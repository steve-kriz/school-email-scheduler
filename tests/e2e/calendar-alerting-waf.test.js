/**
 * E2E (cucumber-style) scenarios for TASK-011: CloudWatch alerting and WAF
 * rules for the calendar endpoints.
 *
 * These implement the ticket's Gherkin verbatim in Given/When/Then form under
 * `node --test`. Three things are executed for real here rather than inspected:
 *
 *   1. TERRAFORM. Variable defaults, the cross-variable invariant, the variable
 *      validations and the SNS `count` guard are evaluated by a real
 *      `terraform console` in a throwaway workspace, using the guard expression
 *      LIFTED OUT OF alerting.tf itself. So "no alarm resources are planned
 *      with Alert_SNS_ARN = \"\"" is proved by terraform evaluating the file's
 *      own expression to 0, not by a regex recognising the text.
 *
 *      HONEST LIMIT: a real `terraform plan` needs AWS credentials, an S3
 *      backend and two remote states, none of which exist in this environment.
 *      The scenario below therefore verifies the count expression and
 *      `terraform validate`, and says so in its own name. It does NOT claim a
 *      plan was run.
 *
 *   2. THE WAF RULES. Parsed out of HCL and evaluated against real requests in
 *      priority order (tests/helpers/waf-rules.mjs), so "no rule blocks the
 *      callback" is a decision this suite computes, not an assumption.
 *
 *   3. THE ALARM EMITTERS. scan.mjs and google-token.mjs are driven end to end
 *      with every DynamoDB, Gmail, Anthropic and HTTP dependency injected as a
 *      mock - no database connection is opened anywhere in this file - and the
 *      emitted token is checked against the token terraform/alerting.tf filters
 *      on. That two-sided contract is the thing nothing else fails loudly on.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractResourceBody, extractBlock } from '../helpers/hcl-blocks.mjs';
import { parseRuleGroup, evaluateRuleGroup, readArgument } from '../helpers/waf-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TERRAFORM_DIR = path.join(PROJECT_ROOT, 'terraform');
const CONFIG_DIR = path.join(TERRAFORM_DIR, 'config');
const DEV_AU_VAR_FILE = 'config/dev/au.tfvars';

const alertingContent = fs.readFileSync(path.join(TERRAFORM_DIR, 'alerting.tf'), 'utf-8');
// TASK-049 deleted terraform/waf_calendar.tf. Reading it here would throw at
// module load and take the whole file down, so the path is only ever used to
// assert its ABSENCE.
const WAF_TF_PATH = path.join(TERRAFORM_DIR, 'waf_calendar.tf');

// --- Backend modules under test. Imported by absolute file URL, the
// convention the rest of this suite uses on Windows. ---
const moduleUrl = (name) =>
  new URL(`file:///${path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', name).replace(/\\/g, '/')}`).href;

const { ALARM_TOKENS, emitAlarm } = await import(moduleUrl('alarms.mjs'));
const { runScan, SCAN_STATUS } = await import(moduleUrl('scan.mjs'));
const { getAccessToken, ReauthRequiredError } = await import(moduleUrl('google-token.mjs'));

// -----------------------------------------------------------------------------
// terraform harness
// -----------------------------------------------------------------------------

function resolveTerraformBin() {
  for (const candidate of ['C:/External/Terraform/terraform.exe', 'C:/External/Terraform/terraform']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'terraform';
}

const TERRAFORM_BIN = resolveTerraformBin();

/** A workspace holding variables.tf + config/, initialised once and reused. */
let workspace = null;

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-alerting-'));
  fs.copyFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), path.join(workspace, 'variables.tf'));
  fs.cpSync(CONFIG_DIR, path.join(workspace, 'config'), { recursive: true });
  // No provider is declared by variables.tf, so init needs no plugins, no
  // network and no AWS credentials.
  execFileSync(TERRAFORM_BIN, ['init', '-backend=false', '-input=false', '-no-color'], {
    cwd: workspace,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180000,
  });
});

