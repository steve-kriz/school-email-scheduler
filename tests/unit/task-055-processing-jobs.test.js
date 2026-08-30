/**
 * TASK-055 UNIT - the processing-jobs settings model, function by function.
 *
 * Scope: `validateProcessingJobs` (per-job and collection rules, indexed error
 * field names, id preservation), the new caps, `requireValidSettings` /
 * `validateSettingsPayload`, `buildConnectionPatch` and its compiled
 * UpdateExpression, `SETTINGS_FIELDS` / `PUBLIC_ATTRIBUTES`, and the
 * migrate-on-read synthesis in `toPublicJson` / `toSettingsJson`.
 *
 * NO DATABASE. Nothing here constructs an AWS client. The projection and patch
 * helpers are pure, `buildUpdateParams` is called directly to assert the
 * COMPILED expression rather than round-tripping through a fake, and the id
 * generator is injected (`newId`) so every branch is reachable with no
 * randomness, no credentials and no network.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConnectionPatch,
  countCodePoints,
  MAX_DOMAIN_LABEL_LENGTH,
  MAX_DOMAIN_LENGTH,
  MAX_PROCESSING_JOBS,
  MAX_PROCESSING_JOB_NAME_LENGTH,
  MAX_SCHOOL_NAME_LENGTH,
  MAX_SEARCH_TERMS_PER_JOB,
  MAX_SEARCH_TERM_LENGTH,
  requireValidSettings,
  SETTINGS_FIELDS,
  SettingsValidationError,
  toSettingsJson,
  validateProcessingJobs,
  validateSettingsPayload,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/settings.mjs';

import {
  buildUpdateParams,
  PUBLIC_ATTRIBUTES,
  toPublicJson,
} from '../../src/lambda/calendar/backend/connections.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTINGS_SRC = path.join(REPO_ROOT, 'src/lambda/calendar/backend/settings.mjs');
const INDEX_SRC = path.join(REPO_ROOT, 'src/lambda/calendar/index.mjs');
const TERRAFORM_SRC = path.join(REPO_ROOT, 'terraform/dynamodb_calendar_connections.tf');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_UUID = '6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d';

/** A stubbed id generator: deterministic, and countable. */
function stubIds(prefix = 'generated') {
  let n = 0;
  const calls = [];
  const newId = () => {
    n += 1;
    const id = `${prefix}-${n}`;
    calls.push(id);
    return id;
  };
  return { newId, calls };
}

/** One valid job payload, overridable field by field. */
function job(overrides = {}) {
  return {
    name: "St Mary's",
    schoolName: "St Mary's Primary",
    domain: 'stmarys.edu.au',
    searchTerms: [],
    ...overrides,
  };
}

/** Validate and return the thrown SettingsValidationError, or fail. */
function refusal(raw, options = {}) {
  try {
    validateProcessingJobs(raw, { newId: stubIds().newId, ...options });
  } catch (err) {
    assert.ok(err instanceof SettingsValidationError, `expected SettingsValidationError, got ${err?.name}`);
    assert.equal(err.statusCode, 400);
    return err;
  }
  assert.fail('Should have thrown');
}

/* =========================================================================
 * Constants and shape
 * ========================================================================= */

