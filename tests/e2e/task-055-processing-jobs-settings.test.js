/**
 * TASK-055 E2E - "A user configures independent named processing jobs".
 *
 * Cucumber-style scenarios (Given/When/Then) written for `node --test`; there is
 * no cucumber runner in this repo and none is added. Each `describe` is a
 * Feature/Scenario from the ticket's Gherkin and each `it` is one Then.
 *
 * NO DATABASE. Every DynamoDB call is injected: the routes take `getConnection`
 * and `updateItem` as options, so nothing here opens a client, reads credentials
 * or touches the network. `buildUpdateParams` is exercised directly to assert the
 * COMPILED UpdateItem expression rather than a round-trip through a fake, and the
 * scan scenario injects every I/O seam it needs so Gmail is never called either.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import { handler, handleAuthMe } from '../../src/lambda/calendar/index.mjs';
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from '../../src/lambda/calendar/backend/session.mjs';
import {
  buildUpdateParams,
  connectionUserId,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/connections.mjs';
import {
  buildConnectionPatch,
  requireValidSettings,
} from '../../src/lambda/calendar/backend/settings.mjs';
import { runScan, SCAN_STATUS } from '../../src/lambda/calendar/backend/scan.mjs';

const sessionSecret = 'test-session-secret-must-be-32-bytes-long!!';
const testGoogleSub = 'task-055-google-sub';
const testEmail = 'parent@example.test';

const defaultEnv = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
  SESSION_SECRET: sessionSecret,
  PUBLIC_BASE_URL: 'https://example.com',
  CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
  CALENDAR_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789:key/1234',
  CALENDAR_LOG_LEVEL: 'none',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_UUID = '6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d';

function makeSessionCookie() {
  const token = createSessionToken({ sub: testGoogleSub, email: testEmail }, { secret: sessionSecret });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function makeEvent(method, path, body = null, cookie = makeSessionCookie()) {
  const event = {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
    cookies: cookie ? [cookie] : [],
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
 * A stand-in for `ddbUpdateItem` with the SAME contract the real one has -
 * `({ tableName, key, updates }) => row` - applying the patch to a starting row
 * the way an ALL_NEW UpdateItem would. `REMOVE_ATTRIBUTE` deletes.
 *
 * This is the ONLY database seam in the file: `updateConnection` takes it as an
 * injected dependency, so the whole PUT path runs with no AWS SDK, no credentials
 * and no network.
 */
function makeUpdateItemSpy(startingRow = {}) {
  const calls = [];
  const updateItem = async ({ tableName, key, updates }) => {
    calls.push({ tableName, key, updates });
    const row = {
      userId: connectionUserId(testGoogleSub),
      email: testEmail,
      hasRefreshToken: true,
      ...startingRow,
    };
    for (const [attribute, value] of Object.entries(updates || {})) {
      if (value === REMOVE_ATTRIBUTE) delete row[attribute];
      else row[attribute] = value;
    }
    return row;
  };
  return { updateItem, calls };
}

/** One valid processing job payload, overridable field by field. */
function job(overrides = {}) {
  return {
    name: "St Mary's",
    schoolName: "St Mary's Primary",
    domains: ['stmarys.edu.au'],
    searchTerms: [],
    ...overrides,
  };
}

/** When they PUT settings with this body. */
async function putSettings(body, { updateItem, spy } = {}) {
  const useSpy = spy || makeUpdateItemSpy();
  const response = await handler(makeEvent('PUT', '/calendar/api/settings', body), {}, {
    env: defaultEnv,
    updateItem: updateItem || useSpy.updateItem,
  });
  return { response, body: JSON.parse(response.body), spy: useSpy };
}

/** When they GET settings for a stored row. `updateItem` throws: a GET writes nothing. */
async function getSettings(storedRow) {
  const writes = [];
  const response = await handler(makeEvent('GET', '/calendar/api/settings'), {}, {
    env: defaultEnv,
    getConnection: async () => storedRow,
    updateItem: async (params) => {
      writes.push(params);
      throw new Error('a GET must not write');
    },
  });
  return { response, body: JSON.parse(response.body), writes };
}

/** When they GET auth/me for a stored row. */
async function getAuthMe(storedRow) {
  const response = await handleAuthMe(makeEvent('GET', '/calendar/api/auth/me'), {
    env: defaultEnv,
    getConnection: async () => storedRow,
  });
  return { response, body: JSON.parse(response.body) };
}

/* =========================================================================
 * Feature: A user configures independent named processing jobs
 *
 * Background:
 *   Given an authenticated user with a connection row
 *   And the DynamoDB UpdateItem call is a spy on an injected updateItem
 * ========================================================================= */

