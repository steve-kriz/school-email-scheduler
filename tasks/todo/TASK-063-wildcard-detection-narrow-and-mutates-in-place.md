---
id: TASK-063
title: finalise's wildcard detection reads only element zero, does not trim, and deletes in place
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: low
---

## Description
`src/lambda/calendar/index.mjs:335-339`:

```js
const first = Array.isArray(value) ? value[0] : value;
if (first === "*")
```

Three gaps:

1. **Only element `[0]` is read.** A hand-rolled
   `['https://x.example.com', '*']` — wildcard not first — is not detected, and
   the credentials header survives.
2. **No trimming.** `[' * ']` is not detected, but HTTP parsers strip
   surrounding whitespace, so a browser still sees `*`.
3. **In-place mutation.** `delete headers[name]` at `:344` runs in ESM strict
   mode, so a frozen or sealed response object throws a `TypeError` out of the
   router instead of being sanitised.

## Impact If Not Fixed
The choke point can be defeated by cosmetic variations in how a future route
spells the wildcard, and a frozen response turns the guard itself into an
unhandled 5xx — the exact availability failure mode TASK-022 set out to remove
elsewhere in this layer.

## Acceptance Criteria
- [ ] Wildcard detection examines every element of an array-valued origin header, not just index 0.
- [ ] The comparison trims surrounding whitespace before matching `*`.
- [ ] A frozen or sealed response is handled without throwing — sanitised by constructing a new object, or explicitly rejected with a clear error.
- [ ] Each case is pinned by mutation, with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Wildcard detection is not defeated by spelling
  Scenario Outline: A wildcard anywhere in the origin header strips credentials
    Given a response whose origin header is <value> with credentials "true"
    When the router finalises it
    Then the credentials header is absent
    Examples:
      | value                            |
      | ["*"]                            |
      | ["https://x.example.com", "*"]   |
      | [" * "]                          |

  Scenario: A frozen response does not crash the router
    Given a frozen response with a wildcard origin and credentials
    When the router finalises it
    Then no TypeError escapes the router
```

## Additional Context
