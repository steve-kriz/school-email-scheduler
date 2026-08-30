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
 * CONTAINMENT RULE: `refreshTokenEnc` and `refreshTokenKeyId` (the KMS CMK ARN
 * that wrapped it) never leave this module. `getConnection` strips both and
 * reports only the derived boolean `hasRefreshToken`, and the only way to
 * obtain the token itself is `getRefreshToken`, which decrypts and returns
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

/** Attributes that must never be handed to a caller outside this module. */
export const SECRET_ATTRIBUTES = ["refreshTokenEnc", "refreshTokenKeyId"];

/**
 * Attributes `toPublicJson` is allowed to emit, mapped from the stored row.
 * Extended by later tickets as the UI needs more.
 *
 * Deliberately still absent: `lastHistoryId` (a Gmail internal watermark the UI
 * has no use for), `lastScanError` (raw error text, until a ticket decides how it
 * is presented), `refreshTokenKeyId`, `userId`, `createdAt`, `updatedAt`. Adding
 * an attribute here exposes it on EVERY route that projects a connection, so the
 * list grows one deliberate entry at a time.
 */
export const PUBLIC_ATTRIBUTES = [
  "email",
  // TASK-005 settings: what the user asked us to watch for. TASK-055 replaced the
  // `schoolNames`/`searchDomains` string sets with `processingJobs`, a List of
  // Maps - one named "search + extract" configuration per entry. The three legacy
  // attributes (`schoolNames`, `searchDomains` and the pre-TASK-053 `schoolName`
  // scalar) are deliberately NOT in this list: `toPublicJson` migrates them on
  // read into one synthesised job, so they are projected UNDER the new name and no
  // response body ever carries them.
  "processingJobs",
  // Schedule preferences (written by TASK-005's settings route and TASK-008).
  "scheduleEnabled",
  "scheduleFrequency",
  "scheduleHour",
  "timezone",
  // Scan watermark the settings page reports back to the user.
  "lastScanAt",
  "lastScanStatus",
];

/**
 * Sentinel patch value meaning "delete this attribute" rather than "set it".
 *
 * DynamoDB rejects an EMPTY string set: `searchDomains: new Set([])` fails the
 * write with a ValidationException rather than storing "no domains". The only way
 * to express "this user now has no domains" is to REMOVE the attribute, so a
 * patch value of `REMOVE_ATTRIBUTE` compiles to a `REMOVE` clause in
 * `ddbUpdateItem` instead of a `SET`. Do not "simplify" this back into writing
 * `[]` or `new Set()`.
 *
 * Also how a superseded attribute is retired: a settings save SETs
 * `processingJobs` and REMOVEs the legacy `schoolNames`, `searchDomains` and
 * `schoolName` attributes in ONE UpdateItem, which is why `buildUpdateParams`
 * compiles a mixed SET/REMOVE expression rather than one or the other.
 *
 * THE EMPTY-SET REASON DOES NOT APPLY TO A LIST (TASK-055). `processingJobs` is
 * an `L` of `M`, and an empty `L` stores perfectly well - so a job's empty
 * `searchTerms` is written as an empty list, not a removal. `buildConnectionPatch`
 * does still use this sentinel for a whole-list-empty `processingJobs`, but purely
 * so "unset" has ONE representation on the row; that is a consistency choice, not
 * a DynamoDB constraint.
 *
 * A Symbol cannot appear in a JSON request body, so no client can smuggle a
 * removal through a route that forwards a parsed payload as a patch.
 * `Symbol.for` (rather than a bare `Symbol`) keeps the sentinel comparable across
 * module instances, which matters when a test loads this module twice.
 */
export const REMOVE_ATTRIBUTE = Symbol.for("calendar.connections.REMOVE_ATTRIBUTE");

/**
 * How old a `scanStartedAt` lock must be before it is treated as abandoned
 * rather than active (TASK-008). A Lambda invocation that was itself killed by
 * its own timeout leaves `scanInProgress` set forever unless something else
 * expires it - this is that expiry.
 */
