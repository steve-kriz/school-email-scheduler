---
id: TASK-060
title: Simplify the processing job settings UI to comma-separated domain and search-term fields
status: todo
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T10:00:00Z
---

## Description
Depends on TASK-059's `domains: string[]` field (replacing the single
`domain: string`). Change the settings page's per-job editor so that BOTH the
domain field and the search-terms field are entered as ONE comma-separated
text input each, instead of today's UI: domain is already one text input (no
change needed there beyond re-reading/re-writing it as a list), but search
terms currently use a per-term row editor (`Add search term` / `Remove term`
buttons, one input per term) built by TASK-057 - that row editor is REMOVED
and replaced with a single comma-separated text input, matching how domain
now works.

Files: `src/lambda/calendar/frontend/settings.js` (the job-row renderer, the
read/write helpers, `JOB_ERROR_FIELDS`/`fieldErrorId`), `settings.html` (only
if a label/hint needs to change - the field markup itself stays a single
`.field` per TASK-057's existing `jobField` builder), `styles.css` (remove the
now-unused `.job__terms`/`.job__term` rules if nothing else references them).

## Additional Context
(Fixed design decisions this ticket must follow.)

**Both fields become a single comma-separated text input, using the SAME
`jobField` builder already used for `name`/`schoolName`/`domain`
(`settings.js:394-417`)** - do not build a new input type. `termsBlock`
(`settings.js:438-485`), the per-term `rowButton` calls, `onAddTerm`/
`onRemoveTerm` handlers, and the term-specific `data-term-index` wiring are
REMOVED entirely, not kept alongside the new field.

**Parsing rule, shared by both fields:** split on commas, trim each piece,
drop empty pieces, and do NOT de-duplicate client-side (the server already
collapses duplicate domains and rejects nothing for a duplicate search term -
let it own that). A trailing comma, doubled commas, or leading/trailing
whitespace around a comma are all just "an empty piece to drop", not an
error. This is a simple, generic `splitCommaList(text)` / `joinCommaList(list)`
pair - write it once and use it for both fields, so they cannot drift.

**Rendering:** a job's `domains` array renders into the domain input's
`.value` as `domains.join(", ")`; its `searchTerms` array renders the same
way into the search-terms input. Reading the form back (`readForm`/
`buildJobsPayload`, `settings.js` ~707-748) parses each input's current text
with the shared splitter into an array before sending.

