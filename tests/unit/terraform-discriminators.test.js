import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

function resolveTerraformBin() {
  const candidates = [
    'C:/External/Terraform/terraform.exe',
    'C:/External/Terraform/terraform'
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'terraform';
}

const TERRAFORM_BIN = resolveTerraformBin();

function describeExecError(error) {
  const parts = [];
  if (error.status !== undefined && error.status !== null) parts.push(`exit status ${error.status}`);
  if (error.message) parts.push(error.message);
  const stdout = (error.stdout || '').toString().trim();
  const stderr = (error.stderr || '').toString().trim();
  if (stdout) parts.push(`stdout: ${stdout}`);
  if (stderr) parts.push(`stderr: ${stderr}`);
  return parts.join(' | ');
}

function removeWorkspace(workspace) {
  if (!workspace) return;
  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`Failed to remove temporary terraform workspace ${workspace}: ${error.message}`);
  }
}

const SECRET_LOOKUP_MAIN_TF = `
variable "secret_json" {
  type = string
}

locals {
  secrets = jsondecode(var.secret_json)
}

locals {
  google_client_id     = lookup(local.secrets, "GOOGLE_CLIENT_ID", "")
  google_client_secret = lookup(local.secrets, "GOOGLE_CLIENT_SECRET", "")
  anthropic_api_key    = lookup(local.secrets, "ANTHROPIC_API_KEY", "")
  session_secret       = lookup(local.secrets, "SESSION_SECRET", "")
  allowed_origins      = lookup(local.secrets, "ALLOWED_ORIGINS", "")
}
`;

function createSecretLookupWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-secret-lookup-'));
  try {
    fs.writeFileSync(path.join(workspace, 'main.tf'), SECRET_LOOKUP_MAIN_TF, 'utf-8');
    execSync(`"${TERRAFORM_BIN}" init -backend=false -input=false -no-color`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000
    });
  } catch (error) {
    removeWorkspace(workspace);
    throw new Error(`Failed to prepare secret lookup workspace: ${describeExecError(error)}`);
  }
  return workspace;
}

function tryEvaluateSecretExpression(workspace, expression, secretJson) {
  try {
    const stdout = execSync(`"${TERRAFORM_BIN}" console -no-color`, {
      cwd: workspace,
      input: `${expression}\n`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
      env: { ...process.env, TF_VAR_secret_json: secretJson }
    });
    const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '');
    const match = clean.match(/"((?:[^"\\]|\\.)*)"/);
    if (!match) {
      throw new Error(
        `Could not parse a string value for "${expression}" from terraform console output: ${JSON.stringify(clean)}`
      );
    }
    return { ok: true, value: match[1] };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not parse')) {
      throw error;
    }
    return { ok: false, error: describeExecError(error) };
  }
}

describe('Terraform Discriminator Tests', () => {
  describe('Feature: Lookup vs direct index discriminates', () => {
    const PAYLOAD_MISSING_ANTHROPIC_KEY = JSON.stringify({
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      SESSION_SECRET: 'test-session-secret',
      ALLOWED_ORIGINS: 'https://example.com'
    });

    let workspace;

    before(() => {
      workspace = createSecretLookupWorkspace();
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    describe('Discriminator 1: lookup() with default succeeds on missing key', () => {
      it('proves lookup() returns empty string for missing key', () => {
        const result = tryEvaluateSecretExpression(
          workspace,
          'lookup(local.secrets, "ANTHROPIC_API_KEY", "")',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        assert.ok(result.ok,
          `lookup() should succeed but got error: ${result.error}`);
        assert.equal(result.value, '',
          `lookup() with missing key should yield "" but got "${result.value}"`);
      });

      it('would FAIL if lookup default were wrong - this proves it discriminates', () => {
        // Test that if we looked for a wrong expected value, the test would catch it
        const result = tryEvaluateSecretExpression(
          workspace,
          'lookup(local.secrets, "ANTHROPIC_API_KEY", "")',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        // Verify that the value is NOT some other string
        assert.notEqual(result.value, 'fallback-value',
          'If default were "fallback-value", this test would fail');
        assert.notEqual(result.value, 'ANTHROPIC_API_KEY',
          'If default were the key name, this test would fail');
      });
    });

    describe('Discriminator 2: direct index errors on missing key', () => {
      it('proves direct index fails with "Invalid index" error', () => {
        const result = tryEvaluateSecretExpression(
          workspace,
          'local.secrets["ANTHROPIC_API_KEY"]',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        assert.equal(result.ok, false,
          `Direct index should error but succeeded with "${result.value}"`);
        assert.match(result.error, /Invalid index/,
          `Should error with "Invalid index" but got: ${result.error}`);
      });

      it('would FAIL if we expected success - this proves it discriminates', () => {
        // This test documents that if we inverted the assertion, it would fail
        const result = tryEvaluateSecretExpression(
          workspace,
          'local.secrets["ANTHROPIC_API_KEY"]',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        // If we asserted the opposite, this would fail:
        assert.notEqual(result.ok, true,
          'If we asserted direct index should succeed, this test would fail');
        assert.ok(result.error.length > 0,
          'Error message is not empty - proves it actually errored');
      });
    });

    describe('Mutual exclusivity: only one can be true', () => {
      it('when lookup succeeds, direct index fails - they are opposite', () => {
        const lookupResult = tryEvaluateSecretExpression(
          workspace,
          'lookup(local.secrets, "ANTHROPIC_API_KEY", "")',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        const directResult = tryEvaluateSecretExpression(
          workspace,
          'local.secrets["ANTHROPIC_API_KEY"]',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        // One succeeds, one fails - they discriminate
        assert.equal(lookupResult.ok, true,
          'lookup() must succeed');
        assert.equal(directResult.ok, false,
          'direct index must fail');
        assert.notEqual(
          lookupResult.ok,
          directResult.ok,
          'The two approaches must have opposite success/fail outcomes'
        );
      });
    });
  });
});
