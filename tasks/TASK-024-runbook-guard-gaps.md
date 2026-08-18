---
id: TASK-024
title: Runbook guard gaps — unpinned verb list, owner guard matches non-owners, sentence-split bypass
status: in-progress
created: 2026-08-18T01:30:00Z
updated: 2026-08-18T01:33:30Z
review-of: TASK-018
agent: build-024
---

## Description
Three findings from the TASK-018 review, consolidated because all three live in
`tests/e2e/check-oauth-config.test.js` and all three concern the same guard: the
one preventing the false "Terraform creates the secret" claim from returning.

### 1. The ownership-verb test does not test the guard (the verb list is unpinned)
Lines 519–544, *"Then it catches false claims using ownership verbs"*, define a
throwaway local `OWNERSHIP_VERBS` regex, assert it matches three local example
strings, then re-assert `terraformCreatesSecretClaims() === []` — a duplicate of
the test at line 505. It never feeds `"Terraform manages the secret"` to the real
guard.

Be precise about what is and isn't broken here, because it is easy to
misdiagnose. The real guard **does** currently catch these verbs — verified by
mutation: appending `Terraform manages the secret for you.` to the runbook fails
the suite, as does the passive `The secret is owned and established by
Terraform.` What is missing is that **nothing pins the verb list**. Trim
`manage|own|establish` out of the real `CREATE_VERB` regex (line 40) and every
test still passes, because this test only ever exercises its own local copy.

Fix: delete the local regex and feed each ownership-verb phrasing through the
real `terraformCreatesSecretClaims()` against a temp doc copy containing the
claim, asserting it is reported. Cover active, passive, and future tense. That
way trimming the verb list turns the suite red.

### 2. The "names the owning stack" guard is satisfied by naming non-owners
The `namesOwner` check (line 566) passes if the runbook contains any of
`tf-basestack|basestack|tf-cloudinfra|operator-owned|out of band|manual
prerequisite`. But the runbook names `tf-cloudinfra` and `ohq-chatbot2`
specifically to record that they do **not** create the secret. So the guard is
satisfied by prose asserting the opposite of what it is checking for.

Consequence: a future rewrite could delete the `create-secret` step and leave
only "stack X does not create it" prose, and this guard would still pass — the
runbook could ship naming no actual owner while the AC guard reports green.

Fix: require the owner mention to be an affirmative ownership statement, not a
bare substring. Either scope the match to a dedicated "Who creates the secret"
section and require an affirmative clause within it, or require the sentence
containing the stack name to be free of negation. Prove it with a fixture whose
only stack mentions are negative, asserting the guard fails.

### 3. A false claim split across two sentences bypasses the guard
`terraformCreatesSecretClaims()` splits on `.;:!?` and analyses within a single
clause, so a claim whose Terraform subject and create-verb sit in separate
sentences is never flagged — e.g. *"Terraform handles this secret. It provisions
the value for you."*

TASK-018 left this open deliberately, on the reasoning that the always-on
positive assertion ("Terraform only reads") is a backstop. The review confirmed
that backstop works **only** when the positive sentence is also removed; a
sentence-split claim that leaves the positive sentence in place trips nothing —
so the runbook would then contain both a true and a false statement, with the
false one unguarded.

Fix, choosing whichever you can make reliable: carry the subject across a
sentence boundary when the following sentence opens with a pronoun referring
back to it (`It`/`This`/`That`), or add a contradiction check asserting the
runbook does not simultaneously claim Terraform only reads and that it
creates/provisions. If neither is reliable enough to avoid false positives on
legitimate prose, say so explicitly and leave it — a documented, tested boundary
is acceptable; an undocumented one is not.

## Impact If Not Fixed
The guard exists because the false claim caused a concrete onboarding failure:
an operator following the runbook hits `ResourceNotFoundException` on
`put-secret-value` and then a failed `terraform apply`, while the doc misdirects
them into searching Terraform for a resource that was never written. Each gap
above is a path by which that claim can return with the suite green — a trimmed
verb list, a rewrite that names only non-owners, or a claim split across two
sentences. The third is the most likely in practice, because ordinary editing
splits sentences all the time.

## Acceptance Criteria
- [ ] The ownership-verb test feeds each phrasing through the real
      `terraformCreatesSecretClaims()`, not a local regex copy.
- [ ] Active, passive and future-tense ownership claims are each asserted to be
      reported by the real guard.
- [ ] Removing `manage`, `own` or `establish` from the real `CREATE_VERB` regex
      makes the suite fail — verified by mutation.
- [ ] The duplicate `terraformCreatesSecretClaims() === []` assertion at lines
      519–544 is removed (it is already covered at line 505).
- [ ] The `namesOwner` guard requires an affirmative ownership statement and is
      not satisfied by prose naming a stack as a non-owner.
- [ ] A fixture whose only stack mentions are negative makes the `namesOwner`
      guard fail.
- [ ] Deleting the `create-secret` step while naming no owner still fails at
      least one always-on assertion.
- [ ] The sentence-split bypass is either closed and proven with a fixture, or
      documented in a comment naming the exact bypass shape and why it was left.
- [ ] No new assertion is computed-but-unasserted, and none matches a scope
      broader than intended.
- [ ] No real credential is introduced; test fixtures remain obvious dummies.
- [ ] The full suite passes under `npm test`.

## Cucumber Tests
```gherkin
Feature: The runbook ownership guard cannot be trimmed or bypassed
  Scenario Outline: An ownership claim is reported by the real guard
    Given a runbook copy containing "<claim>"
    When terraformCreatesSecretClaims is called on it
    Then the claim is reported
    Examples:
      | claim                                              |
      | Terraform manages the secret for you.              |
      | The secret is owned and established by Terraform.  |
      | Terraform will provision the secret.               |

  Scenario: Trimming the verb list turns the suite red
    Given a build whose CREATE_VERB regex omits manage, own and establish
    When the ownership-verb test runs
    Then it fails

  Scenario: Naming a stack as a non-owner does not satisfy the owner guard
    Given a runbook whose only stack mentions say those stacks do not create it
    When the namesOwner guard runs
    Then it fails

  Scenario: Deleting the create-secret step without naming an owner fails
    Given a runbook copy with the create-secret step removed and no owner named
    When the suite runs
    Then at least one always-on assertion fails

  Scenario: A sentence-split claim is caught or documented
    Given a runbook copy containing "Terraform handles this secret. It provisions the value for you."
    When the guard runs
    Then either the claim is reported, or a comment documents this exact bypass

  Scenario: No fixture resembles a real credential
    Given the test fixtures
    Then every credential-shaped value is an obvious dummy
```

## Additional Context
