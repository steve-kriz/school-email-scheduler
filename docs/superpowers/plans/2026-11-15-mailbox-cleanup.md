# Mailbox Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings "Clean up mailbox" section that scans the whole Gmail mailbox for exact per-sender-domain counts and moves all mail from a chosen domain to Trash.

**Architecture:** Client-driven resumable chunks. The page repeatedly calls a "step" endpoint; each step does ~20s of Gmail work and persists progress as a `mailboxScan` map attribute on the user's existing connection row (no new table, no terraform change). Trashing uses `messages.batchModify` with the `TRASH` label after a server-computed exact count is confirmed by the user.

**Tech Stack:** Node ESM Lambda (`src/lambda/calendar`), Gmail REST via existing `gmailRequest`, DynamoDB via `connections.mjs` helpers, vanilla-JS frontend, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-mailbox-cleanup-design.md`

## Global Constraints

- Add scope `https://www.googleapis.com/auth/gmail.modify` (keep `gmail.readonly`). Move to Trash only (`addLabelIds: ["TRASH"]`); NEVER call `messages.delete` or `mail.google.com` scope.
- Never log sender addresses, domains, subjects, queries or bodies: only counts, statuses, opaque ids (gmail.mjs privacy rule).
- Every route requires a session (`resolveSession`, 401 otherwise); user id is derived from the session `sub` only, never the request.
- All new modules take injectable deps (`fetchImpl`, `getAccessToken`, `getConnection`, `updateConnection`, `now`, `sleep`, `log`) like gmail.mjs; tests never touch network or AWS.
- Step time budget 20s; batchModify chunks of 1000 ids; metadata gets use bounded concurrency 10.
- Trash is recoverable for 30 days; UI wording must say "Move to Trash".

## Review Focus

- Mailbox with zero mail / only Trash+Spam: scan finishes `done` with empty list, no error.
- `From` header with no address, display name only, or multiple addresses: counted under `(unknown)`, never throws.
- Two browser tabs stepping the same scan: stale step is rejected (409) instead of double-counting.
- Domain path param containing `from:`-style operators or spaces (e.g. `a.com OR from:b.com`): rejected 400, never forwarded to Gmail.
- User hasn't re-consented (no `gmail.modify`): trash returns 403 `reauth_required`, scan still works.

---

### Task 1: Request the modify scope and record whether it was granted

**Files:**
- Modify: `backend/google-oauth.mjs:47-52` (GOOGLE_SCOPES), `backend/connections.mjs` (PUBLIC_ATTRIBUTES), `index.mjs` callback (~line 729-780, where `putConnection` is called), `docs/google-oauth-setup.md:108-123`
- Test: `tests/unit/calendar-mailbox-scope.test.js`

**Interfaces:**
- Produces: `GOOGLE_SCOPES` includes `gmail.modify`; `hasModifyScope(scopeString: string): boolean` exported from `google-oauth.mjs`; connection row attribute `canModifyMail` (boolean) written by the callback from the token response `scope`, and listed in `PUBLIC_ATTRIBUTES`.

- [ ] **Step 1: Write failing tests** in the test file: `GOOGLE_SCOPES` contains both gmail scopes; `hasModifyScope("openid https://www.googleapis.com/auth/gmail.modify")` is true, `hasModifyScope("... gmail.readonly")` and `hasModifyScope("")` false; the auth callback (existing test harness style in `calendar-auth.test.js`) calls injected `putConnection` with `canModifyMail: true` when the exchanged tokens' `scope` includes modify and `false` otherwise.
- [ ] **Step 2:** Run `node --test tests/unit/calendar-mailbox-scope.test.js` - expect FAIL.
- [ ] **Step 3:** Implement the scope, `hasModifyScope`, pass `canModifyMail: hasModifyScope(tokens.scope)` into the `putConnection` item, add `"canModifyMail"` to `PUBLIC_ATTRIBUTES`. Update the doc: scope table gains the `gmail.modify` row (Restricted - "moves mail to Trash for mailbox cleanup") and replace the "Do not request gmail.modify" paragraph with a note that cleanup requires it and the console step "OAuth consent screen -> Scopes -> add gmail.modify".
- [ ] **Step 4:** Run the new test plus `node --test tests/unit/calendar-auth.test.js` - expect PASS (fix any existing assertion that pins the exact scope list).
- [ ] **Step 5: Commit** `feat: request gmail.modify and record canModifyMail`

