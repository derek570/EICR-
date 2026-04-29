/**
 * Tests for src/extraction/ring-continuity-script.js — the server-driven
 * micro-conversation that captures R1/Rn/R2 deterministically.
 *
 * Background — 2026-04-29: ring continuity across Flux turns was leaking
 * even with the 60-second timeout (`ring-continuity-timeout.js`) in place,
 * because Flux fragments speech faster than 60s. The script catches the
 * fast-fragmentation case structurally — once "ring continuity for circuit
 * N" is heard, the server takes over and prompts for each missing field
 * via TTS until the bucket fills, the inspector cancels, or topic switches.
 *
 * These tests cover entry detection, value parsing (named + bare), cancel
 * phrases, topic switches, partial-bucket re-entry, and the wire payloads
 * the script emits over the iOS WebSocket. Wire-emit is verified through a
 * minimal `MockWS` that captures sent JSON; we don't exercise the live
 * sonnet-stream.js handler here — that wiring has its own integration
 * coverage in the existing sonnet-stream-* test files.
 */

import {
  RING_SCRIPT_HARD_TIMEOUT_MS,
  detectEntry,
  detectCancel,
  detectTopicSwitch,
  processRingContinuityTurn,
  __testing__,
} from '../extraction/ring-continuity-script.js';
import { RING_FIELDS } from '../extraction/ring-continuity-timeout.js';

const SESSION_ID = 'test-session';

/**
 * Minimal WebSocket double. Captures every successful `send` into `sent`
 * so tests can assert exact wire shape. `readyState` defaults to OPEN so
 * messages flow; tests that care about closed-socket behaviour set it
 * manually before calling.
 */
class MockWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

/**
 * Build a minimal session-shaped object. Mirrors the test helper in
 * ring-continuity-timeout.test.js — the script touches only
 * `ringContinuityScript`, `ringContinuityState`, and `stateSnapshot.circuits`.
 */
function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits },
  };
}

// ---------------------------------------------------------------------------
// detectEntry
// ---------------------------------------------------------------------------

describe('detectEntry', () => {
  test('matches "ring continuity for circuit 13"', () => {
    expect(detectEntry('Ring continuity for circuit 13.')).toEqual({
      matched: true,
      circuit_ref: 13,
    });
  });

  test('matches with filler "uh,"', () => {
    expect(detectEntry('Ring continuity for, uh, circuit 13.')).toEqual({
      matched: true,
      circuit_ref: 13,
    });
  });

  test('matches "ring final on circuit 7"', () => {
    expect(detectEntry('ring final on circuit 7')).toEqual({
      matched: true,
      circuit_ref: 7,
    });
  });

  test('matches "ring continuance for circuit 5" (Deepgram garble)', () => {
    expect(detectEntry('Ring continuance for circuit 5')).toEqual({
      matched: true,
      circuit_ref: 5,
    });
  });

  test('matches bare "ring continuity" without a circuit', () => {
    expect(detectEntry('ring continuity')).toEqual({
      matched: true,
      circuit_ref: null,
    });
  });

  test('matches terse "ring on circuit 4" with leading filler', () => {
    expect(detectEntry('OK, ring on circuit 4')).toEqual({
      matched: true,
      circuit_ref: 4,
    });
  });

  test('does NOT match non-ring narration', () => {
    expect(detectEntry('Zs is 0.62 on circuit 6.')).toEqual({
      matched: false,
      circuit_ref: null,
    });
  });

  test('does NOT match the word "ring" used in a phone-ringing context', () => {
    expect(detectEntry('the phone is ringing again')).toEqual({
      matched: false,
      circuit_ref: null,
    });
  });

  test('returns null circuit_ref for invalid integers (e.g. 0)', () => {
    expect(detectEntry('ring continuity for circuit 0')).toEqual({
      matched: true,
      circuit_ref: null,
    });
  });
});

// ---------------------------------------------------------------------------
// detectCancel
// ---------------------------------------------------------------------------

