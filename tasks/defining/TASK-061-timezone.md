---
id: TASK-061
title: timezone
status: defining
created: 2026-08-31T00:20:25.539Z
updated: 2026-08-31T11:30:00Z
question: Should the time zone selector list every IANA zone (Intl.supportedValuesOf('timeZone'), ~400 entries, needs a fallback for browsers that lack it), or a short curated list of the zones this school tool actually serves (e.g. the Australian zones plus UTC) with the stored zone appended if it is outside that list? And is this strictly about when the scan job fires, or should the chosen zone also drive how event times are DISPLAYED on the calendar (which renders in the browser's own zone today)?
---

## Description
add a timezone selecting in the setting page so that when I set the process job
time it runs in the correct timezone

Clarified after reading the code, because most of this already exists and the
real gap is narrower than the title suggests:

- The scan schedule **already runs in the stored time zone**. `putScanSchedule`
  sets `ScheduleExpressionTimezone` on the EventBridge schedule
  (`scan-schedule.mjs:324`) and deliberately keeps the offset out of the cron
  string, so EventBridge resolves DST on every firing. That plumbing is complete
  and must not be re-implemented or "simplified" into offset arithmetic.
- The settings page **already has a "Time zone" field** — but it is a plain
  free-text box (`settings.html:97-101`), prefilled from the stored zone or from
  the browser's own zone via `detectTimezone()`. There is nothing to *select*,
  which is why it does not read as a time zone setting.

So this ticket is: **turn the existing free-text time zone box into a real
selector**, and close the one gap that box leaves open — a zone that *looks*
right but is not a real zone is accepted by the settings endpoint and then
rejected by the schedule endpoint, leaving the user with a saved setting and a
schedule that was never updated.

## Acceptance Criteria
- [ ] The time zone field in `settings.html` is a `<select class="field-input">`
      following the same markup pattern as `#schedule-frequency-input` and
      `#schedule-day-input`, instead of `<input type="text">`.
- [ ] It keeps the id `timezone-input`, its
      `<label class="field-label" for="timezone-input">Time zone</label>` and its
      `<p id="error-timezone" class="field-error" role="alert" hidden>` slot
      exactly as they are now, so `readForm`, `fillForm` and
      `FIELD_ERROR_IDS.timezone` keep working with no rename anywhere.
- [ ] Every option's `value` is the exact IANA zone id that is sent to the server
      (e.g. `Australia/Sydney`), never a display label or an offset.
- [ ] On load, the select is set to the stored `settings.timezone`; when nothing
      is stored it falls back to `detectTimezone()`, unchanged from today.
- [ ] When the stored (or detected) zone is not one of the listed options, that
      zone is still the selected one — it is added as an option rather than the
      select silently landing on its first entry. A page load must never quietly
      change a schedule's saved zone on the next save.
- [ ] Choosing a zone and pressing Save sends that exact string as `timezone` on
      both `PUT /calendar/api/settings` and `PUT /calendar/api/scan/schedule`;
      `buildSettingsPayload` and `buildSchedulePayload` need no change.
- [ ] The page can no longer submit a blank or non-IANA time zone: the select
      always has a valid option selected. (Today the text box can send `""` or
      `Foo/Bar`.)
- [ ] `validateSchedule` in `backend/settings.mjs` validates `timezone` against
      the real tz database — the same check `scan-schedule.mjs` already uses via
      `isValidTimezone` — instead of the shape-only `TIMEZONE_PATTERN`, so the
      settings endpoint can no longer accept a zone the schedule endpoint will
      reject.
- [ ] That tightened check keeps the existing 400 contract: `field` is
      `"timezone"` and the message stays the current
      `"<value>" is not a valid time zone`, with the echoed value still capped in
      length.
- [ ] A short hint under the field states that the scan runs at the chosen hour
      in the selected time zone, so the connection between the hour field and
      this field is visible.
- [ ] Any option elements built in JS are created with `el()`/`createElement`
      and their text set with `textContent` — no markup assembly anywhere in
      `settings.js` (rule 3 of that file's module docblock; a repo test reads the
      source and fails otherwise).
- [ ] No change to how the schedule actually fires:
      `ScheduleExpressionTimezone` remains the mechanism and
      `buildScanCronExpression` still carries no zone.
- [ ] The existing suites that stub or register `timezone-input` still pass
      unchanged (see Relevant Files).

## Cucumber Tests
```gherkin
Feature: Choosing the time zone the scan schedule runs in

  Background:
    Given I am signed in and on the settings page
    And automatic scanning is provisioned in this environment

  Scenario: The time zone field is a selector, not a text box
    When the settings page loads
    Then the "Time zone" control is a select element with the id "timezone-input"
    And it is labelled by the "Time zone" label
    And a hint tells me the scan runs at my chosen hour in that time zone

  Scenario: My saved time zone is the one selected
    Given my stored settings have a timezone of "Australia/Perth"
    When the settings page loads
    Then the "Time zone" selector shows "Australia/Perth" as the selected option

  Scenario: A first-time user gets their browser's zone
    Given my stored settings have no timezone
    And my browser reports its zone as "Australia/Sydney"
    When the settings page loads
    Then the "Time zone" selector shows "Australia/Sydney" as the selected option

  Scenario: Saving sends the chosen zone to both endpoints
    Given automatic scanning is switched on
    And the scan hour is 7
    When I choose "Australia/Brisbane" and press "Save settings"
    Then the settings request body has a timezone of "Australia/Brisbane"
    And the scan schedule request body has a timezone of "Australia/Brisbane"
    And the schedule is created with a ScheduleExpressionTimezone of "Australia/Brisbane"
    And the cron expression contains no offset or zone of its own

  Scenario: The chosen zone is what the job actually fires in
    Given I have saved a daily scan at hour 7 in "Australia/Brisbane"
    Then the stored schedule expression is "cron(0 7 * * ? *)"
    And the schedule's timezone is "Australia/Brisbane"
    And no conversion of the hour to UTC has been performed at save time

  # --- Edge and failure cases ---

  Scenario: A stored zone that is not in the list is still preserved
    Given my stored settings have a timezone of "Pacific/Chatham"
    And "Pacific/Chatham" is not one of the listed options
    When the settings page loads
    Then the "Time zone" selector still shows "Pacific/Chatham" as selected
    And pressing "Save settings" without touching the field sends "Pacific/Chatham" unchanged

  Scenario: A plausible-looking but fake zone is refused by the settings endpoint
    When a client sends a settings payload with a timezone of "Mars/Olympus_Mons"
    Then the response is 400
    And the response field is "timezone"
    And the response error reads "Mars/Olympus_Mons" is not a valid time zone
    And nothing is written to my connection row

  Scenario: The settings and schedule endpoints agree on what is valid
    When a client sends a timezone of "Foo/Bar" to the settings endpoint
    And a client sends a timezone of "Foo/Bar" to the scan schedule endpoint
    Then both respond 400 naming the field "timezone"
    And there is no value that one accepts and the other rejects

  Scenario: A blank time zone can no longer be submitted from the page
    When the settings page loads
    Then the "Time zone" selector has a non-empty selected value
    And there is no way to clear it to an empty string

  Scenario: A rejected time zone is shown against the field
    Given the server refuses my time zone with a 400 naming the field "timezone"
    When the save completes
    Then the message is shown in the "error-timezone" slot
    And it is set as text, so a hostile value cannot become markup
    And the form-level error line stays hidden

  Scenario: The browser cannot report a zone at all
    Given my stored settings have no timezone
    And the browser's Intl lookup throws
    When the settings page loads
    Then the "Time zone" selector falls back to "UTC" rather than being blank
```

## Edge and Failure Cases to Handle
- **Stored zone outside the option list.** Must be added as a selected option,
  never silently replaced by the first entry — that would rewrite a working
  schedule's zone on the user's next save.
- **`detectTimezone()` throwing or returning "".** Already handled in
  `settings.js:441-448` by falling back to `"UTC"`; the selector must not
  reintroduce a blank state on that path.
- **A shape-valid but non-existent zone** (`Foo/Bar`, `Mars/Olympus_Mons`).
  Today `settings.mjs` accepts it and `scan-schedule.mjs` rejects it, so the user
  gets "Your school was saved, but the automatic scan schedule was not" and a
  bogus `timezone` persisted on the connection row. Tightening `validateSchedule`
  closes this.
- **A blank timezone.** Today `buildSettingsPayload` omits the key (server leaves
  the stored value alone) while `buildSchedulePayload` sends `""` (400 on the
  schedule only) — an inconsistent half-failure the selector removes.
- **Legacy stored value.** A connection row saved before this change may hold a
  zone that the tightened validator would now reject. Loading the page must still
  render (the selector shows it), and the failure, if any, must surface as a
  normal 400 on save rather than a crash while filling the form.
- **Scheduling not provisioned** (`isScheduleEnabled` false). The schedule PUT
  answers `{ available: false }` and `save()` reports "Automatic scanning is not
  available in this environment yet." The selector must not change that path.
- **DST.** Never convert the chosen hour to UTC at save time. See the TIMEZONE
  note in the `scan-schedule.mjs` docblock.
- **Untrusted text.** Any zone string reaching the DOM goes through `textContent`
  or a control's `value`, per rule 3 of the `settings.js` docblock.

## Relevant Files and Context
- `src\lambda\calendar\frontend\settings.html` — lines 91-101: the schedule
  fields. Line 99 is the free-text box to replace. Copy the
  `<select class="field-input">` pattern from `#schedule-frequency-input`
  (line 70) and `#schedule-day-input` (line 79).
- `src\lambda\calendar\frontend\settings.js`
  - `detectTimezone()` (line 441) — the browser-zone fallback; keep it and its
    injectable override `options.detectTimezone` (line 693), which the tests use.
  - `fillForm` (line 950) — where the stored zone is put into the control.
  - `readForm` (line 919) — where it is read back out.
  - `buildSettingsPayload` (line 411) and `buildSchedulePayload` (line 432) —
    both already send `timezone`; neither should need changing.
  - `FIELD_ERROR_IDS` (line 98) — already maps `timezone -> error-timezone`.
  - Read the module docblock (lines 15-57) first: **rule 2** (the server is the
    source of truth for validation, and no client rule is ever stricter) and
    **rule 3** (no markup assignment, ever) both bear directly on this change.
- `src\lambda\calendar\backend\settings.mjs`
  - `validateSchedule` (line 1077), timezone branch at lines 1110-1116 — the
    shape-only check to replace.
  - `TIMEZONE_PATTERN` (line 468) and `MAX_TIMEZONE_LENGTH` (line 471) — the
    constants that check uses today.
  - `SETTINGS_FIELDS` (line 105) — already includes `timezone`, so it is already
    projected back to the page.
- `src\lambda\calendar\backend\scan-schedule.mjs`
  - `isValidTimezone` (line 131) — the real tz-database check to reuse.
  - `validateScheduleInput` (line 163), timezone branch at lines 190-194 — the
    behaviour `settings.mjs` should match.
  - `putScanSchedule` (line 304) — `ScheduleExpressionTimezone` at line 324; the
    zone is honoured here and this is the code path that makes the feature real.
  - Module docblock TIMEZONE note (lines 24-30) — do not reopen.
- `src\lambda\calendar\backend\connections.mjs` — `timezone` is in the public
  attribute allow-list (line 62); no change expected.
- Tests that already touch `timezone-input` or `detectTimezone` and must keep
  passing (and are the natural homes for new coverage):
  - `tests\unit\task-057-processing-jobs-ui.test.js` (lines 100, 158, 424, 1077)
  - `tests\unit\task-053-school-names.test.js` (lines 582, 601)
  - `tests\e2e\calendar-frontend-flow.test.js` (lines 235, 1440)
  - `tests\e2e\task-057-processing-jobs-flow.test.js` (line 160)
  - `tests\unit\calendar-settings.test.js` (lines 618-657) — the existing
    `validateSchedule` timezone cases; the "special chars" rejection must still
    pass and new "shape-valid but not a real zone" cases belong here.
  - `tests\e2e\calendar-settings-routes.test.js` — route-level schedule coverage.
- Note: `tests\unit\calendar-frontend-timezone.test.js` and
  `tests\e2e\calendar-frontend-timezone.test.js` are about **all-day event
  rendering** across zones (TASK-010), not this setting. Unrelated — do not
  change them.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
