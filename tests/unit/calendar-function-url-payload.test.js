/**
 * calendar-function-url-payload.test.js — TASK-049 unit tests.
 *
 * The units that changed when the app moved from the shared ALB to its own
 * Lambda function URL, tested in isolation from the router:
 *
 *   - `resolvePublicBaseUrl` — the origin the app is served on, now derived per
 *     request instead of read from an env var.
 *   - `isPayloadFormatV2` / `getQueryParam` — whether query values still need
 *     percent-decoding. Format 2.0 decodes them for us; decoding twice corrupts
 *     any value containing a "%".
 *   - `buildResponse` — the response shape: single-value `headers` plus a
 *     `cookies` array, with `Set-Cookie` split out.
 *   - `getCookies` — reading cookies from format 2.0's top-level array.
 *   - `isScheduledScanEvent` — telling an EventBridge schedule apart from an
 *     HTTP request now that HTTP requests carry neither `path` nor `httpMethod`.
 *
 * Everything here is pure. No DynamoDB, KMS or network client is constructed
 * anywhere in this file, and no test opens a database connection.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  resolvePublicBaseUrl,
  isPayloadFormatV2,
  getQueryParam,
  buildResponse,
  jsonResponse,
  finalise,
} from '../../src/lambda/calendar/index.mjs';
import { getCookies, getCookie, SESSION_COOKIE_NAME } from '../../src/lambda/calendar/backend/session.mjs';
import { isScheduledScanEvent, SCAN_SCHEDULED_SOURCE } from '../../src/lambda/calendar/backend/scan-schedule.mjs';

const FN_HOST = 'k7q2xexample.lambda-url.ap-southeast-2.on.aws';

/** A minimal payload-format-2.0 event. */
function v2Event(overrides = {}) {
  return {
    version: '2.0',
    rawPath: '/calendar/api/health',
    rawQueryString: '',
    headers: { host: FN_HOST },
    cookies: [],
    requestContext: { domainName: FN_HOST, http: { method: 'GET', path: '/calendar/api/health' } },
    ...overrides,
  };
}

describe('Unit: resolvePublicBaseUrl (TASK-049)', () => {
  describe('Feature: the origin is derived from the request that arrived', () => {
    it('Given an empty PUBLIC_BASE_URL, Then the origin comes from requestContext.domainName over https', () => {
      assert.equal(resolvePublicBaseUrl(v2Event(), { PUBLIC_BASE_URL: '' }), `https://${FN_HOST}`);
    });

    it('And an entirely absent PUBLIC_BASE_URL behaves the same as an empty one', () => {
      assert.equal(resolvePublicBaseUrl(v2Event(), {}), `https://${FN_HOST}`);
    });

    it('And requestContext.domainName wins over the host header, because the Lambda service sets it rather than the client', () => {
      const event = v2Event({ headers: { host: 'spoofed.example.com' } });
      assert.equal(resolvePublicBaseUrl(event, {}), `https://${FN_HOST}`);
    });

    it('And the host header is used when there is no requestContext.domainName', () => {
      const event = v2Event({ requestContext: { http: { method: 'GET', path: '/x' } } });
      assert.equal(resolvePublicBaseUrl(event, {}), `https://${FN_HOST}`);
    });

    it('And x-forwarded-proto is honoured, so a local proxy can serve http', () => {
      const event = v2Event({
        headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' },
        requestContext: { http: { method: 'GET', path: '/x' } },
      });
      assert.equal(resolvePublicBaseUrl(event, {}), 'http://localhost:3000');
    });

    it('And an unrecognised x-forwarded-proto falls back to https rather than building a nonsense scheme', () => {
      const event = v2Event({
        headers: { host: FN_HOST, 'x-forwarded-proto': 'gopher' },
        requestContext: { http: { method: 'GET', path: '/x' } },
      });
      assert.equal(resolvePublicBaseUrl(event, {}), `https://${FN_HOST}`);
    });
  });

  describe('Feature: an explicit configuration always wins', () => {
    it('Given PUBLIC_BASE_URL is set, Then it overrides the derived host', () => {
      assert.equal(
        resolvePublicBaseUrl(v2Event(), { PUBLIC_BASE_URL: 'http://localhost:3000' }),
        'http://localhost:3000'
      );
    });

    it('And a trailing slash is trimmed, so the callback path is not double-slashed', () => {
      assert.equal(
        resolvePublicBaseUrl(v2Event(), { PUBLIC_BASE_URL: 'https://calendar.example.com///' }),
        'https://calendar.example.com'
      );
    });

    it('And surrounding whitespace is trimmed', () => {
      assert.equal(
        resolvePublicBaseUrl(v2Event(), { PUBLIC_BASE_URL: '  https://calendar.example.com  ' }),
        'https://calendar.example.com'
      );
    });
  });

  describe('Feature: FAILURE PATH - a hostile Host header cannot inject into a URL we build', () => {
    // The only thing built from this value is the Google redirect_uri. Google
    // refuses any redirect_uri not registered on the client, so a spoofed host
    // cannot redirect a code anywhere; the pattern check exists so path or query
    // text cannot be injected into a URL this code constructs.
    const hostileHosts = [
      'evil.com/../../path',
      'evil.com?query=1',
      'evil.com#fragment',
      'evil.com\\backslash',
      'evil.com /space',
      'evil.com"quote',
      'evil.com:notaport',
    ];

    for (const host of hostileHosts) {
      it(`Given a Host header of ${JSON.stringify(host)}, Then the derived origin is "" rather than a malformed URL`, () => {
        const event = v2Event({
          headers: { host },
          requestContext: { http: { method: 'GET', path: '/x' } },
        });
        assert.equal(resolvePublicBaseUrl(event, {}), '',
          'a host that is not a plain hostname must resolve to "", so the route reports "not configured"');
      });
    }

    it('And a legitimate host:port is still accepted', () => {
      const event = v2Event({
        headers: { host: 'localhost:3000' },
        requestContext: { http: { method: 'GET', path: '/x' } },
      });
      assert.equal(resolvePublicBaseUrl(event, {}), 'https://localhost:3000');
    });

    it('And an event with no host at all resolves to ""', () => {
      assert.equal(resolvePublicBaseUrl({}, {}), '');
      assert.equal(resolvePublicBaseUrl(null, {}), '');
    });
  });
});

