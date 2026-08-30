/**
 * UNIT tests for TASK-058 - "filter the calendar and attention list by
 * processing job".
 *
 * Scope of this file: the units, in isolation.
 *
 *   - the two new exported PURE helpers, `processingJobList` and
 *     `filterEventsByJob`, including every tolerance the ticket spells out
 *     (`null` rather than `[]`, malformed entries, an event with no
 *     `processingJobId`);
 *   - the four exported empty-state copy constants, checked against the text
 *     `frontend/index.html` actually ships, so the constant and the markup
 *     cannot drift;
 *   - `renderJobFilter`, `setJobFilter`, `renderMonth` and `renderAttention`
 *     driven DIRECTLY off `controller.state` against a minimal hand-built
 *     panel - including the degenerate documents (no `<select>`, no row) the
 *     guards in the code exist for;
 *   - source-shape claims that no behavioural test can make: that
 *     `renderJobFilter` is called from `applyIdentity` and nowhere else, that
 *     the `change` listener is bound once in `bindControls`, that nothing is
 *     persisted, and that no backend file grew a `processingJobName`;
 *   - `styles.css` read as text with `tests/helpers/css-text.mjs`, because
 *     there is no CSS engine and no layout anywhere in this repo.
 *
 * NO DATABASE IS TOUCHED, and none is mocked, because nothing on these paths
 * reaches one. NO NETWORK CALL IS MADE EITHER: the injected `fetchImpl` throws,
 * and the one scenario that needs an `/auth/me` body injects a stub `api`
 * client (`createCalendarApp` takes `options.api`) rather than a transport.
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/task-058-job-filter-flow.test.js`.
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

const app = await import('../../src/lambda/calendar/frontend/app.js');
const { parseHtml, findElements, textOf } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const APP_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'app.js'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf-8');
const STYLES_CSS = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf-8');
const EVENTS_MJS = fs.readFileSync(path.join(CALENDAR_DIR, 'backend', 'events.mjs'), 'utf-8');

const XSS = '<img src=x onerror=alert(1)>';

/** Noon-ish on 15 September 2026 UTC+10 - September 2026 in every real zone. */
const NOW = Date.parse('2026-09-15T02:00:00.000Z');

/** Whitespace-collapsed text, for comparing a constant with shipped markup. */
const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();

/**
 * The smallest document the filter, the grid and the attention panel can all be
 * driven against.
 *
 * Hand-written HERE on purpose (unlike the e2e file, which parses the shipped
 * page): these tests are about the functions' behaviour given a page, and
 * `omit` lets a scenario take a required node away to exercise a guard.
 */
function makePage({ omit = [] } = {}) {
  const parts = [
    '<section id="connection-state"></section>',
    '<div id="app-body" hidden>',
    '<p id="school-name"></p>',
    '<h2 id="month-heading"></h2>',
    '<div id="job-filter-row" class="calendar-filter" hidden>',
    '<label class="calendar-filter__label" for="job-filter">Show events from</label>',
    '<select id="job-filter" class="calendar-filter__select"></select>',
    '</div>',
    '<div id="calendar-weekdays"></div>',
    '<div id="calendar-grid"></div>',
    '<p id="calendar-empty" hidden>No events this month. Nothing to keep track of just yet.</p>',
    '<p id="calendar-truncated" hidden></p>',
    '<p id="attention-message" hidden></p>',
    '<ul id="attention-list"></ul>',
    '<button id="attention-more" type="button" hidden aria-expanded="false"></button>',
    '<p id="attention-empty" hidden>Nothing needs attention. You are all caught up.</p>',
    '</div>',
    '<section id="event-detail" hidden></section>',
  ].filter((part) => !omit.some((id) => part.includes(`id="${id}"`)));
  return parseHtml(`<html><body><main>${parts.join('')}</main></body></html>`);
}

/**
 * A controller with nothing running: no timers, no `start()`, and a `fetchImpl`
 * that THROWS, so a test that accidentally reached the network fails loudly
 * rather than passing quietly.
 */
function makeController(doc, options = {}) {
  return app.createCalendarApp({
    document: doc,
    fetchImpl: async () => {
      throw new Error('a unit test reached the network');
    },
    now: () => NOW,
    locale: 'en-AU',
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    ...options,
  });
}

/**
 * A stub API client. `createCalendarApp` takes `options.api`, so `loadIdentity`
 * - the only way into `applyIdentity` and therefore into `renderJobFilter` -
 * can be driven with ZERO transport of any kind.
 */
function stubApi(meBody, log = []) {
  return {
    get: async (url) => {
      log.push({ method: 'GET', url });
      return { ok: true, status: 200, data: meBody };
    },
    post: async (url) => {
      log.push({ method: 'POST', url });
      return { ok: true, status: 200, data: { ok: true } };
    },
    put: async (url) => {
      log.push({ method: 'PUT', url });
      return { ok: true, status: 200, data: { ok: true } };
    },
  };
}

/** `count` month events on consecutive days, all attributed to `jobId`. */
const monthEvents = (prefix, jobId, count, firstDay = 1) =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    startsAt: `2026-09-${String(firstDay + index).padStart(2, '0')}`,
    allDay: true,
    processingJobId: jobId,
  }));

/** `count` pending attention rows for `jobId`, already soonest-first. */
const attentionRows = (prefix, jobId, count, firstDay = 16) =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    startsAt: '2026-09-28',
    allDay: true,
    needsAttention: true,
    status: 'pending',
    processingJobId: jobId,
    dueBy: `2026-09-${String(firstDay + index).padStart(2, '0')}T00:00:00.000Z`,
  }));

const optionsIn = (doc) => doc.getElementById('job-filter').querySelectorAll('option');
const chipsIn = (doc) => doc.getElementById('calendar-grid').querySelectorAll('.chip');
const rowsIn = (doc) => doc.getElementById('attention-list').querySelectorAll('.attention-item');

/**
 * The body of one function in a source file, found by matching braces.
 *
 * Brace matching rather than "slice to the next `\n  }\n`": this repo is checked
 * out with CRLF endings, so an indentation heuristic finds nothing, slices to
 * the end of the file, and turns "renderMonth must not rebuild the options" into
 * "app.js must not mention renderJobFilter" - a different, and false, claim.
 *
 * @param {string} source
 * @param {string} signature Exact text the declaration starts with.
 * @returns {string} The text between the outermost braces.
 */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was renamed or reshaped`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${signature} is never closed`);
}

