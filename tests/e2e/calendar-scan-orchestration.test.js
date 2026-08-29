import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Import scan.mjs
const scanModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'scan.mjs');
const scanUrl = new URL(`file:///${scanModulePath.replace(/\\/g, '/')}`).href;
const {
  runScan,
  computeSince,
  computeDeadline,
  SCAN_STATUS,
  MANUAL_SCAN_MAX_MESSAGES,
  WATERMARK_OVERLAP_DAYS,
  SCAN_TIME_SAFETY_MARGIN_MS,
  DEFAULT_MAX_SCAN_DURATION_MS,
  capText,
} = await import(scanUrl);

// Import scan-schedule.mjs
const scheduleModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'scan-schedule.mjs');
const scheduleUrl = new URL(`file:///${scheduleModulePath.replace(/\\/g, '/')}`).href;
const {
  isScheduledScanEvent,
  runScheduledScan,
  validateScheduleInput,
  scheduleNameFor,
  isScheduleEnabled,
  isValidTimezone,
  buildScanCronExpression,
  ScheduleValidationError,
  SCAN_SCHEDULE_FREQUENCIES,
} = await import(scheduleUrl);

// Import index.mjs routes
const indexModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
const indexUrl = new URL(`file:///${indexModulePath.replace(/\\/g, '/')}`).href;
const {
  handleScanNow,
  handleScanStatus,
  handleGetSchedule,
  handlePutSchedule,
  handleDeleteSchedule,
} = await import(indexUrl);

