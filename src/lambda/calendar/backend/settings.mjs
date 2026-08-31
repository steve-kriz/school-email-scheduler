/**
 * settings.mjs - what the user asked us to watch for, and how it is validated.
 *
 * A list of named PROCESSING JOBS (TASK-055). Each job is one independent
 * "search + extract" configuration: a display `name`, one `schoolName`, zero or
 * more sender `domains` (TASK-059), and zero or more free-text `searchTerms`. A
 * job is the whole input to the Gmail search query (TASK-056) and the extraction
 * prompt (TASK-007), which is why the validation here is not cosmetic: a domain
 * that is wrong in the wrong direction decides how much of the user's mailbox is
 * read and how much of it is sent to a model.
 *
 * `domains` IS OPTIONAL, `name` AND `schoolName` ARE REQUIRED (TASK-059). A job
 * that watches several sender domains at once - a P&C association's own domain
 * alongside the school's - is an ordinary setup, so the singular `domain` became
 * the plural `domains` list, matching `searchTerms`. It is OPTIONAL because
 * `hasJobQueryClauses`/`buildJobQuery` (gmail.mjs) already build a usable query
 * from a quoted school name and/or search terms alone: requiring a domain would
 * add a restriction the pipeline does not need and would refuse a legitimate
 * "match this school by name via a newsletter relay" job. The "a job must be
 * searchable" guarantee is carried by the still-required `schoolName`.
 *
 * Each job carries a server-owned `id` (a UUID) that never changes once created,
 * because TASK-056 attributes extracted events to it and the id must survive a
 * rename. A PUT is a WHOLE-LIST REPLACE - it never reads the stored row - so the
 * only way an id survives is for the client to echo it back; see
 * `validateProcessingJobs`. A job left out of the submitted list is deleted.
 *
 * STORAGE: `processingJobs` is a DynamoDB LIST OF MAPS (see
 * terraform/dynamodb_calendar_connections.tf). The document client marshals a
 * plain JS array of plain objects to `L` of `M` on its own, so the patch carries
 * exactly that - NOT a `Set` (this attribute is not a string set) and not a JSON
 * string. `JSON.stringify(new Set())` is `"{}"`, so a Set that escaped into a
 * response body would silently become an empty object. A job's `searchTerms` and
 * its `domains` (TASK-059) are likewise plain arrays, and an EMPTY one is stored
 * AS an empty list: the empty-set write error that `REMOVE_ATTRIBUTE` exists for
 * applies to `SS`, not to `L`.
 *
 * LEGACY `schoolNames` (SS), `searchDomains` (SS) and `schoolName` (S). These are
 * the pre-TASK-055 shape and are no longer part of the read or write contract: no
 * route accepts them and no response body emits them. A row that has not been
 * saved since is MIGRATED ON READ in `toPublicJson` (connections.mjs), which
 * synthesises exactly one "Default" job from them, and all three attributes are
 * REMOVEd by `buildConnectionPatch` in the same UpdateItem that SETs
 * `processingJobs` - so a row migrates on its owner's next save and no row ever
 * carries both shapes. There is no batch migration.
 *
 * `validateSchoolNames` and `validateSearchDomains` are still exported (other
 * modules and tests import them, and they remain the reference for this file's
 * count-then-normalise-then-dedup shape) but they are NO LONGER part of the
 * settings request path - `requireValidSettings` calls neither. `MAX_SCHOOL_NAMES`
 * and `MAX_SEARCH_DOMAINS` exist only to bound those two retained functions; the
 * cap that applies to a JOB's domain list is `MAX_SEARCH_DOMAINS_PER_JOB`.
 *
 * CO-DEPLOY WITH THE FRONTEND. The request contract here has no legacy alias, so
 * an older settings page cannot save against it: TASK-055/057 made
 * `processingJobs` the only accepted shape, and TASK-059 renamed a job's singular
 * `domain` to the plural `domains` list. TASK-060 is the matching frontend (a
 * comma-separated domains field) and MUST ship with this module - a settings page
 * that still sends `domain` will have that key dropped as unknown and will save a
 * job with no sender filter.
 *
 * NO SANITISATION, DELIBERATELY. Job names, school names, domains and search
 * terms are stored exactly as validated - raw, unescaped text. Stripping or
 * escaping characters at the storage layer corrupts legitimate values ("St Mary's
 * Primary", "École") and hides the corruption in the database, where it can never
 * be undone. Escaping is the job of the boundary that renders:
 *   - the frontend (TASK-057) escapes on render, so the text cannot become
 *     markup in the page;
 *   - the prompt builder (TASK-007) wraps these values in a delimited block, so
 *     the text cannot become instructions to the model.
 * What IS enforced here is SHAPE: a length bound on each free-text field, a cap
 * on how many jobs and how many terms, and a strict hostname grammar on each
 * domain, so no field can carry an arbitrary payload in the first place.
 *
 * VALIDATION IS SERVER-SIDE. The frontend will validate too, for the error
 * messages, but nothing here trusts that: every rule below is re-checked on the
 * request.
 *
 * TESTABILITY: every I/O function takes its dependencies as parameters with real
 * defaults, exactly as connections.mjs does. That includes the id generator -
 * `validateProcessingJobs` takes `newId` so every branch is reachable with a
 * stubbed generator. Nothing in this module imports the AWS SDK, and every branch
 * is reachable with no AWS credentials and no network.
 */

import { randomUUID } from "node:crypto";

import {
  connectionUserId,
  getConnection,
  REMOVE_ATTRIBUTE,
  toPublicJson,
  updateConnection,
} from "./connections.mjs";

/** Path the settings routes are mounted on. */
export const SETTINGS_PATH = "/calendar/api/settings";

/**
 * Fields the settings API reports. Every one of these must also appear in
 * `PUBLIC_ATTRIBUTES` in connections.mjs - that list is the allow-list, and an
 * attribute missing from it projects as null however hard this module asks for
 * it.
 */
export const SETTINGS_FIELDS = [
  "email",
  "processingJobs",
  "scheduleEnabled",
  "scheduleFrequency",
  "scheduleHour",
  "timezone",
  "lastScanAt",
  "lastScanStatus",
];

/**
 * Display name bound, counted in code points (see `countCodePoints`). Bounds a
 * single job's `schoolName`, and - unchanged since TASK-053 - each entry of the
 * retained `validateSchoolNames`.
 */
export const MAX_SCHOOL_NAME_LENGTH = 120;

/**
 * How many processing jobs one user may configure.
 *
 * A settings row is ONE DynamoDB item and must stay well inside the 400KB item
 * limit: twenty jobs each carrying twenty ~80-character search terms is roughly
 * 44KB, so this cap has two orders of magnitude of headroom. It is also what
 * keeps the number of Gmail queries per scan bounded (TASK-056 runs one search
 * per job).
 */
export const MAX_PROCESSING_JOBS = 20;

/**
 * Job display-name bound, in code points. Matches `MAX_SCHOOL_NAME_LENGTH`: both
 * are free-text labels a person types, so there is no reason for them to differ.
 */
export const MAX_PROCESSING_JOB_NAME_LENGTH = 120;

