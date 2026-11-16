/**
 * task-059-multiple-domains-flow.test.js - TASK-059 END-TO-END (Gherkin) scenarios.
 *
 * One `describe` per scenario in the ticket's "Cucumber Tests" feature file,
 * with Given/When/Then test names. These are scenario-style `node --test` cases:
 * no cucumber package is used or needed.
 *
 * Background (applies to every scenario below):
 *   Given a signed-in user with a stored Gmail connection
 *   And the settings validator mints ids from a stubbed generator
 *
 * NO DATABASE. Every DynamoDB seam is injected: `getConnection` answers a plain
 * object literal in the shape a stored row arrives in, and `updateItem` records
 * the compiled patch and echoes it back. Nothing here constructs a DynamoDB
 * client, reads AWS credentials or touches the network. Gmail and Anthropic are
 * stubbed at their outermost I/O seams (`fetchImpl`, `createMessage`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { handler } from '../../src/lambda/calendar/index.mjs';
import { SESSION_COOKIE_NAME, createSessionToken } from '../../src/lambda/calendar/backend/session.mjs';
import { connectionUserId, REMOVE_ATTRIBUTE } from '../../src/lambda/calendar/backend/connections.mjs';
import { validateProcessingJobs, buildConnectionPatch } from '../../src/lambda/calendar/backend/settings.mjs';
import { buildJobClauses, buildJobQuery, hasJobQueryClauses } from '../../src/lambda/calendar/backend/gmail.mjs';
import { toProcessingJobs, runScan, SCAN_JOB_STATUS } from '../../src/lambda/calendar/backend/scan.mjs';

const SESSION_SECRET = 'test-session-secret-must-be-32-bytes-long!!';
const GOOGLE_SUB = 'test-user-google-sub-123';
const USER = connectionUserId(GOOGLE_SUB);
const EMAIL = 'parent@example.com';
const TABLE = 'test-calendar-events';

const ENV = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
  SESSION_SECRET,
  PUBLIC_BASE_URL: 'https://example.com',
  CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
  CALENDAR_EVENTS_TABLE: TABLE,
  CALENDAR_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012',
  CALENDAR_LOG_LEVEL: 'none',
};

/** `since` is fixed so every asserted query string ends in the same after: date. */
const SINCE = new Date('2026-06-02T00:00:00.000Z');

function cookie() {
  return `${SESSION_COOKIE_NAME}=${createSessionToken({ sub: GOOGLE_SUB, email: EMAIL }, { secret: SESSION_SECRET })}`;
}

function makeEvent(method, path, body = null) {
  const event = {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
    cookies: [cookie()],
    requestContext: {
      domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
      http: { method, path },
    },
  };
  if (body !== null) {
    event.body = JSON.stringify(body);
    event.isBase64Encoded = false;
  }
  return event;
}

/**
 * The stubbed connections table. A recorder, not DynamoDB: it captures the
 * compiled `updates` map and echoes the resulting row back, exactly as the real
 * UpdateItem with ALL_NEW does. Nothing opens a client.
 */
function fakeTable({ existing = null, extraAttributes = {} } = {}) {
  const calls = [];
  const updateItem = async ({ tableName, key, updates }) => {
    calls.push({ tableName, key, updates });
    const row = { userId: USER, email: EMAIL, ...(existing || {}) };
    for (const [attribute, value] of Object.entries(updates || {})) {
      if (value === REMOVE_ATTRIBUTE) delete row[attribute];
      else row[attribute] = value;
    }
    return { ...row, ...extraAttributes };
  };
  return { updateItem, calls };
}

/** PUT /calendar/api/settings with a processing-job list. */
async function putJobs(processingJobs, { table = fakeTable() } = {}) {
  const response = await handler(makeEvent('PUT', '/calendar/api/settings', { processingJobs }), {}, {
    env: ENV,
    updateItem: table.updateItem,
  });
  return { response, body: JSON.parse(response.body), table };
}

