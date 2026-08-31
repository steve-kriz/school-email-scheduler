/**
 * task-059-multiple-domains.test.js - TASK-059 UNIT tests.
 *
 * A processing job carries `domains: string[]` instead of the singular
 * `domain: string`. One `describe` per Acceptance Criterion group:
 *
 *   settings.mjs      AC 1-17   validateJobDomains / validateProcessingJobs /
 *                               buildConnectionPatch / MAX_SEARCH_DOMAINS_PER_JOB
 *   gmail.mjs         AC 18-25  buildJobClauses / hasJobQueryClauses / buildJobQuery
 *   scan.mjs          AC 26-33  toProcessingJobs + the read-compat shim
 *   connections.mjs   AC 37-40  synthesizeLegacyProcessingJob / toPublicJson
 *   cross-cutting     AC 41-42  the co-deploy note
 *
 * NO DATABASE. Every function under test here is pure: nothing in this file
 * constructs a DynamoDB client, reads credentials or touches the network - the
 * "stored rows" are plain object literals in the shapes DynamoDB hands back.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  validateProcessingJobs,
  validateSettingsPayload,
  buildConnectionPatch,
  toSettingsJson,
  SettingsValidationError,
  MAX_SEARCH_DOMAINS_PER_JOB,
  MAX_SEARCH_DOMAINS,
  MAX_SEARCH_TERMS_PER_JOB,
  MAX_PROCESSING_JOBS,
} from '../../src/lambda/calendar/backend/settings.mjs';

import {
  buildJobClauses,
  hasJobQueryClauses,
  buildJobQuery,
  buildQuery,
} from '../../src/lambda/calendar/backend/gmail.mjs';

import { toProcessingJobs } from '../../src/lambda/calendar/backend/scan.mjs';

import { toPublicJson, REMOVE_ATTRIBUTE } from '../../src/lambda/calendar/backend/connections.mjs';

import { buildUserContent, isWatchedSender } from '../../src/lambda/calendar/backend/anthropic.mjs';

const SINCE = new Date('2026-06-02T00:00:00.000Z');
const CLIENT_UUID = '6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d';

/** A deterministic id generator, so no branch depends on randomness. */
function stubIds(prefix = 'id') {
  let n = 0;
  return { newId: () => `${prefix}-${(n += 1)}` };
}

/** One valid job payload, overridable field by field. */
function job(overrides = {}) {
  return {
    name: "St Mary's",
    schoolName: "St Mary's Primary",
    domains: ['stmarys.edu.au'],
    searchTerms: [],
    ...overrides,
  };
}

/** Validate and return the thrown SettingsValidationError, or fail. */
function refusal(jobs) {
  try {
    validateProcessingJobs(jobs, stubIds());
  } catch (err) {
    assert.ok(err instanceof SettingsValidationError, `expected SettingsValidationError, got ${err}`);
    return err;
  }
  return assert.fail('validateProcessingJobs accepted a payload it should have refused');
}

function source(relative) {
  return readFileSync(fileURLToPath(new URL(`../../src/lambda/calendar/backend/${relative}`, import.meta.url)), 'utf8');
}

/* =========================================================================
 * settings.mjs - AC 1-17
 * ========================================================================= */

describe('TASK-059 unit: validateProcessingJobs output shape (AC 1, 2)', () => {
  it('AC 1: returns exactly { id, name, schoolName, domains, searchTerms } per job', () => {
    const [validated] = validateProcessingJobs([job()], stubIds());
    assert.deepEqual(Object.keys(validated).sort(), ['domains', 'id', 'name', 'schoolName', 'searchTerms']);
  });

  it('AC 1: the key "domain" never appears in the output, for any input', () => {
    const inputs = [
      job(),
      job({ domains: [] }),
      job({ domain: 'stmarys.edu.au' }),
      job({ domain: 'stmarys.edu.au', domains: ['pandc.org.au'] }),
    ];
    for (const entry of inputs) {
      const [validated] = validateProcessingJobs([entry], stubIds());
      assert.ok(!('domain' in validated), `singular key survived for ${JSON.stringify(entry)}`);
    }
  });

  it('AC 2: an incoming singular `domain` is DROPPED as an unknown key, not aliased and not an error', () => {
    const [validated] = validateProcessingJobs(
      [{ name: "St Mary's", schoolName: "St Mary's Primary", domain: 'stmarys.edu.au' }],
      stubIds()
    );
    assert.deepEqual(validated.domains, [], 'the singular key was aliased into domains');
    assert.ok(!('domain' in validated));
  });

  it('AC 2: a singular `domain` alongside a real `domains` list does not contaminate it', () => {
    const [validated] = validateProcessingJobs([job({ domain: 'ignored.edu.au', domains: ['pandc.org.au'] })], stubIds());
    assert.deepEqual(validated.domains, ['pandc.org.au']);
  });
});

