/**
 * task-056-per-job-search.test.js - TASK-056 UNIT tests.
 *
 * One `describe` per Acceptance Criterion (or per tight group of them), naming
 * the AC number so a failure points straight back at the ticket. Covers:
 *
 *   gmail.mjs   - buildJobQuery / buildJobClauses / toQueryPhrase /
 *                 toSearchTermList / hasJobQueryClauses, and the job-aware
 *                 fetchCandidateMessages seam (AC 1-8, 35, 36).
 *   scan.mjs    - toProcessingJobs, the per-job loop, the budget split, the
 *                 deadline, the watermark and the report shape (AC 9-24, 39-46).
 *   events.mjs  - processingJobId threading, deriveEventId stability,
 *                 LIFECYCLE_ATTRIBUTES, first-seen-wins, the public projection
 *                 (AC 25-29, 31, 37, 38, 44, 45).
 *   anthropic.mjs - per-job extraction context, DECISION A, the byte-stable
 *                 system prompt and the queryMatched cost-gate bypass
 *                 (AC 30, 32-34).
 *
 * EVERY collaborator is injected. No DynamoDB client, no Gmail HTTP call and no
 * Anthropic call is made anywhere in this file: `batchWrite`/`batchGet`,
 * `fetchImpl`, `createMessage`, `getAccessToken`, `getConnection`,
 * `updateConnection`, the scan lock and the clock are all stubs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createHash } from 'node:crypto';

import {
  buildQuery,
  buildJobQuery,
  buildJobClauses,
  hasJobQueryClauses,
  toQueryPhrase,
  toSearchTermList,
  fetchCandidateMessages,
} from '../../src/lambda/calendar/backend/gmail.mjs';

import {
  runScan,
  toProcessingJobs,
  computeSince,
  SCAN_STATUS,
  SCAN_JOB_STATUS,
  MANUAL_SCAN_MAX_MESSAGES,
} from '../../src/lambda/calendar/backend/scan.mjs';

import {
  buildEventItem,
  buildEventItems,
  storeEvents,
  deriveEventId,
  applyPreservedLifecycle,
  toEventJson,
  LIFECYCLE_ATTRIBUTES,
  PUBLIC_EVENT_FIELDS,
  SKIP_REASON,
  EVENT_STATUS,
} from '../../src/lambda/calendar/backend/events.mjs';

import {
  buildRequest,
  buildUserContent,
  extractFromMessage,
  isWatchedSender,
  EXTRACTION_STATUS,
  EXTRACTION_SYSTEM_PROMPT,
  DATA_TAGS,
} from '../../src/lambda/calendar/backend/anthropic.mjs';

import { ReauthRequiredError } from '../../src/lambda/calendar/backend/google-token.mjs';
import { ALARM_TOKENS } from '../../src/lambda/calendar/backend/alarms.mjs';

const USER = 'google#sub-1';
const ENV = { CALENDAR_LOG_LEVEL: 'none', CALENDAR_EVENTS_TABLE: 'test-calendar-events' };
const SINCE = new Date('2026-05-19T00:00:00.000Z');

/** A fully populated processing job; override any field per test. */
function makeJob(id, over = {}) {
  return {
    id,
    name: `${id} display name`,
    schoolName: `${id} School`,
    domain: `${id}.edu.au`,
    searchTerms: [],
    ...over,
  };
}

/** An empty per-job fetch result, in `fetchCandidateMessages`'s exact shape. */
function emptyFetch(over = {}) {
  return { messages: [], truncated: false, errors: [], newestReceivedAt: null, ...over };
}

function makeMessage(id, over = {}) {
  return {
    id,
    threadId: `t-${id}`,
    subject: 'Newsletter',
    from: 'office@example.edu.au',
    receivedAt: '2026-06-01T00:00:00.000Z',
    snippet: '',
    body: 'Body text',
    ...over,
  };
}

/**
 * Drive `runScan` with every collaborator stubbed, recording what it did.
 *
 * @returns {Promise<{ result: object, calls: object }>}
 */
async function runScanWith({
  jobs = [],
  connectionExtra = {},
  lastScanAt = null,
  mode = 'scheduled',
  maxMessages = null,
  onFetch = async () => emptyFetch(),
  onExtract = async () => ({ events: [] }),
  onStore = async () => ({ written: 0, skipped: [] }),
  now = () => Date.parse('2026-06-02T00:00:00.000Z'),
  getRemainingTimeInMillis = null,
  log = () => {},
  env = ENV,
} = {}) {
  const calls = {
    fetches: [],
    extracts: [],
    stores: [],
    patches: [],
    alarms: [],
    locks: 0,
    unlocks: 0,
    connectionReads: 0,
  };

  const result = await runScan(
    { userId: USER, mode, maxMessages },
    {
      env,
      log,
      now,
      getRemainingTimeInMillis,
      getConnection: async () => {
        calls.connectionReads += 1;
        return { userId: USER, processingJobs: jobs, lastScanAt, ...connectionExtra };
      },
      updateConnection: async (userId, patch) => {
        calls.patches.push(patch);
      },
      acquireScanLock: async () => {
        calls.locks += 1;
        return true;
      },
      releaseScanLock: async () => {
        calls.unlocks += 1;
      },
      fetchCandidateMessages: async (args) => {
        calls.fetches.push(args);
        return onFetch(args);
      },
      extractFromMessage: async (args) => {
        calls.extracts.push(args);
        return onExtract(args);
      },
      storeEvents: async (args) => {
        calls.stores.push(args);
        return onStore(args);
      },
      emitAlarm: (token, fields) => {
        calls.alarms.push({ token, fields });
      },
    }
  );

  return { result, calls };
}

