/**
 * UNIT tests for TASK-057 - "Settings UI to add, edit, remove and name multiple
 * processing jobs".
 *
 * Scope of this file: the units, in isolation.
 *
 *   - the pure helpers `validateProcessingJobsClient`, `fieldErrorId`,
 *     `FIELD_ERROR_IDS`, `toEditableJobs`, `emptyProcessingJob`,
 *     `buildJobsPayload` and `buildSettingsPayload`;
 *   - the exported renderer `renderProcessingJobs(doc, container, jobs, handlers)`
 *     driven DIRECTLY against a minimal hand-built container - including the two
 *     degenerate inputs (no container, a `processingJobs` that is not an array)
 *     the guards in the code exist for;
 *   - `createSettingsPage`'s list behaviour (add / arm / confirm / cancel, and
 *     the client-side rejection path of `save`) driven through an INJECTED api
 *     client. The per-term add/remove controls TASK-057 shipped were REMOVED by
 *     TASK-060: `domains` and `searchTerms` are one comma-separated input each,
 *     so this file's assertions track that shape (see
 *     `tests/unit/task-060-comma-separated-job-fields.test.js` for the parser);
 *   - the shipped `settings.html` and `styles.css` read as TEXT, because there
 *     is no CSS engine and no layout anywhere in this repo (see the docblocks in
 *     `tests/helpers/fake-dom.mjs` and `tests/helpers/css-text.mjs`).
 *
 * NO DATABASE IS TOUCHED and NO NETWORK CALL IS MADE. Every page here is built
 * with an injected `api` whose methods are local async functions; the one page
 * that takes a `fetchImpl` gets one that THROWS, so a test that accidentally
 * reached the network would fail loudly rather than quietly pass.
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/task-057-processing-jobs-flow.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'frontend');

const app = await import('../../src/lambda/calendar/frontend/app.js');
const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { parseHtml, findElements, textOf, walk } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const APP_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'app.js'), 'utf-8');
const SETTINGS_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.js'), 'utf-8');
const SETTINGS_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf-8');
const STYLES_CSS = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf-8');

const XSS = '<img src=x onerror=alert(1)>';

/** A complete, valid job, so a scenario only has to state the bit it is about. */
const job = (overrides = {}) => ({
  id: 'job-1',
  name: 'Ashfield',
  schoolName: 'Ashfield Public School',
  // TASK-059 renamed the singular `domain` to a `domains` LIST; TASK-060 renders
  // that list into one comma-separated input.
  domains: ['ashfield.nsw.edu.au'],
  searchTerms: [],
  ...overrides,
});

/**
 * The smallest document `renderProcessingJobs` can be driven against.
 *
 * Hand-written HERE on purpose (the e2e file parses the shipped page instead):
 * these tests are about the renderer's behaviour given a container, and `omit`
 * lets a scenario take a required node away to exercise a guard. Every id used
 * below is separately pinned against the shipped `settings.html` by the markup
 * scenarios at the foot of this file, so a rename cannot hide here.
 */
function makeJobsHost({ omit = [] } = {}) {
  const parts = [
    '<div id="processing-jobs" class="jobs"></div>',
    '<p id="processing-jobs-empty" class="field-hint" hidden></p>',
  ].filter((part) => !omit.some((id) => part.includes(`id="${id}"`)));
  const doc = parseHtml(`<html><body><form id="settings-form">${parts.join('')}</form></body></html>`);
  return { doc, container: doc.getElementById('processing-jobs') };
}

/**
 * A minimal settings form, for the controller scenarios.
 *
 * Same reasoning as above: hand-built so a guard can be exercised by leaving a
 * node out, and every id is pinned against the shipped page below.
 */
function makeSettingsDoc() {
  const html = `<html><body data-page="settings">
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
        <!-- A <select> since TASK-061, seeded with the same static UTC option
             the shipped page carries; settings.js refills it on every load. -->
        <select id="timezone-input" class="field-input"><option value="UTC">UTC</option></select>
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
  </body></html>`;
  return parseHtml(html);
}

/**
 * An injected api client. NOTHING here touches the network - every method is a
 * local async function that records its call and answers from a script.
 */
function makeApi({ settingsBody = {}, putResult, scheduleResult } = {}) {
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
      if (url === settings.SCHEDULE_ENDPOINT) return scheduleResult ?? ok({ available: true });
      return putResult ?? ok(settingsBody);
    },
    del: async (url) => {
      calls.push({ method: 'DELETE', url });
      return scheduleResult ?? ok({ available: true });
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
    // A fetch that THROWS: the injected api is the only route out, so a
    // regression that fell back to the network fails loudly here.
    fetchImpl: () => {
      throw new Error('a unit test reached for the network');
    },
  });
  await page.start();
  return { doc, page, api, settingsBody };
}

const rowsIn = (doc) => doc.getElementById('processing-jobs').querySelectorAll('.job');
const valueOf = (doc, id) => doc.getElementById(id)?.value;
const settingsPutBodies = (api) =>
  api.calls.filter((call) => call.method === 'PUT' && call.url === settings.SETTINGS_ENDPOINT).map((call) => call.body);

/* =========================================================================
 * validateProcessingJobsClient - the pre-flight, and only the pre-flight
 * ========================================================================= */

