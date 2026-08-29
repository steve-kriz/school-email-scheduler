/**
 * calendar-function-url.test.js — TASK-049 end-to-end (Gherkin) scenarios.
 *
 * The calendar app moved off the shared ALB and onto its own Lambda function
 * URL. That is not just a networking change: the EVENT the handler receives and
 * the RESPONSE it must return both changed shape, and every difference fails
 * SILENTLY if it is wrong.
 *
 *   - Requests arrive as payload format 2.0: `rawPath` instead of `path`,
 *     `requestContext.http.method` instead of `httpMethod`, cookies in a
 *     top-level `cookies` ARRAY instead of in the header map, and
 *     `queryStringParameters` values already percent-DECODED.
 *   - Responses must carry `statusCode`, a SINGLE-VALUE `headers` map and a
 *     `cookies` array. A function URL IGNORES `multiValueHeaders` and
 *     `statusDescription` without complaint, so a response left in the old ALB
 *     shape goes out as a bare 200 with no Content-Type and no Set-Cookie —
 *     sign-in loops forever and nothing appears in the logs.
 *
 * Every scenario below is one Gherkin scenario from the ticket, driven through
 * the REAL exported `handler`.
 *
 * NO DATABASE CONNECTION IS OPENED ANYWHERE IN THIS FILE. `putConnection`,
 * `getConnection`, `exchangeCode` and `runScan` are all injected fakes, and the
 * assertions check what those fakes were handed. Nothing here constructs a
 * DynamoDB or KMS client.
 *
 * A NOTE ON `env`. The handler resolves the request's origin and passes it to
 * the routes as `PUBLIC_BASE_URL` on an env object built from `process.env` —
 * but an injected `deps.env` REPLACES that object wholesale. So the scenarios
 * that exercise the per-request derivation deliberately do NOT inject `env`;
 * they set `process.env` (with `PUBLIC_BASE_URL` empty, exactly as deployed) and
 * restore it afterwards. Injecting `env` is used only where the point is that an
 * explicit configuration overrides the derivation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import { handler, resolvePublicBaseUrl } from '../../src/lambda/calendar/index.mjs';
import {
  generateCodeVerifier,
  CALLBACK_PATH,
  POST_LOGIN_PATH,
  OAUTH_STATE_COOKIE_NAME,
} from '../../src/lambda/calendar/backend/google-oauth.mjs';
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from '../../src/lambda/calendar/backend/session.mjs';
import { SCAN_SCHEDULED_SOURCE } from '../../src/lambda/calendar/backend/scan-schedule.mjs';

/* =========================================================================
 * World
 * ========================================================================= */

const FN_HOST = 'k7q2xexample.lambda-url.ap-southeast-2.on.aws';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const SESSION_SECRET = 'test-session-secret-must-be-32-bytes-long!!';

/**
 * The deployed environment. PUBLIC_BASE_URL is EMPTY on purpose: Terraform
 * cannot put the function URL's generated id into the function's own
 * environment (the URL depends on the function, so that would be a dependency
 * cycle), so the origin has to be derived per request.
 */
const DEPLOYED_ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
  SESSION_SECRET,
  PUBLIC_BASE_URL: '',
  CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
  CALENDAR_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789:key/1234-5678',
  CALENDAR_LOG_LEVEL: 'none',
};

/**
 * GIVEN a browser request on the function URL: an event in payload format 2.0.
 *
 * Note what is deliberately ABSENT: no `path`, no `httpMethod`, no
 * `multiValueHeaders`, no `multiValueQueryStringParameters`. A function URL
 * sends none of them, so a fixture that included them would let a handler still
 * reading the old fields pass a test it should fail.
 */
function givenAFunctionUrlRequest({
  path,
  method = 'GET',
  cookies = [],
  query = null,
  headers = {},
  body = null,
} = {}) {
  const rawQueryString = query
    ? Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString,
    headers: { host: FN_HOST, ...headers },
    cookies,
    queryStringParameters: query || undefined,
    requestContext: {
      domainName: FN_HOST,
      http: { method, path, sourceIp: '203.0.113.10' },
    },
    body,
    isBase64Encoded: false,
  };
}

/** A signed session cookie for `sub`, in the form the `cookies` array carries. */
function sessionCookieFor(sub, email = `${sub}@example.test`) {
  const token = createSessionToken(
    { sub, email },
    { secret: SESSION_SECRET, nowSeconds: Math.floor(Date.now() / 1000) }
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** An unsigned id_token; the handler decodes claims and does not verify RS256. */
function idTokenFor(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key1' }), 'utf8').toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      azp: CLIENT_ID,
      aud: CLIENT_ID,
      sub,
      email,
      email_verified: true,
      iat: now,
      exp: now + 3600,
    }),
    'utf8'
  ).toString('base64url');
  return `${header}.${payload}.fake_signature`;
}

