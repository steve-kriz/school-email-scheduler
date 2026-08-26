---
id: TASK-097
title: The terraform validate catch path discards the -json diagnostics it already holds
status: todo
created: 2026-08-18T10:05:00.000Z
updated: 2026-08-18T10:05:00.000Z
review-of: TASK-028
severity: low
---

## Description
`tests/e2e/terraform-scaffold.test.js:315-321`.

On a real validation error, `terraform validate -json` exits non-zero and writes
its structured diagnostics to **stdout**, leaving stderr typically empty. The
catch block reads `error.stdout` into `output` and `console.error`s it, but then
fails with:

```js
assert.fail(`terraform validate failed with status ${error.status}: ${stderr}`)
```

interpolating the empty `stderr` rather than the diagnostics it already has.

## Impact If Not Fixed
The one failure mode this test exists to report produces the message
`terraform validate failed with status 1: ` with no cause attached. Whoever
debugs it is sent to scroll back through console noise instead of reading the
assertion output, which is where the diagnostics belong.

## Acceptance Criteria
- [ ] The failure message interpolates the `-json` diagnostics from stdout, not the (usually empty) stderr.
- [ ] The message remains readable when stdout is large — summarise or truncate rather than dumping everything.
- [ ] A test drives a genuine validation error and asserts the failure message names the actual diagnostic.
- [ ] Console noise is not duplicated into the assertion message.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A failing terraform validate explains itself
  Scenario: A validation error surfaces its diagnostic
    Given a terraform configuration with a real validation error
    When the validate test runs
    Then the assertion message names the diagnostic from the json output

  Scenario: An empty stderr does not produce an empty message
    Given terraform writes diagnostics to stdout and nothing to stderr
    When the validate test fails
    Then the assertion message is not blank
```

## Additional Context
