/**
 * A01P (2026-09-08) — ACCEPTED-ALIAS CONSISTENCY for Ze / PFC.
 *
 * "Ze 0.35", then "Ze 0.50", then Calculate Zs with R1+R2 0.20 gave 0.55: the
 * correction was stored under the raw key the model used while the hydrated
 * sibling spelling kept 0.35, and the calculators read the short key first.
 *
 * Contract pinned here (stage6-snapshot-mutators.js `writeAcceptedAliases`):
 *   - the accepted RAW key is written; alias siblings ALREADY PRESENT in the
 *     SAME record are reconciled to the same value;
 *   - an ABSENT sibling is never created for storage (outbound
 *     FIELD_CORRECTIONS still supplies ze/pfc on the wire);
 *   - no cross-bucket copy (circuits[0] vs boards[]), no seed/merge fan-out;
 *   - ONE mutation receipt per atom when ANY targeted slot changed
 *     (alias-only repair included), ZERO for an unchanged replay, original
 *     kind/field/origin preserved, secondary slots in `detail.alias_repairs`;
 *   - `projectField` answers exact key first, then an absent-key alias
 *     fallback within its bucket; a bucket holding BOTH spellings answers each
 *     by its exact key ([current_behaviour], A01 unifies).
 */

import { jest } from '@jest/globals';

const { dispatchRecordBoardReading } = await import('../extraction/stage6-dispatchers-board.js');
const { createInspectDispatcher } = await import('../extraction/stage6-dispatchers-answer.js');
const { dispatchCalculateZs } = await import('../extraction/stage6-dispatchers-circuit.js');
const {
  applyReadingToSnapshot,
  applyReadingMultiBoard,
  applyBoardReadingToSnapshot,
  applyBoardReadingMultiBoard,
  applyReadingFlagAware,
  writeAcceptedAliases,
  acceptedAliasSiblings,
} = await import('../extraction/stage6-snapshot-mutators.js');
const { createPerTurnWrites } = await import('../extraction/stage6-per-turn-writes.js');
const { createMutationObserver, attachMutationObserver } =
  await import('../extraction/plan00-semantic-capture.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(snapshot = {}) {
  return {
    sessionId: 'sess-a01p-alias',
    certType: 'eicr',
    toolCallsMode: 'live',
    stateSnapshot: {
      circuits: { 0: {} },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'b2', designation: 'Garage', board_type: 'sub_distribution' },
      ],
      currentBoardId: 'main',
      ...snapshot,
    },
    extractedObservations: [],
  };
}

/** Attach a REAL observer with a real producer origin frame. */
function observe(snapshot, origin = 'model_direct') {
  const observer = createMutationObserver({ sessionId: 'sess-a01p-alias' });
  attachMutationObserver(snapshot, observer);
  observer.setOriginFrame({ origin, meta: { leg: 'test' } });
  return observer;
}

function ctxFor(session) {
  return {
    session,
    logger: makeLogger(),
    turnId: 'turn-1',
    perTurnWrites: createPerTurnWrites(),
    round: 1,
  };
}

async function record(session, input, id = 'toolu_rbr') {
  return dispatchRecordBoardReading(
    { tool_call_id: id, name: 'record_board_reading', input: { confidence: 0.9, ...input } },
    ctxFor(session)
  );
}

function body(env) {
  return JSON.parse(env.content);
}

