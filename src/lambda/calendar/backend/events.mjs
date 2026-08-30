/**
 * events.mjs - the only module that touches the calendar events table.
 *
 * Table shape is documented in terraform/dynamodb_calendar_events.tf: hash key
 * `userId` = "google#<google sub>", range key `eventId`, a StartsAtIndex for the
 * month view and a SPARSE AttentionIndex for the "needs attention" list.
 *
 * The WRITE half is everything between "the model said something" and "a row
 * exists":
 *   normaliseInstant  -> is this string actually a date?
 *   buildEventItem    -> one model event -> one storable row, or a recorded skip
 *   deriveEventId     -> the content-derived key that makes a re-scan idempotent
 *   putEvents         -> BatchWriteItem in 25s, retrying UnprocessedItems
 *   storeEvents       -> the above for a whole extraction, preserving any
 *                        acknowledge/dismiss the user has already made
 *
 * The READ/MUTATE half (TASK-009, second half of this file) is everything the
 * browser needs:
 *   queryEventsInRange   -> StartsAtIndex BETWEEN, paged, for the month view
 *   queryUpcomingEvents  -> AttentionIndex, soonest deadline first
 *   acknowledgeEvent / dismissEvent / restoreEvent -> conditional UpdateItems
 *   toEventJson          -> the allow-listed response projection
 *
 * ---------------------------------------------------------------------------
 * TRUST: every `event` reaching this module came from a language model reading an
 * attacker-writable email, so nothing in it is trusted for anything but its own
 * field. Values are length-capped, the category is mapped onto a closed list, the
 * confidence is clamped, and any event whose date does not survive the checks
 * below is DROPPED with a recorded reason rather than stored. The only side effect
 * this module performs is a write to the events table - see the containment note
 * in anthropic.mjs.
 *
 * WHY receivedAt IS THE ANCHOR, NOT SCAN TIME. Relative dates ("next Friday",
 * "week 5") are resolved by the model against the EMAIL's receipt time, which is
 * passed into the prompt explicitly, and the sanity bound below is measured from
 * the same instant. A newsletter first scanned three weeks late must still land on
 * the day it meant; anchoring on scan time would silently shift every relative
 * date in a backfill.
 *
 * WHY THE 400-DAY BOUND. The commonest extraction failure is not an invented
 * event, it is a right day with a wrong YEAR - an email in December mentioning
 * "5 February" resolved to the February just gone, or a stray "2062" from a typo.
 * Those rows are invisible to the user (the month view never navigates there) and
 * poison the "needs attention" list forever. So an event more than
 * MAX_HORIZON_DAYS after `receivedAt` is refused and recorded as a skip: the
 * parent noticing a missing event is recoverable, a confidently wrong date is not.
 * The bound is one-sided by design - a genuinely PAST event is kept, because a
 * late-scanned email legitimately describes last term, and its `ttl` will retire
 * it on its own.
 *
 * WHY eventId IS DERIVED FROM CONTENT.
 *   eventId = sha256(sourceMessageId + "|" + title.trim().toLowerCase() + "|" + startsAt)
 * The key is a function of the source message, the normalised title and the
 * NORMALISED start instant, so re-scanning the same email produces the same key
 * and the write is an overwrite instead of a duplicate. Normalising the title and
 * the instant before hashing is what makes that hold in practice: the model may
 * emit "2026-03-14" one run and "2026-03-14T00:00:00Z" the next, and an un-
 * normalised hash would treat them as two events. The three parts are joined with
 * "|" rather than concatenated so a title ending in a digit cannot collide with a
 * different title/date split.
 *
 * A RE-SCAN NO LONGER OVERWRITES `status` (TASK-009). BatchWriteItem still cannot
 * express a condition, so a bare re-extraction of an already-acknowledged event
 * WOULD rewrite the row with `status: "pending"` and re-add its `attentionKey`,
 * popping the event back into the "needs attention" list. TASK-007 recorded that
 * as a known hole; TASK-009 closes it by reading the rows' existing lifecycle
 * state before the batch write and carrying an `acknowledged`/`dismissed` status
 * forward - see `readLifecycleStates`, `applyPreservedLifecycle` and the long
 * rationale in the "READING AND CLEARING EVENTS" section header below, which also
 * states the cost and the one race that remains.
 *
 * THE SPARSE-GSI CONTRACT (from terraform/dynamodb_calendar_events.tf):
 * `attentionKey = "<userId>#pending"` is set ONLY when `needsAttention` is true
 * AND `status` is "pending". A GSI indexes an item only when the item carries BOTH
 * the index's hash key AND its range key, and AttentionIndex ranges on `dueBy` -
 * so an actionable event with no stated deadline would be silently absent from the
 * list it exists to appear in. `dueBy` therefore falls back to the event's own
 * start instant, which is the effective deadline for "attend this" or "pay before
 * the excursion". See `resolveDueBy`.
 *
 * TESTABILITY: `@aws-sdk/*` is imported LAZILY inside the one I/O function, and
 * every public function takes its dependencies as injectable parameters with real
 * defaults (`batchWrite`, `now`, `sleep`, `random`, `env`, `log`). The module
 * imports cleanly, and every branch is reachable, with the SDK absent, no AWS
 * credentials and no real timers.
 *
 * SECURITY: nothing here logs a title, a description, a subject or a sender. Log
 * lines carry message ids, event ids, counts and skip reasons only.
 */

import { createHash } from "node:crypto";

/** Environment variable naming the table (set by terraform/lambda_calendar.tf). */
export const EVENTS_TABLE_ENV = "CALENDAR_EVENTS_TABLE";

/** Fallback region when the Lambda runtime has not set AWS_REGION. */
const DEFAULT_REGION = "ap-southeast-2";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Sanity bound on how far after `receivedAt` an extracted event may fall. */
export const MAX_HORIZON_DAYS = 400;

/** How long after its start an event row lives before DynamoDB retires it. */
export const TTL_DAYS = 400;

/** DynamoDB's hard per-request cap on BatchWriteItem. Not a tuning knob. */
export const BATCH_WRITE_CHUNK_SIZE = 25;

/** Attempts per chunk, including the first, when items come back unprocessed. */
export const MAX_BATCH_ATTEMPTS = 4;

/** First backoff step for an unprocessed-items retry; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 100;

/** Ceiling on any single unprocessed-items wait. */
export const RETRY_MAX_DELAY_MS = 5000;

/** Lifecycle states, as documented in the table's terraform. */
export const EVENT_STATUS = Object.freeze({
  PENDING: "pending",
  ACKNOWLEDGED: "acknowledged",
  DISMISSED: "dismissed",
});

/** Suffix of the sparse GSI's hash key. */
export const ATTENTION_KEY_SUFFIX = "#pending";

/** Closed category list. Anything else is stored as `other`. */
export const EVENT_CATEGORIES = Object.freeze([
  "excursion",
  "sport",
  "payment",
  "assembly",
  "meeting",
  "performance",
  "holiday",
  "uniform",
  "deadline",
  "other",
]);

/** Fallback category for an unrecognised value. */
export const DEFAULT_CATEGORY = "other";

/** Why an extracted event was not stored. Callers report counts of these. */
export const SKIP_REASON = Object.freeze({
  /** No usable title: a row with no title is not renderable. */
  MISSING_TITLE: "missing_title",
  /** `startsAt` was absent or did not parse as a date. */
  UNPARSABLE_START: "unparsable_start",
  /** More than MAX_HORIZON_DAYS after `receivedAt` - almost always a wrong year. */
  OUT_OF_HORIZON: "out_of_horizon",
  /** Two events in the same batch derived the same eventId. */
  DUPLICATE: "duplicate",
});

/**
 * Length caps. DynamoDB's 400KB item limit is not the operative concern - the
 * renderer is: an unbounded model-authored `description` can carry an entire
 * quoted email thread, which costs storage on every scan and renders as a wall of
 * text. Values are truncated rather than rejected, because a long description is
 * still a valid event.
 */
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_LOCATION_LENGTH = 300;
export const MAX_ACTION_LENGTH = 300;
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_FROM_LENGTH = 320;

/**
 * Control characters, including DEL. Model-authored text can carry newlines and
 * stray control bytes that survive into the UI and mean nothing in a title or a
 * location; they are collapsed to spaces rather than rejected. Built from escapes
 * so the source file itself stays free of literal control bytes.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
let documentClientPromise = null;

/** Real timer. Injected as `sleep`, so tests never actually wait. */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a logger that honours CALENDAR_LOG_LEVEL from the given environment.
 * A factory, per request, exactly as in gmail.mjs and google-token.mjs.
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
 * Resolve the table name, or "" when unconfigured so callers can raise an error
 * naming the variable. Mirrors connections.mjs.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveTableName(env = process.env) {
  return (env?.[EVENTS_TABLE_ENV] || "").trim();
}

/**
 * Lazily construct (and cache per container) the DynamoDB document client.
 * Never called on an injected-dependency path.
 *
 * @returns {Promise<object>}
 */
export async function getDocumentClient() {
  if (!documentClientPromise) {
    documentClientPromise = (async () => {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      return DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
        }),
        // An optional field the caller left unset must not fail the whole write.
        { marshallOptions: { removeUndefinedValues: true } }
      );
    })();
  }
  return documentClientPromise;
}

/** Drop the cached document client (tests, credential changes). */
export function resetDocumentClient() {
  documentClientPromise = null;
}

