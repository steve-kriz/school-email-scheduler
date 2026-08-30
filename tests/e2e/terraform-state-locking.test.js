/**
 * TASK-050 e2e scenarios: "Feature: Terraform state locking uses S3 alone".
 *
 * Cucumber-style Given/When/Then specs run under `node --test` (no cucumber
 * package is installed and none is added).
 *
 * NO REAL CLOUD ACCESS AND NO DATABASE CONNECTION IS EVER OPENED:
 *   - the init scripts are EXECUTED for real, but with `terraform` shadowed by
 *     a bash function that only records its argv, so nothing reaches AWS;
 *   - terraform itself is only ever run as `validate` or `init -backend=false`
 *     / `console` against throwaway workspaces that declare no backend and no
 *     provider, so no credentials, no S3 and no DynamoDB are touched.
 *
 * Three acceptance criteria CANNOT be executed from this sandbox because they
 * need live AWS (an empty `terraform plan` per environment, state-bucket
 * versioning, and the deploy identity's IAM on the `.tflock` object). Per the
 * ticket those are covered here as DOCUMENTATION assertions only - see
 * "Scenario: The criteria that need live AWS are documented, not faked".
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  extractBackendS3Block,
  extractTerraformBlock,
  extractLabelledBlock,
  parseAssignments,
  unquote,
  constraintAllows,
  maskCommentsAndStrings,
  INIT_SCRIPTS,
  TFVARS_FILES,
  REMOTE_STATE_MAPS,
  REMOVED_REMOTE_STATE_MAPS
} from '../helpers/tf-state-locking.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');

// ---------------------------------------------------------------------------
// terraform binary resolution (same convention as the other e2e terraform
// suites: absolute candidates first, then a PROVEN fallback to PATH).
// ---------------------------------------------------------------------------
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

function resolveTerraformBin() {
  const candidates = ['C:/External/Terraform/terraform.exe', 'C:/External/Terraform/terraform'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    execFileSync('terraform', ['version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  } catch (error) {
    throw new Error(
      'Could not resolve a terraform binary. Tried absolute paths: ' +
      `${candidates.join(', ')} (none exist on disk). Fell back to "terraform" on PATH, ` +
      `but running "terraform version" failed: ${describeExecError(error)}`
    );
  }
  return 'terraform';
}

const TERRAFORM_BIN = resolveTerraformBin();

function removeWorkspace(workspace) {
  if (!workspace) return;
  try {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.error(`Failed to remove temporary workspace ${workspace}: ${error.message}`);
  }
}

const readTf = (...segments) => fs.readFileSync(path.join(TERRAFORM_DIR, ...segments), 'utf-8');

// ---------------------------------------------------------------------------
// Init-script execution harness.
//
// The script is SOURCED with a shell function named `terraform` already
// defined. A function takes precedence over any binary on PATH, so the real
// terraform is never reached and no AWS call can happen - while `eval
// $INIT_CMD` still executes for real, which is what makes this an e2e check of
// the command the script actually builds rather than a regex over its text.
// ---------------------------------------------------------------------------
const HARNESS = [
  'terraform() { echo "@@TFCALL@@ $*" >> "$OUT"; }',
  '. "$SCRIPT" > /dev/null 2>&1',
  '{',
  '  echo "@@INIT_CMD@@ $INIT_CMD"',
  '  echo "@@TF_STATE_KEY@@ $TF_STATE_KEY"',
  '  echo "@@TF_WORKSPACE@@ $TF_WORKSPACE"',
  '  echo "@@DDBTABLENAME@@ ${DDBTABLENAME+SET}"',
  '} >> "$OUT"',
  ''
].join('\n');

/**
 * Run one terraform_init_*.sh with terraform stubbed out and return what it
 * actually did: the terraform invocations, the built INIT_CMD, and the shell
 * variables that matter. `ci` selects the CI / non-CI branch of the guard.
 */
