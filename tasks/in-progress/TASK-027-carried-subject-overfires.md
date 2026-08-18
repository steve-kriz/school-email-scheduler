---
id: TASK-027
title: Runbook guard over-fires — the carried-subject path never checks the carried verb's object
status: testing
created: 2026-08-18T02:15:00Z
updated: 2026-08-18T02:35:29Z
review-of: TASK-024
activities: [{"activity":"code","model":"claude-opus-5","note":"deviated from ticket instruction with cause: literal after-only rule breaks 3 TASK-024 true positives whose object is "the value". Implemented intent via SECRET_ANAPHOR + priorClause as antecedent gate. 11-case corpus verified by orchestrator. Found 2 of 23 CREATE_VERB branches unpinned (makes?, sets? up) - pre-existing; orchestrator 21-word sweep had missed them"}]
---

## Description
TASK-024 closed the sentence-split bypass by carrying the Terraform subject
across one clause boundary. The carry gate itself is tight — it fires only when
the verb's own clause is nothing but a back-referring pronoun plus an optional
adverb/auxiliary. The **object** test is not.

`tests/e2e/check-oauth-config.test.js:110-112`:

```js
const secretIsTheObject =
  /\bsecrets?\b/i.test(after.slice(0, OBJECT_WINDOW)) ||
  /\bsecrets?\b/i.test(before.slice(-OBJECT_WINDOW)) ||
  (carriesTerraformSubject && /\bsecrets?\b/i.test(priorClause));
```

The third branch is satisfied when the **previous** clause mentions a secret. It
never inspects what the carried verb actually operates on. So any sentence of the
shape *"Terraform … secret. It [adverb] {creates|provisions|makes|sets up}
&lt;anything&gt;."* is reported as a false claim, whatever the real object is.

Verified by lifting `terraformCreatesSecretClaimsIn` out of the test file and
running it against the real runbook plus one appended sentence:

```
clean    baseline (real runbook, unmodified)
FLAGGED  "Terraform reads this secret. It then creates the Lambda execution role."
FLAGGED  "Terraform reads the secret. It also creates the DynamoDB table."
FLAGGED  "Terraform reads the secret. It also creates the KMS key."
FLAGGED  "Terraform handles this secret. It provisions the value for you."   <- correct
clean    "Terraform reads the secret. It provisions nothing."                <- correct
```

The reported clause for the first case is
`Terraform reads this secret. It then [creates] the Lambda execution role`.

The last two lines matter: the guard's true-positive and denial behaviour are
both correct, and this ticket must not weaken either. The defect is confined to
the object test on the carried path.

All three false positives are **accurate documentation**. Terraform in this
project really does create the Lambda execution role, the DynamoDB tables and
the KMS CMK — `terraform/lambda_calendar.tf`, `dynamodb_calendar_connections.tf`,
`dynamodb_calendar_events.tf` and `kms_calendar.tf` are all in the repository.
The runbook has every reason to say so, and the secret is the document's main
subject, so a nearby secret mention is the normal case rather than a rare one.

Fix: require the secret to be the object of the **carried** verb, not merely
present in the prior clause — i.e. on the carried path test `after` (the text
following the verb) for `secrets?`, the same way the non-carried path does, and
drop the `priorClause` object branch. Keep the subject carry as it is; only the
object test changes. Then confirm the guard still catches
*"Terraform handles this secret. It provisions the value for you."*, which is the
case TASK-024 existed to close, and still ignores the denial form.

## Impact If Not Fixed
This guard's whole purpose is to stop a false ownership claim from returning to
the runbook, and it does that job. But a guard that also fails correct
documentation gets worked around. The failure mode is specific and likely: a
writer documenting what Terraform genuinely creates, in a sentence that follows a
secret mention with a pronoun subject, gets a red suite with a message asserting
the runbook contains a false claim — when it does not. The natural responses are
to reword until the guard is quiet, to add the sentence to an exclusion list, or
to delete the guard. The last of those reopens the original onboarding failure:
an operator following the doc hits `ResourceNotFoundException` on
`put-secret-value`, then a failed `terraform apply`, while the doc misdirects
them into searching Terraform for a resource that was never written.

There is no correctness or security consequence today — the real runbook is clean
and the suite is green. The cost of leaving it is that the guard becomes
untrustworthy exactly when someone extends the document, which is the moment it
needs to be trusted.

## Acceptance Criteria
- [ ] On the carried path, the secret must be the object of the carried verb;
      the `priorClause` object branch is removed.
- [ ] `"Terraform reads this secret. It then creates the Lambda execution role."`
      is **not** reported.
- [ ] `"Terraform reads the secret. It also creates the DynamoDB table."` is
      **not** reported.
- [ ] `"Terraform reads the secret. It also creates the KMS key."` is **not**
      reported.
- [ ] `"Terraform handles this secret. It provisions the value for you."` **is**
      still reported — the TASK-024 bypass stays closed.
- [ ] `"Terraform reads the secret. It provisions nothing."` is still **not**
      reported — the denial path is unchanged.
- [ ] The four always-on ownership-claim guards still pass against the real
      runbook.
- [ ] All 21 `CREATE_VERB` tenses remain pinned: removing any one still turns the
      suite red (re-verify by sweep, do not assume).
- [ ] The two documented-open bypass shapes remain pinned to their current
      not-caught behaviour.
- [ ] A false-positive fixture table covers at least the three sentences above,
      so a future re-loosening of the object test turns the suite red.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The ownership guard does not fire on correct documentation
  Scenario Outline: Terraform creating something that is not the secret is allowed
    Given a runbook copy containing "<sentence>"
    When terraformCreatesSecretClaimsIn is called on it
    Then no claim is reported
    Examples:
      | sentence                                                                 |
      | Terraform reads this secret. It then creates the Lambda execution role.  |
      | Terraform reads the secret. It also creates the DynamoDB table.          |
      | Terraform reads the secret. It also creates the KMS key.                 |

  Scenario: The sentence-split claim TASK-024 closed stays closed
    Given a runbook copy containing "Terraform handles this secret. It provisions the value for you."
    When the guard runs
    Then the claim is reported

  Scenario: A denial is still not a claim
    Given a runbook copy containing "Terraform reads the secret. It provisions nothing."
    When the guard runs
    Then no claim is reported

  Scenario: Re-loosening the object test is caught
    Given a build whose carried path accepts a secret mention in the prior clause
    When the suite runs
    Then at least one test fails
```

## Additional Context
