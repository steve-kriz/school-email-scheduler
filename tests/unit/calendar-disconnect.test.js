/**
 * Unit tests for TASK-013 - disconnecting a Google account.
 *
 * Scope: the units underneath the HTTP route.
 *   - backend/disconnect.mjs   revokeGrant, disconnectAccount, RevocationError
 *   - backend/connections.mjs  deleteConnection
 *   - backend/events.mjs       buildUserEventKeysQueryParams, deleteEventsForUser
 *   - frontend/settings.js     the pure confirmation helpers
 *   - frontend/settings.html   the markup contract the helpers depend on
 *
 * EVERY external call is faked. There is no DynamoDB client, no KMS call and no
 * `fetch` that is not an injected function defined in this file: `revokeGrant`
 * takes `fetchImpl`, `deleteConnection` takes `deleteItem`, `deleteEventsForUser`
 * takes `query`/`batchDelete`/`sleep`, and `disconnectAccount` takes every one of
 * its storage dependencies. A test here that reached the network would be a
 * failed test even if it went green.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOOGLE_REVOKE_ENDPOINT,
  ALREADY_REVOKED_ERROR,
  RevocationError,
  revokeGrant,
  disconnectAccount,
} from '../../src/lambda/calendar/backend/disconnect.mjs';

import {
  deleteConnection,
  updateConnection,
  buildUpdateParams,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/connections.mjs';

import {
  buildUserEventKeysQueryParams,
  deleteEventsForUser,
  MAX_DELETE_PAGES,
  STARTS_AT_INDEX,
} from '../../src/lambda/calendar/backend/events.mjs';

import {
  CONFIRM_PHRASE_KEEP,
  CONFIRM_PHRASE_DELETE,
  DISCONNECT_ENDPOINT,
  requiredConfirmation,
  isConfirmed,
  disconnectRequestBody,
  disconnectSummary,
  initDisconnectControl,
} from '../../src/lambda/calendar/frontend/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CALENDAR_DIR = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar');

const TABLE = 'test-connections-table';
const EVENTS_TABLE = 'test-events-table';
const USER = 'google#user-1';
const SILENT_ENV = { CALENDAR_LOG_LEVEL: 'none' };

/** A `fetch` Response stand-in. `text()` is what revokeGrant actually reads. */
function fakeResponse(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

/** Collects log lines so an assertion can search them for secrets. */
function makeLogSpy() {
  const lines = [];
  const log = (message, fields) => lines.push({ message, fields });
  log.lines = lines;
  log.text = () => lines.map((line) => `${line.message} ${JSON.stringify(line.fields ?? null)}`).join('\n');
  return log;
}

/* =========================================================================
 * revokeGrant - the outcome mapping
 * ========================================================================= */

describe('TASK-013 unit: revokeGrant', () => {
  it('POSTs the refresh token as a form-encoded body to the revoke endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return fakeResponse(200, '');
    };

    const result = await revokeGrant('rt-secret-value', {
      fetchImpl,
      revokeEndpoint: 'https://revoke.test/revoke',
      env: SILENT_ENV,
    });

    assert.equal(calls.length, 1, 'exactly one revoke request');
    assert.equal(calls[0].url, 'https://revoke.test/revoke');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');

    const params = new URLSearchParams(calls[0].init.body);
    assert.equal(params.get('token'), 'rt-secret-value');
    assert.deepEqual([...params.keys()], ['token'], 'only the token parameter is sent');
    assert.deepEqual(result, { revoked: true, alreadyRevoked: false, statusCode: 200 });
  });

  it('defaults to Google\'s documented revocation endpoint', () => {
    assert.equal(GOOGLE_REVOKE_ENDPOINT, 'https://oauth2.googleapis.com/revoke');
  });

  it('percent-encodes a token containing & and = so it cannot smuggle a second parameter', async () => {
    let sentBody = '';
    const fetchImpl = async (_url, init) => {
      sentBody = init.body;
      return fakeResponse(200, '');
    };

    await revokeGrant('a&client_id=evil=b', { fetchImpl, env: SILENT_ENV });

    const params = new URLSearchParams(sentBody);
    assert.deepEqual([...params.keys()], ['token'], 'the injected parameter did not become a real one');
    assert.equal(params.get('token'), 'a&client_id=evil=b');
    assert.equal(params.get('client_id'), null);
  });

  it('treats 200 as success', async () => {
    const result = await revokeGrant('rt', { fetchImpl: async () => fakeResponse(200, ''), env: SILENT_ENV });
    assert.equal(result.revoked, true);
    assert.equal(result.alreadyRevoked, false);
    assert.equal(result.statusCode, 200);
  });

  it('treats 400 invalid_token as success, flagged alreadyRevoked', async () => {
    const result = await revokeGrant('rt', {
      fetchImpl: async () => fakeResponse(400, JSON.stringify({ error: ALREADY_REVOKED_ERROR })),
      env: SILENT_ENV,
    });
    assert.equal(result.revoked, true, 'the grant is not live, which is the end state we wanted');
    assert.equal(result.alreadyRevoked, true);
    assert.equal(result.statusCode, 400);
  });

  it('throws RevocationError on a 500', async () => {
    await assert.rejects(
      () => revokeGrant('rt', { fetchImpl: async () => fakeResponse(500, 'upstream boom'), env: SILENT_ENV }),
      (err) => {
        assert.equal(err instanceof RevocationError, true);
        assert.equal(err.name, 'RevocationError');
        assert.equal(err.reason, 'http_500');
        assert.equal(err.statusCode, 500);
        assert.equal(/upstream boom/.test(err.message), false, 'the response body never reaches the error');
        return true;
      }
    );
  });

  it('throws RevocationError on a network failure, with statusCode 0', async () => {
    await assert.rejects(
      () => revokeGrant('rt', {
        fetchImpl: async () => { throw new TypeError('fetch failed: https://oauth2.googleapis.com/revoke'); },
        env: SILENT_ENV,
      }),
      (err) => {
        assert.equal(err.name, 'RevocationError');
        assert.equal(err.reason, 'network_error');
        assert.equal(err.statusCode, 0);
        assert.equal(/oauth2\.googleapis\.com/.test(err.message), false, 'the fetch message is not re-thrown');
        return true;
      }
    );
  });

  it('throws RevocationError on a 400 whose body will not parse - it does NOT guess "already revoked"', async () => {
    await assert.rejects(
      () => revokeGrant('rt', { fetchImpl: async () => fakeResponse(400, '<html>bad request</html>'), env: SILENT_ENV }),
      (err) => {
        assert.equal(err.name, 'RevocationError');
        assert.equal(err.reason, 'http_400', 'an unparseable 400 is a failure, not a charitable success');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  });

  it('throws RevocationError on a 400 carrying some other OAuth error', async () => {
    await assert.rejects(
      () => revokeGrant('rt', {
        fetchImpl: async () => fakeResponse(400, JSON.stringify({ error: 'invalid_request' })),
        env: SILENT_ENV,
      }),
      (err) => {
        assert.equal(err.reason, 'invalid_request');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  });

  it('throws RevocationError on an unrecognised 4xx such as 403', async () => {
    await assert.rejects(
      () => revokeGrant('rt', { fetchImpl: async () => fakeResponse(403, ''), env: SILENT_ENV }),
      (err) => {
        assert.equal(err.reason, 'http_403');
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  it('throws RevocationError when there is no fetch implementation at all', async () => {
    await assert.rejects(
      () => revokeGrant('rt', { fetchImpl: null, env: SILENT_ENV }),
      (err) => {
        assert.equal(err.name, 'RevocationError');
        assert.equal(err.reason, 'no_fetch');
        return true;
      }
    );
  });

  it('rejects an empty or non-string refresh token before any request is made', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return fakeResponse(200, ''); };

    await assert.rejects(() => revokeGrant('', { fetchImpl, env: SILENT_ENV }), /refreshToken is required/);
    await assert.rejects(() => revokeGrant(undefined, { fetchImpl, env: SILENT_ENV }), /refreshToken is required/);
    assert.equal(called, 0, 'no revoke request was attempted');
  });

  it('never writes the token, the request body or the response body to a log line', async () => {
    const log = makeLogSpy();
    await revokeGrant('rt-secret-value', {
      fetchImpl: async () => fakeResponse(200, JSON.stringify({ secret_echo: 'rt-secret-value' })),
      env: SILENT_ENV,
      log,
    });

    assert.ok(log.lines.length > 0, 'the revoke did log something, so the search below is not vacuous');
    assert.equal(/rt-secret-value/.test(log.text()), false, 'no log line contains the refresh token');
    assert.equal(/token=/.test(log.text()), false, 'no log line contains the form body');
  });
});

/* =========================================================================
 * deleteConnection - the observed-delete contract
 * ========================================================================= */

describe('TASK-013 unit: deleteConnection', () => {
  it('deletes by the userId key and reports deleted:true from the returned old image', async () => {
    const calls = [];
    const deleteItem = async (args) => {
      calls.push(args);
      return { userId: USER, email: 'a@b.test', refreshTokenEnc: 'enc:rt-secret-value', refreshTokenKeyId: 'arn:kms:key' };
    };

    const result = await deleteConnection(USER, { deleteItem, tableName: TABLE, env: SILENT_ENV });

    assert.deepEqual(calls, [{ tableName: TABLE, key: { userId: USER } }]);
    assert.equal(result.deleted, true);
    assert.equal(result.hadRefreshToken, true);
  });

  it('reports deleted:false when DynamoDB returned no old image - it never claims a delete it did not observe', async () => {
    const result = await deleteConnection(USER, {
      deleteItem: async () => null,
      tableName: TABLE,
      env: SILENT_ENV,
    });
    assert.deepEqual(result, { deleted: false, hadRefreshToken: false });
  });

  it('strips the ciphertext and the key ARN out of the old image before returning', async () => {
    const result = await deleteConnection(USER, {
      deleteItem: async () => ({ userId: USER, refreshTokenEnc: 'enc:rt-secret-value', refreshTokenKeyId: 'arn:aws:kms:key/abc' }),
      tableName: TABLE,
      env: SILENT_ENV,
    });

    assert.deepEqual(Object.keys(result).sort(), ['deleted', 'hadRefreshToken']);
    const serialised = JSON.stringify(result);
    assert.equal(/rt-secret-value/.test(serialised), false, 'no ciphertext escapes deleteConnection');
    assert.equal(/arn:aws:kms/.test(serialised), false, 'no key ARN escapes deleteConnection');
  });

  it('reports hadRefreshToken:false for a row that carried no wrapped token', async () => {
    const result = await deleteConnection(USER, {
      deleteItem: async () => ({ userId: USER, email: 'a@b.test' }),
      tableName: TABLE,
      env: SILENT_ENV,
    });
    assert.equal(result.deleted, true);
    assert.equal(result.hadRefreshToken, false);
  });

  it('requires a userId and a table name', async () => {
    const deleteItem = async () => null;
    await assert.rejects(() => deleteConnection('', { deleteItem, tableName: TABLE, env: SILENT_ENV }), /userId is required/);
    await assert.rejects(() => deleteConnection(USER, { deleteItem, env: {} }), /CALENDAR_CONNECTIONS_TABLE is not set/);
  });

  it('asks DynamoDB for the old image (ReturnValues ALL_OLD) at the un-injectable SDK boundary', () => {
    // ddbDeleteItem constructs a DeleteCommand against a module-scoped client
    // with no injection seam, so this one claim is pinned at the source. Every
    // behavioural assertion above runs the real code with a fake deleteItem.
    const source = fs.readFileSync(path.join(CALENDAR_DIR, 'backend', 'connections.mjs'), 'utf-8');
    const body = source.slice(source.indexOf('export async function ddbDeleteItem'));
    const command = body.slice(0, body.indexOf('return result'));
    assert.ok(/new DeleteCommand\(/.test(command), 'ddbDeleteItem issues a DeleteCommand');
    assert.ok(
      /ReturnValues:\s*"ALL_OLD"/.test(command),
      'without ALL_OLD, deleteConnection cannot tell "row removed" from "nothing to remove"'
    );
  });
});

/* =========================================================================
 * buildUserEventKeysQueryParams - key-only enumeration of a user's events
 * ========================================================================= */

describe('TASK-013 unit: buildUserEventKeysQueryParams', () => {
  it('queries StartsAtIndex by userId alone, with no range condition, so the whole history is in scope', () => {
    const params = buildUserEventKeysQueryParams({ tableName: EVENTS_TABLE, userId: USER });

    assert.equal(params.TableName, EVENTS_TABLE);
    assert.equal(params.IndexName, STARTS_AT_INDEX);
    assert.equal(params.KeyConditionExpression, '#userId = :userId');
    assert.equal(/AND/i.test(params.KeyConditionExpression), false, 'no date window may narrow an erase');
    assert.equal(params.ExpressionAttributeValues[':userId'], USER);
    assert.equal(Object.keys(params.ExpressionAttributeValues).length, 1);
  });

  it('projects the two key attributes only, so no title or sender is read into the delete path', () => {
    const params = buildUserEventKeysQueryParams({ tableName: EVENTS_TABLE, userId: USER });
    const projected = params.ProjectionExpression.split(',').map((part) => part.trim());
    assert.deepEqual(projected, ['#userId', '#eventId']);
    assert.deepEqual(params.ExpressionAttributeNames, { '#userId': 'userId', '#eventId': 'eventId' });
  });

  it('omits ExclusiveStartKey on the first page and includes it on later ones', () => {
    const first = buildUserEventKeysQueryParams({ tableName: EVENTS_TABLE, userId: USER });
    assert.equal('ExclusiveStartKey' in first, false);

    const next = buildUserEventKeysQueryParams({
      tableName: EVENTS_TABLE,
      userId: USER,
      exclusiveStartKey: { userId: USER, eventId: 'e-25' },
    });
    assert.deepEqual(next.ExclusiveStartKey, { userId: USER, eventId: 'e-25' });
  });
});

/* =========================================================================
 * deleteEventsForUser - paging, chunking, retries and honest completeness
 * ========================================================================= */

/** Build `n` index items for a user. */
function eventItems(n, offset = 0, userId = USER) {
  return Array.from({ length: n }, (_, i) => ({ userId, eventId: `evt-${offset + i}` }));
}

/**
 * A query stand-in that hands back a scripted list of pages and records the
 * params it was called with.
 */
function makePagedQuery(pages) {
  const seen = [];
  const query = async (params) => {
    seen.push(params);
    const page = pages[seen.length - 1];
    if (!page) throw new Error(`query called ${seen.length} times but only ${pages.length} pages were scripted`);
    return page;
  };
  query.seen = seen;
  return query;
}

describe('TASK-013 unit: deleteEventsForUser', () => {
  it('deletes 31 events across two query pages in chunks of 25, 5 and 1', async () => {
    const query = makePagedQuery([
      { items: eventItems(30), lastEvaluatedKey: { userId: USER, eventId: 'evt-29' } },
      { items: eventItems(1, 30), lastEvaluatedKey: null },
    ]);
    const chunkSizes = [];
    const deletedKeys = [];
    const batchDelete = async ({ tableName, keys }) => {
      assert.equal(tableName, EVENTS_TABLE);
      chunkSizes.push(keys.length);
      deletedKeys.push(...keys.map((k) => k.eventId));
      return { unprocessed: [] };
    };

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.deepEqual(chunkSizes, [25, 5, 1], 'BatchWriteItem chunks never exceed 25');
    assert.equal(result.deleted, 31);
    assert.equal(result.pages, 2);
    assert.equal(result.requests, 3);
    assert.equal(result.complete, true);
    assert.equal(new Set(deletedKeys).size, 31, 'every distinct event was addressed exactly once');
    assert.equal(query.seen.length, 2);
    assert.deepEqual(query.seen[1].ExclusiveStartKey, { userId: USER, eventId: 'evt-29' }, 'LastEvaluatedKey was followed');
  });

  it('clears a history spanning three query pages', async () => {
    const query = makePagedQuery([
      { items: eventItems(4, 0), lastEvaluatedKey: { userId: USER, eventId: 'evt-3' } },
      { items: eventItems(4, 4), lastEvaluatedKey: { userId: USER, eventId: 'evt-7' } },
      { items: eventItems(4, 8), lastEvaluatedKey: null },
    ]);
    const deleted = [];
    const batchDelete = async ({ keys }) => { deleted.push(...keys.map((k) => k.eventId)); return { unprocessed: [] }; };

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(result.pages, 3);
    assert.equal(result.deleted, 12);
    assert.equal(result.complete, true);
    assert.deepEqual(deleted.sort(), eventItems(12).map((e) => e.eventId).sort());
  });

  it('retries UnprocessedItems and counts only the keys DynamoDB confirmed', async () => {
    const query = makePagedQuery([{ items: eventItems(5), lastEvaluatedKey: null }]);
    const attempts = [];
    const sleeps = [];
    const batchDelete = async ({ keys }) => {
      attempts.push(keys.map((k) => k.eventId));
      // First attempt: DynamoDB throttled two of the five.
      if (attempts.length === 1) return { unprocessed: keys.slice(3) };
      return { unprocessed: [] };
    };

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async (ms) => sleeps.push(ms), random: () => 0, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(attempts.length, 2, 'the unprocessed keys were retried');
    assert.deepEqual(attempts[1], ['evt-3', 'evt-4'], 'only the unprocessed keys were resent');
    assert.equal(result.deleted, 5, '3 confirmed on the first attempt plus 2 on the retry');
    assert.equal(result.requests, 2);
    assert.equal(result.complete, true);
    assert.equal(sleeps.length, 1, 'the retry backed off through the injected sleep');
  });

  it('reports complete:false when unprocessed keys survive every attempt', async () => {
    const query = makePagedQuery([{ items: eventItems(3), lastEvaluatedKey: null }]);
    // The SAME key is throttled on every attempt, including the retries - a
    // `keys.slice(2)` stand-in would silently stop throttling once the retry
    // shrank `pending` to one key, so the retry would "succeed" and this test
    // would never exercise the survived-every-attempt route at all.
    const batchDelete = async ({ keys }) => ({ unprocessed: keys.filter((key) => key.eventId === 'evt-2') });

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, maxAttempts: 3, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(result.complete, false, 'rows may remain, and the result says so');
    assert.equal(result.unprocessed.length, 1);
    assert.deepEqual(result.unprocessed[0], { userId: USER, eventId: 'evt-2' });
    assert.equal(result.deleted, 2, 'the surviving key is not counted as deleted');
  });

  it('reports complete:false when an index item carries no usable key, and does not send it', async () => {
    const query = makePagedQuery([
      { items: [{ userId: USER, eventId: 'evt-0' }, { userId: USER }, { eventId: 'evt-2' }], lastEvaluatedKey: null },
    ]);
    const sent = [];
    const batchDelete = async ({ keys }) => { sent.push(...keys); return { unprocessed: [] }; };

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(result.complete, false);
    assert.equal(result.deleted, 1);
    assert.deepEqual(sent, [{ userId: USER, eventId: 'evt-0' }], 'an unusable item is never guessed into a key');
  });

  it('reports complete:false when the page cap is reached with a LastEvaluatedKey still outstanding', async () => {
    let calls = 0;
    const query = async () => {
      calls += 1;
      // Never stops handing back a page - the runaway a page cap exists for.
      return { items: eventItems(1, calls), lastEvaluatedKey: { userId: USER, eventId: `evt-${calls}` } };
    };
    const batchDelete = async () => ({ unprocessed: [] });

    const result = await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, maxPages: 3, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(result.pages, 3, 'the loop stopped at the cap');
    assert.equal(calls, 3);
    assert.equal(result.complete, false, 'stopping early is reported, not swallowed');
  });

  it('defaults the runaway guard to MAX_DELETE_PAGES, well above the read-path page cap', () => {
    assert.equal(MAX_DELETE_PAGES, 200);
  });

  it('queries only the given user partition, so another user\'s rows are never addressed', async () => {
    const query = makePagedQuery([{ items: eventItems(2, 0, 'google#user-1'), lastEvaluatedKey: null }]);
    const sent = [];
    const batchDelete = async ({ keys }) => { sent.push(...keys); return { unprocessed: [] }; };

    await deleteEventsForUser(
      { userId: 'google#user-1', tableName: EVENTS_TABLE },
      { query, batchDelete, sleep: async () => {}, random: () => 0, env: SILENT_ENV, log: makeLogSpy() }
    );

    assert.equal(query.seen[0].ExpressionAttributeValues[':userId'], 'google#user-1');
    assert.equal(sent.every((key) => key.userId === 'google#user-1'), true);
    assert.equal(sent.some((key) => key.userId === 'google#user-2'), false);
  });

  it('logs counts only - no event title reaches a log line even when the query hands one back', async () => {
    const query = makePagedQuery([
      { items: [{ userId: USER, eventId: 'evt-0', title: 'Year 4 Swimming Carnival' }], lastEvaluatedKey: null },
    ]);
    const log = makeLogSpy();

    await deleteEventsForUser(
      { userId: USER, tableName: EVENTS_TABLE },
      { query, batchDelete: async () => ({ unprocessed: [] }), sleep: async () => {}, random: () => 0, env: SILENT_ENV, log }
    );

    assert.ok(log.lines.length > 0, 'something was logged, so this search is not vacuous');
    assert.equal(/Swimming Carnival/.test(log.text()), false);
  });

  it('requires a userId and a configured events table', async () => {
    const deps = { query: async () => ({ items: [], lastEvaluatedKey: null }), batchDelete: async () => ({ unprocessed: [] }), env: SILENT_ENV };
    await assert.rejects(() => deleteEventsForUser({ userId: '' }, deps), /userId is required/);
    await assert.rejects(() => deleteEventsForUser({ userId: USER }, deps), /CALENDAR_EVENTS_TABLE is not configured/);
  });
});

/* =========================================================================
 * disconnectAccount - the ordering, and what happens when a step fails
 * ========================================================================= */

/**
 * Build the full dependency set for `disconnectAccount`, recording an ordered
 * trace of every dependency that was actually invoked.
 *
 * Overrides let one test change one step without restating the rest.
 */
function makeDisconnectDeps(overrides = {}) {
  const trace = [];
  const log = makeLogSpy();

  const deps = {
    getConnection: async () => { trace.push('getConnection'); return { userId: USER, hasRefreshToken: true }; },
    getRefreshToken: async () => { trace.push('getRefreshToken'); return 'rt-secret-value'; },
    revokeGrant: async () => { trace.push('revokeGrant'); return { revoked: true, alreadyRevoked: false, statusCode: 200 }; },
    resetTokenCache: () => { trace.push('resetTokenCache'); },
    deleteScanSchedule: async () => { trace.push('deleteScanSchedule'); return { available: true }; },
    deleteConnection: async () => { trace.push('deleteConnection'); return { deleted: true, hadRefreshToken: true }; },
    deleteEventsForUser: async () => { trace.push('deleteEventsForUser'); return { deleted: 12, complete: true }; },
    env: SILENT_ENV,
    log,
    ...overrides,
  };

  return { deps, trace, log };
}

describe('TASK-013 unit: disconnectAccount ordering', () => {
  it('reads, revokes, clears the schedule, deletes the row, then deletes the events - in that order', async () => {
    const { deps, trace } = makeDisconnectDeps();

    const result = await disconnectAccount({ userId: USER, deleteEvents: true }, deps);

    assert.deepEqual(trace, [
      'getConnection',
      'getRefreshToken',
      'revokeGrant',
      'resetTokenCache',
      'deleteScanSchedule',
      'deleteConnection',
      'deleteEventsForUser',
    ]);
    assert.equal(trace.indexOf('revokeGrant') < trace.indexOf('deleteConnection'), true, 'revoke happens before any delete');
    assert.deepEqual(result, {
      revoked: true,
      alreadyRevoked: false,
      connectionDeleted: true,
      scheduleCleared: true,
      eventsDeleted: 12,
      eventsDeleteComplete: true,
    });
  });

  it('performs NO delete of any kind when the revocation fails - observed from the calls made', async () => {
    const { deps, trace } = makeDisconnectDeps({
      revokeGrant: async () => {
        trace.push('revokeGrant');
        throw new RevocationError('Google refused', { reason: 'http_500', statusCode: 500 });
      },
    });

    await assert.rejects(
      () => disconnectAccount({ userId: USER, deleteEvents: true }, deps),
      (err) => { assert.equal(err.name, 'RevocationError'); assert.equal(err.reason, 'http_500'); return true; }
    );

    assert.deepEqual(trace, ['getConnection', 'getRefreshToken', 'revokeGrant']);
    assert.equal(trace.includes('deleteConnection'), false, 'the connection row was never touched');
    assert.equal(trace.includes('deleteEventsForUser'), false, 'no event was deleted');
    assert.equal(trace.includes('deleteScanSchedule'), false);
  });

  it('performs NO delete when the revocation raises a network error', async () => {
    const { deps, trace } = makeDisconnectDeps({
      revokeGrant: async () => {
        trace.push('revokeGrant');
        throw new RevocationError('unreachable', { reason: 'network_error', statusCode: 0 });
      },
    });

    await assert.rejects(() => disconnectAccount({ userId: USER, deleteEvents: true }, deps), /unreachable/);
    assert.deepEqual(trace, ['getConnection', 'getRefreshToken', 'revokeGrant']);
  });

  it('aborts without deleting when the connection read itself fails', async () => {
    const { deps, trace } = makeDisconnectDeps({
      getConnection: async () => { trace.push('getConnection'); throw new Error('ddb unavailable'); },
    });

    await assert.rejects(() => disconnectAccount({ userId: USER, deleteEvents: true }, deps), /ddb unavailable/);
    assert.deepEqual(trace, ['getConnection'], 'code that cannot see the grant does not start destroying it');
  });

  it('completes when the grant was already revoked at Google (400 invalid_token)', async () => {
    const { deps, trace } = makeDisconnectDeps({
      revokeGrant: async () => { trace.push('revokeGrant'); return { revoked: true, alreadyRevoked: true, statusCode: 400 }; },
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: false }, deps);

    assert.equal(result.revoked, true);
    assert.equal(result.alreadyRevoked, true);
    assert.equal(result.connectionDeleted, true);
    assert.equal(trace.includes('deleteConnection'), true);
  });

  it('is idempotent: with no stored row it skips the revoke and the KMS decrypt, and still reports false/false', async () => {
    const { deps, trace } = makeDisconnectDeps({
      getConnection: async () => { trace.push('getConnection'); return null; },
      deleteConnection: async () => { trace.push('deleteConnection'); return { deleted: false, hadRefreshToken: false }; },
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: false }, deps);

    assert.equal(result.revoked, false);
    assert.equal(result.connectionDeleted, false);
    assert.equal(trace.includes('getRefreshToken'), false, 'no pointless KMS decrypt on a repeat disconnect');
    assert.equal(trace.includes('revokeGrant'), false, 'nothing to revoke');
    assert.equal(trace.includes('deleteScanSchedule'), true, 'an orphaned schedule is still cleared on a retry');
  });

  it('skips the revoke when the stored row has no wrapped token at all', async () => {
    const { deps, trace } = makeDisconnectDeps({
      getConnection: async () => { trace.push('getConnection'); return { userId: USER, hasRefreshToken: false }; },
    });

    const result = await disconnectAccount({ userId: USER }, deps);
    assert.equal(result.revoked, false);
    assert.equal(trace.includes('revokeGrant'), false);
  });

  it('skips the revoke when the decrypt returns nothing usable', async () => {
    const { deps, trace } = makeDisconnectDeps({
      getRefreshToken: async () => { trace.push('getRefreshToken'); return null; },
    });

    const result = await disconnectAccount({ userId: USER }, deps);
    assert.equal(result.revoked, false);
    assert.equal(trace.includes('revokeGrant'), false);
    assert.equal(trace.includes('deleteConnection'), true);
  });

  it('drops the cached access token for exactly the disconnecting user', async () => {
    const cleared = [];
    const { deps } = makeDisconnectDeps({ resetTokenCache: (userId) => cleared.push(userId) });

    await disconnectAccount({ userId: USER }, deps);
    assert.deepEqual(cleared, [USER]);
  });

  it('forwards the session-derived userId to every storage dependency, and no other id', async () => {
    const seen = [];
    const { deps } = makeDisconnectDeps({
      getConnection: async (userId) => { seen.push(['getConnection', userId]); return { hasRefreshToken: true }; },
      getRefreshToken: async (userId) => { seen.push(['getRefreshToken', userId]); return 'rt-secret-value'; },
      deleteScanSchedule: async (userId) => { seen.push(['deleteScanSchedule', userId]); return { available: true }; },
      deleteConnection: async (userId) => { seen.push(['deleteConnection', userId]); return { deleted: true, hadRefreshToken: true }; },
      deleteEventsForUser: async ({ userId }) => { seen.push(['deleteEventsForUser', userId]); return { deleted: 1, complete: true }; },
    });

    await disconnectAccount({ userId: 'google#user-1', deleteEvents: true }, deps);

    assert.equal(seen.length, 5);
    assert.equal(seen.every(([, userId]) => userId === 'google#user-1'), true, JSON.stringify(seen));
  });

  it('requires a userId', async () => {
    const { deps, trace } = makeDisconnectDeps();
    await assert.rejects(() => disconnectAccount({ userId: '' }, deps), /userId is required/);
    await assert.rejects(() => disconnectAccount({}, deps), /userId is required/);
    assert.deepEqual(trace, [], 'nothing ran');
  });

  it('never puts the refresh token in a log line', async () => {
    const { deps, log } = makeDisconnectDeps();
    await disconnectAccount({ userId: USER, deleteEvents: true }, deps);

    assert.ok(log.lines.length > 0, 'the disconnect logged something');
    assert.equal(/rt-secret-value/.test(log.text()), false);
  });
});

describe('TASK-013 unit: disconnectAccount does not resurrect the connection row', () => {
  /**
   * THE HAZARD, STATED IN CODE.
   *
   * `deleteScanSchedule` normally finishes by patching the connection row to
   * record "no schedule", through `updateConnection` -> `ddbUpdateItem`. A
   * DynamoDB UpdateItem with no existence condition CREATES the row it cannot
   * find, so that patch would put a stub connection back moments before (or
   * after) the disconnect deletes it. `disconnectAccount` injects a no-op
   * `updateConnection` to stop that.
   *
   * The stand-in below reproduces the real function's tail EXACTLY: it calls
   * whatever `updateConnection` it was handed and DEFAULTS to the real one, with
   * a fake `updateItem` standing in for the table. So if the no-op injection were
   * removed from disconnect.mjs, the default would fire and a write would land in
   * `tableWrites` - which is asserted empty.
   */
  function scheduleDeleteThatPatchesTheRow(tableWrites) {
    const updateItem = async ({ tableName, key, updates }) => {
      tableWrites.push({ tableName, key, updates });
      return { userId: key.userId, ...updates };
    };
    return async (userId, { env, updateConnection: patch = updateConnection } = {}) => {
      await patch(
        userId,
        {
          scheduleEnabled: false,
          scheduleFrequency: REMOVE_ATTRIBUTE,
          scheduleHour: REMOVE_ATTRIBUTE,
          scheduleDayOfWeek: REMOVE_ATTRIBUTE,
          timezone: REMOVE_ATTRIBUTE,
        },
        { updateItem, tableName: TABLE, env }
      );
      return { available: true, configured: false, enabled: false };
    };
  }

  it('the hazard is real: the schedule patch is an unconditional UpdateItem, which upserts', () => {
    const params = buildUpdateParams({
      tableName: TABLE,
      key: { userId: USER },
      updates: { scheduleEnabled: false, timezone: REMOVE_ATTRIBUTE, updatedAt: '2026-08-26T00:00:00.000Z' },
    });

    assert.equal('ConditionExpression' in params, false,
      'no attribute_exists guard - DynamoDB would create the row, which is exactly the resurrection risk');
    assert.ok(/SET/.test(params.UpdateExpression));
  });

  it('no write reaches the connections table while the schedule is cleared during a disconnect', async () => {
    const tableWrites = [];
    const { deps } = makeDisconnectDeps({
      deleteScanSchedule: scheduleDeleteThatPatchesTheRow(tableWrites),
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: false }, deps);

    assert.equal(result.scheduleCleared, true, 'the schedule was cleared');
    assert.deepEqual(tableWrites, [], 'a schedule patch during a disconnect must never write to the connections table');
  });

  it('no write reaches the table on a repeat disconnect either, where an upsert would invent a whole row', async () => {
    const tableWrites = [];
    const { deps } = makeDisconnectDeps({
      getConnection: async () => null,
      deleteConnection: async () => ({ deleted: false, hadRefreshToken: false }),
      deleteScanSchedule: scheduleDeleteThatPatchesTheRow(tableWrites),
    });

    const result = await disconnectAccount({ userId: USER }, deps);

    assert.equal(result.connectionDeleted, false);
    assert.deepEqual(tableWrites, [], 'a disconnected user must not get a stub connection row back');
  });
});

describe('TASK-013 unit: disconnectAccount partial-failure reporting', () => {
  it('reports scheduleCleared:false but still deletes, when clearing the schedule throws', async () => {
    const { deps, trace } = makeDisconnectDeps({
      deleteScanSchedule: async () => { trace.push('deleteScanSchedule'); throw new Error('scheduler unavailable'); },
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: true }, deps);

    assert.equal(result.scheduleCleared, false);
    assert.equal(result.connectionDeleted, true, 'an EventBridge problem must not strand a user whose grant is already dead');
    assert.equal(trace.includes('deleteConnection'), true);
  });

  it('reports eventsDeleteComplete:false when the erase reports incomplete', async () => {
    const { deps } = makeDisconnectDeps({
      deleteEventsForUser: async () => ({ deleted: 7, complete: false }),
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: true }, deps);
    assert.equal(result.eventsDeleted, 7);
    assert.equal(result.eventsDeleteComplete, false);
  });

  it('reports eventsDeleteComplete:false when the erase throws outright', async () => {
    const { deps } = makeDisconnectDeps({
      deleteEventsForUser: async () => { throw new Error('ddb boom'); },
    });

    const result = await disconnectAccount({ userId: USER, deleteEvents: true }, deps);

    assert.equal(result.connectionDeleted, true, 'the revoke and the row delete already happened and are reported truthfully');
    assert.equal(result.eventsDeleted, 0);
    assert.equal(result.eventsDeleteComplete, false, 'the honest "rows may remain" answer');
  });

  it('does not touch the events at all when deleteEvents is false or absent', async () => {
    for (const args of [{ userId: USER, deleteEvents: false }, { userId: USER }]) {
      const { deps, trace } = makeDisconnectDeps();
      const result = await disconnectAccount(args, deps);
      assert.equal(trace.includes('deleteEventsForUser'), false, `events erased for ${JSON.stringify(args)}`);
      assert.equal(result.eventsDeleted, 0);
      assert.equal(result.eventsDeleteComplete, true);
    }
  });

  it('does not erase events for a non-boolean deleteEvents that would pass a truthiness check', async () => {
    for (const truthy of ['true', 1, [], {}]) {
      const { deps, trace } = makeDisconnectDeps();
      await disconnectAccount({ userId: USER, deleteEvents: truthy }, deps);
      assert.equal(trace.includes('deleteEventsForUser'), false, `truthy value ${JSON.stringify(truthy)} triggered an erase`);
    }
  });

  it('coerces a non-numeric deleted count to 0 rather than leaking it into the response', async () => {
    const { deps } = makeDisconnectDeps({
      deleteEventsForUser: async () => ({ deleted: undefined, complete: true }),
    });
    const result = await disconnectAccount({ userId: USER, deleteEvents: true }, deps);
    assert.equal(result.eventsDeleted, 0);
  });
});

/* =========================================================================
 * frontend/settings.js - the pure confirmation helpers
 * ========================================================================= */

describe('TASK-013 unit: settings.js confirmation helpers', () => {
  it('uses a different phrase for keeping and for deleting', () => {
    assert.equal(CONFIRM_PHRASE_KEEP, 'DISCONNECT');
    assert.equal(CONFIRM_PHRASE_DELETE, 'DELETE MY EVENTS');
    assert.notEqual(CONFIRM_PHRASE_KEEP, CONFIRM_PHRASE_DELETE);
    assert.equal(requiredConfirmation(false), CONFIRM_PHRASE_KEEP);
    assert.equal(requiredConfirmation(true), CONFIRM_PHRASE_DELETE);
    assert.equal(requiredConfirmation(undefined), CONFIRM_PHRASE_KEEP, 'anything but a real true is the mild phrase');
    assert.equal(requiredConfirmation('true'), CONFIRM_PHRASE_KEEP);
  });

  it('accepts the exact phrase, forgives surrounding whitespace and refuses the wrong case', () => {
    assert.equal(isConfirmed('DISCONNECT', false), true);
    assert.equal(isConfirmed('  DISCONNECT  ', false), true);
    assert.equal(isConfirmed('disconnect', false), false);
    assert.equal(isConfirmed('DISCONNECT NOW', false), false);
    assert.equal(isConfirmed('DELETE MY EVENTS', true), true);
    assert.equal(isConfirmed('delete my events', true), false);
  });

  it('does not let the keep-phrase confirm the destructive choice', () => {
    assert.equal(isConfirmed('DISCONNECT', true), false, 'the milder confirmation cannot stand in for the erase');
    assert.equal(isConfirmed('DELETE MY EVENTS', false), false);
  });

  it('treats anything that is not a string as unconfirmed', () => {
    for (const value of [undefined, null, 0, 1, true, {}, [], ['DISCONNECT']]) {
      assert.equal(isConfirmed(value, false), false, `${JSON.stringify(value) ?? 'undefined'} must not confirm`);
      assert.equal(isConfirmed(value, true), false);
    }
  });

  it('always sends deleteEvents as a real boolean', () => {
    assert.deepEqual(disconnectRequestBody(true), { deleteEvents: true });
    assert.deepEqual(disconnectRequestBody(false), { deleteEvents: false });
    for (const truthy of ['true', 1, [], {}]) {
      assert.deepEqual(disconnectRequestBody(truthy), { deleteEvents: false }, `${JSON.stringify(truthy)} must not become true`);
      assert.equal(typeof disconnectRequestBody(truthy).deleteEvents, 'boolean');
    }
  });

  it('posts to the same path the Lambda routes', () => {
    assert.equal(DISCONNECT_ENDPOINT, '/calendar/api/auth/disconnect');
  });

  it('summarises a clean disconnect that kept the calendar', () => {
    const text = disconnectSummary({ revoked: true, connectionDeleted: true, eventsDeleted: 0, eventsDeleteComplete: true });
    assert.ok(/revoked/i.test(text), text);
    assert.ok(/kept/i.test(text), text);
  });

  it('summarises a clean erase with its count', () => {
    const text = disconnectSummary({ revoked: true, eventsDeleted: 12, eventsDeleteComplete: true });
    assert.ok(/12 event/.test(text), text);
    assert.equal(/may remain/.test(text), false);
  });

  it('tells the user rows may remain when eventsDeleteComplete is false', () => {
    const text = disconnectSummary({ revoked: true, eventsDeleted: 7, eventsDeleteComplete: false });
    assert.ok(/7 event/.test(text), text);
    assert.ok(/may remain/i.test(text), text);
    assert.ok(/again/i.test(text), text);
  });

  it('does not claim a revocation that did not happen', () => {
    const text = disconnectSummary({ revoked: false, connectionDeleted: false, eventsDeleted: 0, eventsDeleteComplete: true });
    assert.ok(/no stored/i.test(text), text);
    assert.equal(/^Access to your Gmail account has been revoked/.test(text), false);
  });

  it('never reaches the DOM through innerHTML', () => {
    const source = fs.readFileSync(path.join(CALENDAR_DIR, 'frontend', 'settings.js'), 'utf-8');
    const uses = source.match(/\.innerHTML/g) || [];
    assert.deepEqual(uses, [], 'settings.js must set text through textContent only');
    assert.ok(/textContent/.test(source), 'and it does set text, so the check above is not vacuous');
  });
});

/* =========================================================================
 * initDisconnectControl - driven against a tiny DOM stand-in
 * ========================================================================= */

/** The smallest element that satisfies what initDisconnectControl touches. */
function makeElement(extra = {}) {
  const listeners = new Map();
  return {
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatch(type) {
      for (const handler of listeners.get(type) || []) await handler();
    },
    ...extra,
  };
}

/** A `root` with the ids settings.js looks up. */
function makeFakeRoot() {
  const elements = {
    '#disconnect-gmail': makeElement(),
    '#disconnect-events-delete': makeElement(),
    '#disconnect-events-keep': makeElement({ checked: true }),
    '#disconnect-confirm-phrase': makeElement(),
    '#disconnect-confirm': makeElement(),
    '#disconnect-submit': makeElement({ disabled: true }),
    '#disconnect-status': makeElement(),
  };
  return { elements, querySelector: (selector) => elements[selector] ?? null };
}

describe('TASK-013 unit: initDisconnectControl', () => {
  it('returns null rather than throwing when the section is not on the page', () => {
    assert.equal(initDisconnectControl({ root: { querySelector: () => null } }), null);
    assert.equal(initDisconnectControl({ root: null }), null);
  });

  it('starts on "keep my events", with the mild phrase shown and the button disabled', () => {
    const root = makeFakeRoot();
    const control = initDisconnectControl({ root, fetchImpl: async () => { throw new Error('no request expected'); } });

    assert.notEqual(control, null);
    assert.equal(root.elements['#disconnect-events-keep'].checked, true);
    assert.equal(root.elements['#disconnect-events-delete'].checked, false, 'the destructive choice is not preselected');
    assert.equal(root.elements['#disconnect-confirm-phrase'].textContent, 'DISCONNECT');
    assert.equal(root.elements['#disconnect-submit'].disabled, true);
  });

  it('enables the button only once the exact phrase is typed', async () => {
    const root = makeFakeRoot();
    initDisconnectControl({ root, fetchImpl: async () => { throw new Error('no request expected'); } });
    const input = root.elements['#disconnect-confirm'];
    const submit = root.elements['#disconnect-submit'];

    input.value = 'DISCONN';
    await input.dispatch('input');
    assert.equal(submit.disabled, true);

    input.value = 'DISCONNECT';
    await input.dispatch('input');
    assert.equal(submit.disabled, false);
  });

  it('clears the typed confirmation when the choice changes, so it cannot be inherited by the erase', async () => {
    const root = makeFakeRoot();
    initDisconnectControl({ root, fetchImpl: async () => { throw new Error('no request expected'); } });
    const input = root.elements['#disconnect-confirm'];
    const submit = root.elements['#disconnect-submit'];

    input.value = 'DISCONNECT';
    await input.dispatch('input');
    assert.equal(submit.disabled, false, 'confirmed for the mild choice');

    root.elements['#disconnect-events-keep'].checked = false;
    root.elements['#disconnect-events-delete'].checked = true;
    await root.elements['#disconnect-events-delete'].dispatch('change');

    assert.equal(input.value, '', 'the typed text was discarded');
    assert.equal(submit.disabled, true, 'the destructive choice must be confirmed on its own terms');
    assert.equal(root.elements['#disconnect-confirm-phrase'].textContent, 'DELETE MY EVENTS');
  });

  it('sends deleteEvents:true only after the destructive phrase is typed', async () => {
    const root = makeFakeRoot();
    const calls = [];
    initDisconnectControl({
      root,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ revoked: true, eventsDeleted: 12, eventsDeleteComplete: true }) };
      },
    });

    root.elements['#disconnect-events-keep'].checked = false;
    root.elements['#disconnect-events-delete'].checked = true;
    await root.elements['#disconnect-events-delete'].dispatch('change');

    root.elements['#disconnect-confirm'].value = 'DELETE MY EVENTS';
    await root.elements['#disconnect-confirm'].dispatch('input');
    await root.elements['#disconnect-submit'].dispatch('click');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DISCONNECT_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(calls[0].init.body), { deleteEvents: true });
    assert.ok(/12 event/.test(root.elements['#disconnect-status'].textContent));
  });

  it('refuses to send anything when the confirmation is wrong, even if the button was re-enabled', async () => {
    const root = makeFakeRoot();
    let called = 0;
    initDisconnectControl({ root, fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; } });

    root.elements['#disconnect-confirm'].value = 'disconnect';
    root.elements['#disconnect-submit'].disabled = false; // the attribute is a hint, not the gate
    await root.elements['#disconnect-submit'].dispatch('click');

    assert.equal(called, 0, 'the click handler re-checks the phrase itself');
    assert.equal(root.elements['#disconnect-submit'].disabled, true, 'and puts the gate back');
  });

  it('tells the user nothing was deleted when the server answers 502, and does not report success', async () => {
    const root = makeFakeRoot();
    let notified = 0;
    initDisconnectControl({
      root,
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
      onDisconnected: () => { notified += 1; },
    });

    root.elements['#disconnect-confirm'].value = 'DISCONNECT';
    await root.elements['#disconnect-confirm'].dispatch('input');
    await root.elements['#disconnect-submit'].dispatch('click');

    const status = root.elements['#disconnect-status'].textContent;
    assert.ok(/nothing was deleted/i.test(status), status);
    assert.equal(notified, 0, 'a failed disconnect is not announced as a success');
  });

  it('survives a network failure without claiming anything changed', async () => {
    const root = makeFakeRoot();
    initDisconnectControl({ root, fetchImpl: async () => { throw new TypeError('fetch failed'); } });

    root.elements['#disconnect-confirm'].value = 'DISCONNECT';
    await root.elements['#disconnect-confirm'].dispatch('input');
    await root.elements['#disconnect-submit'].dispatch('click');

    const status = root.elements['#disconnect-status'].textContent;
    assert.ok(/nothing was changed/i.test(status), status);
  });
});