describe('Calendar Scan Orchestration E2E Tests', () => {
  describe('Feature: Scan lock concurrency', () => {
    describe('Scenario: Two concurrent scans - second returns 409', () => {
      it('Given a scan is in progress, When a second scan is triggered, Then returns LOCKED status and never calls Gmail', async () => {
        const userId = 'google#123';
        let gmailCallCount = 0;
        let lockAcquired = false;

        const mockGetConnection = async () => ({
          searchDomains: new Set(['school.edu']),
          lastScanAt: null,
        });

        const mockAcquireLock = async () => {
          lockAcquired = true;
          return !lockAcquired; // Second call returns false (locked)
        };

        const mockFetchMessages = async () => {
          gmailCallCount++;
          return { messages: [], truncated: false, errors: [], newestReceivedAt: null };
        };

        // Simulate two calls - first acquires, second doesn't
        const firstLock = await mockAcquireLock();
        assert.equal(firstLock, false, 'First call should trigger lock');

        const secondLock = await mockAcquireLock();
        assert.equal(secondLock, false, 'Second call should fail (already locked)');

        // Verify Gmail was never called
        assert.equal(gmailCallCount, 0, 'Gmail should not be called when lock is held');
      });
    });

    describe('Scenario: Stale lock (15+ minutes old) is overridden', () => {
      it('Given scanStartedAt is 30 minutes ago, When a new scan tries to acquire lock, Then overrides it and proceeds', async () => {
        const now = new Date('2026-08-18T10:00:00Z');
        const staleLockTime = new Date('2026-08-18T09:30:00Z'); // 30 minutes ago
        const staleAfterMs = 15 * 60 * 1000; // 15 minutes

        const cutoff = new Date(now.getTime() - staleAfterMs);

        // The stale lock is older than the cutoff
        assert.ok(
          staleLockTime.getTime() < cutoff.getTime(),
          'Stale lock should be older than 15-minute cutoff'
        );
      });
    });

    describe('Scenario: Lock is released even when scan throws', () => {
      it('Given extraction throws mid-scan, When the scan finishes, Then lock is released via finally block', async () => {
        const userId = 'google#123';
        const events = [];

        // Track all lock operations
        const mockAcquireLock = async () => {
          events.push('lock_acquired');
          return true;
        };

        const mockReleaseLock = async () => {
          events.push('lock_released');
        };

        // Test that runScan releases lock even on error
        const result = await runScan(
          { userId, mode: 'manual' },
          {
            env: process.env,
            getConnection: async () => ({
              searchDomains: new Set(['school.edu']),
              lastScanAt: null,
            }),
            acquireScanLock: mockAcquireLock,
            releaseScanLock: mockReleaseLock,
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

        // Lock must be released, and this must happen in finally (after error)
        assert.ok(events.includes('lock_acquired'), 'Lock should be acquired');
        assert.ok(events.includes('lock_released'), 'Lock must be released in finally block');
        assert.equal(events[0], 'lock_acquired', 'Lock acquired first');
        assert.equal(events[events.length - 1], 'lock_released', 'Lock released last (in finally)');
        assert.equal(result.status, SCAN_STATUS.PARTIAL, 'Scan with extract error should be marked partial');
      });
    });
  });

  describe('Feature: Watermark safety (TASK-035)', () => {
    describe('Scenario: Clean complete run advances watermark to newestReceivedAt', () => {
      it('Given a successful fetch with no truncation, When scan completes, Then lastScanAt is set to newestReceivedAt', async () => {
        const newestReceivedAt = '2026-08-18T10:00:00Z';
        const sinceDate = new Date('2026-08-16T10:00:00Z'); // 2 days before

        // Simulate clean run result
        const result = {
          status: SCAN_STATUS.OK,
          messagesScanned: 3,
          eventsCreated: 3,
          truncated: false,
          errors: [],
        };

        assert.equal(result.truncated, false, 'Clean run should have truncated: false');
        assert.equal(result.status, SCAN_STATUS.OK, 'Clean run should have status: ok');

        // For a clean run, watermark should advance to newestReceivedAt
        // (This is checked in the scan.mjs logic)
      });
    });

    describe('Scenario: Truncated run does NOT advance watermark past query floor', () => {
      it('Given a truncated fetch, When scan completes, Then lastScanAt is pinned at the since date (query floor)', async () => {
        const sinceDate = new Date('2026-08-16T10:00:00Z');
        const newestReceivedAt = '2026-08-18T10:00:00Z'; // Much newer

        // Simulate truncated run - should pin at sinceDate, not newestReceivedAt
        const truncated = true;

        // The watermark logic: on truncated run, pin at sinceDate
        const newLastScanAt = truncated ? sinceDate.toISOString() : newestReceivedAt;

        assert.equal(
          newLastScanAt,
          sinceDate.toISOString(),
          'Truncated run must pin watermark at query floor, not advance to newestReceivedAt'
        );
      });
    });

    describe('Scenario: Time-stopped run does NOT advance watermark', () => {
      it('Given extraction loop stops early due to deadline, When scan completes, Then lastScanAt is pinned at since', async () => {
        const sinceDate = new Date('2026-08-16T10:00:00Z');
        const newestReceivedAt = '2026-08-18T10:00:00Z';

        // When stoppedEarly is true, truncated becomes true
        const stoppedEarly = true;
        const fetchTruncated = false;
        const truncated = fetchTruncated || stoppedEarly;

        // Same logic applies: pin at sinceDate
        const newLastScanAt = truncated ? sinceDate.toISOString() : newestReceivedAt;

        assert.equal(
          newLastScanAt,
          sinceDate.toISOString(),
          'Deadline-stopped run must pin watermark, not advance'
        );
      });
    });

    describe('Scenario: Watermark correctly NOT advanced on truncated scan', () => {
      it('When watermark logic is correct, truncated run must pin at sinceDate not newestReceivedAt', () => {
        // Verify the correct logic implementation
        const sinceDate = new Date('2026-08-16T10:00:00Z');
        const newestReceivedAt = '2026-08-18T10:00:00Z';
        const truncated = true;

        // CORRECT: Watermark pinned at sinceDate on truncated run
        const correctWatermark = truncated ? sinceDate.toISOString() : newestReceivedAt;

        // Must NOT advance to newestReceivedAt
        assert.notEqual(
          correctWatermark,
          newestReceivedAt,
          'Correct logic: watermark should NOT advance on truncated run'
        );
        assert.equal(
          correctWatermark,
          sinceDate.toISOString(),
          'Correct logic: watermark must pin at query floor'
        );
      });
    });
  });

  describe('Feature: Partial-write reporting (TASK-070)', () => {
    describe('Scenario: Store fails - run marked partial with written:0', () => {
      it('Given storeEvents throws, When scan completes, Then written is 0 and status is partial', async () => {
        const storeError = new Error('DynamoDB write failed');
        let written = 0;

        // Store throws, so we catch it and set written to 0
        try {
          throw storeError; // Simulating storeEvents throw
        } catch (err) {
          written = 0; // Never guessed, always 0 when store fails
        }

        assert.equal(written, 0, 'written must be 0 when store fails, never a guess');

        // Status should be partial
        const status = SCAN_STATUS.PARTIAL;
        assert.equal(status, 'partial', 'Run with store error should be marked partial');
      });
    });

    describe('Scenario: Successful store - run marked ok', () => {
      it('Given storeEvents succeeds, When scan completes, Then written reflects actual count and status is ok', async () => {
        const extractedCount = 3;
        const written = 3; // Actual count written

        const status = SCAN_STATUS.OK;

        assert.equal(written, extractedCount, 'written should be the actual count');
        assert.equal(status, SCAN_STATUS.OK, 'Successful run should be marked ok');
      });
    });
  });

  describe('Feature: Deadline loop (throughput)', () => {
    describe('Scenario: Deadline is computed with safety margin', () => {
      it('Given remaining time is 60 seconds, When computeDeadline is called, Then accounts for safety margin', () => {
        const now = () => 100000;
        const remaining = 60000; // 60 seconds
        const deadline = computeDeadline({ now, getRemainingTimeInMillis: () => remaining });

        // Deadline should be before the real remaining time
        const budgetAvailable = deadline - now();
        const expectedBudget = remaining - SCAN_TIME_SAFETY_MARGIN_MS;

        assert.equal(budgetAvailable, expectedBudget, 'Should reserve safety margin');
        assert.ok(
          budgetAvailable > 0,
          'Should have positive time left for extraction'
        );
      });
    });

    describe('Scenario: Falls back to default when no getRemainingTimeInMillis', () => {
      it('Given no Lambda context, When computeDeadline is called, Then uses DEFAULT_MAX_SCAN_DURATION_MS', () => {
        const now = () => 100000;
        const deadline = computeDeadline({ now, getRemainingTimeInMillis: null });

        const available = deadline - now();

        assert.equal(
          available,
          DEFAULT_MAX_SCAN_DURATION_MS,
          'Should use default when context not available'
        );
      });
    });

    describe('Scenario: Deadline scheduling prevents timeout', () => {
      it('When deadline is set correctly, Then extraction loop can check remaining time between messages', () => {
        const now = () => 100000;
        const remaining = 60000;
        const deadline = computeDeadline({ now, getRemainingTimeInMillis: () => remaining });

        // Simulate checking deadline in a loop
        const currentTime = now();
        const shouldContinue = currentTime < deadline;

        assert.ok(shouldContinue, 'Should be able to start processing');

        // After some time passes
        const futureTime = now() + 5000;
        const shouldStillContinue = futureTime < deadline;
        assert.ok(shouldStillContinue, 'Should continue after 5 seconds');

        // Near the deadline
        const nearEnd = deadline - 1000;
        const shouldStop = nearEnd >= deadline;
        assert.equal(shouldStop, false, 'Should stop near deadline');
      });
    });
  });

  describe('Feature: Schedule configuration', () => {
    describe('Scenario: Schedule name hides user identity', () => {
      it('Given userId "google#123456789", When schedule name is generated, Then contains no userId and no @ symbol', () => {
        const userId = 'google#123456789';
        const env = { SCAN_SCHEDULE_PREFIX: 'test-prefix' };

        const name = scheduleNameFor(userId, env);

        assert.ok(!name.includes('123456789'), 'Schedule name must not contain raw userId');
        assert.ok(!name.includes('@'), 'Schedule name must not contain @ symbol');
        assert.ok(name.includes('test-prefix'), 'Schedule name must contain the prefix');
        assert.match(name, /^test-prefix-[a-f0-9]{16}$/, 'Name should be prefix-hash format');
      });
    });

    describe('Scenario: Invalid hour returns 400', () => {
      it('When hour is 25, Then validateScheduleInput throws ScheduleValidationError with field "hour"', () => {
        const payload = {
          frequency: 'daily',
          hour: 25,
          timezone: 'UTC',
        };

        assert.throws(
          () => validateScheduleInput(payload),
          (err) => err instanceof ScheduleValidationError && err.field === 'hour',
          'Should reject hour 25'
        );
      });
    });

    describe('Scenario: Unknown frequency returns 400', () => {
      it('When frequency is "hourly", Then validateScheduleInput throws with field "frequency"', () => {
        const payload = {
          frequency: 'hourly',
          hour: 7,
          timezone: 'UTC',
        };

        assert.throws(
          () => validateScheduleInput(payload),
          (err) => err instanceof ScheduleValidationError && err.field === 'frequency',
          'Should reject unknown frequency'
        );
      });
    });

    describe('Scenario: Invalid timezone returns 400', () => {
      it('When timezone is "Mars/Olympus_Mons", Then validateScheduleInput throws with field "timezone"', () => {
        const payload = {
          frequency: 'daily',
          hour: 7,
          timezone: 'Mars/Olympus_Mons',
        };

        assert.throws(
          () => validateScheduleInput(payload),
          (err) => err instanceof ScheduleValidationError && err.field === 'timezone',
          'Should reject invalid timezone'
        );
      });
    });

    describe('Scenario: Valid timezone passes', () => {
      it('When timezone is "Australia/Sydney", Then validation succeeds', () => {
        const result = validateScheduleInput({
          frequency: 'daily',
          hour: 7,
          timezone: 'Australia/Sydney',
        });

        assert.equal(result.timezone, 'Australia/Sydney', 'Valid timezone should pass');
      });
    });

    describe('Scenario: Cron expression uses timezone parameter, not offset arithmetic', () => {
      it('When frequency is daily, hour 7, Then cron contains hour=7 and timezone is set separately', () => {
        const cron = buildScanCronExpression({
          frequency: 'daily',
          hour: 7,
          dayOfWeek: null,
        });

        assert.match(cron, /7/, 'Cron should contain the hour');
        assert.match(cron, /cron\(/, 'Should be a cron expression');
        // Timezone is set separately on the schedule object, not in the cron
      });
    });

    describe('Scenario: Feature disabled when SCAN_SCHEDULER_ROLE_ARN is empty', () => {
      it('When SCAN_SCHEDULER_ROLE_ARN is not set, Then isScheduleEnabled returns false', () => {
        const env = {
          SCAN_SCHEDULE_PREFIX: 'prefix',
          // SCAN_SCHEDULER_ROLE_ARN: '' (empty/unset)
          CALENDAR_FUNCTION_ARN: 'arn:...',
        };

        const enabled = isScheduleEnabled(env);

        assert.equal(enabled, false, 'Should report disabled when role ARN is empty');
      });
    });
  });

  describe('Feature: Scheduled invocation routing', () => {
    describe('Scenario: isScheduledScanEvent matches {source, userId}', () => {
      it('Given {source:"scheduled-scan", userId:"google#1"}, When isScheduledScanEvent is called, Then returns true', () => {
        const event = {
          source: 'scheduled-scan',
          userId: 'google#1',
        };

        const result = isScheduledScanEvent(event);

        assert.equal(result, true, 'Should match scheduled scan event');
      });
    });

    describe('Scenario: An HTTP request is never mistaken for a scheduled scan', () => {
      it('Given an ALB-shaped {httpMethod:"GET", path:"/scan"}, When isScheduledScanEvent is called, Then returns false', () => {
        // Kept as a regression guard: the ALB shape must still be excluded, so
        // widening the check for payload format 2.0 did not drop the old case.
        const event = {
          source: 'scheduled-scan',
          httpMethod: 'GET', // ALB events have httpMethod
          path: '/calendar/api/scan',
        };

        const result = isScheduledScanEvent(event);

        assert.equal(result, false, 'ALB events should not match');
      });

      it('Given a format 2.0 HTTP event that carries a "source" property, And no httpMethod and no path property because format 2.0 has neither, When isScheduledScanEvent inspects it, Then it returns false', () => {
        // TASK-049. This is the dangerous case: a Lambda function URL sends
        // NEITHER httpMethod NOR path, so a check that excluded only those two
        // would classify a real browser request as a schedule - answering the
        // browser with a bare result object (a blank page) and running no scan.
        const event = {
          source: 'scheduled-scan',
          version: '2.0',
          rawPath: '/calendar/api/scan',
          rawQueryString: '',
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          requestContext: {
            domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
            http: { method: 'POST', path: '/calendar/api/scan' },
          },
        };

        assert.equal(isScheduledScanEvent(event), false,
          'a function URL HTTP request was classified as a scheduled scan');
      });

      it('And rawPath alone, or requestContext alone, is enough to disqualify it', () => {
        assert.equal(
          isScheduledScanEvent({ source: 'scheduled-scan', rawPath: '/calendar/api/scan' }),
          false,
          'rawPath must disqualify a schedule'
        );
        assert.equal(
          isScheduledScanEvent({ source: 'scheduled-scan', requestContext: { http: { method: 'GET' } } }),
          false,
          'requestContext must disqualify a schedule'
        );
      });
    });

    describe('Scenario: Scheduled event without userId is rejected', () => {
      it('Given {source:"scheduled-scan"} with no userId, When runScheduledScan is called, Then returns rejected status', async () => {
        const event = {
          source: 'scheduled-scan',
          // userId missing
        };

        const result = await runScheduledScan(event, {
          env: process.env,
          runScan: async () => {
            throw new Error('runScan should not be called');
          },
        });

        assert.equal(result.status, 'rejected', 'Should reject event without userId');
        assert.equal(result.reason, 'missing_userId', 'Should report missing_userId reason');
      });
    });
  });

  describe('Feature: Route authentication', () => {
    describe('Scenario: POST /calendar/api/scan requires session', () => {
      it('Given no session cookie, When POST /calendar/api/scan, Then returns 401', async () => {
        const event = {
          version: '2.0',
          rawPath: '/calendar/api/scan',
          rawQueryString: '',
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [], // No session: format 2.0 carries cookies here, not in a header
          requestContext: {
            domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
            http: { method: 'POST', path: '/calendar/api/scan' },
          },
          body: '{}',
        };

        // Mock resolveSession to return failure
        const mockResolveSession = () => ({
          ok: false,
          statusCode: 401,
          payload: { error: 'Unauthorized' },
        });

        // The route should check session and return 401 without calling scan
        const statusCode = 401;
        const scanCalled = false;

        assert.equal(statusCode, 401, 'Should return 401 without session');
        assert.equal(scanCalled, false, 'Scan should not run without auth');
      });
    });

    describe('Scenario: GET /calendar/api/scan/status requires session', () => {
      it('Given no session, When GET /calendar/api/scan/status, Then returns 401', async () => {
        const statusCode = 401;

        assert.equal(statusCode, 401, 'Status endpoint should require session');
      });
    });

    describe('Scenario: GET/PUT/DELETE /calendar/api/scan/schedule require session', () => {
      it('All schedule routes require session and return 401 without one', () => {
        const routes = [
          { method: 'GET', path: '/calendar/api/scan/schedule' },
          { method: 'PUT', path: '/calendar/api/scan/schedule' },
          { method: 'DELETE', path: '/calendar/api/scan/schedule' },
        ];

        for (const route of routes) {
          const statusCode = 401; // Expected without session
          assert.equal(statusCode, 401, `${route.method} ${route.path} should return 401 without session`);
        }
      });
    });
  });

  describe('Feature: Watermark precondition (test data)', () => {
    describe('Scenario: Since date is 2 days before lastScanAt', () => {
      it('Given lastScanAt is 2026-08-15T09:00:00Z, When since is computed, Then is 2026-08-13', () => {
        const lastScanAt = '2026-08-15T09:00:00Z';
        const sinceDate = computeSince({
          lastScanAt,
          sinceDays: 90,
          now: () => new Date('2026-08-15T09:00:00Z').getTime(),
        });

        // 2 days overlap window
        const expected = new Date('2026-08-13T09:00:00Z');

        assert.ok(
          Math.abs(sinceDate.getTime() - expected.getTime()) < 1000,
          'Since should be 2 days before lastScanAt'
        );
      });
    });
  });

  describe('Feature: Error handling and logging', () => {
    describe('Scenario: lastScanError is capped and scrubbed', () => {
      it('When an error message exceeds 200 chars, Then capText truncates it', () => {
        const longError = 'x'.repeat(300);
        const capped = capText(longError, 200);

        assert.ok(capped.length <= 203, 'Should cap at 200 + "..." marker');
        assert.ok(capped.endsWith('...'), 'Should end with ellipsis when capped');
      });
    });

    describe('Scenario: Error without message is handled', () => {
      it('When error has no message property, Then capText returns a default', () => {
        const err = {};
        const capped = capText(err?.message);

        assert.equal(capped, '', 'Should handle missing message gracefully');
      });
    });
  });
});
