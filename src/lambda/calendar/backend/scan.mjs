/**
 * scan.mjs - one full scan of a user's mailbox: fetch, extract, persist,
 * record the outcome. This is the operation both "Scan now" and the
 * EventBridge schedule (scan-schedule.mjs) invoke.
 *
 * Sequence, per the ticket:
 *   1. Load the connection. No `searchDomains` -> `not_configured`, no Gmail call.
 *   2. Compute `since` (lastScanAt minus a 2-day overlap, or the 90-day default).
 *   3. Fetch candidate messages, extract each one, persist what survives.
 *   4. Record `lastScanAt`/`lastScanStatus`/`lastScanError`/counts on the
 *      connection.
 *   5. Return `{ status, messagesScanned, eventsCreated, eventsUpdated, skipped,
 *      truncated, errors }`.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY. A scan is not re-entrant: `connections.mjs`'s `acquireScanLock`
 * sets `scanInProgress`/`scanStartedAt` behind a ConditionExpression so two
 * invocations for the same user cannot both proceed, a lock older than
 * `SCAN_LOCK_STALE_MS` is treated as abandoned (a killed invocation must not
 * wedge the account), and `releaseScanLock` runs in a `finally` so a thrown
 * error still frees it.
 *
 * ---------------------------------------------------------------------------
 * THROUGHPUT (see the ticket's "Throughput constraint", read before changing
 * this). A scan can face up to `DEFAULT_MAX_MESSAGES` (TASK-006) messages, each
 * costing one sequential Anthropic call (TASK-007) that can itself retry up to
 * `MAX_ATTEMPTS` times. STRATEGY CHOSEN: raise the Lambda's own timeout to 900s
 * (the 15-minute ceiling; see terraform/lambda_calendar.tf) AND make the
 * extraction loop itself deadline-aware via an injected clock and the
 * invocation's own `getRemainingTimeInMillis` (real Lambda context, wired by
 * index.mjs) - a per-email worst case cannot be bounded mathematically (a
 * single retry sequence can wait up to RETRY_MAX_DELAY_MS per attempt, and the
 * Anthropic SDK's own request timeout is outside this module's control), so
 * instead of gambling on a fixed per-invocation message cap being "enough", the
 * loop below checks the clock BETWEEN messages and stops - loudly and
 * resumably - once `SCAN_TIME_SAFETY_MARGIN_MS` of runway remains, rather than
 * being killed mid-write by the platform with nothing recorded. `computeDeadline`
 * is pure and takes an injected clock, so a test can drive it with a stubbed
 * clock and no real timers (see the ticket's acceptance criteria).
 *
 * ---------------------------------------------------------------------------
 * WATERMARK (see the ticket's "Watermark precondition", read before changing
 * this). Gmail's `messages.list` is newest-first and `listMessageIds` (TASK-006)
 * keeps whatever it already collected up to `maxMessages`, so a TRUNCATED fetch
 * retains the newest matches and silently drops older ones within the same
 * search window. Advancing `lastScanAt` to `newestReceivedAt` on a truncated
 * scan would move the next scan's `after:` date past every dropped message,
 * losing that mail permanently with no error to show for it.
 *
 * STRATEGY CHOSEN: on any run that is truncated OR stopped early by the
 * deadline above, `lastScanAt` is PINNED at the exact `since` value THIS run's
 * own query used - not `newestReceivedAt`, and not "the oldest fetched
 * message" either, because messages that were dropped by the cap were never
 * fetched at all and their timestamp is unknown to this module; the only value
 * provably at or before every message this run saw *and* every message it
 * dropped is the query floor itself. That floor already covered the whole
 * window this run searched, so pinning it there is what lets the next scan's
 * `after:` date still cover the gap. Only a clean, complete run (fetched
 * everything the query matched, and finished before the deadline) advances
 * forward, to `newestReceivedAt` (or to this run's own start time when nothing
 * matched at all, so an empty mailbox does not re-scan the same window
 * forever). Repeated truncation on the same account will keep re-fetching
 * (idempotently, via events.mjs's content-derived `eventId`) the same window
 * rather than the backlog draining in one step - a bounded cost, not a
 * correctness problem, and the one this ticket is scoped to fix; TASK-035 owns
 * hardening `fetchCandidateMessages` itself.
 *
 * ---------------------------------------------------------------------------
 * TASK-070 (read before changing the store step). `putEvents` does not guard
 * `batchWrite`, so a thrown DynamoDB error abandons the remaining chunks and
 * the caller cannot know how many of them were written. This module does not
 * work around that defect - it is tracked separately - but it does not
 * COMPOUND it either: a throw from `storeEvents` is caught here, reported as
 * `written: 0` (never assumed to be some other number) and the scan is marked
 * "partial", never "ok". The events that WERE extracted before the throw are
 * not lost from the report either way - the extraction step and the persist
 * step are separate try/catches - only the write outcome is uncertain, and
 * this module says so rather than guessing.
 *
 * EVENTS CREATED VS UPDATED. `events.mjs`'s own hand-off note records that a
 * content-derived `eventId` written via `BatchWriteItem` cannot cheaply be told
 * apart from an update without an extra read per event - and an extra read per
 * event would scale cost exactly like the extraction calls this scan is
 * already careful to bound. So `eventsCreated` reports the whole written count
 * and `eventsUpdated` is always 0, rather than a guessed split.
 *
 * ---------------------------------------------------------------------------
 * TESTABILITY: every collaborator (`getConnection`, `updateConnection`,
 * `acquireScanLock`, `releaseScanLock`, `fetchCandidateMessages`,
 * `extractFromMessage`, `storeEvents`, `now`, `getRemainingTimeInMillis`, `env`,
 * `log`) is injectable with a real default, exactly as in gmail.mjs,
 * anthropic.mjs and events.mjs. No AWS SDK, Gmail or Anthropic call is made on
 * an injected-dependency path.
 *
 * SECURITY: this module logs message ids, statuses, counts and short,
 * pre-scrubbed error messages only - the same discipline as the modules it
 * orchestrates. `lastScanError` is capped in length here as well, as a second
 * line of defence.
 */