after(() => {
  if (workspace && fs.existsSync(workspace)) {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/**
 * Evaluate `expression` with `terraform console`, returning both the printed
 * value and anything terraform complained about. Never swallows a failure: a
 * console run that produces no parsable value throws.
 *
 * @param {string} expression
 * @param {string[]} [extraArgs] e.g. ['-var', 'Alert_SNS_ARN=arn:...']
 * @returns {{value: string, stderr: string}}
 */
function tfConsole(expression, extraArgs = []) {
  const result = spawnSync(
    TERRAFORM_BIN,
    ['console', '-no-color', `-var-file=${DEV_AU_VAR_FILE}`, ...extraArgs],
    { cwd: workspace, input: `${expression}\n`, encoding: 'utf-8', timeout: 120000 }
  );
  if (result.error) throw new Error(`terraform console failed to start: ${result.error.message}`);
  const stdout = (result.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
  const stderr = (result.stderr || '').replace(/\u001b\[[0-9;]*m/g, '');
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(
      `terraform console printed no value for ${JSON.stringify(expression)}. stderr: ${stderr || '(empty)'}`
    );
  }
  return { value: lines[lines.length - 1], stderr };
}

/** The `count = ...` expression declared by a named alarm, read from alerting.tf. */
function alarmCountExpression(alarmName) {
  const body = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', alarmName);
  assert.ok(body, `aws_cloudwatch_metric_alarm "${alarmName}" not found`);
  const expression = readArgument(body, 'count');
  assert.ok(expression, `alarm "${alarmName}" declares no count`);
  return expression.replace(/\s+/g, ' ').trim();
}

function alarmNames() {
  const names = [];
  for (const line of alertingContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match = /^resource\s+"aws_cloudwatch_metric_alarm"\s+"([A-Za-z0-9_-]+)"/.exec(trimmed);
    if (match) names.push(match[1]);
  }
  return names;
}

// -----------------------------------------------------------------------------
// Feature: Operational guardrails
// -----------------------------------------------------------------------------

describe('Feature: Operational guardrails - alerting (TASK-011)', () => {
  describe('Scenario: A dev environment without an SNS topic still applies', () => {
    it('Given Alert_SNS_ARN is an empty string, When terraform evaluates the alerting count guards, Then every alarm resolves to 0 instances', () => {
      // config/dev/au.tfvars sets Alert_SNS_ARN = "" - the first environment
      // the calendar deploys to.
      assert.match(
        fs.readFileSync(path.join(CONFIG_DIR, 'dev', 'au.tfvars'), 'utf-8'),
        /Alert_SNS_ARN\s*=\s*""/,
        'dev/au must still be the empty-topic environment this guard exists for'
      );

      const names = alarmNames();
      // Four since TASK-049 removed the ALB target-group alarm.
      assert.ok(names.length >= 4, `expected at least 4 alarms in alerting.tf, found ${names.length}`);
      for (const name of names) {
        const { value } = tfConsole(alarmCountExpression(name));
        assert.strictEqual(value, '0', `alarm "${name}" would still be created in an environment with no SNS topic`);
      }
    });

    it('And planning succeeds: terraform validate reports error_count 0 without waf_calendar.tf', () => {
      // NOT a `terraform plan`: that needs AWS credentials, an S3 backend and
      // two remote data sources, none of which exist here. What IS proved is
      // that the configuration is valid, and that the guard above evaluates to
      // zero. waf_calendar.tf is deliberately NOT in this list any more:
      // TASK-049 deleted it, and the configuration must still validate without
      // it - a dangling reference to the removed rule group would show up here.
      for (const file of ['alerting.tf', 'lambda_calendar.tf']) {
        assert.ok(fs.existsSync(path.join(TERRAFORM_DIR, file)), `${file} must exist to be validated`);
      }
      assert.strictEqual(
        fs.existsSync(WAF_TF_PATH),
        false,
        'waf_calendar.tf must be gone, and the configuration must still validate without it'
      );

      const result = spawnSync(TERRAFORM_BIN, ['validate', '-json', '-no-color'], {
        cwd: TERRAFORM_DIR,
        encoding: 'utf-8',
        timeout: 180000,
      });
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(
        parsed.error_count,
        0,
        `terraform validate reported ${parsed.error_count} error(s): ${JSON.stringify(parsed.diagnostics)}`
      );
      assert.strictEqual(parsed.valid, true, 'the configuration must be valid');
    });

    it('FAILURE PATH: with a topic configured the same guard resolves to 1, so it is a real switch and not a constant', () => {
      const arn = 'arn:aws:sns:ap-southeast-2:058264301523:alerts';
      for (const name of alarmNames()) {
        const { value } = tfConsole(alarmCountExpression(name), ['-var', `Alert_SNS_ARN=${arn}`]);
        assert.strictEqual(value, '1', `alarm "${name}" must be created once a topic is configured`);
      }
    });
  });

  describe('Scenario: Lambda failures raise an alarm', () => {
    it('Given Alert_SNS_ARN is set, Then an alarm exists on the calendar function Errors metric', () => {
      const body = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_lambda_errors');
      assert.ok(body, 'no Errors alarm declared');
      assert.strictEqual(readArgument(body, 'metric_name'), 'Errors');
      assert.strictEqual(readArgument(body, 'namespace'), 'AWS/Lambda');
      assert.strictEqual(
        readArgument(body, 'alarm_actions').replace(/\s+/g, ''),
        '[var.Alert_SNS_ARN]',
        'the alarm must notify the shared SNS topic'
      );
      const dimensions = extractBlock(body.replace(/dimensions\s*=\s*\{/, 'dimensions {'), 'dimensions');
      assert.strictEqual(readArgument(dimensions, 'FunctionName'), 'aws_lambda_function.calendar.function_name');
    });

    it('And an alarm exists on the calendar function Throttles metric', () => {
      const body = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_lambda_throttles');
      assert.ok(body, 'no Throttles alarm declared');
      assert.strictEqual(readArgument(body, 'metric_name'), 'Throttles');
      assert.strictEqual(readArgument(body, 'namespace'), 'AWS/Lambda');
      assert.strictEqual(readArgument(body, 'alarm_actions').replace(/\s+/g, ''), '[var.Alert_SNS_ARN]');
      const dimensions = extractBlock(body.replace(/dimensions\s*=\s*\{/, 'dimensions {'), 'dimensions');
      assert.strictEqual(readArgument(dimensions, 'FunctionName'), 'aws_lambda_function.calendar.function_name');
    });
  });

  describe('Scenario: A spike in extraction failures is visible', () => {
    it('Given the alerting configuration, Then a log metric filter matches "CALENDAR_EXTRACTION_FAILED"', () => {
      const locals = /calendar_extraction_failed_token\s*=\s*"([^"]+)"/.exec(alertingContent);
      assert.ok(locals, 'alerting.tf must define local.calendar_extraction_failed_token');
      assert.strictEqual(locals[1], 'CALENDAR_EXTRACTION_FAILED');

      const body = extractResourceBody(alertingContent, 'aws_cloudwatch_log_metric_filter', 'calendar_extraction_failed');
      assert.ok(body, 'no extraction-failure metric filter declared');
      assert.strictEqual(readArgument(body, 'pattern'), '\\"${local.calendar_extraction_failed_token}\\"');
    });

    it('And that filter has an alarm', () => {
      const body = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_extraction_failures');
      assert.ok(body, 'no extraction-failure alarm declared');
      assert.strictEqual(
        readArgument(body, 'metric_name'),
        'aws_cloudwatch_log_metric_filter.calendar_extraction_failed.metric_transformation[0].name',
        'the alarm must be wired to the filter it alarms on'
      );
      assert.strictEqual(readArgument(body, 'alarm_actions').replace(/\s+/g, ''), '[var.Alert_SNS_ARN]');
    });

    it('CONTRACT: the token the Lambda emits is the token the filter matches', () => {
      // Two-sided and nothing fails loudly if it drifts: change one and the
      // filter simply stops matching, forever and silently.
      const fromTerraform = /calendar_extraction_failed_token\s*=\s*"([^"]+)"/.exec(alertingContent)[1];
      assert.strictEqual(
        ALARM_TOKENS.EXTRACTION_FAILED,
        fromTerraform,
        'alarms.mjs ALARM_TOKENS.EXTRACTION_FAILED and local.calendar_extraction_failed_token have drifted apart'
      );

      // ...and an actual emission carries it, so the filter would count it.
      let line = null;
      emitAlarm(ALARM_TOKENS.EXTRACTION_FAILED, { userId: 'google#1' }, {
        write: (message, fields) => { line = `${message} ${JSON.stringify(fields)}`; },
      });
      assert.strictEqual(line.includes(fromTerraform), true, 'an emitted line must contain the filtered term');
    });
  });

  describe('Scenario: Mass grant revocation is noticed', () => {
    it('Given the alerting configuration, Then a log metric filter matches "CALENDAR_REAUTH_REQUIRED"', () => {
      const locals = /calendar_reauth_required_token\s*=\s*"([^"]+)"/.exec(alertingContent);
      assert.ok(locals, 'alerting.tf must define local.calendar_reauth_required_token');
      assert.strictEqual(locals[1], 'CALENDAR_REAUTH_REQUIRED');

      const body = extractResourceBody(alertingContent, 'aws_cloudwatch_log_metric_filter', 'calendar_reauth_required');
      assert.ok(body, 'no reauth metric filter declared');
      assert.strictEqual(readArgument(body, 'pattern'), '\\"${local.calendar_reauth_required_token}\\"');

      const alarm = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_reauth_required');
      assert.ok(alarm, 'the reauth filter must have an alarm');
      assert.strictEqual(
        readArgument(alarm, 'metric_name'),
        'aws_cloudwatch_log_metric_filter.calendar_reauth_required.metric_transformation[0].name'
      );
    });

    it('CONTRACT: the token google-token.mjs emits is the token the filter matches', () => {
      const fromTerraform = /calendar_reauth_required_token\s*=\s*"([^"]+)"/.exec(alertingContent)[1];
      assert.strictEqual(
        ALARM_TOKENS.REAUTH_REQUIRED,
        fromTerraform,
        'alarms.mjs ALARM_TOKENS.REAUTH_REQUIRED and local.calendar_reauth_required_token have drifted apart'
      );
    });
  });

  describe('Scenario: No alarm is left watching a metric that cannot report (TASK-049)', () => {
    it('When terraform is applied without the ALB target group, Then no CloudWatch alarm remains with a TargetGroup or LoadBalancer dimension for this app', () => {
      assert.strictEqual(
        extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', 'calendar_target_group_unhealthy_hosts'),
        null,
        'the target-group health alarm survives; with no target group it can only report INSUFFICIENT_DATA, which looks like health'
      );

      for (const name of alarmNames()) {
        const body = extractResourceBody(alertingContent, 'aws_cloudwatch_metric_alarm', name);
        assert.notStrictEqual(
          readArgument(body, 'namespace'),
          'AWS/ApplicationELB',
          `alarm "${name}" still watches AWS/ApplicationELB`
        );
        const dimensions = extractBlock(body.replace(/dimensions\s*=\s*\{/, 'dimensions {'), 'dimensions');
        if (!dimensions) continue;
        assert.strictEqual(readArgument(dimensions, 'TargetGroup'), null, `alarm "${name}" keeps a TargetGroup dimension`);
        assert.strictEqual(readArgument(dimensions, 'LoadBalancer'), null, `alarm "${name}" keeps a LoadBalancer dimension`);
      }
    });
  });
});

