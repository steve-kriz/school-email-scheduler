/**
 * UNIT tests for TASK-054 - "attention list expander and mobile-friendly UI".
 *
 * Scope of this file: the units, in isolation. No page is started, no `fetch`
 * is ever called (the injected one THROWS, so a test that accidentally reached
 * the network would fail loudly rather than quietly pass), and no timer runs.
 *
 *   - `MAX_ATTENTION_ITEMS` and the `overflowCount` contract it is fed to;
 *   - `createCalendarApp`'s validation of `options.maxAttentionItems`;
 *   - `renderAttention` and `toggleAttentionExpanded` driven DIRECTLY off
 *     `controller.state`, against a minimal parsed panel - including the two
 *     degenerate documents (no list, no toggle) that the guards in the code
 *     exist for;
 *   - `tests/helpers/css-text.mjs` itself. That helper is what underwrites
 *     every "outside a media query" claim in the e2e file, so it is tested
 *     against synthetic stylesheets that would fool a regex - otherwise the
 *     CSS scenarios are only as trustworthy as an untested reader.
 *
 * NO DATABASE IS TOUCHED, and none is mocked either, because nothing on these
 * paths reaches one. The frontend module talks only to an injected `fetch`.
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/task-054-attention-expander-flow.test.js`.
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
const { parseHtml, textOf } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const APP_JS = fs.readFileSync(path.join(FRONTEND_DIR, 'app.js'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf-8');
const SETTINGS_HTML = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf-8');
const STYLES_CSS = fs.readFileSync(path.join(FRONTEND_DIR, 'styles.css'), 'utf-8');

const NOW = Date.parse('2026-09-15T02:00:00.000Z');

/**
 * The smallest document `renderAttention` can be driven against.
 *
 * Hand-written on purpose HERE (unlike the e2e file, which parses the shipped
 * page): these tests are about the function's behaviour given a panel, and
 * `omit` lets a scenario take a required node away to exercise a guard.
 */
function makePanel({ omit = [] } = {}) {
  const parts = [
    '<p id="attention-message" hidden></p>',
    '<ul id="attention-list"></ul>',
    '<button id="attention-more" type="button" hidden aria-expanded="false"></button>',
    '<p id="attention-empty" hidden></p>',
  ].filter((part) => !omit.some((id) => part.includes(`id="${id}"`)));
  return parseHtml(`<html><body><main>${parts.join('')}</main></body></html>`);
}

/** A controller with nothing running: no fetch, no timers, no start(). */
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

/** `count` pending rows, already in soonest-first order. */
const pendingList = (count) =>
  Array.from({ length: count }, (unused, index) => ({
    eventId: String.fromCharCode(97 + index),
    title: `Note ${index}`,
    startsAt: '2026-09-25',
    allDay: true,
    needsAttention: true,
    status: 'pending',
    dueBy: `2026-09-${String(16 + index).padStart(2, '0')}T00:00:00.000Z`,
  }));

const rows = (doc) => doc.getElementById('attention-list').querySelectorAll('.attention-item');
const hiddenFlags = (doc) => rows(doc).map((row) => row.hidden);

/**
 * The body of one function in a source file, found by matching braces.
 *
 * Brace matching rather than "slice to the next `\n  }\n`": this repo is
 * checked out with CRLF endings, so an indentation-and-newline heuristic finds
 * nothing, slices to the end of the file, and turns a "renderAttention must not
 * bind listeners" assertion into a "app.js must not contain addEventListener"
 * assertion - which is a different, and false, claim.
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

/* ========================================================================= */

describe('TASK-054 unit: the attention cap constant', () => {
  it('exports MAX_ATTENTION_ITEMS as 5, alongside MAX_CHIPS_PER_DAY', () => {
    assert.equal(app.MAX_ATTENTION_ITEMS, 5);
    assert.equal(Number.isInteger(app.MAX_ATTENTION_ITEMS), true);
    assert.equal(app.MAX_CHIPS_PER_DAY, 3, 'the day-cell cap changed - the two caps must stay distinct');
    assert.notEqual(
      app.MAX_ATTENTION_ITEMS,
      app.MAX_CHIPS_PER_DAY,
      'the two caps became equal, which would make every "used the right max" test vacuous'
    );
  });
});

