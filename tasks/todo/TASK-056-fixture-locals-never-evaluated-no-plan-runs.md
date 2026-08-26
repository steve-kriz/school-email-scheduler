---
id: TASK-056
title: The fixture's locals block is never evaluated and nothing ever runs plan or validate
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: low
---

## Description
`tests/e2e/terraform-scaffold.test.js:156-162` and
`tests/unit/terraform-discriminators.test.js:58-64` define fixture locals
(`google_client_id` … `allowed_origins`), but every test types the raw
expression `lookup(local.secrets, "ANTHROPIC_API_KEY", "")` on stdin (lines 438,
134, 147, 190) rather than evaluating `local.anthropic_api_key`.

The locals block is therefore dead code, and what the suite proves is the
semantics of terraform's `lookup()` builtin — not the pattern actually copied
from `main.tf`.

Relatedly, the ticket's titular claim is that a partially-populated secret
"still PLANS", but no `terraform plan` and not even a `terraform validate` ever
runs against the fixture. `terraform console` evaluating an expression is a
weaker proxy. (TASK-015 was accepted on this basis because its AC prescribed
`terraform console` explicitly — so this is a strengthening, not a defect.)

Closing it is cheap: add an `output` over each local and run
`terraform plan -input=false` on the provider-less fixture.

## Impact If Not Fixed
The suite proves a property of terraform rather than a property of this repo's
configuration, so a mistake in how `main.tf` composes its locals would not be
caught. The ticket's headline claim rests on an expression evaluation rather
than a plan, which is a weaker guarantee than the ticket's title advertises.

## Acceptance Criteria
- [ ] Each fixture local is evaluated by name (e.g. `local.anthropic_api_key`) rather than by re-typing the raw expression inline.
- [ ] An `output` exists over each local, and `terraform plan -input=false` runs successfully against the provider-less fixture with a partially-populated payload.
- [ ] The plan test fails if a local is changed to a direct index, verified by mutation with the mutation confirmed to have applied.
- [ ] The fixture still requires no AWS credentials, no backend, and makes no AWS API call.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A partially-populated secret still plans
  Scenario: Plan succeeds with a key missing from the payload
    Given a secret payload with ANTHROPIC_API_KEY absent
    When terraform plan runs against the provider-less fixture
    Then it succeeds
    And the output for anthropic_api_key is the empty string

  Scenario: A direct index breaks the plan
    Given a local rewritten to use a direct index
    When terraform plan runs
    Then it fails with Invalid index
```

## Additional Context
