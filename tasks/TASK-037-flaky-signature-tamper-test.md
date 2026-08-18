---
id: TASK-037
title: The signature-tamper test fails ~6% of runs because it flips base64url padding bits
status: todo
created: 2026-08-18T03:45:00Z
updated: 2026-08-18T03:45:00Z
review-of: TASK-004
---

## Description
`tests/e2e/calendar-auth-routes.test.js:1181` — *"should reject signatures
differing only in final byte"* — is intermittently red. It was surfaced during
the TASK-025 build, which saw it fail in a full-suite run and pass in isolation,
and reported it as *"a load-sensitive timing assertion, pre-existing and
unrelated to this ticket"*.

**Pre-existing and unrelated is right. Load-sensitive timing is not the cause.**
The test is deterministic given its input; the input just varies per run.

The tamper is:

```js
const [payload, signature] = validToken.split('.');
const tamperedSig = signature.slice(0, -1) + (signature[signature.length - 1] === 'A' ? 'B' : 'A');
```

The session signature is an HMAC-SHA256 — 32 bytes, encoded as **43 base64url
characters**. 43 × 6 = 258 bits for 256 bits of data, so the final character
carries 4 significant bits plus **2 padding bits**. Characters differing only in
those low 2 bits decode to identical bytes, in groups of four: `{A,B,C,D}`,
`{E,F,G,H}`, and so on.

So when the real signature's last character falls in `{A,B,C,D}`, the flip lands
inside the same group, `Buffer.from(tampered, "base64url")` equals
`Buffer.from(signature, "base64url")`, the signature is **genuinely valid**, the
route correctly returns 200 — and the test, which asserts 401, fails.

Measured over 20,000 generated tokens:

```
signature length (chars)               : 43
flips that decode to IDENTICAL bytes   : 1228 / 20000  (6.14%)
```

6.14% matches the predicted 4/64 exactly. The token varies run to run because
`createSessionToken` is called with a `Date.now()`-derived `nowSeconds`, so the
HMAC — and its last character — changes every second.

Fix: tamper the **decoded bytes**, not the base64url text. Decode the signature,
flip a bit in a byte, re-encode. Or flip a character in the middle of the string,
where all 6 bits are significant. Either way, assert as part of the test that the
tampered signature actually decodes to different bytes than the original — the
guard that would have caught this.

The sibling test *"should handle truncated signatures gracefully"* at `:1213`
should be checked for the same class of problem while you are in there.

## Impact If Not Fixed
About one run in sixteen fails, and the failure is maximally misleading. The
message reads as *"a tampered session signature was accepted"* — apparent
authentication bypass on the OAuth session boundary, the most security-sensitive
assertion in the project. Anyone who hits it will stop and investigate a
non-existent vulnerability. It has already cost one such investigation: it was
first attributed to timing and load, which is the wrong direction entirely.

The second cost is worse than the first. An intermittently-red security test
trains people to re-run the suite until it goes green, which is exactly the habit
that lets a *real* red result through. This project has spent seventeen findings
on assertions that pass when they should fail; an assertion that fails when it
should pass corrodes trust in the suite from the other end.

There is no defect in the production code. `signaturesMatch`,
`timingSafeEqual` and the 401 path are all correct and separately pinned — the
test is simply constructing a signature that is not actually tampered.

## Acceptance Criteria
- [ ] The tamper operates on decoded signature bytes, or on a character position
      where all 6 bits are significant.
- [ ] The test asserts the tampered signature decodes to **different** bytes than
      the original, before asserting the 401.
- [ ] The test passes on 200 consecutive runs with varying `nowSeconds`
      (a loop over generated tokens is acceptable and cheap).
- [ ] A token whose signature's last character is `A`, `B`, `C` or `D` is included
      explicitly as a fixture, since those are the cases that used to fail.
- [ ] `should handle truncated signatures gracefully` is checked for the same
      base64url-alignment problem and fixed if present.
- [ ] Reverting `signaturesMatch` to `===` still reddens the source assertion at
      `tests/unit/calendar-auth.test.js:789` — the existing coverage is not
      weakened.
- [ ] A genuinely tampered signature still yields 401, and a valid one still
      yields 200.
- [ ] The full suite passes on three consecutive runs.

## Cucumber Tests
```gherkin
Feature: A tampered session signature is rejected, and the tamper is real
  Scenario: The tamper changes the decoded bytes
    Given a valid session token
    When the signature is tampered
    Then the tampered signature decodes to different bytes than the original

  Scenario Outline: A tampered signature is rejected regardless of alignment
    Given a valid session token whose signature ends in "<lastChar>"
    When the tampered token is presented
    Then the response status code is 401
    Examples:
      | lastChar |
      | A        |
      | B        |
      | C        |
      | D        |

  Scenario: A valid signature is still accepted
    Given an untampered valid session token
    When it is presented
    Then the response status code is 200

  Scenario: The test is stable
    When the signature-tamper test runs 200 times with varying token inputs
    Then it passes every time
```

## Additional Context
