/**
 * School calendar - settings page.
 *
 * The processing jobs (TASK-055/TASK-057/TASK-060) - a named school, the sender
 * domains its mail comes from and its extra search terms, one block per job -
 * the recurring-scan controls (TASK-010), and the Disconnect Gmail control
 * (TASK-013). Shares its API client, its connection cards and its text helpers
 * with app.js (same origin, plain ES module import, no bundler).
 *
 * The two halves are independent: the settings form below is driven by
 * `createSettingsPage`, the disconnect section at the foot of the file by
 * `initDisconnectControl`, and neither reads the other's state. They share only
 * this module and the single bootstrap at the very bottom.
 *
 * THREE THINGS WORTH KNOWING BEFORE CHANGING THIS FILE.
 *
 * 1. EVERY STORED VALUE IS RENDERED AS TEXT, always - a job's name, its school
 *    name, its domains and its search terms, the last two comma-joined into one
 *    field each by `joinCommaList`. They are stored raw - the storage layer in
 *    backend/settings.mjs names escaping-on-render as its mitigation - so a
 *    stored `<img src=x onerror=alert(1)>` has to come back out as those literal
 *    characters, comma-joined string included. A value reaches the page in
 *    exactly two places: an input's `value` (character data by definition) and a
 *    `textContent` assignment. No markup is ever assembled from one, here or
 *    anywhere else.
 *
 * 2. THE SERVER IS THE SOURCE OF TRUTH FOR VALIDATION, AND NO RULE HERE IS EVER
 *    STRICTER THAN ITS RULE (amended by TASK-057, narrowed again by TASK-060).
 *    The form sends what the user typed and renders whatever
 *    `400 { error, field }` comes back next to the field that was named. The ONE
 *    thing checked before the round trip is `validateProcessingJobsClient`, and
 *    it is deliberately confined to two rule families the server cannot report
 *    usefully in bulk: a REQUIRED name and schoolName, and a DUPLICATE job name
 *    (trimmed, case-insensitive, per backend/settings.mjs
 *    `validateProcessingJobs`). `domains` is OPTIONAL per job (TASK-059 - a job
 *    with a school name and no domains is valid and still searchable), so there
 *    is deliberately NO required-domains check here. It does NOT check domain
 *    shape, public-provider hosts, string lengths, the job cap or the search-term
 *    cap - re-implementing those would give two sources of truth that drift, and
 *    would let a page that is out of date silently refuse a value the server
 *    would have accepted. If a rule is not in that short list, it belongs on the
 *    server and its message arrives as a 400.
 *
 *    THE DOMAINS AND SEARCH-TERMS FIELDS ARE COMMA-SEPARATED TEXT (TASK-060).
 *    One input each, split on commas by `splitCommaList` on the way out and
 *    re-joined by `joinCommaList` on the way in. There is no per-term row editor
 *    any more, and a comma can no longer be part of a search term entered here -
 *    that is the deliberate reversal of TASK-056's old rule.
 *
 * 3. NO MARKUP ASSIGNMENT, ANYWHERE. Every string that reaches the DOM in this
 *    file goes through `textContent` or an input's `value`, including the
 *    strings this file authored itself - the rule is worth more as a habit with
 *    no exceptions than as a judgement call made per string. A repo test reads
 *    this source and fails if that ever stops being true. The job rows are the
 *    only nodes this file BUILDS, and they are built with `document.createElement`
 *    through app.js's `el()` helper for exactly that reason.
 */

import {
  API_BASE,
  clear,
  createApiClient,
  el,
  processingJobEntries,
  renderConnectionCards,
  textOr,
} from "./app.js";

/** The settings endpoint. */
export const SETTINGS_ENDPOINT = `${API_BASE}/settings`;

/** The recurring-scan schedule endpoint (TASK-008). */
export const SCHEDULE_ENDPOINT = `${API_BASE}/scan/schedule`;

/** Default hour for a first-time schedule: early enough to beat the school run. */
export const DEFAULT_SCHEDULE_HOUR = 7;

/**
 * Field name -> the id of the element that shows its error.
 *
 * An ALLOWLIST, and it fails closed: a `field` the server names that is not in
 * this table falls back to the form-level error line rather than being
 * interpolated into an element lookup. Building `error-${field}` from an
 * arbitrary server string would silently target whatever element happened to
 * carry that id - and would silently show nothing at all when none did, which is
 * the worse half: the save would appear to fail for no stated reason.
 *
 * Both naming conventions are covered because the two endpoints use different
 * ones: `PUT /calendar/api/settings` names `scheduleFrequency`/`scheduleHour`,
 * while `PUT /calendar/api/scan/schedule` names `frequency`/`hour`/`dayOfWeek`.
 *
 * The superseded `schoolName` (TASK-053), `schoolNames` and `searchDomains`
 * (TASK-057) are deliberately NOT kept as aliases for `processingJobs`: there is
 * no element with those ids any more, so aliasing them would point an error at
 * nothing. Failing closed sends them to the form-level line, where the user at
 * least sees why the save was refused.
 */
export const FIELD_ERROR_IDS = Object.freeze({
  processingJobs: "error-processingJobs",
  scheduleEnabled: "error-scheduleEnabled",
  scheduleFrequency: "error-scheduleFrequency",
  scheduleHour: "error-scheduleHour",
  timezone: "error-timezone",
  frequency: "error-scheduleFrequency",
  hour: "error-scheduleHour",
  dayOfWeek: "error-dayOfWeek",
  enabled: "error-scheduleEnabled",
});

/** Where an error with no usable field name goes. */
export const FORM_ERROR_ID = "error-form";

/**
 * The per-job sub-fields the server is allowed to name in an indexed error.
 *
 * An ALLOWLIST, matching `validateProcessingJobs` in backend/settings.mjs exactly.
 * A sub-field outside it - a rename on the server, a typo, a hostile string - has
 * no slot on this page, so it falls through to the form-level line rather than
 * being interpolated into an element lookup.
 *
 * The superseded singular `domain` (renamed to `domains` by TASK-059) is
 * deliberately NOT kept as an alias, exactly as `schoolName`/`searchDomains` are
 * not kept in `FIELD_ERROR_IDS`: no element with that id is rendered any more, so
 * aliasing it would point an error at nothing. It fails closed to the form line.
 */
export const JOB_ERROR_FIELDS = Object.freeze(["name", "schoolName", "domains", "searchTerms"]);

/**
 * The one indexed field shape the server emits, anchored at both ends.
 *
 * `processingJobs[<index>].<key>`, where the index is one or more DIGITS - so
 * "processingJobs[-1].name" and "processingJobs[abc].name" do not match at all,
 * and neither can reach the id builder below.
 */
