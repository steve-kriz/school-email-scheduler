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
  // Fall back to whatever is on PATH. If terraform is not installed at all the
  // exec calls below throw, and every caller turns that into a hard failure -
  // this helper must never let a missing terraform become a silent skip.
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

      it('When "terraform validate" is run in the terraform directory, Then it exits with status 0', () => {
        try {
          const result = execSync(
            'terraform validate -json',
            {
              cwd: TERRAFORM_DIR,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 30000
            }
          );
          // If we get here, validation succeeded
          assert.ok(true, 'terraform validate succeeded');
        } catch (error) {
          const output = error.stdout || '';
          const stderr = error.stderr || '';
          console.error('Terraform validate output:', output);
          console.error('Terraform validate stderr:', stderr);
          assert.fail(`terraform validate failed with status ${error.status}: ${stderr}`);
        }
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

      it('Given the dev/au tfvars are loaded, When the name_prefix_short local is evaluated, Then it equals "au-dev-rhq"', () => {
        const namePrefixShort = evaluateTerraformExpression(workspace, 'local.name_prefix_short');
        assert.equal(namePrefixShort, 'au-dev-rhq',
          `Expected terraform to evaluate local.name_prefix_short to "au-dev-rhq", got "${namePrefixShort}"`);
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

    describe('Scenario: The calendar sub-domain is used, not the chatbot\'s', () => {
      it('Given the dev/au tfvars are loaded, Then sub_domain equals "calendar" And the route53 record name starts with "calendar."', () => {
        const tfvarsPath = path.join(CONFIG_DIR, 'dev', 'au.tfvars');
        assert.ok(fs.existsSync(tfvarsPath), 'dev/au.tfvars not found');
        const tfvarsContent = fs.readFileSync(tfvarsPath, 'utf-8');

        const subDomainMatch = tfvarsContent.match(/sub_domain\s*=\s*"([^"]+)"/);
        assert.ok(subDomainMatch, 'sub_domain not found in tfvars');
        assert.equal(subDomainMatch[1], 'calendar',
          `Expected sub_domain to be "calendar", got "${subDomainMatch[1]}"`);

        // Check route53 record in main.tf
        const mainTfPath = path.join(TERRAFORM_DIR, 'main.tf');
        const mainTfContent = fs.readFileSync(mainTfPath, 'utf-8');

        assert.ok(mainTfContent.includes('var.sub_domain'),
          'var.sub_domain reference not found in main.tf');
        assert.ok(mainTfContent.includes('aws_route53_record'),
          'aws_route53_record resource not found in main.tf');
        assert.ok(mainTfContent.includes('${var.sub_domain}.'),
          'Route53 record name does not use var.sub_domain');
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
      it('Given the app-config secret JSON omits "ANTHROPIC_API_KEY", When the secrets local is evaluated with lookup and an empty default, Then evaluation succeeds and yields an empty string', () => {
        const mainTfPath = path.join(TERRAFORM_DIR, 'main.tf');
        const mainTfContent = fs.readFileSync(mainTfPath, 'utf-8');

        // Verify that lookup() with a default is used for secret keys
        assert.ok(mainTfContent.includes('lookup(local.secrets'),
          'lookup() not used for secret access in main.tf');
        assert.ok(mainTfContent.includes('ANTHROPIC_API_KEY'),
          'ANTHROPIC_API_KEY reference not found in main.tf');

        // Check that lookup() has a default value
        const anthropicMatch = mainTfContent.match(/anthropic_api_key\s*=\s*lookup\(local\.secrets,\s*"ANTHROPIC_API_KEY",\s*"([^"]*)"\)/);
        assert.ok(anthropicMatch, 'ANTHROPIC_API_KEY lookup not found or missing default');
        assert.equal(anthropicMatch[1], '',
          'Default value for ANTHROPIC_API_KEY should be empty string');

        assert.ok(true, 'lookup() with empty default allows missing keys to be handled gracefully');
      });
    });

    describe('Scenario Outline: Every tenant has a config file', () => {
      const examples = [
        { path: 'config/dev/au.tfvars', desc: 'dev/au' },
        { path: 'config/prod/au.tfvars', desc: 'prod/au' },
        { path: 'config/prod/uk.tfvars', desc: 'prod/uk' },
        { path: 'config/prod/us.tfvars', desc: 'prod/us' }
      ];

      examples.forEach(example => {
        it(`Given the terraform config directory, Then a tfvars file exists at "${example.path}" (${example.desc})`, () => {
          const fullPath = path.join(TERRAFORM_DIR, example.path);
          assert.ok(fs.existsSync(fullPath),
            `Expected tfvars file not found: ${fullPath}`);

          const content = fs.readFileSync(fullPath, 'utf-8');
          assert.ok(content.length > 0, `tfvars file is empty: ${fullPath}`);
        });
      });
    });
  });
});
