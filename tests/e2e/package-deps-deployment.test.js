import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractResourceBody, extractBlock } from '../helpers/hcl-blocks.mjs';
import { findAwsSdkImports } from '../../scripts/verify-lambda-package-deps.mjs';

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

      it('When package.json dependencies are declared, Then every @aws-sdk/* package the source actually imports is declared', () => {
        // TASK-038 rework (review cycle 1). The decision recorded in
        // terraform/lambda_calendar.tf is that this Lambda SHIPS every
        // @aws-sdk/* package it imports rather than leaning on the managed
        // runtime's bundled subset, so "imported implies declared" with no
        // exemptions. The expected set is derived from the source tree rather
        // than hard-coded, so a NEW undeclared @aws-sdk import fails here too -
        // that is exactly how @aws-sdk/client-kms and @aws-sdk/client-scheduler
        // stayed undeclared across several tickets.
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8')
        );
        const imported = findAwsSdkImports({ lambdaDir: LAMBDA_DIR });

        // Guard the derivation itself: if the scan silently returned nothing,
        // the loop below would pass vacuously.
        for (const expected of [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/client-kms',
          '@aws-sdk/client-scheduler'
        ]) {
          assert.ok(imported.includes(expected),
            `the source scan did not find the known import ${expected} - the derivation is broken, not the manifest`);
        }

        for (const name of imported) {
          assert.ok(packageJson.dependencies[name],
            `${name} is imported under src/lambda/calendar but not declared in package.json`);
        }
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

    describe('Scenario: The install command runs where it thinks it does', () => {
      // TASK-038 rework (review cycle 1). The rejected version of the
      // provisioner did `cd <lambda dir> && node <relative script path>
      // <relative lambda dir>`. Terraform substituted all three fragments as
      // plain relative strings BEFORE the shell ran, so the two after the `cd`
      // resolved against the new working directory and pointed at directories
      // that do not exist - `node` died with `Cannot find module` on every
      // apply. `terraform validate` cannot see a path inside a command string,
      // and no test looked, so it shipped. These are the assertions that look.
      it('Given the local-exec provisioner, Then it takes its cwd from working_dir and never changes directory mid-command', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        const start = tfContent.indexOf('resource "null_resource" "calendar_lambda_npm_install"');
        assert.notStrictEqual(start, -1, 'null_resource.calendar_lambda_npm_install not found');
        const body = tfContent.slice(start);

        assert.match(body, /working_dir\s*=\s*local\.calendar_lambda_dir/,
          'the provisioner does not take its working directory from local.calendar_lambda_dir');

        const commandMatch = body.match(/command\s*=\s*"(.*)"/);
        assert.ok(commandMatch, 'no local-exec command found on the null_resource');
        assert.ok(
          !/(?:^|[\s&|;])cd\s/.test(commandMatch[1]),
          'the provisioner command contains a `cd`: any path after it is resolved against the NEW working directory, which is the defect this ticket was rejected for'
        );
      });

      it('Given the path locals the provisioner interpolates, Then each one resolves to something that exists on disk', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );

        // path.module is "." for this root module, so Terraform resolves
        // abspath("${path.module}/X") against the directory it runs in, i.e.
        // terraform/ - which is what path.resolve(TERRAFORM_DIR, X) does here.
        const resolved = {};
        const localRe = /(calendar_lambda_dir|calendar_deps_verifier)\s*=\s*abspath\("\$\{path\.module\}\/(.+?)"\)/g;
        for (const match of tfContent.matchAll(localRe)) {
          resolved[match[1]] = path.resolve(TERRAFORM_DIR, match[2]);
        }

        assert.deepStrictEqual(
          Object.keys(resolved).sort(),
          ['calendar_deps_verifier', 'calendar_lambda_dir'],
          'the provisioner path locals are no longer defined with abspath("${path.module}/...") - this assertion can no longer see them'
        );

        for (const [name, target] of Object.entries(resolved)) {
          assert.ok(fs.existsSync(target),
            `local.${name} resolves to ${target}, which does not exist - terraform apply would fail here`);
        }
      });

      it('Given the provisioner command, Then it passes the verifier the lambda directory as an absolute local, not a relative fragment', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        const commandMatch = tfContent.match(/command\s*=\s*"(npm ci.*)"/);
        assert.ok(commandMatch, 'the npm ci provisioner command was not found');
        const command = commandMatch[1];

        assert.ok(command.includes('${local.calendar_deps_verifier}'),
          'the command does not invoke the verifier through local.calendar_deps_verifier');
        assert.ok(command.includes('${local.calendar_lambda_dir}'),
          'the command does not pass local.calendar_lambda_dir as the verifier argument');
        assert.ok(!command.includes('${path.module}'),
          'the command still interpolates ${path.module} directly, which yields a relative path the shell re-resolves');
      });

      it('Given the triggers block, Then the install and its guard are forced to run on every apply, not only when a hash changed', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        // Hash-only triggers compare against what the LAST host to apply
        // recorded in the shared remote state, not against whether THIS host
        // has a node_modules - so a second machine or a fresh CI runner skips
        // the install AND the guard, and archive_file happily zips a directory
        // with no dependencies in it.
        assert.match(tfContent, /always_run\s*=\s*timestamp\(\)/,
          'the null_resource has no unconditional trigger, so the guard can be skipped entirely on a host that has never applied');
      });
    });

    describe('Scenario: The manifest and terraform comment agree on AWS SDK bundling', () => {
      it('Given terraform/lambda_calendar.tf, Then it records the TASK-038 @aws-sdk decision and no longer claims the runtime supplies the SDK', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(
          tfContent.includes('@aws-sdk/* DECISION (TASK-038'),
          'terraform does not record the TASK-038 @aws-sdk decision'
        );
        assert.ok(
          tfContent.includes('The zip SHIPS every @aws-sdk/* package this Lambda'),
          'terraform decision comment does not state that the zip ships every imported @aws-sdk package'
        );
        assert.ok(
          !tfContent.includes('AWS SDK v3 is provided by the nodejs24.x runtime'),
          'terraform still claims the runtime provides the AWS SDK, which contradicts a manifest that declares @aws-sdk packages'
        );
      });

      it('When package.json declares @aws-sdk packages, Then the terraform comment names every one of them as shipped rather than runtime-provided', () => {
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8')
        );
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );

        // TASK-038 rework (review cycle 1): the recorded decision is that this
        // Lambda ships every @aws-sdk/* package its source imports instead of
        // relying on the managed runtime's bundled subset. The manifest and
        // the terraform therefore agree only if each declared package is named
        // in the decision comment.
        const declared = Object.keys(packageJson.dependencies)
          .filter((name) => name.startsWith('@aws-sdk/'));

        assert.ok(declared.length > 0, 'package.json declares no @aws-sdk packages at all');

        for (const name of declared) {
          assert.ok(
            tfContent.includes(name),
            `package.json declares ${name} but the terraform decision comment never mentions it`
          );
        }
      });

      it('When the decision is recorded, Then the terraform states the reason and the measured cost', () => {
        const tfContent = fs.readFileSync(
          path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8'
        );
        assert.ok(
          tfContent.includes('TASK-038'),
          'TASK-038 decision not referenced in terraform comment'
        );
        assert.ok(
          /250MB unzipped limit/.test(tfContent),
          'terraform decision comment does not weigh the zip size against the Lambda unzipped limit'
        );
        assert.ok(
          /ESM/.test(tfContent) && /NODE_PATH/.test(tfContent),
          'terraform decision comment does not give the ESM/NODE_PATH reason for not relying on the runtime copy'
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