describe('TASK-054 unit: overflowCount is reused unmodified', () => {
  it('still answers the day-cell questions it answered before', () => {
    assert.equal(app.overflowCount(0, 3), 0);
    assert.equal(app.overflowCount(3, 3), 0);
    assert.equal(app.overflowCount(4, 3), 1);
    assert.equal(app.overflowCount(9, 3), 6);
  });

  it('answers the panel questions when given the panel cap explicitly', () => {
    assert.equal(app.overflowCount(4, 5), 0);
    assert.equal(app.overflowCount(5, 5), 0);
    assert.equal(app.overflowCount(6, 5), 1);
    assert.equal(app.overflowCount(8, 5), 3);
  });

  it('and its OWN fallback is still 3, which is why the caller must pass a max', () => {
    // This is the trap the panel has to avoid: called without a usable max,
    // overflowCount reports 1 overflowing row out of 4 - the day-cell answer.
    for (const badMax of [undefined, null, 0, -1, Number.NaN, 'five']) {
      assert.equal(app.overflowCount(4, badMax), 1, `overflowCount(4, ${String(badMax)})`);
      assert.equal(app.overflowCount(4, badMax), app.overflowCount(4, app.MAX_CHIPS_PER_DAY));
    }
  });

  it('treats a nonsense total as zero rather than throwing', () => {
    for (const badTotal of [undefined, null, Number.NaN, 'six']) {
      assert.equal(app.overflowCount(badTotal, 5), 0, `overflowCount(${String(badTotal)}, 5)`);
    }
  });
});

describe('TASK-054 unit: createCalendarApp validates options.maxAttentionItems', () => {
  it('starts with attentionExpanded false, as a real property of the state', () => {
    const controller = makeController(makePanel());
    assert.equal(controller.state.attentionExpanded, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(controller.state, 'attentionExpanded'),
      true,
      'attentionExpanded is not part of the state object'
    );
  });

  it('uses an integer greater than zero', () => {
    for (const value of [1, 2, 7, 50]) {
      const doc = makePanel();
      const controller = makeController(doc, { maxAttentionItems: value });
      controller.state.attention = pendingList(50);
      controller.renderAttention();
      assert.equal(
        rows(doc).filter((row) => row.hidden === false).length,
        value,
        `maxAttentionItems ${value} was not honoured`
      );
    }
  });

  it('falls back to 5 for anything else', () => {
    const NONSENSE = [0, -1, -5, 2.5, 0.5, '5', '', true, false, null, undefined, Number.NaN, Infinity, [], {}];
    for (const value of NONSENSE) {
      const doc = makePanel();
      const controller = makeController(doc, { maxAttentionItems: value });
      controller.state.attention = pendingList(9);
      controller.renderAttention();
      assert.equal(
        rows(doc).filter((row) => row.hidden === false).length,
        app.MAX_ATTENTION_ITEMS,
        `maxAttentionItems ${JSON.stringify(value) ?? String(value)} did not fall back to 5`
      );
    }
  });

  it('validates it exactly the way maxChipsPerDay is validated', () => {
    // Same predicate, so the two options cannot drift apart silently.
    assert.match(
      APP_JS,
      /Number\.isInteger\(options\.maxAttentionItems\)\s*&&\s*options\.maxAttentionItems\s*>\s*0/,
      'maxAttentionItems is not validated with the integer-greater-than-zero predicate'
    );
    assert.match(APP_JS, /Number\.isInteger\(options\.maxChipsPerDay\)\s*&&\s*options\.maxChipsPerDay\s*>\s*0/);
  });
});

describe('TASK-054 unit: renderAttention caps, hides and labels', () => {
  const render = (count, options = {}) => {
    const doc = makePanel();
    const controller = makeController(doc, options);
    controller.state.attention = pendingList(count);
    controller.renderAttention();
    return { doc, controller, toggle: doc.getElementById('attention-more') };
  };

  it('hides nothing at or below the cap', () => {
    for (const count of [0, 1, 4, 5]) {
      const { doc, toggle } = render(count);
      assert.equal(rows(doc).length, count);
      assert.deepEqual(hiddenFlags(doc), new Array(count).fill(false), `${count} items`);
      assert.equal(toggle.hidden, true, `${count} items showed an expander`);
      assert.equal(textOf(toggle), '', `${count} items left a label on a hidden expander`);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    }
  });

  it('hides every row past the cap while leaving it in the DOM', () => {
    const { doc, toggle } = render(9);
    assert.equal(rows(doc).length, 9, 'rows were dropped rather than hidden');
    assert.deepEqual(hiddenFlags(doc), [false, false, false, false, false, true, true, true, true]);
    assert.deepEqual(
      rows(doc).map((row) => row.getAttribute('data-event-id')),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      'a hidden row lost its data-event-id'
    );
    assert.equal(toggle.hidden, false);
    assert.equal(textOf(toggle), 'Show 4 more');
  });

  it('labels the expander with the exact overflow count', () => {
    for (const [count, label] of [[6, 'Show 1 more'], [7, 'Show 2 more'], [25, 'Show 20 more']]) {
      const { toggle } = render(count);
      assert.equal(textOf(toggle), label);
    }
  });

  it('drives the empty state off the total, not the visible count', () => {
    assert.equal(render(0).doc.getElementById('attention-empty').hidden, false);
    for (const count of [1, 5, 9]) {
      assert.equal(
        render(count).doc.getElementById('attention-empty').hidden,
        true,
        `${count} items but the empty state showed`
      );
    }
  });

  it('builds the label as a single text node - no markup is assembled', () => {
    const { toggle } = render(9);
    assert.equal(toggle.childNodes.length, 1);
    assert.equal(toggle.childNodes[0].nodeType, 3, 'the expander label is not a text node');
    assert.equal(toggle.children.length, 0, 'the expander label contains an element');
  });

  it('sets aria-expanded as a string attribute both ways', () => {
    const { controller, toggle } = render(9);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
    controller.toggleAttentionExpanded();
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
    controller.toggleAttentionExpanded();
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  });
});