describe('TASK-055 unit: constants and shape', () => {
  it('exports the new caps with the values the ticket fixed', () => {
    assert.equal(MAX_PROCESSING_JOBS, 20);
    assert.equal(MAX_PROCESSING_JOB_NAME_LENGTH, 120);
    assert.equal(MAX_SEARCH_TERMS_PER_JOB, 20);
    assert.equal(MAX_SEARCH_TERM_LENGTH, 80);
  });

  it('leaves MAX_SCHOOL_NAME_LENGTH and the DNS bounds unchanged', () => {
    assert.equal(MAX_SCHOOL_NAME_LENGTH, 120);
    assert.equal(MAX_DOMAIN_LENGTH, 253);
    assert.equal(MAX_DOMAIN_LABEL_LENGTH, 63);
  });

  it('lists processingJobs in SETTINGS_FIELDS and no longer lists the legacy keys', () => {
    assert.ok(SETTINGS_FIELDS.includes('processingJobs'));
    assert.ok(!SETTINGS_FIELDS.includes('schoolNames'));
    assert.ok(!SETTINGS_FIELDS.includes('searchDomains'));
    assert.ok(!SETTINGS_FIELDS.includes('schoolName'));
  });

  it('publishes processingJobs in PUBLIC_ATTRIBUTES and none of the legacy names', () => {
    assert.ok(PUBLIC_ATTRIBUTES.includes('processingJobs'));
    assert.ok(!PUBLIC_ATTRIBUTES.includes('schoolNames'));
    assert.ok(!PUBLIC_ATTRIBUTES.includes('searchDomains'));
    assert.ok(!PUBLIC_ATTRIBUTES.includes('schoolName'));
  });

  it('returns exactly the five documented keys, dropping any unknown key', () => {
    const [validated] = validateProcessingJobs(
      [job({ isAdmin: true, userId: 'nope', searchTerms: ['canteen'] })],
      { newId: stubIds().newId }
    );
    assert.deepEqual(Object.keys(validated).sort(), [
      'domain',
      'id',
      'name',
      'schoolName',
      'searchTerms',
    ]);
    assert.ok(!('isAdmin' in validated));
    assert.ok(!('userId' in validated));
  });

  it('no longer routes the settings request through validateSchoolNames/validateSearchDomains', () => {
    const source = fs.readFileSync(SETTINGS_SRC, 'utf8');
    const start = source.indexOf('export function requireValidSettings');
    assert.ok(start > 0, 'requireValidSettings is gone');
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.ok(!body.includes('validateSchoolNames('), 'requireValidSettings still calls validateSchoolNames');
    assert.ok(!body.includes('validateSearchDomains('), 'requireValidSettings still calls validateSearchDomains');
    assert.ok(body.includes('validateProcessingJobs('), 'requireValidSettings does not call validateProcessingJobs');
  });

  it("documents the indexed field form where SettingsValidationError's contract lives", () => {
    const source = fs.readFileSync(SETTINGS_SRC, 'utf8');
    const docStart = source.lastIndexOf('/**', source.indexOf('export class SettingsValidationError'));
    const docblock = source.slice(docStart, source.indexOf('export class SettingsValidationError'));
    assert.ok(
      docblock.includes('processingJobs[<index>].<key>'),
      "SettingsValidationError's docblock does not record the indexed field form"
    );
  });

  it("updates handlePutSettings' docblock to describe processing jobs", () => {
    const source = fs.readFileSync(INDEX_SRC, 'utf8');
    const docStart = source.lastIndexOf('/**', source.indexOf('export async function handlePutSettings'));
    const docblock = source.slice(docStart, source.indexOf('export async function handlePutSettings'));
    assert.ok(docblock.includes('processing job'), 'the PUT docblock still describes the old fields');
    assert.ok(!docblock.includes('save the school name and search domains'));
  });

  it('records processingJobs (L of M) and the legacy attributes in the terraform schema comment', () => {
    const tf = fs.readFileSync(TERRAFORM_SRC, 'utf8');
    assert.ok(tf.includes('processingJobs (L of M)'), 'the schema comment does not document the new attribute');
    for (const legacy of ['schoolNames (SS)', 'searchDomains (SS)', 'schoolName (S)']) {
      assert.ok(tf.includes(legacy), `the schema comment does not record ${legacy} as legacy`);
    }
    assert.ok(/LEGACY/.test(tf), 'the legacy attributes are not marked as such');
  });
});

/* =========================================================================
 * Per-job validation
 * ========================================================================= */

describe('TASK-055 unit: validateProcessingJobs - name', () => {
  it('trims, preserves case and characters exactly, and stores no lower-cased copy', () => {
    const [validated] = validateProcessingJobs(
      [job({ name: '  P&C Association - École, Annexe  ' })],
      { newId: stubIds().newId }
    );
    assert.equal(validated.name, 'P&C Association - École, Annexe');
  });

  for (const [label, value] of [
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['an array', ['A']],
    ['an object', { name: 'x' }],
  ]) {
    it(`rejects a ${label} name with field processingJobs[0].name`, () => {
      const err = refusal([job({ name: value })]);
      assert.equal(err.field, 'processingJobs[0].name');
    });
  }

  it('accepts exactly 120 code points and refuses 121, counted by CODE POINT', () => {
    const exactly = '👍'.repeat(MAX_PROCESSING_JOB_NAME_LENGTH);
    assert.ok(exactly.length > MAX_PROCESSING_JOB_NAME_LENGTH, 'fixture is not multi-unit');
    assert.equal(countCodePoints(exactly), MAX_PROCESSING_JOB_NAME_LENGTH);
    assert.equal(validateProcessingJobs([job({ name: exactly })], { newId: stubIds().newId })[0].name, exactly);

    const over = '👍'.repeat(MAX_PROCESSING_JOB_NAME_LENGTH + 1);
    const err = refusal([job({ name: over })]);
    assert.equal(err.field, 'processingJobs[0].name');
    assert.ok(err.message.includes('120'), err.message);
  });
});

