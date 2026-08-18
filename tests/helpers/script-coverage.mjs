/**
 * Shared helpers for reasoning about npm test-script commands.
 *
 * Both tests/e2e/npm-scripts.test.js and tests/unit/npm-scripts-config.test.js
 * import from here so that the "does this script cover tests/<dir>?" question has
 * exactly one implementation. A second, divergent copy of the check is how the
 * unit layer previously ended up with a guard that could not fail.
 *
 * DESIGN RULE: a guard that cannot decide must not report "covered".
 * Every unrecognised shape below resolves to *not covered*. A false negative
 * fails a correct script (annoying, visible, fixable); a false positive lets a
 * whole test directory silently vanish from CI, which is the regression
 * TASK-019 was opened for. When in doubt, answer "no".
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
 *
 * The second group below is the dangerous half: node flags whose value is a
 * *path*. `node --import tests/e2e/setup.mjs --test tests/unit` registers a
 * setup module; tests/e2e is NOT a directory that runs. Omitting these flags
 * made the value look like a positional test path, so the predicate reported
 * tests/e2e as covered by a command that only ever runs tests/unit. That is the
 * exact fail-open direction this allowlist exists to close, so any new
 * path-valued node flag belongs here.
 */
export const VALUE_TAKING_FLAGS = new Set([
  // Value-taking flags whose value is not a path
  '--test-name-pattern',
  '--test-reporter',
  '--test-concurrency',
  '--experimental-loader',
  // Value-taking flags whose value IS a path (fail-open risk if omitted)
  '--import',
  '--require',
  '-r',
  '--loader',
  '--env-file',
  '--env-file-if-exists',
  '--test-reporter-destination',
]);

/**
 * Executable names that mean "this segment is the node binary".
 * Compared on the basename, lower-cased, so `./node`, `/usr/bin/node` and
 * `C:\Program Files\nodejs\node.exe` all qualify.
 */
const NODE_EXECUTABLES = new Set(['node', 'node.exe', 'node.cmd', 'nodejs']);

/** `CI=1 node --test tests/unit` — a leading `VAR=value` prefix is not a path. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Shell constructs whose expansion we cannot know statically. A segment
 * containing any of these is unparseable, and an unparseable segment
 * contributes no paths — so it can only ever make the answer "not covered".
 */
const UNSUPPORTED_CONSTRUCTS = ['$(', '${', '`', '>', '<'];

/**
 * Lexes a script command into command segments, each a list of tokens.
 *
 * Segments are split on the shell operators `&&`, `||`, `;`, `|`, `&` and
 * newlines, outside of quotes. This is what gives the predicate a notion of
 * *which command a token belongs to*: in `echo tests && node --test tests/unit`
 * the bare `tests` belongs to `echo` and must not satisfy the whole-tree
 * short-circuit for `node --test`.
 *
 * Quote characters are kept in the token text so downstream normalisation and
 * verbatim re-emission (scopeScriptToSingleFile) behave exactly as before.
 *
 * @param {string} script
 * @returns {string[][]|null} segments, or null if the command cannot be lexed
 *   (an unterminated quote); null always resolves to "not covered".
 */
export function lexCommandSegments(script) {
  if (typeof script !== 'string') {
    return null;
  }

  const segments = [];
  let tokens = [];
  let current = '';
  let quote = null;

  const endToken = () => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) {
      segments.push(tokens);
    }
    tokens = [];
  };

  let i = 0;
  while (i < script.length) {
    const ch = script[i];

    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      if (ch === '\n') {
        endSegment();
      } else {
        endToken();
      }
      i += 1;
      continue;
    }

    const pair = script.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      endSegment();
      i += 2;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (quote) {
    // Unterminated quote: we do not know where the token ends, so we refuse
    // to answer rather than guess.
    return null;
  }

  endSegment();
  return segments;
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
 * True when the token is a flag (and not a negative number or a bare "-").
 *
 * @param {string} token
 * @returns {boolean}
 */
function isFlag(token) {
  return token.startsWith('-') && token.length > 1;
}

/**
 * True when a flag written in space-separated form consumes the next token.
 *
 * @param {string} token
 * @returns {boolean}
 */
function consumesNextToken(token) {
  if (token.includes('=')) {
    return false;
  }
  return VALUE_TAKING_FLAGS.has(token);
}

