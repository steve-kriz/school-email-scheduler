---
id: TASK-055
title: Replace schoolNames/searchDomains with multiple named processing jobs (settings model)
status: done
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T12:05:00Z
question: NON-BLOCKING, defaults taken, ticket is buildable as written. (1) DEPLOY COUPLING / LEGACY REQUEST SHAPE. Additional Context says schoolNames/searchDomains are "REMOVED from the read/write contract entirely", which is stricter than TASK-053's precedent - TASK-053 kept ACCEPTING the superseded field on the way IN (settings.mjs:715-733) so a browser tab loaded before the deploy still saved. Taking Additional Context literally means the moment TASK-055 deploys alone, the CURRENT settings page (frontend/settings.js:182-187 always PUTs schoolNames + searchDomains and never processingJobs) gets a 400 on every save, and app.js's needsSchool gate reads me.schoolNames which /auth/me will no longer emit. DEFAULT TAKEN - follow Additional Context literally: the PUT accepts ONLY processingJobs, a legacy-only body is a 400 with field "processingJobs", and migration is READ-side only. Consequence recorded in "Edge and Failure Cases": TASK-055 and TASK-057 must ship in the same deploy, and TASK-055 alone must not be released to users. If the user would rather TASK-055 be independently releasable, the alternative is a transitional request-side alias (a body carrying only schoolNames/searchDomains is folded into one synthesized job using the same rule as migrate-on-read) - say so and this ticket gains one AC and one scenario. (2) CAP VALUES, which Additional Context explicitly delegates ("pick a sensible max, e.g. 20"). DEFAULTS TAKEN - MAX_PROCESSING_JOBS = 20, MAX_SEARCH_TERMS_PER_JOB = 20, MAX_SEARCH_TERM_LENGTH = 80 code points. 80 rather than the file's existing 120 because a search term is bounded by Gmail QUERY length, not by prompt token cost - 20 terms x ~86 chars quoted and OR-joined is ~1.7KB, which leaves TASK-056 headroom under the ~2KB practical query limit, whereas 20 x 120 would be ~2.5KB and put TASK-056's generated query over it. Worst-case row is ~20 x 2.2KB = ~44KB, comfortably inside the 400KB item limit.
---

## Description
Replace the single `schoolNames`/`searchDomains` settings (added by TASK-053) with a
list of named **processing jobs**. Each processing job is one independent
"search + extract" configuration: a name, a school name, a domain, and a list
of free-text search terms. This ticket is the backend settings model only —
the Gmail query builder, scan pipeline and event attribution are TASK-056; the
settings UI is TASK-057; calendar/attention filtering is TASK-058. Those
tickets depend on the shape decided here, so do not rename any field below
without updating this ticket first.

This ticket lives in `src/lambda/calendar/backend/settings.mjs`. Read it in
full first — it already has a migrate-on-read/clear-on-write precedent from
TASK-053 (`schoolName` -> `schoolNames`) to follow for this migration.

## Additional Context
(This section documents fixed design decisions other tickets depend on. Do
not diverge from field names or shapes below without flagging it back.)

**ProcessingJob shape** (one element of the new `processingJobs` array):
```js
{
  id: string,            // stable, server-generated (crypto.randomUUID()), never
                          // changes once created - TASK-056 attributes events to
                          // this id, and it must survive a job being renamed
  name: string,           // required, non-empty, must be unique among this
                          // user's own jobs (case-insensitive compare) - this is
                          // what TASK-058's filter UI displays and matches on
  schoolName: string,     // required, non-empty, one school name (NOT an array
                          // - TASK-053's array existed because there was only
                          // ONE job; multiple schools now means multiple jobs)
  domain: string,         // required, non-empty, one search domain, same
                          // validation rules TASK-053's validateSearchDomains
                          // already applies (hostname-shaped, lowercased, etc)
  searchTerms: string[],  // zero or more free-text terms, each trimmed and
                          // non-empty after trimming; cap the count (pick a
                          // sensible max, e.g. 20, matching the existing
                          // MAX_SCHOOL_NAMES-style cap pattern already in this
                          // file) and reject anything absurdly long the same
                          // way validateSchoolNames already caps name length
}
```

**Settings record change:** `schoolNames` and `searchDomains` are REMOVED from
the read/write contract entirely, replaced by `processingJobs: ProcessingJob[]`.
Cap the number of jobs too (pick a sensible max, e.g. 20) - a settings row is
one DynamoDB item and must stay well inside the 400KB item limit.

**Storage shape is a genuine change, not a copy-paste of the existing Set
pattern.** `schoolNames`/`searchDomains` are stored today as native DynamoDB
String Sets (`new Set(names)`, see `patchSettingsUpdate` around line 795-804).
`processingJobs` is a list of objects with a nested array field
(`searchTerms`), which DynamoDB represents as a List of Maps (`L` of `M`), not
a String Set - the marshalling code needs to build that shape explicitly. The
AWS SDK v3 document client marshals plain JS arrays-of-objects to `L`/`M`
correctly on its own; the point is not to reuse `new Set(...)` for this field.