describe('Unit: payload format detection and query reading (TASK-049)', () => {
  describe('Feature: isPayloadFormatV2 classifies by shape as well as by version', () => {
    it('Given version "2.0", Then it is format 2.0', () => {
      assert.equal(isPayloadFormatV2({ version: '2.0' }), true);
    });

    it('And a rawPath alone is enough, so a fixture omitting version is still classified correctly', () => {
      assert.equal(isPayloadFormatV2({ rawPath: '/calendar' }), true);
    });

    it('And a rawQueryString alone is enough', () => {
      assert.equal(isPayloadFormatV2({ rawQueryString: 'a=b' }), true);
    });

    it('FAILURE PATH: an ALB-shaped event is NOT format 2.0, so its query values are still decoded', () => {
      assert.equal(isPayloadFormatV2({ path: '/calendar', httpMethod: 'GET' }), false);
      assert.equal(isPayloadFormatV2({}), false);
      assert.equal(isPayloadFormatV2(null), false);
    });
  });

  describe('Feature: getQueryParam does not double-decode format 2.0 values', () => {
    it('Given a format 2.0 code containing "/" and "+", Then the value is returned byte-identical', () => {
      const code = '4/0AeanS0Y+slash/and%2Bplus';
      const event = v2Event({ queryStringParameters: { code } });
      assert.equal(getQueryParam(event, 'code'), code);
    });

    it('And a bare percent sequence survives, which a second decode would corrupt or throw on', () => {
      const event = v2Event({ queryStringParameters: { state: '100%25sure%2F' } });
      assert.equal(getQueryParam(event, 'state'), '100%25sure%2F');
    });

    it('And a missing parameter is null', () => {
      assert.equal(getQueryParam(v2Event({ queryStringParameters: {} }), 'code'), null);
      assert.equal(getQueryParam(v2Event(), 'code'), null);
    });

    it('FAILURE PATH: an ALB-shaped event IS still decoded, so no ALB caller regresses', () => {
      const albEvent = {
        path: '/calendar',
        httpMethod: 'GET',
        queryStringParameters: { code: '4%2F0AeanS0Y' },
      };
      assert.equal(getQueryParam(albEvent, 'code'), '4/0AeanS0Y');
    });
  });
});

