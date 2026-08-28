---
id: TASK-010
title: Web UI — connect Gmail, settings, month calendar and attention list
status: done
created: 2026-08-17T11:00:00Z
updated: 2026-08-28T22:28:40.000Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-26T02:35:00.000Z","finishedAt":"2026-08-26T03:30:00.000Z","note":"DISPATCH DIED MID-WORK - not a code failure. The org monthly spend limit was reached and the agent was terminated by an API error just as it was about to verify its routes; it never reported. PARTIAL WORK IS PRESERVED AND UNCOMMITTED in the worktree C:/Projects/officehq_git/.orchestrate-wt/school-email-scheduler/TASK-010 on branch ticket/TASK-010 at base 846157d: src/lambda/calendar/index.mjs MODIFIED and src/lambda/calendar/frontend/ UNTRACKED. Nothing was verified, nothing was committed, and NO CLAIM ABOUT CORRECTNESS IS MADE. Claim released so the next run re-dispatches this column; the resuming coder should inspect that worktree first rather than starting over. THE TASK-013 COLLISION IS STILL LIVE: TASK-013 independently created frontend/settings.html and frontend/settings.js on its own branch, so two versions of those two files must be reconciled at merge. No tokens/cost recorded - the run was truncated"},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-28T21:27:00.000Z","finishedAt":"2026-08-28T21:43:00.000Z","note":"RESUMED the dispatch killed by the spend limit rather than restarting. The salvaged uncommitted work was substantively correct and nearly all of it was KEPT, but it had never been EXECUTED, so every AC was re-verified by running it; no code defects were found and the two failures hit were bugs in the coder own throwaway fixtures. Committed ecce67d at base 846157d. index.mjs +186: FRONTEND_FILES frozen filename->content-type, FRONTEND_ROUTES 9 exact paths->filename, FRONTEND_CSP, readFrontendFile and routeFrontendRequest dispatched LAST in handler so no static path can shadow an API route. New frontend/index.html, app.js (1310 lines, pure helpers exported and document/fetch/clock/timers injectable), settings.html, settings.js, styles.css (no @import, no url(), no web fonts). CACHE PROVEN BEHAVIOURALLY not by inspection: exactly 5 disk reads occurred, one per file, none outside frontend/, and a second pass over every asset added ZERO reads. TRAVERSAL PROVEN ACROSS 7 FORMS: ../../etc/passwd, %2e%2e%2f, ..%2f, uppercase-encoded, /CALENDAR/APP.JS, /calendar/frontend/app.js and POST /calendar/app.js all 404. Hostile title AND hostile schoolName both render as literal text with no IMG element created anywhere. Date-only handling verified in Denver, LA, UTC, London, Kolkata, Sydney and Kiritimati, after confirming against the backend that a date-only startsAt is stored as T00:00:00.000Z with allDay true (normaliseInstant, events.mjs:445) so the client slices the string and never converts. Mid-session 401 re-renders connect, clears the timer and sends ZERO further requests even when a stray timer tick fires. Token/cost telemetry not correlated; 143802 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-28T21:45:00.000Z","finishedAt":"2026-08-28T21:55:02.000Z","note":"RECONCILIATION dispatch: resolved the TASK-013 add/add collision on frontend/settings.html and settings.js after the orchestrator merged master into this branch. Committed ef1b640, working tree clean, no conflict markers, master untouched. index.mjs had already AUTO-merged cleanly (this ticket static routes plus TASK-013 disconnect route). THE UNION WAS TAKEN, NOT A CHOICE: TASK-013 block was spliced in and then DIFFED AGAINST MASTER TO PROVE IT IS BYTE-IDENTICAL - no reimplementation, no silent weakening. All 21 exports present (TASK-013 8 plus this ticket 13) with no name collisions, both setStatus being function-scoped. The two bootstraps were merged into ONE block still guarded on data-page settings: TASK-013 original guard was only a typeof document check, so folding it into the data-page guard is what prevents a second bootstrap while keeping the module inert under node --test. In the HTML their section and its comment were inserted VERBATIM, re-indented one level only, and their input markup was deliberately NOT touched because their test slices from id=disconnect-events-keep to the next > and requires checked inside that window, so any attribute reordering would break it. CONTRACT HELD: TASK-013 106/106 still pass. Static routes and traversal re-verified after the index.mjs auto-merge, still exactly 5 disk reads and zero on the second pass. Full suite 2123 of 2125, the 2 being the known baseline failures reproduced on untouched base 846157d beforehand. settings.js contains zero .innerHTML. VERIFIED THE UNION NEITHER TICKET TESTS COVER: both halves on ONE document - settings form still loads, fills and surfaces its field-level 400; the disconnect gate still fails closed, switches phrase on choice change, clears typed text and posts credentials same-origin; a settings save does not clobber the disconnect status or submit state. Token/cost telemetry not correlated; 182889 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-28T21:45:00.000Z","finishedAt":"2026-08-28T22:28:40.000Z","note":"GREEN. Suite 2310 tests 2303 pass 3 fail 4 skipped; the 3 are the pre-existing baseline only. Committed c81bc06, src/ byte-identical to ef1b640 so no product code was quietly changed to make tests pass. Delivered 93 e2e and 92 unit tests plus a new shared harness tests/helpers/fake-dom.mjs. HARNESS QUALITY: the fake DOM parses the REAL frontend/index.html and settings.html rather than a hand-built fixture, so a renamed id turns scenarios red; dispatch() awaits handlers (the async-handler phantom-failure trap the coder warned about); and textContent never parses markup, so the XSS scenarios prove NO ELEMENT WAS CREATED rather than that a string merely looks escaped. PROVEN BEHAVIOURALLY NOT BY SHAPE: 16 hostile paths through the real handler including %2e%2e%2f, ..%2f, ..%252f, uppercase-encoded, /CALENDAR/APP.JS, /calendar/frontend/app.js and POST/PUT/DELETE to an asset path, all 404 WITH THE READ LIST ASSERTED deepEqual EMPTY, not merely on status; every read path across all 9 routes asserted to be a member of a fixed 5-element literal set, and readFrontendFile refuses __proto__/constructor/traversal names with zero readFile calls; fileCache proven by exact counts, 5 reads on the first pass over 9 routes and EXACTLY 0 across three further passes; innerHTML and secret scans run on the BODIES THE HANDLER ACTUALLY SERVED, not the files on disk; the Denver criterion sets process.env.TZ IN-PROCESS BEFORE the dynamic import and asserts getTimezoneOffset()===360 so it cannot pass in the host zone, with a timed 02:00Z control event that still lands on the 3rd; the mid-session 401 asserts clearInterval was called with the REAL timer id and that two stray ticks plus a direct refreshAll() produce ZERO further requests. ANTI-VACUITY PROVEN BY SIX EXECUTED PRODUCT-CODE MUTATIONS, each caught then reverted: cache disabled 6 red, filename built from request path 5 red, allowlist guard removed 2 red, date-only converted through Date 8 red, credentials dropped 6 red, 401 not stopping the timer 1 red. TASK-013 contract held at 106/106, plus new union coverage that neither ticket had. BASELINE CORRECTED HONESTLY: the stable baseline is 3 failures, not 2 - the third is task-038-deployment-packaging.test.js asserting git ignores src/lambda/calendar/node_modules, which fails because the ignore pattern is directory-only and the directory does not exist in this worktree; .gitignore is unchanged vs base and it passes once deps are installed. Also reported pre-existing parallel-load flakes unrelated to this ticket (calendar-auth session-signature tests, and terraform-resolver/terraform-scaffold contending on a 30s terraform validate spawn), both reproduced in baseline runs with its own files EXCLUDED. Token/cost telemetry not correlated; 205385 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
depends-on: TASK-009
---

