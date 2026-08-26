---
id: TASK-041
title: Source-inspection pins in the handler-deps suite will redden on correct future work
status: todo
created: 2026-08-18T05:55:00.000Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-025
severity: low
---

## Description
`tests/e2e/calendar-handler-deps.test.js:307` asserts an EXACT count:
`(source.match(/\.\.\.routeDeps\b/g) || []).length === 2`. TASK-009 (events API)
and TASK-010 will each add a
`routeXRequest(path, method, event, { origin, ...routeDeps })` dispatch and turn
this red for no security reason.

Four tests (`:295`, `:306`, `:657`, `:675`) also slice the source with
`/function asRouteDeps\(value\) \{[\s\S]*?\n\}/`, coupling them to the literal
parameter name `value` and to `function` declaration syntax. Renaming the
parameter or converting to a `const` arrow fails them with "asRouteDeps should be
defined" while behaviour is untouched.

Rewrite these as invariant-based assertions — e.g. every route dispatch spreads
`routeDeps` and none spreads raw `deps` — rather than exact counts and
syntax-coupled slices.

## Impact If Not Fixed
The next correct ticket makes the security suite fail. That trains whoever is on
shift to edit or loosen these specific security assertions to get green — the
standard route by which a deliberate pin quietly stops pinning anything. This is
near-certain rather than hypothetical: TASK-009 and TASK-010 are already on the
board and both add route dispatches.

## Acceptance Criteria
- [ ] The `...routeDeps` assertion verifies the invariant (no dispatch spreads raw `deps`) instead of an exact occurrence count.
- [ ] Adding a third route dispatch that correctly spreads `routeDeps` does not redden the suite.
- [ ] A dispatch that spreads raw `deps` still reddens the suite.
- [ ] The four syntax-coupled source slices survive renaming the parameter and converting `asRouteDeps` to a `const` arrow function.
- [ ] Each rewritten assertion is verified to still fail on the defect it guards, by applying the mutation and confirming it applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Security pins survive correct refactors but still catch the defect
  Scenario: A new correct route dispatch is added
    Given a third route dispatch that spreads routeDeps
    When the suite runs
    Then it stays green

  Scenario: A dispatch spreads the raw deps argument
    Given a route dispatch that spreads raw deps
    When the suite runs
    Then at least one test fails

  Scenario: asRouteDeps is refactored without changing behaviour
    Given asRouteDeps is rewritten as a const arrow with a renamed parameter
    When the suite runs
    Then it stays green
```

## Additional Context
