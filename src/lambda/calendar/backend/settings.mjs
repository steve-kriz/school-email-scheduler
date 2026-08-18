/**
 * settings.mjs - what the user asked us to watch for, and how it is validated.
 *
 * One school display name plus one or more sender domains. These two values are
 * the whole input to the Gmail search query (TASK-006) and the extraction prompt
 * (TASK-007), which is why the validation here is not cosmetic: a domain list
 * that is wrong in the wrong direction decides how much of the user's mailbox is
 * read and how much of it is sent to a model.
 *
 * STORAGE: `searchDomains` is a DynamoDB string set (see
 * terraform/dynamodb_calendar_connections.tf). The document client marshals a JS
 * `Set` to SS, so that is what the patch carries. DynamoDB rejects an EMPTY
 * string set outright, so "this user now has no domains" cannot be written as
 * `new Set()` - it has to REMOVE the attribute, which is what
 * `REMOVE_ATTRIBUTE` from connections.mjs expresses. `buildConnectionPatch`
 * handles that case explicitly; do not simplify it back into writing an empty
 * set, which fails the write with a ValidationException.
 *
 * NO SANITISATION, DELIBERATELY. `schoolName` and each domain are stored exactly
 * as validated - raw, unescaped text. Stripping or escaping characters at the
 * storage layer corrupts legitimate values ("St Mary's Primary", "École") and
 * hides the corruption in the database, where it can never be undone. Escaping is
 * the job of the boundary that renders:
 *   - the frontend (TASK-010) escapes on render, so the text cannot become
 *     markup in the page;
 *   - the prompt builder (TASK-007) wraps these values in a delimited block, so
 *     the text cannot become instructions to the model.
 * What IS enforced here is SHAPE: a length bound on the name, and a strict
 * hostname grammar on each domain, so neither field can carry an arbitrary
 * payload in the first place.
 *
 * VALIDATION IS SERVER-SIDE. The frontend will validate too, for the error
 * messages, but nothing here trusts that: every rule below is re-checked on the
 * request.
 *
 * TESTABILITY: every I/O function takes its dependencies as parameters with real
 * defaults, exactly as connections.mjs does. Nothing in this module imports the
 * AWS SDK, and every branch is reachable with no AWS credentials and no network.
 */

import {
  connectionUserId,
  getConnection,
  REMOVE_ATTRIBUTE,
  toPublicJson,
  updateConnection,
} from "./connections.mjs";

/** Path the settings routes are mounted on. */
export const SETTINGS_PATH = "/calendar/api/settings";

/**
 * Fields the settings API reports. Every one of these must also appear in
 * `PUBLIC_ATTRIBUTES` in connections.mjs - that list is the allow-list, and an
 * attribute missing from it projects as null however hard this module asks for
 * it.
 */
export const SETTINGS_FIELDS = [
  "email",
  "schoolName",
  "searchDomains",
  "scheduleEnabled",
  "scheduleFrequency",
  "scheduleHour",
  "timezone",
  "lastScanAt",
  "lastScanStatus",
];

/** Display name bound, counted in code points (see `countCodePoints`). */
export const MAX_SCHOOL_NAME_LENGTH = 120;

/**
 * How many domains one user may watch. Ten is generous for a real school (the
 * school itself, a P&C, a newsletter platform, a sports association) and low
 * enough that the generated Gmail query stays inside Google's own query limits.
 */
export const MAX_SEARCH_DOMAINS = 10;

/** DNS limits: 253 characters overall, 63 per label. */
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_DOMAIN_LABEL_LENGTH = 63;

/**
 * Hosts a user must not match on.
 *
 * "sender is @gmail.com" is not a school filter - it is most of a personal
 * mailbox. Allowing it would put unrelated private mail through the extraction
 * model, which is both a privacy failure and an unbounded cost. Matched EXACTLY,
 * not as a suffix: "gmail.com" is refused, a hypothetical "mail.gmail.com" is
 * not, because the concern is the shared public host itself.
 */
