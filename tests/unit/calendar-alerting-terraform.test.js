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
// TASK-049 DELETED terraform/waf_calendar.tf: AWS WAF regional Web ACLs can be
// associated with an ALB, API Gateway, AppSync or Cognito - never with a Lambda
// function URL - so the rule group could not follow the app to its new ingress.
// This path is kept only so the tests below can assert the file is gone; nothing
// here may read it.
const WAF_TF = path.join(TERRAFORM_DIR, 'waf_calendar.tf');

const alertingContent = fs.readFileSync(ALERTING_TF, 'utf-8');

/**
 * A minimal in-memory rule group, so the parser's own failure modes can still be
 * tested now that there is no waf_calendar.tf on disk to parse.
 */
const WAF_PARSER_FIXTURE = `
resource "aws_wafv2_rule_group" "fixture_group" {
  name     = "fixture"
  scope    = "REGIONAL"
  capacity = 50

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "fixture"
    sampled_requests_enabled   = false
  }
}
`;

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

// `calendar_target_group_unhealthy_hosts` was removed by TASK-049 along with the
// ALB target group. An UnHealthyHostCount alarm on a target group that no longer
// exists reports INSUFFICIENT_DATA forever, which reads as "healthy" on a
// dashboard while nothing is actually being watched.
const EXPECTED_ALARMS = [
  'calendar_lambda_errors',
  'calendar_lambda_throttles',
  'calendar_extraction_failures',
  'calendar_reauth_required',
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
      // Four since TASK-049 removed the ALB target-group alarm.
      assert.ok(declared.length >= 4, `expected at least 4 alarms, found ${declared.length}`);
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

  describe('AC 6 (TASK-049): No alarm is left watching a metric that cannot report', () => {
    it('When terraform is applied without the ALB target group, Then the UnHealthyHostCount alarm is gone', () => {
      assert.strictEqual(
        extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_target_group_unhealthy_hosts'),
        null,
        'calendar_target_group_unhealthy_hosts survives; with no target group it can only ever report INSUFFICIENT_DATA'
      );
    });

    it('And no CloudWatch alarm remains with a TargetGroup or LoadBalancer dimension for this app', () => {
      for (const name of resourceNamesOfType(alertingContent, 'aws_cloudwatch_metric_alarm')) {
        const body = alarmBody(alertingContent, name);
        const dimensions = extractBlock(withDimensionsAsBlock(body), 'dimensions');
        if (!dimensions) continue;
        assert.strictEqual(
          readArgument(dimensions, 'TargetGroup'),
          null,
          `alarm "${name}" still carries a TargetGroup dimension`
        );
        assert.strictEqual(
          readArgument(dimensions, 'LoadBalancer'),
          null,
          `alarm "${name}" still carries a LoadBalancer dimension`
        );
      }
    });

    it('And no alarm is left on the AWS/ApplicationELB namespace, which this app no longer produces metrics in', () => {
      for (const name of resourceNamesOfType(alertingContent, 'aws_cloudwatch_metric_alarm')) {
        assert.notStrictEqual(
          readArgument(alarmBody(alertingContent, name), 'namespace'),
          'AWS/ApplicationELB',
          `alarm "${name}" watches AWS/ApplicationELB, but this app is no longer behind a load balancer`
        );
      }
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

/**
 * TASK-049: waf_calendar.tf is DELETED, not emptied.
 *
 * The rule group it published (calendar_protection) was referenced by the
 * basestack ALB's Web ACL. Moving the app to a Lambda function URL removed the
 * only thing that could consume it, and an unconsumed rule group is a resource
 * that costs WCU and protects nothing - so it had to go with its variables and
 * outputs, or a later reader would reasonably assume the app was still behind a
 * WAF when it is not.
 */
describe('Unit: the calendar WAF rule group is removed with its consumers (TASK-049)', () => {
  it('Scenario: No WAF rule group is left without a consumer - waf_calendar.tf no longer exists', () => {
    assert.strictEqual(
      fs.existsSync(WAF_TF),
      false,
      'terraform/waf_calendar.tf still exists; no regional Web ACL can associate with a Lambda function URL, so anything it declares has no consumer'
    );
  });

  it('And no .tf file anywhere declares aws_wafv2_rule_group.calendar_protection', () => {
    const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((file) => file.endsWith('.tf'));
    assert.ok(tfFiles.length >= 6, `expected the terraform directory to hold several files, found ${tfFiles.length}`);
    for (const file of tfFiles) {
      const content = fs.readFileSync(path.join(TERRAFORM_DIR, file), 'utf-8');
      assert.deepStrictEqual(
        resourceNamesOfType(content, 'aws_wafv2_rule_group'),
        [],
        `${file} still declares a WAF rule group that nothing can associate with`
      );
    }
  });

  it('And the rule group outputs are removed too, so nothing downstream can still reference it', () => {
    const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((file) => file.endsWith('.tf'));
    for (const file of tfFiles) {
      const content = fs.readFileSync(path.join(TERRAFORM_DIR, file), 'utf-8');
      // Comment lines are skipped deliberately: a comment explaining WHY the
      // rule group was removed is exactly what should survive, whereas live HCL
      // referencing it is what must not.
      const liveLines = content
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('#') && !trimmed.startsWith('//');
        })
        .join('\n');
      assert.ok(
        !liveLines.includes('calendar_protection'),
        `${file} still references the deleted calendar_protection rule group`
      );
      assert.ok(
        !/output "calendar_waf_/.test(liveLines),
        `${file} still publishes a calendar WAF output for a rule group that no longer exists`
      );
    }
  });

  it('And the rate-limit variables that only fed those rules are gone from variables.tf', () => {
    const variables = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
    for (const name of ['calendar_waf_rate_limit', 'calendar_scan_rate_limit']) {
      assert.ok(
        !variables.includes(`variable "${name}"`),
        `variables.tf still declares var.${name}, which nothing consumes now the rule group is gone`
      );
    }
  });

  it('And no WAF logging destination is declared anywhere in the terraform directory', () => {
    const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((file) => file.endsWith('.tf'));
    for (const file of tfFiles) {
      const content = fs.readFileSync(path.join(TERRAFORM_DIR, file), 'utf-8');
      assert.deepStrictEqual(
        resourceNamesOfType(content, 'aws_wafv2_web_acl_logging_configuration'),
        [],
        `${file} must not create a WAF logging destination`
      );
    }
  });
});

describe('Unit: the WAF parser fails loudly rather than silently passing (TASK-011)', () => {
  it('throws when the named rule group does not exist', () => {
    assert.throws(
      () => parseRuleGroup(WAF_PARSER_FIXTURE, 'not_a_rule_group'),
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