import {
  getConnection,
  updateConnection,
  acquireScanLock,
  releaseScanLock,
} from "./connections.mjs";
import { fetchCandidateMessages, toDomainList, readGmailConfig, DEFAULT_SINCE_DAYS } from "./gmail.mjs";
import { extractFromMessage } from "./anthropic.mjs";
import { storeEvents } from "./events.mjs";
import { ReauthRequiredError, REAUTH_SCAN_STATUS } from "./google-token.mjs";
import { ALARM_TOKENS, emitAlarm } from "./alarms.mjs";

/** Hard cap on a browser-triggered scan (ticket requirement): a full scan can
 * take minutes, which is longer than any reasonable request should keep a
 * browser waiting. */
export const MANUAL_SCAN_MAX_MESSAGES = 50;

/** School emails are edited and resent; idempotent `eventId`s make this free. */
export const WATERMARK_OVERLAP_DAYS = 2;

/** Reserved runway at the end of an invocation for persisting events and
 * releasing the lock, once the extraction loop's deadline is hit. */
export const SCAN_TIME_SAFETY_MARGIN_MS = 30_000;

/** Fallback time budget when no `getRemainingTimeInMillis` is supplied (a
 * manual scan, or a test) - comfortably inside the 15-minute Lambda ceiling. */
export const DEFAULT_MAX_SCAN_DURATION_MS = 12 * 60 * 1000;

