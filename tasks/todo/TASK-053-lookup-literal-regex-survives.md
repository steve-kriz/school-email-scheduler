---
id: TASK-053
title: The regex-for-lookup assertion TASK-015 set out to delete still survives in the unit suite
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: medium
---

## Description
TASK-015's headline deliverable was replacing text-matching assertions with
behavioural ones. `tests/unit/terraform-scaffold.test.js:254-257` still asserts:

```js
assert.ok(mainContent.includes('lookup(local.secrets'),
  'lookup() not used for secret access');
```

That is verbatim the assertion the ticket set out to replace. (Confirmed by
direct inspection, not inference.)

Lines 259-261 are worse:

```js
assert.ok(mainContent.includes('""'),
  'Empty default not provided for secret lookups');
```

This passes for any `.tf` file containing an empty string anywhere — a
permanently-green no-op.

Replace both with the behavioural / parser-based checks TASK-015 built, or
delete them as superseded.

## Impact If Not Fixed
The ticket's headline deliverable is only half-landed. The weak assertion
remains in the tree as a template for future tests and reads as sanctioned
practice, and `includes('""')` inflates the suite's apparent coverage with an
assertion that cannot fail.

## Acceptance Criteria
- [ ] `tests/unit/terraform-scaffold.test.js:254-257` is replaced by a behavioural or parser-based assertion, or removed as superseded.
- [ ] The `includes('""')` assertion at `:259-261` is replaced with one that can fail.
- [ ] A repo-wide sweep confirms no remaining assertion matches only the `lookup(` literal as its sole check; report what the sweep found.
- [ ] Each replacement is proven to fail on the defect it guards, by mutation with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Secret-access assertions test behaviour, not text
  Scenario: Removing a guarded lookup from main.tf is caught
    Given a guarded lookup is replaced by a direct index
    When the suite runs
    Then at least one test fails

  Scenario: A no-op assertion cannot remain
    Given the suite is swept for assertions that pass on any input
    Then none are found in the terraform scaffold tests
```

## Additional Context