describe('acceptedAliasSiblings / writeAcceptedAliases — the helper', () => {
  test('families are exactly the ze and pfc alias sets; other fields have no siblings', () => {
    expect(acceptedAliasSiblings('ze')).toEqual(['earth_loop_impedance_ze']);
    expect(acceptedAliasSiblings('earth_loop_impedance_ze')).toEqual(['ze']);
    expect(acceptedAliasSiblings('pfc')).toEqual(['prospective_fault_current']);
    expect(acceptedAliasSiblings('prospective_fault_current')).toEqual(['pfc']);
    expect(acceptedAliasSiblings('manufacturer')).toEqual([]);
    expect(acceptedAliasSiblings('client_name')).toEqual([]);
  });

  test('[invariant] a present sibling is reconciled; an absent sibling is never created', () => {
    const rec = { ze: '0.35', earth_loop_impedance_ze: '0.35' };
    const w = writeAcceptedAliases(rec, 'earth_loop_impedance_ze', '0.50');
    expect(rec).toEqual({ ze: '0.50', earth_loop_impedance_ze: '0.50' });
    expect(w.changed).toBe(true);
    expect(w.previous).toBe('0.35');
    expect(w.repaired).toEqual([{ key: 'ze', previous_value: '0.35' }]);

    const bare = {};
    writeAcceptedAliases(bare, 'ze', '0.35');
    expect(bare).toEqual({ ze: '0.35' });
    expect('earth_loop_impedance_ze' in bare).toBe(false);
  });

  test('[invariant] alias-ONLY repair counts as a change; an unchanged replay does not', () => {
    const rec = { ze: '0.50', earth_loop_impedance_ze: '0.35' };
    const w = writeAcceptedAliases(rec, 'ze', '0.50');
    expect(w.changed).toBe(true);
    expect(w.repaired).toEqual([{ key: 'earth_loop_impedance_ze', previous_value: '0.35' }]);
    const w2 = writeAcceptedAliases(rec, 'ze', '0.50');
    expect(w2.changed).toBe(false);
    expect(w2.repaired).toEqual([]);
  });
});

describe('[invariant] the four atoms reconcile within their OWN bucket only', () => {
  test('applyBoardReadingToSnapshot (circuits[0]) — both spellings present → both updated; boards[main] untouched', () => {
    const snapshot = makeSession({
      circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.35' } },
      boards: [{ id: 'main', board_type: 'main', ze: '0.35' }],
    }).stateSnapshot;
    applyBoardReadingToSnapshot(snapshot, { field: 'ze', value: '0.50' });
    expect(snapshot.circuits[0]).toEqual({ ze: '0.50', earth_loop_impedance_ze: '0.50' });
    expect(snapshot.boards[0].ze).toBe('0.35'); // no cross-bucket copy
  });

  test('applyBoardReadingMultiBoard (boards[b2]) — sibling present on the record is reconciled', () => {
    const snapshot = makeSession({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'b2', board_type: 'sub_distribution', ze: '0.40', earth_loop_impedance_ze: '0.40' },
      ],
    }).stateSnapshot;
    applyBoardReadingMultiBoard(snapshot, {
      field: 'earth_loop_impedance_ze',
      value: '0.55',
      boardId: 'b2',
    });
    expect(snapshot.boards[1]).toMatchObject({ ze: '0.55', earth_loop_impedance_ze: '0.55' });
    expect(snapshot.circuits[0]).toEqual({});
  });

  test('applyReadingToSnapshot circuit 0 (legacy atom) reconciles; circuit 1 is exact-key only', () => {
    const snapshot = makeSession({
      circuits: {
        0: { pfc: '1.2', prospective_fault_current: '1.2' },
        1: { ze: 'x', earth_loop_impedance_ze: 'y' },
      },
    }).stateSnapshot;
    applyReadingToSnapshot(snapshot, {
      circuit: 0,
      field: 'prospective_fault_current',
      value: '2.0',
    });
    expect(snapshot.circuits[0]).toEqual({ pfc: '2.0', prospective_fault_current: '2.0' });
    applyReadingToSnapshot(snapshot, { circuit: 1, field: 'ze', value: 'z' });
    expect(snapshot.circuits[1]).toEqual({ ze: 'z', earth_loop_impedance_ze: 'y' });
  });

  test('applyReadingMultiBoard circuit 0 on a sub-board composite bucket reconciles', () => {
    const snapshot = makeSession({
      currentBoardId: 'b2',
      circuits: {
        'b2::0': { circuit: 0, board_id: 'b2', ze: '0.40', earth_loop_impedance_ze: '0.40' },
      },
    }).stateSnapshot;
    applyReadingMultiBoard(snapshot, { circuit: 0, field: 'ze', value: '0.60', boardId: 'b2' });
    expect(snapshot.circuits['b2::0']).toMatchObject({
      ze: '0.60',
      earth_loop_impedance_ze: '0.60',
    });
  });

  test('legacy off-mode path (applyReadingFlagAware, main, circuit 0) reconciles the same way', () => {
    const snapshot = makeSession({
      circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.35' } },
    }).stateSnapshot;
    applyReadingFlagAware(snapshot, {
      circuit: 0,
      field: 'earth_loop_impedance_ze',
      value: '0.50',
    });
    expect(snapshot.circuits[0]).toEqual({ ze: '0.50', earth_loop_impedance_ze: '0.50' });
  });
});

