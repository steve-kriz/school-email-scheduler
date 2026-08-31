---
id: TASK-059
title: Let a processing job watch multiple domains (backend validation and Gmail query)
status: done
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T10:15:00Z
question: RESOLVED by the orchestrator - yes, handle it in connections.mjs too, not deferred. synthesizeLegacyProcessingJob (connections.mjs:379-402) is renamed to emit domains (a one-element list derived the same way it derives its current domain, still folding remaining legacy entries into searchTerms) instead of the singular domain. Additionally, toPublicJson's per-job projection must read a STORED job map that still only carries the pre-TASK-059 singular domain key as domains: [domain] (dropped if blank) when domains itself is absent - the same read-compatibility shim scan.mjs's toProcessingJobs needs (this ticket's AC 29), applied on the settings/auth-me read path so an existing TASK-055/057 user's configured domain keeps showing up in the settings UI and in /auth/me immediately after this ships, without requiring them to re-save first. See the added Acceptance Criteria under "connections.mjs" below.
---

## Description
A processing job (TASK-055/056/057/058) currently carries exactly ONE
`domain: string`. Change this to `domains: string[]` - a job can watch several
sender domains at once (e.g. a P&C association's own domain alongside the
school's), the same way it already supports several free-text `searchTerms`.

This ticket is the backend half only: validation, storage, the Gmail query
builder, and the scan pipeline's legacy fallback. The settings UI (comma-
separated text input replacing the single domain field, and also replacing
the search-terms row-editor with a comma-separated field - see that ticket for
why both change together) is TASK-060, which depends on the shape decided
here. TASK-058 (the calendar's processing-job filter) is untouched - it
filters by job `id` and never reads `domain`.

Files: `src/lambda/calendar/backend/settings.mjs` (validation + storage),
`src/lambda/calendar/backend/gmail.mjs` (per-job query builder),
`src/lambda/calendar/backend/scan.mjs` (two call sites: the per-job
extraction-context wiring, and the raw-row legacy fallback in
`toProcessingJobs`). Read all three in full before starting.

## Additional Context
(Fixed design decisions TASK-060 depends on. Do not diverge from the field
name below without flagging it back.)

**Field rename, not a type change under the old name.** `domain: string`
becomes `domains: string[]`, matching the pluralisation already used for
`searchTerms`. Do not keep the key named `domain` holding an array - every
reader of a processing job (this ticket's three files, plus TASK-060's
frontend) must agree on `domains` as the key.

**Validation:** reuse the SAME per-domain rules already applied to the old
singular field - `normalizeDomain` -> `isValidDomain` ->
`isPublicMailDomain` - but now over a list. `validateSearchDomains`
(`settings.mjs:673-707`) already implements exactly this shape of validation
(count cap counted before de-dup, normalise-then-validate-then-public-check
each entry, duplicates COLLAPSE rather than error) for the pre-TASK-055 flat
`searchDomains` field - write the new per-job validator as an indexed sibling
of it (same rule order, same collapse-duplicates stance - two spellings of
one domain are one intent, unlike a duplicate JOB NAME which errors), not a
fresh design. At least one domain is required per job (a job with zero usable
domains but a school name/search terms is still valid overall via those other
fields - TASK-056's `hasJobQueryClauses` already tolerates an empty domain
list, so "at least one domain" is NOT a new job-level requirement, only a
list-shape rule: if `domains` is present it must be a non-empty-when-provided
list of valid entries, or omitted/empty entirely).

Actually decide explicitly (BA: pick one and document it): is `domains`
still REQUIRED (a job must always have at least one domain, as `domain` was),
or does it become OPTIONAL now that a job could in principle match on school
name and search terms alone? The safest, most consistent choice given
`hasJobQueryClauses`'s existing tolerance is to make it OPTIONAL - a job with
an empty `domains` list, a school name, and no search terms is still usable
and unambiguous. Document whichever you choose and update the "required
fields" story (client-side validation in TASK-060, and this ticket's own
per-job "all fields required" framing) to match.

**Storage.** `domains` is a plain JS array of strings (same DynamoDB `L` of
`S` shape `searchTerms` already uses inside a job's `M`) - no new marshalling
concerns, unlike TASK-055's original `L` of `M` work.

**Gmail query builder (`gmail.mjs`).** `buildJobClauses` already calls
`toDomainList([job?.domain])` (line 375) - note it ALREADY wraps the singular
value in an array before normalising, because `toDomainList` is a generic
list-or-Set-or-string normaliser. Changing this call to
`toDomainList(job?.domains)` is very likely sufficient by itself - `buildQuery`
(the OLD, still-used single-user query builder) already ORs multiple domains
together with `from:@d1 OR from:@d2`, so the same OR-per-domain behaviour is
what a multi-domain job needs, not new logic. Confirm this by reading
`toDomainList` and `buildQuery` before assuming a rewrite is needed.

**`scan.mjs`, two call sites.** (1) The per-job extraction-context wiring
passes `searchDomains: [job.domain]` (line ~668) to give the LLM a
single-element domain list for its `<school_context>` block (TASK-056's
Decision A/context-wiring). With `domains` already a list, this simplifies to
`searchDomains: job.domains` directly - no wrapping needed. (2) `toProcessingJobs`
(~line 355) reads the RAW DynamoDB-shaped connection row directly (it does not
go through `settings.mjs`'s `toPublicJson` projection) and has its own parallel
migrate-on-read logic for a row with no `processingJobs` at all. Its per-job
mapping at line 371 reads `domain: text(source.domain)` - update this to read
a `domains` array the same way it already reads `searchTerms` two lines below
(`source.domains?.L` mapped through `text`, or a plain array). Its LEGACY
FALLBACK below that (lines 377-385, reached when a row has no `processingJobs`
attribute at all) currently synthesises ONE JOB PER LEGACY DOMAIN, each with a
single `domain`. Update the field name to `domains: [domain]` (a one-element
array) - this ticket does NOT need to redesign that one-job-per-domain
fallback shape into a single shared job (that would diverge from
`settings.mjs`'s OWN migrate-on-read, which already makes one shared default
job - a pre-existing inconsistency between the two fallbacks that is out of
scope here; note it but do not fix it).

## Acceptance Criteria

### Decision: `domains` is OPTIONAL (resolved by the BA, per the Additional Context)

`domains` is **optional per job**, not required. Rationale, from reading the code:
`gmail.mjs:392 hasJobQueryClauses` / `gmail.mjs:363 buildJobClauses` already build a
usable query from a quoted `schoolName` and/or `searchTerms` alone, and
`gmail.mjs:427 buildJobQuery` only throws `no_job_query` when there are ZERO clauses of
any kind; `scan.mjs:531-544` already tolerates and reports such a job as
`not_configured` without ever issuing a bare `after:` mailbox-wide query. Requiring at
least one domain would therefore add a NEW restriction the pipeline does not need, and
would break a legitimate "match this school by name via a newsletter relay" job.
Because `schoolName` remains required (`settings.mjs:884-888`, `requiredJobText`), the
"a job must be searchable" guarantee is still carried by another field, so nothing is
weakened. **Resulting validation rule:** `domains` absent, `null`, or `[]` is VALID and
normalises/stores as `[]`; when a non-empty list IS supplied, every entry must pass the
full `normalizeDomain` -> non-blank -> `isValidDomain` -> `isPublicMailDomain` sequence.
This is the ONE deliberate divergence from `validateSearchDomains` (which errors on an
empty list); it matches `validateSearchTerms`' "absent is not a mistake" branch
(`settings.mjs:755-758`) instead, which is the correct per-job sibling.

### settings.mjs - `validateProcessingJobs` (~842-931) and its helpers

- [ ] 1. `validateProcessingJobs` returns, per job, **exactly** the five keys
  `{ id, name, schoolName, domains, searchTerms }`. The key `domain` no longer appears in
  its output for any input.
- [ ] 2. An incoming singular `domain` key on a submitted job is **dropped as an unknown
  key** (the existing "rebuilt key by key, unknown keys dropped" rule), NOT aliased to
  `domains` and NOT an error. A payload carrying only `domain` therefore validates with
  `domains: []`.
- [ ] 3. `domains` absent or `null` normalises to `[]` and the job saves - no error.
- [ ] 4. `domains: []` (explicit empty array) is accepted and normalises to `[]`.
- [ ] 5. `domains` present but not an array (a bare string, a number, an object, `true`)
  throws `SettingsValidationError` with field `processingJobs[<index>].domains` and a
  message in the shape of `validateSearchTerms`' list message, e.g.
  `"School email domains must be a list"`. A bare string is NOT accepted as one domain and
  is NEVER comma-split - TASK-060's UI does the comma splitting client-side and sends an
  array.
- [ ] 6. A new exported constant caps domains **per job** - `MAX_SEARCH_DOMAINS_PER_JOB`,
  value `10` - named and documented as the sibling of `MAX_SEARCH_TERMS_PER_JOB`
  (`settings.mjs:126`). The retained flat `MAX_SEARCH_DOMAINS` (`settings.mjs:154`) is
  left alone and still bounds `validateSearchDomains` only; its docblock line "a
  processing job carries exactly one domain" is corrected.
- [ ] 7. The count cap is checked on what was **SUBMITTED, before de-duplication**: eleven
  entries of which two are duplicates is reported as "too many" (message in the shape
  `Enter at most 10 school email domains for one processing job`), not silently collapsed
  to ten.
- [ ] 8. Each entry is processed in this exact rule order, so the message names the real
  problem: `normalizeDomain(entry)` -> blank check -> `isValidDomain` ->
  `isPublicMailDomain` -> de-duplicate.
- [ ] 9. An entry that normalises to `""` (empty string, whitespace-only, a non-string)
  is rejected with `"A school email domain cannot be blank"` on field
  `processingJobs[<index>].domains` - mirroring `validateSearchTerms`' blank-entry message
  rather than emitting the useless `"" is not a valid email domain`.
- [ ] 10. A non-blank entry that fails `isValidDomain` is rejected with
  `"<echoed raw entry>" is not a valid email domain`, echoing the RAW submitted entry
  through the existing `echo()` truncation, so the user can see WHICH of several entries
  was wrong.
- [ ] 11. An entry that passes `isValidDomain` but is a public mail host
  (`isPublicMailDomain`) is rejected with the existing message
  `<normalised domain> is a public email provider, not a school domain - use the school's
  own domain`, naming the offending domain.
- [ ] 12. Duplicates within one job's list **COLLAPSE, they do not error** - compared on
  the NORMALISED value, so `"StMarys.EDU.au"`, `"@stmarys.edu.au"` and
  `"https://stmarys.edu.au/news"` in one list store as the single entry
  `"stmarys.edu.au"`. Input order is preserved and first-occurrence wins.
- [ ] 13. Every error raised by the domains validator carries the **indexed** field name
  `processingJobs[<index>].domains`, using the submitted zero-based index and the existing
  `at(key)` helper, so TASK-060's form can highlight the right row.
- [ ] 14. The `SettingsValidationError` docblock's list of indexed `<key>` values
  (`settings.mjs:449-452`) is updated from `domain` to `domains`.
- [ ] 15. `buildConnectionPatch` (`settings.mjs:1113-1141`) rebuilds `domains` key by key
  as `Array.isArray(job.domains) ? [...job.domains] : []`, exactly as it already does for
  `searchTerms`, so an unvalidated key still cannot reach the stored item. An empty
  `domains` is written AS an empty DynamoDB `L` (this is a list, not an `SS` - the
  empty-set write problem does not apply). The three legacy REMOVEs
  (`schoolNames`/`searchDomains`/`schoolName`) are unchanged.
- [ ] 16. The `validateProcessingJobs` `@returns` JSDoc (`settings.mjs:837-839`) and the
  module docblock's "one sender `domain`" framing (`settings.mjs:5-7`) are updated to the
  plural shape, and the docblock states that `domains` is OPTIONAL while `name` and
  `schoolName` remain required.
- [ ] 17. Regression - everything else in `validateProcessingJobs` is unchanged: duplicate
  job NAMES still error (case-insensitive, both spellings quoted), a canonical-UUID `id`
  is still preserved and any other id re-minted, duplicate client-supplied ids still error,
  `MAX_PROCESSING_JOBS` still applies, `name`/`schoolName` are still required via
  `requiredJobText`, and `searchTerms` validation is untouched.

### gmail.mjs - `buildJobClauses` (~363-380) and its callers

- [ ] 18. **Confirmed by reading (`gmail.mjs:186-198` `toDomainList`, `266-283`
  `buildQuery`, `427-439` `buildJobQuery`): changing line 375 from
  `toDomainList([job?.domain])` to `toDomainList(job?.domains)` is sufficient on its own.**
  `toDomainList` already accepts a plain array (and a `Set` and `{SS:[...]}`), already
  normalises each entry through `normalizeDomain`, already drops entries that normalise to
  `""`, and already de-duplicates; the existing `for (const domain of ...) add(...)` loop
  already emits one `from:@<domain>` clause per entry; and `buildJobQuery` already OR-joins
  every clause inside ONE pair of parentheses with `after:` appended outside. No new
  looping, joining or bracketing logic is required, and `buildQuery` must NOT be changed.
- [ ] 19. A job with `domains: ["stmarys.edu.au", "pandc.org.au"]` and
  `schoolName: "St Mary's"` produces the clause list
  `["from:@stmarys.edu.au", "from:@pandc.org.au", "\"St Mary's\""]` - domain clauses first,
  in stored order, then the school name, then each search term. The contractual clause
  ORDER from TASK-056 is preserved (its byte-for-byte regression guard must still pass for
  a single-domain job).
- [ ] 20. `buildJobQuery` for that job emits exactly
  `(from:@stmarys.edu.au OR from:@pandc.org.au OR "St Mary's") after:YYYY/MM/DD` - one
  paren group, `after:` outside it.
- [ ] 21. A single-domain job emits a query **byte-identical** to what it emitted before
  this ticket, once its `domain` is expressed as `domains: ["<host>"]`.
- [ ] 22. `domains` entries that duplicate each other after normalisation, or that
  duplicate a clause already added, emit the clause ONCE (existing case-insensitive `add`
  de-duplication); entries that normalise to `""` emit nothing.
- [ ] 23. A job with `domains: []` (or no `domains` key) but a usable `schoolName` still
  builds a query - `("St Mary's") after:...` - and `hasJobQueryClauses` returns `true`.
- [ ] 24. A job with `domains: []`, no `searchTerms`, and a `schoolName` that
  `toQueryPhrase` strips to `""` (e.g. `schoolName: "\"\"\""` - non-blank so it passes
  `requiredJobText`, but all quotes so it strips empty) yields ZERO clauses:
  `hasJobQueryClauses` returns `false` and `buildJobQuery` still throws with
  `code: "no_job_query"`. A bare `after:` mailbox-wide query is never emitted.
- [ ] 25. Docblocks updated: `buildJobClauses`' `@param` job shape
  (`gmail.mjs:360`), `buildJobQuery`'s `@param` job shape (`gmail.mjs:421`),
  `fetchCandidateMessages`' `@param args.job` shape (`gmail.mjs:1066`), the "came from
  `job.domain`" wording (`gmail.mjs:412`), the module docblock's job shape
  (`gmail.mjs:18-23`), and - importantly - `buildJobQuery`'s now-false claim that
  "Upstream validation (TASK-055) makes all three fields required" (`gmail.mjs:416-418`),
  which must be corrected to say `domains` is optional and that this is exactly why the
  zero-clause guard is not merely defensive.

### scan.mjs - `toProcessingJobs` (~355-386) and the extraction-context call site (~668)

- [ ] 26. The extraction-context wiring at `scan.mjs:668` becomes
  `searchDomains: job.domains` - the `[...]` wrapping is removed. `schoolNames:
  [job.schoolName]` is unchanged, and `searchTerms` still deliberately do NOT reach the
  model (TASK-056 Decision A).
- [ ] 27. `anthropic.mjs`'s `buildUserContent`/`isWatchedSender` need NO code change:
  `toDomainList` already accepts a multi-entry array, so a multi-domain job's
  `<school_context>` lists every domain and `isWatchedSender` matches any of them. Only
  the stale doc line `anthropic.mjs:558` (`searchDomains: [job.domain]`) is updated.
- [ ] 28. `toProcessingJobs`' per-job mapping emits `domains: string[]` in place of
  `domain: string`, reading the raw row's `source.domains` in both shapes it can arrive
  in - a plain array (document client) and `{ L: [{ S: "..." }] }` (low-level client) -
  the same way the adjacent line already handles `source.searchTerms?.L`. Entries go
  through the existing `text()` trim and blank entries are dropped.
- [ ] 29. **Read-compatibility for already-migrated TASK-055/057 rows:** when a stored job
  map has NO `domains` attribute but DOES have the singular `domain`, `toProcessingJobs`
  reads it as the one-element list `[text(source.domain)]` (dropped if blank). Without
  this, every user who saved under TASK-055/057 silently loses their sender filter on
  their next scan until they re-save. This is a READ-side tolerance only - it does not
  reintroduce `domain` on the write or response contract (AC 2 still stands).
- [ ] 30. The legacy fallback (`scan.mjs:377-385`, reached only when the row has NO
  `processingJobs` attribute at all) still synthesises ONE JOB PER legacy `searchDomains`
  entry, with `id: "legacy#<domain>"` and the same name/schoolName derivation, but the
  field is renamed to `domains: [domain]` (a one-element array). The one-job-per-domain
  shape is NOT redesigned into a single shared job.
- [ ] 31. A code comment at that fallback records - without fixing - the pre-existing
  divergence from `connections.mjs`'s `synthesizeLegacyProcessingJob`, which makes ONE
  shared "Default" job from the same legacy attributes. Out of scope here.
- [ ] 32. `toProcessingJobs`' `@returns` JSDoc (`scan.mjs:353`) and the module docblock's
  job shape (`scan.mjs:21`) are updated to `domains: string[]`.
- [ ] 33. `runScan` is otherwise unchanged: `hasJobQueryClauses` still decides usability
  before any Gmail call, an unusable job is still reported `not_configured`, the per-job
  message-budget split, deadline handling, per-job error isolation and watermark rules are
  untouched.

### connections.mjs - the settings/auth-me read path (resolved question - NOT deferred)

- [ ] 37. `synthesizeLegacyProcessingJob` (`connections.mjs:379-402`) is updated to emit
  `domains: domains[0] ? [domains[0]] : []` (a one-element list, or `[]`) in place of the
  singular `domain: domains[0] || ""`, so the migrate-on-read synthesis this function
  already performs for a row with no `processingJobs` attribute at all matches the new
  shape. `domains[1..]` continues to fold into the synthesised job's `searchTerms` exactly
  as it does today - only the key name and container shape for the first entry changes.
- [ ] 38. `toPublicJson`'s per-job projection gains the SAME read-compatibility shim as
  `scan.mjs`'s `toProcessingJobs` (AC 29): when a STORED job map (one already saved under
  TASK-055/057) has no `domains` attribute but does have the singular `domain`, the
  projected job reports `domains: [domain]` (dropped if blank) instead of an absent/empty
  list. This runs on the READ path only, in the same place `toPublicJson` already handles a
  job map at all - it does not write anything back, and the next real save through
  `validateProcessingJobs` still drops any singular `domain` key per AC 2.
- [ ] 39. With AC 38 in place, `GET /calendar/api/settings` and `GET /calendar/api/auth/me`
  both continue to show an existing TASK-055/057 user's configured domain immediately after
  this ticket ships, with no re-save required and no visible regression in the settings
  page (TASK-060 renders whatever `domains` array it receives).
- [ ] 40. Neither `toPublicJson` nor `synthesizeLegacyProcessingJob` ever emits a `domain`
  key (singular) on any response body, for either a migrated-on-read legacy row or a
  previously-stored TASK-055/057 job - only `domains`.

### Cross-cutting

- [ ] 41. No frontend file is changed by this ticket -
  `src/lambda/calendar/frontend/settings.js` still reads/writes the singular `domain` and
  is TASK-060's job. This ticket must therefore be co-deployed with TASK-060, and that
  co-deploy requirement is stated in the settings.mjs docblock alongside the existing
  TASK-055/057 co-deploy note.
- [ ] 42. Existing unit tests that assert the singular `domain` key (settings validation,
  `buildJobClauses`/`buildJobQuery`, `toProcessingJobs`, `synthesizeLegacyProcessingJob`/
  `toPublicJson`, and any scan/e2e fixture building a job) are updated to the plural shape,
  and new tests cover every scenario in the Cucumber block below.
- [ ] 43. `npm test` passes with no unrelated behaviour change.

### Edge and failure cases the coder must handle explicitly

- `domains` absent / `null` / `[]` - all valid, all normalise to `[]` (the OPTIONAL decision).
- `domains` as a bare string, a number, an object, or `true` - rejected as "must be a list"; never comma-split, never wrapped.
- An entry that is not a string (a number, `null`, a nested array) - `normalizeDomain` returns `""` for it, so it lands on the blank-entry message, not a crash.
- Whitespace-only entry, `"@"`-only entry, a lone label (`"stmarys"`), a leading/trailing dot, a trailing hyphen - all refused by `isValidDomain`.
- An over-length domain (>253 chars) or an over-length label (>63 chars) - refused; the echoed value is truncated to 64 chars by `echo()`.
- A public-mail host anywhere in a multi-entry list (including in a list that is otherwise fine) - refused, naming the normalised host.
- More than `MAX_SEARCH_DOMAINS_PER_JOB` entries, including when duplicates would bring the list under the cap - refused as "too many".
- Duplicates that only match AFTER normalisation (`"@StMarys.EDU.au"` vs `"stmarys.edu.au"`) - collapse silently.
- Two different jobs sharing a domain - still allowed (only job NAMES must be unique).
- A job with `domains: []` and a `schoolName` that `toQueryPhrase` strips empty - zero clauses, `not_configured`, `no_job_query`, and never a bare `after:` query.
- A stored row written under TASK-055/057 carrying the singular `domain` inside a job map - both `toProcessingJobs` (scan) AND `toPublicJson`/`synthesizeLegacyProcessingJob` (settings/auth-me) must still find the domain (AC 29, AC 38).
- A row with NO `processingJobs` attribute at all - the legacy one-job-per-domain fallback still runs and now emits `domains: [d]`.
- A row whose `processingJobs` arrives in low-level `{ L: [{ M: {...} }] }` shape - both `domains` and the singular `domain` must be readable through it.

## Cucumber Tests
```gherkin
Feature: A processing job can watch several sender domains

  Background:
    Given a signed-in user with a stored Gmail connection
    And the settings validator mints ids from a stubbed generator

  # --- AC 1, 12, 19, 20: the headline case ---
  Scenario: A job with multiple domains saves and ORs every domain into its Gmail query
    When the user saves one processing job named "St Mary's" with school name "St Mary's Primary" and domains "stmarys.edu.au, pandc.org.au"
    Then the save succeeds
    And the stored job has domains ["stmarys.edu.au", "pandc.org.au"] and no "domain" key
    And the job's Gmail clauses are ["from:@stmarys.edu.au", "from:@pandc.org.au", "\"St Mary's Primary\""] in that order
    And the job's Gmail query is "(from:@stmarys.edu.au OR from:@pandc.org.au OR \"St Mary's Primary\") after:2026/06/02"

  # --- AC 21: no regression for the single-domain case ---
  Scenario: A single-domain job emits the same query it did before the rename
    When the user saves a processing job with school name "St Mary's Primary" and domains ["stmarys.edu.au"]
    Then the job's Gmail query is "(from:@stmarys.edu.au OR \"St Mary's Primary\") after:2026/06/02"

  # --- AC 3, 4, 23: the OPTIONAL decision ---
  Scenario Outline: A job with no domains at all is accepted and still searchable
    When the user saves a processing job with school name "St Mary's Primary" and <domains_field>
    Then the save succeeds
    And the stored job has domains []
    And the job is reported as usable for scanning
    And the job's Gmail query is "(\"St Mary's Primary\") after:2026/06/02"

    Examples:
      | domains_field           |
      | no domains key          |
      | domains set to null     |
      | an empty domains list   |

  # --- AC 12, 22: duplicates collapse, they do not error ---
  Scenario: Duplicate domains within one job collapse instead of failing the save
    When the user saves a processing job with domains ["StMarys.EDU.au", "@stmarys.edu.au", "https://stmarys.edu.au/news", "pandc.org.au"]
    Then the save succeeds
    And the stored job has domains ["stmarys.edu.au", "pandc.org.au"]
    And the job's Gmail query contains "from:@stmarys.edu.au" exactly once

  # --- AC 10, 13: FAILURE - an invalid entry is named ---
  Scenario: An invalid domain in a multi-domain list is rejected and named
    When the user saves processing job 0 "Newsletters" and processing job 1 "Sport" with domains ["stmarys.edu.au", "not a domain", "pandc.org.au"] on job 1
    Then the save is rejected with status 400
    And the error field is "processingJobs[1].domains"
    And the error message names "not a domain" as not a valid email domain
    And nothing is written to the connections table

  # --- AC 11: FAILURE - a public mail provider anywhere in the list ---
  Scenario: A public mail provider mixed into an otherwise valid list is refused
    When the user saves a processing job with domains ["stmarys.edu.au", "GMAIL.com"]
    Then the save is rejected with status 400
    And the error field is "processingJobs[0].domains"
    And the error message names "gmail.com" as a public email provider

  # --- AC 9: FAILURE - a blank entry ---
  Scenario Outline: A blank entry inside a supplied domains list is refused
    When the user saves a processing job with domains ["stmarys.edu.au", <entry>]
    Then the save is rejected with status 400
    And the error field is "processingJobs[0].domains"
    And the error message is "A school email domain cannot be blank"

    Examples:
      | entry   |
      | ""      |
      | "   "   |
      | 42      |
      | null    |

  # --- AC 5: FAILURE - wrong container type, never comma-split ---
  Scenario: A bare comma-separated string is refused rather than split
    When the user saves a processing job with domains set to the string "stmarys.edu.au, pandc.org.au"
    Then the save is rejected with status 400
    And the error field is "processingJobs[0].domains"
    And the error message is "School email domains must be a list"

  # --- AC 6, 7: FAILURE - count cap, counted before de-duplication ---
  Scenario: Eleven submitted domains are refused even when two of them are duplicates
    When the user saves a processing job with 11 domain entries of which 2 are duplicates
    Then the save is rejected with status 400
    And the error field is "processingJobs[0].domains"
    And the error message says at most 10 school email domains for one processing job

  # --- AC 2: the superseded singular key is dropped, not aliased ---
  Scenario: A payload sending the old singular domain key stores no domain
    When the user saves a processing job carrying only the key "domain" set to "stmarys.edu.au"
    Then the save succeeds
    And the stored job has domains []
    And the stored job has no "domain" key

  # --- AC 17: unchanged neighbouring rules ---
  Scenario: Two jobs may share a domain but not a name
    When the user saves jobs "Newsletters" and "Sport" both with domains ["stmarys.edu.au"]
    Then the save succeeds
    When the user saves jobs "Sport" and "SPORT" both with domains ["stmarys.edu.au"]
    Then the save is rejected with status 400
    And the error field is "processingJobs"
    And the error message names both "Sport" and "SPORT"

  # --- AC 24: FAILURE - a job with nothing searchable left ---
  Scenario: A job with no domains whose school name strips to nothing is never sent to Gmail
    Given a stored processing job with domains [], no search terms, and school name "\"\"\""
    When a scan runs
    Then the job is reported as "not_configured"
    And no Gmail query is issued for it
    And building its query fails with code "no_job_query"

  # --- AC 26, 27: extraction context ---
  Scenario: Every one of a job's domains reaches the extraction context
    Given a stored processing job with domains ["stmarys.edu.au", "pandc.org.au"] and school name "St Mary's Primary"
    When a scan extracts events from a matching message
    Then the extraction is called with searchDomains ["stmarys.edu.au", "pandc.org.au"]
    And the extraction is called with schoolNames ["St Mary's Primary"]
    And a message from "office@pandc.org.au" is treated as a watched sender

  # --- AC 28, 30: THE LEGACY FALLBACK still works for an unmigrated row ---
  Scenario: A row with no processingJobs still scans via the legacy one-job-per-domain fallback
    Given a stored connection row with no "processingJobs" attribute
    And legacy schoolNames ["St Mary's Primary", "Holy Cross"] and legacy searchDomains ["stmarys.edu.au", "holycross.edu.au"]
    When the scan resolves its processing jobs
    Then it produces 2 jobs
    And job 0 has id "legacy#stmarys.edu.au" and domains ["stmarys.edu.au"]
    And job 1 has id "legacy#holycross.edu.au" and domains ["holycross.edu.au"]
    And no job has a "domain" key
    And each job's Gmail query filters on its own single domain

  # --- AC 29: FAILURE MODE GUARDED - an already-migrated singular row must not lose its domain (scan side) ---
  Scenario: A row saved under the old singular job shape still scans on its domain
    Given a stored connection row whose processingJobs list holds one job with domain "stmarys.edu.au" and no domains key
    When the scan resolves its processing jobs
    Then that job has domains ["stmarys.edu.au"]
    And its Gmail query contains "from:@stmarys.edu.au"

  # --- AC 38: FAILURE MODE GUARDED - the same row must not lose its domain in the settings/auth-me response ---
  Scenario: A row saved under the old singular job shape still shows its domain in settings
    Given a stored connection row whose processingJobs list holds one job with domain "stmarys.edu.au" and no domains key
    When they GET settings
    Then the response body processingJobs[0].domains is ["stmarys.edu.au"]
    And the response body processingJobs[0] has no "domain" key
    When they GET auth/me
    Then the response body processingJobs[0].domains is ["stmarys.edu.au"]

  # --- AC 37: the connections.mjs legacy synthesis matches the new shape ---
  Scenario: connections.mjs's own legacy synthesis emits domains, not domain
    Given a stored row with no processingJobs, legacy schoolNames ["St Mary's Primary"] and legacy searchDomains ["stmarys.edu.au", "pandc.org.au"]
    When they GET settings
    Then the response body processingJobs[0].domains is ["stmarys.edu.au"]
    And the response body processingJobs[0].searchTerms includes "pandc.org.au"
    And the response body processingJobs[0] has no "domain" key

  # --- AC 28: low-level DynamoDB shape tolerance ---
  Scenario: A raw low-level DynamoDB row is read into plain domain strings
    Given a stored connection row whose processingJobs is { L: [ { M: { domains: { L: [ { S: "stmarys.edu.au" }, { S: " pandc.org.au " } ] } } } ] }
    When the scan resolves its processing jobs
    Then that job has domains ["stmarys.edu.au", "pandc.org.au"]

  # --- AC 15: storage shape ---
  Scenario: An empty domains list is stored as an empty DynamoDB list
    When the user saves a processing job with no domains
    Then the DynamoDB patch writes processingJobs as a list of maps
    And that job's "domains" attribute is an empty list, not absent and not a set
    And the patch still REMOVEs the legacy schoolNames, searchDomains and schoolName attributes
```
