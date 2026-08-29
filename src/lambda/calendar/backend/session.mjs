/**
 * session.mjs - the site session, as a stateless signed cookie.
 *
 * There is no server-side session store and no session table: a session IS the
 * cookie. The cookie value is
 *
 *     base64url(JSON.stringify({ sub, email, iat, exp })) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET))
 *
 * so any tampering with the claims invalidates the signature, and the `exp`
 * claim is enforced on every read (a signature alone must never be enough - a
 * leaked 7-day cookie has to stop working). Nothing about the session needs a
 * DynamoDB round-trip, which is what keeps `/calendar/api/auth/me` and every
 * later authenticated route cheap.
 *
 * The trade-off of statelessness is that a session cannot be revoked
 * server-side before `exp`; logout clears the browser's copy. Rotating
 * SESSION_SECRET invalidates every outstanding session at once, which is the
 * break-glass control.
 *
 * SECURITY:
 *  - The signature comparison goes through `crypto.timingSafeEqual`. A `===`
 *    comparison of two HMACs returns on the first differing byte and lets an
 *    attacker forge a signature byte-by-byte from response timing.
 *  - Nothing here logs. Not the cookie, not the token, not the payload, not the
 *    secret, at any log level.
 *  - `HttpOnly` keeps the cookie out of `document.cookie`, so an XSS bug cannot
 *    read the session out of the page. `Secure` keeps it off plaintext HTTP.
 *    `SameSite=Lax` blocks it on cross-site POSTs (CSRF) while still allowing
 *    the top-level GET redirect back from Google.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Cookie the session token is carried in. */
export const SESSION_COOKIE_NAME = "calendar_session";

/** Session lifetime: 7 days, in seconds. Used for both `exp` and `Max-Age`. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Cookie path. Scoped to /calendar, which is where the app lives. This began as
 * a way to keep the session off the other apps that shared the ALB hostname (the
 * chatbot owns /chatbot); since TASK-049 the app has its own function-URL origin
 * and shares it with nothing, so the scoping is now just least privilege - the
 * cookie is still not sent on any path this app does not serve.
 */
export const SESSION_COOKIE_PATH = "/calendar";

/**
 * A 401-shaped failure. `requireSession` throws this so every authenticated
 * route added by a later ticket can `catch` and turn it straight into a
 * response, without each route re-deriving the status code.
 *
 * `reason` is a stable machine token ("missing" | "malformed" | "signature" |
 * "expired" | "no-secret"), safe to log - it never contains cookie material.
 */
export class SessionError extends Error {
  /**
   * @param {string} reason
   * @param {string} [message] Client-safe message.
   */
  constructor(reason, message = "Unauthorized") {
    super(message);
    this.name = "SessionError";
    this.statusCode = 401;
    this.reason = reason;
  }
}

/** Current time in whole seconds - the unit `iat`/`exp` are expressed in. */
export function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * base64url-encode a string or Buffer (no padding, URL/cookie safe).
 * @param {string|Buffer} value
 * @returns {string}
 */
function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return buffer.toString("base64url");
}

/**
 * Encode session claims into the payload segment.
 * @param {{ sub: string, email: string, iat: number, exp: number }} claims
 * @returns {string}
 */
export function encodeSessionPayload(claims) {
  return base64UrlEncode(JSON.stringify(claims));
}

/**
 * Decode a payload segment back into claims. Returns null for anything that is
 * not base64url-encoded JSON describing an object - a tampered payload must fail
 * as "invalid", never throw and become a 500.
 *
 * @param {string} segment
 * @returns {object|null}
 */
