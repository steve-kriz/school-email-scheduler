/**
 * TASK-051 e2e (cucumber-style Given/When/Then) scenarios: the Terraform config
 * is reduced to a single deployable environment (dev/au), and the dead
 * Route53/ALB/global-provider/legacystack surface is removed.
 *
 * These are the ticket's Gherkin scenarios implemented as `node --test` cases -
 * no cucumber package is installed or required. Where a scenario is about what
 * terraform ACTUALLY does (evaluation, undeclared-variable errors, missing
 * required variables), it is executed with the real terraform binary in a
 * throwaway, provider-free, local-only workspace built under os.tmpdir(). The
 * real terraform/ directory is never mutated.
 *
 * NO DATABASE CONNECTION IS EVER OPENED by this file. The only DynamoDB tables
 * named anywhere here are terraform source text read off disk as strings, and
 * the only AWS-shaped strings are ARNs asserted textually - no AWS SDK client
 * is constructed and no network call is made.
 *
 * The matching unit coverage lives in tests/unit/task-051-terraform-refactor.test.js.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');

const DEV_AU_VAR_FILE = 'config/dev/au.tfvars';

// The ten variables TASK-051 deleted. Declaration and reference had to move
// together: a `var.X` with no declaration is a hard "Reference to undeclared
// input variable" error, and a declaration with no default and no value is a
// hard "No value for required variable". Both directions are exercised below.
const REMOVED_VARIABLES = [
  'sub_domain',
  'hosted_zone',
  'hosted_zone_id',
  'alb_name',
  'project_name_short',
  'timezone',
  'geo_id',
  'language',
  'account_id',
  'terraform_remote_state_legacystack_config',
  // Appended by TASK-052: same rule, later ticket. Its declaration, its data
  // source and its tfvars key were removed in one change once the Lambda's
  // vpc_config and security group - the only readers - were deleted.
  'terraform_remote_state_basestack_config'
];

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
      `and "terraform" on PATH, which failed: ${describeExecError(error)}`
    );
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
 * Build a throwaway workspace from a map of { filename: contents } and run
 * `terraform init -backend=false` in it once. No provider is declared in any
 * fixture here, so init downloads nothing and needs no AWS credentials.
 */
function makeWorkspace(files, { copyConfig = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-051-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(workspace, name), contents, 'utf-8');
    }
    if (copyConfig) {
      fs.cpSync(CONFIG_DIR, path.join(workspace, 'config'), { recursive: true });
    }
    execFileSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
  } catch (error) {
    removeWorkspace(workspace);
    throw new Error(`Failed to prepare terraform workspace: ${describeExecError(error)}`);
  }
  return workspace;
}

/** Run `terraform validate -json` in `workspace` and return the parsed report. */
function validateJson(workspace) {
  let stdout;
  try {
    stdout = execFileSync(TERRAFORM_BIN, ['validate', '-json'], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
    });
  } catch (error) {
    stdout = (error.stdout || '').toString();
    if (!stdout.trim()) {
      throw new Error(`terraform validate produced no JSON: ${describeExecError(error)}`);
    }
  }
  return JSON.parse(stdout);
}

/**
 * Feed one expression to `terraform console`. Never throws on a terraform
 * failure - returns { ok: false, error, stderr } - so a scenario can assert on
 * the failure text as readily as on a value.
 */
