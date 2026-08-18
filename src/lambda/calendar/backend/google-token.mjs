/**
 * google-token.mjs - mints (and caches) the short-lived Gmail ACCESS token from
 * the stored refresh token.
 *
 * The authorisation-code exchange lives in google-oauth.mjs and happens once, at
 * connect time. This module is the other half: every later scan needs a fresh
 * access token, and the only durable credential the app holds is the wrapped
 * refresh token in the connections table.
 *
 * CONTAINMENT RULE (see connections.mjs): `getRefreshToken` is the single exit
 * for refresh-token material. This module calls it, hands the value straight to
 * Google's token endpoint, and lets it go out of scope. The refresh token is
 * never returned to a caller, never cached, never put in an error message and
 * never logged - and neither is the access token this module returns.
 *
 * PER-CONTAINER CACHE: access tokens are cached in MODULE MEMORY, keyed by
 * userId. A warm Lambda container serves many requests, and Google's token
 * endpoint is a network round trip that also counts against a quota, so
 * re-minting on every call is pure waste when the token is good for an hour.
 * The cache is therefore per-container, NOT global: a cold start, a second
 * container or a redeploy simply mints again, which is correct but slower. It is
 * deliberately never persisted - a stored access token would be a second copy of
 * a credential for no benefit, given it expires in an hour anyway.
 *
 * Because that cache is module state, tests MUST be able to clear it or they
 * become order-dependent: `resetTokenCache()` is that seam, and
 * `getCachedTokenExpiry()` lets a test assert on the cache without the token
 * itself being exposed.
 *
 * REVOCATION: when a user removes the app from their Google account, the refresh
 * token is dead and no amount of retrying will help. Google reports that as
 * `400 invalid_grant`, which this module turns into a `ReauthRequiredError` and
 * records as `lastScanStatus = "reauth_required"` on the connection, so the UI
 * can ask for a reconnect instead of showing a generic failure that a user
 * cannot act on.
 *
 * TESTABILITY: every I/O boundary (`fetchImpl`, `getRefreshToken`,
 * `updateConnection`, `nowSeconds`, `env`) is an injectable parameter with a real
 * default. No network call and no AWS call happens on an injected path.
 *
 * SECURITY: nothing here logs a refresh token, an access token, a client secret
 * or a token-endpoint response body, at any level.
 */

import { GOOGLE_TOKEN_ENDPOINT, readOAuthConfig, missingConfigVars } from "./google-oauth.mjs";
import {
  getRefreshToken as getStoredRefreshToken,
  updateConnection as updateStoredConnection,
} from "./connections.mjs";

export { GOOGLE_TOKEN_ENDPOINT };

/**
 * How much life a cached token must have left to be reused.
 *
 * A token that expires in 5 seconds is worthless: the Gmail call it is handed to
 * may well take longer than that, and the resulting 401 costs a round trip and a
 * re-mint anyway. 60 seconds is comfortably longer than any single Gmail request
 * in this app.
 */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

/** `lastScanStatus` written when the user's grant has been revoked. */
export const REAUTH_SCAN_STATUS = "reauth_required";

/** Config variables the refresh grant cannot run without. */
export const REQUIRED_REFRESH_VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

/**
 * Raised when the stored grant can no longer mint tokens and only the user can
 * fix it, by reconnecting Gmail.
 *
 * Distinguishable on purpose: callers branch on this to render a "reconnect
 * Gmail" state, so it must not be mistaken for a transient failure. Checked with
 * `instanceof` or on `err.name`, which survives a structured-clone boundary.
 *
 * `reason` is a short, log-safe token ("invalid_grant", "no_refresh_token") -
 * never token material.
 */
export class ReauthRequiredError extends Error {
  /**
   * @param {string} message
   * @param {{ reason?: string, userId?: string }} [details]
   */
  constructor(message, { reason = "invalid_grant", userId = "" } = {}) {
    super(message);
    this.name = "ReauthRequiredError";
    this.reason = reason;
    this.userId = userId;
    this.reauthRequired = true;
  }
}

/** Raised for any other token-endpoint failure (network, 5xx, malformed body). */
export class TokenRefreshError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, oauthError?: string }} [details]
   */
  constructor(message, { statusCode = 0, oauthError = "" } = {}) {
    super(message);
    this.name = "TokenRefreshError";
    this.statusCode = statusCode;
    this.oauthError = oauthError;
  }
}