const INDEXED_JOB_FIELD = /^processingJobs\[(\d+)\]\.([A-Za-z]+)$/;

/**
 * Resolve the element id for a server-named field, failing closed.
 *
 * Two forms are understood, in this order:
 *  1. A whole-field name in `FIELD_ERROR_IDS` ("processingJobs", "scheduleHour").
 *  2. TASK-055's per-job form `processingJobs[<index>].<key>`, which resolves to
 *     the `error-job-<index>-<key>` slot the row renderer built. The index is
 *     digits-only and the key must be in `JOB_ERROR_FIELDS`, so the id is
 *     assembled from two values this file already trusts rather than from an
 *     arbitrary server string.
 *
 * Anything else is `FORM_ERROR_ID`. Note that a well-formed id here is still only
 * a CANDIDATE: `showFieldError` falls back to the form line when no element with
 * that id is on the page, which is what happens when the server names a row the
 * user has since removed.
 *
 * @param {unknown} field
 * @returns {string} An id that exists in settings.html, or one the renderer built.
 */
export function fieldErrorId(field) {
  if (typeof field !== "string") return FORM_ERROR_ID;
  if (Object.prototype.hasOwnProperty.call(FIELD_ERROR_IDS, field)) return FIELD_ERROR_IDS[field];

  const match = INDEXED_JOB_FIELD.exec(field);
  if (!match) return FORM_ERROR_ID;
  if (!JOB_ERROR_FIELDS.includes(match[2])) return FORM_ERROR_ID;
  return `error-job-${match[1]}-${match[2]}`;
}

/** Trim anything that might not be a string, without ever producing "null". */
function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse one comma-separated field into a list (TASK-060).
 *
 * THE ONE PARSER ON THIS PAGE. Both list-valued job fields - `domains` and
 * `searchTerms` - go through this pair and nothing else splits or joins a job
 * field anywhere in this file. Two parsers would drift, and the drift would show
 * up as one field tolerating a trailing comma while the other refused the save.
 *
 * `,` (U+002C) IS THE ONLY DELIMITER. Whitespace is not one, and neither is a
 * semicolon: "a.edu.au b.edu.au" is ONE entry, because a domain (or a search
 * phrase like "uniform shop") can legitimately contain a space and guessing at a
 * second delimiter would send values the user never typed.
 *
 * TOLERANT, NEVER AN ERROR. A trailing comma, a leading comma, doubled commas and
 * whitespace either side of one are all just "an empty piece to drop" - the user
 * is mid-type, not mistaken. Nothing here de-duplicates, case-folds, caps the
 * count or checks the shape of a piece: that is all server-side (rule 2 of the
 * module docblock), and `validateJobDomains` in backend/settings.mjs collapses
 * duplicate domains itself.
 *
 * Pure: no DOM, no module state, safe to unit-test by direct import.
 *
 * @param {unknown} text Raw input value, or anything at all.
 * @returns {string[]} Trimmed, non-blank pieces in the order typed.
 */