describe('TASK-055 unit: validateProcessingJobs - schoolName', () => {
  it('is a single string, trimmed and preserved exactly', () => {
    const [validated] = validateProcessingJobs(
      [job({ schoolName: "  St Mary's Primary, Manly  " })],
      { newId: stubIds().newId }
    );
    assert.equal(validated.schoolName, "St Mary's Primary, Manly");
  });

  for (const [label, value] of [
    ['absent', undefined],
    ['whitespace only', '  '],
    ['an ARRAY (never silently first-elemented)', ['A', 'B']],
    ['a number', 7],
  ]) {
    it(`rejects a ${label} schoolName with field processingJobs[0].schoolName`, () => {
      const err = refusal([job({ schoolName: value })]);
      assert.equal(err.field, 'processingJobs[0].schoolName');
    });
  }

  it('bounds schoolName by MAX_SCHOOL_NAME_LENGTH, in code points', () => {
    const err = refusal([job({ schoolName: '👍'.repeat(MAX_SCHOOL_NAME_LENGTH + 1) })]);
    assert.equal(err.field, 'processingJobs[0].schoolName');
    assert.ok(err.message.includes('120'), err.message);
  });
});

describe('TASK-055 unit: validateProcessingJobs - domain', () => {
  it('runs the EXISTING normalizeDomain then isValidDomain, storing the lower-cased host', () => {
    for (const form of [
      'https://StMarys.EDU.au/news',
      '@StMarys.edu.au',
      'office@stmarys.edu.au',
      '*.stmarys.edu.au',
      'stmarys.edu.au:443',
      '  STMARYS.EDU.AU  ',
    ]) {
      const [validated] = validateProcessingJobs([job({ domain: form })], { newId: stubIds().newId });
      assert.equal(validated.domain, 'stmarys.edu.au', `form ${form}`);
    }
  });

  for (const [label, value] of [
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['a single label', 'stmarys'],
    ['a malformed label', '-bad-.edu.au'],
    ['an ARRAY', ['a.edu.au']],
    ['a number', 123],
  ]) {
    it(`rejects a ${label} domain with field processingJobs[0].domain`, () => {
      const err = refusal([job({ domain: value })]);
      assert.equal(err.field, 'processingJobs[0].domain');
    });
  }

  it('applies the EXISTING public-provider check per job, with the same message', () => {
    const err = refusal([job({ domain: 'gmail.com' })]);
    assert.equal(err.field, 'processingJobs[0].domain');
    assert.ok(err.message.includes('gmail.com'), err.message);
    assert.ok(err.message.includes('is a public email provider'), err.message);
  });
});

