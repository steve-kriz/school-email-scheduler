---
id: TASK-009
title: Events API — calendar range, upcoming attention list, acknowledge and dismiss
status: todo
created: 2026-08-17T11:00:00Z
updated: 2026-08-17T11:00:00Z
depends-on: TASK-007
---

## Description
Expose the stored events to the frontend: one query that fills a calendar month,
one that fills the "needs attention" list, and mutations to clear an item.

Depends on TASK-007 (needs `events.mjs` and the two GSIs from TASK-002).

Extend `src/lambda/calendar/backend/events.mjs` and add routes to `index.mjs`:

- `GET /calendar/api/events?from=YYYY-MM-DD&to=YYYY-MM-DD` — Query
  `StartsAtIndex` with `userId = <session sub>` and a `startsAt BETWEEN`
  condition. **Never Scan the table** and never filter by user in application
  code after a broad read — the partition key is the tenancy boundary.
  Validate that both dates parse, that `from <= to`, and that the span is at
  most 93 days (a quarter view); return `400` otherwise. Default to the current
  month when both are omitted. Follow `LastEvaluatedKey` so a busy month is not
  silently truncated, and cap at 500 items with a `truncated` flag.

- `GET /calendar/api/events/upcoming?limit=N` — Query `AttentionIndex` with
  `attentionKey = "<userId>#pending"`, ordered by `dueBy` ascending
  (`ScanIndexForward: true`), so the soonest deadline is first. Default
  `limit` 20, maximum 100. Because the index is sparse, acknowledged and
  dismissed events are absent by construction rather than filtered out.
  Include an `overdue` boolean per item computed against now.

- `POST /calendar/api/events/{eventId}/acknowledge` — set
  `status = "acknowledged"`, stamp `acknowledgedAt`, and **`REMOVE attentionKey`**
  in the same `UpdateItem` so the row leaves `AttentionIndex`.

- `POST /calendar/api/events/{eventId}/dismiss` — same shape with
  `status = "dismissed"` and `dismissedAt`.

- `POST /calendar/api/events/{eventId}/restore` — set `status = "pending"` and
  re-set `attentionKey` when the event has `needsAttention` true, so a mistaken
  dismissal is recoverable.

Every mutation must carry a condition expression asserting
`attribute_exists(userId)` **and** that `userId` equals the session user, so a
guessed or leaked `eventId` from another account cannot be mutated. A condition
failure returns `404` (not `403` — do not confirm that someone else's event
exists).

`eventId` arrives from the URL path. Validate it as 64 lowercase hex characters
before it reaches DynamoDB and reject anything else with `400`.

All routes require a session and return `401` without one. Never accept a
`userId` from the query string, body, or a header — always take it from the
verified session, or one user can read another's calendar.

Response shape per event: `eventId`, `title`, `description`, `startsAt`,
`endsAt`, `allDay`, `location`, `category`, `needsAttention`, `actionRequired`,
`dueBy`, `status`, `confidence`, `sourceSubject`, `sourceFrom`,
`sourceReceivedAt`. Return the source subject/sender so the UI can show
provenance, but never `sourceMessageId` — it is a Gmail handle with no purpose
in the browser.

## Re-scan precondition (from the TASK-007 build — read before building)
TASK-007 persists events with `BatchWriteItem` and a content-derived `eventId`
(`sha256(sourceMessageId|title|startsAt)`). That makes a re-scan idempotent by
design — the same email yields the same key — but it also means **a re-scan
rewrites the item wholesale**, resetting `status` to `pending` and re-adding
`attentionKey`. An event the user has already acknowledged therefore pops back
into the attention list on the next scheduled scan.

`BatchWriteItem` cannot carry a condition expression, so this is inherent to the
write strategy rather than an oversight — the TASK-007 author left it in place
with a WARNING docblock rather than papering over it, because the fix belongs to
whichever ticket owns acknowledge. That is this one.

Resolve it one of two ways, and state which you chose:
- read existing `status` values before writing and preserve an acknowledged
  state (costs a read per event, and races with a concurrent scan); or
- record the acknowledgement somewhere a re-scan does not overwrite — a separate
  attribute the write does not touch, or a separate item keyed by `eventId`.

Whichever you pick, prove it with a test that acknowledges an event, re-runs the
store path for the same source email, and asserts the event is **still**
acknowledged and **absent** from the attention list.

## Acceptance Criteria
- [ ] Acknowledging an event survives a re-scan of the same source email: the
      event stays acknowledged and does not reappear in the attention list.