/** GET /calendar/api/settings or /calendar/api/auth/me over a stored row. */
async function get(path, row) {
  const response = await handler(makeEvent('GET', path), {}, {
    env: ENV,
    getConnection: async () => row,
  });
  return { response, body: JSON.parse(response.body) };
}

/** One valid REQUEST job; the server mints the id. */
function jobBody(overrides = {}) {
  return { name: "St Mary's", schoolName: "St Mary's Primary", domains: ['stmarys.edu.au'], searchTerms: [], ...overrides };
}

/* ---------------------------------------------------------------------------
 * Minimal Gmail + Anthropic stubs for the scan scenarios.
 * ------------------------------------------------------------------------- */
function makeGmail({ mailbox = [] } = {}) {
  const state = { queries: [] };
  const fetchImpl = async (url) => {
    if (url.includes('/messages?')) {
      const query = new URL(url).searchParams.get('q');
      state.queries.push(query);
      const matched = mailbox.filter((entry) => entry.matchTokens.some((token) => query.includes(token)));
      return { ok: true, status: 200, text: async () => JSON.stringify({ messages: matched.map((e) => ({ id: e.id })) }) };
    }
    const id = decodeURIComponent(url.split('/messages/')[1].split('?')[0]);
    const entry = mailbox.find((candidate) => candidate.id === id);
    if (!entry) return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: entry.id,
        threadId: `t-${entry.id}`,
        internalDate: String(Date.parse(entry.receivedAt)),
        snippet: entry.subject,
        payload: {
          headers: [{ name: 'Subject', value: entry.subject }, { name: 'From', value: entry.from }],
          mimeType: 'text/plain',
          body: { data: Buffer.from(entry.body).toString('base64url') },
        },
      }),
    };
  };
  return { fetchImpl, state };
}

function makeAnthropic() {
  const state = { requests: [] };
  const createMessage = async (request) => {
    state.requests.push(request);
    return { stop_reason: 'end_turn', parsed_output: { isSchoolEmail: true, events: [] } };
  };
  return { createMessage, state };
}

/** Drive one whole scan over a STORED CONNECTION ROW, with every seam stubbed. */
async function scan(row, { mailbox = [] } = {}) {
  const gmail = makeGmail({ mailbox });
  const anthropic = makeAnthropic();
  const result = await runScan(
    { userId: USER, mode: 'scheduled' },
    {
      env: ENV,
      log: () => {},
      now: () => SINCE.getTime(),
      getConnection: async () => ({ userId: USER, ...row }),
      updateConnection: async () => {},
      acquireScanLock: async () => true,
      releaseScanLock: async () => {},
      getAccessToken: async () => 'access-token',
      fetchImpl: gmail.fetchImpl,
      createMessage: anthropic.createMessage,
      batchGet: async () => ({ items: [], unprocessedKeys: [] }),
      batchWrite: async () => ({ unprocessed: [] }),
      errorTypes: null,
      sleep: async () => {},
      random: () => 0,
      maxAttempts: 1,
    }
  );
  return { result, gmail, anthropic };
}

/* =========================================================================
 * Scenario: A job with multiple domains saves and ORs every domain into its
 *           Gmail query                                      (AC 1, 12, 19, 20)
 * ========================================================================= */