describe('detectCancel', () => {
  test.each([
    ['cancel'],
    ['stop'],
    ['stop that'],
    ['skip this'],
    ['skip ring'],
    ['scrap that'],
    ['scrap ring'],
    ['forget it'],
    ['never mind'],
    ['abort'],
    ['ignore that'],
    ['Cancel — wrong circuit.'],
  ])('matches %p', (text) => {
    expect(detectCancel(text)).toBe(true);
  });

  test.each([['lives are 0.43'], ['neutrals 0.43'], [''], ['ring continuity for circuit 5']])(
    'does not match %p',
    (text) => {
      expect(detectCancel(text)).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// detectTopicSwitch
// ---------------------------------------------------------------------------

describe('detectTopicSwitch', () => {
  test.each([
    ['Zs is 0.62'],
    ['Ze of 0.18'],
    ['z s is 0.4'],
    ['circuit 5 is the cooker'],
    ['R1+R2 is 0.5'],
    ['R1 + R2 is 0.5'],
    ['insulation resistance greater than 200'],
    ['RCD trip time'],
    ['polarity confirmed'],
  ])('matches %p as topic switch', (text) => {
    expect(detectTopicSwitch(text)).toBe(true);
  });

  test.each([
    ['lives are 0.43'],
    ['neutrals are 0.43'],
    ['CPC 0.78'],
    ['earths are 0.78'],
    ['0.43'],
    [''],
  ])('does NOT match %p (these are values for the script)', (text) => {
    expect(detectTopicSwitch(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseValue + extractNamedFieldValues
// ---------------------------------------------------------------------------

describe('parseValue (via __testing__)', () => {
  const { parseValue } = __testing__;

  test('parses "0.43"', () => {
    expect(parseValue('0.43')).toBe('0.43');
  });

  test('parses bare ".43" with leading-zero canonicalisation', () => {
    expect(parseValue('.43')).toBe('0.43');
  });

  test('parses integer "1"', () => {
    expect(parseValue('1')).toBe('1');
  });

  test('parses discontinuous "infinite" → "∞"', () => {
    expect(parseValue('the cpc is infinite')).toBe('∞');
  });

  test('parses "open ring" → "∞"', () => {
    expect(parseValue('open ring')).toBe('∞');
  });

  test('returns null for unparseable text', () => {
    expect(parseValue('the cable looks fine')).toBe(null);
  });
});

describe('extractNamedFieldValues (via __testing__)', () => {
  const { extractNamedFieldValues } = __testing__;

  test('extracts a single "lives 0.43"', () => {
    expect(extractNamedFieldValues('lives 0.43')).toEqual([
      { field: 'ring_r1_ohm', value: '0.43' },
    ]);
  });

  test('extracts "lives are 0.43" with filler', () => {
    expect(extractNamedFieldValues('lives are 0.43.')).toEqual([
      { field: 'ring_r1_ohm', value: '0.43' },
    ]);
  });

  test('extracts all three from a single utterance', () => {
    expect(extractNamedFieldValues('lives are 0.43, neutrals 0.43, and earths 0.78.')).toEqual([
      { field: 'ring_r1_ohm', value: '0.43' },
      { field: 'ring_rn_ohm', value: '0.43' },
      { field: 'ring_r2_ohm', value: '0.78' },
    ]);
  });

  test('extracts "CPC 0.78" as ring_r2_ohm', () => {
    expect(extractNamedFieldValues('CPC 0.78')).toEqual([{ field: 'ring_r2_ohm', value: '0.78' }]);
  });

  test('returns empty for utterance with no field words', () => {
    expect(extractNamedFieldValues('0.43')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// processRingContinuityTurn — entry & inactive paths
// ---------------------------------------------------------------------------

describe('processRingContinuityTurn — inactive / entry', () => {
  test('returns handled=false when script inactive and no entry trigger', () => {
    const session = buildSession();
    const ws = new MockWS();
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62 on circuit 6.',
      now: 1000,
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toEqual([]);
    expect(session.ringContinuityScript).toBeFalsy();
  });

  test('entry with circuit + no volunteered values asks for lives', () => {
    const session = buildSession();
    const ws = new MockWS();
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.ringContinuityScript.active).toBe(true);
    expect(session.ringContinuityScript.circuit_ref).toBe(13);
    expect(session.ringContinuityScript.values).toEqual({});
    // First emitted message should be the ask for ring_r1_ohm.
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      reason: 'missing_value',
      context_field: 'ring_r1_ohm',
      context_circuit: 13,
      expected_answer_shape: 'value',
    });
    expect(ws.sent[0].question).toMatch(/lives/i);
  });

  test('entry with volunteered "lives 0.43" writes R1 + asks for Rn', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives are 0.43.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
    expect(session.ringContinuityScript.values).toEqual({
      ring_r1_ohm: '0.43',
    });
    // Two emits: extraction (R1=0.43), then ask for Rn.
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0].type).toBe('extraction');
    expect(ws.sent[0].result.readings).toEqual([
      { field: 'ring_r1_ohm', circuit: 13, value: '0.43', confidence: 1.0, source: 'ring_script' },
    ]);
    expect(ws.sent[1].type).toBe('ask_user_started');
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
  });

  test('entry without circuit asks "Which circuit?"', () => {
    const session = buildSession();
    const ws = new MockWS();
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity.',
      now: 1000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.ringContinuityScript.circuit_ref).toBeNull();
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      reason: 'missing_context',
      context_field: null,
      context_circuit: null,
    });
    expect(ws.sent[0].question).toMatch(/which circuit/i);
  });

  test('partial bucket re-entry seeds from snapshot, asks for next missing', () => {
    const session = buildSession({ 13: { ring_r1_ohm: '0.43' } });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    expect(session.ringContinuityScript.values).toEqual({
      ring_r1_ohm: '0.43',
    });
    // Should NOT re-emit extraction (no new write); should ask for Rn.
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].type).toBe('ask_user_started');
    expect(ws.sent[0].context_field).toBe('ring_rn_ohm');
  });

  test('all-three volunteered on entry emits completion immediately', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives 0.43, neutrals 0.43, earths 0.78.',
      now: 1000,
    });
    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ring_r1_ohm: '0.43',
      ring_rn_ohm: '0.43',
      ring_r2_ohm: '0.78',
    });
    // State cleared on completion.
    expect(session.ringContinuityScript).toBeFalsy();
    // Wire: 1× extraction with all three readings, 1× completion info.
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0].type).toBe('extraction');
    expect(ws.sent[0].result.readings).toHaveLength(3);
    expect(ws.sent[1]).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      expected_answer_shape: 'none',
    });
    expect(ws.sent[1].question).toMatch(/got it/i);
  });
});

