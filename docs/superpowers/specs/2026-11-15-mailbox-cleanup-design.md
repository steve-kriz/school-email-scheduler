# Mailbox cleanup (Settings) - design

## Intent
In Settings, a "Clean up mailbox" section lists every sender domain in the user's
Gmail with an exact email count, and lets the user move all mail from a domain to
Trash. Goal: reclaim a cluttered inbox from within the app. Cleanup is for ANY
sender in the mailbox, not just domains in processing jobs.

## Goals / non-goals / anti-goals
- Goals: exact per-domain counts over the whole mailbox; progress shown while
  scanning; per-domain "Move to Trash" with a count-confirm step.
- Non-goals: per-sender (address) cleanup, label management, unsubscribing,
  permanent delete, scheduled cleanups.
- Anti-goals: silently deleting more than the user confirmed; any bulk action
  without showing the exact count first; logging sender addresses/subjects.

## Constraints
- App is read-only today (`gmail.readonly`, google-oauth.mjs). Trashing needs
  `gmail.modify` (restricted scope). Existing connections must re-consent; until
  they do, the section shows a "Grant permission" prompt and nothing is deleted.
- Gmail has no group-by-sender API: counts come from reading each message's
  `From` header (`format=metadata`, `metadataHeaders=From`).
- Lambda timeout 900s; Function URL requests should stay short.
- Privacy rule in gmail.mjs: never log bodies, subjects, addresses, queries.
  Domains are the user's data: log counts and opaque ids only.

## Approaches considered
- A. Sample scan of latest 5,000 - fast but counts incomplete.
- B. Full resumable scan, exact (CHOSEN by user).
- C. Sample + exact-on-demand - rejected by user.

## Design (B)
**Scope:** add `gmail.modify` to GOOGLE_SCOPES (keeps readonly behaviour).
Store granted scopes on the connection; `GET /calendar/api/mailbox/status`
reports `canModify`. Re-consent reuses the existing OAuth start route.
*Open for builder: confirm whether `include_granted_scopes` makes re-consent
a single click.*

**Scan (client-driven chunks, no background worker):**
- `POST /calendar/api/mailbox/scan` starts (or resets) a scan, creates state.
- `POST /calendar/api/mailbox/scan/step` processes work for ~20s, then returns
  `{ scanned, total (estimate), done }`. The page loops calling it and draws a
  progress bar; closing the tab pauses, reopening resumes.
- State (one DynamoDB item per user, TTL ~7 days): `pageToken`, `scanned`,
  `domainCounts` map, `status`. Per step: `messages.list` page (500 ids, no
  query, excluding trash/spam), then parallel metadata gets (bounded
  concurrency, existing retry/backoff in gmail.mjs), tally `From` domain
  (normalizeDomain), persist. Failed single messages are counted as `errors`.
- `GET /calendar/api/mailbox/domains` returns counts sorted desc.
- Counts are a snapshot as of scan time; UI shows the scan date and a Rescan.

**Delete:**
- `POST /calendar/api/mailbox/domains/{domain}/trash` with body
  `{ confirmCount }`. Step 1 (no confirmCount): server re-counts with
  `from:domain` and returns the exact number. Step 2: the UI confirms
  "Move N emails from domain to Trash?"; the server pages `from:domain`
  ids and calls `messages.batchModify` (addLabelIds TRASH, 1000 ids per call),
  time-boxed and resumable the same way as the scan.
- Matches the exact domain and its subdomains (`from:@domain` plus
  `from:@*.domain` not supported by Gmail, so builder to use `from:domain`
  and re-verify each id's From domain before trashing).
- Trash, not permanent delete: recoverable 30 days.

**UI:** new section in settings.html/js: "Scan mailbox" button, progress bar,
table (Domain | Emails | Move to Trash), confirm dialog, result toast. Matches
existing settings styling.

## Left to the builder
Exact DynamoDB table/key layout (reuse calendar connections or events table),
concurrency and per-step time budget, test seams (injectable fetch/now like
gmail.mjs), terraform IAM if a table is added, unit + e2e tests following the
existing tests/ patterns.

## Risks to note
- Large mailboxes: ~5 quota units per message get; 50k messages is ~10-15 min.
- `gmail.modify` is a restricted scope: an unverified Google OAuth app shows a
  warning screen and is limited to 100 test users.
