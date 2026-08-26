---
id: TASK-076
title: Title-variant collapse and empty-sourceMessageId collision in eventId are unproven
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: low
---

## Description
Two separate gaps around `deriveEventId`
(`src/lambda/calendar/backend/events.mjs:329-332`):

1. **The whitespace/case normalisation is unproven.** `deriveEventId` receives
   the already-`cleanText`ed title, so case and whitespace variants DO collapse
   to one id correctly. But no test asserts it — the idempotence tests reuse a
   byte-identical title. The normalisation could be dropped from the hash input
   without failing anything.
2. **An empty `sourceMessageId` collides.** At `events.mjs:413`, a message with
   no `id` contributes an empty first hash component, so two id-less messages
   with the same title and date derive the SAME `eventId` and silently overwrite
   each other.

## Impact If Not Fixed
If the normalisation is dropped, a re-scan whose title differs by a single space
silently duplicates every event on the parent's calendar — the exact failure
idempotence exists to prevent, and highly visible to the end user. The empty-id
collision is rarer but loses an event outright rather than duplicating one.

## Acceptance Criteria
- [ ] A test asserts titles differing only by case and by surrounding/internal whitespace derive the SAME `eventId`.
- [ ] Removing the normalisation from the hash input reddens that test, verified by mutation with the mutation confirmed to have applied.
- [ ] Two distinct messages with no `id` but the same title and date are handled without silently overwriting one another — either by rejecting the id-less message, or by including a distinguishing component.
- [ ] Genuinely identical events across a re-scan still collapse to one row (idempotence preserved).
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Event identity is stable and collision-free
  Scenario Outline: Title variants collapse to one event
    Given an event titled "<title>" from the same message and date
    Then it derives the same eventId as "School Disco"
    Examples:
      | title         |
      | school disco  |
      | School  Disco |
      | School Disco  |

  Scenario: Two id-less messages do not overwrite each other
    Given two different messages with no id, the same title and the same date
    When their events are derived
    Then they do not silently collapse into one row

  Scenario: Dropping the normalisation is caught
    Given the title normalisation is removed from the hash input
    When the suite runs
    Then at least one test fails
```

## Additional Context