export const SCAN_LOCK_STALE_MS = 15 * 60 * 1000;

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
 * Compile a flat patch into UpdateItem parameters.
 *
 * Pure, and exported, so the expression building is testable with the AWS SDK
 * absent - which is the whole point of the lazy imports below it.
 *
 * Attribute names go through `#n0`-style placeholders because several column
 * names in this schema (`timezone`, `status`-like fields added later) are
 * DynamoDB reserved words that cannot appear bare in an UpdateExpression.
 *
 * Any patch entry whose value is `REMOVE_ATTRIBUTE` compiles to a `REMOVE`
 * clause instead of a `SET`, which is the only way to clear a string set (see the
 * sentinel's docblock: an empty SS is a write error, not an empty set).
 * `ExpressionAttributeValues` is omitted entirely when every entry is a removal,
 * because DynamoDB rejects an empty value map as well - so a removal-only patch
 * built with an empty map would fail for a second, unrelated reason.
 *
 * A `condition` (TASK-008's scan lock) adds a `ConditionExpression`, merging
 * its own `names`/`values` into the same maps the SET/REMOVE clause uses -
 * DynamoDB rejects a request with a `#name`/`:value` placeholder declared but
 * never referenced, so the merge (not two separate expression-attribute maps)
 * is what keeps a condition-only call, and a call with both a patch and a
 * condition, both valid.
 *
 * @param {{ tableName: string, key: object, updates: Record<string, unknown>, condition?: { expression: string, names?: object, values?: object } }} args
 * @returns {object} UpdateCommand input.
 */
export function buildUpdateParams({ tableName, key, updates, condition = null }) {
  const names = {};
  const values = {};
  const sets = [];
  const removes = [];
  let i = 0;
  for (const [attribute, value] of Object.entries(updates || {})) {
    const nameKey = `#n${i}`;
    names[nameKey] = attribute;
    if (value === REMOVE_ATTRIBUTE) {
      removes.push(nameKey);
    } else {
      const valueKey = `:v${i}`;
      values[valueKey] = value;
      sets.push(`${nameKey} = ${valueKey}`);
    }
    i += 1;
  }

  const clauses = [];
  if (sets.length > 0) clauses.push(`SET ${sets.join(", ")}`);
  if (removes.length > 0) clauses.push(`REMOVE ${removes.join(", ")}`);
  // An UpdateItem with no clauses is a syntax error at DynamoDB; fail here, where
  // the message can say what was actually wrong.
  if (clauses.length === 0) throw new Error("buildUpdateParams: updates is empty");

  const params = {
    TableName: tableName,
    Key: key,
    UpdateExpression: clauses.join(" "),
    ExpressionAttributeNames: names,
    ReturnValues: "ALL_NEW",
  };
  if (sets.length > 0) params.ExpressionAttributeValues = values;

  if (condition && typeof condition.expression === "string" && condition.expression) {
    params.ConditionExpression = condition.expression;
    if (condition.names) params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, ...condition.names };
    if (condition.values) params.ExpressionAttributeValues = { ...(params.ExpressionAttributeValues || {}), ...condition.values };
  }

  return params;
}

/**
 * Real DynamoDB UpdateItem for a flat patch. Default `updateItem` dependency.
 *
 * @param {{ tableName: string, key: object, updates: Record<string, unknown>, condition?: object }} args
 * @returns {Promise<object|null>} The updated attributes.
 */
export async function ddbUpdateItem({ tableName, key, updates, condition = null }) {
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(new UpdateCommand(buildUpdateParams({ tableName, key, updates, condition })));
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
 * Make one stored attribute value safe to put in a JSON response body.
 *
 * A DynamoDB string set arrives as a JS `Set` from the document client, or as
 * `{ SS: [...] }` from the low-level client. `JSON.stringify(new Set(["a"]))` is
 * `"{}"`, so without this a set-valued attribute such as `searchDomains` would
 * silently serialise to an empty object - a response that looks structurally
 * fine and has lost the data. Sets are unordered in DynamoDB, so the array is
 * sorted: responses then have a stable shape that a UI diff or an assertion can
 * rely on, instead of one that changes with storage order.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function jsonSafeValue(value) {
  if (value instanceof Set) return [...value].map(String).sort();
  // A List (`processingJobs`, TASK-055) is already JSON-safe, and its ORDER IS
  // THE USER'S - unlike a Set, a DynamoDB List preserves it - so it passes
  // through unsorted and untouched, objects and all.
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.SS)) {
    return [...value.SS].map(String).sort();
  }
  return value;
}

