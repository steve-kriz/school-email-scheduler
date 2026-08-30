/**
 * scan.mjs - one full scan of a user's mailbox: fetch, extract, persist,
 * record the outcome. This is the operation both "Scan now" and the
 * EventBridge schedule (scan-schedule.mjs) invoke.
 *
 * Sequence, per the ticket:
 *   1. Load the connection and resolve its PROCESSING JOBS. No job with a usable
 *      search field -> `not_configured`, no lock and no Gmail call.
 *   2. Compute `since` (lastScanAt minus a 2-day overlap, or the 90-day default)
 *      and the invocation deadline - ONCE each, for the whole run.
 *   3. For EACH job, in settings order: fetch its own candidate messages,
 *      extract each one with that job's school context, persist what survives
 *      tagged with that job's id.
 *   4. Record `lastScanAt`/`lastScanStatus`/`lastScanError`/totals on the
 *      connection, in ONE patch after the loop.
 *   5. Return `{ status, messagesScanned, eventsCreated, eventsUpdated, skipped,
 *      truncated, errors, jobs }`.
 *
 * ---------------------------------------------------------------------------
 * ONE SEARCH PER PROCESSING JOB (TASK-056). A user can watch more than one
 * school, and each job carries its own `{ id, name, schoolName, domain,
 * searchTerms }`. Every job is searched INDEPENDENTLY - its own Gmail query, its
 * own extraction pass with its own school context, its own `storeEvents` call -
 * because that is the only way a stored event can be attributed back to the job
 * that found it (`processingJobId` on the row). It is a deliberate requirement,
 * not an accident of the implementation: do not "optimise" it back into one
 * combined query, which would make attribution unknowable.
 *
 * What that costs, stated plainly: two jobs that both match one email each pay
 * their own extraction call for it, and the row is written twice (collapsing to
 * one row by the content-derived `eventId`, with the FIRST job keeping the
 * attribution - see `applyPreservedLifecycle`). The summed `eventsCreated` can
 * therefore double-count one underlying event. That is ACCEPTED and consistent
 * with the "EVENTS CREATED VS UPDATED" note below - `eventsCreated` has always
 * reported the whole written count - and must not be "fixed" with a per-event
 * read, which is precisely the per-event cost this module exists to avoid.
 *
 * THE MESSAGE BUDGET IS SPLIT, NOT MULTIPLIED. The cap
 * (`MANUAL_SCAN_MAX_MESSAGES` for a manual scan, `readGmailConfig`/`maxMessages`
 * otherwise) stays a WHOLE-INVOCATION budget: each job is fetched with
 * `floor(cap / usableJobCount)`. Five jobs on a manual scan must not fetch 250
 * messages and keep a browser waiting. The split is EVEN rather than
 * first-come-first-served on purpose - a first-come budget lets one noisy job
 * starve every later job on every scan, because a truncated run re-scans the same
 * window and the same noisy job consumes it again.
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
 * forever).
 *
 * ACROSS A JOB LOOP (TASK-056) the rule GENERALISES rather than changing. There
 * is ONE `lastScanAt` on the connection and one `since` floor shared by every
 * job's query, so the watermark must stay provably at or before every message
 * ANY job saw, dropped, or never reached. It is therefore pinned when ANY of
 * these is true: any job's fetch was truncated; the deadline stopped the run
 * mid-loop; a usable job was never attempted; any job's fetch failed outright.
 * It advances only when EVERY usable job ran to completion untruncated, and then
 * to the MAXIMUM `newestReceivedAt` across all of them. PER-JOB WATERMARKS ARE
 * OUT OF SCOPE - one job finishing cleanly must not move a floor that another
 * job's dropped mail still depends on.
 *
 * Repeated truncation on the same account will keep re-fetching
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
 * SECURITY: this module logs message ids, statuses, counts, opaque
 * `processingJobId`s and short, pre-scrubbed error messages only - the same
 * discipline as the modules it orchestrates. A job's `name`, its `schoolName`
 * and its `searchTerms` are personal data and NEVER reach a log line; `name` is
 * returned in the `jobs` breakdown because that response goes to the
 * authenticated owner's own browser, which is a different destination from
 * CloudWatch. `lastScanError` is capped in length here as well, as a second line
 * of defence.
 */

