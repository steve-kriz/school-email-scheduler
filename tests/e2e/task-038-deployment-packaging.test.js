/**
 * TASK-038 e2e — Feature: The deployment package carries its runtime
 * dependencies.
 *
 * These are the ticket's Gherkin scenarios, written Given/When/Then as
 * `node --test` cases. They deliberately EXECUTE things rather than pattern
 * matching the source that declares them:
 *   - the verifier is spawned as a real child process, against real and
 *     against deliberately broken directories;
 *   - the provisioner command is taken from terraform/lambda_calendar.tf,
 *     its `${local.*}` references are resolved the way terraform resolves
 *     them, and the resulting command is RUN;
 *   - the rejected `cd`-then-relative-path shape is run too, as a regression
 *     witness, and must still fail.
 *
 * No database is touched anywhere in this file - there is no DB in the
 * packaging path - and nothing here reaches the network: the one `npm ci`
 * case fails on npm's local lockfile-sync check before any fetch.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findAwsSdkImports } from '../../scripts/verify-lambda-package-deps.mjs';
import {
  resolvePathLocals,
  interpolateCommand,
  commandChangesDirectory,
  splitAndChain,
  archiveIncludes,
  parseArchiveExcludes
} from '../helpers/tf-path-locals.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const LAMBDA_DIR = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar');
const NODE_MODULES = path.join(LAMBDA_DIR, 'node_modules');
const VERIFY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'verify-lambda-package-deps.mjs');
const TF_PATH = path.join(TERRAFORM_DIR, 'lambda_calendar.tf');

const tf = fs.readFileSync(TF_PATH, 'utf-8');
const manifest = JSON.parse(fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8'));

/** Run node with `args`, returning exit status and combined output. */
function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf-8', ...options });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`
  };
}

