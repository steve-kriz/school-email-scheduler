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
const TERRAFORM_CONFIG_DIR = path.join(PROJECT_ROOT, 'terraform', 'config');

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
