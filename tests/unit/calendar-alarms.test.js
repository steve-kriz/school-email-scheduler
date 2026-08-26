/**
 * Unit tests for src/lambda/calendar/backend/alarms.mjs (TASK-011).
 *
 * The metric filters in terraform/alerting.tf count log events; alarms.mjs is
 * what produces them. Two things therefore have to hold and are pinned here:
 *
 *   1. The tokens are exactly the strings the filters match. The cross-file
 *      contract itself is asserted in tests/unit/calendar-alerting-terraform.test.js
 *      (which reads both sides); this file pins the JS side's own values so a
 *      rename shows up as two failures, not one silent drift.
 *   2. An alarm line can never carry credentials or a child's personal data
 *      into CloudWatch. That is `sanitiseAlarmFields`, and it is tested for
 *      what it drops AND for the collateral damage of dropping it - a field
 *      called `errorCode` or `emailCount` goes too, and that side effect is
 *      pinned deliberately rather than discovered later.
 *
 * Every assertion here executes the module. Nothing is proved by reading the
 * source text.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const alarmsModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'alarms.mjs');
const alarmsUrl = new URL(`file:///${alarmsModulePath.replace(/\\/g, '/')}`).href;
const {
  ALARM_TOKENS,
  DENIED_ALARM_FIELDS,
  MAX_ALARM_FIELD_LENGTH,
  isAllowedAlarmField,
  sanitiseAlarmFields,
  emitAlarm,
} = await import(alarmsUrl);

/**
 * Run `fn` with console.error replaced by a recorder, and return everything it
 * was called with. Restored in `finally` so a throwing assertion cannot leave
 * the rest of the suite writing into an array.
 */
function captureConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

