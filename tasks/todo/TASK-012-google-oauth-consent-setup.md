---
id: TASK-012
title: Google OAuth client setup runbook and restricted-scope verification path
status: testing
created: 2026-08-18T09:00:00Z
updated: 2026-08-18T00:00:54Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-17T23:50:32Z","finishedAt":"2026-08-17T23:57:42Z","tokens":63761,"note":"built in worktree; salvaged by file copy"}]
---

## Description
`https://www.googleapis.com/auth/gmail.readonly` is a Google **restricted**
scope. Nothing in TASK-001..011 covers the Google-side configuration the OAuth
flow depends on, and the constraints are load-bearing enough to block launch:

- An **unverified** app requesting a restricted scope is capped at **100
  distinct users** and shows an "Google hasn't verified this app" interstitial
  before consent. Fine for dev and a pilot; fatal for general release.
- Production use of a restricted scope requires **OAuth app verification** plus
  an annual **CASA security assessment**, and the app must comply with Google's
  **Limited Use** requirements — which include letting the user revoke access
  and have their data deleted (that endpoint is TASK-013).
- Each tenant/environment pair is a **different redirect URI**, because the
  callback is derived from `PUBLIC_BASE_URL` per TASK-004. Every one must be
  registered on the OAuth client or the callback fails with
  `redirect_uri_mismatch`.

This ticket produces the written runbook and an automated config preflight. It
does **not** perform Console clicks — those are a human step the runbook
describes.

Deliverables:

**`docs/google-oauth-setup.md`** — a runbook covering, in order:
1. Google Cloud project selection and enabling the **Gmail API**.
2. OAuth consent screen configuration: app name, support email, publisher
   domain, the scope list (`openid`, `email`, `profile`,
   `gmail.readonly`), and the privacy-policy and terms URLs verification
   requires.
3. Creating the **Web application** OAuth client, and the full redirect-URI
   matrix — one row per tenant/environment, each
   `https://calendar.<hosted_zone>/calendar/api/auth/google/callback`, derived
   from the `hosted_zone` values in `terraform/config/**/*.tfvars`. Include
   `http://localhost:<port>/calendar/api/auth/google/callback` for local work
   and note that Google permits `http` only for `localhost`.
4. Populating the Secrets Manager secret
   `${environment}-${tenant}/app-config/school_calendar_services` with
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
   `ANTHROPIC_API_KEY`, `ALLOWED_ORIGINS` — as an `aws secretsmanager
   put-secret-value` command whose JSON values are **placeholders**, never real
   credentials.
5. The verification path: the 100-user unverified cap, what triggers a
   verification review, the CASA assessment cadence, and the Limited Use
   obligations — with a pointer to TASK-013 as the revoke/delete implementation.
6. A troubleshooting table for the failures this setup actually produces:
   `redirect_uri_mismatch`, `access_denied`, `admin_policy_enforced` (Workspace
   admin has blocked the app), and a missing `refresh_token` in the token
   response (cause: `prompt=consent` or `access_type=offline` omitted — both
   are set in TASK-004, so this means a regression).

**`scripts/check-oauth-config.mjs`** — a preflight run as
`npm run check:oauth-config -- --env dev --tenant au`. It reads the app-config
secret for that env/tenant, and reports **key presence and shape only**:
- Every required key present and non-empty.
- `GOOGLE_CLIENT_ID` ends with `.apps.googleusercontent.com`.
- `SESSION_SECRET` decodes to at least 32 bytes of entropy.
- `ANTHROPIC_API_KEY` starts with `sk-ant-`.
Exit `0` when every check passes, `1` otherwise, printing one line per check.
**It must never print, log, or otherwise emit a secret value** — not even a
prefix or a truncation, which is still key material. Report presence, length
and the pass/fail verdict only. Add the `check:oauth-config` script to the root
`package.json`.

## Acceptance Criteria
- [ ] `docs/google-oauth-setup.md` exists and covers all six numbered sections
      above.
- [ ] The runbook lists one redirect URI per tenant/environment, each matching
      `https://calendar.<hosted_zone>/calendar/api/auth/google/callback` with the
      `hosted_zone` values taken from the tfvars files.
- [ ] The runbook includes a `localhost` redirect URI and notes that `http` is
      permitted only for localhost.
- [ ] The runbook states the 100-user unverified cap and that a restricted
      scope requires verification plus a CASA assessment for production.
- [ ] The runbook names the Limited Use revoke/delete obligation and points at
      TASK-013.
- [ ] The runbook's troubleshooting table covers `redirect_uri_mismatch`,
      `access_denied`, `admin_policy_enforced`, and a missing `refresh_token`.
- [ ] No real client id, client secret, API key, or session secret appears
      anywhere in the runbook — only clearly-marked placeholders.
- [ ] `scripts/check-oauth-config.mjs` exits `0` when every required key is
      present and well-formed.
- [ ] It exits `1` and names the offending key when a required key is missing.
- [ ] It exits `1` when a required key is present but empty.
- [ ] It exits `1` when `GOOGLE_CLIENT_ID` does not end with
      `.apps.googleusercontent.com`.
- [ ] It exits `1` when `SESSION_SECRET` carries under 32 bytes of entropy.
- [ ] It exits `1` when `ANTHROPIC_API_KEY` does not start with `sk-ant-`.
- [ ] Its output contains no secret value, prefix, or truncation — only key
      names, byte lengths, and verdicts.
- [ ] `npm run check:oauth-config` is defined in the root `package.json`.
- [ ] The Secrets Manager call is mocked in tests; no test reads a real secret.

## Cucumber Tests
```gherkin
Feature: Google OAuth configuration preflight
  Scenario: A fully configured environment passes
    Given a secret containing every required key, well-formed
    When the preflight runs for env "dev" tenant "au"
    Then it exits with status 0

  Scenario: A missing key is named
    Given a secret with no "GOOGLE_CLIENT_SECRET" key
    When the preflight runs
    Then it exits with status 1
    And the output names "GOOGLE_CLIENT_SECRET"

  Scenario: An empty key is treated as missing
    Given a secret where "SESSION_SECRET" is an empty string
    When the preflight runs
    Then it exits with status 1

  Scenario Outline: Malformed credentials are caught before deploy
    Given a secret where "<key>" is "<value>"
    When the preflight runs
    Then it exits with status 1
    Examples:
      | key                | value                  |
      | GOOGLE_CLIENT_ID   | 12345                  |
      | ANTHROPIC_API_KEY  | not-an-anthropic-key   |
      | SESSION_SECRET     | short                  |

  Scenario: The preflight never leaks key material
    Given a secret where GOOGLE_CLIENT_SECRET is "GOCSPX-super-secret-value"
    When the preflight runs
    Then the output does not contain "GOCSPX-super-secret-value"
    And the output does not contain "GOCSPX"

  Scenario: Every deployed environment has a registered callback
    Given the runbook redirect URI table
    And the terraform tfvars files
    Then every tenant and environment pair in tfvars appears in the table

  Scenario: The runbook carries no real credentials
    Given the file "docs/google-oauth-setup.md"
    Then it contains no value matching a Google client secret pattern
    And it contains no value matching an Anthropic API key pattern
```

## Additional Context
