import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const scanModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'scan.mjs');
const scanUrl = new URL(`file:///${scanModulePath.replace(/\\/g, '/')}`).href;
const {
  runScan,
  computeSince,
  computeDeadline,
  capText,
  makeLogger,
  SCAN_STATUS,
  MANUAL_SCAN_MAX_MESSAGES,
  WATERMARK_OVERLAP_DAYS,
  SCAN_TIME_SAFETY_MARGIN_MS,
  DEFAULT_MAX_SCAN_DURATION_MS,
} = await import(scanUrl);

const gmailModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'gmail.mjs');
const gmailUrl = new URL(`file:///${gmailModulePath.replace(/\\/g, '/')}`).href;
const { DEFAULT_SINCE_DAYS } = await import(gmailUrl);

const scheduleModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'scan-schedule.mjs');
const scheduleUrl = new URL(`file:///${scheduleModulePath.replace(/\\/g, '/')}`).href;
const {
  validateScheduleInput,
  scheduleNameFor,
  isValidTimezone,
  buildScanCronExpression,
  ScheduleValidationError,
} = await import(scheduleUrl);

describe('Calendar Scan Unit Tests', () => {
  describe('computeSince', () => {
    it('should compute since as lastScanAt minus 2 days', () => {
      const lastScanAt = '2026-08-15T09:00:00Z';
      const now = () => new Date('2026-08-15T09:00:00Z').getTime();
      const sinceDays = 90;

      const result = computeSince({ lastScanAt, sinceDays, now });

      // Should be 2 days (48 hours) before
      const expected = new Date('2026-08-13T09:00:00Z');
      const diff = Math.abs(result.getTime() - expected.getTime());

      assert.ok(diff < 1000, 'Should be within 1 second of expected');
    });

    it('should use the given sinceDays default when no lastScanAt', () => {
      const now = () => new Date('2026-08-18T09:00:00Z').getTime();
      const sinceDays = 90;

      const result = computeSince({ lastScanAt: null, sinceDays, now });

      // ~90 days back from 2026-08-18
      const expected = new Date(now() - 90 * 24 * 60 * 60 * 1000);
      const diff = Math.abs(result.getTime() - expected.getTime());

      assert.ok(diff < 2000, 'Should be ~90 days back');
    });

    it('should handle invalid ISO date gracefully', () => {
      const result = computeSince({
        lastScanAt: 'invalid-date',
        sinceDays: 90,
        now: () => new Date('2026-08-18T09:00:00Z').getTime(),
      });

      // Should fall back to the sinceDays default
      assert.ok(result instanceof Date, 'Should return a Date');
    });

    it('should default sinceDays to 5 when omitted, so a first scan only fetches recent mail', () => {
      const now = () => new Date('2026-08-18T09:00:00Z').getTime();

      assert.equal(DEFAULT_SINCE_DAYS, 5, 'gmail.mjs default lookback must be 5 days');

      const result = computeSince({ lastScanAt: null, now });
      const expected = new Date(now() - 5 * 24 * 60 * 60 * 1000);

      assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000, 'Should be ~5 days back by default');
    });

    it('should cap a stale lastScanAt at sinceDays back, never re-fetching further than the ceiling', () => {
      const now = () => new Date('2026-08-18T09:00:00Z').getTime();
      // A watermark from months ago - the connection's schedule was paused, say.
      const lastScanAt = '2026-01-01T00:00:00Z';
      const sinceDays = 5;

      const result = computeSince({ lastScanAt, sinceDays, now });
      const expectedCeiling = new Date(now() - sinceDays * 24 * 60 * 60 * 1000);

      assert.ok(
        Math.abs(result.getTime() - expectedCeiling.getTime()) < 1000,
        'a stale watermark must not push the floor back past the sinceDays ceiling'
      );
    });

    it('should still use lastScanAt (minus overlap) when it is more recent than the sinceDays ceiling', () => {
      const now = () => new Date('2026-08-18T09:00:00Z').getTime();
      const lastScanAt = '2026-08-17T09:00:00Z'; // yesterday - well inside the 5-day ceiling
      const sinceDays = 5;

      const result = computeSince({ lastScanAt, sinceDays, now });
      const expected = new Date(Date.parse(lastScanAt) - WATERMARK_OVERLAP_DAYS * 24 * 60 * 60 * 1000);

      assert.ok(
        Math.abs(result.getTime() - expected.getTime()) < 1000,
        'a recent watermark should still be used as-is (with its overlap), not overridden by the ceiling'
      );
    });
  });

  describe('computeDeadline', () => {
    it('should compute deadline with safety margin', () => {
      const now = () => 100000;
      const remaining = 60000; // 60 seconds

      const deadline = computeDeadline({
        now,
        getRemainingTimeInMillis: () => remaining,
      });

      const budgetMs = deadline - now();

      // Budget should be remaining minus safety margin
      const expectedBudget = remaining - SCAN_TIME_SAFETY_MARGIN_MS;
      assert.equal(budgetMs, expectedBudget, 'Should reserve safety margin');
      assert.ok(budgetMs > 0, 'Should have time left for extraction');
    });

    it('should use default when getRemainingTimeInMillis is null', () => {
      const now = () => 100000;

      const deadline = computeDeadline({ now, getRemainingTimeInMillis: null });

      const available = deadline - now();

      assert.equal(available, DEFAULT_MAX_SCAN_DURATION_MS, 'Should use default');
    });

    it('should use default when getRemainingTimeInMillis is not a function', () => {
      const now = () => 100000;

      const deadline = computeDeadline({ now, getRemainingTimeInMillis: 'not-a-function' });

      const available = deadline - now();

      assert.equal(available, DEFAULT_MAX_SCAN_DURATION_MS, 'Should use default for non-function');
    });
  });

  describe('capText', () => {
    it('should truncate text longer than limit', () => {
      const longText = 'x'.repeat(300);
      const result = capText(longText, 200);

      assert.ok(result.length <= 203, 'Should be capped');
      assert.ok(result.endsWith('...'), 'Should end with ellipsis');
      assert.equal(result.slice(0, 200), 'x'.repeat(200), 'Should preserve prefix');
    });

    it('should not truncate text within limit', () => {
      const text = 'short text';
      const result = capText(text, 200);

      assert.equal(result, text, 'Should not modify short text');
    });

    it('should use default limit of 200 when not provided', () => {
      const text = 'x'.repeat(250);
      const result = capText(text);

      assert.ok(result.length <= 203, 'Should use default limit');
    });

    it('should handle null/undefined', () => {
      assert.equal(capText(null), '', 'Should handle null');
      assert.equal(capText(undefined), '', 'Should handle undefined');
    });
  });

  describe('makeLogger', () => {
    it('should return a function', () => {
      const logger = makeLogger();

      assert.equal(typeof logger, 'function', 'Should return a function');
    });

    it('should log when level is not "none"', () => {
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args);

      const logger = makeLogger({ CALENDAR_LOG_LEVEL: 'basic' });
      logger('test message', { field: 'value' });

      console.log = originalLog;

      assert.equal(logs.length, 1, 'Should have logged');
    });

    it('should not log when level is "none"', () => {
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args);

      const logger = makeLogger({ CALENDAR_LOG_LEVEL: 'none' });
      logger('test message');

      console.log = originalLog;

      assert.equal(logs.length, 0, 'Should not log at "none" level');
    });
  });

  describe('validateScheduleInput', () => {
    it('should validate valid daily schedule', () => {
      const result = validateScheduleInput({
        frequency: 'daily',
        hour: 7,
        timezone: 'UTC',
      });

      assert.equal(result.frequency, 'daily');
      assert.equal(result.hour, 7);
      assert.equal(result.timezone, 'UTC');
      assert.equal(result.dayOfWeek, null);
    });

    it('should validate valid weekly schedule', () => {
      const result = validateScheduleInput({
        frequency: 'weekly',
        hour: 7,
        dayOfWeek: 3,
        timezone: 'UTC',
      });

      assert.equal(result.frequency, 'weekly');
      assert.equal(result.hour, 7);
      assert.equal(result.dayOfWeek, 3);
    });

    it('should reject non-object payload', () => {
      assert.throws(
        () => validateScheduleInput('not an object'),
        ScheduleValidationError,
        'Should reject non-object'
      );
    });

    it('should reject invalid frequency', () => {
      assert.throws(
        () => validateScheduleInput({
          frequency: 'hourly',
          hour: 7,
          timezone: 'UTC',
        }),
        (err) => err.field === 'frequency',
        'Should reject invalid frequency'
      );
    });

    it('should reject hour outside 0-23', () => {
      assert.throws(
        () => validateScheduleInput({
          frequency: 'daily',
          hour: 25,
          timezone: 'UTC',
        }),
        (err) => err.field === 'hour',
        'Should reject hour 25'
      );

      assert.throws(
        () => validateScheduleInput({
          frequency: 'daily',
          hour: -1,
          timezone: 'UTC',
        }),
        (err) => err.field === 'hour',
        'Should reject negative hour'
      );
    });

    it('should reject invalid timezone', () => {
      assert.throws(
        () => validateScheduleInput({
          frequency: 'daily',
          hour: 7,
          timezone: 'Invalid/Zone',
        }),
        (err) => err.field === 'timezone',
        'Should reject invalid timezone'
      );
    });

    it('should accept hour as string', () => {
      const result = validateScheduleInput({
        frequency: 'daily',
        hour: '7',
        timezone: 'UTC',
      });

      assert.equal(result.hour, 7, 'Should parse hour from string');
    });

    it('should reject hour as invalid string', () => {
      assert.throws(
        () => validateScheduleInput({
          frequency: 'daily',
          hour: 'abc',
          timezone: 'UTC',
        }),
        (err) => err.field === 'hour',
        'Should reject non-numeric hour string'
      );
    });
  });

  describe('buildScanCronExpression', () => {
    it('should build daily cron expression', () => {
      const cron = buildScanCronExpression({
        frequency: 'daily',
        hour: 7,
        dayOfWeek: null,
      });

      assert.match(cron, /cron\(0 7 \* \* \? \*\)/, 'Should be daily at 7am');
    });

    it('should build weekly cron expression', () => {
      const cron = buildScanCronExpression({
        frequency: 'weekly',
        hour: 7,
        dayOfWeek: 3, // Wednesday
      });

      assert.match(cron, /cron\(0 7 \? \* WED \*\)/, 'Should be weekly on Wednesday at 7am');
    });

    it('should include hour in cron', () => {
      const cron = buildScanCronExpression({
        frequency: 'daily',
        hour: 15,
        dayOfWeek: null,
      });

      assert.match(cron, /0 15/, 'Should include hour 15');
    });

    it('should use correct day-of-week tokens', () => {
      const days = [
        { dow: 0, token: 'SUN' },
        { dow: 1, token: 'MON' },
        { dow: 2, token: 'TUE' },
        { dow: 3, token: 'WED' },
        { dow: 4, token: 'THU' },
        { dow: 5, token: 'FRI' },
        { dow: 6, token: 'SAT' },
      ];

      for (const { dow, token } of days) {
        const cron = buildScanCronExpression({
          frequency: 'weekly',
          hour: 7,
          dayOfWeek: dow,
        });

        assert.match(cron, new RegExp(`\\* ${token} `), `Should use ${token} for day ${dow}`);
      }
    });
  });

  describe('scheduleNameFor', () => {
    it('should generate consistent name for same userId', () => {
      const userId = 'google#123456789';
      const env = { SCAN_SCHEDULE_PREFIX: 'test-prefix' };

      const name1 = scheduleNameFor(userId, env);
      const name2 = scheduleNameFor(userId, env);

      assert.equal(name1, name2, 'Should be deterministic');
    });

    it('should not contain raw userId', () => {
      const userId = 'google#123456789';
      const env = { SCAN_SCHEDULE_PREFIX: 'prefix' };

      const name = scheduleNameFor(userId, env);

      assert.ok(!name.includes('123456789'), 'Should not contain user number');
      assert.ok(!name.includes('google'), 'Should not contain provider prefix');
    });

    it('should not contain @ symbol', () => {
      const userId = 'google#user@example.com';
      const env = { SCAN_SCHEDULE_PREFIX: 'prefix' };

      const name = scheduleNameFor(userId, env);

      assert.ok(!name.includes('@'), 'Should not contain @ symbol');
    });

    it('should be prefix-hash format', () => {
      const userId = 'google#123';
      const env = { SCAN_SCHEDULE_PREFIX: 'test-prefix' };

      const name = scheduleNameFor(userId, env);

      assert.match(name, /^test-prefix-[a-f0-9]{16}$/, 'Should be prefix-hash(16 chars)');
    });

    it('should use provided prefix', () => {
      const userId = 'google#123';
      const env = { SCAN_SCHEDULE_PREFIX: 'my-custom-prefix' };

      const name = scheduleNameFor(userId, env);

      assert.ok(name.startsWith('my-custom-prefix-'), 'Should use custom prefix');
    });
  });

  describe('isValidTimezone', () => {
    it('should accept valid timezones', () => {
      const validZones = [
        'UTC',
        'America/New_York',
        'Europe/London',
        'Asia/Tokyo',
        'Australia/Sydney',
      ];

      for (const zone of validZones) {
        const result = isValidTimezone(zone);
        assert.ok(result, `Should accept ${zone}`);
      }
    });

    it('should reject invalid timezones', () => {
      const invalidZones = [
        'Invalid/Zone',
        'Mars/Olympus_Mons',
        'Not/A/Real/Zone',
        '',
        null,
        undefined,
      ];

      for (const zone of invalidZones) {
        const result = isValidTimezone(zone);
        assert.ok(!result, `Should reject ${zone}`);
      }
    });

    it('should reject non-string', () => {
      assert.equal(isValidTimezone(123), false, 'Should reject number');
      assert.equal(isValidTimezone({}), false, 'Should reject object');
      assert.equal(isValidTimezone([]), false, 'Should reject array');
    });
  });

  describe('runScan - unit tests', () => {
    describe('not_configured path', () => {
      it('should return not_configured when searchDomains is empty', async () => {
        const result = await runScan(
          { userId: 'google#123', mode: 'manual' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: '',
              lastScanAt: null,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
          }
        );

        assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
        assert.equal(result.messagesScanned, 0);
      });

      it('should not call Gmail when not configured', async () => {
        let gmailCalled = false;

        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: undefined,
              lastScanAt: null,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
            fetchCandidateMessages: async () => {
              gmailCalled = true;
              return { messages: [], truncated: false, errors: [], newestReceivedAt: null };
            },
          }
        );

        assert.equal(gmailCalled, false, 'Gmail should not be called');
        assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      });
    });

    describe('locked path', () => {
      it('should return LOCKED when lock cannot be acquired', async () => {
        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: null,
            }),
            acquireScanLock: async () => false, // Lock failed
            releaseScanLock: async () => {},
          }
        );

        assert.equal(result.status, SCAN_STATUS.LOCKED);
      });
    });

    describe('manual scan cap', () => {
      it('should cap manual scans at MANUAL_SCAN_MAX_MESSAGES', async () => {
        let capturedMaxMessages = null;

        const result = await runScan(
          { userId: 'google#123', mode: 'manual', maxMessages: 1000 },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: null,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
            fetchCandidateMessages: async (args) => {
              capturedMaxMessages = args.maxMessages;
              return { messages: [], truncated: false, errors: [], newestReceivedAt: null };
            },
            updateConnection: async () => {},
          }
        );

        assert.ok(
          capturedMaxMessages <= MANUAL_SCAN_MAX_MESSAGES,
          `Manual scan should be capped at ${MANUAL_SCAN_MAX_MESSAGES}`
        );
      });
    });

    describe('lock release on throw', () => {
      it('should release lock even when extraction throws', async () => {
        let lockReleased = false;

        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: null,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {
              lockReleased = true;
            },
            fetchCandidateMessages: async () => ({
              messages: [{ id: 'msg1' }],
              truncated: false,
              errors: [],
              newestReceivedAt: new Date().toISOString(),
            }),
            extractFromMessage: async () => {
              throw new Error('Extraction failed');
            },
            storeEvents: async () => ({ written: 0, skipped: [] }),
            updateConnection: async () => {},
          }
        );

        assert.ok(lockReleased, 'Lock must be released even when extraction throws');
      });
    });

    describe('watermark on clean run', () => {
      it('should advance watermark to newestReceivedAt on clean run', async () => {
        const newestReceivedAt = '2026-08-18T10:00:00Z';
        let updatePatch = null;

        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: '2026-08-16T10:00:00Z',
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
            fetchCandidateMessages: async () => ({
              messages: [],
              truncated: false,
              errors: [],
              newestReceivedAt,
            }),
            storeEvents: async () => ({ written: 0, skipped: [] }),
            updateConnection: async (userId, patch) => {
              updatePatch = patch;
            },
          }
        );

        assert.equal(result.status, SCAN_STATUS.OK, 'Clean run should be ok');
        assert.equal(updatePatch.lastScanAt, newestReceivedAt, 'Should advance to newest');
      });
    });

    describe('watermark on truncated run', () => {
      it('should pin watermark at sinceDate on truncated run', async () => {
        const newestReceivedAt = '2026-08-18T10:00:00Z';
        const lastScanAt = '2026-08-16T10:00:00Z';
        let updatePatch = null;

        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            // Fixed and close to lastScanAt/newestReceivedAt above, so the
            // computeSince ceiling (now - sinceDays) never overrides the
            // lastScanAt-derived floor this test means to exercise.
            now: () => new Date('2026-08-18T12:00:00Z').getTime(),
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
            fetchCandidateMessages: async (args) => ({
              messages: [],
              truncated: true, // Truncated!
              errors: [],
              newestReceivedAt,
            }),
            storeEvents: async () => ({ written: 0, skipped: [] }),
            updateConnection: async (userId, patch) => {
              updatePatch = patch;
            },
          }
        );

        assert.equal(result.truncated, true, 'Should report truncated');
        // Since = lastScanAt - 2 days, so it should pin at that floor
        assert.ok(
          updatePatch.lastScanAt <= new Date(new Date(lastScanAt).getTime() - 2 * 24 * 60 * 60 * 1000 + 1000).toISOString(),
          'Should pin at query floor, not advance'
        );
      });
    });

    describe('store error handling', () => {
      it('should report written:0 and partial status when store throws', async () => {
        let updatePatch = null;

        const result = await runScan(
          { userId: 'google#123' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: null,
            }),
            acquireScanLock: async () => true,
            releaseScanLock: async () => {},
            fetchCandidateMessages: async () => ({
              messages: [{ id: 'msg1' }],
              truncated: false,
              errors: [],
              newestReceivedAt: new Date().toISOString(),
            }),
            extractFromMessage: async () => ({
              events: [{ id: 'event1', data: {} }],
            }),
            storeEvents: async () => {
              throw new Error('DynamoDB failed');
            },
            updateConnection: async (userId, patch) => {
              updatePatch = patch;
            },
          }
        );

        assert.equal(result.status, SCAN_STATUS.PARTIAL, 'Should be marked partial');
        assert.equal(result.eventsCreated, 0, 'Should report 0 created, not guessed');
        assert.equal(updatePatch.lastScanEventsCreated, 0, 'Patch should reflect 0 written');
      });
    });
  });
});