describe('TASK-057 unit: validateProcessingJobsClient', () => {
  it('returns null when there is nothing to say', () => {
    assert.equal(settings.validateProcessingJobsClient([job(), job({ id: 'job-2', name: 'Beta' })]), null);
    assert.equal(settings.validateProcessingJobsClient([]), null);
  });

  for (const [field, message] of [
    ['name', /name is required/i],
    ['schoolName', /school name is required/i],
  ]) {
    it(`reports a missing "${field}" as processingJobs[0].${field}`, () => {
      for (const blank of ['', '   ', undefined, null, 42]) {
        const problem = settings.validateProcessingJobsClient([job({ [field]: blank })]);
        assert.notEqual(problem, null, `${field} = ${String(blank)} was accepted`);
        assert.equal(problem.field, `processingJobs[0].${field}`);
        assert.match(problem.error, message);
      }
    });
  }

  it('no longer requires a domain of any kind (TASK-059 made domains optional)', () => {
    // TASK-057 shipped a "domain is required" pre-flight. TASK-059 made the
    // field optional server-side and TASK-060 removed the client check, so an
    // absent, empty or malformed `domains` is as unremarkable as an empty
    // `searchTerms` - the coverage moves rather than disappearing.
    for (const empty of [[], undefined, null, '', 'ashfield.nsw.edu.au', 42, {}]) {
      assert.equal(
        settings.validateProcessingJobsClient([job({ domains: empty })]),
        null,
        `domains = ${JSON.stringify(empty)} was refused locally`
      );
    }
  });

  it('shapes the problem exactly like the server 400 body, so no adapter is needed', () => {
    const problem = settings.validateProcessingJobsClient([job({ name: '' })]);
    assert.deepEqual(Object.keys(problem).sort(), ['error', 'field']);
    assert.equal(typeof problem.error, 'string');
    // And the field it names resolves to a slot the renderer builds.
    assert.equal(settings.fieldErrorId(problem.field), 'error-job-0-name');
  });

  it('reports a duplicate name against the LATER of the two jobs', () => {
    const problem = settings.validateProcessingJobsClient([
      job({ name: 'Ashfield' }),
      job({ id: 'job-2', name: 'Ashfield' }),
    ]);
    assert.equal(problem.field, 'processingJobs[1].name');
    assert.match(problem.error, /Ashfield/);
    assert.match(problem.error, /same processing job name|different name/i);
  });

  it('compares duplicate names TRIMMED and CASE-INSENSITIVELY, per TASK-055', () => {
    const problem = settings.validateProcessingJobsClient([
      job({ name: 'Ashfield' }),
      job({ id: 'job-2', name: '  ashfield  ' }),
    ]);
    assert.equal(problem.field, 'processingJobs[1].name');
    // Not the exact-match dedup the removed parseSchoolNameList used.
    assert.equal(
      settings.validateProcessingJobsClient([job({ name: 'Ashfield' }), job({ id: 'job-2', name: 'Ashfield North' })]),
      null
    );
  });

  it('runs the required checks BEFORE the uniqueness check', () => {
    const problem = settings.validateProcessingJobsClient([job({ name: '  ' }), job({ id: 'job-2', name: '' })]);
    assert.equal(problem.field, 'processingJobs[0].name');
    assert.match(problem.error, /required/i);
    assert.equal(/duplicate|same/i.test(problem.error), false, 'two blank names were reported as duplicates');
  });

  it('walks jobs in list order, so the reported problem is the topmost one on screen', () => {
    const problem = settings.validateProcessingJobsClient([
      job({ name: '' }),
      job({ id: 'job-2', name: 'Beta', domains: [] }),
    ]);
    assert.equal(problem.field, 'processingJobs[0].name');
  });

  it('checks name -> schoolName within a job, and stops there', () => {
    const problem = settings.validateProcessingJobsClient([job({ schoolName: '', domains: [] })]);
    assert.equal(problem.field, 'processingJobs[0].schoolName');
  });

  it('does NOT second-guess the rules the server owns', () => {
    // Domain shape, a public mail provider, string lengths, the job cap and the
    // search-term cap are ALL server-owned. A page that refused any of them
    // could refuse a value TASK-055 would have accepted.
    assert.equal(settings.validateProcessingJobsClient([job({ domains: ['gmail.com'] })]), null);
    assert.equal(settings.validateProcessingJobsClient([job({ domains: ['not a domain at all'] })]), null);
    assert.equal(
      settings.validateProcessingJobsClient([job({ domains: Array.from({ length: 30 }, (_, i) => `d${i}.edu.au`) })]),
      null
    );
    assert.equal(settings.validateProcessingJobsClient([job({ name: 'A'.repeat(500) })]), null);
    assert.equal(
      settings.validateProcessingJobsClient(
        Array.from({ length: 21 }, (_, index) => job({ id: `job-${index}`, name: `Job ${index}` }))
      ),
      null
    );
    assert.equal(
      settings.validateProcessingJobsClient([job({ searchTerms: Array.from({ length: 60 }, (_, i) => `t${i}`) })]),
      null
    );
  });

  it('tolerates a non-array input and a non-object entry without throwing', () => {
    assert.equal(settings.validateProcessingJobsClient(null), null);
    assert.equal(settings.validateProcessingJobsClient(undefined), null);
    assert.equal(settings.validateProcessingJobsClient('Ashfield'), null);
    assert.equal(settings.validateProcessingJobsClient({ 0: job() }), null);

    for (const entry of [null, undefined, 7, 'Ashfield', []]) {
      const problem = settings.validateProcessingJobsClient([entry]);
      assert.equal(problem.field, 'processingJobs[0].name', `entry ${String(entry)} threw or was accepted`);
    }
  });
});

/* =========================================================================
 * fieldErrorId / FIELD_ERROR_IDS - an allowlist that fails closed
 * ========================================================================= */

describe('TASK-057 unit: fieldErrorId resolves the indexed form and nothing else', () => {
  it('adds processingJobs, drops the superseded keys, keeps every schedule key', () => {
    assert.equal(settings.FIELD_ERROR_IDS.processingJobs, 'error-processingJobs');
    for (const dead of ['schoolName', 'schoolNames', 'searchDomains']) {
      assert.equal(Object.prototype.hasOwnProperty.call(settings.FIELD_ERROR_IDS, dead), false, dead);
    }
    for (const [field, id] of [
      ['scheduleEnabled', 'error-scheduleEnabled'],
      ['scheduleFrequency', 'error-scheduleFrequency'],
      ['scheduleHour', 'error-scheduleHour'],
      ['timezone', 'error-timezone'],
      ['frequency', 'error-scheduleFrequency'],
      ['hour', 'error-scheduleHour'],
      ['dayOfWeek', 'error-dayOfWeek'],
      ['enabled', 'error-scheduleEnabled'],
    ]) {
      assert.equal(settings.FIELD_ERROR_IDS[field], id, field);
    }
    assert.ok(Object.isFrozen(settings.FIELD_ERROR_IDS), 'the allowlist must not be mutable');
  });

  it('resolves processingJobs[<digits>].<allowlisted key> to the row slot', () => {
    for (const key of ['name', 'schoolName', 'domains', 'searchTerms']) {
      assert.equal(settings.fieldErrorId(`processingJobs[0].${key}`), `error-job-0-${key}`);
      assert.equal(settings.fieldErrorId(`processingJobs[12].${key}`), `error-job-12-${key}`);
    }
    // TASK-059/TASK-060: the singular `domain` is gone and is deliberately NOT
    // kept as an alias, so it fails closed to the form line.
    assert.deepEqual([...settings.JOB_ERROR_FIELDS], ['name', 'schoolName', 'domains', 'searchTerms']);
    assert.equal(settings.fieldErrorId('processingJobs[0].domain'), settings.FORM_ERROR_ID);
  });

  it('FAILS CLOSED for a malformed index, an unlisted sub-field, or anything else', () => {
    for (const hostile of [
      'processingJobs[0].nickname',
      'processingJobs[abc].name',
      'processingJobs[-1].name',
      'processingJobs[].name',
      'processingJobs[0].',
      'processingJobs[0]',
      'processingJobs[0].name ',
      ' processingJobs[0].name',
      'xprocessingJobs[0].name',
      'processingJobs[0].name.evil',
      'processingJobs[0].__proto__',
      'processingJobs[1e3].name',
      'schoolNames',
      'searchDomains',
      '42',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      42,
      null,
      undefined,
      {},
      ['processingJobs[0].name'],
    ]) {
      assert.equal(settings.fieldErrorId(hostile), settings.FORM_ERROR_ID, String(hostile));
    }
  });

  it('every id in the static table exists in the shipped settings.html', () => {
    const doc = parseHtml(SETTINGS_HTML);
    for (const field of Object.keys(settings.FIELD_ERROR_IDS)) {
      const id = settings.fieldErrorId(field);
      assert.notEqual(doc.getElementById(id), null, `${field} -> ${id} does not exist in settings.html`);
    }
    assert.notEqual(doc.getElementById(settings.FORM_ERROR_ID), null);
  });
});

/* =========================================================================
 * The payload builders
 * ========================================================================= */

