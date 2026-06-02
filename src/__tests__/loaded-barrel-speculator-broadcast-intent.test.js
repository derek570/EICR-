/**
 * Fix A 2026-06-02 (handoff-2026-06-02-fixes.md §A) — broadcast-intent skip
 * preflight for the loaded-barrel-speculator.
 *
 * Field-bug repro: session E87F58C1-D2A4-404B-8846-C75CCE98E3F1 09:35:26 BST.
 * Inspector said "Live to earth insulation resistance on circuits 2 and 3 is
 * greater than 299 megohms." Sonnet emitted two record_reading calls (c2,
 * c3). The speculator fired on the first one (c2 only), pre-synthed
 * "Circuit 2, IR L to E >299" and shipped the audio to iOS ~388 ms before
 * the bundler's broadcast-detector flagged the second circuit and aborted
 * the bucket. iOS played the per-circuit synth, then the bundler's grouped
 * "Circuits 2, 3, IR L to E >299" played on top — two overlapping TTS
 * payloads, different text, no client-side dedupe.
 *
 * Fix: runLiveMode runs detectBroadcastIntent on the transcript BEFORE
 * runToolLoop starts and writes `entry.broadcastIntentByTurn.set(turnId,
 * true)` for broadcast transcripts. The speculator's _speculate preflight
 * reads that map and returns early (no synth, no cost ledger) on any
 * circuit-level reading when the flag is set. Board-level readings
 * (circuit:null) are never skipped.
 *
 * Test surface (mirrors loaded-barrel-speculator-fast-tts-skip.test.js):
 *   1. onSnapshotPatch path — broadcast flag set → no synth.
 *   2. onToolUseStreamed path — broadcast flag set → no synth.
 *   3. Per-turn scoping — flag on turn T1 doesn't leak to T2.
 *   4. No entry / no map — graceful degradation, normal synth.
 *   5. Board-level reading (circuit:null) — flag IGNORED, synth fires.
 *   6. Flag absent (non-broadcast turn) — synth fires as today.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { _resetForTests as resetCache } from '../extraction/loaded-barrel-cache.js';
import { encodeReadingKey, encodeBoardReadingKey } from '../extraction/stage6-per-turn-writes.js';

const SESSION_ID = 'BCASTSESS';
const TURN_ID = 'T1';

beforeEach(() => {
  resetCache();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
  });
});

afterEach(() => {
  resetCache();
  activeSessions.delete(SESSION_ID);
});

function flush() {
  return new Promise((r) => setImmediate(r));
}

function makeMockClientFactory() {
  const synths = [];
  const factory = jest.fn(() => {
    const client = {
      synth: jest.fn((text, opts) => {
        let resolveSynth;
        let rejectSynth;
        const promise = new Promise((res, rej) => {
          resolveSynth = res;
          rejectSynth = rej;
        });
        synths.push({
          text,
          opts,
          client,
          resolve: (timings = {}) => {
            opts.onAudio(Buffer.from([1, 2, 3]));
            resolveSynth(timings);
          },
          reject: (err) => rejectSynth(err),
        });
        return promise;
      }),
      close: jest.fn(),
    };
    return client;
  });
  return { factory, synths };
}

function makeSpeculator(tracker, logger = null) {
  const { factory, synths } = makeMockClientFactory();
  const spec = createSpeculator({
    sessionId: SESSION_ID,
    apiKey: 'k',
    costTracker: tracker,
    clientFactory: factory,
    logger,
  });
  return { spec, factory, synths };
}

function setBroadcastIntent(turnId = TURN_ID) {
  const entry = activeSessions.get(SESSION_ID);
  entry.broadcastIntentByTurn.set(turnId, true);
}

function buildSnapshotPatch({ field, circuit, value, turnId = TURN_ID }) {
  return {
    patch: {
      readings: {
        added: [
          {
            key: encodeReadingKey(field, circuit),
            value: { value, confidence: 1.0, source_turn_id: turnId },
          },
        ],
        overwritten: [],
        removed: [],
      },
      boardReadings: { added: [], overwritten: [], removed: [] },
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
      boardOps: [],
      fieldCorrections: [],
    },
    raw: { perTurnWrites: null },
    ctx: {
      sessionId: SESSION_ID,
      turnId,
      toolName: 'record_reading',
      toolCallId: 'tc1',
      roundIdx: 1,
    },
  };
}

function buildBoardSnapshotPatch({ field, value, turnId = TURN_ID }) {
  return {
    patch: {
      readings: { added: [], overwritten: [], removed: [] },
      boardReadings: {
        added: [
          {
            key: encodeBoardReadingKey(field, null),
            value: { value, confidence: 1.0, source_turn_id: turnId },
          },
        ],
        overwritten: [],
        removed: [],
      },
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
      boardOps: [],
      fieldCorrections: [],
    },
    raw: { perTurnWrites: null },
    ctx: {
      sessionId: SESSION_ID,
      turnId,
      toolName: 'record_board_reading',
      toolCallId: 'tcb1',
      roundIdx: 1,
    },
  };
}

describe('broadcast-intent skip preflight — both entry paths', () => {
  test('onSnapshotPatch path: broadcast flag set → no synth, no cost', async () => {
    const tracker = new CostTracker();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const { spec, synths } = makeSpeculator(tracker, logger);

    setBroadcastIntent();
    spec.onSnapshotPatch(
      buildSnapshotPatch({ field: 'insulation_resistance_l_e', circuit: 2, value: '>299' })
    );
    await flush();
    await flush();

    expect(synths).toHaveLength(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);

    // Telemetry emitted at the skip site so post-hoc CloudWatch attribution works.
    const skipCalls = logger.info.mock.calls.filter(
      ([evt]) => evt === 'voice_latency.loaded_barrel_skipped_broadcast_intent'
    );
    expect(skipCalls).toHaveLength(1);
    expect(skipCalls[0][1]).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      field: 'insulation_resistance_l_e',
      circuit: 2,
    });
  });

  test('onToolUseStreamed path: broadcast flag set → no synth, no cost', async () => {
    const tracker = new CostTracker();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const { spec, synths } = makeSpeculator(tracker, logger);

    setBroadcastIntent();
    spec.onToolUseStreamed({
      record: {
        name: 'record_reading',
        input: {
          field: 'insulation_resistance_l_e',
          circuit: 2,
          value: '>299',
          confidence: 1.0,
        },
      },
      ctx: { sessionId: SESSION_ID, turnId: TURN_ID, roundIdx: 1 },
    });
    await flush();
    await flush();

    expect(synths).toHaveLength(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);

    const skipCalls = logger.info.mock.calls.filter(
      ([evt]) => evt === 'voice_latency.loaded_barrel_skipped_broadcast_intent'
    );
    expect(skipCalls).toHaveLength(1);
  });

  test('skip is per-turn: flag on T1 does not leak to T2', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    setBroadcastIntent('T1');
    // Different turn — the harness's per-turn map entry is keyed on turnId,
    // so T2 doesn't see T1's flag and the synth fires normally.
    spec.onSnapshotPatch(
      buildSnapshotPatch({
        field: 'insulation_resistance_l_e',
        circuit: 2,
        value: '>299',
        turnId: 'T2',
      })
    );
    await flush();
    await flush();

    expect(synths.length).toBeGreaterThan(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBeGreaterThan(0);
  });

  test('no entry / no map: speculator falls through to normal synth (graceful degradation)', async () => {
    activeSessions.delete(SESSION_ID);
    try {
      const tracker = new CostTracker();
      const { spec, synths } = makeSpeculator(tracker);
      spec.onSnapshotPatch(
        buildSnapshotPatch({ field: 'insulation_resistance_l_e', circuit: 2, value: '>299' })
      );
      await flush();
      await flush();

      expect(synths.length).toBeGreaterThan(0);
    } finally {
      activeSessions.set(SESSION_ID, {
        session: { sessionId: SESSION_ID },
        pendingFastTtsSlots: new Map(),
        fastPathCorrelationIdByTurn: new Map(),
        broadcastIntentByTurn: new Map(),
      });
    }
  });

  test('board-level reading (circuit:null) is NEVER skipped, even with broadcast flag set', async () => {
    // Per-circuit broadcast can't apply to board fields (Ze, PFC, etc.) —
    // they live on the board itself, not on a circuit row. The skip's
    // `Number.isInteger(circuit) && circuit > 0` guard MUST gate the
    // broadcast-flag check so board-level synth still fires.
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    setBroadcastIntent();
    spec.onSnapshotPatch(
      buildBoardSnapshotPatch({ field: 'earth_loop_impedance_ze', value: '0.27' })
    );
    await flush();
    await flush();

    expect(synths.length).toBeGreaterThan(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBeGreaterThan(0);
  });

  test('non-broadcast turn (flag absent): synth fires as today (regression lock)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    // Do NOT call setBroadcastIntent — map stays empty, .get returns undefined.
    spec.onSnapshotPatch(
      buildSnapshotPatch({ field: 'insulation_resistance_l_e', circuit: 2, value: '>299' })
    );
    await flush();
    await flush();

    expect(synths.length).toBeGreaterThan(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBeGreaterThan(0);
  });

  test('flag explicitly false: synth fires (only === true triggers skip)', async () => {
    // The contract in active-sessions.js JSDoc says only `true` is ever
    // written; absent === false. Pin via `false` value too — a defensive
    // future writer storing `false` MUST NOT skip. The `=== true` check
    // at the read site enforces this.
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    const entry = activeSessions.get(SESSION_ID);
    entry.broadcastIntentByTurn.set(TURN_ID, false);

    spec.onSnapshotPatch(
      buildSnapshotPatch({ field: 'insulation_resistance_l_e', circuit: 2, value: '>299' })
    );
    await flush();
    await flush();

    expect(synths.length).toBeGreaterThan(0);
  });
});
