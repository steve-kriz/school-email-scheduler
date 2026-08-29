/**
 * scan-schedule.mjs - one recurring EventBridge Scheduler job per user for the
 * automatic Gmail scan, mirroring `ohq-chatbot2/src/lambda/chatbot/backend/
 * summary-schedule.mjs`. That file manages a SINGLE, deployment-wide schedule;
 * this one manages ONE SCHEDULE PER USER, so its identity is derived from the
 * userId rather than being a fixed name from Terraform.
 *
 * Shape:
 *   scheduleNameFor       -> a name derived from the userId, never containing it
 *   validateScheduleInput -> frequency/hour/dayOfWeek/timezone, or a 400
 *   buildScanCronExpression -> the cron() string; the timezone is NEVER baked
 *                              into it (see below)
 *   getScanSchedule / putScanSchedule / deleteScanSchedule -> the CRUD the
 *                              settings routes call
 *   isScheduledScanEvent / runScheduledScan -> the EventBridge-fired path
 *
 * ---------------------------------------------------------------------------
 * SCHEDULE IDENTITY. `${SCAN_SCHEDULE_PREFIX}-<sha256(userId).slice(0, 16)>`.
 * The userId ("google#<sub>") is a stable, resolvable identifier for a real
 * Google account, so it must never appear in an AWS resource name (schedule
 * names are visible in CloudTrail, the console and any IAM policy that lists
 * them); the hash is one-way and the prefix carries no user data at all.
 *
 * TIMEZONE. `ScheduleExpressionTimezone` is set on the schedule itself and the
 * cron expression carries only an hour and (for weekly) a day - EventBridge
 * Scheduler resolves DST for that zone on every firing. Converting the user's
 * chosen hour to UTC here, once, at save time, would be WRONG the moment the
 * zone's offset changes (a daylight-saving transition) - the schedule would
 * silently fire an hour off twice a year. Never "simplify" this into offset
 * arithmetic.
 *
 * FEATURE FLAG. `isScheduleEnabled` mirrors the chatbot's own gate: scheduling
 * needs `SCAN_SCHEDULE_PREFIX`, `SCAN_SCHEDULER_ROLE_ARN` and
 * `CALENDAR_FUNCTION_ARN`, all set by Terraform. Missing any of them means the
 * feature is not provisioned in this environment, and every entry point below
 * reports that as `available: false` rather than throwing - a deploy that has
 * not yet applied the scheduler infrastructure must not 500 the settings page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCHEDULE'S CONFIG IS READ FROM THE CONNECTION ROW, NOT FROM
 * EventBridge. `getScanSchedule` answers from `connections.mjs`, which is
 * already the source of truth for every other user-facing scan fact
 * (`lastScanAt`, `lastScanStatus`); reading it back from AWS on every page load
 * would add a second failure mode (a Scheduler API blip) to a value this
 * module itself just wrote. `putScanSchedule`/`deleteScanSchedule` are the ones
 * that actually call EventBridge, because those are the operations that must
 * take effect there.
 *
 * ---------------------------------------------------------------------------
 * TESTABILITY: `@aws-sdk/client-scheduler` is imported LAZILY, inside the one
 * function that resolves a client, and every public function accepts injected
 * `client`/`commands` (stub command constructors) exactly as
 * anthropic.mjs injects `client`/`errorTypes`. The module imports cleanly and
 * every branch is reachable with the SDK absent and no AWS credentials.
 *
 * SECURITY: nothing here logs a userId's raw value into an AWS resource name,
 * and nothing schedule-related is ever included in a model prompt or an email.
 */

import { updateConnection as updateStoredConnection, getConnection as getStoredConnection, REMOVE_ATTRIBUTE } from "./connections.mjs";
import { runScan } from "./scan.mjs";
import { createHash } from "node:crypto";

/** Sentinel the scheduled invocation payload carries so index.mjs can tell a
 * scheduler-delivered event apart from an HTTP request. */
export const SCAN_SCHEDULED_SOURCE = "scheduled-scan";

/** Accepted `frequency` values. */
export const SCAN_SCHEDULE_FREQUENCIES = Object.freeze(["daily", "weekly"]);

/** EventBridge cron day-of-week tokens, indexed 0 (Sunday) - 6 (Saturday). */
export const SCAN_DAYS_OF_WEEK = Object.freeze(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);

/** Hex characters of the userId hash kept in the schedule name. */
export const SCHEDULE_NAME_HASH_LENGTH = 16;

/**
 * Read the scheduler configuration from the given environment, per call rather
 * than at import time - matching every sibling backend module.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ prefix: string, group: string, schedulerRoleArn: string, functionArn: string }}
 */