describe('TASK-057 unit: buildJobsPayload and buildSettingsPayload', () => {
  it('round-trips an existing server id and OMITS the key for a new row', () => {
    const out = settings.buildJobsPayload([
      job(),
      { id: '', key: 'row-7', name: 'Beta', schoolName: 'Beta School', domains: ['beta.edu.au'], searchTerms: [] },
    ]);
    assert.equal(out[0].id, 'job-1');
    assert.equal('id' in out[1], false, 'a client temp id reached the payload');
    assert.equal('key' in out[1], false, 'the client-side row key reached the payload');
  });

  it('trims both strings and every list entry, and drops blank entries', () => {
    const out = settings.buildJobsPayload([
      {
        name: ' A ',
        schoolName: ' B ',
        domains: ['  c.edu.au  ', '', '   ', null],
        searchTerms: ['  newsletter  ', '', '   ', null],
      },
    ]);
    assert.deepEqual(out, [
      { name: 'A', schoolName: 'B', domains: ['c.edu.au'], searchTerms: ['newsletter'] },
    ]);
    // And no singular `domain` key survives anywhere in the payload.
    assert.equal('domain' in out[0], false, 'the superseded singular domain key was still sent');
  });

  it('saves an empty term list as [] and never as [""]', () => {
    assert.deepEqual(settings.buildJobsPayload([job({ searchTerms: [''] })])[0].searchTerms, []);
    assert.deepEqual(settings.buildJobsPayload([job({ searchTerms: 'nope' })])[0].searchTerms, []);
  });

  it('ALWAYS sends processingJobs, including as [], and never the superseded keys', () => {
    const cleared = settings.buildSettingsPayload({ processingJobs: [], scheduleEnabled: false });
    assert.deepEqual(cleared.processingJobs, []);
    assert.ok('processingJobs' in cleared);
    assert.equal('schoolNames' in cleared, false);
    assert.equal('searchDomains' in cleared, false);

    // Even with nothing supplied at all - an absent key would read to the
    // server as "leave what is stored alone".
    assert.deepEqual(settings.buildSettingsPayload({}).processingJobs, []);
  });

  it('leaves the schedule branches exactly as they were', () => {
    const blank = settings.buildSettingsPayload({
      processingJobs: [],
      scheduleEnabled: false,
      scheduleFrequency: '',
      scheduleHour: '',
      timezone: '',
    });
    assert.deepEqual(Object.keys(blank).sort(), ['processingJobs', 'scheduleEnabled']);

    const full = settings.buildSettingsPayload({
      processingJobs: [],
      scheduleEnabled: true,
      scheduleFrequency: ' weekly ',
      scheduleHour: ' 7 ',
      timezone: ' Australia/Sydney ',
    });
    assert.equal(full.scheduleEnabled, true);
    assert.equal(full.scheduleFrequency, 'weekly');
    assert.equal(full.scheduleHour, '7');
    assert.equal(full.timezone, 'Australia/Sydney');
  });

  it('keeps the module surface other pages and tickets depend on', () => {
    assert.equal(settings.SETTINGS_ENDPOINT, '/calendar/api/settings');
    assert.equal(settings.SCHEDULE_ENDPOINT, '/calendar/api/scan/schedule');
    assert.equal(settings.DEFAULT_SCHEDULE_HOUR, 7);
    assert.equal(settings.FORM_ERROR_ID, 'error-form');
    for (const name of [
      'detectTimezone',
      'buildSchedulePayload',
      'createSettingsPage',
      'bootstrapSettings',
      'requiredConfirmation',
      'isConfirmed',
      'disconnectRequestBody',
      'disconnectSummary',
      'initDisconnectControl',
    ]) {
      assert.equal(typeof settings[name], 'function', `${name} lost its export`);
    }
    assert.equal(settings.CONFIRM_PHRASE_KEEP, 'DISCONNECT');
    assert.equal(settings.CONFIRM_PHRASE_DELETE, 'DELETE MY EVENTS');
    assert.equal(settings.requiredConfirmation(true), 'DELETE MY EVENTS');
    assert.equal(settings.isConfirmed(' DISCONNECT ', false), true);
    assert.equal(settings.isConfirmed('disconnect', false), false);
  });
});

/* =========================================================================
 * renderProcessingJobs - the only nodes this file builds
 * ========================================================================= */