describe('Unit: buildResponse emits payload format 2.0 (TASK-049)', () => {
  describe('Feature: the response shape a function URL can actually read', () => {
    it('Given any response, Then it has statusCode, a headers map, a cookies array and no ALB fields', () => {
      const response = buildResponse(200, '{}');
      assert.equal(response.statusCode, 200);
      assert.equal(typeof response.headers, 'object');
      assert.ok(Array.isArray(response.cookies));
      assert.equal(response.multiValueHeaders, undefined,
        'multiValueHeaders is silently ignored by a function URL and must not be emitted');
      assert.equal(response.statusDescription, undefined,
        'statusDescription is silently ignored by a function URL and must not be emitted');
      assert.equal(response.isBase64Encoded, false);
    });

    it('And every header value is a single string, never an array', () => {
      const response = buildResponse(200, '{}', 'application/json');
      for (const [name, value] of Object.entries(response.headers)) {
        assert.equal(typeof value, 'string', `header ${name} is not a string`);
      }
      assert.equal(response.headers['Content-Type'], 'application/json');
    });

    it('And a caller-supplied array header is folded onto one comma-joined line', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        headers: { 'X-Thing': ['a', 'b'] },
      });
      assert.equal(response.headers['X-Thing'], 'a, b');
    });
  });

  describe('Feature: Set-Cookie is split into the cookies array', () => {
    it('Given two Set-Cookie values, Then both land in cookies and neither stays in headers', () => {
      const response = buildResponse(302, '', 'text/plain', {
        headers: { 'Set-Cookie': ['a=1; HttpOnly', 'b=2; Secure'] },
      });
      assert.deepEqual(response.cookies, ['a=1; HttpOnly', 'b=2; Secure']);
      for (const name of Object.keys(response.headers)) {
        assert.notEqual(name.toLowerCase(), 'set-cookie');
      }
    });

    it('And a single string Set-Cookie is still moved into the array', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        headers: { 'Set-Cookie': 'a=1' },
      });
      assert.deepEqual(response.cookies, ['a=1']);
    });

    it('And the header name is matched case-insensitively, because HTTP header names are', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        headers: { 'set-cookie': ['a=1'] },
      });
      assert.deepEqual(response.cookies, ['a=1']);
      assert.equal(response.headers['set-cookie'], undefined);
    });

    it('FAILURE PATH: empty and nullish cookie values are dropped rather than emitted as blank Set-Cookie lines', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        headers: { 'Set-Cookie': ['a=1', '', null, undefined, 'b=2'] },
      });
      assert.deepEqual(response.cookies, ['a=1', 'b=2']);
    });

    it('And two cookies are never folded onto one line, which would produce one corrupt cookie instead of two', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        headers: { 'Set-Cookie': ['a=1; Path=/calendar', 'b=2; Path=/calendar'] },
      });
      assert.equal(response.cookies.length, 2);
      assert.ok(!response.cookies.some((c) => c.includes(', ')),
        'a cookie value was comma-folded');
    });
  });

  describe('Feature: the wildcard-credentials invariant survives the shape change', () => {
    it('Given the resolved origin is "*", Then Access-Control-Allow-Credentials is stripped from the headers map', () => {
      const response = buildResponse(200, '{}', 'application/json', {
        origin: 'https://anything.example.com',
        allowlist: [],
        headers: { 'Access-Control-Allow-Credentials': 'true' },
      });
      assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
      assert.deepEqual(
        Object.keys(response.headers).filter((n) => n.toLowerCase() === 'access-control-allow-credentials'),
        []
      );
    });

    it('And jsonResponse inherits the same strip', () => {
      const response = jsonResponse(200, { ok: true }, {
        origin: 'https://anything.example.com',
        allowlist: [],
        headers: { 'access-control-allow-credentials': 'true' },
      });
      assert.deepEqual(
        Object.keys(response.headers).filter((n) => n.toLowerCase() === 'access-control-allow-credentials'),
        []
      );
    });

    it('And finalise strips it from a hand-rolled format 2.0 response that never went through buildResponse', () => {
      const hand = {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': 'true',
        },
        cookies: [],
        body: '{}',
      };
      const finalised = finalise(hand);
      assert.deepEqual(
        Object.keys(finalised.headers).filter((n) => n.toLowerCase() === 'access-control-allow-credentials'),
        []
      );
    });
  });
});

