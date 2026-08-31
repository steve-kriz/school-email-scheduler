/**
 * gmail.mjs - reads candidate school emails out of Gmail.
 *
 * RETRIEVAL ONLY. This module decides WHICH messages are candidates (sender
 * domain + a date window) and turns each one into plain text. It does not decide
 * what any message means: event extraction is TASK-007's job and no model call
 * happens here.
 *
 * Shape of a scan:
 *   buildJobQuery   -> a Gmail search string for ONE processing job (TASK-056)
 *   buildQuery      -> the legacy whole-connection form, kept for callers that
 *                      still search by sender domain alone
 *   listMessageIds  -> every id the query matches, paged, capped
 *   getMessage      -> one message, decoded to plain text
 *   fetchCandidateMessages -> the three above, for one user, plus a watermark
 *
 * ONE SEARCH PER PROCESSING JOB (TASK-056). A job carries its own
 * `{ id, name, schoolName, domains, searchTerms }`, and its query ORs EVERY
 * sender domain (TASK-059 - a job may watch several, e.g. a school's own domain
 * and its P&C's) together with QUOTED TEXT searches for the school name and each
 * search term. That widens matching from "sender domain only" to "one of these
 * sender domains or this text anywhere in the subject or body", deliberately: it
 * is what lets a school's mail be found when it arrives via a newsletter relay.
 * The caller therefore must NOT assume every returned message came from one of
 * the job's domains.
 *
 * WHY THE CAP AND THE WINDOW: a first scan of an unfiltered mailbox is unbounded
 * work against a rate-limited API. Every query is therefore domain-filtered and
 * date-bounded (90 days by default), and the id listing stops at `maxMessages`
 * and REPORTS that it stopped (`truncated: true`) rather than silently dropping
 * the remainder - a scan that quietly ignores half the mail looks like an
 * extraction bug later.
 *
 * RESILIENCE: 429 and 5xx are retried with exponential backoff plus jitter, at
 * most 4 attempts, honouring `Retry-After`. 401 re-mints the access token once
 * (tokens expire mid-scan) and 403 is never retried - a scope or permission
 * problem does not improve on the third try. A single message that fails to fetch
 * or parse is collected into `errors` and the scan continues: one malformed
 * newsletter must not cost the whole batch.
 *
 * TESTABILITY: `fetchImpl`, `sleep`, `random`, `now`, `getAccessToken`,
 * `getConnection`, `env` and `log` are all injectable with real defaults. The
 * backoff sleeps through the INJECTED sleep and jitters through the INJECTED
 * random, so a test can drive all 4 attempts instantly and deterministically with
 * `sleep: async () => {}` and `random: () => 0`.
 *
 * SECURITY: message bodies, subjects, snippets, sender addresses and access
 * tokens are NEVER logged, at any level. Neither is the query, a job's `name`,
 * its `schoolName` or any of its `searchTerms` - those are the user's own words
 * about their own children's school. The only things this module logs are
 * counts, statuses, Gmail message ids and a job's opaque `processingJobId`.
 */

import { normalizeDomain } from "./settings.mjs";
import { getConnection as getStoredConnection } from "./connections.mjs";
import { getAccessToken as mintAccessToken, ReauthRequiredError } from "./google-token.mjs";

/** Gmail REST base. Overridable per call so tests never touch the network. */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** The authenticated user; this app never reads another mailbox. */
export const GMAIL_USER_ID = "me";

/** Default cap on ids collected in one scan (see the module docblock). */
export const DEFAULT_MAX_MESSAGES = 200;

/** Default cap on characters kept per body. */
export const DEFAULT_MAX_BODY_CHARS = 20000;

/** Default lookback when the caller has no watermark yet. */
export const DEFAULT_SINCE_DAYS = 90;

/** Ids requested per `messages.list` page (Gmail allows up to 500). */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Safety net on paging. A server (or a stub) that keeps returning a
 * `nextPageToken` would otherwise loop forever; the id cap normally ends paging
 * long before this does.
 */
export const MAX_PAGES = 100;

/** Total attempts per HTTP request, including the first. */
export const MAX_ATTEMPTS = 4;

/** First backoff step; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 500;

/** Ceiling on any single backoff wait, including a `Retry-After` we were given. */
export const RETRY_MAX_DELAY_MS = 20000;

/** Statuses worth retrying: rate limiting and server-side faults. */
export const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/** Raised for a Gmail API failure that survived the retry policy. */
export class GmailApiError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, attempts?: number, reason?: string, messageId?: string }} [details]
   */
  constructor(message, { statusCode = 0, attempts = 0, reason = "", messageId = "" } = {}) {
    super(message);
    this.name = "GmailApiError";
    this.statusCode = statusCode;
    this.attempts = attempts;
    this.reason = reason;
    this.messageId = messageId;
  }
}

/** Real timer. Injected as `sleep` everywhere, so tests never actually wait. */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a logger that honours CALENDAR_LOG_LEVEL=none from the given
 * environment.
 *
 * A FACTORY rather than a module-level constant so the level is read per request
 * from the same injectable `env` as the rest of the configuration - a test that
 * injects `{ CALENDAR_LOG_LEVEL: "none" }` gets a silent module, and a redeployed
 * level takes effect on the next invocation.
 *
 * Only counts, statuses and message ids are ever passed to it from this module.
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
 * Read the scan limits from the environment, per request rather than at import
 * time, so a redeployed configuration takes effect on the next invocation and a
 * test can vary them without re-importing the module.
 *
 * All three variables are OPTIONAL - the defaults above are the intended
 * production values, and the variables exist only as an escape hatch, which is
 * why terraform does not set them.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ maxMessages: number, maxBodyChars: number, sinceDays: number }}
 */
