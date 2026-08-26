---
id: TASK-052
title: parseSecretsAccesses is triplicated, so its 30 unit tests exercise copies rather than the shipped parser
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: medium
---

## Description
`parseSecretsAccesses` exists in three places with identical bodies:

- `tests/e2e/terraform-scaffold.test.js:229` — the only copy that actually guards `main.tf`
- `tests/unit/parseSecretsAccesses.test.js:14` — the comment literally reads "Copy of parseSecretsAccesses from terraform-scaffold.test.js"
- `tests/unit/mutation-sweep.test.js:15`

`assertAllSecretReadsAreGuarded` is duplicated too, at
`terraform-scaffold.test.js:269` and `mutation-sweep.test.js:48`.

`tests/helpers/hcl-blocks.mjs` (built by TASK-017) already exists as the natural
home and already has stronger masking. Consolidate there.

## Impact If Not Fixed
All 30 unit tests can stay green while the e2e copy — the only one that guards a
real terraform file — drifts or regresses. The mutation sweep's proof of
discrimination applies to a copy that nothing ships, so the suite's central
claim ("this parser is proven to catch violations") is being made about the
wrong code.

## Acceptance Criteria
- [ ] One definition of `parseSecretsAccesses` and one of `assertAllSecretReadsAreGuarded`, exported from `tests/helpers/hcl-blocks.mjs`.
- [ ] All three test files import them; no copy remains.
- [ ] The unit tests demonstrably exercise the same function the e2e guard uses — verified by mutating the shared helper once and confirming BOTH unit and e2e tests redden.
- [ ] The mutation is confirmed to have applied before the result is trusted, and the restore is verified.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: One parser, exercised by every test that claims to test it
  Scenario: Mutating the shared parser reddens both suites
    Given the shared parseSecretsAccesses is mutated to miss direct indexes
    When the unit and e2e suites run
    Then tests fail in both

  Scenario: No duplicate definition remains
    Given the test tree is searched for a local parseSecretsAccesses definition
    Then only the shared helper defines it
```

## Additional Context
Bundled nit from the same review: `tests/unit/mutation-sweep.test.js:132-137`
asserts "all mutations applied successfully" and that `main.tf` was "restored
after each mutation" — but the mutations are purely in-memory string
replacements and the file is never written, so the assertion is vacuous by
construction and its message misrepresents what happened. The in-memory design
is the *safer* choice; only the labelling is wrong. Fix the wording and the
assertion together.

Also `tests/e2e/terraform-scaffold.test.js:298-300`: `const result = execSync(...)`
is assigned, never used, and followed by `assert.ok(true, ...)`.
