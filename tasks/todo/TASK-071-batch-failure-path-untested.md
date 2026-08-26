---
id: TASK-071
title: The per-message failure path that keeps one bad email from killing the batch is untested
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: medium
---

## Description
`src/lambda/calendar/backend/anthropic.mjs:1140-1155` holds the per-message
catch that keeps one unreadable email from killing an entire user's scan. It
sets `EXTRACTION_STATUS.FAILED`.

`EXTRACTION_STATUS.FAILED` is **never asserted in either test file**. The e2e
batch case (`tests/e2e/calendar-extraction-flow.test.js:216-291`) mixes
extracted / not-school / skipped-sender outcomes only — never a throwing
message.

The ticket's own Cucumber scenario is explicit about this guarantee: "A refusal
is recorded and the scan continues ... the first and third emails are still
extracted" (ticket lines 227-231). Nothing covers it.

## Impact If Not Fixed
If that catch is narrowed or removed, a single message that exhausts its
retries aborts the whole user's scan, and no test detects it. The resilience
guarantee the module is built around — one bad email must not cost the batch —
is entirely unverified.

## Acceptance Criteria
- [ ] A test runs a batch of three messages where the second throws, and asserts the first and third are still extracted.
- [ ] The failing message is recorded with `EXTRACTION_STATUS.FAILED`.
- [ ] The scan result reports the failure rather than silently omitting the message.
- [ ] Narrowing or removing the per-message catch reddens a test, verified by applying the mutation and confirming it applied.
- [ ] The equivalent refusal case (model refuses, scan continues) is likewise pinned.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: One bad email does not cost the batch
  Scenario: A throwing message does not abort the scan
    Given three messages where the second throws on extraction
    When the batch is extracted
    Then the first and third messages are extracted successfully
    And the second is recorded as FAILED

  Scenario: A refusal is recorded and the scan continues
    Given three messages where the model refuses the second
    When the batch is extracted
    Then the first and third are still extracted
    And the refusal is recorded
```

## Additional Context
