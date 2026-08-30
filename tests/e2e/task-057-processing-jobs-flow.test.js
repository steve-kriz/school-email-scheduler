/**
 * E2E (cucumber-style) scenarios for TASK-057 - "Settings UI to add, edit,
 * remove and name multiple processing jobs".
 *
 * The ticket's Gherkin, written Given / When / Then and driven through the code
 * that actually ships:
 *
 *   - the client scenarios run the REAL `frontend/settings.js` against the REAL
 *     `frontend/settings.html`, parsed by `tests/helpers/fake-dom.mjs`. The
 *     container, the empty hint, the list-level error slot and the add button
 *     are STATIC markup, so a test that built its own page would keep passing
 *     after `#processing-jobs` stopped shipping; parsing the real page means it
 *     does not. Every interaction is a real `dispatch('click')` or
 *     `dispatch('submit')` on a node the renderer built;
 *   - the presentation scenarios pull `styles.css`, `settings.html` and
 *     `settings.js` back THROUGH THE REAL LAMBDA HANDLER and assert on the
 *     served bytes. There is no CSS engine anywhere in this repo (see the
 *     docblock in `tests/helpers/fake-dom.mjs`), so "the 44px minimum is not
 *     nested in a media query" is a statement about the stylesheet, read with
 *     the brace matcher in `tests/helpers/css-text.mjs` - not about a rendered
 *     box.
 *
 * NO DATABASE CONNECTION IS OPENED, and none can be. The page only ever talks
 * to an INJECTED `fetch`; there is no real `fetch` in scope in any scenario
 * below, and the static routes never reach a data layer at all. The one other
 * I/O boundary, reading an asset off disk, is injected wherever a scenario
 * counts reads.
 *
 * TWO HARNESS RULES, both load-bearing:
 *   1. `dispatch()` awaits its handlers. The form's submit handler starts an
 *      async `save()`, so scenarios that assert on a response also `drain()`.
 *   2. Element ids are INDEX-BASED and only valid for the current render, which
 *      is the code's own contract. Every lookup below is therefore done fresh
 *      through `getElementById` after the mutation, never cached across one.
 *
 * The unit tests for the same ticket are in
 * `tests/unit/task-057-processing-jobs-ui.test.js`.
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

const { handler, FRONTEND_ROUTES, FRONTEND_FILES } = await import('../../src/lambda/calendar/index.mjs');
const app = await import('../../src/lambda/calendar/frontend/app.js');
const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { loadDocument, findElements, textOf } = await import('../helpers/fake-dom.mjs');
const css = await import('../helpers/css-text.mjs');

const XSS = '<img src=x onerror=alert(1)>';
const SETTINGS_PATH = '/calendar/api/settings';
const SCHEDULE_PATH = '/calendar/api/scan/schedule';

/** Let every already-resolved promise chain settle. */
async function drain(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const albEvent = (requestPath, method = 'GET') => ({
  version: '2.0',
  rawPath: requestPath,
  rawQueryString: '',
  requestContext: {
    domainName: 'abc123.lambda-url.ap-southeast-2.on.aws',
    http: { method, path: requestPath },
  },
  headers: { host: 'abc123.lambda-url.ap-southeast-2.on.aws' },
  cookies: [],
  queryStringParameters: {},
  body: null,
  isBase64Encoded: false,
});

/** One complete, valid processing job. */
const job = (overrides = {}) => ({
  id: 'job-1',
  name: 'Ashfield',
  schoolName: 'Ashfield Public School',
  domain: 'ashfield.nsw.edu.au',
  searchTerms: [],
  ...overrides,
});

/* =========================================================================
 * The world: an injected fetch that answers the settings API, and nothing else.
 * ========================================================================= */

function makeWorld(overrides = {}) {
  const world = {
    calls: [],
    processingJobs: [job()],
    scheduleEnabled: false,
    settingsGetStatus: 200,
    settingsPutStatus: 200,
    /** When null, a PUT echoes the stored settings back. */
    settingsPutBody: null,
    scheduleStatus: 200,
    scheduleBody: { available: true },
    /** When set, EVERY route answers with this status. */
    forceStatus: null,
    ...overrides,
  };

  world.settingsBody = () => ({
    connectionStatus: 'connected',
    email: 'parent@example.test',
    lastScanStatus: 'ok',
    processingJobs: world.processingJobs,
    scheduleEnabled: world.scheduleEnabled,
    scheduleFrequency: 'daily',
    scheduleHour: 7,
    timezone: 'Australia/Sydney',
  });

  // Every body is a FRESH structuredClone, so a scenario that edits a rendered
  // row cannot mutate the fixture the next response is built from.
  const reply = (status, body) => ({ status, json: async () => structuredClone(body ?? {}) });

  world.fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const requestPath = full.split('?')[0];
    const method = init.method || 'GET';
    world.calls.push({ url: full, path: requestPath, method, init, body: init.body ? JSON.parse(init.body) : null });

    if (world.forceStatus !== null) return reply(world.forceStatus, { error: 'Not signed in' });

    if (requestPath === SETTINGS_PATH) {
      if (method === 'PUT') {
        return reply(world.settingsPutStatus, world.settingsPutBody ?? world.settingsBody());
      }
      return world.settingsGetStatus === 200
        ? reply(200, world.settingsBody())
        : reply(world.settingsGetStatus, { error: 'Not signed in' });
    }
    if (requestPath === SCHEDULE_PATH) return reply(world.scheduleStatus, world.scheduleBody);

    throw new Error(`the page requested a route the world does not know: ${method} ${full}`);
  };

  return world;
}

