import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractResourceBody, extractBlock } from '../helpers/hcl-blocks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const LAMBDA_DIR = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar');
const VERIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'verify-lambda-package-deps.mjs');

describe('Package Dependency Deployment (TASK-038) E2E Tests', () => {
  describe('Feature: The deployment package carries its runtime dependencies', () => {
    describe('Scenario: The manifest declares the required dependencies', () => {
      it('Given src/lambda/calendar/package.json, Then it declares @anthropic-ai/sdk and zod as dependencies', () => {
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8')
        );
        assert.ok(packageJson.dependencies, 'package.json has no dependencies block');
        assert.ok(packageJson.dependencies['@anthropic-ai/sdk'],
          '@anthropic-ai/sdk is not declared as a dependency');
        assert.ok(packageJson.dependencies['zod'],
          'zod is not declared as a dependency');
      });

      it('When package.json dependencies are declared, Then the two runtime-bundled @aws-sdk/* packages are NOT declared, and the two NOT bundled by the runtime ARE declared', () => {
        // TASK-038 rework (review cycle 1): nodejs20.x+ bundles ONLY
        // @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb and @aws-sdk/client-s3.
        // @aws-sdk/client-kms (backend/crypto.mjs) and @aws-sdk/client-scheduler
        // (backend/scan-schedule.mjs) are imported by src/ and are NOT part of
        // that bundled set, so they must be declared or every OAuth connect and
        // every scan breaks on first use.
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8')
        );
        assert.strictEqual(packageJson.dependencies['@aws-sdk/client-dynamodb'], undefined,
          '@aws-sdk/client-dynamodb should not be declared (runtime provides it)');
        assert.strictEqual(packageJson.dependencies['@aws-sdk/lib-dynamodb'], undefined,
          '@aws-sdk/lib-dynamodb should not be declared (runtime provides it)');
        assert.ok(packageJson.dependencies['@aws-sdk/client-kms'],
          '@aws-sdk/client-kms should be declared (not bundled by the runtime, used by backend/crypto.mjs)');
        assert.ok(packageJson.dependencies['@aws-sdk/client-scheduler'],
          '@aws-sdk/client-scheduler should be declared (not bundled by the runtime, used by backend/scan-schedule.mjs)');
      });
    });

    describe('Scenario: Package lock file exists', () => {
      it('Given src/lambda/calendar/, Then package-lock.json exists', () => {
        const lockPath = path.join(LAMBDA_DIR, 'package-lock.json');
        assert.ok(fs.existsSync(lockPath), 'package-lock.json does not exist');
      });

      it('When package-lock.json is read, Then it is valid JSON with a lockfileVersion', () => {
        const lockContent = fs.readFileSync(
          path.join(LAMBDA_DIR, 'package-lock.json'), 'utf-8'
        );
        const lock = JSON.parse(lockContent);
        assert.ok(lock.lockfileVersion !== undefined,
          'package-lock.json does not have a lockfileVersion field');
      });
    });

    describe('Scenario: Terraform wiring ensures npm install before archive', () => {
      it('Given terraform/lambda_calendar.tf, Then null_resource.calendar_lambda_npm_install exists', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        // null_resource is a resource type, so we can use extractResourceBody
        assert.ok(tfContent.includes('resource "null_resource" "calendar_lambda_npm_install"'),
          'null_resource.calendar_lambda_npm_install not found in terraform file');
      });

      it('When null_resource.calendar_lambda_npm_install is declared, Then it has triggers block', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('triggers = {'),
          'triggers block not found in null_resource');
      });

      it('When triggers block exists, Then it includes both package_lock_hash and package_json_hash', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('package_lock_hash'), 'package_lock_hash not in triggers');
        assert.ok(tfContent.includes('package_json_hash'), 'package_json_hash not in triggers');
      });

      it('When triggers are configured, Then both hashes use filesha256', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('filesha256'), 'filesha256 not used for hash triggers');
        assert.ok(tfContent.includes('filesha256') && tfContent.includes('package-lock.json'),
          'package-lock.json not hashed with filesha256');
        assert.ok(tfContent.includes('filesha256') && tfContent.includes('package.json'),
          'package.json not hashed with filesha256');
      });

      it('When null_resource has a provisioner, Then it runs npm ci --omit=dev', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('npm ci --omit=dev'),
          'provisioner does not run "npm ci --omit=dev"');
      });

      it('When the provisioner runs npm ci, Then it also runs the verify script', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('verify-lambda-package-deps.mjs'),
          'provisioner does not run verify-lambda-package-deps.mjs');
      });

      it('Given archive_file.calendar_lambda_zip, Then it depends_on null_resource.calendar_lambda_npm_install', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(tfContent.includes('data "archive_file" "calendar_lambda_zip"'),
          'archive_file data source not found');
        assert.ok(
          tfContent.includes('depends_on  = [null_resource.calendar_lambda_npm_install]'),
          'archive_file does not depend on null_resource.calendar_lambda_npm_install'
        );
      });
    });

    describe('Scenario: The manifest and terraform comment agree on AWS SDK bundling', () => {
      it('Given terraform/lambda_calendar.tf comment section, Then it says the nodejs24.x runtime provides the AWS SDK', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(
          tfContent.includes('AWS SDK v3 is provided by the nodejs24.x runtime'),
          'terraform comment does not mention that AWS SDK is provided by runtime'
        );
      });

      it('When the terraform comment mentions bundled AWS SDK, Then it should NOT contradict the package.json', () => {
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8')
        );
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );

        // TASK-038 rework (review cycle 1): the runtime bundles only
        // @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb among the packages
        // this Lambda's source imports (plus @aws-sdk/client-s3, which is
        // bundled but never imported here) - those two should not be declared.
        // @aws-sdk/client-kms and @aws-sdk/client-scheduler are NOT bundled, so
        // the manifest declaring them does not contradict the comment.
        if (tfContent.includes('provided by the nodejs24.x runtime')) {
          assert.strictEqual(packageJson.dependencies['@aws-sdk/client-dynamodb'], undefined,
            'package.json declares @aws-sdk/client-dynamodb but terraform says runtime provides it');
          assert.strictEqual(packageJson.dependencies['@aws-sdk/lib-dynamodb'], undefined,
            'package.json declares @aws-sdk/lib-dynamodb but terraform says runtime provides it');
          assert.ok(packageJson.dependencies['@aws-sdk/client-kms'],
            '@aws-sdk/client-kms is not bundled by the runtime and must be declared');
          assert.ok(packageJson.dependencies['@aws-sdk/client-scheduler'],
            '@aws-sdk/client-scheduler is not bundled by the runtime and must be declared');
        }
      });

      it('When TASK-038 decision is recorded, Then the terraform comment explains the @aws-sdk removal', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(
          tfContent.includes('TASK-038'),
          'TASK-038 decision not referenced in terraform comment'
        );
        assert.ok(
          tfContent.includes('REMOVED'),
          'terraform comment does not explain that @aws-sdk packages were removed'
        );
      });
    });

    describe('Scenario: A dependency-less package is refused loudly', () => {
      it('Given the verify script exists, When executed with no missing dependencies, Then it exits 0', () => {
        // Create a mock scenario with the actual node_modules present
        if (fs.existsSync(path.join(LAMBDA_DIR, 'node_modules'))) {
          const exitCode = execSync(`node "${VERIFY_SCRIPT}" "${LAMBDA_DIR}"`, {
            encoding: 'utf-8'
          }).trim();
          // The script logs but doesn't error if successful
          assert.ok(exitCode.includes('PASS'), 'verify script should log PASS when dependencies are present');
        }
      });

      it('When the verify script runs and dependencies are present, Then it logs a PASS message', () => {
        if (fs.existsSync(path.join(LAMBDA_DIR, 'node_modules'))) {
          const output = execSync(`node "${VERIFY_SCRIPT}" "${LAMBDA_DIR}"`, {
            encoding: 'utf-8'
          });
          assert.ok(output.includes('PASS'), 'Script output does not include PASS message');
        }
      });

      it('When the verify script runs with missing dependencies, Then it exits with non-zero and logs FAIL', () => {
        // Create a temporary test directory with a broken setup
        const testDir = path.join(PROJECT_ROOT, '.tmp-test-verify-broken-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        try {
          fs.mkdirSync(path.join(testDir, 'node_modules'), { recursive: true });
          fs.writeFileSync(
            path.join(testDir, 'package.json'),
            JSON.stringify({ dependencies: { 'missing-pkg': '1.0.0' } })
          );

          let exitCode = 0;
          let output = '';
          try {
            output = execSync(`node "${VERIFY_SCRIPT}" "${testDir}"`, {
              encoding: 'utf-8',
              stdio: 'pipe'
            });
          } catch (err) {
            exitCode = err.status;
            output = err.stdout || err.stderr || '';
          }

          assert.notStrictEqual(exitCode, 0, 'Script should exit non-zero when dependencies are missing');
          assert.ok(output.includes('FAIL'), 'Output should include FAIL message');
          assert.ok(output.includes('missing-pkg'), 'Output should name the missing package');
        } finally {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      });

      it('When a dependency is missing, Then the error message names it explicitly', () => {
        const testDir = path.join(PROJECT_ROOT, '.tmp-test-verify-named-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        try {
          fs.mkdirSync(path.join(testDir, 'node_modules'), { recursive: true });
          fs.writeFileSync(
            path.join(testDir, 'package.json'),
            JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '^1.0', 'zod': '^2.0' } })
          );

          let output = '';
          try {
            execSync(`node "${VERIFY_SCRIPT}" "${testDir}"`, {
              encoding: 'utf-8',
              stdio: 'pipe'
            });
          } catch (err) {
            output = err.stdout || err.stderr || '';
          }

          assert.ok(output.includes('@anthropic-ai/sdk'), 'Missing @anthropic-ai/sdk not named');
          assert.ok(output.includes('zod'), 'Missing zod not named');
        } finally {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      });
    });

    describe('Scenario: The provisioner chain fails loudly when verify script exits non-zero', () => {
      it('When npm ci succeeds but verify fails, Then the combined provisioner command fails', () => {
        // Create a temporary test directory to simulate the provisioner environment
        const testDir = path.join(PROJECT_ROOT, '.tmp-test-provisioner-chain-' + Date.now());
        const testLambdaDir = path.join(testDir, 'src', 'lambda', 'calendar');
        fs.mkdirSync(testLambdaDir, { recursive: true });

        try {
          // Write a minimal package.json
          fs.writeFileSync(
            path.join(testLambdaDir, 'package.json'),
            JSON.stringify({ dependencies: { 'this-package-does-not-exist-xyz': '1.0.0' } })
          );

          // Create node_modules but don't install the missing package
          fs.mkdirSync(path.join(testLambdaDir, 'node_modules'), { recursive: true });

          // Simulate the provisioner command: cd into the dir, run verify
          const command = `cd "${testLambdaDir}" && node "${VERIFY_SCRIPT}" "${testLambdaDir}"`;

          let exitCode = 0;
          try {
            execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
          } catch (err) {
            exitCode = err.status;
          }

          assert.notStrictEqual(exitCode, 0, 'Provisioner command should fail when verify script fails');
        } finally {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      });
    });

    describe('Scenario: The source tree is not left dirty by packaging', () => {
      it('Given src/lambda/calendar, Then it has .gitignore rules for node_modules', () => {
        const gitignorePath = path.join(LAMBDA_DIR, '.gitignore');
        // Check if a .gitignore exists at the project level that covers node_modules
        const gitignores = [
          gitignorePath,
          path.join(PROJECT_ROOT, '.gitignore')
        ];

        let hasNodeModulesIgnore = false;
        for (const gitignore of gitignores) {
          if (fs.existsSync(gitignore)) {
            const content = fs.readFileSync(gitignore, 'utf-8');
            if (content.includes('node_modules')) {
              hasNodeModulesIgnore = true;
              break;
            }
          }
        }
        assert.ok(hasNodeModulesIgnore, 'node_modules is not in any .gitignore');
      });

      it('When archive_file excludes, Then package-lock.json is excluded from the zip', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        // Data sources use "data" keyword, not "resource", so search for it in the content
        assert.ok(tfContent.includes('data "archive_file" "calendar_lambda_zip"'),
          'archive_file data source not found');
        assert.ok(tfContent.includes('"package-lock.json"'),
          'archive_file should exclude package-lock.json (it is committed but not needed in zip)');
      });

      it('When archive_file is built, Then it does not commit node_modules to git', () => {
        // Verify node_modules is in .gitignore
        const projectGitignorePath = path.join(PROJECT_ROOT, '.gitignore');
        const content = fs.readFileSync(projectGitignorePath, 'utf-8');
        assert.ok(content.includes('node_modules'), 'node_modules not in .gitignore - it would be committed');
      });
    });
  });
});
