---
id: TASK-035
title: The incremental watermark is unpinned and advancing it on a truncated scan loses mail permanently
status: todo
created: 2026-08-18T03:35:00Z
updated: 2026-08-18T03:35:00Z
review-of: TASK-006
---

## Description
Two findings from the TASK-006 review about the same field —
`fetchCandidateMessages`'s `newestReceivedAt`, which TASK-008 will use as the
incremental scan watermark. They are one ticket because they are one risk: the
watermark can be wrong, and nothing would notice.

### 1. `newestReceivedAt` and `truncated` are entirely unpinned
`src/lambda/calendar/backend/gmail.mjs:979-983` computes the max `receivedAt`
across fetched messages, and `:999` returns it alongside `truncated`. Neither
field is asserted anywhere. Both `fetchCandidateMessages` scenarios in
`tests/e2e/calendar-gmail-fetch.test.js` (~lines 556 and 616) assert only
`messages.length`, `errors`, or that a throw happens.

Verified by mutation, each change asserted to have persisted to disk:

```
flip `message.receivedAt > newestReceivedAt` to `<`  (returns the OLDEST)  -> 112 pass, 0 fail
hardcode `newestReceivedAt: null` in the return                           -> 112 pass, 0 fail
hardcode `truncated: false` in the return                                  -> 112 pass, 0 fail
```

All three survive. The field the entire incremental-scan design depends on has no
test at all.

### 2. Advancing the watermark on a truncated scan loses mail permanently
This is the more serious half, and it is a **contract** defect rather than a code
defect — the retrieval logic is correct.

Gmail's `users.messages.list` returns **newest-first**. `listMessageIds`
accumulates ids in page order and stops once `ids.length >= cap`
(`gmail.mjs:579, :590`), so the ids it keeps are the **newest** and the ones it
drops are the **oldest**. Meanwhile `newestReceivedAt` is the maximum across
what was fetched — i.e. the newest message overall.

So on a truncated scan the two facts combine badly: if the caller advances the
watermark to `newestReceivedAt`, the next scan's `after:` date excludes every
match older than it — including all the older matches that fell beyond the cap
and were never fetched. **Those messages are never retrieved again.**

The code reports `truncated` correctly, so this is entirely handleable. The
problem is that the `fetchCandidateMessages` docblock (`:858-902`) documents
`newestReceivedAt` as "what TASK-008 advances the incremental watermark to" with
**no warning** about the truncation interaction — and TASK-008 is not yet built,
so the trap is still ahead of us rather than behind.

Fix, in two parts:
- Harden the `fetchCandidateMessages` docblock to state the invariant plainly:
  **on `truncated: true` the watermark must not be advanced past the oldest
  fetched message**, or the scan must be re-run until it returns
  `truncated: false`.
- Add the assertions from part 1 so the field is pinned: the correct maximum
  across mixed `internalDate` values, `null` when no message carries a timestamp,
  and `truncated` propagating from `listMessageIds` rather than being hardcoded.

No change to the retrieval logic itself is required.

**A matching precondition has been added to TASK-008 directly**, since that is
where the data loss would actually occur. This ticket owns the docblock and the
tests; TASK-008 owns honouring the invariant.

## Impact If Not Fixed
Part 2 is silent, permanent loss of the user's calendar emails. It triggers on
the **first** scan of any busy mailbox — the initial window is 90 days and the
cap is 200 messages, so a mailbox with more than 200 school emails in 90 days
hits it immediately — and on any later burst that exceeds the cap. The user
never receives those events, and there is no error to indicate why: the scan
succeeds, some events appear, and the missing ones are simply absent. That is the
worst failure shape available here, because nothing distinguishes it from "the
school did not send anything that week".

Part 1 is what makes part 2 hard to catch and easy to reintroduce. With the
watermark unpinned, a future regression ships green and fails in one of two
directions, both invisible in tests: the watermark jumps ahead and older mail is
never re-scanned (data loss), or it never advances and every scan re-processes
the same messages (an unbounded Anthropic bill, since TASK-007 spends extraction
tokens per message).

Neither has a security consequence. Both are correctness, and the first scan of a
real mailbox is the most likely moment for a user to hit them.

## Acceptance Criteria
- [ ] A test asserts `newestReceivedAt` equals the correct maximum across
      messages with mixed, out-of-order `internalDate` values.
- [ ] Flipping the max comparison to `<` reddens at least one test.
- [ ] Hardcoding `newestReceivedAt: null` reddens at least one test.
- [ ] A test asserts `newestReceivedAt` is `null` when no fetched message carries
      a timestamp.
- [ ] A test asserts `truncated` propagates from `listMessageIds`; hardcoding it
      to `false` reddens at least one test.
- [ ] The `fetchCandidateMessages` docblock states that on `truncated: true` the
      watermark must not be advanced past the oldest fetched message.
- [ ] The docblock explains **why** — Gmail lists newest-first, so the cap drops
      the oldest matches — so the invariant is not mistaken for caution.
- [ ] The oldest fetched `receivedAt` is available to the caller, or the docblock
      states explicitly how a caller is expected to derive a safe watermark on a
      truncated scan.
- [ ] Every mutation is asserted to have applied on disk before its result is
      trusted.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The incremental watermark is correct and pinned
  Scenario: The watermark is the newest fetched timestamp
    Given fetched messages with out-of-order receivedAt values
    When fetchCandidateMessages returns
    Then newestReceivedAt equals the latest of those values

  Scenario: No timestamps yields no watermark
    Given fetched messages that carry no internalDate
    When fetchCandidateMessages returns
    Then newestReceivedAt is null

  Scenario: truncated is propagated, not assumed
    Given listMessageIds reports truncated true
    When fetchCandidateMessages returns
    Then truncated is true

  Scenario Outline: A watermark regression is caught
    Given a build with <mutation>
    When the suite runs
    Then at least one test fails
    Examples:
      | mutation                         |
      | the max comparison flipped to <  |
      | newestReceivedAt hardcoded null  |
      | truncated hardcoded false        |

  Scenario: The truncation invariant is documented
    Given the fetchCandidateMessages docblock
    Then it states the watermark must not advance past the oldest fetched message when truncated
```

## Additional Context
