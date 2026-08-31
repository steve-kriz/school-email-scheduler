---
id: TASK-058
title: Filter the calendar and attention list by processing job
status: done
created: 2026-08-31T00:00:00Z
updated: 2026-08-31T12:15:00Z
---

## Description
Depends on TASK-056's `processingJobId` field on stored/returned events. Let
the user filter the month calendar and the "needs attention" list down to
events from one named processing job, or show all of them.

Files: `src/lambda/calendar/frontend/app.js` (rendering/state for the month
grid and attention list built by TASK-010/TASK-054) and `styles.css` for any
new filter-control styling. Read `app.js` in full first, particularly
`renderAttention`/`renderDayCell`/`renderChip` and the `state` object TASK-054
already extended (`state.attentionExpanded` etc.) - this filter is more of the
same kind of client-side render-state, not a new data-fetching mechanism.

## Additional Context
- The events endpoint already returns whatever fields TASK-056 put on each
  event, including `processingJobId`. This ticket needs the job's NAME to
  label the filter control, not just its id - the events endpoint may need a
  small addition (a `processingJobName` alongside `processingJobId` on each
  returned event is the simplest option, resolved server-side from the user's
  current `processingJobs` settings; a client-side join against the settings
  API is the alternative) - the BA should decide and document which, since it
  determines whether this ticket touches any backend file at all.
- The filter is a client-side, in-memory filter over events already fetched
  for the visible month (and the attention list) - it must not require a
  fresh API call just to change which job is shown, the same way TASK-054's
  expand/collapse is pure client-side state.
- Default state is "all jobs" (unfiltered) - a first-time user with one
  default job should see no visible change from today's behaviour.
- A day cell's "+N more" overflow count and the attention list's "Show N
  more" (TASK-054) must reflect the FILTERED count, not the unfiltered total
  - a hidden-by-filter event should not count toward "N more" the user would
    see by expanding.
- Mobile-friendliness matters here too, consistent with TASK-054 - the filter
  control needs a real touch target and must not push the page into
  horizontal scrolling on a narrow viewport.

## The one open decision, decided

**The job NAME comes from a CLIENT-SIDE JOIN. The events endpoint is NOT
changed and this ticket touches NO backend file at all.**

The join source is `state.me.processingJobs`, which the calendar page
**already has**: `loadIdentity` (`app.js:1135-1144`) fetches
`GET /calendar/api/auth/me` on every page start and stores the whole body on
`state.me`, and `/auth/me` is `toPublicJson(connection, ...)`
(`index.mjs:1121`) over the `PUBLIC_ATTRIBUTES` allow-list
(`connections.mjs:48-66`) - the same allow-list `toSettingsJson`
(`settings.mjs:833-840`) projects for `GET /calendar/api/settings`. TASK-055
replaces `schoolNames`/`searchDomains` in that contract with `processingJobs`,
so `processingJobs` arrives on `/auth/me` for free, exactly as `schoolNames`
does today (`app.js:602-605`, `app.js:1149`). **No new request, no new
endpoint, no extra round trip.**

Why not `processingJobName` on each event, resolved server-side:

1. **It would only name jobs that happen to have events in the current
   month.** The dropdown has to list every configured job, including one that
   found nothing in September, or the option list would change every time the
   user pages between months. Only the settings-sourced list can do that.
2. **It would cost a settings read per events request.** `handleGetEvents`
   (`index.mjs:1761-1798`) and `handleGetUpcoming` (`index.mjs:1812-1848`)
   currently do exactly one Query each and never touch the connection row.
   The page polls both every 60s (`REFRESH_INTERVAL_MS`, `app.js:69`), so
   this would add two DynamoDB `GetItem`s per user per minute forever, to
   deliver a string the client already holds.
3. **It would break `toEventJson`'s contract.** That function
   (`events.mjs:1149-1169`) is documented as a field-by-field allow-list
   projection *of the stored row*; `processingJobName` is not on the row and
   cannot be, because TASK-056 deliberately stores the id and not the name so
   attribution survives a rename.
4. **It denormalises a name onto every event.** N events carry N copies of a
   string that changes when the user renames the job.

**Consequence for the coder: this ticket changes exactly three files -
`src/lambda/calendar/frontend/app.js`, `index.html` and `styles.css`.** If you
find yourself editing `src/lambda/calendar/index.mjs` or
`src/lambda/calendar/backend/events.mjs` (in particular `toEventJson` at
`events.mjs:1149`, or `handleGetEvents`/`handleGetUpcoming`), stop - that is
the rejected option.

**Hard prerequisite from TASK-056 (verify before building, do not
re-implement it here):** `processingJobId` must reach the browser, which
means TASK-056 adds it to `toEventJson`'s allow-list at
`events.mjs:1149-1169`, not only to the stored item (TASK-056's own
Acceptance Criteria now requires this - AC 31). `toUpcomingJson`
(`events.mjs:1194-1198`) spreads `toEventJson`, so the attention list
inherits it automatically. If the field were ever absent from the API
response, every event would fall into the "unattributed" bucket described
below and the filter would be inert.

## Acceptance Criteria

### Where the job list comes from (the decision above, made testable)

