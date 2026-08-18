---
id: TASK-034
title: Two lexer branches are unpinned, one computed value is unasserted, and the exit-0 spawn is duplicated
status: todo
created: 2026-08-18T03:20:00Z
updated: 2026-08-18T03:20:00Z
review-of: TASK-029
---

## Description
Three low findings from the TASK-029 review, all in the npm-scripts test files and
their shared helper. None is failing today and none is fail-open.

### 1. Two lexer branches are unpinned
`lexCommandSegments` is newly exported but imported by **neither** test file —
verified: `grep -rn "lexCommandSegments" tests/` matches only the helper's own
definition and its two internal call sites. The separators are exercised only
indirectly through `isDirectoryCovered`, and that indirect coverage does not reach
every branch. Verified by mutating each branch individually, asserting each
mutation persisted to disk:

```
newline ends a segment      -> disabled: 101 pass, 0 fail   ** UNPINNED **
; (semicolon)               -> disabled: 2 fail             pinned
| (pipe)                    -> disabled: 2 fail             pinned
& (single ampersand)        -> disabled: 101 pass, 0 fail   ** UNPINNED **
```

The review reported the newline and single-`&` branches as untested and was right
on both; note it grouped `;`/`|` with `&`, and those two are in fact pinned — only
the bare `&` is not.

Both unpinned branches matter for real scripts. A multi-line npm script (a YAML
block scalar, or a `package.json` value containing `\n`) relies on the newline
split; `cmd &` backgrounding relies on the single-`&` split. Either could be
removed today with the suite green.

Fix: import `lexCommandSegments` directly and test it as a unit — a script with a
newline separator, one with `&` backgrounding, one with `;`/`|`, one with a
separator inside quotes, and an unterminated quote returning `null`. Then confirm
by mutation that each branch reddens.

### 2. A computed value that is never asserted
`tests/e2e/npm-scripts.test.js` computes `guardWouldCatch` at ~line 660 and sets
it at ~line 671, then never asserts on it. Confirmed: those are its only two
occurrences in the file. The broken-setup test's sole load-bearing assertion is
`brokenScriptDetected`. The dead block adds no coverage and misleads a reader
about what the test proves.

Fix: assert on it or delete it. If the intent was a second, independent check that
the guard catches the broken script, make it an assertion; if it duplicates
`brokenScriptDetected`, remove it.

### 3. The scoped `test:e2e` command is spawned four times
`tests/e2e/npm-scripts.test.js` spawns the scoped `test:e2e` command at roughly
lines 346, 524, 551 and 609, several asserting the same exit-0 fact, plus
`npm run test:bdd` and `npm run check:oauth-config`. TASK-023's intent was **one**
exit-0 spawn by design, as the dependency-free proof. The extra spawns are CI cost
for no added assurance.

Be careful attributing this: it is not clear which spawns TASK-029 added versus
which were inherited from TASK-019 or TASK-023, so treat it as consolidation of
existing cost, not as a regression. Keep one canonical exit-0 spawn (the one that
reads `scripts['test:e2e']` from `package.json` and executes it — that assertion is
load-bearing and verified) and have the other tests assert on the scoped command
*string* rather than re-spawning it.

## Impact If Not Fixed
Finding 1 is the substantive one: two branches of a newly written lexer can be
deleted with the suite green, and the lexer is the mechanism the whole
fail-closed guarantee rests on. A regression in newline or `&` handling would
change which command segments are considered — the exact reasoning that decides
whether a directory counts as covered — and nothing would catch it. It is low
rather than medium only because neither separator appears in this repository's
current scripts.

Finding 2 is the seventeenth assertion-shaped defect found in this project: a
value computed as though it were being checked, and not checked. Its cost is
misdirection rather than missed coverage, since the adjacent assertion does the
real work.

Finding 3 costs wall-clock on every CI run and adds a process-spawn failure mode
to tests whose subject is string parsing. The npm-scripts files are now 101 tests
and among the slowest in the suite.

## Acceptance Criteria
- [ ] `lexCommandSegments` is imported and tested directly by at least one test
      file.
- [ ] A script separated by a newline is split into segments, and disabling the
      newline branch reddens a test.
- [ ] A script using `&` backgrounding is split into segments, and disabling the
      single-`&` branch reddens a test.
- [ ] The `;` and `|` branches remain pinned.
- [ ] A separator inside single or double quotes does **not** split, and an
      unterminated quote returns `null` — both asserted directly against
      `lexCommandSegments`.
- [ ] `guardWouldCatch` is either asserted or removed; no computed-but-unasserted
      value remains in either npm-scripts test file.
- [ ] Exactly one test spawns the scoped `test:e2e` command; the others assert on
      the scoped command string.
- [ ] The canonical exit-0 proof still reads `scripts['test:e2e']` from
      `package.json` and executes it, and rewiring that script to a bad path still
      reddens it.
- [ ] Wall time for the two npm-scripts files is reported before and after.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The lexer is tested directly and nothing is computed without being checked
  Scenario Outline: Each separator splits a script into segments
    Given the script "<script>"
    When lexCommandSegments is called
    Then it returns more than one segment
    Examples:
      | script                                  |
      | node --test tests/unit\nnode --test tests/e2e |
      | node --test tests/unit & node --test tests/e2e |
      | node --test tests/unit ; node --test tests/e2e |

  Scenario: A separator inside quotes does not split
    Given the script "node --test \"tests/a&&b\""
    When lexCommandSegments is called
    Then it returns exactly one segment

  Scenario: An unterminated quote is unparseable
    Given the script "node --test \"tests"
    When lexCommandSegments is called
    Then it returns null

  Scenario Outline: Removing a separator branch is caught
    Given a build with the <branch> branch disabled
    When the suite runs
    Then at least one test fails
    Examples:
      | branch  |
      | newline |
      | &       |

  Scenario: No value is computed without being asserted
    Given the npm-scripts test files
    Then every computed boolean reaches an assertion
```

## Additional Context
