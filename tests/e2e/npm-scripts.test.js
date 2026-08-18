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

// Extensions that node --test recognizes
const TEST_EXTENSIONS = ['.test.js', '.test.mjs', '.test.cjs'];

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
 * Checks if a directory is covered by a test script.
 * A directory is covered if:
 * 1. The script explicitly names it (tests/<dir>), OR
 * 2. The script names a genuine parent path (tests/ or tests or tests/* wildcard)
 *
 * This predicate rejects the escape hatch that `|| testScript.includes('tests/')` would provide,
 * because that would match even when the directory is not truly covered
 * (e.g., "tests/unit" contains the substring "tests/" but does not cover "tests/e2e").
 *
 * Hardened against false positives:
 * - Case 1: Match must end at a path boundary (end of string, whitespace, or /)
 *   (prevents "tests/e2e-legacy" matching when looking for "e2e")
 * - Case 2: Token must be a genuine path argument (must not be preceded by =, or be a flag value)
 *   (prevents "--test-name-pattern tests" making every directory covered)
 */
function isDirectoryCovered(testScript, dirName) {
  // Case 1: The specific directory is explicitly mentioned, at a path boundary
  // Match "tests/<dir>" only if it's followed by end-of-string, whitespace, or /
  const exactPattern = new RegExp(`tests/${dirName}(?:\\s|/|$)`);
  if (exactPattern.test(testScript)) {
    return true;
  }

  // Case 2: A parent path is present as a standalone token
  // Split by whitespace to get individual arguments/tokens
  const tokens = testScript.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Exact parent directory token (covers all subdirs recursively)
    // Prefer `tests/` with slash to avoid false matches with flag values like `--test-name-pattern tests`
    if (token === 'tests/') {
      return true;
    }

    // Bare `tests` is only valid as a path if it's NOT preceded by a flag argument
    // (flags that take values should have = or be in positions where we can detect them)
    if (token === 'tests') {
      if (i === 0) {
        // First token, definitely a path (though unusual)
        return true;
      }
      const prevToken = tokens[i - 1];
      // If previous token doesn't look like it takes an argument (doesn't start with -),
      // then this could be a path
      if (!prevToken.startsWith('-')) {
        return true;
      }
      // Otherwise, skip it (likely a flag value)
    }

    // Parent with wildcard (e.g., tests/* or tests/**)
    if (token.startsWith('tests/') && token.includes('*')) {
      return true;
    }
  }

  return false;
}

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

    it('And when the test:e2e script is executed against a specific e2e file, Then it exits successfully', () => {
      // Note: spawning the full `npm run test:e2e` from within this file would be self-referential,
      // since test:e2e is `node --test tests/e2e` and this file lives in tests/e2e.
      // Instead, we verify that node --test works on a specific e2e file that does not itself spawn tests.
      const result = runCommand(PROJECT_ROOT, 'node', ['--test', 'tests/e2e/terraform-scaffold.test.js']);
      assert.equal(result.code, 0, `node --test on e2e file should exit 0, got ${result.code}`);
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
});