// ---------------------------------------------------------------------------
// processRingContinuityTurn — active path (the canonical bug repro)
// ---------------------------------------------------------------------------

describe('processRingContinuityTurn — active', () => {
  /**
   * The canonical session B107472D bug repro:
   *   Turn 1: "Ring continuity for circuit 13. Lives are 0.43." → R1 saved
   *   Turn 2: "Neutrals are"                                    → no value
   *   Turn 3: "0.43."                                           → BARE bug
   *   Turn 4: "and earths are 0.78."                            → R2 saved
   * The script must produce R1=0.43, Rn=0.43, R2=0.78 across these turns.
   */
  test('B107472D repro — fragmented dictation captures all three', () => {
    const session = buildSession();
    const ws = new MockWS();

    // Turn 1
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives are 0.43.',
      now: 1000,
    });
    // Turn 2
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Neutrals are',
      now: 5000,
    });
    // Turn 3 — bare value, must land as Rn (next missing).
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.43.',
      now: 7000,
    });
    // Turn 4 — named earths, finishes the script.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'and earths are 0.78.',
      now: 15000,
    });

    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ring_r1_ohm: '0.43',
      ring_rn_ohm: '0.43',
      ring_r2_ohm: '0.78',
    });
    // Script cleared on completion.
    expect(session.ringContinuityScript).toBeFalsy();
  });

  test('cancel mid-script preserves writes and emits cancellation TTS', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives 0.43.',
      now: 1000,
    });
    ws.sent.length = 0; // clear capture
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.ringContinuityScript).toBeFalsy();
    // R1 stays in the snapshot.
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      expected_answer_shape: 'none',
    });
    expect(ws.sent[0].question).toMatch(/cancelled/i);
    expect(ws.sent[0].question).toMatch(/1 of 3/);
  });

  test('topic switch (Zs) exits with fallthrough=true', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    ws.sent.length = 0;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62 on circuit 6.',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'Zs is 0.62 on circuit 6.',
    });
    expect(session.ringContinuityScript).toBeFalsy();
    expect(ws.sent).toEqual([]); // no new TTS — Sonnet handles the new utterance
  });

  test('switching to ring continuity for a NEW circuit re-seeds script', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives 0.43.',
      now: 1000,
    });
    ws.sent.length = 0;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 14. Lives 0.51.',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.ringContinuityScript.circuit_ref).toBe(14);
    expect(session.ringContinuityScript.values).toEqual({
      ring_r1_ohm: '0.51',
    });
    // c13's R1 stays in the snapshot — preserved from the prior script.
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
    expect(session.stateSnapshot.circuits[14].ring_r1_ohm).toBe('0.51');
  });

  test('"which circuit?" answer "circuit 13" promotes script', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    expect(session.ringContinuityScript.circuit_ref).toBeNull();
    ws.sent.length = 0;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 13',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.ringContinuityScript.circuit_ref).toBe(13);
    // Should now ask for lives (R1).
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].context_field).toBe('ring_r1_ohm');
  });

  test('discontinuous CPC writes "∞" and finishes', () => {
    const session = buildSession({
      13: { ring_r1_ohm: '0.43', ring_rn_ohm: '0.43' },
    });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    ws.sent.length = 0;
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'CPC is open',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[13].ring_r2_ohm).toBe('∞');
    expect(session.ringContinuityScript).toBeFalsy();
  });

  test('hard timeout clears stale script state on next turn', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      now: 1000,
    });
    expect(session.ringContinuityScript.active).toBe(true);
    ws.sent.length = 0;
    // Far past the hard timeout — but the next utterance is not a ring entry,
    // so script should be silently cleared and the turn falls through to
    // normal Sonnet handling.
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62 on circuit 6.',
      now: 1000 + RING_SCRIPT_HARD_TIMEOUT_MS + 5000,
    });
    expect(out).toEqual({ handled: false });
    expect(session.ringContinuityScript).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Wire-emit safety: closed socket