- [ ] A new exported pure helper `processingJobList(value)` reads a
      `processingJobs` value off an `/auth/me` body and returns an array of
      `{ id, name }`, mirroring `schoolNameList` (`app.js:602-605`) in both
      shape and tolerance: a non-array (including `null`, which is what
      `toPublicJson` emits for an absent attribute, `connections.mjs:351-355`)
      returns `[]`; entries that are not objects, or whose `id` or `name` is
      missing/blank after trimming, are dropped rather than rendered.
- [ ] The job list is read from `state.me.processingJobs` only. `app.js`
      contains **no** new `fetch`/`api.get` call, and in particular does not
      call `GET /calendar/api/settings`. Asserted by counting requests made by
      an injected `fetchImpl` across a full `start()` + filter change.
- [ ] No file under `src/lambda/calendar/backend/` and not
      `src/lambda/calendar/index.mjs` is modified by this ticket. `toEventJson`
      (`events.mjs:1149`) gains no `processingJobName`.
- [ ] The filter matches on `event.processingJobId` **equal to the selected
      job's `id`**, never on the name - a renamed job keeps its events.

### The filter control - markup (`frontend/index.html`)

- [ ] A static filter row is added inside `<section class="panel
      calendar-panel">`, immediately after the closing `</div>` of
      `<div class="calendar-toolbar">` (`index.html:33-41`) and immediately
      before `<p id="scan-message">` (`index.html:43`):
      `<div id="job-filter-row" class="calendar-filter" hidden><label class="calendar-filter__label" for="job-filter">Show events from</label><select id="job-filter" class="calendar-filter__select"></select></div>`
      (formatted across lines as the rest of the file is; the ids, the `for`
      and the `hidden` are the load-bearing parts).
- [ ] The `<select>` ships with **no `<option>` children** - every option is a
      job name, i.e. data, and is built by `app.js`.
- [ ] The wrapper `<div>`, not the `<select>`, carries `hidden`, so the label
      never floats alone.
- [ ] The row ships `hidden`, so a page whose script never loads shows no dead
      control - the same rule TASK-054 applied to `#attention-more`
      (`index.html:64`).
- [ ] `<label for="job-filter">` is a real label with visible text, so the
      control has an accessible name without an `aria-label`.
- [ ] No existing element in `index.html` is renamed, reordered or removed. In
      particular `#attention-more` still appears after `#attention-list` and
      before `#attention-empty` (asserted by
      `tests/e2e/task-054-attention-expander-flow.test.js:222`).
- [ ] No sixth frontend file is added.

### The filter control - options and visibility (`app.js`)

- [ ] `state` (`app.js:794-809`) gains `jobFilter: null`, initialised in the
      state literal. `null` means "all jobs"; any other value is a non-empty
      job id string.
- [ ] `state` gains `processingJobs: []`, holding the `{ id, name }` list from
      the last `/auth/me`.
- [ ] A new `renderJobFilter()` rebuilds the `<select>`: it `clear()`s the
      element, appends one "All jobs" option with `value=""` **first**, then
      one option per job in `state.processingJobs` in the order the API
      returned them, each with `value` = the job id and `textContent` = the job
      name.
- [ ] Options are built with `document.createElement` and `textContent` only.
      A job name is user-entered and stored raw (`settings.mjs` names
      escaping-on-render as its mitigation, exactly as for `schoolNames`), so
      a name of `<img src=x onerror=alert(1)>` renders as those literal
      characters and creates no element.
- [ ] `renderJobFilter()` is called from `applyIdentity` (`app.js:1146-1158`)
      only - **not** from `renderMonth` or `renderAttention`, which run on
      every 60s poll and on every optimistic mutation. (Rebuilding the options
      under the user mid-selection is the same class of bug as TASK-054's
      "do not append the toggle on every render".)
- [ ] After rebuilding, `renderJobFilter()` re-applies the current selection by
      assigning `select.value` explicitly (`state.jobFilter ?? ""`).
- [ ] If the current `state.jobFilter` names a job that is no longer in the
      list, the filter resets to `null`, `select.value` becomes `""`, and the
      month grid and attention list re-render unfiltered.
- [ ] `#job-filter-row` is visible only when `state.processingJobs.length >= 2`
      and hidden otherwise. **This is what delivers "no visible change for a
      single-default-job user":** with zero or one job there is nothing to
      choose between, so the control never appears and the page looks exactly
      as it does today.
- [ ] The default on first render is "All jobs": `state.jobFilter` is `null`,
      the first option is selected, and the rendered grid and attention list
      are byte-for-byte the same as they are without this ticket.

### Applying the filter (`app.js`)

- [ ] A new exported pure helper `filterEventsByJob(events, jobId)` returns the
      list unchanged (as an array) when `jobId` is `null`, `undefined` or `""`,
      and otherwise returns only those events whose `processingJobId ===
      jobId`. A non-array `events` returns `[]`.
- [ ] `renderMonth` (`app.js:917-950`) groups
      `filterEventsByJob(state.events, state.jobFilter)`, not `state.events`,
      so `groupEventsByDay` (`app.js:289-299`) never sees a filtered-out event.
