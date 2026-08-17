---
id: TASK-008
title: Scan orchestration — manual trigger and EventBridge schedule
status: todo
created: 2026-08-17T11:00:00Z
updated: 2026-08-17T11:00:00Z
depends-on: TASK-007
---

## Description
Wire fetching and extraction into a single scan operation, exposed two ways: a
"Scan now" button endpoint, and a recurring EventBridge Scheduler schedule the
user configures from the UI. This mirrors the chatbot's scheduled-summary
pattern in `ohq-chatbot2/terraform/lambda_chatbot.tf` and
`src/lambda/chatbot/backend/summary-schedule.mjs`.

Depends on TASK-007.

New files:
- `src/lambda/calendar/backend/scan.mjs`
- `src/lambda/calendar/backend/scan-schedule.mjs`
- `terraform/scheduler_calendar.tf`

**`scan.mjs`** — `runScan({ userId, mode })` where `mode` is `"manual"` or
`"scheduled"`:
1. Load the connection. If `searchDomains` is unset, return a
   `not_configured` result without calling Gmail.
2. Compute `since` from `lastScanAt` minus a 2-day overlap window — school
   emails are edited and resent, and an exact watermark drops mail that arrived
   during the previous scan. Idempotent `eventId`s make the overlap free.
3. `fetchCandidateMessages`, extract each message, persist events.
4. Update the connection with `lastScanAt`, `lastScanStatus`
   (`ok` | `partial` | `reauth_required` | `error`), `lastScanError` (a short
   message, never a token or body), and counts.
5. Return `{ status, messagesScanned, eventsCreated, eventsUpdated, skipped, truncated, errors }`.

Concurrency: a scan is not re-entrant. Guard with a conditional update that
sets `scanInProgress` + `scanStartedAt` only when the attribute is absent or
older than 15 minutes (a stale lock from a timed-out invocation must not wedge
the account forever). A second concurrent scan returns `409`, and the lock is
released in a `finally` so a thrown error does not leave it set.

**Routes:**
- `POST /calendar/api/scan` — authenticated; runs a scan for the session user
  and returns the result. `409` when a scan is already running. Because a full
  scan can exceed a browser's patience, cap `maxMessages` for manual scans at
  50 and report `truncated`.
- `GET /calendar/api/scan/status` — last scan status/counts from the connection.
- `GET|PUT|DELETE /calendar/api/scan/schedule` — read, upsert and remove the
  user's schedule.

**`scan-schedule.mjs`** — manage one EventBridge schedule per user via
`@aws-sdk/client-scheduler`. Schedule name
`${SCAN_SCHEDULE_PREFIX}-<sha256(userId) first 16 hex chars>` — the raw
`userId` must not appear in an AWS resource name, and scheduler names have a
restricted character set and length limit. Target: this Lambda's ARN with input
`{"source":"scheduled-scan","userId":"..."}`, using
`SCAN_SCHEDULER_ROLE_ARN`. Accept `frequency` (`daily` | `weekly`), `hour`
(0–23), `dayOfWeek` for weekly, and an IANA `timezone`; render a cron
expression and pass the timezone to Scheduler rather than doing offset maths.
Validate every field and return `400` on anything out of range. When
`SCAN_SCHEDULER_ROLE_ARN` or the function ARN is empty, report the feature as
disabled instead of failing — mirror `isScheduleEnabled` in the chatbot.

**Scheduled invocation path** — `index.mjs` must detect the non-ALB event shape
`{ source: "scheduled-scan", userId }` **before** any ALB routing, run the scan
for that user, and return a plain result object (there is no HTTP response to
build). Add an `isScheduledScanEvent(event)` predicate, as the chatbot does with
`isScheduledSummaryEvent`.

**`scheduler_calendar.tf`:**
- `aws_iam_role` `${local.name_prefix}-calendar-sched-role` assumable by
  `scheduler.amazonaws.com`, with an inline policy allowing
  `lambda:InvokeFunction` on the calendar function ARN and `"<arn>:*"`.
- Extend the Lambda policy (TASK-003) with `scheduler:GetSchedule`,
  `CreateSchedule`, `UpdateSchedule`, `DeleteSchedule`, `ListSchedules` scoped
  to `arn:aws:scheduler:${var.region}:${var.account_id}:schedule/default/${prefix}-*`
  — not account-wide schedule management.
- Add an `iam:PassRole` statement for the scheduler role, conditioned on
  `StringEquals { "iam:PassedToService" = "scheduler.amazonaws.com" }`, so the
  Lambda cannot hand this role to any other service.
- New env vars: `SCAN_SCHEDULE_PREFIX` (`${local.name_prefix}-calendar-scan`),
  `SCAN_SCHEDULE_GROUP` (`default`), `SCAN_SCHEDULER_ROLE_ARN`,
  `CALENDAR_FUNCTION_ARN` (from the `locals` value, not the resource attribute).

## Acceptance Criteria
- [ ] `runScan` returns `not_configured` without calling Gmail when
      `searchDomains` is unset.
- [ ] `since` is `lastScanAt` minus a 2-day overlap; a first-ever scan uses the
      90-day default from TASK-006.
- [ ] After a successful scan the connection records `lastScanAt`,
      `lastScanStatus`, and the counts.
