/**
 * TASK-038 unit tests — the two halves of the packaging guard.
 *
 * 1. `scripts/verify-lambda-package-deps.mjs`'s `@aws-sdk` scanner and the
 *    "imported implies declared" rule. The review-cycle-1 rework DELETED the
 *    RUNTIME_BUNDLED_AWS_SDK_PACKAGES allowlist, so packages that used to be
 *    exempt (client-dynamodb, lib-dynamodb) must now be reported when they are
 *    imported without a declaration. Nothing covered these functions before.
 *
 * 2. `tests/helpers/tf-path-locals.mjs`, the resolver the e2e scenarios use to
 *    turn the provisioner's HCL into the command a shell really receives -
 *    which is how those scenarios EXECUTE the command instead of pattern
 *    matching the file that declares it.
 *
 * No database, network or filesystem-of-record access: every case below is
 * driven by injected readers and in-memory fixtures.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';

import {
  findAwsSdkImports,
  findUndeclaredAwsSdkImports,
  run
} from '../../scripts/verify-lambda-package-deps.mjs';

import {
  parseLocalsBlock,
  resolvePathLocals,
  interpolateCommand,
  commandChangesDirectory,
  splitAndChain,
  archiveIncludes,
  parseArchiveExcludes
} from '../helpers/tf-path-locals.mjs';

/**
 * Build a fake `readdirSync(dir, { withFileTypes: true })` over a plain
 * object tree, so the scanner can be driven without touching disk.
 * @param {object} tree Nested object; string values are file contents.
 */
function fakeFs(tree) {
  const lookup = (dir) => {
    const parts = dir.split(/[\\/]/).filter((p) => p && p !== '.');
    let node = tree;
    for (const part of parts) {
      if (!node || typeof node !== 'object' || !(part in node)) {
        throw new Error(`ENOENT: ${dir}`);
      }
      node = node[part];
    }
    return node;
  };

  return {
    readDir(dir) {
      const node = lookup(dir);
      if (typeof node !== 'object') throw new Error(`ENOTDIR: ${dir}`);
      return Object.entries(node).map(([name, value]) => ({
        name,
        isDirectory: () => typeof value === 'object'
      }));
    },
    readFile(filePath) {
      const node = lookup(filePath);
      if (typeof node !== 'string') throw new Error(`EISDIR: ${filePath}`);
      return node;
    }
  };
}