- [ ] `renderAttention` (`app.js:1009-1044`) sorts and caps
      `filterEventsByJob(state.attention, state.jobFilter)`, not
      `state.attention`.
- [ ] **`state.events` and `state.attention` themselves are never filtered in
      place.** Both keep every event the API returned; filtering happens only
      on the way into a render. (`mutateAttention` at `app.js:1234-1269`
      splices by index into `state.attention` and restores by index on
      failure - filtering the array itself would restore a row at the wrong
      index or lose it entirely.)
- [ ] A new `setJobFilter(jobId)` sets `state.jobFilter` (mapping `""` to
      `null`), then calls `renderMonth()` and `renderAttention()` and nothing
      else. It is exposed on the returned controller alongside
      `toggleAttentionExpanded` (`app.js:1373-1396`).
- [ ] `setJobFilter` performs **no network request** - no refetch of the month,
      no refetch of the attention list. Asserted by request count against an
      injected `fetchImpl`.
- [ ] The `change` listener on `#job-filter` is bound **once**, in
      `bindControls` (`app.js:1349-1361`). Note the local `bind` helper there
      hard-codes `"click"`; either generalise it with an event-type parameter
      or add an explicit `addEventListener("change", ...)` line - do not bind
      inside a render function.
- [ ] `state.jobFilter` survives every re-render: the 60s poll
      (`startPolling`, `app.js:1334-1339`), `loadMonth`, `loadAttention`, a
      successful or failed `mutateAttention`, and month navigation
      (`previousMonth`/`nextMonth`/`goToToday`, `app.js:1317-1330`). Paging to
      October keeps the selected job selected.
- [ ] The filter is **not** persisted across page loads (no `localStorage`, no
      cookie, no query parameter). A reload comes back on "All jobs".

### Overflow counts reflect the FILTERED set

- [ ] A day cell's `+N more` count is `overflowCount(filteredEventsInThatCell,
      maxChips)` - an event hidden by the filter contributes nothing to `N`,
      and revealing the overflow never reveals an event from another job.
- [ ] When filtering drops a cell to `maxChips` or fewer events, that cell's
      `+N more` button is not rendered at all.
- [ ] The attention panel's `Show N more` count is
      `overflowCount(filteredAttentionCount, maxAttentionItems)`, still called
      with an explicit valid max (`overflowCount`'s fallback is
      `MAX_CHIPS_PER_DAY` = 3, not the attention cap - `app.js:326-330`).
- [ ] When the filtered attention list is at or below the cap,
      `#attention-more` is hidden and `state.attentionExpanded` resets to
      `false`, by the existing rule at `app.js:1017` - and switching back to
      "All jobs" therefore comes back **collapsed** with a correct
      `Show N more`. This is the accepted behaviour, not a defect.
