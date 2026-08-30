/**
 * School calendar - browser application.
 *
 * Vanilla ES module. No build step, no bundler and no third-party script: the
 * Lambda is the only origin the page is allowed to talk to, and a remote
 * <script src> would be both an external dependency to review and something the
 * WAF can block outright.
 *
 * TWO RULES RUN THROUGH THIS WHOLE FILE.
 *
 * 1. EVERY VALUE THAT CAME OUT OF AN EMAIL IS TEXT, NEVER MARKUP. Titles,
 *    descriptions, locations, categories, subjects and sender addresses are all
 *    attacker-influenced: anyone who can send mail to the account can choose
 *    them. So the DOM is built exclusively with `document.createElement` and
 *    `textContent`. No HTML string is ever assembled and assigned into the
 *    document - not from data, not from constants. The same rule is applied to
 *    every `schoolNames` entry, which comes from settings rather than from mail:
 *    they are still stored raw (see backend/settings.mjs, which names
 *    escaping-on-render as its mitigation), so they are still rendered as text
 *    here - the joined list goes into ONE `textContent`, never into markup.
 *
 * 2. A DATE-ONLY DAY IS A CALENDAR DATE, NOT AN INSTANT. `new Date("2026-09-04")`
 *    parses as UTC midnight, which in Denver is 2026-09-03 at 18:00 - so an
 *    all-day event handed to the local-time formatter lands on the wrong day for
 *    every user west of UTC. `eventDateKey` therefore reads the calendar date
 *    out of the string for all-day events and never converts it. Timed events
 *    are converted, because for them the local instant IS the answer.
 *
 * Everything pure is exported so it can be tested without a DOM, and the
 * rendering layer takes its `document`, `fetch` and clock by injection for the
 * same reason. The bootstrap at the foot of the file only runs in a browser, and
 * only on the calendar page - settings.js imports this module for its shared
 * helpers and must not start a calendar.
 */

/** Base path of the JSON API. Same origin as this file, always. */
export const API_BASE = "/calendar/api";

/** Where the "Connect your Gmail account" action sends the browser. */
export const AUTH_START_URL = "/calendar/api/auth/google/start";

/** The settings page, linked from the school-setup prompt. */
export const SETTINGS_URL = "/calendar/settings";

/**
 * Credentials mode for every request this app makes.
 *
 * The session lives in a HttpOnly cookie, so a request sent without credentials
 * is silently anonymous and comes back 401 - which would look exactly like an
 * expired session and send the user round the sign-in loop for nothing.
 * "same-origin" (not "include") because the API is same-origin by construction
 * and there is no reason to offer the cookie to anywhere else.
 */
export const FETCH_CREDENTIALS = "same-origin";

/** How many event chips a day cell shows before it offers "+N more". */
export const MAX_CHIPS_PER_DAY = 3;

/**
 * How many attention rows the panel shows before it offers "Show N more".
 *
 * The overflow is hidden rather than dropped, so nothing a parent has to act on
 * is ever unreachable - it just stops the panel growing without limit down a
 * phone screen, which is the whole reason the cap exists.
 */
export const MAX_ATTENTION_ITEMS = 5;

/** Background refresh cadence for the two lists. */
export const REFRESH_INTERVAL_MS = 60000;

/** `lastScanStatus` value meaning the stored Gmail grant no longer works. */
export const REAUTH_SCAN_STATUS = "reauth_required";

/** Visible copy that other code (and the tests) match on. */
export const CONNECT_PROMPT = "Connect your Gmail account";
export const SCHOOL_PROMPT = "Tell us your school";
export const REAUTH_PROMPT = "Reconnect Gmail";

/**
 * Shown when the scan endpoint answers 409.
 *
 * Deliberately phrased so the sentence contains the words "a scan is already
 * running" in the same case the user reads them, rather than burying the fact in
 * a generic "please try again".
 */
export const SCAN_BUSY_MESSAGE = "Not started: a scan is already running. Try again once it finishes.";

/** Appended when a scan stopped at its cap - the user must know mail was left. */
export const SCAN_TRUNCATED_MESSAGE =
  "The scan reached its limit, so more mail remains unscanned - run it again to keep going.";

/** Shown when an acknowledge/dismiss did not land and the row was put back. */
export const RESTORE_MESSAGE = "That did not save, so the reminder has been put back. Please try again.";

/** Weekday column headings, Sunday first (matches `buildMonthMatrix`). */
export const WEEKDAY_LABELS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

// --- Small DOM helpers -------------------------------------------------------

/**
 * Create an element with an optional class and an optional TEXT body.
 *
 * The text goes through `textContent`, which is the whole of the escaping story
 * in this app: the browser stores it as character data, so `<img src=x
 * onerror=alert(1)>` is displayed as those literal characters and no element is
 * ever created from it.
 *
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {unknown} [text] Coerced with String() when present.
 * @returns {Element}
 */
export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Empty a node by removing its children one at a time.
 *
 * This is why no HTML string is needed anywhere: clearing a container is the one
 * job people normally reach for a markup assignment to do.
 *
 * @param {Element} node
 */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Text for a value that may be missing, without ever rendering "null".
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function textOr(value, fallback = "Not recorded") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

// --- Dates -------------------------------------------------------------------

/**
 * Is this a bare calendar date (`YYYY-MM-DD`) with no time component?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * The local calendar date of a Date, as `YYYY-MM-DD`.
 *
 * Built from the LOCAL getters rather than `toISOString().slice(0, 10)`, which
 * would give the UTC date and put an evening event on tomorrow for anyone east
 * of UTC.
 *
 * @param {Date} date
 * @returns {string}
 */
