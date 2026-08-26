import { dirname } from "path";
import { fileURLToPath } from "url";

import {
  buildAuthorizationUrl,
  buildRedirectUri,
  codeChallengeS256,
  decodeIdToken,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generateState,
  missingConfigVars,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  parseStateCookie,
  POST_LOGIN_PATH,
  readOAuthConfig,
  REQUIRED_CALLBACK_VARS,
  REQUIRED_START_VARS,
  serializeClearedStateCookie,
  serializeStateCookie,
  stateMatches,
  validateIdTokenClaims,
} from "./backend/google-oauth.mjs";
import {
  createSessionToken,
  getCookie,
  requireSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./backend/session.mjs";
import { connectionUserId, getConnection, putConnection, toPublicJson } from "./backend/connections.mjs";
import { disconnectAccount, RevocationError } from "./backend/disconnect.mjs";
import {
  loadSettings,
  parseJsonBody,
  requireValidSettings,
  saveSettings,
  SETTINGS_PATH,
  SettingsValidationError,
  toSettingsJson,
} from "./backend/settings.mjs";
import {
  acknowledgeEvent,
  dismissEvent,
  EventNotFoundError,
  EventValidationError,
  queryEventsInRange,
  queryUpcomingEvents,
  restoreEvent,
} from "./backend/events.mjs";
import { runScan, SCAN_STATUS } from "./backend/scan.mjs";
import {
  deleteScanSchedule,
  getScanSchedule,
  isScheduledScanEvent,
  putScanSchedule,
  runScheduledScan,
  ScheduleValidationError,
} from "./backend/scan-schedule.mjs";

// ESM has no __dirname/__filename. Derive them from import.meta.url, exactly as
// the chatbot Lambda does, so frontend assets can be read relative to the
// bundle root once TASK-010 adds them.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root of the deployed bundle; frontend assets live under `${ASSET_DIR}/frontend`.
const ASSET_DIR = __dirname;

// Cache frontend files in memory after first read. Lambda containers are reused
// between invocations, so each asset is read from disk at most once per
// container. Populated by the frontend ticket; declared here so the serve path
// has somewhere to cache from day one.
const fileCache = new Map();

// --- Origin Allowlist ---
// Parsed from ALLOWED_ORIGINS env var (comma-separated domain list). Each entry
// is a domain suffix match, e.g. "officehq.com.au" matches
// "https://my.officehq.com.au". Empty = open mode (echo "*").
/**
 * Parse a raw comma-separated ALLOWED_ORIGINS string into a normalised list.
 *
 * Entries are lower-cased because `isOriginAllowed` compares them against
 * `new URL(origin).hostname`, which the URL spec always normalises to
 * lowercase — an entry of "OfficeHQ.com.au" could otherwise never match
 * anything. The chatbot Lambda lower-cases its entries the same way.
 *
 * Exported so tests can exercise several allowlist configurations without
 * mutating module-scope state (ALLOWED_ORIGINS is read once at import time).
 *
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
function parseAllowedOrigins(raw) {
  return (raw || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const LOG_LEVEL = process.env.CALENDAR_LOG_LEVEL || "basic";

/**
 * Log a request/summary line unless logging is switched off entirely.
 */
function logBasic(...args) {
  if (LOG_LEVEL === "none") return;
  console.log(...args);
}

/**
 * Log detail that is only wanted while debugging.
 *
 * SECURITY: "verbose" widens WHAT is logged, never WHETHER a secret may be
 * logged. Authorisation codes, access/refresh tokens, id_tokens, cookie values
 * and the session secret are never passed to any logger in this codebase, at any
 * level. Verbose also logs personal data (email subjects, in a later ticket) and
 * must not be left on in prod.
 */
function logVerbose(...args) {
  if (LOG_LEVEL !== "verbose") return;
  console.log(...args);
}

/**
 * Coerce a possibly-malformed allowlist into an array (TASK-022).
 *
 * `allowlist = ALLOWED_ORIGINS` default parameters only fire for `undefined`;
 * an explicit `null` or a non-array value (e.g. a string from a config path)
 * sails straight past the default and on into `.length`/`.some`, which throws.
 * The handler has no try/catch, so that throw becomes an unhandled 5xx for the
 * whole request.
 *
 * Chosen fallback: the module-scope `ALLOWED_ORIGINS` constant, NOT `[]`.
 * Falling back to `[]` would mean open mode - echo any origin - for exactly
 * the call that received a malformed value, which is the wrong direction to
 * fail on a security gate. Falling back to the module default instead keeps
 * whatever restriction is actually configured (or reproduces today's
 * behaviour unchanged when ALLOWED_ORIGINS is unset, since that is `[]`
 * already). This is a fail-safe default, not a fail-open one.
 *
 * @param {unknown} allowlist
 * @returns {string[]}
 */
function coerceAllowlist(allowlist) {
  return Array.isArray(allowlist) ? allowlist : ALLOWED_ORIGINS;
}

/**
 * Is this origin covered by the allowlist (exact host or domain suffix)?
 *
 * The suffix match requires a dot boundary: an entry of "officehq.com.au"
 * matches "officehq.com.au" and "sub.officehq.com.au" but NOT the lookalike
 * "evil-officehq.com.au" (a bare `host.endsWith(allowed)` would accept it) and
 * not "officehq.com.au.attacker.com" (which the suffix test rules out).
 *
 * `allowlist` is coerced via `coerceAllowlist` before use, so `null` or a
 * non-array value falls back to the module default instead of throwing
 * (TASK-022).
 *
 * @param {string|null|undefined} origin  full origin, e.g. "https://x.example.com"
 * @param {string[]} [allowlist]          defaults to the module-scope allowlist
 */
function isOriginAllowed(origin, allowlist = ALLOWED_ORIGINS) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const list = coerceAllowlist(allowlist);
  return list.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/**
 * Determine the CORS origin to return.
 * - allowlist empty (open mode) -> "*"
 * - origin in allowlist         -> echo it back
 * - otherwise                   -> null (no CORS header, browser blocks it)
 *
 * `allowlist` is coerced via `coerceAllowlist` before use, so `null` or a
 * non-array value falls back to the module default instead of throwing on
 * `.length` (TASK-022). `[]` still means open mode and `undefined` still
 * resolves to the module constant - the coercion only changes behaviour for
 * `null` and non-array values, which previously threw.
 *
 * @param {string|null|undefined} origin
 * @param {string[]} [allowlist]  defaults to the module-scope allowlist
 */
function getCorsOrigin(origin, allowlist = ALLOWED_ORIGINS) {
  const list = coerceAllowlist(allowlist);
  if (list.length === 0) return "*";
  if (origin && isOriginAllowed(origin, list)) return origin;
  return null;
}

/**
 * Pull the request Origin (or Referer) out of an ALB event's headers. With
 * lambda_multi_value_headers_enabled the values arrive as arrays, so handle
 * both shapes.
 */
function getRequestOrigin(headers) {
  const read = (name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const origin = read("origin");
  if (origin) return origin;
  const referer = read("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

const STATUS_TEXT = {
  200: "OK",
  204: "No Content",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  // Used when Google's token endpoint - not this service - is what failed.
  502: "Bad Gateway",
};

const CREDENTIALS_HEADER = "access-control-allow-credentials";

/**
 * Build an ALB-compatible response (multi-value headers format).
 *
 * The target group sets lambda_multi_value_headers_enabled = true, so the ALB
 * expects `multiValueHeaders` (every value an array) rather than `headers`.
 * That is what lets later tickets emit several Set-Cookie headers from one
 * response - a single-value `headers` map cannot.
 *
 * Security invariant: `Access-Control-Allow-Credentials` is never emitted while
 * the resolved origin is the wildcard "*". With ALLOWED_ORIGINS unset the gate
 * is in open mode, and pairing credentials with "*" would turn per-user
 * calendar data into a cross-origin read. This is enforced here rather than
 * left to convention, so a later route that adds the header (session cookies,
 * authenticated APIs) is stripped instead of shipping the combination. Set
 * ALLOWED_ORIGINS to an explicit list to use credentialed CORS.
 *
 * `allowlist` is passed straight to `getCorsOrigin`, which coerces `null` and
 * any non-array value to the module default rather than throwing on
 * `.length` - so a caller passing a malformed allowlist here fails safe
 * (no CORS header, not a 5xx) rather than throwing (TASK-022).
 *
 * @param {number} statusCode
 * @param {string} body           already-serialised body
 * @param {string} [contentType]
 * @param {{origin?: string|null, headers?: Record<string, string[]>, allowlist?: string[]}} [options]
 */
function buildResponse(statusCode, body, contentType = "application/json", options = {}) {
  const { origin = null, headers = {}, allowlist = ALLOWED_ORIGINS } = options;

  const corsOrigin = getCorsOrigin(origin, allowlist);

  const multiValueHeaders = {
    "Content-Type": [contentType],
    "Access-Control-Allow-Methods": ["GET, POST, PUT, DELETE, OPTIONS"],
    "Access-Control-Allow-Headers": ["Content-Type, Authorization, X-Requested-With"],
    "Access-Control-Max-Age": ["86400"],
    "Cache-Control": ["no-cache"],
    ...headers,
  };

  // Only include the CORS origin header when we resolved an allowed origin.
  if (corsOrigin) {
    multiValueHeaders["Access-Control-Allow-Origin"] = [corsOrigin];
    multiValueHeaders["Vary"] = ["Origin"];
  }

  // Hard invariant: credentials are never exposed to a wildcard origin. Header
  // names are compared case-insensitively because HTTP header names are.
  if (corsOrigin === "*") {
    for (const name of Object.keys(multiValueHeaders)) {
      if (name.toLowerCase() === CREDENTIALS_HEADER) {
        delete multiValueHeaders[name];
        // Name only - never the value, which may be a credential elsewhere.
        logBasic(
          "[Calendar] Dropped",
          name,
          "- credentials cannot be paired with a wildcard CORS origin; set ALLOWED_ORIGINS"
        );
      }
    }
  }

  return {
    statusCode,
    statusDescription: `${statusCode} ${STATUS_TEXT[statusCode] || "Error"}`,
    multiValueHeaders,
    body,
    isBase64Encoded: false,
  };
}

/**
 * JSON convenience wrapper around buildResponse.
 */
function jsonResponse(statusCode, payload, options = {}) {
  return buildResponse(statusCode, JSON.stringify(payload), "application/json", options);
}

/**
 * Router-level choke point (TASK-022): strip
 * `Access-Control-Allow-Credentials` from ANY response carrying a wildcard
 * `Access-Control-Allow-Origin`, no matter how that response was built.
 *
 * `buildResponse` already enforces this invariant for every response built
 * through it, and every route in this file does route through it - so there
 * is no live bug today. But that guarantee is structural only for
 * `buildResponse`'s own callers: nothing stops a future route from returning
 * a hand-rolled `{ statusCode, multiValueHeaders, ... }` object instead of
 * calling `buildResponse`, which would bypass the strip entirely and could
 * re-introduce exactly the `*` + Allow-Credentials pairing TASK-020 exists to
 * prevent.
 *
 * `handler` runs every value it returns - whatever `routeAuthRequest` /
 * `routeSettingsRequest` / a future route produces, `buildResponse`-built or
 * not - through this function before it leaves the router. It inspects the
 * RESPONSE'S OWN headers rather than recomputing the origin decision, so the
 * guarantee holds even for a response built by code that never called
 * `getCorsOrigin` at all. This is deliberately in addition to, not instead
 * of, the guard inside `buildResponse`: that guard still protects any direct
 * caller of `buildResponse`/`jsonResponse` (including route handlers under
 * test in isolation), while this one protects the router's output as a
 * whole.
 *
 * @param {object} response  An ALB-shaped response (multiValueHeaders keyed).
 * @returns {object} The same response object, mutated in place if a strip was
 *   necessary.
 */
function finalise(response) {
  if (!response || typeof response !== "object") return response;
  const headers = response.multiValueHeaders;
  if (!headers || typeof headers !== "object") return response;

  let originIsWildcard = false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "access-control-allow-origin") continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first === "*") originIsWildcard = true;
  }
  if (!originIsWildcard) return response;

  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === CREDENTIALS_HEADER) {
      delete headers[name];
      // Name only - never the value, which may be a credential elsewhere.
      logBasic(
        "[Calendar] Dropped",
        name,
        "- credentials cannot be paired with a wildcard CORS origin; set ALLOWED_ORIGINS"
      );
    }
  }
  return response;
}

