---
id: TASK-070
title: A thrown batchWrite abandons the remaining chunks and loses the written count
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: medium
---

## Description
`src/lambda/calendar/backend/events.mjs:623` — `await batchWrite(...)` is
unguarded.

`putEvents` treats only `UnprocessedItems` as a partial result. A real exception
— `ProvisionedThroughputExceededException`, a transient transport error —
propagates straight out of `storeEvents`. Two consequences:

1. The count of chunks already written is discarded, so the caller cannot tell
   which events were stored.
2. Every chunk *after* the failing one is never attempted.

No test covers this: every `batchWrite` mock in both test files returns a
resolved object, so the throwing path has never executed.

Fix: catch per chunk, continue to the remaining chunks, and return a partial
result carrying both what was written and what failed — matching the design the
module already uses for `UnprocessedItems`.

## Impact If Not Fixed
One transient DynamoDB error mid-scan silently drops all later events for that
user. Because the written count is lost with the exception, a partial write is
indistinguishable from a total failure, so the scan cannot report or resume
accurately — and the parent simply never sees those calendar events.

## Acceptance Criteria
- [ ] A throwing `batchWrite` does not abort the remaining chunks; each chunk is attempted.
- [ ] `putEvents` returns a partial result recording which chunks were written and which failed, rather than propagating the exception.
- [ ] The written count survives a mid-batch throw and is reported to the caller.
- [ ] A test makes `batchWrite` throw on chunk 2 of 3 and asserts chunks 1 and 3 are written and the failure is reported.
- [ ] The distinction between a thrown error and `UnprocessedItems` is preserved — both are partial results, neither is silently swallowed.
- [ ] The fix is pinned by mutation, with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A partial batch write loses nothing silently
  Scenario: A transient error mid-batch does not abandon later chunks
    Given three chunks of events to write
    And the second chunk write throws a transient error
    When putEvents runs
    Then the first and third chunks are written
    And the result reports the second chunk as failed
    And the result reports the number of events actually written

  Scenario: A thrown error is distinguishable from unprocessed items
    Given a chunk that throws and a chunk that returns UnprocessedItems
    When putEvents runs
    Then the result distinguishes the two outcomes
```

## Additional Context
