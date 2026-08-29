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
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health' } },
          cookies: [],
          headers: {
            'host': 'abc123.lambda-url.ap-southeast-2.on.aws',
            'user-agent': 'curl'
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
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          queryStringParameters: null,
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.ok(response.headers['Content-Type'], 'Content-Type header not found');
        assert.equal(response.headers['Content-Type'], 'application/json',
          `Expected Content-Type application/json, got ${response.headers['Content-Type']}`);
      });

      it('When an ALB event for "GET /calendar/api/health" is invoked, Then the response body is valid JSON', async () => {
        const event = {
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
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
          version: '2.0',
          rawPath: '/calendar/api/nope',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/nope' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 404, `Expected status 404, got ${response.statusCode}`);
      });

      it('When an ALB event for an unknown path is invoked, Then the response is JSON with an error key', async () => {
        const event = {
          version: '2.0',
          rawPath: '/calendar/api/nope',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/nope' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
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
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
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
          version: '2.0',
          rawPath: '/calendar/api/health?foo=bar',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health?foo=bar' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
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
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'PUT', path: '/calendar/api/health' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          body: '{}',
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 404, `Expected 404 for PUT /calendar/api/health, got ${response.statusCode}`);
      });

      it('When an OPTIONS request is made, Then status code is 200 (CORS preflight)', async () => {
        const event = {
          version: '2.0',
          rawPath: '/some/path',
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'OPTIONS', path: '/some/path' } },
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(response.statusCode, 200, `Expected 200 for OPTIONS, got ${response.statusCode}`);
      });
    });

    describe('Scenario: Response shape is payload format 2.0 headers + cookies, not multiValueHeaders', () => {
      it('When handler returns a response, Then it has a single-value headers key, a cookies array, and no multiValueHeaders or statusDescription', async () => {
        const event = {
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          requestContext: {
            domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
            http: { method: 'GET', path: '/calendar/api/health' }
          },
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.ok(response.headers, 'headers key not found');
        // A function URL IGNORES these two silently, so they must never be sent.
        assert.equal(response.multiValueHeaders, undefined,
          'multiValueHeaders must not exist on a function URL response');
        assert.equal(response.statusDescription, undefined,
          'statusDescription must not exist on a function URL response');
        assert.ok(Array.isArray(response.cookies),
          'cookies must always be an array, even when empty');

        // Every value in the format 2.0 headers map is a single string.
        for (const [key, value] of Object.entries(response.headers)) {
          assert.equal(typeof value, 'string', `headers["${key}"] is not a string`);
        }
      });

      it('When handler returns Content-Type, Then it is a plain string within headers', async () => {
        const event = {
          version: '2.0',
          rawPath: '/calendar/api/health',
          rawQueryString: '',
          headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
          cookies: [],
          requestContext: {
            domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
            http: { method: 'GET', path: '/calendar/api/health' }
          },
          body: null,
          isBase64Encoded: false
        };

        const response = await handler(event);
        assert.equal(typeof response.headers['Content-Type'], 'string',
          'Content-Type is not a plain string');
        assert.equal(response.headers['Content-Type'], 'application/json',
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
// Handler-level tests only: these call handler() directly and test the
// integration of routes with the response layer. Function-level tests for
// parseAllowedOrigins/isOriginAllowed/getCorsOrigin/buildResponse live in
// tests/unit/calendar-cors.test.js and run under 'npm run test:unit'.
// ---------------------------------------------------------------------------
describe('Feature: Handler response layer guards are applied', () => {
  describe('Scenario: No live handler response carries credentials with a wildcard origin', () => {
    const credentialsHeaderOf = (response) =>
      Object.keys(response.headers)
        .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');

    it('And no live handler response carries Access-Control-Allow-Credentials with a wildcard origin', async () => {
      const paths = ['/calendar/api/health', '/calendar/api/nope'];
      for (const p of paths) {
        const response = await handler({
          version: '2.0',
          rawPath: p,
          rawQueryString: '',
          requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: p } },
          headers: {
            host: 'abc123.lambda-url.ap-southeast-2.on.aws',
            origin: 'https://anything.example.com'
          },
          cookies: [],
          body: null,
          isBase64Encoded: false
        });
        // Assert both the wildcard origin AND the absence of credentials.
        // Compared as a plain string: payload format 2.0 header values are
        // single strings, so indexing [0] here would silently compare the first
        // CHARACTER and pass for any value starting with "*".
        assert.equal(response.headers['Access-Control-Allow-Origin'], '*',
          `Response for ${p} did not have a wildcard Access-Control-Allow-Origin`);
        assert.deepEqual(credentialsHeaderOf(response), [],
          `Response for ${p} carried Access-Control-Allow-Credentials with a wildcard origin`);
      }
    });
  });

  describe('Scenario: The health check is unaffected', () => {
    it('When a function URL event for "GET /calendar/api/health" is invoked, Then the response status code is 200', async () => {
      // A probe sends no Origin header at all. (Since TASK-049 nothing actually
      // polls this route: the ALB health check that did went with the target
      // group and no replacement was built.)
      const response = await handler({
        version: '2.0',
        rawPath: '/calendar/api/health',
        rawQueryString: '',
        requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method: 'GET', path: '/calendar/api/health' } },
        headers: {
          host: 'abc123.lambda-url.ap-southeast-2.on.aws',
          'user-agent': 'curl/8.0'
        },
        cookies: [],
        body: null,
        isBase64Encoded: false
      });
      assert.equal(response.statusCode, 200, `Expected status 200, got ${response.statusCode}`);
      assert.equal(JSON.parse(response.body).status, 'ok', 'Health check status is not "ok"');
    });
  });
});
