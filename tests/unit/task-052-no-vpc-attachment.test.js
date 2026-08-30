/**
 * TASK-052 unit coverage: the calendar Lambda's VPC attachment, the security
 * group that only existed to satisfy it, the VPCNetworkInterfaces IAM statement
 * and the basestack remote state (its data source, its variable and its tfvars
 * key) are all removed - together, and documented where they used to be.
 *
 * Pure over strings. Every assertion here reads terraform source text off disk
 * and parses it. NO DATABASE CONNECTION IS EVER OPENED: no AWS SDK client is
 * constructed, no DynamoDB/KMS/Secrets Manager call is made, no terraform binary
 * is invoked and no network or AWS credential is touched. The DynamoDB table
 * names that appear below are terraform source text, not endpoints.
 *
 * The matching cucumber-style e2e scenarios (which DO execute terraform) live in
 * tests/e2e/task-052-no-vpc-attachment.test.js.
 */

import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStatementArray, parsePolicyStatements } from '../helpers/hcl-blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

/**
 * Drop whole-line `#` / `//` comments. TASK-052 deliberately leaves long
 * comments NAMING everything it deleted (vpc_config, aws_security_group,
 * subnet_ids, the basestack state) so a future reader understands the decision.
 * Every "is it gone?" assertion therefore has to read CODE only, or it would
 * match the explanatory prose and fail for the wrong reason.
 */