describe('TASK-054 unit: toggleAttentionExpanded', () => {
  it('is exposed on the controller', () => {
    const controller = makeController(makePanel());
    assert.equal(typeof controller.toggleAttentionExpanded, 'function');
  });

  it('flips the state, re-renders and returns the new value', () => {
    const doc = makePanel();
    const controller = makeController(doc);
    controller.state.attention = pendingList(9);
    controller.renderAttention();

    assert.equal(controller.toggleAttentionExpanded(), true);
    assert.equal(controller.state.attentionExpanded, true);
    assert.deepEqual(hiddenFlags(doc), new Array(9).fill(false));
    assert.equal(textOf(doc.getElementById('attention-more')), 'Show less');

    assert.equal(controller.toggleAttentionExpanded(), false);
    assert.equal(controller.state.attentionExpanded, false);
    assert.equal(hiddenFlags(doc).filter(Boolean).length, 4);
    assert.equal(textOf(doc.getElementById('attention-more')), 'Show 4 more');
  });

  /* --- edge / failure paths ---------------------------------------- */

  it('is a no-op when there is nothing to expand, rather than latching a stale flag', () => {
    const doc = makePanel();
    const controller = makeController(doc);
    controller.state.attention = pendingList(3);
    controller.renderAttention();

    assert.equal(controller.toggleAttentionExpanded(), false, 'the flag latched on with nothing to reveal');
    assert.equal(controller.state.attentionExpanded, false);
    assert.equal(doc.getElementById('attention-more').hidden, true);
    assert.equal(textOf(doc.getElementById('attention-more')), '');
  });

  it('resets the flag the moment the list drops back to the cap', () => {
    const doc = makePanel();
    const controller = makeController(doc);
    controller.state.attention = pendingList(6);
    controller.renderAttention();
    controller.toggleAttentionExpanded();
    assert.equal(controller.state.attentionExpanded, true);

    controller.state.attention = pendingList(5);
    controller.renderAttention();

    assert.equal(controller.state.attentionExpanded, false, 'the expanded flag survived with nothing to hide');
    assert.equal(doc.getElementById('attention-more').hidden, true);
    assert.equal(textOf(doc.getElementById('attention-more')), '');
    assert.deepEqual(hiddenFlags(doc), new Array(5).fill(false));
  });

  it('keeps the flag while rows are still hidden, however many times it re-renders', () => {
    const doc = makePanel();
    const controller = makeController(doc);
    controller.state.attention = pendingList(9);
    controller.renderAttention();
    controller.toggleAttentionExpanded();

    for (let turn = 0; turn < 10; turn += 1) controller.renderAttention();

    assert.equal(controller.state.attentionExpanded, true, 're-rendering collapsed the panel');
    assert.deepEqual(hiddenFlags(doc), new Array(9).fill(false));
  });

  it('renders without a #attention-more in the document instead of throwing', () => {
    const doc = makePanel({ omit: ['attention-more'] });
    const controller = makeController(doc);
    controller.state.attention = pendingList(9);
    assert.doesNotThrow(() => controller.renderAttention());
    assert.equal(rows(doc).length, 9, 'the list stopped rendering because the toggle was missing');
    assert.doesNotThrow(() => controller.toggleAttentionExpanded());
  });

  it('renders without a #attention-list in the document instead of throwing', () => {
    const doc = makePanel({ omit: ['attention-list'] });
    const controller = makeController(doc);
    controller.state.attention = pendingList(9);
    assert.doesNotThrow(() => controller.renderAttention());
    // The toggle is driven off the DATA, not off the list, so it still reports.
    assert.equal(textOf(doc.getElementById('attention-more')), 'Show 4 more');
  });

  it('tolerates malformed rows in state.attention', () => {
    const doc = makePanel();
    const controller = makeController(doc);
    controller.state.attention = [...pendingList(5), null, undefined, {}, { eventId: 'z' }];
    assert.doesNotThrow(() => controller.renderAttention());
    assert.equal(rows(doc).length, 9);
    assert.equal(doc.getElementById('attention-more').hidden, false);
  });
});

