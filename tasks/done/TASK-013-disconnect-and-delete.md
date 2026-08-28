---
id: TASK-013
title: Disconnect Gmail — revoke the grant and delete stored data
status: done
created: 2026-08-18T09:00:00Z
updated: 2026-08-28T21:44:12.000Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T02:35:00.000Z","finishedAt":"2026-08-26T03:15:00.000Z","note":"Implemented and committed (096b31d). New backend/disconnect.mjs (revokeGrant + disconnectAccount), deleteConnection in connections.mjs (ReturnValues ALL_OLD, strips secrets before returning), deleteEventsForUser in events.mjs (key-only projection, MAX_DELETE_PAGES), AUTH_DISCONNECT_PATH route in index.mjs, plus frontend/settings.html and settings.js. ORDERING CHOSEN AND JUSTIFIED: read token -> revoke at Google -> clear schedule -> delete row -> delete events. The row is the ONLY copy of the grant, so deleting first would leave a live grant this app could never revoke; that makes revoke-fails-but-something-deleted structurally unreachable, and revoke-succeeds-delete-fails self-healing because a retry gets 400 invalid_token (treated as success) and re-attempts. SHARPEST FIND: deleteScanSchedule normally ends with an UpdateItem patch, and UpdateItem CREATES the row it cannot find - it would have resurrected a stub connection immediately before or after the delete. Coder injected a no-op updateConnection to prevent that, and still calls it when no row exists so a retry can clear an orphaned schedule. Correctly reasoned the TASK-011 alarm interaction: disconnect talks to the REVOKE endpoint not the token endpoint so it cannot reach the invalid_grant branch, and after deletion a later scan takes the alarm-free no_refresh_token path - a deliberate disconnect emits ZERO CALENDAR_REAUTH_REQUIRED. deleteEvents must be a real boolean (non-boolean -> 400 field deleteEvents, no truthiness coercion). eventsDeleteComplete always present and false when unprocessed keys survived, an index item had no usable key, MAX_DELETE_PAGES was hit, or the erase threw - a 200 with false is the honest rows-may-remain answer. The 502 path deliberately does NOT clear the session cookie. resetTokenCache called so a warm container cannot reuse an access token from the dead grant. BOUNDARY RESPECTED: created the two frontend files but did NOT add a serve route because TASK-010 owns the static allowlist and its traversal tests. No terraform change needed. Reported full suite 1877 tests 1873 pass with only the two known unrelated failures. Token/cost telemetry not correlated; 173204 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-26T03:15:00.000Z","finishedAt":"2026-08-26T03:30:00.000Z","note":"DISPATCH DIED BEFORE DOING ANY WORK - the org monthly spend limit was reached and the agent was terminated by an API error on its first step, having only said it would read the ticket. NO TESTS WERE WRITTEN AND NOTHING WAS RUN; THIS TICKET IS UNTESTED and must not be treated as verified. The implementation is safely COMMITTED at 096b31d on branch ticket/TASK-013 with a clean worktree, so no work is lost. Claim released so the next run re-dispatches the testing column from scratch. The full tester brief must be re-issued: revoke-outcome mapping including the unparseable-400 case, the deleteScanSchedule UpdateItem resurrection hazard proven by a test that fails if the no-op is removed, zero CALENDAR_REAUTH_REQUIRED on a deliberate disconnect, all four routes to eventsDeleteComplete false, boolean-only deleteEvents, the 502 path not clearing the session cookie, resetTokenCache, and paging plus UnprocessedItems retry. No tokens/cost recorded - the run was truncated"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-28T21:27:00.000Z","finishedAt":"2026-08-28T21:39:00.000Z","note":"GREEN. Suite 1983 tests 1981 pass 2 fail, the two being the known unrelated TASK-098 and TASK-099; all 106 TASK-013 tests pass. Implementation code NOT modified, git diff clean against 096b31d. THE PRE-EXISTING FILE LEFT BY THE DEAD DISPATCH WAS NOT USABLE AS FOUND and was repaired, not trusted: it did not parse at all (a literal newline inside a string at line 660, SyntaxError, so it could never have run - the prior note claiming no tests were written was wrong but the file it left was dead), and it contained a test that COULD NOT FAIL (the survived-every-attempt retry mock returned keys.slice(2), which went empty once the retry shrank pending to 1 key, so the retry succeeded by construction); mock now throttles the same key every attempt. Both were TEST defects, not implementation defects. RESURRECTION HAZARD PROVEN BY EXECUTED MUTATION: removing the no-op updateConnection from disconnect.mjs reddened 4 tests, the sharpest being a second disconnect returning connectionDeleted true for a stub row the UpdateItem had just upserted; the e2e fake updateItem genuinely upserts so this is behavioural, not a source grep. JUDGMENT CALL PINNED: an unparseable 400 from the revoke endpoint is FAILURE (502, nothing deleted, reason http_400), because a wrong already-gone verdict destroys the only copy of a live token while a wrong failure verdict costs one retry. Zero CALENDAR_REAUTH_REQUIRED proven three ways including an injected emitAlarm spy recording nothing. All four eventsDeleteComplete false routes covered at route level each asserting rows really remain, and the field asserted present on every 200. Boolean-only deleteEvents with world.trace asserted empty so no storage was reached. 502 path asserted to leave the cookie, 200 path asserted to clear it. resetTokenCache proven against a really-primed cache. Paging 63 events over 3 pages gave batch sizes 25,5,25,5,3 with a hard assert that no batch exceeds 25. node_modules absent in the worktree, so any real @aws-sdk import would have thrown - additional proof no DB call is real. Token/cost telemetry not correlated; 114322 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-28T21:42:00.000Z","finishedAt":"2026-08-28T21:44:12.000Z","note":"CORRECTION dispatch, merge-blocking defect found by the orchestrator at merge review, not by the suite. The new e2e file carried 4 LITERAL NUL bytes (offsets 3617, 4562, 7990, 8078) used as a composite-key separator in template literals, so git classified the whole file as binary and reported it as Bin 0 -> 43948 bytes; that disables diffs, merges and line-ending conversion on a file parallel branches touch, and would have silently exempted it from this repo known CRLF hazard. Same defect class as the separately ticketed NUL byte in tests/helpers/fake-events-table.mjs. Replaced each with the two-character escape backslash-zero, which evaluates to the identical U+0000 so every composite key is byte-identical at runtime; only the on-disk representation changed, file grew 43948 to 43952 bytes. Verified zero NUL bytes in BOTH the working tree and the committed blob. Verified the text diff CORRECTLY: a diff renders Bin if EITHER side is binary and the previous blob still was, so it used a throwaway one-character probe edit against the fixed commit to show a normal 1 insertion 1 deletion text diff, then reverted it. Re-ran to identical counts 1983/1981/2 with 106/106 for this ticket. Committed 5f3b2c5. Merged to master, where the file now diffs as 1042 text lines. Token/cost telemetry not correlated; 122592 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
depends-on: TASK-009
---

