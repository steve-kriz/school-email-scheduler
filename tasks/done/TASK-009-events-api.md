---
id: TASK-009
title: Events API — calendar range, upcoming attention list, acknowledge and dismiss
status: done
created: 2026-08-17T11:00:00Z
updated: 2026-08-26T02:10:00.000Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T00:05:00.000Z","finishedAt":"2026-08-26T00:31:00.000Z","note":"events.mjs read/mutate half (+1165) + 5 routes in index.mjs (+349) + dynamodb:BatchGetItem added to the IAM statement. Re-scan precondition solved via option 1: storeEvents BatchGetItems the exact keys it is about to write and applyPreservedLifecycle carries acknowledged/dismissed forward, so a handled row never returns to AttentionIndex; pre-read FAILS SOFT (write proceeds, logs lifecycle_read_failed) on the stated reasoning that losing a new event beats resurrecting a handled one. No new runtime dependency - all new SDK imports come from lib-dynamodb which is already runtime-bundled, so nothing to reconcile with TASK-038. Reported 1588 pass / 2 fail with the 2 failures claimed PRE-EXISTING on the base commit (npm-scripts test:bdd, and two mutated-fixture assertions in dynamodb-calendar.test.js) - NOT yet independently verified by the orchestrator. terraform validate error_count 0, warning_count 4 as expected. Token/cost telemetry not correlated for this window; agent reported 170905 total subagent tokens, direction unsplit, so tokensIn/tokensOut are omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-26T00:35:00.000Z","finishedAt":"2026-08-26T01:35:00.000Z","note":"RED - genuine implementation defect, fix loop attempt 1 of 3. parseRangeBound accepts impossible calendar days: its docblock claims ISO parsing yields NaN for them, which is FALSE. ORCHESTRATOR INDEPENDENTLY CONFIRMED: Date.parse(2026-02-31T00:00:00.000Z) is VALID and rolls to 2026-03-03; 2026-04-31 rolls to 2026-05-01; only 2026-13-01 genuinely NaNs. Caught by 2 assertions (1 e2e + 1 unit). Consequences: a non-existent instant ships as a BETWEEN key bound, and with only from supplied 2026-02-31 fills to from MARCH while the echoed from still says February, so the reported range and span arithmetic disagree. Suite 1717 tests / 1713 pass / 4 fail = 2 defect + 2 known baseline (TASK-098 npm-scripts, TASK-099 CRLF). Delivered tests/e2e/calendar-events-api.test.js (52 scenarios through the real handler with a signed session cookie), tests/unit/calendar-events-api.test.js (75 tests), and tests/helpers/fake-events-table.mjs (in-memory table that THROWS on a Scan, on an unknown index, on a malformed key condition and on an UpdateItem with no ConditionExpression, models AttentionIndex as genuinely sparse and raises a real ConditionalCheckFailedException). QUALITY NOTE - this tester met the bar the previous two did not: all 11 mutations EXECUTED not reasoned about, each needle-guarded so a non-matching needle aborts as meaningless rather than reporting a false catch (M1 pre-read off 2->7 fail, M5 path regex 2->4, M8 cap not cap+1 2->4, M10 key condition drops hash key 2->14, M11 IAM BatchGetItem removed 1->2). No vacuous assertions; the single source-inspection test is the terraform IAM grant where no executable alternative exists and the repo precedents it. All 22 other acceptance criteria passed, including the full re-scan preserve chain observed end to end. Committed c49d92e; implementation and terraform byte-identical to d07eb4d. Token/cost telemetry not correlated; 147038 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T01:35:00.000Z","finishedAt":"2026-08-26T01:45:00.000Z","note":"FIX attempt 1 of 3 SUCCEEDED (1b2283a), events.mjs only, +28/-5. parseRangeBound now round-trips the canonical date (parsed.iso.slice(0,10) !== raw -> EventValidationError), same 400 {error,field} shape, no new error type. False docblock premise removed and replaced with the real Date.parse behaviour. AUDITED THE WHOLE CLASS rather than the one line: buildEventItem left deliberately unchanged (canonicalises model output for eventId hashing and StartsAtIndex keying, not a validation gate - tightening it would change TASK-007 eventId derivation), isOverdue cleared (reads stored data, gates nothing), monthRangeFor/resolveRange Date.parse cleared (operate on already-validated strings), requireEventId regex only, index.mjs parses no dates. Added a WARNING to normaliseInstant docblock that it is NOT a day validator and callers must round-trip - the recurrence guard the false prose failed to be. FOUND A TEST DEFECT AND CORRECTLY REFUSED TO EDIT THE TEST: tests/unit/calendar-events-api.test.js:183 passes an EAGERLY EVALUATED third argument to assert.throws whose template literal calls resolveRange with the very date that must now be rejected, so the message expression itself throws and escapes the test. ORCHESTRATOR CONFIRMED from the stack (test file 183:72 inside resolveRange, failureType testCodeFailure) - the assertion logic is correct and passes; only the diagnostic is self-defeating, constructible only while the bug is present. Returned to testing for the Testing column to fix its own message argument. e2e 52/52 (was 51/1); full suite 1717 tests 1714 pass 3 fail = 2 known baseline + this test-owned diagnostic. Boundary behaviour verified directly: 2026-02-31/04-31/13-01/02-29/00-10/01-00 all rejected with field set; 2026-02-28 and the real leap day 2024-02-29 accepted; resolveRange({from:2026-02-01}) now fills to 2026-02-28 spanDays 28 so echoed range and span agree. Token/cost telemetry not correlated; 33742 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-26T01:45:00.000Z","finishedAt":"2026-08-26T02:08:00.000Z","note":"GREEN (6443a8a). Tester accepted the diagnosis, repaired its own eagerly-evaluated message argument (plain string + a comment recording the trap) and WIDENED the case rather than doing the minimum: a table of four impossible days each asserting error name AND field, plus neighbouring real days (2026-02-28, 03-01, 12-31 and the 2028-02-29 leap day) so the round-trip check is shown to reject impossible days rather than everything near a month boundary. Own files 128/128. Full suite 1718 tests 1716 pass 2 fail - one MORE test than the orchestrator predicted, and it said so and reconciled the arithmetic rather than quietly matching the forecast. Baseline confirmed as exactly the two known unrelated failures (TASK-098, TASK-099), explicitly noting the other not-ok lines are parent suites propagating those two leaves. M12 (the mutation the orchestrator demanded) EXECUTED: reverting parseRangeBound to the old parse-succeeded check turns both impossible-day tests red, and critically they now fail as ASSERTION failures rather than escaping as testCodeFailure. M13 pins the guard from the other direction (rejects-everything, 26 failures). ONE SURVIVING MUTANT PROVED EQUIVALENT NOT MISSED: M12b weakens the round-trip to year-month only; rather than assert equivalence by reasoning the tester ENUMERATED all 60000 YYYY-MM-DD strings across 2024-2029 and found zero disagreements, since a day rollover always crosses a month boundary. Swept its own files for the same eager-argument trap by script not eyeball: no findings, and it deleted a second instance of the shape that could not throw but was one removed ?. from the same failure mode. HONESTY NOTE: reported an uncharacterised 1714/4 run immediately after commit, captured counts but not leaf names, and flagged it rather than re-running until it looked right; four consecutive runs since at 1716/2 and ten of its own files at 128/0. Hypothesis (unproven, pre-existing infrastructure) recorded against TASK-099. Token/cost telemetry not correlated; 174316 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
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