/**
 * userId -> { accessToken, expiresAt } where `expiresAt` is epoch SECONDS.
 *
 * Per-container state; see the module docblock. Never serialised, never logged.
 */
const tokenCache = new Map();

/**
 * Drop cached access tokens.
 *
 * Test seam FIRST (module state that cannot be cleared makes tests
 * order-dependent), and also the right thing to call after a disconnect so a
 * revoked grant's token cannot be reused for the rest of the container's life.
 *
 * @param {string|null} [userId] One user, or every user when omitted.
 * @returns {void}
 */
export function resetTokenCache(userId = null) {
  if (userId) tokenCache.delete(userId);
  else tokenCache.clear();
}

/**
 * Expiry (epoch seconds) of a user's cached token, or null when nothing is
 * cached.
 *
 * Deliberately exposes only the EXPIRY, not the token: this is an observability
 * and test hook, and it must not become a second way to obtain credentials.
 *
 * @param {string} userId
 * @returns {number|null}
 */
export function getCachedTokenExpiry(userId) {
  const entry = tokenCache.get(userId);
  return entry ? entry.expiresAt : null;
}

/**
 * Is this cache entry usable right now?
 *
 * Pure and exported so the skew rule is testable without any I/O at all.
 *
 * @param {{ accessToken?: string, expiresAt?: number }|null|undefined} entry
 * @param {number} nowInSeconds
 * @param {number} [skewSeconds]
 * @returns {boolean}
 */
export function isTokenFresh(entry, nowInSeconds, skewSeconds = TOKEN_EXPIRY_SKEW_SECONDS) {
  if (!entry || typeof entry.accessToken !== "string" || entry.accessToken.length === 0) return false;
  if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)) return false;
  return entry.expiresAt - nowInSeconds >= skewSeconds;
}

/**
 * Record that this connection needs re-authorisation.
 *
 * Best effort ON PURPOSE: the caller is already about to throw
 * `ReauthRequiredError`, and a DynamoDB blip while writing the marker must not
 * replace that actionable error with a storage error. The write failure is
 * reported as a count-only log line and swallowed.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {Function} [deps.updateConnection]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<boolean>} Whether the marker was written.
 */
export async function markReauthRequired(
  userId,
  { updateConnection = updateStoredConnection, env = process.env, log = defaultLog } = {}
) {
  try {
    await updateConnection(userId, { lastScanStatus: REAUTH_SCAN_STATUS }, { env });
    return true;
  } catch {
    log("calendar.token.reauth_marker_failed", { userId });
    return false;
  }
}

/**
 * Build a logger that honours CALENDAR_LOG_LEVEL=none from the given
 * environment.
 *
 * A FACTORY, not a module-level constant, so the level comes from the same
 * injectable `env` as the rest of the configuration and is read per request.
 * Only counts, ids, statuses and token LIFETIMES are ever passed to it - never a
 * token value.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {(message: string, fields?: object) => void}
 */
export function makeLogger(env = process.env) {
  return (message, fields = undefined) => {
    if ((env?.CALENDAR_LOG_LEVEL || "basic") === "none") return;
    if (fields === undefined) console.log(message);
    else console.log(message, fields);
  };
}

/** Logger used when a caller injected neither `log` nor `env`. */
function defaultLog(message, fields = undefined) {
  makeLogger(process.env)(message, fields);
}

/**
 * Get a usable Gmail access token for a user, minting one only when needed.
 *
 * Cache hit: returns the cached token with no HTTP call at all, as long as more
 * than `TOKEN_EXPIRY_SKEW_SECONDS` of life remain. Cache miss, expiry inside the
 * skew window, or `forceRefresh`: decrypts the stored refresh token, POSTs
 * `grant_type=refresh_token`, caches the result and returns it.
 *
 * NOT retried here. A transient 5xx from the token endpoint surfaces as
 * `TokenRefreshError` and the scan fails, to be retried on its next scheduled
 * run - that is a cheaper and more predictable behaviour than a retry loop
 * around a credential mint, and it keeps this module free of timers. The Gmail
 * request path (gmail.mjs) does retry, because a scan makes hundreds of calls
 * there and one blip should not lose the batch.
 *
 * @param {string} userId Connections-table key ("google#<sub>").
 * @param {object} [deps]
 * @param {boolean} [deps.forceRefresh] Ignore (and replace) any cached token;
 *   used by gmail.mjs to re-mint exactly once after a 401.
 * @param {(userId: string, options?: object) => Promise<string|null>} [deps.getRefreshToken]
 * @param {Function} [deps.updateConnection] Used only to mark reauth_required.
 * @param {(url: string, init: object) => Promise<any>} [deps.fetchImpl]
 * @param {string} [deps.tokenEndpoint]
 * @param {() => number} [deps.nowSeconds] Epoch-seconds clock.
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<string>} A bearer access token.
 * @throws {ReauthRequiredError} Grant revoked, or no stored grant at all.
 * @throws {TokenRefreshError} Any other token-endpoint failure.
 */
