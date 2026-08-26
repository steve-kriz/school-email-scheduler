---
id: TASK-075
title: ANTHROPIC_MAX_TOKENS is an undocumented unbounded env knob, and hasApiKey is dead
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: low
---

## Description
`src/lambda/calendar/backend/anthropic.mjs:340-345` reads `ANTHROPIC_MAX_TOKENS`
through `positiveInt` with **no upper bound**. It is not set anywhere in
terraform — only `ANTHROPIC_MODEL` is, at `terraform/lambda_calendar.tf:141` —
so it is an undocumented environment override on the per-call output budget.

Separately, `hasApiKey` is returned from the same config surface but consumed by
nothing outside the tests.

Fix: bound and document the knob (or remove it if it is not deliberately part of
the operator interface), and either wire `hasApiKey` into a real missing-key
preflight or delete it.

## Impact If Not Fixed
An operator typo in an unvalidated, undocumented variable silently multiplies the
output-token ceiling on every call — a direct, unbounded cost increase with no
error and no log line. The dead `hasApiKey` field implies a missing-key preflight
that does not exist, so a deployment with no API key fails at first extraction
rather than at startup.

## Acceptance Criteria
- [ ] `ANTHROPIC_MAX_TOKENS` is validated against a documented upper bound, and an out-of-range value is rejected loudly at config load rather than silently accepted.
- [ ] The variable is either documented as part of the operator interface (and set in terraform) or removed.
- [ ] `hasApiKey` is either used in a real preflight that fails fast on a missing key, or deleted.
- [ ] A missing API key produces a clear, early failure rather than a per-message extraction error.
- [ ] Each behaviour is pinned by mutation, with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The output-token budget is bounded and documented
  Scenario: An out-of-range max-tokens value is rejected
    Given ANTHROPIC_MAX_TOKENS is set far above the documented bound
    When the config is loaded
    Then it fails loudly naming the variable and the bound

  Scenario: A missing API key fails fast
    Given no Anthropic API key is configured
    When the module performs its preflight
    Then it reports the missing key before any message is processed
```

## Additional Context
