---
id: TASK-062
title: The fail-safe fallback is only tested in the one configuration where fail-safe and fail-open coincide
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: low
---

## Description
`src/lambda/calendar/index.mjs:120-132` argues that falling back to the module
constant `ALLOWED_ORIGINS` is fail-SAFE, whereas falling back to `[]` would be
fail-OPEN. That is the central design decision of TASK-022.

But `ALLOWED_ORIGINS` is `parseAllowedOrigins(process.env.ALLOWED_ORIGINS)`
(`:85`), which evaluates to `[]` — open mode — whenever the env var is unset or
empty. And `terraform/lambda_calendar.tf:130` defaults it to `""` when the
secret key is absent.

Every coercion test runs with the var unset. So the suite only ever proves the
fallback in the configuration where "fall back to the module constant" and "fall
back to `[]`" produce identical results. The reasoning remains sound — the
fallback is never *more* open than the deployed policy — but it is unproven.

Fix: re-import the module with `ALLOWED_ORIGINS` set (e.g.
`await import(url + '?v=2')` after setting the env var) and assert a malformed
allowlist still resolves to the configured restrictive list.

## Impact If Not Fixed
The security property the ticket's central design decision rests on has zero
test coverage. A future change to `coerceAllowlist` that returns `[]` under a
*configured* allowlist would keep the whole suite green while quietly switching
the origin gate to open mode for that call.

## Acceptance Criteria
- [ ] A test sets `ALLOWED_ORIGINS` to a specific list, re-imports the module, and asserts a `null`/non-array allowlist still resolves to that configured list — not to `[]`.
- [ ] A test asserts that under a configured allowlist, a disallowed origin is still refused when the allowlist argument is malformed.
- [ ] Changing `coerceAllowlist` to return `[]` reddens that test, verified by mutation with the mutation confirmed to have applied.
- [ ] The env var is restored in a `finally` so it cannot leak into other tests.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A malformed allowlist never widens the origin gate
  Scenario: A configured allowlist survives a malformed argument
    Given ALLOWED_ORIGINS is configured with one specific origin
    When the origin gate is called with a null allowlist
    Then only that configured origin is allowed

  Scenario: Falling back to open mode is caught
    Given coerceAllowlist is changed to return an empty array
    When the suite runs
    Then at least one test fails
```

## Additional Context