## Description
TASK-004's `logout` ends the browser session but leaves the Gmail grant live and
every stored event in place. A user who signs in with Google needs a real way
out: revoke the app's access at Google and delete what was stored. This is also
a **Limited Use requirement** for the restricted `gmail.readonly` scope
(see TASK-012), not just good manners.

Depends on TASK-009 (needs the events table access patterns) and TASK-004
(needs `connections.mjs`, `session.mjs`, `getRefreshToken`).

Add to `src/lambda/calendar/backend/connections.mjs` (or a new
`backend/disconnect.mjs`) and route in `index.mjs`:

**`POST /calendar/api/auth/disconnect`** — authenticated. Body accepts
`{ deleteEvents: boolean }` so the two concerns are separable: a user may want
to stop the app reading their mail while keeping the calendar it already built.
Order of operations matters, because a partial failure must never leave a live
grant with no local record of it:
1. Read the refresh token.
2. `POST https://oauth2.googleapis.com/revoke` with `token=<refresh token>`.
   Treat **`200` and `400 invalid_token` both as success** — a `400` means the
   grant is already gone, which is the desired end state, and failing the
   request there would strand the user.
3. Delete the connection row (which destroys the only copy of the encrypted
   refresh token — the grant is unrecoverable afterwards, by design).
4. When `deleteEvents` is true, delete every event for the user: Query
   `StartsAtIndex` for the user's `eventId`s and `BatchWriteItem` deletes in
   chunks of 25, following `LastEvaluatedKey` so a large history is fully
   cleared rather than partially. Retry `UnprocessedItems`.
5. Clear the session cookie and return `200` with
   `{ revoked, connectionDeleted, eventsDeleted }` counts.

**Failure handling.** If revocation fails with anything other than
`400 invalid_token` — a network error, a `5xx` — do **not** delete the
connection row: without the stored token the grant can never be revoked again,
and a live unrevocable grant is strictly worse than a retryable failure. Return
`502` with a message telling the user to retry, and leave all state untouched.
Deleting events, by contrast, is safe to attempt independently of revocation.