describe('TASK-059 unit: domains is OPTIONAL (AC 3, 4)', () => {
  for (const [label, value] of [['absent', undefined], ['null', null], ['an explicit empty array', []]]) {
    it(`AC 3/4: ${label} normalises to [] and the job saves`, () => {
      const payload = job();
      delete payload.domains;
      if (value !== undefined) payload.domains = value;

      const [validated] = validateProcessingJobs([payload], stubIds());
      assert.deepEqual(validated.domains, []);
    });
  }
});

describe('TASK-059 unit: domains must be a LIST (AC 5)', () => {
  for (const [label, value] of [
    ['a bare string', 'stmarys.edu.au'],
    ['a comma-separated string', 'stmarys.edu.au, pandc.org.au'],
    ['a number', 42],
    ['an object', { 0: 'stmarys.edu.au' }],
    ['true', true],
  ]) {
    it(`AC 5: ${label} is refused with "School email domains must be a list"`, () => {
      const err = refusal([job({ domains: value })]);
      assert.equal(err.field, 'processingJobs[0].domains');
      assert.equal(err.message, 'School email domains must be a list');
    });
  }

  it('AC 5: a comma-separated string is NEVER split into two domains', () => {
    const err = refusal([job({ domains: 'stmarys.edu.au, pandc.org.au' })]);
    assert.ok(!err.message.includes('pandc'), 'the validator looked inside the string');
  });
});

describe('TASK-059 unit: MAX_SEARCH_DOMAINS_PER_JOB and the count cap (AC 6, 7)', () => {
  it('AC 6: MAX_SEARCH_DOMAINS_PER_JOB is exported and is 10', () => {
    assert.equal(MAX_SEARCH_DOMAINS_PER_JOB, 10);
  });

  it('AC 6: the retained flat MAX_SEARCH_DOMAINS is left alone and is a separate constant', () => {
    assert.equal(MAX_SEARCH_DOMAINS, 10);
    assert.notEqual(MAX_SEARCH_TERMS_PER_JOB, MAX_SEARCH_DOMAINS_PER_JOB, 'the two per-job caps are distinct values');
  });

  it('AC 6: the MAX_SEARCH_DOMAINS docblock no longer claims a job carries exactly one domain', () => {
    assert.ok(
      !source('settings.mjs').includes('a processing job carries exactly one domain'),
      'the stale "exactly one domain" docblock line survived'
    );
  });

  it('AC 6: exactly 10 domains is accepted', () => {
    const domains = Array.from({ length: 10 }, (_, i) => `school${i}.edu.au`);
    const [validated] = validateProcessingJobs([job({ domains })], stubIds());
    assert.deepEqual(validated.domains, domains);
  });

  it('AC 7: the cap is counted on what was SUBMITTED, before de-duplication', () => {
    // Eleven entries, two of which are duplicates: de-duplicated it would be 9,
    // which fits - so a cap applied after collapsing would silently accept it.
    const domains = [
      ...Array.from({ length: 9 }, (_, i) => `school${i}.edu.au`),
      'school0.edu.au',
      '@School1.EDU.au',
    ];
    assert.equal(domains.length, 11);
    const err = refusal([job({ domains })]);
    assert.equal(err.field, 'processingJobs[0].domains');
    assert.equal(err.message, 'Enter at most 10 school email domains for one processing job');
  });

  it('AC 7: the too-many message is checked BEFORE any per-entry rule', () => {
    // Eleven entries where one is also invalid: the count wins, so the message
    // is about the count and not about the invalid entry.
    const domains = [...Array.from({ length: 10 }, (_, i) => `school${i}.edu.au`), 'not a domain'];
    const err = refusal([job({ domains })]);
    assert.ok(err.message.startsWith('Enter at most 10'), err.message);
  });
});