- [ ] A test drives acknowledge -> re-store -> query and asserts both.
- [ ] `GET /calendar/api/events` queries `StartsAtIndex` with the session
      `userId` as the hash key and a `BETWEEN` on `startsAt`.
- [ ] No route in this ticket issues a DynamoDB `Scan`.
- [ ] No route accepts a `userId` from the query string, body, or headers.
- [ ] Omitting `from` and `to` defaults to the current calendar month.
- [ ] A `from` later than `to` returns `400`.
- [ ] An unparseable date returns `400`.
- [ ] A range wider than 93 days returns `400`.
- [ ] A month with more results than one page follows `LastEvaluatedKey`, and a
      result set capped at 500 sets `truncated: true`.
- [ ] `GET /calendar/api/events/upcoming` queries `AttentionIndex` on
      `"<userId>#pending"` with `ScanIndexForward: true`, soonest `dueBy` first.
- [ ] `limit` defaults to 20 and is clamped to a maximum of 100.
- [ ] Each upcoming item carries an `overdue` boolean computed against the
      current time.
- [ ] Acknowledging an event sets `status = "acknowledged"`, stamps
      `acknowledgedAt`, and removes `attentionKey` in the same update.
- [ ] An acknowledged event no longer appears in the upcoming response.
- [ ] Dismissing behaves the same with `status = "dismissed"`.
- [ ] Restoring a dismissed event with `needsAttention` true sets it back to
      `pending` and re-adds `attentionKey`.
- [ ] Every mutation carries a condition expression binding the row to the
      session `userId`.
- [ ] Mutating another user's `eventId` returns `404`, not `403`, and does not
      modify the row.
- [ ] An `eventId` that is not 64 lowercase hex characters returns `400` and no
      DynamoDB call is made.
- [ ] Every route returns `401` without a valid session.
- [ ] No response body contains `sourceMessageId`, `refreshTokenEnc`, or any
      token.
- [ ] All DynamoDB calls are mocked in tests; no test opens a real connection.

## Cucumber Tests
```gherkin
Feature: Reading and clearing calendar events
  Scenario: A month of events is returned in order
    Given an authenticated user with events on 2026-09-04 and 2026-09-18
    When they GET events from 2026-09-01 to 2026-09-30
    Then the response status code is 200
    And 2 events are returned
    And the query used the StartsAtIndex

  Scenario: The default range is the current month
    Given an authenticated user
    When they GET "/calendar/api/events" with no parameters
    Then the queried range covers the current calendar month

  Scenario Outline: Invalid ranges are refused
    Given an authenticated user
    When they GET events from "<from>" to "<to>"
    Then the response status code is 400
    Examples:
      | from       | to         |
      | 2026-09-30 | 2026-09-01 |
      | not-a-date | 2026-09-30 |
      | 2026-01-01 | 2026-12-31 |

  Scenario: A crowded month is not silently truncated
    Given a month whose events span two DynamoDB pages
    When the month is queried
    Then events from both pages are returned

  Scenario: Upcoming items are ordered by deadline
    Given pending attention events due 2026-08-22 and 2026-08-19
    When they GET "/calendar/api/events/upcoming"
    Then the first item is due 2026-08-19

  Scenario: A passed deadline is marked overdue
    Given a pending attention event due yesterday
    When they GET "/calendar/api/events/upcoming"
    Then that item has overdue true

  Scenario: Acknowledging clears an item from the attention list
    Given a pending attention event
    When the user POSTs to its acknowledge route
    Then the response status code is 200
    And the item no longer appears in the upcoming response
    And the stored item has no attentionKey attribute

  Scenario: A mistaken dismissal can be undone
    Given a dismissed event with needsAttention true
    When the user POSTs to its restore route
    Then its status is "pending"
    And it reappears in the upcoming response

  Scenario: One user cannot touch another user's event
    Given an event belonging to user "google#2"
    When user "google#1" POSTs to its acknowledge route
    Then the response status code is 404
    And the event is unchanged

  Scenario: One user cannot read another user's calendar
    Given a session for user "google#1"
    When they GET events with a userId query parameter of "google#2"
    Then the returned events all belong to "google#1"

  Scenario: A malformed event id is rejected before the database
    Given an authenticated user
    When they POST to acknowledge event id "../../etc/passwd"
    Then the response status code is 400
    And no DynamoDB call is made

  Scenario: Gmail handles are not exposed to the browser
    Given an authenticated user with events
    When they GET the month view
    Then no response item contains "sourceMessageId"

  Scenario: Unauthenticated access is refused
    Given no session cookie
    When "/calendar/api/events/upcoming" is requested
    Then the response status code is 401
```

## Additional Context
