/**
 * E2E (cucumber-style) scenarios for TASK-061 - "Choosing the time zone the scan
 * schedule runs in".
 *
 * The ticket's Gherkin, written Given / When / Then and driven through the code
 * that actually ships:
 *
 *   - the page scenarios run the REAL `frontend/settings.js` against the REAL
 *     `frontend/settings.html`, parsed by `tests/helpers/fake-dom.mjs`. The
 *     `<select id="timezone-input">`, its label, its hint and its
 *     `#error-timezone` slot are STATIC markup, so a test that built its own
 *     page would keep passing after the control stopped shipping; parsing the
 *     real page means it does not. Saving is a real `dispatch('submit')`;
 *   - the endpoint scenarios run the REAL Lambda `handler` /
 *     `handlePutSchedule` and the REAL `putScanSchedule`, so "the settings and
 *     schedule endpoints agree" is a statement about both validators, not about
 *     a copy of one of them.
 *
 * NO DATABASE CONNECTION IS OPENED, AND NO HTTP REQUEST IS MADE. Every I/O
 * boundary is injected:
 *   - the page only ever talks to an INJECTED `fetch`; there is no real `fetch`
 *     in scope in any scenario below;
 *   - the settings route gets an INJECTED `updateItem` spy in place of DynamoDB
 *     (a 400 scenario then asserts it was never called);
 *   - the schedule route gets an INJECTED EventBridge Scheduler client and
 *     command set, and an INJECTED `updateConnection`, so the create/update call
 *     and its `ScheduleExpressionTimezone` are assertable without an AWS SDK;
 *   - `Intl` is INJECTED through `createSettingsPage`'s `options.intl` seam
 *     wherever an older browser is being described. The global `Intl` is never
 *     reassigned.
 *
 * The unit tests for the same ticket are in
 * `tests/unit/task-061-timezone-selector.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must precede the index.mjs import: its log level is read once at module load.
process.env.CALENDAR_LOG_LEVEL = 'none';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'src', 'lambda', 'calendar', 'frontend');
const SETTINGS_HTML = path.join(FRONTEND_DIR, 'settings.html');

const { handler, handlePutSchedule } = await import('../../src/lambda/calendar/index.mjs');
const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { putScanSchedule, buildScanCronExpression, validateScheduleInput, isValidTimezone } = await import(
  '../../src/lambda/calendar/backend/scan-schedule.mjs'
);
const { connectionUserId, REMOVE_ATTRIBUTE } = await import('../../src/lambda/calendar/backend/connections.mjs');
const { SESSION_COOKIE_NAME, createSessionToken } = await import('../../src/lambda/calendar/backend/session.mjs');
const { loadDocument, findElements, textOf } = await import('../helpers/fake-dom.mjs');

const SETTINGS_PATH = '/calendar/api/settings';
const SCHEDULE_PATH = '/calendar/api/scan/schedule';
const XSS = '<img src=x onerror=alert(1)>';

/** Let every already-resolved promise chain settle. */
async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* =========================================================================
 * Background: an older browser, and a modern one. Neither touches global Intl.
 * ========================================================================= */

/** A browser whose `Intl` cannot enumerate zones (the fallback path). */
const OLD_BROWSER_INTL = Object.freeze({ DateTimeFormat: () => ({}) });

/** A browser whose zone list is exactly `zones`. */
const browserListing = (zones) => ({ supportedValuesOf: () => [...zones] });

/* =========================================================================
 * The world: an injected fetch that answers the two API routes, and nothing else
 * ========================================================================= */

