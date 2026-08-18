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

/** Runbook prose with fenced code blocks removed, so example commands and
 *  pasted AWS error text are never mistaken for a claim the runbook makes. */
function runbookProse() {
  return fs
    .readFileSync(RUNBOOK_PATH, 'utf-8')
    .replace(/```[\s\S]*?```/g, ' ');
}

/** Prose split into rough sentences, newlines collapsed so a claim wrapped
 *  across lines is still examined as one sentence. */
function runbookSentences() {
  return runbookProse()
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Semantic guard: "Terraform creates the secret" must never come back ------
// Rather than matching one exact sentence, every create-flavoured verb in the
// prose is examined in context: does a Terraform subject govern it, is the
// secret its object, and is it negated? A claim only counts as false when a
// Terraform subject creates a secret and nothing negates it.
const CREATE_VERB = /\b(create|creates|created|creating|provision|provisions|provisioned|provisioning|makes?|made|sets? up)\b/gi;
const SUBJECT_WINDOW = 45;
const OBJECT_WINDOW = 70;
const NEGATION_BEFORE_VERB = /\b(not|never|no|nor|neither|without|n't|rather than|instead of)\b(\s+\S+){0,3}\s*$/i;

/** Sentences in the runbook that claim Terraform creates the secret. */
function terraformCreatesSecretClaims() {
  const prose = runbookProse().replace(/\s+/g, ' ');
  const claims = [];

  for (const match of prose.matchAll(CREATE_VERB)) {
    const start = match.index;
    const end = start + match[0].length;

    // `aws secretsmanager create-secret` is a CLI subcommand, not a claim.
    if (/^-secret/.test(prose.slice(end, end + 7))) continue;

    // Restrict to the verb's own clause: stop at sentence/clause punctuation.
    const before = prose.slice(Math.max(0, start - 160), start).split(/[.;:!?]/).pop();
    const after = prose.slice(end, end + 160).split(/[.;:!?]/)[0];

    const governedByTerraform =
      /\bterraform\b/i.test(before.slice(-SUBJECT_WINDOW)) ||
      /\bby\b[^,]{0,25}\bterraform\b/i.test(after.slice(0, SUBJECT_WINDOW));
    if (!governedByTerraform) continue;

    const secretIsTheObject =
      /\bsecrets?\b/i.test(after.slice(0, OBJECT_WINDOW)) ||
      /\bsecrets?\b/i.test(before.slice(-OBJECT_WINDOW));
    if (!secretIsTheObject) continue;

    if (NEGATION_BEFORE_VERB.test(before)) continue;

    claims.push(`${before}[${match[0]}]${after}`.trim());
  }

  return claims;
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
    });

    describe('Scenario: It names what actually creates the secret', () => {
      it('Then it documents a create-secret step or names the owning stack', () => {
        const content = fs.readFileSync(RUNBOOK_PATH, 'utf-8');
        const documentsCreateStep = /aws\s+secretsmanager\s+create-secret/.test(content);
        const namesOwner = /\b(tf-basestack|basestack|tf-cloudinfra|operator-owned|out of band|manual prerequisite)\b/i
          .test(content);

        assert.ok(
          documentsCreateStep || namesOwner,
          'Runbook must either document a create-secret step or name what owns the secret'
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
