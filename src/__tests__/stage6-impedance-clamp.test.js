/**
 * Plan D (2026-07-25, feedback id 100(b), field session C06B9904) — the
 * read-back must speak the value that was STORED.
 *
 * Derek dictated "Main earth is sixteen now." on a TN-C-S installation. The
 * assistant SPOKE "Ze 16" while the client independently divided it and `1.6`
 * was written to the certificate: a server/client split-brain in which the
 * inspector's ear-verification loop (Audio-First invariant #1) confirmed a
 * number that was never stored. This suite pins the fix — the SERVER clamps,
 * the server's spoken line names the correction, and every write seam that can
 * reach the snapshot goes through the same clamp.
 *
 * DISCRIMINATION DISCIPLINE (the reason several assertions look over-specified):
 * when a fix makes two values equal, an equality assertion between them is
 * almost always ALREADY TRUE on unfixed `main` (both sides simply hold the raw
 * `16`). Every test below therefore pins the CLAMPED LITERAL and the CONTENT of
 * the spoken line, never a bare cross-equality and never a synthesis COUNT
 * alone. Where a cross-equality is asserted it is stated explicitly as the
 * mirror-vs-seam guard, IN ADDITION to the literal.
 *
 * The `session_ack` capability advert (`server_impedance_clamp`) is covered by
 * its own suite — `sonnet-stream-impedance-clamp-capability.test.js` — and is
 * deliberately NOT duplicated here.
 *
 * The fast-TTS route seam lives in
 * `voice-latency-fast-tts-impedance-clamp.test.js`: that route's module graph
 * needs `jest.unstable_mockModule`, which cannot coexist with this file's
 * static imports.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  IMPEDANCE_CLAMP_CORRECTION,
  ZE_IMPEDANCE_FIELDS,
  CONTINUITY_IMPEDANCE_FIELDS,
  resolveImpedanceKind,
  resolveBoardAwareEarthing,
  clampImpedance,
  clampReadingForDispatch,
} from '../extraction/impedance-clamp.js';
import {
  createWriteDispatcher,
  createSortRecordsAsksLast,
  isEarthingArrangementRecord,
  isBoardContextChangingRecord,
} from '../extraction/stage6-dispatchers.js';
import {
  createPerTurnWrites,
  encodeReadingKey,
  encodeBoardReadingKey,
} from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { buildConfirmationText, buildFanoutGroupKey } from '../extraction/confirmation-text.js';
import { expandForTTS } from '../extraction/tts-text-expander.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';
import { applyOrphanRecoveredReading } from '../extraction/stage6-shadow-harness.js';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import {
  buildCacheKey,
  peek,
  _resetForTests as resetSpeculatorCache,
} from '../extraction/loaded-barrel-cache.js';
import { normaliseDialogueSlotWrite } from '../extraction/dialogue-engine/helpers/dialogue-slot-normalise.js';
import { applyWrite } from '../extraction/dialogue-engine/helpers/snapshot-write.js';
import {
  peekValueCorrection,
  consumeValueCorrection,
  clearValueCorrection,
} from '../extraction/dialogue-engine/helpers/value-corrections.js';
import {
  processDialogueTurn,
  processRingContinuityTurn,
  ringContinuitySchema,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';

// ───────────────────────────────────────────────────────────── helpers ──

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * A session whose ORIGIN SUPPLY carries `earthing_arrangement` — the shape the
 * seeder produces from a job's supply characteristics, i.e. what turn 1 sees
 * with NO `job_state_update` having arrived.
 */
