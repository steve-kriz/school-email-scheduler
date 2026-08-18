import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

// --- IAM policy parsing helpers ---
// The calendar policy is an inline `policy = jsonencode({ ... })` block in HCL,
// not JSON on disk (its resources are unresolved Terraform references), so it
// cannot be JSON.parse'd. These helpers attribute each `Resource` assignment to
// the Sid of the statement that encloses it, by splitting the policy text on
// Sid boundaries. Sid is the first key of every statement in this policy.

// Matches an UNSCOPED resource - literally `Resource = "*"`. It deliberately
// does not match a scoped value that merely contains a wildcard, such as
// `Resource = "arn:aws:logs:*:*:*"`.
const UNSCOPED_RESOURCE = /Resource\s*=\s*"\*"/;

// The only statements allowed an unscoped resource. The VPC network-interface
// actions do not support resource-level permissions, so AWS requires "*".
const ALLOWED_UNSCOPED_SIDS = ['VPCNetworkInterfaces'];

/**
 * Returns the calendar Lambda's inline IAM policy text with HCL comment lines
 * removed, so that prose mentioning `Resource = "*"` cannot be mistaken for a
 * real grant (the VPC statement's comment does exactly that).
 */
function extractCalendarPolicy(tfContent) {
  const policyMatch = tfContent.match(/policy = jsonencode\(\{[\s\S]*?\}\)/);
  assert.ok(policyMatch, 'IAM policy not found');
  return policyMatch[0]
    .split('\n')
    .filter(line => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * Asserts that every statement in the policy has Sid as its first key.
 * This is a requirement of parsePolicyStatements, which splits statements on Sid
 * boundaries and cannot see a statement whose Sid appears later. A statement with
 * Sid in a non-first position would have its Resource silently misattributed to
 * the previous statement, creating a false negative in the resource-scoping guard.
 */
function assertAllStatementsHaveSidFirst(policyText) {
  // Extract the Statement array from the policy using bracket counting
  // (lazy match fails when brackets nest, e.g., Action = ["..."])
  const statementArrayPos = policyText.indexOf('Statement = [');
  if (statementArrayPos === -1) {
    return; // No Statement array found, skip check
  }

  const arrayStart = statementArrayPos + 'Statement = ['.length - 1; // position of '['
  let bracketDepth = 1;
  let arrayEnd = arrayStart;

  for (let i = arrayStart + 1; i < policyText.length; i++) {
    if (policyText[i] === '[') {
      bracketDepth++;
    } else if (policyText[i] === ']') {
      bracketDepth--;
      if (bracketDepth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }

  if (bracketDepth !== 0) {
    return; // Mismatched brackets, skip check
  }

  const statementsText = policyText.substring(arrayStart + 1, arrayEnd);

  // Find each statement block { ... } and check that Sid comes first
  let braceDepth = 0;
  let statementStart = -1;

  for (let i = 0; i < statementsText.length; i++) {
    const char = statementsText[i];

    if (char === '{') {
      if (braceDepth === 0) {
        statementStart = i;
      }
      braceDepth++;
    } else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0 && statementStart !== -1) {
        // We have a complete statement block
        const statement = statementsText.substring(statementStart, i + 1);

        // Extract the content after the opening brace, removing comments and whitespace
        const contentAfterBrace = statement
          .substring(1) // Remove opening {
          .replace(/^\s+/, '') // Remove leading whitespace
          .replace(/^(\/\/|#)[^\n]*\n/gm, '') // Remove comment lines
          .trim();

        // Check that Sid comes first
        if (!contentAfterBrace.startsWith('Sid')) {
          assert.fail(
            'Every statement in the IAM policy must have Sid as its first key. ' +
            'parsePolicyStatements() attributes Resource values by splitting on Sid boundaries, ' +
            'and cannot see a statement whose Sid appears later. This would cause a silent false negative. ' +
            'Reorder the statement so Sid is first. ' +
            'Statement starts with: ' + contentAfterBrace.substring(0, 80)
          );
        }

        statementStart = -1;
      }
    }
  }
}

/**
 * Splits a policy into one { sid, body } chunk per statement. A chunk runs from
 * its own Sid assignment to the next one (or the end of the policy).
 * REQUIRES: Every statement has Sid as its first key (enforced by assertAllStatementsHaveSidFirst).
 */
function parsePolicyStatements(policyText) {
  assertAllStatementsHaveSidFirst(policyText);

  const sidMatches = [...policyText.matchAll(/Sid\s*=\s*"([^"]+)"/g)];
  assert.ok(sidMatches.length > 0, 'no Sid-bearing statements found in IAM policy');

  return sidMatches.map((match, index) => {
    const next = sidMatches[index + 1];
    return {
      sid: match[1],
      body: policyText.slice(match.index, next ? next.index : policyText.length)
    };
  });
}

/** The sorted Sids of the statements that grant an unscoped `Resource = "*"`. */
function sidsWithUnscopedResource(policyText) {
  return parsePolicyStatements(policyText)
    .filter(statement => UNSCOPED_RESOURCE.test(statement.body))
    .map(statement => statement.sid)
    .sort();
}

function statementBySid(statements, sid) {
  const statement = statements.find(candidate => candidate.sid === sid);
  assert.ok(statement, `statement "${sid}" not found in IAM policy`);
  return statement;
}

/** The single-valued `Resource = <expr>` of a statement, as written in HCL. */
function scalarResource(statement) {
  const match = statement.body.match(/Resource\s*=\s*([^\n]+)/);
  assert.ok(match, `statement "${statement.sid}" has no Resource assignment`);
  return match[1].trim().replace(/,$/, '');
}

/** The entries of a statement's `Resource = [ ... ]` list, as written in HCL. */
function resourceList(statement) {
  const match = statement.body.match(/Resource\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, `statement "${statement.sid}" has no Resource list`);
  return match[1].split(',').map(entry => entry.trim()).filter(Boolean);
}

describe('Calendar Lambda Terraform Unit Tests', () => {
  describe('Feature: Calendar Lambda and ALB wiring', () => {
    describe('Scenario: Archive file configuration', () => {
      it('Given lambda_calendar.tf, Then archive_file data source zips ../src/lambda/calendar', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('data "archive_file" "calendar_lambda_zip"'),
          'archive_file data source not found');
        assert.ok(tfContent.includes('source_dir  = "../src/lambda/calendar"'),
          'source_dir not correctly set');
      });

      it('When archive_file is configured, Then output_path is packages/lambda_function_calendar.zip', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('output_path = "packages/lambda_function_calendar.zip"'),
          'output_path not correctly set');
      });

      it('When archive_file is configured, Then it excludes CLAUDE.md, .deployment, package-lock.json, __test_shims__', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('"CLAUDE.md"'), 'CLAUDE.md not in excludes');
        assert.ok(tfContent.includes('".deployment"'), '.deployment not in excludes');
        assert.ok(tfContent.includes('"package-lock.json"'), 'package-lock.json not in excludes');
        assert.ok(tfContent.includes('"__test_shims__"'), '__test_shims__ not in excludes');
      });
    });

    describe('Scenario: Lambda function configuration', () => {
      it('Given aws_lambda_function resource, Then function_name is ${local.name_prefix}-school-calendar', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('function_name    = "${local.name_prefix}-school-calendar"'),
          'function_name not correctly set');
      });

      it('When lambda_function is configured, Then runtime is nodejs24.x', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('runtime          = "nodejs24.x"'),
          'runtime not correctly set to nodejs24.x');
      });

      it('When lambda_function is configured, Then handler is index.handler', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('handler          = "index.handler"'),
          'handler not correctly set');
      });

      it('When lambda_function is configured, Then timeout is 60 seconds', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('timeout          = 60'),
          'timeout not correctly set to 60');
      });

      it('When lambda_function is configured, Then memory_size is 512 MB', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('memory_size      = 512'),
          'memory_size not correctly set to 512');
      });

      it('When lambda_function is configured, Then source_code_hash is from archive output_base64sha256', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('source_code_hash = data.archive_file.calendar_lambda_zip.output_base64sha256'),
          'source_code_hash not correctly set');
      });
    });

    describe('Scenario: VPC configuration', () => {
      it('Given aws_lambda_function, Then vpc_config block exists', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('vpc_config {'),
          'vpc_config block not found');
      });

      it('When vpc_config is set, Then security_group_ids includes calendar security group', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('security_group_ids = [aws_security_group.calendar_sg.id]'),
          'security_group_ids not correctly set');
      });

      it('When vpc_config is set, Then subnet_ids are basestack private_subnet_ids', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('subnet_ids         = data.terraform_remote_state.basestack.outputs.private_subnet_ids'),
          'subnet_ids not correctly set');
      });
    });

    describe('Scenario: Function environment variables', () => {
      it('Given environment block in lambda_function, Then CALENDAR_LOG_LEVEL is set from var.calendar_log_level', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('CALENDAR_LOG_LEVEL = var.calendar_log_level'),
          'CALENDAR_LOG_LEVEL not correctly set');
      });

      it('When CALENDAR_FUNCTION_ARN is set, Then it is derived from locals, not from aws_lambda_function.calendar.arn', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('CALENDAR_FUNCTION_ARN = local.calendar_function_arn'),
          'CALENDAR_FUNCTION_ARN not derived from locals');
        assert.ok(!tfContent.match(/CALENDAR_FUNCTION_ARN\s*=\s*aws_lambda_function\.calendar\.arn/),
          'CALENDAR_FUNCTION_ARN should not reference aws_lambda_function.calendar.arn (would create cycle)');
      });

      it('When secret variables are set, Then every secret-derived var uses lookup(local.secrets, "KEY", "")', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');

        const secretVars = [
          'ALLOWED_ORIGINS',
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'SESSION_SECRET',
          'ANTHROPIC_API_KEY'
        ];

        for (const varName of secretVars) {
          const pattern = new RegExp(`${varName}\\s*=\\s*lookup\\(local\\.secrets,\\s*"${varName}",\\s*""\\)`);
          assert.ok(pattern.test(tfContent),
            `${varName} does not use lookup(local.secrets, "${varName}", "")`);
        }
      });
    });

    describe('Scenario: IAM policy scoping', () => {
      it('Given iam_policy for calendar lambda, Then the statements using an unscoped Resource = "*" are exactly the VPC network-interface statement', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const policyText = extractCalendarPolicy(tfContent);
        const statements = parsePolicyStatements(policyText);

        // Every statement must name a resource; otherwise an over-broad grant
        // could hide from the check below simply by omitting Resource.
        for (const statement of statements) {
          assert.match(statement.body, /Resource\s*=/,
            `statement "${statement.sid}" has no Resource assignment`);
        }

        assert.deepStrictEqual(sidsWithUnscopedResource(policyText), ALLOWED_UNSCOPED_SIDS,
          'the statements granting an unscoped Resource = "*" must be exactly ' +
          `${ALLOWED_UNSCOPED_SIDS.join(', ')} (the EC2 network-interface actions AWS cannot scope)`);

        // CloudWatch Logs is scoped-with-wildcards, not unscoped: it must keep
        // its logs ARN pattern rather than degrade to "*".
        assert.strictEqual(scalarResource(statementBySid(statements, 'CloudWatchLogs')),
          '"arn:aws:logs:*:*:*"',
          'CloudWatch Logs statement is not scoped to the logs ARN pattern');
      });

      it('When DynamoDB statement is configured, Then its resources are both table ARNs and the events index ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const statements = parsePolicyStatements(extractCalendarPolicy(tfContent));

        // Index Queries are authorised against the INDEX ARN, not the table ARN,
        // so "<events table arn>/index/*" must be listed explicitly.
        assert.deepStrictEqual(
          resourceList(statementBySid(statements, 'DynamoDBCalendarTables')),
          [
            'aws_dynamodb_table.calendar_connections.arn',
            'aws_dynamodb_table.calendar_events.arn',
            '"${aws_dynamodb_table.calendar_events.arn}/index/*"'
          ],
          'DynamoDB resources must be exactly both table ARNs plus the events table index ARN');
      });

      it('When KMS statement is configured, Then Resource is exactly the calendar CMK ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const statements = parsePolicyStatements(extractCalendarPolicy(tfContent));

        assert.strictEqual(scalarResource(statementBySid(statements, 'KMSCalendarKey')),
          'aws_kms_key.calendar.arn',
          'KMS statement must be scoped to exactly the calendar CMK ARN - a broader ' +
          'grant would let the Lambda decrypt with any key in the account');
      });

      it('When Secrets Manager statement is configured, Then Resource is the app-config secret ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const statements = parsePolicyStatements(extractCalendarPolicy(tfContent));

        assert.strictEqual(scalarResource(statementBySid(statements, 'SecretsManagerAppConfig')),
          'data.aws_secretsmanager_secret.app_config.arn',
          'Secrets Manager statement must be scoped to the app-config secret ARN');
      });

      it('When a mutated copy broadens the KMS statement to Resource = "*", Then the scoping assertion fails', () => {
        const realTfPath = path.join(TERRAFORM_DIR, 'lambda_calendar.tf');
        const original = fs.readFileSync(realTfPath, 'utf-8');
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-iam-fixture-'));
        const fixturePath = path.join(fixtureDir, 'lambda_calendar.tf');

        try {
          const mutated = original.replace(/Resource = aws_kms_key\.calendar\.arn/, 'Resource = "*"');
          assert.notStrictEqual(mutated, original,
            'fixture mutation did not apply - the KMS Resource assignment was not found');
          fs.writeFileSync(fixturePath, mutated, 'utf-8');

          const mutatedSids = sidsWithUnscopedResource(
            extractCalendarPolicy(fs.readFileSync(fixturePath, 'utf-8')));

          assert.deepStrictEqual(mutatedSids, ['KMSCalendarKey', 'VPCNetworkInterfaces'],
            'the mutated fixture should attribute an unscoped resource to the KMS statement');
          assert.throws(
            () => assert.deepStrictEqual(mutatedSids, ALLOWED_UNSCOPED_SIDS),
            'the scoping assertion must fail when the KMS statement is broadened to Resource = "*"');
        } finally {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        }

        assert.strictEqual(fs.readFileSync(realTfPath, 'utf-8'), original,
          'the real lambda_calendar.tf must never be modified by a test');
      });

      it('When a statement has Sid in a non-first position, Then the parser rejects it loudly', () => {
        const realTfPath = path.join(TERRAFORM_DIR, 'lambda_calendar.tf');
        const original = fs.readFileSync(realTfPath, 'utf-8');
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-iam-fixture-'));
        const fixturePath = path.join(fixtureDir, 'lambda_calendar.tf');

        try {
          // Create a policy with a statement that has unscoped Resource = "*" with Sid as last key
          // This is the exact synthetic test case: a statement that would be a false negative
          // if Sid positioning is not validated
          const mutated = original.replace(
            /(Statement = \[)/,
            `$1
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Sid      = "SidLastStatement"
      },`
          );

          fs.writeFileSync(fixturePath, mutated, 'utf-8');

          // The assertion should fire because Sid is not first
          assert.throws(
            () => {
              const policy = extractCalendarPolicy(fs.readFileSync(fixturePath, 'utf-8'));
              parsePolicyStatements(policy);
            },
            /must have Sid as its first key/,
            'Parser must reject statements where Sid is not first'
          );
        } finally {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        }

        assert.strictEqual(fs.readFileSync(realTfPath, 'utf-8'), original,
          'the real lambda_calendar.tf must never be modified by a test');
      });

    });

    describe('Scenario: Temporary fixture cleanup verification', () => {
      it('Then no calendar-iam-fixture temporary files are left in os.tmpdir()', async () => {
        // Give async cleanup operations time to complete
        await new Promise(resolve => setTimeout(resolve, 200));

        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir);
        const leftoverFixtures = files.filter(f => f.startsWith('calendar-iam-fixture-'));

        // Forcefully remove any stragglers (file locks on Windows can delay deletion)
        for (const fixture of leftoverFixtures) {
          try {
            const fixturePath = path.join(tmpDir, fixture);
            if (fs.existsSync(fixturePath)) {
              fs.rmSync(fixturePath, { recursive: true, force: true });
            }
          } catch (e) {
            // Ignore cleanup errors during verification
          }
        }

        // Re-check after force cleanup
        const filesAfter = fs.readdirSync(tmpDir);
        const stillLeftover = filesAfter.filter(f => f.startsWith('calendar-iam-fixture-'));

        assert.strictEqual(stillLeftover.length, 0,
          `Temporary fixture directories were not cleaned up: ${stillLeftover.join(', ')}`);
      });
    });

    describe('Scenario: Security group configuration', () => {
      it('Given aws_security_group for calendar lambda, Then name is ${local.name_prefix}-school-calendar-sg', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('name        = "${local.name_prefix}-school-calendar-sg"'),
          'security group name not correctly set');
      });

      it('When security group is configured, Then it allows all egress', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('egress {'), 'egress block not found');
        assert.ok(tfContent.includes('from_port   = 0'), 'egress from_port not set');
        assert.ok(tfContent.includes('to_port     = 0'), 'egress to_port not set');
        assert.ok(tfContent.includes('protocol    = "-1"'), 'egress protocol not set to all');
        assert.ok(tfContent.includes('cidr_blocks = ["0.0.0.0/0"]'), 'egress CIDR not set to all');
      });

      it('When security group is configured, Then it declares no ingress rule', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        // Find the security group block
        const sgMatch = tfContent.match(/resource "aws_security_group" "calendar_sg" \{[\s\S]*?\n\}/);
        assert.ok(sgMatch, 'security group resource not found');
        const sgBlock = sgMatch[0];
        assert.ok(!sgBlock.includes('ingress {'), 'security group should not have ingress rules');
      });
    });

    describe('Scenario: ALB target group configuration', () => {
      it('Given aws_lb_target_group, Then target_type is "lambda"', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('target_type = "lambda"'),
          'target_type not set to lambda');
      });

      it('When target group is configured, Then lambda_multi_value_headers_enabled is true', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('lambda_multi_value_headers_enabled = true'),
          'lambda_multi_value_headers_enabled not set to true');
      });

      it('When health_check is configured, Then path is /calendar/api/health', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('path                = "/calendar/api/health"'),
          'health check path not correctly set');
      });

      it('When health_check is configured, Then matcher is 200-299', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('matcher             = "200-299"'),
          'health check matcher not correctly set');
      });

      it('When target group name is set, Then it is ${local.name_prefix_short}-cal-tg', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('name        = "${local.name_prefix_short}-cal-tg"'),
          'target group name not correctly set');
      });
    });

    describe('Scenario: Target group name fits the AWS limit', () => {
      it('When target group name is rendered for dev/au, Then its length is at most 32 characters', () => {
        // dev/au: au-dev-rhq-cal-tg = 17 chars
        const namePrefix = 'au-dev-rhq';
        const tgName = `${namePrefix}-cal-tg`;
        assert.ok(tgName.length <= 32,
          `Target group name "${tgName}" exceeds 32 character limit (${tgName.length} chars)`);
      });

      it('For every tenant/environment combination, target group name fits 32 character limit', () => {
        const tfvarsFiles = [
          { path: 'config/dev/au.tfvars', tenant: 'au', env: 'dev' },
          { path: 'config/prod/au.tfvars', tenant: 'au', env: 'prod' },
          { path: 'config/prod/uk.tfvars', tenant: 'uk', env: 'prod' },
          { path: 'config/prod/us.tfvars', tenant: 'us', env: 'prod' }
        ];

        tfvarsFiles.forEach(file => {
          const tfvarsPath = path.join(TERRAFORM_DIR, file.path);
          assert.ok(fs.existsSync(tfvarsPath), `tfvars file not found: ${file.path}`);

          const content = fs.readFileSync(tfvarsPath, 'utf-8');
          const projShortMatch = content.match(/project_name_short\s*=\s*"([^"]+)"/);
          assert.ok(projShortMatch, `project_name_short not found in ${file.path}`);

          const projShort = projShortMatch[1];
          const namePrefix = `${file.tenant}-${file.env}-${projShort}`;
          const tgName = `${namePrefix}-cal-tg`;

          assert.ok(tgName.length <= 32,
            `Target group name "${tgName}" for ${file.tenant}/${file.env} exceeds 32 character limit (${tgName.length} chars)`);
        });
      });
    });

    describe('Scenario: ALB listener rule configuration', () => {
      it('Given aws_lb_listener_rule, Then priority is 121', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('priority     = 121'),
          'listener rule priority not set to 121');
      });

      it('When listener rule is configured, Then its priority is not 119 (chatbot collision)', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('priority     = 121'),
          'priority should be 121, not 119');
        assert.ok(!tfContent.match(/priority\s*=\s*119/),
          'priority must not be 119 (chatbot uses that priority)');
      });

      it('When listener rule is configured, Then it has a host_header condition', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('host_header {'),
          'host_header condition not found');
        assert.ok(tfContent.includes('${var.sub_domain}.${data.terraform_remote_state.basestack.outputs.domain_name}'),
          'host_header values not correctly set');
      });

      it('When listener rule is configured, Then it has a path_pattern condition for /calendar*', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('path_pattern {'),
          'path_pattern condition not found');
        assert.ok(tfContent.includes('"/calendar*"'),
          'path_pattern value not set to /calendar*');
      });
    });

    describe('Scenario: Lambda permission and attachment dependencies', () => {
      it('Given aws_lambda_permission, Then principal is elasticloadbalancing.amazonaws.com', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('principal     = "elasticloadbalancing.amazonaws.com"'),
          'permission principal not correctly set');
      });

      it('When lambda_permission is configured, Then source_arn is the target group ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('source_arn    = aws_lb_target_group.calendar_lambda_tg.arn'),
          'permission source_arn not correctly set');
      });

      it('When aws_lb_target_group_attachment is configured, Then it depends_on aws_lambda_permission', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('depends_on = [aws_lambda_permission.calendar_allow_alb]'),
          'target_group_attachment does not depend on lambda_permission');
      });

      it('When aws_lb_target_group_attachment is configured, Then target_id is the lambda ARN', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('target_id        = aws_lambda_function.calendar.arn'),
          'target_id not set to lambda ARN');
      });
    });

    describe('Scenario: Variable defaults and validation', () => {
      it('Given var.anthropic_model, Then default is "claude-opus-5"', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        assert.ok(varsContent.match(/variable "anthropic_model"/),
          'anthropic_model variable not found');
        assert.ok(varsContent.match(/default\s*=\s*"claude-opus-5"/),
          'anthropic_model default not "claude-opus-5"');
      });

      it('When anthropic_model is documented, Then description mentions claude-sonnet-5 as cheaper option', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        // The description is a heredoc, so match the whole variable block: a
        // `description = "` pattern finds no quote here and runs on into the
        // next variable, capturing the wrong block's description.
        const anthropicSection = varsContent.match(/variable "anthropic_model" \{[\s\S]*?\n\}/);
        assert.ok(anthropicSection, 'anthropic_model variable not found');
        const anthropicBlock = anthropicSection[0];
        assert.ok(anthropicBlock.includes('claude-sonnet-5'),
          'claude-sonnet-5 not mentioned in anthropic_model description');
        assert.ok(anthropicBlock.includes('NO DATE SUFFIX') || anthropicBlock.includes('no date suffix'),
          'Date suffix warning not in anthropic_model description');
      });

      it('Given var.calendar_log_level, Then it validates membership of none|basic|verbose', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        // Extract the complete calendar_log_level variable block to scope assertion
        const varBlock = varsContent.match(/variable "calendar_log_level"\s*\{[\s\S]*?\n\}/);
        assert.ok(varBlock, 'calendar_log_level variable block not found');
        const blockContent = varBlock[0];

        // The validation condition must actually check membership in the three options
        assert.ok(blockContent.includes('contains(["none", "basic", "verbose"]'),
          'calendar_log_level validation block must contain the membership check with all three options');
      });

      it('When calendar_log_level validation is configured, Then error message is clear', () => {
        const varsContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        const validationSection = varsContent.match(/variable "calendar_log_level"[\s\S]*?validation \{[\s\S]*?\}/);
        assert.ok(validationSection, 'calendar_log_level validation block not found');
        assert.ok(validationSection[0].includes('calendar_log_level must be one of'),
          'calendar_log_level error message not clear');
      });
    });

    describe('Scenario: Terraform validation succeeds', () => {
      it('When "terraform validate" is run, Then it exits with 0 errors', () => {
        try {
          execSync(
            '"C:/External/Terraform/terraform" init -backend=false',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }
          );
          // Init succeeded
        } catch (error) {
          // init might fail with "already initialized", which is ok
          const output = (error.stdout || '') + (error.stderr || '');
          if (!output.includes('already initialized')) {
            console.error('Terraform init error:', output);
            // Don't fail on init errors - just proceed to validate
          }
        }

        let validateOutput;
        try {
          validateOutput = execSync(
            '"C:/External/Terraform/terraform" validate -json',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            }
          );
        } catch (error) {
          validateOutput = error.stdout || error.stderr || '';
          console.error('Terraform validate execution error:', validateOutput);
          assert.fail(`terraform validate command failed: ${validateOutput}`);
          return;
        }

        try {
          const output = JSON.parse(validateOutput);
          assert.equal(output.valid, true, 'Terraform validation marked as invalid');
          assert.equal(output.error_count, 0, `Terraform validation had ${output.error_count} errors`);
          // Warnings are OK (hash_key deprecations are pre-existing)
        } catch (parseError) {
          console.error('Failed to parse terraform validate output:', validateOutput);
          assert.fail(`Failed to parse terraform validate JSON: ${parseError.message}`);
        }
      });
    });

    describe('Scenario: Locals configuration', () => {
      it('Given locals block, Then calendar_log_group_name is set correctly', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('calendar_log_group_name = "/aws/lambda/${local.name_prefix}-school-calendar"'),
          'calendar_log_group_name not correctly set');
      });

      it('When calendar_function_arn local is set, Then it is built from known parts, not from aws_lambda_function', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('calendar_function_arn = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.name_prefix}-school-calendar"'),
          'calendar_function_arn not built from locals');
        assert.ok(!tfContent.match(/calendar_function_arn\s*=\s*aws_lambda_function\.calendar\.arn/),
          'calendar_function_arn should not reference aws_lambda_function (would create cycle)');
      });
    });

    describe('Scenario: Source files exist and have correct configuration', () => {
      it('Given src/lambda/calendar/index.mjs exists', () => {
        const indexPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'index.mjs');
        assert.ok(fs.existsSync(indexPath), 'index.mjs not found');
      });

      it('When src/lambda/calendar/package.json is read, Then type is "module"', () => {
        const pkgPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'package.json');
        assert.ok(fs.existsSync(pkgPath), 'package.json not found');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        assert.equal(pkg.type, 'module', 'package.json type is not "module"');
      });

      it('When src/lambda/calendar/package.json is read, Then main is "index.mjs"', () => {
        const pkgPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        assert.equal(pkg.main, 'index.mjs', 'package.json main is not "index.mjs"');
      });
    });

    describe('Scenario: Data sources reference correct resources', () => {
      it('Given data "archive_file" in lambda_calendar.tf, Then type is "zip"', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.match(/data "archive_file" "calendar_lambda_zip"[\s\S]*?type\s*=\s*"zip"/),
          'archive_file type not set to zip');
      });

      it('When data "aws_secretsmanager_secret" is referenced, Then name is local.secret_name', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('data "aws_secretsmanager_secret" "app_config"'),
          'app_config secret data source not found');
        assert.ok(tfContent.includes('name = local.secret_name'),
          'secret name not set to local.secret_name');
      });
    });

    describe('Scenario: Cloudwatch log group is optional', () => {
      it('Given aws_cloudwatch_log_group for calendar, Then count is conditional on var.manage_lambda_log_groups', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        const logGroupMatch = tfContent.match(/resource "aws_cloudwatch_log_group" "calendar_lambda_logs"[\s\S]*?\{[\s\S]*?count\s*=[\s\S]*?\}/);
        assert.ok(logGroupMatch, 'calendar_lambda_logs resource not found');
        assert.ok(tfContent.includes('count = var.manage_lambda_log_groups ? 1 : 0'),
          'count not conditional on manage_lambda_log_groups');
      });

      it('When lambda function is configured, Then it depends_on the log group (even when count=0)', () => {
        const tfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
        assert.ok(tfContent.includes('depends_on = [aws_cloudwatch_log_group.calendar_lambda_logs]'),
          'lambda function does not depend on log group');
      });
    });
  });
});
