/**
 * alarms.mjs - the structured log tokens CloudWatch alarms are built on.
 *
 * terraform/alerting.tf creates one `aws_cloudwatch_log_metric_filter` per
 * token in `ALARM_TOKENS`, each matching the token as a quoted term anywhere in
 * a log event, and alarms on the resulting count. The strings here and the
 * `local.calendar_*_token` values in that file are ONE CONTRACT: change a token
 * on only one side and nothing fails loudly - the filter simply stops matching
 * and the alarm goes quiet forever. Both sides are therefore named constants,
 * not inline literals.
 *
 * WHY THESE EVENTS NEED THEIR OWN TOKENS. Both are failures the app handles
 * gracefully ON PURPOSE, which is exactly what makes them invisible:
 *   - An extraction failure is caught per message by scan.mjs, which reports
 *     the run as "partial" and carries on. One unreadable email must not cost
 *     the batch - but that also means the Lambda publishes no AWS/Lambda
 *     `Errors` datapoint when EVERY message fails (Anthropic down, key expired,
 *     the model refusing the prompt).
 *   - A revoked Gmail grant is a normal, user-fixable state, surfaced in the
 *     UI. Nothing is thrown to the runtime. When it happens to everyone at once
 *     (consent screen change, client-secret rotation) every scan stops silently.
 *
 * WHY console.error, AND WHY NOT GATED ON CALENDAR_LOG_LEVEL. These are
 * operational signals, not diagnostics: routing them through the sibling
 * modules' `makeLogger` would mean `CALENDAR_LOG_LEVEL=none` (documented as
 * "errors only") silently disarms the production alarms as a side effect of a
 * verbosity setting. `console.error` is both the level that survives that
 * setting and the correct severity.
 *
 * SECURITY: an alarm event must never become an exfiltration path for the
 * material this app handles. `emitAlarm` therefore drops any field whose NAME
 * looks credential- or content-bearing, keeps only primitive values, and caps
 * every string. That is defence in depth, not the only defence: the callers
 * already pass ids, counts and error NAMES only, and gmail.mjs / anthropic.mjs
 * scrub message content long before it could reach here. Nothing in this module
 * ever logs a token, a cookie, an Authorization header, a request body, an
 * email subject or a message snippet.
 */

/**
 * Tokens matched by the metric filters in terraform/alerting.tf.
 *
 * Frozen so a caller cannot mutate the contract at runtime.
 */
export const ALARM_TOKENS = Object.freeze({
  /** A single message could not be turned into events (see scan.mjs). */
  EXTRACTION_FAILED: "CALENDAR_EXTRACTION_FAILED",
  /** A stored Gmail grant was rejected as revoked (see google-token.mjs). */
  REAUTH_REQUIRED: "CALENDAR_REAUTH_REQUIRED",
});

/** Longest field value an alarm line will carry. Alarms need counts, not prose. */
export const MAX_ALARM_FIELD_LENGTH = 120;

/**
 * Field names that are never emitted, whatever their value.
 *
 * Matched as a substring, case-insensitively, so `accessToken`, `id_token` and
 * `TOKEN` are all refused by the one `token` entry. Deliberately broad: a field
 * wrongly dropped costs a line of debugging, a field wrongly emitted puts
 * credentials or a child's personal data in CloudWatch.
 */
export const DENIED_ALARM_FIELDS = Object.freeze([
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "session",
  "body",
  "subject",
  "snippet",
  "payload",
  "email",
  "address",
  "code",
  "state",
]);

/**
 * Is this field name safe to emit?
 *
 * Pure and exported so the denylist is provable without capturing any output.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isAllowedAlarmField(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  const lower = name.toLowerCase();
  return !DENIED_ALARM_FIELDS.some((denied) => lower.includes(denied));
}

/**
 * Reduce a caller's fields to the subset an alarm line may carry: allowed
 * names, primitive values, capped strings.
 *
 * Objects, arrays, functions, symbols and nullish values are dropped rather
 * than stringified - `String(someObject)` is how a whole message payload ends
 * up in a log line by accident.
 *
 * Pure and exported for the same reason as `isAllowedAlarmField`.
 *
 * @param {object} [fields]
 * @param {number} [limit]
 * @returns {Record<string, string|number|boolean>}
 */
export function sanitiseAlarmFields(fields = undefined, limit = MAX_ALARM_FIELD_LENGTH) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};

  const safe = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!isAllowedAlarmField(name)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      safe[name] = value;
    } else if (typeof value === "boolean") {
      safe[name] = value;
    } else if (typeof value === "string") {
      safe[name] = value.length > limit ? `${value.slice(0, limit)}...` : value;
    }
    // Anything else (object, array, function, null, undefined) is dropped.
  }
  return safe;
}

/**
 * Emit one alarm event.
 *
 * The token is written FIRST and on its own, so the CloudWatch term filter
 * matches regardless of what (if anything) follows it, and so a truncated log
 * event still counts.
 *
 * @param {string} token One of `ALARM_TOKENS`. Anything else is ignored, so a
 *   typo cannot invent a metric nobody is alarming on.
 * @param {object} [fields] Ids, counts and error names only; see
 *   `sanitiseAlarmFields` for what is actually allowed through.
 * @param {object} [deps]
 * @param {(message: string, fields?: object) => void} [deps.write] Sink,
 *   defaulting to `console.error`. Injectable so a caller (or a test) can
 *   capture emissions without stubbing the console.
 * @returns {boolean} Whether anything was emitted.
 */
export function emitAlarm(token, fields = undefined, { write = undefined } = {}) {
  const known = Object.values(ALARM_TOKENS).includes(token);
  if (!known) return false;

  const sink = typeof write === "function" ? write : (message, safe) => console.error(message, safe);
  const safe = sanitiseAlarmFields(fields);
  sink(token, safe);
  return true;
}
