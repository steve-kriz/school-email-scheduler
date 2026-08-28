/**
 * E2E (cucumber-style) scenarios for TASK-010 - "Web UI: connect Gmail,
 * settings, month calendar and attention list".
 *
 * These are the ticket's Gherkin scenarios written Given/When/Then, driven end
 * to end through the code that actually ships:
 *
 *   - the static half runs through the REAL Lambda `handler`, so the dispatch
 *     order, the allowlist, the cache and the headers are all exercised the way
 *     a browser would exercise them;
 *   - the client half runs the REAL `frontend/app.js` and `frontend/settings.js`
 *     against the REAL `frontend/index.html` and `frontend/settings.html`,
 *     parsed into the DOM stand-in in `tests/helpers/fake-dom.mjs`. Nothing here
 *     asserts against markup a test invented: a renamed id or a `hidden` that
 *     stopped shipping turns these red.
 *
 * NO DATABASE CONNECTION IS OPENED, and none can be. The static routes never
 * reach a data layer at all, and the client only ever talks to an injected
 * `fetch` - there is no real `fetch` in scope in any scenario below. The only
 * other I/O boundary, reading an asset off disk, is injected wherever a scenario
 * counts reads.
 *
 * TWO HARNESS RULES THAT MATTER:
 *   1. `dispatch()` awaits its handlers (several of them are async). A
 *      synchronous dispatch returns before the fetch resolves and invents
 *      failures.
 *   2. Every stubbed response body is a FRESH structuredClone. `state.attention`
 *      aliases the parsed array, and the optimistic splice mutates it - handing
 *      back the same array object twice would corrupt the fixture rather than
 *      test the code.
 */

import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must precede the index.mjs import: its log level is read once at module load.
process.env.CALENDAR_LOG_LEVEL = 'none';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar');
const FRONTEND_DIR = path.join(CALENDAR_DIR, 'frontend');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');
const SETTINGS_HTML = path.join(FRONTEND_DIR, 'settings.html');

const { handler, FRONTEND_ROUTES, FRONTEND_FILES } = await import('../../src/lambda/calendar/index.mjs');
const app = await import('../../src/lambda/calendar/frontend/app.js');
const settingsModule = await import('../../src/lambda/calendar/frontend/settings.js');
const { loadDocument, findElements, textOf } = await import('../helpers/fake-dom.mjs');

const XSS = '<img src=x onerror=alert(1)>';

/** Noon-ish on 15 September 2026 UTC+10; September 2026 in every real zone. */
const NOW = Date.parse('2026-09-15T02:00:00.000Z');
const VIEW_YEAR = new Date(NOW).getFullYear();
const VIEW_MONTH = new Date(NOW).getMonth();
const TODAY_KEY = app.localDateKey(new Date(NOW));

/** An ISO instant for a LOCAL wall-clock time, so a scenario is zone-proof. */
const localIso = (year, month, day, hour = 9, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();

/** Let every already-resolved promise chain settle. */
async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const albEvent = (requestPath, method = 'GET') => ({
  path: requestPath,
  httpMethod: method,
  headers: {},
  queryStringParameters: {},
  body: null,
  isBase64Encoded: false,
});

const headerOf = (response, name) => {
  const value = response.multiValueHeaders?.[name];
  return Array.isArray(value) ? value[0] : value;
};

/* =========================================================================
 * The world: an injected fetch that answers the calendar API, and nothing else.
 * ========================================================================= */

function makeWorld(overrides = {}) {
  const world = {
    calls: [],
    meStatus: 200,
    me: {
      connectionStatus: 'connected',
      email: 'parent@example.test',
      schoolName: 'Ashfield Public School',
      lastScanStatus: 'ok',
    },
    events: [],
    truncated: false,
    attention: [],
    settings: {
      connectionStatus: 'connected',
      email: 'parent@example.test',
      schoolName: 'Ashfield Public School',
      searchDomains: ['ashfield-p.schools.nsw.edu.au'],
      scheduleEnabled: false,
      scheduleFrequency: 'daily',
      scheduleHour: 7,
      timezone: 'Australia/Sydney',
    },
    settingsPutStatus: 200,
    settingsPutBody: null,
    scanStatus: 200,
    scanBody: { status: 'ok', messagesScanned: 12, eventsCreated: 3 },
    mutationStatus: 200,
    mutationBody: { ok: true },
    scheduleStatus: 200,
    scheduleBody: { available: true },
    /** When set, EVERY route answers with this status - used to expire a session. */
    forceStatus: null,
    /** Called with (path, init) before the response is chosen; for probes. */
    onRequest: null,
    ...overrides,
  };

  const reply = (status, body) => ({ status, json: async () => structuredClone(body ?? {}) });

  world.fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const requestPath = full.split('?')[0];
    const query = full.slice(requestPath.length);
    const call = { url: full, path: requestPath, query, method: init.method || 'GET', init };
    world.calls.push(call);
    if (typeof world.onRequest === 'function') world.onRequest(call);

    if (world.forceStatus !== null) return reply(world.forceStatus, { error: 'Not signed in' });

    if (requestPath === '/calendar/api/auth/me') {
      return world.meStatus === 200 ? reply(200, world.me) : reply(world.meStatus, { error: 'Not signed in' });
    }
    if (requestPath === '/calendar/api/events') {
      return reply(200, { events: world.events, truncated: world.truncated });
    }
    if (requestPath === '/calendar/api/events/upcoming') {
      return reply(200, { events: world.attention });
    }
    if (/^\/calendar\/api\/events\/[^/]+\/(acknowledge|dismiss|restore)$/.test(requestPath)) {
      return reply(world.mutationStatus, world.mutationBody);
    }
    if (requestPath === '/calendar/api/scan') {
      return reply(world.scanStatus, world.scanBody);
    }
    if (requestPath === '/calendar/api/settings') {
      if ((init.method || 'GET') === 'PUT') {
        return reply(world.settingsPutStatus, world.settingsPutBody ?? world.settings);
      }
      return reply(200, world.settings);
    }
    if (requestPath === '/calendar/api/scan/schedule') {
      return reply(world.scheduleStatus, world.scheduleBody);
    }
    throw new Error(`the page requested a route the world does not know: ${init.method || 'GET'} ${full}`);
  };

  return world;
}

/** Injected timers, so "polling stopped" is an observable fact. */
function makeTimers() {
  const timers = { nextId: 1, started: [], cleared: [], fn: null };
  timers.setIntervalImpl = (fn, ms) => {
    const id = timers.nextId;
    timers.nextId += 1;
    timers.fn = fn;
    timers.started.push({ id, ms });
    return id;
  };
  timers.clearIntervalImpl = (id) => {
    timers.cleared.push(id);
  };
  /** Fire the interval callback the way a browser would, then let it settle. */
  timers.fire = async () => {
    if (typeof timers.fn !== 'function') throw new Error('no interval was ever started');
    timers.fn();
    await drain();
  };
  return timers;
}

/** Open the real calendar page against the real app.js. */
function openCalendar(world, options = {}) {
  const doc = loadDocument(INDEX_HTML);
  const timers = makeTimers();
  const controller = app.createCalendarApp({
    document: doc,
    fetchImpl: world.fetchImpl,
    now: () => NOW,
    locale: 'en-AU',
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    ...options,
  });
  return { doc, timers, controller };
}

/** Open the real settings page against the real settings.js. */
function openSettings(world, options = {}) {
  const doc = loadDocument(SETTINGS_HTML);
  const page = settingsModule.createSettingsPage({
    document: doc,
    fetchImpl: world.fetchImpl,
    detectTimezone: () => 'Australia/Sydney',
    ...options,
  });
  return { doc, page };
}