export function splitCommaList(text) {
  if (typeof text !== "string") return [];
  return text
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

/**
 * Render a stored list back into one comma-separated field value (TASK-060).
 *
 * The inverse of `splitCommaList` for every value that one produces:
 * `splitCommaList(joinCommaList(list))` is `list` for any list of non-blank,
 * comma-free, already-trimmed strings.
 *
 * Entries that are not strings, and entries that are blank once trimmed, are
 * SKIPPED rather than joined, so a stored `["a", "", "b"]` reads as "a, b" and
 * never as "a, , b" - an empty slot the user would then have to clean up. A
 * non-array (a legacy scalar, a null) is "", so a malformed stored value renders
 * an empty field instead of throwing while the page builds.
 *
 * LOSSY BY DESIGN for one legacy shape: a stored entry that itself contains a
 * comma ("canteen, roster", saved before TASK-060) renders into the field
 * indistinguishably from two entries and will split into two on the next save.
 * That is the direct, intended consequence of making the comma a delimiter here.
 *
 * @param {unknown} list
 * @returns {string} "" when there is nothing to show.
 */
export function joinCommaList(list) {
  if (!Array.isArray(list)) return "";
  // The kept entries are NOT trimmed: they go into an input the user is about to
  // edit, and this function's job is to show what is stored, not to rewrite it.
  return list.filter((entry) => typeof entry === "string" && entry.trim() !== "").join(", ");
}

/**
 * Normalise whatever the settings API returned into rows this page can edit.
 *
 * Tolerant on purpose - the same first-run and malformed-body shapes
 * `processingJobEntries` tolerates in app.js - because a page that throws while
 * rendering leaves the user with no form at all. A non-array is no rows; an entry
 * that is not an object becomes a blank row rather than being dropped, so the
 * server's "name is required" for that index still lands on something visible.
 *
 * Values are kept EXACTLY as stored, untrimmed: they go straight into an input's
 * `value`, and trimming what the user is about to edit would move their cursor.
 * The trim happens once, on the way out, in `buildJobsPayload`.
 *
 * `domains` and `searchTerms` are both LISTS here (TASK-059/TASK-060) and get the
 * same tolerance: a stored array maps entry-by-entry with a non-string coerced to
 * "", and anything that is not an array at all - a legacy `domain` scalar, a
 * null - is no entries, so the field renders empty rather than throwing.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, name: string, schoolName: string, domains: string[], searchTerms: string[] }>}
 */
export function toEditableJobs(value) {
  if (!Array.isArray(value)) return [];
  const toStringList = (raw) =>
    Array.isArray(raw) ? raw.map((entry) => (typeof entry === "string" ? entry : "")) : [];
  return value.map((entry) => {
    const source = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    return {
      id: typeof source.id === "string" ? source.id : "",
      name: typeof source.name === "string" ? source.name : "",
      schoolName: typeof source.schoolName === "string" ? source.schoolName : "",
      domains: toStringList(source.domains),
      searchTerms: toStringList(source.searchTerms),
    };
  });
}

/** A blank row, the shape "Add processing job" appends. */
export function emptyProcessingJob() {
  return { id: "", name: "", schoolName: "", domains: [], searchTerms: [] };
}

/**
 * Turn the edited rows into the `processingJobs` array the PUT carries.
 *
 * THE `id` IS ROUND-TRIPPED, NEVER INVENTED. A job the server has already stored
 * carries its server-issued id back unchanged, because TASK-056 attributes every
 * extracted event to that id and a rename that dropped it would orphan all of
 * them. A row added in this session has no id and the key is OMITTED ENTIRELY -
 * `validateProcessingJobs` mints one server-side for exactly that case, and a
 * client-invented id would be indistinguishable from a real one in storage.
 *
 * `domains` AND `searchTerms` ARE SENT AS LISTS, never as the comma-separated text
 * the user typed: the server refuses a bare string for either ("Search terms must
 * be a list", "School email domains must be a list") precisely so that nobody has
 * to guess at a delimiter server-side. The comma splitting happens once, in
 * `splitCommaList`, on the way out of the DOM.
 *
 * Blank entries are dropped a second time here, belt and braces. `splitCommaList`
 * has already dropped them - a doubled comma is not an entry - but this layer is
 * also reachable from state that was never in the DOM, and the server refuses a
 * blank outright ("A search term cannot be blank", "A school email domain cannot
 * be blank"), so a stray blank must never turn into a failed save.
 *
 * @param {unknown} jobs Rows from `readForm`.
 * @returns {Array<object>}
 */
export function buildJobsPayload(jobs) {
  if (!Array.isArray(jobs)) return [];
  const cleanList = (raw) =>
    (Array.isArray(raw) ? raw : []).map(trimText).filter((entry) => entry !== "");
  return jobs.map((entry) => {
    const source = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const job = {
      name: trimText(source.name),
      schoolName: trimText(source.schoolName),
      domains: cleanList(source.domains),
      searchTerms: cleanList(source.searchTerms),
    };
    const id = trimText(source.id);
    if (id !== "") job.id = id;
    return job;
  });
}

/**
 * The pre-flight described in rule 2 of the module docblock.
 *
 * Returns `null` when there is nothing to say, or the FIRST problem as
 * `{ field, error }` - deliberately the same shape as the server's 400 body, so
 * the caller feeds it straight into `showFieldError` with no adapter.
 *
 * ORDER IS THE POINT. Jobs are walked top to bottom and, within a job, the checks
 * run name -> duplicate-name -> schoolName, which is `validateProcessingJobs`'
 * own order. That means the reported problem is always the topmost one on screen,
 * and two jobs with blank names are reported as "required" (job 0 fails on its own
 * name before job 1 is ever compared to it) rather than as duplicates of each
 * other, which would be a baffling thing to be told.
 *
 * THERE IS NO REQUIRED-DOMAINS CHECK (TASK-059/TASK-060). `validateJobDomains` on
 * the server treats an absent, null or empty `domains` list as "no domains", not
 * as a mistake: `buildJobQuery` builds a usable query from a quoted school name
 * and/or search terms alone, so a job that matches its school through a newsletter
 * relay is legitimate. A required-check here would refuse a save the server would
 * have accepted, which rule 2 forbids. An empty `domains` is exactly as
 * unremarkable as an empty `searchTerms`, which has never been checked either.
 *
 * IT READS LISTS, NOT TEXT. `readJobsFromDom` has already run `splitCommaList`
 * over both comma-separated fields, so every row reaching here carries real
 * arrays; nothing in this function re-splits a string or touches an input.
 *
 * WHAT IS NOT CHECKED, ON PURPOSE: domain shape, public-provider hosts, any length
 * bound, the job cap and the search-term cap. See rule 2 - this function may never
 * refuse a value the server would have accepted.
 *
 * @param {unknown} jobs
 * @returns {{ field: string, error: string }|null}
 */
export function validateProcessingJobsClient(jobs) {
  if (!Array.isArray(jobs)) return null;

  // Lower-cased name -> the casing the user actually typed, so the clash message
  // can quote both spellings, exactly as the server's does.
  const seenNames = new Map();

  for (let index = 0; index < jobs.length; index += 1) {
    const entry = jobs[index];
    const source = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const at = (key) => `processingJobs[${index}].${key}`;

    const name = trimText(source.name);
    if (name === "") return { field: at("name"), error: "Processing job name is required" };

    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      return {
        field: at("name"),
        error: `"${name}" is the same processing job name as "${seenNames.get(nameKey)}" - give each job a different name`,
      };
    }
    seenNames.set(nameKey, name);

    if (trimText(source.schoolName) === "") {
      return { field: at("schoolName"), error: "School name is required" };
    }
    // No domains check: see the docblock. `domains` is optional per job.
  }

  return null;
}

/**
 * Build the `PUT /calendar/api/settings` body from the form's raw values.
 *
 * `processingJobs` is always sent - the server requires it, and an omitted value
 * there would be reported as "required" rather than as the blank the user
 * actually left. An EMPTY list is still sent for the same reason: dropping the key
 * would read to the server as "leave what is stored alone", so removing the last
 * job and saving would silently do nothing.
 *
 * The schedule fields are only sent when they carry something: `scheduleHour` of
 * `""` would be read as an unusable number and rejected, when what the user meant
 * was "I did not set one".
 *
 * @param {object} values
 * @returns {object}
 */
export function buildSettingsPayload(values = {}) {
  const payload = {
    processingJobs: buildJobsPayload(values.processingJobs),
    scheduleEnabled: values.scheduleEnabled === true,
  };

  const frequency = typeof values.scheduleFrequency === "string" ? values.scheduleFrequency.trim() : "";
  if (frequency !== "") payload.scheduleFrequency = frequency;

  const hour = typeof values.scheduleHour === "string" ? values.scheduleHour.trim() : values.scheduleHour;
  if (hour !== "" && hour !== null && hour !== undefined) payload.scheduleHour = hour;

  const timezone = typeof values.timezone === "string" ? values.timezone.trim() : "";
  if (timezone !== "") payload.timezone = timezone;

  return payload;
}

/**
 * Build the `PUT /calendar/api/scan/schedule` body.
 *
 * `dayOfWeek` is only meaningful weekly, and the schedule route rejects a
 * missing one for a weekly schedule - so it is sent for weekly and left out
 * otherwise.
 *
 * @param {object} values
 * @returns {object}
 */
export function buildSchedulePayload(values = {}) {
  const frequency = typeof values.scheduleFrequency === "string" ? values.scheduleFrequency.trim() : "";
  const payload = {
    frequency,
    hour: typeof values.scheduleHour === "string" ? values.scheduleHour.trim() : values.scheduleHour,
    timezone: typeof values.timezone === "string" ? values.timezone.trim() : "",
  };
  if (frequency === "weekly") {
    payload.dayOfWeek = typeof values.dayOfWeek === "string" ? values.dayOfWeek.trim() : values.dayOfWeek;
  }
  return payload;
}