describe('TASK-055 unit: validateProcessingJobs - searchTerms', () => {
  it('normalises absent, null and undefined all to []', () => {
    const { name, schoolName, domain } = job();
    for (const value of [undefined, null]) {
      const [validated] = validateProcessingJobs(
        [{ name, schoolName, domain, searchTerms: value }],
        { newId: stubIds().newId }
      );
      assert.deepEqual(validated.searchTerms, []);
    }
    const [omitted] = validateProcessingJobs([{ name, schoolName, domain }], { newId: stubIds().newId });
    assert.deepEqual(omitted.searchTerms, []);
  });

  it('REFUSES a bare string rather than wrapping or comma-splitting it', () => {
    const err = refusal([job({ searchTerms: 'canteen, uniform' })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
    assert.ok(err.message.includes('list'), err.message);
  });

  it('trims each term and refuses a blank one', () => {
    const [validated] = validateProcessingJobs(
      [job({ searchTerms: ['  canteen roster  ', 'swimming carnival'] })],
      { newId: stubIds().newId }
    );
    assert.deepEqual(validated.searchTerms, ['canteen roster', 'swimming carnival']);

    const err = refusal([job({ searchTerms: ['canteen', '   '] })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
  });

  it('refuses a non-string term', () => {
    const err = refusal([job({ searchTerms: ['canteen', 42] })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
  });

  it('de-duplicates EXACTLY (case-sensitive, order preserved) rather than erroring', () => {
    const [validated] = validateProcessingJobs(
      [job({ searchTerms: ['canteen', ' canteen ', 'CANTEEN', 'uniform', 'canteen'] })],
      { newId: stubIds().newId }
    );
    assert.deepEqual(validated.searchTerms, ['canteen', 'CANTEEN', 'uniform']);
  });

  it('counts the cap on what was SUBMITTED, BEFORE de-duplication', () => {
    const unique = Array.from({ length: MAX_SEARCH_TERMS_PER_JOB }, (_, i) => `term ${i}`);
    assert.equal(
      validateProcessingJobs([job({ searchTerms: unique })], { newId: stubIds().newId })[0].searchTerms.length,
      MAX_SEARCH_TERMS_PER_JOB
    );

    // 21 submitted entries of which 5 are duplicates would collapse to 16 - it
    // must still be reported as "too many".
    const withDuplicates = [...Array.from({ length: 16 }, (_, i) => `term ${i}`), 'term 0', 'term 1', 'term 2', 'term 3', 'term 4'];
    assert.equal(withDuplicates.length, MAX_SEARCH_TERMS_PER_JOB + 1);
    const err = refusal([job({ searchTerms: withDuplicates })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
    assert.ok(err.message.includes('20'), err.message);
  });

  it('accepts a term of exactly 80 code points and refuses 81, counted by CODE POINT', () => {
    const exactly = '🎒'.repeat(MAX_SEARCH_TERM_LENGTH);
    assert.equal(countCodePoints(exactly), MAX_SEARCH_TERM_LENGTH);
    assert.deepEqual(
      validateProcessingJobs([job({ searchTerms: [exactly] })], { newId: stubIds().newId })[0].searchTerms,
      [exactly]
    );

    const over = '🎒'.repeat(MAX_SEARCH_TERM_LENGTH + 1);
    const err = refusal([job({ searchTerms: [over] })]);
    assert.equal(err.field, 'processingJobs[0].searchTerms');
    assert.ok(err.message.includes('80'), err.message);
  });
});

describe('TASK-055 unit: validateProcessingJobs - ids', () => {
  it('PRESERVES a canonical UUID verbatim, in either casing', () => {
    const upper = CLIENT_UUID.toUpperCase();
    const ids = stubIds();
    const jobs = validateProcessingJobs(
      [job({ id: CLIENT_UUID }), job({ name: 'Second', id: upper.replace('6F', '7F') })],
      { newId: ids.newId }
    );
    assert.equal(jobs[0].id, CLIENT_UUID);
    assert.equal(jobs[1].id, upper.replace('6F', '7F'));
    assert.deepEqual(ids.calls, [], 'a preserved id must not consume a generated one');
  });

  for (const [label, value] of [
    ['absent', undefined],
    ['empty', ''],
    ['the synthesized literal "default"', 'default'],
    ['malformed', 'not-a-uuid'],
    ['a number', 12345],
    ['null', null],
    ['an object', {}],
  ]) {
    it(`REPLACES a ${label} id rather than rejecting it`, () => {
      const ids = stubIds();
      const [validated] = validateProcessingJobs([job({ id: value })], { newId: ids.newId });
      assert.equal(validated.id, 'generated-1');
      assert.deepEqual(ids.calls, ['generated-1']);
    });
  }

  it('defaults newId to randomUUID, so a route that injects nothing still mints a UUID', () => {
    const [validated] = validateProcessingJobs([job()]);
    assert.match(validated.id, UUID_RE);
  });

  it('REFUSES two jobs carrying the same valid UUID (field processingJobs)', () => {
    const err = refusal([job({ id: CLIENT_UUID }), job({ name: 'Second', id: CLIENT_UUID })]);
    assert.equal(err.field, 'processingJobs');
    assert.ok(err.message.includes('own id'), err.message);
  });

  it('compares duplicate ids case-insensitively - two casings are one id', () => {
    const err = refusal([job({ id: CLIENT_UUID }), job({ name: 'Second', id: CLIENT_UUID.toUpperCase() })]);
    assert.equal(err.field, 'processingJobs');
  });

  it('does NOT treat a constant stubbed generator as a duplicate', () => {
    const jobs = validateProcessingJobs(
      [job({ name: 'One' }), job({ name: 'Two' })],
      { newId: () => 'always-the-same' }
    );
    assert.deepEqual(jobs.map((entry) => entry.id), ['always-the-same', 'always-the-same']);
  });
});

/* =========================================================================
 * Collection validation
 * ========================================================================= */

describe('TASK-055 unit: validateProcessingJobs - the collection', () => {
  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a plain object', { 0: {} }],
    ['a string', "St Mary's"],
    ['a number', 3],
  ]) {
    it(`rejects ${label} with field processingJobs and a message naming the field`, () => {
      const err = refusal(value);
      assert.equal(err.field, 'processingJobs');
      assert.ok(err.message.includes('processingJobs'), err.message);
    });
  }

  it('rejects an EMPTY array in the house style', () => {
    const err = refusal([]);
    assert.equal(err.field, 'processingJobs');
    assert.equal(err.message, 'At least one processing job is required');
  });

  it('accepts exactly 20 jobs and refuses 21, counted BEFORE de-duplication', () => {
    const twenty = Array.from({ length: MAX_PROCESSING_JOBS }, (_, i) => job({ name: `Job ${i}` }));
    assert.equal(validateProcessingJobs(twenty, { newId: stubIds().newId }).length, MAX_PROCESSING_JOBS);

    // 21 jobs of which 3 share a name must be reported as "too many", not as a
    // duplicate-name clash: the collection count is checked first.
    const twentyOne = [
      ...Array.from({ length: 18 }, (_, i) => job({ name: `Job ${i}` })),
      job({ name: 'Job 0' }),
      job({ name: 'Job 1' }),
      job({ name: 'Job 2' }),
    ];
    assert.equal(twentyOne.length, MAX_PROCESSING_JOBS + 1);
    const err = refusal(twentyOne);
    assert.equal(err.field, 'processingJobs');
    assert.ok(err.message.includes('20'), err.message);
  });

  it('REJECTS two names that match case-insensitively after trimming, naming the duplicate', () => {
    const err = refusal([job({ name: "St Mary's" }), job({ name: "  ST MARY'S  " })]);
    assert.equal(err.field, 'processingJobs');
    assert.ok(err.message.includes("ST MARY'S"), err.message);
    assert.ok(err.message.includes("St Mary's"), err.message);
  });

  it('keeps the FIRST occurrence casing exactly as typed - the compare never rewrites it', () => {
    const jobs = validateProcessingJobs(
      [job({ name: "St Mary's" }), job({ name: 'SPORT' }), job({ name: 'newsletters' })],
      { newId: stubIds().newId }
    );
    assert.deepEqual(jobs.map((entry) => entry.name), ["St Mary's", 'SPORT', 'newsletters']);
  });

  it('ALLOWS two jobs sharing a domain, a schoolName, or both, with different names', () => {
    const jobs = validateProcessingJobs(
      [job({ name: 'Newsletters' }), job({ name: 'Sport' })],
      { newId: stubIds().newId }
    );
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((entry) => entry.domain), ['stmarys.edu.au', 'stmarys.edu.au']);
    assert.deepEqual(jobs.map((entry) => entry.schoolName), ["St Mary's Primary", "St Mary's Primary"]);
  });

  it('preserves input order', () => {
    const jobs = validateProcessingJobs(
      [job({ name: 'Zeta' }), job({ name: 'Alpha' })],
      { newId: stubIds().newId }
    );
    assert.deepEqual(jobs.map((entry) => entry.name), ['Zeta', 'Alpha']);
  });
});

/* =========================================================================
 * Error field naming
 * ========================================================================= */

describe('TASK-055 unit: error field naming', () => {
  it('uses the SUBMITTED zero-based index in the indexed field name', () => {
    const err = refusal([job({ name: 'One' }), job({ name: 'Two' }), job({ name: 'Three', domain: 'stmarys' })]);
    assert.equal(err.field, 'processingJobs[2].domain');
  });

  it('names the offending job when a later job omits a required field', () => {
    const { name, domain } = job();
    const err = refusal([job({ name: 'First' }), { name: 'Second', domain }]);
    assert.equal(err.field, 'processingJobs[1].schoolName');
    assert.ok(name);
  });

  it('echoes the rejected value length-capped at 64 characters plus an ellipsis', () => {
    const long = 'A'.repeat(500);
    const err = refusal([job({ name: long })]);
    assert.equal(err.field, 'processingJobs[0].name');
    const echoed = err.message.match(/^"([^"]*)"/);
    assert.ok(echoed, `message did not carry a quoted echo: ${err.message}`);
    assert.equal(echoed[1], `${'A'.repeat(64)}...`);
    assert.ok(err.message.length < 200, 'the whole payload leaked into the message');
  });

  it('never puts the whole payload in a message', () => {
    const secret = 'B'.repeat(300);
    const err = refusal([job({ name: 'Valid' }), job({ name: 'Valid', schoolName: secret })]);
    // The duplicate-name clash fires first here; either way the message must not
    // carry the 300-character value.
    assert.ok(!err.message.includes(secret));
  });
});

/* =========================================================================
 * Request contract
 * ========================================================================= */

describe('TASK-055 unit: requireValidSettings / validateSettingsPayload', () => {
  it('returns processingJobs plus the schedule fields, and nothing legacy', () => {
    const result = requireValidSettings(
      { processingJobs: [job()], scheduleEnabled: true, scheduleFrequency: 'daily', scheduleHour: 7, timezone: 'Australia/Sydney' },
      { newId: stubIds().newId }
    );
    assert.deepEqual(Object.keys(result).sort(), [
      'processingJobs',
      'scheduleEnabled',
      'scheduleFrequency',
      'scheduleHour',
      'timezone',
    ]);
    assert.ok(!('schoolNames' in result));
    assert.ok(!('searchDomains' in result));
    assert.ok(!('schoolName' in result));
  });

  it('reads payload.processingJobs ONLY - a legacy-only body is a 400 naming processingJobs', () => {
    for (const payload of [
      { schoolNames: ["St Mary's"], searchDomains: ['stmarys.edu.au'] },
      { schoolName: "St Mary's", searchDomains: ['stmarys.edu.au'] },
      { searchDomains: ['stmarys.edu.au'] },
      {},
    ]) {
      const verdict = validateSettingsPayload(payload);
      assert.equal(verdict.valid, false, JSON.stringify(payload));
      assert.equal(verdict.field, 'processingJobs');
    }
  });

  it('leaves an absent schedule key alone rather than defaulting it', () => {
    const result = requireValidSettings({ processingJobs: [job()] }, { newId: stubIds().newId });
    assert.equal(result.scheduleEnabled, undefined);
    assert.equal(result.scheduleFrequency, undefined);
    assert.equal(result.scheduleHour, undefined);
    assert.equal(result.timezone, undefined);
  });

  it('still rejects a non-object body with a null field', () => {
    for (const payload of ['not an object', [], null, 42]) {
      const verdict = validateSettingsPayload(payload);
      assert.equal(verdict.valid, false);
      assert.equal(verdict.field, null);
    }
  });

  it('validateSettingsPayload carries the INDEXED field name and rethrows anything else', () => {
    const verdict = validateSettingsPayload({ processingJobs: [job(), job({ name: 'Two', domain: 'gmail.com' })] });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.field, 'processingJobs[1].domain');

    assert.throws(
      () => validateSettingsPayload({ processingJobs: [job()] }, {
        newId: () => {
          throw new TypeError('boom');
        },
      }),
      TypeError
    );
  });

  it('still validates the schedule fields exactly as before', () => {
    const verdict = validateSettingsPayload({ processingJobs: [job()], scheduleHour: 24 });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.field, 'scheduleHour');
  });
});

/* =========================================================================
 * Storage and patch
 * ========================================================================= */

describe('TASK-055 unit: buildConnectionPatch and the compiled UpdateExpression', () => {
  const settings = () =>
    requireValidSettings(
      { processingJobs: [job({ searchTerms: ['canteen roster'] }), job({ name: 'Sport' })] },
      { newId: stubIds().newId }
    );

  it('writes a PLAIN ARRAY of PLAIN OBJECTS - never a Set, never a JSON string', () => {
    const patch = buildConnectionPatch(settings());
    assert.ok(Array.isArray(patch.processingJobs));
    assert.ok(!(patch.processingJobs instanceof Set));
    assert.notEqual(typeof patch.processingJobs, 'string');
    for (const entry of patch.processingJobs) {
      assert.equal(Object.getPrototypeOf(entry), Object.prototype);
      assert.deepEqual(Object.keys(entry).sort(), ['domain', 'id', 'name', 'schoolName', 'searchTerms']);
      assert.ok(Array.isArray(entry.searchTerms));
      assert.ok(!(entry.searchTerms instanceof Set));
    }
  });

  it('stores an EMPTY searchTerms AS an empty list, not a removal', () => {
    const patch = buildConnectionPatch(
      requireValidSettings({ processingJobs: [job()] }, { newId: stubIds().newId })
    );
    assert.deepEqual(patch.processingJobs[0].searchTerms, []);
    assert.notEqual(patch.processingJobs[0].searchTerms, REMOVE_ATTRIBUTE);
  });

  it('uses REMOVE_ATTRIBUTE for a whole-list-empty processingJobs', () => {
    const patch = buildConnectionPatch({ processingJobs: [] });
    assert.equal(patch.processingJobs, REMOVE_ATTRIBUTE);
  });

  it('ALWAYS clears schoolNames, searchDomains AND schoolName in the same patch', () => {
    for (const jobs of [settings().processingJobs, []]) {
      const patch = buildConnectionPatch({ processingJobs: jobs });
      assert.equal(patch.schoolNames, REMOVE_ATTRIBUTE);
      assert.equal(patch.searchDomains, REMOVE_ATTRIBUTE);
      assert.equal(patch.schoolName, REMOVE_ATTRIBUTE);
    }
  });

  it('touches nothing when processingJobs was not supplied', () => {
    const patch = buildConnectionPatch({ scheduleEnabled: true });
    assert.deepEqual(patch, { scheduleEnabled: true });
  });

  it('compiles to a MIXED SET + REMOVE with ExpressionAttributeValues present', () => {
    const params = buildUpdateParams({
      tableName: 'test-connections-table',
      key: { userId: 'google:sub' },
      updates: buildConnectionPatch(settings()),
    });

    const names = params.ExpressionAttributeNames;
    const keyFor = (attribute) => Object.keys(names).find((nameKey) => names[nameKey] === attribute);

    assert.match(params.UpdateExpression, /^SET /, 'no SET clause');
    assert.match(params.UpdateExpression, / REMOVE /, 'no REMOVE clause');
    const [setClause, removeClause] = params.UpdateExpression.split(' REMOVE ');
    assert.ok(setClause.includes(`${keyFor('processingJobs')} = `), 'processingJobs is not SET');
    for (const legacy of ['schoolNames', 'searchDomains', 'schoolName']) {
      assert.ok(removeClause.split(', ').includes(keyFor(legacy)), `${legacy} is not REMOVEd`);
    }

    assert.ok(params.ExpressionAttributeValues, 'ExpressionAttributeValues was omitted from a mixed patch');
    const stored = Object.values(params.ExpressionAttributeValues).find((v) => Array.isArray(v));
    assert.ok(Array.isArray(stored));
    assert.equal(stored.length, 2);
  });
});

/* =========================================================================
 * Projection and migrate-on-read
 * ========================================================================= */

describe('TASK-055 unit: migrate-on-read in toPublicJson', () => {
  const storedJobs = [
    { id: CLIENT_UUID, name: 'Real', schoolName: 'Real School', domain: 'real.edu.au', searchTerms: ['canteen'] },
  ];

  it('passes a stored list of objects through unchanged and UNSORTED', () => {
    const jobs = [
      { id: 'z', name: 'Zeta', schoolName: 'Z', domain: 'z.edu.au', searchTerms: [] },
      { id: 'a', name: 'Alpha', schoolName: 'A', domain: 'a.edu.au', searchTerms: [] },
    ];
    const json = toPublicJson({ processingJobs: jobs });
    assert.deepEqual(json.processingJobs, jobs, 'a List must not be sorted - its order is the user\'s');
  });

  it('synthesises exactly one "Default" job from schoolNames + searchDomains string sets', () => {
    const json = toPublicJson({
      schoolNames: new Set(["St Mary's Primary"]),
      searchDomains: new Set(['stmarys.edu.au']),
    });
    assert.deepEqual(json.processingJobs, [
      {
        id: 'default',
        name: 'Default',
        schoolName: "St Mary's Primary",
        domain: 'stmarys.edu.au',
        searchTerms: [],
      },
    ]);
    assert.ok(!('schoolNames' in json));
    assert.ok(!('searchDomains' in json));
    assert.ok(!('schoolName' in json));
  });

  it('folds every REMAINING legacy entry into searchTerms rather than dropping it', () => {
    const json = toPublicJson({
      schoolNames: new Set(['Alpha School', 'Beta School', 'Gamma School']),
      searchDomains: new Set(['alpha.edu.au', 'beta.edu.au']),
    });
    assert.equal(json.processingJobs[0].schoolName, 'Alpha School');
    assert.equal(json.processingJobs[0].domain, 'alpha.edu.au');
    assert.deepEqual(json.processingJobs[0].searchTerms, ['Beta School', 'Gamma School', 'beta.edu.au']);
  });

  it('SORTS both legacy lists first, so the synthesis is identical on every read', () => {
    // A DynamoDB string set is unordered; these two rows are the SAME row read
    // twice with a different iteration order.
    const first = toPublicJson({
      schoolNames: new Set(['Gamma School', 'Alpha School', 'Beta School']),
      searchDomains: new Set(['beta.edu.au', 'alpha.edu.au']),
    });
    const second = toPublicJson({
      schoolNames: new Set(['Beta School', 'Gamma School', 'Alpha School']),
      searchDomains: new Set(['alpha.edu.au', 'beta.edu.au']),
    });
    assert.deepEqual(first.processingJobs, second.processingJobs);
    assert.equal(first.processingJobs[0].schoolName, 'Alpha School');
    assert.equal(first.processingJobs[0].domain, 'alpha.edu.au');
  });

  it('normalises a Set, a low-level { SS: [...] } and a plain array alike, dropping blanks', () => {
    const fromSet = toPublicJson({ schoolNames: new Set(['Alpha School', '   ']), searchDomains: new Set(['alpha.edu.au']) });
    const fromSS = toPublicJson({ schoolNames: { SS: ['Alpha School', ''] }, searchDomains: { SS: ['alpha.edu.au'] } });
    const fromArray = toPublicJson({ schoolNames: ['Alpha School', '  '], searchDomains: ['alpha.edu.au'] });
    assert.deepEqual(fromSet.processingJobs, fromSS.processingJobs);
    assert.deepEqual(fromSet.processingJobs, fromArray.processingJobs);
    assert.deepEqual(fromSet.processingJobs[0].searchTerms, []);
  });

  it('reads a pre-TASK-053 scalar schoolName as a one-element names list', () => {
    const json = toPublicJson({
      schoolName: '  Alpha School  ',
      searchDomains: new Set(['alpha.edu.au']),
    });
    assert.equal(json.processingJobs[0].schoolName, 'Alpha School');
    assert.equal(json.processingJobs[0].domain, 'alpha.edu.au');
    assert.ok(!('schoolName' in json));
  });

  it('synthesises an empty domain when only school names exist, and vice versa', () => {
    const namesOnly = toPublicJson({ schoolNames: new Set(['Alpha School']) });
    assert.equal(namesOnly.processingJobs[0].schoolName, 'Alpha School');
    assert.equal(namesOnly.processingJobs[0].domain, '');

    const domainsOnly = toPublicJson({ searchDomains: new Set(['alpha.edu.au']) });
    assert.equal(domainsOnly.processingJobs[0].schoolName, '');
    assert.equal(domainsOnly.processingJobs[0].domain, 'alpha.edu.au');
  });

  it('NEVER triggers when a non-empty processingJobs exists - the stored jobs always win', () => {
    const json = toPublicJson({
      processingJobs: storedJobs,
      schoolNames: new Set(['Legacy School']),
      searchDomains: new Set(['legacy.edu.au']),
      schoolName: 'Older School',
    });
    assert.deepEqual(json.processingJobs, storedJobs);
    assert.ok(!json.processingJobs.some((entry) => entry.name === 'Default'));
  });

  it('DOES trigger when the stored processingJobs is an empty list', () => {
    const json = toPublicJson({ processingJobs: [], schoolNames: new Set(['Legacy School']) });
    assert.equal(json.processingJobs.length, 1);
    assert.equal(json.processingJobs[0].name, 'Default');
  });

  it('projects null from toPublicJson and [] from toSettingsJson for a row with nothing', () => {
    const bare = { email: 'p@example.test' };
    assert.equal(toPublicJson(bare).processingJobs, null);
    assert.equal(toPublicJson(null).processingJobs, null);
    assert.deepEqual(toSettingsJson(bare).processingJobs, []);
    assert.deepEqual(toSettingsJson(null, { email: 'p@example.test' }).processingJobs, []);
  });

  it('coerces a non-array stored processingJobs to [] in toSettingsJson', () => {
    for (const stored of ['not a list', 42, { L: [] }]) {
      assert.deepEqual(toSettingsJson({ processingJobs: stored }).processingJobs, []);
    }
  });

  it('is READ-ONLY: synthesising touches nothing and issues no write', () => {
    const row = { schoolNames: new Set(['Alpha School']), searchDomains: new Set(['alpha.edu.au']) };
    const before = { names: [...row.schoolNames], domains: [...row.searchDomains] };
    toPublicJson(row);
    toPublicJson(row);
    assert.deepEqual([...row.schoolNames], before.names, 'the raw stored row was mutated by a read');
    assert.deepEqual([...row.searchDomains], before.domains, 'the raw stored row was mutated by a read');
    assert.ok(!('processingJobs' in row), 'the read wrote the synthesised job back onto the row');
  });

  it('the synthesised job is NOT valid PUT input when a legacy source was missing', () => {
    // Deliberate: the user must fill the gap before their first real save, and
    // the validator is not relaxed to let a half-migrated job through.
    const synthesized = toPublicJson({ schoolNames: new Set(['Alpha School']) }).processingJobs;
    const err = refusal(synthesized);
    assert.equal(err.field, 'processingJobs[0].domain');
  });
});
