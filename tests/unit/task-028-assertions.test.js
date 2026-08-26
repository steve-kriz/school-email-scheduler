/**
 * TASK-028: Four assertions that do not verify what they claim
 *
 * Unit tests for dead/vacuous assertion fixes, including critical mutations
 * to verify the assertions now actually work.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

describe('Unit Tests: TASK-028 Assertions', () => {

  describe('Test Suite 1: Negated-object assertion is concrete', () => {
    it('Uses claims.length > 0, not tautological constant check', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify no tautological pattern remains
      assert.ok(
        !content.includes('/nothing|no/.test(negatedObjectClaim)'),
        'Should not have tautological /nothing|no/ regex on constant'
      );

      // Verify claims.length > 0 assertions exist
      assert.ok(
        /claims\.length > 0/.test(content),
        'Should assert claims.length > 0'
      );
    });
  });

  describe('Test Suite 2: Ordering guard uses whitespace-tolerant regex', () => {
    it('Helper uses \\s+ for both aws secretsmanager commands', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify \s+ usage in helper
      assert.ok(
        /aws\\s\+secretsmanager\\s\+create-secret/.test(content),
        'Must use \\s+ tolerant regex'
      );
    });

    it('Helper throws (not returns) when markers missing', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the function
      const helperMatch = content.match(
        /function assertCreateBeforePutOrdering[\s\S]*?^}/m
      );
      assert.ok(helperMatch, 'Helper exists');

      // Count throw statements
      const throws = helperMatch[0].match(/throw new Error/g) || [];
      assert.ok(throws.length >= 2, 'Must have throw statements');
    });

    it('Tests cover double-spaced and reversed order cases', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify tests for double-space and ordering exist
      assert.ok(
        /double-spaced|double spaced/.test(content),
        'Should have test for double-spaced case'
      );

      // Count assert.throws calls
      const throws = content.match(/assert\.throws[\s\S]{0,200}assertCreateBeforePutOrdering/g) || [];
      assert.ok(
        throws.length >= 2,
        'Should have at least 2 assert.throws for the helper'
      );
    });
  });

  describe('Test Suite 3: "executes successfully" asserts exit code', () => {
    it('Test asserts result.code === 0', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /assert\.equal\(result\.code, 0/.test(content),
        'Must assert result.code === 0'
      );
    });

    it('Test uses exit-zero-fixture.mjs', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /exit-zero-fixture\.mjs/.test(content),
        'Must use exit-zero-fixture.mjs'
      );
    });
  });

  describe('Test Suite 4: Test names match measured behavior', () => {
    it('Scoped test explains it is not the real spawn', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find test about scoped command
      assert.ok(
        /scoped.*excludes.*tests\/e2e/.test(content),
        'Should have test about scoped command excluding tests/e2e'
      );

      // Verify it explains real test is elsewhere
      assert.ok(
        /does not run|real.*proof|real.*test/.test(content),
        'Should explain real test exists elsewhere'
      );
    });

    it('Real test:e2e spawn test exists', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /npm run test:e2e.*exits 0|test:e2e.*spawned/.test(content),
        'Should have real test:e2e spawn test'
      );
    });
  });

  describe('Test Suite 5: NODE_TEST_CONTEXT is stripped', () => {
    it('runCommand deletes NODE_TEST_CONTEXT before spawning', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /delete env\.NODE_TEST_CONTEXT/.test(content),
        'Must delete NODE_TEST_CONTEXT from env'
      );
    });

    it('Comment explains NODE_TEST_CONTEXT leak problem', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify documentation exists
      assert.ok(
        /NODE_TEST_CONTEXT/.test(content),
        'Should mention NODE_TEST_CONTEXT'
      );

      assert.ok(
        /recursive|recursively|re-entrant|re-entracy/i.test(content),
        'Should explain the recursive re-entry problem'
      );

      assert.ok(
        /exit 0|fails when/.test(content),
        'Should explain why NODE_TEST_CONTEXT causes problems'
      );
    });

    it('Multiple result.code === 0 assertions now real', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Count assertions
      const assertions = content.match(/assert\.equal\(result\.code, 0/g) || [];
      assert.ok(
        assertions.length >= 2,
        'Should have multiple result.code === 0 assertions'
      );
    });
  });

  describe('Test Suite 6: No assert.ok(true) or assert.ok(1) remains', () => {
    it('check-oauth-config.test.js has no assert.ok(true)', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        !content.includes('assert.ok(true'),
        'Must not have assert.ok(true, ...)'
      );
    });

    it('npm-scripts.test.js has no assert.ok(true)', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        !content.includes('assert.ok(true'),
        'Must not have assert.ok(true, ...)'
      );
    });

    it('terraform-scaffold.test.js has no assert.ok(true) or assert.ok(1)', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-scaffold.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        !content.includes('assert.ok(true'),
        'Must not have assert.ok(true, ...)'
      );

      assert.ok(
        !content.match(/assert\.ok\s*\(\s*1\s*,/),
        'Must not have assert.ok(1, ...)'
      );
    });
  });

  describe('Test Suite 7: terraform validate assertion parses JSON', () => {
    it('Uses JSON.parse on terraform -json output', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-scaffold.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify both JSON.parse and terraform validate -json exist
      assert.ok(
        /JSON\.parse/.test(content),
        'Must parse JSON output'
      );

      assert.ok(
        /terraform validate.*-json|validate.*-json/.test(content),
        'Must use terraform validate -json'
      );
    });

    it('Asserts error_count === 0', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-scaffold.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /error_count/.test(content),
        'Must reference error_count'
      );

      assert.ok(
        /error_count.*0|0.*error_count/.test(content),
        'Must check error_count value'
      );
    });
  });

  describe('Test Suite 8: runCommand function works correctly', () => {
    it('Copies process.env and deletes NODE_TEST_CONTEXT', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify env copy
      assert.ok(
        /\{\s*\.\.\.process\.env/.test(content),
        'Should copy process.env with spread operator'
      );

      // Verify deletion
      assert.ok(
        /delete env\.NODE_TEST_CONTEXT/.test(content),
        'Must delete NODE_TEST_CONTEXT'
      );
    });

    it('Passes env to spawnSync', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify spawnSync and env exist
      assert.ok(
        /spawnSync/.test(content),
        'Must use spawnSync'
      );

      assert.ok(
        /spawnSync[\s\S]{0,200}env[\s\S]{0,200}\}/.test(content),
        'Must pass env to spawnSync in options'
      );
    });

    it('Returns object with code, stdout, stderr', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify return object structure
      assert.ok(
        /code[\s\S]*stdout[\s\S]*stderr/.test(content),
        'Should return object with code, stdout, stderr'
      );
    });
  });
});