describe('TASK-057 unit: renderProcessingJobs', () => {
  it('renders one .job per entry, in the array order, never re-sorted', () => {
    const { doc, container } = makeJobsHost();
    const count = settings.renderProcessingJobs(doc, container, [
      job({ id: 'job-1', name: 'Zeta' }),
      job({ id: 'job-2', name: 'Alpha' }),
    ]);
    assert.equal(count, 2);
    const rows = rowsIn(doc);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute('data-job-index'), '0');
    assert.equal(rows[1].getAttribute('data-job-index'), '1');
    assert.equal(valueOf(doc, 'job-0-name'), 'Zeta');
    assert.equal(valueOf(doc, 'job-1-name'), 'Alpha');
    assert.equal(container.childNodes.indexOf(rows[0]) < container.childNodes.indexOf(rows[1]), true);
  });

  it('builds the four fields with their labels and their own error slots', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['canteen', 'uniform shop'] })]);

    // TASK-060: all four are the SAME `jobField` builder, so the two list-valued
    // ones are indistinguishable from the two scalar ones apart from their value.
    for (const [key, label, value] of [
      ['name', 'Name', 'Ashfield'],
      ['schoolName', 'School name', 'Ashfield Public School'],
      ['domains', 'Email domains (comma separated)', 'ashfield.nsw.edu.au'],
      ['searchTerms', 'Search terms (comma separated)', 'canteen, uniform shop'],
    ]) {
      const input = doc.getElementById(`job-0-${key}`);
      assert.notEqual(input, null, `job-0-${key} is missing`);
      assert.equal(input.tagName, 'INPUT');
      assert.equal(input.getAttribute('type'), 'text');
      assert.equal(input.className, 'field-input');
      assert.equal(input.value, value);
      assert.equal(input.parentNode.className, 'field', 'the input is not in the .field wrapper');

      const labelNode = doc.getElementById('processing-jobs').querySelector(`label[for="job-0-${key}"]`);
      assert.notEqual(labelNode, null, `no <label for="job-0-${key}">`);
      assert.equal(labelNode.className, 'field-label');
      assert.equal(textOf(labelNode), label);

      const slot = doc.getElementById(`error-job-0-${key}`);
      assert.notEqual(slot, null, `error-job-0-${key} is missing`);
      assert.equal(slot.tagName, 'P');
      assert.equal(slot.className, 'field-error');
      assert.equal(slot.getAttribute('role'), 'alert');
      assert.equal(slot.hidden, true);
    }

    // The id the removed `termsBlock` used to build by hand still exists, so a
    // server 400 on processingJobs[0].searchTerms still lands somewhere.
    assert.notEqual(doc.getElementById('error-job-0-searchTerms'), null, 'the terms error slot is missing');
    const head = doc.getElementById('job-0-head');
    assert.equal(head.className, 'job__head');
    assert.equal(textOf(head), 'Ashfield');
  });

  it('names each row in its accessible labels, so twenty rows do not read the same', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ name: 'Ashfield' }), job({ id: 'job-2', name: 'St Marys' })]);
    const first = doc.getElementById('job-0-name').getAttribute('aria-label');
    const second = doc.getElementById('job-1-name').getAttribute('aria-label');
    assert.match(first, /Ashfield/);
    assert.match(second, /St Marys/);
    assert.notEqual(first, second, 'two rows announce an identical "Name" field');

    // And an unnamed row still gets a distinct label, from its position.
    const blank = makeJobsHost();
    settings.renderProcessingJobs(blank.doc, blank.container, [job({ name: '' }), job({ id: 'job-2', name: '' })]);
    assert.notEqual(
      blank.doc.getElementById('job-0-name').getAttribute('aria-label'),
      blank.doc.getElementById('job-1-name').getAttribute('aria-label')
    );
    assert.equal(textOf(blank.doc.getElementById('job-0-head')), 'New processing job 1');
  });

  it('renders a hostile stored value as literal text, creating no element from it', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [
      { id: 'job-1', name: XSS, schoolName: 'S', domains: ['d.edu.au'], searchTerms: ['<script>alert(1)</script>'] },
    ]);

    assert.equal(valueOf(doc, 'job-0-name'), XSS);
    assert.equal(doc.getElementById('job-0-head').textContent, XSS);
    // The comma-joined string is still character data in an input `value`.
    assert.equal(valueOf(doc, 'job-0-searchTerms'), '<script>alert(1)</script>');
    // Stronger than asserting escaped text: the element simply does not exist.
    assert.deepEqual(findElements(doc, 'img'), [], 'an IMG was created from a job name');
    assert.deepEqual(findElements(doc, 'script'), [], 'a SCRIPT was created from a search term');
  });

  it('carries a server id as data-job-id, and marks a row added this session', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ id: 'srv-9' }), { ...settings.emptyProcessingJob(), key: 'row-1' }]);
    const rows = rowsIn(doc);
    assert.equal(rows[0].getAttribute('data-job-id'), 'srv-9');
    assert.equal(rows[0].getAttribute('data-job-new'), null);
    assert.equal(rows[1].getAttribute('data-job-id'), null, 'a client temp id was written as a server id');
    assert.equal(rows[1].getAttribute('data-job-new'), 'true');
    // Neither is ever rendered as visible text.
    assert.equal(/srv-9|row-1/.test(textOf(doc.getElementById('processing-jobs'))), false);
  });

  it('renders no rows and shows the empty hint for absent, non-array or empty jobs', () => {
    for (const value of [undefined, null, 'Ashfield', 42, {}, []]) {
      const { doc, container } = makeJobsHost();
      assert.equal(settings.renderProcessingJobs(doc, container, value), 0, String(value));
      assert.equal(rowsIn(doc).length, 0, String(value));
      assert.equal(doc.getElementById('processing-jobs-empty').hidden, false, String(value));
    }
  });

  it('hides the empty hint as soon as there is a row, and shows it again when the last goes', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job()]);
    assert.equal(doc.getElementById('processing-jobs-empty').hidden, true);
    settings.renderProcessingJobs(doc, container, []);
    assert.equal(doc.getElementById('processing-jobs-empty').hidden, false);
  });

  it('empties the container between renders, so a stale row cannot linger', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ name: 'A' }), job({ id: 'job-2', name: 'B' })]);
    settings.renderProcessingJobs(doc, container, [job({ id: 'job-2', name: 'B' })]);
    assert.equal(rowsIn(doc).length, 1);
    assert.equal(valueOf(doc, 'job-0-name'), 'B');
    assert.equal(doc.getElementById('job-1-name'), null, 'a removed row survived the re-render');
  });

  it('does not throw when the container is missing, and still drives the hint', () => {
    const { doc } = makeJobsHost();
    assert.equal(settings.renderProcessingJobs(doc, null, [job()]), 0);
    assert.equal(doc.getElementById('processing-jobs-empty').hidden, true);

    const stripped = makeJobsHost({ omit: ['processing-jobs-empty'] });
    assert.equal(settings.renderProcessingJobs(stripped.doc, stripped.container, [job()]), 1);
  });

  it('renders the search terms as ONE comma-joined input, not as a row per term', () => {
    // TASK-060 replaced TASK-057's per-term row editor outright. The coverage
    // below is the same ground - several stored terms reaching the page - read
    // against the shape that replaced it.
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['newsletter', 'canteen'] })]);

    const input = doc.getElementById('job-0-searchTerms');
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.getAttribute('type'), 'text');
    assert.equal(input.className, 'field-input');
    assert.equal(input.getAttribute('data-job-index'), '0');
    assert.equal(input.getAttribute('autocomplete'), 'off');
    assert.equal(input.value, 'newsletter, canteen');
    assert.equal(
      doc.getElementById('processing-jobs').querySelectorAll('#job-0-searchTerms').length,
      1,
      'more than one search-terms input was rendered for one job'
    );

    // Every structure the removed editor built is gone.
    assert.equal(doc.getElementById('job-0-terms'), null, 'the <ul> term list survived');
    assert.equal(doc.getElementById('job-0-terms-label'), null);
    assert.equal(doc.getElementById('job-0-term-0'), null);
    assert.equal(doc.getElementById('add-term-0'), null, 'the Add search term button survived');
    assert.equal(doc.getElementById('remove-job-0-term-0'), null);
    assert.equal(doc.getElementById('processing-jobs').querySelectorAll('.job__term').length, 0);
    assert.equal(doc.getElementById('processing-jobs').querySelectorAll('.job__terms').length, 0);
    const built = new Set();
    walk(doc.getElementById('processing-jobs'), (node) => built.add(node.tagName), false);
    assert.equal(built.has('UL'), false, 'a <ul> term list was built');
    assert.equal(built.has('LI'), false, 'an <li> term row was built');
    assert.deepEqual(
      doc.getElementById('processing-jobs').querySelectorAll('[data-term-index]'),
      [],
      'a node still carries data-term-index'
    );
  });

  it('renders an EMPTY search-terms input for searchTerms: [], and no add button', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: [] })]);
    assert.equal(valueOf(doc, 'job-0-searchTerms'), '');
    assert.equal(doc.getElementById('job-0-terms'), null);
    assert.equal(doc.getElementById('add-term-0'), null);
    assert.equal(doc.getElementById('job-0-term-0'), null);
  });

  it('renders the Remove job button, and no confirmation, when the row is not armed', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [{ ...job(), key: 'row-1' }]);
    const remove = doc.getElementById('remove-job-0');
    assert.equal(textOf(remove), 'Remove job');
    assert.equal(remove.getAttribute('data-job-index'), '0');
    assert.equal(remove.className, 'btn btn-small');
    assert.equal(doc.getElementById('confirm-remove-job-0'), null);
    assert.equal(doc.getElementById('cancel-remove-job-0'), null);
  });

  it('renders the arm-then-confirm block for the ONE row whose key is armed', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(
      doc,
      container,
      [{ ...job({ name: 'Ashfield' }), key: 'row-1' }, { ...job({ id: 'job-2', name: 'St Marys' }), key: 'row-2' }],
      { confirmingKey: 'row-2' }
    );

    assert.equal(doc.getElementById('confirm-remove-job-0'), null, 'a second row was armed');
    assert.equal(doc.getElementById('remove-job-0') !== null, true);

    const confirm = doc.getElementById('job-1-confirm');
    assert.notEqual(confirm, null);
    assert.equal(confirm.className, 'job__confirm');
    assert.match(textOf(confirm), /Remove St Marys\?/);
    // The name reaches the block as textContent - it can never become markup.
    assert.equal(textOf(doc.getElementById('confirm-remove-job-1')), 'Confirm remove');
    assert.equal(textOf(doc.getElementById('cancel-remove-job-1')), 'Cancel');
    // The acting control replaces the arming one, so it cannot be double-tapped.
    assert.equal(doc.getElementById('remove-job-1'), null);
  });

  it('renders a hostile job name in the confirmation as text, not as markup', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [{ ...job({ name: XSS }), key: 'row-1' }], { confirmingKey: 'row-1' });
    assert.equal(textOf(doc.getElementById('job-0-confirm')).includes(XSS), true);
    assert.deepEqual(findElements(doc, 'img'), []);
  });

  it('gives every button it builds type="button" and a 44px class, and every input .field-input', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(
      doc,
      container,
      [{ ...job({ searchTerms: ['newsletter'] }), key: 'row-1' }],
      { confirmingKey: 'row-1' }
    );

    const buttons = findElements(doc.getElementById('processing-jobs'), 'button');
    // Two, since TASK-060 removed the per-term Add/Remove: Confirm remove and
    // Cancel on the armed row.
    assert.ok(buttons.length >= 2, `only ${buttons.length} buttons were built`);
    for (const button of buttons) {
      // type="button" is load-bearing: every one of these sits inside
      // #settings-form, where a default type="submit" would save on every tap.
      assert.equal(button.getAttribute('type'), 'button', textOf(button));
      assert.ok(
        button.className === 'btn' || button.className === 'btn btn-small',
        `${textOf(button)} carries "${button.className}", which has no 44px rule`
      );
    }

    for (const input of findElements(doc.getElementById('processing-jobs'), 'input')) {
      assert.equal(input.className, 'field-input', input.getAttribute('id'));
      const id = input.getAttribute('id');
      assert.notEqual(
        doc.getElementById('processing-jobs').querySelector(`label[for="${id}"]`),
        null,
        `${id} has no <label for>`
      );
    }
  });

  it('builds NO markup sink and no second list-editing idiom', () => {
    const { doc, container } = makeJobsHost();
    settings.renderProcessingJobs(doc, container, [job({ searchTerms: ['x'] })]);
    const built = new Set();
    walk(doc.getElementById('processing-jobs'), (node) => built.add(node.tagName), false);
    // No textarea (the comma/newline box this ticket replaced), no select, no
    // drag handle: one idiom - a button that appends a row, and a per-row Remove.
    assert.equal(built.has('TEXTAREA'), false, 'a textarea list editor reappeared');
    assert.equal(built.has('SELECT'), false);
  });
});

