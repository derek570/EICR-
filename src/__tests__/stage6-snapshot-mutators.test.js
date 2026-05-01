/**
 * Tests for src/extraction/stage6-snapshot-mutators.js — the six shared
 * mutation atoms that both legacy updateStateSnapshot AND Phase 2 tool-call
 * dispatchers must call.
 *
 * Contract (per Plan 02-01 §Interfaces):
 *  - applyReadingToSnapshot   — write circuit-field value; auto-creates bucket
 *  - clearReadingInSnapshot   — delete a value; returns {cleared: boolean}
 *  - upsertCircuitMeta        — update meta fields; preserves unmentioned
 *  - renameCircuit            — rekey from_ref → circuit_ref; {ok, error?}
 *  - appendObservation        — push observation w/ uuid; owns id generation
 *  - deleteObservation        — remove by id; {ok, removed|error}
 */

import {
  applyReadingToSnapshot,
  clearReadingInSnapshot,
  upsertCircuitMeta,
  renameCircuit,
  appendObservation,
  deleteObservation,
} from '../extraction/stage6-snapshot-mutators.js';

// UUIDv4 shape — appendObservation MUST use crypto.randomUUID().
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const emptySnapshot = () => ({ circuits: {} });
const emptySession = () => ({ extractedObservations: [] });

describe('applyReadingToSnapshot', () => {
  test('writes into an empty snapshot, auto-creating the bucket (LEGACY behaviour preserved)', () => {
    const snap = emptySnapshot();
    applyReadingToSnapshot(snap, { circuit: 3, field: 'Ze_ohms', value: '0.35' });
    expect(snap).toEqual({ circuits: { 3: { Ze_ohms: '0.35' } } });
  });

  test('overwrites existing value for the same circuit+field (same-turn correction path)', () => {
    const snap = { circuits: { 3: { Ze_ohms: '0.35' } } };
    applyReadingToSnapshot(snap, { circuit: 3, field: 'Ze_ohms', value: '0.41' });
    expect(snap.circuits[3].Ze_ohms).toBe('0.41');
  });

  test('does not clobber other fields on the same circuit', () => {
    const snap = { circuits: { 3: { Ze_ohms: '0.35', Zs_ohms: '0.43' } } };
    applyReadingToSnapshot(snap, { circuit: 3, field: 'Zs_ohms', value: '0.44' });
    expect(snap.circuits[3]).toEqual({ Ze_ohms: '0.35', Zs_ohms: '0.44' });
  });
});

describe('clearReadingInSnapshot', () => {
  test('clears an existing value and returns {cleared: true}', () => {
    const snap = { circuits: { 3: { Ze_ohms: '0.35' } } };
    const res = clearReadingInSnapshot(snap, { circuit: 3, field: 'Ze_ohms' });
    expect(res).toEqual({ cleared: true });
    expect(snap.circuits).toEqual({ 3: {} });
  });

  test('noop on missing circuit — returns {cleared: false}, snapshot unchanged', () => {
    const snap = { circuits: {} };
    const res = clearReadingInSnapshot(snap, { circuit: 99, field: 'Ze_ohms' });
    expect(res).toEqual({ cleared: false });
    expect(snap).toEqual({ circuits: {} });
  });

  test('noop on missing field — returns {cleared: false}, snapshot unchanged', () => {
    const snap = { circuits: { 3: { Zs_ohms: '0.43' } } };
    const res = clearReadingInSnapshot(snap, { circuit: 3, field: 'Ze_ohms' });
    expect(res).toEqual({ cleared: false });
    expect(snap.circuits[3]).toEqual({ Zs_ohms: '0.43' });
  });
});

describe('upsertCircuitMeta', () => {
  test('creates a new bucket with only the supplied meta field', () => {
    const snap = emptySnapshot();
    upsertCircuitMeta(snap, { circuit_ref: 5, designation: 'Ring final' });
    expect(snap.circuits).toEqual({ 5: { designation: 'Ring final' } });
  });

  test('ignores null/undefined meta fields (no key written)', () => {
    const snap = emptySnapshot();
    upsertCircuitMeta(snap, {
      circuit_ref: 5,
      designation: 'Ring final',
      phase: null,
      rating_amps: undefined,
      cable_csa_mm2: null,
    });
    expect(snap.circuits[5]).toEqual({ designation: 'Ring final' });
  });

  test('on existing circuit, updates supplied fields and preserves unmentioned', () => {
    const snap = {
      circuits: {
        5: { designation: 'Ring final', phase: 'L1', rating_amps: 32 },
      },
    };
    upsertCircuitMeta(snap, { circuit_ref: 5, phase: 'L2' });
    expect(snap.circuits[5]).toEqual({
      designation: 'Ring final',
      phase: 'L2',
      rating_amps: 32,
    });
  });
});

