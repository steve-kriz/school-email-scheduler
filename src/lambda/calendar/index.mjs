import { dirname } from "path";
import { fileURLToPath } from "url";

// ESM has no __dirname/__filename. Derive them from import.meta.url, exactly as
// the chatbot Lambda does, so frontend assets can be read relative to the
// bundle root once TASK-010 adds them.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root of the deployed bundle; frontend assets live under `${ASSET_DIR}/frontend`.
const ASSET_DIR = __dirname;

// Cache frontend files in memory after first read. Lambda containers are reused
// between invocations, so each asset is read from disk at most once per
// container. Populated by the frontend ticket; declared here so the serve path
// has somewhere to cache from day one.
const fileCache = new Map();

// --- Origin Allowlist ---
// Parsed from ALLOWED_ORIGINS env var (comma-separated domain list). Each entry
// is a domain suffix match, e.g. "officehq.com.au" matches
// "https://my.officehq.com.au". Empty = open mode (echo "*").
/**
 * Parse a raw comma-separated ALLOWED_ORIGINS string into a normalised list.
 *
 * Entries are lower-cased because `isOriginAllowed` compares them against
 * `new URL(origin).hostname`, which the URL spec always normalises to
 * lowercase — an entry of "OfficeHQ.com.au" could otherwise never match
 * anything. The chatbot Lambda lower-cases its entries the same way.
 *
 * Exported so tests can exercise several allowlist configurations without
 * mutating module-scope state (ALLOWED_ORIGINS is read once at import time).
 *
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
function parseAllowedOrigins(raw) {
  return (raw || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const LOG_LEVEL = process.env.CALENDAR_LOG_LEVEL || "basic";

/**
 * Log a request/summary line unless logging is switched off entirely.
 */
function logBasic(...args) {
  if (LOG_LEVEL === "none") return;
  console.log(...args);
}

/**
 * Is this origin covered by the allowlist (exact host or domain suffix)?
 *
 * The suffix match requires a dot boundary: an entry of "officehq.com.au"
 * matches "officehq.com.au" and "sub.officehq.com.au" but NOT the lookalike
 * "evil-officehq.com.au" (a bare `host.endsWith(allowed)` would accept it) and
 * not "officehq.com.au.attacker.com" (which the suffix test rules out).
 *
 * @param {string|null|undefined} origin  full origin, e.g. "https://x.example.com"
 * @param {string[]} [allowlist]          defaults to the module-scope allowlist
 */
function isOriginAllowed(origin, allowlist = ALLOWED_ORIGINS) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowlist.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/**
 * Determine the CORS origin to return.
 * - allowlist empty (open mode) -> "*"
 * - origin in allowlist         -> echo it back
 * - otherwise                   -> null (no CORS header, browser blocks it)
 *
 * @param {string|null|undefined} origin
 * @param {string[]} [allowlist]  defaults to the module-scope allowlist
 */
function getCorsOrigin(origin, allowlist = ALLOWED_ORIGINS) {
  if (allowlist.length === 0) return "*";
  if (origin && isOriginAllowed(origin, allowlist)) return origin;
  return null;
}

/**
 * Pull the request Origin (or Referer) out of an ALB event's headers. With
 * lambda_multi_value_headers_enabled the values arrive as arrays, so handle
 * both shapes.
 */
