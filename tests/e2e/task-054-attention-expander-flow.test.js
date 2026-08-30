/**
 * E2E (cucumber-style) scenarios for TASK-054 - "attention list expander and
 * mobile-friendly UI".
 *
 * Given / When / Then, driven through the code that actually ships:
 *
 *   - the client scenarios run the REAL `frontend/app.js` against the REAL
 *     `frontend/index.html`, parsed by `tests/helpers/fake-dom.mjs`. The
 *     expander is STATIC markup, so a test that invented its own button would
 *     keep passing after `#attention-more` stopped shipping; parsing the real
 *     page means it does not;
 *   - the presentation scenarios pull `styles.css` and `settings.html` back
 *     THROUGH THE REAL LAMBDA HANDLER and assert on the served bytes. There is
 *     no CSS engine anywhere in this repo (see the docblock in
 *     `tests/helpers/fake-dom.mjs`), so "the 44px minimum is not nested in a
 *     media query" is a statement about the stylesheet, read with the brace
 *     matcher in `tests/helpers/css-text.mjs` - not about a rendered box.
 *
 * NO DATABASE CONNECTION IS OPENED, and none can be. The client only ever talks
 * to an injected `fetch`; there is no real `fetch` in scope in any scenario
 * below. The static routes never reach a data layer at all.
 *
 * HARNESS RULES INHERITED FROM THE TASK-010 SUITE, both load-bearing:
 *   1. `dispatch()` awaits its handlers - acknowledge and dismiss are async, and
 *      a synchronous click would assert before the fetch resolved.
 *   2. Every stubbed body is a fresh `structuredClone`. `state.attention`
 *      aliases the parsed array and the optimistic splice mutates it, so a
 *      shared array would corrupt the fixture instead of testing the code.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must precede the index.mjs import: its log level is read once at module load.
process.env.CALENDAR_LOG_LEVEL = 'none';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'frontend');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');

const { handler } = await import('../../src/lambda/calendar/index.mjs');
const app = await import('../../src/lambda/calendar/frontend/app.js');
const { loadDocument, findElements, textOf } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const XSS = '<img src=x onerror=alert(1)>';

/** Noon-ish on 15 September 2026 UTC+10 - September 2026 in every real zone. */
const NOW = Date.parse('2026-09-15T02:00:00.000Z');

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
    me: {
      connectionStatus: 'connected',
      email: 'parent@example.test',
      schoolNames: ['Ashfield Public School'],
      lastScanStatus: 'ok',
    },
    events: [],
    attention: [],
    mutationStatus: 200,
    mutationBody: { ok: true },
    ...overrides,
  };

  const reply = (status, body) => ({ status, json: async () => structuredClone(body ?? {}) });

  world.fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const requestPath = full.split('?')[0];
    world.calls.push({ path: requestPath, method: init.method || 'GET' });

    if (requestPath === '/calendar/api/auth/me') return reply(200, world.me);
    if (requestPath === '/calendar/api/events') {
      return reply(200, { events: world.events, truncated: false });
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

/* --- Fixtures --------------------------------------------------------- */

/** One pending attention row. `day` orders it: bigger day = later deadline. */
const pending = (id, day, title = `Note ${id}`) => ({
  eventId: id,
  title,
  startsAt: '2026-09-25',
  allDay: true,
  needsAttention: true,
  status: 'pending',
  actionRequired: `Do the thing for ${title}`,
  dueBy: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
});

/** `count` rows, ids a..z, SHUFFLED, so "soonest first" is the code's doing. */
function pendingList(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(pending(String.fromCharCode(97 + index), 16 + index));
  }
  return rows.slice().reverse();
}

const rowsIn = (doc) => doc.getElementById('attention-list').querySelectorAll('.attention-item');
const idsIn = (doc) => rowsIn(doc).map((row) => row.getAttribute('data-event-id'));
const visibleIds = (doc) =>
  rowsIn(doc)
    .filter((row) => row.hidden === false)
    .map((row) => row.getAttribute('data-event-id'));
const hiddenIds = (doc) =>
  rowsIn(doc)
    .filter((row) => row.hidden === true)
    .map((row) => row.getAttribute('data-event-id'));