/**
 * How many search terms one job may carry. Every term is OR'd into that job's
 * Gmail query (TASK-056), so the cap is what keeps the generated query inside
 * Google's own length limits.
 */
export const MAX_SEARCH_TERMS_PER_JOB = 20;

/**
 * How many sender domains one job may watch (TASK-059).
 *
 * The sibling of `MAX_SEARCH_TERMS_PER_JOB`, and the cap that actually applies on
 * the settings request path - a job's `domains` list, not the retained flat
 * `MAX_SEARCH_DOMAINS`. Every domain is OR'd into that job's Gmail query
 * (TASK-056) alongside its school name and search terms, so this is what keeps
 * the generated query inside Google's own length limits: ten `from:@<host>`
 * clauses of a realistic length is a few hundred bytes, which leaves room for the
 * twenty quoted search terms `MAX_SEARCH_TERMS_PER_JOB` allows beside them.
 *
 * Ten is also the number a person can hold in their head for ONE job: a school,
 * its P&C, a newsletter relay and a handful of sub-domains. It is deliberately
 * the same value as `MAX_SEARCH_DOMAINS` (which used to bound the whole
 * connection) so nobody who was inside the old cap is outside the new one.
 */
export const MAX_SEARCH_DOMAINS_PER_JOB = 10;

/**
 * Search term bound, in code points. Deliberately SHORTER than
 * `MAX_SCHOOL_NAME_LENGTH`: a search term is bounded by Gmail QUERY length, not
 * by prompt token cost. Twenty terms of ~86 characters quoted and OR-joined is
 * about 1.7KB, which leaves TASK-056 headroom under the ~2KB practical query
 * limit; a 120-character bound would put the generated query over it.
 */
export const MAX_SEARCH_TERM_LENGTH = 80;

/**
 * How many school names one user may list.
 *
 * RETAINED FOR `validateSchoolNames` ONLY (TASK-055). Nothing on the settings
 * request path references this any more - a processing job carries exactly one
 * school name, bounded by `MAX_SCHOOL_NAME_LENGTH`, and the count cap that
 * matters now is `MAX_PROCESSING_JOBS`. Kept because that function is still
 * exported and imported outside this file.
 */
export const MAX_SCHOOL_NAMES = 10;

/**
 * How many domains one user may watch.
 *
 * RETAINED FOR `validateSearchDomains` ONLY (TASK-055), for the same reason as
 * `MAX_SCHOOL_NAMES`: a processing job carries its OWN domain list, bounded by
 * `MAX_SEARCH_DOMAINS_PER_JOB` (TASK-059), and this constant bounds nothing on
 * the settings request path.
 */
export const MAX_SEARCH_DOMAINS = 10;

/** DNS limits: 253 characters overall, 63 per label. */
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_DOMAIN_LABEL_LENGTH = 63;

/**
 * Hosts a user must not match on.
 *
 * "sender is @gmail.com" is not a school filter - it is most of a personal
 * mailbox. Allowing it would put unrelated private mail through the extraction
 * model, which is both a privacy failure and an unbounded cost. Matched EXACTLY,
 * not as a suffix: "gmail.com" is refused, a hypothetical "mail.gmail.com" is
 * not, because the concern is the shared public host itself and a school could
 * legitimately be hosted on a subdomain. See `isPublicMailBrand` below: the
 * subdomain allowance is deliberate in BOTH checks and is pinned by tests - do
 * not "fix" it into a suffix match.
 *
 * REGIONAL VARIANTS ARE NOT OPTIONAL. This is an Australian deployment, so
 * "outlook.com.au" and "yahoo.com.au" are exactly what a local user types; a list
 * that only knows the .com forms lets the most likely mistake straight through.
 * The list is still only the fast path - `PUBLIC_MAIL_BRANDS` catches the suffix
 * nobody thought of, but ONLY for brands that are never a plausible school name
 * (see the note on `PUBLIC_MAIL_BRANDS` itself). Dictionary-word brands like
 * "me", "mac", "mail", "live", "proton", "aol" and "zoho" rely on THIS exact-match
 * list alone - a genuine school could register "live.edu.au" or "mail.edu.au", so
 * those words are deliberately not refused under an arbitrary suffix. Their known
 * hosts ("me.com", "mac.com", "mail.com", "live.com"/".com.au"/".co.uk",
 * "proton.me", "aol.com", "zoho.com") are listed here instead, which is why this
 * list carries more than just the six original providers.
 *
 * AUSTRALIAN ISPS AND PORTALS (TASK-046) are the highest-probability miss for
 * this tenant specifically: an Australian parent is more likely to own a Bigpond
 * or Optusnet mailbox than an "outlook.com.au" one, because those ISP-issued
 * addresses predate webmail and are still the primary personal inbox for a large,
 * older share of the population this deployment serves. They are listed here,
 * exact-match only, rather than promoted to `PUBLIC_MAIL_BRANDS`: not because
 * their names are ambiguous (they are not - "bigpond", "optusnet" and "y7mail" are
 * unambiguous provider brands, unlike "mail" or "live"), but because this ticket's
 * acceptance criteria scopes the fix to the named exact hosts and leaves the
 * any-suffix promotion to a follow-on (TASK-044 promotes "aol"/"zoho" the same
 * way, for the same reason - these are good candidates for the same treatment).
 * "internode.on.net" needs no `CCTLD_SECOND_LEVEL_LABELS` change to match: it is
 * refused by direct string equality against THIS list, before `registrableName`
 * is ever consulted (see `isPublicMailDomain`), so the unusual "on.net" shape
 * (which `registrableName` would in any case read as the registrable domain
 * "on.net" with "internode" as a subdomain label - correctly, since "on.net" is
 * itself a registered domain, not a public suffix) is irrelevant to this entry.
 */
export const PUBLIC_MAIL_DOMAINS = Object.freeze([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "outlook.com.au",
  "outlook.co.uk",
  "hotmail.com",
  "hotmail.com.au",
  "hotmail.co.uk",
  "hotmail.fr",
  "live.com",
  "live.com.au",
  "live.co.uk",
  "msn.com",
  // Yahoo
  "yahoo.com",
  "yahoo.com.au",
  "yahoo.co.uk",
  "yahoo.ca",
  "ymail.com",
  "rocketmail.com",
  // AOL
  "aol.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Proton
  "proton.me",
  "protonmail.com",
  "pm.me",
  // United Internet
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  // Other high-traffic consumer hosts
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
  "fastmail.com",
  "tutanota.com",
  // Australian ISPs and portals (TASK-046) - see the docblock above for why
  // these are exact-match only rather than promoted to PUBLIC_MAIL_BRANDS.
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "y7mail.com",
  "iinet.net.au",
  "tpg.com.au",
  "internode.on.net",
  "dodo.com.au",
]);

