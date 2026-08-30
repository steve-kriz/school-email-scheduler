/**
 * E2E (cucumber-style) scenarios for TASK-058 - "filter the calendar and the
 * attention list by processing job".
 *
 * Given / When / Then, driven through the code that actually ships:
 *
 *   - the client scenarios run the REAL `frontend/app.js` against the REAL
 *     `frontend/index.html`, parsed by `tests/helpers/fake-dom.mjs`. The filter
 *     row is STATIC markup, so a test that invented its own <select> would keep
 *     passing after `#job-filter` stopped shipping; parsing the real page means
 *     it does not;
 *   - the presentation scenarios pull `styles.css` back THROUGH THE REAL LAMBDA
 *     HANDLER and assert on the served bytes with the brace matcher in
 *     `tests/helpers/css-text.mjs`. There is no CSS engine and no layout in this
 *     repo, so "44px is not nested in a media query" is a statement about the
 *     stylesheet, not about a rendered box.
 *
 * NO DATABASE CONNECTION IS OPENED, and none can be. The client only ever talks
 * to an INJECTED `fetchImpl`; there is no real `fetch` in scope in any scenario
 * below, and an unknown route throws rather than escaping to the network. The
 * static routes never reach a data layer at all.
 *
 * TWO HARNESS RULES INHERITED FROM THE TASK-010 AND TASK-054 SUITES:
 *   1. `dispatch()` awaits its handlers - acknowledge and dismiss are async, so
 *      a synchronous click would assert before the fetch resolved.
 *   2. Every stubbed body is a fresh `structuredClone`. `state.attention`
 *      aliases the parsed array and the optimistic splice mutates it, so a
 *      shared array would corrupt the fixture instead of testing the code.
 *
 * AND ONE THAT IS SPECIFIC TO A <select> IN THIS HARNESS: a select built with
 * `createElement` does not derive its `.value` from its options (`fake-dom.mjs`
 * hydrates that only at PARSE time), which is exactly why the app assigns
 * `select.value` explicitly. A user choice is therefore driven the way the
 * browser would deliver it: set `.value`, then `await dispatch('change')`.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must precede the index.mjs import: its log level is read once at module load.
process.env.CALENDAR_LOG_LEVEL = 'none';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar');
const FRONTEND_DIR = path.join(CALENDAR_DIR, 'frontend');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');

const { handler, FRONTEND_ROUTES, FRONTEND_FILES } = await import('../../src/lambda/calendar/index.mjs');
const app = await import('../../src/lambda/calendar/frontend/app.js');
const { loadDocument, findElements, textOf } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const XSS = '<img src=x onerror=alert(1)>';

/** Noon-ish on 15 September 2026 UTC+10 - September 2026 in every real zone. */
const NOW = Date.parse('2026-09-15T02:00:00.000Z');

/** The two jobs the Background configures. */
const JOB_A = { id: 'job-a', name: 'Junior School' };
const JOB_B = { id: 'job-b', name: 'Senior School' };

/** Let every already-resolved promise chain settle. */
async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const albEvent = (requestPath, method = 'GET') => ({
  version: '2.0',
  rawPath: requestPath,
  rawQueryString: '',
  requestContext: {
    domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
    http: { method, path: requestPath },
  },
  headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
  cookies: [],
  queryStringParameters: {},
  body: null,
  isBase64Encoded: false,
});

/* =========================================================================
 * The world: an injected fetch that answers the calendar API, and nothing else.
 * ========================================================================= */

function makeWorld(overrides = {}) {
  const world = {
    calls: [],
    processingJobs: [JOB_A, JOB_B],
    events: [],
    truncated: false,
    attention: [],
    mutationStatus: 200,
    mutationBody: { ok: true },
    ...overrides,
  };

  world.me = () => ({
    connectionStatus: 'connected',
    email: 'parent@example.test',
    lastScanStatus: 'ok',
    processingJobs: world.processingJobs,
  });

  const reply = (status, body) => ({ status, json: async () => structuredClone(body ?? {}) });

  world.fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const requestPath = full.split('?')[0];
    world.calls.push({ path: requestPath, url: full, method: init.method || 'GET' });

    if (requestPath === '/calendar/api/auth/me') return reply(200, world.me());
    if (requestPath === '/calendar/api/events') {
      return reply(200, { events: world.events, truncated: world.truncated });
    }
    if (requestPath === '/calendar/api/events/upcoming') {
      return reply(200, { events: world.attention });
    }
    if (/^\/calendar\/api\/events\/[^/]+\/(acknowledge|dismiss|restore)$/.test(requestPath)) {
      return reply(world.mutationStatus, world.mutationBody);
    }
    throw new Error(`the page requested a route the world does not know: ${full}`);
  };

  return world;
}

/** Injected timers, so "the 60s poll fired" is an observable fact. */
function makeTimers() {
  const timers = { nextId: 1, started: [], cleared: [], fn: null };
  timers.setIntervalImpl = (fn, ms) => {
    const id = timers.nextId;
    timers.nextId += 1;
    timers.fn = fn;
    timers.started.push({ id, ms });
    return id;
  };
  timers.clearIntervalImpl = (id) => timers.cleared.push(id);
  timers.fire = async () => {
    if (typeof timers.fn !== 'function') throw new Error('no interval was ever started');
    timers.fn();
    await drain();
  };
  return timers;
}

/** Open the real calendar page against the real app.js. */
function openCalendar(world, options = {}) {
  const doc = loadDocument(INDEX_HTML);
  const timers = makeTimers();
  const controller = app.createCalendarApp({
    document: doc,
    fetchImpl: world.fetchImpl,
    now: () => NOW,
    locale: 'en-AU',
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    ...options,
  });
  return { doc, timers, controller };
}

/** Given a started page. */
async function startedPage(world, options = {}) {
  const opened = openCalendar(world, options);
  await opened.controller.start();
  return opened;
}

