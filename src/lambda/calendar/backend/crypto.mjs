/**
 * crypto.mjs - KMS wrap/unwrap for the one secret this app stores at rest: the
 * Gmail refresh token.
 *
 * The connections table never holds a plaintext token (see
 * terraform/dynamodb_calendar_connections.tf - there is deliberately no
 * `refreshToken` attribute in that schema). Everything written to
 * `refreshTokenEnc` passes through `encryptSecret` first, and the CMK ARN that
 * wrapped it is returned alongside so the caller can record it in
 * `refreshTokenKeyId`. Storing the key ARN next to the ciphertext is what makes
 * a key rotation or key swap DETECTABLE per row: `needsRewrap` compares the
 * stored ARN with the currently configured one, so a stale row can be re-wrapped
 * instead of silently failing to decrypt years later.
 *
 * TESTABILITY: `@aws-sdk/client-kms` is imported lazily, inside the real I/O
 * functions only, and every public function takes its I/O dependency as a
 * parameter with a real default (the pattern scripts/check-oauth-config.mjs
 * uses). This module therefore imports cleanly, and every branch is reachable,
 * with the SDK absent and with no AWS credentials.
 *
 * SECURITY: nothing in this module logs. Not the plaintext, not the ciphertext,
 * not the key id, at any log level - a ciphertext plus a key ARN is still
 * material an attacker can work with, and the plaintext is the OAuth grant
 * itself.
 */

import { timingSafeEqual } from "node:crypto";

/** Fallback region when the Lambda runtime has not set AWS_REGION. */
const DEFAULT_REGION = "ap-southeast-2";

// Cached KMS client promise. Lambda containers are reused, so the client (and
// its credential resolution) is built at most once per container. Exposed via
// `resetKmsClient` so a test can drop it without reaching into module state.
let kmsClientPromise = null;

/**
 * Lazily construct (and cache) the real KMS client.
 *
 * Not called on any injected-dependency path, which is why the SDK can be
 * absent in unit tests.
 *
 * @returns {Promise<object>} An `@aws-sdk/client-kms` KMSClient.
 */
export async function getKmsClient() {
  if (!kmsClientPromise) {
    kmsClientPromise = (async () => {
      const { KMSClient } = await import("@aws-sdk/client-kms");
      return new KMSClient({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
      });
    })();
  }
  return kmsClientPromise;
}

/** Drop the cached KMS client (tests, and after a credential change). */
export function resetKmsClient() {
  kmsClientPromise = null;
}

/**
 * Real KMS Encrypt call. The default `encrypt` dependency of `encryptSecret`.
 *
 * @param {{ keyId: string, plaintext: string }} args
 * @returns {Promise<{ ciphertext: string, keyId: string }>} base64 ciphertext and
 *   the ARN of the key KMS actually used (which may be more specific than the
 *   alias or id that was passed in).
 */
export async function kmsEncrypt({ keyId, plaintext }) {
  const { EncryptCommand } = await import("@aws-sdk/client-kms");
  const client = await getKmsClient();
  const result = await client.send(
    new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.from(plaintext, "utf8"),
    })
  );
  return {
    ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
    keyId: result.KeyId || keyId,
  };
}

/**
 * Real KMS Decrypt call. The default `decrypt` dependency of `decryptSecret`.
 *
 * `KeyId` is passed whenever it is known even though a symmetric CMK does not
 * require it: supplying it makes KMS reject a ciphertext that was wrapped with
 * some other key rather than transparently decrypting it.
 *
 * @param {{ ciphertext: string, keyId?: string|null }} args base64 ciphertext.
 * @returns {Promise<string>} UTF-8 plaintext.
 */
export async function kmsDecrypt({ ciphertext, keyId = null }) {
  const { DecryptCommand } = await import("@aws-sdk/client-kms");
  const client = await getKmsClient();
  const params = { CiphertextBlob: Buffer.from(ciphertext, "base64") };
  if (keyId) params.KeyId = keyId;
  const result = await client.send(new DecryptCommand(params));
  return Buffer.from(result.Plaintext).toString("utf8");
}