function runInitScript(scriptFile, { ci }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-init-harness-'));
  try {
    const harnessPath = path.join(workspace, 'harness.sh');
    const outPath = path.join(workspace, 'out.txt');
    fs.writeFileSync(harnessPath, HARNESS, 'utf-8');
    fs.writeFileSync(outPath, '', 'utf-8');

    const env = { ...process.env, OUT: outPath, SCRIPT: `./terraform/${scriptFile}` };
    // Prove the CI branch for real: set CI=true, or remove it entirely so the
    // operator (non-CI) branch runs even if the harness host sets CI itself.
    if (ci) env.CI = 'true';
    else delete env.CI;

    const result = spawnSync('bash', [harnessPath], {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60000, env
    });
    if (result.error) {
      throw new Error(`Could not run bash for ${scriptFile}: ${result.error.message}`);
    }

    const output = fs.readFileSync(outPath, 'utf-8');
    const pick = (marker) => {
      const line = output.split('\n').find(l => l.startsWith(`@@${marker}@@`));
      return line === undefined ? null : line.slice(`@@${marker}@@`.length).trim();
    };

    const calls = output.split('\n')
      .filter(l => l.startsWith('@@TFCALL@@'))
      .map(l => l.slice('@@TFCALL@@'.length).trim());

    const initCall = calls.find(c => c.startsWith('init '));
    if (!initCall) {
      throw new Error(
        `${scriptFile} never invoked \`terraform init\`. Captured output was: ${JSON.stringify(output)}`);
    }

    const backendConfigArgs = initCall.split(/\s+/)
      .filter(a => a.startsWith('-backend-config='))
      .map(a => a.slice('-backend-config='.length));

    return {
      raw: output,
      calls,
      initCall,
      initCmdText: pick('INIT_CMD'),
      stateKey: pick('TF_STATE_KEY'),
      workspaceName: pick('TF_WORKSPACE'),
      ddbTableNameSet: pick('DDBTABLENAME') === 'SET',
      backendConfigArgs,
      backendConfigKeys: backendConfigArgs.map(a => a.split('=')[0])
    };
  } finally {
    removeWorkspace(workspace);
  }
}

// ---------------------------------------------------------------------------
// terraform console workspace (variables.tf + config/ only: no backend, no
// provider, so `init -backend=false` downloads nothing and needs no creds).
// ---------------------------------------------------------------------------
function createConsoleWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-lock-console-'));
  try {
    fs.copyFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), path.join(workspace, 'variables.tf'));
    fs.cpSync(CONFIG_DIR, path.join(workspace, 'config'), { recursive: true });
    execFileSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
      cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000
    });
  } catch (error) {
    removeWorkspace(workspace);
    throw new Error(`Failed to prepare terraform console workspace: ${describeExecError(error)}`);
  }
  return workspace;
}

/**
 * Evaluate `expression` with `terraform console` against one tfvars file.
 * Returns { ok: true, stdout } or { ok: false, error } so a scenario can
 * assert on a FAILURE as readily as on a success.
 */
function tryConsole(workspace, expression, varFile) {
  try {
    const stdout = execFileSync(
      TERRAFORM_BIN, ['console', '-no-color', `-var-file=${varFile}`],
      { cwd: workspace, input: `${expression}\n`, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 }
    );
    return { ok: true, stdout: stdout.replace(/\[[0-9;]*m/g, '') };
  } catch (error) {
    return { ok: false, error: describeExecError(error) };
  }
}

/** Evaluate `jsonencode(<expr>)` and parse the JSON object terraform prints. */
function evaluateMap(workspace, expression, varFile) {
  const result = tryConsole(workspace, `jsonencode(${expression})`, varFile);
  assert.ok(result.ok, `terraform console failed evaluating ${expression} with ${varFile}: ${result.error}`);
  const match = result.stdout.match(/"((?:[^"\\]|\\.)*)"/);
  assert.ok(match, `Could not parse a JSON string from terraform console output: ${JSON.stringify(result.stdout)}`);
  return JSON.parse(JSON.parse(`"${match[1]}"`));
}

// ---------------------------------------------------------------------------
// The ticket text, used for the documentation-only acceptance criteria.
// ---------------------------------------------------------------------------
function readTicketText() {
  const tasksDir = path.join(PROJECT_ROOT, 'tasks');
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^TASK-050.*\.md$/i.test(entry.name)) found.push(full);
    }
  };
  walk(tasksDir);
  assert.equal(found.length > 0, true,
    `Could not find the TASK-050 ticket under ${tasksDir}. The acceptance criteria that ` +
    'require live AWS are documented there and nowhere else, so losing the file loses the record.');
  return { path: found[0], text: fs.readFileSync(found[0], 'utf-8') };
}

