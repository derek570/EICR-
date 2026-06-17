/**
 * Plan B (2026-06-17) B1b — post-loop drift validation + designation parity.
 *
 * Exercises speculator.validateAgainstConfirmations(turnId, confirmations, opts)
 * and the designation threading into _speculate. Mirrors the mock-client +
 * microtask-flush pattern of loaded-barrel-speculator.test.js so no real
 * ElevenLabs WS opens.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import {
  buildCacheKey,
  peek,
  _resetForTests as resetCache,
} from '../extraction/loaded-barrel-cache.js';
import { buildConfirmationText } from '../extraction/confirmation-text.js';
import { expandForTTS } from '../extraction/tts-text-expander.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

const ENV_KEYS = ['VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN'];

beforeEach(() => {
  resetCache();
  for (const k of ENV_KEYS) delete process.env[k];
  // Raise the per-turn cap so multi-slot drift tests aren't capped at 2.
  process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '10';
});

afterEach(() => {
  resetCache();
  for (const k of ENV_KEYS) delete process.env[k];
  jest.restoreAllMocks();
});

async function flush() {
  await new Promise((r) => setImmediate(r));
}

function makeMockClientFactory({ mp3Payload = Buffer.from([1, 2, 3]) } = {}) {
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
          resolve: (timings = {}) => {
            opts.onAudio(mp3Payload);
            resolveSynth(timings);
          },
          reject: (err) => rejectSynth(err),
        });
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => rejectSynth(new Error('aborted')));
        }
        return promise;
      }),
      close: jest.fn(),
    };
    return client;
  });
  return { factory, synths };
}

function makeSpeculator({ factory, initialDesignations = null } = {}) {
  return createSpeculator({
    sessionId: 'S',
    apiKey: 'test-key',
    costTracker: new CostTracker(),
    clientFactory: factory,
    initialDesignations,
  });
}

function patchForAdded({ field, circuit, boardId = null, value, confidence = 1.0, turnId = 'T1' }) {
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
    ctx: { sessionId: 'S', turnId, toolName: 'record_reading', toolCallId: 'tc', roundIdx: 1 },
  };
}

// Compute the canonical expandedText the speculator/bundler produce for a slot,
// optionally with a designation (mirrors buildConfirmationText + expandForTTS).
function expandedFor(field, value, circuit, designation = null) {
  return expandForTTS(buildConfirmationText(field, value, circuit, designation));
}

function keyFor({ field, value, circuit, boardId = null, designation = null, turnId = 'T1' }) {
  return buildCacheKey({
    sessionId: 'S',
    turnId,
    boardId,
    field,
    circuit,
    expandedText: expandedFor(field, value, circuit, designation),
  });
}

// Drive a single reading to a ready cache entry; return its cache key.
async function specToReady(spec, synths, { field, circuit, value, boardId = null, turnId = 'T1' }) {
  const idxBefore = synths.length;
  spec.onSnapshotPatch(patchForAdded({ field, circuit, boardId, value, turnId }));
  await flush();
  synths[idxBefore].resolve();
  await flush();
  return keyFor({ field, value, circuit, boardId, turnId });
}

describe('B1b — validateAgainstConfirmations: match vs drift', () => {
  test('matching emitted confirmation → entry stays servable (no invalidate)', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specToReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.5',
    });
    expect(peek(key)?.state).toBe('ready');

    const text = buildConfirmationText('measured_zs_ohm', '0.5', 1);
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'measured_zs_ohm', circuit: 1, text, expanded_text: expandForTTS(text) },
    ]);

    expect(invalidated).toBe(0);
    expect(peek(key)?.state).toBe('ready'); // still claimable by the canonical POST
  });

  test('no matching emitted confirmation (corrected value) → invalidate + drift outcome', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specToReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.5',
    });
    expect(peek(key)?.state).toBe('ready');

    // Bundler emitted the CORRECTED value (0.6) → speculated 0.5 has no match.
    const corrected = buildConfirmationText('measured_zs_ohm', '0.6', 1);
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'measured_zs_ohm', circuit: 1, text: corrected, expanded_text: expandForTTS(corrected) },
    ]);

    expect(invalidated).toBe(1);
    expect(peek(key)).toBe(null); // dropped → keys.js structurally MISSes → fresh synth
  });

  test('empty / null emitted confirmation set → all live entries invalidated, no throw', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specToReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.5',
    });
    expect(() => spec.validateAgainstConfirmations('T1', null)).not.toThrow();
    expect(peek(key)).toBe(null);
  });

  test('grouped final line → ALL underlying per-slot entries invalidated', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    // Two live per-slot entries (different values so no broadcast suppression);
    // the bundler emits ONE grouped line whose text matches neither.
    const key1 = await specToReady(spec, synths, {
      field: 'insulation_resistance_l_e',
      circuit: 1,
      value: '299',
    });
    const key2 = await specToReady(spec, synths, {
      field: 'insulation_resistance_l_e',
      circuit: 2,
      value: '300',
    });
    expect(peek(key1)?.state).toBe('ready');
    expect(peek(key2)?.state).toBe('ready');

    const grouped = 'Circuits 1 and 2, insulation resistance line to earth';
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'insulation_resistance_l_e', circuit: null, text: grouped, expanded_text: expandForTTS(grouped) },
    ]);

    expect(invalidated).toBe(2);
    expect(peek(key1)).toBe(null);
    expect(peek(key2)).toBe(null);
  });

  test('aborted/cap turn → invalidate ALL live entries regardless of emitted set', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specToReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.5',
    });
    // Even with a MATCHING confirmation present, aborted=true drops everything.
    const text = buildConfirmationText('measured_zs_ohm', '0.5', 1);
    const invalidated = spec.validateAgainstConfirmations(
      'T1',
      [{ field: 'measured_zs_ohm', circuit: 1, text, expanded_text: expandForTTS(text) }],
      { aborted: true }
    );
    expect(invalidated).toBe(1);
    expect(peek(key)).toBe(null);
  });

  test('overwrite mid-turn → stale registry entry skipped; live final entry kept on match', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const staleKey = await specToReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.5',
    });
    expect(peek(staleKey)?.state).toBe('ready');

    // Overwrite the same slot mid-turn → onSnapshotPatch invalidates the old
    // (0.5) entry AND speculates the new value (9.9).
    spec.onSnapshotPatch({
      patch: {
        readings: {
          added: [],
          overwritten: [
            {
              key: encodeReadingKey('measured_zs_ohm', 1, null),
              after: { value: '9.9', confidence: 1.0, source_turn_id: 'T1' },
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
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    synths[1].resolve(); // drive the new 9.9 speculation to ready
    await flush();
    expect(peek(staleKey)).toBe(null); // old (0.5) entry already gone
    const finalKey = keyFor({ field: 'measured_zs_ohm', value: '9.9', circuit: 1 });
    expect(peek(finalKey)?.state).toBe('ready');

    // Bundler emitted the FINAL value (9.9). validate must: skip the stale 0.5
    // registry entry (re-peek null, no double-invalidate / throw) AND keep the
    // matching 9.9 entry servable.
    const finalText = buildConfirmationText('measured_zs_ohm', '9.9', 1);
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'measured_zs_ohm', circuit: 1, text: finalText, expanded_text: expandForTTS(finalText) },
    ]);
    expect(invalidated).toBe(0);
    expect(peek(finalKey)?.state).toBe('ready');
  });
});

describe('B1b — designation parity', () => {
  test('existing named circuit (seeded) → speculated text matches emitted designated text → servable HIT', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory, initialDesignations: new Map([[4, 'Cooker']]) });

    spec.onSnapshotPatch(patchForAdded({ field: 'measured_zs_ohm', circuit: 4, value: '0.5' }));
    await flush();
    // The speculated text must carry the designation (not "Circuit 4").
    expect(synths[0].text).toBe(expandedFor('measured_zs_ohm', '0.5', 4, 'Cooker'));
    synths[0].resolve();
    await flush();

    const key = keyFor({ field: 'measured_zs_ohm', value: '0.5', circuit: 4, designation: 'Cooker' });
    expect(peek(key)?.state).toBe('ready');

    // Bundler emits the SAME designated text → HIT (no invalidate).
    const text = buildConfirmationText('measured_zs_ohm', '0.5', 4, 'Cooker');
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'measured_zs_ohm', circuit: 4, text, expanded_text: expandForTTS(text) },
    ]);
    expect(invalidated).toBe(0);
    expect(peek(key)?.state).toBe('ready');
  });

  test('same-turn circuit_designation observed BEFORE the reading → designation applied', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });

    // Streamed circuit_designation write first (Sonnet renamed circuit 4).
    spec.onToolUseStreamed({
      record: { name: 'record_reading', input: { field: 'circuit_designation', circuit: '4', value: 'Cooker' } },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    // Then the zs reading on circuit 4.
    spec.onToolUseStreamed({
      record: { name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: '4', value: '0.5' } },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();

    const zsSynth = synths.find((s) => s.text.includes('zed S') || s.text.toLowerCase().includes('zed'));
    expect(zsSynth?.text).toBe(expandedFor('measured_zs_ohm', '0.5', 4, 'Cooker'));
  });

  test('ordering edge: reading speculates BEFORE its circuit_designation is observed → safe MISS (drift), not stale serve', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });

    // Reading streams FIRST (no designation observed yet) → un-designated text.
    spec.onToolUseStreamed({
      record: { name: 'record_reading', input: { field: 'measured_zs_ohm', circuit: '4', value: '0.5' } },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    });
    await flush();
    expect(synths[0].text).toBe(expandedFor('measured_zs_ohm', '0.5', 4, null)); // "Circuit 4..."
    synths[0].resolve();
    await flush();
    const undesignatedKey = keyFor({ field: 'measured_zs_ohm', value: '0.5', circuit: 4, designation: null });
    expect(peek(undesignatedKey)?.state).toBe('ready');

    // Designation arrives later; the bundler's FINAL emitted confirmation is
    // designated ("Cooker, ...") → the un-designated parked entry must MISS.
    const designated = buildConfirmationText('measured_zs_ohm', '0.5', 4, 'Cooker');
    const invalidated = spec.validateAgainstConfirmations('T1', [
      { field: 'measured_zs_ohm', circuit: 4, text: designated, expanded_text: expandForTTS(designated) },
    ]);
    expect(invalidated).toBe(1);
    expect(peek(undesignatedKey)).toBe(null); // dropped → fresh synth, never a stale un-designated serve
  });
});
