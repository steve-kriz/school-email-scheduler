---
id: TASK-001
title: Terraform scaffold and repo structure mirroring ohq-chatbot2
status: done
created: 2026-08-17T11:00:00Z
updated: 2026-08-17T23:50:16Z
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-17T23:31:15Z","finishedAt":"2026-08-17T23:36:32Z","tokens":45157},{"activity":"test","model":"claude-haiku-4-5","startedAt":"2026-08-17T23:38:20Z","finishedAt":"2026-08-17T23:44:29Z","tokens":48018,"result":"pass","tests":77},{"activity":"review","model":"claude-opus-4-8","startedAt":"2026-08-17T23:45:55Z","finishedAt":"2026-08-17T23:48:15Z","tokens":52051,"verdict":"accept","followUps":["TASK-014","TASK-015"]}]
---

## Description
Stand up the repository skeleton and the shared Terraform layer, copying the
conventions of `C:\Projects\officehq_git\ohq-chatbot2` exactly. This ticket
creates only the shared/foundational files — the Lambda, DynamoDB, scheduler,
WAF and alerting resources land in later tickets, so `terraform validate` must
pass with just these files present.

Reference files to copy the pattern from (read them, do not import them):
- `ohq-chatbot2/terraform/provider.tf` — s3 backend, `hashicorp/aws ~> 6.19`,
  two providers (regional + `aws_global` alias), `default_tags`, and the
  `basestack` / `legacystack` `terraform_remote_state` data sources.
- `ohq-chatbot2/terraform/variables.tf` — the `locals` block defining
  `name_prefix = "${var.tenant}-${var.environment}-${var.project_name}"` and
  `name_prefix_short`, plus every shared variable.
- `ohq-chatbot2/terraform/main.tf` — Route53 A-record alias to the shared
  web-app ALB, the `aws_secretsmanager_secret_version` lookup and
  `local.secrets = jsondecode(...)`, the ALB + 443 listener data sources.
- `ohq-chatbot2/terraform/config/dev/au.tfvars` and the three prod tfvars.
- `ohq-chatbot2/terraform/terraform_init_dev_au.sh` and the three prod scripts.
- `ohq-chatbot2/package.json` — root test scripts (`node --test tests/unit`,
  playwright, playwright-bdd).

Project-specific values for this repo:
- `project_name = "receptionhq"`, `project_name_short = "rhq"` (unchanged — the
  same platform), `sub_domain = "calendar"`.
- Secrets Manager secret id:
  `"${var.environment}-${var.tenant}/app-config/school_calendar_services"`,
  exposed as `local.secret_name` in `variables.tf` and read in `main.tf`. The
  JSON payload holds `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `ALLOWED_ORIGINS`. Use
  `lookup(local.secrets, "KEY", "")` for every read so a partially-populated
  secret does not fail `plan`.
- Terraform state key in the init scripts:
  `TF_STATE_KEY="terraform_${TF_ENV_SHORT}_school_calendar.tfstate"` — it must
  NOT collide with `terraform_dev_ohq_chatbot.tfstate`. Keep the `$CI` guard
  that omits `-backend-config="profile=..."` in CI.
- The base Lambda execution role and its basic-execution policy from
  `main.tf` are NOT copied — TASK-003 owns a purpose-scoped role instead.
  Copy the `aws_iam_policy_document.lambda_assume_role_policy` data source
  only, since later tickets reuse it.

Also create `.gitignore` covering `.terraform/`, `*.tfstate*`, `packages/*.zip`,
`node_modules/`, `.env`, and playwright output dirs.

## Acceptance Criteria
- [ ] `terraform/provider.tf` declares `hashicorp/aws ~> 6.19`, the `s3` backend
      with `encrypt = true` and `dynamodb_table = "tfstate-table"`, the regional
      provider constrained by `allowed_account_ids = [var.account_id]`, and the
      `aws_global` (us-east-1) aliased provider.
- [ ] `terraform/provider.tf` declares the `basestack` and `legacystack`
      `terraform_remote_state` data sources reading from the corresponding
      `var.terraform_remote_state_*_config` maps.
- [ ] `terraform/variables.tf` defines `local.name_prefix`,
      `local.name_prefix_short` and `local.secret_name` with the values above,
      and declares every variable referenced by the tfvars files.
- [ ] `terraform/main.tf` creates exactly one `aws_route53_record` aliasing
      `${var.sub_domain}.<basestack domain_name>` to the shared ALB, and exposes
      `local.secrets` from the Secrets Manager lookup.
- [ ] `terraform/main.tf` declares
      `data.aws_iam_policy_document.lambda_assume_role_policy` allowing
      `sts:AssumeRole` for the `lambda.amazonaws.com` service principal.
- [ ] `terraform/config/dev/au.tfvars` sets `sub_domain = "calendar"` and the
      same `account_id`, `region`, `tenant`, `environment`, `alb_name`,
      `hosted_zone*` and remote-state maps as the chatbot dev/au tfvars.
- [ ] `terraform/config/prod/{au,uk,us}.tfvars` exist with each tenant's values
      copied from the chatbot equivalents and `sub_domain = "calendar"`.
- [ ] Four executable `terraform_init_{dev_au,prod_au,prod_uk,prod_us}.sh`
      scripts exist, each exporting a `school_calendar` state key and selecting
      the matching workspace with `terraform workspace select -or-create`.
- [ ] `terraform validate` succeeds against the scaffold with no other `.tf`
      files present.
- [ ] Root `package.json` defines `test` (`node --test tests/unit`),
      `test:unit`, `test:e2e`, and `test:bdd` scripts matching the chatbot's,
      and `tests/unit/`, `tests/bdd/features/`, `tests/bdd/steps/`, `tests/e2e/`
      directories exist.
- [ ] `.gitignore` ignores `.terraform/`, `*.tfstate*`, `packages/*.zip`,
      `node_modules/`, and `.env`.
- [ ] No AWS credential, account secret, or token value is committed in any
      file — the tfvars contain only the same non-secret ids the chatbot's do.

## Cucumber Tests
```gherkin
Feature: Terraform scaffold
  Scenario: The shared layer validates on its own
    Given only the scaffold terraform files are present
    When "terraform validate" is run in the terraform directory
    Then it exits with status 0

  Scenario: Resource names are prefixed per tenant and environment
    Given the dev/au tfvars are loaded
    When the name_prefix local is evaluated
    Then it equals "au-dev-receptionhq"

  Scenario: The calendar sub-domain is used, not the chatbot's
    Given the dev/au tfvars are loaded
    Then sub_domain equals "calendar"
    And the route53 record name starts with "calendar."

  Scenario: The state key does not collide with the chatbot's
    Given the dev/au init script
    When TF_STATE_KEY is read
    Then it contains "school_calendar"
    And it does not equal "terraform_dev_ohq_chatbot.tfstate"

  Scenario: A missing optional secret key does not break planning
    Given the app-config secret JSON omits "ANTHROPIC_API_KEY"
    When the secrets local is evaluated with lookup and an empty default
    Then evaluation succeeds and yields an empty string

  Scenario Outline: Every tenant has a config file
    Given the terraform config directory
    Then a tfvars file exists at "<path>"
    Examples:
      | path                |
      | config/dev/au.tfvars  |
      | config/prod/au.tfvars |
      | config/prod/uk.tfvars |
      | config/prod/us.tfvars |
```

## Additional Context
