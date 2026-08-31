---
id: TASK-057
title: Settings UI to add, edit, remove and name multiple processing jobs
status: done
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T12:35:00Z
question: NON-BLOCKING, defaults taken, ticket is buildable as written. (1) PUT contract for a job with no id yet - TASK-055 fixes id as server-generated but does not itself state whether the PUT accepts an entry with the key absent, null, or a client temp id. DEFAULT TAKEN - the client omits the key entirely for a new job and round-trips the server's id for an existing one; if TASK-055 lands a different contract, only buildSettingsPayload changes. (2) Is an empty processingJobs: [] a valid save? TASK-053 rejected an empty schoolNames; TASK-055 does not say. DEFAULT TAKEN - the client sends [] without objecting and displays whatever the server answers, so the rule stays in one place (TASK-055). (3) Ownership of the app.js needsSchool/identity-card fix - TASK-055 removes schoolNames from the projection, which breaks connectionView's needsSchool gate and identityCard on both pages, and no ticket currently claims fixing them. DEFAULT TAKEN - the minimal fix (processingJobList normaliser, needsSchool from processingJobs.length, identityCard/header rendering job names) is scoped into this ticket, fenced away from TASK-058's render/filter surface. (4) settings.js's module docblock rule 2 currently states validation is the server's job and this page does not second-guess it; this ticket's Additional Context asks for a client-side pre-flight. Reconciled by limiting the client check to required-fields + name-uniqueness only (never domain-shape/length/count caps) and requiring the docblock be amended to say so - confirm that reading is correct.
---

## Description
Depends on TASK-055's `processingJobs` settings shape (`{ id, name, schoolName,
domain, searchTerms }`). Replace the single school-name(s)/search-domains form
TASK-053 added to the settings page with a list-editor UI: the user can add a
new processing job, edit an existing one's name/schoolName/domain/searchTerms,
remove one, and see each job clearly labelled by its name.

Files: `src/lambda/calendar/frontend/settings.html`, `settings.js`, and
`styles.css` for any new list/row styling needed. Read `settings.js` and
`settings.html` in full first - TASK-053 already built a form-to-payload
builder and a save/error-display flow for the old shape that this replaces
rather than duplicates.

## Additional Context
- Each job needs its own small form/row: a name field, a school name field, a
  domain field, and a repeatable search-terms input (add/remove a term the
  same interaction pattern as adding/removing a job itself - do not build two
  different list-editing patterns in one page).
- "Add processing job" appends a new, empty, editable job to the list -
  giving it a client-side temporary id is fine (TASK-055's backend assigns
  the real server-side `id` on first save; follow whatever contract TASK-055's
  finished API actually expects for a job with no id yet - read that ticket's
  finished implementation, don't guess ahead of it).
- "Remove" deletes a job from the list (with the existing settings page's
  established confirmation/undo pattern, if any - check how TASK-053's
  disconnect flow or any other destructive action on this page currently
  confirms, and stay consistent rather than inventing a new confirmation UI).
- Client-side validation should mirror TASK-055's server validation closely
  enough that a bad save attempt is caught before the round trip where
  practical (required name/schoolName/domain, name uniqueness among the
  user's own jobs), but the server validation error is still the source of
  truth - display whatever `SettingsValidationError` the API returns exactly
  as TASK-053's error-display pattern already does for the old fields.
- Mobile-friendliness matters here the same way it did for TASK-054 - this
  page gets used from a phone. A per-job editor block should not require
  horizontal scrolling on a narrow viewport.

## Decisions settled by reading the code (do not re-litigate)

Everything below was verified by reading the shipped files, not assumed.

1. **The current form is a flat, static, two-textarea form.** `settings.html:23-94`
   is a single `<form id="settings-form" class="panel settings-panel" novalidate>`
   containing `<textarea id="school-names-input">` (26-34) and
   `<textarea id="search-domains-input">` (36-45), each with a `.field-hint` and a
   `.field-error` slot (`#error-schoolNames`, `#error-searchDomains`). The schedule
   controls (47-88), the form-level error line `#error-form` (90), the status line
   `#settings-status` (91) and `#save-settings` (93) follow. **Only the two
   textareas and their two error slots are replaced by this ticket.** The schedule
   half of the form, `#error-form`, `#settings-status` and `#save-settings` are
   untouched.

2. **`settings.js` builds no markup today.** Its only DOM mutation is `textContent`,
   input `.value`, `.hidden` and one `node.className` (`settings.js:286`). This
   ticket introduces the **first** element construction in this file. Rule 3 of the
   module docblock (`settings.js:32-36`) - "NO MARKUP ASSIGNMENT, ANYWHERE ... A repo
   test reads this source and fails if that ever stops being true" - still binds:
   every node must be built with `document.createElement` / the imported
   `el(doc, tag, className, text)` helper (`app.js:114`) and filled via `textContent`
   or an input's `value`. No `innerHTML`, no `insertAdjacentHTML`, no template
   string of markup.

3. **The established save/error-display flow is `save()` at `settings.js:401-455`**,
   and it is reused, not rewritten: `clearErrors()` (252-262) blanks every known
   error slot; `setStatus("Saving...", false)` (281-288); `api.put(SETTINGS_ENDPOINT,
   payload)`; a `400` is routed through `showFieldError(result.data.field,
   result.data.error)` (271-279) which resolves the element id through
   `fieldErrorId()` (99-102) against the frozen `FIELD_ERROR_IDS` allowlist (77-88)
   and **fails closed to `FORM_ERROR_ID`** for any unrecognised field; then
   `setStatus("Nothing was saved - please fix the highlighted field.", true)`. The
   schedule sync (`syncSchedule`, 388-393) runs only after the settings PUT
   succeeded and reports separately. This ticket changes **what** is validated and
   which slots exist - never this control flow.

4. **The one destructive-action confirmation pattern on this page is
   `initDisconnectControl` (`settings.js:613-704`).** Its three structural rules are
   what "stay consistent rather than inventing a new confirmation UI" means here:
   (a) the button that performs the destructive step ships `disabled`/inactive in
   markup and is only armed by `refresh()`; (b) the gate is **re-checked at action
   time** and not trusted from the `disabled` attribute (`settings.js:655-658`);
   (c) changing the target **invalidates a pending confirmation** (`onChoiceChange`,
   639-645). It is a typed-phrase gate (`requiredConfirmation` / `isConfirmed`,
   537-558) because disconnecting is **irreversible at Google**.
   **DECISION:** removing a job is **not** irreversible - nothing is written until
   the user presses Save, so a reload or Cancel restores it. A typed phrase per row,
   across up to 20 rows, would be disproportionate and would make the page unusable
   on a phone. Job removal therefore reuses rules (a), (b) and (c) as a **two-step,
   in-row arm-then-confirm**: `Remove` puts that one row into a confirming state
   showing `Confirm remove` and `Cancel`; nothing is spliced out of the list until
   `Confirm remove` is activated. `requiredConfirmation` / `isConfirmed` /
   `CONFIRM_PHRASE_*` and the whole disconnect section are **not modified**.

