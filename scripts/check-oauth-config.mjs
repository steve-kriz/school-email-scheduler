#!/usr/bin/env node
/**
 * check-oauth-config — preflight for the per-tenant app-config secret.
 *
 * Usage:
 *   npm run check:oauth-config -- --env dev --tenant au
 *   node scripts/check-oauth-config.mjs --env prod --tenant uk [--region eu-west-2]
 *
 * Reads `${environment}-${tenant}/app-config/school_calendar_services` from AWS
 * Secrets Manager and reports **key presence and shape only**:
 *   - every required key present and non-empty
 *   - GOOGLE_CLIENT_ID ends with .apps.googleusercontent.com
 *   - SESSION_SECRET decodes to at least 32 bytes
 *   - ANTHROPIC_API_KEY carries the expected Anthropic prefix
 *
 * Exits 0 when every check passes, 1 otherwise (including argument errors).
 *
 * SECURITY: this script must never print, log, or otherwise emit a secret
 * value — not even a prefix or a truncation, which is still key material. Only
 * key names, byte lengths, encodings and pass/fail verdicts are printed. That
 * rule is why JSON parse failures are reported without the parser's message
 * (Node embeds a snippet of the offending input in it) and why no check ever
 * interpolates a value into its reason string.
 *
 * See docs/google-oauth-setup.md for the surrounding runbook.
 */

import { pathToFileURL } from 'node:url';

const LOG_PREFIX = '[check-oauth-config]';

/** Keys the app-config secret must carry. */
export const REQUIRED_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SESSION_SECRET',
  'ANTHROPIC_API_KEY',
  'ALLOWED_ORIGINS'
];

/** Suffix every Google OAuth web client id carries. */
export const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/** Prefix every Anthropic API key carries. */
export const ANTHROPIC_KEY_PREFIX = 'sk-ant-';

/** Minimum decoded key material for the session cookie HMAC. */
export const MIN_SESSION_SECRET_BYTES = 32;

/**
 * Region each environment/tenant pair is deployed to, mirroring
 * terraform/config/<environment>/<tenant>.tfvars. Used only as a default for
 * the real AWS lookup; an unknown pair falls back to the ambient region.
 */
export const TENANT_REGIONS = {
  'dev-au': 'ap-southeast-2',
  'prod-au': 'ap-southeast-2',
  'prod-uk': 'eu-west-2',
  'prod-us': 'us-west-1'
};

const DEFAULT_REGION = 'ap-southeast-2';

export const USAGE = [
  'Usage: node scripts/check-oauth-config.mjs --env <environment> --tenant <tenant> [--region <aws-region>]',
  '',
  '  --env     Environment name, e.g. dev or prod            (required)',
  '  --tenant  Tenant short name, e.g. au, uk or us          (required)',
  '  --region  AWS region override; defaults to the tenant region',
  '  --help    Show this message',
  '',
  'Example: npm run check:oauth-config -- --env dev --tenant au'
].join('\n');

/**
 * Build the Secrets Manager secret id for an environment/tenant pair. Mirrors
 * local.secret_name in terraform/variables.tf.
 * @param {string} environment
 * @param {string} tenant
 * @returns {string}
 */
export function secretIdFor(environment, tenant) {
  return `${environment}-${tenant}/app-config/school_calendar_services`;
}

/**
 * Resolve the region for an environment/tenant pair.
 * @param {string} environment
 * @param {string} tenant
 * @returns {string}
 */
export function regionFor(environment, tenant) {
  return TENANT_REGIONS[`${environment}-${tenant}`]
    || process.env.AWS_REGION
    || process.env.AWS_DEFAULT_REGION
    || DEFAULT_REGION;
}

/**
 * Parse CLI arguments. Never throws — a bad invocation comes back as an error
 * string so the caller can print usage and exit 1 rather than a stack trace.
 * @param {string[]} argv Arguments after the script name.
 * @returns {{ environment?: string, tenant?: string, region?: string, help?: boolean, error?: string }}
 */
export function parseArgs(argv = []) {
  const out = {};
  const args = Array.isArray(argv) ? argv.slice() : [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);

    if (flag !== '--env' && flag !== '--environment' && flag !== '--tenant' && flag !== '--region') {
      return { error: `unknown argument "${flag}"` };
    }

    if (value === undefined) {
      value = args[i + 1];
      // A following flag is not this flag's value.
      if (value === undefined || value.startsWith('--')) {
        return { error: `${flag} requires a value` };
      }
      i++;
    }

    if (flag === '--env' || flag === '--environment') out.environment = value.trim();
    else if (flag === '--tenant') out.tenant = value.trim();
    else out.region = value.trim();
  }

  if (!out.environment) return { error: 'missing required argument --env' };
  if (!out.tenant) return { error: 'missing required argument --tenant' };

  return out;
}

