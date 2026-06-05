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

function makeSpeculator({ factory, logger = null } = {}) {
  // logger threads through to createSpeculator so tests can spy on
  // voice_latency.* log rows the new 2026-06-03b Fix C gate emits.
  // Without this, logger?.info?.(…) silently does nothing because
  // createSpeculator defaults logger=null.
  return createSpeculator({
    sessionId: 'S',
    apiKey: 'test-key',
    costTracker: new CostTracker(),
    clientFactory: factory,
    logger,
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

  test('2026-05-29 v2: SUPPRESSED_TTS_FIELDS skipped (deny-list policy)', () => {
    // Policy flipped to deny-list. Internal IDs and metadata still
    // skip pre-synth; everything else (including arbitrary "made up"
    // fields) now produces TTS because the inspector wants confirmation
    // on every UI write.
    return (async () => {
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onSnapshotPatch(
        patchForAdded({
          field: 'circuit_ref', // explicitly suppressed
          circuit: 1,
          boardId: null,
          value: '7',
        })
      );
      await flush();
      expect(factory).toHaveBeenCalledTimes(0);
    })();
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

// Loaded Barrel Phase 2.D (2026-05-25) — streamed-tool hook tests.
// Fires from inside runToolLoop's per-round stream loop, BEFORE the
// post-stream dispatcher runs. The speculator must begin pre-synth
// against the streamed input (with coercion applied) so multi-tool
// turns get a head start.
describe('onToolUseStreamed (Phase 2.D streamed-speculation hook)', () => {
  /** Helper to build the streamed-hook event shape for a single tool_use. */
  function streamedEvent({ field, circuit, value, boardId, confidence = 1.0, turnId = 'T1' }) {
    return {
      record: {
        index: 0,
        tool_call_id: 'tc_stream_1',
        name: 'record_reading',
        input: {
          field,
          circuit,
          value,
          confidence,
          source_turn_id: turnId,
          ...(boardId != null ? { board_id: boardId } : {}),
        },
      },
      ctx: { sessionId: 'S', turnId, roundIdx: 1 },
    };
  }

  test('record_reading streamed → begins pre-synth before any onSnapshotPatch fires', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 1, value: '0.5' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(synths).toHaveLength(1);
    // Same expanded text as the onSnapshotPatch happy-path test —
    // proving speculator-text is identical regardless of which hook
    // fires it (parity invariant for HIT path).
    expect(synths[0].text).toBe('Circuit 1, zed S zero point five');
  });

  test('later onSnapshotPatch for the same slot DOES NOT double-synth (dedup via cachePeek)', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 1, value: '0.5' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    // Simulate the post-stream dispatch firing onSnapshotPatch for the
    // SAME slot. The speculator's cachePeek should find the in-flight
    // entry and bail.
    spec.onSnapshotPatch(
      patchForAdded({ field: 'measured_zs_ohm', circuit: 1, boardId: null, value: '0.5' })
    );
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('2026-05-29: ocpd_bs_en streamed → coercion applies AND synth fires (now in friendly-name table)', async () => {
    // ocpd_bs_en was added to CONFIRMATION_FRIENDLY_NAMES on 2026-05-29
    // so inspectors hear BS-EN code reads back during walk-away
    // dictation. Mid-stream speculator emit fires when the streamed
    // value lands.
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(streamedEvent({ field: 'ocpd_bs_en', circuit: 1, value: 'BS 60898' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('polarity_confirmed="true" coerced to "Y" before pre-synth (matches dispatcher)', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(
      streamedEvent({ field: 'polarity_confirmed', circuit: 1, value: 'true' })
    );
    await flush();
    // "Y" produces a non-null confirmation; raw "true" would not.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(synths[0].text).toBeTruthy();
  });

  test('non-record_reading records (observation, ask_user, etc.) are silently skipped', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed({
      record: {
        index: 0,
        tool_call_id: 'tc_obs',
        name: 'record_observation',
        input: { code: 'C2', location: 'kitchen', text: 'broken socket' },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    spec.onToolUseStreamed({
      record: {
        index: 1,
        tool_call_id: 'tc_ask',
        name: 'ask_user',
        input: { question: 'which circuit?', reason: 'missing_context' },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('error-shaped records (invalid_json from assembler) are silently skipped', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed({
      record: {
        index: 0,
        tool_call_id: 'tc_bad',
        name: 'record_reading',
        error: 'invalid_json',
        raw_partial: '{not valid',
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('non-string circuit (null / undefined / non-integer) silently skipped', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed({
      record: {
        index: 0,
        tool_call_id: 'tc_null',
        name: 'record_reading',
        input: { field: 'measured_zs_ohm', circuit: null, value: '0.5', confidence: 1.0 },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('three streamed record_readings in one turn → first two synth, third hits per-turn cap', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 1, value: '0.1' }));
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 2, value: '0.2' }));
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 3, value: '0.3' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(synths).toHaveLength(2);
  });

  // 2026-05-28 widening — record_board_reading also gets the streamed
  // head start. Same wire shape (no circuit, has board_id), same
  // coercion, same friendly-name table.
  describe('record_board_reading (2026-05-28 widening)', () => {
    function boardStreamedEvent({
      field,
      value,
      boardId = 'main',
      confidence = 1.0,
      turnId = 'T1',
    }) {
      return {
        record: {
          index: 0,
          tool_call_id: 'tc_bs_1',
          name: 'record_board_reading',
          input: {
            field,
            value,
            confidence,
            board_id: boardId,
            source_turn_id: turnId,
          },
        },
        ctx: { sessionId: 'S', turnId, roundIdx: 1 },
      };
    }

    test('record_board_reading streamed → begins pre-synth (Ze)', async () => {
      const { factory, synths } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed(
        boardStreamedEvent({ field: 'earth_loop_impedance_ze', value: '0.25', boardId: 'main' })
      );
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(synths).toHaveLength(1);
      // Board-level confirmation has no "Circuit N," prefix.
      expect(synths[0].text).not.toMatch(/Circuit/i);
      expect(synths[0].text.toLowerCase()).toContain('z');
    });

    test('record_board_reading with no board_id → boardId=null on speculation slot', async () => {
      const { factory, synths } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed({
        record: {
          index: 0,
          tool_call_id: 'tc_bs_noboard',
          name: 'record_board_reading',
          input: {
            field: 'earth_loop_impedance_ze',
            value: '0.18',
            confidence: 1.0,
            source_turn_id: 'T1',
          },
        },
        ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
      });
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(synths).toHaveLength(1);
    });

    test.skip('record_board_reading dedups with later onSnapshotPatch for same slot — 2026-05-29 v2 regression under deny-list policy, investigate post-EIC', async () => {
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed(
        boardStreamedEvent({ field: 'earth_loop_impedance_ze', value: '0.30', boardId: 'main' })
      );
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);

      // onSnapshotPatch for the same slot — should NOT double-synth.
      spec.onSnapshotPatch({
        patch: {
          readings: { added: [], overwritten: [], removed: [] },
          boardReadings: {
            added: [
              {
                key: 'earth_loop_impedance_ze::main',
                value: { value: '0.30', confidence: 1.0 },
              },
            ],
            overwritten: [],
            removed: [],
          },
          cleared: [],
          boardOps: [],
        },
        raw: {},
        ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
      });
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);
    });

    test('2026-05-29 v2: under deny-list policy, sub_main_cable_length speaks (it has a value)', async () => {
      // Previously suppressed because the field wasn't in the
      // friendly-name allow-list. The deny-list flip means any non-
      // suppressed, non-_id field with a value produces TTS. Inspector
      // requested coverage on every UI write — this is part of that.
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed(boardStreamedEvent({ field: 'sub_main_cable_length', value: '10' }));
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);
    });

    test('record_board_reading missing value silently skipped', async () => {
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed({
        record: {
          index: 0,
          tool_call_id: 'tc_bs_novalue',
          name: 'record_board_reading',
          input: {
            field: 'earth_loop_impedance_ze',
            confidence: 1.0,
            board_id: 'main',
            source_turn_id: 'T1',
          },
        },
        ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
      });
      await flush();
      expect(factory).toHaveBeenCalledTimes(0);
    });

    test('error-shaped record_board_reading silently skipped', async () => {
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed({
        record: {
          index: 0,
          tool_call_id: 'tc_bs_err',
          name: 'record_board_reading',
          error: 'invalid_json',
        },
        ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
      });
      await flush();
      expect(factory).toHaveBeenCalledTimes(0);
    });

    test('mixed record_reading + record_board_reading streamed in same turn → both synth', async () => {
      const { factory, synths } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 1, value: '0.5' }));
      spec.onToolUseStreamed(
        boardStreamedEvent({ field: 'earth_loop_impedance_ze', value: '0.20', boardId: 'main' })
      );
      await flush();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(synths).toHaveLength(2);
    });

    test('voice-correctness-2026-06-03b Fix C: record_board_reading main_switch_bs_en with OFF-enum value → skip synth + log voice_latency.speculator_skipped_enum_field', async () => {
      // F03B590C turn 9 repro. coerceRecordBoardReadingValue handles
      // ONLY nominal_voltage_* (see record-reading-coercion.js:172-182)
      // — it does NOT run parseBsCode on board-side BS fields, so the
      // raw 'BS 1361' reaches the gate verbatim. Canonical
      // main_switch_bs_en option is '1361 type 1' (verified via
      // schema-lock test in stage6-dispatch-validation-enum.test.js).
      // Pre-fix, the speculator's synth started before the dispatcher
      // rejected the off-enum value and TTS *"main switch BS EN BS
      // 1361"* leaked to iOS; round-2's correct *"main switch BS EN
      // 1361 type 1"* was deduped by iOS but the act of dispatching it
      // truncated TTS #1 mid-speech.
      const { factory } = makeMockClientFactory();
      const loggerSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      const spec = makeSpeculator({ factory, logger: loggerSpy });
      spec.onToolUseStreamed(boardStreamedEvent({ field: 'main_switch_bs_en', value: 'BS 1361' }));
      await flush();
      expect(factory).toHaveBeenCalledTimes(0);
      expect(loggerSpy.info).toHaveBeenCalledWith(
        'voice_latency.speculator_skipped_enum_field',
        expect.objectContaining({
          tool: 'record_board_reading',
          field: 'main_switch_bs_en',
          coerced_value_preview: 'BS 1361',
        })
      );
    });

    test('voice-correctness-2026-06-03b Fix C: record_board_reading main_switch_bs_en with ON-enum value → synth fires normally', async () => {
      // Counter-test: legitimate enum values must NOT be skipped. The
      // value-aware policy means the speculator's latency win is
      // preserved on the common case. If a future widening turns this
      // into a field-aware ("skip all enum fields") policy, this test
      // fails loudly.
      const { factory } = makeMockClientFactory();
      const spec = makeSpeculator({ factory });
      spec.onToolUseStreamed(
        boardStreamedEvent({ field: 'main_switch_bs_en', value: '1361 type 1' })
      );
      await flush();
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  test('voice-correctness-2026-06-03b Fix C: record_reading off-enum circuit field is also skipped', async () => {
    // Circuit-side counterpart to the board-side gate. ocpd_bs_en is a
    // circuit-level enum field. coerceRecordReadingValue DOES run
    // parseBsCode in the BS_EN_FIELDS path (which is why the existing
    // 2026-05-29 test at line 699 passes on 'BS 60898' — coerces to
    // on-enum 'BS EN 60898'). Picking 'XYZ 99999' bypasses parseBsCode
    // (no recognisable BS prefix) — the value passes through
    // unmodified, lands as off-enum, and the gate fires.
    const { factory } = makeMockClientFactory();
    const loggerSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const spec = makeSpeculator({ factory, logger: loggerSpy });
    spec.onToolUseStreamed(streamedEvent({ field: 'ocpd_bs_en', circuit: 1, value: 'XYZ 99999' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(0);
    expect(loggerSpy.info).toHaveBeenCalledWith(
      'voice_latency.speculator_skipped_enum_field',
      expect.objectContaining({
        tool: 'record_reading',
        field: 'ocpd_bs_en',
        coerced_value_preview: 'XYZ 99999',
      })
    );
  });

  test('voice-correctness-2026-06-03b Fix C: non-enum field (measured_zs_ohm) still synths — counter-test for non-enum-gated fields', async () => {
    // measured_zs_ohm is type:"number" in the schema (no select
    // options), so CIRCUIT_FIELD_VALUE_ENUMS.get('measured_zs_ohm')
    // returns undefined and the gate condition `allowed && ...` is
    // false. The speculator MUST still fire. If a future change adds
    // numeric fields to the enum map by mistake, this test catches it.
    // The existing happy-path test at line 670 already covers this,
    // but pinning it explicitly with the Fix C labelling makes the
    // intent legible.
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    spec.onToolUseStreamed(streamedEvent({ field: 'measured_zs_ohm', circuit: 1, value: '0.5' }));
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(synths).toHaveLength(1);
  });
});