describe('Scenario: A job with multiple domains saves and ORs every domain into its Gmail query', () => {
  it('When the user saves one job with domains "stmarys.edu.au, pandc.org.au", Then the save succeeds', async () => {
    const { response, body } = await putJobs([
      jobBody({ domains: ['stmarys.edu.au', 'pandc.org.au'] }),
    ]);
    assert.equal(response.statusCode, 200);
    assert.equal(body.processingJobs.length, 1);
  });

  it('And the stored job has domains ["stmarys.edu.au", "pandc.org.au"] and no "domain" key', async () => {
    const { body, table } = await putJobs([jobBody({ domains: ['stmarys.edu.au', 'pandc.org.au'] })]);

    assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
    assert.ok(!('domain' in body.processingJobs[0]), 'the response body carried the superseded singular key');

    const written = table.calls[0].updates.processingJobs[0];
    assert.deepEqual(written.domains, ['stmarys.edu.au', 'pandc.org.au']);
    assert.ok(!('domain' in written), 'the STORED item carried the superseded singular key');
  });

  it('And the job\'s Gmail clauses are the domains in stored order, then the school name', async () => {
    const { body } = await putJobs([jobBody({ domains: ['stmarys.edu.au', 'pandc.org.au'] })]);
    assert.deepEqual(buildJobClauses(body.processingJobs[0]), [
      'from:@stmarys.edu.au',
      'from:@pandc.org.au',
      '"St Mary\'s Primary"',
    ]);
  });

  it('And the job\'s Gmail query is one paren group with after: outside it', async () => {
    const { body } = await putJobs([jobBody({ domains: ['stmarys.edu.au', 'pandc.org.au'] })]);
    assert.equal(
      buildJobQuery({ job: body.processingJobs[0], since: SINCE }),
      '(from:@stmarys.edu.au OR from:@pandc.org.au OR "St Mary\'s Primary") after:2026/06/02'
    );
  });
});

/* =========================================================================
 * Scenario: A single-domain job emits the same query it did before the rename
 * ========================================================================= (AC 21) */

describe('Scenario: A single-domain job emits the same query it did before the rename', () => {
  it('When the user saves a job with domains ["stmarys.edu.au"], Then its query is unchanged', async () => {
    const { response, body } = await putJobs([jobBody({ domains: ['stmarys.edu.au'] })]);
    assert.equal(response.statusCode, 200);
    assert.equal(
      buildJobQuery({ job: body.processingJobs[0], since: SINCE }),
      '(from:@stmarys.edu.au OR "St Mary\'s Primary") after:2026/06/02'
    );
  });
});

/* =========================================================================
 * Scenario Outline: A job with no domains at all is accepted and still
 *                   searchable                                 (AC 3, 4, 23)
 * ========================================================================= */

describe('Scenario Outline: A job with no domains at all is accepted and still searchable', () => {
  const examples = [
    ['no domains key', (payload) => delete payload.domains],
    ['domains set to null', (payload) => { payload.domains = null; }],
    ['an empty domains list', (payload) => { payload.domains = []; }],
  ];

  for (const [label, mutate] of examples) {
    it(`Given ${label}, When the user saves, Then it succeeds with domains [] and is still searchable`, async () => {
      const payload = jobBody();
      mutate(payload);

      const { response, body } = await putJobs([payload]);

      assert.equal(response.statusCode, 200, JSON.stringify(body));
      assert.deepEqual(body.processingJobs[0].domains, []);
      assert.equal(hasJobQueryClauses(body.processingJobs[0]), true, 'the job is not reported as usable for scanning');
      assert.equal(
        buildJobQuery({ job: body.processingJobs[0], since: SINCE }),
        '("St Mary\'s Primary") after:2026/06/02'
      );
    });
  }
});

/* =========================================================================
 * Scenario: Duplicate domains within one job collapse instead of failing
 * ========================================================================= (AC 12, 22) */