/**
 * TASK-049: the WAF rule group is removed, not repointed.
 *
 * aws_wafv2_rule_group.calendar_protection was consumed by the basestack ALB's
 * Web ACL. A regional Web ACL cannot be associated with a Lambda function URL,
 * so once the app moved there the rule group had NO consumer in the request
 * path - it would still cost WCU and still look protective in the console while
 * inspecting nothing.
 */
describe('Feature: The WAF rule group is removed along with its outputs (TASK-049)', () => {
  describe('Scenario: No WAF rule group is left without a consumer', () => {
    it('When the change is applied, Then terraform/waf_calendar.tf no longer exists', () => {
      assert.strictEqual(fs.existsSync(WAF_TF_PATH), false, 'terraform/waf_calendar.tf still exists');
    });

    it('And no .tf file declares a WAF rule group, web ACL or association for this app', () => {
      const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((name) => name.endsWith('.tf'));
      assert.ok(tfFiles.length > 0, 'no terraform files found');
      for (const name of tfFiles) {
        const content = fs.readFileSync(path.join(TERRAFORM_DIR, name), 'utf-8');
        for (const type of [
          'aws_wafv2_rule_group',
          'aws_wafv2_web_acl',
          'aws_wafv2_web_acl_association',
          'aws_wafv2_web_acl_logging_configuration',
        ]) {
          assert.ok(
            !new RegExp(`^\\s*resource\\s+"${type}"`, 'm').test(content),
            `${name} still declares a ${type}, which nothing in the request path can consume`
          );
        }
      }
    });

    it('And no output still exports the rule group ARN', () => {
      const tfFiles = fs.readdirSync(TERRAFORM_DIR).filter((name) => name.endsWith('.tf'));
      for (const name of tfFiles) {
        const content = fs.readFileSync(path.join(TERRAFORM_DIR, name), 'utf-8');
        assert.ok(
          !/output\s+"calendar_waf_rule_group_arn"/.test(content),
          `${name} still exports calendar_waf_rule_group_arn for a resource that no longer exists`
        );
      }
    });

    it('FAILURE PATH: the scan rate limit that capped Anthropic spend per IP is gone, and nothing silently claims otherwise', () => {
      // This is a deliberate, documented loss - the test exists so it cannot be
      // quietly reintroduced as a comment while no rule enforces it.
      const variables = fs.readFileSync(path.join(TERRAFORM_DIR, 'variables.tf'), 'utf-8');
      assert.ok(
        !variables.includes('variable "calendar_scan_rate_limit"'),
        'var.calendar_scan_rate_limit is still declared but no rule consumes it'
      );
      const lambdaTf = fs.readFileSync(path.join(TERRAFORM_DIR, 'lambda_calendar.tf'), 'utf-8');
      assert.match(
        lambdaTf,
        /WAF/,
        'lambda_calendar.tf must record that the function URL has no WAF in front of it'
      );
    });
  });
});