export function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Which day cell an event belongs in.
 *
 * All-day events are placed by their STORED calendar date, read straight out of
 * the string, with no Date conversion anywhere on the path. The store
 * canonicalises a date-only `startsAt` to `...T00:00:00.000Z` and sets
 * `allDay: true` (see backend/events.mjs `normaliseInstant`), so both shapes -
 * the bare `2026-09-04` and the canonical UTC-midnight form - have to be handled
 * here, and both resolve to `2026-09-04` in Denver exactly as they do in Sydney.
 *
 * Timed events ARE converted to local time, because for them the instant is the
 * fact and the local day is what the user means by "when".
 *
 * @param {object} event
 * @returns {string|null} `YYYY-MM-DD`, or null when there is no usable start.
 */
export function eventDateKey(event) {
  const raw = typeof event?.startsAt === "string" ? event.startsAt.trim() : "";
  if (!raw) return null;
  // No timezone shift for a bare date - see the module docblock.
  if (isDateOnly(raw)) return raw;
  if (event?.allDay === true) {
    const head = raw.slice(0, 10);
    return isDateOnly(head) ? head : null;
  }
  const epochMs = Date.parse(raw);
  if (Number.isNaN(epochMs)) return null;
  return localDateKey(new Date(epochMs));
}

/**
 * The inclusive `from`/`to` bounds of a month, for `GET /calendar/api/events`.
 *
 * Built through `Date.UTC` so the arithmetic cannot drift by a day depending on
 * where the browser is; the result is a pair of calendar dates, not instants,
 * and the API expands the `to` bound to the end of that day itself.
 *
 * @param {number} year
 * @param {number} monthIndex 0-11.
 * @returns {{ from: string, to: string }}
 */
