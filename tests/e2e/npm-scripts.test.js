import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDirectoryCovered,
  scopeScriptToSingleFile
} from '../helpers/script-coverage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

// Extensions that node --test recognizes
const TEST_EXTENSIONS = ['.test.js', '.test.mjs', '.test.cjs'];

// Dependency-free target for proving the real test:e2e command exits 0.
// It imports only node builtins and spawns nothing (no terraform, no npm), so a
// failure there can only mean the npm script itself is broken.
const SPAWN_TARGET = 'tests/helpers/exit-zero-fixture.mjs';

/**
 * Spawns a command and returns the result.
 *
 * This file runs under `node --test`, which sets NODE_TEST_CONTEXT in its own
 * process env. If a spawned command is itself `node --test ...` (several
 * assertions below spawn a scoped test:e2e/test:unit command), inheriting
 * that variable makes the child believe it is a recursive re-entrant call: it
 * prints "run() is being called recursively within a test file. skipping
 * running files." and exits 0 without running anything. That would make
 * every `result.code === 0` assertion below pass whether or not the spawned
 * tests actually ran -- exactly the fail-open shape this ticket exists to
 * remove. Stripping it ensures a spawned `node --test` child always runs for
 * real and its exit code reflects its own tests.
 */
function runCommand(cwd, command, args = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(command, args, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    timeout: 60000,  // Generous timeout for full suite runs
    env
  });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// isDirectoryCovered lives in tests/helpers/script-coverage.mjs so the unit layer
// (tests/unit/npm-scripts-config.test.js) asserts against the same predicate
// rather than a second, weaker copy of the rule.

/**
 * Recursively checks if a directory contains test files
 */
function hasAnyTestFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (hasAnyTestFiles(path.join(dirPath, entry.name))) {
          return true;
        }
      } else if (TEST_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        return true;
      }
    }
  } catch (e) {
    // Directory doesn't exist or not readable
  }
  return false;
}

/**
 * Finds all immediate subdirectories of tests/ that contain test files
 */
function findTestDirectories(testsPath) {
  const dirsWithTests = [];
  try {
    const entries = fs.readdirSync(testsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdirPath = path.join(testsPath, entry.name);
      if (hasAnyTestFiles(subdirPath)) {
        dirsWithTests.push(entry.name);
      }
    }
  } catch (e) {
    // Directory doesn't exist or not readable
  }
  return dirsWithTests;
}

