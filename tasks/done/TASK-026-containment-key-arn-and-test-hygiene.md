---
id: TASK-026
title: Containment gap (KMS key ARN survives stripSecrets) plus two e2e test-hygiene defects
status: done
created: 2026-08-18T02:10:00Z
updated: 2026-08-18T09:40:00.000Z
activities: [{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T08:30:00.000Z","finishedAt":"2026-08-18T08:55:00.000Z","tokensIn":62556,"note":"GREEN 214/214 (140 unit + 41 + 33 e2e), 825ms. Exhaustive containment sweep: only 3 return paths in connections.mjs (:344/:446/:489) all via stripSecrets, no list/query, no error path echoes a raw item, HTTP responses go through toPublicJson allow-list. SECRET_ATTRIBUTES mutation -> 5 red. Tester reported HONESTLY that the leak assertion is structurally sound but currently VACUOUS - it passes because logs are empty, not because nothing leaks (TASK-077); says do not count it toward security guarantees until fixed"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T09:25:00.000Z","finishedAt":"2026-08-18T09:40:00.000Z","tokensIn":82005,"note":"VERDICT ACCEPT (read-only reviewer, disclosed). Containment sweep independently confirmed exhaustive: 3 return paths all via stripSecrets, error paths carry only err.name/message, settings.mjs spreads the projection not the connection, ddbGetItem has no external caller. CORRECTION IN THE TICKETS FAVOUR: capturedLogs is NOT empty - LOG_LEVEL defaults to basic so logBasic at index.mjs:1037 does fire and is captured, so the leak assertion is PARTIALLY vacuous, not wholly. Also judged the ARN only modestly sensitive (same value sits in the Lambda env as CALENDAR_KMS_KEY_ID) but found the docblock does not overclaim. 5 findings -> TASK-089..093; most serious is A: putConnection rejects a caller-supplied refreshTokenEnc but NOT refreshTokenKeyId"}]
review-of: TASK-004
---

## Description
Three low-severity findings from the TASK-004 review, consolidated. The first is
in source, the other two are test hygiene. They are independent of each other;
they share a ticket only because all three are low and all three came from the
same review.

### 1. `stripSecrets` leaves the KMS key ARN on every returned object
`SECRET_ATTRIBUTES = ["refreshTokenEnc"]`
(`src/lambda/calendar/backend/connections.mjs:35`), so `stripSecrets`
(`:184-193`) returns objects that still carry `refreshTokenKeyId` — the KMS CMK
ARN wrapping the user's Gmail refresh token. `getConnection`, `putConnection`
and `updateConnection` all return `stripSecrets(...)`, so the ARN reaches every
caller of those functions.

There is **no leak today**: `handleAuthMe` routes the connection through the
allow-list `toPublicJson`, so the ARN reaches neither responses nor logs. This
is a defence-in-depth gap, and it matters because it contradicts a guarantee the
code states about itself. `crypto.mjs:21-24` explicitly designates the key id as
material that must never be logged — *"a ciphertext plus a key ARN is still
material an attacker can work with"* — while the containment docblock in
`connections.mjs:11` promises only that `refreshTokenEnc` never leaves the
module and is silent on the key ARN. So the module that owns containment does not
strip the attribute that its sibling module declares sensitive.

Fix: add `refreshTokenKeyId` to `SECRET_ATTRIBUTES`. `getRefreshToken` reads the
raw item directly rather than going through `stripSecrets`, so the decrypt path
is unaffected — confirm that while making the change.

### 2. `afterEach` never restores `console.log`
`tests/e2e/calendar-auth-routes.test.js:78-82` does:

```js
const originalLog = console.log;
console.log = originalLog;
```

This captures the already-overridden wrapper and reassigns it to itself. The real
`console.log` is never restored, so the monkey-patch leaks past the suite and
each `beforeEach` stacks another wrapper on the previous one.