/* --- Fixtures --------------------------------------------------------- */

/** `count` all-day month events on consecutive days, attributed to `jobId`. */
const monthEvents = (prefix, jobId, count, firstDay = 1) =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    startsAt: `2026-09-${String(firstDay + index).padStart(2, '0')}`,
    allDay: true,
    processingJobId: jobId,
  }));

/** `count` events all landing on ONE day, attributed to `jobId`. */
const oneDayEvents = (prefix, jobId, count, dateKey = '2026-09-12') =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    startsAt: dateKey,
    allDay: true,
    processingJobId: jobId,
  }));

/** `count` pending attention rows for `jobId`, deadlines from `firstDay`. */
const attentionRows = (prefix, jobId, count, firstDay = 16) =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    startsAt: '2026-09-28',
    allDay: true,
    needsAttention: true,
    status: 'pending',
    actionRequired: `Do the thing for ${prefix} ${index}`,
    processingJobId: jobId,
    dueBy: `2026-09-${String(firstDay + index).padStart(2, '0')}T00:00:00.000Z`,
  }));

/* --- Readers ----------------------------------------------------------- */

const selectIn = (doc) => doc.getElementById('job-filter');
const optionsIn = (doc) => selectIn(doc).querySelectorAll('option');
const chipsIn = (doc) => doc.getElementById('calendar-grid').querySelectorAll('.chip');
const chipIds = (doc) => chipsIn(doc).map((chip) => chip.getAttribute('data-event-id'));
const cellFor = (doc, key) => doc.getElementById('calendar-grid').querySelector(`[data-date="${key}"]`);
const rowsIn = (doc) => doc.getElementById('attention-list').querySelectorAll('.attention-item');
const rowIds = (doc) => rowsIn(doc).map((row) => row.getAttribute('data-event-id'));
const visibleRowIds = (doc) => rowsIn(doc).filter((row) => row.hidden === false).map((row) => row.getAttribute('data-event-id'));
const hiddenRowIds = (doc) => rowsIn(doc).filter((row) => row.hidden === true).map((row) => row.getAttribute('data-event-id'));
const toggleIn = (doc) => doc.getElementById('attention-more');
const rowFor = (doc, id) => doc.getElementById('attention-list').querySelector(`[data-event-id="${id}"]`);

/**
 * When the user selects an option in the filter.
 *
 * The browser sets `.value` and then fires `change`; so does this. `dispatch` is
 * async and awaits every handler.
 */
async function selectJob(doc, value) {
  const select = selectIn(doc);
  select.value = value;
  await select.dispatch('change');
}

/** When the user selects the option whose LABEL is `name`. */
async function selectJobNamed(doc, name) {
  const option = optionsIn(doc).find((node) => textOf(node) === name);
  assert.notEqual(option, undefined, `no option labelled "${name}" - the dropdown does not offer that job`);
  await selectJob(doc, option.getAttribute('value'));
}

/* =========================================================================
 * Feature: Filtering the calendar by processing job
 *
 * Background:
 *   Given an authenticated user whose Gmail is connected
 *   And GET /calendar/api/auth/me returns processingJobs job-a "Junior School"
 *     and job-b "Senior School"
 *   And the calendar page has started
 * ========================================================================= */