export async function getAccessToken(
  userId,
  {
    forceRefresh = false,
    getRefreshToken = getStoredRefreshToken,
    updateConnection = updateStoredConnection,
    fetchImpl = globalThis.fetch,
    tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    env = process.env,
    log = null,
  } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("getAccessToken: userId is required");

  // Resolved from the injected `env` when the caller did not supply a logger, so
  // CALENDAR_LOG_LEVEL is honoured per request rather than per container.
  const logLine = typeof log === "function" ? log : makeLogger(env);

  if (!forceRefresh && isTokenFresh(tokenCache.get(userId), nowSeconds())) {
    return tokenCache.get(userId).accessToken;
  }

  // A stale entry is dropped BEFORE the mint, so a failed refresh cannot leave a
  // token behind that the next call would happily reuse.
  tokenCache.delete(userId);

  if (typeof fetchImpl !== "function") {
    throw new TokenRefreshError("getAccessToken: no fetch implementation available");
  }

  const config = readOAuthConfig(env);
  const missing = missingConfigVars(config, REQUIRED_REFRESH_VARS);
  if (missing.length > 0) {
    // Names only - safe to log, and the reason a misconfiguration is diagnosable.
    throw new TokenRefreshError(`getAccessToken: missing configuration: ${missing.join(", ")}`);
  }

  const refreshToken = await getRefreshToken(userId, { env });
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    // No stored grant: the same user-facing outcome as a revoked one, so it is
    // the same error type. `lastScanStatus` is NOT written here - an UpdateItem
    // on a userId with no row CREATES one, and inventing a stub connection for a
    // user who never connected would make the settings page report a broken
    // connection rather than no connection.
    throw new ReauthRequiredError("Gmail is not connected for this user", {
      reason: "no_refresh_token",
      userId,
    });
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  // Read once as text so a non-JSON error page does not throw, and parse
  // defensively - the raw text is never included in an error, because a token
  // endpoint body can carry token material.
  const text = typeof response?.text === "function" ? await response.text() : "";
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response?.ok) {
    const status = response?.status ?? 0;
    const oauthError = typeof payload?.error === "string" ? payload.error : "";

    // The revocation signal. Google also uses invalid_grant for an expired or
    // already-rotated refresh token; in every one of those cases the user has to
    // reconnect, so they share one outcome.
    if (status === 400 && oauthError === "invalid_grant") {
      await markReauthRequired(userId, { updateConnection, env, log: logLine });
      logLine("calendar.token.reauth_required", { userId, status });
      throw new ReauthRequiredError("Gmail authorisation has been revoked; the user must reconnect", {
        reason: "invalid_grant",
        userId,
      });
    }

    const description = typeof payload?.error_description === "string" ? payload.error_description : "";
    const label = oauthError || `http_${status || "unknown"}`;
    throw new TokenRefreshError(
      description ? `Google token refresh failed: ${label}: ${description}` : `Google token refresh failed: ${label}`,
      { statusCode: status, oauthError: label }
    );
  }

  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (!accessToken) {
    throw new TokenRefreshError("Google token refresh returned no access_token", {
      statusCode: response?.status ?? 0,
    });
  }

  // `expires_in` is trusted as-is rather than clamped to an hour: a SHORT value
  // is honoured, which is what makes the next call re-mint (the skew check sees
  // too little life left) instead of carrying a token Google has already retired.
  const expiresIn = typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 0;
  tokenCache.set(userId, { accessToken, expiresAt: nowSeconds() + expiresIn });

  // Counts and ids only. The token and its value never reach a log line; the
  // lifetime does, because it is useful and is not a secret.
  logLine("calendar.token.minted", { userId, expiresIn });

  return accessToken;
}
