/**
 * UNIT tests for TASK-060 - "Simplify the processing job settings UI to
 * comma-separated domain and search-term fields".
 *
 * Scope of this file: the units, in isolation. One `describe` per Acceptance
 * Criterion group:
 *
 *   A  the shared `splitCommaList` / `joinCommaList` pair, by direct import
 *   B  the per-term row editor is gone (source + rendered DOM + controller)
 *   C  the domains field reads and renders through the list helpers
 *   D  search terms become one `jobField`-built input
 *   E  element ids and error routing
 *   F  client-side pre-flight validation
 *   G  the stale comments that asserted the OLD rule
 *   H  the CSS cleanup
 *   I  the copy in settings.html and the field labels
 *   J  the regression guards (no markup sink, re-render normalisation)
 *
 * NO DATABASE IS TOUCHED and NO NETWORK CALL IS MADE. `splitCommaList` and
 * `joinCommaList` are pure and are called directly; every page built below gets
 * an INJECTED `api` whose methods are local async functions, plus a `fetchImpl`
 * that THROWS, so a test that accidentally reached the network would fail
 * loudly rather than quietly pass.
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/task-060-comma-separated-job-fields-flow.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar');
const FRONTEND_DIR = path.join(CALENDAR_DIR, 'frontend');

const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { parseHtml, findElements, textOf, walk } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const SETTINGS_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.js'), 'utf-8');
const SETTINGS_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf-8');
const STYLES_CSS = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf-8');
const BACKEND_SETTINGS = fs.readFileSync(path.join(CALENDAR_DIR, 'backend', 'settings.mjs'), 'utf-8');
const BACKEND_GMAIL = fs.readFileSync(path.join(CALENDAR_DIR, 'backend', 'gmail.mjs'), 'utf-8');

const { splitCommaList, joinCommaList } = settings;

const XSS = '<img src=x onerror=alert(1)>';

/** One complete, valid job in the post-TASK-059 shape. */
const job = (overrides = {}) => ({
  id: 'job-1',
  name: 'Ashfield',
  schoolName: 'Ashfield Public School',
  domains: ['ashfield-p.schools.nsw.edu.au'],
  searchTerms: [],
  ...overrides,
});

/** The smallest document `renderProcessingJobs` can be driven against. */
function makeJobsHost() {
  const doc = parseHtml(
    '<html><body><form id="settings-form">' +
      '<div id="processing-jobs" class="jobs"></div>' +
      '<p id="processing-jobs-empty" class="field-hint" hidden></p>' +
      '</form></body></html>'
  );
  return { doc, container: doc.getElementById('processing-jobs') };
}

/** A minimal settings form, for the controller scenarios. */
function makeSettingsDoc() {
  return parseHtml(`<html><body data-page="settings">
    <section id="connection-state"></section>
    <div id="settings-body" hidden>
      <p id="settings-summary"></p>
      <form id="settings-form" novalidate>
        <div id="processing-jobs" class="jobs"></div>
        <p id="processing-jobs-empty" class="field-hint" hidden></p>
        <p id="error-processingJobs" class="field-error" role="alert" hidden></p>
        <button id="add-processing-job" type="button" class="btn">Add processing job</button>
        <input id="schedule-enabled-input" class="field-checkbox" type="checkbox" />
        <select id="schedule-frequency-input" class="field-input"><option value="daily">Daily</option></select>
        <select id="schedule-day-input" class="field-input"><option value="0">Sunday</option></select>
        <input id="schedule-hour-input" class="field-input" type="number" />
        <input id="timezone-input" class="field-input" type="text" />
        <p id="error-scheduleEnabled" class="field-error" hidden></p>
        <p id="error-scheduleFrequency" class="field-error" hidden></p>
        <p id="error-scheduleHour" class="field-error" hidden></p>
        <p id="error-dayOfWeek" class="field-error" hidden></p>
        <p id="error-timezone" class="field-error" hidden></p>
        <p id="error-form" class="field-error" role="alert" hidden></p>
        <p id="settings-status" class="notice" hidden></p>
        <button id="save-settings" type="submit" class="btn btn-primary">Save settings</button>
      </form>
    </div>
  </body></html>`);
}

/**
 * An injected api client. NOTHING here touches the network - every method is a
 * local async function that records its call and answers from a script.
 */
function makeApi({ settingsBody = {}, putResult } = {}) {
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
      if (url === settings.SCHEDULE_ENDPOINT) return ok({ available: true });
      return putResult ?? ok(settingsBody);
    },
    del: async (url) => {
      calls.push({ method: 'DELETE', url });
      return ok({ available: true });
    },
    isHalted: () => false,
    reset: () => {},
  };
}

/** Start a controller against the minimal form with the given stored jobs. */
async function openPage(processingJobs, apiOptions = {}) {
  const doc = makeSettingsDoc();
  const settingsBody = {
    connectionStatus: 'connected',
    email: 'parent@example.test',
    processingJobs,
    scheduleEnabled: false,
    scheduleFrequency: 'daily',
    scheduleHour: 7,
    timezone: 'Australia/Sydney',
  };
  const api = makeApi({ settingsBody, ...apiOptions });
  const page = settings.createSettingsPage({
    document: doc,
    api,
    detectTimezone: () => 'Australia/Sydney',
    fetchImpl: () => {
      throw new Error('a unit test reached for the network');
    },
  });
  await page.start();
  return { doc, page, api };
}

const valueOf = (doc, id) => doc.getElementById(id)?.value;
const putBodies = (api) =>
  api.calls.filter((call) => call.method === 'PUT' && call.url === settings.SETTINGS_ENDPOINT).map((call) => call.body);

/* =========================================================================
 * A. The shared split/join helper pair
 * ========================================================================= */