describe('Feature: Filtering the calendar by processing job', () => {
  describe('Scenario: The control lists every configured job plus an "All" option', () => {
    it('When the page has finished starting, Then the row is visible and offers All + both jobs', async () => {
      const world = makeWorld();
      const { doc, controller } = await startedPage(world);

      assert.equal(doc.getElementById('job-filter-row').hidden, false, 'the filter row stayed hidden with two jobs');
      const options = optionsIn(doc);
      assert.equal(options.length, 3, 'the select does not offer All jobs plus both jobs');
      assert.equal(options[0].getAttribute('value'), '');
      assert.equal(textOf(options[0]), 'All jobs');
      assert.deepEqual(options.slice(1).map((option) => option.getAttribute('value')), ['job-a', 'job-b']);
      assert.deepEqual(options.slice(1).map((option) => textOf(option)), ['Junior School', 'Senior School']);
      assert.equal(selectIn(doc).value, '', 'the control did not come up on "All jobs"');
      assert.equal(controller.state.jobFilter, null);
    });

    it('And the option list came from /auth/me alone - no settings request was made', async () => {
      const world = makeWorld();
      const { doc } = await startedPage(world);
      await selectJob(doc, 'job-a');
      await selectJob(doc, '');

      assert.deepEqual(
        world.calls.map((call) => call.path),
        ['/calendar/api/auth/me', '/calendar/api/events', '/calendar/api/events/upcoming'],
        'a full start plus two filter changes made a request the design forbids'
      );
      assert.equal(
        world.calls.some((call) => call.path === '/calendar/api/settings'),
        false,
        'the page joined the job names against GET /calendar/api/settings'
      );
    });
  });

  describe('Scenario: All jobs is the default and shows everything', () => {
    it('Given 2 events for job-a and 3 for job-b, Then 5 chips render and jobFilter is null', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);

      assert.equal(chipsIn(doc).length, 5);
      assert.equal(controller.state.jobFilter, null);
      assert.equal(selectIn(doc).value, '');
    });
  });

  describe("Scenario: Filtering to one job hides the other job's events from the grid", () => {
    it('When the user selects "Junior School", Then only the 2 job-a chips remain', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);

      await selectJobNamed(doc, 'Junior School');

      assert.equal(chipsIn(doc).length, 2);
      assert.deepEqual(chipIds(doc), ['a-0', 'a-1']);
      for (const id of ['b-0', 'b-1', 'b-2']) {
        assert.equal(chipIds(doc).includes(id), false, `${id} belongs to job-b and is still on the grid`);
      }
      assert.equal(controller.state.jobFilter, 'job-a');
    });
  });

  describe("Scenario: Filtering to one job hides the other job's rows from the attention list", () => {
    it('Given 3 job-a and 4 job-b items, When "Senior School" is selected, Then exactly 4 rows remain', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc } = await startedPage(world);
      assert.equal(rowsIn(doc).length, 7);

      await selectJobNamed(doc, 'Senior School');

      assert.equal(rowsIn(doc).length, 4);
      assert.deepEqual(rowIds(doc), ['b-0', 'b-1', 'b-2', 'b-3']);
      for (const id of ['a-0', 'a-1', 'a-2']) {
        assert.equal(rowFor(doc, id), null, `${id} belongs to job-a and is still in the list`);
      }
    });
  });

  describe('Scenario: Switching back to "All" restores everything', () => {
    it('When the user reselects "All jobs", Then all 5 chips and all 7 rows come back', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');
      assert.equal(chipsIn(doc).length, 2);

      await selectJobNamed(doc, 'All jobs');

      assert.equal(chipsIn(doc).length, 5);
      assert.equal(rowsIn(doc).length, 7);
      assert.equal(controller.state.jobFilter, null);
    });
  });

  describe('Scenario: Changing the filter makes no network request', () => {
    it('Given the call count so far, When two selections are made, Then it is unchanged', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc } = await startedPage(world);
      const before = world.calls.length;
      assert.equal(before, 3, 'the start-up request set changed');

      await selectJobNamed(doc, 'Senior School');
      await selectJobNamed(doc, 'All jobs');

      assert.equal(world.calls.length, before, 'changing the filter refetched something');
    });
  });

  describe('Scenario: The filter survives a background refresh', () => {
    it('Given "Junior School" is selected, When the 60s timer fires, Then only job-a still renders', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, timers, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await timers.fire();

      assert.equal(controller.state.jobFilter, 'job-a', 'the poll cleared the filter');
      assert.deepEqual(chipIds(doc), ['a-0', 'a-1']);
      assert.deepEqual(rowIds(doc), ['a-0', 'a-1', 'a-2']);
      assert.equal(selectIn(doc).value, 'job-a', 'the poll reset the control');
      assert.equal(optionsIn(doc).length, 3, 'the poll rebuilt the option list');
    });

    it('And an explicit loadMonth / loadAttention leaves it selected too', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await controller.loadMonth();
      await controller.loadAttention();

      assert.equal(controller.state.jobFilter, 'job-a');
      assert.equal(chipsIn(doc).length, 2);
      assert.equal(rowsIn(doc).length, 3);
    });
  });

  describe('Scenario: The filter survives month navigation', () => {
    it('When the user activates "next-month", Then the selection and its label are unchanged', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await doc.getElementById('next-month').dispatch('click');

      assert.equal(controller.state.jobFilter, 'job-a', 'paging to October cleared the filter');
      assert.equal(controller.state.viewMonth, 9, 'the page did not actually navigate');
      const select = selectIn(doc);
      assert.equal(select.value, 'job-a');
      const selected = optionsIn(doc).find((option) => option.getAttribute('value') === select.value);
      assert.equal(textOf(selected), 'Junior School', 'the control no longer shows the selected job');
    });

    it('And "today" and "previous month" keep it too', async () => {
      const world = makeWorld({ events: monthEvents('a', 'job-a', 2) });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await doc.getElementById('prev-month').dispatch('click');
      assert.equal(controller.state.jobFilter, 'job-a');
      await doc.getElementById('today').dispatch('click');
      assert.equal(controller.state.jobFilter, 'job-a');
      assert.equal(selectIn(doc).value, 'job-a');
    });
  });

  describe('Scenario: Filtering does not discard the events it is hiding', () => {
    it('When "Junior School" is selected, Then state.events still holds all 5', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, controller } = await startedPage(world);

      await selectJobNamed(doc, 'Junior School');

      assert.equal(controller.state.events.length, 5, 'state.events was filtered in place');
      assert.equal(controller.state.attention.length, 7, 'state.attention was filtered in place');
      assert.deepEqual(
        controller.state.events.map((event) => event.eventId),
        ['a-0', 'a-1', 'b-0', 'b-1', 'b-2'],
        'the backing array was reordered or trimmed'
      );
    });
  });
});

/* =========================================================================
 * Feature: Overflow counts follow the filter
 *
 * Background:
 *   Given an authenticated user with processing jobs "job-a" and "job-b"
 *   And the calendar page has started with a maximum of 3 chips per day
 *   And a maximum of 5 visible attention items
 * ========================================================================= */