/** Open the REAL settings page against the REAL settings.js. */
function openSettings(world, options = {}) {
  const doc = loadDocument(SETTINGS_HTML);
  const page = settings.createSettingsPage({
    document: doc,
    fetchImpl: world.fetchImpl,
    detectTimezone: () => 'Australia/Sydney',
    ...options,
  });
  return { doc, page };
}

/** Background: an authenticated user whose Gmail is connected, page loaded. */
async function givenTheSettingsPageHasLoaded(world) {
  const { doc, page } = openSettings(world);
  await page.start();
  await drain();
  return { doc, page };
}

const jobBlocks = (doc) => doc.getElementById('processing-jobs').querySelectorAll('.job');
const termsOf = (doc, index) => doc.getElementById(`job-${index}-terms`).querySelectorAll('.job__term');
const valueOf = (doc, id) => doc.getElementById(id)?.value;
const isHidden = (doc, id) => doc.getElementById(id).hidden;

/** "When the user activates X" - a real click on the node currently rendered. */
async function activate(doc, id) {
  const node = doc.getElementById(id);
  assert.notEqual(node, null, `there is no element with id "${id}" to activate`);
  await node.dispatch('click');
  await drain();
}

/** "When the user types V into X". */
function type(doc, id, value) {
  const node = doc.getElementById(id);
  assert.notEqual(node, null, `there is no input with id "${id}" to type into`);
  node.value = value;
}

/** "When the user submits the settings form". */
async function submit(doc) {
  const event = await doc.getElementById('settings-form').dispatch('submit');
  await drain();
  return event;
}

const settingsPuts = (world) => world.calls.filter((call) => call.method === 'PUT' && call.path === SETTINGS_PATH);
const settingsRequests = (world) => world.calls.filter((call) => call.path === SETTINGS_PATH);

/** Fill a whole row, so a scenario only has to state the bit it is about. */
function fillRow(doc, index, { name, schoolName, domain }) {
  type(doc, `job-${index}-name`, name);
  type(doc, `job-${index}-schoolName`, schoolName);
  type(doc, `job-${index}-domain`, domain);
}

/* =========================================================================
 * Feature: A user manages several named processing jobs from the settings page
 * ========================================================================= */