export const PUBLIC_MAIL_DOMAINS = Object.freeze([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
]);

/** Accepted `scheduleFrequency` values. TASK-008 owns what they mean. */
export const SCHEDULE_FREQUENCIES = Object.freeze(["daily", "weekly"]);

/** One DNS label: alphanumeric, inner hyphens only. */
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** IANA zone shape, e.g. "Australia/Sydney", "UTC", "America/Argentina/Salta". */
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/** Longest plausible IANA zone name, with headroom. */
const MAX_TIMEZONE_LENGTH = 64;

/** How much of a rejected value is echoed back to the caller. */
const ECHO_LENGTH = 64;

/**
 * A 400-shaped failure, carrying the field the client should highlight.
 *
 * Mirrors `SessionError` in session.mjs: the status code lives with the error
 * rather than being re-derived by each route, so the two routes below cannot
 * disagree about what a validation failure is worth.
 *
 * `field` is one of the SETTINGS_FIELDS names, or null when the whole body was
 * unusable.
 */
export class SettingsValidationError extends Error {
  /**
   * @param {string|null} field
   * @param {string} message Client-safe: shown to the user.
   */
  constructor(field, message) {
    super(message);
    this.name = "SettingsValidationError";
    this.statusCode = 400;
    this.field = field;
  }
}

/**
 * Count characters the way a person would: by code point, not by UTF-16 unit.
 *
 * `"👨‍👩‍👧".length` is 8 and `"é".length` can be 2 after decomposition, so a
 * `.length` bound silently rejects names that are well inside the limit as the
 * user sees it. ASCII behaves identically either way.
 *
 * @param {string} value
 * @returns {number}
 */
export function countCodePoints(value) {
  return [...value].length;
}

/**
 * Truncate a rejected value for an error message.
 *
 * The value is attacker-controllable text on its way into a response body (and
 * from there into a page), so it is length-capped, exactly as the OAuth error
 * `reason` is in index.mjs. It is NOT escaped here: the frontend escapes on
 * render, and escaping twice would show the user `&#39;` where they typed an
 * apostrophe.
 *
 * @param {unknown} value
 * @returns {string}
 */
function echo(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length > ECHO_LENGTH ? `${text.slice(0, ECHO_LENGTH)}...` : text;
}

/**
 * Reduce whatever the user pasted to a bare hostname.
 *
 * NORMALISE RATHER THAN REJECT. Every form below is a natural thing to paste out
 * of a browser or an email client, and refusing them teaches the user nothing
 * except that the field is fussy:
 *
 *   "@StMarys.EDU.au"             -> "stmarys.edu.au"   (an address fragment)
 *   "office@stmarys.edu.au"       -> "stmarys.edu.au"   (a whole address)
 *   "https://stmarys.edu.au/news" -> "stmarys.edu.au"   (a copied URL)
 *   "*.stmarys.edu.au"            -> "stmarys.edu.au"   (a wildcard pattern)
 *   "stmarys.edu.au:443"          -> "stmarys.edu.au"   (a URL with a port)
 *
 * Order matters: the scheme goes before the path split (otherwise "//" eats the
 * host), and the path split goes before the "@" cut (otherwise a "@" later in a
 * URL path would be read as an address separator).
 *
 * What is deliberately NOT normalised: a leading or trailing dot, and a trailing
 * hyphen. Those are not "a different way of writing a domain", they are typos or
 * truncation, and quietly repairing them would store a domain the user never
 * meant to enter. They fall through to `isValidDomain` and are refused.
 *
 * @param {unknown} raw
 * @returns {string} Normalised host, or "" when there is nothing left.
 */
