/**
 * PLAN-C P4d — row 8: the legacy utterance-batch response epoch (the SOURCE).
 *
 * `_processUtteranceBatch` collapses several buffered utterances into one Sonnet
 * API call. Pre-P4d it dropped every buffered `options.utteranceId`, so the
 * batched extraction result — and every legacy frame derived from it (question /
 * voice_command_response / reconnect-replay, rows 5-7) — crossed the wire with
 * no `utterance_id` and the client chime watchdog could not correlate them.
 *
 * This proves the SOURCE half of the plan's A/B batch contract: buffer utterances
 * A then B and the resulting extraction carries B's id (the newest non-empty
 * buffered epoch). Rows 5-7 (the frames that consume result.utterance_id) are
 * covered in plan-c-p4d-legacy-frames.test.js.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

const toolUseContent = (input) => [{ type: 'tool_use', name: 'record_extraction', input }];

const EMPTY_EXTRACTION = {
  extracted_readings: [],
  field_clears: [],
  circuit_updates: [],
  observations: [],
  validation_alerts: [],
  questions_for_user: [],
  confirmations: [],
};

function mockOneExtraction() {
  mockCreate.mockResolvedValue({
    content: toolUseContent({ ...EMPTY_EXTRACTION }),
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  });
}

describe('P4d row 8 — batched extraction carries the last non-empty buffered utterance id', () => {
  let session;

  beforeEach(() => {
    session = new EICRExtractionSession('test-key', 'sess-p4d-batch', 'eicr');
    mockCreate.mockReset();
    mockOneExtraction();
    session.start(null);
  });

  afterEach(() => {
    if (session.batchTimeoutHandle) {
      clearTimeout(session.batchTimeoutHandle);
      session.batchTimeoutHandle = null;
    }
    session.utteranceBuffer = [];
  });

  test('buffer A then B → result.utterance_id === B (BATCH_SIZE=2 flushes on the 2nd)', async () => {
    // First utterance buffers (returns the empty "waiting for more" result).
    const first = await session.extractFromUtterance('Zs is 0.35', [], {
      utteranceId: 'utt-A',
      confirmationsEnabled: true,
    });
    expect(first.extracted_readings).toEqual([]);

    // Second fills the batch → the combined API call fires and the result
    // carries the NEWEST buffered epoch.
    const result = await session.extractFromUtterance('on circuit 1', [], {
      utteranceId: 'utt-B',
      confirmationsEnabled: true,
    });
    expect(result).toBeTruthy();
    expect(result.utterance_id).toBe('utt-B');
    // One combined API call for the two buffered utterances.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('newest buffered id is EMPTY → falls back to the last NON-EMPTY (A)', async () => {
    await session.extractFromUtterance('Zs is 0.35', [], { utteranceId: 'utt-A' });
    const result = await session.extractFromUtterance('on circuit 1', [], { utteranceId: '' });
    expect(result.utterance_id).toBe('utt-A');
  });

  test('no buffered id at all → result.utterance_id === null (never fabricated)', async () => {
    await session.extractFromUtterance('Zs is 0.35', [], {});
    const result = await session.extractFromUtterance('on circuit 1', [], {});
    expect(result.utterance_id).toBeNull();
  });

  test('single flushed utterance also carries its id (sync-shape parity)', async () => {
    await session.extractFromUtterance('Zs is 0.35 on circuit 1', [], { utteranceId: 'utt-solo' });
    const result = await session.flushUtteranceBuffer();
    expect(result.utterance_id).toBe('utt-solo');
  });
});