describe('Feature: A user configures independent named processing jobs', () => {
  describe('Scenario: Adding and saving one processing job', () => {
    const payload = {
      processingJobs: [
        job({ searchTerms: ['canteen roster', 'swimming carnival'] }),
      ],
    };

    it('Then the response status code is 200 and processingJobs has 1 entry with the submitted fields', async () => {
      const { response, body } = await putSettings(payload);
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs.length, 1);

      const [entry] = body.processingJobs;
      assert.equal(entry.name, "St Mary's");
      assert.equal(entry.schoolName, "St Mary's Primary");
      assert.deepEqual(entry.domains, ['stmarys.edu.au']);
      assert.ok(!('domain' in entry), 'the singular key leaked (TASK-059)');
      assert.deepEqual(entry.searchTerms, ['canteen roster', 'swimming carnival']);
      assert.match(entry.id, UUID_RE, 'the server did not mint a canonical UUID');
    });

    it('And the response body has no schoolNames, searchDomains or schoolName key', async () => {
      const { body } = await putSettings(payload);
      assert.ok(!('schoolNames' in body));
      assert.ok(!('searchDomains' in body));
      assert.ok(!('schoolName' in body));
    });

    it('And the stored processingJobs attribute is a plain array of plain objects, not a Set', async () => {
      const spy = makeUpdateItemSpy();
      await putSettings(payload, { spy });

      assert.equal(spy.calls.length, 1);
      const written = spy.calls[0].updates.processingJobs;
      assert.ok(Array.isArray(written));
      assert.ok(!(written instanceof Set));
      assert.notEqual(typeof written, 'string');
      assert.equal(Object.getPrototypeOf(written[0]), Object.prototype);
      assert.ok(Array.isArray(written[0].searchTerms));
      // The failure this guards: JSON.stringify(new Set()) is "{}", so a Set that
      // escaped into a response body would silently become an empty object.
      assert.notEqual(JSON.stringify(written), '{}');
    });
  });

  describe('Scenario: Two jobs for two different schools are saved in submitted order', () => {
    it('Then the response is 200 and the names are ["Zeta", "Alpha"]', async () => {
      const { response, body } = await putSettings({
        processingJobs: [
          job({ name: 'Zeta', schoolName: 'Zeta College', domains: ['zeta.edu.au'] }),
          job({ name: 'Alpha', schoolName: 'Alpha School', domains: ['alpha.edu.au'] }),
        ],
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs.map((entry) => entry.name), ['Zeta', 'Alpha']);
    });
  });

  describe('Scenario: A job with no search terms is valid', () => {
    it('Then the response is 200 and the stored searchTerms is an empty LIST, not a removed attribute', async () => {
      const spy = makeUpdateItemSpy();
      const { response, body } = await putSettings({ processingJobs: [job({ searchTerms: [] })] }, { spy });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs[0].searchTerms, []);

      const written = spy.calls[0].updates.processingJobs[0];
      assert.deepEqual(written.searchTerms, []);
      assert.notEqual(written.searchTerms, REMOVE_ATTRIBUTE);
      assert.ok('searchTerms' in written, 'the empty list was dropped from the stored map');
    });
  });

  describe('Scenario: An absent searchTerms key normalizes to an empty list', () => {
    it('Then the response is 200 and processingJobs[0].searchTerms is []', async () => {
      const { name, schoolName, domains } = job();
      const { response, body } = await putSettings({ processingJobs: [{ name, schoolName, domains }] });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs[0].searchTerms, []);
    });
  });

  describe('Scenario: Two jobs may legitimately share a domain', () => {
    it('Then the response is 200 and processingJobs has 2 entries', async () => {
      const { response, body } = await putSettings({
        processingJobs: [job({ name: 'Newsletters' }), job({ name: 'Sport' })],
      });
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs.length, 2);
      assert.deepEqual(body.processingJobs.map((entry) => entry.domains), [['stmarys.edu.au'], ['stmarys.edu.au']]);
    });
  });

  describe('Scenario: A domain is normalized the same way it always was', () => {
    it('Then processingJobs[0].domains is ["stmarys.edu.au"]', async () => {
      const { response, body } = await putSettings({
        processingJobs: [job({ domains: ['https://StMarys.EDU.au/news'] })],
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au']);
    });
  });

  describe('Scenario: A job name keeps its exact characters', () => {
    it('Then processingJobs[0].name is "P&C Association - École, Annexe"', async () => {
      const name = 'P&C Association - École, Annexe';
      const { response, body } = await putSettings({ processingJobs: [job({ name })] });
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs[0].name, name);
    });
  });

  describe('Scenario: Twenty jobs are accepted', () => {
    it('Then the response is 200 and processingJobs has 20 entries', async () => {
      const jobs = Array.from({ length: 20 }, (_, i) =>
        job({ name: `Job ${i}`, schoolName: `School ${i}`, domains: [`school${i}.edu.au`] })
      );
      const { response, body } = await putSettings({ processingJobs: jobs });
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs.length, 20);
      assert.equal(new Set(body.processingJobs.map((entry) => entry.id)).size, 20, 'ids collided');
    });
  });

  describe('Scenario: Saving clears every legacy attribute in the same write', () => {
    const legacyRow = {
      schoolNames: new Set(["St Mary's Primary"]),
      searchDomains: new Set(['stmarys.edu.au']),
      schoolName: "St Mary's Primary",
    };

    it('Then the UpdateItem expression SETs processingJobs and REMOVEs all three legacy attributes', () => {
      const params = buildUpdateParams({
        tableName: 'test-connections-table',
        key: { userId: connectionUserId(testGoogleSub) },
        updates: buildConnectionPatch(requireValidSettings({ processingJobs: [job()] })),
      });

      const names = params.ExpressionAttributeNames;
      const keyFor = (attribute) => Object.keys(names).find((nameKey) => names[nameKey] === attribute);

      assert.match(params.UpdateExpression, /^SET /);
      assert.match(params.UpdateExpression, / REMOVE /);
      const [setClause, removeClause] = params.UpdateExpression.split(' REMOVE ');
      assert.ok(setClause.includes(`${keyFor('processingJobs')} = `), 'processingJobs is not SET');
      for (const legacy of ['schoolNames', 'searchDomains', 'schoolName']) {
        assert.ok(removeClause.split(', ').includes(keyFor(legacy)), `${legacy} is not REMOVEd`);
      }
    });

    it('And ExpressionAttributeValues is present on that UpdateItem (mixed patch, not all-removals)', () => {
      const params = buildUpdateParams({
        tableName: 'test-connections-table',
        key: { userId: connectionUserId(testGoogleSub) },
        updates: buildConnectionPatch(requireValidSettings({ processingJobs: [job()] })),
      });
      assert.ok(params.ExpressionAttributeValues, 'ExpressionAttributeValues was omitted');
      assert.ok(Object.values(params.ExpressionAttributeValues).some((v) => Array.isArray(v)));
    });

    it('And the stored row afterwards has none of those three legacy attributes', async () => {
      const spy = makeUpdateItemSpy(legacyRow);
      const { response, body } = await putSettings({ processingJobs: [job()] }, { spy });

      assert.equal(response.statusCode, 200);
      for (const legacy of ['schoolNames', 'searchDomains', 'schoolName']) {
        assert.equal(spy.calls[0].updates[legacy], REMOVE_ATTRIBUTE, `${legacy} was not retired`);
        assert.ok(!(legacy in body), `${legacy} leaked into the response`);
      }
    });
  });
});

