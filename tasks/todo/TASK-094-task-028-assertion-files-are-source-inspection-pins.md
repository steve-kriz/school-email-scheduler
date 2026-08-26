---
id: TASK-094
title: Both task-028-assertions files are source-inspection pins that survive the mutations they claim to catch
status: todo
created: 2026-08-18T10:05:00.000Z
updated: 2026-08-18T10:05:00.000Z
review-of: TASK-028
severity: medium
---

## Description
`tests/e2e/task-028-assertions.test.js` (15 tests) and
`tests/unit/task-028-assertions.test.js` (22 tests) do not import or invoke a
single thing under test. All 37 tests `fs.readFileSync(<some test file>)` and
regex-match the **source text**.

Concretely:

- `e2e/task-028-assertions.test.js:21-50` carries the comment *"The mutation
  check: if we made `terraformCreatesSecretClaimsIn` return `[]`, this test would
  fail (proving the assertion is real)."* That is **false** — the test never
  calls the function; it greps for the string `claims.length > 0`.
- Inverting `assertCreateBeforePutOrdering`'s comparison to
  `createMatch.index > putMatch.index` leaves every test in both files green,
  because they only count `throw new Error` occurrences (`unit:62-63`,
  `e2e:114-115`).
- "Passes if the thing under test is deleted" shapes: `unit:32-35`
  (`/claims\.length > 0/` matches nine unrelated sites), `unit:90-93` and
  `unit:168-178` (`assert.equal(result.code, 0` appears at five sites).
- Near-tautological: `unit:279-282`, `unit:290-293`, `e2e:302`.
- `unit:181-216` hard-codes a three-file list, encoding the narrow reading of the
  sweep criterion so it can never surface the missing instances.
- The two files duplicate roughly 90% of each other's assertions across the
  unit/e2e boundary.

The genuine coverage for TASK-028 lives in the files under test —
`check-oauth-config.test.js:1056-1106` really calls the helper via
`assert.throws`, and the exit-code assertions were proved by an executed
mutation. So nothing is currently uncovered; these 37 tests simply add no
discrimination.

## Impact If Not Fixed
A ticket whose entire purpose was eliminating assertions that report success over
unexercised behaviour has shipped 37 more of them, plus a comment falsely stating
a mutation-proof was performed. The next reviewer counting green tests will
over-estimate this area's coverage, and the brittle source-text regexes will
produce false failures on any cosmetic edit to the files they inspect.

## Acceptance Criteria
- [ ] Every retained test imports and invokes the behaviour it names, rather than grepping source text.
- [ ] Inverting `assertCreateBeforePutOrdering`'s comparison reddens at least one test, verified by applying the mutation and confirming it applied.
- [ ] Making `terraformCreatesSecretClaimsIn` return `[]` reddens at least one test.
- [ ] The false mutation-proof comment at `e2e:21-50` is removed or made true.
- [ ] Duplication between the unit and e2e files is resolved — each assertion lives in one place.
- [ ] Any test that cannot be made discriminating is deleted rather than kept for the count.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Tests for the assertion-quality ticket are themselves discriminating
  Scenario: Inverting the ordering comparison is caught
    Given assertCreateBeforePutOrdering compares its indices the wrong way round
    When the suite runs
    Then at least one test fails

  Scenario: Emptying the claims function is caught
    Given terraformCreatesSecretClaimsIn returns an empty array
    When the suite runs
    Then at least one test fails

  Scenario: A cosmetic reformat does not break the suite
    Given the inspected test files are reformatted without behaviour change
    When the suite runs
    Then it stays green
```

## Additional Context
