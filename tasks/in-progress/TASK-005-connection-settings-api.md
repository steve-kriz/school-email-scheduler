---
id: TASK-005
title: Connection settings API for school name and search domains
status: done
created: 2026-08-17T11:00:00Z
updated: 2026-08-18T03:00:22Z
depends-on: TASK-004
activities: [{"activity":"code","model":"claude-opus-5","tokens":102248,"note":"settings.mjs + routes; scope extended into connections.mjs with cause"},{"activity":"test","model":"claude-haiku-4-5","tokens":90613,"note":"153 tests; 3 hazards mutation-verified"},{"activity":"review","model":"claude-opus-4-8","tokens":46164,"note":"no critical/high in executable code. Read TASK-007 and TASK-010 and found the raw-storage obligations settings.mjs documents do NOT cover schoolName -> ACs added to both tickets directly. Blocklist misses 10 consumer hosts incl outlook.com.au/yahoo.com.au -> TASK-032"}]
---

## Description
Let a signed-in user tell the app which school to watch for: a display name and
one or more email domains whose senders count as school mail. These values drive
the Gmail search query (TASK-006) and the extraction prompt (TASK-007).

Depends on TASK-004 (needs `requireSession` and `connections.mjs`).

New file: `src/lambda/calendar/backend/settings.mjs`, plus routes in `index.mjs`:
- `GET /calendar/api/settings` — `200` with
  `{ email, schoolName, searchDomains, scheduleEnabled, scheduleFrequency, scheduleHour, timezone, lastScanAt, lastScanStatus }`.
  Returns the public projection only — never `refreshTokenEnc`.
- `PUT /calendar/api/settings` — accepts `{ schoolName, searchDomains }` (and
  optionally the schedule fields, which TASK-008 also writes), validates,
  persists via `updateConnection`, and returns the updated public projection.

Validation rules, all enforced server-side and all returning `400` with a
`{ error, field }` body:
- `schoolName` — required, trimmed, 1–120 characters. Reject strings that are
  empty after trimming.
- `searchDomains` — required, an array of 1–10 entries. Each entry is lowercased
  and trimmed, then must match a hostname shape: labels of
  `[a-z0-9]([a-z0-9-]*[a-z0-9])?` joined by dots, at least two labels, total
  length ≤ 253, no leading/trailing dot or hyphen. **Strip a leading `@`, a
  `*.` wildcard prefix, and any scheme or path** if the user pasted
  `https://stmarys.edu.au/` or `@stmarys.edu.au` — normalise rather than
  reject, since both are natural things to paste. Reject anything still
  invalid after normalisation.
- Reject duplicate domains after normalisation (case-insensitively) rather
  than storing them twice.
- Reject a `searchDomains` value that is a bare public mail host
  (`gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `yahoo.com`,
  `icloud.com`) — matching all of Gmail is never the intent and would send the
  user's entire mailbox through the extraction model. Return a `400` naming the
  offending domain.

The stored value is a DynamoDB string set (`searchDomains` SS). Note that
DynamoDB rejects an **empty** string set, so an update that would clear the set
must remove the attribute instead of writing `[]` — handle this explicitly.

`schoolName` and each domain are user-controlled text that later reaches both an
HTML page (TASK-010) and a model prompt (TASK-007). Store them raw here but
document that the frontend escapes on render and the prompt builder wraps them
in a delimited block — do not attempt sanitisation by stripping characters,
which corrupts legitimate names like `St Mary's`.

## Acceptance Criteria
- [ ] `GET /calendar/api/settings` returns `200` with the public projection for
      an authenticated user, and `401` with no valid session.
- [ ] `PUT /calendar/api/settings` returns `200` and the updated projection on
      a valid payload, and `401` with no valid session.
- [ ] Neither route's response body contains `refreshTokenEnc` or any token.
- [ ] A missing or whitespace-only `schoolName` returns `400` with
      `field: "schoolName"`.
- [ ] A `schoolName` longer than 120 characters returns `400`.
- [ ] An empty `searchDomains` array returns `400` with
      `field: "searchDomains"`.
- [ ] More than 10 domains returns `400`.
- [ ] `"@StMarys.EDU.au"`, `"https://stmarys.edu.au/news"` and
      `"*.stmarys.edu.au"` all normalise to `stmarys.edu.au` and are accepted.
- [ ] `"not a domain"`, `"stmarys"`, `"-bad.com"` and `"bad-.com"` each return
      `400`.
- [ ] Duplicate domains differing only by case are stored once.
- [ ] `gmail.com` (and each other public mail host in the blocklist) returns
      `400` naming the domain.
- [ ] An update that would leave `searchDomains` empty removes the attribute
      rather than writing an empty string set, and does not raise a DynamoDB
      validation error.
- [ ] Stored `schoolName` preserves apostrophes and accented characters
      unchanged (no stripping or escaping at the storage layer).
- [ ] All DynamoDB calls are mocked in tests; no test opens a real connection.

## Cucumber Tests
```gherkin
Feature: Connection settings
  Scenario: An authenticated user saves their school
    Given an authenticated user with no settings yet
    When they PUT schoolName "St Mary's Primary" and searchDomains ["stmarys.edu.au"]
    Then the response status code is 200
    And the stored schoolName is "St Mary's Primary"
    And the stored searchDomains contains exactly "stmarys.edu.au"

  Scenario: Settings are private to the session
    Given no session cookie
    When "/calendar/api/settings" is requested
    Then the response status code is 401

  Scenario Outline: Pasted domain forms are normalised, not rejected
    Given an authenticated user
    When they PUT searchDomains ["<input>"]
    Then the response status code is 200
    And the stored searchDomains contains exactly "stmarys.edu.au"
    Examples:
      | input                         |
      | stmarys.edu.au                |
      | @StMarys.EDU.au               |
      | https://stmarys.edu.au/news   |
      | *.stmarys.edu.au              |

  Scenario Outline: Malformed domains are refused
    Given an authenticated user
    When they PUT searchDomains ["<input>"]
    Then the response status code is 400
    And the error field is "searchDomains"
    Examples:
      | input       |
      | not a domain |
      | stmarys      |
      | -bad.com     |
      | bad-.com     |

  Scenario: Matching an entire public mailbox is refused
    Given an authenticated user
    When they PUT searchDomains ["gmail.com"]
    Then the response status code is 400
    And the error message names "gmail.com"

  Scenario: An empty school name is refused
    Given an authenticated user
    When they PUT schoolName "   " and searchDomains ["stmarys.edu.au"]
    Then the response status code is 400
    And the error field is "schoolName"

  Scenario: Clearing the domain list does not write an empty string set
    Given an authenticated user with one stored domain
    When an update leaves searchDomains empty
    Then the searchDomains attribute is removed from the item
    And no DynamoDB validation error is raised

  Scenario: Duplicate domains collapse
    Given an authenticated user
    When they PUT searchDomains ["stmarys.edu.au", "StMarys.edu.au"]
    Then the stored searchDomains has exactly one entry
```

## Additional Context