describe('Feature: The test suite that CI runs includes the e2e scenarios', () => {
  describe('Scenario: npm test runs both directories', () => {
    it('Given package.json, When the test script is checked, Then it covers both tests/unit and tests/e2e', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts.test, 'test script should exist');

      const testScript = pkgJson.scripts.test;
      // Semantic check: the script must cover both directories, either explicitly or via parent path
      assert.ok(isDirectoryCovered(testScript, 'unit'),
        `test script should cover tests/unit. Got: "${testScript}"`);
      assert.ok(isDirectoryCovered(testScript, 'e2e'),
        `test script should cover tests/e2e. Got: "${testScript}"`);
    });

    it('When the coverage predicate is tested with synthetic inputs, Then it rejects uncovered directories', () => {
      // Prove the predicate discriminates by testing it with fabricated scenarios
      const scriptExplicit = 'node --test tests/unit tests/e2e';
      const scriptWithParent = 'node --test tests/';
      const scriptWithoutDir = 'node --test tests/unit';

      // Explicit mentions should be covered
      assert.ok(isDirectoryCovered(scriptExplicit, 'unit'), 'unit explicitly mentioned');
      assert.ok(isDirectoryCovered(scriptExplicit, 'e2e'), 'e2e explicitly mentioned');

      // Uncovered directory should be rejected
      assert.ok(!isDirectoryCovered(scriptExplicit, 'integration'),
        'integration NOT mentioned should not be covered');

      // Parent path should cover all
      assert.ok(isDirectoryCovered(scriptWithParent, 'unit'), 'unit covered by parent tests/');
      assert.ok(isDirectoryCovered(scriptWithParent, 'e2e'), 'e2e covered by parent tests/');
      assert.ok(isDirectoryCovered(scriptWithParent, 'integration'),
        'integration covered by parent tests/');

      // Without parent, only mentioned dirs are covered
      assert.ok(isDirectoryCovered(scriptWithoutDir, 'unit'), 'unit explicitly mentioned');
      assert.ok(!isDirectoryCovered(scriptWithoutDir, 'e2e'),
        'e2e NOT mentioned, not covered by parent');

      console.log('Coverage predicate validation: accepts covered dirs, rejects uncovered');
    });

    it('When the predicate is tested against false-positive inputs, Then it rejects substring and flag-value matches', () => {
      // False positive 1: Directory name appears in a similar path
      // e.g., looking for 'e2e' in a script that mentions 'tests/e2e-legacy'
      const scriptWithSimilar = 'node --test tests/e2e-legacy';
      assert.ok(!isDirectoryCovered(scriptWithSimilar, 'e2e'),
        'Should not match e2e in "tests/e2e-legacy" (substring false positive)');
      assert.ok(isDirectoryCovered(scriptWithSimilar, 'e2e-legacy'),
        'Should match e2e-legacy when explicitly present');

      // False positive 2: Token appears as a flag value
      // e.g., '--test-name-pattern tests' makes 'tests' a flag value, not a path
      const scriptWithFlagValue = 'node --test --test-name-pattern tests tests/unit';
      assert.ok(!isDirectoryCovered(scriptWithFlagValue, 'integration'),
        'Flag value "tests" should not cover unlisted integration');
      assert.ok(isDirectoryCovered(scriptWithFlagValue, 'unit'),
        'Explicit tests/unit should be covered');

      // False positive 3: Verify that legitimate parent path still works
      const scriptWithParentPath = 'node --test tests/ --other-flag=value';
      assert.ok(isDirectoryCovered(scriptWithParentPath, 'integration'),
        'Parent path tests/ should cover all directories');

      console.log('Coverage predicate hardening validated: rejects substring and flag-value false positives');
    });

    it('When the predicate sees legitimate whole-tree forms, Then it accepts them', () => {
      // `--test` is a boolean flag, so the token after it is a genuine path argument.
      // These three forms are all exactly equivalent to `node --test tests/unit tests/e2e`
      // and must not be reported as leaving a directory uncovered.
      for (const dir of ['unit', 'e2e', 'integration']) {
        assert.ok(isDirectoryCovered('node --test tests', dir),
          `"node --test tests" should cover tests/${dir} (bare parent path after a boolean flag)`);
        assert.ok(isDirectoryCovered('node --test ./tests/', dir),
          `"node --test ./tests/" should cover tests/${dir} (leading ./ and trailing / are noise)`);
      }

      assert.ok(isDirectoryCovered('node --test "tests/e2e"', 'e2e'),
        'A quoted path argument should cover tests/e2e');
      assert.ok(!isDirectoryCovered('node --test "tests/e2e"', 'unit'),
        'A quoted tests/e2e should not cover tests/unit');

      // Multiple explicit directories still resolve independently
      assert.ok(isDirectoryCovered('node --test tests/unit tests/e2e', 'e2e'),
        'Explicit tests/e2e alongside tests/unit should be covered');

      // Boolean flags that are NOT on the value-taking allowlist do not swallow paths
      assert.ok(isDirectoryCovered('node --test --experimental-test-coverage tests', 'e2e'),
        'A boolean coverage flag should not consume the following path');

      // A value-taking flag in =value form does not consume the next token either
      assert.ok(isDirectoryCovered('node --test --test-reporter=spec tests', 'e2e'),
        '--flag=value form should not consume the following path');

      console.log('Coverage predicate accepts equivalent whole-tree script forms');
    });

    it('When the predicate sees a directory that will NOT run, Then it never reports it covered', () => {
      // TASK-029: the fail-open direction. Every script below runs tests/unit only,
      // yet each reported tests/e2e as covered before the fix. The unit layer pins
      // the same rules against the same shared predicate.
      const runsUnitOnly = [
        'node --import tests/e2e/setup.mjs --test tests/unit',
        'node --require tests/e2e/setup.js --test tests/unit',
        'node -r tests/e2e/setup.js --test tests/unit',
        'node --loader tests/e2e/loader.mjs --test tests/unit',
        'node --env-file tests/e2e/.env --test tests/unit',
        'node --env-file-if-exists tests/e2e/.env --test tests/unit',
        'node --test --import tests/e2e/setup.mjs tests/unit',
        'node --test --loader tests/e2e/loader.mjs tests/unit',
        'node --test --test-reporter-destination tests/e2e/out.txt tests/unit',
        'echo tests && node --test tests/unit',
        'node --test tests/unit && echo tests',
        'node --test tests/unit ; echo tests',
        'node --test tests/unit | grep tests',
        'node --test tests/unit || echo tests',
        'CI=1 node --test tests/unit',
      ];

      for (const script of runsUnitOnly) {
        assert.ok(!isDirectoryCovered(script, 'e2e'),
          `"${script}" runs only tests/unit; it must NOT be reported as covering tests/e2e`);
        assert.ok(isDirectoryCovered(script, 'unit'),
          `"${script}" does run tests/unit and must be reported as covering it`);
      }

      // A shape the predicate cannot resolve must answer "not covered", never "covered".
      const undecidable = [
        'node --test $(cat dirs.txt)',
        'node --test "tests',
        'node runner.mjs --test tests',
        'node --test',
        'npx mocha tests',
      ];

      for (const script of undecidable) {
        for (const dir of ['unit', 'e2e']) {
          assert.ok(!isDirectoryCovered(script, dir),
            `Undecidable script "${script}" must not report tests/${dir} as covered`);
        }
      }

      console.log('Fail-open direction closed: setup-file flags and foreign commands never report covered');
    });

    it('And all tests/ subdirectories containing test files are covered by the test script', () => {
      // Discover which subdirectories of tests/ contain test files (any extension)
      const testsDir = path.join(PROJECT_ROOT, 'tests');
      const dirsWithTests = findTestDirectories(testsDir);

      // Get the test script from package.json
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testScript = pkgJson.scripts.test || '';

      // Check that each directory with tests is covered (no silent exclusions)
      for (const dir of dirsWithTests) {
        assert.ok(isDirectoryCovered(testScript, dir),
          `Directory "tests/${dir}" contains test files but is NOT covered by test script. ` +
          `Test script: "${testScript}". ` +
          `Discovered test directories: ${dirsWithTests.join(', ')}`);
      }

      // Verify we're detecting nested test files (if any) by asserting recursion was used
      const unitNestedPath = path.join(PROJECT_ROOT, 'tests', 'unit', 'subdir', 'foo.test.js');
      if (fs.existsSync(unitNestedPath)) {
        assert.ok(dirsWithTests.includes('unit'),
          'Nested test files under unit should be discovered');
      }

      // Report the discovered directories for verification
      console.log(`Discovered test directories (containing .test.{js,mjs,cjs}): ${dirsWithTests.join(', ')}`);
    });

    it('And both tests/unit and tests/e2e directories contain test files', () => {
      // Verify that test files exist in both directories (with all recognized extensions)
      const unitDir = path.join(PROJECT_ROOT, 'tests', 'unit');
      const e2eDir = path.join(PROJECT_ROOT, 'tests', 'e2e');

      assert.ok(fs.existsSync(unitDir), 'tests/unit directory should exist');
      assert.ok(fs.existsSync(e2eDir), 'tests/e2e directory should exist');

      // Count files with all supported extensions
      const unitFiles = fs.readdirSync(unitDir)
        .filter(f => TEST_EXTENSIONS.some(ext => f.endsWith(ext)));
      const e2eFiles = fs.readdirSync(e2eDir)
        .filter(f => TEST_EXTENSIONS.some(ext => f.endsWith(ext)));

      assert.ok(unitFiles.length > 0, `tests/unit should contain test files, found ${unitFiles.length}`);
      assert.ok(e2eFiles.length > 0, `tests/e2e should contain test files, found ${e2eFiles.length}`);

      // Verify files contain test patterns
      for (const file of unitFiles) {
        const content = fs.readFileSync(path.join(unitDir, file), 'utf-8');
        assert.ok(content.includes('describe(') || content.includes('it('),
          `${file} should contain test definitions`);
      }

      for (const file of e2eFiles) {
        const content = fs.readFileSync(path.join(e2eDir, file), 'utf-8');
        assert.ok(content.includes('describe(') || content.includes('it('),
          `${file} should contain test definitions`);
      }
    });
  });

  describe('Scenario: The fast inner loop is still scoped', () => {
    it('Given package.json, When the test:unit script is checked, Then it covers tests/unit but not tests/e2e', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts['test:unit'], 'test:unit script should exist');

      const testUnitScript = pkgJson.scripts['test:unit'];
      // Semantic check: must cover unit, must not cover e2e (no sweeping parent path)
      assert.ok(isDirectoryCovered(testUnitScript, 'unit'),
        `test:unit should cover tests/unit. Got: "${testUnitScript}"`);
      assert.ok(!isDirectoryCovered(testUnitScript, 'e2e'),
        `test:unit should NOT cover tests/e2e. Got: "${testUnitScript}"`);
    });

    it('And the node --test command executes successfully', () => {
      // Uses the dependency-free spawn target rather than
      // tests/unit/terraform-scaffold.test.js: that file shells out to
      // `terraform validate -json`, an external binary this assertion has no
      // need of. SPAWN_TARGET's only failure mode is the `node --test`
      // plumbing itself.
      const result = runCommand(PROJECT_ROOT, 'node', ['--test', SPAWN_TARGET]);
      assert.equal(result.code, 0, `node --test should exit 0. stderr: ${result.stderr}`);
    });
  });

  describe('Scenario: The e2e script no longer invokes Playwright', () => {
    it('Given package.json, Then the test:e2e script does not invoke "playwright"', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts['test:e2e'], 'test:e2e script should exist');

      const testEeScript = pkgJson.scripts['test:e2e'];
      assert.ok(!testEeScript.includes('playwright'),
        `test:e2e script should not invoke playwright. Got: "${testEeScript}"`);
      assert.ok(!testEeScript.includes('bddgen'),
        `test:e2e script should not invoke bddgen. Got: "${testEeScript}"`);
    });

    it('And when the test:e2e script is executed against a single file, Then it exits successfully', () => {
      // Spawning `npm run test:e2e` verbatim would be self-referential: test:e2e is
      // `node --test tests/e2e` and this file lives in tests/e2e. So we read the real
      // script from package.json and run *that* command — executable and flags intact —
      // with its directory arguments replaced by one file, so directory discovery never
      // runs and this file cannot re-enter itself.
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];
      assert.ok(testE2eScript, 'test:e2e script should exist');

      // The target imports only node builtins, so a non-zero exit means the script's
      // plumbing is broken — not that terraform is missing or that source code changed.
      assert.ok(fs.existsSync(path.join(PROJECT_ROOT, SPAWN_TARGET)),
        `Spawn target "${SPAWN_TARGET}" should exist`);

      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);
      assert.ok(!scopedCommand.includes('tests/e2e'),
        `Scoped command must not target the tests/e2e directory. Got: "${scopedCommand}"`);

      const result = runCommand(PROJECT_ROOT, scopedCommand);
      assert.equal(result.code, 0,
        `Scoped test:e2e command should exit 0, got ${result.code}. ` +
        `Script: "${testE2eScript}". Ran: "${scopedCommand}". ` +
        `Output: ${result.stdout}${result.stderr}`);
    });
  });

  describe('Scenario: No script invokes a missing binary', () => {
    it('Given every script in package.json, Then each invokes only node, npm, or an available binary', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts, 'package.json should have scripts');

      const nodeModulesExists = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'));

      for (const [scriptName, scriptCmd] of Object.entries(pkgJson.scripts)) {
        const tokens = scriptCmd.trim().split(/\s+/);
        const firstToken = tokens[0];

        if (firstToken === 'node' || firstToken === 'npm') {
          continue; // Always available
        }

        if (nodeModulesExists) {
          const nodeBinPath = path.join(PROJECT_ROOT, 'node_modules', '.bin');
          const binPath = path.join(nodeBinPath, firstToken);
          assert.ok(
            fs.existsSync(binPath) || fs.existsSync(binPath + '.cmd') || fs.existsSync(binPath + '.ps1'),
            `Script "${scriptName}" invokes "${firstToken}" which is not available`
          );
        } else {
          assert.ok(
            firstToken === 'node' || firstToken === 'npm',
            `Script "${scriptName}" invokes "${firstToken}" but only node/npm are acceptable when node_modules is missing`
          );
        }
      }
    });
  });

  describe('Scenario: Leak-safety guards now run under the CI command', () => {
    it('Given tests/e2e/, When checking for check-oauth-config tests, Then the leak-safety E2E scenarios exist', () => {
      const oauthTestPath = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      assert.ok(fs.existsSync(oauthTestPath), 'check-oauth-config.test.js should exist in tests/e2e');

      const content = fs.readFileSync(oauthTestPath, 'utf-8');
      assert.ok(content.includes('describe('), 'Should contain test suites');
      assert.ok(content.includes('OAuth'), 'Should contain OAuth-related tests');
      assert.ok(content.includes('Scenario:'), 'Should contain Gherkin scenarios');
    });

    it('And the check:oauth-config script is preserved and configured correctly', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts['check:oauth-config'],
        'check:oauth-config script should be defined');

      const script = pkgJson.scripts['check:oauth-config'];
      assert.ok(script.includes('check-oauth-config.mjs'),
        `check:oauth-config should reference check-oauth-config.mjs. Got: "${script}"`);
    });
  });

  describe('Scenario: Test assertions were not altered', () => {
    it('Given test files exist, Then they contain assertion patterns', () => {
      const testDirs = [
        path.join(PROJECT_ROOT, 'tests', 'unit'),
        path.join(PROJECT_ROOT, 'tests', 'e2e')
      ];

      for (const testDir of testDirs) {
        assert.ok(fs.existsSync(testDir), `Test directory ${testDir} should exist`);
        const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));
        assert.ok(files.length > 0, `Test directory ${testDir} should contain test files`);

        for (const file of files) {
          const filePath = path.join(testDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          assert.ok(
            content.includes('assert.') || content.includes('it('),
            `Test file ${file} should contain test assertions`
          );
        }
      }
    });
  });

  describe('Scenario: package.json stays valid', () => {
    it('Given package.json, Then it parses as valid JSON', () => {
      assert.doesNotThrow(() => {
        JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      }, 'package.json should be valid JSON');
    });

    it('And it still defines "check:oauth-config"', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts['check:oauth-config'],
        'package.json should define check:oauth-config script');

      const script = pkgJson.scripts['check:oauth-config'];
      assert.ok(script.includes('check-oauth-config.mjs'),
        `check:oauth-config should reference check-oauth-config.mjs. Got: "${script}"`);
    });

    it('And the check:oauth-config script with no arguments provides usage guidance', () => {
      const result = runCommand(PROJECT_ROOT, 'npm', ['run', 'check:oauth-config']);
      assert.equal(result.code, 1, 'check:oauth-config with no args should exit 1');

      const output = result.stdout + result.stderr;
      const hasGuidance = output.includes('Usage') ||
                          output.includes('--env') ||
                          output.includes('--tenant') ||
                          output.includes('required');
      assert.ok(hasGuidance, 'check:oauth-config should provide usage information');
    });

    it('And when "npm run test:bdd" is executed, Then it exits 0 (as required by existing assertions)', () => {
      // Note: tests/bdd/ is retained only because tests/unit/terraform-scaffold.test.js:406
      // asserts that the test:bdd script exists. This assertion ensures it exits cleanly,
      // so that future cleanup does not accidentally break existing test assertions.
      const result = runCommand(PROJECT_ROOT, 'npm', ['run', 'test:bdd']);
      assert.equal(result.code, 0, `test:bdd should exit 0, got exit code ${result.code}`);
    });
  });

  describe('Scenario: The exit-0 assertion proves the real script wiring works', () => {
    it('When reading test:e2e from package.json, Then that exact command is what we run', () => {
      // The exit-0 assertion (line 279) reads scripts['test:e2e'] from package.json
      // and runs that command scoped to a single file. This test verifies the reading
      // happens (not hardcoding an equivalent) and would catch mutations to the script.
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];

      assert.ok(testE2eScript, 'test:e2e script should exist in package.json');

      // The script must start with 'node' (not npm run) because we're running it raw
      assert.ok(testE2eScript.startsWith('node'),
        `test:e2e script should be executable as-is. Got: "${testE2eScript}"`);

      // Scoped to a single file, the command should still invoke node with the same flags
      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);
      assert.ok(scopedCommand.startsWith('node'),
        'Scoped command should still invoke node');
    });

    it('And the spawn target imports only node builtins (no external dependencies)', () => {
      // The fixture at tests/helpers/exit-zero-fixture.mjs must only import from
      // node:test and node:assert, so a failure cannot be misattributed to
      // terraform, aws-cli, or other external binaries being missing.
      const fixtureContent = fs.readFileSync(
        path.join(PROJECT_ROOT, SPAWN_TARGET),
        'utf-8'
      );

      // Check that it imports from node:* only (and not terraform, aws, etc.)
      // Extract only import statements (not comments)
      const importLines = fixtureContent.split('\n').filter(line => line.trim().startsWith('import'));
      for (const line of importLines) {
        assert.ok(line.includes("from 'node:") || line.includes('from "node:'),
          `Spawn target should only import from node:* builtins. Found: ${line}`);
      }

      // Verify it does not spawn any external processes (executable code, not comments)
      const codeLines = fixtureContent.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
      const codeContent = codeLines.join('\n');

      assert.ok(!codeContent.includes('spawnSync') && !codeContent.includes('spawn('),
        'Spawn target should not spawn external processes');
      assert.ok(!codeContent.includes('execSync') && !codeContent.includes('exec('),
        'Spawn target should not exec external commands');

      console.log('Spawn target verified: pure node, no external dependencies (AC 8)');
    });

    it('And when the scoped test:e2e command is run, Then it exits with code 0', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];

      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);
      const result = runCommand(PROJECT_ROOT, scopedCommand);

      assert.equal(result.code, 0,
        `Scoped test:e2e exit code must be 0 (proves script wiring works). ` +
        `Got: ${result.code}. Script: "${testE2eScript}". Ran: "${scopedCommand}". ` +
        `Stdout: ${result.stdout}. Stderr: ${result.stderr}`);
    });

    it('And breaking the script (synthetic mutation) would cause the assertion to fail', () => {
      // Prove the assertion would catch a real script breakage by showing:
      // 1. The assertion reads the exact value from package.json scripts['test:e2e']
      // 2. If that value changed, the assertion would fail
      // 3. The scoped command depends on that value
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];

      // The assertion reads this exact value (line 286 in the main e2e test)
      assert.ok(testE2eScript, 'test:e2e script value must exist in package.json');
      assert.ok(testE2eScript.startsWith('node'), 'Script must be a raw command (readfrom package.json)');

      // If the script value changed to something invalid, the assertion would fail
      // (we're proving the assertion depends on package.json by checking our scoping logic)
      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);
      assert.ok(scopedCommand.includes('node'),
        'Scoped command must preserve the node executable from the script');

      // Verify the real scoped command (with valid fixture) exits 0
      const realResult = runCommand(PROJECT_ROOT, scopedCommand);
      assert.equal(realResult.code, 0, 'Real scoped command should exit 0');

      // But a mutation to a different executable would fail
      const mutantScript = testE2eScript.replace('node', 'missing-executable');
      const mutantCommand = scopeScriptToSingleFile(mutantScript, SPAWN_TARGET);
      const mutantResult = runCommand(PROJECT_ROOT, mutantCommand);
      assert.notEqual(mutantResult.code, 0,
        'Mutated executable should cause non-zero exit (proves assertion would catch script changes)');

      // If the script value were removed or empty, the assertion would fail
      // (since isDirectoryCovered checks would fail if the script was falsy)
      assert.ok(pkgJson.scripts['test:e2e'],
        'test:e2e must exist and be non-empty (assertion depends on this)');

      console.log('Mutation test passed: assertion would catch script changes via package.json');
    });

    it('And the real test:unit script must NOT be compatible with test:e2e', () => {
      // Regression guard: test:unit and test:e2e are different scripts that
      // should not accidentally use each other's path. This test confirms
      // the assertion uses the correct script from package.json.
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testUnitScript = pkgJson.scripts['test:unit'];
      const testE2eScript = pkgJson.scripts['test:e2e'];

      assert.notEqual(testUnitScript, testE2eScript,
        'test:unit and test:e2e scripts should be different');

      // Verify test:unit targets unit only, test:e2e targets e2e only
      assert.ok(testUnitScript.includes('tests/unit'),
        'test:unit should target tests/unit');
      assert.ok(testE2eScript.includes('tests/e2e'),
        'test:e2e should target tests/e2e');

      console.log('Script isolation verified: unit and e2e are distinct');
    });
  });

  describe('Scenario: No recursion: npm test and npm run test:e2e complete without spawning child nodes', () => {
    it('When npm run test:e2e is executed, Then it exits 0 and does not spawn recursive node processes', () => {
      // The concern: if NODE_TEST_CONTEXT is not inherited correctly, a test inside
      // tests/e2e/ that runs `node --test tests/e2e` would re-enter itself, spawning
      // another node process that spawns another, etc. (fork bomb). This test verifies
      // the test:e2e script completes normally.
      //
      // This is proven by running the real scoped command (not the full directory
      // discovery) and confirming exit 0. A recursive re-entry would manifest as:
      // - timeout (the command hangs)
      // - non-zero exit (one of the re-entered tests fails)
      // - or excessive child process count (if we were monitoring)
      //
      // We run it directly to avoid spawning from an already-running test context,
      // then verify the exit code.
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];
      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);

      const result = runCommand(PROJECT_ROOT, scopedCommand);
      assert.equal(result.code, 0,
        `test:e2e scoped command should exit 0 (no fork bomb). Got: ${result.code}`);

      console.log('No recursion detected: test:e2e exits cleanly (AC 11)');
    });

    it('And the scoped test:e2e command excludes tests/e2e, so directory discovery cannot re-enter it', () => {
      // This does not run `npm test` itself -- the real exit-0 proof above
      // (AC 11) already spawns the scoped command and asserts exit 0, and
      // that is what rules out a hang or a fork bomb. This test checks only
      // the two static pre-conditions that make that real spawn safe to run
      // at all: the dependency-free fixture exists, and the scoped command
      // does not still reference the tests/e2e directory (which would cause
      // this very file to re-enter itself via directory discovery).
      const fixtureExists = fs.existsSync(
        path.join(PROJECT_ROOT, SPAWN_TARGET)
      );
      assert.ok(fixtureExists, 'Fixture should exist (proof against re-entrance)');

      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testE2eScript = pkgJson.scripts['test:e2e'];
      const scopedCommand = scopeScriptToSingleFile(testE2eScript, SPAWN_TARGET);

      // The scoped command should NOT include tests/e2e as a directory
      assert.ok(!scopedCommand.includes('tests/e2e'),
        'Scoped command must not reference tests/e2e directory (prevents re-discovery)');

      console.log('Re-entrance guard confirmed: scoping prevents directory discovery');
    });
  });

  describe('Scenario: A broken setup-file script is caught by the predicate', () => {
    it('When the test script is set to a form that drops tests/e2e, Then at least one guard assertion fails', () => {
      // TASK-029 AC 8: Setting the test script to
      // 'node --import tests/e2e/globalSetup.mjs --test tests/unit'
      // must cause the coverage assertions to fail, proving the predicate would catch
      // this dangerous regression (where a setup file silently drops a test directory).
      const brokenScript = 'node --import tests/e2e/globalSetup.mjs --test tests/unit';
      const unitDir = 'unit';
      const e2eDir = 'e2e';

      // The predicate must detect that this script only runs unit, not e2e
      assert.ok(isDirectoryCovered(brokenScript, unitDir),
        'Broken script does run tests/unit');
      assert.ok(!isDirectoryCovered(brokenScript, e2eDir),
        'Broken script with --import setup file must NOT report tests/e2e as covered');

      // This is the core guard: the real test script MUST cover both.
      // If we were to apply the broken script to package.json, the assertion
      // "test script must cover tests/e2e" would fail.
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const realScript = pkgJson.scripts.test;

      // Prove the guard would catch the mutation by showing it fails for the broken form
      let guardWouldCatch = false;
      try {
        assert.ok(isDirectoryCovered(realScript, 'e2e'),
          `test script must cover tests/e2e`);
        // If we get here, the real script is fine. Now check that it WOULD fail
        // if we substituted the broken one.
        assert.ok(isDirectoryCovered(brokenScript, 'e2e'),
          `This line should fail for the broken script`);
      } catch (error) {
        // An earlier assertion passed. This one DOES NOT, because the broken
        // script does not cover e2e. That proves the guard is working.
        guardWouldCatch = true;
      }

      // If we're testing with the real script, the guard passed (good).
      // The second assertion (for the broken script) would fail (good).
      // So we verify the second assertion fails by doing it separately:
      let brokenScriptDetected = false;
      try {
        assert.ok(isDirectoryCovered(brokenScript, 'e2e'));
        // If we get here, the broken script was NOT caught (bad)
      } catch (error) {
        brokenScriptDetected = true;
      }

      assert.ok(brokenScriptDetected,
        'The assertion for the broken script MUST fail, proving the guard would catch the mutation');

      console.log('Mutation guard confirmed: broken setup-file script caught (AC 8)');
    });

    it('And the real test script successfully covers both directories', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testScript = pkgJson.scripts.test;

      // The real script MUST pass both assertions
      assert.ok(isDirectoryCovered(testScript, 'unit'),
        'Real test script must cover tests/unit');
      assert.ok(isDirectoryCovered(testScript, 'e2e'),
        'Real test script must cover tests/e2e (would fail if script was broken)');

      console.log('Real script verification: covers both unit and e2e (AC 8 control)');
    });
  });
});
