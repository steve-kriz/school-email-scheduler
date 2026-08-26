---
id: TASK-061
title: The allowlist coercion is untested in isOriginAllowed and buildResponse, so AC1 is met on one path only
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: medium
---

## Description
TASK-022's AC1 names three entry points that must survive a malformed allowlist:
`getCorsOrigin`, `isOriginAllowed` and `buildResponse`.

Only `getCorsOrigin` is actually tested with one. A grep across `tests/**` finds
no call passing `null`, a string, a number or an object as `isOriginAllowed`'s
second argument, and no `allowlist: null` in any `buildResponse` options. Every
test reaches `isOriginAllowed` **through** `getCorsOrigin`, which has already
coerced the list — so the coercion at `src/lambda/calendar/index.mjs:158` is
never exercised with a malformed value.

The reviewer's assessment (reasoned, not executed): deleting line 158 would
leave the suite green.

## Impact If Not Fixed
Two of the three entry points the ticket set out to harden have no regression
guard. A later refactor can silently reintroduce the `TypeError`-on-`null`
unhandled 5xx that TASK-022 exists to remove, and the acceptance criterion is
recorded as met on evidence covering only one of the three functions.

## Acceptance Criteria
- [ ] `isOriginAllowed` is called directly with `null`, a string, a number and an object as its allowlist argument, and each returns without throwing.
- [ ] `buildResponse` is called directly with `allowlist: null` and a non-array, and each returns a well-formed response.
- [ ] Deleting the coercion at `index.mjs:158` reddens at least one test, verified by applying the mutation and confirming it applied.
- [ ] Deleting the coercion from the `buildResponse` path likewise reddens a test.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Every allowlist entry point survives a malformed value
  Scenario Outline: A malformed allowlist does not throw
    Given <fn> is called directly with an allowlist of <value>
    Then it returns without throwing
    Examples:
      | fn              | value  |
      | isOriginAllowed | null   |
      | isOriginAllowed | "text" |
      | buildResponse   | null   |
      | buildResponse   | 42     |

  Scenario: Removing a coercion is caught
    Given the coercion in isOriginAllowed is deleted
    When the suite runs
    Then at least one test fails
```

## Additional Context