5. **`fieldErrorId` cannot resolve TASK-055's indexed field names as written.**
   `FIELD_ERROR_IDS` is an `Object.freeze`d static table looked up with
   `hasOwnProperty` (`settings.js:99-102`), so a server field of
   `processingJobs[2].name` falls through to `#error-form` and the per-field
   targeting is lost. `fieldErrorId` gains a **narrow, allowlisted** parse of that
   one indexed form (see AC), keeping the fail-closed property intact. The
   `schoolNames` and `searchDomains` keys are **removed** from `FIELD_ERROR_IDS`,
   exactly as TASK-053 removed `schoolName` and for the same stated reason
   (`settings.js:72-75`): there is no element with those ids any more, so keeping
   them would aim an error at nothing.

6. **Rule 2 of the module docblock is deliberately amended by this ticket.**
   `settings.js:23-30` currently states "VALIDATION IS THE SERVER'S JOB AND THIS
   PAGE DOES NOT SECOND-GUESS IT". The Additional Context above asks for a
   client-side pre-flight. These are reconciled, not ignored: the client checks
   **only** the two rule families named in the ticket (required
   name/schoolName/domain, and case-insensitive name uniqueness), never
   domain-shape, length or count caps - so the page can never refuse a value the
   server would have accepted. The docblock must be **updated in the same commit**
   to say exactly that, rather than left contradicting the code.

7. **The list is fully re-rendered on every structural change, and element ids are
   index-based.** This makes the DOM ids line up 1:1 with TASK-055's
   `processingJobs[<index>].<field>` error field names, which is the whole reason to
   prefer indexes over the client temp id for *element ids*. It also means a
   re-render must never be triggered on keystroke (see Edge Cases: focus loss).

8. **New jobs send no `id`.** TASK-055 specifies `id` as "stable, server-generated
   (`crypto.randomUUID()`)". The client keeps a temp id **only** as in-memory
   bookkeeping for the confirming-row state; it is never sent. An existing job's
   server `id` is round-tripped unchanged so a rename cannot orphan TASK-056's event
   attribution. **See the clarifying question on the PUT contract for id-less jobs.**

9. **`app.js` must change, minimally, or the settings page visibly breaks.**
   `settings.js` imports `renderConnectionCards` and `schoolNameList` from `app.js`
   (`settings.js:39-47`) and calls `renderConnectionCards` on load and after every
   save (`settings.js:372, 430`). `connectionView` (`app.js:626-640`) sets
   `needsSchool` from `me.schoolNames`; TASK-055 removes that key from the
   projection, so `needsSchool` would be permanently true and the "Tell us your
   school" card (`schoolCard`, `app.js:680-692`) would show forever, on both pages.
   The **minimal** fix is in scope here and fenced to it. Calendar/attention
   filtering stays TASK-058's.

10. **No sixth frontend file.** The route table, the five-file allowlist and the
    read-count assertions in `tests/e2e/calendar-frontend-flow.test.js` (~347-438)
    hard-code five files under `frontend/`. All new CSS goes in `styles.css`, all new
    markup in `settings.html`, all new script in `settings.js`.

11. **There is no CSS engine and no layout in the test harness.**
    `tests/helpers/fake-dom.mjs` is a hand-rolled DOM with no `getComputedStyle`, no
    geometry and no `matchMedia`. Every CSS criterion below is verified by reading
    `styles.css` as **text**, via the existing `tests/helpers/css-text.mjs` helper
    TASK-054 added for exactly this.

## Acceptance Criteria

### Markup: the processing-jobs section (`frontend/settings.html`)
- [ ] `<textarea id="school-names-input">` and its `.field-hint` and
      `<p id="error-schoolNames">` (`settings.html:26-34`) are removed.
- [ ] `<textarea id="search-domains-input">` and its `.field-hint` and
      `<p id="error-searchDomains">` (`settings.html:36-45`) are removed.
- [ ] The `<h2>Your school</h2>` heading (`settings.html:24`) is replaced by a
      heading naming the new concept (e.g. `<h2>Your processing jobs</h2>`), still
      inside `<form id="settings-form">`.
- [ ] A static, initially-empty container `<div id="processing-jobs" class="jobs">`
      is added in their place. It is the **only** node whose children `settings.js`
      creates; every other element on the page stays static markup.
- [ ] A static `<p id="processing-jobs-empty" class="field-hint" hidden>` explains, in
      words, that no processing job is configured yet and that mail will not be
      scanned until one is added. Its `hidden` is driven by `settings.js`.
- [ ] A static `<p id="error-processingJobs" class="field-error" role="alert" hidden>`
      is added as the list-level error slot, matching the shape of the removed
      `#error-schoolNames` exactly (`settings.html:33`).
- [ ] A static `<button id="add-processing-job" type="button" class="btn">` labelled
      "Add processing job" is added after the container. `type="button"` is
      load-bearing: it sits inside `<form id="settings-form">`, and a default
      `type="submit"` would trigger a save on every add.
- [ ] A static `.field-hint` paragraph explains what a processing job is (one
      school + one domain + optional extra search terms, searched and attributed
      independently).
- [ ] `#error-form` (90), `#settings-status` (91), `#save-settings` (93), the whole
      "Automatic scanning" block (47-88), and the entire `#disconnect-gmail`
      section (114-173) are byte-unchanged. In particular `disabled` still sits
      between `id="disconnect-submit"` and `</button>` on line 169, because
      `tests/unit/calendar-disconnect.test.js` and
      `tests/e2e/calendar-disconnect-flow.test.js` slice the raw HTML on that span.
- [ ] `<body data-page="settings">` (9) is unchanged - it is the bootstrap contract
      at `settings.js:713`.

### Rendering a job row from `processingJobs` (`frontend/settings.js`)
- [ ] A new exported `renderProcessingJobs(doc, container, jobs)` (or an equivalent
      named function exposed on the controller) empties `#processing-jobs` with the
      imported `clear()` helper (`app.js:129`) and appends one block per job, in the
      order the array arrives. Order is never re-sorted client-side.
- [ ] Each job renders as `<section class="job" data-job-index="<i>">` containing, in
      order: a head showing the job's name as **text**, three labelled fields, the
      search-terms sub-list, and the actions row.