function codeOnly(content) {
  return content.split('\n').filter(line => !/^\s*(#|\/\/)/.test(line)).join('\n');
}

function commentsOnly(content) {
  return content.split('\n').filter(line => /^\s*(#|\/\/)/.test(line)).join('\n');
}

function listTfFiles() {
  return fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf')).sort();
}

/** Brace-match a top-level `resource "TYPE" "NAME" { ... }` block. */
function extractResourceBlock(content, type, name) {
  const header = new RegExp(`resource\\s+"${type}"\\s+"${name}"\\s*\\{`);
  const match = header.exec(content);
  if (!match) return null;
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(match.index, i + 1);
    }
  }
  return null;
}

function calendarPolicyStatements() {
  const match = codeOnly(readTf('lambda_calendar.tf')).match(/policy = jsonencode\(\{[\s\S]*?\}\)/);
  assert.ok(match, 'the calendar inline IAM policy was not found');
  return parsePolicyStatements(extractStatementArray(match[0]));
}

// Every identifier TASK-052 removed. None may appear in CODE anywhere under
// terraform/ - comments are expected to mention all of them.
const FORBIDDEN_CODE_TOKENS = [
  'terraform_remote_state.basestack',
  'terraform_remote_state_basestack_config',
  'aws_security_group',
  'vpc_config',
  'subnet_ids',
  'security_group_ids',
  'vpc_id'
];

describe('TASK-052 unit: the calendar Lambda has no VPC attachment and no basestack remote state', () => {

  // ---------------------------------------------------------------------------
  describe('the comment-stripping helper these assertions depend on', () => {
    // If codeOnly() stripped too much, every absence assertion below would be
    // vacuous and "prove" anything is gone. So it is covered first.
    it('removes whole-line # and // comments but keeps code and trailing comments', () => {
      const source = [
        '# the vpc_config block was removed by TASK-052',
        '  // so was aws_security_group.calendar_sg',
        'resource "aws_lambda_function" "calendar" {',
        '  function_name = "x" # trailing comments stay on their code line',
        '}'
      ].join('\n');
      const code = codeOnly(source);
      assert.ok(!code.includes('vpc_config'), 'a full-line # comment survived');
      assert.ok(!code.includes('aws_security_group'), 'a full-line // comment survived');
      assert.ok(code.includes('resource "aws_lambda_function" "calendar" {'), 'code was stripped');
      assert.ok(code.includes('trailing comments stay'), 'a trailing comment was wrongly removed');
    });

    it('commentsOnly() is the exact inverse, so documentation assertions cannot read code', () => {
      const source = '# doc line\nresource "x" "y" {}\n';
      assert.equal(commentsOnly(source).trim(), '# doc line');
      assert.ok(!commentsOnly(source).includes('resource'), 'commentsOnly leaked a code line');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: aws_lambda_function.calendar declares no vpc_config block', () => {
    let lambdaBlock;

    before(() => {
      lambdaBlock = extractResourceBlock(
        codeOnly(readTf('lambda_calendar.tf')), 'aws_lambda_function', 'calendar');
      assert.ok(lambdaBlock, 'aws_lambda_function.calendar not found');
    });

    it('declares no vpc_config block and no empty placeholder', () => {
      assert.ok(!/vpc_config\s*\{/.test(lambdaBlock), 'a vpc_config block survives');
      assert.ok(!/vpc_config\s*=/.test(lambdaBlock), 'a vpc_config assignment survives');
      assert.ok(!lambdaBlock.includes('vpc_config'), 'vpc_config is still named in code');
    });

    it('names neither subnet_ids nor security_group_ids', () => {
      assert.ok(!lambdaBlock.includes('subnet_ids'), 'subnet_ids survives');
      assert.ok(!lambdaBlock.includes('security_group_ids'), 'security_group_ids survives');
    });

    it('and the whole file names neither, in any other resource either', () => {
      const code = codeOnly(readTf('lambda_calendar.tf'));
      assert.ok(!code.includes('subnet_ids'), 'subnet_ids survives elsewhere in lambda_calendar.tf');
      assert.ok(!code.includes('security_group_ids'), 'security_group_ids survives elsewhere in lambda_calendar.tf');
      assert.ok(!code.includes('vpc_config'), 'vpc_config survives elsewhere in lambda_calendar.tf');
    });

    it('but the function itself, its runtime and its handler are still there (this removes wiring, not the Lambda)', () => {
      assert.match(lambdaBlock, /function_name\s+=\s+"\$\{local\.name_prefix\}-school-calendar"/,
        'the calendar function_name changed or the function is gone');
      assert.match(lambdaBlock, /runtime\s+=\s+"nodejs24\.x"/, 'the runtime changed');
      assert.match(lambdaBlock, /handler\s+=\s+"index\.handler"/, 'the handler changed');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: no aws_security_group or aws_security_group_rule exists anywhere under terraform/', () => {
    it('no .tf file declares an aws_security_group resource', () => {
      const offenders = listTfFiles()
        .filter(file => /resource\s+"aws_security_group"/.test(codeOnly(readTf(file))));
      assert.deepEqual(offenders, [], `security groups survive in: ${offenders.join(', ')}`);
    });

    it('no .tf file declares an aws_security_group_rule resource', () => {
      const offenders = listTfFiles()
        .filter(file => /resource\s+"aws_security_group_rule"/.test(codeOnly(readTf(file))));
      assert.deepEqual(offenders, [], `security group rules survive in: ${offenders.join(', ')}`);
    });

    it('no .tf file mentions aws_security_group in code at all, not even as a reference', () => {
      const offenders = listTfFiles()
        .filter(file => codeOnly(readTf(file)).includes('aws_security_group'));
      assert.deepEqual(offenders, [], `aws_security_group is still referenced in: ${offenders.join(', ')}`);
    });

    it('and no orphaned egress/ingress rule or vpc_id survives in lambda_calendar.tf', () => {
      const code = codeOnly(readTf('lambda_calendar.tf'));
      assert.ok(!/^\s*egress\s*\{/m.test(code), 'an egress block survives with no security group to own it');
      assert.ok(!/^\s*ingress\s*\{/m.test(code), 'an ingress block survives with no security group to own it');
      assert.ok(!code.includes('cidr_blocks'), 'a cidr_blocks assignment survives');
      assert.ok(!code.includes('vpc_id'), 'a vpc_id assignment survives');
    });

    it('and the resource-block extractor is discriminating: it finds a security group in a fixture', () => {
      const fixture = [
        'resource "aws_security_group" "calendar_sg" {',
        '  vpc_id = "vpc-1"',
        '  egress {',
        '    from_port = 0',
        '  }',
        '}'
      ].join('\n');
      assert.ok(extractResourceBlock(fixture, 'aws_security_group', 'calendar_sg'),
        'the extractor cannot find a security group it is supposed to catch');
      assert.ok(/resource\s+"aws_security_group"/.test(codeOnly(fixture)),
        'the scan regex cannot see a security group it is supposed to catch');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: the VPCNetworkInterfaces IAM statement is gone and the description no longer claims VPC', () => {
    let statements;
    let policyBlock;

    before(() => {
      statements = calendarPolicyStatements();
      policyBlock = extractResourceBlock(
        codeOnly(readTf('lambda_calendar.tf')), 'aws_iam_policy', 'calendar_lambda_policy');
      assert.ok(policyBlock, 'aws_iam_policy.calendar_lambda_policy not found');
    });

    it('parses to exactly the four surviving statements', () => {
      assert.deepEqual(statements.map(s => s.sid).sort(),
        ['CloudWatchLogs', 'DynamoDBCalendarTables', 'KMSCalendarKey', 'SecretsManagerAppConfig'],
        `unexpected statement set: ${statements.map(s => s.sid).join(', ')}`);
    });

    it('grants no ec2 action of any kind', () => {
      const policyText = statements.map(s => s.body).join('\n');
      assert.ok(!/ec2:\w*NetworkInterface\w*/.test(policyText), 'an ENI action survives');
      assert.ok(!/ec2:\w*PrivateIpAddresses/.test(policyText), 'a private-IP action survives');
      assert.ok(!/"ec2:/.test(policyText), 'some ec2:* action survives');
    });

    it('has a description that names CloudWatch Logs, DynamoDB, KMS and Secrets Manager but not VPC', () => {
      const description = policyBlock.match(/description\s*=\s*"([^"]*)"/);
      assert.ok(description, 'the policy has no description');
      assert.ok(!/VPC/i.test(description[1]), `the description still claims VPC: ${description[1]}`);
      for (const claim of ['CloudWatch Logs', 'DynamoDB', 'KMS', 'Secrets Manager']) {
        assert.ok(description[1].includes(claim), `the description no longer names ${claim}`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: no statement uses Resource = "*" and the four survivors keep their exact resources', () => {
    let byId;

    before(() => {
      byId = new Map(calendarPolicyStatements().map(s => [s.sid, s.body]));
    });

    const resourceOf = sid => {
      const body = byId.get(sid);
      assert.ok(body, `statement "${sid}" is missing`);
      const match = body.match(/Resource\s*=\s*([^\n]+)/);
      assert.ok(match, `statement "${sid}" has no Resource assignment`);
      return match[1].trim().replace(/,$/, '');
    };

    it('no statement assigns Resource = "*"', () => {
      const unscoped = [...byId.entries()]
        .filter(([, body]) => /Resource\s*=\s*"\*"/.test(body))
        .map(([sid]) => sid);
      assert.deepEqual(unscoped, [], `unscoped statements survive: ${unscoped.join(', ')}`);
    });

    it('every statement still names a Resource, so nothing hides by omitting it', () => {
      for (const [sid, body] of byId) {
        assert.match(body, /Resource\s*=/, `statement "${sid}" has no Resource assignment at all`);
      }
    });

    it('CloudWatchLogs keeps "arn:aws:logs:*:*:*" byte-for-byte', () => {
      assert.equal(resourceOf('CloudWatchLogs'), '"arn:aws:logs:*:*:*"');
    });

    it('DynamoDBCalendarTables keeps both table ARNs and the events index ARN byte-for-byte', () => {
      const list = byId.get('DynamoDBCalendarTables')
        .match(/Resource\s*=\s*\[([\s\S]*?)\]/)[1]
        .split(',').map(e => e.trim()).filter(Boolean);
      assert.deepEqual(list, [
        'aws_dynamodb_table.calendar_connections.arn',
        'aws_dynamodb_table.calendar_events.arn',
        '"${aws_dynamodb_table.calendar_events.arn}/index/*"'
      ]);
    });

    it('KMSCalendarKey keeps aws_kms_key.calendar.arn byte-for-byte', () => {
      assert.equal(resourceOf('KMSCalendarKey'), 'aws_kms_key.calendar.arn');
    });

    it('SecretsManagerAppConfig keeps data.aws_secretsmanager_secret.app_config.arn byte-for-byte', () => {
      assert.equal(resourceOf('SecretsManagerAppConfig'), 'data.aws_secretsmanager_secret.app_config.arn');
    });

    it('FAILURE PATH: the same unscoped-resource scan flags a mutated copy that broadens KMS to "*"', () => {
      // Proves the "no statement is unscoped" assertion is discriminating and
      // not passing because the scan never matches anything. The mutation is
      // applied to an in-memory string; nothing on disk is touched.
      const original = codeOnly(readTf('lambda_calendar.tf'));
      const mutated = original.replace(/Resource = aws_kms_key\.calendar\.arn/, 'Resource = "*"');
      assert.notStrictEqual(mutated, original,
        'the fixture mutation did not apply - the KMS Resource assignment was not found');

      const mutatedUnscoped = parsePolicyStatements(
        extractStatementArray(mutated.match(/policy = jsonencode\(\{[\s\S]*?\}\)/)[0]))
        .filter(s => /Resource\s*=\s*"\*"/.test(s.body))
        .map(s => s.sid);
      assert.deepEqual(mutatedUnscoped, ['KMSCalendarKey'],
        'the scan does not attribute an unscoped Resource to the broadened KMS statement');

      // ...and the file on disk is untouched by this test.
      assert.equal(codeOnly(readTf('lambda_calendar.tf')), original,
        'the real lambda_calendar.tf must never be modified by a test');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: the basestack remote state, its variable and its tfvars key are gone together', () => {
    it('provider.tf declares no data "terraform_remote_state" "basestack"', () => {
      const code = codeOnly(readTf('provider.tf'));
      assert.ok(!/data\s+"terraform_remote_state"\s+"basestack"/.test(code),
        'the basestack data source survives');
      assert.ok(!code.includes('terraform_remote_state'),
        'provider.tf still names terraform_remote_state in code');
    });

    it('variables.tf declares no variable "terraform_remote_state_basestack_config"', () => {
      const code = codeOnly(readTf('variables.tf'));
      assert.ok(!/^\s*variable\s+"terraform_remote_state_basestack_config"/m.test(code),
        'the variable declaration survives');
    });

    it('config/dev/au.tfvars assigns no terraform_remote_state_basestack_config key', () => {
      const code = codeOnly(readTf('config', 'dev', 'au.tfvars'));
      assert.ok(!/^\s*terraform_remote_state_basestack_config\s*=/m.test(code),
        'the tfvars key survives with no declaration - terraform would warn "Value for undeclared variable"');
      assert.ok(!code.includes('basestack'), 'dev/au.tfvars still names basestack in code');
      assert.ok(!code.includes('tfstate'), 'dev/au.tfvars still names a tfstate object in code');
    });

    it('FAILURE PATH: declaration and tfvars key must not desync - neither side survives alone', () => {
      // The hazard TASK-051 warned about and TASK-052 avoided: an orphaned
      // tfvars key only WARNS, but a declaration with no default and no value is
      // a hard "No value for required variable". Both directions are asserted so
      // a half-done removal cannot pass.
      const variablesCode = codeOnly(readTf('variables.tf'));
      const tfvarsCode = codeOnly(readTf('config', 'dev', 'au.tfvars'));
      const declared = /^\s*variable\s+"terraform_remote_state_basestack_config"/m.test(variablesCode);
      const assigned = /^\s*terraform_remote_state_basestack_config\s*=/m.test(tfvarsCode);
      assert.equal(declared, false, 'the declaration survives without a tfvars value: hard error on plan');
      assert.equal(assigned, false, 'the tfvars key survives without a declaration: "Value for undeclared variable"');
      assert.equal(declared, assigned,
        'declaration and tfvars key are out of sync - they must be removed in the same change');
    });

    it('no file under terraform/ references any removed identifier in CODE', () => {
      const offenders = [];
      for (const file of [...listTfFiles(), 'config/dev/au.tfvars']) {
        const code = codeOnly(readTf(...file.split('/')));
        for (const token of FORBIDDEN_CODE_TOKENS) {
          if (code.includes(token)) offenders.push(`${file} -> ${token}`);
        }
      }
      assert.deepEqual(offenders, [], `TASK-052 identifiers survive in code: ${offenders.join(', ')}`);
    });

    it('and the forbidden-token sweep is discriminating in both directions', () => {
      const asCode = FORBIDDEN_CODE_TOKENS.map(t => `x = ${t}`).join('\n');
      assert.deepEqual(FORBIDDEN_CODE_TOKENS.filter(t => codeOnly(asCode).includes(t)),
        FORBIDDEN_CODE_TOKENS, 'the sweep misses tokens it is supposed to catch');
      const asComments = FORBIDDEN_CODE_TOKENS.map(t => `# removed: ${t}`).join('\n');
      assert.deepEqual(FORBIDDEN_CODE_TOKENS.filter(t => codeOnly(asComments).includes(t)),
        [], 'the sweep treats a comment mention as a live code reference');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: the removal is documented, and no stale load-bearing comment survives', () => {
    it('lambda_calendar.tf documents the no-VPC placement as deliberate', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /deliberate/i, 'nothing says the no-VPC placement is deliberate');
      assert.match(comments, /do not "?restore"?|NOT ATTACHED TO ANY VPC|HAS NO `?vpc_config/i,
        'nothing warns a future reader against "restoring" the VPC attachment');
    });

    it('and names what it gives up: no fixed NAT egress IP, no network-layer isolation', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /NAT/, 'the NAT egress IP loss is not named');
      assert.match(comments, /egress IP|static source IP/i, 'the fixed/static source IP loss is not named');
      assert.match(comments, /network-layer isolation|network layer isolation/i,
        'the network-layer isolation loss is not named');
    });

    it('and why it is safe here: no VPC endpoints, no source-VPC IAM conditions, all public endpoints', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /vpc_endpoint|VPC endpoint|PrivateLink/i, 'VPC endpoints are not addressed');
      assert.match(comments, /SourceVpc/i, 'source-VPC IAM/KMS conditions are not addressed');
      assert.match(comments, /PUBLIC endpoint/i, 'the "everything is a public endpoint" argument is missing');
    });

    it('and warns about the DependencyViolation ENI-cleanup hazard on a real apply', () => {
      assert.match(commentsOnly(readTf('lambda_calendar.tf')), /DependencyViolation/,
        'nothing warns that the first apply can fail to delete the SG while AWS reaps the ENIs');
    });

    it('variables.tf and provider.tf carry no stale load-bearing / do-not-remove / NOT dead claims', () => {
      for (const file of ['variables.tf', 'provider.tf']) {
        const comments = commentsOnly(readTf(file));
        assert.ok(!/load[- ]bearing/i.test(comments), `${file} still claims something is load-bearing`);
        assert.ok(!/do not remove/i.test(comments), `${file} still says "do not remove" about a deleted thing`);
        assert.ok(!/is NOT dead/i.test(comments), `${file} still says a deleted declaration is "NOT dead"`);
      }
    });

    it('and the comment check is discriminating: the OLD provider.tf comment WOULD have failed it', () => {
      // The exact prose that used to sit above data.terraform_remote_state.basestack.
      const oldComment = [
        '# Read (not written) by this stack: outputs.vpc_id and outputs.private_subnet_ids',
        '# wire the Lambda into the VPC in lambda_calendar.tf. Do not remove - the',
        '# companion `legacystack` remote state was dead and was deleted by TASK-051,',
        '# this one is load-bearing.'
      ].join('\n');
      assert.ok(/load[- ]bearing/i.test(commentsOnly(oldComment)),
        'the stale-comment check cannot detect the very comment it exists to catch');
      assert.ok(/do not remove/i.test(commentsOnly(oldComment)),
        'the stale-comment check cannot detect a "Do not remove" claim');
    });
  });

  // ---------------------------------------------------------------------------
  describe('AC: function identity is preserved', () => {
    let code;

    before(() => { code = codeOnly(readTf('lambda_calendar.tf')); });

    it('function_name is still "${local.name_prefix}-school-calendar"', () => {
      assert.ok(code.includes('function_name    = "${local.name_prefix}-school-calendar"'),
        'the function_name changed; a renamed function gets a NEW function URL id');
    });

    it('aws_lambda_function_url.calendar is still declared, attached to the calendar function, with authorization_type NONE', () => {
      const block = extractResourceBlock(code, 'aws_lambda_function_url', 'calendar');
      assert.ok(block, 'aws_lambda_function_url.calendar is gone');
      assert.ok(block.includes('aws_lambda_function.calendar.function_name'),
        'the function URL is no longer attached to the calendar Lambda');
      assert.match(block, /authorization_type\s*=\s*"NONE"/, 'authorization_type changed');
    });

    it('aws_lambda_permission.calendar_allow_function_url still grants lambda:InvokeFunctionUrl to "*" with auth type NONE', () => {
      const block = extractResourceBlock(code, 'aws_lambda_permission', 'calendar_allow_function_url');
      assert.ok(block, 'aws_lambda_permission.calendar_allow_function_url is gone');
      assert.match(block, /action\s*=\s*"lambda:InvokeFunctionUrl"/, 'the granted action changed');
      assert.match(block, /principal\s*=\s*"\*"/, 'the principal changed');
      assert.match(block, /function_url_auth_type\s*=\s*"NONE"/, 'the function_url_auth_type changed');
    });

    it('and the public origin is still published as output "calendar_function_url"', () => {
      assert.match(code, /output "calendar_function_url" \{[\s\S]*?aws_lambda_function_url\.calendar\.function_url/,
        'the calendar_function_url output no longer exposes the function URL');
    });
  });
});