## Description
Serve the browser app from the same Lambda, following the chatbot's pattern in
`ohq-chatbot2/src/lambda/chatbot/index.mjs` and its `frontend/` directory:
static files read from disk on first request, cached in the module-level
`fileCache` Map, and served with the right content type.

Depends on TASK-009 (needs every API route) and TASK-008 (scan endpoints).

New files under `src/lambda/calendar/frontend/`:
- `index.html` — the shell: header, connection state, month calendar, and the
  "Needs attention" panel.
- `app.js` — all client logic. Vanilla ES modules, no build step and no CDN
  dependency (the Lambda is the only origin; a CDN `<script src>` would be an
  external dependency to review and can be blocked by the WAF).
- `styles.css`.
- `settings.html` + `settings.js` — school name and search-domain editor, plus
  the schedule controls.

Routes to add to `index.mjs`, matching how the chatbot serves `widget.js` and
its admin pages:
- `GET /calendar` and `/calendar/` → `index.html`
- `GET /calendar/settings` and `/calendar/settings.html` → `settings.html`
- `GET /calendar/app.js`, `/calendar/settings.js`, `/calendar/styles.css` →
  the corresponding files with `application/javascript` / `text/css`
Serve only from an explicit allowlist map of path → filename. Do **not** build a
filesystem path by concatenating any part of the request path — that is a path
traversal (`/calendar/../../../etc/passwd`), and an allowlist eliminates the
class of bug rather than trying to filter it.

