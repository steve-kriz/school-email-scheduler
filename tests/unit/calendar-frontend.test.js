/**
 * UNIT tests for TASK-010 - "Web UI: connect Gmail, settings, month calendar
 * and attention list".
 *
 * Scope of this file: the units, in isolation.
 *
 *   - the static-asset layer in `src/lambda/calendar/index.mjs`
 *     (`FRONTEND_FILES`, `FRONTEND_ROUTES`, `FRONTEND_CSP`, `readFrontendFile`,
 *     `routeFrontendRequest`), driven with an injected `readFile` and an
 *     injected cache so every disk read is counted rather than assumed;
 *   - every pure helper exported by `frontend/app.js` and `frontend/settings.js`;
 *   - `createApiClient`, which is where `credentials: "same-origin"` and the
 *     401 halt actually live;
 *   - source-level invariants over the five served files (no `innerHTML`, no
 *     secrets, no external origin).
 *
 * The end-to-end Gherkin scenarios are in
 * `tests/e2e/calendar-frontend-flow.test.js` and
 * `tests/e2e/calendar-frontend-timezone.test.js`.
 *
 * NO DATABASE IS TOUCHED HERE, and none is mocked either, because nothing on
 * these paths reaches one: `routeFrontendRequest` runs before any handler that
 * would, and the frontend modules only ever talk to an injected `fetch`. The
 * one I/O boundary that exists on this path - reading a file off disk - is
 * injected in every test that exercises it.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Set BEFORE index.mjs is imported: its LOG_LEVEL is read once at module load,
// so this has to happen ahead of the import, which is why the import is dynamic.
process.env.CALENDAR_LOG_LEVEL = 'none';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar');
const FRONTEND_DIR = path.join(CALENDAR_DIR, 'frontend');

const {
  routeFrontendRequest,
  readFrontendFile,
  FRONTEND_FILES,
  FRONTEND_ROUTES,
  FRONTEND_CSP,
} = await import('../../src/lambda/calendar/index.mjs');

const app = await import('../../src/lambda/calendar/frontend/app.js');
const settings = await import('../../src/lambda/calendar/frontend/settings.js');

const { parseHtml, findElements, textOf } = await import('../helpers/fake-dom.mjs');

/** Every file the service is allowed to read, as an absolute path. */
const ASSET_DIR = '/fake/bundle';
const EXPECTED_READ_PATHS = new Set(
  ['index.html', 'settings.html', 'app.js', 'settings.js', 'styles.css'].map((name) =>
    path.join(ASSET_DIR, 'frontend', name)
  )
);

/**
 * A recording stand-in for `readFileSync`.
 *
 * Every test that could read the disk uses this, so "no file outside frontend/
 * was read" is an assertion about recorded calls rather than an inference from
 * a status code.
 */
function makeReader(contents = {}) {
  const reads = [];
  const read = (filePath, encoding) => {
    reads.push({ filePath, encoding });
    const base = path.basename(String(filePath));
    if (Object.prototype.hasOwnProperty.call(contents, base)) return contents[base];
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    error.code = 'ENOENT';
    throw error;
  };
  return { read, reads };
}

const FILE_BODIES = {
  'index.html': '<!DOCTYPE html><html><body data-page="calendar"></body></html>',
  'settings.html': '<!DOCTYPE html><html><body data-page="settings"></body></html>',
  'app.js': 'export const APP = 1;',
  'settings.js': 'export const SETTINGS = 1;',
  'styles.css': ':root { color: black; }',
};

const headerOf = (response, name) => {
  const value = response.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

/* =========================================================================
 * The allowlist itself
 * ========================================================================= */

describe('TASK-010 unit: the static-asset allowlist', () => {
  it('names exactly five files and freezes the table', () => {
    assert.deepEqual(Object.keys(FRONTEND_FILES).sort(), [
      'app.js',
      'index.html',
      'settings.html',
      'settings.js',
      'styles.css',
    ]);
    assert.equal(Object.isFrozen(FRONTEND_FILES), true, 'FRONTEND_FILES must be frozen');
    assert.throws(() => {
      FRONTEND_FILES['../../etc/passwd'] = 'text/plain';
    }, TypeError);
  });

  it('gives each file the content type the ticket asks for', () => {
    assert.equal(FRONTEND_FILES['index.html'], 'text/html');
    assert.equal(FRONTEND_FILES['settings.html'], 'text/html');
    assert.equal(FRONTEND_FILES['app.js'], 'application/javascript');
    assert.equal(FRONTEND_FILES['settings.js'], 'application/javascript');
    assert.equal(FRONTEND_FILES['styles.css'], 'text/css');
  });

  it('maps nine exact request paths, and every target is an allowlisted file', () => {
    assert.equal(FRONTEND_ROUTES.size, 9);
    assert.deepEqual([...FRONTEND_ROUTES.keys()].sort(), [
      '/calendar',
      '/calendar/',
      '/calendar/app.js',
      '/calendar/index.html',
      '/calendar/settings',
      '/calendar/settings.html',
      '/calendar/settings.js',
      '/calendar/settings/',
      '/calendar/styles.css',
    ]);
    for (const [route, filename] of FRONTEND_ROUTES) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(FRONTEND_FILES, filename),
        true,
        `${route} points at "${filename}", which is not an allowlisted file`
      );
    }
  });

  it('routes every path the ticket names to the right file', () => {
    assert.equal(FRONTEND_ROUTES.get('/calendar'), 'index.html');
    assert.equal(FRONTEND_ROUTES.get('/calendar/'), 'index.html');
    assert.equal(FRONTEND_ROUTES.get('/calendar/settings'), 'settings.html');
    assert.equal(FRONTEND_ROUTES.get('/calendar/settings.html'), 'settings.html');
    assert.equal(FRONTEND_ROUTES.get('/calendar/app.js'), 'app.js');
    assert.equal(FRONTEND_ROUTES.get('/calendar/settings.js'), 'settings.js');
    assert.equal(FRONTEND_ROUTES.get('/calendar/styles.css'), 'styles.css');
  });

  it('carries a CSP that forbids the two things this app deliberately does not use', () => {
    assert.match(FRONTEND_CSP, /(^|;\s*)default-src 'self'/);
    assert.match(FRONTEND_CSP, /(^|;\s*)script-src 'self'/);
    assert.match(FRONTEND_CSP, /(^|;\s*)frame-ancestors 'none'/);
    assert.match(FRONTEND_CSP, /(^|;\s*)base-uri 'none'/);
    assert.equal(/unsafe-inline/.test(FRONTEND_CSP), false, 'inline script/style must not be allowed');
    assert.equal(/unsafe-eval/.test(FRONTEND_CSP), false);
  });
});

/* =========================================================================
 * readFrontendFile - the only place a filesystem path is built
 * ========================================================================= */