describe('TASK-054 unit: the shipped markup and source', () => {
  it('ships the expander as a sibling AFTER the closing </ul>, never inside it', () => {
    const list = INDEX_HTML.indexOf('<ul id="attention-list"');
    const closeList = INDEX_HTML.indexOf('</ul>', list);
    const toggle = INDEX_HTML.indexOf('id="attention-more"');
    const empty = INDEX_HTML.indexOf('id="attention-empty"');
    assert.notEqual(toggle, -1, '#attention-more does not ship');
    assert.ok(closeList < toggle, 'the expander is inside the <ul>, which is invalid markup');
    assert.ok(toggle < empty, 'the expander ships after the empty state');
  });

  it('ships it hidden, typed, and wired to the list for assistive tech', () => {
    const tag = INDEX_HTML.slice(
      INDEX_HTML.lastIndexOf('<', INDEX_HTML.indexOf('id="attention-more"')),
      INDEX_HTML.indexOf('>', INDEX_HTML.indexOf('id="attention-more"')) + 1
    );
    assert.match(tag, /^<button\b/);
    assert.match(tag, /type="button"/, 'an untyped button inside a form would submit it');
    assert.match(tag, /\bhidden\b/, 'the expander does not ship hidden');
    assert.match(tag, /aria-expanded="false"/);
    assert.match(tag, /aria-controls="attention-list"/);
    assert.match(tag, /class="[^"]*\bmore-toggle\b[^"]*"/);
    assert.match(tag, /class="[^"]*\battention-more\b[^"]*"/);
  });

  it('binds the toggle exactly once, in bindControls and nowhere else', () => {
    const occurrences = APP_JS.match(/bind\("attention-more"/g) || [];
    assert.equal(occurrences.length, 1, 'the toggle is bound in more than one place');

    assert.match(
      functionBody(APP_JS, 'function bindControls()'),
      /bind\("attention-more"/,
      'the toggle is not bound in bindControls'
    );

    // The signature carries its parens, so the search does not land on
    // `renderAttentionItem`, which legitimately DOES bind per-row handlers.
    const renderBody = functionBody(APP_JS, 'function renderAttention()');
    assert.equal(
      /addEventListener/.test(renderBody),
      false,
      'renderAttention adds a listener - it runs on every poll, so handlers would stack'
    );
    assert.equal(
      /createElement|el\(doc, "button"/.test(renderBody),
      false,
      'renderAttention builds a button - the expander is static markup'
    );
  });

  it('assembles no markup anywhere in app.js', () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
      assert.equal(APP_JS.includes(forbidden), false, `app.js uses ${forbidden}`);
    }
  });

  it('leaves the #disconnect-submit raw-source shape the existing guards slice on', () => {
    const submit = SETTINGS_HTML.slice(SETTINGS_HTML.indexOf('id="disconnect-submit"'));
    const tag = submit.slice(0, submit.indexOf('</button>'));
    assert.match(tag, /disabled/, 'disabled no longer follows the id in the raw source');
    const openTag = SETTINGS_HTML.slice(
      SETTINGS_HTML.lastIndexOf('<', SETTINGS_HTML.indexOf('id="disconnect-submit"')),
      SETTINGS_HTML.indexOf('>', SETTINGS_HTML.indexOf('id="disconnect-submit"')) + 1
    );
    assert.match(openTag, /class="btn"/);
    assert.equal(/btn-primary/.test(openTag), false);
  });
});

/* =========================================================================
 * The CSS reader that underwrites the e2e presentation scenarios
 * ========================================================================= */

describe('TASK-054 unit: tests/helpers/css-text.mjs', () => {
  it('blanks comments without moving anything else', () => {
    const source = 'a {\n/* min-height: 44px in prose */\n  color: red;\n}';
    const stripped = css.stripComments(source);
    assert.equal(stripped.length, source.length, 'offsets moved, so block ordering could not be trusted');
    assert.equal(stripped.includes('44px'), false, 'a comment mentioning the rule was left in');
    assert.equal(stripped.split('\n').length, source.split('\n').length);
    assert.match(stripped, /color: red;/);
  });

  it('would NOT credit a 44px that only exists in a comment', () => {
    const sheet = '/* .btn should be min-height: 44px */\n.btn { color: red; }';
    assert.equal(css.declaredValue(css.outsideMediaQueries(sheet), '.btn', 'min-height'), null);
  });

  it('would NOT credit a 44px nested inside a media query', () => {
    const sheet = '.btn { color: red; }\n@media (max-width: 600px) { .btn { min-height: 44px; } }';
    assert.equal(
      css.declaredValue(css.outsideMediaQueries(sheet), '.btn', 'min-height'),
      null,
      'a media-query-only rule was reported as applying at every width'
    );
    assert.equal(css.declaredValue(css.mediaBlocks(sheet)[0].body, '.btn', 'min-height'), '44px');
  });

  it('matches selectors exactly, so .btn is not answered by .btn-small', () => {
    const sheet = '.btn-small { min-height: 44px; }';
    assert.equal(css.declaredValue(sheet, '.btn', 'min-height'), null);
    assert.equal(css.declaredValue(sheet, '.btn-small', 'min-height'), '44px');
  });

  it('finds a selector inside a comma-separated list', () => {
    const sheet = '.a,\n.b { min-height: 44px; }';
    assert.equal(css.declaredValue(sheet, '.b', 'min-height'), '44px');
  });

  it('reports top-level media blocks in source order and does not recurse into them', () => {
    const sheet = 'a{}\n@media (max-width: 860px){ .x{} }\n@media (max-width: 600px){ @media print { .y{} } }';
    const blocks = css.mediaBlocks(sheet);
    assert.deepEqual(blocks.map((block) => block.prelude), ['(max-width: 860px)', '(max-width: 600px)']);
    assert.ok(blocks[0].end < blocks[1].start);
  });

  it('takes the last declaration when a property is declared twice, as the cascade would', () => {
    assert.equal(css.declaredValue('.a { min-height: 20px; }\n.a { min-height: 44px; }', '.a', 'min-height'), '44px');
  });
});

describe('TASK-054 unit: styles.css read as text', () => {
  const topLevel = css.outsideMediaQueries(STYLES_CSS);
  const blocks = css.mediaBlocks(STYLES_CSS);

  it('gives every button-shaped control a 44px minimum at every width', () => {
    for (const selector of ['.btn', '.btn-link', '.btn-small', '.more-toggle', '.nav-link']) {
      assert.equal(css.declaredValue(topLevel, selector, 'min-height'), '44px', selector);
    }
  });

  it('excepts .chip at 28px, and says why in a comment above the rule', () => {
    assert.equal(css.declaredValue(topLevel, '.chip', 'min-height'), '28px');
    const at = STYLES_CSS.indexOf('\n.chip {');
    const comment = STYLES_CSS.slice(0, at).slice(STYLES_CSS.slice(0, at).lastIndexOf('/*'));
    assert.match(comment, /EXCEPTION/i);
    assert.match(comment, /44px/);
  });

  it('appends the 600px breakpoint after the untouched 860px one', () => {
    assert.deepEqual(blocks.map((block) => block.prelude), ['(max-width: 860px)', '(max-width: 600px)']);
    assert.equal(css.eachRule(blocks[0].body).length, 1, 'the 860px block gained or lost a rule');
    assert.equal(css.declaredValue(blocks[0].body, '.app-main', 'grid-template-columns'), 'minmax(0, 1fr)');
  });

  it('never shrinks the base type or gives .field-input a size of its own', () => {
    assert.equal(css.declaredValue(topLevel, 'body', 'font-size'), '16px');
    assert.equal(css.declaredValue(topLevel, '.field-input', 'font'), 'inherit');
    for (const block of blocks) {
      assert.equal(css.declaredValue(block.body, 'body', 'font-size'), null, `@media ${block.prelude} resizes the body`);
      assert.equal(css.declaredValue(block.body, '.field-input', 'font-size'), null);
    }
  });

  it('never gives the month grid a sideways scroll', () => {
    for (const scope of [topLevel, ...blocks.map((block) => block.body)]) {
      for (const selector of ['.calendar-grid', '.calendar-week', '.calendar-weekdays']) {
        assert.equal(css.declaredValue(scope, selector, 'overflow-x'), null, selector);
      }
    }
    assert.equal(css.declaredValue(topLevel, '.calendar-week', 'grid-template-columns'), 'repeat(7, minmax(0, 1fr))');
  });

  it('pulls in nothing from the internet', () => {
    assert.equal(/@import/i.test(STYLES_CSS), false);
    assert.equal(/https?:\/\//i.test(STYLES_CSS), false);
  });
});