/**
 * Read a legacy string-set attribute in whatever shape it arrives in.
 *
 * `getConnection` returns RAW stored values, so a string set is a JS `Set` from
 * the document client, `{ SS: [...] }` from the low-level client, or a plain
 * array if something already normalised it. Blank entries are dropped.
 *
 * SORTED, ALWAYS. A DynamoDB string set is UNORDERED, so "the first entry" is only
 * well defined after sorting - without this, the job synthesised below could name a
 * different school on two reads of the same unchanged row. Matches the sort
 * `jsonSafeValue` already applies to a set.
 *
 * @param {unknown} value
 * @returns {string[]} Trimmed, non-empty, sorted.
 */
function legacyStringList(value) {
  const raw = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray(value.SS)
        ? value.SS
        : [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry).trim()))
    .filter((entry) => entry !== "")
    .sort();
}

/**
 * Synthesise one "Default" processing job from a row's legacy attributes.
 *
 * MIGRATE ON READ, WRITE NOTHING (TASK-055, following TASK-053's precedent). A row
 * saved before processing jobs existed carries `schoolNames`/`searchDomains` string
 * sets, or - if it has not been saved since TASK-053 either - a lone `schoolName`
 * scalar. Rather than run a batch migration, the old shape is folded into the new
 * one here, on every read, until its owner's next save clears the legacy
 * attributes for good (see `buildConnectionPatch`). No write is issued by a GET.
 *
 * The REMAINING legacy entries are folded in as `searchTerms` rather than dropped:
 * under the new model a job's school name, domain and search terms are all OR'd
 * together (TASK-056), so this preserves the full search coverage the user had.
 *
 * The result is NOT necessarily valid PUT input - a row with only domains yields
 * `schoolName: ""`, which the validator refuses. That is intended: the user fills
 * the gap before their first real save, and the rules are not relaxed to let a
 * half-migrated job through.
 *
 * @param {object} source Raw stored row.
 * @param {object} fallback
 * @returns {Array<object>|null} A one-element list, or null when there is no
 *   legacy data at all.
 */
