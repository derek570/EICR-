/**
 * Plan 00B §B2 — semantic mutation capture: commit receipts at the REAL
 * atoms, producer origin frames, derived-parent provenance, journal overlay
 * join and the INVALID/HOLD discipline. Includes the §B2 RED cases:
 * missing/wrong/unresolved parent, commit without origin, unmatched journal
 * overlay, and the address-mirror clone zero-commit exemption.
 */

import { describe, test, expect } from '@jest/globals';
import {
  attachMutationObserver,
  createMutationObserver,
  getMutationObserver,
  MUTATION_OBSERVER,
  SEMANTIC_ORIGINS,
} from '../extraction/plan00-semantic-capture.js';
import {
  applyReadingToSnapshot,
  applyReadingMultiBoard,
  clearReadingInSnapshot,
  upsertCircuitMeta,
  renameCircuit,
  deleteCircuit,
  applyBoardReadingToSnapshot,
  appendBoardToSnapshot,
  setCurrentBoardInSnapshot,
  markDistributionCircuitInSnapshot,
  appendObservation,
  deleteObservation,
} from '../extraction/stage6-snapshot-mutators.js';
import { applyPostcodeLookupToSnapshot } from '../extraction/postcode-snapshot-applier.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';

function makeSnapshot() {
  return { circuits: {}, boards: [{ id: 'main', board_type: 'main' }], currentBoardId: 'main' };
}

function observedSnapshot() {
  const snapshot = makeSnapshot();
  const observer = createMutationObserver({ sessionId: 's1' });
  attachMutationObserver(snapshot, observer);
  return { snapshot, observer };
}

const MODEL_FRAME = { origin: 'model_direct', meta: { tool: 'test' } };

describe('commit receipts at the real atoms', () => {
  test('attachment is non-enumerable and exactly-once', () => {
    const { snapshot, observer } = observedSnapshot();
    expect(getMutationObserver(snapshot)).toBe(observer);
    expect(Object.keys(snapshot)).not.toContain('observer');
    expect(JSON.stringify(snapshot)).not.toContain('mutationObserver');
    expect(() => attachMutationObserver(snapshot, observer)).toThrow(/already attached/);
  });

  test('a real reading write emits ONE receipt; a same-value rewrite emits none', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'measured_zs_ohm', value: '0.63' });
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'measured_zs_ohm', value: '0.63' });
    expect(observer.receipts).toHaveLength(1);
    const r = observer.receipts[0];
    expect(r).toMatchObject({
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 3,
      board_id: 'main',
      value: '0.63',
      origin: 'model_direct',
      seq: 1,
    });
    expect(Object.isFrozen(r)).toBe(true);
  });

  test('write→clear ordering is preserved in the receipt stream', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'ir_live_live_mohm', value: 'LIM' });
    clearReadingInSnapshot(snapshot, { circuit: 3, field: 'ir_live_live_mohm' });
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'ir_live_live_mohm', value: '100' });
    expect(observer.receipts.map((r) => [r.kind, r.seq])).toEqual([
      ['reading', 1],
      ['clear', 2],
      ['reading', 3],
    ]);
    expect(observer.receipts[1].previous_value).toBe('LIM');
  });

  test('no-op clears, idempotent renames and absent deletes emit nothing', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    clearReadingInSnapshot(snapshot, { circuit: 9, field: 'measured_zs_ohm' });
    renameCircuit(snapshot, { from_ref: 4, circuit_ref: 4 });
    deleteCircuit(snapshot, { circuit_ref: 12 });
    expect(observer.receipts).toHaveLength(0);
  });

  test('multi-board writes carry their resolved board identity', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyReadingMultiBoard(snapshot, {
      circuit: 2,
      field: 'measured_zs_ohm',
      value: '1.10',
      boardId: 'garage',
    });
    expect(observer.receipts[0]).toMatchObject({ board_id: 'garage', circuit: 2 });
  });

  test('board-op atoms: add/select/mark gate on real change', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    appendBoardToSnapshot(snapshot, { id: 'sub-1', designation: 'Garage', board_type: 'sub_main' });
    expect(snapshot.currentBoardId).toBe('sub-1');
    setCurrentBoardInSnapshot(snapshot, 'sub-1'); // same board — no receipt
    setCurrentBoardInSnapshot(snapshot, 'main');
    const bucket = { is_distribution_circuit: undefined, feeds_board_id: undefined };
    markDistributionCircuitInSnapshot(snapshot, bucket, {
      circuitRef: 2,
      sourceBoardId: 'main',
      feedsBoardId: 'sub-1',
    });
    // already marked — no second receipt
    markDistributionCircuitInSnapshot(snapshot, bucket, {
      circuitRef: 2,
      sourceBoardId: 'main',
      feedsBoardId: 'sub-1',
    });
    expect(observer.receipts.map((r) => r.kind)).toEqual([
      'board_add',
      'select_board',
      'mark_distribution_circuit',
    ]);
    expect(observer.receipts[0].detail.previous_current_board_id).toBe('main');
    expect(observer.receipts[1].detail.previous_board_id).toBe('sub-1');
  });

  test('circuit meta upsert reports created + changed fields once', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    upsertCircuitMeta(snapshot, { circuit_ref: 7, designation: 'Kitchen Ring' });
    upsertCircuitMeta(snapshot, { circuit_ref: 7, designation: 'Kitchen Ring' }); // no change
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0].detail).toMatchObject({
      created: true,
      changed_fields: ['circuit_designation'],
    });
  });

  test('observation atoms emit on the SESSION target', () => {
    const session = { extractedObservations: [] };
    const observer = createMutationObserver({ sessionId: 's1' });
    attachMutationObserver(session, observer);
    observer.setOriginFrame(MODEL_FRAME);
    const { id } = appendObservation(session, {
      code: 'C2',
      location: 'kitchen',
      text: 'damaged socket',
      circuit: 4,
      suggested_regulation: null,
    });
    deleteObservation(session, { observation_id: id });
    deleteObservation(session, { observation_id: id }); // not found — no receipt
    expect(observer.receipts.map((r) => r.kind)).toEqual([
      'observation_create',
      'observation_delete',
    ]);
    expect(observer.receipts[0].detail.observation_id).toBe(id);
  });
});

