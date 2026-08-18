---
id: TASK-033
title: An unlisted path-valued node flag after the first positional still reports covered
status: todo
created: 2026-08-18T03:20:00Z
updated: 2026-08-18T03:20:00Z
review-of: TASK-029
---

## Description
TASK-029 closed the false-covered shapes it enumerated, and the lexer/segment model
holds: there is no default-true, no covered-yielding early return, no swallowing
catch and no `||` fallback. But the guarantee is only as complete as
`VALUE_TAKING_FLAGS`. In the post-first-positional loop of `segmentTestPaths`
(`tests/helpers/script-coverage.mjs`, ~lines 288-297), an **unknown** flag is
assumed boolean and skipped by one token, so an unlisted *path-valued* node flag
lets its path value fall through and be counted as coverage.

Verified by driving the real helper:

```
got=true   node --test tests/unit --watch-path tests/e2e
got=true   node --test tests/unit --cpu-prof-dir tests/e2e
got=true   node --test tests/unit --snapshot-blob tests/e2e/snap.blob
got=true   node --test tests/unit --diagnostic-dir tests/e2e
got=true   node --test tests/unit --heapsnapshot-signal tests/e2e
```

None of those commands runs `tests/e2e`. `--watch-path` registers a watch path;
`--cpu-prof-dir` and `--diagnostic-dir` name output directories. The command runs
`tests/unit` only, and the guard reports e2e as covered.

Note the asymmetry, because it tells you where the fix belongs. The **same flag
placed before `--test` fails closed**:

```
got=false  node --watch-path tests/e2e --test tests/unit
got=false  node --cpu-prof-dir tests/e2e --test tests/unit
```

So the pre-positional path is safe and the post-positional path is not. The design
rule TASK-029 adopted — "a guard that cannot decide must not report covered" — is
enforced for unrecognised *constructs* (`$(`, backtick, unterminated quote) but
not for unrecognised *flags*. An allowlist of value-taking flags is inherently
incomplete, and treating "not in my list" as "boolean, skip one" is a
fail-open default.

Fix direction, in preference order:

1. **Invert the default for `-`-prefixed tokens after the first positional.** Node
   accepts almost no flags there — it stops parsing its own flags at the first
   positional, which is the insight TASK-029 already encodes. So a `-`-prefixed
   token appearing after a positional is either a flag the *test runner* consumes
   or something the model does not understand. Either way it is not evidence of
   directory coverage, so the safe reading is to stop collecting positionals at
   that point, or to treat the segment as unparseable. That removes the class
   rather than extending a list.
2. If a list is kept, add the known path-valued flags above **and** make an
   unrecognised `-`-prefixed token after a positional mark the segment
   unparseable rather than boolean.

Whichever is chosen, every entry and the unknown-flag default must be pinned:
removing an entry, or flipping the default back to "assume boolean", must redden a
test. This project has already shipped two unpinned regex branches
(`CREATE_VERB`'s `makes?` and `sets? up`) for exactly this reason.

## Impact If Not Fixed
This is the same silent-directory-drop that TASK-019, TASK-023 and TASK-029 were
each opened to prevent, reachable through a door TASK-029 left open. The
triggering edit is ordinary: someone adds `--watch-path`, `--cpu-prof-dir` or a
future path-valued node flag to the `test` script, pointing at something under
`tests/`. Nothing errors, the coverage guard stays green, and a whole directory
stops running.

`tests/e2e` currently holds the plaintext-refresh-token canary from TASK-004, the
OAuth route guards, the runbook preflight guard, the terraform scaffold
assertions and the DynamoDB schema checks. Losing that directory silently removes
the guard on "no plaintext OAuth tokens at rest" while CI reports success — and
the only symptom would be a bug reaching production that the dropped directory
would have caught.

Severity is medium rather than high because it requires a future edit to trigger
and today's scripts are unaffected. The reason to fix it now is that the fix is
a default flip, and the failure is invisible by construction.

## Acceptance Criteria
- [ ] `isDirectoryCovered('node --test tests/unit --watch-path tests/e2e', 'e2e')`
      returns false.
- [ ] The same holds for `--cpu-prof-dir`, `--diagnostic-dir`, `--snapshot-blob`
      and `--heapsnapshot-signal`.
- [ ] An **invented** flag not in any list — e.g.
      `node --test tests/unit --future-flag tests/e2e` — also returns false,
      proving the class is closed rather than five names added.
- [ ] The pre-positional direction still fails closed:
      `node --watch-path tests/e2e --test tests/unit` returns false.
- [ ] Every TASK-023 and TASK-029 case still holds — `node --test tests`,
      `node --test ./tests/`, `node --test "tests/e2e"` covered;
      `tests/e2e-legacy`, `--test-name-pattern tests`, the four path-valued flag
      shapes, the chained-`echo` case and every unparseable construct not covered.
- [ ] All 11 existing `VALUE_TAKING_FLAGS` entries remain individually pinned —
      re-verify by sweep, asserting each mutation applied before trusting a green.
- [ ] The unknown-flag default is pinned: flipping it back to "assume boolean"
      reddens at least one test.
- [ ] `node --test tests/unit tests/e2e` — the repository's real `test` script —
      still reports covered for both directories.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: An unrecognised flag is never evidence of coverage
  Scenario Outline: A path-valued flag after the first positional is not coverage
    Given a test script of "<script>"
    When coverage of "e2e" is evaluated
    Then it reports not covered
    Examples:
      | script                                                  |
      | node --test tests/unit --watch-path tests/e2e            |
      | node --test tests/unit --cpu-prof-dir tests/e2e          |
      | node --test tests/unit --diagnostic-dir tests/e2e        |
      | node --test tests/unit --future-flag tests/e2e           |

  Scenario: The pre-positional direction still fails closed
    Given a test script of "node --watch-path tests/e2e --test tests/unit"
    When coverage of "e2e" is evaluated
    Then it reports not covered

  Scenario: The real test script is unaffected
    Given a test script of "node --test tests/unit tests/e2e"
    When coverage of "e2e" is evaluated
    Then it reports covered

  Scenario: Flipping the unknown-flag default is caught
    Given a build that assumes an unknown flag is boolean
    When the suite runs
    Then at least one test fails
```

## Additional Context