/**
 * Trim and cap a model-authored string.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
export function cleanText(value, limit) {
  const text = String(value ?? "")
    // Collapse newlines and control characters: they survive into the UI and are
    // never meaningful in a title or a location.
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

/**
 * Map a model-supplied category onto the closed list.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseCategory(value) {
  const category = String(value ?? "")
    .trim()
    .toLowerCase();
  return EVENT_CATEGORIES.includes(category) ? category : DEFAULT_CATEGORY;
}

/**
 * Clamp confidence into 0..1.
 *
 * The zod schema deliberately types this as a plain number (bounds in a
 * structured-output schema risk a compilation 400 - see anthropic.mjs), so the
 * bound is enforced here. A non-numeric value reads as 0, i.e. "no confidence",
 * rather than being dropped: the event may still be real.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * Parse a model-supplied instant into a canonical ISO-8601 UTC string.
 *
 * Handles the three shapes the schema allows:
 *   - date-only ("2026-03-14"), which the prompt asks for when no time of day was
 *     stated: read as midnight UTC and reported as `dateOnly`;
 *   - a full timestamp with an offset ("2026-03-14T09:30:00+11:00");
 *   - a timestamp with NO offset ("2026-03-14T09:30:00"), which `Date.parse`
 *     would read in the container's local zone. That is UTC on Lambda but is not
 *     guaranteed to be, and a test machine's zone would shift the stored day. So a
 *     missing offset is made explicit as UTC here, which is also what the prompt
 *     tells the model to expect.
 *
 * The canonical output matters beyond tidiness: `startsAt` is the StartsAtIndex
 * range key, queried with BETWEEN on lexical strings, so a mixed set of formats
 * would break month queries; and it is hashed into `eventId`, so canonicalising is
 * what makes a re-scan idempotent.
 *
 * NOT a day validator. It normalises; it does not verify that the day exists.
 * `Date.parse` returns NaN only for an out-of-range MONTH - an out-of-range DAY
 * rolls over silently, so "2026-02-31" comes back as a valid 2026-03-03. Callers
 * that need to REFUSE an impossible day must compare the canonical `iso` back to
 * their input; `parseRangeBound` is the worked example. The store path deliberately
 * does not: a model-supplied date is being canonicalised for hashing and range
 * keying, where a rolled-over day is still a usable instant.
 *
 * @param {unknown} value
 * @returns {{ iso: string, epochMs: number, dateOnly: boolean }|null} null for
 *   anything unparseable - the caller records a skip.
 */