**A search term may legitimately contain a comma today is no longer true once
this ships** - TASK-056's existing rule ("a search term may legitimately
contain a comma, so never comma-split it") is being DELIBERATELY REVERSED by
this ticket, per the user's explicit request. Update the code comments/
docblocks that state the old rule (in `settings.mjs`'s `validateSearchTerms`
docblock and `settings.js`'s own comments) so they no longer contradict the
new behaviour - a stale comment claiming commas are safe inside a term would
mislead the next person to touch this code.

**Error routing:** `JOB_ERROR_FIELDS` (`settings.js:110`) and `fieldErrorId`'s
indexed-field parser need `domain` renamed to `domains` (matching TASK-059's
backend field rename) so a server 400 on `processingJobs[2].domains` still
resolves to that job's error slot. Decide (and document) whether the DOM
element ids stay `job-<i>-domain`/`error-job-<i>-domain` (cosmetic, no
functional difference since there is still exactly one input) or are also
renamed to `-domains` for consistency - either is acceptable, pick one.

**Client-side validation (`validateProcessingJobsClient`,
`settings.js` ~236-290):** re-confirm against TASK-059's finished decision on
whether `domains` is required. If TASK-059 kept it required, the client
pre-flight's existing "domain is required" check (~276-278) needs to parse
the comma-separated text and check the resulting list is non-empty, not just
check the raw string is non-blank. If TASK-059 made it optional, remove that
required-check for domains entirely (mirroring however TASK-059 treats an
absent/empty `domains` array as valid).

**Field hint text** in `settings.html`/`jobField`'s label should tell the user
commas separate multiple values (e.g. "Email domain(s), comma separated") -
check the existing hint copy for the domain field and the (removed) search
terms heading ("Extra search terms") and write hint text consistent with the
rest of this page's voice.

## Acceptance Criteria

### A. The shared split/join helper pair

- [ ] A1. `settings.js` defines and exports exactly ONE parser pair,
      `splitCommaList(text)` and `joinCommaList(list)`, and BOTH the domains
      field and the search-terms field go through it. No second, field-specific
      splitting or joining expression exists anywhere in the file (no inline
      `.split(",")` and no inline `.join(", ")` on a job field).
- [ ] A2. `splitCommaList` treats `,` (U+002C) as the ONLY delimiter. Whitespace,
      semicolons and any other character are NOT delimiters: `"a.edu.au b.edu.au"`
      parses to the single entry `["a.edu.au b.edu.au"]`.
- [ ] A3. `splitCommaList` returns each piece trimmed of leading/trailing
      whitespace, with empty pieces dropped, in the order typed, with NO
      de-duplication, NO case-folding, and NO cap on how many entries come back.
- [ ] A4. `splitCommaList` tolerance, all of which return a clean list rather than
      an error: a trailing comma (`"a, b,"` -> `["a","b"]`), a leading comma
      (`",a"` -> `["a"]`), doubled or tripled commas (`"a,,b"` / `"a, , ,b"` ->
      `["a","b"]`), and whitespace either side of a comma (`"  a  ,  b  "` ->
      `["a","b"]`).
- [ ] A5. `splitCommaList` returns `[]` for `""`, for whitespace only, for a value
      that is only commas and whitespace (`" , , "`), and for any non-string input
      (`null`, `undefined`, a number, an array, an object). It never throws.
- [ ] A6. `joinCommaList(list)` joins with the two-character separator `", "`,
      skipping entries that are not strings and entries that are blank after
      trimming, so a stored `["a", "", "b"]` renders as `"a, b"` and never as
      `"a, , b"`. A non-array input and an empty array both return `""`. It never
      throws.
- [ ] A7. Round trip: for any list of non-blank, comma-free, already-trimmed
      strings, `splitCommaList(joinCommaList(list))` deep-equals `list`.
- [ ] A8. Both helpers are pure - they touch no DOM and read no module state - and
      are unit-testable by direct import from `settings.js`.

### B. The per-term row editor is removed

- [ ] B1. `termsBlock` (`settings.js:438-485`) is deleted outright. No `<ul>`,
      `<li>`, `.job__terms` or `.job__term` node is built anywhere in
      `settings.js`, and no `job-<i>-terms` or `job-<i>-terms-label` element id is
      produced.
- [ ] B2. The controller functions `addTerm` and `removeTerm`
      (`settings.js:787-807`) are deleted, are no longer passed into `renderJobs`'
      handler object (`settings.js:756-757`), and are no longer returned from
      `createSettingsPage` (`settings.js:1061-1062`). Calling
      `page.addTerm` / `page.removeTerm` is `undefined`.
- [ ] B3. `renderProcessingJobs`' handler contract no longer mentions `onAddTerm`
      or `onRemoveTerm`, and the `@param` docblock listing them
      (`settings.js:574`) is updated to the real remaining set
      (`onRemoveJob`, `onConfirmRemoveJob`, `onCancelRemoveJob`, `confirmingKey`).
- [ ] B4. `rowButton` (`settings.js:419-429`) drops its now-unused fifth parameter
      and the `data-term-index` line: its signature becomes
      `rowButton(doc, id, text, index)`, matching all four surviving call sites
      (`confirm-remove-job-<i>`, `cancel-remove-job-<i>`, `remove-job-<i>`), and
      its docblock no longer says "and optionally its term".
- [ ] B5. No element rendered by this page carries a `data-term-index` attribute,
      and no `add-term-<i>` or `remove-job-<i>-term-<j>` button id is produced.
- [ ] B6. The remove-job arm/confirm/cancel flow, its `confirmingKey` bookkeeping
      and the "one row armed at a time" rule are UNCHANGED by this ticket. The
      only behaviour lost with the term rows is the term-level add/remove itself.

### C. The domains field reads and renders through the list helpers

- [ ] C1. `toEditableJobs` (`settings.js:171-185`) produces `domains` instead of
      `domain`: a stored array maps entry-by-entry with non-strings coerced to
      `""` (exactly the tolerance it already applies to `searchTerms`), and a
      non-array stored value yields `[]`. No `domain` key is produced on an
      editable row.
- [ ] C2. `emptyProcessingJob` (`settings.js:188-190`) returns
      `{ id: "", name: "", schoolName: "", domains: [], searchTerms: [] }`.
- [ ] C3. `jobBlock` renders the domains field with the existing `jobField`
      builder, key `domains`, and value `joinCommaList(job.domains)` - so a job
      stored with three domains renders as one input holding `"a, b, c"`.
- [ ] C4. `readJobsFromDom` reads the single domains input's raw text and stores
      `domains: splitCommaList(text)` on the row. When that input is absent from
      the document (a stripped page or a test harness), it falls back to the
      `domains` ARRAY already in state - not to `[]` and not to the result of
      splitting `""`.
- [ ] C5. `buildJobsPayload` sends `domains` as an array of trimmed, non-blank
      strings and emits NO `domain` key at any position in the payload. The
      existing `id` round-trip rule (omit the key entirely for a row added this
      session) is unchanged.
- [ ] C6. A value the user types that is not a valid domain is still SENT, not
      refused locally - rule 2 of the module docblock. `splitCommaList` performs no
      domain-shape check, no public-provider check and no length or count check.

### D. Search terms become one `jobField`-built input

- [ ] D1. The search-terms field is built by the SAME `jobField` helper as
      `name`/`schoolName`/`domains`, with key `searchTerms`, producing input id
      `job-<i>-searchTerms`, `data-job-index="<i>"`, `autocomplete="off"`,
      `type="text"` and the `.field-input` class - no bespoke builder and no new
      input type.
- [ ] D2. Its error slot is the one `jobField` already creates as `error-${id}`,
      i.e. `error-job-<i>-searchTerms` - the same id `termsBlock` built by hand
      today, so an existing server 400 on `processingJobs[<i>].searchTerms` keeps
      landing in the right place.
- [ ] D3. The input's value is `joinCommaList(job.searchTerms)`, so a job stored
      with `["canteen","uniform shop"]` renders as `"canteen, uniform shop"`.
- [ ] D4. `readJobsFromDom` sets `searchTerms: splitCommaList(text)` from that one
      input, with the same missing-element fallback to the array in state as C4.
      The per-term `job-<i>-term-<j>` reads (`settings.js:741-743`) are gone.
- [ ] D5. `buildJobsPayload` still sends `searchTerms` as an array of trimmed,
      non-blank strings. Its existing blank-dropping filter is kept as a
      belt-and-braces even though `splitCommaList` already drops blanks.
- [ ] D6. The accessible label follows `jobField`'s existing pattern
      (`"<labelText> for <describedAs>"`), so the field is announced against its
      own job rather than as one of many identical fields.

### E. Element ids and error routing

- [ ] E1. `JOB_ERROR_FIELDS` (`settings.js:110`) becomes
      `["name", "schoolName", "domains", "searchTerms"]`. The old `domain` is
      REMOVED and deliberately NOT kept as an alias, matching the existing
      fail-closed stance documented for `schoolName`/`schoolNames`/`searchDomains`.
- [ ] E2. DECISION (made here, do not re-open): the DOM element ids ALSO rename, to
      `job-<i>-domains` and `error-job-<i>-domains`. Reason: `fieldErrorId` builds
      `error-job-${index}-${key}` by concatenating the server's own key, so keeping
      a `-domain` element id while the server names `domains` would need a new
      key-to-id mapping layer and would break the documented invariant that element
      ids line up 1:1 with the server's indexed field names. This must be recorded
      in the code comment at `settings.js:351-368`, whose `job-2-domain` example is
      updated to `job-2-domains`.
- [ ] E3. `fieldErrorId("processingJobs[2].domains")` returns
      `"error-job-2-domains"`, and `fieldErrorId("processingJobs[2].searchTerms")`
      returns `"error-job-2-searchTerms"`.
- [ ] E4. `fieldErrorId("processingJobs[2].domain")` (the OLD singular key) returns
      `FORM_ERROR_ID` - it is no longer in the allowlist, so it fails closed to the
      form-level line rather than pointing at an element that does not exist.
- [ ] E5. The `INDEXED_JOB_FIELD` regex is UNCHANGED, and its existing guarantees
      still hold: `processingJobs[-1].domains` and `processingJobs[abc].domains`
      match nothing and resolve to `FORM_ERROR_ID`.
- [ ] E6. `FIELD_ERROR_IDS`, `FORM_ERROR_ID`, `showFieldError`'s
      missing-element-falls-back-to-the-form-line behaviour, and `clearErrors`'
      `.field-error` sweep of the `#processing-jobs` container all keep working
      unchanged against the renamed slots.

### F. Client-side pre-flight validation

- [ ] F1. `validateProcessingJobsClient` reads the ALREADY-PARSED array off the row
      (`readJobsFromDom` has split the text before this runs). It must NOT re-split
      a string and must NOT read a raw input value itself.
- [ ] F2. Its check order is unchanged and still mirrors the server's:
      name -> duplicate name -> schoolName -> domains (see F4 for what "the
      domains check" now is). The first problem found, walking jobs top to bottom,
      is the one reported.
- [ ] F3. It still performs NO domain-shape, public-provider, length, job-cap or
      search-term-cap check, and still never refuses a value the server would have
      accepted (rule 2 of the module docblock). `searchTerms` gets no client-side
      check at all.
- [ ] F4. RESOLVED (the flip point is decided): TASK-059 made `domains` OPTIONAL
      per job (a job with no domains but a usable `schoolName` is valid and still
      searchable). Client-side validation therefore adds NO required-domains
      check at all - an empty or missing `domains` list is not a validation
      problem, exactly like an empty `searchTerms` list already is not one. Do
      not add a "domains is required" branch to `validateProcessingJobsClient`.
- [ ] F5. The duplicate-job-name check and its message are untouched by this
      ticket.

### G. Stale comments corrected (comment-only, no behaviour change)

- [ ] G1. `settings.js`'s module docblock: the file header (line 4, "a named
      school + domain + search terms") and rule 2's "a REQUIRED
      name/schoolName/domain" (line 31) name `domains` and drop the now-false
      "required" framing for it - only `name` and `schoolName` are required per
      job - and rule 2 no longer describes a search-term row editor.
- [ ] G2. `settings.js`'s `buildJobsPayload` docblock (lines 202-205) no longer
      justifies dropping blank terms as "what an 'Add search term' the user changed
      their mind about looks like" - that control no longer exists. Replace it with
      the comma-splitting rationale.
- [ ] G3. `src/lambda/calendar/backend/settings.mjs`, `validateSearchTerms`
      docblock (lines 760-763): the RULE stays (a bare string is still rejected;
      the API contract is still a list, and the client still sends a list), but the
      justification "A search term may legitimately contain a comma ('canteen,
      roster')" is corrected - the settings UI now treats a comma as a delimiter,
      so a term containing one can no longer be entered there. No executable
      change to this file.
- [ ] G4. `src/lambda/calendar/backend/gmail.mjs`, `toSearchTermList` docblock
      (lines 285-294): the same reversed claim ("neither lower-cased nor split on
      commas - 'Year 4, Kindy' is one phrase the user typed") is corrected. No
      executable change to this file. If TASK-059's build already corrected this
      docblock, no further change is needed here.
- [ ] G5. No comment left anywhere in the repo asserts that a comma is safe inside
      a search term entered through the settings UI. Verify with a repo-wide search
      for "comma" before closing the ticket.

### H. CSS cleanup

- [ ] H1. The `.job__terms` (styles.css:668-674) and `.job__term`
      (styles.css:676-679) rules are deleted. Confirmed before removal: the only
      references in the repo are `settings.js`'s `termsBlock` (removed by B1) and
      the TASK-057 test assertions listed in J1 - no other stylesheet, template or
      source file uses either class.
- [ ] H2. The TASK-057 section comment (styles.css:626-642) is updated: "A job is
      one school, one domain and its search terms" becomes wording that matches the
      new shape (one school, its domains and its search terms, each one field).
- [ ] H3. `.jobs`, `.job`, `.job__head`, `.job__actions` and `.job__confirm` are
      untouched, and the single-column / no-`overflow-x` / inherited-touch-target
      properties that section documents still hold for every remaining job control.
- [ ] H4. The new search-terms field needs no new CSS: it carries `.field` and
      `.field-input` like every other field on the page.

### I. Copy in `settings.html` and the field labels

- [ ] I1. The static intro `.field-hint` (settings.html:26-33) is updated to tell
      the user, once, that several domains and several search terms can be entered
      by separating them with commas, and that domains are optional as long as a
      school name is given. Its existing warning that a public mail provider such
      as gmail.com is not accepted is KEPT.
- [ ] I2. The domains field label reads "Email domains (comma separated)" and the
      search-terms field label reads "Search terms (comma separated)". Both are
      passed as `jobField`'s `labelText`, so both flow into the `for`/`id` pairing
      AND the `aria-label` with no extra machinery.
- [ ] I3. The removed "Extra search terms" heading and its
      `job-<i>-terms-label` id are gone with `termsBlock`.
- [ ] I4. No new element id is added to `settings.html`; the per-job field markup
      remains entirely script-built, one `.field` per field, per TASK-057.

### J. Regression and non-scope

- [ ] J1. The tests that assert the removed structures are updated in the same
      change and the whole suite passes:
      `tests/unit/task-057-processing-jobs-ui.test.js` (~587-610, 721-780, 814-823,
      1115-1125), `tests/e2e/task-057-processing-jobs-flow.test.js` (the `termsOf`
      helper at line 175, and ~236, 591-642, 728-734, 930-934), and
      `tests/e2e/calendar-frontend-flow.test.js` (~1333, 1438, 1465, 1518-1522,
      1570-1609) for the `job-0-domain` / `error-job-0-domain` id rename.
- [ ] J2. The no-markup-assignment guard still passes: `settings.js` contains no
      `.innerHTML`, `.outerHTML`, `insertAdjacentHTML`, `document.write` or
      `createContextualFragment` property access. Every value still reaches the DOM
      as an input `value` or a `textContent`, including the comma-joined string
      produced by `joinCommaList`.
- [ ] J3. Re-render normalisation is ACCEPTED and documented in a code comment:
      because `syncJobsFromDom` parses and `renderJobs` re-joins, a structural
      action (add job, remove job, arm/cancel a removal) rewrites an in-progress
      `"a, b,"` as `"a, b"`. This is the tolerance rule of A4 made visible, not a
      bug, and it must not clear or reorder what the user typed beyond dropping
      empty pieces.
- [ ] J4. Lossy-join is ACCEPTED and documented: a legacy stored value that itself
      contains a comma (e.g. a `searchTerms` entry `"canteen, roster"` saved before
      this ticket) renders as one field and will split into two entries on the next
      save. This is the direct, intended consequence of reversing TASK-056's rule.
- [ ] J5. Out of scope and unchanged: `app.js` (verified - `processingJobEntries`
      never reads `domain`), TASK-058's calendar job filter (filters by job `id`),
      the schedule half of the settings form, the Disconnect Gmail control, and all
      server-side validation rules.

## Cucumber Tests
```gherkin
Feature: Comma-separated domains and search terms in the processing job editor
  As a parent setting up a processing job
  I want to type several domains and several search terms as one comma-separated
  field each
  So that I do not have to add and remove one row per search term

  Background:
    Given I am signed in with Gmail connected
    And I am on the settings page
    And the settings body is visible

  # --- A: the shared helper pair -------------------------------------------

  Scenario: Entering multiple comma-separated domains and search terms and saving
    Given I have added a processing job
    When I type "Ashfield" into the name field of job 0
    And I type "Ashfield Public School" into the school name field of job 0
    And I type "ashfield-p.schools.nsw.edu.au, ashfieldpandc.org.au" into the email domains field of job 0
    And I type "canteen, uniform shop, working bee" into the search terms field of job 0
    And I press Save settings
    Then the request body's processingJobs[0].domains is exactly ["ashfield-p.schools.nsw.edu.au", "ashfieldpandc.org.au"]
    And the request body's processingJobs[0].searchTerms is exactly ["canteen", "uniform shop", "working bee"]
    And the request body carries no "domain" key on any job
    And the status line reads "Saved."

  Scenario Outline: Sloppy comma and whitespace input is tolerated, not rejected
    Given I have added a processing job
    And job 0 has the name "Ashfield" and the school name "Ashfield Public School"
    When I type "<typed>" into the email domains field of job 0
    And I press Save settings
    Then the request body's processingJobs[0].domains is exactly <parsed>
    And no field error is shown for job 0

    Examples:
      | typed                | parsed             |
      | a.edu.au, b.edu.au,  | ["a.edu.au","b.edu.au"] |
      | a.edu.au,,b.edu.au   | ["a.edu.au","b.edu.au"] |
      | ,a.edu.au            | ["a.edu.au"]       |
      |   a.edu.au  ,  b.edu.au   | ["a.edu.au","b.edu.au"] |
      | a.edu.au, , ,b.edu.au | ["a.edu.au","b.edu.au"] |

  Scenario: Duplicates are not collapsed on the client
    Given I have added a valid processing job
    When I type "a.edu.au, a.edu.au" into the email domains field of job 0
    And I press Save settings
    Then the request body's processingJobs[0].domains is exactly ["a.edu.au", "a.edu.au"]
    And the server is left to collapse the duplicate

  # --- C, D: rendering a stored job ----------------------------------------

  Scenario: An existing job with several domains renders as one comma-joined value
    Given the settings API returns one processing job named "Ashfield"
    And that job has the domains ["ashfield-p.schools.nsw.edu.au", "ashfieldpandc.org.au"]
    And that job has the search terms ["canteen", "uniform shop"]
    When the settings page loads
    Then the email domains field of job 0 holds "ashfield-p.schools.nsw.edu.au, ashfieldpandc.org.au"
    And the search terms field of job 0 holds "canteen, uniform shop"
    And exactly one search terms input is rendered for job 0
    And no element on the page has the class "job__term"
    And no "Add search term" button is on the page

  Scenario: A stored job with no domains renders an empty field rather than failing
    Given the settings API returns one processing job named "Ashfield" with no domains attribute
    When the settings page loads
    Then the email domains field of job 0 holds ""
    And the job row is still rendered with its name and school name fields

  Scenario: A stored value that is not a list is tolerated
    Given the settings API returns one processing job whose domains attribute is the string "a.edu.au"
    When the settings page loads
    Then the email domains field of job 0 holds ""
    And the page renders without throwing

  # --- B: the term row editor is gone --------------------------------------

  Scenario: The per-term row editor no longer exists
    Given the settings API returns one processing job with three search terms
    When the settings page loads
    Then no element on the page carries a "data-term-index" attribute
    And no element has an id matching "job-0-term-0"
    And no element has an id matching "add-term-0"
    And the controller does not expose addTerm
    And the controller does not expose removeTerm

  Scenario: Removing a job still works after the term rows are gone
    Given the settings API returns two processing jobs
    When I press "Remove job" on job 1
    And I press "Confirm remove"
    Then only one job row is rendered
    And nothing has been sent to the server yet

  # --- E: server error routing ---------------------------------------------

  Scenario: A server-side domains validation error routes to the right job's slot
    Given the settings API returns two processing jobs
    When I type "gmail.com" into the email domains field of job 1
    And I press Save settings
    And the server responds 400 with field "processingJobs[1].domains" and error "gmail.com is a public mail provider"
    Then the error slot "error-job-1-domains" is visible
    And it reads "gmail.com is a public mail provider"
    And the error slot "error-job-0-domains" stays hidden
    And the form-level error line stays hidden
    And the status line reads "Nothing was saved - please fix the highlighted field."

  Scenario: A server-side search terms error routes to that job's search terms slot
    Given the settings API returns one processing job
    When I press Save settings
    And the server responds 400 with field "processingJobs[0].searchTerms" and error "Enter at most 20 search terms for one processing job"
    Then the error slot "error-job-0-searchTerms" is visible
    And it reads "Enter at most 20 search terms for one processing job"

  Scenario: The retired singular field name fails closed to the form line
    Given the settings API returns one processing job
    When I press Save settings
    And the server responds 400 with field "processingJobs[0].domain" and error "That domain is not accepted"
    Then no error slot named "error-job-0-domain" is on the page
    And the form-level error line is visible
    And it reads "That domain is not accepted"

  Scenario: A 400 naming a row the user has since removed falls back to the form line
    Given the settings API returns three processing jobs
    When I press Save settings
    And I remove job 2 while the request is in flight
    And the server responds 400 with field "processingJobs[2].domains" and error "That domain is not accepted"
    Then the form-level error line is visible
    And it reads "That domain is not accepted"

  Scenario: A hostile field name is never interpolated into an element lookup
    Given the settings API returns one processing job
    When I press Save settings
    And the server responds 400 with field "processingJobs[abc].domains" and error "Nope"
    Then the form-level error line is visible
    And it reads "Nope"

  # --- F4: domains is optional - saving with none is not a client error ----

  Scenario: Saving a job with no domains at all succeeds client-side
    Given I have added a processing job
    And job 0 has the name "Ashfield" and the school name "Ashfield Public School"
    When I leave the email domains field of job 0 empty
    And I press Save settings
    Then a request IS sent to the settings API
    And the request body's processingJobs[0].domains is exactly []
    And no error slot for job 0 is shown before the response arrives

  Scenario: A domains field holding only commas and spaces is sent as an empty list
    Given I have added a processing job
    And job 0 has the name "Ashfield" and the school name "Ashfield Public School"
    When I type " , , " into the email domains field of job 0
    And I press Save settings
    Then a request IS sent to the settings API
    And the request body's processingJobs[0].domains is exactly []

  Scenario: A missing school name is still reported, independent of domains
    Given I have added a processing job
    And job 0 has the name "Ashfield" and an empty school name
    When I leave the email domains field of job 0 empty
    And I press Save settings
    Then the error slot "error-job-0-schoolName" is visible
    And no request is sent to the settings API

  # --- F3: the client never over-refuses -----------------------------------

  Scenario: An invalid-looking domain is still sent for the server to judge
    Given I have added a valid processing job
    When I type "not a domain at all" into the email domains field of job 0
    And I press Save settings
    Then a request IS sent to the settings API
    And the request body's processingJobs[0].domains is exactly ["not a domain at all"]

  Scenario: Whitespace is not a delimiter
    Given I have added a valid processing job
    When I type "a.edu.au b.edu.au" into the email domains field of job 0
    And I press Save settings
    Then the request body's processingJobs[0].domains is exactly ["a.edu.au b.edu.au"]

  Scenario: Twenty-one search terms are sent, not refused locally
    Given I have added a valid processing job
    When I type 21 comma-separated search terms into the search terms field of job 0
    And I press Save settings
    Then a request IS sent to the settings API
    And the request body's processingJobs[0].searchTerms has 21 entries

  # --- J3: re-render normalisation -----------------------------------------

  Scenario: Adding another job normalises the in-progress text without losing it
    Given I have added a processing job
    When I type "a.edu.au, b.edu.au," into the email domains field of job 0
    And I press "Add processing job"
    Then the email domains field of job 0 holds "a.edu.au, b.edu.au"
    And a second, empty job row is rendered
    And the caret is in the name field of job 1

  Scenario: Unsaved typing in both fields survives a structural change
    Given the settings API returns two processing jobs
    When I type "x.edu.au, y.edu.au" into the email domains field of job 0
    And I type "fete, disco" into the search terms field of job 0
    And I press "Remove job" on job 1 and then "Cancel"
    Then the email domains field of job 0 still holds "x.edu.au, y.edu.au"
    And the search terms field of job 0 still holds "fete, disco"

  # --- Safety ---------------------------------------------------------------

  Scenario: A hostile stored value reaches the field as literal characters
    Given the settings API returns one processing job
    And that job has the search terms ["<img src=x onerror=alert(1)>", "canteen"]
    When the settings page loads
    Then the search terms field of job 0 holds "<img src=x onerror=alert(1)>, canteen"
    And no img element exists inside the processing jobs container
    And settings.js contains no innerHTML property access
```