const toggleIn = (doc) => doc.getElementById('attention-more');
const rowFor = (doc, id) => doc.getElementById('attention-list').querySelector(`[data-event-id="${id}"]`);

/* =========================================================================
 * Feature: The attention panel caps itself and offers an expander
 * ========================================================================= */

describe('Feature: The "Needs attention" panel caps its length', () => {
  describe('Scenario: The expander ships in the page, hidden, as a sibling of the list', () => {
    it('Given the served calendar page, Then #attention-more is a button outside #attention-list', async () => {
      const response = await handler(albEvent('/calendar'), {}, {});
      assert.equal(response.statusCode, 200);

      const doc = loadDocument(INDEX_HTML);
      const toggle = doc.getElementById('attention-more');
      assert.notEqual(toggle, null, '#attention-more does not ship in index.html');
      assert.equal(toggle.tagName, 'BUTTON');
      assert.equal(toggle.getAttribute('type'), 'button');
      assert.equal(toggle.hidden, true, 'the toggle must ship hidden');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(toggle.getAttribute('aria-controls'), 'attention-list');
      assert.match(toggle.className, /\bmore-toggle\b/);
      assert.match(toggle.className, /\battention-more\b/);

      const list = doc.getElementById('attention-list');
      assert.equal(list.querySelector('#attention-more'), null, 'a <button> is not valid inside a <ul>');
      assert.equal(toggle.parentNode, list.parentNode, 'the toggle is not a sibling of the list');
      assert.equal(toggle.parentNode.localName, 'aside');
    });

    it('And it sits between the list and the empty state, so the reading order is list -> more -> empty', () => {
      const doc = loadDocument(INDEX_HTML);
      const siblings = toggleIn(doc).parentNode.children;
      const at = (id) => siblings.findIndex((node) => node.getAttribute('id') === id);
      assert.ok(at('attention-list') < at('attention-more'), 'the toggle is before the list');
      assert.ok(at('attention-more') < at('attention-empty'), 'the toggle is after the empty state');
    });
  });

  describe('Scenario: A list that fits shows everything and offers nothing', () => {
    it('Given exactly five items, When the panel renders, Then all five are visible and no expander appears', async () => {
      const world = makeWorld({ attention: pendingList(5) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      assert.equal(rowsIn(doc).length, 5);
      assert.deepEqual(hiddenIds(doc), [], 'a list at the cap hid a row');
      const toggle = toggleIn(doc);
      assert.equal(toggle.hidden, true);
      assert.equal(textOf(toggle), '', 'a hidden control still carried a label');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(controller.state.attentionExpanded, false);
    });

    it('And four items do NOT trip the day-cell cap of three, proving the panel passes its own max', async () => {
      const world = makeWorld({ attention: pendingList(4) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      assert.equal(
        toggleIn(doc).hidden,
        true,
        'four items offered "Show 1 more": overflowCount was called without an explicit max and fell back to MAX_CHIPS_PER_DAY (3)'
      );
      assert.deepEqual(hiddenIds(doc), []);
      assert.equal(app.MAX_CHIPS_PER_DAY, 3, 'the discriminator above relies on the two caps differing');
      assert.equal(app.MAX_ATTENTION_ITEMS, 5);
    });
  });

  describe('Scenario: A long list is capped, soonest first, with the rest hidden but still in the DOM', () => {
    it('Given eight items out of order, When the panel renders, Then the five soonest are visible', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      assert.deepEqual(idsIn(doc), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'the panel is not sorted by dueBy');
      assert.deepEqual(visibleIds(doc), ['a', 'b', 'c', 'd', 'e'], 'the visible rows are not the soonest five');
      assert.deepEqual(hiddenIds(doc), ['f', 'g', 'h']);
      assert.equal(rowsIn(doc).length, 8, 'the overflow was dropped from the DOM instead of hidden');
      assert.equal(controller.state.attention.length, 8);
    });

    it('And each hidden row keeps its data-event-id and its actions, so nothing becomes unreachable', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      for (const id of ['f', 'g', 'h']) {
        const row = rowFor(doc, id);
        assert.notEqual(row, null, `hidden row ${id} left the DOM`);
        assert.equal(row.hidden, true);
        assert.notEqual(row.querySelector('[data-action="acknowledge"]'), null);
        assert.notEqual(row.querySelector('[data-action="dismiss"]'), null);
      }
    });

    it('And the expander appears, counting the hidden rows, collapsed', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const toggle = toggleIn(doc);
      assert.equal(toggle.hidden, false);
      assert.equal(textOf(toggle), 'Show 3 more');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(controller.state.attentionExpanded, false, 'the panel did not start collapsed');
    });
  });

  describe('Scenario: Expanding reveals everything, collapsing puts it back', () => {
    it('When the user activates "Show 3 more", Then every row is visible and the label offers the way back', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await toggleIn(doc).dispatch('click');

      assert.deepEqual(hiddenIds(doc), [], 'a row stayed hidden after expanding');
      assert.deepEqual(visibleIds(doc), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      assert.equal(textOf(toggleIn(doc)), 'Show less');
      assert.equal(toggleIn(doc).getAttribute('aria-expanded'), 'true');
      assert.equal(controller.state.attentionExpanded, true);
    });

    it('And activating it again collapses back to the capped view with the count restored', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await toggleIn(doc).dispatch('click');
      await toggleIn(doc).dispatch('click');

      assert.deepEqual(visibleIds(doc), ['a', 'b', 'c', 'd', 'e']);
      assert.deepEqual(hiddenIds(doc), ['f', 'g', 'h']);
      assert.equal(textOf(toggleIn(doc)), 'Show 3 more');
      assert.equal(toggleIn(doc).getAttribute('aria-expanded'), 'false');
      assert.equal(controller.state.attentionExpanded, false);
    });

    it('And aria-expanded is a real string attribute, not a stray boolean property', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      const raw = toggleIn(doc).getAttribute('aria-expanded');
      assert.equal(typeof raw, 'string');
      assert.equal(raw, 'true');
    });
  });

  describe('Scenario: The same handler drives both directions and is bound exactly once', () => {
    it('Given the panel has re-rendered four times, When the user clicks once, Then the panel flips once', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      // Four renders in total. If the handler were re-bound per render, one
      // click would run it an EVEN number of times and land back on collapsed.
      controller.renderAttention();
      controller.renderAttention();
      controller.renderAttention();

      const toggle = toggleIn(doc);
      assert.equal(toggle.listeners.get('click').length, 1, 'the click handler was bound more than once');

      await toggle.dispatch('click');
      assert.equal(controller.state.attentionExpanded, true, 'one click did not flip the panel exactly once');
      assert.equal(textOf(toggleIn(doc)), 'Show less');
    });

    it('And re-rendering never appends a second toggle to the page', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      controller.renderAttention();
      controller.renderAttention();

      assert.equal(doc.querySelectorAll('#attention-more').length, 1, 'a second expander was built during render');
    });
  });

  describe('Scenario: An expanded panel is not collapsed behind the user by a refresh', () => {
    it('Given the panel is expanded, When the 60s poll fires, Then it is still expanded', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, timers, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      await timers.fire();

      assert.equal(controller.state.attentionExpanded, true, 'the poll collapsed the panel');
      assert.deepEqual(hiddenIds(doc), []);
      assert.equal(textOf(toggleIn(doc)), 'Show less');
      assert.equal(toggleIn(doc).getAttribute('aria-expanded'), 'true');
    });

    it('And an explicit loadAttention leaves it expanded too', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      await controller.loadAttention();

      assert.equal(controller.state.attentionExpanded, true);
      assert.deepEqual(hiddenIds(doc), []);
    });

    it('And a successful acknowledge leaves it expanded, with the count reduced by one', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      await rowFor(doc, 'c').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.equal(controller.state.attentionExpanded, true, 'acknowledging collapsed the panel');
      assert.deepEqual(visibleIds(doc), ['a', 'b', 'd', 'e', 'f', 'g', 'h']);
      assert.deepEqual(hiddenIds(doc), []);
      assert.equal(textOf(toggleIn(doc)), 'Show less');
    });

    it('And a FAILED dismiss restores the row without collapsing the panel', async () => {
      const world = makeWorld({
        attention: pendingList(8),
        mutationStatus: 500,
        mutationBody: { error: 'Could not update the event' },
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      await rowFor(doc, 'g').querySelector('[data-action="dismiss"]').dispatch('click');

      assert.equal(controller.state.attentionExpanded, true, 'the restore path collapsed the panel');
      assert.deepEqual(idsIn(doc), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'the row came back in the wrong place');
      assert.deepEqual(hiddenIds(doc), [], 'the restored panel re-hid rows the user had revealed');
      const message = doc.getElementById('attention-message');
      assert.equal(message.hidden, false, 'the failure was swallowed');
      assert.equal(textOf(message), app.RESTORE_MESSAGE);
    });
  });

  describe('Scenario: The expander retires once there is nothing left to hide', () => {
    it('Given six expanded items, When one is acknowledged, Then the expander disappears and the state resets', async () => {
      const world = makeWorld({ attention: pendingList(6) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(textOf(toggleIn(doc)), 'Show 1 more');
      await toggleIn(doc).dispatch('click');
      assert.equal(controller.state.attentionExpanded, true);

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.equal(rowsIn(doc).length, 5);
      assert.deepEqual(hiddenIds(doc), []);
      const toggle = toggleIn(doc);
      assert.equal(toggle.hidden, true, 'the expander stayed on screen with nothing to expand');
      assert.equal(textOf(toggle), '', 'a hidden expander kept a stale "Show N more" label');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(controller.state.attentionExpanded, false, 'the expanded flag survived with nothing to hide');
    });

    /**
     * CHARACTERISATION, at the one point where two of the ticket's rules meet.
     *
     * "expanded survives the optimistic-failure restore" and "expanded resets
     * once the count drops to the cap" are in tension at EXACTLY cap + 1: the
     * optimistic splice takes six rows to five, which is the reset condition,
     * and the restore then puts the sixth back into a collapsed panel. The
     * implementation resolves it in favour of the reset. Pinned here so the
     * resolution is a decision on the record rather than an accident - and note
     * what does NOT happen: the row comes back, in order, reachable behind
     * "Show 1 more", and the failure is still reported.
     */
    it('And at exactly cap + 1, a FAILED acknowledge collapses the panel - the reset rule wins', async () => {
      const world = makeWorld({
        attention: pendingList(6),
        mutationStatus: 500,
        mutationBody: { error: 'Could not update the event' },
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');
      assert.equal(controller.state.attentionExpanded, true);

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.equal(controller.state.attentionExpanded, false);
      assert.deepEqual(idsIn(doc), ['a', 'b', 'c', 'd', 'e', 'f'], 'the row did not come back in place');
      assert.deepEqual(hiddenIds(doc), ['f'], 'the restored row is not the one behind the expander');
      assert.equal(textOf(toggleIn(doc)), 'Show 1 more', 'the row became unreachable');
      assert.equal(textOf(doc.getElementById('attention-message')), app.RESTORE_MESSAGE);
    });

    it('And a later refill comes back collapsed rather than remembering the stale choice', async () => {
      const world = makeWorld({ attention: pendingList(6) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await toggleIn(doc).dispatch('click');

      world.attention = pendingList(5);
      await controller.loadAttention();
      assert.equal(controller.state.attentionExpanded, false);

      world.attention = pendingList(8);
      await controller.loadAttention();

      assert.equal(controller.state.attentionExpanded, false);
      assert.deepEqual(hiddenIds(doc), ['f', 'g', 'h']);
      assert.equal(textOf(toggleIn(doc)), 'Show 3 more');
    });
  });

  describe('Scenario: The empty state is untouched by the cap', () => {
    it('Given nothing needs attention, Then the success empty state shows and the expander stays hidden', async () => {
      const world = makeWorld({ attention: [] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const empty = doc.getElementById('attention-empty');
      assert.equal(empty.hidden, false);
      assert.match(empty.className, /empty-state--success/);
      assert.match(textOf(empty), /caught up/i);
      assert.equal(toggleIn(doc).hidden, true);
      assert.equal(textOf(toggleIn(doc)), '');
    });

    it('And a non-empty capped list keeps the empty state hidden', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(doc.getElementById('attention-empty').hidden, true);
    });
  });

  /* --- failure / hostile-input path ---------------------------------- */

  describe('Scenario: A hostile title hidden behind the expander is still only text when revealed', () => {
    it('Given the last of seven items has a script-shaped title, Then revealing it injects nothing', async () => {
      const rows = pendingList(7);
      const hostile = rows.find((row) => row.eventId === 'g');
      hostile.title = XSS;
      hostile.actionRequired = XSS;

      const world = makeWorld({ attention: rows });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const row = rowFor(doc, 'g');
      assert.equal(row.hidden, true, 'the hostile row was meant to start hidden');
      assert.deepEqual(findElements(doc, 'img'), [], 'an element was injected while hidden');

      await toggleIn(doc).dispatch('click');

      // Re-queried, not reused: renderAttention rebuilds the list from scratch,
      // so the pre-click node is detached and would report a stale `hidden`.
      const revealed = rowFor(doc, 'g');
      assert.equal(revealed.hidden, false, 'the hostile row did not come back into view');
      assert.equal(textOf(revealed.querySelector('.attention-title')), XSS);
      assert.equal(revealed.querySelector('.attention-title').childNodes.length, 1, 'the title parsed into more than one node');
      assert.deepEqual(findElements(doc, 'img'), [], 'revealing the row injected an element');
      // Scoped to the list: the page legitimately loads /calendar/app.js with a
      // <script> of its own, so a document-wide count would prove nothing.
      assert.deepEqual(findElements(doc.getElementById('attention-list'), 'script'), []);
    });

    it('And the expander label itself is text, built from a number - never markup', async () => {
      const rows = pendingList(8);
      const world = makeWorld({ attention: rows });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const toggle = toggleIn(doc);
      assert.equal(toggle.childNodes.length, 1, 'the label is more than one node - markup was assembled');
      assert.equal(toggle.childNodes[0].nodeType, 3, 'the label is not a text node');
      assert.equal(toggle.childNodes[0].data, 'Show 3 more');
    });
  });

  /* --- edge cases on the injected cap -------------------------------- */

  describe('Scenario Outline: A nonsense maxAttentionItems falls back to five rather than breaking the panel', () => {
    const NONSENSE = [
      ['zero', 0],
      ['negative', -3],
      ['non-integer', 2.5],
      ['a string', '2'],
      ['NaN', Number.NaN],
      ['null', null],
      ['undefined', undefined],
    ];

    for (const [label, value] of NONSENSE) {
      it(`Given maxAttentionItems is ${label}, When eight items render, Then five are visible`, async () => {
        const world = makeWorld({ attention: pendingList(8) });
        const { doc, controller } = openCalendar(world, { maxAttentionItems: value });
        await controller.start();

        assert.deepEqual(visibleIds(doc), ['a', 'b', 'c', 'd', 'e'], `maxAttentionItems ${label} was honoured`);
        assert.equal(textOf(toggleIn(doc)), 'Show 3 more');
      });
    }

    it('And a valid integer cap IS honoured', async () => {
      const world = makeWorld({ attention: pendingList(8) });
      const { doc, controller } = openCalendar(world, { maxAttentionItems: 2 });
      await controller.start();

      assert.deepEqual(visibleIds(doc), ['a', 'b']);
      assert.equal(textOf(toggleIn(doc)), 'Show 6 more');

      await toggleIn(doc).dispatch('click');
      assert.deepEqual(hiddenIds(doc), []);
    });
  });
});

/* =========================================================================
 * Feature: The served stylesheet is usable on a phone
 * ========================================================================= */

describe('Feature: The served stylesheet is usable on a phone', () => {
  let sheet;
  let topLevel;
  let blocks;

  before(async () => {
    const response = await handler(albEvent('/calendar/styles.css'), {}, {});
    assert.equal(response.statusCode, 200, 'the stylesheet is not served');
    sheet = response.body;
    topLevel = css.outsideMediaQueries(sheet);
    blocks = css.mediaBlocks(sheet);
  });

  describe('Scenario: Touch targets are 44px at every width, not only on a phone', () => {
    for (const selector of ['.btn', '.btn-link', '.btn-small', '.more-toggle', '.nav-link']) {
      it(`Given the served stylesheet, Then ${selector} declares min-height: 44px outside any media query`, () => {
        const rules = css.rulesFor(topLevel, selector);
        assert.ok(rules.length > 0, `${selector} has no top-level rule at all`);
        assert.equal(
          css.declaredValue(topLevel, selector, 'min-height'),
          '44px',
          `${selector} does not declare a 44px minimum outside a media query`
        );
      });
    }

    it('And no media query shrinks one of them back below 44px', () => {
      for (const block of blocks) {
        for (const selector of ['.btn', '.btn-link', '.btn-small', '.more-toggle', '.nav-link']) {
          const value = css.declaredValue(block.body, selector, 'min-height');
          if (value === null) continue;
          const pixels = Number.parseFloat(value);
          assert.ok(
            Number.isFinite(pixels) && pixels >= 44,
            `@media ${block.prelude} shrinks ${selector} to ${value}`
          );
        }
      }
    });

    it('And native radios and checkboxes get a 24px minimum, their labels carrying the large hit area', () => {
      for (const selector of ['input[type="radio"]', 'input[type="checkbox"]']) {
        assert.equal(css.declaredValue(topLevel, selector, 'min-width'), '24px', selector);
        assert.equal(css.declaredValue(topLevel, selector, 'min-height'), '24px', selector);
      }
    });
  });

  describe('Scenario: The chip is a documented exception to the 44px rule', () => {
    it('Given .chip, Then it declares a smaller minimum than 44px', () => {
      const value = css.declaredValue(topLevel, '.chip', 'min-height');
      assert.equal(value, '28px', '.chip does not declare the documented 28px minimum');
      assert.ok(Number.parseFloat(value) < 44);
    });

    it('And a comment near the rule explains WHY, so it does not read as an oversight', () => {
      const at = sheet.indexOf('\n.chip {');
      assert.notEqual(at, -1, 'no top-level .chip rule found in the served sheet');
      const preamble = sheet.slice(Math.max(0, at - 700), at);
      const comment = preamble.slice(preamble.lastIndexOf('/*'));
      assert.ok(comment.startsWith('/*'), 'the .chip rule has no comment above it');
      assert.match(comment, /exception/i, 'the comment above .chip does not name it as an exception');
      assert.match(comment, /44px/, 'the comment above .chip does not reference the rule it is excepted from');
    });
  });

  describe('Scenario: The phone breakpoint is added after, not instead of, the existing one', () => {
    it('Given the served stylesheet, Then both breakpoints exist and 860px comes first', () => {
      const preludes = blocks.map((block) => block.prelude);
      assert.deepEqual(
        preludes,
        ['(max-width: 860px)', '(max-width: 600px)'],
        'the breakpoints are missing, reordered, or joined by an unexpected third'
      );
      assert.ok(blocks[0].start < blocks[1].start);
      assert.ok(blocks[0].end < blocks[1].start, 'the 600px block is nested inside the 860px one');
    });

    it('And the 860px block still does the one thing it did before: collapse app-main to one column', () => {
      const rules = css.rulesFor(blocks[0].body, '.app-main');
      assert.equal(rules.length, 1, 'the 860px block no longer contains exactly one .app-main rule');
      assert.equal(
        css.declaredValue(blocks[0].body, '.app-main', 'grid-template-columns'),
        'minmax(0, 1fr)',
        'the 860px single-column rule was disturbed'
      );
      assert.equal(css.eachRule(blocks[0].body).length, 1, 'rules were added to the 860px block');
    });

    it('And the 600px block reclaims padding rather than reflowing the layout', () => {
      const body = blocks[1].body;
      for (const selector of ['.app-header', '.app-main', '.panel', '.day-cell']) {
        assert.ok(css.rulesFor(body, selector).length > 0, `${selector} is not tuned at 600px`);
      }
      assert.equal(css.declaredValue(body, '.toolbar-actions', 'width'), '100%');
    });
  });

  describe('Scenario: The month grid stays a month grid', () => {
    it('Given any width, Then the calendar keeps seven columns and never scrolls sideways', () => {
      // A week - and the weekday header above it - is the seven-column grid.
      // `.calendar-grid` is the single-column stack the weeks sit in, so it is
      // asserted for overflow only.
      for (const selector of ['.calendar-week', '.calendar-weekdays']) {
        assert.equal(
          css.declaredValue(topLevel, selector, 'grid-template-columns'),
          'repeat(7, minmax(0, 1fr))',
          `${selector} is no longer a seven-column grid`
        );
      }
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        for (const selector of ['.calendar-grid', '.calendar-week', '.calendar-weekdays']) {
          assert.equal(
            css.declaredValue(scope, selector, 'overflow-x'),
            null,
            `${selector} was given overflow-x - a month you scroll sideways is not a month you can read`
          );
        }
        for (const selector of ['.calendar-week', '.calendar-weekdays']) {
          const columns = css.declaredValue(scope, selector, 'grid-template-columns');
          if (columns !== null) assert.match(columns, /repeat\(7,/, `${selector} stopped being seven columns`);
        }
      }
      assert.equal(css.declaredValue(topLevel, '.calendar-grid', 'grid-template-columns'), 'minmax(0, 1fr)');
    });
  });

  describe('Scenario: Nothing shrinks type into an iOS zoom-on-focus', () => {
    it('Given every scope in the sheet, Then no rule takes the body below 16px', () => {
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        const value = css.declaredValue(scope, 'body', 'font-size');
        if (value === null) continue;
        assert.match(value, /^16px$/, `the body font-size was changed to ${value}`);
      }
      assert.equal(css.declaredValue(topLevel, 'body', 'font-size'), '16px');
    });

    it('And .field-input keeps `font: inherit` and is never given a font-size of its own', () => {
      assert.equal(css.declaredValue(topLevel, '.field-input', 'font'), 'inherit');
      for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
        assert.equal(
          css.declaredValue(scope, '.field-input', 'font-size'),
          null,
          'a font-size on .field-input is what makes iOS zoom the page on focus'
        );
      }
    });
  });

  describe('Scenario: The stylesheet still pulls in nothing from the internet', () => {
    it('Given the served bytes, Then there is no @import and no remote URL', () => {
      assert.equal(/@import/i.test(sheet), false, 'the stylesheet imports something');
      assert.equal(/https?:\/\//i.test(sheet), false, 'the stylesheet references a remote origin');
      assert.equal(/url\(\s*["']?\/\//i.test(sheet), false, 'the stylesheet references a protocol-relative URL');
    });

    it('And the newly styled settings sections are real rules, not dangling class names', () => {
      for (const selector of ['.settings__section', '.disconnect__choice', '.disconnect__option', '.disconnect__confirm', '.attention-more']) {
        assert.ok(css.rulesFor(topLevel, selector).length > 0, `${selector} is named in markup but unstyled`);
      }
    });
  });
});

/* =========================================================================
 * Feature: The disconnect controls join the design system without regressing
 * ========================================================================= */

describe('Feature: The disconnect controls are styled without regressing the guard', () => {
  let html;

  before(async () => {
    const response = await handler(albEvent('/calendar/settings'), {}, {});
    assert.equal(response.statusCode, 200);
    html = response.body;
  });

  /** The raw `<button ...>` open tag carrying the given id. */
  const openTagFor = (source, id) => {
    const at = source.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, `#${id} does not ship in the served page`);
    return source.slice(source.lastIndexOf('<', at), source.indexOf('>', at) + 1);
  };

  it('Given the served settings page, Then #disconnect-submit is a .btn and NOT a .btn-primary', () => {
    const tag = openTagFor(html, 'disconnect-submit');
    assert.match(tag, /class="btn"/, 'the disconnect button did not join the design system');
    assert.equal(/btn-primary/.test(tag), false, 'a destructive action must not be styled as the primary one');
  });

  it('And it STILL ships disabled, in the same relative position the existing guards slice on', () => {
    const submit = html.slice(html.indexOf('id="disconnect-submit"'));
    assert.ok(
      /disabled/.test(submit.slice(0, submit.indexOf('</button>'))),
      'a page whose script never loads could now submit an unconfirmed disconnect'
    );
  });

  it('And the confirmation input joined the field styling', () => {
    assert.match(openTagFor(html, 'disconnect-confirm'), /class="field-input"/);
  });

  it('And settings.js was not dragged into this change', async () => {
    const response = await handler(albEvent('/calendar/settings.js'), {}, {});
    assert.equal(response.statusCode, 200);
    assert.equal(/attention-more|attentionExpanded|maxAttentionItems/.test(response.body), false,
      'settings.js grew attention-panel logic that belongs in app.js');
    assert.match(response.body, /disconnect-submit/, 'settings.js stopped wiring the disconnect submit');
  });
});
