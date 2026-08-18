/**
 * Dependency-free spawn target for the npm-script wiring assertions.
 *
 * tests/e2e/npm-scripts.test.js needs to execute the real `test:e2e` command and
 * prove it exits 0. Every other e2e file either spawns an external process
 * (terraform, npm) or imports application source, so a failure there would be
 * misattributed to npm-script wiring. This file imports only node builtins and
 * asserts nothing about the project, so the only way the spawn fails is if the
 * script's plumbing is broken.
 *
 * Intentionally NOT named "*.test.mjs": it must never be picked up by directory
 * discovery (`node --test tests/...`), only by an explicit path argument.
 */
import { it } from 'node:test';
import * as assert from 'node:assert';

it('runs with no external dependencies', () => {
  assert.ok(true, 'fixture always passes');
});
