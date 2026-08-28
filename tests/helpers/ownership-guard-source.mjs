/**
 * Loads the secret-ownership guard OUT OF tests/e2e/check-oauth-config.test.js
 * so it can be exercised directly.
 *
 * The guard (`terraformCreatesSecretClaimsIn` and friends, TASK-024/027/030)
 * is defined at module scope in that e2e file and exported from nowhere. The
 * repo's existing workaround for that shape is to paste a copy of the function
 * into the test that wants it (tests/unit/mutation-sweep.test.js does exactly
 * that with parseSecretsAccesses). A copy is worthless as a regression guard:
 * it drifts silently, and then the test proves things about the copy while the
 * real guard rots. So this reads the real source instead.
 *
 * Everything above the top-level `describe(` in that file is helper
 * definitions. That prelude is lifted verbatim, its imports and its
 * import.meta-derived path constants are replaced (a data: URL module has no
 * meaningful import.meta.url, so relative specifiers and __dirname cannot
 * survive the move), and the whole thing is imported as one module with an
 * export list appended. No product or test source on disk is modified.
 *
 * CRLF NOTE (TASK-099): the split is on a literal marker string and the line
 * filter uses /\r?\n/, so this works identically in an LF checkout and a CRLF
 * one. Nothing here matches a bare "\n" against file content.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GUARD_SOURCE_FILE = path.join(PROJECT_ROOT, 'tests', 'e2e', 'check-oauth-config.test.js');
const DESCRIBE_MARKER = "describe('Google OAuth Configuration Preflight E2E Tests'";

const EXPORTED_NAMES = [
  'terraformCreatesSecretClaimsIn',
  'terraformCreatesSecretClaims',
  'NON_SECRET_RESOURCE_TERMS',
  'nonSecretResourcePattern',
  'objectPhraseOf',
  'runbookText',
  'proseOf',
  'sentencesOf',
  'SECRET_ANAPHOR',
  'CREATE_VERB',
  'OBJECT_WINDOW'
];

/** The prelude of the e2e guard file: everything before its top-level describe. */
export function guardPreludeSource() {
  const source = fs.readFileSync(GUARD_SOURCE_FILE, 'utf-8');
  const cut = source.indexOf(DESCRIBE_MARKER);
  if (cut < 0) {
    throw new Error(
      `Could not find "${DESCRIBE_MARKER}" in ${GUARD_SOURCE_FILE}; the guard ` +
        'file was restructured and this loader must be updated rather than ' +
        'silently testing nothing.'
    );
  }
  return source.slice(0, cut);
}

function rewrittenModuleSource() {
  const prelude = guardPreludeSource();
  const body = prelude
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*import\s/.test(line) &&
        !/^const\s+(__filename|__dirname|PROJECT_ROOT)\s*=/.test(line)
    )
    .join('\n');

  if (!body.includes('function terraformCreatesSecretClaimsIn')) {
    throw new Error(
      'The extracted prelude does not define terraformCreatesSecretClaimsIn. ' +
        'Refusing to hand back a module that would make every assertion vacuous.'
    );
  }

  return [
    "import * as fs from 'node:fs';",
    "import * as path from 'node:path';",
    "import * as assert from 'node:assert';",
    `const PROJECT_ROOT = ${JSON.stringify(PROJECT_ROOT)};`,
    body,
    `export { ${EXPORTED_NAMES.join(', ')} };`
  ].join('\n');
}

/**
 * The live guard, imported from the real e2e file's own source text.
 * `overrides` may replace whole top-level statements before evaluation; it is
 * used only by the fail-loud tests that must prove a mutation actually applied.
 */
export async function loadOwnershipGuard({ transform } = {}) {
  let source = rewrittenModuleSource();
  if (transform) {
    const transformed = transform(source);
    if (transformed === source) {
      throw new Error(
        'loadOwnershipGuard: the requested transform changed nothing, so the ' +
          'mutated build would be identical to the real one and any assertion ' +
          'about it would pass vacuously (TASK-099).'
      );
    }
    source = transformed;
  }
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf-8').toString('base64')}`;
  return import(url);
}

export { GUARD_SOURCE_FILE, PROJECT_ROOT, DESCRIBE_MARKER };