/* =========================================================================
 * processingJobList - the client-side join's only source of a job NAME
 * ========================================================================= */

describe('TASK-058 unit: processingJobList', () => {
  it('is exported as a function', () => {
    assert.equal(typeof app.processingJobList, 'function');
  });

  it('reads { id, name } pairs, in the order the API returned them', () => {
    const jobs = app.processingJobList([
      { id: 'job-a', name: 'Junior School', schoolName: 'Junior', domain: 'j.test' },
      { id: 'job-b', name: 'Senior School' },
    ]);
    assert.deepEqual(jobs, [
      { id: 'job-a', name: 'Junior School' },
      { id: 'job-b', name: 'Senior School' },
    ]);
  });

  it('projects only id and name, dropping every other field of the settings shape', () => {
    const [job] = app.processingJobList([
      { id: 'job-a', name: 'Junior', schoolName: 'x', domain: 'y', searchTerms: ['z'] },
    ]);
    assert.deepEqual(Object.keys(job).sort(), ['id', 'name']);
  });

  it('trims both fields', () => {
    assert.deepEqual(app.processingJobList([{ id: '  job-a  ', name: '  Junior School  ' }]), [
      { id: 'job-a', name: 'Junior School' },
    ]);
  });

  /* --- edge / failure paths ------------------------------------------ */

  it('returns [] for null - which is what an unset attribute projects as, not []', () => {
    assert.deepEqual(app.processingJobList(null), []);
  });

  it('returns [] for every other non-array, rather than throwing', () => {
    for (const value of [undefined, '', 'job-a', 0, 7, true, false, {}, { id: 'a' }, Number.NaN]) {
      assert.deepEqual(app.processingJobList(value), [], `processingJobList(${JSON.stringify(value) ?? String(value)})`);
    }
  });

  it('returns [] for an empty array', () => {
    assert.deepEqual(app.processingJobList([]), []);
  });

  it('drops entries that are not objects', () => {
    assert.deepEqual(
      app.processingJobList([null, undefined, 'job-a', 42, true, ['job-a', 'Junior'], { id: 'job-a', name: 'Junior' }]),
      [{ id: 'job-a', name: 'Junior' }]
    );
  });

  it('drops an entry whose id or name is missing, blank, or blank after trimming', () => {
    assert.deepEqual(
      app.processingJobList([
        { id: 'job-a', name: 'Junior' },
        { name: 'No id at all' },
        { id: 'job-c' },
        { id: '', name: 'Blank id' },
        { id: 'job-d', name: '' },
        { id: '   ', name: 'Whitespace id' },
        { id: 'job-e', name: '   ' },
        { id: 7, name: 'Numeric id' },
        { id: 'job-f', name: 7 },
        {},
      ]),
      [{ id: 'job-a', name: 'Junior' }],
      'a malformed entry was rendered as a blank option nobody could identify'
    );
  });

  it('is total: no input of any shape makes it throw', () => {
    // The tolerance pattern `schoolNameList` established, stated as a property
    // rather than by comparison - TASK-055 is retiring that helper, and this
    // requirement outlives it.
    const HOSTILE = [
      null, undefined, '', 0, Number.NaN, true, {}, [], [null], [[]], [{ id: {} }], [{ name: [] }],
      [Object.create(null)], [{ get id() { return 'job-a'; }, name: 'Junior' }],
    ];
    HOSTILE.forEach((value, index) => {
      assert.doesNotThrow(() => app.processingJobList(value), `HOSTILE[${index}] made processingJobList throw`);
      assert.equal(Array.isArray(app.processingJobList(value)), true, `HOSTILE[${index}] produced a non-array`);
    });
  });

  it('does not mutate or alias its input', () => {
    const input = [{ id: 'job-a', name: 'Junior' }];
    const jobs = app.processingJobList(input);
    assert.notStrictEqual(jobs, input);
    assert.notStrictEqual(jobs[0], input[0]);
    jobs[0].name = 'Changed';
    assert.equal(input[0].name, 'Junior');
  });

  it('keeps a hostile name as the literal string it is - escaping happens on render', () => {
    assert.deepEqual(app.processingJobList([{ id: 'job-a', name: XSS }]), [{ id: 'job-a', name: XSS }]);
  });
});

/* =========================================================================
 * filterEventsByJob - the filter itself
 * ========================================================================= */

describe('TASK-058 unit: filterEventsByJob', () => {
  const EVENTS = [
    { eventId: 'a1', processingJobId: 'job-a' },
    { eventId: 'b1', processingJobId: 'job-b' },
    { eventId: 'a2', processingJobId: 'job-a' },
    { eventId: 'n1', processingJobId: null },
    { eventId: 'n2' },
  ];
  const ids = (list) => list.map((event) => event.eventId);

  it('is exported as a function', () => {
    assert.equal(typeof app.filterEventsByJob, 'function');
  });

  it('returns the whole list for null, undefined and "" - all three mean "all jobs"', () => {
    for (const jobId of [null, undefined, '']) {
      assert.deepEqual(ids(app.filterEventsByJob(EVENTS, jobId)), ['a1', 'b1', 'a2', 'n1', 'n2'], String(jobId));
    }
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS)), ['a1', 'b1', 'a2', 'n1', 'n2'], 'omitted argument');
  });

  it('returns only the selected job\'s events, in the original order', () => {
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, 'job-a')), ['a1', 'a2']);
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, 'job-b')), ['b1']);
  });

  it('matches on the id and NEVER on the name, so a rename keeps its events', () => {
    const renamed = [{ eventId: 'a1', processingJobId: 'job-a', title: 'Junior School' }];
    assert.deepEqual(ids(app.filterEventsByJob(renamed, 'job-a')), ['a1']);
    assert.deepEqual(app.filterEventsByJob(renamed, 'Junior School'), [], 'the filter matched on a name');
  });

  it('never mutates its input and returns a list of the SAME objects', () => {
    const input = EVENTS.slice();
    const filtered = app.filterEventsByJob(input, 'job-a');
    assert.equal(input.length, 5, 'the backing array was filtered in place');
    assert.strictEqual(filtered[0], input[0], 'the events were cloned rather than referenced');
  });

  /* --- edge / failure paths ------------------------------------------ */

  it('hides an event with no attribution under a job, and shows it under all jobs', () => {
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, null)).includes('n1'), true);
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, null)).includes('n2'), true);
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, 'job-a')).includes('n1'), false);
    assert.deepEqual(ids(app.filterEventsByJob(EVENTS, 'job-a')).includes('n2'), false);
  });

  it('invents no "unattributed" bucket - no job id ever selects the unattributed rows', () => {
    for (const jobId of ['null', 'undefined', 'unattributed', ' ']) {
      assert.deepEqual(app.filterEventsByJob(EVENTS, jobId), [], `"${jobId}" selected something`);
    }
  });

  it('returns [] for a non-array events argument, rather than throwing', () => {
    for (const value of [null, undefined, 'a', 7, {}, true]) {
      assert.deepEqual(app.filterEventsByJob(value, 'job-a'), [], String(value));
      assert.deepEqual(app.filterEventsByJob(value, null), [], `${String(value)} with no filter`);
    }
  });

  it('tolerates null and undefined entries inside the list', () => {
    const messy = [null, undefined, { eventId: 'a1', processingJobId: 'job-a' }];
    assert.deepEqual(ids(app.filterEventsByJob(messy, 'job-a')), ['a1']);
  });

  it('is an exact ===, so a job id is never matched by coercion', () => {
    const numeric = [{ eventId: 'x', processingJobId: 1 }];
    assert.deepEqual(app.filterEventsByJob(numeric, '1'), []);
  });
});