- [ ] The three fields are `<input type="text" class="field-input">` with ids
      `job-<i>-name`, `job-<i>-schoolName`, `job-<i>-domain`, each with a
      `<label class="field-label" for="...">` ("Name", "School name", "Email
      domain") and each wrapped in a `.field` div, matching the existing field
      markup at `settings.html:26-34`.
- [ ] Each field is followed by its own error slot
      `<p class="field-error" role="alert" hidden>` with id
      `error-job-<i>-name`, `error-job-<i>-schoolName`, `error-job-<i>-domain`, plus
      one `error-job-<i>-searchTerms` in the terms sub-list.
- [ ] Every stored value reaches the DOM **only** as an input `.value` or via
      `textContent`. A job whose `name` is `<img src=x onerror=alert(1)>` produces
      that literal string in the input value and in the head label, and **no `img`
      element exists anywhere in the document**.
- [ ] A job with a server `id` carries it in a `data-job-id` attribute on its
      `<section>`; a job added this session carries a client temp id instead, marked
      so it is distinguishable (e.g. `data-job-new="true"`). Neither is ever
      rendered as visible text.
- [ ] When `processingJobs` is absent, not an array, or empty, the container renders
      no `.job` blocks and `#processing-jobs-empty` is visible. Otherwise
      `#processing-jobs-empty` is hidden.
- [ ] `fillForm` (`settings.js:327-353`) no longer touches `school-names-input` or
      `search-domains-input`; it calls the job renderer with
      `settings?.processingJobs`. The schedule/timezone half of `fillForm`
      (336-352) is unchanged.
- [ ] `renderSummary` (`settings.js:290-305`) reads `processingJobs` instead of
      `schoolNames`: with jobs it renders `Watching mail for ` followed by the job
      **names** joined with `", "` as **one** `textContent` assignment on the
      existing `<strong id="settings-school-name" class="settings-summary-name">`;
      with none it keeps a "nothing saved yet" sentence. The element id
      `settings-school-name` is retained so
      `tests/e2e/calendar-frontend-flow.test.js` (~1552) is not broken gratuitously.

### The search-terms sub-list (same interaction pattern as the job list)
- [ ] Each job renders `<ul class="job__terms">` (or an equivalent list container)
      with one row per term: `<input type="text" class="field-input"
      id="job-<i>-term-<j>" data-job-index="<i>" data-term-index="<j>">` and a
      `<button type="button" class="btn btn-small" id="remove-job-<i>-term-<j>">`
      labelled "Remove term".
- [ ] Each job renders one `<button type="button" class="btn btn-small"
      id="add-term-<i>">` labelled "Add search term", which appends **one empty term
      input** to that job only and leaves every other job untouched.
- [ ] Removing a term removes exactly that term from that job's `searchTerms` and
      re-renders. Removing a term is **not** confirmed - it is a single field, not a
      whole job, and the disconnect pattern's gate is reserved for removing a job.
- [ ] A job with `searchTerms: []` renders zero term rows plus the "Add search term"
      button, and saves as `searchTerms: []` (never as `[""]`).
- [ ] The add/remove **term** controls and the add/remove **job** controls are the
      same interaction: a button that appends one empty editable row, and a per-row
      Remove button. No second list-editing idiom (no comma-separated textarea, no
      chip/tag widget, no drag handle) appears anywhere on this page.

### Editing, and not losing unsaved work
- [ ] Before **any** re-render caused by add or remove, the current DOM values of
      every job field and every term input are read back into the controller's state,
      so a user who has typed into row 1 and then adds row 2 does not lose what they
      typed.
- [ ] Adding a job appends an empty job (`name`, `schoolName`, `domain` all `""`,
      `searchTerms: []`) to the **end** of the list, re-renders, and moves focus to
      the new job's `#job-<i>-name` input.
- [ ] No re-render is triggered by typing. There is no `input`/`keyup` listener that
      re-renders the list; the state is read out of the DOM on demand.
- [ ] Every listener for the job/term controls is bound **once** (via event
      delegation on `#processing-jobs`, or re-bound only as part of the single
      re-render that just created those nodes). A test that adds and removes a job
      ten times and then activates one control observes exactly **one** state
      change - a stacked-handler bug is explicitly out of tolerance.

### Removing a job (reusing the disconnect control's three gate rules)
- [ ] Each job renders `<button type="button" class="btn btn-small"
      id="remove-job-<i>" data-job-index="<i>">` labelled "Remove job".
- [ ] Activating it does **not** remove anything. It puts that one row into a
      confirming state: the row shows a `.job__confirm` block naming the job
      ("Remove <name>?", the name rendered as `textContent`) with
      `<button type="button" class="btn btn-small" id="confirm-remove-job-<i>">`
      ("Confirm remove") and `<button type="button" class="btn btn-small"
      id="cancel-remove-job-<i>">` ("Cancel"). This mirrors
      `initDisconnectControl`'s rule (a): the acting control does not exist/arm
      until the user has explicitly asked for it.
- [ ] Activating `#confirm-remove-job-<i>` splices exactly that job out of the
      client-side list and re-renders. The handler **re-checks that this row is the
      one currently armed** before acting rather than trusting the button's presence,
      mirroring `settings.js:655-658`. Nothing is sent to the server.
- [ ] Activating `#cancel-remove-job-<i>` returns the row to its normal state and
      removes nothing.
- [ ] **At most one row is ever in the confirming state.** Arming a second row, adding
      a job, removing a term, or a successful save all clear any pending
      confirmation - mirroring `onChoiceChange` (`settings.js:639-645`) invalidating a
      confirmation when the target changes.
- [ ] Removing the last remaining job is allowed; the list renders empty and
      `#processing-jobs-empty` becomes visible. The client does **not** invent a
      "you must keep at least one job" rule.
- [ ] The removal is only persisted when the user presses Save. Reloading the page
      before saving brings the job back. The empty-state hint says so in words, so a
      user cannot mistake the removal for an immediate deletion.
- [ ] `initDisconnectControl`, `requiredConfirmation`, `isConfirmed`,
      `CONFIRM_PHRASE_KEEP`, `CONFIRM_PHRASE_DELETE`, `disconnectRequestBody` and
      `disconnectSummary` are **not modified**.

### Client-side validation (pre-flight only)
- [ ] A new exported pure function `validateProcessingJobsClient(jobs)` returns
      `null` when the list is acceptable, or `{ field, error }` for the **first**
      problem only - shaped exactly like the server's 400 body, so it can be fed
      straight into the existing `showFieldError(field, message)` with no adapter.
- [ ] It reports a missing/blank-after-trim `name` as
      `field: "processingJobs[<i>].name"`, a missing/blank `schoolName` as
      `processingJobs[<i>].schoolName`, and a missing/blank `domain` as
      `processingJobs[<i>].domain`.
- [ ] It reports a duplicate `name` - compared **trimmed and case-insensitively**,
      per TASK-055 - against the **later** of the two jobs, as
      `field: "processingJobs[<i>].name"`, with a message naming the clash.
- [ ] Required checks run before the uniqueness check, so two jobs with blank names
      are reported as "name is required", not as duplicates of each other.
- [ ] Jobs are checked in list order and, within a job, name -> schoolName ->
      domain, so the reported problem is always the topmost one on screen.
- [ ] It does **not** check domain shape/hostname validity, string lengths, the job
      count cap, or the search-term count cap. Those stay server-owned, so this page
      can never refuse a value TASK-055 would have accepted.
- [ ] It tolerates a non-array input and a non-object entry without throwing.
- [ ] The module docblock's rule 2 (`settings.js:23-30`) is rewritten to state the
      reconciled position: the client pre-flights **only** required-field and
      name-uniqueness, the server remains the source of truth, and no client rule may
      be stricter than the server's.

### Save and error display (reusing the existing flow verbatim)
- [ ] `buildSettingsPayload` (`settings.js:182-199`) no longer emits `schoolNames` or
      `searchDomains`. It emits `processingJobs: <array>` built from the form.
- [ ] `processingJobs` is **always** sent, including as `[]`, for the reason already
      documented at `settings.js:170-175`: omitting the key would read to the server
      as "leave what is stored alone", so clearing the list would silently do
      nothing. The `scheduleEnabled` / `scheduleFrequency` / `scheduleHour` /
      `timezone` branches (186-197) are unchanged.
- [ ] Each emitted job is `{ name, schoolName, domain, searchTerms }` with all three
      strings trimmed and every term trimmed and blank terms dropped, plus `id` **only
      when** the job carries a non-empty server-issued id. A client temp id is never
      sent.
- [ ] `readForm` (`settings.js:307-325`) no longer reads `school-names-input` or
      `search-domains-input`; it returns the job list read out of `#processing-jobs`.
      Its schedule/timezone reads are unchanged.
- [ ] `parseSchoolNameList`, `formatSchoolNameList`, `parseDomainList` and
      `formatDomainList` (`settings.js:115-164`) are removed if nothing else uses
      them, and their unit tests are updated accordingly. They are **not** left
      exported-but-dead.
- [ ] `save()` runs `validateProcessingJobsClient` **after** `clearErrors()` and
      `setStatus("Saving...", false)` and **before** `api.put`. On a problem it calls
      `showFieldError(field, message)`, sets the status to the existing
      `"Nothing was saved - please fix the highlighted field."`, makes **no** network
      request, and returns a result object with `ok: false` and the same `field`.
- [ ] `state.saving` is released and `#save-settings` is re-enabled on the
      client-side-rejection path too - the existing `finally` block
      (`settings.js:451-454`) already does this and must keep covering it.
- [ ] `FIELD_ERROR_IDS` (`settings.js:77-88`) drops the `schoolNames` and
      `searchDomains` keys, adds `processingJobs: "error-processingJobs"`, and keeps
      every schedule key unchanged.
- [ ] `fieldErrorId` (`settings.js:99-102`) additionally resolves the exact form
      `processingJobs[<index>].<field>` where `<index>` is one or more digits and
      `<field>` is one of an allowlisted `name`, `schoolName`, `domain`,
      `searchTerms`, to `error-job-<index>-<field>`. Anything else - a malformed
      index, an unlisted sub-field, a negative or non-numeric index - returns
      `FORM_ERROR_ID`. The allowlist stays an allowlist; no id is interpolated from
      an arbitrary server string.
- [ ] `fieldErrorId`'s resolved id is only used if `getElementById` finds it;
      otherwise `showFieldError` falls back to `FORM_ERROR_ID`, so a server naming
      `processingJobs[9].name` when only 3 rows are on screen still shows the user
      why the save was refused instead of silently showing nothing.
- [ ] `clearErrors()` (`settings.js:253-262`) additionally clears every per-row error
      slot currently in the DOM (found by class or by an id prefix), not just the ids
      in the static `FIELD_ERROR_IDS` table - otherwise a stale row error survives the
      next save.
- [ ] On a successful save, `state.settings` is replaced with the response body and
      `fillForm` re-renders the rows from it, so **server-assigned `id`s land on the
      newly created rows** and a subsequent edit-and-save updates rather than
      duplicates them. This is the existing behaviour at `settings.js:429-432` and
      must not be bypassed.
- [ ] The `syncSchedule` call and all four of its outcome branches
      (`settings.js:434-450`) are unchanged.
- [ ] `SETTINGS_ENDPOINT`, `SCHEDULE_ENDPOINT`, `DEFAULT_SCHEDULE_HOUR`,
      `FORM_ERROR_ID`, `detectTimezone`, `buildSchedulePayload`, `createSettingsPage`'s
      option surface and `bootstrapSettings` keep their names and signatures.

### Minimal `app.js` change (fenced; filtering stays TASK-058)
- [ ] A new exported `processingJobList(value)` normaliser returns `[]` for a
      non-array and otherwise the entries that are objects with a non-blank string
      `name`, mirroring how `schoolNameList` (`app.js:602-605`) tolerates the
      first-run shape without throwing.
- [ ] `connectionView` (`app.js:626-640`) sets `needsSchool` from
      `processingJobList(me.processingJobs).length === 0` instead of `me.schoolNames`.
      Its three-independent-flags behaviour and the `connectionStatus` /
      `lastScanStatus` branches are unchanged.
- [ ] `identityCard` (`app.js:695-716`) and the calendar header
      (`app.js:1149-1153`) render the job **names** joined with `", "` as a single
      `textContent` assignment. The element ids `identity-school-name` and the header
      id are retained.
- [ ] `schoolNameList` is removed if nothing else uses it, and its import in
      `settings.js:39-47` is dropped. No dead export is left behind.
- [ ] Nothing in `renderDayCell`, `renderChip`, `renderAttention`,
      `MAX_ATTENTION_ITEMS`, `state.attentionExpanded` or the polling loop is
      touched - TASK-058 owns those.

### Mobile and touch targets (`frontend/styles.css`, consistent with TASK-054)
- [ ] New rules for `.jobs`, `.job`, `.job__head`, `.job__terms`, `.job__term`,
      `.job__actions` and `.job__confirm` are added to the `--- Settings form ---`
      block of `styles.css` (around 510-578), in that stylesheet's existing commented
      voice.
- [ ] `.job` uses the same visual language as `.settings__section`
      (`styles.css:587-592`): surface background, `1px solid var(--line)`, 8px
      radius, padding - so a job reads as a distinct card, not as loose fields.
- [ ] `.job` and `.job__term` lay out as `display: grid` in a **single column** at
      narrow widths, and no rule anywhere sets `overflow-x` on `.jobs`, `.job` or
      any descendant. A horizontally scrolling region inside a vertically scrolling
      page is the trap TASK-054 explicitly refused (`styles.css:627-641`).
- [ ] Every button this ticket adds carries `class="btn"` or `class="btn btn-small"`,
      both of which already declare `min-height: 44px` **outside** any media query
      (`styles.css:159-210`). No new rule reduces a touch target, and no new
      touch-target rule is placed inside a media query.
- [ ] Every new text input carries `class="field-input"`, which is `font: inherit`
      at the 16px body size (`styles.css:36-43, 542-550`). No new rule reduces the
      font-size of an input below 16px - the iOS-zoom-on-focus constraint recorded at
      `styles.css:637-640` still holds.
- [ ] Every new input has a `<label>` with a matching `for`, and the labels are
      distinct per row (e.g. the row's index or name appears in the accessible
      label), so a screen reader does not announce twenty identical "Name" fields.
- [ ] Additions to the existing `@media (max-width: 600px)` block
      (`styles.css:642-684`) - if any - only reduce padding/gaps. The 860px block
      (621-625) is not modified, and no third breakpoint is introduced.
- [ ] `.app-main--narrow` (`styles.css:90-92`) is **not** changed - `minmax(0, 640px)`
      already shrinks to a 360px viewport because the track minimum is 0.
- [ ] `styles.css` stays self-contained: no `@import`, no web font, no `http`/`https`
      URL, so the served-body scans in
      `tests/e2e/calendar-frontend-flow.test.js` (~469-503) keep passing under
      `default-src 'self'`.

### Non-regression
- [ ] No frontend source file contains `innerHTML`, `insertAdjacentHTML` or
      `document.write` - the source scans at `tests/e2e/calendar-frontend-flow.test.js`
      (~490) and `tests/unit/calendar-disconnect.test.js` (~953) still pass with the
      new element-building code in `settings.js`.
- [ ] `GET /calendar/settings.html`, `/calendar/settings.js` and `/calendar/styles.css`
      still return 200 with their existing content types, and exactly five files are
      read under `frontend/` (`tests/e2e/calendar-frontend-flow.test.js` ~267-271,
      347-438).
- [ ] Every disconnect scenario in `tests/unit/calendar-disconnect.test.js` and
      `tests/e2e/calendar-disconnect-flow.test.js` passes unchanged, including the
      raw-HTML slice asserting `#disconnect-submit` ships `disabled`.
- [ ] Every schedule scenario driven through `#settings-form` still passes: the
      schedule payload, the `{ available: false }` branch, the 400-on-schedule branch
      and the DELETE-when-disabled branch.
- [ ] The `school-names-input` / `search-domains-input` / `error-schoolNames`
      assertions in `tests/e2e/calendar-frontend-flow.test.js` (1314, 1416, 1421,
      1441-1443, 1482-1491, 1553) and `tests/unit/task-053-school-names.test.js` are
      **updated**, not deleted wholesale - each one has an equivalent in the new
      shape, and losing the coverage silently is not acceptable.

## Cucumber Tests

```gherkin
Feature: A user manages several named processing jobs from the settings page

  Background:
    Given an authenticated user whose Gmail is connected
    And the settings page has loaded

  Scenario: Stored jobs render one editable block each, in order
    Given the settings response processingJobs is
      | id    | name        | schoolName             | domain              | searchTerms         |
      | job-1 | Ashfield    | Ashfield Public School | ashfield.nsw.edu.au | newsletter, canteen |
      | job-2 | St Mary's   | St Mary's Primary      | stmarys.nsw.edu.au  |                     |
    When the processing jobs are rendered
    Then the element with id "processing-jobs" contains 2 elements with class "job"
    And the first job block appears before the second
    And the value of "job-0-name" is "Ashfield"
    And the value of "job-0-schoolName" is "Ashfield Public School"
    And the value of "job-0-domain" is "ashfield.nsw.edu.au"
    And job 0 shows 2 search term inputs with values "newsletter" and "canteen"
    And job 1 shows 0 search term inputs
    And the element with id "processing-jobs-empty" is hidden
    And the element with id "settings-summary" reads "Watching mail for Ashfield, St Mary's"

  Scenario: A user with no jobs is told so and is not shown an empty row
    Given the settings response processingJobs is []
    When the processing jobs are rendered
    Then the element with id "processing-jobs" contains no elements with class "job"
    And the element with id "processing-jobs-empty" is visible

  Scenario: Adding a new job and saving it
    Given the settings response processingJobs is []
    When the user activates "add-processing-job"
    Then the element with id "processing-jobs" contains 1 element with class "job"
    And the value of "job-0-name" is ""
    And focus is on the element with id "job-0-name"
    When the user types "Ashfield" into "job-0-name"
    And the user types "Ashfield Public School" into "job-0-schoolName"
    And the user types "ashfield.nsw.edu.au" into "job-0-domain"
    And the user activates "add-term-0"
    And the user types "newsletter" into "job-0-term-0"
    And the user submits the settings form
    Then a PUT is sent to the settings endpoint
    And the PUT body processingJobs is
      """
      [{ "name": "Ashfield", "schoolName": "Ashfield Public School",
         "domain": "ashfield.nsw.edu.au", "searchTerms": ["newsletter"] }]
      """
    And the PUT body has no schoolNames key
    And the PUT body has no searchDomains key
    And the first job in the PUT body has no id key
    And the settings status reads "Saved."

  Scenario: A server-assigned id lands on the new row after the save
    Given the user has added and saved one new job
    And the save response processingJobs is [{ id: "srv-9", name: "Ashfield", schoolName: "Ashfield Public School", domain: "ashfield.nsw.edu.au", searchTerms: [] }]
    Then the job block at index 0 has a data-job-id attribute of "srv-9"
    When the user changes "job-0-name" to "Ashfield PS" and saves again
    Then the PUT body processingJobs[0].id is "srv-9"

  Scenario: Editing an existing job preserves its id so attribution survives a rename
    Given the settings response processingJobs is [{ id: "job-1", name: "Ashfield", schoolName: "Ashfield Public School", domain: "ashfield.nsw.edu.au", searchTerms: [] }]
    When the user changes "job-0-name" to "Ashfield Newsletters"
    And the user submits the settings form
    Then the PUT body processingJobs[0].id is "job-1"
    And the PUT body processingJobs[0].name is "Ashfield Newsletters"

  Scenario: Adding a second job does not lose what was typed into the first
    Given the settings response processingJobs is []
    When the user activates "add-processing-job"
    And the user types "Ashfield" into "job-0-name"
    And the user activates "add-processing-job"
    Then the element with id "processing-jobs" contains 2 elements with class "job"
    And the value of "job-0-name" is still "Ashfield"
    And the value of "job-1-name" is ""

  Scenario: Adding and removing search terms uses the same pattern as adding a job
    Given one stored job with searchTerms ["newsletter"]
    When the user activates "add-term-0"
    Then job 0 shows 2 search term inputs
    And the value of "job-0-term-1" is ""
    When the user types "canteen" into "job-0-term-1"
    And the user activates "remove-job-0-term-0"
    Then job 0 shows 1 search term input
    And the value of "job-0-term-0" is "canteen"
    When the user submits the settings form
    Then the PUT body processingJobs[0].searchTerms is ["canteen"]

  Scenario: A blank search term is dropped rather than sent
    Given one stored job with searchTerms []
    When the user activates "add-term-0"
    And the user leaves "job-0-term-0" empty
    And the user fills the job's name, school name and domain
    And the user submits the settings form
    Then the PUT body processingJobs[0].searchTerms is []

  Scenario: Adding a search term to one job leaves the other jobs alone
    Given two stored jobs each with 1 search term
    When the user activates "add-term-1"
    Then job 1 shows 2 search term inputs
    And job 0 still shows 1 search term input

  Scenario: Removing a job asks first, then removes it, then saves the removal
    Given two stored jobs named "Ashfield" and "St Mary's"
    When the user activates "remove-job-0"
    Then the element with id "processing-jobs" still contains 2 elements with class "job"
    And a confirmation naming "Ashfield" is shown inside job block 0
    And the element with id "confirm-remove-job-0" is present
    When the user activates "confirm-remove-job-0"
    Then the element with id "processing-jobs" contains 1 element with class "job"
    And the value of "job-0-name" is "St Mary's"
    And no request has been sent to the settings endpoint
    When the user submits the settings form
    Then the PUT body processingJobs has 1 entry
    And that entry's name is "St Mary's"

  Scenario: Cancelling a removal keeps the job
    Given two stored jobs
    When the user activates "remove-job-0"
    And the user activates "cancel-remove-job-0"
    Then the element with id "processing-jobs" contains 2 elements with class "job"
    And the element with id "confirm-remove-job-0" is not present

  Scenario: Arming a second removal invalidates the first
    Given three stored jobs
    When the user activates "remove-job-0"
    And the user activates "remove-job-2"
    Then the element with id "confirm-remove-job-2" is present
    And the element with id "confirm-remove-job-0" is not present
    When the user activates "confirm-remove-job-2"
    Then 2 job blocks remain
    And the job named in job block 0 is the originally first job

  Scenario: Removing the last job leaves an explicit empty state, not a blank panel
    Given one stored job
    When the user activates "remove-job-0"
    And the user activates "confirm-remove-job-0"
    Then the element with id "processing-jobs" contains no elements with class "job"
    And the element with id "processing-jobs-empty" is visible
    When the user submits the settings form
    Then the PUT body processingJobs is []

  Scenario: A removal is not persisted until the user saves
    Given two stored jobs
    When the user activates "remove-job-0"
    And the user activates "confirm-remove-job-0"
    And the page is reloaded without saving
    Then the element with id "processing-jobs" contains 2 elements with class "job"

  # --- Client-side validation: caught before the round trip ---

  Scenario: A duplicate job name is refused before any request is sent
    Given two jobs both named "Ashfield" with valid school names and domains
    When the user submits the settings form
    Then no request is sent to the settings endpoint
    And the element with id "error-job-1-name" is visible
    And its text mentions the duplicate name
    And the element with id "error-job-0-name" is hidden
    And the settings status reads "Nothing was saved - please fix the highlighted field."
    And the element with id "save-settings" is enabled again

  Scenario: Duplicate names are compared case-insensitively and after trimming
    Given a job named "Ashfield" and a second job named "  ashfield  "
    When the user submits the settings form
    Then no request is sent to the settings endpoint
    And the element with id "error-job-1-name" is visible

  Scenario Outline: A required field left blank is refused before the round trip
    Given one job whose "<field>" is blank and whose other required fields are filled
    When the user submits the settings form
    Then no request is sent to the settings endpoint
    And the element with id "error-job-0-<field>" is visible
    Examples:
      | field      |
      | name       |
      | schoolName |
      | domain     |

  Scenario: Only the first problem is reported, topmost first
    Given job 0 has a blank name and job 1 has a blank domain
    When the user submits the settings form
    Then the element with id "error-job-0-name" is visible
    And the element with id "error-job-1-domain" is hidden

  Scenario: Two blank names are reported as required, not as duplicates
    Given two jobs both with blank names
    When the user submits the settings form
    Then the element with id "error-job-0-name" is visible
    And its text says the name is required
    And its text does not mention a duplicate

  Scenario: The client does not second-guess rules it does not own
    Given one job whose domain is "gmail.com" and whose other fields are valid
    When the user submits the settings form
    Then a PUT is sent to the settings endpoint
    And the client did not block the request itself

  # --- Server-side validation: the server stays the source of truth ---

  Scenario: A server field error lands on the named job's field
    Given one valid-looking job
    And the settings endpoint will respond 400 with field "processingJobs[0].domain" and error "That domain is not accepted."
    When the user submits the settings form
    Then the element with id "error-job-0-domain" is visible
    And its text is "That domain is not accepted."
    And the element with id "error-form" is hidden
    And the element with id "error-processingJobs" is hidden
    And the settings status reads "Nothing was saved - please fix the highlighted field."

  Scenario: A list-level server error lands on the list-level slot
    Given 21 jobs
    And the settings endpoint will respond 400 with field "processingJobs" and error "At most 20 processing jobs."
    When the user submits the settings form
    Then the element with id "error-processingJobs" is visible
    And its text is "At most 20 processing jobs."
    And the element with id "error-form" is hidden

  Scenario Outline: An unresolvable server field name fails closed to the form line
    Given one valid-looking job
    And the settings endpoint will respond 400 with field "<field>"
    When the user submits the settings form
    Then the element with id "error-form" is visible
    Examples:
      | field                        |
      | processingJobs[0].nickname   |
      | processingJobs[abc].name     |
      | processingJobs[-1].name      |
      | processingJobs[9].name       |
      | schoolNames                  |
      | 42                           |

  Scenario: A stale error does not survive the next save
    Given a previous save put an error in "error-job-0-name"
    When the user fixes the name and submits the settings form again
    Then the element with id "error-job-0-name" is hidden
    And the settings status reads "Saved."

  # --- Failure and edge paths ---

  Scenario: A hostile job name is rendered as literal text everywhere
    Given the settings response processingJobs is [{ id: "job-1", name: "<img src=x onerror=alert(1)>", schoolName: "S", domain: "d.edu.au", searchTerms: ["<script>alert(1)</script>"] }]
    When the processing jobs are rendered
    Then the value of "job-0-name" is that literal string
    And the value of "job-0-term-0" is that literal script string
    And the job head element textContent is that literal name string
    And no IMG element exists anywhere in the document
    And no SCRIPT element was created by the renderer

  Scenario: The list renderer survives a malformed settings body
    Given the settings response processingJobs is not an array
    When the processing jobs are rendered
    Then no error is thrown
    And the element with id "processing-jobs" contains no elements with class "job"
    And the element with id "processing-jobs-empty" is visible

  Scenario: A network failure on save changes nothing on screen
    Given two jobs and a settings endpoint that responds 500
    When the user submits the settings form
    Then the element with id "processing-jobs" still contains 2 elements with class "job"
    And the settings status reports that the settings could not be saved
    And the element with id "save-settings" is enabled again

  Scenario: A 401 during save hides the settings body and prompts a reconnect
    Given the settings endpoint will respond 401
    When the user submits the settings form
    Then the element with id "settings-body" is hidden
    And the connect card is rendered

  Scenario: Controls are bound once, not once per render
    Given one stored job
    When the user adds and removes a job 10 times
    And the user activates "add-processing-job" once
    Then exactly 1 new job block is added

  Scenario: Adding a job never submits the form
    Given the settings response processingJobs is []
    When the user activates "add-processing-job"
    Then no request is sent to the settings endpoint
    And the element with id "add-processing-job" has type "button"

  Scenario: Saving twice in quick succession sends one request
    Given one valid job
    When the user submits the settings form twice before the first response arrives
    Then exactly 1 PUT is sent to the settings endpoint

  Scenario: The setup prompt reflects processing jobs, not the removed schoolNames
    Given /auth/me returns processingJobs []
    Then connectionView reports needsSchool true
    And the "Tell us your school" card is rendered
    Given /auth/me returns processingJobs with one named job
    Then connectionView reports needsSchool false
    And the identity card shows that job's name as text

Feature: The processing-job editor is usable on a phone

  Scenario: Job rows stack rather than scroll sideways
    Given the shipped styles.css
    Then it contains a rule for ".job"
    And no rule sets overflow-x on ".jobs" or ".job" or their descendants
    And ".job" declares display: grid

  Scenario Outline: Every control added by this ticket meets the 44px guideline
    Given the shipped settings.html and styles.css
    Then the control "<control>" carries a class whose rule declares min-height 44px
    And that rule is not inside a media query
    Examples:
      | control              |
      | add-processing-job   |
      | remove job button    |
      | confirm remove       |
      | cancel remove        |
      | add search term      |
      | remove search term   |

  Scenario: Text inputs keep the 16px size that stops iOS zooming on focus
    Given the shipped styles.css
    Then ".field-input" still declares font: inherit
    And no rule reduces the font-size of ".field-input" below 16px
    And every job and term input carries the class "field-input"

  Scenario: No sixth frontend file and no external reference is introduced
    Given every frontend route is requested against an injected reader
    Then exactly five files are read under frontend/
    And styles.css contains no @import
    And no served body references an http or https URL

  Scenario: The disconnect section is untouched by this ticket
    Given the shipped settings.html
    Then the element with id "disconnect-submit" still ships the disabled attribute before its closing tag
    And the element with id "disconnect-events-keep" still ships checked
    And settings.js still exports requiredConfirmation and isConfirmed unchanged
```

## Edge and Failure Cases the implementer must handle

- **Re-rendering steals focus.** The list is rebuilt wholesale on add/remove, so any
  focused input is destroyed. Never re-render on `input`/`keyup`, and explicitly
  restore focus after an add (to the new row's name field). A re-render on keystroke
  would make the form impossible to type into.
- **Read the DOM back into state before every re-render.** The controller does not
  observe typing, so unsaved edits live only in the DOM. Re-rendering from
  `state.settings` instead of from the current DOM values silently discards
  everything the user typed since the last save - the single most likely bug in this
  ticket.
- **Index-based element ids shift when a job is removed.** They are only valid for
  the current render. Never cache an id across a mutation; resolve controls through
  `data-job-index` / `data-term-index` at event time.
- **`fieldErrorId` must stay an allowlist.** `error-${field}` built from an arbitrary
  server string would target whatever element happened to carry that id, and would
  show nothing at all when none did - the failure mode already called out at
  `settings.js:60-67`. Parse the indexed form with an anchored regex, allowlist the
  four sub-field names, and verify the element exists before using it.
- **A server 400 can name a row that is no longer on screen** (the user removed it
  after the request went out, or the server indexes differently). `showFieldError`
  must fall back to the form-level line, never fail silently.
- **`clearErrors` currently iterates a static id table** (`settings.js:253-262`). Per-row
  error slots are dynamic and will not be cleared by it as written; a stale row error
  would persist through the next save and point at the wrong row after a removal.
- **`hidden` works on this page only because of `[hidden] { display: none !important }`
  (`styles.css:617-619`)**, and `.field` is `display: grid` (527-530). If `.job` or
  `.job__term` are `display: grid`, the same `!important` is what keeps `hidden`
  effective on them. Do not weaken or reorder that rule.
- **`type="button"` on every new button.** They all sit inside
  `<form id="settings-form">`, whose submit handler calls `save()`
  (`settings.js:458-465`). A default-typed button would save on every "Add search
  term".
- **Do not stack listeners.** If handlers are bound inside the render function
  without delegation, ten renders means ten handlers and one tap flips the state ten
  times - the exact trap TASK-054 documented for `renderAttention`.
- **The test harness DOM is limited.** `tests/helpers/fake-dom.mjs` has
  `createElement`, `appendChild`, `removeChild`, `setAttribute`/`getAttribute`,
  `querySelector(All)` (tag/id/class/attribute + descendant combinators only),
  `addEventListener` and an **async** `dispatch()`. It has **no** `Element.remove()`,
  no `dataset`, no `closest()`, no `insertBefore`, no `getComputedStyle`, no layout
  and no `matchMedia`. Use `getAttribute("data-job-index")` not `el.dataset.jobIndex`,
  walk to the parent rather than `closest()`, and clear the container with the
  imported `clear()` helper (`app.js:129`).
- **`getElementById` in the harness walks the live tree**, so dynamically appended
  rows are findable - but only after they have been appended to a node already in
  the document.
- **`textContent` never parses markup, in the harness and in the browser.** That is
  the escaping story. Asserting the absence of an injected element (`findElements(doc,
  "img")`) is stronger than asserting the presence of escaped text - write it that
  way.
- **Do not send a client temp id.** TASK-055 generates `id` server-side and TASK-056
  attributes events to it. A client-invented id that reached storage would be
  indistinguishable from a real one and could collide.
- **Do not drop an existing `id` on edit.** Renaming a job must keep its `id`, or
  every event TASK-056 attributed to it is orphaned. This is the whole reason
  TASK-055 made `id` separate from `name`.
- **Do not omit `processingJobs` from the payload when the list is empty.** The
  documented rule at `settings.js:170-175` is that an absent key reads as "leave what
  is stored alone", so clearing the list would silently do nothing.
- **Do not enforce caps or domain shape client-side.** A page that is out of date
  would then refuse a value the server accepts - the failure mode rule 2 of the
  docblock exists to prevent.
- **Order of client checks matters.** Required-before-unique, and job order
  top-to-bottom, or the reported error points somewhere the user is not looking.
- **The uniqueness comparison is `trim()` + `toLowerCase()`**, per TASK-055. Do not
  reuse `parseSchoolNameList`'s exact-match dedup semantics (`settings.js:149-159`),
  which are deliberately case-sensitive for a different reason.
- **`save()`'s `finally` must still release `state.saving` and re-enable
  `#save-settings`** on the new client-side-rejection path, or one bad save locks the
  button for the rest of the session.
- **Removing `schoolNameList` from `app.js` breaks `settings.js`'s import list**
  (`settings.js:39-47`). Update both, and check no third caller remains.
- **`schoolNames`/`searchDomains` keys must be removed from `FIELD_ERROR_IDS`**, not
  aliased onto a new slot - the same fail-closed reasoning TASK-053 recorded at
  `settings.js:72-75`.
- **Do not add a sixth frontend file**, do not add `@import`, a web font or any
  remote URL - the allowlist, read-count and served-body scans all assert it.
- **Do not restyle or re-order the disconnect section.** Its raw-HTML slice
  assertions are position-sensitive.

## Relevant Files and Context

All frontend paths are under `src/lambda/calendar/frontend/`.

- **`frontend/settings.html`** - `<body data-page="settings">` at 9 (the bootstrap
  contract read at `settings.js:713`); `#connection-state` at 18;
  `#settings-body` at 20 and `#settings-summary` at 21;
  **`<form id="settings-form" class="panel settings-panel" novalidate>` at 23**;
  **the `<h2>Your school</h2>` at 24 and the two textarea fields at 26-45 - the exact
  block this ticket replaces**, including `#error-schoolNames` (33) and
  `#error-searchDomains` (44) and the `.field` / `.field-label` / `.field-input` /
  `.field-hint` / `.field-error` markup shape to copy for each job field; the
  schedule block 47-88 (untouched); `#error-form` 90; `#settings-status` 91;
  `#save-settings` 93; **the entire `#disconnect-gmail` section 114-173 (untouched,
  and position-sensitive - `disabled` must stay between the id and `</button>` on
  169)**.
- **`frontend/settings.js`** - **module docblock 1-37, whose rule 2 (23-30) and rule 3
  (32-36) this ticket must respectively amend and obey**; `SETTINGS_ENDPOINT` 50;
  `FIELD_ERROR_IDS` 77-88 and the fail-closed rationale at 60-75; `FORM_ERROR_ID` 91;
  **`fieldErrorId` 99-102** (the indexed-field parse goes here);
  `parseDomainList`/`formatDomainList` 115-130 and
  `parseSchoolNameList`/`formatSchoolNameList` 149-164 (all four removed with the
  fields they serve); **`buildSettingsPayload` 182-199** and the always-send rule at
  170-175; `buildSchedulePayload` 211-222 (unchanged); `createSettingsPage` 243-491 -
  specifically **`clearErrors` 253-262**, **`showFieldError` 271-279**, `setStatus`
  281-288, **`renderSummary` 290-305**, **`readForm` 307-325**, **`fillForm` 327-353**,
  `renderSignedOut` 355-360, `load` 362-378, `syncSchedule` 388-393, **`save` 401-455**,
  `bindControls` 457-470, the returned controller surface 478-491;
  **`initDisconnectControl` 613-704 - the confirmation pattern to mirror, not to
  modify** (`requiredConfirmation` 537-539, `isConfirmed` 555-558, the
  re-check-at-submit at 655-658, `onChoiceChange` 639-645, `refresh` 632-637); the
  `data-page` bootstrap 713-717.
- **`frontend/app.js`** - `el(doc, tag, className, text)` at 114 and `clear(node)` at
  129 (the two helpers every new node must be built with); `textOr` 141;
  **`schoolNameList` 602-605** (to be replaced by `processingJobList`);
  **`connectionView` 626-640 and its `needsSchool` gate at 637**; `schoolCard`
  680-692; **`identityCard` 695-716** and `identity-school-name` at 711;
  `renderConnectionCards` 729-744 (shared with the settings page); **the calendar
  header at 1149-1153**. Nothing else in this file is in scope - TASK-058 owns the
  render/filter surface.
- **`frontend/styles.css`** - docblock 1-14 (**no colour-alone state, no remote
  URL**); `.panel` 104-109; **the buttons block 150-210 (`.btn`, `.btn-primary`,
  `.btn-link`, `.btn-small`), all at `min-height: 44px` outside any media query, with
  the rationale comment at 150-157**; `.settings-body` 512-515; `.settings-summary`
  517-520; `.settings-panel` 522-525; **`.field` 527-530, `.field--inline` 532-536,
  `.field-label` 538-540, `.field-input` 542-550, `.field-hint` 567-571,
  `.field-error` 573-578 - the field markup vocabulary each job row reuses**; the
  24px radio/checkbox exception 556-565; **`.settings__section` 587-592 (the card
  language `.job` should match)**, `.disconnect__choice` 594-599,
  `.disconnect__option` 601-609, `.disconnect__confirm` 611-615;
  **`[hidden] { display: none !important }` 617-619**; `@media (max-width: 860px)`
  621-625; **`@media (max-width: 600px)` 642-684 and its no-horizontal-scroll /
  keep-16px rationale at 627-641**.

Sibling tickets:
- **`tasks/defining/TASK-055-processing-jobs-settings-model.md`** - the authoritative
  `ProcessingJob` shape, the `processingJobs` read/write contract, the caps, the
  migrate-on-read rule and the `SettingsValidationError` field-naming convention this
  UI's error routing depends on.
- **`tasks/defining/TASK-056-per-job-gmail-search-and-attribution.md`** - why a job's
  `id` must survive a rename.
- **`tasks/defining/TASK-058-filter-calendar-by-processing-job.md`** - owns `app.js`'s
  render/filter surface; the `app.js` change here is deliberately fenced to
  `connectionView`/`identityCard`/the header.

Prior art:
- **`tasks/done/TASK-053-multi-school-names.md`** - built the form this ticket
  replaces: the newline-splitter rationale, `FIELD_ERROR_IDS`'s deliberate omission of
  a superseded key, and the "every value is rendered as text" discipline.
- **`tasks/done/TASK-054-attention-expander-mobile-ui.md`** - the mobile contract this
  ticket must stay consistent with: 44px outside media queries, the 24px input
  exception, no `overflow-x`, keep 16px inputs, the 600px breakpoint, the five-file
  allowlist, and the CSS-as-text verification approach.

Tests that must be updated or kept green:
- **`tests/e2e/calendar-frontend-flow.test.js`** - the settings-page block around
  1300-1560 (`school-names-input` at 1314, 1416, 1441, 1482; `settings-summary` at
  1421; `error-schoolNames` at 1491; `settings-school-name` at ~1552-1553); the
  served-body source scans ~469-503; the five-file allowlist/read-count ~347-438; the
  `styles.css` content-type check ~267-271; the disconnect-markup scenarios ~1574-1615.
- **`tests/unit/task-053-school-names.test.js`** - the frontend-helper tests for
  `parseSchoolNameList`/`formatSchoolNameList`, which move to the new helpers.
- **`tests/unit/calendar-disconnect.test.js`** (~953) and
  **`tests/e2e/calendar-disconnect-flow.test.js`** - the no-`innerHTML` source scan
  and the raw-HTML `disabled` slice.
- **`tests/e2e/calendar-frontend-timezone.test.js`** - drives the same settings form.
- **`tests/helpers/fake-dom.mjs`** - read the docblock (1-29) and the `FakeElement` /
  `FakeDocument` API (140-262) before writing tests: no `Element.remove()`, no
  `dataset`, no `closest()`, async `dispatch()`, live `getElementById`.
- **`tests/helpers/css-text.mjs`** - the brace-matching CSS-as-text reader TASK-054
  added; every CSS criterion above is checked through it.