export function normalizeDomain(raw) {
  if (typeof raw !== "string") return "";

  let value = raw.trim().toLowerCase();
  if (!value) return "";

  // Scheme ("https://", "mailto:" is handled by the "@" cut below) and the
  // protocol-relative "//" form.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^\/\//, "");

  // Path, query and fragment.
  value = value.split(/[/?#]/)[0];

  // An address or an address fragment: keep what follows the LAST "@".
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);

  // Wildcard prefixes, however many were pasted ("*.*.example.com").
  while (value.startsWith("*.")) value = value.slice(2);

  // Port.
  value = value.replace(/:\d+$/, "");

  return value.trim();
}

/**
 * Does this string have the shape of a public domain name?
 *
 * Applied AFTER `normalizeDomain`, to what is left. At least two labels, because
 * a single label ("stmarys", "localhost") can never be the domain of an email
 * sender and matching on one would be a filter that never fires.
 *
 * @param {string} value Already normalised and lower-cased.
 * @returns {boolean}
 */
export function isValidDomain(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false;

  const labels = value.split(".");
  if (labels.length < 2) return false;

  return labels.every(
    (label) => label.length > 0 && label.length <= MAX_DOMAIN_LABEL_LENGTH && DOMAIN_LABEL_PATTERN.test(label)
  );
}

/**
 * Validate the school display name.
 *
 * Trimmed, then bounded. Trimming is not sanitisation - it removes only leading
 * and trailing whitespace, which no user meant to type - and the value is stored
 * exactly as returned here, apostrophes and accents intact.
 *
 * @param {unknown} raw
 * @returns {string} The trimmed name.
 * @throws {SettingsValidationError}
 */
export function validateSchoolName(raw) {
  if (typeof raw !== "string") {
    throw new SettingsValidationError("schoolName", "School name is required");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Covers both "missing" and "spaces only": to the user they are one mistake.
    throw new SettingsValidationError("schoolName", "School name is required");
  }
  if (countCodePoints(trimmed) > MAX_SCHOOL_NAME_LENGTH) {
    throw new SettingsValidationError(
      "schoolName",
      `School name must be ${MAX_SCHOOL_NAME_LENGTH} characters or fewer`
    );
  }
  return trimmed;
}

/**
 * Validate and normalise the domain list.
 *
 * Rule order is chosen so the message names the real problem:
 *  1. Is it a non-empty array at all, and within MAX_SEARCH_DOMAINS? The count is
 *     checked on what the user SUBMITTED, before de-duplication, so pasting
 *     fifteen domains is reported as "too many" rather than silently collapsing
 *     to a number that happens to fit.
 *  2. Normalise, then shape-check each entry.
 *  3. Refuse public mail hosts, naming the offender.
 *  4. De-duplicate.
 *
 * Duplicates COLLAPSE rather than erroring. Two spellings of the same domain are
 * one intent, not a mistake worth blocking a save for, and a string set could not
 * store them twice anyway.
 *
 * @param {unknown} raw
 * @returns {string[]} Normalised, de-duplicated, order preserved.
 * @throws {SettingsValidationError}
 */
export function validateSearchDomains(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SettingsValidationError("searchDomains", "At least one school email domain is required");
  }
  if (raw.length > MAX_SEARCH_DOMAINS) {
    throw new SettingsValidationError(
      "searchDomains",
      `Enter at most ${MAX_SEARCH_DOMAINS} school email domains`
    );
  }

  const seen = new Set();
  const domains = [];

  for (const entry of raw) {
    const domain = normalizeDomain(entry);
    if (!isValidDomain(domain)) {
      throw new SettingsValidationError(
        "searchDomains",
        `"${echo(entry)}" is not a valid email domain`
      );
    }
    if (PUBLIC_MAIL_DOMAINS.includes(domain)) {
      throw new SettingsValidationError(
        "searchDomains",
        `${domain} is a public email provider, not a school domain - use the school's own domain`
      );
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return domains;
}

/**
 * Validate the optional schedule fields.
 *
 * TASK-008 owns the scan schedule and writes these too; this route accepts them
 * so the settings form can save everything in one request. Only keys the caller
 * actually sent are validated and returned - an absent key means "leave whatever
 * is stored alone", never "reset it to a default".
 *
 * HTML form controls submit strings, so "true"/"false" and "7" are accepted for
 * the boolean and the hour and coerced to their real types. Coercion happens
 * here, once, rather than in the UI, so the stored types stay consistent whoever
 * is calling.
 *
 * @param {object} payload
 * @returns {{ scheduleEnabled?: boolean, scheduleFrequency?: string, scheduleHour?: number, timezone?: string }}
 * @throws {SettingsValidationError}
 */
export function validateSchedule(payload) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;

  if (has("scheduleEnabled")) {
    const value = payload.scheduleEnabled;
    if (value === true || value === "true") out.scheduleEnabled = true;
    else if (value === false || value === "false") out.scheduleEnabled = false;
    else throw new SettingsValidationError("scheduleEnabled", "Automatic scanning must be on or off");
  }

  if (has("scheduleFrequency")) {
    const value = typeof payload.scheduleFrequency === "string" ? payload.scheduleFrequency.trim().toLowerCase() : "";
    if (!SCHEDULE_FREQUENCIES.includes(value)) {
      throw new SettingsValidationError(
        "scheduleFrequency",
        `Frequency must be one of: ${SCHEDULE_FREQUENCIES.join(", ")}`
      );
    }
    out.scheduleFrequency = value;
  }

  if (has("scheduleHour")) {
    const raw = payload.scheduleHour;
    // Only a whole-number string is accepted; Number("") is 0 and Number(" ")
    // is 0, either of which would silently become midnight.
    const value = typeof raw === "number" ? raw : /^\d{1,2}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new SettingsValidationError("scheduleHour", "Scan hour must be a whole number from 0 to 23");
    }
    out.scheduleHour = value;
  }

  if (has("timezone")) {
    const value = typeof payload.timezone === "string" ? payload.timezone.trim() : "";
    if (!value || value.length > MAX_TIMEZONE_LENGTH || !TIMEZONE_PATTERN.test(value)) {
      throw new SettingsValidationError("timezone", `"${echo(payload.timezone)}" is not a valid time zone`);
    }
    out.timezone = value;
  }

  return out;
}

