---
id: TASK-017
title: Make the calendar table tests assert semantics, not raw HCL text
status: todo
created: 2026-08-18T00:05:00Z
updated: 2026-08-18T00:05:00Z
review-of: TASK-002
---

## Description
`tests/unit/dynamodb-calendar.test.js` and `tests/e2e/dynamodb-calendar.test.js`
assert almost entirely by substring-matching raw `.tf` text
(`content.includes('...')`). Two concrete consequences the review identified:

**1. Block context is not verified.** `point_in_time_recovery`, `ttl` and
`server_side_encryption` are each validated only via
`includes('enabled = true')` / `includes('enabled     = true')`. That cannot
tell which block the flag belongs to, so a flag moved between blocks, or
switched off in one block while another still says `true`, keeps the suite
green. Examples live around `tests/unit/dynamodb-calendar.test.js:154-168` and
`:320-348`.

**2. A dead assertion.** `tests/e2e/dynamodb-calendar.test.js:38-41` asserts
`!schemaSection.includes('refreshToken\s')`. In a JavaScript string literal
`'refreshToken\s'` is the literal 14-character text `refreshToken\s` — a
backslash followed by `s`, not a regex whitespace class. That text never appears
in the file, so the negation is always true and the assertion can never fail.
The scenario reads as double coverage of the security-critical "no plaintext
refresh token attribute" invariant but is really single-covered by the adjacent
`.match(/refreshToken\s*:/)`.

Fix both by asserting over **parsed structure** rather than text. Terraform can
emit machine-readable configuration without AWS credentials:
`terraform init -backend=false` then `terraform show -json` on a plan is not
available (no credentials), but `hcl2json`-style parsing is unnecessary — the
practical approach is to parse the block structure yourself: locate each
`resource "aws_dynamodb_table" "<name>" { ... }` body by brace matching, then
assert on nested blocks *within that body* rather than on the whole file. Build
one small shared helper (e.g. `tests/helpers/hcl-blocks.mjs`) that extracts a
named resource body and its nested blocks, and reuse it across the assertions.

Then replace the dead assertion with a real one: assert that no attribute name
in the documented schema matches `/^\s*[-*]?\s*refreshToken\s*[:(]/m` other
than `refreshTokenEnc` and `refreshTokenKeyId`, so a genuinely plaintext
`refreshToken` entry would fail.

Do not weaken existing coverage while refactoring: the suite must still cover
every acceptance criterion TASK-002 listed.

**Folded in from the TASK-016 review — brace counting is unsafe as it stands.**
TASK-016 added `extractResourceBody(content, type, name)` and
`bodyDeclaresTtlBlock(body)` at module scope in both dynamodb test files, and
the shared helper this ticket builds must supersede them rather than sit
alongside them. `extractResourceBody` counts braces without skipping string
literals or comments. It works on today's files only because every brace-bearing
construct happens to be balanced (`${local.name_prefix}`,
`merge(var.tags, { ... })`). A future resource containing an unbalanced brace in
a string, a comment, or a heredoc — `description = "use { here"`, or an inline
IAM policy — makes the extractor return a **truncated** body, and a truncated
body that omits a real `ttl` block yields a **false negative**: the TTL guard
passes when it should fail.

That is the worst failure mode available here, because the guard exists
specifically to protect the table holding every user's OAuth grant, and later
tickets add richer `.tf` files (TASK-003's `lambda_calendar.tf` already contains
inline IAM policy JSON). So the shared helper must skip braces inside double-quoted
strings, `#`/`//` line comments, and `<<EOT`/`<<-EOT` heredocs, and must be tested
against a fixture containing each of those. Migrate both dynamodb test files onto
the shared helper and delete the local copies, so there is exactly one
implementation to keep correct.

**Also folded in from the TASK-021 review — the Sid-first guard disables itself
silently (medium).** `tests/unit/calendar-lambda-terraform.test.js` gained
`assertAllStatementsHaveSidFirst` (lines ~52–78) to close a false negative where a
statement with `Sid` in a later position hid its `Resource = "*"` from the
least-privilege guard. That fix has the same weakness as the extractor above: it
locates the policy array with `indexOf('Statement = [')` and then counts `[`/`]`
without skipping string literals, and on **any** mismatch or missing marker it
`return`s silently, skipping the whole check.

Verified by execution. With the marker reformatted from `Statement = [` to
`Statement=[`, a synthetic statement carrying `Resource = "*"` with its `Sid`
last is not reported at all:

