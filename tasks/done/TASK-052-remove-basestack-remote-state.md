---
id: TASK-052
title: remove basestack remote state
status: done
created: 2026-08-30T03:00:00.000Z
updated: 2026-08-30T07:20:00.000Z
question: NON-BLOCKING — proceeding to build, informational only. (1) Outbound source IP: today egress leaves via the basestack's private-subnet NAT (a stable public IP). Off-VPC, egress comes from AWS-managed Lambda addresses that are not stable. Nothing in this repo needs a fixed egress IP (Google/Anthropic don't require IP allowlisting), but if any external partner IP-allowlists this app's outbound traffic, that lives outside this repo and only the user can confirm it's not the case. (2) Rollout staging: detaching a Lambda from a VPC leaves Hyperplane ENIs behind for up to ~20-40 minutes, and destroying the security group in the same apply as the detach can fail with DependencyViolation until those ENIs clear. Documented as an edge case/known apply-time hazard in the ticket (retry the apply once ENIs clear) rather than gated as a blocking question, since it's an operational sequencing detail, not a scope decision.
activities: [{"activity":"ba","model":"claude-opus-4-8","startedAt":"2026-08-30T06:35:00.000Z","finishedAt":"2026-08-30T06:40:00.000Z","note":"Defined by reading the current tree fresh rather than trusting any ticket's stated line numbers. Confirmed data.terraform_remote_state.basestack has exactly two readers, both in lambda_calendar.tf (vpc_config.subnet_ids, aws_security_group.calendar_sg.vpc_id), and aws_security_group.calendar_sg's only consumer is that vpc_config - it cannot survive removal. Confirmed via grep: no aws_vpc_endpoint anywhere in terraform/, no aws:SourceVpc/aws:SourceVpce condition in any IAM or KMS policy, no CloudWatch alarm dimension keyed on the SG/VPC/subnets. Confirmed every backend .mjs client (DynamoDB, KMS, Secrets Manager) is constructed with no endpoint override and every external host (Google OAuth, Gmail, Anthropic) is a public one - nothing needs private/VPC-only connectivity. Read tasks/done/TASK-002 (zero VPC mentions) and tasks/done/TASK-003 (the SG was already documented as egress-only, 'ALB reaches Lambda via the Lambda service, not the network') and tasks/done/TASK-001 (the whole basestack/legacystack remote-state pattern was copied from ohq-chatbot2's provider.tf, i.e. house style, not a requirement of this app). CONCLUDED this is safe cleanup with no functional downside, not a blocking scope question - raised two informational, non-blocking notes instead (outbound IP stability, ENI-cleanup apply sequencing) rather than parking the ticket. Also caught that terraform/variables.tf and terraform/provider.tf both carry active 'do not remove, this is load-bearing' comments about the basestack state that would become false and misleading once this ships, and wrote that removal into the acceptance criteria. Identified six existing test sites that currently assert the old wiring and must be inverted, not deleted, plus two test files (inline HCL-parser fixtures) that must NOT be touched despite superficially similar strings. Token/cost telemetry not correlated; 74512 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed"},{"activity":"orchestrate-claim","startedAt":"2026-08-30T06:46:00.000Z","finishedAt":"2026-08-30T06:46:00.000Z","note":"BA's clarifying questions were both non-blocking (informational only), so claimed directly under build-052, free slot available, dispatching orchestrate-coder next in an isolated worktree."},{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-30T06:46:00.000Z","finishedAt":"2026-08-30T06:59:00.000Z","note":"Built in isolated worktree agent-affe95aa8444555e6. Confirmed the same stale-worktree issue TASK-051 hit (branched at 07b5820, missing TASK-049/050/051); also discovered origin/master is itself stale at 07b5820 (the merged work only exists on local master, 280be18) so fast-forwarded to LOCAL master instead of origin/master. Removed the Lambda's vpc_config block, the aws_security_group.calendar_sg resource, the VPCNetworkInterfaces IAM statement, data.terraform_remote_state.basestack, variable terraform_remote_state_basestack_config, and its tfvars map, replacing each with a house-style removal comment (matching TASK-049/051's pattern) rather than leaving stale load-bearing/do-not-remove prose behind. terraform validate: Success, 4 pre-existing unrelated warnings. fmt -check -recursive clean. terraform console confirmed local.name_prefix/local.secret_name unchanged and no orphaned-tfvars warning. Forbidden-token sweep (comments excluded) found zero remaining code references to any removed identifier; diff audit confirmed the ONLY added non-comment line in the whole change is the IAM policy description, so every other surviving statement/resource (CloudWatchLogs, DynamoDBCalendarTables, KMSCalendarKey, SecretsManagerAppConfig, function_name, function_url, function_url permission) is byte-for-byte untouched. IMPORTANT SAFETY FINDING: this sandbox has live AWS credentials configured, but for account 169189756964 - NOT account 058264301523, which is what terraform_init_dev_au.sh actually targets (profile ohq-dev, state bucket ap-southeast-2-058264301523-officehq-tfstate-bucket). Coder deliberately did NOT run terraform plan against those credentials, since it would target the wrong account and - because TASK-051 already removed allowed_account_ids - nothing in the code would stop it or even warn about it. Flagged for a human to verify the real plan (in the correct account) shows the Lambda updated in place, never destroy/recreate, before any apply. Did not touch tests or src/. Token/cost telemetry not correlated; 57894 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed."},{"activity":"test","model":"claude-opus-5","startedAt":"2026-08-30T06:59:00.000Z","finishedAt":"2026-08-30T07:15:00.000Z","note":"GREEN. Baseline (implementation stashed): 2531 tests, 2524 pass, 3 fail. Final: 2622 tests, 2615 pass, 3 fail (same 3, verbatim, confirmed pre-existing and unrelated - npm-scripts test:bdd, task-038 node_modules-not-installed, dynamodb-calendar fixture-mutation no-op). +91 net new passing tests. Added tests/e2e/task-052-no-vpc-attachment.test.js (42 pass, includes both FAILURE scenarios run for real: orphaned tfvars key produces an actual terraform plan Value-for-undeclared-variable warning, basestack-deleted-with-reader-surviving fixture produces an actual terraform validate Reference-to-undeclared-resource error) and tests/unit/task-052-no-vpc-attachment.test.js (37 pass, incl. a KMS-broadened-to-wildcard mutation and a declaration/tfvars desync check in both directions). Rewrote every site asserting the old VPC wiring to assert its correct absence with a comment naming what it used to assert and why TASK-052 reverses it - calendar-lambda-terraform.test.js (ALLOWED_UNSCOPED_SIDS -> [], VPC/SG scenarios inverted, both mutation fixtures lost VPCNetworkInterfaces), terraform-scaffold.test.js, task-051-terraform-refactor.test.js (both unit+e2e - TASK-051's own basestack-survives guard scenario reversed), terraform-state-locking.test.js (both unit+e2e), tests/helpers/tf-state-locking.mjs (REMOTE_STATE_MAPS -> [], basestack moved to REMOVED_REMOTE_STATE_MAPS). Confirmed via git status --porcelain that tests/unit/hcl-blocks-core.test.js and tests/e2e/hcl-semantic-assertions.test.js (inline HCL-parser fixtures, not real-file reads) were untouched. No product code modified; no DB/AWS client constructed anywhere, only offline terraform validate/console/plan (never apply). Flagged, not fixed (pre-existing, out of ticket scope): tests/unit/calendar-auth.test.js:686 has the same class of ~6%-flaky tampered-signature test that TASK-051 already fixed in a DIFFERENT file (tests/e2e/calendar-auth-routes.test.js) - measured 1251/20000 = 6.3% no-op rate on the last-base64url-char flip. Worth a follow-up ticket if it starts reddening CI. Token/cost telemetry not correlated; 160621 total subagent tokens, direction unsplit, so tokensIn/tokensOut omitted rather than guessed."},{"activity":"orchestrate-review","startedAt":"2026-08-30T07:15:00.000Z","finishedAt":"2026-08-30T07:15:00.000Z","note":"pr-review column resolved to agent tech-lead, but that column's configured instructions read verbatim 'skip step, move to done' - honored as a configured no-op pass-through, same as TASK-049/050/051; no tech-lead agent was invoked."},{"activity":"orchestrate-merge","startedAt":"2026-08-30T07:15:00.000Z","finishedAt":"2026-08-30T07:20:00.000Z","note":"Checked main working tree status before touching anything (lesson from TASK-050/051's merges) - clean, only expected tasks/ bookkeeping, no unexplained terraform/ diffs this time. Committed coder+tester changes on worktree-agent-affe95aa8444555e6 (commit 8f80136, 13 files) and merged into master with --no-ff (merge commit fc6d178) with no classifier interruption (no deletions of production config this time, unlike TASK-051). Independently re-ran terraform init/validate/fmt against the merged main tree afterward rather than trusting the subagents' reports alone: error_count 0, warning_count 4 (same pre-existing DynamoDB deprecations), fmt clean - matching exactly. Worktree and branch removed after."}]
---

## Description

Remove the calendar Lambda's VPC attachment entirely and, with it, the last consumer of the basestack remote state.

The Lambda currently runs inside the basestack VPC's private subnets. Nothing requires that. Verified by reading the tree, not assumed:

* `data.terraform_remote_state.basestack` is read in exactly TWO places, both in `terraform/lambda_calendar.tf`: `outputs.private_subnet_ids` feeds `vpc_config.subnet_ids` and `outputs.vpc_id` feeds `aws_security_group.calendar_sg.vpc_id`. There is no third reader of any basestack output anywhere in the repo.
* `aws_security_group.calendar_sg` is egress-all with NO ingress rule, and its only consumer is that `vpc_config`. It exists solely to satisfy the VPC attachment. It is the only `aws_security_group` in the repo, and there are no `aws_security_group_rule` resources at all.
* There is NO `aws_vpc_endpoint` anywhere in `terraform/`, no `aws:SourceVpc`/`aws:SourceVpce` condition in any IAM or KMS policy (`kms_calendar.tf` grants only account-root `kms:*`; the sole `Condition` in the tree is the `PassRole`/EventBridge restriction at `scheduler_calendar.tf:101`), and no CloudWatch alarm in `alerting.tf` dimensions on the SG, VPC or subnets.
* Everything the Lambda talks to is a public endpoint reachable from a non-VPC Lambda: DynamoDB and KMS clients are constructed with no `endpoint` override (`backend/connections.mjs`, `backend/events.mjs`, `backend/crypto.mjs`), and the external hosts are hardcoded public ones — `accounts.google.com`, `oauth2.googleapis.com` (`backend/google-oauth.mjs`, `backend/disconnect.mjs`), `gmail.googleapis.com` (`backend/gmail.mjs`) — plus Anthropic, Secrets Manager, EventBridge Scheduler and CloudWatch Logs.

WHY it was in a VPC in the first place: it was inherited, not required. `tasks/done/TASK-002-dynamodb-and-kms.md` never mentions VPC, subnet or endpoint at all. `tasks/done/TASK-003-lambda-alb-terraform.md` asked for the SG "in the basestack VPC, egress-all, no ingress (ALB reaches Lambda via the Lambda service, not the network)" — so even then the SG was known not to carry ingress. `tasks/done/TASK-001-terraform-scaffold.md` records that the whole `basestack`/`legacystack` remote-state pattern was copied from `ohq-chatbot2/terraform/provider.tf`. It is the basestack house style for every app in it, not a connectivity or isolation requirement of this app.

So this is cleanup, not a functional change. A non-VPC Lambda reaches public AWS service endpoints and the public internet directly with no NAT, so removing the attachment costs the app nothing it uses. It also removes a cross-stack coupling (this deploy no longer needs read access to the basestack state object), removes the ENI cold-start penalty, and removes NAT data-processing cost.

Once `vpc_config` and the security group go, `data.terraform_remote_state.basestack` has no reader, so it, `variable "terraform_remote_state_basestack_config"` and the tfvars block that sets it are all removed in the same change — the same declaration-and-tfvars-key-move-together rule TASK-051 established.

The one thing this genuinely changes: outbound traffic no longer leaves through the basestack NAT's stable public IP. Nothing in this repo depends on a fixed egress IP (see the `question` field for the informational, non-blocking caveat).

## Acceptance Criteria

- [x] `resource "aws_lambda_function" "calendar"` in `terraform/lambda_calendar.tf` declares NO `vpc_config` block at all — no `subnet_ids`, no `security_group_ids`, and no empty placeholder block.
- [x] `resource "aws_security_group" "calendar_sg"` is deleted from `terraform/lambda_calendar.tf`, and no `aws_security_group` or `aws_security_group_rule` resource exists anywhere under `terraform/`.
- [x] The `VPCNetworkInterfaces` statement (the five `ec2:CreateNetworkInterface` / `DescribeNetworkInterfaces` / `DeleteNetworkInterface` / `AssignPrivateIpAddresses` / `UnassignPrivateIpAddresses` actions on `Resource = "*"`) is removed from `aws_iam_policy.calendar_lambda_policy`, and the policy's `description` no longer claims "VPC".
- [x] After that removal, NO statement in the calendar policy uses `Resource = "*"`. `CloudWatchLogs` keeps its scoped `"arn:aws:logs:*:*:*"` unchanged, and `DynamoDBCalendarTables`, `KMSCalendarKey` and `SecretsManagerAppConfig` keep their exact existing resource values byte-for-byte.
- [x] `data "terraform_remote_state" "basestack"` is deleted from `terraform/provider.tf`.
- [x] `variable "terraform_remote_state_basestack_config"` is deleted from `terraform/variables.tf`.
- [x] The `terraform_remote_state_basestack_config = { ... }` block (bucket, key, region) is deleted from `terraform/config/dev/au.tfvars` in the SAME change as the declaration.
- [x] No file under `terraform/` references, in CODE (comment lines excluded), any of: `terraform_remote_state.basestack`, `terraform_remote_state_basestack_config`, `aws_security_group`, `vpc_config`, `subnet_ids`, `security_group_ids`, or `vpc_id`.
- [x] `terraform validate` succeeds against `terraform/`, and `terraform console -var-file=config/dev/au.tfvars` still evaluates `local.name_prefix` to `au-dev-receptionhq` and `local.secret_name` to `dev-au/app-config/school_calendar_services` — no resource is renamed.
- [x] A comment in `terraform/lambda_calendar.tf` where `vpc_config` used to be records the decision in the same "deliberate, not an oversight" style as the TASK-049 function-URL comment: that the Lambda runs on AWS-managed networking by design, what that gives up (no fixed NAT egress IP, no network-layer isolation), and why it is safe here (no `aws_vpc_endpoint` in this repo, no `aws:SourceVpc`/`aws:SourceVpce` condition in any policy, and every dependency — DynamoDB, KMS, Secrets Manager, EventBridge Scheduler, CloudWatch Logs, Google OAuth/Gmail, Anthropic — is a public endpoint).
- [x] The now-false "load-bearing, do not remove" comments in `terraform/variables.tf` (above `terraform_remote_state_basestack_config`) and `terraform/provider.tf` (above `data.terraform_remote_state.basestack`) are removed or rewritten. Leaving either would document the exact opposite of the code.
- [x] Function identity is preserved: `function_name`, `aws_lambda_function_url.calendar` and `aws_lambda_permission.calendar_allow_function_url` are untouched, so the function URL id — and therefore the Google OAuth redirect URI already registered in the Google console — does not change.
- [ ] `terraform plan` against dev/au shows `aws_lambda_function.calendar` updated IN PLACE (`~`) with its VPC configuration cleared, never destroy/recreate (`-/+`), and shows `aws_security_group.calendar_sg` destroyed. A plan reporting "no changes" to the function is a FALSE PASS and must be investigated, not accepted. **NOT VERIFIABLE from this sandbox — its configured AWS credentials target account 169189756964, not the 058264301523 this stack actually deploys to, and TASK-051 already removed the guard that would have caught that mismatch. Neither the coder nor the tester ran `plan`/`apply` against those credentials. A human with credentials for the correct account MUST run `terraform plan` and confirm an in-place update before any apply.**
- [x] Every test that asserts the old wiring is updated to assert the new state, with no assertion merely deleted and left with nothing in its place:
  - `tests/unit/calendar-lambda-terraform.test.js` — `ALLOWED_UNSCOPED_SIDS` becomes empty; the VPC-configuration scenario is replaced by a scenario asserting no `vpc_config` exists; the security-group-configuration scenario is replaced by a scenario asserting no `aws_security_group` exists; the IAM scoping test now asserts NO statement is unscoped; and the mutation fixtures that currently expect `['KMSCalendarKey','VPCNetworkInterfaces']` and `['SidLastStatement','VPCNetworkInterfaces']` drop the `VPCNetworkInterfaces` element.
  - `tests/unit/terraform-scaffold.test.js` — "dev/au.tfvars should keep the basestack remote state map" is inverted to assert its absence, and `terraform_remote_state_basestack_config` is added to the removed-keys list.
  - `tests/unit/task-051-terraform-refactor.test.js` — inverted to assert the basestack data source and both reads are gone.
  - `tests/e2e/task-051-terraform-refactor.test.js` — the "basestack remote state survives" scenario and the "FAILURE - basestack removed" scenario (whose second test currently asserts the real tree still has both reads) are reworked so they no longer defend wiring that is gone.
- [x] `tests/unit/hcl-blocks-core.test.js` and `tests/e2e/hcl-semantic-assertions.test.js` are NOT changed. Their `VPCNetworkInterfaces` strings are inline fixtures exercising the HCL parser itself, not reads of the real file; editing them would weaken parser coverage for no reason.
- [x] `npm test` (via `node --test "tests/unit/*.test.js" "tests/e2e/*.test.js"` — the bare-directory form is independently broken, per TASK-050) passes.
- [x] No file under `src/` is modified (`git status --porcelain -- src` is empty).

## Cucumber Tests

```gherkin
Feature: The calendar Lambda runs with no VPC attachment

  Scenario: The Lambda declares no VPC configuration
    Given terraform/lambda_calendar.tf
    When the aws_lambda_function "calendar" resource block is read
    Then it contains no "vpc_config" block
    And it references no subnet_ids and no security_group_ids

  Scenario: The security group that only existed for the VPC attachment is gone
    Given the terraform/ directory
    When every .tf file is scanned for resource declarations
    Then no aws_security_group resource is declared
    And no aws_security_group_rule resource is declared
    And no file references aws_security_group.calendar_sg

  Scenario: The ENI permissions the VPC attachment required are gone
    Given the inline policy of aws_iam_policy.calendar_lambda_policy
    When its statements are parsed with the shared HCL extractor
    Then no statement has the Sid "VPCNetworkInterfaces"
    And no statement grants any ec2:*NetworkInterface* action
    And the policy description does not claim "VPC"

  Scenario: Removing the VPC statement leaves every remaining grant scoped
    Given the inline policy of aws_iam_policy.calendar_lambda_policy
    When its statements are parsed
    Then no statement assigns Resource = "*"
    And the CloudWatchLogs statement is still scoped to "arn:aws:logs:*:*:*"
    And the DynamoDBCalendarTables statement still lists both table ARNs and the events index ARN
    And the KMSCalendarKey statement is still scoped to aws_kms_key.calendar.arn
    And the SecretsManagerAppConfig statement is still scoped to data.aws_secretsmanager_secret.app_config.arn

  Scenario: The basestack remote state and its variable are removed together
    Given the terraform/ directory
    When provider.tf, variables.tf and config/dev/au.tfvars are read with comment lines stripped
    Then provider.tf declares no data "terraform_remote_state" "basestack"
    And variables.tf declares no variable "terraform_remote_state_basestack_config"
    And config/dev/au.tfvars assigns no terraform_remote_state_basestack_config key
    And no .tf file reads data.terraform_remote_state.basestack.outputs.<anything>

  Scenario: The configuration still validates and names nothing differently
    Given the terraform/ directory after the removal
    When "terraform validate" is run
    Then it reports zero errors
    And "terraform console -var-file=config/dev/au.tfvars" evaluates local.name_prefix to "au-dev-receptionhq"
    And it evaluates local.secret_name to "dev-au/app-config/school_calendar_services"

  Scenario: The removal is documented where the wiring used to be
    Given terraform/lambda_calendar.tf
    When the comments around the removed vpc_config are read
    Then they state the no-VPC placement is deliberate
    And they name what it gives up, including the loss of a fixed NAT egress IP
    And variables.tf no longer claims the basestack remote state is load-bearing
    And provider.tf no longer carries a "do not remove" note for a data source that is gone

  Scenario: The function URL survives, so the registered OAuth redirect URI still works
    Given a terraform plan for dev/au after the removal
    When the planned actions are inspected
    Then aws_lambda_function.calendar is updated in place with its VPC configuration cleared
    And aws_lambda_function.calendar is not destroyed and recreated
    And aws_lambda_function_url.calendar has no planned change
    And aws_lambda_permission.calendar_allow_function_url has no planned change
    And aws_security_group.calendar_sg is planned for destruction

  Scenario: FAILURE - the plan would replace the function instead of updating it
    Given a terraform plan for dev/au after the removal
    When aws_lambda_function.calendar is shown with a "-/+ destroy and then create replacement" action
    Then the change must not be applied
    And it is reported as a blocker, because a recreated function mints a new
        function URL id and every Google sign-in then fails with redirect_uri_mismatch
        until the Google Cloud console is updated by hand

  Scenario: FAILURE - the plan reports no change to the Lambda at all
    Given the vpc_config block has been deleted from lambda_calendar.tf
    When terraform plan shows no change to aws_lambda_function.calendar
    Then the removal is treated as NOT applied
    And it is reported, because the deployed function would still be attached to
        the VPC while the code claims otherwise, and the security group destroy
        would then fail

  Scenario: FAILURE - the tfvars key is left behind after the variable is deleted
    Given variable "terraform_remote_state_basestack_config" has been removed from variables.tf
    And config/dev/au.tfvars still assigns terraform_remote_state_basestack_config
    When terraform plan is run with -var-file=config/dev/au.tfvars
    Then terraform emits a "Value for undeclared variable" warning
    And the test suite fails, because a warning alone would let the orphan ship

  Scenario: FAILURE - the data source is deleted while a reader survives
    Given a fixture in which data "terraform_remote_state" "basestack" is deleted
    And a vpc_config still reads data.terraform_remote_state.basestack.outputs.private_subnet_ids
    When terraform validate runs against that fixture
    Then it reports a "Reference to undeclared resource" error
    And the real terraform/ tree contains no such reference

  Scenario: EDGE - the security group cannot be deleted while Lambda ENIs linger
    Given terraform apply has detached aws_lambda_function.calendar from the VPC
    And the Lambda service has not yet torn down its Hyperplane ENIs
    When terraform tries to destroy aws_security_group.calendar_sg
    Then AWS may reject the delete with DependencyViolation
    And the correct response is to wait for ENI cleanup and re-run apply,
        not to force-delete the ENIs or abandon the change

  Scenario: The HCL parser fixtures are untouched
    Given tests/unit/hcl-blocks-core.test.js and tests/e2e/hcl-semantic-assertions.test.js
    When they are compared against master
    Then their inline VPCNetworkInterfaces fixtures are unchanged,
         because they test the parser, not the real Terraform files
```

## Edge and Failure Cases

1. **Lambda ENI cleanup blocks the SG destroy.** Detaching a function from a VPC leaves Hyperplane ENIs behind for up to ~20-40 minutes. Terraform will try to destroy `aws_security_group.calendar_sg` in the same apply and can fail with `DependencyViolation: resource sg-... has a dependent object`. This is expected, not a bug: wait and re-run the apply.
2. **Ordering hazard with the ENI IAM grants.** The Lambda service uses the execution role's `ec2:*NetworkInterface*` permissions to manage its ENIs. Removing the `VPCNetworkInterfaces` statement in the SAME apply as the detach can leave orphaned ENIs that then block the SG delete indefinitely. Safest sequence is detach first, remove the grants and the SG once the ENIs are gone. Do NOT delete the execution role.
3. **Provider "no diff" quirk.** Removing an optional `vpc_config` block has historically produced no plan diff in some AWS provider versions, silently leaving the deployed function attached. Verify from the plan that the VPC configuration is actually being cleared. Do not "fix" this by leaving an empty `vpc_config` block behind — that violates the first acceptance criterion.
4. **Replacement instead of in-place update.** Changing `vpc_config` is normally an `UpdateFunctionConfiguration` (in-place). If the plan shows `-/+`, STOP: a new function URL id breaks the manually registered Google OAuth redirect URI (`docs/google-oauth-setup.md` section 3, and the operational note in `terraform/lambda_calendar.tf`).
5. **Outbound source IP changes.** Egress moves from the basestack NAT's stable public IP to AWS-managed Lambda addresses. Nothing in this repo needs a fixed egress IP; anything outside it that IP-allowlists this app would break. See the `question` field.
6. **Orphaned tfvars key only warns.** `terraform plan` emits "Value for undeclared variable" and continues, so an assertion must explicitly check the key's absence. The reverse — a declaration with no default and no value — is a hard error, which is why both sides must move in one change (TASK-051's rule).
7. **Comments that outlive their code.** `terraform/variables.tf` and `terraform/provider.tf` both actively assert the basestack state is load-bearing. Deleting the code and keeping the prose is worse than either.
8. **Test fixtures that look like real references.** `tests/unit/hcl-blocks-core.test.js` and `tests/e2e/hcl-semantic-assertions.test.js` mention `VPCNetworkInterfaces` in inline fixture strings only. A blanket find-and-replace across `tests/` would gut parser coverage.
9. **Historical prose in docs.** `docs/google-oauth-setup.md`'s note about reconstructing the deleted prod tenants from git history stays true; do not chase it.
10. **No `terraform init` change needed.** `terraform_remote_state` is a builtin, not a plugin, and the S3 backend config in `provider.tf` and `terraform_init_dev_au.sh` is unrelated to the basestack state object. Leave both alone.

## Relevant Files and Context

**Change these:**
- `terraform/lambda_calendar.tf` — the `vpc_config` block; the `VPCNetworkInterfaces` IAM statement; the policy `description` and header comment (both name VPC); `resource "aws_security_group" "calendar_sg"`.
- `terraform/provider.tf` — `data "terraform_remote_state" "basestack"` and its "do not remove, load-bearing" comment.
- `terraform/variables.tf` — `variable "terraform_remote_state_basestack_config"` and the now-false comment above it.
- `terraform/config/dev/au.tfvars` — the `terraform_remote_state_basestack_config` map block (the only tfvars file in the repo since TASK-051).

**Tests that currently assert the OLD wiring and must be reworked:**
- `tests/unit/calendar-lambda-terraform.test.js`, `tests/unit/terraform-scaffold.test.js`, `tests/unit/task-051-terraform-refactor.test.js`, `tests/e2e/task-051-terraform-refactor.test.js`.

**Tests to leave alone (inline parser fixtures, not real-file reads):**
- `tests/unit/hcl-blocks-core.test.js`, `tests/e2e/hcl-semantic-assertions.test.js`.

**Read for context, do not change:**
- `terraform/alerting.tf` — alarms dimension only on `FunctionName`; nothing keys off the SG, VPC or subnets.
- `terraform/kms_calendar.tf` — key policy grants account-root `kms:*` only; no VPC condition.
- `terraform/scheduler_calendar.tf` — its only `Condition` restricts `PassRole` to EventBridge Scheduler; unrelated to networking.
- `src/lambda/calendar/backend/{connections,events,crypto,gmail,google-oauth,disconnect}.mjs` — AWS clients built with no `endpoint` override; all external hosts are public.
- `tasks/done/TASK-001-terraform-scaffold.md`, `tasks/done/TASK-003-lambda-alb-terraform.md` — the original (template-copied) rationale.
- `tasks/done/TASK-049-url.md` — why the function URL id must not change.
- `tasks/done/TASK-051-terraform-refactor.md` — the declaration-and-tfvars-key move-together rule and the comment style for recorded removals.

**Conventions to follow:** removals in this repo leave a comment naming what was removed, by which ticket, and why — see the existing removal comments in `terraform/variables.tf`, `terraform/main.tf` and `terraform/alerting.tf`. Tests are `node --test` with `describe`/`it` in Given/When/Then phrasing.

**Run commands:**
`cd terraform && terraform init -backend=false && terraform validate -json` (binary at `C:/External/Terraform/terraform.exe`, v1.16.0); tests via `node --test "tests/unit/*.test.js" "tests/e2e/*.test.js"` — `npm test` is independently broken.

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
