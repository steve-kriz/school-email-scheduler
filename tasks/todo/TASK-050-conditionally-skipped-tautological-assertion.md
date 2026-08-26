---
id: TASK-050
title: A conditionally-skipped, near-tautological assertion survived the attempt-2 rewrite
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: low
---

## Description
`tests/unit/calendar-settings-public-mail.test.js:472-480` has two defects at
once:

1. The whole body is wrapped in `if (longDomain.length <= 253) { ... }`, so every
   assertion inside silently vanishes if the constants change. A test that can
   skip itself without saying so is indistinguishable from a passing test.
2. The assertion itself is `assert.ok(result === null || result.name, 'Should not
   crash')`, which accepts both possible outcomes. It can only fail if the call
   throws.

This is the same shape as the tautological if/else that made TASK-032 attempt 1
red and was supposedly retired in attempt 2.

Fix: assert the specific expected result for the long-domain edge
unconditionally, and if a length precondition genuinely matters, assert the
precondition instead of branching on it.

## Impact If Not Fixed
Leaving one of these behind re-establishes the pattern as acceptable in the very
file where it was just removed, and gives false confidence that the long-domain
edge is pinned when nothing is pinning it. The next reader copies the shape.

## Acceptance Criteria
- [ ] The long-domain edge is asserted unconditionally, with the specific expected result rather than an either-or.
- [ ] Any length precondition is asserted, not used as a silent skip.
- [ ] The test fails when the long-domain behaviour regresses, proven by mutation with the mutation confirmed to have applied.
- [ ] The file contains no remaining assertion that accepts both outcomes, and no assertion body wrapped in a condition that can silently skip it — sweep the file and report what was found.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The long-domain edge is genuinely pinned
  Scenario: A 253-character domain resolves to a specific documented result
    Given a domain at the maximum permitted length
    When registrableName is called
    Then it returns the specific documented result

  Scenario: The assertion cannot silently skip
    Given the length constants are changed
    When the suite runs
    Then the test still executes its assertions
```

## Additional Context
