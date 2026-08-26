---
id: TASK-101
title: Five packaging tests fail confusingly when the gitignored src/lambda/calendar/node_modules drifts from the manifest — no test says so, and nothing installs it
status: todo
created: 2026-08-26T02:30:00.000Z
updated: 2026-08-26T02:30:00.000Z
---

## Description
Merging TASK-038 and TASK-009 into `master` produced **six** suite failures where
one was expected. Five of them had nothing to do with either ticket's code:
`src/lambda/calendar/node_modules` was stale.

That directory is gitignored and is never installed by the test suite. It had been
populated under TASK-038's **cycle-0** manifest, which deliberately removed
`@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` on the belief the runtime
bundled them. The cycle-1 rework reversed that decision and re-declared all four
`@aws-sdk` packages — so after the merge the manifest declared four and the
installed tree contained two:

```
MISSING  @aws-sdk/client-dynamodb
PRESENT  @aws-sdk/client-kms
PRESENT  @aws-sdk/client-scheduler
MISSING  @aws-sdk/lib-dynamodb
```

Running `npm ci --omit=dev` in `src/lambda/calendar` took the suite from
**1773/1779** to **1778/1779** — every one of the five cleared, leaving only the
known TASK-098 failure.

### The defect is the diagnosis, not the drift
Drift is expected; a manifest changed and an install did not follow. The problem is
that **nothing says so**. The five tests fail with messages about missing packages
and non-zero verify-script exits, which read like a broken implementation. Nothing
in the output says "your installed tree does not match the manifest — run `npm ci`".

This cost real time on this run, and it is the same shape as TASK-098 and TASK-099:
**the suite is green only in a prepared environment**, and when the environment is
wrong it fails misleadingly rather than saying what is wrong. A fresh clone has no
`src/lambda/calendar/node_modules` at all, so CI would hit some version of this on
day one.

TASK-038's tester noted several assertions are "conditional on `node_modules`
existing" — worth checking whether that condition silently SKIPS on a fresh clone
(coverage quietly disappears) while it FAILS on a stale one. Both outcomes are bad,
in opposite ways, and the fix should make the state explicit either way.

### Note on the id
Numbered TASK-101 because 100 is the true maximum. Unrelated to the "TASK-101"
referenced in TASK-038's review activity note (that review named ids TASK-098..106
for findings whose ticket files were never created; those were handled as TASK-038
rework).

## Acceptance Criteria
- [ ] When `src/lambda/calendar/node_modules` is absent or out of sync with
      `src/lambda/calendar/package.json`, the affected tests fail (or skip) with a
      message that NAMES the cause and the remedy (`npm ci --omit=dev` in that
      directory) — not with a generic missing-package error.
- [ ] Whether the dependency-dependent tests should skip or fail on a fresh clone is
      decided deliberately and recorded; if they skip, the skip is visible as a SKIP
      and never folded into a pass.
- [ ] The manifest-versus-installed-tree check is proven by an executed mutation:
      remove a declared package from the installed tree, confirm the message names
      it and the remedy, restore, confirm green.
- [ ] A fresh clone can reach a green suite by following documented steps, and those
      steps are recorded where a newcomer will find them.
- [ ] No existing TASK-038 assertion is weakened to accommodate this.
- [ ] The full suite passes, with any remaining known failures (TASK-098, TASK-099)
      reported separately and honestly.

## Cucumber Tests
```gherkin
Feature: The suite explains an out-of-sync dependency tree
  Scenario: A stale installed tree is diagnosed, not just failed
    Given the manifest declares a package that is not installed
    When the packaging tests run
    Then the failure names the missing package and the install command to run

  Scenario: A fresh clone is handled deliberately
    Given src/lambda/calendar/node_modules does not exist
    When the packaging tests run
    Then they either skip visibly or fail with an actionable message
    And they never report as passed

  Scenario: A synced tree is green
    Given npm ci has been run in src/lambda/calendar
    When the packaging tests run
    Then they all pass
```

## Additional Context
