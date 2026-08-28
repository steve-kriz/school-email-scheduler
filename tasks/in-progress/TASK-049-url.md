---
id: TASK-049
title: URL
status: in-progress
created: 2026-08-28T21:29:10.401Z
updated: 2026-08-28T22:28:40.000Z
agent: build-049
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-08-28T21:45:00.000Z","finishedAt":"2026-08-28T21:53:00.000Z","note":"DEFINED and PARKED on a blocking security decision. Confirmed all six conflict points the orchestrator supplied, then SIZED THE TICKET WELL BEYOND THEM. Established the ALB is NOT ours to remove - data.aws_lb.web_app_alb and data.aws_lb_listener are DATA SOURCES on a basestack ALB shared with the chatbot (which owns listener priority 119 to our 121), so remove the ALB can only mean remove this app four ALB resources. Established THE PUBLIC HOSTNAME CANNOT SURVIVE: aws_route53_record.this is an A-ALIAS to the ALB, a function URL is not a valid Route53 alias target, and a CNAME to it fails TLS because the cert is AWS-owned for the lambda-url domain. BIGGEST FINDING - THIS IS A CODE MIGRATION, NOT A TERRAFORM CHANGE: the handler is ALB-payload-shaped end to end (event.path, event.httpMethod, event.multiValueHeaders; buildResponse returns statusDescription plus multiValueHeaders; finalise inspects response.multiValueHeaders) while function URLs use payload format 2.0 and IGNORE multiValueHeaders on the response entirely, so an unmigrated response silently returns 200 with no Content-Type and no Set-Cookie and sign-in loops forever with nothing in the logs. Counted 168 occurrences of multiValueHeaders/statusDescription/httpMethod across 10 test files. TWO SILENT-BREAKAGE LANDMINES FOUND BY READING, NOT GUESSING: isScheduledScanEvent distinguishes an EventBridge scan from an HTTP request by httpMethod === undefined AND path === undefined, and BOTH are undefined in a format 2.0 event, so any HTTP request carrying a source property would be misrouted into a scan; and getQueryParam percent-decodes precisely because ALB delivers query values still encoded, while format 2.0 delivers them already decoded, so the OAuth code gets DOUBLE-DECODED and sign-in breaks only for values containing escapes - an intermittent-looking failure. Verified CloudFront is viable before offering it (the aws_global us-east-1 provider alias exists at provider.tf:32-46 and is currently UNUSED) but priced it honestly: needs a new us-east-1 ACM cert with DNS validation since basestack exports no cert, a CLOUDFRONT-scope ACL owned by this stack, and a CLOUDFRONT-scope re-issue of the rule group because the existing one is REGIONAL and its capacity is immutable. Wrote every acceptance criterion as an INVARIANT that holds under all three options so nothing presumes an answer. Also flagged the TASK-010 collision: that ticket is live on index.mjs and this one rewrites the same file response layer. Token/cost telemetry not correlated; 52615 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
answer: remove waf, remove alerting
---

## Description
Today the calendar app is reached at `https://<sub_domain>.<basestack domain>/calendar*`
via the **shared, basestack-owned** ALB. Four resources in `terraform/lambda_calendar.tf`
do that wiring (`aws_lb_target_group.calendar_lambda_tg`,
`aws_lambda_permission.calendar_allow_alb`, `aws_lb_listener_rule.calendar_listener_rule`
priority 121, `aws_lb_target_group_attachment.calendar_lambda_attachment`), plus
`aws_route53_record.this` in `terraform/main.tf`, which is an A-ALIAS to the ALB.

This ticket replaces that ingress with an `aws_lambda_function_url`.

Scope note grounded in the code: the ALB itself is NOT removed by this ticket and
cannot be. `data.aws_lb.web_app_alb` and `data.aws_lb_listener.web_app_alb_listener_443`
are DATA SOURCES on a basestack-owned load balancer shared with the chatbot (which owns
listener priority 119). "Remove the ALB" here means "remove this app's four ALB
resources and stop routing this app through it".

This is not a Terraform-only change. The Lambda speaks the ALB payload format
throughout, and a function URL uses payload format 2.0:

- `index.mjs:1897-1899` reads `event.path`, `event.httpMethod`, `event.multiValueHeaders`
- `buildResponse` (`index.mjs:267-310`) returns `statusDescription` plus `multiValueHeaders`
- `finalise` (`index.mjs:348-373`) inspects `response.multiValueHeaders`