const chipsIn = (cell) => cell.querySelectorAll('.chip');
const cellFor = (doc, dateKey) => doc.getElementById('calendar-grid').querySelector(`[data-date="${dateKey}"]`);

/* =========================================================================
 * Feature: Serving the browser app from the Lambda
 * ========================================================================= */

describe('Feature: The browser app is served from the Lambda', () => {
  describe('Scenario: The calendar page is served as HTML', () => {
    it('Given a browser, When GET /calendar is requested, Then it returns 200 and text/html', async () => {
      const response = await handler(albEvent('/calendar'), {}, {});
      assert.equal(response.statusCode, 200);
      assert.equal(headerOf(response, 'Content-Type'), 'text/html');
      assert.match(response.body, /^<!DOCTYPE html>/);
      assert.match(response.body, /data-page="calendar"/);
    });

    it('And the trailing-slash and index.html forms serve the same page', async () => {
      const bare = await handler(albEvent('/calendar'), {}, {});
      for (const alias of ['/calendar/', '/calendar/index.html']) {
        const response = await handler(albEvent(alias), {}, {});
        assert.equal(response.statusCode, 200, alias);
        assert.equal(response.body, bare.body, alias);
      }
    });

    it('And the page is served with a CSP that allows neither inline script nor a CDN', async () => {
      const response = await handler(albEvent('/calendar'), {}, {});
      const csp = headerOf(response, 'Content-Security-Policy');
      assert.match(csp, /script-src 'self'/);
      assert.equal(/unsafe-inline/.test(csp), false);
      assert.equal(headerOf(response, 'X-Content-Type-Options'), 'nosniff');
    });
  });

  describe('Scenario: The module and the stylesheet are served with the right types', () => {
    it('When GET /calendar/app.js is requested, Then it returns 200 and application/javascript', async () => {
      const response = await handler(albEvent('/calendar/app.js'), {}, {});
      assert.equal(response.statusCode, 200);
      assert.equal(headerOf(response, 'Content-Type'), 'application/javascript');
      assert.match(response.body, /export function createCalendarApp/);
    });

    it('And GET /calendar/styles.css returns 200 and text/css', async () => {
      const response = await handler(albEvent('/calendar/styles.css'), {}, {});
      assert.equal(response.statusCode, 200);
      assert.equal(headerOf(response, 'Content-Type'), 'text/css');
    });

    it('And GET /calendar/settings serves the settings page and /calendar/settings.js its module', async () => {
      const page = await handler(albEvent('/calendar/settings'), {}, {});
      assert.equal(page.statusCode, 200);
      assert.equal(headerOf(page, 'Content-Type'), 'text/html');
      assert.match(page.body, /data-page="settings"/);

      const script = await handler(albEvent('/calendar/settings.js'), {}, {});
      assert.equal(script.statusCode, 200);
      assert.equal(headerOf(script, 'Content-Type'), 'application/javascript');
    });
  });

  describe('Scenario Outline: Static serving resists path traversal', () => {
    const HOSTILE = [
      '/calendar/../../etc/passwd',
      '/calendar/../../../etc/passwd',
      '/calendar/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/calendar/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
      '/calendar/..%2f..%2fetc%2fpasswd',
      '/calendar/..%252f..%252fetc%252fpasswd',
      '/calendar/....//....//etc/passwd',
      '/CALENDAR/APP.JS',
      '/calendar/frontend/app.js',
      '/calendar/../index.mjs',
      '/calendar/index.mjs',
      '/calendar/backend/settings.mjs',
      '/calendar/package.json',
      '/calendar/.env',
      '/calendar/app.js/../../index.mjs',
      '/etc/passwd',
    ];

    it('When each hostile path is requested, Then the response status code is 404', async () => {
      for (const requestPath of HOSTILE) {
        const response = await handler(albEvent(requestPath), {}, {});
        assert.equal(response.statusCode, 404, `${requestPath} did not 404`);
        assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ['error', 'path']);
      }
    });

    it('And NO file outside frontend/ is opened - proven on the recorded reads, not on the status', async () => {
      const reads = [];
      const readFile = (filePath, encoding) => {
        reads.push(filePath);
        return `stub:${path.basename(String(filePath))}:${encoding}`;
      };
      for (const requestPath of HOSTILE) {
        const response = await handler(albEvent(requestPath), {}, {
          readFile,
          fileCache: new Map(),
          assetDir: '/fake/bundle',
        });
        assert.equal(response.statusCode, 404, requestPath);
      }
      assert.deepEqual(reads, [], `a traversal path opened a file: ${reads.join(', ')}`);
    });

    it('And a POST to an asset path is not served either', async () => {
      const reads = [];
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const response = await handler(albEvent('/calendar/app.js', method), {}, {
          readFile: (filePath) => {
            reads.push(filePath);
            return '';
          },
          fileCache: new Map(),
          assetDir: '/fake/bundle',
        });
        assert.equal(response.statusCode, 404, `${method} /calendar/app.js was served`);
      }
      assert.deepEqual(reads, []);
    });
  });

  describe('Scenario: Static file resolution uses an explicit allowlist', () => {
    it('Given every served route, Then each read path is one of exactly five literals under frontend/', async () => {
      const reads = [];
      const deps = {
        readFile: (filePath) => {
          reads.push(filePath);
          return `stub:${path.basename(String(filePath))}`;
        },
        fileCache: new Map(),
        assetDir: '/fake/bundle',
      };
      for (const route of FRONTEND_ROUTES.keys()) {
        const response = await handler(albEvent(route), {}, deps);
        assert.equal(response.statusCode, 200, route);
      }

      const expected = new Set(
        Object.keys(FRONTEND_FILES).map((name) => path.join('/fake/bundle', 'frontend', name))
      );
      assert.equal(reads.length, 5, `expected five reads for nine routes, got ${reads.length}`);
      for (const filePath of reads) {
        assert.equal(expected.has(filePath), true, `a path was built from request input: ${filePath}`);
      }
    });

    it('And no request-path text ever reaches the filesystem, even for a path that looks like a filename', async () => {
      const reads = [];
      const deps = {
        readFile: (filePath) => {
          reads.push(filePath);
          return '';
        },
        fileCache: new Map(),
        assetDir: '/fake/bundle',
      };
      for (const requestPath of [
        '/calendar/robots.txt',
        '/calendar/favicon.ico',
        '/calendar/app.js.map',
        '/calendar/styles.css.map',
        '/calendar/settings.html.bak',
      ]) {
        assert.equal((await handler(albEvent(requestPath), {}, deps)).statusCode, 404, requestPath);
      }
      assert.deepEqual(reads, []);
    });
  });

  describe('Scenario: Files are read once and served from the cache', () => {
    it('Given a cold cache, When every asset is requested, Then there is exactly one read per file', async () => {
      const reads = [];
      const deps = {
        readFile: (filePath) => {
          reads.push(filePath);
          return `stub:${path.basename(String(filePath))}`;
        },
        fileCache: new Map(),
        assetDir: '/fake/bundle',
      };

      for (const route of FRONTEND_ROUTES.keys()) {
        assert.equal((await handler(albEvent(route), {}, deps)).statusCode, 200, route);
      }
      assert.equal(reads.length, 5);
      assert.equal(new Set(reads).size, 5, 'the same file was read twice on the first pass');
      assert.equal(deps.fileCache.size, 5);
    });

    it('And a second pass over every asset adds ZERO reads', async () => {
      const reads = [];
      const deps = {
        readFile: (filePath) => {
          reads.push(filePath);
          return `stub:${path.basename(String(filePath))}`;
        },
        fileCache: new Map(),
        assetDir: '/fake/bundle',
      };

      for (const route of FRONTEND_ROUTES.keys()) await handler(albEvent(route), {}, deps);
      const afterFirstPass = reads.length;

      for (let pass = 0; pass < 3; pass += 1) {
        for (const route of FRONTEND_ROUTES.keys()) {
          const response = await handler(albEvent(route), {}, deps);
          assert.equal(response.statusCode, 200, route);
          assert.equal(response.body, `stub:${FRONTEND_ROUTES.get(route)}`, route);
        }
      }
      assert.equal(reads.length, afterFirstPass, 'a warm cache read the disk again');
    });
  });

  describe('Scenario: A static path cannot shadow an API route', () => {
    it('Given the API paths, When they are requested, Then the API answers - not the static router', async () => {
      for (const apiPath of [
        '/calendar/api/auth/me',
        '/calendar/api/settings',
        '/calendar/api/events',
        '/calendar/api/events/upcoming',
      ]) {
        const response = await handler(albEvent(apiPath), {}, {});
        assert.equal(response.statusCode, 401, apiPath);
        assert.equal(headerOf(response, 'Content-Type'), 'application/json', apiPath);
        assert.equal(/<!DOCTYPE html>/.test(response.body), false, `${apiPath} was served the page`);
      }
    });
  });

  describe('Scenario: Secrets are never served to the browser', () => {
    /** The bodies the Lambda actually hands out, not the files on disk. */
    let servedBodies;

    before(async () => {
      servedBodies = [];
      for (const [route, filename] of FRONTEND_ROUTES) {
        const response = await handler(albEvent(route), {}, {});
        assert.equal(response.statusCode, 200, route);
        servedBodies.push({ route, filename, body: response.body });
      }
    });

    it('Then none of the served bodies contains an API key, client secret or token', () => {
      const patterns = [
        [/AIza[0-9A-Za-z_-]{10,}/, 'a Google API key'],
        [/GOCSPX-[0-9A-Za-z_-]{5,}/, 'a Google client secret'],
        [/\bya29\.[0-9A-Za-z_-]{10,}/, 'a Google access token'],
        [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
        [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
        [/client[_-]?secret/i, 'a client secret'],
        [/\bapi[_-]?key\b/i, 'an api key'],
        [/\baccess[_-]?token\b/i, 'an access token'],
        [/\brefresh[_-]?token\b/i, 'a refresh token'],
        [/\beyJ[0-9A-Za-z_-]{10,}\./, 'a JWT'],
        [/\bSESSION_SECRET\b/, 'the session secret'],
      ];
      for (const { route, body } of servedBodies) {
        for (const [pattern, what] of patterns) {
          assert.equal(pattern.test(body), false, `${route} served ${what}`);
        }
      }
    });

    it('And none of them reaches the DOM through innerHTML', () => {
      for (const { route, body } of servedBodies) {
        assert.equal(/\.innerHTML/.test(body), false, `${route} uses innerHTML`);
        assert.equal(/insertAdjacentHTML/.test(body), false, `${route} uses insertAdjacentHTML`);
        assert.equal(/document\.write/.test(body), false, `${route} uses document.write`);
      }
    });

    it('And none of them loads anything from another origin', () => {
      for (const { route, body } of servedBodies) {
        assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(body), false, `${route} references an external URL`);
      }
    });
  });
});

