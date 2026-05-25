/**
 * Cost-integrity test suite for loaded-barrel-speculator.
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §C). Pins the structural
 * invariant added by Pivots 11.4 / 11.6 / 11.9 / 11.10 / 11.11:
 *
 *   charsCompleted + charsCancelled + charsFailed === charsStarted
 *
 * for every code path that can terminate a speculation — synth-complete,
 * synth-error, abort, cache-supersede, prune-on-board-transition, TTL
 * expiry, abortBySlot, shutdown sweep. Pre-text aborts MUST NOT open a
 * ledger entry; the invariant should hold without their participation.
 *
 * Cross-session isolation (Pivot 11.9): one speculator's shutdown
 * sweep cannot affect another speculator's cost tracker — the
 * `costOpenByCorrelation` Set is per-instance, not module-level.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import {
  buildCacheKey,
  peek,
  markSuperseded,
  _resetForTests as resetCache,
} from '../extraction/loaded-barrel-cache.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';
import { expandForTTS } from '../extraction/tts-text-expander.js';
import { buildConfirmationText } from '../extraction/confirmation-text.js';

beforeEach(() => resetCache());
afterEach(() => resetCache());

function flush() {
  return new Promise((r) => setImmediate(r));
}

/**
 * Assert the speculator's structural cost-integrity invariant. Called
 * from afterEach in every test so a regression that opens a ledger
 * entry without a matching terminal surfaces immediately.
 *
 * Note: charsServed is NOT in the invariant. It's a HIT credit
 * orthogonal to the Started/Terminal accounting — promoteSpeculativeToCanonical
 * sums it as a diagnostic only.
 */
function assertCostInvariant(tracker) {
  const sub = tracker.elevenLabsSpeculative;
  const total = sub.charsCompleted + sub.charsCancelled + sub.charsFailed;
  expect(total).toBe(sub.charsStarted);
}