The review confirmed this **cannot cause a false pass on this ticket**: stacked
wrappers push *duplicate* entries into `capturedLogs`, which is reset each
`beforeEach`, so the log-leak assertions scan more output than intended, never
less. Record that in the fix so nobody re-diagnoses it as a live leak. The real
risk is cross-file interference once other suites share the process.

### 3. An unawaited handler call in a synchronous `it`
`tests/e2e/calendar-auth-routes.test.js:193-206` calls `handler(...)` without
`await` inside a synchronous `it`. It currently observes the logs it asserts on
because `handleAuthStart` has no internal `await` and does its logging
synchronously before the handler's promise suspends.

That is a real assertion resting on an implementation detail. The moment
`handleAuthStart` gains any `await` before its log line — a config fetch, a
metrics call — the assertion silently stops observing logs and goes vacuously
green. Await the handler and make the `it` async.

## Impact If Not Fixed
Finding 1 is the one with security consequence, though only latently: a future
route or debug log that emits a connection row would disclose the CMK ARN
wrapping every user's Gmail refresh token. That gives an attacker with another
foothold a concrete target, and it would happen silently, because the
containment mechanism a developer would reasonably trust to strip secrets does
not strip this one. The fix is a one-word addition to an array.

Findings 2 and 3 have no current correctness impact, and neither is producing a
false pass today. They are on this board because finding 3 is a log-hygiene
assertion — part of the "no token ever reaches a log" guarantee — that would go
vacuously green rather than red if the code it guards changed shape. This
project has already found fourteen assertions that passed regardless of the
code; this is a fifteenth waiting for one `await` to be added elsewhere.

## Acceptance Criteria
- [ ] `refreshTokenKeyId` is included in `SECRET_ATTRIBUTES`.
- [ ] A test asserts `getConnection`, `putConnection` and `updateConnection`
      return objects carrying neither `refreshTokenEnc` nor `refreshTokenKeyId`.
- [ ] A test asserts `getRefreshToken` still decrypts correctly after the
      change — the raw-item read path is unaffected.
- [ ] Removing `refreshTokenKeyId` from `SECRET_ATTRIBUTES` turns at least one
      test red, verified by mutation.
- [ ] The `connections.mjs` containment docblock names the key ARN alongside
      `refreshTokenEnc`, so the stated guarantee matches the code.
- [ ] `afterEach` restores the genuine original `console.log`, captured before
      the first override, and a test proves no wrapper survives the suite.
- [ ] The `beforeEach`/`afterEach` pair cannot stack wrappers across tests.
- [ ] The unawaited `handler(...)` call is awaited and its `it` is async.
- [ ] A comment records that the stacking bug inflated captured output rather
      than suppressing it, so it was never a false pass.
- [ ] Adding an `await` before the log line in `handleAuthStart` does **not**
      make the start-path log assertion vacuous — verified by temporarily
      inserting one and confirming the test still fails when a token is logged.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Containment covers the key ARN and the log-capture harness is sound
  Scenario Outline: No connection accessor returns key material
    When <accessor> returns a connection
    Then the result contains neither refreshTokenEnc nor refreshTokenKeyId
    Examples:
      | accessor         |
      | getConnection    |
      | putConnection    |
      | updateConnection |

  Scenario: The decrypt path still works
    Given a stored connection with an encrypted refresh token
    When getRefreshToken is called
    Then the plaintext is returned

  Scenario: Removing the key ARN from SECRET_ATTRIBUTES is caught
    Given a build where SECRET_ATTRIBUTES omits refreshTokenKeyId
    When the suite runs
    Then at least one test fails

  Scenario: console.log is genuinely restored
    Given the auth e2e suite has finished
    Then console.log is the original function
    And no capture wrapper remains installed

  Scenario: The start-path log assertion survives an added await
    Given handleAuthStart gains an await before its log line
    When a token is logged on that path
    Then the log-hygiene assertion still fails
```

## Additional Context