- [ ] Rows hidden by the CAP are still `hidden` `<li>`s in `#attention-list`
      (TASK-054's rule). Rows hidden by the FILTER are **not rendered at all**
      - they are a different list, not a collapsed part of this one, so
      `#attention-list` must contain no `<li>` for an event from an unselected
      job.

### Empty states must not lie while a filter is on

- [ ] Four exported copy constants are added:
      `CALENDAR_EMPTY_MESSAGE` = "No events this month. Nothing to keep track
      of just yet.", `CALENDAR_EMPTY_FILTERED_MESSAGE` = "No events from that
      processing job this month.", `ATTENTION_EMPTY_MESSAGE` = "Nothing needs
      attention. You are all caught up.", `ATTENTION_EMPTY_FILTERED_MESSAGE` =
      "Nothing from that processing job needs attention."
- [ ] The two unfiltered constants are **exactly** the text already shipped in
      `index.html:48-50` and `index.html:65-67` (compared trimmed and
      whitespace-collapsed), so a script-less page still reads correctly and
      `tests/e2e/calendar-frontend-flow.test.js:1249`
      (`assert.match(textOf(empty), /No events this month/)`) still passes.
- [ ] `renderMonth` hides `#calendar-empty` when the FILTERED month has events,
      and sets its `textContent` to `CALENDAR_EMPTY_FILTERED_MESSAGE` when the
      filtered month is empty and `state.jobFilter` is not null, or to
      `CALENDAR_EMPTY_MESSAGE` when it is null.
- [ ] `renderAttention` does the same for `#attention-empty` with the two
      attention constants.
- [ ] Both messages are set with `textContent`. Neither interpolates the job
      name (that would put a raw settings value into a sentence for no gain;
      the dropdown right above already shows which job is selected).

### What the filter does NOT change

- [ ] `#calendar-truncated` keeps being driven by `state.truncated` alone
      (`app.js:940-949`). `truncated` is a fact about the SERVER-side range
      query, not about the filtered view, so a filter neither sets nor clears
      it.
- [ ] The event detail panel (`openEvent`, `app.js:1070-1123`) is **not**
      closed by a filter change. Filtering is a change of view scope, not a
      change of data, and closing a panel the user deliberately opened would be
      surprising. It closes only via `#detail-close`, a successful
      acknowledge/dismiss of the shown event, or a 401.
- [ ] `renderChip` (`app.js:849-866`) and `renderAttentionItem`
      (`app.js:952-993`) are unchanged - no job name, id or badge is added to a
      chip or an attention row by this ticket.
- [ ] `groupEventsByDay`, `splitDayEvents`, `compareByStart`, `compareByDueBy`
      and `overflowCount` are used as they are and not modified.

### Mobile: touch target and no horizontal scroll (`frontend/styles.css`)

- [ ] `.calendar-filter__select` declares `min-height: 44px` **outside any
      media query**, matching TASK-054's rule that touch sizing applies at all
      widths (`styles.css:159-211` for `.btn`/`.btn-link`/`.btn-small`).
- [ ] `.calendar-filter__select` declares `font: inherit`, so it stays at the
      16px body size. Below 16px iOS Safari zooms the viewport when the control
      takes focus - the same reason `.field-input` keeps `font: inherit`
      (`styles.css:542-550`, and the comment at `styles.css:636-641`).
- [ ] `.calendar-filter__select` declares `max-width: 100%`, so a long job name
      can never widen the panel past the viewport.
- [ ] `.calendar-filter` lays the label and control out with `display: flex`,
      `flex-wrap: wrap`, `align-items: center` and a `gap`, so at 360px the
      control wraps under its label instead of overflowing - the same pattern
      `.calendar-toolbar` (`styles.css:214-220`) and `.toolbar-actions`
      (`styles.css:227-232`) already use.
- [ ] Inside the existing `@media (max-width: 600px)` block
      (`styles.css:642+`), `.calendar-filter__select` gets `width: 100%` so it
      forms a full-width row, consistent with what that block already does to
      `.toolbar-actions` (`styles.css:658-661`).
- [ ] No rule anywhere sets `overflow-x` on `.calendar-filter`,
      `.calendar-panel`, `.calendar-grid` or `.calendar-week`. The page must
      not gain a horizontal scrollbar at 360px.
- [ ] The new rules are added in the "Calendar" section near
      `.calendar-toolbar`, and the `@media (max-width: 600px)` block is
      appended to, not restructured. The `@media (max-width: 860px)` block
      (`styles.css:621-625`) is untouched.
- [ ] `styles.css` stays self-contained: no `@import`, no web font, no
      `http(s)` URL (asserted by the served-body scan at
      `tests/e2e/calendar-frontend-flow.test.js:498-503`).

### Non-regression

- [ ] With `state.processingJobs` empty (today's data, or a `/auth/me` that
      predates TASK-055), every existing calendar and attention scenario
      behaves identically: the control is hidden, nothing is filtered, and the
      empty-state copy is the original text.
- [ ] The whole `Feature: The "Needs attention" panel` block
      (`tests/e2e/calendar-frontend-flow.test.js:949-1131`) still passes.
- [ ] Both TASK-054 suites still pass unchanged
      (`tests/e2e/task-054-attention-expander-flow.test.js`,
      `tests/unit/task-054-attention-expander.test.js`), including the
      element-ordering assertion at line 222 and the 93 tests as a whole.
- [ ] The day-cell overflow block
      (`tests/e2e/calendar-frontend-flow.test.js:739-778`) and the grid-shape
      assertions (`:619-629`) still pass.
- [ ] The served-body source scans still pass: no `innerHTML`, no
      `insertAdjacentHTML`, no `document.write`, no external URL
      (`tests/e2e/calendar-frontend-flow.test.js:469-503`).
- [ ] The five-file allowlist and read-count assertions
      (`tests/e2e/calendar-frontend-flow.test.js:347-438`) are unaffected.

## Cucumber Tests

```gherkin
Feature: Filtering the calendar by processing job

  Background:
    Given an authenticated user whose Gmail is connected
    And GET /calendar/api/auth/me returns processingJobs:
      | id     | name          |
      | job-a  | Junior School |
      | job-b  | Senior School |
    And the calendar page has started

  Scenario: The control lists every configured job plus an "All" option
    When the calendar page has finished starting
    Then the element with id "job-filter-row" is visible
    And the select with id "job-filter" has 3 options
    And its first option has the value "" and the text "All jobs"
    And its remaining options have the values "job-a" and "job-b"
    And their texts are "Junior School" and "Senior School"
    And the selected value is ""

  Scenario: All jobs is the default and shows everything
    Given the month returns 2 events for job-a and 3 events for job-b
    When the calendar page has finished starting
    Then 5 event chips are rendered in the month grid
    And the controller state jobFilter is null

  Scenario: Filtering to one job hides the other job's events from the grid
    Given the month returns 2 events for job-a and 3 events for job-b
    When the user selects "Junior School" in "job-filter"
    Then 2 event chips are rendered in the month grid
    And no chip carries the event id of any job-b event
    And the controller state jobFilter is "job-a"

  Scenario: Filtering to one job hides the other job's rows from the attention list
    Given 3 attention items belong to job-a and 4 belong to job-b
    When the user selects "Senior School" in "job-filter"
    Then the attention list contains exactly 4 items
    And no attention item carries the event id of any job-a item

  Scenario: Switching back to "All" restores everything
    Given the month returns 2 events for job-a and 3 events for job-b
    And 3 attention items belong to job-a and 4 belong to job-b
    And the user has selected "Junior School" in "job-filter"
    When the user selects "All jobs" in "job-filter"
    Then 5 event chips are rendered in the month grid
    And the attention list contains exactly 7 items
    And the controller state jobFilter is null

  Scenario: Changing the filter makes no network request
    Given the number of fetch calls so far is recorded
    When the user selects "Senior School" in "job-filter"
    And then selects "All jobs" in "job-filter"
    Then the number of fetch calls is unchanged

  Scenario: The filter survives a background refresh
    Given the user has selected "Junior School" in "job-filter"
    When the 60-second refresh timer fires and the same events come back
    Then the controller state jobFilter is still "job-a"
    And only job-a events are rendered in the month grid

  Scenario: The filter survives month navigation
    Given the user has selected "Junior School" in "job-filter"
    When the user activates "next-month"
    Then the controller state jobFilter is still "job-a"
    And the select with id "job-filter" still shows "Junior School"

  Scenario: Filtering does not discard the events it is hiding
    Given the month returns 2 events for job-a and 3 events for job-b
    When the user selects "Junior School" in "job-filter"
    Then the controller state events still contains 5 events

Feature: Overflow counts follow the filter

  Background:
    Given an authenticated user with processing jobs "job-a" and "job-b"
    And the calendar page has started with a maximum of 3 chips per day
    And a maximum of 5 visible attention items

  Scenario: A day cell's "+N more" counts only the filtered events
    Given 4 January events for job-a and 3 January events for job-b all fall on the 12th
    When the attention and month panels render unfiltered
    Then the day cell for the 12th shows "+4 more"
    When the user selects the job named for "job-a"
    Then the day cell for the 12th shows "+1 more"
    And revealing the overflow shows only job-a events

  Scenario: A day cell that fits after filtering loses its "+N more" entirely
    Given 4 events for job-a and 2 events for job-b fall on the same day
    When the user selects the job named for "job-b"
    Then the day cell for that day renders no element with class "more-toggle"
    And both job-b chips are visible

  Scenario: The attention "Show N more" counts only the filtered items
    Given 8 attention items belong to job-a and 4 belong to job-b
    When the attention panel renders unfiltered
    Then the text of "attention-more" is "Show 7 more"
    When the user selects the job named for "job-a"
    Then the text of "attention-more" is "Show 3 more"
    And 5 attention items are visible
    And 3 attention items are present but hidden

  Scenario: Filtering below the cap retires the attention toggle
    Given 8 attention items belong to job-a and 4 belong to job-b
    And the user has activated "attention-more"
    When the user selects the job named for "job-b"
    Then the element with id "attention-more" is hidden
    And all 4 attention items are visible
    And the controller state attentionExpanded is false

  Scenario: Switching back to All comes back collapsed with the correct count
    Given 8 attention items belong to job-a and 4 belong to job-b
    And the user has selected the job named for "job-b"
    When the user selects "All jobs" in "job-filter"
    Then the element with id "attention-more" is visible
    And its text is "Show 7 more"
    And its aria-expanded attribute is "false"

  Scenario: A filtered-out attention row is absent from the list, not merely hidden
    Given 3 attention items belong to job-a and 4 belong to job-b
    When the user selects the job named for "job-a"
    Then the attention list contains no element carrying a job-b event id

Feature: A single-job user sees no change

  Scenario: One processing job means no filter control
    Given GET /calendar/api/auth/me returns exactly one processing job named "Default"
    When the calendar page has finished starting
    Then the element with id "job-filter-row" is hidden
    And every event returned for the month is rendered in the grid
    And the controller state jobFilter is null

  Scenario: No processing jobs at all means no filter control
    Given GET /calendar/api/auth/me returns processingJobs as null
    When the calendar page has finished starting
    Then the element with id "job-filter-row" is hidden
    And the controller state processingJobs is an empty list
    And the month grid renders every returned event

  # --- Failure and edge paths ---

  Scenario: Events with no job attribution are visible under All and hidden under a job
    Given the month returns 2 events with a processingJobId of null
    And 2 events for job-a
    When the calendar page renders unfiltered
    Then 4 event chips are rendered
    When the user selects the job named for "job-a"
    Then 2 event chips are rendered
    And neither unattributed event is rendered

  Scenario: The events endpoint omitting processingJobId leaves the filter inert, not broken
    Given the month returns 5 events with no processingJobId field at all
    When the user selects the job named for "job-a"
    Then the month grid renders 0 event chips
    And the element with id "calendar-empty" is visible
    And no error is thrown

  Scenario: A job removed in settings clears a stale selection on the next load
    Given the user has selected the job named for "job-b"
    When /auth/me is loaded again and returns only "job-a"
    Then the select with id "job-filter" has 2 options
    And the controller state jobFilter is null
    And every returned event is rendered in the grid

  Scenario: A hostile job name is rendered as text in the option
    Given a processing job named "<img src=x onerror=alert(1)>"
    When the calendar page has finished starting
    Then that option's textContent is that literal string
    And no IMG element exists anywhere in the document

  Scenario: A malformed processingJobs entry is dropped, not rendered
    Given processingJobs contains one valid job, one entry with a blank name, one entry with no id, and one string
    When the calendar page has finished starting
    Then the select with id "job-filter" has 2 options
    And the only job option is the valid one

  Scenario: An empty filtered month says the filter is why, not that there is nothing on
    Given the month returns 3 events, all for job-b
    When the user selects the job named for "job-a"
    Then the element with id "calendar-empty" is visible
    And its text is "No events from that processing job this month."
    When the user selects "All jobs" in "job-filter"
    Then the element with id "calendar-empty" is hidden

  Scenario: An empty filtered attention list says the filter is why
    Given 4 attention items, all for job-b
    When the user selects the job named for "job-a"
    Then the element with id "attention-empty" is visible
    And its text is "Nothing from that processing job needs attention."

  Scenario: The unfiltered empty copy is unchanged from what index.html ships
    Given nothing is returned for the month and nothing needs attention
    When the calendar page renders unfiltered
    Then the text of "calendar-empty" matches "No events this month"
    And the text of "attention-empty" matches "Nothing needs attention"

  Scenario: Acknowledging a visible row under a filter still restores in place on failure
    Given 3 attention items belong to job-a and 4 belong to job-b
    And the user has selected the job named for "job-a"
    And the acknowledge request will return 500
    When the user acknowledges the 2nd visible item
    Then that row reappears as the 2nd item in the filtered list
    And the attention message reads the restore message
    And the controller state attention still contains 7 items

  Scenario: The truncated notice is about the fetch, not the filter
    Given the events endpoint reports truncated true
    When the user selects the job named for "job-a"
    Then the element with id "calendar-truncated" is still visible
    And its text is unchanged

  Scenario: An open detail panel is not closed by changing the filter
    Given the user has opened the detail panel for a job-b event
    When the user selects the job named for "job-a"
    Then the element with id "event-detail" is still visible
    And it still carries the job-b event id

  Scenario: The change listener is bound once, not once per render
    Given the user has selected the job named for "job-a"
    And the 60-second refresh timer has fired 5 times
    When the user selects "All jobs" in "job-filter"
    Then the controller state jobFilter is null
    And the month grid renders every returned event

  Scenario: The control ships inert for a page whose script never loads
    Given the shipped index.html is parsed without running app.js
    Then the element with id "job-filter-row" has the hidden attribute
    And the select with id "job-filter" has no option children
    And it sits between the calendar toolbar and the scan message

Feature: The filter control is usable on a phone

  Scenario: The control meets the touch-target guideline at every width
    Given the shipped styles.css
    Then the rule for ".calendar-filter__select" declares a min-height of 44px
    And that declaration is not inside any media query

  Scenario: The control does not trigger the iOS focus zoom
    Given the shipped styles.css
    Then the rule for ".calendar-filter__select" declares font: inherit
    And no media query reduces the body font-size below 16px

  Scenario: A long job name cannot widen the page
    Given the shipped styles.css
    Then the rule for ".calendar-filter__select" declares max-width: 100%
    And the 600px media block sets .calendar-filter__select width to 100%
    And the rule for ".calendar-filter" declares flex-wrap: wrap

  # --- Failure and edge paths ---

  Scenario: Nothing gains a horizontal scroll region
    Given the shipped styles.css
    Then no rule sets overflow-x on .calendar-filter
    And no rule sets overflow-x on .calendar-grid or .calendar-week
    And .calendar-week still uses repeat(7, minmax(0, 1fr))

  Scenario: The stylesheet stays self-contained and no new asset appears
    Given every frontend route is requested against an injected reader
    Then styles.css contains no @import and references no http or https URL
    And exactly five files are read
```

## Edge and Failure Cases the implementer must handle

- **An event with no `processingJobId`** (every row written before TASK-056,
  and any row TASK-056 could not attribute) is visible under "All jobs" and
  hidden under any specific job. Do not invent an "unattributed" pseudo-job
  option and do not leak such events into a job's view - matching a `null` id
  against a selected id must simply be false.
- **`processingJobs` arrives as `null`, not `[]`.** `toPublicJson` projects an
  absent attribute as `null` (`connections.mjs:351-355`) - this is the ordinary
  first-run case, exactly as it is for `schoolNames` (`app.js:616-623`), not a
  defensive afterthought. `processingJobList` must return `[]` for it.
- **Zero or one job hides the control.** Do not render a one-option dropdown,
  and do not render an "All jobs"-only dropdown. The ticket's promise is that a
  single-default-job user sees no change.
- **Do not filter `state.events` / `state.attention` in place.**
  `mutateAttention` (`app.js:1234-1269`) splices by index and restores by the
  same index on failure; a filtered backing array would restore the row in the
  wrong place or drop it. Filter on the way into the render, every time.
- **Do not rebuild the `<select>`'s options inside `renderMonth` or
  `renderAttention`.** Both run on every 60s poll and on every optimistic
  mutation; rebuilding options would clear and reset the control under a user
  mid-interaction. Build them in `applyIdentity` only. This is TASK-054's
  "the toggle is static markup, not JS-appended" trap in a new costume.
- **Re-apply `select.value` after any rebuild.** Replacing the option children
  does not preserve the selection.
- **In the test harness a `<select>` built with `createElement` does not derive
  `.value` from its options.** `tests/helpers/fake-dom.mjs` hydrates a select's
  `value` from its options only at PARSE time (`fake-dom.mjs:525-531`); a
  `FakeElement` created by `createElement` just has `value = ''`
  (`fake-dom.mjs:113`). So the app **must** assign `select.value` explicitly,
  and a test drives a change by setting `select.value = 'job-a'` and then
  `await select.dispatch('change')`. `dispatch` is async and awaits every
  handler (`fake-dom.mjs:209-215`), and `addEventListener` accepts any event
  type (`fake-dom.mjs:196-200`).
- **`bindControls`'s local `bind` helper only binds `"click"`**
  (`app.js:1350-1353`). A `<select>` needs `"change"`. Generalise the helper or
  add one explicit line - but bind it in `bindControls`, once. Binding inside a
  render function stacks one handler per poll, so after ten polls one selection
  would fire the handler ten times (this exact bug is called out in TASK-054).
- **A stale `state.jobFilter` after a settings edit.** The job list is only
  refreshed by `loadIdentity`, which the 60s poll does not call
  (`refreshAll`, `app.js:1215-1219`, fetches the month and the attention list
  only). So a job renamed or deleted in another tab is not reflected until a
  reload. That is accepted - do NOT add an identity fetch to the poll. Just
  make sure the reset-to-"All jobs" path runs when the list *is* reloaded and
  the selected id has vanished.
- **`overflowCount`'s max fallback is `MAX_CHIPS_PER_DAY` (3), not the
  attention cap** (`app.js:326-330`). Keep passing an explicit valid max, as
  TASK-054 does.
- **A filter that empties the attention list trips TASK-054's
  reset-when-overflow-is-zero rule** (`app.js:1017`), so an expanded panel
  collapses when the user narrows to a small job and stays collapsed when they
  widen again. This is the documented, accepted behaviour - do not add extra
  state to defeat it, and do not remove the reset.
- **The empty-state copy must not lie.** "No events this month. Nothing to keep
  track of just yet." is false when the user has filtered away three events.
  Swap the text, and swap it back when the filter clears.
- **Every job name is user-supplied text** and is stored raw, exactly like
  `schoolNames`. `<option>` labels go through `textContent` only - `app.js`'s
  rule 1 (`app.js:9-20`) has no exceptions, and the served-body scan at
  `tests/e2e/calendar-frontend-flow.test.js:490-503` fails the build on
  `.innerHTML`.
- **`hidden` on `#job-filter-row` works only because of
  `[hidden] { display: none !important }`** (`styles.css:617-619`), which the
  new `.calendar-filter { display: flex }` rule would otherwise beat. Do not
  weaken or reorder that rule, and do not use a `visibility`/`height: 0`
  approach - the `<select>` would stay focusable and tabbable.
- **Do not add a sixth frontend file.** The route table, the allowlist and the
  read-count assertions all hard-code five
  (`tests/e2e/calendar-frontend-flow.test.js:347-438`).
- **There is no CSS engine and no layout in the test harness.** Every CSS
  criterion above is verified by reading `styles.css` as text - use the
  existing `tests/helpers/css-text.mjs` reader TASK-054 added rather than a
  fresh regex, and do not add a DOM or CSS library.
- **Do not touch the backend.** If a change seems to need `toEventJson`,
  `handleGetEvents` or `handleGetUpcoming`, re-read "The one open decision,
  decided" above - that is the rejected design.

## Relevant Files and Context

All frontend paths are under `src/lambda/calendar/frontend/`.

- **`frontend/app.js`** (the file that does nearly all of this work) - module
  docblock 1-34 (**rule 1: everything is `textContent`, never markup**);
  `MAX_CHIPS_PER_DAY` 57 and `MAX_ATTENTION_ITEMS` 66 (where the new exported
  constants belong); `overflowCount` 326-330 (**reused, not modified; its
  invalid-max fallback is 3**); `groupEventsByDay` 289-299; `splitDayEvents`
  308-317; `compareByDueBy` 473-478; **`schoolNameList` 602-605 - the exact
  tolerance pattern `processingJobList` mirrors**; `connectionView` 626-640
  (how an `/auth/me` body is read); `renderChip` 849-866 (unchanged);
  **`renderDayCell` 868-915 - the `hiddenChips` / `+N more` block at 891-912 is
  what must now count the filtered set**; `renderMonth` 917-950 (grouping at
  925, the `#calendar-empty` line at 938, the `#calendar-truncated` block at
  940-949); `renderAttentionItem` 952-993 (unchanged); **`renderAttention`
  1009-1044 - the sort at 1011, the `overflowCount` at 1014, the
  reset-when-zero at 1017, the `Show N more` label at 1036, the
  `#attention-empty` line at 1043**; `toggleAttentionExpanded` 1055-1059 (the
  shape `setJobFilter` mirrors); `openEvent` 1070-1123; the `state` literal
  **794-809** (where `jobFilter` and `processingJobs` go); `loadIdentity`
  1135-1144 and **`applyIdentity` 1146-1158 - where `renderJobFilter` is
  called**; `loadMonth` 1184-1199; `loadAttention` 1201-1213; `refreshAll`
  1215-1219 (note: it does NOT reload identity); **`mutateAttention` 1234-1269
  - the optimistic splice at 1240-1243 and the restore-by-index at
  1262-1265**; `goToMonth`/`previousMonth`/`nextMonth`/`goToToday` 1317-1330;
  `startPolling` 1334-1339; **`bindControls` 1349-1361 - the local `bind`
  helper is click-only**; `start` 1363-1371; the returned controller surface
  1373-1396 (where `setJobFilter` is exposed).
- **`frontend/index.html`** - `data-page="calendar"` bootstrap contract 9-13;
  **the calendar toolbar 33-41 and `#scan-message` 43 - the new
  `#job-filter-row` goes between them**; the weekday/grid containers 45-46;
  `#calendar-empty` 48-50 and `#calendar-truncated` 51 (the exact empty copy to
  keep in sync with the new constant); the attention `<aside>` 54-68, with
  `#attention-list` 57, **TASK-054's `#attention-more` 58-64 (the static,
  ships-hidden precedent this control follows)** and `#attention-empty` 65-67.
