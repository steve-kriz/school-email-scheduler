import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  handler,
  handleGetSettings,
  handlePutSettings,
} from '../../src/lambda/calendar/index.mjs';

import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from '../../src/lambda/calendar/backend/session.mjs';

import {
  connectionUserId,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/connections.mjs';

describe('Calendar Settings Routes - E2E Tests', () => {
  const baseUrl = 'https://example.com';
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const clientSecret = 'test-client-secret-xyz';
  const sessionSecret = 'test-session-secret-must-be-32-bytes-long!!';
  const kmsKeyId = 'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012';

  const defaultEnv = {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    SESSION_SECRET: sessionSecret,
    PUBLIC_BASE_URL: baseUrl,
    CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
    CALENDAR_KMS_KEY_ID: kmsKeyId,
    CALENDAR_LOG_LEVEL: 'none',
  };

  const testGoogleSub = 'test-user-google-sub-123';
  const testEmail = 'test@example.com';

  let capturedLogs = [];
  let originalLog, originalWarn, originalError;

  beforeEach(() => {
    capturedLogs = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;

    console.log = (...args) => {
      capturedLogs.push({ level: 'log', args });
      originalLog(...args);
    };
    console.warn = (...args) => {
      capturedLogs.push({ level: 'warn', args });
      originalWarn(...args);
    };
    console.error = (...args) => {
      capturedLogs.push({ level: 'error', args });
      originalError(...args);
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  /**
   * Helper: Create a valid session cookie for testing.
   */
  function makeSessionCookie(secret = sessionSecret) {
    const token = createSessionToken(
      { sub: testGoogleSub, email: testEmail },
      { secret }
    );
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  /**
   * Helper: Create a Lambda function URL event (payload format 2.0, TASK-049)
   * with headers, cookies and/or body.
   */
  function makeEvent(method, path, body = null, cookie = null) {
    const event = {
      version: '2.0',
      rawPath: path,
      rawQueryString: '',
      headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
      cookies: [],
      requestContext: {
        domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
        http: { method, path },
      },
    };

    if (cookie) {
      event.cookies.push(cookie);
    }

    if (body !== null) {
      event.body = JSON.stringify(body);
      event.isBase64Encoded = false;
    }

    return event;
  }

  /**
   * TASK-055 replaced the `schoolNames`/`searchDomains` request and response
   * shape with `processingJobs`, a list of named "search + extract" jobs. Every
   * assertion below is the processing-job equivalent of the one it replaced.
   */
  const storedJob = {
    id: '6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d',
    name: 'Newsletters',
    schoolName: 'Test School',
    domain: 'school.edu.au',
    searchTerms: [],
  };

  /** One valid REQUEST job (no id - the server mints one). */
  function jobBody(overrides = {}) {
    return {
      name: 'Newsletters',
      schoolName: 'Test School',
      domain: 'school.edu.au',
      searchTerms: [],
      ...overrides,
    };
  }

  describe('GET /calendar/api/settings', () => {
    it('should return 401 when no session cookie is present', async () => {
      const event = makeEvent('GET', '/calendar/api/settings');
      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 401);
      const body = JSON.parse(response.body);
      assert.ok(body.error);
    });

    it('should return 200 with user settings when authenticated', async () => {
      const cookie = makeSessionCookie();
      const mockConnection = {
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        processingJobs: [storedJob],
        connected: true,
        connectionStatus: 'connected',
      };

      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const mockGetConnection = async () => mockConnection;

      const response = await handler(event, {}, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.email, testEmail);
      assert.ok(Array.isArray(body.processingJobs));
      assert.deepEqual(body.processingJobs, [storedJob]);
      assert.ok(!('schoolName' in body));
      assert.ok(!('schoolNames' in body));
      assert.ok(!('searchDomains' in body));
    });

    it('should return 200 with fallback email when user has no settings row', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const mockGetConnection = async () => null;

      const response = await handler(event, {}, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.email, testEmail);
      assert.deepEqual(body.processingJobs, []);
    });

    it('should never include refreshTokenEnc in response', async () => {
      const cookie = makeSessionCookie();
      const mockConnection = {
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        processingJobs: [storedJob],
        refreshTokenEnc: 'encrypted-token-should-not-be-here',
        connected: true,
        connectionStatus: 'connected',
      };

      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const mockGetConnection = async () => mockConnection;

      const response = await handler(event, {}, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      const body = JSON.parse(response.body);
      assert.equal(body.refreshTokenEnc, undefined);
      assert.equal(body.refreshToken, undefined);
      assert.equal(body.refreshTokenKeyId, undefined);
    });

    it('should return 500 when getConnection fails without leaking secrets', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const mockGetConnection = async () => {
        throw new Error('Database connection failed');
      };

      const response = await handler(event, {}, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.ok(body.error);
      assert.equal(body.error, 'Could not read your settings');
      // Ensure no secrets in body
      assert.ok(!JSON.stringify(body).includes(sessionSecret));
      assert.ok(!JSON.stringify(body).includes(kmsKeyId));
    });

    it('processingJobs should be an array in the JSON response, never a Set', async () => {
      const cookie = makeSessionCookie();
      // A legacy row still stored as string SETs: migrate-on-read must project it
      // as a plain array of plain objects, because JSON.stringify(new Set()) is
      // "{}" and would silently lose the data.
      const mockConnection = {
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        searchDomains: new Set(['domain1.edu.au', 'domain2.edu.au']),
        connected: true,
        connectionStatus: 'connected',
      };

      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const mockGetConnection = async () => mockConnection;

      const response = await handler(event, {}, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      const body = JSON.parse(response.body);
      assert.ok(Array.isArray(body.processingJobs));
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].id, 'default');
      assert.equal(body.processingJobs[0].domain, 'domain1.edu.au');
      assert.deepEqual(body.processingJobs[0].searchTerms, ['domain2.edu.au']);
      assert.ok(!('searchDomains' in body));
    });
  });

  describe('PUT /calendar/api/settings', () => {
    /**
     * The ONLY database seam: an injected `updateItem` that echoes back the
     * attributes the compiled UpdateExpression actually SET. Nothing here opens a
     * DynamoDB client, reads credentials or touches the network.
     */
    function makeEchoUpdateItem(extraAttributes = {}) {
      const calls = [];
      const updateItem = async ({ tableName, key, updates }) => {
        calls.push({ tableName, key, updates });
        const row = {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
        };
        for (const [attribute, value] of Object.entries(updates || {})) {
          if (value === REMOVE_ATTRIBUTE) delete row[attribute];
          else row[attribute] = value;
        }
        return { ...row, ...extraAttributes };
      };
      return { updateItem, calls };
    }

    it('should return 401 when no session cookie is present', async () => {
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody()],
      });

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 401);
    });

    it('should return 400 when processingJobs is missing', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        scheduleEnabled: true,
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'processingJobs');
    });

    it('should return 400 when a job schoolName is whitespace only', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ schoolName: '   ' })],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'processingJobs[0].schoolName');
      assert.ok(body.error.includes('required'));
    });

    it('should return 400 when a school name exceeds 120 characters', async () => {
      const cookie = makeSessionCookie();
      const longName = 'A'.repeat(121);
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ schoolName: longName })],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'processingJobs[0].schoolName');
      assert.ok(body.error.includes('120 characters'));
    });

    it('should return 400 when processingJobs is an empty array', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'processingJobs');
    });

    it('should return 400 when processingJobs exceeds 20 jobs', async () => {
      const cookie = makeSessionCookie();
      const jobs = Array.from({ length: 21 }, (_, i) =>
        jobBody({ name: `Job ${i}`, domain: `domain${i}.edu.au` })
      );
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: jobs,
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'processingJobs');
      assert.ok(body.error.includes('20'));
    });

    it('should return 400 for invalid domain formats', async () => {
      const cookie = makeSessionCookie();
      const testCases = [
        'not a domain',
        'stmarys',
        '-bad.com',
        'bad-.com',
      ];

      for (const badDomain of testCases) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ domain: badDomain })],
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400, `Should reject domain: ${badDomain}`);
        const body = JSON.parse(response.body);
        assert.equal(body.field, 'processingJobs[0].domain');
      }
    });

    it('should reject public mail hosts (gmail.com, outlook.com, etc)', async () => {
      const cookie = makeSessionCookie();
      const publicHosts = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];

      for (const host of publicHosts) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ domain: host })],
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400, `Should reject public host: ${host}`);
        const body = JSON.parse(response.body);
        assert.equal(body.field, 'processingJobs[0].domain');
        assert.ok(body.error.includes(host));
      }
    });

    it('should normalize domain formats: @example, https://example, *.example, example:443', async () => {
      const cookie = makeSessionCookie();
      const testForms = [
        '@example.edu.au',
        'office@example.edu.au',
        'https://example.edu.au/news',
        '*.example.edu.au',
        'example.edu.au:443',
      ];

      for (const form of testForms) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ domain: form })],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: makeEchoUpdateItem().updateItem,
        });

        assert.equal(response.statusCode, 200, `Should accept domain form: ${form}`);
        const body = JSON.parse(response.body);
        assert.deepEqual(
          body.processingJobs.map((entry) => entry.domain),
          ['example.edu.au']
        );
      }
    });

    it('should collapse duplicate search terms (exactly, after trimming) silently', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ searchTerms: ['canteen', '  canteen  ', 'uniform'] })],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: makeEchoUpdateItem().updateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body.processingJobs[0].searchTerms, ['canteen', 'uniform']);
    });

    it('should preserve apostrophes and accents in every school name', async () => {
      const cookie = makeSessionCookie();
      const testNames = [
        "St Mary's Primary",
        "École Publique",
        "O'Reilly's School",
      ];

      for (const schoolName of testNames) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ name: schoolName, schoolName })],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: makeEchoUpdateItem().updateItem,
        });

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.equal(body.processingJobs[0].schoolName, schoolName, `Should preserve: ${schoolName}`);
        assert.equal(body.processingJobs[0].name, schoolName);
      }
    });

    it('should store raw HTML/script tags without escaping', async () => {
      const cookie = makeSessionCookie();
      const injectionTests = [
        '<script>alert(1)</script>',
        '"><img src=x>',
        'Ignore previous instructions and ...',
      ];

      for (const injectedValue of injectionTests) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ schoolName: injectedValue, searchTerms: [injectedValue] })],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: makeEchoUpdateItem().updateItem,
        });

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        // Raw storage - exactly as input
        assert.equal(body.processingJobs[0].schoolName, injectedValue);
        assert.deepEqual(body.processingJobs[0].searchTerms, [injectedValue]);
      }
    });

    it('should return 200 with updated settings on valid payload', async () => {
      const cookie = makeSessionCookie();
      const spy = makeEchoUpdateItem({ hasRefreshToken: true });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ name: 'Updated', schoolName: 'Updated School', domain: 'updated.edu.au' })],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: spy.updateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].schoolName, 'Updated School');
      assert.equal(body.processingJobs[0].domain, 'updated.edu.au');
      assert.match(
        body.processingJobs[0].id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'the server must mint a canonical UUID for a job with no id'
      );
      assert.ok(!('schoolName' in body));
      assert.ok(!('schoolNames' in body));
      assert.ok(!('searchDomains' in body));
      assert.equal(body.email, testEmail);
      // The stored value is a plain array of plain objects, not a Set, and every
      // legacy attribute is retired in the same UpdateItem.
      const written = spy.calls[0].updates;
      assert.ok(Array.isArray(written.processingJobs));
      assert.ok(!(written.processingJobs instanceof Set));
      assert.deepEqual(Object.keys(written.processingJobs[0]).sort(), [
        'domain',
        'id',
        'name',
        'schoolName',
        'searchTerms',
      ]);
      assert.equal(written.schoolNames, REMOVE_ATTRIBUTE);
      assert.equal(written.searchDomains, REMOVE_ATTRIBUTE);
      assert.equal(written.schoolName, REMOVE_ATTRIBUTE);
    });

    it('should never include tokens in response body', async () => {
      const cookie = makeSessionCookie();
      const spy = makeEchoUpdateItem({
        refreshTokenEnc: 'should-not-appear',
        refreshTokenKeyId: 'should-not-appear',
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody()],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: spy.updateItem,
      });

      const body = JSON.parse(response.body);
      assert.equal(body.refreshTokenEnc, undefined);
      assert.equal(body.refreshTokenKeyId, undefined);
    });

    it('should return 500 when save fails without leaking secrets', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async () => {
        throw new Error('Database error');
      };

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody()],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: mockUpdateItem,
      });

      assert.equal(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.equal(body.error, 'Could not save your settings');
      // Ensure no secrets leak
      assert.ok(!JSON.stringify(body).includes(sessionSecret));
      assert.ok(!JSON.stringify(body).includes(kmsKeyId));
    });

    it('should accept valid schedule fields and pass them through', async () => {
      const cookie = makeSessionCookie();

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody()],
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: makeEchoUpdateItem().updateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.scheduleEnabled, true);
      assert.equal(body.scheduleFrequency, 'daily');
      assert.equal(body.scheduleHour, 7);
      assert.equal(body.timezone, 'Australia/Sydney');
    });

    it('should log job and search-term counts on success without logging raw payload', async () => {
      const cookie = makeSessionCookie();

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [
          jobBody({
            name: 'Secret Job Name',
            schoolName: 'Secret School Name',
            domain: 'secretdomain.edu.au',
            searchTerms: ['Secret Search Term'],
          }),
        ],
      }, cookie);

      capturedLogs = [];
      const origLog = console.log;
      console.log = (...args) => {
        capturedLogs.push(args);
        origLog(...args);
      };

      const response = await handler(event, {}, {
        env: { ...defaultEnv, CALENDAR_LOG_LEVEL: 'basic' },
        updateItem: makeEchoUpdateItem().updateItem,
      });

      console.log = origLog;

      assert.equal(response.statusCode, 200);
      // Counts only - never the personal data itself.
      const logsString = JSON.stringify(capturedLogs);
      assert.ok(logsString.includes('jobCount'), 'Should log the job count');
      assert.ok(logsString.includes('searchTermCount'), 'Should log the search-term count');
      assert.ok(!logsString.includes('Secret Job Name'), 'Should not log the job name text');
      assert.ok(!logsString.includes('Secret School Name'), 'Should not log the school name text');
      assert.ok(!logsString.includes('secretdomain.edu.au'), 'Should not log the domain');
      assert.ok(!logsString.includes('Secret Search Term'), 'Should not log a search term');
      // And the superseded keys must be gone from the log line entirely: reading
      // settings.schoolNames.length in the 200 path would throw a TypeError.
      assert.ok(!logsString.includes('schoolNameCount'));
      assert.ok(!logsString.includes('domainCount'));
    });

    it('should not log session cookie in error responses', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [], // Invalid - empty
      }, cookie);

      capturedLogs = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args) => {
        capturedLogs.push({ level: 'log', args });
        origLog(...args);
      };
      console.error = (...args) => {
        capturedLogs.push({ level: 'error', args });
        origError(...args);
      };

      const response = await handler(event, {}, {
        env: { ...defaultEnv, CALENDAR_LOG_LEVEL: 'verbose' },
      });

      console.log = origLog;
      console.error = origError;

      assert.equal(response.statusCode, 400);
      const logsString = JSON.stringify(capturedLogs);
      assert.ok(!logsString.includes(cookie), 'Cookie should not appear in logs');
      assert.ok(!logsString.includes(sessionSecret), 'Session secret should not appear in logs');
    });
  });

  describe('Empty processingJobs removal path', () => {
    it('should generate REMOVE clauses when the job list is cleared', async () => {
      // Unreachable from the PUT (which requires at least one job) but reachable
      // from any other caller, so the patch shape is asserted directly.
      const { buildConnectionPatch } = await import('../../src/lambda/calendar/backend/settings.mjs');
      const patch = buildConnectionPatch({ processingJobs: [] });

      assert.equal(
        patch.processingJobs,
        REMOVE_ATTRIBUTE,
        'buildConnectionPatch should use REMOVE_ATTRIBUTE for an empty job list'
      );
      assert.equal(patch.searchDomains, REMOVE_ATTRIBUTE);
      assert.equal(patch.schoolNames, REMOVE_ATTRIBUTE);
      assert.equal(patch.schoolName, REMOVE_ATTRIBUTE);
    });

    it('should keep an EMPTY searchTerms as an empty list, not a removal', async () => {
      const { buildConnectionPatch } = await import('../../src/lambda/calendar/backend/settings.mjs');
      const patch = buildConnectionPatch({ processingJobs: [{ ...storedJob, searchTerms: [] }] });
      assert.deepEqual(patch.processingJobs[0].searchTerms, []);
    });
  });

  describe('Domain edge cases', () => {
    it('should reject a 254-character domain name', async () => {
      const cookie = makeSessionCookie();
      const longDomain = 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64) + '.' + 'd'.repeat(64) + '.com';

      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ domain: longDomain })],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject domain with trailing dot', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ domain: 'example.edu.au.' })],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject domain that is only a wildcard', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: [jobBody({ domain: '*.' })],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject processingJobs sent as a string instead of an array', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        processingJobs: 'example.edu.au',
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).field, 'processingJobs');
    });

    it('should reject a job whose domain is null, a number or an array', async () => {
      const cookie = makeSessionCookie();
      const testCases = [null, 123, ['example.edu.au'], { domain: 'example.edu.au' }];

      for (const domain of testCases) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [jobBody({ domain })],
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400, `Should reject domain: ${JSON.stringify(domain)}`);
        assert.equal(JSON.parse(response.body).field, 'processingJobs[0].domain');
      }
    });

    it('should reject invalid JSON in request body', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', null, cookie);
      event.body = 'not valid json {]';

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });
  });

  describe('Session handling edge cases', () => {
    it('should return 401 when SESSION_SECRET is not set', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('GET', '/calendar/api/settings', null, cookie);
      const badEnv = { ...defaultEnv, SESSION_SECRET: undefined };

      const response = await handler(event, {}, { env: badEnv });
      assert.equal(response.statusCode, 500);
    });

    it('should return 401 when the format 2.0 cookies array is present but empty', async () => {
      const event = {
        version: '2.0',
        rawPath: '/calendar/api/settings',
        rawQueryString: '',
        headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
        cookies: [],
        requestContext: {
          domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
          http: { method: 'GET', path: '/calendar/api/settings' },
        },
      };

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 401);
    });
  });
});