/**
 * Provider BRANDS, matched on the registrable name under any public suffix.
 *
 * The second line of defence behind PUBLIC_MAIL_DOMAINS. A literal host list is
 * always one launch behind reality - "hotmail.com.br" exists today and
 * "yahoo.<something>" will exist next year - and every miss is silent: the scan
 * succeeds, so the only symptoms are noisy events and a bigger Anthropic bill.
 * Matching the brand instead of the host closes that class of gap without another
 * edit.
 *
 * UNAMBIGUOUS BRANDS ONLY. Every entry here is a name that is never a plausible
 * genuine registration for a school ("gmail", "hotmail", "protonmail") - nobody
 * mistakes "gmail.edu.au" for a real school. That is a deliberately narrower list
 * than a first pass might reach for: dictionary-word brands such as "me", "mac",
 * "mail", "live", "proton", "aol" and "zoho" are NOT here, because each is also an
 * ordinary word or short name a real school could legitimately register as its
 * OWN domain (a school directly registered at "live.edu.au" or "mail.edu.au" is
 * unlikely, but not implausible the way "gmail.edu.au" is), and matching them under
 * every suffix would refuse a real customer with no way around it. Those brands
 * are instead covered ONLY by their known exact hosts in PUBLIC_MAIL_DOMAINS
 * ("me.com", "mac.com", "mail.com", "live.com"/".com.au"/".co.uk", "proton.me",
 * "aol.com", "zoho.com") - real, but bounded, coverage in exchange for never
 * refusing a genuine school. This is a deliberate trade: the brand check below
 * trades completeness for zero false positives on real school domains, which is
 * the promise this module makes and the exact-match list cannot make on its own.
 *
 * A false positive here blocks a real customer at the settings form, so the bar
 * for adding an entry is "this word is unambiguously a mail brand and never a
 * plausible school name" - not merely "this is a mail brand". Do not add a
 * dictionary-word brand to this array on the reasoning that it improves coverage;
 * add its known hosts to PUBLIC_MAIL_DOMAINS instead. A school that puts one of
 * these brands in FRONT of its own name ("mail.stmarys.edu.au") is unaffected
 * either way - see `registrableName`.
 */
export const PUBLIC_MAIL_BRANDS = Object.freeze([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "msn",
  "yahoo",
  "ymail",
  "rocketmail",
  "icloud",
  "protonmail",
  "gmx",
  "yandex",
  "qq",
]);

/**
 * Second-level labels that are part of a PUBLIC SUFFIX rather than a name anyone
 * registered, when they sit under a two-letter ccTLD.
 *
 * "stmarys.edu.au" is registered at the third level, "stmarys.com" at the second,
 * and telling those apart is what the Public Suffix List is for. We deliberately
 * do NOT take a PSL dependency for this - it is a large, frequently-updated data
 * file, and the whole of this module is dependency-free and runs with no network.
 *
 * THE HEURISTIC: if the last label is a two-letter ccTLD AND the label before it
 * is one of these well-known registry labels, the suffix is two labels long;
 * otherwise it is one.
 *
 * ITS LIMITS, stated rather than discovered later:
 *   - It over-shortens exotic multi-label suffixes not listed here (e.g.
 *     "example.act.edu.au" reads "edu" as the registrable name). That direction is
 *     harmless: "edu" is not a provider brand, so nothing is wrongly refused.
 *   - It over-lengthens a genuine two-label registration under a listed pair
 *     (someone who really owns "co.xx"). Also harmless here, for the same reason.
 * Both failure modes only ever produce a WRONG registrable name for domains whose
 * name is not a provider brand, so the worst case is that a brand slips through to
 * the exact-match list - never that a school domain is refused.
 */
const CCTLD_SECOND_LEVEL_LABELS = Object.freeze([
  "com",
  "co",
  "net",
  "ne",
  "org",
  "or",
  "edu",
  "ac",
  "sch",
  "gov",
  "govt",
  "gob",
  "mil",
  "id",
  "in",
  "info",
  "biz",
  "nom",
  "asn",
]);

/**
 * The registrable name of a host: the label immediately left of its public suffix.
 *
 *   "mail.com"             -> { name: "mail",    subdomain: false }
 *   "hotmail.com.br"       -> { name: "hotmail", subdomain: false }
 *   "yahoo.example"        -> { name: "yahoo",   subdomain: false }
 *   "stmarys.edu.au"       -> { name: "stmarys", subdomain: false }
 *   "mail.stmarys.edu.au"  -> { name: "stmarys", subdomain: true  }
 *   "mail.gmail.com"       -> { name: "gmail",   subdomain: true  }
 *
 * `subdomain` records whether anything sat to the LEFT of the registrable name.
 * That flag is the whole reason "mail.com" and "mail.stmarys.edu.au" can be told
 * apart: in the first, "mail" IS the registered name and the host is a public
 * provider; in the second, "mail" is just a label a school put in front of its own
 * name, which is the most ordinary thing in the world.
 *
 * @param {string} value Already normalised, lower-cased, shape-checked.
 * @returns {{ name: string, subdomain: boolean }|null} Null when there is no
 *   registrable name at all (e.g. the bare suffix "com.au").
 */
export function registrableName(value) {
  if (typeof value !== "string") return null;
  const labels = value.split(".");
  if (labels.length < 2) return null;

  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  const suffixLength =
    last.length === 2 && CCTLD_SECOND_LEVEL_LABELS.includes(secondLast) ? 2 : 1;

  const nameIndex = labels.length - suffixLength - 1;
  if (nameIndex < 0) return null;

  return { name: labels[nameIndex], subdomain: nameIndex > 0 };
}

/**
 * Is this host a public mail provider the scanner must refuse?
 *
 * Two checks, in this order:
 *  1. Exact match against PUBLIC_MAIL_DOMAINS - the fast, unambiguous path, and
 *     the ONLY path for the dictionary-word brands ("me", "mac", "mail", "live",
 *     "proton", "aol", "zoho" - see PUBLIC_MAIL_BRANDS for why).
 *  2. Brand match: the REGISTRABLE NAME is one of the UNAMBIGUOUS provider brands
 *     in PUBLIC_MAIL_BRANDS, under any public suffix. Only when the brand is the
 *     registered name itself, never when it is a subdomain label - so
 *     "hotmail.com.br" is refused while "mail.gmail.com" and "mail.stmarys.edu.au"
 *     are both allowed, matching the exact-match rule's own subdomain stance (see
 *     PUBLIC_MAIL_DOMAINS). Because step 2 only ever consults the unambiguous
 *     list, a genuine school domain is never refused by the brand check alone -
 *     "live.edu.au" and "mail.edu.au" pass, even though "live" and "mail" are
 *     provider-adjacent words, because neither is in PUBLIC_MAIL_BRANDS.
 *
 * @param {string} domain Already normalised and shape-checked.
 * @returns {boolean}
 */
export function isPublicMailDomain(domain) {
  if (typeof domain !== "string" || domain === "") return false;
  if (PUBLIC_MAIL_DOMAINS.includes(domain)) return true;

  const registrable = registrableName(domain);
  if (!registrable || registrable.subdomain) return false;
  return PUBLIC_MAIL_BRANDS.includes(registrable.name);
}

/** Accepted `scheduleFrequency` values. TASK-008 owns what they mean. */
export const SCHEDULE_FREQUENCIES = Object.freeze(["daily", "weekly"]);

