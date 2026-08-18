---
id: TASK-036
title: Retry-After in the past gives zero spacing, plus three untested Gmail paths
status: todo
created: 2026-08-18T03:35:00Z
updated: 2026-08-18T03:35:00Z
review-of: TASK-006
---

## Description
Four low findings from the TASK-006 review. None is failing today; none has a
security or data consequence.

### 1. A `Retry-After` HTTP-date in the past yields zero backoff
`src/lambda/calendar/backend/gmail.mjs:296` resolves an HTTP-date `Retry-After`
against the injected `now`, and `:328-329` clamps with `Math.max(0, at - now)`.
When Google sends a date already in the past — or the container's clock is skewed
ahead — the header resolves to `0`, and `backoffDelayMs` then returns `0`. The
result is up to four back-to-back retries against an endpoint that just asked us
to slow down.

Bounded by `MAX_ATTEMPTS` (4), so the blast radius is four immediate requests
rather than a hot loop. Fix by flooring a header-derived delay at one base step
(`RETRY_BASE_DELAY_MS`) when it resolves to `0`, rather than trusting a past date
to mean "retry immediately".

### 2. The transport-error retry path is untested
`gmail.mjs:429-439` retries a thrown `fetchImpl` error (a network failure, as
distinct from an HTTP error status). Making that path non-retryable would go
undetected — no test drives a thrown transport error.

### 3. `no_search_domains` propagation through `fetchCandidateMessages` is untested
`buildQuery` throws `code: "no_search_domains"` when the domain list is empty,
which is the guard preventing a bare `after:` query from scanning the user's
entire mailbox. That throw is tested at the `buildQuery` level, but nothing
asserts `fetchCandidateMessages` **propagates** it when the domains resolve empty
from the connection. Swallowing it — e.g. catching it into `errors[]` like a
per-message failure — would go undetected, and the consequence would be a
whole-mailbox scan.

### 4. Docblock/code mismatch on the token freshness boundary
`getAccessToken`'s docblock says a token is reused when "more than
`TOKEN_EXPIRY_SKEW_SECONDS`" remain, while `isTokenFresh`
(`google-token.mjs:158`) uses `>=`, so a token with exactly 60 seconds left is
reused. One second, harmless — comment versus code only. Fix the comment, not the
code.

## Impact If Not Fixed
Finding 1 makes the retry policy briefly ineffective exactly when it matters —
under rate limiting with a skewed clock — turning a backoff into four immediate
retries and making a `429` more likely to exhaust its attempts and fail the scan.
Minor and bounded, but it defeats the purpose of honouring the header at all.

Findings 2 and 3 are real code paths that can regress with the suite green.
Finding 3 is the one worth caring about: the guard it leaves unpinned is the one
standing between a configured scan and reading the user's entire mailbox through
the Anthropic model — the same outcome TASK-032's blocklist exists to prevent,
reached by a different route. It is low only because the throw is tested one level
down and nothing currently swallows it.

Finding 4 costs nothing but will mislead the next reader of the cache logic.

## Acceptance Criteria
- [ ] A `Retry-After` HTTP-date in the past yields at least one base step of
      delay, not `0`.
- [ ] A test drives that case with an injected `now` ahead of the header date and
      asserts the resulting delay is non-zero.
- [ ] A seconds-form `Retry-After` and a valid future HTTP-date still behave as
      they do today, and remain clamped to `RETRY_MAX_DELAY_MS`.
- [ ] A test drives a thrown transport error from `fetchImpl` and asserts it is
      retried; making that path non-retryable reddens a test.
- [ ] A test asserts `fetchCandidateMessages` propagates the
      `no_search_domains` error rather than collecting it into `errors[]`;
      swallowing it reddens a test.
- [ ] `getAccessToken`'s docblock matches `isTokenFresh`'s `>=` boundary.
- [ ] Every mutation is asserted to have applied on disk before its result is
      trusted.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Retry edges and previously untested paths
  Scenario: A past Retry-After date does not mean retry immediately
    Given a Retry-After HTTP-date earlier than the injected now
    When the delay is computed
    Then it is at least one base step

  Scenario: A future Retry-After date is still honoured and clamped
    Given a Retry-After HTTP-date one hour ahead
    When the delay is computed
    Then it equals the maximum delay

  Scenario: A transport error is retried
    Given fetchImpl throws a network error twice then succeeds
    When a message is fetched
    Then the fetch succeeds and two retries occurred

  Scenario: An empty domain list aborts the scan rather than scanning everything
    Given a connection whose searchDomains resolve empty
    When fetchCandidateMessages runs
    Then it throws no_search_domains
    And no Gmail list request is made
```

## Additional Context