/** The state cookie the start route sets, rebuilt for a callback fixture. */
function stateCookieFor(state, codeVerifier) {
  const value = Buffer.from(JSON.stringify({ state, codeVerifier }), 'utf8').toString('base64url');
  return `${OAUTH_STATE_COOKIE_NAME}=${value}`;
}

/**
 * Run `fn` with `process.env` looking like a deployed environment, so the
 * handler's per-request `PUBLIC_BASE_URL` derivation is the thing under test
 * rather than an injected `env` object. Restores every key it touched.
 */
async function withDeployedProcessEnv(fn, overrides = {}) {
  const applied = { ...DEPLOYED_ENV, ...overrides };
  const saved = new Map();
  for (const [key, value] of Object.entries(applied)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A successful token exchange, with the id_token claims the callback needs. */
function successfulExchange(sub, email, onCode = () => {}) {
  return async ({ code }) => {
    onCode(code);
    return {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      idToken: idTokenFor(sub, email),
      expiresIn: 3600,
      scope: 'openid email profile',
      tokenType: 'Bearer',
    };
  };
}

let originalLog;
let originalWarn;
let originalError;

beforeEach(() => {
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

/* =========================================================================
 * Feature
 * ========================================================================= */

describe('Feature: Calendar app reachable from a Lambda function URL (TASK-049)', () => {
  describe('Scenario: The function URL serves the calendar app', () => {
    it('Given the calendar Lambda has a function URL, When a browser requests "/calendar/api/health" on that URL, Then the response status is 200 And the body reports service "school-calendar"', async () => {
      const response = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/health' }),
        {},
        { env: DEPLOYED_ENV }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).service, 'school-calendar');
      // The shape a function URL can actually read.
      assert.equal(response.headers['Content-Type'], 'application/json');
      assert.equal(response.multiValueHeaders, undefined,
        'multiValueHeaders is ignored by a function URL and must not be emitted');
      assert.equal(response.statusDescription, undefined,
        'statusDescription is ignored by a function URL and must not be emitted');
    });
  });

  describe('Scenario: Payload format 2.0 routing', () => {
    it('Given an event with rawPath "/calendar/api/auth/me" and requestContext.http.method "GET", When the handler processes it, Then it routes to the auth "me" handler And it does not fall through to the 404 branch', async () => {
      let getConnectionCalls = 0;
      const response = await handler(
        givenAFunctionUrlRequest({
          path: '/calendar/api/auth/me',
          cookies: [sessionCookieFor('google-sub-1', 'me@example.com')],
        }),
        {},
        {
          env: DEPLOYED_ENV,
          // Mocked storage: no DynamoDB client is ever constructed.
          getConnection: async () => {
            getConnectionCalls += 1;
            return null;
          },
        }
      );

      assert.equal(getConnectionCalls, 1, 'the auth "me" handler was never reached');
      assert.notEqual(response.statusCode, 404, 'the request fell through to the 404 branch');
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).email, 'me@example.com');
    });

    it('FAILURE PATH: Given a format 2.0 event whose rawPath is not a route, Then it 404s and never reaches the connections layer', async () => {
      // Proves the assertion above is load-bearing: routing comes from rawPath,
      // so an unrouted path cannot reach a handler through some other field.
      let getConnectionCalls = 0;
      const response = await handler(
        givenAFunctionUrlRequest({
          path: '/calendar/api/definitely-not-a-route',
          cookies: [sessionCookieFor('google-sub-1')],
        }),
        {},
        {
          env: DEPLOYED_ENV,
          getConnection: async () => {
            getConnectionCalls += 1;
            return null;
          },
        }
      );

      assert.equal(getConnectionCalls, 0, 'an unrouted path still reached the connections layer');
      assert.equal(response.statusCode, 404);
    });

    it('And the method comes from requestContext.http.method, so a POST-only route rejects a GET', async () => {
      const response = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/auth/disconnect', method: 'GET' }),
        {},
        { env: DEPLOYED_ENV, getConnection: async () => null }
      );
      // Not a 200: the disconnect route is POST-only, so a GET must not perform it.
      assert.notEqual(response.statusCode, 200);
    });
  });

  describe('Scenario: Multiple Set-Cookie headers survive the format change', () => {
    it('Given a sign-in response that sets more than one cookie, When the handler returns it through the function URL, Then every cookie is delivered in the "cookies" array And none of them is dropped because it was placed in "multiValueHeaders"', async () => {
      const state = 'state-value-abc';
      const codeVerifier = generateCodeVerifier();
      let storedConnection = null;

      const response = await withDeployedProcessEnv(() =>
        handler(
          givenAFunctionUrlRequest({
            path: CALLBACK_PATH,
            query: { state, code: 'valid-code' },
            cookies: [stateCookieFor(state, codeVerifier)],
          }),
          {},
          {
            exchangeCode: successfulExchange('google-sub-1', 'user@example.com'),
            // Mocked persistence: nothing touches DynamoDB or KMS.
            putConnection: async (connection) => {
              storedConnection = connection;
              return {};
            },
          }
        )
      );

      assert.equal(response.statusCode, 302);
      assert.ok(storedConnection, 'the connection was never stored');

      // The response sets TWO cookies: the new session, and the cleared OAuth
      // state cookie. Both must survive.
      assert.ok(Array.isArray(response.cookies), 'cookies must be an array');
      assert.equal(response.cookies.length, 2,
        `expected 2 cookies, got ${response.cookies.length}: ${JSON.stringify(response.cookies)}`);

      const session = response.cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      const clearedState = response.cookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
      assert.ok(session, `session cookie missing from ${JSON.stringify(response.cookies)}`);
      assert.ok(clearedState, `cleared state cookie missing from ${JSON.stringify(response.cookies)}`);

      // Nothing was left behind in the header map, and nothing was folded onto
      // one comma-joined line (which would produce one corrupt cookie, not two).
      assert.equal(response.multiValueHeaders, undefined);
      for (const name of Object.keys(response.headers)) {
        assert.notEqual(name.toLowerCase(), 'set-cookie',
          'Set-Cookie was left in the headers map, where a second value cannot be represented');
      }
    });

    it('And a response that sets no cookie still carries an empty array, never undefined', async () => {
      const response = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/health' }),
        {},
        { env: DEPLOYED_ENV }
      );
      assert.deepEqual(response.cookies, []);
    });
  });

  describe('Scenario: Session cookie attributes are unchanged', () => {
    it('Given a successful Google OAuth callback, When the session cookie is issued, Then it carries HttpOnly, Secure and SameSite=Lax', async () => {
      const state = 'state-value-def';
      const codeVerifier = generateCodeVerifier();

      const response = await withDeployedProcessEnv(() =>
        handler(
          givenAFunctionUrlRequest({
            path: CALLBACK_PATH,
            query: { state, code: 'valid-code' },
            cookies: [stateCookieFor(state, codeVerifier)],
          }),
          {},
          {
            exchangeCode: successfulExchange('google-sub-2', 'user2@example.com'),
            putConnection: async () => ({}),
          }
        )
      );

      const session = response.cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      assert.ok(session, 'no session cookie was issued');
      assert.match(session, /HttpOnly/, session);
      assert.match(session, /Secure/, session);
      assert.match(session, /SameSite=Lax/, session);
      assert.match(session, /Path=\/calendar/, session);
      assert.equal(response.headers.Location, POST_LOGIN_PATH);
    });

    it('And a subsequent authenticated request is accepted on the new origin', async () => {
      const state = 'state-value-ghi';
      const codeVerifier = generateCodeVerifier();

      const callback = await withDeployedProcessEnv(() =>
        handler(
          givenAFunctionUrlRequest({
            path: CALLBACK_PATH,
            query: { state, code: 'valid-code' },
            cookies: [stateCookieFor(state, codeVerifier)],
          }),
          {},
          {
            exchangeCode: successfulExchange('google-sub-3', 'user3@example.com'),
            putConnection: async () => ({}),
          }
        )
      );

      // Take the cookie the browser was given and send it back the way a
      // function URL delivers cookies: in the `cookies` array, NOT in a Cookie
      // header. Reading only the header would make every request look signed
      // out, which is the specific regression this asserts against.
      const issued = callback.cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      assert.ok(issued, 'the callback issued no session cookie to replay');
      const nameValue = issued.split(';')[0];

      let seenUserId = null;
      const me = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/auth/me', cookies: [nameValue] }),
        {},
        {
          env: DEPLOYED_ENV,
          getConnection: async (userId) => {
            seenUserId = userId;
            return null;
          },
        }
      );

      assert.equal(me.statusCode, 200, 'the session issued on the new origin was not accepted back');
      assert.equal(JSON.parse(me.body).email, 'user3@example.com');
      assert.ok(seenUserId, 'the session never resolved to a user id');
    });

    it('FAILURE PATH: a request whose cookies array is empty is rejected as unauthenticated', async () => {
      let getConnectionCalls = 0;
      const response = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/auth/me', cookies: [] }),
        {},
        {
          env: DEPLOYED_ENV,
          getConnection: async () => {
            getConnectionCalls += 1;
            return null;
          },
        }
      );

      assert.equal(response.statusCode, 401);
      assert.equal(getConnectionCalls, 0, 'an unauthenticated request still hit the connections layer');
    });
  });

  describe('Scenario: PUBLIC_BASE_URL matches the origin actually served', () => {
    it('Given the app is served from its new public origin, When the OAuth start route builds the redirect_uri, Then the redirect_uri host equals the host the browser is on', async () => {
      const response = await withDeployedProcessEnv(() =>
        handler(givenAFunctionUrlRequest({ path: '/calendar/api/auth/google/start' }), {}, {})
      );

      assert.equal(response.statusCode, 302);
      const location = new URL(response.headers.Location);
      const redirectUri = new URL(location.searchParams.get('redirect_uri'));

      assert.equal(redirectUri.host, FN_HOST,
        `redirect_uri host ${redirectUri.host} is not the host the browser reached us on (${FN_HOST})`);
      assert.equal(redirectUri.protocol, 'https:');
      assert.equal(redirectUri.pathname, CALLBACK_PATH);
    });

    it('And a request arriving on a DIFFERENT function URL host gets that host in its redirect_uri', async () => {
      // The whole point of deriving per request: the value follows the URL id,
      // so a recreated function URL needs no redeploy of the Lambda.
      const otherHost = 'zz9plural.lambda-url.eu-west-2.on.aws';
      const event = givenAFunctionUrlRequest({ path: '/calendar/api/auth/google/start' });
      event.headers.host = otherHost;
      event.requestContext.domainName = otherHost;

      const response = await withDeployedProcessEnv(() => handler(event, {}, {}));

      assert.equal(response.statusCode, 302);
      const location = new URL(response.headers.Location);
      const redirectUri = new URL(location.searchParams.get('redirect_uri'));
      assert.equal(redirectUri.host, otherHost);
    });

    it('And an explicitly configured PUBLIC_BASE_URL still overrides the derivation, so local development keeps working', async () => {
      const response = await handler(
        givenAFunctionUrlRequest({ path: '/calendar/api/auth/google/start' }),
        {},
        { env: { ...DEPLOYED_ENV, PUBLIC_BASE_URL: 'http://localhost:3000' } }
      );

      assert.equal(response.statusCode, 302);
      const location = new URL(response.headers.Location);
      const redirectUri = new URL(location.searchParams.get('redirect_uri'));
      assert.equal(redirectUri.origin, 'http://localhost:3000',
        'an explicit PUBLIC_BASE_URL must still win, or local development breaks');
    });
  });

  describe('Scenario: OAuth code containing a slash is not double-decoded', () => {
    it('Given a callback whose "code" query value contains "/" and "+", When getQueryParam reads it under payload format 2.0, Then the value handed to the token exchange is byte-identical to what Google issued And the token exchange does not fail with invalid_grant', async () => {
      // Format 2.0 hands queryStringParameters over ALREADY DECODED. Decoding
      // again would turn a literal "%2F" inside the code into "/" and a "+"
      // into a space, corrupting only the subset of codes that contain an
      // escape — which looks intermittent rather than broken.
      const GOOGLE_CODE = '4/0AeanS0Y+slash/and%2Bplus_literal-value';
      const state = 'state-value-jkl';
      const codeVerifier = generateCodeVerifier();

      let codeSeenByExchange = null;
      const response = await withDeployedProcessEnv(() =>
        handler(
          givenAFunctionUrlRequest({
            path: CALLBACK_PATH,
            query: { state, code: GOOGLE_CODE },
            cookies: [stateCookieFor(state, codeVerifier)],
          }),
          {},
          {
            exchangeCode: async ({ code }) => {
              codeSeenByExchange = code;
              // A real token endpoint answers invalid_grant for a mangled code.
              if (code !== GOOGLE_CODE) throw new Error('invalid_grant');
              return {
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                idToken: idTokenFor('google-sub-4', 'user4@example.com'),
                expiresIn: 3600,
                scope: 'openid email profile',
                tokenType: 'Bearer',
              };
            },
            putConnection: async () => ({}),
          }
        )
      );

      assert.equal(codeSeenByExchange, GOOGLE_CODE,
        `the code was mangled on the way to the exchange: ${JSON.stringify(codeSeenByExchange)}`);
      assert.notEqual(response.statusCode, 502,
        'the token exchange failed — a 502 here is the invalid_grant path');
      assert.equal(response.statusCode, 302);
    });
  });

  describe('Scenario: A scheduled scan event is never mistaken for an HTTP request', () => {
    it('Given an EventBridge Scheduler event with source set to the scan source, When the handler inspects it, Then it runs the scheduled scan and returns a plain result object And it does not return an HTTP response shape', async () => {
      let scanArgs = null;
      const scheduledEvent = {
        source: SCAN_SCHEDULED_SOURCE,
        userId: 'google#1',
        // Deliberately none of rawPath / requestContext / path / httpMethod.
      };

      const result = await handler(scheduledEvent, {}, {
        env: DEPLOYED_ENV,
        // Injected so no Gmail call, no Anthropic call and no DynamoDB client.
        runScan: async (args) => {
          scanArgs = args;
          return { status: 'ok', messagesScanned: 3 };
        },
      });

      assert.ok(scanArgs, 'the scheduled scan never ran');
      assert.equal(scanArgs.userId, 'google#1');
      assert.equal(scanArgs.mode, 'scheduled');
      assert.deepEqual(result, { status: 'ok', messagesScanned: 3 });
      assert.equal(result.statusCode, undefined,
        'a scheduler invocation must not receive an HTTP response shape');
      assert.equal(result.headers, undefined);
      assert.equal(result.cookies, undefined);
      assert.equal(result.body, undefined);
    });
  });

  describe('Scenario: An HTTP request is never mistaken for a scheduled scan', () => {
    it('Given a format 2.0 HTTP event that carries a "source" property, And no httpMethod and no path property, because format 2.0 has neither, When isScheduledScanEvent inspects it, Then it returns false And the request is routed as HTTP', async () => {
      // The nasty case: format 2.0 has no `httpMethod` and no `path`, so a test
      // of "source is set AND httpMethod/path are absent" would classify this
      // real browser request as a schedule and answer it with a bare result
      // object — a blank page, and no scan either.
      const event = givenAFunctionUrlRequest({ path: '/calendar/api/health' });
      event.source = SCAN_SCHEDULED_SOURCE;

      let ranScan = false;
      const response = await handler(event, {}, {
        env: DEPLOYED_ENV,
        runScan: async () => {
          ranScan = true;
          return { status: 'ok' };
        },
      });

      assert.equal(ranScan, false,
        'an HTTP request on the function URL was run as a scheduled scan');
      assert.equal(response.statusCode, 200, 'the request was not routed as HTTP');
      assert.equal(JSON.parse(response.body).service, 'school-calendar');
    });
  });

  describe('Scenario: Wildcard CORS never ships credentials', () => {
    it('Given ALLOWED_ORIGINS is unset so the resolved origin is "*", When any route returns a response carrying Access-Control-Allow-Credentials, Then finalise strips that header from the new response shape before it leaves the router', async () => {
      const response = await handler(
        givenAFunctionUrlRequest({
          path: '/calendar/api/health',
          headers: { origin: 'https://anything.example.com' },
        }),
        {},
        { env: { ...DEPLOYED_ENV, ALLOWED_ORIGINS: undefined } }
      );

      assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
      const credentialHeaders = Object.keys(response.headers)
        .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');
      assert.deepEqual(credentialHeaders, [],
        'Access-Control-Allow-Credentials was paired with a wildcard origin in the format 2.0 headers map');
    });

    it('And the strip reads the new `headers` map, not the removed `multiValueHeaders`', async () => {
      // If finalise still looked at multiValueHeaders it would find nothing and
      // strip nothing, so this pairing is the regression guard.
      const response = await handler(
        givenAFunctionUrlRequest({
          path: '/calendar/api/health',
          headers: { origin: 'https://anything.example.com' },
        }),
        {},
        { env: DEPLOYED_ENV }
      );
      assert.equal(response.multiValueHeaders, undefined);
      assert.ok(response.headers, 'the response has no headers map for finalise to inspect');
    });
  });

  describe('Scenario: the derived origin is the one the browser is on', () => {
    it('Given a request on the function URL, Then resolvePublicBaseUrl returns that exact https origin', () => {
      const event = givenAFunctionUrlRequest({ path: '/calendar/api/health' });
      assert.equal(resolvePublicBaseUrl(event, { PUBLIC_BASE_URL: '' }), `https://${FN_HOST}`);
    });
  });
});
