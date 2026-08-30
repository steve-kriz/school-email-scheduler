/**
 * E2E (cucumber-style) scenario for TASK-010:
 *
 *   Scenario: All-day events do not shift across the date line
 *     Given an event with a date-only startsAt of 2026-09-04
 *     And a browser timezone of "America/Denver"
 *     When the calendar renders
 *     Then the event appears on 2026-09-04
 *
 * This is a whole-page scenario, not a helper test: the REAL `frontend/app.js`
 * renders the REAL `frontend/index.html` into the DOM stand-in, and the
 * assertion is made on the day cell the chip actually landed in.
 *
 * THE ZONE IS SET IN-PROCESS, BEFORE app.js IS IMPORTED. `TZ=... node` is
 * ignored on the machine this repo is developed on, so a scenario that set the
 * zone on the command line would quietly run in Australia/Sydney - where the
 * assertion is already true for the wrong reason - and would prove nothing about
 * a user west of UTC. `node --test` gives each file its own process, so nothing
 * here leaks into another file.
 *
 * No database is touched: the page talks only to the injected fetch below.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Denver: UTC-6 in September. Set before the app.js import below. */
process.env.TZ = 'America/Denver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'frontend', 'index.html');

const app = await import('../../src/lambda/calendar/frontend/app.js');
const { loadDocument, textOf } = await import('../helpers/fake-dom.mjs');

/** Midday on 15 September 2026 in Denver, so the view opens on September 2026. */
const NOW = Date.parse('2026-09-15T18:00:00.000Z');

const EVENTS = [
  // The bare shape, as an extractor would hand it over.
  { eventId: 'bare', startsAt: '2026-09-04', allDay: true, title: 'Book week parade' },
  // The canonical stored shape: normaliseInstant writes UTC midnight + allDay.
  { eventId: 'canonical', startsAt: '2026-09-04T00:00:00.000Z', allDay: true, title: 'Mufti day' },
  // A TIMED event that genuinely belongs on the 3rd in Denver - the control that
  // proves the local conversion is still happening for events that need it.
  { eventId: 'timed', startsAt: '2026-09-04T02:00:00.000Z', title: 'Late night P&C meeting' },
];

function render() {
  const doc = loadDocument(INDEX_HTML);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const requestPath = String(url).split('?')[0];
    const body =
      requestPath === '/calendar/api/auth/me'
        ? { connectionStatus: 'connected', email: 'parent@example.test', schoolNames: ['Ashfield Public School'] }
        : requestPath === '/calendar/api/events'
          ? { events: structuredClone(EVENTS), truncated: false }
          : { events: [] };
    return { status: 200, json: async () => body };
  };

  const controller = app.createCalendarApp({
    document: doc,
    fetchImpl,
    now: () => NOW,
    locale: 'en-US',
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  return { doc, controller, calls };
}

const cellFor = (doc, dateKey) => doc.getElementById('calendar-grid').querySelector(`[data-date="${dateKey}"]`);
const chipIds = (cell) => (cell ? cell.querySelectorAll('.chip').map((chip) => chip.getAttribute('data-event-id')) : null);

describe('Feature: All-day events do not shift across the date line', () => {
  let doc;

  before(async () => {
    const rendered = render();
    doc = rendered.doc;
    await rendered.controller.start();
  });

  it('Given a browser timezone of "America/Denver", Then the process really is in that zone', () => {
    assert.equal(
      new Date(Date.UTC(2026, 8, 4, 12)).getTimezoneOffset(),
      360,
      'this Node did not adopt TZ=America/Denver - the scenario below would be testing the host zone'
    );
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Denver');
    // The bug this scenario exists to catch, made explicit.
    assert.equal(app.localDateKey(new Date('2026-09-04')), '2026-09-03');
  });

  it('Given an event with a date-only startsAt of 2026-09-04, When the calendar renders, Then it appears on 2026-09-04', () => {
    const fourth = cellFor(doc, '2026-09-04');
    assert.notEqual(fourth, null, 'there is no cell for 2026-09-04');
    assert.ok(chipIds(fourth).includes('bare'), `the date-only event landed elsewhere: ${chipIds(fourth).join(', ')}`);
    assert.match(textOf(fourth), /Book week parade/);
  });

  it('And the canonical UTC-midnight form lands on the 4th as well', () => {
    assert.ok(chipIds(cellFor(doc, '2026-09-04')).includes('canonical'));
  });

  it('And neither of them leaked onto the 3rd', () => {
    const third = chipIds(cellFor(doc, '2026-09-03'));
    assert.equal(third.includes('bare'), false, 'the all-day event shifted back a day');
    assert.equal(third.includes('canonical'), false, 'the canonical all-day event shifted back a day');
  });

  it('And both are shown in the all-day band, labelled "All day" rather than a clock time', () => {
    const band = cellFor(doc, '2026-09-04').querySelector('.all-day-band');
    assert.deepEqual(band.querySelectorAll('.chip').map((chip) => chip.getAttribute('data-event-id')), ['bare', 'canonical']);
    for (const chip of band.querySelectorAll('.chip')) {
      assert.equal(chip.querySelector('.chip-time'), null, 'an all-day chip carries a clock time');
    }
  });

  it('And a TIMED event at 02:00 UTC still lands on the 3rd, so the conversion has not been switched off', () => {
    assert.deepEqual(chipIds(cellFor(doc, '2026-09-03')), ['timed']);
    assert.equal(chipIds(cellFor(doc, '2026-09-04')).includes('timed'), false);
  });

  it('And opening the all-day event describes it as all day on the 4th', async () => {
    await cellFor(doc, '2026-09-04').querySelectorAll('.chip')[0].dispatch('click');
    assert.match(textOf(doc.getElementById('detail-when')), /All day on .*\b4\b/);
    assert.equal(/Sep 3|September 3/.test(textOf(doc.getElementById('detail-when'))), false);
  });

  it('And the month grid is September 2026, not August or October', () => {
    assert.match(textOf(doc.getElementById('month-heading')), /September\s+2026/);
    assert.equal(doc.getElementById('calendar-grid').querySelectorAll('.day-cell--in-month').length, 30);
  });
});