function makeSession({ earthing = null, circuits = {}, boards = null } = {}) {
  const snapshot = {
    circuits: {
      ...(earthing === null ? {} : { 0: { earthing_arrangement: earthing } }),
      ...circuits,
    },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  if (boards) snapshot.boards = boards;
  return { sessionId: 's-clamp', stateSnapshot: snapshot, extractedObservations: [] };
}

async function dispatchBoardReading(session, writes, input, id = 'tu_b1', logger = mockLogger()) {
  const d = createWriteDispatcher(session, logger, 'turn-1', writes);
  return d(
    {
      tool_call_id: id,
      name: 'record_board_reading',
      input: { confidence: 0.95, source_turn_id: 't1', ...input },
    },
    {}
  );
}

async function dispatchCircuitReading(session, writes, input, id = 'tu_c1', logger = mockLogger()) {
  const d = createWriteDispatcher(session, logger, 'turn-1', writes);
  return d(
    {
      tool_call_id: id,
      name: 'record_reading',
      input: { confidence: 0.95, source_turn_id: 't1', ...input },
    },
    {}
  );
}

function bundle(writes) {
  return bundleToolCallsIntoResult(
    writes,
    { questions: [] },
    {
      confirmationsEnabled: true,
      turnId: 'turn-1',
    }
  );
}

const texts = (result) => (result.confirmations ?? []).map((c) => c.text);
const boardEntry = (writes, field) => writes.boardReadings.get(encodeBoardReadingKey(field));

// ═══════════════════════════════════════════════════════════════════════
// §7 — module unit: bands, divisors, fail-safe
// ═══════════════════════════════════════════════════════════════════════

describe('impedance-clamp module — bands and divisors', () => {
  test('in-range values pass through BYTE-IDENTICAL (no rounding, no reformat)', () => {
    // "0.50" must not become "0.5"; a trailing-zero reformat would make the
    // spoken read-back drift from the dictated number for no reason.
    for (const [field, value] of [
      ['earth_loop_impedance_ze', '0.50'],
      ['earth_loop_impedance_ze', '4.999'],
      ['r1_r2_ohm', '1.000'],
      ['r2_ohm', '0.01'],
    ]) {
      const out = clampReadingForDispatch({ field, value, earthing: 'TN-C-S' });
      expect(out.value).toBe(value);
      expect(out.correction).toBeNull();
    }
  });

  test('÷10 — a Ze of 16 on a known non-TT supply corrects to 1.6 and names the divisor', () => {
    const out = clampReadingForDispatch({
      field: 'earth_loop_impedance_ze',
      value: '16',
      earthing: 'TN-C-S',
    });
    expect(out.value).toBe('1.6');
    expect(out.correction).toEqual({ original: '16', corrected: '1.6', divisor: 10 });
  });

  test('÷100 — a continuity reading of 35 corrects to 0.35 (÷10 = 3.5 is still out of band)', () => {
    const out = clampReadingForDispatch({ field: 'r1_r2_ohm', value: '35', earthing: null });
    expect(out.value).toBe('0.35');
    expect(out.correction).toEqual({ original: '35', corrected: '0.35', divisor: 100 });
  });

  test('÷10 wins over ÷100 when BOTH land in band (first divisor that fits)', () => {
    // 16 / 10 = 1.6 ≤ 2.0, so the continuity band takes ÷10 and never tries ÷100.
    const out = clampReadingForDispatch({ field: 'ring_r1_ohm', value: '16', earthing: null });
    expect(out.value).toBe('1.6');
    expect(out.correction.divisor).toBe(10);
  });

  test('out_of_range is a NO-OP: value written unchanged, no correction, nothing to ask', () => {
    // 9000 / 10 = 900 and / 100 = 90 — both outside [0.01, 5]. §4.6 keeps
    // out_of_range behaviour deliberately untouched: the reading is still
    // WRITTEN (Audio-First #2 — never silently drop) and read back as dictated.
    const out = clampReadingForDispatch({
      field: 'earth_loop_impedance_ze',
      value: '9000',
      earthing: 'TN-S',
    });
    expect(out.value).toBe('9000');
    expect(out.correction).toBeNull();
    expect(clampImpedance('ze', '9000', 'TN-S')).toEqual({ kind: 'out_of_range', value: '9000' });
  });

  test('non-string / non-numeric values are left entirely to the validator', () => {
    for (const value of [null, undefined, { a: 1 }, ['16'], true]) {
      const out = clampReadingForDispatch({ field: 'r1_r2_ohm', value, earthing: null });
      expect(out.value).toBe(value);
      expect(out.correction).toBeNull();
    }
  });
});

describe('impedance-clamp module — which fields are in a band', () => {
  test.each(ZE_IMPEDANCE_FIELDS)('%s resolves to the ze band and clamps', (field) => {
    expect(resolveImpedanceKind(field)).toBe('ze');
    // `zs_at_db` is DISPATCHER-UNREACHABLE (absent from BOARD_FIELD_ENUM), so
    // it is exercised here through the seam entry point directly — the enum
    // could widen tomorrow and must not silently gain an unclamped spelling.
    expect(clampReadingForDispatch({ field, value: '16', earthing: 'TN-C-S' }).value).toBe('1.6');
  });

  test.each(CONTINUITY_IMPEDANCE_FIELDS)('%s resolves to the continuity band', (field) => {
    expect(resolveImpedanceKind(field)).toBe('continuity');
    expect(clampReadingForDispatch({ field, value: '16', earthing: null }).value).toBe('1.6');
  });

  test('measured_zs_ohm is NOT clamped — a 5 Ω circuit Zs survives verbatim', () => {
    // A long final circuit legitimately reads tens of ohms and the range gate
    // already allows 0–100 Ω. Adding it to a band would start silently
    // dividing valid readings — a WORSE defect than the one being fixed.
    expect(resolveImpedanceKind('measured_zs_ohm')).toBeNull();
    for (const value of ['5', '16', '35.5']) {
      const out = clampReadingForDispatch({ field: 'measured_zs_ohm', value, earthing: 'TN-C-S' });
      expect(out.value).toBe(value);
      expect(out.correction).toBeNull();
    }
  });

  test('every other field passes through untouched', () => {
    for (const field of [
      'rcd_trip_time_ms',
      'circuit_designation',
      'polarity_confirmed',
      '',
      null,
    ]) {
      expect(resolveImpedanceKind(field)).toBeNull();
    }
  });
});

describe('impedance-clamp module — earthing fail-safe (ze band only)', () => {
  const ZE_SPELLINGS = ['ze', 'earth_loop_impedance_ze'];

  test.each(ZE_SPELLINGS)('%s: TT leaves 16 ALONE (a rod earth legitimately reads 16 Ω)', (f) => {
    const out = clampReadingForDispatch({ field: f, value: '16', earthing: 'TT' });
    expect(out.value).toBe('16');
    expect(out.correction).toBeNull();
  });

  test.each(ZE_SPELLINGS)('%s: UNKNOWN earthing leaves 16 ALONE (fail safe)', (f) => {
    for (const earthing of [null, undefined, '', '   ']) {
      const out = clampReadingForDispatch({ field: f, value: '16', earthing });
      expect(out.value).toBe('16');
      expect(out.correction).toBeNull();
    }
  });

  test.each(ZE_SPELLINGS)('%s: KNOWN non-TT divides 16 to 1.6', (f) => {
    for (const earthing of ['TN-C-S', 'TN-S', 'TN-C', 'IT']) {
      const out = clampReadingForDispatch({ field: f, value: '16', earthing });
      expect(out.value).toBe('1.6');
    }
  });

  test('continuity bands are earthing-INDEPENDENT — unknown earthing still clamps', () => {
    // The fail-safe exists because the TT ze band is 40× wider. Continuity has
    // no such split, so an unresolved arrangement must NOT suppress the clamp.
    expect(clampReadingForDispatch({ field: 'r1_r2_ohm', value: '16' }).value).toBe('1.6');
    expect(clampReadingForDispatch({ field: 'r1_r2_ohm', value: '16', earthing: 'TT' }).value).toBe(
      '1.6'
    );
  });
});

describe('resolveBoardAwareEarthing — source ladder', () => {
  test('turn 1, no job_state_update: the seeded origin supply resolves', () => {
    const session = makeSession({ earthing: 'TN-C-S' });
    expect(resolveBoardAwareEarthing(session.stateSnapshot, null)).toBe('TN-C-S');
  });

  test('board-local record wins over the origin when both are present and non-TT', () => {
    const snapshot = {
      circuits: { 0: { earthing_arrangement: 'TN-S' } },
      boards: [{ id: 'db2', earthing_arrangement: 'TN-C-S' }],
      currentBoardId: 'db2',
    };
    expect(resolveBoardAwareEarthing(snapshot, 'db2')).toBe('TN-C-S');
  });

  test('TT WINS ACROSS SOURCES in BOTH directions', () => {
    // Asymmetric on purpose: believing TT can only ever leave a value alone,
    // whereas believing not-TT can divide a perfectly good rod-earth reading.
    const originTT = {
      circuits: { 0: { earthing_arrangement: 'TT' } },
      boards: [{ id: 'db2', earthing_arrangement: 'TN-C-S' }],
      currentBoardId: 'db2',
    };
    expect(resolveBoardAwareEarthing(originTT, 'db2')).toBe('TT');

    const boardTT = {
      circuits: { 0: { earthing_arrangement: 'TN-C-S' } },
      boards: [{ id: 'db2', earthing_arrangement: 'TT' }],
      currentBoardId: 'db2',
    };
    expect(resolveBoardAwareEarthing(boardTT, 'db2')).toBe('TT');
  });

  test('non-scalar / blank values never pick a band', () => {
    expect(
      resolveBoardAwareEarthing({ circuits: { 0: { earthing_arrangement: ['TT'] } } }, null)
    ).toBeNull();
    expect(
      resolveBoardAwareEarthing({ circuits: { 0: { earthing_arrangement: '  ' } } }, null)
    ).toBeNull();
    expect(resolveBoardAwareEarthing(null, null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — drift: the backend mirror against the TRACKED TypeScript source
// ═══════════════════════════════════════════════════════════════════════

describe('drift — impedance-clamp.js mirrors packages/shared-utils/src/circuit-derivations.ts', () => {
  // jest.config.js sets `transform: {}` — the backend cannot import the .ts
  // source, which is exactly why impedance-clamp.js is a hand-written mirror.
  // A hand-written mirror needs a drift pin: this reads the TRACKED TS source
  // (never a build artefact / node_modules copy), extracts the numbers that
  // define the algorithm, and asserts the JS mirror behaves to THOSE numbers.
  const tsPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../packages/shared-utils/src/circuit-derivations.ts'
  );
  const ts = readFileSync(tsPath, 'utf8');
  const clampSrc = (() => {
    // Anchor by SYMBOL, never by line number or by a "next export" heuristic —
    // this file is edited often, and `resolveZe` happens to sit ABOVE the clamp
    // block, so an ordering assumption silently yields an EMPTY slice whose
    // regexes then match nothing.
    const start = ts.indexOf('function bounds(');
    const clampStart = ts.indexOf('export function clampImpedance', start);
    const end = ts.indexOf('\n}\n', clampStart);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(clampStart).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(clampStart);
    return ts.slice(start, end + 3);
  })();

  function bandFrom(re) {
    const m = clampSrc.match(re);
    expect(m).not.toBeNull();
    return [Number(m[1]), Number(m[2])];
  }

  const TT_BAND = bandFrom(/includes\('TT'\)\)\s*\{\s*return \[([\d.]+), ([\d.]+)\];/);
  const NON_TT_BAND = bandFrom(/includes\('TT'\)\)[\s\S]*?\}\s*return \[([\d.]+), ([\d.]+)\];/);
  const CONTINUITY_BAND = bandFrom(/case 'continuity':[\s\S]*?return \[([\d.]+), ([\d.]+)\];/);
  const DIVISORS = (() => {
    const m = clampSrc.match(/for \(const divisor of \[([\d, ]+)\]\)/);
    expect(m).not.toBeNull();
    return m[1].split(',').map((s) => Number(s.trim()));
  })();

  test('the extracted bands are the ones the algorithm is documented around', () => {
    // Guards the extraction itself — if the regexes silently stopped matching
    // the real branches, the boundary tests below would pin nothing.
    expect(TT_BAND).toEqual([0.01, 200]);
    expect(NON_TT_BAND).toEqual([0.01, 5]);
    expect(CONTINUITY_BAND).toEqual([0.01, 2]);
    expect(DIVISORS).toEqual([10, 100]);
  });

  test.each([
    ['ze', 'TT', () => TT_BAND],
    ['ze', 'TN-C-S', () => NON_TT_BAND],
    ['continuity', null, () => CONTINUITY_BAND],
  ])('the JS mirror honours the TS band for %s / %s', (kind, earthing, band) => {
    const [lo, hi] = band();
    expect(clampImpedance(kind, String(lo), earthing).kind).toBe('ok');
    expect(clampImpedance(kind, String(hi), earthing).kind).toBe('ok');
    // Just outside the top of the band the mirror must stop saying "ok".
    expect(clampImpedance(kind, String(hi * 1.01), earthing).kind).not.toBe('ok');
  });

  test('the JS mirror tries the TS divisors in the TS order', () => {
    const [first, second] = DIVISORS;
    const [, hi] = CONTINUITY_BAND;
    // A value that fits the FIRST divisor must report the first, never the second.
    expect(clampImpedance('continuity', String(hi * first * 0.8), null).divisor).toBe(first);
    // A value too big for the first but fitting the second reports the second.
    expect(clampImpedance('continuity', String(hi * second * 0.4), null).divisor).toBe(second);
  });

  test('formatCorrected: 2 dp, trailing zeros trimmed (TS keeps toFixed(2))', () => {
    expect(clampSrc).toContain('toFixed(2)');
    expect(clampSrc).toContain('Math.round(d * 100) / 100');
    expect(clampImpedance('continuity', '16', null).corrected).toBe('1.6'); // not "1.60"
    expect(clampImpedance('continuity', '20', null).corrected).toBe('2'); // not "2.00"
    expect(clampImpedance('continuity', '123', null).corrected).toBe('1.23');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — the C06B9904 repro, end to end
// ═══════════════════════════════════════════════════════════════════════

describe('C06B9904 — "Main earth is sixteen now." on a TN-C-S installation', () => {
  test('dispatcher → bundler → confirmation: stored 1.6, emitted 1.6, ONE line naming 16 → 1.6', async () => {
    const session = makeSession({ earthing: 'TN-C-S' });
    const writes = createPerTurnWrites();

    const envelope = await dispatchBoardReading(session, writes, {
      field: 'earth_loop_impedance_ze',
      value: '16',
    });
    expect(envelope.is_error).toBe(false);

    const result = bundle(writes);
    const emitted = (result.extracted_board_readings ?? []).filter(
      (r) => r.field === 'earth_loop_impedance_ze'
    );

    // Assert BOTH the snapshot AND the emitted value equal the CLAMPED LITERAL
    // `1.6` — not merely that they equal each other. The cross-equality below
    // is the mirror-vs-seam guard; the pin to `1.6` is what makes this test
    // DISCRIMINATING. On unfixed `main` both sides hold the raw `16` and are
    // already equal, so a cross-equality alone proves nothing. Do not let a
    // later reader re-weaken this to `expect(stored).toBe(emitted)`.
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('1.6');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].value).toBe('1.6');
    expect(emitted[0].value).toBe(session.stateSnapshot.circuits[0].earth_loop_impedance_ze);

    // The spoken line NAMES the alteration, and there is exactly ONE of it —
    // the inspector hears the number that was actually stored, once.
    expect(texts(result)).toEqual(['Ze recorded as 1.6 — I corrected 16 to 1.6']);
  });

  test('the SAME utterance on a TT installation stores and speaks the raw 16', async () => {
    const session = makeSession({ earthing: 'TT' });
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, {
      field: 'earth_loop_impedance_ze',
      value: '16',
    });
    const result = bundle(writes);
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('16');
    expect(texts(result)).toEqual(['Ze 16']);
  });

  test('with the earthing arrangement UNRESOLVED nothing is altered and nothing is claimed', async () => {
    const session = makeSession({ earthing: null });
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, {
      field: 'earth_loop_impedance_ze',
      value: '16',
    });
    const result = bundle(writes);
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('16');
    expect(texts(result)).toEqual(['Ze 16']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — the dispatcher pre-write seams
// ═══════════════════════════════════════════════════════════════════════

describe('dispatcher seams — board', () => {
  test.each(['ze', 'earth_loop_impedance_ze', 'ze_at_db'])(
    '%s clamps at the board dispatcher and stashes the correction for the bundler',
    async (field) => {
      const session = makeSession({ earthing: 'TN-S' });
      const writes = createPerTurnWrites();
      await dispatchBoardReading(session, writes, { field, value: '16' });
      const stored = [...writes.boardReadings.values()];
      expect(stored).toHaveLength(1);
      expect(stored[0].value).toBe('1.6');
      expect(stored[0][IMPEDANCE_CLAMP_CORRECTION]).toEqual({
        original: '16',
        corrected: '1.6',
        divisor: 10,
      });
    }
  );

  test('a clamped board write emits ONE stage6.impedance_clamp_applied row naming its seam', async () => {
    const session = makeSession({ earthing: 'TN-S' });
    const logger = mockLogger();
    await dispatchBoardReading(
      session,
      createPerTurnWrites(),
      { field: 'earth_loop_impedance_ze', value: '16' },
      'tu_log',
      logger
    );
    const rows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.impedance_clamp_applied');
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({ original: '16', corrected: '1.6', divisor: 10 });
    expect(typeof rows[0][1].seam).toBe('string');
  });

  test('an UNCLAMPED board write logs no clamp row and stashes no marker', async () => {
    const session = makeSession({ earthing: 'TN-S' });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    await dispatchBoardReading(
      session,
      writes,
      { field: 'earth_loop_impedance_ze', value: '0.35' },
      'tu_ok',
      logger
    );
    expect(logger.info.mock.calls.filter((c) => c[0] === 'stage6.impedance_clamp_applied')).toEqual(
      []
    );
    expect(
      boardEntry(writes, 'earth_loop_impedance_ze')[IMPEDANCE_CLAMP_CORRECTION]
    ).toBeUndefined();
  });

  test('EXEMPTION — the bonding PASS mirror is a derived tick, not a dictated magnitude', async () => {
    // The mirror writes the string 'PASS'; it must never be dragged through a
    // numeric band (and, being derived, must never be spoken either).
    const session = makeSession({ earthing: 'TN-S' });
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, { field: 'bonding_water', value: 'PASS' });
    const mirror = boardEntry(writes, 'bonding_conductor_continuity');
    expect(mirror).toMatchObject({ value: 'PASS', auto_resolved: true });
    expect(mirror[IMPEDANCE_CLAMP_CORRECTION]).toBeUndefined();
  });
});

describe('dispatcher seams — circuit', () => {
  test.each(CONTINUITY_IMPEDANCE_FIELDS)(
    '%s clamps at the circuit dispatcher and reads back the STORED value',
    async (field) => {
      const session = makeSession({ earthing: 'TN-C-S', circuits: { 3: {} } });
      const writes = createPerTurnWrites();
      const envelope = await dispatchCircuitReading(session, writes, {
        field,
        circuit: 3,
        value: '35',
      });
      expect(envelope.is_error).toBe(false);
      expect(session.stateSnapshot.circuits[3][field]).toBe('0.35');
      const entry = writes.readings.get(encodeReadingKey(field, 3));
      expect(entry.value).toBe('0.35');
      expect(entry[IMPEDANCE_CLAMP_CORRECTION]).toEqual({
        original: '35',
        corrected: '0.35',
        divisor: 100,
      });
      const result = bundle(writes);
      expect(texts(result)).toContain(
        buildConfirmationText(field, '0.35', 3, null, {
          correction: { original: '35', corrected: '0.35', divisor: 100 },
        })
      );
    }
  );

  test('EXEMPTION — a CALCULATED r1_r2_ohm is never clamped, however large', async () => {
    // The clamp exists to undo a DICTATION artefact (Deepgram dropping a
    // decimal). A calculator result is arithmetic over values that were each
    // already clamped on the way in, so re-clamping it would silently divide a
    // correct derivation by 10 — and, being derived, it must not claim a
    // correction either. `applyCalculatedReading` deliberately bypasses the
    // clamp; this pins that.
    const session = makeSession({
      earthing: 'TN-C-S',
      circuits: { 4: { ring_r1_ohm: '20', ring_r2_ohm: '20' } },
    });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const envelope = await d(
      {
        tool_call_id: 'tu_calc',
        name: 'calculate_r1_plus_r2',
        input: { method: 'ring_continuity', circuit_ref: 4 },
      },
      {}
    );
    expect(envelope.is_error).toBe(false);
    // (20 + 20) / 4 = 10.00 — far outside the [0.01, 2] continuity band.
    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('10.00');
    const entry = writes.readings.get(encodeReadingKey('r1_r2_ohm', 4));
    expect(entry.value).toBe('10.00');
    expect(entry[IMPEDANCE_CLAMP_CORRECTION]).toBeUndefined();
    expect(texts(bundle(writes)).join(' ')).not.toContain('I corrected');
  });

  test('a circuit measured_zs_ohm of 16 survives the dispatcher verbatim', async () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 3: {} } });
    const writes = createPerTurnWrites();
    await dispatchCircuitReading(session, writes, {
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '16',
    });
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('16');
    expect(texts(bundle(writes))).toEqual(['Circuit 3, Zs 16']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — correction transport, fan-out identity, and the wire boundary
// ═══════════════════════════════════════════════════════════════════════

describe('correction transport through the bundler', () => {
  test('the correction survives the bundler REBUILD — asserted on the spoken TEXT', async () => {
    // The bundler does not forward the dispatcher's entry object: it builds a
    // NEW reading record per emitted row. Asserting "the dispatcher set a
    // Symbol" would pass even if the bundler dropped it on the floor, so the
    // assertion has to be the text that comes OUT.
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 7: {} } });
    const writes = createPerTurnWrites();
    await dispatchCircuitReading(session, writes, {
      field: 'r1_r2_ohm',
      circuit: 7,
      value: '16',
    });
    expect(texts(bundle(writes))).toEqual([
      'Circuit 7, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6',
    ]);
  });

  test('the marker NEVER reaches the wire', async () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 7: {} } });
    const writes = createPerTurnWrites();
    await dispatchCircuitReading(session, writes, { field: 'r1_r2_ohm', circuit: 7, value: '16' });
    await dispatchBoardReading(session, writes, {
      field: 'earth_loop_impedance_ze',
      value: '16',
    });
    const result = bundle(writes);
    // A Symbol key is invisible to JSON.stringify by construction — that is
    // WHY a Symbol was chosen over a string key (a string key would need a
    // strip step at every wire boundary, and would start shipping the moment
    // someone added a new one). Prove the property rather than trusting it.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('impedanceClampCorrection');
    expect(serialised).not.toContain('correction');
    for (const row of [
      ...(result.extracted_readings ?? []),
      ...(result.extracted_board_readings ?? []),
    ]) {
      expect(Object.getOwnPropertySymbols(row)).toEqual([]);
    }
  });
});

describe('fan-out identity — a corrected write never merges with an uncorrected one', () => {
  test('buildFanoutGroupKey separates corrected from uncorrected at the SAME value', () => {
    const base = { field: 'r1_r2_ohm', value: '1.6', boardId: null, calculated: false };
    const uncorrected = buildFanoutGroupKey({ ...base, correction: null });
    const corrected = buildFanoutGroupKey({
      ...base,
      correction: { original: '16', corrected: '1.6', divisor: 10 },
    });
    expect(corrected).not.toBe(uncorrected);
    // Two writes corrected the SAME way DO share an identity — otherwise a
    // genuine fan-out would fragment into one line per circuit.
    expect(
      buildFanoutGroupKey({
        ...base,
        correction: { original: '16', corrected: '1.6', divisor: 10 },
      })
    ).toBe(corrected);
  });

  test('bundler: circuit dictated 1.6 and circuit dictated 16 do NOT collapse into one line', async () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 1: {}, 2: {} } });
    const writes = createPerTurnWrites();
    // Both end up STORED as 1.6 — the only thing distinguishing them is that
    // one was altered by the server, which the inspector must hear about.
    await dispatchCircuitReading(
      session,
      writes,
      { field: 'r1_r2_ohm', circuit: 1, value: '1.6' },
      'a'
    );
    await dispatchCircuitReading(
      session,
      writes,
      { field: 'r1_r2_ohm', circuit: 2, value: '16' },
      'b'
    );
    expect(session.stateSnapshot.circuits[1].r1_r2_ohm).toBe('1.6');
    expect(session.stateSnapshot.circuits[2].r1_r2_ohm).toBe('1.6');

    const spoken = texts(bundle(writes));
    expect(spoken).toHaveLength(2);
    expect(spoken).toContain('Circuit 1, R1 plus R2 1.6');
    expect(spoken).toContain('Circuit 2, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6');
    // The failure this pins: a value-only group key merges them into
    // "Circuits 1 and 2, R1 plus R2 1.6" and the correction is never spoken.
    expect(spoken.some((t) => /Circuits 1 (and|to) 2/.test(t))).toBe(false);
  });

  test('bundler: two circuits corrected IDENTICALLY still fan out into one grouped line', async () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 1: {}, 2: {} } });
    const writes = createPerTurnWrites();
    await dispatchCircuitReading(
      session,
      writes,
      { field: 'r1_r2_ohm', circuit: 1, value: '16' },
      'a'
    );
    await dispatchCircuitReading(
      session,
      writes,
      { field: 'r1_r2_ohm', circuit: 2, value: '16' },
      'b'
    );
    const spoken = texts(bundle(writes));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('I corrected 16 to 1.6');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — the orphan-recovery seam (an INDEPENDENT write path)