export function decodeSessionPayload(segment) {
  if (typeof segment !== "string" || segment.length === 0) return null;
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * HMAC-SHA256 the payload segment with the session secret.
 * @param {string} encodedPayload
 * @param {string} secret
 * @returns {string} base64url signature.
 */
export function signSessionPayload(encodedPayload, secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    // Named variable, no value. Signing with an empty key would produce a
    // signature every attacker can also compute.
    throw new Error("signSessionPayload: SESSION_SECRET is not set");
  }
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

/**
 * Constant-time comparison of two base64url signatures.
 *
 * Both sides are decoded to bytes first so the comparison is over the digest
 * itself. Only the byte LENGTHS are compared with an operator (a digest length
 * is public: SHA-256 is always 32 bytes); the digest bytes always go through
 * `crypto.timingSafeEqual`.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {boolean}
 */
export function signaturesMatch(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const left = Buffer.from(expected, "base64url");
  const right = Buffer.from(actual, "base64url");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Mint a session token for a signed-in Google identity.
 *
 * @param {{ sub: string, email: string }} identity
 * @param {object} options
 * @param {string} options.secret            SESSION_SECRET.
 * @param {number} [options.nowSeconds]      Clock injection point for tests.
 * @param {number} [options.ttlSeconds]
 * @returns {string} `<payload>.<signature>`
 */
export function createSessionToken({ sub, email }, { secret, nowSeconds = nowInSeconds(), ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  if (!sub) throw new Error("createSessionToken: sub is required");
  const claims = {
    sub: String(sub),
    email: email ? String(email) : "",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const payload = encodeSessionPayload(claims);
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

/**
 * Verify a session token: shape, signature, then expiry.
 *
 * Never throws - callers get a verdict plus a stable `reason` so they can decide
 * between 401 and 500 without parsing an error message.
 *
 * @param {string|null|undefined} token
 * @param {object} options
 * @param {string} options.secret
 * @param {number} [options.nowSeconds]
 * @returns {{ valid: true, claims: { sub: string, email: string, iat: number, exp: number } } | { valid: false, reason: string }}
 */
export function verifySessionToken(token, { secret, nowSeconds = nowInSeconds() } = {}) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { valid: false, reason: "no-secret" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "missing" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }

  const [payload, signature] = parts;

  // Signature first: never trust the claims of an unverified payload, not even
  // to read `exp` from them.
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  if (!signaturesMatch(expected, signature)) {
    return { valid: false, reason: "signature" };
  }

  const claims = decodeSessionPayload(payload);
  if (!claims || typeof claims.sub !== "string" || !claims.sub) {
    return { valid: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { valid: false, reason: "malformed" };
  }
  // A valid signature over an expired payload is still expired.
  if (claims.exp <= nowSeconds) {
    return { valid: false, reason: "expired" };
  }

  return {
    valid: true,
    claims: {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : "",
      iat: typeof claims.iat === "number" ? claims.iat : 0,
      exp: claims.exp,
    },
  };
}

/**
 * Serialise the Set-Cookie value for a session.
 *
 * @param {string} token
 * @param {object} [options]
 * @param {number} [options.ttlSeconds]
 * @param {string} [options.path]
 * @returns {string}
 */
export function serializeSessionCookie(token, { ttlSeconds = SESSION_TTL_SECONDS, path = SESSION_COOKIE_PATH } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${path}`,
    `Max-Age=${ttlSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Serialise a Set-Cookie value that expires the session immediately. Both
 * `Max-Age=0` and a 1970 `Expires` are sent, because some older browsers honour
 * only one of the two.
 *
 * @param {object} [options]
 * @param {string} [options.path]
 * @returns {string}
 */
export function serializeClearedSessionCookie({ path = SESSION_COOKIE_PATH } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=`,
    `Path=${path}`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Parse a Cookie header into a name -> value map. Tolerates an array of parts -
 * which is both payload format 2.0's `cookies` array (one "name=value" per
 * entry) and the array form the ALB used to deliver - and cookie values that
 * themselves contain "=" (base64 padding, JWT-ish tokens).
 *
 * @param {string|string[]|null|undefined} raw
 * @returns {Record<string, string>}
 */
export function parseCookieHeader(raw) {
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  const out = {};
  if (typeof header !== "string" || header.length === 0) return out;

  for (const part of header.split(";")) {
    const segment = part.trim();
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    if (!name) continue;
    out[name] = segment.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Cookies from a request event, whichever shape they arrived in.
 *
 * A Lambda function URL (payload format 2.0) does NOT put cookies in the header
 * map at all: it strips them into a top-level `cookies` array, so reading only
 * the Cookie header there finds nothing and every request looks signed out
 * (TASK-049). The header path is kept for the ALB shape and for any caller that
 * still sends a plain Cookie header, and is tried second so a real `cookies`
 * array always wins.
 *
 * @param {object} event
 * @returns {Record<string, string>}
 */
export function getCookies(event) {
  if (Array.isArray(event?.cookies) && event.cookies.length > 0) {
    return parseCookieHeader(event.cookies);
  }

  const headers = event?.headers || event?.multiValueHeaders || {};
  // HTTP header names are case-insensitive; both event formats lower-case them,
  // but do not depend on that.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "cookie") {
      return parseCookieHeader(headers[name]);
    }
  }
  return {};
}

/**
 * Read a named cookie from a request event.
 * @param {object} event
 * @param {string} name
 * @returns {string|null}
 */
export function getCookie(event, name) {
  const value = getCookies(event)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read and verify the session on a request, without throwing.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string} [options.secret]      Defaults to process.env.SESSION_SECRET.
 * @param {number} [options.nowSeconds]
 * @returns {{ valid: true, claims: object } | { valid: false, reason: string }}
 */
export function readSession(event, { secret = process.env.SESSION_SECRET || "", nowSeconds = nowInSeconds() } = {}) {
  const token = getCookie(event, SESSION_COOKIE_NAME);
  if (!token) return { valid: false, reason: "missing" };
  return verifySessionToken(token, { secret, nowSeconds });
}

/**
 * Require a valid session, or throw a 401-shaped `SessionError`.
 *
 * This is the helper every authenticated route in later tickets should use, so
 * the "what counts as signed in" decision lives in exactly one place.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string} [options.secret]
 * @param {number} [options.nowSeconds]
 * @returns {{ sub: string, email: string, iat: number, exp: number }}
 * @throws {SessionError}
 */
export function requireSession(event, options = {}) {
  const result = readSession(event, options);
  if (!result.valid) {
    throw new SessionError(result.reason);
  }
  return result.claims;
}