describe('TASK-060 unit A: splitCommaList and joinCommaList', () => {
  it('A1. exports exactly ONE parser pair, and nothing else splits or joins a job field', () => {
    assert.equal(typeof splitCommaList, 'function');
    assert.equal(typeof joinCommaList, 'function');

    // No SECOND, field-specific splitting or joining expression anywhere in the
    // file. `.split(",")` and `.join(", ")` may each appear exactly once - inside
    // the helper that owns them.
    const splits = SETTINGS_JS.match(/\.split\(\s*["'],["']\s*\)/g) || [];
    assert.equal(splits.length, 1, `settings.js splits on a comma in ${splits.length} places, not 1`);
    // Two `.join(", ")` exist: this pair's, and `renderSummary`'s join of job
    // NAMES for the summary line, which predates this ticket and is not a job
    // list FIELD. What must hold is that neither list field joins or splits
    // outside the pair, so the check is scoped to the renderer and the reader.
    const joins = SETTINGS_JS.match(/\.join\(\s*["'],\s["']\s*\)/g) || [];
    assert.equal(joins.length, 2, `settings.js joins with ", " in ${joins.length} places, not 2`);

    const renderer = SETTINGS_JS.slice(
      SETTINGS_JS.indexOf('function jobBlock'),
      SETTINGS_JS.indexOf('export function createSettingsPage')
    );
    const domReader = SETTINGS_JS.slice(
      SETTINGS_JS.indexOf('function readJobsFromDom'),
      SETTINGS_JS.indexOf('function syncJobsFromDom')
    );
    for (const [where, source] of [['jobBlock', renderer], ['readJobsFromDom', domReader]]) {
      assert.equal(/\.join\(/.test(source), false, `${where} joins a job field itself`);
      assert.equal(/\.split\(/.test(source), false, `${where} splits a job field itself`);
      assert.ok(/joinCommaList|splitCommaList/.test(source), `${where} does not go through the shared pair`);
    }

    // And the one split lives inside splitCommaList, the one join inside
    // joinCommaList - not in the renderer or the DOM reader.
    const splitBody = SETTINGS_JS.slice(
      SETTINGS_JS.indexOf('export function splitCommaList'),
      SETTINGS_JS.indexOf('export function joinCommaList')
    );
    assert.match(splitBody, /\.split\(","\)/, 'the one comma split is not inside splitCommaList');
  });

  it('A2. treats "," as the ONLY delimiter - whitespace and semicolons are not', () => {
    assert.deepEqual(splitCommaList('a.edu.au b.edu.au'), ['a.edu.au b.edu.au']);
    assert.deepEqual(splitCommaList('a.edu.au;b.edu.au'), ['a.edu.au;b.edu.au']);
    assert.deepEqual(splitCommaList('a.edu.au\tb.edu.au'), ['a.edu.au\tb.edu.au']);
    assert.deepEqual(splitCommaList('uniform shop'), ['uniform shop']);
    // A newline is not a delimiter either; it is trimmed at the edges only.
    assert.deepEqual(splitCommaList('a\nb'), ['a\nb']);
  });

  it('A3. trims each piece, drops blanks, keeps typed order, dedupes nothing and caps nothing', () => {
    assert.deepEqual(splitCommaList('  a  ,  b  ,  c  '), ['a', 'b', 'c']);
    // Order is the order typed, never sorted.
    assert.deepEqual(splitCommaList('zeta, alpha, mid'), ['zeta', 'alpha', 'mid']);
    // NO de-duplication - the server collapses duplicate domains itself.
    assert.deepEqual(splitCommaList('a.edu.au, a.edu.au'), ['a.edu.au', 'a.edu.au']);
    // NO case-folding.
    assert.deepEqual(splitCommaList('Ashfield, ASHFIELD'), ['Ashfield', 'ASHFIELD']);
    // NO cap on how many come back.
    const many = Array.from({ length: 200 }, (_, index) => `t${index}`);
    assert.deepEqual(splitCommaList(many.join(', ')), many);
  });

  it('A4. tolerates a trailing, leading, doubled or space-padded comma rather than erroring', () => {
    for (const [typed, parsed] of [
      ['a, b,', ['a', 'b']],
      [',a', ['a']],
      ['a,,b', ['a', 'b']],
      ['a, , ,b', ['a', 'b']],
      ['  a  ,  b  ', ['a', 'b']],
      [',,a,,b,,', ['a', 'b']],
      ['a,', ['a']],
    ]) {
      assert.deepEqual(splitCommaList(typed), parsed, JSON.stringify(typed));
    }
  });

  it('A5. returns [] for blank, comma-only and non-string input, and never throws', () => {
    for (const empty of ['', '   ', '\t\n ', ',', ' , , ', ',,,']) {
      assert.deepEqual(splitCommaList(empty), [], JSON.stringify(empty));
    }
    for (const notAString of [null, undefined, 42, 0, NaN, true, false, ['a'], { a: 1 }, Symbol('a'), () => {}]) {
      assert.deepEqual(splitCommaList(notAString), [], String(notAString));
    }
  });

  it('A6. joins with ", ", skipping non-strings and blanks, and never throws', () => {
    assert.equal(joinCommaList(['a', 'b', 'c']), 'a, b, c');
    assert.equal(joinCommaList(['a', '', 'b']), 'a, b', 'a stored blank rendered as an empty slot');
    assert.equal(joinCommaList(['a', '   ', 'b']), 'a, b');
    assert.equal(joinCommaList(['a', null, undefined, 7, {}, ['b'], 'c']), 'a, c');
    assert.equal(joinCommaList(['solo']), 'solo');
    // A non-array and an empty array are both "".
    for (const nothing of [[], null, undefined, 'a, b', 42, {}, true]) {
      assert.equal(joinCommaList(nothing), '', String(nothing));
    }
  });

  it('A7. round-trips: splitCommaList(joinCommaList(list)) deep-equals list', () => {
    for (const list of [
      ['a.edu.au'],
      ['a.edu.au', 'b.edu.au', 'c.edu.au'],
      ['canteen', 'uniform shop', 'working bee'],
      ["St Mary's", 'Year 4', XSS],
      [],
      Array.from({ length: 50 }, (_, index) => `term-${index}`),
    ]) {
      assert.deepEqual(splitCommaList(joinCommaList(list)), list, JSON.stringify(list));
    }
  });

  it('A7 (edge). the round trip is lossy ONLY for a stored entry that itself contains a comma', () => {
    // J4: accepted and documented. A legacy "canteen, roster" saved before this
    // ticket renders as one field and splits into two on the next save.
    assert.equal(joinCommaList(['canteen, roster']), 'canteen, roster');
    assert.deepEqual(splitCommaList('canteen, roster'), ['canteen', 'roster']);
  });

  it('A8. both helpers are pure - no DOM, no module state, importable on their own', () => {
    // Called with no document in scope at all (this is node, not a browser) and
    // repeated calls with the same input give the same answer.
    assert.equal(typeof globalThis.document, 'undefined', 'a document leaked into the unit environment');
    const first = splitCommaList('a, b');
    const second = splitCommaList('a, b');
    assert.deepEqual(first, second);
    assert.notEqual(first, second, 'the helper returns a shared, mutable array');
    // Mutating the answer cannot affect the next call.
    first.push('c');
    assert.deepEqual(splitCommaList('a, b'), ['a', 'b']);
    // And joinCommaList does not mutate the list it is given.
    const list = ['a', '', 'b'];
    joinCommaList(list);
    assert.deepEqual(list, ['a', '', 'b']);
  });
});

/* =========================================================================
 * B. The per-term row editor is removed
 * ========================================================================= */

describe('TASK-060 unit B: the per-term row editor is gone', () => {
  it('B1. termsBlock is deleted: no ul/li, no .job__term(s), no job-<i>-terms id', () => {
    assert.equal(SETTINGS_JS.includes('termsBlock'), false, 'termsBlock is still defined');
    assert.equal(/job__terms?\b/.test(SETTINGS_JS), false, 'a term class name survived in settings.js');

    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['a', 'b', 'c'] })]);
    const built = new Set();
    walk(doc.getElementById('processing-jobs'), (node) => built.add(node.tagName), false);
    assert.equal(built.has('UL'), false, 'a <ul> was built');
    assert.equal(built.has('LI'), false, 'an <li> was built');
    assert.equal(doc.getElementById('job-0-terms'), null);
    assert.equal(doc.getElementById('job-0-terms-label'), null);
  });

  it('B2. addTerm and removeTerm are gone from the handlers and the controller', async () => {
    assert.equal(SETTINGS_JS.includes('onAddTerm'), false);
    assert.equal(SETTINGS_JS.includes('onRemoveTerm'), false);
    assert.equal(/function addTerm\b/.test(SETTINGS_JS), false, 'addTerm is still defined');
    assert.equal(/function removeTerm\b/.test(SETTINGS_JS), false, 'removeTerm is still defined');

    const { page } = await openPage([job()]);
    assert.equal(page.addTerm, undefined);
    assert.equal(page.removeTerm, undefined);
    assert.equal('addTerm' in page, false);
    assert.equal('removeTerm' in page, false);
  });

  it('B3. renderProcessingJobs\' @param docblock lists the real remaining handler set', () => {
    const index = SETTINGS_JS.indexOf('export function renderProcessingJobs');
    const docblock = SETTINGS_JS.slice(SETTINGS_JS.lastIndexOf('/**', index), index);
    assert.equal(/onAddTerm|onRemoveTerm/.test(docblock), false, 'the docblock still promises a term handler');
    for (const handler of ['onRemoveJob', 'onConfirmRemoveJob', 'onCancelRemoveJob', 'confirmingKey']) {
      assert.ok(docblock.includes(handler), `the docblock no longer names ${handler}`);
    }
  });

  it('B4. rowButton takes four parameters and writes no data-term-index', () => {
    assert.match(SETTINGS_JS, /function rowButton\(doc, id, text, index\)\s*\{/);
    assert.equal(SETTINGS_JS.includes('data-term-index'), false);
    const index = SETTINGS_JS.indexOf('function rowButton');
    const docblock = SETTINGS_JS.slice(SETTINGS_JS.lastIndexOf('/**', index), index);
    assert.equal(/optionally its term/i.test(docblock), false, 'the rowButton docblock still mentions a term');

    // All four surviving call sites pass four arguments.
    const calls = (SETTINGS_JS.match(/rowButton\(\s*doc,[^;]*?\);/gs) || []).filter(
      (call) => !call.startsWith('rowButton(doc, id, text, index)')
    );
    assert.equal(calls.length, 3, `expected 3 rowButton call sites, found ${calls.length}`);
    for (const call of calls) {
      assert.equal(call.split(',').length, 4, `a rowButton call site passes the wrong arity: ${call}`);
    }
  });

  it('B5. no data-term-index attribute, add-term-<i> or remove-job-<i>-term-<j> is rendered', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(
      doc,
      container,
      [{ ...job({ searchTerms: ['a', 'b'] }), key: 'row-1' }],
      { confirmingKey: 'row-1' }
    );
    assert.deepEqual(doc.getElementById('processing-jobs').querySelectorAll('[data-term-index]'), []);
    assert.equal(doc.getElementById('add-term-0'), null);
    assert.equal(doc.getElementById('remove-job-0-term-0'), null);
    assert.equal(doc.getElementById('remove-job-0-term-1'), null);
    assert.equal(doc.getElementById('job-0-term-0'), null);

    const buttonIds = findElements(doc.getElementById('processing-jobs'), 'button').map((node) =>
      node.getAttribute('id')
    );
    assert.deepEqual(buttonIds.sort(), ['cancel-remove-job-0', 'confirm-remove-job-0']);
  });

  it('B6. the arm / confirm / cancel flow and the one-armed-row rule are UNCHANGED', async () => {
    const { doc, page } = await openPage([job({ name: 'A' }), job({ id: 'job-2', name: 'B' })]);

    page.armRemoveJob(0);
    assert.equal(doc.getElementById('processing-jobs').querySelectorAll('.job').length, 2, 'arming removed a row');
    assert.notEqual(doc.getElementById('confirm-remove-job-0'), null);
    assert.equal(doc.getElementById('remove-job-0'), null, 'the arming control was not replaced');

    // Arming a different row invalidates the first.
    page.armRemoveJob(1);
    assert.equal(doc.getElementById('confirm-remove-job-0'), null, 'two rows were armed at once');
    assert.notEqual(doc.getElementById('confirm-remove-job-1'), null);

    // The gate is the armed key, not the presence of a control.
    assert.equal(page.confirmRemoveJob(0), false);
    assert.equal(doc.getElementById('processing-jobs').querySelectorAll('.job').length, 2);

    page.armRemoveJob(1);
    assert.equal(page.confirmRemoveJob(1), true);
    assert.equal(doc.getElementById('processing-jobs').querySelectorAll('.job').length, 1);
    assert.equal(page.state.confirmingKey, null);

    page.armRemoveJob(0);
    page.cancelRemoveJob(0);
    assert.equal(page.state.confirmingKey, null);
    assert.notEqual(doc.getElementById('remove-job-0'), null);
  });
});

/* =========================================================================
 * C. The domains field reads and renders through the list helpers
 * ========================================================================= */

describe('TASK-060 unit C: the domains field', () => {
  it('C1. toEditableJobs produces `domains`, never `domain`, with searchTerms\' tolerance', () => {
    const rows = settings.toEditableJobs([
      { id: 'job-1', name: 'A', schoolName: 'A School', domains: ['a.edu.au', 7, null, 'b.edu.au'] },
    ]);
    assert.deepEqual(rows[0].domains, ['a.edu.au', '', '', 'b.edu.au'], 'a non-string was not coerced to ""');
    assert.equal('domain' in rows[0], false, 'an editable row still carries the superseded key');
    // A non-array stored value is no entries at all.
    for (const notAList of ['a.edu.au', 42, null, undefined, { 0: 'a.edu.au' }]) {
      assert.deepEqual(settings.toEditableJobs([{ domains: notAList }])[0].domains, [], String(notAList));
    }
    // Exactly the tolerance already applied to searchTerms.
    assert.deepEqual(
      settings.toEditableJobs([{ domains: [1, 'a'], searchTerms: [1, 'a'] }])[0].domains,
      settings.toEditableJobs([{ domains: [1, 'a'], searchTerms: [1, 'a'] }])[0].searchTerms
    );
  });

  it('C2. emptyProcessingJob is { id, name, schoolName, domains: [], searchTerms: [] }', () => {
    assert.deepEqual(settings.emptyProcessingJob(), {
      id: '',
      name: '',
      schoolName: '',
      domains: [],
      searchTerms: [],
    });
    assert.deepEqual(Object.keys(settings.emptyProcessingJob()).sort(), [
      'domains',
      'id',
      'name',
      'schoolName',
      'searchTerms',
    ]);
  });

  it('C3. jobBlock renders domains with the shared jobField builder and a joined value', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [
      job({ domains: ['a.edu.au', 'b.edu.au', 'c.edu.au'] }),
    ]);
    const input = doc.getElementById('job-0-domains');
    assert.equal(input.value, 'a.edu.au, b.edu.au, c.edu.au');
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.getAttribute('type'), 'text');
    assert.equal(input.className, 'field-input');
    assert.equal(input.getAttribute('data-job-index'), '0');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    assert.equal(input.parentNode.className, 'field');
    assert.notEqual(doc.getElementById('error-job-0-domains'), null);
  });

  it('C4. readJobsFromDom splits the domains text, and falls back to the ARRAY in state', async () => {
    const { doc, page } = await openPage([job({ domains: ['a.edu.au', 'b.edu.au'] })]);
    doc.getElementById('job-0-domains').value = 'x.edu.au, y.edu.au,';
    assert.deepEqual(page.readJobsFromDom()[0].domains, ['x.edu.au', 'y.edu.au']);

    // "" is a REAL value - the user cleared the field.
    doc.getElementById('job-0-domains').value = '';
    assert.deepEqual(page.readJobsFromDom()[0].domains, []);

    // An ABSENT input is not "the user cleared the field": the array already in
    // state is kept, not [] and not splitCommaList("").
    const stripped = await openPage([job({ domains: ['a.edu.au', 'b.edu.au'] })]);
    const row = stripped.doc.getElementById('job-0-domains');
    row.parentNode.removeChild(row);
    assert.equal(stripped.doc.getElementById('job-0-domains'), null);
    assert.deepEqual(stripped.page.readJobsFromDom()[0].domains, ['a.edu.au', 'b.edu.au']);
  });

  it('C5. buildJobsPayload sends domains as a trimmed, non-blank list and no `domain` key', () => {
    const out = settings.buildJobsPayload([
      { id: 'job-1', name: 'A', schoolName: 'S', domains: [' a.edu.au ', '', '  ', null, 7, 'b.edu.au'] },
      { id: '', key: 'row-2', name: 'B', schoolName: 'S2', domains: ['c.edu.au'] },
    ]);
    assert.deepEqual(out[0].domains, ['a.edu.au', 'b.edu.au']);
    for (const entry of out) {
      assert.equal('domain' in entry, false, 'a `domain` key reached the payload');
    }
    // The id round-trip rule is unchanged.
    assert.equal(out[0].id, 'job-1');
    assert.equal('id' in out[1], false, 'a row added this session sent an id');
    assert.equal('key' in out[1], false);
  });

  it('C6. an invalid-looking domain is SENT, not refused locally', () => {
    for (const typed of ['gmail.com', 'not a domain at all', '..', 'a'.repeat(500), '<script>']) {
      assert.deepEqual(splitCommaList(typed), [typed], typed);
      assert.equal(settings.validateProcessingJobsClient([job({ domains: [typed] })]), null, typed);
      assert.deepEqual(settings.buildJobsPayload([job({ domains: [typed] })])[0].domains, [typed]);
    }
    // No count cap either.
    const many = Array.from({ length: 60 }, (_, index) => `d${index}.edu.au`);
    assert.deepEqual(splitCommaList(many.join(', ')), many);
  });
});

/* =========================================================================
 * D. Search terms become one jobField-built input
 * ========================================================================= */

describe('TASK-060 unit D: the search-terms field', () => {
  it('D1. is built by the SAME jobField helper, with the same attributes as every other field', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['canteen'] })]);

    const terms = doc.getElementById('job-0-searchTerms');
    const name = doc.getElementById('job-0-name');
    assert.notEqual(terms, null, 'job-0-searchTerms is missing');
    for (const attribute of ['type', 'data-job-index', 'autocomplete']) {
      assert.equal(terms.getAttribute(attribute), name.getAttribute(attribute), attribute);
    }
    assert.equal(terms.getAttribute('type'), 'text');
    assert.equal(terms.getAttribute('autocomplete'), 'off');
    assert.equal(terms.className, 'field-input');
    assert.equal(terms.parentNode.className, 'field');
    // No bespoke builder and no new input type anywhere on the row.
    for (const input of findElements(doc.getElementById('processing-jobs'), 'input')) {
      assert.equal(input.getAttribute('type'), 'text', input.getAttribute('id'));
      assert.equal(input.className, 'field-input', input.getAttribute('id'));
    }
  });

  it('D2. its error slot is the id jobField creates, error-job-<i>-searchTerms', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job(), job({ id: 'job-2', name: 'B' })]);
    for (const index of [0, 1]) {
      const slot = doc.getElementById(`error-job-${index}-searchTerms`);
      assert.notEqual(slot, null, `error-job-${index}-searchTerms is missing`);
      assert.equal(slot.tagName, 'P');
      assert.equal(slot.className, 'field-error');
      assert.equal(slot.getAttribute('role'), 'alert');
      assert.equal(slot.hidden, true);
    }
    assert.equal(settings.fieldErrorId('processingJobs[1].searchTerms'), 'error-job-1-searchTerms');
  });

  it('D3. its value is joinCommaList(job.searchTerms)', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [
      job({ searchTerms: ['canteen', 'uniform shop'] }),
      job({ id: 'job-2', name: 'B', searchTerms: [] }),
      job({ id: 'job-3', name: 'C', searchTerms: ['a', '', 'b'] }),
    ]);
    assert.equal(valueOf(doc, 'job-0-searchTerms'), 'canteen, uniform shop');
    assert.equal(valueOf(doc, 'job-1-searchTerms'), '');
    assert.equal(valueOf(doc, 'job-2-searchTerms'), 'a, b', 'a stored blank rendered as an empty slot');
  });

  it('D4. readJobsFromDom splits the terms text, with the same missing-element fallback', async () => {
    const { doc, page } = await openPage([job({ searchTerms: ['canteen'] })]);
    doc.getElementById('job-0-searchTerms').value = 'canteen, uniform shop, working bee';
    assert.deepEqual(page.readJobsFromDom()[0].searchTerms, ['canteen', 'uniform shop', 'working bee']);

    doc.getElementById('job-0-searchTerms').value = '';
    assert.deepEqual(page.readJobsFromDom()[0].searchTerms, []);

    const stripped = await openPage([job({ searchTerms: ['canteen', 'fete'] })]);
    const input = stripped.doc.getElementById('job-0-searchTerms');
    input.parentNode.removeChild(input);
    assert.deepEqual(stripped.page.readJobsFromDom()[0].searchTerms, ['canteen', 'fete']);

    // And the per-term reads are gone from the source.
    assert.equal(/job-\$\{index\}-term-/.test(SETTINGS_JS), false, 'a per-term DOM read survived');
  });

  it('D5. buildJobsPayload still trims and drops blank terms, belt and braces', () => {
    const out = settings.buildJobsPayload([
      { name: 'A', schoolName: 'S', searchTerms: ['  canteen  ', '', '   ', null, 7, 'fete'] },
    ]);
    assert.deepEqual(out[0].searchTerms, ['canteen', 'fete']);
    assert.deepEqual(settings.buildJobsPayload([{ searchTerms: 'canteen, fete' }])[0].searchTerms, []);
  });

  it('D6. the accessible label follows jobField\'s "<labelText> for <describedAs>" pattern', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [
      job({ name: 'Ashfield' }),
      job({ id: 'job-2', name: 'St Marys' }),
    ]);
    const first = doc.getElementById('job-0-searchTerms').getAttribute('aria-label');
    const second = doc.getElementById('job-1-searchTerms').getAttribute('aria-label');
    assert.equal(first, 'Search terms (comma separated) for processing job "Ashfield"');
    assert.equal(second, 'Search terms (comma separated) for processing job "St Marys"');
    assert.notEqual(first, second, 'two rows announce an identical search-terms field');
    assert.equal(
      doc.getElementById('job-0-domains').getAttribute('aria-label'),
      'Email domains (comma separated) for processing job "Ashfield"'
    );

    // And an unnamed row still gets a distinct label, from its position.
    const blank = makeJobsHost();
    settings.renderProcessingJobs(blank.doc, blank.container, [job({ name: '' }), job({ id: 'job-2', name: '' })]);
    assert.notEqual(
      blank.doc.getElementById('job-0-searchTerms').getAttribute('aria-label'),
      blank.doc.getElementById('job-1-searchTerms').getAttribute('aria-label')
    );
  });
});

