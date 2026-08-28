---
id: TASK-050
title: terraform state
status: defining
created: 2026-08-28T21:30:01.654Z
updated: 2026-08-28T22:20:47.000Z
question: PARKED — BLOCKED ON AN EXTERNAL TERRAFORM UPGRADE. Verified, not assumed: the binary the tests hardcode (C:/External/Terraform/terraform) reports v1.8.5, and use_lockfile requires 1.10+. User decision: park this ticket until Terraform is upgraded across every operator and deploy host; no prerequisite ticket was raised, because the upgrade is infrastructure work outside this repo. DO NOT BUILD and do not let a build run pick this up until that upgrade has actually happened and been confirmed here. Note provider.tf declares NO required_version at all today, which is exactly why the version drift was invisible — adding that pin is an acceptance criterion of this ticket, so a pre-1.10 binary will fail fast instead of silently initialising an UNLOCKED backend. Remaining secondary questions once unblocked: confirm scope is the state-LOCK table only and that the application tables calendar_connections and calendar_events (user data + KMS-encrypted OAuth refresh tokens, PITR on) stay untouched; confirm this repo only STOPS REFERENCING the shared upstream lock table and never deletes it; decide whether the two inert terraform_remote_state dynamodb_table keys go too; and settle who verifies state-bucket versioning plus the deploy role s3:PutObject/s3:DeleteObject on the tflock key, and whether a short apply freeze across dev-au/prod-au/prod-uk/prod-us is acceptable for the cutover.
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-08-28T21:45:00.000Z","finishedAt":"2026-08-28T21:52:00.000Z","note":"DEFINED and PARKED on 5 blocking questions. Established the facts rather than assuming the standard pattern: the lock table is NOT a resource in this repo at all - it is referenced in three places that all consume it (provider.tf backend block literal, the four init scripts which override that literal with a REGION-PREFIXED name ap-southeast-2-tfstate-table, and two terraform_remote_state data sources whose dynamodb_table key is INERT because read-only state reads never take a lock). Concluded the table and the state bucket are upstream/shared - the same bucket holds basestack, legacystack and the chatbot stack state, and the tfvars header says to sync with the tf-basestack repo - so this repo can only STOP REFERENCING the table, never delete it. SHARPEST FINDING: provider.tf declares NO required_version at all, and use_lockfile needs Terraform 1.10+, so without adding the pin an operator on an older binary silently gets an UNLOCKED backend; that made the version pin an acceptance criterion rather than a nicety, and the version question potentially ticket-blocking. Correctly ruled OUT -migrate-state: only the locking mechanism changes while bucket/key/workspace stay identical, so -reconfigure (already what the init scripts run) is right and -migrate-state could prompt destructive state moves. Made the empty terraform plan the sharpest acceptance criterion. Explicitly fenced off the two APPLICATION DynamoDB tables (calendar_connections, calendar_events) holding user data and KMS-encrypted refresh tokens as out of scope and forbidden, since conflating them with the lock table would destroy every refresh token irrecoverably. Also caught the map-key/index desync hazard (removing dynamodb_table from tfvars but not from the provider.tf index is a hard Invalid index error at plan time, so both sides must move in one commit), the old-mode/new-mode concurrency straddle window where two applies cannot see each other's locks, and the IAM gap on the .tflock object. Token/cost telemetry not correlated; 44744 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"}]
answer: upgrade terraform
---

## Description

Replace the Terraform **S3 backend's DynamoDB state-lock table** with S3-native lockfile locking (`use_lockfile = true`), so Terraform state and its lock both live in S3 alone.

**Scope is the state-lock table only.** This repo also has two **application** DynamoDB tables — `aws_dynamodb_table.calendar_connections` (`terraform/dynamodb_calendar_connections.tf:58`) and `aws_dynamodb_table.calendar_events` (`terraform/dynamodb_calendar_events.tf:71`), created by TASK-002 and holding user data and KMS-encrypted refresh tokens. **These must not be touched.** They are the only `aws_dynamodb_table` resources in the repo; the lock table is not a resource here at all.

Today the lock table is referenced in three places, none of which create it:

1. `terraform/provider.tf:11-14` — `backend "s3"` has literal `dynamodb_table = "tfstate-table"`, plus `encrypt = true`. Bucket/key/region are partial config supplied at init.
2. The four init scripts (`terraform/terraform_init_{dev_au,prod_au,prod_uk,prod_us}.sh`) export `DDBTABLENAME="tfstate-table"` and pass `-backend-config="dynamodb_table=$AWS_REGION-$DDBTABLENAME"` (i.e. the real table is region-prefixed, `ap-southeast-2-tfstate-table`; the literal in provider.tf is overridden by this).
3. `terraform/provider.tf:53-71` — the `basestack` and `legacystack` `terraform_remote_state` data sources pass `dynamodb_table` from the `terraform_remote_state_basestack_config` / `terraform_remote_state_legacystack_config` map variables, populated in all four tfvars under `terraform/config/`. These are **read-only** state reads that never take a lock, so the key is inert there.

