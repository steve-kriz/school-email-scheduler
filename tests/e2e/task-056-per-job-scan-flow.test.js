/**
 * task-056-per-job-scan-flow.test.js - TASK-056 END-TO-END (Gherkin) scenarios.
 *
 * One `describe` per scenario in the ticket's "Cucumber Tests" feature file,
 * with Given/When/Then test names. These are scenario-style `node --test` cases:
 * no cucumber package is used or needed.
 *
 * Background (applies to every scenario below):
 *   Given a connected user "google#sub-1"
 *   And the events table and Gmail API are stubbed with injected dependencies
 *   And no real timers, AWS calls, Gmail calls or Anthropic calls are made
 *
 * These drive the REAL `runScan` over the REAL `fetchCandidateMessages`,
 * `extractFromMessage` and `storeEvents`; only the outermost I/O seams are
 * stubbed - `fetchImpl` (Gmail HTTP), `createMessage` (Anthropic), `batchGet` /
 * `batchWrite` (DynamoDB), `getAccessToken`, the connection row, the scan lock
 * and the clock. `sleep` is a no-op and `random` is fixed, so no real timer ever
 * runs and no retry schedule is non-deterministic.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { runScan, SCAN_STATUS, SCAN_JOB_STATUS, MANUAL_SCAN_MAX_MESSAGES } from '../../src/lambda/calendar/backend/scan.mjs';
import { buildQuery, buildJobQuery } from '../../src/lambda/calendar/backend/gmail.mjs';
import { deriveEventId, LIFECYCLE_ATTRIBUTES, EVENT_STATUS } from '../../src/lambda/calendar/backend/events.mjs';
import { ReauthRequiredError } from '../../src/lambda/calendar/backend/google-token.mjs';

const USER = 'google#sub-1';
const TABLE = 'test-calendar-events';
const ENV = { CALENDAR_LOG_LEVEL: 'none', CALENDAR_EVENTS_TABLE: TABLE };

/* ---------------------------------------------------------------------------
 * The stubbed events table. A Map, not DynamoDB: `batchGet` answers the narrow
 * lifecycle projection and `batchWrite` overwrites by (userId, eventId), which
 * is exactly the same-key collapse the real table performs.
 * ------------------------------------------------------------------------- */
class FakeEventsStore {
  constructor() {
    this.rows = new Map();
    this.writes = [];
    this.reads = [];
  }

  key(userId, eventId) {
    return `${userId}|${eventId}`;
  }

  all() {
    return [...this.rows.values()];
  }

  get(eventId, userId = USER) {
    return this.rows.get(this.key(userId, eventId)) || null;
  }

  seed(item) {
    this.rows.set(this.key(item.userId, item.eventId), item);
  }

  deps() {
    return {
      batchGet: async ({ keys }) => {
        this.reads.push(keys);
        const items = [];
        for (const { userId, eventId } of keys) {
          const row = this.rows.get(this.key(userId, eventId));
          if (!row) continue;
          const projected = {};
          for (const attribute of LIFECYCLE_ATTRIBUTES) {
            if (row[attribute] !== undefined) projected[attribute] = row[attribute];
          }
          items.push(projected);
        }
        return { items, unprocessedKeys: [] };
      },
      batchWrite: async ({ items }) => {
        for (const item of items) {
          this.writes.push(item);
          // `removeUndefinedValues` on the real document client: an undefined
          // attribute is simply absent from the stored row.
          const stored = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
          this.rows.set(this.key(stored.userId, stored.eventId), stored);
        }
        return { unprocessed: [] };
      },
    };
  }
}

/* ---------------------------------------------------------------------------
 * The stubbed Gmail API. One `fetchImpl` serving `messages?q=` listings and
 * `messages/<id>?format=full` fetches from an in-memory mailbox.
 * ------------------------------------------------------------------------- */
function makeGmail({ mailbox = [], pageSize = 100, failWhenQueryHas = null, listStatus = 200 } = {}) {
  const state = { queries: [], listUrls: [], fetchedIds: [] };

  const fetchImpl = async (url) => {
    if (url.includes('/messages?')) {
      const params = new URL(url).searchParams;
      const query = params.get('q');
      const maxResults = Number(params.get('maxResults'));
      state.queries.push(query);
      state.listUrls.push(url);

      if (failWhenQueryHas && query.includes(failWhenQueryHas)) {
        return { ok: false, status: 500, text: async () => '{"error":"backend error"}' };
      }
      if (listStatus !== 200) {
        return { ok: false, status: listStatus, text: async () => '{"error":"boom"}' };
      }

      const matched = mailbox.filter((entry) => entry.matchTokens.some((token) => query.includes(token)));
      // A real page returns up to `maxResults`; anything beyond it is what makes
      // listMessageIds report `truncated`.
      const page = matched.slice(0, Math.min(maxResults + 1, pageSize + 1));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: page.map((entry) => ({ id: entry.id })) }),
      };
    }

    const id = decodeURIComponent(url.split('/messages/')[1].split('?')[0]);
    state.fetchedIds.push(id);
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
          headers: [
            { name: 'Subject', value: entry.subject },
            { name: 'From', value: entry.from },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from(entry.body).toString('base64url') },
        },
      }),
    };
  };

  return { fetchImpl, state };
}