export function readGmailConfig(env = process.env) {
  return {
    maxMessages: positiveInt(env.CALENDAR_GMAIL_MAX_MESSAGES, DEFAULT_MAX_MESSAGES),
    maxBodyChars: positiveInt(env.CALENDAR_GMAIL_MAX_BODY_CHARS, DEFAULT_MAX_BODY_CHARS),
    sinceDays: positiveInt(env.CALENDAR_GMAIL_SINCE_DAYS, DEFAULT_SINCE_DAYS),
  };
}

/**
 * Parse a positive integer, falling back on anything unusable (absent, blank,
 * zero, negative, NaN) - a misconfigured "0" must not mean "scan nothing" or
 * "keep no body".
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
 * Coerce a stored `searchDomains` value into a clean list of hostnames.
 *
 * Handles all three shapes the value arrives in: a JS `Set` (DynamoDB document
 * client), `{ SS: [...] }` (low-level client) or a plain array (a caller passing
 * what it already read). Each entry goes back through settings.mjs's
 * `normalizeDomain` so there is ONE definition of "what a domain is" in this
 * codebase; stored values already passed it, so this is idempotent, and it also
 * turns an "@school.edu" style entry into "school.edu".
 *
 * @param {unknown} value
 * @returns {string[]} Unique, lower-cased hostnames.
 */