/**
 * Is this string plausible base64? Used to fail fast on a corrupted
 * `refreshTokenEnc` before spending a KMS call on it.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBase64(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

/**
 * Resolve the configured CMK. Returns "" when unset so callers raise a
 * configuration error naming the variable rather than calling KMS with a blank
 * key id.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveKeyId(env = process.env) {
  return (env.CALENDAR_KMS_KEY_ID || "").trim();
}

/**
 * Encrypt a secret with the project CMK.
 *
 * @param {string} plaintext
 * @param {object} [options]
 * @param {string|null} [options.keyId]  Override the configured CMK.
 * @param {(args: { keyId: string, plaintext: string }) => Promise<{ciphertext: string, keyId?: string}|string>} [options.encrypt]
 *   Injectable KMS Encrypt. May resolve to `{ ciphertext, keyId }` or to a bare
 *   base64 string, so a test double can stay a one-liner.
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {Promise<{ ciphertext: string, keyId: string }>} base64 ciphertext plus
 *   the key ARN to record alongside it.
 */
export async function encryptSecret(plaintext, { keyId = null, encrypt = kmsEncrypt, env = process.env } = {}) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }

  const resolvedKeyId = keyId || resolveKeyId(env);
  if (!resolvedKeyId) {
    // Variable name only - there is no value to leak here, and naming it is
    // what makes the misconfiguration actionable.
    throw new Error("encryptSecret: CALENDAR_KMS_KEY_ID is not set");
  }

  const result = await encrypt({ keyId: resolvedKeyId, plaintext });
  const ciphertext = typeof result === "string" ? result : result?.ciphertext;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("encryptSecret: KMS returned no ciphertext");
  }

  return {
    ciphertext,
    keyId: (typeof result === "string" ? resolvedKeyId : result?.keyId) || resolvedKeyId,
  };
}

/**
 * Decrypt a base64 ciphertext produced by `encryptSecret`.
 *
 * @param {string} ciphertext base64 KMS ciphertext.
 * @param {object} [options]
 * @param {string|null} [options.keyId] Key ARN recorded with the ciphertext.
 * @param {(args: { ciphertext: string, keyId: string|null }) => Promise<string>} [options.decrypt]
 *   Injectable KMS Decrypt.
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {Promise<string>} plaintext.
 */
export async function decryptSecret(ciphertext, { keyId = null, decrypt = kmsDecrypt, env = process.env } = {}) {
  if (!isBase64(ciphertext)) {
    // No value in the message: the ciphertext itself is not printed.
    throw new Error("decryptSecret: ciphertext is not valid base64");
  }

  const resolvedKeyId = keyId || resolveKeyId(env) || null;
  const plaintext = await decrypt({ ciphertext, keyId: resolvedKeyId });
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("decryptSecret: KMS returned no plaintext");
  }
  return plaintext;
}

/**
 * Was this ciphertext wrapped with a key other than the one now configured?
 * True means the row should be re-wrapped (next time the user re-consents, or by
 * a migration) - this is the rotation detection the stored key ARN exists for.
 *
 * An unknown stored key id counts as needing a re-wrap: rows written before the
 * ARN was recorded cannot be proven current.
 *
 * @param {string|null|undefined} storedKeyId
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {boolean}
 */
export function needsRewrap(storedKeyId, { env = process.env } = {}) {
  const current = resolveKeyId(env);
  if (!current) return false; // Nothing to compare against; not a rotation signal.
  if (!storedKeyId) return true;
  return storedKeyId !== current;
}

/**
 * Constant-time equality for two strings.
 *
 * Lives here rather than in session.mjs so both the session HMAC check and the
 * OAuth `state` check can share one implementation. Only the LENGTHS are
 * compared with a normal operator; the bytes themselves always go through
 * `crypto.timingSafeEqual`, never `===`, which returns early on the first
 * differing byte and leaks the correct prefix through response timing.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret (it is visible in the cookie), so an early return here
  // reveals nothing that the attacker cannot already measure.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
