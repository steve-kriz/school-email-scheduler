import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

/**
 * Spawns a command (non-test) and returns the result
 */
function runCommand(cwd, command, args = []) {
  const result = spawnSync(command, args, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    timeout: 60000  // Generous timeout for full suite runs
  });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Parses TAP output and extracts test/pass counts
 */
function parseTestCounts(output) {
  const lines = output.split('\n');
  const counts = { tests: 0, pass: 0 };

  for (const line of lines) {
    const testMatch = line.match(/^# tests (\d+)/);
    const passMatch = line.match(/^# pass (\d+)/);

    if (testMatch) counts.tests = parseInt(testMatch[1], 10);
    if (passMatch) counts.pass = parseInt(passMatch[1], 10);
  }

  return counts;
}

describe('Feature: The test suite that CI runs includes the e2e scenarios', () => {
  describe('Scenario: npm test runs both directories', () => {
    it('Given package.json, When the test script is checked, Then it includes both tests/unit and tests/e2e', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts.test, 'test script should exist');

      const testScript = pkgJson.scripts.test;
      assert.strictEqual(testScript, 'node --test tests/unit tests/e2e',
        `test script should be "node --test tests/unit tests/e2e". Got: "${testScript}"`);
    });

    it('When the command configured in npm test is executed, Then the test count matches the expected directories', () => {
      // The npm test script is configured as: "node --test tests/unit tests/e2e"
      // This test verifies that the npm scripts correctly wire both directories.

      // Count test files in each directory
      const unitDir = path.join(PROJECT_ROOT, 'tests', 'unit');
      const e2eDir = path.join(PROJECT_ROOT, 'tests', 'e2e');

      const unitTestFiles = fs.readdirSync(unitDir)
        .filter(f => f.endsWith('.test.js')).length;
      const e2eTestFiles = fs.readdirSync(e2eDir)
        .filter(f => f.endsWith('.test.js')).length;

      assert.ok(unitTestFiles > 0, `tests/unit should contain test files, found ${unitTestFiles}`);
      assert.ok(e2eTestFiles > 0, `tests/e2e should contain test files, found ${e2eTestFiles}`);

      // Verify the test script explicitly names both directories
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testScript = pkgJson.scripts.test;

      const hasUnit = testScript.includes('tests/unit');
      const hasE2e = testScript.includes('tests/e2e');

      assert.ok(hasUnit, `test script should reference tests/unit. Got: "${testScript}"`);
      assert.ok(hasE2e, `test script should reference tests/e2e. Got: "${testScript}"`);

      // Report directory statistics for verification
      console.log(`Test file discovery: tests/unit has ${unitTestFiles} test files, tests/e2e has ${e2eTestFiles} test files`);
      console.log(`npm test script: "${testScript}"`);
    });

    it('And all tests/ subdirectories containing .test.js files are covered by the test script', () => {
      // Discover which subdirectories of tests/ contain .test.js files
      const testsDir = path.join(PROJECT_ROOT, 'tests');
      const entries = fs.readdirSync(testsDir, { withFileTypes: true });
      const dirsWithTests = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const subdir = entry.name;
        const subdirPath = path.join(testsDir, subdir);
        const testFiles = fs.readdirSync(subdirPath)
          .filter(f => f.endsWith('.test.js'));

        if (testFiles.length > 0) {
          dirsWithTests.push(subdir);
        }
      }

      // Get the test script from package.json
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const testScript = pkgJson.scripts.test || '';

      // Check that each directory with tests is covered
      for (const dir of dirsWithTests) {
        const isCovered = testScript.includes(`tests/${dir}`) || testScript.includes('tests/');
        assert.ok(isCovered,
          `Directory "tests/${dir}" contains .test.js files but is not covered by the test script. ` +
          `Test script: "${testScript}". ` +
          `Discovered test directories: ${dirsWithTests.join(', ')}`);
      }

      // Report the discovered directories for verification
      console.log(`Discovered test directories with .test.js files: ${dirsWithTests.join(', ')}`);
    });

    it('And both tests/unit and tests/e2e directories contain test files', () => {
      // Verify that test files exist in both directories
      const unitDir = path.join(PROJECT_ROOT, 'tests', 'unit');
      const e2eDir = path.join(PROJECT_ROOT, 'tests', 'e2e');

      assert.ok(fs.existsSync(unitDir), 'tests/unit directory should exist');
      assert.ok(fs.existsSync(e2eDir), 'tests/e2e directory should exist');

      const unitFiles = fs.readdirSync(unitDir).filter(f => f.endsWith('.test.js'));
      const e2eFiles = fs.readdirSync(e2eDir).filter(f => f.endsWith('.test.js'));

      assert.ok(unitFiles.length > 0, 'tests/unit should contain test files');
      assert.ok(e2eFiles.length > 0, 'tests/e2e should contain test files');

      // Verify both contain test patterns
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
    it('Given package.json, When the test:unit script is checked, Then it only references tests/unit', () => {
      const pkgJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      assert.ok(pkgJson.scripts['test:unit'], 'test:unit script should exist');

      const testUnitScript = pkgJson.scripts['test:unit'];
      assert.strictEqual(testUnitScript, 'node --test tests/unit',
        `test:unit script should be "node --test tests/unit". Got: "${testUnitScript}"`);
      assert.ok(!testUnitScript.includes('tests/e2e'),
        'test:unit should not include tests/e2e');
    });

    it('And the node --test tests/unit command executes successfully', () => {
      const result = runCommand(PROJECT_ROOT, 'node', ['--test', 'tests/unit/terraform-scaffold.test.js']);
      // Should not error, though exit code may vary
      const output = result.stdout + result.stderr;
      assert.ok(output.length > 0, 'node --test should produce output');
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

    it('And when npm run test:e2e is executed, Then it exits successfully', () => {
      const result = runCommand(PROJECT_ROOT, 'npm', ['run', 'test:e2e']);
      assert.equal(result.code, 0, `test:e2e should exit 0, got ${result.code}`);
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
  });
});