/* =========================================================================
 * The empty-state copy constants
 * ========================================================================= */

describe('TASK-058 unit: the four empty-state copy constants', () => {
  it('exports all four, as non-empty strings', () => {
    for (const name of [
      'CALENDAR_EMPTY_MESSAGE',
      'CALENDAR_EMPTY_FILTERED_MESSAGE',
      'ATTENTION_EMPTY_MESSAGE',
      'ATTENTION_EMPTY_FILTERED_MESSAGE',
    ]) {
      assert.equal(typeof app[name], 'string', `${name} is not exported as a string`);
      assert.notEqual(app[name].trim(), '', `${name} is blank`);
    }
  });

  it('uses exactly the wording the ticket specifies', () => {
    assert.equal(app.CALENDAR_EMPTY_MESSAGE, 'No events this month. Nothing to keep track of just yet.');
    assert.equal(app.CALENDAR_EMPTY_FILTERED_MESSAGE, 'No events from that processing job this month.');
    assert.equal(app.ATTENTION_EMPTY_MESSAGE, 'Nothing needs attention. You are all caught up.');
    assert.equal(app.ATTENTION_EMPTY_FILTERED_MESSAGE, 'Nothing from that processing job needs attention.');
  });

  it('keeps the two UNFILTERED constants byte-for-byte in step with index.html', () => {
    const doc = parseHtml(INDEX_HTML);
    assert.equal(
      collapse(doc.getElementById('calendar-empty').textContent),
      collapse(app.CALENDAR_EMPTY_MESSAGE),
      'the shipped #calendar-empty copy drifted away from CALENDAR_EMPTY_MESSAGE'
    );
    assert.equal(
      collapse(doc.getElementById('attention-empty').textContent),
      collapse(app.ATTENTION_EMPTY_MESSAGE),
      'the shipped #attention-empty copy drifted away from ATTENTION_EMPTY_MESSAGE'
    );
  });

  it('and the shipped copy still satisfies the TASK-010 assertions that match on it', () => {
    // tests/e2e/calendar-frontend-flow.test.js matches /No events this month/.
    assert.match(app.CALENDAR_EMPTY_MESSAGE, /No events this month/);
    assert.match(app.ATTENTION_EMPTY_MESSAGE, /caught up/i);
  });

  it('names no job in either filtered message - a raw settings value stays out of a sentence', () => {
    for (const message of [app.CALENDAR_EMPTY_FILTERED_MESSAGE, app.ATTENTION_EMPTY_FILTERED_MESSAGE]) {
      assert.equal(/\$\{|%s|\{\{/.test(message), false, `${message} interpolates something`);
      assert.match(message, /that processing job/, 'the filtered copy does not say the filter is why');
    }
  });
});

/* =========================================================================
 * The new state
 * ========================================================================= */

describe('TASK-058 unit: state gains jobFilter and processingJobs', () => {
  it('initialises jobFilter to null and processingJobs to an empty array', () => {
    const controller = makeController(makePage());
    assert.equal(controller.state.jobFilter, null);
    assert.deepEqual(controller.state.processingJobs, []);
  });

  it('carries them as real own properties of the state literal', () => {
    const controller = makeController(makePage());
    for (const key of ['jobFilter', 'processingJobs']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(controller.state, key),
        true,
        `${key} is not part of the state object`
      );
    }
  });

  it('declares them in the state literal in source, not bolted on later', () => {
    assert.match(APP_JS, /\n\s*processingJobs:\s*\[\],/);
    assert.match(APP_JS, /\n\s*jobFilter:\s*null,/);
  });
});

/* =========================================================================
 * renderJobFilter - options, selection and visibility
 * ========================================================================= */

describe('TASK-058 unit: renderJobFilter', () => {
  /** Load an /auth/me body through the ONLY entry point: loadIdentity. */
  async function withJobs(processingJobs, { doc = makePage(), options = {} } = {}) {
    const log = [];
    const me = { connectionStatus: 'connected', email: 'p@example.test', processingJobs };
    const controller = makeController(doc, { api: stubApi(me, log), ...options });
    await controller.loadIdentity();
    return { doc, controller, log };
  }

  const TWO = [
    { id: 'job-a', name: 'Junior School' },
    { id: 'job-b', name: 'Senior School' },
  ];

  it('puts "All jobs" first, with an empty value, then one option per job in order', async () => {
    const { doc } = await withJobs(TWO);
    const options = optionsIn(doc);
    assert.equal(options.length, 3);
    assert.equal(textOf(options[0]), 'All jobs');
    assert.equal(options[0].getAttribute('value'), '');
    assert.equal(options[0].value, '');
    assert.deepEqual(options.slice(1).map((option) => option.getAttribute('value')), ['job-a', 'job-b']);
    assert.deepEqual(options.slice(1).map((option) => textOf(option)), ['Junior School', 'Senior School']);
  });

  it('uses the job id as the value and the job name as the text - never the other way round', async () => {
    const { doc } = await withJobs(TWO);
    for (const option of optionsIn(doc).slice(1)) {
      assert.equal(/^job-[ab]$/.test(option.getAttribute('value')), true);
      assert.equal(/School$/.test(textOf(option)), true);
    }
  });

  it('reveals the row only at two or more jobs', async () => {
    for (const [label, jobs, hidden] of [
      ['null', null, true],
      ['none', [], true],
      ['one', [{ id: 'job-a', name: 'Default' }], true],
      ['two', TWO, false],
      ['three', [...TWO, { id: 'job-c', name: 'Third' }], false],
    ]) {
      const { doc } = await withJobs(jobs);
      assert.equal(doc.getElementById('job-filter-row').hidden, hidden, `${label} job(s)`);
    }
  });

  it('stores the parsed list on state.processingJobs', async () => {
    const { controller } = await withJobs(TWO);
    assert.deepEqual(controller.state.processingJobs, TWO);

    const empty = await withJobs(null);
    assert.deepEqual(empty.controller.state.processingJobs, []);
  });

  it('re-applies the current selection explicitly after rebuilding the children', async () => {
    const doc = makePage();
    const { controller } = await withJobs(TWO, { doc });
    controller.setJobFilter('job-b');
    assert.equal(controller.state.jobFilter, 'job-b');

    await controller.loadIdentity();

    assert.equal(
      doc.getElementById('job-filter').value,
      'job-b',
      'replacing the option children lost the selection - select.value was not re-applied'
    );
    assert.equal(controller.state.jobFilter, 'job-b');
  });

  it('selects "All jobs" - value "" - when nothing is filtered', async () => {
    const { doc, controller } = await withJobs(TWO);
    assert.equal(controller.state.jobFilter, null);
    assert.equal(doc.getElementById('job-filter').value, '');
  });

  it('builds every option with createElement and textContent, so a hostile name is inert', async () => {
    const { doc } = await withJobs([
      { id: 'job-a', name: XSS },
      { id: 'job-b', name: 'Senior School' },
    ]);
    const option = optionsIn(doc)[1];
    assert.equal(textOf(option), XSS);
    assert.equal(option.childNodes.length, 1, 'the name parsed into more than one node');
    assert.equal(option.childNodes[0].nodeType, 3, 'the option label is not a text node');
    assert.equal(option.children.length, 0);
    assert.deepEqual(findElements(doc, 'img'), [], 'a hostile job name created an element');
  });

  /* --- edge / failure paths ------------------------------------------ */

  it('drops a selection whose job has vanished, and re-renders unfiltered', async () => {
    const doc = makePage();
    const { controller } = await withJobs(TWO, { doc });
    controller.state.events = [...monthEvents('a', 'job-a', 1), ...monthEvents('b', 'job-b', 2, 5)];
    controller.state.attention = attentionRows('b', 'job-b', 2);
    controller.setJobFilter('job-b');
    assert.equal(chipsIn(doc).length, 2);

    // /auth/me comes back with job-b deleted.
    const log = [];
    const reloaded = app.createCalendarApp({
      document: doc,
      fetchImpl: async () => {
        throw new Error('a unit test reached the network');
      },
      now: () => NOW,
      locale: 'en-AU',
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      api: stubApi({ connectionStatus: 'connected', processingJobs: [{ id: 'job-a', name: 'Junior School' }] }, log),
    });
    reloaded.state.events = controller.state.events;
    reloaded.state.attention = controller.state.attention;
    reloaded.state.jobFilter = 'job-b';
    await reloaded.loadIdentity();

    assert.equal(reloaded.state.jobFilter, null, 'a stale selection survived the reload');
    assert.equal(doc.getElementById('job-filter').value, '');
    assert.equal(optionsIn(doc).length, 2, 'the option list did not shrink to All jobs + job-a');
    assert.equal(chipsIn(doc).length, 3, 'the grid was not re-rendered unfiltered after the reset');
    assert.equal(rowsIn(doc).length, 2);
  });

  it('keeps a selection whose job is still listed, even after a rename', async () => {
    const doc = makePage();
    const { controller } = await withJobs(TWO, { doc });
    controller.setJobFilter('job-a');

    const renamed = app.createCalendarApp({
      document: doc,
      fetchImpl: async () => {
        throw new Error('a unit test reached the network');
      },
      now: () => NOW,
      locale: 'en-AU',
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
      api: stubApi({
        connectionStatus: 'connected',
        processingJobs: [
          { id: 'job-a', name: 'Junior School (renamed)' },
          { id: 'job-b', name: 'Senior School' },
        ],
      }),
    });
    renamed.state.jobFilter = 'job-a';
    await renamed.loadIdentity();

    assert.equal(renamed.state.jobFilter, 'job-a', 'a rename dropped the selection');
    assert.equal(doc.getElementById('job-filter').value, 'job-a');
    assert.equal(textOf(optionsIn(doc)[1]), 'Junior School (renamed)');
  });

  it('renders without a #job-filter in the document instead of throwing', async () => {
    const doc = makePage({ omit: ['job-filter'] });
    await assert.doesNotReject(async () => {
      await withJobs(TWO, { doc });
    });
  });

  it('renders without a #job-filter-row in the document instead of throwing', async () => {
    const doc = makePage({ omit: ['job-filter-row'] });
    await assert.doesNotReject(async () => {
      await withJobs(TWO, { doc });
    });
  });

  it('rebuilds rather than appends, so ten reloads leave three options', async () => {
    const doc = makePage();
    const { controller } = await withJobs(TWO, { doc });
    for (let turn = 0; turn < 10; turn += 1) await controller.loadIdentity();
    assert.equal(optionsIn(doc).length, 3, 'options were appended instead of rebuilt');
  });
});

/* =========================================================================
 * setJobFilter
 * ========================================================================= */

describe('TASK-058 unit: setJobFilter', () => {
  const build = () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.events = [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)];
    controller.state.attention = [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)];
    controller.renderMonth();
    controller.renderAttention();
    return { doc, controller };
  };

  it('is exposed on the controller, alongside toggleAttentionExpanded', () => {
    const controller = makeController(makePage());
    assert.equal(typeof controller.setJobFilter, 'function');
    assert.equal(typeof controller.toggleAttentionExpanded, 'function');
  });

  it('sets state.jobFilter and re-renders both panels', () => {
    const { doc, controller } = build();
    assert.equal(chipsIn(doc).length, 5);
    assert.equal(rowsIn(doc).length, 7);

    controller.setJobFilter('job-a');

    assert.equal(controller.state.jobFilter, 'job-a');
    assert.equal(chipsIn(doc).length, 2);
    assert.equal(rowsIn(doc).length, 3);
  });

  it('maps "" back to null - the same thing the "All jobs" option carries', () => {
    const { controller } = build();
    controller.setJobFilter('job-a');
    assert.equal(controller.setJobFilter(''), null);
    assert.equal(controller.state.jobFilter, null);
  });

  it('treats null, undefined and a whitespace string as "all jobs" too', () => {
    for (const value of [null, undefined, '   ', '\t']) {
      const { controller } = build();
      controller.setJobFilter('job-a');
      controller.setJobFilter(value);
      assert.equal(controller.state.jobFilter, null, `setJobFilter(${JSON.stringify(value) ?? String(value)})`);
    }
  });

  it('returns the new filter value', () => {
    const { controller } = build();
    assert.equal(controller.setJobFilter('job-b'), 'job-b');
    assert.equal(controller.setJobFilter(''), null);
  });

  it('never filters state.events or state.attention in place', () => {
    const { controller } = build();
    controller.setJobFilter('job-a');
    assert.equal(controller.state.events.length, 5, 'state.events was filtered in place');
    assert.equal(controller.state.attention.length, 7, 'state.attention was filtered in place');
    controller.setJobFilter('job-b');
    assert.equal(controller.state.events.length, 5);
    assert.equal(controller.state.attention.length, 7);
  });

  it('makes no request at all - the injected api is never called', async () => {
    const doc = makePage();
    const log = [];
    const controller = makeController(doc, { api: stubApi({ connectionStatus: 'connected' }, log) });
    controller.state.events = monthEvents('a', 'job-a', 2);
    controller.setJobFilter('job-a');
    controller.setJobFilter('');
    controller.setJobFilter('job-b');
    assert.deepEqual(log, [], 'changing the filter made a request');
  });

  it('does not close an open detail panel', () => {
    const { doc, controller } = build();
    controller.openEvent({ eventId: 'b-0', title: 'Senior thing', processingJobId: 'job-b' });
    assert.equal(doc.getElementById('event-detail').hidden, false);

    controller.setJobFilter('job-a');

    const panel = doc.getElementById('event-detail');
    assert.equal(panel.hidden, false, 'filtering closed a panel the user deliberately opened');
    assert.equal(panel.getAttribute('data-event-id'), 'b-0');
    assert.equal(controller.state.selectedEventId, 'b-0');
  });

  it('leaves #calendar-truncated alone - truncation is a fact about the fetch', () => {
    const { doc, controller } = build();
    controller.state.truncated = true;
    controller.renderMonth();
    const before = textOf(doc.getElementById('calendar-truncated'));
    assert.equal(doc.getElementById('calendar-truncated').hidden, false);

    controller.setJobFilter('job-a');

    assert.equal(doc.getElementById('calendar-truncated').hidden, false, 'the filter cleared the truncated notice');
    assert.equal(textOf(doc.getElementById('calendar-truncated')), before);
  });
});

