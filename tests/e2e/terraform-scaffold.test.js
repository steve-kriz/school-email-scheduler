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
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

// The terraform locals below are evaluated for real with `terraform console`.
// That cannot run inside terraform/ itself: the s3 backend declared in
// provider.tf demands AWS credentials. So variables.tf plus config/ are copied
// into a throwaway workspace which contains no backend and no providers, and
// is initialised with -backend=false.
const DEV_AU_VAR_FILE = 'config/dev/au.tfvars';
const TERRAFORM_BIN = resolveTerraformBin();

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
  // Neither absolute candidate exists. Fall back to whatever `terraform` on
  // PATH resolves to, but never trust that silently: prove it actually runs
  // before handing it back, and if it does not, fail loudly naming every
  // location that was tried so a missing/broken terraform is diagnosable
  // rather than surfacing later as a mysterious ENOENT deep in some test.
  try {
    execSync('terraform version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000
    });
  } catch (error) {
    throw new Error(
      'Could not resolve a terraform binary. Tried absolute paths: ' +
      `${candidates.join(', ')} (none exist on disk). Fell back to "terraform" on PATH, ` +
      `but running "terraform version" failed: ${describeExecError(error)}`
    );
  }
  return 'terraform';
}

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
    // Never mask the real test result with a cleanup error, but do not leave a
    // leaked workspace unannounced either.
    console.error(`Failed to remove temporary terraform workspace ${workspace}: ${error.message}`);
  }
}

/**
 * Build a throwaway terraform workspace holding variables.tf (optionally
 * mutated) and config/, and run `terraform init -backend=false` in it once.
 * Callers reuse the returned directory for every `terraform console` call -
 * init is the slow part, evaluation is not.
 */
function createTerraformConsoleWorkspace(mutateVariablesTf) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-locals-'));
  try {
    const variablesTfPath = path.join(TERRAFORM_DIR, 'variables.tf');
    const original = fs.readFileSync(variablesTfPath, 'utf-8');
    const contents = mutateVariablesTf ? mutateVariablesTf(original) : original;
    fs.writeFileSync(path.join(workspace, 'variables.tf'), contents, 'utf-8');
    fs.cpSync(CONFIG_DIR, path.join(workspace, 'config'), { recursive: true });

    execSync(`"${TERRAFORM_BIN}" init -backend=false -input=false -no-color`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000
    });
  } catch (error) {
    removeWorkspace(workspace);
    throw new Error(`Failed to prepare terraform console workspace: ${describeExecError(error)}`);
  }
  return workspace;
}

/**
 * Evaluate a single terraform expression by feeding it to `terraform console`
 * on stdin, and return the string it printed. Throws - never returns a
 * fallback - if terraform fails or the output cannot be parsed.
 */
function evaluateTerraformExpression(workspace, expression, varFile = DEV_AU_VAR_FILE) {
  let stdout;
  try {
    stdout = execSync(`"${TERRAFORM_BIN}" console -no-color -var-file=${varFile}`, {
      cwd: workspace,
      input: `${expression}\n`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000
    });
  } catch (error) {
    throw new Error(`terraform console failed evaluating "${expression}": ${describeExecError(error)}`);
  }

  // Strip any ANSI escapes before looking for the quoted result.
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const match = clean.match(/"((?:[^"\\]|\\.)*)"/);
  if (!match) {
    throw new Error(
      `Could not parse a string value for "${expression}" from terraform console output: ${JSON.stringify(clean)}`
    );
  }
  return match[1];
}

// Matches the `name_prefix = ...` assignment whatever spacing is used, so a
// reformat of variables.tf cannot quietly turn the mutation below into a no-op.
// name_prefix_short is not matched: `name_prefix` there is followed by `_`.
const NAME_PREFIX_ASSIGNMENT = /^([ \t]*name_prefix[ \t]*=[ \t]*)(\S.*)$/m;
const REORDERED_NAME_PREFIX = '"${var.environment}-${var.tenant}-${var.project_name}"';

