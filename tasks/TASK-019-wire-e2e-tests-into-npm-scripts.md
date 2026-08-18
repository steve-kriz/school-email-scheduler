---
id: TASK-019
title: Wire the node:test e2e suite into the npm scripts so CI actually runs it
status: todo
created: 2026-08-18T00:12:00Z
updated: 2026-08-18T00:12:00Z
review-of: TASK-012
---

## Description
Every e2e test written so far uses `node:test` (`describe`/`it` from
`node:test`, `node:assert`), but no npm script runs them:

- `test` and `test:unit` → `node --test tests/unit` — `tests/e2e` is not included.
- `test:e2e` → `playwright test` — Playwright will not execute
  `node:test`-style files as intended, and no Playwright config or dependency
  is installed anyway.

The affected files, all currently unrun by `npm test`:
`tests/e2e/terraform-scaffold.test.js` (10 tests),
`tests/e2e/dynamodb-calendar.test.js` (19),
`tests/e2e/check-oauth-config.test.js` (38).

That is 67 assertions — including the leak-safety guards that prove
`check-oauth-config.mjs` never emits key material, and the redirect-URI drift
guard that compares the runbook against the tfvars — which pass only when
someone runs `node --test tests/unit tests/e2e` manually.

This is cross-cutting, not specific to TASK-012: every later ticket writes e2e
scenarios into `tests/e2e/`, so until this is fixed each one adds more tests
that CI silently skips.

Fix the scripts so a single obvious command runs everything:
- `test` → runs both directories (`node --test tests/unit tests/e2e`).
- Keep `test:unit` scoped to `tests/unit` for a fast inner loop.
- Add `test:e2e` → `node --test tests/e2e`, replacing the Playwright
  invocation. TASK-001 copied the Playwright scripts from `ohq-chatbot2`, but no
  Playwright config or dependency exists in this repo and every test written so
  far is `node:test`, so the Playwright scripts are aspirational rather than
  functional.
- Decide what to do with `test:bdd`, `test:bdd:headed`, `test:bdd:report`,
  `test:e2e:headed`, `test:e2e:ui` and `test:e2e:report`, which all invoke
  `playwright`/`bddgen` binaries that are not installed. Either remove them, or
  keep them and move `@playwright/test` and `playwright-bdd` from
  `devDependencies` into an installed state with a working config. Do **not**
  leave scripts that fail with "command not found" — state which option you
  chose and why in your summary.
- `test:unit:coverage` should keep working.

Do not change any test file's contents in this ticket. This is a wiring fix.

## Impact If Not Fixed
The tests that guarantee the security properties of this codebase do not run in
CI. A future edit that leaks a secret value into an error path of
`check-oauth-config.mjs`, or that drifts a tenant's redirect URI away from its
`hosted_zone`, would merge with a green `npm test` because the assertions that
catch those cases live in `tests/e2e/` and are never executed. The problem
compounds with every ticket: each one adds e2e scenarios that appear to protect
the codebase while contributing nothing to the actual gate.

## Acceptance Criteria
- [ ] `npm test` executes the tests in both `tests/unit` and `tests/e2e`.
- [ ] The count reported by `npm test` matches the count from
      `node --test tests/unit tests/e2e` — no test is silently excluded.
- [ ] `npm run test:unit` still runs only `tests/unit`.
- [ ] `npm run test:e2e` runs the `node:test` e2e suite and does not invoke
      Playwright.
- [ ] `npm run test:unit:coverage` still works.
- [ ] No npm script remains that invokes a binary which is not installed —
      either the script is removed or the dependency is installed with a working
      config.
- [ ] No test file's assertions are modified by this ticket.
- [ ] Every script defined in `package.json` exits 0 on a clean checkout (or is
      documented as requiring an argument, like `check:oauth-config`).
- [ ] `package.json` remains valid JSON and the `check:oauth-config` script is
      preserved.

## Cucumber Tests
```gherkin
Feature: The test suite that CI runs includes the e2e scenarios
  Scenario: npm test runs both directories
    When "npm test" is run
    Then the reported test count equals the count from "node --test tests/unit tests/e2e"
    And the run includes tests from tests/e2e

  Scenario: The fast inner loop is still scoped
    When "npm run test:unit" is run
    Then it runs only tests under tests/unit

  Scenario: The e2e script no longer invokes Playwright
    Given package.json
    Then the test:e2e script does not invoke "playwright"

  Scenario: No script invokes a missing binary
    Given every script in package.json
    Then none invokes a binary absent from node_modules and absent from the repo

  Scenario: Leak-safety guards now run under the CI command
    When "npm test" is run
    Then the check-oauth-config leak-safety scenarios are executed

  Scenario: Test assertions were not altered
    Given the test files before and after this ticket
    Then their assertions are unchanged

  Scenario: package.json stays valid
    Given package.json
    Then it parses as JSON
    And it still defines "check:oauth-config"
```

## Additional Context
