/**
 * calendar-events-api.test.js — TASK-009 end-to-end (Gherkin) scenarios.
 *
 * Every scenario below drives the REAL Lambda `handler(event, {}, deps)` with a
 * real signed session cookie, over an in-memory table (tests/helpers/
 * fake-events-table.mjs). No DynamoDB connection is opened anywhere in this file:
 * the `query`, `updateEvent`, `getEvent`, `batchGet` and `batchWrite` seams are
 * all injected, and the fake throws if a read arrives without a key condition
 * (i.e. if anything ever tried to Scan).
 *
 * Test names are Given/When/Then, one `describe` per Gherkin scenario in the
 * ticket.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import { handler } from '../../src/lambda/calendar/index.mjs';
import { SESSION_COOKIE_NAME, createSessionToken } from '../../src/lambda/calendar/backend/session.mjs';
import { storeEvents, deriveEventId } from '../../src/lambda/calendar/backend/events.mjs';
import { FakeEventsTable, makeRecordingLog } from '../helpers/fake-events-table.mjs';

const SESSION_SECRET = 'test-session-secret-must-be-32-bytes-long!!';
const TABLE = 'test-calendar-events';

const ENV = {
  SESSION_SECRET,
  CALENDAR_EVENTS_TABLE: TABLE,
  CALENDAR_LOG_LEVEL: 'none',
};

const USER_A = 'google#1';
const USER_B = 'google#2';

/** A well-formed eventId: 64 lowercase hex characters. */
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);

function cookieFor(sub) {
  return `${SESSION_COOKIE_NAME}=${createSessionToken({ sub, email: `${sub}@example.com` }, { secret: SESSION_SECRET })}`;
}

/**
 * Build a Lambda function URL event (payload format 2.0, TASK-049).
 * `cookie` omitted means an unauthenticated request.
 *
 * Format 2.0 carries cookies in a top-level `cookies` ARRAY rather than in the
 * header map, the path in `rawPath`, and the method in
 * `requestContext.http.method` — none of `path`, `httpMethod` or
 * `multiValueHeaders` exists any more.
 */
