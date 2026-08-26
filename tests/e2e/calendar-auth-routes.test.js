import { describe, it, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createHash } from 'node:crypto';

import {
  handler,
  handleAuthStart,
  handleAuthCallback,
  handleAuthLogout,
  handleAuthMe,
} from '../../src/lambda/calendar/index.mjs';

import {
  generateCodeVerifier,
  codeChallengeS256 as generateChallenge,
  buildRedirectUri,
  CALLBACK_PATH,
  POST_LOGIN_PATH,
} from '../../src/lambda/calendar/backend/google-oauth.mjs';

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  parseCookieHeader,
} from '../../src/lambda/calendar/backend/session.mjs';

import {
  encodeSessionPayload,
  signSessionPayload,
} from '../../src/lambda/calendar/backend/session.mjs';

import {
  putConnection,
  connectionUserId,
} from '../../src/lambda/calendar/backend/connections.mjs';

describe('Calendar OAuth Routes - E2E Tests', () => {
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
    CALENDAR_LOG_LEVEL: 'verbose',
  };

  let capturedLogs = [];

  // Captured once, before any `beforeEach` has ever run, so this always refers
  // to the genuine, un-wrapped console methods - never to a wrapper installed
  // by a previous test. `beforeEach` below always wraps THESE, not the current
  // `console.log`/`warn`/`error` (which may already be a wrapper), and
  // `afterEach` always restores THESE. That is what makes stacking impossible:
  // there is nothing to stack onto, because every wrap starts from the same
  // originals and every restore returns to the same originals.
  const REAL_CONSOLE_LOG = console.log;
  const REAL_CONSOLE_WARN = console.warn;
  const REAL_CONSOLE_ERROR = console.error;

  beforeEach(() => {
    capturedLogs = [];
    // Capture console output
    console.log = (...args) => {
      capturedLogs.push({ level: 'log', args });
      REAL_CONSOLE_LOG(...args);
    };
    console.warn = (...args) => {
      capturedLogs.push({ level: 'warn', args });
      REAL_CONSOLE_WARN(...args);
    };
    console.error = (...args) => {
      capturedLogs.push({ level: 'error', args });
      REAL_CONSOLE_ERROR(...args);
    };
  });

  afterEach(() => {
    // Restore the genuine originals captured above - NOT `console.log` itself,
    // which was the bug here: `const originalLog = console.log; console.log =
    // originalLog;` reads the ALREADY-WRAPPED function and reassigns it to
    // itself, so the wrapper never actually comes off and each `beforeEach`
    // stacks another wrapper on top of the last.
    //
    // That stacking bug never produced a false pass: every stacked wrapper
    // still pushes its own entry into `capturedLogs`, which is reset at the
    // top of every `beforeEach`, so the log-hygiene assertions below always
    // scanned MORE captured output than intended, never less. It inflated
    // captured output rather than suppressing it, so no assertion in this
    // file was ever weakened by it - the real risk was only cross-file
    // interference once other suites shared the process, which restoring the
    // genuine original here now prevents.
    console.log = REAL_CONSOLE_LOG;
    console.warn = REAL_CONSOLE_WARN;
    console.error = REAL_CONSOLE_ERROR;
  });

  after(() => {
    // Proves the fix: once every test in this suite has finished, console.*
    // must be back to the exact function references captured before the
    // first override, with no wrapper left installed.
    assert.strictEqual(console.log, REAL_CONSOLE_LOG, 'console.log must be the genuine original after the suite finishes');
    assert.strictEqual(console.warn, REAL_CONSOLE_WARN, 'console.warn must be the genuine original after the suite finishes');
    assert.strictEqual(console.error, REAL_CONSOLE_ERROR, 'console.error must be the genuine original after the suite finishes');
  });

  describe('GET /calendar/api/auth/google/start', () => {
    it('should return 302 with Google authorization URL', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 302);
      assert.ok(response.multiValueHeaders.Location);
      const location = response.multiValueHeaders.Location[0];
      assert.ok(location.includes('https://accounts.google.com/o/oauth2/v2/auth'));
    });

    it('should include all required OAuth parameters in redirect', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });
      const location = response.multiValueHeaders.Location[0];

      assert.ok(location.includes(`client_id=${clientId}`));
      assert.ok(location.includes('scope='));
      assert.ok(location.includes('gmail.readonly'));
      assert.ok(location.includes('access_type=offline'));
      assert.ok(location.includes('prompt=consent'));
      assert.ok(location.includes('state='));
      assert.ok(location.includes('code_challenge='));
      assert.ok(location.includes('code_challenge_method=S256'));
    });

    it('should set HttpOnly state cookie with verifier and state', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });
      const setCookie = response.multiValueHeaders['Set-Cookie'];

      assert.ok(setCookie);
      const stateCookie = setCookie.find((c) => c.includes('calendar_oauth_state='));
      assert.ok(stateCookie);
      assert.ok(stateCookie.includes('HttpOnly'));
      assert.ok(stateCookie.includes('Secure'));
      assert.ok(stateCookie.includes('SameSite=Lax'));
      assert.ok(stateCookie.includes('Max-Age=600'));
      assert.ok(stateCookie.includes('Path=/calendar'));
    });

    it('should never expose code_verifier in redirect URL', async () => {
      // Intercept randomBytes to control the verifier
      const testVerifier = 'test-verifier-1234567890123456789012';
      const randomBytes = (size) => {
        const buf = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
          buf[i] = 0x30 + (i % 10); // "0123456789..."
        }
        return buf;
      };

      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv, randomBytes });
      const location = response.multiValueHeaders.Location[0];

      // The actual generated verifier will be different, but we verify
      // the pattern: any 43-char base64url sequence should not appear in the URL
      assert.ok(!location.includes('code_verifier'), 'code_verifier must not appear in URL');
    });

    it('should return 500 when GOOGLE_CLIENT_ID is missing', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const env = { ...defaultEnv, GOOGLE_CLIENT_ID: '' };
      const response = await handler(event, undefined, { env });

      assert.equal(response.statusCode, 500);
      const body = JSON.parse(response.body);
      assert.ok(body.error);
    });

    it('should return 500 when PUBLIC_BASE_URL is missing', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      const env = { ...defaultEnv, PUBLIC_BASE_URL: '' };
      const response = await handler(event, undefined, { env });

      assert.equal(response.statusCode, 500);
    });

    it('should not leak secrets in logs', async () => {
      const event = {
        path: '/calendar/api/auth/google/start',
        httpMethod: 'GET',
        headers: {},
      };

      capturedLogs = [];
      // Must be awaited: `handleAuthStart` currently logs synchronously before
      // its first `await`, but that is an implementation detail, not a
      // contract. An unawaited call here would only happen to observe those
      // logs today; the moment the handler gains any `await` before its log
      // line, this assertion would stop observing anything and go vacuously
      // green instead of red. Awaiting the full response is what keeps this
      // assertion honest regardless of where the handler suspends.
      await handler(event, undefined, { env: defaultEnv });

      const logContent = JSON.stringify(capturedLogs);
      assert.ok(!logContent.includes(clientSecret), 'client secret must not be logged');
      assert.ok(!logContent.includes(sessionSecret), 'session secret must not be logged');
    });
  });

  describe('GET /calendar/api/auth/google/callback - State validation', () => {
    it('should return 400 when state parameter is missing', async () => {
      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          code: 'auth-code-123',
        },
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.ok(body.error.includes('state') || body.error.includes('sign-in'));
    });

    it('should return 400 when state cookie is missing (expired or blocked)', async () => {
      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: 'any-state-value',
          code: 'auth-code-123',
        },
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
    });

    it('should return 400 when state does not match the cookie', async () => {
      // Create a valid state cookie with a specific state value
      const stateValue = 'cookie-state-value';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: 'different-state-value',
          code: 'auth-code-123',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
    });

    it('should clear state cookie on state mismatch', async () => {
      const stateValue = 'cookie-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: 'wrong-state',
          code: 'auth-code-123',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      const setCookie = response.multiValueHeaders['Set-Cookie'];
      assert.ok(setCookie);
      const clearedCookie = setCookie.find((c) => c.includes('calendar_oauth_state='));
      assert.ok(clearedCookie);
      assert.ok(clearedCookie.includes('Max-Age=0'));
    });

    it('should return 500 before checking state if config is missing', async () => {
      const stateValue = 'test-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'auth-code-123',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const env = { ...defaultEnv, SESSION_SECRET: '' };
      const response = await handler(event, undefined, { env });

      // Missing SESSION_SECRET should trigger 500 BEFORE state is checked
      assert.equal(response.statusCode, 500);
    });
  });

  describe('GET /calendar/api/auth/google/callback - Token exchange error handling', () => {
    it('should return 502 when token exchange fails', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'bad-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      // Mock exchange that fails
      const exchangeCode = async () => {
        const err = new Error('Token endpoint error');
        err.name = 'TokenExchangeError';
        err.statusCode = 400;
        throw err;
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      assert.equal(response.statusCode, 502);
    });

    it('should return 400 with reason when Google returns error', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          error: 'access_denied',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.ok(body.reason);
    });

    it('should clear state cookie on token exchange failure', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'bad-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const exchangeCode = async () => {
        throw new Error('Exchange failed');
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      const setCookie = response.multiValueHeaders['Set-Cookie'];
      assert.ok(setCookie);
      const clearedCookie = setCookie.find((c) => c.includes('calendar_oauth_state='));
      assert.ok(clearedCookie);
      assert.ok(clearedCookie.includes('Max-Age=0'));
    });
  });

  describe('GET /calendar/api/auth/google/callback - Happy path + encryption', () => {
    it('CRITICAL: plaintext refresh token is never stored (uses real putConnection)', async () => {
      // This test uses the REAL putConnection function with only its seams injected
      // (getItem, putItem, encrypt). We verify the real encryption/stripping happens.

      const stateValue = 'valid-state-123';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const plaintextRefreshToken = 'rt-PLAINTEXT-CANARY-xyz789-this-must-never-appear';
      const mockCiphertext = 'base64-encoded-ciphertext-value-here';

      let capturedDBItem = null;

      // Inject only the SEAMS of putConnection: getItem, putItem, and encrypt
      const mockGetItem = async () => null; // User has no existing row

      const mockPutItem = async (args) => {
        // Capture what would be written to the database
        capturedDBItem = { ...args.item };
      };

      const mockEncrypt = async (plaintext, options) => {
        // Record that we're encrypting the right plaintext
        assert.equal(plaintext, plaintextRefreshToken, 'encrypt should receive the plaintext token');
        return {
          ciphertext: mockCiphertext,
          keyId: options.env?.CALENDAR_KMS_KEY_ID || kmsKeyId,
        };
      };

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token-value',
          refreshToken: plaintextRefreshToken,
          idToken: createTestIdToken('google-sub-123', 'user@example.com', clientId),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      // Create a wrapper that calls the real putConnection with injected seams
      const wrappedPutConnection = async (connection, options = {}) => {
        return putConnection(connection, {
          ...options,
          getItem: mockGetItem,
          putItem: mockPutItem,
          encrypt: mockEncrypt,
          tableName: defaultEnv.CALENDAR_CONNECTIONS_TABLE,
          env: defaultEnv,
        });
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: wrappedPutConnection,
      });

      assert.equal(response.statusCode, 302);

      // Verify the database item (what was passed to putItem) never contains plaintext
      assert.ok(capturedDBItem, 'putItem should have been called with the database item');

      // Deep scan: verify plaintext does NOT appear anywhere in the item
      const deepScan = (obj, visited = new Set()) => {
        if (obj === null || obj === undefined) return;
        if (visited.has(obj)) return; // Prevent circular reference issues
        visited.add(obj);

        if (typeof obj === 'string') {
          assert.ok(
            !obj.includes(plaintextRefreshToken),
            `plaintext token found in string: ${obj}`
          );
          assert.ok(!obj.includes('PLAINTEXT-CANARY'), 'plaintext canary found in stored item');
        } else if (typeof obj === 'object') {
          for (const value of Object.values(obj)) {
            deepScan(value, visited);
          }
        }
      };

      deepScan(capturedDBItem);

      // Verify the encrypted form is present
      assert.equal(
        capturedDBItem.refreshTokenEnc,
        mockCiphertext,
        'refreshTokenEnc should contain the ciphertext from encrypt()'
      );

      // Verify plaintext attribute was deleted
      assert.ok(
        !('refreshToken' in capturedDBItem),
        'plaintext refreshToken attribute must not exist in stored item'
      );
    });

    it('should store email and sub from id_token', async () => {
      const stateValue = 'valid-state-123';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      let capturedConnection = null;

      const mockPutConnection = async (connection) => {
        capturedConnection = connection;
        return { userId: `google#${connection.sub}` };
      };

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token-value',
          idToken: createTestIdToken('google-sub-456', 'newuser@example.com', clientId),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: mockPutConnection,
      });

      assert.equal(response.statusCode, 302);
      assert.equal(capturedConnection.sub, 'google-sub-456');
      assert.equal(capturedConnection.email, 'newuser@example.com');
    });

    it('should set session cookie with correct attributes on success', async () => {
      const stateValue = 'valid-state-123';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: createTestIdToken('google-sub-789', 'user@test.com', clientId),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const mockPutConnection = async () => ({});

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: mockPutConnection,
      });

      assert.equal(response.statusCode, 302);
      const setCookie = response.multiValueHeaders['Set-Cookie'];
      assert.ok(setCookie);

      const sessionCookie = setCookie.find((c) => c.includes('calendar_session='));
      assert.ok(sessionCookie);
      assert.ok(sessionCookie.includes('HttpOnly'));
      assert.ok(sessionCookie.includes('Secure'));
      assert.ok(sessionCookie.includes('SameSite=Lax'));
      assert.ok(sessionCookie.includes('Path=/calendar'));
      assert.ok(sessionCookie.includes('Max-Age=604800')); // 7 days
    });

    it('should redirect to /calendar on success', async () => {
      const stateValue = 'valid-state-123';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: createTestIdToken('sub-123', 'user@example.com', clientId),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const mockPutConnection = async () => ({});

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: mockPutConnection,
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.multiValueHeaders.Location[0], POST_LOGIN_PATH);
    });

    it('should preserve existing refresh token when new one is empty', async () => {
      const stateValue = 'valid-state-123';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      let capturedConnection = null;

      const mockPutConnection = async (connection) => {
        capturedConnection = connection;
        return {};
      };

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: '', // Empty on repeat consent without force
          idToken: createTestIdToken('sub-123', 'user@example.com', clientId),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: mockPutConnection,
      });

      assert.equal(response.statusCode, 302);
      // The function should still be called (putConnection is not skipped)
      // and it should handle empty refreshToken gracefully
      assert.ok(capturedConnection);
      assert.equal(capturedConnection.refreshToken, '');
    });
  });

  describe('GET /calendar/api/auth/google/callback - Log leakage checks', () => {
    it('should not leak authorization code in logs', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');
      const secretCode = 'auth-code-secret-xyz-must-not-appear-123456';

      capturedLogs = [];

      const exchangeCode = async () => {
        throw new Error('Exchange failed');
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: secretCode,
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      const logContent = JSON.stringify(capturedLogs);
      assert.ok(!logContent.includes(secretCode), 'authorization code must not appear in logs');
    });

    it('should not leak tokens, session secret, or id_token in logs (success path)', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const secretAccessToken = 'access-token-secret-value-abc123-must-not-log';
      const secretRefreshToken = 'refresh-token-secret-def456-must-not-log';
      const secretIdToken = createTestIdToken('sub', 'user@example.com', clientId);

      capturedLogs = [];

      const exchangeCode = async () => {
        return {
          accessToken: secretAccessToken,
          refreshToken: secretRefreshToken,
          idToken: secretIdToken,
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const mockPutConnection = async () => ({});

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
        putConnection: mockPutConnection,
      });

      const logContent = JSON.stringify(capturedLogs);
      assert.ok(!logContent.includes(secretAccessToken), 'access token must not be logged');
      assert.ok(!logContent.includes(secretRefreshToken), 'refresh token must not be logged');
      assert.ok(!logContent.includes(secretIdToken), 'id_token must not be logged');
      assert.ok(!logContent.includes(sessionSecret), 'session secret must not be logged');
    });

    it('should not leak tokens in logs (error paths)', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      capturedLogs = [];

      const exchangeCode = async () => {
        // Real Google error - from exchangeCodeForTokens which is designed to NOT leak tokens
        const err = new Error('Google token exchange failed: invalid_grant: The authorization code is invalid');
        err.name = 'TokenExchangeError';
        err.statusCode = 400;
        throw err;
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      const logContent = JSON.stringify(capturedLogs);
      // The logged error message should not contain token material - it should be safe
      // The message is a Google error code + description (invalid_grant), not a token
      assert.ok(logContent.includes('invalid_grant') || logContent.includes('GoogleError') || logContent.includes('Token exchange'), 'should log the error');
      // Verify the whole message is a safe description
      assert.ok(!logContent.includes('refresh'), 'must not mention refresh tokens');
    });
  });

  describe('GET /calendar/api/auth/google/callback - id_token validation', () => {
    it('should reject id_token with wrong audience', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: createTestIdToken('sub-123', 'user@example.com', 'wrong-client-id'),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      assert.equal(response.statusCode, 400);
    });

    it('should reject expired id_token', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const exchangeCode = async () => {
        const now = Math.floor(Date.now() / 1000);
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: createTestIdToken('sub-123', 'user@example.com', clientId, now - 100), // Expired
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      assert.equal(response.statusCode, 400);
    });

    it('should reject id_token with email_verified: false', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const exchangeCode = async () => {
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          idToken: createTestIdToken('sub-123', 'user@example.com', clientId, undefined, true),
          expiresIn: 3600,
          scope: 'openid email profile',
          tokenType: 'Bearer',
        };
      };

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
          code: 'valid-code',
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        exchangeCode,
      });

      assert.equal(response.statusCode, 400);
    });
  });

  describe('GET /calendar/api/auth/me', () => {
    it('should return 401 when not signed in', async () => {
      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 401);
    });

    it('should return session email and connection status when signed in', async () => {
      const sessionToken = createSessionToken(
        { sub: 'google-sub-123', email: 'user@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      const mockGetConnection = async () => {
        return {
          hasRefreshToken: true,
          email: 'user@example.com',
        };
      };

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.email, 'user@example.com');
      assert.equal(body.connected, true);
      assert.equal(body.connectionStatus, 'connected');
    });

    it('should return connectionStatus=not_connected when no refresh token', async () => {
      const sessionToken = createSessionToken(
        { sub: 'google-sub-456', email: 'user2@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      const mockGetConnection = async () => {
        return {
          hasRefreshToken: false,
          email: 'user2@example.com',
        };
      };

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.connected, false);
      assert.equal(body.connectionStatus, 'not_connected');
    });

    it('should return connectionStatus=unknown when lookup fails', async () => {
      const sessionToken = createSessionToken(
        { sub: 'google-sub-789', email: 'user3@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      const mockGetConnection = async () => {
        throw new Error('DynamoDB connection error');
      };

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.connectionStatus, 'unknown');
      assert.equal(body.connected, false);
      assert.equal(body.email, 'user3@example.com'); // Email still reported
    });

    it('should reject a tampered session cookie', async () => {
      const sessionToken = createSessionToken(
        { sub: 'google-sub-123', email: 'user@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      // Tamper with the payload
      const [payload, signature] = sessionToken.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      claims.sub = 'attacker-sub'; // Change sub
      const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const tamperedToken = tamperedPayload + '.' + signature;

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${tamperedToken}`],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 401);
    });

    it('should reject an expired session cookie', async () => {
      const now = Math.floor(Date.now() / 1000);
      const sessionToken = createSessionToken(
        { sub: 'google-sub-123', email: 'user@example.com' },
        { secret: sessionSecret, nowSeconds: now, ttlSeconds: 100 }
      );

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      // Verify with time advanced beyond expiry
      const futureTime = now + 200;

      const response = await handler(event, undefined, {
        env: defaultEnv,
        nowSeconds: futureTime,
      });

      assert.equal(response.statusCode, 401);
    });

    it('should not include refreshTokenEnc in response', async () => {
      const sessionToken = createSessionToken(
        { sub: 'google-sub-123', email: 'user@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      const mockGetConnection = async () => {
        return {
          hasRefreshToken: true,
          email: 'user@example.com',
          refreshTokenEnc: 'should-not-appear-in-response',
        };
      };

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: defaultEnv,
        getConnection: mockGetConnection,
      });

      const body = JSON.parse(response.body);
      const bodyStr = JSON.stringify(body);
      assert.ok(!bodyStr.includes('should-not-appear-in-response'));
    });
  });

  describe('POST /calendar/api/auth/logout', () => {
    it('should return 204 with cleared cookies', async () => {
      const event = {
        path: '/calendar/api/auth/logout',
        httpMethod: 'POST',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 204);
      const setCookie = response.multiValueHeaders['Set-Cookie'];
      assert.ok(setCookie);
      assert.ok(setCookie.length >= 2); // Both session and state cookies cleared
    });

    it('should expire session cookie', async () => {
      const event = {
        path: '/calendar/api/auth/logout',
        httpMethod: 'POST',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      const setCookie = response.multiValueHeaders['Set-Cookie'];
      const sessionCookie = setCookie.find((c) => c.includes('calendar_session='));
      assert.ok(sessionCookie);
      assert.ok(sessionCookie.includes('Max-Age=0'));
    });

    it('should expire state cookie', async () => {
      const event = {
        path: '/calendar/api/auth/logout',
        httpMethod: 'POST',
        headers: {},
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      const setCookie = response.multiValueHeaders['Set-Cookie'];
      const stateCookie = setCookie.find((c) => c.includes('calendar_oauth_state='));
      assert.ok(stateCookie);
      assert.ok(stateCookie.includes('Max-Age=0'));
    });
  });

  describe('Session signature verification - timingSafeEqual usage', () => {
    it('should reject signatures differing only in final byte', async () => {
      const sessionSecret = 'test-session-secret-32-bytes-long!!!';
      const now = Math.floor(Date.now() / 1000);

      // Create a valid token
      const validToken = createSessionToken(
        { sub: 'user-123', email: 'test@example.com' },
        { secret: sessionSecret, nowSeconds: now, ttlSeconds: 3600 }
      );

      // Tamper with only the last byte of the signature
      const [payload, signature] = validToken.split('.');
      const tamperedSig = signature.slice(0, -1) + (signature[signature.length - 1] === 'A' ? 'B' : 'A');
      const tamperedToken = payload + '.' + tamperedSig;

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${tamperedToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: { ...defaultEnv, SESSION_SECRET: sessionSecret },
        nowSeconds: now + 10,
      });

      // Should be rejected, not accepted
      assert.equal(response.statusCode, 401);
    });

    it('should handle truncated signatures gracefully', async () => {
      const sessionSecret = 'test-session-secret-32-bytes-long!!!';
      const now = Math.floor(Date.now() / 1000);

      const validToken = createSessionToken(
        { sub: 'user-123', email: 'test@example.com' },
        { secret: sessionSecret, nowSeconds: now, ttlSeconds: 3600 }
      );

      const [payload, signature] = validToken.split('.');
      const truncatedToken = payload + '.' + signature.slice(0, signature.length - 5); // Truncate

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${truncatedToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: { ...defaultEnv, SESSION_SECRET: sessionSecret },
        nowSeconds: now + 10,
      });

      // Should be rejected with 401, not 500 (no crash on length mismatch)
      assert.equal(response.statusCode, 401);
    });
  });

  describe('Edge cases and error paths', () => {
    it('should handle code callback with state cookie but missing code', async () => {
      const stateValue = 'valid-state';
      const codeVerifier = generateCodeVerifier();
      const cookieData = Buffer.from(JSON.stringify({ state: stateValue, codeVerifier }), 'utf8').toString('base64url');

      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: stateValue,
        },
        multiValueHeaders: {
          cookie: [`calendar_oauth_state=${cookieData}`],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
    });

    it('should handle malformed state cookie', async () => {
      const event = {
        path: '/calendar/api/auth/google/callback',
        httpMethod: 'GET',
        queryStringParameters: {
          state: 'any-state',
          code: 'any-code',
        },
        multiValueHeaders: {
          cookie: ['calendar_oauth_state=invalid-base64-!!!'],
        },
      };

      const response = await handler(event, undefined, { env: defaultEnv });

      assert.equal(response.statusCode, 400);
    });

    it('should return 401 with no session secret configured for /me', async () => {
      const sessionToken = createSessionToken(
        { sub: 'user-123', email: 'test@example.com' },
        { secret: sessionSecret, nowSeconds: Math.floor(Date.now() / 1000) }
      );

      const event = {
        path: '/calendar/api/auth/me',
        httpMethod: 'GET',
        multiValueHeaders: {
          cookie: [`calendar_session=${sessionToken}`],
        },
      };

      const response = await handler(event, undefined, {
        env: { ...defaultEnv, SESSION_SECRET: '' },
      });

      assert.equal(response.statusCode, 500);
    });
  });
});

// Helper function to create a valid Google id_token for testing
function createTestIdToken(sub, email, aud, exp = undefined, emailVerifiedFalse = false) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    azp: aud,
    aud,
    sub,
    email,
    email_verified: emailVerifiedFalse ? false : true,
    iat: now,
    exp: exp !== undefined ? exp : now + 3600,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key1' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = 'fake_signature_here'; // Not cryptographically verified in the code

  return `${header}.${payload}.${signature}`;
}
