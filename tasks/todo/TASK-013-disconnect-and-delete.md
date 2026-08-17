---
id: TASK-013
title: Disconnect Gmail — revoke the grant and delete stored data
status: todo
created: 2026-08-18T09:00:00Z
updated: 2026-08-18T09:00:00Z
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