function getRequestOrigin(headers) {
  const read = (name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const origin = read("origin");
  if (origin) return origin;
  const referer = read("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

const STATUS_TEXT = {
  200: "OK",
  204: "No Content",
  302: "Found",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

const CREDENTIALS_HEADER = "access-control-allow-credentials";

/**
 * Build an ALB-compatible response (multi-value headers format).
 *
 * The target group sets lambda_multi_value_headers_enabled = true, so the ALB
 * expects `multiValueHeaders` (every value an array) rather than `headers`.
 * That is what lets later tickets emit several Set-Cookie headers from one
 * response - a single-value `headers` map cannot.
 *
 * Security invariant: `Access-Control-Allow-Credentials` is never emitted while
 * the resolved origin is the wildcard "*". With ALLOWED_ORIGINS unset the gate
 * is in open mode, and pairing credentials with "*" would turn per-user
 * calendar data into a cross-origin read. This is enforced here rather than
 * left to convention, so a later route that adds the header (session cookies,
 * authenticated APIs) is stripped instead of shipping the combination. Set
 * ALLOWED_ORIGINS to an explicit list to use credentialed CORS.
 *
 * @param {number} statusCode
 * @param {string} body           already-serialised body
 * @param {string} [contentType]
 * @param {{origin?: string|null, headers?: Record<string, string[]>, allowlist?: string[]}} [options]
 */
function buildResponse(statusCode, body, contentType = "application/json", options = {}) {
  const { origin = null, headers = {}, allowlist = ALLOWED_ORIGINS } = options;

  const corsOrigin = getCorsOrigin(origin, allowlist);

  const multiValueHeaders = {
    "Content-Type": [contentType],
    "Access-Control-Allow-Methods": ["GET, POST, DELETE, OPTIONS"],
    "Access-Control-Allow-Headers": ["Content-Type, Authorization, X-Requested-With"],
    "Access-Control-Max-Age": ["86400"],
    "Cache-Control": ["no-cache"],
    ...headers,
  };

  // Only include the CORS origin header when we resolved an allowed origin.
  if (corsOrigin) {
    multiValueHeaders["Access-Control-Allow-Origin"] = [corsOrigin];
    multiValueHeaders["Vary"] = ["Origin"];
  }

  // Hard invariant: credentials are never exposed to a wildcard origin. Header
  // names are compared case-insensitively because HTTP header names are.
  if (corsOrigin === "*") {
    for (const name of Object.keys(multiValueHeaders)) {
      if (name.toLowerCase() === CREDENTIALS_HEADER) {
        delete multiValueHeaders[name];
        // Name only - never the value, which may be a credential elsewhere.
        logBasic(
          "[Calendar] Dropped",
          name,
          "- credentials cannot be paired with a wildcard CORS origin; set ALLOWED_ORIGINS"
        );
      }
    }
  }

  return {
    statusCode,
    statusDescription: `${statusCode} ${STATUS_TEXT[statusCode] || "Error"}`,
    multiValueHeaders,
    body,
    isBase64Encoded: false,
  };
}

/**
 * JSON convenience wrapper around buildResponse.
 */
function jsonResponse(statusCode, payload, options = {}) {
  return buildResponse(statusCode, JSON.stringify(payload), "application/json", options);
}

/**
 * Lambda handler for the school calendar app, invoked by the shared web-app ALB
 * on the /calendar* path prefix.
 *
 * Only the health check exists so far - it is what the target group polls, so
 * it must answer 200 before anything else can be wired up. OAuth, the events
 * API and the frontend are added by later tickets.
 */
export async function handler(event) {
  const path = event?.path || "/";
  const method = (event?.httpMethod || "GET").toUpperCase();
  const headers = event?.multiValueHeaders || event?.headers || {};
  const origin = getRequestOrigin(headers);

  logBasic("[Calendar] Request:", { method, path, origin: origin || "none" });

  // CORS preflight for all routes.
  if (method === "OPTIONS") {
    return buildResponse(200, "", "application/json", { origin });
  }

  // Health check — deliberately open: ALB health checks send no Origin header
  // and no credentials, and the body carries nothing sensitive.
  if (path === "/calendar/api/health" && method === "GET") {
    return jsonResponse(
      200,
      {
        status: "ok",
        service: "school-calendar",
        timestamp: new Date().toISOString(),
      },
      { origin }
    );
  }

  // 404 for everything else — later tickets add the real routes.
  return jsonResponse(404, { error: "Not found", path }, { origin });
}

// Exported for unit tests and for the route modules added by later tickets.
export {
  buildResponse,
  jsonResponse,
  getCorsOrigin,
  isOriginAllowed,
  parseAllowedOrigins,
  ALLOWED_ORIGINS,
  fileCache,
  ASSET_DIR,
};