export function normaliseInstant(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  let candidate = raw;
  if (dateOnly) {
    candidate = `${raw}T00:00:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw) && !/(z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    candidate = `${raw.replace(" ", "T")}Z`;
  }

  const epochMs = Date.parse(candidate);
  if (Number.isNaN(epochMs)) return null;
  return { iso: new Date(epochMs).toISOString(), epochMs, dateOnly };
}

/**
 * The content-derived range key. See the module docblock for why it is derived
 * rather than generated, and why the parts are normalised before hashing.
 *
 * THE INPUTS ARE FIXED: sourceMessageId, title and startsAt, and nothing else.
 * `processingJobId` is deliberately NOT hashed in (TASK-056) - two processing
 * jobs that both match one email must derive the SAME id so the row collapses to
 * one, and every extra input to this hash is another way for the same event to
 * be stored twice, which is exactly the live bug the derived key was introduced
 * to fix.
 *
 * @param {object} args
 * @param {string} args.sourceMessageId
 * @param {string} args.title
 * @param {string} args.startsAt Canonical ISO from `normaliseInstant`.
 * @returns {string} sha256 hex.
 */
export function deriveEventId({ sourceMessageId, title, startsAt } = {}) {
  const parts = [String(sourceMessageId ?? ""), String(title ?? "").trim().toLowerCase(), String(startsAt ?? "")];
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

/**
 * The sparse GSI's hash key, or undefined when the item must stay out of the
 * index. `undefined` (not "") because DynamoDB rejects an empty string key, and
 * because the document client is configured to drop undefined attributes - so the
 * attribute is simply absent, which is exactly what "sparse" means.
 *
 * @param {string} userId
 * @param {{ needsAttention?: unknown, status?: string }} args
 * @returns {string|undefined}
 */
export function attentionKeyFor(userId, { needsAttention, status } = {}) {
  if (needsAttention !== true) return undefined;
  if (status !== EVENT_STATUS.PENDING) return undefined;
  return `${userId}${ATTENTION_KEY_SUFFIX}`;
}

/**
 * The AttentionIndex range key for an actionable event.
 *
 * Falls back to the event's own start instant when the email stated no deadline,
 * because an item missing the index's range key is not indexed at all - see the
 * sparse-GSI note in the module docblock. Returns undefined for an event that is
 * not going into the index, so no `dueBy` is invented for a purely informational
 * one.
 *
 * @param {object} args
 * @param {string|undefined} args.attentionKey
 * @param {string|null} args.dueBy Canonical ISO, or null.
 * @param {string} args.startsAt Canonical ISO.
 * @returns {string|undefined}
 */
export function resolveDueBy({ attentionKey, dueBy, startsAt } = {}) {
  if (dueBy) return dueBy;
  if (!attentionKey) return undefined;
  return startsAt;
}

/** `ttl` for a row: epoch SECONDS, TTL_DAYS after the event starts. */
export function computeTtl(startsAtEpochMs) {
  return Math.floor((startsAtEpochMs + TTL_DAYS * DAY_MS) / 1000);
}

/**
 * Turn one model event into a storable row, or explain why it cannot be one.
 *
 * ATTRIBUTION (TASK-056). `processingJobId` records WHICH processing job's search
 * turned this email up. It is the job's stable `id`, never its `name`, so
 * renaming a job later does not orphan its events. It is stamped on the row but
 * is deliberately NOT part of `deriveEventId`: the same email found by two jobs
 * must still collapse to ONE row, and changing what the hash is derived from
 * risks reopening the live duplication bug an earlier session fixed. A blank or
 * absent value leaves the attribute UNDEFINED (the document client is configured
 * with `removeUndefinedValues`, so it is simply absent) rather than "" or null.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {object} args.message The source message from gmail.mjs.
 * @param {object} args.event One entry from the model's `events` array.
 * @param {string|null} [args.processingJobId] The job whose search found this
 *   email (TASK-056).
 * @param {object} [options]
 * @param {() => number} [options.now] Epoch-ms clock; used for the audit stamps
 *   and as the horizon anchor of LAST resort (see below).
 * @returns {{ item: object|null, skipped: { reason: string, eventId: string|null }|null }}
 */
export function buildEventItem(
  { userId, message = {}, event = {}, processingJobId = null } = {},
  { now = () => Date.now() } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("buildEventItem: userId is required");

  const skip = (reason) => ({ item: null, skipped: { reason, eventId: null } });

  const title = cleanText(event.title, MAX_TITLE_LENGTH);
  if (!title) return skip(SKIP_REASON.MISSING_TITLE);

  const start = normaliseInstant(event.startsAt);
  if (!start) return skip(SKIP_REASON.UNPARSABLE_START);

  // The anchor is the EMAIL's receipt time. A message with no usable receivedAt
  // (rare, but Gmail's internalDate can be absent on an imported message) falls
  // back to scan time, which keeps the sanity bound in force rather than letting
  // an unbounded date through.
  const received = normaliseInstant(message.receivedAt);
  const anchorMs = received ? received.epochMs : now();
  if (start.epochMs - anchorMs > MAX_HORIZON_DAYS * DAY_MS) return skip(SKIP_REASON.OUT_OF_HORIZON);

  const end = normaliseInstant(event.endsAt);
  const due = normaliseInstant(event.dueBy);
  const nowIso = new Date(now()).toISOString();
  const status = EVENT_STATUS.PENDING;
  const needsAttention = event.needsAttention === true;
  const attentionKey = attentionKeyFor(userId, { needsAttention, status });
  const eventId = deriveEventId({ sourceMessageId: message.id, title, startsAt: start.iso });

  const item = {
    userId,
    eventId,
    title,
    description: cleanText(event.description, MAX_DESCRIPTION_LENGTH) || undefined,
    location: cleanText(event.location, MAX_LOCATION_LENGTH) || undefined,
    category: normaliseCategory(event.category),
    startsAt: start.iso,
    // An end before the start is the model mis-reading a range; drop it rather
    // than store a negative-length event the UI would render backwards.
    endsAt: end && end.epochMs >= start.epochMs ? end.iso : undefined,
    // A date-only start means no time of day was stated, whatever the model set.
    allDay: event.allDay === true || start.dateOnly,
    needsAttention,
    actionRequired: needsAttention ? cleanText(event.actionRequired, MAX_ACTION_LENGTH) || undefined : undefined,
    dueBy: resolveDueBy({ attentionKey, dueBy: due ? due.iso : null, startsAt: start.iso }),
    status,
    attentionKey,
    sourceMessageId: String(message.id ?? ""),
    sourceSubject: cleanText(message.subject, MAX_SUBJECT_LENGTH) || undefined,
    sourceFrom: cleanText(message.from, MAX_FROM_LENGTH) || undefined,
    sourceReceivedAt: received ? received.iso : undefined,
    // Absent rather than "" when unattributed - see the ATTRIBUTION note above.
    processingJobId: String(processingJobId ?? "").trim() || undefined,
    confidence: clampConfidence(event.confidence),
    createdAt: nowIso,
    updatedAt: nowIso,
    ttl: computeTtl(start.epochMs),
  };

  return { item, skipped: null };
}

/**
 * Normalise a whole extraction into rows.
 *
 * Accepts either shape the pipeline produces: `{ message, events }` for one
 * message, or `extractions: [{ message, event }, ...]` exactly as
 * `extractEvents` in anthropic.mjs returns them.
 *
 * DE-DUPLICATES BY KEY. BatchWriteItem rejects an entire request that contains
 * two writes to the same key ("Provided list of item keys contains duplicates"),
 * and a deterministic eventId makes that easy to hit: one newsletter that mentions
 * the same event twice, or two forwarded copies of one email, produce the same
 * key. The first occurrence wins and the rest are recorded as DUPLICATE skips, so
 * one repeated event cannot fail the batch it happens to share.
 *
 * Every row built here carries the same `processingJobId` (TASK-056): one call is
 * one job's extraction pass. A pair may override it (`pair.processingJobId`) for
 * a caller that mixes jobs in one batch, but the scan loop does not - it calls
 * once per job, which is what makes the attribution meaningful.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {object} [args.message] Source message, when passing `events`.
 * @param {object[]} [args.events] Model events belonging to `message`.
 * @param {Array<{ message: object, event: object, processingJobId?: string }>} [args.extractions]
 * @param {string|null} [args.processingJobId] The job that found these emails.
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @returns {{ items: object[], skipped: Array<{ messageId: string, reason: string }>, counts: Record<string, number> }}
 */
export function buildEventItems(
  { userId, message = null, events = null, extractions = null, processingJobId = null } = {},
  { now = () => Date.now() } = {}
) {
  const pairs = Array.isArray(extractions)
    ? extractions.filter((pair) => pair && typeof pair === "object")
    : (Array.isArray(events) ? events : []).map((event) => ({ message: message || {}, event }));

  const items = [];
  const skipped = [];
  const counts = {};
  const seen = new Set();

  const record = (messageId, reason) => {
    skipped.push({ messageId, reason });
    counts[reason] = (counts[reason] || 0) + 1;
  };

  for (const pair of pairs) {
    const source = pair.message || message || {};
    const messageId = String(source.id ?? "");
    const built = buildEventItem(
      {
        userId,
        message: source,
        event: pair.event || {},
        processingJobId: pair.processingJobId ?? processingJobId,
      },
      { now }
    );
    if (!built.item) {
      record(messageId, built.skipped.reason);
      continue;
    }
    if (seen.has(built.item.eventId)) {
      record(messageId, SKIP_REASON.DUPLICATE);
      continue;
    }
    seen.add(built.item.eventId);
    items.push(built.item);
  }

  return { items, skipped, counts };
}

/**
 * Split a list into DynamoDB-sized chunks.
 *
 * @param {object[]} items
 * @param {number} [size]
 * @returns {object[][]}
 */
export function chunkItems(items, size = BATCH_WRITE_CHUNK_SIZE) {
  const limit = Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), BATCH_WRITE_CHUNK_SIZE) : BATCH_WRITE_CHUNK_SIZE;
  const chunks = [];
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i += limit) chunks.push(list.slice(i, i + limit));
  return chunks;
}

/**
 * Backoff for an unprocessed-items retry: exponential with equal jitter, matching
 * gmail.mjs. `random` is injected so the schedule is assertable and the retry
 * tests are deterministic.
 *
 * @param {object} args
 * @param {number} args.attempt 1-based.
 * @param {number} [args.baseDelayMs]
 * @param {number} [args.maxDelayMs]
 * @param {() => number} [args.random]
 * @returns {number}
 */
export function backoffDelayMs({
  attempt,
  baseDelayMs = RETRY_BASE_DELAY_MS,
  maxDelayMs = RETRY_MAX_DELAY_MS,
  random = Math.random,
} = {}) {
  const step = Math.max(1, Number.isFinite(attempt) ? attempt : 1);
  const exponential = Math.min(baseDelayMs * 2 ** (step - 1), maxDelayMs);
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

/**
 * Real DynamoDB BatchWriteItem for one chunk. Default `batchWrite` dependency.
 *
 * Returns the items DynamoDB did NOT write, already unwrapped from the
 * `UnprocessedItems` envelope, so the retry loop above it never has to know the
 * request shape. UnprocessedItems is NOT an error: it is how DynamoDB reports
 * partial throttling, and ignoring it silently loses events.
 *
 * @param {{ tableName: string, items: object[] }} args
 * @returns {Promise<{ unprocessed: object[] }>}
 */
export async function ddbBatchWrite({ tableName, items }) {
  const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(
    new BatchWriteCommand({
      RequestItems: { [tableName]: items.map((item) => ({ PutRequest: { Item: item } })) },
    })
  );
  const remaining = result?.UnprocessedItems?.[tableName] || [];
  return { unprocessed: remaining.map((request) => request?.PutRequest?.Item).filter(Boolean) };
}

/**
 * Write rows in chunks of BATCH_WRITE_CHUNK_SIZE, retrying UnprocessedItems.
 *
 * Every wait goes through the INJECTED `sleep` and jitters through the INJECTED
 * `random`, so a test drives every retry instantly and deterministically.
 *
 * Items still unprocessed after MAX_BATCH_ATTEMPTS are RETURNED rather than
 * thrown: the rest of the scan's events are already stored, the caller can report
 * a partial write, and the next scan re-derives the same keys and re-writes them.
 *
 * @param {object} args
 * @param {object[]} args.items
 * @param {string} [args.tableName] Defaults to the configured table.
 * @param {object} [deps]
 * @param {(args: { tableName: string, items: object[] }) => Promise<{ unprocessed: object[] }>} [deps.batchWrite]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random]
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.baseDelayMs]
 * @param {number} [deps.maxDelayMs]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ written: number, unprocessed: object[], requests: number }>}
 */
export async function putEvents(
  { items, tableName = null } = {},
  {
    batchWrite = ddbBatchWrite,
    sleep = defaultSleep,
    random = Math.random,
    maxAttempts = MAX_BATCH_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    env = process.env,
    log = null,
  } = {}
) {
  const logLine = typeof log === "function" ? log : makeLogger(env);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return { written: 0, unprocessed: [], requests: 0 };

  const table = (typeof tableName === "string" && tableName.trim()) || resolveTableName(env);
  if (!table) throw new Error(`putEvents: ${EVENTS_TABLE_ENV} is not configured`);

  let written = 0;
  let requests = 0;
  const leftOver = [];

  for (const chunk of chunkItems(list)) {
    let pending = chunk;
    let attempt = 0;

    while (pending.length > 0 && attempt < maxAttempts) {
      attempt += 1;
      requests += 1;
      const result = await batchWrite({ tableName: table, items: pending });
      const unprocessed = Array.isArray(result?.unprocessed) ? result.unprocessed.filter(Boolean) : [];
      written += pending.length - unprocessed.length;

      if (unprocessed.length === 0) break;
      if (attempt >= maxAttempts) {
        pending = unprocessed;
        break;
      }
      const delayMs = backoffDelayMs({ attempt, baseDelayMs, maxDelayMs, random });
      logLine("calendar.events.unprocessed_retry", { count: unprocessed.length, attempt, delayMs });
      await sleep(delayMs);
      pending = unprocessed;
    }

    if (pending.length > 0 && attempt >= maxAttempts) leftOver.push(...pending);
  }

  if (leftOver.length > 0) {
    logLine("calendar.events.write_incomplete", { unprocessed: leftOver.length, attempts: maxAttempts });
  }

  return { written, unprocessed: leftOver, requests };
}

/**
 * Normalise an extraction and store what survives.
 *
 * The one function TASK-008's scan loop needs: hand it the userId and either one
 * message's events or the `events` array from `extractEvents`, and it reports what
 * was written and what was refused, with reasons. Skips are DATA, not errors - a
 * scan that dropped four wrong-year events did its job.
 *
 * PRESERVES THE USER'S DECISIONS (TASK-009). Before writing, the rows about to be
 * overwritten are read back by key and any `acknowledged`/`dismissed` status is
 * carried forward, so a re-scan of an already-handled email does not resurrect it
 * into the "needs attention" list. `BatchWriteItem` cannot express a condition,
 * which is why this is a pre-read rather than a conditional write - the full
 * rationale, the cost and the one remaining race are in the READING AND CLEARING
 * EVENTS section header. The pre-read FAILS SOFT: if it throws, the write still
 * happens and the failure is logged, because losing a brand-new event is worse
 * than resurrecting a handled one. Pass `preserveHandled: false` to skip it
 * entirely (a first-ever scan of a mailbox has nothing to preserve).
 *
 * ATTRIBUTES TO A PROCESSING JOB (TASK-056). `processingJobId` is stamped on every
 * row this call writes, and `applyPreservedLifecycle` keeps the FIRST job that
 * ever wrote a given `eventId` on later rescans - so an email two jobs both match
 * is stored once, attributed to whichever job saw it first, whatever order the
 * jobs run in afterwards.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {object} [args.message]
 * @param {object[]} [args.events]
 * @param {Array<{ message: object, event: object }>} [args.extractions]
 * @param {string|null} [args.processingJobId] The job that found these emails.
 * @param {string} [args.tableName]
 * @param {object} [deps] `batchWrite`, `batchGet`, `preserveHandled`, `now`,
 *   `sleep`, `random`, `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `env`, `log`.
 * @returns {Promise<{ written: number, items: object[], preserved: number, skipped: Array<{ messageId: string, reason: string }>, counts: Record<string, number>, unprocessed: object[], requests: number }>}
 */
export async function storeEvents(
  { userId, message = null, events = null, extractions = null, processingJobId = null, tableName = null } = {},
  deps = {}
) {
  const {
    now = () => Date.now(),
    env = process.env,
    log = null,
    batchGet = ddbBatchGet,
    preserveHandled = true,
    ...writeDeps
  } = deps;
  const logLine = typeof log === "function" ? log : makeLogger(env);

  const built = buildEventItems({ userId, message, events, extractions, processingJobId }, { now });
  const { skipped, counts } = built;
  let items = built.items;
  let preserved = 0;

  if (preserveHandled && items.length > 0) {
    try {
      const table = (typeof tableName === "string" && tableName.trim()) || resolveTableName(env);
      if (!table) throw new Error(`storeEvents: ${EVENTS_TABLE_ENV} is not configured`);
      const states = await readLifecycleStates(
        { items, tableName: table },
        {
          batchGet,
          sleep: writeDeps.sleep,
          random: writeDeps.random,
          maxAttempts: writeDeps.maxAttempts,
          baseDelayMs: writeDeps.baseDelayMs,
          maxDelayMs: writeDeps.maxDelayMs,
          env,
          log: logLine,
        }
      );
      if (states.size > 0) {
        items = items.map((item) => {
          const merged = applyPreservedLifecycle(item, states.get(item.eventId));
          // `preserved` counts HANDLED events carried forward, and only those:
          // since TASK-056 the merge also carries `processingJobId`/`createdAt`
          // on a still-pending row (first-seen-wins attribution), which changes
          // the reference without the user having handled anything. Counting by
          // identity alone would inflate this number on every rescan and make
          // "how many acknowledgements did this scan protect" meaningless.
          if (
            merged !== item &&
            (merged.status === EVENT_STATUS.ACKNOWLEDGED || merged.status === EVENT_STATUS.DISMISSED)
          ) {
            preserved += 1;
          }
          return merged;
        });
      }
    } catch (err) {
      // Names and types only, never a title or a subject.
      logLine("calendar.events.lifecycle_read_failed", {
        userId,
        candidates: items.length,
        errorName: err?.name || "Error",
        errorMessage: err?.message || "unknown error",
      });
    }
  }

  const result = await putEvents({ items, tableName }, { ...writeDeps, env, log: logLine });

  logLine("calendar.events.stored", {
    userId,
    candidates: items.length + skipped.length,
    written: result.written,
    preserved,
    skipped: skipped.length,
    unprocessed: result.unprocessed.length,
    counts,
  });

  return { ...result, items, preserved, skipped, counts };
}

/* ===========================================================================
 * READING AND CLEARING EVENTS (TASK-009)
 * ---------------------------------------------------------------------------
 * The write half above turns model output into rows. This half is everything the
 * browser needs: the month view, the "needs attention" list, and the three
 * mutations that clear an item.
 *
 * TENANCY IS THE PARTITION KEY, NOT A FILTER. Every read below is a Query whose
 * hash key is derived from the VERIFIED SESSION's userId - `userId` for
 * StartsAtIndex, `"<userId>#pending"` for AttentionIndex. There is no `Scan` in
 * this module and no post-read filter on `userId`: a broad read plus an
 * application-code filter is one forgotten branch away from cross-tenant
 * disclosure, whereas a Query on the wrong partition returns nothing. For the
 * same reason no function here accepts a userId that did not come from the route
 * layer's `resolveSession`.
 *
 * EVERY MUTATION IS CONDITIONAL. `buildEventUpdateParams` always emits
 * `attribute_exists(#userId) AND #userId = :userId`, so a guessed or leaked
 * `eventId` from another account cannot be written. A condition failure surfaces
 * as `EventNotFoundError` -> HTTP 404, never 403: a 403 would confirm that
 * someone else's event exists, which is exactly the fact being protected.
 *
 * THE RESPONSE PROJECTION IS AN ALLOW-LIST. `toEventJson` names the seventeen
 * fields the UI renders and copies nothing else, so `sourceMessageId` (a Gmail
 * handle with no purpose in a browser), `attentionKey`, `ttl` and anything a
 * later ticket adds to the row are absent BY CONSTRUCTION rather than by
 * remembering to delete them. Route handlers never see a raw item.
 *
 * ---------------------------------------------------------------------------
 * HOW THE RE-SCAN/ACKNOWLEDGE COLLISION IS RESOLVED (the TASK-007 WARNING).
 *
 * TASK-007 left a documented hole: `BatchWriteItem` carries no condition, so a
 * re-scan of an already-acknowledged email rewrote the row with
 * `status: "pending"` and re-added its `attentionKey`, popping the event back
 * into the attention list. Of the two options the ticket offered, this build
 * takes the FIRST: read the existing lifecycle state before writing and carry it
 * forward.
 *
 * `storeEvents` now BatchGetItems the exact keys it is about to write (a
 * key-scoped read, never a Scan, projected down to the lifecycle attributes
 * only) and `applyPreservedLifecycle` merges an existing `acknowledged`/
 * `dismissed` state onto the freshly built row. Because `attentionKey` is only
 * ever set for a PENDING row, preserving the status also keeps the row out of
 * AttentionIndex - the sparse index stays the single source of truth for "needs
 * attention" and nothing has to be filtered out of the query afterwards.
 *
 * Why not the second option (a marker item a re-scan cannot touch): a marker
 * outside the row cannot suppress the row's own `attentionKey`, so the
 * acknowledged event would still be IN AttentionIndex and the upcoming list
 * would have to read every marker and subtract it in application code - a broad
 * read plus a filter, which is the pattern this module exists to avoid.
 *
 * The costs, stated plainly rather than hidden:
 *   - one BatchGetItem per 100 candidate rows per scan (needs
 *     `dynamodb:BatchGetItem`, granted in terraform/lambda_calendar.tf);
 *   - a race with a concurrent acknowledge. An acknowledge landing between the
 *     pre-read and the BatchWriteItem is lost and the event reappears once. The
 *     window is milliseconds, scan-vs-scan is already excluded by the per-user
 *     scan lock in connections.mjs, and the user's remedy - acknowledge again -
 *     is the same click they just made.
 *   - the pre-read FAILS SOFT: if it throws, the write still proceeds and the
 *     failure is logged as `calendar.events.lifecycle_read_failed`. Deferring
 *     the write instead would protect an acknowledgement at the cost of silently
 *     dropping brand-new events from the same email, which is the worse of the
 *     two - a resurrected acknowledgement is a click, a missing excursion is a
 *     missed excursion.
 * =========================================================================== */

/** GSI backing the month view (hash `userId`, range `startsAt`). */
export const STARTS_AT_INDEX = "StartsAtIndex";

/** Sparse GSI backing the attention list (hash `attentionKey`, range `dueBy`). */
export const ATTENTION_INDEX = "AttentionIndex";

/** Widest range the month/quarter view may ask for, in inclusive days. */
export const MAX_RANGE_DAYS = 93;

/** Hard cap on items returned by one range query, after which `truncated` is set. */
export const MAX_RANGE_ITEMS = 500;

/**
 * Ceiling on LastEvaluatedKey follows for one logical query. Paging exists so a
 * busy month is not silently truncated; this bound exists so a pathological
 * partition cannot spin a Lambda until its timeout.
 */
export const MAX_QUERY_PAGES = 20;

/** Default and maximum `limit` for the attention list. */
export const DEFAULT_UPCOMING_LIMIT = 20;
export const MAX_UPCOMING_LIMIT = 100;

/** DynamoDB's hard per-request cap on BatchGetItem keys. Not a tuning knob. */
export const BATCH_GET_CHUNK_SIZE = 100;

/**
 * `eventId` is a sha256 hex digest (see `deriveEventId`), so 64 LOWERCASE hex
 * characters and nothing else. Anchored, with no `i` flag and no whitespace
 * tolerance: the value arrives from a URL path, and a permissive pattern here is
 * what turns a path segment into a DynamoDB key the caller partly controls.
 */
export const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;

/** `from`/`to` query parameters are calendar dates, not timestamps. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Row attributes the re-scan pre-read fetches. Deliberately narrow: the write
 * path only needs to know whether the user has already handled this event and
 * who saw it first, so projecting the whole row would pull titles and
 * descriptions through a code path that has no use for them.
 *
 * `processingJobId` is here for first-seen-wins attribution (TASK-056): without
 * it the pre-read cannot tell `applyPreservedLifecycle` which job stored the row
 * originally, and a rescan by a second job would silently take the attribution.
 */
export const LIFECYCLE_ATTRIBUTES = Object.freeze([
  "userId",
  "eventId",
  "status",
  "acknowledgedAt",
  "dismissedAt",
  "dueBy",
  "createdAt",
  "processingJobId",
]);

/**
 * The exact fields a response may carry. `sourceMessageId` is absent on purpose -
 * the UI shows provenance with the subject and sender, and the Gmail handle would
 * be a live API identifier sitting in a browser.
 *
 * `processingJobId` IS public (TASK-056): the calendar and attention views filter
 * by processing job, and the id is an opaque handle to a job the same user
 * configured - it discloses nothing they did not type themselves. The job's
 * `name` stays out; the browser already has it from the settings endpoint.
 */
export const PUBLIC_EVENT_FIELDS = Object.freeze([
  "eventId",
  "title",
  "description",
  "startsAt",
  "endsAt",
  "allDay",
  "location",
  "category",
  "needsAttention",
  "actionRequired",
  "dueBy",
  "status",
  "confidence",
  "sourceSubject",
  "sourceFrom",
  "sourceReceivedAt",
  "processingJobId",
]);

/**
 * A caller-supplied value this module refuses. The message is client-safe by
 * construction: it names the offending field and never echoes an unbounded value,
 * so the route layer can return it as a 400 body (same contract as
 * SettingsValidationError in settings.mjs).
 */
export class EventValidationError extends Error {
  /**
   * @param {string} message
   * @param {string|null} [field]
   */
  constructor(message, field = null) {
    super(message);
    this.name = "EventValidationError";
    this.field = field;
  }
}

/**
 * The addressed event is not this user's, or does not exist. Deliberately ONE
 * error for both cases - the route maps it to 404, so a caller probing another
 * account's eventId learns nothing from the status code.
 */
export class EventNotFoundError extends Error {
  /** @param {string} [message] */
  constructor(message = "Event not found") {
    super(message);
    this.name = "EventNotFoundError";
  }
}

/**
 * Is this string a well-formed eventId?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEventId(value) {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

/**
 * Validate a path-supplied eventId, or refuse it.
 *
 * Called BEFORE any table name is resolved and any client is constructed, so a
 * malformed id never reaches DynamoDB at all.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {EventValidationError}
 */
export function requireEventId(value) {
  if (!isEventId(value)) {
    // Never echo the offending value: it is attacker-controlled path text.
    throw new EventValidationError("eventId must be 64 lowercase hexadecimal characters", "eventId");
  }
  return value;
}

/** Epoch-ms -> "YYYY-MM-DD" in UTC. */
function toDateOnly(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * First and last day of the UTC month containing `nowMs`.
 *
 * UTC, not a local zone: `startsAt` is stored as canonical UTC and the range
 * query compares strings, so resolving "this month" in the container's zone would
 * shift the boundary by hours and drop or add an event at each edge.
 *
 * @param {number} nowMs
 * @returns {{ from: string, to: string }}
 */
export function currentMonthRange(nowMs) {
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return {
    from: toDateOnly(Date.UTC(year, month, 1)),
    // Day 0 of the next month is the last day of this one, leap years included.
    to: toDateOnly(Date.UTC(year, month + 1, 0)),
  };
}

/**
 * First and last day of the month containing a "YYYY-MM-DD" date.
 *
 * @param {string} dateOnly
 * @returns {{ from: string, to: string }}
 */
export function monthRangeFor(dateOnly) {
  return currentMonthRange(Date.parse(`${dateOnly}T00:00:00.000Z`));
}

/**
 * Parse one `from`/`to` bound.
 *
 * Strict "YYYY-MM-DD", and strict about the DAY as well as the shape.
 *
 * Two guards, because neither alone is sufficient:
 *   - the pattern rejects anything that is not four-two-two digits;
 *   - the ROUND TRIP rejects a well-shaped day that does not exist. Parsing alone
 *     does not: `Date.parse("2026-02-31T00:00:00.000Z")` is NOT NaN, it silently
 *     rolls over to 2026-03-03, and "2026-04-31" rolls to 2026-05-01. Only an
 *     out-of-range MONTH ("2026-13-01") actually yields NaN. So the parsed instant
 *     is re-rendered as a date and compared back to the input: a day that rolled
 *     over comes back as a different string and is refused.
 *
 * Silently rolling over would be worse than a 400 twice over: the rolled instant
 * would ship as a DynamoDB BETWEEN key bound for a day that does not exist, and
 * with only `from` supplied the filled `to` would come from the NEXT month while
 * the echoed `from` still read the old one, so the reported range and the span
 * arithmetic would disagree with each other.
 *
 * @param {unknown} value
 * @param {string} field Named in the error so the UI can point at the input.
 * @returns {string}
 * @throws {EventValidationError}
 */
export function parseRangeBound(value, field) {
  const raw = String(value ?? "").trim();
  const parsed = DATE_ONLY_PATTERN.test(raw) ? normaliseInstant(raw) : null;
  // `parsed &&` is not enough on its own - see the docblock. The canonical date
  // must render back to exactly what was asked for.
  if (!parsed || parsed.iso.slice(0, 10) !== raw) {
    throw new EventValidationError(`${field} must be a calendar date in YYYY-MM-DD form`, field);
  }
  return raw;
}

/**
 * Turn the two optional query parameters into a validated, bounded range.
 *
 * Rules, and why each one is a 400 rather than a silent correction:
 *   - both omitted -> the current calendar month, which is what the month view
 *     opens on;
 *   - exactly one supplied -> the OTHER bound is filled from the supplied one's
 *     own month, so a half-specified request is always a valid month-sized range
 *     instead of a confusing "from is after to" against today's date;
 *   - unparseable bound -> 400. Coercing junk to today would render a month the
 *     user did not ask for and look like data loss;
 *   - `from` after `to` -> 400. A BETWEEN with reversed bounds returns nothing at
 *     all, which is indistinguishable from an empty month;
 *   - wider than MAX_RANGE_DAYS -> 400. The bound is what keeps one request's
 *     cost bounded; a year-wide query is a paging loop, not a calendar view.
 *
 * The returned `fromIso`/`toIso` bracket whole days - the `to` bound is the last
 * millisecond of its day - because `startsAt` carries a time of day and a BETWEEN
 * ending at midnight would drop everything happening on the final day.
 *
 * @param {{ from?: unknown, to?: unknown }} args
 * @param {{ now?: () => number }} [options]
 * @returns {{ from: string, to: string, fromIso: string, toIso: string, spanDays: number }}
 * @throws {EventValidationError}
 */
export function resolveRange({ from = null, to = null } = {}, { now = () => Date.now() } = {}) {
  const supplied = (value) => value !== null && value !== undefined && String(value).trim() !== "";
  const hasFrom = supplied(from);
  const hasTo = supplied(to);

  let fromDate;
  let toDate;
  if (!hasFrom && !hasTo) {
    ({ from: fromDate, to: toDate } = currentMonthRange(now()));
  } else if (hasFrom && !hasTo) {
    fromDate = parseRangeBound(from, "from");
    toDate = monthRangeFor(fromDate).to;
  } else if (!hasFrom && hasTo) {
    toDate = parseRangeBound(to, "to");
    fromDate = monthRangeFor(toDate).from;
  } else {
    fromDate = parseRangeBound(from, "from");
    toDate = parseRangeBound(to, "to");
  }

  const fromMs = Date.parse(`${fromDate}T00:00:00.000Z`);
  const toMs = Date.parse(`${toDate}T00:00:00.000Z`);
  if (fromMs > toMs) {
    throw new EventValidationError("from must not be later than to", "from");
  }

  const spanDays = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new EventValidationError(`the range must not span more than ${MAX_RANGE_DAYS} days`, "to");
  }

  return {
    from: fromDate,
    to: toDate,
    fromIso: `${fromDate}T00:00:00.000Z`,
    toIso: `${toDate}T23:59:59.999Z`,
    spanDays,
  };
}

/**
 * Clamp a caller-supplied `limit` for the attention list.
 *
 * Anything unusable (absent, non-numeric, zero, negative) reads as "use the
 * default" rather than a 400: `limit` is a page size, not data, and refusing the
 * whole request over it would be a worse answer than the sensible one. Above the
 * maximum it is clamped, never honoured - the cap is a cost bound.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampUpcomingLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_UPCOMING_LIMIT;
  const floored = Math.floor(number);
  if (floored < 1) return DEFAULT_UPCOMING_LIMIT;
  return Math.min(floored, MAX_UPCOMING_LIMIT);
}

/**
 * The sparse GSI's hash key for a user's pending, actionable events.
 *
 * Built from the SESSION's userId by the caller - never from anything a request
 * body or query string supplied.
 *
 * @param {string} userId
 * @returns {string}
 */
export function attentionKeyForUser(userId) {
  if (typeof userId !== "string" || !userId) throw new Error("attentionKeyForUser: userId is required");
  return `${userId}${ATTENTION_KEY_SUFFIX}`;
}

/**
 * Project a stored row onto the response shape.
 *
 * An ALLOW-LIST, field by field, so nothing new on the row can leak by default.
 * Absent optional attributes become `null` rather than being omitted, so the UI
 * can render one stable shape instead of testing for each key.
 *
 * @param {object|null} item
 * @returns {object|null}
 */
export function toEventJson(item) {
  if (!item || typeof item !== "object") return null;
  return {
    eventId: item.eventId ?? null,
    title: item.title ?? null,
    description: item.description ?? null,
    startsAt: item.startsAt ?? null,
    endsAt: item.endsAt ?? null,
    allDay: item.allDay === true,
    location: item.location ?? null,
    category: item.category ?? DEFAULT_CATEGORY,
    needsAttention: item.needsAttention === true,
    actionRequired: item.actionRequired ?? null,
    dueBy: item.dueBy ?? null,
    status: item.status ?? EVENT_STATUS.PENDING,
    confidence: clampConfidence(item.confidence),
    sourceSubject: item.sourceSubject ?? null,
    sourceFrom: item.sourceFrom ?? null,
    sourceReceivedAt: item.sourceReceivedAt ?? null,
    // Which processing job's search found this email (TASK-056). Null for a row
    // stored before jobs existed, and it can name a job the user has since
    // deleted - nothing rewrites stored rows when a job goes away, so the UI
    // must treat an unknown id as "no filter matches", not as an error.
    processingJobId: item.processingJobId ?? null,
  };
}

/**
 * Has this item's deadline passed?
 *
 * Computed at read time against the caller's clock rather than stored, because a
 * stored flag would be wrong the moment the deadline passed with nobody writing.
 *
 * @param {object} item
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isOverdue(item, nowMs) {
  const due = normaliseInstant(item?.dueBy);
  if (!due) return false;
  return due.epochMs < nowMs;
}

/**
 * Project a row for the attention list: the public shape plus `overdue`.
 *
 * @param {object|null} item
 * @param {number} nowMs
 * @returns {object|null}
 */
export function toUpcomingJson(item, nowMs) {
  const projected = toEventJson(item);
  if (!projected) return null;
  return { ...projected, overdue: isOverdue(item, nowMs) };
}

/**
 * Query parameters for the month view. Pure and exported so the index name, the
 * hash key and the BETWEEN condition are assertable with the SDK absent.
 *
 * `#userId`/`#startsAt` go through placeholders for the same reason
 * `buildUpdateParams` does it in connections.mjs - several attribute names in this
 * schema are DynamoDB reserved words, and a placeholder is never wrong.
 *
 * @param {object} args
 * @param {string} args.tableName
 * @param {string} args.userId Session-derived. Never request-supplied.
 * @param {string} args.fromIso
 * @param {string} args.toIso
 * @param {number} [args.limit]
 * @param {object|null} [args.exclusiveStartKey]
 * @returns {object} QueryCommand input.
 */
export function buildRangeQueryParams({ tableName, userId, fromIso, toIso, limit = null, exclusiveStartKey = null }) {
  const params = {
    TableName: tableName,
    IndexName: STARTS_AT_INDEX,
    KeyConditionExpression: "#userId = :userId AND #startsAt BETWEEN :from AND :to",
    ExpressionAttributeNames: { "#userId": "userId", "#startsAt": "startsAt" },
    ExpressionAttributeValues: { ":userId": userId, ":from": fromIso, ":to": toIso },
    // Chronological, so the month view renders in order without a client sort.
    ScanIndexForward: true,
  };
  if (Number.isFinite(limit) && limit > 0) params.Limit = Math.floor(limit);
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;
  return params;
}

/**
 * Query parameters for the attention list.
 *
 * No FilterExpression on `status`: the index is SPARSE, so acknowledged and
 * dismissed events are absent by construction (their `attentionKey` was removed).
 * `ScanIndexForward: true` orders by the range key `dueBy` ascending - soonest
 * deadline first, which is the only useful order for a list of things to do.
 *
 * @param {object} args
 * @param {string} args.tableName
 * @param {string} args.attentionKey
 * @param {number} [args.limit]
 * @param {object|null} [args.exclusiveStartKey]
 * @returns {object} QueryCommand input.
 */
export function buildAttentionQueryParams({ tableName, attentionKey, limit = null, exclusiveStartKey = null }) {
  const params = {
    TableName: tableName,
    IndexName: ATTENTION_INDEX,
    KeyConditionExpression: "#attentionKey = :attentionKey",
    ExpressionAttributeNames: { "#attentionKey": "attentionKey" },
    ExpressionAttributeValues: { ":attentionKey": attentionKey },
    ScanIndexForward: true,
  };
  if (Number.isFinite(limit) && limit > 0) params.Limit = Math.floor(limit);
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;
  return params;
}

/**
 * Real DynamoDB Query. Default `query` dependency for both read paths.
 *
 * Takes the whole QueryCommand input rather than named arguments, so the pure
 * builders above are exactly what production sends and a test can assert on the
 * same object the SDK would receive.
 *
 * @param {object} params QueryCommand input.
 * @returns {Promise<{ items: object[], lastEvaluatedKey: object|null }>}
 */
export async function ddbQuery(params) {
  const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new QueryCommand(params));
  return { items: result?.Items || [], lastEvaluatedKey: result?.LastEvaluatedKey || null };
}

/** Resolve the table name for a read/mutate call, or throw naming the variable. */
function requireTable(tableName, env, caller) {
  const table = (typeof tableName === "string" && tableName.trim()) || resolveTableName(env);
  if (!table) throw new Error(`${caller}: ${EVENTS_TABLE_ENV} is not configured`);
  return table;
}

/**
 * The month (or quarter) view: every event of this user starting inside a range.
 *
 * FOLLOWS LastEvaluatedKey. DynamoDB pages at 1MB regardless of `Limit`, so a
 * busy month genuinely arrives in several pages; stopping at the first would
 * silently hide the rest of the month, which looks exactly like the scanner
 * having missed those emails. Paging stops at `maxItems` (reported as
 * `truncated: true`, never as a short honest-looking answer) and at
 * `MAX_QUERY_PAGES`.
 *
 * @param {object} args
 * @param {string} args.userId Session-derived.
 * @param {string|null} [args.from] "YYYY-MM-DD"
 * @param {string|null} [args.to] "YYYY-MM-DD"
 * @param {string|null} [args.tableName]
 * @param {object} [deps]
 * @param {(params: object) => Promise<{ items: object[], lastEvaluatedKey: object|null }>} [deps.query]
 * @param {() => number} [deps.now]
 * @param {number} [deps.maxItems]
 * @param {number} [deps.maxPages]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ from: string, to: string, count: number, truncated: boolean, pages: number, events: object[] }>}
 * @throws {EventValidationError} for an unusable range.
 */
export async function queryEventsInRange(
  { userId, from = null, to = null, tableName = null } = {},
  {
    query = ddbQuery,
    now = () => Date.now(),
    maxItems = MAX_RANGE_ITEMS,
    maxPages = MAX_QUERY_PAGES,
    env = process.env,
    log = null,
  } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("queryEventsInRange: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);

  // Range validation FIRST: a bad range must be a 400 without a table lookup or
  // a single DynamoDB call.
  const range = resolveRange({ from, to }, { now });
  const table = requireTable(tableName, env, "queryEventsInRange");

  const cap = Math.max(1, Math.min(Math.floor(Number(maxItems)) || MAX_RANGE_ITEMS, MAX_RANGE_ITEMS));
  const pageCap = Math.max(1, Math.floor(Number(maxPages)) || MAX_QUERY_PAGES);

  const items = [];
  let exclusiveStartKey = null;
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages += 1;
    // One more than we are allowed to keep, so "there is more" is a fact we
    // observed rather than an inference from a full page.
    const page = await query(
      buildRangeQueryParams({
        tableName: table,
        userId,
        fromIso: range.fromIso,
        toIso: range.toIso,
        limit: cap - items.length + 1,
        exclusiveStartKey,
      })
    );
    for (const item of page?.items || []) items.push(item);

    if (items.length > cap) {
      items.length = cap;
      truncated = true;
      break;
    }
    exclusiveStartKey = page?.lastEvaluatedKey || null;
    if (!exclusiveStartKey) break;
    if (pages >= pageCap) {
      truncated = true;
      break;
    }
  }

  logLine("calendar.events.range_query", {
    userId,
    from: range.from,
    to: range.to,
    count: items.length,
    pages,
    truncated,
  });

  return {
    from: range.from,
    to: range.to,
    count: items.length,
    truncated,
    pages,
    events: items.map(toEventJson),
  };
}

/**
 * The "needs attention" list: pending, actionable events, soonest deadline first.
 *
 * @param {object} args
 * @param {string} args.userId Session-derived.
 * @param {unknown} [args.limit] Clamped by `clampUpcomingLimit`.
 * @param {string|null} [args.tableName]
 * @param {object} [deps] `query`, `now`, `maxPages`, `env`, `log`.
 * @returns {Promise<{ limit: number, count: number, truncated: boolean, pages: number, events: object[] }>}
 */
export async function queryUpcomingEvents(
  { userId, limit = null, tableName = null } = {},
  { query = ddbQuery, now = () => Date.now(), maxPages = MAX_QUERY_PAGES, env = process.env, log = null } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("queryUpcomingEvents: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);
  const table = requireTable(tableName, env, "queryUpcomingEvents");

  const cap = clampUpcomingLimit(limit);
  const pageCap = Math.max(1, Math.floor(Number(maxPages)) || MAX_QUERY_PAGES);
  const attentionKey = attentionKeyForUser(userId);

  const items = [];
  let exclusiveStartKey = null;
  let pages = 0;
  let truncated = false;

  for (;;) {
    pages += 1;
    const page = await query(
      buildAttentionQueryParams({
        tableName: table,
        attentionKey,
        limit: cap - items.length,
        exclusiveStartKey,
      })
    );
    for (const item of page?.items || []) items.push(item);
    exclusiveStartKey = page?.lastEvaluatedKey || null;

    if (items.length >= cap) {
      items.length = cap;
      truncated = Boolean(exclusiveStartKey);
      break;
    }
    if (!exclusiveStartKey) break;
    if (pages >= pageCap) {
      truncated = true;
      break;
    }
  }

  // One clock reading for the whole page, so two items with the same deadline
  // cannot disagree about being overdue.
  const nowMs = now();

  logLine("calendar.events.attention_query", { userId, limit: cap, count: items.length, pages, truncated });

  return {
    limit: cap,
    count: items.length,
    truncated,
    pages,
    events: items.map((item) => toUpcomingJson(item, nowMs)),
  };
}

/**
 * Compile a mutation into UpdateItem parameters, always condition-bound to the
 * session user.
 *
 * The ConditionExpression is not optional and not a parameter: every mutation in
 * this module carries `attribute_exists(#userId) AND #userId = :userId`, so there
 * is no code path that can write an event row without it.
 *
 * `attribute_exists(#userId)` on the HASH KEY is how DynamoDB spells "this item
 * exists" - an item cannot exist without its key. The redundant-looking equality
 * is kept because the two clauses guard different mistakes: the first stops a
 * mutation from CREATING a row for a guessed eventId, the second is the explicit
 * tenancy assertion the reviewer of this file is looking for.
 *
 * Attribute names all go through placeholders because `status` (and `location`,
 * and others in this schema) are DynamoDB reserved words.
 *
 * @param {object} args
 * @param {string} args.tableName
 * @param {string} args.userId
 * @param {string} args.eventId
 * @param {Record<string, unknown>} [args.set] `undefined` values are dropped.
 * @param {string[]} [args.remove]
 * @returns {object} UpdateCommand input.
 */
export function buildEventUpdateParams({ tableName, userId, eventId, set = {}, remove = [] }) {
  const names = { "#userId": "userId" };
  const values = { ":userId": userId };
  const sets = [];
  const removes = [];

  let i = 0;
  for (const [attribute, value] of Object.entries(set || {})) {
    if (value === undefined) continue;
    names[`#s${i}`] = attribute;
    values[`:s${i}`] = value;
    sets.push(`#s${i} = :s${i}`);
    i += 1;
  }

  let j = 0;
  for (const attribute of Array.isArray(remove) ? remove : []) {
    names[`#r${j}`] = attribute;
    removes.push(`#r${j}`);
    j += 1;
  }

  const clauses = [];
  if (sets.length > 0) clauses.push(`SET ${sets.join(", ")}`);
  if (removes.length > 0) clauses.push(`REMOVE ${removes.join(", ")}`);
  // DynamoDB rejects an UpdateItem with no clauses; fail here, where the message
  // can say what was actually wrong.
  if (clauses.length === 0) throw new Error("buildEventUpdateParams: nothing to set or remove");

  return {
    TableName: tableName,
    Key: { userId, eventId },
    UpdateExpression: clauses.join(" "),
    ConditionExpression: "attribute_exists(#userId) AND #userId = :userId",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  };
}

/**
 * Real DynamoDB UpdateItem for an event row. Default `updateEvent` dependency.
 *
 * @param {object} params UpdateCommand input from `buildEventUpdateParams`.
 * @returns {Promise<object|null>} The updated row.
 */
export async function ddbUpdateEvent(params) {
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new UpdateCommand(params));
  return result?.Attributes || null;
}

/**
 * Real DynamoDB GetItem for one event row. Default `getEvent` dependency.
 *
 * Keyed by BOTH `userId` and `eventId`, so this is not a way to read another
 * account's row: a foreign eventId under this user's partition is simply absent.
 *
 * @param {{ tableName: string, userId: string, eventId: string }} args
 * @returns {Promise<object|null>}
 */
export async function ddbGetEvent({ tableName, userId, eventId }) {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new GetCommand({ TableName: tableName, Key: { userId, eventId } }));
  return result?.Item || null;
}

