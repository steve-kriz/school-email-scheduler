---
id: TASK-028
title: A dead negated-object assertion and an ordering guard that fails open on reformat
status: todo
created: 2026-08-18T02:15:00Z
updated: 2026-08-18T02:15:00Z
review-of: TASK-024
---

## Description
Two low findings from the TASK-024 review, both in
`tests/e2e/check-oauth-config.test.js`, both verified by execution.

They share the "must never fail open" principle with **TASK-017**, but they are
filed separately on purpose: TASK-017 owns the terraform/HCL helpers in the
dynamodb and lambda test files, and folding a different file's guards into it
would make an already-large ticket harder to finish. Treat the two as siblings,
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

Neither has a security consequence and neither is failing today. Both are on the
board because they are the same defect class this project has now hit fifteen
times: an assertion reporting success over nothing.

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
```

## Additional Context