Behaviour:
- On load, call `GET /calendar/api/auth/me`. When it returns `401`, render a
  "Connect your Gmail account" state whose button navigates to
  `/calendar/api/auth/google/start`. When it returns `200` but `schoolName` is
  unset, render a "Tell us your school" prompt linking to settings.
- When `lastScanStatus` is `reauth_required`, show a "Reconnect Gmail" banner
  rather than an empty calendar — a silently blank month after a revoked grant
  is the worst failure mode here.
- Month grid: weeks as rows, day cells showing event chips ordered by start
  time, an all-day band, previous/next month navigation that refetches
  `GET /calendar/api/events` for the new range, and a "Today" button. Highlight
  today's cell. A day with more events than fit shows a "+N more" affordance
  that opens the day's list.
- Clicking an event opens a detail panel showing title, time, location,
  description, category, the source subject and sender, and — when
  `needsAttention` — the action required, the deadline, and Acknowledge /
  Dismiss buttons wired to TASK-009's routes.
- "Needs attention" panel: renders `GET /calendar/api/events/upcoming`, soonest
  first, with overdue items visually distinguished (not by colour alone — pair
  it with a text label, so the state survives colour-blindness and greyscale).
  Acknowledging removes the row optimistically and restores it if the request
  fails.
- "Scan now" button: `POST /calendar/api/scan`, disabled with a progress state
  while in flight, then refresh both views. On `409` show "a scan is already
  running". On `truncated` tell the user the scan was capped and more mail
  remains.
- Empty states for "no events this month" and "nothing needs attention" that
  read as success, not as errors.

Security and correctness requirements:
- **Escape every value that came from an email.** Titles, descriptions,
  locations, sender names and subjects are attacker-influenced. Build DOM with
  `textContent` / `createElement`, never `innerHTML` with interpolated data.
  There must be no `innerHTML =` assignment anywhere that includes a value from
  an API response.
- Render dates in the user's local timezone; treat a date-only `startsAt`
  (no time component) as all-day and do **not** apply a timezone shift to it,
  or an event lands on the wrong day for users west of UTC.
- Send `credentials: "same-origin"` on every fetch so the session cookie is
  attached, and handle a mid-session `401` by re-rendering the connect state
  rather than looping on failed requests.
- No API key, client secret, or token is present in any served file.

## Acceptance Criteria
- [ ] `GET /calendar` returns `200` and `text/html`.
- [ ] `GET /calendar/app.js` returns `200` with
      `application/javascript`, and `/calendar/styles.css` with `text/css`.
- [ ] Static file resolution uses an explicit allowlist map; no filesystem path
      is built from request-path input.
- [ ] `GET /calendar/../../etc/passwd` and
      `GET /calendar/%2e%2e%2f%2e%2e%2fetc%2fpasswd` both return `404` and read
      no file outside `frontend/`.
- [ ] Files are read once and served from `fileCache` on subsequent requests.
- [ ] With no session, the page renders a "Connect your Gmail account" action
      pointing at `/calendar/api/auth/google/start`.
- [ ] With a session but no `schoolName`, the page prompts for school setup and
      links to settings.
- [ ] When `lastScanStatus` is `reauth_required`, a reconnect banner is shown.
- [ ] The month grid renders one cell per day of the displayed month with event
      chips ordered by start time, and highlights today.
- [ ] Previous/next month navigation refetches events for the new range, and
      "Today" returns to the current month.
- [ ] A day with more events than fit shows a "+N more" control that reveals
      the rest.
- [ ] Clicking an event opens a detail panel showing time, location,
      description, category, source subject and sender.
- [ ] An event with `needsAttention` shows its action required, deadline, and
      working Acknowledge and Dismiss buttons.
- [ ] The attention panel lists upcoming items soonest-first and marks overdue
      items with a text label, not by colour alone.
- [ ] Acknowledging removes the row optimistically and restores it on failure.
- [ ] "Scan now" disables itself while in flight, then refreshes both views.
- [ ] A `409` from the scan endpoint shows "a scan is already running".
- [ ] A `truncated` scan result tells the user more mail remains.
- [ ] Empty months and an empty attention list render success-toned empty
      states, not error text.
- [ ] No served file contains an `innerHTML =` assignment that includes a value
      from an API response.
