/**
 * Helpers for TASK-050 (Terraform state locking moves from a DynamoDB lock
 * table to S3-native `use_lockfile`).
 *
 * These parse terraform source text and the four `terraform_init_*.sh`
 * scripts. Nothing here opens a network connection, a database connection or
 * an AWS session - every function is pure over strings.
 *
 * `tests/helpers/hcl-blocks.mjs` already extracts *unlabelled* nested blocks,
 * but its masker blanks string literals before matching the header, so it can
 * never match a LABELLED block such as `backend "s3" { ... }`. That is why the
 * labelled-block extractor below exists rather than reusing extractBlock().
 */

/**
 * Replace the contents of comments and double-quoted strings with spaces,
 * preserving length and newlines so indices stay aligned with `content`.
 *
 * This is what lets callers ask "is `dynamodb_table` still referenced in
 * *code*?" without a prose comment that merely mentions the DynamoDB lock
 * table counting as a live reference.
 */
export function maskCommentsAndStrings(content) {
  const out = content.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
    }
  };

  while (i < content.length) {
    const two = content.slice(i, i + 2);
    if (content[i] === '#' || two === '//') {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? content.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? content.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (content[i] === '"') {
      let j = i + 1;
      while (j < content.length) {
        if (content[j] === '\\') { j += 2; continue; }
        if (content[j] === '"') break;
        if (content[j] === '\n') break;
        j++;
      }
      // Blank the inside only; keep the quote characters so a header regex
      // that anchors on them still has something to match against.
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Find the index of the `}` matching the `{` at `openIndex`, ignoring braces
 * that live inside comments or string literals. Throws rather than returning a
 * sentinel if the braces never balance.
 */
function findMatchingBrace(content, openIndex) {
  if (content[openIndex] !== '{') {
    throw new Error(`findMatchingBrace: character at index ${openIndex} is not "{"`);
  }
  // maskCommentsAndStrings blanks the *contents* of comments and strings, so a
  // brace inside a `"${...}"` interpolation or a comment cannot move the depth
  // counter. The surviving quote characters are not braces, so they are inert
  // here.
  const masked = maskCommentsAndStrings(content);
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('findMatchingBrace: unbalanced braces - reached end of content while depth > 0');
}

/**
 * Return the body text (strictly between the outermost braces) of the first
 * block whose header matches `headerSource`, a regex source string that must
 * end just before the opening brace - e.g. `backend\\s+"s3"`. Returns null if
 * no such block exists.
 */
export function extractLabelledBlock(content, headerSource) {
  // Match the header against a copy where comments are blanked (so a
  // commented-out block is never found) but quote characters survive (so the
  // `"s3"` label in the header pattern can still match).
  const searchable = maskCommentsOnly(content);
  const header = new RegExp(`(^|[^A-Za-z0-9_.])${headerSource}\\s*\\{`);
  const match = header.exec(searchable);
  if (!match) return null;

  const open = match.index + match[0].length - 1;
  const close = findMatchingBrace(content, open);
  return content.slice(open + 1, close);
}

/** Blank comment bodies only, leaving string literals fully intact. */
export function maskCommentsOnly(content) {
  const out = content.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
    }
  };
  while (i < content.length) {
    const two = content.slice(i, i + 2);
    if (content[i] === '#' || two === '//') {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? content.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? content.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (content[i] === '"') {
      // Skip over the string so a `#` inside it is not treated as a comment.
      let j = i + 1;
      while (j < content.length) {
        if (content[j] === '\\') { j += 2; continue; }
        if (content[j] === '"' || content[j] === '\n') break;
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Body of the `backend "s3" { ... }` block in provider.tf, or null. */
export function extractBackendS3Block(providerContent) {
  return extractLabelledBlock(providerContent, 'backend\\s+"s3"');
}

/** Body of the top-level `terraform { ... }` block, or null. */
export function extractTerraformBlock(providerContent) {
  return extractLabelledBlock(providerContent, 'terraform');
}

/**
 * Body of a top-level `<name> = { ... }` assignment (how the
 * terraform_remote_state_*_config maps are written in the tfvars), or null.
 */
export function extractMapLiteral(content, name) {
  return extractLabelledBlock(content, `${name}\\s*=`);
}

/**
 * Parse the simple `key = value` assignments directly inside a block body,
 * ignoring anything nested inside a deeper `{ ... }` and ignoring comments.
 * Returns a Map of key -> trimmed raw value text.
 */
export function parseAssignments(body) {
  const masked = maskCommentsOnly(body);
  const result = new Map();
  let depth = 0;
  for (const rawLine of masked.split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/);
      if (m && !m[2].trim().startsWith('{')) {
        result.set(m[1], m[2].trim());
      }
    }
    for (const ch of rawLine) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return result;
}

/** Strip surrounding double quotes from an HCL string literal. */
export function unquote(value) {
  const m = String(value).trim().match(/^"((?:[^"\\]|\\.)*)"$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Terraform version constraint evaluation
// ---------------------------------------------------------------------------

function parseVersion(version) {
  const parts = String(version).trim().replace(/^v/, '').split(/[.+-]/);
  const nums = [];
  for (const part of parts.slice(0, 3)) {
    const n = Number.parseInt(part, 10);
    if (Number.isNaN(n)) break;
    nums.push(n);
  }
  while (nums.length < 3) nums.push(0);
  return nums;
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluate a Terraform version constraint string (e.g. `">= 1.10"`,
 * `"~> 6.19"`, `">= 1.10, < 2.0"`) against a concrete version.
 *
 * Only the operators Terraform actually supports are implemented; an
 * unrecognised operator throws rather than silently returning true, so a
 * constraint this cannot reason about can never masquerade as a pass.
 */
export function constraintAllows(constraint, version) {
  const terms = String(constraint).split(',').map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) {
    throw new Error(`constraintAllows: empty constraint ${JSON.stringify(constraint)}`);
  }
  return terms.every(term => {
    const m = term.match(/^(>=|<=|~>|!=|>|<|=)?\s*(\d[\w.+-]*)$/);
    if (!m) {
      throw new Error(`constraintAllows: unrecognised constraint term ${JSON.stringify(term)}`);
    }
    const op = m[1] || '=';
    const target = m[2];
    const cmp = compareVersions(version, target);
    switch (op) {
      case '=': return cmp === 0;
      case '!=': return cmp !== 0;
      case '>': return cmp > 0;
      case '>=': return cmp >= 0;
      case '<': return cmp < 0;
      case '<=': return cmp <= 0;
      case '~>': {
        // `~> X.Y` allows Y to increase but not X; `~> X.Y.Z` allows Z only.
        if (cmp < 0) return false;
        const segments = target.split('.').length;
        const t = parseVersion(target);
        const v = parseVersion(version);
        if (segments <= 2) return v[0] === t[0];
        return v[0] === t[0] && v[1] === t[1];
      }
      default:
        throw new Error(`constraintAllows: unhandled operator ${op}`);
    }
  });
}

// ---------------------------------------------------------------------------
// terraform_init_*.sh parsing
// ---------------------------------------------------------------------------

/** The four init scripts this ticket touches, in a stable order. */
export const INIT_SCRIPTS = [
  { file: 'terraform_init_dev_au.sh', envShort: 'dev_au', workspace: 'dev-au', profile: 'ohq-dev' },
  { file: 'terraform_init_prod_au.sh', envShort: 'prod_au', workspace: 'prod-au', profile: 'ohq-prod' },
  { file: 'terraform_init_prod_uk.sh', envShort: 'prod_uk', workspace: 'prod-uk', profile: 'ohq-prod' },
  { file: 'terraform_init_prod_us.sh', envShort: 'prod_us', workspace: 'prod-us', profile: 'ohq-prod' }
];

/** The four tfvars files this ticket touches, in a stable order. */
export const TFVARS_FILES = [
  'config/dev/au.tfvars',
  'config/prod/au.tfvars',
  'config/prod/uk.tfvars',
  'config/prod/us.tfvars'
];

/** Both terraform_remote_state config map variable names. */
export const REMOTE_STATE_MAPS = [
  'terraform_remote_state_basestack_config',
  'terraform_remote_state_legacystack_config'
];

/**
 * Statically parse an init script's text. This is deliberately textual: the
 * e2e suite separately *executes* the script with `terraform` shadowed by a
 * shell function, and the two must agree.
 */
export function parseInitScript(content) {
  const backendConfigKeys = [];
  const BACKEND_CONFIG = /-backend-config=\\?"([A-Za-z_][A-Za-z0-9_]*)=/g;
  let m;
  while ((m = BACKEND_CONFIG.exec(content)) !== null) {
    backendConfigKeys.push(m[1]);
  }

  const stateKeyMatch = content.match(/^\s*TF_STATE_KEY\s*=\s*"([^"]*)"/m);
  const workspaceMatch = content.match(/^\s*TF_WORKSPACE\s*=\s*"([^"]*)"/m);

  return {
    backendConfigKeys,
    stateKeyLiteral: stateKeyMatch ? stateKeyMatch[1] : null,
    workspaceLiteral: workspaceMatch ? workspaceMatch[1] : null,
    exportsDdbTableName: /^\s*export\s+DDBTABLENAME\s*=/m.test(content),
    mentionsDdbTableName: /DDBTABLENAME/.test(content),
    mentionsDynamodbTable: /dynamodb_table/.test(content),
    hasCiGuard: /if\s+\[\s+"\$CI"\s+!=\s+"true"\s+\]/.test(content),
    hasProfileBackendConfig: /-backend-config=\\?"profile=/.test(content),
    hasReconfigure: /-reconfigure\b/.test(content),
    hasMigrateState: /-migrate-state\b/.test(content),
    hasWorkspaceSelect: /terraform\s+workspace\s+select\s+-or-create/.test(content)
  };
}
