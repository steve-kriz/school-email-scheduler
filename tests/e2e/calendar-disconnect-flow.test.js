/**
 * E2E (cucumber-style) scenarios for TASK-013 - "Disconnect Gmail: revoke the
 * grant and delete stored data".
 *
 * These are the ticket's Gherkin scenarios, written Given/When/Then, driven
 * through the REAL Lambda `handler` at `POST /calendar/api/auth/disconnect`.
 * The whole stack underneath the route runs for real: `handleAuthDisconnect` ->
 * `disconnectAccount` -> `revokeGrant` / `deleteConnection` /
 * `deleteEventsForUser`. Only the four true I/O boundaries are faked, and every
 * one of them is faked in this file:
 *
 *   - DynamoDB  -> `makeWorld()` below is an in-memory pair of tables with
 *                  DynamoDB's actual semantics: DeleteItem returns the old image
 *                  (ALL_OLD) or null, Query pages through LastEvaluatedKey and
 *                  honours ProjectionExpression, BatchWriteItem can hand back
 *                  UnprocessedItems, and UpdateItem UPSERTS (which is the
 *                  resurrection hazard scenario 8 pins down).
 *   - KMS       -> `getRefreshToken` is injected; no decrypt ever happens.
 *   - Google    -> `fetchImpl` is injected; no network request ever happens.
 *   - EventBridge Scheduler -> `deleteScanSchedule` is a stand-in that
 *                  reproduces the real function's connection-row patch.
 *
 * A scenario here that opened a real connection would be a failed scenario even
 * if it went green.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handler } from '../../src/lambda/calendar/index.mjs';

import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from '../../src/lambda/calendar/backend/session.mjs';

import {
  connectionUserId,
  deleteConnection,
  updateConnection,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/connections.mjs';

import { deleteEventsForUser } from '../../src/lambda/calendar/backend/events.mjs';

import {
  getAccessToken,
  getCachedTokenExpiry,
  resetTokenCache,
  ReauthRequiredError,
} from '../../src/lambda/calendar/backend/google-token.mjs';

import { ALARM_TOKENS } from '../../src/lambda/calendar/backend/alarms.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar');

const SESSION_SECRET = 'test-session-secret-must-be-32-bytes-long!!';
const CONNECTIONS_TABLE = 'test-connections-table';
const EVENTS_TABLE = 'test-events-table';
const REVOKE_ENDPOINT = 'https://revoke.test/revoke';
const REFRESH_TOKEN = 'rt-secret-value';

const ENV = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
  SESSION_SECRET,
  PUBLIC_BASE_URL: 'https://example.com',
  CALENDAR_CONNECTIONS_TABLE: CONNECTIONS_TABLE,
  CALENDAR_EVENTS_TABLE: EVENTS_TABLE,
  CALENDAR_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789:key/abc',
  CALENDAR_LOG_LEVEL: 'basic',
};

/* =========================================================================
 * The world: two in-memory tables that behave the way DynamoDB behaves.
 * ========================================================================= */

/**
 * @param {object} [options]
 * @param {number} [options.pageSize] Query page size, so a scenario can force
 *   multiple pages without inventing thousands of rows.
 */
