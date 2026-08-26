---
id: TASK-045
title: The demoted brands' exact-host list omits mail.ru and most of the live.<cc> family
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: medium
---

## Description
`src/lambda/calendar/backend/settings.mjs:104-107` and `:176-179` promise that the
seven demoted brands remain covered because "their known hosts ... are listed
here instead" in `PUBLIC_MAIL_DOMAINS` (`:109-156`) — presented as
bounded-but-real coverage.

The list does not deliver that. Missing known consumer hosts include:

- **`mail.ru`** — one of the largest consumer mail providers in the world. Only
  `yandex.ru` is listed.
- `aol.co.uk`, `aol.de`, `aol.fr` (see also TASK-044, which promotes `aol` to the
  brand tier and may subsume these).
- The Microsoft `live.<cc>` family beyond the three listed: `live.fr`, `live.nl`,
  `live.ca`, `live.it`, `live.de`, `live.co.za`, `live.com.mx`, `live.se`,
  `live.jp` and others.

Since these brands are deliberately excluded from the any-suffix check, the exact
list is the only control — so either the list must be brought up to the coverage
its docblock claims, or the docblock must be softened to state the real limit.

## Impact If Not Fixed
A user entering `mail.ru` or `live.fr` reproduces the exact defect TASK-032 was
raised to fix: their whole personal mailbox goes through the Anthropic API on
every scheduled scan, silently, with no error — only a larger bill and noisier
results. The docblock's coverage promise is currently stronger than the list
delivers, so a reader auditing the trade-off will believe the gap is closed when
it is not.

## Acceptance Criteria
- [ ] `mail.ru` is refused with a 400 naming the domain.
- [ ] The `live.<cc>` family is extended to the common regional hosts, each refused.
- [ ] The docblock's coverage claim matches what the list actually covers, with the residual limit stated honestly.
- [ ] Every added entry is individually pinned: removing any one reddens at least one test, verified by applying the mutation and confirming it applied.
- [ ] Genuine school domains, including `mail.stmarys.edu.au` and `mail.edu.au`, are still accepted.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Known consumer hosts of the demoted brands are refused
  Scenario Outline: A listed consumer host is refused
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 400
    And the error message names "<domain>"
    Examples:
      | domain   |
      | mail.ru  |
      | live.fr  |
      | live.ca  |
      | live.de  |

  Scenario: A school subdomain named mail is still accepted
    Given an authenticated user
    When they PUT searchDomains ["mail.stmarys.edu.au"]
    Then the response status code is 200
```

## Additional Context