describe('producer origin frames', () => {
  test('the REAL write dispatcher frames model_direct around record_reading', async () => {
    const { snapshot, observer } = observedSnapshot();
    // Minimal session shape the record_reading dispatcher requires.
    const session = {
      sessionId: 's1',
      stateSnapshot: snapshot,
      voiceLatencyFlags: {},
    };
    const perTurnWrites = {
      readings: new Map(),
      readingJournal: [],
      boardReadings: new Map(),
      boardReadingJournal: [],
      boardOps: [],
      mandatoryNotices: [],
      voiceNotices: [],
    };
    // Pre-create the circuit so the dispatcher's existence check passes.
    snapshot.circuits[3] = {};
    const stubLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const dispatch = createWriteDispatcher(session, stubLogger, 't1', perTurnWrites, {
      hasLimRangedWriteV1: true,
      hasLowConfReadbackV1: true,
    });
    const env = await dispatch({
      tool_call_id: 'tc-1',
      name: 'record_reading',
      input: { field: 'measured_zs_ohm', circuit: 3, value: '0.63', confidence: 0.9 },
    });
    const body = JSON.parse(env.content);
    expect(body.ok).toBe(true);
    const readingReceipts = observer.receipts.filter((r) => r.kind === 'reading');
    expect(readingReceipts).toHaveLength(1);
    expect(readingReceipts[0].origin).toBe('model_direct');
    expect(readingReceipts[0].origin_meta).toMatchObject({ tool: 'record_reading' });
    // Frame cleared after dispatch — a later out-of-band atom call has no origin.
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'r1_r2_ohm', value: '0.2' });
    expect(observer.invalid?.reason).toBe('commit_without_origin_frame');
  });

  test('every declared origin is a member of the closed enum', () => {
    expect(SEMANTIC_ORIGINS).toEqual([
      'model_direct',
      'ask_auto_resolve',
      'calculator',
      'silent_deterministic',
      'dialogue_script_direct',
      'dialogue_script_derived',
    ]);
  });
});