describe('renameCircuit', () => {
  test('rekeys a bucket from from_ref to circuit_ref, returns {ok:true}', () => {
    const snap = { circuits: { 3: { Ze_ohms: '0.35' } } };
    const res = renameCircuit(snap, { from_ref: 3, circuit_ref: 7 });
    expect(res).toEqual({ ok: true });
    expect(snap.circuits).toEqual({ 7: { Ze_ohms: '0.35' } });
    expect(snap.circuits[3]).toBeUndefined();
  });

  test('returns {ok:false, error:source_not_found} when from_ref missing; snapshot unchanged', () => {
    const snap = { circuits: { 7: { Ze_ohms: '0.35' } } };
    const before = JSON.stringify(snap);
    const res = renameCircuit(snap, { from_ref: 3, circuit_ref: 8 });
    expect(res).toEqual({ ok: false, error: { code: 'source_not_found' } });
    expect(JSON.stringify(snap)).toBe(before);
  });

  test('returns {ok:false, error:target_exists} when circuit_ref occupied; NO destructive merge', () => {
    const snap = {
      circuits: { 3: { Ze_ohms: '0.35' }, 7: { Ze_ohms: '0.99' } },
    };
    const before = JSON.stringify(snap);
    const res = renameCircuit(snap, { from_ref: 3, circuit_ref: 7 });
    expect(res).toEqual({ ok: false, error: { code: 'target_exists' } });
    expect(JSON.stringify(snap)).toBe(before);
  });

  test('from_ref === circuit_ref is an idempotent noop (Plan 02-01 §Q8)', () => {
    const snap = { circuits: { 3: { Ze_ohms: '0.35' } } };
    const before = JSON.stringify(snap);
    const res = renameCircuit(snap, { from_ref: 3, circuit_ref: 3 });
    expect(res).toEqual({ ok: true });
    expect(JSON.stringify(snap)).toBe(before);
  });
});

describe('appendObservation', () => {
  test('pushes onto session.extractedObservations with a fresh UUIDv4 id', () => {
    const session = emptySession();
    const res = appendObservation(session, {
      code: 'C2',
      location: 'kitchen',
      text: 'damaged socket',
      circuit: null,
      suggested_regulation: null,
    });
    expect(res.id).toMatch(UUID_V4_RE);
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0]).toEqual({
      id: res.id,
      code: 'C2',
      location: 'kitchen',
      text: 'damaged socket',
      circuit: null,
      suggested_regulation: null,
      schedule_item: null,
    });
  });

  test('two calls produce two distinct UUIDs and both observations are present', () => {
    const session = emptySession();
    const { id: id1 } = appendObservation(session, {
      code: 'C2',
      location: 'x',
      text: 'y',
      circuit: null,
      suggested_regulation: null,
    });
    const { id: id2 } = appendObservation(session, {
      code: 'C3',
      location: 'z',
      text: 'w',
      circuit: 5,
      suggested_regulation: '411.3.1.1',
    });
    expect(id1).not.toBe(id2);
    expect(session.extractedObservations.map((o) => o.id)).toEqual([id1, id2]);
  });

  test('initialises extractedObservations if absent on session', () => {
    const session = {};
    appendObservation(session, {
      code: 'C1',
      location: 'a',
      text: 'b',
      circuit: null,
      suggested_regulation: null,
    });
    expect(Array.isArray(session.extractedObservations)).toBe(true);
    expect(session.extractedObservations).toHaveLength(1);
  });
});

describe('deleteObservation', () => {
  test('removes the observation by id and returns {ok:true, removed:{...}}', () => {
    const session = emptySession();
    const { id } = appendObservation(session, {
      code: 'C2',
      location: 'kitchen',
      text: 'damaged socket',
      circuit: null,
      suggested_regulation: null,
    });
    const res = deleteObservation(session, { observation_id: id });
    expect(res.ok).toBe(true);
    expect(res.removed.id).toBe(id);
    expect(res.removed.code).toBe('C2');
    expect(session.extractedObservations).toHaveLength(0);
  });

  test('returns {ok:false, error:not_found} for an unknown id; session unchanged', () => {
    const session = emptySession();
    appendObservation(session, {
      code: 'C2',
      location: 'kitchen',
      text: 'damaged socket',
      circuit: null,
      suggested_regulation: null,
    });
    const before = JSON.stringify(session.extractedObservations);
    const res = deleteObservation(session, { observation_id: 'not-a-real-id' });
    expect(res).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(JSON.stringify(session.extractedObservations)).toBe(before);
  });
});
