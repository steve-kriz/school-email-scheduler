import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// Import the handler from the actual source
const handlerPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
const handlerUrl = new URL(`file:///${handlerPath.replace(/\\/g, '/')}`).href;
const {
  buildResponse,
  jsonResponse,
  getCorsOrigin,
  isOriginAllowed,
  parseAllowedOrigins,
  coerceAllowlist,
  finalise,
  ALLOWED_ORIGINS
} = await import(handlerUrl);

describe('Unit Tests: CORS Origin Gate', () => {
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
        assert.equal(response.headers['Access-Control-Allow-Origin'], undefined,
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
        assert.equal(response.headers['Access-Control-Allow-Origin'], undefined,
          'A lookalike origin was echoed in Access-Control-Allow-Origin');
      });
    });

    describe('Scenario: Credentials are never paired with a wildcard origin', () => {
      const credentialsHeaderOf = (response) =>
        Object.keys(response.headers)
          .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');

      it('Given ALLOWED_ORIGINS is unset, When any response is built, Then it does not carry Access-Control-Allow-Credentials', () => {
        const response = buildResponse(200, '{}', 'application/json', { origin: 'https://anything.example.com', allowlist: OPEN });
        assert.equal(response.headers['Access-Control-Allow-Origin'], '*',
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
        assert.equal(response.headers['Access-Control-Allow-Origin'], '*',
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
        assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://officehq.com.au',
          'An allowed origin was not echoed back');
        // Payload format 2.0 folds array header values to a single string.
        assert.equal(response.headers['Access-Control-Allow-Credentials'], 'true',
          'Credentials were stripped for a specifically allowed (non-wildcard) origin');
      });
    });

    describe('Scenario: An echoed origin is accompanied by Vary: Origin', () => {
      it('When an allowed subdomain origin is echoed, Then Vary: Origin is set so caches do not cross-serve it', () => {
        const response = buildResponse(200, '{}', 'application/json', {
          origin: 'https://sub.officehq.com.au',
          allowlist: OFFICEHQ
        });
        assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://sub.officehq.com.au',
          'An allowed subdomain origin was not echoed back');
        assert.equal(response.headers['Vary'], 'Origin',
          'Vary: Origin was not set alongside an echoed origin');
      });
    });
  });

  // AC1: Handle null, non-array, and undefined allowlist without throwing
  describe('Feature: Allowlist coercion handles malformed inputs', () => {
    describe('Scenario Outline: A malformed allowlist does not throw', () => {
      it('Given an allowlist of null, When the cors origin is resolved, Then a defined result is returned and no error is thrown', () => {
        let threw = false;
        let result;
        try {
          result = getCorsOrigin('https://anything.example.com', null);
        } catch (e) {
          threw = true;
        }
        assert.equal(threw, false, 'getCorsOrigin threw with a null allowlist');
        assert.ok(result !== undefined, 'getCorsOrigin returned undefined with a null allowlist');
      });

      it('Given an allowlist of a string, When the cors origin is resolved, Then a defined result is returned and no error is thrown', () => {
        let threw = false;
        let result;
        try {
          result = getCorsOrigin('https://anything.example.com', 'officehq.com.au');
        } catch (e) {
          threw = true;
        }
        assert.equal(threw, false, 'getCorsOrigin threw with a string allowlist');
        assert.ok(result !== undefined, 'getCorsOrigin returned undefined with a string allowlist');
      });

      it('Given an allowlist of a number, When the cors origin is resolved, Then a defined result is returned and no error is thrown', () => {
        let threw = false;
        let result;
        try {
          result = getCorsOrigin('https://anything.example.com', 123);
        } catch (e) {
          threw = true;
        }
        assert.equal(threw, false, 'getCorsOrigin threw with a number allowlist');
        assert.ok(result !== undefined, 'getCorsOrigin returned undefined with a number allowlist');
      });

      it('Given an allowlist of an object, When the cors origin is resolved, Then a defined result is returned and no error is thrown', () => {
        let threw = false;
        let result;
        try {
          result = getCorsOrigin('https://anything.example.com', { domains: ['officehq.com.au'] });
        } catch (e) {
          threw = true;
        }
        assert.equal(threw, false, 'getCorsOrigin threw with an object allowlist');
        assert.ok(result !== undefined, 'getCorsOrigin returned undefined with an object allowlist');
      });

      it('Given an allowlist of undefined, When the cors origin is resolved, Then a defined result is returned and no error is thrown', () => {
        let threw = false;
        let result;
        try {
          result = getCorsOrigin('https://anything.example.com', undefined);
        } catch (e) {
          threw = true;
        }
        assert.equal(threw, false, 'getCorsOrigin threw with undefined allowlist');
        assert.ok(result !== undefined, 'getCorsOrigin returned undefined with undefined allowlist');
      });
    });

    // AC2 & AC3: Pin the fallback (ALLOWED_ORIGINS, NOT [])
    describe('Scenario: A malformed allowlist falls back to the module constant, not to open mode', () => {
      it('When coerceAllowlist receives null, Then it returns the module ALLOWED_ORIGINS constant', () => {
        const result = coerceAllowlist(null);
        assert.strictEqual(result, ALLOWED_ORIGINS, 'coerceAllowlist(null) did not return ALLOWED_ORIGINS');
      });

      it('When coerceAllowlist receives a string, Then it returns the module ALLOWED_ORIGINS constant', () => {
        const result = coerceAllowlist('officehq.com.au');
        assert.strictEqual(result, ALLOWED_ORIGINS, 'coerceAllowlist(string) did not return ALLOWED_ORIGINS');
      });

      it('When coerceAllowlist receives a number, Then it returns the module ALLOWED_ORIGINS constant', () => {
        const result = coerceAllowlist(123);
        assert.strictEqual(result, ALLOWED_ORIGINS, 'coerceAllowlist(number) did not return ALLOWED_ORIGINS');
      });

      it('When coerceAllowlist receives an object, Then it returns the module ALLOWED_ORIGINS constant', () => {
        const result = coerceAllowlist({ domains: [] });
        assert.strictEqual(result, ALLOWED_ORIGINS, 'coerceAllowlist(object) did not return ALLOWED_ORIGINS');
      });

      it('When coerceAllowlist receives undefined, Then it returns the module ALLOWED_ORIGINS constant', () => {
        const result = coerceAllowlist(undefined);
        assert.strictEqual(result, ALLOWED_ORIGINS, 'coerceAllowlist(undefined) did not return ALLOWED_ORIGINS');
      });

      it('When coerceAllowlist receives an array, Then it returns that array unchanged', () => {
        const testArray = ['officehq.com.au', 'example.com'];
        const result = coerceAllowlist(testArray);
        assert.strictEqual(result, testArray, 'coerceAllowlist(array) did not return the same array');
      });

      it('And empty array still means open mode', () => {
        const result = getCorsOrigin('https://anything.example.com', []);
        assert.equal(result, '*', 'Empty allowlist did not resolve to "*"');
      });
    });
  });

  // AC4 & AC5: Hand-rolled response cannot pair credentials with wildcard
  describe('Feature: The router-level finalise choke point guards all responses', () => {
    describe('Scenario: A hand-rolled raw response cannot emit Access-Control-Allow-Credentials with a wildcard origin', () => {
      it('Given a route that returns a raw response object carrying Allow-Credentials, And the resolved origin is "*", When the response leaves the router via finalise, Then it does not carry Access-Control-Allow-Credentials', () => {
        const rawResponse = {
          statusCode: 200,
          headers: {
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          },
          body: '{}',
          isBase64Encoded: false
        };

        const finalised = finalise(rawResponse);

        // Confirm the wildcard origin is present
        assert.equal(finalised.headers['Access-Control-Allow-Origin'], '*',
          'Wildcard origin was not present in the hand-rolled response');

        // Confirm credentials header was stripped
        const credentialsHeaders = Object.keys(finalised.headers)
          .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');
        assert.deepEqual(credentialsHeaders, [],
          'finalise did not strip Access-Control-Allow-Credentials from a wildcard-origin response');
      });

      it('And the header-name variant is case-insensitive', () => {
        const rawResponse = {
          statusCode: 200,
          headers: {
            'access-control-allow-credentials': 'true',
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          },
          body: '{}',
          isBase64Encoded: false
        };

        const finalised = finalise(rawResponse);

        // Confirm wildcard origin is present
        assert.equal(finalised.headers['Access-Control-Allow-Origin'], '*',
          'Wildcard origin was not present');

        // Confirm lowercase credentials header was stripped
        const credentialsHeaders = Object.keys(finalised.headers)
          .filter((name) => name.toLowerCase() === 'access-control-allow-credentials');
        assert.deepEqual(credentialsHeaders, [],
          'finalise did not strip lowercase access-control-allow-credentials from a wildcard-origin response');
      });

      it('But finalise leaves credentials intact when the origin is not a wildcard', () => {
        const rawResponse = {
          statusCode: 200,
          // Array values are deliberately kept here: `finalise` documents that it
          // tolerates them, because a hand-rolled response never went through
          // buildResponse's flattening.
          headers: {
            'Access-Control-Allow-Credentials': ['true'],
            'Access-Control-Allow-Origin': ['https://officehq.com.au'],
            'Content-Type': ['application/json']
          },
          body: '{}',
          isBase64Encoded: false
        };

        const finalised = finalise(rawResponse);

        assert.deepEqual(finalised.headers['Access-Control-Allow-Credentials'], ['true'],
          'finalise stripped credentials when the origin was not a wildcard');
      });

      it('And finalise handles a null/missing headers map gracefully', () => {
        const rawResponse = {
          statusCode: 200,
          body: '{}',
          isBase64Encoded: false
        };

        let threw = false;
        let result;
        try {
          result = finalise(rawResponse);
        } catch (e) {
          threw = true;
        }

        assert.equal(threw, false, 'finalise threw when the headers map was missing');
        assert.ok(result, 'finalise returned falsy value');
      });
    });
  });
});
