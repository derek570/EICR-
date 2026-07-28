/**
 * A2-multiboard item 4 — speculator.reconcileCollapsedReplacements.
 *
 * P5 (2026-07-23) collapses a same-turn `clear_reading` → `record_reading` pair
 * at projection time: the stale clear is dropped and only the surviving write
 * reaches the wire, stamped `replaces_cleared: true`. The speculator ran BEFORE
 * any of that, off the raw dispatch, so its parked audio for that slot can be
 * stale — and critically it is parked under whatever the DISPATCH said, which
 * for the common omitted-`board_id` shape is the NULL board while the emitted
 * confirmation carries the enriched effective board.
 *
 * `validateAgainstConfirmations` is not a net for this: it compares expanded
 * TEXT and nothing else, and the board never appears in the spoken line, so a
 * stale null-board entry whose text happens to equal the emitted confirmation
 * is judged VALID and left servable for its whole TTL. Hence a dedicated
 * INVALIDATE-ONLY pass, and hence the exact-key cache door (a slot-wide
 * invalidation would reach into an adjacent turn's entries).
 *
 * Mirrors the mock-client + microtask-flush pattern of
 * loaded-barrel-speculator-drift-validate.test.js so no real ElevenLabs WS
 * opens.
 */

import { jest } from '@jest/globals';

// The logger is mocked — and the module imports therefore dynamic — purely so
// one test can assert the audit row actually REACHES the log. `recordOutcome`
// silently DROPS an outcome that isn't a member of SERVER_OUTCOMES (warn, then
// return), so without that assertion this reconciliation could run for a whole
// release emitting nothing at all. It was in fact first written that way.
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
jest.unstable_mockModule('../logger.js', () => ({ default: mockLogger }));

const { createSpeculator } = await import('../extraction/loaded-barrel-speculator.js');
const { CostTracker } = await import('../extraction/cost-tracker.js');
const {
  buildCacheKey,
  peek,
  _resetForTests: resetCache,
} = await import('../extraction/loaded-barrel-cache.js');
const { buildConfirmationText } = await import('../extraction/confirmation-text.js');
const { expandForTTS } = await import('../extraction/tts-text-expander.js');
const { encodeReadingKey } = await import('../extraction/stage6-per-turn-writes.js');

/** Every `voice_latency.outcome` row logged so far, oldest first. */
function outcomeRows() {
  return mockLogger.info.mock.calls
    .filter(([msg]) => msg === 'voice_latency.outcome')
    .map(([, payload]) => payload);
}

const CAP_ENV = 'VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN';
const MAIN = 'main';
const SUB = 'sub-b';

beforeEach(() => {
  resetCache();
  for (const fn of Object.values(mockLogger)) fn.mockClear();
  // Several cases need 3+ speculations in one turn; the default cap is 2 and a
  // cap-skipped speculation would silently look like a successful terminate.
  process.env[CAP_ENV] = '10';
});

afterEach(() => {
  resetCache();
  delete process.env[CAP_ENV];
  jest.restoreAllMocks();
});

async function flush() {
  await new Promise((r) => setImmediate(r));
}

function makeMockClientFactory({ mp3Payload = Buffer.from([1, 2, 3]) } = {}) {
  const synths = [];
  const factory = jest.fn(() => ({
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
      });
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => rejectSynth(new Error('aborted')));
      }
      return promise;
    }),
    close: jest.fn(),
  }));
  return { factory, synths };
}

function makeSpeculator({ factory }) {
  return createSpeculator({
    sessionId: 'S',
    apiKey: 'test-key',
    costTracker: new CostTracker(),
    clientFactory: factory,
  });
}

