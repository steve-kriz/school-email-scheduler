---
id: TASK-020
title: Fix the CORS allowlist case bug, close the default, and test the origin gate
status: testing
created: 2026-08-18T00:30:00Z
updated: 2026-08-18T00:53:17Z
review-of: TASK-003
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-18T00:46:57Z","finishedAt":"2026-08-18T00:50:48Z","tokens":36906,"note":"lookalike match was already correct; no high-sev bug found"}]
---

## Description
Three related CORS findings from the TASK-003 review, all in the same two files.
They are one ticket because they are one subject and touch the same code — the
origin gate that every later route inherits.

**This must land before TASK-004.** TASK-004 modifies `index.mjs` heavily and
adds the session cookie; fixing the origin gate afterwards means auditing new
authenticated routes as well as this one.

### 1. The allowlist is never lower-cased (a real bug)
`src/lambda/calendar/index.mjs` lines 23–26 parse `ALLOWED_ORIGINS` with
`.map((o) => o.trim())` and no `.toLowerCase()`. But `isOriginAllowed`
(lines 41–52) matches against `new URL(origin).hostname`, which the URL spec
**always** normalises to lowercase. So an entry like `OfficeHQ.com.au` can never
match anything.

`ohq-chatbot2/src/lambda/chatbot/index.mjs` does lower-case its entries
(`.map((d) => d.trim().toLowerCase())`), so this is also a divergence from the
reference TASK-003 was told to mirror. Add `.toLowerCase()`.

### 2. The origin gate has no behavioural coverage
`tests/e2e/calendar-lambda.test.js` lines 266–291 assert only that
`getCorsOrigin` and `isOriginAllowed` are exported *functions*. Nothing exercises
their return values, which is exactly why finding 1 passed a green suite. Cover:
- open mode (`ALLOWED_ORIGINS` unset) returns `*`
- an allowed origin is echoed back
- a disallowed origin returns null / is not echoed
- suffix matching works as intended (`https://sub.officehq.com.au` against an
  `officehq.com.au` entry) **and** does not over-match a lookalike domain — an
  entry of `officehq.com.au` must NOT allow `evil-officehq.com.au` or
  `officehq.com.au.attacker.com`. Verify which of these the current
  implementation actually does; if suffix matching is naive enough to allow a
  lookalike, that is a **high**-severity bug, so report it rather than quietly
  writing a test around the existing behaviour.
- mixed-case entries match after the fix in 1

### 3. Close the open-by-default posture
With `ALLOWED_ORIGINS` unset the handler returns
`Access-Control-Allow-Origin: *` for every response. The review confirmed this is
**not** currently exploitable, because nothing sets
`Access-Control-Allow-Credentials: true` and browsers refuse to expose a
credentialed response to a `*` origin. The risk is the combination arriving
later: TASK-004 adds session cookies, and a coder adding `Allow-Credentials`
next to the still-open `*` branch — or prod shipping with `ALLOWED_ORIGINS`
empty — turns per-user calendar data into a cross-origin read.

Choose and implement one, and say which in your summary:
- **(a) Preferred:** keep `*` for unauthenticated responses but add a hard
  invariant that `Access-Control-Allow-Credentials` is never emitted while the
  resolved origin is `*`, enforced in `buildResponse` (not merely by convention)
  and covered by a test that fails if someone adds the header.
- **(b)** Close the default entirely: with `ALLOWED_ORIGINS` unset, emit no
  `Access-Control-Allow-Origin` header at all. Safer, but verify the ALB health
  check and same-origin frontend still work, since TASK-010 serves the UI from
  this same origin.

Do not do both. (a) is preferred because same-origin serving means the frontend
never needs a CORS header, so closing the default costs nothing but also gains
nothing until someone adds a cross-origin consumer — whereas the invariant
prevents the actual failure mode.

## Impact If Not Fixed
An operator who sets `ALLOWED_ORIGINS` with any capitalisation gets a silent
CORS block that looks like a code bug rather than a config typo, with no test
to point at the cause. More seriously, the origin gate is the app's only
cross-origin control and currently has zero behavioural coverage, so once
TASK-004 adds session cookies and TASK-009 exposes per-user calendar data, a
regression that pairs credentials with the open `*` branch — or a naive suffix
match that accepts `evil-officehq.com.au` — would ship green.

## Acceptance Criteria
- [ ] `ALLOWED_ORIGINS` entries are lower-cased at parse time.
- [ ] A mixed-case entry (`OfficeHQ.com.au`) matches a request from
      `https://officehq.com.au`, verified by a test that fails before the fix.
- [ ] `getCorsOrigin` returns `*` in open mode, and that is asserted on the
      return value, not on the export's type.
- [ ] An allowed origin is echoed back; a disallowed origin is not.
- [ ] Suffix matching allows `https://sub.officehq.com.au` for an
      `officehq.com.au` entry.
- [ ] Suffix matching REJECTS `https://evil-officehq.com.au` and
      `https://officehq.com.au.attacker.com` for an `officehq.com.au` entry. If
      the current implementation accepts either, that is reported as a
      high-severity bug and fixed in this ticket.
- [ ] Either (a) `buildResponse` structurally cannot emit
      `Access-Control-Allow-Credentials` while the resolved origin is `*`, with a
      test that fails if the header is added; or (b) no
      `Access-Control-Allow-Origin` header is emitted when `ALLOWED_ORIGINS` is
      unset — one, not both, and the choice is stated.
- [ ] The ALB health check still returns 200 after the change.
- [ ] `GET /calendar/api/health` and the 404 fallback still behave as TASK-003's
      tests assert — those tests are not modified.
- [ ] The full suite passes under `npm test`.
- [ ] No secret, token, or cookie value is logged by any path touched here.

## Cucumber Tests
```gherkin
Feature: The origin gate behaves as configured
  Scenario: A mixed-case allowlist entry still matches
    Given ALLOWED_ORIGINS is "OfficeHQ.com.au"
    When a request arrives from "https://officehq.com.au"
    Then the origin is allowed

  Scenario: Open mode echoes a wildcard
    Given ALLOWED_ORIGINS is unset
    When the cors origin is resolved
    Then it is "*"

  Scenario: A disallowed origin is not echoed
    Given ALLOWED_ORIGINS is "officehq.com.au"
    When a request arrives from "https://example.com"
    Then the origin is not allowed

  Scenario: A subdomain of an allowed domain is allowed
    Given ALLOWED_ORIGINS is "officehq.com.au"
    When a request arrives from "https://sub.officehq.com.au"
    Then the origin is allowed

  Scenario Outline: A lookalike domain is refused
    Given ALLOWED_ORIGINS is "officehq.com.au"
    When a request arrives from "<origin>"
    Then the origin is not allowed
    Examples:
      | origin                                  |
      | https://evil-officehq.com.au            |
      | https://officehq.com.au.attacker.com    |

  Scenario: Credentials are never paired with a wildcard origin
    Given ALLOWED_ORIGINS is unset
    When any response is built
    Then it does not carry Access-Control-Allow-Credentials

  Scenario: The health check is unaffected
    When an ALB event for "GET /calendar/api/health" is invoked
    Then the response status code is 200
```

## Additional Context
