/**
 * E2E (cucumber-style) scenarios for TASK-060 - "Simplify the processing job
 * settings UI to comma-separated domain and search-term fields".
 *
 * The ticket's Gherkin feature file, written Given / When / Then and driven
 * through the code that actually ships: the REAL `frontend/settings.js` against
 * the REAL `frontend/settings.html`, parsed by `tests/helpers/fake-dom.mjs`.
 * Every interaction is a real `dispatch('click')` or `dispatch('submit')` on a
 * node the renderer built, and the presentation scenarios pull `styles.css` and
 * `settings.js` back THROUGH THE REAL LAMBDA HANDLER and read the served bytes.
 *
 * NO DATABASE CONNECTION IS OPENED, and none can be. The page only ever talks to
 * an INJECTED `fetch` (`world.fetchImpl`); there is no real `fetch` in scope in
 * any scenario below, no DynamoDB client is constructed and no credential is
 * read. The "stored settings" are plain object literals the injected fetch hands
 * back in the shape the settings API returns.
 *
 * TWO HARNESS RULES, both load-bearing:
 *   1. `dispatch()` awaits its handlers. The form's submit handler starts an
 *      async `save()`, so scenarios that assert on a response also `drain()`.
 *   2. Element ids are INDEX-BASED and only valid for the current render, which
 *      is the code's own contract. Every lookup below is therefore done fresh
 *      through `getElementById` after the mutation, never cached across one.
 *
 * The unit tests for the same ticket are in
 * `tests/unit/task-060-comma-separated-job-fields.test.js`.
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

const { handler } = await import('../../src/lambda/calendar/index.mjs');
const settings = await import('../../src/lambda/calendar/frontend/settings.js');
const { loadDocument, findElements, textOf, walk } = await import('../helpers/fake-dom.mjs');
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

/** One complete, valid processing job in the post-TASK-059 shape. */
const job = (overrides = {}) => ({
  id: 'job-1',
  name: 'Ashfield',
  schoolName: 'Ashfield Public School',
  domains: ['ashfield-p.schools.nsw.edu.au'],
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
    settingsPutStatus: 200,
    /** When null, a PUT echoes the stored settings back. */
    settingsPutBody: null,
    scheduleStatus: 200,
    scheduleBody: { available: true },
    /** Called just before a PUT answers - the "while the request is in flight" hook. */
    onSettingsPut: null,
    ...overrides,
  };

  world.settingsBody = () => ({
    connectionStatus: 'connected',
    email: 'parent@example.test',
    lastScanStatus: 'ok',
    processingJobs: world.processingJobs,
    scheduleEnabled: false,
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

    if (requestPath === SETTINGS_PATH) {
      if (method === 'PUT') {
        if (typeof world.onSettingsPut === 'function') await world.onSettingsPut();
        if (world.settingsPutBody !== null) return reply(world.settingsPutStatus, world.settingsPutBody);
        // A 200 STORES what it was sent and echoes the new projection back, as
        // the real route does - otherwise a successful save would re-render the
        // rows from a stale fixture and the row under test would vanish.
        if (world.settingsPutStatus === 200) {
          const sent = world.calls.at(-1).body?.processingJobs;
          world.processingJobs = (Array.isArray(sent) ? sent : []).map((entry, index) => ({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `srv-${index}`,
            ...entry,
          }));
        }
        return reply(world.settingsPutStatus, world.settingsBody());
      }
      return reply(200, world.settingsBody());
    }
    if (requestPath === SCHEDULE_PATH) return reply(world.scheduleStatus, world.scheduleBody);

    throw new Error(`the page requested a route the world does not know: ${method} ${full}`);
  };

  return world;
}

/* --- The Background steps ------------------------------------------------ */

/** Given I am signed in with Gmail connected, and I am on the settings page. */
async function givenTheSettingsPageHasLoaded(world) {
  const doc = loadDocument(SETTINGS_HTML);
  const page = settings.createSettingsPage({
    document: doc,
    fetchImpl: world.fetchImpl,
    detectTimezone: () => 'Australia/Sydney',
  });
  await page.start();
  await drain();
  // And the settings body is visible.
  assert.equal(doc.getElementById('settings-body').hidden, false, 'the settings body never became visible');
  return { doc, page };
}

/* --- The When / Then steps ----------------------------------------------- */

/** "When I type V into the <field> field of job <i>". */
function type(doc, id, value) {
  const node = doc.getElementById(id);
  assert.notEqual(node, null, `there is no input with id "${id}" to type into`);
  node.value = value;
}

/** "When I press <button>" - a real click on the node currently rendered. */
async function press(doc, id) {
  const node = doc.getElementById(id);
  assert.notEqual(node, null, `there is no element with id "${id}" to press`);
  await node.dispatch('click');
  await drain();
}

/** "When I press Save settings". */
async function pressSave(doc) {
  await doc.getElementById('settings-form').dispatch('submit');
  await drain();
}

const jobBlocks = (doc) => doc.getElementById('processing-jobs').querySelectorAll('.job');
const valueOf = (doc, id) => doc.getElementById(id)?.value;
const isHidden = (doc, id) => doc.getElementById(id)?.hidden;
const settingsPuts = (world) => world.calls.filter((call) => call.method === 'PUT' && call.path === SETTINGS_PATH);
const lastPutJobs = (world) => settingsPuts(world).at(-1).body.processingJobs;

/** "Given I have added a processing job" whose required fields are filled. */
async function givenAValidAddedJob(world) {
  const { doc, page } = await givenTheSettingsPageHasLoaded(world);
  await press(doc, 'add-processing-job');
  type(doc, 'job-0-name', 'Ashfield');
  type(doc, 'job-0-schoolName', 'Ashfield Public School');
  return { doc, page };
}

/* =========================================================================
 * Feature: Comma-separated domains and search terms in the processing job editor
 *
 *   As a parent setting up a processing job
 *   I want to type several domains and several search terms as one
 *   comma-separated field each
 *   So that I do not have to add and remove one row per search term
 * ========================================================================= */

describe('Feature: Comma-separated domains and search terms in the processing job editor', () => {
  /* --- A: the shared helper pair ---------------------------------------- */

  describe('Scenario: Entering multiple comma-separated domains and search terms and saving', () => {
    it('Given an added job, When both list fields are typed and saved, Then both are sent as lists', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      // Given I have added a processing job
      await press(doc, 'add-processing-job');

      // When I type ... into each field of job 0
      type(doc, 'job-0-name', 'Ashfield');
      type(doc, 'job-0-schoolName', 'Ashfield Public School');
      type(doc, 'job-0-domains', 'ashfield-p.schools.nsw.edu.au, ashfieldpandc.org.au');
      type(doc, 'job-0-searchTerms', 'canteen, uniform shop, working bee');

      // And I press Save settings
      await pressSave(doc);

      // Then the request body's processingJobs[0].domains is exactly [...]
      const sent = lastPutJobs(world)[0];
      assert.deepEqual(sent.domains, ['ashfield-p.schools.nsw.edu.au', 'ashfieldpandc.org.au']);
      assert.deepEqual(sent.searchTerms, ['canteen', 'uniform shop', 'working bee']);

      // And the request body carries no "domain" key on any job
      for (const entry of lastPutJobs(world)) {
        assert.equal('domain' in entry, false, 'a superseded singular domain key was sent');
      }

      // And the status line reads "Saved."
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });
  });

  describe('Scenario Outline: Sloppy comma and whitespace input is tolerated, not rejected', () => {
    for (const [typed, parsed] of [
      ['a.edu.au, b.edu.au,', ['a.edu.au', 'b.edu.au']],
      ['a.edu.au,,b.edu.au', ['a.edu.au', 'b.edu.au']],
      [',a.edu.au', ['a.edu.au']],
      ['  a.edu.au  ,  b.edu.au  ', ['a.edu.au', 'b.edu.au']],
      ['a.edu.au, , ,b.edu.au', ['a.edu.au', 'b.edu.au']],
    ]) {
      it(`Given job 0 is valid, When I type "${typed}" into the email domains field, Then ${JSON.stringify(parsed)} is sent`, async () => {
        const world = makeWorld({ processingJobs: [] });
        const { doc } = await givenAValidAddedJob(world);

        type(doc, 'job-0-domains', typed);
        await pressSave(doc);

        assert.deepEqual(lastPutJobs(world)[0].domains, parsed);
        // And no field error is shown for job 0.
        for (const key of ['name', 'schoolName', 'domains', 'searchTerms']) {
          assert.equal(isHidden(doc, `error-job-0-${key}`), true, `error-job-0-${key} was shown`);
        }
        assert.equal(isHidden(doc, 'error-form'), true);
      });
    }
  });

  describe('Scenario: Duplicates are not collapsed on the client', () => {
    it('Given a valid job, When the same domain is typed twice, Then both are sent for the server to collapse', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      type(doc, 'job-0-domains', 'a.edu.au, a.edu.au');
      await pressSave(doc);

      assert.deepEqual(lastPutJobs(world)[0].domains, ['a.edu.au', 'a.edu.au']);
      // And the server is left to collapse the duplicate: nothing client-side
      // refused it, and the save went through.
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });
  });

  /* --- C, D: rendering a stored job ------------------------------------- */

  describe('Scenario: An existing job with several domains renders as one comma-joined value', () => {
    it('Given a stored job with two domains and two terms, When the page loads, Then each is one joined field', async () => {
      const world = makeWorld({
        processingJobs: [
          job({
            name: 'Ashfield',
            domains: ['ashfield-p.schools.nsw.edu.au', 'ashfieldpandc.org.au'],
            searchTerms: ['canteen', 'uniform shop'],
          }),
        ],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      assert.equal(valueOf(doc, 'job-0-domains'), 'ashfield-p.schools.nsw.edu.au, ashfieldpandc.org.au');
      assert.equal(valueOf(doc, 'job-0-searchTerms'), 'canteen, uniform shop');

      // And exactly one search terms input is rendered for job 0.
      const container = doc.getElementById('processing-jobs');
      assert.equal(container.querySelectorAll('#job-0-searchTerms').length, 1);
      assert.equal(container.querySelectorAll('#job-0-domains').length, 1);
      // Four fields on the row, no more: name, schoolName, domains, searchTerms.
      assert.equal(findElements(container, 'input').length, 4);

      // And no element on the page has the class "job__term".
      assert.deepEqual(container.querySelectorAll('.job__term'), []);
      assert.deepEqual(container.querySelectorAll('.job__terms'), []);

      // And no "Add search term" button is on the page.
      assert.equal(doc.getElementById('add-term-0'), null);
      const buttonText = findElements(container, 'button').map((node) => textOf(node));
      assert.equal(buttonText.includes('Add search term'), false, 'the Add search term button survived');
      assert.equal(buttonText.includes('Remove term'), false, 'a Remove term button survived');
      assert.deepEqual(buttonText, ['Remove job']);
    });
  });

  describe('Scenario: A stored job with no domains renders an empty field rather than failing', () => {
    it('Given a stored job with no domains attribute, When the page loads, Then the field is empty and the row is intact', async () => {
      const world = makeWorld({
        processingJobs: [{ id: 'job-1', name: 'Ashfield', schoolName: 'Ashfield Public School', searchTerms: [] }],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      assert.equal(valueOf(doc, 'job-0-domains'), '');
      // And the job row is still rendered with its name and school name fields.
      assert.equal(jobBlocks(doc).length, 1);
      assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield');
      assert.equal(valueOf(doc, 'job-0-schoolName'), 'Ashfield Public School');
      assert.notEqual(doc.getElementById('job-0-searchTerms'), null);
      assert.equal(isHidden(doc, 'processing-jobs-empty'), true);
    });
  });

  describe('Scenario: A stored value that is not a list is tolerated', () => {
    for (const [label, stored] of [
      ['the string "a.edu.au"', 'a.edu.au'],
      ['a number', 42],
      ['null', null],
      ['an object', { 0: 'a.edu.au' }],
    ]) {
      it(`Given a stored job whose domains attribute is ${label}, When the page loads, Then the field is empty and nothing throws`, async () => {
        const world = makeWorld({
          processingJobs: [job({ domains: stored, searchTerms: stored })],
        });
        const { doc } = await givenTheSettingsPageHasLoaded(world);

        assert.equal(valueOf(doc, 'job-0-domains'), '');
        assert.equal(valueOf(doc, 'job-0-searchTerms'), '');
        // And the page renders without throwing - the row and the form are there.
        assert.equal(jobBlocks(doc).length, 1);
        assert.equal(isHidden(doc, 'settings-body'), false, 'a malformed value left the page unusable');
      });
    }
  });

  /* --- B: the term row editor is gone ----------------------------------- */

  describe('Scenario: The per-term row editor no longer exists', () => {
    it('Given a stored job with three search terms, When the page loads, Then no term-row structure exists', async () => {
      const world = makeWorld({ processingJobs: [job({ searchTerms: ['canteen', 'fete', 'disco'] })] });
      const { doc, page } = await givenTheSettingsPageHasLoaded(world);

      // Then no element on the page carries a "data-term-index" attribute.
      assert.deepEqual(doc.querySelectorAll('[data-term-index]'), []);
      // And no element has an id matching "job-0-term-0" / "add-term-0".
      assert.equal(doc.getElementById('job-0-term-0'), null);
      assert.equal(doc.getElementById('add-term-0'), null);
      assert.equal(doc.getElementById('remove-job-0-term-0'), null);
      assert.equal(doc.getElementById('job-0-terms'), null);
      assert.equal(doc.getElementById('job-0-terms-label'), null);

      // No <ul>/<li> is built inside the container at all.
      const built = new Set();
      walk(doc.getElementById('processing-jobs'), (node) => built.add(node.tagName), false);
      assert.equal(built.has('UL'), false);
      assert.equal(built.has('LI'), false);

      // And the controller does not expose addTerm / removeTerm.
      assert.equal(page.addTerm, undefined);
      assert.equal(page.removeTerm, undefined);

      // The three terms are all still there - as one field.
      assert.equal(valueOf(doc, 'job-0-searchTerms'), 'canteen, fete, disco');
    });
  });

  describe('Scenario: Removing a job still works after the term rows are gone', () => {
    it('Given two stored jobs, When job 1 is removed and confirmed, Then one row remains and nothing was sent', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'Ashfield' }), job({ id: 'job-2', name: 'St Marys' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);
      const before = world.calls.length;

      await press(doc, 'remove-job-1');
      // Nothing has happened yet - the acting control did not exist until now.
      assert.equal(jobBlocks(doc).length, 2, 'arming a removal removed the job');
      assert.match(textOf(doc.getElementById('job-1-confirm')), /Remove St Marys\?/);

      await press(doc, 'confirm-remove-job-1');

      // Then only one job row is rendered.
      assert.equal(jobBlocks(doc).length, 1);
      assert.equal(valueOf(doc, 'job-0-name'), 'Ashfield');
      // And nothing has been sent to the server yet.
      assert.equal(world.calls.length, before, 'a removal reached the network before Save');
      assert.equal(settingsPuts(world).length, 0);
    });
  });

  /* --- E: server error routing ------------------------------------------ */

  describe("Scenario: A server-side domains validation error routes to the right job's slot", () => {
    it('Given two jobs, When the server 400s on processingJobs[1].domains, Then error-job-1-domains carries it', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'Ashfield' }), job({ id: 'job-2', name: 'St Marys' })],
      });
      world.settingsPutStatus = 400;
      world.settingsPutBody = {
        error: 'gmail.com is a public mail provider',
        field: 'processingJobs[1].domains',
      };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-1-domains', 'gmail.com');
      await pressSave(doc);

      assert.equal(isHidden(doc, 'error-job-1-domains'), false, 'the named slot stayed hidden');
      assert.equal(textOf(doc.getElementById('error-job-1-domains')), 'gmail.com is a public mail provider');
      assert.equal(isHidden(doc, 'error-job-0-domains'), true, 'the error also landed on the wrong row');
      assert.equal(isHidden(doc, 'error-form'), true, 'the form-level line was shown as well');
      assert.equal(
        textOf(doc.getElementById('settings-status')),
        'Nothing was saved - please fix the highlighted field.'
      );
      // A refused settings save never goes on to write the schedule.
      assert.equal(world.calls.some((call) => call.path === SCHEDULE_PATH), false);
    });
  });

  describe("Scenario: A server-side search terms error routes to that job's search terms slot", () => {
    it('Given one job, When the server 400s on processingJobs[0].searchTerms, Then error-job-0-searchTerms carries it', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      world.settingsPutStatus = 400;
      world.settingsPutBody = {
        error: 'Enter at most 20 search terms for one processing job',
        field: 'processingJobs[0].searchTerms',
      };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await pressSave(doc);

      assert.equal(isHidden(doc, 'error-job-0-searchTerms'), false);
      assert.equal(
        textOf(doc.getElementById('error-job-0-searchTerms')),
        'Enter at most 20 search terms for one processing job'
      );
      assert.equal(isHidden(doc, 'error-form'), true);
    });
  });

  describe('Scenario: The retired singular field name fails closed to the form line', () => {
    it('Given one job, When the server 400s on processingJobs[0].domain, Then the form-level line carries it', async () => {
      const world = makeWorld({ processingJobs: [job()] });
      world.settingsPutStatus = 400;
      world.settingsPutBody = { error: 'That domain is not accepted', field: 'processingJobs[0].domain' };
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await pressSave(doc);

      // Then no error slot named "error-job-0-domain" is on the page.
      assert.equal(doc.getElementById('error-job-0-domain'), null);
      // And the form-level error line is visible and reads the server's words.
      assert.equal(isHidden(doc, 'error-form'), false);
      assert.equal(textOf(doc.getElementById('error-form')), 'That domain is not accepted');
      // The renamed slot stays hidden - the message did not leak into it.
      assert.equal(isHidden(doc, 'error-job-0-domains'), true);
    });
  });

  describe('Scenario: A 400 naming a row the user has since removed falls back to the form line', () => {
    it('Given three jobs, When job 2 is removed while the request is in flight, Then the form line carries the error', async () => {
      const world = makeWorld({
        processingJobs: [
          job({ id: 'job-1', name: 'A' }),
          job({ id: 'job-2', name: 'B' }),
          job({ id: 'job-3', name: 'C' }),
        ],
      });
      world.settingsPutStatus = 400;
      world.settingsPutBody = { error: 'That domain is not accepted', field: 'processingJobs[2].domains' };
      const { doc, page } = await givenTheSettingsPageHasLoaded(world);
      assert.equal(jobBlocks(doc).length, 3);

      // The removal happens WHILE the PUT is in flight, before it answers.
      world.onSettingsPut = () => {
        page.armRemoveJob(2);
        page.confirmRemoveJob(2);
        world.onSettingsPut = null;
      };
      await pressSave(doc);

      assert.equal(jobBlocks(doc).length, 2, 'the in-flight removal did not take effect');
      assert.equal(doc.getElementById('error-job-2-domains'), null, 'the named slot still exists');
      assert.equal(isHidden(doc, 'error-form'), false);
      assert.equal(textOf(doc.getElementById('error-form')), 'That domain is not accepted');
    });
  });

  describe('Scenario: A hostile field name is never interpolated into an element lookup', () => {
    for (const hostile of [
      'processingJobs[abc].domains',
      'processingJobs[-1].domains',
      'processingJobs[0].__proto__',
      'processingJobs[0].domains.evil',
      'error-form',
    ]) {
      it(`Given one job, When the server 400s with field "${hostile}", Then the form-level line carries it`, async () => {
        const world = makeWorld({ processingJobs: [job()] });
        world.settingsPutStatus = 400;
        world.settingsPutBody = { error: 'Nope', field: hostile };
        const { doc } = await givenTheSettingsPageHasLoaded(world);

        await pressSave(doc);

        assert.equal(isHidden(doc, 'error-form'), false, hostile);
        assert.equal(textOf(doc.getElementById('error-form')), 'Nope');
        assert.equal(isHidden(doc, 'error-job-0-domains'), true);
        assert.equal(isHidden(doc, 'error-job-0-searchTerms'), true);
      });
    }
  });

  /* --- F4: domains is optional - saving with none is not a client error -- */

  describe('Scenario: Saving a job with no domains at all succeeds client-side', () => {
    it('Given a valid job, When the domains field is left empty and saved, Then a request IS sent with []', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      // When I leave the email domains field of job 0 empty
      assert.equal(valueOf(doc, 'job-0-domains'), '');

      // No error slot for job 0 is shown before the response arrives, either.
      for (const key of ['name', 'schoolName', 'domains', 'searchTerms']) {
        assert.equal(isHidden(doc, `error-job-0-${key}`), true);
      }

      await pressSave(doc);

      assert.equal(settingsPuts(world).length, 1, 'no request was sent to the settings API');
      assert.deepEqual(lastPutJobs(world)[0].domains, []);
      assert.equal(isHidden(doc, 'error-job-0-domains'), true, 'a domains error was invented client-side');
      assert.equal(textOf(doc.getElementById('settings-status')), 'Saved.');
    });
  });

  describe('Scenario: A domains field holding only commas and spaces is sent as an empty list', () => {
    it('Given a valid job, When " , , " is typed into the domains field and saved, Then [] is sent', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      type(doc, 'job-0-domains', ' , , ');
      await pressSave(doc);

      assert.equal(settingsPuts(world).length, 1, 'no request was sent to the settings API');
      assert.deepEqual(lastPutJobs(world)[0].domains, []);
      assert.equal(isHidden(doc, 'error-job-0-domains'), true);
    });
  });

  describe('Scenario: A missing school name is still reported, independent of domains', () => {
    it('Given a job with a name but no school name, When saved with empty domains, Then nothing is sent', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      await press(doc, 'add-processing-job');
      type(doc, 'job-0-name', 'Ashfield');
      type(doc, 'job-0-schoolName', '');
      type(doc, 'job-0-domains', '');
      await pressSave(doc);

      assert.equal(isHidden(doc, 'error-job-0-schoolName'), false);
      assert.match(textOf(doc.getElementById('error-job-0-schoolName')), /school name is required/i);
      assert.equal(settingsPuts(world).length, 0, 'a client-rejected save still cost a round trip');
      // And the domains slot is NOT what was flagged.
      assert.equal(isHidden(doc, 'error-job-0-domains'), true);
      // One bad save must not lock the form.
      assert.equal(doc.getElementById('save-settings').disabled, false);
    });
  });

  /* --- F3: the client never over-refuses -------------------------------- */

  describe('Scenario: An invalid-looking domain is still sent for the server to judge', () => {
    it('Given a valid job, When "not a domain at all" is typed, Then it is sent verbatim as one entry', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      type(doc, 'job-0-domains', 'not a domain at all');
      await pressSave(doc);

      assert.equal(settingsPuts(world).length, 1, 'the client refused a value the server may have accepted');
      assert.deepEqual(lastPutJobs(world)[0].domains, ['not a domain at all']);
    });
  });

  describe('Scenario: Whitespace is not a delimiter', () => {
    it('Given a valid job, When "a.edu.au b.edu.au" is typed, Then it is sent as ONE entry', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      type(doc, 'job-0-domains', 'a.edu.au b.edu.au');
      await pressSave(doc);

      assert.deepEqual(lastPutJobs(world)[0].domains, ['a.edu.au b.edu.au']);
    });

    it('And a semicolon is not a delimiter either', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      type(doc, 'job-0-searchTerms', 'canteen;fete');
      await pressSave(doc);

      assert.deepEqual(lastPutJobs(world)[0].searchTerms, ['canteen;fete']);
    });
  });

  describe('Scenario: Twenty-one search terms are sent, not refused locally', () => {
    it('Given a valid job, When 21 comma-separated terms are typed, Then all 21 are sent for the server to cap', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc } = await givenAValidAddedJob(world);

      const terms = Array.from({ length: 21 }, (_, index) => `term ${index}`);
      type(doc, 'job-0-searchTerms', terms.join(', '));
      await pressSave(doc);

      assert.equal(settingsPuts(world).length, 1, 'the client enforced the search-term cap itself');
      assert.equal(lastPutJobs(world)[0].searchTerms.length, 21);
      assert.deepEqual(lastPutJobs(world)[0].searchTerms, terms);
    });
  });

  /* --- J3: re-render normalisation --------------------------------------- */

  describe('Scenario: Adding another job normalises the in-progress text without losing it', () => {
    it('Given "a.edu.au, b.edu.au," typed into job 0, When another job is added, Then the trailing comma is dropped', async () => {
      const world = makeWorld({ processingJobs: [] });
      const { doc, page } = await givenTheSettingsPageHasLoaded(world);

      await press(doc, 'add-processing-job');
      type(doc, 'job-0-domains', 'a.edu.au, b.edu.au,');
      await press(doc, 'add-processing-job');

      // Then the email domains field of job 0 holds "a.edu.au, b.edu.au".
      assert.equal(valueOf(doc, 'job-0-domains'), 'a.edu.au, b.edu.au');
      // And a second, empty job row is rendered.
      assert.equal(jobBlocks(doc).length, 2);
      assert.equal(valueOf(doc, 'job-1-name'), '');
      assert.equal(valueOf(doc, 'job-1-domains'), '');
      assert.equal(valueOf(doc, 'job-1-searchTerms'), '');
      // And the caret is in the name field of job 1.
      assert.equal(page.state.focusFieldId, 'job-1-name');
    });
  });

  describe('Scenario: Unsaved typing in both fields survives a structural change', () => {
    it('Given typing in both list fields of job 0, When job 1 is armed and cancelled, Then both still read back', async () => {
      const world = makeWorld({
        processingJobs: [job({ id: 'job-1', name: 'A' }), job({ id: 'job-2', name: 'B' })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      type(doc, 'job-0-domains', 'x.edu.au, y.edu.au');
      type(doc, 'job-0-searchTerms', 'fete, disco');

      await press(doc, 'remove-job-1');
      await press(doc, 'cancel-remove-job-1');

      assert.equal(valueOf(doc, 'job-0-domains'), 'x.edu.au, y.edu.au');
      assert.equal(valueOf(doc, 'job-0-searchTerms'), 'fete, disco');
      assert.equal(jobBlocks(doc).length, 2, 'a cancelled removal changed the list');
    });
  });

  /* --- Safety ------------------------------------------------------------ */

  describe('Scenario: A hostile stored value reaches the field as literal characters', () => {
    it('Given a stored term of "<img ...>", When the page loads, Then it is character data and no IMG exists', async () => {
      const world = makeWorld({
        processingJobs: [job({ searchTerms: [XSS, 'canteen'], domains: ['<script>alert(1)</script>'] })],
      });
      const { doc } = await givenTheSettingsPageHasLoaded(world);

      // Then the search terms field of job 0 holds the literal characters.
      assert.equal(valueOf(doc, 'job-0-searchTerms'), `${XSS}, canteen`);
      assert.equal(valueOf(doc, 'job-0-domains'), '<script>alert(1)</script>');

      // And no img element exists inside the processing jobs container.
      const container = doc.getElementById('processing-jobs');
      assert.deepEqual(findElements(container, 'img'), [], 'an IMG was created from a stored search term');
      assert.deepEqual(findElements(container, 'script'), [], 'a SCRIPT was created from a stored domain');
      assert.deepEqual(findElements(doc, 'img'), [], 'an IMG was created anywhere on the page');

      // And it round-trips back out as the same two entries.
      await pressSave(doc);
      assert.deepEqual(lastPutJobs(world)[0].searchTerms, [XSS, 'canteen']);
    });

    it('And settings.js, as SERVED, contains no innerHTML property access', async () => {
      const response = await handler(albEvent('/calendar/settings.js'), {}, {});
      assert.equal(response.statusCode, 200);
      const served = response.body;
      assert.deepEqual(served.match(/\.innerHTML/g) || [], []);
      assert.deepEqual(served.match(/\.outerHTML/g) || [], []);
      assert.deepEqual(served.match(/\.insertAdjacentHTML\(/g) || [], []);
      assert.deepEqual(served.match(/document\.write/g) || [], []);
      assert.deepEqual(served.match(/createContextualFragment/g) || [], []);
      // The helpers this ticket added are in the bytes actually shipped.
      assert.match(served, /export function splitCommaList/);
      assert.match(served, /export function joinCommaList/);
      assert.equal(served.includes('termsBlock'), false, 'the removed builder is still being served');
    });
  });
});

/* =========================================================================
 * Feature: the served assets reflect the simplified editor
 * ========================================================================= */

describe('Feature: The simplified job editor is what the Lambda serves', () => {
  /** The bytes the Lambda actually serves, not a file read behind its back. */
  async function served(route) {
    const response = await handler(albEvent(route), {}, {});
    assert.equal(response.statusCode, 200, route);
    return response.body;
  }

  describe('Scenario: The term-row stylesheet rules are gone from the served CSS', () => {
    it('Given the served styles.css, Then .job__terms and .job__term have no rule, and .job still does', async () => {
      const stylesheet = await served('/calendar/styles.css');
      const outside = css.outsideMediaQueries(stylesheet);

      for (const dead of ['.job__terms', '.job__term']) {
        assert.deepEqual(css.rulesFor(outside, dead), [], `${dead} is still served`);
      }
      assert.equal(/\.job__terms?\b/.test(stylesheet), false, 'a term class survived in the served bytes');

      // And the surviving job rules are untouched.
      for (const selector of ['.jobs', '.job', '.job__head', '.job__actions', '.job__confirm']) {
        assert.ok(css.rulesFor(outside, selector).length >= 1, `${selector} went missing`);
      }
      assert.equal(css.declaredValue(outside, '.job', 'display'), 'grid');
      assert.equal(css.declaredValue(outside, '.btn-small', 'min-height'), '44px');
      assert.equal(css.declaredValue(outside, '.field-input', 'font'), 'inherit');
    });
  });

  describe('Scenario: The served settings.html explains commas and keeps the gmail.com warning', () => {
    it('Given the served settings.html, Then the intro hint tells the user commas separate values', async () => {
      const markup = await served('/calendar/settings.html');
      const doc = loadDocument(SETTINGS_HTML);

      const hints = findElements(doc.getElementById('settings-form'), 'p')
        .filter((node) => node.className === 'field-hint')
        .map((node) => textOf(node));
      const intro = hints.find((text) => /comma/i.test(text));
      assert.ok(intro, `no served hint mentions commas, saw: ${hints.join(' | ')}`);
      assert.match(intro, /optional/i, 'the hint does not say domains are optional');
      assert.match(intro, /gmail\.com/, 'the public mail provider warning was dropped');

      // And no per-job field markup was baked into the static page.
      assert.equal(markup.includes('Extra search terms'), false);
      assert.equal(markup.includes('id="job-0-domains"'), false);
      assert.equal(doc.getElementById('processing-jobs').children.length, 0);
    });
  });
});