/* ---------------------------------------------------------------------------
 * The stubbed Anthropic API. `createMessage` reads the subject back out of the
 * assembled user turn and answers with whatever the mailbox entry declared, so
 * the real prompt-building code runs for every scenario.
 * ------------------------------------------------------------------------- */
function makeAnthropic({ mailbox = [], onRequest = () => {} } = {}) {
  const state = { requests: [] };

  const createMessage = async (request) => {
    state.requests.push(request);
    const content = request.messages[0].content;
    const subject = (content.match(/^subject: (.*)$/m) || [])[1] || '';
    const entry = mailbox.find((candidate) => candidate.subject === subject);
    onRequest(request, entry);
    return {
      stop_reason: 'end_turn',
      parsed_output: { isSchoolEmail: true, events: entry ? entry.events : [] },
    };
  };

  return { createMessage, state };
}

function mail({ id, from, subject, body = 'Details inside.', receivedAt, matchTokens, events = [] }) {
  return { id, from, subject, body, receivedAt, matchTokens, events };
}

function makeJob(id, { name, schoolName, domain, searchTerms = [] }) {
  return { id, name, schoolName, domain, searchTerms };
}

/**
 * Drive one whole scan with the stubs above wired in.
 *
 * @returns {Promise<{ result: object, gmail: object, anthropic: object, store: FakeEventsStore, patches: object[], locks: object }>}
 */
async function scan({
  jobs,
  mailbox = [],
  store = new FakeEventsStore(),
  lastScanAt = null,
  mode = 'scheduled',
  maxMessages = null,
  now = () => Date.parse('2026-06-02T00:00:00.000Z'),
  getRemainingTimeInMillis = null,
  getAccessToken = async () => 'access-token',
  failWhenQueryHas = null,
  onRequest = () => {},
  pageSize = 100,
  acquireScanLock = async () => true,
} = {}) {
  const gmail = makeGmail({ mailbox, failWhenQueryHas, pageSize });
  const anthropic = makeAnthropic({ mailbox, onRequest });
  const patches = [];
  const locks = { acquired: 0, released: 0 };

  const result = await runScan(
    { userId: USER, mode, maxMessages },
    {
      env: ENV,
      log: () => {},
      now,
      getRemainingTimeInMillis,
      getConnection: async () => ({ userId: USER, processingJobs: jobs, lastScanAt }),
      updateConnection: async (_userId, patch) => {
        patches.push(patch);
      },
      acquireScanLock: async (...args) => {
        locks.acquired += 1;
        return acquireScanLock(...args);
      },
      releaseScanLock: async () => {
        locks.released += 1;
      },
      // --- outermost I/O seams, all stubbed ---
      getAccessToken,
      fetchImpl: gmail.fetchImpl,
      createMessage: anthropic.createMessage,
      errorTypes: null,
      sleep: async () => {},
      random: () => 0,
      maxAttempts: 1,
      ...store.deps(),
    }
  );

  return { result, gmail, anthropic, store, patches, locks };
}

