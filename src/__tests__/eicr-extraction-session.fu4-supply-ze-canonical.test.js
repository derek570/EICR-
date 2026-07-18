/**
 * F/U-4 (numeric-gate-redesign follow-up, 2026-07-18) — seeded/merged supply
 * Ze and PFC must land under the CANONICAL field_schema keys
 * (`earth_loop_impedance_ze`, `prospective_fault_current`), NOT the legacy
 * wire aliases (`ze`, `pfc`).
 *
 * The bug: `_seedStateFromJobState` stored `circuits[0].ze` while BOTH
 * calculators read `circuits[0].earth_loop_impedance_ze` — so a job-seeded
 * supply Ze was invisible to `calculate_zs` (every call on a seeded job
 * skipped `no_ze`), and the model-facing snapshot showed `ze` while the
 * dispatcher demanded the canonical key (split brain; surfaced by the live
 * marker-② "Zs for circuit 4." investigation).
 *
 * SCOPE GUARD pinned here too: the rename happens ONLY at the two SUPPLY
 * ingestion sites. Bare `ze` is ALSO a legitimate, distinct board_fields key
 * (a dictated board-level Ze on the main board lives at circuits[0] as `ze`)
 * — a bucket-wide LEGACY_TO_CANONICAL rename would corrupt real board
 * readings, so none was added.
 */

import { jest } from '@jest/globals';
import {
  EICRExtractionSession,
  SUPPLY_MERGE_KEY_ALIASES,
} from '../extraction/eicr-extraction-session.js';
import { dispatchCalculateZs } from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

// start() arms a REAL cache-keepalive timer (which would fire a real HTTP
// call with the fake key and keep the jest process alive) — track every
// session and stop() it in afterEach.
const liveSessions = [];
afterEach(() => {
  for (const s of liveSessions.splice(0)) {
    try {
      s.stop();
    } catch {
      /* teardown only */
    }
  }
});

function makeSession(opts = {}) {
  const s = new EICRExtractionSession('test-key', `fu4-${Math.random()}`, 'eicr', opts);
  liveSessions.push(s);
  return s;
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('F/U-4 — seeder stores canonical supply keys', () => {
  test('start() with supply.ze seeds circuits[0].earth_loop_impedance_ze (no bare ze key)', () => {
    const s = makeSession();
    s.start({ circuits: [], supply: { ze: '0.35' } });
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.35');
    expect('ze' in s.stateSnapshot.circuits[0]).toBe(false);
  });

  test('start() with supplyCharacteristics.earthLoopImpedanceZe (iOS camel shape) seeds the canonical key', () => {
    const s = makeSession();
    s.start({ circuits: [], supplyCharacteristics: { earthLoopImpedanceZe: '0.28' } });
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.28');
  });

  test('start() with supply.pfc seeds prospective_fault_current (no bare pfc key)', () => {
    const s = makeSession();
    s.start({ circuits: [], supply: { pfc: '1.5', prospectiveFaultCurrent: undefined } });
    expect(s.stateSnapshot.circuits[0].prospective_fault_current).toBe('1.5');
    expect('pfc' in s.stateSnapshot.circuits[0]).toBe(false);
  });
});

describe('F/U-4 — updateJobState supply merge maps aliases to canonical (fill-if-empty)', () => {
  test('camelCase earthLoopImpedanceZe fills the canonical key', () => {
    const s = makeSession();
    s.updateJobState({ supply: { earthLoopImpedanceZe: '0.31' } });
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.31');
    expect('earthLoopImpedanceZe' in s.stateSnapshot.circuits[0]).toBe(false);
  });

  test('short ze alias fills the canonical key', () => {
    const s = makeSession();
    s.updateJobState({ supply: { ze: 0.4 } });
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe(0.4);
    expect('ze' in s.stateSnapshot.circuits[0]).toBe(false);
  });

  test('a DICTATED canonical value wins over a later job-state echo (reading fill-if-empty contract)', () => {
    const s = makeSession();
    // Simulate a live record_board_reading having written the canonical key.
    s.stateSnapshot.circuits[0] = { earth_loop_impedance_ze: '0.13' };
    s.updateJobState({ supply: { ze: '0.99' } });
    // The dictated value is snapshot-canonical; the echo must not overwrite.
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.13');
  });

  test('the alias map is exactly the four supply keys (scope pin)', () => {
    expect(SUPPLY_MERGE_KEY_ALIASES).toEqual({
      earthLoopImpedanceZe: 'earth_loop_impedance_ze',
      ze: 'earth_loop_impedance_ze',
      prospectiveFaultCurrent: 'prospective_fault_current',
      pfc: 'prospective_fault_current',
    });
  });

  test('SCOPE GUARD: a circuit-level `ze` key is NOT renamed (board-field distinctness preserved)', () => {
    const s = makeSession();
    // kind='circuit' merge path: ze must pass through raw — it is a distinct
    // board_fields key, not the supply alias.
    s.updateJobState({ circuits: [{ ref: 1, ze: '0.50' }] });
    expect(s.stateSnapshot.circuits[1].ze).toBe('0.50');
    expect('earth_loop_impedance_ze' in s.stateSnapshot.circuits[1]).toBe(false);
  });
});

describe('F/U-4 — the repro: calculate_zs SEES a job-seeded supply Ze', () => {
  test('seeded supply Ze + circuit r1_r2 → dispatchCalculateZs COMPUTES (no more no_ze skip)', async () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 4, designation: 'Upstairs Sockets', r1R2Ohm: '0.86' }],
      supply: { ze: '0.35' },
    });
    const perTurnWrites = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_fu4', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      { session: s, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0 }
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(true);
    // Pre-fix this was computed:[], skipped:[{reason:'no_ze'}].
    expect(body.skipped).toEqual([]);
    expect(body.computed).toEqual([
      { circuit_ref: 4, field: 'measured_zs_ohm', value: '1.21' }, // 0.35 + 0.86
    ]);
  });
});