describe('Scenario: Duplicate domains within one job collapse instead of failing the save', () => {
  const submitted = ['StMarys.EDU.au', '@stmarys.edu.au', 'https://stmarys.edu.au/news', 'pandc.org.au'];

  it('When the user saves four entries that are two domains, Then the save succeeds', async () => {
    const { response } = await putJobs([jobBody({ domains: submitted })]);
    assert.equal(response.statusCode, 200);
  });

  it('And the stored job has domains ["stmarys.edu.au", "pandc.org.au"]', async () => {
    const { body, table } = await putJobs([jobBody({ domains: submitted })]);
    assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
    assert.deepEqual(table.calls[0].updates.processingJobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
  });

  it('And the job\'s Gmail query contains "from:@stmarys.edu.au" exactly once', async () => {
    const { body } = await putJobs([jobBody({ domains: submitted })]);
    const query = buildJobQuery({ job: body.processingJobs[0], since: SINCE });
    assert.equal(query.split('from:@stmarys.edu.au').length - 1, 1, query);
  });
});

/* =========================================================================
 * Scenario: An invalid domain in a multi-domain list is rejected and named
 * ========================================================================= (AC 10, 13) */

describe('Scenario: An invalid domain in a multi-domain list is rejected and named', () => {
  const payload = [
    jobBody({ name: 'Newsletters' }),
    jobBody({ name: 'Sport', domains: ['stmarys.edu.au', 'not a domain', 'pandc.org.au'] }),
  ];

  it('When the user saves job 1 with an invalid entry, Then the save is rejected with status 400', async () => {
    const { response } = await putJobs(payload);
    assert.equal(response.statusCode, 400);
  });

  it('And the error field is "processingJobs[1].domains" and the message names "not a domain"', async () => {
    const { body } = await putJobs(payload);
    assert.equal(body.field, 'processingJobs[1].domains');
    assert.equal(body.error, '"not a domain" is not a valid email domain');
  });

  it('And nothing is written to the connections table', async () => {
    const table = fakeTable();
    await putJobs(payload, { table });
    assert.deepEqual(table.calls, [], 'a refused save still wrote to the table');
  });
});

/* =========================================================================
 * Scenario: A public mail provider mixed into an otherwise valid list
 * ========================================================================= (AC 11) */

describe('Scenario: A public mail provider mixed into an otherwise valid list is refused', () => {
  it('When the list holds "GMAIL.com", Then it is a 400 naming the NORMALISED host', async () => {
    const table = fakeTable();
    const { response, body } = await putJobs([jobBody({ domains: ['stmarys.edu.au', 'GMAIL.com'] })], { table });

    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'processingJobs[0].domains');
    assert.equal(body.error, "gmail.com is a public email provider, not a school domain - use the school's own domain");
    assert.deepEqual(table.calls, []);
  });
});

/* =========================================================================
 * Scenario Outline: A blank entry inside a supplied domains list is refused
 * ========================================================================= (AC 9) */

describe('Scenario Outline: A blank entry inside a supplied domains list is refused', () => {
  for (const [label, entry] of [['""', ''], ['"   "', '   '], ['42', 42], ['null', null]]) {
    it(`Given the entry ${label}, When the user saves, Then it is a 400 "A school email domain cannot be blank"`, async () => {
      const table = fakeTable();
      const { response, body } = await putJobs([jobBody({ domains: ['stmarys.edu.au', entry] })], { table });

      assert.equal(response.statusCode, 400);
      assert.equal(body.field, 'processingJobs[0].domains');
      assert.equal(body.error, 'A school email domain cannot be blank');
      assert.deepEqual(table.calls, []);
    });
  }
});

/* =========================================================================
 * Scenario: A bare comma-separated string is refused rather than split
 * ========================================================================= (AC 5) */

describe('Scenario: A bare comma-separated string is refused rather than split', () => {
  it('When domains is the string "stmarys.edu.au, pandc.org.au", Then it is a 400 "must be a list"', async () => {
    const table = fakeTable();
    const { response, body } = await putJobs(
      [jobBody({ domains: 'stmarys.edu.au, pandc.org.au' })],
      { table }
    );

    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'processingJobs[0].domains');
    assert.equal(body.error, 'School email domains must be a list');
    assert.ok(!body.error.includes('pandc'), 'the validator looked inside the string');
    assert.deepEqual(table.calls, []);
  });
});

/* =========================================================================
 * Scenario: Eleven submitted domains are refused even when two are duplicates
 * ========================================================================= (AC 6, 7) */