export function toDomainList(value) {
  let entries = [];
  if (value instanceof Set) entries = [...value];
  else if (Array.isArray(value)) entries = value;
  else if (value && typeof value === "object" && Array.isArray(value.SS)) entries = value.SS;

  const seen = new Set();
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/**
 * Coerce a caller-supplied instant into a Date, or null.
 *
 * Accepts a Date, an ISO-8601 string (the shape `lastScanAt` is stored in) or a
 * number of epoch MILLISECONDS (matching `Date`). Anything unparseable reads as
 * "no watermark" rather than throwing, so a corrupt stored value degrades to a
 * full default window instead of failing the scan.
 *
 * @param {unknown} value
 * @returns {Date|null}
 */
export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

/**
 * Format a Date the way Gmail's `after:`/`before:` operators require.
 *
 * Gmail does NOT accept ISO-8601 here: `after:2026-08-17T00:00:00Z` is not a
 * date to Gmail, and depending on the rest of the query it either errors or
 * quietly matches the wrong thing. The operator takes `YYYY/MM/DD`, so the
 * conversion is explicit.
 *
 * The parts are taken in UTC, deliberately: the alternative is the container's
 * local zone, which on Lambda is also UTC but is not guaranteed to be. Gmail
 * itself evaluates `after:` in the ACCOUNT's timezone, so this filter is only
 * day-accurate - which is why callers must treat the boundary as overlapping and
 * de-duplicate by message id rather than assume the window is exact.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026/08/17"
 */
export function formatGmailDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * Compose the Gmail search string for a user's candidate mail.
 *
 * Example: `(from:@stmarys.edu.au OR from:@pta.stmarys.edu.au) after:2026/05/19`
 *
 * The `from:` clauses are OR-joined inside PARENTHESES because Gmail's implicit
 * operator is AND: without the brackets the trailing `after:` binds to the last
 * clause only, and the query silently means something else.
 *
 * An empty domain list THROWS rather than producing a bare `after:` query. A
 * query with no sender filter would scan the user's entire mailbox and send every
 * personal email through the rest of the pipeline; there is no situation in which
 * that is the desired fallback.
 *
 * @param {object} args
 * @param {string[]|Set<string>|{SS: string[]}} args.searchDomains
 * @param {Date|string|number|null} [args.since] Watermark; the window starts here.
 * @param {number} [args.sinceDays] Lookback used when `since` is absent.
 * @param {() => Date} [args.now] Injectable clock.
 * @returns {string}
 */
export function buildQuery({ searchDomains, since = null, sinceDays = DEFAULT_SINCE_DAYS, now = () => new Date() } = {}) {
  const domains = toDomainList(searchDomains);
  if (domains.length === 0) {
    const error = new Error("buildQuery: at least one search domain is required");
    error.code = "no_search_domains";
    throw error;
  }

  const fromClause = domains.map((domain) => `from:@${domain}`).join(" OR ");

  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SINCE_DAYS;
  // No watermark means a first scan, and a first scan is bounded: 90 days is
  // roughly a school term either side, and unbounded history is both slow and
  // full of events that are already in the past.
  const start = toDate(since) || new Date(now().getTime() - days * 24 * 60 * 60 * 1000);

  return `(${fromClause}) after:${formatGmailDate(start)}`;
}

/**
 * Coerce a stored `searchTerms` value into a clean list of phrases.
 *
 * Same shape-tolerance as `toDomainList` (JS `Set` from the document client,
 * `{ SS: [...] }` from the low-level one, a plain array, or a lone string), but
 * deliberately NOT the same normalisation: a search term is the user's own free
 * text, so it is neither lower-cased nor split on commas - "Year 4, Kindy" is one
 * phrase the user typed, and splitting it would search for something they never
 * asked for. settings.mjs (TASK-055) owns the validation rules; this only
 * tolerates whatever is in the table.
 *
 * @param {unknown} value
 * @returns {string[]} Trimmed, non-blank phrases, in the stored order.
 */
export function toSearchTermList(value) {
  let entries = [];
  if (value instanceof Set) entries = [...value];
  else if (Array.isArray(value)) entries = value;
  else if (value && typeof value === "object" && Array.isArray(value.SS)) entries = value.SS;
  else if (typeof value === "string") entries = [value];

  const terms = [];
  for (const entry of entries) {
    const term = String(entry ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Turn one free-text value (a school name, a search term) into a QUOTED Gmail
 * clause, or "" when there is nothing usable left.
 *
 * Gmail has no escape syntax inside a quoted phrase, so an embedded `"` cannot be
 * escaped - it can only END the phrase early, after which the rest of the user's
 * text is read as OPERATORS (`... OR from:@evil.example` being the obvious
 * abuse). NEUTRALISATION IS THEREFORE BY STRIPPING: every double quote (straight
 * or typographic) is removed before the value is wrapped, so the emitted clause is
 * always exactly one quoted token. A value that is left empty by the stripping is
 * treated as blank and dropped by the caller.
 *
 * Newlines and control characters are collapsed to spaces first (a query is a
 * single line; a raw newline would truncate it), and runs of whitespace are
 * collapsed so the phrase matches the way the user would expect.
 *
 * @param {unknown} value
 * @returns {string} e.g. `"St Mary's Primary"`, or "".
 */
export function toQueryPhrase(value) {
  const text = String(value ?? "")
    // Control characters (newline, tab, NUL, DEL) become spaces before
    // anything else: a Gmail query is a single line.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    // Straight AND typographic quotes: a smart quote pasted out of a word
    // processor terminates a Gmail phrase just as a straight one does.
    .replace(/["\u201C\u201D\u201E\u201F\u2033]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? `"${text}"` : "";
}

/**
 * The OR clauses one processing job contributes to a Gmail query.
 *
 * Order is fixed and contractual (the regression guard in TASK-056 compares the
 * emitted string byte for byte): the sender-domain clauses first, in stored
 * order, then the school name, then each search term in stored order. The domains
 * go through the SAME `toDomainList`/`normalizeDomain` path the old single-query
 * builder used, so there is still exactly one definition of "what a domain is" in
 * this codebase.
 *
 * A JOB MAY WATCH SEVERAL DOMAINS (TASK-059), and `domains` may equally be absent
 * or empty. Nothing here needed new looping to support that: `toDomainList`
 * already accepts a plain array (as well as a `Set` and `{ SS: [...] }`), already
 * normalises and de-duplicates it, and the loop below already emits one
 * `from:@<host>` clause per entry - which is the same OR-per-domain shape
 * `buildQuery` has always produced for the whole-connection form.
 *
 * Blank entries are dropped and duplicate clauses are emitted once (compared
 * case-insensitively, since Gmail's text search is case-insensitive anyway and a
 * repeated clause only costs query length).
 *
 * @param {{ domains?: unknown, schoolName?: unknown, searchTerms?: unknown }} [job]
 * @returns {string[]}
 */
export function buildJobClauses(job = {}) {
  const clauses = [];
  const seen = new Set();

  const add = (clause) => {
    if (!clause) return;
    const key = clause.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    clauses.push(clause);
  };

  for (const domain of toDomainList(job?.domains)) add(`from:@${domain}`);
  add(toQueryPhrase(job?.schoolName));
  for (const term of toSearchTermList(job?.searchTerms)) add(toQueryPhrase(term));

  return clauses;
}

/**
 * Can this job be searched at all? True when it contributes at least one clause.
 *
 * Exported so the scan loop can decide "usable" WITHOUT building a query or
 * catching an exception - it needs the count of usable jobs up front to split the
 * message budget between them.
 *
 * @param {object} [job]
 * @returns {boolean}
 */
export function hasJobQueryClauses(job) {
  return buildJobClauses(job).length > 0;
}

/**
 * Compose the Gmail search string for ONE processing job.
 *
 * Example:
 *   `(from:@stmarys.edu.au OR "St Mary's Primary" OR "Year 4") after:2026/05/19`
 *   `(from:@stmarys.edu.au OR from:@pandc.org.au OR "St Mary's") after:2026/05/19`
 *
 * This is the per-job sibling of `buildQuery` and follows exactly the same
 * bracketing rule: the clauses are OR-joined inside ONE pair of parentheses and
 * the `after:` floor is appended OUTSIDE the group, because Gmail's implicit
 * operator is AND and an unbracketed `after:` would bind to the last clause only.
 * A job whose only clause is its one domain therefore emits `(from:@d) after:...`,
 * byte-identical to what the single-domain query emitted before TASK-059.
 *
 * DELIBERATE WIDENING: unlike `buildQuery`, this matches on TEXT as well as on
 * sender - a quoted school name or search term matches subject and body. That is
 * the point of a processing job, not an accident. It also means the caller must
 * not assume every returned message came from one of `job.domains`.
 *
 * A job with NO usable clause THROWS (`code: "no_job_query"`) rather than
 * emitting a bare `after:` query: that query would return the user's entire
 * personal mailbox and put it through extraction. THIS GUARD IS NOT MERELY
 * DEFENSIVE (TASK-059): `domains` is OPTIONAL upstream, so only `name` and
 * `schoolName` are required by `validateProcessingJobs`, and a job with no
 * domains, no search terms and a `schoolName` that `toQueryPhrase` strips to ""
 * (say `"""`) passes validation and reaches here with zero clauses. It is a
 * REACHABLE case, and the throw is what stops a mailbox-wide query being issued
 * for it - `hasJobQueryClauses` is how scan.mjs sees it coming and reports the job
 * `not_configured` instead.
 *
 * @param {object} args
 * @param {{ id?: string, name?: string, schoolName?: unknown, domains?: unknown, searchTerms?: unknown }} args.job
 * @param {Date|string|number|null} [args.since] Watermark; the window starts here.
 * @param {number} [args.sinceDays] Lookback used when `since` is absent.
 * @param {() => Date} [args.now] Injectable clock.
 * @returns {string}
 */
export function buildJobQuery({ job, since = null, sinceDays = DEFAULT_SINCE_DAYS, now = () => new Date() } = {}) {
  const clauses = buildJobClauses(job);
  if (clauses.length === 0) {
    const error = new Error("buildJobQuery: the job has no usable search domain, school name or search term");
    error.code = "no_job_query";
    throw error;
  }

  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : DEFAULT_SINCE_DAYS;
  const start = toDate(since) || new Date(now().getTime() - days * 24 * 60 * 60 * 1000);

  return `(${clauses.join(" OR ")}) after:${formatGmailDate(start)}`;
}

/**
 * Interpret a `Retry-After` header.
 *
 * BOTH RFC 9110 forms are supported, because Google sends either depending on
 * the service: a delta-seconds count ("30") and an HTTP-date ("Wed, 21 Oct 2026
 * 07:28:00 GMT"). The date form is resolved against the INJECTED clock, so a
 * fixture date does not become a negative (or enormous) wait as the test suite
 * ages. Anything else - blank, garbage, a past date - reads as null so the
 * caller falls back on its own backoff.
 *
 * @param {string|null|undefined} value
 * @param {{ now?: () => number }} [options]
 * @returns {number|null} Milliseconds to wait, or null.
 */
export function parseRetryAfter(value, { now = () => Date.now() } = {}) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now());
}

/**
 * How long to wait before attempt N+1.
 *
 * Exponential (500ms, 1s, 2s, ...) with EQUAL JITTER: half the computed delay is
 * fixed and half is random. The jitter matters because a scheduled scan can wake
 * many users' work at the same instant, and a fixed backoff would have them all
 * retry in lockstep and re-trigger the same 429.
 *
 * A `Retry-After` we were actually given wins over the local calculation - the
 * server knows better - but is still clamped to `maxDelayMs`, so a header of
 * "3600" cannot park a Lambda for an hour.
 *
 * Pure, with `random` injected, so the backoff schedule is fully assertable.
 *
 * @param {object} args
 * @param {number} args.attempt 1-based number of the attempt that just failed.
 * @param {number|null} [args.retryAfterMs]
 * @param {number} [args.baseDelayMs]
 * @param {number} [args.maxDelayMs]
 * @param {() => number} [args.random]
 * @returns {number} Milliseconds.
 */
export function backoffDelayMs({
  attempt,
  retryAfterMs = null,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  random = Math.random,
} = {}) {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.round(retryAfterMs), maxDelayMs);
  }
  const step = Math.max(1, Number.isFinite(attempt) ? attempt : 1);
  const exponential = Math.min(baseDelayMs * 2 ** (step - 1), maxDelayMs);
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

/** Is this status worth another attempt? */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.includes(status) || (typeof status === "number" && status >= 500 && status < 600);
}

/**
 * Read a header from a `Response`-like object, tolerating a plain-object stub.
 *
 * @param {any} response
 * @param {string} name
 * @returns {string|null}
 */
function readHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return direct === undefined ? null : String(direct);
}

/**
 * Perform one Gmail API request, with the retry policy applied.
 *
 * Returns the parsed JSON payload AND the access token that finally worked: when
 * a 401 forced a re-mint mid-scan, the caller must adopt the new token for its
 * next request, or every remaining request pays for another 401 round trip.
 *
 * Policy, in order:
 *  - 2xx: parse and return.
 *  - 401: re-mint the token via `refreshAccessToken` and retry ONCE. Tokens
 *    expire mid-scan; that is normal and not an error. A second 401, or no
 *    refresher, fails immediately - retrying a rejected credential is pointless.
 *  - 403: fail immediately. Insufficient scope, a disabled API or a suspended
 *    account do not resolve within a backoff window, and hammering them looks
 *    like abuse.
 *  - 429 / 5xx: back off (honouring `Retry-After`) and retry, up to
 *    `maxAttempts` total attempts, then fail with the last status.
 *  - A thrown fetch error (DNS, socket) is treated as retryable: it is the
 *    network equivalent of a 503.
 *
 * @param {string} url
 * @param {object} deps
 * @param {string} deps.accessToken
 * @param {(url: string, init?: object) => Promise<any>} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep] Injected: tests never wait.
 * @param {() => number} [deps.random] Injected jitter source.
 * @param {() => number} [deps.now] Epoch-ms clock, for HTTP-date Retry-After.
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.baseDelayMs]
 * @param {number} [deps.maxDelayMs]
 * @param {(() => Promise<string>)|null} [deps.refreshAccessToken]
 * @param {string} [deps.messageId] For error/log context only.
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ payload: any, accessToken: string }>}
 */
export async function gmailRequest(
  url,
  {
    accessToken,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = () => Date.now(),
    maxAttempts = MAX_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    refreshAccessToken = null,
    messageId = "",
    log = defaultLog,
  } = {}
) {
  if (typeof fetchImpl !== "function") throw new GmailApiError("gmailRequest: no fetch implementation available");

  let token = accessToken;
  let reminted = false;
  let attempt = 0;
  let lastStatus = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    let response = null;
    let transportError = null;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (error) {
      transportError = error;
    }

    if (transportError) {
      if (attempt >= maxAttempts) {
        throw new GmailApiError(`Gmail request failed after ${attempt} attempts: ${transportError.message}`, {
          attempts: attempt,
          reason: "transport",
          messageId,
        });
      }
      await sleep(backoffDelayMs({ attempt, baseDelayMs, maxDelayMs, random }));
      continue;
    }

    const status = response?.status ?? 0;
    lastStatus = status;

    if (response?.ok) {
      const text = typeof response.text === "function" ? await response.text() : "";
      try {
        return { payload: text ? JSON.parse(text) : {}, accessToken: token };
      } catch {
        // A 200 that is not JSON is not something a retry fixes.
        throw new GmailApiError("Gmail returned a non-JSON body", {
          statusCode: status,
          attempts: attempt,
          reason: "non_json",
          messageId,
        });
      }
    }

    // Drain the error body so the connection can be reused, and pull only the
    // API-level fields out of it. Gmail error bodies describe the FAILURE, but
    // they are never echoed wholesale into an error message - `message` can
    // contain the query, and the query contains the school's domains.
    let errorPayload = null;
    if (typeof response?.text === "function") {
      const text = await response.text();
      try {
        errorPayload = text ? JSON.parse(text) : null;
      } catch {
        errorPayload = null;
      }
    }
    const apiReason = typeof errorPayload?.error?.status === "string" ? errorPayload.error.status : "";

    if (status === 401) {
      if (typeof refreshAccessToken === "function" && !reminted) {
        reminted = true;
        log("calendar.gmail.token_reminted", { status });
        token = await refreshAccessToken();
        // Straight back round the loop with the new credential: no backoff, this
        // is an expected token rotation rather than a fault.
        continue;
      }
      throw new GmailApiError("Gmail rejected the access token (401)", {
        statusCode: status,
        attempts: attempt,
        reason: apiReason || "unauthenticated",
        messageId,
      });
    }

    if (status === 403) {
      throw new GmailApiError("Gmail refused the request (403)", {
        statusCode: status,
        attempts: attempt,
        reason: apiReason || "forbidden",
        messageId,
      });
    }

    if (isRetryableStatus(status) && attempt < maxAttempts) {
      const retryAfterMs = parseRetryAfter(readHeader(response, "retry-after"), { now });
      const delay = backoffDelayMs({ attempt, retryAfterMs, baseDelayMs, maxDelayMs, random });
      log("calendar.gmail.retry", { status, attempt, delayMs: delay, messageId });
      await sleep(delay);
      continue;
    }

    throw new GmailApiError(`Gmail request failed with status ${status}`, {
      statusCode: status,
      attempts: attempt,
      reason: apiReason || (isRetryableStatus(status) ? "retries_exhausted" : "http_error"),
      messageId,
    });
  }

  throw new GmailApiError(`Gmail request failed after ${maxAttempts} attempts`, {
    statusCode: lastStatus,
    attempts: maxAttempts,
    reason: "retries_exhausted",
    messageId,
  });
}