- **`frontend/styles.css`** - docblock 1-14 (**no colour-alone state, no remote
  URL**); `.btn`/`.btn-link`/`.btn-small` 159-211 (the `min-height: 44px`
  pattern); **`.calendar-toolbar` 214-220 and `.toolbar-actions` 227-232 - the
  flex/wrap/gap idiom the new `.calendar-filter` copies, and where the new
  rules belong**; the 7-column grid definitions 234-246; `.chip` 332-348;
  `.more-toggle` 371-384; `.empty-state` 475-482; `.field-label` 538-540 and
  **`.field-input` 542-550 (`font: inherit`, i.e. 16px - the anti-iOS-zoom
  rule)**; the radio/checkbox 24px exception and its comment 556-565;
  **`[hidden]` 617-619**; `@media (max-width: 860px)` 621-625 (untouched);
  **`@media (max-width: 600px)` 642+ (appended to; see its docblock 627-641 for
  the no-overflow-x and no-shrinking-type rules this ticket must respect)**.

Read-only context (do NOT edit these - they justify the design decision above):

- **`src/lambda/calendar/index.mjs`** - `handleAuthMe` 1070-1125 (returns
  `toPublicJson`, which is where `processingJobs` arrives); `handleGetSettings`
  1216-1244; **`handleGetEvents` 1761-1798 and `handleGetUpcoming` 1812-1848 -
  unchanged by this ticket**.