describe('Feature: Per-job Gmail search and per-job event attribution (TASK-056 e2e)', () => {
  describe("Scenario: A job's query ORs its domain, school name and search terms under one after: clause", () => {
    it('Given a job with a domain, school name and two search terms, When the query is built, Then it is one OR group under one after: clause', () => {
      // Given a processing job with domain "stmarys.edu.au", school name
      // "St Mary's Primary" and search terms "Year 4" and "Canteen"
      const job = makeJob('job-a', {
        name: "St Mary's",
        schoolName: "St Mary's Primary",
        domain: 'stmarys.edu.au',
        searchTerms: ['Year 4', 'Canteen'],
      });
      // And the scan watermark resolves to 2026-05-19
      const since = new Date('2026-05-19T00:00:00.000Z');

      // When the query for that job is built
      const query = buildJobQuery({ job, since });

      // Then the query is exactly the OR group under the after: clause
      assert.equal(query, '(from:@stmarys.edu.au OR "St Mary\'s Primary" OR "Year 4" OR "Canteen") after:2026/05/19');
      // And the OR clauses are inside a single pair of parentheses
      assert.equal((query.match(/\(/g) || []).length, 1);
      assert.equal((query.match(/\)/g) || []).length, 1);
      // And the after: clause is outside that group
      assert.match(query, /\) after:2026\/05\/19$/);
    });
  });

  describe('Scenario: A domain-only job produces byte-identical output to the old single-domain query', () => {
    it('Given a job with only a domain, When the query is built, Then it is exactly "(from:@stmarys.edu.au) after:2026/05/19"', () => {
      const job = makeJob('job-a', { name: "St Mary's", schoolName: '', domain: 'stmarys.edu.au', searchTerms: [] });
      const since = new Date('2026-05-19T00:00:00.000Z');

      const query = buildJobQuery({ job, since });

      assert.equal(query, '(from:@stmarys.edu.au) after:2026/05/19');
      assert.equal(query, buildQuery({ searchDomains: ['stmarys.edu.au'], since }), 'byte-identical to the pre-ticket builder');
    });
  });

  describe('Scenario: Two jobs each find distinct events in one scan invocation', () => {
    it('Given two jobs each matching their own message, When a scheduled scan runs, Then each stored event is attributed to the job that found it', async () => {
      // Given two processing jobs and one matching message each
      const mailbox = [
        mail({
          id: 'm1',
          from: 'office@stmarys.edu.au',
          subject: 'Year 4 excursion notice',
          receivedAt: '2026-06-01T09:00:00.000Z',
          matchTokens: ['from:@stmarys.edu.au'],
          events: [{ title: 'Year 4 Excursion', startsAt: '2026-06-20T09:00:00.000Z', category: 'excursion' }],
        }),
        mail({
          id: 'm2',
          from: 'office@riverside.edu.au',
          subject: 'Swimming carnival',
          receivedAt: '2026-06-01T11:30:00.000Z',
          matchTokens: ['from:@riverside.edu.au'],
          events: [{ title: 'Swimming Carnival', startsAt: '2026-06-25T09:00:00.000Z', category: 'sport' }],
        }),
      ];

      // When a scheduled scan runs
      const { result, gmail, store, patches } = await scan({
        jobs: [
          makeJob('job-a', { name: "St Mary's", schoolName: "St Mary's Primary", domain: 'stmarys.edu.au' }),
          makeJob('job-b', { name: 'Riverside High', schoolName: 'Riverside High', domain: 'riverside.edu.au' }),
        ],
        mailbox,
        lastScanAt: '2026-05-21T00:00:00.000Z',
      });

      // Then two Gmail searches are performed, one per job, in settings order
      assert.equal(gmail.state.queries.length, 2);
      assert.match(gmail.state.queries[0], /^\(from:@stmarys\.edu\.au OR "St Mary's Primary"\)/);
      assert.match(gmail.state.queries[1], /^\(from:@riverside\.edu\.au OR "Riverside High"\)/);
      // And each search uses the same after: floor
      assert.ok(gmail.state.queries.every((q) => q.endsWith(' after:2026/05/19')));

      // And the stored event from each message carries its own job's id
      const byTitle = Object.fromEntries(store.all().map((row) => [row.title, row]));
      assert.equal(byTitle['Year 4 Excursion'].processingJobId, 'job-a');
      assert.equal(byTitle['Year 4 Excursion'].sourceMessageId, 'm1');
      assert.equal(byTitle['Swimming Carnival'].processingJobId, 'job-b');
      assert.equal(byTitle['Swimming Carnival'].sourceMessageId, 'm2');

      // And the result reports messagesScanned 2 and eventsCreated 2
      assert.equal(result.messagesScanned, 2);
      assert.equal(result.eventsCreated, 2);

      // And the result's jobs array has 2 entries in settings order
      assert.deepEqual(result.jobs.map((entry) => entry.processingJobId), ['job-a', 'job-b']);
      // And the jobs entry for "job-a" reports the expected breakdown
      assert.deepEqual(result.jobs[0], {
        processingJobId: 'job-a',
        name: "St Mary's",
        status: SCAN_JOB_STATUS.OK,
        messagesScanned: 1,
        eventsCreated: 1,
        eventsUpdated: 0,
        skipped: 0,
        truncated: false,
        errors: 0,
      });

      // And the totals equal the sum of the per-job counts
      assert.equal(result.messagesScanned, result.jobs.reduce((sum, j) => sum + j.messagesScanned, 0));
      assert.equal(result.eventsCreated, result.jobs.reduce((sum, j) => sum + j.eventsCreated, 0));
      assert.equal(result.status, SCAN_STATUS.OK);

      // And lastScanAt advances to the latest receivedAt across both jobs
      assert.equal(patches.length, 1);
      assert.equal(patches[0].lastScanAt, '2026-06-01T11:30:00.000Z');
    });
  });

  describe("Scenario: Per-job extraction context carries only that job's school name and domain", () => {
    it("Given two jobs, When job-a's message is extracted, Then the request holds only job-a's context and no search term", async () => {
      const mailbox = [
        mail({
          id: 'm1',
          from: 'office@stmarys.edu.au',
          subject: 'Tuckshop roster',
          body: 'Tuckshop roster for the term.',
          receivedAt: '2026-06-01T09:00:00.000Z',
          matchTokens: ['from:@stmarys.edu.au'],
          events: [{ title: 'Tuckshop duty', startsAt: '2026-06-18T09:00:00.000Z' }],
        }),
      ];

      const { anthropic } = await scan({
        jobs: [
          makeJob('job-a', {
            name: "St Mary's",
            schoolName: "St Mary's Primary",
            domain: 'stmarys.edu.au',
            searchTerms: ['Tuckshop'],
          }),
          makeJob('job-b', { name: 'Riverside High', schoolName: 'Riverside High', domain: 'riverside.edu.au' }),
        ],
        mailbox,
        lastScanAt: '2026-05-21T00:00:00.000Z',
      });

      assert.equal(anthropic.state.requests.length, 1, 'only job-a matched a message');
      const request = anthropic.state.requests[0];
      const content = request.messages[0].content;
      const serialised = JSON.stringify(request);

      // Then the extraction request contains "St Mary's Primary" as the ONLY school_name
      const schoolNames = [...content.matchAll(/<school_name>(.*?)<\/school_name>/g)].map((m) => m[1]);
      assert.deepEqual(schoolNames, ["St Mary's Primary"]);
      // And "stmarys.edu.au" as the only watched_domain value
      const domains = [...content.matchAll(/<watched_domain>(.*?)<\/watched_domain>/g)].map((m) => m[1]);
      assert.deepEqual(domains, ['stmarys.edu.au']);
      // And it does not contain "Riverside High"
      assert.ok(!serialised.includes('Riverside High'), "another job's school name must never leak into this prompt");
      // And it does not contain "Tuckshop" as a SEARCH TERM anywhere in the request
      const withoutEmail = serialised.replace(/Tuckshop roster[^"]*/g, '').replace(/Tuckshop duty/g, '');
      assert.ok(!/searchTerms/.test(serialised), 'searchTerms is not even a key in the request');
      assert.ok(
        !new RegExp('<school_name>[^<]*Tuckshop').test(content) && !new RegExp('<watched_domain>[^<]*Tuckshop').test(content),
        'the search term never becomes school context'
      );
      assert.ok(!/Tuckshop/.test(withoutEmail.replace(/subject: [^\\]*/g, '')), 'the only Tuckshop text is the email itself');

      // And the system prompt is byte-identical to the version before this change
      // (pinned by digest in tests/unit/task-056-per-job-search.test.js, AC 34).
      assert.ok(Array.isArray(request.system), 'the system block is still the cache breakpoint');
    });
  });

  describe('Scenario: Two jobs match the same email and the first job keeps the attribution on rescan', () => {
    it('Given both jobs match message m9, When a scan runs and is later re-run in the other order, Then job-a keeps the attribution and createdAt', async () => {
      const mailbox = [
        mail({
          id: 'm9',
          from: 'office@shared.edu.au',
          subject: 'Book fair next week',
          receivedAt: '2026-06-01T09:00:00.000Z',
          matchTokens: ['from:@shared.edu.au'],
          events: [{ title: 'Book Fair', startsAt: '2026-06-10T00:00:00.000Z' }],
        }),
      ];
      const jobA = makeJob('job-a', { name: 'A', schoolName: 'Shared School', domain: 'shared.edu.au' });
      const jobB = makeJob('job-b', { name: 'B', schoolName: 'Shared School', domain: 'shared.edu.au' });
      const store = new FakeEventsStore();

      // When a scan runs
      const first = await scan({
        jobs: [jobA, jobB],
        mailbox,
        store,
        lastScanAt: '2026-05-21T00:00:00.000Z',
        now: () => Date.parse('2026-06-02T00:00:00.000Z'),
      });

      // Then both extraction passes derive the same eventId
      const expectedId = deriveEventId({ sourceMessageId: 'm9', title: 'Book Fair', startsAt: '2026-06-10T00:00:00.000Z' });
      assert.equal(store.writes.length, 2, 'each job paid its own write');
      assert.ok(store.writes.every((row) => row.eventId === expectedId));
      // And exactly one row is stored for that eventId
      assert.equal(store.all().length, 1);
      // And that row's processingJobId is "job-a"
      assert.equal(store.get(expectedId).processingJobId, 'job-a');
      const firstCreatedAt = store.get(expectedId).createdAt;
      assert.equal(firstCreatedAt, '2026-06-02T00:00:00.000Z');
      assert.equal(first.result.status, SCAN_STATUS.OK);

      // When the user later reorders the jobs so that "job-b" runs first
      // And a second scan runs over the same message
      await scan({
        jobs: [jobB, jobA],
        mailbox,
        store,
        lastScanAt: '2026-06-01T00:00:00.000Z',
        now: () => Date.parse('2026-06-09T00:00:00.000Z'),
      });

      // Then exactly one row still exists for that eventId
      assert.equal(store.all().length, 1);
      // And its processingJobId is still "job-a"
      assert.equal(store.get(expectedId).processingJobId, 'job-a');
      // And its createdAt is still the first scan's timestamp
      assert.equal(store.get(expectedId).createdAt, firstCreatedAt);
      assert.equal(store.get(expectedId).updatedAt, '2026-06-09T00:00:00.000Z', 'only updatedAt moves');
    });
  });

  describe('Scenario: A rescan by another job does not resurrect an acknowledged event', () => {
    it('Given an acknowledged event attributed to job-a, When job-b re-extracts it, Then the status, the missing attentionKey and the attribution all survive', async () => {
      const mailbox = [
        mail({
          id: 'm9',
          from: 'office@shared.edu.au',
          subject: 'Book fair next week',
          receivedAt: '2026-06-01T09:00:00.000Z',
          matchTokens: ['from:@shared.edu.au'],
          events: [{ title: 'Book Fair', startsAt: '2026-06-10T00:00:00.000Z', needsAttention: true, actionRequired: 'Send money' }],
        }),
      ];
      const eventId = deriveEventId({ sourceMessageId: 'm9', title: 'Book Fair', startsAt: '2026-06-10T00:00:00.000Z' });

      // Given an event stored with processingJobId "job-a" and status "acknowledged"
      const store = new FakeEventsStore();
      store.seed({
        userId: USER,
        eventId,
        title: 'Book Fair',
        status: EVENT_STATUS.ACKNOWLEDGED,
        acknowledgedAt: '2026-06-03T00:00:00.000Z',
        dueBy: '2026-06-09T00:00:00.000Z',
        processingJobId: 'job-a',
        createdAt: '2026-06-02T00:00:00.000Z',
      });

      // When a later scan re-extracts the same event under job "job-b"
      await scan({
        jobs: [makeJob('job-b', { name: 'B', schoolName: 'Shared School', domain: 'shared.edu.au' })],
        mailbox,
        store,
        lastScanAt: '2026-06-04T00:00:00.000Z',
        now: () => Date.parse('2026-06-06T00:00:00.000Z'),
      });

      const row = store.get(eventId);
      // Then the stored row keeps status "acknowledged"
      assert.equal(row.status, EVENT_STATUS.ACKNOWLEDGED);
      assert.equal(row.acknowledgedAt, '2026-06-03T00:00:00.000Z');
      // And it carries no attentionKey
      assert.equal(row.attentionKey, undefined);
      assert.ok(!('attentionKey' in row));
      // And its processingJobId is still "job-a"
      assert.equal(row.processingJobId, 'job-a');
      assert.equal(row.createdAt, '2026-06-02T00:00:00.000Z');
    });
  });

  describe('Scenario: The scan runs out of time mid-job-loop and pins the watermark', () => {
    it('Given the clock passes the deadline while job-b extracts, When the scan runs, Then job-c is never fetched and the watermark is pinned', async () => {
      const START = Date.parse('2026-06-02T00:00:00.000Z');
      let clock = START;

      const mailbox = [
        mail({ id: 'a1', from: 'office@a.edu.au', subject: 'A one', receivedAt: '2026-06-01T01:00:00.000Z', matchTokens: ['from:@a.edu.au'], events: [{ title: 'A Event', startsAt: '2026-06-20T00:00:00.000Z' }] }),
        mail({ id: 'b1', from: 'office@b.edu.au', subject: 'B one', receivedAt: '2026-06-01T02:00:00.000Z', matchTokens: ['from:@b.edu.au'], events: [{ title: 'B Event', startsAt: '2026-06-21T00:00:00.000Z' }] }),
        mail({ id: 'b2', from: 'office@b.edu.au', subject: 'B two', receivedAt: '2026-06-01T03:00:00.000Z', matchTokens: ['from:@b.edu.au'], events: [{ title: 'B Event Two', startsAt: '2026-06-22T00:00:00.000Z' }] }),
        mail({ id: 'c1', from: 'office@c.edu.au', subject: 'C one', receivedAt: '2026-06-01T04:00:00.000Z', matchTokens: ['from:@c.edu.au'], events: [{ title: 'C Event', startsAt: '2026-06-23T00:00:00.000Z' }] }),
      ];

      const { result, gmail, store, patches, locks } = await scan({
        // Given three processing jobs "job-a", "job-b" and "job-c"
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: 'A School', domain: 'a.edu.au' }),
          makeJob('job-b', { name: 'B', schoolName: 'B School', domain: 'b.edu.au' }),
          makeJob('job-c', { name: 'C', schoolName: 'C School', domain: 'c.edu.au' }),
        ],
        mailbox,
        // And the stored lastScanAt is "2026-05-21" so the query floor is 2026-05-19
        lastScanAt: '2026-05-21T00:00:00.000Z',
        now: () => clock,
        // 60s of runway minus the 30s safety margin: a 30s budget.
        getRemainingTimeInMillis: () => 60_000,
        // And the injected clock passes the deadline while job-b is being extracted
        onRequest: (_request, entry) => {
          if (entry && entry.id === 'b1') clock = START + 120_000;
        },
      });

      // Then job-a completes and its extracted events are persisted
      assert.ok(store.all().some((row) => row.title === 'A Event'));
      assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.OK);
      // And job-b's already-extracted events are persisted
      assert.ok(store.all().some((row) => row.title === 'B Event'));
      assert.ok(!store.all().some((row) => row.title === 'B Event Two'), 'the deadline stopped job-b before its second message');
      assert.equal(result.jobs[1].status, SCAN_JOB_STATUS.PARTIAL);
      assert.equal(result.jobs[1].truncated, true);
      // And job-c is never fetched from Gmail
      assert.equal(gmail.state.queries.length, 2);
      assert.ok(!gmail.state.queries.some((q) => q.includes('c.edu.au')));
      // And the jobs entry for "job-c" reports status "not_attempted" with all counts zero
      assert.deepEqual(result.jobs[2], {
        processingJobId: 'job-c',
        name: 'C',
        status: SCAN_JOB_STATUS.NOT_ATTEMPTED,
        messagesScanned: 0,
        eventsCreated: 0,
        eventsUpdated: 0,
        skipped: 0,
        truncated: false,
        errors: 0,
      });
      // And the result reports truncated true and status "partial"
      assert.equal(result.truncated, true);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      // And lastScanAt is written as the query floor, not as any newestReceivedAt
      assert.equal(patches.length, 1);
      assert.equal(patches[0].lastScanAt, '2026-05-19T00:00:00.000Z');
      // And the scan lock is released
      assert.equal(locks.acquired, 1);
      assert.equal(locks.released, 1);
    });
  });

  describe('Scenario: One truncated job pins the watermark for the whole run', () => {
    it("Given job-a's fetch is truncated and job-b completes cleanly, When a scan runs, Then the watermark is this run's own query floor", async () => {
      const mailbox = [
        mail({ id: 'a1', from: 'office@a.edu.au', subject: 'A one', receivedAt: '2026-06-01T01:00:00.000Z', matchTokens: ['from:@a.edu.au'], events: [{ title: 'A One', startsAt: '2026-06-20T00:00:00.000Z' }] }),
        mail({ id: 'a2', from: 'office@a.edu.au', subject: 'A two', receivedAt: '2026-06-01T02:00:00.000Z', matchTokens: ['from:@a.edu.au'], events: [{ title: 'A Two', startsAt: '2026-06-21T00:00:00.000Z' }] }),
        mail({ id: 'b1', from: 'office@b.edu.au', subject: 'B one', receivedAt: '2026-06-01T03:00:00.000Z', matchTokens: ['from:@b.edu.au'], events: [{ title: 'B One', startsAt: '2026-06-22T00:00:00.000Z' }] }),
      ];

      // A whole-invocation budget of 2 over two jobs gives each job one message,
      // which is fewer than job-a's mailbox holds - a real truncation.
      const { result, patches } = await scan({
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: 'A School', domain: 'a.edu.au' }),
          makeJob('job-b', { name: 'B', schoolName: 'B School', domain: 'b.edu.au' }),
        ],
        mailbox,
        maxMessages: 2,
        lastScanAt: '2026-05-21T00:00:00.000Z',
      });

      assert.equal(result.jobs[0].truncated, true, "job-a's fetch reports truncated true");
      assert.equal(result.jobs[1].truncated, false, 'job-b completes cleanly');
      // Then lastScanAt is written as this run's own query floor
      assert.equal(patches[0].lastScanAt, '2026-05-19T00:00:00.000Z');
      // And the result reports truncated true and status "partial"
      assert.equal(result.truncated, true);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
    });
  });

  describe('Scenario: A job with no usable search fields is skipped rather than querying the whole mailbox', () => {
    it('Given job-a is blank and job-b is configured, When a scan runs, Then only job-b is searched and no bare after: query is sent', async () => {
      const mailbox = [
        mail({ id: 'b1', from: 'office@riverside.edu.au', subject: 'B one', receivedAt: '2026-06-01T03:00:00.000Z', matchTokens: ['from:@riverside.edu.au'], events: [{ title: 'B One', startsAt: '2026-06-22T00:00:00.000Z' }] }),
      ];

      const { result, gmail, store } = await scan({
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: '', domain: '', searchTerms: [] }),
          makeJob('job-b', { name: 'B', schoolName: 'Riverside High', domain: 'riverside.edu.au' }),
        ],
        mailbox,
        lastScanAt: '2026-05-21T00:00:00.000Z',
      });

      // Then no Gmail search is performed for "job-a"
      assert.equal(gmail.state.queries.length, 1);
      // And no query containing a bare "after:" clause is ever sent
      for (const query of gmail.state.queries) {
        assert.match(query, /^\(.+\) after:/, 'every query opens with a non-empty OR group');
        assert.ok(!/^after:/.test(query));
        assert.ok(!query.includes('()'));
      }
      // And the jobs entry for "job-a" reports status "not_configured" with all counts zero
      assert.deepEqual(result.jobs[0], {
        processingJobId: 'job-a',
        name: 'A',
        status: SCAN_JOB_STATUS.NOT_CONFIGURED,
        messagesScanned: 0,
        eventsCreated: 0,
        eventsUpdated: 0,
        skipped: 0,
        truncated: false,
        errors: 0,
      });
      // And job-b is still scanned normally
      assert.equal(result.jobs[1].status, SCAN_JOB_STATUS.OK);
      assert.equal(result.jobs[1].messagesScanned, 1);
      assert.equal(store.all()[0].processingJobId, 'job-b');
    });
  });

  describe('Scenario: Every job unusable reports not_configured without taking the scan lock', () => {
    it('Given every job is blank, When a scan runs, Then not_configured is returned with no lock and no Gmail or Anthropic call', async () => {
      const { result, gmail, anthropic, locks, patches } = await scan({
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: '', domain: '', searchTerms: [] }),
          makeJob('job-b', { name: 'B', schoolName: '   ', domain: ' ', searchTerms: ['  '] }),
        ],
      });

      // Then the result status is "not_configured"
      assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      // And no scan lock is acquired
      assert.equal(locks.acquired, 0);
      assert.equal(locks.released, 0);
      // And no Gmail or Anthropic call is made
      assert.equal(gmail.state.queries.length, 0);
      assert.equal(gmail.state.fetchedIds.length, 0);
      assert.equal(anthropic.state.requests.length, 0);
      assert.equal(patches.length, 0);
      assert.deepEqual(result.jobs.map((entry) => entry.status), [SCAN_JOB_STATUS.NOT_CONFIGURED, SCAN_JOB_STATUS.NOT_CONFIGURED]);
    });
  });

  describe("Scenario: One job's fetch failure does not abort the remaining jobs", () => {
    it("Given job-b's Gmail fetch fails, When a scan runs, Then job-a and job-c still run and the run is partial", async () => {
      const mailbox = [
        mail({ id: 'a1', from: 'office@a.edu.au', subject: 'A one', receivedAt: '2026-06-01T01:00:00.000Z', matchTokens: ['from:@a.edu.au'], events: [{ title: 'A One', startsAt: '2026-06-20T00:00:00.000Z' }] }),
        mail({ id: 'b1', from: 'office@b.edu.au', subject: 'B one', receivedAt: '2026-06-01T02:00:00.000Z', matchTokens: ['from:@b.edu.au'], events: [{ title: 'B One', startsAt: '2026-06-21T00:00:00.000Z' }] }),
        mail({ id: 'c1', from: 'office@c.edu.au', subject: 'C one', receivedAt: '2026-06-01T03:00:00.000Z', matchTokens: ['from:@c.edu.au'], events: [{ title: 'C One', startsAt: '2026-06-22T00:00:00.000Z' }] }),
      ];

      const { result, gmail, store, patches } = await scan({
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: 'A School', domain: 'a.edu.au' }),
          makeJob('job-b', { name: 'B', schoolName: 'B School', domain: 'b.edu.au' }),
          makeJob('job-c', { name: 'C', schoolName: 'C School', domain: 'c.edu.au' }),
        ],
        mailbox,
        lastScanAt: '2026-05-21T00:00:00.000Z',
        // And job-b's Gmail fetch throws a GmailApiError (a persistent 500).
        failWhenQueryHas: 'b.edu.au',
      });

      // Then job-a and job-c are still fetched and extracted
      assert.equal(gmail.state.queries.length, 3);
      const titles = store.all().map((row) => row.title).sort();
      assert.deepEqual(titles, ['A One', 'C One']);
      // And the jobs entry for "job-b" reports status "error" with errors 1
      assert.equal(result.jobs[1].status, SCAN_JOB_STATUS.ERROR);
      assert.equal(result.jobs[1].errors, 1);
      assert.equal(result.jobs[1].messagesScanned, 0);
      // And the top-level errors array contains that job's error
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].id, '');
      assert.match(result.errors[0].error, /Gmail/i);
      // And the result status is "partial"
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      // And lastScanAt is written as this run's own query floor
      assert.equal(patches[0].lastScanAt, '2026-05-19T00:00:00.000Z');
    });
  });

  describe('Scenario: A revoked grant aborts the whole loop', () => {
    it("Given job-b's fetch throws ReauthRequiredError, When a scan runs, Then job-c is never fetched and counts are zeroed", async () => {
      const mailbox = [
        mail({ id: 'a1', from: 'office@a.edu.au', subject: 'A one', receivedAt: '2026-06-01T01:00:00.000Z', matchTokens: ['from:@a.edu.au'], events: [{ title: 'A One', startsAt: '2026-06-20T00:00:00.000Z' }] }),
        mail({ id: 'c1', from: 'office@c.edu.au', subject: 'C one', receivedAt: '2026-06-01T03:00:00.000Z', matchTokens: ['from:@c.edu.au'], events: [{ title: 'C One', startsAt: '2026-06-22T00:00:00.000Z' }] }),
      ];

      let tokenMints = 0;
      const { result, gmail, patches, locks } = await scan({
        jobs: [
          makeJob('job-a', { name: 'A', schoolName: 'A School', domain: 'a.edu.au' }),
          makeJob('job-b', { name: 'B', schoolName: 'B School', domain: 'b.edu.au' }),
          makeJob('job-c', { name: 'C', schoolName: 'C School', domain: 'c.edu.au' }),
        ],
        mailbox,
        lastScanAt: '2026-05-21T00:00:00.000Z',
        getAccessToken: async () => {
          tokenMints += 1;
          if (tokenMints === 2) throw new ReauthRequiredError('the grant was revoked');
          return 'access-token';
        },
      });

      // Then job-c is never fetched
      assert.equal(tokenMints, 2, 'the loop stopped at job-b');
      assert.ok(!gmail.state.queries.some((q) => q.includes('c.edu.au')));
      // And the result status is "reauth_required" with all counts zero
      assert.equal(result.status, SCAN_STATUS.REAUTH_REQUIRED);
      assert.equal(result.messagesScanned, 0);
      assert.equal(result.eventsCreated, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.errors, []);
      for (const entry of result.jobs) {
        assert.equal(entry.messagesScanned, 0);
        assert.equal(entry.eventsCreated, 0);
        assert.equal(entry.errors, 0);
      }
      // And no lastScanAt patch is written
      assert.equal(patches.length, 0);
      // And the scan lock is released
      assert.equal(locks.acquired, 1);
      assert.equal(locks.released, 1);
    });
  });

  describe('Scenario: A manual scan splits its message budget across jobs', () => {
    it('Given five jobs and a manual cap of 50, When the scan runs, Then each job asks Gmail for at most 10 messages', async () => {
      const jobs = ['a', 'b', 'c', 'd', 'e'].map((key) =>
        makeJob(`job-${key}`, { name: key.toUpperCase(), schoolName: `${key} School`, domain: `${key}.edu.au` })
      );

      const { gmail } = await scan({ jobs, mode: 'manual', lastScanAt: '2026-05-21T00:00:00.000Z' });

      assert.equal(MANUAL_SCAN_MAX_MESSAGES, 50);
      assert.equal(gmail.state.listUrls.length, 5);
      const asked = gmail.state.listUrls.map((url) => Number(new URL(url).searchParams.get('maxResults')));
      // Then each job's fetch is asked for at most 10 messages
      assert.deepEqual(asked, [10, 10, 10, 10, 10]);
      // And the total messages fetched across all jobs does not exceed 50
      assert.ok(asked.reduce((sum, n) => sum + n, 0) <= 50);
    });
  });

  describe('Scenario: A quote typed into a search term cannot break out of its clause', () => {
    it('Given a search term containing a quote and an operator, When the query is built, Then it is one quoted token in one OR group', () => {
      const job = makeJob('job-a', {
        name: 'A',
        schoolName: '',
        domain: '',
        searchTerms: ['Year "4" OR from:@evil.example'],
      });

      const query = buildJobQuery({ job, since: new Date('2026-05-19T00:00:00.000Z') });

      // Then the emitted clause is a single quoted token containing no unescaped double quote
      assert.equal(query, '("Year 4 OR from:@evil.example") after:2026/05/19');
      assert.equal((query.match(/"/g) || []).length, 2);
      // And the query still contains exactly one parenthesised OR group followed by the after: clause
      assert.equal((query.match(/\(/g) || []).length, 1);
      assert.equal((query.match(/\)/g) || []).length, 1);
      assert.match(query, /^\(.+\) after:2026\/05\/19$/);
    });
  });

  describe('Scenario: eventId derivation is unchanged by this ticket', () => {
    it('Given a message id, a title and a start instant, When the eventId is derived, Then it is the pinned sha256 and is unaffected by attribution', () => {
      const id = deriveEventId({ sourceMessageId: 'm1', title: 'Year 4 Excursion', startsAt: '2026-06-10T00:00:00.000Z' });

      // Then it equals the sha256 of "m1|year 4 excursion|2026-06-10T00:00:00.000Z"
      assert.equal(id, 'c28189d0f74204244d1cf91d4a425d5b2d03895fb506d05f8e47e048ec5522c0');
      // And it is identical whether or not a processingJobId was supplied
      assert.equal(deriveEventId({ sourceMessageId: 'm1', title: 'YEAR 4 EXCURSION ', startsAt: '2026-06-10T00:00:00.000Z' }), id);
      assert.equal(
        deriveEventId({ sourceMessageId: 'm1', title: 'Year 4 Excursion', startsAt: '2026-06-10T00:00:00.000Z', processingJobId: 'job-b' }),
        id,
        'the hash takes no new input: a processingJobId in the args object changes nothing'
      );
    });
  });
});