/**
 * Validate a whole settings payload without throwing.
 *
 * Pairs with `requireValidSettings` the way `readSession` pairs with
 * `requireSession`: a caller that wants a verdict gets one, a caller that wants
 * to fail fast throws.
 *
 * @param {unknown} payload
 * @returns {{ valid: true, settings: object } | { valid: false, field: string|null, error: string }}
 */
export function validateSettingsPayload(payload) {
  try {
    return { valid: true, settings: requireValidSettings(payload) };
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return { valid: false, field: err.field, error: err.message };
    }
    throw err;
  }
}

/**
 * Validate a whole settings payload, or throw a 400-shaped error.
 *
 * @param {unknown} payload
 * @returns {{ schoolName: string, searchDomains: string[] } & Record<string, unknown>}
 * @throws {SettingsValidationError}
 */
export function requireValidSettings(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SettingsValidationError(null, "Expected a JSON object");
  }

  return {
    schoolName: validateSchoolName(payload.schoolName),
    searchDomains: validateSearchDomains(payload.searchDomains),
    ...validateSchedule(payload),
  };
}

/**
 * Parse a request body into an object.
 *
 * An absent or blank body is `{}` rather than an error: the validator then
 * reports the missing FIELD ("School name is required"), which is what the user
 * can act on, instead of a generic complaint about the body.
 *
 * @param {object} event ALB event.
 * @returns {object}
 * @throws {SettingsValidationError} When the body is not parseable JSON.
 */
export function parseJsonBody(event) {
  const raw = event?.body;
  if (typeof raw !== "string" || raw.trim() === "") return {};

  const text = event?.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The body itself is never logged or echoed - it is unvalidated input of
    // unknown size and may contain anything the caller chose to send.
    throw new SettingsValidationError(null, "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsValidationError(null, "Expected a JSON object");
  }
  return parsed;
}

