/**
 * google-oauth.mjs - the Google authorisation-code flow, with PKCE.
 *
 * The Google grant is BOTH the site login and the Gmail read authorisation:
 * there is no second identity provider, so the `id_token` from this exchange is
 * what the session cookie is minted from, and the `refresh_token` from the same
 * exchange is what later scans use to read Gmail.
 *
 * Why each unobvious parameter is here:
 *  - `access_type=offline` + `prompt=consent`: Google issues a refresh token only
 *    for an offline grant, and on a REPEAT consent it silently omits the refresh
 *    token unless consent is forced. Without both, the first sign-in works and
 *    every re-connect afterwards stores nothing.
 *  - PKCE (`code_challenge`/`code_verifier`): binds the authorisation code to
 *    this browser, so a code intercepted in a redirect cannot be redeemed
 *    elsewhere.
 *  - `state`: the CSRF defence. It is compared against a value only this
 *    browser holds, in an HttpOnly cookie, so a forged callback fails.
 *  - `redirect_uri` is always computed from PUBLIC_BASE_URL server-side. It is
 *    never read from the query string - an attacker-supplied redirect target is
 *    how authorisation codes get exfiltrated (and Google's exact-match rule is
 *    the only other thing standing in the way).
 *
 * TESTABILITY: the token exchange takes its `fetch` and its endpoint as
 * parameters with real defaults, and every other function here is pure. No
 * network call happens on any injected path.
 *
 * SECURITY: nothing in this module logs. Not the authorisation code, the access
 * token, the refresh token, the `id_token`, the client secret, the code verifier
 * or the state, at any log level.
 */

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constantTimeEquals } from "./crypto.mjs";

/** Google's authorisation endpoint (the user-facing consent screen). */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's token endpoint (server-to-server code exchange). */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Scopes requested. `openid`/`email`/`profile` make this the login; the
 * gmail.readonly scope is the whole point of the app and is deliberately
 * read-only - nothing in this project ever needs to send or modify mail.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

/** Issuers Google signs id_tokens with; both spellings are legitimate. */
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Path the callback is served on, appended to PUBLIC_BASE_URL. */
export const CALLBACK_PATH = "/calendar/api/auth/google/callback";

/** Cookie holding the in-flight `state` and PKCE `code_verifier`. */
export const OAUTH_STATE_COOKIE_NAME = "calendar_oauth_state";

/**
 * Lifetime of the state cookie: 10 minutes. Long enough to read a consent
 * screen, short enough that an abandoned attempt cannot be replayed later.
 */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Where the user lands after a successful sign-in. */
export const POST_LOGIN_PATH = "/calendar";

/**
 * Environment variables this flow cannot run without. Names only ever appear in
 * logs; values never do.
 */
export const REQUIRED_START_VARS = ["GOOGLE_CLIENT_ID", "PUBLIC_BASE_URL"];
export const REQUIRED_CALLBACK_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET",
  "PUBLIC_BASE_URL",
];

/**
 * Read the OAuth configuration out of the environment.
 *
 * Read per-request rather than at module load so a Lambda container picks up a
 * rotated secret on its next invocation - and so tests can vary the environment
 * without re-importing the module.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ clientId: string, clientSecret: string, sessionSecret: string, publicBaseUrl: string }}
 */
export function readOAuthConfig(env = process.env) {
  return {
    clientId: (env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || "").trim(),
    sessionSecret: (env.SESSION_SECRET || "").trim(),
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
  };
}

/**
 * Which of the given variables are missing or empty.
 *
 * Returns NAMES ONLY - this list is designed to be safe to log verbatim, which
 * is what lets a misconfiguration fail loudly without leaking the secret.
 *
 * @param {{ clientId: string, clientSecret: string, sessionSecret: string, publicBaseUrl: string }} config
 * @param {string[]} [required]
 * @returns {string[]}
 */
export function missingConfigVars(config, required = REQUIRED_CALLBACK_VARS) {
  const byName = {
    GOOGLE_CLIENT_ID: config?.clientId,
    GOOGLE_CLIENT_SECRET: config?.clientSecret,
    SESSION_SECRET: config?.sessionSecret,
    PUBLIC_BASE_URL: config?.publicBaseUrl,
  };
  return required.filter((name) => {
    const value = byName[name];
    return typeof value !== "string" || value.length === 0;
  });
}

/**
 * The one true redirect_uri, derived from PUBLIC_BASE_URL. Never from a query
 * parameter, a Host header or a Referer.
 *
 * @param {string} publicBaseUrl
 * @returns {string}
 */