describe('Unit: getCookies reads the format 2.0 cookies array (TASK-049)', () => {
  it('Given a cookies array, Then each "name=value" entry is parsed', () => {
    const event = v2Event({ cookies: [`${SESSION_COOKIE_NAME}=abc`, 'other=xyz'] });
    assert.deepEqual(getCookies(event), { [SESSION_COOKIE_NAME]: 'abc', other: 'xyz' });
    assert.equal(getCookie(event, SESSION_COOKIE_NAME), 'abc');
  });

  it('And a cookie value containing "=" (base64 padding, JWT-ish tokens) is not truncated', () => {
    const event = v2Event({ cookies: [`${SESSION_COOKIE_NAME}=a.b.c==`] });
    assert.equal(getCookie(event, SESSION_COOKIE_NAME), 'a.b.c==');
  });

  it('And a real cookies array wins over a Cookie header, so the format 2.0 source is authoritative', () => {
    const event = v2Event({
      cookies: [`${SESSION_COOKIE_NAME}=from-array`],
      headers: { host: FN_HOST, cookie: `${SESSION_COOKIE_NAME}=from-header` },
    });
    assert.equal(getCookie(event, SESSION_COOKIE_NAME), 'from-array');
  });

  it('And a plain Cookie header is still read when the cookies array is empty', () => {
    const event = v2Event({
      cookies: [],
      headers: { host: FN_HOST, Cookie: `${SESSION_COOKIE_NAME}=from-header` },
    });
    assert.equal(getCookie(event, SESSION_COOKIE_NAME), 'from-header');
  });

  it('FAILURE PATH: an event with neither yields no cookies rather than throwing', () => {
    assert.deepEqual(getCookies(v2Event({ cookies: [] })), {});
    assert.deepEqual(getCookies({}), {});
    assert.equal(getCookie(v2Event({ cookies: [] }), SESSION_COOKIE_NAME), null);
  });
});

describe('Unit: isScheduledScanEvent excludes BOTH request shapes (TASK-049)', () => {
  it('Given a scheduler payload carrying only source and userId, Then it is a scheduled scan', () => {
    assert.equal(isScheduledScanEvent({ source: SCAN_SCHEDULED_SOURCE, userId: 'google#1' }), true);
  });

  it('Scenario: An HTTP request is never mistaken for a scheduled scan — a format 2.0 event carrying "source" returns false', () => {
    // Format 2.0 has NO httpMethod and NO path, so excluding only those two
    // would classify this real browser request as a schedule: it would be
    // answered with a bare result object (blank page) and no scan would run.
    const event = v2Event();
    event.source = SCAN_SCHEDULED_SOURCE;
    assert.equal(isScheduledScanEvent(event), false);
  });

  it('And rawPath alone is enough to disqualify it', () => {
    assert.equal(
      isScheduledScanEvent({ source: SCAN_SCHEDULED_SOURCE, rawPath: '/calendar/api/health' }),
      false
    );
  });

  it('And requestContext alone is enough to disqualify it', () => {
    assert.equal(
      isScheduledScanEvent({ source: SCAN_SCHEDULED_SOURCE, requestContext: { http: { method: 'GET' } } }),
      false
    );
  });

  it('And the ALB fields still disqualify it, so no previously-correct behaviour regressed', () => {
    assert.equal(isScheduledScanEvent({ source: SCAN_SCHEDULED_SOURCE, httpMethod: 'GET' }), false);
    assert.equal(isScheduledScanEvent({ source: SCAN_SCHEDULED_SOURCE, path: '/calendar' }), false);
  });

  it('FAILURE PATH: a different source is not a scheduled scan even with no request fields at all', () => {
    assert.equal(isScheduledScanEvent({ source: 'aws.events' }), false);
    assert.equal(isScheduledScanEvent({}), false);
    assert.equal(isScheduledScanEvent(null), false);
    assert.equal(isScheduledScanEvent('scheduled-scan'), false);
  });
});