import {
  getConnection,
  updateConnection,
  acquireScanLock,
  releaseScanLock,
} from "./connections.mjs";
import {
  fetchCandidateMessages,
  toDomainList,
  toSearchTermList,
  hasJobQueryClauses,
  readGmailConfig,
  DEFAULT_SINCE_DAYS,
} from "./gmail.mjs";
import { extractFromMessage, toSchoolNameList } from "./anthropic.mjs";
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
  /** No processing job with a usable search field; Gmail was never called. */
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

/**
 * Every outcome ONE processing job can report inside a run's `jobs` breakdown.
 *
 * Distinct from `SCAN_STATUS` on purpose: `locked` and `reauth_required` are
 * properties of the whole invocation and can never describe a single job, and
 * `not_attempted` (the deadline arrived before this job's turn) has no
 * whole-run equivalent.
 */
export const SCAN_JOB_STATUS = Object.freeze({
  /** Fetched, extracted and persisted with nothing dropped. */
  OK: "ok",
  /** Ran, but was truncated, cut short by the deadline, or had failures. */
  PARTIAL: "partial",
  /** Its Gmail fetch failed outright; nothing was extracted for it. */
  ERROR: "error",
  /** No usable domain, school name or search term: never sent to Gmail. */
  NOT_CONFIGURED: "not_configured",
  /** The invocation ran out of runway before this job's turn came. */
  NOT_ATTEMPTED: "not_attempted",
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
    jobs: [],
    ...overrides,
  };
}

/**
 * The processing jobs this scan will run, in settings order.
 *
 * READS DEFENSIVELY, on purpose. `connection.processingJobs` is owned by
 * settings.mjs (TASK-055), including its validation and its migrate-on-read for
 * rows written before jobs existed. This module re-validates NONE of that - it
 * only normalises the shapes a stored value can arrive in (a plain array from
 * the document client, a DynamoDB `{ L: [...] }` list from the low-level one)
 * and tolerates a partially filled job rather than throwing mid-scan.
 *
 * THE LEGACY FALLBACK below is a bridge, not a second source of truth: when the
 * row carries no `processingJobs` at all, one job is synthesised per stored
 * `searchDomains` entry so an unmigrated connection still scans instead of
 * silently reporting `not_configured`. Once every read path returns migrated
 * jobs this branch simply stops being reached.
 *
 * A job with a blank `id` keeps it blank rather than being given a generated
 * one: attribution must be STABLE across scans, and an index-derived id would
 * change the moment the user reorders their jobs, which is worse than an
 * unattributed event.
 *
 * @param {object|null|undefined} connection Raw row from `getConnection`.
 * @returns {Array<{ id: string, name: string, schoolName: string, domain: string, searchTerms: string[] }>}
 */
export function toProcessingJobs(connection) {
  const raw = connection?.processingJobs;
  let entries = [];
  if (Array.isArray(raw)) entries = raw;
  else if (raw instanceof Set) entries = [...raw];
  else if (raw && typeof raw === "object" && Array.isArray(raw.L)) entries = raw.L;

  const jobs = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry.M && typeof entry.M === "object" ? entry.M : entry;
    const text = (value) => String(value?.S ?? value ?? "").trim();
    jobs.push({
      id: text(source.id),
      name: text(source.name),
      schoolName: text(source.schoolName),
      domain: text(source.domain),
      searchTerms: toSearchTermList(source.searchTerms?.L ? source.searchTerms.L.map((v) => text(v)) : source.searchTerms),
    });
  }
  if (jobs.length > 0) return jobs;

  const names = toSchoolNameList(connection?.schoolNames ?? connection?.schoolName);
  return toDomainList(connection?.searchDomains).map((domain, index) => ({
    // Derived from the domain, which is the only stable thing a legacy row has.
    id: `legacy#${domain}`,
    name: names[index] || names[0] || domain,
    schoolName: names[index] || names[0] || "",
    domain,
    searchTerms: [],
  }));
}