/** One DNS label: alphanumeric, inner hyphens only. */
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Longest plausible IANA zone name, with headroom. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * Is this a real IANA time zone?
 *
 * DELIBERATELY THE SAME CHECK AS `isValidTimezone` IN scan-schedule.mjs, and for
 * the same reason: `Intl`'s own tz database is the only thing that knows which
 * zones exist. This route used to shape-check with a regex, which happily
 * accepted "Mars/Olympus_Mons" - and since the settings form saves here and then
 * pushes the same zone to `PUT /calendar/api/scan/schedule`, which HAS always
 * used the real database, the two endpoints disagreed: the zone was persisted on
 * the connection row and the schedule it was meant for was never updated. The
 * user was told "your school was saved, but the automatic scan schedule was
 * not", with nothing on the page explaining which value was at fault.
 *
 * MIRRORED, NOT IMPORTED. Importing scan-schedule.mjs here would pull in
 * scan.mjs -> gmail.mjs -> this module, a cycle, and would drag the whole scan
 * stack into every settings request. The check is four lines and has no
 * configuration or tuning of its own, so the copy cannot drift in any way that
 * matters - but if scan-schedule.mjs's version ever changes, change this one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  // Cheap guard first: nothing this long is a zone name, and it keeps an
  // arbitrarily large body out of the ICU lookup.
  if (value.length > MAX_TIMEZONE_LENGTH) return false;
  try {
    // eslint-disable-next-line no-new -- constructing it IS the validation.
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** How much of a rejected value is echoed back to the caller. */
const ECHO_LENGTH = 64;

/**
 * A 400-shaped failure, carrying the field the client should highlight.
 *
 * Mirrors `SessionError` in session.mjs: the status code lives with the error
 * rather than being re-derived by each route, so the two routes below cannot
 * disagree about what a validation failure is worth.
 *
 * `field` is one of:
 *   - a SETTINGS_FIELDS name, e.g. "processingJobs" or "scheduleHour", for a
 *     failure that belongs to the whole field (not an array, empty, too many,
 *     a duplicate job name, a duplicate job id);
 *   - an INDEXED per-job name of the form `processingJobs[<index>].<key>`, e.g.
 *     "processingJobs[2].domains", where `<index>` is the zero-based position in
 *     the SUBMITTED array and `<key>` is one of `name`, `schoolName`, `domains`,
 *     `searchTerms` (TASK-055, pluralised by TASK-059). The index is the
 *     submitted one so the form can
 *     point at the row the user is looking at;
 *   - null when the whole body was unusable.
 */
export class SettingsValidationError extends Error {
  /**
   * @param {string|null} field
   * @param {string} message Client-safe: shown to the user.
   */
  constructor(field, message) {
    super(message);
    this.name = "SettingsValidationError";
    this.statusCode = 400;
    this.field = field;
  }
}

/**
 * Count characters the way a person would: by code point, not by UTF-16 unit.
 *
 * `"👨‍👩‍👧".length` is 8 and `"é".length` can be 2 after decomposition, so a
 * `.length` bound silently rejects names that are well inside the limit as the
 * user sees it. ASCII behaves identically either way.
 *
 * @param {string} value
 * @returns {number}
 */
export function countCodePoints(value) {
  return [...value].length;
}

/**
 * Truncate a rejected value for an error message.
 *
 * The value is attacker-controllable text on its way into a response body (and
 * from there into a page), so it is length-capped, exactly as the OAuth error
 * `reason` is in index.mjs. It is NOT escaped here: the frontend escapes on
 * render, and escaping twice would show the user `&#39;` where they typed an
 * apostrophe.
 *
 * @param {unknown} value
 * @returns {string}
 */
function echo(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length > ECHO_LENGTH ? `${text.slice(0, ECHO_LENGTH)}...` : text;
}

/**
 * Reduce whatever the user pasted to a bare hostname.
 *
 * NORMALISE RATHER THAN REJECT. Every form below is a natural thing to paste out
 * of a browser or an email client, and refusing them teaches the user nothing
 * except that the field is fussy:
 *
 *   "@StMarys.EDU.au"             -> "stmarys.edu.au"   (an address fragment)
 *   "office@stmarys.edu.au"       -> "stmarys.edu.au"   (a whole address)
 *   "https://stmarys.edu.au/news" -> "stmarys.edu.au"   (a copied URL)
 *   "*.stmarys.edu.au"            -> "stmarys.edu.au"   (a wildcard pattern)
 *   "stmarys.edu.au:443"          -> "stmarys.edu.au"   (a URL with a port)
 *
 * Order matters: the scheme goes before the path split (otherwise "//" eats the
 * host), and the path split goes before the "@" cut (otherwise a "@" later in a
 * URL path would be read as an address separator).
 *
 * What is deliberately NOT normalised: a leading or trailing dot, and a trailing
 * hyphen. Those are not "a different way of writing a domain", they are typos or
 * truncation, and quietly repairing them would store a domain the user never
 * meant to enter. They fall through to `isValidDomain` and are refused.
 *
 * @param {unknown} raw
 * @returns {string} Normalised host, or "" when there is nothing left.
 */
export function normalizeDomain(raw) {
  if (typeof raw !== "string") return "";

  let value = raw.trim().toLowerCase();
  if (!value) return "";

  // Scheme ("https://", "mailto:" is handled by the "@" cut below) and the
  // protocol-relative "//" form.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^\/\//, "");

  // Path, query and fragment.
  value = value.split(/[/?#]/)[0];

  // An address or an address fragment: keep what follows the LAST "@".
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);

  // Wildcard prefixes, however many were pasted ("*.*.example.com").
  while (value.startsWith("*.")) value = value.slice(2);

  // Port.
  value = value.replace(/:\d+$/, "");

  return value.trim();
}

/**
 * Does this string have the shape of a public domain name?
 *
 * Applied AFTER `normalizeDomain`, to what is left. At least two labels, because
 * a single label ("stmarys", "localhost") can never be the domain of an email
 * sender and matching on one would be a filter that never fires.
 *
 * @param {string} value Already normalised and lower-cased.
 * @returns {boolean}
 */
export function isValidDomain(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false;

  const labels = value.split(".");
  if (labels.length < 2) return false;

  return labels.every(
    (label) => label.length > 0 && label.length <= MAX_DOMAIN_LABEL_LENGTH && DOMAIN_LABEL_PATTERN.test(label)
  );
}

/**
 * Validate and normalise the school display names.
 *
 * NO LONGER ON THE SETTINGS REQUEST PATH (TASK-055). `requireValidSettings` does
 * not call this - a processing job carries exactly one school name, validated by
 * `validateProcessingJobs`. Retained and still exported because it is imported
 * outside this file, and because its structure is what the per-job validator
 * mirrors.
 *
 * Mirrors `validateSearchDomains` - count first, normalise each entry, then
 * de-duplicate with input order preserved - with three deliberate differences,
 * because these are display text rather than hostnames:
 *
 *  - NO LOWER-CASING. A domain is lower-cased because DNS is case-insensitive
 *    and the label grammar below is lowercase-only; capitalisation in "St Mary's
 *    Primary" is the user's own and is what the model is shown.
 *  - DE-DUPLICATION IS EXACT, on the trimmed string, for the same reason: "St
 *    Marys" and "ST MARYS" are two spellings the user may have meant to give,
 *    and folding them is a decision this layer has no basis to make.
 *  - A BARE STRING IS ONE NAME, never comma-split. A school name may legitimately
 *    contain a comma ("St Mary's Primary, Manly"), and splitting it would store
 *    two names neither of which the user typed. The single-string form is the
 *    LEGACY request shape (a `schoolName` scalar from a browser tab loaded before
 *    TASK-053 deployed) and is accepted so an in-flight save is not answered with
 *    a 400 that reads to the user like data loss.
 *
 * Trimming is not sanitisation - it removes only leading and trailing
 * whitespace, which no user meant to type - and each value is stored exactly as
 * returned here, apostrophes, ampersands, hyphens and accents intact.
 *
 * @param {unknown} raw An array of names, or a single name.
 * @returns {string[]} Trimmed, de-duplicated, order preserved.
 * @throws {SettingsValidationError}
 */
export function validateSchoolNames(raw) {
  const entries = typeof raw === "string" ? [raw] : raw;

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new SettingsValidationError("schoolNames", "At least one school name is required");
  }
  // Counted on what was SUBMITTED, before de-duplication, so eleven entries with
  // a duplicate among them is reported as "too many" rather than silently
  // collapsing to a number that happens to fit.
  if (entries.length > MAX_SCHOOL_NAMES) {
    throw new SettingsValidationError("schoolNames", `Enter at most ${MAX_SCHOOL_NAMES} school names`);
  }

  const seen = new Set();
  const names = [];

  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new SettingsValidationError("schoolNames", "Each school name must be text");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      // Covers both "missing" and "spaces only": to the user they are one mistake.
      throw new SettingsValidationError("schoolNames", "School name is required");
    }
    if (countCodePoints(trimmed) > MAX_SCHOOL_NAME_LENGTH) {
      throw new SettingsValidationError(
        "schoolNames",
        `"${echo(trimmed)}" is longer than ${MAX_SCHOOL_NAME_LENGTH} characters`
      );
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }

  return names;
}

