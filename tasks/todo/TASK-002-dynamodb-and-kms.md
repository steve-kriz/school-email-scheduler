---
id: TASK-002
title: DynamoDB connection and event tables with a KMS CMK
status: testing
created: 2026-08-17T11:00:00Z
updated: 2026-08-17T23:54:27Z
depends-on: TASK-001
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-17T23:50:31Z","finishedAt":"2026-08-17T23:53:10Z","tokens":24737}]
---

## Description
Create the two DynamoDB tables and the customer-managed KMS key that protects
the stored Gmail refresh tokens. Follow the style of
`ohq-chatbot2/terraform/dynamodb_chatbot_features.tf`: a leading comment block
documenting the full schema, `billing_mode = "PAY_PER_REQUEST"`, a `ttl` block,
`point_in_time_recovery`, and `tags = merge(var.tags, { Purpose = "..." })`.

Depends on TASK-001 (needs `local.name_prefix` and `var.tags`).

Files to add:
- `terraform/kms_calendar.tf`
- `terraform/dynamodb_calendar_connections.tf`
- `terraform/dynamodb_calendar_events.tf`

**KMS CMK** — `aws_kms_key` plus an `aws_kms_alias` named
`alias/${local.name_prefix}-school-calendar`. Enable key rotation, set a
`deletion_window_in_days` of 30, and write a key policy that grants the account
root full control and nothing else (the Lambda role gets `kms:Encrypt` /
`kms:Decrypt` via its own IAM policy in TASK-003, scoped to this key ARN).
Expose the key ARN and alias for later tickets via `output` blocks.

**Connections table** — `${local.name_prefix}-calendar-connections`, hash key
`userId` (S). Schema to document in the header comment:
- `userId` (PK) — `"google#<google sub claim>"`
- `email` — the connected Google account address
- `schoolName` — free-text school name entered by the user
- `searchDomains` (SS) — domains to match senders against
- `refreshTokenEnc` — base64 KMS ciphertext of the Gmail refresh token; the
  plaintext token is never written to this table
- `refreshTokenKeyId` — the CMK ARN used, so rotation can be detected
- `lastHistoryId`, `lastScanAt`, `lastScanStatus`, `lastScanError`
- `scheduleEnabled` (BOOL), `scheduleFrequency`, `scheduleHour`, `timezone`
- `createdAt`, `updatedAt`
No GSI is required — every access is a `GetItem`/`PutItem` by `userId`.
Enable `point_in_time_recovery` (this table holds the only copy of the OAuth
grant) and enable `server_side_encryption` with the CMK from `kms_calendar.tf`.

**Events table** — `${local.name_prefix}-calendar-events`, hash key `userId`
(S), range key `eventId` (S). Schema:
- `eventId` — deterministic sha256 hex of
  `sourceMessageId | normalisedTitle | startsAt`, so re-scanning the same email
  is idempotent and never duplicates an event
- `title`, `description`, `location`, `category`
- `startsAt`, `endsAt` (ISO-8601), `allDay` (BOOL)
- `needsAttention` (BOOL), `actionRequired`, `dueBy`
- `status` — `pending` | `acknowledged` | `dismissed`
- `sourceMessageId`, `sourceSubject`, `sourceFrom`, `sourceReceivedAt`
- `confidence` (N) — model-reported extraction confidence 0–1
- `createdAt`, `updatedAt`, `ttl`
Two global secondary indexes:
- `StartsAtIndex` — hash `userId`, range `startsAt`, `projection_type = "ALL"`.
  Backs the calendar month-range query.
- `AttentionIndex` — hash `attentionKey`, range `dueBy`, `projection_type =
  "ALL"`. **Sparse by design:** only events that are both `needsAttention` and
  `status = "pending"` carry an `attentionKey` attribute (value
  `"<userId>#pending"`); acknowledging or dismissing an event removes the
  attribute so the row drops out of the index. Document this in the header
  comment the way the chatbot's `ReplyTargetIndex` comment does, including the
  warning that IAM must grant access to `<table arn>/index/*` or the Query
  fails with AccessDeniedException.
Enable `ttl` on attribute `ttl` so long-past events age out, and enable
`server_side_encryption` with the same CMK.

## Acceptance Criteria
- [ ] `aws_kms_key` exists with rotation enabled, a 30-day deletion window, and
      an alias `alias/${local.name_prefix}-school-calendar`.
- [ ] The KMS key policy grants the account root full control and grants no
      other principal any action.
- [ ] The key ARN is exposed as a Terraform `output` so later tickets can
      reference it.
- [ ] `${local.name_prefix}-calendar-connections` exists with hash key `userId`
      (S), no range key, and no GSI.
- [ ] The connections table has `point_in_time_recovery` enabled and
      `server_side_encryption` referencing the CMK.
- [ ] `${local.name_prefix}-calendar-events` exists with hash key `userId` (S)
      and range key `eventId` (S).
- [ ] The events table declares a `StartsAtIndex` GSI (hash `userId`, range
      `startsAt`, projection ALL).
- [ ] The events table declares an `AttentionIndex` GSI (hash `attentionKey`,
      range `dueBy`, projection ALL), and both attributes are declared in
      `attribute` blocks.
- [ ] The events table has `ttl` enabled on the `ttl` attribute and
      `server_side_encryption` referencing the CMK.
- [ ] Both tables use `billing_mode = "PAY_PER_REQUEST"` and merge
      `var.tags` with a table-specific `Purpose` tag.
- [ ] Each table file opens with a comment block documenting every attribute,
      and the events file documents that `AttentionIndex` is sparse and that
      IAM must include `/index/*`.
- [ ] `terraform validate` succeeds with TASK-001's files plus these three.
- [ ] No plaintext refresh-token attribute is defined anywhere in the schema —
      only `refreshTokenEnc`.

## Cucumber Tests
```gherkin
Feature: Calendar data stores
  Scenario: Refresh tokens are only ever stored encrypted
    Given the connections table schema
    Then it documents a "refreshTokenEnc" attribute
    And it does not document any plaintext "refreshToken" attribute

  Scenario: A month of events can be read with one range query
    Given the events table
    Then a GSI named "StartsAtIndex" exists with hash key "userId" and range key "startsAt"

  Scenario: The attention index only holds items that need attention
    Given an event with needsAttention true and status "pending"
    Then the item carries an "attentionKey" attribute
    When the event is acknowledged
    Then the "attentionKey" attribute is removed and the item leaves AttentionIndex

  Scenario: Re-scanning the same email does not duplicate an event
    Given an email that yields an event titled "Sports Carnival" starting 2026-09-04
    When the same email is scanned a second time
    Then the computed eventId is identical
    And the events table still holds exactly one matching item

  Scenario: Both tables are encrypted with the project CMK
    Given the terraform configuration
    Then the connections table and the events table both set server_side_encryption to the calendar KMS key

  Scenario: The connections table can be restored after an accidental delete
    Given the connections table
    Then point_in_time_recovery is enabled
```

## Additional Context