/* =========================================================================
 * Feature: Processing job ids are stable across a rename
 * ========================================================================= */

describe('Feature: Processing job ids are stable across a rename', () => {
  describe('Scenario: A client-echoed UUID is preserved', () => {
    it('Then the response is 200, the id survives and the name is the new one', async () => {
      const { response, body } = await putSettings({
        processingJobs: [job({ id: CLIENT_UUID, name: 'New name' })],
      });
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs[0].id, CLIENT_UUID);
      assert.equal(body.processingJobs[0].name, 'New name');
    });
  });

  describe('Scenario Outline: An unusable id is replaced rather than rejected', () => {
    const examples = [
      ['absent', undefined],
      ['""', ''],
      ['"default"', 'default'],
      ['"not-a-uuid"', 'not-a-uuid'],
      ['12345', 12345],
    ];
    for (const [label, id] of examples) {
      it(`Given id ${label}, Then 200 and processingJobs[0].id is a freshly generated UUID`, async () => {
        const { response, body } = await putSettings({ processingJobs: [job({ id })] });
        assert.equal(response.statusCode, 200);
        assert.match(body.processingJobs[0].id, UUID_RE);
        assert.notEqual(body.processingJobs[0].id, id);
      });
    }
  });

  describe('Scenario: Two jobs sharing one id are refused', () => {
    it('Then 400 with field "processingJobs" and updateItem was never called', async () => {
      const spy = makeUpdateItemSpy();
      const { response, body } = await putSettings(
        { processingJobs: [job({ id: CLIENT_UUID }), job({ name: 'Second', id: CLIENT_UUID })] },
        { spy }
      );
      assert.equal(response.statusCode, 400);
      assert.equal(body.field, 'processingJobs');
      assert.deepEqual(spy.calls, [], 'a refused save still wrote to the table');
    });
  });
});