Format 2.0 supplies `rawPath` and `requestContext.http.method`, a single-value `headers`
map plus a `cookies` array, and IGNORES `multiValueHeaders` on the response — so an
unmigrated response silently loses every header, including `Set-Cookie` and `Content-Type`.

### DECISION MADE — build option 1: bare function URL, accept the losses
The conflict was raised and the user answered: **"remove waf, remove alerting"**.
Build a plain `aws_lambda_function_url` with `authorization_type = "NONE"` and
deliberately give up the WAF and the ALB-keyed alarm. No CloudFront, no ACM cert,
no replacement ACL. This section records WHY that is a deliberate, informed choice
rather than an oversight, so nobody "fixes" it later:

- **The WAF genuinely cannot follow.** `terraform/waf_calendar.tf` creates NO web ACL
  and NO `aws_wafv2_web_acl_association`: it publishes a REGIONAL rule group consumed
  by the shared ALB's basestack-owned ACL. AWS WAF regional ACLs associate with
  ALB / API Gateway / AppSync / Cognito — never with a Lambda function URL. Keeping a
  WAF here was only possible via CloudFront, which was considered and declined.
- **What is knowingly given up:** every rule in `calendar_protection`, including the
  `/calendar/api/scan` rate limit that caps Anthropic spend per IP and the
  OAuth-callback allow rule; the `calendar_target_group_unhealthy_hosts` alarm; and
  the only thing currently probing `/calendar/api/health` (the ALB health check,
  300s interval). TASK-011 is partially undone on purpose.
- **This supersedes TASK-048** (`resolution: wont-do`, "Remove the WAF"). That ticket
  declined removing the WAF as a standalone act; this one accepts its removal as the
  price of the function URL. If TASK-048's reasoning is ever revisited, start here.
- **The public hostname changes.** The app moves to
  `https://<url-id>.lambda-url.<region>.on.aws/calendar/...`; the custom hostname and
  its Route53 A-ALIAS go away, and TLS is served by an AWS-owned certificate.
- **`authorization_type = "NONE"` is required**, because it is the only value a browser
  can reach directly (`AWS_IAM` needs SigV4 on every request). The endpoint is therefore
  publicly reachable with no network-layer filtering in front of it; the app's own
  session auth remains the only guard on the data routes.

**Operational prerequisite, easy to miss and it breaks sign-in:** the Google Cloud
console redirect URI must be updated by hand to the new function-URL origin, or OAuth
fails with `redirect_uri_mismatch` (`docs/google-oauth-setup.md:147-149`).

## Acceptance Criteria

### Ingress and Terraform
- [ ] An `aws_lambda_function_url` for `aws_lambda_function.calendar` exists in
      `terraform/lambda_calendar.tf` and its URL is exposed as a Terraform output.
- [ ] Its `authorization_type` is `"NONE"` (the decided value — the only one a browser
      can reach directly), and the file carries a comment stating that this endpoint is
      deliberately public with no WAF in front of it, and that app-level session auth is
      the only guard on the data routes.
- [ ] `aws_lb_target_group.calendar_lambda_tg`, `aws_lb_listener_rule.calendar_listener_rule`,
      `aws_lb_target_group_attachment.calendar_lambda_attachment` and
      `aws_lambda_permission.calendar_allow_alb` are all removed together — no resource
      is left referencing a removed one.
- [ ] `data.aws_lb.web_app_alb` and `data.aws_lb_listener.web_app_alb_listener_443` in
      `terraform/main.tf` are removed if and only if nothing else still references them
      (`terraform validate` passes either way).
- [ ] The basestack ALB, its listener and the chatbot's priority-119 rule are untouched.
- [ ] The Lambda keeps its `vpc_config` and egress-only security group unchanged; the
      security group still has no ingress rule.
- [ ] `terraform validate` and `terraform fmt -check` pass on `terraform/`.

### Public URL, DNS and OAuth
- [ ] `local.calendar_public_base_url` / the `PUBLIC_BASE_URL` env var
      (`terraform/lambda_calendar.tf:207` and `:277`) resolves to the origin the app is
      ACTUALLY served from after the change — never a hostname that no longer routes here.
