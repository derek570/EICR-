/**
 * P1 ring-script-hardening — decision-gate criterion 2 (two-layer delete
 * integration contract). Two boundaries, tested with the REAL component on
 * each side of the seam (mocking either layer alone proves only fabricated
 * output):
 *
 *   (a) real `runShadowHarness` (live mode) + `mockStream` canned model
 *       rounds emitting exactly three `clear_reading` calls for the ring
 *       fields — asserting on the surfaces that actually survive
 *       `runLiveMode`: exactly three `result.field_corrections` entries,
 *       three token-distinct `field_cleared` confirmations (each spoken
 *       exactly once), three successful `stage6_tool_call` clear rows, all
 *       three snapshot fields absent, and NO generic orphan/catch-all
 *       apology.
 *
 * The sonnet-stream ingress side (b) lives in
 * sonnet-stream-ring-delete-ingress.test.js (it needs module-level mocks
 * incompatible with importing the real shadow harness here).
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockClient } from './helpers/mockStream.js';
import {
  runShadowHarness,
  NOOP_AUDIBILITY_PROMPTS,
  CATCHALL_AUDIBILITY_PROMPTS,
} from '../extraction/stage6-shadow-harness.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function endTurnStream() {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

/** One model round with three clear_reading tool calls (the delete contract). */
function tripleClearStream(circuit = 13) {
  const fields = ['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm'];
  const events = [
    { type: 'message_start', message: { id: 'msg_clear', role: 'assistant', content: [] } },
  ];
  fields.forEach((field, i) => {
    events.push(
      {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: `tu_clear_${i}`, name: 'clear_reading', input: {} },
      },
      {
        type: 'content_block_delta',
        index: i,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ field, circuit, reason: 'user_requested_delete' }),
        },
      },
      { type: 'content_block_stop', index: i }
    );
  });
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    {
      type: 'message_stop',
    }
  );
  return events;
}

function makeLiveSession() {
  return {
    sessionId: 'sess-ring-delete',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([tripleClearStream(), endTurnStream()]),
    stateSnapshot: {
      circuits: {
        13: {
          circuit_ref: 13,
          circuit_designation: '',
          ring_r1_ohm: '0.77',
          ring_rn_ohm: '0.78',
          ring_r2_ohm: '1.19',
        },
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    _snapshot: null,
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    extractFromUtterance: jest.fn(),
  };
}

const SERVER_NOTE_13 =
  '[Server note: The assistant just read back the complete ring-continuity set ' +
  '(R1, Rn and R2) for circuit 13 and asked "All correct?". ' +
  "The user's reply follows.] ";

describe('P1 delete contract — runShadowHarness + canned triple clear_reading', () => {
  let session;
  let logger;
  let result;

  beforeEach(async () => {
    session = makeLiveSession();
    logger = makeLogger();
    result = await runShadowHarness(session, `${SERVER_NOTE_13}No. Please delete them all.`, [], {
      logger,
      // The live path threads confirmationsEnabled from the transcript
      // message; the audible contract under test IS the spoken channel.
      confirmationsEnabled: true,
    });
  });

  test('exactly three field_corrections entries for the ring fields survive runLiveMode', () => {
    expect(Array.isArray(result.field_corrections)).toBe(true);
    const clears = result.field_corrections.filter((c) => c.reason === 'clear_reading');
    expect(clears).toHaveLength(3);
    // Outbound wire canonicalisation: ring_* → ring_continuity_* legacy names.
    expect(clears.map((c) => c.field).sort()).toEqual([
      'ring_continuity_r1',
      'ring_continuity_r2',
      'ring_continuity_rn',
    ]);
    for (const c of clears) expect(c.circuit).toBe(13);
    // The Stage-6-only cleared_readings slot is stripped before return.
    expect(result.cleared_readings).toBeUndefined();
  });

  test('exactly three token-distinct field_cleared confirmations — each spoken exactly once', () => {
    const cleared = (result.confirmations ?? []).filter((c) => c.field === 'field_cleared');
    expect(cleared).toHaveLength(3);
    const tokens = cleared.map((c) => c.dedupe_token);
    expect(new Set(tokens).size).toBe(3);
    for (const t of tokens) expect(t).toMatch(/^clear_/);
    // Each text names the circuit + a cleared reading; no duplicates.
    const texts = cleared.map((c) => c.text);
    expect(new Set(texts).size).toBe(3);
    for (const t of texts) expect(t).toMatch(/^Circuit 13, .+ cleared$/);
  });

  test('three successful stage6_tool_call clear rows are logged', () => {
    const rows = logger.info.mock.calls
      .filter((c) => c[0] === 'stage6_tool_call')
      .map((c) => c[1])
      .filter((r) => r.tool === 'clear_reading');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.is_error).toBe(false);
      expect(row.outcome).toBe('ok');
    }
  });

  test('all three ring fields are absent from the snapshot after the turn', () => {
    const bucket = session.stateSnapshot.circuits[13];
    expect(bucket.ring_r1_ohm ?? null).toBeNull();
    expect(bucket.ring_rn_ohm ?? null).toBeNull();
    expect(bucket.ring_r2_ohm ?? null).toBeNull();
  });

  test('no generic orphan/catch-all apology rides the confirmations', () => {
    const apologyFamilies = new Set([...NOOP_AUDIBILITY_PROMPTS, ...CATCHALL_AUDIBILITY_PROMPTS]);
    for (const c of result.confirmations ?? []) {
      expect(apologyFamilies.has(c.text)).toBe(false);
    }
  });
});