// ═══════════════════════════════════════════════════════════════════════

describe('orphan-recovery seam', () => {
  test('a recovered continuity reading is clamped, emitted clamped, and read back naming the correction', () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 4: {} } });
    const result = {};
    const reading = applyOrphanRecoveredReading({
      session,
      result,
      tuple: { slotField: 'r1_r2_ohm', circuit: 4, value: '16' },
      turnId: 't1',
    });
    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('1.6');
    expect(reading.value).toBe('1.6');
    expect(result.extracted_readings[0].value).toBe('1.6');
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toBe(
      'Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
    );
  });

  test('an in-band recovered reading is byte-unchanged and speaks the plain line', () => {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 4: {} } });
    const result = {};
    applyOrphanRecoveredReading({
      session,
      result,
      tuple: { slotField: 'r1_r2_ohm', circuit: 4, value: '0.35' },
      turnId: 't1',
    });
    expect(session.stateSnapshot.circuits[4].r1_r2_ohm).toBe('0.35');
    expect(result.confirmations[0].text).toBe('Circuit 4, R1 plus R2 0.35');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — Loaded Barrel speculator parity (the line the inspector actually HEARS)
// ═══════════════════════════════════════════════════════════════════════

describe('Loaded Barrel speculator — parity with the dispatcher', () => {
  const OLD_FLAG = process.env.VOICE_LATENCY_LOADED_BARREL;

  beforeEach(() => {
    resetSpeculatorCache();
    process.env.VOICE_LATENCY_LOADED_BARREL = 'true';
  });
  afterEach(() => {
    resetSpeculatorCache();
    if (OLD_FLAG === undefined) delete process.env.VOICE_LATENCY_LOADED_BARREL;
    else process.env.VOICE_LATENCY_LOADED_BARREL = OLD_FLAG;
  });

  function makeMockClientFactory() {
    const synths = [];
    const factory = jest.fn(() => {
      const client = {
        synth: jest.fn((text, opts) => {
          let resolveSynth;
          const promise = new Promise((res) => {
            resolveSynth = res;
          });
          synths.push({
            text,
            resolve: () => {
              opts.onAudio(Buffer.from([1, 2, 3]));
              resolveSynth({});
            },
          });
          return promise;
        }),
        close: jest.fn(),
      };
      return client;
    });
    return { factory, synths };
  }

  function makeSpeculator(factory, resolveEarthing) {
    return createSpeculator({
      sessionId: 'S',
      apiKey: 'test-key',
      costTracker: new CostTracker(),
      clientFactory: factory,
      resolveEarthing,
    });
  }

  const flush = () => new Promise((r) => setImmediate(r));

  function streamedBoard({ field, value, boardId = null }) {
    return {
      record: {
        index: 0,
        tool_call_id: 'tc_s1',
        name: 'record_board_reading',
        input: {
          field,
          value,
          confidence: 1.0,
          source_turn_id: 'T1',
          ...(boardId != null ? { board_id: boardId } : {}),
        },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    };
  }

  function streamedCircuit({ field, circuit, value }) {
    return {
      record: {
        index: 0,
        tool_call_id: 'tc_s2',
        name: 'record_reading',
        input: { field, circuit, value, confidence: 1.0, source_turn_id: 'T1' },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    };
  }

  test('board Ze on a KNOWN non-TT board: the SPECULATED text names the correction', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => 'TN-C-S');
    spec.onToolUseStreamed(streamedBoard({ field: 'earth_loop_impedance_ze', value: '16' }));
    await flush();

    // DISCRIMINATING on CONTENT, never on the COUNT of syntheses: an unfixed
    // speculator also synthesises exactly once — it just says "Ze 16".
    const expectedText = 'Ze recorded as 1.6 — I corrected 16 to 1.6';
    expect(synths).toHaveLength(1);
    expect(synths[0].text).toBe(expandForTTS(expectedText));

    // And the cache is keyed on that same text, so the dispatcher's later
    // POST for the identical slot HITS rather than re-synthesising a
    // contradictory line.
    const key = buildCacheKey({
      sessionId: 'S',
      turnId: 'T1',
      boardId: null,
      field: 'earth_loop_impedance_ze',
      circuit: null,
      expandedText: expandForTTS(expectedText),
    });
    expect(peek(key)?.state).toBe('pending');
    synths[0].resolve();
    await flush();
    expect(peek(key)?.state).toBe('ready');
  });

  test('board Ze on a TT board speculates the RAW value (no correction claimed)', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => 'TT');
    spec.onToolUseStreamed(streamedBoard({ field: 'earth_loop_impedance_ze', value: '16' }));
    await flush();
    expect(synths[0].text).toBe(expandForTTS('Ze 16'));
  });

  test('board Ze with UNKNOWN earthing speculates the RAW value (fail safe)', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => null);
    spec.onToolUseStreamed(streamedBoard({ field: 'earth_loop_impedance_ze', value: '16' }));
    await flush();
    expect(synths[0].text).toBe(expandForTTS('Ze 16'));
  });

  test('a throwing resolveEarthing degrades to "unknown", never to a wrong band', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => {
      throw new Error('snapshot gone');
    });
    spec.onToolUseStreamed(streamedBoard({ field: 'earth_loop_impedance_ze', value: '16' }));
    await flush();
    expect(synths[0].text).toBe(expandForTTS('Ze 16'));
  });

  test('circuit continuity clamps in the speculator exactly as in the dispatcher', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => 'TN-C-S');
    spec.onToolUseStreamed(streamedCircuit({ field: 'r1_r2_ohm', circuit: 4, value: '16' }));
    await flush();
    expect(synths[0].text).toBe(
      expandForTTS('Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6')
    );
  });

  test('speculated text is BYTE-IDENTICAL to the bundler line for the same slot', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator(factory, () => 'TN-C-S');
    spec.onToolUseStreamed(streamedCircuit({ field: 'r1_r2_ohm', circuit: 4, value: '16' }));
    await flush();

    const session = makeSession({ earthing: 'TN-C-S', circuits: { 4: {} } });
    const writes = createPerTurnWrites();
    await dispatchCircuitReading(session, writes, { field: 'r1_r2_ohm', circuit: 4, value: '16' });
    const bundled = texts(bundle(writes));

    expect(bundled).toHaveLength(1);
    // The two producers must agree byte-for-byte or the pre-synth cache MISSES
    // and the inspector hears two contradictory lines for one reading.
    expect(synths[0].text).toBe(expandForTTS(bundled[0]));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — dialogue Seam A: normaliseDialogueSlotWrite
// ═══════════════════════════════════════════════════════════════════════

describe('dialogue Seam A — normaliseDialogueSlotWrite', () => {
  test('an out-of-band seeded continuity value is CORRECTED, not rejected', () => {
    // Clamp-then-validate is the mandated order. Validating first would reject
    // the write outright — a dropped reading, Audio-First #2.
    const out = normaliseDialogueSlotWrite(ringContinuitySchema, 'ring_r1_ohm', '16', null);
    expect(out).toEqual({
      ok: true,
      value: '1.6',
      correction: { original: '16', corrected: '1.6', divisor: 10 },
    });
  });

  test('an in-band value passes through with correction null', () => {
    expect(normaliseDialogueSlotWrite(ringContinuitySchema, 'ring_r1_ohm', '0.43', null)).toEqual({
      ok: true,
      value: '0.43',
      correction: null,
    });
  });

  test('LIM is a limitation, not a magnitude — never divided', () => {
    const out = normaliseDialogueSlotWrite(ringContinuitySchema, 'ring_r1_ohm', 'lim', null);
    expect(out).toEqual({ ok: true, value: 'LIM', correction: null });
  });

  test('the ze family is NOT reachable through this seam — and no schema can make it so', () => {
    // Seam A clamps only what it also validates: NUMERIC_READING_FIELDS. The ze
    // family is absent from that set, so a ze value handed to this seam passes
    // through untouched — which is CORRECT today only because no dialogue
    // schema declares a ze slot (ze reaches the snapshot via the board
    // dispatcher and Seam B instead). Pin BOTH halves: if a future schema adds
    // a ze slot, this test fails and forces the seam to be widened rather than
    // silently storing a raw 16.
    expect(
      normaliseDialogueSlotWrite(ringContinuitySchema, 'earth_loop_impedance_ze', '16', 'TN-C-S')
    ).toMatchObject({ ok: true, value: '16', correction: null });

    const slotFields = ALL_DIALOGUE_SCHEMAS.flatMap((s) =>
      (s.slots ?? []).map((slot) => slot.field).filter(Boolean)
    );
    expect(slotFields.length).toBeGreaterThan(0);
    for (const f of slotFields) {
      expect(ZE_IMPEDANCE_FIELDS).not.toContain(f);
      // ...and every CONTINUITY slot a schema does declare must be one this
      // seam actually clamps, or the clamp would be a no-op on the live path.
      if (CONTINUITY_IMPEDANCE_FIELDS.includes(f)) {
        expect(normaliseDialogueSlotWrite(ringContinuitySchema, f, '16', null)).toMatchObject({
          ok: true,
          value: '1.6',
        });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — dialogue Seam B: applyWrite + the state-scoped correction ledger
// ═══════════════════════════════════════════════════════════════════════

describe('dialogue Seam B — through a REAL engine caller', () => {
  class FakeWS {
    constructor() {
      this.OPEN = 1;
      this.readyState = this.OPEN;
      this.sent = [];
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
  }

  function ringSession(circuits = { 13: {} }) {
    return {
      sessionId: 'sess_ring_clamp',
      stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
    };
  }

  function ringTurn(ws, session, transcriptText, now) {
    return processRingContinuityTurn({
      ws,
      session,
      sessionId: session.sessionId,
      transcriptText,
      rawReplyText: transcriptText,
      logger: null,
      now,
    });
  }

  test('a dictated 16 mid-script is STORED as 1.6 and the triple read-back names the correction', () => {
    const ws = new FakeWS();
    const session = ringSession();
    ringTurn(ws, session, 'Ring continuity for circuit 13.', 1000);
    ringTurn(ws, session, '16', 2000); // R1 — out of band, corrected to 1.6
    ringTurn(ws, session, 'Neutrals are 0.43.', 3000);
    ringTurn(ws, session, '0.78', 4000);

    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('1.6');
    const ask = ws.sent.at(-1);
    expect(ask).toMatchObject({ type: 'ask_user_started', reason: 'confirm_ring_continuity' });
    expect(ask.question).toBe('R1 1.6, Rn 0.43, R2 0.78. I corrected 16 to 1.6. All correct?');
  });

  test('an UNCORRECTED script renders the triple BYTE-IDENTICALLY to pre-Plan-D', () => {
    const ws = new FakeWS();
    const session = ringSession();
    ringTurn(ws, session, 'Ring continuity for circuit 13.', 1000);
    ringTurn(ws, session, '0.43', 2000);
    ringTurn(ws, session, 'Neutrals are 0.43.', 3000);
    ringTurn(ws, session, '0.78', 4000);
    expect(ws.sent.at(-1).question).toBe('R1 0.43, Rn 0.43, R2 0.78. All correct?');
  });
});

describe('dialogue Seam B — the correction ledger lifecycle', () => {
  const schema = { name: 'ring_continuity' };

  function scriptSession(circuits = { 13: {} }) {
    return {
      sessionId: 'sess_seamb',
      stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
      dialogueScriptState: { schemaName: 'ring_continuity', values: {}, last_turn_at: 0 },
    };
  }

  test('applyWrite returns the clamped value AND records the correction on the script state', () => {
    const session = scriptSession();
    const out = applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    expect(out).toEqual({
      value: '1.6',
      correction: { original: '16', corrected: '1.6', divisor: 10 },
    });
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('1.6');
    expect(session.dialogueScriptState.values.ring_r1_ohm).toBe('1.6');
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toEqual({
      original: '16',
      corrected: '1.6',
      divisor: 10,
    });
  });

  test('overwriting with an UNCORRECTED value RETIRES the stale correction', () => {
    // Otherwise the confirmation would keep claiming "I corrected 16 to 1.6"
    // about a value the inspector has since replaced by hand.
    const session = scriptSession();
    applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    applyWrite(session, schema, 13, 'ring_r1_ohm', '0.43', 2000);
    expect(session.dialogueScriptState.values.ring_r1_ohm).toBe('0.43');
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });

  test('the clause is spoken EXACTLY ONCE across a two-read-back sequence', () => {
    const session = scriptSession();
    applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    expect(consumeValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toEqual({
      original: '16',
      corrected: '1.6',
      divisor: 10,
    });
    // Consume is read-and-DELETE: a second read-back of the same slot must not
    // repeat the clause.
    expect(consumeValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });

  test('clearValueCorrection retires a slot without consuming it', () => {
    // Pinned deliberately: this helper has NO engine call site today. It is the
    // designated hook for a clear / script-cancel path, and an untested export
    // is one refactor away from being deleted as dead code.
    const session = scriptSession();
    applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    clearValueCorrection(session.dialogueScriptState, 'ring_r1_ohm');
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });

  test('a correction recorded under one script never leaks into the next', () => {
    const session = scriptSession();
    applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    // Script cancelled / finished → a fresh state object. The ledger is scoped
    // to the state, so nothing survives.
    session.dialogueScriptState = {
      schemaName: 'ring_continuity',
      values: {},
      last_turn_at: 3000,
    };
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });

  test('a write for a DIFFERENT script name touches neither values nor the ledger', () => {
    const session = scriptSession();
    session.dialogueScriptState.schemaName = 'insulation_resistance';
    applyWrite(session, schema, 13, 'ring_r1_ohm', '16', 1000);
    // The snapshot still gets the CLAMPED value — the clamp is unconditional —
    // but the script-scoped ledger belongs to a different script.
    expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('1.6');
    expect(session.dialogueScriptState.values.ring_r1_ohm).toBeUndefined();
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — dialogue Seam D: the start_dialogue_script backfill hand-off
//
// `start_dialogue_script` with `pending_writes` is a SONNET-initiated seed:
// enterScriptByName clamps it (Seam A) and records the provenance into the
// dialogue state store, whose only speech consumer is the script's own
// end-of-script confirmation — but the dispatcher ALSO backfills
// perTurnWrites so the value reaches `extracted_readings`, which puts it in
// front of the Stage-6 bundler too. That bundler line lands FIRST, so it is
// the one the inspector reacts to; it has to carry the clause.
// ═══════════════════════════════════════════════════════════════════════

describe('dialogue Seam D — start_dialogue_script seeds hand the clamp to the bundler', () => {
  function scriptSession() {
    const session = makeSession({ earthing: 'TN-C-S', circuits: { 4: {} } });
    session.activeWs = null;
    return session;
  }

  function seedCall(field, value) {
    return {
      tool_call_id: 'tu_sds1',
      name: 'start_dialogue_script',
      input: {
        schema: 'ring_continuity',
        circuit: 4,
        source_turn_id: 't1',
        reason: 'inspector dictated a ring reading',
        pending_writes: [{ field, value }],
      },
    };
  }

  async function seed(session, writes, field, value) {
    return dispatchStartDialogueScript(seedCall(field, value), {
      session,
      logger: mockLogger(),
      turnId: 'turn-1',
      round: 1,
      perTurnWrites: writes,
    });
  }

  test('DISCRIMINATING: a seeded 16 is stored 1.6 AND the bundler names the correction', async () => {
    const session = scriptSession();
    const writes = createPerTurnWrites();
    await seed(session, writes, 'ring_r1_ohm', '16');

    // The clamp itself already worked pre-fix (Seam A) — assert it so a
    // regression there is not mistaken for a transport regression.
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('1.6');

    // THIS is the discriminating half. Pre-fix the backfill built a fresh
    // entry object with no Symbol, so the bundler read back the bare
    // "Circuit 4, ring R1 1.6" — right number, no explanation, and the
    // inspector who said "sixteen" was never told the server had divided it.
    const entry = writes.readings.get(encodeReadingKey('ring_r1_ohm', 4, undefined));
    expect(entry[IMPEDANCE_CLAMP_CORRECTION]).toEqual({
      original: '16',
      corrected: '1.6',
      divisor: 10,
    });
    expect(texts(bundle(writes)).join(' | ')).toContain('I corrected 16 to 1.6');
  });

  test('the hand-off CONSUMES, so the clause is named exactly once (Audio-First #1)', async () => {
    const session = scriptSession();
    await seed(session, createPerTurnWrites(), 'ring_r1_ohm', '16');
    // The bundler owns this clause now; leaving the ledger entry would make
    // the end-of-script confirmation say "I corrected 16 to 1.6" a SECOND
    // time on a later turn.
    expect(peekValueCorrection(session.dialogueScriptState, 'ring_r1_ohm')).toBeNull();
  });

  test('an UNCORRECTED seed carries no Symbol and reads back byte-identically', async () => {
    const session = scriptSession();
    const writes = createPerTurnWrites();
    await seed(session, writes, 'ring_r1_ohm', '0.43');

    const entry = writes.readings.get(encodeReadingKey('ring_r1_ohm', 4, undefined));
    expect(entry[IMPEDANCE_CLAMP_CORRECTION]).toBeUndefined();
    expect(texts(bundle(writes)).join(' | ')).not.toContain('I corrected');
  });

  test('the correction is non-enumerable — it cannot reach a wire frame', async () => {
    const session = scriptSession();
    const writes = createPerTurnWrites();
    await seed(session, writes, 'ring_r1_ohm', '16');

    const entry = writes.readings.get(encodeReadingKey('ring_r1_ohm', 4, undefined));
    expect(Object.keys(entry)).not.toContain('correction');
    expect(JSON.stringify(entry)).not.toContain('16');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 — dialogue Seam C: the post-completion correction breadcrumb
// ═══════════════════════════════════════════════════════════════════════

describe('dialogue Seam C — post-completion correction breadcrumb', () => {
  class FakeWS {
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
   * A synthetic schema whose breadcrumb field IS in a clamp band.
   *
   * COVERAGE NOTE (verified 2026-07-25): the only schema declaring a
   * `correctionBreadcrumb` today is insulation-resistance, whose fields are the
   * two megaohm IR legs — neither is in an impedance band, so on the LIVE path
   * this clamp is currently a pass-through. The breadcrumb config is
   * schema-driven, so the moment any continuity-field schema gains one this
   * producer would otherwise start storing raw values while the server
   * advertises `server_impedance_clamp` and the client has stopped clamping.
   * This synthetic schema is what pins that half of the seam.
   */
  const syntheticSchema = {
    name: 'synthetic_continuity',
    triggers: [],
    slots: [],
    extractionSource: 'synthetic_script',
    toolCallIdPrefix: 'syn',
    logEventPrefix: 'synthetic',
    correctionBreadcrumb: {
      windowMs: 15_000,
      fields: ['r1_r2_ohm'],
      fieldLabels: { r1_r2_ohm: 'R1 plus R2' },
      correctionRe: /^\s*no\b[,.]?\s+(.+?)[.!?]*\s*$/i,
      valueOnlyRe: /^[\d.]+$/,
      valueParser: (s) => s.trim(),
    },
  };

  function breadcrumbSession(field, { earthing = 'TN-C-S' } = {}) {
    return {
      sessionId: 'sess_seamc',
      stateSnapshot: {
        circuits: { 0: { earthing_arrangement: earthing }, 5: {} },
        currentBoardId: null,
      },
      dialogueCorrectionBreadcrumb: {
        schemaName: syntheticSchema.name,
        field,
        circuit_ref: 5,
        boardId: null,
        at: 1000,
      },
    };
  }

  test('a continuity-field breadcrumb CLAMPS and names the correction aloud', () => {
    const ws = new FakeWS();
    const session = breadcrumbSession('r1_r2_ohm');
    const logger = mockLogger();
    processDialogueTurn({
      ws,
      session,
      sessionId: session.sessionId,
      transcriptText: 'No, 16',
      rawReplyText: 'No, 16',
      schemas: [syntheticSchema],
      logger,
      now: 2000,
    });

    expect(session.stateSnapshot.circuits[5].r1_r2_ohm).toBe('1.6');
    const spoken = ws.sent.filter(
      (f) => typeof f.question === 'string' || typeof f.text === 'string'
    );
    const line = JSON.stringify(spoken);
    expect(line).toContain('Got it, R1 plus R2 1.6. I corrected 16 to 1.6.');
    // The extraction frame carries the STORED value, never the dictated one.
    const extraction = ws.sent.find((f) => f.type === 'extraction');
    expect(JSON.stringify(extraction)).toContain('1.6');
    expect(JSON.stringify(extraction)).not.toContain('"16"');
    // And the shared clamp row fires so every server-altered number is
    // greppable under ONE event name regardless of which seam altered it.
    const rows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.impedance_clamp_applied');
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({ seam: 'dialogue_correction_breadcrumb', corrected: '1.6' });
  });

  test('an IN-BAND breadcrumb renders BYTE-IDENTICALLY to pre-Plan-D (no extra sentence)', () => {
    const ws = new FakeWS();
    const session = breadcrumbSession('r1_r2_ohm');
    const logger = mockLogger();
    processDialogueTurn({
      ws,
      session,
      sessionId: session.sessionId,
      transcriptText: 'No, 0.47',
      rawReplyText: 'No, 0.47',
      schemas: [syntheticSchema],
      logger,
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].r1_r2_ohm).toBe('0.47');
    const line = JSON.stringify(ws.sent);
    expect(line).toContain('Got it, R1 plus R2 0.47.');
    expect(line).not.toContain('I corrected');
    expect(logger.info.mock.calls.filter((c) => c[0] === 'stage6.impedance_clamp_applied')).toEqual(
      []
    );
  });

  test('an IR megaohm breadcrumb passes through BYTE-UNCHANGED (not in any band)', () => {
    // The live half of the seam: 100 MΩ is not an impedance-band value and must
    // never be divided by a clamp aimed at ohms.
    const ws = new FakeWS();
    const irSchema = {
      ...syntheticSchema,
      name: 'synthetic_ir',
      correctionBreadcrumb: {
        ...syntheticSchema.correctionBreadcrumb,
        fields: ['ir_live_earth_mohm'],
        fieldLabels: { ir_live_earth_mohm: 'live-to-earth' },
      },
    };
    const session = breadcrumbSession('ir_live_earth_mohm');
    session.dialogueCorrectionBreadcrumb.schemaName = irSchema.name;
    processDialogueTurn({
      ws,
      session,
      sessionId: session.sessionId,
      transcriptText: 'No, 100',
      rawReplyText: 'No, 100',
      schemas: [irSchema],
      logger: null,
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ir_live_earth_mohm).toBe('100');
    expect(JSON.stringify(ws.sent)).not.toContain('I corrected');
  });
});

// ─────────────────────────── same-round dispatch ordering (Codex lens 3) ──
//
// The clamp resolves the Ze band from the COMMITTED `session.stateSnapshot`,
// and runToolLoop dispatches a round's records SEQUENTIALLY. A single utterance
// can carry both facts, and the model emits them in UTTERANCE order — so
// "Ze is 16 on a TN-C-S system" arrives Ze-FIRST. Without the earthing-first
// partition in `createSortRecordsAsksLast` that Ze write sees an UNKNOWN
// arrangement and declines to divide (the fail-safe), while the same utterance
// phrased the other way round WOULD clamp: a silent order-dependence on a
// safety-critical path. These tests pin the partition and its consequence.
describe('Plan D — same-round earthing_arrangement dispatches before the impedance write', () => {
  test('createSortRecordsAsksLast hoists earthing_arrangement, keeps asks last, stable within partitions', () => {
    const sort = createSortRecordsAsksLast();
    const records = [
      { id: 'ze', name: 'record_board_reading', input: { field: 'earth_loop_impedance_ze' } },
      { id: 'ask', name: 'ask_user', input: { question: 'q' } },
      { id: 'earth', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
      { id: 'zs', name: 'record_reading', input: { field: 'measured_zs_ohm' } },
      { id: 'earth2', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
    ];
    expect(sort(records).map((r) => r.id)).toEqual(['earth', 'earth2', 'ze', 'zs', 'ask']);
    // Pure — the input array is untouched.
    expect(records.map((r) => r.id)).toEqual(['ze', 'ask', 'earth', 'zs', 'earth2']);
  });

  test('the predicate is narrow: only record_board_reading + earthing_arrangement is hoisted', () => {
    expect(
      isEarthingArrangementRecord({
        name: 'record_board_reading',
        input: { field: 'earthing_arrangement' },
      })
    ).toBe(true);
    // A same-named field on a DIFFERENT tool is not a board fact write.
    expect(
      isEarthingArrangementRecord({
        name: 'record_reading',
        input: { field: 'earthing_arrangement' },
      })
    ).toBe(false);
    // Another board fact is NOT hoisted — the narrow rule is the proven one.
    expect(
      isEarthingArrangementRecord({
        name: 'record_board_reading',
        input: { field: 'manufacturer' },
      })
    ).toBe(false);
    // Malformed shapes must never throw.
    for (const bad of [
      null,
      undefined,
      {},
      { name: 'record_board_reading' },
      { name: 'record_board_reading', input: null },
      { name: 'record_board_reading', input: 'earthing_arrangement' },
      { name: 'record_board_reading', input: { field: 42 } },
    ]) {
      expect(isEarthingArrangementRecord(bad)).toBe(false);
    }
  });

  test('identity/degenerate inputs short-circuit unchanged', () => {
    const sort = createSortRecordsAsksLast();
    const one = [
      { id: 'a', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
    ];
    expect(sort(one)).toBe(one);
    expect(sort([])).toEqual([]);
    expect(sort(null)).toBe(null);
  });

  test('DISCRIMINATING: "Ze is 16 on a TN-C-S system" (Ze emitted FIRST) still stores 1.6', async () => {
    // NOTHING is seeded — no job_state supply, no prior turn. The arrangement
    // arrives in this very round, AFTER the Ze in emission order.
    const session = makeSession({ earthing: null });
    const writes = createPerTurnWrites();
    const records = [
      {
        id: 'tu_ze',
        name: 'record_board_reading',
        input: { field: 'earth_loop_impedance_ze', value: '16' },
      },
      {
        id: 'tu_earth',
        name: 'record_board_reading',
        input: { field: 'earthing_arrangement', value: 'TN-C-S' },
      },
    ];

    // Dispatch in the hook's order, exactly as runToolLoop does.
    for (const rec of createSortRecordsAsksLast()(records)) {
      const env = await dispatchBoardReading(session, writes, rec.input, rec.id);
      expect(env.is_error).toBe(false);
    }

    // The clamped LITERAL — not a cross-equality, which would already hold on
    // unfixed source (both sides would read '16').
    expect(session.stateSnapshot.circuits[0].earthing_arrangement).toBe('TN-C-S');
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('1.6');

    // ...and the SPOKEN line names the correction, so a wrong clamp is
    // catchable by ear.
    const result = bundle(writes);
    expect(texts(result)).toContain('Ze recorded as 1.6 — I corrected 16 to 1.6');
  });

  // CONTROL, not a proof of the fix: the arrangement is ALREADY ahead of the Ze
  // in emission order, so this passes on unfixed source too. It is here to pin
  // that the hoist did not BREAK the phrasing that always worked.
  test('CONTROL — the reverse utterance order reaches the same stored value', async () => {
    const session = makeSession({ earthing: null });
    const writes = createPerTurnWrites();
    const records = [
      {
        id: 'tu_earth',
        name: 'record_board_reading',
        input: { field: 'earthing_arrangement', value: 'TN-C-S' },
      },
      {
        id: 'tu_ze',
        name: 'record_board_reading',
        input: { field: 'earth_loop_impedance_ze', value: '16' },
      },
    ];
    for (const rec of createSortRecordsAsksLast()(records)) {
      await dispatchBoardReading(session, writes, rec.input, rec.id);
    }
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('1.6');
  });

  test('DISCRIMINATING: a same-round TT emitted after the Ze OVERRIDES a stale TN-C-S and leaves 16 alone', async () => {
    // The safety direction that matters: 16 Ω is an ordinary TT rod-earth
    // reading. Hoisting the arrangement must make the band CORRECT, not just
    // make the clamp fire.
    //
    // The session is seeded TN-C-S so this test can FAIL: without the hoist the
    // Ze dispatches first, resolves the STALE TN-C-S band [0.01, 5], and divides
    // a perfectly good rod-earth reading to 1.6 — corrupting a correct value,
    // the exact harm this plan exists to prevent. Seeding nothing would make the
    // assertion true on unfixed source (unknown arrangement also declines to
    // divide) and prove nothing.
    const session = makeSession({ earthing: 'TN-C-S' });
    const writes = createPerTurnWrites();
    const records = [
      {
        id: 'tu_ze',
        name: 'record_board_reading',
        input: { field: 'earth_loop_impedance_ze', value: '16' },
      },
      {
        id: 'tu_earth',
        name: 'record_board_reading',
        input: { field: 'earthing_arrangement', value: 'TT' },
      },
    ];
    for (const rec of createSortRecordsAsksLast()(records)) {
      await dispatchBoardReading(session, writes, rec.input, rec.id);
    }
    expect(session.stateSnapshot.circuits[0].earthing_arrangement).toBe('TT');
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('16');
    expect(JSON.stringify(texts(bundle(writes)))).not.toContain('I corrected');
  });

  // --- board-context segments (Codex mini-review, 2026-07-25) -----------------
  // `record_board_reading` has no board_id: the dispatcher resolves its target as
  // snapshot.currentBoardId, which add_board/select_board mutate mid-round. The
  // hoist must therefore never cross one, or "add the garage board, earthing is
  // TT, Ze is 16" would stamp TT on the ORIGIN supply instead of the new board.

  test('DISCRIMINATING: an earthing write is NOT hoisted across add_board', () => {
    const sort = createSortRecordsAsksLast();
    const records = [
      { id: 'add', name: 'add_board', input: { designation: 'Garage' } },
      { id: 'earth', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
      { id: 'ze', name: 'record_board_reading', input: { field: 'earth_loop_impedance_ze' } },
    ];
    // Pre-fix this returned ['earth','add','ze'] — the arrangement committed
    // against the OLD currentBoardId.
    expect(sort(records).map((r) => r.id)).toEqual(['add', 'earth', 'ze']);
  });

  test('select_board is also a boundary, and each segment hoists independently', () => {
    const sort = createSortRecordsAsksLast();
    const records = [
      { id: 'ze1', name: 'record_board_reading', input: { field: 'earth_loop_impedance_ze' } },
      { id: 'earth1', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
      { id: 'sel', name: 'select_board', input: { board_id: 'sub-1' } },
      { id: 'ze2', name: 'record_board_reading', input: { field: 'ze_at_db' } },
      { id: 'ask', name: 'ask_user', input: { question: 'q' } },
      { id: 'earth2', name: 'record_board_reading', input: { field: 'earthing_arrangement' } },
    ];
    // Segment 1 hoists earth1 above ze1; the boundary stays put; segment 2
    // hoists earth2 above ze2; the ask still goes to the ROUND tail (it writes
    // nothing, so it has no board context to lose).
    expect(sort(records).map((r) => r.id)).toEqual([
      'earth1',
      'ze1',
      'sel',
      'earth2',
      'ze2',
      'ask',
    ]);
  });

  test('isBoardContextChangingRecord is narrow and total', () => {
    expect(isBoardContextChangingRecord({ name: 'add_board' })).toBe(true);
    expect(isBoardContextChangingRecord({ name: 'select_board' })).toBe(true);
    expect(isBoardContextChangingRecord({ name: 'record_board_reading' })).toBe(false);
    for (const bad of [null, undefined, {}, { name: 42 }, 'add_board']) {
      expect(isBoardContextChangingRecord(bad)).toBe(false);
    }
  });
});
