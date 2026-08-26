---
id: TASK-038
title: The deploy zips src/ as-is, so the Anthropic SDK is never installed and every extraction fails quietly
status: done
created: 2026-08-18T03:55:00Z
updated: 2026-08-26T01:55:00.000Z
activities: [{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-18T08:55:00.000Z","finishedAt":"2026-08-18T09:50:00.000Z","tokensIn":82365,"note":"null_resource runs npm ci --omit=dev then a new scripts/verify-lambda-package-deps.mjs preflight; archive_file depends_on it, so a broken install fails apply before a zip exists. Lockfile generated and committed-pending. Removed @aws-sdk/* from the manifest (runtime provides them) so manifest and terraform comment agree. REAL npm ci ran and both @anthropic-ai/sdk and zod dynamically imported OK; verify script mutation-tested both full and partial miss, restore confirmed. terraform validate Success. NOT verified: real terraform plan/apply (S3 backend needs AWS creds) - honestly reported. NOTE: src/lambda/calendar/package-lock.json is UNTRACKED and must be committed or the fix does not reproduce"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T09:50:00.000Z","finishedAt":"2026-08-18T10:20:00.000Z","tokensIn":68226,"note":"GREEN 49/49 (27 unit + 22 e2e) plus 56/56 no regression. Mutations EXECUTED not claimed: bypassing the missing-dep check caught by 4 tests, flipping the success exit code caught by 2, stripping package names from the error caught by 2. Provisioner chain fail-loud proved with a genuinely broken node_modules (exit 1 naming zod). Honestly reported terraform plan/apply unverifiable without AWS creds. DEFECT INTRODUCED: added assert.ok(true, Script executed without throwing) at package-deps-deployment.test.js:178 - the 7th vacuous assertion, folded into TASK-028 rework sweep"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T10:20:00.000Z","finishedAt":"2026-08-18T10:50:00.000Z","tokensIn":44756,"note":"VERDICT REJECT-AND-REWORK (cycle 1/3). CRITICAL TASK-098: post-cd relative paths in the local-exec resolve against the NEW cwd, so the verify script arg becomes src/lambda/scripts/... - ORCHESTRATOR CONFIRMED that directory does not exist, so every apply fails. terraform validate cannot catch it and no test did. HIGH TASK-099: client-kms removed but nodejs20.x+ bundles only client-dynamodb/lib-dynamodb/client-s3; ORCHESTRATOR FOUND THE GAP IS WIDER - client-kms, client-scheduler and credential-providers are all imported in src/ and declared nowhere. HIGH TASK-100: trigger-gated install means a second machine or CI runner skips install AND guard. HIGH TASK-101: lockfile untracked so filesha256 hard-errors at plan on a fresh checkout. Plus TASK-102..106"},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T00:05:00.000Z","finishedAt":"2026-08-26T00:52:00.000Z","note":"REWORK cycle 1 COMPLETE (db0b6be). CRITICAL post-cd path bug fixed by hoisting all four paths into abspath() locals and replacing cd with the provisioner working_dir, plus two fileexists preconditions - PROVEN by executing the interpolated command for real (npm ci installed 41 packages, verifier printed PASS exit 0), not by reasoning. REVIEWER WAS WRONG ON ONE POINT, coder checked and said so: @aws-sdk/credential-providers is NOT imported anywhere under src/ - its only occurrence in the repo is the reviewer note itself. Real imported set is four: client-dynamodb, lib-dynamodb, client-kms, client-scheduler. DECISION REVERSED vs cycle 0: now ships all four pinned independently (the ticket second blessed option) rather than relying on runtime bundling, because this is 100pct ESM using dynamic import() where the runtime copy is exposed only via NODE_PATH which the ESM resolver does not consult. Cost MEASURED not asserted: kms+scheduler alone are 17.7MB (smithy core), the dynamodb pair adds only 2.6MB, 20.3MB of 250MB. RUNTIME_BUNDLED_AWS_SDK_PACKAGES removed from the verifier; it is now a flat imported-implies-declared set difference. Fail-loud paths EXECUTED: undeclared import -> exit 1 naming it; lockfile drift -> npm ci exit 1 aborting before archive_file. terraform plan/apply still UNVERIFIED (S3 backend needs AWS creds) - honestly reported. Claims npm test is broken at base independently of this ticket (node --test with directory args) - ORCHESTRATOR VERIFYING. Token/cost telemetry not correlated; 120283 total subagent tokens reported, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-26T00:52:00.000Z","finishedAt":"2026-08-26T01:52:00.000Z","note":"GREEN. New tests/e2e/task-038-deployment-packaging.test.js (28 cases, all four Gherkin scenarios) + tests/unit/task-038-packaging-guard.test.js (29) + tests/helpers/tf-path-locals.mjs. 1651 tests 1649 pass 2 fail; the 2 are the known unrelated baseline (TASK-099 CRLF, TASK-098 test:bdd), byte-identical to the pre-existing baseline measured at db0b6be. New files alone 57/57. terraform validate error_count 0 warning_count 4. CRITICAL path finding proved BY EXECUTION not reading: the e2e parses the real command, resolves the terraform locals the same way terraform does (verified abspath(path.module/../x) == path.resolve(tfdir,x) against a real terraform console) and RUNS the verify step from working_dir -> exit 0, AND runs the rejected shape as a live regression witness, asserting it still dies with Cannot find module. @aws-sdk decision re-verified against the NEW ship-all-four decision; contradiction detector carries a positive control on the old runtime-provides sentence so it cannot pass vacuously. CONFIRMED THE REVIEWER WAS WRONG AND THE CODER RIGHT: credential-providers occurs nowhere under src/. 14 mutation groups EXECUTED mutate-red-restore-green with the tree verified clean after each, including re-running both of the coder own claimed mutations for real. HONEST SELF-CATCH: its first node_modules-skip fixture used a bare side-effect import and passed for the WRONG reason even with the skip removed - it noticed, fixed the fixture to the from-form and re-proved red. NOT VERIFIED and stated plainly: real terraform plan/apply (no AWS creds) and the actual zip is never built. Raised 2 latent non-blocking gaps -> TASK-100. Token/cost telemetry not correlated; 117883 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
review-of: TASK-007
---

## Description
TASK-007 added the first genuine runtime dependencies — `@anthropic-ai/sdk` and
`zod` in `src/lambda/calendar/package.json`. Nothing installs them.

`terraform/lambda_calendar.tf` builds the deployment package with
`data.archive_file` over `../src/lambda/calendar` **as-is**, and `node_modules/`
is gitignored. So the zip contains `package.json` but no dependencies. The
failure mode is the bad one:

- The Lambda **still boots**, because TASK-007 deliberately imports the SDK
  behind a cached module-scope promise (`getClient()`) rather than at top level —
  it had to, since this repo has no `node_modules` at all and the whole test
  suite runs on zero dependencies.
- Every extraction then fails at first use and is recorded as a `FAILED`
  extraction against the message.
- A scan therefore *succeeds*, reports messages fetched, and produces **zero
  events**, with no error surfaced to the user and nothing obviously wrong in the
  logs beyond per-message failures.

That is quiet degradation of the product's core function. It would present as
"the calendar just doesn't find anything".

Fix: make the dependency install part of the packaging path, not a step someone
remembers. Options, in rough order of robustness:
- a `null_resource`/`terraform_data` provisioner running
  `npm install --omit=dev` in `src/lambda/calendar` before `archive_file`, with
  the `package-lock.json` hash as a trigger;
- build the zip from a staging directory that the install populates, leaving the
  source tree clean;
- or a documented, enforced build step in the deploy runbook plus a preflight
  check that fails when `node_modules` is absent from the archive.

Whichever is chosen, add a check that **fails loudly** rather than shipping a zip
without dependencies — this project has already found three guards that silently
no-oped, and a missing dependency that only manifests as "no events extracted" is
the same shape.

### The `@aws-sdk` declarations, which are the other half of this
`src/lambda/calendar/package.json` also declares `@aws-sdk/client-dynamodb`,
`@aws-sdk/client-kms` and `@aws-sdk/lib-dynamodb`. Those are **bundled by the
`nodejs24.x` runtime** — `terraform/lambda_calendar.tf` says so explicitly — so
they do not need to be shipped.

This is unresolved residue from an earlier mistake of mine, and the record should
state it plainly: during TASK-004 I told the coder the runtime did **not** bundle
the AWS SDK. It does. The coder declared the three packages on my instruction,
then flagged the contradiction against the terraform comment rather than
"fixing" the comment. I corrected the record but never removed the declarations,
and TASK-007's author flagged them again rather than silently deleting another
ticket's decision — correctly.

Now that something actually runs `npm install`, the declarations stop being
harmless: they pull roughly tens of megabytes of AWS SDK into the zip for no
benefit, against a 250MB unzipped Lambda limit, and slow every deploy.

Decide deliberately and record the reason:
- **remove** them, relying on the runtime's bundled copy (matches the terraform
  comment and keeps the zip small); or
- **keep** them, pinning the SDK version independently of the runtime's, and
  update the terraform comment so it no longer contradicts the manifest.

Either is defensible. What is not defensible is leaving the manifest and the
comment disagreeing, which is the state today.

## Impact If Not Fixed
The first real deployment produces a calendar that finds nothing. Gmail
retrieval works, the scan reports success, and every extraction is recorded as
failed — so the symptom is an empty calendar with no error, which is
indistinguishable from "the school sent no dated emails". Diagnosing it means
reading per-message extraction records in CloudWatch, which nobody will do first.

The secondary cost is the zip. If the install runs while the three `@aws-sdk`
declarations remain, the package grows by roughly an order of magnitude for
dependencies the runtime already provides, pushing toward the 250MB unzipped
limit and lengthening every deploy — and it does that silently too.

There is no security consequence.

## Acceptance Criteria
- [ ] The deployment package contains `@anthropic-ai/sdk` and `zod` — asserted by
      a test or preflight check against the archive contents, not by inspection.
- [ ] Packaging without dependencies **fails loudly** rather than producing a zip
      that boots and degrades.
- [ ] The install is triggered by the dependency manifest changing, not by a
      human remembering.
- [ ] The source tree is not left dirty by the packaging step (or the staging
      directory is gitignored).
- [ ] A decision is recorded on the three `@aws-sdk` declarations — removed, or
      kept with the terraform comment corrected — with the reason stated in the
      manifest or the terraform.
- [ ] `terraform/lambda_calendar.tf`'s comment about bundled SDKs and
      `src/lambda/calendar/package.json` no longer contradict each other.
- [ ] `terraform validate` still reports `error_count == 0` (4 pre-existing
      provider deprecation warnings are expected and must not be asserted away).
- [ ] The existing terraform env-var and IAM assertions still pass.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The deployment package carries its runtime dependencies
  Scenario: The archive contains the Anthropic SDK
    Given the packaging step has run
    When the archive contents are inspected
    Then @anthropic-ai/sdk and zod are present

  Scenario: A dependency-less package is refused
    Given node_modules is absent
    When packaging runs
    Then it fails with a message naming the missing dependencies

  Scenario: The install is manifest-triggered
    Given package.json changes
    When terraform plans
    Then the install is re-run

  Scenario: The manifest and the terraform comment agree
    Given src/lambda/calendar/package.json and terraform/lambda_calendar.tf
    Then neither claims something the other contradicts about bundled SDKs
```

## Additional Context
