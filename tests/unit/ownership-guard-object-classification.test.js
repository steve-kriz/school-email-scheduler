/**
 * TASK-030 (unit): the object-classification primitives behind the inverted
 * ownership guard.
 *
 * The e2e file drives whole sentences through terraformCreatesSecretClaimsIn.
 * These tests take the three pieces that decide the answer — the term list,
 * the pattern built from it, and the object-phrase trimmer — and pin each on
 * its own, so a failure says which piece broke rather than only that some
 * sentence changed classification.
 *
 * Everything is loaded from the real guard source via
 * tests/helpers/ownership-guard-source.mjs. Nothing here is a copy of the
 * implementation.
 *
 * DATABASE: none involved. No DB client is imported, constructed or stubbed;
 * the only I/O is reading tests/e2e/check-oauth-config.test.js and
 * docs/google-oauth-setup.md.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  loadOwnershipGuard,
  guardPreludeSource,
  GUARD_SOURCE_FILE
} from '../helpers/ownership-guard-source.mjs';

const guard = await loadOwnershipGuard();
const {
  NON_SECRET_RESOURCE_TERMS,
  nonSecretResourcePattern,
  objectPhraseOf,
  terraformCreatesSecretClaimsIn,
  SECRET_ANAPHOR,
  OBJECT_WINDOW,
  runbookText
} = guard;

describe('Unit: the inverted ownership guard classifies objects (TASK-030)', () => {
  describe('NON_SECRET_RESOURCE_TERMS', () => {
    it('is frozen, so nothing can widen the exclusion list at runtime', () => {
      assert.ok(
        Object.isFrozen(NON_SECRET_RESOURCE_TERMS),
        'An unfrozen list can be pushed to from any test that has imported it, and ' +
          'a wider exclusion list means more claims excused.'
      );
      assert.throws(
        () => {
          NON_SECRET_RESOURCE_TERMS.push('credential');
        },
        TypeError,
        'Pushing onto the frozen list must throw in module (strict) code rather ' +
          'than silently no-op.'
      );
    });

    it('holds exactly the nine head nouns the ticket names, with no duplicates', () => {
      assert.deepEqual(
        NON_SECRET_RESOURCE_TERMS.slice().sort(),
        ['alias', 'bucket', 'key', 'log group', 'manifest', 'policy', 'role', 'schema', 'table'],
        'The ticket lists role, table, key, bucket, log group, alias, policy, ' +
          'manifest, schema as the non-secret resources this stack really creates. ' +
          'Anything else on the list is an object the guard has been told to excuse.'
      );
      assert.equal(
        new Set(NON_SECRET_RESOURCE_TERMS).size,
        NON_SECRET_RESOURCE_TERMS.length,
        'A duplicated entry survives its own removal in the pinning sweep and would ' +
          'make that entry look pinned when it is not.'
      );
    });

    it('excludes "resource", which names nothing in particular', () => {
      assert.ok(
        !NON_SECRET_RESOURCE_TERMS.includes('resource'),
        'AC 4 requires "Terraform creates the resource for this stack." to be ' +
          'reported. Listing "resource" would excuse it.'
      );
    });

    it('contains no blank or whitespace-only entry', () => {
      for (const term of NON_SECRET_RESOURCE_TERMS) {
        assert.equal(typeof term, 'string', `${JSON.stringify(term)} is not a string`);
        assert.ok(
          term.trim().length > 0,
          'A blank entry compiles to an alternative that matches everywhere, which ' +
            'excuses every object and turns the guard into a function that always ' +
            'returns [].'
        );
      }
    });
  });

  describe('nonSecretResourcePattern', () => {
    const pattern = () => nonSecretResourcePattern(NON_SECRET_RESOURCE_TERMS);

    NON_SECRET_RESOURCE_TERMS.forEach((term) => {
      it(`matches the head noun "${term}" and its simple plural`, () => {
        assert.ok(pattern().test(` the ${term}`), `"${term}" must match its own pattern`);
        assert.ok(
          pattern().test(` the ${term}s`),
          `The simple plural of "${term}" must match; documentation says "roles", ` +
            '"tables" and "buckets" as readily as the singular.'
        );
      });
    });

    it('tolerates the -es plural and the collapsed whitespace proseOf() produces', () => {
      assert.ok(pattern().test(' the aliases'), '"aliases" is a simple plural of "alias"');
      assert.ok(pattern().test(' the log  groups'), 'proseOf collapses whitespace; a two-word term must survive it');
    });

    it('does not match a paraphrase of the secret', () => {
      for (const paraphrase of ['credential', 'config entry', 'entry', 'item', 'resource', 'value']) {
        assert.ok(
          !pattern().test(` the ${paraphrase}`),
          `"${paraphrase}" must not be classified as a non-secret resource, or the ` +
            'exact false claim TASK-030 was raised for is excused again.'
        );
      }
    });

    it('does not match an irregular plural, so it falls through to the fail-closed default', () => {
      assert.ok(
        !pattern().test(' the policies'),
        '"policies" is deliberately unmatched. Unmatched means reported, which is ' +
          'the safe direction. This pin exists so a future "fix" that matches ' +
          'irregular plurals has to be a deliberate, visible decision rather than a ' +
          'silent widening of what gets excused.'
      );
    });

    it('anchors on word boundaries, so a term inside a longer word does not match', () => {
      assert.ok(!pattern().test(' the keyring'), '"keyring" is not "key"');
      assert.ok(!pattern().test(' the tablet'), '"tablet" is not "table"');
      assert.ok(!pattern().test(' the payroll'), '"payroll" is not "role"');
    });

    it('built from a single blank term, matches everything — which is why a blank entry must never reach it', () => {
      // Not a wish: this is the actual behaviour of the pattern builder, pinned
      // so the hazard is visible. `''` becomes the alternative `e?s?`, which
      // matches the empty string at any word boundary.
      assert.ok(
        nonSecretResourcePattern(['']).test('the thingamajig'),
        'If this ever stops being true the argument-validation test below can be ' +
          'relaxed; while it is true, a blank entry is a total kill switch for the ' +
          'guard and must be rejected before it is compiled.'
      );
    });
  });

  describe('objectPhraseOf', () => {
    it('stops the object at the first preposition, so an adjunct cannot supply the object', () => {
      assert.equal(objectPhraseOf(' the credential for the events table').trim(), 'the credential');
      assert.equal(objectPhraseOf(' the entry in the KMS key').trim(), 'the entry');
      assert.equal(objectPhraseOf(' the item with the deployment bucket').trim(), 'the item');
    });

    it('stops the object at the first conjunction', () => {
      assert.equal(objectPhraseOf(' the credential and the role').trim(), 'the credential');
      assert.equal(objectPhraseOf(' the credential or the policy').trim(), 'the credential');
    });

    it('returns the whole object when there is no adjunct to trim', () => {
      assert.equal(objectPhraseOf(' the thingamajig').trim(), 'the thingamajig');
      assert.equal(objectPhraseOf(' the DynamoDB table').trim(), 'the DynamoDB table');
    });

    it('never looks further than OBJECT_WINDOW characters', () => {
      const far = ` the credential ${'x'.repeat(OBJECT_WINDOW)} table`;
      assert.ok(
        !objectPhraseOf(far).includes('table'),
        'A resource named beyond the object window must not reach the object test; ' +
          'the window is what keeps "the object" meaning the object.'
      );
    });

    it('keeps a real multi-word resource object intact', () => {
      assert.ok(
        nonSecretResourcePattern(NON_SECRET_RESOURCE_TERMS).test(
          objectPhraseOf(' the CloudWatch log group')
        ),
        'Trimming at prepositions must not chop a legitimate multi-word object; ' +
          'otherwise accurate documentation starts being reported.'
      );
    });
  });

  describe('terraformCreatesSecretClaimsIn argument validation', () => {
    const claimText = () =>
      `${runbookText()}${'\r\n\r\n'}Terraform creates the credential for this stack.${'\r\n'}`;

    it('throws on an empty term list rather than compiling a pattern that excuses everything', () => {
      assert.throws(
        () => terraformCreatesSecretClaimsIn(claimText(), { nonSecretTerms: [] }),
        /non-empty array/,
        'An empty list is the no-op-guard defect class: the guard would return [] ' +
          'for every document and look exactly like a clean runbook.'
      );
    });

    it('throws on a non-array term list', () => {
      for (const bad of [null, 'role', 42, { role: true }, new Set(['role'])]) {
        assert.throws(
          () => terraformCreatesSecretClaimsIn(claimText(), { nonSecretTerms: bad }),
          /non-empty array/,
          `${JSON.stringify(String(bad))} must be rejected loudly.`
        );
      }
    });

    it('rejects a term list containing a blank entry, which disables the guard as completely as an empty list', () => {
      // The array is non-empty, so the length check above passes, but `''`
      // compiles to an alternative that matches at every word boundary: every
      // object is classified as "some other named resource" and no claim is
      // ever reported. The list-length check catches the obvious shape of this
      // mistake and misses the shape one level down.
      for (const bad of [[''], ['   '], ['', 'role'], ['role', '']]) {
        assert.throws(
          () => terraformCreatesSecretClaimsIn(claimText(), { nonSecretTerms: bad }),
          /non-empty array|blank|empty/i,
          `nonSecretTerms ${JSON.stringify(bad)} was accepted. It compiles to a ` +
            'pattern matching everywhere, so the guard silently reports nothing — ' +
            'the very failure the empty-list check was added to prevent, one level ' +
            'down. Demonstrated: with this list the blatant claim ' +
            '"Terraform creates the credential for this stack." is NOT reported.'
        );
      }
    });

    it('uses the shipped list when no override is given', () => {
      assert.deepEqual(
        terraformCreatesSecretClaimsIn(runbookText()),
        [],
        'The default path must behave exactly like passing NON_SECRET_RESOURCE_TERMS.'
      );
      assert.deepEqual(
        terraformCreatesSecretClaimsIn(runbookText(), {
          nonSecretTerms: NON_SECRET_RESOURCE_TERMS
        }),
        [],
        'Passing the shipped list explicitly must not change the result.'
      );
    });
  });

  describe('SECRET_ANAPHOR is unchanged by the inversion', () => {
    // Step 1 of the object test is unchanged and still carries the anaphors
    // across a clause boundary. If the inversion had been implemented by
    // gutting step 1, the carried-claim tests would still pass for the wrong
    // reason — via the fail-closed default rather than via classification.
    ['the value', 'its values', 'this content', 'that contents', 'the payload', 'the version'].forEach(
      (anaphor) => {
        it(`still recognises "${anaphor}" as the secret`, () => {
          assert.ok(
            SECRET_ANAPHOR.test(` ${anaphor} for you`),
            `"${anaphor}" is an anaphor for the secret; dropping it would move this ` +
              'sentence from "provably the secret" to "undeterminable", which still ' +
              'reports but for the wrong reason.'
          );
        });
      }
    );

    it('does not treat an unrelated noun as an anaphor', () => {
      assert.ok(
        !SECRET_ANAPHOR.test(' the DynamoDB table for you'),
        'If everything were an anaphor, step 2 could never be reached and accurate ' +
          'documentation would be reported.'
      );
    });
  });

  describe('the loader itself is not vacuous', () => {
    // If the extraction silently produced an empty or stale module, every
    // assertion in both files would pass or fail for reasons having nothing to
    // do with the guard. These pin the harness.
    it('extracts the guard from the real e2e file, not from a copy', () => {
      const prelude = guardPreludeSource();
      assert.ok(
        GUARD_SOURCE_FILE.split(/[\\/]/).slice(-3).join('/') ===
          'tests/e2e/check-oauth-config.test.js',
        `The guard must be read from tests/e2e/check-oauth-config.test.js, got ${GUARD_SOURCE_FILE}`
      );
      assert.ok(
        prelude.includes('function terraformCreatesSecretClaimsIn'),
        'The extracted prelude must contain the guard itself.'
      );
      assert.ok(
        prelude.includes('const NON_SECRET_RESOURCE_TERMS'),
        'The extracted prelude must contain the exclusion list.'
      );
    });

    it('refuses a transform that changes nothing, so a failed mutation cannot read as green', () => {
      return assert.rejects(
        () => loadOwnershipGuard({ transform: (source) => source }),
        /changed nothing/,
        'A no-op transform is TASK-099 in miniature: the mutated build would be ' +
          'identical to the real one and every assertion about it would pass ' +
          'vacuously.'
      );
    });

    it('reflects an actual source mutation, proving the mutation sweeps mutate something', async () => {
      const mutated = await loadOwnershipGuard({
        transform: (source) =>
          // Line-ending agnostic on purpose (TASK-099): matched by token, not
          // by a hardcoded newline.
          source.replace(/'role',/, "'roleXYZ',")
      });
      assert.ok(
        !mutated.NON_SECRET_RESOURCE_TERMS.includes('role'),
        'The transform did not reach the loaded module, so every mutation-based ' +
          'assertion in this ticket would be meaningless.'
      );
      assert.ok(
        mutated.NON_SECRET_RESOURCE_TERMS.includes('roleXYZ'),
        'The mutated list must be the one the loaded guard actually uses.'
      );
    });
  });
});
