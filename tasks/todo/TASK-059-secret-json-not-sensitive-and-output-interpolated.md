---
id: TASK-059
title: The fixture's secret_json variable is not marked sensitive and raw terraform output is printed
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: low
---

## Description
`tests/e2e/terraform-scaffold.test.js:148-150` and
`tests/unit/terraform-discriminators.test.js:50-52` declare
`variable "secret_json"` without `sensitive = true`.

`describeExecError` (`tests/e2e/terraform-scaffold.test.js:39-48`) concatenates
raw `stdout` + `stderr` into an `Error` message, which is then embedded in
assertion text and `console.error`.

There is **no leak today**: the payloads are hard-coded fakes
(`'test-google-client-secret'`), the payload travels via the `TF_VAR_secret_json`
env var rather than the shell command line or a file, `terraform console` writes
no state, and the temp workspace `main.tf` contains no values. The `env: { ...process.env }`
pass-through does forward the developer's real credentials into the child, which
is harmless here only because the fixture declares no provider and makes no AWS
call.

This is hardening against the obvious future misuse, not a live defect.

## Impact If Not Fixed
The harness is an inviting template to copy against a real payload. At that
point terraform diagnostics containing key names or values would be printed into
CI logs verbatim, and the unmarked variable would let terraform echo values in
its own output. Marking the variable sensitive and truncating or redacting
captured output is cheap insurance taken before the mistake, not after.

## Acceptance Criteria
- [ ] `variable "secret_json"` is declared `sensitive = true` in both fixtures.
- [ ] `describeExecError` redacts or truncates captured `stdout`/`stderr` rather than interpolating it whole.
- [ ] A test asserts that a payload value planted in the fixture never appears in an assertion message or console output on the failure path.
- [ ] The child process receives only the environment it needs, rather than the developer's full environment, or the pass-through is documented as deliberate with its safety condition stated.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Secret values never reach logs
  Scenario: A failing evaluation does not print the payload
    Given a payload containing the sentinel value "SENTINEL-SECRET"
    When the terraform evaluation fails and the error is reported
    Then the reported message does not contain "SENTINEL-SECRET"

  Scenario: The variable is marked sensitive
    Given the fixture's variable declaration
    Then it declares sensitive = true
```

## Additional Context