describe('TASK-059 unit: per-entry rule order and messages (AC 8, 9, 10, 11)', () => {
  for (const [label, entry] of [
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['an "@"-only entry', '@'],
    ['a number', 42],
    ['null', null],
    ['a nested array', ['stmarys.edu.au']],
    ['an object', {}],
  ]) {
    it(`AC 9: ${label} is "A school email domain cannot be blank", not a useless "" is not valid`, () => {
      const err = refusal([job({ domains: ['stmarys.edu.au', entry] })]);
      assert.equal(err.field, 'processingJobs[0].domains');
      assert.equal(err.message, 'A school email domain cannot be blank');
    });
  }

  for (const [label, entry] of [
    ['a lone label', 'stmarys'],
    ['a leading dot', '.stmarys.edu.au'],
    ['a trailing dot', 'stmarys.edu.au.'],
    ['a trailing hyphen', 'stmarys-.edu.au'],
    ['a leading hyphen', '-stmarys.edu.au'],
    ['spaces inside', 'not a domain'],
  ]) {
    it(`AC 10: ${label} echoes the RAW entry as not a valid email domain`, () => {
      const err = refusal([job({ domains: ['stmarys.edu.au', entry, 'pandc.org.au'] })]);
      assert.equal(err.field, 'processingJobs[0].domains');
      assert.equal(err.message, `"${entry}" is not a valid email domain`);
    });
  }

  it('AC 10: an over-length label (>63) is refused', () => {
    const entry = `${'a'.repeat(64)}.edu.au`;
    const err = refusal([job({ domains: [entry] })]);
    assert.ok(err.message.includes('is not a valid email domain'), err.message);
  });

  it('AC 10: an over-length domain (>253) is refused and the echo is truncated to 64 chars plus an ellipsis', () => {
    const entry = `${Array.from({ length: 7 }, () => 'a'.repeat(40)).join('.')}.edu.au`;
    assert.ok(entry.length > 253, `fixture is only ${entry.length} chars`);
    const err = refusal([job({ domains: [entry] })]);
    assert.equal(err.message, `"${`${'a'.repeat(40)}.${'a'.repeat(23)}`}..." is not a valid email domain`);
    const echoed = err.message.slice(1, err.message.indexOf('" is not'));
    assert.equal(echoed.length, 67, 'echo() truncates to 64 characters plus an ellipsis');
  });

  for (const host of ['gmail.com', 'GMAIL.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'hotmail.com']) {
    it(`AC 11: the public mail host ${host} is refused ANYWHERE in an otherwise valid list, naming the normalised host`, () => {
      const err = refusal([job({ domains: ['stmarys.edu.au', host, 'pandc.org.au'] })]);
      assert.equal(err.field, 'processingJobs[0].domains');
      assert.equal(
        err.message,
        `${host.toLowerCase()} is a public email provider, not a school domain - use the school's own domain`
      );
    });
  }

  it('AC 8: the rule ORDER is normalize -> blank -> isValidDomain -> isPublicMailDomain', () => {
    // "  " normalises to "" so it is BLANK, never "not a valid email domain".
    assert.equal(refusal([job({ domains: ['  '] })]).message, 'A school email domain cannot be blank');
    // "@gmail.com" normalises to a VALID domain, so it reaches the public check.
    assert.ok(refusal([job({ domains: ['@gmail.com'] })]).message.includes('is a public email provider'));
    // "gmail" is not a valid domain at all, so it never reaches the public check.
    assert.equal(refusal([job({ domains: ['gmail'] })]).message, '"gmail" is not a valid email domain');
  });
});

describe('TASK-059 unit: duplicates COLLAPSE, they do not error (AC 12)', () => {
  it('AC 12: three spellings of one domain store as one entry, first occurrence wins', () => {
    const [validated] = validateProcessingJobs(
      [job({ domains: ['StMarys.EDU.au', '@stmarys.edu.au', 'https://stmarys.edu.au/news'] })],
      stubIds()
    );
    assert.deepEqual(validated.domains, ['stmarys.edu.au']);
  });

  it('AC 12: input ORDER is preserved across a collapse', () => {
    const [validated] = validateProcessingJobs(
      [job({ domains: ['pandc.org.au', 'StMarys.EDU.au', 'PANDC.org.au', 'stmarys.edu.au:443'] })],
      stubIds()
    );
    assert.deepEqual(validated.domains, ['pandc.org.au', 'stmarys.edu.au']);
  });

  it('AC 12: duplicates that only match AFTER normalisation collapse silently', () => {
    const [validated] = validateProcessingJobs(
      [job({ domains: ['@StMarys.EDU.au', 'stmarys.edu.au'] })],
      stubIds()
    );
    assert.deepEqual(validated.domains, ['stmarys.edu.au']);
  });
});

describe('TASK-059 unit: indexed field naming (AC 13, 14)', () => {
  it('AC 13: the field carries the SUBMITTED zero-based index', () => {
    const err = refusal([
      job({ name: 'Zero' }),
      job({ name: 'One' }),
      job({ name: 'Two', domains: ['not a domain'] }),
    ]);
    assert.equal(err.field, 'processingJobs[2].domains');
  });

  it('AC 13: every domains failure mode carries the indexed name', () => {
    const cases = [
      { domains: 'a string' },
      { domains: Array.from({ length: 11 }, (_, i) => `s${i}.edu.au`) },
      { domains: [''] },
      { domains: ['stmarys'] },
      { domains: ['gmail.com'] },
    ];
    for (const override of cases) {
      const err = refusal([job({ name: 'A' }), job({ name: 'B', ...override })]);
      assert.equal(err.field, 'processingJobs[1].domains', JSON.stringify(override));
    }
  });

  it('AC 14: the SettingsValidationError docblock lists `domains`, not `domain`', () => {
    const text = source('settings.mjs');
    assert.ok(text.includes('"processingJobs[2].domains"'), 'the docblock example still names the singular key');
    assert.ok(!/`domain`, `searchTerms`/.test(text), 'the indexed <key> list still names the singular key');
  });

  it('AC 13: validateSettingsPayload surfaces the same indexed field without throwing', () => {
    const verdict = validateSettingsPayload({ processingJobs: [job(), job({ name: 'Two', domains: ['gmail.com'] })] });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.field, 'processingJobs[1].domains');
  });
});