/**
 * Run one conditional mutation and translate a condition failure into
 * `EventNotFoundError`.
 *
 * Classified by `err.name`, not by message text, matching connections.mjs's scan
 * lock - `ConditionalCheckFailedException` is the SDK's own exception type.
 *
 * @param {object} args
 * @param {object} [deps]
 * @returns {Promise<object|null>}
 */
async function applyEventMutation({ tableName, userId, eventId, set, remove }, { updateEvent = ddbUpdateEvent } = {}) {
  try {
    return await updateEvent(buildEventUpdateParams({ tableName, userId, eventId, set, remove }));
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") throw new EventNotFoundError();
    throw err;
  }
}

/**
 * Mark an event handled: acknowledge or dismiss.
 *
 * The status change and `REMOVE attentionKey` are ONE UpdateItem, not two calls:
 * an item that is "acknowledged" but still carries an `attentionKey` is in
 * AttentionIndex, so a split write leaves the user's list wrong for as long as the
 * second call takes - or forever, if it fails.
 *
 * @param {object} args
 * @param {string} args.userId Session-derived.
 * @param {string} args.eventId From the URL path; validated here.
 * @param {string} args.status EVENT_STATUS.ACKNOWLEDGED or DISMISSED.
 * @param {string|null} [args.tableName]
 * @param {object} [deps] `updateEvent`, `now`, `env`, `log`.
 * @returns {Promise<object>} The public projection of the updated row.
 * @throws {EventValidationError|EventNotFoundError}
 */
