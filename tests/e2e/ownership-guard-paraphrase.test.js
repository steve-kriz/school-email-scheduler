/**
 * TASK-030 (e2e, cucumber-style): a false ownership claim must be caught
 * however the secret is named.
 *
 * These are the ticket's Gherkin scenarios executed as node --test cases in
 * Given/When/Then form. Every assertion runs the REAL guard, lifted out of
 * tests/e2e/check-oauth-config.test.js by tests/helpers/ownership-guard-source.mjs,
 * against the REAL runbook with one fixture sentence appended in memory.
 *
 * Independence note: the guard is not exported from anywhere, and the repo's
 * existing habit for that shape is to paste a copy of the function into the
 * consuming test (tests/unit/mutation-sweep.test.js). A copy proves nothing
 * about the shipped guard, so nothing here copies it.
 *
 * DATABASE: this ticket's subject is a text guard over docs/ and terraform/.
 * Nothing here opens, imports or stubs a database client, and no fixture
 * reaches a network or a DB driver; the only I/O is reading files.
 *
 * CRLF (TASK-099): no assertion below matches a bare "\n" against file content.
 * Fixtures are appended with an explicit separator and every mutation is proved
 * to have applied before its result is trusted.
 *
 * NO WRITES (AC 11): every fixture is an in-memory string. The final scenario
 * hashes docs/google-oauth-setup.md before and after the whole file has run.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadOwnershipGuard, guardPreludeSource } from '../helpers/ownership-guard-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RUNBOOK_PATH = path.join(PROJECT_ROOT, 'docs', 'google-oauth-setup.md');

/** The declaration of CREATE_VERB in the guard source, so the branch sweep can
 *  rebuild the alternation in memory with one branch missing. */
const CREATE_VERB_DECL = /const CREATE_VERB = \/\\b\(([^)]*)\)\\b\/gi;/;

const guard = await loadOwnershipGuard();
const {
  terraformCreatesSecretClaimsIn,
  NON_SECRET_RESOURCE_TERMS,
  runbookText
} = guard;

/** GIVEN a runbook copy containing <sentence>. Never touches disk. */
function runbookCopyContaining(sentence) {
  return `${runbookText()}${'\r\n\r\n'}${sentence}${'\r\n'}`;
}

/** WHEN the guard runs on that copy. */
function claimsFor(sentence, options) {
  return terraformCreatesSecretClaimsIn(runbookCopyContaining(sentence), options);
}

/** The baseline must be claim-free or every fixture below means nothing. */
function assertBaselineIsClean(options) {
  assert.deepEqual(
    terraformCreatesSecretClaimsIn(runbookText(), options),
    [],
    'The real runbook must report no claims for these fixtures to mean anything; ' +
      'if it does not, the fixture result cannot be attributed to the fixture.'
  );
}

