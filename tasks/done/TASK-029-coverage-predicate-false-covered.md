---
id: TASK-029
title: Coverage predicate can report a directory as covered when it will not run
status: done
created: 2026-08-18T02:22:00Z
updated: 2026-08-18T03:23:50Z
review-of: TASK-023
activities: [{"activity":"review","model":"claude-opus-4-8","tokens":54105,"note":"no critical/high fail-open. Found unlisted path-valued flags after first positional report covered -> TASK-033 medium; unpinned lexer branches + dead value -> TASK-034. All reproduced by orchestrator"}]
---

## Description
`isDirectoryCovered` / `extractPathArguments` in `tests/helpers/script-coverage.mjs`
is a whitespace tokeniser with no model of shell command structure and an
incomplete value-flag allowlist. It can report a directory as **covered** when
that directory would not actually run.

This is the dangerous direction. TASK-019 exists because `tests/e2e` was silently
absent from CI; TASK-023 fixed the predicate's *false negatives* (correct scripts
reported as uncovered, merely annoying). This ticket is the inverse and it is the
failure TASK-019 was created to prevent.

Verified by importing the real helper and driving it:

```
FALSE-COVERED  got=true  reality=false  node --import tests/e2e/setup.mjs --test tests/unit
FALSE-COVERED  got=true  reality=false  node --require tests/e2e/setup.js --test tests/unit
FALSE-COVERED  got=true  reality=false  node --loader tests/e2e/loader.mjs --test tests/unit
FALSE-COVERED  got=true  reality=false  node --env-file tests/e2e/.env --test tests/unit
FALSE-COVERED  got=true  reality=false  echo tests && node --test tests/unit
ok             got=false reality=false  CI=1 node --test tests/unit
false-negative got=false reality=true   npm run test:unit && npm run test:e2e
ok             got=true  reality=true   node --test tests/unit tests/e2e
ok             got=false reality=false  node --test tests/unit
```

Two distinct causes:

**1. Path-valued flags missing from the allowlist.** `VALUE_TAKING_FLAGS`
(lines 24-29) lists only `--test-name-pattern`, `--test-reporter`,
`--test-concurrency`, `--experimental-loader`. Node flags that take a **path**
value — `--import`, `--require`, `--loader`, `--env-file` — are absent, so their
value is read as a positional path argument. `--import tests/e2e/setup.mjs` is a
setup-file registration, not a directory to run, but the tokeniser counts it as
e2e coverage.

This is the standard node-test setup pattern, so it is a likely edit rather than a
contrived one: someone adds a global setup file under `tests/e2e/` and narrows the
run directory, and the guard reports the directory as still covered.

**2. No notion of which command a token belongs to.** Every token in the whole
string is scanned. `echo tests && node --test tests/unit` reports e2e as covered
because the bare `tests` argument belonging to `echo` satisfies the whole-tree
short-circuit. Any stray `tests`- or `tests/<dir>`-shaped token from an unrelated
chained command produces a false covered.

The undetected mutation to close: setting the `test` script to
`node --import tests/e2e/globalSetup.mjs --test tests/unit` drops `tests/e2e` from
execution while every coverage assertion stays green.

Note the one false negative in the table (`npm run test:unit && npm run test:e2e`
→ `false`). Delegation through `npm run` is not resolved. That direction is
harmless — it fails a correct script rather than passing a broken one — so treat
it as optional. If you do address it, do not trade it for any new false-covered
case.

Fix direction: split the command on shell separators (`&&`, `||`, `;`, `|`) and
evaluate only segments that actually invoke a test runner; extend
`VALUE_TAKING_FLAGS` with the path-valued node flags above; and keep the explicit
allowlist approach rather than reverting to heuristics — the comment at lines
11-23 explaining why the naive "previous token starts with `-`" rule was wrong is
correct and should survive.

**A guard that cannot decide must not report "covered".** Where the predicate
cannot parse a script shape with confidence, it should report not-covered (or
throw), never covered. Failing loud on an unrecognised shape is acceptable;
failing open is what this ticket exists to remove. This is the same principle
TASK-017 imposes on the terraform helpers.

