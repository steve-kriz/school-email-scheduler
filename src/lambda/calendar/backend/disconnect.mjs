/**
 * disconnect.mjs - revoking the Gmail grant and erasing what was stored.
 *
 * TASK-004's logout ends the browser session and nothing else: the refresh token
 * stays live and every extracted event stays in the table. This module is the
 * real way out, and it is also a Limited Use requirement for the restricted
 * `gmail.readonly` scope (TASK-012), not a courtesy.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER.
 *
 * The two halves of a disconnect fail in opposite directions, so the sequence is
 * chosen to make every partial failure RETRYABLE rather than terminal:
 *
 *   1. READ the refresh token. The connection row is the app's ONLY copy of the
 *      grant (see connections.mjs). Deleting the row first would destroy the
 *      credential the revocation needs, leaving a live grant on the user's Google
 *      account that this app can never again revoke on their behalf.
 *   2. REVOKE at Google. `200` and `400 invalid_token` are both success -
 *      a `400` means the grant is already gone, which IS the desired end state,
 *      and failing the request there would strand a user who cannot get out.
 *      Anything else (network error, 5xx, an unrecognised 4xx) aborts the whole
 *      disconnect with NOTHING deleted. A retryable failure is strictly better
 *      than an unrevocable live grant, so this path FAILS CLOSED.
 *   3. CLEAR the recurring scan schedule, so nothing keeps firing for an account
 *      that is about to have no connection row at all.
 *   4. DELETE the connection row. Irreversible on purpose - the wrapped refresh
 *      token goes with it.
 *   5. DELETE the events, when and only when the caller asked. Independent of
 *      revocation: erasing a calendar is safe whether or not Google answered.
 *
 * The reverse-order failures are the ones that matter, so they are stated
 * explicitly:
 *   - revoke OK, delete fails  -> the grant is dead and the row survives. The
 *     user retries; the second revoke returns `400 invalid_token`, which is
 *     success, and the delete is attempted again. Harmless and self-healing.
 *   - revoke fails, delete done -> NEVER REACHABLE. That is the ordering's whole
 *     purpose: a failed revocation returns before any delete runs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT RAISE THE REVOCATION ALARM.
 *
 * TASK-011 wired `ALARM_TOKENS.REAUTH_REQUIRED` to the `400 invalid_grant`
 * branch of google-token.mjs, so a wave of revoked grants pages an operator.
 * A user-initiated disconnect is not that event, and must not be counted as one:
 * this module never calls `emitAlarm`, and it talks to Google's REVOKE endpoint,
 * not its token endpoint, so it cannot reach that branch either. After the row is
 * gone a later scan takes google-token.mjs's `no_refresh_token` path, which is
 * also deliberately alarm-free. A disconnect therefore produces zero alarm
 * events, which is what makes the alarm mean "grants are being revoked at
 * Google" rather than "people are leaving".
 *
 * TESTABILITY: every I/O boundary (`fetchImpl`, `revokeEndpoint`, and every
 * storage function) is an injectable parameter with a real default. No network
 * call, no AWS call and no KMS call happens on an injected path.
 *
 * SECURITY: nothing here logs the refresh token, the revoke request body, the
 * revoke response body, or an event title. Log lines carry the userId, counts
 * and outcome flags only.
 */

import {
  deleteConnection as deleteStoredConnection,
  getConnection as getStoredConnection,
  getRefreshToken as getStoredRefreshToken,
} from "./connections.mjs";
import { deleteEventsForUser as deleteStoredEventsForUser } from "./events.mjs";
import { deleteScanSchedule as deleteStoredScanSchedule } from "./scan-schedule.mjs";
import { resetTokenCache } from "./google-token.mjs";

/** Google's OAuth 2.0 revocation endpoint (RFC 7009). */
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * The one `400` body Google returns that means "already revoked". Treated as
 * success; every other 4xx is a failure, because guessing wrong here destroys the
 * only copy of a still-live grant.
 */
export const ALREADY_REVOKED_ERROR = "invalid_token";

