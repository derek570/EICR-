/**
 * A2 (2026-07-28) — `replaces_cleared`, the PRODUCER half.
 *
 * The defect: P5 (2026-07-23) collapses a same-turn `clear_reading` +
 * `record_reading` for ONE circuit slot server-side, so the wire carries a BARE
 * write against a cell the client still believes is populated. Web's
 * `applyCircuitReadings` gate is fill-only and source-agnostic (`hasValue(cell)
 * → skip`), so it silently DROPPED that write: the assistant spoke the
 * replacement, the backend and iOS stored it, and web kept the STALE value.
 * That is the inverse Audio-First violation — spoken but not written.
 *
 * The marker closes it by telling the consumer "the server already cleared this
 * cell", which is exactly the information the collapse destroyed. It is
 * OMIT-WHEN-FALSE: an ordinary write carries no such key, so every pre-A2 wire
 * snapshot and every client that has never heard of the field is byte-identical.
 *
 * This file pins the producer end across the SAME matrix P5's own collapse
 * matrix covers (`stage6-p5-clear-write-collapse.test.js`) — the stamp must
 * follow the collapse everywhere the collapse fires, and nowhere else — plus:
 *   - two same-turn spellings of ONE effective slot resolving to exactly one
 *     flagged winner (A2-multiboard, 2026-07-28 — A2-core's fail-closed-UNFLAGGED
 *     guard is REMOVED because the journal projection makes the case unreachable);
 *   - derived/mirror writes being excluded from candidacy;
 *   - the WIRE contract, driven through the real egress chain and deep-equalled
 *     against the shared cross-client fixture web's decoder test imports.
 *
 * The two smoke legs through `runShadowHarness` live in
 * `stage6-tool-loop-e2e.test.js`; everything scope-sensitive is here.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dispatchRecordReading,
  dispatchClearReading,
  dispatchCalculateZs,
  dispatchSetFieldForAllCircuits,
} from '../extraction/stage6-dispatchers-circuit.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';
import {
  bundleToolCallsIntoResult,
  SAME_TURN_CLEAR_WRITE_COLLAPSED,
} from '../extraction/stage6-event-bundler.js';
import {
  createPerTurnWrites,
  encodeReadingKey,
  attachEffectiveSlot,
} from '../extraction/stage6-per-turn-writes.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { mockClient } from './helpers/mockStream.js';

// `sonnet-stream.js` pulls `../storage.js`, whose module-level
// `path.resolve(import.meta.dirname, …)` is `undefined` under Jest's ESM VM, so
// storage is mocked and sonnet-stream dynamically imported below. Nothing here
// exercises storage — the seam under test is a pure projection.
jest.unstable_mockModule('../storage.js', () => ({
  getJobPrefix: jest.fn(() => ''),
  uploadFile: jest.fn(async () => {}),
  uploadBytes: jest.fn(async () => {}),
  uploadText: jest.fn(async () => {}),
  uploadJson: jest.fn(async () => {}),
  downloadFile: jest.fn(async () => {}),
  downloadBytes: jest.fn(async () => null),
  downloadText: jest.fn(async () => null),
  downloadJson: jest.fn(async () => null),
  fileExists: jest.fn(async () => false),
  deleteFile: jest.fn(async () => {}),
  copyObject: jest.fn(async () => {}),
  deletePrefix: jest.fn(async () => {}),
  listFiles: jest.fn(async () => []),
  listDirectories: jest.fn(async () => []),
  listJobFolders: jest.fn(async () => []),
  getFileUrl: jest.fn(async () => ''),
  getJobFiles: jest.fn(async () => []),
  uploadJobFile: jest.fn(async () => {}),
  downloadJobFile: jest.fn(async () => null),
  isUsingS3: jest.fn(() => false),
  getBucketName: jest.fn(() => 'test-bucket'),
}));

const {
  projectExtractionResultForWire,
  _test_validateAndCorrectFields,
  _test_buildResultFrameLedger,
} = await import('../extraction/sonnet-stream.js');

const WIRE_CONTRACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/test-contracts/replaces-cleared-circuit.json'
);
const wireContract = JSON.parse(readFileSync(WIRE_CONTRACT_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Harness — deliberately identical in shape to stage6-p5-clear-write-collapse
// so the two matrices stay readable side by side.
// ---------------------------------------------------------------------------

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(circuits = {}, extra = {}) {
  return {
    sessionId: 'a2-test',
    stateSnapshot: {
      circuits,
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      ...extra,
    },
  };
}

function ctx(session, perTurnWrites, callId = 'tc1') {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0, callId };
}

function recordCall(input, tool_call_id = 'w1') {
  return { tool_call_id, name: 'record_reading', input };
}
function clearCall(input, tool_call_id = 'c1') {
  return { tool_call_id, name: 'clear_reading', input };
}

function bundle(perTurnWrites) {
  return bundleToolCallsIntoResult(perTurnWrites, null, {
    confirmationsEnabled: true,
    turnId: 't1',
  });
}

/** The reading the wire would carry for a given field+circuit (+board). */
const readingFor = (r, field, circuit, boardId) =>
  r.extracted_readings.find(
    (x) =>
      x.field === field &&
      x.circuit === circuit &&
      (boardId === undefined || x.board_id === boardId)
  );

