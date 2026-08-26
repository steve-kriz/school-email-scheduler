/**
 * calendar-events-api.test.js — TASK-009 unit tests.
 *
 * The e2e file (tests/e2e/calendar-events-api.test.js) drives the real handler
 * over an in-memory table. This file pins the pieces underneath it: the pure
 * parameter builders (so the index name, the key conditions, the condition
 * expression and the response allow-list are asserted against the exact object
 * the SDK would receive), the range/limit rules, the paging loop, the error
 * translation, and the re-scan lifecycle preserve.
 *
 * Every DynamoDB seam is injected. Nothing here constructs a client.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  ATTENTION_INDEX,
  DEFAULT_UPCOMING_LIMIT,
  EVENT_ID_PATTERN,
  EVENT_STATUS,
  EventNotFoundError,
  EventValidationError,
  LIFECYCLE_ATTRIBUTES,
  MAX_RANGE_DAYS,
  MAX_RANGE_ITEMS,
  MAX_UPCOMING_LIMIT,
  PUBLIC_EVENT_FIELDS,
  STARTS_AT_INDEX,
  acknowledgeEvent,
  applyPreservedLifecycle,
  attentionKeyForUser,
  buildAttentionQueryParams,
  buildEventUpdateParams,
  buildLifecycleGetParams,
  buildRangeQueryParams,
  chunkKeys,
  clampUpcomingLimit,
  currentMonthRange,
  deriveEventId,
  dismissEvent,
  isEventId,
  isOverdue,
  parseRangeBound,
  queryEventsInRange,
  queryUpcomingEvents,
  readLifecycleStates,
  requireEventId,
  resolveRange,
  restoreEvent,
  storeEvents,
  toEventJson,
  toUpcomingJson,
} from '../../src/lambda/calendar/backend/events.mjs';

import { parseEventActionPath } from '../../src/lambda/calendar/index.mjs';

const TABLE = 'test-calendar-events';
const USER = 'google#1';
const ID = 'a'.repeat(64);

/** A conditional-check failure exactly as the SDK raises it. */
function conditionalCheckFailure() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('TASK-009 unit: eventId validation', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    assert.equal(isEventId(ID), true);
    assert.equal(requireEventId(ID), ID);
    assert.equal(EVENT_ID_PATTERN.source, '^[0-9a-f]{64}$');
    assert.equal(EVENT_ID_PATTERN.flags, '', 'an `i` flag would let an uppercase id through');
    // A real derived id must satisfy the pattern the route enforces.
    assert.equal(isEventId(deriveEventId({ sourceMessageId: 'm1', title: 'T', startsAt: '2026-09-04T09:00:00.000Z' })), true);
  });

  const rejected = [
    ['uppercase', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex character', `${'a'.repeat(63)}g`],
    ['path traversal', '../../etc/passwd'],
    ['leading whitespace', ` ${'a'.repeat(64)}`],
    ['trailing newline', `${'a'.repeat(64)}\n`],
    ['empty string', ''],
    ['null', null],
    ['number', 123],
    ['object', { toString: () => 'a'.repeat(64) }],
  ];

  for (const [why, value] of rejected) {
    it(`rejects ${why}`, () => {
      assert.equal(isEventId(value), false);
      assert.throws(
        () => requireEventId(value),
        (err) => {
          assert.ok(err instanceof EventValidationError, `expected EventValidationError, got ${err?.name}`);
          assert.equal(err.name, 'EventValidationError');
          assert.equal(err.field, 'eventId');
          assert.match(err.message, /64 lowercase hexadecimal characters/);
          if (typeof value === 'string' && value.length > 0) {
            assert.ok(!err.message.includes(value), 'the message must not echo the offending value');
          }
          return true;
        }
      );
    });
  }
});