export function readScheduleConfig(env = process.env) {
  return {
    prefix: String(env?.SCAN_SCHEDULE_PREFIX ?? "").trim(),
    group: String(env?.SCAN_SCHEDULE_GROUP ?? "").trim() || "default",
    schedulerRoleArn: String(env?.SCAN_SCHEDULER_ROLE_ARN ?? "").trim(),
    functionArn: String(env?.CALENDAR_FUNCTION_ARN ?? "").trim(),
  };
}

/**
 * Is the scheduling feature provisioned in this environment? Mirrors the
 * chatbot's `isScheduleEnabled`.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isScheduleEnabled(env = process.env) {
  const config = readScheduleConfig(env);
  return Boolean(config.prefix && config.schedulerRoleArn && config.functionArn);
}

/**
 * The EventBridge Scheduler name for a user - a hash of their userId, never the
 * userId itself. Deterministic, so create/update/delete all agree on which
 * schedule is theirs without storing the name anywhere.
 *
 * @param {string} userId
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function scheduleNameFor(userId, env = process.env) {
  const { prefix } = readScheduleConfig(env);
  const hash = createHash("sha256")
    .update(String(userId ?? ""), "utf8")
    .digest("hex")
    .slice(0, SCHEDULE_NAME_HASH_LENGTH);
  return `${prefix}-${hash}`;
}

/**
 * Is this a real IANA time zone? Delegates to `Intl`'s own tz database rather
 * than a hand-maintained list or a regex - a regex shape check would happily
 * accept "Mars/Olympus_Mons".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    // eslint-disable-next-line no-new -- constructing it IS the validation.
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A 400-shaped failure, carrying the field the client should highlight - mirrors `SettingsValidationError`. */
export class ScheduleValidationError extends Error {
  /**
   * @param {string|null} field
   * @param {string} message Client-safe: shown to the user.
   */
  constructor(field, message) {
    super(message);
    this.name = "ScheduleValidationError";
    this.statusCode = 400;
    this.field = field;
  }
}

/**
 * Validate a schedule request body.
 *
 * @param {unknown} payload
 * @returns {{ frequency: string, hour: number, dayOfWeek: number|null, timezone: string }}
 * @throws {ScheduleValidationError}
 */
export function validateScheduleInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ScheduleValidationError(null, "Expected a JSON object");
  }

  const frequency = typeof payload.frequency === "string" ? payload.frequency.trim().toLowerCase() : "";
  if (!SCAN_SCHEDULE_FREQUENCIES.includes(frequency)) {
    throw new ScheduleValidationError("frequency", `Frequency must be one of: ${SCAN_SCHEDULE_FREQUENCIES.join(", ")}`);
  }

  const hourRaw = payload.hour;
  const hour =
    typeof hourRaw === "number" ? hourRaw : /^\d{1,2}$/.test(String(hourRaw ?? "").trim()) ? Number(String(hourRaw).trim()) : NaN;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ScheduleValidationError("hour", "Scan hour must be a whole number from 0 to 23");
  }

  let dayOfWeek = null;
  if (frequency === "weekly") {
    const dowRaw = payload.dayOfWeek;
    const dow = typeof dowRaw === "number" ? dowRaw : /^\d$/.test(String(dowRaw ?? "").trim()) ? Number(String(dowRaw).trim()) : NaN;
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new ScheduleValidationError("dayOfWeek", "Day of week must be a whole number from 0 (Sunday) to 6 (Saturday)");
    }
    dayOfWeek = dow;
  }

  const timezone = typeof payload.timezone === "string" ? payload.timezone.trim() : "";
  if (!isValidTimezone(timezone)) {
    const echoed = String(payload.timezone ?? "").slice(0, 64);
    throw new ScheduleValidationError("timezone", `"${echoed}" is not a valid time zone`);
  }

  return { frequency, hour, dayOfWeek, timezone };
}

/**
 * Render the EventBridge Scheduler cron() expression. The timezone is
 * deliberately NOT part of this string - see the module docblock.
 *
 * @param {{ frequency: string, hour: number, dayOfWeek: number|null }} args
 * @returns {string}
 */
export function buildScanCronExpression({ frequency, hour, dayOfWeek }) {
  if (frequency === "weekly") {
    const dow = SCAN_DAYS_OF_WEEK[dayOfWeek];
    return `cron(0 ${hour} ? * ${dow} *)`;
  }
  return `cron(0 ${hour} * * ? *)`;
}

let sdkPromise = null;
let clientPromise = null;

