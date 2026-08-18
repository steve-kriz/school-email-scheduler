---
id: TASK-016
title: Remove the TTL reaper from the connections table
status: todo
created: 2026-08-18T00:05:00Z
updated: 2026-08-18T00:05:00Z
review-of: TASK-002
---

## Description
`terraform/dynamodb_calendar_connections.tf` (around lines 57–60) enables:

```hcl
ttl {
  attribute_name = "ttl"
  enabled        = true
}
```

TASK-002's connections schema deliberately does not include a `ttl` attribute —
only the events table's does — and the file's own schema comment block (around
lines 11–36) correctly omits it, so the comment and the resource currently
disagree with each other.

Remove the block. Also remove the comment above it that justifies it, so the
file stops documenting a behaviour it no longer has.

**Build this before TASK-007 and TASK-009 land.** Those tickets introduce the
first code that writes to connection items, and they also write TTL-stamped
events. That is precisely when a shared write helper could start stamping `ttl`
onto a connection row.

Leave the events table's `ttl` block exactly as it is — TTL is correct and
specified there.

Note for sequencing: `tests/unit/dynamodb-calendar.test.js` and
`tests/e2e/dynamodb-calendar.test.js` are also edited by TASK-017. These two
tickets must not be built concurrently.

## Impact If Not Fixed
The connections table holds the only copy of each user's encrypted Gmail refresh
token. An enabled TTL reaper with no current writer is inert today, but any later
code path that stamps a `ttl` attribute onto a connection item — most plausibly
by reusing an events-table write helper, where TTL stamping is correct and
expected — would silently and permanently expire that user's OAuth grant. The
user would simply stop receiving events with no in-app signal, and recovery
would require a manual point-in-time restore to a new table within the retention
window.

## Acceptance Criteria
- [ ] The `ttl` block is removed from `terraform/dynamodb_calendar_connections.tf`.
- [ ] The comment justifying the connections TTL is removed with it.
- [ ] The events table's `ttl` block is unchanged and still enabled on attribute
      `ttl`.
- [ ] The connections table still has `point_in_time_recovery` enabled and
      `server_side_encryption` referencing the calendar CMK.
- [ ] No other attribute, index, or setting on either table changes.
- [ ] A test asserts the connections table has **no** `ttl` block, so the
      removal cannot be silently reverted.
- [ ] That test distinguishes the two tables — it must fail if the block is
      re-added to connections, and must not fire on the events table's
      legitimate `ttl` block.
- [ ] `terraform init -backend=false && terraform validate` reports 0 errors.
- [ ] `terraform fmt -check -recursive` is clean.
- [ ] The full suite passes under `node --test tests/unit tests/e2e`.

## Cucumber Tests
```gherkin
Feature: The OAuth grant table has no expiry reaper
  Scenario: The connections table declares no TTL
    Given terraform/dynamodb_calendar_connections.tf
    Then it contains no ttl block

  Scenario: The events table keeps its TTL
    Given terraform/dynamodb_calendar_events.tf
    Then it declares a ttl block enabled on attribute "ttl"

  Scenario: Re-adding the connections TTL turns the suite red
    Given a copy of the connections file with a ttl block re-added
    When the guard assertion runs
    Then it fails

  Scenario: The test does not confuse the two tables
    Given the events table's legitimate ttl block
    When the connections guard assertion runs
    Then it does not fire on the events table

  Scenario: Durability settings survive the change
    Given terraform/dynamodb_calendar_connections.tf
    Then point_in_time_recovery is enabled
    And server_side_encryption references the calendar KMS key

  Scenario: The configuration still validates
    When terraform validate runs after terraform init -backend=false
    Then error_count is 0
```

## Additional Context