- [ ] `aws_route53_record.this` is either removed, or repointed at a target that is a
      legal alias for the new ingress. No record is left aliasing the ALB for a hostname
      this app no longer answers on.
- [ ] The end state serves the app over HTTPS with a certificate valid for the hostname
      users are told to visit (no name-mismatch TLS warning).
- [ ] The Google OAuth redirect URI that must be registered in the Google Cloud console
      is stated explicitly in the ticket's build notes, and `docs/google-oauth-setup.md`
      (lines 46-48 and 147-169) is updated to match the new `PUBLIC_BASE_URL` derivation.

### Handler payload migration
- [ ] The handler routes correctly on a payload-format-2.0 event: path from `rawPath`,
      method from `requestContext.http.method`, with the existing ALB reads retained or
      cleanly replaced (no route regresses).
- [ ] Responses use a shape the function URL actually honours: `statusCode`, a
      single-value `headers` map, and multiple `Set-Cookie` values emitted via the
      `cookies` array. No response relies on `multiValueHeaders` reaching the client.
- [ ] `finalise` still strips `Access-Control-Allow-Credentials` whenever
      `Access-Control-Allow-Origin` is `*`, on the NEW response shape (the TASK-020/022
      invariant survives the migration).
- [ ] `serializeSessionCookie` / `serializeClearedSessionCookie`
      (`backend/session.mjs:234-264`) still deliver `HttpOnly; Secure; SameSite=Lax`, and
      login and logout both work end to end on the new URL.
- [ ] Cookie reading (`backend/session.mjs:297`, `index.mjs:1899`) handles the format-2.0
      `cookies` array as well as a `Cookie` header.
- [ ] `getQueryParam` (`index.mjs:409-435`) returns the correct value for an OAuth `code`
      containing `/` or `+` under the new payload format — no double-decoding.
- [ ] `isScheduledScanEvent` (`backend/scan-schedule.mjs:424-432`) still returns `false`
      for every HTTP request under the new payload format, and `true` only for the
      EventBridge Scheduler payload.
- [ ] Base64 request bodies still decode (`backend/settings.mjs:692` reads
      `event.isBase64Encoded`).

### Monitoring and WAF removal (decided: remove both)
- [ ] `aws_cloudwatch_metric_alarm.calendar_target_group_unhealthy_hosts`
      (`terraform/alerting.tf:236-277`) is REMOVED, not left defined on `TargetGroup` /
      `LoadBalancer` dimensions that can no longer report. An alarm on a metric that never
      reports never fires, which is worse than no alarm because it looks like coverage.
- [ ] `aws_wafv2_rule_group.calendar_protection` is REMOVED along with its outputs
      `calendar_waf_rule_group_arn` and `calendar_waf_managed_rule_groups`
      (`terraform/waf_calendar.tf`). A rule group published for an ACL that no longer sees
      this app's traffic is not an acceptable end state.
- [ ] `var.calendar_waf_rate_limit` and `var.calendar_scan_rate_limit`
      (`terraform/variables.tf:165-207`) are removed, along with their values in all four
      files under `terraform/config/`. No variable is left claiming to protect a path it
      no longer protects.
- [ ] `terraform/variables.tf:170`'s comment referencing
      `aws_wafv2_rule_group.calendar_protection` is removed or corrected, since it will
      name a resource that no longer exists.
- [ ] The loss of the `/calendar/api/scan` cost control is recorded in the code, not just
      in this ticket: the scan route carries a comment stating that the per-IP rate limit
      that capped Anthropic spend was removed with the WAF, so the next person reading it
      knows the cap is gone rather than assuming it still applies.
- [ ] Nothing probes `/calendar/api/health` after this change, and that is recorded as a
      known gap in the ticket's build notes rather than silently accepted.

### Tests and docs
- [ ] Every test asserting the ALB wiring is updated to assert the new ingress, not
      deleted wholesale: `tests/unit/calendar-lambda-terraform.test.js` (~469-595),
      `tests/unit/calendar-alerting-terraform.test.js` (~285-299),
      `tests/unit/terraform-scaffold.test.js` (~231-241),
      `tests/e2e/calendar-alerting-waf.test.js`.