- **`src/lambda/calendar/backend/connections.mjs`** - `PUBLIC_ATTRIBUTES`
  48-66 (TASK-055 swaps `schoolNames`/`searchDomains` for `processingJobs`
  here, which is what puts the list on `/auth/me`); `toPublicJson` 338-370
  (absent attributes project as `null`).
- **`src/lambda/calendar/backend/settings.mjs`** - `toSettingsJson` 833-840.
- **`src/lambda/calendar/backend/events.mjs`** - **`toEventJson` 1149-1169, the
  allow-list TASK-056 must add `processingJobId` to**; `toUpcomingJson`
  1194-1198 (spreads it).

Tests that must keep passing, and where they assert:

- **`tests/e2e/calendar-frontend-flow.test.js`** - the attention panel block
  **949-1131** (`rowFor` at 961); the day-cell overflow block **739-778**; the
  grid-shape assertions **619-629**; the `#calendar-empty` scenario
  **1246-1258** (it matches `/No events this month/`); the served-body source
  scans **469-503**; the allowlist/read-count blocks **347-438**; the
  `styles.css` content-type check **267-271**.
- **`tests/e2e/task-054-attention-expander-flow.test.js`** (52 tests) and
  **`tests/unit/task-054-attention-expander.test.js`** (41 tests) - the
  expander behaviour this ticket layers a filter on top of. Line 222 asserts
  `#attention-more` sits between the list and the empty state.
