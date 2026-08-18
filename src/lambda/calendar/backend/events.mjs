/**
 * events.mjs - the only module that touches the calendar events table.
 *
 * Table shape is documented in terraform/dynamodb_calendar_events.tf: hash key
 * `userId` = "google#<google sub>", range key `eventId`, a StartsAtIndex for the
 * month view and a SPARSE AttentionIndex for the "needs attention" list.
 *
 * Its job is everything between "the model said something" and "a row exists":
 *   normaliseInstant  -> is this string actually a date?
 *   buildEventItem    -> one model event -> one storable row, or a recorded skip
 *   deriveEventId     -> the content-derived key that makes a re-scan idempotent
 *   putEvents         -> BatchWriteItem in 25s, retrying UnprocessedItems
 *   storeEvents       -> the above for a whole extraction
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
 * WARNING - A RE-SCAN OVERWRITES `status`. BatchWriteItem cannot express a
 * condition, so a re-extraction of an already-acknowledged event rewrites the row
 * with `status: "pending"` and re-adds its `attentionKey`, i.e. the event pops
 * back into the "needs attention" list. That is inherent to "BatchWriteItem plus
 * a content-derived key" and is left here deliberately rather than papered over:
 * whichever ticket owns acknowledge/dismiss must either read the existing statuses
 * before writing or mark handled events with something a re-scan preserves. Raised
 * in the TASK-007 hand-off.
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
 * @param {object} args
 * @param {string} args.userId
 * @param {object} args.message The source message from gmail.mjs.
 * @param {object} args.event One entry from the model's `events` array.
 * @param {object} [options]
 * @param {() => number} [options.now] Epoch-ms clock; used for the audit stamps
 *   and as the horizon anchor of LAST resort (see below).
 * @returns {{ item: object|null, skipped: { reason: string, eventId: string|null }|null }}
 */
export function buildEventItem({ userId, message = {}, event = {} } = {}, { now = () => Date.now() } = {}) {
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
 * @param {object} args
 * @param {string} args.userId
 * @param {object} [args.message] Source message, when passing `events`.
 * @param {object[]} [args.events] Model events belonging to `message`.
 * @param {Array<{ message: object, event: object }>} [args.extractions]
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @returns {{ items: object[], skipped: Array<{ messageId: string, reason: string }>, counts: Record<string, number> }}
 */
export function buildEventItems(
  { userId, message = null, events = null, extractions = null } = {},
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
    const built = buildEventItem({ userId, message: source, event: pair.event || {} }, { now });
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
 * @param {object} args
 * @param {string} args.userId
 * @param {object} [args.message]
 * @param {object[]} [args.events]
 * @param {Array<{ message: object, event: object }>} [args.extractions]
 * @param {string} [args.tableName]
 * @param {object} [deps] `batchWrite`, `now`, `sleep`, `random`, `maxAttempts`,
 *   `baseDelayMs`, `maxDelayMs`, `env`, `log`.
 * @returns {Promise<{ written: number, items: object[], skipped: Array<{ messageId: string, reason: string }>, counts: Record<string, number>, unprocessed: object[], requests: number }>}
 */
export async function storeEvents(
  { userId, message = null, events = null, extractions = null, tableName = null } = {},
  deps = {}
) {
  const { now = () => Date.now(), env = process.env, log = null, ...writeDeps } = deps;
  const logLine = typeof log === "function" ? log : makeLogger(env);

  const { items, skipped, counts } = buildEventItems({ userId, message, events, extractions }, { now });
  const result = await putEvents({ items, tableName }, { ...writeDeps, env, log: logLine });

  logLine("calendar.events.stored", {
    userId,
    candidates: items.length + skipped.length,
    written: result.written,
    skipped: skipped.length,
    unprocessed: result.unprocessed.length,
    counts,
  });

  return { ...result, items, skipped, counts };
}