- [ ] Handler tests that construct ALB-shaped events or assert `multiValueHeaders` /
      `statusDescription` are migrated to the new payload format — ~168 occurrences across
      `tests/e2e/calendar-auth-routes.test.js`, `tests/e2e/calendar-lambda.test.js`,
      `tests/unit/calendar-cors.test.js`, `tests/e2e/calendar-handler-deps.test.js`,
      `tests/e2e/calendar-settings-routes.test.js`,
      `tests/e2e/calendar-settings-public-mail-routes.test.js`,
      `tests/e2e/calendar-events-api.test.js`, `tests/e2e/calendar-disconnect-flow.test.js`,
      `tests/e2e/calendar-scan-orchestration.test.js`, `tests/unit/calendar-auth.test.js`.
- [ ] The whole suite passes.
- [ ] Comments that describe ALB behaviour as current fact are corrected, not left stale:
      `lambda_calendar.tf:2` and `:417-420`, `index.mjs:241-247` and `:398-404` and
      `:1914-1915`, `session.mjs:267-269`, `waf_calendar.tf:216-219`.

## Cucumber Tests

```gherkin
Feature: Calendar app reachable from a Lambda function URL

  Scenario: The function URL serves the calendar app
    Given the calendar Lambda has a function URL
    When a browser requests "/calendar/api/health" on that URL
    Then the response status is 200
    And the body reports service "school-calendar"

  Scenario: Payload format 2.0 routing
    Given an event with rawPath "/calendar/api/auth/me" and requestContext.http.method "GET"
    When the handler processes it
    Then it routes to the auth "me" handler
    And it does not fall through to the 404 branch

  Scenario: Multiple Set-Cookie headers survive the format change
    Given a sign-in response that sets more than one cookie
    When the handler returns it through the function URL
    Then every cookie is delivered in the "cookies" array
    And none of them is dropped because it was placed in "multiValueHeaders"

  Scenario: Session cookie attributes are unchanged
    Given a successful Google OAuth callback
    When the session cookie is issued
    Then it carries HttpOnly, Secure and SameSite=Lax
    And a subsequent authenticated request is accepted on the new origin

  Scenario: PUBLIC_BASE_URL matches the origin actually served
    Given the app is served from its new public origin
    When the OAuth start route builds the redirect_uri
    Then the redirect_uri host equals the host the browser is on

  Scenario: OAuth code containing a slash is not double-decoded
    Given a callback whose "code" query value contains "/" and "+"
    When getQueryParam reads it under payload format 2.0
    Then the value handed to the token exchange is byte-identical to what Google issued
    And the token exchange does not fail with invalid_grant

  Scenario: A scheduled scan event is never mistaken for an HTTP request
    Given an EventBridge Scheduler event with source set to the scan source
    When the handler inspects it
    Then it runs the scheduled scan and returns a plain result object
    And it does not return an HTTP response shape

  Scenario: An HTTP request is never mistaken for a scheduled scan
    Given a format 2.0 HTTP event that carries a "source" property
    And no httpMethod and no path property, because format 2.0 has neither
    When isScheduledScanEvent inspects it
    Then it returns false
    And the request is routed as HTTP

  Scenario: Wildcard CORS never ships credentials
    Given ALLOWED_ORIGINS is unset so the resolved origin is "*"
    When any route returns a response carrying Access-Control-Allow-Credentials
    Then finalise strips that header from the new response shape before it leaves the router

  Scenario: No alarm is left watching a metric that cannot report
    When terraform is applied without the ALB target group
    Then no CloudWatch alarm remains with a TargetGroup or LoadBalancer dimension for this app

  Scenario: No WAF rule group is left without a consumer
    When the change is applied
    Then aws_wafv2_rule_group.calendar_protection is either consumed by an ACL in the request path, or removed along with its outputs

  Scenario: Stale DNS does not silently serve nothing
    Given the Route53 A-ALIAS previously pointed at the shared ALB
    When the listener rule for this app is removed
    Then the record is removed or repointed
    And no user is left with a hostname that resolves to a load balancer with no matching rule

  Scenario: TLS name matches the advertised hostname
    When a user visits the hostname documented for this app
    Then the presented certificate is valid for that hostname
```

## Edge and Failure Cases the Implementer Must Handle

1. **Silent header loss.** Function URLs ignore `multiValueHeaders`. An unmigrated
   response returns 200 with no `Content-Type` and no `Set-Cookie` — sign-in loops
   forever with nothing in the logs.
