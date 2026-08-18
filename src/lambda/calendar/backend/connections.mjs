/**
 * connections.mjs - the only module that touches the calendar connections table.
 *
 * Table shape is documented in terraform/dynamodb_calendar_connections.tf:
 * hash key `userId` = "google#<google sub>", one row per connected Google
 * account, holding the WRAPPED Gmail refresh token (`refreshTokenEnc`, base64
 * KMS ciphertext) and the ARN of the key that wrapped it
 * (`refreshTokenKeyId`). There is deliberately no `refreshToken` attribute and no
 * `ttl` attribute - this row is the app's only copy of the user's OAuth grant.
 *
 * CONTAINMENT RULE: `refreshTokenEnc` never leaves this module. `getConnection`
 * strips it and reports only the derived boolean `hasRefreshToken`, and the only
 * way to obtain the token itself is `getRefreshToken`, which decrypts and returns
 * the plaintext to a caller that has asked for it explicitly. Anything that
 * serialises a connection into an HTTP response must go through `toPublicJson`,
 * which is an allow-list projection rather than a delete-list - a new attribute
 * added by a later ticket is therefore private until someone chooses to expose
 * it.
 *
 * TESTABILITY: `@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb` are imported
 * lazily inside the three I/O functions, and every public function takes those
 * functions as injectable parameters with real defaults. The module imports
 * cleanly, and every branch is reachable, with the SDK absent and no AWS
 * credentials.
 *
 * SECURITY: nothing here logs a token, a ciphertext or a key id at any level.
 */

import { encryptSecret, decryptSecret } from "./crypto.mjs";

/** Every user id is namespaced by its identity provider. */
export const USER_ID_PREFIX = "google#";

/** Attribute that must never be handed to a caller outside this module. */
export const SECRET_ATTRIBUTES = ["refreshTokenEnc"];

/**
 * Attributes `toPublicJson` is allowed to emit, mapped from the stored row.
 * Extended by later tickets as the UI needs more (schedule, search domains).
 */
export const PUBLIC_ATTRIBUTES = ["email", "schoolName"];

/**
 * Whether the caller could determine the connection state at all.
 *
 * "not_connected" and "unknown" are deliberately DIFFERENT answers. Collapsing
 * them means a transient DynamoDB error renders in the UI as a confident "not
 * connected", which invites the user to re-authorise a grant they already hold -
 * minting a second refresh token and overwriting a working connection to fix
 * what was a blip. A caller that cannot tell the two apart cannot avoid that.
 */
export const CONNECTION_STATUS = {
  CONNECTED: "connected",
  NOT_CONNECTED: "not_connected",
  UNKNOWN: "unknown",
};

/** Fallback region when the Lambda runtime has not set AWS_REGION. */
const DEFAULT_REGION = "ap-southeast-2";

let documentClientPromise = null;

/**
 * Build the connections-table key for a Google `sub` claim.
 * @param {string} sub
 * @returns {string}
 */
export function connectionUserId(sub) {
  if (typeof sub !== "string" || !sub) {
    throw new Error("connectionUserId: sub is required");
  }
  return sub.startsWith(USER_ID_PREFIX) ? sub : `${USER_ID_PREFIX}${sub}`;
}

/**
 * Resolve the table name, or "" when unconfigured so callers can raise an error
 * naming the variable.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveTableName(env = process.env) {
  return (env.CALENDAR_CONNECTIONS_TABLE || "").trim();
}

/**
 * Lazily construct (and cache per container) the DynamoDB document client.
 * Never called on an injected-dependency path.
 * @returns {Promise<object>}
 */
export async function getDocumentClient() {
  if (!documentClientPromise) {
    documentClientPromise = (async () => {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      return DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
        }),
        // Undefined attributes are dropped rather than rejected, so an optional
        // field the caller left unset does not fail the whole write.
        { marshallOptions: { removeUndefinedValues: true } }
      );
    })();
  }
  return documentClientPromise;
}

/** Drop the cached document client (tests, credential changes). */
export function resetDocumentClient() {
  documentClientPromise = null;
}

/**
 * Real DynamoDB GetItem. Default `getItem` dependency.
 * @param {{ tableName: string, key: object }} args
 * @returns {Promise<object|null>} The item, or null when absent.
 */
export async function ddbGetItem({ tableName, key }) {
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new GetCommand({ TableName: tableName, Key: key }));
  return result?.Item || null;
}

/**
 * Real DynamoDB PutItem. Default `putItem` dependency.
 * @param {{ tableName: string, item: object }} args
 * @returns {Promise<void>}
 */
