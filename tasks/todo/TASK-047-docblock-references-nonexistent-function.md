---
id: TASK-047
title: A settings docblock points at isPublicMailBrand, which does not exist
status: todo
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-032
severity: low
---

## Description
`src/lambda/calendar/backend/settings.mjs:92` says "See `isPublicMailBrand`
below". `isPublicMailBrand` appears nowhere in the repository — the review
grepped for it and found no definition, no export and no other reference.

The intended referents are `PUBLIC_MAIL_BRANDS` and `isPublicMailDomain`.

## Impact If Not Fixed
That cross-reference sits in the docblock whose entire job is to stop a later
reader "fixing" the deliberate `mail.gmail.com` subdomain allowance into a suffix
match. A reader who follows the pointer to check the subdomain rule finds
nothing, and may conclude the second-line brand check was never built — the
wrong lesson, from the one comment specifically written to prevent it.

## Acceptance Criteria
- [ ] The reference names a symbol that actually exists (`PUBLIC_MAIL_BRANDS` and/or `isPublicMailDomain`).
- [ ] A test or check asserts that identifiers cited in these blocklist docblocks resolve to real exports, so the next stale reference is caught rather than shipped.
- [ ] The subdomain intent the docblock exists to protect is still stated clearly.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Docblock cross-references resolve
  Scenario: Every identifier cited in the blocklist docblocks exists
    Given the settings module docblocks
    When each cited identifier is resolved against the module's exports
    Then every one resolves

  Scenario: A stale reference is caught
    Given a docblock citing a symbol that does not exist
    When the suite runs
    Then at least one test fails
```

## Additional Context
