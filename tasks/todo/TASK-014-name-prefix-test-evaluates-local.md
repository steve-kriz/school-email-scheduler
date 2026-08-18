---
id: TASK-014
title: name_prefix test must evaluate the Terraform local, not re-implement it
status: todo
created: 2026-08-18T00:00:00Z
updated: 2026-08-18T00:00:00Z
review-of: TASK-001
---

## Description
`tests/e2e/terraform-scaffold.test.js` (around lines 50–72) claims to verify the
Gherkin scenario *"When the name_prefix local is evaluated, Then it equals
au-dev-receptionhq"*. It does not evaluate the local. It reads `tenant`,
`environment` and `project_name` out of the tfvars and then re-implements the
concatenation in JavaScript:

```js
`${tenant}-${env}-${proj}`  // === "au-dev-receptionhq"
```

The companion unit test (around lines 88–99) only asserts that the three
variables are *referenced* inside `local.name_prefix`, not the order they appear
in. So the assertion passes whatever `variables.tf` actually says.

Replace the JavaScript re-implementation with a real evaluation of
`local.name_prefix`, using the approach TASK-001's build documented: copy
`variables.tf` and `config/` into a temp directory, `terraform init
-backend=false`, then `terraform console -var-file=config/dev/au.tfvars` and
read the value back. (`terraform console` cannot run in `terraform/` itself
because the s3 backend needs credentials.) `terraform` v1.8.5 is installed at
`C:\External\Terraform\terraform`.

Extend the same treatment to `local.name_prefix_short` and `local.secret_name`,
which have the same weakness.

Add the regression this is really about: an ordering mutation must turn the
suite red. Write the temp copy with the interpolation deliberately reordered to
`${var.environment}-${var.tenant}-${var.project_name}` and assert the evaluated
value is **not** `au-dev-receptionhq` — proving the test discriminates rather
than merely passing.

## Impact If Not Fixed
A future edit that reorders `local.name_prefix` — say to
`${var.environment}-${var.tenant}-${var.project_name}` — keeps the suite green
while silently renaming every resource in every tenant. Because the ALB, target
group, IAM role, DynamoDB table and KMS alias names all derive from this local,
the regression would first surface at `terraform apply` against a real
environment, as either a mass resource replacement or a name collision.

## Acceptance Criteria
- [ ] The `name_prefix` scenario evaluates `local.name_prefix` through
      `terraform console` and asserts the returned value, rather than
      recomputing the string in JavaScript.
- [ ] `local.name_prefix_short` is evaluated the same way and asserted to equal
      `au-dev-rhq` for dev/au.
- [ ] `local.secret_name` is evaluated the same way and asserted to equal
      `dev-au/app-config/school_calendar_services` for dev/au.
- [ ] A mutation test reorders the interpolation in a temp copy and asserts the
      evaluated value is no longer `au-dev-receptionhq`, so the test provably
      fails when the local is wrong.
- [ ] No test asserts a `local.*` value by re-implementing its expression in
      JavaScript.
- [ ] The temp directory used for evaluation is cleaned up even when the test
      fails.
- [ ] The suite still passes under `node --test tests/unit tests/e2e`.
- [ ] If the `terraform` binary is absent the test fails with a clear message
      naming the missing binary — it does not silently skip or pass.

## Cucumber Tests
```gherkin
Feature: Terraform local evaluation is genuinely tested
  Scenario: name_prefix is read from Terraform, not recomputed in the test
    Given the dev/au tfvars
    When local.name_prefix is evaluated via terraform console
    Then the returned value is "au-dev-receptionhq"

  Scenario: The short prefix and secret name are evaluated too
    Given the dev/au tfvars
    When local.name_prefix_short and local.secret_name are evaluated
    Then they are "au-dev-rhq" and "dev-au/app-config/school_calendar_services"

  Scenario: Reordering the interpolation turns the suite red
    Given a temp copy of variables.tf whose name_prefix is reordered to environment-tenant-project
    When local.name_prefix is evaluated
    Then the value is not "au-dev-receptionhq"
    And the assertion fails

  Scenario: No local is asserted by string rebuilding
    Given the test files
    Then no test builds an expected local value by concatenating tfvars values in JavaScript

  Scenario: A missing terraform binary is reported, not skipped
    Given the terraform binary is unavailable
    When the evaluation test runs
    Then it fails with a message naming the missing binary

  Scenario: Temp evaluation directories do not leak
    Given an evaluation test that fails mid-run
    When the suite finishes
    Then no temp evaluation directory remains
```

## Additional Context