/** Lazily load the scheduler SDK. See the module docblock's TESTABILITY note. */
async function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@aws-sdk/client-scheduler");
  return sdkPromise;
}

/** The shared client, built once per container. */
async function getSchedulerClient(env = process.env) {
  if (!clientPromise) {
    clientPromise = (async () => {
      const sdk = await loadSdk();
      const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "ap-southeast-2";
      return new sdk.SchedulerClient({ region });
    })();
  }
  return clientPromise;
}

/** Drop the cached client (tests, credential changes). */
export function resetSchedulerClient() {
  sdkPromise = null;
  clientPromise = null;
}

/**
 * Resolve the client and command constructors, honouring an injected pair for
 * tests over the lazily-loaded real SDK.
 *
 * @param {{ client?: any, commands?: object, env?: object }} args
 * @returns {Promise<{ client: any, commands: object }>}
 */
async function resolveScheduler({ client = null, commands = null, env = process.env } = {}) {
  if (client && commands) return { client, commands };
  const sdk = await loadSdk();
  const resolvedCommands = commands || {
    GetScheduleCommand: sdk.GetScheduleCommand,
    CreateScheduleCommand: sdk.CreateScheduleCommand,
    UpdateScheduleCommand: sdk.UpdateScheduleCommand,
    DeleteScheduleCommand: sdk.DeleteScheduleCommand,
  };
  const resolvedClient = client || (await getSchedulerClient(env));
  return { client: resolvedClient, commands: resolvedCommands };
}

/**
 * Read a user's saved schedule preferences, from the connection row (see the
 * module docblock for why this does not call EventBridge).
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof getStoredConnection} [deps.getConnection]
 * @returns {Promise<object>}
 */
export async function getScanSchedule(userId, { env = process.env, getConnection: loadConnection = getStoredConnection } = {}) {
  if (!isScheduleEnabled(env)) {
    return { available: false, configured: false, enabled: false };
  }

  const connection = await loadConnection(userId, { env });
  const frequency = typeof connection?.scheduleFrequency === "string" ? connection.scheduleFrequency : null;

  return {
    available: true,
    configured: Boolean(frequency),
    enabled: connection?.scheduleEnabled === true,
    frequency,
    hour: typeof connection?.scheduleHour === "number" ? connection.scheduleHour : null,
    dayOfWeek: typeof connection?.scheduleDayOfWeek === "number" ? connection.scheduleDayOfWeek : null,
    timezone: typeof connection?.timezone === "string" ? connection.timezone : null,
  };
}

/**
 * Create or update the user's schedule. Idempotent: a GetSchedule decides
 * create vs update, exactly as the chatbot's `putSummarySchedule` does.
 *
 * @param {string} userId
 * @param {unknown} rawPayload
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof updateStoredConnection} [deps.updateConnection]
 * @param {any} [deps.client] Injected scheduler client (tests).
 * @param {object} [deps.commands] Injected command constructors (tests).
 * @returns {Promise<object>}
 * @throws {ScheduleValidationError}
 */
export async function putScanSchedule(
  userId,
  rawPayload,
  { env = process.env, updateConnection: patchConnection = updateStoredConnection, client = null, commands = null } = {}
) {
  if (!isScheduleEnabled(env)) {
    return { available: false };
  }

  const validated = validateScheduleInput(rawPayload);
  const cron = buildScanCronExpression(validated);
  const { group, schedulerRoleArn, functionArn } = readScheduleConfig(env);
  const name = scheduleNameFor(userId, env);

  const { client: schedulerClient, commands: cmds } = await resolveScheduler({ client, commands, env });

  const input = {
    Name: name,
    GroupName: group,
    ScheduleExpression: cron,
    ScheduleExpressionTimezone: validated.timezone,
    FlexibleTimeWindow: { Mode: "OFF" },
    State: "ENABLED",
    Target: {
      Arn: functionArn,
      RoleArn: schedulerRoleArn,
      Input: JSON.stringify({ source: SCAN_SCHEDULED_SOURCE, userId }),
    },
  };

  let exists = true;
  try {
    await schedulerClient.send(new cmds.GetScheduleCommand({ Name: name, GroupName: group }));
  } catch (err) {
    if (err?.name === "ResourceNotFoundException") exists = false;
    else throw err;
  }

  if (exists) await schedulerClient.send(new cmds.UpdateScheduleCommand(input));
  else await schedulerClient.send(new cmds.CreateScheduleCommand(input));

  const patch = {
    scheduleEnabled: true,
    scheduleFrequency: validated.frequency,
    scheduleHour: validated.hour,
    timezone: validated.timezone,
    scheduleDayOfWeek: validated.frequency === "weekly" ? validated.dayOfWeek : REMOVE_ATTRIBUTE,
  };
  await patchConnection(userId, patch, { env });

  return {
    available: true,
    configured: true,
    enabled: true,
    frequency: validated.frequency,
    hour: validated.hour,
    dayOfWeek: validated.frequency === "weekly" ? validated.dayOfWeek : null,
    timezone: validated.timezone,
    cron,
  };
}

