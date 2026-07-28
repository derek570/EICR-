/**
 * A2-multiboard (2026-07-28) — effective-board WIRE ENRICHMENT.
 *
 * `record_reading` carries no `board_id` in the common case: the model says
 * "Zs on circuit three is nought four two" and the dispatcher resolves the
 * board from `select_board`. The dispatcher stores only the RAW input board id,
 * so that write reaches the wire UNSCOPED — and both clients then resolve it by
 * circuit REF alone (web's `ensureRow`, iOS's one envelope-wide
 * current/first-board fallback). On a cross-board turn two winners for circuit
 * 3 therefore land on ONE client row: the write survived the bundler (that is
 * what the journal fixed) and is still lost at the client.
 *
 * The fix stamps the dispatcher-resolved effective board onto the wire for:
 *   1. every FLAGGED (`replaces_cleared`) reading, always — the collapse
 *      manifest already keys on the effective board, so an unenriched flagged
 *      reading is unresolvable by the client's board-aware targeting;
 *   2. ordinary readings, but ONLY on a cross-board turn — so single-board
 *      traffic stays byte-identical and the loaded-barrel speculator's
 *      null-board cache entries keep hitting (Audio-First #3).
 */

import { jest } from '@jest/globals';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
} from '../extraction/stage6-dispatchers-circuit.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function ctx(session, perTurnWrites, callId) {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0, callId };
}

function session(boards, currentBoardId, circuits) {
  return {
    sessionId: 'a2mb-enrich',
    stateSnapshot: {
      circuits,
      boards,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

function bundle(perTurnWrites) {
  return bundleToolCallsIntoResult(perTurnWrites, null, {
    confirmationsEnabled: true,
    turnId: 't1',
  });
}

/** An omitted-`board_id` write — the shape the model actually emits. */
function unscopedWrite(s, p, callId, circuit, value, field = 'measured_zs_ohm') {
  return dispatchRecordReading(
    {
      tool_call_id: callId,
      name: 'record_reading',
      input: { field, circuit, value, confidence: 0.9, source_turn_id: 't1' },
    },
    ctx(s, p, callId)
  );
}

const zsOf = (r) => r.extracted_readings.filter((x) => x.field === 'measured_zs_ohm');

describe('A2-multiboard — cross-board ordinary writes are wire-enriched', () => {
  test('select_board A → write → select_board B → write: both survive AND carry their own board', async () => {
    const s = session(MULTI_BOARD, 'main', {
      3: { measured_zs_ohm: null },
      'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: null },
    });
    const p = createPerTurnWrites();

    await unscopedWrite(s, p, 'w1', 3, '0.42');
    // `select_board sub-b` — the dispatcher mutates `currentBoardId`, which is
    // the only thing the following write's effective-board resolution reads.
    s.stateSnapshot.currentBoardId = 'sub-b';
    await unscopedWrite(s, p, 'w2', 3, '0.55');

    const zs = zsOf(bundle(p));
    // Both writes reach the wire (the journal's doing) …
    expect(zs).toHaveLength(2);
    // … and each is addressed to the board it was dictated against. Without
    // this, both land on whichever circuit-3 row the client finds first.
    expect(zs.find((x) => x.value === '0.42').board_id).toBe('main');
    expect(zs.find((x) => x.value === '0.55').board_id).toBe('sub-b');
  });

  test('a single-board turn is NOT enriched — the wire stays byte-identical', async () => {
    // Same multi-board JOB, but the turn only writes one board. This is the
    // overwhelmingly common case and must not grow a new wire field (cache
    // hits + latency).
    const s = session(MULTI_BOARD, 'main', {
      3: { measured_zs_ohm: null },
      4: { measured_zs_ohm: null },
    });
    const p = createPerTurnWrites();

    await unscopedWrite(s, p, 'w1', 3, '0.42');
    await unscopedWrite(s, p, 'w2', 4, '0.61');

    const readings = bundle(p).extracted_readings;
    expect(readings).toHaveLength(2);
    for (const r of readings) {
      expect(Object.hasOwn(r, 'board_id')).toBe(false);
    }
  });

  test('an EXPLICIT board_id is never overwritten by enrichment', async () => {
    const s = session(MULTI_BOARD, 'main', {
      3: { measured_zs_ohm: null },
      'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: null },
    });
    const p = createPerTurnWrites();

    await dispatchRecordReading(
      {
        tool_call_id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(s, p, 'w1')
    );
    s.stateSnapshot.currentBoardId = 'sub-b';
    await unscopedWrite(s, p, 'w2', 3, '0.55');

    const zs = zsOf(bundle(p));
    expect(zs.find((x) => x.value === '0.42').board_id).toBe('main');
    expect(zs.find((x) => x.value === '0.55').board_id).toBe('sub-b');
  });
});

describe('A2-multiboard — flagged replacements are ALWAYS enriched', () => {
  test('clear + write, both omitting board_id, on a sub-board: the flag carries the board', async () => {
    // The exact multi-board F5: the inspector is on the sub-board, corrects a
    // value, and the collapse drops the clear. Pre-enrichment the surviving
    // write reached web flagged but UNSCOPED, so board-aware targeting could
    // not resolve it and the spoken replacement was never applied.
    const s = session(MULTI_BOARD, 'sub-b', {
      3: { measured_zs_ohm: '1.50' },
      'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: '2.50' },
    });
    const p = createPerTurnWrites();

    await dispatchClearReading(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      ctx(s, p, 'c1')
    );
    await unscopedWrite(s, p, 'w1', 3, '0.55');

    const r = bundle(p);
    const zs = zsOf(r);
    expect(zs).toHaveLength(1);
    expect(zs[0].replaces_cleared).toBe(true);
    expect(zs[0].board_id).toBe('sub-b');
    // The stale clear is gone (P5 collapse) — the enrichment does not disturb it.
    expect(
      (r.field_corrections ?? []).filter(
        (c) => c.reason === 'clear_reading' && c.field === 'measured_zs_ohm'
      )
    ).toHaveLength(0);
  });

  test('a flagged replacement on a SINGLE-board turn is still enriched', async () => {
    // Enrichment for flagged readings is unconditional — it is what makes the
    // client's fail-closed board targeting resolvable at all.
    const s = session(MULTI_BOARD, 'main', { 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();

    await dispatchClearReading(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      ctx(s, p, 'c1')
    );
    await unscopedWrite(s, p, 'w1', 3, '0.42');

    const zs = zsOf(bundle(p));
    expect(zs).toHaveLength(1);
    expect(zs[0].replaces_cleared).toBe(true);
    expect(zs[0].board_id).toBe('main');
  });

  test('a job with NO boards is enriched with the canonical main identity', async () => {
    const s = session([], null, { 3: { measured_zs_ohm: '1.50' } });
    const p = createPerTurnWrites();

    await dispatchClearReading(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      ctx(s, p, 'c1')
    );
    await unscopedWrite(s, p, 'w1', 3, '0.42');

    const zs = zsOf(bundle(p));
    expect(zs).toHaveLength(1);
    expect(zs[0].replaces_cleared).toBe(true);
    // The dispatcher resolves an unscoped write on a boardless job to the
    // synthesised default `main` identity — the SAME identity the production
    // hydration path creates (scope item 5). Enriching with it is what lets the
    // client's attributed-unscoped eligibility rule resolve the replacement;
    // leaving it off would be the unresolvable case all over again.
    expect(zs[0].board_id).toBe('main');
  });
});