/* =========================================================================
 * The controller: editing, adding, removing, and not losing unsaved work
 * ========================================================================= */

describe('TASK-057 unit: the settings controller drives the list', () => {
  it('fills the rows from the loaded settings and never touches a removed textarea', async () => {
    const { doc } = await openPage([job({ name: 'Ashfield' }), job({ id: 'job-2', name: 'St Marys' })]);
    assert.equal(rowsIn(doc).length, 2);
    assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield');
    assert.equal(valueOf(doc, 'job-1-name'), 'St Marys');
    assert.equal(doc.getElementById('school-names-input'), null);
    assert.equal(doc.getElementById('search-domains-input'), null);
    assert.match(textOf(doc.getElementById('settings-summary')), /^Watching mail for Ashfield, St Marys$/);
  });

  it('appends a BLANK row at the end and asks for focus on its name field', async () => {
    const { doc, page } = await openPage([job()]);
    assert.equal(page.addJob(), 2);
    assert.equal(rowsIn(doc).length, 2);
    assert.equal(valueOf(doc, 'job-1-name'), '');
    assert.equal(valueOf(doc, 'job-1-schoolName'), '');
    assert.equal(valueOf(doc, 'job-1-domains'), '');
    assert.equal(valueOf(doc, 'job-1-searchTerms'), '');
    assert.equal(page.state.focusFieldId, 'job-1-name');
  });

  it('reads the DOM back into state before EVERY re-render, so typing is not lost', async () => {
    const { doc, page } = await openPage([]);
    page.addJob();
    doc.getElementById('job-0-name').value = 'Ashfield';
    doc.getElementById('job-0-domains').value = 'ashfield.nsw.edu.au, ashfieldpandc.org.au';
    doc.getElementById('job-0-searchTerms').value = 'canteen, uniform shop';
    page.addJob();

    assert.equal(rowsIn(doc).length, 2);
    assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield', 'the first row lost what was typed into it');
    assert.equal(valueOf(doc, 'job-0-domains'), 'ashfield.nsw.edu.au, ashfieldpandc.org.au');
    assert.equal(valueOf(doc, 'job-0-searchTerms'), 'canteen, uniform shop');
    assert.equal(valueOf(doc, 'job-1-name'), '');
  });

  it('binds NO listener to a job input, so typing can never trigger a re-render', async () => {
    const { doc } = await openPage([job({ searchTerms: ['x'] })]);
    for (const id of ['job-0-name', 'job-0-schoolName', 'job-0-domains', 'job-0-searchTerms']) {
      assert.equal(doc.getElementById(id).listeners.size, 0, `${id} carries a listener`);
    }
  });

  it('binds each control exactly once, however many times the list is rebuilt', async () => {
    const { doc, page } = await openPage([job()]);
    for (let round = 0; round < 10; round += 1) {
      page.addJob();
      page.armRemoveJob(1);
      page.confirmRemoveJob(1);
    }
    assert.equal(rowsIn(doc).length, 1);
    // The static add button is bound once at start; the per-row controls are
    // discarded and rebuilt with the nodes they belong to.
    assert.equal(doc.getElementById('add-processing-job').listeners.get('click').length, 1);
    assert.equal(doc.getElementById('remove-job-0').listeners.get('click').length, 1);
  });

  it('no longer exposes addTerm or removeTerm on the controller (TASK-060)', async () => {
    const { page } = await openPage([job({ searchTerms: ['a'] })]);
    assert.equal(page.addTerm, undefined, 'addTerm is still on the controller');
    assert.equal(page.removeTerm, undefined, 'removeTerm is still on the controller');
    assert.equal(SETTINGS_JS.includes('onAddTerm'), false, 'the onAddTerm handler survived');
    assert.equal(SETTINGS_JS.includes('onRemoveTerm'), false, 'the onRemoveTerm handler survived');
    assert.equal(SETTINGS_JS.includes('data-term-index'), false, 'the term-index wiring survived');
  });

  it('edits terms on ONE job through its own input, leaving the others untouched', async () => {
    // The replacement for the add-term/remove-term coverage above: the same
    // "one job's terms change, its neighbour's do not" property, now expressed
    // through the single comma-separated field.
    const { doc, page, api } = await openPage([
      job({ searchTerms: ['a'] }),
      job({ id: 'job-2', name: 'B', searchTerms: ['b'] }),
    ]);
    assert.equal(valueOf(doc, 'job-0-searchTerms'), 'a');
    assert.equal(valueOf(doc, 'job-1-searchTerms'), 'b');

    doc.getElementById('job-1-searchTerms').value = 'b, canteen';
    // A structural action re-reads the DOM, so the edit survives it.
    page.addJob();
    assert.equal(valueOf(doc, 'job-1-searchTerms'), 'b, canteen');
    assert.equal(valueOf(doc, 'job-0-searchTerms'), 'a', 'the other job changed');

    // And it is the split LIST that would be sent, not the text.
    assert.deepEqual(page.readJobsFromDom()[1].searchTerms, ['b', 'canteen']);
    assert.deepEqual(page.readJobsFromDom()[0].searchTerms, ['a']);
    assert.equal(settingsPutBodies(api).length, 0, 'an edit reached the network');
  });

  it('arms a removal without removing anything, and cancels back to normal', async () => {
    const { doc, page } = await openPage([job({ name: 'Ashfield' }), job({ id: 'job-2', name: 'St Marys' })]);
    page.armRemoveJob(0);
    assert.equal(rowsIn(doc).length, 2, 'arming removed a row');
    assert.notEqual(doc.getElementById('confirm-remove-job-0'), null);
    assert.match(textOf(doc.getElementById('job-0-confirm')), /Ashfield/);

    page.cancelRemoveJob(0);
    assert.equal(rowsIn(doc).length, 2);
    assert.equal(doc.getElementById('confirm-remove-job-0'), null);
    assert.equal(page.state.confirmingKey, null);
  });

  it('keeps AT MOST ONE row armed, and clears it on any other structural change', async () => {
    const { doc, page } = await openPage([
      job({ name: 'A' }),
      job({ id: 'job-2', name: 'B' }),
      job({ id: 'job-3', name: 'C' }),
    ]);
    page.armRemoveJob(0);
    page.armRemoveJob(2);
    assert.equal(doc.getElementById('confirm-remove-job-0'), null, 'two rows were armed at once');
    assert.notEqual(doc.getElementById('confirm-remove-job-2'), null);

    // The things the ticket names as invalidating a pending confirmation:
    // arming another row (above), adding a job, cancelling, and a successful
    // save. Each mirrors `onChoiceChange` in the disconnect control. (The
    // "removing a term" case went with TASK-060's per-term editor.)
    page.armRemoveJob(2);
    page.addJob();
    assert.equal(page.state.confirmingKey, null, 'adding a job left a stale confirmation');

    page.armRemoveJob(0);
    page.cancelRemoveJob(0);
    assert.equal(page.state.confirmingKey, null, 'cancelling left a stale confirmation');

    // Fill the row the add() above appended, so the save is not refused by the
    // pre-flight before it can get as far as re-rendering.
    doc.getElementById('job-3-name').value = 'D';
    doc.getElementById('job-3-schoolName').value = 'D School';
    doc.getElementById('job-3-domains').value = 'd.edu.au';
    page.armRemoveJob(0);
    assert.equal((await page.save()).ok, true);
    assert.equal(page.state.confirmingKey, null, 'a successful save left a stale confirmation');
    assert.equal(doc.getElementById('confirm-remove-job-0'), null);
  });

  it('RE-CHECKS the armed row at action time rather than trusting the button', async () => {
    const { doc, page } = await openPage([job({ name: 'A' }), job({ id: 'job-2', name: 'B' })]);
    page.armRemoveJob(0);
    // Confirming a DIFFERENT row must remove nothing - the gate is the armed
    // key, not the presence of a control.
    assert.equal(page.confirmRemoveJob(1), false);
    assert.equal(rowsIn(doc).length, 2);
    assert.equal(page.state.confirmingKey, null, 'a mismatched confirm left the arm standing');

    // And confirming with nothing armed at all is also a no-op.
    assert.equal(page.confirmRemoveJob(0), false);
    assert.equal(rowsIn(doc).length, 2);
  });

  it('splices exactly the armed row out, sends nothing, and allows removing the last one', async () => {
    const { doc, page, api } = await openPage([job({ name: 'A' }), job({ id: 'job-2', name: 'B' })]);
    page.armRemoveJob(0);
    assert.equal(page.confirmRemoveJob(0), true);
    assert.equal(rowsIn(doc).length, 1);
    assert.equal(valueOf(doc, 'job-0-name'), 'B');
    assert.deepEqual(api.calls.filter((call) => call.method !== 'GET'), [], 'a removal reached the network');

    page.armRemoveJob(0);
    assert.equal(page.confirmRemoveJob(0), true);
    assert.equal(rowsIn(doc).length, 0);
    assert.equal(doc.getElementById('processing-jobs-empty').hidden, false);
    // The client invents no "you must keep at least one job" rule.
    assert.equal(doc.getElementById('error-processingJobs').hidden, true);
  });

  it('persists a removal only on Save, and sends [] when the list was cleared', async () => {
    const { page, api } = await openPage([job()]);
    page.armRemoveJob(0);
    page.confirmRemoveJob(0);
    assert.equal(settingsPutBodies(api).length, 0, 'the removal was sent before Save');

    await page.save();
    assert.deepEqual(settingsPutBodies(api)[0].processingJobs, []);
  });
});

