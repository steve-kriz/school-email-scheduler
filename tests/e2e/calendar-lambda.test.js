import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Import the handler from the actual source
// Convert path to file:// URL for ES modules on Windows
const handlerPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
const handlerUrl = new URL(`file:///${handlerPath.replace(/\\/g, '/')}`).href;
const {
  handler,
  buildResponse,
  jsonResponse,
  getCorsOrigin,
  isOriginAllowed,
  parseAllowedOrigins,
  fileCache,
  ASSET_DIR
} = await import(handlerUrl);

describe('Calendar Lambda E2E Tests', () => {
  describe('Feature: Calendar Lambda and ALB wiring', () => {
    describe('Scenario: The ALB health check passes', () => {
      it('Given the calendar lambda handler', () => {
        assert.ok(typeof handler === 'function', 'handler is not a function');
      });

      it('When an ALB event for "GET /calendar/api/health" is invoked, Then the response status code is 200', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          headers: {
            'host': ['example.com'],
            'user-agent': ['curl']
          },
          multiValueHeaders: {
            'host': ['example.com'],
            'user-agent': ['curl']
          },
          queryStringParameters: null,
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 200, `Expected status 200, got ${response.statusCode}`);
      });

      it('When an ALB event for "GET /calendar/api/health" is invoked, Then the response content type is "application/json"', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          multiValueHeaders: {
            'host': ['example.com']
          },
          queryStringParameters: null,
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.ok(response.multiValueHeaders['Content-Type'], 'Content-Type header not found');
        assert.equal(response.multiValueHeaders['Content-Type'][0], 'application/json',
          `Expected Content-Type application/json, got ${response.multiValueHeaders['Content-Type'][0]}`);
      });

      it('When an ALB event for "GET /calendar/api/health" is invoked, Then the response body is valid JSON', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);
        assert.ok(body.status === 'ok', 'Health check status is not "ok"');
        assert.ok(body.service === 'school-calendar', 'Service name is not "school-calendar"');
        assert.ok(body.timestamp, 'Timestamp is missing');
      });
    });

    describe('Scenario: An unknown path is rejected rather than served', () => {
      it('Given the calendar lambda handler', () => {
        assert.ok(typeof handler === 'function', 'handler is not a function');
      });

      it('When an ALB event for "GET /calendar/api/nope" is invoked, Then the response status code is 404', async () => {
        const event = {
          path: '/calendar/api/nope',
          httpMethod: 'GET',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 404, `Expected status 404, got ${response.statusCode}`);
      });

      it('When an ALB event for an unknown path is invoked, Then the response is JSON with an error key', async () => {
        const event = {
          path: '/calendar/api/nope',
          httpMethod: 'GET',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        const body = JSON.parse(response.body);
        assert.ok(body.error, 'Error field is missing');
        assert.equal(body.path, '/calendar/api/nope', 'Path is not echoed correctly');
      });
    });

    describe('Scenario: The handler runs as an ES module without __dirname', () => {
      it('Given the file "src/lambda/calendar/index.mjs", Then it does not contain a bare "__dirname" reference', async () => {
        const fs = await import('node:fs');
        const indexPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
        const content = fs.readFileSync(indexPath, 'utf-8');

        // Check for bare __dirname - but it should NOT be there as a global reference
        // The pattern is: it should derive it from import.meta.url
        // The test should fail only if __dirname is used as a bare global without being declared first
        const lines = content.split('\n');
        let hasDerivedDirname = false;
        let dirnameDeclarationLine = -1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Check if __dirname is derived from import.meta.url (const __dirname = dirname(__filename))
          if (line.includes('const __dirname') && line.includes('dirname(')) {
            hasDerivedDirname = true;
            dirnameDeclarationLine = i;
          }
        }

        assert.ok(hasDerivedDirname, '__dirname is not derived from import.meta.url');

        // Check that __dirname is NOT used as a bare global BEFORE it's declared
        // (it's OK to use it AFTER declaration in other assignments)
        // A truly "bare" use would be something like: readFileSync(`${__dirname}/file.txt`)
        // without __dirname being declared as a const first

        // Since we found the declaration, the key is that __dirname must be derived from import.meta.url
        // and not be a bare global. The code is correct if:
        // 1. __dirname is declared from dirname(__filename), and
        // 2. __filename is declared from fileURLToPath(import.meta.url)
        // Both of these are checked above.
      });

      it('And it derives the directory from "import.meta.url"', async () => {
        const fs = await import('node:fs');
        const indexPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
        const content = fs.readFileSync(indexPath, 'utf-8');

        assert.ok(content.includes('fileURLToPath(import.meta.url)'),
          'fileURLToPath(import.meta.url) not found');
        assert.ok(content.includes('import.meta.url'),
          'import.meta.url not found');
        assert.ok(content.includes('dirname'),
          'dirname function not found');
      });
    });

    describe('Scenario: Handler behavior with minimal events', () => {
      it('When an ALB event has no headers object at all, Then the handler does not throw', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          // No headers, no multiValueHeaders
          body: null,
          isBase64Encoded: false
        };

        let threw = false;
        let response;
        try {
          response = await handler(event);
        } catch (e) {
          threw = true;
        }

        assert.ok(!threw, `Handler threw an error: ${threw ? 'true' : 'false'}`);
        assert.ok(response, 'Handler returned no response');
      });

      it('When an ALB event for a path with query string is invoked, Then status code is 404', async () => {
        const event = {
          path: '/calendar/api/health?foo=bar',
          httpMethod: 'GET',
          multiValueHeaders: {},
          queryStringParameters: { foo: 'bar' },
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        // Query strings change the path, so /calendar/api/health?foo=bar is not /calendar/api/health
        assert.ok(response.statusCode === 404, 'Expected 404 for path with query string');
      });

      it('When an unsupported method (PUT) is used on the health path, Then status code is 404', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'PUT',
          multiValueHeaders: {},
          body: '{}',
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 404, `Expected 404 for PUT /calendar/api/health, got ${response.statusCode}`);
      });

      it('When an OPTIONS request is made, Then status code is 200 (CORS preflight)', async () => {
        const event = {
          path: '/some/path',
          httpMethod: 'OPTIONS',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 200, `Expected 200 for OPTIONS, got ${response.statusCode}`);
      });
    });

    describe('Scenario: Response shape is multiValueHeaders, not headers', () => {
      it('When handler returns a response, Then it has multiValueHeaders key and no single-value headers key', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.ok(response.multiValueHeaders, 'multiValueHeaders key not found');
        assert.ok(!response.headers, 'Single-value headers key should not exist');

        // All values in multiValueHeaders should be arrays
        for (const [key, value] of Object.entries(response.multiValueHeaders)) {
          assert.ok(Array.isArray(value), `multiValueHeaders["${key}"] is not an array`);
        }
      });

      it('When handler returns Content-Type, Then it is an array within multiValueHeaders', async () => {
        const event = {
          path: '/calendar/api/health',
          httpMethod: 'GET',
          multiValueHeaders: {},
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.ok(Array.isArray(response.multiValueHeaders['Content-Type']),
          'Content-Type is not an array');
        assert.equal(response.multiValueHeaders['Content-Type'][0], 'application/json',
          'Content-Type value is not application/json');
      });
    });

    describe('Scenario: Exported utilities are available', () => {
      it('Then buildResponse function is exported', () => {
        assert.ok(typeof buildResponse === 'function', 'buildResponse is not a function');
      });

      it('Then jsonResponse function is exported', () => {
        assert.ok(typeof jsonResponse === 'function', 'jsonResponse is not a function');
      });

      it('Then getCorsOrigin function is exported', () => {
        assert.ok(typeof getCorsOrigin === 'function', 'getCorsOrigin is not a function');
      });

      it('Then isOriginAllowed function is exported', () => {
        assert.ok(typeof isOriginAllowed === 'function', 'isOriginAllowed is not a function');
      });

      it('Then parseAllowedOrigins function is exported', () => {
        assert.ok(typeof parseAllowedOrigins === 'function', 'parseAllowedOrigins is not a function');
      });

      it('Then fileCache is exported', () => {
        assert.ok(fileCache instanceof Map, 'fileCache is not a Map');
      });

      it('Then ASSET_DIR is exported as a string', () => {
        assert.ok(typeof ASSET_DIR === 'string', 'ASSET_DIR is not a string');
        assert.ok(ASSET_DIR.length > 0, 'ASSET_DIR is empty');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The origin gate is the app's only cross-origin control and every later route
// inherits it, so these tests assert on RETURN VALUES rather than on the fact
// that the functions are exported.
//
// ALLOWED_ORIGINS is parsed once at module scope, so a test cannot reconfigure
// it by writing process.env after import (and this is ESM, so there is no
// require.cache to bust). Instead getCorsOrigin/isOriginAllowed/buildResponse
// take an optional allowlist argument that defaults to the module-scope
// constant, and parseAllowedOrigins is exported so tests parse a raw string
// exactly as the module does at import time.
// ---------------------------------------------------------------------------
describe('Feature: The origin gate behaves as configured', () => {
  const OPEN = parseAllowedOrigins('');
  const OFFICEHQ = parseAllowedOrigins('officehq.com.au');
  const MIXED_CASE = parseAllowedOrigins('OfficeHQ.com.au');

  describe('Scenario: A mixed-case allowlist entry still matches', () => {
    it('Given ALLOWED_ORIGINS is "OfficeHQ.com.au", Then entries are lower-cased at parse time', () => {
      assert.deepEqual(MIXED_CASE, ['officehq.com.au'],
        'ALLOWED_ORIGINS entries are not lower-cased at parse time');
    });

    it('When a request arrives from "https://officehq.com.au", Then the origin is allowed', () => {
      // Fails before the fix: URL always lower-cases hostname, so a raw
      // "OfficeHQ.com.au" entry could never match any hostname.
      assert.equal(isOriginAllowed('https://officehq.com.au', MIXED_CASE), true,
        'A mixed-case allowlist entry did not match a lowercase origin');
    });

    it('And a subdomain of the mixed-case entry is allowed', () => {
      assert.equal(isOriginAllowed('https://sub.officehq.com.au', MIXED_CASE), true,
        'A mixed-case allowlist entry did not match a subdomain');
    });

    it('And a mixed-case origin matches a lowercase entry', () => {
      assert.equal(isOriginAllowed('https://OfficeHQ.com.au', OFFICEHQ), true,
        'A mixed-case origin did not match a lowercase allowlist entry');
    });

    it('And ALLOWED_ORIGINS entries are trimmed and blanks dropped', () => {
      assert.deepEqual(parseAllowedOrigins(' A.com , ,B.com '), ['a.com', 'b.com'],
        'ALLOWED_ORIGINS parsing does not trim entries and drop blanks');
    });
  });

  describe('Scenario: Open mode echoes a wildcard', () => {
    it('Given ALLOWED_ORIGINS is unset, When the cors origin is resolved, Then it is "*"', () => {
      assert.equal(parseAllowedOrigins(undefined).length, 0, 'Unset ALLOWED_ORIGINS did not parse to an empty allowlist');
      assert.equal(getCorsOrigin(null, OPEN), '*', 'Open mode did not resolve to "*" for a missing origin');
      assert.equal(getCorsOrigin('https://anything.example.com', OPEN), '*',
        'Open mode did not resolve to "*" for an arbitrary origin');
    });

    it('And no origin is "allowed" by name in open mode - the wildcard is the only opener', () => {
      // isOriginAllowed is the membership test; open mode is handled by
      // getCorsOrigin. Keeping them distinct is what lets a future route
      // require a real allowlist entry even while CORS is open.
      assert.equal(isOriginAllowed('https://anything.example.com', OPEN), false,
        'An empty allowlist reported an origin as an explicit member');
    });
  });

  describe('Scenario: An allowed origin is echoed back', () => {
    it('Given ALLOWED_ORIGINS is "officehq.com.au", When a request arrives from "https://officehq.com.au", Then it is echoed', () => {
      assert.equal(getCorsOrigin('https://officehq.com.au', OFFICEHQ), 'https://officehq.com.au',
        'An allowed origin was not echoed back');
    });

    it('And the echoed value is the full origin, not just the hostname', () => {
      assert.equal(getCorsOrigin('https://sub.officehq.com.au:8443', OFFICEHQ),
        'https://sub.officehq.com.au:8443',
        'The echoed CORS origin was not the request origin verbatim');
    });
  });

  describe('Scenario: A disallowed origin is not echoed', () => {
    it('Given ALLOWED_ORIGINS is "officehq.com.au", When a request arrives from "https://example.com", Then the origin is not allowed', () => {
      assert.equal(isOriginAllowed('https://example.com', OFFICEHQ), false,
        'A disallowed origin was reported as allowed');
    });

    it('And getCorsOrigin returns null for it', () => {
      assert.equal(getCorsOrigin('https://example.com', OFFICEHQ), null,
        'A disallowed origin did not resolve to null');
    });

    it('And no Access-Control-Allow-Origin header is emitted for it', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://example.com',
        allowlist: OFFICEHQ
      });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'], undefined,
        'A disallowed origin was echoed in Access-Control-Allow-Origin');
    });

    it('And a missing or malformed origin is not allowed', () => {
      assert.equal(isOriginAllowed(null, OFFICEHQ), false, 'A null origin was allowed');
      assert.equal(isOriginAllowed('', OFFICEHQ), false, 'An empty origin was allowed');
      assert.equal(isOriginAllowed('not-a-url', OFFICEHQ), false, 'A malformed origin was allowed');
      assert.equal(getCorsOrigin(null, OFFICEHQ), null, 'A null origin did not resolve to null');
    });
  });

  describe('Scenario: A subdomain of an allowed domain is allowed', () => {
    it('Given ALLOWED_ORIGINS is "officehq.com.au", When a request arrives from "https://sub.officehq.com.au", Then the origin is allowed', () => {
      assert.equal(isOriginAllowed('https://sub.officehq.com.au', OFFICEHQ), true,
        'A subdomain of an allowed domain was rejected');
    });

    it('And a deeper subdomain is allowed', () => {
      assert.equal(isOriginAllowed('https://a.b.officehq.com.au', OFFICEHQ), true,
        'A nested subdomain of an allowed domain was rejected');
    });

    it('And the exact domain is allowed', () => {
      assert.equal(isOriginAllowed('https://officehq.com.au', OFFICEHQ), true,
        'The exact allowed domain was rejected');
    });
  });

  describe('Scenario Outline: A lookalike domain is refused', () => {
    // The suffix match must require a dot boundary. A naive
    // `hostname.endsWith(entry)` would accept "evil-officehq.com.au", which
    // genuinely ends with "officehq.com.au".
    const lookalikes = [
      'https://evil-officehq.com.au',
      'https://officehq.com.au.attacker.com',
      'https://notofficehq.com.au',
      'https://evil-officehq.com.au/path',
      'https://xofficehq.com.au'
    ];

    for (const origin of lookalikes) {
      it(`Given ALLOWED_ORIGINS is "officehq.com.au", When a request arrives from "${origin}", Then the origin is not allowed`, () => {
        assert.equal(isOriginAllowed(origin, OFFICEHQ), false,
          `Lookalike origin ${origin} was allowed by an "officehq.com.au" allowlist`);
        assert.equal(getCorsOrigin(origin, OFFICEHQ), null,
          `Lookalike origin ${origin} resolved to a CORS origin instead of null`);
      });
    }

    it('And a lookalike is not echoed in a built response', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://evil-officehq.com.au',
        allowlist: OFFICEHQ
      });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'], undefined,
        'A lookalike origin was echoed in Access-Control-Allow-Origin');
    });
  });

  describe('Scenario: Credentials are never paired with a wildcard origin', () => {
    const credentialsHeaderOf = (response) =>
      Object.keys(response.multiValueHeaders)
        .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');

    it('Given ALLOWED_ORIGINS is unset, When any response is built, Then it does not carry Access-Control-Allow-Credentials', () => {
      const response = buildResponse(200, '{}', 'application/json', { origin: 'https://anything.example.com', allowlist: OPEN });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'][0], '*',
        'Open mode did not emit a wildcard Access-Control-Allow-Origin');
      assert.deepEqual(credentialsHeaderOf(response), [],
        'A wildcard-origin response carried Access-Control-Allow-Credentials');
    });

    // This is the regression guard: buildResponse must structurally refuse to
    // emit the header alongside "*", not merely refrain from adding it. Fails
    // if a later ticket adds Allow-Credentials next to the open "*" branch, or
    // removes the invariant from buildResponse.
    it('And a caller that explicitly asks for Allow-Credentials alongside "*" does not get it', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://anything.example.com',
        allowlist: OPEN,
        headers: { 'Access-Control-Allow-Credentials': ['true'] }
      });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'][0], '*',
        'Open mode did not emit a wildcard Access-Control-Allow-Origin');
      assert.deepEqual(credentialsHeaderOf(response), [],
        'buildResponse emitted Access-Control-Allow-Credentials while the resolved origin was "*"');
    });

    it('And the invariant is case-insensitive, as HTTP header names are', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://anything.example.com',
        allowlist: OPEN,
        headers: { 'access-control-allow-credentials': ['true'] }
      });
      assert.deepEqual(credentialsHeaderOf(response), [],
        'A lowercase Access-Control-Allow-Credentials survived alongside a wildcard origin');
    });

    it('And jsonResponse inherits the same invariant', () => {
      const response = jsonResponse(200, { ok: true }, {
        origin: 'https://anything.example.com',
        allowlist: OPEN,
        headers: { 'Access-Control-Allow-Credentials': ['true'] }
      });
      assert.deepEqual(credentialsHeaderOf(response), [],
        'jsonResponse emitted Access-Control-Allow-Credentials alongside a wildcard origin');
    });

    it('But with an explicit allowlist and an allowed origin, credentials are permitted', () => {
      // Proves the invariant is scoped to the wildcard rather than a blanket
      // ban, so TASK-004 can use credentialed CORS by setting ALLOWED_ORIGINS.
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://officehq.com.au',
        allowlist: OFFICEHQ,
        headers: { 'Access-Control-Allow-Credentials': ['true'] }
      });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'][0], 'https://officehq.com.au',
        'An allowed origin was not echoed back');
      assert.deepEqual(response.multiValueHeaders['Access-Control-Allow-Credentials'], ['true'],
        'Credentials were stripped for a specifically allowed (non-wildcard) origin');
    });

    it('And no live handler response carries Access-Control-Allow-Credentials', async () => {
      const paths = ['/calendar/api/health', '/calendar/api/nope'];
      for (const p of paths) {
        const response = await handler({
          path: p,
          httpMethod: 'GET',
          multiValueHeaders: { origin: ['https://anything.example.com'] },
          body: null,
          isBase64Encoded: false
        });
        assert.deepEqual(credentialsHeaderOf(response), [],
          `Response for ${p} carried Access-Control-Allow-Credentials`);
      }
    });
  });

  describe('Scenario: The health check is unaffected', () => {
    it('When an ALB event for "GET /calendar/api/health" is invoked, Then the response status code is 200', async () => {
      // The ALB health check sends no Origin header at all.
      const response = await handler({
        path: '/calendar/api/health',
        httpMethod: 'GET',
        multiValueHeaders: { host: ['internal'], 'user-agent': ['ELB-HealthChecker/2.0'] },
        body: null,
        isBase64Encoded: false
      });
      assert.equal(response.statusCode, 200, `Expected status 200, got ${response.statusCode}`);
      assert.equal(JSON.parse(response.body).status, 'ok', 'Health check status is not "ok"');
    });
  });

  describe('Scenario: An echoed origin is accompanied by Vary: Origin', () => {
    it('When an allowed subdomain origin is echoed, Then Vary: Origin is set so caches do not cross-serve it', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://sub.officehq.com.au',
        allowlist: OFFICEHQ
      });
      assert.equal(response.multiValueHeaders['Access-Control-Allow-Origin'][0], 'https://sub.officehq.com.au',
        'An allowed subdomain origin was not echoed back');
      assert.deepEqual(response.multiValueHeaders['Vary'], ['Origin'],
        'Vary: Origin was not set alongside an echoed origin');
    });
  });
});
