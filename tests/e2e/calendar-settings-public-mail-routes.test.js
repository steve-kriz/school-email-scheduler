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

import { REMOVE_ATTRIBUTE } from '../../src/lambda/calendar/backend/connections.mjs';

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

  /** A Lambda function URL event (payload format 2.0, TASK-049). */
  function makeEvent(body, cookie) {
    return {
      version: '2.0',
      rawPath: '/calendar/api/settings',
      rawQueryString: '',
      headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
      cookies: cookie ? [cookie] : [],
      requestContext: {
        domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
        http: { method: 'PUT', path: '/calendar/api/settings' },
      },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    };
  }

  /**
   * TASK-055 moved the request contract to `processingJobs`: one domain now lives
   * on one job, so a refused domain is reported under the INDEXED field name
   * `processingJobs[<index>].domains` rather than the collection name (TASK-059 pluralised the key).
   */
  const DOMAIN_FIELD = 'processingJobs[0].domains';

  /** One valid processing job carrying the domain under test. */
  function jobWith(domain, overrides = {}) {
    return {
      name: 'Newsletters',
      schoolName: 'St Marys Primary',
      domains: [domain],
      searchTerms: [],
      ...overrides,
    };
  }

  /** PUT a single domain and return the parsed response. */
  async function putDomain(domain) {
    const response = await handler(
      makeEvent({ processingJobs: [jobWith(domain)] }, makeSessionCookie()),
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
      assert.equal(body.field, DOMAIN_FIELD);
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
      assert.equal(body.field, DOMAIN_FIELD);
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should still return 400 naming the domain for the six originally-blocked hosts', async () => {
    for (const host of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, DOMAIN_FIELD);
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  it('should return 400 naming the domain for a brand under an unlisted suffix', async () => {
    for (const host of ['hotmail.com.br', 'yahoo.example']) {
      const { response, body } = await putDomain(host);
      assert.equal(response.statusCode, 400, `${host} should be refused`);
      assert.equal(body.field, DOMAIN_FIELD);
      assert.ok(body.error.includes(host), `body should name ${host}, got "${body.error}"`);
    }
  });

  /**
   * Drive an ACCEPTED PUT. The injected `updateItem` is the ONLY database seam
   * and never opens a connection: it decodes the compiled UpdateExpression's
   * value map and echoes the SET attributes back as the stored row.
   */
  async function putJobs(jobs) {
    const captured = [];
    const response = await handler(
      makeEvent({ processingJobs: jobs }, makeSessionCookie()),
      {},
      {
        env: defaultEnv,
        updateItem: async ({ tableName, key, updates }) => {
          captured.push({ tableName, key, updates });
          const row = { userId: `google:${testGoogleSub}`, email: testEmail };
          for (const [attribute, value] of Object.entries(updates || {})) {
            if (value === REMOVE_ATTRIBUTE) delete row[attribute];
            else row[attribute] = value;
          }
          return row;
        },
      }
    );
    return { response, body: JSON.parse(response.body), captured };
  }

  it('should not refuse a school domain with a "mail" subdomain', async () => {
    const { response, body, captured } = await putJobs([jobWith('mail.stmarys.edu.au')]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.processingJobs.flatMap((job) => job.domains),
      ['mail.stmarys.edu.au']
    );
    assert.equal(captured.length, 1);
  });

  it('should accept an Australian school domain unaffected by the ISP/portal entries (TASK-046)', async () => {
    const { response, body, captured } = await putJobs([
      jobWith('stbedes.vic.edu.au', { schoolName: 'St Bedes College' }),
    ]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.processingJobs.flatMap((job) => job.domains),
      ['stbedes.vic.edu.au']
    );
    assert.equal(captured.length, 1);
  });

  it('should accept a qld.edu.au school domain (TASK-046: AC scope)', async () => {
    const { response, body, captured } = await putJobs([
      jobWith('example.qld.edu.au', { schoolName: 'Sunshine State School' }),
    ]);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.processingJobs.flatMap((job) => job.domains),
      ['example.qld.edu.au']
    );
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
    assert.equal(body.field, DOMAIN_FIELD);
    assert.ok(body.error.includes('outlook.com.au'), 'should name normalised form, not the input');
  });

  it('should refuse email address form and report normalised domain', async () => {
    const { response, body } = await putDomain('user@yahoo.com.au');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, DOMAIN_FIELD);
    assert.ok(body.error.includes('yahoo.com.au'), 'should name the domain extracted from address');
  });

  it('should refuse URL form and report normalised domain', async () => {
    const { response, body } = await putDomain('https://gmail.com/login');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, DOMAIN_FIELD);
    assert.ok(body.error.includes('gmail.com'), 'should name the domain extracted from URL');
  });

  it('should accept school domains with brand-like names in subdomain', async () => {
    // One domain per job now (TASK-055), so three domains are three jobs - which
    // is the shape a multi-domain user saves in from here on.
    const { response, body } = await putJobs([
      jobWith('livewire.edu.au', { name: 'Livewire', schoolName: 'School Districts' }),
      jobWith('mailroom.vic.edu.au', { name: 'Mailroom', schoolName: 'School Districts' }),
      jobWith('live.qld.edu.au', { name: 'Live QLD', schoolName: 'School Districts' }),
    ]);

    assert.equal(response.statusCode, 200, 'should accept school domains with brand-like words');
    const domains = body.processingJobs.flatMap((job) => job.domains);
    assert.equal(domains.length, 3);
    assert.ok(domains.includes('livewire.edu.au'));
    assert.ok(domains.includes('mailroom.vic.edu.au'));
    assert.ok(domains.includes('live.qld.edu.au'));
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
      assert.equal(body.field, DOMAIN_FIELD);
      assert.ok(body.error.includes(host), `should name ${host} in error message`);
    }
  });

  it('should refuse wildcard patterns after normalisation', async () => {
    const { response, body } = await putDomain('*.hotmail.com');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, DOMAIN_FIELD);
    assert.ok(body.error.includes('hotmail.com'), 'should name the normalised domain');
  });

  it('should normalise whitespace around domains', async () => {
    const { response, body } = await putDomain('  gmail.com  ');
    assert.equal(response.statusCode, 400);
    assert.equal(body.field, DOMAIN_FIELD);
    assert.ok(body.error.includes('gmail.com'));
  });
});