// --- Google sign-in routes ---
// The Google grant is both the site login and the Gmail read authorisation, so
// these four routes are the whole of authentication. The flow itself lives in
// backend/google-oauth.mjs, the cookie in backend/session.mjs and the storage in
// backend/connections.mjs; this file only maps them onto HTTP.
//
// Every response below goes through buildResponse/jsonResponse. Nothing here
// hand-rolls a `{ statusCode ... }` object, because the "no credentials with a
// wildcard origin" invariant lives inside buildResponse; `handler` additionally
// runs every value it returns through `finalise` (TASK-022), so the invariant
// would still hold even if a future route did hand-roll one. `allowlist` here
// is only ever passed through as undefined or an array, but a `null` or
// non-array value reaching buildResponse/getCorsOrigin/isOriginAllowed now
// fails safe instead of throwing (TASK-022; see coerceAllowlist).

/** Route prefix for the auth endpoints. */
const AUTH_START_PATH = "/calendar/api/auth/google/start";
const AUTH_CALLBACK_PATH = "/calendar/api/auth/google/callback";
const AUTH_LOGOUT_PATH = "/calendar/api/auth/logout";
const AUTH_ME_PATH = "/calendar/api/auth/me";
const AUTH_DISCONNECT_PATH = "/calendar/api/auth/disconnect";

/**
 * Percent-decode an ALB query-string value.
 *
 * ALB events deliver query values still URL-encoded (unlike API Gateway), so a
 * Google authorisation code containing "/" arrives as "%2F". Only percent-escapes
 * are decoded - "+" is left alone because none of the values this app reads
 * (base64url state, Google codes) can legitimately contain an encoded space, and
 * mangling one would break the exchange.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeQueryValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read a query-string parameter from an ALB event, in either the single-value or
 * multi-value shape.
 *
 * @param {object} event
 * @param {string} name
 * @returns {string|null}
 */
function getQueryParam(event, name) {
  const multi = event?.multiValueQueryStringParameters;
  if (multi && Array.isArray(multi[name]) && multi[name].length > 0) {
    return decodeQueryValue(String(multi[name][0]));
  }
  const single = event?.queryStringParameters;
  if (single && single[name] !== undefined && single[name] !== null) {
    return decodeQueryValue(String(single[name]));
  }
  return null;
}

/**
 * GET /calendar/api/auth/google/start - begin the Google sign-in.
 *
 * Mints a fresh `state` and PKCE `code_verifier`, parks both in a 10-minute
 * HttpOnly cookie, and redirects to Google with only the S256 CHALLENGE in the
 * URL. The verifier itself is never in the redirect, so an observer of the
 * redirect (browser history, referrer logs, the user) cannot redeem a stolen
 * code.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {(size: number) => Buffer} [options.randomBytes] Injectable entropy.
 * @returns {Promise<object>} ALB response.
 */
export async function handleAuthStart(event, options = {}) {
  const { origin = null, allowlist, env = process.env, randomBytes } = options;

  const config = readOAuthConfig(env);
  const missing = missingConfigVars(config, REQUIRED_START_VARS);
  if (missing.length > 0) {
    // Names only. Never a value, not even a truncated one.
    logBasic("[Calendar] Google sign-in unavailable - unset environment variables:", missing.join(", "));
    return jsonResponse(500, { error: "Google sign-in is not configured" }, { origin, allowlist });
  }

  const state = generateState(randomBytes);
  const codeVerifier = generateCodeVerifier(randomBytes);
  const authorizationUrl = buildAuthorizationUrl({
    clientId: config.clientId,
    // Server-side only: the redirect target is derived from PUBLIC_BASE_URL and
    // is never read from the request.
    redirectUri: buildRedirectUri(config.publicBaseUrl),
    state,
    codeChallenge: codeChallengeS256(codeVerifier),
  });

  logVerbose("[Calendar] Google sign-in start - redirecting to Google", {
    // Deliberately no state, no verifier, no challenge, no client id.
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
  });

  return buildResponse(302, "", "text/plain", {
    origin,
    allowlist,
    headers: {
      Location: [authorizationUrl],
      "Set-Cookie": [serializeStateCookie({ state, codeVerifier })],
    },
  });
}

