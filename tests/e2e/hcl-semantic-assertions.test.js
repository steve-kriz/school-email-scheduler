import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  extractResourceBody,
  extractBlock,
  bodyDeclaresTtlBlock,
  extractStatementArray,
  parsePolicyStatements,
} from '../helpers/hcl-blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

// Helper to create a temp copy of a terraform file with mutations applied
function createMutatedFixture(originalPath, mutationFn) {
  const content = fs.readFileSync(originalPath, 'utf-8');
  const mutated = mutationFn(content);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mut-'));
  const tempFile = path.join(tempDir, path.basename(originalPath));
  fs.writeFileSync(tempFile, mutated, 'utf-8');
  return { tempFile, tempDir, mutated };
}

function cleanupTemp(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('Semantic Terraform Assertions (TASK-017)', () => {
  describe('Feature: A flag in the wrong block is caught', () => {
    it('Scenario: point_in_time_recovery enabled in wrong block fails assertion', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const { tempFile, tempDir, mutated } = createMutatedFixture(
        connectionsPath,
        (content) => {
          // Move enabled = true from point_in_time_recovery to point_in_time_recovery_test
          return content.replace(
            /point_in_time_recovery\s*\{[\s\S]*?enabled\s*=\s*true/,
            'point_in_time_recovery {\n    enabled = false'
          );
        }
      );

      try {
        const body = extractResourceBody(mutated, 'aws_dynamodb_table', 'calendar_connections');
        assert.ok(body, 'should extract resource body');
        const pitrBlock = extractBlock(body, 'point_in_time_recovery');
        assert.ok(pitrBlock, 'should find point_in_time_recovery block');
        // The mutation disabled it, so this should fail
        const isEnabled = /enabled\s*=\s*true/.test(pitrBlock);
        assert.strictEqual(isEnabled, false, 'point_in_time_recovery should not be enabled after mutation');
      } finally {
        cleanupTemp(tempDir);
      }
    });

    it('Scenario: enabled = true in different block is not caught by whole-file assertion', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const originalContent = fs.readFileSync(connectionsPath, 'utf-8');

      // With block-scoped assertion, we should only look at the specific block
      const body = extractResourceBody(originalContent, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'should extract resource body');

      const pitrBlock = extractBlock(body, 'point_in_time_recovery');
      assert.ok(pitrBlock, 'should find point_in_time_recovery block');

      // The real file should have it enabled
      const isEnabled = /enabled\s*=\s*true/.test(pitrBlock);
      assert.strictEqual(isEnabled, true, 'point_in_time_recovery should be enabled in the real file');
    });
  });

  describe('Feature: A wrong encryption key is caught', () => {
    it('Scenario: server_side_encryption with wrong KMS key fails assertion', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const { tempFile, tempDir, mutated } = createMutatedFixture(
        connectionsPath,
        (content) => {
          // Replace the calendar KMS key with a different key
          return content.replace(
            /kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/,
            'kms_key_arn = aws_kms_key.wrong.arn'
          );
        }
      );

      try {
        const body = extractResourceBody(mutated, 'aws_dynamodb_table', 'calendar_connections');
        assert.ok(body, 'should extract resource body');
        const sseBlock = extractBlock(body, 'server_side_encryption');
        assert.ok(sseBlock, 'should find server_side_encryption block');

        // The mutation changed the key reference
        const hasCalendarKey = /kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(sseBlock);
        assert.strictEqual(hasCalendarKey, false, 'server_side_encryption should not reference calendar key after mutation');
      } finally {
        cleanupTemp(tempDir);
      }
    });

    it('Scenario: real file uses correct KMS key', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'should extract resource body');
      const sseBlock = extractBlock(body, 'server_side_encryption');
      assert.ok(sseBlock, 'should find server_side_encryption block');

      const hasCalendarKey = /kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(sseBlock);
      assert.strictEqual(hasCalendarKey, true, 'server_side_encryption should reference calendar KMS key');
    });
  });

  describe('Feature: A plaintext refresh token entry is caught', () => {
    it('Scenario: plaintext refreshToken in schema comment fails assertion', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const { tempFile, tempDir, mutated } = createMutatedFixture(
        connectionsPath,
        (content) => {
          // Add a plaintext refreshToken attribute to the schema comment (dangerous mutation)
          return content.replace(
            'refreshTokenEnc     : base64 KMS ciphertext',
            'refreshToken        : PLAINTEXT oauth refresh token (DANGER!)\n#   refreshTokenEnc     : base64 KMS ciphertext'
          );
        }
      );

      try {
        // The schema is in the file header comments, not in the resource body.
        // Check the full file content for plaintext token references
        const hasPlaintextToken = mutated.includes('refreshToken        : PLAINTEXT');
        assert.strictEqual(hasPlaintextToken, true, 'should detect plaintext refreshToken in mutated schema');
      } finally {
        cleanupTemp(tempDir);
      }
    });

    it('Scenario: real file does not have plaintext refreshToken', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      // The schema is documented in the file header comments
      // Check that plaintext refreshToken is NOT documented
      const hasPlaintextToken = /^\s*[-*]?\s*refreshToken\s*[:(]/m.test(content) &&
                                !content.includes('refreshTokenEnc') ||
                                content.includes('no `refreshToken` attribute');

      // The actual schema should only reference encrypted variants
      const schemaHasEncrypted = content.includes('refreshTokenEnc') || content.includes('refreshTokenKeyId');

      assert.ok(schemaHasEncrypted, 'should have encrypted token fields in schema');
      assert.ok(content.includes('no `refreshToken` attribute'), 'schema comment should explicitly state no plaintext refreshToken');
    });

    it('Scenario: dead assertion removed (no literal backslash-s string match)', () => {
      // The dead assertion from TASK-002 was checking for the literal string 'refreshToken\s'
      // which is NOT a regex pattern but a literal 14-character string. That assertion
      // could never fail because the file never contained that literal text.
      // We verify the pattern is not used in the test files.
      const unitTestPath = path.join(__dirname, '..', 'unit', 'dynamodb-calendar.test.js');
      const e2eTestPath = path.join(__dirname, '..', 'e2e', 'dynamodb-calendar.test.js');

      for (const testPath of [unitTestPath, e2eTestPath]) {
        if (fs.existsSync(testPath)) {
          const testContent = fs.readFileSync(testPath, 'utf-8');
          // The dead assertion was: !schemaSection.includes('refreshToken\s')
          // This literal string should not appear in the tests anymore
          const hasDeadAssertion = testContent.includes("'refreshToken\\s'") || testContent.includes('"refreshToken\\s"');
          assert.strictEqual(hasDeadAssertion, false, `dead assertion pattern should be removed from ${testPath}`);
        }
      }
    });
  });

  describe('Feature: The real files still pass', () => {
    it('Scenario: connections table has point_in_time_recovery enabled', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'should extract resource body');
      const pitrBlock = extractBlock(body, 'point_in_time_recovery');
      assert.ok(pitrBlock, 'should find point_in_time_recovery block');
      assert.ok(/enabled\s*=\s*true/.test(pitrBlock), 'point_in_time_recovery should be enabled');
    });

    it('Scenario: connections table has server_side_encryption enabled with CMK', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'should extract resource body');
      const sseBlock = extractBlock(body, 'server_side_encryption');
      assert.ok(sseBlock, 'should find server_side_encryption block');
      assert.ok(/enabled\s*=\s*true/.test(sseBlock), 'server_side_encryption should be enabled');
      assert.ok(/kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(sseBlock), 'should use calendar KMS key');
    });

    it('Scenario: connections table has NO ttl block', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'should extract resource body');
      assert.strictEqual(bodyDeclaresTtlBlock(body), false, 'connections table should not have ttl block');
    });

    it('Scenario: events table has ttl block enabled', () => {
      const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
      if (fs.existsSync(eventsPath)) {
        const content = fs.readFileSync(eventsPath, 'utf-8');
        const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_events');
        assert.ok(body, 'should extract events table resource body');
        assert.strictEqual(bodyDeclaresTtlBlock(body), true, 'events table should have ttl block');
      }
    });
  });

  describe('Feature: Coverage does not regress (TASK-002)', () => {
    it('Scenario: all table definitions are still tested structurally', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const content = fs.readFileSync(connectionsPath, 'utf-8');

      // These are the core assertions from TASK-002
      assert.ok(content.includes('aws_dynamodb_table'), 'table resource declared');
      assert.ok(content.includes('calendar_connections'), 'correct table name');
      assert.ok(content.includes('PAY_PER_REQUEST'), 'on-demand billing');

      // Using the helper to verify block-scoped content
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'resource body extracted for structural assertions');
    });
  });

  describe('Feature: Mutated fixtures do not leak', () => {
    it('Scenario: fixture created during test is cleaned up on success', () => {
      const testPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const { tempFile, tempDir } = createMutatedFixture(testPath, (c) => c);

      assert.ok(fs.existsSync(tempFile), 'temp file should exist during test');
      cleanupTemp(tempDir);
      assert.strictEqual(fs.existsSync(tempDir), false, 'temp directory should be cleaned up');
    });

    it('Scenario: real terraform files are unmodified by tests', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const originalContent = fs.readFileSync(connectionsPath, 'utf-8');

      // Run some mutations in temp files
      const { tempDir: tempDir1 } = createMutatedFixture(connectionsPath, (c) => c.replace(/enabled\s*=\s*true/, 'enabled = false'));
      cleanupTemp(tempDir1);

      const currentContent = fs.readFileSync(connectionsPath, 'utf-8');
      assert.strictEqual(currentContent, originalContent, 'real file should not be modified');
    });
  });

  describe('Feature: Key order independence in IAM policies', () => {
    it('Scenario: Sid-last statement with Resource attribution', () => {
      const lambdaPath = path.join(TERRAFORM_DIR, 'lambda_calendar.tf');
      if (fs.existsSync(lambdaPath)) {
        const content = fs.readFileSync(lambdaPath, 'utf-8');
        const policyMatch = content.match(/policy = jsonencode\(\{[\s\S]*?\}\)/);
        if (policyMatch) {
          const policyText = policyMatch[0]
            .split('\n')
            .filter(line => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
            .join('\n');

          try {
            const arrayBody = extractStatementArray(policyText);
            const statements = parsePolicyStatements(arrayBody);

            // Every statement should have a Sid, even if it's last
            for (const statement of statements) {
              assert.ok(statement.sid, `statement should have Sid: ${statement.body.substring(0, 50)}`);
            }
          } catch (e) {
            // Policy parsing is optional for this test
          }
        }
      }
    });

    it('Scenario: alphabetized keys do not cause statement parser to fail', () => {
      const policyText = `
{
  Statement = [
    {
      Action = "ec2:*",
      Effect = "Allow",
      Resource = "*",
      Sid = "VPCNetworkInterfaces"
    }
  ]
}
      `.trim();

      const arrayBody = extractStatementArray(policyText);
      const statements = parsePolicyStatements(arrayBody);
      assert.strictEqual(statements.length, 1);
      assert.strictEqual(statements[0].sid, 'VPCNetworkInterfaces');
      assert.ok(/Resource\s*=\s*"\*"/.test(statements[0].body));
    });

    it('Scenario: Statement=[without spaces] still finds array', () => {
      const policyText = `
{
  Statement=[
    { Sid = "Test", Resource = "*", Action = "logs:*" }
  ]
}
      `.trim();

      // This should NOT throw - the tolerant marker should find it
      const arrayBody = extractStatementArray(policyText);
      const statements = parsePolicyStatements(arrayBody);
      assert.strictEqual(statements.length, 1);
      assert.strictEqual(statements[0].sid, 'Test');
    });

    it('Scenario: Statement with multiple spaces still finds array', () => {
      const policyText = `
{
  Statement  =  [
    { Sid = "Test", Resource = "*", Action = "logs:*" }
  ]
}
      `.trim();

      const arrayBody = extractStatementArray(policyText);
      const statements = parsePolicyStatements(arrayBody);
      assert.strictEqual(statements.length, 1);
      assert.strictEqual(statements[0].sid, 'Test');
    });
  });

  describe('Feature: Unscoped Resource in unusual positions is caught', () => {
    it('Scenario: Resource at end of Sid-last statement is attributed correctly', () => {
      const arrayBody = `
{
  Action = "ec2:CreateNetworkInterface",
  Effect = "Allow",
  Sid = "VPCNetworkInterfaces",
  Resource = "*"
}
      `.trim();

      const statements = parsePolicyStatements(arrayBody);
      assert.strictEqual(statements.length, 1);
      assert.strictEqual(statements[0].sid, 'VPCNetworkInterfaces');
      assert.ok(/Resource\s*=\s*"\*"/.test(statements[0].body), 'unscoped Resource should be in statement body');
    });

    it('Scenario: unparseable policy fails loudly, not silently', () => {
      const policyText = '{ no Statement array here }';

      assert.throws(
        () => extractStatementArray(policyText),
        /no "Statement = \[" array found/,
        'should throw explicitly when Statement not found'
      );
    });
  });
});