**Migrate-on-read, exactly like TASK-053's precedent:** when a stored row has
no `processingJobs` (or an empty array) AND has legacy `schoolNames` and/or
`searchDomains` data, synthesize exactly ONE default processing job on READ
(never written back until the user's next PUT, same as TASK-053):
- `id`: any stable-for-this-read value is fine (e.g. `"default"`) since it is
  re-synthesized every read until the user saves for real.
- `name`: `"Default"`.
- `schoolName`: the first entry of the legacy `schoolNames` list, or `""` if
  none.
- `domain`: the first entry of the legacy `searchDomains` list, or `""` if
  none.
- `searchTerms`: every REMAINING legacy entry - `schoolNames[1:]` concatenated
  with `searchDomains[1:]` - folded in as search terms. This is deliberate:
  under the new model schoolName/domain/searchTerms are all OR'd together
  (TASK-056), so folding the rest in as search terms is a lossless migration
  that preserves full search coverage, not a data-dropping shortcut.
- On the next PUT of settings (now sending `processingJobs`), clear the legacy
  `schoolNames`/`searchDomains` attributes from the row entirely, mirroring
  TASK-053's "schoolNames always also REMOVEs schoolName" clear-on-write rule.

**Validation errors** should follow the existing `SettingsValidationError`
pattern in this file (field name + message), with a field name of
`processingJobs` (or `processingJobs[<index>].<field>` if you want per-job
precision - either is acceptable as long as it is consistent and documented).

## Acceptance Criteria

### Constants and shape (backend/settings.mjs)
- [ ] New exported constants, placed beside the existing caps and documented the
      same way: `MAX_PROCESSING_JOBS = 20`, `MAX_PROCESSING_JOB_NAME_LENGTH = 120`,
      `MAX_SEARCH_TERMS_PER_JOB = 20`, `MAX_SEARCH_TERM_LENGTH = 80`.
- [ ] `MAX_SCHOOL_NAME_LENGTH = 120` is UNCHANGED and now bounds a job's single
      `schoolName`. `MAX_DOMAIN_LENGTH`/`MAX_DOMAIN_LABEL_LENGTH` are unchanged and
      bound a job's single `domain`.
- [ ] `MAX_SCHOOL_NAMES` and `MAX_SEARCH_DOMAINS` are no longer referenced by any
      validator in this file. Deleting them is optional; if either is kept it is
      only because something outside this file still imports it, and the docblock
      says so.
- [ ] A validated job is exactly the five keys `{ id, name, schoolName, domain,
      searchTerms }` and no others — an unknown key in the request payload is
      dropped, not stored and not rejected (the stored item must not grow fields
      nobody validated).
- [ ] `SETTINGS_FIELDS` lists `"processingJobs"` and no longer lists
      `"schoolNames"` or `"searchDomains"`.

### Per-job validation (`validateProcessingJobs`)
- [ ] A new exported `validateProcessingJobs(raw, { newId } = {})` returns
      `ProcessingJob[]` with input order preserved, and throws
      `SettingsValidationError` on any failure below. `newId` defaults to
      `randomUUID` from `node:crypto` and is injectable, per the module docblock's
      testability rule (settings.mjs:44-46) — every branch must be reachable with
      a stubbed id generator and no network.
- [ ] `name`: required; must be a string; trimmed; rejected when empty or
      whitespace-only after trimming; rejected when longer than
      `MAX_PROCESSING_JOB_NAME_LENGTH` counted by `countCodePoints` (not
      `.length`). Stored exactly as trimmed — case preserved, no lower-casing, no
      escaping, per the module's NO SANITISATION rule.
- [ ] `schoolName`: required; a single string (never an array); same rules as
      `name` but bounded by `MAX_SCHOOL_NAME_LENGTH`. An array value is REJECTED
      rather than silently taking its first element.
- [ ] `domain`: required; a single string; passed through the EXISTING
      `normalizeDomain` then `isValidDomain`, and rejected by the EXISTING
      `isPublicMailDomain` check with the same "is a public email provider, not a
      school domain" message. The stored value is the normalized, lower-cased
      host. An array value is REJECTED.
- [ ] `searchTerms`: optional; absent, `null` or `undefined` all normalize to
      `[]`; a non-array value (including a bare string) is REJECTED rather than
      wrapped or comma-split — a search term may legitimately contain a comma, for
      the same reason `validateSchoolNames` refuses to comma-split.
- [ ] Each search term must be a string, is trimmed, is rejected when empty after
      trimming, and is rejected when longer than `MAX_SEARCH_TERM_LENGTH` code
      points. Terms are de-duplicated EXACTLY (case-sensitive, order preserved),
      matching `validateSchoolNames`' dedup stance rather than erroring.
- [ ] The `searchTerms` count is checked on what was SUBMITTED, BEFORE
      de-duplication, against `MAX_SEARCH_TERMS_PER_JOB`, matching the
      count-before-dedup rule in `validateSchoolNames` (settings.mjs:539-544).
- [ ] `id`: a client-supplied `id` that matches the canonical UUID shape
      (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) is
      PRESERVED verbatim — this is the only way an id survives a rename, since the
      PUT is a whole-list replace and never reads the stored row.
- [ ] Any other `id` — absent, empty, non-string, malformed, or the synthesized
      literal `"default"` — is REPLACED with a freshly generated `newId()`. It is
      never a 400: the first real save after a migrate-on-read legitimately echoes
      `"default"` back, and rejecting it would 400 every migrated user's first save.
- [ ] Two jobs in one payload carrying the SAME valid `id` are rejected (field
      `processingJobs`), so attribution cannot become ambiguous for TASK-056.

### Collection validation
- [ ] A non-array `processingJobs` (object, string, number, `null`) is rejected
      with field `processingJobs` and a message naming the field.
- [ ] An EMPTY array is rejected with field `processingJobs` and a message in the
      house style, e.g. "At least one processing job is required" — mirroring
      "At least one school email domain is required" (settings.mjs:596).
- [ ] More than `MAX_PROCESSING_JOBS` jobs is rejected with field
      `processingJobs`, counted on what was SUBMITTED before any de-duplication,
      and the message names the number 20.
- [ ] Two jobs whose `name` matches CASE-INSENSITIVELY after trimming are
      REJECTED with a `SettingsValidationError` naming the duplicated name.
      Duplicate names ERROR, they do NOT collapse — this is deliberately the
      opposite of `validateSearchDomains`' collapse-duplicates rule, because a
      job name is an identity the user picks and TASK-058's filter UI matches on
      it.
- [ ] The stored casing of a name is the FIRST occurrence exactly as the user
      typed it; the case-insensitive compare is used for the uniqueness check only
      and never rewrites the stored value.
- [ ] Two jobs may share the same `domain`, the same `schoolName`, or both, with
      different names — this is explicitly allowed and must not be rejected
      (TASK-056 documents cross-job duplicate events as an expected case).

### Error field naming
- [ ] Collection-level failures (not an array, empty, too many, duplicate name,
      duplicate id) use `field: "processingJobs"`.
- [ ] Per-job failures use `field: "processingJobs[<index>].<key>"` where
      `<index>` is the zero-based index in the SUBMITTED array and `<key>` is one
      of `name`, `schoolName`, `domain`, `searchTerms` — e.g.
      `"processingJobs[2].domain"`.
- [ ] The rejected value in every message is echoed through the existing `echo`
      helper (capped at 64 characters, unescaped), and no message contains the
      whole payload.
- [ ] `SettingsValidationError`'s docblock (settings.mjs:386-390), which currently
      says `field` is "one of the SETTINGS_FIELDS names, or null", is updated to
      record the new indexed form so the contract stays documented where it is
      enforced.

### Request contract (`requireValidSettings`, `validateSettingsPayload`)
- [ ] `requireValidSettings` returns `{ processingJobs, ...validateSchedule(...) }`
      and no longer returns `schoolNames` or `searchDomains`.
- [ ] `requireValidSettings` reads `payload.processingJobs` only. A body carrying
      only legacy `schoolNames`/`searchDomains`/`schoolName` is a 400 with field
      `processingJobs` (see the parked question — this is the default taken).
- [ ] `validateSchoolNames` and `validateSearchDomains` are no longer called by
      `requireValidSettings`. They may remain exported (other modules and tests
      import them) but the module docblock records that they are no longer part of
      the settings request path.
- [ ] `validateSettingsPayload` still returns `{ valid: false, field, error }` for
      a `SettingsValidationError` and rethrows anything else — unchanged behaviour,
      now carrying indexed field names.
- [ ] The schedule fields (`scheduleEnabled`, `scheduleFrequency`, `scheduleHour`,
      `timezone`) are unchanged: still optional, still "absent means leave alone".

### Storage and patch (`buildConnectionPatch`)
- [ ] `buildConnectionPatch` writes `processingJobs` as a PLAIN JS ARRAY of PLAIN
      OBJECTS, letting the document client marshal it to `L` of `M`. It must NOT
      use `new Set(...)` for this field, and must not stringify it to JSON.
- [ ] Each written job object carries exactly `{ id, name, schoolName, domain,
      searchTerms }`, with `searchTerms` written as a plain array (`L` of `S`),
      including an EMPTY array — DynamoDB accepts an empty `L`, unlike an empty
      `SS`, so `searchTerms: []` is stored as-is and is NOT turned into a removal.
- [ ] An empty `processingJobs` array (unreachable from the PUT, reachable from
      any other caller) writes `REMOVE_ATTRIBUTE` rather than an empty list. This
      is a consistency choice with the existing string-set branches, not a DynamoDB
      constraint, and the code comment says so rather than repeating the
      empty-SS-is-a-write-error reason, which does not apply here.
- [ ] Whenever `processingJobs` is written, the SAME patch also emits
      `schoolNames: REMOVE_ATTRIBUTE`, `searchDomains: REMOVE_ATTRIBUTE` AND
      `schoolName: REMOVE_ATTRIBUTE` — all three legacy attributes are cleared in
      one UpdateItem. `schoolName` is included because a row that never saved since
      TASK-053 still carries the original scalar and nothing else will ever clear it
      now that nothing writes `schoolNames`.
- [ ] The compiled `UpdateExpression` is a MIXED SET + REMOVE with
      `ExpressionAttributeValues` present (`buildUpdateParams` omits that map only
      when a patch is all removals — connections.mjs:250). Assert the compiled
      expression, not just the round-trip.
- [ ] `saveSettings` is otherwise unchanged: still `updateConnection` only, never
      `putConnection`, and the patch still carries no token attribute.

### Projection and migrate-on-read (backend/connections.mjs, backend/settings.mjs)
- [ ] `PUBLIC_ATTRIBUTES` contains `"processingJobs"` and no longer contains
      `"schoolNames"` or `"searchDomains"`. No response body from any route emits
      either key, nor `schoolName`.
- [ ] `jsonSafeValue` passes an array of objects through unchanged (it already
      returns `value` for `Array.isArray`), so a stored `L` of `M` projects as-is.
      No sorting is applied to `processingJobs`: unlike a `Set`, a DynamoDB List
      preserves order, and the user's job order is meaningful.
- [ ] The migrate-on-read synthesis lives in `toPublicJson`, next to the existing
      TASK-053 `schoolName` fallback, so `/calendar/api/settings` AND
      `/calendar/api/auth/me` both see the new shape — matching TASK-053's precedent
      of putting the one legacy read in the shared projection.
- [ ] Synthesis triggers when the projected `processingJobs` is absent/null/empty
      AND at least one legacy source is present. It NEVER triggers when a non-empty
      `processingJobs` exists — the stored jobs always win.
- [ ] Legacy sources are normalized before use: `schoolNames` from a JS `Set`,
      `{ SS: [...] }` or an array; if `schoolNames` is absent, the legacy scalar
      `schoolName` string is read as a ONE-ELEMENT names list (TASK-053's own
      fallback, still needed here); `searchDomains` from a `Set`, `{ SS: [...] }`
      or an array. Blank entries are dropped.
- [ ] Because a DynamoDB string set is UNORDERED, both legacy lists are SORTED
      before "first entry" is taken, matching `jsonSafeValue`'s existing sort. The
      synthesized job is therefore identical on every read of the same row.
- [ ] The synthesized job is exactly: `id: "default"`, `name: "Default"`,
      `schoolName: <first sorted legacy school name, or "">`,
      `domain: <first sorted legacy domain, or "">`,
      `searchTerms: [...legacyNames.slice(1), ...legacyDomains.slice(1)]`.
- [ ] The synthesis is READ-ONLY: no write is issued during a GET, and the stored
      row still carries its legacy attributes until the user's next PUT.
- [ ] A row with NEITHER legacy attribute NOR `processingJobs` projects
      `processingJobs: null` from `toPublicJson` (consistent with every other unset
      attribute) and `[]` from `toSettingsJson`'s coercion — the same null-vs-empty
      split TASK-053 settled for `schoolNames` (see TASK-053 AC, `/auth/me` returns
      null, `/settings` returns `[]`).
- [ ] `toSettingsJson` coerces `processingJobs` to `[]` when it is not an array,
      and no longer coerces `schoolNames`/`searchDomains`.

### Routes (index.mjs)
- [ ] `GET /calendar/api/settings` returns `processingJobs` as an array for: a row
      with real jobs, a legacy row (one synthesized job), and a row with nothing
      (`[]`). It returns no `schoolNames`, `searchDomains` or `schoolName` key.
- [ ] `PUT /calendar/api/settings` with a valid `processingJobs` body returns 200
      and a body whose `processingJobs` echoes what was stored, in submitted order,
      each job carrying a server-owned `id`.
- [ ] A validation failure returns 400 with the `field` from the error (including
      the indexed form) and a client-safe message, and NOTHING is written — assert
      via a spy on the injected `updateItem` that it was never called.
- [ ] The success log line (index.mjs:1322-1325) no longer reads
      `settings.schoolNames.length` / `settings.searchDomains.length` — those keys
      no longer exist and would throw a `TypeError` inside the 200 path. It logs
      COUNTS ONLY: `jobCount` and, at most, a total `searchTermCount`. No job name,
      school name, domain or search term is ever logged — they are personal data
      (index.mjs:1312, 1320).
- [ ] `handlePutSettings`' docblock, which says "save the school name and search
      domains", is updated to describe processing jobs.

### Non-regression and scope
- [ ] `src/lambda/calendar/backend/scan.mjs` is NOT changed by this ticket
      (TASK-056 owns it) and must not crash: `toDomainList(undefined)` returns `[]`
      (anthropic.mjs:425-442), so a row saved through the new PUT reports
      `SCAN_STATUS.NOT_CONFIGURED` and never calls Gmail. That degraded-but-safe
      behaviour must be asserted, not assumed.
- [ ] `src/lambda/calendar/frontend/**` is NOT changed by this ticket (TASK-057
      owns it).
- [ ] `terraform/dynamodb_calendar_connections.tf`'s schema COMMENT block documents
      `processingJobs (L of M)` with its per-job keys, and records that
      `schoolNames (SS)` / `searchDomains (SS)` / `schoolName (S)` are legacy,
      read-migrated and cleared on next save. No resource change — the table is
      schemaless beyond the `userId` hash key.
- [ ] The module docblock at the top of `settings.mjs` (lines 1-47) is rewritten
      where it describes "one or more school display names plus one or more sender
      domains" and the string-set storage rule, so the file's own documentation
      matches what it now enforces.
- [ ] The full existing suite passes, with the `schoolNames`/`searchDomains`
      assertions in the test files listed under "Relevant Files and Context"
      updated to the new shape.

## Cucumber Tests

```gherkin
Feature: A user configures independent named processing jobs

  Background:
    Given an authenticated user with a connection row
    And the DynamoDB UpdateItem call is a spy on an injected updateItem

  Scenario: Adding and saving one processing job
    When they PUT settings with one processing job named "St Mary's" for school
      "St Mary's Primary", domain "stmarys.edu.au" and search terms
      ["canteen roster", "swimming carnival"]
    Then the response status code is 200
    And the response body processingJobs has 1 entry
    And that entry name is "St Mary's"
    And that entry schoolName is "St Mary's Primary"
    And that entry domain is "stmarys.edu.au"
    And that entry searchTerms is ["canteen roster", "swimming carnival"]
    And that entry id is a canonical UUID
    And the response body has no schoolNames key
    And the response body has no searchDomains key
    And the stored processingJobs attribute is a plain array of plain objects, not a Set

  Scenario: Two jobs for two different schools are saved in submitted order
    When they PUT settings with jobs named ["Zeta", "Alpha"]
    Then the response status code is 200
    And the response body processingJobs names are ["Zeta", "Alpha"]

  Scenario: A job with no search terms is valid
    When they PUT settings with one job whose searchTerms is []
    Then the response status code is 200
    And the stored job searchTerms is an empty list, not a removed attribute

  Scenario: An absent searchTerms key normalizes to an empty list
    When they PUT settings with one job that omits searchTerms entirely
    Then the response status code is 200
    And the response body processingJobs[0].searchTerms is []

  Scenario: Two jobs may legitimately share a domain
    When they PUT settings with jobs "Newsletters" and "Sport", both on domain
      "stmarys.edu.au"
    Then the response status code is 200
    And the response body processingJobs has 2 entries

  Scenario: A domain is normalized the same way it always was
    When they PUT settings with one job whose domain is "https://StMarys.EDU.au/news"
    Then the response status code is 200
    And the response body processingJobs[0].domain is "stmarys.edu.au"

  Scenario: A job name keeps its exact characters
    When they PUT settings with one job named "P&C Association - École, Annexe"
    Then the response status code is 200
    And the response body processingJobs[0].name is "P&C Association - École, Annexe"

  Scenario: Twenty jobs are accepted
    When they PUT settings with 20 distinctly named jobs
    Then the response status code is 200
    And the response body processingJobs has 20 entries

  Scenario: Saving clears every legacy attribute in the same write
    Given a stored row carrying schoolNames, searchDomains and a legacy schoolName scalar
    When they PUT settings with one valid processing job
    Then the UpdateItem expression SETs processingJobs
    And the UpdateItem expression REMOVEs schoolNames, searchDomains and schoolName
    And ExpressionAttributeValues is present on that UpdateItem
    And the stored row afterwards has none of those three legacy attributes

Feature: Processing job ids are stable across a rename

  Scenario: A client-echoed UUID is preserved
    Given a stored job with id "6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d" named "Old name"
    When they PUT settings with that same id and the name "New name"
    Then the response status code is 200
    And the response body processingJobs[0].id is "6f1d2c1e-1c2a-4a3b-8c4d-9e0f1a2b3c4d"
    And the response body processingJobs[0].name is "New name"

  Scenario Outline: An unusable id is replaced rather than rejected
    When they PUT settings with one job whose id is <id>
    Then the response status code is 200
    And the response body processingJobs[0].id is a freshly generated UUID
    Examples:
      | id          |
      | absent      |
      | ""          |
      | "default"   |
      | "not-a-uuid"|
      | 12345       |

  Scenario: Two jobs sharing one id are refused
    When they PUT settings with two jobs carrying the same valid UUID id
    Then the response status code is 400
    And the response body field is "processingJobs"
    And updateItem was never called

# --- Validation failures and edge paths ---

Feature: Invalid processing jobs are refused and nothing is written

  Scenario: Duplicate job names differing only by case are refused
    When they PUT settings with jobs named ["St Mary's", "ST MARY'S"]
    Then the response status code is 400
    And the response body field is "processingJobs"
    And the error message mentions the duplicated name
    And updateItem was never called

  Scenario: A missing required field is refused and names the offending job
    When they PUT settings with two jobs where the second job omits schoolName
    Then the response status code is 400
    And the response body field is "processingJobs[1].schoolName"
    And updateItem was never called

  Scenario Outline: Each required per-job field is enforced
    When they PUT settings with one job whose <field> is <value>
    Then the response status code is 400
    And the response body field is "processingJobs[0].<field>"
    Examples:
      | field      | value           |
      | name       | absent          |
      | name       | ""              |
      | name       | "   "           |
      | name       | 42              |
      | schoolName | absent          |
      | schoolName | "  "            |
      | schoolName | ["A","B"]       |
      | domain     | absent          |
      | domain     | ""              |
      | domain     | "stmarys"       |
      | domain     | "-bad-.edu.au"  |
      | domain     | ["a.edu.au"]    |

  Scenario: A public mail provider domain is still refused, per job
    When they PUT settings with one job whose domain is "gmail.com"
    Then the response status code is 400
    And the response body field is "processingJobs[0].domain"
    And the error message says it is a public email provider

  Scenario: An empty job list is refused
    When they PUT settings with processingJobs []
    Then the response status code is 400
    And the response body field is "processingJobs"
    And the error message says at least one processing job is required

  Scenario Outline: A non-array processingJobs is refused
    When they PUT settings with processingJobs <value>
    Then the response status code is 400
    And the response body field is "processingJobs"
    Examples:
      | value                |
      | absent               |
      | null                 |
      | "St Mary's"          |
      | { "0": { } }         |

  Scenario: More than twenty jobs is refused, counted before de-duplication
    When they PUT settings with 21 jobs of which 3 share a name
    Then the response status code is 400
    And the response body field is "processingJobs"
    And the error message mentions 20

  Scenario: More than twenty search terms in one job is refused before de-duplication
    When they PUT settings with one job carrying 21 search terms of which 5 are duplicates
    Then the response status code is 400
    And the response body field is "processingJobs[0].searchTerms"
    And the error message mentions 20

  Scenario: A bare string searchTerms is refused, never comma-split
    When they PUT settings with one job whose searchTerms is "canteen, uniform"
    Then the response status code is 400
    And the response body field is "processingJobs[0].searchTerms"

  Scenario: A blank search term is refused
    When they PUT settings with one job whose searchTerms is ["canteen", "   "]
    Then the response status code is 400
    And the response body field is "processingJobs[0].searchTerms"

  Scenario: Duplicate search terms collapse rather than failing the save
    When they PUT settings with one job whose searchTerms is ["canteen", " canteen "]
    Then the response status code is 200
    And the response body processingJobs[0].searchTerms is ["canteen"]

  Scenario: A search term over 80 code points is refused, counted by code point
    When they PUT settings with one job carrying a search term of 81 emoji code points
    Then the response status code is 400
    And the response body field is "processingJobs[0].searchTerms"
    And the error message mentions 80

  Scenario: A search term of exactly 80 emoji code points is accepted
    When they PUT settings with one job carrying a search term of 80 emoji code points
    Then the response status code is 200

  Scenario: A job name over 120 code points is refused
    When they PUT settings with one job whose name is 121 code points long
    Then the response status code is 400
    And the response body field is "processingJobs[0].name"
    And the error message mentions 120

  Scenario: A rejected value is echoed length-capped
    When they PUT settings with one job whose name is 500 characters long
    Then the response status code is 400
    And the echoed value in the error message is at most 64 characters plus an ellipsis

  Scenario: Unknown per-job keys are dropped, not stored and not rejected
    When they PUT settings with one valid job carrying an extra key "isAdmin": true
    Then the response status code is 200
    And the stored job has exactly the keys id, name, schoolName, domain, searchTerms

  Scenario: A legacy-only body is refused now that the contract has moved
    When they PUT settings with schoolNames ["St Mary's"] and searchDomains ["stmarys.edu.au"]
      and no processingJobs
    Then the response status code is 400
    And the response body field is "processingJobs"
    And updateItem was never called

Feature: Existing rows migrate on read into one default processing job

  Scenario: An old-shape row reads back as one synthesized default job
    Given a stored row whose schoolNames is a string set of ["St Mary's Primary"]
    And whose searchDomains is a string set of ["stmarys.edu.au"]
    And which has no processingJobs attribute
    When they GET settings
    Then the response status code is 200
    And the response body processingJobs has 1 entry
    And that entry id is "default"
    And that entry name is "Default"
    And that entry schoolName is "St Mary's Primary"
    And that entry domain is "stmarys.edu.au"
    And that entry searchTerms is []
    And the response body has no schoolNames key
    And the response body has no searchDomains key
    And no write was issued during the GET

  Scenario: Remaining legacy entries are folded into searchTerms, not dropped
    Given a stored row whose schoolNames is a string set of ["Alpha School", "Beta School", "Gamma School"]
    And whose searchDomains is a string set of ["alpha.edu.au", "beta.edu.au"]
    And which has no processingJobs attribute
    When they GET settings
    Then the response body processingJobs has 1 entry
    And that entry schoolName is "Alpha School"
    And that entry domain is "alpha.edu.au"
    And that entry searchTerms is ["Beta School", "Gamma School", "beta.edu.au"]

  Scenario: The synthesized job is identical on every read of the same row
    Given a stored row with legacy string sets in an arbitrary storage order
    When they GET settings twice
    Then both responses have the same processingJobs[0].schoolName
    And both responses have the same processingJobs[0].domain
    And both responses have the same processingJobs[0].searchTerms

  Scenario: A legacy row with only school names synthesizes an empty domain
    Given a stored row whose schoolNames is ["Alpha School"] and which has no searchDomains
    When they GET settings
    Then the response body processingJobs[0].schoolName is "Alpha School"
    And the response body processingJobs[0].domain is ""

  Scenario: A legacy row with only domains synthesizes an empty school name
    Given a stored row whose searchDomains is ["alpha.edu.au"] and which has no schoolNames
    When they GET settings
    Then the response body processingJobs[0].schoolName is ""
    And the response body processingJobs[0].domain is "alpha.edu.au"

  Scenario: A pre-TASK-053 row whose school is still a scalar also migrates
    Given a stored row whose schoolName is the scalar string "Alpha School"
    And whose searchDomains is ["alpha.edu.au"]
    And which has no schoolNames and no processingJobs
    When they GET settings
    Then the response body processingJobs[0].schoolName is "Alpha School"
    And the response body has no schoolName key

  Scenario: Real stored jobs always win over legacy attributes
    Given a stored row carrying BOTH a non-empty processingJobs list and legacy schoolNames
    When they GET settings
    Then the response body processingJobs is the stored list
    And no "Default" job is synthesized

  Scenario: An empty stored processingJobs list still triggers synthesis
    Given a stored row whose processingJobs is an empty list and which has legacy schoolNames
    When they GET settings
    Then the response body processingJobs has 1 entry named "Default"

  Scenario: A row with nothing at all reports an empty list
    Given a stored row with no processingJobs and no legacy attributes
    When they GET settings
    Then the response body processingJobs is []

  Scenario: /auth/me sees the same migration
    Given a stored row with legacy schoolNames and searchDomains and no processingJobs
    When they GET auth/me
    Then the response body processingJobs has 1 entry named "Default"

  Scenario: /auth/me reports null rather than [] for a row with nothing
    Given a stored row with no processingJobs and no legacy attributes
    When they GET auth/me
    Then the response body processingJobs is null

  Scenario: Saving a migrated job replaces the placeholder id with a real one
    Given a legacy row that reads back as the synthesized "default" job
    When they PUT settings echoing that job back with id "default" and a filled-in domain
    Then the response status code is 200
    And the response body processingJobs[0].id is a canonical UUID
    And the response body processingJobs[0].id is not "default"
    And the stored row afterwards has no schoolNames, searchDomains or schoolName

Feature: The scan pipeline degrades safely until TASK-056 lands

  Scenario: A row saved in the new shape reports not_configured instead of crashing
    Given a stored row whose only settings attribute is processingJobs
    When runScan is invoked for that user
    Then the scan status is "not_configured"
    And Gmail was never called
    And no exception is thrown

Feature: Personal data never reaches a log line

  Scenario: A successful save logs counts only
    When they PUT settings with one job named "St Mary's" and search term "canteen roster"
    Then the response status code is 200
    And the settings-saved log line contains a job count
    And the log output contains no job name, school name, domain or search term
```

## Edge and Failure Cases the implementer must handle

- **`settings.schoolNames.length` in the 200 path will throw.** index.mjs:1323-1324
  reads `settings.schoolNames.length` and `settings.searchDomains.length` from the
  validated object. Once `requireValidSettings` stops returning those keys, that log
  line raises a `TypeError` AFTER a successful write — a save that actually
  succeeded would be reported to the user as a 500 (or an unhandled rejection).
  This is the single most likely way to break the PUT route, and it is inside
  `index.mjs`, not `settings.mjs`.
- **Empty `L` is legal; empty `SS` is not.** The `REMOVE_ATTRIBUTE` machinery
  exists because DynamoDB rejects an empty string set. That reason does NOT apply
  to `processingJobs` or to a job's `searchTerms`. `searchTerms: []` must be stored
  as an empty list; only the whole-list-empty case uses `REMOVE_ATTRIBUTE`, and for
  consistency rather than necessity. Do not copy the empty-SS comment verbatim.
- **Do not reuse `new Set(...)` for `processingJobs`.** `JSON.stringify(new Set())`
  is `"{}"` — a Set that escapes into a response body silently becomes an empty
  object, which is exactly the class of failure `jsonSafeValue` exists to prevent
  (connections.mjs:297-313).
- **String sets are UNORDERED.** "The first entry of the legacy `schoolNames` list"
  is only well-defined after sorting. Without an explicit sort, the synthesized job's
  `schoolName` can differ between two reads of the same unchanged row, which would
  make the migration non-deterministic and the tests flaky.
- **`getConnection` returns RAW stored values.** The migrate-on-read fallback runs
  inside `toPublicJson` against a raw row, so the legacy values arrive as JS `Set`s
  (or `{ SS: [...] }`, or a bare scalar for a pre-TASK-053 row) — never as arrays.
  Normalise all four shapes; do not assume an array.
- **The synthesized job is NOT valid input.** It can carry `schoolName: ""` or
  `domain: ""`, which the PUT validator rejects. That is intended: the user must
  fill the gap before the first real save. TASK-057 must not auto-submit the
  synthesized job unchanged, and this ticket must not "fix" it by relaxing the
  required-field rules.
- **`"default"` will be echoed back by the client.** Replacing (not rejecting) a
  non-UUID id is what stops every migrated user's first save from 400ing.
- **A whole-list-replace PUT is how a job is deleted.** There is no per-job DELETE
  route. A job absent from the submitted list is gone, and its id is gone with it —
  TASK-056's events keep a `processingJobId` pointing at a job that no longer
  exists, and TASK-058 must tolerate that. Flagged here so those tickets do not
  discover it late.
- **Case-insensitive uniqueness must not rewrite the stored casing.** Compare on a
  lower-cased trimmed copy; store the original. This is the same distinction
  `validateSchoolNames` makes when it refuses to lower-case display text
  (settings.mjs:506-531).
- **Count caps BEFORE de-duplicating**, for both jobs and search terms, so 21
  entries containing duplicates is reported as "too many" rather than collapsing to
  a passing number (matches settings.mjs:539-544 and 598-603).
- **Code points, not UTF-16 units.** Use `countCodePoints`; `.length` wrongly
  rejects a name of 113 four-byte emoji that is inside a 120 bound.
- **`buildUpdateParams` omits `ExpressionAttributeValues` for an all-removal patch**
  (connections.mjs:250). The new patch is mixed SET + REMOVE, so both the values map
  and both clauses must be present — assert the compiled expression, not only the
  round-trip.
- **`updateConnection` refuses token attributes** (connections.mjs:526-530). The
  patch must never grow one; do not work around that guard.
- **No sanitisation at the storage layer.** Job names, school names and search terms
  are stored raw. Escaping is the frontend's job on render (TASK-057) and the prompt
  builder's job via `defuseDelimiters` (TASK-056). Do not strip or escape here.
- **Personal data must not be logged.** A job name, school name, domain or search
  term never appears in a log line — counts only (index.mjs:1312, 1320).
- **KNOWN INTERMEDIATE STATE — TASK-055 must not ship alone.** With the default
  taken in the `question` field:
  - `frontend/settings.js:182-187` always PUTs `schoolNames` + `searchDomains` and
    never `processingJobs`, so every save from the current page 400s until TASK-057
    lands.
  - `frontend/app.js`'s `needsSchool` gate reads `me.schoolNames`, which `/auth/me`
    will no longer emit, so the "Tell us your school" card shows permanently.
  - `frontend/settings.js`'s `FIELD_ERROR_IDS` has no `processingJobs` key, so a
    field error falls through to the form-level line via `fieldErrorId`'s
    fail-closed branch (settings.js:99-102) — degraded, but not silent.
  - `scan.mjs` reads `connection?.searchDomains` directly, so a row saved in the new
    shape scans as `not_configured` until TASK-056 lands.
  TASK-055 + TASK-056 + TASK-057 must be released together.

## Relevant Files and Context

Backend (all under `src/lambda/calendar/`):
- `backend/settings.mjs` — the primary file. `SETTINGS_FIELDS` (66-76),
  `MAX_SCHOOL_NAME_LENGTH` (79), `MAX_SCHOOL_NAMES` (87), `MAX_SEARCH_DOMAINS`
  (94), `MAX_DOMAIN_LENGTH`/`MAX_DOMAIN_LABEL_LENGTH` (97-98), `PUBLIC_MAIL_DOMAINS`
  (143-200) and `PUBLIC_MAIL_BRANDS` (236-250) — both unchanged, still applied per
  job via `isPublicMailDomain` (353-360); `SettingsValidationError` (387-398, and
  its `field` docblock at 386-390 which this ticket must update); `countCodePoints`
  (410-412); `echo` (426-429); `normalizeDomain` (456-481); `isValidDomain`
  (493-503); `validateSchoolNames` (533-570) and `validateSearchDomains` (594-628) —
  the two functions whose count-then-normalise-then-dedup structure the new
  per-job validator mirrors, and whose OPPOSITE duplicate stances (collapse for
  domains, and now ERROR for job names) must be kept straight; `validateSchedule`
  (647-689, unchanged); `validateSettingsPayload` (701-710); `requireValidSettings`
  (725-735); `parseJsonBody` (751-769, unchanged); `buildConnectionPatch` (792-812)
  — NOTE: Additional Context calls this `patchSettingsUpdate`; the actual exported
  name in the file is `buildConnectionPatch`, and the `new Set(...)` marshalling it
  describes is at lines 795-808; `toSettingsJson` (833-840); `saveSettings`
  (873-883). Module docblock 1-47 states the string-set, no-sanitisation and
  testability rules and must be rewritten.
- `backend/connections.mjs` — `PUBLIC_ATTRIBUTES` (48-65); `REMOVE_ATTRIBUTE`
  (87, and its docblock 67-86 explaining the empty-SS constraint that does NOT
  apply to a List); `buildUpdateParams` (217-259, mixed SET/REMOVE and the
  omit-values-map rule at 250); `jsonSafeValue` (306-313, Set/`{SS}` handling and
  the sort); `toPublicJson` (349-370, and specifically the TASK-053 legacy read at
  357-360 — the exact place and pattern the new synthesis belongs beside);
  `getConnection` (383-390); `updateConnection` (514-535).
- `index.mjs` — `handleGetSettings` (1216-1244); `handlePutSettings` (1271-1337),
  especially the 400 shape at 1295-1300, the log line at 1322-1325 that WILL throw
  if not updated, and the response projection at 1332-1336; `routeSettingsRequest`
  (1349-1354); the `/auth/me` handler that shares `toPublicJson`.
- `backend/scan.mjs` — read-only for this ticket. `SCAN_STATUS.NOT_CONFIGURED`
  (131-132), the `toDomainList(connection?.searchDomains)` gate at 337-341, and the
  `extractOne` call at 411-419. TASK-056 owns changing these.
- `backend/anthropic.mjs` — read-only for this ticket. `toDomainList` (425-442) is
  the shape-normaliser whose `undefined -> []` behaviour is what makes the scan
  degrade safely rather than crash.

Frontend (`src/lambda/calendar/frontend/`) — NOT changed by this ticket, listed so
the coder can see what will break in the intermediate state and TASK-057 can pick
it up: `settings.js` `FIELD_ERROR_IDS` (77-88), `fieldErrorId` (99-102),
`buildSettingsPayload` (182-188), `renderSummary` (291-303); `app.js`
`connectionView`'s `needsSchool` gate and the identity card / calendar header that
read `me.schoolNames`.

Infrastructure:
- `terraform/dynamodb_calendar_connections.tf` — schema COMMENT block only; the
  table is schemaless beyond the `userId` hash key, so no resource change.

Tests to update (they assert the old `schoolNames`/`searchDomains` request and
response shape and will go red):
- `tests/unit/calendar-settings.test.js`
- `tests/unit/task-053-school-names.test.js`
- `tests/unit/calendar-settings-public-mail.test.js`
- `tests/e2e/calendar-settings-routes.test.js`
- `tests/e2e/calendar-settings-public-mail-routes.test.js`
- `tests/e2e/task-053-multiple-school-names.test.js`
- `tests/unit/calendar-auth.test.js`, `tests/unit/calendar-scan.test.js`,
  `tests/e2e/calendar-scan-orchestration.test.js`,
  `tests/e2e/calendar-frontend-flow.test.js`,
  `tests/e2e/calendar-frontend-timezone.test.js`

New tests should follow the existing per-ticket naming convention:
`tests/unit/task-055-processing-jobs.test.js` and
`tests/e2e/task-055-processing-jobs-settings.test.js`.

Prior art: `tasks/done/TASK-053-multi-school-names.md` is the migrate-on-read +
clear-on-write precedent (its "Edge and Failure Cases" section lists the DynamoDB
traps this ticket inherits). This is the FIRST ticket to store a nested `L` of `M`
on this table — every prior settings attribute was a scalar or a string set.
