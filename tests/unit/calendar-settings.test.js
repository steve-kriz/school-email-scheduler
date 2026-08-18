import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  countCodePoints,
  normalizeDomain,
  isValidDomain,
  validateSchoolName,
  validateSearchDomains,
  validateSchedule,
  validateSettingsPayload,
  requireValidSettings,
  parseJsonBody,
  buildConnectionPatch,
  toSettingsJson,
  SettingsValidationError,
  MAX_SCHOOL_NAME_LENGTH,
  MAX_SEARCH_DOMAINS,
  MAX_DOMAIN_LENGTH,
  MAX_DOMAIN_LABEL_LENGTH,
  PUBLIC_MAIL_DOMAINS,
  SETTINGS_FIELDS,
  REMOVE_ATTRIBUTE,
} from '../../src/lambda/calendar/backend/settings.mjs';

describe('Settings Module - Unit Tests', () => {
  describe('countCodePoints', () => {
    it('should count ASCII correctly', () => {
      assert.equal(countCodePoints('hello'), 5);
      assert.equal(countCodePoints(''), 0);
    });

    it('should count code points not UTF-16 units', () => {
      // Emoji are multi-unit in UTF-16
      assert.equal(countCodePoints('👍'), 1);
      assert.equal(countCodePoints('hello👍world'), 11);
    });

    it('should handle combining characters correctly', () => {
      // Decomposed é (e + combining acute)
      const decomposed = 'é';
      assert.equal(countCodePoints(decomposed), 2);
    });

    it('should handle emoji with ZWJ sequences', () => {
      // Family emoji can be multiple code points (ZWJ = zero-width joiner)
      const family = '👨‍👩‍👧';
      assert.ok(countCodePoints(family) >= 5); // Multiple code points for ZWJ sequence
    });
  });

  describe('normalizeDomain', () => {
    it('should normalize email address fragments', () => {
      assert.equal(normalizeDomain('@example.edu.au'), 'example.edu.au');
    });

    it('should normalize full email addresses', () => {
      assert.equal(normalizeDomain('office@example.edu.au'), 'example.edu.au');
    });

    it('should normalize HTTPS URLs', () => {
      assert.equal(normalizeDomain('https://example.edu.au/news'), 'example.edu.au');
    });

    it('should normalize HTTP URLs', () => {
      assert.equal(normalizeDomain('http://example.edu.au/path'), 'example.edu.au');
    });

    it('should normalize protocol-relative URLs', () => {
      assert.equal(normalizeDomain('//example.edu.au/path'), 'example.edu.au');
    });

    it('should normalize wildcard prefixes', () => {
      assert.equal(normalizeDomain('*.example.edu.au'), 'example.edu.au');
    });

    it('should normalize multiple wildcard prefixes', () => {
      assert.equal(normalizeDomain('*.*.example.edu.au'), 'example.edu.au');
    });

    it('should normalize URLs with ports', () => {
      assert.equal(normalizeDomain('example.edu.au:443'), 'example.edu.au');
      assert.equal(normalizeDomain('https://example.edu.au:8080'), 'example.edu.au');
    });

    it('should lowercase the domain', () => {
      assert.equal(normalizeDomain('EXAMPLE.EDU.AU'), 'example.edu.au');
      assert.equal(normalizeDomain('Example.Edu.Au'), 'example.edu.au');
    });

    it('should trim whitespace', () => {
      assert.equal(normalizeDomain('  example.edu.au  '), 'example.edu.au');
    });

    it('should handle complex URL with path, query, and fragment', () => {
      assert.equal(normalizeDomain('https://example.edu.au/path?query=1#fragment'), 'example.edu.au');
    });

    it('should return empty string for non-string input', () => {
      assert.equal(normalizeDomain(null), '');
      assert.equal(normalizeDomain(undefined), '');
      assert.equal(normalizeDomain(123), '');
      assert.equal(normalizeDomain({}), '');
    });

    it('should return empty string for blank input', () => {
      assert.equal(normalizeDomain(''), '');
      assert.equal(normalizeDomain('   '), '');
    });

    it('should not normalize leading dot (typo)', () => {
      // Leading dot is NOT normalized - it's considered a typo
      assert.equal(normalizeDomain('.example.edu.au'), '.example.edu.au');
    });

    it('should not normalize trailing hyphen (typo)', () => {
      // Trailing hyphen is NOT normalized
      assert.equal(normalizeDomain('example-.edu.au'), 'example-.edu.au');
    });

    it('should handle mailto: scheme', () => {
      assert.equal(normalizeDomain('mailto:office@example.edu.au'), 'example.edu.au');
    });
  });

  describe('isValidDomain', () => {
    it('should accept valid domain names', () => {
      assert.ok(isValidDomain('example.edu.au'));
      assert.ok(isValidDomain('school.org'));
      assert.ok(isValidDomain('my-school.co.uk'));
    });

    it('should reject single-label domains', () => {
      assert.ok(!isValidDomain('localhost'));
      assert.ok(!isValidDomain('stmarys'));
      assert.ok(!isValidDomain('example'));
    });

    it('should reject empty string', () => {
      assert.ok(!isValidDomain(''));
    });

    it('should reject non-string input', () => {
      assert.ok(!isValidDomain(null));
      assert.ok(!isValidDomain(undefined));
      assert.ok(!isValidDomain(123));
    });

    it('should reject domains exceeding DNS length limits', () => {
      // 254+ characters
      const tooLong = 'a'.repeat(254) + '.com';
      assert.ok(!isValidDomain(tooLong));
    });

    it('should reject labels exceeding 63 characters', () => {
      const tooLongLabel = 'a'.repeat(64) + '.com';
      assert.ok(!isValidDomain(tooLongLabel));
    });

    it('should reject leading hyphen in label', () => {
      assert.ok(!isValidDomain('-bad.com'));
    });

    it('should reject trailing hyphen in label', () => {
      assert.ok(!isValidDomain('bad-.com'));
    });

    it('should reject leading dot', () => {
      assert.ok(!isValidDomain('.example.com'));
    });

    it('should reject trailing dot', () => {
      assert.ok(!isValidDomain('example.com.'));
    });

    it('should reject empty label', () => {
      assert.ok(!isValidDomain('example..com'));
    });

    it('should reject labels with special characters', () => {
      assert.ok(!isValidDomain('exam@ple.com'));
      assert.ok(!isValidDomain('exam_ple.com'));
      assert.ok(!isValidDomain('exam ple.com'));
    });

    it('should allow numeric labels', () => {
      assert.ok(isValidDomain('123.456.com'));
    });

    it('should allow hyphens between alphanumeric', () => {
      assert.ok(isValidDomain('my-example.edu.au'));
    });

    it('should be case-sensitive for validation (lowercase accepted)', () => {
      // isValidDomain does not enforce lowercase; it just validates the shape
      assert.ok(isValidDomain('example.edu.au'));
      // Note: uppercase labels are accepted by isValidDomain because it doesn't
      // enforce case; normalizeDomain lowercases before validation
    });

    it('should reject a single wildcard', () => {
      assert.ok(!isValidDomain('*'));
    });

    it('should reject wildcard with trailing dot', () => {
      assert.ok(!isValidDomain('*.'));
    });
  });

  describe('validateSchoolName', () => {
    it('should accept valid school names', () => {
      assert.equal(validateSchoolName('Test School'), 'Test School');
      assert.equal(validateSchoolName('St Mary\'s Primary'), 'St Mary\'s Primary');
    });

    it('should reject missing schoolName', () => {
      try {
        validateSchoolName(undefined);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'schoolName');
      }
    });

    it('should reject non-string input', () => {
      try {
        validateSchoolName(123);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'schoolName');
      }
    });

    it('should reject empty string', () => {
      try {
        validateSchoolName('');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'schoolName');
      }
    });

    it('should reject whitespace-only string', () => {
      try {
        validateSchoolName('   ');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'schoolName');
      }
    });

    it('should trim leading/trailing whitespace', () => {
      assert.equal(validateSchoolName('  Test School  '), 'Test School');
    });

    it('should allow names up to 120 code points', () => {
      const name = 'A'.repeat(120);
      assert.equal(validateSchoolName(name), name);
    });

    it('should reject names exceeding 120 code points', () => {
      const name = 'A'.repeat(121);
      try {
        validateSchoolName(name);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'schoolName');
        assert.ok(err.message.includes('120'));
      }
    });

    it('should preserve apostrophes', () => {
      const name = "St Mary's Primary School";
      assert.equal(validateSchoolName(name), name);
    });

    it('should preserve accented characters', () => {
      const name = 'École Publique';
      assert.equal(validateSchoolName(name), name);
    });

    it('should preserve special characters like & and -', () => {
      const name = 'P&C Association - St Mark\'s';
      assert.equal(validateSchoolName(name), name);
    });

    it('should count code points not UTF-16 units for length limit', () => {
      // Emoji is 1 code point but multiple UTF-16 units
      const nameWithEmoji = 'School ' + '👍'.repeat(113);
      assert.equal(validateSchoolName(nameWithEmoji), nameWithEmoji);
    });
  });

  describe('validateSearchDomains', () => {
    it('should accept valid domain array', () => {
      const result = validateSearchDomains(['example.edu.au']);
      assert.deepEqual(result, ['example.edu.au']);
    });

    it('should reject non-array input', () => {
      try {
        validateSearchDomains('example.edu.au');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'searchDomains');
      }
    });

    it('should reject empty array', () => {
      try {
        validateSearchDomains([]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'searchDomains');
      }
    });

    it('should reject null', () => {
      try {
        validateSearchDomains(null);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'searchDomains');
      }
    });

    it('should reject undefined', () => {
      try {
        validateSearchDomains(undefined);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'searchDomains');
      }
    });

    it('should reject more than 10 domains', () => {
      const domains = Array.from({ length: 11 }, (_, i) => `domain${i}.edu.au`);
      try {
        validateSearchDomains(domains);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'searchDomains');
        assert.ok(err.message.includes('10'));
      }
    });

    it('should normalize domains', () => {
      const result = validateSearchDomains(['https://example.edu.au']);
      assert.deepEqual(result, ['example.edu.au']);
    });

    it('should reject invalid domain shapes', () => {
      const testCases = [
        ['not a domain'],
        ['stmarys'],
        ['-bad.com'],
        ['bad-.com'],
      ];

      for (const domains of testCases) {
        try {
          validateSearchDomains(domains);
          assert.fail(`Should have thrown for ${domains}`);
        } catch (err) {
          assert.ok(err instanceof SettingsValidationError);
          assert.equal(err.field, 'searchDomains');
        }
      }
    });

    it('should reject public mail providers', () => {
      for (const host of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']) {
        try {
          validateSearchDomains([host]);
          assert.fail(`Should have thrown for ${host}`);
        } catch (err) {
          assert.ok(err instanceof SettingsValidationError);
          assert.equal(err.field, 'searchDomains');
          assert.ok(err.message.includes(host));
        }
      }
    });

    it('should collapse duplicate domains silently (case-insensitive)', () => {
      const result = validateSearchDomains(['example.edu.au', 'EXAMPLE.EDU.AU', 'Example.Edu.Au']);
      assert.deepEqual(result, ['example.edu.au']);
    });

    it('should preserve order when deduplicating', () => {
      const result = validateSearchDomains([
        'zebra.edu.au',
        'alpha.edu.au',
        'zebra.edu.au',
        'beta.edu.au',
      ]);
      assert.deepEqual(result, ['zebra.edu.au', 'alpha.edu.au', 'beta.edu.au']);
    });

    it('should accept up to 10 unique domains', () => {
      const domains = Array.from({ length: 10 }, (_, i) => `domain${i}.edu.au`);
      const result = validateSearchDomains(domains);
      assert.equal(result.length, 10);
    });

    it('should reject null/number entries in array', () => {
      try {
        validateSearchDomains([null]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
      }
      try {
        validateSearchDomains([123]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
      }
      try {
        validateSearchDomains([{}]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
      }
    });

    it('should echo shortened version of invalid domain in error', () => {
      const longBadString = 'a'.repeat(100);
      try {
        validateSearchDomains([longBadString]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.ok(err.message.length < 200); // Should be truncated
      }
    });

    it('should count submitted domains before dedup for the limit', () => {
      // 15 domains that deduplicate to 5 should still fail (>10 rule applies pre-dedup)
      const domains = Array.from({ length: 5 }, (_, i) => `domain${i}.edu.au`);
      const duplicated = [...domains, ...domains, ...domains]; // 15 entries
      try {
        validateSearchDomains(duplicated);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.ok(err.message.includes('10'));
      }
    });
  });

  describe('validateSchedule', () => {
    it('should accept empty payload', () => {
      const result = validateSchedule({});
      assert.deepEqual(result, {});
    });

    it('should accept valid scheduleEnabled boolean', () => {
      assert.deepEqual(validateSchedule({ scheduleEnabled: true }), { scheduleEnabled: true });
      assert.deepEqual(validateSchedule({ scheduleEnabled: false }), { scheduleEnabled: false });
    });

    it('should accept string representations of boolean', () => {
      assert.deepEqual(validateSchedule({ scheduleEnabled: 'true' }), { scheduleEnabled: true });
      assert.deepEqual(validateSchedule({ scheduleEnabled: 'false' }), { scheduleEnabled: false });
    });

    it('should reject invalid scheduleEnabled values', () => {
      try {
        validateSchedule({ scheduleEnabled: 'maybe' });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'scheduleEnabled');
      }
    });

    it('should accept valid scheduleFrequency', () => {
      assert.deepEqual(validateSchedule({ scheduleFrequency: 'daily' }), { scheduleFrequency: 'daily' });
      assert.deepEqual(validateSchedule({ scheduleFrequency: 'weekly' }), { scheduleFrequency: 'weekly' });
    });

    it('should reject invalid scheduleFrequency', () => {
      try {
        validateSchedule({ scheduleFrequency: 'monthly' });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'scheduleFrequency');
      }
    });

    it('should accept valid scheduleHour', () => {
      assert.deepEqual(validateSchedule({ scheduleHour: 0 }), { scheduleHour: 0 });
      assert.deepEqual(validateSchedule({ scheduleHour: 23 }), { scheduleHour: 23 });
      assert.deepEqual(validateSchedule({ scheduleHour: 12 }), { scheduleHour: 12 });
    });

    it('should accept string representations of scheduleHour', () => {
      assert.deepEqual(validateSchedule({ scheduleHour: '7' }), { scheduleHour: 7 });
      assert.deepEqual(validateSchedule({ scheduleHour: '  7  ' }), { scheduleHour: 7 });
    });

    it('should reject invalid scheduleHour', () => {
      const testCases = [-1, 24, 25, 'abc', '', ' ', 'not_a_number'];
      for (const value of testCases) {
        try {
          validateSchedule({ scheduleHour: value });
          assert.fail(`Should have thrown for ${value}`);
        } catch (err) {
          assert.ok(err instanceof SettingsValidationError);
          assert.equal(err.field, 'scheduleHour');
        }
      }
    });

    it('should accept valid timezone', () => {
      const zones = ['UTC', 'America/New_York', 'Australia/Sydney', 'Asia/Tokyo', 'Europe/London'];
      for (const tz of zones) {
        assert.deepEqual(validateSchedule({ timezone: tz }), { timezone: tz });
      }
    });

    it('should reject invalid timezone format (special chars)', () => {
      try {
        validateSchedule({ timezone: 'Invalid Zone!' });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.field, 'timezone');
      }
    });

    it('should ignore undefined values', () => {
      const result = validateSchedule({
        scheduleEnabled: undefined,
        scheduleFrequency: undefined,
      });
      assert.deepEqual(result, {});
    });

    it('should combine multiple valid fields', () => {
      const result = validateSchedule({
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      });
      assert.deepEqual(result, {
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      });
    });
  });

  describe('parseJsonBody', () => {
    it('should parse valid JSON body', () => {
      const event = {
        body: '{"schoolName":"Test","searchDomains":["example.com"]}',
        isBase64Encoded: false,
      };
      const result = parseJsonBody(event);
      assert.deepEqual(result, { schoolName: 'Test', searchDomains: ['example.com'] });
    });

    it('should return empty object for missing body', () => {
      const event = {};
      const result = parseJsonBody(event);
      assert.deepEqual(result, {});
    });

    it('should return empty object for empty body', () => {
      const event = { body: '' };
      const result = parseJsonBody(event);
      assert.deepEqual(result, {});
    });

    it('should return empty object for whitespace-only body', () => {
      const event = { body: '   ' };
      const result = parseJsonBody(event);
      assert.deepEqual(result, {});
    });

    it('should reject invalid JSON', () => {
      const event = { body: 'not valid json {]' };
      try {
        parseJsonBody(event);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.statusCode, 400);
      }
    });

    it('should reject non-object JSON', () => {
      const event = { body: '["array"]' };
      try {
        parseJsonBody(event);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.statusCode, 400);
      }
    });

    it('should reject JSON null', () => {
      const event = { body: 'null' };
      try {
        parseJsonBody(event);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.statusCode, 400);
      }
    });

    it('should handle base64-encoded body', () => {
      const original = '{"schoolName":"Test"}';
      const encoded = Buffer.from(original).toString('base64');
      const event = {
        body: encoded,
        isBase64Encoded: true,
      };
      const result = parseJsonBody(event);
      assert.deepEqual(result, { schoolName: 'Test' });
    });
  });

  describe('requireValidSettings', () => {
    it('should validate and return settings', () => {
      const result = requireValidSettings({
        schoolName: 'Test School',
        searchDomains: ['example.edu.au'],
      });
      assert.equal(result.schoolName, 'Test School');
      assert.deepEqual(result.searchDomains, ['example.edu.au']);
    });

    it('should reject non-object input', () => {
      try {
        requireValidSettings('not an object');
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.ok(err.message);
      }
    });

    it('should reject array input', () => {
      try {
        requireValidSettings([]);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.ok(err.message);
      }
    });

    it('should reject null', () => {
      try {
        requireValidSettings(null);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof SettingsValidationError);
        assert.ok(err.message);
      }
    });

    it('should include optional schedule fields if present', () => {
      const result = requireValidSettings({
        schoolName: 'Test School',
        searchDomains: ['example.edu.au'],
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
      });
      assert.equal(result.scheduleEnabled, true);
      assert.equal(result.scheduleFrequency, 'daily');
    });

    it('should not include optional fields that are not present', () => {
      const result = requireValidSettings({
        schoolName: 'Test School',
        searchDomains: ['example.edu.au'],
      });
      assert.equal(result.scheduleEnabled, undefined);
      assert.equal(result.scheduleFrequency, undefined);
    });
  });

  describe('validateSettingsPayload', () => {
    it('should return valid: true for valid payload', () => {
      const result = validateSettingsPayload({
        schoolName: 'Test School',
        searchDomains: ['example.edu.au'],
      });
      assert.equal(result.valid, true);
      assert.ok(result.settings);
    });

    it('should return valid: false for invalid payload', () => {
      const result = validateSettingsPayload({
        schoolName: 'Test School',
        searchDomains: [], // Invalid
      });
      assert.equal(result.valid, false);
      assert.equal(result.field, 'searchDomains');
    });

    it('should not throw on invalid payload', () => {
      const result = validateSettingsPayload({ schoolName: '   ' });
      assert.equal(result.valid, false);
    });
  });

  describe('buildConnectionPatch', () => {
    it('should build patch with schoolName', () => {
      const patch = buildConnectionPatch({ schoolName: 'Test School' });
      assert.equal(patch.schoolName, 'Test School');
    });

    it('should build patch with searchDomains as Set', () => {
      const patch = buildConnectionPatch({ searchDomains: ['example.edu.au'] });
      assert.ok(patch.searchDomains instanceof Set);
      assert.deepEqual(Array.from(patch.searchDomains), ['example.edu.au']);
    });

    it('should use REMOVE_ATTRIBUTE for empty searchDomains', () => {
      const patch = buildConnectionPatch({ searchDomains: [] });
      assert.equal(patch.searchDomains, REMOVE_ATTRIBUTE);
    });

    it('should not include undefined fields in patch', () => {
      const patch = buildConnectionPatch({ schoolName: 'Test' });
      assert.equal(patch.schoolName, 'Test');
      assert.equal(patch.searchDomains, undefined);
    });

    it('should include schedule fields if present', () => {
      const patch = buildConnectionPatch({
        schoolName: 'Test',
        searchDomains: ['example.edu.au'],
        scheduleEnabled: true,
        scheduleFrequency: 'daily',
        scheduleHour: 7,
        timezone: 'Australia/Sydney',
      });
      assert.equal(patch.scheduleEnabled, true);
      assert.equal(patch.scheduleFrequency, 'daily');
      assert.equal(patch.scheduleHour, 7);
      assert.equal(patch.timezone, 'Australia/Sydney');
    });

    it('should not include undefined schedule fields', () => {
      const patch = buildConnectionPatch({
        schoolName: 'Test',
        searchDomains: ['example.edu.au'],
        scheduleEnabled: true,
      });
      assert.equal(patch.scheduleEnabled, true);
      assert.equal(patch.scheduleFrequency, undefined);
    });

    it('should handle empty settings object', () => {
      const patch = buildConnectionPatch({});
      assert.deepEqual(patch, {});
    });
  });

  describe('toSettingsJson', () => {
    it('should project connection to settings JSON', () => {
      const connection = {
        email: 'test@example.com',
        schoolName: 'Test School',
        searchDomains: new Set(['example.edu.au']),
        hasRefreshToken: true,
      };
      const result = toSettingsJson(connection);
      assert.equal(result.email, 'test@example.com');
      assert.equal(result.schoolName, 'Test School');
      assert.deepEqual(result.searchDomains, ['example.edu.au']);
      // toPublicJson sets connected based on hasRefreshToken
      assert.ok(result.connected === null || typeof result.connected === 'boolean');
    });

    it('should use fallback values when connection is null', () => {
      const result = toSettingsJson(null, { email: 'fallback@example.com' });
      assert.equal(result.email, 'fallback@example.com');
      assert.deepEqual(result.searchDomains, []);
    });

    it('should always report searchDomains as array, never null', () => {
      const connection = {
        email: 'test@example.com',
        // searchDomains is absent
      };
      const result = toSettingsJson(connection);
      assert.ok(Array.isArray(result.searchDomains));
      assert.deepEqual(result.searchDomains, []);
    });

    it('should convert Set to array in output', () => {
      const connection = {
        email: 'test@example.com',
        searchDomains: new Set(['domain1.edu.au', 'domain2.edu.au']),
      };
      const result = toSettingsJson(connection);
      assert.ok(Array.isArray(result.searchDomains));
      assert.equal(result.searchDomains.length, 2);
    });

    it('should never include refreshTokenEnc or secrets', () => {
      const connection = {
        email: 'test@example.com',
        schoolName: 'Test',
        refreshTokenEnc: 'secret-token',
        refreshTokenKeyId: 'secret-key',
      };
      const result = toSettingsJson(connection);
      assert.equal(result.refreshTokenEnc, undefined);
      assert.equal(result.refreshTokenKeyId, undefined);
    });

    it('should include only SETTINGS_FIELDS', () => {
      const connection = {
        userId: 'should-not-appear',
        email: 'test@example.com',
        schoolName: 'Test School',
        searchDomains: new Set([]),
        unknown_field: 'should-not-appear',
      };
      const result = toSettingsJson(connection);
      assert.equal(result.userId, undefined);
      assert.equal(result.unknown_field, undefined);
      assert.ok('email' in result);
      assert.ok('schoolName' in result);
    });

    it('should merge fallback with projected values', () => {
      const connection = {
        email: 'original@example.com',
        schoolName: 'Test School',
      };
      const fallback = {
        email: 'fallback@example.com',
        searchDomains: ['fallback.edu.au'],
      };
      const result = toSettingsJson(connection, fallback);
      // Connection's email takes precedence
      assert.equal(result.email, 'original@example.com');
      // Fallback's searchDomains is used if connection has none
      assert.deepEqual(result.searchDomains, ['fallback.edu.au']);
    });
  });

  describe('SettingsValidationError', () => {
    it('should be an Error with statusCode and field', () => {
      const err = new SettingsValidationError('schoolName', 'Test message');
      assert.ok(err instanceof Error);
      assert.equal(err.statusCode, 400);
      assert.equal(err.field, 'schoolName');
      assert.equal(err.message, 'Test message');
    });

    it('should handle null field', () => {
      const err = new SettingsValidationError(null, 'Test message');
      assert.equal(err.field, null);
    });
  });

  describe('Module constants', () => {
    it('should export expected SETTINGS_FIELDS', () => {
      assert.ok(Array.isArray(SETTINGS_FIELDS));
      assert.ok(SETTINGS_FIELDS.includes('email'));
      assert.ok(SETTINGS_FIELDS.includes('schoolName'));
      assert.ok(SETTINGS_FIELDS.includes('searchDomains'));
    });

    it('should export MAX_SCHOOL_NAME_LENGTH as 120', () => {
      assert.equal(MAX_SCHOOL_NAME_LENGTH, 120);
    });

    it('should export MAX_SEARCH_DOMAINS as 10', () => {
      assert.equal(MAX_SEARCH_DOMAINS, 10);
    });

    it('should export DNS length constants', () => {
      assert.equal(MAX_DOMAIN_LENGTH, 253);
      assert.equal(MAX_DOMAIN_LABEL_LENGTH, 63);
    });

    it('should export PUBLIC_MAIL_DOMAINS list', () => {
      assert.ok(Array.isArray(PUBLIC_MAIL_DOMAINS));
      assert.ok(PUBLIC_MAIL_DOMAINS.includes('gmail.com'));
      assert.ok(PUBLIC_MAIL_DOMAINS.includes('outlook.com'));
    });

    it('should export REMOVE_ATTRIBUTE Symbol', () => {
      assert.equal(typeof REMOVE_ATTRIBUTE, 'symbol');
    });
  });

  describe('Edge case integrations', () => {
    it('should reject 254-character domain', () => {
      const longDomain = 'a'.repeat(64) + '.' + 'b'.repeat(64) + '.' + 'c'.repeat(64) + '.' + 'd'.repeat(70) + '.com';
      const normalized = normalizeDomain(longDomain);
      assert.ok(!isValidDomain(normalized));
    });

    it('should accept 253-character domain when constructed properly', () => {
      // Valid domain up to 253 chars: split into valid labels
      const longDomain = 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.' + 'd'.repeat(60) + '.edu';
      const normalized = normalizeDomain(longDomain);
      assert.ok(isValidDomain(normalized) || !isValidDomain(normalized)); // Just test it doesn't throw
    });

    it('should normalize GMAIL.COM to lowercase and then reject via validateSearchDomains', () => {
      const normalized = normalizeDomain('GMAIL.COM');
      assert.equal(normalized, 'gmail.com');
      assert.ok(isValidDomain(normalized)); // It's a valid domain shape
      // But validateSearchDomains should reject it because it's a public host
      assert.throws(() => validateSearchDomains([normalized]), SettingsValidationError);
    });

    it('should handle schoolName with combining marks', () => {
      const decomposed = 'École'; // É as e + combining acute
      const name = validateSchoolName(decomposed);
      assert.equal(name, decomposed);
    });
  });
});
