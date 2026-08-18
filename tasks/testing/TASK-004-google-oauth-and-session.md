---
id: TASK-004
title: Google OAuth sign-in, session cookie, and encrypted refresh-token storage
status: failed-testing
created: 2026-08-17T11:00:00Z
updated: 2026-08-18T01:52:51Z
depends-on: TASK-003
activities: [{"activity":"code","model":"claude-opus-5","note":"worktree 021a249 merged; 16/17 security checks verified by execution"},{"activity":"test","model":"claude-haiku-4-5","tokens":90645,"note":"attempt 1/3: 167 tests green but mutation testing found the plaintext-canary test tautological (mock performs the invariant) and timingSafeEqual unasserted; returned"}]
---

## Description
Let the user sign in with their Google account. The Google grant is both the
site login and the Gmail read authorisation — there is no second identity
provider. The refresh token is encrypted with the project CMK and stored in the
connections table; the site session is a signed cookie.

Depends on TASK-003 (needs the handler, env vars, IAM and tables).

New files:
- `src/lambda/calendar/backend/google-oauth.mjs`
- `src/lambda/calendar/backend/session.mjs`
- `src/lambda/calendar/backend/crypto.mjs`
- `src/lambda/calendar/backend/connections.mjs`

Routes to add to `index.mjs`:
- `GET /calendar/api/auth/google/start` — build the Google authorisation URL and
  `302` to it. Scopes: `openid`, `email`, `profile`,
  `https://www.googleapis.com/auth/gmail.readonly`. Include
  `access_type=offline` and `prompt=consent` so a refresh token is actually
  issued (Google omits it on repeat consent without `prompt=consent`).
  Generate a random `state` and a PKCE `code_verifier`; store both in a
  short-lived (10 minute) `HttpOnly` cookie and send `code_challenge`
  (S256) to Google.
- `GET /calendar/api/auth/google/callback` — verify `state` matches the cookie
  (reject with `400` if absent or mismatched — this is the CSRF defence),
  exchange `code` + `code_verifier` at `https://oauth2.googleapis.com/token`,
  validate the returned `id_token`'s `iss`/`aud`/`exp` and read `sub` and
  `email` from it, encrypt the `refresh_token` with KMS, upsert the connection
  row, set the session cookie, and `302` to `/calendar`.
- `POST /calendar/api/auth/logout` — clear the session cookie and `204`.
- `GET /calendar/api/auth/me` — `200` with `{ email, schoolName, connected }`
  for a valid session, `401` otherwise.

