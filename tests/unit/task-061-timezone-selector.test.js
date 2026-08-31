/**
 * UNIT tests for TASK-061 - "a time zone SELECTOR for the scan schedule".
 *
 * Scope of this file: the units, in isolation.
 *
 *   - the pure frontend helpers `supportedTimezones(intlImpl)`,
 *     `timezoneOptionList(selected, intlImpl)` and the constants
 *     `FALLBACK_TIMEZONE` / `TIMEZONE_FALLBACK_ZONES`, driven through an
 *     INJECTED `Intl` stand-in so the missing-`supportedValuesOf` and
 *     throwing-`Intl` paths are exercised without touching the global;
 *   - the DOM helper `fillTimezoneSelect(doc, select, selected, intlImpl)`,
 *     driven against a hand-built `<select>`;
 *   - `createSettingsPage`'s new `options.intl` seam alongside the existing
 *     `options.detectTimezone` one;
 *   - the shipped `settings.html` read as MARKUP (parsed by the repo's fake DOM)
 *     and `settings.js` read as TEXT, because there is no browser anywhere in
 *     this repo (see the docblock in `tests/helpers/fake-dom.mjs`);
 *   - `validateSchedule`'s tightened `timezone` branch in
 *     `backend/settings.mjs`, and its agreement with `isValidTimezone` in
 *     `backend/scan-schedule.mjs`.
 *
 * NO DATABASE IS TOUCHED AND NO NETWORK CALL IS MADE. Nothing here builds an
 * AWS client, opens a socket or reads a connection row: the backend functions
 * under test are pure validators, and the one page built below is given an
 * injected `api` whose methods are local async functions plus a `fetchImpl`
 * that THROWS, so a regression that reached for the network fails loudly rather
 * than quietly passing.
 *
 * `Intl` IS INJECTED, NEVER MONKEY-PATCHED. Every scenario that needs a browser
 * without `Intl.supportedValuesOf` passes a stand-in object; the global `Intl`
 * is only used by the two scenarios that deliberately assert the real default,
 * and it is never reassigned.
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/task-061-timezone-selector-flow.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'frontend');
const BACKEND_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'backend');

const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { validateSchedule, SettingsValidationError } = await import(
  '../../src/lambda/calendar/backend/settings.mjs'
);
const { isValidTimezone } = await import('../../src/lambda/calendar/backend/scan-schedule.mjs');
const { parseHtml, findElements, textOf } = await import('../helpers/fake-dom.mjs');

const SETTINGS_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.js'), 'utf-8');
const SETTINGS_MJS = fs.readFileSync(path.join(BACKEND_DIR, 'settings.mjs'), 'utf-8');
const SETTINGS_DOC = parseHtml(fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf-8'));

const XSS = '<img src=x onerror=alert(1)>';

/* =========================================================================
 * Intl stand-ins. NOTHING below replaces the global.
 * ========================================================================= */

/** An `Intl` that enumerates exactly `zones`, recording what it was asked for. */
function intlListing(zones) {
  const asked = [];
  return {
    asked,
    supportedValuesOf(key) {
      asked.push(key);
      return zones;
    },
  };
}

/** An older browser: `Intl` exists, `supportedValuesOf` does not. */
const INTL_WITHOUT_LIST = Object.freeze({ DateTimeFormat: () => ({}) });

/** An `Intl` build whose zone list throws (some embedded ICU builds). */
const INTL_THAT_THROWS = Object.freeze({
  supportedValuesOf() {
    throw new RangeError('no zone list in this build');
  },
});

/* =========================================================================
 * The constants
 * ========================================================================= */