/**
 * Validate and normalise the domain list.
 *
 * NO LONGER ON THE SETTINGS REQUEST PATH (TASK-055), for the same reason as
 * `validateSchoolNames`: a processing job carries its own `domains` list
 * (TASK-059), validated by `validateJobDomains` through the same
 * `normalizeDomain` -> `isValidDomain` -> `isPublicMailDomain` sequence. This
 * function remains the reference for that shape, and `validateJobDomains` is its
 * indexed, per-job sibling - the ONE rule it diverges on is the empty list, which
 * is a mistake for a whole connection but not for one job.
 *
 * Rule order is chosen so the message names the real problem:
 *  1. Is it a non-empty array at all, and within MAX_SEARCH_DOMAINS? The count is
 *     checked on what the user SUBMITTED, before de-duplication, so pasting
 *     fifteen domains is reported as "too many" rather than silently collapsing
 *     to a number that happens to fit.
 *  2. Normalise, then shape-check each entry.
 *  3. Refuse public mail hosts - by exact host, then by provider brand under any
 *     public suffix (`isPublicMailDomain`) - naming the offender either way, so the
 *     user can see which of their entries was the problem.
 *  4. De-duplicate.
 *
 * Duplicates COLLAPSE rather than erroring. Two spellings of the same domain are
 * one intent, not a mistake worth blocking a save for, and a string set could not
 * store them twice anyway.
 *
 * @param {unknown} raw
 * @returns {string[]} Normalised, de-duplicated, order preserved.
 * @throws {SettingsValidationError}
 */
