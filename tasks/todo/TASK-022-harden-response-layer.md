---
id: TASK-022
title: Harden the response layer — null allowlist, bypassable invariant, test placement
status: todo
created: 2026-08-18T01:15:00Z
updated: 2026-08-18T01:15:00Z
review-of: TASK-020
---

## Description
Four low-severity findings from the TASK-020 review, consolidated because they
all live in `src/lambda/calendar/index.mjs` and
`tests/e2e/calendar-lambda.test.js` and all concern the same layer: the response
builder and its origin gate.

None is a live bug. All four are traps for the code landing in TASK-004 onward,
which adds session cookies and credentialed CORS on top of this layer.

### 1. A `null` or non-array `allowlist` throws instead of failing safe
`getCorsOrigin` (line 90, `allowlist.length`), `isOriginAllowed` (line 75,
`allowlist.some`) and `buildResponse` (lines 151–153) guard only `undefined`, via
the default parameter. An explicit `null` — or any non-array — reaches `.length`
/ `.some` and throws a `TypeError`. The handler has no try/catch, so a caller
passing `allowlist: null` from a config path produces an unhandled throw and a
5xx for the whole request rather than a defined result.

Note this is **fail-closed for data exposure** — on a throw no CORS header is
emitted at all — so it is an availability edge, not a leak. Fix by coercing a
non-array to the module default (or to `[]`, whichever you argue is safer) at
the top of each entry point, and assert both `null` and a non-array string are
handled.

### 2. The credentials invariant is structural only via `buildResponse`
The wildcard-vs-credentials strip lives solely in `buildResponse`
(lines 170–184). Every current caller routes through it — `jsonResponse`
(line 199) and the handler (lines 220, 226, 238) — so there is no live bug. But
nothing prevents a future route from returning a raw response object and
bypassing the guard entirely, which would re-introduce exactly the
`*` + `Access-Control-Allow-Credentials` pairing TASK-020 exists to prevent.

Make the guarantee hold for any response, not just sanctioned ones. Options,
pick one and justify it:
- Funnel every return through a single choke point and add a test asserting the
  handler has no `return { statusCode` literal outside it (a source-level
  assertion, crude but effective).
- Move the strip into a tiny `finalise(response)` applied to whatever the router
  returns, so a raw object still passes through it.

The second is stronger; state your choice.

### 3. Origin-gate behavioural tests sit in the e2e file
All the function-level tests for `parseAllowedOrigins` / `isOriginAllowed` /
`getCorsOrigin` / `buildResponse` are in
`tests/e2e/calendar-lambda.test.js` (lines 319–565). `package.json` wires
`test:unit` to `tests/unit` only, so these run under `npm test` and `test:e2e`
but **not** `test:unit`. They are pure unit tests of exported helpers; a
unit-only lane gives false confidence about the origin gate.

Move them to `tests/unit/calendar-cors.test.js`, leaving the genuinely
handler-level e2e scenarios (health check, 404, ALB event shape) where they are.
Do not weaken any assertion in the move, and confirm the counts before and after
account for every test.

### 4. The live-handler credentials test asserts trivially
`tests/e2e/calendar-lambda.test.js` lines 522–535 assert only that no handler
response carries `Access-Control-Allow-Credentials`. The handler never adds that
header on any path, so the assertion passes regardless of whether the strip
logic works — it cannot fail on a regression. It also does not assert the
wildcard origin is present on the open-mode responses it builds.

This is the ninth assertion found in this codebase that passes regardless of the
code. Tighten it: assert `Access-Control-Allow-Origin` is `*` on those paths so
the test proves something, and keep the absence check as a secondary assertion.
The real protection remains the unit-level guards at lines 476–496 — do not
remove those.

## Impact If Not Fixed
TASK-004 adds session cookies and is the first ticket that will legitimately
need credentialed CORS, so it is the first caller able to trip every one of
these. A `null` allowlist from a config path becomes an unhandled 5xx; a route
that hand-rolls a response silently escapes the credentials invariant and can
pair `Access-Control-Allow-Credentials` with a wildcard origin, exposing
per-user calendar data cross-origin; and because the origin-gate tests do not
run in the unit lane while the handler-level credentials test cannot fail, a
regression in either could merge with a green gate.

## Acceptance Criteria
- [ ] `getCorsOrigin`, `isOriginAllowed` and `buildResponse` handle an
      `allowlist` of `null`, a non-array (e.g. a string), and `undefined`
      without throwing.
- [ ] A test asserts each of those three inputs produces a defined result, and
      states which fallback was chosen.
- [ ] `[]` still means open mode and `undefined` still falls through to the
      module constant — existing behaviour is not changed by the coercion.
- [ ] The credentials-vs-wildcard strip applies to any response the router
      returns, not only those built via `buildResponse`.
- [ ] A test proves a hand-rolled raw response cannot emit
      `Access-Control-Allow-Credentials` alongside a wildcard origin.
- [ ] The origin-gate function tests live in `tests/unit/` and run under
      `npm run test:unit`.
- [ ] No assertion is weakened or lost in the move; the total count is
      reconciled before and after.
- [ ] The handler-level credentials test additionally asserts
      `Access-Control-Allow-Origin` is `*` on the paths it exercises, so it can
      fail on a regression.
- [ ] The unit-level credentials guards (lines 476–496) are retained.
- [ ] TASK-003's health-check, 404 and ALB-shape tests still pass unmodified.
- [ ] The full suite passes under `npm test`.

## Cucumber Tests
```gherkin
Feature: The response layer fails safe and is fully guarded
  Scenario Outline: A malformed allowlist does not throw
    Given an allowlist of <value>
    When the cors origin is resolved
    Then a defined result is returned and no error is thrown
    Examples:
      | value        |
      | null         |
      | "officehq"   |
      | undefined    |

  Scenario: An empty allowlist still means open mode
    Given an allowlist of []
    When the cors origin is resolved
    Then it is "*"

  Scenario: A hand-rolled response cannot pair credentials with a wildcard
    Given a route that returns a raw response object carrying Allow-Credentials
    And the resolved origin is "*"
    When the response leaves the router
    Then it does not carry Access-Control-Allow-Credentials

  Scenario: The origin gate runs in the unit lane
    When "npm run test:unit" is run
    Then the parseAllowedOrigins and isOriginAllowed scenarios are executed

  Scenario: No assertion was lost in the move
    Given the suite before and after the move
    Then every origin-gate assertion is still present

  Scenario: The handler credentials test can fail
    Given a mutated build where the wildcard strip is removed
    When the handler-level credentials test runs
    Then it fails
```

## Additional Context