- [ ] A stored `schoolName` of `<img src=x onerror=alert(1)>` renders as literal
      text on the settings page and on the setup prompt.
      (From the TASK-005 review: this ticket scoped its escape rule to "every
      value that came from an email", and its only concrete XSS criterion tested
      an event title. `schoolName` comes from settings, not an email, so an
      implementer reading the rule as email-scoped would render it unescaped.
      Self-XSS only — same authenticated user — but the storage layer documents
      this escaping as its mitigation, so it must be pinned here.)
- [ ] An event whose title is `<img src=x onerror=alert(1)>` renders as literal
      text and executes no script.
- [ ] A date-only `startsAt` renders on that calendar date with no timezone
      shift, verified for a UTC-negative local timezone.
- [ ] Every fetch sends `credentials: "same-origin"`.
- [ ] A `401` mid-session re-renders the connect state and stops further polling.
- [ ] No served file contains an API key, client secret, or token.
- [ ] The settings page saves school name and domains through
      `PUT /calendar/api/settings` and surfaces a field-level `400` message.

## Cucumber Tests
```gherkin
Feature: Calendar web interface
  Scenario: A new visitor is asked to connect Gmail
    Given no session cookie
    When the calendar page is opened
    Then a "Connect your Gmail account" action is shown
    And it points at "/calendar/api/auth/google/start"

  Scenario: A connected user without a school is prompted to set one
    Given an authenticated user with no schoolName
    When the calendar page is opened
    Then a school setup prompt is shown

  Scenario: A revoked grant is explained rather than shown as an empty month
    Given the connection lastScanStatus is "reauth_required"
    When the calendar page is opened
    Then a reconnect banner is shown

  Scenario: The month grid shows the month's events
    Given events on 2026-09-04 and 2026-09-18
    When the September 2026 calendar is rendered
    Then the 4th and the 18th each show one event chip
    And today's cell is highlighted

  Scenario: Navigating months refetches the range
    Given the September 2026 calendar is displayed
    When the user clicks next month
    Then events are refetched for October 2026

  Scenario: A busy day reveals its overflow
    Given a day with 6 events and room for 3 chips
    When the day cell is rendered
    Then a "+3 more" control is shown
    And activating it reveals the remaining events

  Scenario: Opening an event shows its provenance
    Given an event extracted from an email subject "Term 3 Newsletter"
    When the event is clicked
    Then the detail panel shows "Term 3 Newsletter"

  Scenario: A parent clears an action item
    Given a pending attention event in the panel
    When the user clicks Acknowledge
    Then the row is removed from the panel
    And a request is sent to the acknowledge route

  Scenario: A failed acknowledge restores the row
    Given a pending attention event
    And the acknowledge request will fail
    When the user clicks Acknowledge
    Then the row reappears in the panel

  Scenario: Overdue items are legible without colour
    Given an attention event whose deadline has passed
    When the panel is rendered
    Then the item carries a textual overdue label

  Scenario: Scanning shows progress and refreshes
    Given an authenticated configured user
    When the user clicks "Scan now"
    Then the button is disabled while the request is in flight
    And both the calendar and attention panel refresh on completion

  Scenario: A concurrent scan is explained
    Given the scan endpoint returns 409
    When the user clicks "Scan now"
    Then a message says a scan is already running

  Scenario: A capped scan tells the user mail remains
    Given the scan result has truncated true
    When the result is rendered
    Then the user is told more mail remains unscanned

  Scenario: Email content cannot inject script
    Given an event titled "<img src=x onerror=alert(1)>"
    When the calendar renders
    Then the title appears as literal text
    And no script executes

  Scenario: All-day events do not shift across the date line
    Given an event with a date-only startsAt of 2026-09-04
    And a browser timezone of "America/Denver"
    When the calendar renders
    Then the event appears on 2026-09-04

  Scenario Outline: Static serving resists path traversal
    When "<path>" is requested
    Then the response status code is 404
    Examples:
      | path                                          |
      | /calendar/../../etc/passwd                    |
      | /calendar/%2e%2e%2f%2e%2e%2fetc%2fpasswd      |

  Scenario: A session expiring mid-use is handled
    Given an authenticated page whose session then expires
    When the next fetch returns 401
    Then the connect state is rendered
    And no further polling requests are sent

  Scenario: Secrets are never served to the browser
    Given the served frontend files
    Then none contains an API key, client secret, or token

  Scenario: Saving invalid settings shows a field error
    Given the settings page
    When the user saves searchDomains "gmail.com"
    Then a field-level error message is shown
```

## Additional Context
