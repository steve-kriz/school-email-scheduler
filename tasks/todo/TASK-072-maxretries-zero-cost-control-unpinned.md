---
id: TASK-072
title: The maxRetries zero cost control is unpinned and untestable as written
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: low
---

## Description
`getClient()` (`src/lambda/calendar/backend/anthropic.mjs:697-706`) passes
`maxRetries: 0` to the Anthropic SDK. That single option is the only thing
preventing our own 4 attempts from composing with the SDK's default 2 retries
into **12 HTTP calls per email**. The coder discovered this composition while
building the ticket and closed it deliberately.

It cannot be tested as written: `loadSdk()` (`:673-676`) uses a non-injectable
static `import("@anthropic-ai/sdk")`, so no test can reach `getClient()` or
observe the option.

Fix: make the SDK loader injectable (a `loadSdk` dep defaulting to the real
import) so a test can assert the client is constructed with `maxRetries: 0`.

## Impact If Not Fixed
Dropping `{ maxRetries: 0 }` in a future edit triples worst-case spend per email
during a transient outage, with nothing to catch it. The reasoning behind the
option lives only in a code comment and this ticket, so the next person to touch
client construction has no failing test to warn them.

## Acceptance Criteria
- [ ] The SDK loader is injectable, defaulting to the real lazy import so production behaviour is unchanged.
- [ ] The lazy import remains lazy — no eager SDK import at module load (`node_modules` is not installed in this repo).
- [ ] A test asserts the client is constructed with `maxRetries: 0`.
- [ ] Removing `maxRetries: 0` reddens that test, verified by mutation with the mutation confirmed to have applied.
- [ ] The full suite passes without `node_modules` present.

## Cucumber Tests
```gherkin
Feature: Our retry policy is not multiplied by the SDK's
  Scenario: The client disables SDK-level retries
    Given the SDK loader is stubbed
    When the client is constructed
    Then it is constructed with maxRetries 0

  Scenario: Re-enabling SDK retries is caught
    Given maxRetries 0 is removed from client construction
    When the suite runs
    Then at least one test fails

  Scenario: The SDK is never imported eagerly
    Given node_modules is absent
    When the module is imported
    Then no error is raised
```

## Additional Context