describe('TASK-059 unit: buildConnectionPatch storage shape (AC 15)', () => {
  const stored = {
    id: CLIENT_UUID,
    name: 'Newsletters',
    schoolName: "St Mary's Primary",
    domains: ['stmarys.edu.au', 'pandc.org.au'],
    searchTerms: ['Year 4'],
  };

  it('AC 15: rebuilds domains key by key as a COPY of the validated array', () => {
    const patch = buildConnectionPatch({ processingJobs: [stored] });
    assert.deepEqual(patch.processingJobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
    assert.notEqual(patch.processingJobs[0].domains, stored.domains, 'the stored array was aliased, not copied');
  });

  it('AC 15: an unvalidated key (including a singular `domain`) cannot reach the stored item', () => {
    const patch = buildConnectionPatch({
      processingJobs: [{ ...stored, domain: 'sneaky.edu.au', isAdmin: true }],
    });
    assert.deepEqual(Object.keys(patch.processingJobs[0]).sort(), [
      'domains',
      'id',
      'name',
      'schoolName',
      'searchTerms',
    ]);
    assert.ok(!('domain' in patch.processingJobs[0]));
    assert.ok(!('isAdmin' in patch.processingJobs[0]));
  });

  it('AC 15: an EMPTY domains list is written as an empty LIST, not a Set and not a removal', () => {
    const patch = buildConnectionPatch({ processingJobs: [{ ...stored, domains: [] }] });
    const written = patch.processingJobs[0];
    assert.ok('domains' in written, 'domains was dropped rather than written empty');
    assert.ok(Array.isArray(written.domains));
    assert.ok(!(written.domains instanceof Set));
    assert.deepEqual(written.domains, []);
    assert.notEqual(written.domains, REMOVE_ATTRIBUTE);
  });

  it('AC 15: a non-array domains on an unvalidated job degrades to [] rather than being written through', () => {
    const patch = buildConnectionPatch({ processingJobs: [{ ...stored, domains: 'stmarys.edu.au' }] });
    assert.deepEqual(patch.processingJobs[0].domains, []);
  });

  it('AC 15: the three legacy REMOVEs are unchanged', () => {
    const patch = buildConnectionPatch({ processingJobs: [stored] });
    assert.equal(patch.schoolNames, REMOVE_ATTRIBUTE);
    assert.equal(patch.searchDomains, REMOVE_ATTRIBUTE);
    assert.equal(patch.schoolName, REMOVE_ATTRIBUTE);
  });
});

describe('TASK-059 unit: docblocks (AC 16, 41)', () => {
  it('AC 16: the @returns JSDoc names domains: string[]', () => {
    assert.ok(source('settings.mjs').includes('domains: string[]'));
  });

  it('AC 16: the module docblock states domains is OPTIONAL while name and schoolName are required', () => {
    assert.ok(source('settings.mjs').includes('`domains` IS OPTIONAL, `name` AND `schoolName` ARE REQUIRED'));
  });

  it('AC 41: settings.mjs records the TASK-060 co-deploy requirement', () => {
    const text = source('settings.mjs');
    assert.ok(text.includes('TASK-060'), 'no TASK-060 co-deploy note in the settings.mjs docblock');
  });
});

describe('TASK-059 unit: everything else in validateProcessingJobs is unchanged (AC 17)', () => {
  it('AC 17: duplicate job NAMES still error, case-insensitively, quoting both spellings', () => {
    const err = refusal([job({ name: 'Sport' }), job({ name: 'SPORT' })]);
    assert.equal(err.field, 'processingJobs');
    assert.ok(err.message.includes('"SPORT"'), err.message);
    assert.ok(err.message.includes('"Sport"'), err.message);
  });

  it('AC 17: two jobs MAY share a domain as long as their names differ', () => {
    const jobs = validateProcessingJobs(
      [job({ name: 'Newsletters' }), job({ name: 'Sport' })],
      stubIds()
    );
    assert.deepEqual(jobs.map((entry) => entry.domains), [['stmarys.edu.au'], ['stmarys.edu.au']]);
  });

  it('AC 17: a canonical UUID id is preserved and any other id is re-minted', () => {
    const [kept] = validateProcessingJobs([job({ id: CLIENT_UUID })], stubIds());
    assert.equal(kept.id, CLIENT_UUID);
    const [minted] = validateProcessingJobs([job({ id: 'default' })], stubIds());
    assert.equal(minted.id, 'id-1');
  });

  it('AC 17: duplicate client-supplied ids still error', () => {
    const err = refusal([job({ name: 'A', id: CLIENT_UUID }), job({ name: 'B', id: CLIENT_UUID })]);
    assert.equal(err.field, 'processingJobs');
    assert.equal(err.message, 'Each processing job must have its own id');
  });

  it('AC 17: MAX_PROCESSING_JOBS still applies', () => {
    const jobs = Array.from({ length: MAX_PROCESSING_JOBS + 1 }, (_, i) => job({ name: `Job ${i}` }));
    const err = refusal(jobs);
    assert.equal(err.field, 'processingJobs');
    assert.ok(err.message.includes(String(MAX_PROCESSING_JOBS)), err.message);
  });

  it('AC 17: name and schoolName are still REQUIRED even with a full domains list', () => {
    assert.equal(refusal([{ schoolName: 'S', domains: ['stmarys.edu.au'] }]).field, 'processingJobs[0].name');
    assert.equal(refusal([{ name: 'N', domains: ['stmarys.edu.au'] }]).field, 'processingJobs[0].schoolName');
  });

  it('AC 17: searchTerms validation is untouched', () => {
    const err = refusal([job({ searchTerms: 'canteen, uniform' })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
    assert.equal(err.message, 'Search terms must be a list');
  });
});

/* =========================================================================
 * gmail.mjs - AC 18-25
 * ========================================================================= */

describe('TASK-059 unit: buildJobClauses reads job.domains (AC 18, 19, 22)', () => {
  it('AC 19: domain clauses come first, in STORED order, then the school name, then each term', () => {
    const clauses = buildJobClauses({
      domains: ['stmarys.edu.au', 'pandc.org.au'],
      schoolName: "St Mary's",
      searchTerms: ['Year 4'],
    });
    assert.deepEqual(clauses, ['from:@stmarys.edu.au', 'from:@pandc.org.au', '"St Mary\'s"', '"Year 4"']);
  });

  it('AC 19: the TASK-056 byte-for-byte clause contract still holds for a single-domain job', () => {
    assert.deepEqual(
      buildJobClauses({ domains: ['stmarys.edu.au'], schoolName: "St Mary's Primary", searchTerms: ['Year 4', 'Canteen'] }),
      ['from:@stmarys.edu.au', '"St Mary\'s Primary"', '"Year 4"', '"Canteen"']
    );
  });

  it('AC 18: the singular `domain` key is NO LONGER read by the clause builder', () => {
    assert.deepEqual(buildJobClauses({ domain: 'stmarys.edu.au', schoolName: '', searchTerms: [] }), []);
  });

  it('AC 18: toDomainList tolerance is inherited - a Set and an { SS: [...] } read the same as an array', () => {
    const expected = ['from:@stmarys.edu.au', 'from:@pandc.org.au'];
    const base = { schoolName: '', searchTerms: [] };
    assert.deepEqual(buildJobClauses({ ...base, domains: ['stmarys.edu.au', 'pandc.org.au'] }), expected);
    assert.deepEqual(buildJobClauses({ ...base, domains: new Set(['stmarys.edu.au', 'pandc.org.au']) }), expected);
    assert.deepEqual(buildJobClauses({ ...base, domains: { SS: ['stmarys.edu.au', 'pandc.org.au'] } }), expected);
  });

  it('AC 22: entries duplicating each other after normalisation emit the clause ONCE', () => {
    assert.deepEqual(
      buildJobClauses({
        domains: ['StMarys.EDU.au', '@stmarys.edu.au', 'https://stmarys.edu.au/news', 'pandc.org.au'],
        schoolName: '',
        searchTerms: [],
      }),
      ['from:@stmarys.edu.au', 'from:@pandc.org.au']
    );
  });

  it('AC 22: entries that normalise to "" emit nothing', () => {
    assert.deepEqual(
      buildJobClauses({ domains: ['', '   ', 'stmarys.edu.au', null, 42], schoolName: '', searchTerms: [] }),
      ['from:@stmarys.edu.au']
    );
  });
});

describe('TASK-059 unit: buildJobQuery bracketing and regression (AC 20, 21, 23, 24)', () => {
  it('AC 20: multiple domains OR into ONE paren group with after: OUTSIDE it', () => {
    const query = buildJobQuery({
      job: { domains: ['stmarys.edu.au', 'pandc.org.au'], schoolName: "St Mary's", searchTerms: [] },
      since: SINCE,
    });
    assert.equal(query, '(from:@stmarys.edu.au OR from:@pandc.org.au OR "St Mary\'s") after:2026/06/02');
  });

  it('AC 21: a single-domain job is BYTE-IDENTICAL to the old single-domain query', () => {
    const legacy = buildQuery({ searchDomains: ['stmarys.edu.au'], since: SINCE });
    const perJob = buildJobQuery({
      job: { domains: ['stmarys.edu.au'], schoolName: '', searchTerms: [] },
      since: SINCE,
    });
    assert.equal(perJob, legacy);
    assert.equal(perJob, '(from:@stmarys.edu.au) after:2026/06/02');
  });

  it('AC 21: buildQuery itself is untouched and still ORs a whole-connection domain list', () => {
    assert.equal(
      buildQuery({ searchDomains: ['stmarys.edu.au', 'pandc.org.au'], since: SINCE }),
      '(from:@stmarys.edu.au OR from:@pandc.org.au) after:2026/06/02'
    );
  });

  for (const [label, domains] of [['an empty list', []], ['no domains key at all', undefined]]) {
    it(`AC 23: a job with ${label} but a usable schoolName is still searchable`, () => {
      const target = { schoolName: "St Mary's Primary", searchTerms: [] };
      if (domains !== undefined) target.domains = domains;
      assert.equal(hasJobQueryClauses(target), true);
      assert.equal(buildJobQuery({ job: target, since: SINCE }), '("St Mary\'s Primary") after:2026/06/02');
    });
  }

  it('AC 24: domains [], no terms and a schoolName that strips empty yields ZERO clauses', () => {
    const target = { domains: [], schoolName: '"""', searchTerms: [] };
    assert.deepEqual(buildJobClauses(target), []);
    assert.equal(hasJobQueryClauses(target), false);
    assert.throws(
      () => buildJobQuery({ job: target, since: SINCE }),
      (err) => err.code === 'no_job_query'
    );
  });

  it('AC 24: a bare `after:` mailbox-wide query is NEVER emitted', () => {
    for (const target of [{ domains: [] }, { domains: [''], schoolName: '  ', searchTerms: ['  '] }, {}]) {
      assert.throws(() => buildJobQuery({ job: target, since: SINCE }), (err) => err.code === 'no_job_query');
    }
  });
});

describe('TASK-059 unit: gmail.mjs docblocks (AC 25)', () => {
  const text = source('gmail.mjs');

  it('AC 25: no docblock still describes the singular job.domain', () => {
    assert.ok(!text.includes('job?.domain]'), 'buildJobClauses still documents the wrapped singular value');
    assert.ok(!text.includes('came from `job.domain`'), 'the stale "came from job.domain" wording survived');
  });

  it('AC 25: buildJobQuery no longer claims upstream validation makes all three fields required', () => {
    assert.ok(
      !text.includes('makes all three fields required'),
      'the now-false "all three fields required" claim survived'
    );
    assert.ok(text.includes('`domains` is OPTIONAL upstream'), 'the corrected optionality note is missing');
  });

  it('AC 25: the zero-clause guard is documented as REACHABLE, not merely defensive', () => {
    assert.ok(/NOT MERELY\s+\*?\s*DEFENSIVE/.test(text) || text.includes('NOT MERELY'), text.slice(0, 0));
    assert.ok(text.includes('REACHABLE case'));
  });
});

/* =========================================================================
 * scan.mjs - AC 26-33
 * ========================================================================= */

describe('TASK-059 unit: toProcessingJobs reads domains (AC 28, 32)', () => {
  it('AC 28: a plain array of strings is read, trimmed, with blanks dropped', () => {
    const jobs = toProcessingJobs({
      processingJobs: [
        {
          id: 'job-a',
          name: ' Newsletters ',
          schoolName: " St Mary's Primary ",
          domains: [' stmarys.edu.au ', '', '   ', 'pandc.org.au'],
          searchTerms: [' Year 4 '],
        },
      ],
    });
    assert.deepEqual(jobs, [
      {
        id: 'job-a',
        name: 'Newsletters',
        schoolName: "St Mary's Primary",
        domains: ['stmarys.edu.au', 'pandc.org.au'],
        searchTerms: ['Year 4'],
      },
    ]);
  });

  it('AC 28: the low-level { L: [{ S }] } shape reads into plain strings', () => {
    const jobs = toProcessingJobs({
      processingJobs: {
        L: [
          {
            M: {
              id: { S: 'job-a' },
              name: { S: 'A' },
              schoolName: { S: 'A School' },
              domains: { L: [{ S: 'stmarys.edu.au' }, { S: ' pandc.org.au ' }] },
              searchTerms: { L: [{ S: 'Term' }] },
            },
          },
        ],
      },
    });
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
    assert.deepEqual(jobs[0].searchTerms, ['Term']);
  });

  it('AC 28: no job ever carries the singular key', () => {
    const jobs = toProcessingJobs({
      processingJobs: [{ id: 'a', name: 'A', schoolName: 'S', domain: 'stmarys.edu.au' }],
    });
    assert.ok(!('domain' in jobs[0]));
  });

  it('AC 32: the module docblock and @returns describe domains: string[]', () => {
    const text = source('scan.mjs');
    assert.ok(text.includes('domains: string[]'));
    assert.ok(!/domain: string\b/.test(text), 'a "domain: string" JSDoc survived');
  });
});

describe('TASK-059 unit: the read-compat shim for a stored singular domain (AC 29)', () => {
  it('AC 29: a stored job with `domain` and no `domains` reads as the one-element list', () => {
    const jobs = toProcessingJobs({
      processingJobs: [
        { id: 'job-a', name: 'A', schoolName: 'A School', domain: 'stmarys.edu.au', searchTerms: [] },
      ],
    });
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
  });

  it('AC 29: the shim reads through the low-level { M: { domain: { S } } } shape too', () => {
    const jobs = toProcessingJobs({
      processingJobs: { L: [{ M: { id: { S: 'job-a' }, name: { S: 'A' }, domain: { S: ' stmarys.edu.au ' } } }] },
    });
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
  });

  it('AC 29: a blank stored singular domain is DROPPED rather than stored as [""]', () => {
    for (const stale of ['', '   ']) {
      const jobs = toProcessingJobs({ processingJobs: [{ id: 'a', name: 'A', domain: stale }] });
      assert.deepEqual(jobs[0].domains, []);
    }
  });

  it('AC 29: the shim is only consulted when `domains` is ABSENT - a deliberate empty list stays empty', () => {
    const jobs = toProcessingJobs({
      processingJobs: [{ id: 'a', name: 'A', domains: [], domain: 'stmarys.edu.au' }],
    });
    assert.deepEqual(jobs[0].domains, [], 'a deliberately empty domains list was overwritten by the stale singular key');
  });

  it('AC 29: a real `domains` list always wins over a stale singular key', () => {
    const jobs = toProcessingJobs({
      processingJobs: [{ id: 'a', name: 'A', domains: ['pandc.org.au'], domain: 'stmarys.edu.au' }],
    });
    assert.deepEqual(jobs[0].domains, ['pandc.org.au']);
  });

  it('AC 29: the recovered domain actually reaches the Gmail query', () => {
    const [job0] = toProcessingJobs({
      processingJobs: [{ id: 'a', name: 'A', schoolName: '', domain: 'stmarys.edu.au', searchTerms: [] }],
    });
    assert.equal(buildJobQuery({ job: job0, since: SINCE }), '(from:@stmarys.edu.au) after:2026/06/02');
  });
});

describe('TASK-059 unit: the legacy one-job-per-domain fallback (AC 30, 31)', () => {
  it('AC 30: a row with NO processingJobs synthesises one job per legacy searchDomains entry, with domains: [d]', () => {
    const jobs = toProcessingJobs({
      schoolNames: ["St Mary's Primary", 'Holy Cross'],
      searchDomains: ['stmarys.edu.au', 'holycross.edu.au'],
    });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, 'legacy#stmarys.edu.au');
    assert.deepEqual(jobs[0].domains, ['stmarys.edu.au']);
    assert.equal(jobs[1].id, 'legacy#holycross.edu.au');
    assert.deepEqual(jobs[1].domains, ['holycross.edu.au']);
    for (const entry of jobs) assert.ok(!('domain' in entry), 'the singular key survived the fallback');
  });

  it('AC 30: the one-job-per-domain shape is NOT redesigned into one shared job', () => {
    const jobs = toProcessingJobs({ searchDomains: new Set(['a.edu.au', 'b.edu.au', 'c.edu.au']) });
    assert.equal(jobs.length, 3);
  });

  it('AC 31: a comment records the divergence from connections.mjs without fixing it', () => {
    const text = source('scan.mjs');
    assert.ok(text.includes('synthesizeLegacyProcessingJob'), 'the divergence note is missing from scan.mjs');
  });
});

describe('TASK-059 unit: the extraction context passes domains straight through (AC 26, 27)', () => {
  it('AC 26: the [...] wrapping at the extraction-context call site is gone', () => {
    const text = source('scan.mjs');
    assert.ok(text.includes('searchDomains: job.domains'), 'the call site does not pass job.domains directly');
    assert.ok(!text.includes('searchDomains: [job.domain]'), 'the singular wrapping survived');
    assert.ok(text.includes('schoolNames: [job.schoolName]'), 'schoolNames wiring changed unexpectedly');
  });

  it('AC 27: buildUserContent lists EVERY domain of a multi-domain job in <school_context>', () => {
    const content = buildUserContent({
      message: { subject: 'Newsletter', from: 'office@pandc.org.au', receivedAt: '2026-06-01', body: 'hi' },
      schoolNames: ["St Mary's Primary"],
      searchDomains: ['stmarys.edu.au', 'pandc.org.au'],
    });
    assert.ok(content.includes('stmarys.edu.au'), content);
    assert.ok(content.includes('pandc.org.au'), content);
  });

  it('AC 27: isWatchedSender matches ANY of a multi-domain job\'s domains', () => {
    const domains = ['stmarys.edu.au', 'pandc.org.au'];
    assert.equal(isWatchedSender('office@pandc.org.au', domains), true);
    assert.equal(isWatchedSender('news@stmarys.edu.au', domains), true);
    assert.equal(isWatchedSender('spam@example.com', domains), false);
    assert.equal(isWatchedSender('office@pandc.org.au', []), false, 'empty means watch nothing');
  });

  it('AC 27: only the stale doc line changed in anthropic.mjs - no `searchDomains: [job.domain]` remains', () => {
    assert.ok(!source('anthropic.mjs').includes('searchDomains: [job.domain]'));
  });
});

/* =========================================================================
 * connections.mjs - AC 37-40
 * ========================================================================= */

describe('TASK-059 unit: synthesizeLegacyProcessingJob emits domains (AC 37, 40)', () => {
  it('AC 37: the FIRST (sorted) legacy domain becomes a ONE-ELEMENT domains list; the rest fold into searchTerms', () => {
    // legacyStringList SORTS the unordered DynamoDB string set before taking
    // the first entry (deliberate, pre-dates TASK-059), so "pandc.org.au"
    // sorts ahead of "stmarys.edu.au" and becomes domains[0].
    const json = toPublicJson({
      schoolNames: new Set(["St Mary's Primary"]),
      searchDomains: new Set(['stmarys.edu.au', 'pandc.org.au']),
    });
    assert.deepEqual(json.processingJobs, [
      {
        id: 'default',
        name: 'Default',
        schoolName: "St Mary's Primary",
        domains: ['pandc.org.au'],
        searchTerms: ['stmarys.edu.au'],
      },
    ]);
  });

  it('AC 37: no legacy domains at all synthesises domains: [], not a singular empty string', () => {
    const json = toPublicJson({ schoolNames: new Set(['Alpha School']) });
    assert.deepEqual(json.processingJobs[0].domains, []);
    assert.ok(!('domain' in json.processingJobs[0]));
  });

  it('AC 40: the synthesised job never carries a singular `domain` key', () => {
    const json = toPublicJson({ searchDomains: new Set(['alpha.edu.au']) });
    assert.ok(!('domain' in json.processingJobs[0]));
    assert.deepEqual(json.processingJobs[0].domains, ['alpha.edu.au']);
  });

  it('AC 37: the synthesis is stable across two reads of the same unordered set', () => {
    const first = toPublicJson({ searchDomains: new Set(['b.edu.au', 'a.edu.au']) });
    const second = toPublicJson({ searchDomains: new Set(['a.edu.au', 'b.edu.au']) });
    assert.deepEqual(first.processingJobs, second.processingJobs);
  });
});

describe('TASK-059 unit: toPublicJson read-compat shim (AC 38, 39, 40)', () => {
  it('AC 38: a STORED job with the singular `domain` projects as domains: [domain]', () => {
    const json = toPublicJson({
      processingJobs: [{ id: CLIENT_UUID, name: 'A', schoolName: 'A School', domain: 'stmarys.edu.au', searchTerms: [] }],
    });
    assert.deepEqual(json.processingJobs[0].domains, ['stmarys.edu.au']);
    assert.ok(!('domain' in json.processingJobs[0]));
  });

  it('AC 38: a blank stored singular domain is dropped rather than projected as [""]', () => {
    const json = toPublicJson({ processingJobs: [{ id: 'a', name: 'A', domain: '   ' }] });
    assert.deepEqual(json.processingJobs[0].domains, []);
  });

  it('AC 38: a stored `domains` list wins and is NOT sorted - it is the user\'s own order', () => {
    const json = toPublicJson({
      processingJobs: [{ id: 'a', name: 'A', domains: ['stmarys.edu.au', 'pandc.org.au'], domain: 'stale.edu.au' }],
    });
    assert.deepEqual(json.processingJobs[0].domains, ['stmarys.edu.au', 'pandc.org.au']);
  });

  it('AC 38: the shim tolerates the low-level { L: [{ S }] } and { M } shapes', () => {
    const fromList = toPublicJson({
      processingJobs: [{ id: 'a', name: 'A', domains: { L: [{ S: ' stmarys.edu.au ' }, { S: '' }] } }],
    });
    assert.deepEqual(fromList.processingJobs[0].domains, ['stmarys.edu.au']);

    const fromMap = toPublicJson({
      processingJobs: [{ M: { id: { S: 'a' }, name: { S: 'A' }, domain: { S: 'stmarys.edu.au' } } }],
    });
    assert.deepEqual(fromMap.processingJobs[0].M.domains, ['stmarys.edu.au']);
    assert.ok(!('domain' in fromMap.processingJobs[0].M));
  });

  it('AC 38: it is a READ, not a migration - the raw stored row is never mutated', () => {
    const row = { processingJobs: [{ id: 'a', name: 'A', domain: 'stmarys.edu.au' }] };
    toPublicJson(row);
    assert.deepEqual(row.processingJobs[0], { id: 'a', name: 'A', domain: 'stmarys.edu.au' });
  });

  it('AC 39: toSettingsJson (the /settings body) shows the recovered domain too', () => {
    const body = toSettingsJson({
      email: 'user@example.com',
      processingJobs: [{ id: CLIENT_UUID, name: 'A', schoolName: 'A School', domain: 'stmarys.edu.au', searchTerms: [] }],
      hasRefreshToken: true,
    });
    assert.deepEqual(body.processingJobs[0].domains, ['stmarys.edu.au']);
    assert.ok(!('domain' in body.processingJobs[0]));
  });

  it('AC 40: neither path ever emits a singular `domain`, on any row shape', () => {
    const rows = [
      { processingJobs: [{ id: 'a', name: 'A', domain: 'stmarys.edu.au' }] },
      { processingJobs: [{ id: 'a', name: 'A', domains: ['stmarys.edu.au'] }] },
      { schoolNames: new Set(['Alpha School']), searchDomains: new Set(['alpha.edu.au']) },
      { schoolName: 'Alpha School' },
    ];
    for (const row of rows) {
      const json = toPublicJson(row);
      for (const entry of json.processingJobs || []) {
        assert.ok(!('domain' in entry), `singular key emitted for ${JSON.stringify(row)}`);
      }
    }
  });

  it('AC 40: a non-job entry in the list is returned untouched rather than crashing the read', () => {
    const json = toPublicJson({ processingJobs: [null, 'not a job', 7] });
    assert.deepEqual(json.processingJobs, [null, 'not a job', 7]);
  });
});