function synthesizeLegacyProcessingJob(source, fallback) {
  let names = legacyStringList(source.schoolNames !== undefined ? source.schoolNames : fallback.schoolNames);
  if (names.length === 0) {
    // TASK-053's own fallback, still needed: a pre-TASK-053 row's school is a
    // bare scalar string, which reads as a one-element names list.
    const scalar = source.schoolName !== undefined ? source.schoolName : fallback.schoolName;
    if (typeof scalar === "string" && scalar.trim() !== "") names = [scalar.trim()];
  }
  const domains = legacyStringList(source.searchDomains !== undefined ? source.searchDomains : fallback.searchDomains);

  if (names.length === 0 && domains.length === 0) return null;

  return [
    {
      // A placeholder id, not a real one: it is re-synthesised on every read and
      // is replaced with a server-generated UUID the first time the user saves.
      id: "default",
      name: "Default",
      schoolName: names[0] || "",
      domain: domains[0] || "",
      searchTerms: [...names.slice(1), ...domains.slice(1)],
    },
  ];
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
 * THE ONE LEGACY READ IN THIS MODULE (TASK-053, extended by TASK-055): a row
 * written before processing jobs existed carries `schoolNames`/`searchDomains`
 * string sets, or a lone pre-TASK-053 `schoolName` scalar. It is projected here as
 * a single synthesised "Default" job (see `synthesizeLegacyProcessingJob`), so
 * both `/settings` and `/auth/me` - which share this function - see the new shape
 * and nothing downstream has to know the old one existed. A STORED
 * `processingJobs` list ALWAYS WINS; synthesis only runs when there is none or it
 * is empty, and no legacy key is ever emitted under its own name. The fallback
 * stays until it can be shown no row still has the old attributes; rows migrate
 * one at a time as their owners save (see `buildConnectionPatch`).
 *
 * @param {object|null} connection A row from `getConnection`, or null.
 * @param {object} [fallback] Values to fall back on when there is no row yet
 *   (the session's email, typically - a user who has signed in but whose row has
 *   not been written).
 * @param {object} [options]
 * @param {boolean} [options.lookupFailed] True when the read threw, i.e. the
 *   connection state could not be determined.
 * @returns {Record<string, unknown> & { connected: boolean, connectionStatus: string }}
 *   One key per PUBLIC_ATTRIBUTES entry (null when unset), plus the two derived
 *   connection fields.
 */
export function toPublicJson(connection, fallback = {}, { lookupFailed = false } = {}) {
  const source = connection && typeof connection === "object" ? connection : {};
  const out = {};
  for (const attribute of PUBLIC_ATTRIBUTES) {
    const value = source[attribute] !== undefined ? source[attribute] : fallback[attribute];
    out[attribute] = value === undefined || value === null || value === "" ? null : jsonSafeValue(value);
  }

  if (!Array.isArray(out.processingJobs) || out.processingJobs.length === 0) {
    const synthesized = synthesizeLegacyProcessingJob(source, fallback);
    if (synthesized) out.processingJobs = synthesized;
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
 * A patch value of `REMOVE_ATTRIBUTE` deletes that attribute instead of setting
 * it - the only way to clear a string set, because DynamoDB will not store an
 * empty one. The sentinel is passed straight through to `updateItem`.
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

/**
 * Attempt to acquire the per-user scan lock (TASK-008).
 *
 * A scan is not re-entrant: this sets `scanInProgress: true` and
 * `scanStartedAt` in ONE atomic UpdateItem, guarded by a ConditionExpression
 * so two concurrent invocations for the same user cannot both believe they
 * hold the lock - a plain read-then-write from the caller could not make that
 * guarantee. The condition passes when there is no lock at all
 * (`attribute_not_exists`) OR the existing lock is older than `staleAfterMs`:
 * a lock left behind by an invocation that was itself killed by a Lambda
 * timeout must not wedge the account forever.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {number} [deps.staleAfterMs]
 * @param {() => string} [deps.now] ISO-8601 clock.
 * @param {(args: { tableName: string, key: object, updates: object, condition?: object }) => Promise<object|null>} [deps.updateItem]
 * @param {string|null} [deps.tableName]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<boolean>} true when this call now holds the lock.
 */
export async function acquireScanLock(
  userId,
  {
    staleAfterMs = SCAN_LOCK_STALE_MS,
    now = () => new Date().toISOString(),
    updateItem = ddbUpdateItem,
    tableName = null,
    env = process.env,
  } = {}
) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("acquireScanLock: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("acquireScanLock: userId is required");

  const startedAt = now();
  const cutoff = new Date(Date.parse(startedAt) - staleAfterMs).toISOString();

  try {
    await updateItem({
      tableName: table,
      key: { userId },
      updates: { scanInProgress: true, scanStartedAt: startedAt },
      condition: {
        expression: "attribute_not_exists(#scanStartedAt) OR #scanStartedAt < :staleCutoff",
        names: { "#scanStartedAt": "scanStartedAt" },
        values: { ":staleCutoff": cutoff },
      },
    });
    return true;
  } catch (err) {
    // Classified by type, not message text, matching gmail.mjs/anthropic.mjs:
    // this is the SDK's own exception for a failed ConditionExpression.
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/**
 * Release the scan lock. Callers run this in a `finally`, so a scan that
 * throws still clears it - a lock that only ever expired after
 * `SCAN_LOCK_STALE_MS` would otherwise leave the account unscannable for up to
 * that long after every crashed run.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object, updates: object }) => Promise<object|null>} [deps.updateItem]
 * @param {string|null} [deps.tableName]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<void>}
 */
export async function releaseScanLock(userId, { updateItem = ddbUpdateItem, tableName = null, env = process.env } = {}) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("releaseScanLock: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("releaseScanLock: userId is required");

  await updateItem({
    tableName: table,
    key: { userId },
    updates: { scanInProgress: REMOVE_ATTRIBUTE, scanStartedAt: REMOVE_ATTRIBUTE },
  });
}

/**
 * Real DynamoDB DeleteItem. Default `deleteItem` dependency.
 *
 * `ReturnValues: "ALL_OLD"` is NOT decoration. DynamoDB's DeleteItem succeeds
 * against a key that was never there, so without the old image a caller cannot
 * tell "row removed" from "nothing to remove" - and a disconnect that reports
 * `connectionDeleted: true` for a row it never saw is a success message about a
 * deletion that may not have happened. ALL_OLD makes the outcome OBSERVED.
 *
 * The returned attributes carry `refreshTokenEnc`/`refreshTokenKeyId`, so this
 * value must not escape the module unstripped - `deleteConnection` below is the
 * only caller and reduces it to booleans.
 *
 * @param {{ tableName: string, key: object }} args
 * @returns {Promise<object|null>} The deleted item, or null when there was none.
 */
export async function ddbDeleteItem({ tableName, key }) {
  const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const client = await getDocumentClient();
  const result = await client.send(
    new DeleteCommand({ TableName: tableName, Key: key, ReturnValues: "ALL_OLD" })
  );
  return result?.Attributes || null;
}

/**
 * Delete a user's connection row - the app's ONLY copy of their OAuth grant.
 *
 * This is irreversible by design (TASK-013): once the row is gone the wrapped
 * refresh token is gone with it, and no amount of KMS access brings it back. The
 * grant must therefore already have been revoked at Google before this is
 * called, because after it there is nothing left to revoke WITH. That ordering is
 * enforced by `disconnectAccount` in disconnect.mjs, which is the only sanctioned
 * caller.
 *
 * Deleting the whole row also removes, in the same atomic operation, everything
 * else the row carried: the scan lock (`scanInProgress`/`scanStartedAt`), the
 * Gmail watermark (`lastHistoryId`), the schedule preferences and the settings.
 * There is deliberately no partial "clear the token but keep the row" variant - a
 * row with settings and no grant is exactly the "connected but broken" state the
 * connection-status work exists to avoid.
 *
 * The return value reports what was OBSERVED, never what was assumed: `deleted`
 * is true only when DynamoDB returned an old image, so a second disconnect
 * reports `deleted: false` rather than claiming a deletion that did not happen.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {(args: { tableName: string, key: object }) => Promise<object|null>} [deps.deleteItem]
 * @param {string|null} [deps.tableName]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<{ deleted: boolean, hadRefreshToken: boolean }>}
 */
export async function deleteConnection(userId, { deleteItem = ddbDeleteItem, tableName = null, env = process.env } = {}) {
  const table = tableName || resolveTableName(env);
  if (!table) throw new Error("deleteConnection: CALENDAR_CONNECTIONS_TABLE is not set");
  if (!userId) throw new Error("deleteConnection: userId is required");

  const previous = await deleteItem({ tableName: table, key: { userId } });
  // Only two booleans leave this function. The old image itself carries the
  // ciphertext and the key ARN and is dropped here (CONTAINMENT RULE).
  const stripped = stripSecrets(previous);
  return {
    deleted: stripped !== null,
    hadRefreshToken: stripped?.hasRefreshToken === true,
  };
}
