---
id: TASK-039
title: The route-layer tokenEndpoint-from-env mutation is pinned only by a source regex
status: todo
created: 2026-08-18T05:55:00.000Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-025
severity: medium
---

## Description
`tests/e2e/calendar-handler-deps.test.js:638-651` is the only guard against
`handleAuthCallback` defaulting `tokenEndpoint` from the environment, and it is a
negative regex over a text slice of the function:
`source.match(/export async function handleAuthCallback[\s\S]*?\n\}/)`.

No runtime test sets `process.env.GOOGLE_TOKEN_ENDPOINT` and drives the full
callback route through `handler`. `:370` only injects `env` via deps; `:333` and
`:351` exercise `google-oauth.mjs` directly and bypass the handler. The slice is
also vacuously satisfiable: a mutation placed in `routeAuthRequest` or in
`handler` itself falls outside the captured text, so the negative assertion
passes while the vulnerability is present.

The other two of the three plausible mutation sites ARE pinned at runtime —
`:333` re-imports the module fresh with the env var set and asserts the exported
constant is still the literal, and `:351` forces default-parameter evaluation at
call time. Only the route layer is regex-only. Close that third site.

## Impact If Not Fixed
The exact refactor this seam was hardened against — making the token endpoint
environment-driven — is, in one of its three plausible locations, caught only by
a text match that a reformat or a slightly different code shape can silently stop
matching. If it stops matching, the code exchange can be pointed at an
attacker-controlled endpoint whose unsigned id_token mints a session for any
account, with a fully green suite.

## Acceptance Criteria
- [ ] A runtime test sets `process.env.GOOGLE_TOKEN_ENDPOINT` to an evil value and drives the full auth-callback route through `handler`, asserting the exchange still hits the hardcoded constant.
- [ ] Equivalent runtime coverage exists for a mutation placed in `routeAuthRequest` and in `handler`, not only in `handleAuthCallback`.
- [ ] Each new test is verified by applying the mutation, asserting the mutation actually applied, and observing the test go red.
- [ ] The regex-slice assertion is removed or demoted to a secondary check, so it is not the load-bearing pin.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The token endpoint cannot be steered by the environment
  Scenario: An env-supplied token endpoint is ignored by the callback route
    Given GOOGLE_TOKEN_ENDPOINT is set to an attacker-controlled URL
    When an auth callback is driven through the handler
    Then the code exchange request goes to the hardcoded Google token endpoint

  Scenario Outline: Reintroducing the vulnerability is caught wherever it is placed
    Given tokenEndpoint is mutated to read from the environment in <location>
    When the suite runs
    Then at least one test fails
    Examples:
      | location           |
      | handleAuthCallback |
      | routeAuthRequest   |
      | handler            |
```

## Additional Context
