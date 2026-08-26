---
id: TASK-046
title: Neither blocklist tier knows any Australian ISP or portal consumer host
status: done
created: 2026-08-18T06:35:00.000Z
updated: 2026-08-18T11:40:00.000Z
activities: [{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T10:35:00.000Z","finishedAt":"2026-08-18T10:50:00.000Z","tokensIn":61046,"note":"GREEN 147/147 (132 unit + 15 e2e), 403ms. All 8 AU hosts refused at route level with the domain named; stmarys/mail.stmarys/stbedes.vic/example.qld .edu.au all 200. Mutations EXECUTED on 3 entries: bigpond.com -> 5 red, optusnet.com.au -> 5 red, internode.on.net -> 7 red, each restored to 147. VERIFIED the coder ordering claim in code: exact match at :339 precedes registrableName at :341, and added a test that fails if reversed. All 7 dictionary-word brands still accepted under .edu.au, so TASK-032 behaviour is preserved"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T11:25:00.000Z","finishedAt":"2026-08-18T11:40:00.000Z","tokensIn":37536,"note":"VERDICT ACCEPT, all 5 AC met (read-only reviewer, disclosed). Confirmed the two-tier design did not regress and nothing AU was smuggled into the brand tier. Subdomains: mail.bigpond.com and webmail.optusnet.com.au are ACCEPTED and that is correct - ISP consumer mailboxes only exist at the apex, so those are not addresses a parent can own; matches the deliberate mail.gmail.com precedent, and it recommended NOT raising it. Pinning at 46 entries scales: module-not-in-test closed by a filter+deepEqual, test-not-in-module by the per-entry loop, and the length check is the only thing that catches a DUPLICATE entry, so it is not a restatement. 2 findings -> TASK-107 (telstra.com is the largest remaining miss, plus ozemail/westnet/adam/y7mail.com.au - and it argued AGAINST optus.com.au/iinet.com.au/aussiebroadband/spin with reasons) and TASK-108 (the new docblock paragraph justifies a design choice by ticket process, embeds a recommendation belonging in a ticket, and contradicts the brand-tier docblock on aol/zoho)"}]
review-of: TASK-032
severity: medium
---

## Description
TASK-032's whole framing is that "this is an Australian deployment — the `au`
tenant, `receptionhq.com.au` — so those are exactly the hosts a local user would
type." It closed the Microsoft and Yahoo `.com.au` variants but left the
Australian ISP and portal mailboxes untouched.

Neither tier in `src/lambda/calendar/backend/settings.mjs:109-156` knows:

- `bigpond.com`, `bigpond.net.au` — Telstra, the largest legacy consumer mail
  domain in Australia
- `optusnet.com.au`
- `y7mail.com` — Yahoo7 AU; note its registrable name is `y7mail`, which is not
  in `PUBLIC_MAIL_BRANDS`, so the brand check cannot catch it
- `iinet.net.au`, `tpg.com.au`, `internode.on.net`, `dodo.com.au`

The brand check offers no help here: none of these registrable names is a listed
brand, so only the exact list can refuse them.

## Impact If Not Fixed
The highest-probability local miss for this tenant stays open. An Australian
parent — especially an older one — is more likely to own a Bigpond or Optusnet
mailbox than an `outlook.com.au` one, and pointing the scanner at it pushes their
entire personal inbox through the Anthropic API on every scheduled scan, with the
same privacy exposure and per-scan token cost the blocklist exists to prevent.

## Acceptance Criteria
- [ ] `bigpond.com`, `bigpond.net.au`, `optusnet.com.au`, `y7mail.com`, `iinet.net.au`, `tpg.com.au`, `internode.on.net` and `dodo.com.au` are each refused with a 400 naming the domain.
- [ ] Genuine Australian school domains (`stmarys.edu.au`, `mail.stmarys.edu.au`, `*.vic.edu.au`, `*.qld.edu.au`) are unaffected.
- [ ] Every added entry is individually pinned: removing any one reddens at least one test, verified by applying the mutation and confirming it applied.
- [ ] The AU-specific rationale is documented alongside the entries so a later reader does not prune them as noise.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Australian consumer mailboxes cannot be used as a school domain
  Scenario Outline: An AU ISP or portal host is refused
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 400
    And the error message names "<domain>"
    Examples:
      | domain            |
      | bigpond.com       |
      | bigpond.net.au    |
      | optusnet.com.au   |
      | y7mail.com        |
      | iinet.net.au      |
      | tpg.com.au        |

  Scenario Outline: Australian school domains are unaffected
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 200
    Examples:
      | domain                |
      | stmarys.edu.au        |
      | mail.stmarys.edu.au   |
      | stbedes.vic.edu.au    |
```

## Additional Context
