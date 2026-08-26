/**
 * WAF rule-group parsing and request evaluation for TASK-011.
 *
 * AC 13 ("no rule blocks GET /calendar/api/auth/google/callback with code and
 * state query parameters") says *verified, not assumed*. `terraform plan` and
 * a live `wafv2 check-capacity`/console test both need AWS credentials, which
 * are not available here, so the strongest verification left is to parse the
 * rule group out of HCL into a structure and then actually RUN a request
 * through it in priority order, applying each rule's text transformations and
 * positional constraints. That is executed logic over the real configuration,
 * not a regex looking for a reassuring substring: a rule whose search string
 * is not lower-cased under a LOWERCASE transformation, or an allow rule that
 * sits after the rule it is meant to pre-empt, changes the returned decision.
 *
 * Everything here FAILS LOUDLY. A rule whose statement shape is not
 * recognised, or a field the evaluator cannot supply, throws - it is never
 * silently treated as "does not match", because a parser that quietly returns
 * "no match" would make an allow-rule test pass while proving nothing.
 *
 * Built on tests/helpers/hcl-blocks.mjs (TASK-017), so every lookup is scoped
 * to the block it belongs to rather than to the whole file.
 */

import { extractResourceBody, extractBlock } from './hcl-blocks.mjs';

/** Field kinds a byte_match_statement can inspect. */
export const FIELD_KINDS = [
  'uri_path',
  'method',
  'query_string',
  'all_query_arguments',
  'single_query_argument',
  'body',
  'json_body',
  'single_header',
  'headers',
  'cookies',
];

/**
 * Field kinds that carry credential or request-content material. If the
 * calendar rule group ever inspects one of these, the OAuth `code`/`state`
 * query parameters (or a cookie, or an Authorization header) become something
 * a rule can match on - and therefore block on.
 */
export const CONTENT_BEARING_FIELD_KINDS = [
  'query_string',
  'all_query_arguments',
  'single_query_argument',
  'body',
  'json_body',
  'single_header',
  'headers',
  'cookies',
];

/**
 * Every occurrence of a named nested block within `body`, in source order.
 *
 * {@link extractBlock} returns only the first; a rule group has three `rule`
 * blocks and a byte match can have several `text_transformation` blocks, so
 * repeated extraction is done by consuming the text past each block found.
 *
 * @param {string} body
 * @param {string} blockName
 * @returns {string[]} Each block's body text.
 */
export function extractAllBlocks(body, blockName) {
  const found = [];
  let rest = body;
  // Bounded rather than `while (true)`: a parser bug that failed to advance
  // would otherwise hang the test run instead of failing it.
  for (let guard = 0; guard < 500; guard += 1) {
    const block = extractBlock(rest, blockName);
    if (block === null) return found;
    found.push(block);
    const at = rest.indexOf(block);
    if (at === -1) {
      throw new Error(`extractAllBlocks: could not locate the extracted "${blockName}" body to advance past`);
    }
    rest = rest.slice(at + block.length);
  }
  throw new Error(`extractAllBlocks: more than 500 "${blockName}" blocks - refusing to loop`);
}

/**
 * `body` with the bodies of every named nested block removed, leaving only the
 * arguments declared directly on it. Used so that a rule's own `priority` is
 * read from the rule and not from a nested `text_transformation`.
 *
 * @param {string} body
 * @param {string[]} blockNames
 * @returns {string}
 */
export function stripBlocks(body, blockNames) {
  let stripped = body;
  for (const blockName of blockNames) {
    for (const block of extractAllBlocks(stripped, blockName)) {
      stripped = stripped.replace(block, '\n');
    }
  }
  return stripped;
}

/**
 * Read a top-level `key = value` argument from a block body. Returns the raw
 * right-hand side, trimmed, with surrounding double quotes removed if present,
 * or `null` when the key is absent.
 *
 * The key must not be preceded by an identifier character, so `name` does not
 * match `metric_name`.
 *
 * @param {string} body
 * @param {string} key
 * @returns {string|null}
 */