export function validateSearchDomains(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SettingsValidationError("searchDomains", "At least one school email domain is required");
  }
  if (raw.length > MAX_SEARCH_DOMAINS) {
    throw new SettingsValidationError(
      "searchDomains",
      `Enter at most ${MAX_SEARCH_DOMAINS} school email domains`
    );
  }

  const seen = new Set();
  const domains = [];

  for (const entry of raw) {
    const domain = normalizeDomain(entry);
    if (!isValidDomain(domain)) {
      throw new SettingsValidationError(
        "searchDomains",
        `"${echo(entry)}" is not a valid email domain`
      );
    }
    if (isPublicMailDomain(domain)) {
      throw new SettingsValidationError(
        "searchDomains",
        `${domain} is a public email provider, not a school domain - use the school's own domain`
      );
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return domains;
}

/**
 * The canonical UUID shape, which is the ONLY id a client may keep.
 *
 * Anything else is replaced rather than refused (see `validateProcessingJobs`),
 * so this pattern is a filter, not a validation rule.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate one required free-text field of a processing job.
 *
 * Shared by `name` and `schoolName` so the two cannot drift. An ARRAY is refused
 * rather than having its first element taken: a job carries exactly one of each,
 * and silently keeping element zero would store something the user did not send.
 *
 * @param {unknown} raw
 * @param {{ field: string, label: string, max: number }} spec
 * @returns {string} Trimmed, case and characters untouched.
 * @throws {SettingsValidationError}
 */
function requiredJobText(raw, { field, label, max }) {
  if (raw === undefined || raw === null) {
    throw new SettingsValidationError(field, `${label} is required`);
  }
  if (typeof raw !== "string") {
    throw new SettingsValidationError(field, `${label} must be text`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Covers both "missing" and "spaces only": to the user they are one mistake.
    throw new SettingsValidationError(field, `${label} is required`);
  }
  if (countCodePoints(trimmed) > max) {
    throw new SettingsValidationError(field, `"${echo(trimmed)}" is longer than ${max} characters`);
  }
  return trimmed;
}

/**
 * Validate one job's sender domain list (TASK-059).
 *
 * The indexed, per-job sibling of `validateSearchDomains`, with the SAME rule
 * order so the message names the real problem:
 *  1. Shape and count. The count is checked on what was SUBMITTED, before
 *     de-duplication, so eleven entries with two duplicates among them is
 *     reported as "too many" rather than silently collapsing to a number that
 *     happens to fit.
 *  2. `normalizeDomain` each entry, then a BLANK check, then `isValidDomain`,
 *     then `isPublicMailDomain`. The blank check is split out of
 *     `validateSearchDomains`' single "not a valid email domain" branch on
 *     purpose: with several entries in one field, `"" is not a valid email
 *     domain` tells the user nothing, whereas "cannot be blank" names the
 *     mistake. It mirrors `validateSearchTerms`' blank-entry message.
 *  3. De-duplicate on the NORMALISED value, first occurrence wins.
 *
 * DUPLICATES COLLAPSE, THEY DO NOT ERROR - matching `validateSearchDomains`.
 * "StMarys.EDU.au", "@stmarys.edu.au" and "https://stmarys.edu.au/news" in one
 * list are three spellings of one intent, unlike a duplicate JOB NAME, which is
 * an identity clash and errors.
 *
 * ABSENT IS NOT A MISTAKE (the one deliberate divergence from
 * `validateSearchDomains`, which requires a non-empty list). `domains` is
 * OPTIONAL: `hasJobQueryClauses`/`buildJobQuery` (gmail.mjs) already build a
 * usable query from a quoted school name and/or search terms alone, and a job
 * that matches a school by name via a newsletter relay is legitimate. This
 * follows `validateSearchTerms`' null/undefined branch instead.
 *
 * A BARE STRING IS REFUSED, NEVER COMMA-SPLIT, for the same reason as
 * `validateSearchTerms`: guessing at a delimiter would store values the user
 * never typed. TASK-060's UI does the comma splitting client-side and sends a
 * list.
 *
 * @param {unknown} raw
 * @param {string} field Indexed field name for any error.
 * @returns {string[]} Normalised, de-duplicated, order preserved. `[]` when the
 *   caller sent nothing.
 * @throws {SettingsValidationError}
 */
function validateJobDomains(raw, field) {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    throw new SettingsValidationError(field, "School email domains must be a list");
  }
  if (raw.length > MAX_SEARCH_DOMAINS_PER_JOB) {
    throw new SettingsValidationError(
      field,
      `Enter at most ${MAX_SEARCH_DOMAINS_PER_JOB} school email domains for one processing job`
    );
  }

  const seen = new Set();
  const domains = [];

  for (const entry of raw) {
    // `normalizeDomain` returns "" for a non-string (a number, null, a nested
    // array), so those land on the blank message below rather than crashing.
    const domain = normalizeDomain(entry);
    if (domain === "") {
      throw new SettingsValidationError(field, "A school email domain cannot be blank");
    }
    if (!isValidDomain(domain)) {
      // The RAW entry is echoed, not the normalised one, so a user with several
      // domains in one field can see WHICH of them was wrong.
      throw new SettingsValidationError(field, `"${echo(entry)}" is not a valid email domain`);
    }
    if (isPublicMailDomain(domain)) {
      throw new SettingsValidationError(
        field,
        `${domain} is a public email provider, not a school domain - use the school's own domain`
      );
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  return domains;
}

/**
 * Validate one job's free-text search terms.
 *
 * @param {unknown} raw
 * @param {string} field Indexed field name for any error.
 * @returns {string[]} Trimmed, exactly de-duplicated, order preserved.
 * @throws {SettingsValidationError}
 */
function validateSearchTerms(raw, field) {
  // Absent is not a mistake - a job may legitimately match on its school name and
  // its domains alone - so null/undefined normalise to "no terms".
  if (raw === undefined || raw === null) return [];

  // A BARE STRING IS NOT ONE TERM AND IS NEVER COMMA-SPLIT. The API contract is a
  // list: guessing at a delimiter server-side would store terms the user never
  // typed, and the caller - which knows what it collected - is the only layer that
  // can split safely. The client sends a list or nothing.
  //
  // NOTE (TASK-060): a comma is now a DELIMITER in the settings UI's search-terms
  // field, so a term containing one can no longer be entered there; the UI splits
  // on it and sends the pieces. The old justification for this branch ("a search
  // term may legitimately contain a comma") no longer holds and has been removed -
  // do not restore it. The RULE itself is unchanged and still correct: this module
  // splits nothing.
  if (!Array.isArray(raw)) {
    throw new SettingsValidationError(field, "Search terms must be a list");
  }
  // Counted on what was SUBMITTED, before de-duplication, so twenty-one entries
  // with a duplicate among them is reported as "too many" rather than silently
  // collapsing to a number that happens to fit.
  if (raw.length > MAX_SEARCH_TERMS_PER_JOB) {
    throw new SettingsValidationError(
      field,
      `Enter at most ${MAX_SEARCH_TERMS_PER_JOB} search terms for one processing job`
    );
  }

  const seen = new Set();
  const terms = [];

  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new SettingsValidationError(field, "Each search term must be text");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new SettingsValidationError(field, "A search term cannot be blank");
    }
    if (countCodePoints(trimmed) > MAX_SEARCH_TERM_LENGTH) {
      throw new SettingsValidationError(
        field,
        `"${echo(trimmed)}" is longer than ${MAX_SEARCH_TERM_LENGTH} characters`
      );
    }
    // De-duplication is EXACT and case-sensitive, matching `validateSchoolNames`:
    // two casings are two spellings the user may have meant, and duplicates are
    // one intent rather than a mistake worth blocking a save for.
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    terms.push(trimmed);
  }

  return terms;
}

/**
 * Validate the whole processing-job list (TASK-055).
 *
 * Rule order is chosen so the message names the real problem, and mirrors
 * `validateSearchDomains`: shape and count of the COLLECTION first (counted on
 * what was submitted, before any de-duplication), then each job in submitted
 * order.
 *
 * DUPLICATE NAMES ERROR; they do NOT collapse. This is deliberately the OPPOSITE
 * of `validateSearchDomains`' collapse-duplicates rule. Two spellings of one
 * domain are one intent, but a job name is an IDENTITY the user picked and that
 * TASK-058's filter UI matches on, so two jobs that read the same in a list are a
 * mistake worth reporting. The compare is case-insensitive on a trimmed copy; the
 * STORED casing is the user's own, exactly as typed - lower-casing display text
 * is not this layer's decision (see `validateSchoolNames`).
 *
 * Two jobs MAY share a domain, a `schoolName`, or both, as long as their names
 * differ - "Newsletters" and "Sport" on one school domain is an ordinary setup,
 * and TASK-056 documents the duplicate events that follow as expected.
 *
 * REQUIRED VS OPTIONAL (TASK-059): `name` and `schoolName` are REQUIRED, and
 * `domains` is OPTIONAL - absent, null or `[]` all normalise to `[]` and save.
 * See `validateJobDomains` for why, and the module docblock for what still
 * guarantees a job is searchable.
 *
 * IDS ARE PRESERVED, NOT RE-MINTED, when the client echoes a canonical UUID back.
 * The PUT is a whole-list replace and never reads the stored row, so echoing is
 * the ONLY way an id survives a rename - and TASK-056 attributes events to it.
 * Any other id (absent, empty, non-string, malformed, or the synthesised literal
 * "default" that migrate-on-read hands out) is REPLACED with a fresh one rather
 * than refused: a migrated user's very first save legitimately echoes "default"
 * back, and 400ing that would block every one of them.
 *
 * @param {unknown} raw
 * @param {object} [deps]
 * @param {() => string} [deps.newId] Id generator; injectable so every branch is
 *   reachable with a stub and no randomness.
 * @returns {Array<{ id: string, name: string, schoolName: string, domains: string[], searchTerms: string[] }>}
 *   Exactly those five keys per job - an unknown key in the payload is DROPPED,
 *   so the stored item cannot grow a field nobody validated. That includes the
 *   superseded singular `domain` (TASK-059), which is neither read nor emitted.
 *   Input order preserved.
 * @throws {SettingsValidationError}
 */
export function validateProcessingJobs(raw, { newId = randomUUID } = {}) {
  if (!Array.isArray(raw)) {
    throw new SettingsValidationError("processingJobs", "processingJobs must be a list of processing jobs");
  }
  if (raw.length === 0) {
    throw new SettingsValidationError("processingJobs", "At least one processing job is required");
  }
  if (raw.length > MAX_PROCESSING_JOBS) {
    throw new SettingsValidationError("processingJobs", `Enter at most ${MAX_PROCESSING_JOBS} processing jobs`);
  }

  // Lower-cased name -> the casing the user actually typed, so the clash message
  // can quote both spellings. The stored value is always the typed one.
  const seenNames = new Map();
  const seenIds = new Set();
  const jobs = [];

  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    // A non-object entry is not a separate error class: it has no usable fields,
    // so it falls through to the required-field messages below and is reported as
    // the missing name it is.
    const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const at = (key) => `processingJobs[${index}].${key}`;

    const name = requiredJobText(source.name, {
      field: at("name"),
      label: "Processing job name",
      max: MAX_PROCESSING_JOB_NAME_LENGTH,
    });
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      // BOTH spellings are named: the compare is case-insensitive, so a user
      // looking at "St Mary's" and "ST MARY'S" needs to be told those two are the
      // clash rather than left to find it.
      throw new SettingsValidationError(
        "processingJobs",
        `"${echo(name)}" is the same processing job name as "${echo(seenNames.get(nameKey))}" - give each job a different name`
      );
    }
    seenNames.set(nameKey, name);

    const schoolName = requiredJobText(source.schoolName, {
      field: at("schoolName"),
      label: "School name",
      max: MAX_SCHOOL_NAME_LENGTH,
    });

    // The SINGULAR `source.domain` a pre-TASK-059 client may still send is not
    // read here at all: it is an unknown key and is dropped with the rest of
    // them, so such a payload saves a job with an empty `domains` list rather
    // than being silently aliased into the new field. See the co-deploy note in
    // the module docblock - TASK-060 is the matching frontend.
    const domains = validateJobDomains(source.domains, at("domains"));

    const searchTerms = validateSearchTerms(source.searchTerms, at("searchTerms"));

    const keepsId = typeof source.id === "string" && UUID_PATTERN.test(source.id);
    const id = keepsId ? source.id : newId();
    if (keepsId) {
      // Only a CLIENT-SUPPLIED id can collide - a generated one is fresh by
      // construction, and checking those too would only make an injected stub
      // generator that returns a constant look like a duplicate. Two jobs sharing
      // one id would make TASK-056's event attribution ambiguous, so this is
      // refused rather than quietly repaired. Compared case-insensitively: two
      // casings of one UUID are one id, however they were typed.
      const idKey = id.toLowerCase();
      if (seenIds.has(idKey)) {
        throw new SettingsValidationError("processingJobs", "Each processing job must have its own id");
      }
      seenIds.add(idKey);
    }

    jobs.push({ id, name, schoolName, domains, searchTerms });
  }

  return jobs;
}