function tryConsole(workspace, expression, varFileArgs = []) {
  try {
    const stdout = execFileSync(TERRAFORM_BIN, ['console', '-no-color', ...varFileArgs], {
      cwd: workspace, input: `${expression}\n`, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
    });
    const clean = stdout.replace(/\[[0-9;]*m/g, '');
    return { ok: true, raw: clean, value: (clean.match(/"((?:[^"\\]|\\.)*)"/) || [])[1] };
  } catch (error) {
    return {
      ok: false,
      error: describeExecError(error),
      stderr: `${(error.stdout || '').toString()}\n${(error.stderr || '').toString()}`
    };
  }
}

/**
 * Run `terraform plan -input=false` in `workspace`. Never throws on a plan
 * failure - returns { ok: false, output } - so a scenario can assert on the
 * error text. -input=false is what turns a missing required variable into a
 * hard error instead of an interactive prompt.
 */
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

/** Console evaluation that must succeed; returns the printed string. */
function evaluate(workspace, expression, varFileArgs) {
  const result = tryConsole(workspace, expression, varFileArgs);
  assert.ok(result.ok, `terraform console failed evaluating "${expression}": ${result.error}`);
  assert.ok(result.value !== undefined,
    `could not parse a string value for "${expression}" from: ${JSON.stringify(result.raw)}`);
  return result.value;
}

// -----------------------------------------------------------------------------
// source-reading helpers
// -----------------------------------------------------------------------------

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

/**
 * Drop `#` / `//` comment lines. TASK-051 left long comments NAMING everything
 * it removed (var.account_id, allowed_account_ids, legacystack, aws_global), so
 * an "is it gone?" assertion over the raw text would see those names and pass
 * for the wrong reason. Every absence assertion below reads code only.
 */
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

// =============================================================================

describe('TASK-051 e2e', () => {
  describe('Feature: Terraform config is reduced to a single deployable environment', () => {

    // -------------------------------------------------------------------------
    describe("Scenario: Only one environment's config survives", () => {
      it('Given the change for this ticket, When terraform/config/ is inspected, Then only dev/au.tfvars exists', () => {
        const found = [];
        const walk = dir => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.tfvars')) {
              found.push(path.relative(CONFIG_DIR, full).replace(/\\/g, '/'));
            }
          }
        };
        walk(CONFIG_DIR);

        assert.deepEqual(found.sort(), ['dev/au.tfvars'],
          `terraform/config/ should hold exactly one tfvars file, found: ${found.join(', ') || '(none)'}`);
        assert.ok(!fs.existsSync(path.join(CONFIG_DIR, 'prod')),
          'terraform/config/prod/ still exists; the whole directory was supposed to go');
      });

      it('And terraform_init_prod_au.sh, terraform_init_prod_uk.sh and terraform_init_prod_us.sh do not exist', () => {
        for (const tenant of ['au', 'uk', 'us']) {
          const script = path.join(TERRAFORM_DIR, `terraform_init_prod_${tenant}.sh`);
          assert.ok(!fs.existsSync(script),
            `terraform_init_prod_${tenant}.sh still exists, but config/prod/${tenant}.tfvars is gone - ` +
            'running it would fail at plan time on missing required variables');
        }
      });

      it('And terraform_init_dev_au.sh still exists', () => {
        const script = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
        assert.ok(fs.existsSync(script), 'terraform_init_dev_au.sh not found - the only deployable path was deleted');
        assert.ok(fs.statSync(script).isFile(), 'terraform_init_dev_au.sh is not a file');

        const initScripts = fs.readdirSync(TERRAFORM_DIR).filter(f => /^terraform_init_.*\.sh$/.test(f)).sort();
        assert.deepEqual(initScripts, ['terraform_init_dev_au.sh'],
          `expected exactly one init script, found: ${initScripts.join(', ')}`);
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: The dead Route53 / ALB / misc variables are gone from declarations and tfvars together', () => {
      const DECLARATION_SUBSET = [
        'sub_domain', 'hosted_zone', 'hosted_zone_id', 'alb_name',
        'project_name_short', 'timezone', 'geo_id', 'language'
      ];

      it('Given terraform/variables.tf, When the configuration is read, Then none of those eight variables is declared', () => {
        const variablesTf = readTf('variables.tf');
        for (const name of DECLARATION_SUBSET) {
          assert.ok(!new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesTf),
            `variable "${name}" is still declared in variables.tf`);
        }
      });

      it('And dev/au.tfvars assigns none of those keys', () => {
        const tfvars = codeOnly(readTf('config', 'dev', 'au.tfvars'));
        for (const name of REMOVED_VARIABLES) {
          assert.ok(!new RegExp(`^\\s*${name}\\s*=`, 'm').test(tfvars),
            `dev/au.tfvars still assigns "${name}"; terraform would warn "Value for undeclared variable"`);
        }
      });

      it('And no .tf file references any of them', () => {
        const offenders = [];
        for (const file of listTfFiles()) {
          const code = codeOnly(readTf(file));
          for (const name of REMOVED_VARIABLES) {
            // \b on the right so var.hosted_zone does not match var.hosted_zone_id.
            if (new RegExp(`var\\.${name}\\b`).test(code)) offenders.push(`${file} -> var.${name}`);
          }
        }
        assert.deepEqual(offenders, [],
          `.tf files still reference removed variables: ${offenders.join(', ')}`);
      });

      it('And terraform itself emits no "Value for undeclared variable" warning when the var file is loaded', () => {
        // The authoritative check: terraform, not a regex, decides whether the
        // tfvars and the declarations agree.
        let workspace;
        try {
          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
          const result = tryConsole(workspace, 'local.name_prefix', [`-var-file=${DEV_AU_VAR_FILE}`]);
          assert.ok(result.ok, `terraform console could not load ${DEV_AU_VAR_FILE}: ${result.error}`);
          assert.ok(!/Value for undeclared variable/i.test(result.raw),
            `terraform warned about an undeclared variable while loading ${DEV_AU_VAR_FILE}:\n${result.raw}`);
        } finally {
          removeWorkspace(workspace);
        }
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: The account-id guard is deliberately removed, not silently missing', () => {
      let providerTf;
      before(() => { providerTf = readTf('provider.tf'); });

      it('Given the single remaining provider "aws" block, When terraform/provider.tf is read, Then it declares no allowed_account_ids argument', () => {
        const blocks = providerTf.match(/^provider\s+"aws"\s*\{/gm) || [];
        assert.equal(blocks.length, 1,
          `expected exactly one provider "aws" block, found ${blocks.length}`);
        assert.ok(!codeOnly(providerTf).includes('allowed_account_ids'),
          'allowed_account_ids is still an active argument in provider.tf');
      });

      it('And a comment above the provider block states that the account-mismatch guard was deliberately removed', () => {
        const beforeProvider = providerTf.slice(0, providerTf.search(/^provider\s+"aws"\s*\{/m));
        const comments = commentsOnly(beforeProvider);
        assert.ok(comments.includes('allowed_account_ids'),
          'no comment ABOVE the provider block mentions allowed_account_ids - the dropped guard is silently missing');
        assert.match(comments, /deliberate|deliberately|accepted|informed regression/i,
          'the comment above the provider block does not say the removal was deliberate');
        assert.match(comments, /account/i,
          'the comment above the provider block does not explain the account-mismatch consequence');
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: The account id in ARNs now comes from the caller identity', () => {
      const CALLER_ID = '${data.aws_caller_identity.current.account_id}';

      it('Given variable "account_id" has been removed, When local.calendar_function_arn is read, Then it interpolates data.aws_caller_identity.current.account_id', () => {
        assert.ok(!/^\s*variable\s+"account_id"/m.test(readTf('variables.tf')),
          'variable "account_id" is still declared');

        const lambdaTf = readTf('lambda_calendar.tf');
        assert.ok(lambdaTf.includes(
          `calendar_function_arn = "arn:aws:lambda:\${var.region}:${CALLER_ID}:function:\${local.name_prefix}-school-calendar"`),
        'local.calendar_function_arn is not built from data.aws_caller_identity.current.account_id');
      });

      it('And the scheduler IAM resource scope interpolates it too', () => {
        const schedulerTf = readTf('scheduler_calendar.tf');
        const manageScan = schedulerTf.slice(schedulerTf.indexOf('Sid    = "ManageScanSchedules"'));
        assert.ok(manageScan.length > 0, 'the ManageScanSchedules statement was not found');
        const resourceLine = manageScan.split('\n').find(l => l.includes('Resource ='));
        assert.ok(resourceLine, 'the ManageScanSchedules statement has no Resource line');
        assert.ok(resourceLine.includes(CALLER_ID),
          `ManageScanSchedules Resource does not use the caller identity: ${resourceLine.trim()}`);
        assert.ok(resourceLine.includes('schedule/default/${local.name_prefix}-calendar-scan-*'),
          `ManageScanSchedules Resource scope narrowed/widened unexpectedly: ${resourceLine.trim()}`);
      });

      it('And neither contains a hardcoded 12-digit account number, And neither contains var.account_id', () => {
        for (const file of ['lambda_calendar.tf', 'scheduler_calendar.tf']) {
          const code = codeOnly(readTf(file));
          assert.ok(!code.includes('var.account_id'),
            `${file} still references var.account_id, which no longer exists`);
          for (const line of code.split('\n').filter(l => l.includes('arn:aws:'))) {
            assert.ok(!/:\d{12}:/.test(line),
              `${file} hardcodes a 12-digit account id in an ARN: ${line.trim()}`);
          }
        }
      });

      it('And data.aws_caller_identity.current is actually declared, so those interpolations resolve', () => {
        assert.ok(/^data\s+"aws_caller_identity"\s+"current"\s*\{/m.test(readTf('provider.tf')),
          'data "aws_caller_identity" "current" is not declared, so both ARNs would fail validation');
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: The unused global provider alias and the unread legacystack remote state are gone', () => {
      it('Given no resource or data source sets provider = aws.aws_global, When terraform/provider.tf is read, Then it declares exactly one provider "aws" block', () => {
        for (const file of listTfFiles()) {
          assert.ok(!/provider\s*=\s*aws\.aws_global/.test(codeOnly(readTf(file))),
            `${file} sets provider = aws.aws_global, but the alias was removed`);
        }
        const blocks = readTf('provider.tf').match(/^provider\s+"aws"\s*\{/gm) || [];
        assert.equal(blocks.length, 1, `expected exactly one provider "aws" block, found ${blocks.length}`);
        assert.ok(!codeOnly(readTf('provider.tf')).includes('aws_global'),
          'the aws_global alias block survives in provider.tf');
      });

      it('And data "terraform_remote_state" "legacystack" is absent, And variable "terraform_remote_state_legacystack_config" is absent', () => {
        for (const file of listTfFiles()) {
          const code = codeOnly(readTf(file));
          assert.ok(!code.includes('terraform_remote_state.legacystack'),
            `${file} still reads data.terraform_remote_state.legacystack`);
          assert.ok(!/data\s+"terraform_remote_state"\s+"legacystack"/.test(code),
            `${file} still declares the legacystack remote state`);
          assert.ok(!code.includes('terraform_remote_state_legacystack_config'),
            `${file} still references terraform_remote_state_legacystack_config`);
        }
      });

      it('And dev/au.tfvars declares no terraform_remote_state_legacystack_config block', () => {
        const tfvars = codeOnly(readTf('config', 'dev', 'au.tfvars'));
        assert.ok(!tfvars.includes('terraform_remote_state_legacystack_config'),
          'dev/au.tfvars still declares terraform_remote_state_legacystack_config');
      });
    });

    // -------------------------------------------------------------------------
    // REVERSED BY TASK-052. This scenario used to be titled "The basestack
    // remote state survives (it is not per-tenant, it is dev/au's own)" and
    // guarded three things: that lambda_calendar.tf still read
    // outputs.private_subnet_ids and outputs.vpc_id, that the variable and the
    // data source were still declared, and that dev/au.tfvars still evaluated
    // the map to a non-empty bucket/key/region.
    //
    // TASK-051 was right AT THE TIME: basestack still had two readers. TASK-052
    // deliberately deleted BOTH of them - the Lambda's vpc_config and
    // aws_security_group.calendar_sg - which left the remote state with no
    // reader at all, so the state, its variable and its tfvars key went too.
    // The guard is kept, pointed the other way, so a future accidental
    // RE-INTRODUCTION is caught just as the accidental removal used to be.
    describe('Scenario: The basestack remote state is gone, together with its last reader (TASK-052 reverses TASK-051)', () => {
      it('Given the VPC attachment was removed, When lambda_calendar.tf is read, Then it reads neither outputs.private_subnet_ids nor outputs.vpc_id', () => {
        const lambdaTf = codeOnly(readTf('lambda_calendar.tf'));
        assert.ok(!lambdaTf.includes('data.terraform_remote_state.basestack.outputs.private_subnet_ids'),
          "the Lambda's vpc_config still reads private_subnet_ids, but the remote state is gone");
        assert.ok(!lambdaTf.includes('data.terraform_remote_state.basestack.outputs.vpc_id'),
          'a security group still reads vpc_id, but the remote state is gone');
      });

      it('And variable "terraform_remote_state_basestack_config" is no longer declared, nor is the data source', () => {
        assert.ok(!/^\s*variable\s+"terraform_remote_state_basestack_config"/m.test(codeOnly(readTf('variables.tf'))),
          'variable "terraform_remote_state_basestack_config" survives with nothing reading it');
        assert.ok(!/data\s+"terraform_remote_state"\s+"basestack"/.test(codeOnly(readTf('provider.tf'))),
          'data "terraform_remote_state" "basestack" survives in provider.tf');
      });

      it('And terraform itself reports terraform_remote_state_basestack_config as undeclared when a fixture var file sets it', () => {
        // Proven by execution, not by string matching: the real variables.tf is
        // loaded into a throwaway workspace with a var file that still assigns
        // the deleted key. Terraform must warn "Value for undeclared variable" -
        // exactly the orphaned-tfvars desync TASK-051 warned about, and the
        // reason TASK-052 removed declaration and tfvars key in one change.
        let workspace;
        try {
          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
          fs.writeFileSync(path.join(workspace, 'orphan.tfvars'), [
            'terraform_remote_state_basestack_config = {',
            '  region = "ap-southeast-2"',
            '  bucket = "some-bucket"',
            '  key    = "env:/dev-au/terraform_dev_au_basestack.tfstate"',
            '}',
            ''
          ].join('\n'), 'utf-8');

          const plan = tryPlan(workspace, [`-var-file=${DEV_AU_VAR_FILE}`, '-var-file=orphan.tfvars']);
          assert.match(plan.output, /Value for undeclared variable/,
            `terraform did not warn about the orphaned tfvars key; output was: ${plan.output}`);
          assert.match(plan.output, /terraform_remote_state_basestack_config/,
            'the warning does not name terraform_remote_state_basestack_config');

          // And the REAL tfvars does not carry that key, so the real tree is clean.
          assert.ok(!codeOnly(readTf('config', 'dev', 'au.tfvars'))
            .includes('terraform_remote_state_basestack_config'),
          'the real config/dev/au.tfvars still assigns the deleted variable');
        } finally {
          removeWorkspace(workspace);
        }
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: Resource naming is unchanged', () => {
      let workspace;

      before(() => {
        workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
      });

      after(() => {
        removeWorkspace(workspace);
        workspace = undefined;
      });

      it('Given dev/au.tfvars in a provider-free workspace, When local.name_prefix is evaluated with terraform console, Then it is "au-dev-receptionhq"', () => {
        const value = evaluate(workspace, 'local.name_prefix', [`-var-file=${DEV_AU_VAR_FILE}`]);
        assert.equal(value, 'au-dev-receptionhq',
          `local.name_prefix evaluated to "${value}" - resource names would change, which is a destroy/recreate`);
      });

      it('And local.secret_name is "dev-au/app-config/school_calendar_services"', () => {
        const value = evaluate(workspace, 'local.secret_name', [`-var-file=${DEV_AU_VAR_FILE}`]);
        assert.equal(value, 'dev-au/app-config/school_calendar_services',
          `local.secret_name evaluated to "${value}" - the Lambda would read a secret that does not exist`);
      });

      it('And local.name_prefix_short is gone with its ALB target group, so evaluating it errors', () => {
        // The discriminating half: if the harness were not really reading
        // variables.tf, a removed local would still "evaluate".
        const result = tryConsole(workspace, 'local.name_prefix_short', [`-var-file=${DEV_AU_VAR_FILE}`]);
        assert.equal(result.ok, false,
          `local.name_prefix_short still evaluates (to "${result.value}"); TASK-051 removed it`);
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: The configuration still validates and loads cleanly', () => {
      it('Given the terraform directory, When "terraform validate -json" is run, Then error_count is 0', () => {
        // Runs against the already-initialised terraform/ directory (the coder
        // ran `terraform init -backend=false` there). validate is read-only, so
        // it is safe to run alongside the other suites that do the same; the
        // generous timeout is purely to absorb that contention rather than to
        // report a schema-load stall as a config error.
        let stdout;
        try {
          stdout = execFileSync(TERRAFORM_BIN, ['validate', '-json'], {
            cwd: TERRAFORM_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000
          });
        } catch (error) {
          stdout = (error.stdout || '').toString();
          if (!stdout.trim()) {
            assert.fail(`terraform validate produced no JSON: ${describeExecError(error)}`);
          }
        }
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.error_count, 0,
          `terraform validate reported ${parsed.error_count} error(s): ${JSON.stringify(parsed.diagnostics)}`);
      });

      it('And "terraform console -var-file=config/dev/au.tfvars" emits no undeclared-variable warning', () => {
        let workspace;
        try {
          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
          const result = tryConsole(workspace, 'var.region', [`-var-file=${DEV_AU_VAR_FILE}`]);
          assert.ok(result.ok, `terraform console failed loading the var file: ${result.error}`);
          assert.ok(!/Value for undeclared variable/i.test(result.raw),
            `undeclared-variable warning emitted:\n${result.raw}`);
          assert.equal(result.value, 'ap-southeast-2',
            `var.region evaluated to "${result.value}" - the var file was not really loaded`);
        } finally {
          removeWorkspace(workspace);
        }
      });

      it('And "terraform fmt -check -recursive" passes', () => {
        try {
          execFileSync(TERRAFORM_BIN, ['fmt', '-check', '-recursive', '-no-color'], {
            cwd: TERRAFORM_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
          });
        } catch (error) {
          assert.fail(`terraform fmt -check -recursive reported unformatted files: ${describeExecError(error)}`);
        }
      });
    });

    // -------------------------------------------------------------------------
    describe("Scenario: TASK-050's backend settings survive this refactor", () => {
      let terraformBlock;
      let backendBlock;

      before(() => {
        const providerTf = readTf('provider.tf');
        terraformBlock = providerTf.slice(providerTf.indexOf('terraform {'), providerTf.indexOf('provider "aws"'));
        const backendStart = terraformBlock.indexOf('backend "s3"');
        assert.ok(backendStart >= 0, 'no backend "s3" block found in the terraform block');
        backendBlock = terraformBlock.slice(backendStart);
      });

      it('Given terraform/provider.tf, When the terraform block is read, Then required_version still constrains Terraform to 1.10 or newer', () => {
        assert.match(terraformBlock, /required_version\s*=\s*">=\s*1\.10"/,
          'required_version >= 1.10 was lost; an older binary would silently init a backend with no locking');
      });

      it('And required_providers still constrains hashicorp/aws to "~> 6.19"', () => {
        assert.match(terraformBlock, /source\s*=\s*"hashicorp\/aws"/,
          'the hashicorp/aws provider source was changed or removed');
        assert.match(terraformBlock, /version\s*=\s*"~>\s*6\.19"/,
          'the aws provider version constraint is no longer "~> 6.19"');
      });

      it('And the backend still sets encrypt = true and use_lockfile = true', () => {
        assert.match(backendBlock, /encrypt\s*=\s*true/, 'backend "s3" no longer sets encrypt = true');
        assert.match(backendBlock, /use_lockfile\s*=\s*true/, 'backend "s3" no longer sets use_lockfile = true');
      });

      it('And the backend still declares no dynamodb_table and no literal bucket, key or region', () => {
        const code = codeOnly(backendBlock);
        assert.ok(!code.includes('dynamodb_table'),
          'backend "s3" reintroduced dynamodb_table; TASK-050 replaced it with the S3 lockfile');
        for (const key of ['bucket', 'key', 'region']) {
          assert.ok(!new RegExp(`^\\s*${key}\\s*=`, 'm').test(code),
            `backend "s3" now hardcodes ${key}; it is supplied by -backend-config from the init script`);
        }
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: Other tenants no longer have a code path to plan or apply', () => {
      it('Given terraform/config/prod/ has been removed And the prod init scripts have been removed, When check-oauth-config.mjs\'s tenant map is read, Then it lists only the dev/au tenant', async () => {
        assert.ok(!fs.existsSync(path.join(CONFIG_DIR, 'prod')), 'terraform/config/prod/ still exists');
        for (const tenant of ['au', 'uk', 'us']) {
          assert.ok(!fs.existsSync(path.join(TERRAFORM_DIR, `terraform_init_prod_${tenant}.sh`)),
            `terraform_init_prod_${tenant}.sh still exists`);
        }

        // Imported, not regex-scraped, so this asserts the value the script
        // really exports. The module has no top-level AWS client and no DB
        // handle, so importing it opens nothing.
        const { TENANT_REGIONS } = await import(
          new URL(`file://${path.join(SCRIPTS_DIR, 'check-oauth-config.mjs').replace(/\\/g, '/')}`).href
        );
        assert.deepEqual(Object.keys(TENANT_REGIONS), ['dev-au'],
          `TENANT_REGIONS should list only dev-au, got: ${Object.keys(TENANT_REGIONS).join(', ')}`);
        assert.equal(TENANT_REGIONS['dev-au'], 'ap-southeast-2',
          "dev-au's region must still be ap-southeast-2, matching config/dev/au.tfvars");
      });

      it('And docs/google-oauth-setup.md no longer instructs an operator to run a prod init script', () => {
        const runbook = fs.readFileSync(path.join(DOCS_DIR, 'google-oauth-setup.md'), 'utf-8');
        for (const tenant of ['au', 'uk', 'us']) {
          assert.ok(!runbook.includes(`terraform_init_prod_${tenant}.sh`),
            `the runbook still tells an operator to run terraform_init_prod_${tenant}.sh`);
        }
      });

      it('And it no longer presents a prod tenant as currently deployable', () => {
        const runbook = fs.readFileSync(path.join(DOCS_DIR, 'google-oauth-setup.md'), 'utf-8');
        assert.ok(!/\|\s*`?prod`?\s*\|\s*`?(au|uk|us)`?\s*\|/.test(runbook),
          'the runbook still has a table row listing a prod tenant as a deployment');
        assert.ok(!/prod-(au|uk|us)\/app-config\/school_calendar_services/.test(runbook),
          'the runbook still lists a prod secret id as one to create');
        assert.match(runbook, /only\s+`?dev`?\s*\/\s*`?au`?\s+is deployable/i,
          'the runbook does not state that only dev/au is deployable from this repo');
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: FAILURE - a declaration is removed while a consumer survives', () => {
      it('Given variable "account_id" has been removed But a .tf file still interpolates var.account_id, When terraform validate runs, Then it fails with "Reference to undeclared input variable"', () => {
        // Reproduces the exact half-done refactor this ticket had to avoid:
        // the real variables.tf (account_id already gone) plus a fixture that
        // still reads var.account_id, the way scheduler_calendar.tf used to.
        let workspace;
        try {
          workspace = makeWorkspace({
            'variables.tf': readTf('variables.tf'),
            'stale_consumer.tf': [
              'locals {',
              '  stale_arn = "arn:aws:scheduler:${var.region}:${var.account_id}:schedule/default/x"',
              '}'
            ].join('\n')
          }, { copyConfig: true });

          const report = validateJson(workspace);
          assert.ok(report.error_count > 0,
            'terraform validate accepted a var.account_id reference with no declaration - ' +
            'this scenario is not discriminating and the guard below proves nothing');
          const summaries = report.diagnostics.map(d => `${d.summary}: ${d.detail || ''}`).join(' | ');
          assert.match(summaries, /Reference to undeclared input variable/,
            `expected a "Reference to undeclared input variable" error, got: ${summaries}`);
          assert.match(summaries, /account_id/,
            `the error does not name account_id: ${summaries}`);
        } finally {
          removeWorkspace(workspace);
        }
      });

      it('And the change is rejected rather than applied: the real tree has no such reference, so it validates', () => {
        let workspace;
        try {
          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
          const report = validateJson(workspace);
          assert.equal(report.error_count, 0,
            `the real variables.tf does not validate on its own: ${JSON.stringify(report.diagnostics)}`);
        } finally {
          removeWorkspace(workspace);
        }
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: FAILURE - a tfvars key is removed while a required declaration survives', () => {
      it('Given a key has been removed from config/dev/au.tfvars But its variable is still declared with no default, When terraform plan runs with that var file, Then it fails with "No value for required variable"', () => {
        // The mirror image of the scenario above, and the reason declaration
        // and tfvars key had to move together in one commit.
        let workspace;
        try {
          const tfvars = readTf('config', 'dev', 'au.tfvars');
          const stripped = tfvars
            .split('\n')
            .filter(line => !/^\s*tenant\s*=/.test(line))
            .join('\n');
          assert.notEqual(stripped, tfvars,
            'could not find the `tenant =` assignment in dev/au.tfvars to strip - fix this test rather than letting the mutation no-op');

          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') });
          fs.mkdirSync(path.join(workspace, 'config'), { recursive: true });
          fs.writeFileSync(path.join(workspace, 'config', 'stripped.tfvars'), stripped, 'utf-8');

          const result = tryPlan(workspace, ['-var-file=config/stripped.tfvars']);
          assert.equal(result.ok, false,
            'terraform plan accepted a var file missing a required variable - the scenario is not discriminating');
          assert.match(result.output, /No value for required variable/,
            `expected a "No value for required variable" error, got: ${result.output}`);
          assert.match(result.output, /variable "tenant"|input variable "tenant"/,
            `the error does not name the stripped variable "tenant": ${result.output}`);
        } finally {
          removeWorkspace(workspace);
        }
      });

      it('And the discriminating half: the unmodified dev/au.tfvars plans cleanly', () => {
        // Proves the failure above is caused by the stripped key, not by the
        // provider-free workspace being unplannable in general.
        let workspace;
        try {
          workspace = makeWorkspace({ 'variables.tf': readTf('variables.tf') }, { copyConfig: true });
          const result = tryPlan(workspace, [`-var-file=${DEV_AU_VAR_FILE}`]);
          assert.ok(result.ok,
            `the real dev/au.tfvars should satisfy every required variable, but plan failed: ${result.output}`);
          assert.ok(!/Value for undeclared variable/i.test(result.output),
            `plan warned about an undeclared variable:\n${result.output}`);
        } finally {
          removeWorkspace(workspace);
        }
      });
    });

    // -------------------------------------------------------------------------
    // RETAINED, WITH ITS CONCLUSION REVERSED BY TASK-052. The mechanism this
    // scenario proves is unchanged and still worth guarding: deleting a
    // terraform_remote_state data source while a reader survives is a hard
    // "Reference to undeclared resource" error, not a silent degradation.
    // What TASK-052 changes is the VERDICT. Under TASK-051 the correct fix was
    // "keep the data source". Under TASK-052 it is "delete the readers FIRST,
    // then the data source" - which is what was done - so the closing assertion
    // that the real tree still holds those reads is inverted below.
    describe('Scenario: FAILURE - the data source is deleted while a reader survives', () => {
      // Fixture mirroring lambda_calendar.tf's two reads. It is a copy, not the
      // real file, precisely because this scenario has to DELETE the data source
      // to show what breaks - the real terraform/ directory is never touched.
      const BASESTACK_FIXTURE = [
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
        '  sg_vpc_id         = data.terraform_remote_state.basestack.outputs.vpc_id',
        '}'
      ].join('\n');

      it('Given data.terraform_remote_state.basestack has been deleted by mistake, When terraform validate runs, Then the vpc_config and security group reads have no source', () => {
        let workspace;
        try {
          const withoutBasestack = BASESTACK_FIXTURE.replace(
            /data "terraform_remote_state" "basestack" \{[\s\S]*?\n\}\n/,
            ''
          );
          assert.ok(!withoutBasestack.includes('data "terraform_remote_state" "basestack" {'),
            'the deletion mutation did not apply - fix this test rather than letting it no-op');

          workspace = makeWorkspace({ 'main.tf': withoutBasestack });
          const report = validateJson(workspace);
          assert.ok(report.error_count > 0,
            'terraform validate accepted reads from a deleted remote state - the Lambda would silently lose its VPC attachment');
          const summaries = report.diagnostics.map(d => `${d.summary}: ${d.detail || ''}`).join(' | ');
          assert.match(summaries, /Reference to undeclared resource|not been declared/,
            `expected an undeclared-resource error, got: ${summaries}`);
        } finally {
          removeWorkspace(workspace);
        }
      });

      it('And the intact fixture (data source + readers together) still validates, so the error above really is about the deletion', () => {
        let workspace;
        try {
          workspace = makeWorkspace({ 'main.tf': BASESTACK_FIXTURE });
          const report = validateJson(workspace);
          assert.equal(report.error_count, 0,
            `the intact basestack fixture should validate: ${JSON.stringify(report.diagnostics)}`);
        } finally {
          removeWorkspace(workspace);
        }
      });

      // INVERTED BY TASK-052. This used to close with "the real tree really does
      // keep both reads and the data source". It no longer does, and must not:
      // TASK-052 removed the readers and the data source TOGETHER, which is the
      // only ordering that avoids the failure the fixture above demonstrates.
      it('And the real terraform/ tree contains no such dangling reference - readers and data source went together', () => {
        const lambdaTf = codeOnly(readTf('lambda_calendar.tf'));
        assert.ok(!lambdaTf.includes('data.terraform_remote_state.basestack'),
          'lambda_calendar.tf still reads the deleted basestack remote state - this is the dangling ' +
          'reference the fixture above proves terraform rejects');
        assert.ok(!/data\s+"terraform_remote_state"\s+"basestack"/.test(codeOnly(readTf('provider.tf'))),
          'provider.tf still declares data "terraform_remote_state" "basestack"');

        // No .tf file anywhere may reference it in code.
        const offenders = listTfFiles().filter(
          file => codeOnly(readTf(file)).includes('terraform_remote_state.basestack'));
        assert.deepEqual(offenders, [],
          `these files still reference data.terraform_remote_state.basestack: ${offenders.join(', ')}`);
      });
    });

    // -------------------------------------------------------------------------
    describe('Scenario: Nothing outside the refactor moved', () => {
      it('Given the ticket says no file under src/ was touched, Then the calendar Lambda source is unchanged in this working tree', () => {
        const status = execFileSync('git', ['status', '--porcelain', '--', 'src'], {
          cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000
        }).trim();
        assert.equal(status, '', `files under src/ were modified by this ticket:\n${status}`);
      });

      it('And dynamodb_calendar_connections.tf, dynamodb_calendar_events.tf and kms_calendar.tf are untouched', () => {
        const untouched = ['dynamodb_calendar_connections.tf', 'dynamodb_calendar_events.tf', 'kms_calendar.tf'];
        const status = execFileSync(
          'git', ['status', '--porcelain', '--', ...untouched.map(f => `terraform/${f}`)],
          { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 }
        ).trim();
        assert.equal(status, '', `out-of-scope terraform files were modified:\n${status}`);
      });

      it('And every variable the stack still needs is still declared and unchanged in kind', () => {
        const variablesTf = readTf('variables.tf');
        const KEPT = [
          'region', 'environment', 'tenant', 'project_name', 'Alert_SNS_ARN', 'tags',
          'manage_lambda_log_groups', 'calendar_log_level', 'anthropic_model', 'public_base_url'
        ];
        for (const name of KEPT) {
          assert.ok(new RegExp(`^\\s*variable\\s+"${name}"`, 'm').test(variablesTf),
            `variable "${name}" must still be declared, but is missing`);
        }
      });
    });
  });
});