async function setEventHandled(
  { userId, eventId, status, tableName = null },
  { updateEvent = ddbUpdateEvent, now = () => Date.now(), env = process.env, log = null } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("setEventHandled: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);

  // Validation before anything else: a malformed id costs no table lookup and no
  // DynamoDB call.
  const id = requireEventId(eventId);
  const table = requireTable(tableName, env, "setEventHandled");
  const stampedAt = new Date(now()).toISOString();

  const set = { status, updatedAt: stampedAt };
  if (status === EVENT_STATUS.ACKNOWLEDGED) set.acknowledgedAt = stampedAt;
  if (status === EVENT_STATUS.DISMISSED) set.dismissedAt = stampedAt;

  const updated = await applyEventMutation(
    // REMOVE, not `attentionKey = ""`: DynamoDB rejects an empty string as an
    // index key, and the attribute must be ABSENT for the sparse index to drop
    // the row. See the lifecycle contract in dynamodb_calendar_events.tf.
    { tableName: table, userId, eventId: id, set, remove: ["attentionKey"] },
    { updateEvent }
  );

  logLine("calendar.events.handled", { userId, eventId: id, status });
  return toEventJson(updated || { eventId: id, status });
}

/**
 * POST .../acknowledge - the user has seen this and it needs nothing further.
 *
 * @param {{ userId: string, eventId: string, tableName?: string|null }} args
 * @param {object} [deps] `updateEvent`, `now`, `env`, `log`.
 * @returns {Promise<object>}
 */
export async function acknowledgeEvent({ userId, eventId, tableName = null } = {}, deps = {}) {
  return setEventHandled({ userId, eventId, status: EVENT_STATUS.ACKNOWLEDGED, tableName }, deps);
}

/**
 * POST .../dismiss - this is not relevant; stop showing it.
 *
 * @param {{ userId: string, eventId: string, tableName?: string|null }} args
 * @param {object} [deps] `updateEvent`, `now`, `env`, `log`.
 * @returns {Promise<object>}
 */
export async function dismissEvent({ userId, eventId, tableName = null } = {}, deps = {}) {
  return setEventHandled({ userId, eventId, status: EVENT_STATUS.DISMISSED, tableName }, deps);
}

/**
 * POST .../restore - undo a mistaken acknowledge or dismiss.
 *
 * Needs the existing row, for two reasons that are not obvious:
 *   - `attentionKey` may only be re-added when `needsAttention` is true, and that
 *     is a property of the extracted event, not of the request;
 *   - a GSI indexes an item only when it has BOTH index keys, so re-adding
 *     `attentionKey` without a `dueBy` would put the event back into `pending`
 *     while leaving it invisible in the attention list. `resolveDueBy` supplies
 *     the same start-instant fallback the write path uses.
 *
 * The read is keyed by `{ userId, eventId }` - it cannot see another account's
 * row - and the write that follows is still condition-bound, so a row deleted
 * between the two calls fails closed as a 404 rather than being recreated.
 *
 * @param {{ userId: string, eventId: string, tableName?: string|null }} args
 * @param {object} [deps] `getEvent`, `updateEvent`, `now`, `env`, `log`.
 * @returns {Promise<object>}
 * @throws {EventValidationError|EventNotFoundError}
 */
export async function restoreEvent(
  { userId, eventId, tableName = null } = {},
  { getEvent = ddbGetEvent, updateEvent = ddbUpdateEvent, now = () => Date.now(), env = process.env, log = null } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("restoreEvent: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);

  const id = requireEventId(eventId);
  const table = requireTable(tableName, env, "restoreEvent");

  const existing = await getEvent({ tableName: table, userId, eventId: id });
  // One error for "not yours" and "not there", so the 404 leaks nothing.
  if (!existing) throw new EventNotFoundError();

  const stampedAt = new Date(now()).toISOString();
  const status = EVENT_STATUS.PENDING;
  const set = { status, updatedAt: stampedAt };
  const remove = ["acknowledgedAt", "dismissedAt"];

  const attentionKey = attentionKeyFor(userId, { needsAttention: existing.needsAttention, status });
  if (attentionKey) {
    set.attentionKey = attentionKey;
    const dueBy = resolveDueBy({ attentionKey, dueBy: existing.dueBy || null, startsAt: existing.startsAt });
    if (dueBy) set.dueBy = dueBy;
  } else {
    // A purely informational event goes back to pending WITHOUT rejoining the
    // attention list - it was never in it.
    remove.push("attentionKey");
  }

  const updated = await applyEventMutation({ tableName: table, userId, eventId: id, set, remove }, { updateEvent });

  logLine("calendar.events.restored", { userId, eventId: id, needsAttention: existing.needsAttention === true });
  return toEventJson(updated || { ...existing, ...set });
}

/**
 * Split keys into BatchGetItem-sized chunks. Separate from `chunkItems` because
 * the two DynamoDB batch APIs have different hard caps (100 reads, 25 writes) and
 * clamping a read batch to the write cap would triple the request count.
 *
 * @param {object[]} keys
 * @param {number} [size]
 * @returns {object[][]}
 */
export function chunkKeys(keys, size = BATCH_GET_CHUNK_SIZE) {
  const limit =
    Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), BATCH_GET_CHUNK_SIZE) : BATCH_GET_CHUNK_SIZE;
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  const chunks = [];
  for (let i = 0; i < list.length; i += limit) chunks.push(list.slice(i, i + limit));
  return chunks;
}

