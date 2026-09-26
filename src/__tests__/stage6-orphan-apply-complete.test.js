/**
 * #5a apply-complete guard — field report 2026-06-24 #4/#5 (session B0F28CFB).
 *
 * The 2026-06-23 orphan net (#10) orphaned a STRUCTURALLY-COMPLETE RCD reading
 * because the Deepgram garble "RCD tryptoid" (= "trip time") made the live
 * extractor produce 0 readings. The orphaned reading then (a) fell to the iOS
 * local-apply fallback → contentless TTS (#4) and (b) lingered in rolling
 * context → re-emitted next turn → bundled together (#5).
 *
 * The deterministic re-parse recovers a single complete (field, circuit, value)
 * tuple from transcriptText (result is EMPTY when the net fires) and applies it
 * as the Stage 6 canonical field `rcd_time_ms` with a content-bearing read-back
 * — instead of a contentless clarifying prompt. Resolved decision #4.
 */

import { jest } from '@jest/globals';

// PLAN-W1 M1 — the two-turn #5a garble scenario below drives the REAL harness
// with a scripted tool loop (the loop calls the real composed dispatcher, so a
// turn-2 `record_reading` writes and reads back through the ordinary path).
const runToolLoopSpy = jest.fn();
jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: jest.fn(() =>
    Object.assign(async () => ({ tool_use_id: 'a', content: '{}', is_error: false }), {
      __tag: 'asks',
    })
  ),
  ASK_USER_TIMEOUT_MS: 20000,
}));
jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));
jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: jest.fn(() => ({
    onSnapshotPatch: jest.fn(),
    onLoopComplete: jest.fn(),
    onToolUseStreamed: jest.fn(),
    validateAgainstConfirmations: jest.fn(),
    abortBySlot: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const {
  reparseSingleCompleteReading,
  applyOrphanRecoveredReading,
  runShadowHarness,
  ORPHAN_PROMPTS,
} = await import('../extraction/stage6-shadow-harness.js');
const { ALL_DIALOGUE_SCHEMAS } = await import('../extraction/dialogue-engine/index.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

describe('reparseSingleCompleteReading', () => {
  test('recovers the "tryptoid" garble as a single complete RCD tuple', () => {
    const t = reparseSingleCompleteReading(
      'RCD tryptoid of circuit 2 is 28 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 2, value: '28' });
  });

  test('recovers the clean "trip time" phrasing too', () => {
    const t = reparseSingleCompleteReading(
      'RCD trip time for circuit 5 is 24 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 5, value: '24' });
  });

  // C4 (field session 6B6FE011 F8) — "ICD" garble of "RCD". The alias
  // lives in the ENTRY TRIGGER (the extractor's `trip time` anchor is
  // prefix-agnostic); without it the ICD form never matched any schema
  // and the net produced nothing.
  test('recovers the "ICD" garble of RCD identically to the clean form', () => {
    const icd = reparseSingleCompleteReading(
      'ICD trip time for circuit 5 is 26 milliseconds',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(icd).toEqual({ slotField: 'rcd_trip_time', circuit: 5, value: '26' });
    // Byte-for-byte parity with the RCD spelling of the same utterance.
    expect(icd).toEqual(
      reparseSingleCompleteReading(
        'RCD trip time for circuit 5 is 26 milliseconds',
        ALL_DIALOGUE_SCHEMAS
      )
    );
  });

  // C4 — "triptan" garble of "trip time" (same session). Previously it
  // relied on the Sonnet handover; the enumerated extractor alias makes
  // it deterministic like "tryptoid".
  test('recovers the "triptan" garble as a trip-time tuple', () => {
    const t = reparseSingleCompleteReading(
      'RCD triptan of circuit 2 is 26 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 2, value: '26' });
  });

  // C4 — the fully garbled form as heard in the field: both aliases at once.
  test('recovers the doubly-garbled "ICD triptan" form', () => {
    const t = reparseSingleCompleteReading(
      'ICD triptan for circuit 3 is 30 ms',
      ALL_DIALOGUE_SCHEMAS
    );
    expect(t).toEqual({ slotField: 'rcd_trip_time', circuit: 3, value: '30' });
  });

  test('no explicit circuit digit → null (no fuzzy designation in the net)', () => {
    expect(reparseSingleCompleteReading('RCD tryptoid is 28 ms', ALL_DIALOGUE_SCHEMAS)).toBeNull();
  });

  test('numeric chitchat with no field anchor → null (orphan prompt still fires)', () => {
    expect(
      reparseSingleCompleteReading('the weather is 28 degrees', ALL_DIALOGUE_SCHEMAS)
    ).toBeNull();
  });

  test('empty / non-string transcript → null', () => {
    expect(reparseSingleCompleteReading('', ALL_DIALOGUE_SCHEMAS)).toBeNull();
    expect(reparseSingleCompleteReading(null, ALL_DIALOGUE_SCHEMAS)).toBeNull();
  });
});

describe('applyOrphanRecoveredReading', () => {
  const makeSession = (circuits = { 2: { circuit_designation: 'Cooker' } }) => ({
    sessionId: 'sess_test',
    stateSnapshot: { circuits },
  });

  test('writes rcd_time_ms to the snapshot, pushes a wire reading + content read-back', () => {
    const session = makeSession();
    const result = {};
    const tuple = { slotField: 'rcd_trip_time', circuit: 2, value: '28' };

    const reading = applyOrphanRecoveredReading({ session, result, tuple, turnId: 'turn-11' });

    // Snapshot persisted under the Stage 6 canonical field name.
    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBe('28');
    // Wire reading carries the canonical name (validateAndCorrectFields rewrites
    // it to the iOS wire form downstream, exactly as for a Haiku reading).
    expect(reading).toMatchObject({ field: 'rcd_time_ms', circuit: 2, value: '28' });
    expect(result.extracted_readings).toHaveLength(1);
    expect(result.extracted_readings[0].field).toBe('rcd_time_ms');
    // Content-bearing spoken read-back (NOT contentless) — uses the designation.
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe('Cooker, circuit 2, RCD time 28');
    expect(result.confirmations[0].field).toBe('rcd_time_ms');
    expect(result.confirmations[0].circuit).toBe(2);
    expect(result.confirmations[0].expects_ios_ack).toBe(false);
    expect(typeof result.confirmations[0].expanded_text).toBe('string');
  });

  test('read-back falls back to "Circuit N" when no designation is known', () => {
    const session = makeSession({ 2: {} });
    const result = {};
    applyOrphanRecoveredReading({
      session,
      result,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '28' },
      turnId: 'turn-11',
    });
    expect(result.confirmations[0].text).toBe('Circuit 2, RCD time 28');
  });
});

// PLAN-W1 M1 (W1-5) — the #5a garble class after the re-parse write is gone.
// Turn 1: a zero-call turn carrying a complete (garbled) reading is NOT
// written by the server; one orphan line speaks and orphanContext carries the
// utterance. Turn 2: the model input contains the carried words, and a model
// `record_reading` writes and reads back exactly once across both turns. This
// proves the plumbing; whether the LIVE model writes on turn 2 is a live-lane
// question and is not claimed here.
describe('PLAN-W1 M1 — two-turn #5a garble handoff (harness level, scripted model)', () => {
  const SESSION_ID = 'sess-w1-two-turn';

  function makeSession() {
    return {
      sessionId: SESSION_ID,
      systemPrompt: 'sys',
      toolCallsMode: 'live',
      certType: 'eicr',
      turnCount: 0,
      costTracker: {
        addSonnetUsage: jest.fn(),
        recordElevenLabsSpeculativeStarted: jest.fn(() => true),
        recordElevenLabsSpeculativeTerminal: jest.fn(),
      },
      stateSnapshot: {
        circuits: { 2: { circuit_designation: 'Kitchen sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
      extractedObservations: [],
      activeTurnTranscript: null,
      _snapshot: null,
      buildSystemBlocks() {
        return [{ type: 'text', text: this.systemPrompt }];
      },
      buildAgenticSystemBlocks() {
        return this.buildSystemBlocks();
      },
    };
  }

  function loopReturning(calls, seenMessages) {
    runToolLoopSpy.mockImplementation(async (opts) => {
      seenMessages.push(opts.messages);
      const toolCalls = [];
      for (let i = 0; i < calls.length; i += 1) {
        const c = calls[i];
        const env = await opts.dispatcher(
          { tool_call_id: `toolu_${i}`, name: c.name, input: c.input },
          opts.ctx
        );
        toolCalls.push({ tool_call_id: `toolu_${i}`, name: c.name, input: c.input, result: env });
      }
      return {
        stop_reason: 'end_turn',
        rounds: 1,
        tool_calls: toolCalls,
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
  }

  const opts = () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    chimeObserved: true,
  });

  beforeEach(() => {
    activeSessions.set(SESSION_ID, {
      session: { sessionId: SESSION_ID },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
  });
  afterEach(() => {
    activeSessions.delete(SESSION_ID);
    runToolLoopSpy.mockReset();
  });

  test('turn 1 hands off (no server write); turn 2 model write reads back exactly once', async () => {
    const session = makeSession();
    const seen = [];
    const garble = 'RCD tryptoid of circuit 2 is 28 ms';

    loopReturning([], seen);
    const r1 = await runShadowHarness(session, garble, [], opts());
    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBeUndefined();
    expect(r1.extracted_readings ?? []).toHaveLength(0);
    const r1Lines = (r1.confirmations ?? []).filter((c) => c.text?.trim());
    expect(r1Lines).toHaveLength(1);
    expect(ORPHAN_PROMPTS).toContain(r1Lines[0].text);
    expect(session.orphanContext?.transcript).toBe(garble);

    loopReturning(
      [
        {
          name: 'record_reading',
          input: {
            field: 'rcd_time_ms',
            circuit: 2,
            value: '28',
            confidence: 0.9,
            source_turn_id: 't2',
          },
        },
      ],
      seen
    );
    const r2 = await runShadowHarness(session, 'RCD trip time circuit 2, 28', [], opts());
    const turn2Input = JSON.stringify(seen[1]);
    expect(turn2Input).toContain(garble);

    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBe('28');
    const readBacks = [...(r1.confirmations ?? []), ...(r2.confirmations ?? [])].filter(
      (c) => c.field === 'rcd_time_ms' && c.circuit === 2
    );
    expect(readBacks).toHaveLength(1);
    const all = [...(r1.confirmations ?? []), ...(r2.confirmations ?? [])];
    expect(all.some((c) => /^Already got that/.test(c.text || ''))).toBe(false);
  });
});