describe('TASK-009 unit: range resolution', () => {
  it('defaults to the current UTC calendar month when both bounds are omitted', () => {
    const range = resolveRange({}, { now: () => Date.parse('2026-09-17T23:30:00.000Z') });
    assert.equal(range.from, '2026-09-01');
    assert.equal(range.to, '2026-09-30');
    assert.equal(range.fromIso, '2026-09-01T00:00:00.000Z');
    assert.equal(range.toIso, '2026-09-30T23:59:59.999Z');
    assert.equal(range.spanDays, 30);
  });

  it('gets February right in a leap year and in a common year', () => {
    assert.deepEqual(currentMonthRange(Date.parse('2028-02-10T00:00:00.000Z')), { from: '2028-02-01', to: '2028-02-29' });
    assert.deepEqual(currentMonthRange(Date.parse('2026-02-10T00:00:00.000Z')), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(currentMonthRange(Date.parse('2026-12-31T23:59:00.000Z')), { from: '2026-12-01', to: '2026-12-31' });
  });

  it('fills the missing bound from the supplied bound\'s own month', () => {
    const fromOnly = resolveRange({ from: '2026-11-09' });
    assert.deepEqual([fromOnly.from, fromOnly.to], ['2026-11-09', '2026-11-30']);

    const toOnly = resolveRange({ to: '2026-11-09' });
    assert.deepEqual([toOnly.from, toOnly.to], ['2026-11-01', '2026-11-09']);
  });

  it('expands the `to` bound to the last millisecond of its day', () => {
    const range = resolveRange({ from: '2026-09-01', to: '2026-09-30' });
    assert.equal(range.toIso, '2026-09-30T23:59:59.999Z');
    assert.ok(range.toIso > '2026-09-30T23:30:00.000Z', 'an evening event on the final day must fall inside the BETWEEN');
  });

  it('treats an empty or whitespace bound as omitted rather than as junk', () => {
    const range = resolveRange({ from: '', to: '   ' }, { now: () => Date.parse('2026-09-17T00:00:00.000Z') });
    assert.deepEqual([range.from, range.to], ['2026-09-01', '2026-09-30']);
  });

  it('refuses a reversed range, naming `from`', () => {
    assert.throws(
      () => resolveRange({ from: '2026-09-30', to: '2026-09-01' }),
      (err) => {
        assert.equal(err.name, 'EventValidationError');
        assert.equal(err.field, 'from');
        assert.match(err.message, /must not be later than to/);
        return true;
      }
    );
  });

  it('refuses an unparseable bound, naming the field', () => {
    assert.throws(
      () => resolveRange({ from: 'not-a-date', to: '2026-09-30' }),
      (err) => err.name === 'EventValidationError' && err.field === 'from'
    );
    assert.throws(
      () => resolveRange({ from: '2026-09-01', to: '30/09/2026' }),
      (err) => err.name === 'EventValidationError' && err.field === 'to'
    );
    assert.throws(
      () => resolveRange({ from: '2026-9-1', to: '2026-09-30' }),
      (err) => err.name === 'EventValidationError' && err.field === 'from'
    );
    assert.throws(() => parseRangeBound('2026-13-01', 'from'), EventValidationError);
  });

  it('refuses an impossible day rather than rolling it into the next month', () => {
    // parseRangeBound's own docblock: "2026-02-31 matches [the pattern] and is
    // not a date - so the value is also parsed, which rejects impossible days".
    assert.throws(
      () => parseRangeBound('2026-02-31', 'from'),
      (err) => err?.name === 'EventValidationError',
      `2026-02-31 was accepted; resolveRange produced ${JSON.stringify(resolveRange({ from: '2026-02-31', to: '2026-03-05' }))}`
    );
    assert.throws(() => parseRangeBound('2026-04-31', 'to'), (err) => err?.name === 'EventValidationError');
  });

  it('accepts a span of exactly the maximum and refuses one day more', () => {
    assert.equal(MAX_RANGE_DAYS, 93);
    const widest = resolveRange({ from: '2026-09-01', to: '2026-12-02' });
    assert.equal(widest.spanDays, 93, 'the span is inclusive of both ends');

    assert.throws(
      () => resolveRange({ from: '2026-09-01', to: '2026-12-03' }),
      (err) => {
        assert.equal(err.name, 'EventValidationError');
        assert.equal(err.field, 'to');
        assert.match(err.message, /93 days/);
        return true;
      }
    );
    assert.throws(() => resolveRange({ from: '2026-01-01', to: '2026-12-31' }), EventValidationError);
  });

  it('treats a single day as a span of one', () => {
    const range = resolveRange({ from: '2026-09-04', to: '2026-09-04' });
    assert.equal(range.spanDays, 1);
    assert.equal(range.fromIso, '2026-09-04T00:00:00.000Z');
    assert.equal(range.toIso, '2026-09-04T23:59:59.999Z');
  });
});

describe('TASK-009 unit: upcoming limit clamping', () => {
  it('defaults anything unusable and clamps above the maximum', () => {
    assert.equal(DEFAULT_UPCOMING_LIMIT, 20);
    assert.equal(MAX_UPCOMING_LIMIT, 100);
    for (const value of [null, undefined, '', 'abc', NaN, 0, -5, {}]) {
      assert.equal(clampUpcomingLimit(value), 20, `${JSON.stringify(value)} should fall back to the default`);
    }
    assert.equal(clampUpcomingLimit(1), 1);
    assert.equal(clampUpcomingLimit('7'), 7);
    assert.equal(clampUpcomingLimit(7.9), 7);
    assert.equal(clampUpcomingLimit(100), 100);
    assert.equal(clampUpcomingLimit(101), 100);
    assert.equal(clampUpcomingLimit(100000), 100);
    assert.equal(clampUpcomingLimit(Infinity), 20, 'a non-finite value is not a page size');
  });
});

describe('TASK-009 unit: query parameter builders', () => {
  it('builds the month view against StartsAtIndex with a BETWEEN on startsAt', () => {
    const params = buildRangeQueryParams({
      tableName: TABLE,
      userId: USER,
      fromIso: '2026-09-01T00:00:00.000Z',
      toIso: '2026-09-30T23:59:59.999Z',
    });

    assert.equal(params.TableName, TABLE);
    assert.equal(params.IndexName, STARTS_AT_INDEX);
    assert.equal(params.IndexName, 'StartsAtIndex');
    assert.equal(params.KeyConditionExpression, '#userId = :userId AND #startsAt BETWEEN :from AND :to');
    assert.deepEqual(params.ExpressionAttributeNames, { '#userId': 'userId', '#startsAt': 'startsAt' });
    assert.deepEqual(params.ExpressionAttributeValues, {
      ':userId': USER,
      ':from': '2026-09-01T00:00:00.000Z',
      ':to': '2026-09-30T23:59:59.999Z',
    });
    assert.equal(params.ScanIndexForward, true);
    assert.equal(params.FilterExpression, undefined, 'tenancy is the hash key, not a filter');
    assert.equal(params.Limit, undefined);
    assert.equal(params.ExclusiveStartKey, undefined);
    assert.equal('Segment' in params, false, 'a Query has no Scan parallelism knobs');
  });

  it('carries Limit and ExclusiveStartKey only when they are usable', () => {
    const paged = buildRangeQueryParams({
      tableName: TABLE,
      userId: USER,
      fromIso: 'a',
      toIso: 'b',
      limit: 12.7,
      exclusiveStartKey: { userId: USER, eventId: ID },
    });
    assert.equal(paged.Limit, 12);
    assert.deepEqual(paged.ExclusiveStartKey, { userId: USER, eventId: ID });

    const unpaged = buildRangeQueryParams({ tableName: TABLE, userId: USER, fromIso: 'a', toIso: 'b', limit: 0 });
    assert.equal(unpaged.Limit, undefined);
  });

  it('builds the attention list against the sparse AttentionIndex, ascending', () => {
    const params = buildAttentionQueryParams({ tableName: TABLE, attentionKey: 'google#1#pending', limit: 20 });

    assert.equal(params.IndexName, ATTENTION_INDEX);
    assert.equal(params.IndexName, 'AttentionIndex');
    assert.equal(params.KeyConditionExpression, '#attentionKey = :attentionKey');
    assert.deepEqual(params.ExpressionAttributeValues, { ':attentionKey': 'google#1#pending' });
    assert.equal(params.ScanIndexForward, true, 'soonest dueBy first');
    assert.equal(params.FilterExpression, undefined, 'handled rows are absent by construction, not filtered out');
    assert.equal(params.Limit, 20);
  });

  it('derives the attention hash key from the userId and refuses an empty one', () => {
    assert.equal(attentionKeyForUser('google#1'), 'google#1#pending');
    assert.throws(() => attentionKeyForUser(''), /userId is required/);
    assert.throws(() => attentionKeyForUser(undefined), /userId is required/);
  });
});

describe('TASK-009 unit: the response projection is an allow-list', () => {
  const raw = {
    userId: USER,
    eventId: ID,
    title: 'Photo day',
    description: 'Full uniform',
    startsAt: '2026-09-04T09:00:00.000Z',
    endsAt: '2026-09-04T10:00:00.000Z',
    allDay: false,
    location: 'Hall',
    category: 'other',
    needsAttention: true,
    actionRequired: 'Return the form',
    dueBy: '2026-09-01T00:00:00.000Z',
    status: 'pending',
    confidence: 0.8,
    sourceSubject: 'Photo day',
    sourceFrom: 'office@school.edu',
    sourceReceivedAt: '2026-08-20T00:00:00.000Z',
    // None of the following may ever be published.
    sourceMessageId: 'gmail-handle-abc',
    attentionKey: 'google#1#pending',
    ttl: 1800000000,
    refreshTokenEnc: 'ENCRYPTED',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };

  it('copies exactly the sixteen published fields and nothing else', () => {
    const json = toEventJson(raw);
    assert.deepEqual(Object.keys(json).sort(), [...PUBLIC_EVENT_FIELDS].sort());
    assert.equal(PUBLIC_EVENT_FIELDS.includes('sourceMessageId'), false);
    for (const banned of ['sourceMessageId', 'attentionKey', 'ttl', 'refreshTokenEnc', 'userId', 'createdAt', 'updatedAt']) {
      assert.equal(banned in json, false, `${banned} must not be published`);
    }
    assert.ok(!JSON.stringify(json).includes('gmail-handle-abc'));
    assert.equal(json.sourceSubject, 'Photo day', 'provenance the UI is allowed to show');
    assert.equal(json.sourceFrom, 'office@school.edu');
  });

  it('gives absent optional attributes a stable null and sane defaults', () => {
    const json = toEventJson({ eventId: ID });
    assert.equal(json.title, null);
    assert.equal(json.description, null);
    assert.equal(json.dueBy, null);
    assert.equal(json.allDay, false);
    assert.equal(json.needsAttention, false);
    assert.equal(json.status, EVENT_STATUS.PENDING);
    assert.equal(json.category, 'other');
    assert.equal(json.confidence, 0);
  });

  it('returns null for a missing item', () => {
    assert.equal(toEventJson(null), null);
    assert.equal(toEventJson(undefined), null);
    assert.equal(toEventJson('a string'), null);
    assert.equal(toUpcomingJson(null, Date.now()), null);
  });

  it('computes overdue against the supplied clock and adds it to the upcoming shape', () => {
    const nowMs = Date.parse('2026-09-02T00:00:00.000Z');
    assert.equal(isOverdue({ dueBy: '2026-09-01T00:00:00.000Z' }, nowMs), true);
    assert.equal(isOverdue({ dueBy: '2026-09-03T00:00:00.000Z' }, nowMs), false);
    assert.equal(isOverdue({ dueBy: nowMs === 0 ? null : '2026-09-02T00:00:00.000Z' }, nowMs), false, 'a deadline exactly now has not passed');
    assert.equal(isOverdue({ dueBy: null }, nowMs), false, 'no deadline is not an overdue deadline');
    assert.equal(isOverdue({ dueBy: 'rubbish' }, nowMs), false);

    const upcoming = toUpcomingJson(raw, nowMs);
    assert.equal(upcoming.overdue, true);
    assert.deepEqual(Object.keys(upcoming).sort(), [...PUBLIC_EVENT_FIELDS, 'overdue'].sort());
  });
});

describe('TASK-009 unit: the mutation parameter builder', () => {
  it('always emits the tenancy condition and keys the row by userId + eventId', () => {
    const params = buildEventUpdateParams({
      tableName: TABLE,
      userId: USER,
      eventId: ID,
      set: { status: 'acknowledged', acknowledgedAt: '2026-08-20T00:00:00.000Z' },
      remove: ['attentionKey'],
    });

    assert.equal(params.ConditionExpression, 'attribute_exists(#userId) AND #userId = :userId');
    assert.equal(params.ExpressionAttributeNames['#userId'], 'userId');
    assert.equal(params.ExpressionAttributeValues[':userId'], USER);
    assert.deepEqual(params.Key, { userId: USER, eventId: ID });
    assert.equal(params.TableName, TABLE);
    assert.equal(params.ReturnValues, 'ALL_NEW');
  });

  it('sets and removes in ONE expression, with placeholders for reserved words', () => {
    const params = buildEventUpdateParams({
      tableName: TABLE,
      userId: USER,
      eventId: ID,
      set: { status: 'acknowledged' },
      remove: ['attentionKey'],
    });

    assert.match(params.UpdateExpression, /^SET #s0 = :s0 REMOVE #r0$/);
    assert.equal(params.ExpressionAttributeNames['#s0'], 'status');
    assert.equal(params.ExpressionAttributeNames['#r0'], 'attentionKey');
    assert.equal(params.ExpressionAttributeValues[':s0'], 'acknowledged');
    assert.ok(
      !/\bstatus\b/.test(params.UpdateExpression),
      '`status` is a DynamoDB reserved word and must not appear literally in the expression'
    );
  });

  it('drops undefined values rather than writing them', () => {
    const params = buildEventUpdateParams({
      tableName: TABLE,
      userId: USER,
      eventId: ID,
      set: { status: 'pending', dueBy: undefined },
    });
    assert.equal(params.UpdateExpression, 'SET #s0 = :s0');
    assert.equal(Object.values(params.ExpressionAttributeNames).includes('dueBy'), false);
  });

  it('refuses to build an update with nothing to do', () => {
    assert.throws(
      () => buildEventUpdateParams({ tableName: TABLE, userId: USER, eventId: ID }),
      /nothing to set or remove/
    );
  });
});

describe('TASK-009 unit: the range query paging loop', () => {
  function pagingQuery(pages) {
    const calls = [];
    let index = 0;
    return {
      calls,
      query: async (params) => {
        calls.push(params);
        const page = pages[index] || { items: [], lastEvaluatedKey: null };
        index += 1;
        return page;
      },
    };
  }

  it('follows LastEvaluatedKey and concatenates the pages', async () => {
    const { calls, query } = pagingQuery([
      { items: [{ eventId: 'one', startsAt: '2026-09-02T00:00:00.000Z' }], lastEvaluatedKey: { eventId: 'one' } },
      { items: [{ eventId: 'two', startsAt: '2026-09-03T00:00:00.000Z' }], lastEvaluatedKey: null },
    ]);

    const result = await queryEventsInRange(
      { userId: USER, from: '2026-09-01', to: '2026-09-30', tableName: TABLE },
      { query, log: () => {} }
    );

    assert.equal(result.count, 2);
    assert.equal(result.pages, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.events.map((e) => e.eventId), ['one', 'two']);
    assert.deepEqual(calls[1].ExclusiveStartKey, { eventId: 'one' });
  });

  it('stops at maxItems and reports truncated, having observed the extra item', async () => {
    const overflow = Array.from({ length: 6 }, (_, i) => ({ eventId: `e${i}`, startsAt: '2026-09-02T00:00:00.000Z' }));
    const { calls, query } = pagingQuery([{ items: overflow, lastEvaluatedKey: null }]);

    const result = await queryEventsInRange(
      { userId: USER, from: '2026-09-01', to: '2026-09-30', tableName: TABLE },
      { query, maxItems: 5, log: () => {} }
    );

    assert.equal(result.count, 5);
    assert.equal(result.truncated, true);
    assert.equal(calls[0].Limit, 6, 'the loop asks for cap + 1 so "there is more" is observed, not inferred');
  });

  it('does not claim truncation when the result exactly fills the cap', async () => {
    const exact = Array.from({ length: 5 }, (_, i) => ({ eventId: `e${i}`, startsAt: '2026-09-02T00:00:00.000Z' }));
    const { query } = pagingQuery([{ items: exact, lastEvaluatedKey: null }]);

    const result = await queryEventsInRange(
      { userId: USER, from: '2026-09-01', to: '2026-09-30', tableName: TABLE },
      { query, maxItems: 5, log: () => {} }
    );

    assert.equal(result.count, 5);
    assert.equal(result.truncated, false);
  });

  it('stops at the page ceiling rather than looping forever', async () => {
    let calls = 0;
    const query = async () => {
      calls += 1;
      return { items: [{ eventId: `e${calls}`, startsAt: '2026-09-02T00:00:00.000Z' }], lastEvaluatedKey: { eventId: `e${calls}` } };
    };

    const result = await queryEventsInRange(
      { userId: USER, from: '2026-09-01', to: '2026-09-30', tableName: TABLE },
      { query, maxPages: 3, log: () => {} }
    );

    assert.equal(calls, 3);
    assert.equal(result.pages, 3);
    assert.equal(result.truncated, true);
  });

  it('validates the range before issuing any query', async () => {
    let calls = 0;
    const query = async () => {
      calls += 1;
      return { items: [], lastEvaluatedKey: null };
    };

    await assert.rejects(
      () => queryEventsInRange({ userId: USER, from: '2026-12-31', to: '2026-01-01', tableName: TABLE }, { query, log: () => {} }),
      (err) => err.name === 'EventValidationError'
    );
    assert.equal(calls, 0);
  });

  it('refuses to run without a session-derived userId', async () => {
    await assert.rejects(
      () => queryEventsInRange({ tableName: TABLE }, { query: async () => ({ items: [] }), log: () => {} }),
      /userId is required/
    );
  });

  it('caps maxItems at the module maximum even when a caller asks for more', async () => {
    const { calls, query } = pagingQuery([{ items: [], lastEvaluatedKey: null }]);
    await queryEventsInRange(
      { userId: USER, from: '2026-09-01', to: '2026-09-30', tableName: TABLE },
      { query, maxItems: 100000, log: () => {} }
    );
    assert.equal(calls[0].Limit, MAX_RANGE_ITEMS + 1);
  });
});

describe('TASK-009 unit: the attention query', () => {
  it('asks the sparse index for this user and stamps overdue from one clock reading', async () => {
    const calls = [];
    const query = async (params) => {
      calls.push(params);
      return {
        items: [
          { eventId: 'late', dueBy: '2026-08-19T00:00:00.000Z' },
          { eventId: 'soon', dueBy: '2026-08-22T00:00:00.000Z' },
        ],
        lastEvaluatedKey: null,
      };
    };
    let clockReads = 0;
    const now = () => {
      clockReads += 1;
      return Date.parse('2026-08-20T00:00:00.000Z');
    };

    const result = await queryUpcomingEvents({ userId: USER, tableName: TABLE }, { query, now, log: () => {} });

    assert.equal(calls[0].IndexName, 'AttentionIndex');
    assert.equal(calls[0].ExpressionAttributeValues[':attentionKey'], 'google#1#pending');
    assert.equal(calls[0].ScanIndexForward, true);
    assert.equal(result.limit, 20);
    assert.equal(result.events[0].overdue, true);
    assert.equal(result.events[1].overdue, false);
    assert.equal(clockReads, 1, 'two items with the same deadline must not disagree about being overdue');
  });

  it('clamps the caller limit and reports it back', async () => {
    const calls = [];
    const query = async (params) => {
      calls.push(params);
      return { items: [], lastEvaluatedKey: null };
    };

    const result = await queryUpcomingEvents({ userId: USER, limit: '5000', tableName: TABLE }, { query, log: () => {} });
    assert.equal(result.limit, 100);
    assert.equal(calls[0].Limit, 100);
  });

  it('truncates at the limit and says so when the index has more', async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ eventId: `e${i}`, dueBy: '2026-08-20T00:00:00.000Z' }));
    const query = async () => ({ items, lastEvaluatedKey: { eventId: 'e3' } });

    const result = await queryUpcomingEvents({ userId: USER, limit: 3, tableName: TABLE }, { query, log: () => {} });

    assert.equal(result.count, 3);
    assert.equal(result.truncated, true);
  });

  it('refuses to run without a session-derived userId', async () => {
    await assert.rejects(
      () => queryUpcomingEvents({ tableName: TABLE }, { query: async () => ({ items: [] }), log: () => {} }),
      /userId is required/
    );
  });
});

