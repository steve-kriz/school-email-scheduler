---
id: TASK-028
title: Four assertions that do not verify what they claim (preflight guard + npm-scripts)
status: todo
created: 2026-08-18T02:15:00Z
updated: 2026-08-18T02:22:00Z
review-of: TASK-024, TASK-023
---

## Description
Four low findings, all the same defect class: an assertion that reports success
over behaviour it never exercises. Two come from the TASK-024 review and live in
`tests/e2e/check-oauth-config.test.js`; two come from the TASK-023 review and live
in `tests/e2e/npm-scripts.test.js`. All four were verified by execution or by
reading the predicate.

They are grouped because the fix is the same discipline in each case — make the
assertion depend on the thing its name promises — not because the files are
related. Sections 1-2 and 3-4 can be done independently.

These share the "must never fail open" principle with **TASK-017** (terraform/HCL
helpers) and **TASK-029** (the coverage predicate's false-covered cases), and are
filed separately from both: TASK-017 owns a different subsystem, and TASK-029 is a
medium fail-open defect rather than a weak assertion. Treat all three as siblings,
not duplicates.

### 1. The negated-object assertion can never fail (dead assertion)
`tests/e2e/check-oauth-config.test.js:796-807`:

```js
const negatedObjectClaim = 'Terraform creates nothing for the secret.';
const mutated = `${runbookText()}\n\n${negatedObjectClaim}\n`;
const claims = terraformCreatesSecretClaimsIn(mutated);

assert.ok(
  claims.length > 0 || /nothing|no/.test(negatedObjectClaim),
  ...
);
```

`negatedObjectClaim` is a constant that contains the word `nothing`, so
`/nothing|no/.test(negatedObjectClaim)` is **always true** and the `||` is
always satisfied regardless of what `terraformCreatesSecretClaimsIn` returns.

The test's stated purpose is to prove the `NEGATED_OBJECT` asymmetry is not
exploitable — that check exists only on the carried path (lines 76 and 101), so
the non-carried path's handling of a negated object is what needs proving. The
mutation that goes undetected: make `terraformCreatesSecretClaimsIn` return `[]`
for this input, or delete the non-carried negation handling entirely, and this
test stays green.

This is the fifteenth assertion found in this repository that passes regardless
of the code, and the second in this file specifically.

Fix: assert the concrete expected behaviour directly. Decide what
`"Terraform creates nothing for the secret."` should do — it is a denial, so it
should almost certainly **not** be reported — and assert that, with no constant
inside the predicate. If the intended behaviour is that it *is* reported, assert
`claims.length > 0` alone and let the test prove it.

### 2. The ordering guard fails open on a whitespace reformat
`tests/e2e/check-oauth-config.test.js:892-907` locates both commands with a
literal, single-spaced `indexOf` and returns silently when the first is absent:

```js
const createIndex = content.indexOf('aws secretsmanager create-secret');
const putIndex = content.indexOf('aws secretsmanager put-secret-value');
if (createIndex === -1) {
  return; // no create-secret step documented; ordering does not apply
}
```

Sibling guards in the same file use the tolerant `/aws\s+secretsmanager\s+create-secret/`
(e.g. lines 928, 976). Verified by execution against the real runbook:

```
original    literal indexOf : 11730
original    tolerant regex  : true
reformatted literal indexOf : -1      <- the test returns early
reformatted tolerant regex  : true    <- sibling guards still fire
occurrences that must be reformatted : 2
```

Be precise about the blast radius, because it is narrower than it first looks and
two attempts to reproduce it at suite level failed. The runbook mentions the
command **twice** — once in prose at line 231 and once in the code block at line
284 — so reformatting only the code block leaves the prose occurrence for
`indexOf` to find, and the guard still runs. Both occurrences must be reformatted
before it goes quiet. Sibling guards also keep the step's *presence* protected
either way. What becomes unguarded is specifically the **ordering** property:
that `create-secret` is documented before `put-secret-value`.

Fix: locate both commands with the same `\s+` regex the sibling guards use, and
make the guard **throw** rather than `return` when the marker is missing. A guard
that cannot find what it is guarding must be loud — the same requirement TASK-017
imposes on the terraform helpers, for the same reason.

### 3. "executes successfully" never checks the exit code
`tests/e2e/npm-scripts.test.js:259-264`:

```js
it('And the node --test tests/unit command executes successfully', () => {
  const result = runCommand(PROJECT_ROOT, 'node', ['--test', 'tests/unit/terraform-scaffold.test.js']);
  // Should not error, though exit code may vary
  const output = result.stdout + result.stderr;
  assert.ok(output.length > 0, 'node --test should produce output');
});
```

The test is named "executes successfully" and never inspects `result.code`. Its own
comment concedes the point — *"exit code may vary"*. `node --test` writes output on
failure as well as success, so `output.length > 0` holds either way.

Undetected mutation: make `tests/unit/terraform-scaffold.test.js` fail with a
non-zero exit — this test still passes, because stderr is non-empty.

It also hardcodes `tests/unit/terraform-scaffold.test.js`, which is the file that
shells out to `terraform validate -json`. That does not affect pass/fail here
(output is non-empty whether or not terraform exists), but it means the test's
runtime depends on an external binary for no benefit. Point it at
`tests/helpers/exit-zero-fixture.mjs` — created by TASK-023 precisely to be a
dependency-free spawn target — and assert `result.code === 0`.

### 4. "npm test completes without hanging or excessive forking" never runs npm test
`tests/e2e/npm-scripts.test.js:568-586`. The test name promises that `npm test`
completes without hanging or forking. The body checks that the fixture file exists
and that `scopeScriptToSingleFile(...)` output excludes `tests/e2e`. It never
invokes `npm test`.

Undetected mutation: if `npm test` genuinely hung or fork-bombed, this test would
still pass, because the behaviour it names is never executed.

The comment acknowledges the substitution — *"the existence of a fixture file and
the scoping logic prove no re-entrance occurs"* — and that reasoning is sound as
far as it goes: `node --test <file>` performs no directory discovery, so
re-entrance genuinely cannot occur. The defect is the **name**, which claims an
empirical property the test does not measure. Either rename it to describe what it
actually checks (the scoped command excludes the e2e directory), or make it spawn
the real thing with a timeout and assert exit 0 plus a bounded process count. The
real exit-0 proof at lines 471-482 already does the latter for `test:e2e`, so
renaming is the cheaper and more honest fix.

## Impact If Not Fixed
Finding 1 leaves the suite carrying a test that appears to cover the
`NEGATED_OBJECT` asymmetry and covers nothing. That is worse than having no test,
because an auditor reading the file concludes the asymmetry is guarded. If the
non-carried negation handling ever regresses — a legitimate denial like
*"Terraform creates no secret"* starting to be flagged, or a genuine claim
slipping through — nothing catches it.

Finding 2 means the create-before-populate ordering invariant can be silently
unguarded by an innocuous formatting change to the runbook. That invariant exists
because the original onboarding failure was precisely a step depending on a
secret an earlier step had not created: `put-secret-value` before the secret
exists returns `ResourceNotFoundException`. If the steps were later reordered
while the commands happened to be reformatted, that trap could ship with the
suite green.

Findings 3 and 4 cannot drop a directory or weaken a guarantee — the properties
they name are covered elsewhere (the real exit-0 proof at lines 471-482, and the
scoped-command recursion checks). Their cost is misdirection: a reviewer auditing
this suite reads "executes successfully" and "completes without hanging or
excessive forking" and concludes exit-code health and fork safety are measured
here. Neither is. When someone later needs to know whether those properties are
guarded — most likely while debugging a CI hang — the test names will send them to
the wrong place and they will trust an answer the suite never established.

None of the four has a security consequence and none is failing today. All four
are on the board because they are the same defect class this project has now hit
sixteen times: an assertion reporting success over behaviour it does not exercise.
The recurring lesson is that a test's name is a claim, and an unexercised claim in
a green suite is worse than a missing test, because it stops anyone looking.

## Acceptance Criteria
- [ ] The negated-object assertion contains no constant that forces its predicate
      true.
- [ ] It asserts the concrete intended behaviour for
      `"Terraform creates nothing for the secret."`, stated explicitly in the
      test name or a comment.
- [ ] Making `terraformCreatesSecretClaimsIn` return `[]` for that input turns
      the assertion red if the intended behaviour is "reported"; deleting the
      non-carried negation handling turns it red if the intended behaviour is
      "not reported". Verify whichever applies by mutation.
- [ ] The ordering guard locates both commands with a `\s+`-tolerant pattern.
- [ ] The ordering guard **throws** with an explanatory message when a marker
      cannot be found, rather than returning silently.
- [ ] With **every** occurrence of `aws secretsmanager create-secret`
      double-spaced in a fixture, the ordering guard still runs — proven by a
      fixture where the order is also reversed, which must fail.
- [ ] A fixture with the marker removed entirely fails loudly rather than
      passing.
- [ ] The real runbook still passes unchanged.
- [ ] No test writes to `docs/google-oauth-setup.md`; fixtures stay in memory.
- [ ] The "executes successfully" test asserts `result.code === 0`.
- [ ] That test spawns `tests/helpers/exit-zero-fixture.mjs` rather than the
      terraform-shelling file, so it needs no external binary.
- [ ] Making the spawn target exit non-zero turns that test red — verified by
      mutation.
- [ ] The "completes without hanging or excessive forking" test either runs
      `npm test` with a timeout and asserts exit 0 plus a bounded process count,
      or is renamed to state only what it checks.
- [ ] No test in `npm-scripts.test.js` has a name promising a property it does not
      exercise.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Guards in the preflight suite cannot pass vacuously or fail open
  Scenario: The negated-object assertion depends on the guard's output
    Given a build whose non-carried negation handling is deleted
    When the negated-object test runs
    Then it fails

  Scenario: The ordering guard survives a whitespace reformat
    Given a runbook fixture where every create-secret occurrence is double-spaced
    And the create-secret step is documented after put-secret-value
    When the ordering guard runs
    Then it fails

  Scenario: A missing marker fails loudly
    Given a runbook fixture with no create-secret command at all
    When the ordering guard runs
    Then it throws rather than returning silently

  Scenario: The real runbook is unaffected
    Given the unmodified runbook
    When the suite runs
    Then every assertion passes

  Scenario: "executes successfully" depends on the exit code
    Given a spawn target that exits non-zero
    When the executes-successfully test runs
    Then it fails

  Scenario: The spawn target needs no external binary
    Given a machine with no terraform installed
    When the executes-successfully test runs
    Then it still passes

  Scenario: No test name promises what it does not measure
    Given every test in npm-scripts.test.js
    Then each name describes a property its body exercises
```

## Additional Context