describe('TASK-010 unit: readFrontendFile', () => {
  it('reads exactly one path per allowlisted file, all of them under frontend/', () => {
    const { read, reads } = makeReader(FILE_BODIES);
    const cache = new Map();

    for (const filename of Object.keys(FRONTEND_FILES)) {
      const content = readFrontendFile(filename, { readFile: read, cache, assetDir: ASSET_DIR });
      assert.equal(content, FILE_BODIES[filename]);
    }

    assert.equal(reads.length, 5, 'one read per file, no more');
    for (const call of reads) {
      assert.equal(call.encoding, 'utf-8');
      assert.equal(
        EXPECTED_READ_PATHS.has(call.filePath),
        true,
        `read a path that is not one of the five allowlisted files: ${call.filePath}`
      );
      assert.equal(
        path.relative(path.join(ASSET_DIR, 'frontend'), call.filePath).startsWith('..'),
        false,
        `read escaped frontend/: ${call.filePath}`
      );
    }
  });

  it('serves the second request from the cache, with no further disk read', () => {
    const { read, reads } = makeReader(FILE_BODIES);
    const cache = new Map();

    for (const filename of Object.keys(FRONTEND_FILES)) {
      readFrontendFile(filename, { readFile: read, cache, assetDir: ASSET_DIR });
    }
    const afterFirstPass = reads.length;
    assert.equal(afterFirstPass, 5);

    for (let pass = 0; pass < 3; pass += 1) {
      for (const filename of Object.keys(FRONTEND_FILES)) {
        assert.equal(
          readFrontendFile(filename, { readFile: read, cache, assetDir: ASSET_DIR }),
          FILE_BODIES[filename]
        );
      }
    }
    assert.equal(reads.length, afterFirstPass, 'a warm cache must add ZERO reads');
  });

  it('refuses any name that is not an own key of the table, without touching the disk', () => {
    const hostile = [
      '../../etc/passwd',
      '../index.mjs',
      'frontend/app.js',
      '/etc/passwd',
      'app.js .png',
      'APP.JS',
      'index.html ',
      '',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ];
    const { read, reads } = makeReader(FILE_BODIES);
    const cache = new Map();

    for (const name of hostile) {
      assert.throws(
        () => readFrontendFile(name, { readFile: read, cache, assetDir: ASSET_DIR }),
        /not an allowlisted frontend file/,
        `"${name}" was not refused`
      );
    }
    assert.deepEqual(reads, [], 'a refused name must never reach the filesystem');
    assert.equal(cache.size, 0);
  });

  it('refuses a non-string name rather than coercing it into a path', () => {
    const { read, reads } = makeReader(FILE_BODIES);
    for (const name of [null, undefined, 42, {}, ['app.js'], Symbol.iterator]) {
      assert.throws(() => readFrontendFile(name, { readFile: read, cache: new Map(), assetDir: ASSET_DIR }));
    }
    assert.deepEqual(reads, []);
  });

  it('truncates the rejected name in its error, so an unbounded request value cannot fill the log', () => {
    const enormous = 'A'.repeat(5000);
    assert.throws(
      () => readFrontendFile(enormous, { readFile: () => '', cache: new Map(), assetDir: ASSET_DIR }),
      (error) => {
        assert.equal(error.message.includes('A'.repeat(64)), true);
        assert.equal(error.message.includes('A'.repeat(65)), false, 'the name was not truncated to 64 characters');
        return true;
      }
    );
  });

  it('lets a genuine read failure surface rather than caching a miss', () => {
    const { read, reads } = makeReader({});
    const cache = new Map();
    assert.throws(() => readFrontendFile('app.js', { readFile: read, cache, assetDir: ASSET_DIR }), /ENOENT/);
    assert.equal(cache.size, 0, 'a failed read must not poison the cache');
    assert.equal(reads.length, 1);
  });
});

/* =========================================================================
 * routeFrontendRequest
 * ========================================================================= */

describe('TASK-010 unit: routeFrontendRequest', () => {
  let reader;
  let cache;

  beforeEach(() => {
    reader = makeReader(FILE_BODIES);
    cache = new Map();
  });

  const call = (requestPath, method = 'GET') =>
    routeFrontendRequest(requestPath, method, {}, {
      readFile: reader.read,
      fileCache: cache,
      assetDir: ASSET_DIR,
    });

  it('serves each of the nine routes with its declared content type and nosniff', () => {
    for (const [route, filename] of FRONTEND_ROUTES) {
      const response = call(route);
      assert.notEqual(response, null, `${route} was not served`);
      assert.equal(response.statusCode, 200, route);
      assert.equal(headerOf(response, 'Content-Type'), FRONTEND_FILES[filename], route);
      assert.equal(headerOf(response, 'X-Content-Type-Options'), 'nosniff', route);
      assert.equal(response.body, FILE_BODIES[filename], route);
    }
  });

  it('adds the CSP and Referrer-Policy to the HTML pages only', () => {
    for (const route of ['/calendar', '/calendar/', '/calendar/index.html', '/calendar/settings', '/calendar/settings.html']) {
      const response = call(route);
      assert.equal(headerOf(response, 'Content-Security-Policy'), FRONTEND_CSP, route);
      assert.equal(headerOf(response, 'Referrer-Policy'), 'same-origin', route);
    }
    for (const route of ['/calendar/app.js', '/calendar/settings.js', '/calendar/styles.css']) {
      const response = call(route);
      assert.equal(headerOf(response, 'Content-Security-Policy'), undefined, route);
    }
  });

  it('builds no filesystem path from the request path - every read is one of five literals', () => {
    for (const route of FRONTEND_ROUTES.keys()) call(route);
    assert.equal(reader.reads.length, 5, 'nine routes, five files, five reads');
    for (const { filePath } of reader.reads) {
      assert.equal(EXPECTED_READ_PATHS.has(filePath), true, `unexpected read: ${filePath}`);
    }
  });

  it('reads each file once no matter how many times its routes are requested', () => {
    for (let pass = 0; pass < 4; pass += 1) {
      for (const route of FRONTEND_ROUTES.keys()) {
        assert.equal(call(route).statusCode, 200);
      }
    }
    assert.equal(reader.reads.length, 5, 'four passes over nine routes must still be five reads');
  });

  it('returns null for a method other than GET, so an asset path cannot be posted to', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(call('/calendar/app.js', method), null, method);
      assert.equal(call('/calendar', method), null, method);
    }
    assert.deepEqual(reader.reads, [], 'a non-GET must not read anything');
  });

  it('returns null - and reads nothing - for every traversal and near-miss form', () => {
    const hostile = [
      '/calendar/../../etc/passwd',
      '/calendar/../../../etc/passwd',
      '/calendar/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/calendar/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
      '/calendar/..%2f..%2fetc%2fpasswd',
      '/calendar/..%252f..%252fetc%252fpasswd',
      '/calendar/....//....//etc/passwd',
      '/calendar/..\\..\\etc\\passwd',
      '/CALENDAR/APP.JS',
      '/Calendar/App.js',
      '/calendar/frontend/app.js',
      '/calendar/app.js/',
      '/calendar/app.js%00.png',
      '/calendar/app.js?x=1',
      '/calendar//app.js',
      '/calendar/./app.js',
      '/calendar/index.mjs',
      '/calendar/backend/settings.mjs',
      '/calendar/package.json',
      '/calendar/../index.mjs',
      '/calendar/settings.js.map',
      '/calendar/.env',
      '//calendar/app.js',
      '/calendar ',
      ' /calendar',
      '/calendar/app.js#frag',
      '/calendar/%61pp.js',
      '/calendar/app%2Ejs',
      '/etc/passwd',
      '',
      '/',
    ];
    for (const requestPath of hostile) {
      assert.equal(call(requestPath), null, `"${requestPath}" was served instead of falling through to the 404`);
    }
    assert.deepEqual(reader.reads, [], 'a rejected path must open nothing at all');
    assert.equal(cache.size, 0);
  });

  it('returns null for the API paths, so no static route can shadow one', () => {
    for (const apiPath of [
      '/calendar/api/auth/me',
      '/calendar/api/auth/google/start',
      '/calendar/api/auth/disconnect',
      '/calendar/api/settings',
      '/calendar/api/scan',
      '/calendar/api/events',
      '/calendar/api/events/upcoming',
      '/calendar/api/events/abc/acknowledge',
    ]) {
      assert.equal(call(apiPath), null, apiPath);
    }
    assert.deepEqual(reader.reads, []);
  });

  it('answers 500, not a stack trace, when an allowlisted file cannot be read', () => {
    const broken = makeReader({});
    const response = routeFrontendRequest('/calendar', 'GET', {}, {
      readFile: broken.read,
      fileCache: new Map(),
      assetDir: ASSET_DIR,
    });
    assert.equal(response.statusCode, 500);
    assert.equal(headerOf(response, 'Content-Type'), 'application/json');
    const body = JSON.parse(response.body);
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(/ENOENT|\/fake\/bundle|at /.test(body.error), false, `the 500 leaked detail: ${body.error}`);
  });
});