/**
 * BatchGetItem parameters for the re-scan lifecycle pre-read. Pure and exported
 * so the projection is assertable with the SDK absent.
 *
 * `ProjectionExpression` is narrow on purpose (see LIFECYCLE_ATTRIBUTES) and
 * every attribute goes through a placeholder because `status` is a reserved word.
 *
 * @param {{ tableName: string, keys: Array<{ userId: string, eventId: string }> }} args
 * @returns {object} BatchGetCommand input.
 */
export function buildLifecycleGetParams({ tableName, keys }) {
  const names = {};
  const projection = LIFECYCLE_ATTRIBUTES.map((attribute, index) => {
    names[`#p${index}`] = attribute;
    return `#p${index}`;
  });
  return {
    RequestItems: {
      [tableName]: {
        Keys: (Array.isArray(keys) ? keys : []).map(({ userId, eventId }) => ({ userId, eventId })),
        ProjectionExpression: projection.join(", "),
        ExpressionAttributeNames: names,
      },
    },
  };
}

/**
 * Real DynamoDB BatchGetItem for the lifecycle pre-read. Default `batchGet`.
 *
 * Returns unread keys unwrapped from the `UnprocessedKeys` envelope, so the retry
 * loop above it never has to know the request shape - the same contract
 * `ddbBatchWrite` uses for `UnprocessedItems`.
 *
 * @param {{ tableName: string, keys: Array<{ userId: string, eventId: string }> }} args
 * @returns {Promise<{ items: object[], unprocessedKeys: object[] }>}
 */
