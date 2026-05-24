/**
 * Tests for src/extraction/loaded-barrel-speculator.js (Loaded Barrel
 * Phase 2.B).
 *
 * The speculator's hot path opens an ElevenLabs WS — these tests
 * inject a mock ElevenLabsStreamClient via the `clientFactory` opt so
 * no real network calls fire.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import {
  buildCacheKey,
  peek,
  _resetForTests as resetCache,
} from '../extraction/loaded-barrel-cache.js';
import { encodeReadingKey, encodeBoardReadingKey } from '../extraction/stage6-per-turn-writes.js';

const ENV_KEYS = ['VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN'];

beforeEach(() => {
  resetCache();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  resetCache();
  for (const k of ENV_KEYS) delete process.env[k];
});

// _speculate is fire-and-forget (async, not awaited inside onSnapshotPatch
// so a single hook event doesn't block runToolLoop). Tests drain the
// microtask queue via setImmediate to let the speculator's promise chain
// progress to the factory call.
async function flush() {
  await new Promise((r) => setImmediate(r));
}

/**
 * Build a mock ElevenLabsStreamClient factory that simulates
 * synthesis. The mock holds a controllable resolver so tests can
 * assert state during the in-flight window.
 */
function makeMockClientFactory({ failWith = null, mp3Payload = Buffer.from([1, 2, 3]) } = {}) {
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
        const synthRec = {
          text,
          opts,
          client,
          resolve: (timings = {}) => {
            opts.onAudio(mp3Payload);
            resolveSynth(timings);
          },
          reject: (err) => rejectSynth(err),
        };
        synths.push(synthRec);
        // Honour AbortSignal if test aborts mid-flight.
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            rejectSynth(new Error('elevenlabs_stream_aborted'));
          });
        }
        if (failWith) {
          setImmediate(() => rejectSynth(failWith));
        }
        return promise;
      }),
      close: jest.fn(),
    };
    return client;
  });
  return { factory, synths };
}

function makeSpeculator({ factory } = {}) {
  return createSpeculator({
    sessionId: 'S',
    apiKey: 'test-key',
    costTracker: new CostTracker(),
    clientFactory: factory,
  });
}

/**
 * Helper to build the onSnapshotPatch event shape for a single
 * record_reading mutation.
 */
