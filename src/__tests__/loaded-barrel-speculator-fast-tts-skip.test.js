/**
 * Fast-TTS skip preflight tests for loaded-barrel-speculator.
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 9). When the
 * Mode-A fast-TTS route accepts an iOS POST for a given (turnId, slot)
 * pair, it writes the slotKey into entry.pendingFastTtsSlots BEFORE
 * responding. _speculate's shared preflight then short-circuits
 * BEFORE opening a cost ledger entry — iOS plays the fast-path MP3 and
 * the speculator's audio would be wasted.
 *
 * The skip check lives in the SHARED preflight inside _speculate, so
 * BOTH entry paths (onToolUseStreamed AND onSnapshotPatch) are
 * covered by a single check. This file pins both paths.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { _resetForTests as resetCache } from '../extraction/loaded-barrel-cache.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

const SESSION_ID = 'SKIPSESS';
const TURN_ID = 'T1';

beforeEach(() => {
  resetCache();
  // Build a minimal activeSessions entry with the per-turn map. The
  // speculator looks it up via getActiveSessionEntry(sessionId).
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
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

function makeSpeculator(tracker) {
  const { factory, synths } = makeMockClientFactory();
  const spec = createSpeculator({
    sessionId: SESSION_ID,
    apiKey: 'k',
    costTracker: tracker,
    clientFactory: factory,
  });
  return { spec, factory, synths };
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

function seedFastTtsSlot({ field, circuit, boardId = '', turnId = TURN_ID }) {
  const entry = activeSessions.get(SESSION_ID);
  const slotKey = `${field}::${circuit ?? 'null'}::${boardId}`;
  if (!entry.pendingFastTtsSlots.has(turnId)) {
    entry.pendingFastTtsSlots.set(turnId, new Set());
  }
  entry.pendingFastTtsSlots.get(turnId).add(slotKey);
}

describe('fast-TTS skip preflight — both entry paths', () => {
  test('onSnapshotPatch path: pre-seeded slot → no synth, no cost', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    seedFastTtsSlot({ field: 'measured_zs_ohm', circuit: 1 });
    spec.onSnapshotPatch(
      buildSnapshotPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();

    expect(synths).toHaveLength(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);
  });

  test('onToolUseStreamed path: pre-seeded slot → no synth, no cost', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    seedFastTtsSlot({ field: 'measured_zs_ohm', circuit: 1 });
    spec.onToolUseStreamed({
      record: {
        name: 'record_reading',
        input: { field: 'measured_zs_ohm', circuit: 1, value: '0.62', confidence: 1.0 },
      },
      ctx: { sessionId: SESSION_ID, turnId: TURN_ID, roundIdx: 1 },
    });
    await flush();
    await flush();

    expect(synths).toHaveLength(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);
  });

  test('skip is per-(turn, slot): different slot in same turn still synthesises', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    seedFastTtsSlot({ field: 'measured_zs_ohm', circuit: 1 });
    spec.onSnapshotPatch(buildSnapshotPatch({ field: 'r1_r2_ohm', circuit: 1, value: '0.30' }));
    await flush();
    await flush();

    // r1_r2_ohm is NOT seeded → synth fires normally.
    expect(synths.length).toBeGreaterThan(0);
    expect(tracker.elevenLabsSpeculative.charsStarted).toBeGreaterThan(0);
  });

  test('skip is per-turn: same slot in a later turn synthesises (no cross-turn leak)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);

    seedFastTtsSlot({ field: 'measured_zs_ohm', circuit: 1, turnId: 'T1' });
    spec.onSnapshotPatch(
      buildSnapshotPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62', turnId: 'T2' })
    );
    await flush();
    await flush();

    expect(synths.length).toBeGreaterThan(0);
  });

  test('no entry / no map: speculator falls through to normal synth (graceful degradation)', async () => {
    // Delete the entry so getActiveSessionEntry returns null. The
    // speculator must NOT throw and must NOT skip on missing context.
    activeSessions.delete(SESSION_ID);
    try {
      const tracker = new CostTracker();
      const { spec, synths } = makeSpeculator(tracker);
      spec.onSnapshotPatch(
        buildSnapshotPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
      );
      await flush();
      await flush();
      expect(synths.length).toBeGreaterThan(0);
    } finally {
      // Restore for afterEach.
      activeSessions.set(SESSION_ID, {
        session: { sessionId: SESSION_ID },
        pendingFastTtsSlots: new Map(),
        fastPathCorrelationIdByTurn: new Map(),
      });
    }
  });
});