/** Every reading in the projection that carries the marker. */
const flagged = (r) => r.extracted_readings.filter((x) => x.replaces_cleared === true);

// ---------------------------------------------------------------------------
// 1. Every readings.set producer that can survive a collapse gets the marker.
//    (Mirrors P5 §6 — if a producer collapses a clear, it must also explain
//    itself to the client, or web silently drops exactly that producer's write.)
// ---------------------------------------------------------------------------

describe('A2 — the marker follows the collapse across every producer', () => {
  test('record_reading: clear→write flags the surviving write', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'user_correction' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    const r = bundle(p);

    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
    expect(readingFor(r, 'ir_live_live_mohm', 3).replaces_cleared).toBe(true);
    expect(flagged(r)).toHaveLength(1);
  });

  test('repeated clear→write→clear→write: only the FINAL surviving write is flagged, once', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }, 'c1'),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        {
          field: 'ir_live_live_mohm',
          circuit: 3,
          value: '90',
          confidence: 0.9,
          source_turn_id: 't1',
        },
        'w1'
      ),
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }, 'c2'),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        {
          field: 'ir_live_live_mohm',
          circuit: 3,
          value: '100',
          confidence: 0.9,
          source_turn_id: 't1',
        },
        'w2'
      ),
      ctx(session, p)
    );
    const r = bundle(p);

    // Same Map key ⇒ ONE surviving reading, so this is NOT the ambiguous case.
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].value).toBe('100');
    expect(r.extracted_readings[0].replaces_cleared).toBe(true);
  });

  test('set_field_for_all_circuits: only the collapsed circuit is flagged', async () => {
    const session = makeSession({
      0: {},
      1: { circuit_designation: 'Ckt 1', rcd_type: 'AC' },
      2: { circuit_designation: 'Ckt 2', rcd_type: 'AC' },
    });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'rcd_type', circuit: 1, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'sf1',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_type',
          value: 'A',
          scope: 'non_spare',
          source_turn_id: 't1',
          confidence: 1,
        },
      },
      ctx(session, p)
    );
    const r = bundle(p);

    expect(readingFor(r, 'rcd_type', 1).replaces_cleared).toBe(true);
    // Circuit 2 got the same bulk value with no clear behind it — an ordinary
    // write, so it must stay bare (fill-only gating is still correct there).
    expect('replaces_cleared' in readingFor(r, 'rcd_type', 2)).toBe(false);
    expect(flagged(r)).toHaveLength(1);
  });

  test('auto-resolve (::auto:: tool_call_id): the resolved write is flagged', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
        'tc::auto::resolve'
      ),
      ctx(session, p)
    );
    const r = bundle(p);

    const w = readingFor(r, 'measured_zs_ohm', 3);
    expect(w.auto_resolved).toBe(true);
    expect(w.replaces_cleared).toBe(true);
  });

  test('calculate_zs: the COMPUTED write is flagged (a calc result is spoken and authoritative since F/U-1)', async () => {
    const session = makeSession({
      0: { earth_loop_impedance_ze: '0.35' },
      4: { measured_zs_ohm: '1.10', r1_r2_ohm: '0.86' },
    });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 4, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchCalculateZs(
      { tool_call_id: 'cz1', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      ctx(session, p)
    );
    const r = bundle(p);

    const w = readingFor(r, 'measured_zs_ohm', 4);
    expect(w.value).toBe('1.21');
    // A calculator result is an explicitly-requested, spoken value (F/U-1,
    // 2026-07-19), so it has exactly the same spoken-but-not-written exposure
    // on web as a dictated one — it MUST carry the marker.
    expect(w.replaces_cleared).toBe(true);
  });

  test('start_dialogue_script: the script-seeded write is flagged', async () => {
    const session = makeSession({ 4: { ring_r1_ohm: '0.83', circuit_designation: 'Ring' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ring_r1_ohm', circuit: 4, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchStartDialogueScript(
      {
        tool_call_id: 'sd1',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: 4,
          pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
          source_turn_id: 't1',
          reason: 'garble',
        },
      },
      { ...ctx(session, p), ws: { send() {}, readyState: 1 } }
    );
    const r = bundle(p);

    const w = readingFor(r, 'ring_r1_ohm', 4);
    expect(w.value).toBe('0.32');
    expect(w.replaces_cleared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Board-scope spellings — the marker uses the SAME effective identity the
//    collapse matched on, so a mixed-spelling collapse must still flag.
// ---------------------------------------------------------------------------

describe('A2 — effective board identity (mixed spellings)', () => {
  test('clear(omitted board)→write(explicit current board) flags the write', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
        board_id: 'main',
      }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(flagged(r)).toHaveLength(1);
    expect(readingFor(r, 'ir_live_live_mohm', 3).replaces_cleared).toBe(true);
  });

  test('clear(explicit current board)→write(omitted board) flags the write', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'x', board_id: 'main' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(flagged(r)).toHaveLength(1);
    expect(readingFor(r, 'ir_live_live_mohm', 3).replaces_cleared).toBe(true);
  });

  test("'*' broadcast: ONLY board A's generated write is flagged, never board B's", async () => {
    const session = makeSession(
      {
        0: {},
        1: { circuit_designation: 'Main Ckt 1', rcd_type: 'AC' },
        'sub-1::1': {
          board_id: 'sub-1',
          circuit: 1,
          circuit_designation: 'Sub Ckt 1',
          rcd_type: 'AC',
        },
      },
      {
        boards: [
          { id: 'main', board_type: 'main', designation: 'DB-1' },
          { id: 'sub-1', board_type: 'sub', designation: 'DB-2' },
        ],
      }
    );
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'rcd_type', circuit: 1, reason: 'x', board_id: 'main' }),
      ctx(session, p)
    );
    await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'sf2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_type',
          value: 'A',
          scope: 'non_spare',
          source_turn_id: 't1',
          confidence: 1,
          board_id: '*',
        },
      },
      ctx(session, p)
    );
    const r = bundle(p);

    expect(readingFor(r, 'rcd_type', 1, 'main').replaces_cleared).toBe(true);
    expect('replaces_cleared' in readingFor(r, 'rcd_type', 1, 'sub-1')).toBe(false);
    expect(flagged(r)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Negative space — the marker must be ABSENT everywhere the collapse
//    doesn't fire. A spurious marker is a licence to overwrite a value the
//    server never cleared, which is a data-loss bug in the other direction.
// ---------------------------------------------------------------------------

describe('A2 — the marker is absent whenever nothing was collapsed', () => {
  test('an ordinary write carries no key at all (omit-when-false)', async () => {
    const session = makeSession({ 3: {} });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect('replaces_cleared' in r.extracted_readings[0]).toBe(false);
    expect(JSON.stringify(r.extracted_readings[0])).not.toContain('replaces_cleared');
  });

  test('write→clear (clear survives) flags nothing — there IS no surviving write', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM' } });
    const p = createPerTurnWrites();
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    await dispatchClearReading(
      clearCall({ field: 'ir_live_live_mohm', circuit: 3, reason: 'user_correction' }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(r.extracted_readings).toHaveLength(0);
    expect(r.field_corrections).toHaveLength(1);
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toBeUndefined();
  });

  test('cross-field: a clear on field A never flags a write on field B', async () => {
    const session = makeSession({ 3: { ir_live_live_mohm: 'LIM', ir_live_earth_mohm: '50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'ir_live_earth_mohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({
        field: 'ir_live_live_mohm',
        circuit: 3,
        value: '100',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(flagged(r)).toHaveLength(0);
  });

  test('different circuit: a clear on c3 never flags a write on c4', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.0' }, 4: {} });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall({
        field: 'measured_zs_ohm',
        circuit: 4,
        value: '0.42',
        confidence: 0.9,
        source_turn_id: 't1',
      }),
      ctx(session, p)
    );
    const r = bundle(p);
    expect(flagged(r)).toHaveLength(0);
  });

  test('different board: a clear on board A never flags board B (same field+circuit)', () => {
    // Hand-built to isolate the identity: the clear and the write differ ONLY
    // in effective board, so a marker here would prove the lookup ignores scope.
    const p = createPerTurnWrites();
    p.readings.set(
      encodeReadingKey('measured_zs_ohm', 1, 'sub-1'),
      attachEffectiveSlot(
        { value: '0.42', confidence: 1, source_turn_id: 't1', boardId: 'sub-1' },
        'measured_zs_ohm',
        1,
        'sub-1'
      )
    );
    p.fieldCorrections.push(
      attachEffectiveSlot(
        {
          type: 'field_corrected',
          circuit: 1,
          field: 'measured_zs_ohm',
          previous_value: '1.0',
          reason: 'clear_reading',
          board_id: 'main',
        },
        'measured_zs_ohm',
        1,
        'main'
      )
    );
    const r = bundle(p);
    expect(r.field_corrections).toHaveLength(1); // no collapse…
    expect(flagged(r)).toHaveLength(0); // …so no marker
  });
});

// ---------------------------------------------------------------------------
// 4. Derived/mirror writes are NOT candidates.
//    A mirror is a computed consequence, designed-silent by Audio-First #1's
//    stated exception. It is never the audible replacement a clear was
//    superseded by, so it must neither be stamped nor make a slot ambiguous.
// ---------------------------------------------------------------------------

describe('A2 — derived/mirror writes are excluded from candidacy', () => {
  const derivedEntry = (boardId) =>
    attachEffectiveSlot(
      { value: '0.42', confidence: 1, source_turn_id: 't1', boardId, derived: true },
      'measured_zs_ohm',
      1,
      boardId
    );
  const clearOnSlot = (boardId) =>
    attachEffectiveSlot(
      {
        type: 'field_corrected',
        circuit: 1,
        field: 'measured_zs_ohm',
        previous_value: '1.0',
        reason: 'clear_reading',
        board_id: boardId,
      },
      'measured_zs_ohm',
      1,
      boardId
    );

  test('a collapse whose ONLY surviving write is derived stamps nothing and is not ambiguous', () => {
    const p = createPerTurnWrites();
    p.readings.set(encodeReadingKey('measured_zs_ohm', 1, 'main'), derivedEntry('main'));
    p.fieldCorrections.push(clearOnSlot('main'));
    const r = bundle(p);

    // The collapse still fires (that is P5's contract, unchanged)…
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
    // …but a silent mirror is not a spoken replacement, so nothing is marked.
    expect(flagged(r)).toHaveLength(0);
  });

  test('a derived twin alongside ONE real write still flags exactly the real write', () => {
    const p = createPerTurnWrites();
    // Two Map entries, one effective slot: one derived (excluded), one real.
    p.readings.set(encodeReadingKey('measured_zs_ohm', 1, 'main'), derivedEntry('main'));
    p.readings.set(
      encodeReadingKey('measured_zs_ohm', 1, null),
      attachEffectiveSlot(
        { value: '0.42', confidence: 1, source_turn_id: 't1', boardId: null },
        'measured_zs_ohm',
        1,
        'main'
      )
    );
    p.fieldCorrections.push(clearOnSlot('main'));
    const r = bundle(p);

    expect(flagged(r)).toHaveLength(1);
    expect(flagged(r)[0].value).toBe('0.42');
  });
});

// ---------------------------------------------------------------------------
// 5. Two same-turn SPELLINGS of one effective slot → ONE last-write-wins winner.
//
//    `encodeReadingKey` embeds the RAW board_id and `dispatchRecordReading`
//    passes `input.board_id` verbatim, so a same-turn omitted-board write and
//    an explicit-current-board write of the same slot are TWO Map entries with
//    ONE effective identity.
//
//    A2-core stamped NEITHER (fail-closed-UNFLAGGED) because it could not tell
//    which write the clear belonged to. A2-multiboard (2026-07-28) removes that
//    guard: the append-only sequenced write JOURNAL makes the ordering
//    decidable, so the projection is last-write-wins PER EFFECTIVE SLOT and the
//    two spellings collapse to exactly ONE surviving reading — which is then
//    unambiguously the replacement, and IS flagged. The inversion is the point:
//    the old behaviour left web holding the stale value (the very
//    spoken-but-not-written class A2 exists to close) on any turn where the
//    model spelled the board both ways.
// ---------------------------------------------------------------------------

describe('A2-multiboard — two same-turn spellings of one slot resolve to ONE flagged winner', () => {
  test('the LAST write wins and carries the marker; the shadowed spelling never reaches the wire', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    // Spelling 1 — board omitted.
    await dispatchRecordReading(
      recordCall(
        {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
        'w1'
      ),
      ctx(session, p)
    );
    // Spelling 2 — explicit CURRENT board. Same effective slot, different Map key.
    await dispatchRecordReading(
      recordCall(
        {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.44',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
        'w2'
      ),
      ctx(session, p)
    );
    const r = bundle(p);

    // The two spellings are ONE effective slot, so exactly one write survives —
    // the LAST one, per the journal's write sequence.
    const zs = r.extracted_readings.filter((x) => x.field === 'measured_zs_ohm');
    expect(zs).toHaveLength(1);
    expect(zs[0].value).toBe('0.44');
    // The collapse fired (P5 behaviour unchanged)…
    expect(r[SAME_TURN_CLEAR_WRITE_COLLAPSED]).toHaveLength(1);
    expect('field_corrections' in r).toBe(false);
    // …and the sole survivor IS the replacement, so it carries the marker.
    // (Pre-A2-multiboard this asserted ZERO flags — the inversion is deliberate:
    // declining left web holding the stale value.)
    expect(flagged(r)).toHaveLength(1);
    expect(flagged(r)[0].value).toBe('0.44');
  });

  test('no ambiguity manifest rides the wire — the removed guard leaves no residue', async () => {
    const session = makeSession({ 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();
    await dispatchClearReading(
      clearCall({ field: 'measured_zs_ohm', circuit: 3, reason: 'x' }),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
        'w1'
      ),
      ctx(session, p)
    );
    await dispatchRecordReading(
      recordCall(
        {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.44',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
        'w2'
      ),
      ctx(session, p)
    );
    const r = bundle(p);

    expect(Object.keys(r)).not.toContain('replaces_cleared_ambiguous_projection');
    expect(JSON.stringify(r)).not.toContain('ambiguous');
    // No Symbol-keyed manifest survives either — the export is gone, so nothing
    // can read one; this pins that no NEW symbol quietly replaced it.
    expect(
      Object.getOwnPropertySymbols(r).map((s) => s.toString()).join('|')
    ).not.toContain('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// 6. WIRE CONTRACT — the bytes web actually decodes.
//
//    Driven through the REAL egress chain production uses:
//      runShadowHarness(live)            the producer
//        → validateAndCorrectFields      canonical → legacy field-name rewrite
//          → projectExtractionResultForWire   the `{readings, ...rest}` shape
//            → JSON.stringify            the wire
//    and deep-equalled against the shared cross-client fixture. Web's decoder
//    test imports the SAME file, so the two halves of the contract cannot drift
//    apart silently: a producer-side change either updates both or fails here.
// ---------------------------------------------------------------------------

function toolUseRound(toolCalls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_tu', role: 'assistant', content: [] } },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

/** The exact turn the committed fixture was generated from. */
function wireContractSession() {
  const streams = [
    toolUseRound([
      {
        id: 'toolu_clear',
        name: 'clear_reading',
        input: { field: 'ir_live_live_mohm', circuit: 1, reason: 'user_correction' },
      },
      {
        id: 'toolu_replacement',
        name: 'record_reading',
        input: {
          field: 'ir_live_live_mohm',
          circuit: 1,
          value: '100',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {
        id: 'toolu_ordinary',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      // A clear with NO same-turn replacement — proves the collapse (and the
      // marker) is slot-scoped and that surviving clears still reach the wire.
      {
        id: 'toolu_surviving_clear',
        name: 'clear_reading',
        input: { field: 'r1_r2_ohm', circuit: 1, reason: 'user_correction' },
      },
      {
        id: 'toolu_create',
        name: 'create_circuit',
        input: { circuit_ref: 2, designation: 'Sockets' },
      },
    ]),
    endTurnRound('done'),
  ];
  return {
    sessionId: 'a2-wire',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient(streams),
    stateSnapshot: {
      circuits: { 1: { ir_live_live_mohm: 'LIM', r1_r2_ohm: '0.86' } },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt }];
    },
    extractFromUtterance: jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions: [],
    })),
  };
}

describe('A2 — wire contract (shared cross-client fixture)', () => {
  test('the production egress chain reproduces the committed frame byte-for-byte', async () => {
    const session = wireContractSession();
    const result = await runShadowHarness(session, 'insulation live live is one hundred', [], {
      logger: mockLogger(),
      confirmationsEnabled: true,
      utteranceId: 'utt-a2-wire',
    });
    _test_validateAndCorrectFields(result, 'a2-wire');

    // Built by the REAL frame builder production sends from, NOT by this test
    // re-assembling `{type:'extraction', result: project(...)}`. That distinction
    // is the whole point: a re-implementation here would stay green if
    // buildResultFrameLedger ever grew its own inline projection again, and the
    // fixture would then pin a shape production had stopped emitting.
    const frames = _test_buildResultFrameLedger(session.stateSnapshot, result);
    const extractionFrames = frames.filter((f) => f.kind === 'extraction');
    expect(extractionFrames).toHaveLength(1);

    // The ledger hands the socket a JSON STRING — parsing it is exactly what a
    // client decoder does, and it drops the non-enumerable telemetry Symbols the
    // in-memory result still carries.
    expect(JSON.parse(extractionFrames[0].json)).toEqual(wireContract);
  });

  test('the OTHER production egress site emits the same extraction frame as the ledger', async () => {
    // `session.onBatchResult` (sonnet-stream.js:2710) sends its extraction frame
    // WITHOUT going through the ledger. Both sites are only equivalent because
    // both call the shared projection; pin that equivalence at the frame level so
    // re-inlining a projection at either site is a failure here rather than a
    // client-visible divergence between the live and batch paths.
    const session = wireContractSession();
    const result = await runShadowHarness(session, 'insulation live live is one hundred', [], {
      logger: mockLogger(),
      confirmationsEnabled: true,
      utteranceId: 'utt-a2-wire',
    });
    _test_validateAndCorrectFields(result, 'a2-wire');

    const ledgerFrame = _test_buildResultFrameLedger(session.stateSnapshot, result).find(
      (f) => f.kind === 'extraction'
    ).json;
    // The literal `:2711` send expression.
    const batchFrame = JSON.stringify({
      type: 'extraction',
      result: projectExtractionResultForWire(result),
    });

    expect(JSON.parse(batchFrame)).toEqual(JSON.parse(ledgerFrame));
  });

  test('DRIFT LOCK — every extraction-frame egress site routes through the shared projection', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../extraction/sonnet-stream.js'),
      'utf8'
    );
    // Every place that builds a `type: 'extraction'` payload must take its
    // `result` from the seam. A re-inlined `...rest` spread at an egress site is
    // invisible to every behavioural test above (it would produce the same bytes
    // TODAY and drift the moment the seam changes), so it is caught structurally.
    const egressSites = src.match(/type: 'extraction',\s*result: ([A-Za-z_][\w]*)/g) ?? [];
    expect(egressSites.length).toBeGreaterThanOrEqual(2);
    for (const site of egressSites) {
      expect(site).toMatch(
        /result: (projectExtractionResultForWire|resultWithoutQuestions|result)\b/
      );
    }
    // And the ONE variable spelling that is not literally the seam call is
    // assigned from it on the immediately preceding line.
    expect(src).toMatch(
      /const resultWithoutQuestions = projectExtractionResultForWire\(result\);\s*\n\s*currentWs\.send\(\s*JSON\.stringify\(\{ type: 'extraction', result: resultWithoutQuestions \}\)\s*\);/
    );
  });

  test('the fixture itself encodes the contract: flagged replacement, bare ordinary write, surviving clear', () => {
    const readings = wireContract.result.readings;
    // The replacement carries the marker, under its LEGACY wire field name.
    const replacement = readings.find((r) => r.field === 'insulation_resistance_l_l');
    expect(replacement.replaces_cleared).toBe(true);
    // A2-multiboard (2026-07-28) — DELIBERATE contract change, asserted rather
    // than deleted. A flagged replacement is ALWAYS enriched with the
    // dispatcher-resolved effective board, even on this single-board turn: the
    // collapse manifest keys on the EFFECTIVE board, so an unenriched flagged
    // reading is unresolvable by the client's board-aware fail-closed targeting
    // and the spoken replacement would be dropped all over again. This turn's
    // job declares no boards, so the value is the SYNTHESISED canonical main
    // identity — the same string web seeds when it has no board evidence of its
    // own (`BACKEND_DEFAULT_MAIN_BOARD_ID`).
    expect(replacement.board_id).toBe('main');
    // The ordinary write in the SAME frame stays bare — omit-when-false is what
    // keeps a pre-A2 client byte-identical, and ordinary writes are enriched
    // ONLY on a genuinely cross-board turn (this one writes one board), so a
    // single-board frame grows no new key and the speculator's null-board cache
    // entries keep hitting.
    const ordinary = readings.find((r) => r.field === 'zs');
    expect('replaces_cleared' in ordinary).toBe(false);
    expect('board_id' in ordinary).toBe(false);
    // The collapsed clear is gone from the wire; the un-replaced one survives.
    const clearedFields = wireContract.result.field_corrections.map((c) => c.field);
    expect(clearedFields).toEqual(['r1_plus_r2']);
  });
});

// ---------------------------------------------------------------------------
// 7. The projection seam itself — spread-never-allowlist.
//
//    `projectExtractionResultForWire` drops the four server-internal keys and
//    renames `extracted_readings` → `readings`; EVERYTHING else passes through
//    by spread. That is deliberate: an allowlist would silently drop the next
//    result key someone adds (board_ops, validation_alerts, …) and the loss
//    would only surface as a missing client behaviour in the field.
// ---------------------------------------------------------------------------

describe('A2 — projectExtractionResultForWire', () => {
  test('renames extracted_readings, drops the server-internal keys, preserves everything else', () => {
    const projected = projectExtractionResultForWire({
      extracted_readings: [{ field: 'zs', circuit: 1, value: '0.42', replaces_cleared: true }],
      questions_for_user: [{ field: 'zs' }],
      spoken_response: 'Circuit 1, Zs 0.42',
      action: 'some_action',
      observationUpdates: [{ observation_id: 'o1' }],
      observations: [],
      questions: [],
      turn_id: 't1',
      utterance_id: 'u1',
      field_corrections: [{ field: 'r1_plus_r2' }],
      cleared_readings: [{ field: 'r1_plus_r2' }],
      circuit_updates: [{ op: 'create', circuit_ref: 2 }],
      board_ops: [{ op: 'add_board' }],
      validation_alerts: [{ type: 'x' }],
      confirmations: [{ text: 'hi' }],
    });

    expect(projected.readings[0].replaces_cleared).toBe(true);
    expect('extracted_readings' in projected).toBe(false);
    for (const dropped of [
      'questions_for_user',
      'spoken_response',
      'action',
      'observationUpdates',
    ]) {
      expect(dropped in projected).toBe(false);
    }
    for (const kept of [
      'observations',
      'questions',
      'turn_id',
      'utterance_id',
      'field_corrections',
      'cleared_readings',
      'circuit_updates',
      'board_ops',
      'validation_alerts',
      'confirmations',
    ]) {
      expect(kept in projected).toBe(true);
    }
  });

  test('an unknown future key passes through untouched (spread, not allowlist)', () => {
    const projected = projectExtractionResultForWire({
      extracted_readings: [],
      some_future_frame_key: { nested: true },
    });
    expect(projected.some_future_frame_key).toEqual({ nested: true });
  });
});

// ---------------------------------------------------------------------------
// The two-spelling case, driven END-TO-END through the REAL harness.
//
// A2-core routed this case to a fail-closed skip whose ONLY observability was
// `stage6.replaces_cleared_ambiguous_projection`. A2-multiboard resolves it
// instead (journal last-write-wins per effective slot), so the telemetry has
// no subject left and BOTH the emitter and its manifest Symbol are removed.
// These tests pin the replacement behaviour on the real live lane AND assert
// the dead emitter cannot creep back in.
// ---------------------------------------------------------------------------

/** A turn whose clear has TWO same-slot replacements differing only in board
 *  spelling — one effective slot, so the journal picks the last writer. */
function ambiguousProjectionSession() {
  const streams = [
    toolUseRound([
      {
        id: 'toolu_clear_amb',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      {
        id: 'toolu_amb_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {
        id: 'toolu_amb_2',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.44',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
    ]),
    endTurnRound('done'),
  ];
  return {
    sessionId: 'a2-amb',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient(streams),
    stateSnapshot: {
      circuits: { 3: { measured_zs_ohm: '1.50' } },
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt }];
    },
    extractFromUtterance: jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions: [],
    })),
  };
}

describe('A2-multiboard — the two-spelling turn resolves on the real LIVE lane', () => {
  test('exactly ONE reading reaches the wire, flagged, and NO ambiguity row is logged', async () => {
    const logger = mockLogger();
    const session = ambiguousProjectionSession();
    const result = await runShadowHarness(
      session,
      'zs on circuit three is nought point four two',
      [],
      {
        logger,
        confirmationsEnabled: true,
        utteranceId: 'utt-a2-amb',
      }
    );

    const zs = (result.extracted_readings ?? []).filter((r) => r.field === 'measured_zs_ohm');
    expect(zs).toHaveLength(1);
    expect(zs[0].value).toBe('0.44');
    expect(zs[0].replaces_cleared).toBe(true);

    // The dead telemetry must never fire again — nothing emits it.
    expect(
      logger.info.mock.calls.filter(
        ([event]) => event === 'stage6.replaces_cleared_ambiguous_projection'
      )
    ).toHaveLength(0);
  });

  test('an ordinary collapsed turn is unchanged and emits NO ambiguity row', async () => {
    const logger = mockLogger();
    const result = await runShadowHarness(
      wireContractSession(),
      'insulation live live is one hundred',
      [],
      {
        logger,
        confirmationsEnabled: true,
        utteranceId: 'utt-a2-amb-neg',
      }
    );

    expect(result.extracted_readings.some((r) => r.replaces_cleared === true)).toBe(true);
    expect(
      logger.info.mock.calls.filter(
        ([event]) => event === 'stage6.replaces_cleared_ambiguous_projection'
      )
    ).toHaveLength(0);
  });

  test('DRIFT LOCK — the ambiguity emitter is GONE from both harness lanes', () => {
    // The inverse of A2-core's lock. The guard is unreachable by construction
    // now (journal LWW collapses the two spellings), so re-adding an emitter
    // would be re-adding a branch that can never fire — a silent lie in the
    // logs. Its P5 sibling must still be wired on BOTH lanes, unchanged.
    const src = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../extraction/stage6-shadow-harness.js'
      ),
      'utf8'
    );
    expect(src).not.toMatch(/emitReplacesClearedAmbiguousTelemetry\(/);
    const p5CallSites = src.match(
      /emitClearWriteCollapseTelemetry\(log, session, turnId, (result|toolResult)\);/g
    );
    expect(p5CallSites).toHaveLength(2);
    expect(new Set(p5CallSites).size).toBe(2); // one per lane, not one line twice
  });
});