/** The browser's own zone, used as the default for a user who has none stored. */
export function detectTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/* ---------------------------------------------------------------------------
 * The processing-job rows (TASK-057, TASK-060)
 *
 * The ONLY nodes this file builds. Three rules hold throughout:
 *
 *  - EVERY node comes from `el()` / `createElement`, and every value reaches the
 *    DOM as an input's `value` or a `textContent` - see rule 1 of the docblock.
 *  - ELEMENT IDS ARE INDEX-BASED (`job-2-domains`), so they line up 1:1 with the
 *    server's `processingJobs[2].domains` error names and `fieldErrorId` can
 *    resolve one into the other. They are therefore only valid for the CURRENT
 *    render: never cache one across an add or a remove, and resolve controls
 *    through `data-job-index` at event time.
 *
 *    THAT 1:1 RULE IS WHY THE DOMAIN FIELD'S IDS WERE RENAMED with TASK-059's
 *    server-side `domain` -> `domains`: `fieldErrorId` builds
 *    `error-job-${index}-${key}` by concatenating the server's OWN key, so
 *    holding on to a `job-2-domain` element id while the server named `domains`
 *    would have needed a key-to-id mapping layer and would have broken the
 *    invariant this bullet states. The ids are `job-<i>-domains` and
 *    `error-job-<i>-domains`. Decided in TASK-060; do not re-open it.
 *  - HANDLERS ARE BOUND TO NODES THIS FUNCTION JUST CREATED, once each. The list
 *    is rebuilt wholesale on every structural change, so the old nodes and their
 *    listeners are discarded with them and nothing can stack. (Delegation on the
 *    container would be the other way to get that property; binding here keeps
 *    every control's handler next to the control it belongs to.)
 * ------------------------------------------------------------------------ */

/** The heading text for a row - the job's own name, or a placeholder if blank. */
function jobHeading(job, index) {
  const name = typeof job?.name === "string" ? job.name : "";
  // The RAW name, not a trimmed copy: the head has to read back as exactly what
  // is in the name input. Only the blank test is trimmed.
  return name.trim() === "" ? `New processing job ${index + 1}` : name;
}

/** A short, distinct description of a row, for accessible labels. */
function jobLabel(job, index) {
  const name = trimText(job?.name);
  return name === "" ? `processing job ${index + 1}` : `processing job "${name}"`;
}

/** An error slot matching the static `.field-error` markup in settings.html. */
function errorSlot(doc, id) {
  const node = el(doc, "p", "field-error");
  node.setAttribute("id", id);
  node.setAttribute("role", "alert");
  node.hidden = true;
  return node;
}

/** A text input with its label, its own error slot, and the `.field` wrapper. */
function jobField(doc, index, key, labelText, value, describedAs) {
  const field = el(doc, "div", "field");
  const id = `job-${index}-${key}`;

  const label = el(doc, "label", "field-label", labelText);
  label.setAttribute("for", id);
  field.appendChild(label);

  const input = el(doc, "input", "field-input");
  input.setAttribute("type", "text");
  input.setAttribute("id", id);
  input.setAttribute("data-job-index", String(index));
  input.setAttribute("autocomplete", "off");
  // The visible label reads "Name" on every row; the accessible one names the
  // row too, so a screen reader does not announce twenty identical fields.
  input.setAttribute("aria-label", `${labelText} for ${describedAs}`);
  // `value` is character data by definition - a hostile stored name lands here
  // as the literal characters and no element is ever created from it.
  input.value = typeof value === "string" ? value : "";
  field.appendChild(input);

  field.appendChild(errorSlot(doc, `error-${id}`));
  return field;
}

/** A `.btn btn-small` button carrying its row index. */
function rowButton(doc, id, text, index) {
  const button = el(doc, "button", "btn btn-small", text);
  // Always explicit: every one of these sits inside #settings-form, where a
  // default type="submit" would save the whole form on every tap.
  button.setAttribute("type", "button");
  button.setAttribute("id", id);
  button.setAttribute("data-job-index", String(index));
  return button;
}

/**
 * The arm-then-confirm removal, mirroring `initDisconnectControl`'s three rules:
 * the acting control does not exist until the user asks for it (a), the handler
 * re-checks the gate rather than trusting the button (b, in the controller), and
 * arming a different row invalidates a pending one (c, in the controller).
 *
 * A typed phrase - what the disconnect control uses - would be disproportionate
 * here and unusable on a phone across twenty rows: removing a job writes nothing,
 * so Cancel, or a reload, brings it straight back.
 */
function confirmBlock(doc, job, index, handlers, describedAs) {
  const block = el(doc, "div", "job__confirm");
  block.setAttribute("id", `job-${index}-confirm`);
  block.setAttribute("role", "group");

  // ONE textContent assignment, so the name cannot become markup.
  block.appendChild(el(doc, "p", null, `Remove ${jobHeading(job, index)}?`));
  block.appendChild(
    el(doc, "p", "field-hint", "Nothing is removed from your account until you press Save settings.")
  );

  const actions = el(doc, "div", "job__actions");
  const confirm = rowButton(doc, `confirm-remove-job-${index}`, "Confirm remove", index);
  confirm.setAttribute("aria-label", `Confirm removing ${describedAs}`);
  confirm.addEventListener("click", () => handlers.onConfirmRemoveJob?.(index));
  actions.appendChild(confirm);

  const cancel = rowButton(doc, `cancel-remove-job-${index}`, "Cancel", index);
  cancel.setAttribute("aria-label", `Keep ${describedAs}`);
  cancel.addEventListener("click", () => handlers.onCancelRemoveJob?.(index));
  actions.appendChild(cancel);

  block.appendChild(actions);
  return block;
}