export function monthRange(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * The month laid out as weeks of seven day cells, Sunday first.
 *
 * Leading and trailing cells belong to the neighbouring months and are marked
 * `inMonth: false`, so the grid is always rectangular while the count of
 * `inMonth` cells is exactly the number of days in the month.
 *
 * @param {number} year
 * @param {number} monthIndex 0-11.
 * @returns {Array<Array<{ dateKey: string, dayOfMonth: number, inMonth: boolean }>>}
 */
export function buildMonthMatrix(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const leading = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const cells = [];
  const push = (date, inMonth) => {
    cells.push({ dateKey: date.toISOString().slice(0, 10), dayOfMonth: date.getUTCDate(), inMonth });
  };

  for (let offset = leading; offset > 0; offset -= 1) push(new Date(Date.UTC(year, monthIndex, 1 - offset)), false);
  for (let day = 1; day <= daysInMonth; day += 1) push(new Date(Date.UTC(year, monthIndex, day)), true);
  let trailing = 1;
  while (cells.length % 7 !== 0) {
    push(new Date(Date.UTC(year, monthIndex + 1, trailing)), false);
    trailing += 1;
  }

  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** Minutes past local midnight, used only to order chips within one day. */
function startSortValue(event) {
  if (!event) return Number.POSITIVE_INFINITY;
  // All-day items sit at the top of the cell, in their own band.
  if (event.allDay === true || isDateOnly(event.startsAt)) return -1;
  const epochMs = Date.parse(String(event.startsAt ?? ""));
  if (Number.isNaN(epochMs)) return Number.POSITIVE_INFINITY;
  const local = new Date(epochMs);
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * Order two events by start time within a day, ties broken by title so the
 * order is stable between renders.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareByStart(a, b) {
  const left = startSortValue(a);
  const right = startSortValue(b);
  if (left === right) return String(a?.title ?? "").localeCompare(String(b?.title ?? ""));
  return left - right;
}

/**
 * Bucket a flat event list by day cell, each bucket ordered by start time.
 *
 * @param {object[]} events
 * @returns {Map<string, object[]>}
 */
export function groupEventsByDay(events) {
  const byDay = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = eventDateKey(event);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(event);
  }
  for (const list of byDay.values()) list.sort(compareByStart);
  return byDay;
}

/**
 * Split one day's events into the all-day band and the timed chips, each
 * already ordered.
 *
 * @param {object[]} events
 * @returns {{ allDay: object[], timed: object[] }}
 */
export function splitDayEvents(events) {
  const list = (Array.isArray(events) ? events.slice() : []).sort(compareByStart);
  const allDay = [];
  const timed = [];
  for (const event of list) {
    if (event && (event.allDay === true || isDateOnly(event.startsAt))) allDay.push(event);
    else timed.push(event);
  }
  return { allDay, timed };
}

/**
 * How many chips a cell has to hide behind its "+N more" control.
 *
 * @param {number} total
 * @param {number} max
 * @returns {number} 0 when everything fits.
 */
export function overflowCount(total, max) {
  const count = Number.isFinite(total) ? total : 0;
  const room = Number.isFinite(max) && max > 0 ? max : MAX_CHIPS_PER_DAY;
  return count > room ? count - room : 0;
}

/** Local time of day, e.g. "9:00 am". */
function formatTimeOfDay(date, locale) {
  try {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * Render a `YYYY-MM-DD` calendar date for display WITHOUT a timezone conversion.
 *
 * `new Date(year, monthIndex, day)` is local midnight on exactly that date, so
 * the formatted result names the same day in every timezone. Parsing the string
 * with `new Date(key)` instead would be UTC midnight and would print the day
 * before for anyone west of UTC.
 *
 * @param {string} key
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDateKey(key, locale) {
  if (!isDateOnly(key)) return textOr(key, "");
  const [year, month, day] = key.trim().split("-").map(Number);
  const local = new Date(year, month - 1, day);
  try {
    return local.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  } catch {
    return key;
  }
}

/**
 * "September 2026" for the grid heading.
 *
 * @param {number} year
 * @param {number} monthIndex
 * @param {string} [locale]
 * @returns {string}
 */
export function monthLabel(year, monthIndex, locale) {
  const local = new Date(year, monthIndex, 1);
  try {
    return local.toLocaleDateString(locale, { month: "long", year: "numeric" });
  } catch {
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  }
}

/**
 * Chip-sized time label: "All day", or the local start time.
 *
 * @param {object} event
 * @param {string} [locale]
 * @returns {string}
 */
export function formatEventTime(event, locale) {
  if (!event) return "";
  if (event.allDay === true || isDateOnly(event.startsAt)) return "All day";
  const epochMs = Date.parse(String(event.startsAt ?? ""));
  if (Number.isNaN(epochMs)) return "";
  return formatTimeOfDay(new Date(epochMs), locale);
}

/**
 * Full "when" line for the detail panel.
 *
 * @param {object} event
 * @param {string} [locale]
 * @returns {string}
 */
export function formatEventWhen(event, locale) {
  if (!event) return "";
  if (event.allDay === true || isDateOnly(event.startsAt)) {
    const key = eventDateKey(event);
    return key ? `All day on ${formatDateKey(key, locale)}` : "All day";
  }
  const epochMs = Date.parse(String(event.startsAt ?? ""));
  if (Number.isNaN(epochMs)) return "Time not recorded";
  const start = new Date(epochMs);
  let when = `${formatDateKey(localDateKey(start), locale)}, ${formatTimeOfDay(start, locale)}`;
  const endMs = Date.parse(String(event.endsAt ?? ""));
  if (!Number.isNaN(endMs) && endMs > epochMs) when += ` to ${formatTimeOfDay(new Date(endMs), locale)}`;
  return when;
}

/** Epoch-ms of a deadline; a bare date means the END of that day. */
function deadlineValue(event) {
  const raw = typeof event?.dueBy === "string" ? event.dueBy.trim() : "";
  if (!raw) return Number.POSITIVE_INFINITY;
  const epochMs = Date.parse(isDateOnly(raw) ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(epochMs) ? Number.POSITIVE_INFINITY : epochMs;
}

/**
 * Render a deadline for display.
 *
 * @param {unknown} value
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDeadline(value, locale) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "no deadline recorded";
  if (isDateOnly(raw)) return formatDateKey(raw, locale);
  const epochMs = Date.parse(raw);
  if (Number.isNaN(epochMs)) return "no deadline recorded";
  const local = new Date(epochMs);
  return `${formatDateKey(localDateKey(local), locale)}, ${formatTimeOfDay(local, locale)}`;
}

/**
 * Has this item's deadline passed?
 *
 * The API already computes `overdue` against the server clock (see `isOverdue`
 * in backend/events.mjs) and that answer is trusted when present; the local
 * recomputation is what keeps a long-lived page honest as its own clock moves
 * past a deadline with no refetch in between.
 *
 * @param {object} event
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isOverdueEvent(event, nowMs) {
  if (event && event.overdue === true) return true;
  const due = deadlineValue(event);
  if (!Number.isFinite(due)) return false;
  return due < nowMs;
}

/**
 * Order the attention list soonest deadline first, ties broken by title.
 *
 * The API already returns this order (the AttentionIndex is keyed on `dueBy`),
 * so this is belt and braces - but it means the panel is right about "soonest
 * first" even after an optimistic removal has reshuffled the local array.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareByDueBy(a, b) {
  const left = deadlineValue(a);
  const right = deadlineValue(b);
  if (left === right) return String(a?.title ?? "").localeCompare(String(b?.title ?? ""));
  return left - right;
}

/**
 * Turn a scan result into the sentence the user reads.
 *
 * A truncated run ALWAYS says so. A scan that quietly stopped at its cap and
 * reported "done" would leave the user believing their calendar is complete.
 *
 * @param {object} result Body of `POST /calendar/api/scan`.
 * @returns {string}
 */
export function scanResultMessage(result) {
  const scan = result && typeof result === "object" ? result : {};
  const parts = [];

  if (scan.status === "not_configured") {
    parts.push("We need your school name and its mail domains before we can scan.");
  } else {
    const scanned = Number.isFinite(scan.messagesScanned) ? scan.messagesScanned : 0;
    const created = Number.isFinite(scan.eventsCreated) ? scan.eventsCreated : 0;
    parts.push(
      `Scanned ${scanned} message${scanned === 1 ? "" : "s"} and found ${created} event${created === 1 ? "" : "s"}.`
    );
  }

  if (scan.truncated === true) parts.push(SCAN_TRUNCATED_MESSAGE);
  return parts.join(" ");
}

// --- API client --------------------------------------------------------------

/**
 * The single place this app talks to the network.
 *
 * Two things are structural here rather than conventional:
 *
 *  - `credentials: "same-origin"` is written once, on the only `fetch` call in
 *    the file, so there is no second call site that could forget it and there is
 *    nothing to keep in sync.
 *
 *  - A 401 HALTS THE CLIENT. `onUnauthorized` fires once and every later request
 *    short-circuits without touching the network. A page whose session expired
 *    would otherwise keep its refresh timer running and keep firing requests
 *    that can only fail - which is both a pointless load on the service and a
 *    user staring at a calendar that never explains why it stopped updating.
 *    The halt is observable through `isHalted()` so the behaviour can be
 *    asserted rather than assumed.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch, for tests.
 * @param {() => void} [options.onUnauthorized] Called once, on the first 401.
 * @returns {{ request: Function, get: Function, post: Function, put: Function, del: Function, isHalted: () => boolean, reset: () => void }}
 */
export function createApiClient({ fetchImpl, onUnauthorized } = {}) {
  const send = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args);
  const signalUnauthorized = typeof onUnauthorized === "function" ? onUnauthorized : () => {};
  let halted = false;

  async function request(url, { method = "GET", body = null } = {}) {
    if (halted) return { ok: false, status: 401, data: null, halted: true };

    const init = {
      method,
      // Session cookie is HttpOnly; without this the request is anonymous.
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    };
    if (body !== null && body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await send(url, init);
    } catch {
      // Never surface the underlying error text: it is not actionable and can
      // carry the request URL into the page.
      return { ok: false, status: 0, data: null, networkError: true };
    }

    const status = Number(response?.status);
    if (status === 401) {
      halted = true;
      signalUnauthorized();
      return { ok: false, status: 401, data: null };
    }

    let data = null;
    try {
      data = typeof response?.json === "function" ? await response.json() : null;
    } catch {
      data = null;
    }

    return { ok: status >= 200 && status < 300, status, data };
  }

  return {
    request,
    get: (url) => request(url),
    post: (url, body = null) => request(url, { method: "POST", body }),
    put: (url, body = null) => request(url, { method: "PUT", body }),
    del: (url) => request(url, { method: "DELETE" }),
    isHalted: () => halted,
    reset: () => {
      halted = false;
    },
  };
}

// --- Connection state --------------------------------------------------------

/**
 * Read the saved school names off an `/auth/me` body.
 *
 * Tolerant on purpose: the attribute is null on a row that has never had one, and
 * this page must not throw on the shape it is guaranteed to meet on a first run.
 * Blank entries are dropped so a stray one cannot render as "Watching mail for ,
 * St Mary's".
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function schoolNameList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry !== "");
}

/**
 * Decide, from `GET /calendar/api/auth/me`, which prompts the page owes the user.
 *
 * Pure so the decision can be tested on its own. `null` means the call came back
 * 401 - not signed in at all.
 *
 * The three flags are independent on purpose. A revoked grant with a school name
 * already set still needs the reconnect banner; a fresh sign-in with no school
 * still needs the setup prompt even though it is also not connected. Treating
 * them as one enum would drop one of the two messages in exactly those cases.
 *
 * `needsSchool` is true whenever `schoolNames` is absent, is not an array, or is
 * empty. `/auth/me` projects an unset attribute as null rather than `[]` (see
 * backend/connections.mjs), so "not an array" is the ordinary first-run case here,
 * not a defensive afterthought.
 *
 * @param {object|null} me
 * @returns {{ signedIn: boolean, needsConnect: boolean, needsSchool: boolean, needsReauth: boolean }}
 */
export function connectionView(me) {
  if (!me || typeof me !== "object") {
    return { signedIn: false, needsConnect: true, needsSchool: false, needsReauth: false };
  }
  const schoolNames = schoolNameList(me.schoolNames);
  return {
    signedIn: true,
    // "unknown" (the connections table could not be read) is deliberately NOT
    // treated as "not connected": prompting a reconnect there would mint a
    // second grant over a working one to fix what was a blip.
    needsConnect: me.connectionStatus === "not_connected",
    needsSchool: schoolNames.length === 0,
    needsReauth: me.lastScanStatus === REAUTH_SCAN_STATUS,
  };
}

/** The "Connect your Gmail account" card. */
function connectCard(doc) {
  const card = el(doc, "section", "card card--connect");
  card.setAttribute("id", "connect-card");
  card.appendChild(el(doc, "h2", "card-title", CONNECT_PROMPT));
  card.appendChild(
    el(doc, "p", "card-body", "We read your school mail to build this calendar, and nothing else.")
  );
  const action = el(doc, "a", "btn-link", CONNECT_PROMPT);
  action.setAttribute("id", "connect-gmail");
  action.setAttribute("href", AUTH_START_URL);
  card.appendChild(action);
  return card;
}

/** The "Reconnect Gmail" banner shown for lastScanStatus = reauth_required. */
function reauthCard(doc) {
  const card = el(doc, "section", "card card--reauth");
  card.setAttribute("id", "reauth-banner");
  card.setAttribute("role", "alert");
  card.appendChild(el(doc, "h2", "card-title", REAUTH_PROMPT));
  card.appendChild(
    el(
      doc,
      "p",
      "card-body",
      "Your Gmail access was withdrawn or has expired, so we stopped looking for new events. " +
        "Nothing already on the calendar has been lost - reconnect and the next scan will catch up."
    )
  );
  const action = el(doc, "a", "btn-link", REAUTH_PROMPT);
  action.setAttribute("id", "reconnect-gmail");
  action.setAttribute("href", AUTH_START_URL);
  card.appendChild(action);
  return card;
}

/** The "Tell us your school" setup prompt. */
function schoolCard(doc) {
  const card = el(doc, "section", "card card--school");
  card.setAttribute("id", "school-setup");
  card.appendChild(el(doc, "h2", "card-title", SCHOOL_PROMPT));
  card.appendChild(
    el(doc, "p", "card-body", "Add your school name and the domains its mail comes from, and we can start looking.")
  );
  const action = el(doc, "a", "btn-link", "Go to settings");
  action.setAttribute("id", "school-setup-link");
  action.setAttribute("href", SETTINGS_URL);
  card.appendChild(action);
  return card;
}

/** Who is signed in, and which school we are watching. Both rendered as text. */
function identityCard(doc, me) {
  const card = el(doc, "section", "card card--identity");
  card.setAttribute("id", "identity-card");
  const email = el(doc, "p", "card-body");
  email.setAttribute("id", "identity-email");
  email.textContent = `Signed in as ${textOr(me?.email, "your Google account")}`;
  card.appendChild(email);

  const schoolNames = schoolNameList(me?.schoolNames);
  if (schoolNames.length > 0) {
    // Each name is stored raw and the JOINED list is rendered as TEXT here,
    // exactly as an email subject is. They are the user's own values, so an
    // injection is self-inflicted, but the storage layer names this escaping as
    // its mitigation - and joining before assigning keeps it one text node rather
    // than a list assembled out of markup.
    const school = el(doc, "p", "card-body");
    school.setAttribute("id", "identity-school-name");
    school.textContent = `Watching mail for ${schoolNames.join(", ")}`;
    card.appendChild(school);
  }
  return card;
}

/**
 * Render the connection area for a given `/auth/me` result.
 *
 * Shared with settings.js so both pages answer a missing session, a revoked
 * grant and an unconfigured school in exactly the same words.
 *
 * @param {Document} doc
 * @param {Element} container
 * @param {object|null} me
 * @returns {{ signedIn: boolean, needsConnect: boolean, needsSchool: boolean, needsReauth: boolean }}
 */
export function renderConnectionCards(doc, container, me) {
  const view = connectionView(me);
  if (!container) return view;
  clear(container);

  if (!view.signedIn) {
    container.appendChild(connectCard(doc));
    return view;
  }

  if (view.needsReauth) container.appendChild(reauthCard(doc));
  if (view.needsConnect) container.appendChild(connectCard(doc));
  if (view.needsSchool) container.appendChild(schoolCard(doc));
  container.appendChild(identityCard(doc, me));
  return view;
}

// --- The calendar page -------------------------------------------------------

/**
 * Build the calendar page controller.
 *
 * Every external dependency - the document, fetch, the clock, the timer - is
 * injectable, so the whole page can be driven without a browser.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.api] A ready-made client (overrides `fetchImpl`).
 * @param {() => number} [options.now] Epoch-ms clock.
 * @param {string} [options.locale]
 * @param {number} [options.maxChipsPerDay]
 * @param {number} [options.maxAttentionItems]
 * @param {number} [options.refreshIntervalMs]
 * @param {Function} [options.setIntervalImpl]
 * @param {Function} [options.clearIntervalImpl]
 * @returns {object} The controller.
 */
export function createCalendarApp(options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("createCalendarApp: a document is required");

  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const locale = options.locale;
  const maxChips = Number.isInteger(options.maxChipsPerDay) && options.maxChipsPerDay > 0
    ? options.maxChipsPerDay
    : MAX_CHIPS_PER_DAY;
  const maxAttentionItems = Number.isInteger(options.maxAttentionItems) && options.maxAttentionItems > 0
    ? options.maxAttentionItems
    : MAX_ATTENTION_ITEMS;
  const refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
    ? options.refreshIntervalMs
    : REFRESH_INTERVAL_MS;
  const startTimer =
    typeof options.setIntervalImpl === "function"
      ? options.setIntervalImpl
      : (fn, ms) => (typeof setInterval === "function" ? setInterval(fn, ms) : null);
  const stopTimer =
    typeof options.clearIntervalImpl === "function"
      ? options.clearIntervalImpl
      : (id) => {
          if (typeof clearInterval === "function") clearInterval(id);
        };

  const startOfView = new Date(now());
  const state = {
    me: null,
    viewYear: startOfView.getFullYear(),
    viewMonth: startOfView.getMonth(),
    events: [],
    attention: [],
    // Survives every re-render - poll, reload, optimistic mutation - so an
    // expanded panel does not silently collapse under the user. Only
    // `renderAttention` clears it, and only once there is nothing left to hide.
    attentionExpanded: false,
    truncated: false,
    lastRange: null,
    scanInFlight: false,
    timerId: null,
    selectedEventId: null,
  };

  const api =
    options.api ||
    createApiClient({
      fetchImpl: options.fetchImpl,
      onUnauthorized: () => handleUnauthorized(),
    });

  const byId = (id) => doc.getElementById(id);

  // --- messages ---

  function setMessage(id, text, isProblem) {
    const node = byId(id);
    if (!node) return;
    const value = typeof text === "string" ? text : "";
    node.textContent = value;
    node.className = isProblem ? "notice notice--problem" : "notice";
    node.hidden = value === "";
  }

  function setScanMessage(text, isProblem) {
    const node = byId("scan-message");
    if (!node) return;
    const value = typeof text === "string" ? text : "";
    node.textContent = value;
    node.className = isProblem ? "scan-message notice--problem" : "scan-message";
    node.hidden = value === "";
  }

  // --- rendering ---

  function renderWeekdayHeader() {
    const header = byId("calendar-weekdays");
    if (!header) return;
    clear(header);
    for (const label of WEEKDAY_LABELS) header.appendChild(el(doc, "div", "weekday", label));
  }

  function renderChip(event) {
    const allDay = event?.allDay === true || isDateOnly(event?.startsAt);
    let className = "chip";
    if (allDay) className += " chip--all-day";
    if (event?.needsAttention === true) className += " chip--attention";

    const chip = el(doc, "button", className);
    chip.setAttribute("type", "button");
    chip.setAttribute("data-event-id", textOr(event?.eventId, ""));
    if (!allDay) {
      const time = formatEventTime(event, locale);
      if (time) chip.appendChild(el(doc, "span", "chip-time", time));
    }
    // The title came out of an email. It is appended as TEXT and nothing else.
    chip.appendChild(el(doc, "span", "chip-title", textOr(event?.title, "(untitled event)")));
    chip.addEventListener("click", () => openEvent(event));
    return chip;
  }

  function renderDayCell(cell, events, todayKey) {
    const isToday = cell.dateKey === todayKey;
    let className = cell.inMonth ? "day-cell day-cell--in-month" : "day-cell day-cell--outside";
    if (isToday) className += " day-cell--today";

    const node = el(doc, "div", className);
    node.setAttribute("role", "gridcell");
    node.setAttribute("data-date", cell.dateKey);

    const head = el(doc, "div", "day-head");
    head.appendChild(el(doc, "span", "day-number", String(cell.dayOfMonth)));
    if (isToday) {
      // A visible word, not just a colour - see the note in styles.css.
      head.appendChild(el(doc, "span", "day-today-marker", "Today"));
      node.setAttribute("aria-current", "date");
    }
    node.appendChild(head);

    const { allDay, timed } = splitDayEvents(events);
    const ordered = allDay.concat(timed);
    const band = el(doc, "div", "all-day-band");
    node.appendChild(band);

    const hiddenChips = [];
    ordered.forEach((event, index) => {
      const chip = renderChip(event);
      if (index >= maxChips) {
        chip.hidden = true;
        hiddenChips.push(chip);
      }
      const isAllDay = event?.allDay === true || isDateOnly(event?.startsAt);
      (isAllDay ? band : node).appendChild(chip);
    });

    const hiddenCount = overflowCount(ordered.length, maxChips);
    if (hiddenCount > 0) {
      const more = el(doc, "button", "more-toggle", `+${hiddenCount} more`);
      more.setAttribute("type", "button");
      more.setAttribute("data-more-for", cell.dateKey);
      more.addEventListener("click", () => {
        for (const chip of hiddenChips) chip.hidden = false;
        more.hidden = true;
      });
      node.appendChild(more);
    }

    return node;
  }

  function renderMonth() {
    const heading = byId("month-heading");
    if (heading) heading.textContent = monthLabel(state.viewYear, state.viewMonth, locale);
    renderWeekdayHeader();

    const grid = byId("calendar-grid");
    if (grid) {
      clear(grid);
      const byDay = groupEventsByDay(state.events);
      const todayKey = localDateKey(new Date(now()));
      for (const week of buildMonthMatrix(state.viewYear, state.viewMonth)) {
        const row = el(doc, "div", "calendar-week");
        row.setAttribute("role", "row");
        for (const cell of week) row.appendChild(renderDayCell(cell, byDay.get(cell.dateKey) || [], todayKey));
        grid.appendChild(row);
      }
    }

    const empty = byId("calendar-empty");
    // Reads as a good outcome, not as a failure: an empty month means there is
    // nothing to do, and the wording and styling both say so.
    if (empty) empty.hidden = state.events.length > 0;

    const truncated = byId("calendar-truncated");
    if (truncated) {
      // `truncated` is reported by the API observing one row past its cap, not
      // guessed from the row count - so saying so here is a fact, not a hint.
      truncated.className = "notice notice--info";
      truncated.textContent = state.truncated
        ? "This month has more events than we can show at once. Narrow the range to see the rest."
        : "";
      truncated.hidden = !state.truncated;
    }
  }

  function renderAttentionItem(event, nowMs) {
    const overdue = isOverdueEvent(event, nowMs);
    const item = el(doc, "li", overdue ? "attention-item attention-item--overdue" : "attention-item");
    item.setAttribute("data-event-id", textOr(event?.eventId, ""));

    const head = el(doc, "div", "attention-head");
    head.appendChild(el(doc, "span", "attention-title", textOr(event?.title, "(untitled event)")));
    // The overdue state carries a WORD, not just a colour, so it survives
    // greyscale and colour-blindness.
    const badge = el(doc, "span", overdue ? "badge badge--overdue" : "badge badge--due", overdue ? "Overdue" : "Due");
    if (overdue) badge.setAttribute("data-overdue", "true");
    head.appendChild(badge);
    item.appendChild(head);

    if (event?.actionRequired) {
      item.appendChild(el(doc, "p", "attention-meta", String(event.actionRequired)));
    }
    item.appendChild(
      el(doc, "p", "attention-meta", `${overdue ? "Was due" : "Due"} ${formatDeadline(event?.dueBy, locale)}`)
    );

    const actions = el(doc, "div", "attention-actions");
    const acknowledgeButton = el(doc, "button", "btn btn-small btn-primary", "Acknowledge");
    acknowledgeButton.setAttribute("type", "button");
    acknowledgeButton.setAttribute("data-action", "acknowledge");
    acknowledgeButton.addEventListener("click", () => acknowledge(event?.eventId));
    actions.appendChild(acknowledgeButton);

    const dismissButton = el(doc, "button", "btn btn-small", "Dismiss");
    dismissButton.setAttribute("type", "button");
    dismissButton.setAttribute("data-action", "dismiss");
    dismissButton.addEventListener("click", () => dismiss(event?.eventId));
    actions.appendChild(dismissButton);

    const detailsButton = el(doc, "button", "btn btn-small", "Details");
    detailsButton.setAttribute("type", "button");
    detailsButton.addEventListener("click", () => openEvent(event));
    actions.appendChild(detailsButton);

    item.appendChild(actions);
    return item;
  }

  /**
   * Render the attention panel, capped at `maxAttentionItems` visible rows.
   *
   * Rows past the cap are HIDDEN, never removed: every deadline stays in
   * `#attention-list` under its `data-event-id`, so nothing the user has to act
   * on becomes unreachable. `hidden` on the `<li>` takes the whole row - action
   * buttons included - out of the tab order, which a `visibility` or `height: 0`
   * approach would not.
   *
   * The "Show N more" control is static markup in index.html. Building it here
   * would append a fresh button on every poll and every optimistic mutation;
   * this function only ever updates its text, its `hidden` and its
   * `aria-expanded`.
   */
  function renderAttention() {
    const list = byId("attention-list");
    const ordered = state.attention.slice().sort(compareByDueBy);
    // Always with an explicit, valid max: `overflowCount` falls back to
    // MAX_CHIPS_PER_DAY (3), which is not this cap.
    const hiddenCount = overflowCount(ordered.length, maxAttentionItems);
    // Nothing left to hide - forget that the list was expanded, so a later
    // refill comes back collapsed rather than remembering a stale choice.
    if (hiddenCount === 0) state.attentionExpanded = false;

    if (list) {
      clear(list);
      const nowMs = now();
      ordered.forEach((event, index) => {
        const item = renderAttentionItem(event, nowMs);
        item.hidden = index >= maxAttentionItems && !state.attentionExpanded;
        list.appendChild(item);
      });
    }

    const more = byId("attention-more");
    if (more) {
      more.hidden = hiddenCount === 0;
      // The label carries a count, so it is data: textContent, never markup.
      // Blank when there is nothing to offer, so empty text and `hidden` stay
      // paired the way the message helpers above keep them.
      if (hiddenCount === 0) more.textContent = "";
      else more.textContent = state.attentionExpanded ? "Show less" : `Show ${hiddenCount} more`;
      // A string attribute, not a boolean property: only setAttribute produces
      // the `aria-expanded` a screen reader reads.
      more.setAttribute("aria-expanded", state.attentionExpanded ? "true" : "false");
    }

    const empty = byId("attention-empty");
    if (empty) empty.hidden = ordered.length > 0;
  }

  /**
   * Flip the attention panel between collapsed and expanded.
   *
   * Two-way, unlike the day-cell "+N more" which reveals once and retires: the
   * attention panel is the thing most likely to overrun a phone screen, so the
   * user needs to be able to put it back.
   *
   * @returns {boolean} The new expanded state.
   */
  function toggleAttentionExpanded() {
    state.attentionExpanded = !state.attentionExpanded;
    renderAttention();
    return state.attentionExpanded;
  }

  function detailRow(label, value, id) {
    const row = el(doc, "p", "detail-row");
    if (id) row.setAttribute("id", id);
    row.appendChild(el(doc, "span", "detail-label", `${label}:`));
    // Every one of these came from an email. All of them are text.
    row.appendChild(el(doc, "span", "detail-value", textOr(value)));
    return row;
  }

  function openEvent(event) {
    const panel = byId("event-detail");
    if (!panel || !event) return null;
    state.selectedEventId = event.eventId ?? null;
    clear(panel);
    panel.hidden = false;
    panel.setAttribute("data-event-id", textOr(event.eventId, ""));

    const title = el(doc, "h2", "detail-title", textOr(event.title, "(untitled event)"));
    title.setAttribute("id", "detail-title");
    panel.appendChild(title);

    panel.appendChild(detailRow("When", formatEventWhen(event, locale), "detail-when"));
    panel.appendChild(detailRow("Location", event.location, "detail-location"));
    panel.appendChild(detailRow("Description", event.description, "detail-description"));
    panel.appendChild(detailRow("Category", event.category, "detail-category"));
    panel.appendChild(detailRow("From the email", event.sourceSubject, "detail-source-subject"));
    panel.appendChild(detailRow("Sent by", event.sourceFrom, "detail-source-from"));

    if (event.needsAttention === true) {
      panel.appendChild(detailRow("Action required", event.actionRequired, "detail-action-required"));
      panel.appendChild(detailRow("Deadline", formatDeadline(event.dueBy, locale), "detail-deadline"));

      const actions = el(doc, "div", "detail-actions");
      const acknowledgeButton = el(doc, "button", "btn btn-primary btn-small", "Acknowledge");
      acknowledgeButton.setAttribute("type", "button");
      acknowledgeButton.setAttribute("id", "detail-acknowledge");
      acknowledgeButton.addEventListener("click", () => acknowledge(event.eventId));
      actions.appendChild(acknowledgeButton);

      const dismissButton = el(doc, "button", "btn btn-small", "Dismiss");
      dismissButton.setAttribute("type", "button");
      dismissButton.setAttribute("id", "detail-dismiss");
      dismissButton.addEventListener("click", () => dismiss(event.eventId));
      actions.appendChild(dismissButton);

      panel.appendChild(actions);
    }

    const close = el(doc, "button", "btn btn-small", "Close");
    close.setAttribute("type", "button");
    close.setAttribute("id", "detail-close");
    close.addEventListener("click", () => closeEvent());
    panel.appendChild(close);

    return panel;
  }

  function closeEvent() {
    const panel = byId("event-detail");
    state.selectedEventId = null;
    if (!panel) return;
    clear(panel);
    panel.hidden = true;
  }

  // --- data ---

  async function loadIdentity() {
    const result = await api.get(`${API_BASE}/auth/me`);
    if (!result.ok) {
      renderSignedOut();
      return result;
    }
    state.me = result.data || {};
    applyIdentity();
    return result;
  }

  function applyIdentity() {
    renderConnectionCards(doc, byId("connection-state"), state.me);

    const schoolNames = schoolNameList(state.me?.schoolNames);
    const header = byId("school-name");
    // Text, not markup - every name is stored raw (see backend/settings.mjs).
    if (header) {
      header.textContent = schoolNames.length === 0 ? "" : `Watching mail for ${schoolNames.join(", ")}`;
    }

    const body = byId("app-body");
    if (body) body.hidden = false;
  }

  function renderSignedOut() {
    state.me = null;
    state.events = [];
    state.attention = [];
    stopPolling();
    renderConnectionCards(doc, byId("connection-state"), null);
    const header = byId("school-name");
    if (header) header.textContent = "";
    const body = byId("app-body");
    if (body) body.hidden = true;
    closeEvent();
  }

  /**
   * The mid-session 401 path.
   *
   * Fired once by the API client. It re-renders the connect state AND stops the
   * refresh timer, so the page neither loops on requests that can only fail nor
   * sits there silently not updating.
   */
  function handleUnauthorized() {
    renderSignedOut();
  }

  async function loadMonth() {
    const range = monthRange(state.viewYear, state.viewMonth);
    state.lastRange = range;
    const url = `${API_BASE}/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    const result = await api.get(url);
    if (!result.ok) {
      if (result.status !== 401) {
        setMessage("calendar-truncated", "We could not load this month just now. Please try again.", true);
      }
      return result;
    }
    state.events = Array.isArray(result.data?.events) ? result.data.events : [];
    state.truncated = result.data?.truncated === true;
    renderMonth();
    return result;
  }

  async function loadAttention() {
    const result = await api.get(`${API_BASE}/events/upcoming`);
    if (!result.ok) {
      if (result.status !== 401) {
        setMessage("attention-message", "We could not load your reminders just now.", true);
      }
      return result;
    }
    state.attention = Array.isArray(result.data?.events) ? result.data.events : [];
    setMessage("attention-message", "", false);
    renderAttention();
    return result;
  }

  async function refreshAll() {
    const month = await loadMonth();
    const attention = await loadAttention();
    return { month, attention };
  }

  /**
   * Acknowledge or dismiss, optimistically.
   *
   * The row leaves the panel before the request is sent, because the user has
   * decided and the list should reflect that immediately. If the request does
   * not land it goes back EXACTLY where it was (same index, same object) and the
   * panel says so - a silently swallowed failure would leave the user believing
   * a deadline was cleared when it is still pending on the server.
   *
   * @param {string} eventId
   * @param {"acknowledge"|"dismiss"} action
   * @returns {Promise<{ ok: boolean, restored: boolean, status?: number, reason?: string }>}
   */
  async function mutateAttention(eventId, action) {
    const id = typeof eventId === "string" ? eventId : "";
    if (!id) return { ok: false, restored: false, reason: "no-event-id" };

    const index = state.attention.findIndex((item) => item && item.eventId === id);
    const removed = index === -1 ? null : state.attention[index];
    if (index !== -1) {
      state.attention.splice(index, 1);
      renderAttention();
    }

    const result = await api.post(`${API_BASE}/events/${encodeURIComponent(id)}/${action}`);
    if (result.ok) {
      setMessage("attention-message", "", false);
      if (state.selectedEventId === id) closeEvent();
      // Update the month view in place rather than refetching it: the only
      // thing that changed is this one row, and an extra round trip here would
      // make every acknowledge cost a range query.
      for (const event of state.events) {
        if (event && event.eventId === id) {
          event.status = action === "acknowledge" ? "acknowledged" : "dismissed";
          event.needsAttention = false;
        }
      }
      renderMonth();
      return { ok: true, restored: false, status: result.status };
    }

    if (index !== -1 && removed) {
      state.attention.splice(index, 0, removed);
      renderAttention();
    }
    // A 401 has already re-rendered the connect state; do not shout twice.
    if (result.status !== 401) setMessage("attention-message", RESTORE_MESSAGE, true);
    return { ok: false, restored: index !== -1, status: result.status };
  }

  const acknowledge = (eventId) => mutateAttention(eventId, "acknowledge");
  const dismiss = (eventId) => mutateAttention(eventId, "dismiss");

  /**
   * Run a scan now.
   *
   * The button is disabled BEFORE the request is awaited and re-enabled in a
   * `finally`, so it is disabled for exactly the in-flight window even when the
   * request throws.
   */
  async function runScanNow() {
    if (state.scanInFlight) return { ok: false, status: 0, reason: "already-in-flight" };
    const button = byId("scan-now");
    state.scanInFlight = true;
    if (button) {
      button.disabled = true;
      button.textContent = "Scanning...";
    }
    setScanMessage("Scanning your mail. This can take a moment.", false);

    try {
      const result = await api.post(`${API_BASE}/scan`);

      if (result.status === 409) {
        setScanMessage(SCAN_BUSY_MESSAGE, true);
        return { ok: false, status: 409 };
      }
      if (!result.ok) {
        if (result.status !== 401) setScanMessage("We could not run the scan just now. Please try again.", true);
        return { ok: false, status: result.status };
      }

      setScanMessage(scanResultMessage(result.data), result.data?.truncated === true);
      await refreshAll();
      return { ok: true, status: result.status, data: result.data };
    } finally {
      state.scanInFlight = false;
      if (button) {
        button.disabled = false;
        button.textContent = "Scan now";
      }
    }
  }

  // --- navigation ---

  function goToMonth(year, monthIndex) {
    const shifted = new Date(Date.UTC(year, monthIndex, 1));
    state.viewYear = shifted.getUTCFullYear();
    state.viewMonth = shifted.getUTCMonth();
    return loadMonth();
  }

  const previousMonth = () => goToMonth(state.viewYear, state.viewMonth - 1);
  const nextMonth = () => goToMonth(state.viewYear, state.viewMonth + 1);

  function goToToday() {
    const today = new Date(now());
    return goToMonth(today.getFullYear(), today.getMonth());
  }

  // --- polling ---

  function startPolling() {
    if (state.timerId !== null) return;
    state.timerId = startTimer(() => {
      refreshAll();
    }, refreshIntervalMs);
  }

  function stopPolling() {
    if (state.timerId === null) return;
    stopTimer(state.timerId);
    state.timerId = null;
  }

  // --- wiring ---

  function bindControls() {
    const bind = (id, handler) => {
      const node = byId(id);
      if (node) node.addEventListener("click", handler);
    };
    bind("prev-month", () => previousMonth());
    bind("next-month", () => nextMonth());
    bind("today", () => goToToday());
    bind("scan-now", () => runScanNow());
    // Bound once, here. Binding it inside renderAttention would stack one more
    // handler on the same button with every poll.
    bind("attention-more", () => toggleAttentionExpanded());
  }

  async function start() {
    bindControls();
    renderMonth();
    const identity = await loadIdentity();
    if (!identity.ok) return { started: false, identity };
    await refreshAll();
    startPolling();
    return { started: true, identity };
  }

  return {
    state,
    api,
    start,
    stop: stopPolling,
    startPolling,
    stopPolling,
    loadIdentity,
    loadMonth,
    loadAttention,
    refreshAll,
    renderMonth,
    renderAttention,
    toggleAttentionExpanded,
    goToMonth,
    previousMonth,
    nextMonth,
    goToToday,
    openEvent,
    closeEvent,
    acknowledge,
    dismiss,
    runScanNow,
  };
}

/**
 * Start the calendar against the real document. Exported so the bootstrap is
 * callable rather than only implicit.
 *
 * @param {object} [options] Forwarded to `createCalendarApp`.
 * @returns {object} The controller.
 */
export function bootstrap(options = {}) {
  const app = createCalendarApp(options);
  app.start();
  return app;
}

// Browser only, and only on the calendar page. Module scripts are deferred, so
// the body exists by the time this runs. settings.js imports this module for its
// shared helpers, and its own page carries data-page="settings", so importing
// this file there does not start a second calendar.
if (typeof document !== "undefined" && document.body && document.body.getAttribute("data-page") === "calendar") {
  bootstrap();
}