describe('TASK-009 unit: acknowledge, dismiss and restore', () => {
  it('acknowledge sets the status, stamps acknowledgedAt and removes attentionKey in one update', async () => {
    const updates = [];
    const updateEvent = async (params) => {
      updates.push(params);
      return { userId: USER, eventId: ID, status: 'acknowledged', title: 'Photo day' };
    };

    const result = await acknowledgeEvent(
      { userId: USER, eventId: ID, tableName: TABLE },
      { updateEvent, now: () => Date.parse('2026-08-20T05:00:00.000Z'), log: () => {} }
    );

    assert.equal(updates.length, 1);
    const names = updates[0].ExpressionAttributeNames;
    const values = updates[0].ExpressionAttributeValues;
    const setAttributes = Object.fromEntries(
      Object.entries(names)
        .filter(([placeholder]) => placeholder.startsWith('#s'))
        .map(([placeholder, attribute]) => [attribute, values[`:${placeholder.slice(1)}`]])
    );
    assert.equal(setAttributes.status, 'acknowledged');
    assert.equal(setAttributes.acknowledgedAt, '2026-08-20T05:00:00.000Z');
    assert.equal(setAttributes.updatedAt, '2026-08-20T05:00:00.000Z');
    assert.equal(setAttributes.dismissedAt, undefined, 'acknowledge must not stamp a dismissal');
    assert.equal(Object.values(names).includes('attentionKey'), true);
    assert.match(updates[0].UpdateExpression, /REMOVE/);
    assert.equal(result.status, 'acknowledged');
    assert.equal('attentionKey' in result, false, 'the response is the public projection');
  });

  it('dismiss stamps dismissedAt instead', async () => {
    const updates = [];
    const updateEvent = async (params) => {
      updates.push(params);
      return { userId: USER, eventId: ID, status: 'dismissed' };
    };

    await dismissEvent(
      { userId: USER, eventId: ID, tableName: TABLE },
      { updateEvent, now: () => Date.parse('2026-08-20T05:00:00.000Z'), log: () => {} }
    );

    const names = updates[0].ExpressionAttributeNames;
    const attributes = Object.values(names);
    assert.equal(attributes.includes('dismissedAt'), true);
    assert.equal(attributes.includes('acknowledgedAt'), false);
    assert.equal(attributes.includes('attentionKey'), true);
  });

  it('translates a ConditionalCheckFailedException into EventNotFoundError, never a 403-shaped error', async () => {
    const updateEvent = async () => {
      throw conditionalCheckFailure();
    };

    for (const mutate of [acknowledgeEvent, dismissEvent]) {
      await assert.rejects(
        () => mutate({ userId: USER, eventId: ID, tableName: TABLE }, { updateEvent, log: () => {} }),
        (err) => {
          assert.ok(err instanceof EventNotFoundError, `expected EventNotFoundError, got ${err?.name}`);
          assert.equal(err.name, 'EventNotFoundError');
          assert.equal(err.message, 'Event not found');
          assert.ok(!/forbidden|denied|another/i.test(err.message), 'the message must not confirm the row belongs to someone else');
          return true;
        }
      );
    }
  });

  it('lets an unexpected DynamoDB error through rather than disguising it as a 404', async () => {
    const updateEvent = async () => {
      throw Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' });
    };

    await assert.rejects(
      () => acknowledgeEvent({ userId: USER, eventId: ID, tableName: TABLE }, { updateEvent, log: () => {} }),
      (err) => err.name === 'ProvisionedThroughputExceededException'
    );
  });

  it('validates the eventId before any DynamoDB call', async () => {
    let calls = 0;
    const updateEvent = async () => {
      calls += 1;
      return {};
    };
    const getEvent = async () => {
      calls += 1;
      return null;
    };

    for (const mutate of [acknowledgeEvent, dismissEvent, restoreEvent]) {
      await assert.rejects(
        () => mutate({ userId: USER, eventId: '../../etc/passwd', tableName: TABLE }, { updateEvent, getEvent, log: () => {} }),
        (err) => err.name === 'EventValidationError' && err.field === 'eventId'
      );
    }
    assert.equal(calls, 0, 'a malformed id must cost no DynamoDB call at all');
  });

  it('restore re-adds attentionKey (with a dueBy) only when needsAttention is true', async () => {
    const updates = [];
    const updateEvent = async (params) => {
      updates.push(params);
      return { userId: USER, eventId: ID, status: 'pending' };
    };
    const getEvent = async () => ({
      userId: USER,
      eventId: ID,
      needsAttention: true,
      status: 'dismissed',
      startsAt: '2026-09-10T09:00:00.000Z',
      dueBy: '2026-09-03T00:00:00.000Z',
    });

    await restoreEvent({ userId: USER, eventId: ID, tableName: TABLE }, { getEvent, updateEvent, log: () => {} });

    const names = updates[0].ExpressionAttributeNames;
    const values = updates[0].ExpressionAttributeValues;
    const setAttributes = Object.fromEntries(
      Object.entries(names)
        .filter(([placeholder]) => placeholder.startsWith('#s'))
        .map(([placeholder, attribute]) => [attribute, values[`:${placeholder.slice(1)}`]])
    );
    const removed = Object.entries(names)
      .filter(([placeholder]) => placeholder.startsWith('#r'))
      .map(([, attribute]) => attribute);

    assert.equal(setAttributes.status, 'pending');
    assert.equal(setAttributes.attentionKey, 'google#1#pending');
    assert.equal(setAttributes.dueBy, '2026-09-03T00:00:00.000Z', 'a GSI needs BOTH keys or the row is invisible in the list');
    assert.deepEqual(removed.sort(), ['acknowledgedAt', 'dismissedAt']);
  });

  it('restore falls back to the start instant when the event carried no deadline', async () => {
    const updates = [];
    const updateEvent = async (params) => {
      updates.push(params);
      return { userId: USER, eventId: ID, status: 'pending' };
    };
    const getEvent = async () => ({
      userId: USER,
      eventId: ID,
      needsAttention: true,
      status: 'dismissed',
      startsAt: '2026-09-10T09:00:00.000Z',
    });

    await restoreEvent({ userId: USER, eventId: ID, tableName: TABLE }, { getEvent, updateEvent, log: () => {} });

    const names = updates[0].ExpressionAttributeNames;
    const values = updates[0].ExpressionAttributeValues;
    const dueByPlaceholder = Object.entries(names).find(([, attribute]) => attribute === 'dueBy')?.[0];
    assert.ok(dueByPlaceholder, 'restore must supply the index range key');
    assert.equal(values[`:${dueByPlaceholder.slice(1)}`], '2026-09-10T09:00:00.000Z');
  });

  it('restore of an informational event goes back to pending WITHOUT rejoining the attention list', async () => {
    const updates = [];
    const updateEvent = async (params) => {
      updates.push(params);
      return { userId: USER, eventId: ID, status: 'pending' };
    };
    const getEvent = async () => ({ userId: USER, eventId: ID, needsAttention: false, status: 'dismissed', startsAt: '2026-09-10T09:00:00.000Z' });

    await restoreEvent({ userId: USER, eventId: ID, tableName: TABLE }, { getEvent, updateEvent, log: () => {} });

    const names = updates[0].ExpressionAttributeNames;
    const setAttributes = Object.entries(names).filter(([p]) => p.startsWith('#s')).map(([, a]) => a);
    const removed = Object.entries(names).filter(([p]) => p.startsWith('#r')).map(([, a]) => a);
    assert.equal(setAttributes.includes('attentionKey'), false);
    assert.equal(removed.includes('attentionKey'), true);
  });

  it('restore reads the row keyed by BOTH userId and eventId, and 404s when it is absent', async () => {
    const gets = [];
    let updates = 0;
    const getEvent = async (args) => {
      gets.push(args);
      return null;
    };
    const updateEvent = async () => {
      updates += 1;
      return {};
    };

    await assert.rejects(
      () => restoreEvent({ userId: USER, eventId: ID, tableName: TABLE }, { getEvent, updateEvent, log: () => {} }),
      (err) => err.name === 'EventNotFoundError'
    );
    assert.deepEqual(gets, [{ tableName: TABLE, userId: USER, eventId: ID }]);
    assert.equal(updates, 0, 'a missing row must not be recreated by an UpdateItem');
  });

  it('restore still fails closed when the row is deleted between the read and the write', async () => {
    const getEvent = async () => ({ userId: USER, eventId: ID, needsAttention: true, status: 'dismissed', startsAt: '2026-09-10T09:00:00.000Z' });
    const updateEvent = async () => {
      throw conditionalCheckFailure();
    };

    await assert.rejects(
      () => restoreEvent({ userId: USER, eventId: ID, tableName: TABLE }, { getEvent, updateEvent, log: () => {} }),
      (err) => err.name === 'EventNotFoundError'
    );
  });
});