/**
 * Validate the optional schedule fields.
 *
 * TASK-008 owns the scan schedule and writes these too; this route accepts them
 * so the settings form can save everything in one request. Only keys the caller
 * actually sent are validated and returned - an absent key means "leave whatever
 * is stored alone", never "reset it to a default".
 *
 * HTML form controls submit strings, so "true"/"false" and "7" are accepted for
 * the boolean and the hour and coerced to their real types. Coercion happens
 * here, once, rather than in the UI, so the stored types stay consistent whoever
 * is calling.
 *
 * @param {object} payload
 * @returns {{ scheduleEnabled?: boolean, scheduleFrequency?: string, scheduleHour?: number, timezone?: string }}
 * @throws {SettingsValidationError}
 */
export function validateSchedule(payload) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;

  if (has("scheduleEnabled")) {
    const value = payload.scheduleEnabled;
    if (value === true || value === "true") out.scheduleEnabled = true;
    else if (value === false || value === "false") out.scheduleEnabled = false;
    else throw new SettingsValidationError("scheduleEnabled", "Automatic scanning must be on or off");
  }

  if (has("scheduleFrequency")) {
    const value = typeof payload.scheduleFrequency === "string" ? payload.scheduleFrequency.trim().toLowerCase() : "";
    if (!SCHEDULE_FREQUENCIES.includes(value)) {
      throw new SettingsValidationError(
        "scheduleFrequency",
        `Frequency must be one of: ${SCHEDULE_FREQUENCIES.join(", ")}`
      );
    }
    out.scheduleFrequency = value;
  }

  if (has("scheduleHour")) {
    const raw = payload.scheduleHour;
    // Only a whole-number string is accepted; Number("") is 0 and Number(" ")
    // is 0, either of which would silently become midnight.
    const value = typeof raw === "number" ? raw : /^\d{1,2}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new SettingsValidationError("scheduleHour", "Scan hour must be a whole number from 0 to 23");
    }
    out.scheduleHour = value;
  }

  if (has("timezone")) {
    // The trimmed value is what is checked AND what is stored, so the zone this
    // route accepts is byte-for-byte the one the schedule route will be handed.
    const value = typeof payload.timezone === "string" ? payload.timezone.trim() : "";
    if (!isValidTimezone(value)) {
      throw new SettingsValidationError("timezone", `"${echo(payload.timezone)}" is not a valid time zone`);
    }
    out.timezone = value;
  }

  return out;
}

/**
 * Validate a whole settings payload without throwing.
 *
 * Pairs with `requireValidSettings` the way `readSession` pairs with
 * `requireSession`: a caller that wants a verdict gets one, a caller that wants
 * to fail fast throws.
 *
 * The `field` it reports carries whatever `requireValidSettings` threw, including
 * the indexed `processingJobs[<index>].<key>` form (TASK-055).
 *
 * @param {unknown} payload
 * @param {object} [options] Forwarded to `requireValidSettings` (`newId`).
 * @returns {{ valid: true, settings: object } | { valid: false, field: string|null, error: string }}
 */
export function validateSettingsPayload(payload, options = {}) {
  try {
    return { valid: true, settings: requireValidSettings(payload, options) };
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return { valid: false, field: err.field, error: err.message };
    }
    throw err;
  }
}

/**
 * Validate a whole settings payload, or throw a 400-shaped error.
 *
 * ONE REQUEST SHAPE (TASK-055): `processingJobs`, and only `processingJobs`. The
 * legacy `schoolNames`/`searchDomains`/`schoolName` keys are no longer read here
 * at all, so a body carrying only those is a 400 naming `processingJobs`. The
 * legacy shape survives only on the READ side, where `toPublicJson` migrates a
 * stored row into one synthesised job; there is no request-side alias. That makes
 * this ticket's frontend (TASK-057, and TASK-060 for the `domains` rename) a
 * required co-deploy - an older settings page cannot save against this contract.
 *
 * The schedule fields are unchanged and still optional: a key the caller omitted
 * means "leave whatever is stored alone", never "reset it".
 *
 * @param {unknown} payload
 * @param {object} [options] Forwarded to `validateProcessingJobs` (`newId`).
 * @returns {{ processingJobs: Array<object> } & Record<string, unknown>}
 * @throws {SettingsValidationError}
 */
export function requireValidSettings(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SettingsValidationError(null, "Expected a JSON object");
  }

  return {
    processingJobs: validateProcessingJobs(payload.processingJobs, options),
    ...validateSchedule(payload),
  };
}