function fnUrlEvent({ path, method = 'GET', cookie = null, query = null, body = null }) {
  const rawQueryString = query
    ? Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString,
    headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
    cookies: cookie ? [cookie] : [],
    queryStringParameters: query || undefined,
    requestContext: {
      domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
      http: { method, path },
    },
    body: body === null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/**
 * A stored row, shaped like what buildEventItem writes.
 */
function storedEvent({
  userId = USER_A,
  eventId = ID_A,
  title = 'School photo day',
  startsAt = '2026-09-04T09:00:00.000Z',
  needsAttention = false,
  dueBy = undefined,
  status = 'pending',
  attentionKey = undefined,
} = {}) {
  return {
    userId,
    eventId,
    title,
    description: 'Wear full uniform',
    location: 'School hall',
    category: 'other',
    startsAt,
    endsAt: undefined,
    allDay: false,
    needsAttention,
    actionRequired: needsAttention ? 'Return the form' : undefined,
    dueBy,
    status,
    attentionKey,
    // Present on the row, and must never reach the browser.
    sourceMessageId: 'gmail-message-handle-18f0c',
    sourceSubject: 'Photo day next Friday',
    sourceFrom: 'office@school.edu',
    sourceReceivedAt: '2026-08-20T01:02:03.000Z',
    confidence: 0.9,
    createdAt: '2026-08-20T01:05:00.000Z',
    updatedAt: '2026-08-20T01:05:00.000Z',
    ttl: 1800000000,
  };
}

/** A pending row that IS in the sparse attention index. */
function attentionEvent(overrides = {}) {
  const userId = overrides.userId || USER_A;
  return storedEvent({
    needsAttention: true,
    attentionKey: `${userId}#pending`,
    ...overrides,
    userId,
  });
}

let originalLog;
let originalWarn;
let originalError;

beforeEach(() => {
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

/** Invoke the handler with the fake table wired into every seam. */
async function invoke(event, table, extra = {}) {
  const response = await handler(event, {}, {
    env: ENV,
    query: table.query,
    updateEvent: table.updateEvent,
    getEvent: table.getEvent,
    tableName: TABLE,
    ...extra,
  });
  return { response, body: response.body ? JSON.parse(response.body) : null };
}

describe('Feature: Reading and clearing calendar events (TASK-009 e2e)', () => {
  describe('Scenario: A month of events is returned in order', () => {
    it('Given events on 2026-09-04 and 2026-09-18, When the user GETs that month, Then 200 with 2 events from StartsAtIndex', async () => {
      const table = new FakeEventsTable([
        storedEvent({ eventId: ID_B, title: 'Athletics carnival', startsAt: '2026-09-18T09:00:00.000Z' }),
        storedEvent({ eventId: ID_A, title: 'School photo day', startsAt: '2026-09-04T09:00:00.000Z' }),
      ]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.count, 2);
      assert.equal(body.events.length, 2);
      assert.deepEqual(body.events.map((e) => e.title), ['School photo day', 'Athletics carnival']);
      assert.equal(body.truncated, false);

      assert.equal(table.queries.length, 1);
      const params = table.queries[0];
      assert.equal(params.IndexName, 'StartsAtIndex');
      assert.equal(params.TableName, TABLE);
      assert.equal(params.ScanIndexForward, true);
      assert.equal(params.ExpressionAttributeValues[':userId'], USER_A);
      assert.match(params.KeyConditionExpression, /BETWEEN/);
      assert.equal(params.ExpressionAttributeValues[':from'], '2026-09-01T00:00:00.000Z');
      // The `to` bound covers the whole final day, or an evening event on the
      // 30th would be dropped.
      assert.equal(params.ExpressionAttributeValues[':to'], '2026-09-30T23:59:59.999Z');
    });

    it('Given an event at 23:30 on the last day of the range, When the month is queried, Then it is included', async () => {
      const table = new FakeEventsTable([
        storedEvent({ eventId: ID_A, title: 'Late night working bee', startsAt: '2026-09-30T23:30:00.000Z' }),
      ]);

      const { body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table
      );

      assert.equal(body.count, 1, 'an event late on the final day must be inside the range');
      assert.equal(body.events[0].title, 'Late night working bee');
    });
  });

  describe('Scenario: The default range is the current month', () => {
    it('Given an authenticated user, When they GET /calendar/api/events with no parameters, Then the queried range covers the current calendar month', async () => {
      const table = new FakeEventsTable([]);
      // A leap February, so a wrong last-day calculation shows up as the 28th.
      const nowMs = Date.parse('2028-02-14T22:00:00.000Z');

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A) }),
        table,
        { now: () => nowMs }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.from, '2028-02-01');
      assert.equal(body.to, '2028-02-29');
      const values = table.queries[0].ExpressionAttributeValues;
      assert.equal(values[':from'], '2028-02-01T00:00:00.000Z');
      assert.equal(values[':to'], '2028-02-29T23:59:59.999Z');
    });

    it('Given only a `from`, When the month is queried, Then `to` is filled from that same month', async () => {
      const table = new FakeEventsTable([]);

      const { body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-11-09' } }),
        table
      );

      assert.equal(body.from, '2026-11-09');
      assert.equal(body.to, '2026-11-30');
    });
  });

  describe('Scenario Outline: Invalid ranges are refused', () => {
    const examples = [
      { from: '2026-09-30', to: '2026-09-01', because: 'from is after to' },
      { from: 'not-a-date', to: '2026-09-30', because: 'from does not parse' },
      { from: '2026-01-01', to: '2026-12-31', because: 'the span exceeds 93 days' },
    ];

    for (const { from, to, because } of examples) {
      it(`Given an authenticated user, When they GET events from "${from}" to "${to}", Then 400 (${because}) and no DynamoDB call`, async () => {
        const table = new FakeEventsTable([storedEvent()]);

        const { response, body } = await invoke(
          fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from, to } }),
          table
        );

        assert.equal(response.statusCode, 400);
        assert.equal(typeof body.error, 'string');
        assert.ok(body.error.length > 0, 'a 400 must explain itself');
        assert.ok(['from', 'to'].includes(body.field), `field should name the offending bound, got ${body.field}`);
        assert.equal(table.callCount, 0, 'a bad range must be refused before any DynamoDB call');
      });
    }

    it('Given a range of exactly 93 days, When it is queried, Then it is accepted', async () => {
      const table = new FakeEventsTable([]);

      const { response } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-12-02' } }),
        table
      );

      assert.equal(response.statusCode, 200, '93 inclusive days is the documented maximum, not one past it');
      assert.equal(table.queries.length, 1);
    });

    it('Given a range of 94 days, When it is queried, Then 400', async () => {
      const table = new FakeEventsTable([]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-12-03' } }),
        table
      );

      assert.equal(response.statusCode, 400);
      assert.equal(body.field, 'to');
      assert.equal(table.callCount, 0);
    });

    it('Given a date that matches the pattern but is not a real day, When it is queried, Then 400', async () => {
      const table = new FakeEventsTable([]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-02-31', to: '2026-03-05' } }),
        table
      );

      // 2026-02-31 matches YYYY-MM-DD and is not a day. Date.parse rolls it
      // forward to 2026-03-03 rather than refusing it, so without an explicit
      // round-trip check the API would send "2026-02-31T00:00:00.000Z" as a
      // BETWEEN bound - an instant that does not exist.
      //
      // The message is a PLAIN STRING: an interpolated read of the request the
      // route did NOT make is a diagnostic that only makes sense while the bug
      // is present, and evaluating it eagerly is how such a message escapes the
      // assertion it was meant to explain.
      assert.equal(response.statusCode, 400, '2026-02-31 is not a date and must not reach DynamoDB as a key bound');
      assert.equal(body.field, 'from');
      assert.equal(table.callCount, 0, 'an impossible day must be refused before any DynamoDB call');
      assert.deepEqual(table.queries, [], 'no query may have been issued at all');
    });

    it('Given the real days on either side of an impossible one, When they are queried, Then they are accepted', async () => {
      // The round-trip check must reject impossible days, not every date near a
      // month boundary.
      for (const [from, to] of [['2026-02-28', '2026-03-05'], ['2026-03-01', '2026-03-05'], ['2028-02-29', '2028-03-05']]) {
        const table = new FakeEventsTable([]);
        const { response } = await invoke(
          fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from, to } }),
          table
        );
        assert.equal(response.statusCode, 200, `${from} is a real calendar day and must be accepted`);
        assert.equal(table.queries.length, 1);
      }
    });
  });

  describe('Scenario: A crowded month is not silently truncated', () => {
    it('Given a month whose events span two DynamoDB pages, When the month is queried, Then events from both pages are returned', async () => {
      const table = new FakeEventsTable(
        [
          storedEvent({ eventId: ID_A, title: 'Page one event', startsAt: '2026-09-02T09:00:00.000Z' }),
          storedEvent({ eventId: ID_B, title: 'Page two event', startsAt: '2026-09-20T09:00:00.000Z' }),
        ],
        { pageSize: 1 }
      );

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.count, 2, 'the second page must be followed, not dropped');
      assert.deepEqual(body.events.map((e) => e.title), ['Page one event', 'Page two event']);
      assert.equal(body.pages, 2);
      assert.equal(body.truncated, false);
      assert.equal(table.queries.length, 2);
      assert.equal(table.queries[0].ExclusiveStartKey, undefined);
      assert.equal(table.queries[1].ExclusiveStartKey.eventId, ID_A, 'the second page must resume from the first page LastEvaluatedKey');
    });

    it('Given more events than the cap, When the month is queried, Then the result is capped and truncated is true', async () => {
      const rows = [];
      for (let i = 0; i < 5; i += 1) {
        rows.push(storedEvent({ eventId: String(i).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'), title: `Event ${i}`, startsAt: `2026-09-0${i + 1}T09:00:00.000Z` }));
      }
      const table = new FakeEventsTable(rows);

      const { body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table,
        { maxItems: 3 }
      );

      assert.equal(body.count, 3, 'the response is capped');
      assert.equal(body.events.length, 3);
      assert.equal(body.truncated, true, 'a capped result must say so rather than look like a short honest answer');
    });

    it('Given exactly as many events as the cap, When the month is queried, Then truncated is false', async () => {
      const table = new FakeEventsTable([
        storedEvent({ eventId: ID_A, startsAt: '2026-09-02T09:00:00.000Z' }),
        storedEvent({ eventId: ID_B, startsAt: '2026-09-03T09:00:00.000Z' }),
        storedEvent({ eventId: ID_C, startsAt: '2026-09-04T09:00:00.000Z' }),
      ]);

      const { body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table,
        { maxItems: 3 }
      );

      assert.equal(body.count, 3);
      assert.equal(body.truncated, false, 'a full page is not evidence of more; the extra item is what proves it');
    });
  });

  describe('Scenario: Upcoming items are ordered by deadline', () => {
    it('Given pending attention events due 2026-08-22 and 2026-08-19, When they GET upcoming, Then the first item is due 2026-08-19', async () => {
      const table = new FakeEventsTable([
        attentionEvent({ eventId: ID_A, title: 'Excursion permission', dueBy: '2026-08-22T00:00:00.000Z', startsAt: '2026-08-25T09:00:00.000Z' }),
        attentionEvent({ eventId: ID_B, title: 'Book club payment', dueBy: '2026-08-19T00:00:00.000Z', startsAt: '2026-08-24T09:00:00.000Z' }),
      ]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }),
        table,
        { now: () => Date.parse('2026-08-18T00:00:00.000Z') }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.count, 2);
      assert.equal(body.events[0].dueBy, '2026-08-19T00:00:00.000Z');
      assert.equal(body.events[0].title, 'Book club payment');
      assert.equal(body.events[1].dueBy, '2026-08-22T00:00:00.000Z');

      const params = table.queries[0];
      assert.equal(params.IndexName, 'AttentionIndex');
      assert.equal(params.ScanIndexForward, true, 'soonest deadline first');
      assert.equal(params.ExpressionAttributeValues[':attentionKey'], 'google#1#pending');
      assert.equal(params.FilterExpression, undefined, 'the sparse index removes handled rows; a filter would be a second, weaker mechanism');
    });

    it('Given no limit, When they GET upcoming, Then the limit is 20; and Given limit=500, Then it is clamped to 100', async () => {
      const table = new FakeEventsTable([]);

      const { body: defaulted } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }),
        table
      );
      assert.equal(defaulted.limit, 20);
      assert.equal(table.queries[0].Limit, 20);

      const { body: clamped } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A), query: { limit: '500' } }),
        table
      );
      assert.equal(clamped.limit, 100, 'the cap is a cost bound and is never honoured above 100');
      assert.equal(table.queries[1].Limit, 100);

      const { body: honoured } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A), query: { limit: '7' } }),
        table
      );
      assert.equal(honoured.limit, 7);
    });
  });

  describe('Scenario: A passed deadline is marked overdue', () => {
    it('Given a pending attention event due yesterday, When they GET upcoming, Then that item has overdue true and a future one has false', async () => {
      const nowMs = Date.parse('2026-08-20T10:00:00.000Z');
      const table = new FakeEventsTable([
        attentionEvent({ eventId: ID_A, title: 'Overdue form', dueBy: '2026-08-19T00:00:00.000Z', startsAt: '2026-08-26T09:00:00.000Z' }),
        attentionEvent({ eventId: ID_B, title: 'Still time', dueBy: '2026-08-28T00:00:00.000Z', startsAt: '2026-08-30T09:00:00.000Z' }),
      ]);

      const { body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }),
        table,
        { now: () => nowMs }
      );

      const byTitle = Object.fromEntries(body.events.map((e) => [e.title, e]));
      assert.equal(byTitle['Overdue form'].overdue, true);
      assert.equal(byTitle['Still time'].overdue, false);
    });
  });

  describe('Scenario: Acknowledging clears an item from the attention list', () => {
    it('Given a pending attention event, When the user POSTs to its acknowledge route, Then 200, the stored row has no attentionKey, and it leaves the upcoming response', async () => {
      const table = new FakeEventsTable([
        attentionEvent({ eventId: ID_A, title: 'Excursion permission', dueBy: '2026-08-22T00:00:00.000Z' }),
        attentionEvent({ eventId: ID_B, title: 'Book club payment', dueBy: '2026-08-23T00:00:00.000Z' }),
      ]);
      const stampMs = Date.parse('2026-08-20T05:00:00.000Z');

      const before = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(before.body.count, 2);

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/acknowledge`, method: 'POST', cookie: cookieFor(USER_A) }),
        table,
        { now: () => stampMs }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.event.status, 'acknowledged');
      assert.equal(body.event.eventId, ID_A);

      const stored = table.read(USER_A, ID_A);
      assert.equal(stored.status, 'acknowledged');
      assert.equal(stored.acknowledgedAt, '2026-08-20T05:00:00.000Z');
      assert.ok(!('attentionKey' in stored), 'the row must LOSE attentionKey, not merely be marked acknowledged');

      // One UpdateItem did both, so the list is never briefly wrong.
      assert.equal(table.updates.length, 1);
      const update = table.updates[0];
      assert.match(update.UpdateExpression, /^SET .*REMOVE /);
      assert.match(update.ConditionExpression, /attribute_exists\(#userId\) AND #userId = :userId/);
      assert.equal(update.ExpressionAttributeValues[':userId'], USER_A);
      assert.deepEqual(update.Key, { userId: USER_A, eventId: ID_A });

      const after = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(after.body.count, 1);
      assert.deepEqual(after.body.events.map((e) => e.eventId), [ID_B]);
    });

    it('Given a pending attention event, When the user POSTs to its dismiss route, Then it is dismissed, stamped, and gone from the list', async () => {
      const table = new FakeEventsTable([attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' })]);
      const stampMs = Date.parse('2026-08-20T06:30:00.000Z');

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/dismiss`, method: 'POST', cookie: cookieFor(USER_A) }),
        table,
        { now: () => stampMs }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.event.status, 'dismissed');
      const stored = table.read(USER_A, ID_A);
      assert.equal(stored.status, 'dismissed');
      assert.equal(stored.dismissedAt, '2026-08-20T06:30:00.000Z');
      assert.equal(stored.acknowledgedAt, undefined, 'dismiss must not stamp an acknowledgement');
      assert.ok(!('attentionKey' in stored));

      const after = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(after.body.count, 0);
    });
  });

  describe('Scenario: A mistaken dismissal can be undone', () => {
    it('Given a dismissed event with needsAttention true, When the user POSTs to its restore route, Then its status is pending and it reappears in upcoming', async () => {
      const dismissed = storedEvent({
        eventId: ID_A,
        title: 'Excursion permission',
        needsAttention: true,
        status: 'dismissed',
        startsAt: '2026-08-25T09:00:00.000Z',
        dueBy: '2026-08-22T00:00:00.000Z',
      });
      dismissed.dismissedAt = '2026-08-20T06:30:00.000Z';
      const table = new FakeEventsTable([dismissed]);

      const empty = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(empty.body.count, 0, 'a dismissed row starts outside the sparse index');

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/restore`, method: 'POST', cookie: cookieFor(USER_A) }),
        table,
        { now: () => Date.parse('2026-08-21T00:00:00.000Z') }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.event.status, 'pending');

      const stored = table.read(USER_A, ID_A);
      assert.equal(stored.status, 'pending');
      assert.equal(stored.attentionKey, 'google#1#pending', 'restore must put the row back into the sparse index');
      assert.equal(stored.dueBy, '2026-08-22T00:00:00.000Z');
      assert.equal(stored.dismissedAt, undefined, 'the dismissal stamp must be cleared');

      const after = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(after.body.count, 1);
      assert.equal(after.body.events[0].eventId, ID_A);
    });

    it('Given a dismissed event with needsAttention FALSE, When it is restored, Then it is pending but does not join the attention list', async () => {
      const table = new FakeEventsTable([
        storedEvent({ eventId: ID_A, needsAttention: false, status: 'dismissed', startsAt: '2026-08-25T09:00:00.000Z' }),
      ]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/restore`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.event.status, 'pending');
      const stored = table.read(USER_A, ID_A);
      assert.equal(stored.attentionKey, undefined, 'an informational event was never in the attention list');

      const after = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(after.body.count, 0);
    });

    it('Given an eventId that does not exist, When it is restored, Then 404 and no UpdateItem is issued', async () => {
      const table = new FakeEventsTable([]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_C}/restore`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 404);
      assert.equal(body.error, 'Event not found');
      assert.equal(table.updates.length, 0, 'a missing row must not be recreated by the restore write');
    });
  });

  describe("Scenario: One user cannot touch another user's event", () => {
    it('Given an event belonging to user "google#2", When user "google#1" POSTs to its acknowledge route, Then 404 and the event is unchanged', async () => {
      const foreign = attentionEvent({ userId: USER_B, eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' });
      const table = new FakeEventsTable([foreign]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/acknowledge`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 404, "a foreign event must be a 404, never a 403 that confirms it exists");
      assert.equal(body.error, 'Event not found');
      assert.equal(body.field, undefined);

      const stored = table.read(USER_B, ID_A);
      assert.equal(stored.status, 'pending', "the other user's row must be untouched");
      assert.equal(stored.attentionKey, 'google#2#pending');
      assert.equal(table.updates[0].ExpressionAttributeValues[':userId'], USER_A, 'the condition binds the write to the SESSION user');
    });

    it('Given a foreign event, When user "google#1" dismisses and restores it, Then both are 404 and the row is unchanged', async () => {
      const foreign = attentionEvent({ userId: USER_B, eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' });
      const table = new FakeEventsTable([foreign]);

      const dismissed = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/dismiss`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );
      const restored = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/restore`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(dismissed.response.statusCode, 404);
      assert.equal(restored.response.statusCode, 404);
      const stored = table.read(USER_B, ID_A);
      assert.equal(stored.status, 'pending');
      assert.equal(stored.attentionKey, 'google#2#pending');
      assert.equal(stored.dismissedAt, undefined);
      assert.equal(stored.updatedAt, foreign.updatedAt, "no write landed on the other user's row");
    });
  });

  describe("Scenario: One user cannot read another user's calendar", () => {
    it('Given a session for "google#1", When they GET events with userId=google#2, Then every returned event belongs to google#1', async () => {
      const table = new FakeEventsTable([
        storedEvent({ userId: USER_A, eventId: ID_A, title: 'Mine', startsAt: '2026-09-04T09:00:00.000Z' }),
        storedEvent({ userId: USER_B, eventId: ID_B, title: 'Theirs', startsAt: '2026-09-05T09:00:00.000Z' }),
      ]);

      const { response, body } = await invoke(
        fnUrlEvent({
          path: '/calendar/api/events',
          cookie: cookieFor(USER_A),
          query: { from: '2026-09-01', to: '2026-09-30', userId: USER_B },
        }),
        table
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.count, 1);
      assert.deepEqual(body.events.map((e) => e.title), ['Mine']);
      assert.equal(table.queries[0].ExpressionAttributeValues[':userId'], USER_A, 'the hash key comes from the session, not the query string');
    });

    it('Given a session for "google#1", When they GET upcoming with a userId query parameter and a userId body/header, Then the attention key is still theirs', async () => {
      const table = new FakeEventsTable([
        attentionEvent({ userId: USER_B, eventId: ID_B, title: 'Theirs', dueBy: '2026-08-22T00:00:00.000Z' }),
      ]);

      const event = fnUrlEvent({
        path: '/calendar/api/events/upcoming',
        cookie: cookieFor(USER_A),
        query: { userId: USER_B, limit: '50' },
      });
      event.headers['x-user-id'] = USER_B;
      event.body = JSON.stringify({ userId: USER_B });

      const { response, body } = await invoke(event, table);

      assert.equal(response.statusCode, 200);
      assert.equal(body.count, 0, "another user's attention list must not be reachable");
      assert.equal(table.queries[0].ExpressionAttributeValues[':attentionKey'], 'google#1#pending');
    });
  });

  describe('Scenario: A malformed event id is rejected before the database', () => {
    it('Given an authenticated user, When they POST to acknowledge event id "../../etc/passwd", Then 400 and no DynamoDB call is made', async () => {
      const table = new FakeEventsTable([storedEvent()]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/../../etc/passwd/acknowledge', method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 400, 'a traversal attempt must be a named 400, not the router generic 404');
      assert.equal(body.field, 'eventId');
      assert.match(body.error, /64 lowercase hexadecimal/);
      assert.ok(!body.error.includes('etc/passwd'), 'the refusal must not echo attacker-controlled path text');
      assert.equal(table.callCount, 0);
    });

    const badIds = [
      { id: 'A'.repeat(64), why: 'uppercase hex' },
      { id: 'a'.repeat(63), why: '63 characters' },
      { id: 'a'.repeat(65), why: '65 characters' },
      { id: `${'a'.repeat(63)}g`, why: 'a non-hex character' },
      { id: '%2E%2E%2F%2E%2E%2Fetc%2Fpasswd', why: 'a percent-encoded traversal' },
      { id: `${'a'.repeat(64)}%20`, why: 'trailing encoded whitespace' },
    ];

    for (const { id, why } of badIds) {
      it(`Given an id with ${why}, When acknowledge is POSTed, Then 400 and no DynamoDB call`, async () => {
        const table = new FakeEventsTable([storedEvent()]);

        const { response, body } = await invoke(
          fnUrlEvent({ path: `/calendar/api/events/${id}/acknowledge`, method: 'POST', cookie: cookieFor(USER_A) }),
          table
        );

        assert.equal(response.statusCode, 400, `${why} must be refused`);
        assert.equal(body.field, 'eventId');
        assert.equal(table.callCount, 0);
      });
    }
  });

  describe('Scenario: The URL decides which row is mutated', () => {
    it('Given a body and an injected option that name a different eventId, When acknowledge is POSTed, Then the URL row is the one written', async () => {
      const table = new FakeEventsTable([
        attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' }),
        attentionEvent({ eventId: ID_B, dueBy: '2026-08-23T00:00:00.000Z' }),
      ]);

      const event = fnUrlEvent({
        path: `/calendar/api/events/${ID_A}/acknowledge`,
        method: 'POST',
        cookie: cookieFor(USER_A),
        body: { eventId: ID_B },
      });

      // `eventId` supplied as a dependency override too: the route must set the
      // path value AFTER spreading options, so this cannot redirect the write.
      const { response } = await invoke(event, table, { eventId: ID_B });

      assert.equal(response.statusCode, 200);
      assert.equal(table.updates.length, 1);
      assert.equal(table.updates[0].Key.eventId, ID_A, 'the URL, not the body or an option, names the row');
      assert.equal(table.read(USER_A, ID_A).status, 'acknowledged');
      assert.equal(table.read(USER_A, ID_B).status, 'pending', 'the other row must be untouched');
    });
  });

  describe('Scenario: Gmail handles are not exposed to the browser', () => {
    it('Given an authenticated user with events, When they GET the month view, Then no response item contains sourceMessageId or any token', async () => {
      const row = storedEvent({ eventId: ID_A, startsAt: '2026-09-04T09:00:00.000Z' });
      row.refreshTokenEnc = 'ENCRYPTED-REFRESH-TOKEN';
      row.accessToken = 'ya29.a0-fake-access-token';
      const table = new FakeEventsTable([row]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table
      );

      assert.equal(response.statusCode, 200);
      const serialised = response.body;
      for (const banned of ['sourceMessageId', 'gmail-message-handle', 'refreshTokenEnc', 'ENCRYPTED-REFRESH-TOKEN', 'accessToken', 'ya29.', 'attentionKey', 'ttl']) {
        assert.ok(!serialised.includes(banned), `the response body must not contain "${banned}"`);
      }
      assert.deepEqual(Object.keys(body.events[0]).sort(), [
        'actionRequired', 'allDay', 'category', 'confidence', 'description', 'dueBy', 'endsAt', 'eventId',
        'location', 'needsAttention', 'sourceFrom', 'sourceReceivedAt', 'sourceSubject', 'startsAt', 'status', 'title',
      ]);
      // Provenance the UI is allowed to show.
      assert.equal(body.events[0].sourceSubject, 'Photo day next Friday');
      assert.equal(body.events[0].sourceFrom, 'office@school.edu');
    });

    it('Given attention events, When upcoming is read, Then items carry overdue and still no sourceMessageId', async () => {
      const table = new FakeEventsTable([attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' })]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }),
        table
      );

      assert.ok(!response.body.includes('sourceMessageId'));
      assert.equal(typeof body.events[0].overdue, 'boolean');
    });
  });

  describe('Scenario: Unauthenticated access is refused', () => {
    const routes = [
      { path: '/calendar/api/events', method: 'GET' },
      { path: '/calendar/api/events/upcoming', method: 'GET' },
      { path: `/calendar/api/events/${ID_A}/acknowledge`, method: 'POST' },
      { path: `/calendar/api/events/${ID_A}/dismiss`, method: 'POST' },
      { path: `/calendar/api/events/${ID_A}/restore`, method: 'POST' },
    ];

    for (const { path, method } of routes) {
      it(`Given no session cookie, When ${method} ${path} is requested, Then 401 and no DynamoDB call`, async () => {
        const table = new FakeEventsTable([attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' })]);

        const { response, body } = await invoke(fnUrlEvent({ path, method }), table);

        assert.equal(response.statusCode, 401);
        assert.equal(body.error, 'Not signed in');
        assert.equal(table.callCount, 0);
      });
    }

    it('Given a tampered session cookie, When upcoming is requested, Then 401', async () => {
      const table = new FakeEventsTable([]);
      const valid = createSessionToken({ sub: USER_A, email: 'a@example.com' }, { secret: SESSION_SECRET });
      const tampered = `${SESSION_COOKIE_NAME}=${valid.slice(0, -3)}xyz`;

      const { response } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: tampered }),
        table
      );

      assert.equal(response.statusCode, 401);
      assert.equal(table.callCount, 0);
    });

    it('Given a session signed with a different secret, When the month view is requested, Then 401', async () => {
      const table = new FakeEventsTable([]);
      const foreign = `${SESSION_COOKIE_NAME}=${createSessionToken({ sub: USER_A }, { secret: 'a-completely-different-secret-value-32b' })}`;

      const { response } = await invoke(fnUrlEvent({ path: '/calendar/api/events', cookie: foreign }), table);

      assert.equal(response.statusCode, 401);
      assert.equal(table.callCount, 0);
    });
  });

  describe('Scenario: A handled event survives a re-scan of the same source email', () => {
    const message = {
      id: 'gmail-message-handle-18f0c',
      subject: 'Excursion to the museum',
      from: 'office@school.edu',
      receivedAt: '2026-08-18T01:00:00.000Z',
    };
    const modelEvent = {
      title: 'Museum excursion',
      startsAt: '2026-09-10T09:00:00.000Z',
      needsAttention: true,
      actionRequired: 'Return the permission slip',
      dueBy: '2026-09-03T00:00:00.000Z',
      category: 'excursion',
      confidence: 0.9,
    };
    const nowMs = Date.parse('2026-08-18T02:00:00.000Z');

    /** Run the TASK-007 store path over the same email, against the fake table. */
    async function reScan(table, log) {
      return storeEvents(
        { userId: USER_A, message, events: [modelEvent], tableName: TABLE },
        { batchWrite: table.batchWrite, batchGet: table.batchGet, now: () => nowMs, env: ENV, log, sleep: async () => {} }
      );
    }

    it('Given an acknowledged event, When the same email is re-scanned, Then it stays acknowledged and stays out of the attention list', async () => {
      const table = new FakeEventsTable([]);
      const eventId = deriveEventId({ sourceMessageId: message.id, title: modelEvent.title, startsAt: modelEvent.startsAt });

      // 1. First scan stores it as pending, in the attention list.
      await reScan(table);
      const firstList = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(firstList.body.count, 1);
      assert.equal(firstList.body.events[0].eventId, eventId);

      // 2. The user acknowledges it through the real route.
      const ack = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${eventId}/acknowledge`, method: 'POST', cookie: cookieFor(USER_A) }),
        table,
        { now: () => Date.parse('2026-08-19T00:00:00.000Z') }
      );
      assert.equal(ack.response.statusCode, 200);

      // 3. The scheduled scan sees the same email again.
      const rescan = await reScan(table);
      assert.equal(rescan.written, 1, 'the re-scan still writes the row');
      assert.equal(rescan.preserved, 1, 'and reports that it preserved a handled lifecycle');
      assert.equal(table.batchGets.length, 2, 'the write pre-reads the exact keys it is about to overwrite');
      assert.deepEqual(table.batchGets[1].keys, [{ userId: USER_A, eventId }], 'key-scoped, never a scan of the partition');

      // 4. It is STILL acknowledged and STILL absent from the attention list.
      const stored = table.read(USER_A, eventId);
      assert.equal(stored.status, 'acknowledged');
      assert.equal(stored.acknowledgedAt, '2026-08-19T00:00:00.000Z', 'the original acknowledgement stamp survives');
      assert.equal(stored.attentionKey, undefined);

      const afterList = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(afterList.body.count, 0, 'a re-scan must not resurrect a handled event');

      // The month view still shows it, with the fresh content from the re-scan.
      const month = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        table
      );
      assert.equal(month.body.count, 1);
      assert.equal(month.body.events[0].status, 'acknowledged');
      assert.equal(month.body.events[0].dueBy, '2026-09-03T00:00:00.000Z', 'the deadline is still displayed for a handled event');
    });

    it('Given a dismissed event, When the same email is re-scanned, Then it stays dismissed', async () => {
      const table = new FakeEventsTable([]);
      const eventId = deriveEventId({ sourceMessageId: message.id, title: modelEvent.title, startsAt: modelEvent.startsAt });

      await reScan(table);
      await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${eventId}/dismiss`, method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );
      await reScan(table);

      assert.equal(table.read(USER_A, eventId).status, 'dismissed');
      const list = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(list.body.count, 0);
    });

    it('Given a still-pending event, When the same email is re-scanned, Then it stays in the attention list and nothing is reported preserved', async () => {
      const table = new FakeEventsTable([]);

      await reScan(table);
      const rescan = await reScan(table);

      assert.equal(rescan.preserved, 0, 'a pending row has no decision to carry forward');
      const list = await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);
      assert.equal(list.body.count, 1, 'a pending event must still be actionable after a re-scan');
    });

    it('Given the lifecycle pre-read throws, When the email is re-scanned, Then the write still happens and the failure is logged', async () => {
      const table = new FakeEventsTable([]);
      const log = makeRecordingLog();
      const eventId = deriveEventId({ sourceMessageId: message.id, title: modelEvent.title, startsAt: modelEvent.startsAt });

      table.batchGetError = Object.assign(new Error('ProvisionedThroughputExceeded'), { name: 'ProvisionedThroughputExceededException' });
      const result = await reScan(table, log);

      assert.equal(result.written, 1, 'losing a brand-new event is worse than resurrecting a handled one: the write must proceed');
      assert.equal(result.preserved, 0);
      assert.equal(table.batchWrites.length, 1);
      assert.ok(table.read(USER_A, eventId), 'the row is stored despite the failed pre-read');

      const failure = log.lines.find((line) => line.message === 'calendar.events.lifecycle_read_failed');
      assert.ok(failure, `expected calendar.events.lifecycle_read_failed, got ${JSON.stringify(log.messages())}`);
      assert.equal(failure.fields.errorName, 'ProvisionedThroughputExceededException');
      assert.equal(failure.fields.userId, USER_A);
      assert.ok(!JSON.stringify(failure.fields).includes('Museum excursion'), 'the log line must not carry event titles');
    });
  });

  describe('Scenario: The events routes never Scan and never accept a foreign method', () => {
    it('Given any events route, When it is exercised, Then every DynamoDB read carries an index and a key condition', async () => {
      const table = new FakeEventsTable([attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z', startsAt: '2026-09-04T09:00:00.000Z' })]);

      await invoke(fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }), table);
      await invoke(fnUrlEvent({ path: '/calendar/api/events/upcoming', cookie: cookieFor(USER_A) }), table);

      assert.equal(table.queries.length, 2);
      for (const params of table.queries) {
        assert.ok(['StartsAtIndex', 'AttentionIndex'].includes(params.IndexName), `unexpected index ${params.IndexName}`);
        assert.equal(typeof params.KeyConditionExpression, 'string');
        assert.equal(params.FilterExpression, undefined, 'tenancy is the partition key, never a post-read filter');
      }
    });

    it('Given a DELETE to the month view, When it is routed, Then 404 from the generic router and no query', async () => {
      const table = new FakeEventsTable([]);

      const { response } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events', method: 'DELETE', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 404);
      assert.equal(table.callCount, 0);
    });

    it('Given a GET to the acknowledge route, When it is routed, Then 404 and no mutation', async () => {
      const table = new FakeEventsTable([attentionEvent({ eventId: ID_A, dueBy: '2026-08-22T00:00:00.000Z' })]);

      const { response } = await invoke(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/acknowledge`, method: 'GET', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 404);
      assert.equal(table.updates.length, 0);
    });

    it('Given the literal path /calendar/api/events/upcoming, When it is POSTed to acknowledge-style, Then "upcoming" is never read as an event id', async () => {
      const table = new FakeEventsTable([]);

      const { response, body } = await invoke(
        fnUrlEvent({ path: '/calendar/api/events/upcoming/acknowledge', method: 'POST', cookie: cookieFor(USER_A) }),
        table
      );

      assert.equal(response.statusCode, 400, '"upcoming" is not 64 hex characters');
      assert.equal(body.field, 'eventId');
      assert.equal(table.callCount, 0);
    });
  });

  describe('Scenario: An unexpected DynamoDB failure is a 500, not a leak', () => {
    it('Given the query throws, When the month view is read, Then 500 with a generic message and no internals', async () => {
      const table = new FakeEventsTable([]);
      const exploding = async () => {
        throw Object.assign(new Error('table test-calendar-events not found: arn:aws:dynamodb:...'), { name: 'ResourceNotFoundException' });
      };

      const response = await handler(
        fnUrlEvent({ path: '/calendar/api/events', cookie: cookieFor(USER_A), query: { from: '2026-09-01', to: '2026-09-30' } }),
        {},
        { env: ENV, query: exploding, tableName: TABLE }
      );
      const body = JSON.parse(response.body);

      assert.equal(response.statusCode, 500);
      assert.equal(body.error, 'Could not read your calendar');
      assert.ok(!response.body.includes('arn:aws'), 'internal detail must not be echoed');
      assert.equal(table.callCount, 0);
    });

    it('Given the update throws an unexpected error, When acknowledge is POSTed, Then 500 rather than a misleading 404', async () => {
      const exploding = async () => {
        throw Object.assign(new Error('boom'), { name: 'InternalServerError' });
      };

      const response = await handler(
        fnUrlEvent({ path: `/calendar/api/events/${ID_A}/acknowledge`, method: 'POST', cookie: cookieFor(USER_A) }),
        {},
        { env: ENV, updateEvent: exploding, tableName: TABLE }
      );
      const body = JSON.parse(response.body);

      assert.equal(response.statusCode, 500);
      assert.equal(body.error, 'Could not update the event');
    });
  });
});
