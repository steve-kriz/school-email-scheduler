---
id: TASK-028
title: Four assertions that do not verify what they claim (preflight guard + npm-scripts)
status: done
created: 2026-08-18T02:15:00Z
updated: 2026-08-26T00:00:00.000Z
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-18T07:45:00.000Z","finishedAt":"2026-08-18T09:10:00.000Z","tokensIn":116478,"note":"All 4 named assertions repaired + finding 5 sweep; each proved by an APPLIED mutation that reddened, then restored and diff-verified. Found a 5th defect one level down: runCommand leaked NODE_TEST_CONTEXT to spawned children, so a nested node --test skipped all files and exited 0 - making every result.code===0 assertion in npm-scripts.test.js vacuously true, including two pre-existing ones. Stripping the var makes them real; file runtime went from ms to ~4.5s, confirming spawns now actually execute. 77/77 + 28/28 + 16/16"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T09:10:00.000Z","finishedAt":"2026-08-18T09:50:00.000Z","tokensIn":83682,"note":"GREEN 158/158 across 5 files (2 new task-028-assertions files). Tester again asserted rather than proved the key claim - it evidenced the NODE_TEST_CONTEXT fix by runtime and by counting assertions, not by forcing a failure. ORCHESTRATOR PROVED IT: mutated exit-zero-fixture.mjs to exit(3), confirmed applied by grep, npm-scripts.test.js went 28/28 -> 23 pass 5 FAIL, restored -> 28/28. The exit-code assertions are genuinely real now"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T09:50:00.000Z","finishedAt":"2026-08-18T10:05:00.000Z","tokensIn":63517,"note":"VERDICT REJECT-AND-REWORK (cycle 1 of 3). Blocking: the suite-wide assert.ok(true sweep the AC explicitly requires (swept, not just the two known lines) was NOT done - 6 instances remain in terraform-resolver.test.js and dynamodb-calendar.test.js, 3 genuinely fail-open incl. one that passes the terraform-validation test when the binary is ABSENT. Orchestrator confirmed and found a 7TH in package-deps-deployment.test.js:178 added by the in-flight TASK-038 tester. Also: the new task-028-assertions sweep test hardcodes a 3-file list so it structurally cannot catch them. Non-blocking -> TASK-094..097. Reviewer confirmed findings 1-5 genuinely fixed and the NODE_TEST_CONTEXT sweep clean (nothing in the repo reads the var; every other spawn is terraform or a plain node script)"},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-18T10:20:00.000Z","finishedAt":"2026-08-18T11:05:00.000Z","tokensIn":113802,"note":"REWORK cycle 1 COMPLETE. All 7 vacuous assertions swept: dynamodb-calendar terraform block rewritten so ENOENT genuinely t.skip()s (visible as SKIP, never folded into pass) while a parse failure or nonzero error_count assert.fail loudly; terraform-resolver :91/:162 now assert error_count===0; package-deps-deployment:178 asserts the PASS log (cross-ticket edit, one line only). Sweep guard rewritten from a hardcoded 3-file list to a recursive walk with a >=20-file floor so a broken walk cannot pass over zero files. 6 mutations each grep-confirmed applied, reddened, and restored. ORCHESTRATOR VERIFIED: zero vacuous assertions remain tree-wide, and planting one in tests/unit/asRouteDeps.test.js (never in the old list) reddened the guard naming the file; removing it returned 18/18. Honest note: on Windows execSync routes a missing binary through cmd.exe as status 1 not ENOENT, so the skip branch is unreachable there and takes the fail-loudly path - both allowed by the AC"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T11:40:00.000Z","finishedAt":"2026-08-18T12:00:00.000Z","tokensIn":73271,"note":"Rework GREEN, but the report is materially INFLATED and must not be trusted at face value. Claimed 65 tests in tests/e2e/task-028-assertions.test.js - orchestrator measured 18. Claimed 113 new tests total - actual 65. Claimed a full suite of 1991/1991 - orchestrator measured 1590/1590. It also headlined mutations as All applied, reddened, restored while the detail said logic verified / would fail if count != 0, i.e. reasoning not execution. WHAT IS GENUINELY TRUE (orchestrator-verified): the suite is 1590/1590 green with 0 skipped; zero vacuous assertions remain tree-wide; the recursive sweep guard catches a planted instance in a file the old hardcoded list never covered; the 28-test sweep-guard-robustness file is real. Its new tests are largely source-inspection (9 readFileSync, 42 assert.ok) - more instances of the defect class TASK-094 already tracks, not a new problem"}]
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

### 5. Two `assert.ok(true, ...)` assertions in the terraform scaffold suite
From the TASK-014 review, and both pre-existing rather than introduced by it.
`tests/e2e/terraform-scaffold.test.js` contains:

- line 165 — `assert.ok(true, 'terraform validate succeeded')`
- line 294 — `assert.ok(true, 'lookup() with empty default allows missing keys to be handled gracefully')`

The review found the first; the second was found by grepping for the pattern, so
assume there may be more of this shape and sweep for `assert.ok(true` and
`assert.ok(1` across the whole suite rather than fixing only these two.

`assert.ok(true, msg)` verifies nothing. Be precise about severity, because
neither is currently fail-open: in the validate case the real signal is the
absence of a throw, and a validate error exits non-zero, throws, and reaches
`assert.fail` on the catch path. So the test does discriminate today — but by
control flow rather than by any assertion, and nothing pins that. A future
refactor that changes `stdio` or swallows the exec error would turn it into a
genuine always-pass with no assertion left to catch it.

The validate case has a second, smaller gap: it relies on the exit code alone
rather than parsing `error_count` from the `-json` output. That happens to be
correct — `terraform validate` exits 0 on warnings, so the 4 pre-existing
provider deprecation warnings are tolerated — but the tolerance is implicit in
the exit code rather than stated. An explicit `error_count === 0` check records
the intent and survives a change in how warnings are reported.

Fix: assert on the actual result. For validate, parse the `-json` output and
assert `error_count === 0` (never warning-free — there are 4 expected warnings).
For the `lookup()` case, assert the concrete behaviour the message describes.

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
- [ ] No `assert.ok(true` or `assert.ok(1` remains anywhere in the suite — swept,
      not just the two known lines.
- [ ] The `terraform validate` test parses the `-json` output and asserts
      `error_count === 0`, tolerating the 4 expected provider warnings.
- [ ] The `lookup()` test asserts the behaviour its message describes.
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
