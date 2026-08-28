---
id: TASK-030
title: The ownership guard misses a false claim that paraphrases "the secret"
status: done
created: 2026-08-18T02:52:00Z
updated: 2026-08-28T21:37:59.000Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T01:58:00.000Z","finishedAt":"2026-08-26T02:50:00.000Z","note":"Implemented via INVERSION (the ticket second option) rather than a synonym list, with the reasoning stated: a synonym list for the secret can never be complete and would need pinning word by word forever. The object test now asks three questions with REPORT as the default - provably the secret -> claim; provably some other named resource -> not a claim; unclassifiable -> CLAIM, REPORTED (fail closed), replacing the old if (!secretIsTheObject) continue. NON_SECRET_RESOURCE_TERMS frozen at nine head nouns with resource deliberately ABSENT so the AC-required Terraform creates the resource case still reports; irregular plurals deliberately unmatched because unmatched means reported. objectPhraseOf trims at the first preposition so a trailing adjunct cannot excuse the claim. terraformCreatesSecretClaimsIn THROWS on an empty term list, because an empty list would compile to a pattern matching everywhere and silently disable the guard - exactly the no-op-guard defect class this board keeps finding. AVOIDED THE TASK-099 TRAP DELIBERATELY: the per-term pinning sweep runs IN MEMORY through a new parameter rather than .replace() on file text, and each removal asserts it ACTUALLY APPLIED (length changed, term gone) before trusting either result. Sweep asserts the term set and the fixture set are equal, so adding a term without a fixture fails. check-oauth-config.test.js 88/88 (was 77). Full suite 1601 with only the two known unrelated failures, identical to its baseline. Preserved behaviours enumerated and still green: the 5 TASK-027 carried-other-object false positives, the 2 documented-open bypasses still NOT caught, and the documented over-fire still firing. Guard now over-fires BY DESIGN on unrecognised objects - the ticket intent, pairing with TASK-031. Token/cost telemetry not correlated; 79933 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-26T02:50:00.000Z","finishedAt":"2026-08-26T03:05:00.000Z","note":"RED - one genuine defect, fix loop attempt 1 of 3. The empty-list guard the coder added is defeated one level down: nonSecretTerms [\"\"] passes the Array.isArray && length===0 check, then nonSecretResourcePattern compiles the alternative e?s? which matches at EVERY word boundary, so every object classifies as some other named resource, step 3 is never reached and the guard returns [] for a runbook literally saying Terraform creates the credential for this stack. ORCHESTRATOR INDEPENDENTLY CONFIRMED by rebuilding the pattern function: [\"\"] -> \b(?:e?s?)\b matches the thingamajig TRUE; [\"   \"] likewise; and critically [\"\",\"role\"] ALSO matches everywhere, so one blank entry in an otherwise valid list silently disables the guard. [], null, role, 42, {} and a Set are all correctly rejected today. Fix is one line in the validation: reject entries that are not non-blank strings. 1724 tests 1721 pass 3 fail = 1 defect + 2 known baseline. Delivered tests/e2e/ownership-guard-paraphrase.test.js (86, all green), tests/unit/ownership-guard-object-classification.test.js (37, 36 green) and tests/helpers/ownership-guard-source.mjs. HARNESS QUALITY: the helper loads the guard out of the REAL source text rather than pasting a copy, explicitly rejecting the repo existing habit (mutation-sweep.test.js pastes parseSecretsAccesses) because a copy can drift; it also throws if a requested mutation transform changes nothing. 4 mutations EXECUTED on disk: adding a term with no fixture went 10 red PROVING the set-equality invariant; reverting step 3 to the old continue went 36 red; neutering objectPhraseOf reddened all 9 adjunct scenarios; dropping a CREATE_VERB branch reddened the parse test. Honestly listed 2 mutations it reasoned about but did NOT execute. ADDED A PIN THAT DID NOT EXIST: the guard pinned its 23 CREATE_VERB branches by fixture only, never by rebuilding the alternation - the new sweep parses the real declaration and rebuilds it with one branch removed, so a 24th branch added without a fixture fails. Runbook baseline safety independently re-proved by disabling step 2 entirely and still getting [], with the reduced list shown live so the [] cannot be an inert no-op. CRLF-checked: re-checked out its three files so git converted them and re-ran to identical counts. docs/google-oauth-setup.md sha256 compared before/after to prove no writes. Token/cost telemetry not correlated; 88803 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T03:05:00.000Z","finishedAt":"2026-08-26T03:12:00.000Z","note":"FIX attempt 1 of 3 SUCCEEDED (491d995), one validation block, no test files touched. Rejects any nonSecretTerms entry that is not a non-blank string, with the offending index and value named in the throw. DELIBERATE PLACEMENT CALL: validation stays in the CALLER, not in nonSecretResourcePattern, because the tester deliberately PINS the builder degenerate behaviour at ownership-guard-object-classification.test.js:138-148 as the visible statement of the hazard - hardening the builder would have turned that test red. A comment records this so the next person does not helpfully move it. AUDITED THE SAME SHAPE ELSEWHERE by execution: objectPhraseOf can return an empty string when the text after the verb starts with a splitter, and it FAILS CLOSED (a validated pattern cannot match empty, so the object is unclassifiable and therefore reported) - verified with two real sentences. Established the general property that EMPTINESS IS THE ONLY WAY an entry can widen the pattern, since escapeRegex reduces every other entry to a literal, so rejecting blanks makes the compiled pattern structurally incapable of matching everywhere. Non-string entries now throw the explanatory error instead of a bare TypeError. Degenerate sweep EXECUTED through the tester own loader: [\"\"], [\"   \"], [\"\",\"role\"], [\"role\",\"\"], [], null, string, 42, object, Set, [null], [42], [role,42] all throw. Suite 1724 tests 1722 pass 2 fail, exactly the orchestrator predicted result, the two being the known unrelated TASK-098 and TASK-099. ALSO REPORTED A NEW FLAKE honestly rather than burying it: terraform-resolver.test.js:80 and terraform-scaffold.test.js contend over terraform validate in the same directory under parallel node --test (30s timeout); serial re-run 28/28 - raised as TASK-103. Token/cost telemetry not correlated; 102632 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-28T21:27:00.000Z","finishedAt":"2026-08-28T21:37:59.000Z","note":"GREEN, re-test after fix attempt 1 of 3. Suite 1732 tests 1730 pass 2 fail, the two being the known unrelated TASK-098 and TASK-099; no third failure and the TASK-103 terraform flake did not occur. Baseline 1724 plus 8 added tests. PROVED THE FIX IS NOT A NO-OP BY REVERTING IT: deleted the 24-line validation block on disk (asserting 549 chars actually went), re-ran, 8 tests red, and a direct probe showed the degenerate lists NO LONGER THROW and the guard silently returns [] for Terraform creates the credential for this stack; restored byte-identical. Verified by execution not reading: all 13 degenerate shapes throw naming the offending index; every paraphrase AC reports across direct, carried and passive forms; the 3 TASK-027 false positives and the provisions-nothing sentence still not reported; per-term pinning proved BOTH directions on disk with mutation-applied assertions (removing each of the 9 terms reddens 5 to 8 tests, adding an unpinned queue reddens 2); all 23 CREATE_VERB branches pinned and an unpinned 24th reddens 1. Runbook sha256 identical before and after every run. CRLF re-checked: file re-checked-out so git converted it, 671 CRLF 0 bare LF, suite re-ran to identical counts. ADDED THE COVERAGE THE FIX ACTUALLY NEEDED: the existing switched-off scenario only covered wholly-unusable lists, never the one-bad-entry-in-a-non-empty-array shape the fix addresses; new scenario covers those 7 cases plus a control proving the same list minus the blank is accepted and still reports. Product code untouched, git diff against 491d995 for the guard file is empty. Merged to master. Token/cost telemetry not correlated; 63230 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
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