/* =========================================================================
 * Overflow counts follow the filter
 * ========================================================================= */

describe('TASK-058 unit: overflow counts reflect the filtered set', () => {
  const sameDay = (prefix, jobId, count) =>
    Array.from({ length: count }, (unused, index) => ({
      eventId: `${prefix}-${index}`,
      title: `${prefix} ${index}`,
      startsAt: '2026-09-12',
      allDay: true,
      processingJobId: jobId,
    }));

  const cellFor = (doc, key) => doc.getElementById('calendar-grid').querySelector(`[data-date="${key}"]`);

  it('counts a day cell\'s "+N more" over the FILTERED events only', () => {
    const doc = makePage();
    const controller = makeController(doc, { maxChipsPerDay: 3 });
    controller.state.events = [...sameDay('a', 'job-a', 4), ...sameDay('b', 'job-b', 3)];
    controller.renderMonth();
    assert.equal(textOf(cellFor(doc, '2026-09-12').querySelector('.more-toggle')), '+4 more');

    controller.setJobFilter('job-a');

    assert.equal(
      textOf(cellFor(doc, '2026-09-12').querySelector('.more-toggle')),
      '+1 more',
      'the overflow count still included events the filter had hidden'
    );
  });

  it('reveals only the selected job\'s events when the overflow is opened', async () => {
    const doc = makePage();
    const controller = makeController(doc, { maxChipsPerDay: 3 });
    controller.state.events = [...sameDay('a', 'job-a', 4), ...sameDay('b', 'job-b', 3)];
    controller.setJobFilter('job-a');

    const cell = cellFor(doc, '2026-09-12');
    await cell.querySelector('.more-toggle').dispatch('click');

    const ids = cell.querySelectorAll('.chip').map((chip) => chip.getAttribute('data-event-id'));
    assert.deepEqual(ids, ['a-0', 'a-1', 'a-2', 'a-3']);
    assert.equal(cell.querySelectorAll('.chip').some((chip) => chip.hidden === true), false);
  });

  it('drops the "+N more" entirely once the filtered cell fits', () => {
    const doc = makePage();
    const controller = makeController(doc, { maxChipsPerDay: 3 });
    controller.state.events = [...sameDay('a', 'job-a', 4), ...sameDay('b', 'job-b', 2)];
    controller.renderMonth();
    assert.notEqual(cellFor(doc, '2026-09-12').querySelector('.more-toggle'), null);

    controller.setJobFilter('job-b');

    const cell = cellFor(doc, '2026-09-12');
    assert.equal(cell.querySelector('.more-toggle'), null, 'a cell that fits after filtering kept its overflow control');
    assert.equal(cell.querySelectorAll('.chip').length, 2);
    assert.equal(cell.querySelectorAll('.chip').filter((chip) => chip.hidden === true).length, 0);
  });

  it('counts the attention "Show N more" over the FILTERED items, with the panel cap', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.attention = [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)];
    controller.renderAttention();
    assert.equal(textOf(doc.getElementById('attention-more')), 'Show 7 more');

    controller.setJobFilter('job-a');

    assert.equal(textOf(doc.getElementById('attention-more')), 'Show 3 more');
    assert.equal(rowsIn(doc).filter((row) => row.hidden === false).length, 5);
    assert.equal(rowsIn(doc).filter((row) => row.hidden === true).length, 3);
  });

  it('uses the panel cap, not overflowCount\'s fallback of MAX_CHIPS_PER_DAY', () => {
    const doc = makePage();
    const controller = makeController(doc);
    // Four filtered rows: below the panel cap of 5, above the day cap of 3.
    controller.state.attention = [...attentionRows('a', 'job-a', 4), ...attentionRows('b', 'job-b', 4, 24)];
    controller.setJobFilter('job-a');
    assert.equal(
      doc.getElementById('attention-more').hidden,
      true,
      'four filtered rows offered "Show 1 more" - overflowCount fell back to MAX_CHIPS_PER_DAY'
    );
    assert.notEqual(app.MAX_ATTENTION_ITEMS, app.MAX_CHIPS_PER_DAY);
  });

  it('retires the toggle and resets attentionExpanded when the filter empties the overflow', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.attention = [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)];
    controller.renderAttention();
    controller.toggleAttentionExpanded();
    assert.equal(controller.state.attentionExpanded, true);

    controller.setJobFilter('job-b');

    assert.equal(doc.getElementById('attention-more').hidden, true);
    assert.equal(textOf(doc.getElementById('attention-more')), '');
    assert.equal(rowsIn(doc).length, 4);
    assert.equal(rowsIn(doc).filter((row) => row.hidden === false).length, 4);
    assert.equal(controller.state.attentionExpanded, false, 'the expanded flag survived with nothing to hide');
  });

  it('and widening back to all jobs comes back COLLAPSED with a correct count - the documented behaviour', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.attention = [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)];
    controller.renderAttention();
    controller.toggleAttentionExpanded();
    controller.setJobFilter('job-b');

    controller.setJobFilter('');

    const toggle = doc.getElementById('attention-more');
    assert.equal(toggle.hidden, false);
    assert.equal(textOf(toggle), 'Show 7 more');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(controller.state.attentionExpanded, false);
  });

  it('renders NO <li> for a filtered-out row - filtering is not the same hiding as the cap', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.attention = [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)];
    controller.setJobFilter('job-a');

    const ids = rowsIn(doc).map((row) => row.getAttribute('data-event-id'));
    assert.deepEqual(ids, ['a-0', 'a-1', 'a-2']);
    for (const id of ['b-0', 'b-1', 'b-2', 'b-3']) {
      assert.equal(
        doc.getElementById('attention-list').querySelector(`[data-event-id="${id}"]`),
        null,
        `${id} was rendered hidden rather than left out of the filtered list`
      );
    }
  });
});