```
normal `Statement = [` marker      -> THREW (guard active)
reformatted `Statement=[` marker   -> SILENT PASS -> ["VPCNetworkInterfaces"]
```

So a whitespace edit turns off the guard protecting the KMS decrypt path for every
user's refresh token, with the suite still green. Two requirements:

- The shared extractor must find the `Statement` array by a tolerant pattern
  (`/Statement\s*=\s*\[/`), not a literal string, and must skip brackets inside
  strings, comments and heredocs.
- **It must never fail open.** If the policy cannot be parsed, the helper must
  throw with a message saying so — not `return` silently. A guard that cannot
  find what it is guarding has to be loud. Add a fixture proving that an
  unparseable policy fails rather than passes.

**And the brittleness the same review raised (low).** The Sid-first check hard-fails
whenever `Sid` is not the first key, rather than attributing correctly. That was
the right immediate call over a silent false negative, and the message is
actionable ("Reorder the statement so Sid is first"). But it fails the suite on
correct HCL if someone alphabetises keys so `Action` precedes `Sid`, sending them
to fix test plumbing rather than code. (`terraform fmt` only aligns `=`; it does
not reorder keys, so routine formatting is safe.) Once the shared extractor parses
statement objects structurally, attribute `Resource` to its enclosing statement
regardless of key order and **delete the Sid-first constraint** — it exists only
because the current parser splits on Sid boundaries. Keep a test proving a
Sid-last statement's unscoped `Resource` is still caught.

Note for sequencing: TASK-016 also edited these two test files, and TASK-014 and
TASK-015 edit the scaffold test pair for the same class of reason. None of these
tickets may be built concurrently with each other.

## Impact If Not Fixed
These tests are the gate that is supposed to catch a regression in the table
definitions, and today they only prove certain strings are present somewhere in
the file. A change that turns off point-in-time recovery on the connections
table, points `server_side_encryption` at the wrong key, or adds an unwanted
`ttl` block would pass CI while silently weakening durability or encryption on
the table holding every user's OAuth grant. The dead assertion additionally
overstates coverage of the most sensitive invariant in the schema, so a reader
auditing the tests would conclude the plaintext-token guard is stronger than it
is.

## Acceptance Criteria
- [ ] A shared helper extracts a named `resource` body from a `.tf` file by
      brace matching and returns its nested blocks.
- [ ] `point_in_time_recovery`, `ttl` and `server_side_encryption` assertions
      operate on the specific resource body and the specific nested block, not
      on whole-file substrings.
- [ ] An assertion fails when `enabled = true` is present in the file but in the
      wrong block — verified with a deliberately mutated fixture.
- [ ] An assertion fails when `server_side_encryption` references a different
      KMS key — verified with a mutated fixture.
- [ ] The dead `!includes('refreshToken\s')` assertion is replaced with a check
      that actually fails on a plaintext `refreshToken` schema entry, verified
      with a mutated fixture.
- [ ] The replacement still passes against the real file, where only
      `refreshTokenEnc` and `refreshTokenKeyId` appear.
- [ ] No assertion in either file relies on matching an HCL flag by whole-file
      substring where block context is what matters.
- [ ] Every acceptance criterion TASK-002 listed is still covered — coverage
      count does not drop.
- [ ] The full suite passes under `node --test tests/unit tests/e2e`.
- [ ] Mutated fixtures are written to a temp location and cleaned up even when a
      test fails; the real `.tf` files are never modified by a test.
- [ ] The shared resource-body extractor ignores braces inside double-quoted
      strings, `#` and `//` line comments, and `<<EOT` / `<<-EOT` heredocs.
- [ ] A fixture containing an unbalanced brace in a string (e.g.
      `description = "use { here"`) is extracted correctly, and a `ttl` block
      placed *after* that string is still detected — proving the extractor
      cannot produce a false negative by truncating the body.
- [ ] Equivalent fixtures cover an unbalanced brace in a comment and in a
      heredoc.
- [ ] The extractor is verified against `terraform/lambda_calendar.tf`, which
      contains inline IAM policy JSON, not only against the two dynamodb files.
- [ ] `extractResourceBody` and `bodyDeclaresTtlBlock` exist in exactly one
      place — the shared helper — and the local copies in both dynamodb test
      files are deleted, not left duplicated.
- [ ] TASK-016's TTL guard still passes after migrating onto the shared helper,
      and its mutated-fixture test still fails when the block is re-added.
- [ ] The `Statement` array is located by a tolerant pattern, so `Statement=[`
      (no spaces) and `Statement  =  [` are both found.
- [ ] The helper **throws** rather than returning silently when a policy cannot
      be parsed — verified with an unparseable fixture that must fail, not pass.
- [ ] With the marker reformatted to `Statement=[`, a Sid-last statement carrying
      `Resource = "*"` is still reported (or the run fails loudly) — the silent
      pass demonstrated in the TASK-021 review no longer occurs.
- [ ] `Resource` is attributed to its enclosing statement regardless of key
      order, and the `assertAllStatementsHaveSidFirst` constraint is deleted once
      that holds.
- [ ] A test proves an unscoped `Resource` in a Sid-last statement is caught by
      attribution, not by the deleted key-order constraint.
- [ ] Alphabetising a statement's keys so `Action` precedes `Sid` no longer fails
      the suite.

## Cucumber Tests
```gherkin
Feature: Table tests assert structure, not text
  Scenario: A flag in the wrong block is caught
    Given a mutated copy where enabled = true sits in a different block
    When the point_in_time_recovery assertion runs
    Then it fails

  Scenario: A wrong encryption key is caught
    Given a mutated copy whose server_side_encryption references another key
    When the encryption assertion runs
    Then it fails

  Scenario: A plaintext refresh token entry is caught
    Given a mutated copy whose schema comment documents a "refreshToken" attribute
    When the plaintext-token assertion runs
    Then it fails

  Scenario: The real files still pass
    Given the unmodified terraform files
    When the full suite runs
    Then every assertion passes

  Scenario: The dead assertion is gone
    Given tests/e2e/dynamodb-calendar.test.js
    Then it contains no assertion on the literal string "refreshToken\s"

  Scenario: Coverage does not regress
    Given the refactored suite
    Then it still covers every acceptance criterion listed by TASK-002

  Scenario: Mutated fixtures do not leak
    Given a fixture-based test that fails mid-run
    When the suite finishes
    Then no temp fixture remains
    And the real terraform files are unmodified
```

## Additional Context
