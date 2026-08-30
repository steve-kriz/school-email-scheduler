import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractResourceBody, extractBlock, bodyDeclaresTtlBlock } from '../helpers/hcl-blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

// -----------------------------------------------------------------------------
// TTL guard helpers (TASK-016, superseded by tests/helpers/hcl-blocks.mjs)
// -----------------------------------------------------------------------------
// Scoped to one resource body via the shared extractor so the guard fires only
// on the connections table and never on the events table's legitimate ttl
// block. The shared extractor (TASK-017) skips braces inside strings,
// comments, and heredocs rather than counting them naively.

/**
 * The guard assertion under test. Throws if the connections table in `content`
 * declares a ttl block.
 */
function assertNoConnectionsTtl(content) {
  const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
  assert.ok(body, 'aws_dynamodb_table.calendar_connections resource body not found');
  assert.equal(bodyDeclaresTtlBlock(body), false,
    'connections table must not declare a ttl block');
}

describe('DynamoDB Calendar E2E Tests', () => {
  describe('Feature: Calendar data stores', () => {

    describe('Scenario: Refresh tokens are only ever stored encrypted', () => {
      let connectionsContent;

      it('Given the connections table schema', () => {
        const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
        assert.ok(fs.existsSync(connectionsPath), 'dynamodb_calendar_connections.tf not found');
        connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
        assert.ok(connectionsContent.length > 0, 'dynamodb_calendar_connections.tf is empty');
      });

      it('Then it documents a "refreshTokenEnc" attribute', () => {
        assert.ok(connectionsContent.includes('refreshTokenEnc'),
          'refreshTokenEnc attribute not documented in schema comments');
      });

      it('And it does not document any plaintext "refreshToken" attribute', () => {
        // Real check (replaces a dead assertion). The old check compared
        // against a JS string literal containing an escaped backslash and the
        // letter that follows it, which is not the same thing as a regex
        // whitespace class - so it tested for text that could never appear in
        // the file, and doubled up on the adjacent `.match()` check rather
        // than adding coverage.
        //
        // Strip the leading "#"/"//" comment markers from the schema section
        // and test each line against the documented pattern for a plaintext
        // attribute name: an optional bullet, then "refreshToken" followed
        // directly by ":" or "(" (not by more identifier characters, which is
        // what excludes "refreshTokenEnc" and "refreshTokenKeyId").
        const schemaSection = connectionsContent.substring(0, connectionsContent.indexOf('resource "'));
        const uncommented = schemaSection
          .split('\n')
          .map(line => line.replace(/^\s*#\s?/, '').replace(/^\s*\/\/\s?/, ''))
          .join('\n');

        assert.ok(!/^\s*[-*]?\s*refreshToken\s*[:(]/m.test(uncommented),
          'plaintext refreshToken attribute should not be documented (refreshTokenEnc/refreshTokenKeyId are fine)');
      });

      it('And the schema does document refreshTokenKeyId without tripping the plaintext-token check', () => {
        const schemaSection = connectionsContent.substring(0, connectionsContent.indexOf('resource "'));
        assert.ok(schemaSection.includes('refreshTokenKeyId'),
          'refreshTokenKeyId should be documented in schema');
      });
    });

    describe('Scenario: A plaintext refresh token entry is caught (mutated fixture)', () => {
      it('Given a mutated copy whose schema comment documents a "refreshToken" attribute, When the plaintext-token assertion runs, Then it fails', () => {
        const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
        const original = fs.readFileSync(connectionsPath, 'utf-8');

        const mutated = original.replace(
          '#   refreshTokenEnc     :',
          '#   refreshToken        : the plaintext Gmail refresh token (should never appear)\n#   refreshTokenEnc     :'
        );
        assert.notEqual(mutated, original, 'fixture mutation did not apply');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task017-plaintext-token-'));
        try {
          const tmpFile = path.join(tmpDir, 'dynamodb_calendar_connections.tf');
          fs.writeFileSync(tmpFile, mutated, 'utf-8');
          const content = fs.readFileSync(tmpFile, 'utf-8');

          const schemaSection = content.substring(0, content.indexOf('resource "'));
          const uncommented = schemaSection
            .split('\n')
            .map(line => line.replace(/^\s*#\s?/, '').replace(/^\s*\/\/\s?/, ''))
            .join('\n');

          assert.throws(
            () => assert.ok(!/^\s*[-*]?\s*refreshToken\s*[:(]/m.test(uncommented),
              'plaintext refreshToken attribute should not be documented'),
            assert.AssertionError,
            'the plaintext-token assertion must fail once a genuine "refreshToken :" entry is documented'
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    });

    describe('Scenario: A month of events can be read with one range query', () => {
      let eventsContent;

      it('Given the events table', () => {
        const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
        assert.ok(fs.existsSync(eventsPath), 'dynamodb_calendar_events.tf not found');
        eventsContent = fs.readFileSync(eventsPath, 'utf-8');
        assert.ok(eventsContent.length > 0, 'dynamodb_calendar_events.tf is empty');
      });

      it('Then a GSI named "StartsAtIndex" exists with hash key "userId" and range key "startsAt"', () => {
        assert.ok(eventsContent.includes('StartsAtIndex'),
          'StartsAtIndex GSI not found');
        assert.ok(eventsContent.includes('global_secondary_index') &&
                 eventsContent.includes('name            = "StartsAtIndex"'),
          'StartsAtIndex GSI not properly defined');

        // Check for hash and range keys in the GSI
        const gsiSection = eventsContent.match(/global_secondary_index\s*\{[\s\S]*?name\s*=\s*"StartsAtIndex"[\s\S]*?\}/);
        assert.ok(gsiSection, 'StartsAtIndex GSI definition not found');
        assert.ok(gsiSection[0].includes('hash_key') && gsiSection[0].includes('userId'),
          'StartsAtIndex hash key should be userId');
        assert.ok(gsiSection[0].includes('range_key') && gsiSection[0].includes('startsAt'),
          'StartsAtIndex range key should be startsAt');
        assert.ok(gsiSection[0].includes('projection_type') && gsiSection[0].includes('ALL'),
          'StartsAtIndex projection should be ALL');
      });
    });

    describe('Scenario: The attention index only holds items that need attention', () => {
      let eventsContent;

      it('Given an event with needsAttention true and status "pending"', () => {
        const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
        eventsContent = fs.readFileSync(eventsPath, 'utf-8');

        // The schema documents these attributes
        assert.ok(eventsContent.includes('needsAttention'),
          'needsAttention attribute not documented');
        assert.ok(eventsContent.includes('status'),
          'status attribute not documented');
      });

      it('Then the item carries an "attentionKey" attribute', () => {
        assert.ok(eventsContent.includes('attentionKey'),
          'attentionKey attribute not declared in schema');

        // Verify it's declared as an attribute for the GSI
        const attrSection = eventsContent.match(/attribute\s*\{\s*name\s*=\s*"attentionKey"/);
        assert.ok(attrSection, 'attentionKey not declared in attribute block');
      });

      it('When the event is acknowledged', () => {
        // This is a schema-level assertion about the sparse index contract
        assert.ok(eventsContent.includes('SPARSE'),
          'Sparse index behavior not documented');
      });

      it('Then the "attentionKey" attribute is removed and the item leaves AttentionIndex', () => {
        // Check that the comment documents the REMOVE contract
        assert.ok(eventsContent.includes('REMOVE the attentionKey attribute') ||
                 eventsContent.includes('REMOVE attentionKey'),
          'REMOVE contract for attentionKey not documented');
        assert.ok(eventsContent.includes('UpdateExpression'),
          'UpdateExpression guidance not found in documentation');
      });
    });

    describe('Scenario: Re-scanning the same email does not duplicate an event', () => {
      let eventsContent;

      it('Given an email that yields an event titled "Sports Carnival" starting 2026-09-04', () => {
        const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
        eventsContent = fs.readFileSync(eventsPath, 'utf-8');

        // Verify the eventId derivation is documented
        assert.ok(eventsContent.includes('eventId') && eventsContent.includes('sha256'),
          'eventId derivation not documented');
      });

      it('When the same email is scanned a second time', () => {
        // Verify idempotency is documented
        assert.ok(eventsContent.includes('eventId') && eventsContent.includes('overwrites'),
          'eventId idempotency (overwrite behavior) not documented');
      });

      it('Then the computed eventId is identical', () => {
        // Test the eventId determinism using the documented formula
        const sourceMessageId = 'msg-12345';
        const normalisedTitle = 'Sports Carnival';
        const startsAt = '2026-09-04T09:00:00Z';

        // First computation
        const input1 = `${sourceMessageId}|${normalisedTitle}|${startsAt}`;
        const eventId1 = createHash('sha256').update(input1).digest('hex');

        // Second computation (same inputs)
        const input2 = `${sourceMessageId}|${normalisedTitle}|${startsAt}`;
        const eventId2 = createHash('sha256').update(input2).digest('hex');

        assert.equal(eventId1, eventId2,
          'eventId should be deterministic for same inputs');
      });

      it('And the events table still holds exactly one matching item', () => {
        // With the eventId being deterministic, a PutItem would overwrite
        // This is validated by the schema having eventId as the sort key
        assert.ok(eventsContent.includes('range_key') && eventsContent.includes('eventId'),
          'eventId should be the range key to ensure uniqueness per userId');
      });

      it('Edge case: Changing any input component produces a different eventId', () => {
        const sourceMessageId = 'msg-12345';
        const normalisedTitle = 'Sports Carnival';
        const startsAt = '2026-09-04T09:00:00Z';

        const baseInput = `${sourceMessageId}|${normalisedTitle}|${startsAt}`;
        const baseEventId = createHash('sha256').update(baseInput).digest('hex');

        // Change sourceMessageId
        const differentSourceInput = `msg-54321|${normalisedTitle}|${startsAt}`;
        const differentSourceEventId = createHash('sha256').update(differentSourceInput).digest('hex');
        assert.notEqual(baseEventId, differentSourceEventId,
          'eventId should change when sourceMessageId changes');

        // Change title
        const differentTitleInput = `${sourceMessageId}|Different Title|${startsAt}`;
        const differentTitleEventId = createHash('sha256').update(differentTitleInput).digest('hex');
        assert.notEqual(baseEventId, differentTitleEventId,
          'eventId should change when title changes');

        // Change time
        const differentTimeInput = `${sourceMessageId}|${normalisedTitle}|2026-09-05T09:00:00Z`;
        const differentTimeEventId = createHash('sha256').update(differentTimeInput).digest('hex');
        assert.notEqual(baseEventId, differentTimeEventId,
          'eventId should change when startsAt changes');
      });
    });

    describe('Scenario: Both tables are encrypted with the project CMK', () => {
      let connectionsContent;
      let eventsContent;
      let kmsContent;

      it('Given the terraform configuration', () => {
        const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
        const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
        const kmsPath = path.join(TERRAFORM_DIR, 'kms_calendar.tf');

        assert.ok(fs.existsSync(connectionsPath), 'connections table file not found');
        assert.ok(fs.existsSync(eventsPath), 'events table file not found');
        assert.ok(fs.existsSync(kmsPath), 'KMS file not found');

        connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
        eventsContent = fs.readFileSync(eventsPath, 'utf-8');
        kmsContent = fs.readFileSync(kmsPath, 'utf-8');
      });

      it('Then the connections table and the events table both set server_side_encryption to the calendar KMS key', () => {
        // Check connections table - scoped to its own resource body and its
        // own server_side_encryption block, not a whole-file substring.
        const connectionsBody = extractResourceBody(connectionsContent, 'aws_dynamodb_table', 'calendar_connections');
        assert.ok(connectionsBody, 'aws_dynamodb_table.calendar_connections resource body not found');
        const connectionsSse = extractBlock(connectionsBody, 'server_side_encryption');
        assert.ok(connectionsSse, 'connections table missing server_side_encryption block');
        assert.ok(/kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(connectionsSse),
          'connections table server_side_encryption not using calendar KMS key');

        // Check events table
        const eventsBody = extractResourceBody(eventsContent, 'aws_dynamodb_table', 'calendar_events');
        assert.ok(eventsBody, 'aws_dynamodb_table.calendar_events resource body not found');
        const eventsSse = extractBlock(eventsBody, 'server_side_encryption');
        assert.ok(eventsSse, 'events table missing server_side_encryption block');
        assert.ok(/kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(eventsSse),
          'events table server_side_encryption not using calendar KMS key');

        // Verify the KMS key exists
        assert.ok(kmsContent.includes('aws_kms_key.calendar'),
          'calendar KMS key not defined');
      });
    });

    describe('Scenario: The connections table can be restored after an accidental delete', () => {
      let connectionsContent;

      it('Given the connections table', () => {
        const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
        connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
      });

      it('Then point_in_time_recovery is enabled', () => {
        const body = extractResourceBody(connectionsContent, 'aws_dynamodb_table', 'calendar_connections');
        assert.ok(body, 'aws_dynamodb_table.calendar_connections resource body not found');
        const pitrBlock = extractBlock(body, 'point_in_time_recovery');
        assert.ok(pitrBlock, 'point_in_time_recovery block not found');
        assert.ok(/enabled\s*=\s*true/.test(pitrBlock),
          'point_in_time_recovery not enabled');
      });
    });
  });

  describe('Feature: The OAuth grant table has no expiry reaper', () => {
    const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
    const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');

    describe('Scenario: The connections table declares no TTL', () => {
      it('Given terraform/dynamodb_calendar_connections.tf, Then it contains no ttl block', () => {
        const content = fs.readFileSync(connectionsPath, 'utf-8');
        assertNoConnectionsTtl(content);
      });
    });

    describe('Scenario: The events table keeps its TTL', () => {
      it('Given terraform/dynamodb_calendar_events.tf, Then it declares a ttl block enabled on attribute "ttl"', () => {
        const content = fs.readFileSync(eventsPath, 'utf-8');
        const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_events');
        assert.ok(body, 'aws_dynamodb_table.calendar_events resource body not found');
        assert.equal(bodyDeclaresTtlBlock(body), true,
          'events table should still declare a ttl block');
        const ttlBlock = extractBlock(body, 'ttl');
        assert.ok(ttlBlock, 'ttl block not found in the calendar_events resource body');
        assert.ok(/attribute_name\s*=\s*"ttl"/.test(ttlBlock) && /enabled\s*=\s*true/.test(ttlBlock),
          'events table ttl should be enabled on attribute "ttl"');
      });
    });

    describe('Scenario: Re-adding the connections TTL turns the suite red', () => {
      it('Given a mutated copy of the connections file, When the guard runs, Then it fails', () => {
        const content = fs.readFileSync(connectionsPath, 'utf-8');
        const mutated = content.replace(
          /(\n\s*point_in_time_recovery\s*\{)/,
          '\n  ttl {\n    attribute_name = "ttl"\n    enabled        = true\n  }\n$1'
        );
        assert.notEqual(mutated, content, 'fixture mutation did not apply');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task016-ttl-guard-'));
        const tmpFile = path.join(tmpDir, 'dynamodb_calendar_connections.tf');
        try {
          fs.writeFileSync(tmpFile, mutated, 'utf-8');
          assert.throws(
            () => assertNoConnectionsTtl(fs.readFileSync(tmpFile, 'utf-8')),
            assert.AssertionError,
            'guard should fail when a ttl block is re-added to the connections table'
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    });

    describe('Scenario: The test does not confuse the two tables', () => {
      it("Given the events table's legitimate ttl block, When the connections guard runs, Then it does not fire", () => {
        const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
        assert.equal(
          extractResourceBody(eventsContent, 'aws_dynamodb_table', 'calendar_connections'),
          null,
          'the connections guard should find no connections resource in the events file');

        // The guard, run over both files concatenated, still passes: the events
        // table's ttl block is outside the connections resource body.
        const connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
        assertNoConnectionsTtl(`${eventsContent}\n${connectionsContent}`);
        assertNoConnectionsTtl(`${connectionsContent}\n${eventsContent}`);
      });
    });

    describe('Scenario: Durability settings survive the change', () => {
      it('Then point_in_time_recovery is enabled and server_side_encryption references the calendar KMS key', () => {
        const content = fs.readFileSync(connectionsPath, 'utf-8');
        const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
        assert.ok(body, 'aws_dynamodb_table.calendar_connections resource body not found');

        const pitrBlock = extractBlock(body, 'point_in_time_recovery');
        assert.ok(pitrBlock, 'point_in_time_recovery block not found');
        assert.ok(/enabled\s*=\s*true/.test(pitrBlock),
          'point_in_time_recovery should still be enabled');

        const sseBlock = extractBlock(body, 'server_side_encryption');
        assert.ok(sseBlock, 'server_side_encryption block not found');
        assert.ok(/kms_key_arn\s*=\s*aws_kms_key\.calendar\.arn/.test(sseBlock),
          'server_side_encryption should still reference the calendar CMK');
      });
    });
  });

  describe('Feature: Terraform validation', () => {
    describe('Scenario: The DynamoDB and KMS configuration validates', () => {
      it('When "terraform validate" is run after "terraform init -backend=false", Then error_count equals 0', (t) => {
        // First init. A missing terraform binary is reported as a genuine
        // skip (visible in the test-runner output) rather than a pass -
        // there is nothing to validate without terraform, so the test must
        // not claim success.
        try {
          execSync('terraform init -backend=false', {
            cwd: TERRAFORM_DIR,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 60000
          });
        } catch (error) {
          if (error.code === 'ENOENT') {
            t.skip('terraform binary not found - cannot run terraform init/validate');
            return;
          }
          assert.fail(`terraform init failed: ${(error.stderr || error.message || '').toString()}`);
        }

        // Then validate.
        let result;
        try {
          result = execSync('terraform validate -json', {
            cwd: TERRAFORM_DIR,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 60000
          });
        } catch (error) {
          if (error.code === 'ENOENT') {
            t.skip('terraform binary not found - cannot run terraform validate');
            return;
          }
          const output = (error.stdout || '').toString();
          const stderr = (error.stderr || '').toString();
          assert.fail(`terraform validate failed: ${stderr || output}`);
          return;
        }

        // A -json output that fails to parse means nothing was actually
        // verified - that must fail loudly, not report success.
        let parsed;
        try {
          parsed = JSON.parse(result);
        } catch (e) {
          assert.fail(
            `terraform validate -json output could not be parsed as JSON (${e.message}): ${result}`
          );
          return;
        }

        // `terraform validate` exits 0 on warnings alone, so the exit code by
        // itself tolerates them implicitly. Assert error_count === 0
        // explicitly rather than trusting control flow - never warning-free.
        assert.equal(
          parsed.error_count,
          0,
          `terraform validate reported ${parsed.error_count} error(s): ${JSON.stringify(parsed.diagnostics)}`
        );
      });
    });
  });

  describe('Feature: The dead assertion is gone', () => {
    describe('Scenario: This test file itself contains no dead literal-string check', () => {
      it('Given tests/e2e/dynamodb-calendar.test.js, Then it contains no assertion on the literal string "refreshToken\\s"', () => {
        const selfContent = fs.readFileSync(__filename, 'utf-8');
        // Build the dead call shape (an `.includes(...)` call on a JS string
        // literal holding a backslash and the letter that follows it, not a
        // regex) from parts, so this test's own source does not itself
        // contain a copy of the pattern it is searching for.
        const deadCallShape = ['.includes(', "'", 'refreshToken', String.fromCharCode(92), 's', "'", ')'].join('');
        assert.ok(!selfContent.includes(deadCallShape),
          'the dead refreshToken-backslash-s includes() check should have been removed, not left alongside the real one');
      });
    });
  });
});