describe('Scenario: Eleven submitted domains are refused even when two of them are duplicates', () => {
  it('When 11 entries are submitted (2 duplicates, 9 distinct), Then it is a 400 "at most 10"', async () => {
    const domains = [
      ...Array.from({ length: 9 }, (_, i) => `school${i}.edu.au`),
      'school0.edu.au',
      '@School1.EDU.au',
    ];
    assert.equal(domains.length, 11);
    assert.equal(new Set(domains.map((d) => d.replace('@', '').toLowerCase())).size, 9, 'the fixture must collapse to 9');

    const table = fakeTable();
    const { response, body } = await putJobs([jobBody({ domains })], { table });

    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'processingJobs[0].domains');
    assert.equal(body.error, 'Enter at most 10 school email domains for one processing job');
    assert.deepEqual(table.calls, []);
  });
});

/* =========================================================================
 * Scenario: A payload sending the old singular domain key stores no domain
 * ========================================================================= (AC 2) */

describe('Scenario: A payload sending the old singular domain key stores no domain', () => {
  it('When the payload carries only "domain", Then the save succeeds with domains [] and no "domain" key', async () => {
    const table = fakeTable();
    const { response, body } = await putJobs(
      [{ name: "St Mary's", schoolName: "St Mary's Primary", domain: 'stmarys.edu.au', searchTerms: [] }],
      { table }
    );

    assert.equal(response.statusCode, 200, JSON.stringify(body));
    assert.deepEqual(body.processingJobs[0].domains, []);
    assert.ok(!('domain' in body.processingJobs[0]));

    const written = table.calls[0].updates.processingJobs[0];
    assert.deepEqual(written.domains, []);
    assert.ok(!('domain' in written), 'the superseded key reached the stored item');
  });
});

/* =========================================================================
 * Scenario: Two jobs may share a domain but not a name
 * ========================================================================= (AC 17) */

describe('Scenario: Two jobs may share a domain but not a name', () => {
  it('When the user saves "Newsletters" and "Sport" on one domain, Then the save succeeds', async () => {
    const { response, body } = await putJobs([
      jobBody({ name: 'Newsletters' }),
      jobBody({ name: 'Sport' }),
    ]);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.processingJobs.map((entry) => entry.domains), [['stmarys.edu.au'], ['stmarys.edu.au']]);
  });

  it('When the user saves "Sport" and "SPORT", Then it is a 400 on processingJobs naming both spellings', async () => {
    const table = fakeTable();
    const { response, body } = await putJobs(
      [jobBody({ name: 'Sport' }), jobBody({ name: 'SPORT' })],
      { table }
    );

    assert.equal(response.statusCode, 400);
    assert.equal(body.field, 'processingJobs');
    assert.ok(body.error.includes('"Sport"'), body.error);
    assert.ok(body.error.includes('"SPORT"'), body.error);
    assert.deepEqual(table.calls, []);
  });
});

/* =========================================================================
 * Scenario: A job with no domains whose school name strips to nothing is never
 *           sent to Gmail                                             (AC 24)
 * ========================================================================= */

describe('Scenario: A job with no domains whose school name strips to nothing is never sent to Gmail', () => {
  const storedRow = {
    processingJobs: [{ id: 'job-a', name: 'Broken', schoolName: '"""', domains: [], searchTerms: [] }],
  };

  it('Given such a stored job, When a scan runs, Then the job is reported "not_configured"', async () => {
    const { result } = await scan(storedRow);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.NOT_CONFIGURED);
  });

  it('And no Gmail query is issued for it', async () => {
    const { gmail } = await scan(storedRow);
    assert.deepEqual(gmail.state.queries, [], 'a mailbox-wide query was issued for an unusable job');
  });

  it('And building its query fails with code "no_job_query"', () => {
    const [resolved] = toProcessingJobs(storedRow);
    assert.equal(hasJobQueryClauses(resolved), false);
    assert.throws(() => buildJobQuery({ job: resolved, since: SINCE }), (err) => err.code === 'no_job_query');
  });

  it('And a SAVE of that same job is still accepted - domains is optional, schoolName is what is required', async () => {
    const { response, body } = await putJobs([jobBody({ schoolName: '"""', domains: [] })]);
    assert.equal(response.statusCode, 200, JSON.stringify(body));
    assert.deepEqual(body.processingJobs[0].domains, []);
  });
});

