/**
 * School calendar - settings page.
 *
 * The school name, the sender domains that count as school mail, and the
 * recurring-scan controls. Shares its API client, its connection cards and its
 * text helpers with app.js (same origin, plain ES module import, no bundler).
 *
 * TWO THINGS WORTH KNOWING BEFORE CHANGING THIS FILE.
 *
 * 1. `schoolName` IS RENDERED AS TEXT, always. It is stored raw - the storage
 *    layer in backend/settings.mjs names escaping-on-render as its mitigation -
 *    so a stored `<img src=x onerror=alert(1)>` has to come back out as those
 *    literal characters. It reaches the page in exactly two places: an input's
 *    `value` (character data by definition) and a `textContent` assignment. No
 *    markup is ever assembled from it, here or anywhere else.
 *
 * 2. VALIDATION IS THE SERVER'S JOB AND THIS PAGE DOES NOT SECOND-GUESS IT.
 *    The form sends what the user typed and renders whatever `400 { error,
 *    field }` comes back next to the field that was named. Re-implementing the
 *    rules here would give two sources of truth that drift, and would let a page
 *    that is out of date silently refuse a value the server would have accepted.
 *    The one thing done locally is splitting the domains textarea into a list,
 *    which is a shape change, not a rule.
 */

import {
  API_BASE,
  clear,
  createApiClient,
  el,
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
 */
export const FIELD_ERROR_IDS = Object.freeze({
  schoolName: "error-schoolName",
  searchDomains: "error-searchDomains",
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
 * Resolve the element id for a server-named field, failing closed.
 *
 * @param {unknown} field
 * @returns {string} An id that exists in settings.html.
 */
export function fieldErrorId(field) {
  if (typeof field !== "string") return FORM_ERROR_ID;
  return Object.prototype.hasOwnProperty.call(FIELD_ERROR_IDS, field) ? FIELD_ERROR_IDS[field] : FORM_ERROR_ID;
}

/**
 * Split the domains textarea into a list.
 *
 * Commas, semicolons, newlines and spaces all separate. Entries are lower-cased
 * because a domain is case-insensitive and the server's label pattern is
 * lowercase-only, so "School.NSW.edu.au" would otherwise be rejected for a
 * reason the user cannot see. Duplicates are collapsed.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseDomainList(text) {
  const seen = new Set();
  const domains = [];
  for (const part of String(text ?? "").split(/[\s,;]+/)) {
    const entry = part.trim().toLowerCase();
    if (entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    domains.push(entry);
  }
  return domains;
}

/** Render a stored domain list back into the textarea, one per line. */
export function formatDomainList(domains) {
  return (Array.isArray(domains) ? domains : []).map((entry) => String(entry)).join("\n");
}

/**
 * Build the `PUT /calendar/api/settings` body from the form's raw values.
 *
 * `schoolName` and `searchDomains` are always sent - the server requires both,
 * and an omitted value there would be reported as "required" rather than as the
 * blank the user actually left. The schedule fields are only sent when they
 * carry something: `scheduleHour` of `""` would be read as an unusable number
 * and rejected, when what the user meant was "I did not set one".
 *
 * @param {object} values
 * @returns {object}
 */
export function buildSettingsPayload(values = {}) {
  const payload = {
    schoolName: typeof values.schoolName === "string" ? values.schoolName.trim() : "",
    searchDomains: parseDomainList(values.domainsText),
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

  const state = { settings: null, saving: false, lastPayload: null };
  const api = options.api || createApiClient({ fetchImpl: options.fetchImpl, onUnauthorized: () => renderSignedOut() });
  const byId = (id) => doc.getElementById(id);
  const fallbackTimezone = typeof options.detectTimezone === "function" ? options.detectTimezone : detectTimezone;

  /** Every field error line, cleared before each save so none can linger. */
  function clearErrors() {
    const ids = new Set(Object.values(FIELD_ERROR_IDS));
    ids.add(FORM_ERROR_ID);
    for (const id of ids) {
      const node = byId(id);
      if (!node) continue;
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
   */
  function showFieldError(field, message) {
    const id = fieldErrorId(field);
    const node = byId(id);
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
    const schoolName = typeof settings?.schoolName === "string" ? settings.schoolName.trim() : "";
    if (schoolName === "") {
      node.appendChild(el(doc, "span", null, "No school saved yet. Add one below and we can start looking."));
      return;
    }
    node.appendChild(el(doc, "span", null, "Watching mail for "));
    // TEXT. schoolName is stored raw; this is where that is made safe.
    const name = el(doc, "strong", "settings-summary-name", schoolName);
    name.setAttribute("id", "settings-school-name");
    node.appendChild(name);
  }

  function readForm() {
    const value = (id) => {
      const node = byId(id);
      return node && typeof node.value === "string" ? node.value : "";
    };
    const checked = (id) => {
      const node = byId(id);
      return Boolean(node && node.checked);
    };
    return {
      schoolName: value("school-name-input"),
      domainsText: value("search-domains-input"),
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
      // An input's `value` is character data - never parsed as markup - so a
      // hostile schoolName lands in the box as the literal characters typed.
      if (node) node.value = text;
    };
    set("school-name-input", typeof settings?.schoolName === "string" ? settings.schoolName : "");
    set("search-domains-input", formatDomainList(settings?.searchDomains));
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

// Browser only, and only on the settings page.
if (typeof document !== "undefined" && document.body && document.body.getAttribute("data-page") === "settings") {
  bootstrapSettings();
}