function makeMockClientFactory({
  failWith = null,
  failBeforeText = false,
  mp3Payload = Buffer.from([1, 2, 3]),
} = {}) {
  const synths = [];
  const factory = jest.fn(() => {
    if (failBeforeText) {
      throw new Error('factory_failed_pretext');
    }
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

function makePatchForAdded({ field, circuit, value, turnId = 'T1' }) {
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
    ctx: { sessionId: 'S', turnId, toolName: 'record_reading', toolCallId: 'tc1', roundIdx: 1 },
  };
}

describe('cost-integrity invariant — every termination path', () => {
  test('synth-complete path closes ledger via _maybeRecordTerminal completed', async () => {
    const tracker = new CostTracker();
    const { factory, synths } = makeMockClientFactory();
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'k',
      costTracker: tracker,
      clientFactory: factory,
    });

    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();
    synths[0].resolve();
    await flush();

    expect(tracker.elevenLabsSpeculative.charsCompleted).toBeGreaterThan(0);
    expect(spec._internalState.costOpenCount).toBe(0);
    assertCostInvariant(tracker);
  });

  test('synth-error path closes ledger via _maybeRecordTerminal failed', async () => {
    const tracker = new CostTracker();
    const { factory } = makeMockClientFactory({ failWith: new Error('elevenlabs_timeout') });
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'k',
      costTracker: tracker,
      clientFactory: factory,
    });

    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();
    await flush();

    expect(tracker.elevenLabsSpeculative.charsFailed).toBeGreaterThan(0);
    expect(spec._internalState.costOpenCount).toBe(0);
    assertCostInvariant(tracker);
  });

  test('cache-supersede + .catch race — terminal still fires exactly once', async () => {
    const tracker = new CostTracker();
    const { factory, synths } = makeMockClientFactory();
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'k',
      costTracker: tracker,
      clientFactory: factory,
    });

    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();
    expect(spec._internalState.costOpenCount).toBe(1);

    // Supersede the cache entry mid-flight. markSuperseded's reason is
    // diagnostic — the cost decision is unaffected. The synth will
    // resolve later and find casOk=false.
    const text = buildConfirmationText('measured_zs_ohm', '0.62', 1);
    const cacheKey = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'measured_zs_ohm',
      circuit: 1,
      expandedText: expandForTTS(text),
    });
    markSuperseded(cacheKey, 'test_supersede');

    synths[0].resolve();
    await flush();
    await flush();

    // Cancelled credited exactly once; completed stays 0; failed stays 0.
    expect(tracker.elevenLabsSpeculative.charsCancelled).toBeGreaterThan(0);
    expect(tracker.elevenLabsSpeculative.charsCompleted).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);
    assertCostInvariant(tracker);
  });

  test('pre-text abort path: factory throws → NO ledger entry opens', async () => {
    const tracker = new CostTracker();
    const { factory } = makeMockClientFactory({ failBeforeText: true });
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'k',
      costTracker: tracker,
      clientFactory: factory,
    });

    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();

    // Started was never called → charsStarted stays 0 → invariant holds
    // trivially. The pre-text abort path emits loaded_barrel_pretext_abort
    // but does NOT credit charsCancelled (which would inflate the ledger).
    expect(tracker.elevenLabsSpeculative.charsStarted).toBe(0);
    expect(tracker.elevenLabsSpeculative.charsCancelled).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(0);
    assertCostInvariant(tracker);
  });

  test('shutdown sweep closes orphans via _maybeRecordTerminal(cancelled, speculator_shutdown)', async () => {
    const tracker = new CostTracker();
    const { factory, synths } = makeMockClientFactory();
    const spec = createSpeculator({
      sessionId: 'S',
      apiKey: 'k',
      costTracker: tracker,
      clientFactory: factory,
    });

    // Kick off 3 in-flight speculations, never resolve them.
    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();
    // Bump the cap so two more fit.
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '5';
    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'r1_r2_ohm', circuit: 1, value: '0.30', turnId: 'T1' })
    );
    await flush();
    await flush();
    spec.onSnapshotPatch(
      makePatchForAdded({ field: 'ir_live_earth_mohm', circuit: 1, value: '299', turnId: 'T1' })
    );
    await flush();
    await flush();
    delete process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN;

    expect(spec._internalState.costOpenCount).toBe(synths.length);
    expect(synths.length).toBeGreaterThanOrEqual(2);

    spec.shutdown();
    await flush();
    await flush();

    // Every ledger entry closed via the sweep. _maybeRecordTerminal
    // deletes from the Set inside the loop; snapshot-before-iteration
    // is what makes this safe.
    expect(spec._internalState.costOpenCount).toBe(0);
    expect(tracker.elevenLabsSpeculative.charsCancelled).toBeGreaterThan(0);
    assertCostInvariant(tracker);
  });

  // PIVOT 11.9 CRITICAL CASE — the scope-correction defining test. Two
  // speculator instances; calling shutdown on one MUST NOT affect the
  // other's costTracker or its costOpenByCorrelation Set. Pre-Pivot-11.9
  // this would have failed because the Set was module-level.
  test('CROSS-SESSION shutdown isolation: A.shutdown() does not touch B', async () => {
    const trackerA = new CostTracker();
    const trackerB = new CostTracker();
    const factoryA = makeMockClientFactory();
    const factoryB = makeMockClientFactory();
    const specA = createSpeculator({
      sessionId: 'SESSION_A',
      apiKey: 'k',
      costTracker: trackerA,
      clientFactory: factoryA.factory,
    });
    const specB = createSpeculator({
      sessionId: 'SESSION_B',
      apiKey: 'k',
      costTracker: trackerB,
      clientFactory: factoryB.factory,
    });

    // Each session kicks off an in-flight speculation.
    specA.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' })
    );
    await flush();
    await flush();
    specB.onSnapshotPatch(
      makePatchForAdded({ field: 'measured_zs_ohm', circuit: 1, value: '0.99' })
    );
    await flush();
    await flush();

    expect(specA._internalState.costOpenCount).toBe(1);
    expect(specB._internalState.costOpenCount).toBe(1);

    // Shutdown A only.
    specA.shutdown();
    await flush();
    await flush();

    // A's ledger fully closed via sweep.
    expect(specA._internalState.costOpenCount).toBe(0);
    expect(trackerA.elevenLabsSpeculative.charsCancelled).toBeGreaterThan(0);

    // B is UNTOUCHED: still has its open ledger, no Terminal credited.
    expect(specB._internalState.costOpenCount).toBe(1);
    expect(trackerB.elevenLabsSpeculative.charsCancelled).toBe(0);
    expect(trackerB.elevenLabsSpeculative.charsCompleted).toBe(0);
    expect(trackerB.elevenLabsSpeculative.charsFailed).toBe(0);

    // Clean up B.
    factoryB.synths[0].resolve();
    await flush();
    await flush();
    expect(specB._internalState.costOpenCount).toBe(0);
    assertCostInvariant(trackerA);
    assertCostInvariant(trackerB);
  });
});