/**
 * List the ids of every message matching a query, following `nextPageToken`.
 *
 * Stops when Gmail runs out of pages or when `maxMessages` ids have been
 * collected. `truncated` is true only when mail was actually LEFT BEHIND (the cap
 * was reached and either the page held more ids or another page existed), so a
 * result that happens to be exactly `maxMessages` long with nothing after it
 * reports `truncated: false` rather than crying wolf.
 *
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.query
 * @param {number} [args.maxMessages]
 * @param {number} [args.pageSize]
 * @param {string} [args.apiBase]
 * @param {number} [args.maxPages]
 * @param {object} [deps] Passed through to `gmailRequest` (fetchImpl, sleep,
 *   random, now, maxAttempts, refreshAccessToken, log, ...).
 * @returns {Promise<{ ids: string[], truncated: boolean }>}
 */
export async function listMessageIds(
  { accessToken, query, maxMessages = DEFAULT_MAX_MESSAGES, pageSize = DEFAULT_PAGE_SIZE, apiBase = GMAIL_API_BASE, maxPages = MAX_PAGES },
  deps = {}
) {
  if (typeof query !== "string" || !query) throw new Error("listMessageIds: query is required");
  const cap = positiveInt(maxMessages, DEFAULT_MAX_MESSAGES);

  const ids = [];
  let truncated = false;
  let pageToken = null;
  let token = accessToken;
  let pages = 0;

  while (pages < maxPages) {
    pages += 1;

    const remaining = cap - ids.length;
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.max(1, Math.min(positiveInt(pageSize, DEFAULT_PAGE_SIZE), remaining))),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const { payload, accessToken: currentToken } = await gmailRequest(
      `${apiBase}/users/${GMAIL_USER_ID}/messages?${params.toString()}`,
      { ...deps, accessToken: token }
    );
    // Adopt a token that a mid-scan 401 re-minted, so the next page does not 401
    // all over again.
    token = currentToken;

    const page = Array.isArray(payload?.messages) ? payload.messages : [];
    for (const entry of page) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!id) continue;
      if (ids.length >= cap) {
        // More matches exist than the caller allowed: report the cap, do not
        // pretend the mailbox ended here.
        truncated = true;
        break;
      }
      ids.push(id);
    }

    pageToken = typeof payload?.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : null;

    if (ids.length >= cap) {
      if (pageToken) truncated = true;
      break;
    }
    if (!pageToken) break;
  }

  if (pages >= maxPages && pageToken) truncated = true;

  return { ids, truncated };
}

