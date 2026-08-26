---
id: TASK-058
title: The terraform test harness is wholesale-duplicated and one copy's ANSI-strip regex is wrong
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: low
---

## Description
`resolveTerraformBin`, `describeExecError`, `removeWorkspace`,
`createSecretLookupWorkspace`, `tryEvaluateSecretExpression` and
`SECRET_LOOKUP_MAIN_TF` are copied between
`tests/e2e/terraform-scaffold.test.js:23-219` and
`tests/unit/terraform-discriminators.test.js:14-108`.

The copies have already diverged, and one is buggy. Confirmed by direct
inspection:

The two copies of the ANSI-strip regex are NOT identical, but the difference
is an invisible control character, so compare them byte-for-byte rather than
by eye:

    sed -n "109p;205p" tests/e2e/terraform-scaffold.test.js | cat -A

- `tests/e2e/terraform-scaffold.test.js:109` and
  `tests/unit/terraform-discriminators.test.js:94` are CORRECT. The regex
  literal is prefixed with a real ESC control character (0x1B), which
  `cat -A` renders as `^[`. It matches genuine ANSI colour escapes.
- `tests/e2e/terraform-scaffold.test.js:205` is WRONG. The ESC character is
  absent, so the pattern is only an escaped bracket, digits/semicolons and
  `m` — it matches a bare bracket sequence appearing as ordinary data.

Because the ESC is invisible in an editor and in most diffs, this divergence
can survive review indefinitely — which is exactly how it survived here.

Consolidate the harness into a shared helper (alongside or within
`tests/helpers/hcl-blocks.mjs`) and fix the regex once.

## Impact If Not Fixed
The broken regex silently corrupts any evaluated value containing a `[…m`
substring before it is asserted on, producing either a confusing failure or —
worse — a wrong pass. Because the harness is duplicated, fixing it in one file
leaves the other wrong, and the two copies will keep drifting.

## Acceptance Criteria
- [ ] Both copies of the ANSI-strip regex are prefixed with the ESC (0x1B) character, verified with `cat -A` rather than by eye.
- [ ] A test proves a value containing a literal `[0m`-like substring survives stripping intact.
- [ ] The duplicated harness functions are defined once in a shared helper and imported by both files.
- [ ] No copy of `SECRET_LOOKUP_MAIN_TF` or the workspace helpers remains duplicated.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Terraform output is stripped of ANSI codes without corrupting values
  Scenario: A real ANSI escape is stripped
    Given terraform output containing an ANSI colour escape
    When the output is cleaned
    Then the escape is removed

  Scenario: A literal bracket-m substring is preserved
    Given an evaluated value containing the literal text "[0m" as data
    When the output is cleaned
    Then the value is unchanged
```

## Additional Context
Coordinate with TASK-017 pass 3, which consolidates `resolveTerraformBin` to a
single resolver with a loud PATH-fallback failure in
`tests/e2e/terraform-scaffold.test.js`. That work lands first; this ticket
extends the consolidation to the duplicated copy in
`tests/unit/terraform-discriminators.test.js` and fixes the regex.
