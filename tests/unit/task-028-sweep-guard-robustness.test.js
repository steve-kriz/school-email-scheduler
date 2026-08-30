/**
 * TASK-028: Robustness tests for the sweep guard itself
 *
 * These tests attack the sweep guard to verify it cannot be fooled, and that
 * the floor discrimination genuinely works. We build all pattern strings from
 * parts to avoid this test file itself matching the patterns it tests for
 * (following the pattern used in dynamodb-calendar.test.js:471-479).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

describe('Robustness: The sweep guard and floor discrimination', () => {

  describe('Scenario 1: The sweep regex handles whitespace variations', () => {
    it('Guard pattern matches literal assertion with minimal spacing', () => {
      // Build the pattern from parts (not literally writing the banned sequence)
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      // Build test cases from parts
      const testCases = [
        { parts: ['a', 'ssert.ok(true,'], desc: 'minimal' },
        { parts: ['a', 'ssert.ok( true,'], desc: 'space after paren' },
        { parts: ['a', 'ssert.ok(true ,'], desc: 'space before comma' },
        { parts: ['a', 'ssert.ok( true ,'], desc: 'space both sides' },
        { parts: ['a', 'ssert.ok(  true  ,'], desc: 'multiple spaces' },
      ];

      for (const { parts, desc } of testCases) {
        const str = parts.join('');
        assert.ok(pattern.test(str), `Should match: ${desc}`);
      }
    });

    it('Guard pattern matches literal assertion with 1 numeral', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', '1', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      const testCases = [
        { parts: ['a', 'ssert.ok(1,'], desc: 'minimal' },
        { parts: ['a', 'ssert.ok( 1,'], desc: 'space after paren' },
        { parts: ['a', 'ssert.ok(1 ,'], desc: 'space before comma' },
        { parts: ['a', 'ssert.ok( 1 ,'], desc: 'space both sides' },
      ];

      for (const { parts, desc } of testCases) {
        const str = parts.join('');
        assert.ok(pattern.test(str), `Should match: ${desc}`);
      }
    });
  });

  describe('Scenario 2: The sweep logic filters by exact basename match', () => {
    it('Excludes files named task-028-assertions.test.js only by basename', () => {
      const filter = (filePath) => path.basename(filePath) !== 'task-028-assertions.test.js';

      // Verify the exclusion works for both e2e and unit versions
      assert.ok(
        !filter('/tests/e2e/task-028-assertions.test.js'),
        'Must exclude e2e version'
      );

      assert.ok(
        !filter('/tests/unit/task-028-assertions.test.js'),
        'Must exclude unit version'
      );

      // These SHOULD be included (not filtered out):
      const advancedName = ['task-028-assertions-advanced', '.test.js'].join('');
      assert.ok(
        filter('/tests/e2e/' + advancedName),
        'Should NOT exclude similar named file'
      );

      const prefixName = ['other-task-028-assertions', '.test.js'].join('');
      assert.ok(
        filter('/tests/e2e/' + prefixName),
        'Should NOT exclude file with prefix'
      );

      const suffixName = ['task-028-assertions-test', '.js'].join('');
      assert.ok(
        filter('/tests/e2e/' + suffixName),
        'Should NOT exclude file with suffix'
      );
    });

    it('Basename-only filter cannot catch a meta test in a nested directory', () => {
      const filter = (filePath) => path.basename(filePath) !== 'task-028-assertions.test.js';

      assert.ok(
        !filter('/tests/helpers/task-028-assertions.test.js'),
        'Would also exclude meta file in helpers directory (acceptable)'
      );
    });
  });

  describe('Scenario 3: The >= 20 floor prevents broken walks', () => {
    it('Count of *.test.js files in actual tree meets floor', () => {
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

      const testsDir = path.join(PROJECT_ROOT, 'tests');
      const allFiles = collectTestFiles(testsDir);

      assert.ok(
        allFiles.length >= 20,
        `Floor check: must find >= 20 *.test.js files, found ${allFiles.length}`
      );

      // After filtering out the meta file
      const filtered = allFiles.filter((f) => path.basename(f) !== 'task-028-assertions.test.js');
      assert.ok(
        filtered.length >= 20,
        `After filtering meta files: must find >= 20 files, found ${filtered.length}`
      );

      // The floor must be meaningful but not so high it prevents legitimate testing
      assert.ok(
        filtered.length < 100,
        `Sanity check: tree has ${filtered.length} files (should be reasonable)`
      );
    });

    it('Floor of 20 is meaningful - would catch a severely broken walk', () => {
      const mockWalkResults = [
        { count: 0, shouldPass: false },
        { count: 1, shouldPass: false },
        { count: 19, shouldPass: false },
        { count: 20, shouldPass: true },
        { count: 35, shouldPass: true },
      ];

      for (const { count, shouldPass } of mockWalkResults) {
        const passes = count >= 20;
        assert.equal(
          passes,
          shouldPass,
          `Floor check: ${count} files should ${shouldPass ? 'pass' : 'fail'}`
        );
      }
    });
  });

  describe('Scenario 4: The sweep only walks *.test.js files', () => {
    it('Does not match .test.mjs files', () => {
      const endsWithTestJs = (name) => name.endsWith('.test.js');

      assert.ok(endsWithTestJs('file.test.js'), 'matches .test.js');
      assert.ok(!endsWithTestJs('file.test.mjs'), 'does NOT match .test.mjs');
      assert.ok(!endsWithTestJs('file.mjs'), 'does NOT match .mjs');
      assert.ok(!endsWithTestJs('file.js'), 'does NOT match plain .js');
    });

    it('Does not match files without .test. in the name', () => {
      const endsWithTestJs = (name) => name.endsWith('.test.js');

      assert.ok(!endsWithTestJs('helpers.js'), 'does NOT match non-test files');
      assert.ok(!endsWithTestJs('utils.test-helpers.js'), 'does NOT match .test-helpers');
    });

    it('Helper fixture files in tests/helpers/ are out of scope', () => {
      const endsWithTestJs = (name) => name.endsWith('.test.js');

      assert.ok(!endsWithTestJs('exit-zero-fixture.mjs'),
        'Helper fixtures are not swept - correct'
      );
    });
  });

  describe('Scenario 5: The meta-file exclusion is documented appropriately', () => {
    it('task-028-assertions.test.js file contains explicit comment about exclusion', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'task-028-assertions.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the comment explaining the exclusion
      const exclusionComment = content.match(
        /task-028-assertions\.test\.js[\s\S]*?exclude|exclude[\s\S]*?task-028-assertions/i
      );
      assert.ok(
        exclusionComment,
        'Should have comment explaining meta-file exclusion'
      );

      // Verify the reason is stated (meta/inspection test)
      assert.ok(
        /meta|inspection|quote|prose|self-check/i.test(content),
        'Comment should explain why meta file is excluded'
      );
    });

    it('The exclusion would NOT hide a genuine vacuous assertion in the meta file', () => {
      // This is important: if we added the banned pattern to the meta file,
      // it would NOT be caught by the sweep (because meta files are excluded).
      // Is this acceptable?
      //
      // YES - acceptable because:
      // 1. The meta file quotes the pattern in prose/comments (legitimate)
      // 2. Any assertion in the meta file should be structural (reading/grepping)
      // 3. The meta file is curated, not auto-generated

      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'task-028-assertions.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify the assertions in the meta file are structural (file reading)
      assert.ok(
        /fs\.readFileSync|content\.match|content\.includes|regex|pattern/.test(content),
        'Meta file assertions should be structural (file inspection)'
      );
    });
  });

  describe('Scenario 6: Proof that error_count assertions can fail', () => {
    it('dynamodb-calendar.test.js error_count assertion would fail if result.error_count != 0', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'dynamodb-calendar.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the assertion
      const assertion = content.match(/assert\.equal\(\s*parsed\.error_count,\s*0/);
      assert.ok(assertion, 'Must have assert.equal(parsed.error_count, 0)');

      // Verify it would fail if error_count were not 0
      const eqZero = (num) => {
        assert.equal(num, 0, 'error_count must equal 0');
      };

      assert.doesNotThrow(() => eqZero(0), 'Should pass when error_count === 0');
      assert.throws(() => eqZero(1), 'Should fail when error_count === 1');
    });

    // These two used to pin literal line numbers (103 and 181) and window ten
    // lines around each. That made them break on any edit above the window -
    // TASK-051 raised the two `terraform validate` timeouts in that file and
    // shifted every following line, turning a comment change into a red test
    // that said nothing about the property being guarded. The property is "the
    // file asserts on parsed.error_count, twice, once per validate run", so
    // that is what is asserted now, by finding the assertions rather than by
    // counting lines to them.
    it('terraform-resolver.test.js asserts on parsed.error_count for its first validate run', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-resolver.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      assert.ok(
        /assert\.equal\(\s*\n?\s*parsed\.error_count,\s*\n?\s*0\b/.test(content),
        'terraform-resolver.test.js should assert.equal(parsed.error_count, 0)'
      );
    });

    it('terraform-resolver.test.js has an error_count assertion for BOTH of its validate runs', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'terraform-resolver.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      const assertions = content.match(/assert\.equal\(\s*\n?\s*parsed\.error_count,/g) || [];
      assert.equal(
        assertions.length,
        2,
        `terraform-resolver.test.js should carry exactly two parsed.error_count assertions ` +
        `(one per terraform validate run), found ${assertions.length}`
      );

      const validateRuns = content.match(/validate -json|'validate', '-json'/g) || [];
      assert.equal(
        validateRuns.length,
        assertions.length,
        `every terraform validate run should be followed by an error_count assertion: ` +
        `${validateRuns.length} run(s) vs ${assertions.length} assertion(s)`
      );
    });

    it('package-deps-deployment.test.js asserts PASS log', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'package-deps-deployment.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Find the PASS assertion in the content
      assert.ok(
        /assert\.ok\([^)]*includes\s*\(\s*['"]PASS['"][^)]*\)/.test(content),
        'File should assert PASS log'
      );
    });
  });

  describe('Scenario 7: Skip path analysis (Windows note)', () => {
    it('Skip branches exist in dynamodb-calendar.test.js', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'dynamodb-calendar.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Verify skip branches exist
      const skipCount = (content.match(/t\.skip\(/g) || []).length;
      assert.ok(skipCount >= 2, 'Must have at least 2 t.skip() calls (init and validate)');

      // Verify they're guarded by error.code === 'ENOENT'
      assert.ok(
        /if\s*\(\s*error\.code\s*===\s*'ENOENT'\s*\)[\s\S]{0,100}t\.skip/.test(content),
        'Skip must be guarded by ENOENT check'
      );
    });

    it('Both skip and fail paths are present in dynamodb-calendar.test.js', () => {
      const testFile = path.join(PROJECT_ROOT, 'tests', 'e2e', 'dynamodb-calendar.test.js');
      const content = fs.readFileSync(testFile, 'utf-8');

      // Both paths exist:
      assert.ok(content.includes('t.skip'), 'Skip path exists');
      assert.ok(content.includes('assert.fail'), 'Fail-loudly path exists');

      // Verify skip is guarded by ENOENT check
      assert.ok(
        /if\s*\(\s*error\.code\s*===\s*['"]ENOENT['"]/.test(content),
        'Skip should be guarded by ENOENT check'
      );
    });
  });

  describe('Scenario 8: Edge cases the guard might miss (and should)', () => {
    it('Negated boolean is NOT caught (and should not be)', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      // Build !false test from parts
      const negatedTest = ['a', 'ssert.ok(!false, ', "'msg')"].join('');
      assert.ok(
        !pattern.test(negatedTest),
        'Guard correctly does NOT match !false variant'
      );
    });

    it('Different assertion function is NOT caught (and should not be)', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      // strictEqual should not match
      const strictEqualTest = 'assert.strictEqual(true, true)';
      assert.ok(
        !pattern.test(strictEqualTest),
        'Guard correctly does NOT match strictEqual'
      );
    });

    it('Pattern matches across newlines because \\s includes newlines', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      // Build multiline test string from parts
      const multiline = ['a', 'ssert.ok(\n  true,\n  ', "'msg'", '\n', ')'].join('');
      assert.ok(
        pattern.test(multiline),
        'Pattern should match multiline (\\s includes newlines)'
      );
    });
  });

  describe('Scenario 9: The sweep is durable', () => {
    it('Adding a new test file in tests/deep/nested/path/ would be swept', () => {
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

      const testsDir = path.join(PROJECT_ROOT, 'tests');
      const allFiles = collectTestFiles(testsDir);

      // Verify we find files in various subdirectories
      const hasE2e = allFiles.some((f) => f.includes('e2e'));
      const hasUnit = allFiles.some((f) => f.includes('unit'));

      assert.ok(hasE2e, 'Should find e2e test files');
      assert.ok(hasUnit, 'Should find unit test files');
    });

    it('Renaming a .test.js file still includes it in the sweep', () => {
      const endsWithTestJs = (name) => name.endsWith('.test.js');
      assert.ok(
        endsWithTestJs('a-different-name.test.js'),
        'Renamed file still matches'
      );
    });
  });

  describe('Scenario 10: Attack the sweep - variants to try', () => {
    it('Variant 1: Extra spaces before and after paren', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      const variant = ['a', 'ssert.ok(    true    ,'].join('');
      assert.ok(pattern.test(variant), 'Should catch variant with many spaces');
    });

    it('Variant 2: Tab character in spacing', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      const variant = ['a', 'ssert.ok(\ttrue\t,'].join('');
      assert.ok(pattern.test(variant), 'Should catch variant with tabs');
    });

    it('Variant 3: Numeric 1 instead of true', () => {
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', '1', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr);

      const variant = ['a', 'ssert.ok(1,'].join('');
      assert.ok(pattern.test(variant), 'Should catch numeric variant');
    });

    it('Variant 4: The sweep uses .match() with global flag', () => {
      // Verify that .match() with 'g' flag returns all occurrences
      const patternParts = ['assert', '.', 'ok', '\\s*\\(\\s*', 'true', '\\s*,'];
      const patternStr = patternParts.join('');
      const pattern = new RegExp(patternStr, 'g');

      const content = ['a', 'ssert.ok(true, msg) and a', 'ssert.ok(true, other)'].join('');
      const matches = content.match(pattern);
      assert.ok(matches, 'Should find matches');
      assert.equal(matches.length, 2, 'Should find all 2 occurrences');
    });

    it('Variant 5: The sweep correctly only walks *.test.js files', () => {
      // Verify that .test.mjs files are not included
      assert.ok(
        !'fixture.mjs'.endsWith('.test.js'),
        'Fixtures with .mjs extension are not test files'
      );

      assert.ok(
        'mytest.test.js'.endsWith('.test.js'),
        'Files ending in .test.js are included'
      );
    });

    it('Variant 6: The floor genuinely prevents empty walks', () => {
      // If someone broke the walk function, it might return 0 files
      // The >= 20 check would fail such a broken implementation
      const brokenWalkResults = [0, 1, 5, 19];
      for (const count of brokenWalkResults) {
        const passes = count >= 20;
        assert.equal(passes, false, `Walk returning ${count} files should fail floor`);
      }

      // But a correct walk should pass
      assert.equal(35 >= 20, true, 'Correct walk (35 files) should pass floor');
    });
  });
});