function patchForAdded({ field, circuit, boardId = null, value, turnId = 'T1' }) {
  return {
    patch: {
      readings: {
        added: [
          {
            key: encodeReadingKey(field, circuit, boardId),
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
    ctx: { sessionId: 'S', turnId, toolName: 'record_reading', toolCallId: 'tc', roundIdx: 1 },
  };
}

function keyFor({ field, value, circuit, boardId = null, turnId = 'T1' }) {
  return buildCacheKey({
    sessionId: 'S',
    turnId,
    boardId,
    field,
    circuit,
    expandedText: expandForTTS(buildConfirmationText(field, value, circuit, null)),
  });
}

/** Open a speculation and leave it PENDING (synth never resolved). */
async function specPending(spec, { field, circuit, value, boardId = null, turnId = 'T1' }) {
  spec.onSnapshotPatch(patchForAdded({ field, circuit, boardId, value, turnId }));
  await flush();
  return keyFor({ field, value, circuit, boardId, turnId });
}

/** Open a speculation and drive it to READY. */
async function specReady(spec, synths, { field, circuit, value, boardId = null, turnId = 'T1' }) {
  const idxBefore = synths.length;
  const key = await specPending(spec, { field, circuit, value, boardId, turnId });
  synths[idxBefore].resolve();
  await flush();
  return key;
}

/** The wire shape of a P5 collapse survivor. */
function flaggedReading({ field, circuit, value, boardId = null }) {
  return {
    field,
    circuit,
    value,
    confidence: 1.0,
    source: 'tool_call',
    ...(boardId == null ? {} : { board_id: boardId }),
    replaces_cleared: true,
  };
}

function ordinaryReading({ field, circuit, value, boardId = null }) {
  return {
    field,
    circuit,
    value,
    confidence: 1.0,
    source: 'tool_call',
    ...(boardId == null ? {} : { board_id: boardId }),
  };
}

describe('item 4 — a collapsed replacement terminates its speculation', () => {
  test('a PENDING speculation for the flagged slot is terminated', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specPending(spec, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
    });
    expect(peek(key)?.state).toBe('pending');

    const terminated = spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: MAIN }),
      ],
    });

    expect(terminated).toBe(1);
    expect(peek(key)).toBeNull();
  });

  test('a READY speculation is terminated too — markSuperseded could not have', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
    });
    expect(peek(key)?.state).toBe('ready');

    const terminated = spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: MAIN }),
      ],
    });

    expect(terminated).toBe(1);
    expect(peek(key)).toBeNull();
  });

  test('the null-board speculation is matched by the ENRICHED flagged reading', async () => {
    // The defect in one test: the dispatch omitted board_id (scope came from
    // select_board), so the cache key carries null — while the wire reading was
    // enriched with the effective board. Exact-board matching would miss it.
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
      boardId: null,
    });
    expect(peek(key)?.boardId).toBeNull();

    spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: SUB }),
      ],
    });

    expect(peek(key)).toBeNull();
  });

  test('a value-CORRECTED collapse still terminates — reconcile keys on slot, not text', async () => {
    // The clamp/correction shape: the speculation was opened mid-stream off the
    // pre-correction value, so its spoken text differs from the emitted
    // confirmation. validateAgainstConfirmations would also catch this one, but
    // reconcile must not DEPEND on the text agreeing — that dependency is
    // exactly what lets an identical-text stale entry survive.
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const stale = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.83',
    });
    expect(peek(stale)?.state).toBe('ready');

    const terminated = spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        // The surviving write carries the corrected value.
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.63', boardId: MAIN }),
      ],
    });

    expect(terminated).toBe(1);
    expect(peek(stale)).toBeNull();
  });

  test('a GROUPED collapse turn leaves nothing servable for any covered circuit', async () => {
    const { factory } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    // Same field+value across two circuits — the fan-out the bundler collapses
    // into one "Circuits 1 and 2" line.
    const k1 = await specPending(spec, { field: 'measured_zs_ohm', circuit: 1, value: '0.42' });
    const k2 = await specPending(spec, { field: 'measured_zs_ohm', circuit: 2, value: '0.42' });

    spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 1, value: '0.42', boardId: MAIN }),
        flaggedReading({ field: 'measured_zs_ohm', circuit: 2, value: '0.42', boardId: MAIN }),
      ],
    });

    // Whether an entry died to broadcast detection or to reconcile, the
    // end-state contract is the same: no parked audio for either circuit, so
    // the canonical grouped confirmation is what gets synthesised and spoken.
    expect(peek(k1)).toBeNull();
    expect(peek(k2)).toBeNull();
  });
});

describe('item 4 — the termination is auditable', () => {
  test('emits a registered outcome row carrying the slot it killed', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
      boardId: null,
    });

    spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: SUB }),
      ],
    });

    const rows = outcomeRows().filter(
      (r) => r.outcome === 'loaded_barrel_collapsed_replacement_invalidated'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({
      sessionId: 'S',
      turnId: 'T1',
      field: 'measured_zs_ohm',
      circuit: 3,
      // The REGISTRATION's board, not the reading's — that asymmetry is the
      // whole diagnosis when a stale entry shows up in the logs.
      boardId: null,
      aborted: false,
    });
    // The outcome must be a REGISTERED member; an unknown one is dropped with
    // a warn and never reaches voice_latency.outcome at all.
    expect(
      mockLogger.warn.mock.calls.filter(([msg]) => msg === 'voice_latency.unknown_outcome')
    ).toHaveLength(0);
  });

  test('an aborted turn is recorded as such', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    await specReady(spec, synths, { field: 'measured_zs_ohm', circuit: 3, value: '0.42' });

    spec.reconcileCollapsedReplacements(
      'T1',
      {
        extracted_readings: [
          flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: MAIN }),
        ],
      },
      { aborted: true }
    );

    const rows = outcomeRows().filter(
      (r) => r.outcome === 'loaded_barrel_collapsed_replacement_invalidated'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.aborted).toBe(true);
  });
});

