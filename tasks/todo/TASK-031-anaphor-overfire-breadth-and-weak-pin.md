---
id: TASK-031
title: The anaphor object test over-fires on a class of correct prose, and its residual is weakly pinned
status: todo
created: 2026-08-18T02:52:00Z
updated: 2026-08-18T02:52:00Z
review-of: TASK-027
---

## Description
Two low findings from the TASK-027 review, both in
`tests/e2e/check-oauth-config.test.js`.

### 1. The over-fire residual is a class, not a one-off
`SECRET_ANAPHOR` (`:93-94`) matches when the first noun after an optional
determiner is an anaphor word, even when that word modifies a different head
noun. TASK-027 pinned one residual — `"the payload schema"` (`:849-855`) — as an
acceptable boundary. It is representative rather than isolated. Verified by
execution:

```
OVER-FIRE  Terraform reads the secret. It also creates the content delivery bucket.
OVER-FIRE  Terraform reads the secret. It also creates the version manifest.
OVER-FIRE  Terraform reads the secret. It also creates the payload schema for the events table.
clean      Terraform reads the secret. It also creates the retention value for the log group.
```

All three over-fires are accurate documentation. The rule is position-sensitive —
`"the retention value"` correctly stays clean because the anaphor is not the
leading noun — so the exposed surface is precisely *"any object phrase whose
leading noun is `value`/`values`/`content(s)`/`payload`/`version`"*. Content
delivery buckets, version manifests and payload schemas are all ordinary
infrastructure nouns, and this project's runbook already discusses several stacks
and their resources.

Fix direction: require the anaphor to be the **head** of the object phrase rather
than merely its leading token — e.g. reject when the anaphor is immediately
followed by another noun (`payload schema`, `version manifest`, `content
delivery`). Coordinate with **TASK-030**, which pushes in the opposite direction
(catch more claims); if TASK-030 adopts the fail-safe inversion — report unless
the object is a recognised non-secret resource — this finding is subsumed and
should be closed as such rather than fixed twice.

### 2. The over-fire fixture is a weaker pin than its siblings
The `KNOWN_OVER_FIRE_FIXTURES` test (`:857-870`) asserts only
`claims.length > 0`. Its sibling fixtures — e.g. `CARRIED_VERB_OTHER_OBJECT_FIXTURES`
at `:730-733` — first assert the baseline runbook is claim-free, then assert the
appended sentence's effect.

Consequence: if the baseline ever regressed to emit a claim, this test would pass
for the wrong reason *and* simultaneously mask that the documented over-fire had
stopped firing. The mutation that goes undetected: any change that stops the
appended sentence firing, provided some unrelated baseline claim exists.

Fix: match the sibling pattern — assert the baseline is claim-free, and assert the
reported claim originates from the appended sentence (check the reported clause
text, not just the count).

## Impact If Not Fixed
Finding 1 is the failure mode TASK-027 was created to reduce, not eliminated but
narrowed. A writer documenting what Terraform genuinely creates gets a red suite
asserting the runbook contains a false claim, when it does not. The predictable
responses are to reword until the guard is quiet, add an exclusion, or delete the
guard — and deleting it reopens the onboarding failure it exists to prevent
(`ResourceNotFoundException` on `put-secret-value`, then a failed `terraform
apply`, with the doc misdirecting the operator). Over-firing is the *safe*
direction for correctness, which is why this is low rather than medium, but it is
the direction that erodes trust in the guard.

Finding 2 means the documented boundary can silently stop being exercised. A
boundary with a weak pin is only marginally better than a boundary in a comment,
and this file has already produced two assertions that passed regardless of the
code.

Neither is failing today and neither has a security consequence.

## Acceptance Criteria
- [ ] `"Terraform reads the secret. It also creates the content delivery bucket."`
      is not reported.
- [ ] `"Terraform reads the secret. It also creates the version manifest."` is not
      reported.
- [ ] `"Terraform reads the secret. It also creates the retention value for the
      log group."` is still not reported.
- [ ] The four TASK-024/027 true positives still fire, including
      `"It provisions the value for you."` where the anaphor **is** the head noun.
- [ ] The `KNOWN_OVER_FIRE_FIXTURES` test asserts the baseline runbook is
      claim-free before asserting the appended sentence's effect.
- [ ] It asserts the reported clause originates from the appended sentence, not
      merely that some claim exists.
- [ ] A baseline that emits an unrelated claim no longer lets that test pass for
      the wrong reason — verified by mutation.
- [ ] If TASK-030 adopts the fail-safe inversion, finding 1 is closed as subsumed
      with a note saying so, rather than fixed twice.
- [ ] The real runbook still passes unchanged.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The anaphor test matches the head noun, and its boundary is pinned
  Scenario Outline: An anaphor word modifying another noun is not a claim
    Given a runbook copy containing "<sentence>"
    When the guard runs
    Then no claim is reported
    Examples:
      | sentence                                                                     |
      | Terraform reads the secret. It also creates the content delivery bucket.     |
      | Terraform reads the secret. It also creates the version manifest.            |
      | Terraform reads the secret. It also creates the retention value for the log group. |

  Scenario: An anaphor as the head noun is still a claim
    Given a runbook copy containing "Terraform handles this secret. It provisions the value for you."
    When the guard runs
    Then the claim is reported

  Scenario: The over-fire fixture cannot pass for the wrong reason
    Given a baseline runbook that emits an unrelated claim
    And the appended over-fire sentence no longer fires
    When the over-fire test runs
    Then it fails
```

## Additional Context