export function buildRedirectUri(publicBaseUrl) {
  return `${String(publicBaseUrl || "").replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/**
 * Random base64url token.
 * @param {number} [bytes]
 * @param {(size: number) => Buffer} [randomBytes] Injectable entropy source.
 * @returns {string}
 */
export function randomToken(bytes = 32, randomBytes = nodeRandomBytes) {
  return Buffer.from(randomBytes(bytes)).toString("base64url");
}

/**
 * Generate the CSRF `state`.
 * @param {(size: number) => Buffer} [randomBytes]
 * @returns {string}
 */
export function generateState(randomBytes = nodeRandomBytes) {
  return randomToken(32, randomBytes);
}

/**
 * Generate a PKCE `code_verifier`. 32 random bytes base64url-encode to 43
 * characters, which is the minimum RFC 7636 allows.
 * @param {(size: number) => Buffer} [randomBytes]
 * @returns {string}
 */
export function generateCodeVerifier(randomBytes = nodeRandomBytes) {
  return randomToken(32, randomBytes);
}

/**
 * S256 challenge for a PKCE verifier: base64url(SHA-256(verifier)).
 * @param {string} codeVerifier
 * @returns {string}
 */
export function codeChallengeS256(codeVerifier) {
  return createHash("sha256").update(String(codeVerifier), "ascii").digest("base64url");
}

/**
 * Build the Google authorisation URL to redirect the browser to.
 *
 * Note what is NOT in this URL: the code verifier (only its S256 hash is sent)
 * and the client secret. Both stay server-side.
 *
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.redirectUri
 * @param {string} args.state
 * @param {string} args.codeChallenge
 * @param {string[]} [args.scopes]
 * @param {string|null} [args.loginHint]
 * @returns {string}
 */
export function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, scopes = GOOGLE_SCOPES, loginHint = null }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Required for a refresh token to be issued at all.
    access_type: "offline",
    // Required for a refresh token to be issued AGAIN on a repeat consent.
    prompt: "consent",
    include_granted_scopes: "true",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Serialise the state cookie. Carries the `state` and the PKCE `code_verifier`
 * together, because both must survive the round-trip to Google and neither may
 * be visible to page scripts (hence `HttpOnly`).
 *
 * `SameSite=Lax` is required rather than `Strict`: the callback arrives as a
 * cross-site top-level GET from accounts.google.com, and `Strict` would withhold
 * the cookie and break every sign-in.
 *
 * @param {{ state: string, codeVerifier: string }} args
 * @param {object} [options]
 * @param {number} [options.ttlSeconds]
 * @returns {string}
 */
export function serializeStateCookie({ state, codeVerifier }, { ttlSeconds = OAUTH_STATE_TTL_SECONDS } = {}) {
  const value = Buffer.from(JSON.stringify({ state, codeVerifier }), "utf8").toString("base64url");
  return [
    `${OAUTH_STATE_COOKIE_NAME}=${value}`,
    "Path=/calendar",
    `Max-Age=${ttlSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Decode a state cookie value. Returns null for anything malformed - a bad
 * cookie must read as "no state", never throw.
 *
 * @param {string|null|undefined} value
 * @returns {{ state: string, codeVerifier: string }|null}
 */
export function parseStateCookie(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { state, codeVerifier } = parsed;
    if (typeof state !== "string" || !state) return null;
    if (typeof codeVerifier !== "string" || !codeVerifier) return null;
    return { state, codeVerifier };
  } catch {
    return null;
  }
}

/**
 * Set-Cookie value that drops the state cookie.
 *
 * Sent on EVERY callback outcome, success or failure. A left-behind cookie means
 * the next attempt presents a stale `code_verifier` against a fresh code, and
 * Google rejects the exchange - a failure that looks like a bug in the flow
 * rather than leftover state.
 *
 * @returns {string}
 */
export function serializeClearedStateCookie() {
  return [
    `${OAUTH_STATE_COOKIE_NAME}=`,
    "Path=/calendar",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Does the callback's `state` match the browser's cookie?
 *
 * Compared in constant time. Absent on either side is a failure, never a pass -
 * an empty-vs-empty match would turn a missing cookie into a valid callback.
 *
 * @param {string|null|undefined} stateParam
 * @param {string|null|undefined} cookieState
 * @returns {boolean}
 */
export function stateMatches(stateParam, cookieState) {
  if (!stateParam || !cookieState) return false;
  return constantTimeEquals(stateParam, cookieState);
}

/**
 * Exchange an authorisation code for tokens at Google's token endpoint.
 *
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.codeVerifier
 * @param {string} args.clientId
 * @param {string} args.clientSecret
 * @param {string} args.redirectUri
 * @param {object} [options]
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl] Injectable HTTP.
 * @param {string} [options.tokenEndpoint]
 * @returns {Promise<{ accessToken: string, refreshToken: string, idToken: string, expiresIn: number, scope: string, tokenType: string }>}
 */
export async function exchangeCodeForTokens(
  { code, codeVerifier, clientId, clientSecret, redirectUri },
  { fetchImpl = globalThis.fetch, tokenEndpoint = GOOGLE_TOKEN_ENDPOINT } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("exchangeCodeForTokens: no fetch implementation available");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  // Read the body once, as text, so a non-JSON error page does not throw.
  const text = typeof response?.text === "function" ? await response.text() : "";
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response?.ok) {
    // Google's error body contains `error`/`error_description` - both are
    // descriptions of the failure, never token material. The response text as a
    // whole is NOT included, because a token endpoint body can carry tokens.
    const error = payload?.error || `http_${response?.status ?? "unknown"}`;
    const description = payload?.error_description || "";
    const err = new Error(
      description ? `Google token exchange failed: ${error}: ${description}` : `Google token exchange failed: ${error}`
    );
    err.name = "TokenExchangeError";
    err.oauthError = String(error);
    err.statusCode = response?.status ?? 0;
    throw err;
  }

  if (!payload || typeof payload !== "object") {
    const err = new Error("Google token exchange returned a non-JSON body");
    err.name = "TokenExchangeError";
    throw err;
  }

  return {
    accessToken: typeof payload.access_token === "string" ? payload.access_token : "",
    // Absent on a repeat consent that was not forced. The caller must keep any
    // token it already holds rather than overwrite it with "".
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    idToken: typeof payload.id_token === "string" ? payload.id_token : "",
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 0,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "",
  };
}

/**
 * Decode the claims of a JWT without verifying its signature.
 *
 * DELIBERATE SCOPE: the signature is NOT cryptographically verified here. This
 * `id_token` did not arrive from the browser - it came back over TLS on a
 * server-to-server POST to Google's token endpoint that was authenticated with
 * the client secret, in direct response to a code this server issued the PKCE
 * challenge for. There is no attacker position between that request and its
 * response, so a JWKS signature check would be verifying Google's word against
 * Google's own keys fetched over the same TLS trust. The CLAIMS are still fully
 * validated (see `validateIdTokenClaims`) because those are what the session is
 * minted from. Any future path that accepts an `id_token` from a CLIENT must add
 * real JWKS verification before trusting it.
 *
 * @param {string} jwt
 * @returns {object|null} Claims, or null if the token is not a decodable JWT.
 */
export function decodeIdToken(jwt) {
  if (typeof jwt !== "string" || jwt.length === 0) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Validate the claims of a Google `id_token`: issuer, audience, expiry, and the
 * presence of the two claims the app identifies a user by.
 *
 * Never throws; returns a verdict plus a reason token that is safe to log (it
 * names the failing claim, never its value).
 *
 * @param {object|null} claims
 * @param {object} options
 * @param {string} options.clientId       Expected `aud`.
 * @param {number} [options.nowSeconds]
 * @returns {{ valid: true, sub: string, email: string } | { valid: false, reason: string }}
 */
export function validateIdTokenClaims(claims, { clientId, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!claims || typeof claims !== "object") return { valid: false, reason: "undecodable" };

  if (!GOOGLE_ISSUERS.includes(claims.iss)) return { valid: false, reason: "iss" };

  // `aud` must be this exact client: an id_token minted for a different OAuth
  // client is not a login for this app.
  if (!clientId || claims.aud !== clientId) return { valid: false, reason: "aud" };

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return { valid: false, reason: "exp" };
  if (claims.exp <= nowSeconds) return { valid: false, reason: "expired" };

  if (typeof claims.sub !== "string" || !claims.sub) return { valid: false, reason: "sub" };
  if (typeof claims.email !== "string" || !claims.email) return { valid: false, reason: "email" };

  // Only an EXPLICIT false is a rejection; Google omits the claim in some
  // response shapes and an omission is not evidence of an unverified address.
  if (claims.email_verified === false) return { valid: false, reason: "email_unverified" };

  return { valid: true, sub: claims.sub, email: claims.email };
}