/**
 * Byte length of a value's strictest plausible decoding, with the encoding it
 * was read as. Hex and padded base64/base64url are decoded; anything else is
 * measured as raw UTF-8 bytes.
 * @param {string} value
 * @returns {{ bytes: number, encoding: 'hex'|'base64'|'base64url'|'utf8' }}
 */
export function decodedByteLength(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { bytes: 0, encoding: 'utf8' };
  }

  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return { bytes: value.length / 2, encoding: 'hex' };
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    return { bytes: Buffer.from(value, 'base64').length, encoding: 'base64' };
  }

  if (/^[A-Za-z0-9\-_]+$/.test(value) && value.length % 4 === 0) {
    return { bytes: Buffer.from(value, 'base64url').length, encoding: 'base64url' };
  }

  return { bytes: Buffer.byteLength(value, 'utf8'), encoding: 'utf8' };
}

/**
 * Run every check against a decoded secret payload. Pure: no I/O, no logging.
 * Returned reasons are safe to print — they name keys, byte counts and
 * encodings, never values.
 * @param {object} secret Parsed secret payload.
 * @returns {{ ok: boolean, results: Array<{ key: string, check: string, ok: boolean, detail: string }> }}
 */
export function checkConfig(secret) {
  const payload = (secret && typeof secret === 'object' && !Array.isArray(secret)) ? secret : {};
  const results = [];

  const present = {};
  for (const key of REQUIRED_KEYS) {
    const raw = payload[key];
    const isString = typeof raw === 'string';
    const value = isString ? raw : '';
    const nonEmpty = isString && value.trim().length > 0;
    present[key] = nonEmpty ? value : null;

    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      results.push({ key, check: 'present', ok: false, detail: 'key missing from secret payload' });
    } else if (!isString) {
      results.push({ key, check: 'present', ok: false, detail: `expected a string, got ${Array.isArray(raw) ? 'array' : typeof raw}` });
    } else if (!nonEmpty) {
      results.push({ key, check: 'present', ok: false, detail: 'present but empty' });
    } else {
      results.push({ key, check: 'present', ok: true, detail: `${Buffer.byteLength(value, 'utf8')} bytes` });
    }
  }

  // Shape: GOOGLE_CLIENT_ID suffix.
  const clientId = present.GOOGLE_CLIENT_ID;
  if (clientId === null) {
    results.push({
      key: 'GOOGLE_CLIENT_ID',
      check: 'suffix',
      ok: false,
      detail: `cannot evaluate; key missing or empty (expected suffix ${GOOGLE_CLIENT_ID_SUFFIX})`
    });
  } else {
    const ok = clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX);
    results.push({
      key: 'GOOGLE_CLIENT_ID',
      check: 'suffix',
      ok,
      detail: ok
        ? `ends with ${GOOGLE_CLIENT_ID_SUFFIX}`
        : `does not end with ${GOOGLE_CLIENT_ID_SUFFIX}`
    });
  }

  // Shape: SESSION_SECRET entropy.
  const sessionSecret = present.SESSION_SECRET;
  if (sessionSecret === null) {
    results.push({
      key: 'SESSION_SECRET',
      check: 'entropy',
      ok: false,
      detail: `cannot evaluate; key missing or empty (need at least ${MIN_SESSION_SECRET_BYTES} bytes)`
    });
  } else {
    const { bytes, encoding } = decodedByteLength(sessionSecret);
    const ok = bytes >= MIN_SESSION_SECRET_BYTES;
    results.push({
      key: 'SESSION_SECRET',
      check: 'entropy',
      ok,
      detail: `${bytes} bytes decoded as ${encoding}; need at least ${MIN_SESSION_SECRET_BYTES}`
    });
  }

  // Shape: ANTHROPIC_API_KEY prefix.
  const anthropicKey = present.ANTHROPIC_API_KEY;
  if (anthropicKey === null) {
    results.push({
      key: 'ANTHROPIC_API_KEY',
      check: 'prefix',
      ok: false,
      detail: `cannot evaluate; key missing or empty (expected prefix ${ANTHROPIC_KEY_PREFIX})`
    });
  } else {
    const ok = anthropicKey.startsWith(ANTHROPIC_KEY_PREFIX);
    results.push({
      key: 'ANTHROPIC_API_KEY',
      check: 'prefix',
      ok,
      detail: ok
        ? `starts with expected prefix ${ANTHROPIC_KEY_PREFIX}`
        : `does not start with expected prefix ${ANTHROPIC_KEY_PREFIX}`
    });
  }

  return { ok: results.every(r => r.ok), results };
}