/* =========================================================================
 * Scenario: Every one of a job's domains reaches the extraction context
 * ========================================================================= (AC 26, 27) */

describe("Scenario: Every one of a job's domains reaches the extraction context", () => {
  const storedRow = {
    processingJobs: [
      {
        id: 'job-a',
        name: 'Newsletters',
        schoolName: "St Mary's Primary",
        domains: ['stmarys.edu.au', 'pandc.org.au'],
        searchTerms: [],
      },
    ],
  };

  const mailbox = [
    {
      id: 'm-1',
      from: 'office@pandc.org.au',
      subject: 'P&C newsletter',
      body: 'Details inside.',
      receivedAt: '2026-06-01T09:00:00.000Z',
      matchTokens: ['pandc.org.au'],
    },
  ];

  it('Given a two-domain job, When a scan extracts a matching message, Then BOTH domains are in the school context', async () => {
    const { anthropic } = await scan(storedRow, { mailbox });

    assert.equal(anthropic.state.requests.length, 1, 'the message was not extracted');
    const content = anthropic.state.requests[0].messages[0].content;
    assert.ok(content.includes('stmarys.edu.au'), content);
    assert.ok(content.includes('pandc.org.au'), content);
  });

  it('And the extraction is called with schoolNames ["St Mary\'s Primary"] only', async () => {
    const { anthropic } = await scan(storedRow, { mailbox });
    const content = anthropic.state.requests[0].messages[0].content;
    assert.ok(content.includes("St Mary's Primary"), content);
  });

  it('And the message from "office@pandc.org.au" is treated as a watched sender (it was not skipped)', async () => {
    const { result } = await scan(storedRow, { mailbox });
    assert.equal(result.messagesScanned, 1);
    assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.OK);
  });

  it("And the scan's Gmail query ORs both domains", async () => {
    const { gmail } = await scan(storedRow, { mailbox });
    assert.deepEqual(gmail.state.queries, [
      '(from:@stmarys.edu.au OR from:@pandc.org.au OR "St Mary\'s Primary") after:2026/05/28',
    ]);
  });
});

/* =========================================================================
 * Scenario: A row with no processingJobs still scans via the legacy
 *           one-job-per-domain fallback                          (AC 28, 30)
 * ========================================================================= */

describe('Scenario: A row with no processingJobs still scans via the legacy one-job-per-domain fallback', () => {
  const legacyRow = {
    schoolNames: ["St Mary's Primary", 'Holy Cross'],
    searchDomains: ['stmarys.edu.au', 'holycross.edu.au'],
  };

  it('When the scan resolves its processing jobs, Then it produces 2 jobs, one per legacy domain', () => {
    const jobs = toProcessingJobs(legacyRow);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, 'legacy#stmarys.edu.au');
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
    assert.equal(jobs[1].id, 'legacy#holycross.edu.au');
    assert.deepEqual(jobs[1].domains, ['holycross.edu.au']);
  });

  it('And no job has a "domain" key', () => {
    for (const entry of toProcessingJobs(legacyRow)) assert.ok(!('domain' in entry));
  });

  it("And each job's Gmail query filters on its own single domain", async () => {
    const { gmail } = await scan(legacyRow);
    assert.deepEqual(gmail.state.queries, [
      '(from:@stmarys.edu.au OR "St Mary\'s Primary") after:2026/05/28',
      '(from:@holycross.edu.au OR "Holy Cross") after:2026/05/28',
    ]);
  });
});

/* =========================================================================
 * Scenario: A row saved under the old singular job shape still scans on its
 *           domain                                                    (AC 29)
 * ========================================================================= */