describe('TASK-061 unit: the fallback constants', () => {
  it('FALLBACK_TIMEZONE is UTC - the zone that always exists', () => {
    assert.equal(settings.FALLBACK_TIMEZONE, 'UTC');
  });

  it('TIMEZONE_FALLBACK_ZONES is frozen, non-empty, and contains UTC', () => {
    assert.equal(Object.isFrozen(settings.TIMEZONE_FALLBACK_ZONES), true);
    assert.ok(settings.TIMEZONE_FALLBACK_ZONES.length > 0);
    assert.ok(settings.TIMEZONE_FALLBACK_ZONES.includes('UTC'));
  });

  it('every fallback zone is a real, non-blank, unique IANA zone', () => {
    const seen = new Set();
    for (const zone of settings.TIMEZONE_FALLBACK_ZONES) {
      assert.equal(typeof zone, 'string', `${String(zone)} is not a string`);
      assert.notEqual(zone.trim(), '');
      assert.equal(seen.has(zone), false, `${zone} is listed twice`);
      seen.add(zone);
      // The server validates against the real tz database, so a fallback option
      // the server would refuse would be an unsavable choice.
      assert.equal(isValidTimezone(zone), true, `${zone} is not a real zone`);
    }
  });
});

/* =========================================================================
 * supportedTimezones - the option SOURCE
 * ========================================================================= */

describe('TASK-061 unit: supportedTimezones', () => {
  it('asks Intl.supportedValuesOf for "timeZone" and returns what it says', () => {
    const intl = intlListing(['Australia/Sydney', 'Europe/London']);
    assert.deepEqual(settings.supportedTimezones(intl), ['Australia/Sydney', 'Europe/London']);
    assert.deepEqual(intl.asked, ['timeZone']);
  });

  it('falls back when supportedValuesOf is missing', () => {
    assert.deepEqual(settings.supportedTimezones(INTL_WITHOUT_LIST), [...settings.TIMEZONE_FALLBACK_ZONES]);
  });

  it('falls back when supportedValuesOf throws', () => {
    assert.deepEqual(settings.supportedTimezones(INTL_THAT_THROWS), [...settings.TIMEZONE_FALLBACK_ZONES]);
  });

  for (const [label, answer] of [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'Australia/Sydney'],
    ['an object', { 0: 'UTC' }],
    ['an empty array', []],
    ['an array of unusable entries', ['', '   ', 42, null, undefined]],
  ]) {
    it(`falls back when the zone list is ${label}`, () => {
      assert.deepEqual(
        settings.supportedTimezones(intlListing(answer)),
        [...settings.TIMEZONE_FALLBACK_ZONES],
        `${label} was treated as a usable list`
      );
    });
  }

  it('drops the unusable entries from an otherwise usable list', () => {
    const intl = intlListing(['Australia/Sydney', '', 42, null, '  ', 'UTC']);
    assert.deepEqual(settings.supportedTimezones(intl), ['Australia/Sydney', 'UTC']);
  });

  it('returns a COPY of the fallback list, so a caller cannot mutate the constant', () => {
    const list = settings.supportedTimezones(INTL_WITHOUT_LIST);
    assert.notEqual(list, settings.TIMEZONE_FALLBACK_ZONES);
    list.push('Mars/Olympus_Mons');
    assert.equal(settings.TIMEZONE_FALLBACK_ZONES.includes('Mars/Olympus_Mons'), false);
    assert.deepEqual(settings.supportedTimezones(INTL_WITHOUT_LIST), [...settings.TIMEZONE_FALLBACK_ZONES]);
  });

  it('with no argument it uses the ambient Intl - the full IANA list, not a curated one', () => {
    const list = settings.supportedTimezones();
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0);
    if (typeof Intl.supportedValuesOf === 'function') {
      // ~400 entries in a modern runtime. The bound is deliberately loose: the
      // assertion is "the browser's own list", not a pinned count.
      assert.ok(list.length > 100, `only ${list.length} zones came back`);
      assert.ok(list.includes('Australia/Sydney'));
      assert.ok(list.includes('Pacific/Chatham'), 'a zone no curated list would have carried');
    }
  });

  it('null and undefined for the injected Intl both mean "use the ambient one"', () => {
    assert.deepEqual(settings.supportedTimezones(null), settings.supportedTimezones());
    assert.deepEqual(settings.supportedTimezones(undefined), settings.supportedTimezones());
  });
});

