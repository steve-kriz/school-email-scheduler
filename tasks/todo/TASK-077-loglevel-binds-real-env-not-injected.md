---
id: TASK-077
title: LOG_LEVEL binds the real process.env at import, so the tests' injected CALENDAR_LOG_LEVEL is dead config
status: todo
created: 2026-08-18T08:30:00.000Z
updated: 2026-08-18T08:30:00.000Z
review-of: TASK-026
severity: medium
---

## Description
`LOG_LEVEL` in `src/lambda/calendar/index.mjs` is a module-level constant bound
to the real `process.env.CALENDAR_LOG_LEVEL` **at import time**. It does not read
the `env` object the tests inject through deps.

Consequence: the e2e tests' `CALENDAR_LOG_LEVEL: 'verbose'` field is dead
configuration. `logVerbose` never fires under a normal `node --test` run, nor
under `npm test` or `npm run test:e2e` — neither sets a real environment
variable.

This was found during TASK-026 while proving that the
`'should not leak secrets in logs'` assertion could actually fail. It only
passes convincingly when the log line is forced to execute: with
`CALENDAR_LOG_LEVEL=verbose` set as a REAL env var, the pre-fix (un-awaited) test
correctly failed. Under the suite as CI actually invokes it, the log statement
does not run at all.

Fix: make the log level resolvable from the injected `env` (with the real
`process.env` as the default), so the log-hygiene assertions exercise the code
path they name.

## Impact If Not Fixed
The log-hygiene tests — the ones asserting no client secret, token, body or
sender reaches the logs — largely pass because the logging code never executes
under test, not because it is clean. A regression that started logging a secret
at verbose level would ship green, and the assertion that was supposed to catch
it would be measuring nothing.

## Acceptance Criteria
- [ ] The log level is resolved from the injected `env` when one is supplied, defaulting to `process.env` otherwise.
- [ ] Setting `CALENDAR_LOG_LEVEL: 'verbose'` via injected deps genuinely enables `logVerbose` under a plain `node --test` run.
- [ ] The existing log-hygiene assertions are re-verified under a run where the log lines actually execute, and any that only passed vacuously are reported.
- [ ] A test proves a planted secret in a verbose log line IS caught — i.e. the assertion can fail.
- [ ] No real environment variable is required for the suite to exercise these paths.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Log-hygiene tests exercise the logging they assert on
  Scenario: Injected verbose level enables verbose logging
    Given the handler is invoked with an injected env setting the log level to verbose
    When a verbose log line is reached
    Then it is emitted

  Scenario: A planted secret in a verbose log is caught
    Given a verbose log line is made to include a client secret
    When the log-hygiene test runs
    Then it fails
```

## Additional Context
Found by the TASK-026 coder while mutation-testing the leak assertion. It
correctly left the fix out of scope and reported it.