export async function ddbBatchGet({ tableName, keys }) {
  const { BatchGetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new BatchGetCommand(buildLifecycleGetParams({ tableName, keys })));
  return {
    items: result?.Responses?.[tableName] || [],
    unprocessedKeys: result?.UnprocessedKeys?.[tableName]?.Keys || [],
  };
}

/**
 * Read the stored lifecycle state of the rows a write is about to overwrite.
 *
 * Key-scoped: it asks for exactly the keys being written, never a Scan and never
 * a query across the partition. Every wait goes through the INJECTED `sleep` and
 * jitters through the INJECTED `random`, so a test drives the retries instantly.
 *
 * @param {{ items: object[], tableName: string }} args
 * @param {object} [deps] `batchGet`, `sleep`, `random`, `maxAttempts`,
 *   `baseDelayMs`, `maxDelayMs`, `env`, `log`.
 * @returns {Promise<Map<string, object>>} eventId -> stored lifecycle attributes.
 */
export async function readLifecycleStates(
  { items, tableName } = {},
  {
    batchGet = ddbBatchGet,
    sleep = defaultSleep,
    random = Math.random,
    maxAttempts = MAX_BATCH_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    env = process.env,
    log = null,
  } = {}
) {
  const logLine = typeof log === "function" ? log : makeLogger(env);
  const states = new Map();
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.userId && item.eventId);
  if (list.length === 0) return states;

  for (const chunk of chunkKeys(list.map(({ userId, eventId }) => ({ userId, eventId })))) {
    let pending = chunk;
    let attempt = 0;

    while (pending.length > 0 && attempt < maxAttempts) {
      attempt += 1;
      const result = await batchGet({ tableName, keys: pending });
      for (const item of result?.items || []) {
        if (item?.eventId) states.set(item.eventId, item);
      }

      const unread = (Array.isArray(result?.unprocessedKeys) ? result.unprocessedKeys : []).filter(Boolean);
      if (unread.length === 0) break;
      if (attempt >= maxAttempts) {
        // Those rows are written as freshly extracted, i.e. pending. See the
        // fail-soft note in this section's header.
        logLine("calendar.events.lifecycle_read_incomplete", { unread: unread.length, attempts: attempt });
        break;
      }
      await sleep(backoffDelayMs({ attempt, baseDelayMs, maxDelayMs, random }));
      pending = unread;
    }
  }

  return states;
}

/**
 * Carry a stored row's lifecycle AND its first-seen facts forward onto a freshly
 * extracted row.
 *
 * Two separate things are preserved here, and they apply under different
 * conditions:
 *
 *  1. THE USER'S DECISION, when the stored row is `acknowledged`/`dismissed`:
 *     the status, `acknowledgedAt`/`dismissedAt`, and `dueBy` when the new
 *     extraction has none. `attentionKey` is dropped rather than recomputed - a
 *     handled event is not pending, so by the sparse-GSI contract it carries no
 *     `attentionKey` and is absent from the attention list by construction.
 *     `dueBy` is kept, because the month view still displays the deadline of an
 *     event the user has handled.
 *
 *  2. FIRST-SEEN-WINS FACTS, whatever the stored status: `createdAt` and
 *     `processingJobId`. This is why the function does NOT early-return for a
 *     still-pending row (TASK-056). The same email can legitimately match more
 *     than one processing job's query - two jobs sharing a domain, one newsletter
 *     matching two jobs' search terms - and every one of those passes writes the
 *     same content-derived `eventId`. Without this branch the last job to run
 *     would take the attribution and reset the creation stamp on every single
 *     scan, so an event's "which school is this from" would flicker as the user
 *     reorders their jobs. The FIRST job that ever stored the row keeps it.
 *
 * Returns the SAME object reference when there is genuinely nothing to preserve,
 * so callers can cheaply tell a merge from a pass-through (see `storeEvents`,
 * which counts only case 1 as a `preserved`).
 *
 * @param {object} item Freshly built row from `buildEventItem`.
 * @param {object|undefined} existing Stored lifecycle attributes, if any.
 * @returns {object}
 */
