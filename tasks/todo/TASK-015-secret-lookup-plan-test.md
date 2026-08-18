---
id: TASK-015
title: Prove a partially-populated secret still plans, instead of regexing for lookup()
status: todo
created: 2026-08-18T00:00:00Z
updated: 2026-08-18T00:00:00Z
review-of: TASK-001
---

## Description
`tests/e2e/terraform-scaffold.test.js` (around lines 116–135) implements the
Gherkin scenario *"A missing optional secret key does not break planning"* by
regexing `main.tf` for the literal pattern
`lookup(local.secrets, "ANTHROPIC_API_KEY", "")`. That proves the text is
present. It does not prove the behaviour the convention exists for: that a
secret JSON missing a key still evaluates cleanly instead of failing with
`Invalid index`.

Replace the pattern match with a behavioural test. The obstacle is that
`terraform plan` against `terraform/` needs AWS credentials for both the s3
backend and the real `aws_secretsmanager_secret_version` data source, so the
plan cannot be run directly. Test the evaluation semantics instead, without AWS:

- Build a temp directory containing a small `locals`-only configuration that
  reproduces the real pattern — a `secrets` local fed from a `jsondecode` of a
  **variable** standing in for the secret payload, plus the same
  `lookup(local.secrets, "KEY", "")` reads `main.tf` performs.
- `terraform init -backend=false`, then `terraform console` with a payload that
  **omits** `ANTHROPIC_API_KEY`, and assert the read yields `""` rather than
  erroring.
- Assert the contrasting failure: the same payload read as
  `local.secrets["ANTHROPIC_API_KEY"]` (direct index, no `lookup`) **errors**.
  That is what makes the test discriminating — it shows the convention is doing
  work, not that a string is present.

Then close the loop on the real file: assert that **every** secret read in
`terraform/main.tf` goes through `lookup(...)` with a default, by parsing the
file for `local.secrets` accesses and failing on any direct-index form. Cover
all five keys — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ANTHROPIC_API_KEY`, `SESSION_SECRET`, `ALLOWED_ORIGINS` — not just the one the
original scenario named. This assertion is what will catch a later ticket
introducing a direct index.

`terraform` v1.8.5 is installed at `C:\External\Terraform\terraform`.

## Impact If Not Fixed
The `lookup(..., "")` convention is the only thing that lets a new environment
deploy before its Secrets Manager payload is fully populated. Today only its
presence in one line of `main.tf` is asserted, so a later ticket that reads
`local.secrets["SESSION_SECRET"]` directly would keep the suite green and then
fail `terraform plan` with `Invalid index` in exactly the situation the
convention was meant to survive — a fresh tenant whose secret has not been
filled in yet.

## Acceptance Criteria
- [ ] The scenario evaluates a `lookup(local.secrets, "ANTHROPIC_API_KEY", "")`
      read against a payload that omits the key, and asserts the result is `""`.
- [ ] The same test asserts that a direct `local.secrets["ANTHROPIC_API_KEY"]`
      index against the same payload **errors**, proving the test discriminates.
- [ ] A parse of `terraform/main.tf` asserts every `local.secrets` access uses
      `lookup(...)` with a default, and fails on any direct-index access.
- [ ] All five secret keys are covered by that assertion, not just
      `ANTHROPIC_API_KEY`.
- [ ] No test asserts this behaviour by regexing for the `lookup(` literal
      alone.
- [ ] The temp directory used for evaluation is cleaned up even when the test
      fails.
- [ ] The test does not require AWS credentials and makes no AWS API call.
- [ ] The suite still passes under `node --test tests/unit tests/e2e`.

## Cucumber Tests
```gherkin
Feature: Partially-populated secrets still plan
  Scenario: A missing key reads as an empty string
    Given a secret payload that omits "ANTHROPIC_API_KEY"
    When the lookup with an empty default is evaluated
    Then the result is an empty string
    And evaluation does not error

  Scenario: A direct index on the same payload errors
    Given a secret payload that omits "ANTHROPIC_API_KEY"
    When local.secrets["ANTHROPIC_API_KEY"] is evaluated
    Then evaluation errors

  Scenario Outline: Every secret read is guarded
    Given terraform/main.tf
    Then the read of "<key>" uses lookup with a default
    Examples:
      | key                 |
      | GOOGLE_CLIENT_ID    |
      | GOOGLE_CLIENT_SECRET |
      | ANTHROPIC_API_KEY   |
      | SESSION_SECRET      |
      | ALLOWED_ORIGINS     |

  Scenario: A direct index introduced later is caught
    Given a copy of main.tf containing local.secrets["SESSION_SECRET"]
    When the guard assertion runs
    Then it fails and names "SESSION_SECRET"

  Scenario: The test needs no AWS access
    When the suite runs with no AWS credentials configured
    Then these scenarios still pass
    And no AWS API call is attempted

  Scenario: Temp evaluation directories do not leak
    Given an evaluation test that fails mid-run
    When the suite finishes
    Then no temp evaluation directory remains
```

## Additional Context
