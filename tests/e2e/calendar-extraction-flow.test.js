import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const anthropicPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'anthropic.mjs');
const anthropicUrl = new URL(`file:///${anthropicPath.replace(/\\/g, '/')}`).href;
const {
  extractEvents,
  extractFromMessage,
  buildRequest,
  buildSystemBlocks,
  EXTRACTION_STATUS,
  AnthropicExtractionError,
  resetClient,
} = await import(anthropicUrl);

const eventsPath = path.join(PROJECT_ROOT, 'src', 'lambda', 'calendar', 'backend', 'events.mjs');
const eventsUrl = new URL(`file:///${eventsPath.replace(/\\/g, '/')}`).href;
const {
  storeEvents,
  SKIP_REASON,
  resetDocumentClient,
} = await import(eventsUrl);

describe('Calendar Extraction E2E Flow Tests', () => {
  beforeEach(() => {
    resetClient();
    resetDocumentClient();
  });

  describe('Feature: Complete extraction to storage pipeline', () => {
    describe('Scenario: Extract and store valid school email events', () => {
      it('Given a valid school email, When extracted and stored, Then events reach the table', async () => {
        const extractionResults = [];
        const storedItems = [];

        const mockCreateMessage = async () => ({
          stop_reason: 'end_turn',
          parsed_output: {
            isSchoolEmail: true,
            events: [
              {
                title: 'Year 4 Zoo Excursion',
                description: 'All of Year 4 visiting the zoo',
                startsAt: '2026-03-14',
                endsAt: null,
                allDay: true,
                location: 'Central Zoo',
                category: 'excursion',
                needsAttention: true,
                actionRequired: 'Return permission slip',
                dueBy: '2026-03-10',
                confidence: 0.95,
              },
            ],
          },
        });

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'school@example.com',
              subject: 'Year 4 Zoo Excursion',
              body: 'The Year 4 class will visit the Central Zoo on March 14',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        extractionResults.push(result);

        assert.equal(result.status, EXTRACTION_STATUS.EXTRACTED, 'Should extract events');
        assert.equal(result.events.length, 1, 'Should have one event');

        // Now store them
        const mockBatchWrite = async ({ items }) => {
          storedItems.push(...items);
          return { unprocessed: [] };
        };

        const storeResult = await storeEvents(
          {
            userId: 'user1',
            extractions: result.events.map(e => ({ message: result.message, event: e })),
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.ok(storeResult.written > 0, 'Should write events to table');
        assert.equal(storedItems.length, 1, 'Should store one item');
        assert.equal(storedItems[0].title, 'Year 4 Zoo Excursion', 'Should preserve title');
        assert.equal(storedItems[0].needsAttention, true, 'Should mark as actionable');
      });
    });

    describe('Scenario: Non-school email is not stored', () => {
      it('Given a non-school email, When extracted, Then returns NOT_SCHOOL with empty events', async () => {
        const mockCreateMessage = async () => ({
          stop_reason: 'end_turn',
          parsed_output: {
            isSchoolEmail: false,
            events: [],
          },
        });

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'marketing@example.com',
              subject: 'Save 50% on Summer Clothes',
              body: 'This week only!',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(result.status, EXTRACTION_STATUS.NOT_SCHOOL, 'Should classify as non-school');
        assert.deepEqual(result.events, [], 'Should have no events');
      });
    });

    describe('Scenario: Sender filtering prevents unwatched domain from reaching model', () => {
      it('Given sender not in watched domains, When extractFromMessage runs, Then skips without API call', async () => {
        let modelCalled = false;
        const mockCreateMessage = async () => {
          modelCalled = true;
          return { stop_reason: 'end_turn', parsed_output: {} };
        };

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'random@unwatched.com',
              subject: 'Test',
              body: 'Content',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['school.edu'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(result.status, EXTRACTION_STATUS.SKIPPED_SENDER, 'Should skip sender');
        assert.equal(modelCalled, false, 'Should not call model');
      });
    });

    describe('Scenario: Empty email body is skipped without API call', () => {
      it('Given email with empty body, When extractFromMessage runs, Then skips without API call', async () => {
        let modelCalled = false;
        const mockCreateMessage = async () => {
          modelCalled = true;
          return { stop_reason: 'end_turn', parsed_output: {} };
        };

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'school@example.com',
              subject: 'Test',
              body: '',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(result.status, EXTRACTION_STATUS.SKIPPED_EMPTY, 'Should skip empty body');
        assert.equal(modelCalled, false, 'Should not call model');
      });
    });

    describe('Scenario: Batch extraction with mixed success/failure/skip', () => {
      it('Given 3 messages (valid, non-school, unwatched), When extractEvents runs, Then returns counts for each', async () => {
        let modelCalls = 0;
        const mockCreateMessage = async () => {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              stop_reason: 'end_turn',
              parsed_output: {
                isSchoolEmail: true,
                events: [{
                  title: 'Event 1',
                  startsAt: '2026-03-14',
                  allDay: true,
                  category: 'other',
                  needsAttention: false,
                  actionRequired: null,
                  dueBy: null,
                  confidence: 1,
                  description: 'Desc',
                  location: null,
                  endsAt: null,
                }],
              },
            };
          }
          // modelCalls === 2 (non-school email)
          return {
            stop_reason: 'end_turn',
            parsed_output: { isSchoolEmail: false, events: [] },
          };
        };

        const result = await extractEvents(
          {
            messages: [
              {
                id: 'msg1',
                from: 'school@example.com',
                subject: 'Event 1',
                body: 'Content 1',
                receivedAt: '2026-01-15T10:00:00Z',
              },
              {
                id: 'msg2',
                from: 'non-school@example.com',
                subject: 'Sale',
                body: 'Content 2',
                receivedAt: '2026-01-15T10:00:00Z',
              },
              {
                id: 'msg3',
                from: 'unwatched@other.com',
                subject: 'Unknown',
                body: 'Content 3',
                receivedAt: '2026-01-15T10:00:00Z',
              },
            ],
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(result.results.length, 3, 'Should process all 3 messages');
        assert.ok(result.counts[EXTRACTION_STATUS.EXTRACTED] >= 1, 'Should have extracted event');
        assert.ok(result.counts[EXTRACTION_STATUS.NOT_SCHOOL] >= 1, 'Should have non-school');
        assert.ok(result.counts[EXTRACTION_STATUS.SKIPPED_SENDER] >= 1, 'Should have skipped sender');
        assert.equal(result.events.length, 1, 'Should have 1 extractable event');
      });
    });
  });

  describe('Feature: Refusal and truncation handling', () => {
    describe('Scenario: Safety refusal prevents event storage', () => {
      it('Given model returns refusal, When extractFromMessage processes it, Then REFUSED status, no events stored', async () => {
        const mockCreateMessage = async () => ({
          stop_reason: 'refusal',
          parsed_output: null,
        });

        const storedItems = [];
        const mockBatchWrite = async ({ items }) => {
          storedItems.push(...items);
          return { unprocessed: [] };
        };

        const extractResult = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'school@example.com',
              subject: 'Test',
              body: 'Content',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(extractResult.status, EXTRACTION_STATUS.REFUSED, 'Should return REFUSED');
        assert.deepEqual(extractResult.events, [], 'Should have no events from refusal');

        // Attempt to store (should be empty)
        const storeResult = await storeEvents(
          {
            userId: 'user1',
            extractions: [],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(storedItems.length, 0, 'No items should be stored from refusal');
      });
    });

    describe('Scenario: Truncation (max_tokens) discards partial event list', () => {
      it('Given partial event list from max_tokens, When extractFromMessage processes it, Then TRUNCATED status, empty events', async () => {
        const mockCreateMessage = async () => ({
          stop_reason: 'max_tokens',
          parsed_output: {
            isSchoolEmail: true,
            events: [
              {
                title: 'Partial event',
                startsAt: '2026-03-14',
                allDay: true,
                category: 'other',
                needsAttention: false,
                actionRequired: null,
                dueBy: null,
                confidence: 1,
                description: 'Desc',
                location: null,
                endsAt: null,
              },
            ],
          },
        });

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'school@example.com',
              subject: 'Test',
              body: 'Content',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes: null,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(result.status, EXTRACTION_STATUS.TRUNCATED, 'Should return TRUNCATED');
        assert.deepEqual(result.events, [], 'Should discard partial event list');
      });
    });
  });

  describe('Feature: Duplicate event deduplication', () => {
    describe('Scenario: Same event mentioned twice in one email is stored once', () => {
      it('Given extraction with duplicate eventIds, When stored, Then only unique events are written', async () => {
        const storedItems = [];
        const mockBatchWrite = async ({ items }) => {
          storedItems.push(...items);
          return { unprocessed: [] };
        };

        const extractions = [
          {
            message: {
              id: 'msg1',
              subject: 'Event mentioned twice',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Same event twice',
            },
            event: {
              title: 'Year 4 Excursion',
              startsAt: '2026-03-14',
              allDay: true,
              category: 'excursion',
              needsAttention: true,
              actionRequired: 'Return form',
              dueBy: null,
              confidence: 1,
              description: 'Zoo trip',
              location: null,
              endsAt: null,
            },
          },
          {
            message: {
              id: 'msg1',
              subject: 'Event mentioned twice',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Same event twice',
            },
            event: {
              title: 'Year 4 Excursion',
              startsAt: '2026-03-14',
              allDay: true,
              category: 'excursion',
              needsAttention: true,
              actionRequired: 'Return form',
              dueBy: null,
              confidence: 1,
              description: 'Zoo trip',
              location: null,
              endsAt: null,
            },
          },
        ];

        const result = await storeEvents(
          {
            userId: 'user1',
            extractions,
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(storedItems.length, 1, 'Should store only one unique event');
        assert.ok(result.skipped.some(s => s.reason === SKIP_REASON.DUPLICATE), 'Should record duplicate skip');
      });
    });
  });

  describe('Feature: Date validation and horizon checking', () => {
    describe('Scenario: Event with unparseable date is skipped', () => {
      it('Given event with invalid startsAt, When stored, Then recorded as UNPARSABLE_START', async () => {
        const mockBatchWrite = async ({ items }) => ({ unprocessed: [] });

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events: [{
              title: 'Bad date event',
              startsAt: 'not a date',
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.ok(result.skipped.some(s => s.reason === SKIP_REASON.UNPARSABLE_START), 'Should skip unparseable date');
        assert.equal(result.written, 0, 'Should not write invalid event');
      });
    });

    describe('Scenario: Event too far in future is skipped', () => {
      it('Given event 401 days after receivedAt, When stored, Then recorded as OUT_OF_HORIZON', async () => {
        const mockBatchWrite = async ({ items }) => ({ unprocessed: [] });

        const receivedAt = new Date('2026-01-15T10:00:00Z');
        const futureDate = new Date(receivedAt);
        futureDate.setDate(futureDate.getDate() + 401);

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events: [{
              title: 'Far future event',
              startsAt: futureDate.toISOString().split('T')[0],
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.ok(result.skipped.some(s => s.reason === SKIP_REASON.OUT_OF_HORIZON), 'Should skip out-of-horizon event');
        assert.equal(result.written, 0, 'Should not write out-of-horizon event');
      });
    });

    describe('Scenario: Past events are accepted', () => {
      it('Given event in the past, When stored, Then is accepted and written', async () => {
        const storedItems = [];
        const mockBatchWrite = async ({ items }) => {
          storedItems.push(...items);
          return { unprocessed: [] };
        };

        const receivedAt = new Date('2026-01-15T10:00:00Z');
        const pastDate = new Date(receivedAt);
        pastDate.setDate(pastDate.getDate() - 30);

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events: [{
              title: 'Past event',
              startsAt: pastDate.toISOString().split('T')[0],
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(storedItems.length, 1, 'Should accept and write past events');
      });
    });
  });

  describe('Feature: Request structure and prompt caching', () => {
    describe('Scenario: System block carries cache_control marker', () => {
      it('Given a request, When buildRequest is called, Then system block has ephemeral cache_control', () => {
        const request = buildRequest({
          message: {
            id: 'msg1',
            from: 'test@example.com',
            subject: 'Test',
            body: 'Content',
            receivedAt: '2026-01-15T10:00:00Z',
          },
          schoolNames: ['School'],
          searchDomains: ['example.com'],
        });

        const systemBlock = request.system[0];
        assert.ok(systemBlock.cache_control, 'Should have cache_control');
        assert.equal(systemBlock.cache_control.type, 'ephemeral', 'Should use ephemeral cache');
      });
    });

    describe('Scenario: User content contains all variable data after cache breakpoint', () => {
      it('Given a request, When buildRequest is called, Then user content contains message-specific data', () => {
        const request = buildRequest({
          message: {
            id: 'msg123',
            from: 'school@example.com',
            subject: 'Assembly',
            body: 'There will be an assembly',
            receivedAt: '2026-01-15T10:00:00Z',
          },
          schoolNames: ['Test School'],
          searchDomains: ['example.com'],
        });

        const userContent = request.messages[0].content;
        assert.ok(userContent.includes('2026-01-15'), 'Should include receivedAt');
        assert.ok(userContent.includes('Test School'), 'Should include the school name');
        assert.ok(userContent.includes('example.com'), 'Should include searchDomains');
        assert.ok(userContent.includes('school@example.com'), 'Should include sender address');
        assert.ok(userContent.includes('Assembly'), 'Should include subject');
      });

      it('Given buildSystemBlocks, When called multiple times, Then returns identical blocks', () => {
        const blocks1 = buildSystemBlocks();
        const blocks2 = buildSystemBlocks();
        assert.deepEqual(blocks1, blocks2, 'System blocks must be identical for cache stability');
      });
    });
  });

  describe('Feature: Retry and batch error handling', () => {
    describe('Scenario: Connection error retries and eventually succeeds', () => {
      it('Given connection error on first attempt, When callModel retries, Then succeeds', async () => {
        let attempts = 0;
        const mockCreateMessage = async () => {
          attempts += 1;
          if (attempts < 2) {
            const error = new Error('Connection timeout');
            error.name = 'APIConnectionError';
            throw error;
          }
          return {
            stop_reason: 'end_turn',
            parsed_output: { isSchoolEmail: true, events: [] },
          };
        };

        const errorTypes = {
          APIConnectionError: class {},
          APIError: class {},
          AnthropicError: class {},
        };

        const result = await extractFromMessage(
          {
            message: {
              id: 'msg1',
              from: 'school@example.com',
              subject: 'Test',
              body: 'Content',
              receivedAt: '2026-01-15T10:00:00Z',
            },
            schoolNames: ['Test School'],
            searchDomains: ['example.com'],
          },
          {
            createMessage: mockCreateMessage,
            errorTypes,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.equal(attempts, 2, 'Should retry on connection error');
        assert.ok(result.status === EXTRACTION_STATUS.EXTRACTED || result.status === EXTRACTION_STATUS.NOT_SCHOOL, 'Should succeed eventually');
      });
    });

    describe('Scenario: Batch with unprocessed items is retried', () => {
      it('Given unprocessed items on first batch write, When putEvents retries, Then succeeds', async () => {
        let attempts = 0;
        const mockBatchWrite = async ({ items }) => {
          attempts += 1;
          if (attempts === 1) {
            return { unprocessed: items }; // All fail first time
          }
          return { unprocessed: [] }; // Succeed on retry
        };

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events: [{
              title: 'Test event',
              startsAt: '2026-03-14',
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        assert.ok(attempts > 1, 'Should retry on unprocessed items');
        assert.ok(result.written > 0, 'Should eventually write items');
      });
    });

    describe('Scenario: Unprocessed items after max attempts are returned, not thrown', () => {
      it('Given unprocessed items after exhausting retries, When putEvents completes, Then returns items (not error)', async () => {
        const mockBatchWrite = async () => ({
          unprocessed: [{ userId: 'user1', eventId: 'id1', title: 'Stuck' }],
        });

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events: [{
              title: 'Test event',
              startsAt: '2026-03-14',
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          {
            batchWrite: mockBatchWrite,
            sleep: async () => {},
            maxAttempts: 2,
            env: { CALENDAR_LOG_LEVEL: 'none' },
          }
        );

        // storeEvents should not throw; it should return results with unprocessed items
        assert.ok(result.unprocessed.length > 0, 'Should return unprocessed items, not throw');
      });
    });
  });

  describe('Feature: Idempotence - re-scanning same email produces same result', () => {
    describe('Scenario: Re-scan of same email with same event produces same eventId', () => {
      it('Given same email scanned twice, When events are extracted, Then eventIds are identical', async () => {
        const mockCreateMessage = async () => ({
          stop_reason: 'end_turn',
          parsed_output: {
            isSchoolEmail: true,
            events: [{
              title: 'Assembly',
              description: 'School assembly',
              startsAt: '2026-03-14',
              allDay: true,
              category: 'assembly',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              location: null,
              endsAt: null,
            }],
          },
        });

        const message = {
          id: 'msg123',
          from: 'school@example.com',
          subject: 'Assembly',
          body: 'There will be an assembly on March 14',
          receivedAt: '2026-01-15T10:00:00Z',
        };

        // First scan
        const result1 = await extractFromMessage(
          { message, schoolNames: ['School'], searchDomains: ['example.com'] },
          { createMessage: mockCreateMessage, errorTypes: null, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        const storedItems1 = [];
        const mockBatchWrite1 = async ({ items }) => {
          storedItems1.push(...items);
          return { unprocessed: [] };
        };

        await storeEvents(
          {
            userId: 'user1',
            extractions: result1.events.map(e => ({ message, event: e })),
            tableName: 'test-table',
          },
          { batchWrite: mockBatchWrite1, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        // Second scan (identical)
        const result2 = await extractFromMessage(
          { message, schoolNames: ['School'], searchDomains: ['example.com'] },
          { createMessage: mockCreateMessage, errorTypes: null, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        const storedItems2 = [];
        const mockBatchWrite2 = async ({ items }) => {
          storedItems2.push(...items);
          return { unprocessed: [] };
        };

        await storeEvents(
          {
            userId: 'user1',
            extractions: result2.events.map(e => ({ message, event: e })),
            tableName: 'test-table',
          },
          { batchWrite: mockBatchWrite2, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        // Both scans should produce identical eventIds (idempotent write)
        assert.equal(storedItems1.length, 1, 'First scan produces 1 item');
        assert.equal(storedItems2.length, 1, 'Second scan produces 1 item');
        assert.equal(storedItems1[0].eventId, storedItems2[0].eventId, 'EventIds must be identical for idempotence');
      });
    });
  });

  describe('Feature: Edge cases and failure modes', () => {
    describe('Scenario: Message with no receivedAt falls back to scan time for horizon check', () => {
      it('Given message with missing receivedAt, When stored, Then uses scan time as anchor', async () => {
        const mockBatchWrite = async ({ items }) => ({ unprocessed: [] });

        // Create event far in future relative to scan time
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 401);

        const result = await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: undefined, // Missing
              body: 'Body',
            },
            events: [{
              title: 'Far event',
              startsAt: futureDate.toISOString().split('T')[0],
              allDay: true,
              category: 'other',
              needsAttention: false,
              actionRequired: null,
              dueBy: null,
              confidence: 1,
              description: 'Desc',
              location: null,
              endsAt: null,
            }],
            tableName: 'test-table',
          },
          { batchWrite: mockBatchWrite, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        // Should be out of horizon relative to now
        assert.ok(result.skipped.some(s => s.reason === SKIP_REASON.OUT_OF_HORIZON), 'Should use now as anchor when receivedAt missing');
      });
    });

    describe('Scenario: Multiple batches are properly chunked at 25-item boundary', () => {
      it('Given 51 events, When stored, Then creates 3 batch requests', async () => {
        const batchRequests = [];
        const mockBatchWrite = async ({ items }) => {
          batchRequests.push(items.length);
          return { unprocessed: [] };
        };

        const events = Array.from({ length: 51 }, (_, i) => ({
          title: `Event ${i}`,
          startsAt: '2026-03-14',
          allDay: true,
          category: 'other',
          needsAttention: false,
          actionRequired: null,
          dueBy: null,
          confidence: 1,
          description: 'Desc',
          location: null,
          endsAt: null,
        }));

        await storeEvents(
          {
            userId: 'user1',
            message: {
              id: 'msg1',
              subject: 'Test',
              from: 'school@example.com',
              receivedAt: '2026-01-15T10:00:00Z',
              body: 'Body',
            },
            events,
            tableName: 'test-table',
          },
          { batchWrite: mockBatchWrite, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'none' } }
        );

        assert.equal(batchRequests.length, 3, 'Should create 3 batch requests');
        assert.equal(batchRequests[0], 25, 'First batch should have 25 items');
        assert.equal(batchRequests[1], 25, 'Second batch should have 25 items');
        assert.equal(batchRequests[2], 1, 'Third batch should have 1 item');
      });
    });
  });

  describe('Feature: Prompt caching - cache effectiveness', () => {
    describe('Scenario: Second extraction in scan shows cache_read_input_tokens > 0', () => {
      it('Given two emails extracted sequentially, When second call completes, Then usage shows cache_read_input_tokens > 0', async () => {
        const responseUsages = [];
        let callCount = 0;

        const mockCreateMessage = async () => {
          callCount += 1;
          // First call: cache write
          if (callCount === 1) {
            return {
              stop_reason: 'end_turn',
              parsed_output: { isSchoolEmail: true, events: [] },
              usage: {
                input_tokens: 500,
                output_tokens: 10,
                cache_creation_input_tokens: 500,
                cache_read_input_tokens: 0,
              },
            };
          }
          // Second call: cache hit
          return {
            stop_reason: 'end_turn',
            parsed_output: { isSchoolEmail: true, events: [] },
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 400, // Cache hit!
            },
          };
        };

        const message1 = {
          id: 'msg1',
          from: 'school@example.com',
          subject: 'Event 1',
          body: 'First email content',
          receivedAt: '2026-01-15T10:00:00Z',
        };

        const message2 = {
          id: 'msg2',
          from: 'school@example.com',
          subject: 'Event 2',
          body: 'Second email content (different body, same system prompt)',
          receivedAt: '2026-01-15T10:05:00Z',
        };

        // Extract first message
        const result1 = await extractFromMessage(
          { message: message1, schoolNames: ['School'], searchDomains: ['example.com'] },
          { createMessage: mockCreateMessage, errorTypes: null, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'verbose' } }
        );
        responseUsages.push(result1.usage);

        // Extract second message
        const result2 = await extractFromMessage(
          { message: message2, schoolNames: ['School'], searchDomains: ['example.com'] },
          { createMessage: mockCreateMessage, errorTypes: null, sleep: async () => {}, env: { CALENDAR_LOG_LEVEL: 'verbose' } }
        );
        responseUsages.push(result2.usage);

        assert.equal(responseUsages.length, 2, 'Should have usage for both calls');
        assert.equal(responseUsages[0].cacheCreationInputTokens, 500, 'First call should show cache write');
        assert.ok(responseUsages[1].cacheReadInputTokens > 0, 'Second call must show cache hit');
      });
    });
  });
});
