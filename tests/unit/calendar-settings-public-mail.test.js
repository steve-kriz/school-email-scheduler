/**
 * calendar-settings-public-mail.test.js - the public-mail blocklist (TASK-032).
 *
 * Two controls are under test, and they are tested separately on purpose:
 *
 *   1. PUBLIC_MAIL_DOMAINS, an exact-match host list. Every entry is pinned
 *      INDIVIDUALLY, by a literal expectation written out in this file rather than
 *      by iterating the export. Iterating the export cannot pin anything: delete an
 *      entry and the loop simply runs one time fewer, still green. This project has
 *      already shipped an unpinned word list that way (2 of the 23 CREATE_VERB
 *      branches in tests/e2e/check-oauth-config.test.js), so the expectation is
 *      duplicated here deliberately - if this file and the module disagree, that is
 *      the test doing its job.
 *
 *   2. PUBLIC_MAIL_BRANDS, the brand check, which refuses a provider brand under
 *      ANY public suffix. Each brand is driven through the ".example" suffix, which
 *      appears in no exact-list entry, so a green brand test cannot be an
 *      exact-list match in disguise - each test asserts that too.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  validateSearchDomains,
  registrableName,
  isPublicMailDomain,
  PUBLIC_MAIL_DOMAINS,
  PUBLIC_MAIL_BRANDS,
  SettingsValidationError,
} from '../../src/lambda/calendar/backend/settings.mjs';

/**
 * Every host the blocklist must carry, written out literally.
 * Keep in step with PUBLIC_MAIL_DOMAINS; the completeness test below enforces it.
 */
const EXPECTED_PUBLIC_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.com.au',
  'outlook.co.uk',
  'hotmail.com',
  'hotmail.com.au',
  'hotmail.co.uk',
  'hotmail.fr',
  'live.com',
  'live.com.au',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.com.au',
  'yahoo.co.uk',
  'yahoo.ca',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'tutanota.com',
];

/** Every provider brand the brand check must know, written out literally. */
const EXPECTED_PUBLIC_MAIL_BRANDS = [
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'yahoo',
  'ymail',
  'rocketmail',
  'aol',
  'icloud',
  'me',
  'mac',
  'proton',
  'protonmail',
  'gmx',
  'mail',
  'zoho',
  'yandex',
  'qq',
];

/**
 * Drive the real validator and return the error it threw, asserting the shape the
 * API contract depends on: a 400 against the searchDomains field, naming the
 * offending domain so the user can see which entry was refused.
 */
