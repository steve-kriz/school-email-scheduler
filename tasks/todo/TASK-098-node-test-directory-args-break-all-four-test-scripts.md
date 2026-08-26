---
id: TASK-098
title: All four npm test scripts fail — node --test resolves a directory argument as a module, and the assertion that "proves" the wiring runs a scoped variant instead
status: todo
created: 2026-08-26T00:40:00.000Z
updated: 2026-08-26T00:58:00.000Z
---

## Description
**Every one of the project's four test scripts is broken**, and the suite has only
ever looked green because agents run explicit file lists instead of the scripts.
Orchestrator-reproduced in the main working tree at base commit `9afe57e`, on
Node **v22.20.0**, Windows:

```
$ node --test tests/unit
TAP version 13
# Error: Cannot find module 'C:\Projects\officehq_git\school-email-scheduler\tests\unit'
#     at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)
#     at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)
#   code: 'MODULE_NOT_FOUND'
# Subtest: tests\unit
not ok 1 - tests\unit
# pass 0
# fail 1
```

`--test` **is** active (it emits TAP and creates a subtest), but the positional is
treated as a single test *file* to load rather than a directory to expand. All
four scripts in `package.json` use that form, so all four fail:

| script | command | result |
|---|---|---|
| `test` | `node --test tests/unit tests/e2e` | fails, `MODULE_NOT_FOUND` |
| `test:unit` | `node --test tests/unit` | fails, 0 pass / 1 fail |
| `test:e2e` | `node --test tests/e2e` | fails, 0 pass / 1 fail |
| `test:bdd` | `node --test tests/bdd` | fails — the real cause of the red assertion below |

Passing explicit files works correctly (`node --test tests/unit/dynamodb-calendar.test.js`
→ 68 pass / 0 fail), which is why every agent report to date has been green: they
all ran file lists.

### Why no test caught this
`tests/e2e/npm-scripts.test.js` contains a scenario literally titled **"The exit-0
assertion proves the real script wiring works"**. It does not. It reads
`scripts['test:e2e']` from `package.json` and then runs that command **scoped to a
single file** (see the comment at `tests/e2e/npm-scripts.test.js:494` — "runs that
command scoped to a single file"). The scoped form is exactly the form that works,
so the assertion passes while the real script fails. It verifies that the script
string is read rather than hardcoded — a genuine but far weaker property than the
one its name claims.

This is the same defect class the repo has already found repeatedly: TASK-028's
`NODE_TEST_CONTEXT` leak (nested `node --test` skipped everything and exited 0),
and TASK-094's source-inspection pins. An assertion that runs a *modified* version
of the thing under test cannot prove the thing under test works.

### The visible symptom
`tests/e2e/npm-scripts.test.js:479` asserts `npm run test:bdd` exits 0, and it is
currently **red**: `test:bdd should exit 0, got exit code 1`. That file is 27 pass
/ 1 fail. The failure is a knock-on of the directory-argument bug, not a separate
issue.

A secondary contributing fact, worth recording but **not** the root cause:
`tests/bdd/features/` and `tests/bdd/steps/` are both empty, and git does not track
empty directories, so `tests/bdd` is absent from a fresh clone entirely. Even once
the directory-argument bug is fixed, a runner pointed at an empty or missing tree
exits non-zero, so `test:bdd` needs its own decision. Note the comment at
`tests/e2e/npm-scripts.test.js:473`: `tests/bdd/` is retained *only* because
`tests/unit/terraform-scaffold.test.js:406` asserts the `test:bdd` script exists.

### Root cause not fully diagnosed
`node --test <dir>` is documented as supported. Whether this is specific to Node
v22.20.0, to Windows path handling, or to something in this repo's invocation has
**not** been established, and this ticket must not guess. What is established:

- Reproduced by the orchestrator in the main tree (Node v22.20.0, Windows).
- Independently reproduced by the TASK-038 coder on a clean `git archive` export
  of base `9afe57e`, ruling out working-tree contamination.
- Two separate coders misread the resulting failures as unrelated pre-existing
  test failures, which is itself evidence of how misleading the current state is.

The fix must be verified by actually running the scripts, on the platform the
project supports — not by inspecting `package.json`.

## Note on the ticket id
Numbered TASK-098 because 097 is the true maximum id on the board. **Unrelated**
to the "TASK-098" referenced inside TASK-038's review activity note: that review
named ids TASK-098..106 for findings whose ticket files were never created before
the run was interrupted, and those findings are being handled as TASK-038 rework.

## Acceptance Criteria
- [ ] `npm test`, `npm run test:unit` and `npm run test:e2e` each run the full set
      of files under their directories and exit 0, invoked as scripts, on a fresh
      checkout.
- [ ] The chosen mechanism (explicit glob patterns, a runner script, an `engines`
      constraint, or another approach) is recorded with its reason.
- [ ] `npm run test:bdd` exits 0, with its own recorded decision: populate
      `tests/bdd/` with real executable specs, remove the script (and then also the
      `tests/unit/terraform-scaffold.test.js:406` assertion requiring it to exist),
      or explicitly guard the empty case.
- [ ] The "exit-0 assertion proves the real script wiring works" scenario in
      `tests/e2e/npm-scripts.test.js` is repaired so it runs the script's command
      **unmodified and unscoped**, and would fail if the directory form broke again.
- [ ] The repair is proven by mutation: break the script in `package.json`, confirm
      the test goes red naming the script, restore, confirm green — executed, not
      reasoned about.
- [ ] `tests/e2e/npm-scripts.test.js:479` is not relaxed, deleted, or made
      conditional in order to obtain green.
- [ ] The full suite passes, run via `npm test` itself, with the count reported
      honestly.

## Cucumber Tests
```gherkin
Feature: The project's own test scripts actually run the suite
  Scenario: npm test runs every test file
    Given a fresh checkout of the repository
    When "npm test" is executed
    Then it exits with code 0
    And it reports a test count equal to the full suite, not zero

  Scenario: A directory of tests is expanded, not loaded as a module
    Given a directory containing test files
    When the test runner is pointed at that directory
    Then every test file inside it runs
    And no MODULE_NOT_FOUND error is emitted

  Scenario: The wiring assertion runs the real command
    Given tests/e2e/npm-scripts.test.js asserts the test:e2e script works
    When the test:e2e script in package.json is mutated to a broken command
    Then that assertion fails and names the script
    And it is not satisfied by running a scoped variant of the command

  Scenario: The bdd script is honest about its spec tree
    Given tests/bdd contains no test files on a fresh clone
    When "npm run test:bdd" is executed
    Then it either runs real specs and exits 0, or the script no longer exists
```

## Additional Context
