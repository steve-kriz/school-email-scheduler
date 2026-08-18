import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      it('When checking the "test" script, Then it should invoke "node --test tests/unit tests/e2e"', () => {
        assert.ok(packageJson.scripts, 'package.json should have scripts section');
        assert.ok(packageJson.scripts.test, 'test script should exist');

        const testScript = packageJson.scripts.test;
        assert.strictEqual(testScript, 'node --test tests/unit tests/e2e',
          `test script should be exactly "node --test tests/unit tests/e2e". Got: "${testScript}"`);
      });

      it('And the script should mention both directories', () => {
        const testScript = packageJson.scripts.test;
        assert.ok(testScript.includes('tests/unit'), 'test script should include tests/unit');
        assert.ok(testScript.includes('tests/e2e'), 'test script should include tests/e2e');
      });
    });

    describe('Scenario: test:unit script runs only unit tests', () => {
      it('When checking the "test:unit" script, Then it should invoke "node --test tests/unit"', () => {
        assert.ok(packageJson.scripts['test:unit'], 'test:unit script should exist');

        const testUnitScript = packageJson.scripts['test:unit'];
        assert.strictEqual(testUnitScript, 'node --test tests/unit',
          `test:unit script should be exactly "node --test tests/unit". Got: "${testUnitScript}"`);
      });

      it('And the script should NOT include tests/e2e', () => {
        const testUnitScript = packageJson.scripts['test:unit'];
        assert.ok(!testUnitScript.includes('tests/e2e'),
          'test:unit script should not include tests/e2e');
      });
    });

    describe('Scenario: test:e2e script uses node:test instead of Playwright', () => {
      it('When checking the "test:e2e" script, Then it should use "node --test tests/e2e"', () => {
        assert.ok(packageJson.scripts['test:e2e'], 'test:e2e script should exist');

        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.strictEqual(testE2eScript, 'node --test tests/e2e',
          `test:e2e script should be exactly "node --test tests/e2e". Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference "playwright"', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('playwright'),
          `test:e2e script should not include "playwright". Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference "bddgen"', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('bddgen'),
          `test:e2e script should not include "bddgen". Got: "${testE2eScript}"`);
      });

      it('And it should NOT reference "pw"', () => {
        const testE2eScript = packageJson.scripts['test:e2e'];
        assert.ok(!testE2eScript.includes('pw'),
          `test:e2e script should not invoke playwright (pw). Got: "${testE2eScript}"`);
      });
    });

    describe('Scenario: test:unit:coverage script preserves original behavior', () => {
      it('When checking the "test:unit:coverage" script, Then it should use the experimental-test-coverage flag', () => {
        assert.ok(packageJson.scripts['test:unit:coverage'],
          'test:unit:coverage script should exist');

        const coverageScript = packageJson.scripts['test:unit:coverage'];
        assert.ok(coverageScript.includes('--experimental-test-coverage'),
          'test:unit:coverage script should include --experimental-test-coverage');
      });

      it('And it should only run tests/unit', () => {
        const coverageScript = packageJson.scripts['test:unit:coverage'];
        assert.ok(coverageScript.includes('tests/unit'),
          'test:unit:coverage script should include tests/unit');
        assert.ok(!coverageScript.includes('tests/e2e'),
          'test:unit:coverage script should not include tests/e2e');
      });
    });

    describe('Scenario: test:bdd script runs with node:test', () => {
      it('When checking the "test:bdd" script, Then it should be defined', () => {
        assert.ok(packageJson.scripts['test:bdd'],
          'test:bdd script should exist (required by existing test assertions)');
      });

      it('And it should invoke "node --test tests/bdd"', () => {
        const testBddScript = packageJson.scripts['test:bdd'];
        assert.strictEqual(testBddScript, 'node --test tests/bdd',
          `test:bdd script should be "node --test tests/bdd". Got: "${testBddScript}"`);
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
          // Should reference tests/ relative to where npm runs (project root)
          assert.ok(script.includes('tests/'),
            `Script "${scriptName}" should reference tests/ directory. Got: "${script}"`);
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
});