/* =========================================================================
 * timezoneOptionList - the option VALUES
 * ========================================================================= */

describe('TASK-061 unit: timezoneOptionList', () => {
  it('is sorted alphabetically and carries no duplicates', () => {
    const intl = intlListing(['Europe/London', 'Australia/Sydney', 'UTC', 'Australia/Sydney', 'America/New_York']);
    const list = settings.timezoneOptionList('Australia/Sydney', intl);
    assert.deepEqual(list, [...list].sort((a, b) => a.localeCompare(b)), 'not alphabetical');
    assert.equal(new Set(list).size, list.length, 'a zone was listed twice');
    assert.deepEqual(list, ['America/New_York', 'Australia/Sydney', 'Europe/London', 'UTC']);
  });

  it('always contains UTC, even when the browser never mentioned it', () => {
    const list = settings.timezoneOptionList('Australia/Perth', intlListing(['Australia/Perth']));
    assert.ok(list.includes('UTC'));
  });

  it('adds a stored zone the browser does not enumerate - the fallback path', () => {
    const list = settings.timezoneOptionList('Pacific/Chatham', INTL_WITHOUT_LIST);
    assert.ok(list.includes('Pacific/Chatham'), 'the stored zone was dropped');
    assert.ok(list.includes('UTC'));
    for (const zone of settings.TIMEZONE_FALLBACK_ZONES) assert.ok(list.includes(zone), `${zone} went missing`);
  });

  it('trims the selected zone before adding it, and never adds it twice', () => {
    const list = settings.timezoneOptionList('  Australia/Perth  ', intlListing(['Australia/Perth', 'UTC']));
    assert.deepEqual(list, ['Australia/Perth', 'UTC']);
  });

  for (const [label, selected] of [
    ['a blank string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ]) {
    it(`ignores ${label} as the selected zone and still offers UTC`, () => {
      const list = settings.timezoneOptionList(selected, intlListing(['Australia/Sydney']));
      assert.deepEqual(list, ['Australia/Sydney', 'UTC']);
    });
  }

  it('never produces an empty list, whatever the browser answers', () => {
    for (const intl of [INTL_WITHOUT_LIST, INTL_THAT_THROWS, intlListing([]), intlListing(null)]) {
      const list = settings.timezoneOptionList('', intl);
      assert.ok(list.length > 1, 'the selector would have been all but empty');
      assert.ok(list.includes('UTC'));
    }
  });
});

/* =========================================================================
 * fillTimezoneSelect - the only place a zone reaches the DOM
 * ========================================================================= */

/** The smallest document `fillTimezoneSelect` can be driven against. */
function makeSelectHost() {
  const doc = parseHtml(
    '<html><body><select id="timezone-input" class="field-input"><option value="UTC">UTC</option></select></body></html>'
  );
  return { doc, select: doc.getElementById('timezone-input') };
}

const optionsOf = (select) => select.childNodes.filter((node) => node.nodeType === 1);

describe('TASK-061 unit: fillTimezoneSelect', () => {
  it('builds one <option> per zone, value and label both the zone id', () => {
    const { doc, select } = makeSelectHost();
    const chosen = settings.fillTimezoneSelect(doc, select, 'Australia/Sydney', intlListing(['Australia/Sydney', 'UTC']));

    assert.equal(chosen, 'Australia/Sydney');
    const options = optionsOf(select);
    assert.deepEqual(options.map((option) => option.tagName), ['OPTION', 'OPTION']);
    assert.deepEqual(options.map((option) => option.value), ['Australia/Sydney', 'UTC']);
    assert.deepEqual(options.map((option) => option.textContent), ['Australia/Sydney', 'UTC']);
    assert.equal(select.value, 'Australia/Sydney');
  });

  it('replaces the static seed option rather than appending to it', () => {
    const { doc, select } = makeSelectHost();
    settings.fillTimezoneSelect(doc, select, 'UTC', intlListing(['UTC', 'Australia/Perth']));
    assert.equal(optionsOf(select).length, 2, 'the seeded UTC option was left behind');
  });

  it('is idempotent: filling twice does not double the options', () => {
    const { doc, select } = makeSelectHost();
    const intl = intlListing(['UTC', 'Australia/Perth']);
    settings.fillTimezoneSelect(doc, select, 'Australia/Perth', intl);
    const first = optionsOf(select).map((option) => option.value);
    settings.fillTimezoneSelect(doc, select, 'Australia/Perth', intl);
    assert.deepEqual(optionsOf(select).map((option) => option.value), first);
  });

  it('selects the stored zone even when the browser does not enumerate it', () => {
    const { doc, select } = makeSelectHost();
    const chosen = settings.fillTimezoneSelect(doc, select, 'Pacific/Chatham', INTL_WITHOUT_LIST);
    assert.equal(chosen, 'Pacific/Chatham');
    assert.equal(select.value, 'Pacific/Chatham');
    assert.ok(optionsOf(select).some((option) => option.value === 'Pacific/Chatham'));
  });

  for (const [label, selected] of [
    ['a blank string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ]) {
    it(`falls back to UTC when the selected zone is ${label}, never leaving it blank`, () => {
      const { doc, select } = makeSelectHost();
      const chosen = settings.fillTimezoneSelect(doc, select, selected, intlListing(['Australia/Sydney']));
      assert.equal(chosen, 'UTC');
      assert.equal(select.value, 'UTC');
      assert.ok(optionsOf(select).some((option) => option.value === 'UTC'));
    });
  }

  it('trims the stored zone, so a padded legacy value still matches an option', () => {
    const { doc, select } = makeSelectHost();
    const chosen = settings.fillTimezoneSelect(doc, select, '  Australia/Brisbane  ', intlListing(['Australia/Brisbane']));
    assert.equal(chosen, 'Australia/Brisbane');
    assert.equal(select.value, 'Australia/Brisbane');
  });

  it('returns "" and touches nothing when there is no select on the page', () => {
    const { doc } = makeSelectHost();
    assert.equal(settings.fillTimezoneSelect(doc, null, 'Australia/Sydney', INTL_WITHOUT_LIST), '');
    assert.equal(settings.fillTimezoneSelect(doc, undefined, 'Australia/Sydney', INTL_WITHOUT_LIST), '');
  });

  it('renders a hostile legacy value as TEXT and creates no element from it', () => {
    const { doc, select } = makeSelectHost();
    settings.fillTimezoneSelect(doc, select, XSS, INTL_WITHOUT_LIST);
    const hostile = optionsOf(select).filter((option) => option.value === XSS);
    assert.equal(hostile.length, 1, 'the legacy value was dropped instead of being shown');
    assert.equal(hostile[0].textContent, XSS);
    assert.deepEqual(findElements(doc, 'img'), [], 'a stored value became an element');
    assert.equal(select.value, XSS);
  });

  it('the ambient Intl is the default source when none is injected', () => {
    const { doc, select } = makeSelectHost();
    settings.fillTimezoneSelect(doc, select, 'Australia/Sydney');
    const values = optionsOf(select).map((option) => option.value);
    assert.ok(values.includes('Australia/Sydney'));
    assert.ok(values.includes('UTC'));
    if (typeof Intl.supportedValuesOf === 'function') assert.ok(values.length > 100);
  });
});

/* =========================================================================
 * createSettingsPage - the injected `intl` and `detectTimezone` seams
 * ========================================================================= */

/** A minimal settings form: only the nodes the timezone path needs. */
function makeSettingsDoc() {
  return parseHtml(`<html><body data-page="settings">
    <section id="connection-state"></section>
    <div id="settings-body" hidden>
      <p id="settings-summary"></p>
      <form id="settings-form" novalidate>
        <div id="processing-jobs" class="jobs"></div>
        <p id="processing-jobs-empty" class="field-hint" hidden></p>
        <input id="schedule-enabled-input" class="field-checkbox" type="checkbox" />
        <select id="schedule-frequency-input" class="field-input"><option value="daily">Daily</option></select>
        <select id="schedule-day-input" class="field-input"><option value="0">Sunday</option></select>
        <input id="schedule-hour-input" class="field-input" type="number" />
        <select id="timezone-input" class="field-input"><option value="UTC">UTC</option></select>
        <p id="error-timezone" class="field-error" hidden></p>
        <p id="error-form" class="field-error" hidden></p>
        <p id="settings-status" class="notice" hidden></p>
        <button id="save-settings" type="submit" class="btn">Save settings</button>
      </form>
    </div>
  </body></html>`);
}

/** An injected api client. NOTHING here touches the network. */
function makeApi(settingsBody) {
  const calls = [];
  const ok = (data) => ({ ok: true, status: 200, data });
  return {
    calls,
    get: async (url) => {
      calls.push({ method: 'GET', url });
      return ok(settingsBody);
    },
    put: async (url, body) => {
      calls.push({ method: 'PUT', url, body });
      return ok(url === settings.SCHEDULE_ENDPOINT ? { available: true } : settingsBody);
    },
    del: async (url) => {
      calls.push({ method: 'DELETE', url });
      return ok({ available: true });
    },
    isHalted: () => false,
    reset: () => {},
  };
}

async function openPage({ stored, detect, intl }) {
  const doc = makeSettingsDoc();
  const settingsBody = {
    connectionStatus: 'connected',
    email: 'parent@example.test',
    processingJobs: [],
    scheduleEnabled: false,
    scheduleFrequency: 'daily',
    scheduleHour: 7,
    ...(stored === undefined ? {} : { timezone: stored }),
  };
  const api = makeApi(settingsBody);
  const page = settings.createSettingsPage({
    document: doc,
    api,
    ...(detect === undefined ? {} : { detectTimezone: detect }),
    ...(intl === undefined ? {} : { intl }),
    // A fetch that THROWS: the injected api is the only route out, so a
    // regression that fell back to the network fails loudly here.
    fetchImpl: () => {
      throw new Error('a unit test reached for the network');
    },
  });
  await page.start();
  return { doc, page, api, select: doc.getElementById('timezone-input') };
}

describe('TASK-061 unit: createSettingsPage fills the selector', () => {
  it('the stored zone wins and is the selected option', async () => {
    const { select } = await openPage({
      stored: 'Australia/Perth',
      detect: () => 'Australia/Sydney',
      intl: intlListing(['Australia/Perth', 'Australia/Sydney', 'UTC']),
    });
    assert.equal(select.value, 'Australia/Perth');
  });

  it('with nothing stored, the browser zone is selected', async () => {
    const { select } = await openPage({
      detect: () => 'Australia/Sydney',
      intl: intlListing(['Australia/Sydney', 'UTC']),
    });
    assert.equal(select.value, 'Australia/Sydney');
  });

  it('a stored zone the browser cannot enumerate is added rather than replaced', async () => {
    const { select } = await openPage({
      stored: 'Pacific/Chatham',
      detect: () => 'Australia/Sydney',
      intl: INTL_WITHOUT_LIST,
    });
    assert.equal(select.value, 'Pacific/Chatham');
    assert.ok(optionsOf(select).some((option) => option.value === 'Pacific/Chatham'));
    // And it is NOT the first entry, so "landed on the first option" cannot
    // masquerade as a pass.
    assert.notEqual(optionsOf(select)[0].value, 'Pacific/Chatham');
  });

  for (const [label, detect] of [
    ['throws', () => {
      throw new RangeError('Intl is unavailable');
    }],
    ['returns ""', () => ''],
    ['returns whitespace', () => '   '],
    ['returns null', () => null],
    // A number is deliberately NOT in this table: `textOr` renders it as "42",
    // which is a non-blank string, and the page then does what it does with any
    // legacy value it cannot vouch for - shows it and lets the server's 400
    // name the field. The AC covers throwing and blank, which is what the real
    // `detectTimezone` can produce.
  ]) {
    it(`falls back to UTC when the browser zone lookup ${label}`, async () => {
      const { select } = await openPage({ detect, intl: intlListing(['Australia/Sydney', 'UTC']) });
      assert.equal(select.value, 'UTC');
    });
  }

  it('a blank stored zone is treated as "nothing stored", not as a blank selection', async () => {
    const { select } = await openPage({
      stored: '   ',
      detect: () => 'Australia/Sydney',
      intl: intlListing(['Australia/Sydney', 'UTC']),
    });
    assert.equal(select.value, 'Australia/Sydney');
  });

  it('readForm reads the select back, and buildSchedulePayload carries it verbatim', async () => {
    const { doc, page, select } = await openPage({
      stored: 'Australia/Perth',
      detect: () => 'Australia/Sydney',
      intl: intlListing(['Australia/Brisbane', 'Australia/Perth', 'UTC']),
    });
    // Choosing a zone is exactly what a browser does to a <select>.
    select.value = 'Australia/Brisbane';
    const values = page.readForm();
    assert.equal(values.timezone, 'Australia/Brisbane');
    assert.equal(settings.buildSettingsPayload(values).timezone, 'Australia/Brisbane');
    assert.equal(settings.buildSchedulePayload(values).timezone, 'Australia/Brisbane');
    assert.equal(doc.getElementById('timezone-input').value, 'Australia/Brisbane');
  });

  it('no zone string ever becomes an element, whatever is stored', async () => {
    const { doc, select } = await openPage({
      stored: XSS,
      detect: () => 'Australia/Sydney',
      intl: intlListing(['Australia/Sydney', 'UTC']),
    });
    assert.equal(select.value, XSS);
    assert.deepEqual(findElements(doc, 'img'), []);
  });

  it('the intl seam defaults to the ambient Intl when it is not injected', async () => {
    const { select } = await openPage({ stored: 'Australia/Perth', detect: () => 'Australia/Sydney' });
    assert.equal(select.value, 'Australia/Perth');
    assert.ok(optionsOf(select).length > 1);
  });
});

/* =========================================================================
 * The shipped markup
 * ========================================================================= */

describe('TASK-061 unit: settings.html ships a select, not a text box', () => {
  const field = () => SETTINGS_DOC.getElementById('timezone-input');

  it('#timezone-input is a <select class="field-input">', () => {
    const node = field();
    assert.notEqual(node, null, 'the timezone control is not on the page');
    assert.equal(node.tagName, 'SELECT');
    assert.equal(node.className, 'field-input');
  });

  it('there is no <input> with that id any more', () => {
    assert.equal(
      findElements(SETTINGS_DOC, 'input').some((node) => node.getAttribute('id') === 'timezone-input'),
      false
    );
  });

  it('it ships with a usable static option, so a page whose script failed still submits a zone', () => {
    const options = findElements(field(), 'option');
    assert.ok(options.length >= 1, 'the select ships empty');
    assert.ok(options.some((option) => option.getAttribute('value') === 'UTC'));
    assert.equal(field().value, 'UTC');
  });

  it('every static option carries a real IANA zone as its value, never a label or an offset', () => {
    for (const option of findElements(field(), 'option')) {
      const value = option.getAttribute('value');
      assert.equal(isValidTimezone(value), true, `${String(value)} is not a real zone`);
      assert.equal(/[+-]\d/.test(String(value)), false, `${String(value)} looks like an offset`);
    }
  });

  it('keeps its label, and the label still points at the same id', () => {
    const label = SETTINGS_DOC.querySelector('label[for="timezone-input"]');
    assert.notEqual(label, null, 'the Time zone label was renamed or removed');
    assert.equal(label.className, 'field-label');
    assert.equal(textOf(label), 'Time zone');
  });

  it('keeps its #error-timezone slot, hidden and role="alert"', () => {
    const slot = SETTINGS_DOC.getElementById('error-timezone');
    assert.notEqual(slot, null);
    assert.equal(slot.className, 'field-error');
    assert.equal(slot.getAttribute('role'), 'alert');
    assert.equal(slot.hidden, true);
  });

  it('a hint ties the scan hour to the selected zone', () => {
    const hints = findElements(SETTINGS_DOC, 'p').filter((node) => node.className === 'field-hint');
    const hint = hints.find((node) => /time zone/i.test(textOf(node)) && /hour/i.test(textOf(node)));
    assert.notEqual(hint, undefined, 'no hint connects the hour field to the time zone field');
    assert.match(textOf(hint), /scan runs at the hour above, read in this time zone/i);
  });

  it('the select follows the same markup pattern as the other schedule selects', () => {
    for (const id of ['schedule-frequency-input', 'schedule-day-input']) {
      assert.equal(SETTINGS_DOC.getElementById(id).tagName, 'SELECT');
      assert.equal(SETTINGS_DOC.getElementById(id).className, field().className);
    }
  });
});

describe('TASK-061 unit: settings.js builds its options, never assembles markup', () => {
  it('exports the new seams', () => {
    for (const name of ['FALLBACK_TIMEZONE', 'TIMEZONE_FALLBACK_ZONES', 'supportedTimezones', 'timezoneOptionList', 'fillTimezoneSelect', 'detectTimezone']) {
      assert.notEqual(settings[name], undefined, `settings.js no longer exports ${name}`);
    }
  });

  it('reaches for no markup sink anywhere in the file', () => {
    for (const sink of ['.innerHTML', '.outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
      assert.deepEqual(SETTINGS_JS.split(sink).length - 1, 0, `settings.js reaches for ${sink}`);
    }
  });

  it('builds its options with createElement/el and sets their text, not markup', () => {
    const start = SETTINGS_JS.indexOf('export function fillTimezoneSelect');
    assert.notEqual(start, -1, 'fillTimezoneSelect is gone');
    // Line-ending agnostic: the file is checked out with CRLF on Windows.
    const fn = SETTINGS_JS.slice(start, start + 900);
    assert.match(fn, /el\(\s*doc,\s*["']option["']/, 'the option is not built with el()/createElement');
    assert.match(fn, /option\.value\s*=/, 'the zone is not set as the option value');
    assert.equal(/innerHTML|insertAdjacentHTML/.test(fn), false);
  });

  it('adds no third-party combobox or search widget - the page still imports only app.js', () => {
    const imports = SETTINGS_JS.match(/^import[\s\S]*?from\s+"([^"]+)";/gm) || [];
    const sources = imports.map((line) => /from\s+"([^"]+)";/.exec(line)[1]);
    assert.deepEqual(sources, ['./app.js']);
    assert.equal(/timezone-search|combobox|datalist/i.test(SETTINGS_JS), false);
  });
});

/* =========================================================================
 * backend/settings.mjs - validateSchedule's timezone branch
 * ========================================================================= */

/** Zones that really exist, so both validators must accept them. */
const REAL_ZONES = ['UTC', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Perth', 'Pacific/Chatham', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

/** Shape-valid or shape-invalid, but not zones - both validators must refuse. */
const FAKE_ZONES = ['Foo/Bar', 'Mars/Olympus_Mons', 'Invalid Zone!', 'Australia/Sydneyy', 'Australia', '', '   ', '../../etc/passwd', 'A'.repeat(200)];

describe('TASK-061 unit: validateSchedule validates against the real tz database', () => {
  it('accepts every real zone, unchanged', () => {
    for (const zone of REAL_ZONES) {
      assert.deepEqual(validateSchedule({ timezone: zone }), { timezone: zone });
    }
  });

  it('trims before checking AND before storing', () => {
    assert.deepEqual(validateSchedule({ timezone: '  Australia/Sydney  ' }), { timezone: 'Australia/Sydney' });
  });

  it('refuses a shape-valid zone that does not exist', () => {
    for (const zone of ['Foo/Bar', 'Mars/Olympus_Mons', 'Australia/Sydneyy']) {
      assert.throws(
        () => validateSchedule({ timezone: zone }),
        (err) => {
          assert.ok(err instanceof SettingsValidationError, `${zone}: wrong error type`);
          assert.equal(err.field, 'timezone');
          assert.equal(err.message, `"${zone}" is not a valid time zone`);
          return true;
        },
        `${zone} was accepted by the settings endpoint`
      );
    }
  });

  it('keeps refusing the special-character case the old shape check caught', () => {
    assert.throws(
      () => validateSchedule({ timezone: 'Invalid Zone!' }),
      (err) => err instanceof SettingsValidationError && err.field === 'timezone'
    );
  });

  for (const [label, value] of [
    ['a blank string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['null', null],
    ['true', true],
    ['an array', []],
    ['an object', {}],
  ]) {
    it(`refuses ${label} with field "timezone"`, () => {
      assert.throws(
        () => validateSchedule({ timezone: value }),
        (err) => err instanceof SettingsValidationError && err.field === 'timezone',
        `${label} was accepted`
      );
    });
  }

  it('caps the echoed value, so a huge body cannot be reflected whole', () => {
    const huge = 'Mars/'.padEnd(500, 'x');
    assert.throws(
      () => validateSchedule({ timezone: huge }),
      (err) => {
        assert.equal(err.field, 'timezone');
        assert.ok(err.message.length < 120, `the message echoed ${err.message.length} characters`);
        assert.match(err.message, /\.\.\." is not a valid time zone$/);
        return true;
      }
    );
  });

  it('an absent timezone is still "leave what is stored alone", not a rejection', () => {
    assert.deepEqual(validateSchedule({}), {});
    assert.deepEqual(validateSchedule({ timezone: undefined }), {});
  });

  it('the shape-only TIMEZONE_PATTERN is gone from the module', () => {
    assert.equal(/TIMEZONE_PATTERN/.test(SETTINGS_MJS), false, 'the regex check is still in settings.mjs');
    assert.match(SETTINGS_MJS, /new Intl\.DateTimeFormat\(undefined, \{ timeZone: value \}\)/);
  });

  it('agrees with scan-schedule.mjs on every value, in both directions', () => {
    for (const zone of REAL_ZONES) {
      assert.equal(isValidTimezone(zone), true, `${zone}: the schedule endpoint refuses it`);
      assert.doesNotThrow(() => validateSchedule({ timezone: zone }), `${zone}: the settings endpoint refuses it`);
    }
    for (const zone of FAKE_ZONES) {
      assert.equal(isValidTimezone(zone), false, `${zone}: the schedule endpoint accepts it`);
      assert.throws(() => validateSchedule({ timezone: zone }), `${zone}: the settings endpoint accepts it`);
    }
  });

  it('is mirrored, not imported - no scan-schedule import in settings.mjs (the cycle)', () => {
    assert.equal(/from\s+"\.\/scan-schedule\.mjs"/.test(SETTINGS_MJS), false);
    assert.equal(/from\s+"\.\/scan\.mjs"/.test(SETTINGS_MJS), false);
  });
});