2. **Double-decoded OAuth code.** `decodeQueryValue` exists because ALB delivers
   encoded query values; format 2.0 delivers them decoded. Double decoding corrupts
   `code`/`state` and breaks sign-in only for values containing escapes — an
   intermittent-looking failure.
3. **Scheduled-event misdetection**, both directions (see the Gherkin above).
4. **`aws_lambda_permission` swap.** `principal = "elasticloadbalancing.amazonaws.com"`
   with `source_arn` = target group ARN is meaningless without the ALB. A function URL
   with `authorization_type = "NONE"` needs a permission with
   `principal = "*"`, `action = "lambda:InvokeFunctionUrl"` and
   `function_url_auth_type = "NONE"`; the AWS provider adds this implicitly in some
   paths — do not end up with both, and do not end up with neither.
5. **Destroy ordering.** The attachment `depends_on` the permission
   (`lambda_calendar.tf:499-501`). Destroying the permission before deregistering the
   target can fail the apply; remove them in one plan and check the ordering.
6. **Shared-ALB blast radius.** Priority 121 is ours; 119 is the chatbot's. Do not touch
   the listener, the ALB, or the basestack ACL.
7. **Loss of the only health probe.** Nothing but the ALB health check calls
   `/calendar/api/health` today (300s interval).
8. **Function URL response cap** is 6 MB buffered (no streaming with a buffered handler);
   check the largest frontend asset served by TASK-010's static routes.
9. **URL churn on replacement.** A function URL id is stable for the life of the URL
   resource but changes if the resource is destroyed and recreated — and it is baked into
   `PUBLIC_BASE_URL` and into Google's registered redirect URI, so a recreate breaks
   sign-in until the console is updated by hand.
10. **`authorization_type = "AWS_IAM"` is not browser-reachable.** It requires SigV4 on
    every request, so it only works behind something that signs (e.g. CloudFront with OAC).
    `NONE` is the only value a browser can use directly.
11. **`.bak` and `src/lambda/calendar/backend/settings.mjs.orig_restore_check`** are
    untracked leftovers in the working tree — do not migrate or ship them.
12. **TASK-010 touches `index.mjs`** (frontend calendar static routes). This ticket
    rewrites the response layer of the same file; coordinate or rebase.

## Relevant Files and Context

Terraform:
- `terraform/lambda_calendar.tf` — ALB block at 436-502; `local.calendar_public_base_url` 205-207;
  `PUBLIC_BASE_URL` 276-277; `vpc_config` 251-254; security-group comment 417-420
- `terraform/main.tf` — `data.aws_lb` 9-11, `data.aws_lb_listener` 28-31, `aws_route53_record.this` 33-43
- `terraform/alerting.tf` — 236-277 (`calendar_target_group_unhealthy_hosts`, dimensions at 266-269)
- `terraform/waf_calendar.tf` — whole file; header 1-65 explains the shared-ACL model; outputs 271-279
- `terraform/variables.tf` — `sub_domain` at 100; WAF rate-limit vars 165-207
- `terraform/provider.tf` — 32-46 declares an unused `aws_global` (us-east-1) alias; basestack remote
  state exports only `vpc_id`, `private_subnet_ids`, `domain_name` (no ACM cert)

Lambda source:
- `src/lambda/calendar/index.mjs` — `buildResponse` 267-310, `finalise` 348-373,
  `decodeQueryValue`/`getQueryParam` 397-435, `handler` 1873-1975
- `src/lambda/calendar/backend/session.mjs` — cookie serialisation 234-264, cookie parsing 266-300
- `src/lambda/calendar/backend/scan-schedule.mjs` — `isScheduledScanEvent` 411-432
- `src/lambda/calendar/backend/settings.mjs` — body decode at 692
- `src/lambda/calendar/backend/google-oauth.mjs` — redirect_uri derived from `PUBLIC_BASE_URL` (99, 127, 193, 321)

Tests: all files listed in the acceptance criteria above.
Docs: `docs/google-oauth-setup.md` (46-48, 147-169).

Prior art: `tasks/done/TASK-003-lambda-alb-terraform.md` and
`tasks/done/TASK-011-alerting-and-waf.md` are what this ticket partially undoes;
`tasks/done/TASK-048-waf.md` is the declined WAF removal.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