**Idempotency.** Disconnecting twice must not error. A second call with no
connection row returns `200` with `revoked: false, connectionDeleted: false`.

Also extend the UI (TASK-010's settings page) with a "Disconnect Gmail" control
that states plainly what happens — access revoked, and either events kept or
deleted — behind a typed confirmation, since event deletion is unrecoverable.
Offer both choices rather than assuming; the destructive one must not be the
default.

Logging: record the userId, the counts, and the outcome. Never log the refresh
token, the revoke request body, or any event title.

## Acceptance Criteria
- [ ] `POST /calendar/api/auth/disconnect` returns `401` without a valid
      session.
- [ ] A successful disconnect POSTs the refresh token to Google's revoke
      endpoint before any local delete.
- [ ] A `200` from the revoke endpoint is treated as success.
- [ ] A `400 invalid_token` from the revoke endpoint is also treated as
      success, and the disconnect completes.
- [ ] A `500` from the revoke endpoint returns `502`, and the connection row and
      events are left untouched.
- [ ] A network failure calling the revoke endpoint returns `502` and deletes
      nothing.
- [ ] On success the connection row is deleted, so no encrypted refresh token
      remains for that user.
- [ ] With `deleteEvents: true` every event for the user is deleted, including
      across multiple Query pages.
- [ ] With `deleteEvents: false` the events are retained and the response
      reports `eventsDeleted: 0`.
- [ ] Event deletes use `BatchWriteItem` in chunks of at most 25 and retry
      `UnprocessedItems`.
- [ ] The response clears the session cookie.
- [ ] The response body reports `revoked`, `connectionDeleted` and
      `eventsDeleted`.
- [ ] A second disconnect call returns `200` with `revoked: false` and
      `connectionDeleted: false`, and does not error.
- [ ] Deleting one user's data leaves another user's connection and events
      untouched.
- [ ] No log line contains the refresh token, the revoke request body, or an
      event title.
- [ ] The settings page exposes a "Disconnect Gmail" control that names both
      outcomes, requires a typed confirmation, and does not default to
      deleting events.
- [ ] All Google, DynamoDB and KMS calls are mocked in tests.

## Cucumber Tests
```gherkin
Feature: Disconnecting a Google account
  Scenario: A user revokes access and keeps their calendar
    Given an authenticated user with a stored grant and 12 events
    When they POST disconnect with deleteEvents false
    Then the response status code is 200
    And the grant was revoked at Google
    And the connection row is deleted
    And 12 events remain stored

  Scenario: A user revokes access and erases everything
    Given an authenticated user with a stored grant and 12 events
    When they POST disconnect with deleteEvents true
    Then the response status code is 200
    And eventsDeleted is 12
    And no events remain for that user

  Scenario: An already-revoked grant still disconnects cleanly
    Given Google's revoke endpoint returns 400 invalid_token
    When the user POSTs disconnect
    Then the response status code is 200
    And the connection row is deleted

  Scenario: A failed revocation does not strand a live grant
    Given Google's revoke endpoint returns 500
    When the user POSTs disconnect
    Then the response status code is 502
    And the connection row still exists
    And no events are deleted

  Scenario: A network error is retryable, not destructive
    Given the revoke request raises a network error
    When the user POSTs disconnect
    Then the response status code is 502
    And nothing was deleted

  Scenario: A large history is fully cleared
    Given an authenticated user with events spanning three query pages
    When they POST disconnect with deleteEvents true
    Then every event across all three pages is deleted

  Scenario: Disconnecting twice is harmless
    Given a user who has already disconnected
    When they POST disconnect again
    Then the response status code is 200
    And revoked is false
    And connectionDeleted is false

  Scenario: One user's disconnect does not touch another's data
    Given users "google#1" and "google#2" each with a grant and events
    When "google#1" disconnects with deleteEvents true
    Then "google#2" still has a connection row and all their events

  Scenario: The browser session ends with the grant
    Given an authenticated user
    When they POST disconnect
    Then the Set-Cookie header expires the session cookie

  Scenario: Tokens stay out of the logs
    Given a stored refresh token "rt-secret-value"
    When the user POSTs disconnect
    Then no log line contains "rt-secret-value"

  Scenario: Erasing data requires deliberate confirmation
    Given the settings page disconnect control
    Then it states that access will be revoked
    And it offers keeping or deleting events as an explicit choice
    And deleting events is not the default
    And it requires a typed confirmation before deleting
```

## Additional Context
