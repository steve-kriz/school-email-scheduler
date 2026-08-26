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
  // Australian ISPs and portals (TASK-046)
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'y7mail.com',
  'iinet.net.au',
  'tpg.com.au',
  'internode.on.net',
  'dodo.com.au',
];

/** Every provider brand the brand check must know, written out literally. */
const EXPECTED_PUBLIC_MAIL_BRANDS = [
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'msn',
  'yahoo',
  'ymail',
  'rocketmail',
  'icloud',
  'protonmail',
  'gmx',
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

    it('should refuse the Australian ISP and portal hosts TASK-046 found passing', () => {
      // The highest-probability local miss for this tenant: an Australian parent
      // is more likely to own one of these mailboxes than an "outlook.com.au" one.
      for (const host of [
        'bigpond.com',
        'bigpond.net.au',
        'optusnet.com.au',
        'y7mail.com',
        'iinet.net.au',
        'tpg.com.au',
        'internode.on.net',
        'dodo.com.au',
      ]) {
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

  describe('dictionary-word brands under .edu.au are ACCEPTED (AC: genuine school domains unaffected)', () => {
    // The 7 dictionary-word brands were removed from the any-suffix check and are
    // only blocked at their known exact hosts. So these .edu.au domains (which are not
    // in PUBLIC_MAIL_DOMAINS) must be ACCEPTED to meet the AC.
    const dictionaryWordDomains = [
      'live.edu.au',
      'aol.edu.au',
      'me.edu.au',
      'mac.edu.au',
      'proton.edu.au',
      'mail.edu.au',
      'zoho.edu.au',
    ];

    for (const host of dictionaryWordDomains) {
      it(`should accept ${host} (dictionary-word brand under edu.au suffix)`, () => {
        assert.equal(isPublicMailDomain(host), false, `${host} should be accepted`);
        assert.deepEqual(validateSearchDomains([host]), [host]);
      });
    }
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
      // TASK-046: AU ISP/portal entries must not affect genuine school domains.
      'mail.stmarys.edu.au',
      'stbedes.vic.edu.au',
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

    it('internode.on.net is refused by EXACT MATCH before registrableName is consulted (TASK-046)', () => {
      // registrableName("internode.on.net") returns { name: "on", subdomain: true }
      // because "net" is 3 chars and "on" is in CCTLD_SECOND_LEVEL_LABELS, making
      // the suffix 2 labels, so the function reads "on" as registrable name with
      // "internode" as a subdomain. But isPublicMailDomain checks
      // PUBLIC_MAIL_DOMAINS.includes(domain) FIRST (line 339), catching internode.on.net
      // before registrableName is ever called (line 341). This test pins that ordering.
      const result = registrableName('internode.on.net');
      // Prove registrableName would give the wrong answer if it were consulted
      assert.deepEqual(result, { name: 'on', subdomain: true }, 'registrableName would misread it');
      // But isPublicMailDomain refuses it anyway, because the exact-match check fires first
      assert.equal(isPublicMailDomain('internode.on.net'), true, 'must be refused by exact-match check');
      // And it must be in the exact list to be caught by the first check
      assert.ok(PUBLIC_MAIL_DOMAINS.includes('internode.on.net'), 'must be in PUBLIC_MAIL_DOMAINS');
    });
  });

  describe('ccTLD heuristic edge cases - TASK-032 weakness testing', () => {
    it('should handle two-label ccTLD: something.co.uk', () => {
      // co.uk is in CCTLD_SECOND_LEVEL_LABELS, so this is a registrable .co.uk domain
      assert.deepEqual(registrableName('stmarys.co.uk'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.co.uk'), false);
    });

    it('should handle two-label ccTLD: something.com.au', () => {
      // com.au is in CCTLD_SECOND_LEVEL_LABELS
      assert.deepEqual(registrableName('stmarys.com.au'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.com.au'), false);
    });

    it('should handle two-label ccTLD: something.edu.au', () => {
      // edu.au is in CCTLD_SECOND_LEVEL_LABELS
      assert.deepEqual(registrableName('stmarys.edu.au'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.edu.au'), false);
    });

    it('should handle three-label ccTLD: something.act.edu.au', () => {
      // act is NOT in CCTLD_SECOND_LEVEL_LABELS, so heuristic treats edu.au as 2-label suffix
      // Result: "act" is the registrable name, and "stmarys" is a subdomain label
      const result = registrableName('stmarys.act.edu.au');
      assert.equal(result.name, 'act', 'heuristic reads "act" as registrable name');
      assert.equal(result.subdomain, true, '"stmarys" is a subdomain label');
      assert.equal(isPublicMailDomain('stmarys.act.edu.au'), false);
    });

    it('should handle two-letter ccTLD used directly: something.uk', () => {
      // uk is a two-letter ccTLD. The heuristic treats it as single-label suffix.
      assert.deepEqual(registrableName('stmarys.uk'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.uk'), false);
    });

    it('should handle something.co (Colombia)', () => {
      // co is listed as CCTLD_SECOND_LEVEL_LABELS, but it is only used as suffix with 2-letter ccTLDs
      // co is the ccTLD itself, so this should read as single-label suffix
      assert.deepEqual(registrableName('stmarys.co'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.co'), false);
    });

    it('should handle something.io', () => {
      // io is a ccTLD, single-label suffix
      assert.deepEqual(registrableName('stmarys.io'), { name: 'stmarys', subdomain: false });
      assert.equal(isPublicMailDomain('stmarys.io'), false);
    });

    it('should return null for single-label domain', () => {
      assert.equal(registrableName('localhost'), null);
      assert.equal(registrableName('stmarys'), null);
    });

    it('should return null for bare two-label ccTLD suffix', () => {
      assert.equal(registrableName('com.au'), null);
      assert.equal(registrableName('co.uk'), null);
    });

    it('should reject a trailing dot as invalid, not as a provider', () => {
      // normalizeDomain does NOT remove trailing dots (they are typos)
      const trailing = 'stmarys.edu.au.';
      let error = null;
      try {
        validateSearchDomains([trailing]);
      } catch (err) {
        error = err;
      }
      assert.ok(error, 'should have thrown');
      assert.ok(error instanceof SettingsValidationError);
      assert.ok(
        error.message.includes('not a valid email domain'),
        `Should reject trailing dot as invalid domain, not as provider`
      );
    });

    it('should handle very long domain without crashing', () => {
      // MAX_DOMAIN_LENGTH is 253, so just at limit should pass if valid labels
      const longDomain = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.edu.au';
      if (longDomain.length <= 253) {
        const result = registrableName(longDomain);
        assert.ok(result === null || result.name, 'Should not crash on very long domain');
        assert.equal(isPublicMailDomain(longDomain), false);
      }
    });
  });

  describe('brand check false negatives - probe near-misses TASK-032', () => {
    it('should refuse gmail.co.uk (brand under different suffix)', () => {
      // gmail is in PUBLIC_MAIL_BRANDS, .co.uk is a two-label suffix
      assert.ok(!PUBLIC_MAIL_DOMAINS.includes('gmail.co.uk'), 'must not be in exact list');
      refusal('gmail.co.uk');
    });

    it('should refuse googlemail.net (brand under different suffix)', () => {
      // googlemail is in PUBLIC_MAIL_BRANDS, .net is single-label suffix
      assert.ok(!PUBLIC_MAIL_DOMAINS.includes('googlemail.net'), 'must not be in exact list');
      refusal('googlemail.net');
    });

    it('should refuse hotmail.xyz (brand under uncommon suffix)', () => {
      // hotmail is in PUBLIC_MAIL_BRANDS, .xyz is not a ccTLD
      assert.ok(!PUBLIC_MAIL_DOMAINS.includes('hotmail.xyz'), 'must not be in exact list');
      refusal('hotmail.xyz');
    });

    it('should refuse yahoo.io (brand under ccTLD suffix)', () => {
      // yahoo is in PUBLIC_MAIL_BRANDS, .io is a ccTLD
      assert.ok(!PUBLIC_MAIL_DOMAINS.includes('yahoo.io'), 'must not be in exact list');
      refusal('yahoo.io');
    });

    it('should accept live.vic.edu.au (school with brand-like word in subdomain)', () => {
      // live is a dictionary-word brand NOT in PUBLIC_MAIL_BRANDS (removed for false positives).
      // Here "live" is only a subdomain label; registrable name is "vic" (not a brand).
      assert.equal(isPublicMailDomain('live.vic.edu.au'), false);
      assert.deepEqual(validateSearchDomains(['live.vic.edu.au']), ['live.vic.edu.au']);
    });

    it('should accept mail.qld.edu.au (school with brand-like word in subdomain)', () => {
      // mail is a dictionary-word brand NOT in PUBLIC_MAIL_BRANDS (removed for false positives).
      // Here "mail" is only a subdomain label; registrable name is "qld" (not a brand).
      assert.equal(isPublicMailDomain('mail.qld.edu.au'), false);
      assert.deepEqual(validateSearchDomains(['mail.qld.edu.au']), ['mail.qld.edu.au']);
    });

    it('should accept me.edu.au (school with brand-like word as registrable name)', () => {
      // me is a dictionary-word brand that was removed from the brand check.
      // It is only blocked at its known exact hosts (me.com, me.co, etc), so
      // me.edu.au is accepted. This pins the AC: "genuine school domains are unaffected".
      assert.equal(isPublicMailDomain('me.edu.au'), false, 'me.edu.au should be accepted as school domain');
      assert.deepEqual(validateSearchDomains(['me.edu.au']), ['me.edu.au']);
    });
  });

  describe('short brands: substring-matching check TASK-032', () => {
    it('should accept livewire.edu.au (contains "live" but different name)', () => {
      // "livewire" is the registrable name, not "live"
      // The brand check should match whole names, not substrings
      assert.equal(isPublicMailDomain('livewire.edu.au'), false);
      assert.deepEqual(validateSearchDomains(['livewire.edu.au']), ['livewire.edu.au']);
    });

    it('should accept macquarie.edu.au (contains "mac" but different name)', () => {
      // "macquarie" is the registrable name, not "mac"
      assert.equal(isPublicMailDomain('macquarie.edu.au'), false);
      assert.deepEqual(validateSearchDomains(['macquarie.edu.au']), ['macquarie.edu.au']);
    });

    it('should accept mailroom.edu.au (contains "mail" but different name)', () => {
      // "mailroom" is the registrable name, not "mail"
      assert.equal(isPublicMailDomain('mailroom.edu.au'), false);
      assert.deepEqual(validateSearchDomains(['mailroom.edu.au']), ['mailroom.edu.au']);
    });

    it('should refuse mail.com but accept mailroom.com', () => {
      // mail.com is exact match on brand
      refusal('mail.com');
      // mailroom.com has registrable name "mailroom", not "mail"
      assert.equal(isPublicMailDomain('mailroom.com'), false);
      assert.deepEqual(validateSearchDomains(['mailroom.com']), ['mailroom.com']);
    });

    it('should refuse qq.com but accept qqschool.com', () => {
      // qq is a Chinese mail provider brand
      refusal('qq.com');
      // qqschool is a different registrable name
      assert.equal(isPublicMailDomain('qqschool.com'), false);
      assert.deepEqual(validateSearchDomains(['qqschool.com']), ['qqschool.com']);
    });
  });

  describe('normalisation edge cases', () => {
    it('should normalise and refuse mixed-case blocked host', () => {
      const forms = [
        'OUTLOOK.COM.AU',
        'Outlook.Com.Au',
        'outlOOK.COM.au',
      ];
      for (const form of forms) {
        let error = null;
        try {
          validateSearchDomains([form]);
        } catch (err) {
          error = err;
        }
        assert.ok(error, `${form} should have been refused`);
        assert.equal(error.statusCode, 400);
        assert.ok(
          error.message.includes('outlook.com.au'),
          `${form} should normalise to outline.com.au in message`
        );
      }
    });

    it('should normalise email address and refuse if domain is blocked', () => {
      const forms = [
        'user@gmail.com',
        'user+tag@GMAIL.COM',
        ' someone@yahoo.com.au ',
      ];
      for (const form of forms) {
        let error = null;
        try {
          validateSearchDomains([form]);
        } catch (err) {
          error = err;
        }
        assert.ok(error, `${form} should have been refused`);
      }
    });

    it('should normalise URL and refuse if domain is blocked', () => {
      const forms = [
        'https://proton.me/login',
        'http://me.com:443',
        'ftp://icloud.com/path',
      ];
      for (const form of forms) {
        let error = null;
        try {
          validateSearchDomains([form]);
        } catch (err) {
          error = err;
        }
        assert.ok(error, `${form} should have been refused`);
      }
    });

    it('should normalise wildcard and refuse if domain is blocked', () => {
      const forms = [
        '*.hotmail.com',
        '*.*. aol.com',
        '*.*.*.gmail.com',
      ];
      for (const form of forms) {
        let error = null;
        try {
          validateSearchDomains([form]);
        } catch (err) {
          error = err;
        }
        assert.ok(error, `${form} should have been refused`);
      }
    });
  });

  describe('completeness guard - no unpinned entries', () => {
    it('should carry exactly the domains in EXPECTED_PUBLIC_MAIL_DOMAINS', () => {
      // This assertion pins the module's list to the test's list.
      // If a coder adds an entry to PUBLIC_MAIL_DOMAINS without adding a literal
      // test row to EXPECTED_PUBLIC_MAIL_DOMAINS above, this fails.
      assert.equal(
        PUBLIC_MAIL_DOMAINS.length,
        EXPECTED_PUBLIC_MAIL_DOMAINS.length,
        'PUBLIC_MAIL_DOMAINS has entries not listed in EXPECTED_PUBLIC_MAIL_DOMAINS'
      );
      const unexpected = PUBLIC_MAIL_DOMAINS.filter(
        (h) => !EXPECTED_PUBLIC_MAIL_DOMAINS.includes(h)
      );
      assert.deepEqual(
        unexpected,
        [],
        'Adding an entry to PUBLIC_MAIL_DOMAINS requires a pinned test row in this file'
      );
    });

    it('should carry exactly the brands in EXPECTED_PUBLIC_MAIL_BRANDS', () => {
      // Same discipline for brands: every entry must have a literal test
      assert.equal(
        PUBLIC_MAIL_BRANDS.length,
        EXPECTED_PUBLIC_MAIL_BRANDS.length,
        'PUBLIC_MAIL_BRANDS has entries not listed in EXPECTED_PUBLIC_MAIL_BRANDS'
      );
      const unexpected = PUBLIC_MAIL_BRANDS.filter(
        (b) => !EXPECTED_PUBLIC_MAIL_BRANDS.includes(b)
      );
      assert.deepEqual(
        unexpected,
        [],
        'Adding a brand to PUBLIC_MAIL_BRANDS requires a pinned test row in this file'
      );
    });
  });
});
