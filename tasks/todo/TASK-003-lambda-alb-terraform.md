---
id: TASK-003
title: Calendar Lambda, IAM, security group and ALB wiring
status: testing
created: 2026-08-17T11:00:00Z
updated: 2026-08-18T00:19:52Z
depends-on: TASK-002
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-18T00:05:25Z","finishedAt":"2026-08-18T00:14:00Z","tokens":60836,"note":"worktree build, committed 5318e1a, merged clean"}]
---

## Description
Package and publish the calendar Lambda and attach it to the shared web-app ALB,
mirroring `ohq-chatbot2/terraform/lambda_chatbot.tf` end to end. Also create the
minimal Lambda handler that answers the ALB health check, so `terraform apply`
produces a working target.

Depends on TASK-002 (needs the table names/ARNs and the CMK ARN).

Add `terraform/lambda_calendar.tf` containing, in the same order as the chatbot
file:
1. `data "archive_file"` zipping `../src/lambda/calendar` to
   `packages/lambda_function_calendar.zip`, excluding `CLAUDE.md`,
   `.deployment`, `package-lock.json`, `__test_shims__`.
2. A `locals` block with `calendar_log_group_name =
   "/aws/lambda/${local.name_prefix}-school-calendar"` and
   `calendar_function_arn` built from known parts
   (`arn:aws:lambda:${var.region}:${var.account_id}:function:...`) — do **not**
   reference `aws_lambda_function.calendar.arn` from inside the function's own
   `environment` block, which would create a self-referential cycle.
3. `aws_cloudwatch_log_group` gated on `count = var.manage_lambda_log_groups ? 1 : 0`,
   with the same explanatory comment as the chatbot about new vs existing
   environments, and `depends_on` from the function to the log group.
4. `aws_lambda_function` named `${local.name_prefix}-school-calendar`:
   `handler = "index.handler"`, `runtime = "nodejs24.x"`, `timeout = 60`,
   `memory_size = 512`, `source_code_hash` from the archive, a `vpc_config`
   using the new security group and the basestack `private_subnet_ids`.
5. `aws_iam_role` + `aws_iam_policy` + attachment. The policy is **scoped, not
   `Resource = "*"`**, with these statements:
   - CloudWatch Logs create/put on `arn:aws:logs:*:*:*`.
   - The five `ec2:*NetworkInterface*` / `*PrivateIpAddresses` actions on `*`
     (required for VPC Lambda; cannot be scoped).
   - DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`,
     `BatchWriteItem`, `DescribeTable` on the two table ARNs **and**
     `"${events_table_arn}/index/*"` — without the index ARN the
     `AttentionIndex` and `StartsAtIndex` queries fail with
     AccessDeniedException. Add that as a comment, as the chatbot does.
   - KMS `Encrypt`, `Decrypt`, `GenerateDataKey`, `DescribeKey` scoped to the
     TASK-002 CMK ARN only.
   - `secretsmanager:GetSecretValue` scoped to the app-config secret ARN.
6. `aws_security_group` `${local.name_prefix}-school-calendar-sg` in the
   basestack VPC, egress-all, no ingress (ALB reaches Lambda via the Lambda
   service, not the network).
7. `aws_lb_target_group` with `target_type = "lambda"`,
   `lambda_multi_value_headers_enabled = true`, and a health check on
   `/calendar/api/health` matching `200-299`, interval 300, timeout 10,
   healthy/unhealthy threshold 3. **The name must fit AWS's 32-character
   target-group limit** — use `${local.name_prefix_short}-cal-tg`.
8. `aws_lambda_permission` allowing `elasticloadbalancing.amazonaws.com` with
   `source_arn` set to the target group ARN.
9. `aws_lb_listener_rule` on the shared 443 listener with **`priority = 121`**
   (119 is taken by the chatbot on the same ALB — a duplicate priority fails
   apply), a `host_header` condition for
   `${var.sub_domain}.<basestack domain_name>` and a `path_pattern` condition
   for `/calendar*`.
10. `aws_lb_target_group_attachment` with `depends_on` on the permission.

Environment variables on the function — every secret read with
`lookup(local.secrets, "KEY", "")`:
`CALENDAR_CONNECTIONS_TABLE`, `CALENDAR_EVENTS_TABLE`, `CALENDAR_KMS_KEY_ID`,
`CALENDAR_LOG_GROUP_NAME`, `CALENDAR_LOG_LEVEL` (from a new
`var.calendar_log_level` validated to `none|basic|verbose`), `PUBLIC_BASE_URL`
(`https://${var.sub_domain}.<domain_name>`), `ALLOWED_ORIGINS`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
`ANTHROPIC_API_KEY`, and `ANTHROPIC_MODEL` from a new `var.anthropic_model`.