/**
 * GET /calendar/api/auth/google/callback - finish the Google sign-in.
 *
 * Order of checks, and why:
 *  1. Configuration. A server that cannot sign a cookie or authenticate the token
 *     exchange cannot validate anything either, so misconfiguration is answered
 *     first, with a 500 and a log line that names the missing variables only.
 *  2. `state` present and matching the cookie -> 400. This is the CSRF defence:
 *     without it, an attacker can walk a victim's browser through a callback
 *     carrying the ATTACKER's authorisation code and silently connect the
 *     attacker's Gmail to the victim's session.
 *  3. The code exchange, then the id_token claims, then storage.
 *
 * The state cookie is cleared on EVERY outcome. A surviving cookie leaves a stale
 * `code_verifier` behind, which Google rejects on the next attempt.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof exchangeCodeForTokens} [options.exchangeCode] Injectable token exchange.
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl] Injectable HTTP, if the real exchange is kept.
 * @param {string} [options.tokenEndpoint]
 * @param {typeof putConnection} [options.putConnection] Injectable storage.
 * @returns {Promise<object>} ALB response.
 */
export async function handleAuthCallback(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    exchangeCode = exchangeCodeForTokens,
    fetchImpl,
    tokenEndpoint,
    putConnection: saveConnection = putConnection,
  } = options;

  // Cleared on every path out of this function, success or failure.
  const clearedState = serializeClearedStateCookie();

  /** Failure response helper - always clears the state cookie. */
  const fail = (statusCode, payload) =>
    jsonResponse(statusCode, payload, {
      origin,
      allowlist,
      headers: { "Set-Cookie": [clearedState] },
    });

  const config = readOAuthConfig(env);
  const missing = missingConfigVars(config, REQUIRED_CALLBACK_VARS);
  if (missing.length > 0) {
    logBasic("[Calendar] Google callback rejected - unset environment variables:", missing.join(", "));
    return fail(500, { error: "Google sign-in is not configured" });
  }

  // The user declined consent, or Google refused the request. `error` is a short
  // OAuth code such as "access_denied" - a description, not a credential.
  const oauthError = getQueryParam(event, "error");
  if (oauthError) {
    // Truncated because it is attacker-controllable text on the way into the log
    // and into a response body; a real OAuth error code is a short token.
    const reason = oauthError.slice(0, 64);
    logBasic("[Calendar] Google callback returned an error:", reason);
    return fail(400, { error: "Google sign-in was not completed", reason });
  }

  const stateParam = getQueryParam(event, "state");
  const stateCookie = parseStateCookie(getCookie(event, OAUTH_STATE_COOKIE_NAME));

  if (!stateParam) {
    logBasic("[Calendar] Google callback rejected - no state parameter");
    return fail(400, { error: "Invalid sign-in state" });
  }
  if (!stateCookie) {
    logBasic("[Calendar] Google callback rejected - no state cookie (expired or third-party cookies blocked)");
    return fail(400, { error: "Invalid sign-in state" });
  }
  if (!stateMatches(stateParam, stateCookie.state)) {
    // Never log either value: the pair is what the CSRF check turns on.
    logBasic("[Calendar] Google callback rejected - state does not match the cookie");
    return fail(400, { error: "Invalid sign-in state" });
  }

  const code = getQueryParam(event, "code");
  if (!code) {
    logBasic("[Calendar] Google callback rejected - no authorisation code");
    return fail(400, { error: "Missing authorization code" });
  }

  let tokens;
  try {
    tokens = await exchangeCode(
      {
        // The code is passed straight through and never logged.
        code,
        codeVerifier: stateCookie.codeVerifier,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: buildRedirectUri(config.publicBaseUrl),
      },
      { fetchImpl, tokenEndpoint }
    );
  } catch (err) {
    // err.message carries Google's own error code/description only - see
    // exchangeCodeForTokens, which deliberately excludes the response body.
    logBasic("[Calendar] Google token exchange failed:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return fail(502, { error: "Google sign-in failed" });
  }

  const identity = validateIdTokenClaims(decodeIdToken(tokens.idToken), {
    clientId: config.clientId,
    nowSeconds,
  });
  if (!identity.valid) {
    // The reason names the failing claim ("aud", "expired", ...), never a value,
    // and the id_token itself is never logged.
    logBasic("[Calendar] Google callback rejected - id_token claim check failed:", identity.reason);
    return fail(400, { error: "Invalid Google identity token" });
  }

  if (!tokens.refreshToken) {
    // Should not happen: access_type=offline + prompt=consent force one. If it
    // does, keep whatever grant is already stored rather than blanking it.
    logBasic("[Calendar] Google token exchange returned no refresh token - keeping any stored grant");
  }

  try {
    await saveConnection(
      {
        sub: identity.sub,
        email: identity.email,
        // Encrypted inside putConnection; the plaintext is never written and
        // never returned.
        refreshToken: tokens.refreshToken,
      },
      { env }
    );
  } catch (err) {
    logBasic("[Calendar] Could not store the Google connection:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return fail(500, { error: "Could not save the Google connection" });
  }

  const sessionToken = createSessionToken(
    { sub: identity.sub, email: identity.email },
    { secret: config.sessionSecret, nowSeconds, ttlSeconds: SESSION_TTL_SECONDS }
  );

  logBasic("[Calendar] Google sign-in completed for a connected account");

  // Two Set-Cookie headers in one response - only possible because the target
  // group has lambda_multi_value_headers_enabled.
  return buildResponse(302, "", "text/plain", {
    origin,
    allowlist,
    headers: {
      Location: [POST_LOGIN_PATH],
      "Set-Cookie": [serializeSessionCookie(sessionToken), clearedState],
    },
  });
}

/**
 * POST /calendar/api/auth/logout - drop the browser's session.
 *
 * Sessions are stateless, so logout is exactly "expire the cookie". Nothing
 * server-side needs deleting, and no session secret is required to do it - which
 * is why logout keeps working even when the app is misconfigured. The OAuth state
 * cookie is expired too, so an abandoned sign-in cannot outlive the session.
 *
 * @param {object} event
 * @param {object} [options]
 * @returns {Promise<object>} ALB response.
 */
export async function handleAuthLogout(event, options = {}) {
  const { origin = null, allowlist } = options;

  logBasic("[Calendar] Session logout");

  return buildResponse(204, "", "application/json", {
    origin,
    allowlist,
    headers: {
      "Set-Cookie": [serializeClearedSessionCookie(), serializeClearedStateCookie()],
    },
  });
}

/** The only body field the disconnect route reads. */
const DELETE_EVENTS_FIELD = "deleteEvents";

/**
 * Read `deleteEvents` out of a parsed disconnect body.
 *
 * Absent means FALSE. The destructive choice is never implied - a client that
 * forgot the field, or sent an empty body, keeps its calendar.
 *
 * A field that is present but not a boolean is a 400, not a silent false. "0",
 * "no", `null` and `{}` all coerce to something under truthiness rules, and a
 * route that quietly reinterprets them is one careless client away from either
 * erasing a calendar nobody asked to erase or refusing to erase one that was.
 * Saying so is cheap; guessing is not.
 *
 * `SettingsValidationError` is reused rather than a new class invented for one
 * field: it is this file's established "the caller sent something unusable"
 * signal, its message is client-safe by construction, and the 400 mapping below
 * is the same one every other route uses.
 *
 * @param {object} payload Parsed JSON body.
 * @returns {boolean}
 * @throws {SettingsValidationError} When present and not a boolean.
 */
function readDeleteEventsFlag(payload) {
  const value = payload?.[DELETE_EVENTS_FIELD];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    // The offending value is never echoed - it is unvalidated input.
    throw new SettingsValidationError(DELETE_EVENTS_FIELD, "deleteEvents must be true or false");
  }
  return value;
}