function makeWorld(overrides = {}) {
  const world = {
    calls: [],
    storedTimezone: 'Australia/Sydney',
    scheduleEnabled: false,
    settingsPutStatus: 200,
    settingsPutBody: null,
    scheduleStatus: 200,
    scheduleBody: { available: true },
    ...overrides,
  };

  world.settingsBody = () => {
    const body = {
      connectionStatus: 'connected',
      email: 'parent@example.test',
      processingJobs: [
        { id: 'job-1', name: 'Ashfield', schoolName: 'Ashfield Public School', domains: ['ashfield.nsw.edu.au'], searchTerms: [] },
      ],
      scheduleEnabled: world.scheduleEnabled,
      scheduleFrequency: 'daily',
      scheduleHour: 7,
    };
    // `undefined` is "my stored settings have no timezone", which is not the
    // same thing as a stored blank.
    if (world.storedTimezone !== undefined) body.timezone = world.storedTimezone;
    return body;
  };

  const reply = (status, body) => ({ status, json: async () => structuredClone(body ?? {}) });

  world.fetchImpl = async (url, init = {}) => {
    const requestPath = String(url).split('?')[0];
    const method = init.method || 'GET';
    world.calls.push({ path: requestPath, method, body: init.body ? JSON.parse(init.body) : null });

    if (requestPath === SETTINGS_PATH) {
      if (method === 'PUT') return reply(world.settingsPutStatus, world.settingsPutBody ?? world.settingsBody());
      return reply(200, world.settingsBody());
    }
    if (requestPath === SCHEDULE_PATH) return reply(world.scheduleStatus, world.scheduleBody);
    throw new Error(`the page requested a route the world does not know: ${method} ${requestPath}`);
  };

  world.bodyOf = (method, requestPath) =>
    world.calls.filter((call) => call.method === method && call.path === requestPath).map((call) => call.body).pop();

  return world;
}

/** Given I am signed in and on the settings page. */
async function givenTheSettingsPageHasLoaded(world, options = {}) {
  const doc = loadDocument(SETTINGS_HTML);
  const page = settings.createSettingsPage({
    document: doc,
    fetchImpl: world.fetchImpl,
    detectTimezone: () => 'Australia/Sydney',
    ...options,
  });
  await page.start();
  await drain();
  return { doc, page, select: doc.getElementById('timezone-input') };
}

const optionsOf = (select) => select.childNodes.filter((node) => node.nodeType === 1);
const valuesOf = (select) => optionsOf(select).map((option) => option.value);

/** When I press "Save settings". */
async function whenISaveTheForm(doc) {
  await doc.getElementById('settings-form').dispatch('submit');
  await drain();
}

/* =========================================================================
 * The backend world: a session, an injected DynamoDB and an injected Scheduler
 * ========================================================================= */

const SESSION_SECRET = 'test-session-secret-must-be-32-bytes-long!!';
const GOOGLE_SUB = 'test-user-google-sub-123';

const BACKEND_ENV = Object.freeze({
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-xyz',
  SESSION_SECRET,
  PUBLIC_BASE_URL: 'https://example.com',
  CALENDAR_CONNECTIONS_TABLE: 'test-connections-table',
  CALENDAR_KMS_KEY_ID: 'arn:aws:kms:ap-southeast-2:123456789:key/12345678-1234-1234-1234-123456789012',
  CALENDAR_LOG_LEVEL: 'none',
});

/** An environment in which automatic scanning IS provisioned. */
const SCHEDULE_ENV = Object.freeze({
  ...BACKEND_ENV,
  SCAN_SCHEDULE_PREFIX: 'au-dev-receptionhq-calendar-scan',
  SCAN_SCHEDULE_GROUP: 'default',
  SCAN_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
  CALENDAR_FUNCTION_ARN: 'arn:aws:lambda:ap-southeast-2:123456789012:function:calendar',
});

const sessionCookie = () =>
  `${SESSION_COOKIE_NAME}=${createSessionToken({ sub: GOOGLE_SUB, email: 'parent@example.test' }, { secret: SESSION_SECRET })}`;