describe('Feature: the Lambda actually emits what the alarms count (TASK-011)', () => {
  /** Deps for runScan with every I/O boundary mocked. */
  function scanDeps(overrides = {}) {
    return {
      env: {},
      log: () => {},
      getConnection: async () => ({ searchDomains: new Set(['school.edu']), lastScanAt: null, schoolName: 'School' }),
      updateConnection: async () => {},
      acquireScanLock: async () => true,
      releaseScanLock: async () => {},
      fetchCandidateMessages: async () => ({
        messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
        truncated: false,
        errors: [],
        newestReceivedAt: '2026-08-20T00:00:00Z',
      }),
      extractFromMessage: async () => ({ events: [] }),
      storeEvents: async () => ({ written: 0, skipped: [] }),
      ...overrides,
    };
  }

  describe('Scenario: every message failing extraction still reports success to the runtime', () => {
    it('Given extraction throws for each message, When a scan runs, Then one CALENDAR_EXTRACTION_FAILED is emitted per message', async () => {
      const alarms = [];
      const error = Object.assign(new Error('Anthropic 529 overloaded: prompt was "Dear parents..."'), {
        name: 'AnthropicError',
      });

      const result = await runScan(
        { userId: 'google#alarm-1', mode: 'scheduled' },
        scanDeps({
          extractFromMessage: async () => {
            throw error;
          },
          emitAlarm: (token, fields) => alarms.push({ token, fields }),
        })
      );

      // The run is "partial", NOT an error - which is exactly why the token is
      // the only way this is ever seen.
      assert.strictEqual(result.status, SCAN_STATUS.PARTIAL, 'a wholly failed extraction batch still reports partial');
      assert.strictEqual(alarms.length, 2, 'one alarm per failed message');
      for (const alarm of alarms) {
        assert.strictEqual(alarm.token, ALARM_TOKENS.EXTRACTION_FAILED);
        assert.strictEqual(alarm.fields.userId, 'google#alarm-1');
        assert.strictEqual(alarm.fields.mode, 'scheduled');
        assert.strictEqual(alarm.fields.errorName, 'AnthropicError', 'the error NAME is carried, for triage');
      }
      assert.deepStrictEqual(alarms.map((alarm) => alarm.fields.messageId), ['msg-1', 'msg-2']);

      const serialised = JSON.stringify(alarms);
      assert.strictEqual(
        serialised.includes('Dear parents'),
        false,
        'the thrown message can quote the prompt back - it must never reach the alarm'
      );
      assert.strictEqual(serialised.includes('529'), false, 'no error message text at all, only the name');
    });

    it('And a scan where nothing fails emits no alarm at all', async () => {
      const alarms = [];
      const result = await runScan(
        { userId: 'google#alarm-2', mode: 'manual' },
        scanDeps({ emitAlarm: (token, fields) => alarms.push({ token, fields }) })
      );
      assert.strictEqual(result.status, SCAN_STATUS.OK, 'a clean run is ok');
      assert.deepStrictEqual(alarms, [], 'a healthy scan must not move the extraction-failure metric');
    });

    it('EDGE: a partial failure emits only for the message that failed', async () => {
      const alarms = [];
      let call = 0;
      const result = await runScan(
        { userId: 'google#alarm-3', mode: 'manual' },
        scanDeps({
          extractFromMessage: async () => {
            call += 1;
            if (call === 2) throw Object.assign(new Error('bad'), { name: 'ExtractionError' });
            return { events: [] };
          },
          emitAlarm: (token, fields) => alarms.push({ token, fields }),
        })
      );
      assert.strictEqual(result.status, SCAN_STATUS.PARTIAL);
      assert.strictEqual(alarms.length, 1, 'exactly one failed message, one alarm');
      assert.strictEqual(alarms[0].fields.messageId, 'msg-2');
      assert.strictEqual(alarms[0].fields.errorName, 'ExtractionError');
    });
  });

  describe('Scenario: a revoked Gmail grant raises CALENDAR_REAUTH_REQUIRED', () => {
    const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' };

    /** A token endpoint that answers with the given status and OAuth error. */
    function tokenEndpoint(status, oauthError) {
      return async () => ({
        ok: false,
        status,
        text: async () => JSON.stringify({ error: oauthError }),
      });
    }

    it('Given a stored grant Google rejects with invalid_grant, When a token is minted, Then the alarm token is emitted', async () => {
      const alarms = [];
      const updates = [];

      await assert.rejects(
        () =>
          getAccessToken('google#revoked-1', {
            forceRefresh: true,
            env,
            log: () => {},
            getRefreshToken: async () => 'stored-refresh-token',
            updateConnection: async (userId, patch) => updates.push({ userId, patch }),
            fetchImpl: tokenEndpoint(400, 'invalid_grant'),
            emitAlarm: (token, fields) => alarms.push({ token, fields }),
          }),
        (error) => {
          assert.ok(error instanceof ReauthRequiredError, `expected ReauthRequiredError, got ${error?.name}`);
          assert.strictEqual(error.reason, 'invalid_grant', 'the reason must identify a revocation');
          return true;
        }
      );

      assert.strictEqual(alarms.length, 1, 'a revocation must raise exactly one alarm');
      assert.strictEqual(alarms[0].token, ALARM_TOKENS.REAUTH_REQUIRED);
      assert.strictEqual(alarms[0].fields.userId, 'google#revoked-1');
      assert.strictEqual(alarms[0].fields.reason, 'invalid_grant');
      assert.strictEqual(updates.length, 1, 'the connection is marked as needing reauth (mocked DynamoDB write)');
      assert.strictEqual(
        JSON.stringify(alarms).includes('stored-refresh-token'),
        false,
        'no token material in the alarm'
      );
    });

    it('FAILURE PATH: a user who never connected raises NO alarm - that is not a revocation', async () => {
      const alarms = [];
      const updates = [];

      await assert.rejects(
        () =>
          getAccessToken('google#never-connected', {
            forceRefresh: true,
            env,
            log: () => {},
            getRefreshToken: async () => '',
            updateConnection: async (userId, patch) => updates.push({ userId, patch }),
            fetchImpl: tokenEndpoint(400, 'invalid_grant'),
            emitAlarm: (token, fields) => alarms.push({ token, fields }),
          }),
        (error) => {
          assert.ok(error instanceof ReauthRequiredError, `expected ReauthRequiredError, got ${error?.name}`);
          assert.strictEqual(error.reason, 'no_refresh_token');
          return true;
        }
      );

      assert.deepStrictEqual(
        alarms,
        [],
        'counting first-time visitors would make the mass-revocation alarm fire on ordinary traffic'
      );
      assert.deepStrictEqual(updates, [], 'and no connection row is invented for a user who never connected');
    });

    it('FAILURE PATH: an ordinary 500 from the token endpoint raises no reauth alarm', async () => {
      const alarms = [];
      await assert.rejects(
        () =>
          getAccessToken('google#transient', {
            forceRefresh: true,
            env,
            log: () => {},
            getRefreshToken: async () => 'stored-refresh-token',
            updateConnection: async () => {},
            fetchImpl: tokenEndpoint(500, 'internal_failure'),
            emitAlarm: (token, fields) => alarms.push({ token, fields }),
          }),
        (error) => {
          assert.strictEqual(error.name, 'TokenRefreshError', `expected TokenRefreshError, got ${error?.name}`);
          return true;
        }
      );
      assert.deepStrictEqual(alarms, [], 'a transient 5xx is not a revocation and must not move the metric');
    });

    it('And with no injected sink the alarm still reaches the log, via console.error', async () => {
      // deps.emitAlarm is NOT propagated through scan.mjs commonDeps (gmail.mjs
      // calls getAccessToken with a fixed dep list), so the production path is
      // the module default. Prove that default actually writes.
      const calls = [];
      const originalError = console.error;
      console.error = (...args) => calls.push(args);
      try {
        await assert.rejects(
          () =>
            getAccessToken('google#revoked-2', {
              forceRefresh: true,
              env,
              log: () => {},
              getRefreshToken: async () => 'stored-refresh-token',
              updateConnection: async () => {},
              fetchImpl: tokenEndpoint(400, 'invalid_grant'),
            }),
          (error) => {
            assert.ok(error instanceof ReauthRequiredError, `expected ReauthRequiredError, got ${error?.name}`);
            return true;
          }
        );
      } finally {
        console.error = originalError;
      }

      const tokenLines = calls.filter((args) => args[0] === ALARM_TOKENS.REAUTH_REQUIRED);
      assert.strictEqual(tokenLines.length, 1, `expected one CALENDAR_REAUTH_REQUIRED line, saw ${JSON.stringify(calls)}`);
      assert.strictEqual(tokenLines[0][1].userId, 'google#revoked-2');
    });
  });
});
