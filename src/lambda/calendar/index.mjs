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
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

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
 */
function isOriginAllowed(origin) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

/**
 * Determine the CORS origin to return.
 * - allowlist empty (open mode) -> "*"
 * - origin in allowlist         -> echo it back
 * - otherwise                   -> null (no CORS header, browser blocks it)
 */
function getCorsOrigin(origin) {
  if (ALLOWED_ORIGINS.length === 0) return "*";
  if (origin && isOriginAllowed(origin)) return origin;
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

/**
 * Build an ALB-compatible response (multi-value headers format).
 *
 * The target group sets lambda_multi_value_headers_enabled = true, so the ALB
 * expects `multiValueHeaders` (every value an array) rather than `headers`.
 * That is what lets later tickets emit several Set-Cookie headers from one
 * response - a single-value `headers` map cannot.
 *
 * @param {number} statusCode
 * @param {string} body           already-serialised body
 * @param {string} [contentType]
 * @param {{origin?: string|null, headers?: Record<string, string[]>}} [options]
 */
function buildResponse(statusCode, body, contentType = "application/json", options = {}) {
  const { origin = null, headers = {} } = options;

  const corsOrigin = getCorsOrigin(origin);

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
export { buildResponse, jsonResponse, getCorsOrigin, isOriginAllowed, fileCache, ASSET_DIR };