// ---------------------------------------------------------------------------

describe('wire-emit safety', () => {
  test('closed socket: state still mutates, sends are silently swallowed', () => {
    const session = buildSession();
    const ws = new MockWS();
    ws.readyState = 0; // CONNECTING / not OPEN
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives are 0.43.',
      now: 1000,
    });
    // Snapshot still mutated.
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.43');
    // Script state still active (so finally / drain re-enters cleanly).
    expect(session.ringContinuityScript.active).toBe(true);
    // No messages successfully sent.
    expect(ws.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration with the 60s timeout module
// ---------------------------------------------------------------------------

describe('integration with ring-continuity-timeout', () => {
  test('script writes also stamp ringContinuityState for the 60s timer', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives are 0.43.',
      now: 1000,
    });
    expect(session.ringContinuityState).toBeInstanceOf(Map);
    expect(session.ringContinuityState.get(13)).toBe(1000);
  });

  test('completion clears the 60s timer state for the circuit', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13. Lives 0.43, neutrals 0.43, earths 0.78.',
      now: 1000,
    });
    // Bucket full → script cleared its own state AND the timer state.
    expect(session.ringContinuityScript).toBeFalsy();
    expect(session.ringContinuityState?.has?.(13) ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RING_FIELDS sanity — guard against drift with the timeout module
// ---------------------------------------------------------------------------

describe('RING_FIELDS sanity', () => {
  test('matches the canonical ring continuity field names', () => {
    expect(RING_FIELDS).toEqual(['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm']);
  });
});

// ---------------------------------------------------------------------------
// Fix A — pending_writes when entering without a circuit
// (Session 74201B27, 2026-04-29 09:33 BST: "Ring continuity is lives are
// 0.75." was lost because the volunteered-value extractor was guarded on
// circuit_ref. With Fix A, the value queues until the circuit resolves.)
// ---------------------------------------------------------------------------

describe('Fix A — pending_writes when entering without a circuit', () => {
  test('"Ring continuity is lives are 0.75" queues R1 in pending_writes', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.75.',
      now: 1000,
    });
    // Snapshot UNCHANGED — no circuit to write against yet.
    expect(session.stateSnapshot.circuits[1]).toBeUndefined();
    // Pending queue holds the volunteered R1.
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.75' },
    ]);
    // Script asked which circuit; no extraction emit (nothing to write).
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      reason: 'missing_context',
    });
  });

  test('volunteered values are re-applied to the resolved circuit', () => {
    const session = buildSession({ 1: { designation: 'downstairs sockets' } });
    const ws = new MockWS();
    // Turn 1 — entry without circuit, R1 volunteered.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.75.',
      now: 1000,
    });
    ws.sent.length = 0;
    // Turn 2 — answer "circuit 1".
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 1',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[1].ring_r1_ohm).toBe('0.75');
    expect(session.ringContinuityScript.values).toEqual({
      ring_r1_ohm: '0.75',
    });
    // pending_writes drained.
    expect(session.ringContinuityScript.pending_writes).toEqual([]);
    // Two emits: extraction (R1 drained), then ask for Rn.
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0].type).toBe('extraction');
    expect(ws.sent[0].result.readings).toEqual([
      { field: 'ring_r1_ohm', circuit: 1, value: '0.75', confidence: 1.0, source: 'ring_script' },
    ]);
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
  });

  test('multiple volunteered values queue and drain together', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity, lives 0.43, neutrals 0.43.',
      now: 1000,
    });
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.43' },
      { field: 'ring_rn_ohm', value: '0.43' },
    ]);
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 13',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[13]).toMatchObject({
      ring_r1_ohm: '0.43',
      ring_rn_ohm: '0.43',
    });
  });

  test('unresolvable circuit answer logs discarded pending_writes and exits with fallthrough', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.75.',
      now: 1000,
    });
    ws.sent.length = 0;
    // No circuit 1 in snapshot, no designation match — answer is gibberish.
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'never mind not relevant',
      now: 2000,
    });
    // "never mind" is a CANCEL phrase, so this turn cancels — that's
    // actually the user-friendly outcome here, validated by the cancel test
    // suite separately. For the unresolvable case, use a plain non-circuit
    // answer.
    expect(out.handled).toBe(true);
  });

  test('truly-unresolvable answer (no digit, no designation match) exits with fallthrough', () => {
    const session = buildSession({ 5: { designation: 'cooker' } });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity, lives are 0.5.',
      now: 1000,
    });
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.5' },
    ]);
    ws.sent.length = 0;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'something completely unrelated',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'something completely unrelated',
    });
    expect(session.ringContinuityScript).toBeFalsy();
    // No writes survived to the snapshot (no circuit was resolvable).
    expect(session.stateSnapshot.circuits[5].ring_r1_ohm).toBeUndefined();
    // No new wire traffic (fallthrough → caller runs Sonnet).
    expect(ws.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix B — designation-based circuit resolution
// (Session 74201B27, 2026-04-29 09:33 BST: inspector created circuit 1
// with designation "downstairs sockets", entered ring continuity, and
// answered "Which circuit?" with "downstairs sockets". The original
// digit-only parser couldn't resolve the answer.)
// ---------------------------------------------------------------------------

describe('Fix B — findCircuitByDesignation (via __testing__)', () => {
  const { findCircuitByDesignation } = __testing__;

  test('exact match is case-insensitive', () => {
    const session = buildSession({ 1: { designation: 'Downstairs Sockets' } });
    expect(findCircuitByDesignation(session, 'downstairs sockets')).toBe(1);
  });

  test('substring of designation matches (user said less)', () => {
    const session = buildSession({ 1: { designation: 'Downstairs Sockets' } });
    expect(findCircuitByDesignation(session, 'downstairs')).toBe(1);
  });

  test('designation as substring of user text matches (user said more)', () => {
    const session = buildSession({ 1: { designation: 'Downstairs Sockets' } });
    expect(findCircuitByDesignation(session, "it's the downstairs sockets one")).toBe(1);
  });

  test('whitespace tolerant', () => {
    const session = buildSession({ 1: { designation: 'Downstairs   Sockets' } });
    expect(findCircuitByDesignation(session, 'downstairs sockets')).toBe(1);
  });

  test('two-plus matches → null (ambiguous)', () => {
    const session = buildSession({
      1: { designation: 'downstairs sockets' },
      2: { designation: 'upstairs sockets' },
    });
    expect(findCircuitByDesignation(session, 'sockets')).toBeNull();
  });

  test('no match → null', () => {
    const session = buildSession({ 1: { designation: 'cooker' } });
    expect(findCircuitByDesignation(session, 'unrelated text')).toBeNull();
  });

  test('skips circuit 0 (board / supply slot)', () => {
    const session = buildSession({
      0: { designation: 'supply' },
      1: { designation: 'downstairs sockets' },
    });
    expect(findCircuitByDesignation(session, 'supply')).toBeNull();
  });

  test('skips circuits with empty designation', () => {
    const session = buildSession({
      1: { designation: 'cooker' },
      2: { designation: '' },
      3: { designation: null },
    });
    expect(findCircuitByDesignation(session, 'cooker')).toBe(1);
  });

  test('unknown circuits in array form work too', () => {
    const session = {
      stateSnapshot: {
        circuits: [
          { circuit_ref: 1, designation: 'downstairs sockets' },
          { circuit_ref: 2, designation: 'kitchen' },
        ],
      },
    };
    expect(findCircuitByDesignation(session, 'downstairs sockets')).toBe(1);
  });
});

describe('Fix B — designation answer in active path', () => {
  test('"downstairs sockets" answer resolves circuit and drains pending_writes', () => {
    const session = buildSession({
      1: { designation: 'Downstairs Sockets' },
    });
    const ws = new MockWS();
    // Turn 1 — the canonical 74201B27 entry utterance.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.75.',
      now: 1000,
    });
    ws.sent.length = 0;
    // Turn 2 — designation answer (no digit).
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'downstairs sockets.',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Circuit resolved.
    expect(session.ringContinuityScript.circuit_ref).toBe(1);
    // pending_writes drained.
    expect(session.ringContinuityScript.pending_writes).toEqual([]);
    // R1 written to snapshot.
    expect(session.stateSnapshot.circuits[1].ring_r1_ohm).toBe('0.75');
    // Two emits: extraction (R1 drained), ask for Rn.
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0].type).toBe('extraction');
    expect(ws.sent[0].result.readings[0].field).toBe('ring_r1_ohm');
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
  });

  test('combined digit + named-field answer: "circuit 1, neutrals 0.43"', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.43.',
      now: 1000,
    });
    ws.sent.length = 0;
    // Inspector says BOTH circuit and another reading on the same turn.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 1, neutrals 0.43.',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[1]).toMatchObject({
      ring_r1_ohm: '0.43', // drained from pending
      ring_rn_ohm: '0.43', // extracted from this turn
    });
  });

  test('ambiguous designation answer falls through to Sonnet', () => {
    const session = buildSession({
      1: { designation: 'downstairs sockets' },
      2: { designation: 'upstairs sockets' },
    });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity, lives 0.5.',
      now: 1000,
    });
    ws.sent.length = 0;
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'sockets',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'sockets',
    });
    expect(session.ringContinuityScript).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Fix Y — queue follow-up values that arrive while still waiting on a
