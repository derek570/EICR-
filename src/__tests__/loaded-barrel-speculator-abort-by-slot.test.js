/**
 * abortBySlot + slotMatches normalisation tests for loaded-barrel-speculator.
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11). The
 * fast-TTS route calls abortBySlot the moment it accepts a POST for a
 * slot the speculator may have already started synthesising — iOS will
 * play the fast-path MP3 within ~500ms so finishing the speculator
 * synth wastes ElevenLabs chars + ledger.
 *
 * slotMatches normalises:
 *   - boardId: empty string ("") treated as null (single-board sessions)
 *   - circuit: coerced via Number() so "1" and 1 both match
 *   - circuit:0 stays DISTINCT from circuit:null (board readings are 0;
 *     null is "any" which we deliberately don't support here).
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { _resetForTests as resetCache } from '../extraction/loaded-barrel-cache.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

const SESSION_ID = 'ABORTSESS';

beforeEach(() => resetCache());
afterEach(() => resetCache());

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
        // Honour AbortSignal — that's how abortBySlot actually causes
        // termination.
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            rejectSynth(new Error('elevenlabs_stream_aborted'));
          });
        }
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

function buildPatch({ field, circuit, value, turnId = 'T1' }) {
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

describe('abortBySlot — slotMatches normalisation', () => {
  test('exact match cancels in-flight speculation', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);
    expect(spec._internalState.costOpenCount).toBe(1);

    const count = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
    });
    await flush();
    await flush();

    expect(count).toBe(1);
    expect(spec._internalState.costOpenCount).toBe(0);
  });

  test('boardId empty-string in input normalised to null (single-board)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    // Route sends boardId="" — must match entry's boardId=null.
    const count = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: '',
    });
    await flush();
    await flush();

    expect(count).toBe(1);
  });

  test('circuit coerced via Number(): string "1" matches numeric 1', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    const count = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: '1', // string vs internal numeric 1
      boardId: null,
    });
    await flush();
    await flush();
    expect(count).toBe(1);
  });

  test('circuit:0 does NOT match circuit:null (distinct slots)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    // Target circuit:0 — speculator has circuit:1 — no match expected.
    const noMatch = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 0,
      boardId: null,
    });
    expect(noMatch).toBe(0);

    // Target circuit:null — same outcome.
    const noMatchNull = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: null,
      boardId: null,
    });
    expect(noMatchNull).toBe(0);
  });

  test('mismatched sessionId returns 0 (no cross-session interference)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    const count = spec.abortBySlot({
      sessionId: 'WRONG_SESSION',
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
    });
    expect(count).toBe(0);
    expect(spec._internalState.costOpenCount).toBe(1);
  });

  test('no field in target returns 0 (defensive)', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    const count = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: '',
      circuit: 1,
      boardId: null,
    });
    expect(count).toBe(0);
  });

  test('idempotent: second abortBySlot for same slot returns 0', async () => {
    const tracker = new CostTracker();
    const { spec, synths } = makeSpeculator(tracker);
    spec.onSnapshotPatch(buildPatch({ field: 'measured_zs_ohm', circuit: 1, value: '0.62' }));
    await flush();
    await flush();
    expect(synths.length).toBe(1);

    const first = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
    });
    await flush();
    await flush();
    expect(first).toBe(1);

    const second = spec.abortBySlot({
      sessionId: SESSION_ID,
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 1,
      boardId: null,
    });
    expect(second).toBe(0);
  });
});