/**
 * POST /calendar/api/auth/disconnect - revoke the Gmail grant and delete data.
 *
 * The real counterpart to `logout`, which only expires a cookie. This revokes
 * the app's access at Google, deletes the connection row (and with it the only
 * copy of the wrapped refresh token), optionally erases every extracted event,
 * and then ends the browser session.
 *
 * The ordering, the fail-closed revocation and the partial-failure reasoning all
 * live in backend/disconnect.mjs; this function only maps them onto HTTP:
 *
 *   401 - no valid session. Resolved BEFORE the body is parsed, so an
 *         unauthenticated caller learns nothing about the payload shape.
 *   400 - `deleteEvents` present but not a boolean, or an unparseable body.
 *   502 - Google refused the revocation (5xx, network error, an unrecognised
 *         4xx). NOTHING was deleted and the session cookie is deliberately NOT
 *         cleared: the user is still connected, the failure is retryable, and
 *         signing them out of a connection that still exists would hide it from
 *         them. This is the one case where doing less is the safe answer -
 *         deleting the stored token here would leave a live grant on the user's
 *         Google account that this app could never revoke again.
 *   200 - done, with the counts and the cleared session cookie.
 *
 * The 200 body reports what was OBSERVED: `connectionDeleted` comes from
 * DynamoDB's old image, `eventsDeleted` counts only keys DynamoDB confirmed, and
 * `eventsDeleteComplete` is false whenever rows may remain. A deletion route that
 * answers a confident "done" it did not verify is worse than one that fails.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof disconnectAccount} [options.disconnectAccount] Injectable orchestration.
 * @param {Function} [options.getConnection] Injectable storage read.
 * @param {Function} [options.getRefreshToken] Injectable token read.
 * @param {Function} [options.deleteConnection] Injectable row delete.
 * @param {Function} [options.deleteEventsForUser] Injectable event erase.
 * @param {Function} [options.deleteScanSchedule] Injectable schedule delete.
 * @param {Function} [options.revokeGrant] Injectable revocation.
 * @param {Function} [options.resetTokenCache] Injectable access-token cache drop.
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl]
 * @param {string} [options.revokeEndpoint]
 * @param {Function} [options.query] Forwarded to the event erase.
 * @param {Function} [options.batchDelete] Forwarded to the event erase.
 * @param {Function} [options.sleep] Forwarded to the event erase.
 * @param {Function} [options.random] Forwarded to the event erase.
 * @param {number} [options.maxAttempts] Forwarded to the event erase.
 * @param {number} [options.maxPages] Forwarded to the event erase.
 * @param {string|null} [options.tableName] Connections table override.
 * @param {string|null} [options.eventsTableName] Events table override.
 * @param {Function} [options.log]
 * @returns {Promise<object>} ALB response.
 */
