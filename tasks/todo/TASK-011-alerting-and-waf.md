---
id: TASK-011
title: CloudWatch alerting and WAF rules for the calendar endpoints
status: todo
created: 2026-08-17T11:00:00Z
updated: 2026-08-17T11:00:00Z
depends-on: TASK-008
---

## Description
Complete the copy of the chatbot's Terraform surface with the two pieces that
protect it in production: CloudWatch metric filters and alarms, and a WAF rule
group in front of the calendar paths.

Depends on TASK-008 (all runtime resources must exist to be alarmed on).

Reference: `ohq-chatbot2/terraform/alerting.tf` and
`ohq-chatbot2/terraform/waf_chatbot.tf` — read both and follow their structure,
naming and tagging conventions.

**`terraform/alerting.tf`:**
- `aws_cloudwatch_metric_alarm` on the Lambda's `Errors` metric, and one on
  `Throttles`, both dimensioned to the calendar function name, alarming to
  `var.Alert_SNS_ARN`. Guard every alarm with
  `count = var.Alert_SNS_ARN == "" ? 0 : 1` so dev deployments with no SNS topic
  still apply — the chatbot's dev/au tfvars set `Alert_SNS_ARN = ""`, so an
  unguarded alarm breaks the very environment this is first deployed to.
- `aws_cloudwatch_log_metric_filter` + alarm for extraction failures: match a
  structured log token the Lambda emits (define it as
  `CALENDAR_EXTRACTION_FAILED`) so a spike in refusals or API errors is visible.
- A metric filter + alarm for `CALENDAR_REAUTH_REQUIRED`, so mass grant
  revocation (e.g. a changed OAuth consent screen) is noticed.
- An alarm on the ALB target group's `UnHealthyHostCount` for the calendar
  target group.
- Because metric filters need the log group to exist, either depend on the
  `var.manage_lambda_log_groups`-gated group from TASK-003 or document in a
  comment that a fresh environment must apply with that flag `true` first —
  mirror the chatbot's comment on exactly this problem.

**`terraform/waf_calendar.tf`:**
- An `aws_wafv2_web_acl` (or rule group attached to the existing ALB ACL,
  matching whatever the chatbot does — read `waf_chatbot.tf` and follow it) with:
  - A rate-based rule limiting requests per 5 minutes per IP to
    `var.calendar_waf_rate_limit` (new variable, default `300`, same as the
    chatbot's) scoped to the `/calendar*` path prefix.
  - A stricter rate-based rule on `/calendar/api/scan` — a scan costs Gmail
    calls and model tokens, so it needs a tighter bound than page loads. Add
    `var.calendar_scan_rate_limit`, default `10` per 5 minutes per IP.
  - AWS managed rule groups matching the chatbot's selection (at minimum the
    common rule set and known-bad-inputs).
- Association with the shared ALB, following the chatbot's approach.
- `aws_wafv2_web_acl_logging_configuration` if the chatbot has one; otherwise
  omit rather than inventing a new logging destination.

Do not weaken the OAuth callback: the `/calendar/api/auth/google/callback` path
must remain reachable, so verify no rule blocks a `GET` carrying `code` and
`state` query parameters. A managed rule set flagging long opaque query strings
would silently break sign-in, which is worth an explicit check.

## Acceptance Criteria
- [ ] `aws_cloudwatch_metric_alarm` resources exist for the calendar Lambda's
      `Errors` and `Throttles` metrics, dimensioned to the function name.
- [ ] Every alarm is guarded by `count = var.Alert_SNS_ARN == "" ? 0 : 1`.
- [ ] `terraform plan` succeeds with `Alert_SNS_ARN = ""` and creates no alarm
      resources.
- [ ] A log metric filter matches `CALENDAR_EXTRACTION_FAILED` and has an alarm.
- [ ] A log metric filter matches `CALENDAR_REAUTH_REQUIRED` and has an alarm.
- [ ] An alarm exists on the calendar target group's `UnHealthyHostCount`.
- [ ] The metric-filter/log-group ordering problem is either resolved with
      `depends_on` or documented in a comment naming
      `var.manage_lambda_log_groups`.
- [ ] A WAF rate-based rule limits `/calendar*` to
      `var.calendar_waf_rate_limit` requests per 5 minutes per IP.
- [ ] `var.calendar_waf_rate_limit` defaults to `300`.
- [ ] A stricter rate-based rule limits `/calendar/api/scan` to
      `var.calendar_scan_rate_limit`, defaulting to `10`.
- [ ] AWS managed rule groups matching the chatbot's selection are included.
- [ ] The WAF is associated with the shared ALB using the same mechanism as
      `waf_chatbot.tf`.
- [ ] No rule blocks `GET /calendar/api/auth/google/callback` with `code` and
      `state` query parameters — this is verified, not assumed.
- [ ] `terraform validate` succeeds with all prior tickets' files plus these two.
- [ ] No alarm or WAF log configuration emits request bodies, cookies, or
      `Authorization` headers to a log destination.

## Cucumber Tests
```gherkin
Feature: Operational guardrails
  Scenario: A dev environment without an SNS topic still applies
    Given Alert_SNS_ARN is an empty string
    When terraform plans the alerting configuration
    Then no alarm resources are planned
    And planning succeeds

  Scenario: Lambda failures raise an alarm
    Given Alert_SNS_ARN is set
    When terraform plans the alerting configuration
    Then an alarm exists on the calendar function Errors metric
    And an alarm exists on the calendar function Throttles metric

  Scenario: A spike in extraction failures is visible
    Given the alerting configuration
    Then a log metric filter matches "CALENDAR_EXTRACTION_FAILED"
    And that filter has an alarm

  Scenario: Mass grant revocation is noticed
    Given the alerting configuration
    Then a log metric filter matches "CALENDAR_REAUTH_REQUIRED"

  Scenario: An unhealthy target is alarmed
    Given the alerting configuration
    Then an alarm exists on the calendar target group UnHealthyHostCount metric

  Scenario: Page requests are rate limited per IP
    Given the WAF configuration
    Then a rate-based rule scoped to "/calendar*" uses calendar_waf_rate_limit
    And calendar_waf_rate_limit defaults to 300

  Scenario: Scanning is limited more tightly than browsing
    Given the WAF configuration
    Then a rate-based rule scoped to "/calendar/api/scan" uses calendar_scan_rate_limit
    And calendar_scan_rate_limit defaults to 10
    And calendar_scan_rate_limit is lower than calendar_waf_rate_limit

  Scenario: Sign-in still works behind the WAF
    Given the WAF rule set
    When a GET to "/calendar/api/auth/google/callback" carries code and state parameters
    Then no rule blocks the request

  Scenario: WAF logging does not capture credentials
    Given any WAF logging configuration
    Then request bodies, cookies and Authorization headers are excluded
```

## Additional Context
