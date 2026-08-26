/**
 * Unit tests for terraform/alerting.tf and terraform/waf_calendar.tf (TASK-011).
 *
 * Every assertion below is BLOCK SCOPED through tests/helpers/hcl-blocks.mjs
 * and tests/helpers/waf-rules.mjs: a whole-file `content.includes('...')`
 * cannot tell which resource a flag belongs to, so it stays green when a flag
 * is switched off in one alarm while another still sets it (TASK-017). The
 * WAF rules are not merely inspected either - they are parsed into a structure
 * and a request is actually run through them (see tests/helpers/waf-rules.mjs).
 *
 * Every structural claim that matters is additionally proved by MUTATION: the
 * file text is mutated in memory, the assertion is shown to go red, and the
 * unmutated file is shown to be green. Each mutation guards itself with
 * `assert.notStrictEqual(mutated, original, ...)` first - a mutation that
 * silently no-ops (the exact defect TASK-099 found in a CRLF worktree) would
 * otherwise "pass" while proving nothing. For that reason no mutation here
 * hardcodes a `\n`; they all match `\r?\n` or stay within one line.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractResourceBody, extractBlock } from '../helpers/hcl-blocks.mjs';
import {
  parseRuleGroup,
  parseStatement,
  parseVisibilityConfig,
  evaluateRuleGroup,
  extractAllBlocks,
  readArgument,
  CONTENT_BEARING_FIELD_KINDS,
} from '../helpers/waf-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const ALERTING_TF = path.join(TERRAFORM_DIR, 'alerting.tf');
const WAF_TF = path.join(TERRAFORM_DIR, 'waf_calendar.tf');

const alertingContent = fs.readFileSync(ALERTING_TF, 'utf-8');
const wafContent = fs.readFileSync(WAF_TF, 'utf-8');

/** The SNS guard every alarm must carry, whitespace-normalised for comparison. */
const SNS_GUARD = 'var.Alert_SNS_ARN == "" ? 0 : 1';

/**
 * Names of every `resource "<type>" "<name>"` declared in `content`, skipping
 * comment lines so a commented-out example (this file has several, including a
 * whole basestack `rule { ... }` snippet) is never counted as a declaration.
 *
 * @param {string} content
 * @param {string} type
 * @returns {string[]}
 */
