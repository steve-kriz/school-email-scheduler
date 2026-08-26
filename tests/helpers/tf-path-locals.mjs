/**
 * tf-path-locals — resolve the filesystem path `locals` that
 * terraform/lambda_calendar.tf's packaging step interpolates, and model
 * `data.archive_file`'s `excludes` filter, so tests can EXECUTE the real
 * command instead of pattern-matching the HCL that declares it (TASK-038).
 *
 * Why this exists: the rejected version of the provisioner ran
 * `cd <dir> && node <relative script> <relative dir>` in one shell command.
 * Terraform substituted every `${path.module}` fragment as a plain relative
 * string BEFORE the shell ran, so the fragments after the `cd` re-resolved
 * against the NEW working directory and pointed at directories that do not
 * exist. `terraform validate` cannot see a path inside a command string, and
 * no test executed the command, so it shipped and failed on every apply.
 *
 * Resolution semantics implemented here were confirmed against terraform
 * itself (`terraform console`): for a root module, `path.module` is the
 * directory containing the `.tf` file, so
 * `abspath("${path.module}/../x")` === `path.resolve(<terraform dir>, '../x')`.
 */

import * as path from 'node:path';

const ABSPATH_MODULE_RE = /^abspath\("\$\{path\.module\}\/(.+)"\)$/;
const LOCAL_REF_INTERPOLATION_RE = /\$\{local\.([A-Za-z0-9_]+)\}/g;
const ANY_INTERPOLATION_RE = /\$\{([^}]+)\}/g;

/**
 * Extract the `name = expression` pairs from the FIRST `locals { ... }` block
 * in `tfContent`. Nested braces are not expected in a path locals block and
 * are not supported; the block is terminated by the first line that is a lone
 * closing brace.
 *
 * @param {string} tfContent Raw HCL.
 * @returns {Record<string, string>} Raw (untrimmed of quotes) expressions by name.
 * @throws {Error} If no `locals` block is present at all.
 */
export function parseLocalsBlock(tfContent) {
  const start = tfContent.search(/^locals\s*\{\s*$/m);
  if (start === -1) {
    throw new Error('no `locals {` block found in the given terraform content');
  }
  const rest = tfContent.slice(start);
  const end = rest.search(/^\}\s*$/m);
  if (end === -1) {
    throw new Error('the `locals {` block is never closed in the given terraform content');
  }

  const body = rest.slice(0, end);
  const assignments = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (match) assignments[match[1]] = match[2];
  }
  return assignments;
}

/**
 * Resolve the path-valued locals of `tfContent` to absolute paths, exactly the
 * way terraform would when the module directory is `moduleDir`.
 *
 * Two expression shapes are understood, which are the two the packaging step
 * uses:
 *   - `abspath("${path.module}/<suffix>")`  -> resolve(moduleDir, suffix)
 *   - `"${local.<other>}/<suffix>"`         -> <other resolved> + /suffix
 *
 * Anything else (in particular a BARE `"${path.module}/x"` with no `abspath`,
 * which is the relative-fragment shape this ticket was rejected for) is not
 * resolvable here and is reported rather than guessed at.
 *
 * @param {string} tfContent Raw HCL containing a `locals` block.
 * @param {string} moduleDir Directory the module lives in (`path.module`).
 * @returns {{ resolved: Record<string, string>, unresolved: Record<string, string> }}
 */
export function resolvePathLocals(tfContent, moduleDir) {
  const assignments = parseLocalsBlock(tfContent);
  const resolved = {};
  const unresolved = {};

  // Two passes: `abspath(...)` locals first, then the ones that build on them.
  for (const [name, expression] of Object.entries(assignments)) {
    const absMatch = expression.match(ABSPATH_MODULE_RE);
    if (absMatch) resolved[name] = path.resolve(moduleDir, absMatch[1]);
  }

  for (const [name, expression] of Object.entries(assignments)) {
    if (name in resolved) continue;

    const derived = expression.match(/^"\$\{local\.([A-Za-z0-9_]+)\}\/(.+)"$/);
    if (derived && derived[1] in resolved) {
      resolved[name] = path.join(resolved[derived[1]], derived[2]);
    } else {
      unresolved[name] = expression;
    }
  }

  return { resolved, unresolved };
}

/**
 * Substitute `${local.X}` references in a provisioner command with the values
 * in `locals`, producing the string the shell would actually receive.
 *
 * Throws — never silently leaves a fragment in place — when a reference cannot
 * be substituted or when a NON-`local.` interpolation survives. A surviving
 * `${path.module}` is precisely the defect that shipped: it is a relative
 * string the shell re-resolves against whatever directory it happens to be in.
 *
 * @param {string} command The raw `command = "..."` value.
 * @param {Record<string, string>} locals Resolved local values.
 * @returns {string}
 * @throws {Error} Naming the reference that could not be substituted.
 */
export function interpolateCommand(command, locals) {
  const substituted = command.replace(LOCAL_REF_INTERPOLATION_RE, (_full, name) => {
    if (!(name in locals)) {
      throw new Error(`command references local.${name}, which is not defined in the locals block`);
    }
    return locals[name];
  });

  const leftover = substituted.match(ANY_INTERPOLATION_RE);
  if (leftover) {
    throw new Error(
      `command still contains unresolved interpolation(s) after substitution: ${leftover.join(', ')} ` +
      '- a non-local interpolation such as ${path.module} yields a RELATIVE path that the shell ' +
      're-resolves against its current directory (TASK-038)'
    );
  }

  return substituted;
}

/**
 * Does `command` change the shell's working directory part-way through?
 *
 * Any `cd` makes every later relative path in the same command resolve against
 * a different directory than the one terraform interpolated them for.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function commandChangesDirectory(command) {
  return /(?:^|[\s&|;(])cd(?=\s|$)/.test(command);
}

/**
 * Split a `&&`-chained shell command into its steps, so a test can assert the
 * chain aborts at the step it is supposed to.
 * @param {string} command
 * @returns {string[]}
 */
export function splitAndChain(command) {
  return command.split('&&').map((part) => part.trim()).filter(Boolean);
}

/**
 * Model `data.archive_file`'s `excludes`: a repo-relative path is left out of
 * the zip when it equals an exclude entry, or lies underneath one (a directory
 * name in `excludes` takes its whole subtree with it).
 *
 * @param {string} relPath Path relative to `source_dir`, using `/` separators.
 * @param {string[]} excludes The `excludes` list from the archive_file block.
 * @returns {boolean} True when the path would be present in the archive.
 */
export function archiveIncludes(relPath, excludes) {
  const normalised = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  return !excludes.some(
    (entry) => normalised === entry || normalised.startsWith(`${entry}/`)
  );
}

/**
 * Read the `excludes = [...]` string list out of a named `data "archive_file"`
 * block.
 * @param {string} tfContent Raw HCL.
 * @param {string} name The archive_file's second label.
 * @returns {string[]}
 * @throws {Error} If the block or its excludes list cannot be found.
 */
export function parseArchiveExcludes(tfContent, name) {
  const start = tfContent.indexOf(`data "archive_file" "${name}"`);
  if (start === -1) {
    throw new Error(`data "archive_file" "${name}" not found`);
  }
  const body = tfContent.slice(start);
  const match = body.match(/excludes\s*=\s*\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error(`data "archive_file" "${name}" has no excludes list`);
  }
  return Array.from(match[1].matchAll(/"([^"]*)"/g)).map((m) => m[1]);
}