/* =========================================================================
 * Feature: Invalid processing jobs are refused and nothing is written
 * ========================================================================= */

describe('Feature: Invalid processing jobs are refused and nothing is written', () => {
  /** Then the response is 400 with this field, and updateItem was never called. */
  async function refusedWith(body, field) {
    const spy = makeUpdateItemSpy();
    const result = await putSettings(body, { spy });
    assert.equal(result.response.statusCode, 400, `expected 400, got ${result.response.statusCode}`);
    assert.equal(result.body.field, field);
    assert.deepEqual(spy.calls, [], 'a refused save still wrote to the table');
    return result.body;
  }

  describe('Scenario: Duplicate job names differing only by case are refused', () => {
    it('Then 400, field "processingJobs", the message names the duplicate, nothing written', async () => {
      const body = await refusedWith(
        { processingJobs: [job({ name: "St Mary's" }), job({ name: "ST MARY'S" })] },
        'processingJobs'
      );
      assert.ok(body.error.includes("ST MARY'S"), body.error);
      assert.ok(body.error.includes("St Mary's"), body.error);
    });
  });

  describe('Scenario: A missing required field is refused and names the offending job', () => {
    it('Then 400 with field "processingJobs[1].schoolName" and nothing written', async () => {
      const { name, domains } = job();
      await refusedWith(
        { processingJobs: [job({ name: 'First' }), { name: `Second ${name}`, domains }] },
        'processingJobs[1].schoolName'
      );
    });
  });

  describe('Scenario Outline: Each required per-job field is enforced', () => {
    const examples = [
      ['name', 'absent', { name: undefined }],
      ['name', '""', { name: '' }],
      ['name', '"   "', { name: '   ' }],
      ['name', '42', { name: 42 }],
      ['schoolName', 'absent', { schoolName: undefined }],
      ['schoolName', '"  "', { schoolName: '  ' }],
      ['schoolName', '["A","B"]', { schoolName: ['A', 'B'] }],
      // TASK-059: `domains` is a LIST and is OPTIONAL, so "absent" moved to the
      // accepted outline below; what is still refused is a bad CONTAINER or a
      // bad ENTRY.
      ['domains', 'a bare string', { domains: 'stmarys.edu.au' }],
      ['domains', 'a number', { domains: 42 }],
      ['domains', 'holding ""', { domains: [''] }],
      ['domains', 'holding "stmarys"', { domains: ['stmarys'] }],
      ['domains', 'holding "-bad-.edu.au"', { domains: ['-bad-.edu.au'] }],
      ['domains', 'holding a nested ["a.edu.au"]', { domains: [['a.edu.au']] }],
    ];
    for (const [field, label, overrides] of examples) {
      it(`Given ${field} is ${label}, Then 400 with field "processingJobs[0].${field}"`, async () => {
        await refusedWith({ processingJobs: [job(overrides)] }, `processingJobs[0].${field}`);
      });
    }
  });

  describe('Scenario Outline: domains is OPTIONAL, so absent/null/[] all save (TASK-059)', () => {
    for (const [label, value] of [['absent', undefined], ['null', null], ['[]', []]]) {
      it(`Given domains is ${label}, Then 200 and processingJobs[0].domains is []`, async () => {
        const payload = job();
        delete payload.domains;
        if (value !== undefined) payload.domains = value;

        const { response, body } = await putSettings({ processingJobs: [payload] });
        assert.equal(response.statusCode, 200, JSON.stringify(body));
        assert.deepEqual(body.processingJobs[0].domains, []);
      });
    }
  });

  describe('Scenario: A public mail provider domain is still refused, per job', () => {
    it('Then 400 with field "processingJobs[0].domains" saying it is a public email provider', async () => {
      const body = await refusedWith(
        { processingJobs: [job({ domains: ['stmarys.edu.au', 'gmail.com'] })] },
        'processingJobs[0].domains'
      );
      assert.ok(body.error.includes('is a public email provider'), body.error);
      assert.ok(body.error.includes('gmail.com'), body.error);
    });
  });

  describe('Scenario: An empty job list is refused', () => {
    it('Then 400, field "processingJobs", saying at least one processing job is required', async () => {
      const body = await refusedWith({ processingJobs: [] }, 'processingJobs');
      assert.equal(body.error, 'At least one processing job is required');
    });
  });

  describe('Scenario Outline: A non-array processingJobs is refused', () => {
    const examples = [
      ['absent', {}],
      ['null', { processingJobs: null }],
      ['"St Mary\'s"', { processingJobs: "St Mary's" }],
      ['{ "0": { } }', { processingJobs: { 0: {} } }],
    ];
    for (const [label, payload] of examples) {
      it(`Given processingJobs ${label}, Then 400 with field "processingJobs"`, async () => {
        await refusedWith(payload, 'processingJobs');
      });
    }
  });

  describe('Scenario: More than twenty jobs is refused, counted before de-duplication', () => {
    it('Then 400, field "processingJobs", and the message mentions 20', async () => {
      const jobs = [
        ...Array.from({ length: 18 }, (_, i) => job({ name: `Job ${i}` })),
        job({ name: 'Job 0' }),
        job({ name: 'Job 1' }),
        job({ name: 'Job 2' }),
      ];
      assert.equal(jobs.length, 21);
      const body = await refusedWith({ processingJobs: jobs }, 'processingJobs');
      assert.ok(body.error.includes('20'), body.error);
    });
  });

  describe('Scenario: More than twenty search terms in one job is refused before de-duplication', () => {
    it('Then 400, field "processingJobs[0].searchTerms", and the message mentions 20', async () => {
      const terms = [
        ...Array.from({ length: 16 }, (_, i) => `term ${i}`),
        'term 0',
        'term 1',
        'term 2',
        'term 3',
        'term 4',
      ];
      assert.equal(terms.length, 21);
      const body = await refusedWith(
        { processingJobs: [job({ searchTerms: terms })] },
        'processingJobs[0].searchTerms'
      );
      assert.ok(body.error.includes('20'), body.error);
    });
  });

  describe('Scenario: A bare string searchTerms is refused, never comma-split', () => {
    it('Then 400 with field "processingJobs[0].searchTerms"', async () => {
      await refusedWith(
        { processingJobs: [job({ searchTerms: 'canteen, uniform' })] },
        'processingJobs[0].searchTerms'
      );
    });
  });

  describe('Scenario: A blank search term is refused', () => {
    it('Then 400 with field "processingJobs[0].searchTerms"', async () => {
      await refusedWith(
        { processingJobs: [job({ searchTerms: ['canteen', '   '] })] },
        'processingJobs[0].searchTerms'
      );
    });
  });

  describe('Scenario: Duplicate search terms collapse rather than failing the save', () => {
    it('Then 200 and processingJobs[0].searchTerms is ["canteen"]', async () => {
      const { response, body } = await putSettings({
        processingJobs: [job({ searchTerms: ['canteen', ' canteen '] })],
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs[0].searchTerms, ['canteen']);
    });
  });

  describe('Scenario: A search term over 80 code points is refused, counted by code point', () => {
    it('Then 400, field "processingJobs[0].searchTerms", and the message mentions 80', async () => {
      const term = '🎒'.repeat(81);
      assert.equal([...term].length, 81);
      assert.ok(term.length > 81, 'fixture is not multi-unit');
      const body = await refusedWith(
        { processingJobs: [job({ searchTerms: [term] })] },
        'processingJobs[0].searchTerms'
      );
      assert.ok(body.error.includes('80'), body.error);
    });
  });

  describe('Scenario: A search term of exactly 80 emoji code points is accepted', () => {
    it('Then the response status code is 200', async () => {
      const term = '🎒'.repeat(80);
      assert.equal([...term].length, 80);
      const { response, body } = await putSettings({ processingJobs: [job({ searchTerms: [term] })] });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs[0].searchTerms, [term]);
    });
  });

  describe('Scenario: A job name over 120 code points is refused', () => {
    it('Then 400, field "processingJobs[0].name", and the message mentions 120', async () => {
      const body = await refusedWith(
        { processingJobs: [job({ name: '👍'.repeat(121) })] },
        'processingJobs[0].name'
      );
      assert.ok(body.error.includes('120'), body.error);
    });
  });

  describe('Scenario: A rejected value is echoed length-capped', () => {
    it('Then the echoed value is at most 64 characters plus an ellipsis', async () => {
      const body = await refusedWith(
        { processingJobs: [job({ name: 'A'.repeat(500) })] },
        'processingJobs[0].name'
      );
      const echoed = body.error.match(/^"([^"]*)"/);
      assert.ok(echoed, `no quoted echo in: ${body.error}`);
      assert.equal(echoed[1], `${'A'.repeat(64)}...`);
      assert.ok(!body.error.includes('A'.repeat(65)), 'the whole value leaked into the message');
    });
  });

  describe('Scenario: Unknown per-job keys are dropped, not stored and not rejected', () => {
    it('Then 200 and the stored job has exactly the five documented keys', async () => {
      const spy = makeUpdateItemSpy();
      const { response, body } = await putSettings(
        { processingJobs: [job({ isAdmin: true, extra: 'nope' })] },
        { spy }
      );
      assert.equal(response.statusCode, 200);
      assert.deepEqual(Object.keys(spy.calls[0].updates.processingJobs[0]).sort(), [
        'domains',
        'id',
        'name',
        'schoolName',
        'searchTerms',
      ]);
      assert.ok(!('isAdmin' in body.processingJobs[0]));
      assert.ok(!('extra' in body.processingJobs[0]));
    });
  });

  describe('Scenario: A legacy-only body is refused now that the contract has moved', () => {
    it('Then 400 with field "processingJobs" and updateItem was never called', async () => {
      await refusedWith(
        { schoolNames: ["St Mary's"], searchDomains: ['stmarys.edu.au'] },
        'processingJobs'
      );
    });
  });
});