describe('Scenario: A row saved under the old singular job shape still scans on its domain', () => {
  const singularRow = {
    processingJobs: [
      { id: 'job-a', name: 'Newsletters', schoolName: '', domain: 'stmarys.edu.au', searchTerms: [] },
    ],
  };

  it('When the scan resolves its processing jobs, Then that job has domains ["stmarys.edu.au"]', () => {
    const jobs = toProcessingJobs(singularRow);
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
    assert.ok(!('domain' in jobs[0]));
  });

  it('And its Gmail query contains "from:@stmarys.edu.au" - the sender filter is not silently lost', async () => {
    const { gmail } = await scan(singularRow);
    assert.equal(gmail.state.queries.length, 1);
    assert.ok(gmail.state.queries[0].includes('from:@stmarys.edu.au'), gmail.state.queries[0]);
  });
});

/* =========================================================================
 * Scenario: A row saved under the old singular job shape still shows its domain
 *           in settings and /auth/me                                  (AC 38, 39)
 * ========================================================================= */

describe('Scenario: A row saved under the old singular job shape still shows its domain in settings', () => {
  const storedRow = {
    userId: USER,
    email: EMAIL,
    hasRefreshToken: true,
    processingJobs: [
      {
        id: '6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d',
        name: 'Newsletters',
        schoolName: "St Mary's Primary",
        domain: 'stmarys.edu.au',
        searchTerms: ['Year 4'],
      },
    ],
  };

  it('When they GET settings, Then processingJobs[0].domains is ["stmarys.edu.au"]', async () => {
    const { response, body } = await get('/calendar/api/settings', storedRow);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au']);
  });

  it('And the response body processingJobs[0] has no "domain" key', async () => {
    const { body } = await get('/calendar/api/settings', storedRow);
    assert.ok(!('domain' in body.processingJobs[0]), 'the settings body carried both spellings');
  });

  it('When they GET auth/me, Then processingJobs[0].domains is ["stmarys.edu.au"] with no "domain" key', async () => {
    const { response, body } = await get('/calendar/api/auth/me', storedRow);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au']);
    assert.ok(!('domain' in body.processingJobs[0]));
  });

  it('And the read is NOT a migration - nothing is written back', async () => {
    const before = JSON.stringify(storedRow);
    await get('/calendar/api/settings', storedRow);
    await get('/calendar/api/auth/me', storedRow);
    assert.equal(JSON.stringify(storedRow), before, 'the GET mutated the stored row');
  });
});

/* =========================================================================
 * Scenario: connections.mjs's own legacy synthesis emits domains, not domain
 * ========================================================================= (AC 37, 40)
 *
 * NOTE ON THE TICKET'S EXAMPLE VALUES. The ticket's Gherkin expects
 * domains[0] === "stmarys.edu.au" for legacy searchDomains
 * ["stmarys.edu.au", "pandc.org.au"]. The real `legacyStringList` SORTS the
 * unordered DynamoDB string set before taking the first entry - deliberate,
 * pre-existing behaviour that makes the synthesis stable across reads - so
 * "pandc.org.au" sorts first and becomes domains[0], and "stmarys.edu.au"
 * folds into searchTerms. This scenario is written against that ACTUAL
 * behaviour, not the ticket's literal example.
 * ========================================================================= */