/* =========================================================================
 * Empty states must not lie while a filter is on
 * ========================================================================= */

describe('TASK-058 unit: the empty states under a filter', () => {
  const build = () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.events = monthEvents('b', 'job-b', 3);
    controller.state.attention = attentionRows('b', 'job-b', 4);
    controller.renderMonth();
    controller.renderAttention();
    return { doc, controller };
  };

  it('hides both empty states while the filtered view has something in it', () => {
    const { doc, controller } = build();
    controller.setJobFilter('job-b');
    assert.equal(doc.getElementById('calendar-empty').hidden, true);
    assert.equal(doc.getElementById('attention-empty').hidden, true);
  });

  it('says the FILTER is why the month is empty', () => {
    const { doc, controller } = build();
    controller.setJobFilter('job-a');
    const empty = doc.getElementById('calendar-empty');
    assert.equal(empty.hidden, false);
    assert.equal(textOf(empty), app.CALENDAR_EMPTY_FILTERED_MESSAGE);
    assert.equal(textOf(empty), 'No events from that processing job this month.');
  });

  it('says the FILTER is why nothing needs attention', () => {
    const { doc, controller } = build();
    controller.setJobFilter('job-a');
    const empty = doc.getElementById('attention-empty');
    assert.equal(empty.hidden, false);
    assert.equal(textOf(empty), app.ATTENTION_EMPTY_FILTERED_MESSAGE);
  });

  it('swaps the copy back the moment the filter clears', () => {
    const { doc, controller } = build();
    controller.setJobFilter('job-a');
    controller.setJobFilter('');
    assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
    assert.equal(textOf(doc.getElementById('attention-empty')), app.ATTENTION_EMPTY_MESSAGE);
    assert.equal(doc.getElementById('calendar-empty').hidden, true, 'the month has events again');
    assert.equal(doc.getElementById('attention-empty').hidden, true);
  });

  it('uses the unfiltered copy when there is genuinely nothing on', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.renderMonth();
    controller.renderAttention();
    assert.equal(doc.getElementById('calendar-empty').hidden, false);
    assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
    assert.equal(doc.getElementById('attention-empty').hidden, false);
    assert.equal(textOf(doc.getElementById('attention-empty')), app.ATTENTION_EMPTY_MESSAGE);
  });

  it('sets both messages with textContent - one text node, no markup', () => {
    const { doc, controller } = build();
    controller.setJobFilter('job-a');
    for (const id of ['calendar-empty', 'attention-empty']) {
      const node = doc.getElementById(id);
      assert.equal(node.childNodes.length, 1, `${id} holds more than one node`);
      assert.equal(node.childNodes[0].nodeType, 3, `${id} is not a text node`);
      assert.equal(node.children.length, 0);
    }
  });
});

