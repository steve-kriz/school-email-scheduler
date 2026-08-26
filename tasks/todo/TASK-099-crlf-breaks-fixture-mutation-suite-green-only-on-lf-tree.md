---
id: TASK-099
title: The suite is green only on an LF working tree — a hardcoded \n fixture mutation silently no-ops on CRLF, disarming the test that proves TASK-017's block-scoped assertions work
status: todo
created: 2026-08-26T01:20:00.000Z
updated: 2026-08-26T01:20:00.000Z
---

## Description
`tests/unit/dynamodb-calendar.test.js` **fails on any fresh checkout of this
repository**, including CI and any new developer machine. It passes only in a
working tree whose files happen to have LF line endings — such as the one this
work has been happening in.

Orchestrator-verified at base commit `9afe57e`, same commit in both trees:

| tree | line endings | result |
|---|---|---|
| main working tree | LF | `68 pass / 0 fail` |
| fresh `git worktree` checkout | CRLF | `67 pass / 1 fail` |

```
not ok 1 - fails when point_in_time_recovery.enabled is false but a different block says enabled = true
  error: 'fixture mutation did not apply'
  code: 'ERR_ASSERTION'
  location: tests/unit/dynamodb-calendar.test.js:667:5
```

`git config core.autocrlf` is `true`, so git converts LF→CRLF on checkout. The
main tree escaped conversion because these files were written directly to disk and
staged from there; every fresh checkout gets CRLF.

### Root cause
At `tests/unit/dynamodb-calendar.test.js:676` the mutation hardcodes LF:

```js
const mutated = original
  .replace('point_in_time_recovery {\n    enabled = true\n  }',
    'point_in_time_recovery {\n    enabled = false\n  }\n\n  decoy_block {\n    enabled = true\n  }');
assert.notEqual(mutated, original, 'fixture mutation did not apply');
```

`original` is read from `terraform/dynamodb_calendar_connections.tf`. On a CRLF
checkout that file contains `\r\n`, the `String.replace` needle never matches, and
`mutated === original`. The guard on the next line catches it — correctly — and the
test fails.

### Why this one matters more than an ordinary red test
The guard is doing its job, and that is the good news. The bad news is what the
test *would* have done without it. This test exists specifically to prove that
TASK-017's block-scoped HCL assertions close the gap a review identified: that
`enabled = true` attached to the WRONG block must now fail, where the old
whole-file `content.includes('enabled = true')` could not tell the difference.

Had the author not written `assert.notEqual(mutated, original, ...)`, the mutation
would have silently no-opped, the unmutated fixture would have passed every
downstream assertion, and the test would have reported green while proving nothing
— the exact defect class this repo has now hit four times (TASK-028's
`NODE_TEST_CONTEXT` leak, TASK-029's coverage predicate, TASK-094's source-inspection
pins, TASK-098's scoped-command assertion). Any OTHER mutation-based test in the
suite that lacks such a guard is currently vulnerable in the same way and is worth
sweeping for.

### Scope: this is probably not the only one
Search the suite for mutation helpers and fixture edits that hardcode `\n`, and for
any comparison against file content read from disk. Fixing only line 676 leaves the
class open. Two obvious shapes to look for:
- `.replace('...\n...', '...')` against content read with `fs.readFileSync(..., 'utf-8')`
- assertions comparing a literal multi-line template against file content

### Note on related tickets
Distinct from **TASK-098** (all four npm test scripts fail because `node --test`
resolves a directory argument as a module). Both were discovered together and both
explain why three separate coder agents on this run reported "2 pre-existing
failures" with confidently wrong explanations — the counts were right, the causes
were not. Also distinct from **TASK-037** (flaky signature tamper test), which is a
genuine flake; this one is fully deterministic per checkout.

### Observed but NOT characterised — a possible second-order effect
TASK-009's tester reported one anomalous full-suite run at **1714 pass / 4 fail**,
immediately after a `git commit`. It captured counts but not the failing leaf
names, and flagged the gap honestly rather than re-running until the numbers looked
right. Four consecutive full-suite runs since were all 1716/2 with the identical
two known leaves, and ten consecutive runs of its own two files were 128/0 — so the
tests themselves are deterministic.

Its hypothesis, explicitly **unproven**: the run coincided with git rewriting files'
line endings ("LF will be replaced by CRLF the next time Git touches it") while the
suite was concurrently reading the working tree. `npm-scripts.test.js` and
`package-deps-deployment.test.js` spawn subprocesses and read source files, and
`dynamodb-calendar.test.js` mutates fixtures on disk — all three would be exposed to
a file being rewritten underneath them.

Recorded here rather than as its own ticket because it is unreproduced and shares
this ticket's root cause (line-ending conversion). If it recurs — especially in CI —
it deserves separate characterisation with the failing leaf names captured. Anyone
fixing this ticket should consider whether normalising line endings repo-wide would
eliminate the race as a side effect.

## Acceptance Criteria
- [ ] `tests/unit/dynamodb-calendar.test.js` passes on a fresh CRLF checkout and on
      an LF working tree, with the same result on both.
- [ ] The fix makes the mutation line-ending agnostic (e.g. normalise on read, or
      match with a `\r?\n` regex) rather than pinning the repo to one line ending
      in a way a future checkout can undo.
- [ ] The `assert.notEqual(mutated, original, 'fixture mutation did not apply')`
      guard is KEPT, not removed as "no longer needed" — it is what caught this.
- [ ] The suite is swept for other mutation/fixture code that hardcodes `\n` against
      file content read from disk, and each instance found is either fixed or
      recorded as verified safe.
- [ ] Every mutation-based test that lacks a did-the-mutation-apply guard gains one,
      or is recorded as not needing one with the reason.
- [ ] Whether to normalise line endings repo-wide (e.g. a `.gitattributes` with
      `* text=auto eol=lf`) is decided deliberately and the reason recorded — the
      test fix must stand on its own either way, not depend on that decision.
- [ ] Proven by running the affected tests in a genuinely fresh checkout, not only
      in the existing working tree. State which trees were used.

## Cucumber Tests
```gherkin
Feature: The suite behaves identically on any checkout
  Scenario: A fresh CRLF checkout passes
    Given a fresh checkout of the repository with CRLF line endings
    When tests/unit/dynamodb-calendar.test.js is run
    Then it passes with zero failures

  Scenario: The same commit gives the same result on either line ending
    Given the same commit checked out once with LF and once with CRLF
    When the unit suite is run in both trees
    Then both report the same pass and fail counts

  Scenario: A no-op fixture mutation is still caught
    Given a mutation-based test whose replacement needle does not match
    When the test runs
    Then it fails naming the mutation that did not apply
    And it does not pass by asserting against the unmutated fixture

  Scenario: The block-scoped assertion it protects still works
    Given point_in_time_recovery.enabled is false and a decoy block says enabled = true
    When the block-scoped assertion runs
    Then it fails, where a whole-file substring check would have passed
```

## Additional Context
