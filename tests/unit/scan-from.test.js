import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSince } from '../../src/lambda/calendar/backend/scan.mjs';
import { handlePutScanFrom } from '../../src/lambda/calendar/index.mjs';
import { REMOVE_ATTRIBUTE } from '../../src/lambda/calendar/backend/connections.mjs';

const NOW = Date.parse('2026-11-07T00:00:00.000Z');
const DAY = 86400000;

describe('computeSince with a user-set scanFrom', () => {
  it('uses scanFrom exactly, even when older than the sinceDays cap', () => {
    const d = computeSince({ lastScanAt: '2026-11-06T00:00:00.000Z', scanFrom: '2026-10-01T00:00:00.000Z', sinceDays: 5, now: () => NOW });
    assert.equal(d.toISOString(), '2026-10-01T00:00:00.000Z');
  });
  it('ignores a scanFrom in the future or invalid and falls back to the normal window', () => {
    const base = { lastScanAt: '2026-11-06T00:00:00.000Z', sinceDays: 5, now: () => NOW };
    const normal = computeSince(base).toISOString();
    assert.equal(computeSince({ ...base, scanFrom: '2027-01-01T00:00:00.000Z' }).toISOString(), normal);
    assert.equal(computeSince({ ...base, scanFrom: 'nope' }).toISOString(), normal);
  });
});

describe('PUT /calendar/api/scan/from', () => {
  const nowSeconds = NOW / 1000;
  const mk = (body, patch) => ({
    event: { body: JSON.stringify(body), headers: {}, requestContext: { http: { method: 'PUT' } } },
    options: {
      nowSeconds,
      env: {},
      updateConnection: patch,
    },
  });

  it('rejects without a session (401)', async () => {
    const { event, options } = mk({ scanFrom: '2026-10-01' }, async () => assert.fail('must not write'));
    const res = await handlePutScanFrom(event, options);
    assert.equal(res.statusCode, 401);
  });
});

describe('REMOVE_ATTRIBUTE sentinel', () => {
  it('is the shared symbol the scan test asserts on', () => {
    assert.equal(REMOVE_ATTRIBUTE, Symbol.for('calendar.connections.REMOVE_ATTRIBUTE'));
    assert.ok(DAY > 0);
  });
});