/* =========================================================================
 * Save: the client-side rejection path, and the error slots
 * ========================================================================= */

describe('TASK-057 unit: save() pre-flights before the round trip', () => {
  it('makes NO request, shows the field error, sets the status and re-enables the button', async () => {
    const { doc, page, api } = await openPage([job({ name: 'Dup' }), job({ id: 'job-2', name: '  dup  ' })]);
    const result = await page.save();

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.field, 'processingJobs[1].name');
    assert.equal(settingsPutBodies(api).length, 0, 'a client-rejected save still went to the server');
    assert.equal(
      api.calls.some((call) => call.url === settings.SCHEDULE_ENDPOINT),
      false,
      'a rejected save went on to write the schedule'
    );

    assert.equal(doc.getElementById('error-job-1-name').hidden, false);
    assert.match(textOf(doc.getElementById('error-job-1-name')), /Dup/);
    assert.equal(doc.getElementById('error-job-0-name').hidden, true, 'the error landed on the wrong row too');
    assert.equal(textOf(doc.getElementById('settings-status')), 'Nothing was saved - please fix the highlighted field.');

    // The `finally` still runs on this path: one bad save must not lock the form.
    assert.equal(page.state.saving, false);
    assert.equal(doc.getElementById('save-settings').disabled, false);

    // And the page is usable again straight away.
    doc.getElementById('job-1-name').value = 'Other';
    const second = await page.save();
    assert.equal(second.ok, true);
    assert.equal(settingsPutBodies(api).length, 1);
  });

  it('clears EVERY per-row slot before the next save, not just the static table', async () => {
    const { doc, page } = await openPage([job({ name: '' })]);
    await page.save();
    assert.equal(doc.getElementById('error-job-0-name').hidden, false);

    doc.getElementById('job-0-name').value = 'Ashfield';
    await page.save();
    assert.equal(doc.getElementById('error-job-0-name').hidden, true, 'a stale row error survived the next save');
    assert.equal(textOf(doc.getElementById('error-job-0-name')), '');
    assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
  });

  it('clears a per-row slot even when the next save never gets as far as a re-render', async () => {
    // A successful save re-renders the rows, which would blank the slots on its
    // own; a save refused by the pre-flight does NOT. So this is the path where
    // only `clearErrors` sweeping the dynamic slots can take a stale row error
    // away - and where a stale one would point at the wrong row after a removal.
    const { doc, page } = await openPage([job()], {
      putResult: {
        ok: false,
        status: 400,
        data: { error: 'That domain is not accepted.', field: 'processingJobs[0].domains' },
      },
    });
    await page.save();
    assert.equal(doc.getElementById('error-job-0-domains').hidden, false);

    doc.getElementById('job-0-name').value = '   ';
    await page.save();

    assert.equal(
      doc.getElementById('error-job-0-domains').hidden,
      true,
      'a stale row error survived a client-side rejection'
    );
    assert.equal(textOf(doc.getElementById('error-job-0-domains')), '');
    assert.equal(doc.getElementById('error-job-0-name').hidden, false);
  });

  it('routes a server 400 to the named row, and falls back to the form line when it cannot', async () => {
    const { doc, page } = await openPage([job()]);

    assert.deepEqual(page.showFieldError('processingJobs[0].domains', 'That domain is not accepted.'), {
      id: 'error-job-0-domains',
      shown: true,
      text: 'That domain is not accepted.',
    });
    assert.equal(doc.getElementById('error-form').hidden, true);
    assert.equal(doc.getElementById('error-processingJobs').hidden, true);

    page.clearErrors();
    // A row the user removed after the request went out: the id is well formed
    // but no element carries it, so the message still has somewhere to land.
    const orphan = page.showFieldError('processingJobs[9].name', 'Name is required');
    assert.equal(orphan.id, settings.FORM_ERROR_ID);
    assert.equal(doc.getElementById('error-form').hidden, false);
    assert.equal(textOf(doc.getElementById('error-form')), 'Name is required');

    page.clearErrors();
    page.showFieldError('processingJobs', 'At most 20 processing jobs.');
    assert.equal(doc.getElementById('error-processingJobs').hidden, false);
    assert.equal(doc.getElementById('error-form').hidden, true);
  });

  it('replaces state.settings with the response, so a server id lands on the new row', async () => {
    const saved = {
      connectionStatus: 'connected',
      processingJobs: [job({ id: 'srv-9', name: 'Ashfield' })],
      scheduleEnabled: false,
    };
    const { doc, page, api } = await openPage([], { putResult: { ok: true, status: 200, data: saved } });
    page.addJob();
    doc.getElementById('job-0-name').value = 'Ashfield';
    doc.getElementById('job-0-schoolName').value = 'Ashfield Public School';
    doc.getElementById('job-0-domains').value = 'ashfield.nsw.edu.au';

    assert.equal((await page.save()).ok, true);
    assert.equal('id' in settingsPutBodies(api)[0].processingJobs[0], false, 'a new row sent an id');
    assert.equal(rowsIn(doc)[0].getAttribute('data-job-id'), 'srv-9');

    doc.getElementById('job-0-name').value = 'Ashfield PS';
    await page.save();
    assert.equal(settingsPutBodies(api)[1].processingJobs[0].id, 'srv-9', 'a rename orphaned the job id');
    assert.equal(settingsPutBodies(api)[1].processingJobs[0].name, 'Ashfield PS');
  });

  it('refuses a second save while one is in flight', async () => {
    const { page, api } = await openPage([job()]);
    const [first, second] = await Promise.all([page.save(), page.save()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match(second.error, /already in flight/i);
    assert.equal(settingsPutBodies(api).length, 1);
  });
});

/* =========================================================================
 * The shipped markup
 * ========================================================================= */

describe('TASK-057 unit: settings.html ships the processing-jobs section', () => {
  const doc = parseHtml(SETTINGS_HTML);

  it('has removed both textareas, both hints and both error slots', () => {
    for (const dead of [
      'school-names-input',
      'search-domains-input',
      'error-schoolNames',
      'error-searchDomains',
      'school-name-input',
      'error-schoolName',
    ]) {
      assert.equal(doc.getElementById(dead), null, `${dead} survived`);
      assert.equal(SETTINGS_HTML.includes(`id="${dead}"`), false, `${dead} survived in the raw markup`);
    }
    assert.deepEqual(findElements(doc, 'textarea'), [], 'a textarea survived the list editor');
  });

  it('has a heading naming the new concept, still inside #settings-form', () => {
    const form = doc.getElementById('settings-form');
    const headings = findElements(form, 'h2').map((node) => textOf(node));
    assert.ok(
      headings.some((text) => /processing job/i.test(text)),
      `no processing-jobs heading, found: ${headings.join(' | ')}`
    );
    assert.equal(headings.includes('Your school'), false, 'the superseded heading survived');
    assert.ok(headings.includes('Automatic scanning'), 'the schedule heading was disturbed');
  });

  it('has the static container, empty hint, list-level error slot and add button', () => {
    const container = doc.getElementById('processing-jobs');
    assert.notEqual(container, null);
    assert.equal(container.className, 'jobs');
    assert.equal(container.children.length, 0, 'the container must ship empty - settings.js fills it');
    assert.notEqual(doc.querySelector('#settings-form #processing-jobs'), null);

    const empty = doc.getElementById('processing-jobs-empty');
    assert.equal(empty.className, 'field-hint');
    assert.equal(empty.hidden, true, 'the empty hint must ship hidden - settings.js drives it');
    assert.match(textOf(empty), /no processing job/i);
    assert.match(textOf(empty), /scanned/i, 'the hint does not say mail will not be scanned');
    assert.match(textOf(empty), /Save/i, 'the hint does not say a removal is not stored until Save');

    const slot = doc.getElementById('error-processingJobs');
    assert.equal(slot.className, 'field-error');
    assert.equal(slot.getAttribute('role'), 'alert');
    assert.equal(slot.hidden, true);

    const add = doc.getElementById('add-processing-job');
    assert.equal(textOf(add), 'Add processing job');
    assert.equal(add.getAttribute('type'), 'button', 'a default type="submit" would save on every add');
    assert.equal(add.className, 'btn');
    assert.notEqual(doc.querySelector('#settings-form #add-processing-job'), null);
  });

  it('explains, in words, what a processing job is', () => {
    const hints = findElements(doc.getElementById('settings-form'), 'p')
      .filter((node) => node.className === 'field-hint')
      .map((node) => textOf(node));
    assert.ok(
      hints.some((text) => /domain/i.test(text) && /search/i.test(text) && /school/i.test(text)),
      `no explanatory hint found, saw: ${hints.join(' | ')}`
    );
  });

  it('leaves the schedule half, the form error line, the status line and Save alone', () => {
    for (const id of [
      'schedule-enabled-input',
      'schedule-frequency-input',
      'schedule-day-input',
      'schedule-hour-input',
      'timezone-input',
      'error-scheduleEnabled',
      'error-scheduleFrequency',
      'error-dayOfWeek',
      'error-scheduleHour',
      'error-timezone',
      'error-form',
      'settings-status',
      'save-settings',
      'settings-summary',
      'settings-body',
      'connection-state',
    ]) {
      assert.notEqual(doc.getElementById(id), null, `${id} went missing`);
    }
    assert.equal(doc.getElementById('save-settings').getAttribute('type'), 'submit');
    // TASK-061 turned the free-text zone box into a selector; the id, the label
    // and the error slot above are deliberately unchanged.
    assert.equal(doc.getElementById('timezone-input').tagName, 'SELECT');
    assert.equal(doc.body.getAttribute('data-page'), 'settings', 'the bootstrap contract changed');
  });

  it('leaves the disconnect section byte-unchanged, including its position-sensitive slice', () => {
    // tests/unit/calendar-disconnect.test.js slices the raw HTML on this span.
    assert.match(SETTINGS_HTML, /id="disconnect-submit" disabled>/);
    assert.equal(doc.getElementById('disconnect-submit').disabled, true);
    assert.equal(doc.getElementById('disconnect-events-keep').checked, true);
    assert.equal(doc.getElementById('disconnect-events-delete').checked, false);
    assert.notEqual(doc.querySelector('#settings-body #disconnect-gmail'), null);
  });
});

/* =========================================================================
 * The shipped stylesheet, read as TEXT
 * ========================================================================= */

describe('TASK-057 unit: styles.css keeps the job editor usable on a phone', () => {
  const outside = css.outsideMediaQueries(STYLES_CSS);
  const media = css.mediaBlocks(STYLES_CSS);

  it('adds a rule for every surviving class, outside any media query', () => {
    for (const selector of ['.jobs', '.job', '.job__head', '.job__actions', '.job__confirm']) {
      assert.equal(css.rulesFor(outside, selector).length >= 1, true, `no rule for ${selector}`);
    }
  });

  it('has DROPPED the term-row rules with the term-row editor (TASK-060)', () => {
    // The search-terms field needs no CSS of its own: it carries .field and
    // .field-input like every other field on the page.
    for (const dead of ['.job__terms', '.job__term']) {
      assert.deepEqual(css.rulesFor(outside, dead), [], `${dead} survived its only consumer`);
    }
    assert.equal(/\.job__term\b/.test(STYLES_CSS), false, '.job__term survived in the raw stylesheet');
    assert.equal(/\.job__terms\b/.test(STYLES_CSS), false, '.job__terms survived in the raw stylesheet');
    assert.ok(css.rulesFor(outside, '.field-input').length >= 1, '.field-input carries the shared input rule');
  });

  it('lays .jobs and .job out as a single-column grid', () => {
    assert.equal(css.declaredValue(outside, '.job', 'display'), 'grid');
    assert.equal(css.declaredValue(outside, '.jobs', 'display'), 'grid');
    // A single implicit column: nothing declares a multi-column track list.
    for (const selector of ['.jobs', '.job']) {
      assert.equal(css.declaredValue(outside, selector, 'grid-template-columns'), null, selector);
    }
  });

  it('gives .job the same card language as .settings__section', () => {
    const section = css.declarationsOf(css.rulesFor(outside, '.settings__section')[0].body);
    const card = css.declarationsOf(css.rulesFor(outside, '.job')[0].body);
    assert.equal(card.background, section.background);
    assert.equal(card.border, section.border);
    assert.equal(card['border-radius'], section['border-radius']);
    assert.ok(card.padding, '.job declares no padding, so it does not read as a card');
  });

  it('sets overflow-x NOWHERE on the jobs list or anything inside it', () => {
    for (const rule of css.eachRule(css.stripComments(STYLES_CSS).replace(/@media[^{]*\{/g, ''))) {
      const declarations = css.declarationsOf(rule.body);
      if (!rule.selectors.some((selector) => /\.jobs?\b|\.job__/.test(selector))) continue;
      assert.equal(declarations['overflow-x'], undefined, `${rule.selectors.join(', ')} sets overflow-x`);
      assert.equal(declarations.overflow, undefined, `${rule.selectors.join(', ')} sets overflow`);
    }
  });

  it('keeps the 44px touch target on .btn and .btn-small OUTSIDE any media query', () => {
    assert.equal(css.declaredValue(outside, '.btn', 'min-height'), '44px');
    assert.equal(css.declaredValue(outside, '.btn-small', 'min-height'), '44px');
    // And no new rule for a job control shrinks one inside a breakpoint.
    for (const block of media) {
      for (const rule of css.eachRule(block.body)) {
        if (!rule.selectors.some((selector) => /\.jobs?\b|\.job__|\.btn/.test(selector))) continue;
        const declarations = css.declarationsOf(rule.body);
        assert.equal(declarations['min-height'], undefined, `${rule.selectors.join(', ')} sets min-height in @media`);
        assert.equal(declarations.height, undefined, `${rule.selectors.join(', ')} sets height in @media`);
      }
    }
  });

  it('keeps text inputs at the 16px body size that stops iOS zooming on focus', () => {
    assert.equal(css.declaredValue(outside, '.field-input', 'font'), 'inherit');
    for (const source of [outside, ...media.map((block) => block.body)]) {
      assert.equal(css.declaredValue(source, '.field-input', 'font-size'), null, '.field-input font-size was reduced');
    }
  });

  it('only buys back padding at the 600px breakpoint, and adds no third one', () => {
    assert.deepEqual(
      media.map((block) => block.prelude),
      ['(max-width: 860px)', '(max-width: 600px)'],
      'a breakpoint was added, removed or reordered'
    );

    const narrow = media.find((block) => block.prelude === '(max-width: 600px)');
    for (const rule of css.eachRule(narrow.body)) {
      if (!rule.selectors.some((selector) => /\.jobs?\b|\.job__/.test(selector))) continue;
      for (const property of Object.keys(css.declarationsOf(rule.body))) {
        assert.ok(
          /^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(property),
          `${rule.selectors.join(', ')} sets "${property}" at 600px - this block may only reduce padding/gaps`
        );
      }
    }

    const wide = media.find((block) => block.prelude === '(max-width: 860px)');
    assert.equal(/\.job/.test(wide.body), false, 'the 860px block was modified');
  });

  it('leaves .app-main--narrow alone and stays self-contained', () => {
    assert.equal(css.declaredValue(outside, '.app-main--narrow', 'grid-template-columns'), 'minmax(0, 640px)');
    assert.equal(/\[hidden\]/.test(outside), true, 'the [hidden] rule that makes `hidden` work went missing');
    assert.match(css.rulesFor(outside, '[hidden]')[0].body, /display:\s*none\s*!important/);
    assert.equal(/@import/.test(STYLES_CSS), false);
    assert.equal(/https?:\/\//.test(STYLES_CSS), false, 'a remote URL would be blocked by default-src \'self\'');
  });
});

/* =========================================================================
 * Source discipline, and the fenced app.js change
 * ========================================================================= */

describe('TASK-057 unit: source discipline', () => {
  it('reaches the DOM through no markup sink, in either frontend module', () => {
    for (const [name, source] of [['app.js', APP_JS], ['settings.js', SETTINGS_JS]]) {
      // Property ACCESS, not the word: settings.js names innerHTML in a comment
      // explaining why it does not use it, and that comment must stay legal.
      assert.deepEqual(source.match(/\.innerHTML/g) || [], [], `${name} reaches for innerHTML`);
      assert.deepEqual(source.match(/\.outerHTML/g) || [], [], `${name} reaches for outerHTML`);
      assert.deepEqual(source.match(/\.insertAdjacentHTML\(/g) || [], [], `${name} reaches for insertAdjacentHTML`);
      assert.deepEqual(source.match(/document\.write/g) || [], [], `${name} reaches for document.write`);
    }
    assert.ok(/createElement|\bel\(/.test(SETTINGS_JS), 'settings.js builds no nodes, so the scan above is vacuous');
  });

  it('amends the docblock rule that said validation is only ever the server\'s job', () => {
    const docblock = SETTINGS_JS.slice(0, SETTINGS_JS.indexOf('*/'));
    assert.match(docblock, /SOURCE OF TRUTH FOR VALIDATION/i);
    assert.match(docblock, /validateProcessingJobsClient/, 'the docblock does not name the one pre-flight');
    assert.match(docblock, /REQUIRED/i);
    assert.match(docblock, /DUPLICATE/i);
    assert.match(docblock, /NEVER\s+STRICTER|not.*stricter|no rule here is ever\s*\n?\s*\*?\s*stricter/i);
  });

  it('leaves no superseded helper exported-but-dead', () => {
    for (const dead of ['parseSchoolNameList', 'formatSchoolNameList', 'parseDomainList', 'formatDomainList']) {
      assert.equal(settings[dead], undefined, `${dead} is still exported`);
      assert.equal(SETTINGS_JS.includes(`function ${dead}`), false, `${dead} is still defined`);
    }
    assert.equal(app.schoolNameList, undefined, 'schoolNameList is still exported');
    assert.equal(SETTINGS_JS.includes('schoolNameList'), false, 'settings.js still imports schoolNameList');
  });
});

describe('TASK-057 unit: the fenced app.js change', () => {
  const named = (name) => ({ id: 'job-1', name, schoolName: 'S', domains: ['d.edu.au'], searchTerms: [] });

  /** The smallest host `renderConnectionCards` can be driven against. */
  function host() {
    const doc = parseHtml('<html><body><section id="connection-state"></section></body></html>');
    return { doc, container: doc.getElementById('connection-state') };
  }

  it('normalises the /auth/me shape without throwing on the first-run one', () => {
    assert.deepEqual(app.processingJobEntries(null), []);
    assert.deepEqual(app.processingJobEntries(undefined), []);
    assert.deepEqual(app.processingJobEntries('Ashfield'), []);
    assert.deepEqual(app.processingJobEntries([named('Alpha'), named('  '), 7, null, ['x']]).map((j) => j.name), [
      'Alpha',
    ]);
  });

  it('drives needsSchool off processingJobs, keeping the three flags independent', () => {
    const base = { connectionStatus: 'connected', email: 'p@example.test' };
    assert.equal(app.connectionView({ ...base }).needsSchool, true);
    assert.equal(app.connectionView({ ...base, processingJobs: [] }).needsSchool, true);
    assert.equal(app.connectionView({ ...base, processingJobs: [named('Alpha')] }).needsSchool, false);
    assert.deepEqual(
      app.connectionView({ connectionStatus: 'not_connected', processingJobs: [], lastScanStatus: 'reauth_required' }),
      { signedIn: true, needsConnect: true, needsSchool: true, needsReauth: true }
    );
    assert.deepEqual(app.connectionView(null), {
      signedIn: false,
      needsConnect: true,
      needsSchool: false,
      needsReauth: false,
    });
  });

  it('renders the job names, joined, as ONE textContent assignment on #identity-school-name', () => {
    const { doc, container } = host();
    app.renderConnectionCards(doc, container, {
      connectionStatus: 'connected',
      email: 'p@example.test',
      processingJobs: [named('Ashfield'), named(XSS)],
    });
    const node = doc.getElementById('identity-school-name');
    assert.equal(node.textContent, `Watching mail for Ashfield, ${XSS}`);
    assert.equal(node.childNodes.length, 1, 'the list was assembled out of several nodes');
    assert.equal(node.childNodes[0].nodeType, 3, 'the list is not a single text node');
    assert.deepEqual(findElements(doc, 'img'), []);
    assert.equal(doc.getElementById('school-setup'), null, 'a configured account was still asked for a school');
  });

  it('keeps TASK-058\'s stricter helper separate rather than merging the two', () => {
    // The general helper this ticket added tolerates a job with no id; the
    // filter dropdown's does not, because its <option value> IS the id.
    assert.equal(typeof app.processingJobList, 'function');
    assert.equal(app.processingJobEntries([{ name: 'Alpha' }]).length, 1);
    assert.equal(app.processingJobList([{ name: 'Alpha' }]).length, 0);
  });

  it('does not disturb the attention-list surface TASK-054 and TASK-058 own', () => {
    assert.equal(app.MAX_ATTENTION_ITEMS, 5);
    assert.equal(typeof app.filterEventsByJob, 'function');
    for (const name of ['renderDayCell', 'renderChip', 'renderAttention']) {
      assert.ok(APP_JS.includes(name), `${name} disappeared from app.js`);
    }
  });
});
