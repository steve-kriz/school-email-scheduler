---
id: TASK-096
title: The ordering guard compares first-occurrence indices across prose, so a prose mention masks a mis-ordered block
status: todo
created: 2026-08-18T10:05:00.000Z
updated: 2026-08-18T10:05:00.000Z
review-of: TASK-028
severity: low
---

## Description
`assertCreateBeforePutOrdering`
(`tests/e2e/check-oauth-config.test.js:173-189`) locates both markers with
`.match()` — no `/g` — against `documentText`, i.e. the whole runbook including
prose.

TASK-028's own ticket records that `create-secret` appears **twice** in the
runbook: once in prose (~line 231) and once in the executable code block
(~line 284).

So a runbook that mentions `create-secret` in early prose while placing the
actual executable `create-secret` block **after** the `put-secret-value` block
satisfies `createMatch.index < putMatch.index` and passes.

Fix: compare the positions of the COMMAND BLOCK occurrences — e.g. restrict the
search to fenced code blocks, or compare last-occurrence indices — so the guard
measures the order an operator would actually execute.

## Impact If Not Fixed
The invariant the guard exists to protect is the order of the executable steps.
An operator following the code blocks top to bottom would still hit
`ResourceNotFoundException` — creating the secret after trying to put a value
into it — while the guard reports green, which is the precise failure the guard
was written to prevent.

## Acceptance Criteria
- [ ] The guard compares the positions of the executable command occurrences, not the first textual mention anywhere in the document.
- [ ] A fixture with `create-secret` in early prose and its command block after `put-secret-value` FAILS the guard.
- [ ] The real runbook still passes unchanged.
- [ ] The fixture self-checks that its reordering applied before asserting.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The ordering guard measures executable order
  Scenario: A prose mention does not satisfy the guard
    Given a runbook mentioning create-secret in prose
    And whose create-secret command block appears after put-secret-value
    When the ordering guard runs
    Then it reports a violation

  Scenario: The real runbook is unaffected
    Given the current docs/google-oauth-setup.md
    When the ordering guard runs
    Then it passes
```

## Additional Context