describe('TASK-056 unit: per-job Gmail search and event attribution', () => {
  /* =====================================================================
   * gmail.mjs - per-job query construction (AC 1-8)
   * ===================================================================== */

  describe('AC 1: a job-aware query builder takes one job plus since/sinceDays/now', () => {
    it('Given a full job and a since date, When buildJobQuery is called, Then it returns one Gmail search string', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: "St Mary's Primary", domain: 'stmarys.edu.au', searchTerms: ['Year 4'] }),
        since: SINCE,
        now: () => new Date('2026-08-17T00:00:00.000Z'),
      });

      assert.equal(typeof query, 'string');
      assert.equal(query, '(from:@stmarys.edu.au OR "St Mary\'s Primary" OR "Year 4") after:2026/05/19');
    });

    it('Given no since, When buildJobQuery is called with sinceDays and now, Then the floor is now minus sinceDays', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: '', domain: 'stmarys.edu.au', searchTerms: [] }),
        since: null,
        sinceDays: 90,
        now: () => new Date('2026-08-17T00:00:00.000Z'),
      });

      assert.equal(query, '(from:@stmarys.edu.au) after:2026/05/19');
    });
  });

  describe('AC 2: clause order is domain, school name, then each search term; blanks dropped, duplicates emitted once', () => {
    it('Given all three fields, When the clauses are built, Then they appear in the contractual order', () => {
      const clauses = buildJobClauses({
        domain: 'STMARYS.edu.au',
        schoolName: "St Mary's Primary",
        searchTerms: ['Year 4', 'Canteen'],
      });

      assert.deepEqual(clauses, ['from:@stmarys.edu.au', '"St Mary\'s Primary"', '"Year 4"', '"Canteen"']);
    });

    it('Given the domain arrives as "@School.EDU", When clauses are built, Then normalizeDomain is the one definition used', () => {
      assert.deepEqual(buildJobClauses({ domain: '@School.EDU', schoolName: '', searchTerms: [] }), ['from:@school.edu']);
    });

    it('Given blank and whitespace entries, When clauses are built, Then they are dropped', () => {
      const clauses = buildJobClauses({
        domain: '   ',
        schoolName: '   ',
        searchTerms: ['', '   ', 'Canteen'],
      });

      assert.deepEqual(clauses, ['"Canteen"']);
    });

    it('Given a search term equal to the school name in a different case, When clauses are built, Then the duplicate is emitted once', () => {
      const clauses = buildJobClauses({
        domain: 'stmarys.edu.au',
        schoolName: 'St Mary',
        searchTerms: ['st mary', 'ST MARY', 'Canteen'],
      });

      assert.deepEqual(clauses, ['from:@stmarys.edu.au', '"St Mary"', '"Canteen"']);
    });
  });

  describe('AC 3: clauses are OR-joined inside ONE pair of parentheses with after: outside', () => {
    it('Given a three-clause job, When the query is built, Then there is exactly one group and after: sits outside it', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: "St Mary's Primary", domain: 'stmarys.edu.au', searchTerms: ['Year 4'] }),
        since: SINCE,
      });

      assert.equal((query.match(/\(/g) || []).length, 1, 'exactly one opening parenthesis');
      assert.equal((query.match(/\)/g) || []).length, 1, 'exactly one closing parenthesis');
      assert.match(query, /^\(.+\) after:\d{4}\/\d{2}\/\d{2}$/, 'after: is outside the group');
      assert.ok(!/after:\d{4}-\d{2}-\d{2}/.test(query), 'the after: date is never ISO-8601');
    });

    it('Given a since date, When the query is built, Then the after: value is formatGmailDate output (YYYY/MM/DD, UTC)', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: '', domain: 'd.edu', searchTerms: [] }),
        since: new Date('2026-05-19T23:59:59.000Z'),
      });

      assert.equal(query, '(from:@d.edu) after:2026/05/19');
    });
  });

  describe('AC 4 / AC 46: regression guard - a domain-only job is byte-identical to today\'s buildQuery', () => {
    it('Given a job whose only usable field is its domain, When both builders run for the same since, Then the strings are byte-identical', () => {
      const domain = 'stmarys.edu.au';
      const legacy = buildQuery({ searchDomains: [domain], since: SINCE });
      const perJob = buildJobQuery({
        job: makeJob('job-a', { schoolName: '', domain, searchTerms: [] }),
        since: SINCE,
      });

      assert.equal(perJob, legacy);
      assert.equal(perJob, '(from:@stmarys.edu.au) after:2026/05/19');
    });

    it('Given a school name that neutralises to nothing, When the query is built, Then it is still the bare domain form', () => {
      const perJob = buildJobQuery({
        job: makeJob('job-a', { schoolName: '""""', domain: 'stmarys.edu.au', searchTerms: ['  '] }),
        since: SINCE,
      });

      assert.equal(perJob, buildQuery({ searchDomains: ['stmarys.edu.au'], since: SINCE }));
    });
  });

  describe('AC 5: a double quote inside a value cannot break out of its clause', () => {
    it('Given a search term containing a quote and an operator, When the phrase is built, Then it is one quoted token with no inner quote', () => {
      const phrase = toQueryPhrase('Year "4" OR from:@evil.example');

      assert.equal(phrase, '"Year 4 OR from:@evil.example"');
      assert.equal((phrase.match(/"/g) || []).length, 2, 'exactly the opening and closing quote');
      assert.ok(!phrase.slice(1, -1).includes('"'), 'no double quote survives inside the token');
    });

    it('Given typographic quotes pasted from a word processor, When the phrase is built, Then those are stripped too', () => {
      assert.equal(toQueryPhrase('“Year 4”'), '"Year 4"');
    });

    it('Given newlines and control characters, When the phrase is built, Then they collapse to single spaces', () => {
      assert.equal(toQueryPhrase('Year\n4\tExcursion Day'), '"Year 4 Excursion Day"');
    });

    it('Given a value that is nothing but quotes, When the phrase is built, Then it is dropped as if blank', () => {
      assert.equal(toQueryPhrase('""'), '');
      assert.deepEqual(buildJobClauses({ domain: '', schoolName: '""', searchTerms: ['“”'] }), []);
    });

    it('Given a quote-bearing term inside a real job, When the query is built, Then it still has one OR group and one after: clause', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: '', domain: '', searchTerms: ['Year "4" OR from:@evil.example'] }),
        since: SINCE,
      });

      assert.equal(query, '("Year 4 OR from:@evil.example") after:2026/05/19');
      assert.equal((query.match(/\(/g) || []).length, 1);
      assert.equal((query.match(/"/g) || []).length, 2);
    });
  });

  describe('AC 6 / AC 41: a job with zero usable clauses never produces a query', () => {
    it('Given a job with all three fields blank, When buildJobQuery is called, Then it throws code "no_job_query"', () => {
      assert.throws(
        () => buildJobQuery({ job: { id: 'job-a', name: 'x', schoolName: '  ', domain: '', searchTerms: [] }, since: SINCE }),
        (err) => err.code === 'no_job_query',
        'must refuse with a distinguishable code, mirroring no_search_domains'
      );
    });

    it('Given an absent job, When buildJobQuery is called, Then it throws rather than emitting a bare after: query', () => {
      assert.throws(() => buildJobQuery({ job: undefined, since: SINCE }), (err) => err.code === 'no_job_query');
      assert.throws(() => buildJobQuery({}), (err) => err.code === 'no_job_query');
    });

    it('Given the usability probe, When it is asked about usable and unusable jobs, Then it answers without building a query', () => {
      assert.equal(hasJobQueryClauses(makeJob('job-a')), true);
      assert.equal(hasJobQueryClauses({ id: 'x', schoolName: '', domain: '', searchTerms: [] }), false);
      assert.equal(hasJobQueryClauses(undefined), false);
    });
  });

  describe('AC 35: a job with searchTerms: [] queries on domain and school name only', () => {
    it('Given no search terms, When the query is built, Then it holds exactly the two other clauses', () => {
      const query = buildJobQuery({
        job: makeJob('job-a', { schoolName: 'Riverside High', domain: 'riverside.edu.au', searchTerms: [] }),
        since: SINCE,
      });

      assert.equal(query, '(from:@riverside.edu.au OR "Riverside High") after:2026/05/19');
    });
  });

  describe('toSearchTermList tolerates the stored shapes without re-normalising the user\'s words', () => {
    it('Given a Set, an array, a DynamoDB SS list or a lone string, When coerced, Then order and casing survive', () => {
      assert.deepEqual(toSearchTermList(['Year 4', ' Canteen ']), ['Year 4', 'Canteen']);
      assert.deepEqual(toSearchTermList(new Set(['Year 4'])), ['Year 4']);
      assert.deepEqual(toSearchTermList({ SS: ['Year 4', ''] }), ['Year 4']);
      assert.deepEqual(toSearchTermList('Year 4, Kindy'), ['Year 4, Kindy'], 'a typed phrase is never split on commas');
      assert.deepEqual(toSearchTermList(null), []);
    });
  });

  describe('AC 7: fetchCandidateMessages accepts the job and keeps its return contract', () => {
    /** A Gmail transport stub: one list page, then one message per id. */
    function gmailStub({ ids = ['m1'], failIds = [], capture = {} } = {}) {
      return async (url) => {
        if (url.includes('/messages?')) {
          capture.listUrl = url;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ messages: ids.map((id) => ({ id })) }),
          };
        }
        const id = decodeURIComponent(url.split('/messages/')[1].split('?')[0]);
        if (failIds.includes(id)) return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            id,
            threadId: `t-${id}`,
            internalDate: String(Date.parse(`2026-06-0${ids.indexOf(id) + 1}T00:00:00.000Z`)),
            snippet: 'snip',
            payload: {
              headers: [
                { name: 'Subject', value: 'Newsletter' },
                { name: 'From', value: 'office@stmarys.edu.au' },
              ],
              mimeType: 'text/plain',
              body: { data: Buffer.from('Hello body').toString('base64url') },
            },
          }),
        };
      };
    }

    const gmailDeps = (fetchImpl, extra = {}) => ({
      getAccessToken: async () => 'token',
      getConnection: async () => {
        throw new Error('the job path must not read the connection');
      },
      fetchImpl,
      sleep: async () => {},
      random: () => 0,
      now: () => Date.parse('2026-08-17T00:00:00.000Z'),
      env: { CALENDAR_LOG_LEVEL: 'none' },
      ...extra,
    });

    it('Given a job, When fetchCandidateMessages runs, Then the job query is what Gmail is asked for', async () => {
      const capture = {};
      const result = await fetchCandidateMessages(
        {
          userId: USER,
          since: SINCE,
          job: makeJob('job-a', { schoolName: "St Mary's Primary", domain: 'stmarys.edu.au', searchTerms: ['Year 4'] }),
        },
        gmailDeps(gmailStub({ ids: ['m1', 'm2'], capture }))
      );

      const q = decodeURIComponent(new URL(capture.listUrl).searchParams.get('q'));
      assert.equal(q, '(from:@stmarys.edu.au OR "St Mary\'s Primary" OR "Year 4") after:2026/05/19');
      assert.deepEqual(Object.keys(result).sort(), ['errors', 'messages', 'newestReceivedAt', 'truncated']);
      assert.equal(result.messages.length, 2);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.errors, []);
      assert.equal(result.newestReceivedAt, '2026-06-02T00:00:00.000Z', 'the max across successes');
    });

    it('Given a pre-built query, When fetchCandidateMessages runs, Then it is used verbatim', async () => {
      const capture = {};
      await fetchCandidateMessages(
        { userId: USER, since: SINCE, query: '  (from:@a.edu) after:2026/01/01  ' },
        gmailDeps(gmailStub({ ids: ['m1'], capture }))
      );

      assert.equal(decodeURIComponent(new URL(capture.listUrl).searchParams.get('q')), '(from:@a.edu) after:2026/01/01');
    });

    it('Given one message fetch fails, When the job is fetched, Then only that id lands in errors and newestReceivedAt ignores it', async () => {
      const result = await fetchCandidateMessages(
        { userId: USER, since: SINCE, job: makeJob('job-a') },
        gmailDeps(gmailStub({ ids: ['m1', 'm2'], failIds: ['m2'] }))
      );

      assert.equal(result.messages.length, 1);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].id, 'm2');
      assert.equal(result.newestReceivedAt, '2026-06-01T00:00:00.000Z', 'computed from successes only');
    });

    it('Given a revoked grant mid-fetch, When the job is fetched, Then ReauthRequiredError is rethrown untouched', async () => {
      // A 401 on the message fetch drives the one re-mint; the re-mint is what
      // discovers the grant is gone.
      const unauthorised = async (url) => {
        if (url.includes('/messages?')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: 'm1' }] }) };
        }
        return { ok: false, status: 401, text: async () => '{"error":"invalid_grant"}' };
      };

      await assert.rejects(
        fetchCandidateMessages(
          { userId: USER, since: SINCE, job: makeJob('job-a') },
          gmailDeps(unauthorised, {
            getAccessToken: async (_userId, options = {}) => {
              if (options.forceRefresh) throw new ReauthRequiredError('revoked');
              return 'token';
            },
          })
        ),
        (err) => err instanceof ReauthRequiredError
      );
    });

    it('Given a clause-less job, When fetchCandidateMessages runs, Then no HTTP call is made and no_job_query propagates', async () => {
      let httpCalls = 0;
      await assert.rejects(
        fetchCandidateMessages(
          { userId: USER, since: SINCE, job: { id: 'job-a', schoolName: '', domain: '', searchTerms: [] } },
          gmailDeps(async () => {
            httpCalls += 1;
            return { ok: true, status: 200, text: async () => '{}' };
          })
        ),
        (err) => err.code === 'no_job_query'
      );
      assert.equal(httpCalls, 0, 'a bare after: query is never sent to Gmail');
    });
  });

  describe('AC 8: gmail.mjs logs the opaque processingJobId and never the query, name, schoolName or terms', () => {
    it('Given a job with distinctive text, When it is fetched, Then no log line carries any of that text', async () => {
      const lines = [];
      const job = makeJob('job-a', {
        name: 'ZZZ-JOB-NAME',
        schoolName: 'ZZZ-SCHOOL-NAME',
        domain: 'stmarys.edu.au',
        searchTerms: ['ZZZ-SEARCH-TERM'],
      });

      await fetchCandidateMessages(
        { userId: USER, since: SINCE, job },
        {
          getAccessToken: async () => 'token',
          getConnection: async () => ({}),
          fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ messages: [] }) }),
          sleep: async () => {},
          random: () => 0,
          now: () => Date.parse('2026-08-17T00:00:00.000Z'),
          env: { CALENDAR_LOG_LEVEL: 'basic' },
          log: (message, fields) => lines.push({ message, fields }),
        }
      );

      const serialised = JSON.stringify(lines);
      for (const banned of ['ZZZ-JOB-NAME', 'ZZZ-SCHOOL-NAME', 'ZZZ-SEARCH-TERM', 'from:@', 'after:']) {
        assert.ok(!serialised.includes(banned), `a log line must not contain "${banned}"`);
      }
      const complete = lines.find((line) => line.message === 'calendar.gmail.scan_complete');
      assert.ok(complete, 'the scan_complete line is still emitted');
      assert.equal(complete.fields.processingJobId, 'job-a', 'the job is identified by its opaque id');
    });
  });

  /* =====================================================================
   * scan.mjs - the per-job loop (AC 9-24, 36, 39-46)
   * ===================================================================== */

  describe('AC 9: jobs come from connection.processingJobs, with a legacy fallback', () => {
    it('Given a stored processingJobs array, When it is read, Then every field is normalised in settings order', () => {
      const jobs = toProcessingJobs({
        processingJobs: [
          { id: 'job-a', name: ' St Mary\'s ', schoolName: ' St Mary\'s Primary ', domain: ' stmarys.edu.au ', searchTerms: [' Year 4 ', ''] },
          { id: 'job-b', name: 'Riverside', schoolName: 'Riverside High', domain: 'riverside.edu.au', searchTerms: [] },
        ],
      });

      assert.equal(jobs.length, 2);
      assert.deepEqual(jobs[0], {
        id: 'job-a',
        name: "St Mary's",
        schoolName: "St Mary's Primary",
        domain: 'stmarys.edu.au',
        searchTerms: ['Year 4'],
      });
      assert.equal(jobs[1].id, 'job-b');
    });

    it('Given a low-level DynamoDB list shape, When it is read, Then it is tolerated rather than throwing mid-scan', () => {
      const jobs = toProcessingJobs({
        processingJobs: { L: [{ M: { id: { S: 'job-a' }, name: { S: 'A' }, schoolName: { S: 'A School' }, domain: { S: 'a.edu' }, searchTerms: { L: [{ S: 'Term' }] } } }] },
      });

      assert.deepEqual(jobs, [{ id: 'job-a', name: 'A', schoolName: 'A School', domain: 'a.edu', searchTerms: ['Term'] }]);
    });

    it('Given a legacy row with no processingJobs, When it is read, Then one job is synthesised per searchDomains entry so it still scans', () => {
      const jobs = toProcessingJobs({ searchDomains: new Set(['legacy.edu']), schoolNames: ['Legacy School'] });

      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].domain, 'legacy.edu');
      assert.equal(jobs[0].schoolName, 'Legacy School');
      assert.equal(jobs[0].id, 'legacy#legacy.edu', 'stable, and not derived from the array index');
    });

    it('Given a job with a blank id, When it is read, Then the blank id is kept rather than being invented', () => {
      const jobs = toProcessingJobs({ processingJobs: [{ id: '', name: 'n', schoolName: 's', domain: 'd.edu', searchTerms: [] }] });
      assert.equal(jobs[0].id, '', 'an index-derived id would move when the user reorders their jobs');
    });
  });

  describe('AC 10 / AC 36 / AC 41: not_configured takes no lock and calls nothing', () => {
    it('Given every job is unusable, When a scan runs, Then not_configured is returned with no lock, no Gmail and no Anthropic call', async () => {
      const { result, calls } = await runScanWith({
        jobs: [
          { id: 'job-a', name: 'A', schoolName: '', domain: '', searchTerms: [] },
          { id: 'job-b', name: 'B', schoolName: '   ', domain: '  ', searchTerms: ['  '] },
        ],
        onFetch: async () => {
          throw new Error('Gmail must not be called');
        },
      });

      assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      assert.equal(calls.locks, 0, 'no scan lock is acquired');
      assert.equal(calls.fetches.length, 0);
      assert.equal(calls.extracts.length, 0);
      assert.equal(calls.patches.length, 0);
      assert.deepEqual(
        result.jobs.map((entry) => entry.status),
        [SCAN_JOB_STATUS.NOT_CONFIGURED, SCAN_JOB_STATUS.NOT_CONFIGURED]
      );
      assert.equal(result.messagesScanned, 0);
      assert.equal(result.truncated, false);
    });

    it('Given no jobs at all, When a scan runs, Then not_configured is returned with an empty jobs array', async () => {
      const { result, calls } = await runScanWith({ jobs: [] });
      assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      assert.deepEqual(result.jobs, []);
      assert.equal(calls.locks, 0);
    });

    it('Given one usable and one unusable job, When a scan runs, Then the usable one still runs and the other reports not_configured', async () => {
      const { result, calls } = await runScanWith({
        jobs: [{ id: 'job-a', name: 'A', schoolName: '', domain: '', searchTerms: [] }, makeJob('job-b')],
      });

      assert.equal(calls.fetches.length, 1);
      assert.equal(calls.fetches[0].job.id, 'job-b');
      assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.NOT_CONFIGURED);
      assert.equal(result.jobs[0].messagesScanned, 0);
      assert.equal(result.jobs[1].status, SCAN_JOB_STATUS.OK);
    });
  });

  describe('AC 11: computeSince runs once and the same floor is every job\'s after: value', () => {
    it('Given three jobs, When a scan runs, Then every fetch gets the identical since instance', async () => {
      const now = () => Date.parse('2026-06-02T00:00:00.000Z');
      const { calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        now,
      });

      assert.equal(calls.fetches.length, 3);
      const first = calls.fetches[0].since;
      for (const call of calls.fetches) assert.equal(call.since, first, 'one shared floor object, not one per job');
      assert.equal(first.toISOString(), computeSince({ lastScanAt: '2026-05-21T00:00:00.000Z', now }).toISOString());
      assert.equal(first.toISOString(), '2026-05-19T00:00:00.000Z');
    });
  });

  describe('AC 12: computeDeadline runs once and bounds the whole loop', () => {
    it('Given a scan over three jobs, When it runs, Then getRemainingTimeInMillis is consulted exactly once', async () => {
      let remainingCalls = 0;
      await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        getRemainingTimeInMillis: () => {
          remainingCalls += 1;
          return 600_000;
        },
      });

      assert.equal(remainingCalls, 1, 'a per-job deadline would grant runway the invocation does not have');
    });

    it('Given the runway is already inside the safety margin, When a scan runs, Then no job is even fetched', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        getRemainingTimeInMillis: () => 0,
        onFetch: async () => {
          throw new Error('no job should be fetched with no runway');
        },
      });

      assert.equal(calls.fetches.length, 0);
      assert.deepEqual(result.jobs.map((j) => j.status), [SCAN_JOB_STATUS.NOT_ATTEMPTED, SCAN_JOB_STATUS.NOT_ATTEMPTED]);
      assert.equal(result.truncated, true);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
    });
  });

  describe('AC 13: the message budget is split across usable jobs, not multiplied', () => {
    it('Given a five-job manual scan, When it runs, Then each job is asked for floor(50/5) messages', async () => {
      const { calls } = await runScanWith({
        mode: 'manual',
        jobs: ['a', 'b', 'c', 'd', 'e'].map((k) => makeJob(`job-${k}`)),
      });

      assert.equal(MANUAL_SCAN_MAX_MESSAGES, 50);
      assert.equal(calls.fetches.length, 5);
      for (const call of calls.fetches) assert.equal(call.maxMessages, 10);
      assert.equal(calls.fetches.reduce((sum, c) => sum + c.maxMessages, 0), 50, 'the whole-invocation budget is not exceeded');
    });

    it('Given three usable jobs and two unusable ones, When it runs, Then unusable jobs do not count toward the split', async () => {
      const { calls } = await runScanWith({
        mode: 'manual',
        jobs: [
          makeJob('job-a'),
          { id: 'job-b', name: 'B', schoolName: '', domain: '', searchTerms: [] },
          makeJob('job-c'),
          { id: 'job-d', name: 'D', schoolName: '', domain: '', searchTerms: [] },
          makeJob('job-e'),
        ],
      });

      assert.equal(calls.fetches.length, 3);
      for (const call of calls.fetches) assert.equal(call.maxMessages, 16, 'floor(50/3), not floor(50/5)');
    });

    it('Given far more jobs than the cap, When it runs, Then each job still gets at least one message', async () => {
      const jobs = Array.from({ length: 60 }, (_, i) => makeJob(`job-${i}`));
      const { calls } = await runScanWith({ mode: 'manual', jobs });

      for (const call of calls.fetches) assert.equal(call.maxMessages, 1);
    });

    it('AC 46: Given exactly one job, When a manual scan runs, Then the budget is the whole cap', async () => {
      const { calls } = await runScanWith({ mode: 'manual', jobs: [makeJob('job-a')] });
      assert.equal(calls.fetches[0].maxMessages, MANUAL_SCAN_MAX_MESSAGES);
    });
  });

  describe('AC 14: jobs run sequentially in settings order', () => {
    it('Given three jobs, When a scan runs, Then fetch, extract and store happen job by job in order', async () => {
      const order = [];
      await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        onFetch: async ({ job }) => {
          order.push(`fetch:${job.id}`);
          return emptyFetch({ messages: [makeMessage(`m-${job.id}`)] });
        },
        onExtract: async ({ message }) => {
          order.push(`extract:${message.id}`);
          return { events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] };
        },
        onStore: async ({ processingJobId }) => {
          order.push(`store:${processingJobId}`);
          return { written: 1, skipped: [] };
        },
      });

      assert.deepEqual(order, [
        'fetch:job-a', 'extract:m-job-a', 'store:job-a',
        'fetch:job-b', 'extract:m-job-b', 'store:job-b',
        'fetch:job-c', 'extract:m-job-c', 'store:job-c',
      ]);
    });
  });

  describe('AC 15 / AC 43: one job\'s fetch failure is contained; a revoked grant is not', () => {
    it('Given job-b\'s fetch throws, When a scan runs, Then jobs a and c still run and job-b reports error', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        onFetch: async ({ job }) => {
          if (job.id === 'job-b') throw new Error('Gmail 503');
          return emptyFetch();
        },
      });

      assert.equal(calls.fetches.length, 3, 'the loop continued past the failure');
      assert.equal(result.jobs[1].status, SCAN_JOB_STATUS.ERROR);
      assert.equal(result.jobs[1].errors, 1);
      assert.equal(result.errors.length, 1);
      assert.deepEqual(result.errors[0], { id: '', error: 'Gmail 503' });
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
    });

    it('Given job-b\'s fetch throws ReauthRequiredError, When a scan runs, Then job-c is never fetched and counts are zeroed', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        onFetch: async ({ job }) => {
          if (job.id === 'job-b') throw new ReauthRequiredError('revoked');
          return emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' });
        },
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(calls.fetches.length, 2, 'job-c is never fetched');
      assert.equal(result.status, SCAN_STATUS.REAUTH_REQUIRED);
      assert.equal(result.messagesScanned, 0);
      assert.equal(result.eventsCreated, 0);
      assert.equal(result.skipped, 0);
      assert.deepEqual(result.errors, []);
      for (const entry of result.jobs) {
        assert.equal(entry.messagesScanned, 0);
        assert.equal(entry.eventsCreated, 0);
        assert.equal(entry.errors, 0);
      }
      assert.equal(calls.patches.length, 0, 'no lastScanAt patch is written on the reauth path');
      assert.equal(calls.unlocks, 1, 'the scan lock is still released');
    });
  });

  describe('AC 16: a per-message extraction failure costs only that message', () => {
    it('Given one of two messages throws during extraction, When the job runs, Then the other is still extracted and an alarm names only the error type', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a')],
        onFetch: async () => emptyFetch({ messages: [makeMessage('m1'), makeMessage('m2')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async ({ message }) => {
          if (message.id === 'm1') {
            const err = new Error('model exploded');
            err.name = 'AnthropicExtractionError';
            throw err;
          }
          return { events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] };
        },
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(calls.extracts.length, 2, 'the job continued past the failed message');
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].id, 'm1');
      assert.equal(calls.alarms.length, 1);
      assert.equal(calls.alarms[0].token, ALARM_TOKENS.EXTRACTION_FAILED);
      assert.equal(calls.alarms[0].fields.errorName, 'AnthropicExtractionError');
      assert.ok(!JSON.stringify(calls.alarms[0].fields).includes('model exploded'), 'the error MESSAGE is never raised in the alarm');
      assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.PARTIAL);
    });
  });

  describe('AC 17 / AC 42: a storeEvents throw is contained per job', () => {
    it('Given job-a\'s store throws, When a scan runs, Then it reports 0 written and partial, and job-b still runs', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        onFetch: async () => emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async ({ processingJobId }) => {
          if (processingJobId === 'job-a') throw new Error('ProvisionedThroughputExceeded');
          return { written: 1, skipped: [] };
        },
      });

      assert.equal(calls.stores.length, 2, 'the remaining job still ran');
      assert.equal(result.jobs[0].eventsCreated, 0, 'never guessed');
      assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.PARTIAL);
      assert.equal(result.jobs[1].eventsCreated, 1);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      assert.equal(result.eventsCreated, 1, 'the total counts only what was actually reported written');
    });
  });

  describe('AC 18 / AC 19 / AC 40: the watermark across the loop', () => {
    const CLEAN = {
      onFetch: async ({ job }) =>
        emptyFetch({
          messages: [makeMessage(`m-${job.id}`)],
          newestReceivedAt: job.id === 'job-b' ? '2026-06-01T10:00:00.000Z' : '2026-05-30T00:00:00.000Z',
        }),
      onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
      onStore: async () => ({ written: 1, skipped: [] }),
    };

    it('AC 19: Given every job completes untruncated, When the scan finishes, Then lastScanAt advances to the MAXIMUM newestReceivedAt', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        ...CLEAN,
      });

      assert.equal(result.status, SCAN_STATUS.OK);
      assert.equal(calls.patches[0].lastScanAt, '2026-06-01T10:00:00.000Z');
    });

    it('AC 19: Given no job matched anything, When the scan finishes, Then lastScanAt advances to this run\'s own start instant', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        now: () => Date.parse('2026-06-02T03:04:05.000Z'),
      });

      assert.equal(result.status, SCAN_STATUS.OK);
      assert.equal(calls.patches[0].lastScanAt, '2026-06-02T03:04:05.000Z');
    });

    it('AC 40: Given one job returns zero messages and another finds mail, When the scan finishes, Then the empty job is ok and does not pin the watermark', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        onFetch: async ({ job }) =>
          job.id === 'job-a'
            ? emptyFetch()
            : emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(result.jobs[0].status, SCAN_JOB_STATUS.OK);
      assert.equal(result.jobs[0].messagesScanned, 0);
      assert.equal(result.status, SCAN_STATUS.OK);
      assert.equal(calls.patches[0].lastScanAt, '2026-06-01T00:00:00.000Z');
    });

    it('AC 18: Given ANY job\'s fetch was truncated, When the scan finishes, Then lastScanAt is pinned to the query floor', async () => {
      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        onFetch: async ({ job }) =>
          emptyFetch({
            messages: [makeMessage(`m-${job.id}`)],
            truncated: job.id === 'job-a',
            newestReceivedAt: '2026-06-01T00:00:00.000Z',
          }),
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(result.truncated, true);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      assert.equal(calls.patches[0].lastScanAt, '2026-05-19T00:00:00.000Z');
      assert.equal(result.jobs[0].truncated, true);
      assert.equal(result.jobs[1].truncated, false);
    });

    it('AC 18: Given one job\'s fetch failed, When the scan finishes, Then lastScanAt is pinned to the query floor', async () => {
      const { calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        onFetch: async ({ job }) => {
          if (job.id === 'job-a') throw new Error('Gmail 500');
          return emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' });
        },
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(calls.patches[0].lastScanAt, '2026-05-19T00:00:00.000Z');
    });
  });

  describe('AC 20: a job the deadline prevented from starting is not_attempted', () => {
    it('Given the clock passes the deadline while job-b extracts, When the scan finishes, Then job-c is not_attempted with zero counts', async () => {
      // A clock that jumps past the deadline once job-b's message is reached.
      const START = Date.parse('2026-06-02T00:00:00.000Z');
      let clock = START;
      const now = () => clock;

      const { result, calls } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b'), makeJob('job-c')],
        lastScanAt: '2026-05-21T00:00:00.000Z',
        now,
        // 60s of runway - 30s safety margin = a 30s budget.
        getRemainingTimeInMillis: () => 60_000,
        onFetch: async ({ job }) =>
          emptyFetch({ messages: [makeMessage(`m-${job.id}`)], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async ({ message }) => {
          if (message.id === 'm-job-b') clock = START + 120_000;
          return { events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] };
        },
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.deepEqual(calls.fetches.map((c) => c.job.id), ['job-a', 'job-b'], 'job-c is never fetched');
      assert.equal(result.jobs[2].status, SCAN_JOB_STATUS.NOT_ATTEMPTED);
      assert.deepEqual(
        {
          messagesScanned: result.jobs[2].messagesScanned,
          eventsCreated: result.jobs[2].eventsCreated,
          skipped: result.jobs[2].skipped,
          errors: result.jobs[2].errors,
          truncated: result.jobs[2].truncated,
        },
        { messagesScanned: 0, eventsCreated: 0, skipped: 0, errors: 0, truncated: false }
      );
      assert.equal(result.truncated, true);
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      assert.equal(calls.patches[0].lastScanAt, '2026-05-19T00:00:00.000Z', 'pinned, not advanced');
      assert.equal(calls.stores.length, 2, 'job-b\'s already-extracted events are still persisted');
      assert.equal(calls.unlocks, 1);
    });
  });

  describe('AC 21: the connection is patched exactly once, after the loop', () => {
    it('Given four jobs, When a scan runs, Then updateConnection is called once with the totals', async () => {
      const { result, calls } = await runScanWith({
        jobs: ['a', 'b', 'c', 'd'].map((k) => makeJob(`job-${k}`)),
        onFetch: async ({ job }) => emptyFetch({ messages: [makeMessage(`m-${job.id}`)], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [{ messageId: 'm', reason: 'duplicate' }] }),
      });

      assert.equal(calls.patches.length, 1, 'one patch per RUN, not per job');
      assert.deepEqual(calls.patches[0], {
        lastScanAt: '2026-06-01T00:00:00.000Z',
        lastScanStatus: SCAN_STATUS.OK,
        lastScanError: '',
        lastScanMessagesScanned: 4,
        lastScanEventsCreated: 4,
        lastScanEventsUpdated: 0,
        lastScanSkipped: 4,
        lastScanTruncated: false,
      });
      assert.equal(result.messagesScanned, 4);
      assert.equal(calls.locks, 1);
      assert.equal(calls.unlocks, 1);
    });

    it('Given the patch write fails, When a scan runs, Then the failure is swallowed and the result still returned', async () => {
      const result = await runScan(
        { userId: USER, mode: 'scheduled' },
        {
          env: ENV,
          log: () => {},
          now: () => Date.parse('2026-06-02T00:00:00.000Z'),
          getConnection: async () => ({ processingJobs: [makeJob('job-a')] }),
          updateConnection: async () => {
            throw new Error('DynamoDB blip');
          },
          acquireScanLock: async () => true,
          releaseScanLock: async () => {},
          fetchCandidateMessages: async () => emptyFetch(),
          extractFromMessage: async () => ({ events: [] }),
          storeEvents: async () => ({ written: 0, skipped: [] }),
        }
      );

      assert.equal(result.status, SCAN_STATUS.OK, 'a failed "how did it go" write must not become a 500');
    });
  });

  describe('AC 22 / AC 23 / DECISION B: the report shape', () => {
    it('Given SCAN_JOB_STATUS, When it is inspected, Then it is frozen with exactly the five documented values', () => {
      assert.ok(Object.isFrozen(SCAN_JOB_STATUS));
      assert.deepEqual(Object.values(SCAN_JOB_STATUS).sort(), ['error', 'not_attempted', 'not_configured', 'ok', 'partial']);
    });

    it('Given a mixed run, When it finishes, Then jobs has one entry per CONFIGURED job in settings order with exactly the DECISION B keys', async () => {
      const { result } = await runScanWith({
        jobs: [
          makeJob('job-a'),
          { id: 'job-b', name: 'B', schoolName: '', domain: '', searchTerms: [] },
          makeJob('job-c'),
        ],
        onFetch: async ({ job }) => {
          if (job.id === 'job-c') throw new Error('boom');
          return emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' });
        },
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 2, skipped: [{ messageId: 'm1', reason: 'duplicate' }] }),
      });

      assert.deepEqual(result.jobs.map((entry) => entry.processingJobId), ['job-a', 'job-b', 'job-c']);
      for (const entry of result.jobs) {
        assert.deepEqual(Object.keys(entry).sort(), [
          'errors', 'eventsCreated', 'eventsUpdated', 'messagesScanned', 'name',
          'processingJobId', 'skipped', 'status', 'truncated',
        ]);
        assert.equal(typeof entry.errors, 'number', 'errors is a COUNT inside a job entry');
      }

      // Totals are the sums.
      assert.equal(result.messagesScanned, result.jobs.reduce((s, j) => s + j.messagesScanned, 0));
      assert.equal(result.eventsCreated, result.jobs.reduce((s, j) => s + j.eventsCreated, 0));
      assert.equal(result.skipped, result.jobs.reduce((s, j) => s + j.skipped, 0));
      assert.equal(result.eventsUpdated, 0, 'still always 0');
      assert.equal(result.errors.length, result.jobs.reduce((s, j) => s + j.errors, 0));
      assert.equal(result.status, SCAN_STATUS.PARTIAL);
      assert.deepEqual(Object.keys(result).sort(), [
        'errors', 'eventsCreated', 'eventsUpdated', 'jobs', 'messagesScanned', 'skipped', 'status', 'truncated',
      ]);
    });

    it('Given several jobs each report errors, When the run finishes, Then the top-level errors are concatenated in job order', async () => {
      const { result } = await runScanWith({
        jobs: [makeJob('job-a'), makeJob('job-b')],
        onFetch: async ({ job }) => {
          throw new Error(`fail-${job.id}`);
        },
      });

      assert.deepEqual(result.errors.map((e) => e.error), ['fail-job-a', 'fail-job-b']);
    });

    it('AC 39: Given two jobs both write the same underlying event, When the run finishes, Then eventsCreated sums both writes by design', async () => {
      const { result } = await runScanWith({
        jobs: [makeJob('job-a', { domain: 'shared.edu.au' }), makeJob('job-b', { domain: 'shared.edu.au' })],
        onFetch: async () => emptyFetch({ messages: [makeMessage('m9')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [{ title: 'Book Fair', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
      });

      assert.equal(result.eventsCreated, 2, 'the accepted double-count: eventsCreated reports the whole WRITTEN count');
    });
  });

  describe('AC 24: job names reach the owner\'s browser but never a log line', () => {
    it('Given jobs with distinctive names and school names, When a scan runs, Then no log line contains them but the report does', async () => {
      const lines = [];
      const { result } = await runScanWith({
        jobs: [makeJob('job-a', { name: 'ZZZ-JOB-NAME', schoolName: 'ZZZ-SCHOOL-NAME', searchTerms: ['ZZZ-TERM'] })],
        onFetch: async () => emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [{ title: 'T', startsAt: '2026-06-10T00:00:00.000Z' }] }),
        onStore: async () => ({ written: 1, skipped: [] }),
        env: { ...ENV, CALENDAR_LOG_LEVEL: 'basic' },
        log: (message, fields) => lines.push({ message, fields }),
      });

      const serialised = JSON.stringify(lines);
      for (const banned of ['ZZZ-JOB-NAME', 'ZZZ-SCHOOL-NAME', 'ZZZ-TERM']) {
        assert.ok(!serialised.includes(banned), `logs must not contain "${banned}"`);
      }
      assert.ok(serialised.includes('job-a'), 'the opaque processingJobId IS logged');
      assert.equal(result.jobs[0].name, 'ZZZ-JOB-NAME', 'the owner\'s own browser still gets the name');
    });
  });

  /* =====================================================================
   * events.mjs - attribution (AC 25-29, 31, 37, 38, 44, 45)
   * ===================================================================== */

  const MESSAGE = { id: 'm1', subject: 'Newsletter', from: 'office@stmarys.edu.au', receivedAt: '2026-06-01T00:00:00.000Z' };
  const EVENT = { title: 'Year 4 Excursion', startsAt: '2026-06-10T00:00:00.000Z', category: 'excursion', confidence: 0.9 };
  const NOW = () => Date.parse('2026-06-02T00:00:00.000Z');

  describe('AC 25: buildEventItem stamps processingJobId, and leaves it UNDEFINED when blank', () => {
    it('Given a processingJobId, When an item is built, Then it is stamped on the row', () => {
      const { item } = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW });
      assert.equal(item.processingJobId, 'job-a');
    });

    it('Given a blank, whitespace or absent id, When an item is built, Then the attribute is undefined - never "" and never null', () => {
      for (const value of [undefined, null, '', '   ']) {
        const { item } = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: value }, { now: NOW });
        assert.equal(item.processingJobId, undefined, `blank input ${JSON.stringify(value)} must leave the attribute absent`);
        assert.ok(!Object.entries(item).some(([k, v]) => k === 'processingJobId' && (v === '' || v === null)));
      }
    });
  });

  describe('AC 26: buildEventItems and storeEvents thread processingJobId onto every item', () => {
    it('Given a batch of extractions, When items are built, Then every row carries the job id', () => {
      const { items } = buildEventItems(
        {
          userId: USER,
          extractions: [
            { message: MESSAGE, event: EVENT },
            { message: { ...MESSAGE, id: 'm2' }, event: { ...EVENT, title: 'Swimming Carnival' } },
          ],
          processingJobId: 'job-a',
        },
        { now: NOW }
      );

      assert.equal(items.length, 2);
      for (const item of items) assert.equal(item.processingJobId, 'job-a');
    });

    it('Given storeEvents is handed a job id, When it writes, Then every written item carries it (batchWrite/batchGet stubbed)', async () => {
      const written = [];
      const result = await storeEvents(
        { userId: USER, extractions: [{ message: MESSAGE, event: EVENT }], processingJobId: 'job-a', tableName: 'test-table' },
        {
          now: NOW,
          env: ENV,
          log: () => {},
          batchGet: async () => ({ items: [], unprocessedKeys: [] }),
          batchWrite: async ({ items }) => {
            written.push(...items);
            return { unprocessed: [] };
          },
        }
      );

      assert.equal(result.written, 1);
      assert.equal(written[0].processingJobId, 'job-a');
    });
  });

  describe('AC 27 / AC 37 / AC 44: deriveEventId is unchanged by this ticket', () => {
    it('Given fixed inputs, When the id is derived, Then it is the pinned sha256 digest', () => {
      const id = deriveEventId({ sourceMessageId: 'm1', title: 'Year 4 Excursion', startsAt: '2026-06-10T00:00:00.000Z' });

      assert.equal(id, 'c28189d0f74204244d1cf91d4a425d5b2d03895fb506d05f8e47e048ec5522c0');
      assert.equal(id, createHash('sha256').update('m1|year 4 excursion|2026-06-10T00:00:00.000Z', 'utf8').digest('hex'));
    });

    it('Given a processingJobId is supplied or not, When items are built, Then the eventId is identical', () => {
      const a = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW }).item;
      const b = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-b' }, { now: NOW }).item;
      const none = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT }, { now: NOW }).item;

      assert.equal(a.eventId, b.eventId, 'two jobs extracting the same event derive the SAME eventId');
      assert.equal(a.eventId, none.eventId);
      assert.equal(a.eventId, 'c28189d0f74204244d1cf91d4a425d5b2d03895fb506d05f8e47e048ec5522c0');
    });

    it('Given the same job is renamed, When the item is rebuilt, Then attribution is by the stable id, not the name', () => {
      const before = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW }).item;
      const after = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW }).item;

      assert.equal(before.processingJobId, after.processingJobId);
      assert.equal(before.eventId, after.eventId);
      assert.ok(!('name' in before), 'a job name is never stored on the row');
    });
  });

  describe('AC 38: a duplicate eventId inside ONE job\'s batch is collapsed as a DUPLICATE skip', () => {
    it('Given the same event twice in one batch, When items are built, Then one item survives and one duplicate skip is recorded', () => {
      const built = buildEventItems(
        {
          userId: USER,
          extractions: [
            { message: MESSAGE, event: EVENT },
            { message: MESSAGE, event: { ...EVENT } },
          ],
          processingJobId: 'job-a',
        },
        { now: NOW }
      );

      assert.equal(built.items.length, 1);
      assert.equal(built.skipped.length, 1);
      assert.equal(built.skipped[0].reason, SKIP_REASON.DUPLICATE);
    });
  });

  describe('AC 28: LIFECYCLE_ATTRIBUTES carries processingJobId and stays narrow', () => {
    it('Given the pre-read projection, When it is inspected, Then it includes processingJobId and no content field', () => {
      assert.ok(LIFECYCLE_ATTRIBUTES.includes('processingJobId'), 'without it, first-seen-wins cannot work');
      for (const banned of ['title', 'description', 'sourceSubject', 'sourceFrom', 'sourceMessageId']) {
        assert.ok(!LIFECYCLE_ATTRIBUTES.includes(banned), `${banned} must not be pulled into the write path`);
      }
      assert.deepEqual([...LIFECYCLE_ATTRIBUTES].sort(), [
        'acknowledgedAt', 'createdAt', 'dismissedAt', 'dueBy', 'eventId', 'processingJobId', 'status', 'userId',
      ]);
    });
  });

  describe('AC 29: applyPreservedLifecycle is FIRST-SEEN-WINS for processingJobId and createdAt', () => {
    const fresh = () =>
      buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-b' }, { now: NOW }).item;

    it('Given a still-PENDING stored row from job-a, When job-b rescans it, Then attribution and createdAt stay job-a\'s', () => {
      const item = fresh();
      const merged = applyPreservedLifecycle(item, {
        status: EVENT_STATUS.PENDING,
        processingJobId: 'job-a',
        createdAt: '2026-05-30T00:00:00.000Z',
      });

      assert.notEqual(merged, item, 'the function must NOT early-return for a pending row');
      assert.equal(merged.processingJobId, 'job-a');
      assert.equal(merged.createdAt, '2026-05-30T00:00:00.000Z');
      assert.equal(merged.status, EVENT_STATUS.PENDING);
    });

    it('Given an ACKNOWLEDGED stored row from job-a, When job-b rescans it, Then the decision AND the attribution survive', () => {
      const item = fresh();
      const merged = applyPreservedLifecycle(item, {
        status: EVENT_STATUS.ACKNOWLEDGED,
        acknowledgedAt: '2026-06-01T12:00:00.000Z',
        processingJobId: 'job-a',
        createdAt: '2026-05-30T00:00:00.000Z',
        dueBy: '2026-06-09T00:00:00.000Z',
      });

      assert.equal(merged.status, EVENT_STATUS.ACKNOWLEDGED);
      assert.equal(merged.attentionKey, undefined, 'a handled event carries no attentionKey');
      assert.equal(merged.acknowledgedAt, '2026-06-01T12:00:00.000Z');
      assert.equal(merged.dueBy, '2026-06-09T00:00:00.000Z');
      assert.equal(merged.processingJobId, 'job-a');
      assert.equal(merged.createdAt, '2026-05-30T00:00:00.000Z');
    });

    it('Given nothing genuinely to preserve, When the merge runs, Then the SAME object reference comes back', () => {
      const item = fresh();
      assert.equal(applyPreservedLifecycle(item, undefined), item);
      assert.equal(applyPreservedLifecycle(item, null), item);
      assert.equal(
        applyPreservedLifecycle(item, { status: EVENT_STATUS.PENDING, processingJobId: 'job-b', createdAt: item.createdAt }),
        item
      );
    });

    it('Given the stored row has no processingJobId (AC 45, a pre-jobs row), When it is rescanned, Then the new attribution is taken', () => {
      const item = fresh();
      const merged = applyPreservedLifecycle(item, { status: EVENT_STATUS.PENDING, createdAt: item.createdAt });
      assert.equal(merged.processingJobId, 'job-b', 'a blank stored value is not a first-seen fact');
    });

    it('Given a pending attribution-only merge, When storeEvents runs, Then `preserved` is NOT inflated', async () => {
      const result = await storeEvents(
        { userId: USER, extractions: [{ message: MESSAGE, event: EVENT }], processingJobId: 'job-b', tableName: 'test-table' },
        {
          now: NOW,
          env: ENV,
          log: () => {},
          batchGet: async ({ keys }) => ({
            items: keys.map((key) => ({ ...key, status: EVENT_STATUS.PENDING, processingJobId: 'job-a', createdAt: '2026-05-30T00:00:00.000Z' })),
            unprocessedKeys: [],
          }),
          batchWrite: async () => ({ unprocessed: [] }),
        }
      );

      assert.equal(result.preserved, 0, 'preserved counts acknowledged/dismissed carry-forwards only');
      assert.equal(result.items[0].processingJobId, 'job-a');
    });

    it('Given an acknowledged carry-forward, When storeEvents runs, Then `preserved` counts it', async () => {
      const result = await storeEvents(
        { userId: USER, extractions: [{ message: MESSAGE, event: EVENT }], processingJobId: 'job-b', tableName: 'test-table' },
        {
          now: NOW,
          env: ENV,
          log: () => {},
          batchGet: async ({ keys }) => ({
            items: keys.map((key) => ({ ...key, status: EVENT_STATUS.ACKNOWLEDGED, acknowledgedAt: '2026-06-01T00:00:00.000Z', processingJobId: 'job-a' })),
            unprocessedKeys: [],
          }),
          batchWrite: async () => ({ unprocessed: [] }),
        }
      );

      assert.equal(result.preserved, 1);
      assert.equal(result.items[0].status, EVENT_STATUS.ACKNOWLEDGED);
      assert.equal(result.items[0].processingJobId, 'job-a');
    });
  });

  describe('AC 31: processingJobId reaches the browser on the public projection', () => {
    it('Given PUBLIC_EVENT_FIELDS, When it is inspected, Then processingJobId is allowed and Gmail handles still are not', () => {
      assert.ok(PUBLIC_EVENT_FIELDS.includes('processingJobId'));
      for (const banned of ['sourceMessageId', 'attentionKey', 'ttl', 'userId']) {
        assert.ok(!PUBLIC_EVENT_FIELDS.includes(banned), `${banned} must stay off the public projection`);
      }
    });

    it('Given a stored row, When toEventJson projects it, Then processingJobId is carried and an unattributed row reads null', () => {
      const { item } = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW });
      assert.equal(toEventJson(item).processingJobId, 'job-a');

      const bare = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT }, { now: NOW }).item;
      assert.equal(toEventJson(bare).processingJobId, null, 'a pre-jobs row projects null, never undefined-by-omission');
      assert.ok('processingJobId' in toEventJson(bare));
    });

    it('Given the projection, When its keys are listed, Then they are exactly PUBLIC_EVENT_FIELDS', () => {
      const { item } = buildEventItem({ userId: USER, message: MESSAGE, event: EVENT, processingJobId: 'job-a' }, { now: NOW });
      assert.deepEqual(Object.keys(toEventJson(item)).sort(), [...PUBLIC_EVENT_FIELDS].sort());
    });
  });

  /* =====================================================================
   * anthropic.mjs - per-job context and the cost gate (AC 30, 32-34)
   * ===================================================================== */

  describe('AC 34: the system prompt and DATA_TAGS are byte-unchanged (the prompt-cache breakpoint)', () => {
    it('Given EXTRACTION_SYSTEM_PROMPT, When hashed, Then it matches the digest taken before this ticket', () => {
      // Digest computed from src/lambda/calendar/backend/anthropic.mjs at commit
      // 5b16c68 (the commit immediately before TASK-056).
      assert.equal(
        createHash('sha256').update(EXTRACTION_SYSTEM_PROMPT, 'utf8').digest('hex'),
        '8be660074c776cfe4385a9aebe180897edcd1d414a634a4bb32eeae827baf90a'
      );
      assert.equal(EXTRACTION_SYSTEM_PROMPT.length, 9903);
    });

    it('Given DATA_TAGS, When inspected, Then it is unchanged and carries no searchTerms tag', () => {
      assert.deepEqual([...DATA_TAGS], ['email_body', 'email_metadata', 'school_context', 'school_name', 'watched_domain']);
    });
  });

  describe('AC 32 / AC 33 / DECISION A: per-job extraction context', () => {
    const MSG = {
      id: 'm1',
      subject: 'Tuckshop roster',
      from: 'office@stmarys.edu.au',
      receivedAt: '2026-06-01T00:00:00.000Z',
      body: 'Please return the form.',
    };

    it('Given job-a\'s context, When the user content is built, Then only job-a\'s school name and domain appear', () => {
      const content = buildUserContent({
        message: MSG,
        schoolNames: ["St Mary's Primary"],
        searchDomains: ['stmarys.edu.au'],
      });

      assert.equal((content.match(/<school_name>/g) || []).length, 1);
      assert.ok(content.includes("<school_name>St Mary's Primary</school_name>"));
      assert.equal((content.match(/<watched_domain>/g) || []).length, 1);
      assert.ok(content.includes('<watched_domain>stmarys.edu.au</watched_domain>'));
      assert.ok(!content.includes('Riverside High'), 'another job\'s school name must never leak in');
    });

    it('Given a distinctive search term, When the whole request body is serialised, Then the term is absent everywhere', () => {
      const request = buildRequest({
        message: { ...MSG, subject: 'Roster', body: 'Please return the form.' },
        schoolNames: ["St Mary's Primary"],
        searchDomains: ['stmarys.edu.au'],
      });

      const serialised = JSON.stringify(request);
      assert.ok(!serialised.includes('ZZZ-SEARCH-TERM'));
      assert.ok(!serialised.includes('searchTerms'), 'searchTerms is not even a key in the request');
      assert.ok(serialised.includes("St Mary's Primary"));
    });

    it('Given buildUserContent, When called with a searchTerms property, Then the signature ignores it entirely', () => {
      const content = buildUserContent({
        message: MSG,
        schoolNames: ["St Mary's Primary"],
        searchDomains: ['stmarys.edu.au'],
        searchTerms: ['ZZZ-SEARCH-TERM'],
      });

      assert.ok(!content.includes('ZZZ-SEARCH-TERM'), 'DECISION A is enforced by the signature, not by remembering');
    });

    it('Given a scan over two jobs, When each message is extracted, Then each call receives only its own job\'s context and no searchTerms', async () => {
      const { calls } = await runScanWith({
        jobs: [
          makeJob('job-a', { schoolName: "St Mary's Primary", domain: 'stmarys.edu.au', searchTerms: ['Tuckshop'] }),
          makeJob('job-b', { schoolName: 'Riverside High', domain: 'riverside.edu.au', searchTerms: [] }),
        ],
        onFetch: async ({ job }) => emptyFetch({ messages: [makeMessage(`m-${job.id}`)], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
        onExtract: async () => ({ events: [] }),
      });

      assert.equal(calls.extracts.length, 2);
      assert.deepEqual(calls.extracts[0].schoolNames, ["St Mary's Primary"]);
      assert.deepEqual(calls.extracts[0].searchDomains, ['stmarys.edu.au']);
      assert.deepEqual(calls.extracts[1].schoolNames, ['Riverside High']);
      assert.deepEqual(calls.extracts[1].searchDomains, ['riverside.edu.au']);
      assert.ok(!('searchTerms' in calls.extracts[0]), 'searchTerms are never handed to the extractor');
      assert.ok(!JSON.stringify(calls.extracts).includes('Tuckshop'));
    });
  });

  describe('AC 30: the sender cost gate, and the one narrow way past it', () => {
    const OUTSIDE = {
      id: 'm1',
      subject: 'School newsletter relay',
      from: 'newsletter@mailrelay.example',
      receivedAt: '2026-06-01T00:00:00.000Z',
      body: "St Mary's Primary excursion on 10 June.",
    };

    const modelDeps = (calls) => ({
      env: { CALENDAR_LOG_LEVEL: 'none' },
      errorTypes: null,
      sleep: async () => {},
      random: () => 0,
      createMessage: async (request) => {
        calls.push(request);
        return { stop_reason: 'end_turn', parsed_output: { isSchoolEmail: true, events: [{ title: 'Excursion', startsAt: '2026-06-10' }] } };
      },
    });

    it('Given a text-only match from an unwatched sender AND queryMatched, When it is extracted, Then the model IS called', async () => {
      const requests = [];
      const result = await extractFromMessage(
        { message: OUTSIDE, schoolNames: ["St Mary's Primary"], searchDomains: ['stmarys.edu.au'], queryMatched: true },
        modelDeps(requests)
      );

      assert.equal(result.status, EXTRACTION_STATUS.EXTRACTED);
      assert.equal(requests.length, 1, 'the widened query must not be pure cost');
    });

    it('Given the SAME message without queryMatched, When it is extracted, Then the gate stays fail-closed and no token is spent', async () => {
      const requests = [];
      const result = await extractFromMessage(
        { message: OUTSIDE, schoolNames: ["St Mary's Primary"], searchDomains: ['stmarys.edu.au'] },
        modelDeps(requests)
      );

      assert.equal(result.status, EXTRACTION_STATUS.SKIPPED_SENDER);
      assert.equal(requests.length, 0);
    });

    it('Given an EMPTY domain list and no flag, When a message is extracted, Then it is still skipped (empty means watch nothing)', async () => {
      const requests = [];
      const result = await extractFromMessage({ message: OUTSIDE, schoolNames: [], searchDomains: [] }, modelDeps(requests));

      assert.equal(result.status, EXTRACTION_STATUS.SKIPPED_SENDER);
      assert.equal(requests.length, 0);
      assert.equal(isWatchedSender(OUTSIDE.from, []), false);
    });

    it('Given queryMatched is a truthy non-true value, When a message is extracted, Then the gate is NOT bypassed', async () => {
      const requests = [];
      const result = await extractFromMessage(
        { message: OUTSIDE, schoolNames: [], searchDomains: ['stmarys.edu.au'], queryMatched: 'yes' },
        modelDeps(requests)
      );

      assert.equal(result.status, EXTRACTION_STATUS.SKIPPED_SENDER, 'only the boolean true asserts the retrieval fact');
      assert.equal(requests.length, 0);
    });

    it('Given the bypass is taken, When the log is captured, Then only the message id is recorded', async () => {
      const lines = [];
      await extractFromMessage(
        { message: OUTSIDE, schoolNames: ["St Mary's Primary"], searchDomains: ['stmarys.edu.au'], queryMatched: true },
        { ...modelDeps([]), log: (message, fields) => lines.push({ message, fields }) }
      );

      const bypass = lines.find((line) => line.message === 'calendar.anthropic.sender_gate_bypassed');
      assert.ok(bypass, 'the cost of the widening is visible to an operator');
      assert.deepEqual(bypass.fields, { messageId: 'm1' });
      assert.ok(!JSON.stringify(lines).includes('mailrelay.example'), 'the sender is never logged');
    });

    it('Given the scan loop, When it extracts a message, Then it passes queryMatched: true (its own query already filtered)', async () => {
      const { calls } = await runScanWith({
        jobs: [makeJob('job-a')],
        onFetch: async () => emptyFetch({ messages: [makeMessage('m1')], newestReceivedAt: '2026-06-01T00:00:00.000Z' }),
      });

      assert.equal(calls.extracts[0].queryMatched, true);
    });
  });
});