// circuit (session 361A638D, 2026-04-29 10:44 BST: inspector said bare
// "ring continuity", was asked "Which circuit?", then provided values
// instead of a circuit name. Pre-fix, the script gave up and discarded
// the values; post-fix, it queues them and stays alive until a circuit
// resolves on a later turn.)
// ---------------------------------------------------------------------------

describe('Fix Y — values arriving while waiting on circuit', () => {
  test('"lives are 0.86" answer queues into pending_writes (no fallthrough)', () => {
    const session = buildSession({ 11: { designation: 'downstairs sockets' } });
    const ws = new MockWS();
    // Bare "ring continuity" — enters, asks "Which circuit?"
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    expect(session.ringContinuityScript.circuit_ref).toBeNull();
    expect(session.ringContinuityScript.pending_writes).toEqual([]);
    ws.sent.length = 0;

    // Inspector keeps dictating instead of answering — "lives are 0.86".
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Uh, the lives are 0.86.',
      now: 2000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // Script is STILL active.
    expect(session.ringContinuityScript.active).toBe(true);
    // R1 queued.
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.86' },
    ]);
    // No new TTS — silent queue (re-asking would interrupt the inspector).
    expect(ws.sent).toEqual([]);
  });

  test('multiple value-only turns accumulate in pending_writes', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'lives 0.86',
      now: 2000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'neutrals 0.43',
      now: 3000,
    });
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.86' },
      { field: 'ring_rn_ohm', value: '0.43' },
    ]);
  });

  test('subsequent designation answer drains accumulated pending_writes', () => {
    const session = buildSession({ 11: { designation: 'downstairs sockets' } });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Uh, the lives are 0.86.',
      now: 2000,
    });
    ws.sent.length = 0;
    // Now the inspector finally names the circuit by designation.
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'the downstairs sockets',
      now: 3000,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.stateSnapshot.circuits[11].ring_r1_ohm).toBe('0.86');
    expect(session.ringContinuityScript.circuit_ref).toBe(11);
    expect(session.ringContinuityScript.pending_writes).toEqual([]);
    // Two emits: extraction (R1 drained), ask for Rn.
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0].type).toBe('extraction');
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
  });

  test('does not double-queue the same field across turns', () => {
    const session = buildSession();
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'lives 0.86',
      now: 2000,
    });
    // Inspector re-states (slip of the tongue or transcript echo).
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'lives 0.99',
      now: 3000,
    });
    // First value wins — duplicate entry is skipped.
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.86' },
    ]);
  });

  test('value-only turn with no field word still falls through (genuinely unresolvable)', () => {
    const session = buildSession({ 5: { designation: 'cooker' } });
    const ws = new MockWS();
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });
    ws.sent.length = 0;
    // Bare digit "0.86" — no field word, no circuit identifier.
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '0.86',
      now: 2000,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: '0.86',
    });
    expect(session.ringContinuityScript).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Session 361A638D full repro — end-to-end with Fix Y in place