/* =========================================================================
 * Feature: Existing rows migrate on read into one default processing job
 * ========================================================================= */

describe('Feature: Existing rows migrate on read into one default processing job', () => {
  const baseRow = {
    userId: connectionUserId(testGoogleSub),
    email: testEmail,
    hasRefreshToken: true,
  };

  describe('Scenario: An old-shape row reads back as one synthesized default job', () => {
    const row = {
      ...baseRow,
      schoolNames: new Set(["St Mary's Primary"]),
      searchDomains: new Set(['stmarys.edu.au']),
    };

    it('Then 200 with exactly one synthesized "default" job carrying the legacy values', async () => {
      const { response, body } = await getSettings(row);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs, [
        {
          id: 'default',
          name: 'Default',
          schoolName: "St Mary's Primary",
          domains: ['stmarys.edu.au'],
          searchTerms: [],
        },
      ]);
    });

    it('And the response body has no schoolNames or searchDomains key', async () => {
      const { body } = await getSettings(row);
      assert.ok(!('schoolNames' in body));
      assert.ok(!('searchDomains' in body));
      assert.ok(!('schoolName' in body));
    });

    it('And no write was issued during the GET', async () => {
      const { writes } = await getSettings(row);
      assert.deepEqual(writes, [], 'a GET issued a write');
      assert.ok(!('processingJobs' in row), 'the GET wrote the synthesized job back onto the stored row');
    });
  });

  describe('Scenario: Remaining legacy entries are folded into searchTerms, not dropped', () => {
    it('Then the one job carries the first of each and the rest as search terms', async () => {
      const { body } = await getSettings({
        ...baseRow,
        schoolNames: new Set(['Alpha School', 'Beta School', 'Gamma School']),
        searchDomains: new Set(['alpha.edu.au', 'beta.edu.au']),
      });
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].schoolName, 'Alpha School');
      assert.deepEqual(body.processingJobs[0].domains, ['alpha.edu.au']);
      assert.deepEqual(body.processingJobs[0].searchTerms, ['Beta School', 'Gamma School', 'beta.edu.au']);
    });
  });

  describe('Scenario: The synthesized job is identical on every read of the same row', () => {
    it('Then both responses agree on schoolName, domains and searchTerms', async () => {
      // A DynamoDB string set is UNORDERED: these are the same row observed with
      // two different storage orders.
      const first = await getSettings({
        ...baseRow,
        schoolNames: new Set(['Gamma School', 'Alpha School', 'Beta School']),
        searchDomains: new Set(['beta.edu.au', 'alpha.edu.au']),
      });
      const second = await getSettings({
        ...baseRow,
        schoolNames: new Set(['Beta School', 'Gamma School', 'Alpha School']),
        searchDomains: new Set(['alpha.edu.au', 'beta.edu.au']),
      });

      assert.equal(first.body.processingJobs[0].schoolName, second.body.processingJobs[0].schoolName);
      assert.deepEqual(first.body.processingJobs[0].domains, second.body.processingJobs[0].domains);
      assert.deepEqual(first.body.processingJobs[0].searchTerms, second.body.processingJobs[0].searchTerms);
      assert.equal(first.body.processingJobs[0].schoolName, 'Alpha School');
    });
  });

  describe('Scenario: A legacy row with only school names synthesizes an EMPTY domains list', () => {
    it('Then schoolName is "Alpha School" and domains is []', async () => {
      const { body } = await getSettings({ ...baseRow, schoolNames: new Set(['Alpha School']) });
      assert.equal(body.processingJobs[0].schoolName, 'Alpha School');
      assert.deepEqual(body.processingJobs[0].domains, []);
      assert.ok(!('domain' in body.processingJobs[0]));
    });
  });

  describe('Scenario: A legacy row with only domains synthesizes an empty school name', () => {
    it('Then schoolName is "" and domains is ["alpha.edu.au"]', async () => {
      const { body } = await getSettings({ ...baseRow, searchDomains: new Set(['alpha.edu.au']) });
      assert.equal(body.processingJobs[0].schoolName, '');
      assert.deepEqual(body.processingJobs[0].domains, ['alpha.edu.au']);
    });
  });

  describe('Scenario: A pre-TASK-053 row whose school is still a scalar also migrates', () => {
    it('Then schoolName is "Alpha School" and the response has no schoolName key', async () => {
      const { body } = await getSettings({
        ...baseRow,
        schoolName: 'Alpha School',
        searchDomains: new Set(['alpha.edu.au']),
      });
      assert.equal(body.processingJobs[0].schoolName, 'Alpha School');
      assert.deepEqual(body.processingJobs[0].domains, ['alpha.edu.au']);
      assert.ok(!('schoolName' in body));
    });
  });

  describe('Scenario: Real stored jobs always win over legacy attributes', () => {
    it('Then the body is the stored list and no "Default" job is synthesized', async () => {
      const stored = [
        { id: CLIENT_UUID, name: 'Real', schoolName: 'Real School', domains: ['real.edu.au'], searchTerms: ['canteen'] },
      ];
      const { body } = await getSettings({
        ...baseRow,
        processingJobs: stored,
        schoolNames: new Set(['Legacy School']),
        searchDomains: new Set(['legacy.edu.au']),
      });
      assert.deepEqual(body.processingJobs, stored);
      assert.ok(!body.processingJobs.some((entry) => entry.name === 'Default'));
    });
  });

  describe('Scenario: An empty stored processingJobs list still triggers synthesis', () => {
    it('Then the body has 1 entry named "Default"', async () => {
      const { body } = await getSettings({
        ...baseRow,
        processingJobs: [],
        schoolNames: new Set(['Legacy School']),
      });
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].name, 'Default');
    });
  });

  describe('Scenario: A row with nothing at all reports an empty list', () => {
    it('Then GET /settings reports processingJobs as []', async () => {
      const { response, body } = await getSettings({ ...baseRow });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(body.processingJobs, []);
    });
  });

  describe('Scenario: /auth/me sees the same migration', () => {
    it('Then the body has 1 entry named "Default"', async () => {
      const { response, body } = await getAuthMe({
        ...baseRow,
        schoolNames: new Set(['Alpha School']),
        searchDomains: new Set(['alpha.edu.au']),
      });
      assert.equal(response.statusCode, 200);
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].name, 'Default');
      assert.ok(!('schoolNames' in body));
      assert.ok(!('searchDomains' in body));
    });
  });

  describe('Scenario: /auth/me reports null rather than [] for a row with nothing', () => {
    it('Then the body processingJobs is null - the split is intentional', async () => {
      const { body } = await getAuthMe({ ...baseRow });
      assert.equal(body.processingJobs, null);
    });
  });

  describe('Scenario: Saving a migrated job replaces the placeholder id with a real one', () => {
    it('Then 200, the id is a canonical UUID and not "default", and the legacy row is cleared', async () => {
      // Given a legacy row that reads back as the synthesized "default" job.
      const legacyRow = {
        ...baseRow,
        schoolNames: new Set(['Alpha School']),
      };
      const read = await getSettings(legacyRow);
      const [synthesized] = read.body.processingJobs;
      assert.equal(synthesized.id, 'default');
      assert.deepEqual(synthesized.domains, [], 'the fixture must be the incomplete synthesized job');

      // When they PUT it back with id "default" and a filled-in domain.
      const spy = makeUpdateItemSpy({
        schoolNames: new Set(['Alpha School']),
        searchDomains: new Set(['alpha.edu.au']),
        schoolName: 'Alpha School',
      });
      const { response, body } = await putSettings(
        { processingJobs: [{ ...synthesized, domains: ['alpha.edu.au'] }] },
        { spy }
      );

      assert.equal(response.statusCode, 200);
      assert.match(body.processingJobs[0].id, UUID_RE);
      assert.notEqual(body.processingJobs[0].id, 'default');
      for (const legacy of ['schoolNames', 'searchDomains', 'schoolName']) {
        assert.equal(spy.calls[0].updates[legacy], REMOVE_ATTRIBUTE, `${legacy} was not retired`);
        assert.ok(!(legacy in body));
      }
    });
  });
});