describe('[invariant] mutation receipts — one per changed atom, attribution preserved, alias slots in detail', () => {
  test('live dispatch: both spellings present, raw `ze` accepted → ONE board_reading receipt with alias_repairs', async () => {
    const session = makeSession({
      circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.35' } },
    });
    const observer = observe(session.stateSnapshot, 'model_direct');
    const env = await record(session, { field: 'ze', value: '0.50' });
    expect(env.is_error).toBe(false);
    expect(observer.invalid).toBeNull();
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0]).toMatchObject({
      kind: 'board_reading',
      field: 'ze',
      circuit: null,
      board_id: 'main',
      value: '0.50',
      previous_value: '0.35',
      origin: 'model_direct',
      detail: {
        storage: 'circuits0',
        alias_repairs: [{ key: 'earth_loop_impedance_ze', previous_value: '0.35' }],
      },
    });
    expect(session.stateSnapshot.circuits[0]).toEqual({
      ze: '0.50',
      earth_loop_impedance_ze: '0.50',
    });
  });

  test('alias-ONLY repair (primary already equal, sibling stale) still emits exactly one receipt', () => {
    const snapshot = makeSession({
      circuits: { 0: { ze: '0.50', earth_loop_impedance_ze: '0.35' } },
    }).stateSnapshot;
    const observer = observe(snapshot);
    applyBoardReadingToSnapshot(snapshot, { field: 'ze', value: '0.50' });
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0].previous_value).toBe('0.50');
    expect(observer.receipts[0].detail.alias_repairs).toEqual([
      { key: 'earth_loop_impedance_ze', previous_value: '0.35' },
    ]);
  });

  test('an unchanged replay emits ZERO receipts', () => {
    const snapshot = makeSession({
      circuits: { 0: { ze: '0.50', earth_loop_impedance_ze: '0.50' } },
    }).stateSnapshot;
    const observer = observe(snapshot);
    applyBoardReadingToSnapshot(snapshot, { field: 'earth_loop_impedance_ze', value: '0.50' });
    expect(observer.receipts).toHaveLength(0);
  });

  test('legacy leg: applyReadingToSnapshot circuit 0 keeps kind reading + its origin, alias slot in detail', () => {
    const snapshot = makeSession({
      circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.35' } },
    }).stateSnapshot;
    const observer = observe(snapshot, 'model_direct');
    applyReadingToSnapshot(snapshot, {
      circuit: 0,
      field: 'earth_loop_impedance_ze',
      value: '0.50',
    });
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0]).toMatchObject({
      kind: 'reading',
      field: 'earth_loop_impedance_ze',
      circuit: 0,
      origin: 'model_direct',
      detail: { alias_repairs: [{ key: 'ze', previous_value: '0.35' }] },
    });
  });

  test('no-sibling write keeps the receipt detail exactly as before (no alias_repairs key)', () => {
    const snapshot = makeSession().stateSnapshot;
    const observer = observe(snapshot);
    applyBoardReadingToSnapshot(snapshot, { field: 'ze', value: '0.35' });
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0].detail).toEqual({ storage: 'circuits0' });
  });
});