export async function handleAuthDisconnect(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    disconnectAccount: runDisconnect = disconnectAccount,
    getConnection: loadConnection,
    getRefreshToken,
    deleteConnection,
    deleteEventsForUser,
    deleteScanSchedule: removeSchedule,
    revokeGrant,
    resetTokenCache,
    fetchImpl,
    revokeEndpoint,
    query,
    batchDelete,
    sleep,
    random,
    maxAttempts,
    maxPages,
    tableName = null,
    eventsTableName = null,
    log,
  } = options;

  // Session first, exactly as everywhere else in this file.
  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  let deleteEvents;
  try {
    deleteEvents = readDeleteEventsFlag(parseJsonBody(event));
  } catch (err) {
    // `name` is checked alongside `instanceof` so the branch still holds if a
    // test has loaded settings.mjs as a second module instance.
    if (err instanceof SettingsValidationError || err?.name === "SettingsValidationError") {
      logBasic("[Calendar] Disconnect rejected:", { field: err.field ?? "body" });
      return jsonResponse(400, { error: err.message, field: err.field ?? null }, { origin, allowlist });
    }
    logBasic("[Calendar] Disconnect body could not be read:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return jsonResponse(500, { error: "Could not disconnect your Google account" }, { origin, allowlist });
  }

  // Session-derived and nowhere else. A `userId` in the body would let any
  // signed-in caller revoke and erase another account.
  const userId = connectionUserId(session.claims.sub);

  let result;
  try {
    result = await runDisconnect(
      { userId, deleteEvents, tableName, eventsTableName },
      {
        getConnection: loadConnection,
        getRefreshToken,
        deleteConnection,
        deleteEventsForUser,
        deleteScanSchedule: removeSchedule,
        revokeGrant,
        resetTokenCache,
        fetchImpl,
        revokeEndpoint,
        query,
        batchDelete,
        sleep,
        random,
        maxAttempts,
        maxPages,
        env,
        log,
      }
    );
  } catch (err) {
    if (err instanceof RevocationError || err?.name === "RevocationError") {
      // 502, because the failure is Google's or the network's, not this
      // service's and not the user's. `reason` is a short log-safe token; the
      // revoke request and response bodies are never logged (see disconnect.mjs).
      logBasic("[Calendar] Could not revoke the Google grant - nothing was deleted:", {
        userId,
        reason: err.reason || "revoke_failed",
        statusCode: err.statusCode || 0,
      });
      return jsonResponse(
        502,
        { error: "Could not revoke access at Google. Nothing was deleted - please try again." },
        { origin, allowlist }
      );
    }
    logBasic("[Calendar] Disconnect failed:", {
      userId,
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return jsonResponse(500, { error: "Could not disconnect your Google account" }, { origin, allowlist });
  }

  // userId, counts and outcome. Never the token, the revoke body or a title.
  logBasic("[Calendar] Google account disconnected", {
    userId,
    revoked: result.revoked === true,
    connectionDeleted: result.connectionDeleted === true,
    scheduleCleared: result.scheduleCleared !== false,
    eventsDeleted: Number.isFinite(result.eventsDeleted) ? result.eventsDeleted : 0,
    eventsDeleteComplete: result.eventsDeleteComplete !== false,
  });

  // The session goes with the grant. Both cookies are expired, matching logout:
  // an abandoned sign-in must not outlive the account it was for.
  return jsonResponse(
    200,
    {
      revoked: result.revoked === true,
      connectionDeleted: result.connectionDeleted === true,
      eventsDeleted: Number.isFinite(result.eventsDeleted) ? result.eventsDeleted : 0,
      // Reported ALWAYS, not only when it is false: an absent field reads as
      // "fine" and this is the one flag that says rows may still be there.
      eventsDeleteComplete: result.eventsDeleteComplete !== false,
      scheduleCleared: result.scheduleCleared !== false,
    },
    {
      origin,
      allowlist,
      headers: { "Set-Cookie": [serializeClearedSessionCookie(), serializeClearedStateCookie()] },
    }
  );
}

/**
 * GET /calendar/api/auth/me - who is signed in, and are they connected?
 *
 * Response body is the `toPublicJson` projection: `email`, `schoolName`,
 * `connected` and `connectionStatus`. No token, no ciphertext, no key id -
 * `connected` is derived from whether a wrapped refresh token exists, so the
 * answer never requires touching the token itself.
 *
 * `connectionStatus` is "connected" | "not_connected" | "unknown". "unknown"
 * means the connections table could not be read: the session is still valid and
 * the identity is still reported, but the caller must not present that as "not
 * connected" (see the catch block below for why that distinction matters).
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof getConnection} [options.getConnection] Injectable storage read.
 * @returns {Promise<object>} ALB response.
 */
export async function handleAuthMe(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    getConnection: loadConnection = getConnection,
  } = options;

  // No cookie at all is the ordinary "not signed in" case and must not read as a
  // server error, whatever the configuration is.
  const token = getCookie(event, SESSION_COOKIE_NAME);
  if (!token) {
    return jsonResponse(401, { error: "Not signed in" }, { origin, allowlist });
  }

  const sessionSecret = (env.SESSION_SECRET || "").trim();
  if (!sessionSecret) {
    logBasic("[Calendar] Session check failed - unset environment variables: SESSION_SECRET");
    return jsonResponse(500, { error: "Sessions are not configured" }, { origin, allowlist });
  }

  // Uses the same requireSession helper every authenticated route in later
  // tickets will use, so that path is exercised in production and cannot rot.
  // SessionError.reason is one of malformed/signature/expired - never the cookie.
  let claims;
  try {
    claims = requireSession(event, { secret: sessionSecret, nowSeconds });
  } catch (err) {
    logBasic("[Calendar] Session rejected:", err?.reason || "invalid");
    return jsonResponse(401, { error: "Not signed in" }, { origin, allowlist });
  }

  let connection = null;
  let lookupFailed = false;
  try {
    connection = await loadConnection(connectionUserId(claims.sub), { env });
  } catch (err) {
    // A lookup failure must not log the user out - the session is valid on its
    // own - but it must not masquerade as "not connected" either. Reporting a
    // confident false here would invite the user to re-authorise a grant they
    // already hold, minting a second refresh token over a working connection to
    // fix what was a blip. So the identity is still reported and the connection
    // state is reported as unknown.
    lookupFailed = true;
    logBasic("[Calendar] Connection lookup failed; reporting connectionStatus=unknown:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
  }

  return jsonResponse(200, toPublicJson(connection, { email: claims.email }, { lookupFailed }), {
    origin,
    allowlist,
  });
}

/**
 * Dispatch the auth routes. Returns null when the request is not one of them, so
 * the handler can carry on to the frontend/404 paths.
 *
 * @param {string} path
 * @param {string} method
 * @param {object} event
 * @param {object} [options] Passed straight through to the route handlers.
 * @returns {Promise<object|null>}
 */
export async function routeAuthRequest(path, method, event, options = {}) {
  if (path === AUTH_START_PATH && method === "GET") return handleAuthStart(event, options);
  if (path === AUTH_CALLBACK_PATH && method === "GET") return handleAuthCallback(event, options);
  if (path === AUTH_LOGOUT_PATH && method === "POST") return handleAuthLogout(event, options);
  if (path === AUTH_ME_PATH && method === "GET") return handleAuthMe(event, options);
  if (path === AUTH_DISCONNECT_PATH && method === "POST") return handleAuthDisconnect(event, options);
  return null;
}

// --- Connection settings routes ---
// What the user asked us to watch for: a school display name and the sender
// domains that count as school mail. Validation and storage live in
// backend/settings.mjs; this file only maps them onto HTTP.

/**
 * Resolve the caller's session, or the response that should be sent instead.
 *
 * Captures the ordering `handleAuthMe` established, because the order is a
 * decision and not an accident:
 *  1. No cookie at all -> 401. This is the ordinary "not signed in" case and must
 *     not read as a server error, whatever the configuration is.
 *  2. No SESSION_SECRET -> 500. A server that cannot verify a signature cannot
 *     honestly say "not signed in"; the log names the variable, never a value.
 *  3. Invalid/expired cookie -> 401.
 *
 * Authentication is resolved BEFORE any payload is parsed or validated, so an
 * unauthenticated caller cannot use the settings endpoint as an oracle: every
 * request without a session gets the same 401 and learns nothing about which
 * fields exist, what they are called, or which of its values would be rejected.
 *
 * @param {object} event
 * @param {{ env?: Record<string, string|undefined>, nowSeconds?: number }} [options]
 * @returns {{ ok: true, claims: object } | { ok: false, statusCode: number, payload: object }}
 */
function resolveSession(event, { env = process.env, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const token = getCookie(event, SESSION_COOKIE_NAME);
  if (!token) {
    return { ok: false, statusCode: 401, payload: { error: "Not signed in" } };
  }

  const sessionSecret = (env.SESSION_SECRET || "").trim();
  if (!sessionSecret) {
    logBasic("[Calendar] Session check failed - unset environment variables: SESSION_SECRET");
    return { ok: false, statusCode: 500, payload: { error: "Sessions are not configured" } };
  }

  try {
    // SessionError.reason is one of missing/malformed/signature/expired - never
    // the cookie itself.
    return { ok: true, claims: requireSession(event, { secret: sessionSecret, nowSeconds }) };
  } catch (err) {
    logBasic("[Calendar] Session rejected:", err?.reason || "invalid");
    return { ok: false, statusCode: 401, payload: { error: "Not signed in" } };
  }
}

/**
 * GET /calendar/api/settings - the signed-in user's saved settings.
 *
 * Body is the `toSettingsJson` projection, which is built on `toPublicJson`: an
 * allow-list, so `refreshTokenEnc` and every other unpublished attribute is
 * absent by construction rather than by remembering to delete it.
 *
 * A read failure is a 500, NOT a 200 full of nulls. This is deliberately
 * different from `/calendar/api/auth/me`, which reports an unknown connection
 * state and keeps going: there, the useful answer (who is signed in) survives the
 * failed read. Here the entire answer came from that read, and an empty form
 * looks exactly like "you have never configured this" - so the user would retype
 * their settings and a save would then overwrite good data.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof getConnection} [options.getConnection] Injectable storage read.
 * @returns {Promise<object>} ALB response.
 */
export async function handleGetSettings(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    getConnection: loadConnection,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  let connection;
  try {
    connection = await loadSettings(session.claims.sub, { getConnection: loadConnection, env });
  } catch (err) {
    logBasic("[Calendar] Could not read connection settings:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return jsonResponse(500, { error: "Could not read your settings" }, { origin, allowlist });
  }

  // The session's email is the fallback for a user who has signed in but has no
  // settings row yet, so the page can greet them by account before first save.
  return jsonResponse(200, toSettingsJson(connection, { email: session.claims.email }), { origin, allowlist });
}

/**
 * PUT /calendar/api/settings - save the school name and search domains.
 *
 * Order of checks, and why:
 *  1. Session (401/500). See `resolveSession`: validation feedback is only ever
 *     given to a caller who is already signed in.
 *  2. Body parse and validation (400). Every rule is enforced here regardless of
 *     what the frontend checked, and the response names the offending `field` so
 *     the form can point at it.
 *  3. The write, then the projection of what was stored.
 *
 * Schedule fields are accepted but optional; a key the caller omitted is left
 * alone rather than reset (TASK-008 owns the schedule itself).
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof saveSettings} [options.saveSettings] Injectable persistence.
 * @param {Function} [options.updateConnection] Injectable connections-layer patch.
 * @param {Function} [options.updateItem] Injectable DynamoDB UpdateItem.
 * @returns {Promise<object>} ALB response.
 */
export async function handlePutSettings(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    saveSettings: persistSettings = saveSettings,
    updateConnection,
    updateItem,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  let settings;
  try {
    settings = requireValidSettings(parseJsonBody(event));
  } catch (err) {
    // Only a validation failure is a 400. Anything else here is a bug in this
    // service, not bad input, and must not be reported as the user's fault.
    // `name` is checked alongside `instanceof` so the branch still holds if a
    // test has loaded settings.mjs as a second module instance.
    if (err instanceof SettingsValidationError || err?.name === "SettingsValidationError") {
      // The message is client-safe by construction (see settings.mjs) and any
      // echoed value is length-capped there.
      logBasic("[Calendar] Settings rejected:", { field: err.field ?? "body" });
      return jsonResponse(400, { error: err.message, field: err.field ?? null }, { origin, allowlist });
    }
    logBasic("[Calendar] Settings validation failed unexpectedly:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return jsonResponse(500, { error: "Could not save your settings" }, { origin, allowlist });
  }

  let updated;
  try {
    updated = await persistSettings(session.claims.sub, settings, { updateConnection, updateItem, env });
  } catch (err) {
    // Never log the settings themselves: schoolName is personal data.
    logBasic("[Calendar] Could not save connection settings:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
    return jsonResponse(500, { error: "Could not save your settings" }, { origin, allowlist });
  }

  logBasic("[Calendar] Connection settings saved", { domainCount: settings.searchDomains.length });

  // The just-validated values are the fallback, so the response echoes what was
  // stored even when the update returned no attributes. `lookupFailed` is set in
  // that same case: the write succeeded, but the row's connection state was not
  // read back, and reporting a confident "not connected" would invite the user to
  // re-authorise a grant they already hold.
  return jsonResponse(
    200,
    toSettingsJson(updated, { email: session.claims.email, ...settings }, { lookupFailed: updated === null }),
    { origin, allowlist }
  );
}

/**
 * Dispatch the settings routes. Returns null when the request is not one of them,
 * so the handler can carry on to the frontend/404 paths.
 *
 * @param {string} path
 * @param {string} method
 * @param {object} event
 * @param {object} [options] Passed straight through to the route handlers.
 * @returns {Promise<object|null>}
 */
export async function routeSettingsRequest(path, method, event, options = {}) {
  if (path !== SETTINGS_PATH) return null;
  if (method === "GET") return handleGetSettings(event, options);
  if (method === "PUT") return handlePutSettings(event, options);
  return null;
}

// --- Scan and schedule routes (TASK-008) ---
// The manual "Scan now" button, its last-result readback, and the recurring
// EventBridge schedule the settings page manages. The scan itself lives in
// backend/scan.mjs, the schedule CRUD in backend/scan-schedule.mjs; this file
// only maps them onto HTTP, exactly as the auth and settings routes above do.

/** Route paths for the scan endpoints. */
const SCAN_PATH = "/calendar/api/scan";
const SCAN_STATUS_PATH = "/calendar/api/scan/status";
const SCAN_SCHEDULE_PATH = "/calendar/api/scan/schedule";

/**
 * POST /calendar/api/scan - run a scan for the signed-in user right now.
 *
 * Authenticated (401 without a session, matching every other route). A scan
 * already in progress for this user is reported as `409`, and Gmail is never
 * called in that case - `runScan` itself never even attempts the fetch when
 * its lock is held (see scan.mjs's concurrency note).
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof runScan} [options.runScan] Injectable scan runner.
 * @param {(() => number)|null} [options.getRemainingTimeInMillis] Real Lambda
 *   context method (wired by `handler`), for the deadline-aware extraction
 *   loop inside `runScan`.
 * @returns {Promise<object>} ALB response.
 */
export async function handleScanNow(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    runScan: doScan = runScan,
    // Everything else (getConnection, updateConnection, acquireScanLock,
    // releaseScanLock, fetchCandidateMessages, extractFromMessage,
    // storeEvents, getRemainingTimeInMillis, now, log, ...) is forwarded
    // straight through to `runScan`, which documents its own dependencies -
    // this route does not need to know their names to pass them on.
    ...scanDeps
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);

  let result;
  try {
    result = await doScan({ userId, mode: "manual" }, { ...scanDeps, env });
  } catch (err) {
    logBasic("[Calendar] Scan failed unexpectedly:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not run the scan" }, { origin, allowlist });
  }

  if (result.status === SCAN_STATUS.LOCKED) {
    return jsonResponse(409, { error: "A scan is already running" }, { origin, allowlist });
  }

  return jsonResponse(200, result, { origin, allowlist });
}

/**
 * GET /calendar/api/scan/status - the last scan's status and counts.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof getConnection} [options.getConnection] Injectable storage read.
 * @returns {Promise<object>} ALB response.
 */
export async function handleScanStatus(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    getConnection: loadConnection = getConnection,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);

  let connection;
  try {
    connection = await loadConnection(userId, { env });
  } catch (err) {
    logBasic("[Calendar] Could not read scan status:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not read your scan status" }, { origin, allowlist });
  }

  return jsonResponse(
    200,
    {
      lastScanAt: connection?.lastScanAt ?? null,
      lastScanStatus: connection?.lastScanStatus ?? null,
      lastScanError: connection?.lastScanError ?? null,
      messagesScanned: connection?.lastScanMessagesScanned ?? null,
      eventsCreated: connection?.lastScanEventsCreated ?? null,
      eventsUpdated: connection?.lastScanEventsUpdated ?? null,
      skipped: connection?.lastScanSkipped ?? null,
      truncated: connection?.lastScanTruncated ?? null,
    },
    { origin, allowlist }
  );
}

/**
 * GET /calendar/api/scan/schedule - the signed-in user's saved schedule.
 *
 * `getScanSchedule` itself reports `{ available: false }` when the scheduling
 * feature is not provisioned in this environment (TASK-008); that is a normal
 * 200, not an error.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof getScanSchedule} [options.getScanSchedule]
 * @returns {Promise<object>} ALB response.
 */
export async function handleGetSchedule(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    getScanSchedule: loadSchedule = getScanSchedule,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);

  let schedule;
  try {
    schedule = await loadSchedule(userId, { env });
  } catch (err) {
    logBasic("[Calendar] Could not read scan schedule:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not read your scan schedule" }, { origin, allowlist });
  }

  return jsonResponse(200, schedule, { origin, allowlist });
}

