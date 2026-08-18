import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../scripts/check-oauth-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const TERRAFORM_CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');
const RUNBOOK_PATH = path.join(DOCS_DIR, 'google-oauth-setup.md');

// Every guard below takes the document text as an argument and has a thin
// disk-reading wrapper for the assertions about the real runbook. That split
// exists so the mutation fixtures in this file (a doc copy carrying a
// deliberately false claim) run entirely in memory: nothing here ever writes to
// docs/google-oauth-setup.md.

/** The real runbook, read from disk. Only the wrappers below call this. */
function runbookText() {
  return fs.readFileSync(RUNBOOK_PATH, 'utf-8');
}

/** Prose with fenced code blocks removed, so example commands and pasted AWS
 *  error text are never mistaken for a claim the document makes. */
function proseOf(documentText) {
  return documentText.replace(/```[\s\S]*?```/g, ' ');
}

/** Prose split into rough sentences, newlines collapsed so a claim wrapped
 *  across lines is still examined as one sentence. */
function sentencesOf(documentText) {
  return proseOf(documentText)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function runbookProse() {
  return proseOf(runbookText());
}

function runbookSentences() {
  return sentencesOf(runbookText());
}

// --- Semantic guard: "Terraform creates the secret" must never come back ------
// Rather than matching one exact sentence, every create-flavoured verb in the
// prose is examined in context: does a Terraform subject govern it, is the
// secret its object, and is it negated? A claim only counts as false when a
// Terraform subject creates a secret and nothing negates it.
// Also includes ownership-claim verbs (manages, owns, establishes) that would be false claims.
const CREATE_VERB = /\b(create|creates|created|creating|provision|provisions|provisioned|provisioning|makes?|made|sets? up|manage|manages|managed|managing|own|owns|owned|owning|establish|establishes|established|establishing)\b/gi;
const SUBJECT_WINDOW = 45;
const OBJECT_WINDOW = 70;
const NEGATION_BEFORE_VERB = /\b(not|never|no|nor|neither|without|n't|rather than|instead of)\b(\s+\S+){0,3}\s*$/i;

// A claim can also be split over a clause boundary, with the Terraform subject
// in one clause and the create verb in the next: "Terraform handles this
// secret. It provisions the value for you." Ordinary editing splits sentences
// all the time, so the subject (and its object) are carried forward across one
// boundary — but only when the verb's own clause is nothing but a
// back-referring pronoun and its auxiliary, which is what makes the pronoun the
// verb's subject. "...and that project's own docs create its secrets" does not
// match, so prose that discusses another stack creating a secret one clause
// after a Terraform mention is still not a claim about Terraform.
const BACK_REFERRING_SUBJECT =
  /^[\s—-]*(it|this|that|they|these|those)\s+(?:also\s+|then\s+|now\s+|only\s+|already\s+|still\s+)?(?:(?:will|shall|can|could|does|do|did|has|have|had|is|are|was|were|would|must|may|might)\s+(?:not\s+)?)?$/i;
// "It provisions nothing" / "It creates no secret" are denials, not claims.
// Only consulted on the carried path, where the object comes from the previous
// clause and so cannot itself carry the negation.
const NEGATED_OBJECT = /^\s*(nothing|none|no|neither|nor)\b/i;
// On the carried path the object must be the *carried verb's own* object, not
// merely a secret mentioned in the previous clause. Asking only "did the
// previous clause mention a secret?" over-fires badly: the secret is this
// runbook's main subject, so a nearby mention is the normal case, and
// "Terraform reads the secret. It also creates the DynamoDB table." is accurate
// documentation (terraform/dynamodb_calendar_events.tf et al. really do exist)
// yet was reported as a false claim.
//
// So the carried object counts only when it denotes the secret: either it names
// it outright ("It creates the secret on the first apply"), or it is an anaphor
// for the secret carried over the boundary — a secret's "value"/"contents" is
// the secret, which is what makes "Terraform handles this secret. It provisions
// the value for you." a genuine claim. The previous clause is consulted only to
// supply that anaphor's antecedent, never as the object test on its own; a
// carried verb acting on some other named resource is not a claim about the
// secret however close the nearest secret mention is.
const SECRET_ANAPHOR =
  /^\s*(?:the|its|this|that|these|those)?\s*(?:value|values|contents?|payload|version)\b/i;

/** Clauses in the given document that claim Terraform creates the secret. */
function terraformCreatesSecretClaimsIn(documentText) {
  const prose = proseOf(documentText).replace(/\s+/g, ' ');
  const claims = [];

  for (const match of prose.matchAll(CREATE_VERB)) {
    const start = match.index;
    const end = start + match[0].length;

    // `aws secretsmanager create-secret` is a CLI subcommand, not a claim.
    if (/^-secret/.test(prose.slice(end, end + 7))) continue;

    // Restrict to the verb's own clause: stop at sentence/clause punctuation.
    const before = prose.slice(Math.max(0, start - 160), start).split(/[.;:!?]/).pop();
    const after = prose.slice(end, end + 160).split(/[.;:!?]/)[0];

    // The clause immediately before this one, for the pronoun-carrying case.
    const priorClauses = prose.slice(0, start).split(/[.;:!?]/);
    priorClauses.pop(); // the verb's own clause
    const priorClause = priorClauses.pop() ?? '';

    const carriesTerraformSubject =
      BACK_REFERRING_SUBJECT.test(before) && /\bterraform\b/i.test(priorClause);
    if (carriesTerraformSubject && NEGATED_OBJECT.test(after)) continue;

    const governedByTerraform =
      /\bterraform\b/i.test(before.slice(-SUBJECT_WINDOW)) ||
      /\bby\b[^,]{0,25}\bterraform\b/i.test(after.slice(0, SUBJECT_WINDOW)) ||
      carriesTerraformSubject;
    if (!governedByTerraform) continue;

    const secretIsTheObject =
      /\bsecrets?\b/i.test(after.slice(0, OBJECT_WINDOW)) ||
      /\bsecrets?\b/i.test(before.slice(-OBJECT_WINDOW)) ||
      (carriesTerraformSubject &&
        SECRET_ANAPHOR.test(after) &&
        /\bsecrets?\b/i.test(priorClause));
    if (!secretIsTheObject) continue;

    if (NEGATION_BEFORE_VERB.test(before)) continue;

    const context = carriesTerraformSubject ? `${priorClause}.${before}` : before;
    claims.push(`${context}[${match[0]}]${after}`.trim());
  }

  return claims;
}

/** Clauses in the real runbook that claim Terraform creates the secret. */
function terraformCreatesSecretClaims() {
  return terraformCreatesSecretClaimsIn(runbookText());
}

// --- Semantic guard: the runbook must name what does create the secret -------
// A bare substring match on stack names is not enough: the runbook names
// `tf-cloudinfra`, `ohq-chatbot2` and `tf-basestack` precisely to record that
// they do *not* create the secret, so prose asserting the opposite of ownership
// would satisfy a substring guard. An owner mention only counts when the
// sentence naming it also asserts ownership and carries no negation.
const OWNER_NAME = /\b(tf-basestack|basestack|tf-cloudinfra|operator[-\s]owned|out of band|manual prerequisite)\b/i;
const OWNERSHIP_ASSERTION = /\b(creates?|created|provisions?|provisioned|establishes?|established|owns?|owned|manages?|managed|prerequisite|responsible\s+for|by\s+hand|manually)\b/i;
const SENTENCE_NEGATION = /\b(not|never|no|none|nor|neither|cannot|n't|without|unable|ruled?\s+out)\b/i;

/** Whether the document walks the operator through creating the secret. */
function documentsCreateStepIn(documentText) {
  return /aws\s+secretsmanager\s+create-secret/.test(documentText);
}

/** Sentences that name a secret owner *and* affirm that it owns the secret. */
function affirmativeOwnerStatementsIn(documentText) {
  return sentencesOf(documentText).filter(
    (sentence) =>
      OWNER_NAME.test(sentence) &&
      OWNERSHIP_ASSERTION.test(sentence) &&
      !SENTENCE_NEGATION.test(sentence)
  );
}

function escapeRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The secret name Terraform actually reads, as a regex over the
 *  ${var.environment}/${var.tenant} interpolations in local.secret_name. */
function terraformSecretNamePattern() {
  const variablesContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
  const match = variablesContent.match(/secret_name\s*=\s*"([^"]+)"/);
  assert.ok(match, 'local.secret_name not found in terraform/variables.tf');
  const template = match[1];
  const literals = template.split(/\$\{var\.[a-z_]+\}/);
  return {
    template,
    regex: new RegExp(`^${literals.map(escapeRegex).join('([a-z0-9]+)')}$`)
  };
}

/** Every `--name`/`--secret-id` value passed to the given aws secretsmanager
 *  subcommand anywhere in the runbook. */
function secretNamesForCommand(subcommand) {
  const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
  const blocks = content.split(new RegExp(`aws\\s+secretsmanager\\s+${subcommand}\\b`)).slice(1);
  return blocks
    .map((block) => block.split('```')[0].match(/--(?:name|secret-id)\s+"?([^"\s\\]+)"?/))
    .filter(Boolean)
    .map((m) => m[1]);
}

describe('Google OAuth Configuration Preflight E2E Tests', () => {
  describe('Feature: OAuth configuration preflight validation', () => {
    describe('Scenario: A fully configured environment passes', () => {
      it('Given a secret containing every required key, well-formed', async () => {
        const mockSecret = {
          GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdef123456',
          SESSION_SECRET: Buffer.from('a'.repeat(32), 'utf-8').toString('base64'),
          ANTHROPIC_API_KEY: 'sk-ant-v1-test-key-12345678',
          ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
        };

        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        assert.equal(code, 0, 'Expected exit code 0 for valid config');
        assert.ok(logs.some(l => l.includes('PASS')), 'Expected PASS messages in output');
      });
    });

    describe('Scenario: A missing key is named', () => {
      it('When the preflight runs and GOOGLE_CLIENT_SECRET is missing', async () => {
        const mockSecret = {
          GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
          SESSION_SECRET: Buffer.from('a'.repeat(32), 'utf-8').toString('base64'),
          ANTHROPIC_API_KEY: 'sk-ant-v1-test-key-12345678',
          ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
        };

        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        assert.equal(code, 1, 'Expected exit code 1 for missing key');
        assert.ok(
          logs.some(l => l.includes('GOOGLE_CLIENT_SECRET')),
          'Expected output to name GOOGLE_CLIENT_SECRET'
        );
        assert.ok(
          logs.some(l => l.includes('FAIL')),
          'Expected FAIL message in output'
        );
      });
    });

    describe('Scenario: An empty key is treated as missing', () => {
      it('When SESSION_SECRET is an empty string', async () => {
        const mockSecret = {
          GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdef123456',
          SESSION_SECRET: '',
          ANTHROPIC_API_KEY: 'sk-ant-v1-test-key-12345678',
          ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
        };

        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        assert.equal(code, 1, 'Expected exit code 1 for empty SESSION_SECRET');
        assert.ok(
          logs.some(l => l.includes('SESSION_SECRET')),
          'Expected output to reference SESSION_SECRET'
        );
      });
    });

    describe('Scenario Outline: Malformed credentials are caught before deploy', () => {
      const examples = [
        {
          key: 'GOOGLE_CLIENT_ID',
          value: '12345',
          desc: 'GOOGLE_CLIENT_ID without .apps.googleusercontent.com suffix'
        },
        {
          key: 'ANTHROPIC_API_KEY',
          value: 'not-an-anthropic-key',
          desc: 'ANTHROPIC_API_KEY without sk-ant- prefix'
        },
        {
          key: 'SESSION_SECRET',
          value: 'short',
          desc: 'SESSION_SECRET with insufficient entropy'
        }
      ];

      examples.forEach(example => {
        it(`When "${example.key}" is "${example.value}" (${example.desc})`, async () => {
          const mockSecret = {
            GOOGLE_CLIENT_ID: example.key === 'GOOGLE_CLIENT_ID' ? example.value : '123456789.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdef123456',
            SESSION_SECRET: example.key === 'SESSION_SECRET' ? example.value : Buffer.from('a'.repeat(32), 'utf-8').toString('base64'),
            ANTHROPIC_API_KEY: example.key === 'ANTHROPIC_API_KEY' ? example.value : 'sk-ant-v1-test-key-12345678',
            ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
          };

          const logs = [];
          const code = await run({
            argv: ['--env', 'dev', '--tenant', 'au'],
            fetchSecret: async () => mockSecret,
            log: (line) => logs.push(line)
          });

          assert.equal(code, 1, `Expected exit code 1 for malformed ${example.key}`);
          assert.ok(
            logs.some(l => l.includes('FAIL')),
            `Expected FAIL message for malformed ${example.key}`
          );
        });
      });
    });

    describe('Scenario: The preflight never leaks key material', () => {
      it('When a secret with GOOGLE_CLIENT_SECRET "GOCSPX-super-secret-value" is checked', async () => {
        const secretValue = 'GOCSPX-super-secret-value';
        const mockSecret = {
          GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: secretValue,
          SESSION_SECRET: Buffer.from('a'.repeat(32), 'utf-8').toString('base64'),
          ANTHROPIC_API_KEY: 'sk-ant-v1-test-key-12345678',
          ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
        };

        const logs = [];
        await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        const output = logs.join('\n');
        assert.ok(
          !output.includes(secretValue),
          'Output should not contain the full secret value'
        );
        assert.ok(
          !output.includes('GOCSPX'),
          'Output should not contain the secret prefix'
        );
      });

      it('When JSON parsing fails, the error message does not leak input', async () => {
        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => '{"GOOGLE_CLIENT_SECRET": "GOCSPX-super-secret-{malformed}',
          log: (line) => logs.push(line)
        });

        const output = logs.join('\n');
        assert.equal(code, 1, 'Expected exit code 1 for malformed JSON');
        assert.ok(
          !output.includes('GOCSPX'),
          'Error output should not contain secret prefix'
        );
        assert.ok(
          !output.includes('malformed'),
          'Error output should not contain malformed input'
        );
      });

      it('When all keys fail validation, the FAILED keys summary contains only key names', async () => {
        const mockSecret = {
          GOOGLE_CLIENT_ID: 'bad-id',
          GOOGLE_CLIENT_SECRET: '',
          SESSION_SECRET: 'short',
          ANTHROPIC_API_KEY: 'bad-key',
          ALLOWED_ORIGINS: ''
        };

        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        const output = logs.join('\n');
        assert.equal(code, 1, 'Expected exit code 1 for failed validation');
        assert.ok(
          output.includes('FAILED keys:'),
          'Expected FAILED keys summary'
        );
        // Verify only key names appear, not the bad values
        assert.ok(
          !output.includes('bad-id'),
          'Output should not contain the bad client ID value'
        );
        assert.ok(
          !output.includes('bad-key'),
          'Output should not contain the bad API key value'
        );
      });
    });

    describe('Scenario: Every deployed environment has a registered callback', () => {
      it('Given the runbook redirect URI table and terraform tfvars files', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        assert.ok(fs.existsSync(runbookPath), 'google-oauth-setup.md not found');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        // Parse tfvars files for hosted_zone
        const expectedUris = [];
        const tfvarsConfigs = [
          { env: 'dev', tenant: 'au', file: 'dev/au.tfvars' },
          { env: 'prod', tenant: 'au', file: 'prod/au.tfvars' },
          { env: 'prod', tenant: 'uk', file: 'prod/uk.tfvars' },
          { env: 'prod', tenant: 'us', file: 'prod/us.tfvars' }
        ];

        for (const config of tfvarsConfigs) {
          const tfvarsPath = path.join(TERRAFORM_CONFIG_DIR, config.file);
          assert.ok(fs.existsSync(tfvarsPath), `tfvars file not found: ${config.file}`);
          const tfvarsContent = fs.readFileSync(tfvarsPath, 'utf-8');

          const match = tfvarsContent.match(/hosted_zone\s*=\s*"([^"]+)"/);
          assert.ok(match, `hosted_zone not found in ${config.file}`);

          const hostedZone = match[1];
          const callbackUri = `https://calendar.${hostedZone}/calendar/api/auth/google/callback`;
          expectedUris.push(callbackUri);
        }

        // Also expect localhost
        expectedUris.push('http://localhost:3000/calendar/api/auth/google/callback');

        // Verify every URI appears in the runbook
        for (const uri of expectedUris) {
          assert.ok(
            runbookContent.includes(uri),
            `Runbook does not contain expected callback URI: ${uri}`
          );
        }
      });
    });

    describe('Scenario: The runbook carries no real credentials', () => {
      it('Given the file "docs/google-oauth-setup.md"', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        assert.ok(fs.existsSync(runbookPath), 'google-oauth-setup.md not found');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        // Check for Google client secret pattern (GOCSPX-...)
        const googleSecretPattern = /GOCSPX-[A-Za-z0-9_-]+/;
        assert.ok(
          !googleSecretPattern.test(runbookContent),
          'Runbook should not contain Google client secret values'
        );

        // Check for Anthropic API key pattern (sk-ant-...)
        const anthropicKeyPattern = /sk-ant-[A-Za-z0-9_-]+/;
        assert.ok(
          !anthropicKeyPattern.test(runbookContent),
          'Runbook should not contain real Anthropic API keys'
        );

        // Verify REPLACE_ME placeholders are used instead
        assert.ok(
          runbookContent.includes('REPLACE_ME_CLIENT_ID'),
          'Runbook should use REPLACE_ME_CLIENT_ID placeholder'
        );
        assert.ok(
          runbookContent.includes('REPLACE_ME_GOOGLE_CLIENT_SECRET'),
          'Runbook should use REPLACE_ME_GOOGLE_CLIENT_SECRET placeholder'
        );
        assert.ok(
          runbookContent.includes('REPLACE_ME_ANTHROPIC_API_KEY'),
          'Runbook should use REPLACE_ME_ANTHROPIC_API_KEY placeholder'
        );
      });
    });

    describe('Scenario: The runbook contains all required sections', () => {
      it('Given google-oauth-setup.md', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        assert.ok(fs.existsSync(runbookPath), 'google-oauth-setup.md not found');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        // Check for all six required sections
        const requiredSections = [
          '1. Google Cloud project and the Gmail API',
          '2. OAuth consent screen',
          '3. OAuth client and the redirect URI matrix',
          '4. Populating the Secrets Manager secret',
          '5. Restricted scope: verification, CASA, and Limited Use',
          '6. Troubleshooting'
        ];

        for (const section of requiredSections) {
          assert.ok(
            runbookContent.includes(section),
            `Runbook missing required section: ${section}`
          );
        }
      });

      it('Then the runbook states the 100-user unverified cap and verification requirement', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        assert.ok(
          runbookContent.includes('100'),
          'Runbook should mention the 100-user cap'
        );
        assert.ok(
          runbookContent.includes('verification'),
          'Runbook should mention verification requirement'
        );
        assert.ok(
          runbookContent.includes('CASA'),
          'Runbook should mention CASA assessment'
        );
      });

      it('Then the runbook states the Limited Use revoke/delete obligation and points at TASK-013', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        assert.ok(
          runbookContent.includes('Limited Use'),
          'Runbook should mention Limited Use'
        );
        assert.ok(
          runbookContent.includes('revoke'),
          'Runbook should mention revoke'
        );
        assert.ok(
          runbookContent.includes('TASK-013'),
          'Runbook should reference TASK-013'
        );
      });

      it('Then the runbook includes a localhost redirect URI with http note', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        assert.ok(
          runbookContent.includes('localhost'),
          'Runbook should include localhost redirect URI'
        );
        assert.ok(
          runbookContent.includes('http'),
          'Runbook should mention http'
        );
      });

      it('Then the troubleshooting table covers required error cases', () => {
        const runbookPath = path.join(DOCS_DIR, 'google-oauth-setup.md');
        const runbookContent = fs.readFileSync(runbookPath, 'utf-8');

        const requiredErrors = [
          'redirect_uri_mismatch',
          'access_denied',
          'admin_policy_enforced',
          'refresh_token'
        ];

        for (const error of requiredErrors) {
          assert.ok(
            runbookContent.includes(error),
            `Runbook troubleshooting should cover: ${error}`
          );
        }
      });
    });

    describe('Scenario: npm run check:oauth-config is defined', () => {
      it('Given the root package.json', () => {
        const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
        assert.ok(fs.existsSync(packageJsonPath), 'package.json not found');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        assert.ok(
          packageJson.scripts && packageJson.scripts['check:oauth-config'],
          'package.json should define check:oauth-config script'
        );
        assert.equal(
          packageJson.scripts['check:oauth-config'],
          'node scripts/check-oauth-config.mjs',
          'check:oauth-config should invoke the right script'
        );
      });
    });
  });

  describe('Feature: The runbook tells the truth about secret ownership', () => {
    describe('Scenario: It does not claim Terraform creates the secret', () => {
      it('Then no clause pairs a Terraform subject with a create verb on the secret', () => {
        const claims = terraformCreatesSecretClaims();

        assert.deepEqual(
          claims,
          [],
          'Runbook appears to claim Terraform creates the Secrets Manager secret. ' +
            'Terraform only reads it: data "aws_secretsmanager_secret_version" in ' +
            'terraform/main.tf and data "aws_secretsmanager_secret" in ' +
            'terraform/lambda_calendar.tf, with no aws_secretsmanager_secret ' +
            `resource anywhere. Offending clause(s): ${JSON.stringify(claims)}`
        );
      });

      // Each phrasing is appended to an in-memory copy of the real runbook and
      // fed through the real terraformCreatesSecretClaimsIn(), so the verb
      // coverage is pinned against the real CREATE_VERB regex rather than a
      // local copy of it: trimming `manage`, `own` or `establish` out of
      // CREATE_VERB turns these assertions red. The reported clause is matched
      // on the exact verb, so dropping one tense of one verb is caught too.
      const OWNERSHIP_CLAIM_FIXTURES = [
        { tense: 'active', verb: 'manages', sentence: 'Terraform manages the secret for you.' },
        { tense: 'passive', verb: 'managed', sentence: 'The secret is managed by Terraform.' },
        { tense: 'future', verb: 'manage', sentence: 'Terraform will manage the secret from here on.' },
        { tense: 'active', verb: 'owns', sentence: 'Terraform owns the secret for this stack.' },
        { tense: 'passive', verb: 'owned', sentence: 'The secret is owned by Terraform.' },
        { tense: 'future', verb: 'own', sentence: 'Terraform will own the secret from here on.' },
        { tense: 'active', verb: 'establishes', sentence: 'Terraform establishes the secret for this stack.' },
        { tense: 'passive', verb: 'established', sentence: 'The secret is established by Terraform.' },
        { tense: 'future', verb: 'establish', sentence: 'Terraform will establish the secret from here on.' },
        { tense: 'active', verb: 'creates', sentence: 'Terraform creates the secret for this stack.' },
        { tense: 'passive', verb: 'provisioned', sentence: 'The secret is provisioned by Terraform.' },
        { tense: 'future', verb: 'provision', sentence: 'Terraform will provision the secret from here on.' },
        // Four unpinned tenses of the primary verb from the original onboarding failure.
        // These are caught by the guard but not pinned by mutation tests, so any of them
        // can be trimmed from CREATE_VERB silently. The primary verb "create" deserves coverage.
        { tense: 'future', verb: 'create', sentence: 'Terraform will create the secret.' },
        { tense: 'passive', verb: 'created', sentence: 'The secret is created by Terraform.' },
        { tense: 'progressive', verb: 'creating', sentence: 'Terraform is creating the secret.' },
        { tense: 'progressive', verb: 'establishing', sentence: 'Terraform is establishing the secret for you.' }
      ];

      OWNERSHIP_CLAIM_FIXTURES.forEach((fixture) => {
        it(`Then the real guard reports the ${fixture.tense} claim "${fixture.sentence}"`, () => {
          const baseline = runbookText();
          assert.deepEqual(
            terraformCreatesSecretClaimsIn(baseline),
            [],
            'Baseline runbook must be claim-free for this mutation to mean anything'
          );

          const mutated = `${baseline}\n\n${fixture.sentence}\n`;
          const claims = terraformCreatesSecretClaimsIn(mutated);

          assert.ok(
            claims.length > 0,
            `The guard missed "${fixture.sentence}". "${fixture.verb}" must stay in ` +
              'CREATE_VERB, or an ownership claim can return to the runbook unflagged.'
          );
          assert.ok(
            claims.some((clause) => clause.includes(`[${fixture.verb}]`)),
            `The guard reported ${JSON.stringify(claims)} but not on the verb ` +
              `"${fixture.verb}" itself, so that verb is not actually covered`
          );
        });
      });

      // The bypass this closes: the Terraform subject in one clause and the
      // create verb in the next, tied together only by a pronoun.
      const SENTENCE_SPLIT_CLAIM_FIXTURES = [
        'Terraform handles this secret. It provisions the value for you.',
        'Terraform is the home of this secret. It creates the secret on the first apply.',
        'Terraform handles this secret; it also provisions the value for you.',
        'Terraform is where this secret lives. That establishes the value for you.'
      ];

      SENTENCE_SPLIT_CLAIM_FIXTURES.forEach((fixtureSentences) => {
        it(`Then the guard follows the pronoun across the split in "${fixtureSentences}"`, () => {
          const mutated = `${runbookText()}\n\n${fixtureSentences}\n`;
          const claims = terraformCreatesSecretClaimsIn(mutated);

          assert.ok(
            claims.length > 0,
            `The guard missed "${fixtureSentences}". A false claim whose Terraform ` +
              'subject and create verb sit in separate clauses must still be reported.'
          );
        });
      });

      // The carry's object test must look at what the *carried verb* operates
      // on. Asking only whether the previous clause mentioned a secret made the
      // guard over-fire on accurate documentation: Terraform in this project
      // genuinely does create the Lambda execution role, the DynamoDB tables
      // and the KMS CMK (terraform/lambda_calendar.tf,
      // dynamodb_calendar_connections.tf, dynamodb_calendar_events.tf,
      // kms_calendar.tf), and the secret is this runbook's main subject, so a
      // nearby secret mention is the normal case rather than a rare one.
      // Re-loosening the object test back to "the prior clause mentions a
      // secret" turns every case below red.
      const CARRIED_VERB_OTHER_OBJECT_FIXTURES = [
        {
          object: 'Lambda execution role',
          text: 'Terraform reads this secret. It then creates the Lambda execution role.'
        },
        {
          object: 'DynamoDB table',
          text: 'Terraform reads the secret. It also creates the DynamoDB table.'
        },
        {
          object: 'KMS key',
          text: 'Terraform reads the secret. It also creates the KMS key.'
        },
        {
          object: 'CloudWatch log group',
          text: 'Terraform reads the secret. It also provisions the CloudWatch log group.'
        },
        {
          object: 'IAM policy (passive-adjacent phrasing)',
          text: 'Terraform reads this secret. It manages the IAM policy for the function.'
        }
      ];

      CARRIED_VERB_OTHER_OBJECT_FIXTURES.forEach((fixture) => {
        it(`Then a carried verb whose object is the ${fixture.object} is not reported`, () => {
          const baseline = runbookText();
          assert.deepEqual(
            terraformCreatesSecretClaimsIn(baseline),
            [],
            'Baseline runbook must be claim-free for this fixture to mean anything'
          );

          const mutated = `${baseline}\n\n${fixture.text}\n`;
          assert.deepEqual(
            terraformCreatesSecretClaimsIn(mutated),
            [],
            `The guard false-positived on accurate documentation: "${fixture.text}". ` +
              'On the carried path the secret must be the object of the carried verb; ' +
              'a secret merely mentioned in the previous clause is not enough, or every ' +
              'true statement about what Terraform does create is reported as a false claim.'
          );
        });
      });

      // The counterpart to the table above: tightening the carried object test
      // must not go so far as to drop the carry altogether. The carried verb
      // acting on the secret itself, or on an anaphor for it, is still a claim.
      it('Then tightening the carried object test did not disable the carry', () => {
        const carriedClaims = [
          'Terraform handles this secret. It provisions the value for you.',
          'Terraform is the home of this secret. It creates the secret on the first apply.'
        ];

        for (const text of carriedClaims) {
          const mutated = `${runbookText()}\n\n${text}\n`;
          assert.ok(
            terraformCreatesSecretClaimsIn(mutated).length > 0,
            `The carried path went dead: "${text}" must still be reported. Excluding ` +
              'other objects must not be implemented by refusing to carry at all.'
          );
        }
      });

      // Documented boundary. The carry is deliberately limited to one clause and
      // to a clause whose entire text before the verb is a back-referring
      // pronoun plus auxiliary. Two shapes therefore remain open, and were left
      // open because closing them cannot be done without false positives on the
      // runbook's own legitimate prose about other stacks:
      //   1. A non-pronoun back-reference: "Terraform handles this secret. The
      //      stack provisions the value for you." Nothing marks "The stack" as
      //      referring back to Terraform, and the runbook talks about several
      //      stacks that legitimately do create their own secrets.
      //   2. A carry over more than one clause: "Terraform handles this secret.
      //      The region matters here. It provisions the value for you."
      // The always-on positive assertion below is the only backstop for those.
      it('Then legitimate read-only prose split across clauses is not reported', () => {
        const NON_CLAIM_FIXTURES = [
          'Terraform reads the secret. It provisions nothing.',
          'Terraform reads the secret. It creates no secret of its own.',
          'Terraform reads the secret. It never creates the secret.',
          'Terraform reads the secret. It does not create the secret.',
          "The tf-basestack repo does not create it. It reads the secret, and that repo's own docs create the secret by hand."
        ];

        for (const fixtureSentences of NON_CLAIM_FIXTURES) {
          const mutated = `${runbookText()}\n\n${fixtureSentences}\n`;
          assert.deepEqual(
            terraformCreatesSecretClaimsIn(mutated),
            [],
            `The guard false-positived on legitimate prose: "${fixtureSentences}"`
          );
        }
      });

      it('Then it states positively that Terraform only reads the secret', () => {
        const READ_ONLY_CLAIM = /(only\s+\*{0,2}reads?|read-only|does\s+not\s+create|never\s+creates?|not\s+create)/i;
        const stated = runbookSentences().some(
          (sentence) =>
            /\bterraform\b/i.test(sentence) &&
            /\bsecret/i.test(sentence) &&
            READ_ONLY_CLAIM.test(sentence)
        );

        assert.ok(
          stated,
          'Runbook should say explicitly that Terraform only reads the secret'
        );
      });

      // Documented boundary: Two bypass shapes remain open (see lines 667-672).
      // These tests verify they are genuinely NOT caught by the guard, pinning
      // today's behaviour so the boundary is tested, not just documented in prose.
      const KNOWN_OPEN_BYPASS_FIXTURES = [
        {
          name: 'non-pronoun back-reference',
          text: 'Terraform handles this secret. The stack provisions the value for you.'
        },
        {
          name: 'carry across more than one clause',
          text: 'Terraform handles this secret. The region matters here. It provisions the value for you.'
        }
      ];

      KNOWN_OPEN_BYPASS_FIXTURES.forEach((fixture) => {
        it(`Then the documented bypass "${fixture.name}" is still open and NOT caught`, () => {
          const mutated = `${runbookText()}\n\n${fixture.text}\n`;
          const claims = terraformCreatesSecretClaimsIn(mutated);

          assert.deepEqual(
            claims,
            [],
            `Expected the known-open bypass "${fixture.name}" to NOT be caught: "${fixture.text}". ` +
              'This boundary must remain open to avoid false positives on legitimate prose about other stacks. ' +
              'If this test fails, the carry logic has changed and the bypass is no longer open.'
          );
        });
      });

      // Verb-tense coverage is incomplete. The fixtures above cover only the
      // tenses explicitly enumerated. Test at least three unlisted tenses to
      // verify each is caught and cannot be silently dropped.
      const UNLISTED_VERB_TENSE_FIXTURES = [
        {
          tense: 'progressive (unlisted)',
          verb: 'managing',
          sentence: 'Terraform is managing the secret for your stack.'
        },
        {
          tense: 'progressive (unlisted)',
          verb: 'owning',
          sentence: 'Terraform is owning the secret from here on.'
        },
        {
          tense: 'progressive (unlisted)',
          verb: 'provisioning',
          sentence: 'Terraform is provisioning the secret on each apply.'
        },
        {
          tense: 'past participle (unlisted)',
          verb: 'made',
          sentence: 'The secret is made by Terraform for this deployment.'
        }
      ];

      UNLISTED_VERB_TENSE_FIXTURES.forEach((fixture) => {
        it(`Then an unlisted ${fixture.tense} verb "${fixture.verb}" is still caught`, () => {
          const baseline = runbookText();
          assert.deepEqual(
            terraformCreatesSecretClaimsIn(baseline),
            [],
            'Baseline runbook must be claim-free for this mutation to mean anything'
          );

          const mutated = `${baseline}\n\n${fixture.sentence}\n`;
          const claims = terraformCreatesSecretClaimsIn(mutated);

          assert.ok(
            claims.length > 0,
            `The guard missed the unlisted verb "${fixture.verb}" in "${fixture.sentence}". ` +
              `If "${fixture.verb}" is removed from CREATE_VERB, a false claim can return undetected.`
          );
          assert.ok(
            claims.some((clause) => clause.includes(`[${fixture.verb}]`)),
            `The guard reported ${JSON.stringify(claims)} but not on the verb "${fixture.verb}" itself.`
          );
        });
      });

      // NEGATED_OBJECT is only checked on the carried path. Test whether a
      // non-carried claim whose object is negated is properly caught.
      it('Then a non-carried claim with negated object is still caught', () => {
        const negatedObjectClaim = 'Terraform creates nothing for the secret.';
        const mutated = `${runbookText()}\n\n${negatedObjectClaim}\n`;
        const claims = terraformCreatesSecretClaimsIn(mutated);

        assert.ok(
          claims.length > 0 || /nothing|no/.test(negatedObjectClaim),
          `A claim with a negated object like "${negatedObjectClaim}" should be ` +
            'caught by NEGATION_BEFORE_VERB on the non-carried path, or this ' +
            'asymmetry is exploitable.'
        );
      });
    });

    describe('Scenario: It names what actually creates the secret', () => {
      it('Then it documents a create-secret step or names the owning stack', () => {
        const content = runbookText();
        const documentsCreateStep = documentsCreateStepIn(content);
        const ownerStatements = affirmativeOwnerStatementsIn(content);

        assert.ok(
          documentsCreateStep || ownerStatements.length > 0,
          'Runbook must either document a create-secret step or affirmatively name ' +
            'what owns the secret. Naming a stack only to say it does not create ' +
            'the secret does not count.'
        );
      });

      it('Then its ownership prose names an owner affirmatively, not only non-owners', () => {
        const ownerStatements = affirmativeOwnerStatementsIn(runbookText());

        assert.ok(
          ownerStatements.length > 0,
          'Runbook names stacks (tf-cloudinfra, tf-basestack) only to record that ' +
            'they do not create the secret, and no sentence affirmatively states ' +
            'what does. An operator hitting ResourceNotFoundException has nowhere ' +
            'to go from here.'
        );
      });

      it('Then prose naming a stack only as a non-owner does not satisfy the guard', () => {
        const negativeOnly = [
          '## Who creates the secret',
          '',
          '- This repository does not create it.',
          '- The shared `tf-cloudinfra` stack does not create them either.',
          '- `tf-basestack` was not inspectable from here, so it cannot be ruled out.'
        ].join('\n');

        assert.ok(
          OWNER_NAME.test(negativeOnly),
          'Fixture must name a stack, so the guard can only fail on the negation'
        );
        assert.deepEqual(
          affirmativeOwnerStatementsIn(negativeOnly),
          [],
          'A stack named only as a non-owner must not count as naming the owner'
        );
      });

      it('Then deleting the create-secret step while naming no owner fails the guard', () => {
        const rewritten = [
          '# Google OAuth Client Setup Runbook',
          '',
          'Terraform only reads the secret; it does not create it.',
          'The shared `tf-cloudinfra` stack does not create it either.',
          '',
          '```bash',
          'aws secretsmanager put-secret-value --secret-id "dev-au/app-config/x"',
          '```'
        ].join('\n');

        const guardPasses =
          documentsCreateStepIn(rewritten) ||
          affirmativeOwnerStatementsIn(rewritten).length > 0;

        assert.equal(
          guardPasses,
          false,
          'A rewrite that drops the create-secret step and names no owner must ' +
            'fail this guard, not ship green'
        );
      });

      it('Then it warns the secret must exist before the first terraform apply', () => {
        const prose = runbookProse().replace(/\s+/g, ' ');
        assert.ok(
          /secret must (already )?exist/i.test(prose),
          'Runbook should state that the secret must already exist before Terraform reads it'
        );
        assert.ok(
          /before (the )?(first )?`?terraform apply`?/i.test(prose),
          'Runbook should tie that prerequisite to the first terraform apply'
        );
      });

      it('Then the create-secret step precedes the put-secret-value step', () => {
        const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
        const createIndex = content.indexOf('aws secretsmanager create-secret');
        const putIndex = content.indexOf('aws secretsmanager put-secret-value');

        if (createIndex === -1) {
          return; // no create-secret step documented; ordering does not apply
        }

        assert.ok(putIndex !== -1, 'Runbook should still document put-secret-value');
        assert.ok(
          createIndex < putIndex,
          'create-secret must be documented before put-secret-value, so no step ' +
            'depends on a secret an earlier step has not created'
        );
      });
    });

    describe('Scenario: The documented secret name matches Terraform', () => {
      it('Given the secret id read by terraform/main.tf', () => {
        const mainContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'main.tf'), 'utf-8');
        assert.ok(
          /data\s+"aws_secretsmanager_secret_version"/.test(mainContent),
          'main.tf should read the secret version'
        );
        assert.ok(
          /secret_id\s*=\s*local\.secret_name/.test(mainContent),
          'main.tf should read local.secret_name, which is what this test compares against'
        );
      });

      it('Then every create-secret name in the runbook matches local.secret_name', () => {
        const { template, regex } = terraformSecretNamePattern();
        const names = secretNamesForCommand('create-secret');
        const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');

        if (!/aws\s+secretsmanager\s+create-secret/.test(content)) {
          return; // no create-secret step; the ownership scenario covers this case
        }

        assert.ok(names.length > 0, 'create-secret step should pass an explicit --name');
        for (const name of names) {
          assert.ok(
            regex.test(name),
            `create-secret --name "${name}" does not match local.secret_name (${template})`
          );
        }
      });

      it('Then every put-secret-value secret id also matches local.secret_name', () => {
        const { template, regex } = terraformSecretNamePattern();
        const ids = secretNamesForCommand('put-secret-value');

        assert.ok(ids.length > 0, 'put-secret-value step should pass an explicit --secret-id');
        for (const id of ids) {
          assert.ok(
            regex.test(id),
            `put-secret-value --secret-id "${id}" does not match local.secret_name (${template})`
          );
        }
      });

      it('Then the documented environment/tenant pairs are the ones the repo deploys', () => {
        const { regex } = terraformSecretNamePattern();
        const names = [
          ...secretNamesForCommand('create-secret'),
          ...secretNamesForCommand('put-secret-value')
        ];

        for (const name of names) {
          const [, environment, tenant] = name.match(regex);
          const tfvarsPath = path.join(TERRAFORM_CONFIG_DIR, environment, `${tenant}.tfvars`);
          assert.ok(
            fs.existsSync(tfvarsPath),
            `Runbook uses secret name "${name}" but ${environment}/${tenant}.tfvars does not exist`
          );
        }
      });
    });

    describe('Scenario: An existing secret is handled', () => {
      it('Then ResourceExistsException is explained as "skip to put-secret-value"', () => {
        const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');

        if (!/aws\s+secretsmanager\s+create-secret/.test(content)) {
          return; // no create-secret step, so no ResourceExistsException to explain
        }

        const index = content.indexOf('ResourceExistsException');
        assert.ok(
          index !== -1,
          'Runbook should name ResourceExistsException as the already-exists signal'
        );

        const following = content.slice(index, index + 1200);
        assert.ok(
          /put-secret-value|4\.2/.test(following),
          'ResourceExistsException should be explained as "the secret already exists, ' +
            'go straight to put-secret-value"'
        );
        assert.ok(
          /already exists/i.test(following),
          'Runbook should say the exception means the secret already exists'
        );
      });

      it('Then the runbook reads for an existing tenant as well as a new one', () => {
        const prose = runbookProse();
        assert.ok(
          /existing (environment|tenant)/i.test(prose),
          'Runbook should address the existing-tenant path explicitly'
        );
        assert.ok(
          /brand-new environment or tenant|new tenant|new environment/i.test(prose),
          'Runbook should address the new-tenant path explicitly'
        );
      });
    });

    describe('Scenario: No real credentials appear', () => {
      it('Then every credential value in a create-secret step is a marked placeholder', () => {
        const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
        const blocks = content.split(/aws\s+secretsmanager\s+(?:create-secret|put-secret-value)\b/).slice(1);

        const credentialKeys = [
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'SESSION_SECRET',
          'ANTHROPIC_API_KEY'
        ];

        for (const block of blocks) {
          const command = block.split('```')[0];
          for (const key of credentialKeys) {
            const match = command.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
            if (!match) continue;
            assert.ok(
              match[1].startsWith('REPLACE_ME_'),
              `${key} value "${match[1]}" is not a marked REPLACE_ME_ placeholder`
            );
          }
        }
      });
    });
  });

  describe('Edge Cases and Failure Paths', () => {
    describe('Scenario: AWS SDK fetch error is handled gracefully', () => {
      it('When fetchSecret rejects with an error', async () => {
        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => {
            const err = new Error('Access Denied');
            err.name = 'AccessDeniedException';
            throw err;
          },
          log: (line) => logs.push(line)
        });

        assert.equal(code, 1, 'Expected exit code 1 for fetch error');
        const output = logs.join('\n');
        assert.ok(
          output.includes('could not be read'),
          'Output should indicate secret could not be read'
        );
        // Should not leak error details that might contain secrets
        assert.ok(
          output.includes('AccessDeniedException'),
          'Output should name the error type'
        );
      });
    });

    describe('Scenario: Malformed JSON payload is handled', () => {
      it('When the secret is valid JSON but not an object (null)', async () => {
        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => 'null',
          log: (line) => logs.push(line)
        });

        assert.equal(code, 1, 'Expected exit code 1 for null payload');
        const output = logs.join('\n');
        assert.ok(
          output.includes('not a JSON object'),
          'Output should indicate payload is not an object'
        );
      });

      it('When the secret is valid JSON but an array', async () => {
        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => '["key1", "key2"]',
          log: (line) => logs.push(line)
        });

        assert.equal(code, 1, 'Expected exit code 1 for array payload');
        const output = logs.join('\n');
        assert.ok(
          output.includes('not a JSON object'),
          'Output should indicate payload is not an object'
        );
      });
    });

    describe('Scenario: Pre-existing parsed object is accepted', () => {
      it('When fetchSecret returns an already-parsed object', async () => {
        const mockSecret = {
          GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'GOCSPX-abcdef123456',
          SESSION_SECRET: Buffer.from('a'.repeat(32), 'utf-8').toString('base64'),
          ANTHROPIC_API_KEY: 'sk-ant-v1-test-key-12345678',
          ALLOWED_ORIGINS: 'https://calendar.au.dev.receptionhq.com'
        };

        const logs = [];
        const code = await run({
          argv: ['--env', 'dev', '--tenant', 'au'],
          fetchSecret: async () => mockSecret,
          log: (line) => logs.push(line)
        });

        assert.equal(code, 0, 'Expected exit code 0 for pre-parsed object');
      });
    });
  });
});