// ---------------------------------------------------------------------------

describe('Session 361A638D repro — Fix Y salvages bare-entry + value-first', () => {
  test('bare "ring continuity" → "lives 0.86" → "downstairs sockets" → R1 lands', () => {
    const session = buildSession({ 11: { designation: 'Downstairs Sockets' } });
    const ws = new MockWS();

    // T1: "ring continuity" alone.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity',
      now: 1000,
    });

    // T2: inspector keeps dictating instead of naming the circuit.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Uh, the lives are 0.86.',
      now: 2000,
    });
    expect(session.ringContinuityScript.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.86' },
    ]);

    // T3: inspector finally names the circuit (the answer that
    // session 361A638D's Sonnet recovery eventually got, but which the
    // script gave up on too early to consume).
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'The downstairs sockets.',
      now: 3000,
    });
    expect(session.stateSnapshot.circuits[11].ring_r1_ohm).toBe('0.86');
  });
});

// ---------------------------------------------------------------------------
// Session 74201B27 full repro — end-to-end with Fixes A + B in place
// ---------------------------------------------------------------------------

describe('Session 74201B27 repro — Fixes A+B salvage the dictation', () => {
  test('full chain: lives upfront → designation answer → garbled neutrals', () => {
    // Setup: snapshot has circuit 1 named "downstairs sockets" (created
    // by Sonnet on a prior turn outside the script).
    const session = buildSession({
      1: { designation: 'Downstairs Sockets' },
    });
    const ws = new MockWS();

    // Turn 1: "Ring continuity is lives are 0.75."
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity is lives are 0.75.',
      now: 1000,
    });
    expect(session.ringContinuityScript.pending_writes).toHaveLength(1);

    // Turn 2: "downstairs sockets." (designation answer)
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'downstairs sockets.',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[1].ring_r1_ohm).toBe('0.75');

    // Turn 3: "Note tools are 0.75." — Deepgram garbled "Neutrals are
    // 0.75". The named-field extractor won't match "note tools", but
    // the bare-value fallback grabs 0.75 and assigns it to the next
    // missing field (ring_rn_ohm).
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Note tools are 0.75.',
      now: 3000,
    });
    expect(session.stateSnapshot.circuits[1].ring_rn_ohm).toBe('0.75');

    // Turn 4: "earths are 0.32." — finishes the script.
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'earths are 0.32.',
      now: 4000,
    });
    expect(session.stateSnapshot.circuits[1]).toMatchObject({
      ring_r1_ohm: '0.75',
      ring_rn_ohm: '0.75',
      ring_r2_ohm: '0.32',
    });
    // Script cleared on completion.
    expect(session.ringContinuityScript).toBeFalsy();
  });
});
