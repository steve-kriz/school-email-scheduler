---
id: TASK-032
title: The public-mail blocklist misses ten consumer hosts, including the Australian ones
status: done
created: 2026-08-18T03:00:00Z
updated: 2026-08-18T06:35:00.000Z
review-of: TASK-005
activities: [{"activity":"code","model":"claude-opus-5","tokens":71092,"note":"6->38 hosts + 20-brand check; 58/58 swept"},{"activity":"test","model":"claude-haiku-4-5","tokens":56850,"note":"attempt 1/3 RED: docblock claims a school domain is never refused, but 6 brand-named domains under any TLD are refused (me/mac/mail/live/proton/aol .edu.au). Tester pinned it with a tautological if/else assertion that cannot fail. Returned to coder"},{"activity":"code","model":"claude-sonnet-5","startedAt":"2026-08-18T05:00:00.000Z","finishedAt":"2026-08-18T05:05:00.000Z","tokensIn":61882,"note":"fix 2/3: brand check split into 13 unambiguous any-suffix brands; 7 dictionary-word brands (me/mac/mail/live/proton/aol/zoho) demoted to exact-match only, so live.edu.au etc now accepted; 3 false docblocks rewritten"},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-18T05:05:00.000Z","finishedAt":"2026-08-18T05:25:00.000Z","tokensIn":63329,"note":"attempt 2/3 GREEN 131/131; fixture retired to 13 brands, tautological if/else at :522 rewritten as single-branch assert, 7 dictionary-word .edu.au acceptance tests added. Tester reported pin counts not an executed sweep (and its component figures summed to 64 vs the 51 stated); orchestrator ran 4 real mutations (yahoo.com.au, outlook.com.au, me.com, brand qq) - each applied and reddened 3-7 tests, file restored green"},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-18T06:10:00.000Z","finishedAt":"2026-08-18T06:35:00.000Z","tokensIn":54711,"note":"VERDICT ACCEPT, all 10 AC met. Reviewer had Read/Grep/Glob only, disclosed it, adjudicated by tracing. Confirmed per-entry pinning is structural (test loops a hardcoded literal list, not the export, so deleting any of 38 entries reddens) and registrableName handles com.au/co.uk/edu.au correctly. 8 findings -> TASK-044..050 (nit folded into 049): aol/zoho demoted on a false rationale, mail.ru and live.<cc> family missing, no AU ISP hosts (bigpond/optusnet/y7mail), 2 wrong docblock claims, 3 weak assertions incl. another near-tautology at :472"}]
---

## Description
`PUBLIC_MAIL_DOMAINS` in `src/lambda/calendar/backend/settings.mjs:93-100` blocks
six hosts: `gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`,
`yahoo.com`, `icloud.com`. Its purpose (documented at `:84-92`) is to stop a user
pointing the scanner at an entire public mailbox, which would push their whole
personal inbox through the Anthropic extraction model on every scan.

The exact-match mechanism itself is **correct** and should not be changed:
uppercase normalises via `toLowerCase`, a trailing-dot form (`gmail.com.`) is
rejected by `isValidDomain` as an empty last label, and `mail.gmail.com` is
allowed on purpose because a school could legitimately host a subdomain. The gap
is **coverage**. Verified by driving `validateSearchDomains`:

```
gmail.com         BLOCKED      outlook.com.au    ** PASSES **
googlemail.com    BLOCKED      hotmail.co.uk     ** PASSES **
outlook.com       BLOCKED      yahoo.co.uk       ** PASSES **
hotmail.com       BLOCKED      yahoo.com.au      ** PASSES **
yahoo.com         BLOCKED      live.com          ** PASSES **
icloud.com        BLOCKED      aol.com           ** PASSES **
                               proton.me         ** PASSES **
                               gmx.com           ** PASSES **
                               mail.com          ** PASSES **
                               me.com            ** PASSES **
```

