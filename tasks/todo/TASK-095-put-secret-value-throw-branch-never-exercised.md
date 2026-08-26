---
id: TASK-095
title: The ordering guard's missing-put-secret-value throw branch is never exercised
status: todo
created: 2026-08-18T10:05:00.000Z
updated: 2026-08-18T10:05:00.000Z
review-of: TASK-028
severity: low
---

## Description
`assertCreateBeforePutOrdering`
(`tests/e2e/check-oauth-config.test.js:173-189`) has **two** loud-failure
branches: one when `create-secret` is absent (`:174-178`) and one when
`put-secret-value` is absent (`:179-184`).

Only the first is tested. The fixtures at `:1089-1106` remove `create-secret`;
no fixture removes `put-secret-value`, so the second `throw new Error` is dead
code in the suite.

TASK-028's own principle — a guard that cannot find what it is guarding must be
loud — is therefore proved for one marker and assumed for the other.

## Impact If Not Fixed
If a refactor turns the `put-secret-value` branch back into a silent `return`,
nothing catches it, and the ordering invariant re-acquires exactly the fail-open
this ticket removed — this time on the other marker, and with a test suite that
looks like it covers both.

## Acceptance Criteria
- [ ] A fixture removes `put-secret-value` and asserts the helper throws.
- [ ] The fixture self-checks that the removal actually applied before asserting the throw, matching the discipline already used at `:1071` and `:1095`.
- [ ] Turning that branch into a silent `return` reddens a test, verified by applying the mutation and confirming it applied.
- [ ] Both throw messages name which marker was missing.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The ordering guard is loud about either missing marker
  Scenario Outline: A missing marker fails loudly
    Given a runbook fixture with <marker> removed
    When the ordering guard runs
    Then it throws naming <marker>
    Examples:
      | marker            |
      | create-secret     |
      | put-secret-value  |

  Scenario: A silent return is caught
    Given the put-secret-value branch returns instead of throwing
    When the suite runs
    Then at least one test fails
```

## Additional Context