/* =========================================================================
 * Feature: The scan pipeline degrades safely
 *
 * The ticket wrote this as "until TASK-056 lands". TASK-056 has since landed and
 * scan.mjs now CONSUMES processingJobs, so the surviving guarantee - and the one
 * asserted here - is that a row in the new shape neither crashes nor silently
 * calls Gmail when there is nothing usable to search for.
 * ========================================================================= */

describe('Feature: The scan pipeline degrades safely on the new settings shape', () => {
  /** Every I/O seam injected; a call to any of them fails the scenario. */
  function scanDeps(connection, overrides = {}) {
    const gmailCalls = [];
    return {
      calls: gmailCalls,
      deps: {
        env: { ...defaultEnv, ANTHROPIC_API_KEY: 'test-key' },
        log: () => {},
        getConnection: async () => connection,
        updateConnection: async () => {
          throw new Error('a not_configured scan must not patch the row');
        },
        acquireScanLock: async () => {
          throw new Error('a not_configured scan must not take the lock');
        },
        releaseScanLock: async () => {
          throw new Error('a not_configured scan must not release a lock it never took');
        },
        fetchCandidateMessages: async (args) => {
          gmailCalls.push(args);
          throw new Error('Gmail must not be called');
        },
        ...overrides,
      },
    };
  }

  describe('Scenario: A row saved in the new shape with no usable search field reports not_configured', () => {
    it('Then the scan status is "not_configured", Gmail was never called, and nothing threw', async () => {
      // The whole-row equivalent of the synthesized-but-incomplete job: a stored
      // job with neither a school name, a domain nor a search term has nothing to
      // query on, and must never become a bare `after:` sweep of the mailbox.
      const { deps, calls } = scanDeps({
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        hasRefreshToken: true,
        processingJobs: [{ id: 'job-1', name: 'Empty', schoolName: '', domains: [], searchTerms: [] }],
      });

      const result = await runScan({ userId: connectionUserId(testGoogleSub) }, deps);
      assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      assert.deepEqual(calls, [], 'Gmail was called for an unusable job');
      assert.equal(result.messagesScanned, 0);
      assert.equal(result.eventsCreated, 0);
    });
  });

  describe('Scenario: A row with no settings at all reports not_configured rather than crashing', () => {
    it('Then the scan status is "not_configured" and Gmail was never called', async () => {
      const { deps, calls } = scanDeps({
        userId: connectionUserId(testGoogleSub),
        email: testEmail,
        hasRefreshToken: true,
      });

      const result = await runScan({ userId: connectionUserId(testGoogleSub) }, deps);
      assert.equal(result.status, SCAN_STATUS.NOT_CONFIGURED);
      assert.deepEqual(calls, []);
    });
  });
});