describe('TASK-009 unit: the re-scan lifecycle pre-read', () => {
  it('projects only the lifecycle attributes, through placeholders', () => {
    const params = buildLifecycleGetParams({ tableName: TABLE, keys: [{ userId: USER, eventId: ID, title: 'leaked' }] });
    const request = params.RequestItems[TABLE];

    assert.deepEqual(request.Keys, [{ userId: USER, eventId: ID }], 'only key attributes belong in a BatchGet key');
    assert.deepEqual(Object.values(request.ExpressionAttributeNames).sort(), [...LIFECYCLE_ATTRIBUTES].sort());
    assert.ok(!/\bstatus\b/.test(request.ProjectionExpression), '`status` is reserved and must go through a placeholder');
    assert.equal(request.ProjectionExpression.split(',').length, LIFECYCLE_ATTRIBUTES.length);
    assert.equal(LIFECYCLE_ATTRIBUTES.includes('title'), false, 'the write path has no use for titles');
  });

  it('chunks keys at DynamoDB\'s hard limit of 100', () => {
    const keys = Array.from({ length: 250 }, (_, i) => ({ userId: USER, eventId: `e${i}` }));
    const chunks = chunkKeys(keys);
    assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
    assert.equal(chunkKeys(keys, 500).length, 3, 'a caller cannot raise the API cap');
    assert.deepEqual(chunkKeys([]), []);
  });

  it('retries UnprocessedKeys through the injected sleep', async () => {
    const calls = [];
    const batchGet = async ({ keys }) => {
      calls.push(keys.length);
      if (calls.length === 1) {
        return { items: [{ eventId: 'one', status: 'acknowledged' }], unprocessedKeys: [{ userId: USER, eventId: 'two' }] };
      }
      return { items: [{ eventId: 'two', status: 'dismissed' }], unprocessedKeys: [] };
    };
    const slept = [];

    const states = await readLifecycleStates(
      { items: [{ userId: USER, eventId: 'one' }, { userId: USER, eventId: 'two' }], tableName: TABLE },
      { batchGet, sleep: async (ms) => slept.push(ms), random: () => 0.5, log: () => {} }
    );

    assert.deepEqual(calls, [2, 1]);
    assert.equal(slept.length, 1);
    assert.equal(states.get('one').status, 'acknowledged');
    assert.equal(states.get('two').status, 'dismissed');
  });

  it('gives up after the attempt ceiling and logs what it could not read', async () => {
    const batchGet = async () => ({ items: [], unprocessedKeys: [{ userId: USER, eventId: 'one' }] });
    const lines = [];

    const states = await readLifecycleStates(
      { items: [{ userId: USER, eventId: 'one' }], tableName: TABLE },
      { batchGet, sleep: async () => {}, random: () => 0, maxAttempts: 2, log: (message, fields) => lines.push({ message, fields }) }
    );

    assert.equal(states.size, 0);
    const incomplete = lines.find((line) => line.message === 'calendar.events.lifecycle_read_incomplete');
    assert.ok(incomplete, `expected lifecycle_read_incomplete, got ${JSON.stringify(lines.map((l) => l.message))}`);
    assert.equal(incomplete.fields.attempts, 2);
  });

  it('reads nothing at all when there is nothing to write', async () => {
    let calls = 0;
    const states = await readLifecycleStates({ items: [], tableName: TABLE }, { batchGet: async () => { calls += 1; return { items: [] }; }, log: () => {} });
    assert.equal(states.size, 0);
    assert.equal(calls, 0);
  });
});