## Impact If Not Fixed
A whole test directory can silently stop running in CI while the guard whose only
job is to prevent that reports success. The two triggering edits are both ordinary:
adding a `--import`/`--require`/`--loader` setup file that lives under `tests/`,
or chaining a helper command that happens to mention `tests`. Neither looks
security- or CI-relevant to a reviewer, and neither turns anything red.

The consequence is invisible by construction. Nothing fails; tests simply stop
running, and the first evidence is a bug reaching production that the dropped
directory would have caught. `tests/e2e` currently holds the OAuth route tests,
the runbook preflight guard, the terraform scaffold assertions and the DynamoDB
schema checks — including the plaintext-refresh-token canary. Losing that
directory silently would remove the guard on "no plaintext OAuth tokens at rest"
while CI stayed green.

This is the third fail-open defect found in this project's test infrastructure
(after the `Statement = [` marker that disabled the IAM least-privilege guard on
a whitespace edit, and the ordering guard in TASK-028). The pattern is consistent:
a guard that cannot find or parse what it is checking treats that as "fine".

## Acceptance Criteria
- [ ] `isDirectoryCovered('node --import tests/e2e/setup.mjs --test tests/unit', 'e2e')`
      returns false.
- [ ] The same holds for `--require`, `--loader` and `--env-file` variants.
- [ ] `isDirectoryCovered('echo tests && node --test tests/unit', 'e2e')` returns
      false.
- [ ] Commands are split on `&&`, `||`, `;` and `|`, and only segments invoking a
      test runner contribute path arguments.
- [ ] `VALUE_TAKING_FLAGS` includes the path-valued node flags, with the existing
      explanatory comment preserved.
- [ ] Every case TASK-023 fixed still passes: `node --test tests`,
      `node --test ./tests/`, `node --test "tests/e2e"` all report covered, and
      `tests/e2e-legacy` / `--test-name-pattern tests` still report not covered.
- [ ] All four existing `VALUE_TAKING_FLAGS` entries remain individually pinned —
      removing any one turns the suite red. Re-verify by sweep; do not assume.
- [ ] Each newly added flag is likewise pinned by its own test.
- [ ] An unrecognised or unparseable script shape reports not-covered or throws;
      it never reports covered.
- [ ] `CI=1 node --test tests/unit` still reports not covered for e2e.
- [ ] Setting the `test` script to
      `node --import tests/e2e/globalSetup.mjs --test tests/unit` turns at least
      one test red.
- [ ] The unit and e2e layers still share one predicate implementation.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The coverage predicate never reports a directory that will not run
  Scenario Outline: A path-valued flag is not directory coverage
    Given a test script of "<script>"
    When coverage of "e2e" is evaluated
    Then it reports not covered
    Examples:
      | script                                                    |
      | node --import tests/e2e/setup.mjs --test tests/unit        |
      | node --require tests/e2e/setup.js --test tests/unit        |
      | node --loader tests/e2e/loader.mjs --test tests/unit       |
      | node --env-file tests/e2e/.env --test tests/unit           |

  Scenario: A token from an unrelated chained command is not coverage
    Given a test script of "echo tests && node --test tests/unit"
    When coverage of "e2e" is evaluated
    Then it reports not covered

  Scenario Outline: Everything TASK-023 fixed still works
    Given a test script of "<script>"
    When coverage of "e2e" is evaluated
    Then it reports covered
    Examples:
      | script                  |
      | node --test tests       |
      | node --test ./tests/    |
      | node --test "tests/e2e" |

  Scenario: An unparseable shape never reports covered
    Given a script shape the predicate cannot confidently parse
    When coverage is evaluated
    Then it reports not covered or throws

  Scenario: A dropped directory behind a setup file is caught
    Given a test script of "node --import tests/e2e/globalSetup.mjs --test tests/unit"
    When the suite runs
    Then at least one test fails
```

## Additional Context