/**
 * PUT /calendar/api/scan/schedule - create or update the user's schedule.
 *
 * Order of checks mirrors `handlePutSettings`: session first, then body
 * validation (400, naming the field), then the write.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof putScanSchedule} [options.putScanSchedule]
 * @returns {Promise<object>} ALB response.
 */
export async function handlePutSchedule(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    putScanSchedule: saveSchedule = putScanSchedule,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);

  let payload;
  try {
    payload = parseJsonBody(event);
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return jsonResponse(400, { error: err.message, field: err.field ?? null }, { origin, allowlist });
    }
    logBasic("[Calendar] Scan schedule body could not be parsed:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not save your scan schedule" }, { origin, allowlist });
  }

  let result;
  try {
    result = await saveSchedule(userId, payload, { env });
  } catch (err) {
    if (err instanceof ScheduleValidationError || err?.name === "ScheduleValidationError") {
      logBasic("[Calendar] Scan schedule rejected:", { field: err.field ?? "body" });
      return jsonResponse(400, { error: err.message, field: err.field ?? null }, { origin, allowlist });
    }
    logBasic("[Calendar] Could not save scan schedule:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not save your scan schedule" }, { origin, allowlist });
  }

  return jsonResponse(200, result, { origin, allowlist });
}

/**
 * DELETE /calendar/api/scan/schedule - stop future scheduled scans.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof deleteScanSchedule} [options.deleteScanSchedule]
 * @returns {Promise<object>} ALB response.
 */
export async function handleDeleteSchedule(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    deleteScanSchedule: removeSchedule = deleteScanSchedule,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);

  let result;
  try {
    result = await removeSchedule(userId, { env });
  } catch (err) {
    logBasic("[Calendar] Could not delete scan schedule:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not delete your scan schedule" }, { origin, allowlist });
  }

  return jsonResponse(200, result, { origin, allowlist });
}

/**
 * Dispatch the scan/schedule routes. Returns null when the request is not one
 * of them, so the handler can carry on to the frontend/404 paths.
 *
 * @param {string} path
 * @param {string} method
 * @param {object} event
 * @param {object} [options] Passed straight through to the route handlers.
 * @returns {Promise<object|null>}
 */
export async function routeScanRequest(path, method, event, options = {}) {
  if (path === SCAN_PATH && method === "POST") return handleScanNow(event, options);
  if (path === SCAN_STATUS_PATH && method === "GET") return handleScanStatus(event, options);
  if (path === SCAN_SCHEDULE_PATH) {
    if (method === "GET") return handleGetSchedule(event, options);
    if (method === "PUT") return handlePutSchedule(event, options);
    if (method === "DELETE") return handleDeleteSchedule(event, options);
  }
  return null;
}

// --- Events API routes (TASK-009) ---
// What the scanner found, made readable: a range query for the calendar grid, a
// deadline-ordered list of things still to do, and three mutations that clear an
// item. The queries, the condition expressions and the response projection all
// live in backend/events.mjs; this file only maps them onto HTTP, exactly as the
// auth, settings and scan routes above do.
//
// THE USER ID IS NEVER TAKEN FROM THE REQUEST. Every handler below derives it
// from `resolveSession` -> `connectionUserId`, and none of them reads a `userId`
// query parameter, body field or header. A `?userId=` on any of these URLs is
// inert: it is not read, so it cannot be honoured. That is the whole of the
// tenancy boundary on the read side, because `queryEventsInRange` /
// `queryUpcomingEvents` put that value in the Query's HASH KEY - there is no
// broad read and no post-hoc filter that could be skipped.
//
// Error mapping, once, for all five routes:
//   EventValidationError -> 400 with the offending `field` (bad date range, bad
//     eventId). Its message is client-safe by construction and never echoes the
//     offending value.
//   EventNotFoundError   -> 404. NEVER 403: the row either is not this user's or
//     does not exist, and distinguishing those two would confirm that another
//     account's event id is real.
//   anything else        -> 500, with the error's name/message logged but never
//     its contents echoed.

/** Route paths for the events endpoints. */
const EVENTS_PATH = "/calendar/api/events";
const EVENTS_UPCOMING_PATH = "/calendar/api/events/upcoming";

/**
 * `/calendar/api/events/{eventId}/{action}`.
 *
 * The id group is deliberately greedy `(.+)` rather than a single path segment.
 * A traversal attempt like `/calendar/api/events/../../etc/passwd/acknowledge`
 * must reach `requireEventId` and come back as a 400 "that is not an event id";
 * a `[^/]+` group would simply not match, and the request would fall through to
 * the router's generic 404, which says nothing useful and hides the attempt from
 * the events-route logs.
 */
const EVENT_ACTION_PATTERN = /^\/calendar\/api\/events\/(.+)\/(acknowledge|dismiss|restore)$/;

/** The three mutations, so the dispatch table and the handlers cannot drift. */
const EVENT_ACTIONS = Object.freeze({
  ACKNOWLEDGE: "acknowledge",
  DISMISS: "dismiss",
  RESTORE: "restore",
});

/**
 * Split an event mutation path into its id and its action, or null when the path
 * is not one.
 *
 * The captured id is percent-decoded (ALB delivers path text still encoded) and
 * then handed to `requireEventId` unchanged - decoding here is what stops
 * `%2E%2E%2F` from looking like a plausible id, since the decoded value fails the
 * 64-hex test just as the raw one does.
 *
 * @param {string} path
 * @returns {{ eventId: string, action: string }|null}
 */