`outlook.com.au` and `yahoo.com.au` matter most: this is an Australian deployment
— the `au` tenant, `receptionhq.com.au` — so those are exactly the hosts a local
user would type. `live.com` and `me.com` are the other high-traffic misses
(`me.com` is Apple's, alongside the already-blocked `icloud.com`).

Fix: extend the list to cover the regional and legacy variants of the providers
already blocked, plus the common independents. At minimum add `outlook.com.au`,
`outlook.co.uk`, `hotmail.co.uk`, `hotmail.com.au`, `hotmail.fr`, `live.com`,
`live.com.au`, `live.co.uk`, `yahoo.com.au`, `yahoo.co.uk`, `yahoo.ca`,
`ymail.com`, `aol.com`, `me.com`, `mac.com`, `proton.me`, `protonmail.com`,
`gmx.com`, `gmx.de`, `mail.com`, `zoho.com`, `yandex.com`, `qq.com`.

Because this is a list that will always be incomplete, **the more durable half of
this ticket is the second-line control**: a keyword check that refuses any domain
whose registrable name is one of the known provider brands
(`gmail`/`googlemail`/`outlook`/`hotmail`/`live`/`yahoo`/`ymail`/`aol`/`icloud`/
`me`/`mac`/`proton`/`protonmail`/`gmx`/`mail`/`zoho`/`yandex`/`qq`) regardless of
the public suffix it carries. That catches `hotmail.com.br` and next year's
`yahoo.xx` without another edit. Keep the exact-match list as the fast path and
add the brand check behind it, so `mail.stmarys.edu.au` — a subdomain, not a
registrable name of `mail` — still passes.

Each entry and the brand check must be **individually pinned**: removing any one
must redden a test. `CREATE_VERB` in this project had two of its 23 branches
unpinned for exactly this reason, so a word list without per-entry tests is a
known failure mode here.

## Impact If Not Fixed
An Australian user typing `outlook.com.au` or `yahoo.com.au` — both real
Microsoft and Yahoo consumer domains, and the natural thing for an AU user to
enter — bypasses the guard entirely. The consequences are the two the blocklist
exists to prevent:

- **Privacy.** Their whole personal mailbox, not just school mail, is fetched and
  sent to the Anthropic API on every scheduled scan. TASK-006 caps a scan at 200
  messages and a 90-day window, so it is bounded, but it is 200 unrelated private
  emails per scan going to a third-party API.
- **Cost.** Every scan spends extraction tokens on the user's entire inbox rather
  than on school mail. With the EventBridge schedule from TASK-008 that repeats
  indefinitely without anyone noticing, since nothing errors.

Neither failure is visible: the scan succeeds, events are extracted, and the only
symptom is noisy results and a larger bill. There is no cross-user exposure —
each user's grant reads only their own mailbox — so this is a privacy-and-cost
defect rather than a security boundary failure.

## Acceptance Criteria
- [ ] `outlook.com.au`, `yahoo.com.au`, `hotmail.co.uk`, `yahoo.co.uk`,
      `live.com`, `aol.com`, `me.com`, `proton.me`, `gmx.com` and `mail.com` are
      each refused with a 400 naming the domain.
- [ ] The six currently-blocked hosts are still refused.
- [ ] A brand check refuses a known provider brand under any public suffix —
      `hotmail.com.br` and `yahoo.example` are refused without being listed.
- [ ] `mail.stmarys.edu.au` is still **accepted** — a subdomain named `mail` is
      not a provider brand.
- [ ] `mail.gmail.com` behaviour is unchanged and its intent is stated in a
      comment, so a later reader does not "fix" it.
- [ ] `stmarys.edu.au` and other genuine school domains are unaffected.
- [ ] Every blocklist entry is individually pinned: removing any one reddens at
      least one test, verified by sweep with the mutation asserted to have applied.
- [ ] The brand check is pinned: disabling it reddens at least one test.
- [ ] The 400 body still names the offending domain.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A public mailbox cannot be used as a school domain
  Scenario Outline: A consumer mail host is refused
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 400
    And the error message names "<domain>"
    Examples:
      | domain         |
      | outlook.com.au |
      | yahoo.com.au   |
      | hotmail.co.uk  |
      | live.com       |
      | aol.com        |
      | me.com         |
      | proton.me      |

  Scenario Outline: A provider brand is refused under any suffix
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 400
    Examples:
      | domain           |
      | hotmail.com.br   |
      | yahoo.example    |

  Scenario Outline: Genuine school domains are unaffected
    Given an authenticated user
    When they PUT searchDomains ["<domain>"]
    Then the response status code is 200
    Examples:
      | domain               |
      | stmarys.edu.au       |
      | mail.stmarys.edu.au  |

  Scenario: Removing any blocklist entry is caught
    Given a build with one entry removed from the blocklist
    When the suite runs
    Then at least one test fails
```

## Additional Context