describe('Feature: A user manages several named processing jobs from the settings page', () => {
  describe('Scenario: Stored jobs render one editable block each, in order', () => {
    it('Given two stored jobs, When they are rendered, Then each is one editable block in order', async () => {
      const world = makeWorld({
        processingJobs: [
          job({ id: 'job-1', name: 'Ashfield', searchTerms: ['newsletter', 'canteen'] }),
          job({ id: 'job-2', name: "St Mary's", schoolName: "St Mary's Primary", domain: 'stmarys.nsw.edu.au' }),
        ],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      const blocks = jobBlocks(doc);
      assert.equal(blocks.length, 2);
      const container = doc.getElementById('processing-jobs');
      assert.ok(
        container.childNodes.indexOf(blocks[0]) < container.childNodes.indexOf(blocks[1]),
        'the first job block does not appear before the second'
      );

      assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield');
      assert.equal(valueOf(doc, 'job-0-schoolName'), 'Ashfield Public School');
      assert.equal(valueOf(doc, 'job-0-domain'), 'ashfield.nsw.edu.au');
      assert.equal(termsOf(doc, 0).length, 2);
      assert.equal(valueOf(doc, 'job-0-term-0'), 'newsletter');
      assert.equal(valueOf(doc, 'job-0-term-1'), 'canteen');

      assert.equal(valueOf(doc, 'job-1-name'), "St Mary's");
      assert.equal(termsOf(doc, 1).length, 0, 'a job with no terms rendered a term row');

      assert.equal(isHidden(doc, 'processing-jobs-empty'), true);
      assert.equal(textOf(doc.getElementById('settings-summary')), "Watching mail for Ashfield, St Mary's");
    });
  });

  describe('Scenario: A user with no jobs is told so and is not shown an empty row', () => {
    it('Given processingJobs is [], Then no .job block is rendered and the empty hint is visible', async () => {
      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld({ processingJobs: [] }));

      assert.equal(jobBlocks(doc).length, 0, 'an empty editable row was invented');
      assert.equal(isHidden(doc, 'processing-jobs-empty'), false);
      assert.match(textOf(doc.getElementById('processing-jobs-empty')), /no processing job/i);
      assert.match(textOf(doc.getElementById('settings-summary')), /No processing job saved yet/);
    });
  });

  describe('Scenario: Adding a new job and saving it', () => {
    it('Given no jobs, When one is added, filled and saved, Then the PUT carries it with no id', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc, page } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'add-processing-job');

      assert.equal(jobBlocks(doc).length, 1);
      assert.equal(valueOf(doc, 'job-0-name'), '');
      assert.equal(page.state.focusFieldId, 'job-0-name', 'the caret was not moved to the new row');
      assert.equal(isHidden(doc, 'processing-jobs-empty'), true);

      fillRow(doc, 0, {
        name: 'Ashfield',
        schoolName: 'Ashfield Public School',
        domain: 'ashfield.nsw.edu.au',
      });
      await activate(doc, 'add-term-0');
      type(doc, 'job-0-term-0', 'newsletter');
      await submit(doc);

      const puts = settingsPuts(world);
      assert.equal(puts.length, 1, 'no PUT was sent to the settings endpoint');
      assert.deepEqual(puts[0].body.processingJobs, [
        {
          name: 'Ashfield',
          schoolName: 'Ashfield Public School',
          domain: 'ashfield.nsw.edu.au',
          searchTerms: ['newsletter'],
        },
      ]);
      assert.equal('schoolNames' in puts[0].body, false);
      assert.equal('searchDomains' in puts[0].body, false);
      assert.equal('id' in puts[0].body.processingJobs[0], false, 'a client temp id was sent');
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });
  });

  describe('Scenario: A server-assigned id lands on the new row after the save', () => {
    it('Given the save response carries id "srv-9", Then the row carries it and the next save sends it', async () => {
      const world = makeWorld({ processingJobs: [] });
      world.settingsPutBody = {
        connectionStatus: 'connected',
        email: 'parent@example.test',
        processingJobs: [job({ id: 'srv-9', name: 'Ashfield', searchTerms: [] })],
        scheduleEnabled: false,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'add-processing-job');
      fillRow(doc, 0, {
        name: 'Ashfield',
        schoolName: 'Ashfield Public School',
        domain: 'ashfield.nsw.edu.au',
      });
      await submit(doc);

      assert.equal(jobBlocks(doc)[0].getAttribute('data-job-id'), 'srv-9');
      assert.equal(jobBlocks(doc)[0].getAttribute('data-job-new'), null);

      type(doc, 'job-0-name', 'Ashfield PS');
      await submit(doc);

      const puts = settingsPuts(world);
      assert.equal(puts.length, 2);
      assert.equal(puts[1].body.processingJobs[0].id, 'srv-9');
      assert.equal(puts[1].body.processingJobs[0].name, 'Ashfield PS');
    });
  });

  describe('Scenario: Editing an existing job preserves its id so attribution survives a rename', () => {
    it('Given a stored job "job-1", When it is renamed and saved, Then the PUT keeps the id', async () => {
      const world = makeWorld({ processingJobs: [job({ id: 'job-1', name: 'Ashfield' })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-name', 'Ashfield Newsletters');
      await submit(doc);

      const body = settingsPuts(world)[0].body;
      assert.equal(body.processingJobs[0].id, 'job-1', 'a rename orphaned every event attributed to this job');
      assert.equal(body.processingJobs[0].name, 'Ashfield Newsletters');
    });
  });

  describe('Scenario: Adding a second job does not lose what was typed into the first', () => {
    it('Given text typed into row 0, When a second job is added, Then row 0 still reads it back', async () => {
      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld({ processingJobs: [] }));

      await activate(doc, 'add-processing-job');
      type(doc, 'job-0-name', 'Ashfield');
      await activate(doc, 'add-processing-job');

      assert.equal(jobBlocks(doc).length, 2);
      assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield', 'the re-render discarded what the user typed');
      assert.equal(valueOf(doc, 'job-1-name'), '');
    });
  });

  describe('Scenario: Adding and removing search terms uses the same pattern as adding a job', () => {
    it('Given one term, When one is added and the first removed, Then only the survivor is saved', async () => {
      const world = makeWorld({ processingJobs: [job({ searchTerms: ['newsletter'] })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'add-term-0');
      assert.equal(termsOf(doc, 0).length, 2);
      assert.equal(valueOf(doc, 'job-0-term-1'), '');

      type(doc, 'job-0-term-1', 'canteen');
      // Removing a term is NOT confirmed - it is one field, not a whole job.
      await activate(doc, 'remove-job-0-term-0');

      assert.equal(termsOf(doc, 0).length, 1);
      assert.equal(valueOf(doc, 'job-0-term-0'), 'canteen');

      await submit(doc);
      assert.deepEqual(settingsPuts(world)[0].body.processingJobs[0].searchTerms, ['canteen']);
    });
  });

  describe('Scenario: A blank search term is dropped rather than sent', () => {
    it('Given an added but empty term, When the form is submitted, Then searchTerms is []', async () => {
      const world = makeWorld({ processingJobs: [job({ searchTerms: [] })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'add-term-0');
      assert.equal(valueOf(doc, 'job-0-term-0'), '');
      fillRow(doc, 0, { name: 'Ashfield', schoolName: 'Ashfield Public School', domain: 'ashfield.nsw.edu.au' });
      await submit(doc);

      assert.deepEqual(settingsPuts(world)[0].body.processingJobs[0].searchTerms, [], 'a blank term was sent as ""');
    });
  });

  describe('Scenario: Adding a search term to one job leaves the other jobs alone', () => {
    it('Given two jobs with one term each, When a term is added to job 1, Then job 0 is untouched', async () => {
      const world = makeWorld({
        processingJobs: [
          job({ id: 'job-1', name: 'A', searchTerms: ['a'] }),
          job({ id: 'job-2', name: 'B', searchTerms: ['b'] }),
        ],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'add-term-1');

      assert.equal(termsOf(doc, 1).length, 2);
      assert.equal(termsOf(doc, 0).length, 1);
      assert.equal(valueOf(doc, 'job-0-term-0'), 'a');
    });
  });

  describe('Scenario: Removing a job asks first, then removes it, then saves the removal', () => {
    it('Given two jobs, When one is removed and confirmed and saved, Then only the other is sent', async () => {
      const world = makeWorld({
        processingJobs: [
          job({ id: 'job-1', name: 'Ashfield' }),
          job({ id: 'job-2', name: "St Mary's", schoolName: "St Mary's Primary", domain: 'stmarys.nsw.edu.au' }),
        ],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');

      // Rule (a) of the disconnect control: the acting control does not exist
      // until the user has explicitly asked for it, and NOTHING has happened yet.
      assert.equal(jobBlocks(doc).length, 2, 'arming a removal removed the job');
      assert.match(textOf(doc.getElementById('job-0-confirm')), /Remove Ashfield\?/);
      assert.notEqual(doc.getElementById('confirm-remove-job-0'), null);
      assert.equal(doc.getElementById('remove-job-0'), null, 'the arming control is still tappable');

      await activate(doc, 'confirm-remove-job-0');

      assert.equal(jobBlocks(doc).length, 1);
      assert.equal(valueOf(doc, 'job-0-name'), "St Mary's");
      assert.deepEqual(settingsRequests(world).map((call) => call.method), ['GET'], 'the removal was sent immediately');

      await submit(doc);
      const body = settingsPuts(world)[0].body;
      assert.equal(body.processingJobs.length, 1);
      assert.equal(body.processingJobs[0].name, "St Mary's");
    });
  });

  describe('Scenario: Cancelling a removal keeps the job', () => {
    it('Given an armed removal, When it is cancelled, Then both jobs remain and the gate is gone', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');
      await activate(doc, 'cancel-remove-job-0');

      assert.equal(jobBlocks(doc).length, 2);
      assert.equal(doc.getElementById('confirm-remove-job-0'), null);
      assert.notEqual(doc.getElementById('remove-job-0'), null, 'the row did not return to its normal state');
    });
  });

  describe('Scenario: Arming a second removal invalidates the first', () => {
    it('Given three jobs, When a second row is armed, Then the first is disarmed', async () => {
      const world = makeWorld({
        processingJobs: [
          job({ id: 'job-1', name: 'A' }),
          job({ id: 'job-2', name: 'B' }),
          job({ id: 'job-3', name: 'C' }),
        ],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');
      await activate(doc, 'remove-job-2');

      assert.notEqual(doc.getElementById('confirm-remove-job-2'), null);
      assert.equal(doc.getElementById('confirm-remove-job-0'), null, 'two rows were armed at once');

      await activate(doc, 'confirm-remove-job-2');

      assert.equal(jobBlocks(doc).length, 2);
      assert.equal(valueOf(doc, 'job-0-name'), 'A', 'the wrong job was removed');
      assert.equal(valueOf(doc, 'job-1-name'), 'B');
    });
  });

  describe('Scenario: Removing the last job leaves an explicit empty state, not a blank panel', () => {
    it('Given one job, When it is removed and saved, Then the PUT sends []', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');
      await activate(doc, 'confirm-remove-job-0');

      // The client invents no "you must keep at least one job" rule.
      assert.equal(jobBlocks(doc).length, 0);
      assert.equal(isHidden(doc, 'processing-jobs-empty'), false);
      assert.equal(isHidden(doc, 'error-processingJobs'), true);

      await submit(doc);
      assert.deepEqual(settingsPuts(world)[0].body.processingJobs, []);
    });
  });

  describe('Scenario: A removal is not persisted until the user saves', () => {
    it('Given a removal that was not saved, When the page is reloaded, Then the job is back', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');
      await activate(doc, 'confirm-remove-job-0');
      assert.equal(jobBlocks(doc).length, 1);

      // A reload is a fresh page against the same, untouched server state.
      const reloaded = await givenTheSettingsPageHasLoaded(world);
      assert.equal(jobBlocks(reloaded.doc).length, 2, 'an unsaved removal was persisted');
      assert.equal(settingsPuts(world).length, 0);
    });
  });

  /* --- Client-side validation: caught before the round trip --------------- */

  describe('Scenario: A duplicate job name is refused before any request is sent', () => {
    it('Given two jobs both named "Ashfield", When saved, Then nothing is sent and row 1 is flagged', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'Ashfield' }), job({ id: 'job-2', name: 'Ashfield' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await submit(doc);

      assert.equal(settingsPuts(world).length, 0, 'a duplicate name cost a round trip');
      assert.equal(
        world.calls.some((call) => call.path === SCHEDULE_PATH),
        false,
        'a rejected save went on to write the schedule'
      );
      assert.equal(isHidden(doc, 'error-job-1-name'), false);
      assert.match(textOf(doc.getElementById('error-job-1-name')), /Ashfield/);
      assert.equal(isHidden(doc, 'error-job-0-name'), true, 'the error was aimed at the earlier job too');
      assert.equal(
        textOf(doc.getElementById('settings-status')),
        'Nothing was saved - please fix the highlighted field.'
      );
      // The `finally` still runs on this path, or one bad save locks the form.
      assert.equal(doc.getElementById('save-settings').disabled, false);
    });
  });

  describe('Scenario: Duplicate names are compared case-insensitively and after trimming', () => {
    it('Given "Ashfield" and "  ashfield  ", When saved, Then nothing is sent and row 1 is flagged', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'Ashfield' }), job({ id: 'job-2', name: '  ashfield  ' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await submit(doc);

      assert.equal(settingsPuts(world).length, 0);
      assert.equal(isHidden(doc, 'error-job-1-name'), false);
    });
  });

  describe('Scenario Outline: A required field left blank is refused before the round trip', () => {
    for (const field of ['name', 'schoolName', 'domain']) {
      it(`Given one job whose "${field}" is blank, When saved, Then nothing is sent and it is flagged`, async () => {
        const world = makeWorld({ processingJobs: [job()] });
        const { doc } = await givenTheSettingsPageHasLoaded(world);

        type(doc, `job-0-${field}`, '   ');
        await submit(doc);

        assert.equal(settingsPuts(world).length, 0, `a blank ${field} cost a round trip`);
        assert.equal(isHidden(doc, `error-job-0-${field}`), false);
        assert.match(textOf(doc.getElementById(`error-job-0-${field}`)), /required/i);
        assert.equal(doc.getElementById('save-settings').disabled, false);
      });
    }
  });

  describe('Scenario: Only the first problem is reported, topmost first', () => {
    it('Given job 0 with a blank name and job 1 with a blank domain, Then only job 0 is flagged', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-name', '');
      type(doc, 'job-1-domain', '');
      await submit(doc);

      assert.equal(isHidden(doc, 'error-job-0-name'), false);
      assert.equal(isHidden(doc, 'error-job-1-domain'), true, 'a second problem was reported at the same time');
    });
  });

  describe('Scenario: Two blank names are reported as required, not as duplicates', () => {
    it('Given two jobs with blank names, When saved, Then row 0 says the name is required', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-name', '');
      type(doc, 'job-1-name', '   ');
      await submit(doc);

      const message = textOf(doc.getElementById('error-job-0-name'));
      assert.equal(isHidden(doc, 'error-job-0-name'), false);
      assert.match(message, /required/i);
      assert.equal(/duplicate|same/i.test(message), false, 'two blank names were reported as duplicates');
    });
  });

  describe('Scenario: The client does not second-guess rules it does not own', () => {
    it('Given a domain of "gmail.com", When saved, Then the request is sent and the server decides', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-domain', 'gmail.com');
      await submit(doc);

      assert.equal(settingsPuts(world).length, 1, 'the client refused a value the server may have accepted');
      assert.equal(settingsPuts(world)[0].body.processingJobs[0].domain, 'gmail.com');
    });
  });

  /* --- Server-side validation: the server stays the source of truth ------- */

  describe("Scenario: A server field error lands on the named job's field", () => {
    it('Given a 400 naming processingJobs[0].domain, Then that row\'s slot shows the server\'s words', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      world.settingsPutStatus = 400;
      world.settingsPutBody = { error: 'That domain is not accepted.', field: 'processingJobs[0].domain' };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await submit(doc);

      assert.equal(isHidden(doc, 'error-job-0-domain'), false);
      assert.equal(textOf(doc.getElementById('error-job-0-domain')), 'That domain is not accepted.');
      assert.equal(isHidden(doc, 'error-form'), true);
      assert.equal(isHidden(doc, 'error-processingJobs'), true);
      assert.equal(
        textOf(doc.getElementById('settings-status')),
        'Nothing was saved - please fix the highlighted field.'
      );
      assert.equal(
        world.calls.some((call) => call.path === SCHEDULE_PATH),
        false,
        'a refused settings save still wrote the schedule'
      );
    });
  });

  describe('Scenario: A list-level server error lands on the list-level slot', () => {
    it('Given 21 jobs and a 400 naming processingJobs, Then #error-processingJobs carries it', async () => {
      const world = makeWorld({
        processingJobs: Array.from({ length: 21 }, (_, index) =>
          job({ id: `job-${index}`, name: `Job ${index}`, domain: `job${index}.nsw.edu.au` })
        ),
      });
      world.settingsPutStatus = 400;
      world.settingsPutBody = { error: 'At most 20 processing jobs.', field: 'processingJobs' };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      assert.equal(jobBlocks(doc).length, 21, 'the client enforced the job cap itself');
      await submit(doc);

      assert.equal(isHidden(doc, 'error-processingJobs'), false);
      assert.equal(textOf(doc.getElementById('error-processingJobs')), 'At most 20 processing jobs.');
      assert.equal(isHidden(doc, 'error-form'), true);
    });
  });

  describe('Scenario Outline: An unresolvable server field name fails closed to the form line', () => {
    for (const field of [
      'processingJobs[0].nickname',
      'processingJobs[abc].name',
      'processingJobs[-1].name',
      'processingJobs[9].name',
      'schoolNames',
      '42',
    ]) {
      it(`Given a 400 naming "${field}", When saved, Then the form-level line explains the refusal`, async () => {
        const world = makeWorld({ processingJobs: [job()] });
        world.settingsPutStatus = 400;
        world.settingsPutBody = { error: 'That value was refused.', field };
        const { doc } = await givenTheSettingsPageHasLoaded(world);

        await submit(doc);

        assert.equal(isHidden(doc, 'error-form'), false, `${field} showed the user nothing at all`);
        assert.equal(textOf(doc.getElementById('error-form')), 'That value was refused.');
        assert.equal(isHidden(doc, 'error-job-0-name'), true);
      });
    }
  });

  describe('Scenario: A stale error does not survive the next save', () => {
    it('Given a previous save flagged row 0, When it is fixed and saved, Then the slot is empty', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-name', '');
      await submit(doc);
      assert.equal(isHidden(doc, 'error-job-0-name'), false);

      type(doc, 'job-0-name', 'Ashfield');
      await submit(doc);

      assert.equal(isHidden(doc, 'error-job-0-name'), true, 'a stale row error survived the next save');
      assert.equal(textOf(doc.getElementById('error-job-0-name')), '');
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });

    it('And it does not survive a save that is refused before any re-render either', async () => {
      // A good save re-renders the rows, which blanks the slots on its own. A
      // save refused by the pre-flight does NOT, so this is the path where only
      // clearErrors sweeping the dynamic slots can take a stale row error away.
      const world = makeWorld({ processingJobs: [job()] });
      world.settingsPutStatus = 400;
      world.settingsPutBody = { error: 'That domain is not accepted.', field: 'processingJobs[0].domain' };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await submit(doc);
      assert.equal(isHidden(doc, 'error-job-0-domain'), false);

      type(doc, 'job-0-name', '   ');
      await submit(doc);

      assert.equal(isHidden(doc, 'error-job-0-domain'), true, 'a stale row error survived a client-side rejection');
      assert.equal(textOf(doc.getElementById('error-job-0-domain')), '');
      assert.equal(isHidden(doc, 'error-job-0-name'), false);
      assert.equal(settingsPuts(world).length, 1, 'the second, refused save still went to the server');
    });
  });

  /* --- Failure and edge paths -------------------------------------------- */

  describe('Scenario: A hostile job name is rendered as literal text everywhere', () => {
    it('Given a stored name of "<img src=x onerror=alert(1)>", Then no element is created from it', async () => {
      const world = makeWorld({
        processingJobs: [{ id: 'job-1', name: XSS, schoolName: 'S', domain: 'd.edu.au', searchTerms: ['<script>alert(1)</script>'] }],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      assert.equal(valueOf(doc, 'job-0-name'), XSS);
      assert.equal(valueOf(doc, 'job-0-term-0'), '<script>alert(1)</script>');
      assert.equal(doc.getElementById('job-0-head').textContent, XSS);
      assert.equal(doc.getElementById('settings-school-name').textContent, XSS);

      assert.deepEqual(findElements(doc, 'img'), [], 'an IMG element was created from a job name');
      const scripts = findElements(doc, 'script');
      assert.equal(scripts.length, 1, 'the renderer created a SCRIPT element');
      assert.equal(scripts[0].getAttribute('src'), '/calendar/settings.js');
    });

    it('And the confirmation block names the job as text too', async () => {
      const world = makeWorld({ processingJobs: [job({ name: XSS })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await activate(doc, 'remove-job-0');

      assert.ok(textOf(doc.getElementById('job-0-confirm')).includes(XSS));
      assert.deepEqual(findElements(doc, 'img'), []);
    });
  });

  describe('Scenario: The list renderer survives a malformed settings body', () => {
    for (const [label, value] of [
      ['a string', 'Ashfield'],
      ['a number', 42],
      ['an object', { name: 'Ashfield' }],
      ['null', null],
    ]) {
      it(`Given processingJobs is ${label}, Then nothing throws and the empty state shows`, async () => {
        const world = makeWorld({ processingJobs: value });
        const { doc } = await givenTheSettingsPageHasLoaded(world);

        assert.equal(jobBlocks(doc).length, 0);
        assert.equal(isHidden(doc, 'processing-jobs-empty'), false);
        assert.equal(isHidden(doc, 'settings-body'), false, 'the page was left unusable by a malformed body');
      });
    }

    it('And an entry that is not an object becomes a blank row rather than being dropped', async () => {
      const world = makeWorld({ processingJobs: [job(), null, 7] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      assert.equal(jobBlocks(doc).length, 3, 'a bad entry was dropped, shifting every index below it');
      assert.equal(valueOf(doc, 'job-1-name'), '');
      assert.equal(valueOf(doc, 'job-2-name'), '');
    });
  });

  describe('Scenario: A network failure on save changes nothing on screen', () => {
    it('Given the settings endpoint responds 500, Then the rows stay and the user is told', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      world.settingsPutStatus = 500;
      world.settingsPutBody = { error: 'boom' };
      await submit(doc);

      assert.equal(jobBlocks(doc).length, 2, 'a failed save wiped the list');
      assert.equal(valueOf(doc, 'job-0-name'), 'A');
      assert.match(textOf(doc.getElementById('settings-status')), /could not save your settings/i);
      assert.equal(doc.getElementById('save-settings').disabled, false);
      assert.equal(doc.getElementById('connect-gmail'), null, 'a 500 was treated as a sign-out');
    });
  });

  describe('Scenario: A 401 during save hides the settings body and prompts a reconnect', () => {
    it('Given the session expires, When the form is submitted, Then the connect card replaces the form', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);
      assert.equal(isHidden(doc, 'settings-body'), false);

      world.forceStatus = 401;
      await submit(doc);

      assert.equal(isHidden(doc, 'settings-body'), true, 'the settings body survived a sign-out');
      assert.notEqual(doc.getElementById('connect-gmail'), null, 'no connect card was rendered');
      assert.equal(
        doc.getElementById('connect-gmail').getAttribute('href'),
        '/calendar/api/auth/google/start'
      );
      // 401 is not shouted at as a save failure on top of the connect state.
      assert.equal(/could not save/i.test(textOf(doc.getElementById('settings-status'))), false);
    });
  });

  describe('Scenario: Controls are bound once, not once per render', () => {
    it('Given one stored job, When it is added and removed 10 times, Then one more add adds ONE block', async () => {
      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld({ processingJobs: [job()] }));

      for (let round = 0; round < 10; round += 1) {
        await activate(doc, 'add-processing-job');
        await activate(doc, 'remove-job-1');
        await activate(doc, 'confirm-remove-job-1');
      }
      assert.equal(jobBlocks(doc).length, 1, 'a stacked handler changed the state more than once');

      await activate(doc, 'add-processing-job');
      assert.equal(jobBlocks(doc).length, 2, 'one tap added more than one row');
    });
  });

  describe('Scenario: Adding a job never submits the form', () => {
    it('Given no jobs, When "Add processing job" is activated, Then no request is sent', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);
      const before = world.calls.length;

      await activate(doc, 'add-processing-job');
      await activate(doc, 'add-term-0');

      assert.equal(world.calls.length, before, 'adding a row submitted the form');
      assert.equal(doc.getElementById('add-processing-job').getAttribute('type'), 'button');
      assert.equal(doc.getElementById('add-term-0').getAttribute('type'), 'button');
      assert.equal(doc.getElementById('remove-job-0').getAttribute('type'), 'button');
    });
  });

  describe('Scenario: Saving twice in quick succession sends one request', () => {
    it('Given one valid job, When the form is submitted twice, Then exactly 1 PUT is sent', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      const form = doc.getElementById('settings-form');
      await form.dispatch('submit');
      await form.dispatch('submit');
      await drain();

      assert.equal(settingsPuts(world).length, 1, 'a double tap sent two saves');
    });
  });

  describe('Scenario: The setup prompt reflects processing jobs, not the removed schoolNames', () => {
    it('Given /auth/me returns processingJobs [], Then needsSchool is true and the card is rendered', async () => {
      const view = app.connectionView({
        connectionStatus: 'connected',
        email: 'parent@example.test',
        processingJobs: [],
      });
      assert.equal(view.needsSchool, true);

      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld({ processingJobs: [] }));
      assert.notEqual(doc.getElementById('school-setup'), null, 'no "Tell us your school" card was rendered');
      assert.match(textOf(doc.getElementById('school-setup')), /Tell us your school/);
    });

    it('Given one named job, Then needsSchool is false and the identity card shows its name as text', async () => {
      const me = {
        connectionStatus: 'connected',
        email: 'parent@example.test',
        processingJobs: [job({ name: 'Ashfield' })],
      };
      assert.equal(app.connectionView(me).needsSchool, false);

      const { doc } = await givenTheSettingsPageHasLoaded(makeWorld({ processingJobs: [job({ name: 'Ashfield' })] }));
      assert.equal(doc.getElementById('school-setup'), null, 'a configured account was still asked for a school');
      assert.equal(doc.getElementById('identity-school-name').textContent, 'Watching mail for Ashfield');
    });
  });
});