- **`tests/unit/calendar-frontend.test.js`** - the home for unit tests of the
  new exported pure helpers (`processingJobList`, `filterEventsByJob`) and the
  new copy constants; it already covers every exported pure helper in `app.js`.
- **`tests/helpers/fake-dom.mjs`** - read the docblock (1-29) first. `hidden`
  is a plain property; `dispatch()` is async and awaits handlers (209-215);
  selectors support tag/id/class/attribute and descendant combinators only;
  **a `<select>`'s `value` is hydrated from its options only at parse time
  (525-531)**; there is no CSS and no layout.
- **`tests/helpers/css-text.mjs`** - TASK-054's brace-matching CSS-as-text
  reader. Use it for every CSS criterion above rather than writing a new regex.

Prior art: `tasks/done/TASK-010` defined the month grid, the attention panel
and the `more-toggle` pattern; **`tasks/done/TASK-054-attention-expander-mobile-ui.md`
is the closest analogue to this ticket** - read its "Decisions already settled"
list (items 7, 8, 11 and 13 in particular) before starting, because this ticket
follows the same static-markup, state-on-`state`, bind-once, touch-sizing-at-
all-widths rules. Siblings: TASK-055 (`processingJobs` settings model, the
`{ id, name, schoolName, domain, searchTerms }` shape), TASK-056
(`processingJobId` on events - the hard prerequisite), TASK-057 (the settings
UI that creates and names the jobs this filter lists).