- [ ] `lastScanError` never contains a token, an email body, or a subject.
- [ ] A second scan started while one is in progress returns `409` and does not
      call Gmail.
- [ ] A `scanInProgress` lock older than 15 minutes is treated as stale and
      overridden.
- [ ] The lock is released even when the scan throws.
- [ ] `POST /calendar/api/scan` requires a session (`401` without one) and caps
      manual scans at 50 messages, reporting `truncated`.
- [ ] `GET /calendar/api/scan/status` returns the last scan status and counts.
- [ ] `PUT /calendar/api/scan/schedule` creates or updates exactly one schedule
      for the user and returns the stored settings.
- [ ] `DELETE /calendar/api/scan/schedule` removes the schedule and clears
      `scheduleEnabled`.
- [ ] The schedule name contains a hash of the userId and no raw `userId`,
      email address, or `@` character.
- [ ] `hour` outside 0–23, an unknown `frequency`, or an invalid IANA timezone
      each return `400`.
- [ ] The timezone is passed to EventBridge Scheduler rather than baked into
      the cron via offset arithmetic.
- [ ] When `SCAN_SCHEDULER_ROLE_ARN` is empty, the schedule endpoints report
      the feature disabled instead of throwing.
- [ ] `isScheduledScanEvent` matches `{ source: "scheduled-scan", userId }` and
      is evaluated before ALB routing; a scheduled event runs a scan and returns
      a plain object, not an HTTP response shape.
- [ ] A scheduled event with no `userId` is rejected without running a scan.
- [ ] The scheduler IAM role is assumable only by `scheduler.amazonaws.com` and
      may only invoke the calendar function.
- [ ] The Lambda's `scheduler:*` statement is scoped to the
      `${prefix}-*` schedule ARN pattern, not `*`.
- [ ] The `iam:PassRole` statement is conditioned on
      `iam:PassedToService = scheduler.amazonaws.com`.
- [ ] `CALENDAR_FUNCTION_ARN` comes from `locals`, so `terraform plan` reports
      no dependency cycle.
- [ ] All AWS SDK, Gmail and Anthropic calls are mocked in tests.

## Cucumber Tests
```gherkin
Feature: Scanning for school events
  Scenario: A configured user scans on demand
    Given an authenticated user with searchDomains set and 3 matching emails
    When they POST "/calendar/api/scan"
    Then the response status code is 200
    And messagesScanned is 3
    And the connection lastScanStatus becomes "ok"

  Scenario: An unconfigured user is told to configure, not shown an error
    Given an authenticated user with no searchDomains
    When they POST "/calendar/api/scan"
    Then the result status is "not_configured"
    And no Gmail call is made

  Scenario: Overlapping scans are refused
    Given a scan started 1 minute ago is still in progress
    When the user POSTs "/calendar/api/scan"
    Then the response status code is 409
    And no Gmail call is made

  Scenario: A stale lock does not wedge the account
    Given a scanInProgress lock set 30 minutes ago
    When the user POSTs "/calendar/api/scan"
    Then the scan runs
    And the response status code is 200

  Scenario: A crashed scan releases its lock
    Given extraction throws during a scan
    When the scan finishes
    Then scanInProgress is cleared
    And lastScanStatus is "error"

  Scenario: Rescans overlap so nothing is missed
    Given lastScanAt is 2026-08-15T09:00:00Z
    When a scan computes its since date
    Then since is 2026-08-13

  Scenario: A revoked grant surfaces as reauth, not a generic failure
    Given the stored refresh token has been revoked
    When a scan runs
    Then lastScanStatus becomes "reauth_required"

  Scenario: Scheduling a daily scan
    Given an authenticated user
    When they PUT a schedule of frequency "daily", hour 7, timezone "Australia/Sydney"
    Then exactly one EventBridge schedule is created for them
    And the schedule timezone is "Australia/Sydney"

  Scenario: The schedule name does not leak the user identity
    Given a user whose userId is "google#123456789"
    When the schedule name is rendered
    Then it does not contain "123456789"
    And it does not contain "@"

  Scenario Outline: Invalid schedule settings are refused
    Given an authenticated user
    When they PUT a schedule with <field> "<value>"
    Then the response status code is 400
    Examples:
      | field     | value            |
      | hour      | 25               |
      | frequency | hourly           |
      | timezone  | Mars/Olympus_Mons |

  Scenario: Deleting a schedule stops future scans
    Given a user with an existing schedule
    When they DELETE "/calendar/api/scan/schedule"
    Then the EventBridge schedule is deleted
    And scheduleEnabled is false

  Scenario: The scheduled invocation runs a scan
    Given an event {"source":"scheduled-scan","userId":"google#1"}
    When the handler is invoked
    Then a scan runs for "google#1"
    And the return value is not an HTTP response shape

  Scenario: A scheduled event without a user is rejected
    Given an event {"source":"scheduled-scan"}
    When the handler is invoked
    Then no scan runs

  Scenario: Scheduling is hidden when not provisioned
    Given SCAN_SCHEDULER_ROLE_ARN is an empty string
    When the schedule endpoint is requested
    Then it reports the feature as disabled
    And no exception is thrown
```

## Additional Context
