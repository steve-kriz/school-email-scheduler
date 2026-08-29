# Google OAuth Client Setup Runbook

Runbook for the Google-side configuration the School Email Scheduler OAuth flow
depends on, plus the verification path required before general release.

This document describes **human steps in the Google Cloud Console and the AWS
CLI**. Nothing here is automated by Terraform: the OAuth client lives in a
Google Cloud project, not in AWS, and both the Secrets Manager secret *and* its
values are created by an operator. Terraform only ever **reads** that secret —
it does not create the secret and it never writes credentials into it, so the
secret must already exist and hold a version before the first `terraform apply`.
[Section 4](#4-populating-the-secrets-manager-secret) covers both the create and
the populate step.

The automated half of this ticket is the preflight described in
[Section 7](#7-preflight-verifying-the-configuration) — run it after Section 4
and before any deploy.

## Table of Contents

1. [Google Cloud project and the Gmail API](#1-google-cloud-project-and-the-gmail-api)
2. [OAuth consent screen](#2-oauth-consent-screen)
3. [OAuth client and the redirect URI matrix](#3-oauth-client-and-the-redirect-uri-matrix)
4. [Populating the Secrets Manager secret](#4-populating-the-secrets-manager-secret)
5. [Restricted scope: verification, CASA, and Limited Use](#5-restricted-scope-verification-casa-and-limited-use)
6. [Troubleshooting](#6-troubleshooting)
7. [Preflight: verifying the configuration](#7-preflight-verifying-the-configuration)

---

## Why this is more than a checklist

The app requests `https://www.googleapis.com/auth/gmail.readonly`. Google
classifies that as a **restricted** scope — the strictest of its three scope
tiers — because it grants read access to the full contents of a user's mailbox.
Three consequences drive everything below:

- **An unverified app requesting a restricted scope is capped at 100 distinct
  users**, for the lifetime of the client, and every user sees a "Google hasn't
  verified this app" interstitial before the consent screen. Workable for dev
  and a pilot; fatal for general release.
- **Production use requires OAuth app verification plus an annual CASA security
  assessment.** Both take weeks of calendar time. Start them long before the
  launch date.
- **Every tenant and environment is a separate redirect URI.** The callback URL
  is derived server-side from `PUBLIC_BASE_URL`, so each deployment produces a
  different one. Any URI not registered on the OAuth client fails the callback
  with `redirect_uri_mismatch`.
- **Since TASK-049 those URIs are not predictable from the tfvars.** The app is
  served from a Lambda function URL, so each deployment's origin is
  `https://<url-id>.lambda-url.<region>.on.aws` where AWS generates `<url-id>`
  when the function URL is created. You cannot fill the redirect URI in ahead of
  the first `terraform apply`: apply first, read the `calendar_function_url`
  output, then register that value. See Section 3.

**No credential values belong in this file, in any ticket, or in any commit.**
Every credential below is written as a clearly-marked `REPLACE_ME_*`
placeholder. Real values live only in AWS Secrets Manager.

---

## 1. Google Cloud project and the Gmail API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) signed in
   as an account that administers the organisation's Google Cloud.
2. **Select or create the project.** Use a single project for all tenants and
   environments — one OAuth client with all four redirect URIs registered, not
   four clients. Verification and the CASA assessment are done **per OAuth
   client**, so splitting clients multiplies that work by four.
   - Suggested project name: `school-calendar-services`.
   - Record the project ID; it appears in the consent screen audit trail.
3. **Enable the Gmail API.** *APIs & Services → Library → Gmail API → Enable*.
   Without this, the token exchange succeeds but every Gmail call returns
   `403 accessNotConfigured`.
4. Confirm no other API is enabled that the app does not use. Verification
   reviewers ask about every enabled API and every requested scope; an unused
   enabled API is an avoidable review question.

---

## 2. OAuth consent screen

*APIs & Services → OAuth consent screen.*

| Field | Value |
| --- | --- |
| User type | **External** (school staff sign in with their own Google accounts, which are outside our Workspace org) |
| App name | `School Email Scheduler` |
| User support email | A monitored mailbox, not a personal address — it is shown to every user on the consent screen |
| App logo | Optional, but required for a polished verified consent screen. Uploading a logo triggers a separate brand review. |
| Application home page | `<prod au function URL>calendar` — see Section 3; the origin is the `calendar_function_url` Terraform output, not a receptionhq.com host |
| Application privacy policy | `<prod au function URL>calendar/privacy` |
| Application terms of service | `<prod au function URL>calendar/terms` |
| Authorised domain | `receptionhq.com` |
| Publisher domain | `receptionhq.com` — must be verified in Google Search Console by the same account, or verification cannot start |
| Developer contact email | A monitored mailbox; Google sends verification and CASA correspondence here |

> **Known blocker for OAuth app VERIFICATION (TASK-049).** Google requires the
> home page / privacy policy / terms URLs to live on an authorised domain you own
> and have verified in Search Console. `*.lambda-url.<region>.on.aws` is an AWS
> domain, cannot be added as an authorised domain, and cannot be verified. That
> does not block development or the 100-user unverified cap — sign-in works fine
> against the function URL — but the app cannot pass verification while its only
> public origin is the raw function URL. Verification therefore needs a
> repo-owned hostname in front of the function (a custom domain), which TASK-049
> deliberately did not build.

### Scopes

Add exactly these four, and nothing more. Every extra scope widens the
verification review and the CASA assessment.

| Scope | Tier | Why it is needed |
| --- | --- | --- |
| `openid` | Non-sensitive | Issues the `id_token` the callback validates to establish identity |
| `email` | Non-sensitive | Reads the signed-in address for the session and the connection row |
| `profile` | Non-sensitive | Display name on the connection screen |
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** | Reads school newsletters and notices to extract calendar events |

`gmail.readonly` is the only restricted scope, and it is the reason Section 5
exists. Do **not** request `gmail.modify` or `https://mail.google.com/`: the app
never writes to or deletes from the mailbox, and either scope would escalate the
review without adding capability.

### Privacy policy and terms content requirements

Verification is refused if the privacy policy does not, in plain language:

- Name the application, matching the App name above exactly.
- State that the app reads Gmail message content, and for what single purpose
  (extracting school calendar events).
- State what is retained (extracted events, the encrypted refresh token, the
  Google account id and email address) and what is not (message bodies are not
  stored after extraction).
- State that data is not sold, not transferred to third parties for advertising,
  and not used to train generalised AI models.
- Describe how a user revokes access and deletes their data, and link to the
  in-app control. See [Section 5](#limited-use-obligations).

### Test users (pre-verification)

While the app is in **Testing**, only listed test users can consent. Add the
pilot school accounts here. Moving to **In production** while unverified is what
exposes the "Google hasn't verified this app" interstitial to all users and
starts the 100-user cap counting.

---

## 3. OAuth client and the redirect URI matrix

*APIs & Services → Credentials → Create credentials → OAuth client ID.*

| Field | Value |
| --- | --- |
| Application type | **Web application** |
| Name | `school-email-scheduler-web` |
| Authorised JavaScript origins | Not required. The flow is a server-side redirect; the browser never calls Google's token endpoint directly. |
| Authorised redirect URIs | Every row in the table below |

### Redirect URI matrix

The callback is always
`${PUBLIC_BASE_URL}/calendar/api/auth/google/callback`, computed server-side and
never taken from a query parameter.

**How `PUBLIC_BASE_URL` is derived (changed by TASK-049).** The app is served
from a Lambda function URL, not from `<sub_domain>.<hosted_zone>` on the shared
ALB — that hostname and its Route53 record are gone. The origin is therefore

```
https://<url-id>.lambda-url.<region>.on.aws
```

where `<url-id>` is generated by AWS when the function URL is created. It cannot
be predicted from the tfvars and it cannot be baked into the Lambda's own
environment (that would be a Terraform dependency cycle), so:

- `var.public_base_url` is **empty** by default, which leaves the
  `PUBLIC_BASE_URL` env var empty;
- with it empty the handler resolves the origin **per request** from the
  function URL's own host (`resolvePublicBaseUrl` in `src/lambda/calendar/index.mjs`),
  so the redirect URI it sends Google is always the origin the request actually
  arrived on;
- set `var.public_base_url` only if something is ever put in front of the
  function URL (a CDN or custom domain), or locally.

**So the redirect URI is read out of Terraform, not written down in advance:**

```sh
cd terraform
terraform output -raw calendar_function_url    # https://<url-id>.lambda-url.<region>.on.aws/
```

and the URI to register is that value plus `calendar/api/auth/google/callback`
(the output already ends with `/`), i.e.
`https://<url-id>.lambda-url.<region>.on.aws/calendar/api/auth/google/callback`.

| Environment | Tenant | `region` | Redirect URI to register |
| --- | --- | --- | --- |
| `dev` | `au` | `ap-southeast-2` | `<terraform output calendar_function_url>calendar/api/auth/google/callback` |
| `prod` | `au` | `ap-southeast-2` | `<terraform output calendar_function_url>calendar/api/auth/google/callback` |
| `prod` | `uk` | per that tenant's tfvars | `<terraform output calendar_function_url>calendar/api/auth/google/callback` |
| `prod` | `us` | per that tenant's tfvars | `<terraform output calendar_function_url>calendar/api/auth/google/callback` |
| local | — | — | `http://localhost:3000/calendar/api/auth/google/callback` |

Each row is a **different** function URL id, so all four are distinct strings —
run the output command once per deployment and paste the result.

Rules that bite in practice:

- **This is a manual step and sign-in is broken until it is done.** A freshly
  applied environment has a working app and a `redirect_uri_mismatch` on every
  sign-in until its function URL is registered on the OAuth client by hand.
- **A destroyed-and-recreated function URL gets a NEW id.** The id is stable for
  the life of the `aws_lambda_function_url` resource, but `terraform destroy` (or
  anything that forces its replacement) mints a new one — and sign-in stays
  broken until the Console is updated again. `PUBLIC_BASE_URL` needs no change,
  because it is derived per request.
- **All five URIs go on the one client.** Adding a tenant later means editing
  this client, not creating another — see Section 1.
- **`http` is permitted only for `localhost`.** Google rejects a plain-`http`
  redirect URI for any other host, and rejects `http://127.0.0.1` interchangeably
  with `localhost` only for the loopback address forms it whitelists — register
  `localhost` and use `localhost` in `PUBLIC_BASE_URL` locally.
- The local port must match the port the local dev server actually listens on
  and the `PUBLIC_BASE_URL` it is started with. If you run on a different port,
  register that URI too; the port is part of the match.
- **Matching is exact.** Scheme, host, port, and path all compare literally.
  A trailing slash, `https` vs `http`, or `www.` prefix is a different URI.
- Changes to the redirect URI list can take a few minutes to propagate on
  Google's side. A `redirect_uri_mismatch` immediately after an edit is often
  just propagation.

### After creating the client

Google shows the client ID and client secret **once**. Copy both straight into
the `put-secret-value` command in Section 4 (§4.2) — do not paste them into a
ticket, a chat message, a `.env` file that might be committed, or this runbook.
The client
ID always ends with `.apps.googleusercontent.com`; the client secret is a short
opaque string that can be rotated from the same Console screen if leaked.

Add every tenant's redirect URI to the client **before** the first deploy of that
tenant. A missing URI is not detectable by Terraform or by the preflight in
Section 7 — it surfaces only as a failed user sign-in.

---

## 4. Populating the Secrets Manager secret

Terraform **only reads** the per-tenant secret
`${environment}-${tenant}/app-config/school_calendar_services`
(`local.secret_name` in `terraform/variables.tf`). It does not create it:

- `terraform/main.tf` reads the *value* through
  `data "aws_secretsmanager_secret_version"`.
- `terraform/lambda_calendar.tf` reads the *ARN* through
  `data "aws_secretsmanager_secret"`, only so the Lambda's IAM policy can be
  scoped to this one secret.

Both are read-only data sources, and there is no `resource
"aws_secretsmanager_secret"` anywhere under `terraform/`. So the secret must
exist **and already hold a version** before the first `terraform apply` for that
environment/tenant pair — otherwise the plan fails reading a secret, or a secret
version, that is not there.

The payload is a flat JSON object. Create it once (§4.1) and populate it (§4.2)
per environment/tenant pair, in that account and region:

| Environment | Tenant | Secret id | Region |
| --- | --- | --- | --- |
| `dev` | `au` | `dev-au/app-config/school_calendar_services` | `ap-southeast-2` |
| `prod` | `au` | `prod-au/app-config/school_calendar_services` | `ap-southeast-2` |
| `prod` | `uk` | `prod-uk/app-config/school_calendar_services` | `eu-west-2` |
| `prod` | `us` | `prod-us/app-config/school_calendar_services` | `us-west-1` |

### Who creates the secret

Checked at the time of writing, so you do not have to search Terraform for a
resource that was never written:

- **This repository does not create it.** Only the two read-only data sources
  above.
- **The sibling `ohq-chatbot2` stack does not create its equivalent either.** It
  reads `${environment}-${tenant}/app-config/ohq_chatbot_services` through the
  same read-only `data "aws_secretsmanager_secret_version"` source, and that
  project's own docs create its secrets by hand with
  `aws secretsmanager create-secret`.
- **The shared `tf-cloudinfra` stack does not create them either.** It reads
  several `${environment}-${tenant}/app-config/...` secrets (for example
  `consoleapi-cnfg`) and declares no `aws_secretsmanager_secret` *resource*
  at all.
- **`tf-basestack` was not inspectable from here.** It is the repo named at the
  top of `terraform/config/<environment>/<tenant>.tfvars` and the source of
  `data.terraform_remote_state.basestack`, so it cannot be ruled out as the
  owner.

On that evidence, the `app-config` secrets are an **operator-owned
prerequisite**: something a human establishes out of band, outside every stack
listed above. So §4.1 below does it by hand.

Before running §4.1 for a **brand-new environment or tenant**, confirm with
whoever owns platform secret provisioning (the `tf-basestack` owners) that no
other stack is expected to create this secret. If one is, let that stack create
it and skip to §4.2 — creating it by hand would leave the secret outside the
state file that expects to manage it. For an environment that is already running,
the secret exists already and §4.1 is a no-op you can confirm rather than a step
you need.

### Keys

| Key | Meaning | Shape the preflight enforces |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Section 3 | Ends with `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret from Section 3 | Present and non-empty |
| `SESSION_SECRET` | HMAC key for the signed session cookie | Decodes to at least 32 bytes |
| `ANTHROPIC_API_KEY` | Anthropic API key for event extraction | Begins with Anthropic's `sk-ant-` prefix |
| `ALLOWED_ORIGINS` | Comma-separated origin allowlist for CORS | Present and non-empty |

`SESSION_SECRET` is per-environment and must never be shared between `dev` and
`prod` — a leaked dev secret would otherwise forge prod sessions. Generate a
fresh one:

```bash
# 32 random bytes, base64-encoded
openssl rand -base64 32
```

### 4.1 Create the secret

Once per environment/tenant pair, in that pair's account and region. The payload
here is a **placeholder skeleton** — it establishes the secret and its first
version so Terraform's data sources resolve; §4.2 puts the real values in.

Your AWS profile needs `secretsmanager:CreateSecret` for this step and
`secretsmanager:PutSecretValue` for §4.2, in that account and region. The secret
is encrypted with the account's default Secrets Manager KMS key unless you pass
`--kms-key-id`; nothing in this stack requires a customer-managed key for it.

```bash
aws secretsmanager create-secret \
  --region ap-southeast-2 \
  --name "dev-au/app-config/school_calendar_services" \
  --description "School Email Scheduler app config (dev-au)" \
  --secret-string '{
    "GOOGLE_CLIENT_ID": "REPLACE_ME_CLIENT_ID.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "REPLACE_ME_GOOGLE_CLIENT_SECRET",
    "SESSION_SECRET": "REPLACE_ME_BASE64_OF_32_RANDOM_BYTES",
    "ANTHROPIC_API_KEY": "REPLACE_ME_ANTHROPIC_API_KEY",
    "ALLOWED_ORIGINS": "REPLACE_ME_TENANT_ORIGIN"
  }'
```

`--name` must be exactly `local.secret_name` for that pair — the Secret id column
in the table above. A typo here does not fail here; it fails later as
`ResourceNotFoundException` on `terraform plan`, against the *correct* name.

The skeleton is deliberately not a working config. The Section 7 preflight will
fail against it until §4.2 has run, which is the intended reading: §4.1 makes the
secret exist, §4.2 makes it valid.

#### If the secret already exists

For an existing environment or tenant — or if a colleague got there first — the
command fails with:

```
An error occurred (ResourceExistsException) when calling the CreateSecret
operation: The operation failed because the secret
dev-au/app-config/school_calendar_services already exists.
```

**That is the expected signal that §4.1 is already done. Skip straight to §4.2**,
which updates the existing secret in place. Nothing is broken and nothing needs
undoing.

Do **not** delete and recreate the secret to get a clean run. Deletion is
scheduled, not immediate, the name stays reserved for the recovery window, and
every other reader of the secret breaks in the meantime. If you genuinely need to
reset the payload, `put-secret-value` in §4.2 already replaces it wholesale.

### 4.2 Populate the secret

Placeholders only. Substitute real values at the shell, and never in a file that
is committed or in shell history you keep (prefix the command with a space where
your shell honours `HISTCONTROL=ignorespace`).

`put-secret-value` requires the secret to exist: a `ResourceNotFoundException`
here means §4.1 has not been run for this environment/tenant pair.

```bash
aws secretsmanager put-secret-value \
  --region ap-southeast-2 \
  --secret-id "dev-au/app-config/school_calendar_services" \
  --secret-string '{
    "GOOGLE_CLIENT_ID": "REPLACE_ME_CLIENT_ID.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "REPLACE_ME_GOOGLE_CLIENT_SECRET",
    "SESSION_SECRET": "REPLACE_ME_BASE64_OF_32_RANDOM_BYTES",
    "ANTHROPIC_API_KEY": "REPLACE_ME_ANTHROPIC_API_KEY",
    "ALLOWED_ORIGINS": "REPLACE_ME_WITH_terraform_output_calendar_function_url_ORIGIN"
  }'
```

Repeat §4.1 then §4.2 per row of the table above, changing `--region`, the secret
name/id, and the `ALLOWED_ORIGINS` origin to that tenant's own host — since
TASK-049 that origin is the tenant's own function URL
(`terraform output -raw calendar_function_url`), with no path and **no trailing
slash**, so strip the trailing `/` the output ends with. Leaving `ALLOWED_ORIGINS`
empty keeps CORS in open mode (`*`, no credentials), which is what a fresh
environment runs with until the URL is known. `put-secret-value` replaces
the whole payload, so always send **all five keys** — sending a subset silently
drops the others, and `terraform apply` then reads empty strings for them
(`main.tf` reads every key through `lookup(local.secrets, "...", "")`, so a
missing key plans cleanly and fails at runtime instead).

Verify with the preflight in Section 7, not by printing the secret.

---

## 5. Restricted scope: verification, CASA, and Limited Use

### The 100-user unverified cap

An app in production status that requests a restricted or sensitive scope
**without** completing verification is limited to **100 distinct users granting
consent**, counted cumulatively for the life of the OAuth client. Once the cap is
reached, new users cannot consent at all — and the count does not reset when
users revoke. Every user before verification also sees the unverified-app
interstitial ("Google hasn't verified this app") and must click through an
*Advanced* link to proceed.

Practical reading: dev and a single pilot school fit comfortably inside 100
users. General release does not. Treat the cap as a hard launch blocker with a
multi-week lead time.

### What triggers a verification review

Submit for verification (*OAuth consent screen → Publish app → Prepare for
verification*) when any of these is true — all of them are true for this app:

- A **sensitive or restricted scope** is requested (`gmail.readonly` is
  restricted).
- The app is set to **In production** for external users beyond the test list.
- The app displays a logo on the consent screen (separate brand review).
- The publisher domain, app name, privacy policy URL, or requested scope list
  changes **after** verification — any of these re-opens the review.

The review requires: a verified publisher domain, a reachable privacy policy
covering the points in Section 2, and a **demonstration video** showing the
consent flow and exactly how each requested scope is used in the product,
recorded against the real OAuth client ID.

### CASA security assessment

Restricted scopes additionally require a **CASA (Cloud Application Security
Assessment)** through a Google-designated third-party assessor, at Tier 2 or
above for an app handling Gmail content.

- Required **before** a restricted-scope app can serve users beyond the 100-user
  cap.
- **Repeats annually.** The letter of assessment expires; lapsing it can suspend
  the app's restricted-scope access, which takes the product down for every
  tenant at once. Diarise the renewal at least three months ahead.
- Expect evidence requests about encryption at rest and in transit, secret
  management, access control, incident response, and data deletion. Much of the
  answer is already in the architecture: the refresh token is encrypted with a
  project CMK, secrets live in Secrets Manager, and message bodies are not
  retained after extraction.

### Limited Use obligations

Google's **Limited Use** requirements apply to all data obtained via
`gmail.readonly`, independently of verification, and are contractual:

1. **Purpose limitation** — use the data only to provide or improve the
   user-facing feature that is the stated reason for the scope (extracting school
   calendar events). No secondary use.
2. **No transfer** — do not transfer the data to third parties except as needed
   to provide that feature, for security, or to comply with law. Sending message
   text to Anthropic for extraction must be covered explicitly in the privacy
   policy as a service provider acting on our behalf.
3. **No advertising** — never use the data for serving, targeting, or measuring
   advertising.
4. **No human reading** — no human may read the data except with the user's
   explicit consent for specific messages, for security or legal reasons, or on
   aggregated, anonymised data. This makes it a compliance issue, not just a
   hygiene one, that message content is never written to logs.
5. **Revocation and deletion** — the user must be able to **revoke the app's
   access and have their data deleted**.

Obligation 5 is implemented by **TASK-013** (*Disconnect Gmail — revoke the grant
and delete stored data*): `POST /calendar/api/auth/disconnect` revokes the grant
at `https://oauth2.googleapis.com/revoke`, deletes the connection row holding the
encrypted refresh token, and optionally deletes every stored event. That endpoint
and its in-app control are a **verification prerequisite**, not a follow-up
nicety — reviewers look for it, and the privacy policy must link to it.

Restricted-scope minimisation, for the record: the app requests read-only Gmail
access, stores no message bodies after extraction, and holds only the extracted
events plus an encrypted refresh token. Keep it that way; each addition is a new
review question.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `redirect_uri_mismatch` on the callback | The `redirect_uri` the app sent is not registered **exactly** on the OAuth client. Usually a new tenant whose URI was never added, a function URL that was destroyed and recreated with a new id (TASK-049), a `PUBLIC_BASE_URL` override with a trailing slash or wrong scheme, or an edit that has not propagated yet. | Compare the `redirect_uri` in the error page's request details against `terraform output -raw calendar_function_url` for that deployment, character for character. Add or correct the URI on the client, wait a few minutes, retry. If `var.public_base_url` is set, confirm it has no trailing slash. |
| `access_denied` returned to the callback | The user declined consent, closed the consent screen, or — while the app is in **Testing** — is not on the test-user list. Also returned when the unverified 100-user cap has been reached. | If the user did not intend to decline: add them as a test user, or check the cap and consent-screen status. The app should surface a plain "you need to allow Gmail access to continue" message and offer retry, not a stack trace. |
| `admin_policy_enforced` | The user's **Google Workspace administrator** has restricted third-party app access, or has not allowlisted this OAuth client for the restricted Gmail scope. Nothing about our configuration can override this. | The school's Workspace admin must allowlist the app by **client ID** (*Admin console → Security → API controls → App access control → Configure new app → OAuth App Name Or Client ID*) and permit the `gmail.readonly` scope. Give them the client ID and the scope list from Section 2. |
| Token response has **no `refresh_token`** | `access_type=offline` or `prompt=consent` missing from the authorisation URL, or the user has an existing grant and consent was not re-prompted. | Both parameters are set in TASK-004's `/calendar/api/auth/google/start`, so this is a **regression** — check the authorisation URL builder before blaming Google. As a user-level workaround the existing grant can be removed at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), which forces a fresh consent and a new refresh token. |
| `403 accessNotConfigured` from any Gmail call | Gmail API not enabled on the project (Section 1), or the token was issued by a different project's client. | Enable the Gmail API and re-run the flow to get a token minted with the scope. |
| `invalid_client` at the token endpoint | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` mismatched, or from a different project, or the secret was rotated in the Console without updating Secrets Manager. | Re-run Section 4 with the current pair, then the Section 7 preflight. Do not print the values to compare them. |
| `invalid_grant` on refresh | The refresh token was revoked (user disconnected, admin revoked, password change), or is older than the 6-month inactivity expiry, or a Testing-status app's 7-day refresh-token expiry elapsed. | Treat as "reconnect required": clear the connection and send the user back through `/calendar/api/auth/google/start`. Moving the app out of Testing removes the 7-day expiry. |
| Callback rejected with `400` before reaching Google | `state` missing from or mismatched with the short-lived cookie — the CSRF defence in TASK-004. Commonly a cookie dropped because the browser blocked it, or a stale bookmarked callback URL. | Start the flow again from `/calendar/api/auth/google/start`. If reproducible, check the state cookie's attributes (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/calendar`). |

When debugging any of these: **never** log or paste the authorisation code,
access token, refresh token, `id_token`, client secret, session secret, or cookie
value. The Limited Use no-human-reading obligation and the project's own logging
rules both apply, at every log level.

---

## 7. Preflight: verifying the configuration

`scripts/check-oauth-config.mjs` checks the secret for one environment/tenant
pair and reports **key presence and shape only**. It never prints, logs, or
truncates a secret value — a prefix of a key is still key material — so its
output is safe to paste into a ticket or CI log.

```bash
npm run check:oauth-config -- --env dev --tenant au
```

The region defaults to the tenant's region from the table in Section 4; override
with `--region <aws-region>` if needed. AWS credentials come from the ambient
profile, which needs `secretsmanager:GetSecretValue` on that secret.

Checks performed, one printed line each:

- Each of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
  `ANTHROPIC_API_KEY`, `ALLOWED_ORIGINS` is present and non-empty.
- `GOOGLE_CLIENT_ID` ends with `.apps.googleusercontent.com`.
- `SESSION_SECRET` decodes to at least 32 bytes.
- `ANTHROPIC_API_KEY` begins with the expected Anthropic prefix.

Exit status is `0` when every check passes and `1` otherwise, so it drops into a
deploy pipeline ahead of `terraform apply`. Failed lines name the offending key
and report byte lengths and a verdict — never a value.

Run it after every Section 4 change, and once per tenant before that tenant's
first deploy.
