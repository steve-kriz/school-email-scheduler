---
id: TASK-042
title: Four handler-deps test names assert the opposite of what their bodies check
status: todo
created: 2026-08-18T05:55:00.000Z
updated: 2026-08-18T05:55:00.000Z
review-of: TASK-025
severity: low
---

## Description
In `tests/e2e/calendar-handler-deps.test.js`:

- `:388` — the describe block "prototype pollution and exotic shapes" contains no
  prototype-pollution test at all.
- `:429` — "should reject an object with `Symbol.toStringTag`"; the body asserts
  it is **accepted**.
- `:451` — "should reject an object created with
  `Object.setPrototypeOf(obj, Object.prototype)`"; the body sets the prototype to
  **null** and asserts acceptance.

In `tests/unit/asRouteDeps.test.js`:

- `:241` — "should return fresh empty objects ... not a cached singleton"; the
  body states it will not check reference identity, and does not.

Rename each test to describe what it actually asserts, or change the body to
match the name where the name describes the behaviour we want.

Bundled NIT from the same review:
`src/lambda/calendar/backend/google-oauth.mjs:402-403` has a stray bare line with
no leading `*` in the `decodeIdToken` docblock. The content is correct; only the
block shape is malformed — and `tests/e2e/calendar-handler-deps.test.js:598`
depends on that block's shape, so fix them together.

## Impact If Not Fixed
This is the one file a future auditor reads to learn what the deps gate
guarantees, and its titles currently describe a stricter gate than exists.
Someone relying on "we reject Symbol.toStringTag objects" or "we cover prototype
pollution" would make a security decision on coverage that is not there.

## Acceptance Criteria
- [ ] Each of the four tests either has a name matching its body, or a body matching its name.
- [ ] The "prototype pollution" describe block either contains a real prototype-pollution test or is renamed.
- [ ] The `:241` singleton test either checks reference identity or is renamed to what it checks.
- [ ] The malformed `decodeIdToken` docblock line is fixed without breaking the shape assertion at `:598`.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Test names describe what the tests actually verify
  Scenario Outline: A test name matches its assertion
    Given the test named "<name>"
    When its body is read
    Then the behaviour asserted matches the behaviour named
    Examples:
      | name                                 |
      | Symbol.toStringTag handling          |
      | setPrototypeOf handling              |
      | fresh empty objects, not a singleton |

  Scenario: The docblock shape assertion survives the reformat
    Given the decodeIdToken docblock stray line is corrected
    When the suite runs
    Then it stays green
```

## Additional Context
