/**
 * Ask-answer wire-ordering parity scenario.
 *
 * iOS canon (DeepgramRecordingViewModel.swift:2108-2113 + ServerWebSocket-
 * Service.swift:581-589): when an inspector's reply consumes an in-flight
 * Stage 6 ask, the client emits TWO frames in this exact order:
 *
 *   1. `transcript` with the same `utterance_id` that …
 *   2. `ask_user_answered` will echo back as `consumed_utterance_id`.
 *
 * That ordering plus the shared UUID is what makes the backend dedupe
 * fast-path hit at `src/extraction/sonnet-stream.js:1013` instead of
 * falling through to the fuzzy text matcher (which collides on common
 * short answers like "yes" / "circuit 3").
 *
 * If the harness ever drops one of these frames or swaps the order, this
 * scenario fails loudly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { buildHarness, makeHarnessJob, type Harness } from './harness';

describe('parity harness — ask-answer wire ordering', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({
      job: makeHarnessJob([{ ref: '1', designation: 'Immersion Heater' }]),
    });
  });

  afterEach(() => {
    h.teardown();
    WS.clean();
  });

  it('emits transcript then ask_user_answered sharing the same utterance UUID', async () => {
    const utteranceId = 'utt-share-001';
    const toolCallId = 'toolu_01XYZ';

    h.injectFinal('yes', {
      utteranceId,
      inFlightToolCallId: toolCallId,
    });

    const first = (await h.nextWireMessage()) as Record<string, unknown>;
    const second = (await h.nextWireMessage()) as Record<string, unknown>;

    expect(first.type).toBe('transcript');
    expect(first.utterance_id).toBe(utteranceId);

    expect(second.type).toBe('ask_user_answered');
    expect(second.tool_call_id).toBe(toolCallId);
    expect(second.user_text).toBe('yes');
    // The dedupe anchor — backend reads consumed_utterance_id and looks it
    // up in the Set the matching transcript pre-stamped.
    expect(second.consumed_utterance_id).toBe(utteranceId);
  });

  it('a plain reply with no in-flight tool_call_id sends ONLY a transcript', async () => {
    h.injectFinal('circuit one polarity OK', { utteranceId: 'utt-plain-001' });

    const first = (await h.nextWireMessage()) as Record<string, unknown>;
    expect(first.type).toBe('transcript');

    // No second frame queued (would be unhandled otherwise).
    expect(h.server.messages.length).toBe(2); // 1 = session_start, 2 = transcript
  });
});