`session.mjs` — sessions are stateless signed cookies, not server records.
Payload `{ sub, email, iat, exp }` base64url-encoded, followed by an
HMAC-SHA256 over the payload keyed with `SESSION_SECRET`. Verify with
`crypto.timingSafeEqual` (never `===`, which leaks via timing) and reject an
expired `exp`. Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/calendar`, `Max-Age` 7 days. Export a `requireSession(event)` helper
that returns the claims or throws a 401-shaped error, for later tickets to
reuse on every authenticated route.

`crypto.mjs` — `encryptSecret(plaintext)` / `decryptSecret(ciphertext)` over
`@aws-sdk/client-kms` using `CALENDAR_KMS_KEY_ID`, returning/accepting base64.
Include the key ARN alongside the ciphertext so rotation is detectable.

`connections.mjs` — `getConnection(userId)`, `putConnection(...)`,
`updateConnection(userId, patch)`. **Never return `refreshTokenEnc` to any
caller outside this module**; expose a separate
`getRefreshToken(userId)` that decrypts in place. Anything that serialises a
connection for an HTTP response must go through a `toPublicJson` projection.

Security requirements that are part of the work, not optional polish:
- Never log the authorisation code, the access token, the refresh token, the
  `id_token`, the session secret, or the cookie value — at any log level,
  including `verbose`.
- Treat the OAuth `redirect_uri` as `${PUBLIC_BASE_URL}/calendar/api/auth/google/callback`
  computed server-side; never accept a redirect target from the query string.
- Reject the callback when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or
  `SESSION_SECRET` is empty, with a `500` and a log line that names the missing
  variable but prints no value.

## Acceptance Criteria
- [ ] `GET /calendar/api/auth/google/start` returns `302` to
      `accounts.google.com` with `scope` containing `gmail.readonly`,
      `access_type=offline`, `prompt=consent`, a `state` parameter, and
      `code_challenge_method=S256`.
- [ ] The `state` and `code_verifier` are stored in an `HttpOnly` cookie that
      expires within 10 minutes, and are not present in the redirect URL body.
- [ ] The callback returns `400` when `state` is missing, and `400` when
      `state` does not match the cookie value.
- [ ] On a successful callback the refresh token is written as base64 KMS
      ciphertext to `refreshTokenEnc`, and the plaintext value appears nowhere
      in the stored item.
- [ ] On a successful callback the response sets a session cookie carrying
      `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/calendar`, and a `Max-Age`
      of 7 days, and returns `302` to `/calendar`.
- [ ] A tampered session cookie (payload edited, signature unchanged) is
      rejected with `401`.
- [ ] An expired session cookie (`exp` in the past, signature valid) is
      rejected with `401`.
- [ ] Signature comparison uses `crypto.timingSafeEqual`; the source contains
      no `===` comparison of two HMAC values.
- [ ] `GET /calendar/api/auth/me` returns `200` with `email`, `schoolName` and
      `connected` for a valid session and `401` without one.
- [ ] `POST /calendar/api/auth/logout` returns `204` and sets a cookie that
      expires the session immediately.
- [ ] No HTTP response body from any route in this ticket contains
      `refreshTokenEnc`, a refresh token, an access token, or an `id_token`.
- [ ] No log statement emits the authorisation code, any token, the session
      secret, or the cookie value at any log level.
- [ ] The `redirect_uri` is derived from `PUBLIC_BASE_URL` server-side; no route
      reads a redirect target from user input.
- [ ] The callback returns `500` with a variable-name-only log line when
      `GOOGLE_CLIENT_SECRET` or `SESSION_SECRET` is empty.
- [ ] All KMS and DynamoDB calls are mocked in tests; no test opens a real
      AWS connection.

## Cucumber Tests
```gherkin
Feature: Google sign-in and session handling
  Scenario: Starting sign-in redirects to Google with Gmail read scope
    Given an unauthenticated visitor
    When they request "/calendar/api/auth/google/start"
    Then the response status code is 302
    And the Location header host is "accounts.google.com"
    And the Location query contains "gmail.readonly"
    And the Location query contains "access_type=offline"
    And the Location query contains "code_challenge_method=S256"

  Scenario: A callback without state is rejected
    Given a visitor with no oauth state cookie
    When they request the callback with a code but no state
    Then the response status code is 400
    And no connection row is written

  Scenario: A callback whose state does not match the cookie is rejected
    Given an oauth state cookie holding "abc123"
    When the callback is requested with state "def456"
    Then the response status code is 400
    And no connection row is written

  Scenario: A successful callback stores only the encrypted refresh token
    Given Google returns a refresh token "rt-secret-value" and a valid id_token
    When the callback completes
    Then the stored item has a "refreshTokenEnc" attribute
    And no stored attribute value equals "rt-secret-value"
    And the response status code is 302

  Scenario: A tampered session cookie is refused
    Given a session cookie whose payload was edited after signing
    When "/calendar/api/auth/me" is requested with that cookie
    Then the response status code is 401

  Scenario: An expired session is refused even though the signature is valid
    Given a correctly signed session cookie whose exp is one hour in the past
    When "/calendar/api/auth/me" is requested with that cookie
    Then the response status code is 401

  Scenario: Session cookies are not readable by scripts
    Given a successful sign-in
    Then the Set-Cookie header contains "HttpOnly" and "Secure" and "SameSite=Lax"

  Scenario: Tokens never reach the client
    Given an authenticated user
    When "/calendar/api/auth/me" is requested
    Then the response body does not contain "refreshTokenEnc"
    And the response body does not contain an access token

  Scenario: Misconfiguration fails loudly without leaking the secret
    Given SESSION_SECRET is an empty string
    When the callback is requested
    Then the response status code is 500
    And the log output names "SESSION_SECRET" but contains no secret value

  Scenario: Logging out invalidates the browser session
    Given an authenticated user
    When they POST "/calendar/api/auth/logout"
    Then the response status code is 204
    And the Set-Cookie header expires the session cookie immediately
```

## Additional Context
