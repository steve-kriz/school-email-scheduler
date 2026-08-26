---
id: TASK-068
title: retry-after is never asserted and the default 4-attempt ceiling is never exercised
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: medium
---

## Description
`tests/unit/calendar-extraction.test.js:1237-1281` supplies `retry-after: '2'`
and then asserts only:

```js
delays[0] <= 20000
```

An ordinary jittered backoff of ~250–500 ms satisfies that too. The header could
be ignored entirely and the test would still pass.

Separately, every retry test overrides `maxAttempts` to 2 or 3, so
`MAX_ATTEMPTS = 4` (`src/lambda/calendar/backend/anthropic.mjs:126`) is never
exercised. The `parseRetryAfter` / `readHeader` path inside `callModel`
(`anthropic.mjs:1004`) is likewise unpinned — both are exported into the test
file and never called.

## Impact If Not Fixed
The two controls that bound per-email spend during a 429 storm — honouring the
server's requested back-off, and capping attempts — can both regress without any
test failing. A scan would then hammer a rate-limited account and burn budget,
which is precisely the cost failure the retry policy exists to prevent.

## Acceptance Criteria
- [ ] The `retry-after` test asserts the delay is derived from the header (≈2000 ms for `'2'`), not merely bounded above.
- [ ] Ignoring the header reddens that test, verified by mutation with the mutation confirmed to have applied.
- [ ] A test exercises the DEFAULT `MAX_ATTEMPTS = 4` without overriding it, asserting exactly four attempts occur.
- [ ] `parseRetryAfter` and `readHeader` are called directly and pinned, including the HTTP-date form and a malformed value.
- [ ] A `retry-after` in the past yields a non-negative delay (see TASK-036, which covers the zero-spacing edge — coordinate, do not duplicate).
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Rate-limit back-off is honoured and bounded
  Scenario: The server's retry-after is used
    Given a 429 response carrying retry-after "2"
    When the call is retried
    Then the delay before the retry is approximately 2000 ms

  Scenario: Attempts are capped at the default ceiling
    Given a persistently rate-limited endpoint and no maxAttempts override
    When extraction runs
    Then exactly four attempts are made

  Scenario: Ignoring the header is caught
    Given the retry-after header is ignored by the backoff
    When the suite runs
    Then at least one test fails
```

## Additional Context
