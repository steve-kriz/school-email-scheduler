---
id: TASK-030
title: The ownership guard misses a false claim that paraphrases "the secret"
status: in-progress
created: 2026-08-18T02:52:00Z
updated: 2026-08-26T01:58:00.000Z
agent: build-030
review-of: TASK-027
---

## Description
`terraformCreatesSecretClaimsIn` decides whether the claim's object is the secret
by looking for the literal token `secret` or one of five anaphors
(`value`/`values`/`content(s)`/`payload`/`version`) — `SECRET_ANAPHOR` at
`tests/e2e/check-oauth-config.test.js:93-94`, used in `secretIsTheObject` at
`:127-133`. A genuine false ownership claim that paraphrases "the secret" with a
synonym is reported on **neither** path.

Verified by lifting the guard out and running it against the real runbook plus one
appended sentence:

```
MISSED  Terraform handles this secret. It creates the credential for you.
MISSED  Terraform handles this secret. It creates the entry for you.
MISSED  Terraform handles this secret. It provisions the item for you.
MISSED  Terraform creates the credential for this stack.
MISSED  Terraform provisions the config entry for this stack.
```

The last two matter most: they are on the **direct, non-carried** path, are
single sentences, and are exactly the shape of the claim that caused the original
onboarding failure. They are simply not caught.

Be accurate about provenance, because this is easy to mis-attribute. This is
**not a regression introduced by TASK-027.** The non-carried path has always keyed
on the literal token `secret`. What TASK-027 changed is that its carried path used
to fire whenever the *prior* clause mentioned a secret, which accidentally caught
some synonym claims as a side effect of being over-broad — the same over-breadth
that produced the false positives TASK-027 was written to remove. So TASK-027
correctly traded incidental recall for precision; this ticket is the bill for
that trade, and the anaphor set is currently the only compensating mechanism.

The always-on positive-ownership assertions (`:938-962`) are a partial backstop
only: they check that *an* owner is named, not that no false claim exists. A
runbook can name the operator as owner in one section and falsely credit
Terraform with creating "the credential" in another, and pass both.

Fix direction — pick whichever you can make reliable, and say why:
- Extend the object test to a synonym set for the secret (`credential(s)`,
  `entry`, `config entry`, `item`, `resource`, `secret value`), the same way
  `SECRET_ANAPHOR` works. Cheapest, but it is another word list to keep current,
  so it must be **pinned per synonym** the way `CREATE_VERB`'s 23 branches now are
  — every entry's removal must redden a test.
- Or invert the test: on a sentence whose subject is Terraform and whose verb is a
  create/ownership verb, require the object to be **provably something else**
  (a named non-secret resource: role, table, key, bucket, log group, alias,
  policy, manifest, schema) rather than requiring it to be provably the secret.
  That fails safe — an unrecognised object is reported rather than ignored — which
  is the correct direction for a guard. It will over-fire more, so it pairs
  naturally with TASK-031.

**A guard that cannot decide must report the claim, not swallow it.** That is the
opposite of the current default and is the substance of this ticket.

## Impact If Not Fixed
The guard exists to keep one specific false statement out of the operator runbook,
because that statement caused a concrete onboarding failure: the operator hits
`ResourceNotFoundException` on `put-secret-value`, then a failed `terraform
apply`, while the doc misdirects them into searching Terraform for a resource
that was never written.

Today a writer only has to say "credential" or "config entry" instead of "secret"
— an entirely natural paraphrase, and one a technical writer would make for
readability — and the false claim ships with the suite green. The guard reports
success while failing at its single job. Every other defect found in this file has
been a guard that over-fires or a test that verifies nothing; this is the first
that lets the actual regression through, which makes it the most serious of the
set even though nothing is failing today.

The mutation that goes undetected: rewrite any true ownership claim as
`"Terraform creates the credential for this stack."` — green suite, false claim in
the runbook.

## Acceptance Criteria
- [ ] `"Terraform creates the credential for this stack."` is reported.
- [ ] `"Terraform provisions the config entry for this stack."` is reported.
- [ ] `"Terraform handles this secret. It creates the credential for you."` is
      reported.
- [ ] The same holds for `entry`, `item` and `resource` as the object.
- [ ] Whichever mechanism is chosen, each synonym or non-secret-resource term is
      **individually pinned**: removing any one entry reddens at least one test.
      Verify by sweep, asserting each mutation actually applied before trusting a
      green result.
- [ ] All four TASK-024/027 true positives still fire.
- [ ] The three TASK-027 false positives (Lambda execution role, DynamoDB table,
      KMS key) are still **not** reported.
- [ ] `"Terraform reads the secret. It provisions nothing."` is still not reported.
- [ ] The real runbook still passes unchanged.
- [ ] All 23 `CREATE_VERB` branches remain pinned.
- [ ] Where the guard cannot determine the object, it reports rather than
      swallows — stated in a comment and proven by a fixture.
- [ ] Fixtures stay in memory; no test writes to `docs/google-oauth-setup.md`.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A false ownership claim is caught however the secret is named
  Scenario Outline: A paraphrased object is still a claim
    Given a runbook copy containing "<sentence>"
    When terraformCreatesSecretClaimsIn is called on it
    Then the claim is reported
    Examples:
      | sentence                                                          |
      | Terraform creates the credential for this stack.                  |
      | Terraform provisions the config entry for this stack.             |
      | Terraform handles this secret. It creates the credential for you. |
      | Terraform handles this secret. It creates the entry for you.      |

  Scenario Outline: Correct documentation is still not a claim
    Given a runbook copy containing "<sentence>"
    When the guard runs
    Then no claim is reported
    Examples:
      | sentence                                                                |
      | Terraform reads this secret. It then creates the Lambda execution role. |
      | Terraform reads the secret. It also creates the DynamoDB table.         |
      | Terraform reads the secret. It also creates the KMS key.                |
      | Terraform reads the secret. It provisions nothing.                      |

  Scenario: Removing any synonym from the list is caught
    Given a build with one synonym removed from the object test
    When the suite runs
    Then at least one test fails

  Scenario: An undeterminable object is reported, not swallowed
    Given a claim whose object the guard cannot classify
    When the guard runs
    Then the claim is reported
```

## Additional Context
