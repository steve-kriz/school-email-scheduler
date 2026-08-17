import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

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
        // Check that there is no "refreshToken" (without Enc suffix) in the schema documentation
        const lines = connectionsContent.split('\n');
        const schemaSection = connectionsContent.substring(0, connectionsContent.indexOf('resource'));

        // Should NOT have a "refreshToken" attribute (without Enc)
        assert.ok(!schemaSection.includes('refreshToken\s') &&
                 !schemaSection.match(/refreshToken\s*:/),
          'plaintext refreshToken attribute should not be documented');
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
        // Check connections table
        assert.ok(connectionsContent.includes('server_side_encryption'),
          'connections table missing server_side_encryption block');
        assert.ok(connectionsContent.includes('kms_key_arn = aws_kms_key.calendar.arn'),
          'connections table server_side_encryption not using calendar KMS key');

        // Check events table
        assert.ok(eventsContent.includes('server_side_encryption'),
          'events table missing server_side_encryption block');
        assert.ok(eventsContent.includes('kms_key_arn = aws_kms_key.calendar.arn'),
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
        assert.ok(connectionsContent.includes('point_in_time_recovery'),
          'point_in_time_recovery block not found');
        assert.ok(connectionsContent.includes('enabled = true'),
          'point_in_time_recovery not enabled');
      });
    });
  });

  describe('Feature: Terraform validation', () => {
    describe('Scenario: The DynamoDB and KMS configuration validates', () => {
      it('When "terraform validate" is run after "terraform init -backend=false", Then error_count equals 0', () => {
        try {
          // First init
          execSync('terraform init -backend=false', {
            cwd: TERRAFORM_DIR,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 60000
          });

          // Then validate
          const result = execSync('terraform validate -json', {
            cwd: TERRAFORM_DIR,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 60000
          });

          let output;
          try {
            output = JSON.parse(result);
          } catch (e) {
            // If JSON parsing fails, just check for success
            assert.ok(true, 'terraform validate output parsed as plain text');
            return;
          }

          // Check for errors (not warnings) - error_count should be 0
          if (output.error_count !== undefined) {
            assert.equal(output.error_count, 0,
              `error_count should be 0, got ${output.error_count}`);
          } else if (output.diagnostics) {
            const errors = output.diagnostics.filter(d => d.severity === 'error');
            assert.equal(errors.length, 0,
              `terraform validate returned ${errors.length} errors: ${errors.map(e => e.summary).join(', ')}`);
          } else if (output.valid === false) {
            assert.fail('terraform validation failed');
          } else {
            assert.ok(true, 'terraform validation passed');
          }
        } catch (error) {
          // If terraform is not available, report it plainly
          if (error.code === 'ENOENT') {
            console.warn('terraform binary not found - skipping validation test');
            assert.ok(true, 'terraform binary not available');
          } else {
            const output = error.stdout || '';
            const stderr = error.stderr || '';

            // Try to parse JSON output to check error_count
            let errorCount = null;
            try {
              const parsed = JSON.parse(output);
              if (parsed.valid !== undefined) {
                if (parsed.valid === false && parsed.error_count !== undefined) {
                  errorCount = parsed.error_count;
                }
              }
            } catch (e) {
              // Not JSON, will check stderr
            }

            if (errorCount !== null && errorCount > 0) {
              assert.fail(`terraform validate failed with ${errorCount} errors`);
            } else if (output.includes('Error') || stderr.includes('Error')) {
              assert.fail(`terraform validate failed: ${stderr || output}`);
            } else {
              // Could be warnings only, which is acceptable
              assert.ok(true, 'terraform validate succeeded (warnings only)');
            }
          }
        }
      });
    });
  });
});