function patchForAdded({ field, circuit, boardId, value, confidence = 1.0, turnId = 'T1' }) {
  return {
    patch: {
      readings: {
        added: [
          {
            key: encodeReadingKey(field, circuit, boardId),
            value: { value, confidence, source_turn_id: turnId },
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
    ctx: { sessionId: 'S', turnId, toolName: 'record_reading', toolCallId: 'tc1', roundIdx: 1 },
  };
}

describe('createSpeculator — input validation', () => {
  test('throws without sessionId', () => {
    expect(() =>
      createSpeculator({ sessionId: '', apiKey: 'k', costTracker: new CostTracker() })
    ).toThrow();
  });

  test('throws without costTracker', () => {
    expect(() => createSpeculator({ sessionId: 'S', apiKey: 'k' })).toThrow();
  });
});

describe('speculate — happy path', () => {
  test('record_reading → opens synth + caches MP3 on completion', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const text = 'Circuit 1, zed S zero point five'; // post-expand of "Circuit 1, Zs 0.5"

    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.5',
      })
    );
    await flush();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(synths).toHaveLength(1);
    expect(synths[0].text).toBe(text);

    // Cache entry should be pending now.
    const key = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: text,
    });
    expect(peek(key)?.state).toBe('pending');

    // Simulate synth completion.
    synths[0].resolve();
    await flush();
    // Cache transitions pending → ready; entry still in cache awaiting claim.
    expect(peek(key)?.state).toBe('ready');
    expect(peek(key)?.mp3Buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  test('low-confidence reading skipped (no synth)', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.5',
        confidence: 0.5,
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('unknown field skipped (not in friendly-name table)', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'circuit_designation',
        circuit: 1,
        boardId: null,
        value: 'Cooker',
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('polarity_confirmed=false skipped (buildConfirmationText returns null)', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'polarity_confirmed',
        circuit: 1,
        boardId: null,
        value: 'false',
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe('per-turn cap', () => {
  test('default cap = 2 — third write in same turn is skipped', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r1_r2_ohm',
        circuit: 2,
        boardId: null,
        value: '0.2',
        turnId: 'T1',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r2_ohm',
        circuit: 3,
        boardId: null,
        value: '0.3',
        turnId: 'T1',
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('cap resets per turn', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    // T1: 2 (cap)
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r1_r2_ohm',
        circuit: 2,
        boardId: null,
        value: '0.2',
        turnId: 'T1',
      })
    );
    // T2: cap reset; 2 more allowed
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r2_ohm',
        circuit: 3,
        boardId: null,
        value: '0.3',
        turnId: 'T2',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'number_of_points',
        circuit: 4,
        boardId: null,
        value: '5',
        turnId: 'T2',
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(4);
  });

  test('cap respects env override', async () => {
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '1';
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r1_r2_ohm',
        circuit: 2,
        boardId: null,
        value: '0.2',
        turnId: 'T1',
      })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  test('clear_reading invalidates cache entry for the matching slot', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    synths[0].resolve();
    await flush();

    const key = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point one',
    });
    expect(peek(key)?.state).toBe('ready');

    spec.onSnapshotPatch({
      patch: {
        readings: { added: [], overwritten: [], removed: [] },
        boardReadings: { added: [], overwritten: [], removed: [] },
        cleared: [{ field: 'measured_zs_ohm', circuit: 1, reason: 'clear_reading' }],
        observations: [],
        deletedObservations: [],
        circuitOps: [],
        boardOps: [],
        fieldCorrections: [],
      },
      raw: { perTurnWrites: null },
      ctx: { sessionId: 'S', turnId: 'T1', toolName: 'clear_reading' },
    });

    expect(peek(key)).toBe(null);
  });

  test('overwritten reading: old cache entry is invalidated then new speculation runs', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    synths[0].resolve();
    await flush();

    const oldKey = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point one',
    });
    expect(peek(oldKey)?.state).toBe('ready');

    // Overwrite event for the same slot with new value.
    const overwriteKey = encodeReadingKey('measured_zs_ohm', 1, null);
    spec.onSnapshotPatch({
      patch: {
        readings: {
          added: [],
          overwritten: [
            {
              key: overwriteKey,
              before: { value: '0.1', confidence: 1.0 },
              after: { value: '0.2', confidence: 1.0, source_turn_id: 'T1' },
            },
          ],
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
      ctx: { sessionId: 'S', turnId: 'T1', toolName: 'record_reading' },
    });

    await flush();
    // Old key invalidated.
    expect(peek(oldKey)).toBe(null);
    // New speculation kicked off.
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('board-op pruning', () => {
  test('add_board prunes unboarded entries', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    synths[0].resolve();
    await flush();

    const unboardedKey = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point one',
    });
    expect(peek(unboardedKey)).not.toBe(null);

    // add_board event.
    spec.onSnapshotPatch({
      patch: {
        readings: { added: [], overwritten: [], removed: [] },
        boardReadings: { added: [], overwritten: [], removed: [] },
        cleared: [],
        observations: [],
        deletedObservations: [],
        circuitOps: [],
        boardOps: [{ op: 'add_board', board_id: 'B1', designation: 'Sub-1' }],
        fieldCorrections: [],
      },
      raw: { perTurnWrites: null },
      ctx: { sessionId: 'S', turnId: 'T1', toolName: 'add_board' },
    });

    expect(peek(unboardedKey)).toBe(null);
  });

  test('select_board prunes entries with mismatched boardId', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: 'B1',
        value: '0.1',
        turnId: 'T1',
      })
    );
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'r1_r2_ohm',
        circuit: 2,
        boardId: 'B2',
        value: '0.2',
        turnId: 'T1',
      })
    );
    await flush();
    synths[0].resolve();
    synths[1].resolve();
    await flush();

    const keyB1 = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: 'B1',
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point one',
    });
    const keyB2 = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: 'B2',
      field: 'r1_r2_ohm',
      circuit: 2,
      expandedText: 'Circuit 2, R 1 plus R 2 zero point two',
    });
    expect(peek(keyB1)).not.toBe(null);
    expect(peek(keyB2)).not.toBe(null);

    spec.onSnapshotPatch({
      patch: {
        readings: { added: [], overwritten: [], removed: [] },
        boardReadings: { added: [], overwritten: [], removed: [] },
        cleared: [],
        observations: [],
        deletedObservations: [],
        circuitOps: [],
        boardOps: [{ op: 'select_board', board_id: 'B1' }],
        fieldCorrections: [],
      },
      raw: { perTurnWrites: null },
      ctx: { sessionId: 'S', turnId: 'T1', toolName: 'select_board' },
    });

    expect(peek(keyB1)).not.toBe(null); // matches current working board
    expect(peek(keyB2)).toBe(null); // mismatched — pruned
  });
});

describe('cost-tracker integration', () => {
  test('every speculation records Started + Terminal on completion', async () => {
    const { factory, synths } = makeMockClientFactory();
    const costTracker = new CostTracker();
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'test-key',
      costTracker,
      clientFactory: factory,
    });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    expect(costTracker.elevenLabsSpeculative.charsStarted).toBeGreaterThan(0);
    synths[0].resolve();
    await flush();
    expect(costTracker.elevenLabsSpeculative.charsCompleted).toBeGreaterThan(0);
    expect(costTracker.elevenLabsSpeculative._seenCorrelationIds.size).toBe(1);
    expect(costTracker.elevenLabsSpeculative._terminalCorrelationIds.size).toBe(1);
  });

  test('synth failure records Terminal("failed")', async () => {
    const { factory } = makeMockClientFactory({ failWith: new Error('elevenlabs_5xx') });
    const costTracker = new CostTracker();
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'test-key',
      costTracker,
      clientFactory: factory,
    });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    await flush(); // setImmediate inside the mock + the speculator's await chain
    expect(costTracker.elevenLabsSpeculative.charsFailed).toBeGreaterThan(0);
  });
});

describe('shutdown', () => {
  test('aborts in-flight controllers + prunes cache for session', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onSnapshotPatch(
      patchForAdded({
        field: 'measured_zs_ohm',
        circuit: 1,
        boardId: null,
        value: '0.1',
        turnId: 'T1',
      })
    );
    await flush();
    expect(spec._internalState.pendingCount).toBe(1);

    spec.shutdown();
    expect(spec._internalState.pendingCount).toBe(0);
    expect(spec._internalState.currentTurnId).toBe(null);
    // The pending synth's promise should resolve via the abort signal.
    await flush();
    await flush();
    // The cache entry is gone too.
    const key = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: 'Circuit 1, zed S zero point one',
    });
    expect(peek(key)).toBe(null);
  });
});