describe('TASK-009 unit: applyPreservedLifecycle', () => {
  const fresh = {
    userId: USER,
    eventId: ID,
    status: 'pending',
    attentionKey: 'google#1#pending',
    dueBy: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-08-25T00:00:00.000Z',
    title: 'Museum excursion',
  };

  it('returns the SAME object when there is nothing to preserve', () => {
    assert.equal(applyPreservedLifecycle(fresh, undefined), fresh);
    assert.equal(applyPreservedLifecycle(fresh, null), fresh);
    assert.equal(applyPreservedLifecycle(fresh, { status: 'pending' }), fresh, 'a pending row carries no user decision');
    assert.equal(applyPreservedLifecycle(fresh, { status: 'something-else' }), fresh);
  });

  it('carries an acknowledgement forward and drops attentionKey so the row stays out of the sparse index', () => {
    const merged = applyPreservedLifecycle(fresh, {
      status: 'acknowledged',
      acknowledgedAt: '2026-08-26T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    assert.notEqual(merged, fresh);
    assert.equal(merged.status, 'acknowledged');
    assert.equal(merged.attentionKey, undefined, 'a handled event must not rejoin AttentionIndex');
    assert.equal(merged.acknowledgedAt, '2026-08-26T00:00:00.000Z');
    assert.equal(merged.createdAt, '2026-08-01T00:00:00.000Z', 'first-seen belongs to the first extraction');
    assert.equal(merged.dueBy, '2026-09-03T00:00:00.000Z', 'the month view still shows the deadline');
    assert.equal(merged.title, 'Museum excursion', 'the re-scanned content is still applied');
  });

  it('carries a dismissal forward too', () => {
    const merged = applyPreservedLifecycle(fresh, { status: 'dismissed', dismissedAt: '2026-08-26T00:00:00.000Z' });
    assert.equal(merged.status, 'dismissed');
    assert.equal(merged.attentionKey, undefined);
    assert.equal(merged.dismissedAt, '2026-08-26T00:00:00.000Z');
  });

  it('keeps the stored deadline when the re-extraction lost it', () => {
    const withoutDue = { ...fresh, dueBy: undefined };
    const merged = applyPreservedLifecycle(withoutDue, { status: 'acknowledged', dueBy: '2026-09-01T00:00:00.000Z' });
    assert.equal(merged.dueBy, '2026-09-01T00:00:00.000Z');
  });
});

describe('TASK-009 unit: storeEvents preserves the user\'s decisions', () => {
  const message = { id: 'msg-1', subject: 'Excursion', from: 'office@school.edu', receivedAt: '2026-08-18T01:00:00.000Z' };
  const modelEvent = { title: 'Museum excursion', startsAt: '2026-09-10T09:00:00.000Z', needsAttention: true, dueBy: '2026-09-03T00:00:00.000Z' };
  const nowMs = Date.parse('2026-08-18T02:00:00.000Z');

  it('pre-reads the exact keys it is about to write and carries an acknowledgement onto the rebuilt row', async () => {
    const written = [];
    const reads = [];
    const eventId = deriveEventId({ sourceMessageId: message.id, title: modelEvent.title, startsAt: modelEvent.startsAt });

    const result = await storeEvents(
      { userId: USER, message, events: [modelEvent], tableName: TABLE },
      {
        batchWrite: async ({ items }) => {
          written.push(...items);
          return { unprocessed: [] };
        },
        batchGet: async ({ keys }) => {
          reads.push(...keys);
          return { items: [{ eventId, status: 'acknowledged', acknowledgedAt: '2026-08-17T00:00:00.000Z', createdAt: '2026-08-16T00:00:00.000Z' }], unprocessedKeys: [] };
        },
        now: () => nowMs,
        log: () => {},
      }
    );

    assert.deepEqual(reads, [{ userId: USER, eventId }], 'key-scoped, never a partition scan');
    assert.equal(result.preserved, 1);
    assert.equal(written.length, 1);
    assert.equal(written[0].status, 'acknowledged');
    assert.equal(written[0].attentionKey, undefined, 'the rewritten row must not rejoin the attention list');
    assert.equal(written[0].acknowledgedAt, '2026-08-17T00:00:00.000Z');
    assert.equal(written[0].createdAt, '2026-08-16T00:00:00.000Z');
  });

  it('writes a pending row untouched when the stored row is still pending', async () => {
    const written = [];
    const eventId = deriveEventId({ sourceMessageId: message.id, title: modelEvent.title, startsAt: modelEvent.startsAt });

    const result = await storeEvents(
      { userId: USER, message, events: [modelEvent], tableName: TABLE },
      {
        batchWrite: async ({ items }) => {
          written.push(...items);
          return { unprocessed: [] };
        },
        batchGet: async () => ({ items: [{ eventId, status: 'pending' }], unprocessedKeys: [] }),
        now: () => nowMs,
        log: () => {},
      }
    );

    assert.equal(result.preserved, 0);
    assert.equal(written[0].status, 'pending');
    assert.equal(written[0].attentionKey, 'google#1#pending');
  });

  it('FAILS SOFT: a throwing pre-read still writes the row and logs lifecycle_read_failed', async () => {
    const written = [];
    const lines = [];

    const result = await storeEvents(
      { userId: USER, message, events: [modelEvent], tableName: TABLE },
      {
        batchWrite: async ({ items }) => {
          written.push(...items);
          return { unprocessed: [] };
        },
        batchGet: async () => {
          throw Object.assign(new Error('throughput'), { name: 'ProvisionedThroughputExceededException' });
        },
        now: () => nowMs,
        log: (message_, fields) => lines.push({ message: message_, fields }),
      }
    );

    assert.equal(result.written, 1, 'losing a brand-new event is worse than resurrecting a handled one');
    assert.equal(written.length, 1);
    const failure = lines.find((line) => line.message === 'calendar.events.lifecycle_read_failed');
    assert.ok(failure, `expected lifecycle_read_failed, got ${JSON.stringify(lines.map((l) => l.message))}`);
    assert.equal(failure.fields.errorName, 'ProvisionedThroughputExceededException');
    assert.ok(!JSON.stringify(failure.fields).includes('Museum excursion'), 'the log line must not carry event content');
  });

  it('skips the pre-read entirely when preserveHandled is false', async () => {
    let reads = 0;
    const result = await storeEvents(
      { userId: USER, message, events: [modelEvent], tableName: TABLE },
      {
        batchWrite: async () => ({ unprocessed: [] }),
        batchGet: async () => {
          reads += 1;
          return { items: [], unprocessedKeys: [] };
        },
        preserveHandled: false,
        now: () => nowMs,
        log: () => {},
      }
    );

    assert.equal(reads, 0, 'a first-ever scan has nothing to preserve and should not pay for a read');
    assert.equal(result.written, 1);
  });

  it('does not pre-read when the extraction produced nothing to write', async () => {
    let reads = 0;
    let writes = 0;
    const result = await storeEvents(
      { userId: USER, message, events: [{ title: '', startsAt: 'nonsense' }], tableName: TABLE },
      {
        batchWrite: async () => {
          writes += 1;
          return { unprocessed: [] };
        },
        batchGet: async () => {
          reads += 1;
          return { items: [], unprocessedKeys: [] };
        },
        now: () => nowMs,
        log: () => {},
      }
    );

    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(result.written, 0);
    assert.equal(result.skipped.length, 1);
  });
});

describe('TASK-009 unit: the IAM grant the pre-read needs', () => {
  // The lifecycle pre-read is a BatchGetItem. Without the action in the policy it
  // fails with AccessDenied at runtime, the fail-soft path swallows it, and the
  // re-scan silently degrades back to TASK-007's resurrect-on-rescan behaviour -
  // i.e. the ticket's headline acceptance criterion fails in production while
  // every unit test still passes. Terraform is not executable from a test, so
  // this is asserted on the policy document.
  it('grants dynamodb:BatchGetItem alongside Query on the calendar tables statement', () => {
    const tf = readFileSync(new URL('../../terraform/lambda_calendar.tf', import.meta.url), 'utf8');
    const at = tf.indexOf('Sid    = "DynamoDBCalendarTables"');
    assert.notEqual(at, -1, 'the DynamoDBCalendarTables statement must exist');
    const statement = tf.slice(at, tf.indexOf('Resource', at));

    for (const action of ['dynamodb:Query', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem']) {
      assert.ok(statement.includes(`"${action}"`), `the calendar tables statement must grant ${action}`);
    }
    assert.ok(!statement.includes('"dynamodb:Scan"'), 'no route in this ticket Scans, so the grant must not exist either');
    assert.ok(!statement.includes('"dynamodb:*"'), 'the grant must stay an explicit action list');
  });
});

describe('TASK-009 unit: the mutation path pattern', () => {
  it('splits a well-formed mutation path into its id and action', () => {
    for (const action of ['acknowledge', 'dismiss', 'restore']) {
      assert.deepEqual(parseEventActionPath(`/calendar/api/events/${ID}/${action}`), { eventId: ID, action });
    }
  });

  it('matches a traversal attempt so it becomes a named 400 rather than the router\'s generic 404', () => {
    const parsed = parseEventActionPath('/calendar/api/events/../../etc/passwd/acknowledge');
    assert.deepEqual(parsed, { eventId: '../../etc/passwd', action: 'acknowledge' });
    assert.equal(isEventId(parsed.eventId), false, 'and it must then fail the id check');
  });

  it('percent-decodes the captured id, so an encoded traversal is judged on its decoded value', () => {
    const parsed = parseEventActionPath('/calendar/api/events/%2E%2E%2Fsecrets/dismiss');
    assert.equal(parsed.eventId, '../secrets');
    assert.equal(isEventId(parsed.eventId), false);
  });

  it('returns null for anything that is not a mutation path', () => {
    assert.equal(parseEventActionPath('/calendar/api/events'), null);
    assert.equal(parseEventActionPath('/calendar/api/events/upcoming'), null);
    assert.equal(parseEventActionPath(`/calendar/api/events/${ID}`), null);
    assert.equal(parseEventActionPath(`/calendar/api/events/${ID}/delete`), null, 'only the three modelled actions');
    assert.equal(parseEventActionPath(`/calendar/api/events/${ID}/acknowledge/extra`), null);
    assert.equal(parseEventActionPath('/calendar/api/settings'), null);
    assert.equal(parseEventActionPath(null), null);
    assert.equal(parseEventActionPath(undefined), null);
  });
});
