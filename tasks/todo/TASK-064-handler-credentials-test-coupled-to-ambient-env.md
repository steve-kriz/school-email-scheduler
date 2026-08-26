---
id: TASK-064
title: The handler-level credentials test depends on ALLOWED_ORIGINS being unset in the test process
status: todo
created: 2026-08-18T08:05:00.000Z
updated: 2026-08-18T08:05:00.000Z
review-of: TASK-022
severity: low
---

## Description
`tests/e2e/calendar-lambda.test.js:330` asserts `Access-Control-Allow-Origin` is
`*`. That only holds because `ALLOWED_ORIGINS` happens to be unset in the test
process: the module reads it once at import time
(`src/lambda/calendar/index.mjs:85`), and the test never sets or clears it.

A developer or CI runner with `ALLOWED_ORIGINS` exported — entirely plausible
when reproducing a production config locally — turns this into a hard red with a
misleading message.

Fix: control the environment explicitly for this test (set or delete the var and
re-import the module), restoring it in a `finally`, so the assertion depends on
the scenario rather than on ambient state.

Note this assertion was *added* by TASK-022 to replace a tautological
absence-only check. It is a genuine improvement — the goal here is to keep its
strength while removing the environmental coupling.

## Impact If Not Fixed
An environment-dependent failure will be read as a code regression and burn
debugging time. The likely "fix" under time pressure is to weaken the assertion
back to the absence-only check TASK-022 just removed, silently undoing that
work.

## Acceptance Criteria
- [ ] The test explicitly controls `ALLOWED_ORIGINS` rather than relying on it being unset.
- [ ] The variable is restored in a `finally` so it cannot leak into other tests.
- [ ] The test passes with `ALLOWED_ORIGINS` set to an arbitrary value in the ambient environment.
- [ ] The assertion remains as strong as it is today — it must still fail if a wildcard origin ships with credentials.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Handler CORS tests are independent of ambient environment
  Scenario: The credentials test passes with ALLOWED_ORIGINS exported
    Given ALLOWED_ORIGINS is set in the environment before the suite runs
    When the handler credentials test runs
    Then it passes

  Scenario: The assertion still catches the regression
    Given a wildcard origin response is made to carry credentials
    When the test runs
    Then it fails
```

## Additional Context
