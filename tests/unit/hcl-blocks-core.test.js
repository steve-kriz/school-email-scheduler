import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  extractResourceBody,
  extractBlock,
  bodyDeclaresTtlBlock,
  extractStatementArray,
  parsePolicyStatements,
} from '../helpers/hcl-blocks.mjs';

describe('HCL Block Helpers - maskNonCode (TASK-017 Pass 1)', () => {
  describe('maskNonCode: Double-quoted strings', () => {
    it('should extract resource body when a string contains an unbalanced brace', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  name = "test-events"
  description = "Table with { unbalanced brace in description"
  ttl {
    attribute_name = "expiry"
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should extract body despite unbalanced brace in string');
      assert.ok(body.includes('ttl'), 'should include ttl block after the brace-containing string');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block even with brace in string');
    });

    it('should extract resource body when a string contains a bracket', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  name = "test"
  description = "Use [brackets] here"
  ttl {
    attribute_name = "expiry"
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should extract body despite bracket in string');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });

    it('should handle escaped quotes in strings', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  description = "String with \\"escaped quotes\\" and { brace"
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should handle escaped quotes');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });
  });

  describe('maskNonCode: Line comments', () => {
    it('should extract resource body when # comment contains a brace', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  name = "test"
  # This comment has a { unbalanced brace
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should extract body despite brace in # comment');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });

    it('should extract resource body when // comment contains braces and brackets', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  name = "test"
  // This comment has { braces } and [brackets]
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should extract body despite braces/brackets in // comment');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });

    it('should extract resource body with mixed # and // comments containing braces', () => {
      const content = `
resource "aws_dynamodb_table" "events" {
  name = "test"
  # Hash comment { brace }
  // Slash comment [ bracket ]
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
      assert.ok(body, 'should handle both comment types');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });
  });

  describe('maskNonCode: Heredocs (<<EOT and <<-EOT)', () => {
    it('should extract resource body when heredoc contains unbalanced braces', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  policy = jsonencode({
    policy_content = <<EOT
{
  "unbalanced": true
EOT
    ttl {
      enabled = true
    }
  })
}
      `.trim();
      const body = extractResourceBody(content, 'aws_iam_role_policy', 'test');
      assert.ok(body, 'should extract body with heredoc containing braces');
    });

    it('should extract resource body when heredoc is indented with <<-EOT', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  policy = jsonencode({
    content = <<-EOT
      {
        "key": "value"
      }
    EOT
    ttl {
      enabled = true
    }
  })
}
      `.trim();
      const body = extractResourceBody(content, 'aws_iam_role_policy', 'test');
      assert.ok(body, 'should extract body with indented <<- heredoc');
    });

    it('should extract resource body when heredoc contains mixed braces and brackets', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  policy = jsonencode({
    json = <<EOT
{
  "array": [1, 2, 3],
  "nested": { "a": "b" }
}
EOT
    ttl {
      enabled = true
    }
  })
}
      `.trim();
      const body = extractResourceBody(content, 'aws_iam_role_policy', 'test');
      assert.ok(body, 'should extract body with heredoc containing braces/brackets');
    });

    it('should throw when heredoc is never closed', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  policy = jsonencode({
    unclosed = <<EOT
    This heredoc is never terminated
      `.trim();
      assert.throws(
        () => extractResourceBody(content, 'aws_iam_role_policy', 'test'),
        /heredoc.*was opened but never closed/,
        'should throw for unterminated heredoc, not return truncated result'
      );
    });

    it('should handle nested structures (brace in string in heredoc)', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  policy = jsonencode({
    content = <<EOT
{
  "description": "This has { a brace"
}
EOT
    ttl {
      enabled = true
    }
  })
}
      `.trim();
      const body = extractResourceBody(content, 'aws_iam_role_policy', 'test');
      assert.ok(body, 'should extract body with brace in string in heredoc');
    });
  });

  describe('maskNonCode: Complex combinations', () => {
    it('should handle string, comment, and heredoc in the same resource', () => {
      const content = `
resource "aws_iam_role_policy" "test" {
  name = "policy { with brace"
  # This is a { comment with brace
  description = <<EOT
{
  "json": "with { braces"
}
EOT
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_iam_role_policy', 'test');
      assert.ok(body, 'should extract body with mixed constructs');
      assert.ok(bodyDeclaresTtlBlock(body), 'should detect ttl block');
    });

    it('should not mistake commented-out resource for real resource', () => {
      const content = `
# resource "aws_dynamodb_table" "fake" {
#   ttl { enabled = true }
# }
resource "aws_dynamodb_table" "real" {
  ttl {
    enabled = true
  }
}
      `.trim();
      const body = extractResourceBody(content, 'aws_dynamodb_table', 'fake');
      assert.strictEqual(body, null, 'should not find commented-out resource');
      const realBody = extractResourceBody(content, 'aws_dynamodb_table', 'real');
      assert.ok(realBody, 'should find real resource');
    });
  });
});

describe('HCL Block Helpers - extractStatementArray (TASK-017 Pass 2)', () => {
  it('should find Statement array with standard spacing', () => {
    const policy = `
{
  Statement = [
    { Sid = "Test", Resource = "*" }
  ]
}
    `.trim();
    const arrayBody = extractStatementArray(policy);
    assert.ok(arrayBody.includes('Sid'), 'should extract statement array');
  });

  it('should find Statement array with no spaces around equals', () => {
    const policy = `
{
  Statement=[
    { Sid = "Test", Resource = "*" }
  ]
}
    `.trim();
    const arrayBody = extractStatementArray(policy);
    assert.ok(arrayBody.includes('Sid'), 'should find Statement=[ without spaces');
  });

  it('should find Statement array with multiple spaces around equals', () => {
    const policy = `
{
  Statement  =  [
    { Sid = "Test", Resource = "*" }
  ]
}
    `.trim();
    const arrayBody = extractStatementArray(policy);
    assert.ok(arrayBody.includes('Sid'), 'should find Statement with multiple spaces');
  });

  it('should throw when Statement marker is not found', () => {
    const policy = `
{
  Statements = [
    { Sid = "Test" }
  ]
}
    `.trim();
    assert.throws(
      () => extractStatementArray(policy),
      /no "Statement = \[" array found/,
      'should throw when Statement marker is missing'
    );
  });

  it('should throw when Statement array has unbalanced brackets', () => {
    const policy = `
{
  Statement = [
    { Sid = "Test" }
    // missing closing bracket
}
    `.trim();
    assert.throws(
      () => extractStatementArray(policy),
      /unbalanced brackets/,
      'should throw for unbalanced brackets'
    );
  });

  it('should ignore brackets inside strings before the Statement array', () => {
    const policy = `
{
  description = "Array format [1, 2, 3]",
  Statement = [
    { Sid = "Test", Resource = "*" }
  ]
}
    `.trim();
    const arrayBody = extractStatementArray(policy);
    assert.ok(arrayBody.includes('Sid'), 'should find Statement despite brackets in earlier string');
  });
});

describe('HCL Block Helpers - parsePolicyStatements (TASK-017 Pass 2)', () => {
  it('should extract Sid from statement with Sid first', () => {
    const arrayBody = `
{ Sid = "ReadLogs", Resource = "arn:aws:logs:*:*:*", Action = "logs:GetLogEvents" },
{ Sid = "ReadDynamoDB", Resource = "*", Action = "dynamodb:GetItem" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    assert.strictEqual(statements.length, 2);
    assert.strictEqual(statements[0].sid, 'ReadLogs');
    assert.strictEqual(statements[1].sid, 'ReadDynamoDB');
  });

  it('should extract Sid from statement regardless of key order (Sid last)', () => {
    const arrayBody = `
{ Resource = "arn:aws:logs:*:*:*", Action = "logs:GetLogEvents", Sid = "ReadLogs" },
{ Action = "dynamodb:GetItem", Sid = "ReadDynamoDB", Resource = "*" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    assert.strictEqual(statements.length, 2);
    assert.strictEqual(statements[0].sid, 'ReadLogs');
    assert.strictEqual(statements[1].sid, 'ReadDynamoDB');
  });

  it('should extract Sid from statement with Sid in the middle', () => {
    const arrayBody = `
{ Resource = "arn:aws:logs:*:*:*", Sid = "ReadLogs", Action = "logs:GetLogEvents" },
{ Action = "dynamodb:GetItem", Sid = "ReadDynamoDB", Resource = "*" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    assert.strictEqual(statements.length, 2);
    assert.strictEqual(statements[0].sid, 'ReadLogs');
    assert.strictEqual(statements[1].sid, 'ReadDynamoDB');
  });

  it('should extract Sid from statement with alphabetized keys', () => {
    const arrayBody = `
{ Action = "dynamodb:GetItem", Effect = "Allow", Resource = "*", Sid = "DynamoDB" },
{ Action = "logs:GetLogEvents", Effect = "Allow", Resource = "arn:aws:logs:*:*:*", Sid = "Logs" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    assert.strictEqual(statements.length, 2);
    assert.strictEqual(statements[0].sid, 'DynamoDB');
    assert.strictEqual(statements[1].sid, 'Logs');
  });

  it('should throw when a statement has no Sid', () => {
    const arrayBody = `
{ Resource = "arn:aws:logs:*:*:*", Action = "logs:GetLogEvents" },
{ Resource = "*", Action = "dynamodb:GetItem" }
    `.trim();
    assert.throws(
      () => parsePolicyStatements(arrayBody),
      /a statement object has no Sid attribute/,
      'should throw when statement lacks Sid, not silently pass'
    );
  });

  it('should throw when no statement objects are found', () => {
    const arrayBody = '   ';
    assert.throws(
      () => parsePolicyStatements(arrayBody),
      /no statement objects/,
      'should throw when Statement array is empty'
    );
  });

  it('should attribute Resource to the correct statement even when Sid is last', () => {
    const arrayBody = `
{ Resource = "arn:aws:logs:*:*:*", Action = "logs:GetLogEvents", Sid = "LogsStatement" },
{ Resource = "*", Action = "ec2:CreateNetworkInterface", Sid = "VPCStatement" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    const logsStmt = statements.find(s => s.sid === 'LogsStatement');
    const vpcStmt = statements.find(s => s.sid === 'VPCStatement');

    assert.ok(/Resource\s*=\s*"arn:aws:logs:\*:\*:\*"/.test(logsStmt.body), 'LogsStatement should have scoped resource');
    assert.ok(/Resource\s*=\s*"\*"/.test(vpcStmt.body), 'VPCStatement should have unscoped resource');
  });

  it('should handle statements with special characters in Sid values', () => {
    const arrayBody = `
{ Sid = "StatementWithSpecialChars123", Resource = "*", Action = "logs:*" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    assert.strictEqual(statements.length, 1);
    assert.ok(statements[0].sid.includes('Special'));
  });
});

describe('HCL Block Helpers - Mutation Testing', () => {
  it('should detect when ttl block is missing from resource', () => {
    const content = `
resource "aws_dynamodb_table" "events" {
  name = "test"
  point_in_time_recovery {
    enabled = true
  }
}
    `.trim();
    const body = extractResourceBody(content, 'aws_dynamodb_table', 'events');
    assert.ok(!bodyDeclaresTtlBlock(body), 'should not find ttl block when it is absent');
  });

  it('should fail when extractResourceBody returns null for nonexistent resource', () => {
    const content = `
resource "aws_dynamodb_table" "real" {
  ttl { enabled = true }
}
    `.trim();
    const body = extractResourceBody(content, 'aws_dynamodb_table', 'nonexistent');
    assert.strictEqual(body, null, 'should return null for nonexistent resource');
  });

  it('should fail when Statement array cannot be found in policy', () => {
    const policyText = '{ Version = "2012-10-17" }';
    assert.throws(
      () => extractStatementArray(policyText),
      /no "Statement = \[" array found/
    );
  });

  it('should detect unscoped Resource in Sid-last statement', () => {
    const arrayBody = `
{ Resource = "arn:aws:logs:*:*:*", Action = "logs:*", Sid = "LogsStatement" },
{ Action = "ec2:CreateNetworkInterface", Resource = "*", Sid = "VPCNetworkInterfaces" }
    `.trim();
    const statements = parsePolicyStatements(arrayBody);
    const vpcStmt = statements.find(s => s.sid === 'VPCNetworkInterfaces');
    assert.ok(/Resource\s*=\s*"\*"/.test(vpcStmt.body), 'unscoped Resource should be in VPC statement even though Sid is last');
  });
});
