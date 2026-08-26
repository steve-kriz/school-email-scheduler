/**
 * calendar-settings-public-mail-routes.test.js - TASK-032 at the route boundary.
 *
 * The unit tests (tests/unit/calendar-settings-public-mail.test.js) pin the list
 * and the brand check entry by entry. These tests exist for one narrower question:
 * that a refused domain still comes back to the CLIENT as a 400 whose body names
 * the offending domain, on the real PUT route, so the settings form can tell the
 * user which entry it rejected.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import { handler } from '../../src/lambda/calendar/index.mjs';

import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from '../../src/lambda/calendar/backend/session.mjs';

describe('Settings routes - public mail blocklist (TASK-032)', () => {
  const sessionSecret = 'test-session-secret-must-be-32-bytes-long!!';

  const defaultEnv = {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
    SESSION_SECRET: sessionSecret,
    PUBLIC_BASE_URL: 'https://example.com',
    CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
    CALENDAR_KMS_KEY_ID:
      'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012',
    CALENDAR_LOG_LEVEL: 'none',
  };

  const testGoogleSub = 'test-user-google-sub-123';
  const testEmail = 'test@example.com';

  let originalLog, originalWarn, originalError;

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

  function makeSessionCookie() {
    const token = createSessionToken({ sub: testGoogleSub, email: testEmail }, { secret: sessionSecret });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  function makeEvent(body, cookie) {
    return {
      path: '/calendar/api/settings',
      httpMethod: 'PUT',
      headers: {},
      multiValueHeaders: cookie ? { cookie: [cookie] } : {},
      body: JSON.stringify(body),
      isBase64Encoded: false,
    };
  }

  /** PUT a single domain and return the parsed response. */
  async function putDomain(domain) {
    const response = await handler(
      makeEvent({ schoolName: 'St Marys Primary', searchDomains: [domain] }, makeSessionCookie()),
      {},
      { env: defaultEnv }
    );
    return { response, body: JSON.parse(response.body) };
  }

  it('should return 400 naming the domain for each consumer host TASK-032 found passing', async () => {
    const hosts = [
      'outlook.com.au',
      'yahoo.com.au',
      'hotmail.co.uk',
      'yahoo.co.uk',
      'live.com',
      'aol.com',
      'me.com',
      'proton.me',
      'gmx.com',
      'mail.com',
    ];

    for (const host of hosts) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should return 400 naming the domain for each Australian ISP/portal host (TASK-046)', async () => {
    const hosts = [
      'bigpond.com',
      'bigpond.net.au',
      'optusnet.com.au',
      'y7mail.com',
      'iinet.net.au',
      'tpg.com.au',
      'internode.on.net',
      'dodo.com.au',
    ];

    for (const host of hosts) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should still return 400 naming the domain for the six originally-blocked hosts', async () => {
    for (const host of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should return 400 naming the domain for a brand under an unlisted suffix', async () => {
    for (const host of ['hotmail.com.br', 'yahoo.example']) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should not refuse a school domain with a "mail" subdomain', async () => {
    const captured = [];
    const response = await handler(
      makeEvent(
        { schoolName: 'St Marys Primary', searchDomains: ['mail.stmarys.edu.au'] },
        makeSessionCookie()
      ),
      {},
      {
        env: defaultEnv,
        updateItem: async (params) => {
          captured.push(params);
          return {
            Attributes: {
              userId: `google:${testGoogleSub}`,
              email: testEmail,
              schoolName: 'St Marys Primary',
              searchDomains: new Set(['mail.stmarys.edu.au']),
            },
          };
        },
      }
    );

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.searchDomains, ['mail.stmarys.edu.au']);
    assert.equal(captured.length, 1);
  });

  it('should accept an Australian school domain unaffected by the ISP/portal entries (TASK-046)', async () => {
    const captured = [];
    const response = await handler(
      makeEvent(
        { schoolName: 'St Bedes College', searchDomains: ['stbedes.vic.edu.au'] },
        makeSessionCookie()
      ),
      {},
      {
        env: defaultEnv,
        updateItem: async (params) => {
          captured.push(params);
          return {
            Attributes: {
              userId: `google:${testGoogleSub}`,
              email: testEmail,
              schoolName: 'St Bedes College',
              searchDomains: new Set(['stbedes.vic.edu.au']),
            },
          };
        },
      }
    );

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.searchDomains, ['stbedes.vic.edu.au']);
    assert.equal(captured.length, 1);
  });

  it('should accept a qld.edu.au school domain (TASK-046: AC scope)', async () => {
    const captured = [];
    const response = await handler(
      makeEvent(
        { schoolName: 'Sunshine State School', searchDomains: ['example.qld.edu.au'] },
        makeSessionCookie()
      ),
      {},
      {
        env: defaultEnv,
        updateItem: async (params) => {
          captured.push(params);
          return {
            Attributes: {
              userId: `google:${testGoogleSub}`,
              email: testEmail,
              schoolName: 'Sunshine State School',
              searchDomains: new Set(['example.qld.edu.au']),
            },
          };
        },
      }
    );

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.searchDomains, ['example.qld.edu.au']);
    assert.equal(captured.length, 1);
  });

  it('internode.on.net must be refused by exact-match check before registrableName is consulted (TASK-046)', async () => {
    // Verifies the coder's claim: registrableName("internode.on.net") would return
    // { name: "on", subdomain: true }, but the exact-match check catches it first.
    // This test ensures that if someone ever reorders the checks, internode.on.net
    // would silently fail to be refused. By making this explicit, we pin that ordering.
    const { response, body } = await putDomain('internode.on.net');
    assert.equal(response.statusCode, 400, 'internode.on.net must be refused');
    assert.ok(body.error.includes('internode.on.net'), 'error must name internode.on.net');
  });

  it('should refuse mixed-case blocked domains and report the normalised form', async () => {
    const { response, body } = await putDomain('OUTLOOK.COM.AU');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'searchDomains');
    assert.ok(body.error.includes('outlook.com.au'), 'should name normalised form, not the input');
  });

  it('should refuse email address form and report normalised domain', async () => {
    const { response, body } = await putDomain('user@yahoo.com.au');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'searchDomains');
    assert.ok(body.error.includes('yahoo.com.au'), 'should name the domain extracted from address');
  });

  it('should refuse URL form and report normalised domain', async () => {
    const { response, body } = await putDomain('https://gmail.com/login');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'searchDomains');
    assert.ok(body.error.includes('gmail.com'), 'should name the domain extracted from URL');
  });

  it('should accept school domains with brand-like names in subdomain', async () => {
    const captured = [];
    const response = await handler(
      makeEvent(
        {
          schoolName: 'School Districts',
          searchDomains: ['livewire.edu.au', 'mailroom.vic.edu.au', 'live.qld.edu.au'],
        },
        makeSessionCookie()
      ),
      {},
      {
        env: defaultEnv,
        updateItem: async (params) => {
          captured.push(params);
          return {
            Attributes: {
              userId: `google:${testGoogleSub}`,
              email: testEmail,
              schoolName: 'School Districts',
              searchDomains: new Set(['livewire.edu.au', 'mailroom.vic.edu.au', 'live.qld.edu.au']),
            },
          };
        },
      }
    );

    assert.equal(response.statusCode, 200, 'should accept school domains with brand-like words');
    const body = JSON.parse(response.body);
    assert.equal(body.searchDomains.length, 3);
    assert.ok(body.searchDomains.includes('livewire.edu.au'));
    assert.ok(body.searchDomains.includes('mailroom.vic.edu.au'));
    assert.ok(body.searchDomains.includes('live.qld.edu.au'));
  });

  it('should refuse brand-only domains under uncommon suffixes', async () => {
    const hosts = [
      'gmail.co.uk',
      'hotmail.xyz',
      'yahoo.io',
      'outlook.net',
    ];

    for (const host of hosts) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused by brand check`);
      assert.equal(body.field, 'searchDomains');
      assert.ok(body.error.includes(host), `should name ${host} in error message`);
    }
  });

  it('should refuse wildcard patterns after normalisation', async () => {
    const { response, body } = await putDomain('*.hotmail.com');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'searchDomains');
    assert.ok(body.error.includes('hotmail.com'), 'should name the normalised domain');
  });

  it('should normalise whitespace around domains', async () => {
    const { response, body } = await putDomain('  gmail.com  ');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'searchDomains');
    assert.ok(body.error.includes('gmail.com'));
  });
});