/** One whole job block. */
function jobBlock(doc, job, index, handlers, confirming) {
  const section = el(doc, "section", "job");
  section.setAttribute("data-job-index", String(index));

  const serverId = trimText(job?.id);
  if (serverId !== "") {
    // Round-tripped on save so a rename cannot orphan TASK-056's attribution.
    section.setAttribute("data-job-id", serverId);
  } else {
    // Added this session. The temp id is in-memory bookkeeping for the
    // confirming-row state only; it is NEVER sent (see `buildJobsPayload`).
    section.setAttribute("data-job-new", "true");
    section.setAttribute("data-job-temp-id", trimText(job?.key));
  }

  const describedAs = jobLabel(job, index);
  const head = el(doc, "h3", "job__head", jobHeading(job, index));
  head.setAttribute("id", `job-${index}-head`);
  section.setAttribute("aria-labelledby", `job-${index}-head`);
  section.appendChild(head);

  section.appendChild(jobField(doc, index, "name", "Name", job?.name, describedAs));
  section.appendChild(jobField(doc, index, "schoolName", "School name", job?.schoolName, describedAs));
  // Both list fields are ONE ordinary text input each (TASK-060), built by the
  // same helper as the two scalar fields above and carrying the same
  // `error-job-<i>-<key>` slot - so `error-job-<i>-searchTerms`, the id the old
  // per-term block used to build by hand, still exists and a server 400 on
  // `processingJobs[<i>].searchTerms` still lands on it.
  section.appendChild(
    jobField(doc, index, "domains", "Email domains (comma separated)", joinCommaList(job?.domains), describedAs)
  );
  section.appendChild(
    jobField(
      doc,
      index,
      "searchTerms",
      "Search terms (comma separated)",
      joinCommaList(job?.searchTerms),
      describedAs
    )
  );

  if (confirming) {
    section.appendChild(confirmBlock(doc, job, index, handlers, describedAs));
  } else {
    const actions = el(doc, "div", "job__actions");
    const remove = rowButton(doc, `remove-job-${index}`, "Remove job", index);
    remove.setAttribute("aria-label", `Remove ${describedAs}`);
    remove.addEventListener("click", () => handlers.onRemoveJob?.(index));
    actions.appendChild(remove);
    section.appendChild(actions);
  }

  return section;
}

/**
 * Render the whole job list into `#processing-jobs`, and drive the empty hint.
 *
 * Order is the array's own, never re-sorted here: the server stores and returns
 * the list in the order the user built it, and the indexes in every element id
 * (and in every server error name) are positions in that same list.
 *
 * @param {Document} doc
 * @param {Element|null} container The `#processing-jobs` div.
 * @param {Array<object>} jobs Editable rows (see `toEditableJobs`).
 * @param {object} [handlers] `onRemoveJob`, `onConfirmRemoveJob`,
 *   `onCancelRemoveJob`, plus `confirmingKey` - the temp key of the one row, if
 *   any, currently armed for removal.
 * @returns {number} How many rows were rendered.
 */
export function renderProcessingJobs(doc, container, jobs, handlers = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];

  // The hint is static markup OUTSIDE the container (nothing here creates it),
  // so it is toggled rather than built.
  const empty = doc && typeof doc.getElementById === "function" ? doc.getElementById("processing-jobs-empty") : null;
  if (empty) empty.hidden = rows.length > 0;

  if (!container) return 0;
  clear(container);

  const confirmingKey = typeof handlers.confirmingKey === "string" ? handlers.confirmingKey : null;
  for (let index = 0; index < rows.length; index += 1) {
    const job = rows[index];
    const confirming = confirmingKey !== null && job?.key === confirmingKey;
    container.appendChild(jobBlock(doc, job, index, handlers, confirming));
  }
  return rows.length;
}

/**
 * Build the settings page controller.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.api]
 * @returns {object} The controller.
 */