describe('real dispatch pins — first write leaves the sibling absent; both correction orders reconcile', () => {
  test('[current_behaviour] first RAW main `ze` leaves the long alias absent; a sub-board with nothing of its own falls back to origin (no_ze when the origin key is absent)', async () => {
    const session = makeSession();
    await record(session, { field: 'ze', value: '0.35' });
    expect(session.stateSnapshot.circuits[0]).toEqual({ ze: '0.35' });
    // Origin supply key (earth_loop_impedance_ze) is absent → sub-board calc is no_ze.
    session.stateSnapshot.circuits['b2::4'] = { circuit: 4, board_id: 'b2', r1_r2_ohm: '0.20' };
    const res = await dispatchCalculateZs(
      {
        tool_call_id: 'tu',
        name: 'calculate_zs',
        input: { circuit_ref: 4, all: false, board_id: 'b2' },
      },
      ctxFor(session)
    );
    expect(body(res).skipped).toEqual([{ circuit_ref: 4, reason: 'no_ze' }]);
  });

  test('[current_behaviour] first LONG-form main Ze leaves the short key absent', async () => {
    const session = makeSession();
    await record(session, { field: 'earth_loop_impedance_ze', value: '0.50' });
    expect(session.stateSnapshot.circuits[0]).toEqual({ earth_loop_impedance_ze: '0.50' });
  });

  test('[invariant] hydrated {ze:0.35, earth_loop_impedance_ze:0.50}: a fresh accepted write of EITHER spelling reconciles both, then Calculate uses it', async () => {
    for (const spelling of ['ze', 'earth_loop_impedance_ze']) {
      const session = makeSession({
        circuits: {
          0: { ze: '0.35', earth_loop_impedance_ze: '0.50' },
          1: { r1_r2_ohm: '0.20' },
        },
      });
      await record(session, { field: spelling, value: '0.60' });
      expect(session.stateSnapshot.circuits[0]).toEqual({
        ze: '0.60',
        earth_loop_impedance_ze: '0.60',
      });
      const res = await dispatchCalculateZs(
        { tool_call_id: 'tu', name: 'calculate_zs', input: { circuit_ref: 1, all: false } },
        ctxFor(session)
      );
      expect(body(res).computed).toEqual([
        { circuit_ref: 1, field: 'measured_zs_ohm', value: '0.80' },
      ]);
    }
  });

  test('[invariant] the repro: Ze 0.35 (raw ze), then Ze 0.50 as the long form, R1+R2 0.20 → Calculate 0.70', async () => {
    const session = makeSession({ circuits: { 0: {}, 1: { r1_r2_ohm: '0.20' } } });
    await record(session, { field: 'ze', value: '0.35' });
    // A hydration or prior long-form write can leave the sibling present — seed it stale.
    session.stateSnapshot.circuits[0].earth_loop_impedance_ze = '0.35';
    await record(session, { field: 'earth_loop_impedance_ze', value: '0.50' }, 'toolu_2');
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu', name: 'calculate_zs', input: { circuit_ref: 1, all: false } },
      ctxFor(session)
    );
    expect(body(res).computed).toEqual([
      { circuit_ref: 1, field: 'measured_zs_ohm', value: '0.70' },
    ]);
  });
});

describe('inspect — exact key first, absent-key alias fallback within the bucket', () => {
  function inspect(session, input) {
    const dispatch = createInspectDispatcher(
      session,
      makeLogger(),
      'turn-1',
      createPerTurnWrites()
    );
    return dispatch({ tool_call_id: 'toolu_i', name: 'inspect_session_state', input });
  }

  test('[invariant] bucket holds only `ze` → asking for earth_loop_impedance_ze answers it (and vice versa)', async () => {
    const s1 = makeSession({ circuits: { 0: { ze: '0.35' } } });
    const a = body(await inspect(s1, { scope: 'field', field: 'earth_loop_impedance_ze' }));
    expect(a).toMatchObject({ ok: true, recorded: true, value: '0.35' });
    const s2 = makeSession({ circuits: { 0: { earth_loop_impedance_ze: '0.50' } } });
    const b = body(await inspect(s2, { scope: 'field', field: 'ze' }));
    expect(b).toMatchObject({ ok: true, recorded: true, value: '0.50' });
  });

  test('[current_behaviour] bucket holds BOTH spellings with different values → each spelling answers its exact key', async () => {
    const s = makeSession({ circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.50' } } });
    expect(body(await inspect(s, { scope: 'field', field: 'ze' })).value).toBe('0.35');
    expect(body(await inspect(s, { scope: 'field', field: 'earth_loop_impedance_ze' })).value).toBe(
      '0.50'
    );
  });

  test('fallback never crosses buckets: a sub-board record answers from its own record only', async () => {
    const s = makeSession({
      currentBoardId: 'b2',
      circuits: { 0: { ze: '0.35' } },
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'b2', board_type: 'sub_distribution', earth_loop_impedance_ze: '0.55' },
      ],
    });
    // circuits[0] is the MAIN bucket; b2's composite circuit-0 bucket is absent,
    // so the projector reads b2's board record — under the alias fallback.
    expect(body(await inspect(s, { scope: 'field', field: 'ze', board_id: 'b2' })).value).toBe(
      '0.55'
    );
  });
});