/**
 * Turn validated settings into a DynamoDB patch.
 *
 * `searchDomains` becomes a JS `Set`, which the document client marshals to a
 * string set (SS). An EMPTY list becomes `REMOVE_ATTRIBUTE` instead: DynamoDB
 * refuses to store an empty string set and fails the whole write with a
 * ValidationException, so the only way to represent "no domains" is to delete the
 * attribute. The PUT route never reaches this branch (it requires at least one
 * domain), but any other caller that clears the list must not blow up the write -
 * hence the explicit branch here rather than at the route.
 *
 * @param {object} settings Output of `requireValidSettings`, or any subset of it.
 * @returns {Record<string, unknown>} Patch for `updateConnection`.
 */
export function buildConnectionPatch(settings = {}) {
  const patch = {};

  if (settings.schoolName !== undefined) {
    // Stored raw. See the module docblock: escaping happens on render.
    patch.schoolName = settings.schoolName;
  }

  if (settings.searchDomains !== undefined) {
    const domains = Array.isArray(settings.searchDomains) ? settings.searchDomains : [];
    patch.searchDomains = domains.length > 0 ? new Set(domains) : REMOVE_ATTRIBUTE;
  }

  for (const key of ["scheduleEnabled", "scheduleFrequency", "scheduleHour", "timezone"]) {
    if (settings[key] !== undefined) patch[key] = settings[key];
  }

  return patch;
}

/**
 * Project a connection row as the settings response body.
 *
 * Built on `toPublicJson`, which is an allow-list: a stored attribute nobody
 * explicitly published cannot appear here, so `refreshTokenEnc` (and any
 * attribute a later ticket adds) is private by default rather than by vigilance.
 * The body therefore carries the SETTINGS_FIELDS plus `connected` /
 * `connectionStatus`, and no token material of any kind.
 *
 * `searchDomains` is reported as `[]` rather than null when unset, because every
 * consumer treats it as a list and a null would just move that check into the
 * frontend.
 *
 * @param {object|null} connection Row from `getConnection`/`updateConnection`.
 * @param {object} [fallback] Values to use when the row has none (the session's
 *   email, typically - a user who has signed in but has no row yet).
 * @param {object} [options] Forwarded to `toPublicJson` (`lookupFailed`).
 * @returns {Record<string, unknown>}
 */
export function toSettingsJson(connection, fallback = {}, options = {}) {
  const projection = toPublicJson(connection, fallback, options);
  return {
    ...projection,
    searchDomains: Array.isArray(projection.searchDomains) ? projection.searchDomains : [],
  };
}

/**
 * Read a user's settings.
 *
 * @param {string} sub Google `sub` claim (namespaced here).
 * @param {object} [deps]
 * @param {typeof getConnection} [deps.getConnection]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} Row without secrets, or null when the user has
 *   no row yet.
 */
export async function loadSettings(sub, { getConnection: loadConnection = getConnection, env = process.env } = {}) {
  return loadConnection(connectionUserId(sub), { env });
}

/**
 * Persist validated settings and return the stored row.
 *
 * Only `updateConnection` is used, never `putConnection`: a settings save must
 * patch the row, because `putConnection` is the only thing allowed to write token
 * attributes and the settings path must never be able to touch them. That is also
 * why the patch never carries a token attribute - `updateConnection` throws if it
 * does, and that guard is left in place rather than worked around.
 *
 * @param {string} sub Google `sub` claim.
 * @param {object} settings Output of `requireValidSettings`.
 * @param {object} [deps]
 * @param {typeof updateConnection} [deps.updateConnection]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} Updated row without secrets. Null only when the
 *   injected `updateItem` returned nothing - the real one returns ALL_NEW.
 */
export async function saveSettings(
  sub,
  settings,
  { updateConnection: patchConnection = updateConnection, updateItem, env = process.env } = {}
) {
  const patch = buildConnectionPatch(settings);
  // `updateItem` is forwarded so a caller (or a test) can drive the write without
  // replacing the whole of `updateConnection` and losing its containment guard.
  const deps = updateItem ? { env, updateItem } : { env };
  return patchConnection(connectionUserId(sub), patch, deps);
}

export { REMOVE_ATTRIBUTE };
