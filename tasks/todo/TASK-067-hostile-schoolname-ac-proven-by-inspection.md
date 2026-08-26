---
id: TASK-067
title: The hostile-schoolName criterion is proven by inspection, contrary to its own wording
status: todo
created: 2026-08-18T08:20:00.000Z
updated: 2026-08-18T08:20:00.000Z
review-of: TASK-007
severity: medium
---

## Description
TASK-007's acceptance criterion reads: a hostile `schoolName` "does not change
the extraction result for a fixed email body — **proven with a stubbed model
response, not by inspection**."

`tests/unit/calendar-extraction.test.js:1215-1233` only substring-matches the
built prompt text. It never stubs `createMessage`, and never compares
`extractFromMessage` results for a benign versus a hostile `schoolName`.

So the criterion is recorded as met by exactly the method it explicitly ruled
out.

Fix: stub the model response, run `extractFromMessage` twice over one fixed
email body — once with a benign `schoolName`, once with a hostile one designed
to look like instructions — and assert the extracted events are identical.

## Impact If Not Fixed
An explicitly-worded security criterion is recorded as met while the behaviour it
names has never been executed end to end. `schoolName` is user-controlled
settings data, so if a poisoned value could steer extraction, the result is
attacker-influenced events written to a parent's calendar — and nothing today
would detect it.

## Acceptance Criteria
- [ ] A test stubs the model response and runs extraction over one fixed body with a benign `schoolName` and with a hostile one.
- [ ] The extracted events are asserted identical across both runs.
- [ ] The hostile value includes instruction-shaped text and delimiter-shaped text.
- [ ] The test fails if `schoolName` is interpolated outside its delimited block, verified by mutation with the mutation confirmed to have applied.
- [ ] The same treatment is applied to a hostile domain entry.
- [ ] The full suite passes.

## Cucumber Tests
```gherkin
Feature: A poisoned school name cannot steer extraction
  Scenario: Extraction is unchanged by a hostile school name
    Given a fixed email body and a stubbed model response
    When extraction runs with a benign school name
    And extraction runs with a hostile school name
    Then both runs produce identical events

  Scenario: Escaping the delimited block is caught
    Given schoolName is interpolated outside its block
    When the suite runs
    Then at least one test fails
```

## Additional Context