export function applyPreservedLifecycle(item, existing) {
  if (!existing || typeof existing !== "object") return item;

  const status = existing.status;
  const handled = status === EVENT_STATUS.ACKNOWLEDGED || status === EVENT_STATUS.DISMISSED;

  // First-seen-wins: the stored value wins whenever there IS one.
  const firstSeenJobId = String(existing.processingJobId ?? "").trim() || undefined;
  const processingJobId = firstSeenJobId ?? item.processingJobId;
  const createdAt = existing.createdAt ?? item.createdAt;

  if (!handled) {
    // Nothing preserved at all: same reference out, same reference in.
    if (processingJobId === item.processingJobId && createdAt === item.createdAt) return item;
    return { ...item, processingJobId, createdAt };
  }

  return {
    ...item,
    status,
    attentionKey: undefined,
    dueBy: item.dueBy ?? existing.dueBy ?? undefined,
    acknowledgedAt: existing.acknowledgedAt ?? undefined,
    dismissedAt: existing.dismissedAt ?? undefined,
    // First-seen time belongs to the first extraction, not to this re-scan.
    createdAt,
    processingJobId,
  };
}

/* ===========================================================================
 * ERASING A USER'S EVENTS (TASK-013)
 * ---------------------------------------------------------------------------
 * The disconnect route offers to delete everything this app extracted from a
 * user's mail. That is unrecoverable, so the code below is written to the
 * opposite standard from the read paths above: a read that quietly returns a
 * short page is a bug you can see, whereas a DELETE that quietly stops half way
 * and still reports success is a bug that looks exactly like success.
 *
 * Three rules follow from that, and none of them are optional:
 *   1. NOTHING IS INFERRED. `deleted` counts keys DynamoDB confirmed it wrote,
 *      chunk length minus `UnprocessedItems` - never "we sent 25, so 25 went".
 *   2. PAGING RUNS TO EXHAUSTION. The read paths stop at MAX_QUERY_PAGES and
 *      report `truncated`; stopping early here would leave rows behind, so this
 *      follows `LastEvaluatedKey` until DynamoDB stops returning one. The
 *      MAX_DELETE_PAGES bound below is a runaway guard, not a page size, and
 *      hitting it sets `complete: false`.
 *   3. INCOMPLETE IS REPORTED, NOT SWALLOWED. Unprocessed keys that survived
 *      every retry, and a page cap that was actually reached, both clear
 *      `complete`. The route surfaces that to the user rather than answering a
 *      plain "deleted".
 *
 * Tenancy is the partition key here as everywhere else in this module: the keys
 * to delete come from a Query whose hash key is the SESSION-derived userId, so
 * one user's erase cannot address another user's partition. There is no Scan and
 * no application-code filter on userId.
 * =========================================================================== */

/**
 * Runaway guard on the erase loop, not a page size.
 *
 * Every page deletes the rows it returned, so the loop terminates on its own;
 * this bound exists only so a pathological partition (or a query dependency that
 * keeps handing back the same `LastEvaluatedKey`) cannot spin a Lambda until its
 * timeout. Deliberately an order of magnitude above MAX_QUERY_PAGES: reaching it
 * means rows remain, which is reported as `complete: false` rather than being
 * quietly accepted the way a truncated read is.
 */
export const MAX_DELETE_PAGES = 200;

/**
 * Query parameters that enumerate every event key a user owns.
 *
 * Uses StartsAtIndex with a hash-key-only condition and NO range condition, so
 * the whole of the user's history is in scope rather than one date window.
 *
 * `ProjectionExpression` is the two table key attributes and nothing else. A
 * delete needs keys; pulling the full row would drag titles, descriptions,
 * subjects and senders through a code path whose only job is to destroy them,
 * and put them one careless log line away from CloudWatch. Both names go through
 * placeholders for consistency with the other builders here.
 *
 * Pure and exported so the projection, and the absence of a range condition, are
 * assertable with the SDK absent.
 *
 * @param {{ tableName: string, userId: string, exclusiveStartKey?: object|null }} args
 * @returns {object} QueryCommand input.
 */
export function buildUserEventKeysQueryParams({ tableName, userId, exclusiveStartKey = null }) {
  const params = {
    TableName: tableName,
    IndexName: STARTS_AT_INDEX,
    KeyConditionExpression: "#userId = :userId",
    ProjectionExpression: "#userId, #eventId",
    ExpressionAttributeNames: { "#userId": "userId", "#eventId": "eventId" },
    ExpressionAttributeValues: { ":userId": userId },
    ScanIndexForward: true,
  };
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;
  return params;
}

/**
 * Real DynamoDB BatchWriteItem carrying DeleteRequests. Default `batchDelete`.
 *
 * The mirror image of `ddbBatchWrite`: same 25-key cap, same `UnprocessedItems`
 * envelope, unwrapped to bare keys so the retry loop above it never has to know
 * the request shape. UnprocessedItems is NOT an error - it is how DynamoDB
 * reports partial throttling, and ignoring it here silently leaves rows behind
 * after telling the user their data was erased.
 *
 * @param {{ tableName: string, keys: Array<{ userId: string, eventId: string }> }} args
 * @returns {Promise<{ unprocessed: object[] }>}
 */
export async function ddbBatchDelete({ tableName, keys }) {
  const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(
    new BatchWriteCommand({
      RequestItems: {
        [tableName]: keys.map(({ userId, eventId }) => ({ DeleteRequest: { Key: { userId, eventId } } })),
      },
    })
  );
  const remaining = result?.UnprocessedItems?.[tableName] || [];
  return { unprocessed: remaining.map((request) => request?.DeleteRequest?.Key).filter(Boolean) };
}

/**
 * Reduce a queried index item to the table key, or null when it cannot be one.
 *
 * A row missing either key attribute cannot be deleted, and pretending otherwise
 * would inflate the count. The caller treats a rejected item as "rows remain".
 *
 * @param {object} item
 * @returns {{ userId: string, eventId: string }|null}
 */
function toEventKey(item) {
  const userId = item?.userId;
  const eventId = item?.eventId;
  if (typeof userId !== "string" || !userId) return null;
  if (typeof eventId !== "string" || !eventId) return null;
  return { userId, eventId };
}

/**
 * Delete EVERY event belonging to one user.
 *
 * Pages `buildUserEventKeysQueryParams` through `LastEvaluatedKey` to
 * exhaustion, deleting each page in BatchWriteItem chunks of at most 25 and
 * retrying `UnprocessedItems` with the same jittered backoff `putEvents` uses.
 * Every wait goes through the INJECTED `sleep` and jitters through the INJECTED
 * `random`, so a test drives every retry instantly and deterministically.
 *
 * `complete` is the honest answer to "is their data gone?" and is false when
 * anything at all was left behind: keys still unprocessed after `maxAttempts`,
 * an item the index returned without a usable key, or the MAX_DELETE_PAGES
 * runaway guard being reached. Callers must report it rather than reducing the
 * result to its count.
 *
 * @param {object} args
 * @param {string} args.userId Session-derived. Never request-supplied.
 * @param {string|null} [args.tableName]
 * @param {object} [deps]
 * @param {(params: object) => Promise<{ items: object[], lastEvaluatedKey: object|null }>} [deps.query]
 * @param {(args: { tableName: string, keys: object[] }) => Promise<{ unprocessed: object[] }>} [deps.batchDelete]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random]
 * @param {number} [deps.maxAttempts]
 * @param {number} [deps.baseDelayMs]
 * @param {number} [deps.maxDelayMs]
 * @param {number} [deps.maxPages]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @returns {Promise<{ deleted: number, pages: number, requests: number, unprocessed: object[], complete: boolean }>}
 */
export async function deleteEventsForUser(
  { userId, tableName = null } = {},
  {
    query = ddbQuery,
    batchDelete = ddbBatchDelete,
    sleep = defaultSleep,
    random = Math.random,
    maxAttempts = MAX_BATCH_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    maxPages = MAX_DELETE_PAGES,
    env = process.env,
    log = null,
  } = {}
) {
  if (typeof userId !== "string" || !userId) throw new Error("deleteEventsForUser: userId is required");
  const logLine = typeof log === "function" ? log : makeLogger(env);
  const table = requireTable(tableName, env, "deleteEventsForUser");
  const pageCap = Math.max(1, Math.floor(Number(maxPages)) || MAX_DELETE_PAGES);

  let deleted = 0;
  let pages = 0;
  let requests = 0;
  let complete = true;
  const leftOver = [];
  let exclusiveStartKey = null;

  for (;;) {
    pages += 1;
    const page = await query(buildUserEventKeysQueryParams({ tableName: table, userId, exclusiveStartKey }));

    const keys = [];
    for (const item of page?.items || []) {
      const key = toEventKey(item);
      if (key) keys.push(key);
      // An index item with no usable table key cannot be deleted. That is a row
      // that survives the erase, so the result must not claim completeness.
      else complete = false;
    }

    for (const chunk of chunkItems(keys)) {
      let pending = chunk;
      let attempt = 0;

      while (pending.length > 0 && attempt < maxAttempts) {
        attempt += 1;
        requests += 1;
        const result = await batchDelete({ tableName: table, keys: pending });
        const unprocessed = Array.isArray(result?.unprocessed) ? result.unprocessed.filter(Boolean) : [];
        // Counted from what DynamoDB did NOT hand back, never from what was sent.
        deleted += pending.length - unprocessed.length;

        if (unprocessed.length === 0) break;
        if (attempt >= maxAttempts) {
          pending = unprocessed;
          break;
        }
        const delayMs = backoffDelayMs({ attempt, baseDelayMs, maxDelayMs, random });
        logLine("calendar.events.delete_unprocessed_retry", { userId, count: unprocessed.length, attempt, delayMs });
        await sleep(delayMs);
        pending = unprocessed;
      }

      if (pending.length > 0 && attempt >= maxAttempts) leftOver.push(...pending);
    }

    exclusiveStartKey = page?.lastEvaluatedKey || null;
    if (!exclusiveStartKey) break;
    if (pages >= pageCap) {
      // Rows remain and we stopped looking. Say so; do not report a clean erase.
      complete = false;
      logLine("calendar.events.delete_page_cap", { userId, pages, deleted });
      break;
    }
  }

  if (leftOver.length > 0) complete = false;

  // Counts and ids only - no title, description, subject or sender has been read
  // into this function at all (see the key-only ProjectionExpression above).
  logLine("calendar.events.deleted_for_user", {
    userId,
    deleted,
    pages,
    requests,
    unprocessed: leftOver.length,
    complete,
  });

  return { deleted, pages, requests, unprocessed: leftOver, complete };
}
