---
id: TASK-055
title: The secrets parser masks nothing, so a commented-out lookup can satisfy the key-coverage guard
status: todo
created: 2026-08-18T07:05:00.000Z
updated: 2026-08-18T07:05:00.000Z
review-of: TASK-015
severity: medium
---

## Description
`tests/e2e/terraform-scaffold.test.js:229-262` does no comment, string or
heredoc masking. The review established that this errs in **two opposite
directions**, and only the safe one was documented:

- For the **violation** direction it fails safe: unmasked text can only ADD
  violations, never hide one. A false positive is noisy but harmless.
- For the **key-coverage** direction it fails **OPEN**: `guardedKeys` is
  populated from any text matching `lookup(local.secrets, "K", "")`, including
  inside a `#` comment or a `<<-EOT` heredoc. So the assertion at
  `terraform-scaffold.test.js:478-481` would accept a commented-out
  `lookup(local.secrets, "SESSION_SECRET", "")` as proof that key is guarded.

`tests/helpers/hcl-blocks.mjs`'s `maskNonCode` (built by TASK-017) already solves
exactly this and throws on an unterminated heredoc. Adopt it — which pairs
naturally with TASK-052's consolidation.

The separately documented limitation — matching inside longer identifiers such
as `local.secrets_value` (`tests/unit/parseSecretsAccesses.test.js:239`) — is a
false POSITIVE and is genuinely acceptable-and-documented. Leave it, or tighten
it with a word boundary while you are here.

## Impact If Not Fixed
An edit that removes a real guarded read while leaving a documentation comment
or heredoc example keeps the five-key coverage assertion green, so the key
silently stops being read at all. That is a deployable failure the suite is
specifically supposed to catch, and it is invisible because the test reports
success.

## Acceptance Criteria
- [ ] The parser masks strings, `#`/`//` comments and heredocs before classifying, via `maskNonCode` from `tests/helpers/hcl-blocks.mjs`.
- [ ] A commented-out or heredoc-embedded `lookup(local.secrets, "K", "")` does NOT count toward `guardedKeys`.
- [ ] Deleting a real guarded read while leaving a commented example reddens a test, verified by mutation with the mutation confirmed to have applied.
- [ ] An unterminated heredoc throws rather than silently mis-parsing.
- [ ] The false-positive behaviour on longer identifiers is either fixed with a word boundary or re-documented as deliberate.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: Only real code counts as a guarded secret read
  Scenario: A commented-out lookup does not prove a key is guarded
    Given the real lookup for SESSION_SECRET is deleted
    And a commented-out lookup for SESSION_SECRET remains
    When the guard runs
    Then it reports SESSION_SECRET as not guarded

  Scenario: A heredoc example does not prove a key is guarded
    Given a lookup for ANTHROPIC_API_KEY appears only inside a heredoc
    When the guard runs
    Then it reports ANTHROPIC_API_KEY as not guarded

  Scenario: An unterminated heredoc fails loudly
    Given a terraform file with an unterminated heredoc
    When the parser runs
    Then it throws rather than returning a partial result
```

## Additional Context
