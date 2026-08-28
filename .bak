/**
 * Shared HCL block extraction for terraform structure tests (TASK-017).
 *
 * The dynamodb/KMS test suites used to assert with `content.includes('enabled
 * = true')` over the whole file, which cannot tell which block a flag belongs
 * to: a flag moved between blocks, or switched off in one block while another
 * still says `true`, kept the suite green. These helpers instead locate a
 * named `resource "<type>" "<name>" { ... }` body by brace matching, and a
 * named nested block within that body, so assertions can be scoped to the
 * one block that actually matters.
 *
 * Superseded by this file: the `extractResourceBody`/`bodyDeclaresTtlBlock`
 * pair that TASK-016 added independently at module scope in both
 * tests/unit/dynamodb-calendar.test.js and tests/e2e/dynamodb-calendar.test.js.
 * Those counted braces naively, without skipping braces inside double-quoted
 * strings, `#`/`//` line comments, or `<<EOT`/`<<-EOT` heredocs. On today's
 * files every brace-bearing construct happens to be balanced, but a future
 * file containing an unbalanced brace in a string, comment, or heredoc (an
 * inline IAM policy description, for example) would make a naive counter
 * return a truncated body - and a truncated body that omits a real `ttl`
 * block is a false negative on the guard protecting the OAuth grant table.
 * This module skips all three constructs before counting braces.
 */

/**
 * Return a copy of `content` with the same length in which every character
 * that lives inside a double-quoted string, a `#`/`//` line comment, or a
 * `<<EOT`/`<<-EOT` heredoc body is replaced by a space (newlines are kept so
 * line numbers are unaffected). The delimiting quote characters themselves
 * are preserved (so a header like `resource "aws_dynamodb_table" "x" {`
 * still matches literally) - only `{`/`}` characters *inside* a string are
 * blanked, since those are the only string-internal characters that would
 * otherwise confuse brace counting.
 *
 * Throws if a heredoc is opened but never closed, rather than silently
 * treating the remainder of the file as heredoc body.
 */