/* =========================================================================
 * Feature: The processing-job editor is usable on a phone
 * ========================================================================= */

describe('Feature: The processing-job editor is usable on a phone', () => {
  /** The bytes the Lambda actually serves, not a file read behind its back. */
  async function served(route) {
    const response = await handler(albEvent(route), {}, {});
    assert.equal(response.statusCode, 200, route);
    return response;
  }

  describe('Scenario: Job rows stack rather than scroll sideways', () => {
    it('Given the shipped styles.css, Then .job is a grid and nothing sets overflow-x', async () => {
      const stylesheet = (await served('/calendar/styles.css')).body;
      const outside = css.outsideMediaQueries(stylesheet);

      assert.equal(css.rulesFor(outside, '.job').length >= 1, true, 'there is no rule for .job at all');
      assert.equal(css.declaredValue(outside, '.job', 'display'), 'grid');
      assert.equal(css.declaredValue(outside, '.job__term', 'display'), 'grid');
      assert.equal(css.declaredValue(outside, '.jobs', 'display'), 'grid');
      // A single implicit column: no rule declares a multi-column track list.
      for (const selector of ['.jobs', '.job', '.job__term']) {
        assert.equal(css.declaredValue(outside, selector, 'grid-template-columns'), null, selector);
      }

      // A horizontally scrolling region inside a vertically scrolling page is
      // the trap TASK-054 explicitly refused for the month grid.
      const flat = css.stripComments(stylesheet).replace(/@media[^{]*\{/g, '');
      for (const rule of css.eachRule(flat)) {
        if (!rule.selectors.some((selector) => /\.jobs?\b|\.job__/.test(selector))) continue;
        const declarations = css.declarationsOf(rule.body);
        assert.equal(declarations['overflow-x'], undefined, `${rule.selectors.join(', ')} sets overflow-x`);
        assert.equal(declarations.overflow, undefined, `${rule.selectors.join(', ')} sets overflow`);
      }
    });
  });

  describe('Scenario Outline: Every control added by this ticket meets the 44px guideline', () => {
    it('Given the shipped settings.html and styles.css, Then every new control carries a 44px class', async () => {
      const stylesheet = (await served('/calendar/styles.css')).body;
      const outside = css.outsideMediaQueries(stylesheet);
      assert.equal(css.declaredValue(outside, '.btn', 'min-height'), '44px');
      assert.equal(css.declaredValue(outside, '.btn-small', 'min-height'), '44px');

      // The static control, read off the served page.
      const page = loadDocument(SETTINGS_HTML);
      assert.equal(page.getElementById('add-processing-job').className, 'btn');

      // And the five controls the renderer builds, on a rendered, armed row.
      const world = makeWorld({ processingJobs: [job({ searchTerms: ['newsletter'] })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);
      await activate(doc, 'remove-job-0');

      for (const id of ['confirm-remove-job-0', 'cancel-remove-job-0', 'add-term-0', 'remove-job-0-term-0']) {
        const control = doc.getElementById(id);
        assert.notEqual(control, null, `${id} is not rendered`);
        assert.equal(control.className, 'btn btn-small', `${id} carries no 44px class`);
      }
      await activate(doc, 'cancel-remove-job-0');
      assert.equal(doc.getElementById('remove-job-0').className, 'btn btn-small');

      // And that 44px rule is NOT inside a media query, at either breakpoint.
      for (const block of css.mediaBlocks(stylesheet)) {
        for (const rule of css.eachRule(block.body)) {
          if (!rule.selectors.some((selector) => /\.btn|\.jobs?\b|\.job__/.test(selector))) continue;
          assert.equal(
            css.declarationsOf(rule.body)['min-height'],
            undefined,
            `${rule.selectors.join(', ')} sets a touch target inside @media ${block.prelude}`
          );
        }
      }
    });
  });

  describe('Scenario: Text inputs keep the 16px size that stops iOS zooming on focus', () => {
    it('Given the shipped styles.css, Then .field-input inherits the body font and is never reduced', async () => {
      const stylesheet = (await served('/calendar/styles.css')).body;
      assert.equal(css.declaredValue(css.outsideMediaQueries(stylesheet), '.field-input', 'font'), 'inherit');
      for (const source of [css.outsideMediaQueries(stylesheet), ...css.mediaBlocks(stylesheet).map((b) => b.body)]) {
        assert.equal(css.declaredValue(source, '.field-input', 'font-size'), null);
      }

      const world = makeWorld({ processingJobs: [job({ searchTerms: ['newsletter'] })] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);
      const inputs = findElements(doc.getElementById('processing-jobs'), 'input');
      assert.equal(inputs.length, 4, `expected 3 fields and 1 term input, found ${inputs.length}`);
      for (const input of inputs) {
        assert.equal(input.className, 'field-input', input.getAttribute('id'));
      }
    });
  });

  describe('Scenario: No sixth frontend file and no external reference is introduced', () => {
    it('Given every frontend route against an injected reader, Then exactly five files are read', async () => {
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
      const expected = new Set(Object.keys(FRONTEND_FILES).map((name) => path.join('/fake/bundle', 'frontend', name)));
      assert.equal(reads.length, 5, `TASK-057 added a sixth frontend file: ${reads.length} reads`);
      for (const filePath of reads) assert.equal(expected.has(filePath), true, filePath);
    });

    it('And styles.css contains no @import and no served body references a remote URL', async () => {
      const stylesheet = (await served('/calendar/styles.css')).body;
      assert.equal(/@import/.test(stylesheet), false);

      for (const route of ['/calendar/settings', '/calendar/settings.js', '/calendar/styles.css', '/calendar/app.js']) {
        const body = (await served(route)).body;
        assert.equal(/https?:\/\//.test(body), false, `${route} references a remote URL under default-src 'self'`);
        assert.deepEqual(body.match(/\.innerHTML/g) || [], [], `${route} reaches for innerHTML`);
        assert.deepEqual(body.match(/\.insertAdjacentHTML\(/g) || [], [], `${route} reaches for insertAdjacentHTML`);
        assert.deepEqual(body.match(/document\.write/g) || [], [], `${route} reaches for document.write`);
      }
    });
  });

  describe('Scenario: The disconnect section is untouched by this ticket', () => {
    it('Given the shipped settings.html, Then its position-sensitive markup still ships', async () => {
      const body = (await served('/calendar/settings.html')).body;
      // tests/unit/calendar-disconnect.test.js slices the raw HTML on this span.
      assert.match(body, /id="disconnect-submit" disabled>/);
      assert.match(body, /id="disconnect-events-keep"[\s\S]{0,200}checked/);

      const doc = loadDocument(SETTINGS_HTML);
      assert.equal(doc.getElementById('disconnect-submit').disabled, true);
      assert.equal(doc.getElementById('disconnect-events-keep').checked, true);
      assert.notEqual(doc.querySelector('#settings-body #disconnect-gmail'), null);
    });

    it('And settings.js still exports requiredConfirmation and isConfirmed unchanged', () => {
      assert.equal(settings.requiredConfirmation(true), 'DELETE MY EVENTS');
      assert.equal(settings.requiredConfirmation(false), 'DISCONNECT');
      assert.equal(settings.isConfirmed('  DELETE MY EVENTS  ', true), true);
      assert.equal(settings.isConfirmed('delete my events', true), false);
      assert.equal(settings.isConfirmed(null, false), false);
      assert.deepEqual(settings.disconnectRequestBody(true), { deleteEvents: true });
    });

    it('And a settings save does not disturb the disconnect gate', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      const { doc, page } = await givenTheSettingsPageHasLoaded(world);

      const control = settings.initDisconnectControl({ root: doc, fetchImpl: world.fetchImpl });
      assert.notEqual(control, null);
      doc.getElementById('disconnect-confirm').value = 'DISCONNECT';
      await doc.getElementById('disconnect-confirm').dispatch('input');
      assert.equal(doc.getElementById('disconnect-submit').disabled, false);

      await page.save();
      await drain();

      assert.equal(doc.getElementById('disconnect-submit').disabled, false, 'a settings save reset the gate');
      assert.equal(textOf(doc.getElementById('disconnect-status')), '');
      assert.equal(doc.getElementById('disconnect-events-keep').checked, true);
    });
  });
});
