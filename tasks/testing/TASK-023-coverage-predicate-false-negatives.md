---
id: TASK-023
title: Coverage predicate rejects legitimate script forms; unit guard cannot fail
status: done
created: 2026-08-18T01:20:00Z
updated: 2026-08-18T02:25:11Z
review-of: TASK-019
activities: [{"activity":"code","model":"claude-opus-5","tokens":52758,"note":"predicate 7/7 verified"},{"activity":"test","model":"claude-haiku-4-5","tokens":119810,"note":"2 attempts; 71 tests; all 4 allowlist entries pinned"},{"activity":"review","model":"claude-opus-4-8","tokens":51706,"note":"recursion guard now explicit (not incidental) - confirmed. No critical/high. Found predicate CAN return false-covered: 5 shapes reproduced by orchestrator -> TASK-029 medium. 2 weak assertions -> folded into TASK-028"}]
---

## Description
Four findings from the TASK-019 review, consolidated because all four live in
`tests/e2e/npm-scripts.test.js` and `tests/unit/npm-scripts-config.test.js`.

### 1. The hardened predicate rejects legitimate script forms (medium)
TASK-019's case-2 hardening rejects a bare `tests` token when the preceding
token starts with `-`, on the theory that it is then a flag's value. But `--test`
is a **boolean** flag taking no value, so the token after it is a genuine path
argument. Verified by lifting `isDirectoryCovered` out of the test file and
executing it:

```
isDirectoryCovered('node --test tests',       'e2e') -> false   (want true)
isDirectoryCovered('node --test ./tests/',    'e2e') -> false   (want true)
isDirectoryCovered('node --test "tests/e2e"', 'e2e') -> false   (want true)
isDirectoryCovered('node --test tests/unit tests/e2e', 'e2e') -> true  (correct)
```

`node --test tests` is the most natural single-command form for running the whole
tree and is exactly equivalent to the current `test` script. The `./tests/` and
quoted-path variants fail for a related reason: the case-1 regex only accepts a
bare `tests/<dir>` prefix with a `/` or whitespace boundary.

The flag-adjacency heuristic is the wrong shape. Replace it with something that
does not guess: normalise each candidate token (strip surrounding quotes, strip a
leading `./`, strip a trailing `/`), skip tokens that are themselves flags
(start with `-`), and skip the token immediately after a flag **only when that
flag is known to take a value**. Maintain an explicit small allowlist of
value-taking node/npm flags you care about (`--test-name-pattern`,
`--test-reporter`, `--test-concurrency`, `--experimental-loader`) rather than
assuming every flag consumes the next token. State in a comment why the naive
"previous token starts with `-`" rule was wrong.

Add a test for each of the three false negatives above **and** retain the two
false-positive cases TASK-019 fixed (`tests/e2e-legacy` must not cover `e2e`;
`--test-name-pattern tests` must not cover everything), so the fix cannot
regress in either direction.

### 2. The exit-0 assertion no longer exercises the real script (low)
Removing the self-spawn was correct, but the replacement runs
`node --test tests/e2e/terraform-scaffold.test.js` directly (lines ~296–302). It
never reads or invokes `scripts['test:e2e']`, so it would pass even if that
script were rewired to something broken while keeping a string the static checks
accept.

Restore the intent without reintroducing recursion: read `scripts['test:e2e']`
from `package.json`, and execute **that actual command** with a single-file
argument appended (or with a recursion-guard env var set that the spawn checks
and honours). The point is that the assertion should fail if the script's
plumbing breaks, not merely if `node --test` breaks.

### 3. The exit-0 proof depends on terraform being installed (low)
The file chosen for that proof, `tests/e2e/terraform-scaffold.test.js`, itself
runs `terraform validate -json` via `execSync`. On a runner without terraform, or
while the terraform config is mid-change, the npm-scripts assertion fails and
misattributes a terraform problem to npm-script wiring.

Pick an e2e file that spawns no external process for the proof. If none exists,
create a trivial one whose only purpose is to be a dependency-free spawn target,
and say so.