// ===========================================================================
describe('Feature: Terraform state locking uses S3 alone', () => {
  let providerContent;

  before(() => {
    providerContent = readTf('provider.tf');
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The backend declares S3 lockfile locking and no DynamoDB table', () => {
    it('Given the file terraform/provider.tf, When the backend "s3" block is read, Then it contains use_lockfile = true', () => {
      const backend = extractBackendS3Block(providerContent);
      assert.ok(backend, 'no `backend "s3"` block found in terraform/provider.tf');
      const assignments = parseAssignments(backend);
      assert.equal(assignments.get('use_lockfile'), 'true',
        `expected use_lockfile = true inside backend "s3", got ${assignments.get('use_lockfile')}`);
    });

    it('And it does not contain dynamodb_table', () => {
      const backend = extractBackendS3Block(providerContent);
      const assignments = parseAssignments(backend);
      assert.ok(!assignments.has('dynamodb_table'),
        'backend "s3" still declares dynamodb_table, so state would still be locked against the shared table');
    });

    it('And it still contains encrypt = true', () => {
      const backend = extractBackendS3Block(providerContent);
      const assignments = parseAssignments(backend);
      assert.equal(assignments.get('encrypt'), 'true',
        `expected encrypt = true to survive the change, got ${assignments.get('encrypt')}`);
    });

    it('And it still supplies no literal bucket/key/region (partial config preserved)', () => {
      const backend = extractBackendS3Block(providerContent);
      const assignments = parseAssignments(backend);
      const hardcoded = ['bucket', 'key', 'region'].filter(k => assignments.has(k));
      assert.deepEqual(hardcoded, [],
        `backend "s3" hardcodes ${hardcoded.join(', ')}; those must stay partial config from the init scripts`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The terraform block pins a version that supports use_lockfile', () => {
    let requiredVersion;

    before(() => {
      requiredVersion = unquote(parseAssignments(extractTerraformBlock(providerContent)).get('required_version'));
    });

    it('Given the terraform block, When required_version is read, Then it constrains Terraform to 1.10 or newer', () => {
      assert.ok(requiredVersion, 'the terraform { } block declares no required_version at all');
      assert.equal(constraintAllows(requiredVersion, '1.9.8'), false,
        `required_version ${JSON.stringify(requiredVersion)} still admits 1.9.8, which has no use_lockfile support`);
      assert.equal(constraintAllows(requiredVersion, '1.10.0'), true,
        `required_version ${JSON.stringify(requiredVersion)} rejects 1.10.0, the first version supporting use_lockfile`);
    });

    it('And the terraform binary actually installed here satisfies it', () => {
      const versionJson = JSON.parse(
        execFileSync(TERRAFORM_BIN, ['version', '-json'], { encoding: 'utf-8', timeout: 60000 }));
      const installed = versionJson.terraform_version;
      assert.ok(constraintAllows(requiredVersion, installed),
        `the installed terraform ${installed} does not satisfy required_version ${JSON.stringify(requiredVersion)}, ` +
        'so nobody here could run this configuration at all');
    });

    it('And required_providers still constrains hashicorp/aws to "~> 6.19"', () => {
      const requiredProviders = extractLabelledBlock(extractTerraformBlock(providerContent), 'required_providers');
      const aws = extractLabelledBlock(requiredProviders, 'aws\\s*=');
      const assignments = parseAssignments(aws);
      assert.equal(unquote(assignments.get('source')), 'hashicorp/aws');
      assert.equal(unquote(assignments.get('version')), '~> 6.19',
        `the aws provider constraint must be unchanged, got ${assignments.get('version')}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The init scripts no longer supply a lock table', () => {
    for (const script of INIT_SCRIPTS) {
      describe(`Given terraform/${script.file}`, () => {
        let operatorRun;
        let ciRun;

        before(() => {
          operatorRun = runInitScript(script.file, { ci: false });
          ciRun = runInitScript(script.file, { ci: true });
        });

        it('When the built INIT_CMD is inspected, Then it passes -backend-config for bucket, key and region', () => {
          for (const key of ['bucket', 'key', 'region']) {
            assert.ok(operatorRun.backendConfigKeys.includes(key),
              `${script.file} did not pass -backend-config="${key}=..."; ` +
              `it actually ran: ${operatorRun.initCall}`);
          }
        });

        it('And it passes no -backend-config for dynamodb_table', () => {
          assert.ok(!operatorRun.backendConfigKeys.includes('dynamodb_table'),
            `${script.file} still passes a dynamodb_table backend-config; it ran: ${operatorRun.initCall}`);
          assert.ok(!operatorRun.initCall.includes('dynamodb'),
            `${script.file}'s init command still mentions dynamodb: ${operatorRun.initCall}`);
        });

        it('And no DDBTABLENAME variable is exported', () => {
          assert.equal(operatorRun.ddbTableNameSet, false,
            `${script.file} still leaves DDBTABLENAME set in the shell after running`);
        });

        it('And the CI guard that omits the profile backend-config is still present', () => {
          // The guard is proven by running BOTH branches, not by matching text.
          assert.ok(operatorRun.backendConfigKeys.includes('profile'),
            `${script.file} did not pass a profile backend-config outside CI; it ran: ${operatorRun.initCall}`);
          assert.ok(operatorRun.backendConfigArgs.includes(`profile=${script.profile}`),
            `${script.file} passed the wrong profile outside CI; it ran: ${operatorRun.initCall}`);
          assert.ok(!ciRun.backendConfigKeys.includes('profile'),
            `${script.file} still passes a profile backend-config when CI=true; it ran: ${ciRun.initCall}`);
        });

        it('And it still initialises with -reconfigure and never -migrate-state', () => {
          assert.ok(operatorRun.initCall.includes('-reconfigure'),
            `${script.file} no longer runs init with -reconfigure: ${operatorRun.initCall}`);
          assert.ok(!operatorRun.initCall.includes('-migrate-state'),
            `${script.file} runs init with -migrate-state, which can prompt destructive state moves: ${operatorRun.initCall}`);
        });

        it('And it still selects the unchanged workspace with -or-create', () => {
          const workspaceCall = operatorRun.calls.find(c => c.startsWith('workspace '));
          assert.ok(workspaceCall, `${script.file} never ran terraform workspace select`);
          assert.equal(workspaceCall, `workspace select -or-create ${script.workspace}`,
            `${script.file} ran an unexpected workspace command: ${workspaceCall}`);
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The state key is untouched so the same state file is used', () => {
    for (const script of INIT_SCRIPTS) {
      it(`Given terraform/${script.file}, When TF_STATE_KEY is read, Then it is still terraform_\${TF_ENV_SHORT}_school_calendar.tfstate`, () => {
        // Checked twice over: the literal in the source is unchanged, and the
        // value the script actually expands to is the expected one.
        const literal = readTf(script.file).match(/^\s*TF_STATE_KEY\s*=\s*"([^"]*)"/m);
        assert.ok(literal, `${script.file} declares no TF_STATE_KEY`);
        assert.equal(literal[1], 'terraform_${TF_ENV_SHORT}_school_calendar.tfstate',
          `${script.file} TF_STATE_KEY literal changed to ${JSON.stringify(literal[1])}`);

        const run = runInitScript(script.file, { ci: true });
        const expected = `terraform_${script.envShort}_school_calendar.tfstate`;
        assert.equal(run.stateKey, expected,
          `${script.file} expanded TF_STATE_KEY to ${JSON.stringify(run.stateKey)}, expected ${expected}`);
        assert.ok(run.backendConfigArgs.includes(`key=${expected}`),
          `${script.file} did not pass the unchanged state key to the backend; it ran: ${run.initCall}`);
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The remote state data sources drop the inert lock table key', () => {
    let workspace;

    before(() => {
      workspace = createConsoleWorkspace();
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    // INVERTED BY TASK-052. This used to loop over ['basestack'], require that
    // data source to EXIST, and check only that it no longer indexed
    // dynamodb_table. TASK-052 removed the Lambda's vpc_config and
    // aws_security_group.calendar_sg - basestack's only readers - and deleted
    // the data source, its variable and its tfvars key with them. There is no
    // remote state left in this stack, which is a strictly stronger guarantee
    // that no data source indexes a lock table key.
    it('Given terraform/provider.tf, Then no data source indexes a dynamodb_table key', () => {
      assert.ok(!maskCommentsAndStrings(providerContent).includes('dynamodb_table'),
        'provider.tf still indexes ["dynamodb_table"] somewhere');
      assert.ok(
        !extractLabelledBlock(providerContent, 'data\\s+"terraform_remote_state"\\s+"legacystack"'),
        'data "terraform_remote_state" "legacystack" is still declared; TASK-051 removed it');
      assert.ok(
        !extractLabelledBlock(providerContent, 'data\\s+"terraform_remote_state"\\s+"basestack"'),
        'data "terraform_remote_state" "basestack" is still declared; TASK-052 removed it with the VPC attachment');
      assert.ok(!/data\s+"terraform_remote_state"/.test(maskCommentsAndStrings(providerContent)),
        'provider.tf still declares a terraform_remote_state data source of some name');
    });

    // The evaluate-the-map loop that used to live here ran over
    // REMOTE_STATE_MAPS = ['terraform_remote_state_basestack_config'] and
    // asserted terraform evaluated it to a non-empty bucket/key/region with no
    // dynamodb_table. That variable no longer exists, so REMOTE_STATE_MAPS is
    // empty and the loop is vacuous. It is replaced - not dropped - by an
    // executed assertion that terraform itself now rejects every removed map.
    it('And REMOTE_STATE_MAPS is empty, so the per-map evaluation loop below is vacuous by design', () => {
      assert.deepEqual(REMOTE_STATE_MAPS, [],
        'REMOTE_STATE_MAPS is non-empty; re-add the per-map evaluation coverage if a remote state comes back');
    });

    for (const varFile of TFVARS_FILES) {
      for (const mapName of REMOTE_STATE_MAPS) {
        it(`Given ${varFile}, When ${mapName} is evaluated by terraform, Then it declares bucket, key and region and no dynamodb_table`, () => {
          const map = evaluateMap(workspace, `var.${mapName}`, varFile);
          assert.deepEqual(Object.keys(map).sort(), ['bucket', 'key', 'region'],
            `${varFile} :: ${mapName} evaluated to keys ${Object.keys(map).sort().join(', ')}`);
          for (const key of ['bucket', 'key', 'region']) {
            assert.ok(typeof map[key] === 'string' && map[key].length > 0,
              `${varFile} :: ${mapName}.${key} is empty`);
          }
        });
      }

      for (const mapName of REMOVED_REMOTE_STATE_MAPS) {
        it(`Given ${varFile}, When terraform is asked to evaluate var.${mapName}, Then it rejects it as undeclared`, () => {
          const result = tryConsole(workspace, `var.${mapName}`, varFile);
          assert.equal(result.ok, false,
            `terraform still evaluated var.${mapName}, so the declaration survives somewhere`);
          assert.match(result.error, /not been declared|Reference to undeclared/,
            `expected an undeclared-variable error for var.${mapName}, got: ${result.error}`);
        });
      }
    }

    // INVERTED BY TASK-052. This used to index
    // var.terraform_remote_state_basestack_config["dynamodb_table"] and require
    // an "Invalid index" error, proving the key had been dropped from a map that
    // still existed. The whole map is gone now, so the same expression fails one
    // step earlier - on the undeclared VARIABLE, not the missing key. Both are
    // the desync failure path; this pins the stronger one.
    it('And the whole map is gone, not just the key: indexing it errors on the undeclared variable', () => {
      const result = tryConsole(
        workspace, 'var.terraform_remote_state_basestack_config["dynamodb_table"]', TFVARS_FILES[0]);
      assert.equal(result.ok, false,
        'indexing ["dynamodb_table"] still succeeded, so the basestack map was NOT removed');
      assert.match(result.error, /not been declared|Reference to undeclared|Invalid index/,
        `expected terraform to reject the removed map, got: ${result.error}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The configuration still validates', () => {
    // NOTE ON WHERE THIS RUNS.
    //
    // `terraform validate` against the FULL terraform/ directory has to load
    // the 800MB+ AWS provider schema and takes 10-30s. Three existing e2e
    // suites (terraform-scaffold, terraform-resolver, calendar-lambda-terraform)
    // already run it concurrently in that one shared directory, and the
    // slowest was measured at 28.8s against a 30s timeout. Adding a fourth
    // concurrent run tipped two of them into timing out - a failure caused
    // purely by test contention, not by this ticket's change.
    //
    // So the full-config validate is deliberately left to those existing
    // suites (the ticket names them as must-stay-green), and this scenario
    // validates the part THIS ticket actually edited - variables.tf plus every
    // surviving tfvars file - in an isolated, provider-free workspace that costs
    // milliseconds and contends with nothing.
    let workspace;

    before(() => {
      workspace = createConsoleWorkspace();
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    it('Given the edited variables and tfvars, When "terraform validate -json" is run, Then error_count is 0', () => {
      let stdout;
      try {
        stdout = execFileSync(TERRAFORM_BIN, ['validate', '-json'], {
          cwd: workspace, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000
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

    it('And every tfvars file still parses and loads under terraform', () => {
      // A tfvars file broken by the dynamodb_table removal would fail here.
      for (const varFile of TFVARS_FILES) {
        const result = tryConsole(workspace, 'var.region', varFile);
        assert.ok(result.ok, `terraform could not load ${varFile}: ${result.error}`);
      }
    });

    it('And the full-configuration validate remains covered by the existing e2e suite', () => {
      // Guards against that expensive coverage silently disappearing now that
      // this file deliberately does not duplicate it.
      const scaffold = fs.readFileSync(path.join(__dirname, 'terraform-scaffold.test.js'), 'utf-8');
      assert.match(scaffold, /validate/,
        'tests/e2e/terraform-scaffold.test.js no longer runs terraform validate');
      assert.match(scaffold, /error_count/,
        'tests/e2e/terraform-scaffold.test.js no longer asserts on validate error_count');
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The application DynamoDB tables are not in scope', () => {
    const changedFiles = () => {
      const tracked = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8'
      });
      assert.equal(tracked.status, 0, `git diff failed: ${tracked.stderr}`);
      return tracked.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    };

    it('Given the change for this ticket, When the diff is inspected, Then terraform/dynamodb_calendar_connections.tf is unchanged', () => {
      assert.ok(!changedFiles().includes('terraform/dynamodb_calendar_connections.tf'),
        'terraform/dynamodb_calendar_connections.tf was modified; that table holds every user\'s ' +
        'KMS-encrypted refresh token and is explicitly out of scope');
    });

    it('And terraform/dynamodb_calendar_events.tf is unchanged', () => {
      assert.ok(!changedFiles().includes('terraform/dynamodb_calendar_events.tf'),
        'terraform/dynamodb_calendar_events.tf was modified; it is explicitly out of scope');
    });

    it('And no file under src/ is touched', () => {
      const srcFiles = changedFiles().filter(f => f.startsWith('src/'));
      assert.deepEqual(srcFiles, [],
        `this is a terraform-only change, but src/ files were modified: ${srcFiles.join(', ')}`);
    });

    it('And no aws_dynamodb_table resource is added, removed or modified', () => {
      const diff = spawnSync('git', ['diff', 'HEAD', '--', 'terraform'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8'
      });
      assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
      const touchedLines = diff.stdout.split('\n')
        .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
      const tableLines = touchedLines.filter(l => l.includes('aws_dynamodb_table'));
      assert.deepEqual(tableLines, [],
        `the diff adds or removes aws_dynamodb_table lines: ${tableLines.join(' | ')}`);
    });

    it('And -migrate-state appears nowhere in the change', () => {
      const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
      assert.equal(diff.status, 0, `git diff failed: ${diff.stderr}`);
      const added = diff.stdout.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++') && l.includes('-migrate-state'));
      assert.deepEqual(added, [],
        `the change introduces -migrate-state, which is wrong here: ${added.join(' | ')}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: An operator on a pre-1.10 Terraform is stopped rather than left unlocked', () => {
    // No pre-1.10 binary exists in this sandbox (only 1.16.0), so the
    // constraint MECHANISM is proven by inversion: a config whose
    // required_version excludes the installed binary must make `terraform
    // init` fail, exactly as ">= 1.10" would fail on a 1.8.5 binary.
    let workspace;

    before(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-lock-version-'));
    });

    after(() => {
      removeWorkspace(workspace);
      workspace = undefined;
    });

    const initWith = (contents) => {
      fs.writeFileSync(path.join(workspace, 'main.tf'), contents, 'utf-8');
      const result = spawnSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
        cwd: workspace, encoding: 'utf-8', timeout: 180000
      });
      return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
    };

    it('Given a required_version the running binary does not satisfy, When terraform init runs, Then it fails on the version constraint', () => {
      const { status, output } = initWith('terraform {\n  required_version = "< 1.10"\n}\n');
      assert.notEqual(status, 0,
        `terraform init succeeded despite an unsatisfiable required_version; output: ${output}`);
      assert.match(output, /Unsupported Terraform Core version/,
        `expected an unsupported-core-version failure, got: ${output}`);
    });

    it('And it does not initialise a backend with no locking (init aborts before writing .terraform)', () => {
      // The failed init above must not have left an initialised working dir
      // behind - a pre-1.10 operator is stopped, not silently set up unlocked.
      assert.ok(!fs.existsSync(path.join(workspace, '.terraform', 'terraform.tfstate')),
        'terraform init wrote backend state despite failing the required_version check');
    });

    it("And the repo's own required_version lets the supported binary through", () => {
      const requiredVersion = unquote(
        parseAssignments(extractTerraformBlock(providerContent)).get('required_version'));
      const { status, output } = initWith(`terraform {\n  required_version = "${requiredVersion}"\n}\n`);
      assert.equal(status, 0,
        `the repo's own required_version ${JSON.stringify(requiredVersion)} blocks the installed binary: ${output}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Scenario: The shared lock table is not deleted by this repo', () => {
    it('Given the lock table is shared upstream, Then this repo declares no lock table resource and only drops its references', () => {
      const code = maskCommentsAndStrings(providerContent);
      assert.ok(!code.includes('dynamodb_table'),
        'provider.tf still references the lock table');
      assert.ok(!/resource\s+"aws_dynamodb_table"\s+"tfstate/.test(providerContent),
        'this repo must never declare, and therefore never destroy, the shared lock table');
    });

    it('And provider.tf records WHY the table is left in place', () => {
      assert.match(providerContent, /DynamoDB lock table/i,
        'provider.tf does not mention the DynamoDB lock table it stopped using');
      assert.match(providerContent, /upstream|shared|other stacks/i,
        'provider.tf does not record that the table is left in place for other stacks');
    });
  });

  // -------------------------------------------------------------------------
  // The three acceptance criteria that need live AWS. These are DOCUMENTATION
  // checks by design - see the file header.
  // -------------------------------------------------------------------------
  describe('Scenario: The criteria that need live AWS are documented, not faked', () => {
    let ticket;

    before(() => {
      ticket = readTicketText();
    });

    it('Given the ticket, Then the migration proof (an empty plan per environment) is recorded as an acceptance criterion', () => {
      assert.match(ticket.text, /Migration proof/i,
        `${ticket.path} no longer records the migration-proof criterion`);
      assert.match(ticket.text, /terraform plan.*(no changes|empty)|empty plan/is,
        `${ticket.path} does not state that the post-init plan must be empty`);
    });

    it('And the state bucket versioning requirement is recorded', () => {
      assert.match(ticket.text, /versioning enabled/i,
        `${ticket.path} no longer records that the state bucket must have versioning enabled`);
      assert.match(ticket.text, /recovery path|recovery from a corrupt write|recover/i,
        `${ticket.path} does not explain WHY versioning matters once the lock table is gone`);
    });

    it('And the deploy identity IAM requirement on the .tflock object is recorded', () => {
      for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) {
        assert.ok(ticket.text.includes(action),
          `${ticket.path} does not require ${action} on the lock object`);
      }
      assert.match(ticket.text, /tflock/i,
        `${ticket.path} does not name the .tflock object the IAM policy must cover`);
    });

    it('And the rollout order and rollback path are documented', () => {
      assert.match(ticket.text, /rollout order/i, `${ticket.path} does not document the rollout order`);
      assert.match(ticket.text, /rollback path/i, `${ticket.path} does not document the rollback path`);
      assert.match(ticket.text, /force-unlock/i,
        `${ticket.path} does not say how to clear a stale lock (terraform force-unlock)`);
    });

    it('And the ticket states the shared lock table is not deleted by this repo', () => {
      assert.match(ticket.text, /not\s+\*{0,2}deleted\*{0,2}|never deletes it|left in place/i,
        `${ticket.path} does not state that the shared lock table is left in place`);
    });
  });
});