describe('Feature: Overflow counts follow the filter', () => {
  const CHIP_OPTIONS = { maxChipsPerDay: 3, maxAttentionItems: 5 };

  describe('Scenario: A day cell\'s "+N more" counts only the filtered events', () => {
    it('Given 4 job-a and 3 job-b events on the 12th, Then unfiltered shows "+4 more" and job-a shows "+1 more"', async () => {
      const world = makeWorld({
        events: [...oneDayEvents('a', 'job-a', 4), ...oneDayEvents('b', 'job-b', 3)],
      });
      const { doc } = await startedPage(world, CHIP_OPTIONS);

      assert.equal(textOf(cellFor(doc, '2026-09-12').querySelector('.more-toggle')), '+4 more');

      await selectJobNamed(doc, 'Junior School');

      assert.equal(
        textOf(cellFor(doc, '2026-09-12').querySelector('.more-toggle')),
        '+1 more',
        'the overflow count still included events the filter had hidden'
      );
    });

    it('And revealing the overflow shows only job-a events', async () => {
      const world = makeWorld({
        events: [...oneDayEvents('a', 'job-a', 4), ...oneDayEvents('b', 'job-b', 3)],
      });
      const { doc } = await startedPage(world, CHIP_OPTIONS);
      await selectJobNamed(doc, 'Junior School');

      const cell = cellFor(doc, '2026-09-12');
      await cell.querySelector('.more-toggle').dispatch('click');

      const ids = cell.querySelectorAll('.chip').map((chip) => chip.getAttribute('data-event-id'));
      assert.deepEqual(ids, ['a-0', 'a-1', 'a-2', 'a-3'], 'expanding revealed an event from another job');
      assert.equal(cell.querySelectorAll('.chip').some((chip) => chip.hidden === true), false);
    });
  });

  describe('Scenario: A day cell that fits after filtering loses its "+N more" entirely', () => {
    it('Given 4 job-a and 2 job-b on one day, When job-b is selected, Then no .more-toggle is rendered', async () => {
      const world = makeWorld({
        events: [...oneDayEvents('a', 'job-a', 4), ...oneDayEvents('b', 'job-b', 2)],
      });
      const { doc } = await startedPage(world, CHIP_OPTIONS);
      assert.notEqual(cellFor(doc, '2026-09-12').querySelector('.more-toggle'), null);

      await selectJobNamed(doc, 'Senior School');

      const cell = cellFor(doc, '2026-09-12');
      assert.equal(cell.querySelector('.more-toggle'), null, 'a cell that fits kept its overflow control');
      const chips = cell.querySelectorAll('.chip');
      assert.equal(chips.length, 2);
      assert.equal(chips.every((chip) => chip.hidden === false), true, 'a job-b chip is hidden with room to spare');
    });
  });

  describe('Scenario: The attention "Show N more" counts only the filtered items', () => {
    it('Given 8 job-a and 4 job-b items, Then unfiltered reads "Show 7 more" and job-a reads "Show 3 more"', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)],
      });
      const { doc } = await startedPage(world, CHIP_OPTIONS);

      assert.equal(textOf(toggleIn(doc)), 'Show 7 more');

      await selectJobNamed(doc, 'Junior School');

      assert.equal(textOf(toggleIn(doc)), 'Show 3 more');
      assert.equal(visibleRowIds(doc).length, 5, 'five items are not visible under the cap');
      assert.deepEqual(visibleRowIds(doc), ['a-0', 'a-1', 'a-2', 'a-3', 'a-4']);
      assert.deepEqual(hiddenRowIds(doc), ['a-5', 'a-6', 'a-7'], 'three items are not present but hidden');
    });
  });

  describe('Scenario: Filtering below the cap retires the attention toggle', () => {
    it('Given the panel is expanded, When job-b is selected, Then the toggle hides and the flag resets', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)],
      });
      const { doc, controller } = await startedPage(world, CHIP_OPTIONS);
      await toggleIn(doc).dispatch('click');
      assert.equal(controller.state.attentionExpanded, true);

      await selectJobNamed(doc, 'Senior School');

      assert.equal(toggleIn(doc).hidden, true, 'the expander stayed on screen with nothing to expand');
      assert.equal(textOf(toggleIn(doc)), '', 'a hidden expander kept a stale label');
      assert.equal(rowsIn(doc).length, 4);
      assert.deepEqual(hiddenRowIds(doc), [], 'a job-b row stayed hidden');
      assert.equal(controller.state.attentionExpanded, false);
    });
  });

  describe('Scenario: Switching back to All comes back collapsed with the correct count', () => {
    it('When the user reselects "All jobs", Then the toggle reads "Show 7 more" and aria-expanded is "false"', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 8), ...attentionRows('b', 'job-b', 4, 24)],
      });
      const { doc, controller } = await startedPage(world, CHIP_OPTIONS);
      await selectJobNamed(doc, 'Senior School');

      await selectJobNamed(doc, 'All jobs');

      const toggle = toggleIn(doc);
      assert.equal(toggle.hidden, false);
      assert.equal(textOf(toggle), 'Show 7 more');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(controller.state.attentionExpanded, false);
      assert.equal(rowsIn(doc).length, 12);
    });
  });

  describe('Scenario: A filtered-out attention row is absent from the list, not merely hidden', () => {
    it('Given 3 job-a and 4 job-b items, When job-a is selected, Then no <li> carries a job-b id', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc } = await startedPage(world, CHIP_OPTIONS);

      await selectJobNamed(doc, 'Junior School');

      assert.deepEqual(rowIds(doc), ['a-0', 'a-1', 'a-2']);
      for (const id of ['b-0', 'b-1', 'b-2', 'b-3']) {
        assert.equal(
          rowFor(doc, id),
          null,
          `${id} was rendered as a hidden row - a filtered-out row is a different list, not a collapsed part of this one`
        );
      }
      assert.deepEqual(hiddenRowIds(doc), [], 'a filtered list at three items hid a row');
    });
  });
});

/* =========================================================================
 * Feature: A single-job user sees no change
 * ========================================================================= */

