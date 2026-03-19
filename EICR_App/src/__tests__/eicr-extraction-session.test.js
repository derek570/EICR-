/**
 * Tests for EICRExtractionSession — Sonnet multi-turn extraction session.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const { EICRExtractionSession, EICR_SYSTEM_PROMPT } = await import('../extraction/eicr-extraction-session.js');

describe('EICRExtractionSession', () => {
  let session;

  beforeEach(() => {
    session = new EICRExtractionSession('test-api-key', 'test-session-id');
    mockCreate.mockReset();
  });

  afterEach(() => {
    // Clean up batch timeouts to prevent leaking between tests
    if (session.batchTimeoutHandle) {
      clearTimeout(session.batchTimeoutHandle);
      session.batchTimeoutHandle = null;
    }
    session.utteranceBuffer = [];
  });

  describe('constructor', () => {
    test('should initialize with correct defaults', () => {
      expect(session.sessionId).toBe('test-session-id');
      expect(session.conversationHistory).toEqual([]);
      expect(session.extractedReadingsCount).toBe(0);
      expect(session.askedQuestions).toEqual([]);
      expect(session.turnCount).toBe(0);
      expect(session.isActive).toBe(false);
    });
  });

  describe('EICR_SYSTEM_PROMPT', () => {
    test('should be a long string with key sections', () => {
      expect(EICR_SYSTEM_PROMPT.length).toBeGreaterThan(1024); // Must be >= 1024 for caching
      expect(EICR_SYSTEM_PROMPT).toContain('EXTRACTION RULES');
      expect(EICR_SYSTEM_PROMPT).toContain('CIRCUIT FIELDS');
      expect(EICR_SYSTEM_PROMPT).toContain('SUPPLY FIELDS');
      expect(EICR_SYSTEM_PROMPT).toContain('OBSERVATIONS');
      expect(EICR_SYSTEM_PROMPT).toContain('questions_for_user');
    });
  });

  describe('messageText', () => {
    test('should return string content directly', () => {
      expect(EICRExtractionSession.messageText('hello')).toBe('hello');
    });

    test('should join content block array', () => {
      const blocks = [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }];
      expect(EICRExtractionSession.messageText(blocks)).toBe('hello world');
    });

    test('should handle blocks without text', () => {
      const blocks = [{ type: 'image' }, { type: 'text', text: 'hello' }];
      expect(EICRExtractionSession.messageText(blocks)).toBe('hello');
    });

    test('should return empty string for non-string non-array', () => {
      expect(EICRExtractionSession.messageText(null)).toBe('');
      expect(EICRExtractionSession.messageText(42)).toBe('');
    });
  });

  describe('conversationTokenEstimate', () => {
    test('should estimate 0 for empty conversation', () => {
      expect(session.conversationTokenEstimate).toBe(0);
    });

    test('should estimate roughly 4 chars per token', () => {
      session.conversationHistory = [
        { role: 'user', content: 'a'.repeat(400) }, // ~100 tokens
      ];
      expect(session.conversationTokenEstimate).toBe(100);
    });
  });

  describe('start', () => {
    test('should set isActive and start cost tracker', () => {
      session.start(null);
      expect(session.isActive).toBe(true);
    });

    test('should build circuit schedule from job state', () => {
      session.start({
        circuits: [
          { ref: '1', designation: 'Kitchen Sockets', ocpd_type: 'B', ocpd_rating: 32 }
        ]
      });

      expect(session.circuitSchedule).toContain('Circuit 1');
      expect(session.circuitSchedule).toContain('Kitchen Sockets');
    });
  });

  describe('stop', () => {
    test('should set isActive to false and return summary', () => {
      session.start(null);
      const summary = session.stop();

      expect(session.isActive).toBe(false);
      expect(summary.type).toBe('session_summary');
      expect(summary.extraction).toBeDefined();
      expect(summary.extraction.readingsExtracted).toBe(0);
    });
  });

  describe('buildUserMessage', () => {
    test('should include transcript text', () => {
      const msg = session.buildUserMessage('Zs is 0.35');
      expect(msg).toContain('NEW utterance: Zs is 0.35');
    });

    test('should include regex results when provided', () => {
      const msg = session.buildUserMessage('Zs 0.35', [{ field: 'zs', value: '0.35' }]);
      expect(msg).toContain('Regex pre-filled fields');
      expect(msg).toContain('zs');
    });

    test('should include circuit schedule on first call', () => {
      session.circuitSchedule = 'Circuit 1: Lights';
      const msg = session.buildUserMessage('test');
      expect(msg).toContain('CIRCUIT SCHEDULE');
      expect(msg).toContain('Circuit 1: Lights');
    });

    test('should not include circuit schedule on second call', () => {
      session.circuitSchedule = 'Circuit 1: Lights';
      session.buildUserMessage('first');
      const msg = session.buildUserMessage('second');
      expect(msg).not.toContain('CIRCUIT SCHEDULE');
    });

    test('should include already-asked questions', () => {
      session.askedQuestions = ['zs:1', 'r1_plus_r2:2'];
      const msg = session.buildUserMessage('test');
      expect(msg).toContain('Already asked (skip)');
      expect(msg).toContain('zs:1');
    });

    test('should include already-created observations', () => {
      session.extractedObservationTexts = ['missing earth bond at kitchen'];
      const msg = session.buildUserMessage('test');
      expect(msg).toContain('Observations already created');
      expect(msg).toContain('missing earth bond');
    });
  });

  describe('buildCircuitSchedule', () => {
    test('should return empty string for null job state', () => {
      expect(session.buildCircuitSchedule(null)).toBe('');
    });

    test('should return empty string for job state without circuits', () => {
      expect(session.buildCircuitSchedule({})).toBe('');
    });

    test('should format circuit with all fields', () => {
      const schedule = session.buildCircuitSchedule({
        circuits: [{
          ref: '1',
          designation: 'Ring Final',
          ocpd_type: 'B',
          ocpd_rating: 32,
          cable_size: '2.5',
          cable_size_earth: '1.5',
          zs: '0.35',
          r1_plus_r2: '0.47',
        }]
      });

      expect(schedule).toContain('Circuit 1: Ring Final');
      expect(schedule).toContain('ocpd=B/32A');
      expect(schedule).toContain('cable=2.5/1.5mm');
      expect(schedule).toContain('zs=0.35');
      expect(schedule).toContain('r1r2=0.47');
    });

    test('should derive circuit type from designation', () => {
      const schedule = session.buildCircuitSchedule({
        circuits: [
          { ref: '1', designation: 'Kitchen Sockets' },
          { ref: '2', designation: 'Upstairs Lighting' },
        ]
      });

      expect(schedule).toContain('Ring');
      expect(schedule).toContain('Lighting');
    });

    test('should include supply section', () => {
      const schedule = session.buildCircuitSchedule({
        circuits: [],
        supply: {
          earthingArrangement: 'TN-C-S',
          pfc: '1.2',
          ze: '0.35',
        }
      });

      expect(schedule).toContain('Supply:');
      expect(schedule).toContain('earthing=TN-C-S');
      expect(schedule).toContain('PFC=1.2kA');
      expect(schedule).toContain('Ze=0.35ohms');
    });
  });

  describe('extractJSON', () => {
    test('should extract plain JSON object', () => {
      const result = session.extractJSON('{"extracted_readings": []}');
      expect(result).toBe('{"extracted_readings": []}');
    });

    test('should extract JSON from markdown code fence', () => {
      const input = '```json\n{"extracted_readings": []}\n```';
      const result = session.extractJSON(input);
      expect(result).toBe('{"extracted_readings": []}');
    });

    test('should extract JSON from text with surrounding prose', () => {
      const input = 'Here is the result:\n{"key": "value"}\nEnd of response.';
      const result = session.extractJSON(input);
      expect(result).toBe('{"key": "value"}');
    });

    test('should handle already-trimmed JSON', () => {
      const input = '  { "test": true }  ';
      const result = session.extractJSON(input);
      expect(result).toBe('{ "test": true }');
    });
  });

  describe('utterance batching', () => {
    test('should buffer utterances and return empty result until batch is full', async () => {
      session.start(null);

      // First call: buffers, returns empty
      const r1 = await session.extractFromUtterance('utterance 1');
      expect(r1.extracted_readings).toEqual([]);
      expect(session.utteranceBuffer).toHaveLength(1);
      expect(mockCreate).not.toHaveBeenCalled();

      // Second call: still buffers
      const r2 = await session.extractFromUtterance('utterance 2');
      expect(r2.extracted_readings).toEqual([]);
      expect(session.utteranceBuffer).toHaveLength(2);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('should process batch when buffer reaches BATCH_SIZE (3)', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [
              { circuit: 1, field: 'zs', value: 0.35 }
            ],
            field_clears: [],
            circuit_updates: [],
            observations: [],
            validation_alerts: [],
            questions_for_user: [],
            confirmations: []
          })
        }],
        usage: { input_tokens: 200, output_tokens: 80 }
      };
      mockCreate.mockResolvedValue(mockResponse);

      session.start(null);
      await session.extractFromUtterance('utterance 1');
      await session.extractFromUtterance('utterance 2');
      // Third call triggers the batch
      const result = await session.extractFromUtterance('utterance 3');

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.extracted_readings).toHaveLength(1);
      expect(session.utteranceBuffer).toHaveLength(0);
    });

    test('should combine transcript texts with separator', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"extracted_readings":[]}' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('Zs is 0.35');
      await session.extractFromUtterance('on circuit 1');
      await session.extractFromUtterance('r1 plus r2 is 0.47');

      // Check that the combined text was sent
      const callArgs = mockCreate.mock.calls[0][0];
      const lastUserMsg = callArgs.messages[callArgs.messages.length - 1];
      const msgText = lastUserMsg.content[0].text;
      expect(msgText).toContain('Zs is 0.35 ... on circuit 1 ... r1 plus r2 is 0.47');
    });

    test('should merge regex results from all buffered utterances', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"extracted_readings":[]}' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('Zs 0.35', [{ field: 'zs', value: '0.35' }]);
      await session.extractFromUtterance('R2 0.12', [{ field: 'r2', value: '0.12' }]);
      await session.extractFromUtterance('more text');

      const callArgs = mockCreate.mock.calls[0][0];
      const lastUserMsg = callArgs.messages[callArgs.messages.length - 1];
      const msgText = lastUserMsg.content[0].text;
      expect(msgText).toContain('zs');
      expect(msgText).toContain('r2');
    });

    test('flushUtteranceBuffer should process partial batch', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({ extracted_readings: [{ circuit: 2, field: 'r2', value: 0.12 }] })
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('R2 is 0.12 on circuit 2');
      expect(mockCreate).not.toHaveBeenCalled();

      // Flush the partial batch
      const result = await session.flushUtteranceBuffer();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.extracted_readings).toHaveLength(1);
      expect(session.utteranceBuffer).toHaveLength(0);
    });

    test('flushUtteranceBuffer should return null when buffer is empty', async () => {
      session.start(null);
      const result = await session.flushUtteranceBuffer();
      expect(result).toBeNull();
    });

    test('stop should clear batch timeout', () => {
      session.start(null);
      // Simulate a buffered utterance with pending timeout
      session.utteranceBuffer.push({ transcriptText: 'test', regexResults: [], options: {} });
      session.batchTimeoutHandle = setTimeout(() => {}, 10000);

      session.stop();
      expect(session.batchTimeoutHandle).toBeNull();
    });
  });

  describe('extractFromUtterance (via flush)', () => {
    // These tests use flushUtteranceBuffer to trigger the API call after buffering
    test('should parse valid extraction response', async () => {
      const mockResponse = {
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [
              { circuit: 1, field: 'zs', value: 0.35, confidence: 0.9 }
            ],
            field_clears: [],
            circuit_updates: [],
            observations: [],
            validation_alerts: [],
            questions_for_user: [],
            confirmations: []
          })
        }],
        usage: {
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          input_tokens: 200,
          output_tokens: 80
        }
      };
      mockCreate.mockResolvedValue(mockResponse);

      session.start(null);
      await session.extractFromUtterance('Zs is 0.35 on circuit 1');
      const result = await session.flushUtteranceBuffer();

      expect(result.extracted_readings).toHaveLength(1);
      expect(result.extracted_readings[0].field).toBe('zs');
      expect(result.extracted_readings[0].value).toBe(0.35);
      expect(session.extractedReadingsCount).toBe(1);
      expect(session.turnCount).toBe(1);
    });

    test('should handle empty/null response text gracefully', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('hello');
      const result = await session.flushUtteranceBuffer();

      expect(result.extracted_readings).toEqual([]);
      expect(result.questions_for_user).toEqual([]);
    });

    test('should handle malformed JSON response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('test');
      const result = await session.flushUtteranceBuffer();

      expect(result.extracted_readings).toEqual([]);
      // Should still push to conversation history
      expect(session.conversationHistory).toHaveLength(2);
    });

    test('should throw if no text block in response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'image' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('test');
      await expect(session.flushUtteranceBuffer()).rejects.toThrow('No text block');
    });

    test('should track questions asked', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [],
            questions_for_user: [
              { field: 'zs', circuit: -1, question: 'Which circuit?' }
            ]
          })
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('Zs 0.35');
      await session.flushUtteranceBuffer();

      expect(session.askedQuestions).toContain('zs:-1');
    });

    test('should cap askedQuestions at 30', async () => {
      // Pre-fill with 29 questions
      session.askedQuestions = Array.from({ length: 29 }, (_, i) => `field${i}:${i}`);

      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [],
            questions_for_user: [
              { field: 'a', circuit: 1 },
              { field: 'b', circuit: 2 }
            ]
          })
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('test');
      await session.flushUtteranceBuffer();

      expect(session.askedQuestions.length).toBeLessThanOrEqual(30);
    });

    test('should dedup observations with >50% word overlap', async () => {
      session.extractedObservationTexts = ['missing earth bond at consumer unit'];

      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [],
            observations: [
              { code: 'C2', observation_text: 'Missing earth bond at consumer unit' }, // dupe
              { code: 'C3', observation_text: 'Labelling not present on distribution board' } // new
            ]
          })
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('test');
      const result = await session.flushUtteranceBuffer();

      expect(result.observations).toHaveLength(1);
      expect(result.observations[0].code).toBe('C3');
    });

    test('should include confirmations when enabled', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            extracted_readings: [{ circuit: 1, field: 'zs', value: 0.35 }],
            confirmations: [{ text: 'Circuit 1, 0.35', field: 'zs', circuit: 1 }]
          })
        }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });

      session.start(null);
      await session.extractFromUtterance('Zs 0.35 circuit 1', [], { confirmationsEnabled: true });
      const result = await session.flushUtteranceBuffer();

      // Check that CONFIRMATIONS ENABLED was sent
      const userMsg = session.conversationHistory[0].content[0].text;
      expect(userMsg).toContain('[CONFIRMATIONS ENABLED]');
      expect(result.confirmations).toHaveLength(1);
    });
  });

  describe('addMidConversationBreakpoints', () => {
    test('should not add breakpoints for short conversations', () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: 'msg' }]
      }));

      session.addMidConversationBreakpoints(messages);

      // No cache_control should be added
      const withCache = messages.filter(m =>
        Array.isArray(m.content) && m.content.some(b => b.cache_control)
      );
      expect(withCache).toHaveLength(0);
    });

    test('should add breakpoints for long conversations', () => {
      const messages = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `message ${i}` }]
      }));

      session.addMidConversationBreakpoints(messages);

      // Should have max 2 mid-conversation breakpoints
      const withCache = messages.filter(m =>
        Array.isArray(m.content) && m.content.some(b => b.cache_control)
      );
      expect(withCache.length).toBeLessThanOrEqual(2);
      expect(withCache.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('updateJobState', () => {
    test('should rebuild circuit schedule and reset flag', () => {
      session.circuitScheduleIncluded = true;
      session.updateJobState({
        circuits: [{ ref: '5', designation: 'New Circuit' }]
      });

      expect(session.circuitSchedule).toContain('Circuit 5');
      expect(session.circuitScheduleIncluded).toBe(false);
    });
  });

  describe('callWithRetry', () => {
    test('should succeed on first try', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{}' }], usage: {} });

      const result = await session.callWithRetry([{ role: 'user', content: 'test' }]);

      expect(result.content[0].text).toBe('{}');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    test('should retry on 429 errors', async () => {
      const error429 = new Error('rate limited');
      error429.status = 429;

      mockCreate
        .mockRejectedValueOnce(error429)
        .mockResolvedValue({ content: [{ type: 'text', text: '{}' }], usage: {} });

      const result = await session.callWithRetry([{ role: 'user', content: 'test' }]);

      expect(result.content[0].text).toBe('{}');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    }, 10000);

    test('should not retry on client errors (4xx)', async () => {
      const error400 = new Error('bad request');
      error400.status = 400;

      mockCreate.mockRejectedValue(error400);

      await expect(session.callWithRetry([{ role: 'user', content: 'test' }])).rejects.toThrow('bad request');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    test('should throw after max retries', async () => {
      const error500 = new Error('server error');
      error500.status = 500;

      mockCreate.mockRejectedValue(error500);

      await expect(session.callWithRetry([{ role: 'user', content: 'test' }], 2)).rejects.toThrow('server error');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  describe('compact', () => {
    test('should replace conversation history with summary', async () => {
      // Set up conversation history large enough to pass compaction guards (>2 messages, >1500 token estimate)
      const padding = 'x'.repeat(3000); // Ensure token estimate exceeds 1500 threshold
      session.conversationHistory = [
        { role: 'user', content: [{ type: 'text', text: 'utterance 1 ' + padding }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"extracted_readings":[{"circuit":1,"field":"zs","value":0.35}]}' }] },
        { role: 'user', content: [{ type: 'text', text: 'utterance 2 ' + padding }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"extracted_readings":[{"circuit":2,"field":"r1_plus_r2","value":0.47}]}' }] },
      ];
      session.turnCount = 2;
      session.extractedReadingsCount = 2;

      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            confirmed_readings: [
              { circuit: 1, field: 'zs', value: 0.35 },
              { circuit: 2, field: 'r1_plus_r2', value: 0.47 }
            ],
            pending_readings: [],
            observations_created: [],
            active_circuit: null,
            session_context: 'Testing circuits',
            questions_asked: [],
            unresolved_values: []
          })
        }],
        usage: { input_tokens: 500, output_tokens: 200 }
      });

      await session.compact();

      // Conversation should be replaced with 2 messages (summary + ack)
      expect(session.conversationHistory).toHaveLength(2);
      expect(session.conversationHistory[0].content[0].text).toContain('SESSION SUMMARY');
      expect(session.circuitScheduleIncluded).toBe(false);
      expect(session.askedQuestions).toEqual([]);
    });

    test('should continue without compaction on failure', async () => {
      const padding = 'x'.repeat(3000); // Ensure token estimate exceeds 1500 threshold
      session.conversationHistory = [
        { role: 'user', content: 'test ' + padding },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'test 2 ' + padding },
        { role: 'assistant', content: 'response 2' },
      ];
      session.turnCount = 2;

      mockCreate.mockRejectedValue(new Error('API failure'));

      // Should not throw
      await session.compact();

      // Conversation should remain unchanged (compaction failed)
      expect(session.conversationHistory).toHaveLength(4);
      // Should track the failure
      expect(session.compactionFailures).toBe(1);
    });
  });

  describe('pause and resume', () => {
    test('should pause and resume recording', () => {
      session.start(null);
      session.pause();
      session.resume();
      // No throw — just verifying the methods exist and run
      expect(session.isActive).toBe(true);
    });
  });
});
