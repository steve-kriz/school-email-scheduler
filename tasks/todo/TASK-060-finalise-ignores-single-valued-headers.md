---
id: TASK-060
title: finalise inspects only multiValueHeaders, so a single-valued headers response bypasses the invariant
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: medium
---

## Description
`src/lambda/calendar/index.mjs:331-332`:

```js
const headers = response.multiValueHeaders;
if (!headers ...) return response;
```

An ALB response may legitimately carry `headers` (single-valued) instead of
`multiValueHeaders`. A hand-rolled response — exactly the case `finalise` was
built to defend against — is the one most likely to use the simpler shape. This
passes through completely untouched:

```js
{ statusCode: 200, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true' } }
```

No test covers a `headers`-shaped response.

TASK-022's AC says the strip applies to any response the router returns. It is
currently half met: the choke point is bypassable by the very class of response
it exists to catch.

## Impact If Not Fixed
The credentials-vs-wildcard invariant — the security property TASK-022 was
raised to make un-bypassable — can be defeated by a route that simply uses
`headers` instead of `multiValueHeaders`. TASK-004's credentialed-CORS work
could ship such a route pairing `*` with `Access-Control-Allow-Credentials`, and
the guard would stay silent and the suite green.

## Acceptance Criteria
- [ ] `finalise` inspects and sanitises both `headers` and `multiValueHeaders`.
- [ ] A `headers`-shaped response with wildcard origin plus credentials has the credentials header stripped.
- [ ] A `headers`-shaped response with a specific origin keeps its credentials header.
- [ ] A response carrying BOTH shapes is sanitised in both.
- [ ] Each case is pinned by mutation: disabling the new branch reddens a test, with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The credentials invariant holds for every response shape
  Scenario Outline: A wildcard origin never ships with credentials
    Given a hand-rolled response using <shape> with origin "*" and credentials "true"
    When the router finalises it
    Then the credentials header is absent
    Examples:
      | shape             |
      | headers           |
      | multiValueHeaders |
      | both              |

  Scenario: A specific origin keeps its credentials header
    Given a hand-rolled response using headers with a specific origin and credentials
    When the router finalises it
    Then the credentials header is retained
```

## Additional Context
