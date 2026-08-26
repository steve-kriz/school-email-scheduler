---
id: TASK-043
title: Object.prototype pollution bypasses the deps gate because the route layer destructures
status: todo
created: 2026-08-18T05:55:00.000Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-025
severity: low
---

## Description
`src/lambda/calendar/index.mjs:962` builds `{ origin, ...routeDeps }`, and
`:401-410` destructures it:
`const { ..., fetchImpl, tokenEndpoint, ... } = options;`.

Destructuring reads the prototype chain. So a polluted
`Object.prototype.tokenEndpoint` is picked up even though the spread copies only
own properties, and even though `asRouteDeps` correctly returned `{}`. The gate
is bypassed without ever being defeated.

No test pollutes `Object.prototype` and asserts the exchange still hits the
constant. Add that test, and stop the route layer inheriting injectable keys —
via a null-prototype object, `Object.hasOwn` guards, or equivalent.

## Impact If Not Fixed
If any other path in this service ever introduces a prototype-pollution
primitive — a recursive merge, or a query/JSON parser that writes `__proto__` —
the token endpoint becomes steerable again despite this gate, reopening the exact
unsigned-id_token forgery vector TASK-025 was raised to close. The suite has no
assertion standing on that ground, so it would not be noticed.

## Acceptance Criteria
- [ ] A test pollutes `Object.prototype.tokenEndpoint` (and `fetchImpl`) and asserts the code exchange still hits the hardcoded constant.
- [ ] The pollution is cleaned up in a `finally` so it cannot leak into other tests in the run.
- [ ] The route layer no longer inherits injectable keys from the prototype chain.
- [ ] The fix is pinned: reverting it reddens the new test, verified by applying the mutation and confirming it applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Prototype pollution cannot steer route dependencies
  Scenario: A polluted Object.prototype does not reach the token exchange
    Given Object.prototype.tokenEndpoint is set to an attacker-controlled URL
    When an auth callback is driven through the handler
    Then the code exchange request goes to the hardcoded Google token endpoint

  Scenario: The pollution does not leak between tests
    Given a test that pollutes Object.prototype
    When that test finishes, however it finishes
    Then Object.prototype no longer carries the injected key
```

## Additional Context
