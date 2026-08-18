import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPathArguments, isDirectoryCovered } from '../helpers/script-coverage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

describe('Unit Tests: NPM Scripts Configuration for TASK-019', () => {
  describe('Feature: package.json scripts are correctly configured', () => {
    let packageJson;

    it('Setup: Read and parse package.json', () => {
      assert.doesNotThrow(() => {
        const content = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
        packageJson = JSON.parse(content);
      }, 'package.json should be valid JSON');
    });

    describe('Scenario: test script includes both unit and e2e directories', () => {
      it('When checking the "test" script, Then it should run tests/unit and tests/e2e', () => {
        assert.ok(packageJson.scripts, 'package.json should have scripts section');
        assert.ok(packageJson.scripts.test, 'test script should exist');

        const testScript = packageJson.scripts.test;
        // Semantic check via the shared predicate: equivalent forms are acceptable
        // (e.g., "node --test tests" or "node --test tests/") but a script that silently
        // drops a directory must fail. The previous form,
        //   (includes('tests/unit') && includes('tests/e2e')) || includes('tests/')
        // could not fail: `&&` binds tighter than `||`, so "node --test tests/unit"
        // satisfied the trailing includes('tests/') branch with e2e dropped.
        assert.ok(isDirectoryCovered(testScript, 'unit'),
          `test script should cover tests/unit. Got: "${testScript}"`);
        assert.ok(isDirectoryCovered(testScript, 'e2e'),
          `test script should cover tests/e2e. Got: "${testScript}"`);
      });

      it('And the coverage assertion fails for a script that drops tests/e2e', () => {
        // Synthetic proof that the guard above can actually fail on the exact
        // regression it exists to prevent.
        const droppedE2e = 'node --test tests/unit';
        assert.ok(isDirectoryCovered(droppedE2e, 'unit'),
          'Synthetic script should still cover tests/unit');
        assert.ok(!isDirectoryCovered(droppedE2e, 'e2e'),
          `"${droppedE2e}" must NOT be treated as covering tests/e2e`);

        // And that equivalent whole-tree forms are still accepted
        for (const equivalent of ['node --test tests', 'node --test ./tests/', 'node --test "tests"']) {
          assert.ok(isDirectoryCovered(equivalent, 'unit') && isDirectoryCovered(equivalent, 'e2e'),
            `"${equivalent}" should cover both directories`);
        }
      });

      it('And the script should run with node --test', () => {
        const testScript = packageJson.scripts.test;
        assert.ok(testScript.startsWith('node --test'),
          `test script should start with "node --test". Got: "${testScript}"`);
      });
    });

    describe('Scenario: test:unit script runs only unit tests', () => {
      it('When checking the "test:unit" script, Then it should run tests/unit only', () => {
        assert.ok(packageJson.scripts['test:unit'], 'test:unit script should exist');

        const testUnitScript = packageJson.scripts['test:unit'];
        // Semantic check: must cover unit, must not include e2e in the explicit path
        assert.ok(testUnitScript.includes('tests/unit'),
          `test:unit script should reference tests/unit. Got: "${testUnitScript}"`);
        assert.ok(!testUnitScript.includes('tests/e2e'),
          `test:unit script should not reference tests/e2e. Got: "${testUnitScript}"`);
      });

      it('And the script should run with node --test', () => {
        const testUnitScript = packageJson.scripts['test:unit'];
        assert.ok(testUnitScript.startsWith('node --test'),
          `test:unit script should start with "node --test". Got: "${testUnitScript}"`);
      });
    });

    describe('Scenario: test:e2e script uses node:test instead of Playwright', () => {
      it('When checking the "test:e2e" script, Then it uses node --test', () => {
        assert.ok(packageJson.scripts['test:e2e'], 'test:e2e script should exist');

        const testE2eScript = packageJson.scripts['test:e2e'];
        // Semantic check: must use node --test with tests/e2e
        assert.ok(testE2eScript.startsWith('node --test'),
          `test:e2e script should use "node --test". Got: "${testE2eScript}"`);
        assert.ok(testE2eScript.includes('tests/e2e'),
          `test:e2e script should reference tests/e2e. Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference "playwright"', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('playwright'),
          `test:e2e script should not invoke playwright. Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference "bddgen"', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('bddgen'),
          `test:e2e script should not invoke bddgen. Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference Playwright-related binaries', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('pw'),
          `test:e2e script should not invoke playwright. Got: "${testE2eScript}"`);
      });
    });

    describe('Scenario: test:unit:coverage script preserves original behavior', () => {
      it('When checking the "test:unit:coverage" script, Then it enables coverage and runs tests/unit', () => {
        assert.ok(packageJson.scripts['test:unit:coverage'],
          'test:unit:coverage script should exist');

        const coverageScript = packageJson.scripts['test:unit:coverage'];
        // Semantic check: must enable coverage and target unit tests only
        assert.ok(coverageScript.includes('--experimental-test-coverage'),
          'test:unit:coverage script should include --experimental-test-coverage');
        assert.ok(coverageScript.includes('tests/unit'),
          'test:unit:coverage script should include tests/unit');
        assert.ok(!coverageScript.includes('tests/e2e'),
          'test:unit:coverage script should not include tests/e2e');
      });
    });

    describe('Scenario: test:bdd script runs with node:test', () => {
      it('When checking the "test:bdd" script, Then it uses node --test on tests/bdd', () => {
        assert.ok(packageJson.scripts['test:bdd'],
          'test:bdd script should exist (required by existing test assertions)');

        const testBddScript = packageJson.scripts['test:bdd'];
        // Semantic check: must use node --test on tests/bdd
        assert.ok(testBddScript.startsWith('node --test'),
          `test:bdd script should use "node --test". Got: "${testBddScript}"`);
        assert.ok(testBddScript.includes('tests/bdd'),
          `test:bdd script should reference tests/bdd. Got: "${testBddScript}"`);
      });

      it('And it should NOT reference "playwright"', () => {
        const testBddScript = packageJson.scripts['test:bdd'];
        assert.ok(!testBddScript.includes('playwright'),
          'test:bdd script should not reference playwright');
      });
    });

    describe('Scenario: check:oauth-config script is preserved', () => {
      it('When checking the "check:oauth-config" script, Then it should exist', () => {
        assert.ok(packageJson.scripts['check:oauth-config'],
          'check:oauth-config script should exist');
      });

      it('And it should reference the check-oauth-config.mjs file', () => {
        const checkScript = packageJson.scripts['check:oauth-config'];
        assert.ok(checkScript.includes('check-oauth-config.mjs'),
          `check:oauth-config should reference check-oauth-config.mjs. Got: "${checkScript}"`);
      });

      it('And it should use "node" to run the script', () => {
        const checkScript = packageJson.scripts['check:oauth-config'];
        assert.ok(checkScript.startsWith('node'),
          `check:oauth-config should start with "node". Got: "${checkScript}"`);
      });
    });

    describe('Scenario: No deprecated Playwright-specific scripts remain', () => {
      it('When checking all scripts, Then "test:e2e:headed" should NOT exist', () => {
        assert.ok(!packageJson.scripts['test:e2e:headed'],
          'Deprecated test:e2e:headed script should be removed');
      });

      it('And "test:e2e:ui" should NOT exist', () => {
        assert.ok(!packageJson.scripts['test:e2e:ui'],
          'Deprecated test:e2e:ui script should be removed');
      });

      it('And "test:e2e:report" should NOT exist', () => {
        assert.ok(!packageJson.scripts['test:e2e:report'],
          'Deprecated test:e2e:report script should be removed');
      });

      it('And "test:bdd:headed" should NOT exist', () => {
        assert.ok(!packageJson.scripts['test:bdd:headed'],
          'Deprecated test:bdd:headed script should be removed');
      });

      it('And "test:bdd:report" should NOT exist', () => {
        assert.ok(!packageJson.scripts['test:bdd:report'],
          'Deprecated test:bdd:report script should be removed');
      });
    });

    describe('Scenario: No scripts invoke missing binaries', () => {
      it('When checking all scripts, Then each should use "node", "npm", or an available binary', () => {
        const scripts = packageJson.scripts || {};
        const nodeModulesExists = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'));

        for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
          // Extract first token (the binary)
          const tokens = scriptCmd.trim().split(/\s+/);
          const firstToken = tokens[0];

          // node and npm are always available
          if (firstToken === 'node' || firstToken === 'npm') {
            continue;
          }

          // If node_modules exists, check if binary is in .bin
          if (nodeModulesExists) {
            const binPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', firstToken);
            const binPathCmd = binPath + '.cmd';
            const binPathPs1 = binPath + '.ps1';

            assert.ok(
              fs.existsSync(binPath) || fs.existsSync(binPathCmd) || fs.existsSync(binPathPs1),
              `Script "${scriptName}" uses "${firstToken}" which should be in node_modules/.bin or be "node"/"npm". Got: "${scriptCmd}"`
            );
          } else {
            // If node_modules doesn't exist, only node/npm are acceptable
            assert.ok(
              firstToken === 'node' || firstToken === 'npm',
              `Script "${scriptName}" uses "${firstToken}" but node_modules is not present. Only "node" and "npm" are acceptable. Got: "${scriptCmd}"`
            );
          }
        }
      });
    });

    describe('Scenario: No Playwright devDependencies remain', () => {
      it('When checking devDependencies, Then "@playwright/test" should NOT be present', () => {
        const devDeps = packageJson.devDependencies || {};
        assert.ok(!devDeps['@playwright/test'],
          'Playwright dependency @playwright/test should be removed');
      });

      it('And "playwright-bdd" should NOT be present', () => {
        const devDeps = packageJson.devDependencies || {};
        assert.ok(!devDeps['playwright-bdd'],
          'Playwright dependency playwright-bdd should be removed');
      });
    });
  });

  describe('Feature: Script command validation', () => {
    it('Scenario: Every script command has valid syntax', () => {
      const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      const scripts = packageJson.scripts || {};

      for (const [scriptName, scriptCmd] of Object.entries(scripts)) {
        // Each script should be a non-empty string
        assert.ok(typeof scriptCmd === 'string' && scriptCmd.trim().length > 0,
          `Script "${scriptName}" should be a non-empty string. Got: "${scriptCmd}"`);

        // Should not have obvious syntax errors (unbalanced quotes, etc.)
        const singleQuotes = (scriptCmd.match(/'/g) || []).length;
        const doubleQuotes = (scriptCmd.match(/"/g) || []).length;
        const backticks = (scriptCmd.match(/`/g) || []).length;

        assert.ok(singleQuotes % 2 === 0, `Script "${scriptName}" has unbalanced single quotes`);
        assert.ok(doubleQuotes % 2 === 0, `Script "${scriptName}" has unbalanced double quotes`);
        assert.ok(backticks % 2 === 0, `Script "${scriptName}" has unbalanced backticks`);
      }
    });

    it('Scenario: Scripts use absolute path references where needed', () => {
      const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));

      // All test scripts should reference relative paths from project root
      const testScripts = ['test', 'test:unit', 'test:e2e', 'test:unit:coverage', 'test:bdd'];
      for (const scriptName of testScripts) {
        if (packageJson.scripts[scriptName]) {
          const script = packageJson.scripts[scriptName];
          // Should target a path under tests/, relative to where npm runs (project root).
          // Checked on the parsed positional arguments so equivalent spellings
          // ("tests", "./tests/", quoted paths) are accepted and flag values are not
          // mistaken for paths.
          const targetsTestTree = extractPathArguments(script)
            .some(arg => arg === 'tests' || arg.startsWith('tests/'));
          assert.ok(targetsTestTree,
            `Script "${scriptName}" should target a path under tests/. Got: "${script}"`);
        }
      }
    });
  });

  describe('Feature: File existence validation', () => {
    it('Scenario: Test directories exist for each script', () => {
      const testDirs = {
        'tests/unit': 'unit test directory',
        'tests/e2e': 'e2e test directory'
      };

      for (const [relPath, description] of Object.entries(testDirs)) {
        const fullPath = path.join(PROJECT_ROOT, relPath);
        assert.ok(fs.existsSync(fullPath),
          `${description} at "${relPath}" should exist`);
        assert.ok(fs.statSync(fullPath).isDirectory(),
          `"${relPath}" should be a directory`);
      }
    });

    it('Scenario: check-oauth-config.mjs script exists', () => {
      const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'check-oauth-config.mjs');
      assert.ok(fs.existsSync(scriptPath),
        `check-oauth-config.mjs should exist at "${scriptPath}"`);
    });

    it('Scenario: Test files exist in referenced directories', () => {
      const testDirs = [
        path.join(PROJECT_ROOT, 'tests', 'unit'),
        path.join(PROJECT_ROOT, 'tests', 'e2e')
      ];

      for (const testDir of testDirs) {
        const files = fs.readdirSync(testDir)
          .filter(f => f.endsWith('.test.js'));
        assert.ok(files.length > 0,
          `${testDir} should contain at least one .test.js file`);
      }
    });
  });

  describe('Feature: Coverage predicate guards against silent directory exclusions', () => {
    describe('Scenario: Coverage predicate rejects scripts that drop tests/e2e', () => {
      it('When the test script covers only tests/unit, Then it is rejected', () => {
        const unitOnlyScript = 'node --test tests/unit';
        assert.ok(isDirectoryCovered(unitOnlyScript, 'unit'),
          'Script targeting only unit should cover unit');
        assert.ok(!isDirectoryCovered(unitOnlyScript, 'e2e'),
          'Script targeting only unit must NOT cover e2e (regression guard for AC 9)');
      });

      it('And mirror case: When the test script covers only tests/e2e, Then it rejects unit', () => {
        const e2eOnlyScript = 'node --test tests/e2e';
        assert.ok(isDirectoryCovered(e2eOnlyScript, 'e2e'),
          'Script targeting only e2e should cover e2e');
        assert.ok(!isDirectoryCovered(e2eOnlyScript, 'unit'),
          'Script targeting only e2e must NOT cover unit (mirror of AC 9)');
      });

      it('And the root coverage assertion on the real test script confirms both are included', () => {
        const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
        const testScript = packageJson.scripts.test;

        assert.ok(isDirectoryCovered(testScript, 'unit'),
          'Real test script must cover tests/unit');
        assert.ok(isDirectoryCovered(testScript, 'e2e'),
          'Real test script must cover tests/e2e (AC 1)');
      });
    });

    describe('Scenario: All legitimate script forms covering the whole tree are accepted', () => {
      it('When given "node --test tests", Then it covers all directories', () => {
        for (const dir of ['unit', 'e2e', 'integration']) {
          assert.ok(isDirectoryCovered('node --test tests', dir),
            `"node --test tests" must cover tests/${dir} (AC 1)`);
        }
      });

      it('When given "node --test ./tests/", Then it covers all directories', () => {
        for (const dir of ['unit', 'e2e', 'integration']) {
          assert.ok(isDirectoryCovered('node --test ./tests/', dir),
            `"node --test ./tests/" must cover tests/${dir} (AC 2)`);
        }
      });

      it('When given "node --test \\"tests/e2e\\"", Then it covers only e2e', () => {
        assert.ok(isDirectoryCovered('node --test "tests/e2e"', 'e2e'),
          `"node --test \\"tests/e2e\\"" must cover tests/e2e (AC 3)`);
        assert.ok(!isDirectoryCovered('node --test "tests/e2e"', 'unit'),
          'Quoted path to e2e should not cover unit');
      });

      it('When given "node --test tests/e2e-legacy", Then it does NOT cover e2e', () => {
        assert.ok(!isDirectoryCovered('node --test tests/e2e-legacy', 'e2e'),
          `"node --test tests/e2e-legacy" must NOT cover tests/e2e (AC 4, reject substring match)`);
        assert.ok(isDirectoryCovered('node --test tests/e2e-legacy', 'e2e-legacy'),
          'Should cover the exact directory e2e-legacy when explicitly present');
      });

      it('When given a value-taking flag, Then the flag value is not treated as a path', () => {
        const scriptWithFlagValue = 'node --test --test-name-pattern tests tests/unit';
        assert.ok(!isDirectoryCovered(scriptWithFlagValue, 'integration'),
          `Flag value "tests" should not cover tests/integration (AC 5)`);
        assert.ok(isDirectoryCovered(scriptWithFlagValue, 'unit'),
          'Explicit tests/unit should be covered');
      });
    });

    describe('Scenario: Value-taking flags are handled via allowlist', () => {
      it('When given --test-name-pattern flag with path-like value, Then the value is skipped and real path is used', () => {
        // --test-name-pattern takes a value; a bare "tests" token after it is consumed as the value,
        // not as a path argument. Only tests/unit is the real path argument.
        // If --test-name-pattern is removed from allowlist, this would incorrectly cover integration.
        assert.ok(isDirectoryCovered('node --test --test-name-pattern tests tests/unit', 'unit'),
          'Explicit tests/unit should be covered');
        assert.ok(!isDirectoryCovered('node --test --test-name-pattern tests tests/unit', 'integration'),
          '--test-name-pattern value "tests" must NOT be read as a path (PINNED by this case)');
      });

      it('And --test-reporter flag with path-like value is skipped (PINS allowlist entry)', () => {
        // --test-reporter takes a value. Here "tests" is its value, not a path.
        // Only tests/unit is the real path. If --test-reporter is removed from the allowlist,
        // "tests" would be wrongly treated as a path and tests/integration would be covered.
        assert.ok(isDirectoryCovered('node --test --test-reporter tests tests/unit', 'unit'),
          'Explicit tests/unit should be covered');
        assert.ok(!isDirectoryCovered('node --test --test-reporter tests tests/unit', 'integration'),
          '--test-reporter value "tests" must NOT be read as a path (PINS allowlist: AC 6)');
      });

      it('And --test-concurrency flag with path-like value is skipped (PINS allowlist entry)', () => {
        // --test-concurrency takes a numeric value. If a bare "tests" appears after it,
        // it is consumed as the value, not a path. Only tests/unit is the real path.
        // Removing this from allowlist would wrongly cover integration.
        assert.ok(isDirectoryCovered('node --test --test-concurrency tests tests/unit', 'unit'),
          'Explicit tests/unit should be covered');
        assert.ok(!isDirectoryCovered('node --test --test-concurrency tests tests/unit', 'integration'),
          '--test-concurrency value "tests" must NOT be read as a path (PINS allowlist: AC 6)');
      });

      it('And --experimental-loader flag with path-like value is skipped (PINS allowlist entry)', () => {
        // --experimental-loader takes a value. Here "tests" is its value, not a path.
        // Only tests/unit is the real path. If --experimental-loader is removed from the allowlist,
        // "tests" would be wrongly treated as a path and tests/integration would be covered.
        assert.ok(isDirectoryCovered('node --test --experimental-loader tests --test tests/unit', 'unit'),
          'Explicit tests/unit should be covered');
        assert.ok(!isDirectoryCovered('node --test --experimental-loader tests --test tests/unit', 'integration'),
          '--experimental-loader value "tests" must NOT be read as a path (PINS allowlist: AC 6)');
      });

      it('And --flag=value form never consumes the next token (even for value-taking flags)', () => {
        // In --flag=value form, the = binds tightly, so the next token is always a real argument.
        // These must all cover both unit and e2e since tests/ is the actual path argument.
        assert.ok(isDirectoryCovered('node --test --test-reporter=json tests', 'unit'),
          '--test-reporter=json should not consume the following tests');
        assert.ok(isDirectoryCovered('node --test --test-reporter=json tests', 'e2e'),
          '--test-reporter=value form must treat next token as path (AC 6, =value form test)');

        assert.ok(isDirectoryCovered('node --test --test-concurrency=4 tests', 'unit'),
          '--test-concurrency=4 should not consume the following tests');
        assert.ok(isDirectoryCovered('node --test --test-concurrency=4 tests', 'e2e'),
          '--test-concurrency=value form must treat next token as path');
      });

      it('But a boolean flag like --test does NOT consume the next token', () => {
        // --test is a boolean flag, so the token after it is a genuine path
        for (const dir of ['unit', 'e2e']) {
          assert.ok(isDirectoryCovered('node --test tests', dir),
            '--test is a boolean flag and should not consume "tests"');
        }
      });

      it('And a boolean flag that is NOT on the allowlist does not consume the next token', () => {
        // --experimental-test-coverage is a boolean flag, not on the value-taking list
        // So the next token is a genuine path, not a flag value
        assert.ok(isDirectoryCovered('node --test --experimental-test-coverage tests/unit', 'unit'),
          'Boolean flag should not consume the following path');
        assert.ok(!isDirectoryCovered('node --test --experimental-test-coverage tests/unit', 'e2e'),
          'Explicit tests/unit should not cover e2e');
      });

      it('And an unknown flag with space-separated value is NOT treated as consuming the next token', () => {
        // A flag not on the allowlist followed by a path-like token should treat the token as a path
        // This prevents the regression of assuming all --flags consume the next token
        assert.ok(isDirectoryCovered('node --test --some-unknown-flag tests', 'unit'),
          'Unknown flag should not be assumed to consume "tests"');
        assert.ok(isDirectoryCovered('node --test --some-unknown-flag tests', 'e2e'),
          'Unknown flag + tests should cover all directories (AC 6)');
      });
    });

    describe('Scenario: The shared predicate is imported not duplicated', () => {
      it('Then both test files import isDirectoryCovered from script-coverage.mjs', () => {
        const e2eContent = fs.readFileSync(
          path.join(PROJECT_ROOT, 'tests', 'e2e', 'npm-scripts.test.js'),
          'utf-8'
        );
        const unitContent = fs.readFileSync(
          path.join(PROJECT_ROOT, 'tests', 'unit', 'npm-scripts-config.test.js'),
          'utf-8'
        );

        assert.ok(e2eContent.includes("from '../helpers/script-coverage.mjs'") ||
                  e2eContent.includes('from \'../helpers/script-coverage.mjs\''),
          'e2e test should import from script-coverage.mjs (AC 10)');
        assert.ok(unitContent.includes("from '../helpers/script-coverage.mjs'") ||
                  unitContent.includes('from \'../helpers/script-coverage.mjs\''),
          'unit test should import from script-coverage.mjs (AC 10)');

        // Both should import isDirectoryCovered and extractPathArguments from the shared file
        assert.ok(e2eContent.includes('isDirectoryCovered') &&
                  e2eContent.includes('scopeScriptToSingleFile'),
          'e2e test should import shared helpers');
        assert.ok(unitContent.includes('isDirectoryCovered') &&
                  unitContent.includes('extractPathArguments'),
          'unit test should import shared helpers');

        console.log('Shared predicate confirmed: both layers use same implementation (AC 10)');
      });
    });
  });
});
