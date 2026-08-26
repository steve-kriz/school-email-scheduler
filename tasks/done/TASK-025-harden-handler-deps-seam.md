---
id: TASK-025
title: Handler deps seam is reachable in production — make the test-only injection structural
status: done
created: 2026-08-18T02:10:00Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-004
activities: [{"activity":"code","model":"claude-opus-5","note":"asRouteDeps plain-object gate; 9/9 verified by orchestrator; 4 mutations red; tests include controls proving non-vacuity"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T05:00:00.000Z","finishedAt":"2026-08-18T05:12:00.000Z","tokensIn":49828,"note":"GREEN 89/89 (39 e2e + 50 unit); 9/9 AC covered. AC8 mutation-pinning asserted only as would-fail reasoning, not an executed mutate/observe-red/revert sweep — flagged to review"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T05:25:00.000Z","finishedAt":"2026-08-18T05:55:00.000Z","tokensIn":56624,"note":"VERDICT ACCEPT. Reviewer had Read/Grep/Glob only so ran 0 mutations and said so; adjudicated AC8 via executed differential controls (calendar-handler-deps.test.js:106/:202/:130/:164/:182/:333/:351) that empirically prove the pins non-vacuous. Confirmed asRouteDeps is the sole path from arg3 into route deps (index.mjs:928/:931, spread only at :962/:969). 5 non-blocking findings -> TASK-039..043"}]
---

## Description
`handler(event, context = undefined, deps = {})` (`src/lambda/calendar/index.mjs:675`)
documents `deps` as "Route dependency overrides (tests only)". The TASK-004
review accepted skipping cryptographic verification of the Google `id_token`
signature, and that ruling rests explicitly on those seams being unreachable in
production. The reasoning given was:

> `tokenEndpoint`, `fetchImpl`, and `exchangeCode` are injectable **only via the
> `deps` third parameter**. AWS invokes `handler(event, context)`, so `deps` is
> `{}` in production.

**The premise is wrong.** The Node.js Lambda runtime invokes handlers with
**three** arguments — `(event, context, callback)` — for async handlers as well
as callback-style ones. So in production `deps` receives the runtime's callback
**function**, and the `= {}` default never applies.

The conclusion still holds today, but for a different and weaker reason.
Verified by execution:

```
Function.name enumerable?  false
spread of a bare function  {}
spread of a function with an assigned property
                           {"tokenEndpoint":"https://evil.example.com/token"}
handler(evt, {}, {})        -> 200
handler(evt, {}, callback)  -> 200   (identical routing)
```

`routeAuthRequest(path, method, event, { origin, ...deps })` spreads `deps`.
A function's built-in `name`/`length` are non-enumerable so they contribute
nothing, and the runtime's callback has no assigned own properties — so today
the spread yields `{ origin }` and everything falls through to its default.

That is **incidental safety, not enforced safety**. Nothing in the code checks
that the third argument is a plain object. Any own enumerable property present
on whatever object arrives third flows straight into the route layer as a
dependency override — including `tokenEndpoint`, `fetchImpl` and `exchangeCode`,
the precise seams the signature-skip argument depends on. The demonstrated
one-line injection above is what that looks like.

This is the same shape as the `NODE_TEST_CONTEXT` recursion guard found earlier
in this project: correct behaviour today, achieved by accident rather than by
construction, with nothing to keep it correct.

Fix: make the injection structural rather than incidental. In `handler`, accept
`deps` only when it is a plain object — e.g. reject anything whose
`Object.getPrototypeOf` is not `Object.prototype` or `null`, or gate the whole
seam behind an explicit test-only marker key the runtime could never supply.
Prefer the plain-object check: it is one line, needs no test-only branch in
production code, and makes the security argument structural.

Then widen `decodeIdToken`'s docblock boundary
(`src/lambda/calendar/backend/google-oauth.mjs:372-388`). It currently records
only that a future path accepting an `id_token` **from a client** must add JWKS
verification. It must also record the second load-bearing condition: that
`tokenEndpoint` / `fetchImpl` / `exchangeCode` must never become configurable
from env or request input. A developer making the token endpoint env-driven —
an entirely natural-seeming refactor — would silently convert the accepted
signature-skip into a token-forgery vector, with nothing in the code to flag it.

## Impact If Not Fixed
The decision not to cryptographically verify the `id_token` signature is sound,
and this ticket does not change that. What it changes is *why* it is sound. Right
now the answer is "no code currently puts enumerable properties on the third
handler argument" — a property of today's runtime and today's deployment, not of
this codebase. A Lambda wrapper layer (APM/instrumentation products such as
Datadog, Lumigo or New Relic commonly wrap handlers and re-supply the callback),
a runtime change, or a future in-house middleware that decorates the callback
could introduce such a property without anyone connecting it to OAuth security.
If the property happened to be named `tokenEndpoint`, `fetchImpl` or
`exchangeCode`, the code exchange would be redirected to an attacker-controlled
endpoint whose `id_token` is trusted **without signature verification**, and its
`sub`/`email` claims would mint a valid site session for any account the attacker
names. That is full authentication bypass from a change nobody would review as
security-relevant.

The realistic likelihood is low and there is no known path today. The reason to
fix it is that the cost is one line and the current safety margin is invisible:
nothing in the code or tests would notice it disappearing.

## Acceptance Criteria
- [ ] `handler` ignores a third argument that is not a plain object, so a
      function (including the Lambda runtime callback) contributes no dependency
      overrides.
- [ ] A test passes a function carrying an own enumerable `tokenEndpoint`
      property as the third argument and asserts the value is **not** used —
      i.e. the real default endpoint is still what the code would reach.
- [ ] A test passes a function carrying own enumerable `exchangeCode` and
      `fetchImpl` properties and asserts neither is invoked.
- [ ] Legitimate test injection via a plain object still works — every existing
      TASK-004 test continues to pass unchanged.
- [ ] The plain-object check does not rely on `NODE_ENV`, a test-only env var,
      or any signal absent in production.
- [ ] `decodeIdToken`'s docblock records both boundary conditions: a
      client-supplied `id_token`, **and** `tokenEndpoint`/`fetchImpl`/
      `exchangeCode` becoming configurable from env or request input.
- [ ] A test asserts `GOOGLE_TOKEN_ENDPOINT` is an `https://` constant and is
      not read from `process.env`, so the hardcoded-endpoint assumption is
      pinned rather than assumed.
- [ ] The mutation "make `tokenEndpoint` read from `env`" turns at least one
      test red.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The dependency-injection seam cannot be reached from production
  Scenario: The Lambda runtime callback injects nothing
    Given a function with an own enumerable "tokenEndpoint" property
    When it is passed as the handler's third argument
    Then the property is ignored
    And the code exchange would target the hardcoded HTTPS endpoint

  Scenario: A decorated callback cannot supply exchangeCode or fetchImpl
    Given a function carrying own enumerable exchangeCode and fetchImpl properties
    When it is passed as the handler's third argument
    Then neither is invoked

  Scenario: Legitimate test injection still works
    Given a plain object of route dependency overrides
    When it is passed as the handler's third argument
    Then the overrides are applied

  Scenario: The token endpoint is not environment-configurable
    Given the google-oauth module
    Then GOOGLE_TOKEN_ENDPOINT is an https:// constant
    And it is not read from process.env

  Scenario: Making the endpoint env-driven is caught
    Given a build where tokenEndpoint reads from env
    When the suite runs
    Then at least one test fails
```

## Additional Context
