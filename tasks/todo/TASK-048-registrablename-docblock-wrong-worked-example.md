---
id: TASK-048
title: The registrableName docblock's worked example reports the wrong output and contradicts its own test
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: low
---

## Description
`src/lambda/calendar/backend/settings.mjs:222-224` states that
`"example.act.edu.au"` "reads `edu` as the registrable name."

It does not. The labels are `[example, act, edu, au]`; `edu` is a registry label
under the two-letter `au`, so `suffixLength` is 2 and `nameIndex` is 1, giving
`{ name: "act", subdomain: true }`. The unit test at
`tests/unit/calendar-settings-public-mail.test.js:417-424` asserts `"act"` — so
the comment and the test directly disagree.

The docblock's *conclusion* still holds (nothing is wrongly refused), and in fact
holds more strongly than stated: `subdomain: true` skips the brand check
entirely. Only the worked example is wrong. Correct it.

## Impact If Not Fixed
This section is the only documentation of when the hand-rolled public-suffix
heuristic is wrong. A worked example that reports the wrong output makes that
documentation untrustworthy, and will mislead whoever next tunes
`CCTLD_SECOND_LEVEL_LABELS` — the exact person who most needs it to be right.

## Acceptance Criteria
- [ ] The worked example states the actual output (`{ name: "act", subdomain: true }`) and the actual reason.
- [ ] The docblock explains that `subdomain: true` skips the brand check, which is why the case is safe.
- [ ] A test asserts the documented worked examples match real `registrableName` output, so comment and behaviour cannot drift apart again.
- [ ] The existing assertion at `tests/unit/calendar-settings-public-mail.test.js:417-424` still passes unchanged.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Documented suffix examples match real behaviour
  Scenario Outline: A worked example resolves as documented
    Given the domain "<domain>"
    When registrableName is called
    Then it returns name "<name>" and subdomain "<subdomain>"
    Examples:
      | domain              | name | subdomain |
      | example.act.edu.au  | act  | true      |
      | stmarys.edu.au      | stmarys | false  |
      | mail.gmail.com      | gmail | true     |

  Scenario: A docblock example that disagrees with the code is caught
    Given a worked example whose stated output is wrong
    When the suite runs
    Then at least one test fails
```

## Additional Context