/* =========================================================================
 * Feature: Calendar web interface - the connection states
 * ========================================================================= */

describe('Feature: Calendar web interface - connection state', () => {
  it('the fixtures are anchored where the ticket says they are', () => {
    assert.equal(VIEW_YEAR, 2026);
    assert.equal(VIEW_MONTH, 8, 'the scenarios below are written for September 2026');
  });

  describe('Scenario: A new visitor is asked to connect Gmail', () => {
    it('Given no session cookie, When the calendar page is opened, Then a "Connect your Gmail account" action is shown', async () => {
      const world = makeWorld({ meStatus: 401 });
      const { doc, timers, controller } = openCalendar(world);

      const outcome = await controller.start();

      assert.equal(outcome.started, false);
      const action = doc.getElementById('connect-gmail');
      assert.notEqual(action, null, 'no connect action was rendered');
      assert.equal(textOf(action), 'Connect your Gmail account');
      assert.equal(doc.getElementById('app-body').hidden, true, 'the app body is shown to a signed-out visitor');
      assert.deepEqual(timers.started, [], 'a signed-out page must not start polling');
    });

    it('And it points at "/calendar/api/auth/google/start"', async () => {
      const world = makeWorld({ meStatus: 401 });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(doc.getElementById('connect-gmail').getAttribute('href'), '/calendar/api/auth/google/start');
    });

    it('And the page stops there rather than fetching events it cannot have', async () => {
      const world = makeWorld({ meStatus: 401 });
      const { controller } = openCalendar(world);
      await controller.start();
      assert.deepEqual(world.calls.map((call) => call.path), ['/calendar/api/auth/me']);
    });
  });

  describe('Scenario: A connected user without a school is prompted to set one', () => {
    it('Given an authenticated user with no schoolName, When the page is opened, Then a school setup prompt is shown', async () => {
      const world = makeWorld();
      world.me = { connectionStatus: 'connected', email: 'parent@example.test', schoolName: '' };
      const { doc, controller } = openCalendar(world);

      await controller.start();

      const prompt = doc.getElementById('school-setup');
      assert.notEqual(prompt, null, 'no school setup prompt was rendered');
      assert.match(textOf(prompt), /Tell us your school/);
      assert.equal(doc.getElementById('school-setup-link').getAttribute('href'), '/calendar/settings');
      assert.equal(doc.getElementById('app-body').hidden, false, 'the calendar is still usable while unconfigured');
    });
  });

  describe('Scenario: A revoked grant is explained rather than shown as an empty month', () => {
    it('Given lastScanStatus is "reauth_required", When the page is opened, Then a reconnect banner is shown', async () => {
      const world = makeWorld();
      world.me = { ...world.me, lastScanStatus: 'reauth_required' };
      const { doc, controller } = openCalendar(world);

      await controller.start();

      const banner = doc.getElementById('reauth-banner');
      assert.notEqual(banner, null, 'a revoked grant produced a silently empty month');
      assert.equal(banner.getAttribute('role'), 'alert');
      assert.match(textOf(banner), /Reconnect Gmail/);
      assert.equal(doc.getElementById('reconnect-gmail').getAttribute('href'), '/calendar/api/auth/google/start');
    });
  });

  describe('Scenario: A stored hostile schoolName renders as literal text', () => {
    it('Given a schoolName of "<img src=x onerror=alert(1)>", Then it appears as text and creates no element', async () => {
      const world = makeWorld();
      world.me = { ...world.me, schoolName: XSS };
      const { doc, controller } = openCalendar(world);

      await controller.start();

      assert.equal(doc.getElementById('school-name').textContent, `Watching mail for ${XSS}`);
      assert.equal(doc.getElementById('identity-school-name').textContent, `Watching mail for ${XSS}`);
      assert.deepEqual(findElements(doc, 'img'), [], 'an IMG element was created from schoolName');
    });
  });
});

/* =========================================================================
 * Feature: The month grid
 * ========================================================================= */

