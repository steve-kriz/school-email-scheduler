---
id: TASK-056
title: Search Gmail per processing job (OR semantics) and attribute stored events to their job
status: done
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T12:30:00Z
question: NON-BLOCKING, default taken. anthropic.mjs's extractFromMessage gates EVERY message through isWatchedSender(message.from, searchDomains) and returns skipped_sender with no model call for anything not from a watched domain (documented there as "THE COST GATE", fail-closed by design). With per-job queries now OR-ing in quoted text searches for schoolName/searchTerms, a message matched purely on TEXT from a sender outside job.domain would be listed, fetched, and then silently dropped before extraction - making the deliberate widening in this ticket's Additional Context a no-op that only costs Gmail quota. AC 30 below assumes the widening is meant to take effect end to end - a message a job's own query returned is extracted, with the sender gate bypassed on that path only (the gate stays fail-closed for every other caller). Confirm that; or, if the sender gate must stay absolute, AC 30 flips to "a text-only match from an unwatched sender is dropped as skipped_sender and reported in the job's skipped count", and nothing else in this ticket changes.
---

## Description
Depends on TASK-055's `processingJobs` settings shape. Today's scan pipeline
runs ONE Gmail search per user, filtered only by sender domain
(`gmail.mjs`'s `buildQuery` builds `(from:@domain1 OR from:@domain2 OR ...)
after:<date>` - school name is never part of the Gmail query itself, only used
later as extraction context). Replace this with: one independent search PER
processing job, each job's query OR-ing together its own `schoolName`,
`domain`, and every `searchTerms` entry, and every stored event tagged with
which job produced it.

Files this touches: `src/lambda/calendar/backend/gmail.mjs` (query builder),
`src/lambda/calendar/backend/scan.mjs` (runs the per-job loop instead of one
pass), `src/lambda/calendar/backend/anthropic.mjs` (per-job school context
passed into extraction, unchanged shape - just now sourced per job instead of
from one flat settings object), `src/lambda/calendar/backend/events.mjs` (new
field on the stored event item). Read all four in full before starting -
`scan.mjs`'s own docblock is long and explains the watermark/deadline/
throughput invariants a per-job loop must keep intact.

## Additional Context
(Fixed design decisions this ticket must follow - other tickets, especially
TASK-058, depend on the field name below.)

**Per-job Gmail query.** Build one query per processing job, OR-ing together
whichever of its three fields are non-empty:
- `from:@<domain>` for the job's `domain` (existing clause shape, unchanged).
- a quoted text search for `schoolName`, e.g. `"<schoolName>"` - Gmail's
  default quoted-text search matches subject and body, which is exactly what
  the old model did NOT do (it filtered by sender domain only). This is a
  deliberate widening of what counts as a match, per the request that drove
  this ticket.
- a quoted text search for each `searchTerms` entry, same quoting.

Combine those with `OR` inside one parenthesised group, then `AND` the
existing `after:<watermark date>` clause on top, exactly as `buildQuery` does
today. A job with all three fields empty cannot happen once TASK-055's
validation is in place (all three are required), but defend against it
anyway (skip the job rather than sending Gmail a query with an empty OR
group) rather than trusting upstream validation to never regress.

**Run each job independently, not one combined query.** Fetch candidate
messages, extract, and store per job, in a loop over `processingJobs`. This
is what lets a result be attributed back to the job that found it, and it is
an explicit, deliberate requirement, not an optimisation to undo. Keep
`scan.mjs`'s existing per-invocation deadline/time-safety-margin behaviour
working across the WHOLE loop (all jobs), not per job - a scan that runs out
of runway partway through job 3 of 5 must stop the same way it stops today
mid-single-query, with the same watermark-pinning care described in
`scan.mjs`'s own docblock (do not advance `lastScanAt` past work that was
never attempted).

**Event attribution field.** Add `processingJobId` (the job's stable `id`,
not its `name` - a job can be renamed later and the attribution must survive
that) to the item `events.mjs`'s `deriveEventId`/`buildEventItem` produces.
Do NOT fold `processingJobId` into `deriveEventId`'s hash - `eventId` stays
exactly `sha256(sourceMessageId|title|startsAt)` as it is today. This matters:
a session earlier fixed a real live duplication bug caused by an unstable
`eventId`, and changing what the hash is derived from would risk reopening a
different version of the same class of bug.

**Cross-job duplicate handling.** The same underlying email can legitimately
match more than one job's query (e.g. two jobs share a domain, or one
newsletter matches two jobs' search terms). When that happens the SAME
`eventId` is produced by more than one job's extraction pass in the same or a
later scan. This must still result in exactly ONE stored row (existing
dedup/lifecycle-preservation in `events.mjs` already collapses same-key writes
- do not bypass it). For which job "wins" the attribution: preserve the
FIRST job that ever wrote a given `eventId` on later rescans, mirroring the
existing `createdAt: existing.createdAt ?? item.createdAt` pattern in
`applyPreservedLifecycle` - add `processingJobId: existing.processingJobId ??
item.processingJobId` alongside it, so a later rescan (by any job) never
flips an event's attribution.

**Per-job extraction context.** `anthropic.mjs`'s `buildUserContent` already
takes `schoolNames`/`searchDomains` (plural, arbitrary-length lists) as
extraction context for the `<school_context>` block. Per job, pass
`schoolNames: [job.schoolName]` and `searchDomains: [job.domain]`; decide
(and document in this ticket's Acceptance Criteria) whether `job.searchTerms`
should also be folded into one of those two lists for context purposes, or
left out of the LLM prompt entirely (they are always Gmail-search-only) -
either is acceptable, but pick one and be explicit, since TASK-055's sibling
tickets do not decide this for you.

**Report shape.** `runScan`'s return value should report per-job counts
somewhere reasonable (e.g. a `jobs: [{ processingJobId, name, messagesScanned,
eventsCreated, ... }]` breakdown alongside the existing totals) - the exact
shape is the BA's call, but the totals `runScan` already reports
(`messagesScanned`, `eventsCreated`, etc.) must remain sums across all jobs so
nothing currently reading them breaks.

## Acceptance Criteria

**Decisions this ticket makes (the two the Additional Context left open):**

- **DECISION A - `searchTerms` are NOT sent to the LLM.** `job.searchTerms` is a
  Gmail *retrieval* hint only and never reaches the prompt. Rationale, which the
  coder must not undo: (1) `<school_name>` asserts an identity fact - folding
  "Year 4 excursion" in there tells the model the school is called that, which
  corrupts the `isSchoolEmail` judgement the system prompt asks for and biases
  extraction toward inventing events matching the term; (2) `<watched_domain>`
  values go through `toDomainList` -> `normalizeDomain`, which would mangle free
  text into a pseudo-hostname (`"Year 4 excursion"` -> `"year 4 excursion"`) and
  emit it as a domain; (3) every extra prompt byte is untrusted user text in the
  containment boundary for no extraction benefit.
- **DECISION B - the report shape.** `runScan`'s result gains a `jobs` array,
  one entry per configured job, in the same order as `connection.processingJobs`,
  with exactly these keys:
  `{ processingJobId: string, name: string, status: string,
     messagesScanned: number, eventsCreated: number, eventsUpdated: number,
     skipped: number, truncated: boolean, errors: number }`.
  `errors` is a COUNT here (the full `{ id, error }` array stays top-level only,
  so no error text is duplicated into the response twice). `status` comes from a
  new exported frozen `SCAN_JOB_STATUS` with exactly the values
  `ok | partial | error | not_configured | not_attempted`.

**Per-job Gmail query construction (`gmail.mjs`)**

- [ ] 1. A job-aware query builder exists in `gmail.mjs` (extend `buildQuery` or
  add a sibling; the seam is the coder's call) that takes one ProcessingJob
  (`{ id, name, schoolName, domain, searchTerms }`) plus `since`/`sinceDays`/`now`
  and returns a single Gmail search string.
- [ ] 2. The clause list is, in this order: `from:@<domain>` for the job's
  `domain` (normalised through the existing `toDomainList`/`normalizeDomain`
  path, so the one definition of "what a domain is" is not forked); then
  `"<schoolName>"`; then `"<term>"` for each `searchTerms` entry. Blank/whitespace
  entries are dropped, and duplicate clauses are emitted once
  (case-insensitive compare on the clause text).
- [ ] 3. The clauses are OR-joined inside ONE pair of parentheses and the
  existing `after:<YYYY/MM/DD>` clause is appended outside the group, exactly as
  `buildQuery` does today - e.g.
  `(from:@stmarys.edu.au OR "St Mary's Primary" OR "Year 4") after:2026/05/19`.
  The `after:` date still comes from `formatGmailDate` (never ISO-8601).
- [ ] 4. **Regression guard:** for a job whose `schoolName` and `searchTerms`
  produce no clauses and whose `domain` is set, the emitted query is
  BYTE-IDENTICAL to what today's `buildQuery` emits for that single domain and
  the same `since` - `(from:@d) after:YYYY/MM/DD`.
- [ ] 5. A `"` character inside `schoolName` or a `searchTerms` entry cannot
  break out of its quoted clause: the builder neutralises embedded double quotes
  (strip or escape - the coder picks, and states which in a code comment) before
  wrapping, and a value left empty by that neutralisation is dropped as if blank.
  Control characters and newlines are collapsed to spaces first.
- [ ] 6. A job with ZERO usable clauses never produces a query. The builder
  refuses it with a distinguishable error code (e.g. `no_job_query`, mirroring
  today's `no_search_domains`) and the caller skips that job - a bare
  `after:<date>` query, which would scan the whole personal mailbox, is never
  sent to Gmail under any input.
- [ ] 7. `fetchCandidateMessages` accepts the job (or the pre-built query) and
  uses it for `listMessageIds`, and its return contract is otherwise UNCHANGED:
  `{ messages, truncated, errors, newestReceivedAt }`, sequential message
  fetches, per-message failures collected into `errors`, `ReauthRequiredError`
  rethrown, `newestReceivedAt` computed from successes only.
- [ ] 8. Nothing in `gmail.mjs` logs the query, the `schoolName`, or any
  `searchTerms` value - the existing "counts, statuses and message ids only"
  rule holds. Any per-job log line identifies the job by `processingJobId`,
  never by `name`.

**The per-job loop inside one scan invocation (`scan.mjs`)**

- [ ] 9. `runScan` sources its jobs from the connection's `processingJobs`
  (through TASK-055's migrate-on-read path, so a legacy row still scans via its
  synthesised default job) instead of `toDomainList(connection.searchDomains)`.
- [ ] 10. `not_configured` is returned - with no scan lock acquired and no Gmail
  or Anthropic call made - when there are no jobs, or when NO job has at least
  one usable query clause. A run with some usable and some unusable jobs
  proceeds with the usable ones.
- [ ] 11. `computeSince` is called ONCE per invocation and the same `sinceDate`
  is the `after:` floor for EVERY job's query. Per-job watermarks are explicitly
  out of scope: there is one `lastScanAt` on the connection and it must stay
  provably at or before every message every job could have seen.
- [ ] 12. `computeDeadline` is called ONCE, before the loop, and the resulting
  instant bounds the WHOLE loop: it is checked before starting each job and
  between messages inside each job (the existing between-messages check is kept
  verbatim in behaviour). `SCAN_TIME_SAFETY_MARGIN_MS` of runway is still
  reserved for persisting and unlocking.
- [ ] 13. **Message budget is split, not multiplied.** The existing cap (
  `MANUAL_SCAN_MAX_MESSAGES` for manual, `readGmailConfig`/`maxMessages`
  otherwise) remains a WHOLE-INVOCATION budget: each job is fetched with
  `maxMessages = Math.max(1, Math.floor(cap / usableJobCount))`. A five-job
  manual scan therefore still cannot fetch 250 messages and keep a browser
  waiting. (Even split rather than first-come-first-served, deliberately: a
  first-come budget lets one noisy job starve every later job on every scan,
  since a truncated run re-scans the same window.)
- [ ] 14. Jobs run sequentially, in the order they appear in `processingJobs`.
- [ ] 15. A fetch failure for ONE job does not abort the run: it is logged,
  recorded as that job's `status: "error"` with an `{ id: "", error }` entry
  appended to the top-level `errors`, and the loop continues with the next job.
  The one exception is `ReauthRequiredError`, which still aborts the whole scan
  immediately and returns `SCAN_STATUS.REAUTH_REQUIRED` with zeroed counts -
  every remaining job would fail identically.
- [ ] 16. A per-message extraction failure still costs only that message
  (recorded in `errors`, `ALARM_TOKENS.EXTRACTION_FAILED` raised with error NAME
  only) and the job continues.
- [ ] 17. Events are persisted per job via `storeEvents`, and a throw from
  `storeEvents` for one job is caught, reported as `written: 0` for that job
  (never guessed), marks the run `partial`, and does not abort the remaining
  jobs - the TASK-070 rule in the module docblock is preserved, not compounded.

**Watermark and deadline invariants preserved across the loop**

- [ ] 18. `lastScanAt` is PINNED to `sinceDate.toISOString()` - never advanced -
  when ANY of the following is true: any job's fetch was truncated; the deadline
  stopped the run mid-job; at least one usable job was never attempted; any job
  ended with `status: "error"`. This is the generalisation of today's rule: the
  query floor is the only value provably at or before every message any job saw
  AND every message any job dropped or never reached.
- [ ] 19. `lastScanAt` advances only when EVERY usable job ran to completion and
  none was truncated - and then to the MAXIMUM `newestReceivedAt` across all
  jobs (ISO-8601 UTC strings compare as strings), or to this run's own start
  instant when no job matched anything at all.
- [ ] 20. A job the deadline prevented from starting appears in `jobs` with
  `status: "not_attempted"` and all counts zero; the run is `partial` and
  `truncated: true`.
- [ ] 21. The connection is patched exactly ONCE per run, after the loop, with
  the totals (`lastScanMessagesScanned`, `lastScanEventsCreated`,
  `lastScanEventsUpdated`, `lastScanSkipped`, `lastScanTruncated`,
  `lastScanStatus`, `lastScanError`) - not once per job - and `safePatch` still
  swallows a write failure. The scan lock is still acquired once before the loop
  and released once in `finally`.

**Report shape**

- [ ] 22. Totals stay sums across all jobs and keep their existing names and
  meanings: `messagesScanned`, `eventsCreated`, `eventsUpdated` (still always
  0), `skipped`. `truncated` is the OR across jobs (including a deadline stop).
  `errors` is the concatenation of every job's errors, in job order. Overall
  `status` is unchanged: `partial` when there are errors or truncation, else
  `ok`. Nothing currently reading these breaks.
- [ ] 23. `jobs` matches DECISION B exactly, with one entry per configured job
  in settings order - including jobs that were skipped
  (`status: "not_configured"`), never attempted, or produced nothing.
- [ ] 24. `handleScanNow` returns `runScan`'s result verbatim, so `jobs` (which
  contains the user's own job `name`) ships to the authenticated OWNER's browser
  only. `name` must NOT appear in any log line - job names and school names are
  personal data, per the existing "COUNTS ONLY" rule at `index.mjs` ~line 1320.
  Per-job log lines carry `processingJobId` and counts.

**Event attribution (`events.mjs`)**

- [ ] 25. `buildEventItem` accepts an optional `processingJobId` and stamps it on
  the item. Absent/blank leaves the attribute UNDEFINED (the document client is
  configured with `removeUndefinedValues`, so the attribute is simply absent) -
  never `""`, never `null`.
- [ ] 26. `buildEventItems` and `storeEvents` thread `processingJobId` through to
  every item they build, and `scan.mjs` passes the current job's `id` (not its
  `name`).
- [ ] 27. **`deriveEventId` is unchanged.** It still hashes exactly
  `sourceMessageId | title.trim().toLowerCase() | startsAt` and takes no new
  input. A test pins a known digest for fixed inputs and asserts it is
  byte-identical before and after this ticket, and asserts two different jobs
  extracting the same event from the same message derive the SAME `eventId`.
- [ ] 28. `LIFECYCLE_ATTRIBUTES` gains `processingJobId`, so the pre-read
  actually returns it (without it, first-seen-wins cannot work). The projection
  stays narrow - no title, description, subject or sender is added.
- [ ] 29. `applyPreservedLifecycle` implements FIRST-SEEN-WINS attribution:
  `processingJobId: existing.processingJobId ?? item.processingJobId`, and
  `createdAt: existing.createdAt ?? item.createdAt` is applied on the same
  first-seen basis. Both must apply even when the existing row's `status` is
  still `pending` - today the function early-returns for a pending row, so
  attribution (and `createdAt`) would flip on every rescan by another job. The
  acknowledged/dismissed handling (`attentionKey` dropped, `dueBy` kept,
  `acknowledgedAt`/`dismissedAt` carried) is otherwise unchanged, the function
  still returns the SAME object reference when there is genuinely nothing to
  preserve, and `storeEvents`'s `preserved` counter still counts only
  acknowledged/dismissed carry-forwards (an attribution-only merge must not
  inflate it).
- [ ] 30. A message returned by a job's own query is extracted rather than being
  dropped by `extractFromMessage`'s `isWatchedSender` cost gate - see the parked
  `question` in this ticket's frontmatter, which is the one AC an answer can
  flip. The gate's fail-closed default is unchanged for every other caller and
  for an empty domain list.
- [ ] 31. `toEventJson`/`PUBLIC_EVENT_FIELDS` gain `processingJobId` on the
  public projection - TASK-058's calendar/attention filter reads this field
  straight off the events endpoint response, so it must reach the browser, not
  stop at the stored row.

**Per-job extraction context (`anthropic.mjs`)**

- [ ] 32. Per job, extraction is called with `schoolNames: [job.schoolName]` and
  `searchDomains: [job.domain]` - the job's own values, not a union across all
  jobs, so one job's school name never leaks into another job's prompt.
- [ ] 33. Per DECISION A, no `searchTerms` value appears anywhere in the request:
  not in `<school_name>`, not in `<watched_domain>`, not in the metadata block.
  A test asserts a distinctive search term is absent from the whole serialised
  request body.
- [ ] 34. `EXTRACTION_SYSTEM_PROMPT` and `DATA_TAGS` are BYTE-UNCHANGED - the
  system block is the prompt-cache breakpoint and a single varying byte silently
  breaks caching for every later call. All per-job variation stays in the user
  turn, and each value is still individually defused by `defuseDelimiters`
  before it is wrapped.

**Edge and failure cases the coder must handle explicitly**

- [ ] 35. Job with `searchTerms: []` -> query is domain + school name only.
- [ ] 36. Job whose `schoolName`, `domain` and `searchTerms` are all blank ->
  skipped, `status: "not_configured"`, zero counts, no Gmail call, and it does
  NOT count toward `usableJobCount` in the budget split (AC 13).
- [ ] 37. Two jobs sharing the same `domain` -> both queries legitimately return
  the same messages; each job pays its own extraction, and the duplicate
  collapses to one row by `eventId` (AC 29 decides attribution).
- [ ] 38. The same `eventId` produced twice within ONE job's batch is still
  collapsed by `buildEventItems`'s `seen` set and recorded as a
  `SKIP_REASON.DUPLICATE`. Across jobs it is a separate `storeEvents` call, so
  the collapse happens through the pre-read + same-key overwrite instead - which
  is why the scan path must never pass `preserveHandled: false`.
- [ ] 39. Because job B rewrites a row job A already wrote in the same run, the
  summed `eventsCreated` can double-count one underlying event. This is
  ACCEPTED and documented in the code, consistent with the existing
  "`eventsCreated` reports the whole written count" note - it must not be
  "fixed" with a per-event read.
- [ ] 40. A job whose fetch returns zero messages -> `status: "ok"`, zero counts,
  and it does not by itself pin the watermark.
- [ ] 41. Zero usable jobs at the top of the run -> `not_configured` (AC 10).
- [ ] 42. One job's `storeEvents` throwing -> that job reports `eventsCreated: 0`
  and `status: "partial"`, the run is `partial`, later jobs still run (AC 17).
- [ ] 43. `ReauthRequiredError` raised by job 2 of 4 -> whole run returns
  `reauth_required` with zeroed counts and no connection patch, exactly as today
  (google-token.mjs has already marked the connection).
- [ ] 44. A job renamed between two scans -> attribution is unchanged, because
  `processingJobId` is the stable `id` and never the `name`.
- [ ] 45. A job DELETED between two scans -> events already attributed to it keep
  their now-dangling `processingJobId`; nothing in this ticket rewrites or
  deletes those rows (how the UI copes with a dangling id is TASK-058's).
- [ ] 46. A user with exactly one job behaves identically to today for query
  text (AC 4), budget (`floor(cap/1) == cap`), watermark and report totals.

## Cucumber Tests

```gherkin
Feature: Per-job Gmail search and per-job event attribution
  As a parent with more than one school configured
  I want each processing job searched independently
  So that every event is traceable back to the job that found it

  Background:
    Given a connected user "google#sub-1"
    And the events table and Gmail API are stubbed with injected dependencies
    And no real timers, AWS calls, Gmail calls or Anthropic calls are made

  Scenario: A job's query ORs its domain, school name and search terms under one after: clause
    Given a processing job with domain "stmarys.edu.au", school name "St Mary's Primary" and search terms "Year 4" and "Canteen"
    And the scan watermark resolves to 2026-05-19
    When the query for that job is built
    Then the query is "(from:@stmarys.edu.au OR \"St Mary's Primary\" OR \"Year 4\" OR \"Canteen\") after:2026/05/19"
    And the OR clauses are inside a single pair of parentheses
    And the after: clause is outside that group

  Scenario: A domain-only job produces byte-identical output to the old single-domain query
    Given a processing job with domain "stmarys.edu.au", an empty school name and no search terms
    And the scan watermark resolves to 2026-05-19
    When the query for that job is built
    Then the query is exactly "(from:@stmarys.edu.au) after:2026/05/19"

  Scenario: Two jobs each find distinct events in one scan invocation
    Given processing job "job-a" named "St Mary's" with domain "stmarys.edu.au"
    And processing job "job-b" named "Riverside High" with domain "riverside.edu.au"
    And job-a's query returns message "m1" yielding event "Year 4 Excursion"
    And job-b's query returns message "m2" yielding event "Swimming Carnival"
    When a scheduled scan runs
    Then two Gmail searches are performed, one per job, in settings order
    And each search uses the same after: floor
    And the stored event from "m1" has processingJobId "job-a"
    And the stored event from "m2" has processingJobId "job-b"
    And the result reports messagesScanned 2 and eventsCreated 2
    And the result's jobs array has 2 entries in settings order
    And the jobs entry for "job-a" reports processingJobId "job-a", name "St Mary's", status "ok", messagesScanned 1, eventsCreated 1 and errors 0
    And the totals equal the sum of the per-job counts
    And lastScanAt advances to the latest receivedAt across both jobs

  Scenario: Per-job extraction context carries only that job's school name and domain
    Given processing job "job-a" with school name "St Mary's Primary", domain "stmarys.edu.au" and search term "Tuckshop"
    And processing job "job-b" with school name "Riverside High" and domain "riverside.edu.au"
    When a scan runs and job-a's message is extracted
    Then the extraction request for that message contains "St Mary's Primary" as the only school_name value
    And it contains "stmarys.edu.au" as the only watched_domain value
    And it does not contain "Riverside High"
    And it does not contain "Tuckshop" anywhere in the request body
    And the system prompt is byte-identical to the version before this change

  Scenario: Two jobs match the same email and the first job keeps the attribution on rescan
    Given processing job "job-a" and processing job "job-b" both configured for domain "shared.edu.au"
    And both jobs' queries return the same message "m9"
    And extraction of "m9" yields the same event "Book Fair" on 2026-06-10 for both jobs
    When a scan runs
    Then both extraction passes derive the same eventId
    And exactly one row is stored for that eventId
    And that row's processingJobId is "job-a"
    When the user later reorders the jobs so that "job-b" runs first
    And a second scan runs over the same message
    Then exactly one row still exists for that eventId
    And its processingJobId is still "job-a"
    And its createdAt is still the first scan's timestamp

  Scenario: A rescan by another job does not resurrect an acknowledged event
    Given an event stored with processingJobId "job-a" and status "acknowledged"
    When a later scan re-extracts the same event under job "job-b"
    Then the stored row keeps status "acknowledged"
    And it carries no attentionKey
    And its processingJobId is still "job-a"

  Scenario: The scan runs out of time mid-job-loop and pins the watermark
    Given three processing jobs "job-a", "job-b" and "job-c"
    And the stored lastScanAt is "2026-05-21T00:00:00.000Z" so the query floor is 2026-05-19
    And the injected clock passes the computed deadline while job-b is being extracted
    When a scheduled scan runs
    Then job-a completes and its extracted events are persisted
    And job-b's already-extracted events are persisted
    And job-c is never fetched from Gmail
    And the jobs entry for "job-c" reports status "not_attempted" with all counts zero
    And the result reports truncated true and status "partial"
    And lastScanAt is written as the query floor "2026-05-19", not as any newestReceivedAt
    And the scan lock is released

  Scenario: One truncated job pins the watermark for the whole run
    Given two processing jobs
    And job-a's fetch reports truncated true
    And job-b completes cleanly
    When a scan runs
    Then lastScanAt is written as this run's own query floor
    And the result reports truncated true and status "partial"

  Scenario: A job with no usable search fields is skipped rather than querying the whole mailbox
    Given processing job "job-a" with an empty domain, an empty school name and no search terms
    And processing job "job-b" with domain "riverside.edu.au"
    When a scan runs
    Then no Gmail search is performed for "job-a"
    And no query containing a bare "after:" clause is ever sent
    And the jobs entry for "job-a" reports status "not_configured" with all counts zero
    And job-b is still scanned normally

  Scenario: Every job unusable reports not_configured without taking the scan lock
    Given every configured processing job has an empty domain, school name and search terms
    When a scan runs
    Then the result status is "not_configured"
    And no scan lock is acquired
    And no Gmail or Anthropic call is made

  Scenario: One job's fetch failure does not abort the remaining jobs
    Given three processing jobs
    And job-b's Gmail fetch throws a GmailApiError
    When a scan runs
    Then job-a and job-c are still fetched and extracted
    And the jobs entry for "job-b" reports status "error" with errors 1
    And the top-level errors array contains that job's error
    And the result status is "partial"
    And lastScanAt is written as this run's own query floor

  Scenario: A revoked grant aborts the whole loop
    Given three processing jobs
    And job-b's fetch throws ReauthRequiredError
    When a scan runs
    Then job-c is never fetched
    And the result status is "reauth_required" with all counts zero
    And no lastScanAt patch is written
    And the scan lock is released

  Scenario: A manual scan splits its message budget across jobs
    Given five processing jobs
    And a manual scan whose cap is 50 messages
    When the scan runs
    Then each job's fetch is asked for at most 10 messages
    And the total messages fetched across all jobs does not exceed 50

  Scenario: A quote typed into a search term cannot break out of its clause
    Given a processing job with search term "Year \"4\" OR from:@evil.example"
    When the query for that job is built
    Then the emitted clause is a single quoted token containing no unescaped double quote
    And the query still contains exactly one parenthesised OR group followed by the after: clause

  Scenario: eventId derivation is unchanged by this ticket
    Given a message id "m1", a title "Year 4 Excursion" and a start instant "2026-06-10T00:00:00.000Z"
    When the eventId is derived
    Then it equals the sha256 of "m1|year 4 excursion|2026-06-10T00:00:00.000Z"
    And it is identical whether or not a processingJobId was supplied
```

## Relevant files and context

- `src/lambda/calendar/backend/gmail.mjs` - `buildQuery` (~line 254),
  `toDomainList` (~174), `formatGmailDate` (~226), `listMessageIds` (~544),
  `fetchCandidateMessages` (~903), `readGmailConfig`, `DEFAULT_MAX_MESSAGES`.
  Read the module docblock for the cap/window and "never log content" rules.
- `src/lambda/calendar/backend/scan.mjs` - read the WHOLE docblock (lines 1-99:
  CONCURRENCY, THROUGHPUT, WATERMARK, TASK-070, EVENTS CREATED VS UPDATED)
  before touching `runScan` (~301). Key symbols: `SCAN_STATUS`,
  `MANUAL_SCAN_MAX_MESSAGES`, `SCAN_TIME_SAFETY_MARGIN_MS`, `computeSince`,
  `computeDeadline`, `emptyResult`, `safePatch`.
- `src/lambda/calendar/backend/anthropic.mjs` - `buildUserContent` (~561),
  `buildRequest` (~616), `extractFromMessage` (~1094), `isWatchedSender` (~524),
  `toSchoolNameList` (~467), `EXTRACTION_SYSTEM_PROMPT` (~202), `DATA_TAGS`
  (~183), `defuseDelimiters`.
- `src/lambda/calendar/backend/events.mjs` - `deriveEventId` (~347),
  `buildEventItem` (~406), `buildEventItems` (~487), `storeEvents` (~695),
  `LIFECYCLE_ATTRIBUTES` (~876), `readLifecycleStates` (~1767),
  `applyPreservedLifecycle` (~1827), `PUBLIC_EVENT_FIELDS` (~891),
  `toEventJson` (~1149).
- `src/lambda/calendar/backend/settings.mjs` - `normalizeDomain` (~456) is the
  single definition of "what a domain is"; TASK-055 adds the `processingJobs`
  read/migration this ticket consumes.
- `src/lambda/calendar/index.mjs` - `handleScanNow` (~1400) returns the scan
  result verbatim; `handleScanStatus` (~1449) reads only the `lastScan*`
  connection fields (unchanged by this ticket); the "COUNTS ONLY" logging rule
  is at ~1320.
- Patterns to follow: every collaborator injectable with a real default
  (`now`, `getRemainingTimeInMillis`, `fetchCandidateMessages`,
  `extractFromMessage`, `storeEvents`, `env`, `log`); no AWS/Gmail/Anthropic
  call on an injected-dependency path; `makeLogger`/`CALENDAR_LOG_LEVEL`
  honoured per request.
- Existing tests to extend / mirror the naming of:
  `tests/unit/calendar-scan.test.js`, `tests/unit/calendar-gmail.test.js`,
  `tests/unit/calendar-extraction.test.js`,
  `tests/e2e/calendar-scan-orchestration.test.js`,
  `tests/e2e/calendar-gmail-fetch.test.js`,
  `tests/e2e/calendar-extraction-flow.test.js`. New files follow the
  `tests/unit/task-056-*.test.js` / `tests/e2e/task-056-*.test.js` convention
  set by TASK-053 and TASK-054.
- Dependency: TASK-055 owns the `processingJobs` shape
  `{ id, name, schoolName, domain, searchTerms }` and its migrate-on-read. Do
  not re-validate jobs here; `settings.mjs` owns the rules. Do defend against a
  clause-less job anyway (AC 6/36).
- TASK-058 (calendar/attention filter) reads `processingJobId` directly off the
  events endpoint response - see AC 31, which is why `toEventJson` is in scope
  for this ticket and not left to TASK-058.