export function parseEventActionPath(path) {
  const match = EVENT_ACTION_PATTERN.exec(String(path ?? ""));
  if (!match) return null;
  return { eventId: decodeQueryValue(match[1]), action: match[2] };
}

/**
 * Map an events-layer error onto a response, or return null when it is not one
 * of the two the API models.
 *
 * Both classes are matched by `instanceof` AND by `name`, matching the settings
 * routes: a test that has loaded backend/events.mjs as a second module instance
 * would otherwise fall through to a 500.
 *
 * @param {unknown} err
 * @param {{ origin?: string|null, allowlist?: string[] }} responseOptions
 * @returns {object|null}
 */
function eventErrorResponse(err, responseOptions) {
  if (err instanceof EventValidationError || err?.name === "EventValidationError") {
    return jsonResponse(400, { error: err.message, field: err.field ?? null }, responseOptions);
  }
  if (err instanceof EventNotFoundError || err?.name === "EventNotFoundError") {
    // 404, never 403 - see the note at the top of this section.
    return jsonResponse(404, { error: "Event not found" }, responseOptions);
  }
  return null;
}

/**
 * GET /calendar/api/events?from=YYYY-MM-DD&to=YYYY-MM-DD - the calendar grid.
 *
 * Both parameters are optional; omitting them both is the current calendar
 * month. An unusable range (unparseable, reversed, or wider than a quarter) is a
 * 400 naming the field, decided before any DynamoDB call.
 *
 * @param {object} event
 * @param {object} [options]
 * @param {string|null} [options.origin]
 * @param {string[]} [options.allowlist]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.nowSeconds]
 * @param {typeof queryEventsInRange} [options.queryEventsInRange] Injectable read.
 * @param {Function} [options.query] Injectable raw DynamoDB Query.
 * @param {() => number} [options.now] Injectable epoch-ms clock.
 * @param {number} [options.maxItems]
 * @param {number} [options.maxPages]
 * @param {string|null} [options.tableName]
 * @param {Function} [options.log]
 * @returns {Promise<object>} ALB response.
 */
export async function handleGetEvents(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    queryEventsInRange: runRangeQuery = queryEventsInRange,
    query,
    now,
    maxItems,
    maxPages,
    tableName = null,
    log,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  // The ONLY two request-supplied values this route reads. `userId` comes from
  // the verified session below and from nowhere else.
  const from = getQueryParam(event, "from");
  const to = getQueryParam(event, "to");
  const userId = connectionUserId(session.claims.sub);

  let result;
  try {
    result = await runRangeQuery({ userId, from, to, tableName }, { query, now, maxItems, maxPages, env, log });
  } catch (err) {
    const mapped = eventErrorResponse(err, { origin, allowlist });
    if (mapped) return mapped;
    logBasic("[Calendar] Could not read events:", { errorName: err?.name || "Error", errorMessage: err?.message || "" });
    return jsonResponse(500, { error: "Could not read your calendar" }, { origin, allowlist });
  }

  return jsonResponse(200, result, { origin, allowlist });
}

/**
 * GET /calendar/api/events/upcoming?limit=N - the "needs attention" list.
 *
 * Ordered by deadline, soonest first, straight out of the sparse AttentionIndex.
 * `limit` defaults to 20 and is clamped to 100; an unusable value falls back to
 * the default rather than failing the request, because a page size is not data.
 *
 * @param {object} event
 * @param {object} [options] As `handleGetEvents`, with
 *   `queryUpcomingEvents` in place of `queryEventsInRange`.
 * @returns {Promise<object>} ALB response.
 */
export async function handleGetUpcoming(event, options = {}) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    queryUpcomingEvents: runAttentionQuery = queryUpcomingEvents,
    query,
    now,
    maxPages,
    tableName = null,
    log,
  } = options;

  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const limit = getQueryParam(event, "limit");
  const userId = connectionUserId(session.claims.sub);

  let result;
  try {
    result = await runAttentionQuery({ userId, limit, tableName }, { query, now, maxPages, env, log });
  } catch (err) {
    const mapped = eventErrorResponse(err, { origin, allowlist });
    if (mapped) return mapped;
    logBasic("[Calendar] Could not read the attention list:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "",
    });
    return jsonResponse(500, { error: "Could not read your reminders" }, { origin, allowlist });
  }

  return jsonResponse(200, result, { origin, allowlist });
}

/**
 * The body of all three mutation routes.
 *
 * `options.eventId` is set by `routeEventsRequest` from the URL path AFTER the
 * caller's options are spread, so the path value always wins - a dependency
 * override can never redirect a mutation at a different row than the one the URL
 * named.
 *
 * @param {object} event
 * @param {object} options
 * @param {string} action One of EVENT_ACTIONS.
 * @returns {Promise<object>} ALB response.
 */
async function handleEventMutation(event, options, action) {
  const {
    origin = null,
    allowlist,
    env = process.env,
    nowSeconds = Math.floor(Date.now() / 1000),
    eventId = null,
    acknowledgeEvent: doAcknowledge = acknowledgeEvent,
    dismissEvent: doDismiss = dismissEvent,
    restoreEvent: doRestore = restoreEvent,
    updateEvent,
    getEvent,
    now,
    tableName = null,
    log,
  } = options;

  // Session first, exactly as everywhere else in this file: an unauthenticated
  // caller gets a 401 and learns nothing about whether the id was well-formed.
  const session = resolveSession(event, { env, nowSeconds });
  if (!session.ok) {
    return jsonResponse(session.statusCode, session.payload, { origin, allowlist });
  }

  const userId = connectionUserId(session.claims.sub);
  const mutate =
    action === EVENT_ACTIONS.ACKNOWLEDGE ? doAcknowledge : action === EVENT_ACTIONS.DISMISS ? doDismiss : doRestore;

  let updated;
  try {
    // `eventId` is validated inside the events module before it resolves a table
    // name or touches DynamoDB, so a malformed id costs no call at all.
    updated = await mutate({ userId, eventId, tableName }, { updateEvent, getEvent, now, env, log });
  } catch (err) {
    const mapped = eventErrorResponse(err, { origin, allowlist });
    if (mapped) return mapped;
    logBasic("[Calendar] Could not update an event:", {
      action,
      errorName: err?.name || "Error",
      errorMessage: err?.message || "",
    });
    return jsonResponse(500, { error: "Could not update the event" }, { origin, allowlist });
  }

  return jsonResponse(200, { event: updated }, { origin, allowlist });
}

/**
 * POST /calendar/api/events/{eventId}/acknowledge
 * @param {object} event
 * @param {object} [options] Carries the path-derived `eventId`.
 * @returns {Promise<object>} ALB response.
 */
export async function handleAcknowledgeEvent(event, options = {}) {
  return handleEventMutation(event, options, EVENT_ACTIONS.ACKNOWLEDGE);
}

/**
 * POST /calendar/api/events/{eventId}/dismiss
 * @param {object} event
 * @param {object} [options] Carries the path-derived `eventId`.
 * @returns {Promise<object>} ALB response.
 */
export async function handleDismissEvent(event, options = {}) {
  return handleEventMutation(event, options, EVENT_ACTIONS.DISMISS);
}

/**
 * POST /calendar/api/events/{eventId}/restore
 * @param {object} event
 * @param {object} [options] Carries the path-derived `eventId`.
 * @returns {Promise<object>} ALB response.
 */
export async function handleRestoreEvent(event, options = {}) {
  return handleEventMutation(event, options, EVENT_ACTIONS.RESTORE);
}

/**
 * Dispatch the events routes. Returns null when the request is not one of them,
 * so the handler can carry on to the frontend/404 paths.
 *
 * `/calendar/api/events/upcoming` is matched BEFORE the mutation pattern, and the
 * mutation pattern requires a trailing action segment, so the literal path can
 * never be read as an event id.
 *
 * @param {string} path
 * @param {string} method
 * @param {object} event
 * @param {object} [options] Passed straight through to the route handlers.
 * @returns {Promise<object|null>}
 */