/**
 * Fetch the secret string from AWS Secrets Manager.
 *
 * `@aws-sdk/client-secrets-manager` is deliberately NOT a dependency of the root
 * package (which carries test tooling only), so it is imported lazily here and
 * only on the real path. That keeps this module importable — and every branch
 * unit-testable via the injectable `fetchSecret` — without the SDK installed and
 * without AWS credentials.
 *
 * @param {{ secretId: string, region: string }} args
 * @returns {Promise<string>} The raw SecretString.
 */
export async function fetchSecretFromAws({ secretId, region }) {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return response.SecretString ?? '';
}

/**
 * Run the preflight.
 * @param {object} [options]
 * @param {string[]} [options.argv] Arguments after the script name.
 * @param {(args: { secretId: string, region: string, environment: string, tenant: string }) => Promise<string|object>} [options.fetchSecret]
 *   Secret fetcher. May resolve to a raw JSON string (as Secrets Manager returns)
 *   or to an already-parsed object. Defaults to the real AWS lookup.
 * @param {(line: string) => void} [options.log] Line sink; defaults to console.log.
 * @returns {Promise<number>} Process exit code: 0 all checks passed, 1 otherwise.
 */
export async function run({ argv = [], fetchSecret = fetchSecretFromAws, log = console.log } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    log(USAGE);
    return 0;
  }

  if (args.error) {
    log(`${LOG_PREFIX} error: ${args.error}`);
    log(USAGE);
    return 1;
  }

  const { environment, tenant } = args;
  const region = args.region || regionFor(environment, tenant);
  const secretId = secretIdFor(environment, tenant);

  log(`${LOG_PREFIX} environment=${environment} tenant=${tenant} region=${region}`);
  log(`${LOG_PREFIX} secret=${secretId}`);

  let fetched;
  try {
    fetched = await fetchSecret({ secretId, region, environment, tenant });
  } catch (err) {
    // AWS/SDK errors carry no key material; still keep this to name + message.
    log(`${LOG_PREFIX} FAIL  secret could not be read: ${err?.name || 'Error'}: ${err?.message || 'unknown error'}`);
    log(`${LOG_PREFIX} 0 passed, 1 failed`);
    return 1;
  }

  let secret;
  if (typeof fetched === 'string') {
    try {
      secret = JSON.parse(fetched);
    } catch {
      // Deliberately no parser message: Node embeds a snippet of the input,
      // which would be secret material.
      log(`${LOG_PREFIX} FAIL  secret payload is not valid JSON (${Buffer.byteLength(fetched, 'utf8')} bytes read)`);
      log(`${LOG_PREFIX} 0 passed, 1 failed`);
      return 1;
    }
  } else {
    secret = fetched;
  }

  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) {
    log(`${LOG_PREFIX} FAIL  secret payload is not a JSON object`);
    log(`${LOG_PREFIX} 0 passed, 1 failed`);
    return 1;
  }

  const { ok, results } = checkConfig(secret);

  for (const result of results) {
    const verdict = result.ok ? 'PASS' : 'FAIL';
    log(`${LOG_PREFIX} ${verdict}  ${result.key} [${result.check}] ${result.detail}`);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  log(`${LOG_PREFIX} ${passed} passed, ${failed} failed`);

  if (!ok) {
    const offenders = [...new Set(results.filter(r => !r.ok).map(r => r.key))];
    log(`${LOG_PREFIX} FAILED keys: ${offenders.join(', ')}`);
  }

  return ok ? 0 : 1;
}

/* c8 ignore start */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run({ argv: process.argv.slice(2) })
    .then(code => { process.exitCode = code; })
    .catch(err => {
      // Last-resort guard: no stack trace, no value interpolation.
      console.log(`${LOG_PREFIX} FAIL  unexpected error: ${err?.name || 'Error'}`);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