function reorderNamePrefixInterpolation(variablesTfContents) {
  if (!NAME_PREFIX_ASSIGNMENT.test(variablesTfContents)) {
    throw new Error(
      'Could not find the `name_prefix =` assignment in terraform/variables.tf, so the ordering ' +
      'mutation could not be applied. Fix this test rather than letting the mutation silently no-op.'
    );
  }
  const mutated = variablesTfContents.replace(
    NAME_PREFIX_ASSIGNMENT,
    (fullMatch, lhs) => `${lhs}${REORDERED_NAME_PREFIX}`
  );
  if (mutated === variablesTfContents) {
    throw new Error('The ordering mutation left terraform/variables.tf unchanged - the mutation is not being applied.');
  }
  return mutated;
}

// A locals-only stand-in for the real secrets pattern in main.tf. It cannot
// reuse the aws_secretsmanager_secret_version data source (that needs AWS
// credentials), so a `variable` plays the part of the decoded secret payload.
// The lookup() reads below are copied verbatim from main.tf so the same
// convention is what actually gets evaluated.
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

/**
 * Build a throwaway workspace holding only SECRET_LOOKUP_MAIN_TF and run
 * `terraform init -backend=false` in it once. No provider is declared, so
 * init needs no plugins and no AWS credentials.
 */
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

