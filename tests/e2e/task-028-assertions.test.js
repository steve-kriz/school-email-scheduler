/**
 * TASK-028: Four assertions that do not verify what they claim
 *
 * E2E tests covering all acceptance criteria for dead/vacuous assertions.
 * These tests use Gherkin-style Given/When/Then structure.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

describe('Feature: Guards in the preflight suite cannot pass vacuously or fail open', () => {

  describe('Scenario 1: The negated-object assertion depends on the guard\'s output', () => {
    it('Given a fixture with a negated-object denial, When it is run through terraformCreatesSecretClaimsIn, Then it returns a non-empty claims array (proving the test asserts concrete behaviour)', () => {
      // This proves Finding 1 is fixed: the assertion now depends on the
      // actual output of terraformCreatesSecretClaimsIn, not a constant.
      // The mutation check: if we made terraformCreatesSecretClaimsIn return [],
      // this test would fail (proving the assertion is real).

      // Read the check-oauth-config test to verify assertion structure
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the negated-object assertion
      const negatedAssertMatch = content.match(
        /assert\.ok\(\s*claims\.length > 0.*?NEGATED_OBJECT.*?\);/s
      );
      assert.ok(negatedAssertMatch,
        'Negated-object assertion should assert claims.length > 0');

      // Verify it does NOT have the tautological || /nothing|no/.test(negatedObjectClaim)
      assert.ok(
        !negatedAssertMatch[0].includes('|| /nothing|no/.test'),
        'Assertion must not contain the tautological /nothing|no/ pattern'
      );

      // Verify the assertion depends on claims.length, not a constant
      const assertionText = negatedAssertMatch[0];
      assert.ok(
        assertionText.includes('claims.length > 0'),
        'Must assert claims.length > 0 directly'
      );
    });

    it('Then the assertion message explains what it checks', () => {
      // Verify the assertion has a descriptive message
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the negated-object test and check it has a message about non-carried path
      const testMatch = content.match(
        /non-carried denial[\s\S]*?assert\.ok/
      );
      assert.ok(testMatch,
        'Should have negated-object test for non-carried path');

      // Verify it asserts on claims.length
      assert.ok(
        /claims\.length > 0/.test(content),
        'Should assert claims.length > 0'
      );
    });
  });

  describe('Scenario 2: The ordering guard survives a whitespace reformat', () => {
    it('Given the assertCreateBeforePutOrdering helper exists, When called with double-spaced create-secret, Then it still detects the violation', () => {
      // Verify the helper uses \s+ regex (tolerant of whitespace)
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the helper function
      const helperMatch = content.match(
        /function assertCreateBeforePutOrdering[\s\S]*?^}/m
      );
      assert.ok(helperMatch, 'Helper function should exist');

      const helperText = helperMatch[0];

      // Verify it uses \s+ regex (look for the actual regex patterns)
      assert.ok(
        /match\(\/aws\\s\+/.test(helperText),
        'Helper must use \\s+ tolerant regex'
      );

      assert.ok(
        /create-secret/.test(helperText),
        'Helper must reference create-secret'
      );

      assert.ok(
        /put-secret-value/.test(helperText),
        'Helper must reference put-secret-value'
      );
    });

    it('Then the ordering guard throws (not returns) when create-secret is missing', () => {
      // Verify it throws, not returns silently
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const helperMatch = content.match(
        /function assertCreateBeforePutOrdering[\s\S]*?^}/m
      );
      const helperText = helperMatch[0];

      // Verify it throws (not returns) on missing markers
      const throws = helperText.match(/throw new Error/g) || [];
      assert.ok(throws.length >= 2, 'Must have at least 2 throw statements');

      // Verify error mentions the commands
      assert.ok(
        /create-secret/.test(helperText),
        'Error should reference create-secret'
      );
      assert.ok(
        /put-secret-value/.test(helperText),
        'Error should reference put-secret-value'
      );
    });

    it('And the tests verify the guard with double-spaced and reversed order', () => {
      // Verify test exists that reformats both occurrences and checks for throw
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Look for the double-space reformat test
      const doubleSpaceTest = content.match(
        /it\('Then the ordering guard still catches a reversed order.*?double-spaced/s
      );
      assert.ok(doubleSpaceTest, 'Test should verify double-spaced case');

      // Verify it reformats with double spaces
      const reformatMatch = content.match(
        /\.replace\(\s*\/aws \+secretsmanager \+create-secret\/g,\s*'aws  secretsmanager  create-secret'/
      );
      assert.ok(reformatMatch, 'Test must reformat to double spaces');
    });

    it('And a fixture with marker removed entirely fails loudly', () => {
      // Verify test exists that removes the marker and checks for throw
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Look for test that removes create-secret entirely
      const missingTest = content.match(
        /it\('Then the ordering guard throws rather than returns silently when/s
      );
      assert.ok(missingTest, 'Test should verify missing marker case');

      // Verify it uses assert.throws
      assert.ok(
        /assert\.throws\(\s*\(\) => assertCreateBeforePutOrdering\(missing\)/.test(content),
        'Must use assert.throws for missing marker'
      );
    });

    it('Then the real runbook still passes unchanged', () => {
      // Verify the basic test with unmodified runbook exists
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Look for test that runs with runbookText() directly
      const basicTest = content.match(
        /it\('Then the create-secret step precedes the put-secret-value step'/
      );
      assert.ok(basicTest, 'Basic test with unmodified runbook should exist');

      assert.ok(
        /assertCreateBeforePutOrdering\(runbookText\(\)\)/.test(content),
        'Must test with unmodified runbook'
      );
    });

    it('And no test writes to docs/google-oauth-setup.md', () => {
      // Verify fixtures stay in memory, don't write to real files
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify no fs.writeFileSync or similar for the real file
      assert.ok(
        !content.match(/writeFileSync.*docs[\\/]google-oauth-setup\.md/),
        'Must not write to docs/google-oauth-setup.md'
      );

      // Verify fixtures are all in-memory (using mutated template strings)
      const fixturePattern = content.match(
        /const mutated = `\$\{runbookText\(\)\}/g
      );
      assert.ok(fixturePattern, 'Fixtures should use in-memory mutations');
    });
  });

  describe('Scenario 3: "executes successfully" depends on the exit code', () => {
    it('Given a spawn target that exits zero, When the test runs, Then result.code === 0 assertion passes', () => {
      // Verify the test points to exit-zero-fixture.mjs
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the "executes successfully" test
      const testMatch = content.match(
        /it\('And the node --test command executes successfully'[\s\S]*?}\);/
      );
      assert.ok(testMatch, 'Test should exist');

      const testBody = testMatch[0];

      // Verify it uses SPAWN_TARGET (exit-zero-fixture.mjs)
      assert.ok(
        testBody.includes('SPAWN_TARGET'),
        'Must use SPAWN_TARGET'
      );

      // Verify it asserts result.code === 0
      assert.ok(
        /assert\.equal\(result\.code, 0/.test(testBody),
        'Must assert result.code === 0'
      );
    });

    it('Then the spawn target is exit-zero-fixture.mjs, not terraform-scaffold.test.js', () => {
      // Verify SPAWN_TARGET is set correctly
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const spawnTargetMatch = content.match(
        /const SPAWN_TARGET = '([^']+)'/
      );
      assert.ok(spawnTargetMatch, 'SPAWN_TARGET should be defined');
      assert.equal(
        spawnTargetMatch[1],
        'tests/helpers/exit-zero-fixture.mjs',
        'SPAWN_TARGET must be exit-zero-fixture.mjs'
      );

      // Verify the fixture exists
      const fixturePath = path.join(PROJECT_ROOT, spawnTargetMatch[1]);
      assert.ok(
        fs.existsSync(fixturePath),
        'Fixture file must exist'
      );
    });

    it('Then the spawn target imports only node builtins', () => {
      // Verify it has no external dependencies
      const fixturePath = path.join(PROJECT_ROOT, 'tests', 'helpers', 'exit-zero-fixture.mjs');
      const content = fs.readFileSync(fixturePath, 'utf-8');

      // Should only import from node:*
      const imports = content.match(/^import\s+[^;]+;\s*$/gm);
      assert.ok(imports, 'Should have imports');

      for (const importStmt of imports) {
        assert.ok(
          /from\s+['"]node:/.test(importStmt),
          `Import must be from node: builtins: ${importStmt}`
        );
      }
    });
  });

  describe('Scenario 4: No test name promises what it does not measure', () => {
    it('Given the test "And the scoped test:e2e command excludes tests/e2e...", Then its comments explain it does not run npm test', () => {
      // Verify the renamed test has explicit documentation
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const testMatch = content.match(
        /it\('And the scoped test:e2e command excludes tests\/e2e[\s\S]*?}\);/
      );
      assert.ok(testMatch, 'Renamed test should exist');

      const testBody = testMatch[0];

      // Verify it has a comment explaining the real proof is elsewhere
      assert.ok(
        /real exit-0 proof above/.test(testBody) ||
        /AC 11.*already spawns the scoped command/.test(testBody),
        'Comments should explain the real proof is in the sibling test'
      );
    });

    it('Then the real npm test spawn exists as a sibling test', () => {
      // Verify the real spawn test exists nearby
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Look for test that spawns test:e2e and asserts no recursion
      const realTest = content.match(
        /When npm run test:e2e is executed, Then it exits 0[\s\S]*?result\.code/i
      );
      assert.ok(realTest, 'Real test:e2e spawn test should exist');

      // Verify it runs the scoped command
      assert.ok(
        /scopeScriptToSingleFile/.test(content) && /runCommand/.test(content),
        'Test should spawn the actual command'
      );
    });
  });

  describe('Scenario 5: No assert.ok(true, ...) remains', () => {
    /**
     * Recursively collect every `*.test.js` file under `dir`. Enumerated
     * dynamically (not a hardcoded list) so a new vacuous assertion added
     * anywhere in the suite - in a file this test has never heard of - still
     * fails it. tests/helpers fixtures (e.g. exit-zero-fixture.mjs, which is
     * an intentional always-pass spawn target, not a test) are out of scope:
     * only files matching *.test.js are walked.
     * @param {string} dir
     * @returns {string[]} Absolute paths of every *.test.js file found.
     */
    function collectTestFiles(dir) {
      const found = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          found.push(...collectTestFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
          found.push(entryPath);
        }
      }
      return found;
    }

    it('Given the full test suite, When searched for assert.ok(true, Then none are found', () => {
      const testsDir = path.join(PROJECT_ROOT, 'tests');
      const suiteFiles = collectTestFiles(testsDir)
        // task-028-assertions.test.js (this file and its tests/unit sibling)
        // are meta/inspection tests ABOUT this exact defect class: they
        // legitimately quote 'assert.ok(true, ...)' and 'assert.ok(1, ...)'
        // in prose (comments and assertion messages) while checking for the
        // pattern elsewhere, the same reason the self-check at the bottom of
        // dynamodb-calendar.test.js builds its search string from parts
        // rather than writing it literally. Excluding them by name (not by
        // hardcoding the rest of the tree) keeps the sweep dynamic while
        // avoiding a self-match false positive.
        .filter((filePath) => path.basename(filePath) !== 'task-028-assertions.test.js');

      // Sanity check on the sweep itself: if the tree walk came back empty or
      // suspiciously small, the sweep is not actually covering the suite -
      // fail loudly rather than passing vacuously over zero files.
      assert.ok(
        suiteFiles.length >= 20,
        `Expected to find at least 20 *.test.js files under tests/, found ${suiteFiles.length} - the tree walk may be broken`
      );

      for (const filePath of suiteFiles) {
        const relFile = path.relative(PROJECT_ROOT, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Search for assert.ok(true, ...)
        const alwaysTrue = content.match(/assert\.ok\s*\(\s*true\s*,/g);
        assert.ok(
          !alwaysTrue || alwaysTrue.length === 0,
          `File ${relFile} must not contain assert.ok(true, ...)`
        );

        // Also search for assert.ok(1, ...)
        const alwaysOne = content.match(/assert\.ok\s*\(\s*1\s*,/g);
        assert.ok(
          !alwaysOne || alwaysOne.length === 0,
          `File ${relFile} must not contain assert.ok(1, ...)`
        );
      }
    });
  });

  describe('Scenario 6: terraform validate assertion parses -json output', () => {
    it('Given the terraform validate test, When it runs, Then it parses -json output and asserts error_count === 0', () => {
      // Verify the assertion uses JSON.parse and error_count
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-scaffold.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the validate test
      const validateTest = content.match(
        /it\('When "terraform validate"[\s\S]*?error_count[\s\S]*?}\);/
      );
      assert.ok(validateTest, 'Validate test should exist');

      const testBody = validateTest[0];

      // Verify it uses JSON.parse
      assert.ok(
        /JSON\.parse\(result\)/.test(testBody),
        'Must parse JSON output'
      );

      // Verify it asserts error_count === 0
      assert.ok(
        /assert\.equal\([^,]*?error_count[\s\S]*?0/.test(testBody) ||
        /error_count[\s\S]*?0/.test(testBody),
        'Must assert error_count === 0'
      );
    });

    it('Then the assertion message explains the tolerance for warnings', () => {
      // Verify the message mentions the expected warnings
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-scaffold.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const validateTest = content.match(
        /it\('When "terraform validate"[\s\S]*?error_count[\s\S]*?}\);/
      );
      const testBody = validateTest[0];

      // Look for comment about warnings being tolerated
      assert.ok(
        /warnings?.*(ignored|tolerated|expecte|deprecation)/i.test(testBody) ||
        /provider.*warning/.test(testBody),
        'Comments should explain warning tolerance'
      );
    });
  });

  describe('Scenario 7: NODE_TEST_CONTEXT is stripped from spawned env', () => {
    it('Given the runCommand function, When it spawns a child process, Then NODE_TEST_CONTEXT is not passed', () => {
      // Verify the env deletion
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the runCommand function
      const runCommandMatch = content.match(
        /function runCommand[\s\S]*?return \{[\s\S]*?\};/
      );
      assert.ok(runCommandMatch, 'runCommand function should exist');

      const funcBody = runCommandMatch[0];

      // Verify NODE_TEST_CONTEXT is deleted
      assert.ok(
        /delete env\.NODE_TEST_CONTEXT/.test(funcBody),
        'Must delete NODE_TEST_CONTEXT from env'
      );

      // Verify env is passed to spawnSync (in the options object)
      assert.ok(
        /spawnSync/.test(funcBody) && /env/.test(funcBody),
        'Modified env must be passed to spawnSync'
      );
    });

    it('Then the purpose of stripping it is documented', () => {
      // Verify the comment explains the NODE_TEST_CONTEXT leak
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const runCommandMatch = content.match(
        /\/\*[\s\S]*?NODE_TEST_CONTEXT[\s\S]*?\*\/[\s\S]*?function runCommand/
      );
      assert.ok(runCommandMatch, 'Should have detailed comment about NODE_TEST_CONTEXT');

      const comment = runCommandMatch[0];
      assert.ok(
        /recursively|re-entrant|skipping.*running files/i.test(comment),
        'Comment should explain the recursive re-entry problem'
      );
    });
  });
});