export function createSettingsPage(options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("createSettingsPage: a document is required");

  const state = {
    settings: null,
    saving: false,
    lastPayload: null,
    // The editable rows. This - not `state.settings` - is what the list renders
    // from, because it carries everything the user has typed since the last save.
    jobs: [],
    // The temp key of the one row armed for removal, or null. At most one, ever.
    confirmingKey: null,
    // Which field the last add asked for focus on, so the intent is assertable
    // even in a document stand-in that has no focus management.
    focusFieldId: null,
  };
  const api = options.api || createApiClient({ fetchImpl: options.fetchImpl, onUnauthorized: () => renderSignedOut() });
  const byId = (id) => doc.getElementById(id);
  const fallbackTimezone = typeof options.detectTimezone === "function" ? options.detectTimezone : detectTimezone;

  // A client-side key per row, never sent anywhere. It exists only so the
  // confirming-row state survives the re-render that displays it: an index would
  // do until a row above it moved, and a server id does not exist yet on a row
  // the user just added.
  let keySeq = 0;
  const nextKey = () => {
    keySeq += 1;
    return `row-${keySeq}`;
  };

  /**
   * Every field error line, cleared before each save so none can linger.
   *
   * The static table is not enough: the per-row slots are built by the renderer
   * and are not in it, so a stale "name is required" would survive the next save
   * and - after a removal shifted the indexes - point at the wrong row.
   */
  function clearErrors() {
    const ids = new Set(Object.values(FIELD_ERROR_IDS));
    ids.add(FORM_ERROR_ID);
    for (const id of ids) {
      const node = byId(id);
      if (!node) continue;
      node.textContent = "";
      node.hidden = true;
    }

    const container = byId("processing-jobs");
    if (!container || typeof container.querySelectorAll !== "function") return;
    for (const node of container.querySelectorAll(".field-error")) {
      node.textContent = "";
      node.hidden = true;
    }
  }

  /**
   * Show a server-named field error against its field.
   *
   * The message is the server's own, which settings.mjs builds to be
   * client-safe and length-caps any echoed value; it is set with `textContent`
   * regardless, because it can contain a value the user typed.
   *
   * FALLS BACK TO THE FORM LINE WHEN THE NAMED SLOT IS NOT ON THE PAGE. A 400 can
   * legitimately name `processingJobs[9].name` when three rows are on screen - the
   * user removed one after the request went out - and showing nothing at all would
   * leave a save that failed for no stated reason.
   */
  function showFieldError(field, message) {
    let id = fieldErrorId(field);
    let node = byId(id);
    if (!node && id !== FORM_ERROR_ID) {
      id = FORM_ERROR_ID;
      node = byId(id);
    }
    const text = textOr(message, "That value was not accepted.");
    if (!node) return { id, shown: false, text };
    node.textContent = text;
    node.hidden = false;
    return { id, shown: true, text };
  }

  function setStatus(message, isProblem) {
    const node = byId("settings-status");
    if (!node) return;
    const text = typeof message === "string" ? message : "";
    node.textContent = text;
    node.className = isProblem ? "notice notice--problem" : "notice";
    node.hidden = text === "";
  }

  function renderSummary(settings) {
    const node = byId("settings-summary");
    if (!node) return;
    clear(node);
    const jobNames = processingJobEntries(settings?.processingJobs).map((job) => job.name.trim());
    if (jobNames.length === 0) {
      node.appendChild(
        el(doc, "span", null, "No processing job saved yet. Add one below and we can start looking.")
      );
      return;
    }
    node.appendChild(el(doc, "span", null, "Watching mail for "));
    // TEXT, and the JOINED string is one text node - the list is never assembled
    // as markup. Each name is stored raw; this is where that is made safe.
    const name = el(doc, "strong", "settings-summary-name", jobNames.join(", "));
    name.setAttribute("id", "settings-school-name");
    node.appendChild(name);
  }

  const inputValue = (id, fallback) => {
    const node = byId(id);
    return node && typeof node.value === "string" ? node.value : fallback;
  };

  /**
   * Read the rows back out of the DOM, keeping each row's key and server id.
   *
   * THE CONTROLLER DOES NOT OBSERVE TYPING - there is no `input` listener, because
   * a re-render on keystroke would destroy the focused field and make the form
   * impossible to type into. So unsaved edits live ONLY in the DOM, and this has
   * to run before every re-render. Re-rendering from `state.settings` instead
   * would silently discard everything typed since the last save.
   *
   * A row whose input is missing (a stripped page, a test harness with no
   * container) falls back to the value already in state rather than to "". For
   * the two comma-separated fields that fallback is the ARRAY in state, not the
   * result of splitting "": an absent input means "nothing was read", which must
   * not read as "the user cleared the field".
   *
   * NORMALISATION ON RE-RENDER IS ACCEPTED, AND VISIBLE. This function parses and
   * `renderJobs` re-joins, so any structural action (add a job, remove one, arm
   * or cancel a removal) rewrites an in-progress "a, b," as "a, b". That is
   * `splitCommaList`'s tolerance made visible rather than a bug: nothing is
   * cleared or reordered, and the only thing lost is an empty piece the user
   * could not have meant.
   */
  function readJobsFromDom() {
    // `null` is the sentinel for "no such input on the page" - "" is a real value
    // (the user cleared the field) and the two must not be confused.
    const listValue = (id, stored) => {
      const text = inputValue(id, null);
      if (text === null) return Array.isArray(stored) ? stored : [];
      return splitCommaList(text);
    };
    return state.jobs.map((job, index) => ({
      ...job,
      name: inputValue(`job-${index}-name`, job.name),
      schoolName: inputValue(`job-${index}-schoolName`, job.schoolName),
      domains: listValue(`job-${index}-domains`, job.domains),
      searchTerms: listValue(`job-${index}-searchTerms`, job.searchTerms),
    }));
  }

  /** Pull the DOM back into state. Every mutation below starts here. */
  function syncJobsFromDom() {
    state.jobs = readJobsFromDom();
    return state.jobs;
  }

  function renderJobs() {
    return renderProcessingJobs(doc, byId("processing-jobs"), state.jobs, {
      confirmingKey: state.confirmingKey,
      onRemoveJob: armRemoveJob,
      onConfirmRemoveJob: confirmRemoveJob,
      onCancelRemoveJob: cancelRemoveJob,
    });
  }

  /**
   * Move the caret to a field the user is now expected to type into.
   *
   * The id is also recorded on `state`, because the intent is what matters and a
   * document stand-in has no focus management to observe.
   */
  function focusField(id) {
    state.focusFieldId = id;
    const node = byId(id);
    if (node && typeof node.focus === "function") node.focus();
  }

  /** Append one blank row and put the caret in its name field. */
  function addJob() {
    syncJobsFromDom();
    // Adding a row changes the list the pending confirmation was aimed at.
    state.confirmingKey = null;
    state.jobs.push({ ...emptyProcessingJob(), key: nextKey() });
    renderJobs();
    focusField(`job-${state.jobs.length - 1}-name`);
    return state.jobs.length;
  }

  /**
   * Arm a row for removal. NOTHING is removed here.
   *
   * Rule (a) of the disconnect control: the control that performs the destructive
   * step does not exist until the user has explicitly asked for it. Rule (c):
   * arming this row clears whatever was armed before, so at most one is ever
   * pending.
   */
  function armRemoveJob(index) {
    syncJobsFromDom();
    const job = state.jobs[index];
    state.confirmingKey = job ? job.key : null;
    renderJobs();
  }

  function cancelRemoveJob() {
    syncJobsFromDom();
    state.confirmingKey = null;
    renderJobs();
  }

  /**
   * Remove the armed row from the client-side list. Nothing is sent; the removal
   * is only persisted when the user presses Save.
   */
  function confirmRemoveJob(index) {
    syncJobsFromDom();
    const job = state.jobs[index];
    // Rule (b): the gate is re-checked here rather than inferred from the button
    // having been rendered at all.
    if (!job || state.confirmingKey === null || job.key !== state.confirmingKey) {
      state.confirmingKey = null;
      renderJobs();
      return false;
    }
    state.jobs.splice(index, 1);
    state.confirmingKey = null;
    renderJobs();
    return true;
  }

  function readForm() {
    const value = (id) => inputValue(id, "");
    const checked = (id) => {
      const node = byId(id);
      return Boolean(node && node.checked);
    };
    return {
      processingJobs: readJobsFromDom(),
      scheduleEnabled: checked("schedule-enabled-input"),
      scheduleFrequency: value("schedule-frequency-input"),
      scheduleHour: value("schedule-hour-input"),
      dayOfWeek: value("schedule-day-input"),
      timezone: value("timezone-input"),
    };
  }

  function fillForm(settings) {
    const set = (id, text) => {
      const node = byId(id);
      // A control's `value` is character data - never parsed as markup - so a
      // hostile school name lands in the box as the literal characters typed.
      if (node) node.value = text;
    };
    // Replaces the rows wholesale from the server's answer, which is how a
    // server-assigned `id` lands on a row that was created in this session. Any
    // pending confirmation is aimed at rows that no longer exist.
    state.jobs = toEditableJobs(settings?.processingJobs).map((job) => ({ ...job, key: nextKey() }));
    state.confirmingKey = null;
    renderJobs();

    set("schedule-frequency-input", typeof settings?.scheduleFrequency === "string" ? settings.scheduleFrequency : "daily");
    set(
      "schedule-hour-input",
      Number.isFinite(settings?.scheduleHour) ? String(settings.scheduleHour) : String(DEFAULT_SCHEDULE_HOUR)
    );
    // The settings projection has no day-of-week attribute; the schedule
    // endpoint calls it `dayOfWeek`. Read either, and fall back to Sunday.
    const storedDay = Number.isFinite(settings?.scheduleDayOfWeek)
      ? settings.scheduleDayOfWeek
      : Number.isFinite(settings?.dayOfWeek)
        ? settings.dayOfWeek
        : 0;
    set("schedule-day-input", String(storedDay));
    set("timezone-input", typeof settings?.timezone === "string" && settings.timezone !== "" ? settings.timezone : fallbackTimezone());

    const enabled = byId("schedule-enabled-input");
    if (enabled) enabled.checked = settings?.scheduleEnabled === true;
  }

  function renderSignedOut() {
    state.settings = null;
    renderConnectionCards(doc, byId("connection-state"), null);
    const body = byId("settings-body");
    if (body) body.hidden = true;
  }

  async function load() {
    const result = await api.get(SETTINGS_ENDPOINT);
    if (!result.ok) {
      if (result.status === 401) return result;
      setStatus("We could not read your settings just now. Please reload the page.", true);
      return result;
    }
    state.settings = result.data || {};
    // The settings body is the same projection /auth/me returns, so the same
    // connection cards can be driven straight from it.
    renderConnectionCards(doc, byId("connection-state"), state.settings);
    renderSummary(state.settings);
    fillForm(state.settings);
    const body = byId("settings-body");
    if (body) body.hidden = false;
    return result;
  }

  /**
   * Push the recurring schedule to EventBridge.
   *
   * Runs only after the settings save succeeded, and its outcome is reported
   * separately: `{ available: false }` means the scheduling feature is not
   * provisioned in this environment, which is a normal answer and not a failure
   * the user should be shown as red.
   */
  async function syncSchedule(values) {
    if (values.scheduleEnabled !== true) {
      return api.del(SCHEDULE_ENDPOINT);
    }
    return api.put(SCHEDULE_ENDPOINT, buildSchedulePayload(values));
  }

  /**
   * Save. Returns a result object so the outcome is assertable rather than
   * only visible.
   *
   * @returns {Promise<{ ok: boolean, status: number, field?: string|null, error?: string }>}
   */
  async function save() {
    if (state.saving) return { ok: false, status: 0, error: "A save is already in flight" };
    state.saving = true;
    const button = byId("save-settings");
    if (button) button.disabled = true;
    clearErrors();
    setStatus("Saving...", false);

    try {
      const values = readForm();

      // The pre-flight of rule 2 - required fields and duplicate names only. It
      // runs AFTER clearErrors/setStatus so the page has already been reset, and
      // BEFORE the request so a problem it can name costs no round trip. The
      // `finally` below still releases `state.saving` and re-enables the button
      // on this path; without that, one bad save would lock the form.
      const problem = validateProcessingJobsClient(values.processingJobs);
      if (problem) {
        showFieldError(problem.field, problem.error);
        setStatus("Nothing was saved - please fix the highlighted field.", true);
        return { ok: false, status: 0, field: problem.field, error: problem.error };
      }

      const payload = buildSettingsPayload(values);
      state.lastPayload = payload;

      const result = await api.put(SETTINGS_ENDPOINT, payload);

      if (result.status === 400) {
        const field = result.data?.field ?? null;
        const message = result.data?.error;
        showFieldError(field, message);
        setStatus("Nothing was saved - please fix the highlighted field.", true);
        return { ok: false, status: 400, field, error: textOr(message, "") };
      }

      if (!result.ok) {
        if (result.status !== 401) setStatus("We could not save your settings just now. Please try again.", true);
        return { ok: false, status: result.status };
      }

      state.settings = result.data || {};
      renderConnectionCards(doc, byId("connection-state"), state.settings);
      renderSummary(state.settings);
      fillForm(state.settings);

      const schedule = await syncSchedule(values);
      if (schedule.status === 400) {
        showFieldError(schedule.data?.field ?? null, schedule.data?.error);
        setStatus("Your school was saved, but the automatic scan schedule was not.", true);
        return { ok: true, status: result.status, scheduleOk: false, field: schedule.data?.field ?? null };
      }
      if (!schedule.ok && schedule.status !== 401) {
        setStatus("Your school was saved. The automatic scan schedule could not be updated.", true);
        return { ok: true, status: result.status, scheduleOk: false };
      }
      if (schedule.data && schedule.data.available === false) {
        setStatus("Saved. Automatic scanning is not available in this environment yet.", false);
        return { ok: true, status: result.status, scheduleOk: true, scheduleAvailable: false };
      }

      setStatus("Saved.", false);
      return { ok: true, status: result.status, scheduleOk: true };
    } finally {
      state.saving = false;
      if (button) button.disabled = false;
    }
  }

  function bindControls() {
    // Bound ONCE, at start, because this button is static markup that no
    // re-render replaces. Binding it inside the render would stack a handler per
    // render and one tap would then add ten rows. The per-row controls get the
    // same property the other way round: their nodes are discarded and rebuilt by
    // every render, so each carries exactly one listener.
    const addButton = byId("add-processing-job");
    if (addButton) addButton.addEventListener("click", () => addJob());

    const form = byId("settings-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        save();
      });
      return;
    }
    // No form element (a stripped-down page, or a test harness): fall back to
    // the button so the page is still usable rather than quietly inert.
    const button = byId("save-settings");
    if (button) button.addEventListener("click", () => save());
  }

  async function start() {
    bindControls();
    const loaded = await load();
    return { started: loaded.ok === true, loaded };
  }

  return {
    state,
    api,
    start,
    load,
    save,
    readForm,
    fillForm,
    renderSummary,
    showFieldError,
    clearErrors,
    setStatus,
    // The job list, for tests and for anything that needs to drive it without a
    // click. `renderProcessingJobs` here renders the CURRENT state, unlike the
    // module-level function of the same name which takes its rows as an argument.
    renderProcessingJobs: renderJobs,
    readJobsFromDom,
    addJob,
    armRemoveJob,
    cancelRemoveJob,
    confirmRemoveJob,
  };
}

