---
id: TASK-049
title: Three normalisation tests assert only that some error was thrown, not that the blocklist refused the host
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: low
---

## Description
`tests/unit/calendar-settings-public-mail.test.js:591-640` — the email-address,
URL and wildcard normalisation blocks — each assert only `assert.ok(error, ...)`.
No status code, no field, no message check, unlike the `refusal()` helper used
everywhere else in the file.

All three pass for the right reason today (the review traced `normalizeDomain`
for each input, including the `'*.*. aol.com'` case, which survives on the final
`.trim()`). But they would stay green if a `normalizeDomain` regression made the
host malformed and it were rejected as "is not a valid email domain" instead of
being caught by the blocklist.

These are precisely the tests covering "a blocked host pasted as a URL or as an
email address is still blocked", so they must distinguish the guard firing from
the input merely failing shape validation.

Bundled NIT from the same review: `:133-143` and `:643-679` assert the same two
completeness invariants twice. Harmless, but two copies drift — collapse them or
have one delegate to the other.

## Impact If Not Fixed
The tests that specifically cover the paste-a-URL and paste-an-address cases
cannot tell the blocklist working from the blocklist being bypassed. A
normalisation regression that routed those inputs to a shape error instead would
ship green, silently removing the coverage the ticket was written to add.

## Acceptance Criteria
- [ ] Each of the three blocks asserts the specific refusal — status 400 and the blocklist's message/field — via the existing `refusal()` helper rather than bare `assert.ok(error)`.
- [ ] Each test fails if the input is instead rejected as a malformed domain, proven by mutating `normalizeDomain` to mangle the input and confirming the mutation applied and the test reddened.
- [ ] The duplicated completeness guard at `:133-143` / `:643-679` exists once, or one delegates to the other.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A blocked host is refused by the blocklist, not by shape validation
  Scenario Outline: A blocked host in an alternate form is refused for the right reason
    Given an authenticated user
    When they PUT searchDomains ["<input>"]
    Then the response status code is 400
    And the error identifies the public-mail blocklist as the reason
    Examples:
      | input                |
      | user@gmail.com       |
      | https://gmail.com    |
      | *.gmail.com          |

  Scenario: A normalisation regression is distinguishable
    Given normalizeDomain is mutated to mangle its input
    When the suite runs
    Then at least one test fails
```

## Additional Context