describe('Feature: A single-job user sees no change', () => {
  describe('Scenario: One processing job means no filter control', () => {
    it('Given exactly one job named "Default", Then the row is hidden and everything renders', async () => {
      const world = makeWorld({
        processingJobs: [{ id: 'job-only', name: 'Default' }],
        events: monthEvents('a', 'job-only', 4),
        attention: attentionRows('a', 'job-only', 2),
      });
      const { doc, controller } = await startedPage(world);

      assert.equal(doc.getElementById('job-filter-row').hidden, true, 'a one-option dropdown was rendered');
      assert.equal(chipsIn(doc).length, 4);
      assert.equal(rowsIn(doc).length, 2);
      assert.equal(controller.state.jobFilter, null);
      assert.deepEqual(controller.state.processingJobs, [{ id: 'job-only', name: 'Default' }]);
    });
  });

  describe('Scenario: No processing jobs at all means no filter control', () => {
    it('Given processingJobs is null, Then the row is hidden and every event still renders', async () => {
      const world = makeWorld({
        processingJobs: null,
        events: monthEvents('a', null, 3),
        attention: attentionRows('a', null, 2),
      });
      const { doc, controller } = await startedPage(world);

      assert.equal(doc.getElementById('job-filter-row').hidden, true);
      assert.deepEqual(controller.state.processingJobs, []);
      assert.equal(controller.state.jobFilter, null);
      assert.equal(chipsIn(doc).length, 3, 'a page with no jobs stopped rendering its events');
      assert.equal(rowsIn(doc).length, 2);
      assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
    });

    it('And an /auth/me that predates processing jobs entirely behaves the same way', async () => {
      const world = makeWorld({ processingJobs: undefined, events: monthEvents('a', undefined, 3) });
      const { doc, controller } = await startedPage(world);

      assert.equal(doc.getElementById('job-filter-row').hidden, true);
      assert.deepEqual(controller.state.processingJobs, []);
      assert.equal(chipsIn(doc).length, 3);
      assert.equal(optionsIn(doc).length, 1, 'options were built for a page with no jobs');
    });
  });

  /* =======================================================================
   * Failure and edge paths
   * ===================================================================== */

  describe('Scenario: Events with no job attribution are visible under All and hidden under a job', () => {
    it('Given 2 unattributed events and 2 job-a events, Then All shows 4 and job-a shows 2', async () => {
      const world = makeWorld({
        events: [
          ...monthEvents('a', 'job-a', 2),
          { eventId: 'u-0', title: 'Unattributed 0', startsAt: '2026-09-05', allDay: true, processingJobId: null },
          { eventId: 'u-1', title: 'Unattributed 1', startsAt: '2026-09-06', allDay: true, processingJobId: null },
        ],
      });
      const { doc } = await startedPage(world);
      assert.equal(chipsIn(doc).length, 4);

      await selectJobNamed(doc, 'Junior School');

      assert.equal(chipsIn(doc).length, 2);
      assert.deepEqual(chipIds(doc), ['a-0', 'a-1']);
      for (const id of ['u-0', 'u-1']) {
        assert.equal(chipIds(doc).includes(id), false, `${id} leaked into a job's view`);
      }
    });

    it('And no "unattributed" pseudo-job is offered in the dropdown', async () => {
      const world = makeWorld({
        events: [{ eventId: 'u-0', title: 'Unattributed', startsAt: '2026-09-05', allDay: true, processingJobId: null }],
      });
      const { doc } = await startedPage(world);
      assert.deepEqual(optionsIn(doc).map((option) => textOf(option)), ['All jobs', 'Junior School', 'Senior School']);
    });
  });

  describe('Scenario: The events endpoint omitting processingJobId leaves the filter inert, not broken', () => {
    it('Given 5 events with no processingJobId field, When job-a is selected, Then 0 chips and the empty state', async () => {
      const world = makeWorld({
        events: Array.from({ length: 5 }, (unused, index) => ({
          eventId: `e-${index}`,
          title: `Event ${index}`,
          startsAt: `2026-09-0${index + 1}`,
          allDay: true,
        })),
      });
      const { doc, controller } = await startedPage(world);
      assert.equal(chipsIn(doc).length, 5);

      await assert.doesNotReject(() => selectJobNamed(doc, 'Junior School'));

      assert.equal(chipsIn(doc).length, 0);
      assert.equal(doc.getElementById('calendar-empty').hidden, false);
      assert.equal(controller.state.events.length, 5, 'the inert filter destroyed the events it could not match');
    });
  });

  describe('Scenario: A job removed in settings clears a stale selection on the next load', () => {
    it('Given job-b is selected, When /auth/me returns only job-a, Then the selection resets and everything renders', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Senior School');
      assert.equal(controller.state.jobFilter, 'job-b');

      world.processingJobs = [JOB_A];
      await controller.loadIdentity();

      assert.equal(optionsIn(doc).length, 2, 'the option list did not shrink to All jobs + Junior School');
      assert.deepEqual(optionsIn(doc).map((option) => textOf(option)), ['All jobs', 'Junior School']);
      assert.equal(controller.state.jobFilter, null, 'a selection naming a deleted job survived');
      assert.equal(selectIn(doc).value, '');
      assert.equal(chipsIn(doc).length, 5, 'the grid was not re-rendered unfiltered');
      assert.equal(rowsIn(doc).length, 7);
      assert.equal(doc.getElementById('job-filter-row').hidden, true, 'a one-job user was left with a dropdown');
    });

    it('And a poll alone never reloads the job list - that is deliberate, not a gap', async () => {
      const world = makeWorld({ events: monthEvents('a', 'job-a', 2) });
      const { doc, timers, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      world.processingJobs = [JOB_A];
      await timers.fire();

      assert.equal(controller.state.jobFilter, 'job-a', 'the poll re-read identity and reset the filter');
      assert.equal(optionsIn(doc).length, 3, 'the poll rebuilt the dropdown under the user');
      assert.equal(
        world.calls.filter((call) => call.path === '/calendar/api/auth/me').length,
        1,
        'the 60s poll added an identity fetch'
      );
    });
  });

  describe('Scenario: A hostile job name is rendered as text in the option', () => {
    it('Given a job named with an <img> payload, Then the option holds the literal string and no IMG exists', async () => {
      const world = makeWorld({ processingJobs: [{ id: 'job-a', name: XSS }, JOB_B] });
      const { doc } = await startedPage(world);

      const option = optionsIn(doc)[1];
      assert.equal(textOf(option), XSS);
      assert.equal(option.childNodes.length, 1, 'the name parsed into more than one node');
      assert.equal(option.childNodes[0].nodeType, 3, 'the option label is not a text node');
      assert.deepEqual(findElements(doc, 'img'), [], 'a hostile job name created an element');
      assert.deepEqual(findElements(selectIn(doc), 'script'), []);
    });

    it('And selecting it still filters on the id, not on the name', async () => {
      const world = makeWorld({
        processingJobs: [{ id: 'job-a', name: XSS }, JOB_B],
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);

      await selectJobNamed(doc, XSS);

      assert.equal(controller.state.jobFilter, 'job-a');
      assert.deepEqual(chipIds(doc), ['a-0', 'a-1']);
    });
  });

  describe('Scenario: A malformed processingJobs entry is dropped, not rendered', () => {
    it('Given one valid job, one blank name, one with no id and one string, Then only 2 options exist', async () => {
      const world = makeWorld({
        processingJobs: [JOB_A, { id: 'job-x', name: '   ' }, { name: 'No id' }, 'job-y'],
      });
      const { doc, controller } = await startedPage(world);

      assert.equal(optionsIn(doc).length, 2, 'a malformed entry was rendered as an option');
      assert.deepEqual(optionsIn(doc).map((option) => textOf(option)), ['All jobs', 'Junior School']);
      assert.deepEqual(optionsIn(doc).map((option) => option.getAttribute('value')), ['', 'job-a']);
      assert.deepEqual(controller.state.processingJobs, [JOB_A]);
      assert.equal(doc.getElementById('job-filter-row').hidden, true, 'one usable job still showed the control');
    });
  });

  describe('Scenario: An empty filtered month says the filter is why, not that there is nothing on', () => {
    it('Given 3 events all for job-b, When job-a is selected, Then the filtered copy shows', async () => {
      const world = makeWorld({ events: monthEvents('b', 'job-b', 3) });
      const { doc } = await startedPage(world);
      assert.equal(doc.getElementById('calendar-empty').hidden, true);

      await selectJobNamed(doc, 'Junior School');

      const empty = doc.getElementById('calendar-empty');
      assert.equal(empty.hidden, false);
      assert.equal(textOf(empty), 'No events from that processing job this month.');
      assert.equal(textOf(empty), app.CALENDAR_EMPTY_FILTERED_MESSAGE);
    });

    it('And reselecting "All jobs" hides it again', async () => {
      const world = makeWorld({ events: monthEvents('b', 'job-b', 3) });
      const { doc } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await selectJobNamed(doc, 'All jobs');

      assert.equal(doc.getElementById('calendar-empty').hidden, true);
      assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
    });
  });

  describe('Scenario: An empty filtered attention list says the filter is why', () => {
    it('Given 4 attention items all for job-b, When job-a is selected, Then the filtered copy shows', async () => {
      const world = makeWorld({ attention: attentionRows('b', 'job-b', 4) });
      const { doc } = await startedPage(world);

      await selectJobNamed(doc, 'Junior School');

      const empty = doc.getElementById('attention-empty');
      assert.equal(empty.hidden, false);
      assert.equal(textOf(empty), 'Nothing from that processing job needs attention.');
      assert.equal(textOf(empty), app.ATTENTION_EMPTY_FILTERED_MESSAGE);
      assert.equal(rowsIn(doc).length, 0);
      assert.equal(toggleIn(doc).hidden, true);
    });
  });

  describe('Scenario: The unfiltered empty copy is unchanged from what index.html ships', () => {
    it('Given nothing at all, When the page renders unfiltered, Then the original wording shows', async () => {
      const world = makeWorld();
      const { doc } = await startedPage(world);

      assert.match(textOf(doc.getElementById('calendar-empty')), /No events this month/);
      assert.match(textOf(doc.getElementById('attention-empty')), /Nothing needs attention/);
      assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
      assert.equal(textOf(doc.getElementById('attention-empty')), app.ATTENTION_EMPTY_MESSAGE);
      assert.match(doc.getElementById('calendar-empty').className, /empty-state--success/);
    });

    it('And the shipped markup carries that same wording for a page whose script never runs', () => {
      const doc = loadDocument(INDEX_HTML);
      assert.equal(textOf(doc.getElementById('calendar-empty')), app.CALENDAR_EMPTY_MESSAGE);
      assert.equal(textOf(doc.getElementById('attention-empty')), app.ATTENTION_EMPTY_MESSAGE);
    });
  });

  describe('Scenario: Acknowledging a visible row under a filter still restores in place on failure', () => {
    it('Given 3 job-a and 4 job-b items and a 500, When the 2nd visible row is acknowledged, Then it comes back 2nd', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
        mutationStatus: 500,
        mutationBody: { error: 'Could not update the event' },
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');
      assert.deepEqual(rowIds(doc), ['a-0', 'a-1', 'a-2']);

      await rowFor(doc, 'a-1').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.deepEqual(rowIds(doc), ['a-0', 'a-1', 'a-2'], 'the row did not come back in the filtered list in place');
      assert.equal(controller.state.attention.length, 7, 'the backing array lost or duplicated a row');
      const message = doc.getElementById('attention-message');
      assert.equal(message.hidden, false, 'the failure was swallowed');
      assert.equal(textOf(message), app.RESTORE_MESSAGE);
      assert.equal(controller.state.jobFilter, 'job-a', 'the failed mutation cleared the filter');
    });

    it('And a SUCCESSFUL acknowledge under a filter removes only that row', async () => {
      const world = makeWorld({
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      await rowFor(doc, 'a-1').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.deepEqual(rowIds(doc), ['a-0', 'a-2']);
      assert.equal(controller.state.attention.length, 6);
      assert.equal(controller.state.jobFilter, 'job-a');
    });
  });

  describe('Scenario: The truncated notice is about the fetch, not the filter', () => {
    it('Given truncated true, When job-a is selected, Then the notice is still visible and unchanged', async () => {
      const world = makeWorld({
        truncated: true,
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);
      const notice = doc.getElementById('calendar-truncated');
      assert.equal(notice.hidden, false, 'the truncated notice never showed');
      const before = textOf(notice);

      await selectJobNamed(doc, 'Junior School');

      assert.equal(doc.getElementById('calendar-truncated').hidden, false, 'the filter cleared the truncated notice');
      assert.equal(textOf(doc.getElementById('calendar-truncated')), before);
      assert.equal(controller.state.truncated, true);
    });
  });

  describe('Scenario: An open detail panel is not closed by changing the filter', () => {
    it('Given the detail panel is open for a job-b event, When job-a is selected, Then it stays open', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
      });
      const { doc, controller } = await startedPage(world);
      const chip = chipsIn(doc).find((node) => node.getAttribute('data-event-id') === 'b-0');
      await chip.dispatch('click');
      assert.equal(doc.getElementById('event-detail').hidden, false);

      await selectJobNamed(doc, 'Junior School');

      const panel = doc.getElementById('event-detail');
      assert.equal(panel.hidden, false, 'filtering closed a panel the user deliberately opened');
      assert.equal(panel.getAttribute('data-event-id'), 'b-0', 'the panel lost the event it was showing');
      assert.equal(controller.state.selectedEventId, 'b-0');
      // The chip it was opened from is gone; the panel is not.
      assert.equal(chipIds(doc).includes('b-0'), false);
    });
  });

  describe('Scenario: The change listener is bound once, not once per render', () => {
    it('Given 5 polls have fired, When "All jobs" is selected, Then one choice flips the view exactly once', async () => {
      const world = makeWorld({
        events: [...monthEvents('a', 'job-a', 2), ...monthEvents('b', 'job-b', 3, 5)],
        attention: [...attentionRows('a', 'job-a', 3), ...attentionRows('b', 'job-b', 4, 20)],
      });
      const { doc, timers, controller } = await startedPage(world);
      await selectJobNamed(doc, 'Junior School');

      for (let turn = 0; turn < 5; turn += 1) await timers.fire();

      assert.equal(selectIn(doc).listeners.get('change').length, 1, 'the change handler was bound more than once');

      await selectJobNamed(doc, 'All jobs');

      assert.equal(controller.state.jobFilter, null);
      assert.equal(chipsIn(doc).length, 5);
      assert.equal(rowsIn(doc).length, 7);
    });

    it('And re-rendering never appends a second control to the page', async () => {
      const world = makeWorld({ events: monthEvents('a', 'job-a', 2) });
      const { doc, controller } = await startedPage(world);
      controller.renderMonth();
      controller.renderAttention();
      controller.renderMonth();

      assert.equal(doc.querySelectorAll('#job-filter').length, 1, 'a second select was built during render');
      assert.equal(doc.querySelectorAll('#job-filter-row').length, 1);
      assert.equal(optionsIn(doc).length, 3, 'a render rebuilt or appended options');
    });
  });

  describe('Scenario: The control ships inert for a page whose script never loads', () => {
    it('Given the shipped index.html parsed without running app.js, Then the row is hidden and empty', async () => {
      const response = await handler(albEvent('/calendar'), {}, {});
      assert.equal(response.statusCode, 200, 'the calendar page is not served');
      assert.match(response.body, /id="job-filter-row"/, 'the filter row does not ship in the served page');

      const doc = loadDocument(INDEX_HTML);
      const row = doc.getElementById('job-filter-row');
      assert.notEqual(row, null);
      assert.equal(row.hasAttribute('hidden'), true, 'the row does not ship with the hidden attribute');
      assert.equal(row.hidden, true);
      assert.equal(doc.getElementById('job-filter').children.length, 0, 'an <option> ships in the markup');
      assert.equal(doc.getElementById('job-filter').hidden, false, 'the select, not the wrapper, carries hidden');
    });

    it('And it sits between the calendar toolbar and the scan message', () => {
      const doc = loadDocument(INDEX_HTML);
      const siblings = doc.getElementById('job-filter-row').parentNode.children;
      const at = (predicate) => siblings.findIndex(predicate);
      assert.ok(
        at((node) => /\bcalendar-toolbar\b/.test(node.className)) < at((node) => node.getAttribute('id') === 'job-filter-row'),
        'the filter row is not after the calendar toolbar'
      );
      assert.ok(
        at((node) => node.getAttribute('id') === 'job-filter-row') < at((node) => node.getAttribute('id') === 'scan-message'),
        'the filter row is not before #scan-message'
      );
      assert.match(doc.getElementById('job-filter-row').parentNode.className, /\bcalendar-panel\b/);
    });

    it('And #attention-more still sits between the list and the empty state, as TASK-054 asserts', () => {
      const doc = loadDocument(INDEX_HTML);
      const siblings = doc.getElementById('attention-more').parentNode.children;
      const at = (id) => siblings.findIndex((node) => node.getAttribute('id') === id);
      assert.ok(at('attention-list') < at('attention-more'));
      assert.ok(at('attention-more') < at('attention-empty'));
    });
  });
});

