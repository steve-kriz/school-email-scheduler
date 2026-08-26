---
id: TASK-054
title: Two tests named "proves it discriminates" assert nothing and pass with terraform absent
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: medium
---

## Description
`tests/unit/terraform-discriminators.test.js:143-155`, named
"would FAIL if lookup default were wrong - this proves it discriminates",
asserts only:

```js
assert.notEqual(result.value, 'fallback-value', ...);
assert.notEqual(result.value, 'ANTHROPIC_API_KEY', ...);
```

It never checks `result.ok`. When `tryEvaluateSecretExpression` fails it returns
`{ ok: false, error }` with **no `value`**, so `result.value` is `undefined` and
both assertions pass. The test is green with terraform absent, misinstalled, or
erroring for any reason. (Confirmed by direct inspection.)

The companion at `:171-183` is likewise near-tautological: `assert.notEqual(result.ok, true)`
merely restates the `assert.equal(result.ok, false)` already made at `:165`, and
`assert.ok(result.error.length > 0)` adds nothing.

Fix: assert `result.ok === true` and the exact expected value in the first; make
the second either a real inverted-expectation proof or delete it as redundant.

## Impact If Not Fixed
Two tests advertised as discrimination proofs assert nothing, and they pad the
46/46 count with false confidence about precisely the property the ticket was
raised to establish. Worse, they stay green on a machine with no terraform at
all, so a CI runner missing the binary would look healthy.

## Acceptance Criteria
- [ ] The test at `:143-155` asserts `result.ok === true` and the exact expected value (`""`).
- [ ] It fails when terraform is unavailable or errors, rather than passing on an undefined value.
- [ ] The redundant assertions at `:171-183` are replaced with a real proof or removed.
- [ ] Every remaining test in the file is checked for the same `undefined`-passes-notEqual shape; report what the sweep found.
- [ ] Each fix is verified by making the evaluation genuinely fail and observing the test redden.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Discrimination proofs actually discriminate
  Scenario: The lookup default test fails when evaluation fails
    Given terraform evaluation returns ok false with no value
    When the test runs
    Then it fails

  Scenario: The lookup default test passes only on the exact expected value
    Given the lookup default is changed to "fallback-value"
    When the test runs
    Then it fails
```

## Additional Context