### Task 2: Gmail primitives - sender domain, metadata fetch, batch trash

**Files:**
- Modify: `backend/gmail.mjs` (append exports)
- Test: `tests/unit/calendar-mailbox-gmail.test.js`

**Interfaces:**
- Produces:
  - `parseSenderDomain(fromHeader: string|undefined): string` - lower-cased domain of the first address via `normalizeDomain`; `"(unknown)"` if none.
  - `listMessageIdPage({ accessToken, query, pageToken, pageSize }, deps): Promise<{ ids: string[], nextPageToken: string|null, accessToken: string }>` - one page of `messages.list` (default pageSize 500; `query` may be empty string meaning all mail, with `includeSpamTrash=false`).
  - `getMessageSenderDomain({ accessToken, id }, deps): Promise<{ domain: string, accessToken: string }>` - `messages.get?format=metadata&metadataHeaders=From`.
  - `batchTrashMessages({ accessToken, ids }, deps): Promise<{ trashed: number, accessToken: string }>` - POST `messages/batchModify`, body `{ ids, addLabelIds: ["TRASH"] }`, throws if `ids.length > 1000`. `gmailRequest` currently only issues GET: extend it to accept `method`/`body` (default GET, unchanged behaviour) and keep all retry rules.
  - 403 from batchModify -> throw `GmailApiError` with `statusCode: 403` (existing no-retry rule).
- [ ] **Step 1: Write failing tests** with a stub `fetchImpl`: `parseSenderDomain` for `"Bob <bob@Mail.School.edu.au>"` -> `mail.school.edu.au`, `"a@x.com, b@y.com"` -> `x.com`, `"Just A Name"` -> `(unknown)`, `undefined` -> `(unknown)`; `listMessageIdPage` returns ids + `nextPageToken` and sends no `q` when query is empty; `getMessageSenderDomain` requests `format=metadata` and reads the From header case-insensitively; `batchTrashMessages` POSTs the exact JSON body with `addLabelIds:["TRASH"]`, rejects 1001 ids, and propagates 403 without retry; a 429 then 200 retries once.
- [ ] **Step 2:** Run it - expect FAIL.
- [ ] **Step 3:** Implement the four functions and the `method`/`body` extension of `gmailRequest` (JSON content-type only when a body is present).
- [ ] **Step 4:** Run it plus `node --test tests/unit/calendar-gmail.test.js` - expect PASS.
- [ ] **Step 5: Commit** `feat: gmail sender-domain listing and batch trash primitives`

### Task 3: Resumable mailbox scan (`backend/mailbox.mjs`)

**Files:**
- Create: `backend/mailbox.mjs`
- Test: `tests/unit/calendar-mailbox-scan.test.js`

**Interfaces:**
- Consumes: Task 2 functions; `getConnection`, `updateConnection(userId, patch)`, `connectionUserId` from `connections.mjs`; `getAccessToken` from `google-token.mjs`.
- Produces:
  - Stored shape on the connection row, attribute `mailboxScan`: `{ scanId: string, status: "running"|"done"|"error", pageToken: string|null, scanned: number, estimatedTotal: number, errors: number, domainCounts: Record<string, number>, startedAt: string, finishedAt: string|null }`. `domainCounts` keeps at most 5000 distinct domains; further new domains add to key `"(other)"`.
  - `startMailboxScan({ userId }, deps): Promise<MailboxScanState>` - fresh `scanId` (uuid), replaces any previous scan, `estimatedTotal` from `users/me/profile` `messagesTotal`.
  - `stepMailboxScan({ userId, scanId }, deps): Promise<MailboxScanState & { done: boolean }>` - loops list-page -> concurrent metadata gets (concurrency 10) until the budget (`deps.budgetMs`, default 20000, measured with injected `now`) or the mailbox ends; persists after every page; throws `MailboxError("stale_scan", 409)` if stored `scanId` differs; a message that fails fetch increments `errors`, scan continues.
  - `getMailboxDomains({ userId }, deps): Promise<{ status, scanned, estimatedTotal, finishedAt, errors, domains: {domain: string, count: number}[] }>` sorted by count desc then domain.
  - `class MailboxError extends Error { code: string; statusCode: number }`.