function makeWorld({ pageSize = 100 } = {}) {
  /** userId -> connection row */
  const connections = new Map();
  /** `${userId}\0${eventId}` -> event row */
  const events = new Map();

  const world = {
    connections,
    events,
    /** Ordered trace of every table operation, for ordering assertions. */
    trace: [],
    /** Every set of keys handed to BatchWriteItem, in order. */
    batches: [],
    /** Scripted UnprocessedItems: a function (keys, callIndex) => keys|[] */
    unprocessedFor: () => [],
    /** Every revoke request the code made. */
    revokeCalls: [],

    seedConnection(userId, extra = {}) {
      connections.set(userId, {
        userId,
        email: `${userId}@example.test`,
        refreshTokenEnc: `enc:${REFRESH_TOKEN}`,
        refreshTokenKeyId: ENV.CALENDAR_KMS_KEY_ID,
        hasRefreshToken: true,
        ...extra,
      });
    },

    seedEvents(userId, count, titlePrefix = 'Year 4 Swimming Carnival') {
      for (let i = 0; i < count; i += 1) {
        const eventId = `${userId}-evt-${i}`;
        events.set(`${userId}\0${eventId}`, {
          userId,
          eventId,
          title: `${titlePrefix} ${i}`,
          startsAt: `2026-09-0${(i % 9) + 1}T09:00:00.000Z`,
        });
      }
    },

    eventIdsFor(userId) {
      return [...events.values()].filter((row) => row.userId === userId).map((row) => row.eventId).sort();
    },
  };

  /* --- DynamoDB DeleteItem with ReturnValues: ALL_OLD ------------------- */
  world.deleteItem = async ({ tableName, key }) => {
    assert.equal(tableName, CONNECTIONS_TABLE, 'the connection delete addressed the connections table');
    world.trace.push(`DeleteItem:${key.userId}`);
    const previous = connections.get(key.userId) || null;
    connections.delete(key.userId);
    return previous;
  };

  /* --- DynamoDB UpdateItem, which UPSERTS (the resurrection hazard) ----- */
  world.updateItem = async ({ tableName, key, updates }) => {
    assert.equal(tableName, CONNECTIONS_TABLE);
    world.trace.push(`UpdateItem:${key.userId}`);
    const existing = connections.get(key.userId) || { userId: key.userId };
    const next = { ...existing };
    for (const [name, value] of Object.entries(updates || {})) {
      if (value === REMOVE_ATTRIBUTE) delete next[name];
      else next[name] = value;
    }
    // This is the whole point: DynamoDB creates the row it could not find.
    connections.set(key.userId, next);
    return next;
  };

  /* --- DynamoDB Query over the StartsAtIndex --------------------------- */
  world.queryCalls = [];
  world.query = async (params) => {
    world.queryCalls.push(params);
    const userId = params?.ExpressionAttributeValues?.[':userId'];
    world.trace.push(`Query:${userId}`);

    const all = [...events.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => (a.eventId < b.eventId ? -1 : 1));

    const startAfter = params?.ExclusiveStartKey?.eventId ?? null;
    const from = startAfter === null ? 0 : all.findIndex((row) => row.eventId === startAfter) + 1;
    const slice = all.slice(from, from + pageSize);

    // Honour ProjectionExpression the way DynamoDB does, so a key-only
    // projection genuinely cannot hand a title back to the delete path.
    const names = params?.ExpressionAttributeNames || {};
    const projected = String(params?.ProjectionExpression || '')
      .split(',')
      .map((part) => part.trim())
      .map((part) => names[part] ?? part)
      .filter(Boolean);

    const items = slice.map((row) => {
      if (projected.length === 0) return { ...row };
      const out = {};
      for (const attribute of projected) if (attribute in row) out[attribute] = row[attribute];
      return out;
    });

    const last = slice[slice.length - 1];
    const more = from + pageSize < all.length;
    return { items, lastEvaluatedKey: more && last ? { userId, eventId: last.eventId } : null };
  };

  /* --- DynamoDB BatchWriteItem carrying DeleteRequests ------------------ */
  world.batchDelete = async ({ tableName, keys }) => {
    assert.equal(tableName, EVENTS_TABLE, 'event deletes addressed the events table');
    assert.ok(keys.length <= 25, `BatchWriteItem was handed ${keys.length} keys - the hard limit is 25`);
    world.batches.push(keys.map((key) => key.eventId));
    world.trace.push(`BatchWriteItem:${keys.length}`);

    const unprocessed = world.unprocessedFor(keys, world.batches.length - 1) || [];
    const held = new Set(unprocessed.map((key) => `${key.userId}\0${key.eventId}`));
    for (const key of keys) {
      const composite = `${key.userId}\0${key.eventId}`;
      if (!held.has(composite)) events.delete(composite);
    }
    return { unprocessed };
  };

  return world;
}

/**
 * A stand-in for `deleteScanSchedule` that reproduces the REAL function's tail.
 *
 * The real one (scan-schedule.mjs) finishes by patching the connection row
 * through `updateConnection`, defaulting to the stored implementation, and
 * `disconnectAccount` injects a no-op to stop that patch resurrecting the row it
 * is about to delete. This stand-in keeps that exact default, so if the no-op
 * injection were removed from disconnect.mjs the real `updateConnection` would
 * run against `world.updateItem` above - which UPSERTS - and the scenarios that
 * assert "no row came back" would go red.
 */
function scheduleClearThatPatchesTheRow(world) {
  return async (userId, { env, updateConnection: patch = updateConnection } = {}) => {
    world.trace.push(`DeleteSchedule:${userId}`);
    await patch(
      userId,
      {
        scheduleEnabled: false,
        scheduleFrequency: REMOVE_ATTRIBUTE,
        scheduleHour: REMOVE_ATTRIBUTE,
        scheduleDayOfWeek: REMOVE_ATTRIBUTE,
        timezone: REMOVE_ATTRIBUTE,
      },
      { updateItem: world.updateItem, tableName: CONNECTIONS_TABLE, env }
    );
    return { available: true, configured: false, enabled: false };
  };
}