Set `var.anthropic_model` default to **`claude-opus-5`** — the current Opus,
1M context, $5/$25 per MTok. Document in the variable description that
`claude-sonnet-5` is the cheaper option ($3/$15, near-Opus quality on this
class of extraction task) and that the value is a plain model id with **no date
suffix**.

Also create `src/lambda/calendar/index.mjs` and
`src/lambda/calendar/package.json`. The handler is ESM (`"type": "module"`) and
must answer `GET /calendar/api/health` with `200` and a small JSON body, and
return `404` JSON for anything else — later tickets add real routes. Note that
`__dirname` does not exist in ESM: derive it with
`dirname(fileURLToPath(import.meta.url))`, exactly as
`ohq-chatbot2/src/lambda/chatbot/index.mjs` does. Add the in-memory
`fileCache` Map the chatbot uses, ready for the frontend ticket.

## Acceptance Criteria
- [ ] `archive_file` zips `../src/lambda/calendar` to
      `packages/lambda_function_calendar.zip` with the four excludes.
- [ ] The Lambda is named `${local.name_prefix}-school-calendar`, runs
      `nodejs24.x`, handler `index.handler`, timeout 60, memory 512, and sets
      `source_code_hash` from the archive's `output_base64sha256`.
- [ ] The Lambda has a `vpc_config` using the new security group and the
      basestack private subnets.
- [ ] The function's `environment` derives its own ARN from `locals`, not from
      `aws_lambda_function.calendar.arn` — `terraform plan` reports no cycle.
- [ ] The IAM policy grants DynamoDB actions on both table ARNs **and** on
      `"<events table arn>/index/*"`.
- [ ] The IAM policy grants KMS actions scoped to the TASK-002 key ARN only,
      and `secretsmanager:GetSecretValue` scoped to the app-config secret ARN —
      neither uses `Resource = "*"`.
- [ ] No IAM statement in this file uses `Resource = "*"` except the
      CloudWatch Logs and `ec2:*NetworkInterface*` statements.
- [ ] The security group allows all egress and declares no ingress rule.
- [ ] The target group name is `${local.name_prefix_short}-cal-tg` and is at
      most 32 characters for every tenant/environment combination.
- [ ] The target group health check path is `/calendar/api/health` with matcher
      `200-299`, and `lambda_multi_value_headers_enabled = true`.
- [ ] The listener rule uses `priority = 121` and both a `host_header` and a
      `path_pattern` (`/calendar*`) condition.
- [ ] `aws_lb_target_group_attachment` has `depends_on` on the
      `aws_lambda_permission`.
- [ ] `var.anthropic_model` defaults to `claude-opus-5`, and its description
      names `claude-sonnet-5` as the cheaper alternative and warns against
      appending a date suffix.
- [ ] `var.calendar_log_level` validates membership of `none|basic|verbose`.
- [ ] Every secret-derived env var uses `lookup(local.secrets, "KEY", "")` so a
      partially-populated secret still plans.
- [ ] `src/lambda/calendar/index.mjs` returns 200 with a JSON body for
      `GET /calendar/api/health` and 404 JSON for an unknown path.
- [ ] `index.mjs` derives `__dirname` via `fileURLToPath(import.meta.url)` and
      contains no bare `__dirname` reference.
- [ ] `src/lambda/calendar/package.json` sets `"type": "module"` and
      `"main": "index.mjs"`.
- [ ] `terraform validate` succeeds with TASK-001, TASK-002 and this file.

## Cucumber Tests
```gherkin
Feature: Calendar Lambda and ALB wiring
  Scenario: The ALB health check passes
    Given the calendar lambda handler
    When an ALB event for "GET /calendar/api/health" is invoked
    Then the response status code is 200
    And the response content type is "application/json"

  Scenario: An unknown path is rejected rather than served
    Given the calendar lambda handler
    When an ALB event for "GET /calendar/api/nope" is invoked
    Then the response status code is 404

  Scenario: The handler runs as an ES module without __dirname
    Given the file "src/lambda/calendar/index.mjs"
    Then it does not contain a bare "__dirname" reference
    And it derives the directory from "import.meta.url"

  Scenario: The listener rule does not collide with the chatbot's
    Given the calendar listener rule
    Then its priority is 121
    And its priority is not 119

  Scenario: The target group name fits the AWS limit
    Given the tenant "au" and environment "dev"
    When the target group name is rendered
    Then its length is at most 32 characters

  Scenario: Index queries are permitted by IAM
    Given the calendar lambda IAM policy
    Then its DynamoDB resource list includes the events table ARN suffixed with "/index/*"

  Scenario: The lambda cannot decrypt with an unrelated KMS key
    Given the calendar lambda IAM policy
    Then its KMS statement resource is exactly the calendar CMK ARN

  Scenario: A missing secret key does not break the plan
    Given the app-config secret omits "SESSION_SECRET"
    When terraform renders the lambda environment
    Then SESSION_SECRET is an empty string and rendering succeeds
```

## Additional Context