- [ ] **Step 1: Write failing tests** with in-memory fake connection store and stub Gmail deps: two pages of ids tally to correct domain counts and `done: true`; budget exhaustion mid-mailbox returns `done: false` and a following step resumes from the saved `pageToken` without recounting; empty mailbox -> `done`, `domains: []`; per-message failure counted in `errors`; stale `scanId` rejects with `stale_scan`/409; 5001st distinct domain lands in `(other)`; `(unknown)` From counted.
- [ ] **Step 2:** Run it - expect FAIL.
- [ ] **Step 3:** Implement the module. Use the connection row's existing update helper with the `mailboxScan` map (add `mailboxScan` handling to `buildConnectionPatch`/`buildUpdateParams` only if the generic patch cannot SET a nested map; do NOT add it to `PUBLIC_ATTRIBUTES` - the domain list is served by its own route). Log only counts.
- [ ] **Step 4:** Run it - expect PASS.
- [ ] **Step 5: Commit** `feat: resumable whole-mailbox sender-domain scan`

### Task 4: Trash a domain (count, confirm, execute)

**Files:**
- Modify: `backend/mailbox.mjs`
- Test: `tests/unit/calendar-mailbox-trash.test.js`

**Interfaces:**
- Produces:
  - `isValidCleanupDomain(domain: string): boolean` - true only for a plain hostname (letters, digits, dots, hyphens, at least one dot; max 253); false for spaces, `:`, quotes, parentheses, `OR`, etc. `(unknown)`/`(other)` are not trashable.
  - `countDomainMessages({ userId, domain }, deps): Promise<{ count: number }>` - pages ids for `from:{domain}` (never a text search), then re-verifies each id's sender domain equals `domain` or ends with `.{domain}`, returning only the verified `count` (nothing is persisted; the trash step recomputes).
  - `trashDomainMessages({ userId, domain, confirmCount }, deps): Promise<{ trashed: number, remaining: number, done: boolean }>` - re-lists + re-verifies ids, trashes up to the time budget in 1000-id `batchTrashMessages` chunks; if verified count at start exceeds `confirmCount` by more than 5% throw `MailboxError("count_changed", 409)`; if connection lacks `canModifyMail` throw `MailboxError("reauth_required", 403)`. Page calls repeat (`done:false`) until `remaining` is 0 - each call recomputes from Gmail so it is naturally resumable.
- [ ] **Step 1: Write failing tests:** `isValidCleanupDomain` accepts `school.edu.au`, rejects `a.com OR from:b.com`, `a b.com`, `(unknown)`, `localhost`; trash skips a listed id whose verified sender is a different domain (query-match false positive) and counts only verified ones; chunks of exactly 1000 (2500 ids -> 1000,1000,500); no `canModifyMail` -> `reauth_required` 403 and zero batchModify calls; `confirmCount` mismatch beyond tolerance -> `count_changed`; budget exhaustion returns `done:false` with correct `remaining`.
- [ ] **Step 2:** Run it - expect FAIL.
- [ ] **Step 3:** Implement. Query is built only from the validated domain: `from:${domain}`.
- [ ] **Step 4:** Run it - expect PASS.
- [ ] **Step 5: Commit** `feat: confirm-then-trash all mail from a sender domain`

### Task 5: HTTP routes

**Files:**
- Modify: `index.mjs` (new `routeMailboxRequest`, dispatched in `handler` right after `routeScanRequest`, forwarding `getRemainingTimeInMillis` like the scan route)
- Test: `tests/unit/calendar-mailbox-api.test.js`

**Interfaces:**
- Consumes: Task 3/4 functions (injectable via options as `startMailboxScan`, `stepMailboxScan`, `getMailboxDomains`, `countDomainMessages`, `trashDomainMessages`).
- Produces (all JSON, session required):
  - `POST /calendar/api/mailbox/scan` -> 200 state `{scanId,status,scanned,estimatedTotal}`
  - `POST /calendar/api/mailbox/scan/step` body `{scanId}` -> 200 `{scanned,estimatedTotal,done,errors}`; 409 on stale
  - `GET /calendar/api/mailbox/domains` -> 200 `getMailboxDomains` result (+ `canModifyMail` boolean from the connection)
  - `POST /calendar/api/mailbox/domains/count` body `{domain}` -> 200 `{count}`
  - `POST /calendar/api/mailbox/domains/trash` body `{domain, confirmCount}` -> 200 `{trashed,remaining,done}`
  - Domain goes in the BODY (not the path) so no URL-encoding surface; `MailboxError` maps to its `statusCode` and `{ error, code }`; invalid domain -> 400; unexpected -> 500 generic message, logged name/message only.