/**
 * Extracts the test-path arguments of one command segment.
 *
 * Returns null when the segment does not invoke the node test runner, i.e. when
 * it cannot contribute test paths at all. A segment qualifies only when:
 *   - its executable (after any `VAR=value` prefix) is the node binary, and
 *   - `--test` appears in the node flag region, i.e. before the first
 *     positional token.
 *
 * The second condition matters because node stops parsing its own flags at the
 * first positional: in `node runner.mjs --test tests` the `--test` belongs to
 * runner.mjs, not to node, so nothing under tests/ is discovered. Reporting
 * that segment as a test runner would be the fail-open direction.
 *
 * `node --test` with no positional path is also reported as contributing no
 * paths. Node's default discovery would in fact walk the whole tree, but an
 * absent argument is absent evidence: the guard answers "not covered" and asks
 * for the path to be written explicitly.
 *
 * @param {string[]} tokens
 * @returns {string[]|null}
 */
function segmentTestPaths(tokens) {
  if (tokens.some(token => UNSUPPORTED_CONSTRUCTS.some(construct => token.includes(construct)))) {
    return null;
  }

  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) {
    index += 1;
  }
  if (index >= tokens.length) {
    return null;
  }

  const executable = normalizePathToken(tokens[index]).split('/').pop().toLowerCase();
  if (!NODE_EXECUTABLES.has(executable)) {
    return null;
  }
  index += 1;

  // Node flag region: ends at the first positional token.
  let sawTestFlag = false;
  while (index < tokens.length) {
    const raw = tokens[index];
    if (!isFlag(raw)) {
      break;
    }
    const flagName = raw.split('=')[0];
    if (flagName === '--test') {
      sawTestFlag = true;
    }
    index += consumesNextToken(raw) ? 2 : 1;
  }

  if (!sawTestFlag) {
    return null;
  }

  // Everything from the first positional onward is a test file/directory
  // pattern; trailing flags are still skipped (with their values).
  const paths = [];
  while (index < tokens.length) {
    const raw = tokens[index];
    if (isFlag(raw)) {
      index += consumesNextToken(raw) ? 2 : 1;
      continue;
    }
    paths.push(normalizePathToken(raw));
    index += 1;
  }

  return paths;
}

/**
 * Extracts the normalised path arguments that a script actually runs tests from.
 *
 * Only segments that invoke the node test runner contribute (see
 * segmentTestPaths); tokens belonging to any other command in the pipeline, and
 * the values of known value-taking flags, are excluded. An unparseable command
 * yields an empty list, never a speculative path.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function extractPathArguments(script) {
  const segments = lexCommandSegments(script);
  if (!segments) {
    return [];
  }

  const paths = [];
  for (const tokens of segments) {
    const segmentPaths = segmentTestPaths(tokens);
    if (segmentPaths) {
      paths.push(...segmentPaths);
    }
  }

  return paths;
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
 * A directory is covered when a path argument of a *test-runner* segment is:
 * - the whole tree (`tests`, `tests/`, `./tests/`, `"tests"`), OR
 * - the directory itself (`tests/<dirName>`) or a path inside it
 *   (`tests/<dirName>/foo.test.js`), OR
 * - a wildcard that matches the directory segment (`tests/*`, `tests/e2*`).
 *
 * Deliberately NOT covered:
 * - a sibling whose name merely starts with dirName (`tests/e2e-legacy` does not
 *   cover `e2e`) — segment comparison is exact, not prefix-based;
 * - a value of a known value-taking flag (`--test-name-pattern tests` does not
 *   make every directory covered, and `--import tests/e2e/setup.mjs` names a
 *   setup module, not a directory that runs);
 * - a token belonging to some other command in the pipeline
 *   (`echo tests && node --test tests/unit` runs only tests/unit);
 * - anything in a command shape we cannot parse — see the design rule at the
 *   top of this file.
 *
 * @param {string} testScript the raw script command from package.json
 * @param {string} dirName immediate subdirectory of tests/ (e.g. 'unit', 'e2e')
 * @returns {boolean}
 */
export function isDirectoryCovered(testScript, dirName) {
  if (!testScript || !dirName || typeof testScript !== 'string' || typeof dirName !== 'string') {
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
 * Throws for a script it cannot rewrite safely (an unterminated quote, or more
 * than one command segment): silently emitting a half-rewritten pipeline could
 * run the wrong command, or re-enter the directory this scoping exists to avoid.
 *
 * @param {string} script
 * @param {string} targetFile
 * @returns {string}
 */
export function scopeScriptToSingleFile(script, targetFile) {
  const segments = lexCommandSegments(script);
  if (!segments) {
    throw new Error(`Cannot scope an unparseable script command: "${script}"`);
  }
  if (segments.length !== 1) {
    throw new Error(
      `Cannot scope a multi-command script to a single file (found ${segments.length} ` +
      `command segments): "${script}"`
    );
  }

  const tokens = segments[0];
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

    if (isFlag(raw)) {
      kept.push(raw);
      if (consumesNextToken(raw)) {
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
