---
id: TASK-103
title: Two e2e files shell out to terraform validate in the same directory, so parallel node --test makes them contend and time out at 30s
status: todo
created: 2026-08-26T03:30:00.000Z
updated: 2026-08-26T03:30:00.000Z
---

## Description
`tests/e2e/terraform-resolver.test.js` and `tests/e2e/terraform-scaffold.test.js`
both run `terraform validate` against the **same** `terraform/` directory.
`node --test` executes test files in parallel, so the two invocations contend and
one can hang until it is killed.

Observed by TASK-030's fix coder, reported honestly rather than buried:

```
tests/e2e/terraform-resolver.test.js:80
  "terraform binary runs in the main terraform directory"
  terraform validate failed:        <-- empty stderr
  duration_ms: 30026                <-- 30s timeout
```

The failure also took down `terraform-scaffold.test.js`'s `error_count is 0`
assertion, giving a full-suite result of **1720/4** instead of the expected
1722/2. Re-running the two files **serially** gave **28/28 pass**, and the next
full run came back clean at 1722/2.

### This is probably the better explanation for an earlier anomaly
TASK-009's tester reported one uncharacterised full-suite run at **1714 pass / 4
fail** — exactly **two** extra failures over its baseline, the same shape as this
contention (one file times out, and it takes a second file's assertion with it).
That was provisionally recorded against TASK-099 as a possible line-ending race,
which now looks like the weaker hypothesis: terraform contention is concrete,
reproduced, and produces the same +2 signature. Neither is proven; this ticket
should settle it.

### Why it matters more than a normal flake
Both failures present as *terraform being broken* — an empty-stderr
`terraform validate failed` and a false `error_count != 0` — when terraform is
fine. This board has spent real time chasing exactly that class of misleading
signal (TASK-098's directory-argument bug and TASK-099's CRLF mutation were both
misread by three separate agents). A flake that impersonates a genuine
infrastructure failure will keep costing that time until it is fixed.

It is also **not** the same thing as TASK-037 (flaky signature tamper test), and
it is distinct from **TASK-057** (terraform-shelling tests sitting in the unit
suite) — though whoever fixes TASK-057 should read this first, since moving files
between tiers changes which of them run concurrently.

## Acceptance Criteria
- [ ] `terraform validate` invocations cannot contend: either the shelling tests
      are serialized against each other, or each runs against its own copied
      workspace directory, or the result is computed once and shared.
- [ ] The chosen mechanism is recorded with its reason.
- [ ] Running the full suite repeatedly (at least 5 consecutive runs) gives an
      identical pass/fail count every time, with the counts reported.
- [ ] A `terraform validate` failure caused by contention can no longer present as
      an empty-stderr "terraform validate failed" — if the command genuinely fails,
      the message says why.
- [ ] The 30s timeout is either justified in a comment or replaced with a bound
      that distinguishes "terraform is slow" from "terraform is blocked".
- [ ] No terraform assertion is weakened or skipped to achieve stability — in
      particular `error_count == 0` with its 4 expected deprecation warnings must
      still be asserted.
- [ ] Whether this also explains TASK-009's uncharacterised 1714/4 run is
      investigated and the finding recorded in TASK-099 either way.

## Cucumber Tests
```gherkin
Feature: Terraform-shelling tests are stable under a parallel runner
  Scenario: Repeated full-suite runs agree
    Given the full suite is run five times in a row
    When the pass and fail counts are compared
    Then every run reports the same counts

  Scenario: Two terraform tests do not block each other
    Given two test files that both invoke terraform validate
    When they run concurrently
    Then neither times out
    And both report a real validate result

  Scenario: A real terraform failure is still legible
    Given terraform validate genuinely fails
    When the test reports it
    Then the message names the cause rather than being empty
```

## Additional Context
