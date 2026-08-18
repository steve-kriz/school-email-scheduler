import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

// -----------------------------------------------------------------------------
// TTL guard helpers (TASK-016)
// -----------------------------------------------------------------------------
// The connections table must declare NO ttl block: it holds the only copy of
// each user's encrypted OAuth grant, and an enabled reaper would silently and
// permanently expire it if any writer ever stamped a `ttl` attribute. The events
// table's ttl block is legitimate, so the guard is scoped to a single resource
// body by brace counting rather than searching the whole file.

/** Return the body text of `resource "<type>" "<name>" { ... }`, or null. */
function extractResourceBody(content, resourceType, resourceName) {
  const header = new RegExp(`resource\\s+"${resourceType}"\\s+"${resourceName}"\\s*\\{`);
  const match = header.exec(content);
  if (!match) return null;

  const open = match.index + match[0].length - 1; // index of the opening brace
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return null;
}

/** True if the given resource body declares a `ttl { ... }` block. */
function bodyDeclaresTtlBlock(body) {
  const withoutComments = body
    .split('\n')
    .filter(line => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
    .join('\n');
  return /(^|\n)\s*ttl\s*\{/.test(withoutComments);
}

describe('DynamoDB Calendar Unit Tests', () => {

  describe('KMS key (kms_calendar.tf)', () => {
    let kmsContent;

    it('file should exist', () => {
      const kmsPath = path.join(TERRAFORM_DIR, 'kms_calendar.tf');
      assert.ok(fs.existsSync(kmsPath), 'kms_calendar.tf not found');
      kmsContent = fs.readFileSync(kmsPath, 'utf-8');
      assert.ok(kmsContent.length > 0, 'kms_calendar.tf is empty');
    });

    it('should declare aws_kms_key.calendar resource', () => {
      assert.ok(kmsContent.includes('resource "aws_kms_key" "calendar"'),
        'aws_kms_key.calendar resource not found');
    });

    it('should enable key rotation', () => {
      assert.ok(kmsContent.includes('enable_key_rotation'),
        'enable_key_rotation setting not found');
      assert.ok(kmsContent.includes('enable_key_rotation     = true'),
        'enable_key_rotation should be set to true');
    });

    it('should set deletion_window_in_days to 30', () => {
      assert.ok(kmsContent.includes('deletion_window_in_days'),
        'deletion_window_in_days setting not found');
      assert.ok(kmsContent.includes('deletion_window_in_days = 30'),
        'deletion_window_in_days should be set to 30');
    });

    it('should create an alias with the correct name pattern', () => {
      assert.ok(kmsContent.includes('aws_kms_alias.calendar'),
        'aws_kms_alias.calendar resource not found');
      assert.ok(kmsContent.includes('alias/${local.name_prefix}-school-calendar'),
        'KMS alias should follow pattern alias/${local.name_prefix}-school-calendar');
    });

    it('should have a key policy that grants account root full control', () => {
      assert.ok(kmsContent.includes('data "aws_iam_policy_document" "calendar_kms_key"'),
        'calendar_kms_key policy document not found');
      assert.ok(kmsContent.includes('EnableIAMUserPermissions'),
        'EnableIAMUserPermissions statement not found');
      assert.ok(kmsContent.includes('kms:*'),
        'kms:* action not granted');
    });

    it('should restrict KMS policy to account root only (no other principals)', () => {
      assert.ok(kmsContent.includes('identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]'),
        'KMS policy should only grant to account root');

      // Verify there's only one statement (the root statement)
      const statements = (kmsContent.match(/statement\s*\{/g) || []).length;
      assert.equal(statements, 1,
        'KMS policy should only have one statement granting to account root');
    });

    it('should expose calendar_kms_key_arn output', () => {
      assert.ok(kmsContent.includes('output "calendar_kms_key_arn"'),
        'calendar_kms_key_arn output not found');
      assert.ok(kmsContent.includes('value       = aws_kms_key.calendar.arn'),
        'calendar_kms_key_arn output should expose the key ARN');
    });

    it('should expose calendar_kms_key_id output', () => {
      assert.ok(kmsContent.includes('output "calendar_kms_key_id"'),
        'calendar_kms_key_id output not found');
      assert.ok(kmsContent.includes('value       = aws_kms_key.calendar.key_id'),
        'calendar_kms_key_id output should expose the key ID');
    });

    it('should expose calendar_kms_alias output', () => {
      assert.ok(kmsContent.includes('output "calendar_kms_alias"'),
        'calendar_kms_alias output not found');
      assert.ok(kmsContent.includes('value       = aws_kms_alias.calendar.name'),
        'calendar_kms_alias output should expose the alias name');
    });

    it('should include descriptive comments about refresh token encryption', () => {
      assert.ok(kmsContent.includes('refresh token') || kmsContent.includes('Refresh token') ||
               kmsContent.includes('OAuth grant'),
        'Comments should explain refresh token encryption purpose');
    });

    it('edge case: policy should explicitly avoid granting actions to other principals', () => {
      // The comment explicitly states "Deliberately no principal-specific statements"
      // Count only the actual policy statements (not comments)
      const policySection = kmsContent.substring(kmsContent.indexOf('data "aws_iam_policy_document"'));
      const statements = (policySection.match(/statement\s*\{/g) || []).length;
      assert.equal(statements, 1,
        'KMS policy should have exactly one statement (to account root only)');
    });
  });

  describe('Connections table (dynamodb_calendar_connections.tf)', () => {
    let connectionsContent;

    it('file should exist', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      assert.ok(fs.existsSync(connectionsPath), 'dynamodb_calendar_connections.tf not found');
      connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
      assert.ok(connectionsContent.length > 0, 'dynamodb_calendar_connections.tf is empty');
    });

    it('should declare aws_dynamodb_table.calendar_connections resource', () => {
      assert.ok(connectionsContent.includes('resource "aws_dynamodb_table" "calendar_connections"'),
        'aws_dynamodb_table.calendar_connections resource not found');
    });

    it('should have name = "${local.name_prefix}-calendar-connections"', () => {
      assert.ok(connectionsContent.includes('${local.name_prefix}-calendar-connections'),
        'Table name pattern not found');
    });

    it('should have hash_key = "userId" (S type)', () => {
      assert.ok(connectionsContent.includes('hash_key     = "userId"'),
        'hash_key should be "userId"');
      assert.ok(connectionsContent.includes('attribute') &&
               connectionsContent.includes('name = "userId"') &&
               connectionsContent.includes('type = "S"'),
        'userId attribute should be declared as type S');
    });

    it('should NOT have a range_key', () => {
      // Check that range_key is not set in the table
      const tableMatch = connectionsContent.match(/resource\s+"aws_dynamodb_table"\s+"calendar_connections"\s*\{[\s\S]*?\n\}/);
      assert.ok(tableMatch, 'Table resource not found');
      assert.ok(!tableMatch[0].includes('range_key'),
        'Table should not have a range_key');
    });

    it('should NOT have any global_secondary_index', () => {
      const tableMatch = connectionsContent.match(/resource\s+"aws_dynamodb_table"\s+"calendar_connections"\s*\{[\s\S]*?\n\}/);
      assert.ok(!tableMatch[0].includes('global_secondary_index'),
        'Table should not have any GSI');
    });

    it('should set billing_mode = "PAY_PER_REQUEST"', () => {
      assert.ok(connectionsContent.includes('billing_mode = "PAY_PER_REQUEST"'),
        'billing_mode should be PAY_PER_REQUEST');
    });

    it('should enable point_in_time_recovery', () => {
      assert.ok(connectionsContent.includes('point_in_time_recovery'),
        'point_in_time_recovery block not found');
      assert.ok(connectionsContent.includes('enabled = true'),
        'point_in_time_recovery should be enabled');
    });

    it('should enable server_side_encryption with the CMK', () => {
      assert.ok(connectionsContent.includes('server_side_encryption'),
        'server_side_encryption block not found');
      assert.ok(connectionsContent.includes('enabled     = true'),
        'server_side_encryption should be enabled');
      assert.ok(connectionsContent.includes('kms_key_arn = aws_kms_key.calendar.arn'),
        'server_side_encryption should use the calendar CMK');
    });

    it('should NOT declare a ttl block (no reaper on the OAuth grant table)', () => {
      const content = fs.readFileSync(
        path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf'), 'utf-8');
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'calendar_connections');
      assert.ok(body, 'aws_dynamodb_table.calendar_connections resource body not found');
      assert.equal(bodyDeclaresTtlBlock(body), false,
        'connections table must not declare a ttl block - a reaper here would silently expire the only copy of a user\'s OAuth grant');
    });

    it('should not document an operator-stamped connections TTL', () => {
      const content = fs.readFileSync(
        path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf'), 'utf-8');
      assert.ok(!content.includes('reaped'),
        'the comment justifying a connections TTL should be removed along with the block');
    });

    it('should define refreshTokenEnc attribute in the schema', () => {
      // Check in the comment section (schema documentation)
      const commentSection = connectionsContent.substring(0, connectionsContent.indexOf('resource'));
      assert.ok(commentSection.includes('refreshTokenEnc'),
        'refreshTokenEnc should be documented in schema');
    });

    it('should NOT define any plaintext refreshToken attribute', () => {
      // Should NOT have a plaintext "refreshToken" attribute (only refreshTokenEnc)
      const commentSection = connectionsContent.substring(0, connectionsContent.indexOf('resource'));

      // Check the schema documentation section (look for attribute descriptions)
      // The schema part lists attributes with their descriptions
      // We should NOT find a line like "refreshToken :" that describes the plaintext token
      const lines = commentSection.split('\n');
      const schemaLines = lines.slice(lines.findIndex(l => l.includes('Schema')));

      // Check if any schema line mentions "refreshToken :" (the attribute name pattern)
      // excluding "refreshTokenEnc" and "refreshTokenKeyId"
      const hasPlaintextToken = schemaLines.some(line =>
        line.match(/^\s*refreshToken\s+:/) // Matches "refreshToken :" at start of attribute definition
      );

      assert.ok(!hasPlaintextToken,
        'Should not document plaintext refreshToken attribute in schema');
    });

    it('should document that plaintext token is never written', () => {
      assert.ok(connectionsContent.includes('PLAINTEXT TOKEN IS NEVER WRITTEN') ||
               connectionsContent.includes('never persisted') ||
               connectionsContent.includes('The plaintext refresh token is never'),
        'Should document that plaintext token is never stored');
    });

    it('should merge var.tags with Purpose tag', () => {
      assert.ok(connectionsContent.includes('merge(var.tags'),
        'Should merge var.tags');
      assert.ok(connectionsContent.includes('Purpose'),
        'Should include a Purpose tag');
      assert.ok(connectionsContent.includes('School Calendar Google account connections') ||
               connectionsContent.includes('connections'),
        'Purpose tag should describe the table');
    });

    it('should expose calendar_connections_table_name output', () => {
      assert.ok(connectionsContent.includes('output "calendar_connections_table_name"'),
        'calendar_connections_table_name output not found');
    });

    it('should expose calendar_connections_table_arn output', () => {
      assert.ok(connectionsContent.includes('output "calendar_connections_table_arn"'),
        'calendar_connections_table_arn output not found');
    });
  });

  describe('Events table (dynamodb_calendar_events.tf)', () => {
    let eventsContent;

    it('file should exist', () => {
      const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
      assert.ok(fs.existsSync(eventsPath), 'dynamodb_calendar_events.tf not found');
      eventsContent = fs.readFileSync(eventsPath, 'utf-8');
      assert.ok(eventsContent.length > 0, 'dynamodb_calendar_events.tf is empty');
    });

    it('should declare aws_dynamodb_table.calendar_events resource', () => {
      assert.ok(eventsContent.includes('resource "aws_dynamodb_table" "calendar_events"'),
        'aws_dynamodb_table.calendar_events resource not found');
    });

    it('should have name = "${local.name_prefix}-calendar-events"', () => {
      assert.ok(eventsContent.includes('${local.name_prefix}-calendar-events'),
        'Table name pattern not found');
    });

    it('should have hash_key = "userId" (S type)', () => {
      assert.ok(eventsContent.includes('hash_key     = "userId"'),
        'hash_key should be "userId"');
      assert.ok(eventsContent.includes('attribute') &&
               eventsContent.includes('name = "userId"') &&
               eventsContent.includes('type = "S"'),
        'userId attribute should be declared as type S');
    });

    it('should have range_key = "eventId" (S type)', () => {
      assert.ok(eventsContent.includes('range_key    = "eventId"'),
        'range_key should be "eventId"');
      assert.ok(eventsContent.match(/attribute\s*\{\s*name = "eventId"\s*type = "S"/),
        'eventId attribute should be declared as type S');
    });

    it('should declare startsAt attribute (S type) for StartsAtIndex', () => {
      assert.ok(eventsContent.includes('name = "startsAt"'),
        'startsAt attribute not declared');
      assert.ok(eventsContent.includes('type = "S"'),
        'startsAt should be type S');
    });

    it('should declare attentionKey attribute (S type) for AttentionIndex', () => {
      assert.ok(eventsContent.includes('name = "attentionKey"'),
        'attentionKey attribute not declared');
      assert.ok(eventsContent.match(/attribute\s*\{\s*name = "attentionKey"\s*type = "S"/),
        'attentionKey should be declared as type S');
    });

    it('should declare dueBy attribute (S type) for AttentionIndex', () => {
      assert.ok(eventsContent.includes('name = "dueBy"'),
        'dueBy attribute not declared');
      assert.ok(eventsContent.match(/attribute\s*\{\s*name = "dueBy"\s*type = "S"/),
        'dueBy should be declared as type S');
    });

    it('should have StartsAtIndex GSI with correct hash and range keys', () => {
      assert.ok(eventsContent.includes('StartsAtIndex'),
        'StartsAtIndex GSI not found');
      assert.ok(eventsContent.includes('name            = "StartsAtIndex"'),
        'StartsAtIndex name not set');

      // Get the GSI definition
      const gsiMatch = eventsContent.match(/global_secondary_index\s*\{[\s\S]*?name\s*=\s*"StartsAtIndex"[\s\S]*?\}/);
      assert.ok(gsiMatch, 'StartsAtIndex GSI definition not found');

      const gsiDef = gsiMatch[0];
      assert.ok(gsiDef.includes('hash_key') && gsiDef.includes('userId'),
        'StartsAtIndex hash_key should be userId');
      assert.ok(gsiDef.includes('range_key') && gsiDef.includes('startsAt'),
        'StartsAtIndex range_key should be startsAt');
      assert.ok(gsiDef.includes('projection_type') && gsiDef.includes('ALL'),
        'StartsAtIndex projection_type should be ALL');
    });

    it('should have AttentionIndex GSI with correct hash and range keys', () => {
      assert.ok(eventsContent.includes('AttentionIndex'),
        'AttentionIndex GSI not found');
      assert.ok(eventsContent.includes('name            = "AttentionIndex"'),
        'AttentionIndex name not set');

      // Get the GSI definition
      const gsiMatch = eventsContent.match(/global_secondary_index\s*\{[\s\S]*?name\s*=\s*"AttentionIndex"[\s\S]*?\}/);
      assert.ok(gsiMatch, 'AttentionIndex GSI definition not found');

      const gsiDef = gsiMatch[0];
      assert.ok(gsiDef.includes('hash_key') && gsiDef.includes('attentionKey'),
        'AttentionIndex hash_key should be attentionKey');
      assert.ok(gsiDef.includes('range_key') && gsiDef.includes('dueBy'),
        'AttentionIndex range_key should be dueBy');
      assert.ok(gsiDef.includes('projection_type') && gsiDef.includes('ALL'),
        'AttentionIndex projection_type should be ALL');
    });

    it('should enable TTL on the ttl attribute', () => {
      assert.ok(eventsContent.includes('ttl'),
        'ttl block not found');
      assert.ok(eventsContent.includes('attribute_name = "ttl"'),
        'ttl attribute_name should be "ttl"');
      assert.ok(eventsContent.includes('enabled        = true'),
        'ttl should be enabled');
    });

    it('should enable point_in_time_recovery', () => {
      assert.ok(eventsContent.includes('point_in_time_recovery'),
        'point_in_time_recovery block not found');
      assert.ok(eventsContent.includes('enabled = true'),
        'point_in_time_recovery should be enabled');
    });

    it('should set billing_mode = "PAY_PER_REQUEST"', () => {
      assert.ok(eventsContent.includes('billing_mode = "PAY_PER_REQUEST"'),
        'billing_mode should be PAY_PER_REQUEST');
    });

    it('should enable server_side_encryption with the CMK', () => {
      assert.ok(eventsContent.includes('server_side_encryption'),
        'server_side_encryption block not found');
      assert.ok(eventsContent.includes('enabled     = true'),
        'server_side_encryption should be enabled');
      assert.ok(eventsContent.includes('kms_key_arn = aws_kms_key.calendar.arn'),
        'server_side_encryption should use the calendar CMK');
    });

    it('should document eventId derivation using sha256', () => {
      const commentSection = eventsContent.substring(0, eventsContent.indexOf('resource'));
      assert.ok(commentSection.includes('sha256'),
        'eventId derivation should use sha256');
      assert.ok(commentSection.includes('sourceMessageId') &&
               commentSection.includes('normalisedTitle') &&
               commentSection.includes('startsAt'),
        'eventId should be derived from sourceMessageId, title, and startsAt');
    });

    it('should document that eventId derivation ensures idempotency', () => {
      const commentSection = eventsContent.substring(0, eventsContent.indexOf('resource'));
      assert.ok(commentSection.includes('idempotent') || commentSection.includes('overwrites'),
        'Should document that re-scanning produces same eventId (idempotent)');
    });

    it('should document AttentionIndex sparseness', () => {
      const commentSection = eventsContent.substring(0, eventsContent.indexOf('resource'));
      assert.ok(commentSection.includes('SPARSE'),
        'Should document that AttentionIndex is sparse');
      assert.ok(commentSection.includes('needsAttention') &&
               commentSection.includes('status') &&
               commentSection.includes('pending'),
        'Should explain when attentionKey is set (both conditions)');
    });

    it('should document the REMOVE contract for attentionKey', () => {
      const commentSection = eventsContent.substring(0, eventsContent.indexOf('resource'));
      assert.ok(commentSection.includes('REMOVE') && commentSection.includes('attentionKey'),
        'Should document the REMOVE attentionKey contract');
      assert.ok(commentSection.includes('UpdateExpression'),
        'Should mention UpdateExpression for REMOVE');
    });

    it('should document the IAM /index/* requirement', () => {
      const commentSection = eventsContent.substring(0, eventsContent.indexOf('resource'));
      assert.ok(commentSection.includes('/index/*') || commentSection.includes('index/*'),
        'Should document that IAM must include /index/* for GSI queries');
      assert.ok(commentSection.includes('dynamodb:Query'),
        'Should mention Query permission requirement');
    });

    it('should merge var.tags with Purpose tag', () => {
      assert.ok(eventsContent.includes('merge(var.tags'),
        'Should merge var.tags');
      assert.ok(eventsContent.includes('Purpose'),
        'Should include a Purpose tag');
      assert.ok(eventsContent.includes('School Calendar extracted events') ||
               eventsContent.includes('events'),
        'Purpose tag should describe the table');
    });

    it('should expose calendar_events_table_name output', () => {
      assert.ok(eventsContent.includes('output "calendar_events_table_name"'),
        'calendar_events_table_name output not found');
    });

    it('should expose calendar_events_table_arn output', () => {
      assert.ok(eventsContent.includes('output "calendar_events_table_arn"'),
        'calendar_events_table_arn output not found');
      // Should also mention the /index/* IAM requirement in the output description
      assert.ok(eventsContent.includes('/index/*') || eventsContent.includes('index'),
        'Output description should mention /index/* IAM requirement');
    });

    it('edge case: eventId as sort key prevents duplicates even with concurrent re-scans', () => {
      // eventId is the range key (sort key), so (userId, eventId) uniqueness is enforced
      assert.ok(eventsContent.includes('range_key') && eventsContent.includes('eventId'),
        'eventId as range key ensures no duplicates per user');
    });

    it('edge case: attentionKey must be present in item for sparse index inclusion', () => {
      // Sparse index only includes items where the key attribute exists
      assert.ok(eventsContent.includes('SPARSE') || eventsContent.includes('sparse'),
        'Should document sparse index behavior');
    });
  });

  describe('Cross-file validations', () => {
    it('all three files should exist', () => {
      const files = [
        'kms_calendar.tf',
        'dynamodb_calendar_connections.tf',
        'dynamodb_calendar_events.tf'
      ];

      files.forEach(file => {
        const filePath = path.join(TERRAFORM_DIR, file);
        assert.ok(fs.existsSync(filePath), `${file} not found`);
      });
    });

    it('connections and events tables should both reference aws_kms_key.calendar', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');

      const connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');
      const eventsContent = fs.readFileSync(eventsPath, 'utf-8');

      assert.ok(connectionsContent.includes('aws_kms_key.calendar'),
        'connections table should reference aws_kms_key.calendar');
      assert.ok(eventsContent.includes('aws_kms_key.calendar'),
        'events table should reference aws_kms_key.calendar');
    });

    it('KMS key should have descriptive comments', () => {
      const kmsPath = path.join(TERRAFORM_DIR, 'kms_calendar.tf');
      const kmsContent = fs.readFileSync(kmsPath, 'utf-8');

      // Should start with comment block
      assert.ok(kmsContent.trim().startsWith('#'),
        'KMS file should start with comment block');
    });

    it('connections table should have descriptive comments', () => {
      const connectionsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_connections.tf');
      const connectionsContent = fs.readFileSync(connectionsPath, 'utf-8');

      // Should start with comment block
      assert.ok(connectionsContent.trim().startsWith('#'),
        'connections file should start with comment block');
    });

    it('events table should have descriptive comments', () => {
      const eventsPath = path.join(TERRAFORM_DIR, 'dynamodb_calendar_events.tf');
      const eventsContent = fs.readFileSync(eventsPath, 'utf-8');

      // Should start with comment block
      assert.ok(eventsContent.trim().startsWith('#'),
        'events file should start with comment block');
    });
  });
});