/**
 * Start the settings page against the real document.
 *
 * @param {object} [options] Forwarded to `createSettingsPage`.
 * @returns {object} The controller.
 */
export function bootstrapSettings(options = {}) {
  const page = createSettingsPage(options);
  page.start();
  return page;
}


/* ===========================================================================
 * DISCONNECT GMAIL (TASK-013)
 *
 * Self-contained: the helpers below are pure and the control binds itself
 * through an injected `root`/`fetch`, so nothing here depends on the settings
 * form above and nothing above depends on it. Kept in this module because it
 * is part of the same page; merged additively when TASK-010 and TASK-013 both
 * landed a settings.js.
 * ======================================================================== */

/** Where the disconnect request goes. Mirrors AUTH_DISCONNECT_PATH in index.mjs. */
export const DISCONNECT_ENDPOINT = "/calendar/api/auth/disconnect";

/**
 * The phrase the user must type, per choice.
 *
 * TWO DIFFERENT PHRASES ON PURPOSE. A single phrase would let someone type it
 * while "keep my calendar" is selected, change their mind, switch to "delete
 * everything" and submit - with the confirmation for the milder action standing
 * in for the irreversible one. Changing the choice invalidates the typed text,
 * so the destructive option is always confirmed on its own terms.
 */
export const CONFIRM_PHRASE_KEEP = "DISCONNECT";
export const CONFIRM_PHRASE_DELETE = "DELETE MY EVENTS";