/* =========================================================================
 * E. Element ids and error routing
 * ========================================================================= */

describe('TASK-060 unit E: element ids and error routing', () => {
  it('E1. JOB_ERROR_FIELDS is ["name","schoolName","domains","searchTerms"] with no `domain` alias', () => {
    assert.deepEqual([...settings.JOB_ERROR_FIELDS], ['name', 'schoolName', 'domains', 'searchTerms']);
    assert.equal(settings.JOB_ERROR_FIELDS.includes('domain'), false, '`domain` was kept as an alias');
    assert.ok(Object.isFrozen(settings.JOB_ERROR_FIELDS), 'the allowlist must not be mutable');
  });

  it('E2. the DOM element ids are job-<i>-domains / error-job-<i>-domains, and the comment says so', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job(), job({ id: 'job-2' }), job({ id: 'job-3' })]);
    assert.notEqual(doc.getElementById('job-2-domains'), null);
    assert.notEqual(doc.getElementById('error-job-2-domains'), null);
    assert.equal(doc.getElementById('job-2-domain'), null, 'the singular element id survived');
    assert.equal(doc.getElementById('error-job-2-domain'), null);
    // The id builder concatenates the server's own key, so the two line up 1:1.
    assert.equal(settings.fieldErrorId('processingJobs[2].domains'), 'error-job-2-domains');
    assert.notEqual(doc.getElementById(settings.fieldErrorId('processingJobs[2].domains')), null);
    // The decision is recorded in the renderer's section comment, and its
    // worked example is the PLURAL id. (The same comment still names the old
    // singular id once, in the prose explaining why it was NOT kept - that is
    // the rationale E2 asks for, not a stale example.)
    const sectionStart = SETTINGS_JS.indexOf('The processing-job rows');
    const section = SETTINGS_JS.slice(sectionStart, SETTINGS_JS.indexOf('*/', sectionStart));
    assert.match(section, /`job-2-domains`/, 'the worked example is not the plural id');
    assert.match(section, /error-job-<i>-domains/, 'the section does not record the renamed error slot');
    assert.match(section, /TASK-060|do not re-open/i, 'the rename is not recorded as a settled decision');
  });

  it('E3. fieldErrorId resolves the two renamed indexed keys', () => {
    assert.equal(settings.fieldErrorId('processingJobs[2].domains'), 'error-job-2-domains');
    assert.equal(settings.fieldErrorId('processingJobs[2].searchTerms'), 'error-job-2-searchTerms');
    assert.equal(settings.fieldErrorId('processingJobs[0].name'), 'error-job-0-name');
    assert.equal(settings.fieldErrorId('processingJobs[19].schoolName'), 'error-job-19-schoolName');
  });

  it('E4. the OLD singular processingJobs[2].domain fails closed to the form line', () => {
    assert.equal(settings.fieldErrorId('processingJobs[2].domain'), settings.FORM_ERROR_ID);
    assert.equal(settings.fieldErrorId('processingJobs[0].domain'), settings.FORM_ERROR_ID);
    // And no element with that id is rendered, so it could not have landed.
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job()]);
    assert.equal(doc.getElementById('error-job-0-domain'), null);
  });

  it('E5. the INDEXED_JOB_FIELD regex is unchanged: a bad index still resolves to the form line', () => {
    for (const hostile of [
      'processingJobs[-1].domains',
      'processingJobs[abc].domains',
      'processingJobs[].domains',
      'processingJobs[1e3].domains',
      'processingJobs[0].domains ',
      ' processingJobs[0].domains',
      'processingJobs[0].domains.evil',
      'processingJobs[0].__proto__',
      'xprocessingJobs[0].domains',
      42,
      null,
      undefined,
      {},
      ['processingJobs[0].domains'],
    ]) {
      assert.equal(settings.fieldErrorId(hostile), settings.FORM_ERROR_ID, String(hostile));
    }
    assert.match(SETTINGS_JS, /\/\^processingJobs\\\[\(\\d\+\)\\\]\\\.\(\[A-Za-z\]\+\)\$\//);
  });

  it('E6. showFieldError falls back to the form line, and clearErrors sweeps the renamed slots', async () => {
    const { doc, page } = await openPage([job()]);

    assert.deepEqual(page.showFieldError('processingJobs[0].domains', 'gmail.com is a public mail provider'), {
      id: 'error-job-0-domains',
      shown: true,
      text: 'gmail.com is a public mail provider',
    });
    assert.equal(doc.getElementById('error-form').hidden, true);

    page.clearErrors();
    assert.equal(doc.getElementById('error-job-0-domains').hidden, true, 'clearErrors missed the renamed slot');
    assert.equal(textOf(doc.getElementById('error-job-0-domains')), '');

    // A well-formed id with no element on the page still has somewhere to land.
    const orphan = page.showFieldError('processingJobs[9].domains', 'That domain is not accepted');
    assert.equal(orphan.id, settings.FORM_ERROR_ID);
    assert.equal(doc.getElementById('error-form').hidden, false);
    assert.equal(textOf(doc.getElementById('error-form')), 'That domain is not accepted');

    // FIELD_ERROR_IDS and FORM_ERROR_ID are untouched by this ticket.
    assert.equal(settings.FORM_ERROR_ID, 'error-form');
    assert.equal(settings.FIELD_ERROR_IDS.processingJobs, 'error-processingJobs');
    assert.equal(Object.prototype.hasOwnProperty.call(settings.FIELD_ERROR_IDS, 'domains'), false);
  });
});