/* =========================================================================
 * What the filter does NOT change
 * ========================================================================= */

describe('TASK-058 unit: the filter leaves the rest of the render alone', () => {
  it('adds no job name, id or badge to a chip or an attention row', () => {
    const doc = makePage();
    const controller = makeController(doc);
    controller.state.events = monthEvents('a', 'job-a', 1);
    controller.state.attention = attentionRows('a', 'job-a', 1);
    controller.setJobFilter('job-a');

    const chip = chipsIn(doc)[0];
    assert.equal(chip.getAttribute('data-processing-job-id'), null);
    assert.equal(/job-a/.test(textOf(chip)), false, 'a chip grew a job label');
    const row = rowsIn(doc)[0];
    assert.equal(row.getAttribute('data-processing-job-id'), null);
    assert.equal(/job-a/.test(textOf(row)), false, 'an attention row grew a job label');
  });

  it('leaves renderChip and renderAttentionItem free of the filter in source', () => {
    for (const signature of ['function renderChip(', 'function renderAttentionItem(']) {
      const body = functionBody(APP_JS, signature);
      assert.equal(/jobFilter|processingJob/.test(body), false, `${signature} was taught about the filter`);
    }
  });

  it('leaves the reused pure helpers untouched by the ticket', () => {
    assert.equal(app.overflowCount(4, 3), 1);
    assert.equal(app.overflowCount(4, 5), 0);
    assert.equal(app.MAX_CHIPS_PER_DAY, 3);
    assert.equal(app.MAX_ATTENTION_ITEMS, 5);
    for (const signature of [
      'export function groupEventsByDay(',
      'export function splitDayEvents(',
      'export function overflowCount(',
    ]) {
      assert.equal(
        /jobFilter|processingJob/.test(functionBody(APP_JS, signature)),
        false,
        `${signature} was modified by this ticket`
      );
    }
  });
});