### 4. The unit-layer guard cannot fail (low)
`tests/unit/npm-scripts-config.test.js` lines ~31–33 assert:

```js
(script.includes('tests/unit') && script.includes('tests/e2e')) || script.includes('tests/')
```

`&&` binds tighter than `||`, so a `test` script of `node --test tests/unit` —
e2e silently dropped — satisfies the final `includes('tests/')` branch and
passes. The unit-layer guard for this ticket's central guarantee therefore cannot
fail on the exact regression the ticket exists to prevent.

This is the tenth assertion found in this codebase that passes regardless of the
code. Fix it to require genuine coverage of both directories — reuse the same
predicate logic as the e2e file rather than hand-rolling a second, divergent
check. Prove it with a synthetic script string that drops e2e and assert it
fails.

## Impact If Not Fixed
The medium finding actively blocks correct work: anyone simplifying the `test`
script to the equivalent `node --test tests` gets a red suite on a correct
change, and the failure points into a test helper rather than real code, which is
a confusing place to debug. The unit-layer finding is the more insidious one —
the guard protecting "the e2e directory is included in CI" cannot fail, so if
the stronger e2e-side check is ever skipped or removed, the silently-dropped-e2e
regression that motivated TASK-019 in the first place would slip through unit
tests unnoticed, returning the repository to exactly the state TASK-019 was
created to fix.

## Acceptance Criteria
- [ ] `isDirectoryCovered('node --test tests', 'e2e')` returns true.
- [ ] `isDirectoryCovered('node --test ./tests/', 'e2e')` returns true.
- [ ] `isDirectoryCovered('node --test "tests/e2e"', 'e2e')` returns true.
- [ ] `isDirectoryCovered('node --test tests/e2e-legacy', 'e2e')` still returns
      false (the TASK-019 false positive stays fixed).
- [ ] `isDirectoryCovered('node --test --test-name-pattern tests tests/unit', 'integration')`
      still returns false.
- [ ] Value-taking flags are handled via an explicit allowlist, not by assuming
      any token starting with `-` consumes the next token, with a comment
      explaining why the naive rule was wrong.
- [ ] The exit-0 assertion reads `scripts['test:e2e']` from `package.json` and
      executes that command, so it fails if the script's plumbing breaks.
- [ ] That assertion no longer depends on `terraform` being installed.
- [ ] The unit-layer coverage assertion fails for a `test` script of
      `node --test tests/unit`, proven with a synthetic input.
- [ ] The unit and e2e layers share one predicate implementation rather than two
      divergent checks.
- [ ] No recursion is reintroduced: running `npm test` and `npm run test:e2e`
      each still complete and exit 0, with no growth in node process count.
- [ ] The full suite passes under `npm test`.

## Cucumber Tests
```gherkin
Feature: The coverage predicate accepts every equivalent script form
  Scenario Outline: A legitimate whole-tree form is recognised
    Given a test script of "<script>"
    When coverage of "e2e" is evaluated
    Then it reports covered
    Examples:
      | script                          |
      | node --test tests               |
      | node --test ./tests/            |
      | node --test "tests/e2e"         |
      | node --test tests/unit tests/e2e |

  Scenario Outline: The earlier false positives stay fixed
    Given a test script of "<script>"
    When coverage of "<dir>" is evaluated
    Then it reports not covered
    Examples:
      | script                                        | dir         |
      | node --test tests/e2e-legacy                  | e2e         |
      | node --test --test-name-pattern tests tests/unit | integration |

  Scenario: A dropped e2e directory fails the unit guard
    Given a test script of "node --test tests/unit"
    When the unit-layer coverage assertion runs
    Then it fails

  Scenario: The exit-0 proof exercises the real script
    Given the test:e2e script in package.json
    When the exit-0 assertion runs
    Then it executes that script's command rather than a hardcoded equivalent

  Scenario: The exit-0 proof does not need terraform
    Given a machine with no terraform binary
    When the npm-scripts suite runs
    Then the exit-0 assertion still passes

  Scenario: No recursion is reintroduced
    When "npm run test:e2e" is run
    Then it exits 0
    And the node process count does not grow
```

## Additional Context