/* =========================================================================
 * F. Client-side pre-flight validation
 * ========================================================================= */

describe('TASK-060 unit F: validateProcessingJobsClient', () => {
  it('F1. reads the already-parsed array and never re-splits a string or reads an input', () => {
    // A row carrying a comma-separated STRING is not re-split - and, since
    // there is no domains check at all, it is simply not looked at.
    assert.equal(settings.validateProcessingJobsClient([job({ domains: 'a.edu.au, b.edu.au' })]), null);
    const body = SETTINGS_JS.slice(
      SETTINGS_JS.indexOf('export function validateProcessingJobsClient'),
      SETTINGS_JS.indexOf('export function buildSettingsPayload')
    );
    assert.equal(/split|getElementById|\.value\b/.test(body), false, 'the pre-flight re-splits or touches the DOM');
  });

  it('F2. the check order is name -> duplicate name -> schoolName, topmost job first', () => {
    assert.equal(
      settings.validateProcessingJobsClient([job({ name: '', schoolName: '' })]).field,
      'processingJobs[0].name'
    );
    assert.equal(
      settings.validateProcessingJobsClient([job({ schoolName: '' })]).field,
      'processingJobs[0].schoolName'
    );
    assert.equal(
      settings.validateProcessingJobsClient([job({ name: 'A' }), job({ id: 'j2', name: 'a', schoolName: '' })]).field,
      'processingJobs[1].name',
      'the duplicate name was not reported before the blank school name'
    );
    assert.equal(
      settings.validateProcessingJobsClient([job({ schoolName: '' }), job({ id: 'j2', name: '' })]).field,
      'processingJobs[0].schoolName',
      'a lower job was reported before a higher one'
    );
  });

  it('F3. checks no shape, no provider, no length and no cap - and never checks searchTerms', () => {
    assert.equal(settings.validateProcessingJobsClient([job({ domains: ['gmail.com'] })]), null);
    assert.equal(settings.validateProcessingJobsClient([job({ name: 'A'.repeat(500) })]), null);
    assert.equal(
      settings.validateProcessingJobsClient([job({ searchTerms: Array.from({ length: 60 }, (_, i) => `t${i}`) })]),
      null
    );
    assert.equal(
      settings.validateProcessingJobsClient(
        Array.from({ length: 21 }, (_, index) => job({ id: `job-${index}`, name: `Job ${index}` }))
      ),
      null
    );
    for (const terms of [[], [''], ['   '], null, undefined, 'canteen', 42]) {
      assert.equal(settings.validateProcessingJobsClient([job({ searchTerms: terms })]), null, String(terms));
    }
  });

  it('F4. there is NO required-domains branch: an empty or missing domains list is valid', () => {
    for (const empty of [[], [''], ['   '], null, undefined, 'a.edu.au', 42, {}]) {
      assert.equal(
        settings.validateProcessingJobsClient([job({ domains: empty })]),
        null,
        `domains = ${JSON.stringify(empty)} was refused`
      );
    }
    // A job with no `domains` key at all is valid too.
    assert.equal(settings.validateProcessingJobsClient([{ name: 'A', schoolName: 'A School' }]), null);
    // And the source carries no such branch.
    const body = SETTINGS_JS.slice(
      SETTINGS_JS.indexOf('export function validateProcessingJobsClient'),
      SETTINGS_JS.indexOf('export function buildSettingsPayload')
    );
    // The body carries a COMMENT saying there is no such check; what must not
    // exist is the branch itself, i.e. a `domains` field name it could report.
    assert.equal(/field: at\(["']domains/.test(body), false, 'a domains branch survived');
    assert.deepEqual([...new Set(body.match(/at\(["']\w+["']\)/g) || [])].sort(), ['at("name")', 'at("schoolName")']);
  });

  it('F5. the duplicate-name check and its message are untouched', () => {
    const problem = settings.validateProcessingJobsClient([
      job({ name: 'Ashfield' }),
      job({ id: 'job-2', name: '  ashfield  ' }),
    ]);
    assert.equal(problem.field, 'processingJobs[1].name');
    assert.match(problem.error, /Ashfield/);
    assert.match(problem.error, /same processing job name|different name/i);
    assert.deepEqual(Object.keys(problem).sort(), ['error', 'field']);
    assert.equal(
      settings.validateProcessingJobsClient([job({ name: 'Ashfield' }), job({ id: 'job-2', name: 'Ashfield North' })]),
      null
    );
  });
});

/* =========================================================================
 * G. Stale comments corrected
 * ========================================================================= */

describe('TASK-060 unit G: the comments no longer assert the reversed rule', () => {
  it('G1. the module docblock names `domains`, drops "required" for it, and has no row editor', () => {
    const docblock = SETTINGS_JS.slice(0, SETTINGS_JS.indexOf('*/'));
    assert.match(docblock, /domains/, 'the header does not name the plural field');
    assert.match(docblock, /OPTIONAL/i, 'the header does not say domains is optional');
    assert.equal(/search-term row editor|Add search term/i.test(docblock), false);
    // Only name and schoolName are framed as required.
    assert.match(docblock, /REQUIRED name and schoolName/i);
  });

  it('G2. buildJobsPayload\'s docblock explains comma splitting, not a mind-changed Add button', () => {
    const index = SETTINGS_JS.indexOf('export function buildJobsPayload');
    const docblock = SETTINGS_JS.slice(SETTINGS_JS.lastIndexOf('/**', index), index);
    assert.equal(/Add search term/i.test(docblock), false, 'the docblock still cites the removed control');
    assert.match(docblock, /splitCommaList|comma/i, 'the docblock does not give the comma-splitting rationale');
  });

  it('G3/G4. the backend docblocks no longer claim a comma is safe inside a search term', () => {
    // A SCHOOL NAME may still legitimately contain a comma ("St Mary's Primary,
    // Manly") - that rule is untouched by this ticket. ONLY the search-term
    // claim is reversed, so the checks below are term-specific: the wording,
    // and the two worked examples each docblock used to justify it.
    for (const [name, source] of [['settings.mjs', BACKEND_SETTINGS], ['gmail.mjs', BACKEND_GMAIL]]) {
      assert.equal(
        /search term may legitimately[\s*]+contain a comma/i.test(source),
        false,
        `${name} still claims a search term may contain a comma`
      );
      assert.equal(
        /'Year 4, Kindy' is one phrase the user typed/.test(source),
        false,
        `${name} still gives the reversed example as current`
      );
      assert.equal(
        /neither lower-cased nor split on\s*\*?\s*commas/i.test(source),
        false,
        `${name} still states the reversed rule`
      );
    }
    // The school-name rule, which is NOT reversed, is still stated.
    assert.match(BACKEND_SETTINGS, /school name may legitimately[\s*]+contain a comma/i);
    // And both docblocks now record that the UI treats a comma as a delimiter.
    assert.match(BACKEND_SETTINGS, /TASK-060/, 'settings.mjs does not record the reversal');
    assert.match(BACKEND_GMAIL, /TASK-060|delimiter/i, 'gmail.mjs does not record the reversal');
    // The RULE itself stays: a bare string is still rejected, the API contract
    // is still a list.
    assert.match(BACKEND_SETTINGS, /Search terms must be a list/);
    assert.match(BACKEND_SETTINGS, /function validateSearchTerms/);
    assert.match(BACKEND_GMAIL, /function toSearchTermList/);
  });

  it('G5. no comment anywhere in these files says a comma is safe inside a search term', () => {
    for (const [name, source] of [
      ['settings.js', SETTINGS_JS],
      ['settings.mjs', BACKEND_SETTINGS],
      ['gmail.mjs', BACKEND_GMAIL],
    ]) {
      for (const line of source.split('\n')) {
        if (!/comma/i.test(line)) continue;
        assert.equal(
          /comma is safe|safe inside|never comma-split it|can(not| ?not)? be split on commas/i.test(line),
          false,
          `${name}: "${line.trim()}"`
        );
      }
    }
    // And settings.js states the reversal explicitly, so the next reader knows.
    assert.match(SETTINGS_JS, /comma can no longer be part of a search term|deliberate reversal/i);
  });
});

/* =========================================================================
 * H. CSS cleanup
 * ========================================================================= */

describe('TASK-060 unit H: styles.css', () => {
  const outside = css.outsideMediaQueries(STYLES_CSS);

  it('H1. the .job__terms and .job__term rules are deleted, with no reference left anywhere', () => {
    for (const dead of ['.job__terms', '.job__term']) {
      assert.deepEqual(css.rulesFor(outside, dead), [], `${dead} still has a rule`);
    }
    assert.equal(/\.job__terms?\b/.test(STYLES_CSS), false, 'a term class survived in the raw stylesheet');
    assert.equal(/job__terms?\b/.test(SETTINGS_JS), false, 'a term class survived in settings.js');
    assert.equal(/job__terms?\b/.test(SETTINGS_HTML), false, 'a term class survived in settings.html');
  });

  it('H2. the section comment describes the new shape, one field each', () => {
    const start = STYLES_CSS.indexOf('/* --- Settings: processing jobs');
    assert.notEqual(start, -1, 'the TASK-057 section comment went missing');
    const comment = STYLES_CSS.slice(start, STYLES_CSS.indexOf('*/', start));
    assert.equal(/one school, one domain/i.test(comment), false, 'the comment still says "one domain"');
    assert.match(comment, /domains/i);
    assert.match(comment, /\.field each|one \.field|each one field/i);
  });

  it('H3. .jobs, .job, .job__head, .job__actions and .job__confirm are untouched', () => {
    for (const selector of ['.jobs', '.job', '.job__head', '.job__actions', '.job__confirm']) {
      assert.ok(css.rulesFor(outside, selector).length >= 1, `no rule for ${selector}`);
    }
    assert.equal(css.declaredValue(outside, '.jobs', 'display'), 'grid');
    assert.equal(css.declaredValue(outside, '.job', 'display'), 'grid');
    for (const selector of ['.jobs', '.job']) {
      assert.equal(css.declaredValue(outside, selector, 'grid-template-columns'), null, selector);
    }
    // No overflow-x anywhere on the jobs list or inside it.
    for (const rule of css.eachRule(css.stripComments(STYLES_CSS).replace(/@media[^{]*\{/g, ''))) {
      if (!rule.selectors.some((selector) => /\.jobs?\b|\.job__/.test(selector))) continue;
      const declarations = css.declarationsOf(rule.body);
      assert.equal(declarations['overflow-x'], undefined, rule.selectors.join(', '));
      assert.equal(declarations.overflow, undefined, rule.selectors.join(', '));
    }
    // The inherited touch target still holds for every remaining job control.
    assert.equal(css.declaredValue(outside, '.btn', 'min-height'), '44px');
    assert.equal(css.declaredValue(outside, '.btn-small', 'min-height'), '44px');
  });

  it('H4. the new search-terms field needs no new CSS - it is .field / .field-input', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['canteen'] })]);
    const input = doc.getElementById('job-0-searchTerms');
    assert.equal(input.className, 'field-input');
    assert.equal(input.parentNode.className, 'field');
    assert.ok(css.rulesFor(outside, '.field-input').length >= 1);
    assert.ok(css.rulesFor(outside, '.field').length >= 1);
    // And no rule was added naming the search-terms field specifically.
    assert.equal(/searchTerms|search-terms/i.test(STYLES_CSS), false, 'a bespoke search-terms rule was added');
  });
});

/* =========================================================================
 * I. Copy in settings.html and the field labels
 * ========================================================================= */

describe('TASK-060 unit I: the shipped copy', () => {
  const doc = parseHtml(SETTINGS_HTML);

  it('I1. the intro hint explains commas and optional domains, and KEEPS the gmail.com warning', () => {
    const hints = findElements(doc.getElementById('settings-form'), 'p')
      .filter((node) => node.className === 'field-hint')
      .map((node) => textOf(node));
    const intro = hints.find((text) => /comma/i.test(text));
    assert.ok(intro, `no hint mentions commas, saw: ${hints.join(' | ')}`);
    assert.match(intro, /domain/i);
    assert.match(intro, /search/i);
    assert.match(intro, /optional/i, 'the hint does not say domains are optional');
    assert.match(intro, /school name/i);
    assert.match(intro, /gmail\.com/, 'the public mail provider warning was dropped');
  });

  it('I2. the two labels read "... (comma separated)", through jobField\'s labelText', () => {
    const host = makeJobsHost();
    settings.renderProcessingJobs(host.doc, host.container, [job()]);
    for (const [key, label] of [
      ['domains', 'Email domains (comma separated)'],
      ['searchTerms', 'Search terms (comma separated)'],
    ]) {
      const labelNode = host.doc.getElementById('processing-jobs').querySelector(`label[for="job-0-${key}"]`);
      assert.notEqual(labelNode, null, `no <label for="job-0-${key}">`);
      assert.equal(textOf(labelNode), label);
      assert.equal(labelNode.className, 'field-label');
      // The same text flows into the aria-label with no extra machinery.
      assert.equal(
        host.doc.getElementById(`job-0-${key}`).getAttribute('aria-label'),
        `${label} for processing job "Ashfield"`
      );
    }
  });

  it('I3. the "Extra search terms" heading and its job-<i>-terms-label id are gone', () => {
    // The HEADING, exactly as it was rendered - not the module docblock's prose
    // "its extra search terms", which is a description of what a job has.
    assert.equal(SETTINGS_HTML.includes('Extra search terms'), false, 'the heading survived in the markup');
    assert.equal(SETTINGS_JS.includes('Extra search terms'), false, 'the heading survived in settings.js');
    assert.equal(SETTINGS_JS.includes('terms-label'), false);
    const host = makeJobsHost();
    settings.renderProcessingJobs(host.doc, host.container, [job({ searchTerms: ['a'] })]);
    assert.equal(host.doc.getElementById('job-0-terms-label'), null);
  });

  it('I4. no new element id is added to settings.html - the per-job markup is script-built', () => {
    assert.equal(doc.getElementById('processing-jobs').children.length, 0, 'the container must ship empty');
    for (const scripted of ['job-0-name', 'job-0-domains', 'job-0-searchTerms', 'error-job-0-domains']) {
      assert.equal(doc.getElementById(scripted), null, `${scripted} was baked into the static markup`);
      assert.equal(SETTINGS_HTML.includes(`id="${scripted}"`), false, scripted);
    }
    // The static ids the page has always shipped are still there.
    for (const id of ['processing-jobs', 'processing-jobs-empty', 'error-processingJobs', 'add-processing-job']) {
      assert.notEqual(doc.getElementById(id), null, `${id} went missing`);
    }
  });
});

/* =========================================================================
 * J. Regression and non-scope
 * ========================================================================= */

describe('TASK-060 unit J: regression guards', () => {
  it('J2. settings.js reaches the DOM through no markup sink at all', () => {
    // Property ACCESS, not the word: the docblock names innerHTML in a comment
    // explaining why it does not use it, and that comment must stay legal.
    assert.deepEqual(SETTINGS_JS.match(/\.innerHTML/g) || [], []);
    assert.deepEqual(SETTINGS_JS.match(/\.outerHTML/g) || [], []);
    assert.deepEqual(SETTINGS_JS.match(/\.insertAdjacentHTML\(/g) || [], []);
    assert.deepEqual(SETTINGS_JS.match(/document\.write/g) || [], []);
    assert.deepEqual(SETTINGS_JS.match(/createContextualFragment/g) || [], []);

    // Including the comma-joined string joinCommaList produces.
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [
      job({ domains: [XSS, 'a.edu.au'], searchTerms: ['<script>alert(1)</script>', 'canteen'] }),
    ]);
    assert.equal(valueOf(doc, 'job-0-domains'), `${XSS}, a.edu.au`);
    assert.equal(valueOf(doc, 'job-0-searchTerms'), '<script>alert(1)</script>, canteen');
    assert.deepEqual(findElements(doc.getElementById('processing-jobs'), 'img'), []);
    assert.deepEqual(findElements(doc.getElementById('processing-jobs'), 'script'), []);
  });

  it('J3. a structural action normalises the in-progress text without losing or reordering it', async () => {
    const { doc, page } = await openPage([job()]);
    doc.getElementById('job-0-domains').value = 'b.edu.au, a.edu.au,';
    doc.getElementById('job-0-searchTerms').value = 'fete, , disco,';

    page.addJob();

    // The empty pieces are dropped; nothing is cleared or reordered.
    assert.equal(valueOf(doc, 'job-0-domains'), 'b.edu.au, a.edu.au');
    assert.equal(valueOf(doc, 'job-0-searchTerms'), 'fete, disco');
    assert.equal(valueOf(doc, 'job-1-name'), '');

    // The same is true of arming and cancelling a removal.
    doc.getElementById('job-0-domains').value = '  c.edu.au ,, d.edu.au  ';
    page.armRemoveJob(1);
    assert.equal(valueOf(doc, 'job-0-domains'), 'c.edu.au, d.edu.au');
    page.cancelRemoveJob(1);
    assert.equal(valueOf(doc, 'job-0-domains'), 'c.edu.au, d.edu.au');

    // And the acceptance is documented in a code comment.
    assert.match(SETTINGS_JS, /NORMALISATION ON RE-RENDER IS ACCEPTED/i);
  });

  it('J4. the lossy join of a legacy comma-bearing entry is documented', () => {
    assert.match(SETTINGS_JS, /LOSSY BY DESIGN|lossy/i);
    const index = SETTINGS_JS.indexOf('export function joinCommaList');
    const docblock = SETTINGS_JS.slice(SETTINGS_JS.lastIndexOf('/**', index), index);
    assert.match(docblock, /canteen, roster|contains a comma/i);
  });

  it('J5. the exported surface other tickets depend on is undisturbed', () => {
    assert.equal(settings.SETTINGS_ENDPOINT, '/calendar/api/settings');
    assert.equal(settings.SCHEDULE_ENDPOINT, '/calendar/api/scan/schedule');
    assert.equal(settings.DEFAULT_SCHEDULE_HOUR, 7);
    for (const name of [
      'detectTimezone',
      'buildSchedulePayload',
      'buildSettingsPayload',
      'createSettingsPage',
      'bootstrapSettings',
      'renderProcessingJobs',
      'requiredConfirmation',
      'isConfirmed',
      'disconnectRequestBody',
      'disconnectSummary',
      'initDisconnectControl',
    ]) {
      assert.equal(typeof settings[name], 'function', `${name} lost its export`);
    }
    // The schedule half of the payload is unchanged by this ticket.
    const payload = settings.buildSettingsPayload({
      processingJobs: [job()],
      scheduleEnabled: true,
      scheduleFrequency: ' weekly ',
      scheduleHour: ' 7 ',
      timezone: ' Australia/Sydney ',
    });
    assert.equal(payload.scheduleFrequency, 'weekly');
    assert.equal(payload.scheduleHour, '7');
    assert.equal(payload.timezone, 'Australia/Sydney');
    assert.deepEqual(payload.processingJobs[0].domains, ['ashfield-p.schools.nsw.edu.au']);
  });

  it('J5. nothing this ticket touched reaches the network on its own', async () => {
    const { page, api } = await openPage([job()]);
    page.addJob();
    page.armRemoveJob(0);
    page.cancelRemoveJob(0);
    page.armRemoveJob(1);
    page.confirmRemoveJob(1);
    assert.deepEqual(putBodies(api), [], 'an edit or a removal was sent before Save');
    assert.deepEqual(
      api.calls.map((call) => call.method),
      ['GET'],
      'the page made a call it should not have'
    );
  });
});