export async function routeEventsRequest(path, method, event, options = {}) {
  if (path === EVENTS_UPCOMING_PATH) {
    return method === "GET" ? handleGetUpcoming(event, options) : null;
  }
  if (path === EVENTS_PATH) {
    return method === "GET" ? handleGetEvents(event, options) : null;
  }

  const action = parseEventActionPath(path);
  if (!action || method !== "POST") return null;

  // Path last: the URL decides which row is mutated, never the options object.
  const withEventId = { ...options, eventId: action.eventId };
  if (action.action === EVENT_ACTIONS.ACKNOWLEDGE) return handleAcknowledgeEvent(event, withEventId);
  if (action.action === EVENT_ACTIONS.DISMISS) return handleDismissEvent(event, withEventId);
  if (action.action === EVENT_ACTIONS.RESTORE) return handleRestoreEvent(event, withEventId);
  return null;
}

/**
 * Narrow the handler's third argument down to route dependency overrides.
 *
 * SECURITY: the Node.js Lambda runtime invokes handlers with THREE arguments -
 * `(event, context, callback)` - async handlers included. So in production this
 * parameter receives the runtime's callback FUNCTION and the `= {}` default never
 * applies. `routeAuthRequest`/`routeSettingsRequest` spread it, so any own
 * enumerable property on whatever arrives third would land in the route layer as
 * a dependency override - `tokenEndpoint`, `fetchImpl` and `exchangeCode`
 * included. Pointing the code exchange at an attacker-controlled token endpoint
 * is by itself enough to mint a site session for any account it names, because
 * the `id_token` signature is deliberately not verified (see `decodeIdToken` in
 * backend/google-oauth.mjs).
 *
 * A function happens to contribute nothing today, but only by accident: a
 * function's built-in `name`/`length` are non-enumerable, and the runtime's
 * callback carries no assigned own properties. Nothing in the code or the tests
 * would notice that margin disappearing - an APM/instrumentation wrapper, a
 * runtime change or in-house middleware could re-supply a callback with an own
 * property on it. This check makes the guarantee structural instead: only a
 * plain object (prototype `Object.prototype`, or null) is honoured as injection;
 * a function, class instance, array or primitive contributes no overrides at all.
 *
 * The rule is identical in production and under test on purpose: it reads no
 * NODE_ENV, no test-only env var, and no other signal that is absent in prod.
 *
 * @param {unknown} value The third handler argument.
 * @returns {object} `value` when it is a plain object, otherwise `{}`.
 */
function asRouteDeps(value) {
  if (value === null || typeof value !== "object") return {};
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return {};
  return value;
}

/**
 * Lambda handler for the school calendar app, invoked by the shared web-app ALB
 * on the /calendar* path prefix.
 *
 * The health check is what the target group polls, so it answers first and stays
 * deliberately open. The Google sign-in routes follow, then settings, the scan/
 * schedule endpoints and the events API. The frontend is added by TASK-010.
 *
 * The third parameter is an injection seam, not part of the Lambda contract: the
 * runtime calls `handler(event, context, callback)` and its callback is a
 * function, which `asRouteDeps` rejects, so production supplies no overrides. A
 * test can call
 * `handler(event, {}, { getConnection, putConnection, exchangeCode, env, ... })`
 * to exercise a route with no AWS credentials and no network. A plain object
 * passed here is forwarded verbatim to the route handlers, which document their
 * own dependencies; anything that is not a plain object is ignored.
 *
 * @param {object} event
 * @param {object} [context]
 * @param {object} [deps] Route dependency overrides. Honoured only when it is a
 *   plain object, so the runtime's `callback` argument cannot inject anything.
 */
export async function handler(event, context = undefined, deps = {}) {
  // Production receives the runtime's callback here; only a plain object is
  // honoured as dependency overrides (see asRouteDeps for why this is enforced).
  const routeDeps = asRouteDeps(deps);

  // EventBridge Scheduler firing a recurring scan (TASK-008). Checked BEFORE
  // any ALB routing below: this event shape carries no `path`/`httpMethod` at
  // all, and the caller is EventBridge, not a browser, so the return value
  // must be a plain result object, never the ALB response shape the rest of
  // this handler builds. `getRemainingTimeInMillis` is threaded from the real
  // Lambda `context` (absent in a test, which then falls back to
  // scan.mjs's own DEFAULT_MAX_SCAN_DURATION_MS) so the extraction loop can
  // stay inside this invocation's actual remaining time.
  if (isScheduledScanEvent(event)) {
    const scheduledDeps = { env: process.env, ...routeDeps };
    if (
      typeof scheduledDeps.getRemainingTimeInMillis !== "function" &&
      typeof context?.getRemainingTimeInMillis === "function"
    ) {
      scheduledDeps.getRemainingTimeInMillis = () => context.getRemainingTimeInMillis();
    }
    return runScheduledScan(event, scheduledDeps);
  }

  const path = event?.path || "/";
  const method = (event?.httpMethod || "GET").toUpperCase();
  const headers = event?.multiValueHeaders || event?.headers || {};
  const origin = getRequestOrigin(headers);

  logBasic("[Calendar] Request:", { method, path, origin: origin || "none" });

  // Every value this function returns goes through `finalise` immediately
  // before it leaves the router (TASK-022), so the credentials-vs-wildcard
  // invariant holds even for a future route that hand-rolls a raw response
  // and bypasses buildResponse entirely - see finalise's docblock.

  // CORS preflight for all routes.
  if (method === "OPTIONS") {
    return finalise(buildResponse(200, "", "application/json", { origin }));
  }

  // Health check — deliberately open: ALB health checks send no Origin header
  // and no credentials, and the body carries nothing sensitive.
  if (path === "/calendar/api/health" && method === "GET") {
    return finalise(
      jsonResponse(
        200,
        {
          status: "ok",
          service: "school-calendar",
          timestamp: new Date().toISOString(),
        },
        { origin }
      )
    );
  }

  // Google sign-in, session and connection status. `origin` is resolved once
  // above; `allowlist` is left to buildResponse's default unless a caller
  // overrides it. A `null` or non-array allowlist now fails safe rather than
  // throwing (TASK-022; see coerceAllowlist).
  const authResponse = await routeAuthRequest(path, method, event, { origin, ...routeDeps });
  if (authResponse) {
    return finalise(authResponse);
  }

  // School name and search domains. Authenticated: every response is either the
  // signed-in user's own settings or a 401.
  const settingsResponse = await routeSettingsRequest(path, method, event, { origin, ...routeDeps });
  if (settingsResponse) {
    return finalise(settingsResponse);
  }

  // Manual "Scan now", its last-result readback, and the recurring schedule
  // (TASK-008). Every response is either the signed-in user's own scan/
  // schedule state or a 401. `getRemainingTimeInMillis` is threaded from the
  // real Lambda `context` for the same reason as the scheduled-invocation
  // branch above - a manual scan's extraction loop must also stay inside this
  // invocation's actual remaining time, not just its own message cap.
  const scanRouteOptions = { origin, ...routeDeps };
  if (
    typeof scanRouteOptions.getRemainingTimeInMillis !== "function" &&
    typeof context?.getRemainingTimeInMillis === "function"
  ) {
    scanRouteOptions.getRemainingTimeInMillis = () => context.getRemainingTimeInMillis();
  }
  const scanResponse = await routeScanRequest(path, method, event, scanRouteOptions);
  if (scanResponse) {
    return finalise(scanResponse);
  }

  // The events API (TASK-009): the calendar grid, the "needs attention" list and
  // the three mutations that clear an item. Every response is either the
  // signed-in user's own events or a 401 - the session's `sub` is what becomes
  // the Query's hash key, and no handler reads a `userId` from the request.
  const eventsResponse = await routeEventsRequest(path, method, event, { origin, ...routeDeps });
  if (eventsResponse) {
    return finalise(eventsResponse);
  }

  // 404 for everything else — the frontend assets arrive with TASK-010.
  return finalise(jsonResponse(404, { error: "Not found", path }, { origin }));
}

// Exported for unit tests and for the route modules added by later tickets.
export {
  asRouteDeps,
  buildResponse,
  finalise,
  coerceAllowlist,
  jsonResponse,
  getCorsOrigin,
  isOriginAllowed,
  parseAllowedOrigins,
  ALLOWED_ORIGINS,
  fileCache,
  ASSET_DIR,
  getQueryParam,
  AUTH_START_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_ME_PATH,
  AUTH_DISCONNECT_PATH,
  SETTINGS_PATH,
  SCAN_PATH,
  SCAN_STATUS_PATH,
  SCAN_SCHEDULE_PATH,
  EVENTS_PATH,
  EVENTS_UPCOMING_PATH,
};