/**
 * Remove the user's schedule. No-op at EventBridge (resolves) when it does not
 * exist there already.
 *
 * @param {string} userId
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof updateStoredConnection} [deps.updateConnection]
 * @param {any} [deps.client]
 * @param {object} [deps.commands]
 * @returns {Promise<object>}
 */
export async function deleteScanSchedule(
  userId,
  { env = process.env, updateConnection: patchConnection = updateStoredConnection, client = null, commands = null } = {}
) {
  if (!isScheduleEnabled(env)) {
    return { available: false };
  }

  const { group } = readScheduleConfig(env);
  const name = scheduleNameFor(userId, env);
  const { client: schedulerClient, commands: cmds } = await resolveScheduler({ client, commands, env });

  try {
    await schedulerClient.send(new cmds.DeleteScheduleCommand({ Name: name, GroupName: group }));
  } catch (err) {
    if (err?.name !== "ResourceNotFoundException") throw err;
  }

  await patchConnection(
    userId,
    {
      scheduleEnabled: false,
      scheduleFrequency: REMOVE_ATTRIBUTE,
      scheduleHour: REMOVE_ATTRIBUTE,
      scheduleDayOfWeek: REMOVE_ATTRIBUTE,
      timezone: REMOVE_ATTRIBUTE,
    },
    { env }
  );

  return { available: true, configured: false, enabled: false };
}

/**
 * Decide whether an invocation event is our EventBridge Scheduler scan job.
 *
 * `source` alone is not sufficient - it is a free-form string a bus event (or
 * anything else that might one day target this Lambda) could also carry - so
 * this additionally requires the event to clearly NOT be an HTTP request. Both
 * request shapes are excluded, because getting this wrong is silent in both
 * directions: an HTTP request misread as a schedule would answer a browser with
 * a bare result object (no status, no headers), and a schedule misread as HTTP
 * would 404 and never run the scan.
 *
 *   - `rawPath` / `requestContext` are what a Lambda function URL sends
 *     (payload format 2.0, TASK-049).
 *   - `httpMethod` / `path` are what the ALB sent before it.
 *
 * The schedule Input this module writes (see `putScanSchedule`) sets none of the
 * four. Mirrors the chatbot's `isScheduledSummaryEvent`, widened for format 2.0.
 *
 * @param {unknown} event
 * @returns {boolean}
 */
export function isScheduledScanEvent(event) {
  return (
    !!event &&
    typeof event === "object" &&
    event.source === SCAN_SCHEDULED_SOURCE &&
    event.httpMethod === undefined &&
    event.path === undefined &&
    event.rawPath === undefined &&
    event.requestContext === undefined
  );
}

/**
 * Run the scheduled scan for the user named in the event payload.
 *
 * A missing `userId` is rejected WITHOUT calling `runScan` at all - there is no
 * account to lock, fetch or bill, and calling through with an empty userId
 * would either throw deep inside `runScan` or (worse) silently address a wrong
 * or default account.
 *
 * @param {{ source?: string, userId?: string }} event
 * @param {object} [deps] Forwarded to `runScan` (env, log, now,
 *   getRemainingTimeInMillis, and every other injectable dependency).
 * @returns {Promise<object>} A plain result object - never an HTTP response
 *   shape, because there is no browser waiting on this invocation.
 */
export async function runScheduledScan(event, deps = {}) {
  const { env = process.env, log = null, runScan: doScan = runScan } = deps;
  const logLine = typeof log === "function" ? log : (message, fields) => {
    if ((env?.CALENDAR_LOG_LEVEL || "basic") === "none") return;
    if (fields === undefined) console.log(message);
    else console.log(message, fields);
  };

  const userId = typeof event?.userId === "string" ? event.userId : "";
  if (!userId) {
    logLine("calendar.scan.scheduled_rejected", { reason: "missing_userId" });
    return { status: "rejected", reason: "missing_userId" };
  }

  logLine("calendar.scan.scheduled_start", { userId });
  return doScan({ userId, mode: "scheduled" }, deps);
}

export { REMOVE_ATTRIBUTE };