describe('TASK-038 unit: packaging guard', () => {
  describe('Feature: scanning source for @aws-sdk imports', () => {
    it('Given a dynamic import(), When the tree is scanned, Then the package is found', () => {
      const io = fakeFs({
        backend: {
          'crypto.mjs': 'const { KMSClient } = await import("@aws-sdk/client-kms");'
        }
      });
      assert.deepStrictEqual(
        findAwsSdkImports({ lambdaDir: '.', ...io }),
        ['@aws-sdk/client-kms']
      );
    });

    it('Given static, dynamic and require forms, When the tree is scanned, Then all three are found and de-duplicated', () => {
      const io = fakeFs({
        'a.mjs': 'import { X } from "@aws-sdk/client-dynamodb";',
        'b.mjs': 'await import(\'@aws-sdk/lib-dynamodb\');\nawait import("@aws-sdk/client-dynamodb");',
        'c.cjs': 'const s = require("@aws-sdk/client-scheduler");'
      });
      assert.deepStrictEqual(
        findAwsSdkImports({ lambdaDir: '.', ...io }),
        ['@aws-sdk/client-dynamodb', '@aws-sdk/client-scheduler', '@aws-sdk/lib-dynamodb']
      );
    });

    it('Given an import that only exists under node_modules, When the tree is scanned, Then it is NOT reported as a source import', () => {
      const io = fakeFs({
        'index.mjs': 'export const x = 1;',
        node_modules: {
          // `from`-form on purpose. A bare side-effect `import "pkg";` is not
          // matched by the scanner's regex at all, so a fixture using that
          // shape would pass this test even if the directory were walked -
          // i.e. for the wrong reason. These two must be findable, so that a
          // green result here can only mean the DIRECTORY was skipped.
          'dep.mjs': 'import { SQS } from "@aws-sdk/client-sqs";'
        },
        __test_shims__: {
          'shim.mjs': 'import { SNS } from "@aws-sdk/client-sns";'
        }
      });
      assert.deepStrictEqual(findAwsSdkImports({ lambdaDir: '.', ...io }), []);
    });

    it('Given a non-source file mentioning a package, When the tree is scanned, Then it is ignored', () => {
      const io = fakeFs({
        'README.md': 'we use `import "@aws-sdk/client-kms"` here',
        'notes.txt': 'import "@aws-sdk/client-s3";'
      });
      assert.deepStrictEqual(findAwsSdkImports({ lambdaDir: '.', ...io }), []);
    });

    it('Given an unreadable directory, When the tree is scanned, Then it degrades to empty rather than throwing', () => {
      const result = findAwsSdkImports({
        lambdaDir: '.',
        readDir: () => { throw new Error('EACCES'); },
        readFile: () => ''
      });
      assert.deepStrictEqual(result, []);
    });
  });

  describe('Feature: imported implies declared (the allowlist is gone)', () => {
    it('Given every imported package is declared, When the rule is applied, Then nothing is reported', () => {
      assert.deepStrictEqual(
        findUndeclaredAwsSdkImports({
          importedNames: ['@aws-sdk/client-kms', '@aws-sdk/lib-dynamodb'],
          dependencyNames: ['zod', '@aws-sdk/client-kms', '@aws-sdk/lib-dynamodb']
        }),
        []
      );
    });

    it('Given client-dynamodb and lib-dynamodb are imported but undeclared, When the rule is applied, Then BOTH are reported despite the runtime bundling them', () => {
      // The deleted RUNTIME_BUNDLED_AWS_SDK_PACKAGES allowlist exempted exactly
      // these. If any exemption list came back, this returns [] instead.
      assert.deepStrictEqual(
        findUndeclaredAwsSdkImports({
          importedNames: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
          dependencyNames: ['zod']
        }),
        ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb']
      );
    });

    it('Given client-s3 is imported but undeclared, When the rule is applied, Then it is reported too', () => {
      assert.deepStrictEqual(
        findUndeclaredAwsSdkImports({
          importedNames: ['@aws-sdk/client-s3'],
          dependencyNames: ['@aws-sdk/client-kms']
        }),
        ['@aws-sdk/client-s3']
      );
    });

    it('Given a package is declared but never imported, When the rule is applied, Then it is not reported (the rule is one-directional)', () => {
      assert.deepStrictEqual(
        findUndeclaredAwsSdkImports({
          importedNames: [],
          dependencyNames: ['@aws-sdk/client-kms']
        }),
        []
      );
    });
  });

  describe('Feature: run() refuses to package an undeclared import', () => {
    const manifest = JSON.stringify({
      dependencies: { zod: '^4.0.0', '@aws-sdk/client-kms': '^3.0.0' }
    });

    /** readFile that serves the manifest and one source file. */
    function readFile(target) {
      const name = path.basename(target);
      if (name === 'package.json') return manifest;
      if (name === 'connections.mjs') return 'await import("@aws-sdk/client-dynamodb");';
      throw new Error(`unexpected read of ${target}`);
    }

    const readDir = () => [{ name: 'connections.mjs', isDirectory: () => false }];

    it('Given source imports an undeclared @aws-sdk package, When run() executes, Then it returns 1 and names that package', async () => {
      const lines = [];
      const code = await run({ argv: ['lambda'], log: (l) => lines.push(l), readFile, readDir });

      assert.strictEqual(code, 1, `expected exit code 1, got ${code}: ${lines.join(' | ')}`);
      const output = lines.join('\n');
      assert.match(output, /FAIL/, `output did not report FAIL: ${output}`);
      assert.match(output, /@aws-sdk\/client-dynamodb/,
        `output did not name the undeclared package: ${output}`);
      assert.match(output, /TASK-038/, `output did not cite the ticket: ${output}`);
    });

    it('Given the undeclared import, When run() executes, Then it does NOT report the declared packages as a problem', async () => {
      const lines = [];
      await run({ argv: ['lambda'], log: (l) => lines.push(l), readFile, readDir });
      const failLine = lines.find((l) => l.includes('not declared in'));
      assert.ok(failLine, `no "not declared in" line was logged: ${lines.join(' | ')}`);
      assert.doesNotMatch(failLine, /@aws-sdk\/client-kms/,
        `the declared package @aws-sdk/client-kms was wrongly listed as undeclared: ${failLine}`);
    });

    it('Given an undeclared import AND a missing install, When run() executes, Then the undeclared import is reported first', async () => {
      // Ordering matters for the operator reading a failed apply: the manifest
      // is wrong, so fixing node_modules would not help.
      const lines = [];
      const code = await run({
        argv: ['lambda'],
        log: (l) => lines.push(l),
        readFile,
        readDir,
        dirExists: () => false
      });
      assert.strictEqual(code, 1, `expected exit code 1, got ${code}`);
      assert.match(lines[0], /not declared in/, `first line was not the undeclared-import failure: ${lines[0]}`);
    });
  });

  describe('Feature: resolving the provisioner path locals', () => {
    const LOCALS_HCL = [
      'locals {',
      '  calendar_lambda_dir          = abspath("${path.module}/../src/lambda/calendar")',
      '  calendar_lambda_package_json = "${local.calendar_lambda_dir}/package.json"',
      '  calendar_lambda_package_lock = "${local.calendar_lambda_dir}/package-lock.json"',
      '  calendar_deps_verifier       = abspath("${path.module}/../scripts/verify-lambda-package-deps.mjs")',
      '}',
      ''
    ].join('\n');

    it('Given a locals block, When it is parsed, Then every assignment is returned by name', () => {
      assert.deepStrictEqual(
        Object.keys(parseLocalsBlock(LOCALS_HCL)).sort(),
        [
          'calendar_deps_verifier',
          'calendar_lambda_dir',
          'calendar_lambda_package_json',
          'calendar_lambda_package_lock'
        ]
      );
    });

    it('Given content with no locals block, When it is parsed, Then it throws rather than returning nothing', () => {
      assert.throws(
        () => parseLocalsBlock('resource "null_resource" "x" {}\n'),
        /no `locals \{` block found/
      );
    });

    it('Given the module directory, When the locals are resolved, Then abspath resolves against it exactly as terraform does', () => {
      // Confirmed against `terraform console`: for a root module path.module is
      // the directory holding the .tf file.
      const { resolved } = resolvePathLocals(LOCALS_HCL, path.join('C:', 'repo', 'terraform'));
      assert.strictEqual(resolved.calendar_lambda_dir, path.resolve('C:/repo/terraform', '../src/lambda/calendar'));
      assert.strictEqual(resolved.calendar_deps_verifier, path.resolve('C:/repo/terraform', '../scripts/verify-lambda-package-deps.mjs'));
    });

    it('Given a local derived from another local, When they are resolved, Then it is built from the resolved parent', () => {
      const { resolved } = resolvePathLocals(LOCALS_HCL, path.join('C:', 'repo', 'terraform'));
      assert.strictEqual(
        resolved.calendar_lambda_package_lock,
        path.join(resolved.calendar_lambda_dir, 'package-lock.json')
      );
    });

    it('Given a BARE ${path.module} local with no abspath, When it is resolved, Then it is reported unresolved rather than guessed at', () => {
      const bare = 'locals {\n  d = "${path.module}/../src/lambda/calendar"\n}\n';
      const { resolved, unresolved } = resolvePathLocals(bare, 'C:/repo/terraform');
      assert.deepStrictEqual(Object.keys(resolved), []);
      assert.ok('d' in unresolved, `expected local "d" to be unresolved, got ${JSON.stringify(unresolved)}`);
    });
  });

  describe('Feature: interpolating the provisioner command', () => {
    const locals = { calendar_deps_verifier: '/abs/verify.mjs', calendar_lambda_dir: '/abs/lambda' };

    it('Given a command referencing locals, When it is interpolated, Then the absolute values are substituted', () => {
      assert.strictEqual(
        interpolateCommand('npm ci && node "${local.calendar_deps_verifier}" "${local.calendar_lambda_dir}"', locals),
        'npm ci && node "/abs/verify.mjs" "/abs/lambda"'
      );
    });

    it('Given a command referencing an undefined local, When it is interpolated, Then it throws naming that local', () => {
      assert.throws(
        () => interpolateCommand('node "${local.nope}"', locals),
        /references local\.nope/
      );
    });

    it('Given the REJECTED command shape, When it is interpolated, Then it throws because ${path.module} survives as a relative fragment', () => {
      assert.throws(
        () => interpolateCommand('cd "${path.module}/../src/lambda/calendar" && npm ci', locals),
        /unresolved interpolation/
      );
    });

    it('Given a command containing cd, When it is inspected, Then the directory change is detected', () => {
      assert.strictEqual(commandChangesDirectory('cd "/x" && npm ci'), true);
      assert.strictEqual(commandChangesDirectory('npm ci && cd /x'), true);
      assert.strictEqual(commandChangesDirectory('npm ci; cd /x'), true);
    });

    it('Given a command with no cd, When it is inspected, Then words merely containing "cd" do not false-positive', () => {
      assert.strictEqual(commandChangesDirectory('npm ci --omit=dev && node verify.mjs'), false);
      assert.strictEqual(commandChangesDirectory('node ./cdk/build.mjs'), false);
    });

    it('Given an && chain, When it is split, Then each step is returned in order', () => {
      assert.deepStrictEqual(
        splitAndChain('npm ci --omit=dev --ignore-scripts && node "v.mjs" "d"'),
        ['npm ci --omit=dev --ignore-scripts', 'node "v.mjs" "d"']
      );
    });
  });

  describe('Feature: modelling the archive_file excludes filter', () => {
    const EXCLUDES = ['CLAUDE.md', '.deployment', 'package-lock.json', '__test_shims__'];

    it('Given a dependency path, When the excludes are applied, Then it is included in the archive', () => {
      assert.strictEqual(archiveIncludes('node_modules/@anthropic-ai/sdk/package.json', EXCLUDES), true);
      assert.strictEqual(archiveIncludes('node_modules/zod/package.json', EXCLUDES), true);
    });

    it('Given an excluded file, When the excludes are applied, Then it is left out', () => {
      assert.strictEqual(archiveIncludes('package-lock.json', EXCLUDES), false);
      assert.strictEqual(archiveIncludes('CLAUDE.md', EXCLUDES), false);
    });

    it('Given a file under an excluded directory, When the excludes are applied, Then the whole subtree is left out', () => {
      assert.strictEqual(archiveIncludes('__test_shims__/aws-sdk.mjs', EXCLUDES), false);
    });

    it('Given a path that merely starts with an excluded name, When the excludes are applied, Then it is still included', () => {
      assert.strictEqual(archiveIncludes('package-lock.json.bak', EXCLUDES), true);
      assert.strictEqual(archiveIncludes('__test_shims__extra/x.mjs', EXCLUDES), true);
    });

    it('Given an archive_file block, When its excludes are parsed, Then the list is returned in order', () => {
      const hcl = [
        'data "archive_file" "z" {',
        '  type = "zip"',
        '  excludes = [',
        '    "CLAUDE.md",',
        '    "package-lock.json"',
        '  ]',
        '}'
      ].join('\n');
      assert.deepStrictEqual(parseArchiveExcludes(hcl, 'z'), ['CLAUDE.md', 'package-lock.json']);
    });

    it('Given a missing archive_file block, When its excludes are parsed, Then it throws naming the block', () => {
      assert.throws(() => parseArchiveExcludes('data "archive_file" "z" {}', 'other'),
        /data "archive_file" "other" not found/);
    });
  });
});
