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
 * Is this origin covered by the allowlist (exact host or domain suffix)?
 *
 * The suffix match requires a dot boundary: an entry of "officehq.com.au"
 * matches "officehq.com.au" and "sub.officehq.com.au" but NOT the lookalike
 * "evil-officehq.com.au" (a bare `host.endsWith(allowed)` would accept it) and
 * not "officehq.com.au.attacker.com" (which the suffix test rules out).
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
  return allowlist.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/**
 * Determine the CORS origin to return.
 * - allowlist empty (open mode) -> "*"
 * - origin in allowlist         -> echo it back
 * - otherwise                   -> null (no CORS header, browser blocks it)
 *
 * @param {string|null|undefined} origin
 * @param {string[]} [allowlist]  defaults to the module-scope allowlist
 */
function getCorsOrigin(origin, allowlist = ALLOWED_ORIGINS) {
  if (allowlist.length === 0) return "*";
  if (origin && isOriginAllowed(origin, allowlist)) return origin;
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
    "Access-Control-Allow-Methods": ["GET, POST, DELETE, OPTIONS"],
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

// --- Google sign-in routes ---
// The Google grant is both the site login and the Gmail read authorisation, so
// these four routes are the whole of authentication. The flow itself lives in
// backend/google-oauth.mjs, the cookie in backend/session.mjs and the storage in
// backend/connections.mjs; this file only maps them onto HTTP.
//
// Every response below goes through buildResponse/jsonResponse. Nothing here
// hand-rolls a `{ statusCode ... }` object, because the "no credentials with a
// wildcard origin" invariant lives inside buildResponse and a hand-rolled
// response would bypass it. `allowlist` is likewise only ever passed through as
// undefined or an array - never null, which buildResponse cannot handle yet
// (TASK-022).

/** Route prefix for the auth endpoints. */
const AUTH_START_PATH = "/calendar/api/auth/google/start";
const AUTH_CALLBACK_PATH = "/calendar/api/auth/google/callback";
const AUTH_LOGOUT_PATH = "/calendar/api/auth/logout";
const AUTH_ME_PATH = "/calendar/api/auth/me";

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

/**
 * GET /calendar/api/auth/me - who is signed in, and are they connected?
 *
 * Response body is the `toPublicJson` projection: `email`, `schoolName`,
 * `connected`. No token, no ciphertext, no key id - `connected` is derived from
 * whether a wrapped refresh token exists, so the answer never requires touching
 * the token itself.
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
  try {
    connection = await loadConnection(connectionUserId(claims.sub), { env });
  } catch (err) {
    // A lookup failure must not log the user out: the session is valid on its
    // own. Report the identity we can prove and connected=false, and say so.
    logBasic("[Calendar] Connection lookup failed; reporting connected=false:", {
      errorName: err?.name || "Error",
      errorMessage: err?.message || "unknown error",
    });
  }

  return jsonResponse(200, toPublicJson(connection, { email: claims.email }), { origin, allowlist });
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
  return null;
}

/**
 * Lambda handler for the school calendar app, invoked by the shared web-app ALB
 * on the /calendar* path prefix.
 *
 * The health check is what the target group polls, so it answers first and stays
 * deliberately open. The Google sign-in routes follow. The events API and the
 * frontend are added by later tickets.
 *
 * The third parameter is an injection seam, not part of the Lambda contract: AWS
 * calls `handler(event, context)`, and a test can call
 * `handler(event, {}, { getConnection, putConnection, exchangeCode, env, ... })`
 * to exercise a route with no AWS credentials and no network. Anything passed
 * here is forwarded verbatim to the route handlers, which document their own
 * dependencies.
 *
 * @param {object} event
 * @param {object} [context]
 * @param {object} [deps] Route dependency overrides (tests only).
 */
export async function handler(event, context = undefined, deps = {}) {
  const path = event?.path || "/";
  const method = (event?.httpMethod || "GET").toUpperCase();
  const headers = event?.multiValueHeaders || event?.headers || {};
  const origin = getRequestOrigin(headers);

  logBasic("[Calendar] Request:", { method, path, origin: origin || "none" });

  // CORS preflight for all routes.
  if (method === "OPTIONS") {
    return buildResponse(200, "", "application/json", { origin });
  }

  // Health check — deliberately open: ALB health checks send no Origin header
  // and no credentials, and the body carries nothing sensitive.
  if (path === "/calendar/api/health" && method === "GET") {
    return jsonResponse(
      200,
      {
        status: "ok",
        service: "school-calendar",
        timestamp: new Date().toISOString(),
      },
      { origin }
    );
  }

  // Google sign-in, session and connection status. `origin` is resolved once
  // above; `allowlist` is left to buildResponse's default unless a caller
  // overrides it (never pass null - see TASK-022).
  const authResponse = await routeAuthRequest(path, method, event, { origin, ...deps });
  if (authResponse) {
    return authResponse;
  }

  // 404 for everything else — later tickets add the real routes.
  return jsonResponse(404, { error: "Not found", path }, { origin });
}

// Exported for unit tests and for the route modules added by later tickets.
export {
  buildResponse,
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
};
