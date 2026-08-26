#!/usr/bin/env node
/**
 * verify-lambda-package-deps — packaging preflight for a Lambda source
 * directory (TASK-038).
 *
 * Usage:
 *   node scripts/verify-lambda-package-deps.mjs <lambda-dir>
 *   node scripts/verify-lambda-package-deps.mjs ../src/lambda/calendar
 *
 * Reads `<lambda-dir>/package.json`'s `dependencies` and confirms every one of
 * them has a matching directory under `<lambda-dir>/node_modules`. This is run
 * by `terraform/lambda_calendar.tf` immediately after `npm ci --omit=dev`, so a
 * deploy that would otherwise ship a zip with the SDK missing (booting fine,
 * then failing every extraction at first use, per TASK-038) fails the
 * `terraform apply` loudly instead — before the archive is built.
 *
 * It also refuses to package when source imports an `@aws-sdk/*` package that
 * the manifest does not declare, which is the mirror-image gap: a declaration
 * with no install versus an import with no declaration.
 *
 * Exits 0 when every declared dependency is present, 1 otherwise (including
 * argument errors and a missing/unreadable package.json).
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOG_PREFIX = '[verify-lambda-package-deps]';

const AWS_SDK_IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@aws-sdk\/[a-z0-9.-]+)['"]/g;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '__test_shims__']);
const SOURCE_FILE_RE = /\.(mjs|js|cjs)$/;

export const USAGE = [
  'Usage: node scripts/verify-lambda-package-deps.mjs <lambda-dir>',
  '',
  '  <lambda-dir>  Directory containing the Lambda\'s own package.json',
  '',
  'Example: node scripts/verify-lambda-package-deps.mjs ../src/lambda/calendar'
].join('\n');

/**
 * Parse CLI arguments. Never throws — a bad invocation comes back as an error
 * string so the caller can print usage and exit 1 rather than a stack trace.
 * @param {string[]} argv Arguments after the script name.
 * @returns {{ lambdaDir?: string, help?: boolean, error?: string }}
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }

  if (args.length === 0) {
    return { error: 'missing required argument <lambda-dir>' };
  }

  if (args.length > 1) {
    return { error: `unexpected extra argument "${args[1]}"` };
  }

  return { lambdaDir: args[0] };
}

/**
 * Read the `dependencies` names declared in a package.json. Never throws — a
 * missing file or malformed JSON comes back as an error string.
 * @param {string} packageJsonPath
 * @param {{ readFile?: (path: string) => string }} [io]
 * @returns {{ names?: string[], error?: string }}
 */
export function readDependencyNames(packageJsonPath, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let raw;
  try {
    raw = readFile(packageJsonPath);
  } catch (err) {
    return { error: `could not read ${packageJsonPath}: ${err?.message || 'unknown error'}` };
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { error: `${packageJsonPath} is not valid JSON: ${err?.message || 'unknown error'}` };
  }

  const deps = (pkg && typeof pkg === 'object' && pkg.dependencies && typeof pkg.dependencies === 'object')
    ? pkg.dependencies
    : {};

  return { names: Object.keys(deps) };
}

/**
 * Names among `dependencyNames` that do not have a directory under
 * `<lambdaDir>/node_modules`. Pure given an injected `dirExists` — no I/O by
 * default only in the sense that the default delegates to fs.statSync.
 * @param {{ lambdaDir: string, dependencyNames: string[], dirExists?: (path: string) => boolean }} args
 * @returns {string[]} Missing dependency names, in declaration order.
 */
export function findMissingDependencies({ lambdaDir, dependencyNames, dirExists = defaultDirExists }) {
  return dependencyNames.filter((name) => !dirExists(join(lambdaDir, 'node_modules', name)));
}