export async function ddbPutItem({ tableName, item }) {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  await client.send(new PutCommand({ TableName: tableName, Item: item }));
}

/**
 * Real DynamoDB UpdateItem for a flat SET patch. Default `updateItem`
 * dependency.
 *
 * Attribute names go through `#n0`-style placeholders because several column
 * names in this schema (`timezone`, `status`-like fields added later) are
 * DynamoDB reserved words that cannot appear bare in an UpdateExpression.
 *
 * @param {{ tableName: string, key: object, updates: Record<string, unknown> }} args
 * @returns {Promise<object|null>} The updated attributes.
 */
export async function ddbUpdateItem({ tableName, key, updates }) {
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();

  const names = {};
  const values = {};
  const sets = [];
  let i = 0;
  for (const [attribute, value] of Object.entries(updates)) {
    const nameKey = `#n${i}`;
    const valueKey = `:v${i}`;
    names[nameKey] = attribute;
    values[valueKey] = value;
    sets.push(`${nameKey} = ${valueKey}`);
    i += 1;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return result?.Attributes || null;
}

/**
 * Strip the wrapped token out of a stored row and replace it with the derived
 * boolean callers actually need.
 *
 * @param {object|null} item
 * @returns {object|null}
 */
export function stripSecrets(item) {
  if (!item || typeof item !== "object") return null;
  const safe = { ...item };
  const hasRefreshToken = typeof item.refreshTokenEnc === "string" && item.refreshTokenEnc.length > 0;
  for (const attribute of SECRET_ATTRIBUTES) {
    delete safe[attribute];
  }
  safe.hasRefreshToken = hasRefreshToken;
  return safe;
}

/**
 * Project a connection for an HTTP response.
 *
 * Allow-list, not deny-list. `connected` is derived from whether a wrapped
 * refresh token exists, never from the token itself, so no response body can
 * carry token material.
 *
 * `connectionStatus` carries the answer `connected` cannot express: whether the
 * state is KNOWN. A caller that could not read the table passes
 * `lookupFailed: true` and gets `connected: false` with
 * `connectionStatus: "unknown"`, so the UI can say "could not check" instead of
 * inviting the user to re-authorise a grant they already hold. `connected` stays
 * a plain boolean, and is only ever `true` when a stored grant was actually seen.
 *
 * @param {object|null} connection A row from `getConnection`, or null.
 * @param {object} [fallback] Values to fall back on when there is no row yet
 *   (the session's email, typically - a user who has signed in but whose row has
 *   not been written).
 * @param {object} [options]
 * @param {boolean} [options.lookupFailed] True when the read threw, i.e. the
 *   connection state could not be determined.
 * @returns {{ email: string|null, schoolName: string|null, connected: boolean, connectionStatus: string }}
 */
export function toPublicJson(connection, fallback = {}, { lookupFailed = false } = {}) {
  const source = connection && typeof connection === "object" ? connection : {};
  const out = {};
  for (const attribute of PUBLIC_ATTRIBUTES) {
    const value = source[attribute] !== undefined ? source[attribute] : fallback[attribute];
    out[attribute] = value === undefined || value === null || value === "" ? null : value;
  }

  const known = lookupFailed !== true;
  out.connected = known && source.hasRefreshToken === true;
  out.connectionStatus = !known
    ? CONNECTION_STATUS.UNKNOWN
    : out.connected
      ? CONNECTION_STATUS.CONNECTED
      : CONNECTION_STATUS.NOT_CONNECTED;
  return out;
}

/**
 * Fetch a connection row, without its wrapped token.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object }) => Promise<object|null>} [deps.getItem]
 * @param {string|null} [deps.tableName]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} Row with `hasRefreshToken` and no
 *   `refreshTokenEnc`, or null when the user has never connected.
 */
export async function getConnection(userId, { getItem = ddbGetItem, tableName = null, env = process.env } = {}) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("getConnection: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("getConnection: userId is required");

  const item = await getItem({ tableName: table, key: { userId } });
  return stripSecrets(item);
}

/**
 * Decrypt and return a user's Gmail refresh token.
 *
 * The one sanctioned way out of this module for token material. Callers must not
 * log it, must not put it in a response body, and should hold it no longer than
 * the Gmail call that needs it.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object }) => Promise<object|null>} [deps.getItem]
 * @param {(ciphertext: string, options: object) => Promise<string>} [deps.decrypt]
 * @param {string|null} [deps.tableName]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<string|null>} Plaintext refresh token, or null when the user
 *   has no stored grant.
 */
export async function getRefreshToken(userId, { getItem = ddbGetItem, decrypt = decryptSecret, tableName = null, env = process.env } = {}) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("getRefreshToken: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("getRefreshToken: userId is required");

  const item = await getItem({ tableName: table, key: { userId } });
  const ciphertext = item?.refreshTokenEnc;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) return null;

  return decrypt(ciphertext, { keyId: item?.refreshTokenKeyId || null, env });
}