/**
 * Raised when the grant could not be revoked and the caller must NOT delete
 * anything.
 *
 * Distinguishable on purpose: the route maps it to `502` with a "please try
 * again" message, because the failure is Google's or the network's, not the
 * user's, and it is retryable. Checked with `instanceof` or on `err.name`, which
 * survives a second module instance in a test.
 *
 * `reason` is a short, log-safe token ("network_error", "http_500",
 * "invalid_request") - never token material and never a response body.
 */
export class RevocationError extends Error {
  /**
   * @param {string} message
   * @param {{ reason?: string, statusCode?: number }} [details]
   */
  constructor(message, { reason = "revoke_failed", statusCode = 0 } = {}) {
    super(message);
    this.name = "RevocationError";
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/**
 * Build a logger that honours CALENDAR_LOG_LEVEL from the given environment.
 * A factory, per request, exactly as in events.mjs and google-token.mjs.
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

/**
 * POST the refresh token to Google's revoke endpoint.
 *
 * The request body is built inline and never bound to a named variable, so there
 * is no `body` in scope for a log line to reach for; the response body is read
 * only to look at its `error` field and is never logged or put in an error
 * message.
 *
 * SUCCESS IS NARROW ON PURPOSE. `200` is success, and `400` is success only when
 * the parsed body says `invalid_token`. A `400` whose body will not parse is
 * treated as a FAILURE, not charitably as "probably already revoked": a wrong
 * "already gone" verdict deletes the only copy of a live token, whereas a wrong
 * failure verdict costs the user one retry. The cheap mistake is the one to make.
 *
 * @param {string} refreshToken PLAINTEXT. Never logged, never returned.
 * @param {object} [deps]
 * @param {(url: string, init: object) => Promise<any>} [deps.fetchImpl]
 * @param {string} [deps.revokeEndpoint]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ revoked: true, alreadyRevoked: boolean, statusCode: number }>}
 *   `revoked` reports the END STATE - the grant is no longer live - so it is true
 *   for an already-revoked grant as well as for one revoked by this call.
 * @throws {RevocationError} Anything else. The caller must delete nothing.
 */
export async function revokeGrant(
  refreshToken,
  { fetchImpl = globalThis.fetch, revokeEndpoint = GOOGLE_REVOKE_ENDPOINT, env = process.env, log = null } = {}
) {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("revokeGrant: refreshToken is required");
  }
  const logLine = typeof log === "function" ? log : makeLogger(env);

  if (typeof fetchImpl !== "function") {
    throw new RevocationError("No fetch implementation is available to revoke the grant", { reason: "no_fetch" });
  }

  let response;
  try {
    response = await fetchImpl(revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Inline: the only place the token appears, and it goes out of scope with
      // the call. `URLSearchParams` also percent-encodes it, so a token
      // containing "&" or "=" cannot smuggle a second parameter into the form.
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
  } catch {
    // Error NAME only. A fetch failure message can carry the request URL and,
    // depending on the runtime, the request itself.
    throw new RevocationError("Could not reach Google to revoke the grant", {
      reason: "network_error",
      statusCode: 0,
    });
  }

  const statusCode = Number.isFinite(response?.status) ? response.status : 0;

  if (response?.ok === true) {
    logLine("calendar.disconnect.revoked", { statusCode, alreadyRevoked: false });
    return { revoked: true, alreadyRevoked: false, statusCode };
  }

  // Read once as text so a non-JSON error page does not throw, and parse
  // defensively. The raw text never leaves this function.
  const text = typeof response?.text === "function" ? await response.text() : "";
  let oauthError = "";
  try {
    const payload = text ? JSON.parse(text) : null;
    if (typeof payload?.error === "string") oauthError = payload.error;
  } catch {
    oauthError = "";
  }

  if (statusCode === 400 && oauthError === ALREADY_REVOKED_ERROR) {
    // The grant was already gone. That is the end state this route exists to
    // reach, so the disconnect continues rather than stranding the user.
    logLine("calendar.disconnect.revoked", { statusCode, alreadyRevoked: true });
    return { revoked: true, alreadyRevoked: true, statusCode };
  }

  throw new RevocationError("Google refused to revoke the grant", {
    // A short token, never the body: `oauthError` is a fixed OAuth error code
    // when we could parse one, and a status label when we could not.
    reason: oauthError || `http_${statusCode || "unknown"}`,
    statusCode,
  });
}

/**
 * Revoke the grant and delete what the user asked to have deleted.
 *
 * See the module docblock for the ordering and its rationale. In summary: read,
 * revoke, clear the schedule, delete the row, delete the events - and abort with
 * NOTHING deleted if the revocation fails.
 *
 * IDEMPOTENT. A second call finds no stored grant, skips the revoke entirely and
 * reports `revoked: false, connectionDeleted: false`. It is not an error to
 * disconnect an account that is already disconnected, and it still clears the
 * schedule and (if asked) the events, so a first attempt that failed half way can
 * be finished by simply calling again.
 *
 * EVERY OUTCOME IS OBSERVED, NOT ASSUMED. `connectionDeleted` comes from
 * DynamoDB's old image (see `deleteConnection`), and `eventsDeleted` counts only
 * keys DynamoDB confirmed. `eventsDeleteComplete` is false whenever rows may
 * remain, so the caller can tell the user the truth instead of a bare count.
 *
 * @param {object} args
 * @param {string} args.userId Session-derived ("google#<sub>"). Never
 *   request-supplied: a userId from the body would let any signed-in caller erase
 *   another account.
 * @param {boolean} [args.deleteEvents] Defaults to FALSE. The destructive choice
 *   is never the default, at any layer.
 * @param {string|null} [args.tableName] Connections table override.
 * @param {string|null} [args.eventsTableName] Events table override.
 * @param {object} [deps]
 * @param {Function} [deps.getConnection]
 * @param {Function} [deps.getRefreshToken]
 * @param {Function} [deps.deleteConnection]
 * @param {Function} [deps.deleteEventsForUser]
 * @param {Function} [deps.deleteScanSchedule]
 * @param {Function} [deps.revokeGrant]
 * @param {Function} [deps.resetTokenCache]
 * @param {(url: string, init: object) => Promise<any>} [deps.fetchImpl]
 * @param {string} [deps.revokeEndpoint]
 * @param {Function} [deps.query] Forwarded to `deleteEventsForUser`.
 * @param {Function} [deps.batchDelete] Forwarded to `deleteEventsForUser`.
 * @param {Function} [deps.sleep] Forwarded to `deleteEventsForUser`.
 * @param {Function} [deps.random] Forwarded to `deleteEventsForUser`.
 * @param {number} [deps.maxAttempts] Forwarded to `deleteEventsForUser`.
 * @param {number} [deps.maxPages] Forwarded to `deleteEventsForUser`.
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ revoked: boolean, alreadyRevoked: boolean, connectionDeleted: boolean, scheduleCleared: boolean, eventsDeleted: number, eventsDeleteComplete: boolean }>}
 * @throws {RevocationError} Revocation failed; nothing was deleted.
 */
export async function disconnectAccount(
  { userId, deleteEvents = false, tableName = null, eventsTableName = null } = {},
  {
    getConnection = getStoredConnection,
    getRefreshToken = getStoredRefreshToken,
    deleteConnection = deleteStoredConnection,
    deleteEventsForUser = deleteStoredEventsForUser,
    deleteScanSchedule = deleteStoredScanSchedule,
    revokeGrant: revoke = revokeGrant,
    resetTokenCache: dropCachedTokens = resetTokenCache,
    fetchImpl,
    revokeEndpoint,
    query,
    batchDelete,
    sleep,
    random,
    maxAttempts,
    maxPages,
    env = process.env,
    log = null,
  } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("disconnectAccount: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);

  // 1. Read. A failure here THROWS rather than falling through to the deletes:
  //    code that cannot tell whether a grant exists must not start destroying
  //    the thing that would have told it.
  const connection = await getConnection(userId, { tableName, env });

  // 2. Revoke, but only when there is something to revoke. `getRefreshToken`
  //    decrypts, so it is called only when the stripped row says a wrapped token
  //    is actually there - no pointless KMS call on a repeat disconnect.
  let revoked = false;
  let alreadyRevoked = false;
  if (connection?.hasRefreshToken === true) {
    const refreshToken = await getRefreshToken(userId, { tableName, env });
    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      // Throws RevocationError on anything but 200 / 400 invalid_token, and the
      // throw propagates BEFORE any delete below. That is the fail-closed
      // ordering the module docblock describes.
      const result = await revoke(refreshToken, { fetchImpl, revokeEndpoint, env, log: logLine });
      revoked = result.revoked === true;
      alreadyRevoked = result.alreadyRevoked === true;
    }
  }

  // The grant is dead (or was never here). Drop any access token this container
  // minted from it, so a warm Lambda cannot keep reading the mailbox for the
  // rest of its life on a token that outlived its refresh token.
  dropCachedTokens(userId);

  // 3. Stop the recurring scan BEFORE the row goes, and stop it even when there
  //    is no row - that is how a previous disconnect that failed here gets fixed
  //    by a retry instead of leaving a schedule firing forever at an account
  //    that no longer exists.
  //
  //    `updateConnection` is injected as a no-op deliberately: deleteScanSchedule
  //    normally patches the connection row to record "no schedule", and a
  //    DynamoDB UpdateItem CREATES the row it cannot find - which would resurrect
  //    a stub connection either milliseconds before we delete it or, worse, right
  //    after a repeat disconnect found nothing. The whole row is going, so there
  //    is nothing to record.
  let scheduleCleared = true;
  try {
    await deleteScanSchedule(userId, { env, updateConnection: async () => null });
  } catch (err) {
    // Best effort, but LOUD. The grant is already revoked and cannot be
    // un-revoked, so failing the whole disconnect here would strand the user for
    // an EventBridge problem they cannot influence. The orphaned schedule fires
    // against a deleted row, takes google-token.mjs's `no_refresh_token` path and
    // fails harmlessly - and, by design, raises no revocation alarm.
    scheduleCleared = false;
    logLine("calendar.disconnect.schedule_clear_failed", {
      userId,
      errorName: err?.name || "Error",
    });
  }

  // 4. Delete the row. Called unconditionally rather than only when step 1 saw
  //    one: DynamoDB's old image is the authority on whether a row existed, and
  //    a delete driven by a stale read could report a deletion that never
  //    happened (or skip one that was needed).
  const { deleted: connectionDeleted } = await deleteConnection(userId, { tableName, env });

  // 5. Events, only if asked. Independent of everything above: a user who kept
  //    their calendar and one who never had a grant are both handled here.
  let eventsDeleted = 0;
  let eventsDeleteComplete = true;
  if (deleteEvents === true) {
    try {
      const result = await deleteEventsForUser(
        { userId, tableName: eventsTableName },
        { query, batchDelete, sleep, random, maxAttempts, maxPages, env, log: logLine }
      );
      eventsDeleted = Number.isFinite(result?.deleted) ? result.deleted : 0;
      eventsDeleteComplete = result?.complete === true;
    } catch (err) {
      // The revocation and the row deletion already happened and cannot be
      // undone, so this is reported rather than thrown: the caller gets the
      // counts that ARE true plus `eventsDeleteComplete: false`, which is the
      // honest answer to "is my data gone?". Answering a bare 500 here would
      // imply nothing had happened at all, which is the opposite of the truth.
      eventsDeleteComplete = false;
      logLine("calendar.disconnect.events_delete_failed", {
        userId,
        errorName: err?.name || "Error",
      });
    }
  }

  // Ids, counts and outcome flags. No token, no request body, no event title.
  logLine("calendar.disconnect.complete", {
    userId,
    revoked,
    alreadyRevoked,
    connectionDeleted,
    scheduleCleared,
    eventsRequested: deleteEvents === true,
    eventsDeleted,
    eventsDeleteComplete,
  });

  return { revoked, alreadyRevoked, connectionDeleted, scheduleCleared, eventsDeleted, eventsDeleteComplete };
}