describe('Feature: The month grid', () => {
  describe("Scenario: The month grid shows the month's events", () => {
    let doc;

    beforeEach(async () => {
      const world = makeWorld();
      world.events = [
        { eventId: 'e-04', startsAt: '2026-09-04', allDay: true, title: 'Swimming carnival' },
        { eventId: 'e-18', startsAt: '2026-09-18', allDay: true, title: 'Book week parade' },
      ];
      const opened = openCalendar(world);
      doc = opened.doc;
      await opened.controller.start();
    });

    it('Given events on 2026-09-04 and 2026-09-18, Then the 4th and the 18th each show one event chip', () => {
      assert.equal(chipsIn(cellFor(doc, '2026-09-04')).length, 1);
      assert.equal(textOf(chipsIn(cellFor(doc, '2026-09-04'))[0]), 'Swimming carnival');
      assert.equal(chipsIn(cellFor(doc, '2026-09-18')).length, 1);
      assert.equal(textOf(chipsIn(cellFor(doc, '2026-09-18'))[0]), 'Book week parade');
    });

    it('And the grid renders one cell per day of the displayed month', () => {
      const inMonth = doc.getElementById('calendar-grid').querySelectorAll('.day-cell--in-month');
      assert.equal(inMonth.length, 30, 'September has 30 days');
      assert.deepEqual(
        inMonth.map((cell) => cell.getAttribute('data-date')),
        Array.from({ length: 30 }, (unused, index) => `2026-09-${String(index + 1).padStart(2, '0')}`)
      );
      for (const week of doc.getElementById('calendar-grid').querySelectorAll('.calendar-week')) {
        assert.equal(week.querySelectorAll('.day-cell').length, 7);
      }
    });

    it("And today's cell is highlighted, with a word and not only a colour", () => {
      const today = cellFor(doc, TODAY_KEY);
      assert.notEqual(today, null, `no cell for today (${TODAY_KEY})`);
      assert.match(today.className, /day-cell--today/);
      assert.equal(today.getAttribute('aria-current'), 'date');
      assert.match(textOf(today.querySelector('.day-today-marker')), /Today/);

      const others = doc
        .getElementById('calendar-grid')
        .querySelectorAll('.day-cell')
        .filter((cell) => cell.getAttribute('data-date') !== TODAY_KEY);
      assert.equal(others.some((cell) => /day-cell--today/.test(cell.className)), false, 'more than one cell is "today"');
    });

    it('And the month heading names the month being displayed', () => {
      assert.match(textOf(doc.getElementById('month-heading')), /September\s+2026/);
    });

    it('And the weekday header runs Sunday first', () => {
      assert.deepEqual(
        doc.getElementById('calendar-weekdays').querySelectorAll('.weekday').map((node) => textOf(node)),
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      );
    });
  });

  describe("Scenario: A day's chips are ordered by start time", () => {
    it('Given three events on one day out of order, Then the chips render soonest first', async () => {
      const world = makeWorld();
      world.events = [
        { eventId: 'c', startsAt: localIso(2026, 9, 4, 15, 0), title: 'Pickup' },
        { eventId: 'a', startsAt: '2026-09-04', allDay: true, title: 'Book week' },
        { eventId: 'b', startsAt: localIso(2026, 9, 4, 9, 0), title: 'Assembly' },
      ];
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const cell = cellFor(doc, '2026-09-04');
      assert.deepEqual(
        chipsIn(cell).map((chip) => chip.getAttribute('data-event-id')),
        ['a', 'b', 'c'],
        'the all-day band leads, then the timed chips by start time'
      );
      assert.match(chipsIn(cell)[0].className, /chip--all-day/);
      assert.equal(cell.querySelector('.all-day-band').querySelectorAll('.chip').length, 1);
    });
  });

  describe('Scenario: Navigating months refetches the range', () => {
    it('Given September 2026 is displayed, When the user clicks next month, Then events are refetched for October 2026', async () => {
      const world = makeWorld();
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const before = world.calls.length;
      await doc.getElementById('next-month').dispatch('click');

      const eventCalls = world.calls.slice(before).filter((call) => call.path === '/calendar/api/events');
      assert.equal(eventCalls.length, 1, 'next month did not refetch');
      assert.equal(eventCalls[0].query, '?from=2026-10-01&to=2026-10-31');
      assert.match(textOf(doc.getElementById('month-heading')), /October\s+2026/);
      assert.equal(controller.state.viewMonth, 9);
    });

    it('And clicking previous month walks back to August 2026', async () => {
      const world = makeWorld();
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await doc.getElementById('prev-month').dispatch('click');
      const august = world.calls.filter((call) => call.path === '/calendar/api/events').pop();
      assert.equal(august.query, '?from=2026-08-01&to=2026-08-31');
      assert.match(textOf(doc.getElementById('month-heading')), /August\s+2026/);
    });

    it('And "Today" returns to the current month', async () => {
      const world = makeWorld();
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await doc.getElementById('next-month').dispatch('click');
      await doc.getElementById('next-month').dispatch('click');
      assert.equal(controller.state.viewMonth, 10);

      await doc.getElementById('today').dispatch('click');

      assert.equal(controller.state.viewYear, VIEW_YEAR);
      assert.equal(controller.state.viewMonth, VIEW_MONTH);
      const last = world.calls.filter((call) => call.path === '/calendar/api/events').pop();
      assert.equal(last.query, '?from=2026-09-01&to=2026-09-30');
      assert.notEqual(cellFor(doc, TODAY_KEY), null);
    });

    it('And the December-to-January rollover changes the year rather than producing month 12', async () => {
      const world = makeWorld();
      const { controller } = openCalendar(world);
      await controller.start();
      await controller.goToMonth(2026, 11);
      await controller.nextMonth();
      assert.equal(controller.state.viewYear, 2027);
      assert.equal(controller.state.viewMonth, 0);
      assert.equal(
        world.calls.filter((call) => call.path === '/calendar/api/events').pop().query,
        '?from=2027-01-01&to=2027-01-31'
      );
    });
  });

  describe('Scenario: A busy day reveals its overflow', () => {
    let doc;

    beforeEach(async () => {
      const world = makeWorld();
      world.events = Array.from({ length: 6 }, (unused, index) => ({
        eventId: `e-${index}`,
        startsAt: localIso(2026, 9, 4, 8 + index, 0),
        title: `Event ${index}`,
      }));
      const opened = openCalendar(world, { maxChipsPerDay: 3 });
      doc = opened.doc;
      await opened.controller.start();
    });

    it('Given a day with 6 events and room for 3 chips, Then a "+3 more" control is shown', () => {
      const cell = cellFor(doc, '2026-09-04');
      const more = cell.querySelector('.more-toggle');
      assert.notEqual(more, null, 'a full day offered no overflow control');
      assert.equal(textOf(more), '+3 more');
      assert.equal(more.getAttribute('data-more-for'), '2026-09-04');
      assert.equal(chipsIn(cell).filter((chip) => chip.hidden === true).length, 3);
      assert.equal(chipsIn(cell).filter((chip) => chip.hidden !== true).length, 3);
    });

    it('And activating it reveals the remaining events', async () => {
      const cell = cellFor(doc, '2026-09-04');
      const more = cell.querySelector('.more-toggle');

      await more.dispatch('click');

      assert.equal(chipsIn(cell).filter((chip) => chip.hidden === true).length, 0, 'chips stayed hidden');
      assert.equal(chipsIn(cell).length, 6);
      assert.equal(more.hidden, true, 'the control did not retire once everything was shown');
    });

    it('And a day that fits offers no overflow control at all', () => {
      assert.equal(cellFor(doc, '2026-09-05').querySelector('.more-toggle'), null);
    });
  });
});

/* =========================================================================
 * Feature: The event detail panel
 * ========================================================================= */

