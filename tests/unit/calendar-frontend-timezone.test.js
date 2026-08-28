/**
 * UNIT tests for TASK-010's date-only rule, run in a UTC-NEGATIVE timezone.
 *
 * WHY THIS IS ITS OWN FILE. `TZ=... node` does not work on the machine this
 * repo is developed on - Node ignores the environment variable handed in on the
 * command line and stays on the host zone. So the zone is set IN-PROCESS, at the
 * top of this module, BEFORE `frontend/app.js` is imported (which is why the
 * import below is dynamic). `node --test` runs each test file in its own child
 * process, so this file's zone cannot leak into any other.
 *
 * A test that set the zone on the command line would pass in Australia/Sydney -
 * where every one of these assertions is already true - and would say nothing at
 * all about Denver. `assertZone()` below therefore fails loudly if the change
 * did not take, so this file cannot go green for the wrong reason.
 *
 * THE BUG BEING PINNED. `new Date("2026-09-04")` parses as UTC midnight. In
 * Denver that instant is 2026-09-03 at 18:00, so an all-day event routed through
 * the local-time formatter lands on the day BEFORE for every user west of UTC.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

/** The zone every assertion below is written for. Set before the import. */
process.env.TZ = 'America/Denver';

const app = await import('../../src/lambda/calendar/frontend/app.js');

/**
 * Switch the process zone and PROVE it took, so a silently ignored TZ cannot
 * turn a wrong-zone pass into a green test.
 *
 * @param {string} zone
 * @param {number} expectedOffsetMinutes `Date#getTimezoneOffset` on 2026-09-04.
 */
function useZone(zone, expectedOffsetMinutes) {
  process.env.TZ = zone;
  const probe = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));
  assert.equal(
    probe.getTimezoneOffset(),
    expectedOffsetMinutes,
    `this Node did not adopt TZ=${zone}; every assertion below would be testing the host zone instead`
  );
}

describe('TASK-010 unit: a date-only startsAt in America/Denver', () => {
  it('the process really is running in a UTC-negative zone', () => {
    useZone('America/Denver', 360);
    assert.ok(new Date(Date.UTC(2026, 8, 4, 12)).getTimezoneOffset() > 0, 'Denver is behind UTC');
    // The trap itself: this is what a naive implementation would compute.
    assert.equal(app.localDateKey(new Date('2026-09-04')), '2026-09-03');
  });

  it('places a bare 2026-09-04 on 2026-09-04, not on the 3rd', () => {
    useZone('America/Denver', 360);
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04' }), '2026-09-04');
  });

  it('places the canonical stored form (UTC midnight + allDay) on 2026-09-04 too', () => {
    useZone('America/Denver', 360);
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04T00:00:00.000Z', allDay: true }), '2026-09-04');
  });

  it('formats the date-only day as the 4th, with no shift', () => {
    useZone('America/Denver', 360);
    assert.match(app.formatDateKey('2026-09-04', 'en-US'), /\b4\b/);
    assert.match(app.formatDateKey('2026-09-04', 'en-US'), /Sep/i);
    assert.match(app.formatEventWhen({ startsAt: '2026-09-04' }, 'en-US'), /All day on .*\b4\b/);
  });

  it('STILL converts a timed event, so the exemption is real and not a blanket opt-out', () => {
    useZone('America/Denver', 360);
    // 02:00 UTC on the 4th is 20:00 MDT on the 3rd - the local day IS the answer
    // for a timed event, and this proves the conversion has not been disabled.
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04T02:00:00.000Z' }), '2026-09-03');
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04T18:00:00.000Z' }), '2026-09-04');
  });

  it('lands on 2026-09-04 in every zone from Kiritimati to Los Angeles', () => {
    const zones = [
      ['America/Los_Angeles', 420],
      ['America/Denver', 360],
      ['UTC', 0],
      ['Europe/London', -60],
      ['Asia/Kolkata', -330],
      ['Australia/Sydney', -600],
      ['Pacific/Kiritimati', -840],
    ];
    for (const [zone, offset] of zones) {
      useZone(zone, offset);
      assert.equal(app.eventDateKey({ startsAt: '2026-09-04' }), '2026-09-04', zone);
      assert.equal(
        app.eventDateKey({ startsAt: '2026-09-04T00:00:00.000Z', allDay: true }),
        '2026-09-04',
        `${zone} (canonical form)`
      );
      assert.equal(app.formatEventTime({ startsAt: '2026-09-04', allDay: true }), 'All day', zone);
    }
    useZone('America/Denver', 360);
  });

  it('keeps the month range stable in a UTC-negative zone', () => {
    useZone('America/Denver', 360);
    assert.deepEqual(app.monthRange(2026, 8), { from: '2026-09-01', to: '2026-09-30' });
    const inMonth = app.buildMonthMatrix(2026, 8).flat().filter((cell) => cell.inMonth);
    assert.equal(inMonth.length, 30);
    assert.equal(inMonth[0].dateKey, '2026-09-01');
    assert.equal(inMonth[29].dateKey, '2026-09-30');
  });

  it('groups an all-day event into the 4th, whichever shape it arrived in', () => {
    useZone('America/Denver', 360);
    const grouped = app.groupEventsByDay([
      { eventId: 'bare', startsAt: '2026-09-04', allDay: true, title: 'Bare' },
      { eventId: 'canonical', startsAt: '2026-09-04T00:00:00.000Z', allDay: true, title: 'Canonical' },
    ]);
    assert.deepEqual([...grouped.keys()], ['2026-09-04']);
    assert.equal(grouped.get('2026-09-04').length, 2);
  });

  it('treats a bare deadline as the end of that local day, not its start', () => {
    useZone('America/Denver', 360);
    // 2026-09-04T23:59:59.999Z has not passed at 2026-09-04T00:00:00Z.
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-04' }, Date.parse('2026-09-04T00:00:00.000Z')), false);
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-04' }, Date.parse('2026-09-05T12:00:00.000Z')), true);
  });
});
