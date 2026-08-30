/**
 * TASK-052 e2e (cucumber-style Given/When/Then) scenarios: the calendar Lambda
 * runs with NO VPC attachment, and the basestack remote state that only existed
 * to feed that attachment is removed with it.
 *
 * These are the ticket's Gherkin scenarios implemented as `node --test` cases.
 * No cucumber package is installed and none is required. Where a scenario is
 * about what terraform ACTUALLY does (validation, evaluation, undeclared
 * variables, dangling references), it is executed with the real terraform
 * binary. Mutation scenarios build a throwaway, provider-free workspace under
 * os.tmpdir(); the real terraform/ directory is never mutated.
 *
 * NO DATABASE CONNECTION IS EVER OPENED by this file. The DynamoDB tables named
 * here are terraform source text read off disk as strings; no AWS SDK client is
 * constructed, no DynamoDB/KMS/Secrets Manager call is made and no AWS
 * credential is used. `terraform validate` and `terraform console` are run
 * offline (`-backend=false`, no provider configuration in the fixtures), and
 * `terraform plan`/`apply` against the real stack is never invoked.
 *
 * The matching unit coverage lives in tests/unit/task-052-no-vpc-attachment.test.js.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStatementArray, parsePolicyStatements } from '../helpers/hcl-blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');
const DEV_AU_VAR_FILE = 'config/dev/au.tfvars';

// Every identifier TASK-052 removed. None may appear in CODE (comments are
// stripped first - the ticket deliberately leaves long comments NAMING each of
// these to explain the removal, and a raw scan would match that prose).
const FORBIDDEN_CODE_TOKENS = [
  'terraform_remote_state.basestack',
  'terraform_remote_state_basestack_config',
  'aws_security_group',
  'vpc_config',
  'subnet_ids',
  'security_group_ids',
  'vpc_id'
];

// -----------------------------------------------------------------------------
// source-reading helpers
// -----------------------------------------------------------------------------

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

/** Drop whole-line `#` / `//` comments, leaving code. */
function codeOnly(content) {
  return content.split('\n').filter(line => !/^\s*(#|\/\/)/.test(line)).join('\n');
}

/** The inverse - comment text only, for asserting a removal is documented. */
function commentsOnly(content) {
  return content.split('\n').filter(line => /^\s*(#|\/\/)/.test(line)).join('\n');
}

function listTfFiles() {
  return fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf')).sort();
}

/**
 * Normalise CRLF to LF before a byte-for-byte comparison.
 *
 * `git show HEAD:<path>` emits the blob with LF endings; the same file checked
 * out in this Windows worktree has CRLF. Without this, "unchanged" comparisons
 * below would fail on every line of every block for a reason that has nothing
 * to do with the ticket. Only the newline representation is normalised -
 * whitespace, ordering and every character of content are still compared
 * exactly.
 */
const normalizeEol = text => text.replace(/\r\n/g, '\n');

/** The committed (pre-change) contents of a file under terraform/. */
function readTfAtHead(relativePath) {
  return normalizeEol(execFileSync('git', ['show', `HEAD:terraform/${relativePath}`], {
    cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000
  }));
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

/** The calendar IAM policy body with comment lines stripped. */
function calendarPolicyText() {
  const match = codeOnly(readTf('lambda_calendar.tf')).match(/policy = jsonencode\(\{[\s\S]*?\}\)/);
  assert.ok(match, 'the calendar inline IAM policy was not found in lambda_calendar.tf');
  return match[0];
}

// -----------------------------------------------------------------------------
// terraform binary + throwaway workspace plumbing
// -----------------------------------------------------------------------------

function resolveTerraformBin() {
  const candidates = ['C:/External/Terraform/terraform.exe', 'C:/External/Terraform/terraform'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    execFileSync('terraform', ['version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  } catch (error) {
    throw new Error(
      `Could not resolve a terraform binary. Tried ${candidates.join(', ')} (neither exists) ` +
      `and "terraform" on PATH, which failed: ${describeExecError(error)}`);
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

/**
 * Build a throwaway workspace from { filename: contents } and run
 * `terraform init -backend=false` once. No provider block is declared in any
 * fixture here, so init downloads nothing and needs no AWS credentials.
 */
function makeWorkspace(files, { copyConfig = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-052-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(workspace, name), contents, 'utf-8');
    }
    if (copyConfig) fs.cpSync(CONFIG_DIR, path.join(workspace, 'config'), { recursive: true });
    execFileSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
  } catch (error) {
    removeWorkspace(workspace);
    throw new Error(`Failed to prepare terraform workspace: ${describeExecError(error)}`);
  }
  return workspace;
}

function validateJson(workspace) {
  let stdout;
  try {
    stdout = execFileSync(TERRAFORM_BIN, ['validate', '-json'], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
  } catch (error) {
    stdout = (error.stdout || '').toString();
    if (!stdout.trim()) throw new Error(`terraform validate produced no JSON: ${describeExecError(error)}`);
  }
  return JSON.parse(stdout);
}

function tryConsole(workspace, expression, varFileArgs = []) {
  try {
    const stdout = execFileSync(TERRAFORM_BIN, ['console', '-no-color', ...varFileArgs], {
      cwd: workspace, input: `${expression}\n`, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
    const clean = stdout.replace(/\[[0-9;]*m/g, '');
    return { ok: true, raw: clean, value: (clean.match(/"((?:[^"\\]|\\.)*)"/) || [])[1] };
  } catch (error) {
    return { ok: false, error: describeExecError(error) };
  }
}

function tryPlan(workspace, varFileArgs = []) {
  try {
    const stdout = execFileSync(TERRAFORM_BIN, ['plan', '-input=false', '-no-color', ...varFileArgs], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return {
      ok: false,
      output: `${(error.stdout || '').toString()}\n${(error.stderr || '').toString()}`,
      error: describeExecError(error)
    };
  }
}

// =============================================================================
describe('Feature: The calendar Lambda runs with no VPC attachment (TASK-052)', () => {

  // ---------------------------------------------------------------------------
  describe('Scenario: The Lambda declares no VPC configuration', () => {
    let lambdaBlock;

    before(() => {
      lambdaBlock = extractResourceBlock(
        codeOnly(readTf('lambda_calendar.tf')), 'aws_lambda_function', 'calendar');
      assert.ok(lambdaBlock,
        'aws_lambda_function.calendar was not found at all - this ticket removes its vpc_config, not the function');
    });

    it('Given terraform/lambda_calendar.tf, When the aws_lambda_function "calendar" block is read, Then it contains no "vpc_config" block', () => {
      assert.ok(!/vpc_config\s*\{/.test(lambdaBlock),
        'aws_lambda_function.calendar still declares a vpc_config block');
      assert.ok(!lambdaBlock.includes('vpc_config'),
        'aws_lambda_function.calendar still mentions vpc_config in code - not even an empty placeholder is allowed');
    });

    it('And it references no subnet_ids and no security_group_ids', () => {
      assert.ok(!lambdaBlock.includes('subnet_ids'),
        'aws_lambda_function.calendar still references subnet_ids');
      assert.ok(!lambdaBlock.includes('security_group_ids'),
        'aws_lambda_function.calendar still references security_group_ids');
      assert.ok(!lambdaBlock.includes('terraform_remote_state'),
        'aws_lambda_function.calendar still reads a terraform_remote_state output');
    });

    it('And the block-extractor used here is discriminating: it finds vpc_config in a fixture that has one', () => {
      // Without this, the two assertions above could pass simply because the
      // extractor returned a block that never contained the keys anyway.
      const fixture = [
        'resource "aws_lambda_function" "calendar" {',
        '  function_name = "x"',
        '  vpc_config {',
        '    subnet_ids         = ["subnet-1"]',
        '    security_group_ids = ["sg-1"]',
        '  }',
        '}'
      ].join('\n');
      const block = extractResourceBlock(fixture, 'aws_lambda_function', 'calendar');
      assert.ok(block && /vpc_config\s*\{/.test(block),
        'the resource-block extractor cannot see a vpc_config it is supposed to catch');
      assert.ok(block.includes('subnet_ids') && block.includes('security_group_ids'),
        'the resource-block extractor loses the vpc_config keys');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The security group that only existed for the VPC attachment is gone', () => {
    it('Given the terraform/ directory, When every .tf file is scanned, Then no aws_security_group resource is declared', () => {
      const offenders = listTfFiles().filter(
        file => /resource\s+"aws_security_group"/.test(codeOnly(readTf(file))));
      assert.deepEqual(offenders, [],
        `these .tf files still declare an aws_security_group: ${offenders.join(', ')}`);
    });

    it('And no aws_security_group_rule resource is declared', () => {
      const offenders = listTfFiles().filter(
        file => /resource\s+"aws_security_group_rule"/.test(codeOnly(readTf(file))));
      assert.deepEqual(offenders, [],
        `these .tf files still declare an aws_security_group_rule: ${offenders.join(', ')}`);
    });

    it('And aws_security_group.calendar_sg specifically is gone, with no egress rule or vpc_id left behind', () => {
      const code = codeOnly(readTf('lambda_calendar.tf'));
      assert.ok(!extractResourceBlock(code, 'aws_security_group', 'calendar_sg'),
        'aws_security_group.calendar_sg is still declared');
      assert.ok(!/^\s*egress\s*\{/m.test(code), 'an orphaned egress block survives');
      assert.ok(!code.includes('cidr_blocks'), 'an orphaned cidr_blocks assignment survives');
      assert.ok(!code.includes('vpc_id'), 'an orphaned vpc_id assignment survives');
    });

    it('And the scan is discriminating: the same regex flags a security group in a fixture', () => {
      const fixture = 'resource "aws_security_group" "calendar_sg" {\n  vpc_id = "vpc-1"\n}\n';
      assert.ok(/resource\s+"aws_security_group"/.test(codeOnly(fixture)),
        'the security-group scan cannot see a security group it is supposed to catch');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The ENI permissions the VPC attachment required are gone', () => {
    let statements;
    let policyText;

    before(() => {
      policyText = calendarPolicyText();
      statements = parsePolicyStatements(extractStatementArray(policyText));
      assert.ok(statements.length > 0, 'the calendar IAM policy parsed to zero statements');
    });

    it('Given the inline policy of aws_iam_policy.calendar_lambda_policy, When its statements are parsed, Then no statement has the Sid "VPCNetworkInterfaces"', () => {
      const sids = statements.map(s => s.sid).sort();
      assert.ok(!sids.includes('VPCNetworkInterfaces'),
        `the VPCNetworkInterfaces statement survives; statements are: ${sids.join(', ')}`);
      assert.deepEqual(sids,
        ['CloudWatchLogs', 'DynamoDBCalendarTables', 'KMSCalendarKey', 'SecretsManagerAppConfig'],
        `the calendar policy statements changed; got: ${sids.join(', ')}`);
    });

    it('And no statement grants any ec2:*NetworkInterface* action', () => {
      assert.ok(!/ec2:\w*NetworkInterface\w*/.test(policyText),
        'an ec2:*NetworkInterface* action survives in the calendar policy');
      assert.ok(!/ec2:\w*PrivateIpAddresses/.test(policyText),
        'an ec2:*PrivateIpAddresses action survives in the calendar policy');
      assert.ok(!/"ec2:/.test(policyText),
        'the calendar policy still grants some ec2:* action');
    });

    it('And the policy description does not claim "VPC"', () => {
      const policyBlock = extractResourceBlock(
        codeOnly(readTf('lambda_calendar.tf')), 'aws_iam_policy', 'calendar_lambda_policy');
      assert.ok(policyBlock, 'aws_iam_policy.calendar_lambda_policy not found');
      const description = policyBlock.match(/description\s*=\s*"([^"]*)"/);
      assert.ok(description, 'the calendar IAM policy has no description');
      assert.ok(!/VPC/i.test(description[1]),
        `the policy description still claims VPC: ${JSON.stringify(description[1])}`);
      assert.equal(description[1],
        'Policy for school calendar Lambda - CloudWatch Logs + DynamoDB + KMS + Secrets Manager',
        'the policy description is not the expected VPC-free string');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: Removing the VPC statement leaves every remaining grant scoped', () => {
    let statements;
    let policyText;

    before(() => {
      policyText = calendarPolicyText();
      statements = parsePolicyStatements(extractStatementArray(policyText));
    });

    const bySid = sid => {
      const found = statements.find(s => s.sid === sid);
      assert.ok(found, `statement "${sid}" not found in the calendar IAM policy`);
      return found;
    };

    it('Given the inline policy, When its statements are parsed, Then no statement assigns Resource = "*"', () => {
      const unscoped = statements.filter(s => /Resource\s*=\s*"\*"/.test(s.body)).map(s => s.sid);
      assert.deepEqual(unscoped, [],
        `these statements still grant an unscoped Resource = "*": ${unscoped.join(', ')}`);
      // Every statement must NAME a resource, or an over-broad grant could hide
      // by omitting Resource entirely.
      for (const statement of statements) {
        assert.match(statement.body, /Resource\s*=/,
          `statement "${statement.sid}" has no Resource assignment`);
      }
    });

    it('And CloudWatchLogs keeps its exact prior resource value "arn:aws:logs:*:*:*"', () => {
      const value = bySid('CloudWatchLogs').body.match(/Resource\s*=\s*([^\n]+)/)[1].trim();
      assert.equal(value, '"arn:aws:logs:*:*:*"',
        'the CloudWatch Logs statement is no longer scoped to the logs ARN pattern');
    });

    it('And DynamoDBCalendarTables keeps both table ARNs and the events index ARN', () => {
      const list = bySid('DynamoDBCalendarTables').body
        .match(/Resource\s*=\s*\[([\s\S]*?)\]/)[1]
        .split(',').map(entry => entry.trim()).filter(Boolean);
      assert.deepEqual(list, [
        'aws_dynamodb_table.calendar_connections.arn',
        'aws_dynamodb_table.calendar_events.arn',
        '"${aws_dynamodb_table.calendar_events.arn}/index/*"'
      ], 'the DynamoDB resource list changed');
    });

    it('And KMSCalendarKey and SecretsManagerAppConfig keep their exact prior resource values', () => {
      assert.equal(bySid('KMSCalendarKey').body.match(/Resource\s*=\s*([^\n]+)/)[1].trim(),
        'aws_kms_key.calendar.arn', 'the KMS statement is no longer scoped to the calendar CMK');
      assert.equal(bySid('SecretsManagerAppConfig').body.match(/Resource\s*=\s*([^\n]+)/)[1].trim(),
        'data.aws_secretsmanager_secret.app_config.arn',
        'the Secrets Manager statement is no longer scoped to the app-config secret');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The basestack remote state and its variable are removed together', () => {
    it('Given the terraform/ directory, When provider.tf is read with comment lines stripped, Then it declares no data "terraform_remote_state" "basestack"', () => {
      const code = codeOnly(readTf('provider.tf'));
      assert.ok(!/data\s+"terraform_remote_state"\s+"basestack"/.test(code),
        'provider.tf still declares data "terraform_remote_state" "basestack"');
      assert.ok(!/data\s+"terraform_remote_state"/.test(code),
        'provider.tf still declares a terraform_remote_state data source of some name');
    });

    it('And variables.tf declares no variable "terraform_remote_state_basestack_config"', () => {
      const code = codeOnly(readTf('variables.tf'));
      assert.ok(!/^\s*variable\s+"terraform_remote_state_basestack_config"/m.test(code),
        'variables.tf still declares variable "terraform_remote_state_basestack_config"');
      assert.ok(!code.includes('terraform_remote_state'),
        'variables.tf still mentions terraform_remote_state in code');
    });

    it('And config/dev/au.tfvars assigns no terraform_remote_state_basestack_config key', () => {
      const code = codeOnly(readTf('config', 'dev', 'au.tfvars'));
      assert.ok(!/^\s*terraform_remote_state_basestack_config\s*=/m.test(code),
        'config/dev/au.tfvars still assigns terraform_remote_state_basestack_config');
      assert.ok(!code.includes('basestack'), 'config/dev/au.tfvars still names basestack in code');
    });

    it('And no file under terraform/ references any removed identifier in CODE (comments are allowed and expected)', () => {
      const offenders = [];
      const files = [...listTfFiles(), 'config/dev/au.tfvars'];
      for (const file of files) {
        const code = codeOnly(readTf(...file.split('/')));
        for (const token of FORBIDDEN_CODE_TOKENS) {
          if (code.includes(token)) offenders.push(`${file} -> ${token}`);
        }
      }
      assert.deepEqual(offenders, [],
        `TASK-052 identifiers survive in code: ${offenders.join(', ')}`);
    });

    it('And that sweep is discriminating: every forbidden token is detected in a fixture containing it', () => {
      // Proves the sweep above is not passing because codeOnly() strips too much
      // or the token strings are wrong.
      const fixture = FORBIDDEN_CODE_TOKENS.map(token => `x = ${token}`).join('\n');
      const hits = FORBIDDEN_CODE_TOKENS.filter(token => codeOnly(fixture).includes(token));
      assert.deepEqual(hits, FORBIDDEN_CODE_TOKENS,
        'the forbidden-token sweep cannot detect tokens it is supposed to catch');
      // ...and a comment-only mention is correctly NOT a hit.
      const commented = FORBIDDEN_CODE_TOKENS.map(token => `# was: ${token}`).join('\n');
      const commentHits = FORBIDDEN_CODE_TOKENS.filter(token => codeOnly(commented).includes(token));
      assert.deepEqual(commentHits, [],
        'the sweep counts a comment mention as a code reference, which would make the real scan fail wrongly');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The configuration still validates and names nothing differently', () => {
    // NOTE ON WHERE THE CONSOLE RUNS. local.name_prefix and local.secret_name
    // are declared in terraform/variables.tf, so they can be evaluated in a
    // provider-free throwaway workspace holding that exact file plus the real
    // config/ tree. That is the same technique the TASK-051 e2e suite uses, and
    // it is deliberate: several suites already run the full-config
    // `terraform validate` concurrently in terraform/ (it has to load the 800MB
    // AWS provider schema), and piling more concurrent invocations into that one
    // directory has previously tipped them into timeouts. The full-config
    // validate is asserted ONCE below and nowhere else in this file.
    let workspace;

    before(() => {
      workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    it('When "terraform init -backend=false" then "terraform validate -json" is run against terraform/, Then error_count is 0', () => {
      try {
        execFileSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
          cwd: TERRAFORM_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000
        });
      } catch (error) {
        const output = describeExecError(error);
        if (!/already initialized/i.test(output)) {
          assert.fail(`terraform init -backend=false failed: ${output}`);
        }
      }

      const report = validateJson(TERRAFORM_DIR);
      assert.equal(report.error_count, 0,
        `terraform validate reported ${report.error_count} error(s): ` +
        JSON.stringify(report.diagnostics, null, 2));
      assert.equal(report.valid, true, 'terraform validate marked the configuration invalid');

      // The surviving warnings must be the pre-existing DynamoDB range_key
      // deprecations only - nothing about a dangling basestack reference, an
      // undeclared variable or a missing VPC.
      const text = JSON.stringify(report.diagnostics || []);
      assert.ok(!/basestack/i.test(text), `a diagnostic still mentions basestack: ${text}`);
      assert.ok(!/undeclared/i.test(text), `a diagnostic reports an undeclared variable/resource: ${text}`);
      assert.ok(!/vpc/i.test(text), `a diagnostic still mentions a VPC: ${text}`);
    });

    it('And "terraform console -var-file=config/dev/au.tfvars" evaluates local.name_prefix to "au-dev-receptionhq"', () => {
      const result = tryConsole(workspace, 'local.name_prefix', [`-var-file=${DEV_AU_VAR_FILE}`]);
      assert.ok(result.ok, `terraform console failed evaluating local.name_prefix: ${result.error}`);
      assert.equal(result.value, 'au-dev-receptionhq',
        `local.name_prefix evaluated to ${JSON.stringify(result.value)} - a renamed prefix renames every resource`);
      assert.ok(!/Value for undeclared variable/.test(result.raw),
        `terraform warned about an orphaned tfvars key: ${result.raw}`);
    });

    it('And it evaluates local.secret_name to "dev-au/app-config/school_calendar_services"', () => {
      const result = tryConsole(workspace, 'local.secret_name', [`-var-file=${DEV_AU_VAR_FILE}`]);
      assert.ok(result.ok, `terraform console failed evaluating local.secret_name: ${result.error}`);
      assert.equal(result.value, 'dev-au/app-config/school_calendar_services',
        `local.secret_name evaluated to ${JSON.stringify(result.value)} - the Lambda would read the wrong secret`);
      assert.ok(!/Value for undeclared variable/.test(result.raw),
        `terraform warned about an orphaned tfvars key: ${result.raw}`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The removal is documented where the wiring used to be', () => {
    it('Given terraform/lambda_calendar.tf, When the comments around the removed vpc_config are read, Then they state the no-VPC placement is deliberate', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /deliberate/i,
        'no comment states that running outside a VPC is deliberate');
      assert.match(comments, /NOT (attached to any VPC|in a VPC)|HAS NO `?vpc_config/i,
        'no comment states plainly that this function has no vpc_config / is not in a VPC');
    });

    it('And the comment names what the no-VPC placement gives up: no fixed NAT egress IP and no network-layer isolation', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /NAT/, 'the comment does not mention the NAT gateway / fixed egress IP it gives up');
      assert.match(comments, /egress IP|static source IP|fixed egress/i,
        'the comment does not name the loss of a fixed/static egress source IP');
      assert.match(comments, /network-layer isolation|network layer isolation/i,
        'the comment does not name the loss of network-layer isolation');
    });

    it('And the comment says why it is safe here: no VPC endpoints, no source-VPC IAM conditions, everything is a public endpoint', () => {
      const comments = commentsOnly(readTf('lambda_calendar.tf'));
      assert.match(comments, /vpc_endpoint|VPC endpoint|PrivateLink/i,
        'the comment does not explain that nothing reached a service over a VPC endpoint');
      assert.match(comments, /SourceVpc/i,
        'the comment does not explain that no IAM/KMS grant carries a source-VPC condition');
      assert.match(comments, /PUBLIC endpoint/i,
        'the comment does not explain that every dependency is a public endpoint');
    });

    it('And variables.tf and provider.tf no longer carry stale load-bearing / do-not-remove comments for deleted things', () => {
      for (const file of ['variables.tf', 'provider.tf']) {
        const comments = commentsOnly(readTf(file));
        assert.ok(!/load[- ]bearing/i.test(comments),
          `${file} still claims something is "load-bearing" after TASK-052 deleted it`);
        assert.ok(!/do not remove/i.test(comments),
          `${file} still carries a "do not remove" comment for a deleted thing`);
        assert.ok(!/is NOT dead/i.test(comments),
          `${file} still asserts a deleted declaration is "NOT dead"`);
      }
    });

    it('And the removal is recorded in provider.tf, variables.tf and the tfvars, naming TASK-052', () => {
      for (const file of ['provider.tf', 'variables.tf', 'config/dev/au.tfvars']) {
        const comments = commentsOnly(readTf(...file.split('/')));
        assert.match(comments, /TASK-052/,
          `${file} deletes something without a comment recording that TASK-052 did it`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: Function identity is preserved', () => {
    it('Then function_name is unchanged from before this ticket', () => {
      const code = codeOnly(readTf('lambda_calendar.tf'));
      assert.ok(code.includes('function_name    = "${local.name_prefix}-school-calendar"'),
        'the Lambda function_name changed - a new name is a new function and a new function URL');
    });

    it('And aws_lambda_function_url.calendar is byte-for-byte unchanged from HEAD', () => {
      // Compared against the committed version of the file, so this proves the
      // ticket did not touch it - not merely that it still looks plausible.
      const before = readTfAtHead('lambda_calendar.tf');
      const now = normalizeEol(readTf('lambda_calendar.tf'));

      const beforeUrl = extractResourceBlock(before, 'aws_lambda_function_url', 'calendar');
      const nowUrl = extractResourceBlock(now, 'aws_lambda_function_url', 'calendar');
      assert.ok(beforeUrl && nowUrl, 'aws_lambda_function_url.calendar not found in one of the two versions');
      assert.equal(nowUrl, beforeUrl,
        'aws_lambda_function_url.calendar changed; the function URL id would change and the Google ' +
        'OAuth redirect URI already registered against it would stop matching');
    });

    it('And aws_lambda_permission.calendar_allow_function_url is byte-for-byte unchanged from HEAD', () => {
      const before = readTfAtHead('lambda_calendar.tf');
      const now = normalizeEol(readTf('lambda_calendar.tf'));
      const beforePerm = extractResourceBlock(before, 'aws_lambda_permission', 'calendar_allow_function_url');
      const nowPerm = extractResourceBlock(now, 'aws_lambda_permission', 'calendar_allow_function_url');
      assert.ok(beforePerm && nowPerm,
        'aws_lambda_permission.calendar_allow_function_url not found in one of the two versions');
      assert.equal(nowPerm, beforePerm,
        'the function URL invoke permission changed; every request would 403');
    });

    it('And the four surviving IAM statements are byte-for-byte unchanged from HEAD', () => {
      const before = readTfAtHead('lambda_calendar.tf');
      const beforeStatements = new Map(
        parsePolicyStatements(extractStatementArray(
          codeOnly(before).match(/policy = jsonencode\(\{[\s\S]*?\}\)/)[0]))
          .map(s => [s.sid, s.body]));
      const nowStatements = new Map(
        parsePolicyStatements(extractStatementArray(normalizeEol(calendarPolicyText())))
          .map(s => [s.sid, s.body]));

      for (const sid of ['CloudWatchLogs', 'DynamoDBCalendarTables', 'KMSCalendarKey', 'SecretsManagerAppConfig']) {
        assert.ok(beforeStatements.has(sid), `${sid} was missing BEFORE the change - fixture problem, not a regression`);
        assert.equal(nowStatements.get(sid), beforeStatements.get(sid),
          `the ${sid} statement changed; TASK-052 was supposed to remove VPCNetworkInterfaces and nothing else`);
      }
      assert.ok(beforeStatements.has('VPCNetworkInterfaces'),
        'VPCNetworkInterfaces was not present before the change - this ticket is defined as removing it');
      assert.ok(!nowStatements.has('VPCNetworkInterfaces'),
        'VPCNetworkInterfaces survives the change');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: FAILURE - a tfvars key is left behind after the variable is deleted', () => {
    let workspace;

    before(() => {
      workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
      fs.writeFileSync(path.join(workspace, 'orphan.tfvars'), [
        '# Fixture ONLY. This is what dev/au.tfvars would look like if the variable',
        '# had been deleted without deleting the tfvars key in the same change.',
        'terraform_remote_state_basestack_config = {',
        '  region = "ap-southeast-2"',
        '  bucket = "ap-southeast-2-058264301523-officehq-tfstate-bucket"',
        '  key    = "env:/dev-au/terraform_dev_au_basestack.tfstate"',
        '}',
        ''
      ].join('\n'), 'utf-8');
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    it('Given the variable has been removed from variables.tf, But a fixture var file still assigns it, When terraform plan is run, Then terraform emits a "Value for undeclared variable" warning', () => {
      const plan = tryPlan(workspace, [`-var-file=${DEV_AU_VAR_FILE}`, '-var-file=orphan.tfvars']);
      assert.match(plan.output, /Value for undeclared variable/,
        `terraform did not warn about the orphaned tfvars key. Output was:\n${plan.output}`);
      assert.match(plan.output, /terraform_remote_state_basestack_config/,
        'the warning does not name terraform_remote_state_basestack_config');
    });

    it('And the REAL config/dev/au.tfvars produces no such warning, because the key went with the declaration', () => {
      const plan = tryPlan(workspace, [`-var-file=${DEV_AU_VAR_FILE}`]);
      assert.ok(!/Value for undeclared variable/.test(plan.output),
        `the real dev/au.tfvars triggers an undeclared-variable warning:\n${plan.output}`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: FAILURE - the data source is deleted while a reader survives', () => {
    // A copy, never the real files: this scenario has to build the broken state
    // on purpose. The real terraform/ directory is not mutated.
    const READER_FIXTURE = [
      'variable "terraform_remote_state_basestack_config" {',
      '  type = map(string)',
      '  default = {',
      '    bucket = "example-bucket"',
      '    key    = "example.tfstate"',
      '    region = "ap-southeast-2"',
      '  }',
      '}',
      '',
      'data "terraform_remote_state" "basestack" {',
      '  backend = "s3"',
      '  config = {',
      '    bucket = var.terraform_remote_state_basestack_config["bucket"]',
      '    key    = var.terraform_remote_state_basestack_config["key"]',
      '    region = var.terraform_remote_state_basestack_config["region"]',
      '  }',
      '}',
      '',
      'locals {',
      '  lambda_subnet_ids = data.terraform_remote_state.basestack.outputs.private_subnet_ids',
      '}'
    ].join('\n');

    it('Given the data source is deleted, But a reader of outputs.private_subnet_ids survives, When terraform validate runs, Then it reports "Reference to undeclared resource"', () => {
      let workspace;
      try {
        const broken = READER_FIXTURE.replace(
          /data "terraform_remote_state" "basestack" \{[\s\S]*?\n\}\n/, '');
        assert.ok(!broken.includes('data "terraform_remote_state" "basestack" {'),
          'the deletion mutation did not apply - fix this test rather than letting it no-op');
        assert.ok(broken.includes('outputs.private_subnet_ids'),
          'the mutation removed the reader too, so nothing would dangle');

        workspace = makeWorkspace({ 'main.tf': broken });
        const report = validateJson(workspace);
        assert.ok(report.error_count > 0,
          'terraform validate accepted a read from a deleted remote state');
        const summaries = (report.diagnostics || [])
          .map(d => `${d.summary}: ${d.detail || ''}`).join(' | ');
        assert.match(summaries, /Reference to undeclared resource|has not been declared/,
          `expected an undeclared-resource error, got: ${summaries}`);
      } finally {
        removeWorkspace(workspace);
      }
    });

    it('And the intact fixture validates, proving the error above is caused by the deletion and not by the fixture', () => {
      let workspace;
      try {
        workspace = makeWorkspace({ 'main.tf': READER_FIXTURE });
        const report = validateJson(workspace);
        assert.equal(report.error_count, 0,
          `the intact fixture should validate: ${JSON.stringify(report.diagnostics)}`);
      } finally {
        removeWorkspace(workspace);
      }
    });

    it('And the real terraform/ tree contains no such reference - readers and data source were removed together', () => {
      const offenders = listTfFiles().filter(
        file => codeOnly(readTf(file)).includes('terraform_remote_state.basestack'));
      assert.deepEqual(offenders, [],
        `these files still read the deleted basestack remote state: ${offenders.join(', ')}`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: The HCL parser fixtures are untouched', () => {
    // These two files mention VPCNetworkInterfaces in INLINE fixture strings
    // that test the HCL parser itself. They are not reads of the real terraform
    // files, so this ticket must not have edited them.
    const PARSER_FIXTURE_FILES = [
      'tests/unit/hcl-blocks-core.test.js',
      'tests/e2e/hcl-semantic-assertions.test.js'
    ];

    for (const file of PARSER_FIXTURE_FILES) {
      it(`Given ${file}, Then it is unchanged from HEAD in this working tree`, () => {
        const status = execFileSync('git', ['status', '--porcelain', '--', file], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000
        }).trim();
        assert.equal(status, '',
          `${file} was modified; its VPCNetworkInterfaces mentions are parser fixtures, not real-file reads`);
      });

      it(`And ${file} still carries its inline VPCNetworkInterfaces fixture`, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, ...file.split('/')), 'utf-8');
        assert.ok(content.includes('VPCNetworkInterfaces'),
          `${file} lost its VPCNetworkInterfaces parser fixture`);
      });
    }
  });

  // ---------------------------------------------------------------------------
  describe('Scenario: Nothing outside the removal moved', () => {
    it('Given the ticket touches only terraform/, Then no file under src/ was modified', () => {
      const status = execFileSync('git', ['status', '--porcelain', '--', 'src'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000
      }).trim();
      assert.equal(status, '', `files under src/ were modified by this ticket:\n${status}`);
    });

    it('And dynamodb_calendar_connections.tf, dynamodb_calendar_events.tf, kms_calendar.tf, scheduler_calendar.tf and alerting.tf are untouched', () => {
      const untouched = [
        'dynamodb_calendar_connections.tf', 'dynamodb_calendar_events.tf',
        'kms_calendar.tf', 'scheduler_calendar.tf', 'alerting.tf', 'main.tf'
      ];
      const status = execFileSync(
        'git', ['status', '--porcelain', '--', ...untouched.map(f => `terraform/${f}`)],
        { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 }
      ).trim();
      assert.equal(status, '', `out-of-scope terraform files were modified:\n${status}`);
    });
  });
});