export function readArgument(body, key) {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${key}[ \\t]*=[ \\t]*([^\\r\\n]+)`);
  const match = pattern.exec(body);
  if (!match) return null;
  const raw = match[1].trim().replace(/[ \t]*(#|\/\/).*$/, '').trim();
  const quoted = /^"(.*)"$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

/**
 * Which single field a `field_to_match` block selects.
 *
 * @param {string} fieldToMatchBody
 * @returns {string}
 */
function parseFieldToMatch(fieldToMatchBody) {
  const present = FIELD_KINDS.filter((kind) => extractBlock(fieldToMatchBody, kind) !== null);
  if (present.length !== 1) {
    throw new Error(
      `parseFieldToMatch: expected exactly one field kind, found [${present.join(', ')}] in ${JSON.stringify(fieldToMatchBody)}`
    );
  }
  return present[0];
}

/**
 * Parse a `byte_match_statement` body.
 *
 * @param {string} body
 * @returns {{kind: 'byte_match', field: string, searchString: string, positionalConstraint: string, transformations: Array<{priority: number, type: string}>}}
 */
function parseByteMatch(body) {
  const searchString = readArgument(stripBlocks(body, ['field_to_match', 'text_transformation']), 'search_string');
  const positionalConstraint = readArgument(
    stripBlocks(body, ['field_to_match', 'text_transformation']),
    'positional_constraint'
  );
  if (searchString === null) throw new Error('parseByteMatch: no search_string');
  if (positionalConstraint === null) throw new Error('parseByteMatch: no positional_constraint');

  const fieldToMatchBody = extractBlock(body, 'field_to_match');
  if (fieldToMatchBody === null) throw new Error('parseByteMatch: no field_to_match block');

  const transformations = extractAllBlocks(body, 'text_transformation').map((transformBody) => {
    const type = readArgument(transformBody, 'type');
    const priority = readArgument(transformBody, 'priority');
    if (type === null) throw new Error('parseByteMatch: text_transformation with no type');
    return { priority: Number(priority), type };
  });
  if (transformations.length === 0) {
    throw new Error('parseByteMatch: a byte_match_statement must declare at least one text_transformation');
  }

  return {
    kind: 'byte_match',
    field: parseFieldToMatch(fieldToMatchBody),
    searchString,
    positionalConstraint,
    transformations,
  };
}

/**
 * Parse a `statement` block body into an evaluable node.
 *
 * @param {string} body
 * @returns {object}
 */
export function parseStatement(body) {
  const rateBased = extractBlock(body, 'rate_based_statement');
  if (rateBased !== null) {
    const scalars = stripBlocks(rateBased, ['scope_down_statement']);
    const limit = readArgument(scalars, 'limit');
    const aggregateKeyType = readArgument(scalars, 'aggregate_key_type');
    if (limit === null) throw new Error('parseStatement: rate_based_statement with no limit');
    const scopeDownBody = extractBlock(rateBased, 'scope_down_statement');
    return {
      kind: 'rate_based',
      limit,
      aggregateKeyType,
      scopeDown: scopeDownBody === null ? null : parseStatement(scopeDownBody),
    };
  }

  const andBody = extractBlock(body, 'and_statement');
  if (andBody !== null) {
    const parts = extractAllBlocks(andBody, 'statement').map(parseStatement);
    if (parts.length < 2) throw new Error('parseStatement: and_statement with fewer than two statements');
    return { kind: 'and', statements: parts };
  }

  const orBody = extractBlock(body, 'or_statement');
  if (orBody !== null) {
    const parts = extractAllBlocks(orBody, 'statement').map(parseStatement);
    if (parts.length < 2) throw new Error('parseStatement: or_statement with fewer than two statements');
    return { kind: 'or', statements: parts };
  }

  const notBody = extractBlock(body, 'not_statement');
  if (notBody !== null) {
    const parts = extractAllBlocks(notBody, 'statement').map(parseStatement);
    if (parts.length !== 1) throw new Error('parseStatement: not_statement must wrap exactly one statement');
    return { kind: 'not', statement: parts[0] };
  }

  const byteMatch = extractBlock(body, 'byte_match_statement');
  if (byteMatch !== null) return parseByteMatch(byteMatch);

  const managed = extractBlock(body, 'managed_rule_group_statement');
  if (managed !== null) {
    return {
      kind: 'managed_rule_group',
      name: readArgument(managed, 'name'),
      vendorName: readArgument(managed, 'vendor_name'),
    };
  }

  throw new Error(`parseStatement: unrecognised statement shape: ${JSON.stringify(body.slice(0, 200))}`);
}

/** Which action a rule's `action` block selects. */
function parseAction(ruleBody) {
  const actionBody = extractBlock(ruleBody, 'action');
  const overrideBody = extractBlock(ruleBody, 'override_action');
  if (actionBody === null && overrideBody === null) {
    throw new Error('parseAction: rule declares neither action nor override_action');
  }
  const source = actionBody === null ? overrideBody : actionBody;
  const kinds = ['allow', 'block', 'count', 'captcha', 'challenge', 'none'].filter(
    (kind) => extractBlock(source, kind) !== null
  );
  if (kinds.length !== 1) {
    throw new Error(`parseAction: expected exactly one action, found [${kinds.join(', ')}]`);
  }
  return kinds[0];
}

/**
 * Parse a `visibility_config` block.
 *
 * @param {string} body
 * @returns {{cloudwatchMetricsEnabled: boolean, metricName: string, sampledRequestsEnabled: boolean}}
 */
export function parseVisibilityConfig(body) {
  const cloudwatch = readArgument(body, 'cloudwatch_metrics_enabled');
  const metricName = readArgument(body, 'metric_name');
  const sampled = readArgument(body, 'sampled_requests_enabled');
  if (cloudwatch === null || sampled === null) {
    throw new Error(`parseVisibilityConfig: incomplete visibility_config: ${JSON.stringify(body)}`);
  }
  return {
    cloudwatchMetricsEnabled: cloudwatch === 'true',
    metricName,
    sampledRequestsEnabled: sampled === 'true',
  };
}

/**
 * Parse an `aws_wafv2_rule_group` resource out of HCL.
 *
 * @param {string} content Full .tf file text.
 * @param {string} resourceName
 * @returns {{name: string, scope: string, capacity: string, rules: Array<object>, visibility: object, body: string}}
 */
export function parseRuleGroup(content, resourceName) {
  const body = extractResourceBody(content, 'aws_wafv2_rule_group', resourceName);
  if (body === null) throw new Error(`parseRuleGroup: no aws_wafv2_rule_group "${resourceName}" in the given content`);

  const ruleBodies = extractAllBlocks(body, 'rule');
  if (ruleBodies.length === 0) throw new Error(`parseRuleGroup: rule group "${resourceName}" declares no rules`);

  const rules = ruleBodies.map((ruleBody) => {
    const scalars = stripBlocks(ruleBody, ['action', 'override_action', 'statement', 'visibility_config']);
    const name = readArgument(scalars, 'name');
    const priority = readArgument(scalars, 'priority');
    if (name === null) throw new Error('parseRuleGroup: rule with no name');
    if (priority === null) throw new Error(`parseRuleGroup: rule "${name}" has no priority`);

    const statementBody = extractBlock(ruleBody, 'statement');
    if (statementBody === null) throw new Error(`parseRuleGroup: rule "${name}" has no statement`);

    const visibilityBody = extractBlock(ruleBody, 'visibility_config');
    if (visibilityBody === null) throw new Error(`parseRuleGroup: rule "${name}" has no visibility_config`);

    return {
      name,
      priority: Number(priority),
      action: parseAction(ruleBody),
      statement: parseStatement(statementBody),
      visibility: parseVisibilityConfig(visibilityBody),
    };
  });

  // The group-level visibility_config is whatever is left once every rule has
  // been removed, so a rule's own block can never be mistaken for it.
  let residual = body;
  for (const ruleBody of ruleBodies) residual = residual.replace(ruleBody, '\n');
  const groupVisibility = extractBlock(residual, 'visibility_config');
  if (groupVisibility === null) throw new Error(`parseRuleGroup: rule group "${resourceName}" has no visibility_config`);

  const scalars = stripBlocks(body, ['rule', 'visibility_config']);
  return {
    name: readArgument(scalars, 'name'),
    scope: readArgument(scalars, 'scope'),
    capacity: readArgument(scalars, 'capacity'),
    rules,
    visibility: parseVisibilityConfig(groupVisibility),
    body,
  };
}

/** Apply one WAF text transformation. */
function applyTransformation(value, type) {
  switch (type) {
    case 'NONE':
      return value;
    case 'LOWERCASE':
      return value.toLowerCase();
    case 'COMPRESS_WHITE_SPACE':
      return value.replace(/[\t\n\v\f\r ]+/g, ' ');
    case 'URL_DECODE':
      return decodeURIComponent(value);
    default:
      throw new Error(`applyTransformation: unsupported text transformation "${type}"`);
  }
}

/** The request field a byte match inspects. Throws for anything unsupplied. */
function readRequestField(request, field) {
  switch (field) {
    case 'uri_path':
      if (typeof request.uriPath !== 'string') throw new Error('evaluate: request has no uriPath');
      return request.uriPath;
    case 'method':
      if (typeof request.method !== 'string') throw new Error('evaluate: request has no method');
      return request.method;
    case 'query_string':
      if (typeof request.queryString !== 'string') throw new Error('evaluate: request has no queryString');
      return request.queryString;
    default:
      throw new Error(`evaluate: this evaluator cannot supply the "${field}" field`);
  }
}

/** Does a parsed statement match the request? */
export function statementMatches(statement, request) {
  switch (statement.kind) {
    case 'byte_match': {
      let value = readRequestField(request, statement.field);
      const ordered = [...statement.transformations].sort((a, b) => a.priority - b.priority);
      for (const transformation of ordered) value = applyTransformation(value, transformation.type);
      switch (statement.positionalConstraint) {
        case 'EXACTLY':
          return value === statement.searchString;
        case 'STARTS_WITH':
          return value.startsWith(statement.searchString);
        case 'ENDS_WITH':
          return value.endsWith(statement.searchString);
        case 'CONTAINS':
          return value.includes(statement.searchString);
        default:
          throw new Error(`evaluate: unsupported positional_constraint "${statement.positionalConstraint}"`);
      }
    }
    case 'and':
      return statement.statements.every((part) => statementMatches(part, request));
    case 'or':
      return statement.statements.some((part) => statementMatches(part, request));
    case 'not':
      return !statementMatches(statement.statement, request);
    case 'rate_based':
      // Scope-down decides whether the request is COUNTED by this rule; being
      // over the limit is a separate input to evaluateRuleGroup.
      return statement.scopeDown === null ? true : statementMatches(statement.scopeDown, request);
    default:
      throw new Error(`evaluate: cannot evaluate a "${statement.kind}" statement`);
  }
}

/**
 * Run a request through the parsed rules in ascending priority order.
 *
 * @param {Array<object>} rules From {@link parseRuleGroup}.
 * @param {{method: string, uriPath: string, queryString?: string}} request
 * @param {{overLimitRules?: string[]}} [options] Names of rate-based rules
 *   whose per-IP limit this request has already exceeded.
 * @returns {{decision: 'allow'|'block'|'no-match', ruleName: string|null, countedBy: string[], evaluated: string[]}}
 */
export function evaluateRuleGroup(rules, request, { overLimitRules = [] } = {}) {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  const countedBy = [];
  const evaluated = [];

  for (const rule of ordered) {
    evaluated.push(rule.name);
    if (!statementMatches(rule.statement, request)) continue;

    if (rule.statement.kind === 'rate_based') {
      countedBy.push(rule.name);
      if (!overLimitRules.includes(rule.name)) continue;
    }

    if (rule.action === 'allow' || rule.action === 'block') {
      return { decision: rule.action, ruleName: rule.name, countedBy, evaluated };
    }
    // count / none are non-terminating.
  }

  return { decision: 'no-match', ruleName: null, countedBy, evaluated };
}