/**
 * Decode Gmail's body encoding.
 *
 * Gmail returns part bodies as BASE64URL, not standard base64: `-` and `_` stand
 * in for `+` and `/`, and the `=` padding is usually omitted. Decoding such a
 * string as plain base64 does not fail loudly - it produces plausible-looking but
 * CORRUPTED text, which then reaches the extractor as garbage. The alphabet is
 * therefore translated and the padding restored explicitly.
 *
 * Doing it this way (rather than passing "base64url" to `Buffer.from`) also means
 * a part that arrives in standard base64 decodes correctly too, since `+` and `/`
 * survive the translation untouched. Do not "simplify" this away.
 *
 * @param {unknown} data
 * @returns {string} UTF-8 text, or "" for anything undecodable.
 */
export function decodeBase64Url(data) {
  if (typeof data !== "string" || data.length === 0) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padding = (4 - (normalized.length % 4)) % 4;
  try {
    return Buffer.from(normalized + "=".repeat(padding), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Reduce an HTML body to readable text.
 *
 * Only used when a message has NO text/plain alternative. The goal is not
 * fidelity, it is that the dates and times survive: `<script>`/`<style>` content
 * is dropped entirely (it is never prose), block-level tags become newlines so
 * "Friday 3pm" does not run into the next table cell, remaining tags are stripped
 * and the handful of entities that actually appear in school newsletters are
 * decoded.
 *
 * @param {unknown} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (typeof html !== "string" || html.length === 0) return "";

  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    // Block boundaries become line breaks BEFORE tags are stripped, otherwise
    // adjacent cells and list items concatenate into one unreadable run.
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\s*\/?\s*td\s*[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");

  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:lt|#60);/gi, "<")
    .replace(/&(?:gt|#62);/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(Number.parseInt(code, 16)));

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turn a numeric HTML entity into its character, or drop it.
 * @param {number} code
 * @returns {string}
 */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Walk a Gmail MIME tree and pull out readable text.
 *
 * Preference: every text/plain part in the tree wins over every text/html part.
 * The plain alternative is what senders write the dates into, and it needs no
 * lossy tag stripping. HTML is used only when there is no plain text anywhere.
 * (The preference is applied across the whole tree rather than per
 * multipart/alternative branch - simpler, and for a newsletter the two branches
 * carry the same content.)
 *
 * ATTACHMENTS ARE SKIPPED, and skipped as a whole SUBTREE: any part carrying a
 * `filename` is an attachment, whatever its mimeType claims. A PDF newsletter or
 * an embedded image decodes to megabytes of binary noise that would blow the body
 * budget, cost tokens downstream and contain no extractable text anyway. This is
 * why the check is on `filename` and not on a mimeType allow-list.
 *
 * Handles nesting: multipart/mixed wrapping multipart/alternative wrapping the
 * two text parts is the ordinary shape of a school newsletter with an attachment.
 *
 * @param {object|null|undefined} payload A message `payload`, or any part of one.
 * @returns {string} Plain text, "" when the tree holds no readable part.
 */
export function extractPlainText(payload) {
  const plain = [];
  const html = [];

  const visit = (part, depth) => {
    if (!part || typeof part !== "object" || depth > 20) return;

    // Attachment: skip this part AND anything nested inside it.
    if (typeof part.filename === "string" && part.filename.length > 0) return;

    const mimeType = String(part.mimeType || "").toLowerCase();

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      for (const child of part.parts) visit(child, depth + 1);
      // A multipart container can still carry data on itself in odd producers,
      // so fall through rather than returning here.
    }

    const data = part.body?.data;
    if (typeof data !== "string" || data.length === 0) return;

    if (mimeType === "text/plain" || mimeType.startsWith("text/plain;")) {
      plain.push(decodeBase64Url(data));
    } else if (mimeType === "text/html" || mimeType.startsWith("text/html;")) {
      html.push(decodeBase64Url(data));
    } else if (!mimeType && plain.length === 0 && html.length === 0) {
      // No mimeType at all (a bare body): treat it as text rather than lose it.
      plain.push(decodeBase64Url(data));
    }
  };

  visit(payload, 0);

  const plainText = plain.join("\n").trim();
  if (plainText) return plainText;

  const htmlText = html.join("\n");
  return htmlText ? stripHtml(htmlText) : "";
}

/**
 * Cap a body's length, KEEPING THE HEAD.
 *
 * The head is where the information is: school emails lead with the event, the
 * date and the time, and the tail is signatures, disclaimers and quoted threads.
 * Keeping the tail instead would routinely discard the very sentence the
 * extractor exists to read.
 *
 * No "[truncated]" marker is appended, deliberately: the result is a verbatim
 * prefix of the body, so nothing downstream can mistake an inserted marker for
 * something the school wrote.
 *
 * @param {unknown} text
 * @param {number} [maxBodyChars]
 * @returns {string}
 */
export function truncateBody(text, maxBodyChars = DEFAULT_MAX_BODY_CHARS) {
  if (typeof text !== "string" || text.length === 0) return "";
  const cap = positiveInt(maxBodyChars, DEFAULT_MAX_BODY_CHARS);
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * Read one header value, case-insensitively (Gmail's casing is not contractual).
 *
 * @param {Array<{name?: string, value?: string}>|undefined} headers
 * @param {string} name
 * @returns {string}
 */
export function findHeader(headers, name) {
  if (!Array.isArray(headers)) return "";
  const wanted = String(name).toLowerCase();
  for (const header of headers) {
    if (String(header?.name || "").toLowerCase() === wanted) {
      return typeof header.value === "string" ? header.value : "";
    }
  }
  return "";
}

/**
 * Project a raw `users.messages.get` payload into the shape the rest of the
 * pipeline consumes.
 *
 * `receivedAt` comes from `internalDate` (epoch ms, Gmail's own record of when
 * the message arrived) in preference to the `Date` header, which is written by
 * the SENDER and is routinely wrong, mis-zoned or absent. The header is the
 * fallback only.
 *
 * Pure: exported so the mapping and the truncation are testable without any HTTP.
 *
 * @param {object|null} payload
 * @param {{ maxBodyChars?: number }} [options]
 * @returns {{ id: string, threadId: string, subject: string, from: string, receivedAt: string|null, snippet: string, body: string }}
 */
export function parseMessage(payload, { maxBodyChars = DEFAULT_MAX_BODY_CHARS } = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const headers = source.payload?.headers;

  let receivedAt = null;
  const internal = Number.parseInt(String(source.internalDate ?? ""), 10);
  if (Number.isFinite(internal) && internal > 0) {
    receivedAt = new Date(internal).toISOString();
  } else {
    const headerDate = toDate(findHeader(headers, "Date"));
    receivedAt = headerDate ? headerDate.toISOString() : null;
  }

  return {
    id: typeof source.id === "string" ? source.id : "",
    threadId: typeof source.threadId === "string" ? source.threadId : "",
    subject: findHeader(headers, "Subject"),
    from: findHeader(headers, "From"),
    receivedAt,
    snippet: typeof source.snippet === "string" ? source.snippet : "",
    body: truncateBody(extractPlainText(source.payload), maxBodyChars),
  };
}

/**
 * Fetch and decode one message.
 *
 * `format=full` is requested because the parsed MIME tree is what
 * `extractPlainText` walks; `format=raw` would mean implementing a MIME parser
 * here, and `format=metadata` returns no body at all.
 *
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.id
 * @param {number} [args.maxBodyChars]
 * @param {string} [args.apiBase]
 * @param {object} [deps] Passed through to `gmailRequest`.
 * @returns {Promise<{ id: string, threadId: string, subject: string, from: string, receivedAt: string|null, snippet: string, body: string }>}
 */
export async function getMessage(
  { accessToken, id, maxBodyChars = DEFAULT_MAX_BODY_CHARS, apiBase = GMAIL_API_BASE },
  deps = {}
) {
  if (typeof id !== "string" || !id) throw new Error("getMessage: id is required");

  const url = `${apiBase}/users/${GMAIL_USER_ID}/messages/${encodeURIComponent(id)}?format=full`;
  const { payload } = await gmailRequest(url, { ...deps, accessToken, messageId: id });
  const message = parseMessage(payload, { maxBodyChars });
  // Gmail echoes the id; prefer it, but never return an empty id for a message we
  // did fetch - downstream de-duplication keys on it.
  return message.id ? message : { ...message, id };
}

/**
 * The scan-facing entry point: every candidate message for one user.
 *
 * Sequence: resolve WHAT to search for, mint an access token, build the query,
 * list the ids, then fetch the messages one at a time.
 *
 * THREE WAYS TO SAY WHAT TO SEARCH FOR, in precedence order:
 *   1. `query` - a Gmail search string the caller already built. Used verbatim.
 *   2. `job` - one processing job (TASK-056); the query comes from
 *      `buildJobQuery`, which throws `no_job_query` for a job with no usable
 *      field rather than searching the whole mailbox.
 *   3. `searchDomains` (or, failing that, the stored connection) - the legacy
 *      sender-domain-only form, via `buildQuery`.
 * Everything after that step is identical in all three cases: the return
 * contract, the sequential fetching, the per-message error collection, the
 * `ReauthRequiredError` rethrow and `newestReceivedAt` do not vary.
 *
 * Fetching is SEQUENTIAL on purpose. The bottleneck of a scan is Gmail's
 * per-user rate limit, and firing a batch concurrently mostly buys a burst of
 * 429s that the backoff then has to unwind - a slower scan overall, and a noisier
 * one.
 *
 * PARTIAL SUCCESS IS A SUCCESS: a message that fails to fetch or parse is
 * recorded in `errors` as `{ id, error }` and the loop continues. The one
 * exception is `ReauthRequiredError`, which is rethrown: the grant is gone, so
 * every remaining message would fail the same way and the user needs to be told
 * to reconnect.
 *
 * `newestReceivedAt` is the latest `receivedAt` among the messages actually
 * returned, and is what TASK-008 advances the incremental watermark to. It is
 * computed from successes only - advancing past a message that failed would mean
 * never seeing it again.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {Date|string|number|null} [args.since] Watermark; omit for a first scan.
 * @param {number} [args.maxMessages]
 * @param {number} [args.maxBodyChars]
 * @param {string[]|Set<string>|null} [args.searchDomains] Pass what the caller
 *   already read, to save a second table lookup.
 * @param {{ id?: string, name?: string, schoolName?: unknown, domains?: unknown, searchTerms?: unknown }|null} [args.job]
 *   One processing job to search for (TASK-056; `domains` is a list since
 *   TASK-059 and is optional).
 * @param {string|null} [args.query] A pre-built Gmail query, used verbatim.
 * @param {object} [deps]
 * @param {(userId: string, options?: object) => Promise<string>} [deps.getAccessToken]
 * @param {(userId: string, options?: object) => Promise<object|null>} [deps.getConnection]
 * @param {(url: string, init?: object) => Promise<any>} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random]
 * @param {() => number} [deps.now] Epoch-ms clock.
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.baseDelayMs]
 * @param {number} [deps.maxDelayMs]
 * @param {number} [deps.pageSize]
 * @param {string} [deps.apiBase]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ messages: object[], truncated: boolean, errors: Array<{id: string, error: string}>, newestReceivedAt: string|null }>}
 */
export async function fetchCandidateMessages(
  { userId, since = null, maxMessages = null, maxBodyChars = null, searchDomains = null, job = null, query: prebuiltQuery = null } = {},
  {
    getAccessToken = mintAccessToken,
    getConnection = getStoredConnection,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = () => Date.now(),
    maxAttempts = MAX_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    pageSize = DEFAULT_PAGE_SIZE,
    apiBase = GMAIL_API_BASE,
    env = process.env,
    log = null,
  } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("fetchCandidateMessages: userId is required");

  // Resolved from the injected `env` when the caller did not supply a logger, so
  // CALENDAR_LOG_LEVEL is honoured per request rather than per container.
  const logLine = typeof log === "function" ? log : makeLogger(env);

  const config = readGmailConfig(env);
  const cap = positiveInt(maxMessages, config.maxMessages);
  const bodyCap = positiveInt(maxBodyChars, config.maxBodyChars);

  // The job's opaque id is the only part of a job this module may log: `name`,
  // `schoolName` and `searchTerms` are the user's own words. See the SECURITY
  // note in the module docblock.
  const processingJobId = String(job?.id ?? "");

  // Throws with code "no_search_domains"/"no_job_query" - a configuration
  // problem, not a per-message one, so it is NOT reported through `errors`. See
  // buildQuery/buildJobQuery.
  let query;
  if (typeof prebuiltQuery === "string" && prebuiltQuery.trim()) {
    query = prebuiltQuery.trim();
  } else if (job) {
    query = buildJobQuery({ job, since, sinceDays: config.sinceDays, now: () => new Date(now()) });
  } else {
    let domains = toDomainList(searchDomains);
    if (domains.length === 0) {
      const connection = await getConnection(userId, { env });
      domains = toDomainList(connection?.searchDomains);
    }
    query = buildQuery({ searchDomains: domains, since, sinceDays: config.sinceDays, now: () => new Date(now()) });
  }

  // Any ReauthRequiredError from here propagates untouched: it is the one failure
  // the user can actually fix.
  let accessToken = await getAccessToken(userId, { env, log: logLine });

  // Re-mint at most once per scan. `forceRefresh` is used only for that first
  // re-mint; later calls take the (now fresh) cached token, so a token that
  // expires mid-scan costs one extra round trip rather than one per message.
  let reminted = false;
  const refreshAccessToken = async () => {
    accessToken = await getAccessToken(userId, { env, log: logLine, forceRefresh: !reminted });
    reminted = true;
    return accessToken;
  };

  const httpDeps = {
    fetchImpl,
    sleep,
    random,
    now,
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    refreshAccessToken,
    log: logLine,
  };

  const { ids, truncated } = await listMessageIds(
    { accessToken, query, maxMessages: cap, pageSize, apiBase },
    httpDeps
  );

  const messages = [];
  const errors = [];
  let newestReceivedAt = null;

  for (const id of ids) {
    try {
      const message = await getMessage({ accessToken, id, maxBodyChars: bodyCap, apiBase }, httpDeps);
      messages.push(message);
      if (message.receivedAt && (!newestReceivedAt || message.receivedAt > newestReceivedAt)) {
        // ISO-8601 UTC strings compare correctly as strings, which avoids
        // re-parsing every timestamp just to find the maximum.
        newestReceivedAt = message.receivedAt;
      }
    } catch (error) {
      if (error instanceof ReauthRequiredError || error?.name === "ReauthRequiredError") throw error;
      // Id and reason only. Never the subject, the sender or the body.
      errors.push({ id, error: error?.message || String(error) });
    }
  }

  logLine("calendar.gmail.scan_complete", {
    userId,
    // Counts, statuses and opaque ids only - never the query itself, which
    // carries the school name and every search term the user typed.
    processingJobId,
    listed: ids.length,
    fetched: messages.length,
    failed: errors.length,
    truncated,
  });

  return { messages, truncated, errors, newestReceivedAt };
}
