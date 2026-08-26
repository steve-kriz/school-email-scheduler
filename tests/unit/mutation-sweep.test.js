import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MAIN_TF_PATH = path.join(PROJECT_ROOT, 'terraform', 'main.tf');

/**
 * Copy of assertAllSecretReadsAreGuarded from terraform-scaffold.test.js
 */
function parseSecretsAccesses(content) {
  const guardedKeys = [];
  const violations = [];
  const OCCURRENCE = /local\.secrets/g;
  let match;
  while ((match = OCCURRENCE.exec(content)) !== null) {
    const rest = content.slice(match.index + match[0].length);
    const shape = rest.match(/^\s*(\[\s*(["'])([^"']+)\2\s*\]|\.[A-Za-z_][A-Za-z0-9_]*|,)/);
    if (!shape) {
      violations.push({ key: '(unrecognised)', context: rest.slice(0, 40).trim() });
      continue;
    }
    if (shape[1].startsWith('[')) {
      violations.push({ key: shape[3], context: 'direct index' });
    } else if (shape[1].startsWith('.')) {
      violations.push({ key: shape[1].slice(1), context: 'direct attribute access' });
    } else {
      const precedingText = content.slice(0, match.index);
      if (!/lookup\(\s*$/.test(precedingText)) {
        violations.push({ key: '(unknown)', context: 'local.secrets used outside a lookup() call' });
        continue;
      }
      const callRest = rest.match(/^\s*,\s*"([^"]+)"\s*,\s*"[^"]*"\s*\)/);
      if (!callRest) {
        violations.push({ key: '(unknown)', context: `lookup(local.secrets, ...) missing a quoted key/default: ${rest.slice(0, 60).trim()}` });
        continue;
      }
      guardedKeys.push(callRest[1]);
    }
  }
  return { guardedKeys, violations };
}

function assertAllSecretReadsAreGuarded(content, sourceLabel) {
  const { guardedKeys, violations } = parseSecretsAccesses(content);
  assert.equal(violations.length, 0,
    `${sourceLabel} contains ${violations.length} local.secrets access(es) that bypass lookup()'s default: ` +
    violations.map(v => `${v.key} (${v.context})`).join(', '));
  return guardedKeys;
}

describe('Mutation Sweep Tests', () => {
  describe('Mutation: Replace guarded lookups with direct indices', () => {
    // Back up the original before any mutations
    const originalMainTf = fs.readFileSync(MAIN_TF_PATH, 'utf-8');

    const MUTATIONS = [
      {
        name: 'GOOGLE_CLIENT_ID',
        find: 'lookup(local.secrets, "GOOGLE_CLIENT_ID", "")',
        replace: 'local.secrets["GOOGLE_CLIENT_ID"]'
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        find: 'lookup(local.secrets, "GOOGLE_CLIENT_SECRET", "")',
        replace: 'local.secrets["GOOGLE_CLIENT_SECRET"]'
      },
      {
        name: 'ANTHROPIC_API_KEY',
        find: 'lookup(local.secrets, "ANTHROPIC_API_KEY", "")',
        replace: 'local.secrets["ANTHROPIC_API_KEY"]'
      },
      {
        name: 'SESSION_SECRET',
        find: 'lookup(local.secrets, "SESSION_SECRET", "")',
        replace: 'local.secrets["SESSION_SECRET"]'
      },
      {
        name: 'ALLOWED_ORIGINS',
        find: 'lookup(local.secrets, "ALLOWED_ORIGINS", "")',
        replace: 'local.secrets["ALLOWED_ORIGINS"]'
      }
    ];

    MUTATIONS.forEach(mutation => {
      it(`Mutation: ${mutation.name} direct index is caught`, () => {
        const original = fs.readFileSync(MAIN_TF_PATH, 'utf-8');

        // Verify the lookup exists before mutating
        assert.ok(original.includes(mutation.find),
          `Could not find lookup for ${mutation.name} to mutate: ${mutation.find}`);

        // Apply mutation
        const mutated = original.replace(mutation.find, mutation.replace);

        // CRITICAL: Verify mutation actually applied (not silently no-op'd)
        assert.notEqual(mutated, original,
          `Mutation for ${mutation.name} did not apply - the file is unchanged. ` +
          `This would be a silent false green. Verify the find string is correct.`);

        // Verify the exact change is present
        assert.ok(mutated.includes(mutation.replace),
          `After mutation, the direct index for ${mutation.name} is not in the file`);

        // CRITICAL: Verify the original guarded version is gone
        assert.equal(mutated.includes(mutation.find), false,
          `After mutation, the guarded lookup for ${mutation.name} is still in the file`);

        // Now assert the guard check catches this violation
        assert.throws(
          () => assertAllSecretReadsAreGuarded(mutated, 'mutated main.tf'),
          /direct index/,
          `Guard check should fail for direct index on ${mutation.name}`
        );

        // Also verify it names the key
        let thrownError = null;
        try {
          assertAllSecretReadsAreGuarded(mutated, 'mutated main.tf');
        } catch (e) {
          thrownError = e;
        }
        assert.ok(thrownError.message.includes(mutation.name),
          `Error message should name the key ${mutation.name}, got: ${thrownError.message}`);
      });
    });

    it('All mutations applied successfully', () => {
      // Sanity check: main.tf should still match the original (not modified by mutations)
      const current = fs.readFileSync(MAIN_TF_PATH, 'utf-8');
      assert.equal(current, originalMainTf,
        'main.tf has been modified during mutation tests - it should have been restored after each mutation');
    });
  });
});