function resourceNamesOfType(content, type) {
  const header = new RegExp(`^\\s*resource\\s+"${type}"\\s+"([A-Za-z0-9_-]+)"`);
  const names = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match = header.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * A resource body with `dimensions = { ... }` rewritten as a `dimensions { }`
 * block so the shared block extractor can scope to it. Only the assignment
 * form differs; the braces are the same.
 */
function withDimensionsAsBlock(body) {
  return body.replace(/dimensions\s*=\s*\{/, 'dimensions {');
}

/** Body of the named metric alarm, or a failing assertion naming it. */
function alarmBody(content, name) {
  const body = extractResourceBody(content, 'aws_cloudwatch_metric_alarm', name);
  assert.ok(body, `aws_cloudwatch_metric_alarm "${name}" not found in alerting.tf`);
  return body;
}

/** Body of the named log metric filter, or a failing assertion naming it. */
function filterBody(content, name) {
  const body = extractResourceBody(content, 'aws_cloudwatch_log_metric_filter', name);
  assert.ok(body, `aws_cloudwatch_log_metric_filter "${name}" not found in alerting.tf`);
  return body;
}

/** Collapse runs of whitespace, so a reformat does not change an argument's meaning. */
function squash(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Apply `mutate` to `original` and refuse to continue if nothing changed.
 * Modelled on the guard that made TASK-099 visible.
 */
function mutate(original, mutateFn, description) {
  const mutated = mutateFn(original);
  assert.notStrictEqual(mutated, original, `fixture mutation did not apply: ${description}`);
  return mutated;
}

const EXPECTED_ALARMS = [
  'calendar_lambda_errors',
  'calendar_lambda_throttles',
  'calendar_extraction_failures',
  'calendar_reauth_required',
  'calendar_target_group_unhealthy_hosts',
];

describe('Unit: terraform/alerting.tf (TASK-011)', () => {
  describe('AC 1: Lambda Errors and Throttles alarms, dimensioned to the function', () => {
    it('declares an Errors alarm on AWS/Lambda dimensioned to the calendar function name', () => {
      const body = alarmBody(alertingContent, 'calendar_lambda_errors');
      assert.strictEqual(readArgument(body, 'namespace'), 'AWS/Lambda');
      assert.strictEqual(readArgument(body, 'metric_name'), 'Errors');
      assert.strictEqual(readArgument(body, 'comparison_operator'), 'GreaterThanThreshold');
      assert.strictEqual(readArgument(body, 'threshold'), '0', 'any invocation error is worth notifying on');

      const dimensions = extractBlock(withDimensionsAsBlock(body), 'dimensions');
      assert.ok(dimensions, 'the Errors alarm must declare a dimensions map');
      assert.strictEqual(
        readArgument(dimensions, 'FunctionName'),
        'aws_lambda_function.calendar.function_name',
        'dimensioned to the calendar function, not to every Lambda in the account'
      );
    });

    it('declares a Throttles alarm on AWS/Lambda dimensioned to the calendar function name', () => {
      const body = alarmBody(alertingContent, 'calendar_lambda_throttles');
      assert.strictEqual(readArgument(body, 'namespace'), 'AWS/Lambda');
      assert.strictEqual(readArgument(body, 'metric_name'), 'Throttles');

      const dimensions = extractBlock(withDimensionsAsBlock(body), 'dimensions');
      assert.ok(dimensions, 'the Throttles alarm must declare a dimensions map');
      assert.strictEqual(readArgument(dimensions, 'FunctionName'), 'aws_lambda_function.calendar.function_name');
    });

    it('MUTATION: an alarm dimensioned to the wrong function is caught', () => {
      const mutated = mutate(
        alertingContent,
        (content) => content.replace('FunctionName = aws_lambda_function.calendar.function_name', 'FunctionName = "some-other-fn"'),
        'retarget FunctionName'
      );
      const dimensions = extractBlock(withDimensionsAsBlock(alarmBody(mutated, 'calendar_lambda_errors')), 'dimensions');
      assert.strictEqual(
        readArgument(dimensions, 'FunctionName'),
        'some-other-fn',
        'the mutated fixture reads back the wrong function, so the real assertion above is load-bearing'
      );
    });
  });

  describe('AC 2: every alarm is guarded by count = var.Alert_SNS_ARN == "" ? 0 : 1', () => {
    it('declares exactly the five expected alarms and no unguarded extras', () => {
      const declared = resourceNamesOfType(alertingContent, 'aws_cloudwatch_metric_alarm');
      assert.deepStrictEqual(
        [...declared].sort(),
        [...EXPECTED_ALARMS].sort(),
        'alerting.tf declares a different set of alarms than this test knows about'
      );
    });

    it('every declared alarm carries the guard - enumerated, not hardcoded', () => {
      const declared = resourceNamesOfType(alertingContent, 'aws_cloudwatch_metric_alarm');
      assert.ok(declared.length >= 5, `expected at least 5 alarms, found ${declared.length}`);
      for (const name of declared) {
        const count = readArgument(alarmBody(alertingContent, name), 'count');
        assert.strictEqual(
          squash(count),
          SNS_GUARD,
          `alarm "${name}" must be guarded by count = ${SNS_GUARD} so dev/au (Alert_SNS_ARN = "") still applies`
        );
      }
    });

    it('MUTATION: an alarm added without the guard fails the enumeration', () => {
      const mutated = mutate(
        alertingContent,
        (content) =>
          content.replace(
            /resource "aws_cloudwatch_metric_alarm" "calendar_lambda_throttles" \{\r?\n\s*count = [^\r\n]+\r?\n/,
            'resource "aws_cloudwatch_metric_alarm" "calendar_lambda_throttles" {\n'
          ),
        'strip the count guard off the Throttles alarm'
      );

      const declared = resourceNamesOfType(mutated, 'aws_cloudwatch_metric_alarm');
      const unguarded = declared.filter((name) => {
        const count = readArgument(extractResourceBody(mutated, 'aws_cloudwatch_metric_alarm', name), 'count');
        return squash(count) !== SNS_GUARD;
      });
      assert.deepStrictEqual(
        unguarded,
        ['calendar_lambda_throttles'],
        'the guard sweep must name exactly the alarm whose count was removed'
      );
    });

    it('the metric FILTERS are deliberately not guarded - counts are free and give the alarms history', () => {
      for (const name of resourceNamesOfType(alertingContent, 'aws_cloudwatch_log_metric_filter')) {
        assert.strictEqual(
          readArgument(filterBody(alertingContent, name), 'count'),
          null,
          `metric filter "${name}" must exist in every environment, including one with no SNS topic`
        );
      }
    });
  });

  describe('AC 4 and 5: log metric filters for the two alarm tokens', () => {
    it('declares exactly the two expected metric filters', () => {
      assert.deepStrictEqual(
        resourceNamesOfType(alertingContent, 'aws_cloudwatch_log_metric_filter').sort(),
        ['calendar_extraction_failed', 'calendar_reauth_required']
      );
    });

    for (const [resourceName, localName, metricName] of [
      ['calendar_extraction_failed', 'calendar_extraction_failed_token', 'CalendarExtractionFailedCount'],
      ['calendar_reauth_required', 'calendar_reauth_required_token', 'CalendarReauthRequiredCount'],
    ]) {
      it(`${resourceName} matches the token as a quoted term and emits a count-only metric`, () => {
        const body = filterBody(alertingContent, resourceName);
        // In HCL the pattern is written `"\"${local.<token>}\""`, so once the
        // outer quotes are stripped the argument still carries the escaped
        // inner quotes that make it a CloudWatch QUOTED TERM (an unquoted
        // pattern would be parsed as a filter expression, not a term).
        assert.strictEqual(
          readArgument(body, 'pattern'),
          '\\"${local.' + localName + '}\\"',
          'the filter pattern must be the token as a quoted CloudWatch term, built from the local'
        );
        assert.strictEqual(readArgument(body, 'log_group_name'), 'local.calendar_log_group_name');

        const transformation = extractBlock(body, 'metric_transformation');
        assert.ok(transformation, `${resourceName} must declare a metric_transformation`);
        assert.strictEqual(readArgument(transformation, 'name'), metricName);
        assert.strictEqual(readArgument(transformation, 'namespace'), 'local.calendar_metric_namespace');
        assert.strictEqual(
          readArgument(transformation, 'value'),
          '1',
          'AC 15: the metric must be a literal count, never a value extracted from the log event'
        );
        assert.strictEqual(readArgument(transformation, 'default_value'), '0');
      });
    }

    it('each filter has an alarm wired to its own metric_transformation, not to a hand-typed name', () => {
      const extraction = alarmBody(alertingContent, 'calendar_extraction_failures');
      assert.strictEqual(
        readArgument(extraction, 'metric_name'),
        'aws_cloudwatch_log_metric_filter.calendar_extraction_failed.metric_transformation[0].name'
      );
      assert.strictEqual(
        readArgument(extraction, 'namespace'),
        'aws_cloudwatch_log_metric_filter.calendar_extraction_failed.metric_transformation[0].namespace'
      );
      assert.strictEqual(readArgument(extraction, 'comparison_operator'), 'GreaterThanThreshold');
      assert.strictEqual(readArgument(extraction, 'threshold'), '5');
      assert.strictEqual(readArgument(extraction, 'period'), '300');

      const reauth = alarmBody(alertingContent, 'calendar_reauth_required');
      assert.strictEqual(
        readArgument(reauth, 'metric_name'),
        'aws_cloudwatch_log_metric_filter.calendar_reauth_required.metric_transformation[0].name'
      );
      assert.strictEqual(readArgument(reauth, 'threshold'), '10');
      assert.strictEqual(
        readArgument(reauth, 'period'),
        '3600',
        'a mass revocation is measured over an hour: scheduled scans are spread across the day'
      );
    });
  });

  describe('AC 6: ALB target-group UnHealthyHostCount alarm', () => {
    it('alarms on the calendar target group with both required ALB dimensions', () => {
      const body = alarmBody(alertingContent, 'calendar_target_group_unhealthy_hosts');
      assert.strictEqual(readArgument(body, 'namespace'), 'AWS/ApplicationELB');
      assert.strictEqual(readArgument(body, 'metric_name'), 'UnHealthyHostCount');
      assert.strictEqual(readArgument(body, 'statistic'), 'Maximum');
      assert.strictEqual(readArgument(body, 'threshold'), '0');

      const dimensions = extractBlock(withDimensionsAsBlock(body), 'dimensions');
      assert.ok(dimensions, 'the target-group alarm must declare a dimensions map');
      assert.strictEqual(
        readArgument(dimensions, 'TargetGroup'),
        'aws_lb_target_group.calendar_lambda_tg.arn_suffix',
        'the metric dimension is the arn_suffix, not the ARN'
      );
      assert.strictEqual(readArgument(dimensions, 'LoadBalancer'), 'data.aws_lb.web_app_alb.arn_suffix');
    });
  });

  describe('AC 7: the metric-filter / log-group ordering problem', () => {
    it('every metric filter depends_on the managed log group', () => {
      for (const name of resourceNamesOfType(alertingContent, 'aws_cloudwatch_log_metric_filter')) {
        const dependsOn = readArgument(filterBody(alertingContent, name), 'depends_on');
        assert.strictEqual(
          squash(dependsOn),
          '[aws_cloudwatch_log_group.calendar_lambda_logs]',
          `metric filter "${name}" must be ordered after the managed log group`
        );
      }
    });

    it('and the flag a fresh environment must set is named in a comment', () => {
      const commentLines = alertingContent
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('#'))
        .join(' ');
      assert.strictEqual(
        commentLines.includes('var.manage_lambda_log_groups'),
        true,
        'AC 7 requires the ordering problem be resolved with depends_on OR documented naming var.manage_lambda_log_groups - this file does both'
      );
    });
  });

  describe('AC 15: nothing in alerting.tf can carry credentials or request content', () => {
    it('declares no log destination of its own', () => {
      for (const type of [
        'aws_cloudwatch_log_subscription_filter',
        'aws_kinesis_firehose_delivery_stream',
        'aws_wafv2_web_acl_logging_configuration',
        'aws_cloudwatch_log_destination',
      ]) {
        assert.deepStrictEqual(
          resourceNamesOfType(alertingContent, type),
          [],
          `alerting.tf must not declare a ${type}`
        );
      }
    });

    it('no alarm or filter argument references a body, cookie or Authorization header', () => {
      const forbidden = /\$\.(body|cookie|authorization|headers)|"?Cookie"?|Authorization/i;
      const codeOnly = alertingContent
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      const offending = codeOnly.split(/\r?\n/).filter((line) => forbidden.test(line));
      assert.deepStrictEqual(offending, [], 'no non-comment line may reference request content');
    });

    it('every metric_transformation emits a constant, so no matched log text becomes a metric value', () => {
      for (const name of resourceNamesOfType(alertingContent, 'aws_cloudwatch_log_metric_filter')) {
        const transformation = extractBlock(filterBody(alertingContent, name), 'metric_transformation');
        const value = readArgument(transformation, 'value');
        assert.match(value, /^\d+$/, `metric filter "${name}" must emit a literal count, got ${JSON.stringify(value)}`);
      }
    });
  });
});

describe('Unit: terraform/waf_calendar.tf rule group (TASK-011)', () => {
  const ruleGroup = parseRuleGroup(wafContent, 'calendar_protection');
  const byName = Object.fromEntries(ruleGroup.rules.map((rule) => [rule.name, rule]));

  describe('Rule group shape', () => {
    it('is a REGIONAL rule group with an immutable capacity reserved with headroom', () => {
      assert.strictEqual(ruleGroup.scope, 'REGIONAL', 'an ALB is a regional scope, not CLOUDFRONT');
      assert.match(ruleGroup.capacity, /^\d+$/, 'capacity must be a literal number');
      assert.ok(Number(ruleGroup.capacity) >= 50, `capacity ${ruleGroup.capacity} is below the rules' consumption`);
    });

    it('declares exactly the three expected rules at distinct priorities', () => {
      assert.deepStrictEqual(
        ruleGroup.rules.map((rule) => [rule.priority, rule.name, rule.action]).sort((a, b) => a[0] - b[0]),
        [
          [1, 'calendar-scan-rate-limit', 'block'],
          [2, 'calendar-oauth-callback-allow', 'allow'],
          [3, 'calendar-rate-limit', 'block'],
        ]
      );
      const priorities = ruleGroup.rules.map((rule) => rule.priority);
      assert.strictEqual(new Set(priorities).size, priorities.length, 'WAF rejects duplicate priorities');
    });

    it('declares no web ACL and no association of its own - the shared ALB already has one', () => {
      for (const type of ['aws_wafv2_web_acl', 'aws_wafv2_web_acl_association']) {
        assert.deepStrictEqual(resourceNamesOfType(wafContent, type), [], `waf_calendar.tf must not declare a ${type}`);
      }
    });
  });

  describe('AC 8 and 10: the two rate-based rules', () => {
    it('the baseline rule limits /calendar* per IP using var.calendar_waf_rate_limit', () => {
      const rule = byName['calendar-rate-limit'];
      assert.strictEqual(rule.statement.kind, 'rate_based');
      assert.strictEqual(rule.statement.limit, 'var.calendar_waf_rate_limit', 'the limit must come from the variable');
      assert.strictEqual(rule.statement.aggregateKeyType, 'IP', 'per IP, not per forwarded key');
      assert.strictEqual(rule.statement.scopeDown.field, 'uri_path');
      assert.strictEqual(rule.statement.scopeDown.searchString, '/calendar');
      assert.strictEqual(rule.statement.scopeDown.positionalConstraint, 'STARTS_WITH');
      assert.strictEqual(rule.action, 'block');
    });

    it('the scan rule limits /calendar/api/scan per IP using var.calendar_scan_rate_limit', () => {
      const rule = byName['calendar-scan-rate-limit'];
      assert.strictEqual(rule.statement.kind, 'rate_based');
      assert.strictEqual(rule.statement.limit, 'var.calendar_scan_rate_limit');
      assert.strictEqual(rule.statement.aggregateKeyType, 'IP');
      assert.strictEqual(rule.statement.scopeDown.searchString, '/calendar/api/scan');
      assert.strictEqual(rule.action, 'block');
    });

    it('the stricter rule is evaluated first, so a scan is blocked by the tighter bound', () => {
      assert.ok(
        byName['calendar-scan-rate-limit'].priority < byName['calendar-rate-limit'].priority,
        'the scan limit must be evaluated before the broad limit or it can never terminate first'
      );
    });

    it('every byte-match search string is already in the form its transformations produce', () => {
      // A LOWERCASE transformation is applied to the FIELD, not to the search
      // string: an upper-case literal here would simply never match. This is
      // the class of bug the evaluator below actually catches.
      const byteMatches = [];
      const collect = (statement) => {
        if (statement.kind === 'byte_match') byteMatches.push(statement);
        if (statement.kind === 'rate_based' && statement.scopeDown) collect(statement.scopeDown);
        if (statement.statements) statement.statements.forEach(collect);
        if (statement.statement) collect(statement.statement);
      };
      ruleGroup.rules.forEach((rule) => collect(rule.statement));
      assert.strictEqual(byteMatches.length, 4, 'four byte matches: two scope-downs plus the callback path and method');

      for (const match of byteMatches) {
        const lowercases = match.transformations.some((transformation) => transformation.type === 'LOWERCASE');
        if (lowercases) {
          assert.strictEqual(
            match.searchString,
            match.searchString.toLowerCase(),
            `search string ${JSON.stringify(match.searchString)} can never match under a LOWERCASE transformation`
          );
        }
      }
    });
  });

  describe('AC 13: the OAuth callback is never blocked by this rule group', () => {
    const callbackRequest = {
      method: 'GET',
      uriPath: '/calendar/api/auth/google/callback',
      queryString: 'code=4%2F0AeanS0YlongOpaqueValue-with_dashes&state=9f2c1b7e4d5a6f8091a2b3c4d5e6f708&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly',
    };

    it('a GET carrying code and state is terminally ALLOWED, even with both rate limits already exceeded', () => {
      const result = evaluateRuleGroup(ruleGroup.rules, callbackRequest, {
        overLimitRules: ['calendar-scan-rate-limit', 'calendar-rate-limit'],
      });
      assert.strictEqual(result.decision, 'allow', `expected allow, got ${result.decision} from ${result.ruleName}`);
      assert.strictEqual(result.ruleName, 'calendar-oauth-callback-allow');
      assert.deepStrictEqual(
        result.countedBy,
        [],
        'the allow terminates before the baseline limit, so a NATted school burst never accumulates against the callback'
      );
    });

    it('no rule in the group inspects the query string, a cookie, a header or a body at all', () => {
      const fields = new Set();
      const collect = (statement) => {
        if (statement.kind === 'byte_match') fields.add(statement.field);
        if (statement.kind === 'rate_based' && statement.scopeDown) collect(statement.scopeDown);
        if (statement.statements) statement.statements.forEach(collect);
        if (statement.statement) collect(statement.statement);
      };
      ruleGroup.rules.forEach((rule) => collect(rule.statement));

      assert.deepStrictEqual([...fields].sort(), ['method', 'uri_path'], 'only the method and path are inspected');
      for (const kind of CONTENT_BEARING_FIELD_KINDS) {
        assert.strictEqual(fields.has(kind), false, `no rule may inspect "${kind}" - that is where code and state live`);
      }
    });

    it('the path match is case-insensitive, so an odd-cased callback URL is still allowed', () => {
      const result = evaluateRuleGroup(ruleGroup.rules, {
        ...callbackRequest,
        uriPath: '/Calendar/API/Auth/Google/Callback',
      });
      assert.strictEqual(result.decision, 'allow', 'the LOWERCASE transformation must apply to the path');
    });

    it('MUTATION: an upper-cased search string under LOWERCASE stops allowing the callback', () => {
      const mutated = mutate(
        wafContent,
        (content) => content.replace('"/calendar/api/auth/google/callback"', '"/Calendar/API/auth/google/callback"'),
        'upper-case the callback path literal'
      );
      const result = evaluateRuleGroup(parseRuleGroup(mutated, 'calendar_protection').rules, callbackRequest, {
        overLimitRules: ['calendar-rate-limit'],
      });
      assert.strictEqual(
        result.decision,
        'block',
        'with the allow rule unable to match, the callback falls through to the baseline limit - proving the allow is what saves it'
      );
      assert.strictEqual(result.ruleName, 'calendar-rate-limit');
    });

    it('MUTATION: demoting the allow below the baseline limit stops protecting the callback', () => {
      const mutated = mutate(
        wafContent,
        (content) =>
          content.replace(
            /name\s*=\s*"calendar-oauth-callback-allow"(\s*\r?\n\s*priority\s*=\s*)2/,
            'name     = "calendar-oauth-callback-allow"$19'
          ),
        'move the callback allow to priority 9'
      );
      const rules = parseRuleGroup(mutated, 'calendar_protection').rules;
      assert.strictEqual(rules.find((r) => r.name === 'calendar-oauth-callback-allow').priority, 9, 'mutation took effect');

      const result = evaluateRuleGroup(rules, callbackRequest, { overLimitRules: ['calendar-rate-limit'] });
      assert.strictEqual(
        result.decision,
        'block',
        'ordering is load-bearing: an allow evaluated after the rate limit cannot rescue the request'
      );
    });

    it('EDGE: a POST to the callback path is NOT allow-listed - the allow is scoped to GET', () => {
      const result = evaluateRuleGroup(
        ruleGroup.rules,
        { ...callbackRequest, method: 'POST' },
        { overLimitRules: ['calendar-rate-limit'] }
      );
      assert.strictEqual(result.decision, 'block', 'the method is part of the allow, so a POST falls through');
      assert.strictEqual(result.ruleName, 'calendar-rate-limit');
    });

    it('EDGE: /calendar/api/scan is rate limited by the scan rule, not rescued by the callback allow', () => {
      const overLimit = evaluateRuleGroup(
        ruleGroup.rules,
        { method: 'POST', uriPath: '/calendar/api/scan', queryString: '' },
        { overLimitRules: ['calendar-scan-rate-limit'] }
      );
      assert.strictEqual(overLimit.decision, 'block');
      assert.strictEqual(overLimit.ruleName, 'calendar-scan-rate-limit');

      const underLimit = evaluateRuleGroup(ruleGroup.rules, {
        method: 'POST',
        uriPath: '/calendar/api/scan',
        queryString: '',
      });
      assert.strictEqual(underLimit.decision, 'no-match', 'under the limit the request passes');
      assert.deepStrictEqual(
        underLimit.countedBy,
        ['calendar-scan-rate-limit', 'calendar-rate-limit'],
        'a scan is counted by both limits, and the stricter one bites first'
      );
    });

    it('EDGE: a path outside /calendar is untouched by this rule group', () => {
      const result = evaluateRuleGroup(
        ruleGroup.rules,
        { method: 'GET', uriPath: '/chatbot/api/chat', queryString: '' },
        { overLimitRules: ['calendar-rate-limit', 'calendar-scan-rate-limit'] }
      );
      assert.strictEqual(result.decision, 'no-match');
      assert.deepStrictEqual(result.countedBy, [], 'nothing outside /calendar is counted');
    });
  });

  describe('AC 15: no WAF configuration can capture credentials', () => {
    it('sampled_requests_enabled is false on every rule and on the rule group itself', () => {
      assert.strictEqual(
        ruleGroup.visibility.sampledRequestsEnabled,
        false,
        'a sampled request retains cookies, Authorization and the live OAuth code'
      );
      for (const rule of ruleGroup.rules) {
        assert.strictEqual(
          rule.visibility.sampledRequestsEnabled,
          false,
          `rule "${rule.name}" must not sample requests`
        );
      }
      assert.strictEqual(ruleGroup.rules.length + 1, 4, 'four visibility_config blocks were checked');
    });

    it('cloudwatch_metrics_enabled stays true - counts carry no request content', () => {
      assert.strictEqual(ruleGroup.visibility.cloudwatchMetricsEnabled, true);
      for (const rule of ruleGroup.rules) {
        assert.strictEqual(rule.visibility.cloudwatchMetricsEnabled, true, `rule "${rule.name}" should publish counts`);
      }
    });

    it('MUTATION: flipping sampling on in a single rule is caught block-by-block', () => {
      // The point of block scoping: only ONE of the four blocks changes, and a
      // whole-file `includes('sampled_requests_enabled   = false')` would stay
      // green because three others still say false.
      const mutated = mutate(
        wafContent,
        (content) =>
          content.replace(
            /metric_name\s*=\s*"\$\{local\.name_prefix\}-calendar-oauth-callback-allow"([\s\S]{0,400}?)sampled_requests_enabled\s*=\s*false/,
            (full, between) =>
              full.replace(/sampled_requests_enabled\s*=\s*false$/, 'sampled_requests_enabled = true')
          ),
        'enable sampled requests on the OAuth callback rule only'
      );

      const mutatedGroup = parseRuleGroup(mutated, 'calendar_protection');
      const offending = mutatedGroup.rules.filter((rule) => rule.visibility.sampledRequestsEnabled === true);
      assert.deepStrictEqual(
        offending.map((rule) => rule.name),
        ['calendar-oauth-callback-allow'],
        'the per-block check must name exactly the rule that was flipped'
      );
      assert.strictEqual(
        mutatedGroup.visibility.sampledRequestsEnabled,
        false,
        'the group-level block is unaffected, which is precisely why a whole-file check would miss this'
      );
    });

    it('declares no logging configuration anywhere in the terraform directory', () => {
      const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((file) => file.endsWith('.tf'));
      assert.ok(tfFiles.length >= 6, `expected the terraform directory to hold several files, found ${tfFiles.length}`);
      for (const file of tfFiles) {
        const content = fs.readFileSync(path.join(TERRAFORM_DIR, file), 'utf-8');
        assert.deepStrictEqual(
          resourceNamesOfType(content, 'aws_wafv2_web_acl_logging_configuration'),
          [],
          `${file} must not create a WAF logging destination - the chatbot has none`
        );
      }
    });
  });
});

describe('Unit: the WAF parser fails loudly rather than silently passing (TASK-011)', () => {
  it('throws when the named rule group does not exist', () => {
    assert.throws(
      () => parseRuleGroup(wafContent, 'not_a_rule_group'),
      /no aws_wafv2_rule_group "not_a_rule_group"/,
      'a typo in the resource name must throw, not return an empty rule list that trivially "passes"'
    );
  });

  it('throws on a statement shape it does not understand', () => {
    assert.throws(
      () => parseStatement('  ip_set_reference_statement {\n    arn = "x"\n  }\n'),
      /unrecognised statement shape/,
      'an unhandled statement must not be silently treated as "does not match"'
    );
  });

  it('throws on an incomplete visibility_config rather than defaulting it', () => {
    assert.throws(
      () => parseVisibilityConfig('  metric_name = "x"\n'),
      /incomplete visibility_config/,
      'a missing sampled_requests_enabled must not read back as false'
    );
  });

  it('throws when a byte match has no text_transformation', () => {
    assert.throws(
      () =>
        parseStatement(
          'byte_match_statement {\n  search_string = "/x"\n  positional_constraint = "STARTS_WITH"\n  field_to_match {\n    uri_path {}\n  }\n}'
        ),
      /at least one text_transformation/
    );
  });

  it('throws when asked to evaluate a field it cannot supply', () => {
    const rules = [
      {
        name: 'header-rule',
        priority: 1,
        action: 'block',
        statement: {
          kind: 'byte_match',
          field: 'single_header',
          searchString: 'x',
          positionalConstraint: 'CONTAINS',
          transformations: [{ priority: 0, type: 'NONE' }],
        },
        visibility: { cloudwatchMetricsEnabled: true, metricName: 'x', sampledRequestsEnabled: false },
      },
    ];
    assert.throws(
      () => evaluateRuleGroup(rules, { method: 'GET', uriPath: '/calendar' }),
      /cannot supply the "single_header" field/,
      'an unevaluatable rule must fail the test, never be skipped'
    );
  });

  it('extractAllBlocks finds every repeat, not just the first', () => {
    const body = 'rule {\n  name = "a"\n}\nrule {\n  name = "b"\n}\nrule {\n  name = "c"\n}\n';
    assert.deepStrictEqual(
      extractAllBlocks(body, 'rule').map((block) => readArgument(block, 'name')),
      ['a', 'b', 'c']
    );
  });
});