function refusal(domain) {
  let error = null;
  try {
    validateSearchDomains([domain]);
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${domain} should have been refused`);
  assert.ok(error instanceof SettingsValidationError, `${domain}: wrong error type`);
  assert.equal(error.statusCode, 400, `${domain}: wrong status`);
  assert.equal(error.field, 'searchDomains', `${domain}: wrong field`);
  assert.ok(
    error.message.includes(domain),
    `${domain}: message must name the domain, got "${error.message}"`
  );
  return error;
}

describe('Public mail blocklist (TASK-032)', () => {
  describe('PUBLIC_MAIL_DOMAINS - every entry pinned individually', () => {
    for (const host of EXPECTED_PUBLIC_MAIL_DOMAINS) {
      it(`should list and refuse ${host}`, () => {
        // Pins the ENTRY: removing it from the module reddens this assertion even
        // though the brand check would still refuse some of these hosts.
        assert.ok(
          PUBLIC_MAIL_DOMAINS.includes(host),
          `${host} is missing from PUBLIC_MAIL_DOMAINS`
        );
        assert.equal(isPublicMailDomain(host), true, `${host} should be a public mail domain`);
        refusal(host);
      });
    }

    it('should carry no entry that is not pinned above', () => {
      const unexpected = PUBLIC_MAIL_DOMAINS.filter(
        (host) => !EXPECTED_PUBLIC_MAIL_DOMAINS.includes(host)
      );
      assert.deepEqual(
        unexpected,
        [],
        'new blocklist entries need their own pinned test in this file'
      );
      assert.equal(PUBLIC_MAIL_DOMAINS.length, EXPECTED_PUBLIC_MAIL_DOMAINS.length);
    });

    it('should still refuse the six originally-blocked hosts', () => {
      for (const host of [
        'gmail.com',
        'googlemail.com',
        'outlook.com',
        'hotmail.com',
        'yahoo.com',
        'icloud.com',
      ]) {
        refusal(host);
      }
    });

    it('should refuse the ten consumer hosts TASK-032 found passing', () => {
      const missed = [
        'outlook.com.au',
        'yahoo.com.au',
        'hotmail.co.uk',
        'yahoo.co.uk',
        'live.com',
        'aol.com',
        'me.com',
        'proton.me',
        'gmx.com',
        'mail.com',
      ];
      for (const host of missed) refusal(host);
    });

    it('should refuse the Australian regional forms an AU user would type', () => {
      // The deployment is the au tenant, so these are the likeliest mistakes.
      for (const host of ['outlook.com.au', 'yahoo.com.au', 'hotmail.com.au', 'live.com.au']) {
        refusal(host);
      }
    });
  });

  describe('PUBLIC_MAIL_BRANDS - every brand pinned individually', () => {
    for (const brand of EXPECTED_PUBLIC_MAIL_BRANDS) {
      it(`should refuse the ${brand} brand under an unlisted suffix`, () => {
        const host = `${brand}.example`;
        // Proves the refusal came from the BRAND check, not the exact-match list.
        assert.ok(
          !PUBLIC_MAIL_DOMAINS.includes(host),
          `${host} is in PUBLIC_MAIL_DOMAINS, so this test no longer covers the brand check`
        );
        assert.ok(
          PUBLIC_MAIL_BRANDS.includes(brand),
          `${brand} is missing from PUBLIC_MAIL_BRANDS`
        );
        refusal(host);
      });
    }

    it('should carry no brand that is not pinned above', () => {
      const unexpected = PUBLIC_MAIL_BRANDS.filter(
        (brand) => !EXPECTED_PUBLIC_MAIL_BRANDS.includes(brand)
      );
      assert.deepEqual(unexpected, [], 'new brands need their own pinned test in this file');
      assert.equal(PUBLIC_MAIL_BRANDS.length, EXPECTED_PUBLIC_MAIL_BRANDS.length);
    });

    it('should refuse a known brand under a public suffix nobody listed', () => {
      // The point of the brand check: neither host is in PUBLIC_MAIL_DOMAINS.
      for (const host of ['hotmail.com.br', 'yahoo.example']) {
        assert.ok(!PUBLIC_MAIL_DOMAINS.includes(host), `${host} must not be listed`);
        refusal(host);
      }
    });

    it('should refuse a brand under a two-label ccTLD suffix it was never listed under', () => {
      for (const host of ['gmail.com.br', 'outlook.co.nz', 'yahoo.net.au']) {
        assert.ok(!PUBLIC_MAIL_DOMAINS.includes(host), `${host} must not be listed`);
        refusal(host);
      }
    });
  });

  describe('the "mail" brand: registrable name vs subdomain label', () => {
    it('should refuse mail.com, where "mail" IS the registered name', () => {
      refusal('mail.com');
    });

    it('should accept mail.stmarys.edu.au, where "mail" is only a subdomain label', () => {
      // The case a future reader is most likely to break: a school putting "mail"
      // in front of its own name is ordinary, and must stay accepted.
      assert.deepEqual(validateSearchDomains(['mail.stmarys.edu.au']), ['mail.stmarys.edu.au']);
      assert.equal(isPublicMailDomain('mail.stmarys.edu.au'), false);
    });

    it('should accept other provider words used as a subdomain of a school domain', () => {
      for (const host of ['me.stmarys.edu.au', 'live.stmarys.edu.au', 'mac.stmarys.nsw.edu.au']) {
        assert.deepEqual(validateSearchDomains([host]), [host]);
      }
    });
  });

  describe('mail.gmail.com stays allowed (behaviour unchanged)', () => {
    it('should accept mail.gmail.com, because the concern is the shared public host itself', () => {
      // Intentional, in both the exact-match list and the brand check: a school
      // could legitimately be hosted on a subdomain, and the exact-match rule has
      // never been a suffix match. Do not "fix" this into a rejection.
      assert.deepEqual(validateSearchDomains(['mail.gmail.com']), ['mail.gmail.com']);
      assert.equal(isPublicMailDomain('mail.gmail.com'), false);
    });

    it('should accept other subdomains of a blocked host', () => {
      for (const host of ['mail.outlook.com', 'newsletter.yahoo.com.au']) {
        assert.deepEqual(validateSearchDomains([host]), [host]);
      }
    });
  });

  describe('genuine school domains are unaffected', () => {
    const schools = [
      'stmarys.edu.au',
      'stmarys.nsw.edu.au',
      'stmarys.catholic.edu.au',
      'example.act.edu.au',
      'stmarys.com',
      'stmarys.com.au',
      'st-marys.edu.au',
      'pandc.org.au',
      'schoolzine.com.au',
      'sentral.com.au',
    ];

    for (const host of schools) {
      it(`should accept ${host}`, () => {
        assert.equal(isPublicMailDomain(host), false);
        assert.deepEqual(validateSearchDomains([host]), [host]);
      });
    }

    it('should accept a full school list in one save', () => {
      assert.deepEqual(
        validateSearchDomains(['stmarys.edu.au', 'pandc.org.au', 'mail.stmarys.edu.au']),
        ['stmarys.edu.au', 'pandc.org.au', 'mail.stmarys.edu.au']
      );
    });
  });

  describe('normalisation still feeds the blocklist', () => {
    it('should refuse a blocked host however it was pasted', () => {
      const forms = [
        'OUTLOOK.COM.AU',
        ' office@outlook.com.au ',
        'https://outlook.com.au/mail',
        '*.outlook.com.au',
      ];
      for (const raw of forms) {
        let error = null;
        try {
          validateSearchDomains([raw]);
        } catch (err) {
          error = err;
        }
        assert.ok(error, `${raw} should have been refused`);
        assert.equal(error.statusCode, 400);
        assert.equal(error.field, 'searchDomains');
        assert.ok(
          error.message.includes('outlook.com.au'),
          `message should name the normalised host, got "${error.message}"`
        );
      }
    });

    it('should refuse a trailing-dot form as an invalid domain, not as a provider', () => {
      // "gmail.com." has an empty last label, so isValidDomain rejects it first.
      let error = null;
      try {
        validateSearchDomains(['gmail.com.']);
      } catch (err) {
        error = err;
      }
      assert.ok(error);
      assert.equal(error.statusCode, 400);
      assert.ok(error.message.includes('not a valid email domain'));
    });

    it('should name the offending domain and nothing else', () => {
      const error = refusal('me.com');
      assert.ok(!error.message.includes('stmarys'));
    });
  });

  describe('registrableName', () => {
    it('should read a single-label suffix', () => {
      assert.deepEqual(registrableName('mail.com'), { name: 'mail', subdomain: false });
      assert.deepEqual(registrableName('yahoo.example'), { name: 'yahoo', subdomain: false });
    });

    it('should read a two-label ccTLD suffix', () => {
      assert.deepEqual(registrableName('stmarys.edu.au'), { name: 'stmarys', subdomain: false });
      assert.deepEqual(registrableName('hotmail.com.br'), { name: 'hotmail', subdomain: false });
      assert.deepEqual(registrableName('yahoo.co.uk'), { name: 'yahoo', subdomain: false });
    });

    it('should flag a subdomain', () => {
      assert.deepEqual(registrableName('mail.stmarys.edu.au'), { name: 'stmarys', subdomain: true });
      assert.deepEqual(registrableName('mail.gmail.com'), { name: 'gmail', subdomain: true });
    });

    it('should not treat a two-letter ccTLD as a two-label suffix on its own', () => {
      // "proton.me": "proton" is not a registry label, so the suffix is just "me".
      assert.deepEqual(registrableName('proton.me'), { name: 'proton', subdomain: false });
      assert.deepEqual(registrableName('pm.me'), { name: 'pm', subdomain: false });
    });

    it('should return null when there is no registrable name', () => {
      assert.equal(registrableName('com.au'), null);
      assert.equal(registrableName('stmarys'), null);
      assert.equal(registrableName(''), null);
      assert.equal(registrableName(undefined), null);
    });
  });

  describe('isPublicMailDomain', () => {
    it('should be false for non-strings and empty input', () => {
      assert.equal(isPublicMailDomain(''), false);
      assert.equal(isPublicMailDomain(undefined), false);
      assert.equal(isPublicMailDomain(null), false);
      assert.equal(isPublicMailDomain(42), false);
    });

    it('should be true by exact match and true by brand', () => {
      assert.equal(isPublicMailDomain('gmx.de'), true);
      assert.equal(isPublicMailDomain('gmx.example'), true);
    });
  });
});
