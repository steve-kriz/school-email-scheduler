---
id: TASK-040
title: A Proxy with a lying getPrototypeOf trap passes the asRouteDeps gate and the tests bless it
status: todo
created: 2026-08-18T05:55:00.000Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-025
severity: low
---

## Description
`asRouteDeps` (`src/lambda/calendar/index.mjs:899-904`) gates on
`Object.getPrototypeOf`, which invokes the proxy trap. So
`new Proxy(function(){}, { getPrototypeOf: () => Object.prototype })` is honoured
as deps despite wrapping a function. The trap can also throw, making
`asRouteDeps` throw before `handler` reads `event.path`.

The docblock's claim that "only a plain object (prototype `Object.prototype`, or
null) is honoured" is therefore not literally true. Worse, two tests —
`tests/unit/asRouteDeps.test.js:148` and
`tests/e2e/calendar-handler-deps.test.js:389` — assert this permissive behaviour
as CORRECT ("though this is somewhat permissive"), enshrining the gap rather than
flagging it.

Either tighten the gate (and update those tests), or correct the docblock and the
test names so they describe what the gate actually delivers. Do not leave a
comment promising a guarantee the code does not make.

## Impact If Not Fixed
The realistic APM-wrapper case is still handled — an untrapped Proxy over a
function reports `Function.prototype` and is rejected — so live exposure is
small. But this seam's whole value is a guarantee that holds by construction, and
the comment currently overstates what it delivers to any future reader auditing
it. A throwing trap is also an unhandled crash path that fires before request
routing.

## Acceptance Criteria
- [ ] The behaviour for a Proxy with a lying `getPrototypeOf` trap is decided deliberately: either rejected, or accepted with the docblock corrected to say so.
- [ ] A `getPrototypeOf` trap that throws does not crash `handler` before it routes; the failure is handled.
- [ ] The two tests that currently bless the permissive behaviour are updated to match the decision.
- [ ] The `asRouteDeps` docblock states the actual guarantee, with no claim the code does not deliver.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The deps gate's guarantee matches its docblock
  Scenario: A Proxy wrapping a function with a lying prototype trap
    Given deps is a Proxy over a function whose getPrototypeOf returns Object.prototype
    When the handler is invoked with it
    Then the injected dependencies are not honoured

  Scenario: A getPrototypeOf trap that throws
    Given deps is a Proxy whose getPrototypeOf trap throws
    When the handler is invoked with it
    Then the handler does not crash before routing
    And the request is answered
```

## Additional Context