/* =========================================================================
 * Source-level invariants over the five SERVED files
 * ========================================================================= */

describe('TASK-010 unit: what the browser is actually sent', () => {
  const served = Object.keys(FRONTEND_FILES).map((name) => ({
    name,
    source: fs.readFileSync(path.join(FRONTEND_DIR, name), 'utf-8'),
  }));

  it('ships all five files', () => {
    assert.equal(served.length, 5);
    for (const file of served) assert.ok(file.source.length > 0, `${file.name} is empty`);
  });

  it('contains no innerHTML assignment anywhere, in any served file', () => {
    for (const { name, source } of served) {
      assert.deepEqual(source.match(/\.innerHTML/g) || [], [], `${name} reaches the DOM through innerHTML`);
      assert.deepEqual(source.match(/\.outerHTML/g) || [], [], `${name} uses outerHTML`);
      assert.deepEqual(source.match(/insertAdjacentHTML/g) || [], [], `${name} uses insertAdjacentHTML`);
      assert.deepEqual(source.match(/document\.write/g) || [], [], `${name} uses document.write`);
    }
  });

  it('does build text, so the innerHTML check above is not vacuous', () => {
    for (const name of ['app.js', 'settings.js']) {
      const source = served.find((file) => file.name === name).source;
      assert.match(source, /textContent/, `${name} sets no text at all`);
    }
    // app.js owns the one createElement in the app; settings.js builds its DOM
    // through app.js's `el` helper rather than duplicating it.
    assert.match(served.find((file) => file.name === 'app.js').source, /doc\.createElement\(/);
    const settingsSource = served.find((file) => file.name === 'settings.js').source;
    assert.match(settingsSource, /\bel\b[\s\S]{0,400}from\s+"\.\/app\.js"/, 'settings.js does not import the el helper');
    assert.match(settingsSource, /\bel\(doc,/, 'settings.js creates no elements at all');
  });

  it('evaluates nothing at runtime', () => {
    for (const { name, source } of served) {
      assert.equal(/\beval\s*\(/.test(source), false, `${name} calls eval`);
      assert.equal(/new\s+Function\s*\(/.test(source), false, `${name} builds a Function from a string`);
    }
  });

  it('contains no API key, client secret or token', () => {
    const patterns = [
      [/AIza[0-9A-Za-z_-]{10,}/, 'a Google API key'],
      [/GOCSPX-[0-9A-Za-z_-]{5,}/, 'a Google client secret'],
      [/\bya29\.[0-9A-Za-z_-]{10,}/, 'a Google access token'],
      [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
      [/\bsk-[0-9A-Za-z]{20,}/, 'an API secret key'],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
      [/client[_-]?secret/i, 'a client secret'],
      [/\bapi[_-]?key\b/i, 'an api key'],
      [/\bapiKey\b/, 'an apiKey'],
      [/\baccess[_-]?token\b/i, 'an access token'],
      [/\brefresh[_-]?token\b/i, 'a refresh token'],
      [/\bBearer\s+[0-9A-Za-z._-]{10,}/, 'a bearer token'],
      [/\beyJ[0-9A-Za-z_-]{10,}\./, 'a JWT'],
      [/\bAWS_SECRET/i, 'an AWS secret'],
      [/\bSESSION_SECRET\b/, 'the session secret'],
      [/\bKMS_KEY\b/i, 'a KMS key id'],
    ];
    for (const { name, source } of served) {
      for (const [pattern, what] of patterns) {
        assert.equal(pattern.test(source), false, `${name} appears to contain ${what}: ${pattern}`);
      }
    }
  });

  it('depends on no external origin - no CDN script, no remote stylesheet, no web font', () => {
    for (const { name, source } of served) {
      // mail.google.com is the one deliberate exception: app.js's "Open email"
      // link is an outbound <a href> the user clicks to leave the app, never a
      // resource this page loads (script/stylesheet/font) - the risk this guard
      // exists for. See buildGmailSearchUrl.
      assert.equal(
        /https?:\/\/(?!www\.w3\.org|mail\.google\.com)/.test(source),
        false,
        `${name} references an absolute external URL`
      );
      assert.equal(/\/\/cdn\./.test(source), false, `${name} references a CDN`);
    }
    const css = served.find((file) => file.name === 'styles.css').source;
    assert.equal(/@import/.test(css), false, 'styles.css imports another stylesheet');
    assert.equal(/url\s*\(/.test(css), false, 'styles.css fetches a resource');
  });

  it('has no inline script and no inline event handler in either HTML page', () => {
    for (const name of ['index.html', 'settings.html']) {
      const doc = parseHtml(served.find((file) => file.name === name).source);
      const scripts = findElements(doc, 'script');
      assert.equal(scripts.length, 1, `${name} should carry exactly one script element`);
      assert.equal(scripts[0].getAttribute('type'), 'module');
      assert.match(scripts[0].getAttribute('src'), /^\/calendar\/(app|settings)\.js$/);
      assert.equal(textOf(scripts[0]), '', `${name} carries an inline script body`);

      const source = served.find((file) => file.name === name).source;
      assert.equal(
        /\son[a-z]+\s*=/i.test(source),
        false,
        `${name} carries an inline event handler attribute`
      );
    }
  });

  it('sends the session cookie on every request, and never offers it cross-origin', () => {
    for (const name of ['app.js', 'settings.js']) {
      const source = served.find((file) => file.name === name).source;
      assert.match(source, /credentials:\s*"same-origin"/, `${name} does not send credentials`);
      assert.equal(/credentials:\s*"include"/.test(source), false, `${name} offers the cookie cross-origin`);
      assert.equal(/credentials:\s*"omit"/.test(source), false, `${name} drops the cookie`);
    }
  });

  it('boots only on its own page, so importing app.js from settings.js starts no calendar', () => {
    const appSource = served.find((file) => file.name === 'app.js').source;
    const settingsSource = served.find((file) => file.name === 'settings.js').source;
    assert.match(appSource, /data-page"\)\s*===\s*"calendar"/);
    assert.match(settingsSource, /data-page"\)\s*===\s*"settings"/);
    assert.equal(parseHtml(served.find((f) => f.name === 'index.html').source).body.getAttribute('data-page'), 'calendar');
    assert.equal(parseHtml(served.find((f) => f.name === 'settings.html').source).body.getAttribute('data-page'), 'settings');
  });
});

/* =========================================================================
 * app.js - date handling
 * ========================================================================= */

describe('TASK-010 unit: date helpers', () => {
  it('recognises a bare calendar date and nothing else', () => {
    assert.equal(app.isDateOnly('2026-09-04'), true);
    assert.equal(app.isDateOnly(' 2026-09-04 '), true);
    assert.equal(app.isDateOnly('2026-09-04T09:00:00.000Z'), false);
    assert.equal(app.isDateOnly('2026-9-4'), false);
    assert.equal(app.isDateOnly(''), false);
    assert.equal(app.isDateOnly(null), false);
    assert.equal(app.isDateOnly(20260904), false);
  });

  it('places a date-only event by its stored string, with no Date conversion at all', () => {
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04' }), '2026-09-04');
    assert.equal(app.eventDateKey({ startsAt: ' 2026-09-04 ' }), '2026-09-04');
    // The canonical stored form: normaliseInstant writes UTC midnight + allDay.
    assert.equal(app.eventDateKey({ startsAt: '2026-09-04T00:00:00.000Z', allDay: true }), '2026-09-04');
  });

  it('returns null rather than a wrong day for an unusable start', () => {
    assert.equal(app.eventDateKey({}), null);
    assert.equal(app.eventDateKey({ startsAt: '' }), null);
    assert.equal(app.eventDateKey({ startsAt: 'not a date' }), null);
    assert.equal(app.eventDateKey(null), null);
    assert.equal(app.eventDateKey({ startsAt: 'nope', allDay: true }), null);
  });

  it('builds a local date key from the local getters, not from the UTC ones', () => {
    const local = new Date(2026, 8, 4, 23, 30);
    assert.equal(app.localDateKey(local), '2026-09-04');
    assert.equal(app.localDateKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
  });

  it('gives a month its first and last calendar date', () => {
    assert.deepEqual(app.monthRange(2026, 8), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(app.monthRange(2026, 9), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(app.monthRange(2024, 1), { from: '2024-02-01', to: '2024-02-29' });
    assert.deepEqual(app.monthRange(2026, 1), { from: '2026-02-01', to: '2026-02-28' });
  });

  it('lays the month out as whole weeks with one in-month cell per day', () => {
    const weeks = app.buildMonthMatrix(2026, 8);
    for (const week of weeks) assert.equal(week.length, 7);
    const cells = weeks.flat();
    assert.equal(cells.length % 7, 0);
    const inMonth = cells.filter((cell) => cell.inMonth);
    assert.equal(inMonth.length, 30, 'September has 30 days');
    assert.equal(inMonth[0].dateKey, '2026-09-01');
    assert.equal(inMonth[29].dateKey, '2026-09-30');
    assert.deepEqual(
      inMonth.map((cell) => cell.dayOfMonth),
      Array.from({ length: 30 }, (unused, index) => index + 1)
    );
    // 2026-09-01 is a Tuesday, so the grid opens with Sunday 30 August.
    assert.equal(cells[0].dateKey, '2026-08-30');
    assert.equal(cells[0].inMonth, false);
  });

  it('handles a month that starts on the Sunday and one that ends on the Saturday', () => {
    const february = app.buildMonthMatrix(2026, 1).flat();
    assert.equal(february[0].dateKey, '2026-02-01', 'February 2026 starts on a Sunday');
    assert.equal(february.filter((cell) => cell.inMonth).length, 28);
    const december = app.buildMonthMatrix(2025, 11).flat();
    assert.equal(december.filter((cell) => cell.inMonth).length, 31);
    assert.equal(december.length % 7, 0);
  });

  it('says "All day" for an all-day event and a clock time for a timed one', () => {
    assert.equal(app.formatEventTime({ startsAt: '2026-09-04', allDay: true }), 'All day');
    assert.equal(app.formatEventTime({ startsAt: '2026-09-04' }), 'All day');
    assert.equal(app.formatEventTime({ startsAt: 'rubbish' }), '');
    assert.notEqual(app.formatEventTime({ startsAt: '2026-09-04T09:00:00.000Z' }, 'en-AU'), 'All day');
  });

  it('names the same calendar day for an all-day event whichever way it was stored', () => {
    const bare = app.formatEventWhen({ startsAt: '2026-09-04' }, 'en-AU');
    const canonical = app.formatEventWhen({ startsAt: '2026-09-04T00:00:00.000Z', allDay: true }, 'en-AU');
    assert.match(bare, /^All day on /);
    assert.equal(bare, canonical);
    assert.match(bare, /4/);
  });

  it('renders a date key without a timezone conversion', () => {
    const rendered = app.formatDateKey('2026-09-04', 'en-AU');
    assert.match(rendered, /\b4\b/);
    assert.match(rendered, /Sep/i);
    assert.match(rendered, /2026/);
    assert.equal(app.formatDateKey('not-a-date', 'en-AU'), 'not-a-date');
  });

  it('labels the month for the heading', () => {
    assert.match(app.monthLabel(2026, 8, 'en-AU'), /September\s+2026/);
    assert.match(app.monthLabel(2026, 9, 'en-AU'), /October\s+2026/);
  });
});

/* =========================================================================
 * app.js - ordering, grouping, overflow
 * ========================================================================= */

describe('TASK-010 unit: ordering and grouping', () => {
  const timed = (id, iso, title = id) => ({ eventId: id, startsAt: iso, title });

  it('orders a day soonest first, with all-day items ahead of timed ones', () => {
    const midday = timed('b', `2026-09-04T${String(new Date(2026, 8, 4, 12).getUTCHours()).padStart(2, '0')}:00:00.000Z`);
    const list = [midday, { eventId: 'a', startsAt: '2026-09-04', allDay: true, title: 'Assembly' }];
    const ordered = list.slice().sort(app.compareByStart);
    assert.equal(ordered[0].eventId, 'a', 'the all-day item leads the cell');
  });

  it('breaks a tie by title so the order does not flicker between renders', () => {
    const a = { eventId: '1', startsAt: '2026-09-04', allDay: true, title: 'Zebra' };
    const b = { eventId: '2', startsAt: '2026-09-04', allDay: true, title: 'Apple' };
    assert.deepEqual([a, b].sort(app.compareByStart).map((event) => event.title), ['Apple', 'Zebra']);
    assert.deepEqual([b, a].sort(app.compareByStart).map((event) => event.title), ['Apple', 'Zebra']);
  });

  it('buckets events by day and drops the ones with no usable start', () => {
    const grouped = app.groupEventsByDay([
      { eventId: '1', startsAt: '2026-09-04', allDay: true, title: 'A' },
      { eventId: '2', startsAt: '2026-09-18', allDay: true, title: 'B' },
      { eventId: '3', startsAt: '2026-09-04', allDay: true, title: 'C' },
      { eventId: '4', startsAt: 'garbage', title: 'D' },
      null,
    ]);
    assert.deepEqual([...grouped.keys()].sort(), ['2026-09-04', '2026-09-18']);
    assert.equal(grouped.get('2026-09-04').length, 2);
    assert.equal(grouped.get('2026-09-18').length, 1);
  });

  it('returns an empty grouping for a non-array', () => {
    assert.equal(app.groupEventsByDay(null).size, 0);
    assert.equal(app.groupEventsByDay(undefined).size, 0);
    assert.equal(app.groupEventsByDay('nope').size, 0);
  });

  it('splits a day into its all-day band and its timed chips', () => {
    const split = app.splitDayEvents([
      { eventId: '1', startsAt: '2026-09-04T09:00:00.000Z', title: 'Timed' },
      { eventId: '2', startsAt: '2026-09-04', allDay: true, title: 'Band' },
      { eventId: '3', startsAt: '2026-09-04T00:00:00.000Z', allDay: true, title: 'Also band' },
    ]);
    assert.equal(split.allDay.length, 2);
    assert.equal(split.timed.length, 1);
    assert.equal(split.timed[0].eventId, '1');
  });

  it('counts only what does not fit', () => {
    assert.equal(app.overflowCount(6, 3), 3);
    assert.equal(app.overflowCount(3, 3), 0);
    assert.equal(app.overflowCount(0, 3), 0);
    assert.equal(app.overflowCount(4, 0), 4 - app.MAX_CHIPS_PER_DAY);
    assert.equal(app.overflowCount(NaN, 3), 0);
  });

  it('orders the attention list by deadline, treating a bare date as end of day', () => {
    const early = { eventId: '1', dueBy: '2026-09-04T01:00:00.000Z', title: 'Early' };
    const bare = { eventId: '2', dueBy: '2026-09-04', title: 'Bare' };
    const later = { eventId: '3', dueBy: '2026-09-05T01:00:00.000Z', title: 'Later' };
    const none = { eventId: '4', title: 'No deadline' };
    const ordered = [none, later, bare, early].sort(app.compareByDueBy).map((event) => event.eventId);
    assert.deepEqual(ordered, ['1', '2', '3', '4']);
  });

  it('knows an item is overdue from the server flag or from its own clock', () => {
    const nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    assert.equal(app.isOverdueEvent({ overdue: true }, nowMs), true, 'the server flag is trusted');
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-01T00:00:00.000Z' }, nowMs), true);
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-30T00:00:00.000Z' }, nowMs), false);
    assert.equal(app.isOverdueEvent({}, nowMs), false, 'no deadline is not overdue');
    // A bare date is due at the END of that day, so it is not overdue at 00:00.
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-10' }, nowMs), false);
    assert.equal(app.isOverdueEvent({ dueBy: '2026-09-09' }, nowMs), true);
  });

  it('says so plainly when there is no deadline', () => {
    assert.equal(app.formatDeadline(undefined), 'no deadline recorded');
    assert.equal(app.formatDeadline(''), 'no deadline recorded');
    assert.equal(app.formatDeadline('rubbish'), 'no deadline recorded');
    assert.match(app.formatDeadline('2026-09-04', 'en-AU'), /4/);
  });
});

/* =========================================================================
 * app.js - the scan sentence
 * ========================================================================= */

describe('TASK-010 unit: scanResultMessage', () => {
  it('reports the counts with the right plurals', () => {
    assert.equal(
      app.scanResultMessage({ messagesScanned: 1, eventsCreated: 1 }),
      'Scanned 1 message and found 1 event.'
    );
    assert.equal(
      app.scanResultMessage({ messagesScanned: 12, eventsCreated: 0 }),
      'Scanned 12 messages and found 0 events.'
    );
  });

  it('ALWAYS tells the user mail remains when the run was capped', () => {
    const message = app.scanResultMessage({ messagesScanned: 500, eventsCreated: 9, truncated: true });
    assert.ok(message.includes(app.SCAN_TRUNCATED_MESSAGE), message);
    assert.match(message, /more mail remains/i);
  });

  it('does not claim mail remains when it does not', () => {
    assert.equal(/more mail remains/i.test(app.scanResultMessage({ messagesScanned: 5, eventsCreated: 1 })), false);
    assert.equal(/more mail remains/i.test(app.scanResultMessage({ truncated: false })), false);
  });

  it('explains an unconfigured account instead of reporting zero scanned', () => {
    const message = app.scanResultMessage({ status: 'not_configured' });
    assert.match(message, /school name/i);
    assert.equal(/Scanned 0/.test(message), false);
  });

  it('survives a missing or malformed body', () => {
    assert.equal(typeof app.scanResultMessage(null), 'string');
    assert.equal(typeof app.scanResultMessage('nope'), 'string');
    assert.equal(typeof app.scanResultMessage(undefined), 'string');
  });

  it('says "a scan is already running" in the words the user reads', () => {
    assert.match(app.SCAN_BUSY_MESSAGE, /a scan is already running/);
  });
});

/* =========================================================================
 * app.js - connectionView
 * ========================================================================= */

describe('TASK-010 unit: connectionView', () => {
  it('treats a missing /auth/me body as signed out', () => {
    for (const value of [null, undefined, 'nope', 42]) {
      assert.deepEqual(app.connectionView(value), {
        signedIn: false,
        needsConnect: true,
        needsSchool: false,
        needsReauth: false,
      });
    }
  });

  // TASK-055/TASK-057 replaced `schoolNames` with `processingJobs`; the gate is
  // the same gate, read off the new key.
  const namedJob = (name = 'Ashfield Public School') => ({
    id: 'job-1',
    name,
    schoolName: name,
    domain: 'ashfield.nsw.edu.au',
    searchTerms: [],
  });

  it('asks for a school when no job is stored', () => {
    const view = app.connectionView({ connectionStatus: 'connected', processingJobs: [namedJob('   ')] });
    assert.equal(view.signedIn, true);
    assert.equal(view.needsSchool, true, 'a job with a blank name is not a configured job');
    assert.equal(view.needsConnect, false);
  });

  it('asks to reconnect when the last scan reported reauth_required', () => {
    const view = app.connectionView({
      connectionStatus: 'connected',
      processingJobs: [namedJob()],
      lastScanStatus: 'reauth_required',
    });
    assert.equal(view.needsReauth, true);
    assert.equal(view.needsSchool, false);
  });

  it('does not read "unknown" as "not connected"', () => {
    assert.equal(app.connectionView({ connectionStatus: 'unknown', processingJobs: [namedJob('X')] }).needsConnect, false);
    assert.equal(
      app.connectionView({ connectionStatus: 'not_connected', processingJobs: [namedJob('X')] }).needsConnect,
      true
    );
  });

  it('keeps the three flags independent, so no message is swallowed by another', () => {
    const view = app.connectionView({
      connectionStatus: 'not_connected',
      processingJobs: [],
      lastScanStatus: 'reauth_required',
    });
    assert.deepEqual(view, { signedIn: true, needsConnect: true, needsSchool: true, needsReauth: true });
  });
});

/* =========================================================================
 * app.js - the API client
 * ========================================================================= */

describe('TASK-010 unit: createApiClient', () => {
  const okResponse = (payload, status = 200) => ({
    status,
    json: async () => payload,
  });

  it('sends credentials: "same-origin" on every verb', async () => {
    const calls = [];
    const api = app.createApiClient({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return okResponse({});
      },
    });

    await api.get('/calendar/api/auth/me');
    await api.post('/calendar/api/scan');
    await api.post('/calendar/api/events/e1/acknowledge');
    await api.put('/calendar/api/settings', { schoolName: 'X' });
    await api.del('/calendar/api/scan/schedule');

    assert.equal(calls.length, 5);
    for (const { url, init } of calls) {
      assert.equal(init.credentials, 'same-origin', `${url} was sent without the session cookie`);
    }
    assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'POST', 'POST', 'PUT', 'DELETE']);
  });

  it('sends a JSON content type only when there is a body', async () => {
    const calls = [];
    const api = app.createApiClient({
      fetchImpl: async (url, init) => {
        calls.push(init);
        return okResponse({});
      },
    });
    await api.get('/x');
    await api.put('/y', { schoolName: 'Ashfield' });

    assert.equal(calls[0].headers['Content-Type'], undefined);
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[1].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[1].body), { schoolName: 'Ashfield' });
    assert.equal(calls[0].headers.Accept, 'application/json');
  });

  it('halts on the first 401, signals once, and sends nothing afterwards', async () => {
    let fetches = 0;
    let signals = 0;
    const api = app.createApiClient({
      fetchImpl: async () => {
        fetches += 1;
        return okResponse({}, 401);
      },
      onUnauthorized: () => {
        signals += 1;
      },
    });

    const first = await api.get('/calendar/api/auth/me');
    assert.deepEqual({ ok: first.ok, status: first.status, data: first.data }, { ok: false, status: 401, data: null });
    assert.equal(api.isHalted(), true);

    const second = await api.get('/calendar/api/events');
    const third = await api.post('/calendar/api/scan');
    assert.equal(second.halted, true);
    assert.equal(third.halted, true);
    assert.equal(fetches, 1, 'a halted client must not touch the network again');
    assert.equal(signals, 1, 'onUnauthorized must fire exactly once');

    api.reset();
    assert.equal(api.isHalted(), false);
  });

  it('turns a thrown fetch into a status 0 result rather than leaking the error', async () => {
    const api = app.createApiClient({
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND https://internal.example');
      },
    });
    const result = await api.get('/calendar/api/events');
    assert.deepEqual(result, { ok: false, status: 0, data: null, networkError: true });
    assert.equal(JSON.stringify(result).includes('internal.example'), false);
  });

  it('treats an unparseable body as no data rather than throwing', async () => {
    const api = app.createApiClient({
      fetchImpl: async () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    });
    const result = await api.get('/x');
    assert.deepEqual(result, { ok: true, status: 200, data: null });
  });

  it('reports a non-2xx as not ok while still handing back the body', async () => {
    const api = app.createApiClient({
      fetchImpl: async () => okResponse({ error: 'gmail.com is a public mail provider', field: 'searchDomains' }, 400),
    });
    const result = await api.put('/calendar/api/settings', {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.data.field, 'searchDomains');
  });

  it('falls back to the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return okResponse({ ok: true });
    };
    try {
      const api = app.createApiClient({});
      await api.get('/calendar/api/auth/me');
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(seen.url, '/calendar/api/auth/me');
    assert.equal(seen.init.credentials, 'same-origin');
  });
});

/* =========================================================================
 * app.js - the small DOM helpers, and escaping at the unit level
 * ========================================================================= */

describe('TASK-010 unit: DOM helpers escape by construction', () => {
  const blankDocument = () => parseHtml('<!DOCTYPE html><html><body><div id="host"></div></body></html>');

  it('puts a hostile string in as character data, creating no element', () => {
    const doc = blankDocument();
    const node = app.el(doc, 'span', 'chip-title', '<img src=x onerror=alert(1)>');
    doc.getElementById('host').appendChild(node);

    assert.equal(node.tagName, 'SPAN');
    assert.equal(node.className, 'chip-title');
    assert.equal(node.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(node.childNodes.length, 1);
    assert.equal(node.childNodes[0].nodeType, 3, 'the payload became a text node, not markup');
    assert.deepEqual(findElements(doc, 'img'), [], 'an IMG element was created from the payload');
    assert.deepEqual(findElements(doc, 'script'), []);
  });

  it('coerces a non-string body rather than rendering "[object Object]" markup', () => {
    const doc = blankDocument();
    assert.equal(app.el(doc, 'span', null, 0).textContent, '0');
    assert.equal(app.el(doc, 'span', null, false).textContent, 'false');
    assert.equal(app.el(doc, 'span', null, undefined).childNodes.length, 0);
    assert.equal(app.el(doc, 'span', null, null).childNodes.length, 0);
  });

  it('empties a node one child at a time, needing no markup assignment', () => {
    const doc = blankDocument();
    const host = doc.getElementById('host');
    for (let index = 0; index < 5; index += 1) host.appendChild(app.el(doc, 'p', null, `row ${index}`));
    assert.equal(host.childNodes.length, 5);
    app.clear(host);
    assert.equal(host.childNodes.length, 0);
    assert.equal(host.firstChild, null);
    app.clear(null);
    app.clear(undefined);
  });

  it('never renders "null" or "undefined" to the user', () => {
    assert.equal(app.textOr(null), 'Not recorded');
    assert.equal(app.textOr(undefined), 'Not recorded');
    assert.equal(app.textOr('   '), 'Not recorded');
    assert.equal(app.textOr('', 'nothing here'), 'nothing here');
    assert.equal(app.textOr(' Term 3 Newsletter '), 'Term 3 Newsletter');
    assert.equal(app.textOr(0), '0');
  });
});

describe('buildGmailSearchUrl: the event detail panel\'s "Open email" link', () => {
  it('builds a subject-only search when there is no sender', () => {
    const url = app.buildGmailSearchUrl({ subject: 'Term 3 Newsletter' });
    assert.equal(url, 'https://mail.google.com/mail/#search/subject%3A%22Term%203%20Newsletter%22');
  });

  it('ORs in the sender when one is given', () => {
    const url = app.buildGmailSearchUrl({ subject: 'Term 3 Newsletter', from: 'office@school.edu.au' });
    assert.equal(
      url,
      'https://mail.google.com/mail/#search/subject%3A%22Term%203%20Newsletter%22%20from%3A%22office%40school.edu.au%22'
    );
  });

  it('scopes the link to the signed-in account with authuser', () => {
    const url = app.buildGmailSearchUrl({ subject: 'Term 3 Newsletter', email: 'parent@example.test' });
    assert.match(url, /^https:\/\/mail\.google\.com\/mail\/\?authuser=parent%40example\.test#search\//);
  });

  it('returns null when there is no subject to search for', () => {
    assert.equal(app.buildGmailSearchUrl({}), null);
    assert.equal(app.buildGmailSearchUrl({ subject: '' }), null);
    assert.equal(app.buildGmailSearchUrl({ subject: '   ' }), null);
    assert.equal(app.buildGmailSearchUrl(), null);
  });

  it('drops a literal quote instead of letting it end the quoted term early', () => {
    const url = app.buildGmailSearchUrl({ subject: 'Say "hi"' });
    assert.match(url, /subject%3A%22Say%20hi%22/);
  });

  it('never lets subject/sender content change the URL\'s origin or scheme', () => {
    const url = app.buildGmailSearchUrl({
      subject: '<iframe src=javascript:alert(1)>',
      from: '"><img src=x onerror=alert(2)>',
    });
    assert.match(url, /^https:\/\/mail\.google\.com\/mail\//);
    assert.equal(url.includes('<'), false);
    assert.equal(url.includes('>'), false);
    assert.equal(/javascript:/i.test(url), false);
  });
});

describe('TASK-010 unit: renderConnectionCards', () => {
  const host = () => {
    const doc = parseHtml('<!DOCTYPE html><html><body><section id="connection-state"></section></body></html>');
    return { doc, container: doc.getElementById('connection-state') };
  };

  it('offers the Google start URL to a signed-out visitor', () => {
    const { doc, container } = host();
    const view = app.renderConnectionCards(doc, container, null);
    assert.equal(view.signedIn, false);

    const action = doc.getElementById('connect-gmail');
    assert.notEqual(action, null);
    assert.equal(action.tagName, 'A');
    assert.equal(action.getAttribute('href'), '/calendar/api/auth/google/start');
    assert.equal(textOf(action), app.CONNECT_PROMPT);
    assert.equal(doc.getElementById('identity-card'), null, 'a signed-out visitor has no identity card');
  });

  it('prompts for a school and links to settings', () => {
    const { doc, container } = host();
    app.renderConnectionCards(doc, container, { connectionStatus: 'connected', email: 'p@example.test', processingJobs: [] });
    const prompt = doc.getElementById('school-setup');
    assert.notEqual(prompt, null);
    assert.match(textOf(prompt), /Tell us your school/);
    assert.equal(doc.getElementById('school-setup-link').getAttribute('href'), '/calendar/settings');
  });

  it('shows the reconnect banner as an alert rather than an empty month', () => {
    const { doc, container } = host();
    app.renderConnectionCards(doc, container, {
      connectionStatus: 'connected',
      processingJobs: [{ id: 'job-1', name: 'Ashfield Public School' }],
      lastScanStatus: 'reauth_required',
    });
    const banner = doc.getElementById('reauth-banner');
    assert.notEqual(banner, null);
    assert.equal(banner.getAttribute('role'), 'alert');
    assert.match(textOf(banner), /Reconnect Gmail/);
    assert.equal(doc.getElementById('reconnect-gmail').getAttribute('href'), '/calendar/api/auth/google/start');
  });

  it('renders a hostile job name as literal text and creates no element from it', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { doc, container } = host();
    app.renderConnectionCards(doc, container, {
      connectionStatus: 'connected',
      email: 'parent@example.test',
      processingJobs: [{ id: 'job-1', name: payload }],
    });
    const name = doc.getElementById('identity-school-name');
    assert.notEqual(name, null);
    assert.equal(name.textContent, `Watching mail for ${payload}`);
    assert.deepEqual(findElements(doc, 'img'), []);
    assert.deepEqual(findElements(doc, 'script'), []);
  });

  it('clears the container before re-rendering, so a stale prompt cannot linger', () => {
    const { doc, container } = host();
    app.renderConnectionCards(doc, container, null);
    assert.notEqual(doc.getElementById('connect-card'), null);
    app.renderConnectionCards(doc, container, {
      connectionStatus: 'connected',
      processingJobs: [{ id: 'job-1', name: 'Ashfield' }],
    });
    assert.equal(doc.getElementById('connect-card'), null, 'the connect card outlived the sign-in');
  });

  it('returns the view without throwing when there is no container', () => {
    const { doc } = host();
    assert.deepEqual(app.renderConnectionCards(doc, null, null), {
      signedIn: false,
      needsConnect: true,
      needsSchool: false,
      needsReauth: false,
    });
  });
});

/* =========================================================================
 * settings.js - pure helpers
 * ========================================================================= */

describe('TASK-010 unit: settings.js helpers', () => {
  it('maps a server field name to an id that exists in settings.html, and fails closed', () => {
    const doc = parseHtml(fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf-8'));
    for (const field of Object.keys(settings.FIELD_ERROR_IDS)) {
      const id = settings.fieldErrorId(field);
      assert.notEqual(doc.getElementById(id), null, `${field} -> ${id} does not exist in settings.html`);
    }
    assert.notEqual(doc.getElementById(settings.FORM_ERROR_ID), null);

    for (const hostile of ['__proto__', 'constructor', 'toString', 'nonsense', 42, null, undefined, {}]) {
      assert.equal(settings.fieldErrorId(hostile), settings.FORM_ERROR_ID, String(hostile));
    }
  });

  // TASK-057 replaced the two split-on-punctuation textareas with one editable
  // row per job, so `parseDomainList`/`formatDomainList` are gone. Their
  // equivalents in the new shape are the row normaliser and the row-to-payload
  // builder. TASK-059 made `domain` a `domains` LIST and TASK-060 renders that
  // list into one comma-separated input, so the splitting rule moved rather
  // than disappearing: `toEditableJobs` still never splits - it keeps whatever
  // list was stored - and `splitCommaList` owns the one place a comma matters.
  it('normalises a stored list into editable rows, keeping the stored list as a list', () => {
    const rows = settings.toEditableJobs([
      {
        id: 'job-1',
        name: 'Ashfield',
        schoolName: 'Ashfield PS',
        domains: ['a.edu.au', 'b.edu.au'],
        searchTerms: ['x'],
      },
    ]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].domains, ['a.edu.au', 'b.edu.au'], 'a stored list is kept entry-for-entry');
    assert.equal('domain' in rows[0], false, 'the superseded singular key survived on an editable row');
    assert.deepEqual(rows[0].searchTerms, ['x']);
    // A stored value that is not a list at all - a legacy `domain` scalar, a
    // null - is no entries, so the field renders empty rather than throwing.
    assert.deepEqual(settings.toEditableJobs([{ domains: 'a.edu.au, b.edu.au' }])[0].domains, []);
    // Values reach an input's `value` untrimmed: trimming what the user is
    // about to edit would move their caret. The trim happens on the way out.
    assert.equal(settings.toEditableJobs([{ name: '  Ashfield  ' }])[0].name, '  Ashfield  ');
  });

  it('tolerates the shapes a first run and a malformed body can produce', () => {
    assert.deepEqual(settings.toEditableJobs(null), []);
    assert.deepEqual(settings.toEditableJobs('Ashfield'), []);
    assert.deepEqual(settings.toEditableJobs(undefined), []);
    const blank = { id: '', name: '', schoolName: '', domains: [], searchTerms: [] };
    assert.deepEqual(settings.toEditableJobs([null, 7]), [blank, blank]);
    assert.deepEqual(settings.emptyProcessingJob(), blank);
  });

  it('trims on the way out, drops blank list entries, and never invents an id', () => {
    assert.deepEqual(
      settings.buildJobsPayload([
        {
          id: '  job-1  ',
          name: ' Ashfield ',
          schoolName: ' Ashfield PS ',
          domains: [' a.edu.au ', '  ', 7],
          searchTerms: [' x ', '  ', 7],
        },
        { id: '', key: 'row-2', name: 'Beta', schoolName: 'Beta PS', domains: ['b.edu.au'], searchTerms: [] },
      ]),
      [
        { id: 'job-1', name: 'Ashfield', schoolName: 'Ashfield PS', domains: ['a.edu.au'], searchTerms: ['x'] },
        // No `id` key at all for a row added this session, and the client-side
        // `key` is never sent.
        { name: 'Beta', schoolName: 'Beta PS', domains: ['b.edu.au'], searchTerms: [] },
      ]
    );
    assert.deepEqual(settings.buildJobsPayload(null), []);
  });

  it('always sends processingJobs, and omits the schedule fields left blank', () => {
    const payload = settings.buildSettingsPayload({
      processingJobs: [
        {
          id: 'job-1',
          name: '  Ashfield  ',
          schoolName: '  Ashfield Public School  ',
          domains: ['ashfield.nsw.edu.au'],
        },
      ],
      scheduleEnabled: false,
      scheduleFrequency: '',
      scheduleHour: '',
      timezone: '',
    });
    assert.deepEqual(payload, {
      processingJobs: [
        {
          id: 'job-1',
          name: 'Ashfield',
          schoolName: 'Ashfield Public School',
          domains: ['ashfield.nsw.edu.au'],
          searchTerms: [],
        },
      ],
      scheduleEnabled: false,
    });
    assert.equal('schoolNames' in payload, false);
    assert.equal('searchDomains' in payload, false);
    assert.equal('scheduleHour' in payload, false);
    assert.equal('timezone' in payload, false);

    // The empty list is still SENT: an absent key would read to the server as
    // "leave what is stored alone", so clearing the list would be a silent no-op.
    const cleared = settings.buildSettingsPayload({ processingJobs: [], scheduleEnabled: false });
    assert.deepEqual(cleared.processingJobs, []);
    assert.ok('processingJobs' in cleared);

    const full = settings.buildSettingsPayload({
      processingJobs: [{ name: 'X', schoolName: 'X School', domain: 'x.edu.au' }],
      scheduleEnabled: true,
      scheduleFrequency: 'weekly',
      scheduleHour: '7',
      timezone: 'Australia/Sydney',
    });
    assert.equal(full.scheduleFrequency, 'weekly');
    assert.equal(full.scheduleHour, '7');
    assert.equal(full.timezone, 'Australia/Sydney');
    assert.equal(full.scheduleEnabled, true);
  });

  it('sends dayOfWeek only for a weekly schedule', () => {
    const weekly = settings.buildSchedulePayload({ scheduleFrequency: 'weekly', scheduleHour: '7', dayOfWeek: '3', timezone: 'UTC' });
    assert.equal(weekly.dayOfWeek, '3');
    const daily = settings.buildSchedulePayload({ scheduleFrequency: 'daily', scheduleHour: '7', dayOfWeek: '3', timezone: 'UTC' });
    assert.equal('dayOfWeek' in daily, false);
  });

  it('falls back to UTC rather than throwing when the zone cannot be read', () => {
    assert.equal(typeof settings.detectTimezone(), 'string');
    assert.notEqual(settings.detectTimezone(), '');
  });

  it('refuses to build a page without a document instead of silently doing nothing', () => {
    assert.throws(() => settings.createSettingsPage({ document: null }), /document is required/);
    assert.throws(() => app.createCalendarApp({ document: null }), /document is required/);
  });
});
