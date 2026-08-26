---
id: TASK-044
title: aol and zoho were demoted on a factually wrong rationale, so real AOL and Zoho hosts pass
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: medium
---

## Description
`src/lambda/calendar/backend/settings.mjs:171-179` justifies demoting all seven
brands out of `PUBLIC_MAIL_BRANDS` by calling them "dictionary-word brands ...
because each is also an ordinary word or short name a real school could
legitimately register."

That rationale holds for `me`, `mac`, `mail`, `live` and `proton`. It does **not**
hold for `aol` or `zoho`, which are neither ordinary words nor plausible school
registrations — they are exactly like the `gmail`/`hotmail` cases that correctly
stayed in the any-suffix brand tier.

Consequence of the wrong demotion (`settings.mjs:192-206` omission):
`aol.co.uk`, `aol.de`, `aol.fr`, `zoho.eu` and `zoho.in` are all accepted.

Fix: promote `aol` and `zoho` back into `PUBLIC_MAIL_BRANDS` so they are refused
under any public suffix, and correct the docblock so its stated rationale matches
the brands it actually covers.

## Impact If Not Fixed
Two provider brands that carry no false-positive risk sit outside the durable
control, so every new AOL or Zoho regional host is a silent miss requiring a code
edit. A comment that misstates its own rationale is also the precise defect class
that made TASK-032 attempt 1 red, and it will steer the next reader into keeping
the gap open.

## Acceptance Criteria
- [ ] `aol` and `zoho` are in `PUBLIC_MAIL_BRANDS` and refused under any public suffix.
- [ ] `aol.co.uk`, `aol.de`, `aol.fr`, `zoho.eu` and `zoho.in` are each refused with a 400 naming the domain.
- [ ] The remaining five demoted brands (`me`, `mac`, `mail`, `live`, `proton`) still accept `<brand>.edu.au`.
- [ ] The docblock's rationale names only the brands it actually applies to.
- [ ] Both new brand entries are individually pinned: removing either reddens a test, verified by applying the mutation and confirming it applied (the source uses DOUBLE quotes).
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Unambiguous provider brands are refused under any suffix
  Scenario Outline: An AOL or Zoho regional host is refused
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 400
    And the error message names "<domain>"
    Examples:
      | domain    |
      | aol.co.uk |
      | aol.de    |
      | zoho.eu   |
      | zoho.in   |

  Scenario Outline: Genuinely ambiguous brands still pass under a school suffix
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 200
    Examples:
      | domain        |
      | live.edu.au   |
      | mail.edu.au   |
      | proton.edu.au |
```

## Additional Context