/**
 * Upsert a connection row, wrapping the refresh token on the way in.
 *
 * The plaintext `refreshToken` argument is encrypted here and never written: the
 * item handed to DynamoDB carries `refreshTokenEnc` + `refreshTokenKeyId` and no
 * plaintext attribute of any name.
 *
 * When `refreshToken` is empty (Google omits it on a repeat consent that was not
 * forced) any token already stored is PRESERVED rather than blanked - losing it
 * would silently break scanning until the user re-consented. `createdAt` is
 * likewise preserved from the existing row.
 *
 * @param {object} connection
 * @param {string} [connection.userId]      Either this or `sub` is required.
 * @param {string} [connection.sub]         Google `sub`; namespaced automatically.
 * @param {string} [connection.email]
 * @param {string} [connection.refreshToken] PLAINTEXT; encrypted before write.
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object }) => Promise<object|null>} [deps.getItem]
 * @param {(args: { tableName: string, item: object }) => Promise<void>} [deps.putItem]
 * @param {(plaintext: string, options: object) => Promise<{ciphertext: string, keyId: string}>} [deps.encrypt]
 * @param {string|null} [deps.tableName]
 * @param {() => string} [deps.now] ISO-8601 clock.
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object>} The stored row, with secrets stripped.
 */
export async function putConnection(
  connection,
  {
    getItem = ddbGetItem,
    putItem = ddbPutItem,
    encrypt = encryptSecret,
    tableName = null,
    now = () => new Date().toISOString(),
    env = process.env,
  } = {}
) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("putConnection: CALENDAR_CONNECTIONS_TABLE is not set");

  const { userId: explicitUserId, sub, refreshToken, ...attributes } = connection || {};
  const userId = explicitUserId || (sub ? connectionUserId(sub) : "");
  if (!userId) throw new Error("putConnection: userId or sub is required");

  // Guard the containment rule at the write boundary too: a caller must not be
  // able to smuggle a plaintext token in under another attribute name.
  if (Object.prototype.hasOwnProperty.call(attributes, "refreshTokenEnc")) {
    throw new Error("putConnection: pass the plaintext as refreshToken; refreshTokenEnc is written by this module");
  }

  const existing = (await getItem({ tableName: table, key: { userId } })) || null;
  const timestamp = now();

  const item = {
    ...(existing || {}),
    ...attributes,
    userId,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    const { ciphertext, keyId } = await encrypt(refreshToken, { env });
    item.refreshTokenEnc = ciphertext;
    item.refreshTokenKeyId = keyId;
  }

  // Belt and braces: no attribute named after the plaintext, ever.
  delete item.refreshToken;

  await putItem({ tableName: table, item });
  return stripSecrets(item);
}

/**
 * Patch selected attributes of an existing connection row.
 *
 * Token attributes are rejected: the plaintext must never be written, and the
 * ciphertext is `putConnection`'s job (it also records the matching key ARN, and
 * writing one without the other is how a row becomes undecryptable).
 *
 * @param {string} userId
 * @param {Record<string, unknown>} patch
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object, updates: object }) => Promise<object|null>} [deps.updateItem]
 * @param {string|null} [deps.tableName]
 * @param {() => string} [deps.now]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} The updated row, with secrets stripped.
 */
export async function updateConnection(
  userId,
  patch,
  { updateItem = ddbUpdateItem, tableName = null, now = () => new Date().toISOString(), env = process.env } = {}
) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("updateConnection: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("updateConnection: userId is required");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("updateConnection: patch must be an object");
  }

  for (const forbidden of ["refreshToken", "refreshTokenEnc", "refreshTokenKeyId"]) {
    if (Object.prototype.hasOwnProperty.call(patch, forbidden)) {
      throw new Error(`updateConnection: ${forbidden} cannot be patched; use putConnection`);
    }
  }

  const updates = { ...patch, updatedAt: now() };
  const attributes = await updateItem({ tableName: table, key: { userId }, updates });
  return stripSecrets(attributes);
}
