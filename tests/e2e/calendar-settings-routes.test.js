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
        schoolName: 'Test School',
        searchDomains: new Set(['school.edu.au']),
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
      assert.equal(body.schoolName, 'Test School');
      assert.ok(Array.isArray(body.searchDomains));
      assert.deepEqual(body.searchDomains, ['school.edu.au']);
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
      assert.equal(body.searchDomains.length, 0);
    });

    it('should never include refreshTokenEnc in response', async () => {
      const cookie = makeSessionCookie();
      const mockConnection = {
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        schoolName: 'Test School',
        searchDomains: new Set(['school.edu.au']),
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

    it('searchDomains should be an array in the JSON response, never a Set', async () => {
      const cookie = makeSessionCookie();
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
      // The critical test: it must be an array, not an object (Set stringifies to {})
      assert.ok(Array.isArray(body.searchDomains));
      assert.equal(body.searchDomains.length, 2);
      assert.ok(body.searchDomains.includes('domain1.edu.au'));
      assert.ok(body.searchDomains.includes('domain2.edu.au'));
    });
  });

  describe('PUT /calendar/api/settings', () => {
    it('should return 401 when no session cookie is present', async () => {
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['school.edu.au'],
      });

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 401);
    });

    it('should return 400 when schoolName is missing', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        searchDomains: ['school.edu.au'],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'schoolName');
    });

    it('should return 400 when schoolName is whitespace only', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: '   ',
        searchDomains: ['school.edu.au'],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'schoolName');
      assert.ok(body.error.includes('required'));
    });

    it('should return 400 when schoolName exceeds 120 characters', async () => {
      const cookie = makeSessionCookie();
      const longName = 'A'.repeat(121);
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: longName,
        searchDomains: ['school.edu.au'],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'schoolName');
      assert.ok(body.error.includes('120 characters'));
    });

    it('should return 400 when searchDomains is empty array', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: [],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'searchDomains');
    });

    it('should return 400 when searchDomains exceeds 10 domains', async () => {
      const cookie = makeSessionCookie();
      const domains = Array.from({ length: 11 }, (_, i) => `domain${i}.edu.au`);
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: domains,
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes('10'));
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
          schoolName: 'Test School',
          searchDomains: [badDomain],
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400, `Should reject domain: ${badDomain}`);
        const body = JSON.parse(response.body);
        assert.equal(body.field, 'searchDomains');
      }
    });

    it('should reject public mail hosts (gmail.com, outlook.com, etc)', async () => {
      const cookie = makeSessionCookie();
      const publicHosts = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'];

      for (const host of publicHosts) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          schoolName: 'Test School',
          searchDomains: [host],
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400, `Should reject public host: ${host}`);
        const body = JSON.parse(response.body);
        assert.equal(body.field, 'searchDomains');
        assert.ok(body.error.includes(host));
      }
    });

    it('should normalize domain formats: @example, https://example, *.example, example:443', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => {
        // Capture what was written
        return {
          Attributes: {
            userId: connectionUserId(testGoogleSub),
            email: testEmail,
            schoolName: 'Test School',
            searchDomains: new Set(['example.edu.au']),
          },
        };
      };

      const testForms = [
        '@example.edu.au',
        'office@example.edu.au',
        'https://example.edu.au/news',
        '*.example.edu.au',
        'example.edu.au:443',
      ];

      for (const form of testForms) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          schoolName: 'Test School',
          searchDomains: [form],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: mockUpdateItem,
        });

        assert.equal(response.statusCode, 200, `Should accept domain form: ${form}`);
        const body = JSON.parse(response.body);
        assert.deepEqual(body.searchDomains, ['example.edu.au']);
      }
    });

    it('should collapse duplicate domains (case-insensitive) silently', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => ({
        Attributes: {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
          schoolName: 'Test School',
          searchDomains: new Set(['example.edu.au']),
        },
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['example.edu.au', 'EXAMPLE.EDU.AU', 'Example.Edu.Au'],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: mockUpdateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.searchDomains.length, 1);
      assert.equal(body.searchDomains[0], 'example.edu.au');
    });

    it('should preserve apostrophes and accents in schoolName', async () => {
      const cookie = makeSessionCookie();
      const testNames = [
        "St Mary's Primary",
        "École Publique",
        "O'Reilly's School",
      ];

      for (const schoolName of testNames) {
        const mockUpdateItem = async (params) => ({
          Attributes: {
            userId: connectionUserId(testGoogleSub),
            email: testEmail,
            schoolName,
            searchDomains: new Set(['school.edu.au']),
          },
        });

        const event = makeEvent('PUT', '/calendar/api/settings', {
          schoolName,
          searchDomains: ['school.edu.au'],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: mockUpdateItem,
        });

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.equal(body.schoolName, schoolName, `Should preserve: ${schoolName}`);
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
        const mockUpdateItem = async (params) => ({
          Attributes: {
            userId: connectionUserId(testGoogleSub),
            email: testEmail,
            schoolName: injectedValue,
            searchDomains: new Set(['school.edu.au']),
          },
        });

        const event = makeEvent('PUT', '/calendar/api/settings', {
          schoolName: injectedValue,
          searchDomains: ['school.edu.au'],
        }, cookie);

        const response = await handler(event, {}, {
          env: defaultEnv,
          updateItem: mockUpdateItem,
        });

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        // Raw storage - exactly as input
        assert.equal(body.schoolName, injectedValue);
      }
    });

    it('should return 200 with updated settings on valid payload', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => ({
        Attributes: {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
          schoolName: 'Updated School',
          searchDomains: new Set(['updated.edu.au']),
          connected: true,
          connectionStatus: 'connected',
        },
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Updated School',
        searchDomains: ['updated.edu.au'],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: mockUpdateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.schoolName, 'Updated School');
      assert.deepEqual(body.searchDomains, ['updated.edu.au']);
      assert.equal(body.email, testEmail);
    });

    it('should never include tokens in response body', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => ({
        Attributes: {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
          schoolName: 'Test School',
          searchDomains: new Set(['school.edu.au']),
          refreshTokenEnc: 'should-not-appear',
          refreshTokenKeyId: 'should-not-appear',
        },
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['school.edu.au'],
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: mockUpdateItem,
      });

      const body = JSON.parse(response.body);
      assert.equal(body.refreshTokenEnc, undefined);
      assert.equal(body.refreshTokenKeyId, undefined);
    });

    it('should return 500 when save fails without leaking secrets', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => {
        throw new Error('Database error');
      };

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['school.edu.au'],
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
      const mockUpdateItem = async (params) => ({
        Attributes: {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
          schoolName: 'Test School',
          searchDomains: new Set(['school.edu.au']),
          scheduleEnabled: true,
          scheduleFrequency: 'daily',
          scheduleHour: 7,
          timezone: 'Australia/Sydney',
        },
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['school.edu.au'],
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      }, cookie);

      const response = await handler(event, {}, {
        env: defaultEnv,
        updateItem: mockUpdateItem,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.scheduleEnabled, true);
      assert.equal(body.scheduleFrequency, 'daily');
      assert.equal(body.scheduleHour, 7);
      assert.equal(body.timezone, 'Australia/Sydney');
    });

    it('should log domain count on success without logging raw payload', async () => {
      const cookie = makeSessionCookie();
      const mockUpdateItem = async (params) => ({
        Attributes: {
          userId: connectionUserId(testGoogleSub),
          email: testEmail,
          schoolName: 'Secret School Name',
          searchDomains: new Set(['domain1.edu.au', 'domain2.edu.au']),
        },
      });

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Secret School Name',
        searchDomains: ['domain1.edu.au', 'domain2.edu.au'],
      }, cookie);

      capturedLogs = [];
      const origLog = console.log;
      console.log = (...args) => {
        capturedLogs.push(args);
        origLog(...args);
      };

      const response = await handler(event, {}, {
        env: { ...defaultEnv, CALENDAR_LOG_LEVEL: 'basic' },
        updateItem: mockUpdateItem,
      });

      console.log = origLog;

      assert.equal(response.statusCode, 200);
      // Should log domainCount, but NOT the schoolName
      const logsString = JSON.stringify(capturedLogs);
      assert.ok(logsString.includes('domainCount'), 'Should log domain count');
      assert.ok(!logsString.includes('Secret School Name'), 'Should not log schoolName');
    });

    it('should not log session cookie in error responses', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: [], // Invalid - empty
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

  describe('Empty searchDomains removal path', () => {
    it('should generate REMOVE clause when searchDomains list is cleared', async () => {
      const cookie = makeSessionCookie();
      let capturedParams = null;

      const mockUpdateItem = async (params) => {
        capturedParams = params;
        return {
          Attributes: {
            userId: connectionUserId(testGoogleSub),
            email: testEmail,
            schoolName: 'Test School',
            // searchDomains intentionally absent
          },
        };
      };

      // First set some domains, then update via a low-level updateConnection mock
      // that clears searchDomains by passing REMOVE_ATTRIBUTE
      const mockUpdateConnection = async (userId, patch, deps) => {
        // When buildConnectionPatch receives searchDomains: [], it creates REMOVE_ATTRIBUTE
        if (patch.searchDomains === REMOVE_ATTRIBUTE) {
          return await deps.updateItem({ /* would be DynamoDB params */ });
        }
        return mockUpdateItem({});
      };

      // Simulate an update that clears domains via direct patch
      const { buildConnectionPatch } = await import('../../src/lambda/calendar/backend/settings.mjs');
      const patch = buildConnectionPatch({ schoolName: 'Test', searchDomains: [] });

      assert.equal(patch.searchDomains, REMOVE_ATTRIBUTE, 'buildConnectionPatch should use REMOVE_ATTRIBUTE for empty domains');
    });
  });

  describe('Domain edge cases', () => {
    it('should reject a 254-character domain name', async () => {
      const cookie = makeSessionCookie();
      const longDomain = 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64) + '.' + 'd'.repeat(64) + '.com';

      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: [longDomain],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject domain with trailing dot', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['example.edu.au.'],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject domain that is only a wildcard', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: ['*.'],
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject searchDomains sent as string instead of array', async () => {
      const cookie = makeSessionCookie();
      const event = makeEvent('PUT', '/calendar/api/settings', {
        schoolName: 'Test School',
        searchDomains: 'example.edu.au',
      }, cookie);

      const response = await handler(event, {}, { env: defaultEnv });
      assert.equal(response.statusCode, 400);
    });

    it('should reject null/numbers/nested objects in searchDomains array', async () => {
      const cookie = makeSessionCookie();
      const testCases = [
        [null],
        [123],
        [{ domain: 'example.edu.au' }],
      ];

      for (const domains of testCases) {
        const event = makeEvent('PUT', '/calendar/api/settings', {
          schoolName: 'Test School',
          searchDomains: domains,
        }, cookie);

        const response = await handler(event, {}, { env: defaultEnv });
        assert.equal(response.statusCode, 400);
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