/** Every outcome `runScan` can report. Callers switch on these, not on strings. */
export const SCAN_STATUS = Object.freeze({
  /** No `searchDomains` configured; Gmail was never called. */
  NOT_CONFIGURED: "not_configured",
  /** Another scan is already in progress (or its lock has not gone stale). */
  LOCKED: "locked",
  /** Every candidate message was fetched, extracted and its events persisted. */
  OK: "ok",
  /** Truncated, stopped early, or some messages/events failed - but the run
   * completed and the watermark was handled safely either way. */
  PARTIAL: "partial",
  /** The stored Gmail grant has been revoked; the user must reconnect. */
  REAUTH_REQUIRED: REAUTH_SCAN_STATUS,
  /** The fetch itself failed outright (not a per-message failure). */
  ERROR: "error",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 200;

/**
 * Parse a positive integer, falling back on anything unusable - matching the
 * same helper in gmail.mjs/anthropic.mjs.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build a logger that honours CALENDAR_LOG_LEVEL, exactly as the sibling
 * backend modules do.
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
 * Cap a string for a log line or a stored `lastScanError` - never a token, a
 * body or a subject (the errors this module ever sees are already scrubbed by
 * gmail.mjs/anthropic.mjs/events.mjs; this is a second, cheap line of
 * defence, not the only one).
 *
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {string}
 */
export function capText(value, limit = MAX_ERROR_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** A thrown error's message, capped. Never the object itself. */
function shortError(err) {
  return capText(err?.message || String(err ?? "unknown error"));
}

/**
 * The floor a scan's Gmail query uses: `lastScanAt` minus the overlap window,
 * or the configured default lookback when there is no watermark yet (a first
 * scan).
 *
 * Exported and pure so a test can assert the exact date with no clock at all.
 *
 * @param {object} args
 * @param {unknown} [args.lastScanAt] Stored ISO-8601 string, or absent.
 * @param {number} [args.sinceDays] Default lookback (see gmail.mjs's config).
 * @param {() => number} [args.now] Epoch-ms clock.
 * @returns {Date}
 */
export function computeSince({ lastScanAt = null, sinceDays = DEFAULT_SINCE_DAYS, now = () => Date.now() } = {}) {
  const lastScanMs = typeof lastScanAt === "string" && lastScanAt ? Date.parse(lastScanAt) : NaN;
  if (Number.isFinite(lastScanMs)) {
    return new Date(lastScanMs - WATERMARK_OVERLAP_DAYS * DAY_MS);
  }
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SINCE_DAYS;
  return new Date(now() - days * DAY_MS);
}

/**
 * The absolute instant (per the injected clock) the extraction loop must stop
 * by. Pure and exported, so the throughput acceptance criterion is provable
 * with a stubbed clock and no real Lambda invocation.
 *
 * @param {object} args
 * @param {() => number} args.now Epoch-ms clock.
 * @param {(() => number)|null} [args.getRemainingTimeInMillis] The real Lambda
 *   context method, or an injected stand-in; null/absent falls back to
 *   `DEFAULT_MAX_SCAN_DURATION_MS`.
 * @returns {number} Epoch ms.
 */
export function computeDeadline({ now = () => Date.now(), getRemainingTimeInMillis = null } = {}) {
  const remaining = typeof getRemainingTimeInMillis === "function" ? getRemainingTimeInMillis() : null;
  const budgetMs = Number.isFinite(remaining)
    ? Math.max(0, remaining - SCAN_TIME_SAFETY_MARGIN_MS)
    : DEFAULT_MAX_SCAN_DURATION_MS;
  return now() + budgetMs;
}

/** The zeroed shape `runScan` returns for a run that never reached the store step. */
function emptyResult(status, overrides = {}) {
  return {
    status,
    messagesScanned: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    skipped: 0,
    truncated: false,
    errors: [],
    ...overrides,
  };
}

/**
 * Patch the connection with the scan outcome, swallowing (and logging) a
 * write failure - the caller already has the in-memory result to return, and a
 * DynamoDB blip while recording "how did it go" must not turn a completed scan
 * into a 500.
 *
 * @param {Function} patchConnection
 * @param {string} userId
 * @param {object} patch
 * @param {Record<string, string|undefined>} env
 * @param {(message: string, fields?: object) => void} log
 */
async function safePatch(patchConnection, userId, patch, env, log) {
  try {
    await patchConnection(userId, patch, { env });
  } catch (err) {
    log("calendar.scan.patch_failed", { userId, errorName: err?.name || "Error", errorMessage: err?.message || "" });
  }
}

/**
 * Run one scan for one user. See the module docblock for the full sequence,
 * the concurrency lock, the throughput strategy and the watermark rule.
 *
 * @param {object} args
 * @param {string} args.userId Connections-table key ("google#<sub>").
 * @param {"manual"|"scheduled"} [args.mode]
 * @param {number|null} [args.maxMessages] Override; manual scans are still
 *   hard-capped at MANUAL_SCAN_MAX_MESSAGES regardless of what is passed.
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @param {() => number} [deps.now] Epoch-ms clock.
 * @param {(() => number)|null} [deps.getRemainingTimeInMillis] Real Lambda
 *   context method (or a stub), for the deadline-aware extraction loop.
 * @param {typeof getConnection} [deps.getConnection]
 * @param {typeof updateConnection} [deps.updateConnection]
 * @param {typeof acquireScanLock} [deps.acquireScanLock]
 * @param {typeof releaseScanLock} [deps.releaseScanLock]
 * @param {number} [deps.staleLockAfterMs]
 * @param {typeof fetchCandidateMessages} [deps.fetchCandidateMessages]
 * @param {typeof extractFromMessage} [deps.extractFromMessage]
 * @param {typeof storeEvents} [deps.storeEvents]
 * @param {typeof emitAlarm} [deps.emitAlarm] Sink for the CloudWatch alarm
 *   tokens in alarms.mjs; injectable so a test can assert an alarm was raised
 *   without reading the console.
 * @returns {Promise<{ status: string, messagesScanned: number, eventsCreated: number, eventsUpdated: number, skipped: number, truncated: boolean, errors: Array<{id: string, error: string}> }>}
 */
export async function runScan({ userId, mode = "manual", maxMessages = null } = {}, deps = {}) {
  if (typeof userId !== "string" || !userId) throw new Error("runScan: userId is required");

  const {
    env = process.env,
    log = null,
    now = () => Date.now(),
    getRemainingTimeInMillis = null,
    getConnection: loadConnection = getConnection,
    updateConnection: patchConnection = updateConnection,
    acquireScanLock: lockScan = acquireScanLock,
    releaseScanLock: unlockScan = releaseScanLock,
    staleLockAfterMs = undefined,
    fetchCandidateMessages: fetchMessages = fetchCandidateMessages,
    extractFromMessage: extractOne = extractFromMessage,
    storeEvents: persistEvents = storeEvents,
    emitAlarm: raiseAlarm = emitAlarm,
    ...ioDeps
  } = deps;

  const logLine = typeof log === "function" ? log : makeLogger(env);
  const commonDeps = { ...ioDeps, env, log: logLine, now };

  let connection;
  try {
    connection = await loadConnection(userId, { env });
  } catch (err) {
    logLine("calendar.scan.connection_lookup_failed", {
      userId,
      mode,
      errorName: err?.name || "Error",
      errorMessage: err?.message || "",
    });
    throw err;
  }

  const domains = toDomainList(connection?.searchDomains);
  if (domains.length === 0) {
    logLine("calendar.scan.not_configured", { userId, mode });
    return emptyResult(SCAN_STATUS.NOT_CONFIGURED);
  }

  const acquired = await lockScan(userId, { staleAfterMs: staleLockAfterMs, env });
  if (!acquired) {
    logLine("calendar.scan.locked", { userId, mode });
    return emptyResult(SCAN_STATUS.LOCKED);
  }

  try {
    const gmailConfig = readGmailConfig(env);
    const cap =
      mode === "manual"
        ? Math.min(positiveInt(maxMessages, MANUAL_SCAN_MAX_MESSAGES), MANUAL_SCAN_MAX_MESSAGES)
        : positiveInt(maxMessages, gmailConfig.maxMessages);

    const sinceDate = computeSince({ lastScanAt: connection?.lastScanAt, sinceDays: gmailConfig.sinceDays, now });
    const nowIso = new Date(now()).toISOString();

    let fetchResult;
    try {
      fetchResult = await fetchMessages({ userId, since: sinceDate, maxMessages: cap, searchDomains: domains }, commonDeps);
    } catch (err) {
      if (err instanceof ReauthRequiredError || err?.name === "ReauthRequiredError") {
        // google-token.mjs already best-effort marked lastScanStatus on the
        // connection before throwing this; writing it again here would only
        // race that write for no benefit.
        logLine("calendar.scan.reauth_required", { userId, mode });
        return emptyResult(SCAN_STATUS.REAUTH_REQUIRED);
      }

      logLine("calendar.scan.fetch_failed", { userId, mode, errorName: err?.name || "Error", errorMessage: err?.message || "" });
      await safePatch(
        patchConnection,
        userId,
        {
          lastScanAt: sinceDate.toISOString(),
          lastScanStatus: SCAN_STATUS.ERROR,
          lastScanError: shortError(err),
          lastScanMessagesScanned: 0,
          lastScanEventsCreated: 0,
          lastScanEventsUpdated: 0,
          lastScanSkipped: 0,
          lastScanTruncated: false,
        },
        env,
        logLine
      );
      return emptyResult(SCAN_STATUS.ERROR, { errors: [{ id: "", error: shortError(err) }] });
    }

    const { messages, truncated: fetchTruncated, errors: fetchErrors, newestReceivedAt } = fetchResult;

    // --- Extraction: sequential, deadline-checked. See the module docblock's
    // "THROUGHPUT" section for why this is the chosen strategy. ---
    const deadline = computeDeadline({ now, getRemainingTimeInMillis });
    const extractions = [];
    const extractionErrors = [];
    let processed = 0;
    let stoppedEarly = false;

    for (const message of messages) {
      if (now() >= deadline) {
        stoppedEarly = true;
        break;
      }
      try {
        const result = await extractOne(
          { message, schoolName: connection?.schoolName || "", searchDomains: domains },
          commonDeps
        );
        for (const event of result.events) extractions.push({ message, event });
      } catch (err) {
        // One unreadable message must not cost the batch - matching
        // gmail.mjs/anthropic.mjs's own "partial success is a success" rule.
        extractionErrors.push({ id: String(message?.id ?? ""), error: shortError(err) });
        // ...but a run where EVERY message fails this way still reports success
        // to the runtime, so the only way it becomes visible is this token and
        // the alarm on it (terraform/alerting.tf). Error NAME only, never the
        // message: a thrown Anthropic error can quote the prompt back.
        raiseAlarm(ALARM_TOKENS.EXTRACTION_FAILED, {
          userId,
          mode,
          messageId: String(message?.id ?? ""),
          errorName: err?.name || "Error",
        });
      }
      processed += 1;
    }

    // --- Persist whatever was extracted, even from a run that stopped early:
    // progress already made must survive, per the ticket's resumability
    // requirement, rather than being lost when the Lambda later times out. ---
    let stored = { written: 0, skipped: [] };
    let storeError = null;
    if (extractions.length > 0) {
      try {
        stored = await persistEvents({ userId, extractions }, commonDeps);
      } catch (err) {
        // TASK-070: putEvents does not guard batchWrite, so a throw here means
        // this module genuinely does not know how many (if any) of this
        // batch's events reached the table. `written` stays 0 - reported as
        // uncertain, never assumed - and the run is marked "partial".
        storeError = err;
        logLine("calendar.scan.store_failed", {
          userId,
          mode,
          errorName: err?.name || "Error",
          errorMessage: err?.message || "",
        });
      }
    }

    const truncated = fetchTruncated || stoppedEarly;
    const errors = [...fetchErrors, ...extractionErrors];
    if (storeError) errors.push({ id: "", error: shortError(storeError) });

    const status = errors.length > 0 || truncated ? SCAN_STATUS.PARTIAL : SCAN_STATUS.OK;

    // --- Watermark. See the module docblock's "WATERMARK" section: on a
    // truncated or time-stopped run, pin `lastScanAt` at the exact `since` this
    // run's own query used, so the next run's `after:` date still covers
    // everything this run dropped. Only a clean, complete run advances forward. ---
    const newLastScanAt = truncated ? sinceDate.toISOString() : newestReceivedAt || nowIso;

    await safePatch(
      patchConnection,
      userId,
      {
        lastScanAt: newLastScanAt,
        lastScanStatus: status,
        lastScanError: errors.length > 0 ? capText(errors[0].error) : "",
        lastScanMessagesScanned: processed,
        lastScanEventsCreated: stored.written,
        lastScanEventsUpdated: 0,
        lastScanSkipped: stored.skipped.length,
        lastScanTruncated: truncated,
      },
      env,
      logLine
    );

    logLine("calendar.scan.complete", {
      userId,
      mode,
      status,
      messagesScanned: processed,
      truncated,
      errors: errors.length,
    });

    return {
      status,
      messagesScanned: processed,
      eventsCreated: stored.written,
      eventsUpdated: 0,
      skipped: stored.skipped.length,
      truncated,
      errors,
    };
  } finally {
    // Released even when the block above threw - see the module docblock's
    // "CONCURRENCY" note.
    try {
      await unlockScan(userId, { env });
    } catch (err) {
      logLine("calendar.scan.unlock_failed", { userId, mode, errorName: err?.name || "Error", errorMessage: err?.message || "" });
    }
  }
}