function maskNonCode(content) {
  const len = content.length;
  const out = content.split('');
  let i = 0;

  while (i < len) {
    const ch = content[i];

    // Heredoc: <<EOT or <<-EOT, with an optionally quoted marker.
    if (ch === '<' && content[i + 1] === '<') {
      const headerMatch = /^<<(-?)"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(content.slice(i));
      if (headerMatch) {
        const indented = headerMatch[1] === '-';
        const marker = headerMatch[2];

        let headerEnd = content.indexOf('\n', i);
        if (headerEnd === -1) headerEnd = len;
        for (let k = i; k < headerEnd; k++) out[k] = ' ';

        let j = headerEnd === len ? len : headerEnd + 1;
        let closed = false;
        while (j < len) {
          let lineEnd = content.indexOf('\n', j);
          if (lineEnd === -1) lineEnd = len;
          const rawLine = content.slice(j, lineEnd).replace(/\r$/, '');
          const candidate = indented ? rawLine.trimStart() : rawLine;
          for (let k = j; k < lineEnd; k++) out[k] = ' ';

          if (candidate === marker) {
            closed = true;
            j = lineEnd === len ? len : lineEnd + 1;
            break;
          }
          j = lineEnd === len ? len : lineEnd + 1;
        }

        if (!closed) {
          throw new Error(
            `maskNonCode: heredoc "<<${indented ? '-' : ''}${marker}" was opened but never closed`
          );
        }
        i = j;
        continue;
      }
    }

    // Double-quoted string: keep the quotes and the literal text, blank only
    // any brace/bracket characters found inside (braces so `${...}`
    // interpolation and `merge(var.tags, { ... })`-shaped text never confuses
    // brace matching; brackets likewise for callers that bracket-match a
    // `Statement = [ ... ]` array, e.g. parsePolicyStatements below).
    if (ch === '"') {
      i++;
      while (i < len) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '{' || content[i] === '}' || content[i] === '[' || content[i] === ']') {
          out[i] = ' ';
          i++;
          continue;
        }
        if (content[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Line comments.
    if (ch === '#' || (ch === '/' && content[i + 1] === '/')) {
      let lineEnd = content.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = len;
      for (let k = i; k < lineEnd; k++) out[k] = ' ';
      i = lineEnd;
      continue;
    }

    i++;
  }

  return out.join('');
}

/**
 * Find the index of the `}` that matches the `{` at `openIndex` in `content`,
 * skipping braces masked out by {@link maskNonCode}. Throws (rather than
 * returning a sentinel) if the braces never balance, so a caller can never
 * silently receive a truncated result.
 */
function findMatchingBrace(content, openIndex) {
  if (content[openIndex] !== '{') {
    throw new Error(`findMatchingBrace: character at index ${openIndex} is not "{"`);
  }
  const masked = maskNonCode(content);
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '{') {
      depth++;
    } else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('findMatchingBrace: unbalanced braces - reached end of content while depth > 0');
}

/**
 * Return the body text of `resource "<resourceType>" "<resourceName>" { ... }`
 * (the text strictly between the outermost braces), or `null` if no resource
 * with that type/name exists in `content`.
 *
 * Comments and heredoc bodies are masked before the header is searched for,
 * so a commented-out resource declaration is never mistaken for a real one.
 */
export function extractResourceBody(content, resourceType, resourceName) {
  const masked = maskNonCode(content);
  const header = new RegExp(`resource\\s+"${resourceType}"\\s+"${resourceName}"\\s*\\{`);
  const match = header.exec(masked);
  if (!match) return null;

  const open = match.index + match[0].length - 1;
  const close = findMatchingBrace(content, open);
  return content.slice(open + 1, close);
}

/**
 * Return the body text of the first top-level nested block named `blockName`
 * (e.g. `ttl { ... }`, `point_in_time_recovery { ... }`,
 * `server_side_encryption { ... }`) found within `body`, or `null` if no such
 * block exists. `body` is normally the result of {@link extractResourceBody}.
 */
export function extractBlock(body, blockName) {
  const masked = maskNonCode(body);
  const header = new RegExp(`(^|[^A-Za-z0-9_])${blockName}\\s*\\{`);
  const match = header.exec(masked);
  if (!match) return null;

  const open = match.index + match[0].length - 1;
  const close = findMatchingBrace(body, open);
  return body.slice(open + 1, close);
}

/** True if the given resource body declares a `ttl { ... }` block. */
export function bodyDeclaresTtlBlock(body) {
  return extractBlock(body, 'ttl') !== null;
}

/**
 * Find the index of the `]` that matches the `[` at `openIndex` in `content`,
 * skipping brackets masked out by {@link maskNonCode}. Throws (rather than
 * returning a sentinel) if the brackets never balance, mirroring
 * {@link findMatchingBrace} for the bracket delimiter.
 */
function findMatchingBracket(content, openIndex) {
  if (content[openIndex] !== '[') {
    throw new Error(`findMatchingBracket: character at index ${openIndex} is not "["`);
  }
  const masked = maskNonCode(content);
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '[') {
      depth++;
    } else if (masked[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('findMatchingBracket: unbalanced brackets - reached end of content while depth > 0');
}

/**
 * Return the text of the `Statement = [ ... ]` array (the text strictly
 * between the outermost brackets) within an inline IAM policy document, e.g.
 * the text produced by {@code jsonencode({ ... })} in an
 * `aws_iam_role_policy`/`aws_iam_policy` resource.
 *
 * The marker is matched by a tolerant pattern (`/Statement\s*=\s*\[/`) rather
 * than a literal string, so `Statement=[` and `Statement  =  [` are both
 * found - a whitespace-only reformat must not disable the least-privilege
 * guard built on top of this (TASK-017, folded in from the TASK-021 review).
 *
 * Throws - rather than returning `null`/`undefined` - when no `Statement`
 * array marker is found, or when its brackets never balance. A guard that
 * cannot find what it is guarding must fail loudly, not skip silently.
 */
export function extractStatementArray(policyText) {
  const masked = maskNonCode(policyText);
  const marker = /Statement\s*=\s*\[/.exec(masked);
  if (!marker) {
    throw new Error(
      'extractStatementArray: no "Statement = [" array found in the policy text - ' +
      'the IAM least-privilege guard cannot verify a policy it cannot parse'
    );
  }

  const open = marker.index + marker[0].length - 1;
  const close = findMatchingBracket(policyText, open);
  return policyText.slice(open + 1, close);
}

/**
 * Split a `Statement = [ ... ]` array body (as returned by
 * {@link extractStatementArray}) into one `{ sid, body }` object per
 * statement object, by brace-matching each top-level `{ ... }` in the array
 * rather than by splitting the text on `Sid` boundaries.
 *
 * Because each statement's `body` is its own complete, brace-matched text,
 * `Sid` (and every other key, such as `Resource`) is attributed to its
 * enclosing statement regardless of where that key appears among the
 * statement's other keys - there is no requirement that `Sid` be first
 * (TASK-017, superseding TASK-021's `assertAllStatementsHaveSidFirst`, which
 * existed only because that version split statements on `Sid` text
 * boundaries rather than on their own brace bodies).
 *
 * Throws if a statement object has no `Sid` attribute, or if no statement
 * objects are found at all, rather than returning a partial result that
 * could let an unscoped `Resource` go unattributed and unnoticed.
 */
export function parsePolicyStatements(statementArrayBody) {
  const masked = maskNonCode(statementArrayBody);
  const statements = [];
  let i = 0;

  while (i < masked.length) {
    if (masked[i] === '{') {
      const close = findMatchingBrace(statementArrayBody, i);
      const body = statementArrayBody.slice(i, close + 1);

      const sidMatch = /Sid\s*=\s*"([^"]+)"/.exec(body);
      if (!sidMatch) {
        throw new Error(
          'parsePolicyStatements: a statement object has no Sid attribute, so its Resource ' +
          `cannot be attributed. Statement starts: ${body.trim().slice(0, 80)}`
        );
      }

      statements.push({ sid: sidMatch[1], body });
      i = close + 1;
    } else {
      i++;
    }
  }

  if (statements.length === 0) {
    throw new Error('parsePolicyStatements: no statement objects ({ ... }) found in the Statement array');
  }

  return statements;
}