/** A `fetch` Response stand-in for Google's revoke endpoint. */
function revokeResponse(status, body = '') {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/**
 * Build the injected deps for one run. `revoke` describes what Google does.
 *
 * @param {object} world
 * @param {object} [options]
 * @param {'ok'|'already_revoked'|'server_error'|'network_error'|'unparseable_400'} [options.revoke]
 */
function makeDeps(world, { revoke = 'ok', ...extra } = {}) {
  const fetchImpl = async (url, init) => {
    world.revokeCalls.push({ url, init, at: world.trace.length });
    world.trace.push('Revoke');
    if (revoke === 'network_error') throw new TypeError('fetch failed');
    if (revoke === 'server_error') return revokeResponse(500, 'upstream boom');
    if (revoke === 'unparseable_400') return revokeResponse(400, '<html>Bad Request</html>');
    if (revoke === 'already_revoked') return revokeResponse(400, JSON.stringify({ error: 'invalid_token' }));
    return revokeResponse(200, '');
  };

  return {
    env: ENV,
    tableName: CONNECTIONS_TABLE,
    eventsTableName: EVENTS_TABLE,
    fetchImpl,
    revokeEndpoint: REVOKE_ENDPOINT,

    // KMS and the connections read, faked.
    getConnection: async (userId) => {
      world.trace.push(`GetItem:${userId}`);
      const row = world.connections.get(userId);
      if (!row) return null;
      return { userId: row.userId, email: row.email, hasRefreshToken: row.hasRefreshToken === true };
    },
    getRefreshToken: async (userId) => {
      world.trace.push(`Decrypt:${userId}`);
      const row = world.connections.get(userId);
      return row?.refreshTokenEnc ? row.refreshTokenEnc.replace(/^enc:/, '') : null;
    },

    // EventBridge Scheduler, faked - but faithful to the real patch.
    deleteScanSchedule: scheduleClearThatPatchesTheRow(world),

    // The REAL deleteConnection, over the fake table.
    deleteConnection: (userId, options = {}) =>
      deleteConnection(userId, { ...options, deleteItem: world.deleteItem, tableName: CONNECTIONS_TABLE, env: ENV }),

    // The REAL deleteEventsForUser, over the fake table.
    deleteEventsForUser: (args, options = {}) =>
      deleteEventsForUser(
        { ...args, tableName: EVENTS_TABLE },
        {
          ...options,
          query: world.query,
          batchDelete: world.batchDelete,
          sleep: async () => {},
          random: () => 0,
          env: ENV,
        }
      ),

    ...extra,
  };
}

/**
 * GIVEN an authenticated user: a Lambda function URL event (payload format 2.0,
 * TASK-049) carrying a valid session cookie in the `cookies` array.
 */
function givenAuthenticatedDisconnectRequest(sub, body = undefined) {
  const token = createSessionToken(
    { sub, email: `${sub}@example.test` },
    { secret: SESSION_SECRET, nowSeconds: Math.floor(Date.now() / 1000) }
  );
  return {
    version: '2.0',
    rawPath: '/calendar/api/auth/disconnect',
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
    cookies: [`${SESSION_COOKIE_NAME}=${token}`],
    requestContext: {
      domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
      http: { method: 'POST', path: '/calendar/api/auth/disconnect' },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** WHEN they POST disconnect. */
async function whenTheyPostDisconnect(event, deps) {
  const response = await handler(event, undefined, deps);
  return { response, body: response.body ? JSON.parse(response.body) : null };
}

/**
 * The cookies a response sets. Under payload format 2.0 these live in the
 * top-level `cookies` array, never in the header map (TASK-049).
 */
function setCookieHeader(response) {
  const cookies = response?.cookies;
  return Array.isArray(cookies) && cookies.length > 0 ? cookies : null;
}

/* =========================================================================
 * Console capture - for "tokens stay out of the logs" and "no alarm fires".
 * ========================================================================= */

const REAL_LOG = console.log;
const REAL_WARN = console.warn;
const REAL_ERROR = console.error;

let captured = [];

function capturedText() {
  return captured
    .map((line) => line.args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    .join('\n');
}

describe('Feature: Disconnecting a Google account (E2E)', () => {
  beforeEach(() => {
    captured = [];
    console.log = (...args) => captured.push({ level: 'log', args });
    console.warn = (...args) => captured.push({ level: 'warn', args });
    console.error = (...args) => captured.push({ level: 'error', args });
  });

  afterEach(() => {
    console.log = REAL_LOG;
    console.warn = REAL_WARN;
    console.error = REAL_ERROR;
    resetTokenCache();
  });

  /* ---------------------------------------------------------------- AC 1 */
  it('Scenario: An unauthenticated caller is refused before anything is read', async () => {
    // Given a request with no session cookie
    const world = makeWorld();
    const event = {
      version: '2.0',
      rawPath: '/calendar/api/auth/disconnect',
      rawQueryString: '',
      headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
      cookies: [],
      requestContext: {
        domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
        http: { method: 'POST', path: '/calendar/api/auth/disconnect' },
      },
      body: '{"deleteEvents":true}',
    };
    world.seedConnection('google#1');
    world.seedEvents('google#1', 3);

    // When they POST disconnect
    const { response } = await whenTheyPostDisconnect(event, makeDeps(world));

    // Then the response status code is 401
    assert.equal(response.statusCode, 401);
    // And nothing was read, revoked or deleted
    assert.deepEqual(world.trace, [], 'an unauthenticated caller reaches no storage at all');
    assert.equal(world.revokeCalls.length, 0);
    assert.equal(world.connections.size, 1);
    assert.equal(world.eventIdsFor('google#1').length, 3);
  });

  /* ---------------------------------------------------------- Gherkin #1 */
  it('Scenario: A user revokes access and keeps their calendar', async () => {
    // Given an authenticated user with a stored grant and 12 events
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 12);

    // When they POST disconnect with deleteEvents false
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world)
    );

    // Then the response status code is 200
    assert.equal(response.statusCode, 200);
    // And the grant was revoked at Google, BEFORE any local delete
    assert.equal(world.revokeCalls.length, 1);
    assert.equal(world.revokeCalls[0].url, REVOKE_ENDPOINT);
    assert.equal(world.revokeCalls[0].init.method, 'POST');
    assert.equal(new URLSearchParams(world.revokeCalls[0].init.body).get('token'), REFRESH_TOKEN);
    assert.ok(
      world.trace.indexOf('Revoke') < world.trace.indexOf(`DeleteItem:${userId}`),
      `revoke must precede every delete: ${world.trace.join(' -> ')}`
    );
    // And the connection row is deleted
    assert.equal(world.connections.has(userId), false, 'no encrypted refresh token remains for that user');
    assert.equal(body.connectionDeleted, true);
    assert.equal(body.revoked, true);
    // And 12 events remain stored
    assert.equal(world.eventIdsFor(userId).length, 12);
    assert.equal(body.eventsDeleted, 0);
    assert.equal(world.batches.length, 0, 'no BatchWriteItem was issued at all');
  });

  /* ---------------------------------------------------------- Gherkin #2 */
  it('Scenario: A user revokes access and erases everything', async () => {
    // Given an authenticated user with a stored grant and 12 events
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 12);

    // When they POST disconnect with deleteEvents true
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );

    // Then the response status code is 200
    assert.equal(response.statusCode, 200);
    // And eventsDeleted is 12
    assert.equal(body.eventsDeleted, 12);
    assert.equal(body.eventsDeleteComplete, true);
    // And no events remain for that user
    assert.deepEqual(world.eventIdsFor(userId), []);
    assert.equal(world.connections.has(userId), false);
  });

  /* ---------------------------------------------------------- Gherkin #3 */
  it('Scenario: An already-revoked grant still disconnects cleanly', async () => {
    // Given Google's revoke endpoint returns 400 invalid_token
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);

    // When the user POSTs disconnect
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world, { revoke: 'already_revoked' })
    );

    // Then the response status code is 200
    assert.equal(response.statusCode, 200);
    assert.equal(body.revoked, true, 'the grant is not live, which is the end state that was wanted');
    // And the connection row is deleted
    assert.equal(world.connections.has(userId), false);
    assert.equal(body.connectionDeleted, true);
  });

  /* ---------------------------------------------------------- Gherkin #4 */
  it('Scenario: A failed revocation does not strand a live grant', async () => {
    // Given Google's revoke endpoint returns 500
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 12);

    // When the user POSTs disconnect
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world, { revoke: 'server_error' })
    );

    // Then the response status code is 502
    assert.equal(response.statusCode, 502);
    assert.ok(/try again/i.test(body.error), body.error);
    // And the connection row still exists
    assert.equal(world.connections.has(userId), true);
    assert.equal(world.connections.get(userId).refreshTokenEnc, `enc:${REFRESH_TOKEN}`);
    // And no events are deleted
    assert.equal(world.eventIdsFor(userId).length, 12);
    assert.equal(world.batches.length, 0);
    // And the schedule was not cleared either - nothing at all was mutated
    assert.equal(world.trace.some((step) => step.startsWith('DeleteSchedule')), false);
    assert.equal(world.trace.some((step) => step.startsWith('DeleteItem')), false);
  });

  it('Scenario: A 502 deliberately leaves the browser session alone', async () => {
    // Given a revocation that fails
    const world = makeWorld();
    world.seedConnection(connectionUserId('1'));

    // When the user POSTs disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world, { revoke: 'server_error' })
    );

    // Then the session cookie is NOT cleared - the user is still connected and
    // signing them out would hide a connection that still exists from them.
    assert.equal(response.statusCode, 502);
    const cookies = setCookieHeader(response);
    const text = Array.isArray(cookies) ? cookies.join('\n') : String(cookies ?? '');
    assert.equal(/Max-Age=0/.test(text), false, `the 502 path must not expire the session cookie: ${text}`);
  });

  /* ---------------------------------------------------------- Gherkin #5 */
  it('Scenario: A network error is retryable, not destructive', async () => {
    // Given the revoke request raises a network error
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 5);

    // When the user POSTs disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world, { revoke: 'network_error' })
    );

    // Then the response status code is 502
    assert.equal(response.statusCode, 502);
    // And nothing was deleted
    assert.equal(world.connections.has(userId), true);
    assert.equal(world.eventIdsFor(userId).length, 5);
    assert.equal(world.trace.filter((step) => step.startsWith('DeleteItem')).length, 0);
  });

  it('Scenario: A 400 whose body will not parse is a failure, not a charitable success', async () => {
    // Given Google answers 400 with an HTML error page rather than JSON
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 4);

    // When the user POSTs disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world, { revoke: 'unparseable_400' })
    );

    // Then it is 502 and NOTHING was deleted: guessing "already revoked" wrongly
    // destroys the only copy of a still-live token, and the cheap mistake is the
    // one to make.
    assert.equal(response.statusCode, 502);
    assert.equal(world.connections.has(userId), true);
    assert.equal(world.eventIdsFor(userId).length, 4);
  });

  /* ---------------------------------------------------------- Gherkin #6 */
  it('Scenario: A large history is fully cleared across three query pages', async () => {
    // Given an authenticated user with events spanning three query pages
    const world = makeWorld({ pageSize: 30 });
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 63);
    const before = world.eventIdsFor(userId);
    assert.equal(before.length, 63);

    // When they POST disconnect with deleteEvents true
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );

    // Then every event across all three pages is deleted
    assert.equal(response.statusCode, 200);
    assert.equal(body.eventsDeleted, 63);
    assert.equal(body.eventsDeleteComplete, true);
    assert.deepEqual(world.eventIdsFor(userId), []);
    // And the pages were actually followed through LastEvaluatedKey
    assert.equal(world.queryCalls.length, 3, 'three Query pages');
    assert.equal('ExclusiveStartKey' in world.queryCalls[0], false);
    assert.ok(world.queryCalls[1].ExclusiveStartKey, 'page 2 resumed from LastEvaluatedKey');
    assert.ok(world.queryCalls[2].ExclusiveStartKey);
    // And every BatchWriteItem stayed inside DynamoDB's 25-key limit
    assert.deepEqual(world.batches.map((keys) => keys.length), [25, 5, 25, 5, 3]);
    assert.equal(new Set(world.batches.flat()).size, 63, 'every distinct event was addressed exactly once');
  });

  it('Scenario: Throttled deletes are retried through UnprocessedItems', async () => {
    // Given DynamoDB throttles two keys on the very first batch
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 10);
    let firstBatchDone = false;
    world.unprocessedFor = (keys) => {
      if (firstBatchDone) return [];
      firstBatchDone = true;
      return keys.slice(0, 2);
    };

    // When they POST disconnect with deleteEvents true
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );

    // Then the throttled keys were resent and the erase is complete
    assert.equal(response.statusCode, 200);
    assert.equal(world.batches.length, 2, 'the unprocessed keys were retried');
    assert.equal(world.batches[1].length, 2, 'only the unprocessed keys were resent');
    assert.equal(body.eventsDeleted, 10);
    assert.equal(body.eventsDeleteComplete, true);
    assert.deepEqual(world.eventIdsFor(userId), []);
  });

  /* ---------------------------------------------------------- Gherkin #7 */
  it('Scenario: Disconnecting twice is harmless, and never resurrects a stub row', async () => {
    // Given a user who has already disconnected
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    const first = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world)
    );
    assert.equal(first.response.statusCode, 200);
    assert.equal(world.connections.has(userId), false);
    const revokesAfterFirst = world.revokeCalls.length;

    // When they POST disconnect again
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world)
    );

    // Then the response status code is 200
    assert.equal(response.statusCode, 200);
    // And revoked is false
    assert.equal(body.revoked, false);
    // And connectionDeleted is false
    assert.equal(
      body.connectionDeleted,
      false,
      'a second disconnect must not claim a deletion - if the schedule patch upserted a stub row, ' +
        'DeleteItem would have found one and this would be true'
    );
    // And no stub connection row was invented by the schedule patch. The
    // schedule clear DOES still run (so an orphaned schedule gets cleared on a
    // retry) - it simply must not write to the connections table.
    assert.equal(world.connections.has(userId), false, 'a disconnected user must not get a connection row back');
    assert.equal(
      world.trace.some((step) => step.startsWith('UpdateItem')),
      false,
      `no UpdateItem may touch the connections table during a disconnect: ${world.trace.join(' -> ')}`
    );
    assert.ok(world.trace.some((step) => step.startsWith('DeleteSchedule')), 'the schedule clear still ran');
    // And no pointless revoke or KMS decrypt happened for a grant that is gone
    assert.equal(world.revokeCalls.length, revokesAfterFirst, 'nothing left to revoke');
    assert.equal(world.trace.filter((step) => step.startsWith('Decrypt')).length, 1, 'no second KMS decrypt');
  });

  it('Scenario: The schedule patch cannot resurrect the row on a first disconnect either', async () => {
    // Given a connected user
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);

    // When they disconnect
    await whenTheyPostDisconnect(givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }), makeDeps(world));

    // Then the schedule clear ran but wrote nothing to the connections table.
    // DynamoDB's UpdateItem creates the row it cannot find, so an un-neutered
    // patch here would put a stub connection back around the delete.
    assert.ok(world.trace.includes(`DeleteSchedule:${userId}`));
    assert.equal(world.trace.some((step) => step.startsWith('UpdateItem')), false, world.trace.join(' -> '));
    assert.equal(world.connections.has(userId), false);
  });

  /* ---------------------------------------------------------- Gherkin #8 */
  it("Scenario: One user's disconnect does not touch another's data", async () => {
    // Given users "google#1" and "google#2" each with a grant and events
    const world = makeWorld();
    world.seedConnection('google#1');
    world.seedEvents('google#1', 6);
    world.seedConnection('google#2');
    world.seedEvents('google#2', 6);

    // When "google#1" disconnects with deleteEvents true
    const { response, body } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );

    // Then "google#2" still has a connection row and all their events
    assert.equal(response.statusCode, 200);
    assert.equal(body.eventsDeleted, 6);
    assert.equal(world.connections.has('google#1'), false);
    assert.deepEqual(world.eventIdsFor('google#1'), []);
    assert.equal(world.connections.has('google#2'), true);
    assert.equal(world.connections.get('google#2').refreshTokenEnc, `enc:${REFRESH_TOKEN}`);
    assert.equal(world.eventIdsFor('google#2').length, 6);
    // And no request ever addressed the other partition
    assert.equal(
      world.queryCalls.every((params) => params.ExpressionAttributeValues[':userId'] === 'google#1'),
      true
    );
    assert.equal(world.batches.flat().some((eventId) => eventId.startsWith('google#2')), false);
  });

  /* ---------------------------------------------------------- Gherkin #9 */
  it('Scenario: The browser session ends with the grant', async () => {
    // Given an authenticated user
    const world = makeWorld();
    world.seedConnection(connectionUserId('1'));

    // When they POST disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world)
    );

    // Then the Set-Cookie header expires the session cookie
    assert.equal(response.statusCode, 200);
    const cookies = setCookieHeader(response);
    assert.ok(Array.isArray(cookies), 'Set-Cookie is present');
    const session = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.ok(session, cookies.join('\n'));
    assert.ok(/Max-Age=0/.test(session), session);
    assert.ok(/Expires=Thu, 01 Jan 1970/.test(session), session);
    assert.ok(/HttpOnly/.test(session) && /Secure/.test(session), session);
  });

  /* --------------------------------------------------------- Gherkin #10 */
  it('Scenario: Tokens stay out of the logs', async () => {
    // Given a stored refresh token "rt-secret-value"
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 3, 'Year 4 Swimming Carnival');

    // When the user POSTs disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );
    assert.equal(response.statusCode, 200);

    // Then no log line contains "rt-secret-value"
    const text = capturedText();
    assert.ok(captured.length > 0, 'the disconnect logged something, so this search is not vacuous');
    assert.equal(/rt-secret-value/.test(text), false, 'the refresh token reached a log line');
    // And no log line contains the revoke request body
    assert.equal(/token=rt/.test(text), false, 'the revoke request body reached a log line');
    // And no log line contains an event title
    assert.equal(/Swimming Carnival/.test(text), false, 'an event title reached a log line');
    // And the counts and the outcome ARE recorded
    assert.ok(/disconnected/i.test(text), text);
    assert.ok(text.includes(userId), 'the userId is recorded');
  });

  /* ------------------------------------------------- deleteEvents is a bool */
  it('Scenario: A non-boolean deleteEvents is rejected rather than coerced', async () => {
    for (const value of ['true', 1, 0, [], {}, 'false']) {
      // Given a caller that sends deleteEvents as something other than a boolean
      const world = makeWorld();
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 3);

      // When they POST disconnect
      const { response, body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: value }),
        makeDeps(world)
      );

      // Then it is a 400 naming the field, with no truthiness coercion either way
      assert.equal(response.statusCode, 400, `deleteEvents: ${JSON.stringify(value)}`);
      assert.equal(body.field, 'deleteEvents');
      assert.ok(/true or false/i.test(body.error), body.error);
      // And nothing was revoked or deleted
      assert.deepEqual(world.trace, [], `a rejected body must not reach storage: ${JSON.stringify(value)}`);
      assert.equal(world.connections.has(userId), true);
      assert.equal(world.eventIdsFor(userId).length, 3);
    }
  });

  it('Scenario: An absent deleteEvents keeps the calendar - the destructive choice is never implied', async () => {
    for (const body of [{}, undefined, { deleteEvents: null }]) {
      const world = makeWorld();
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 3);

      const result = await whenTheyPostDisconnect(givenAuthenticatedDisconnectRequest('1', body), makeDeps(world));

      assert.equal(result.response.statusCode, 200, JSON.stringify(body));
      assert.equal(result.body.eventsDeleted, 0);
      assert.equal(world.eventIdsFor(userId).length, 3, `events were erased for body ${JSON.stringify(body)}`);
    }
  });

  /* ------------------------------------------- eventsDeleteComplete routes */
  describe('Scenario Outline: eventsDeleteComplete is always present and honest', () => {
    it('is true and present on a clean erase', async () => {
      const world = makeWorld();
      world.seedConnection(connectionUserId('1'));
      world.seedEvents(connectionUserId('1'), 4);

      const { body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
        makeDeps(world)
      );

      assert.equal('eventsDeleteComplete' in body, true, 'an absent field reads as "fine"');
      assert.equal(body.eventsDeleteComplete, true);
      // And the response reports revoked, connectionDeleted and eventsDeleted
      assert.deepEqual(
        Object.keys(body).sort(),
        ['connectionDeleted', 'eventsDeleteComplete', 'eventsDeleted', 'revoked', 'scheduleCleared']
      );
    });

    it('is present and true even when events were never touched', async () => {
      const world = makeWorld();
      world.seedConnection(connectionUserId('1'));

      const { body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
        makeDeps(world)
      );

      assert.equal('eventsDeleteComplete' in body, true);
      assert.equal(body.eventsDeleteComplete, true);
    });

    it('route 1: is false when unprocessed keys survived every attempt', async () => {
      const world = makeWorld();
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 4);
      // The same key is throttled on every single attempt.
      world.unprocessedFor = (keys) => keys.filter((key) => key.eventId.endsWith('-evt-3'));

      const { response, body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
        makeDeps(world)
      );

      assert.equal(response.statusCode, 200, 'a 200 with complete:false is the honest rows-may-remain answer');
      assert.equal(body.eventsDeleteComplete, false);
      assert.equal(body.eventsDeleted, 3, 'the surviving key is not counted as deleted');
      assert.deepEqual(world.eventIdsFor(userId), [`${userId}-evt-3`], 'and it really is still there');
    });

    it('route 2: is false when an index item carried no usable key', async () => {
      const world = makeWorld();
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 3);
      const realQuery = world.query;
      world.query = async (params) => {
        const page = await realQuery(params);
        // One index item comes back without an eventId - it cannot be deleted.
        return { ...page, items: [...page.items, { userId }] };
      };

      const { response, body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
        makeDeps(world)
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.eventsDeleteComplete, false);
      assert.equal(body.eventsDeleted, 3);
      assert.equal(world.batches.flat().length, 3, 'the unusable item was never guessed into a key');
    });

    it('route 3: is false when the MAX_DELETE_PAGES runaway guard is hit', async () => {
      const world = makeWorld({ pageSize: 2 });
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 20);

      const { response, body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
        makeDeps(world, { maxPages: 3 })
      );

      assert.equal(response.statusCode, 200);
      assert.equal(body.eventsDeleteComplete, false, 'stopping early is reported, not swallowed');
      assert.equal(body.eventsDeleted, 6, 'only the pages it actually reached');
      assert.equal(world.eventIdsFor(userId).length, 14, 'rows really do remain');
    });

    it('route 4: is false when the erase throws outright, and the rest is still reported truthfully', async () => {
      const world = makeWorld();
      const userId = connectionUserId('1');
      world.seedConnection(userId);
      world.seedEvents(userId, 4);
      world.query = async () => { throw new Error('ddb unavailable'); };

      const { response, body } = await whenTheyPostDisconnect(
        givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
        makeDeps(world)
      );

      assert.equal(response.statusCode, 200, 'the revoke and row delete already happened; a bare 500 would deny that');
      assert.equal(body.revoked, true);
      assert.equal(body.connectionDeleted, true);
      assert.equal(body.eventsDeleted, 0);
      assert.equal(body.eventsDeleteComplete, false);
      assert.equal(world.eventIdsFor(userId).length, 4);
    });
  });

  /* ------------------------------------------------ the alarm interaction */
  it('Scenario: A deliberate disconnect emits ZERO CALENDAR_REAUTH_REQUIRED alarms', async () => {
    // Given a connected user
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);
    world.seedEvents(userId, 3);

    // When they disconnect
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: true }),
      makeDeps(world)
    );
    assert.equal(response.statusCode, 200);

    // Then no revocation alarm token was written anywhere
    assert.equal(
      capturedText().includes(ALARM_TOKENS.REAUTH_REQUIRED),
      false,
      'a user leaving is not a mass revocation; counting it would make the alarm meaningless'
    );
    // And the only Google endpoint touched was the REVOKE endpoint - the
    // invalid_grant branch that raises the alarm lives on the TOKEN endpoint and
    // is structurally unreachable from here.
    assert.equal(world.revokeCalls.length, 1);
    assert.equal(world.revokeCalls[0].url, REVOKE_ENDPOINT);
    assert.equal(/token$/.test(world.revokeCalls[0].url), false);

    // And a later scan for the now-deleted user takes the alarm-free
    // no_refresh_token path rather than the alarming invalid_grant one.
    const alarms = [];
    await assert.rejects(
      () =>
        getAccessToken(userId, {
          getRefreshToken: async () => null,
          fetchImpl: async () => { throw new Error('the token endpoint must not be reached'); },
          env: ENV,
          log: () => {},
          emitAlarm: (token, fields) => alarms.push({ token, fields }),
        }),
      (err) => {
        assert.ok(err instanceof ReauthRequiredError);
        assert.equal(err.reason, 'no_refresh_token');
        return true;
      }
    );
    assert.deepEqual(alarms, [], 'the post-disconnect scan path is deliberately alarm-free');
  });

  /* ---------------------------------------------- the warm-container hazard */
  it('Scenario: A warm container cannot reuse an access token minted from the dead grant', async () => {
    const world = makeWorld();
    const userId = connectionUserId('1');
    world.seedConnection(userId);

    // Given a warm Lambda that has already minted and cached an access token
    const accessToken = await getAccessToken(userId, {
      getRefreshToken: async () => REFRESH_TOKEN,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'at-live-token', expires_in: 3600 }),
      }),
      env: ENV,
      log: () => {},
      emitAlarm: () => {},
    });
    assert.equal(accessToken, 'at-live-token');
    assert.ok(getCachedTokenExpiry(userId) > 0, 'the token really is cached');

    // When the user disconnects (the REAL resetTokenCache is the default)
    const { response } = await whenTheyPostDisconnect(
      givenAuthenticatedDisconnectRequest('1', { deleteEvents: false }),
      makeDeps(world)
    );
    assert.equal(response.statusCode, 200);

    // Then the cached access token is gone, so nothing can keep reading the
    // mailbox on a token that outlived its refresh token.
    assert.equal(getCachedTokenExpiry(userId), null, 'the access token cache still holds an entry for the dead grant');
    await assert.rejects(
      () =>
        getAccessToken(userId, {
          getRefreshToken: async () => null,
          fetchImpl: async () => { throw new Error('the token endpoint must not be reached'); },
          env: ENV,
          log: () => {},
          emitAlarm: () => {},
        }),
      (err) => err instanceof ReauthRequiredError
    );
  });

  /* --------------------------------------------------------- Gherkin #11 */
  describe('Scenario: Erasing data requires deliberate confirmation', () => {
    const html = fs.readFileSync(path.join(CALENDAR_DIR, 'frontend', 'settings.html'), 'utf-8');

    it('Then it states that access will be revoked', () => {
      assert.ok(/revoke/i.test(html), 'the control says access is revoked');
      assert.ok(/Gmail/.test(html));
    });

    it('And it offers keeping or deleting events as an explicit choice', () => {
      assert.ok(/id="disconnect-events-keep"/.test(html));
      assert.ok(/id="disconnect-events-delete"/.test(html));
      assert.ok(/type="radio"/.test(html), 'two named choices, not one checkbox');
    });

    it('And deleting events is not the default', () => {
      const deleteInput = html.slice(html.indexOf('id="disconnect-events-delete"'));
      assert.equal(
        /checked/.test(deleteInput.slice(0, deleteInput.indexOf('>'))),
        false,
        'the destructive option must never be preselected'
      );
      const keepInput = html.slice(html.indexOf('id="disconnect-events-keep"'));
      assert.ok(/checked/.test(keepInput.slice(0, keepInput.indexOf('>'))), 'keeping is the default');
    });

    it('And it requires a typed confirmation before deleting', () => {
      assert.ok(/id="disconnect-confirm"/.test(html), 'there is a confirmation input');
      const submit = html.slice(html.indexOf('id="disconnect-submit"'));
      assert.ok(
        /disabled/.test(submit.slice(0, submit.indexOf('</button>'))),
        'the submit button ships disabled, so a page whose script never loads cannot submit'
      );
    });
  });
});