describe('Unit: calendar alarm tokens and emission (TASK-011)', () => {
  describe('ALARM_TOKENS', () => {
    it('carries the two token strings terraform/alerting.tf filters on', () => {
      assert.strictEqual(ALARM_TOKENS.EXTRACTION_FAILED, 'CALENDAR_EXTRACTION_FAILED');
      assert.strictEqual(ALARM_TOKENS.REAUTH_REQUIRED, 'CALENDAR_REAUTH_REQUIRED');
      assert.deepStrictEqual(
        Object.keys(ALARM_TOKENS).sort(),
        ['EXTRACTION_FAILED', 'REAUTH_REQUIRED'],
        'A new token without a matching metric filter in alerting.tf would be alarmed on by nothing'
      );
    });

    it('is frozen, so a caller cannot redefine the contract at runtime', () => {
      assert.strictEqual(Object.isFrozen(ALARM_TOKENS), true, 'ALARM_TOKENS must be frozen');
      assert.throws(
        () => {
          'use strict';
          ALARM_TOKENS.EXTRACTION_FAILED = 'SOMETHING_ELSE';
        },
        TypeError,
        'Assigning to a frozen ALARM_TOKENS must throw a TypeError in module (strict) code'
      );
      assert.strictEqual(ALARM_TOKENS.EXTRACTION_FAILED, 'CALENDAR_EXTRACTION_FAILED', 'value survived the attempt');
    });
  });

  describe('isAllowedAlarmField', () => {
    it('allows the identifiers and counters the callers actually pass', () => {
      for (const name of ['userId', 'mode', 'messageId', 'errorName', 'count', 'durationMs', 'attempt']) {
        assert.strictEqual(isAllowedAlarmField(name), true, `${name} should be allowed`);
      }
    });

    it('refuses every denied substring, case-insensitively and anywhere in the name', () => {
      const refused = [
        'token',
        'TOKEN',
        'accessToken',
        'id_token',
        'refresh_token_hint',
        'clientSecret',
        'password',
        'Authorization',
        'authorizationHeader',
        'cookie',
        'Cookies',
        'sessionId',
        'requestBody',
        'subject',
        'snippet',
        'payload',
        'emailAddress',
        'address',
        'oauthCode',
        'stateParam',
      ];
      for (const name of refused) {
        assert.strictEqual(isAllowedAlarmField(name), false, `${name} must be refused`);
      }
    });

    it('covers every entry in DENIED_ALARM_FIELDS, so the list cannot grow entries that do nothing', () => {
      for (const denied of DENIED_ALARM_FIELDS) {
        assert.strictEqual(
          isAllowedAlarmField(`prefix_${denied}_suffix`),
          false,
          `denylist entry "${denied}" is not actually enforced`
        );
      }
      assert.strictEqual(DENIED_ALARM_FIELDS.length, 14, 'denylist size changed - update the expectations above');
    });

    it('ACKNOWLEDGED SIDE EFFECT: innocuous names containing a denied substring are dropped too', () => {
      // Pinned deliberately. `errorCode` contains "code" and `emailCount`
      // contains "email", so both go. That is the cost of a substring
      // denylist, and it is the right trade (a wrongly dropped field costs a
      // line of debugging; a wrongly emitted one costs credentials) - but it
      // must be a known behaviour, not a surprise. If this ever changes, the
      // change should be a deliberate one that turns this test red.
      assert.strictEqual(isAllowedAlarmField('errorCode'), false, 'errorCode is dropped because it contains "code"');
      assert.strictEqual(isAllowedAlarmField('statusCode'), false, 'statusCode is dropped because it contains "code"');
      assert.strictEqual(isAllowedAlarmField('emailCount'), false, 'emailCount is dropped because it contains "email"');
      assert.strictEqual(isAllowedAlarmField('scanState'), false, 'scanState is dropped because it contains "state"');
      // ...and the reason scan.mjs passes `errorName` rather than `errorCode`.
      assert.strictEqual(isAllowedAlarmField('errorName'), true, 'errorName is the allowed spelling');
    });

    it('refuses non-string and empty names rather than coercing them', () => {
      for (const name of ['', null, undefined, 42, {}, [], Symbol('userId')]) {
        assert.strictEqual(isAllowedAlarmField(name), false, `${String(name)} must be refused`);
      }
    });
  });

  describe('sanitiseAlarmFields', () => {
    it('keeps allowed primitives and drops denied names', () => {
      const safe = sanitiseAlarmFields({
        userId: 'google#123',
        mode: 'scheduled',
        messageId: 'abc123',
        errorName: 'AnthropicError',
        attempts: 3,
        truncated: true,
        accessToken: 'ya29.SECRET',
        subject: 'Year 4 excursion',
        snippet: 'Dear parents, please note...',
      });

      assert.deepStrictEqual(safe, {
        userId: 'google#123',
        mode: 'scheduled',
        messageId: 'abc123',
        errorName: 'AnthropicError',
        attempts: 3,
        truncated: true,
      });
      assert.strictEqual('accessToken' in safe, false, 'accessToken must not survive');
      assert.strictEqual('subject' in safe, false, 'subject must not survive');
      assert.strictEqual('snippet' in safe, false, 'snippet must not survive');
    });

    it('drops objects and arrays entirely rather than stringifying them', () => {
      const safe = sanitiseAlarmFields({
        message: { id: 'm1', raw: 'the entire email' },
        events: [{ title: 'Excursion' }],
        headers: new Map(),
        callback: () => 'x',
        marker: Symbol('m'),
        missing: undefined,
        absent: null,
        userId: 'google#123',
      });

      assert.deepStrictEqual(safe, { userId: 'google#123' });
      const serialised = JSON.stringify(safe);
      assert.strictEqual(
        serialised.includes('the entire email'),
        false,
        'an object value must never reach the log line, even stringified'
      );
      assert.strictEqual(serialised.includes('[object Object]'), false, 'no String(object) coercion');
    });

    it('drops non-finite numbers, which are not counts', () => {
      const safe = sanitiseAlarmFields({ a: Number.NaN, b: Infinity, c: -Infinity, d: 0, e: -1 });
      assert.deepStrictEqual(safe, { d: 0, e: -1 });
    });

    it(`caps a string at ${MAX_ALARM_FIELD_LENGTH} characters and marks the truncation`, () => {
      const long = 'x'.repeat(MAX_ALARM_FIELD_LENGTH + 50);
      const safe = sanitiseAlarmFields({ errorName: long });
      assert.strictEqual(safe.errorName.length, MAX_ALARM_FIELD_LENGTH + 3, 'capped value plus the "..." marker');
      assert.strictEqual(safe.errorName.endsWith('...'), true, 'truncation is visible in the value');
      assert.strictEqual(safe.errorName.slice(0, MAX_ALARM_FIELD_LENGTH), long.slice(0, MAX_ALARM_FIELD_LENGTH));
    });

    it('leaves a string exactly at the cap untouched', () => {
      const exact = 'y'.repeat(MAX_ALARM_FIELD_LENGTH);
      assert.strictEqual(sanitiseAlarmFields({ errorName: exact }).errorName, exact, 'no "..." at the boundary');
    });

    it('honours an explicit limit argument', () => {
      assert.strictEqual(sanitiseAlarmFields({ mode: 'scheduled' }, 4).mode, 'sche...');
    });

    it('returns an empty object for anything that is not a plain object', () => {
      for (const input of [undefined, null, 'userId=1', 42, ['userId'], true]) {
        assert.deepStrictEqual(sanitiseAlarmFields(input), {}, `${String(input)} must sanitise to {}`);
      }
    });
  });

  describe('emitAlarm', () => {
    it('emits the token first and on its own, followed by the sanitised fields', () => {
      const written = [];
      const emitted = emitAlarm(
        ALARM_TOKENS.EXTRACTION_FAILED,
        { userId: 'google#123', mode: 'manual', accessToken: 'ya29.SECRET' },
        { write: (message, fields) => written.push([message, fields]) }
      );

      assert.strictEqual(emitted, true, 'a known token must report that it emitted');
      assert.strictEqual(written.length, 1, 'exactly one line per call');
      assert.strictEqual(
        written[0][0],
        'CALENDAR_EXTRACTION_FAILED',
        'the token must be the whole first argument, so the CloudWatch term filter matches'
      );
      assert.deepStrictEqual(written[0][1], { userId: 'google#123', mode: 'manual' });
    });

    it('FAILURE PATH: an unknown token emits nothing and reports false', () => {
      const written = [];
      const emitted = emitAlarm('CALENDAR_EXTRACTON_FAILED', { userId: 'google#123' }, {
        write: (...args) => written.push(args),
      });

      assert.strictEqual(emitted, false, 'a typo must not be emitted');
      assert.deepStrictEqual(written, [], 'nothing may be written for an unknown token');
    });

    it('FAILURE PATH: non-string tokens are refused without throwing', () => {
      for (const token of [undefined, null, 42, {}, ['CALENDAR_EXTRACTION_FAILED']]) {
        const written = [];
        assert.strictEqual(
          emitAlarm(token, { userId: 'u' }, { write: (...args) => written.push(args) }),
          false,
          `${String(token)} must be refused`
        );
        assert.deepStrictEqual(written, [], 'nothing written');
      }
    });

    it('writes to console.error by default', () => {
      const calls = captureConsoleError(() => {
        const emitted = emitAlarm(ALARM_TOKENS.REAUTH_REQUIRED, { userId: 'google#9' });
        assert.strictEqual(emitted, true, 'default sink still reports emission');
      });

      assert.strictEqual(calls.length, 1, 'one console.error call');
      assert.strictEqual(calls[0][0], 'CALENDAR_REAUTH_REQUIRED');
      assert.deepStrictEqual(calls[0][1], { userId: 'google#9' });
    });

    it('falls back to console.error when deps.write is not a function', () => {
      const calls = captureConsoleError(() => {
        assert.strictEqual(emitAlarm(ALARM_TOKENS.REAUTH_REQUIRED, { userId: 'u' }, { write: 'not-a-function' }), true);
      });
      assert.strictEqual(calls.length, 1, 'a bad sink must not silence the alarm');
      assert.strictEqual(calls[0][0], 'CALENDAR_REAUTH_REQUIRED');
    });

    it('is NOT gated on CALENDAR_LOG_LEVEL: a verbosity setting must not disarm production alarms', () => {
      const original = process.env.CALENDAR_LOG_LEVEL;
      process.env.CALENDAR_LOG_LEVEL = 'none';
      try {
        const calls = captureConsoleError(() => {
          assert.strictEqual(emitAlarm(ALARM_TOKENS.EXTRACTION_FAILED, { userId: 'u', mode: 'scheduled' }), true);
        });
        assert.strictEqual(calls.length, 1, 'CALENDAR_LOG_LEVEL=none must not suppress an alarm');
        assert.strictEqual(calls[0][0], 'CALENDAR_EXTRACTION_FAILED');
      } finally {
        if (original === undefined) delete process.env.CALENDAR_LOG_LEVEL;
        else process.env.CALENDAR_LOG_LEVEL = original;
      }
    });

    it('emits with no fields at all', () => {
      const written = [];
      assert.strictEqual(emitAlarm(ALARM_TOKENS.EXTRACTION_FAILED, undefined, { write: (...a) => written.push(a) }), true);
      assert.deepStrictEqual(written[0], ['CALENDAR_EXTRACTION_FAILED', {}]);
    });

    it('a line built from an emission contains the token as a matchable term', () => {
      // What CloudWatch actually sees is the rendered log line. A quoted-term
      // filter pattern "CALENDAR_EXTRACTION_FAILED" matches the token anywhere
      // in that line, so the line is checked for it here the same way.
      let line = null;
      emitAlarm(
        ALARM_TOKENS.EXTRACTION_FAILED,
        { userId: 'google#123', errorName: 'AnthropicError' },
        { write: (message, fields) => { line = `${message} ${JSON.stringify(fields)}`; } }
      );
      assert.strictEqual(typeof line, 'string', 'a line was produced');
      assert.strictEqual(line.includes(ALARM_TOKENS.EXTRACTION_FAILED), true, 'token present in the rendered line');
      assert.strictEqual(line.includes('AnthropicError'), true, 'the error name survives for triage');
      assert.strictEqual(line.includes('ya29'), false, 'no token material');
    });
  });
});