/* =========================================================================
 * Feature: Personal data never reaches a log line
 * ========================================================================= */

describe('Feature: Personal data never reaches a log line', () => {
  let captured = [];
  let originalLog;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (...args) => captured.push(args);
  });

  afterEach(() => {
    console.log = originalLog;
  });

  describe('Scenario: A successful save logs counts only', () => {
    it('Then 200, the settings-saved log line carries counts, and no personal text appears', async () => {
      const response = await handler(
        makeEvent('PUT', '/calendar/api/settings', {
          processingJobs: [
            job({
              name: "St Mary's",
              schoolName: "St Mary's Primary",
              domains: ['stmarys.edu.au'],
              searchTerms: ['canteen roster'],
            }),
          ],
        }),
        {},
        { env: { ...defaultEnv, CALENDAR_LOG_LEVEL: 'basic' }, updateItem: makeUpdateItemSpy().updateItem }
      );

      assert.equal(response.statusCode, 200, 'the 200 path threw - most likely the log line still reads a dead key');

      const logs = JSON.stringify(captured);
      assert.ok(logs.includes('jobCount'), 'the success log carries no job count');
      assert.ok(logs.includes('searchTermCount'), 'the success log carries no search-term count');
      for (const personal of ["St Mary's", "St Mary's Primary", 'stmarys.edu.au', 'canteen roster']) {
        assert.ok(!logs.includes(personal), `the log leaked personal data: ${personal}`);
      }
      // The keys that would have thrown a TypeError inside the 200 path.
      assert.ok(!logs.includes('schoolNameCount'));
      assert.ok(!logs.includes('domainCount'));
    });
  });
});
