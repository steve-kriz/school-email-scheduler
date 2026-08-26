---
id: TASK-065
title: getCorsOrigin echoes the request Origin verbatim, and a new test now pins that behaviour
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: low
---

## Description
`src/lambda/calendar/index.mjs:182` returns the caller-supplied `origin` string
once the *parsed* hostname matches the allowlist. Values such as
`https://user@officehq.com.au`, or an origin carrying a path or fragment, pass
the hostname gate and are reflected into a response header unchanged.

This predates TASK-022. What is new is that `tests/unit/calendar-cors.test.js:82-86`
now locks the verbatim echo in, asserting "the echoed value is the full origin,
not just the hostname". So anyone who later tries to emit
`new URL(origin).origin` — the normalised form — will be blocked by a test that
looks deliberate.

Decide the intended behaviour and make code, comment and test agree. Emitting
the normalised origin is the safer default; if verbatim echo is deliberate,
document why.

## Impact If Not Fixed
Unnormalised, attacker-influenced text is reflected into a response header. The
ALB and runtime sanitising are currently the only things preventing
header-value oddities, and the new test would actively block the person who
tries to fix it — turning an incidental behaviour into an enforced one.

## Acceptance Criteria
- [ ] A decision is made and documented: emit the normalised origin, or keep the verbatim echo with a stated rationale.
- [ ] If normalising: `new URL(origin).origin` (or equivalent) is emitted, and the test at `tests/unit/calendar-cors.test.js:82-86` is updated to match.
- [ ] An origin carrying userinfo, a path or a fragment is handled per the decision, with a test for each form.
- [ ] A malformed origin string does not throw out of the response layer.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The echoed CORS origin is well-defined
  Scenario Outline: An allowed origin with extra syntax is handled per policy
    Given a request whose Origin header is "<origin>"
    When the response origin is resolved
    Then the emitted value matches the documented policy
    Examples:
      | origin                             |
      | https://officehq.com.au            |
      | https://user@officehq.com.au       |
      | https://officehq.com.au/path       |

  Scenario: A malformed origin does not throw
    Given a request whose Origin header is not a valid URL
    When the response origin is resolved
    Then no error escapes the response layer
```

## Additional Context
