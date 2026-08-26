---
id: TASK-100
title: The deploy-time dependency guard only cross-checks @aws-sdk imports, so deleting the @anthropic-ai/sdk declaration ships a broken zip silently — TASK-038's exact failure mode
status: todo
created: 2026-08-26T01:55:00.000Z
updated: 2026-08-26T01:55:00.000Z
review-of: TASK-038
---

## Description
Two latent gaps in `scripts/verify-lambda-package-deps.mjs`, found by TASK-038's
tester while proving the rework. Neither is live today and neither made TASK-038
red — but the second one reopens the exact failure mode TASK-038 exists to prevent,
which is why this is not just a nit.

### Gap 1 — the guard only cross-checks `@aws-sdk/*` imports (the important one)
`findUndeclaredAwsSdkImports` verifies that every imported `@aws-sdk/*` package is
declared. Nothing performs the equivalent check for the two dependencies the ticket
was actually raised about: `@anthropic-ai/sdk` and `zod`.

So if someone deletes the `@anthropic-ai/sdk` declaration from
`src/lambda/calendar/package.json`, `npm ci` succeeds (the manifest is internally
consistent), the guard passes (it only looks at `@aws-sdk/*`), and the zip ships
**without the Anthropic SDK** — producing precisely the original TASK-038 symptom:
the Lambda boots, every extraction fails at first use, a scan reports success, and
the calendar silently finds nothing.

TASK-038's e2e archive-contents scenario does cover this (mutation E8 confirmed it
goes red), so the repository is protected **at test time**. The deploy-time guard —
the thing that runs during `terraform apply`, where no test suite is present — is
not. A guard whose whole purpose is to fail loudly at deploy has a hole exactly
where the ticket's headline dependency lives.

### Gap 2 — the import scanner misses bare side-effect imports
The guard's import-scanning regex matches `import ... from "pkg"` and
`await import("pkg")`, but not a bare side-effect import:

```js
import "@aws-sdk/client-kms";
```

No such import exists under `src/lambda/calendar` today — all four `@aws-sdk`
usages are `from`-form or dynamic `import()` — so this is latent, not live. It
would become live the moment anyone writes one, and it would fail **open**: the
package would be imported, unseen by the scanner, and therefore never required to
be declared.

Note the tester hit this honestly while building its own fixture: its first
`node_modules`-is-skipped fixture used a bare `import "pkg";`, which passed even
with the skip removed — it passed for the wrong reason. The tester noticed, fixed
the fixture to the `from`-form, and re-proved it red. That near-miss is what
surfaced this gap.

### Why this is a follow-up and not a TASK-038 rework
TASK-038 met its acceptance criteria; both of these are additional hardening beyond
what it was asked for, and its tester classified them as non-blocking observations
rather than failures. Recorded here so they are not lost — particularly since this
board's PR Review column is currently configured to skip, so no reviewer will
re-raise them.

## Impact If Not Fixed
Gap 1 restores TASK-038's original failure mode through a different door: a
one-line manifest edit ships a Lambda that boots, reports successful scans, and
extracts nothing, with no error surfaced to the user and nothing obviously wrong in
the logs beyond per-message failures. The test suite would catch it, but the
deploy-time guard — the last line of defence, and the only one running during
`terraform apply` — would not.

Gap 2 is a fail-open hole in the same guard: a future side-effect import would be
invisible to the scanner and so never required to be declared, silently dropping
out of the zip. This repo has already found several guards that silently no-oped;
this is the same shape, caught before it went live.

There is no security consequence to either.

## Acceptance Criteria
- [ ] The deploy-time guard verifies that every non-`@aws-sdk` runtime dependency
      the code imports — at minimum `@anthropic-ai/sdk` and `zod` — is both declared
      in the manifest and present in the installed tree, failing loudly and naming
      the package when it is not.
- [ ] Deleting the `@anthropic-ai/sdk` declaration makes the guard exit non-zero
      naming that package, proven by an executed mutation, not by inspection.
- [ ] The import scanner recognises bare side-effect imports (`import "pkg";`) in
      addition to the `from` and dynamic `import()` forms.
- [ ] A test fixture containing ONLY a bare side-effect import is caught by the
      scanner — and that fixture is verified to fail for the right reason (confirm
      it goes red when the behaviour under test is removed, so it cannot pass
      vacuously the way the tester's first attempt did).
- [ ] The guard still passes on the current tree with no false positives, and
      `terraform validate` still reports `error_count == 0` with the 4 expected
      deprecation warnings not asserted away.
- [ ] No existing TASK-038 assertion is weakened to accommodate the change.
- [ ] The full suite passes, with the two known unrelated baseline failures
      (TASK-098, TASK-099) reported separately and honestly.

## Cucumber Tests
```gherkin
Feature: The deploy guard covers every runtime dependency, not only the AWS SDK
  Scenario: A deleted Anthropic SDK declaration is caught at deploy time
    Given the @anthropic-ai/sdk declaration is removed from the manifest
    When the packaging guard runs
    Then it exits non-zero and names @anthropic-ai/sdk
    And no archive is produced

  Scenario: A bare side-effect import is seen by the scanner
    Given a source file containing only 'import "@aws-sdk/client-kms";'
    When the import scanner runs
    Then it reports that package as imported
    And the guard requires it to be declared

  Scenario: The guard does not fire on a correct tree
    Given the manifest declares every imported runtime dependency
    When the packaging guard runs
    Then it exits 0 and reports PASS

  Scenario: The new fixture cannot pass vacuously
    Given the side-effect-import fixture
    When the scanner's side-effect handling is removed
    Then the fixture's test fails
```

## Additional Context