/* =========================================================================
 * Feature: The filter control is usable on a phone
 *
 * Asserted against the bytes the Lambda actually serves. There is no CSS engine
 * and no layout in this repo - see the docblock in tests/helpers/css-text.mjs.
 * ========================================================================= */

describe('Feature: The filter control is usable on a phone', () => {
  let sheet;
  let topLevel;
  let blocks;
  let phone;

  before(async () => {
    const response = await handler(albEvent('/calendar/styles.css'), {}, {});
    assert.equal(response.statusCode, 200, 'the stylesheet is not served');
    sheet = response.body;
    topLevel = css.outsideMediaQueries(sheet);
    blocks = css.mediaBlocks(sheet);
    phone = blocks.find((block) => block.prelude === '(max-width: 600px)');
  });

  describe('Scenario: The control meets the touch-target guideline at every width', () => {
    it('Given the shipped styles.css, Then .calendar-filter__select declares min-height 44px', () => {
      assert.ok(css.rulesFor(topLevel, '.calendar-filter__select').length > 0, 'the select has no top-level rule');
      assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'min-height'), '44px');
    });

    it('And that declaration is not inside any media query', () => {
      for (const block of blocks) {
        const value = css.declaredValue(block.body, '.calendar-filter__select', 'min-height');
        if (value === null) continue;
        assert.ok(
          Number.parseFloat(value) >= 44,
          `@media ${block.prelude} shrinks the touch target to ${value}`
        );
      }
      // And the same rule the ticket points at as precedent is still there.
      assert.equal(css.declaredValue(topLevel, '.btn', 'min-height'), '44px');
    });
  });

  describe('Scenario: The control does not trigger the iOS focus zoom', () => {
    it('Given the shipped styles.css, Then .calendar-filter__select declares font: inherit', () => {
      assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'font'), 'inherit');
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        assert.equal(
          css.declaredValue(scope, '.calendar-filter__select', 'font-size'),
          null,
          'a font-size on the select is what makes iOS zoom the page on focus'
        );
      }
    });

    it('And no media query reduces the body font-size below 16px', () => {
      assert.equal(css.declaredValue(topLevel, 'body', 'font-size'), '16px');
      for (const block of blocks) {
        const value = css.declaredValue(block.body, 'body', 'font-size');
        if (value === null) continue;
        assert.ok(Number.parseFloat(value) >= 16, `@media ${block.prelude} takes the body to ${value}`);
      }
    });
  });

  describe('Scenario: A long job name cannot widen the page', () => {
    it('Given the shipped styles.css, Then the select declares max-width: 100%', () => {
      assert.equal(css.declaredValue(topLevel, '.calendar-filter__select', 'max-width'), '100%');
    });

    it('And the 600px media block sets its width to 100%', () => {
      assert.notEqual(phone, undefined, 'the 600px block is gone');
      assert.equal(css.declaredValue(phone.body, '.calendar-filter__select', 'width'), '100%');
    });

    it('And .calendar-filter declares flex-wrap: wrap, so the control wraps under its label', () => {
      const declarations = css.declarationsOf(css.rulesFor(topLevel, '.calendar-filter')[0].body);
      assert.equal(declarations['flex-wrap'], 'wrap');
      assert.equal(declarations['display'], 'flex');
      assert.equal(declarations['align-items'], 'center');
      assert.ok(declarations['gap'] !== undefined, '.calendar-filter declares no gap');
    });

    it('And the 860px block was left exactly as it was', () => {
      assert.deepEqual(blocks.map((block) => block.prelude), ['(max-width: 860px)', '(max-width: 600px)']);
      assert.equal(css.eachRule(blocks[0].body).length, 1, 'the 860px block gained or lost a rule');
      assert.equal(css.declaredValue(blocks[0].body, '.app-main', 'grid-template-columns'), 'minmax(0, 1fr)');
    });
  });

  /* --- Failure and edge paths ---------------------------------------- */

  describe('Scenario: Nothing gains a horizontal scroll region', () => {
    it('Given the shipped styles.css, Then no rule sets overflow-x on the filter, the grid or a week', () => {
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        for (const selector of [
          '.calendar-filter',
          '.calendar-filter__select',
          '.calendar-panel',
          '.calendar-grid',
          '.calendar-week',
          '.calendar-weekdays',
        ]) {
          assert.equal(
            css.declaredValue(scope, selector, 'overflow-x'),
            null,
            `${selector} was given overflow-x - a page you scroll sideways at 360px`
          );
        }
      }
    });

    it('And .calendar-week still uses repeat(7, minmax(0, 1fr))', () => {
      assert.equal(css.declaredValue(topLevel, '.calendar-week', 'grid-template-columns'), 'repeat(7, minmax(0, 1fr))');
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        const columns = css.declaredValue(scope, '.calendar-week', 'grid-template-columns');
        if (columns !== null) assert.match(columns, /repeat\(7,/);
      }
    });

    it('And [hidden] keeps its !important, which is the only reason `hidden` beats display: flex', () => {
      const value = css.declaredValue(topLevel, '[hidden]', 'display');
      assert.notEqual(value, null, 'the [hidden] rule is gone - the filter row would show while hidden');
      assert.match(value, /none\s*!important/);
    });
  });

  describe('Scenario: The stylesheet stays self-contained and no new asset appears', () => {
    it('Given the served bytes, Then there is no @import and no remote URL', () => {
      assert.equal(/@import/i.test(sheet), false, 'the stylesheet imports something');
      assert.equal(/https?:\/\//i.test(sheet), false, 'the stylesheet references a remote origin');
      assert.equal(/url\(\s*["']?\/\//i.test(sheet), false, 'the stylesheet references a protocol-relative URL');
    });

    it('And every new class named in the markup is a real rule, not a dangling name', () => {
      for (const selector of ['.calendar-filter', '.calendar-filter__label', '.calendar-filter__select']) {
        assert.ok(css.rulesFor(topLevel, selector).length > 0, `${selector} is named in index.html but unstyled`);
      }
    });

    it('And exactly five files are read across every frontend route', async () => {
      const reads = [];
      const deps = {
        readFile: (filePath) => {
          reads.push(filePath);
          return `stub:${path.basename(String(filePath))}`;
        },
        fileCache: new Map(),
        assetDir: '/fake/bundle',
      };
      for (const route of FRONTEND_ROUTES.keys()) {
        assert.equal((await handler(albEvent(route), {}, deps)).statusCode, 200, route);
      }

      assert.equal(reads.length, 5, `expected five reads, got ${reads.length} - a sixth frontend file was added`);
      assert.equal(new Set(reads).size, 5);
      const expected = new Set(Object.keys(FRONTEND_FILES).map((name) => path.join('/fake/bundle', 'frontend', name)));
      for (const filePath of reads) assert.equal(expected.has(filePath), true, `unexpected read: ${filePath}`);
    });
  });
});
