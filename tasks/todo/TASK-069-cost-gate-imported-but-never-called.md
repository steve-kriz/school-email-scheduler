---
id: TASK-069
title: The zero-token cost gate is imported by the tests but never called
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: medium
---

## Description
The cost gate at `src/lambda/calendar/backend/anthropic.mjs:453-491` is what
keeps a non-school email from ever reaching the model — the zero-token path.

`tests/unit/calendar-extraction.test.js:28-30` imports `senderDomain`,
`isWatchedSender` and `toDomainList` and **calls none of them**. The only
indirect coverage is one e2e case
(`tests/e2e/calendar-extraction-flow.test.js:150-181`, unwatched sender with a
non-empty domain list).

Untested:
- the fail-closed empty-list rule at `:487` (`if (domains.length === 0) return false`)
- subdomain matching
- the `Name <addr>` header form
- the bare-domain fallback at `:488`

Inverting `:487` to `return true` keeps all 91 tests green.

Note also that `anthropic.mjs` carries its own `toDomainList` alongside
`gmail.mjs:174` — two copies that can diverge.

## Impact If Not Fixed
A one-character inversion of the fail-closed rule would push an entire personal
mailbox through the model on every scheduled scan, at full token cost and with
every private email leaving for a third-party API — and no test would notice.
This is the same class of privacy-and-cost failure TASK-032 was raised for,
reached by a different route.

## Acceptance Criteria
- [ ] `isWatchedSender` is called directly with: an empty domain list (must be false), an exact match, a subdomain, a non-match, and a `Name <addr>` header form.
- [ ] `senderDomain` and `toDomainList` are called directly and pinned.
- [ ] Inverting the fail-closed rule at `anthropic.mjs:487` reddens a test, verified by applying the mutation and confirming it applied.
- [ ] A test asserts the model is NOT called for an unwatched sender — zero token spend, not merely a skipped result.
- [ ] The duplicate `toDomainList` in `anthropic.mjs` and `gmail.mjs:174` is consolidated, or a test pins them to identical behaviour.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Only watched senders cost tokens
  Scenario Outline: The sender gate decides correctly
    Given the watched domains are <domains>
    And the sender is <sender>
    Then isWatchedSender returns <result>
    Examples:
      | domains            | sender                  | result |
      |                    | anyone@school.edu.au    | false  |
      | school.edu.au      | head@school.edu.au      | true   |
      | school.edu.au      | head@mail.school.edu.au | true   |
      | school.edu.au      | spam@example.com        | false  |

  Scenario: An unwatched sender never reaches the model
    Given a message from an unwatched sender
    When extraction runs
    Then the model client is never called
```

## Additional Context