/**
 * Which phrase applies to a choice.
 *
 * @param {boolean} deleteEvents
 * @returns {string}
 */
export function requiredConfirmation(deleteEvents) {
  return deleteEvents === true ? CONFIRM_PHRASE_DELETE : CONFIRM_PHRASE_KEEP;
}

/**
 * Has the user typed the phrase this choice requires?
 *
 * Surrounding whitespace is forgiven (a paste or a mobile keyboard adds it);
 * case is NOT. A confirmation that accepts "delete my events" is a confirmation
 * you can type without noticing, which is the opposite of the point.
 *
 * Anything that is not a string is false, so an absent input element - a page
 * whose markup drifted - cannot read as "confirmed".
 *
 * @param {unknown} typed
 * @param {boolean} deleteEvents
 * @returns {boolean}
 */
export function isConfirmed(typed, deleteEvents) {
  if (typeof typed !== "string") return false;
  return typed.trim() === requiredConfirmation(deleteEvents);
}

/**
 * The request body for a disconnect.
 *
 * `deleteEvents` is always sent explicitly, and always as a real boolean, so the
 * server never has to infer intent from an absent field.
 *
 * @param {boolean} deleteEvents
 * @returns {{ deleteEvents: boolean }}
 */
export function disconnectRequestBody(deleteEvents) {
  return { deleteEvents: deleteEvents === true };
}

/**
 * Turn a disconnect response body into the sentence the user sees.
 *
 * `eventsDeleteComplete: false` is reported, not smoothed over: it means rows
 * may still be there, and a page that says "all your events were deleted"
 * anyway would be lying about the one thing the user came here to be sure of.
 *
 * @param {object} result Parsed 200 body from the disconnect route.
 * @returns {string}
 */
export function disconnectSummary(result) {
  const parts = [];
  parts.push(
    result?.revoked === true
      ? "Access to your Gmail account has been revoked."
      : "There was no stored Gmail authorisation to revoke."
  );
  const deleted = Number.isFinite(result?.eventsDeleted) ? result.eventsDeleted : 0;
  if (result?.eventsDeleteComplete === false) {
    parts.push(`${deleted} event(s) were deleted, but some may remain. Please try disconnecting again.`);
  } else if (deleted > 0) {
    parts.push(`${deleted} event(s) were deleted.`);
  } else {
    parts.push("Your calendar was kept.");
  }
  return parts.join(" ");
}

/**
 * Wire the disconnect section up.
 *
 * Returns null (rather than throwing) when the section is not on the page, so
 * this can be called unconditionally from a shared settings bootstrap.
 *
 * @param {object} [options]
 * @param {Document|Element} [options.root] Where to look the elements up.
 * @param {(url: string, init: object) => Promise<any>} [options.fetchImpl]
 * @param {(result: object) => void} [options.onDisconnected] Called after a 200.
 * @returns {object|null} The bound elements and a `refresh` for tests.
 */
export function initDisconnectControl({ root = globalThis.document, fetchImpl, onDisconnected } = {}) {
  if (!root || typeof root.querySelector !== "function") return null;

  const section = root.querySelector("#disconnect-gmail");
  const deleteRadio = root.querySelector("#disconnect-events-delete");
  const keepRadio = root.querySelector("#disconnect-events-keep");
  const phrase = root.querySelector("#disconnect-confirm-phrase");
  const confirmInput = root.querySelector("#disconnect-confirm");
  const submit = root.querySelector("#disconnect-submit");
  const status = root.querySelector("#disconnect-status");
  if (!section || !deleteRadio || !keepRadio || !confirmInput || !submit) return null;

  const wantsDelete = () => deleteRadio.checked === true;

  const setStatus = (text) => {
    // textContent, never innerHTML - see the module docblock.
    if (status) status.textContent = text;
  };

  const refresh = () => {
    if (phrase) phrase.textContent = requiredConfirmation(wantsDelete());
    // The button is the gate. It starts disabled in the markup too, so a page
    // whose script failed to load cannot submit an unconfirmed disconnect.
    submit.disabled = !isConfirmed(confirmInput.value, wantsDelete());
  };

  const onChoiceChange = () => {
    // Switching choice invalidates the confirmation: the phrase it matched was
    // for the other action.
    confirmInput.value = "";
    setStatus("");
    refresh();
  };

  confirmInput.addEventListener("input", refresh);
  deleteRadio.addEventListener("change", onChoiceChange);
  keepRadio.addEventListener("change", onChoiceChange);

  submit.addEventListener("click", async () => {
    const deleteEvents = wantsDelete();
    // Re-checked at submit time, not trusted from the disabled attribute: the
    // attribute is a hint to the user, this is the actual gate.
    if (!isConfirmed(confirmInput.value, deleteEvents)) {
      refresh();
      return;
    }

    submit.disabled = true;
    setStatus("Disconnecting...");

    const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    let response;
    try {
      response = await doFetch(DISCONNECT_ENDPOINT, {
        method: "POST",
        // The session cookie is the only credential; without this the request
        // is unauthenticated and comes back 401.
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(disconnectRequestBody(deleteEvents)),
      });
    } catch {
      setStatus("Could not reach the server. Nothing was changed - please try again.");
      refresh();
      return;
    }

    if (!response?.ok) {
      // 502 is the retryable one: the grant could not be revoked and NOTHING was
      // deleted, which is exactly what the user needs to be told.
      setStatus(
        response?.status === 502
          ? "Google could not be reached to revoke access. Nothing was deleted - please try again."
          : "Could not disconnect your Google account. Please try again."
      );
      refresh();
      return;
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    setStatus(disconnectSummary(result || {}));
    if (typeof onDisconnected === "function") onDisconnected(result || {});
  });

  refresh();
  return { section, deleteRadio, keepRadio, confirmInput, submit, status, refresh };
}


// Browser only, and only on the settings page. ONE bootstrap for the whole
// page: it starts the settings form and binds the disconnect control. Module
// scripts are deferred, so the body exists by the time this runs. The
// data-page guard is what keeps app.js (imported above for its shared helpers)
// from starting a second calendar here, and it keeps this block inert in a test
// runner, where there is no document at all.
if (typeof document !== "undefined" && document.body && document.body.getAttribute("data-page") === "settings") {
  bootstrapSettings();
  // Returns null when the section is absent, so this is safe to call blind.
  initDisconnectControl();
}