function makeEvent(method, requestPath, body = null) {
  return {
    version: '2.0',
    rawPath: requestPath,
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
    cookies: [sessionCookie()],
    requestContext: { domainName: 'abc123.lambda-url.ap-southeast-2.on.aws', http: { method, path: requestPath } },
    body: body === null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** DynamoDB stand-in: records the write and echoes the row back. NO DB. */
function makeUpdateItem() {
  const writes = [];
  const updateItem = async ({ tableName, key, updates }) => {
    writes.push({ tableName, key, updates });
    const row = { userId: connectionUserId(GOOGLE_SUB), email: 'parent@example.test' };
    for (const [attribute, value] of Object.entries(updates || {})) {
      if (value === REMOVE_ATTRIBUTE) delete row[attribute];
      else row[attribute] = value;
    }
    return row;
  };
  return { updateItem, writes };
}

/** EventBridge Scheduler stand-in: records every command it is sent. NO AWS. */
function makeScheduler({ exists = false } = {}) {
  const sent = [];
  const make = (name) =>
    class {
      constructor(input) {
        this.commandName = name;
        this.input = input;
      }
    };
  const commands = {
    GetScheduleCommand: make('GetSchedule'),
    CreateScheduleCommand: make('CreateSchedule'),
    UpdateScheduleCommand: make('UpdateSchedule'),
    DeleteScheduleCommand: make('DeleteSchedule'),
  };
  const client = {
    send: async (command) => {
      sent.push(command);
      if (command.commandName === 'GetSchedule' && !exists) {
        const err = new Error('No schedule with that name');
        err.name = 'ResourceNotFoundException';
        throw err;
      }
      return {};
    },
  };
  const patches = [];
  const updateConnection = async (userId, patch) => {
    patches.push({ userId, patch });
    return patch;
  };
  const inputFor = (name) => sent.find((command) => command.commandName === name)?.input;
  return { client, commands, sent, patches, updateConnection, inputFor };
}

/** PUT /calendar/api/scan/schedule through the REAL route and REAL validator. */
async function putScheduleThroughTheRoute(body, { env = SCHEDULE_ENV, scheduler = makeScheduler() } = {}) {
  const response = await handlePutSchedule(makeEvent('PUT', SCHEDULE_PATH, body), {
    env,
    putScanSchedule: (userId, payload, deps = {}) =>
      putScanSchedule(userId, payload, {
        ...deps,
        env,
        client: scheduler.client,
        commands: scheduler.commands,
        updateConnection: scheduler.updateConnection,
      }),
  });
  return { response, body: JSON.parse(response.body), scheduler };
}

/* =========================================================================
 * Feature: Choosing the time zone the scan schedule runs in
 * ========================================================================= */

describe('Feature: Choosing the time zone the scan schedule runs in', () => {
  describe('Scenario: The time zone field is a selector, not a text box', () => {
    it('When the settings page loads, Then the "Time zone" control is a <select id="timezone-input">', async () => {
      const { doc, select } = await givenTheSettingsPageHasLoaded(makeWorld());

      assert.notEqual(select, null, 'there is no #timezone-input on the page');
      assert.equal(select.tagName, 'SELECT');
      assert.equal(select.className, 'field-input');
      assert.equal(
        findElements(doc, 'input').some((node) => node.getAttribute('id') === 'timezone-input'),
        false,
        'the free-text box is still shipping'
      );
    });

    it('And it is labelled by the "Time zone" label', async () => {
      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld());
      const label = doc.querySelector('label[for="timezone-input"]');
      assert.notEqual(label, null);
      assert.equal(textOf(label), 'Time zone');
    });

    it('And a hint tells me the scan runs at my chosen hour in that time zone', async () => {
      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld());
      const hint = findElements(doc, 'p')
        .filter((node) => node.className === 'field-hint')
        .find((node) => /time zone/i.test(textOf(node)) && /hour/i.test(textOf(node)));
      assert.notEqual(hint, undefined, 'nothing connects the hour field to the time zone field');
      assert.match(textOf(hint), /scan runs at the hour above, read in this time zone/i);
    });

    it('And the option list is the browser\'s own IANA list, with no search widget beside it', async () => {
      const { doc, select } = await givenTheSettingsPageHasLoaded(makeWorld(), {
        intl: browserListing(['Australia/Sydney', 'Australia/Perth', 'Europe/London', 'UTC']),
      });
      assert.deepEqual(valuesOf(select), ['Australia/Perth', 'Australia/Sydney', 'Europe/London', 'UTC']);
      assert.deepEqual(optionsOf(select).map((option) => option.textContent), valuesOf(select));
      // A plain native select and nothing else: no companion text box, no listbox.
      assert.equal(doc.getElementById('timezone-search'), null);
      assert.deepEqual(findElements(doc, 'datalist'), []);
    });
  });

  describe('Scenario: My saved time zone is the one selected', () => {
    it('Given a stored timezone of "Australia/Perth", When the page loads, Then it is the selected option', async () => {
      const world = makeWorld({ storedTimezone: 'Australia/Perth' });
      const { select } = await givenTheSettingsPageHasLoaded(world, {
        intl: browserListing(['Australia/Perth', 'Australia/Sydney', 'UTC']),
      });

      assert.equal(select.value, 'Australia/Perth');
      assert.ok(valuesOf(select).includes('Australia/Perth'));
    });
  });

  describe('Scenario: A first-time user gets their browser\'s zone', () => {
    it('Given no stored timezone and a browser zone of "Australia/Sydney", Then that is selected', async () => {
      const world = makeWorld({ storedTimezone: undefined });
      const { select } = await givenTheSettingsPageHasLoaded(world, {
        detectTimezone: () => 'Australia/Sydney',
        intl: browserListing(['Australia/Perth', 'Australia/Sydney', 'UTC']),
      });

      assert.equal(select.value, 'Australia/Sydney');
    });
  });

  describe('Scenario: Saving sends the chosen zone to both endpoints', () => {
    it('Given scanning is on at hour 7, When I choose "Australia/Brisbane" and save, Then both bodies carry it', async () => {
      const world = makeWorld({ scheduleEnabled: true });
      const { doc, select } = await givenTheSettingsPageHasLoaded(world, {
        intl: browserListing(['Australia/Brisbane', 'Australia/Sydney', 'UTC']),
      });

      assert.equal(doc.getElementById('schedule-enabled-input').checked, true, 'the background is wrong');
      assert.equal(doc.getElementById('schedule-hour-input').value, '7');

      select.value = 'Australia/Brisbane';
      await whenISaveTheForm(doc);

      assert.equal(world.bodyOf('PUT', SETTINGS_PATH).timezone, 'Australia/Brisbane');
      assert.equal(world.bodyOf('PUT', SCHEDULE_PATH).timezone, 'Australia/Brisbane');
      assert.equal(world.bodyOf('PUT', SCHEDULE_PATH).hour, '7');
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });

    it('And the schedule is created with a ScheduleExpressionTimezone of "Australia/Brisbane", and a cron with no zone', async () => {
      const world = makeWorld({ scheduleEnabled: true });
      const { doc, select } = await givenTheSettingsPageHasLoaded(world, {
        intl: browserListing(['Australia/Brisbane', 'UTC']),
      });
      select.value = 'Australia/Brisbane';
      await whenISaveTheForm(doc);

      // The very body the page sent, carried on into the REAL schedule route.
      const sentByThePage = world.bodyOf('PUT', SCHEDULE_PATH);
      const { response, scheduler } = await putScheduleThroughTheRoute(sentByThePage);
      assert.equal(response.statusCode, 200);

      const input = scheduler.inputFor('CreateSchedule');
      assert.notEqual(input, undefined, 'no schedule was created');
      assert.equal(input.ScheduleExpressionTimezone, 'Australia/Brisbane');
      assert.equal(input.ScheduleExpression, 'cron(0 7 * * ? *)');
      assert.equal(/Brisbane|GMT|UTC|[+-]\d\d:?\d\d/.test(input.ScheduleExpression), false, 'the cron carries a zone of its own');
    });
  });

  describe('Scenario: The chosen zone is what the job actually fires in', () => {
    it('Given a daily scan at hour 7 in "Australia/Brisbane", Then the expression is "cron(0 7 * * ? *)" and the zone is separate', async () => {
      const { response, body, scheduler } = await putScheduleThroughTheRoute({
        frequency: 'daily',
        hour: 7,
        timezone: 'Australia/Brisbane',
      });

      assert.equal(response.statusCode, 200);
      assert.equal(body.timezone, 'Australia/Brisbane');
      assert.equal(scheduler.inputFor('CreateSchedule').ScheduleExpression, 'cron(0 7 * * ? *)');
      assert.equal(scheduler.inputFor('CreateSchedule').ScheduleExpressionTimezone, 'Australia/Brisbane');
    });

    it('And no conversion of the hour to UTC has been performed at save time', async () => {
      const { scheduler } = await putScheduleThroughTheRoute({ frequency: 'daily', hour: 7, timezone: 'Australia/Brisbane' });

      // Brisbane is UTC+10: a save-time conversion would have written 21 (the
      // previous day) into the cron and/or 21 onto the row.
      assert.equal(scheduler.inputFor('CreateSchedule').ScheduleExpression.includes(' 21 '), false);
      assert.equal(scheduler.patches.length, 1, 'the row was not patched exactly once');
      assert.equal(scheduler.patches[0].patch.scheduleHour, 7);
      assert.equal(scheduler.patches[0].patch.timezone, 'Australia/Brisbane');
    });

    it('And the cron builder carries no zone for any hour or frequency', () => {
      for (const args of [
        { frequency: 'daily', hour: 0, dayOfWeek: null },
        { frequency: 'daily', hour: 23, dayOfWeek: null },
        { frequency: 'weekly', hour: 7, dayOfWeek: 3 },
      ]) {
        const cron = buildScanCronExpression(args);
        assert.equal(/Australia|UTC|GMT|[+-]\d\d:?\d\d/.test(cron), false, `${cron} carries a zone`);
      }
    });
  });

  /* ------------------------------------------------------------------
   * Edge and failure cases
   * ------------------------------------------------------------------ */

  describe('Scenario: A stored zone that is not in the list is still preserved', () => {
    it('Given a stored "Pacific/Chatham" the browser does not list, When the page loads, Then it is still selected', async () => {
      const world = makeWorld({ storedTimezone: 'Pacific/Chatham' });
      const { select } = await givenTheSettingsPageHasLoaded(world, { intl: OLD_BROWSER_INTL });

      assert.equal(
        settings.supportedTimezones(OLD_BROWSER_INTL).includes('Pacific/Chatham'),
        false,
        'the premise is wrong: this browser does list Chatham'
      );
      assert.equal(select.value, 'Pacific/Chatham');
      assert.ok(valuesOf(select).includes('Pacific/Chatham'), 'the zone was dropped from the options');
      assert.notEqual(valuesOf(select)[0], 'Pacific/Chatham', 'it only matches because it is first');
    });

    it('And pressing "Save settings" without touching the field sends "Pacific/Chatham" unchanged', async () => {
      const world = makeWorld({ storedTimezone: 'Pacific/Chatham', scheduleEnabled: true });
      const { doc } = await givenTheSettingsPageHasLoaded(world, { intl: OLD_BROWSER_INTL });

      await whenISaveTheForm(doc);

      assert.equal(world.bodyOf('PUT', SETTINGS_PATH).timezone, 'Pacific/Chatham');
      assert.equal(world.bodyOf('PUT', SCHEDULE_PATH).timezone, 'Pacific/Chatham');
    });
  });

  describe('Scenario: A plausible-looking but fake zone is refused by the settings endpoint', () => {
    it('When a client sends a timezone of "Mars/Olympus_Mons", Then 400, field "timezone", and nothing is written', async () => {
      const db = makeUpdateItem();
      const response = await handler(
        makeEvent('PUT', SETTINGS_PATH, {
          processingJobs: [{ name: 'Ashfield', schoolName: 'Ashfield Public School', domains: ['ashfield.nsw.edu.au'], searchTerms: [] }],
          timezone: 'Mars/Olympus_Mons',
        }),
        {},
        { env: BACKEND_ENV, updateItem: db.updateItem }
      );

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'timezone');
      assert.equal(body.error, '"Mars/Olympus_Mons" is not a valid time zone');
      assert.deepEqual(db.writes, [], 'the connection row was written despite the 400');
    });

    it('And the echoed value is length-capped, so a huge one cannot be reflected whole', async () => {
      const db = makeUpdateItem();
      const response = await handler(
        makeEvent('PUT', SETTINGS_PATH, {
          processingJobs: [{ name: 'Ashfield', schoolName: 'Ashfield Public School', domains: [], searchTerms: [] }],
          timezone: `Mars/${'x'.repeat(500)}`,
        }),
        {},
        { env: BACKEND_ENV, updateItem: db.updateItem }
      );

      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.equal(body.field, 'timezone');
      assert.ok(body.error.length < 120, `the message echoed ${body.error.length} characters`);
      assert.deepEqual(db.writes, []);
    });

    it('But a real zone in the same request is accepted and written', async () => {
      const db = makeUpdateItem();
      const response = await handler(
        makeEvent('PUT', SETTINGS_PATH, {
          processingJobs: [{ name: 'Ashfield', schoolName: 'Ashfield Public School', domains: [], searchTerms: [] }],
          timezone: 'Australia/Brisbane',
        }),
        {},
        { env: BACKEND_ENV, updateItem: db.updateItem }
      );

      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body).timezone, 'Australia/Brisbane');
      assert.equal(db.writes.length, 1);
      assert.equal(db.writes[0].updates.timezone, 'Australia/Brisbane');
    });
  });

  describe('Scenario: The settings and schedule endpoints agree on what is valid', () => {
    it('When "Foo/Bar" is sent to each endpoint, Then both answer 400 naming the field "timezone"', async () => {
      const db = makeUpdateItem();
      const fromSettings = await handler(
        makeEvent('PUT', SETTINGS_PATH, {
          processingJobs: [{ name: 'Ashfield', schoolName: 'Ashfield Public School', domains: [], searchTerms: [] }],
          timezone: 'Foo/Bar',
        }),
        {},
        { env: BACKEND_ENV, updateItem: db.updateItem }
      );
      const fromSchedule = await putScheduleThroughTheRoute({ frequency: 'daily', hour: 7, timezone: 'Foo/Bar' });

      assert.equal(fromSettings.statusCode, 400);
      assert.equal(JSON.parse(fromSettings.body).field, 'timezone');
      assert.equal(fromSchedule.response.statusCode, 400);
      assert.equal(fromSchedule.body.field, 'timezone');
      // Same sentence from both, so the page shows one message wherever it came from.
      assert.equal(JSON.parse(fromSettings.body).error, fromSchedule.body.error);
      assert.deepEqual(db.writes, []);
      assert.deepEqual(fromSchedule.scheduler.sent, [], 'a rejected zone still reached the scheduler');
    });

    it('And there is no value that one accepts and the other rejects', async () => {
      const values = [
        'UTC',
        'Australia/Sydney',
        'Australia/Brisbane',
        'Pacific/Chatham',
        '  Australia/Perth  ',
        'Foo/Bar',
        'Mars/Olympus_Mons',
        'Invalid Zone!',
        '',
        '   ',
        'Australia',
      ];

      for (const value of values) {
        const db = makeUpdateItem();
        const fromSettings = await handler(
          makeEvent('PUT', SETTINGS_PATH, {
            processingJobs: [{ name: 'Ashfield', schoolName: 'Ashfield Public School', domains: [], searchTerms: [] }],
            timezone: value,
          }),
          {},
          { env: BACKEND_ENV, updateItem: db.updateItem }
        );
        const fromSchedule = await putScheduleThroughTheRoute({ frequency: 'daily', hour: 7, timezone: value });

        const settingsAccepted = fromSettings.statusCode === 200;
        const scheduleAccepted = fromSchedule.response.statusCode === 200;
        assert.equal(
          settingsAccepted,
          scheduleAccepted,
          `"${value}": settings ${fromSettings.statusCode}, schedule ${fromSchedule.response.statusCode}`
        );
        assert.equal(settingsAccepted, isValidTimezone(String(value).trim()), `"${value}": disagrees with the tz database`);
        if (!settingsAccepted) {
          assert.equal(JSON.parse(fromSettings.body).field, 'timezone');
          assert.equal(fromSchedule.body.field, 'timezone');
        }
      }
    });

    it('And every zone the selector can offer is one both endpoints accept', () => {
      for (const zone of settings.timezoneOptionList('', OLD_BROWSER_INTL)) {
        assert.equal(isValidTimezone(zone), true, `${zone} is offered but is not a real zone`);
        assert.doesNotThrow(() => validateScheduleInput({ frequency: 'daily', hour: 7, timezone: zone }));
      }
    });
  });

  describe('Scenario: A blank time zone can no longer be submitted from the page', () => {
    it('When the settings page loads, Then the selector has a non-empty selected value', async () => {
      const { select } = await givenTheSettingsPageHasLoaded(makeWorld());
      assert.notEqual(select.value, '');
      assert.equal(select.value.trim(), select.value);
    });

    it('And there is no way to clear it to an empty string: no option carries a blank value', async () => {
      const { select } = await givenTheSettingsPageHasLoaded(makeWorld(), { intl: OLD_BROWSER_INTL });
      const values = valuesOf(select);
      assert.ok(values.length > 1);
      for (const value of values) {
        assert.notEqual(value, '', 'a blank option is selectable');
        assert.equal(typeof value, 'string');
        assert.notEqual(value.trim(), '');
      }
    });

    it('And the saved body therefore always carries a timezone key', async () => {
      const world = makeWorld({ storedTimezone: undefined, scheduleEnabled: true });
      const { doc } = await givenTheSettingsPageHasLoaded(world, {
        detectTimezone: () => 'Australia/Sydney',
        intl: OLD_BROWSER_INTL,
      });

      await whenISaveTheForm(doc);

      assert.equal('timezone' in world.bodyOf('PUT', SETTINGS_PATH), true, 'the settings body omitted the zone');
      assert.equal(world.bodyOf('PUT', SETTINGS_PATH).timezone, 'Australia/Sydney');
      assert.equal(world.bodyOf('PUT', SCHEDULE_PATH).timezone, 'Australia/Sydney');
    });
  });

  describe('Scenario: A rejected time zone is shown against the field', () => {
    it('Given the server refuses my zone with a 400 naming "timezone", Then the message lands in #error-timezone', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: '"Mars/Olympus_Mons" is not a valid time zone', field: 'timezone' },
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await whenISaveTheForm(doc);

      const slot = doc.getElementById('error-timezone');
      assert.equal(slot.hidden, false, 'the field error stayed hidden');
      assert.equal(textOf(slot), '"Mars/Olympus_Mons" is not a valid time zone');
      assert.equal(doc.getElementById('error-form').hidden, true, 'the form-level line was shown as well');
      assert.match(textOf(doc.getElementById('settings-status')), /Nothing was saved/i);
    });

    it('And it is set as TEXT, so a hostile value cannot become markup', async () => {
      const world = makeWorld({
        settingsPutStatus: 400,
        settingsPutBody: { error: `"${XSS}" is not a valid time zone`, field: 'timezone' },
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await whenISaveTheForm(doc);

      assert.equal(textOf(doc.getElementById('error-timezone')), `"${XSS}" is not a valid time zone`);
      assert.deepEqual(findElements(doc, 'img'), [], 'a rejected value became an element');
    });

    it('And a 400 from the SCHEDULE endpoint lands in the same slot', async () => {
      const world = makeWorld({
        scheduleEnabled: true,
        scheduleStatus: 400,
        scheduleBody: { error: '"Foo/Bar" is not a valid time zone', field: 'timezone' },
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await whenISaveTheForm(doc);

      assert.equal(doc.getElementById('error-timezone').hidden, false);
      assert.equal(textOf(doc.getElementById('error-timezone')), '"Foo/Bar" is not a valid time zone');
      assert.equal(doc.getElementById('error-form').hidden, true);
      assert.match(textOf(doc.getElementById('settings-status')), /automatic scan schedule was not/i);
    });
  });

  describe('Scenario: The browser cannot report a zone at all', () => {
    it('Given nothing stored and an Intl lookup that throws, Then the selector falls back to "UTC"', async () => {
      const world = makeWorld({ storedTimezone: undefined });
      const { select } = await givenTheSettingsPageHasLoaded(world, {
        detectTimezone: () => {
          throw new RangeError('Intl is unavailable in this browser');
        },
        intl: OLD_BROWSER_INTL,
      });

      assert.equal(select.value, 'UTC');
      assert.ok(valuesOf(select).includes('UTC'));
    });

    it('And a zone list that throws still leaves a usable, non-empty selector', async () => {
      const world = makeWorld({ storedTimezone: undefined });
      const { select } = await givenTheSettingsPageHasLoaded(world, {
        detectTimezone: () => '',
        intl: {
          supportedValuesOf: () => {
            throw new RangeError('no zone list in this build');
          },
        },
      });

      assert.equal(select.value, 'UTC');
      assert.ok(valuesOf(select).length > 1, 'the selector was left all but empty');
    });
  });

  describe('Scenario: Automatic scanning is not provisioned in this environment', () => {
    it('When the schedule PUT answers { available: false }, Then the save still reports it plainly', async () => {
      const world = makeWorld({ scheduleEnabled: true, scheduleBody: { available: false } });
      const { doc, select } = await givenTheSettingsPageHasLoaded(world, {
        intl: browserListing(['Australia/Brisbane', 'UTC']),
      });
      select.value = 'Australia/Brisbane';

      await whenISaveTheForm(doc);

      assert.equal(
        textOf(doc.getElementById('settings-status')),
        'Saved. Automatic scanning is not available in this environment yet.'
      );
      assert.equal(doc.getElementById('error-timezone').hidden, true);
      // The chosen zone was still sent - the selector changed nothing here.
      assert.equal(world.bodyOf('PUT', SCHEDULE_PATH).timezone, 'Australia/Brisbane');
    });

    it('And the route itself answers { available: false } without reaching the scheduler', async () => {
      const scheduler = makeScheduler();
      const { response, body } = await putScheduleThroughTheRoute(
        { frequency: 'daily', hour: 7, timezone: 'Australia/Brisbane' },
        { env: BACKEND_ENV, scheduler }
      );

      assert.equal(response.statusCode, 200);
      assert.deepEqual(body, { available: false });
      assert.deepEqual(scheduler.sent, []);
      assert.deepEqual(scheduler.patches, []);
    });
  });

  describe('Scenario: A legacy stored zone the tightened validator would refuse', () => {
    it('Given a row stored before this change, When the page loads, Then it renders rather than crashing', async () => {
      const world = makeWorld({ storedTimezone: 'Foo/Bar' });
      const { doc, select } = await givenTheSettingsPageHasLoaded(world, { intl: OLD_BROWSER_INTL });

      assert.equal(select.value, 'Foo/Bar', 'the legacy value was silently replaced');
      assert.equal(doc.getElementById('settings-body').hidden, false, 'the form never appeared');
      assert.equal(textOf(doc.getElementById('settings-status')), '');
    });

    it('And the failure, if any, arrives as a normal 400 on save', async () => {
      const world = makeWorld({
        storedTimezone: 'Foo/Bar',
        settingsPutStatus: 400,
        settingsPutBody: { error: '"Foo/Bar" is not a valid time zone', field: 'timezone' },
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world, { intl: OLD_BROWSER_INTL });

      await whenISaveTheForm(doc);

      assert.equal(doc.getElementById('error-timezone').hidden, false);
      assert.equal(textOf(doc.getElementById('error-timezone')), '"Foo/Bar" is not a valid time zone');
    });
  });
});