/**
 * One entry of the `jobs` breakdown, zeroed. The key set is contractual (the
 * browser renders it), so it is built in one place rather than spread across the
 * loop: `errors` is a COUNT here, while the full `{ id, error }` entries stay in
 * the top-level `errors` array so no error text is duplicated into the response.
 *
 * The job's `name` IS included - the response goes to the authenticated owner,
 * who typed it - but it must never reach a LOG line. See the "COUNTS ONLY"
 * discipline in index.mjs.
 *
 * @param {{ id: string, name: string }} job
 * @param {string} status
 * @returns {{ processingJobId: string, name: string, status: string, messagesScanned: number, eventsCreated: number, eventsUpdated: number, skipped: number, truncated: boolean, errors: number }}
 */
function newJobReport(job, status) {
  return {
    processingJobId: job.id,
    name: job.name,
    status,
    messagesScanned: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    skipped: 0,
    truncated: false,
    errors: 0,
  };
}

/**
 * The same breakdown with every count reset - used by the abort paths, whose
 * top-level counts are zeroed too, so the report cannot imply work that the
 * caller is being told did not happen.
 *
 * @param {object[]} reports
 * @returns {object[]}
 */
function zeroJobReports(reports) {
  return reports.map((report) => ({
    ...report,
    status: report.status === SCAN_JOB_STATUS.NOT_CONFIGURED ? report.status : SCAN_JOB_STATUS.NOT_ATTEMPTED,
    messagesScanned: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    skipped: 0,
    truncated: false,
    errors: 0,
  }));
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
 * @returns {Promise<{ status: string, messagesScanned: number, eventsCreated: number, eventsUpdated: number, skipped: number, truncated: boolean, errors: Array<{id: string, error: string}>, jobs: Array<{ processingJobId: string, name: string, status: string, messagesScanned: number, eventsCreated: number, eventsUpdated: number, skipped: number, truncated: boolean, errors: number }> }>}
 *   The totals are SUMS across every processing job; `jobs` breaks them down,
 *   one entry per CONFIGURED job in settings order (including jobs that were
 *   skipped, never attempted, or found nothing). `errors` is a count inside a
 *   job entry and the full `{ id, error }` list at the top level, so no error
 *   text appears twice. The `name` in a job entry is the user's own text and is
 *   for the owner's browser only - it must not be logged.
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

  // Settings order is the run order, and the order of the `jobs` report.
  const jobs = toProcessingJobs(connection);
  // "Usable" is decided WITHOUT building a query or catching an exception,
  // because the count is needed up front to split the message budget.
  const usable = jobs.map((job) => hasJobQueryClauses(job));
  const usableJobCount = usable.filter(Boolean).length;
  const jobReports = jobs.map((job, index) =>
    newJobReport(job, usable[index] ? SCAN_JOB_STATUS.NOT_ATTEMPTED : SCAN_JOB_STATUS.NOT_CONFIGURED)
  );

  if (usableJobCount === 0) {
    // No lock is taken and nothing is called: a user with nothing configured
    // must not be able to contend with their own scheduled scan, and a job with
    // no usable field would otherwise mean a bare `after:` query over the whole
    // personal mailbox. Counts only - never a job name.
    logLine("calendar.scan.not_configured", { userId, mode, jobs: jobs.length });
    return emptyResult(SCAN_STATUS.NOT_CONFIGURED, { jobs: jobReports });
  }

  const acquired = await lockScan(userId, { staleAfterMs: staleLockAfterMs, env });
  if (!acquired) {
    logLine("calendar.scan.locked", { userId, mode });
    return emptyResult(SCAN_STATUS.LOCKED, { jobs: zeroJobReports(jobReports) });
  }

  try {
    const gmailConfig = readGmailConfig(env);
    const cap =
      mode === "manual"
        ? Math.min(positiveInt(maxMessages, MANUAL_SCAN_MAX_MESSAGES), MANUAL_SCAN_MAX_MESSAGES)
        : positiveInt(maxMessages, gmailConfig.maxMessages);

    // The budget is per INVOCATION, not per job: see the module docblock.
    const perJobCap = Math.max(1, Math.floor(cap / usableJobCount));

    // ONE floor for every job's query, and ONE deadline for the whole loop.
    // Both are computed here, before any job runs, so no job can be scanned
    // against a different window from its siblings and so a job that starts late
    // inherits the runway the earlier ones left, rather than being granted a
    // fresh budget the invocation does not have.
    const sinceDate = computeSince({ lastScanAt: connection?.lastScanAt, sinceDays: gmailConfig.sinceDays, now });
    const sinceIso = sinceDate.toISOString();
    const nowIso = new Date(now()).toISOString();
    const deadline = computeDeadline({ now, getRemainingTimeInMillis });

    const errors = [];
    let messagesScanned = 0;
    let eventsCreated = 0;
    let skipped = 0;
    let newestReceivedAt = null;
    let anyTruncated = false;
    let stoppedEarly = false;
    let anyJobFailed = false;
    let anyJobUnattempted = false;

    for (let index = 0; index < jobs.length; index += 1) {
      // An unusable job was never a candidate: it keeps `not_configured`, costs
      // no Gmail call, and (per the budget split above) never counted towards
      // `usableJobCount` either.
      if (!usable[index]) continue;

      const job = jobs[index];
      const report = jobReports[index];

      // Checked BEFORE each job as well as between messages: starting a fetch
      // with no runway left would spend the margin reserved for persisting and
      // unlocking. The job stays `not_attempted` with zero counts and the run is
      // reported truncated, which pins the watermark below.
      if (now() >= deadline) {
        stoppedEarly = true;
        anyJobUnattempted = true;
        logLine("calendar.scan.job_not_attempted", { userId, mode, processingJobId: job.id });
        continue;
      }

      let fetchResult;
      try {
        fetchResult = await fetchMessages({ userId, since: sinceDate, maxMessages: perJobCap, job }, commonDeps);
      } catch (err) {
        if (err instanceof ReauthRequiredError || err?.name === "ReauthRequiredError") {
          // The grant is gone, so every remaining job would fail identically.
          // google-token.mjs already best-effort marked lastScanStatus on the
          // connection before throwing this; writing it again here would only
          // race that write for no benefit.
          logLine("calendar.scan.reauth_required", { userId, mode, processingJobId: job.id });
          return emptyResult(SCAN_STATUS.REAUTH_REQUIRED, { jobs: zeroJobReports(jobReports) });
        }

        // One job's fetch failing is NOT the end of the run: the other jobs are
        // other schools, and losing all of them because one domain 500s would be
        // a self-inflicted outage. Recorded against this job and the run
        // continues; the watermark is pinned below because this job's window was
        // never actually searched.
        logLine("calendar.scan.job_fetch_failed", {
          userId,
          mode,
          processingJobId: job.id,
          errorName: err?.name || "Error",
          errorMessage: err?.message || "",
        });
        errors.push({ id: "", error: shortError(err) });
        report.status = SCAN_JOB_STATUS.ERROR;
        report.errors += 1;
        anyJobFailed = true;
        continue;
      }

      const messages = Array.isArray(fetchResult?.messages) ? fetchResult.messages : [];
      if (fetchResult?.truncated === true) {
        report.truncated = true;
        anyTruncated = true;
      }
      for (const failure of Array.isArray(fetchResult?.errors) ? fetchResult.errors : []) {
        errors.push(failure);
        report.errors += 1;
      }

      // --- Extraction: sequential, deadline-checked. See the module docblock's
      // "THROUGHPUT" section for why this is the chosen strategy. ---
      const extractions = [];
      let processed = 0;

      for (const message of messages) {
        if (now() >= deadline) {
          stoppedEarly = true;
          // This job saw only part of its own window, so it is truncated in
          // exactly the sense the watermark rule cares about.
          report.truncated = true;
          break;
        }
        try {
          const result = await extractOne(
            {
              message,
              // THIS JOB's own context, not a union across jobs: one school's
              // name must never appear in the prompt used to read another
              // school's email. `searchTerms` are deliberately absent - they are
              // a Gmail retrieval hint and never reach the model (TASK-056,
              // DECISION A; the rationale is in anthropic.mjs's
              // `buildUserContent`).
              schoolNames: [job.schoolName],
              searchDomains: [job.domain],
              // This message is here because THIS job's own query returned it,
              // and that query matches quoted text as well as sender domain. The
              // sender cost gate has therefore already been satisfied upstream;
              // re-applying it would silently discard every text-only match
              // after we had paid Gmail to fetch it. See `extractFromMessage`.
              queryMatched: true,
            },
            commonDeps
          );
          for (const event of result.events) extractions.push({ message, event });
        } catch (err) {
          // One unreadable message must not cost the batch - matching
          // gmail.mjs/anthropic.mjs's own "partial success is a success" rule.
          errors.push({ id: String(message?.id ?? ""), error: shortError(err) });
          report.errors += 1;
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

      // --- Persist whatever this job extracted, even when the deadline stopped
      // it part way: progress already made must survive, per the ticket's
      // resumability requirement, rather than being lost when the Lambda later
      // times out. Per job, so the rows carry this job's attribution. ---
      let stored = { written: 0, skipped: [] };
      if (extractions.length > 0) {
        try {
          stored = await persistEvents({ userId, extractions, processingJobId: job.id }, commonDeps);
        } catch (err) {
          // TASK-070: putEvents does not guard batchWrite, so a throw here means
          // this module genuinely does not know how many (if any) of this
          // batch's events reached the table. `written` stays 0 - reported as
          // uncertain, never assumed - the job is "partial", and the REMAINING
          // JOBS STILL RUN: this compounds nothing, and abandoning three other
          // schools over one failed write would.
          errors.push({ id: "", error: shortError(err) });
          report.errors += 1;
          logLine("calendar.scan.store_failed", {
            userId,
            mode,
            processingJobId: job.id,
            errorName: err?.name || "Error",
            errorMessage: err?.message || "",
          });
        }
      }

      report.messagesScanned = processed;
      report.eventsCreated = stored.written;
      report.skipped = stored.skipped.length;
      report.status = report.errors > 0 || report.truncated ? SCAN_JOB_STATUS.PARTIAL : SCAN_JOB_STATUS.OK;

      messagesScanned += processed;
      eventsCreated += stored.written;
      skipped += stored.skipped.length;

      // The maximum across jobs: ISO-8601 UTC strings compare as strings.
      const jobNewest = fetchResult?.newestReceivedAt || null;
      if (jobNewest && (!newestReceivedAt || jobNewest > newestReceivedAt)) newestReceivedAt = jobNewest;

      // Counts and an opaque id only - a job's `name` is the user's own words
      // about their own child's school and never reaches a log line.
      logLine("calendar.scan.job_complete", {
        userId,
        mode,
        processingJobId: job.id,
        status: report.status,
        messagesScanned: report.messagesScanned,
        eventsCreated: report.eventsCreated,
        truncated: report.truncated,
        errors: report.errors,
      });
    }

    const truncated = anyTruncated || stoppedEarly;
    const status = errors.length > 0 || truncated ? SCAN_STATUS.PARTIAL : SCAN_STATUS.OK;

    // --- Watermark. See the module docblock's "WATERMARK" section, and its
    // TASK-056 generalisation: the shared floor is the only value provably at or
    // before every message every job saw, dropped, or never reached, so anything
    // that left work behind ANYWHERE in the loop pins `lastScanAt` there. Only a
    // run in which every usable job completed untruncated advances forward. ---
    const newLastScanAt =
      truncated || anyJobUnattempted || anyJobFailed ? sinceIso : newestReceivedAt || nowIso;

    // ONE patch for the whole run, after the loop: a per-job patch would write
    // the connection N times per scan and leave `lastScanAt` briefly advanced
    // while later jobs were still running.
    await safePatch(
      patchConnection,
      userId,
      {
        lastScanAt: newLastScanAt,
        lastScanStatus: status,
        lastScanError: errors.length > 0 ? capText(errors[0].error) : "",
        lastScanMessagesScanned: messagesScanned,
        lastScanEventsCreated: eventsCreated,
        lastScanEventsUpdated: 0,
        lastScanSkipped: skipped,
        lastScanTruncated: truncated,
      },
      env,
      logLine
    );

    logLine("calendar.scan.complete", {
      userId,
      mode,
      status,
      jobs: jobs.length,
      messagesScanned,
      truncated,
      errors: errors.length,
    });

    return {
      status,
      // Totals are SUMS across every job and keep their existing meanings, so
      // nothing already reading them breaks. `eventsCreated` can double-count an
      // email two jobs both matched - see the module docblock.
      messagesScanned,
      eventsCreated,
      eventsUpdated: 0,
      skipped,
      truncated,
      errors,
      jobs: jobReports,
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