describe('item 4 — the blast radius is exactly one registry key', () => {
  test('the SAME field+circuit on the OTHER board survives', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const mainKey = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
      boardId: MAIN,
    });
    const subKey = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.51',
      boardId: SUB,
    });

    const terminated = spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.51', boardId: SUB }),
      ],
    });

    expect(terminated).toBe(1);
    expect(peek(subKey)).toBeNull();
    expect(peek(mainKey)?.state).toBe('ready');
  });

  test("an ADJACENT turn's entry for the same slot survives (exact-key, not by-slot)", async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const t1Key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
      turnId: 'T1',
    });
    // A new turn resets the per-turn registry; T1's CACHE entry lives on until
    // its TTL. invalidateBySlot — session-wide, turn-blind — would kill it.
    const t2Key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.55',
      turnId: 'T2',
    });

    const terminated = spec.reconcileCollapsedReplacements('T2', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.55', boardId: MAIN }),
      ],
    });

    expect(terminated).toBe(1);
    expect(peek(t2Key)).toBeNull();
    expect(peek(t1Key)?.state).toBe('ready');
  });

  test('a DIFFERENT field on the same circuit survives', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const zsKey = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
    });
    const r1Key = await specReady(spec, synths, {
      field: 'r1_r2_ohm',
      circuit: 3,
      value: '0.31',
    });

    spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42', boardId: MAIN }),
      ],
    });

    expect(peek(zsKey)).toBeNull();
    expect(peek(r1Key)?.state).toBe('ready');
  });
});

describe('item 4 — ordinary traffic is untouched', () => {
  test('an ORDINARY omitted-board write keeps its null-board cache hit', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
      boardId: null,
    });
    const synthCountBefore = synths.length;

    const terminated = spec.reconcileCollapsedReplacements('T1', {
      extracted_readings: [
        ordinaryReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42' }),
      ],
    });

    expect(terminated).toBe(0);
    expect(peek(key)?.state).toBe('ready'); // still claimable — no second synthesis
    expect(synths).toHaveLength(synthCountBefore);
  });

  test('a turn with no readings, no registry, or a malformed result is a silent no-op', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
    });

    expect(spec.reconcileCollapsedReplacements('T1', { extracted_readings: [] })).toBe(0);
    expect(spec.reconcileCollapsedReplacements('T1', {})).toBe(0);
    expect(spec.reconcileCollapsedReplacements('T1', null)).toBe(0);
    expect(spec.reconcileCollapsedReplacements('T1', { extracted_readings: [null] })).toBe(0);
    // Unknown turn id — the registry is per-turn, so nothing matches.
    expect(
      spec.reconcileCollapsedReplacements('T-unknown', {
        extracted_readings: [
          flaggedReading({ field: 'measured_zs_ohm', circuit: 3, value: '0.42' }),
        ],
      })
    ).toBe(0);

    expect(peek(key)?.state).toBe('ready');
  });

  test('a non-numeric circuit ref on the flagged reading matches nothing', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    const key = await specReady(spec, synths, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.42',
    });

    expect(
      spec.reconcileCollapsedReplacements('T1', {
        extracted_readings: [
          flaggedReading({ field: 'measured_zs_ohm', circuit: 'unknown', value: '0.42' }),
        ],
      })
    ).toBe(0);
    expect(peek(key)?.state).toBe('ready');
  });

  test('reconcile does not throw when the cache door blows up', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory });
    await specReady(spec, synths, { field: 'measured_zs_ohm', circuit: 3, value: '0.42' });

    // The module contract: a telemetry-adjacent pass must never break
    // extraction. Force an internal throw via a non-iterable registry shape.
    expect(() =>
      spec.reconcileCollapsedReplacements('T1', {
        get extracted_readings() {
          throw new Error('boom');
        },
      })
    ).not.toThrow();
  });
});