/* =========================================================================
 * frontend/settings.html - the markup the helpers rely on
 * ========================================================================= */

describe('TASK-013 unit: settings.html disconnect control', () => {
  const html = fs.readFileSync(path.join(CALENDAR_DIR, 'frontend', 'settings.html'), 'utf-8');

  it('states that access will be revoked at Google', () => {
    const summary = html.slice(html.indexOf('id="disconnect-summary"'), html.indexOf('</p>', html.indexOf('id="disconnect-summary"')));
    assert.ok(/revokes?/i.test(summary), summary);
    assert.ok(/Gmail/.test(summary), summary);
  });

  it('offers keeping and deleting as two explicit radio choices', () => {
    assert.ok(/id="disconnect-events-keep"/.test(html));
    assert.ok(/id="disconnect-events-delete"/.test(html));
    assert.ok(/Keep my calendar/i.test(html));
    assert.ok(/Delete my calendar/i.test(html));
    assert.ok(/permanently delete/i.test(html), 'the destructive choice says what it does');
    assert.ok(/cannot be undone/i.test(html));
  });

  it('preselects keeping the events - the destructive option is never the default', () => {
    const keep = html.slice(html.indexOf('id="disconnect-events-keep"'));
    const keepInput = keep.slice(0, keep.indexOf('/>'));
    assert.ok(/checked/.test(keepInput), keepInput);

    const del = html.slice(html.indexOf('id="disconnect-events-delete"'));
    const delInput = del.slice(0, del.indexOf('/>'));
    assert.equal(/checked/.test(delInput), false, 'the delete radio must not be preselected');
  });

  it('requires a typed confirmation and ships the submit button disabled', () => {
    assert.ok(/id="disconnect-confirm"/.test(html), 'there is a confirmation input');
    assert.ok(/id="disconnect-confirm-phrase">DISCONNECT</.test(html), 'the mild phrase is the one shown initially');
    const submit = html.slice(html.indexOf('id="disconnect-submit"'));
    assert.ok(/disabled/.test(submit.slice(0, submit.indexOf('</button>'))),
      'a page whose script never loads cannot submit an unconfirmed disconnect');
  });

  it('loads the module that enforces the confirmation', () => {
    assert.ok(/src="\/calendar\/settings\.js"/.test(html));
  });
});
