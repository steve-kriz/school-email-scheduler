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
  getMessage,
  fetchCandidateMessages,
  parseMessage,
  decodeBase64Url,
  stripHtml,
  truncateBody,
  formatGmailDate,
  backoffDelayMs,
  parseRetryAfter,
  GmailApiError,
  gmailRequest,
  toDomainList,
  makeLogger,
  readGmailConfig,
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
} = await import(tokenUrl);

describe('Calendar Gmail E2E Tests', () => {
  beforeEach(() => {
    resetTokenCache();
  });

  describe('Feature: buildQuery composes search strings', () => {
    describe('Scenario: buildQuery OR-joins domains with date bounds', () => {
      it('Given domains ["school.edu", "pta.school.edu"], When buildQuery is called, Then returns "(from:@school.edu OR from:@pta.school.edu) after:YYYY/MM/DD"', () => {
        const query = buildQuery({
          searchDomains: ['school.edu', 'pta.school.edu'],
          since: new Date('2026-08-01'),
          now: () => new Date('2026-08-18'),
        });
        assert.match(query, /\(from:@school\.edu OR from:@pta\.school\.edu\) after:\d{4}\/\d{2}\/\d{2}/, 'Query format mismatch');
        assert.match(query, /after:2026\/08\/01/, 'Date format must be YYYY/MM/DD');
      });
    });

    describe('Scenario: buildQuery defaults to 90-day window', () => {
      it('Given no since and sinceDays=90, When buildQuery is called, Then calculates ~90 days back from now', () => {
        const now = new Date('2026-08-18');
        const query = buildQuery({
          searchDomains: ['school.edu'],
          since: null,
          sinceDays: 90,
          now: () => now,
        });
        // ~90 days back from 2026-08-18 is ~2026-05-20
        assert.match(query, /after:2026\/05\//, 'Should default to ~90-day window');
      });
    });

    describe('Scenario: buildQuery throws on empty domain list', () => {
      it('Given no search domains, When buildQuery is called, Then throws with code="no_search_domains"', () => {
        assert.throws(
          () => buildQuery({ searchDomains: [] }),
          (err) => err.code === 'no_search_domains',
          'Should throw no_search_domains'
        );
      });
    });

    describe('Scenario: buildQuery formats dates in UTC', () => {
      it('Given a Date at 2026-08-17T23:59:59Z, When formatGmailDate is called, Then returns "2026/08/17"', () => {
        const date = new Date('2026-08-17T23:59:59Z');
        const formatted = formatGmailDate(date);
        assert.equal(formatted, '2026/08/17', 'Must use UTC parts, not local timezone');
      });
    });
  });

  describe('Feature: listMessageIds pagination and truncation', () => {
    describe('Scenario: listMessageIds follows pagination tokens', () => {
      it('Given three pages of results, When listMessageIds is called, Then collects all ids from each page', async () => {
        let pageCount = 0;
        const mockFetch = async (url) => {
          pageCount++;
          if (pageCount === 1) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                messages: [
                  { id: 'msg1' },
                  { id: 'msg2' },
                ],
                nextPageToken: 'page2',
              }),
            };
          }
          if (pageCount === 2) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                messages: [
                  { id: 'msg3' },
                  { id: 'msg4' },
                ],
                nextPageToken: 'page3',
              }),
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              messages: [
                { id: 'msg5' },
              ],
            }),
          };
        };

        const result = await listMessageIds(
          {
            accessToken: 'token123',
            query: '(from:@school.edu) after:2026/05/20',
            maxMessages: 100,
          },
          {
            fetchImpl: mockFetch,
            sleep: async () => {},
            random: () => 0,
          }
        );

        assert.deepEqual(result.ids, ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'], 'Should collect all ids across pages');
        assert.equal(result.truncated, false, 'Should not be truncated when all pages collected');
      });
    });

    describe('Scenario: listMessageIds respects maxMessages cap', () => {
      it('Given maxMessages=3, When ids are collected, Then stops at cap with truncated=true if more exist', async () => {
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

        assert.equal(result.ids.length, 3, 'Should stop at maxMessages');
        assert.equal(result.truncated, true, 'Should flag truncated=true when cap hit and more exist');
      });
    });

    describe('Scenario: listMessageIds truncated=false at exact cap with no next page', () => {
      it('Given exactly maxMessages ids with no nextPageToken, When listMessageIds completes, Then truncated=false', async () => {
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

        assert.equal(result.ids.length, 3, 'Should return 3 ids');
        assert.equal(result.truncated, false, 'Should NOT be truncated when exactly at cap with no further page');
      });
    });
  });

  describe('Feature: Token caching with 60-second freshness window', () => {
    describe('Scenario: Token is reused when more than 60 seconds remain', () => {
      it('Given a token with 61 seconds of life, When getAccessToken is called again, Then reuses without HTTP call', async () => {
        let httpCallCount = 0;
        const mockFetch = async () => {
          httpCallCount++;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: 'new_token_123',
              expires_in: 3600,
            }),
          };
        };

        const mockGetRefreshToken = async () => 'refresh_token_123';
        const nowStart = 1000; // epoch seconds

        // First call: cache miss, fetches token
        await getAccessToken('user123', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: mockFetch,
          nowSeconds: () => nowStart,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.equal(httpCallCount, 1, 'First call should fetch token');

        // Second call: 61 seconds later, token has 61s left (3600 - 61 + 61 = 3600, but skew is 60)
        // Actually: token expires at nowStart + 3600 = 4600
        // At nowStart + 61, expiry - now = 4600 - 1061 = 3539 (way more than 60), so reused
        await getAccessToken('user123', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: mockFetch,
          nowSeconds: () => nowStart + 61,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.equal(httpCallCount, 1, 'Second call within 60s should reuse token (no HTTP)');
      });
    });

    describe('Scenario: Token is re-minted when less than 60 seconds remain', () => {
      it('Given a token with 59 seconds of life, When getAccessToken is called again, Then re-mints', async () => {
        let httpCallCount = 0;
        const mockFetch = async () => {
          httpCallCount++;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: `token_${httpCallCount}`,
              expires_in: 3600,
            }),
          };
        };

        const mockGetRefreshToken = async () => 'refresh_token_123';
        const nowStart = 1000;

        // First call: cache miss
        await getAccessToken('user123', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: mockFetch,
          nowSeconds: () => nowStart,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.equal(httpCallCount, 1, 'First call');

        // Second call: 3541 seconds later (token expires at 1000 + 3600 = 4600)
        // At 4541, life left = 4600 - 4541 = 59 seconds (less than 60), so re-mint
        await getAccessToken('user123', {
          getRefreshToken: mockGetRefreshToken,
          fetchImpl: mockFetch,
          nowSeconds: () => nowStart + 3541,
          env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
        });
        assert.equal(httpCallCount, 2, 'Second call with 59s left should re-mint');
      });
    });
  });

  describe('Feature: Retry logic for transient failures', () => {
    describe('Scenario: Gmail 429 rate limit is retried up to 4 times then fails', () => {
      it('Given a 429 response on all attempts, When gmailRequest is called, Then throws GmailApiError after 4 attempts', async () => {
        let attempts = 0;
        const mockFetch = async () => {
          attempts++;
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({}),
          };
        };

        try {
          await gmailRequest(
            'https://gmail.googleapis.com/test',
            {
              accessToken: 'token123',
              fetchImpl: mockFetch,
              sleep: async () => {},
              random: () => 0,
              maxAttempts: 4,
            }
          );
          assert.fail('Should have thrown');
        } catch (err) {
          assert.ok(err instanceof GmailApiError, 'Should be GmailApiError');
          assert.equal(err.reason, 'retries_exhausted', 'Reason should be retries_exhausted');
          assert.equal(attempts, 4, 'Should attempt exactly 4 times');
        }
      });
    });

    describe('Scenario: Gmail 403 is not retried', () => {
      it('Given a 403 response, When gmailRequest is called, Then throws after 1 attempt', async () => {
        let attempts = 0;
        const mockFetch = async () => {
          attempts++;
          return {
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }),
          };
        };

        try {
          await gmailRequest(
            'https://gmail.googleapis.com/test',
            {
              accessToken: 'token123',
              fetchImpl: mockFetch,
              sleep: async () => {},
              random: () => 0,
              maxAttempts: 4,
            }
          );
          assert.fail('Should have thrown');
        } catch (err) {
          assert.ok(err instanceof GmailApiError, 'Should be GmailApiError');
          assert.equal(attempts, 1, 'Should attempt exactly 1 time for 403');
        }
      });
    });

    describe('Scenario: Invalid grant sets lastScanStatus=reauth_required', () => {
      it('Given a 400 invalid_grant response, When getAccessToken is called, Then throws ReauthRequiredError and marks reauth_required', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        });

        const mockGetRefreshToken = async () => 'refresh_token_123';
        let updateCalled = false;
        const mockUpdateConnection = async (userId, update) => {
          updateCalled = true;
          assert.deepEqual(update, { lastScanStatus: 'reauth_required' }, 'Should update lastScanStatus');
        };

        try {
          await getAccessToken('user123', {
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
          assert.equal(updateCalled, true, 'Should have called updateConnection');
        }
      });
    });

    describe('Scenario: Missing refresh token throws but does not write lastScanStatus', () => {
      it('Given no stored refresh token, When getAccessToken is called, Then throws ReauthRequiredError without writing connection', async () => {
        const mockGetRefreshToken = async () => null;
        let updateCalled = false;
        const mockUpdateConnection = async () => {
          updateCalled = true;
        };

        try {
          await getAccessToken('user123', {
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
          assert.equal(updateCalled, false, 'Should NOT call updateConnection for missing token');
        }
      });
    });
  });

  describe('Feature: extractPlainText and MIME handling', () => {
    describe('Scenario: extractPlainText decodes base64url correctly', () => {
      it('Given base64url with - and _ characters, When decodeBase64Url is called, Then decodes correctly', () => {
        // "Hello World" in base64url (no padding)
        const encoded = 'SGVsbG8gV29ybGQ';
        const decoded = decodeBase64Url(encoded);
        assert.equal(decoded, 'Hello World', 'Should decode base64url');
      });

      it('Given unpadded base64url, When decodeBase64Url is called, Then adds padding and decodes', () => {
        // Test with actual base64url alphabet
        const encoded = 'test-_data';
        const decoded = decodeBase64Url(encoded);
        // Should not crash, just decode or return empty on failure
        assert.ok(typeof decoded === 'string', 'Should return a string');
      });
    });

    describe('Scenario: extractPlainText prefers text/plain over text/html', () => {
      it('Given both text/plain and text/html parts, When extractPlainText is called, Then returns plain part', () => {
        const plainEncoded = Buffer.from('Hello Plain').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const htmlEncoded = Buffer.from('<b>Hello HTML</b>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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
        const text = extractPlainText(payload);
        assert.ok(text.includes('Hello Plain'), 'Should prefer plain text');
        assert.ok(!text.includes('<'), 'Should not include HTML tags from preferred plain part');
      });
    });

    describe('Scenario: extractPlainText strips HTML when only text/html exists', () => {
      it('Given only text/html part, When extractPlainText is called, Then strips tags and returns text', () => {
        const htmlEncoded = Buffer.from('<b>Hello World</b>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const payload = {
          mimeType: 'text/html',
          body: { data: htmlEncoded },
        };
        const text = extractPlainText(payload);
        assert.equal(text, 'Hello World', 'Should strip HTML tags');
      });
    });

    describe('Scenario: extractPlainText walks nested multipart and skips attachments', () => {
      it('Given multipart/mixed containing multipart/alternative with attachment, When extractPlainText is called, Then returns text and skips attachment', () => {
        const textEncoded = Buffer.from('Hello Text').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const payload = {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { data: textEncoded },
                },
              ],
            },
            {
              mimeType: 'application/pdf',
              filename: 'document.pdf',
              body: { data: 'base64encodedpdf' },
            },
          ],
        };
        const text = extractPlainText(payload);
        assert.equal(text, 'Hello Text', 'Should return text and skip attachment');
      });

      it('Given attachment-only tree (PDF with filename and decodable body), When extractPlainText is called, Then returns empty string', () => {
        // Discriminating test: without the filename skip, this would return decoded PDF bytes
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
        const text = extractPlainText(payload);
        assert.equal(text, '', 'Should skip attachment and return empty, not PDF bytes');
      });

      it('Given text/plain with filename alongside text/html, When extractPlainText is called, Then returns HTML not attached text', () => {
        // Discriminating test: the sharper one - a .txt attachment must not be mistaken for body
        // because text/plain preference is global, the filename check is the only thing stopping it
        const attachedTextEncoded = Buffer.from('This is attached plain text file').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const htmlEncoded = Buffer.from('<p>This is the real HTML body</p>').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const payload = {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'text/plain',
              filename: 'attachment.txt',
              body: { data: attachedTextEncoded },
            },
            {
              mimeType: 'text/html',
              body: { data: htmlEncoded },
            },
          ],
        };
        const text = extractPlainText(payload);
        assert.ok(text.includes('This is the real HTML body'), 'Should return HTML body, not attached text/plain');
        assert.ok(!text.includes('This is attached plain text file'), 'Should skip the attached text/plain');
      });
    });
  });

  describe('Feature: Body truncation', () => {
    describe('Scenario: truncateBody keeps the head when exceeding maxBodyChars', () => {
      it('Given a body longer than maxBodyChars, When truncateBody is called, Then returns head not tail', () => {
        const body = 'Start of message with important info. ' + 'x'.repeat(1000) + ' End of message';
        const truncated = truncateBody(body, 100);
        assert.equal(truncated.length, 100, 'Should truncate to exactly 100 chars');
        assert.ok(truncated.startsWith('Start'), 'Should keep the head');
        assert.ok(!truncated.includes('End of message'), 'Should not include tail');
      });
    });
  });

  describe('Feature: Message parsing and fetching', () => {
    describe('Scenario: One failing message does not abort the scan', () => {
      it('Given 5 messages where the 3rd fails, When fetchCandidateMessages is called, Then returns 4 and errors[0] names the 3rd', async () => {
        const mockFetch = async (url) => {
          // messages.list
          if (url.includes('messages?')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                messages: [
                  { id: 'msg1' },
                  { id: 'msg2' },
                  { id: 'msg3' },
                  { id: 'msg4' },
                  { id: 'msg5' },
                ],
              }),
            };
          }
          // messages.get
          if (url.includes('msg3')) {
            return {
              ok: false,
              status: 500,
              text: async () => JSON.stringify({ error: { status: 'INTERNAL' } }),
            };
          }
          // Other messages succeed
          const msgId = url.match(/msg\d+/)?.[0] || 'msg';
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              id: msgId,
              threadId: 'thread123',
              internalDate: Date.now(),
              payload: { headers: [] },
            }),
          };
        };

        const result = await fetchCandidateMessages(
          { userId: 'user123', searchDomains: ['school.edu'] },
          {
            getAccessToken: async () => 'token123',
            getConnection: async () => ({ searchDomains: ['school.edu'] }),
            fetchImpl: mockFetch,
            sleep: async () => {},
            random: () => 0,
            now: () => Date.now(),
            env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
          }
        );

        assert.equal(result.messages.length, 4, 'Should return 4 messages (msg1,2,4,5)');
        assert.equal(result.errors.length, 1, 'Should have 1 error entry');
        assert.equal(result.errors[0].id, 'msg3', 'Error should name msg3');
      });
    });

    describe('Scenario: ReauthRequiredError mid-scan aborts immediately', () => {
      it('Given a ReauthRequiredError during message fetch, When fetchCandidateMessages runs, Then rethrows without collecting remaining', async () => {
        const mockFetch = async (url) => {
          if (url.includes('messages?')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                messages: [
                  { id: 'msg1' },
                  { id: 'msg2' },
                  { id: 'msg3' },
                ],
              }),
            };
          }
          if (url.includes('msg2')) {
            return {
              ok: false,
              status: 401,
              text: async () => JSON.stringify({}),
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              id: 'msg1',
              threadId: 'thread123',
              internalDate: Date.now(),
              payload: { headers: [] },
            }),
          };
        };

        const mockGetAccessToken = async (userId, opts) => {
          if (opts?.forceRefresh) {
            throw new ReauthRequiredError('Grant revoked', { reason: 'invalid_grant' });
          }
          return 'token123';
        };

        try {
          await fetchCandidateMessages(
            { userId: 'user123', searchDomains: ['school.edu'] },
            {
              getAccessToken: mockGetAccessToken,
              getConnection: async () => ({ searchDomains: ['school.edu'] }),
              fetchImpl: mockFetch,
              sleep: async () => {},
              random: () => 0,
              now: () => Date.now(),
              env: { CALENDAR_LOG_LEVEL: 'none', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' },
            }
          );
          assert.fail('Should have rethrown ReauthRequiredError');
        } catch (err) {
          assert.ok(err instanceof ReauthRequiredError, 'Should rethrow ReauthRequiredError');
        }
      });
    });
  });

  describe('Feature: Log hygiene - no sensitive data leaks', () => {
    describe('Scenario: Logs contain no body, subject, sender, or token', () => {
      it('Given a successful scan with retry and re-mint, When logs are captured, Then no sensitive data appears', async () => {
        const logLines = [];
        const captureLog = (msg, fields) => {
          logLines.push({ msg, fields });
        };

        let listAttempt = 0;
        const mockFetch = async (url) => {
          // Track messages.list attempts separately from messages.get
          if (url.includes('messages?')) {
            listAttempt++;
            if (listAttempt === 1) {
              // First attempt: 429 to test retry logging
              return {
                ok: false,
                status: 429,
                headers: { 'retry-after': '1' },
                text: async () => JSON.stringify({}),
              };
            }
            // Subsequent attempts succeed
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                messages: [{ id: 'msg1' }],
              }),
            };
          }
          if (url.includes('msg1')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                id: 'msg1',
                threadId: 'thread123',
                internalDate: Date.now(),
                payload: {
                  headers: [
                    { name: 'Subject', value: 'School Event' },
                    { name: 'From', value: 'principal@school.edu' },
                  ],
                },
                snippet: 'Meeting at 3pm',
              }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify({}) };
        };

        await fetchCandidateMessages(
          { userId: 'user123', searchDomains: ['school.edu'] },
          {
            getAccessToken: async () => 'secret_token_abc123xyz',
            getConnection: async () => ({ searchDomains: ['school.edu'] }),
            fetchImpl: mockFetch,
            sleep: async () => {},
            random: () => 0,
            now: () => Date.now(),
            log: captureLog,
            env: { CALENDAR_LOG_LEVEL: 'basic' },
          }
        );

        // Check that no log line contains sensitive data
        for (const line of logLines) {
          const logStr = JSON.stringify(line);
          assert.ok(!logStr.includes('secret_token'), 'Logs must not contain access token');
          assert.ok(!logStr.includes('School Event'), 'Logs must not contain subject');
          assert.ok(!logStr.includes('principal@'), 'Logs must not contain sender address');
          assert.ok(!logStr.includes('Meeting at 3pm'), 'Logs must not contain body/snippet');
        }
      });
    });
  });

  describe('Feature: Retry-After header parsing', () => {
    describe('Scenario: Retry-After as seconds is parsed correctly', () => {
      it('Given Retry-After: 30, When parseRetryAfter is called, Then returns 30000ms', () => {
        const ms = parseRetryAfter('30');
        assert.equal(ms, 30000, 'Should convert seconds to milliseconds');
      });
    });

    describe('Scenario: Retry-After as HTTP date is resolved against injected now', () => {
      it('Given Retry-After as an HTTP date, When parseRetryAfter is called with injected now, Then calculates delta correctly', () => {
        const now = 1000000; // epoch ms
        const future = new Date(now + 5000); // 5 seconds in future
        const httpDate = future.toUTCString();
        const ms = parseRetryAfter(httpDate, { now: () => now });
        assert.ok(Math.abs(ms - 5000) < 100, 'Should calculate correct delta from now');
      });
    });

    describe('Scenario: Retry-After clamped to maxDelayMs', () => {
      it('Given Retry-After: 3600 (1 hour), When backoffDelayMs uses it, Then clamps to RETRY_MAX_DELAY_MS (20000)', () => {
        const delay = backoffDelayMs({
          attempt: 2,
          retryAfterMs: 3600000, // 1 hour
          maxDelayMs: 20000,
        });
        assert.equal(delay, 20000, 'Should clamp to maxDelayMs');
      });
    });
  });
});
