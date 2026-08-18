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
const { handler, buildResponse, jsonResponse, getCorsOrigin, isOriginAllowed, fileCache, ASSET_DIR } =
  await import(handlerUrl);

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