describe('derived provenance (§B2 RED set)', () => {
  test('valid parent: a derived write resolves its slot-named trigger', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyReadingToSnapshot(snapshot, { circuit: 5, field: 'rcd_bs_en', value: '61009' });
    observer.setOriginFrame({
      origin: 'dialogue_script_derived',
      derivation_kind: 'mirror',
      parent_slot: { field: 'rcd_bs_en', circuit: 5 },
      source_slot: { field: 'rcd_bs_en', circuit: 5 },
    });
    applyReadingToSnapshot(snapshot, { circuit: 5, field: 'ocpd_bs_en', value: '61009' });
    const derived = observer.receipts[1];
    expect(derived.origin).toBe('dialogue_script_derived');
    expect(derived.parent_operation_id).toBe(observer.receipts[0].operation_id);
    expect(derived.derivation_kind).toBe('mirror');
    expect(observer.invalid).toBeNull();
  });

  test('RED wrong-trigger: a parent slot with no matching receipt is INVALID', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame({
      origin: 'dialogue_script_derived',
      derivation_kind: 'mirror',
      parent_slot: { field: 'never_written_field', circuit: 9 },
      source_slot: { field: 'never_written_field', circuit: 9 },
    });
    applyReadingToSnapshot(snapshot, { circuit: 9, field: 'ocpd_bs_en', value: '60898' });
    expect(observer.invalid?.reason).toBe('derived_parent_unresolved');
  });

  test('RED missing-parent: a derived frame without parent/derivation/source is INVALID', () => {
    const { observer } = observedSnapshot();
    observer.setOriginFrame({ origin: 'dialogue_script_derived' });
    expect(observer.invalid?.reason).toBe('derived_provenance_missing');
  });

  test('RED wrong-source: a derived frame without source_slot is INVALID', () => {
    const { observer } = observedSnapshot();
    observer.setOriginFrame({
      origin: 'silent_deterministic',
      derivation_kind: 'mirror',
      parent_slot: { field: 'x', circuit: 1 },
    });
    expect(observer.invalid?.reason).toBe('derived_provenance_missing');
  });

  test('RED commit without any origin frame records but latches INVALID', () => {
    const { snapshot, observer } = observedSnapshot();
    applyReadingToSnapshot(snapshot, { circuit: 1, field: 'measured_zs_ohm', value: '0.4' });
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0].origin).toBeNull();
    expect(observer.invalid?.reason).toBe('commit_without_origin_frame');
  });

  test('postcode-derived locality writes parent to the REAL postcode write', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyBoardReadingToSnapshot(snapshot, { field: 'postcode', value: 'SW1A 1AA' });
    observer.clearOriginFrame();
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'SW1A 1AA', town: 'London', county: 'Greater London' },
      's1',
      { family: 'site', parentField: 'postcode' }
    );
    expect(changes.map((c) => c.field)).toEqual(['town', 'county']);
    const derived = observer.receipts.filter((r) => r.origin === 'silent_deterministic');
    expect(derived).toHaveLength(2);
    for (const d of derived) {
      expect(d.parent_operation_id).toBe(observer.receipts[0].operation_id);
      expect(d.derivation_kind).toBe('postcode_locality');
    }
    expect(observer.invalid).toBeNull();
    // Values landed exactly where the pre-refactor direct writes put them.
    expect(snapshot.circuits[0].town).toBe('London');
    expect(snapshot.circuits[0].county).toBe('Greater London');
  });
});

describe('journal overlay join (§B2)', () => {
  const slotOf = (row) => ({ field: row.field, circuit: row.circuit ?? null, board_id: null });
  const writeSequenceOf = (row) => row.seq;

  test('matched overlay annotates the receipt; capture stays valid', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'measured_zs_ohm', value: '0.63' });
    observer.joinJournalOverlay({
      rows: [{ field: 'measured_zs_ohm', circuit: 3, seq: 41, source: 'dispatcher' }],
      writeSequenceOf,
      slotOf,
    });
    expect(observer.invalid).toBeNull();
    expect(observer.overlayFor(observer.receipts[0].operation_id)).toEqual({
      write_sequence: 41,
      journal_source: 'dispatcher',
    });
  });

  test('RED unmatched overlay row makes capture INVALID/HOLD', () => {
    const { observer } = observedSnapshot();
    observer.joinJournalOverlay({
      rows: [{ field: 'measured_zs_ohm', circuit: 3, seq: 41, source: 'dispatcher' }],
      writeSequenceOf,
      slotOf,
    });
    expect(observer.invalid?.reason).toBe('journal_overlay_unmatched');
  });

  test('address-mirror source-ledger cloning emits ZERO commits and stays exempt', () => {
    const { observer } = observedSnapshot();
    observer.joinJournalOverlay({
      rows: [{ field: 'client_address', circuit: null, seq: 7, source: 'address_mirror_clone' }],
      writeSequenceOf,
      slotOf,
      nonMutatingSources: ['address_mirror_clone'],
    });
    expect(observer.receipts).toHaveLength(0);
    expect(observer.invalid).toBeNull();
  });

  test('a journal row NEVER creates a commit receipt', () => {
    const { observer } = observedSnapshot();
    observer.joinJournalOverlay({
      rows: [{ field: 'x', circuit: 1, seq: 1, source: 'address_mirror_clone' }],
      writeSequenceOf,
      slotOf,
      nonMutatingSources: ['address_mirror_clone'],
    });
    expect(observer.receipts).toHaveLength(0);
  });
});

describe('capture failure discipline', () => {
  test('forced capture failure (throwing frame consumer) latches INVALID, never throws out', () => {
    const { snapshot, observer } = observedSnapshot();
    observer.setOriginFrame(MODEL_FRAME);
    // Force an internal failure: freeze the receipts array so push throws.
    Object.freeze(observer.receipts);
    expect(() =>
      applyReadingToSnapshot(snapshot, { circuit: 1, field: 'measured_zs_ohm', value: '0.4' })
    ).not.toThrow();
    expect(observer.invalid?.reason).toBe('commit_threw');
    // Production state change still happened — capture is behaviour-isolated.
    expect(snapshot.circuits[1].measured_zs_ohm).toBe('0.4');
  });

  test('dormant production path: atoms on an unobserved snapshot never allocate receipts', () => {
    const snapshot = makeSnapshot();
    applyReadingToSnapshot(snapshot, { circuit: 3, field: 'measured_zs_ohm', value: '0.63' });
    clearReadingInSnapshot(snapshot, { circuit: 3, field: 'measured_zs_ohm' });
    expect(snapshot[MUTATION_OBSERVER]).toBeUndefined();
  });
});