describe('E2E Feature: A false ownership claim is caught however the secret is named (TASK-030)', () => {
  describe('Scenario Outline: A paraphrased object is still a claim', () => {
    // The ticket's four Examples rows, plus the remaining objects AC 4 names
    // (entry, item, resource) on the direct non-carried path. "resource" is the
    // interesting one: it must be reported precisely BECAUSE it names nothing
    // in particular, so it must not appear in the exclusion list.
    const PARAPHRASES = [
      { object: 'credential', sentence: 'Terraform creates the credential for this stack.' },
      { object: 'config entry', sentence: 'Terraform provisions the config entry for this stack.' },
      {
        object: 'credential (carried across a clause boundary)',
        sentence: 'Terraform handles this secret. It creates the credential for you.'
      },
      {
        object: 'entry (carried across a clause boundary)',
        sentence: 'Terraform handles this secret. It creates the entry for you.'
      },
      { object: 'entry', sentence: 'Terraform creates the entry for this stack.' },
      { object: 'item', sentence: 'Terraform provisions the item for this stack.' },
      { object: 'resource', sentence: 'Terraform creates the resource for this stack.' },
      { object: 'resources (plural)', sentence: 'Terraform provisions the resources for this stack.' },
      {
        object: 'item (carried across a clause boundary)',
        sentence: 'Terraform handles this secret. It provisions the item for you.'
      },
      {
        object: 'credential (passive)',
        sentence: 'The credential is created by Terraform.'
      }
    ];

    PARAPHRASES.forEach((example) => {
      it(`Given a runbook copy containing a claim whose object is "${example.object}", When the guard runs, Then the claim is reported`, () => {
        assertBaselineIsClean();

        const claims = claimsFor(example.sentence);

        assert.ok(
          claims.length > 0,
          `The guard missed "${example.sentence}". Paraphrasing the secret as ` +
            `"${example.object}" must not be a way to ship a false ownership claim ` +
            'in the runbook with the suite green — that is the exact mutation ' +
            'TASK-030 was raised for.'
        );
      });
    });
  });

  describe('Scenario Outline: Correct documentation is still not a claim', () => {
    // The ticket's four Examples rows: the TASK-027 false positives, plus the
    // denial. Inverting the object test must not be paid for by reporting
    // accurate prose about the resources Terraform genuinely does create.
    const NON_CLAIMS = [
      'Terraform reads this secret. It then creates the Lambda execution role.',
      'Terraform reads the secret. It also creates the DynamoDB table.',
      'Terraform reads the secret. It also creates the KMS key.',
      'Terraform reads the secret. It provisions nothing.',
      "The tf-basestack repo does not create it. It reads the secret, and that repo's own docs create the secret by hand."
    ];

    NON_CLAIMS.forEach((sentence) => {
      it(`Given a runbook copy containing "${sentence}", When the guard runs, Then no claim is reported`, () => {
        assertBaselineIsClean();

        assert.deepEqual(
          claimsFor(sentence),
          [],
          `The guard false-positived on accurate documentation: "${sentence}". ` +
            'The fail-closed default must apply only to objects the guard cannot ' +
            'classify, not to the named resources this stack really does create.'
        );
      });
    });
  });

  describe('Scenario: The TASK-024/027 true positives still fire', () => {
    // AC 6. The direct claim in three shapes plus the carried anaphor, which is
    // the one an over-tightened object test would kill.
    const TRUE_POSITIVES = [
      'Terraform creates the secret for this stack.',
      'Terraform provisions the secret automatically.',
      'The secret is created by Terraform.',
      'Terraform handles this secret. It provisions the value for you.'
    ];

    TRUE_POSITIVES.forEach((sentence) => {
      it(`Given a runbook copy containing "${sentence}", When the guard runs, Then the claim is reported`, () => {
        assertBaselineIsClean();

        assert.ok(
          claimsFor(sentence).length > 0,
          `The original TASK-024/027 true positive "${sentence}" stopped being ` +
            'reported. Excluding other objects must not be implemented by ' +
            'refusing to classify the secret itself.'
        );
      });
    });

    it('Given a runbook copy containing "Terraform creates nothing for the secret.", When the guard runs, Then it is still reported (over-firing is the safe direction)', () => {
      assert.ok(
        claimsFor('Terraform creates nothing for the secret.').length > 0,
        'A negated object on the non-carried path is deliberately still reported. ' +
          'If this ever goes quiet, non-carried negation handling was added and it ' +
          'is now a route for swallowing a claim.'
      );
    });
  });

  describe('Scenario: An undeterminable object is reported, not swallowed', () => {
    // The substance of the ticket, and the one thing a synonym list can never
    // deliver. These objects are in no list anywhere: not the secret, not a
    // resource the guard knows. A guard that cannot decide must report.
    const UNCLASSIFIABLE = [
      'Terraform creates the widget for this stack.',
      'Terraform provisions the doohickey for this stack.',
      'Terraform owns the frobnicator for this stack.',
      'Terraform establishes the wibble for this stack.',
      'Terraform makes the blorptastic for this stack.',
      'Terraform handles this secret. It creates the thingummy for you.'
    ];

    UNCLASSIFIABLE.forEach((sentence) => {
      it(`Given a claim the guard cannot classify — "${sentence}" — When the guard runs, Then the claim is reported`, () => {
        assertBaselineIsClean();

        assert.ok(
          claimsFor(sentence).length > 0,
          `The guard swallowed "${sentence}". An object it cannot classify must be ` +
            'reported: reverting that default to "report only what is provably the ' +
            'secret" is exactly what let every paraphrase through.'
        );
      });
    });

    it('Given the exclusion list, When it is inspected, Then "resource" is absent so an unnamed resource stays undeterminable', () => {
      assert.ok(
        !NON_SECRET_RESOURCE_TERMS.includes('resource'),
        'Adding "resource" to NON_SECRET_RESOURCE_TERMS would excuse ' +
          '"Terraform creates the resource for this stack.", which AC 4 requires ' +
          'to be reported. It names nothing in particular and must stay ' +
          'undeterminable.'
      );
    });
  });

  describe('Scenario: A trailing adjunct naming a real resource does not excuse the claim', () => {
    // objectPhraseOf's whole reason to exist. Every sentence here names a term
    // that IS on the exclusion list, but names it in an adjunct after the
    // object rather than as the object. If the object test looked at the whole
    // following window, each of these would be excused and the paraphrase hole
    // would be reopened one preposition at a time.
    const ADJUNCT_EXCUSES = [
      { term: 'table', sentence: 'Terraform creates the credential for the events table.' },
      { term: 'role', sentence: 'Terraform creates the credential for the Lambda execution role.' },
      { term: 'key', sentence: 'Terraform creates the credential in the KMS key.' },
      { term: 'bucket', sentence: 'Terraform creates the credential with the deployment bucket.' },
      { term: 'policy', sentence: 'Terraform creates the credential and the IAM policy.' },
      { term: 'log group', sentence: 'Terraform provisions the entry for the CloudWatch log group.' },
      { term: 'schema', sentence: 'Terraform creates the item for the events schema.' },
      { term: 'alias', sentence: 'Terraform creates the config entry for the KMS alias.' },
      { term: 'manifest', sentence: 'Terraform creates the credential for the deployment manifest.' }
    ];

    ADJUNCT_EXCUSES.forEach((example) => {
      it(`Given "${example.sentence}", When the guard runs, Then the trailing "${example.term}" does not excuse the claim`, () => {
        assert.ok(
          NON_SECRET_RESOURCE_TERMS.includes(example.term),
          `This fixture only tests anything while "${example.term}" is on the ` +
            'exclusion list; otherwise it would pass for the wrong reason.'
        );

        assert.ok(
          claimsFor(example.sentence).length > 0,
          `The guard excused "${example.sentence}" because "${example.term}" ` +
            'appeared somewhere after the verb. The object is the credential/entry/' +
            'item; the resource sits in an adjunct. Trimming the object phrase at ' +
            'the first preposition or conjunction is what stops a writer from ' +
            'laundering a false claim through a trailing clause.'
        );
      });
    });
  });

  describe('Scenario: Removing any non-secret-resource term is caught', () => {
    // AC 5, swept independently of the guard file's own sweep and with
    // different fixture prose, so the two cannot fail the same way together.
    // Rule kept deliberately: EXACTLY ONE list term per fixture. A fixture
    // naming two terms would still be excused with either one removed, and its
    // pinning assertion would pass vacuously.
    const TERM_FIXTURES = {
      role: 'Terraform reads the secret. It also creates the deployment role.',
      table: 'Terraform reads the secret. It also creates the events table.',
      key: 'Terraform reads the secret. It also creates the encryption key.',
      bucket: 'Terraform reads the secret. It also creates the artifact bucket.',
      'log group': 'Terraform reads the secret. It also creates the lambda log group.',
      alias: 'Terraform reads the secret. It also creates the encryption alias.',
      policy: 'Terraform reads the secret. It also creates the access policy.',
      manifest: 'Terraform reads the secret. It also creates the build manifest.',
      schema: 'Terraform reads the secret. It also creates the events schema.'
    };

    it('Given the exclusion list and the fixture set, When they are compared, Then they are equal so no term can be added or dropped unpinned', () => {
      assert.deepEqual(
        Object.keys(TERM_FIXTURES).slice().sort(),
        NON_SECRET_RESOURCE_TERMS.slice().sort(),
        'Every entry in NON_SECRET_RESOURCE_TERMS needs a fixture here and vice ' +
          'versa. Set equality — not a subset check — is what makes ADDING an ' +
          'unpinned term fail as loudly as removing a pinned one.'
      );
    });

    it('Given each pinning fixture, When its terms are counted, Then it names exactly one list term', () => {
      for (const [term, sentence] of Object.entries(TERM_FIXTURES)) {
        const named = NON_SECRET_RESOURCE_TERMS.filter((candidate) =>
          new RegExp(`\\b${candidate}\\b`, 'i').test(sentence)
        );
        assert.deepEqual(
          named,
          [term],
          `Fixture for "${term}" names ${JSON.stringify(named)}. A fixture naming ` +
            'two list terms is still excused after either one is removed, so its ' +
            'pinning assertion below would pass without pinning anything.'
        );
      }
    });

    Object.keys(TERM_FIXTURES).forEach((term) => {
      it(`Given a build with "${term}" removed from the exclusion list, When the suite runs, Then its fixture starts being reported`, () => {
        const sentence = TERM_FIXTURES[term];
        const withoutTerm = NON_SECRET_RESOURCE_TERMS.filter((entry) => entry !== term);

        // Prove the mutation applied before trusting either result (TASK-099).
        assert.equal(
          withoutTerm.length,
          NON_SECRET_RESOURCE_TERMS.length - 1,
          `Removing "${term}" did not shorten the list, so the comparison below ` +
            'would run a list against itself and pass vacuously.'
        );
        assert.ok(
          !withoutTerm.includes(term),
          `"${term}" survived its own removal; the mutation did not apply.`
        );

        assertBaselineIsClean();
        assert.deepEqual(
          claimsFor(sentence),
          [],
          `With the full list, "${sentence}" is accurate documentation and must ` +
            'not be reported.'
        );
        assert.ok(
          claimsFor(sentence, { nonSecretTerms: withoutTerm }).length > 0,
          `Dropping "${term}" from NON_SECRET_RESOURCE_TERMS changed nothing, so ` +
            'that entry is unpinned and could be deleted with the suite green.'
        );
      });
    });
  });

  describe('Scenario: Every CREATE_VERB branch remains pinned', () => {
    // AC 10. The guard file pins the verbs by fixture only; nothing there
    // rebuilds CREATE_VERB, so a branch could in principle be dropped and some
    // other branch could cover for it. This sweep rebuilds the alternation in
    // memory with exactly one branch missing and requires the matching fixture
    // to stop being reported ON THAT VERB.
    const BRANCH_FIXTURES = {
      create: ['Terraform will create the secret.'],
      creates: ['Terraform creates the secret for this stack.'],
      created: ['The secret is created by Terraform.'],
      creating: ['Terraform is creating the secret.'],
      provision: ['Terraform will provision the secret from here on.'],
      provisions: ['Terraform provisions the secret automatically.'],
      provisioned: ['The secret is provisioned by Terraform.'],
      provisioning: ['Terraform is provisioning the secret on each apply.'],
      'makes?': ['Terraform makes the secret for you.', 'Terraform will make the secret for this stack.'],
      made: ['The secret is made by Terraform for this deployment.'],
      'sets? up': ['Terraform sets up the secret for you.', 'Terraform will set up the secret for this stack.'],
      manage: ['Terraform will manage the secret from here on.'],
      manages: ['Terraform manages the secret for you.'],
      managed: ['The secret is managed by Terraform.'],
      managing: ['Terraform is managing the secret for your stack.'],
      own: ['Terraform will own the secret from here on.'],
      owns: ['Terraform owns the secret for this stack.'],
      owned: ['The secret is owned by Terraform.'],
      owning: ['Terraform is owning the secret from here on.'],
      establish: ['Terraform will establish the secret from here on.'],
      establishes: ['Terraform establishes the secret for this stack.'],
      established: ['The secret is established by Terraform.'],
      establishing: ['Terraform is establishing the secret for you.']
    };

    /** The verb token a fixture is expected to be reported on, derived from the
     *  branch: `makes?` covers make/makes, `sets? up` covers set up/sets up. */
    function verbTokenIn(sentence, branch) {
      const surfaces =
        branch === 'makes?'
          ? ['makes', 'make']
          : branch === 'sets? up'
            ? ['sets up', 'set up']
            : [branch];
      const found = surfaces.find((surface) =>
        new RegExp(`\\b${surface}\\b`, 'i').test(sentence)
      );
      assert.ok(found, `No surface form of branch "${branch}" appears in "${sentence}"`);
      return found;
    }

    const branchesInSource = () => {
      const declaration = guardPreludeSource().match(CREATE_VERB_DECL);
      assert.ok(
        declaration,
        'CREATE_VERB is no longer declared in the shape this sweep rebuilds. ' +
          'Update the sweep rather than let it quietly stop mutating anything.'
      );
      return declaration[1].split('|');
    };

    it('Given the guard source, When CREATE_VERB is parsed, Then it declares exactly the 23 branches this sweep pins', () => {
      assert.deepEqual(
        branchesInSource(),
        Object.keys(BRANCH_FIXTURES),
        'The CREATE_VERB alternation and this sweep have drifted apart. Set ' +
          'equality in order is deliberate: a branch added without a fixture must ' +
          'fail here, not slip in unpinned.'
      );
      assert.equal(branchesInSource().length, 23, 'AC 10 pins 23 CREATE_VERB branches');
    });

    Object.entries(BRANCH_FIXTURES).forEach(([branch, sentences]) => {
      it(`Given a build with the CREATE_VERB branch "${branch}" removed, When the guard runs, Then its fixture is no longer reported`, async () => {
        const branches = branchesInSource();
        const remaining = branches.filter((entry) => entry !== branch);
        assert.equal(
          remaining.length,
          branches.length - 1,
          `Removing "${branch}" did not shorten the alternation; the mutation did ` +
            'not apply and everything below would pass vacuously.'
        );

        // loadOwnershipGuard throws if the transform is a no-op, so a mutation
        // that silently fails to apply cannot be mistaken for a green result.
        const mutatedGuard = await loadOwnershipGuard({
          transform: (source) =>
            source.replace(
              CREATE_VERB_DECL,
              `const CREATE_VERB = /\\b(${remaining.join('|')})\\b/gi;`
            )
        });

        assert.deepEqual(
          mutatedGuard.terraformCreatesSecretClaimsIn(mutatedGuard.runbookText()),
          [],
          'The mutated build must still find the real runbook clean, or the ' +
            'fixture result below cannot be attributed to the fixture.'
        );

        for (const sentence of sentences) {
          const verb = verbTokenIn(sentence, branch);
          const full = claimsFor(sentence);
          assert.ok(
            full.some((clause) => clause.toLowerCase().includes(`[${verb.toLowerCase()}]`)),
            `With the real CREATE_VERB, "${sentence}" must be reported on the verb ` +
              `"${verb}". Got ${JSON.stringify(full)}.`
          );

          const document = `${mutatedGuard.runbookText()}${'\r\n\r\n'}${sentence}${'\r\n'}`;
          const afterRemoval = mutatedGuard.terraformCreatesSecretClaimsIn(document);
          assert.ok(
            !afterRemoval.some((clause) => clause.toLowerCase().includes(`[${verb.toLowerCase()}]`)),
            `Removing the CREATE_VERB branch "${branch}" changed nothing for ` +
              `"${sentence}": it is still reported on "${verb}". That branch is ` +
              'unpinned and could be deleted with the suite green.'
          );
        }
      });
    });
  });

  describe('Scenario: The guard refuses to be switched off', () => {
    // Failure/edge path. An exclusion list that matches everything excuses
    // every object, which turns the guard into a function that always returns
    // [] — the no-op-guard defect class this board keeps finding. It must be
    // loud rather than green.
    const REJECTED = [
      { label: 'an empty array', value: [] },
      { label: 'null', value: null },
      { label: 'a bare string', value: 'role' },
      { label: 'a number', value: 9 },
      { label: 'an object', value: { role: true } }
    ];

    REJECTED.forEach((example) => {
      it(`Given ${example.label} as the exclusion list, When the guard is called, Then it throws instead of running`, () => {
        assert.throws(
          () => terraformCreatesSecretClaimsIn(runbookText(), { nonSecretTerms: example.value }),
          /non-empty array/,
          `${example.label} must be rejected loudly: a list the guard cannot use ` +
            'would either match everywhere or crash the pattern build, and either ' +
            'way a silently-empty claim list looks exactly like a clean runbook.'
        );
      });
    });
  });

  describe('Scenario: The real runbook still passes unchanged', () => {
    let runbookDigestBefore;

    before(() => {
      runbookDigestBefore = crypto
        .createHash('sha256')
        .update(fs.readFileSync(RUNBOOK_PATH))
        .digest('hex');
    });

    it('Given the real runbook, When the guard runs with the shipped list, Then no claim is reported', () => {
      assert.deepEqual(
        terraformCreatesSecretClaimsIn(runbookText()),
        [],
        'The real runbook must stay claim-free. AC 9.'
      );
    });

    it('Given the real runbook, When the guard runs with the exclusion list reduced to nothing it can match, Then it is STILL clean — no create verb in the runbook is Terraform-governed', () => {
      // This is the load-bearing reason the fail-closed default is safe to
      // ship. With the exclusion list reduced to a term that appears nowhere,
      // step 2 can never fire, so EVERY Terraform-governed, non-negated create
      // verb in the runbook would be reported. Still [] means there are none:
      // the runbook's create verbs all belong to the operator's own steps.
      const maximallyClosed = terraformCreatesSecretClaimsIn(runbookText(), {
        nonSecretTerms: ['zzz-no-such-resource-term-zzz']
      });

      assert.deepEqual(
        maximallyClosed,
        [],
        'With step 2 disabled the runbook reported ' +
          `${JSON.stringify(maximallyClosed)}. That means a create verb in the ` +
          'runbook IS governed by a Terraform subject and only the exclusion list ' +
          'is keeping the baseline green — which makes the whole baseline hostage ' +
          'to that list rather than to the prose being true.'
      );
    });

    it('Given that maximally-closed run, When a known non-claim is appended to it, Then it IS reported — proving the reduced list really did disable step 2', () => {
      // Without this, the assertion above could pass because the reduced list
      // silently did nothing at all.
      assert.ok(
        claimsFor('Terraform reads the secret. It also creates the DynamoDB table.', {
          nonSecretTerms: ['zzz-no-such-resource-term-zzz']
        }).length > 0,
        'The reduced exclusion list did not change classification, so the ' +
          'assertion above proved nothing about the runbook.'
      );
    });

    after(() => {
      const runbookDigestAfter = crypto
        .createHash('sha256')
        .update(fs.readFileSync(RUNBOOK_PATH))
        .digest('hex');
      assert.equal(
        runbookDigestAfter,
        runbookDigestBefore,
        'AC 11: docs/google-oauth-setup.md was modified by this test file. Every ' +
          'fixture must stay in memory; a test that edits the runbook can leave the ' +
          'repo dirty and can make the next run pass for the wrong reason.'
      );
    });
  });

  describe('Scenario: The documented boundaries of the guard are pinned as they are', () => {
    // Not aspirational: these record what the guard deliberately does and does
    // not do, so a future change cannot quietly move either line.
    const STILL_OPEN_BYPASSES = [
      {
        name: 'non-pronoun back-reference',
        sentence: 'Terraform handles this secret. The stack provisions the value for you.'
      },
      {
        name: 'carry over more than one clause',
        sentence:
          'Terraform handles this secret. The region matters here. It provisions the value for you.'
      }
    ];

    STILL_OPEN_BYPASSES.forEach((example) => {
      it(`Given the documented bypass "${example.name}", When the guard runs, Then it is still NOT caught (recorded, not endorsed)`, () => {
        assert.deepEqual(
          claimsFor(example.sentence),
          [],
          `"${example.sentence}" is now caught. That is an improvement, but it is ` +
            'undocumented: update the guard comment and this pin together so the ' +
            'known gap list stays accurate.'
        );
      });
    });

    it('Given the documented over-fire "…creates the payload schema for the events table.", When the guard runs, Then it IS still caught', () => {
      assert.ok(
        claimsFor('Terraform reads the secret. It also creates the payload schema for the events table.')
          .length > 0,
        'The documented over-fire stopped firing. "payload" is a SECRET_ANAPHOR, so ' +
          'this sentence is classified as a claim about the secret before the ' +
          'exclusion list is ever consulted; if that stopped being true, the anaphor ' +
          'path itself has changed.'
      );
    });

    it('Given an irregular plural of a listed term, When the guard runs, Then it is reported (unmatched means reported, and that is the safe direction)', () => {
      assert.ok(
        claimsFor('Terraform reads the secret. It also creates the IAM policies.').length > 0,
        '"policies" is deliberately not matched by the simple-plural pattern, so it ' +
          'is undeterminable and reported. This pin exists so that "improving" the ' +
          'pattern to match irregular plurals cannot silently widen the exclusion ' +
          'list without anyone deciding to.'
      );
    });

    const SIMPLE_PLURALS = [
      'Terraform reads the secret. It also creates the DynamoDB tables.',
      'Terraform reads the secret. It also creates the KMS aliases.',
      'Terraform reads the secret. It also creates the lambda log groups.'
    ];

    SIMPLE_PLURALS.forEach((sentence) => {
      it(`Given a simple plural — "${sentence}" — When the guard runs, Then it is not reported`, () => {
        assert.deepEqual(
          claimsFor(sentence),
          [],
          'Simple plurals of listed resources are accurate documentation and are ' +
            'matched on purpose; only irregular plurals fall through to the ' +
            'fail-closed default.'
        );
      });
    });
  });
});
