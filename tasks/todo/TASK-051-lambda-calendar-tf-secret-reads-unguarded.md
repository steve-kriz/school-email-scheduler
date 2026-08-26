---
id: TASK-051
title: The secret-read guard covers only main.tf, leaving lambda_calendar.tf's five reads unguarded
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: high
---

## Description
`tests/e2e/terraform-scaffold.test.js:474-482` applies
`assertAllSecretReadsAreGuarded` to `terraform/main.tf` alone. But
`terraform/lambda_calendar.tf:130-140` performs **five more** `local.secrets`
reads — and that is the file that injects the secrets into the Lambda's
environment.

The only check on that file, `tests/unit/calendar-lambda-terraform.test.js:204-208`,
is a *positive-presence* regex per key. It passes as long as the guarded form
exists somewhere, and cannot fail when an **additional** direct index
`local.secrets["X"]` is introduced anywhere in the file.

Fix: run the guard over `lambda_calendar.tf` too — ideally over every `.tf` file
in `terraform/`, so a new file cannot silently escape it.

Note this was correctly NOT treated as a defect in TASK-015: that ticket's AC
explicitly scoped the parse to `main.tf`. This is scope extension.

## Impact If Not Fixed
The precise regression the guard exists to prevent can still ship, in the very
file that wires secrets into the Lambda environment. A fresh tenant with a
partially-populated secret would fail `terraform plan` with `Invalid index`
while the test suite stayed green — the exact failure mode TASK-015 was raised
to make impossible.

## Acceptance Criteria
- [ ] `assertAllSecretReadsAreGuarded` runs over `terraform/lambda_calendar.tf` as well as `main.tf`.
- [ ] The guard runs over every `.tf` file in `terraform/`, discovered dynamically, so a newly added file is covered without a test edit.
- [ ] Introducing a direct index into `lambda_calendar.tf` reddens a test, verified by applying the mutation and confirming it applied.
- [ ] The weak positive-presence regex at `tests/unit/calendar-lambda-terraform.test.js:204-208` is replaced or supplemented so it can fail on an added direct index.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Every secret read in every terraform file is guarded
  Scenario Outline: A direct index anywhere is caught
    Given a direct index local.secrets["SESSION_SECRET"] is added to <file>
    When the guard runs
    Then it reports a violation naming SESSION_SECRET
    Examples:
      | file                |
      | main.tf             |
      | lambda_calendar.tf  |

  Scenario: A newly added terraform file is covered automatically
    Given a new .tf file containing an unguarded secret read
    When the suite runs
    Then at least one test fails
```

## Additional Context
