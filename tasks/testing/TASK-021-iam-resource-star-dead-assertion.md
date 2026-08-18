---
id: TASK-021
title: The IAM least-privilege test computes a result and never asserts on it
status: pr-review
created: 2026-08-18T00:30:00Z
updated: 2026-08-18T01:17:11Z
review-of: TASK-003
activities: [{"activity":"code","model":"claude-opus-5","tokens":56348},{"activity":"test","model":"claude-haiku-4-5","tokens":60817,"result":"pass"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T01:11:50Z","finishedAt":"2026-08-18T01:14:42Z","tokens":79775,"result":"pass","tests":401,"note":"rework: Sid-first assertion verified by execution"}]
---

## Description
`tests/unit/calendar-lambda-terraform.test.js` (around lines 133–154) implements
the acceptance criterion *"No IAM statement uses `Resource = "*"` except
CloudWatch Logs and the `ec2:*NetworkInterface*` statement"*. It computes:

```js
const allResourceStarLines = policyText
  .split('\n')
  .filter(line => line.includes('Resource = "*"'));
```

…and then **never asserts on `allResourceStarLines`**. The test only checks that
the `CloudWatchLogs` and `VPC` statement strings exist and that
`statementCount >= 5`. So the criterion has no test behind it at all.

This is the second dead assertion found in this codebase (the first was
`!schemaSection.includes('refreshToken\s')`, now covered by TASK-017). Both share
a shape: a value is computed, reads like coverage, and is never asserted.

The policy in `lambda_calendar.tf` is currently **correct** — only the
`VPCNetworkInterfaces` statement uses literal `Resource = "*"`, while CloudWatch
Logs uses the scoped `arn:aws:logs:*:*:*`, and the DynamoDB, KMS and Secrets
Manager statements are all scoped to specific ARNs. So this is a coverage gap,
not a live vulnerability.

Fix it properly:
- Parse the policy's statements rather than scanning raw lines, so each
  `Resource = "*"` occurrence is attributed to the `Sid` it belongs to.
- Assert that the set of Sids using an unscoped `Resource = "*"` is **exactly**
  the allowed set (the VPC/network-interface statement), rather than asserting a
  count or a mere presence.
- Assert positively that the DynamoDB, KMS and Secrets Manager statements are
  each scoped to a specific ARN reference, and that KMS is scoped to exactly the
  calendar CMK.
- Prove the test discriminates: with a mutated fixture that broadens the KMS
  statement to `Resource = "*"`, the assertion must fail. Write the fixture to a
  temp path and clean it up in a `finally`; never modify the real `.tf`.

While you are in this file, check whether any **other** assertion in it computes
a value it never uses, and fix those too — report each one you find. Do not
refactor assertions that are already sound.

**Also in scope: a third dead-code instance, in a different file.**
`tests/e2e/npm-scripts.test.js` defines a `parseCounts` helper (around lines
38–45) that parses `# tests` / `# pass` totals out of a `node --test` stdout with
`line.match(/^# tests (\d+)/)` and `parseInt`. It is **never called**. It was
written toward a count-equality assertion that was ultimately not needed — the
same file's subdirectory-discovery check covers that defect class better — so the
helper is leftover scaffolding.

Either delete `parseCounts`, or use it for something that earns its place. One
genuinely useful use, if you want to keep it: assert that
`npm run test:unit` and `npm run test:e2e` totals **sum** to the `npm test`
total, which is a real invariant the discovery check does not cover (it would
catch a file matched by one invocation but not another, e.g. a stray
`.test.mjs` extension or a nested directory only one path walks). If you keep it,
it must be exercised; if you delete it, say so. Do not leave it defined and
unused.

Note: TASK-020 also came out of the TASK-003 review but touches
`src/lambda/calendar/index.mjs` and `tests/e2e/calendar-lambda.test.js`, so it
does not overlap this ticket's file and the two may run concurrently.

## Impact If Not Fixed
The only automated guard on this Lambda's least-privilege IAM scoping does
nothing. A future edit that broadens the KMS statement to `Resource = "*"` —
letting the function decrypt with any key in the account — or that broadens the
Secrets Manager or DynamoDB statements, would pass CI green. Because the
function holds the decryption path for every user's Gmail refresh token, an
over-broad KMS grant is the single most damaging scope regression available
here, and it is currently unguarded.

## Acceptance Criteria
- [ ] The test asserts on the set of statements using an unscoped
      `Resource = "*"`, not merely that certain strings are present.
- [ ] That set is asserted to be **exactly** the allowed one (the
      VPC/network-interface statement); an extra unscoped statement fails the
      test.
- [ ] The DynamoDB statement is asserted to reference both table ARNs and the
      events-table `/index/*` ARN.
- [ ] The KMS statement is asserted to be scoped to exactly the calendar CMK
      ARN.
- [ ] The Secrets Manager statement is asserted to be scoped to the app-config
      secret ARN.
- [ ] A mutated fixture that broadens the KMS statement to `Resource = "*"`
      makes the assertion fail, proving it discriminates.
- [ ] Temp fixtures are cleaned up even when a test fails; the real `.tf` files
      are never modified by a test.
- [ ] `allResourceStarLines` — or any other computed-but-unasserted value in this
      file — no longer exists unused.
- [ ] Any other dead assertion found in this file is fixed and reported.
- [ ] The full suite passes under `npm test`.

## Cucumber Tests
```gherkin
Feature: Least-privilege IAM scoping is actually guarded
  Scenario: Only the VPC statement is unscoped
    Given the calendar lambda IAM policy
    When the statements using Resource = "*" are collected
    Then that set contains only the network-interface statement

  Scenario: Broadening KMS turns the suite red
    Given a mutated copy whose KMS statement uses Resource = "*"
    When the scoping assertion runs
    Then it fails

  Scenario: KMS is pinned to the calendar key
    Given the calendar lambda IAM policy
    Then its KMS statement resource is exactly the calendar CMK ARN

  Scenario: DynamoDB covers the index ARN
    Given the calendar lambda IAM policy
    Then its DynamoDB resources include both table ARNs and the events index ARN

  Scenario: Secrets Manager is pinned to the app-config secret
    Given the calendar lambda IAM policy
    Then its Secrets Manager resource is the app-config secret ARN

  Scenario: No computed value is left unasserted
    Given tests/unit/calendar-lambda-terraform.test.js
    Then no variable is assigned from a filter or match and then never used

  Scenario: Fixtures do not leak
    Given a fixture-based test that fails mid-run
    When the suite finishes
    Then no temp fixture remains
    And the real terraform files are unmodified
```

## Additional Context
