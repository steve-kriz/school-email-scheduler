/**
 * Shared helpers for reasoning about npm test-script commands.
 *
 * Both tests/e2e/npm-scripts.test.js and tests/unit/npm-scripts-config.test.js
 * import from here so that the "does this script cover tests/<dir>?" question has
 * exactly one implementation. A second, divergent copy of the check is how the
 * unit layer previously ended up with a guard that could not fail.
 */

/**
 * Flags that consume the *following* token as their value.
 *
 * This is an explicit allowlist on purpose. The earlier heuristic was
 * "a bare `tests` token preceded by anything starting with `-` is a flag value",
 * which is wrong: most node test flags are booleans. `node --test tests` is the
 * most natural way to run the whole tree, and `--test` takes no value, so the
 * token after it is a genuine path argument. Guessing that every flag consumes
 * the next token produced false negatives for correct scripts; guessing that
 * none do produced the `--test-name-pattern tests` false positive. Only an
 * explicit list of value-taking flags gets both directions right.
 *
 * Flags written in `--flag=value` form never consume the next token.
 */
export const VALUE_TAKING_FLAGS = new Set([
  '--test-name-pattern',
  '--test-reporter',
  '--test-concurrency',
  '--experimental-loader',
]);

/**
 * Splits a script command into whitespace-separated tokens.
 *
 * @param {string} script
 * @returns {string[]}
 */
function tokenize(script) {
  return String(script).trim().split(/\s+/).filter(Boolean);
}

/**
 * Normalises a candidate path token so equivalent spellings compare equal:
 * strips surrounding quotes, converts backslashes to forward slashes,
 * strips a leading "./" and strips trailing slashes.
 *
 * e.g. '"./tests/e2e/"' -> 'tests/e2e'
 *
 * @param {string} token
 * @returns {string}
 */
export function normalizePathToken(token) {
  let value = String(token).trim();

  // Strip a matched pair of surrounding quotes
  const quoted = (value.startsWith('"') && value.endsWith('"')) ||
                 (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) {
    value = value.slice(1, -1);
  }

  // Windows-style separators compare as POSIX ones
  value = value.replace(/\\/g, '/');

  // Leading "./" is noise
  while (value.startsWith('./')) {
    value = value.slice(2);
  }

  // Trailing slashes are noise ("tests/" is the same path as "tests")
  while (value.length > 1 && value.endsWith('/')) {
    value = value.slice(0, -1);
  }

  return value;
}

/**
 * Extracts the positional (non-flag) arguments of a script command, normalised.
 *
 * Flags are skipped. The token after a flag is skipped only when that flag is a
 * known value-taking flag (see VALUE_TAKING_FLAGS) written in space-separated
 * form; otherwise it is treated as a genuine positional argument.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function extractPathArguments(script) {
  const tokens = tokenize(script);
  const positional = [];
  let skipNext = false;

  for (const raw of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (raw.startsWith('-')) {
      const flagName = raw.split('=')[0];
      if (!raw.includes('=') && VALUE_TAKING_FLAGS.has(flagName)) {
        skipNext = true;
      }
      continue;
    }

    positional.push(normalizePathToken(raw));
  }

  return positional;
}

/**
 * Matches a single path segment that may contain "*" wildcards.
 *
 * @param {string} segment
 * @param {string} name
 * @returns {boolean}
 */
function segmentMatches(segment, name) {
  if (!segment.includes('*')) {
    return segment === name;
  }
  const pattern = segment
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * Checks whether a test script covers tests/<dirName>.
 *
 * A directory is covered when a positional argument of the script is:
 * - the whole tree (`tests`, `tests/`, `./tests/`, `"tests"`), OR
 * - the directory itself (`tests/<dirName>`) or a path inside it
 *   (`tests/<dirName>/foo.test.js`), OR
 * - a wildcard that matches the directory segment (`tests/*`, `tests/e2*`).
 *
 * Deliberately NOT covered:
 * - a sibling whose name merely starts with dirName (`tests/e2e-legacy` does not
 *   cover `e2e`) — segment comparison is exact, not prefix-based;
 * - a value of a known value-taking flag (`--test-name-pattern tests` does not
 *   make every directory covered).
 *
 * @param {string} testScript the raw script command from package.json
 * @param {string} dirName immediate subdirectory of tests/ (e.g. 'unit', 'e2e')
 * @returns {boolean}
 */
export function isDirectoryCovered(testScript, dirName) {
  if (!testScript || !dirName) {
    return false;
  }

  for (const arg of extractPathArguments(testScript)) {
    const segments = arg.split('/');
    if (segments[0] !== 'tests') {
      continue;
    }

    // Bare `tests` (or `tests/`, normalised) runs the whole tree
    if (segments.length === 1) {
      return true;
    }

    if (segmentMatches(segments[1], dirName)) {
      return true;
    }
  }

  return false;
}

/**
 * Rewrites a script command so it targets exactly one file.
 *
 * The executable, every flag (with its value) and any non-path positional token
 * (e.g. a subcommand) are preserved verbatim; only arguments that point into the
 * tests/ tree are dropped, replaced by the single target file. This lets a test
 * execute the *real* command from package.json — so broken plumbing is caught —
 * while guaranteeing no directory discovery runs, which is what would make a
 * test inside tests/e2e re-enter itself.
 *
 * e.g. ('node --test tests/e2e', 'tests/helpers/exit-zero-fixture.mjs')
 *      -> 'node --test tests/helpers/exit-zero-fixture.mjs'
 *
 * @param {string} script
 * @param {string} targetFile
 * @returns {string}
 */
export function scopeScriptToSingleFile(script, targetFile) {
  const tokens = tokenize(script);
  const kept = [];
  let skipNext = false;

  tokens.forEach((raw, index) => {
    if (skipNext) {
      kept.push(raw);
      skipNext = false;
      return;
    }

    // The executable is always kept
    if (index === 0) {
      kept.push(raw);
      return;
    }

    if (raw.startsWith('-')) {
      kept.push(raw);
      const flagName = raw.split('=')[0];
      if (!raw.includes('=') && VALUE_TAKING_FLAGS.has(flagName)) {
        skipNext = true;
      }
      return;
    }

    // A path into the tests/ tree is dropped in favour of the single target file;
    // any other positional token (a subcommand, say) is part of the plumbing.
    const normalized = normalizePathToken(raw);
    if (normalized !== 'tests' && !normalized.startsWith('tests/')) {
      kept.push(raw);
    }
  });

  kept.push(targetFile);
  return kept.join(' ');
}