/**
 * Evaluate `expression` in `workspace` with `secretJson` supplied to
 * `variable "secret_json"` via a TF_VAR_ environment variable (avoids
 * shell-quoting a JSON string full of quotes through `-var` on the command
 * line). Unlike evaluateTerraformExpression, this never throws when
 * evaluation itself fails - it returns { ok: false, error } so callers can
 * assert on a failure, not just on success.
 */
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
    const clean = stdout.replace(/\[[0-9;]*m/g, '');
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

/**
 * Parse `content` for every textual `local.secrets` access and classify each
 * one as either a guarded `lookup(local.secrets, "KEY", "default")` read or a
 * direct-index/attribute read that bypasses the default. This walks the
 * source rather than checking for the presence of the `lookup(` literal
 * alone, so a direct index elsewhere in the file cannot hide behind an
 * unrelated lookup() call.
 */
function parseSecretsAccesses(content) {
  const guardedKeys = [];
  const violations = [];
  const OCCURRENCE = /local\.secrets/g;
  let match;
  while ((match = OCCURRENCE.exec(content)) !== null) {
    const rest = content.slice(match.index + match[0].length);
    const shape = rest.match(/^\s*(\[\s*(["'])([^"']+)\2\s*\]|\.[A-Za-z_][A-Za-z0-9_]*|,)/);
    if (!shape) {
      violations.push({ key: '(unrecognised)', context: rest.slice(0, 40).trim() });
      continue;
    }
    if (shape[1].startsWith('[')) {
      violations.push({ key: shape[3], context: 'direct index' });
    } else if (shape[1].startsWith('.')) {
      violations.push({ key: shape[1].slice(1), context: 'direct attribute access' });
    } else {
      // A comma right after `local.secrets` is only a guarded read if it is
      // genuinely the first argument of a lookup(...) call.
      const precedingText = content.slice(0, match.index);
      if (!/lookup\(\s*$/.test(precedingText)) {
        violations.push({ key: '(unknown)', context: 'local.secrets used outside a lookup() call' });
        continue;
      }
      const callRest = rest.match(/^\s*,\s*"([^"]+)"\s*,\s*"[^"]*"\s*\)/);
      if (!callRest) {
        violations.push({ key: '(unknown)', context: `lookup(local.secrets, ...) missing a quoted key/default: ${rest.slice(0, 60).trim()}` });
        continue;
      }
      guardedKeys.push(callRest[1]);
    }
  }
  return { guardedKeys, violations };
}

/**
 * Assert every local.secrets access in `content` is a guarded lookup() read,
 * and return the keys found guarded. Throws (naming the offending keys) on
 * any direct-index or other unguarded access.
 */
function assertAllSecretReadsAreGuarded(content, sourceLabel) {
  const { guardedKeys, violations } = parseSecretsAccesses(content);
  assert.equal(violations.length, 0,
    `${sourceLabel} contains ${violations.length} local.secrets access(es) that bypass lookup()'s default: ` +
    violations.map(v => `${v.key} (${v.context})`).join(', '));
  return guardedKeys;
}

describe('Terraform Scaffold E2E Tests', () => {
  describe('Feature: Terraform scaffold', () => {
    describe('Scenario: The shared layer validates on its own', () => {
      it('Given only the scaffold terraform files are present', () => {
        const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter(f => f.endsWith('.tf'));
        assert.ok(tfFiles.length > 0, 'No .tf files found');
        assert.ok(tfFiles.includes('provider.tf'), 'provider.tf not found');
        assert.ok(tfFiles.includes('variables.tf'), 'variables.tf not found');
        assert.ok(tfFiles.includes('main.tf'), 'main.tf not found');
      });

      it('When "terraform validate" is run in the terraform directory, Then error_count is 0', () => {
        let result;
        try {
          result = execSync(
            `"${TERRAFORM_BIN}" validate -json`,
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              // Several e2e suites run a full-config `terraform validate` in
              // this one shared directory concurrently, each loading the 800MB+
              // AWS provider schema. Under that contention this run exceeded the
              // old 30s ceiling and was killed - surfacing as "failed with
              // status null" and an empty stderr, indistinguishable from a
              // genuinely broken config. The ceiling is now generous so a kill
              // means a real hang, not a busy machine.
              timeout: 300000
            }
          );
        } catch (error) {
          const output = error.stdout || '';
          const stderr = error.stderr || '';
          console.error('Terraform validate output:', output);
          console.error('Terraform validate stderr:', stderr);
          assert.fail(
            `terraform validate failed with status ${error.status} (signal ${error.signal}): ` +
            `${stderr || output || error.message}`
          );
        }

        // `terraform validate` exits 0 on warnings alone, so the exit code by
        // itself tolerates them implicitly. Parse the -json output and assert
        // error_count === 0 explicitly -- never warning-free, since there are
        // 4 expected provider deprecation warnings that this intentionally
        // does not gate on.
        const parsed = JSON.parse(result);
        assert.equal(
          parsed.error_count,
          0,
          `terraform validate reported ${parsed.error_count} error(s): ` +
            JSON.stringify(parsed.diagnostics)
        );
      });
    });

    describe('Scenario: Resource names are prefixed per tenant and environment', () => {
      // One workspace, one `terraform init`, reused by every evaluation below.
      let workspace;

      before(() => {
        workspace = createTerraformConsoleWorkspace();
      });

      after(() => {
        removeWorkspace(workspace);
        workspace = undefined;
      });

      it('Given the dev/au tfvars are loaded, When the name_prefix local is evaluated, Then it equals "au-dev-receptionhq"', () => {
        const namePrefix = evaluateTerraformExpression(workspace, 'local.name_prefix');
        assert.equal(namePrefix, 'au-dev-receptionhq',
          `Expected terraform to evaluate local.name_prefix to "au-dev-receptionhq", got "${namePrefix}"`);
      });

      it('Given local.name_prefix_short was removed with the ALB target group, When it is evaluated, Then terraform rejects it as an unsupported local', () => {
        // TASK-051 deleted local.name_prefix_short (and var.project_name_short)
        // because TASK-049 removed its only consumer, the 32-char-capped ALB
        // target group name. Asserting the failure - rather than deleting the
        // test - is what proves the local is really gone rather than merely
        // no longer looked at.
        assert.throws(
          () => evaluateTerraformExpression(workspace, 'local.name_prefix_short'),
          /name_prefix_short|Unsupported attribute|not been declared/,
          'local.name_prefix_short still evaluates; TASK-051 was supposed to remove it');
      });

      it('Given the dev/au tfvars are loaded, When the secret_name local is evaluated, Then it equals "dev-au/app-config/school_calendar_services"', () => {
        const secretName = evaluateTerraformExpression(workspace, 'local.secret_name');
        assert.equal(secretName, 'dev-au/app-config/school_calendar_services',
          `Expected terraform to evaluate local.secret_name to "dev-au/app-config/school_calendar_services", got "${secretName}"`);
      });

      it('Given the name_prefix interpolation is reordered in a temp copy, When it is evaluated, Then it no longer equals "au-dev-receptionhq"', () => {
        // Proves the assertions above discriminate: the same harness, given a
        // wrong local, must produce a different value. If this ever passes with
        // the reordered interpolation still yielding "au-dev-receptionhq", the
        // evaluation is not really reading variables.tf.
        const baseline = evaluateTerraformExpression(workspace, 'local.name_prefix');
        assert.equal(baseline, 'au-dev-receptionhq',
          `Baseline local.name_prefix should be "au-dev-receptionhq" before mutating, got "${baseline}"`);

        let mutatedWorkspace;
        try {
          mutatedWorkspace = createTerraformConsoleWorkspace(reorderNamePrefixInterpolation);

          const mutatedSource = fs.readFileSync(path.join(mutatedWorkspace, 'variables.tf'), 'utf-8');
          assert.ok(mutatedSource.includes(REORDERED_NAME_PREFIX),
            'The temp copy of variables.tf does not contain the reordered interpolation');

          const mutatedPrefix = evaluateTerraformExpression(mutatedWorkspace, 'local.name_prefix');
          assert.notEqual(mutatedPrefix, 'au-dev-receptionhq',
            'Reordering the name_prefix interpolation still evaluated to "au-dev-receptionhq" - ' +
            'the test is not evaluating the local and would pass with the ordering wrong');
          assert.equal(mutatedPrefix, 'dev-au-receptionhq',
            `Expected the reordered interpolation to evaluate to "dev-au-receptionhq", got "${mutatedPrefix}"`);
        } finally {
          removeWorkspace(mutatedWorkspace);
        }
      });
    });

    describe('Scenario: Stale DNS does not silently serve nothing (TASK-049)', () => {
      it('Given the Route53 A-ALIAS previously pointed at the shared ALB, When the listener rule for this app is removed, Then the record is removed too', () => {
        // TASK-049 removed the A-ALIAS; TASK-051 then removed the now-orphaned
        // sub_domain variable and its tfvars key. So sub_domain is no longer
        // asserted to equal "calendar" - it is asserted to be absent from both
        // sides at once, which is the only state terraform accepts (a declared
        // variable with no value is a hard error; a tfvars key with no
        // declaration is an "undeclared variable" warning).
        const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
        assert.ok(fs.existsSync(tfvarsPath), 'dev/au.tfvars not found');
        const tfvarsContent = fs.readFileSync(tfvarsPath, 'utf-8');

        assert.ok(!/^\s*sub_domain\s*=/m.test(tfvarsContent),
          'dev/au.tfvars still assigns sub_domain, but variable "sub_domain" was removed');
        const variablesTf = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
        assert.ok(!/^\s*variable\s+"sub_domain"/m.test(variablesTf),
          'variable "sub_domain" is still declared, but nothing sets or reads it');

        const mainTfPath = path.join(TERRAFORM_DIR, 'main.tf');
        const mainTfContent = fs.readFileSync(mainTfPath, 'utf-8');

        // Declarations only: main.tf carries a comment explaining WHY these were
        // removed, and that comment is exactly what should survive.
        assert.ok(!/^\s*resource\s+"aws_route53_record"/m.test(mainTfContent),
          'aws_route53_record still declared in main.tf; it would resolve to an ALB with no rule for this app');
        assert.ok(!/^\s*data\s+"aws_lb_listener"/m.test(mainTfContent),
          'the ALB listener data source still exists, but no listener rule is attached to it any more');
        assert.ok(!/^\s*data\s+"aws_lb"/m.test(mainTfContent),
          'the shared ALB is still looked up, but nothing routes to this app through it');
      });

      it('And the hostname the app is advertised on is the function URL, whose TLS name AWS owns', () => {
        // TLS name matches the advertised hostname: the app is served from
        // *.lambda-url.<region>.on.aws, which AWS presents a valid certificate
        // for. No custom hostname is advertised, so no certificate has to be
        // provisioned or matched by this repo.
        const lambdaTfPath = path.join(TERRAFORM_DIR, 'lambda_calendar.tf');
        const lambdaTfContent = fs.readFileSync(lambdaTfPath, 'utf-8');

        assert.ok(lambdaTfContent.includes('resource "aws_lambda_function_url" "calendar"'),
          'no function URL declared, so the app has no advertised hostname at all');
        const outputMatch = lambdaTfContent.match(/output "calendar_function_url" \{[\s\S]*?\n\}/);
        assert.ok(outputMatch, 'output "calendar_function_url" not found');
        assert.ok(outputMatch[0].includes('aws_lambda_function_url.calendar.function_url'),
          'the advertised origin is not taken from the function URL resource itself');
        assert.ok(!lambdaTfContent.includes('aws_acm_certificate'),
          'a custom certificate is declared, but the function URL uses the AWS-owned on.aws certificate');
      });
    });

    describe('Scenario: The state key does not collide with the chatbot\'s', () => {
      it('Given the dev/au init script, When TF_STATE_KEY is read, Then it contains "school_calendar" And it does not equal "terraform_dev_ohq_chatbot.tfstate"', () => {
        const initScriptPath = path.join(TERRAFORM_DIR, 'terraform_init_dev_au.sh');
        assert.ok(fs.existsSync(initScriptPath), 'terraform_init_dev_au.sh not found');
        const scriptContent = fs.readFileSync(initScriptPath, 'utf-8');

        const stateKeyMatch = scriptContent.match(/TF_STATE_KEY="([^"]+)"/);
        assert.ok(stateKeyMatch, 'TF_STATE_KEY not found in init script');
        const stateKey = stateKeyMatch[1];

        assert.ok(stateKey.includes('school_calendar'),
          `Expected TF_STATE_KEY to contain "school_calendar", got "${stateKey}"`);
        assert.notEqual(stateKey, 'terraform_dev_ohq_chatbot.tfstate',
          'TF_STATE_KEY should not match the chatbot\'s state key');
      });
    });

    describe('Scenario: A missing optional secret key does not break planning', () => {
      // These evaluate the real secrets = jsondecode(...) / lookup(...)
      // pattern for real via `terraform console`, against a throwaway
      // locals-only config with no AWS provider and no backend - no AWS
      // credentials are needed and no AWS API call is made.
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

      it('Given a secret payload that omits "ANTHROPIC_API_KEY", When the lookup with an empty default is evaluated, Then the result is an empty string and evaluation does not error', () => {
        const result = tryEvaluateSecretExpression(
          workspace,
          'lookup(local.secrets, "ANTHROPIC_API_KEY", "")',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        assert.ok(result.ok,
          `Expected lookup() with a default to evaluate cleanly against a payload missing the key, but it errored: ${result.error}`);
        assert.equal(result.value, '',
          `Expected lookup(local.secrets, "ANTHROPIC_API_KEY", "") to yield "" for a missing key, got "${result.value}"`);
      });

      it('Given the same payload, When local.secrets["ANTHROPIC_API_KEY"] is evaluated directly (no lookup), Then evaluation errors', () => {
        // This is what makes the scenario above discriminating: the same
        // missing key, read without lookup()'s default, must fail. If this
        // ever passes instead of erroring, the test above would not be
        // proving lookup() does anything.
        const result = tryEvaluateSecretExpression(
          workspace,
          'local.secrets["ANTHROPIC_API_KEY"]',
          PAYLOAD_MISSING_ANTHROPIC_KEY
        );
        assert.equal(result.ok, false,
          `Expected a direct index on a missing key to error, but it evaluated to "${result.value}". ` +
          'If a direct index no longer errors, this test stops being discriminating.');
        assert.match(result.error, /Invalid index/,
          `Expected the direct-index failure to be a terraform "Invalid index" error, got: ${result.error}`);
      });
    });

    describe('Scenario Outline: Every secret read is guarded', () => {
      const REQUIRED_SECRET_KEYS = [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'ANTHROPIC_API_KEY',
        'SESSION_SECRET',
        'ALLOWED_ORIGINS'
      ];

      it('Given terraform/main.tf, Then every local.secrets access uses lookup() with a default, covering all five secret keys', () => {
        const mainTfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'main.tf'), 'utf-8');
        const guardedKeys = assertAllSecretReadsAreGuarded(mainTfContent, 'terraform/main.tf');

        for (const key of REQUIRED_SECRET_KEYS) {
          assert.ok(guardedKeys.includes(key),
            `Expected terraform/main.tf to read "${key}" via lookup(local.secrets, "${key}", ...), but no guarded read was found`);
        }
      });
    });

    describe('Scenario: A direct index introduced later is caught', () => {
      it('Given a copy of main.tf containing local.secrets["SESSION_SECRET"], When the guard assertion runs, Then it fails and names "SESSION_SECRET"', () => {
        const mainTfContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'main.tf'), 'utf-8');
        const mutated = mainTfContent.replace(
          'lookup(local.secrets, "SESSION_SECRET", "")',
          'local.secrets["SESSION_SECRET"]'
        );
        assert.notEqual(mutated, mainTfContent,
          'Could not find the SESSION_SECRET lookup line in terraform/main.tf to mutate - fix this test rather than letting the mutation silently no-op.');

        assert.throws(
          () => assertAllSecretReadsAreGuarded(mutated, 'mutated main.tf'),
          /SESSION_SECRET/,
          'Expected the guard assertion to fail and name SESSION_SECRET when a direct index is introduced'
        );
      });
    });

    describe('Scenario Outline: Every deployable tenant has a config file, and only deployable tenants do', () => {
      // TASK-051 cut this stack to one deployable environment. The outline used
      // to have four examples; the three prod rows moved to the "removed" table
      // below so their absence is asserted, not merely unvisited.
      const present = [
        { path: 'config/dev/au.tfvars', desc: 'dev/au' }
      ];
      const removed = [
        { path: 'config/prod/au.tfvars', desc: 'prod/au' },
        { path: 'config/prod/uk.tfvars', desc: 'prod/uk' },
        { path: 'config/prod/us.tfvars', desc: 'prod/us' }
      ];

      present.forEach(example => {
        it(`Given the terraform config directory, Then a tfvars file exists at "${example.path}" (${example.desc})`, () => {
          const fullPath = path.join(TERRAFORM_DIR, example.path);
          assert.ok(fs.existsSync(fullPath),
            `Expected tfvars file not found: ${fullPath}`);

          const content = fs.readFileSync(fullPath, 'utf-8');
          assert.ok(content.length > 0, `tfvars file is empty: ${fullPath}`);
        });
      });

      removed.forEach(example => {
        it(`Given the terraform config directory, Then no tfvars file exists at "${example.path}" (${example.desc} is no longer deployable)`, () => {
          const fullPath = path.join(TERRAFORM_DIR, example.path);
          assert.ok(!fs.existsSync(fullPath),
            `${example.path} still exists, but TASK-051 removed ${example.desc} as a deployable tenant`);
        });
      });

      it('And terraform/config/ contains no directory other than dev/', () => {
        const dirs = fs.readdirSync(CONFIG_DIR, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
          .sort();
        assert.deepEqual(dirs, ['dev'],
          `terraform/config/ should contain only dev/ after TASK-051, found: ${dirs.join(', ')}`);
      });
    });
  });
});