/** Make a throwaway directory and remove it afterwards. */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task038-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The provisioner command as terraform would hand it to the shell. */
function interpolatedProvisionerCommand() {
  const { resolved } = resolvePathLocals(tf, TERRAFORM_DIR);
  const match = tf.match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(match, 'no local-exec `command = "..."` found in terraform/lambda_calendar.tf');
  // HCL escapes the inner quotes; unescape them to get the shell's view.
  const raw = match[1].replace(/\\"/g, '"');
  return { command: interpolateCommand(raw, resolved), locals: resolved };
}

describe('Feature: The deployment package carries its runtime dependencies (TASK-038)', () => {

  describe('Scenario: The archive contains the Anthropic SDK', () => {
    const REQUIRED = ['@anthropic-ai/sdk', 'zod'];

    it('Given the packaging step has run, When the archive contents are computed from archive_file\'s own source_dir and excludes, Then @anthropic-ai/sdk and zod are present', (t) => {
      if (!fs.existsSync(NODE_MODULES)) {
        t.skip(`${NODE_MODULES} is absent, so there is no installed tree to inspect - run npm ci in src/lambda/calendar (the terraform provisioner does this) and re-run`);
        return;
      }

      const sourceDir = tf.match(/source_dir\s*=\s*"([^"]+)"/);
      assert.ok(sourceDir, 'archive_file has no source_dir');
      assert.strictEqual(
        path.resolve(TERRAFORM_DIR, sourceDir[1]),
        LAMBDA_DIR,
        'archive_file.source_dir does not point at src/lambda/calendar, so this scenario is inspecting the wrong tree'
      );

      const excludes = parseArchiveExcludes(tf, 'calendar_lambda_zip');

      for (const name of REQUIRED) {
        const relPath = `node_modules/${name}/package.json`;
        assert.ok(
          fs.existsSync(path.join(LAMBDA_DIR, ...relPath.split('/'))),
          `${relPath} is not on disk under the archive's source_dir, so the zip cannot contain ${name}`
        );
        assert.strictEqual(
          archiveIncludes(relPath, excludes),
          true,
          `${relPath} exists but archive_file.excludes (${excludes.join(', ')}) would drop it from the zip`
        );
      }
    });

    it('Given the same excludes filter, When it is applied to an excluded path, Then that path is dropped - so the inclusion above is a real decision, not a filter that passes everything', () => {
      const excludes = parseArchiveExcludes(tf, 'calendar_lambda_zip');
      assert.ok(excludes.length > 0, 'archive_file declares no excludes, so the filter above could not discriminate');
      assert.strictEqual(archiveIncludes('package-lock.json', excludes), false,
        'package-lock.json is meant to be excluded from the zip but the filter kept it');
      assert.strictEqual(archiveIncludes('node_modules/zod/package.json', excludes), true,
        'the excludes filter drops an installed dependency');
    });

    it('Given every @aws-sdk package the source imports, When the installed tree is inspected, Then each one is present to be zipped', (t) => {
      if (!fs.existsSync(NODE_MODULES)) {
        t.skip(`${NODE_MODULES} is absent - nothing installed to inspect`);
        return;
      }
      const imported = findAwsSdkImports({ lambdaDir: LAMBDA_DIR });
      assert.ok(imported.length >= 4,
        `the source scan found only ${imported.length} @aws-sdk import(s) (${imported.join(', ')}) - the derivation is broken, not the install`);
      for (const name of imported) {
        assert.ok(fs.existsSync(path.join(NODE_MODULES, ...name.split('/'))),
          `${name} is imported by src/lambda/calendar but is not installed under node_modules, so the zip would ship without it`);
      }
    });

    it('Given the archive_file data source, When its ordering is read, Then it depends on the install resource so the zip cannot be built first', () => {
      const start = tf.indexOf('data "archive_file" "calendar_lambda_zip"');
      assert.notStrictEqual(start, -1, 'data "archive_file" "calendar_lambda_zip" not found');
      const body = tf.slice(start, tf.indexOf('\n}', start));
      assert.match(
        body,
        /depends_on\s*=\s*\[\s*null_resource\.calendar_lambda_npm_install\s*\]/,
        'archive_file.calendar_lambda_zip does not depend_on null_resource.calendar_lambda_npm_install, so terraform may zip before the install runs'
      );
    });
  });

  describe('Scenario: A dependency-less package is refused', () => {
    it('Given node_modules is absent, When packaging runs, Then it fails with a message naming the missing dependencies', () => {
      withTempDir((dir) => {
        // The REAL manifest, so the names asserted below are the real ones.
        fs.copyFileSync(path.join(LAMBDA_DIR, 'package.json'), path.join(dir, 'package.json'));

        const { status, output } = runNode([VERIFY_SCRIPT, dir]);

        assert.strictEqual(status, 1,
          `expected the packaging guard to exit 1 with no node_modules, got ${status}: ${output}`);
        assert.match(output, /FAIL/, `guard did not report FAIL: ${output}`);
        for (const name of Object.keys(manifest.dependencies)) {
          assert.ok(output.includes(name),
            `the failure message does not name the missing dependency ${name}: ${output}`);
        }
        assert.match(output, /refusing to package/,
          `the guard did not say it was refusing to package: ${output}`);
      });
    });

    it('Given node_modules exists but one dependency did not land, When packaging runs, Then it names exactly that one and not the installed ones', () => {
      withTempDir((dir) => {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
          dependencies: { '@anthropic-ai/sdk': '^0.117.1', zod: '^4.4.3' }
        }));
        fs.mkdirSync(path.join(dir, 'node_modules', 'zod'), { recursive: true });

        const { status, output } = runNode([VERIFY_SCRIPT, dir]);

        assert.strictEqual(status, 1, `expected exit 1 for a partial install, got ${status}: ${output}`);
        const failLine = output.split('\n').find((l) => l.includes('missing from'));
        assert.ok(failLine, `no "missing from" line in the output: ${output}`);
        assert.ok(failLine.includes('@anthropic-ai/sdk'),
          `the missing package was not named: ${failLine}`);
        assert.ok(!failLine.includes('zod'),
          `zod is installed but was reported missing: ${failLine}`);
      });
    });

    it('Given source imports an @aws-sdk package the manifest does not declare, When packaging runs, Then it refuses and names that package', () => {
      withTempDir((dir) => {
        // The mirror-image gap: an import with no declaration. @aws-sdk/client-dynamodb
        // is used on purpose - it is one of the packages the DELETED
        // runtime-bundled allowlist used to exempt.
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
          dependencies: { zod: '^4.4.3' }
        }));
        fs.mkdirSync(path.join(dir, 'node_modules', 'zod'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'connections.mjs'),
          'const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");\n'
        );

        const { status, output } = runNode([VERIFY_SCRIPT, dir]);

        assert.strictEqual(status, 1, `expected exit 1 for an undeclared import, got ${status}: ${output}`);
        assert.match(output, /not declared in/, `guard did not report the undeclared import: ${output}`);
        assert.ok(output.includes('@aws-sdk/client-dynamodb'),
          `the undeclared import was not named: ${output}`);
      });
    });

    it('Given a fully installed directory, When packaging runs, Then it exits 0 and lists every declared dependency - so the failures above are not the only outcome it can produce', (t) => {
      if (!fs.existsSync(NODE_MODULES)) {
        t.skip(`${NODE_MODULES} is absent - the success path cannot be exercised`);
        return;
      }
      const { status, output } = runNode([VERIFY_SCRIPT, LAMBDA_DIR]);
      assert.strictEqual(status, 0, `expected the guard to pass on the real tree, got ${status}: ${output}`);
      assert.match(output, /PASS/, `guard did not report PASS: ${output}`);
      for (const name of Object.keys(manifest.dependencies)) {
        assert.ok(output.includes(name), `PASS line does not list ${name}: ${output}`);
      }
    });
  });

  describe('Scenario: The install command runs where it thinks it does', () => {
    it('Given the provisioner, When its command is read, Then it takes its directory from working_dir and never changes directory mid-command', () => {
      const start = tf.indexOf('resource "null_resource" "calendar_lambda_npm_install"');
      assert.notStrictEqual(start, -1, 'null_resource.calendar_lambda_npm_install not found');
      const body = tf.slice(start);

      assert.match(body, /working_dir\s*=\s*local\.calendar_lambda_dir/,
        'the provisioner does not take its working directory from local.calendar_lambda_dir');

      const { command } = interpolatedProvisionerCommand();
      assert.strictEqual(commandChangesDirectory(command), false,
        `the provisioner command changes directory part-way through, which re-resolves every later relative path: ${command}`);
    });

    it('Given the command terraform would hand the shell, When its steps are resolved, Then every path in it is absolute and exists', () => {
      const { command, locals } = interpolatedProvisionerCommand();
      const steps = splitAndChain(command);

      assert.strictEqual(steps.length, 2,
        `expected an "npm ci && verify" two-step chain, got ${steps.length}: ${command}`);
      assert.match(steps[0], /^npm ci\b/, `the first step is not npm ci: ${steps[0]}`);
      assert.match(steps[0], /--omit=dev/, `npm ci does not omit devDependencies: ${steps[0]}`);

      for (const name of ['calendar_lambda_dir', 'calendar_deps_verifier']) {
        assert.ok(locals[name], `local.${name} could not be resolved from the locals block`);
        assert.ok(path.isAbsolute(locals[name]), `local.${name} is not absolute: ${locals[name]}`);
        assert.ok(fs.existsSync(locals[name]),
          `local.${name} resolves to ${locals[name]}, which does not exist - terraform apply would die here`);
      }

      assert.ok(steps[1].includes(locals.calendar_deps_verifier),
        `the verify step does not invoke the resolved verifier path: ${steps[1]}`);
      assert.ok(steps[1].includes(locals.calendar_lambda_dir),
        `the verify step does not pass the resolved lambda directory: ${steps[1]}`);
    });

    it('Given the resolved verify step, When it is EXECUTED in the provisioner\'s working_dir, Then it succeeds', (t) => {
      if (!fs.existsSync(NODE_MODULES)) {
        t.skip(`${NODE_MODULES} is absent - npm ci would have to run first`);
        return;
      }
      const { locals } = interpolatedProvisionerCommand();
      const { status, output } = runNode(
        [locals.calendar_deps_verifier, locals.calendar_lambda_dir],
        { cwd: locals.calendar_lambda_dir }
      );
      assert.strictEqual(status, 0,
        `the provisioner's verify step failed when actually run from working_dir: exit ${status}: ${output}`);
      assert.match(output, /PASS/, `verify step produced no PASS: ${output}`);
    });

    it('Given the REJECTED cd-then-relative-path shape, When it is EXECUTED, Then it still fails to find the script - which is why the command must not contain relative fragments', () => {
      // Regression witness for the finding this ticket was rejected on. After
      // `cd <lambda dir>`, the interpolated fragment `./../scripts/verify-...`
      // resolves against the LAMBDA directory, i.e. src/lambda/scripts/...
      const postCdScriptPath = path.resolve(LAMBDA_DIR, '../scripts/verify-lambda-package-deps.mjs');
      assert.ok(!fs.existsSync(postCdScriptPath),
        `${postCdScriptPath} unexpectedly exists, so this witness no longer reproduces the rejected failure`);

      const { status, output } = runNode([postCdScriptPath, LAMBDA_DIR], { cwd: LAMBDA_DIR });
      assert.notStrictEqual(status, 0, `the rejected shape unexpectedly succeeded: ${output}`);
      assert.match(output, /Cannot find module|ERR_MODULE_NOT_FOUND/,
        `the rejected shape failed for some other reason than the missing module: ${output}`);
    });

    it('Given the locals block, When it is read, Then the paths are declared once with abspath and the command interpolates no non-local reference', () => {
      const { resolved, unresolved } = resolvePathLocals(tf, TERRAFORM_DIR);
      assert.deepStrictEqual(unresolved, {},
        `some path locals are not absolute-resolvable: ${JSON.stringify(unresolved)}`);
      assert.deepStrictEqual(
        Object.keys(resolved).sort(),
        ['calendar_deps_verifier', 'calendar_lambda_dir', 'calendar_lambda_package_json', 'calendar_lambda_package_lock'],
        'the four packaging path locals are no longer all defined in one locals block'
      );
      // interpolateCommand throws if a ${path.module} survives into the command.
      assert.doesNotThrow(() => interpolatedProvisionerCommand());
    });

    it('Given a wrong path, When terraform plans, Then a precondition names it - the failure mode terraform validate cannot reach', () => {
      const start = tf.indexOf('resource "null_resource" "calendar_lambda_npm_install"');
      const body = tf.slice(start);
      const preconditions = body.match(/precondition\s*\{[\s\S]*?\}/g) || [];
      assert.strictEqual(preconditions.length, 2,
        `expected 2 fileexists preconditions on the install resource, found ${preconditions.length}`);
      assert.ok(
        preconditions.some((p) => /fileexists\(local\.calendar_lambda_package_lock\)/.test(p)),
        'no precondition checks that the committed lockfile exists'
      );
      assert.ok(
        preconditions.some((p) => /fileexists\(local\.calendar_deps_verifier\)/.test(p)),
        'no precondition checks that the packaging guard script exists'
      );
      for (const p of preconditions) {
        assert.match(p, /error_message\s*=\s*"[^"]{40,}"/,
          `a precondition has no substantive error_message: ${p}`);
      }
    });
  });

  describe('Scenario: The install is manifest-triggered', () => {
    it('Given package.json changes, When terraform plans, Then the trigger value changes because it is a hash of that file', () => {
      const start = tf.indexOf('resource "null_resource" "calendar_lambda_npm_install"');
      const body = tf.slice(start, tf.indexOf('provisioner', start));

      assert.match(body, /package_json_hash\s*=\s*filesha256\(local\.calendar_lambda_package_json\)/,
        'the package.json trigger is not a filesha256 of local.calendar_lambda_package_json');
      assert.match(body, /filesha256\(local\.calendar_lambda_package_lock\)/,
        'the package-lock.json trigger is not a filesha256 of local.calendar_lambda_package_lock');

      // Demonstrate the property the trigger relies on, on the real file.
      const { resolved } = resolvePathLocals(tf, TERRAFORM_DIR);
      const original = fs.readFileSync(resolved.calendar_lambda_package_json);
      const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
      const mutated = Buffer.from(
        original.toString('utf-8').replace('"zod":', '"zod-renamed":')
      );
      assert.notStrictEqual(mutated.toString(), original.toString(),
        'the manifest mutation did not apply, so the hash comparison below would be vacuous');
      assert.notStrictEqual(sha(original), sha(mutated),
        'a changed manifest produced the same filesha256, so the trigger could not fire');
    });

    it('Given a host that has never applied, When terraform plans, Then the install and its guard still run rather than being skipped by matching hashes', () => {
      const start = tf.indexOf('resource "null_resource" "calendar_lambda_npm_install"');
      const body = tf.slice(start, tf.indexOf('provisioner', start));
      assert.match(body, /always_run\s*=\s*timestamp\(\)/,
        'the install resource has only hash triggers, so a second host or a fresh CI runner - whose hashes already match the shared remote state - skips the install AND the guard, and archive_file zips a directory with no node_modules');
    });

    it('Given the trigger paths, When they are resolved, Then both manifests really exist at those paths', () => {
      const { resolved } = resolvePathLocals(tf, TERRAFORM_DIR);
      for (const name of ['calendar_lambda_package_json', 'calendar_lambda_package_lock']) {
        assert.ok(fs.existsSync(resolved[name]),
          `local.${name} resolves to ${resolved[name]}, which does not exist - filesha256 would hard-error at plan time`);
      }
    });
  });

  describe('Scenario: The lockfile is committed and in sync with the manifest', () => {
    it('Given the checkout, When package-lock.json is read, Then it is a v3 lockfile tracked by git', () => {
      const lockPath = path.join(LAMBDA_DIR, 'package-lock.json');
      assert.ok(fs.existsSync(lockPath), 'src/lambda/calendar/package-lock.json is missing - npm ci cannot run');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      assert.ok(lock.lockfileVersion >= 3, `unexpected lockfileVersion ${lock.lockfileVersion}`);

      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'src/lambda/calendar/package-lock.json'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8'
      });
      assert.strictEqual(tracked.status, 0,
        `package-lock.json is not tracked by git, so a fresh checkout has no lockfile and filesha256 hard-errors at plan: ${tracked.stderr}`);
    });

    it('Given the manifest, When it is compared with the lockfile, Then every declared dependency is locked', () => {
      const lock = JSON.parse(fs.readFileSync(path.join(LAMBDA_DIR, 'package-lock.json'), 'utf-8'));
      const rootDeps = lock.packages[''].dependencies || {};
      const declared = Object.keys(manifest.dependencies);
      assert.ok(declared.length >= 6, `expected at least 6 declared dependencies, found ${declared.length}`);

      for (const name of declared) {
        assert.strictEqual(rootDeps[name], manifest.dependencies[name],
          `${name} is declared as ${manifest.dependencies[name]} but the lockfile root records ${rootDeps[name]}`);
        assert.ok(lock.packages[`node_modules/${name}`],
          `${name} has no resolved entry in the lockfile, so npm ci would not install it`);
      }
    });

    it('Given the manifest and lockfile drift apart, When npm ci runs, Then it fails and the chain never reaches the guard or the archive', (t) => {
      const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8', shell: true });
      if (npm.status !== 0) {
        t.skip('npm is not available on PATH, so the provisioner chain cannot be exercised here');
        return;
      }

      withTempDir((dir) => {
        const drifted = JSON.parse(fs.readFileSync(path.join(LAMBDA_DIR, 'package.json'), 'utf-8'));
        drifted.dependencies['left-pad'] = '^1.3.0';
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(drifted, null, 2));
        fs.copyFileSync(path.join(LAMBDA_DIR, 'package-lock.json'), path.join(dir, 'package-lock.json'));

        const result = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
          cwd: dir, encoding: 'utf-8', shell: true, timeout: 120000
        });
        const output = `${result.stdout || ''}${result.stderr || ''}`;

        assert.notStrictEqual(result.status, 0,
          `npm ci accepted a manifest that the lockfile does not cover: ${output}`);
        assert.match(output, /in sync/,
          `npm ci failed for some reason other than lockfile drift: ${output}`);
        assert.match(output, /left-pad/, `the drift failure does not name the offending package: ${output}`);

        // `&&` chaining is what makes that abort the whole provisioner.
        const { command } = interpolatedProvisionerCommand();
        const steps = splitAndChain(command);
        assert.ok(command.includes('&&'),
          `the provisioner does not chain with &&, so a failed npm ci would not stop the verify step: ${command}`);
        assert.match(steps[0], /^npm ci\b/,
          `npm ci is not the first step, so the guard could run against a stale install: ${steps[0]}`);
      });
    });
  });

  describe('Scenario: The manifest and the terraform comment agree', () => {
    it('Given both files, Then the set of @aws-sdk packages the source imports is exactly the set the manifest declares', () => {
      const imported = findAwsSdkImports({ lambdaDir: LAMBDA_DIR });
      const declared = Object.keys(manifest.dependencies).filter((n) => n.startsWith('@aws-sdk/'));

      assert.deepStrictEqual(
        imported.slice().sort(),
        declared.slice().sort(),
        'the @aws-sdk packages imported by src/lambda/calendar and those declared in its package.json differ'
      );
      assert.deepStrictEqual(
        imported.slice().sort(),
        ['@aws-sdk/client-dynamodb', '@aws-sdk/client-kms', '@aws-sdk/client-scheduler', '@aws-sdk/lib-dynamodb'],
        'the imported @aws-sdk set is not the four packages the recorded decision is about'
      );
    });

    it('Given a declared package, Then the terraform decision comment names it as shipped rather than runtime-provided', () => {
      const declared = Object.keys(manifest.dependencies).filter((n) => n.startsWith('@aws-sdk/'));
      assert.ok(declared.length > 0, 'the manifest declares no @aws-sdk packages, so there is nothing to agree about');
      assert.match(tf, /@aws-sdk\/\* DECISION \(TASK-038/,
        'terraform records no TASK-038 @aws-sdk decision');
      for (const name of declared) {
        assert.ok(tf.includes(name),
          `package.json declares ${name} but the terraform decision comment never mentions it`);
      }
    });

    it('Given the terraform, Then no sentence claims a package the manifest declares is supplied by the runtime', () => {
      /**
       * A contradiction is a sentence that both names a declared package (or
       * the SDK generically) and asserts the runtime supplies it / it need not
       * ship. Discussing what a runtime bundles - which the decision does, as
       * its reasoning - is not a contradiction.
       */
      const CLAIM = /(provided by the [a-z0-9.]+ runtime|already provides|do(?:es)? not need to be shipped|no need to ship|so they do not need)/i;
      const findContradictions = (text) => text
        .split(/(?<=\.)\s+/)
        .filter((sentence) => CLAIM.test(sentence));

      // Positive control: the detector must fire on the sentence this ticket
      // was written to remove, otherwise a green result below means nothing.
      const control = 'AWS SDK v3 is provided by the nodejs24.x runtime, so they do not need to be shipped.';
      assert.strictEqual(findContradictions(control).length, 1,
        'the contradiction detector does not fire on the known-bad sentence, so it cannot be trusted on the real file');

      const found = findContradictions(tf);
      assert.deepStrictEqual(found, [],
        `terraform/lambda_calendar.tf still claims the runtime supplies an SDK the manifest declares: ${found.join(' || ')}`);
    });

    it('Given package.json, Then it records the same decision and points at where the reason is written down', () => {
      assert.ok(typeof manifest['//'] === 'string' && manifest['//'].length > 0,
        'package.json records no note about the @aws-sdk decision');
      assert.match(manifest['//'], /TASK-038/, 'the manifest note does not cite the ticket');
      assert.match(manifest['//'], /terraform\/lambda_calendar\.tf/,
        'the manifest note does not point at the terraform where the decision is recorded');
      assert.match(manifest['//'], /SHIPPED|ship/,
        'the manifest note does not state that the @aws-sdk packages are shipped in the zip');
    });

    it('Given the recorded decision, Then it states a reason and weighs the cost rather than just asserting a choice', () => {
      assert.match(tf, /NODE_PATH/, 'the decision does not give the ESM/NODE_PATH resolution reason');
      assert.match(tf, /250MB/, 'the decision does not weigh the zip against the unzipped Lambda limit');
      assert.match(tf, /17\.7MB|20\.3MB/, 'the decision quotes no measured size for what it ships');
    });

    it('Given the guard script, Then it has no runtime-bundled exemption list that could drift out of date', () => {
      const script = fs.readFileSync(VERIFY_SCRIPT, 'utf-8');
      const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(code, /RUNTIME_BUNDLED_AWS_SDK_PACKAGES\s*=/,
        'the runtime-bundled allowlist is back in the guard, which contradicts the recorded decision to ship every imported @aws-sdk package');
    });
  });

  describe('Scenario: The source tree is not left dirty by packaging', () => {
    it('Given the installed dependencies, When git is asked, Then node_modules is ignored', () => {
      const result = spawnSync('git', ['check-ignore', '--', 'src/lambda/calendar/node_modules'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8'
      });
      assert.strictEqual(result.status, 0,
        `git does not ignore src/lambda/calendar/node_modules, so the packaging step dirties the tree: ${result.stdout}${result.stderr}`);
    });

    it('Given a clean lambda directory, When the packaging guard runs over it, Then git reports nothing new', () => {
      const statusOf = () => spawnSync('git', ['status', '--porcelain', '--', 'src/lambda/calendar'], {
        cwd: PROJECT_ROOT, encoding: 'utf-8'
      }).stdout;

      const before = statusOf();
      runNode([VERIFY_SCRIPT, LAMBDA_DIR]);
      assert.strictEqual(statusOf(), before,
        'running the packaging guard changed the working tree under src/lambda/calendar');
    });
  });
});