/**
 * Parse a request body into an object.
 *
 * An absent or blank body is `{}` rather than an error: the validator then
 * reports the missing FIELD ("School name is required"), which is what the user
 * can act on, instead of a generic complaint about the body.
 *
 * `isBase64Encoded` is set by payload format 2.0 exactly as it was by the ALB
 * format, so a base64 body still decodes after TASK-049.
 *
 * @param {object} event Request event (function URL payload format 2.0).
 * @returns {object}
 * @throws {SettingsValidationError} When the body is not parseable JSON.
 */
export function parseJsonBody(event) {
  const raw = event?.body;
  if (typeof raw !== "string" || raw.trim() === "") return {};

  const text = event?.isBase64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The body itself is never logged or echoed - it is unvalidated input of
    // unknown size and may contain anything the caller chose to send.
    throw new SettingsValidationError(null, "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsValidationError(null, "Expected a JSON object");
  }
  return parsed;
}

/**
 * Turn validated settings into a DynamoDB patch.
 *
 * `processingJobs` is written as a PLAIN ARRAY OF PLAIN OBJECTS. The document
 * client marshals that to a List of Maps (`L` of `M`) on its own, which is the
 * stored shape - NOT a `Set` (this is not a string set, and a `Set` that escaped
 * into a response body would `JSON.stringify` to `{}`) and NOT a JSON string. A
 * job's `searchTerms` and its `domains` are likewise plain arrays, and an EMPTY
 * one is written AS an empty list: DynamoDB accepts an empty `L`, so there is
 * nothing to work around.
 *
 * The WHOLE-LIST-empty case writes `REMOVE_ATTRIBUTE` instead of an empty list.
 * That is a CONSISTENCY choice with the string-set attributes elsewhere - "unset"
 * has one representation on this row - and not a DynamoDB constraint: unlike an
 * empty `SS`, an empty `L` would store fine. The PUT route never reaches the
 * branch (it requires at least one job); any other caller that clears the list
 * gets the same "attribute absent" shape a never-configured row has.
 *
 * EVERY LEGACY ATTRIBUTE IS CLEARED IN THE SAME PATCH (TASK-055). Writing
 * `processingJobs` always also REMOVEs `schoolNames`, `searchDomains` AND the
 * pre-TASK-053 `schoolName` scalar, so a row can never carry both shapes and
 * `toPublicJson`'s migrate-on-read stops applying to it the moment its owner
 * saves. `schoolName` is in that list because a row that never saved since
 * TASK-053 still carries the scalar, and nothing writes `schoolNames` any more, so
 * nothing else would ever clear it. `buildUpdateParams` compiles the mixed
 * SET + REMOVE into one UpdateExpression, so this costs no extra write and needs
 * no migration job.
 *
 * @param {object} settings Output of `requireValidSettings`, or any subset of it.
 * @returns {Record<string, unknown>} Patch for `updateConnection`.
 */
export function buildConnectionPatch(settings = {}) {
  const patch = {};

  if (settings.processingJobs !== undefined) {
    // Stored raw. See the module docblock: escaping happens on render.
    const jobs = Array.isArray(settings.processingJobs) ? settings.processingJobs : [];
    patch.processingJobs =
      jobs.length > 0
        ? jobs.map((job) => ({
            // Rebuilt key by key rather than spread, so nothing that was not
            // validated can reach the stored item.
            id: job.id,
            name: job.name,
            schoolName: job.schoolName,
            // A copy, exactly as `searchTerms` below: an EMPTY list is written AS
            // an empty `L` (this is a list, not an `SS`, so the empty-set write
            // problem does not apply), which is the stored shape of the OPTIONAL
            // `domains` when the user watches no sender domain (TASK-059).
            domains: Array.isArray(job.domains) ? [...job.domains] : [],
            searchTerms: Array.isArray(job.searchTerms) ? [...job.searchTerms] : [],
          }))
        : REMOVE_ATTRIBUTE;
    patch.schoolNames = REMOVE_ATTRIBUTE;
    patch.searchDomains = REMOVE_ATTRIBUTE;
    patch.schoolName = REMOVE_ATTRIBUTE;
  }

  for (const key of ["scheduleEnabled", "scheduleFrequency", "scheduleHour", "timezone"]) {
    if (settings[key] !== undefined) patch[key] = settings[key];
  }

  return patch;
}

/**
 * Project a connection row as the settings response body.
 *
 * Built on `toPublicJson`, which is an allow-list: a stored attribute nobody
 * explicitly published cannot appear here, so `refreshTokenEnc` (and any
 * attribute a later ticket adds) is private by default rather than by vigilance.
 * The body therefore carries the SETTINGS_FIELDS plus `connected` /
 * `connectionStatus`, and no token material of any kind.
 *
 * `processingJobs` is reported as `[]` rather than null when unset, because every
 * consumer of THIS route treats it as a list and a null would just move that check
 * into the frontend. `/auth/me`, which projects through `toPublicJson` directly,
 * still reports null there - the same null-vs-empty split TASK-053 settled.
 *
 * @param {object|null} connection Row from `getConnection`/`updateConnection`.
 * @param {object} [fallback] Values to use when the row has none (the session's
 *   email, typically - a user who has signed in but has no row yet).
 * @param {object} [options] Forwarded to `toPublicJson` (`lookupFailed`).
 * @returns {Record<string, unknown>}
 */
export function toSettingsJson(connection, fallback = {}, options = {}) {
  const projection = toPublicJson(connection, fallback, options);
  return {
    ...projection,
    processingJobs: Array.isArray(projection.processingJobs) ? projection.processingJobs : [],
  };
}

/**
 * Read a user's settings.
 *
 * @param {string} sub Google `sub` claim (namespaced here).
 * @param {object} [deps]
 * @param {typeof getConnection} [deps.getConnection]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} Row without secrets, or null when the user has
 *   no row yet.
 */
export async function loadSettings(sub, { getConnection: loadConnection = getConnection, env = process.env } = {}) {
  return loadConnection(connectionUserId(sub), { env });
}

/**
 * Persist validated settings and return the stored row.
 *
 * Only `updateConnection` is used, never `putConnection`: a settings save must
 * patch the row, because `putConnection` is the only thing allowed to write token
 * attributes and the settings path must never be able to touch them. That is also
 * why the patch never carries a token attribute - `updateConnection` throws if it
 * does, and that guard is left in place rather than worked around.
 *
 * @param {string} sub Google `sub` claim.
 * @param {object} settings Output of `requireValidSettings`.
 * @param {object} [deps]
 * @param {typeof updateConnection} [deps.updateConnection]
 * @param {Record<string, string|undefined>} [deps.env]
 * @returns {Promise<object|null>} Updated row without secrets. Null only when the
 *   injected `updateItem` returned nothing - the real one returns ALL_NEW.
 */
export async function saveSettings(
  sub,
  settings,
  { updateConnection: patchConnection = updateConnection, updateItem, env = process.env } = {}
) {
  const patch = buildConnectionPatch(settings);
  // `updateItem` is forwarded so a caller (or a test) can drive the write without
  // replacing the whole of `updateConnection` and losing its containment guard.
  const deps = updateItem ? { env, updateItem } : { env };
  return patchConnection(connectionUserId(sub), patch, deps);
}

export { REMOVE_ATTRIBUTE };