describe("Scenario: connections.mjs's own legacy synthesis emits domains, not domain", () => {
  const legacyRow = {
    userId: USER,
    email: EMAIL,
    hasRefreshToken: true,
    schoolNames: new Set(["St Mary's Primary"]),
    searchDomains: new Set(['stmarys.edu.au', 'pandc.org.au']),
  };

  it('When they GET settings, Then processingJobs[0].domains is the SORTED-first legacy domain', async () => {
    const { response, body } = await get('/calendar/api/settings', legacyRow);
    assert.equal(response.statusCode, 200);
    assert.equal(body.processingJobs.length, 1);
    assert.deepEqual(body.processingJobs[0].domains, ['pandc.org.au']);
  });

  it('And processingJobs[0].searchTerms includes the remaining legacy domain', async () => {
    const { body } = await get('/calendar/api/settings', legacyRow);
    assert.ok(body.processingJobs[0].searchTerms.includes('stmarys.edu.au'), JSON.stringify(body.processingJobs[0]));
  });

  it('And processingJobs[0] has no "domain" key, and no legacy attribute is emitted', async () => {
    const { body } = await get('/calendar/api/settings', legacyRow);
    assert.ok(!('domain' in body.processingJobs[0]));
    assert.ok(!('schoolNames' in body));
    assert.ok(!('searchDomains' in body));
  });

  it('And /auth/me projects the same synthesised shape', async () => {
    const { body } = await get('/calendar/api/auth/me', legacyRow);
    assert.deepEqual(body.processingJobs[0].domains, ['pandc.org.au']);
    assert.ok(!('domain' in body.processingJobs[0]));
  });
});

/* =========================================================================
 * Scenario: A raw low-level DynamoDB row is read into plain domain strings
 * ========================================================================= (AC 28) */

describe('Scenario: A raw low-level DynamoDB row is read into plain domain strings', () => {
  it('Given a { L: [ { M: { domains: { L: [ { S } ] } } } ] } row, When the scan resolves its jobs, Then domains are plain strings', () => {
    const jobs = toProcessingJobs({
      processingJobs: {
        L: [{ M: { domains: { L: [{ S: 'stmarys.edu.au' }, { S: ' pandc.org.au ' }] } } }],
      },
    });
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
  });

  it('And the same low-level row carrying only the singular `domain` is still readable', () => {
    const jobs = toProcessingJobs({
      processingJobs: { L: [{ M: { id: { S: 'job-a' }, domain: { S: 'stmarys.edu.au' } } }] },
    });
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
  });
});

/* =========================================================================
 * Scenario: An empty domains list is stored as an empty DynamoDB list
 * ========================================================================= (AC 15) */

describe('Scenario: An empty domains list is stored as an empty DynamoDB list', () => {
  it('When the user saves a job with no domains, Then the patch writes processingJobs as a list of maps', async () => {
    const payload = jobBody();
    delete payload.domains;
    const { table } = await putJobs([payload]);

    const written = table.calls[0].updates.processingJobs;
    assert.ok(Array.isArray(written), 'processingJobs was not written as a list');
    assert.ok(!(written instanceof Set));
    assert.equal(Object.getPrototypeOf(written[0]), Object.prototype, 'a job was not written as a plain map');
  });

  it('And that job\'s "domains" attribute is an EMPTY LIST, not absent and not a set', async () => {
    const payload = jobBody();
    delete payload.domains;
    const { table } = await putJobs([payload]);

    const written = table.calls[0].updates.processingJobs[0];
    assert.ok('domains' in written, 'domains was dropped instead of written empty');
    assert.ok(Array.isArray(written.domains));
    assert.ok(!(written.domains instanceof Set));
    assert.deepEqual(written.domains, []);
    assert.notEqual(written.domains, REMOVE_ATTRIBUTE);
  });

  it('And the patch still REMOVEs the legacy schoolNames, searchDomains and schoolName attributes', async () => {
    const { table } = await putJobs([jobBody()]);
    const { updates } = table.calls[0];
    assert.equal(updates.schoolNames, REMOVE_ATTRIBUTE);
    assert.equal(updates.searchDomains, REMOVE_ATTRIBUTE);
    assert.equal(updates.schoolName, REMOVE_ATTRIBUTE);
  });

  it('And the same patch built directly from validated jobs agrees, key for key', () => {
    const jobs = validateProcessingJobs([jobBody({ domains: [] })], { newId: () => 'id-1' });
    const patch = buildConnectionPatch({ processingJobs: jobs });
    assert.deepEqual(Object.keys(patch.processingJobs[0]).sort(), [
      'domains',
      'id',
      'name',
      'schoolName',
      'searchTerms',
    ]);
  });
});
