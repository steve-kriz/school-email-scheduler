---
id: TASK-018
title: Runbook wrongly claims Terraform creates the app-config secret
status: testing
created: 2026-08-18T00:12:00Z
updated: 2026-08-18T01:14:58Z
review-of: TASK-012
activities: [{"activity":"code","model":"claude-opus-5","startedAt":"2026-08-18T00:59:30Z","finishedAt":"2026-08-18T01:11:15Z","tokens":99122,"note":"ownership investigated across 3 repos; guard mutation-verified 10/10"}]
---

## Description
`docs/google-oauth-setup.md` states, at lines 8–10 and again at 188–193, that
"Terraform creates and reads the secret, it never writes credentials into it".
That is false.

`terraform/main.tf` (lines 5–7) references the secret **only** through a
`data "aws_secretsmanager_secret_version"` source, which is read-only. There is
no `resource "aws_secretsmanager_secret"` anywhere under `terraform/`. Nothing
in this repository creates the secret.

Section 4's populate command uses `aws secretsmanager put-secret-value`, which
requires the secret to already exist, and the runbook never tells the operator
to create it first.

Fix the runbook to match reality:
- Correct both claims that Terraform creates the secret.
- Add the missing `aws secretsmanager create-secret` step before the
  `put-secret-value` step, with the secret name
  `${environment}-${tenant}/app-config/school_calendar_services` matching
  `local.secret_name`, and placeholder values only.
- Note that `create-secret` fails with `ResourceExistsException` if the secret
  is already present, and that this is the expected signal to skip straight to
  `put-secret-value` — so the runbook reads correctly for both a new tenant and
  an existing one.
- First establish whether another stack legitimately owns this secret. The
  reference project `ohq-chatbot2` reads its own secret
  (`${var.environment}-${var.tenant}/app-config/ohq_chatbot_services`) the same
  read-only way, so there may be a platform convention that a basestack or a
  manual step creates these. If so, say *that* explicitly instead of adding a
  `create-secret` step — the goal is a runbook whose stated ownership is true,
  not necessarily one that creates the secret itself.

Keep every value in the runbook a clearly-marked placeholder. Do not add a real
client id, secret, or key.

## Impact If Not Fixed
An operator provisioning a brand-new environment or tenant follows the runbook
end to end and hits `ResourceNotFoundException` on `put-secret-value`, because
the secret they were told Terraform had created does not exist. The subsequent
`terraform apply` then fails too, on the data source reading a nonexistent
secret version. Onboarding stalls on a confusing error, and the runbook actively
misleads them about where to look — they will search Terraform for a resource
that was never written.

## Acceptance Criteria
- [ ] The runbook no longer claims Terraform creates the Secrets Manager secret.
- [ ] The runbook states accurately what does create it — either an added
      `create-secret` step, or the named stack/manual process that owns it.
- [ ] If a `create-secret` step is added, its secret name matches
      `local.secret_name`
      (`${environment}-${tenant}/app-config/school_calendar_services`).
- [ ] The runbook explains that `ResourceExistsException` from `create-secret`
      means the secret already exists and `put-secret-value` is the next step.
- [ ] The runbook reads correctly for both a new tenant and an existing one.
- [ ] Every credential value in the runbook remains a marked placeholder.
- [ ] A test asserts the runbook does not claim Terraform creates the secret, so
      the incorrect statement cannot silently return.
- [ ] A test asserts that if the runbook names a `create-secret` step, the secret
      name in it matches the one `terraform/main.tf` reads.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: The runbook tells the truth about secret ownership
  Scenario: It does not claim Terraform creates the secret
    Given docs/google-oauth-setup.md
    Then it does not state that Terraform creates the secret

  Scenario: It names what actually creates the secret
    Given docs/google-oauth-setup.md
    Then it either documents a create-secret step or names the stack that owns the secret

  Scenario: The documented secret name matches Terraform
    Given a create-secret step in the runbook
    And the secret id read by terraform/main.tf
    Then the two names match

  Scenario: An existing secret is handled
    Given docs/google-oauth-setup.md
    Then it explains that ResourceExistsException means to skip to put-secret-value

  Scenario: A new tenant can be provisioned by following the runbook
    Given a tenant whose secret does not yet exist
    When the runbook steps are followed in order
    Then no step depends on a resource an earlier step failed to create

  Scenario: No real credentials appear
    Given docs/google-oauth-setup.md
    Then every credential value is a marked placeholder
```

## Additional Context
