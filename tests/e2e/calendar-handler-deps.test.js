import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { handler, asRouteDeps } from '../../src/lambda/calendar/index.mjs';
import {
  GOOGLE_TOKEN_ENDPOINT,
  exchangeCodeForTokens,
} from '../../src/lambda/calendar/backend/google-oauth.mjs';

// The Node.js Lambda runtime invokes handlers with THREE arguments -
// (event, context, callback) - async handlers included. These tests pin down that
// the third argument is honoured as dependency overrides ONLY when it is a plain
// object, so the runtime's callback (a function) can never inject one - most
// importantly not `tokenEndpoint`, `fetchImpl` or `exchangeCode`, the seams the
// "no id_token signature verification" ruling depends on.

const INDEX_PATH = fileURLToPath(new URL('../../src/lambda/calendar/index.mjs', import.meta.url));
const OAUTH_URL = new URL('../../src/lambda/calendar/backend/google-oauth.mjs', import.meta.url);
const OAUTH_PATH = fileURLToPath(OAUTH_URL);

const EVIL_ENDPOINT = 'https://evil.example.com/token';

describe('Calendar handler dependency seam - E2E Tests', () => {
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const clientSecret = 'test-client-secret-xyz';
  const sessionSecret = 'test-session-secret-must-be-32-bytes-long!!';
  const baseUrl = 'https://example.com';

  const oauthEnvVars = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'SESSION_SECRET',
    'PUBLIC_BASE_URL',
    'GOOGLE_TOKEN_ENDPOINT',
    'NODE_ENV',
  ];

  let savedEnv;
  let savedFetch;
  let fetchCalls;

  /** A token-endpoint response whose id_token is unusable, so the callback stops
   *  right after the exchange (400) and never reaches DynamoDB or KMS. */
  const tokenResponse = () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: '',
        expires_in: 3600,
        scope: 'openid email profile',
        token_type: 'Bearer',
      }),
  });

  beforeEach(() => {
    savedEnv = {};
    for (const name of oauthEnvVars) savedEnv[name] = process.env[name];

    // Real process.env config, so a request that IGNORES the injected deps still
    // gets past the configuration gate and actually reaches the token exchange.
    // Without this the "tokenEndpoint was not used" assertions would be vacuous.
    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;
    process.env.SESSION_SECRET = sessionSecret;
    process.env.PUBLIC_BASE_URL = baseUrl;

    fetchCalls = [];
    savedFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return tokenResponse();
    };
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    for (const name of oauthEnvVars) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  /** A well-formed callback request whose state matches its state cookie. */
  function callbackEvent() {
    const state = 'state-value-for-deps-test';
    const codeVerifier = 'code-verifier-for-deps-test-0123456789abcdef';
    const cookie = Buffer.from(JSON.stringify({ state, codeVerifier }), 'utf8').toString('base64url');
    return {
      path: '/calendar/api/auth/google/callback',
      httpMethod: 'GET',
      queryStringParameters: { state, code: 'test-authorization-code' },
      multiValueHeaders: { cookie: [`calendar_oauth_state=${cookie}`] },
    };
  }

  function startEvent() {
    return { path: '/calendar/api/auth/google/start', httpMethod: 'GET', headers: {} };
  }

  describe('a function third argument (the Lambda runtime callback)', () => {
    it('should ignore an own enumerable tokenEndpoint carried on a function', async () => {
      // Shaped like an instrumented runtime callback that happens to carry an
      // assigned property. `name`/`length` are non-enumerable, so `tokenEndpoint`
      // is the only own enumerable key - exactly the dangerous case.
      const runtimeCallback = function callback(err, result) {
        return [err, result];
      };
      runtimeCallback.tokenEndpoint = EVIL_ENDPOINT;
      assert.deepEqual(Object.keys(runtimeCallback), ['tokenEndpoint']);

      const response = await handler(callbackEvent(), {}, runtimeCallback);

      // The exchange really happened (otherwise "not used" proves nothing)...
      assert.equal(fetchCalls.length, 1, 'the default token exchange should have run');
      // ...and it went to Google's constant, not the attacker's endpoint.
      assert.equal(fetchCalls[0].url, GOOGLE_TOKEN_ENDPOINT);
      assert.ok(
        !fetchCalls.some((call) => call.url.includes('evil.example.com')),
        'no request may be sent to an endpoint supplied on a function argument'
      );
      // Stopped at the unusable id_token, so nothing was stored.
      assert.equal(response.statusCode, 400);
    });

    it('should invoke neither exchangeCode nor fetchImpl carried on a function', async () => {
      let exchangeCodeCalls = 0;
      let fetchImplCalls = 0;

      const runtimeCallback = function callback() {};
      runtimeCallback.exchangeCode = async () => {
        exchangeCodeCalls += 1;
        return {
          accessToken: 'a',
          refreshToken: 'r',
          idToken: '',
          expiresIn: 3600,
          scope: '',
          tokenType: 'Bearer',
        };
      };
      runtimeCallback.fetchImpl = async (url) => {
        fetchImplCalls += 1;
        void url;
        return tokenResponse();
      };
      assert.deepEqual(Object.keys(runtimeCallback).sort(), ['exchangeCode', 'fetchImpl']);

      const response = await handler(callbackEvent(), {}, runtimeCallback);

      assert.equal(exchangeCodeCalls, 0, 'exchangeCode on a function must never be invoked');
      assert.equal(fetchImplCalls, 0, 'fetchImpl on a function must never be invoked');
      // The default path ran instead - so "0 calls" is a real rejection, not a
      // request that never got as far as the exchange.
      assert.equal(fetchCalls.length, 1, 'the default token exchange should have run');
      assert.equal(fetchCalls[0].url, GOOGLE_TOKEN_ENDPOINT);
      assert.equal(response.statusCode, 400);
    });

    it('should ignore env carried on a function (route falls back to process.env)', async () => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.PUBLIC_BASE_URL;

      const runtimeCallback = function callback() {};
      runtimeCallback.env = {
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: clientSecret,
        SESSION_SECRET: sessionSecret,
        PUBLIC_BASE_URL: baseUrl,
      };

      const response = await handler(startEvent(), {}, runtimeCallback);

      assert.equal(response.statusCode, 500);
      assert.equal(JSON.parse(response.body).error, 'Google sign-in is not configured');
    });

    it('should ignore a bare function, an array and a class instance', async () => {
      class Deps {
        constructor() {
          this.tokenEndpoint = EVIL_ENDPOINT;
        }
      }
      const arrayDeps = [];
      arrayDeps.tokenEndpoint = EVIL_ENDPOINT;

      for (const third of [function callback() {}, new Deps(), arrayDeps, 'tokenEndpoint', 7, null, undefined]) {
        fetchCalls = [];
        const response = await handler(callbackEvent(), {}, third);
        assert.equal(response.statusCode, 400);
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, GOOGLE_TOKEN_ENDPOINT);
      }
    });
  });

  describe('a plain object third argument (legitimate test injection)', () => {
    it('should still honour tokenEndpoint from a plain object', async () => {
      // The control for the function tests above: the same key on a plain object
      // DOES reach the exchange, so those assertions can genuinely fail.
      const response = await handler(callbackEvent(), {}, { tokenEndpoint: EVIL_ENDPOINT });

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, EVIL_ENDPOINT);
      assert.equal(response.statusCode, 400);
    });

    it('should still honour exchangeCode and fetchImpl from a plain object', async () => {
      let exchangeCodeCalls = 0;
      const exchangeCode = async () => {
        exchangeCodeCalls += 1;
        return {
          accessToken: 'a',
          refreshToken: 'r',
          idToken: '',
          expiresIn: 3600,
          scope: '',
          tokenType: 'Bearer',
        };
      };

      const response = await handler(callbackEvent(), {}, { exchangeCode, fetchImpl: async () => tokenResponse() });

      assert.equal(exchangeCodeCalls, 1, 'plain-object injection must keep working');
      assert.equal(fetchCalls.length, 0, 'the injected exchange replaces the default HTTP path');
      assert.equal(response.statusCode, 400);
    });

    it('should still honour env from a plain object', async () => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.PUBLIC_BASE_URL;

      const response = await handler(startEvent(), undefined, {
        env: { GOOGLE_CLIENT_ID: clientId, PUBLIC_BASE_URL: baseUrl },
      });

      assert.equal(response.statusCode, 302);
      assert.ok(response.multiValueHeaders.Location[0].startsWith('https://accounts.google.com/'));
    });

    it('should honour a null-prototype object of dependencies', async () => {
      const deps = Object.create(null);
      deps.tokenEndpoint = EVIL_ENDPOINT;

      const response = await handler(callbackEvent(), {}, deps);

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, EVIL_ENDPOINT);
      assert.equal(response.statusCode, 400);
    });
  });

  describe('asRouteDeps', () => {
    it('should return plain objects unchanged (same reference)', () => {
      const deps = { env: {}, exchangeCode: () => {} };
      assert.equal(asRouteDeps(deps), deps);

      const bare = Object.create(null);
      assert.equal(asRouteDeps(bare), bare);
    });

    it('should yield no overrides for anything that is not a plain object', () => {
      const fn = function callback() {};
      fn.tokenEndpoint = EVIL_ENDPOINT;
      fn.fetchImpl = () => {};
      fn.exchangeCode = () => {};

      class Deps {}
      const cases = [fn, function bare() {}, new Deps(), [], new Map(), 'x', 1, true, null, undefined];
      for (const value of cases) {
        assert.deepEqual(asRouteDeps(value), {});
        assert.equal(Object.keys(asRouteDeps(value)).length, 0);
      }
      assert.equal(asRouteDeps(fn).tokenEndpoint, undefined);
    });

    it('should behave identically regardless of NODE_ENV', () => {
      const fn = function callback() {};
      fn.tokenEndpoint = EVIL_ENDPOINT;

      process.env.NODE_ENV = 'production';
      assert.deepEqual(asRouteDeps(fn), {});
      process.env.NODE_ENV = 'test';
      assert.deepEqual(asRouteDeps(fn), {});
      delete process.env.NODE_ENV;
      assert.deepEqual(asRouteDeps(fn), {});
    });

    it('should read no environment signal at all (source check)', () => {
      const source = readFileSync(INDEX_PATH, 'utf8');
      const match = source.match(/function asRouteDeps\(value\) \{[\s\S]*?\n\}/);
      assert.ok(match, 'asRouteDeps should be defined in index.mjs');
      const body = match[0];
      assert.ok(!/process\.env/.test(body), 'asRouteDeps must not read process.env');
      assert.ok(!/NODE_ENV|NODE_TEST_CONTEXT/.test(body), 'asRouteDeps must not gate on a test-only signal');
      assert.match(body, /Object\.getPrototypeOf/);
    });

    it('should be the only source of route dependency overrides in the handler', () => {
      const source = readFileSync(INDEX_PATH, 'utf8');
      // A raw `...deps` spread would reintroduce the hole this check closes.
      assert.ok(!/\.\.\.deps\b/.test(source), 'the handler must spread the narrowed deps, never the raw argument');
      assert.equal((source.match(/\.\.\.routeDeps\b/g) || []).length, 2);
    });
  });

  describe('GOOGLE_TOKEN_ENDPOINT', () => {
    it('should be an https:// constant', () => {
      assert.equal(typeof GOOGLE_TOKEN_ENDPOINT, 'string');
      assert.equal(GOOGLE_TOKEN_ENDPOINT, 'https://oauth2.googleapis.com/token');
      assert.ok(GOOGLE_TOKEN_ENDPOINT.startsWith('https://'), 'the code exchange must never leave TLS');
    });

    it('should be declared as a string literal, not read from process.env', () => {
      const source = readFileSync(OAUTH_PATH, 'utf8');
      const declaration = source.match(/export const GOOGLE_TOKEN_ENDPOINT\s*=\s*([^\r\n]*)/);
      assert.ok(declaration, 'GOOGLE_TOKEN_ENDPOINT should be exported from google-oauth.mjs');
      assert.match(declaration[1], /^"https:\/\/[^"]+";$/);
      assert.ok(!/process\.env/.test(declaration[1]));

      // The default parameter that resolves the endpoint must use the constant.
      assert.match(source, /tokenEndpoint\s*=\s*GOOGLE_TOKEN_ENDPOINT/);
      assert.ok(
        !/tokenEndpoint\s*=\s*[^,)\r\n]*\benv\b/.test(source),
        'tokenEndpoint must not be defaulted from the environment'
      );
    });

    it('should not be overridable by process.env, even on a fresh module load', async () => {
      process.env.GOOGLE_TOKEN_ENDPOINT = EVIL_ENDPOINT;

      const fresh = await import(`${OAUTH_URL.href}?fresh=${Date.now()}`);
      assert.equal(fresh.GOOGLE_TOKEN_ENDPOINT, 'https://oauth2.googleapis.com/token');

      await fresh.exchangeCodeForTokens({
        code: 'c',
        codeVerifier: 'v',
        clientId,
        clientSecret,
        redirectUri: `${baseUrl}/calendar/api/auth/google/callback`,
      });

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, 'https://oauth2.googleapis.com/token');
    });

    it('should be the endpoint the exchange uses when no tokenEndpoint is injected', async () => {
      process.env.GOOGLE_TOKEN_ENDPOINT = EVIL_ENDPOINT;

      await exchangeCodeForTokens(
        {
          code: 'c',
          codeVerifier: 'v',
          clientId,
          clientSecret,
          redirectUri: `${baseUrl}/calendar/api/auth/google/callback`,
        },
        {}
      );

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, GOOGLE_TOKEN_ENDPOINT);
      assert.ok(!fetchCalls[0].url.includes('evil.example.com'));
    });

    it('should not be taken from the injected env by the callback route', async () => {
      // Guards the mutation "read tokenEndpoint from env" in the route layer too.
      const response = await handler(callbackEvent(), undefined, {
        env: {
          GOOGLE_CLIENT_ID: clientId,
          GOOGLE_CLIENT_SECRET: clientSecret,
          SESSION_SECRET: sessionSecret,
          PUBLIC_BASE_URL: baseUrl,
          GOOGLE_TOKEN_ENDPOINT: EVIL_ENDPOINT,
        },
      });

      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, GOOGLE_TOKEN_ENDPOINT);
      assert.equal(response.statusCode, 400);
    });
  });
});
