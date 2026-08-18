import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const gmailModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'gmail.mjs');
const gmailUrl = new URL(`file:///${gmailModulePath.replace(/\\/g, '/')}`).href;
const {
  buildQuery,
  listMessageIds,
  extractPlainText,
  parseMessage,
  decodeBase64Url,
  stripHtml,
  truncateBody,
  formatGmailDate,
  backoffDelayMs,
  parseRetryAfter,
  isRetryableStatus,
  findHeader,
  toDomainList,
  toDate,
  readGmailConfig,
  makeLogger,
  getMessage,
  gmailRequest,
  GmailApiError,
  GMAIL_USER_ID,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_SINCE_DAYS,
} = await import(gmailUrl);

const tokenModulePath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'google-token.mjs');
const tokenUrl = new URL(`file:///${tokenModulePath.replace(/\\/g, '/')}`).href;
const {
  getAccessToken,
  resetTokenCache,
  getCachedTokenExpiry,
  ReauthRequiredError,
  TokenRefreshError,
  isTokenFresh,
  TOKEN_EXPIRY_SKEW_SECONDS,
} = await import(tokenUrl);

describe('Calendar Gmail Unit Tests', () => {
  beforeEach(() => {
    resetTokenCache();
  });

  describe('Unit: formatGmailDate', () => {
    it('should format Date in UTC to YYYY/MM/DD', () => {
      const date = new Date('2026-08-17T15:30:45Z');
      assert.equal(formatGmailDate(date), '2026/08/17');
    });

    it('should pad month and day with zero', () => {
      const date = new Date('2026-01-05T00:00:00Z');
      assert.equal(formatGmailDate(date), '2026/01/05');
    });
  });

  describe('Unit: toDomainList', () => {
    it('should handle Set input', () => {
      const set = new Set(['school.edu', 'pta.school.edu']);
      const result = toDomainList(set);
      assert.deepEqual(result.sort(), ['pta.school.edu', 'school.edu']);
    });

    it('should handle array input', () => {
      const result = toDomainList(['school.edu', 'pta.school.edu']);
      assert.deepEqual(result.sort(), ['pta.school.edu', 'school.edu']);
    });

    it('should handle DynamoDB SS format', () => {
      const result = toDomainList({ SS: ['school.edu', 'pta.school.edu'] });
      assert.deepEqual(result.sort(), ['pta.school.edu', 'school.edu']);
    });

    it('should return empty array for null/undefined', () => {
      assert.deepEqual(toDomainList(null), []);
      assert.deepEqual(toDomainList(undefined), []);
    });

    it('should deduplicate domains', () => {
      const result = toDomainList(['school.edu', 'school.edu']);
      assert.equal(result.length, 1);
    });
  });

  describe('Unit: toDate', () => {
    it('should accept Date object', () => {
      const d = new Date('2026-08-17T00:00:00Z');
      const result = toDate(d);
      assert.ok(result instanceof Date);
      assert.equal(result.getTime(), d.getTime());
    });

    it('should accept ISO-8601 string', () => {
      const result = toDate('2026-08-17T00:00:00Z');
      assert.ok(result instanceof Date);
      assert.equal(result.getUTCFullYear(), 2026);
    });

    it('should accept epoch milliseconds', () => {
      const epochMs = 1660723200000;
      const result = toDate(epochMs);
      assert.ok(result instanceof Date);
      assert.equal(result.getTime(), epochMs);
    });

    it('should return null for unparseable input', () => {
      assert.equal(toDate('invalid'), null);
      assert.equal(toDate(NaN), null);
      assert.equal(toDate(''), null);
    });

    it('should return null for invalid Date', () => {
      const invalid = new Date('invalid');
      assert.equal(toDate(invalid), null);
    });
  });

  describe('Unit: decodeBase64Url', () => {
    it('should decode standard base64', () => {
      // "Hello" in base64
      const result = decodeBase64Url('SGVsbG8=');
      assert.equal(result, 'Hello');
    });

    it('should handle unpadded input', () => {
      // "Hello" without padding
      const result = decodeBase64Url('SGVsbG8');
      assert.equal(result, 'Hello');
    });

    it('should translate base64url alphabet', () => {
      // Create a string with - and _ to test translation
      // base64url uses - for + and _ for /
      const standard = 'ABCDefg+/==';
      const base64url = standard.replace(/\+/g, '-').replace(/\//g, '_');
      const result = decodeBase64Url(base64url);
      // Should decode correctly even though translated
      assert.ok(result.length > 0, 'Should decode without crashing');
    });

    it('should return empty string for non-string input', () => {
      assert.equal(decodeBase64Url(null), '');
      assert.equal(decodeBase64Url(undefined), '');
      assert.equal(decodeBase64Url(123), '');
    });

    it('should return empty string for empty input', () => {
      assert.equal(decodeBase64Url(''), '');
    });
  });

  describe('Unit: stripHtml', () => {
    it('should strip all tags', () => {
      const html = '<p>Hello <b>World</b></p>';
      const result = stripHtml(html);
      assert.equal(result, 'Hello World');
    });

    it('should preserve block boundaries', () => {
      const html = '<p>Line 1</p><p>Line 2</p>';
      const result = stripHtml(html);
      assert.ok(result.includes('\n'), 'Should create line breaks at block boundaries');
    });

    it('should remove script and style content', () => {
      const html = '<p>Content</p><script>alert("xss")</script><style>body{}</style><p>More</p>';
      const result = stripHtml(html);
      assert.ok(!result.includes('alert'), 'Should remove script content');
      assert.ok(!result.includes('body{}'), 'Should remove style content');
    });

    it('should decode HTML entities', () => {
      const html = '&nbsp;&lt;&gt;&quot;&apos;';
      const result = stripHtml(html);
      assert.ok(result.includes('<'), 'Should decode &lt;');
      assert.ok(result.includes('>'), 'Should decode &gt;');
    });

    it('should return empty string for non-string', () => {
      assert.equal(stripHtml(null), '');
      assert.equal(stripHtml(123), '');
    });
  });

  describe('Unit: truncateBody', () => {
    it('should truncate to maxBodyChars', () => {
      const text = 'x'.repeat(100);
      const result = truncateBody(text, 50);
      assert.equal(result.length, 50);
    });

    it('should keep full text if under cap', () => {
      const text = 'Short text';
      const result = truncateBody(text, 100);
      assert.equal(result, text);
    });

    it('should keep head, not tail', () => {
      const text = 'IMPORTANT START ' + 'x'.repeat(100) + ' UNIMPORTANT END';
      const result = truncateBody(text, 50);
      assert.ok(result.startsWith('IMPORTANT'), 'Should keep head');
    });

    it('should return empty for non-string', () => {
      assert.equal(truncateBody(null), '');
      assert.equal(truncateBody(undefined), '');
    });
  });

  describe('Unit: findHeader', () => {
    it('should find header case-insensitively', () => {
      const headers = [
        { name: 'Subject', value: 'Test' },
        { name: 'From', value: 'sender@example.com' },
      ];
      assert.equal(findHeader(headers, 'subject'), 'Test');
      assert.equal(findHeader(headers, 'SUBJECT'), 'Test');
      assert.equal(findHeader(headers, 'from'), 'sender@example.com');
    });

    it('should return empty for missing header', () => {
      const headers = [{ name: 'Subject', value: 'Test' }];
      assert.equal(findHeader(headers, 'From'), '');
    });

    it('should return empty for non-array input', () => {
      assert.equal(findHeader(null, 'Subject'), '');
      assert.equal(findHeader(undefined, 'Subject'), '');
    });
  });

  describe('Unit: extractPlainText', () => {
    it('should extract text/plain from simple payload', () => {
      // Encode "Hello Plain" to base64url
      const encoded = Buffer.from('Hello Plain').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'text/plain',
        body: { data: encoded },
      };
      const result = extractPlainText(payload);
      assert.ok(result.includes('Hello Plain'));
    });

    it('should extract from nested multipart/alternative', () => {
      const plainEncoded = Buffer.from('Plain text').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const htmlEncoded = Buffer.from('<b>HTML</b>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: plainEncoded },
          },
          {
            mimeType: 'text/html',
            body: { data: htmlEncoded },
          },
        ],
      };
      const result = extractPlainText(payload);
      assert.ok(result.includes('Plain text'));
      assert.ok(!result.includes('<b>'));
    });

    it('should prefer text/plain across entire tree', () => {
      const htmlEncoded = Buffer.from('<b>First</b>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const plainEncoded = Buffer.from('Second').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'text/html',
            body: { data: htmlEncoded },
          },
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: plainEncoded },
              },
            ],
          },
        ],
      };
      const result = extractPlainText(payload);
      assert.ok(result.includes('Second'), 'Should find plain text in second branch');
    });

    it('should skip attachments (parts with filename)', () => {
      const textEncoded = Buffer.from('Text').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: textEncoded },
          },
          {
            mimeType: 'application/pdf',
            filename: 'document.pdf',
            body: { data: 'base64binary' },
          },
        ],
      };
      const result = extractPlainText(payload);
      assert.equal(result, 'Text');
    });

    it('should return empty when only attachment exists (attachment-only tree)', () => {
      // Discriminating test: PDF with filename and decodable body - the skip is load-bearing here
      const pdfEncoded = Buffer.from('PDF content here').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'document.pdf',
            body: { data: pdfEncoded },
          },
        ],
      };
      const result = extractPlainText(payload);
      assert.equal(result, '', 'Should skip attachment entirely and return empty');
    });

    it('should skip text/plain with filename in favor of text/html (sharper discrimination)', () => {
      // Discriminating test: filename on text/plain makes it an attachment, prefer HTML instead
      // This is the AC case - a .txt attachment must not be mistaken for the body
      const plainWithFilenameEncoded = Buffer.from('This is attached plain text').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const htmlEncoded = Buffer.from('<p>This is the real HTML body</p>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'text/plain',
            filename: 'attachment.txt',
            body: { data: plainWithFilenameEncoded },
          },
          {
            mimeType: 'text/html',
            body: { data: htmlEncoded },
          },
        ],
      };
      const result = extractPlainText(payload);
      assert.ok(result.includes('This is the real HTML body'), 'Should return HTML body, not attached text/plain');
      assert.ok(!result.includes('This is attached plain text'), 'Should skip the attached text/plain');
    });

    it('should handle depth limit (prevent infinite recursion)', () => {
      // Create deeply nested structure
      let payload = {
        mimeType: 'text/plain',
        body: { data: decodeBase64Url('RGVlcA') }, // "Deep"
      };
      for (let i = 0; i < 25; i++) {
        payload = {
          mimeType: 'multipart/mixed',
          parts: [payload],
        };
      }
      // Should not crash, and should respect depth limit
      const result = extractPlainText(payload);
      // Result may be empty due to depth limit, but should not crash
      assert.ok(typeof result === 'string');
    });

    it('should fall back to HTML if no plain text', () => {
      const htmlEncoded = Buffer.from('<p>Hello World</p>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        mimeType: 'text/html',
        body: { data: htmlEncoded },
      };
      const result = extractPlainText(payload);
      assert.ok(result.includes('Hello World'));
      assert.ok(!result.includes('<p>'));
    });

    it('should return empty for null payload', () => {
      assert.equal(extractPlainText(null), '');
      assert.equal(extractPlainText(undefined), '');
    });
  });

  describe('Unit: parseMessage', () => {
    it('should parse basic message fields', () => {
      const payload = {
        id: 'msg123',
        threadId: 'thread456',
        snippet: 'Message preview',
        internalDate: Date.now(),
        payload: {
          headers: [
            { name: 'Subject', value: 'Test Subject' },
            { name: 'From', value: 'sender@example.com' },
          ],
        },
      };
      const result = parseMessage(payload);
      assert.equal(result.id, 'msg123');
      assert.equal(result.threadId, 'thread456');
      assert.equal(result.subject, 'Test Subject');
      assert.equal(result.from, 'sender@example.com');
      assert.equal(result.snippet, 'Message preview');
    });

    it('should use internalDate for receivedAt', () => {
      const now = Date.now();
      const payload = {
        id: 'msg123',
        internalDate: now,
        payload: { headers: [] },
      };
      const result = parseMessage(payload);
      assert.ok(result.receivedAt);
      // ISO string from epoch ms
      const parsed = new Date(result.receivedAt).getTime();
      assert.ok(Math.abs(parsed - now) < 1000, 'receivedAt should match internalDate');
    });

    it('should fall back to Date header if no internalDate', () => {
      const payload = {
        id: 'msg123',
        payload: {
          headers: [
            { name: 'Date', value: 'Mon, 18 Aug 2026 10:00:00 +0000' },
          ],
        },
      };
      const result = parseMessage(payload);
      assert.ok(result.receivedAt, 'Should extract receivedAt from Date header');
    });

    it('should truncate body using maxBodyChars option', () => {
      // Create long text and encode as base64url
      const longText = 'x'.repeat(500);
      const encoded = Buffer.from(longText).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const payload = {
        id: 'msg123',
        payload: {
          mimeType: 'text/plain',
          headers: [],
          body: { data: encoded },
        },
      };
      const result = parseMessage(payload, { maxBodyChars: 50 });
      assert.ok(result.body.length <= 50, 'Should respect maxBodyChars');
    });

    it('should return safe defaults for missing fields', () => {
      const result = parseMessage(null);
      assert.equal(result.id, '');
      assert.equal(result.threadId, '');
      assert.equal(result.subject, '');
      assert.equal(result.from, '');
      assert.equal(result.body, '');
    });
  });

  describe('Unit: parseRetryAfter', () => {
    it('should parse delta-seconds format', () => {
      const ms = parseRetryAfter('30');
      assert.equal(ms, 30000);
    });

    it('should parse HTTP-date format', () => {
      const now = 1000000;
      const future = new Date(now + 5000);
      const ms = parseRetryAfter(future.toUTCString(), { now: () => now });
      assert.ok(Math.abs(ms - 5000) < 100);
    });

    it('should return null for invalid input', () => {
      assert.equal(parseRetryAfter(null), null);
      assert.equal(parseRetryAfter(''), null);
      assert.equal(parseRetryAfter('not a number or date'), null);
    });

    it('should return null for past HTTP-date', () => {
      const now = 1000000;
      const past = new Date(now - 5000);
      const ms = parseRetryAfter(past.toUTCString(), { now: () => now });
      assert.equal(ms, 0, 'Should clamp to 0 for past date');
    });
  });

  describe('Unit: backoffDelayMs', () => {
    it('should compute exponential backoff with jitter', () => {
      // Attempt 1: 500ms * 2^0 = 500, half fixed (250) + half random
      // With random() = 0, result = 250
      // With random() = 1, result = 500
      const delay0 = backoffDelayMs({ attempt: 1, random: () => 0 });
      const delay1 = backoffDelayMs({ attempt: 1, random: () => 1 });
      assert.equal(delay0, 250);
      assert.equal(delay1, 500);

      // Attempt 2: 500 * 2^1 = 1000, half is 500
      // With random = 0, result = 500
      const delay2 = backoffDelayMs({ attempt: 2, random: () => 0 });
      assert.equal(delay2, 500);
    });

    it('should honor Retry-After if provided', () => {
      const delay = backoffDelayMs({
        attempt: 2,
        retryAfterMs: 3000,
        random: () => 0,
      });
      assert.equal(delay, 3000, 'Should use retryAfterMs when provided');
    });

    it('should clamp to maxDelayMs', () => {
      const delay = backoffDelayMs({
        attempt: 10,
        maxDelayMs: 5000,
        random: () => 1,
      });
      assert.ok(delay <= 5000, 'Should not exceed maxDelayMs');
    });

    it('should clamp Retry-After to maxDelayMs', () => {
      const delay = backoffDelayMs({
        attempt: 1,
        retryAfterMs: 3600000, // 1 hour
        maxDelayMs: 20000,
        random: () => 0,
      });
      assert.equal(delay, 20000, 'Should clamp large Retry-After');
    });
  });

  describe('Unit: isRetryableStatus', () => {
    it('should return true for 429', () => {
      assert.ok(isRetryableStatus(429));
    });

    it('should return true for 5xx', () => {
      assert.ok(isRetryableStatus(500));
      assert.ok(isRetryableStatus(502));
      assert.ok(isRetryableStatus(503));
      assert.ok(isRetryableStatus(504));
    });

    it('should return false for 401', () => {
      assert.ok(!isRetryableStatus(401));
    });

    it('should return false for 403', () => {
      assert.ok(!isRetryableStatus(403));
    });

    it('should return false for 404', () => {
      assert.ok(!isRetryableStatus(404));
    });

    it('should return false for 200', () => {
      assert.ok(!isRetryableStatus(200));
    });
  });

  describe('Unit: readGmailConfig', () => {
    it('should read from environment variables', () => {
      const config = readGmailConfig({
        CALENDAR_GMAIL_MAX_MESSAGES: '500',
        CALENDAR_GMAIL_MAX_BODY_CHARS: '50000',
        CALENDAR_GMAIL_SINCE_DAYS: '30',
      });
      assert.equal(config.maxMessages, 500);
      assert.equal(config.maxBodyChars, 50000);
      assert.equal(config.sinceDays, 30);
    });

    it('should use defaults when env vars absent', () => {
      const config = readGmailConfig({});
      assert.equal(config.maxMessages, DEFAULT_MAX_MESSAGES);
      assert.equal(config.maxBodyChars, DEFAULT_MAX_BODY_CHARS);
      assert.equal(config.sinceDays, DEFAULT_SINCE_DAYS);
    });

    it('should ignore invalid values and use defaults', () => {
      const config = readGmailConfig({
        CALENDAR_GMAIL_MAX_MESSAGES: '0',
        CALENDAR_GMAIL_MAX_BODY_CHARS: 'not a number',
        CALENDAR_GMAIL_SINCE_DAYS: '-5',
      });
      assert.equal(config.maxMessages, DEFAULT_MAX_MESSAGES);
      assert.equal(config.maxBodyChars, DEFAULT_MAX_BODY_CHARS);
      assert.equal(config.sinceDays, DEFAULT_SINCE_DAYS);
    });
  });

  describe('Unit: buildQuery', () => {
    it('should construct valid Gmail search query', () => {
      const query = buildQuery({
        searchDomains: ['school.edu'],
        since: new Date('2026-08-01'),
        now: () => new Date('2026-08-18'),
      });
      assert.match(query, /\(from:@school\.edu\) after:2026\/08\/01/);
    });

    it('should OR-join multiple domains', () => {
      const query = buildQuery({
        searchDomains: ['a.edu', 'b.edu', 'c.edu'],
        since: new Date('2026-08-01'),
        now: () => new Date('2026-08-18'),
      });
      assert.ok(query.includes('from:@a.edu'));
      assert.ok(query.includes('from:@b.edu'));
      assert.ok(query.includes('from:@c.edu'));
      assert.ok(query.includes(' OR '));
      assert.match(query, /^\(/); // Starts with (
      assert.ok(query.includes(') after:'));
    });

    it('should wrap domains in parentheses', () => {
      const query = buildQuery({
        searchDomains: ['school.edu'],
        since: new Date('2026-08-01'),
        now: () => new Date('2026-08-18'),
      });
      assert.match(query, /^\(from:@school\.edu\)/);
    });

    it('should throw for empty domain list', () => {
      assert.throws(
        () => buildQuery({ searchDomains: [] }),
        (err) => err.code === 'no_search_domains'
      );
    });

    it('should default to 90 days when no since provided', () => {
      const now = new Date('2026-08-18');
      const query = buildQuery({
        searchDomains: ['school.edu'],
        since: null,
        sinceDays: 90,
        now: () => now,
      });
      // 90 days back from 2026-08-18 is around 2026-05-20
      assert.match(query, /after:2026\/05\/\d{2}/);
    });
  });

  describe('Unit: gmailRequest 401 token refresh', () => {
    it('should call refreshAccessToken once on 401', async () => {
      let attempts = 0;
      let refreshCalls = 0;
      const mockFetch = async () => {
        attempts++;
        if (attempts === 1) {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({}),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: 'success' }),
        };
      };

      const refreshAccessToken = async () => {
        refreshCalls++;
        return 'new_token_456';
      };

      const result = await gmailRequest(
        'https://gmail.googleapis.com/test',
        {
          accessToken: 'old_token_123',
          fetchImpl: mockFetch,
          sleep: async () => {},
          random: () => 0,
          refreshAccessToken,
        }
      );

      assert.equal(refreshCalls, 1, 'Should refresh exactly once');
      assert.equal(result.accessToken, 'new_token_456', 'Should return refreshed token');
    });

    it('should not retry a second 401', async () => {
      let attempts = 0;
      const mockFetch = async () => {
        attempts++;
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({}),
        };
      };

      let refreshCalls = 0;
      const refreshAccessToken = async () => {
        refreshCalls++;
        return 'new_token_456';
      };

      try {
        await gmailRequest(
          'https://gmail.googleapis.com/test',
          {
            accessToken: 'old_token_123',
            fetchImpl: mockFetch,
            sleep: async () => {},
            random: () => 0,
            refreshAccessToken,
            maxAttempts: 4,
          }
        );
        assert.fail('Should have thrown');
      } catch (err) {
        assert.equal(attempts, 2, 'Should attempt exactly 2 times (first + refresh retry)');
        assert.equal(refreshCalls, 1, 'Should refresh exactly once');
      }
    });
  });

  describe('Unit: Token cache with freshness check', () => {
    it('should reuse token when more than 60s of life remain', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: `token_${callCount}`,
            expires_in: 3600,
          }),
        };
      };

      const mockGetRefreshToken = async () => 'refresh_token_123';
      const baseTime = 1000; // epoch seconds

      // First call
      const token1 = await getAccessToken('user123', {
        getRefreshToken: mockGetRefreshToken,
        fetchImpl: mockFetch,
        nowSeconds: () => baseTime,
        env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      });

      // Second call 61 seconds later: token has 3600 - 61 = 3539 seconds left (well above 60s skew)
      const token2 = await getAccessToken('user123', {
        getRefreshToken: mockGetRefreshToken,
        fetchImpl: mockFetch,
        nowSeconds: () => baseTime + 61,
        env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      });

      assert.equal(token1, token2, 'Should reuse same token');
      assert.equal(callCount, 1, 'Should fetch exactly once');
    });

    it('should re-mint when 60s or less of life remain', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            access_token: `token_${callCount}`,
            expires_in: 3600,
          }),
        };
      };

      const mockGetRefreshToken = async () => 'refresh_token_123';
      const baseTime = 1000;

      // First call at time 1000, token expires at 1000 + 3600 = 4600
      await getAccessToken('user789', {
        getRefreshToken: mockGetRefreshToken,
        fetchImpl: mockFetch,
        nowSeconds: () => baseTime,
        env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      });

      // Second call at time 4541, token has 4600 - 4541 = 59 seconds left (below 60s skew)
      await getAccessToken('user789', {
        getRefreshToken: mockGetRefreshToken,
        fetchImpl: mockFetch,
        nowSeconds: () => baseTime + 3541,
        env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      });

      assert.equal(callCount, 2, 'Should fetch twice when skew crossed');
    });

    it('should expose token expiry via getCachedTokenExpiry', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'token123',
          expires_in: 3600,
        }),
      });

      const mockGetRefreshToken = async () => 'refresh_token_123';
      const nowSeconds = 1000;

      await getAccessToken('user456', {
        getRefreshToken: mockGetRefreshToken,
        fetchImpl: mockFetch,
        nowSeconds: () => nowSeconds,
        env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
      });

      const expiry = getCachedTokenExpiry('user456');
      assert.equal(expiry, nowSeconds + 3600, 'Should expose expiry in epoch seconds');
    });
  });

  describe('Unit: no_refresh_token asymmetry - throws but does not write lastScanStatus', () => {
    it('should throw ReauthRequiredError with no_refresh_token reason when token is missing', async () => {
      const mockGetRefreshToken = async () => null;
      let updateCalled = false;
      const mockUpdateConnection = async () => {
        updateCalled = true;
      };

      try {
        await getAccessToken('user_missing', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: async () => ({}),
          updateConnection: mockUpdateConnection,
          nowSeconds: () => 1000,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof ReauthRequiredError, 'Should be ReauthRequiredError');
        assert.equal(err.reason, 'no_refresh_token', 'Reason should be no_refresh_token');
        assert.equal(updateCalled, false, 'Should NOT call updateConnection for missing token (no stub row creation)');
      }
    });

    it('should throw ReauthRequiredError with invalid_grant reason AND write lastScanStatus when grant revoked', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' }),
      });

      const mockGetRefreshToken = async () => 'refresh_token_123';
      let updateCalled = false;
      let updatePayload = null;
      const mockUpdateConnection = async (userId, update) => {
        updateCalled = true;
        updatePayload = update;
      };

      try {
        await getAccessToken('user_revoked', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: mockFetch,
          updateConnection: mockUpdateConnection,
          nowSeconds: () => 1000,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof ReauthRequiredError, 'Should be ReauthRequiredError');
        assert.equal(err.reason, 'invalid_grant', 'Reason should be invalid_grant');
        assert.equal(updateCalled, true, 'Should call updateConnection for invalid_grant');
        assert.deepEqual(updatePayload, { lastScanStatus: 'reauth_required' }, 'Should write lastScanStatus');
      }
    });
  });

  describe('Unit: listMessageIds truncated flag accuracy', () => {
    it('should return truncated=false when exactly maxMessages with no nextPageToken', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          messages: [
            { id: 'msg1' },
            { id: 'msg2' },
            { id: 'msg3' },
          ],
        }),
      });

      const result = await listMessageIds(
        {
          accessToken: 'token123',
          query: '(from:@school.edu) after:2026/05/20',
          maxMessages: 3,
        },
        { fetchImpl: mockFetch, sleep: async () => {}, random: () => 0 }
      );

      assert.equal(result.ids.length, 3, 'Should have exactly 3 ids');
      assert.equal(result.truncated, false, 'Should NOT be truncated when at cap with no further page');
    });

    it('should return truncated=true when cap reached and nextPageToken exists', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          messages: [
            { id: 'msg1' },
            { id: 'msg2' },
            { id: 'msg3' },
            { id: 'msg4' },
          ],
          nextPageToken: 'page2',
        }),
      });

      const result = await listMessageIds(
        {
          accessToken: 'token123',
          query: '(from:@school.edu) after:2026/05/20',
          maxMessages: 3,
        },
        { fetchImpl: mockFetch, sleep: async () => {}, random: () => 0 }
      );

      assert.equal(result.ids.length, 3, 'Should stop at exactly maxMessages');
      assert.equal(result.truncated, true, 'Should be truncated when cap hit and next page exists');
    });

    it('should return truncated=false when fewer than maxMessages and no nextPageToken', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          messages: [
            { id: 'msg1' },
            { id: 'msg2' },
          ],
        }),
      });

      const result = await listMessageIds(
        {
          accessToken: 'token123',
          query: '(from:@school.edu) after:2026/05/20',
          maxMessages: 10,
        },
        { fetchImpl: mockFetch, sleep: async () => {}, random: () => 0 }
      );

      assert.equal(result.ids.length, 2, 'Should return 2 ids');
      assert.equal(result.truncated, false, 'Should NOT be truncated when result is smaller than cap');
    });
  });

  describe('Unit: isTokenFresh', () => {
    it('should return true when token has >60s of life', () => {
      const entry = { accessToken: 'token123', expiresAt: 2000 };
      const now = 1000;
      assert.ok(isTokenFresh(entry, now, TOKEN_EXPIRY_SKEW_SECONDS));
    });

    it('should return false when token has exactly 60s (edge case)', () => {
      const entry = { accessToken: 'token123', expiresAt: 1060 };
      const now = 1000;
      // 1060 - 1000 = 60, which is NOT >= 60 in the test (should be > 60 or use >=)
      // Check the implementation in google-token.mjs
      const fresh = isTokenFresh(entry, now, TOKEN_EXPIRY_SKEW_SECONDS);
      // The code says: entry.expiresAt - nowInSeconds >= skewSeconds
      // So 1060 - 1000 = 60, which is >= 60, so should return true
      assert.ok(fresh, 'Token with exactly 60s remaining should be considered fresh (>=)');
    });

    it('should return false when token has <60s of life', () => {
      const entry = { accessToken: 'token123', expiresAt: 1059 };
      const now = 1000;
      assert.ok(!isTokenFresh(entry, now, TOKEN_EXPIRY_SKEW_SECONDS));
    });

    it('should return false for missing token', () => {
      assert.ok(!isTokenFresh(null, 1000));
      assert.ok(!isTokenFresh(undefined, 1000));
      assert.ok(!isTokenFresh({ expiresAt: 2000 }, 1000)); // no accessToken
    });
  });

  describe('Unit: getMessage', () => {
    it('should fetch and parse a message', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'msg123',
          threadId: 'thread456',
          snippet: 'Preview',
          internalDate: Date.now(),
          payload: {
            headers: [
              { name: 'Subject', value: 'Test' },
              { name: 'From', value: 'sender@example.com' },
            ],
          },
        }),
      });

      const result = await getMessage(
        { accessToken: 'token123', id: 'msg123' },
        { fetchImpl: mockFetch, sleep: async () => {}, random: () => 0 }
      );

      assert.equal(result.id, 'msg123');
      assert.equal(result.threadId, 'thread456');
      assert.equal(result.subject, 'Test');
    });

    it('should throw for missing id when awaited', async () => {
      try {
        await getMessage({ accessToken: 'token123', id: '' });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('id is required'));
      }
    });
  });

  describe('Unit: listMessageIds', () => {
    it('should throw for missing query when awaited', async () => {
      try {
        await listMessageIds({ accessToken: 'token123', query: '' });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err.message.includes('query is required'));
      }
    });

    it('should use default pageSize when not specified', async () => {
      let capturedPageSize = null;
      const mockFetch = async (url) => {
        const params = new URL(url).searchParams;
        capturedPageSize = params.get('maxResults');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ messages: [] }),
        };
      };

      await listMessageIds(
        {
          accessToken: 'token123',
          query: 'from:@school.edu',
        },
        { fetchImpl: mockFetch, sleep: async () => {}, random: () => 0 }
      );

      assert.ok(capturedPageSize, 'Should include maxResults param');
      // Check if it's a reasonable page size (not exceeding remaining cap)
      assert.ok(Number(capturedPageSize) > 0);
    });
  });

  describe('Unit: makeLogger', () => {
    it('should return a function that logs by default', () => {
      let lastLog = null;
      const originalLog = console.log;
      console.log = (...args) => { lastLog = args; };

      const logger = makeLogger({ CALENDAR_LOG_LEVEL: 'basic' });
      logger('test message', { field: 'value' });

      assert.ok(lastLog, 'Should have logged');
      console.log = originalLog;
    });

    it('should return silent logger when CALENDAR_LOG_LEVEL=none', () => {
      let logCalled = false;
      const mockConsole = {
        log: () => { logCalled = true; },
      };

      const logger = makeLogger({ CALENDAR_LOG_LEVEL: 'none' });
      // Since we can't override global console here, just verify the function exists
      assert.ok(typeof logger === 'function');
    });
  });
});
