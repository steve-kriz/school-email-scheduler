---
id: TASK-073
title: A genuine school email with zero events is reported as NOT_SCHOOL
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: low
---

## Description
`src/lambda/calendar/backend/anthropic.mjs:932-934` returns
`EXTRACTION_STATUS.NOT_SCHOOL` when the model reports
`isSchemaEmail: true, events: []` — i.e. a genuine school email that simply
contains no dated events.

That conflates two outcomes the system prompt itself explicitly distinguishes:
"An email can be a genuine school email and still contain no events"
(`anthropic.mjs:228`).

The e2e test at `tests/e2e/calendar-extraction-flow.test.js:705` accepts either
status, so the conflation is baked into the tests as acceptable.

Fix: introduce a distinct status (e.g. `SCHOOL_NO_EVENTS`) or carry the
`isSchoolEmail` flag alongside the status, and make the test assert one specific
outcome rather than either.

## Impact If Not Fixed
The `counts` an operator uses to judge extraction quality cannot separate "we
correctly ignored a retailer" from "we read the school newsletter and found
nothing in it". A silent extraction-quality regression — the model quietly
returning no events for real school mail — would show up as a healthy-looking
NOT_SCHOOL count and never be investigated.

## Acceptance Criteria
- [ ] A genuine school email with zero events is reported distinctly from a non-school email.
- [ ] The status enum (or an accompanying flag) makes the distinction machine-readable for metrics.
- [ ] The e2e assertion at `tests/e2e/calendar-extraction-flow.test.js:705` asserts one specific status, not either-of-two.
- [ ] Operator-facing counts distinguish the two outcomes.
- [ ] The change is pinned by mutation, with the mutation confirmed to have applied.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: School mail with no events is distinguishable from non-school mail
  Scenario: A school newsletter with no dates
    Given the model reports a school email containing no events
    When extraction completes
    Then the outcome is recorded as a school email with zero events

  Scenario: A retailer promotion
    Given the model reports a non-school email
    When extraction completes
    Then the outcome is recorded as not a school email

  Scenario: The two counts are separable
    Given one of each is scanned
    Then the operator counts report them separately
```

## Additional Context