The lock table and the `*-officehq-tfstate-bucket` state bucket are **shared infrastructure owned upstream** (the tfvars header says "Make sure sync up the following variables with tf-basestack Repo"; the same bucket holds basestack, legacystack and the chatbot stack's state). This repo can therefore only **stop referencing** the lock table — it cannot and must not delete it, because other stacks still lock against it. Likewise this repo cannot enable bucket versioning; it can only verify it.

Critically, `terraform { }` in `provider.tf` has **no `required_version`** at all. `use_lockfile` requires Terraform **1.10+**, so the work must add that constraint; otherwise an operator on an older binary silently gets an unlocked backend.

Because only the *locking mechanism* changes and the bucket/key/workspace stay identical, **the state object itself is not migrated**. `terraform init -reconfigure` (already what the init scripts run) is correct; `-migrate-state` is **not** appropriate here and must not be used.

## Acceptance Criteria

- [ ] `terraform/provider.tf`'s `backend "s3"` block no longer contains `dynamodb_table`, and contains `use_lockfile = true`.
- [ ] `terraform/provider.tf`'s `backend "s3"` block still contains `encrypt = true`, and still supplies no literal `bucket`/`key`/`region` (partial config preserved).
- [ ] The `terraform { }` block in `terraform/provider.tf` declares `required_version = ">= 1.10"` (or tighter), so a pre-1.10 binary fails fast instead of initialising an unlocked backend.
- [ ] The `required_providers` `aws = "~> 6.19"` constraint is unchanged.
- [ ] All four of `terraform/terraform_init_dev_au.sh`, `terraform_init_prod_au.sh`, `terraform_init_prod_uk.sh`, `terraform_init_prod_us.sh` no longer pass `-backend-config="dynamodb_table=..."`, and no longer export or echo `DDBTABLENAME`.
- [ ] Those four scripts still pass `bucket`, `key` and `region` backend-config, still keep the `if [ "$CI" != "true" ]` guard that omits `profile` in CI, still use `-reconfigure`, and still run `terraform workspace select -or-create` with the unchanged workspace name.
- [ ] The `TF_STATE_KEY` value in every init script is byte-for-byte unchanged (`terraform_${TF_ENV_SHORT}_school_calendar.tfstate`) — changing the key would point Terraform at a non-existent state and appear as a full-stack create.
- [ ] The `dynamodb_table` key is removed from **both** `terraform_remote_state_*_config` usages in `terraform/provider.tf` **and** from all eight map literals across `terraform/config/dev/au.tfvars`, `config/prod/au.tfvars`, `config/prod/uk.tfvars`, `config/prod/us.tfvars` — removed together in one change, since a `map(string)` index for a missing key is a hard `Invalid index` error at plan time.
- [ ] `bucket`, `key` and `region` in every `terraform_remote_state_*_config` map are unchanged.
- [ ] No `aws_dynamodb_table` resource is added, removed or modified: `terraform/dynamodb_calendar_connections.tf` and `terraform/dynamodb_calendar_events.tf` are untouched, and `git diff --stat` for this change lists no file under `src/`.
- [ ] `terraform init -backend=false && terraform validate -json` in `terraform/` reports `error_count === 0`.
- [ ] `npm test` passes, specifically including `tests/e2e/terraform-scaffold.test.js`, `tests/unit/calendar-lambda-terraform.test.js`, `tests/e2e/dynamodb-calendar.test.js` and `tests/e2e/calendar-alerting-waf.test.js` (the last of which copies `variables.tf` + `config/` into a temp workspace, so the tfvars edits must keep those parseable).
- [ ] A new assertion covers the backend block itself: it asserts `use_lockfile` is present and `dynamodb_table` is absent in `terraform/provider.tf`, alongside the existing app-table assertions that must stay green.
- [ ] **Migration proof**: after re-running the init script for an environment, `terraform plan` for that workspace reports **no changes** — no resource created, destroyed or replaced. An empty plan is the pass condition; any non-empty plan is a failure of this ticket, not a thing to apply.
- [ ] The rollout order is documented in the ticket/PR and followed: confirm no apply is in flight, all operators pull the change together, each environment re-runs its `terraform_init_*.sh` (which already uses `-reconfigure`), and `terraform plan` must be empty before any apply.
- [ ] `-migrate-state` is **not** used anywhere; the state object's S3 key and version are unchanged by the switch.
- [ ] The state bucket has **versioning enabled** — verified before the change and recorded in the PR — since with the lock table gone, object versioning is the recovery path for a bad state write.
- [ ] The deploy identity's IAM policy is verified to allow `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the `<state key>.tflock` object path, since S3 locking creates and deletes that object where DynamoDB permissions previously did the work.
- [ ] The DynamoDB lock table is **not** deleted, detached or modified by this repo; the PR states explicitly that it is left in place because it is upstream/shared, and names who owns any later cleanup.
- [ ] The rollback path is documented: re-add `dynamodb_table`, drop `use_lockfile`, re-run `terraform_init_*.sh`, and delete any stale `.tflock` object (or `terraform force-unlock`) left behind.

## Cucumber Tests

```gherkin
Feature: Terraform state locking uses S3 alone

  Scenario: The backend declares S3 lockfile locking and no DynamoDB table
    Given the file terraform/provider.tf
    When the backend "s3" block is read
    Then it contains use_lockfile = true
    And it does not contain dynamodb_table
    And it still contains encrypt = true

  Scenario: The terraform block pins a version that supports use_lockfile
    Given the terraform block in terraform/provider.tf
    When required_version is read
    Then it constrains Terraform to 1.10 or newer
    And required_providers still constrains hashicorp/aws to "~> 6.19"

  Scenario: The init scripts no longer supply a lock table
    Given each of the four terraform/terraform_init_*.sh scripts
    When the built INIT_CMD is inspected
    Then it passes -backend-config for bucket, key and region
    And it passes no -backend-config for dynamodb_table
    And no DDBTABLENAME variable is exported
    And the CI guard that omits the profile backend-config is still present

  Scenario: The state key is untouched so the same state file is used
    Given each of the four terraform/terraform_init_*.sh scripts
    When TF_STATE_KEY is read
    Then it is still terraform_${TF_ENV_SHORT}_school_calendar.tfstate

  Scenario: The remote state data sources drop the inert lock table key
    Given terraform/provider.tf and the four files under terraform/config
    When the terraform_remote_state_basestack_config and legacystack maps are read
    Then no map declares a dynamodb_table key
    And no data source indexes a dynamodb_table key
    And every map still declares bucket, key and region

  Scenario: The configuration still validates
    Given the terraform directory
    When "terraform init -backend=false" then "terraform validate -json" is run
    Then error_count is 0

  Scenario: Switching the backend changes nothing about the infrastructure
    Given an environment whose state was previously locked with DynamoDB
    When the updated terraform_init_*.sh is run with -reconfigure
    And "terraform plan" is run for that workspace
    Then the plan reports no changes
    And no resource is created, destroyed or replaced
    And no state migration prompt is shown

  Scenario: The application DynamoDB tables are not in scope
    Given the change for this ticket
    When the diff is inspected
    Then terraform/dynamodb_calendar_connections.tf is unchanged
    And terraform/dynamodb_calendar_events.tf is unchanged
    And the calendar_connections and calendar_events tables are absent from the plan

  Scenario: Removing the map key without removing the index breaks the plan
    Given dynamodb_table has been removed from the tfvars maps
    But terraform/provider.tf still indexes the dynamodb_table key
    When terraform plans
    Then it fails with an "Invalid index" error
    And the change is rejected rather than applied

  Scenario: An operator on a pre-1.10 Terraform is stopped rather than left unlocked
    Given an operator whose terraform binary is older than 1.10
    When they run terraform init against the updated backend
    Then terraform fails on the required_version constraint
    And it does not initialise a backend with no locking

  Scenario: Two operators straddling the switch could corrupt state
    Given operator A is on the old code and holds a DynamoDB lock
    And operator B is on the new code and holds only an S3 lockfile
    When both run terraform apply against the same workspace
    Then neither lock is visible to the other and state can be corrupted
    And therefore the rollout requires no apply in flight and all operators to move together

  Scenario: The deploy identity cannot write the lock object
    Given the deploy role lacks s3:PutObject or s3:DeleteObject on the tflock key
    When terraform plan or apply is run
    Then locking fails with an access denied error
    And the run aborts without writing state

  Scenario: A stale lockfile is left behind by an interrupted run
    Given a terraform run was interrupted after creating the tflock object
    When the next run starts
    Then it reports the state as locked
    And the operator clears it with terraform force-unlock rather than deleting state

  Scenario: The shared lock table is not deleted by this repo
    Given the DynamoDB lock table is shared with basestack, legacystack and the chatbot stack
    When this ticket is implemented
    Then the table is left in place and unmodified
    And only this repo's references to it are removed
```

## Edge and Failure Cases

- **Map-key/index desync** — removing `dynamodb_table` from tfvars but not from `provider.tf`'s index (or vice-versa) fails with `Invalid index` at plan time. Both sides must change in the same commit. Only four tfvars files exist; missing one breaks that tenant alone.
- **Pre-1.10 Terraform** — without `required_version`, an old binary ignores or rejects `use_lockfile`; worst case is an apply with no lock at all. This is why the version pin is an AC, not a nicety.
- **The concurrency straddle window** — old-mode and new-mode runs cannot see each other's locks. This is the single highest-risk moment; it requires a freeze and a coordinated cutover.
- **Accidental `-migrate-state`** — unnecessary here and can prompt destructive state moves. Use `-reconfigure` only.
- **Any non-empty plan after the switch** — signals the backend now points at a different or empty state (usually a changed `key`, `bucket` or workspace). Do **not** apply; re-check backend config.
- **IAM gap on the lock object** — S3 locking needs object write *and delete* on the lock key; DynamoDB permissions no longer help.
- **Stale lockfile** after an interrupted run — resolve with `terraform force-unlock`, never by deleting the state object.
- **Bucket versioning off** — with no DynamoDB lock table, versioning is the only recovery from a corrupt write. Verify before cutover; the bucket is upstream-owned so this repo can't fix it.
- **Deleting the shared lock table** — would break basestack, legacystack and the chatbot stack. Out of scope; explicitly forbidden.
- **Confusing the app tables with the lock table** — deleting `calendar_connections` destroys every user's encrypted refresh token irrecoverably (that table has PITR on precisely for this reason). Out of scope; explicitly forbidden.
- **Region-prefix mismatch** — the real lock table is `ap-southeast-2-tfstate-table` (per the scripts) while `provider.tf` and the tfvars say `tfstate-table`. Harmless once removed, but don't "fix" it on the way out.
- **`terraform/.terraform/` local state cache** — a developer's existing `.terraform/terraform.tfstate` records the old backend; `-reconfigure` is what discards it. A stale cache is the usual cause of a surprise re-init prompt.

## Relevant Files and Context

**Must change**
- `terraform/provider.tf` — backend block (lines 11-14), the `terraform{}` block / `required_version`, and the two `terraform_remote_state` data sources (lines 53-71).
- `terraform/terraform_init_dev_au.sh` (lines 6, 18, 25)
- `terraform/terraform_init_prod_au.sh` (lines 6, 18, 25)
- `terraform/terraform_init_prod_uk.sh` (lines 6, 18, 25)
- `terraform/terraform_init_prod_us.sh` (lines 6, 18, 25)
- `terraform/config/dev/au.tfvars` (lines 20, 27)
- `terraform/config/prod/au.tfvars` (lines 20, 27)
- `terraform/config/prod/uk.tfvars` (lines 20, 27)
- `terraform/config/prod/us.tfvars` (same two keys)

**Must NOT change**
- `terraform/dynamodb_calendar_connections.tf`
- `terraform/dynamodb_calendar_events.tf`

**Tests to run / extend**
- `tests/e2e/terraform-scaffold.test.js` — resolves the terraform binary and runs `init -backend=false` plus `validate`; its header comment at lines 16-19 describes the s3 backend and should be kept accurate.
- `tests/unit/calendar-lambda-terraform.test.js` — lines 638-690 run `init -backend=false` plus `validate -json` and assert `error_count === 0`; note it hardcodes `"C:/External/Terraform/terraform"`.
- `tests/e2e/dynamodb-calendar.test.js` — lines ~405-465; the app-table suite that must stay green, proving the app tables were untouched.
- `tests/e2e/calendar-alerting-waf.test.js` — lines 64-90 show the `resolveTerraformBin()` plus temp-workspace pattern to copy for a new backend assertion.
- `tests/helpers/hcl-blocks.mjs` — `extractResourceBody` / `extractBlock` (lines 156-183) for asserting on terraform source text; note `backend "s3"` carries a label, unlike the unlabelled blocks `extractBlock` targets.
- Run with `npm test`.

**Context**
- `terraform/main.tf` lines 1-45 — the shared-resource pattern: upstream-owned things (`aws_lb.web_app_alb`, the route53 zone) are consumed via `data` sources, never created here. The lock table and state bucket follow the same ownership model.
- `tasks/done/TASK-001-terraform-scaffold.md` lines 55-57 — the original AC that mandated `dynamodb_table = "tfstate-table"`. This ticket supersedes it; no live test asserts it, so nothing breaks.
- No CI config exists in the repo (no `.github/`, no pipeline file), so the deploy path is the four init scripts run by operators. There is no runbook documenting the backend — `docs/google-oauth-setup.md` is the only doc and does not mention it, so no doc goes stale.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