/* =========================================================================
 * Source-shape claims no behavioural test can make
 * ========================================================================= */

describe('TASK-058 unit: app.js source shape', () => {
  it('calls renderJobFilter from applyIdentity, and from nowhere else', () => {
    const calls = APP_JS.match(/renderJobFilter\(\);/g) || [];
    assert.equal(calls.length, 1, 'renderJobFilter is called from more than one place');
    assert.match(functionBody(APP_JS, 'function applyIdentity()'), /renderJobFilter\(\);/);
  });

  it('never rebuilds the options from a render function', () => {
    for (const signature of ['function renderMonth()', 'function renderAttention()']) {
      const body = functionBody(APP_JS, signature);
      assert.equal(
        /renderJobFilter/.test(body),
        false,
        `${signature} rebuilds the dropdown - it runs on every poll and would reset the control under the user`
      );
      assert.equal(/job-filter/.test(body), false, `${signature} touches the filter control directly`);
    }
  });

  it('binds the change listener exactly once, in bindControls', () => {
    const bindings = APP_JS.match(/addEventListener\("change"/g) || [];
    assert.equal(bindings.length, 1, 'the change listener is bound in more than one place');
    assert.match(functionBody(APP_JS, 'function bindControls()'), /addEventListener\("change"/);
    for (const signature of ['function renderMonth()', 'function renderAttention()', 'function renderJobFilter()']) {
      assert.equal(
        /addEventListener/.test(functionBody(APP_JS, signature)),
        false,
        `${signature} adds a listener - handlers would stack once per render`
      );
    }
  });

  it('makes no request from setJobFilter, and re-renders exactly the two panels', () => {
    const body = functionBody(APP_JS, 'function setJobFilter(');
    assert.match(body, /renderMonth\(\);/);
    assert.match(body, /renderAttention\(\);/);
    for (const forbidden of ['api.', 'fetch', 'loadMonth', 'loadAttention', 'refreshAll', 'loadIdentity', 'closeEvent']) {
      assert.equal(body.includes(forbidden), false, `setJobFilter does ${forbidden}`);
    }
  });

  it('adds no new API call anywhere, and in particular never reads GET /calendar/api/settings', () => {
    assert.equal(APP_JS.includes('/api/settings'), false, 'app.js reads the settings endpoint');
    assert.equal(/api\.get\(`\$\{API_BASE\}\/settings/.test(APP_JS), false);
    const gets = APP_JS.match(/api\.get\(/g) || [];
    assert.equal(gets.length, 3, `app.js makes ${gets.length} GET calls - /auth/me, /events and /events/upcoming are the only three`);
  });

  it('persists the filter nowhere - no storage, no cookie, no query parameter', () => {
    for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'URLSearchParams', 'history.replaceState']) {
      assert.equal(APP_JS.includes(forbidden), false, `app.js uses ${forbidden}`);
    }
  });

  it('assembles no markup, so the new options cannot be built from a string', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
      assert.equal(APP_JS.includes(forbidden), false, `app.js uses ${forbidden}`);
    }
  });

  it('leaves the backend out of it: toEventJson gained no processingJobName', () => {
    assert.equal(EVENTS_MJS.includes('processingJobName'), false, 'events.mjs denormalises a job name onto an event');
    assert.equal(
      /processingJobName/.test(fs.readFileSync(path.join(CALENDAR_DIR, 'index.mjs'), 'utf-8')),
      false,
      'index.mjs resolves a job name server-side - that is the rejected design'
    );
  });
});

/* =========================================================================
 * The shipped markup
 * ========================================================================= */

describe('TASK-058 unit: index.html ships the control inert', () => {
  const doc = parseHtml(INDEX_HTML);

  it('ships #job-filter-row hidden, with the wrapper carrying hidden - not the select', () => {
    const row = doc.getElementById('job-filter-row');
    assert.notEqual(row, null, '#job-filter-row does not ship');
    assert.equal(row.localName, 'div');
    assert.equal(row.hidden, true, 'the row does not ship hidden');
    assert.match(row.className, /\bcalendar-filter\b/);
    assert.equal(doc.getElementById('job-filter').hidden, false, 'the <select> carries hidden, so the label floats alone');
  });

  it('ships a real <label for="job-filter"> with visible text and no aria-label', () => {
    const label = doc.querySelector('label[for="job-filter"]');
    assert.notEqual(label, null, 'the control has no real label');
    assert.equal(textOf(label), 'Show events from');
    assert.match(label.className, /\bcalendar-filter__label\b/);
    assert.equal(doc.getElementById('job-filter').getAttribute('aria-label'), null, 'an aria-label replaced the label');
  });

  it('ships the <select> with NO option children - every option is data', () => {
    const select = doc.getElementById('job-filter');
    assert.equal(select.localName, 'select');
    assert.match(select.className, /\bcalendar-filter__select\b/);
    assert.deepEqual(select.children, [], 'an <option> ships in the markup');
    assert.deepEqual(findElements(select, 'option'), []);
  });

  it('places the row between the calendar toolbar and #scan-message', () => {
    const panel = doc.querySelector('.calendar-panel');
    const children = panel.children;
    const at = (predicate) => children.findIndex(predicate);
    const toolbar = at((node) => /\bcalendar-toolbar\b/.test(node.className));
    const row = at((node) => node.getAttribute('id') === 'job-filter-row');
    const scan = at((node) => node.getAttribute('id') === 'scan-message');
    assert.notEqual(toolbar, -1, 'the calendar toolbar moved out of the panel');
    assert.ok(toolbar < row, 'the filter row is not after the toolbar');
    assert.ok(row < scan, 'the filter row is not before #scan-message');
    assert.equal(doc.querySelector('.calendar-toolbar #job-filter-row'), null, 'the row was nested inside the toolbar');
  });

  it('leaves the existing elements where the other suites assert they are', () => {
    const aside = doc.getElementById('attention-more').parentNode;
    const at = (id) => aside.children.findIndex((node) => node.getAttribute('id') === id);
    assert.ok(at('attention-list') < at('attention-more'));
    assert.ok(at('attention-more') < at('attention-empty'));
    for (const id of ['calendar-grid', 'calendar-weekdays', 'calendar-empty', 'calendar-truncated', 'scan-message']) {
      assert.notEqual(doc.getElementById(id), null, `#${id} stopped shipping`);
    }
  });

  it('adds no sixth frontend file', () => {
    const files = fs.readdirSync(FRONTEND_DIR).sort();
    assert.deepEqual(files, ['app.js', 'index.html', 'settings.html', 'settings.js', 'styles.css']);
  });
});

/* =========================================================================
 * styles.css read as text - there is no CSS engine in this repo
 * ========================================================================= */

describe('TASK-058 unit: styles.css read as text', () => {
  const topLevel = css.outsideMediaQueries(STYLES_CSS);
  const blocks = css.mediaBlocks(STYLES_CSS);
  const phone = blocks.find((block) => block.prelude === '(max-width: 600px)');

  it('gives .calendar-filter__select a 44px minimum OUTSIDE any media query', () => {
    assert.ok(css.rulesFor(topLevel, '.calendar-filter__select').length > 0, 'no top-level rule for the select');
    assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'min-height'), '44px');
    for (const block of blocks) {
      const value = css.declaredValue(block.body, '.calendar-filter__select', 'min-height');
      if (value === null) continue;
      assert.ok(Number.parseFloat(value) >= 44, `@media ${block.prelude} shrinks the select to ${value}`);
    }
  });

  it('keeps it at the 16px body size with font: inherit, so iOS does not zoom on focus', () => {
    assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'font'), 'inherit');
    for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
      assert.equal(
        css.declaredValue(scope, '.calendar-filter__select', 'font-size'),
        null,
        'a font-size on the select is what makes iOS zoom the page on focus'
      );
      const body = css.declaredValue(scope, 'body', 'font-size');
      if (body !== null) assert.equal(body, '16px');
    }
  });

  it('caps it at max-width: 100%, so a long job name cannot widen the panel', () => {
    assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'max-width'), '100%');
  });

  it('lays the row out with the same flex/wrap/gap idiom as .calendar-toolbar', () => {
    const declarations = css.declarationsOf(css.rulesFor(topLevel, '.calendar-filter')[0].body);
    assert.equal(declarations['display'], 'flex');
    assert.equal(declarations['flex-wrap'], 'wrap');
    assert.equal(declarations['align-items'], 'center');
    assert.ok(declarations['gap'] !== undefined, '.calendar-filter declares no gap');
    assert.equal(css.declaredValue(topLevel, '.calendar-toolbar', 'flex-wrap'), 'wrap', 'the idiom being copied moved');
  });

  it('gives the select a full-width row inside the existing 600px block', () => {
    assert.notEqual(phone, undefined, 'the 600px block is gone');
    assert.equal(css.declaredValue(phone.body, '.calendar-filter__select', 'width'), '100%');
    assert.equal(css.declaredValue(phone.body, '.toolbar-actions', 'width'), '100%', 'the pattern being followed moved');
  });

  it('appends to the 600px block and leaves the 860px one untouched', () => {
    assert.deepEqual(blocks.map((block) => block.prelude), ['(max-width: 860px)', '(max-width: 600px)']);
    assert.equal(css.eachRule(blocks[0].body).length, 1, 'the 860px block gained or lost a rule');
    assert.equal(css.declaredValue(blocks[0].body, '.app-main', 'grid-template-columns'), 'minmax(0, 1fr)');
    assert.equal(css.rulesFor(blocks[0].body, '.calendar-filter__select').length, 0, 'the 860px block was touched');
  });

  it('puts the new rules in the Calendar section, near .calendar-toolbar', () => {
    const stripped = css.stripComments(STYLES_CSS);
    const toolbar = stripped.indexOf('.calendar-toolbar {');
    const filter = stripped.indexOf('.calendar-filter {');
    const weekdays = stripped.indexOf('.calendar-weekdays,');
    assert.notEqual(filter, -1, '.calendar-filter has no rule');
    assert.ok(toolbar < filter, 'the filter rules are not in the Calendar section after .calendar-toolbar');
    assert.ok(filter < weekdays, 'the filter rules landed after the grid definitions');
  });

  /* --- edge / failure paths ------------------------------------------ */

  it('gives nothing a horizontal scroll region', () => {
    for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
      for (const selector of ['.calendar-filter', '.calendar-filter__select', '.calendar-panel', '.calendar-grid', '.calendar-week', '.calendar-weekdays']) {
        assert.equal(
          css.declaredValue(scope, selector, 'overflow-x'),
          null,
          `${selector} was given overflow-x - the page gains a sideways scrollbar at 360px`
        );
      }
    }
    assert.equal(css.declaredValue(topLevel, '.calendar-week', 'grid-template-columns'), 'repeat(7, minmax(0, 1fr))');
  });

  it('keeps [hidden] { display: none !important }, which is the only reason `hidden` beats display: flex', () => {
    const value = css.declaredValue(topLevel, '[hidden]', 'display');
    assert.notEqual(value, null, 'the [hidden] rule is gone - the filter row would show while hidden');
    assert.match(value, /none\s*!important/, '[hidden] lost its !important and display: flex now wins');
  });

  it('hides the row with `hidden` rather than visibility or height, so the select leaves the tab order', () => {
    for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
      assert.equal(css.declaredValue(scope, '.calendar-filter', 'visibility'), null);
      assert.equal(css.declaredValue(scope, '.calendar-filter', 'height'), null);
    }
    assert.equal(/visibility:\s*hidden/.test(css.stripComments(INDEX_HTML)), false);
  });

  it('stays self-contained: no @import, no web font, no remote URL', () => {
    assert.equal(/@import/i.test(STYLES_CSS), false);
    assert.equal(/https?:\/\//i.test(STYLES_CSS), false);
    assert.equal(/url\(\s*["']?\/\//i.test(STYLES_CSS), false);
  });
});
