---
id: TASK-057
title: Terraform-shelling tests live in tests/unit, so the unit suite is no longer hermetic
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: low
---

## Description
`tests/unit/terraform-discriminators.test.js` runs `terraform init` plus four
`terraform console` invocations, and `tests/unit/mutation-sweep.test.js` reads
`terraform/main.tf` from disk. Both are e2e-shaped work sitting in the unit
suite.

Both also duplicate `resolveTerraformBin`'s hard-coded
`C:/External/Terraform/terraform.exe`, which additionally appears at
`tests/e2e/terraform-scaffold.test.js:25-26` — a Windows-only absolute path in
three places.

Move the terraform-shelling tests to `tests/e2e/`, leaving genuinely hermetic
parser tests in `tests/unit/`, and source the binary path from one place.

Note this interacts with TASK-022, which is separately moving CORS
function-level tests out of an e2e file into `tests/unit/` for the mirror-image
reason. Reconcile assertion counts before and after any move.

## Impact If Not Fixed
`npm run test:unit` hard-fails on any machine or CI runner without terraform
installed, which defeats the point of having a fast hermetic unit tier, and the
Windows-only absolute path must be updated in three places whenever it changes.

## Acceptance Criteria
- [ ] Tests that shell out to terraform live under `tests/e2e/`, not `tests/unit/`.
- [ ] `npm run test:unit` passes on a machine with no terraform installed.
- [ ] The terraform binary path is defined once and imported, not duplicated across three files.
- [ ] Assertion counts before and after the move are reconciled and reported, so no test is silently dropped.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The unit suite is hermetic
  Scenario: Unit tests pass without terraform
    Given terraform is not installed
    When npm run test:unit runs
    Then it passes

  Scenario: The e2e suite still covers the terraform behaviour
    Given terraform is installed
    When npm run test:e2e runs
    Then the secret-lookup scenarios run and pass
```

## Additional Context