- [ ] **Step 1: Write failing tests** per route in the style of `calendar-events-api.test.js`: 401 without session for each of the five routes; happy-path 200s with injected stubs; `domain: "a.com OR from:b.com"` -> 400 and the stub never called; stale scan -> 409; `reauth_required` -> 403 with `code`; CORS/finalise path unchanged (response passes through `finalise`).
- [ ] **Step 2:** Run it - expect FAIL.
- [ ] **Step 3:** Implement `routeMailboxRequest(path, method, event, options)` returning `null` for non-mailbox paths; reuse `resolveSession`, `jsonResponse`, a small `readJsonBody` helper already used by settings/events if present.
- [ ] **Step 4:** Run it plus `node --test tests/unit/calendar-function-url-payload.test.js tests/unit/calendar-cors.test.js` - expect PASS.
- [ ] **Step 5: Commit** `feat: mailbox cleanup API routes`

### Task 6: Settings UI

**Files:**
- Modify: `frontend/settings.html` (new section), `frontend/settings.js`, `frontend/styles.css`
- Test: `tests/unit/calendar-frontend-mailbox.test.js`

**Interfaces:**
- Consumes: Task 5 routes.
- Produces (exported from `settings.js` for testing, like existing exports): `runMailboxScan({ fetchImpl, onProgress }): Promise<void>` (POST scan, then loop step until `done`, calling `onProgress({scanned, estimatedTotal})`; stops and rejects on a non-2xx); `renderMailboxDomains(container, domains, { canModifyMail, onTrash })`; `trashDomain({ fetchImpl, domain, confirm, onProgress })` (count -> `confirm(count)` returning boolean -> trash loop until `done`).
- UI: section "Clean up mailbox" with a "Scan mailbox" button, progress text `Scanned 4,200 of ~51,000`, table (Domain | Emails | "Move to Trash" button), confirm via `window.confirm("Move N emails from DOMAIN to Trash? You can restore them from Trash for 30 days.")`. When `canModifyMail` is false the buttons are replaced by a "Grant permission" link to the existing sign-in start route with explanatory text. Domains are inserted with `textContent` (never `innerHTML`).
- [ ] **Step 1: Write failing tests** (jsdom-free, stub fetch/DOM minimal as in `calendar-frontend.test.js`): `runMailboxScan` calls step until `done` and reports progress; a 409 stops it; `trashDomain` does not call trash when `confirm` returns false; trash loops until `done:true`; `renderMailboxDomains` escapes a hostile domain string (`<img onerror>`) and shows Grant-permission when `canModifyMail` false.
- [ ] **Step 2:** Run it - expect FAIL.
- [ ] **Step 3:** Implement HTML/JS/CSS following the existing settings section patterns.
- [ ] **Step 4:** Run `node --test tests/unit tests/e2e` (full suite) - expect all PASS.
- [ ] **Step 5: Commit** `feat: settings page mailbox cleanup section`

### Task 7: Deploy notes and manual verification

**Files:** Modify `docs/google-oauth-setup.md` (done in Task 1; add a short "Mailbox cleanup" runbook section).

- [ ] **Step 1:** Add the runbook: add the scope in Google Cloud Console, deploy, disconnect/reconnect (or use Grant permission), scan, trash a throwaway domain, restore from Gmail Trash.
- [ ] **Step 2:** Run `node --test tests/unit tests/e2e`; expect PASS.
- [ ] **Step 3: Commit** `docs: mailbox cleanup runbook`

## Self-review notes

- Spec coverage: scope+flag (T1), exact whole-mailbox counts with progress and resume (T2-3, T5-6), count-confirm-trash with re-verification (T4-6), re-consent prompt (T1, T6), docs (T1, T7). Subdomain handling is by post-verification in T4 (`domain` or `*.domain`).
- Deviation from spec: scan state lives on the connection row (`mailboxScan`), not a new table with TTL - avoids terraform/IAM work; trade-off is a ~5000-domain cap with `(other)` overflow. Raise with the user if a separate table is preferred.