describe('Feature: The event detail panel', () => {
  const EVENT = {
    eventId: 'evt-newsletter',
    startsAt: localIso(2026, 9, 4, 9, 0),
    endsAt: localIso(2026, 9, 4, 10, 30),
    title: 'Year 4 swimming carnival',
    location: 'Ashfield Aquatic Centre',
    description: 'Bring a hat, sunscreen and a packed lunch.',
    category: 'excursion',
    sourceSubject: 'Term 3 Newsletter',
    sourceFrom: 'office@ashfield-p.schools.nsw.edu.au',
  };

  describe('Scenario: Opening an event shows its provenance', () => {
    let doc;

    beforeEach(async () => {
      const world = makeWorld({ events: [EVENT] });
      const opened = openCalendar(world);
      doc = opened.doc;
      await opened.controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');
    });

    it('Given an event extracted from "Term 3 Newsletter", When it is clicked, Then the panel shows that subject', () => {
      const panel = doc.getElementById('event-detail');
      assert.equal(panel.hidden, false, 'the detail panel stayed hidden');
      assert.equal(panel.getAttribute('data-event-id'), 'evt-newsletter');
      assert.match(textOf(doc.getElementById('detail-source-subject')), /From the email:\s*Term 3 Newsletter/);
    });

    it('And it shows the time, location, description, category and sender', () => {
      assert.match(textOf(doc.getElementById('detail-when')), /When:\s*\S/);
      assert.match(textOf(doc.getElementById('detail-when')), /4/);
      assert.match(textOf(doc.getElementById('detail-location')), /Ashfield Aquatic Centre/);
      assert.match(textOf(doc.getElementById('detail-description')), /packed lunch/);
      assert.match(textOf(doc.getElementById('detail-category')), /excursion/);
      assert.match(textOf(doc.getElementById('detail-source-from')), /office@ashfield-p\.schools\.nsw\.edu\.au/);
      assert.equal(textOf(doc.getElementById('detail-title')), 'Year 4 swimming carnival');
    });

    it('And a field the extractor never filled reads as "Not recorded" rather than "null"', async () => {
      const world = makeWorld({ events: [{ eventId: 'bare', startsAt: '2026-09-04', allDay: true, title: 'Mufti day' }] });
      const opened = openCalendar(world);
      await opened.controller.start();
      await chipsIn(cellFor(opened.doc, '2026-09-04'))[0].dispatch('click');
      assert.match(textOf(opened.doc.getElementById('detail-location')), /Not recorded/);
      assert.equal(/null|undefined/.test(textOf(opened.doc.getElementById('event-detail'))), false);
    });

    it('And closing it hides the panel again', async () => {
      await doc.getElementById('detail-close').dispatch('click');
      assert.equal(doc.getElementById('event-detail').hidden, true);
      assert.equal(doc.getElementById('event-detail').childNodes.length, 0);
    });
  });

  describe('Scenario: An event needing attention offers working actions', () => {
    const ATTENTION_EVENT = {
      ...EVENT,
      eventId: 'evt-permission',
      needsAttention: true,
      actionRequired: 'Return the signed permission note',
      dueBy: '2026-09-20',
      status: 'pending',
    };

    it('Given an event with needsAttention, Then the panel shows the action required and the deadline', async () => {
      const world = makeWorld({ events: [ATTENTION_EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');

      assert.match(textOf(doc.getElementById('detail-action-required')), /Return the signed permission note/);
      assert.match(textOf(doc.getElementById('detail-deadline')), /20/);
      assert.notEqual(doc.getElementById('detail-acknowledge'), null);
      assert.notEqual(doc.getElementById('detail-dismiss'), null);
    });

    it('And Acknowledge sends the acknowledge request and closes the panel', async () => {
      const world = makeWorld({ events: [ATTENTION_EVENT], attention: [ATTENTION_EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');

      await doc.getElementById('detail-acknowledge').dispatch('click');

      const posted = world.calls.filter((call) => call.method === 'POST');
      assert.equal(posted.length, 1);
      assert.equal(posted[0].path, '/calendar/api/events/evt-permission/acknowledge');
      assert.equal(doc.getElementById('event-detail').hidden, true);
    });

    it('And Dismiss sends the dismiss request', async () => {
      const world = makeWorld({ events: [ATTENTION_EVENT], attention: [ATTENTION_EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');

      await doc.getElementById('detail-dismiss').dispatch('click');

      assert.equal(
        world.calls.filter((call) => call.method === 'POST').pop().path,
        '/calendar/api/events/evt-permission/dismiss'
      );
    });

    it('And an event that needs nothing offers no action buttons', async () => {
      const world = makeWorld({ events: [EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');
      assert.equal(doc.getElementById('detail-acknowledge'), null);
      assert.equal(doc.getElementById('detail-action-required'), null);
    });
  });

  describe('Scenario: Email content cannot inject script', () => {
    const HOSTILE_EVENT = {
      eventId: 'evt-xss',
      startsAt: '2026-09-04',
      allDay: true,
      title: XSS,
      location: '<script>alert(2)</script>',
      description: '<svg onload=alert(3)>',
      sourceSubject: '<iframe src=javascript:alert(4)>',
      sourceFrom: '"><img src=x onerror=alert(5)>',
      category: '<style>body{display:none}</style>',
    };

    it('Given an event titled "<img src=x onerror=alert(1)>", Then the title appears as literal text', async () => {
      const world = makeWorld({ events: [HOSTILE_EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const chip = chipsIn(cellFor(doc, '2026-09-04'))[0];
      assert.equal(textOf(chip), XSS, 'the payload was not rendered verbatim as text');

      await chip.dispatch('click');
      assert.equal(doc.getElementById('detail-title').textContent, XSS);
      assert.match(textOf(doc.getElementById('detail-location')), /<script>alert\(2\)<\/script>/);
    });

    it('And no script executes, because no element was created from the payload', async () => {
      const world = makeWorld({ events: [HOSTILE_EVENT] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await chipsIn(cellFor(doc, '2026-09-04'))[0].dispatch('click');

      for (const tag of ['img', 'svg', 'iframe', 'style', 'object', 'embed']) {
        assert.deepEqual(findElements(doc, tag), [], `an ${tag.toUpperCase()} element was created from the payload`);
      }
      // The only SCRIPT in the document is the page's own module tag.
      const scripts = findElements(doc, 'script');
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].getAttribute('src'), '/calendar/app.js');
    });
  });
});

/* =========================================================================
 * Feature: The "Needs attention" panel
 * ========================================================================= */

describe('Feature: The "Needs attention" panel', () => {
  const pending = (id, dueBy, title) => ({
    eventId: id,
    title,
    startsAt: '2026-09-25',
    allDay: true,
    needsAttention: true,
    status: 'pending',
    actionRequired: `Do the thing for ${title}`,
    dueBy,
  });

  const rowFor = (doc, id) => doc.getElementById('attention-list').querySelector(`[data-event-id="${id}"]`);

  describe('Scenario: The panel lists upcoming items soonest first', () => {
    it('Given three items out of order, When the panel renders, Then the soonest deadline is first', async () => {
      const world = makeWorld({
        attention: [
          pending('c', '2026-09-30T00:00:00.000Z', 'Book club'),
          pending('a', '2026-09-16T00:00:00.000Z', 'Permission note'),
          pending('b', '2026-09-20T00:00:00.000Z', 'Library books'),
        ],
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      assert.deepEqual(
        doc
          .getElementById('attention-list')
          .querySelectorAll('.attention-item')
          .map((row) => row.getAttribute('data-event-id')),
        ['a', 'b', 'c']
      );
    });
  });

  describe('Scenario: Overdue items are legible without colour', () => {
    it('Given an attention event whose deadline has passed, Then the item carries a textual overdue label', async () => {
      const world = makeWorld({
        attention: [
          pending('late', '2026-09-01T00:00:00.000Z', 'Excursion note'),
          pending('soon', '2026-09-30T00:00:00.000Z', 'Book club'),
        ],
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const overdue = rowFor(doc, 'late');
      const badge = overdue.querySelector('.badge');
      assert.equal(textOf(badge), 'Overdue', 'the overdue state is carried by colour alone');
      assert.equal(badge.getAttribute('data-overdue'), 'true');
      assert.match(overdue.className, /attention-item--overdue/);
      assert.match(textOf(overdue), /Was due/);

      const upcoming = rowFor(doc, 'soon');
      assert.equal(textOf(upcoming.querySelector('.badge')), 'Due');
      assert.equal(upcoming.querySelector('.badge').getAttribute('data-overdue'), null);
    });
  });

  describe('Scenario: A parent clears an action item', () => {
    it('Given a pending attention event, When the user clicks Acknowledge, Then the row is removed', async () => {
      const world = makeWorld({
        attention: [
          pending('a', '2026-09-16T00:00:00.000Z', 'Permission note'),
          pending('b', '2026-09-20T00:00:00.000Z', 'Library books'),
        ],
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.notEqual(rowFor(doc, 'a'), null);

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.equal(rowFor(doc, 'a'), null, 'the row was not removed optimistically');
      assert.notEqual(rowFor(doc, 'b'), null, 'the wrong row was removed');
    });

    it('And a request is sent to the acknowledge route', async () => {
      const world = makeWorld({ attention: [pending('a', '2026-09-16T00:00:00.000Z', 'Permission note')] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      const posted = world.calls.filter((call) => call.method === 'POST');
      assert.equal(posted.length, 1);
      assert.equal(posted[0].path, '/calendar/api/events/a/acknowledge');
      assert.equal(posted[0].init.credentials, 'same-origin');
    });

    it('And the empty state appears once the last item is cleared', async () => {
      const world = makeWorld({ attention: [pending('a', '2026-09-16T00:00:00.000Z', 'Permission note')] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(doc.getElementById('attention-empty').hidden, true);

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.equal(doc.getElementById('attention-empty').hidden, false);
    });

    it('And Dismiss clears the row through the dismiss route', async () => {
      const world = makeWorld({ attention: [pending('a', '2026-09-16T00:00:00.000Z', 'Permission note')] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await rowFor(doc, 'a').querySelector('[data-action="dismiss"]').dispatch('click');

      assert.equal(rowFor(doc, 'a'), null);
      assert.equal(world.calls.filter((call) => call.method === 'POST').pop().path, '/calendar/api/events/a/dismiss');
    });
  });

  describe('Scenario: A failed acknowledge restores the row', () => {
    it('Given the acknowledge request will fail, When the user clicks Acknowledge, Then the row reappears', async () => {
      const world = makeWorld({
        attention: [
          pending('a', '2026-09-16T00:00:00.000Z', 'Permission note'),
          pending('b', '2026-09-20T00:00:00.000Z', 'Library books'),
          pending('c', '2026-09-24T00:00:00.000Z', 'Book club'),
        ],
        mutationStatus: 500,
        mutationBody: { error: 'Could not update the event' },
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await rowFor(doc, 'b').querySelector('[data-action="acknowledge"]').dispatch('click');

      assert.notEqual(rowFor(doc, 'b'), null, 'the row did not come back');
      assert.deepEqual(
        doc
          .getElementById('attention-list')
          .querySelectorAll('.attention-item')
          .map((row) => row.getAttribute('data-event-id')),
        ['a', 'b', 'c'],
        'the row came back in the wrong place'
      );
      assert.equal(controller.state.attention.length, 3);
    });

    it('And the panel says so, rather than swallowing the failure', async () => {
      const world = makeWorld({
        attention: [pending('a', '2026-09-16T00:00:00.000Z', 'Permission note')],
        mutationStatus: 500,
        mutationBody: { error: 'nope' },
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await rowFor(doc, 'a').querySelector('[data-action="acknowledge"]').dispatch('click');

      const message = doc.getElementById('attention-message');
      assert.equal(message.hidden, false);
      assert.equal(textOf(message), app.RESTORE_MESSAGE);
      assert.match(message.className, /notice--problem/);
    });

    it('And a hostile title in the attention panel is still only text', async () => {
      const world = makeWorld({ attention: [pending('a', '2026-09-16T00:00:00.000Z', XSS)] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(textOf(rowFor(doc, 'a').querySelector('.attention-title')), XSS);
      assert.deepEqual(findElements(doc, 'img'), []);
    });
  });

  describe('Scenario: An empty attention list reads as success, not as an error', () => {
    it('Given nothing needs attention, Then a success-toned empty state is shown', async () => {
      const world = makeWorld({ attention: [] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const empty = doc.getElementById('attention-empty');
      assert.equal(empty.hidden, false);
      assert.match(empty.className, /empty-state--success/);
      assert.match(textOf(empty), /caught up/i);
      assert.equal(/error|failed|problem|sorry|could not/i.test(textOf(empty)), false, 'the empty state reads as a failure');
      assert.equal(doc.getElementById('attention-message').hidden, true);
    });
  });
});

/* =========================================================================
 * Feature: Scan now
 * ========================================================================= */

describe('Feature: Scan now', () => {
  describe('Scenario: Scanning shows progress and refreshes', () => {
    it('Given an authenticated configured user, When "Scan now" is clicked, Then the button is disabled while in flight', async () => {
      const world = makeWorld();
      const seen = [];
      const { doc, controller } = openCalendar(world);
      world.onRequest = (call) => {
        if (call.path === '/calendar/api/scan') {
          const button = doc.getElementById('scan-now');
          seen.push({ disabled: button.disabled, label: textOf(button) });
        }
      };
      await controller.start();

      const before = doc.getElementById('scan-now').disabled;
      await doc.getElementById('scan-now').dispatch('click');

      assert.equal(before, false, 'the button started disabled');
      assert.deepEqual(seen, [{ disabled: true, label: 'Scanning...' }], 'the button was live during the request');
      assert.equal(doc.getElementById('scan-now').disabled, false, 'the button was not re-enabled');
      assert.equal(textOf(doc.getElementById('scan-now')), 'Scan now');
    });

    it('And both the calendar and the attention panel refresh on completion', async () => {
      const world = makeWorld();
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const before = world.calls.length;
      await doc.getElementById('scan-now').dispatch('click');

      const after = world.calls.slice(before).map((call) => call.path);
      assert.deepEqual(after, ['/calendar/api/scan', '/calendar/api/events', '/calendar/api/events/upcoming']);
      assert.match(textOf(doc.getElementById('scan-message')), /Scanned 12 messages and found 3 events\./);
    });

    it('And a second click while the first is in flight is refused rather than doubled', async () => {
      const world = makeWorld();
      const { controller } = openCalendar(world);
      await controller.start();
      const before = world.calls.length;

      const [first, second] = await Promise.all([controller.runScanNow(), controller.runScanNow()]);

      assert.equal(first.ok, true);
      assert.equal(second.reason, 'already-in-flight');
      assert.equal(world.calls.slice(before).filter((call) => call.path === '/calendar/api/scan').length, 1);
    });
  });

  describe('Scenario: A concurrent scan is explained', () => {
    it('Given the scan endpoint returns 409, When "Scan now" is clicked, Then a message says a scan is already running', async () => {
      const world = makeWorld({ scanStatus: 409, scanBody: { error: 'A scan is already running' } });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const before = world.calls.length;
      await doc.getElementById('scan-now').dispatch('click');

      const message = doc.getElementById('scan-message');
      assert.equal(message.hidden, false);
      assert.match(textOf(message), /a scan is already running/);
      assert.match(message.className, /notice--problem/);
      assert.deepEqual(
        world.calls.slice(before).map((call) => call.path),
        ['/calendar/api/scan'],
        'a refused scan must not trigger a refresh'
      );
      assert.equal(doc.getElementById('scan-now').disabled, false);
    });
  });

  describe('Scenario: A capped scan tells the user mail remains', () => {
    it('Given the scan result has truncated true, When the result is rendered, Then the user is told mail remains', async () => {
      const world = makeWorld({
        scanBody: { status: 'ok', messagesScanned: 500, eventsCreated: 21, truncated: true },
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      await doc.getElementById('scan-now').dispatch('click');

      const message = textOf(doc.getElementById('scan-message'));
      assert.match(message, /more mail remains unscanned/i);
      assert.match(message, /Scanned 500 messages/);
      assert.match(doc.getElementById('scan-message').className, /notice--problem/);
    });

    it('And a complete scan does not claim mail remains', async () => {
      const world = makeWorld();
      const { doc, controller } = openCalendar(world);
      await controller.start();
      await doc.getElementById('scan-now').dispatch('click');
      assert.equal(/more mail remains/i.test(textOf(doc.getElementById('scan-message'))), false);
    });
  });
});

/* =========================================================================
 * Feature: Empty months, credentials and session expiry
 * ========================================================================= */

describe('Feature: Empty months, credentials and session expiry', () => {
  describe('Scenario: An empty month reads as success, not as an error', () => {
    it('Given no events this month, Then a success-toned empty state is shown', async () => {
      const world = makeWorld({ events: [] });
      const { doc, controller } = openCalendar(world);
      await controller.start();

      const empty = doc.getElementById('calendar-empty');
      assert.equal(empty.hidden, false);
      assert.match(empty.className, /empty-state--success/);
      assert.match(textOf(empty), /No events this month/);
      assert.equal(/error|failed|problem|sorry|could not/i.test(textOf(empty)), false);
      assert.equal(doc.getElementById('calendar-truncated').hidden, true);
    });

    it('And it disappears as soon as the month has an event', async () => {
      const world = makeWorld({ events: [{ eventId: 'e', startsAt: '2026-09-04', allDay: true, title: 'Assembly' }] });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      assert.equal(doc.getElementById('calendar-empty').hidden, true);
    });

    it('And a truncated range says so as information, not as an error', async () => {
      const world = makeWorld({
        events: [{ eventId: 'e', startsAt: '2026-09-04', allDay: true, title: 'Assembly' }],
        truncated: true,
      });
      const { doc, controller } = openCalendar(world);
      await controller.start();
      const notice = doc.getElementById('calendar-truncated');
      assert.equal(notice.hidden, false);
      assert.match(notice.className, /notice--info/);
      assert.match(textOf(notice), /more events than we can show/i);
    });
  });

  describe('Scenario: Every fetch sends credentials', () => {
    it('Given a whole session of activity, Then every request carried credentials: "same-origin"', async () => {
      const world = makeWorld({
        events: [{ eventId: 'e', startsAt: '2026-09-04', allDay: true, title: 'Assembly' }],
        attention: [
          {
            eventId: 'a',
            title: 'Permission note',
            startsAt: '2026-09-25',
            allDay: true,
            needsAttention: true,
            dueBy: '2026-09-16T00:00:00.000Z',
          },
        ],
      });
      const { doc, controller, timers } = openCalendar(world);

      await controller.start();
      await doc.getElementById('next-month').dispatch('click');
      await doc.getElementById('prev-month').dispatch('click');
      await doc.getElementById('today').dispatch('click');
      await doc.getElementById('scan-now').dispatch('click');
      await doc
        .getElementById('attention-list')
        .querySelector('[data-event-id="a"]')
        .querySelector('[data-action="acknowledge"]')
        .dispatch('click');
      await timers.fire();

      assert.ok(world.calls.length >= 10, `only ${world.calls.length} requests were made`);
      for (const call of world.calls) {
        assert.equal(call.init.credentials, 'same-origin', `${call.method} ${call.url} was sent without credentials`);
      }
    });

    it('And the settings page does the same', async () => {
      const world = makeWorld();
      const { doc, page } = openSettings(world);
      await page.start();
      doc.getElementById('school-name-input').value = 'Ashfield Public School';
      doc.getElementById('search-domains-input').value = 'ashfield-p.schools.nsw.edu.au';
      await page.save();

      assert.ok(world.calls.length >= 3, `only ${world.calls.length} requests were made`);
      for (const call of world.calls) {
        assert.equal(call.init.credentials, 'same-origin', `${call.method} ${call.url} was sent without credentials`);
      }
    });
  });

  describe('Scenario: A session expiring mid-use is handled', () => {
    it('Given an authenticated page whose session then expires, When the next fetch returns 401, Then the connect state is rendered', async () => {
      const world = makeWorld({
        events: [{ eventId: 'e', startsAt: '2026-09-04', allDay: true, title: 'Assembly' }],
      });
      const { doc, controller, timers } = openCalendar(world);
      await controller.start();

      assert.equal(doc.getElementById('app-body').hidden, false);
      assert.equal(timers.started.length, 1, 'polling did not start for a signed-in user');
      assert.equal(doc.getElementById('connect-gmail'), null);

      world.forceStatus = 401;
      await timers.fire();

      assert.notEqual(doc.getElementById('connect-gmail'), null, 'the connect state was not re-rendered');
      assert.equal(doc.getElementById('connect-gmail').getAttribute('href'), '/calendar/api/auth/google/start');
      assert.equal(doc.getElementById('app-body').hidden, true);
      assert.equal(doc.getElementById('event-detail').hidden, true);
      assert.equal(controller.state.events.length, 0);
    });

    it('And no further polling requests are sent, even when a stray timer tick fires', async () => {
      const world = makeWorld();
      const { controller, timers } = openCalendar(world);
      await controller.start();

      world.forceStatus = 401;
      await timers.fire();

      const timerId = timers.started[0].id;
      assert.deepEqual(timers.cleared, [timerId], 'the refresh timer was not stopped');

      const frozen = world.calls.length;
      await timers.fire();
      await timers.fire();
      await controller.refreshAll();
      await controller.loadAttention();

      assert.equal(world.calls.length, frozen, 'the page kept polling a session that is gone');
      assert.equal(controller.api.isHalted(), true);
    });

    it('And it does not shout an error message on top of the connect state', async () => {
      const world = makeWorld();
      const { doc, controller, timers } = openCalendar(world);
      await controller.start();
      world.forceStatus = 401;
      await timers.fire();

      assert.equal(doc.getElementById('attention-message').hidden, true);
      assert.equal(textOf(doc.getElementById('calendar-truncated')), '');
    });
  });

  describe('Scenario: A failing events call is reported without wiping the page', () => {
    it('Given the events call returns 500, Then the user is told - and it is not treated as a sign-out', async () => {
      const world = makeWorld();
      const original = world.fetchImpl;
      world.fetchImpl = async (url, init) => {
        if (String(url).startsWith('/calendar/api/events?')) {
          world.calls.push({ url: String(url), path: '/calendar/api/events', query: '', method: 'GET', init });
          return { status: 500, json: async () => ({ error: 'boom' }) };
        }
        return original(url, init);
      };

      const { doc, controller } = openCalendar(world);
      await controller.start();

      assert.equal(doc.getElementById('calendar-truncated').hidden, false);
      assert.match(textOf(doc.getElementById('calendar-truncated')), /could not load this month/i);
      assert.equal(doc.getElementById('connect-gmail'), null, 'a 500 must not be treated as a sign-out');
    });
  });
});

/* =========================================================================
 * Feature: The settings page
 * ========================================================================= */

describe('Feature: The settings page', () => {
  describe('Scenario: The settings page loads what is stored', () => {
    it('Given a configured account, When the settings page opens, Then the form is filled and revealed', async () => {
      const world = makeWorld();
      const { doc, page } = openSettings(world);

      assert.equal(doc.getElementById('settings-body').hidden, true, 'the settings body must ship hidden');
      await page.start();

      assert.equal(doc.getElementById('settings-body').hidden, false);
      assert.equal(doc.getElementById('school-name-input').value, 'Ashfield Public School');
      assert.equal(doc.getElementById('search-domains-input').value, 'ashfield-p.schools.nsw.edu.au');
      assert.equal(doc.getElementById('timezone-input').value, 'Australia/Sydney');
      assert.equal(doc.getElementById('schedule-hour-input').value, '7');
      assert.equal(doc.getElementById('schedule-enabled-input').checked, false);
      assert.match(textOf(doc.getElementById('settings-summary')), /Watching mail for Ashfield Public School/);
      assert.deepEqual(world.calls.map((call) => `${call.method} ${call.path}`), ['GET /calendar/api/settings']);
    });

    it('And a signed-out visitor gets the connect state instead of an empty form', async () => {
      const world = makeWorld({ forceStatus: 401 });
      const { doc, page } = openSettings(world);
      await page.start();

      assert.notEqual(doc.getElementById('connect-gmail'), null);
      assert.equal(doc.getElementById('settings-body').hidden, true, 'the settings body was revealed without a session');
    });
  });

  describe('Scenario: The settings page saves school name and domains', () => {
    it('When the form is submitted, Then PUT /calendar/api/settings carries what was typed', async () => {
      const world = makeWorld();
      const { doc, page } = openSettings(world);
      await page.start();

      doc.getElementById('school-name-input').value = '  Ashfield Public School  ';
      doc.getElementById('search-domains-input').value = 'ashfield-p.schools.nsw.edu.au\nAshfield-P.SCHOOLS.nsw.edu.au';
      await doc.getElementById('settings-form').dispatch('submit');
      await drain();

      const put = world.calls.find((call) => call.method === 'PUT' && call.path === '/calendar/api/settings');
      assert.notEqual(put, undefined, 'no settings PUT was sent');
      assert.deepEqual(JSON.parse(put.init.body), {
        schoolName: 'Ashfield Public School',
        searchDomains: ['ashfield-p.schools.nsw.edu.au'],
        scheduleEnabled: false,
        scheduleFrequency: 'daily',
        scheduleHour: '7',
        timezone: 'Australia/Sydney',
      });
      assert.equal(put.init.credentials, 'same-origin');
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });

    it('And the native form submit is prevented, so the page does not navigate away', async () => {
      const world = makeWorld();
      const { doc, page } = openSettings(world);
      await page.start();
      const event = await doc.getElementById('settings-form').dispatch('submit');
      await drain();
      assert.equal(event.defaultPrevented, true);
    });
  });

  describe('Scenario: Saving invalid settings shows a field error', () => {
    it('Given the settings page, When the user saves searchDomains "gmail.com", Then a field-level error is shown', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: {
          error: 'gmail.com is a public mail provider, so it cannot be a school domain',
          field: 'searchDomains',
        },
      });
      const { doc, page } = openSettings(world);
      await page.start();

      doc.getElementById('school-name-input').value = 'Ashfield Public School';
      doc.getElementById('search-domains-input').value = 'gmail.com';
      await doc.getElementById('settings-form').dispatch('submit');
      await drain();

      const fieldError = doc.getElementById('error-searchDomains');
      assert.equal(fieldError.hidden, false, 'the field error stayed hidden');
      assert.equal(textOf(fieldError), 'gmail.com is a public mail provider, so it cannot be a school domain');
      assert.match(textOf(doc.getElementById('settings-status')), /Nothing was saved/);
      assert.equal(doc.getElementById('error-schoolName').hidden, true, 'the error landed on the wrong field too');
      assert.equal(
        world.calls.some((call) => call.path === '/calendar/api/scan/schedule'),
        false,
        'a rejected save must not go on to write the schedule'
      );
    });

    it('And a 400 that names no field falls back to the form-level line rather than vanishing', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: 'That request could not be read' },
      });
      const { doc, page } = openSettings(world);
      await page.start();
      const result = await page.save();

      assert.equal(result.ok, false);
      assert.equal(doc.getElementById('error-form').hidden, false);
      assert.equal(textOf(doc.getElementById('error-form')), 'That request could not be read');
    });

    it('And a server-named field that does not exist on the page also falls back, showing something', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: 'nope', field: '__proto__' },
      });
      const { doc, page } = openSettings(world);
      await page.start();
      await page.save();
      assert.equal(doc.getElementById('error-form').hidden, false);
      assert.equal(textOf(doc.getElementById('error-form')), 'nope');
    });

    it('And a field error is cleared before the next save, so it cannot linger', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: 'gmail.com is a public mail provider', field: 'searchDomains' },
      });
      const { doc, page } = openSettings(world);
      await page.start();
      await page.save();
      assert.equal(doc.getElementById('error-searchDomains').hidden, false);

      world.settingsPutStatus = 200;
      world.settingsPutBody = null;
      await page.save();

      assert.equal(doc.getElementById('error-searchDomains').hidden, true, 'a stale field error survived a good save');
      assert.equal(textOf(doc.getElementById('error-searchDomains')), '');
    });
  });

  describe('Scenario: A hostile schoolName renders as literal text on the settings page', () => {
    it('Given a stored schoolName of "<img src=x onerror=alert(1)>", Then it is text in the summary and in the input', async () => {
      const world = makeWorld();
      world.settings = { ...world.settings, schoolName: XSS };
      const { doc, page } = openSettings(world);

      await page.start();

      assert.equal(doc.getElementById('settings-school-name').textContent, XSS);
      assert.equal(doc.getElementById('school-name-input').value, XSS);
      assert.deepEqual(findElements(doc, 'img'), [], 'an IMG element was created from schoolName');
      const scripts = findElements(doc, 'script');
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].getAttribute('src'), '/calendar/settings.js');
    });

    it('And a field error echoing what the user typed is text too', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: `"${XSS}" is not a valid domain`, field: 'searchDomains' },
      });
      const { doc, page } = openSettings(world);
      await page.start();
      await page.save();

      assert.equal(doc.getElementById('error-searchDomains').textContent, `"${XSS}" is not a valid domain`);
      assert.deepEqual(findElements(doc, 'img'), []);
    });
  });

  describe('Scenario: The TASK-013 disconnect control still lives on the same page', () => {
    it('Given the shipped settings page, Then the disconnect section is inside the hidden #settings-body', () => {
      const doc = loadDocument(SETTINGS_HTML);
      assert.equal(doc.getElementById('settings-body').hidden, true);
      assert.notEqual(
        doc.querySelector('#settings-body #disconnect-gmail'),
        null,
        'the disconnect control escaped the gated body'
      );
      assert.equal(doc.getElementById('disconnect-submit').disabled, true);
      assert.equal(doc.getElementById('disconnect-events-keep').checked, true);
      assert.equal(doc.getElementById('disconnect-events-delete').checked, false);
    });

    it('And a signed-out visitor cannot see it, while a signed-in one can', async () => {
      const signedOut = openSettings(makeWorld({ forceStatus: 401 }));
      await signedOut.page.start();
      assert.equal(signedOut.doc.getElementById('settings-body').hidden, true);

      const signedIn = openSettings(makeWorld());
      await signedIn.page.start();
      assert.equal(signedIn.doc.getElementById('settings-body').hidden, false);
    });

    it('And a settings save does not clobber the disconnect status or its submit gate', async () => {
      const world = makeWorld();
      const { doc, page } = openSettings(world);
      await page.start();

      const control = settingsModule.initDisconnectControl({ root: doc, fetchImpl: world.fetchImpl });
      assert.notEqual(control, null);
      doc.getElementById('disconnect-confirm').value = 'DISCONNECT';
      await doc.getElementById('disconnect-confirm').dispatch('input');
      assert.equal(doc.getElementById('disconnect-submit').disabled, false);

      await page.save();

      assert.equal(doc.getElementById('disconnect-submit').disabled, false, 'a settings save reset the disconnect gate');
      assert.equal(textOf(doc.getElementById('disconnect-status')), '');
      assert.equal(doc.getElementById('disconnect-events-keep').checked, true);
    });
  });
});
