---
id: TASK-006
title: Gmail message fetching with token refresh and incremental scanning
status: in-progress
created: 2026-08-17T11:00:00Z
updated: 2026-08-18T02:54:42Z
depends-on: TASK-005
agent: build-006
---

## Description
Read the candidate school emails out of Gmail so TASK-007 can extract events
from them. This ticket covers only retrieval — no model calls.

Depends on TASK-005 (needs stored `searchDomains`) and TASK-004 (needs
`getRefreshToken`).

New files:
- `src/lambda/calendar/backend/google-token.mjs`
- `src/lambda/calendar/backend/gmail.mjs`

`google-token.mjs` — `getAccessToken(userId)`: decrypt the stored refresh token,
POST it to `https://oauth2.googleapis.com/token` with
`grant_type=refresh_token`, and cache the resulting access token **in module
memory keyed by userId with its expiry**, refreshing when fewer than 60 seconds
remain. A warm Lambda container serves many requests, so re-minting on every
call is a needless round trip. When Google answers `400 invalid_grant` the user
has revoked the app: mark the connection `lastScanStatus = "reauth_required"`
and throw a distinguishable `ReauthRequiredError` so callers can surface a
"reconnect Gmail" state rather than a generic failure.

`gmail.mjs`:
- `buildQuery({ searchDomains, since })` — compose a Gmail search string
  `(from:@a.edu OR from:@b.edu) after:YYYY/MM/DD`. Gmail's `after:` takes
  `YYYY/MM/DD`, not ISO-8601 — convert explicitly. With no `since`, default to
  90 days ago rather than the whole mailbox.
- `listMessageIds({ accessToken, query, maxMessages })` — page
  `users.messages.list` following `nextPageToken` until exhausted or
  `maxMessages` (default 200) is reached. Return the ids plus a
  `truncated` boolean so the caller can report that the scan was capped rather
  than silently dropping mail.
- `getMessage({ accessToken, id })` — fetch `format=full` and return
  `{ id, threadId, subject, from, receivedAt, snippet, body }`.
- `extractPlainText(payload)` — walk the MIME tree preferring `text/plain`,
  falling back to `text/html` with tags stripped. Gmail bodies are
  **base64url** (`-` and `_`, often unpadded), not standard base64 — decode
  accordingly or the text is corrupted. Handle `multipart/alternative` and
  nested `multipart/mixed`, and skip attachment parts (a part with a
  `filename`) so a PDF newsletter does not become megabytes of binary noise.
- Truncate each extracted body to a configurable `maxBodyChars` (default
  20000) before returning, keeping the head of the message where dates live.

Resilience requirements:
- Retry `429` and `5xx` from Gmail with exponential backoff and jitter, at most
  4 attempts; respect a `Retry-After` header when present. Do **not** retry
  `401`/`403` — re-mint the token once on `401`, then fail.
- A single message that fails to fetch or parse must not abort the whole scan:
  collect per-message errors and return them alongside the successful results.
- Never log message bodies, subjects, sender addresses, or the access token.
  Log counts and message ids only.

Return shape from the scan-facing helper
`fetchCandidateMessages({ userId, since, maxMessages })`:
`{ messages, truncated, errors, newestReceivedAt }`. `newestReceivedAt` lets
TASK-008 advance the incremental watermark.

## Acceptance Criteria
- [ ] `buildQuery` renders `from:@` clauses OR-joined in parentheses for every
      stored domain.
- [ ] `buildQuery` formats `after:` as `YYYY/MM/DD`, not ISO-8601.
- [ ] `buildQuery` with no `since` defaults to a 90-day window rather than an
      unbounded query.
- [ ] `listMessageIds` follows `nextPageToken` and returns ids from every page.
- [ ] `listMessageIds` stops at `maxMessages` and returns `truncated: true`;
      with fewer results it returns `truncated: false`.
- [ ] `extractPlainText` decodes base64url bodies correctly, including unpadded
      input containing `-` and `_`.
- [ ] `extractPlainText` prefers a `text/plain` part when both plain and HTML
      exist, and strips tags when only `text/html` exists.
- [ ] `extractPlainText` walks nested `multipart/mixed` and
      `multipart/alternative` trees and skips parts carrying a `filename`.
- [ ] Bodies longer than `maxBodyChars` are truncated from the head, not the
      tail.
- [ ] The access token is cached per user in module memory and reused while
      more than 60 seconds of life remain; a second call within that window
      makes no token request.
- [ ] A token response with under 60 seconds remaining triggers a re-mint.
- [ ] A Gmail `429` is retried with backoff up to 4 attempts and then fails;
      a `Retry-After` header is honoured when present.
- [ ] A Gmail `403` is not retried.
- [ ] A `400 invalid_grant` from the token endpoint sets
      `lastScanStatus = "reauth_required"` and throws `ReauthRequiredError`.
- [ ] One failing message does not abort the scan: the returned `errors` array
      names it and the remaining messages are still returned.
- [ ] No log line contains a message body, subject, sender address, or access
      token.
- [ ] All Gmail and token HTTP calls are stubbed in tests; no test performs real
      network I/O.

## Cucumber Tests
```gherkin
Feature: Gmail retrieval
  Scenario: The search query targets only the configured school domains
    Given stored searchDomains ["stmarys.edu.au", "pandc.stmarys.edu.au"]
    When the query is built with no since date
    Then the query contains "from:@stmarys.edu.au"
    And the query contains "from:@pandc.stmarys.edu.au"
    And the query contains an "after:" clause in YYYY/MM/DD form

  Scenario: Paginated results are fully collected
    Given Gmail returns 3 pages of message ids
    When message ids are listed with maxMessages 200
    Then ids from all 3 pages are returned
    And truncated is false

  Scenario: A very large mailbox is capped and reported
    Given Gmail has 500 matching messages
    When message ids are listed with maxMessages 200
    Then exactly 200 ids are returned
    And truncated is true

  Scenario: base64url bodies decode without corruption
    Given a message part encoded as base64url with "-" and "_" and no padding
    When the plain text is extracted
    Then the decoded text matches the original exactly

  Scenario: Plain text wins over HTML
    Given a multipart/alternative message with both text/plain and text/html
    When the plain text is extracted
    Then the text/plain content is returned

  Scenario: Attachments are not treated as body text
    Given a multipart/mixed message with a text/plain part and a PDF attachment part
    When the plain text is extracted
    Then only the text/plain content is returned

  Scenario: Access tokens are reused within their lifetime
    Given a cached access token with 10 minutes remaining
    When two messages are fetched in the same container
    Then the token endpoint is called zero additional times

  Scenario: A revoked grant asks the user to reconnect
    Given the token endpoint returns 400 invalid_grant
    When an access token is requested
    Then a ReauthRequiredError is raised
    And the connection lastScanStatus becomes "reauth_required"

  Scenario: Rate limiting is retried, forbidden is not
    Given Gmail returns 429 twice then 200
    When a message is fetched
    Then the fetch succeeds after 3 attempts
    Given Gmail returns 403
    When a message is fetched
    Then no retry is attempted

  Scenario: One bad message does not sink the scan
    Given 5 candidate messages where the third fails to parse
    When candidate messages are fetched
    Then 4 messages are returned
    And the errors array names the third message id

  Scenario: Message content stays out of the logs
    Given a message with subject "Excursion payment overdue"
    When it is fetched
    Then no log line contains "Excursion payment overdue"
```

## Additional Context