/** @param {string} path */
function defaultDirExists(path) {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively scan `lambdaDir` (excluding `node_modules` and other
 * non-source directories) for `@aws-sdk/*` import/require specifiers, static
 * or dynamic. Never throws — an unreadable directory or file is skipped, not
 * fatal, so this degrades to "found nothing there" rather than crashing the
 * preflight.
 * @param {{ lambdaDir: string, readDir?: (dir: string) => import('node:fs').Dirent[], readFile?: (path: string) => string }} args
 * @returns {string[]} Distinct `@aws-sdk/*` package names found, sorted.
 */
export function findAwsSdkImports({ lambdaDir, readDir = defaultReadDir, readFile = (p) => readFileSync(p, 'utf8') }) {
  const found = new Set();

  const walk = (dir) => {
    let entries;
    try {
      entries = readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (SOURCE_FILE_RE.test(entry.name)) {
        let content;
        try {
          content = readFile(full);
        } catch {
          continue;
        }
        for (const match of content.matchAll(AWS_SDK_IMPORT_RE)) {
          found.add(match[1]);
        }
      }
    }
  };

  walk(lambdaDir);
  return Array.from(found).sort();
}

/** @param {string} dir */
function defaultReadDir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

/**
 * `@aws-sdk/*` names imported by source but not declared in
 * `dependencyNames`. There is deliberately NO runtime-bundled exemption list
 * to check against: TASK-038 decided this Lambda ships every `@aws-sdk/*`
 * package it imports rather than relying on the managed runtime's bundled
 * subset (the reasons, and the measured cost, are recorded above
 * `data.archive_file.calendar_lambda_zip` in terraform/lambda_calendar.tf).
 * The rule is therefore just "imported implies declared", with no allowlist
 * that can drift out of date against what a runtime actually ships.
 *
 * This catches the gap that let `@aws-sdk/client-kms` and
 * `@aws-sdk/client-scheduler` go undeclared for several tickets: checking the
 * manifest alone is blind to an import with no declaration at all, as opposed
 * to a declaration with no install. Either way the Lambda still boots — every
 * `@aws-sdk` import in this codebase is lazy and module-scope-cached — and
 * only fails the first time that specific import is reached at runtime.
 * @param {{ importedNames: string[], dependencyNames: string[] }} args
 * @returns {string[]}
 */
export function findUndeclaredAwsSdkImports({ importedNames, dependencyNames }) {
  const declared = new Set(dependencyNames);
  return importedNames.filter((name) => !declared.has(name));
}

/**
 * Run the preflight.
 * @param {object} [options]
 * @param {string[]} [options.argv] Arguments after the script name.
 * @param {(line: string) => void} [options.log] Line sink; defaults to console.log.
 * @param {(path: string) => string} [options.readFile] package.json reader, injectable for tests.
 * @param {(path: string) => boolean} [options.dirExists] node_modules directory check, injectable for tests.
 * @param {(dir: string) => import('node:fs').Dirent[]} [options.readDir] source-tree walker, injectable for tests.
 * @returns {Promise<number>} Process exit code: 0 all dependencies present, 1 otherwise.
 */
export async function run({ argv = [], log = console.log, readFile, dirExists, readDir } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    log(USAGE);
    return 0;
  }

  if (args.error) {
    log(`${LOG_PREFIX} error: ${args.error}`);
    log(USAGE);
    return 1;
  }

  const { lambdaDir } = args;
  const packageJsonPath = join(lambdaDir, 'package.json');

  const { names, error } = readDependencyNames(packageJsonPath, readFile ? { readFile } : {});
  if (error) {
    log(`${LOG_PREFIX} FAIL  ${error}`);
    return 1;
  }

  const imported = findAwsSdkImports({
    lambdaDir,
    ...(readDir ? { readDir } : {}),
    ...(readFile ? { readFile } : {})
  });
  const undeclared = findUndeclaredAwsSdkImports({ importedNames: imported, dependencyNames: names });

  if (undeclared.length > 0) {
    log(`${LOG_PREFIX} FAIL  source imports @aws-sdk package(s) not declared in ${packageJsonPath}: ${undeclared.join(', ')}`);
    log(`${LOG_PREFIX} refusing to package - this Lambda ships every @aws-sdk package it imports (see terraform/lambda_calendar.tf), and an undeclared import boots fine then fails the first time it is reached at runtime (TASK-038)`);
    return 1;
  }

  if (names.length === 0) {
    log(`${LOG_PREFIX} ${packageJsonPath} declares no runtime dependencies; nothing to verify`);
    return 0;
  }

  const missing = findMissingDependencies({
    lambdaDir,
    dependencyNames: names,
    ...(dirExists ? { dirExists } : {})
  });

  if (missing.length > 0) {
    log(`${LOG_PREFIX} FAIL  missing from ${join(lambdaDir, 'node_modules')}: ${missing.join(', ')}`);
    log(`${LOG_PREFIX} refusing to package - the deploy would boot and then fail every use of the missing dependency (TASK-038)`);
    return 1;
  }

  log(`${LOG_PREFIX} PASS  all ${names.length} declared dependencies present: ${names.join(', ')}`);
  return 0;
}

/* c8 ignore start */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run({ argv: process.argv.slice(2) })
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.log(`${LOG_PREFIX} FAIL  unexpected error: ${err?.name || 'Error'}: ${err?.message || 'unknown error'}`);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
