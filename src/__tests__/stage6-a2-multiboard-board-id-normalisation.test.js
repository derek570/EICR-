/**
 * A2-multiboard (2026-07-28) scope item 6 — the BOARD-ID NORMALISATION BOUNDARY.
 *
 * An empty-string `board_id` is a real shape, not a hypothetical: legacy CSV
 * parsing writes `board_id: ''`, `record_reading` can retain `boardId: ''`, and
 * the bundler emits it (its omit-guard is `!= null`). Backend helpers then
 * disagree about what it MEANS — `getCircuitBucket` / `listCircuitRefsInBoard` /
 * `circuitExistsInSnapshot` read it through a nullish fallback and treat it as
 * "the current board", while `validateBoardScope` compares `'' === currentBoardId`
 * and rejects the whole call as `wrong_board`. So the same tool call is
 * simultaneously routable and unroutable depending on which helper looks first,
 * and which one wins is an accident of dispatcher ordering.
 *
 * The fix normalises at the DISPATCHER BOUNDARY — before validation, snapshot
 * lookup/mutation, Map-key encoding, outward metadata, telemetry and
 * effective-slot attachment — so every seam below sees the one spelling they
 * already agree on: absent.
 *
 * The boundary is ENUMERATED, not blanket. Three board-scoped dispatchers are
 * deliberately EXEMPT and must keep REJECTING an injected empty id:
 *   - `select_board`        — identity/selection (`invalid_board_id`)
 *   - `clear_board_reading` — destructive (`wrong_board`; the A1a contract)
 *   - `record_board_reading`— authoritative, shares the same reject-before-mutate
 *                             guard (`wrong_board`)
 * A blanket rule would silently retarget a destructive or authoritative write at
 * whatever board happens to be current, which is exactly what those guards exist
 * to prevent. The three pins at the bottom of this file are the regression lock.
 */

import { jest } from '@jest/globals';
import {
  isUnscopedBoardId,
  normaliseBoardScopeInput,
} from '../extraction/stage6-multi-board-shape.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
  dispatchCalculateZs,
  dispatchSetFieldForAllCircuits,
} from '../extraction/stage6-dispatchers-circuit.js';
import {
  dispatchMarkDistributionCircuit,
  dispatchSelectBoard,
  dispatchClearBoardReading,
  dispatchRecordBoardReading,
} from '../extraction/stage6-dispatchers-board.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';
import { createAutoResolveWriteHook } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';
import * as barrelCache from '../extraction/loaded-barrel-cache.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const BOARDS = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub_distribution', parent_board_id: 'main' },
];

/** Current board is the SUB board — so "defaults to current" is discriminating. */
function makeSession(circuits = {}, extra = {}) {
  return {
    sessionId: 'a2mb-normalise',
    certType: 'eicr',
    stateSnapshot: {
      circuits,
      boards: BOARDS.map((b) => ({ ...b })),
      currentBoardId: 'sub-b',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      ...extra,
    },
    extractedObservations: [],
  };
}

function ctx(session, perTurnWrites, extra = {}) {
  return {
    session,
    logger: mockLogger(),
    turnId: 't1',
    perTurnWrites,
    round: 0,
    hasBoardClearV1: true,
    ...extra,
  };
}

const body = (env) => JSON.parse(env.content);

// ───────────────────────────────────────────────────────────────────────────
describe('the shared unscoped-board rule', () => {
  test('isUnscopedBoardId treats absent and empty-string alike, and nothing else', () => {
    expect(isUnscopedBoardId(null)).toBe(true);
    expect(isUnscopedBoardId(undefined)).toBe(true);
    expect(isUnscopedBoardId('')).toBe(true);
    expect(isUnscopedBoardId('main')).toBe(false);
    // `'*'` is the broadcast sentinel, not a board id — it must survive.
    expect(isUnscopedBoardId('*')).toBe(false);
    // Whitespace is NOT collapsed: it is not a shape any producer emits, and
    // silently accepting it would widen the rule past what is evidenced.
    expect(isUnscopedBoardId(' ')).toBe(false);
  });

  test('normaliseBoardScopeInput deletes only the empty string, in place', () => {
    const input = { field: 'measured_zs_ohm', board_id: '' };
    const returned = normaliseBoardScopeInput(input);
    // Identity is preserved deliberately: dispatchRecordReading already mutates
    // call.input (coercion, then the impedance clamp) so the snapshot write and
    // the wire mirror cannot hold different values. A clone would break that on
    // exactly the legacy inputs this normaliser exists to handle.
    expect(returned).toBe(input);
    expect('board_id' in input).toBe(false);

    const star = { board_id: '*' };
    expect(normaliseBoardScopeInput(star).board_id).toBe('*');
    const real = { board_id: 'sub-b' };
    expect(normaliseBoardScopeInput(real).board_id).toBe('sub-b');
    // An absent key stays absent rather than being materialised as undefined —
    // the bundler's omit-guards key off `in`/`!= null`, not truthiness.
    const bare = { field: 'x' };
    expect('board_id' in normaliseBoardScopeInput(bare)).toBe(false);
    // Non-objects are passed through rather than thrown on.
    expect(normaliseBoardScopeInput(null)).toBeNull();
    expect(normaliseBoardScopeInput(undefined)).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('circuit mutators — an empty board_id routes to the current board', () => {
  test('record_reading writes to the CURRENT board instead of rejecting as wrong_board', async () => {
    const session = makeSession({ 'sub-b::3': { board_id: 'sub-b', circuit: 3 } });
    const p = createPerTurnWrites();

    const env = await dispatchRecordReading(
      {
        tool_call_id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: '',
        },
      },
      ctx(session, p)
    );

    // Pre-fix this was `{ok:false, error:{code:'wrong_board'}}` — validateBoardScope
    // compared '' against 'sub-b' — even though every routing helper would have
    // put the write on 'sub-b' quite happily.
    expect(body(env).ok).toBe(true);
    expect(session.stateSnapshot.circuits['sub-b::3'].measured_zs_ohm).toBe('0.42');
    // The accumulator key is the UNSCOPED one, identical to an omitted board_id.
    // (`encodeReadingKey` already folds '' onto '' itself, so the key alone is
    // not discriminating — the entry's OUTWARD boardId is. Pre-fix it carried
    // the literal empty string, which the bundler's `!= null` omit-guard then
    // emitted onto the wire as `board_id: ""` for a client to make sense of.)
    const key = encodeReadingKey('measured_zs_ohm', 3, undefined);
    expect(p.readings.has(key)).toBe(true);
    expect(p.readings.get(key).boardId).toBeUndefined();
  });

  test('clear_reading clears on the current board instead of rejecting', async () => {
    const session = makeSession({
      'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: '0.42' },
    });
    const p = createPerTurnWrites();

    const env = await dispatchClearReading(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'wrong circuit', board_id: '' },
      },
      ctx(session, p)
    );

    expect(body(env).ok).toBe(true);
    expect(session.stateSnapshot.circuits['sub-b::3'].measured_zs_ohm ?? null).toBeNull();
  });

  test('calculate_zs computes against the current board instead of board_not_found', async () => {
    const session = makeSession(
      { 'sub-b::3': { board_id: 'sub-b', circuit: 3, r1_r2_ohm: '0.30' } },
      {
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-b',
            designation: 'DB-2',
            board_type: 'sub_distribution',
            parent_board_id: 'main',
            ze: '0.20',
          },
        ],
      }
    );
    const p = createPerTurnWrites();

    const env = await dispatchCalculateZs(
      {
        tool_call_id: 'z1',
        name: 'calculate_zs',
        input: { circuit_ref: 3, source_turn_id: 't1', board_id: '' },
      },
      ctx(session, p)
    );

    const out = body(env);
    // Pre-fix: validateCalculateBoardTarget's `?? currentBoardId` is a `== null`
    // guard, so '' survived as a phantom EXPLICIT target and came back
    // `board_not_found` — a reading the inspector asked for, silently not computed.
    expect(out.ok).toBe(true);
    expect(out.computed).toEqual([{ circuit_ref: 3, field: 'measured_zs_ohm', value: '0.50' }]);
  });

  test('set_field_for_all_circuits fills the current board, and `*` still broadcasts', async () => {
    const session = makeSession({
      'sub-b::3': { board_id: 'sub-b', circuit: 3, circuit_designation: 'Sockets' },
      // The main board's circuits live at the LEGACY bare-numeric key — that
      // dual-shape namespace is `getCircuitBucket`'s whole reason for existing.
      1: { circuit: 1, circuit_designation: 'Lights' },
    });
    const p = createPerTurnWrites();

    const env = await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'b1',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.44',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: '',
        },
      },
      ctx(session, p)
    );

    expect(body(env).ok).toBe(true);
    expect(session.stateSnapshot.circuits['sub-b::3'].measured_zs_ohm).toBe('0.44');
    // Scoped to the current board only — normalisation makes '' behave like an
    // omitted key, NOT like the '*' broadcast.
    expect(session.stateSnapshot.circuits[1].measured_zs_ohm ?? null).toBeNull();

    // …and the broadcast sentinel is untouched by the normaliser.
    const session2 = makeSession({
      'sub-b::3': { board_id: 'sub-b', circuit: 3, circuit_designation: 'Sockets' },
      // The main board's circuits live at the LEGACY bare-numeric key — that
      // dual-shape namespace is `getCircuitBucket`'s whole reason for existing.
      1: { circuit: 1, circuit_designation: 'Lights' },
    });
    const p2 = createPerTurnWrites();
    await dispatchSetFieldForAllCircuits(
      {
        tool_call_id: 'b2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.44',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: '*',
        },
      },
      ctx(session2, p2)
    );
    expect(session2.stateSnapshot.circuits['sub-b::3'].measured_zs_ohm).toBe('0.44');
    expect(session2.stateSnapshot.circuits[1].measured_zs_ohm).toBe('0.44');
  });

  test('mark_distribution_circuit resolves the SOURCE board instead of source_board_not_found', async () => {
    const session = makeSession({
      'sub-b::3': { board_id: 'sub-b', circuit: 3, circuit_designation: 'Submain' },
    });
    const p = createPerTurnWrites();

    const env = await dispatchMarkDistributionCircuit(
      {
        tool_call_id: 'm1',
        name: 'mark_distribution_circuit',
        input: { circuit: 3, feeds_board_id: 'main', source_turn_id: 't1', board_id: '' },
      },
      ctx(session, p)
    );

    expect(body(env).ok).toBe(true);
    expect(session.stateSnapshot.circuits['sub-b::3'].is_distribution_circuit).toBe('yes');
    // The emitted wire op names the RESOLVED source board, so iOS doesn't have
    // to re-derive it — and it must be the current board, never ''.
    const op = p.boardOps.find((o) => o.op === 'mark_distribution_circuit');
    expect(op.source_board_id).toBe('sub-b');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('dialogue-script drain — one normalisation covers all four read sites', () => {
  test('a seeded script write with board_id:"" is backfilled onto the per-turn writes', async () => {
    // Current board is MAIN here, so the seeded value lands on the legacy
    // bare-numeric key — which is the one namespace the drain's bucket lookup
    // resolves to once the empty id is normalised away. Pre-fix the lookup
    // built `''::4`, found nothing, and silently skipped the backfill: the
    // value reached the snapshot and the engine's own WS push but never
    // `extracted_readings`, so every downstream consumer saw a write-shaped
    // silence. That skip is exactly what the backfill exists to prevent.
    const session = makeSession(
      { 4: { circuit: 4, circuit_designation: 'Ring' } },
      { currentBoardId: 'main' }
    );
    const p = createPerTurnWrites();

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
          board_id: '',
        },
      },
      { ...ctx(session, p), ws: { send() {}, readyState: 1 } }
    );

    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.32');
    // The drain reads input.board_id four separate ways (bucket lookup, seeded
    // effective board, key encoding, outward boardId). Normalising once at the
    // top is what stops them disagreeing.
    const key = encodeReadingKey('ring_r1_ohm', 4, undefined);
    expect(p.readings.has(key)).toBe(true);
    expect(p.readings.get(key).boardId).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('auto-resolve writes are routed through the normaliser', () => {
  test("an auto-resolved record_reading carrying board_id:'' writes to the current board", async () => {
    // The hook's injection gate is a bare `!= null`, so '' IS injected into the
    // synthetic input. It is normalised by the DISPATCHER, not by the hook —
    // normalising in the hook would also normalise the exempt board dispatchers.
    const session = makeSession({ 'sub-b::2': { board_id: 'sub-b', circuit: 2 } });
    const p = createPerTurnWrites();
    const hook = createAutoResolveWriteHook(session, mockLogger(), 't1', p);

    const result = await hook(
      {
        tool: 'record_reading',
        field: 'rcd_time_ms',
        circuit: 2,
        value: '26',
        confidence: 1.0,
        source_turn_id: 't1',
        board_id: '',
      },
      { toolCallId: 'toolu_ask' }
    );

    expect(result.ok).toBe(true);
    expect(session.stateSnapshot.circuits['sub-b::2'].rcd_time_ms).toBe('26');
    expect(p.readings.has(encodeReadingKey('rcd_time_ms', 2, undefined))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('loaded-barrel cache — an unscoped entry is reachable by its invalidations', () => {
  const SESSION_ID = 'a2mb-barrel';

  afterEach(() => {
    barrelCache.pruneForSession(SESSION_ID);
  });

  test("a board_id:'' entry is stored unscoped, so slot invalidation and the unboarded prune both find it", () => {
    // buildCacheKey already folds null and '' onto the same hashed byte, but the
    // ENTRY kept '' as a distinct value while every consumer compared with
    // `== null`. The result: a speculation cached from a legacy unscoped write
    // was unreachable by the very invalidations that stop stale audio being
    // served on a corrected reading.
    const cacheKey = barrelCache.buildCacheKey({
      sessionId: SESSION_ID,
      turnId: 't1',
      boardId: '',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'Zs on circuit three, nought point four two',
    });
    const entry = barrelCache.set({
      cacheKey,
      sessionId: SESSION_ID,
      turnId: 't1',
      boardId: '',
      field: 'measured_zs_ohm',
      circuit: 3,
      expandedText: 'Zs on circuit three, nought point four two',
      correlationId: 'corr-1',
    });
    expect(entry.boardId).toBeNull();

    // A clear/re-record of the same slot arrives with NO board scope; pre-fix
    // this compared null against '' and invalidated nothing.
    expect(
      barrelCache.invalidateBySlot(SESSION_ID, {
        boardId: null,
        field: 'measured_zs_ohm',
        circuit: 3,
      })
    ).toBe(1);
  });

  test("add_board prunes a board_id:'' entry as unboarded", () => {
    const cacheKey = barrelCache.buildCacheKey({
      sessionId: SESSION_ID,
      turnId: 't2',
      boardId: '',
      field: 'r1_r2_ohm',
      circuit: 5,
      expandedText: 'R one R two on five is nought point three',
    });
    barrelCache.set({
      cacheKey,
      sessionId: SESSION_ID,
      turnId: 't2',
      boardId: '',
      field: 'r1_r2_ohm',
      circuit: 5,
      expandedText: 'R one R two on five is nought point three',
      correlationId: 'corr-2',
    });

    // add_board may have re-attributed pre-existing unboarded readings, so their
    // cached audio references a slot identity that no longer holds.
    expect(barrelCache.pruneSessionUnboardedEntries(SESSION_ID)).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('EXEMPT dispatchers — an injected empty board id must still REJECT', () => {
  // These three pins are the reason the boundary is enumerated rather than
  // blanket. Normalising here would convert "refuse to act on an unaddressable
  // board" into "act on whatever board is current" — for a selection, a
  // destructive clear, and an authoritative board write respectively.

  test('select_board rejects "" as invalid_board_id', async () => {
    const session = makeSession();
    const p = createPerTurnWrites();
    const env = await dispatchSelectBoard(
      { tool_call_id: 's1', name: 'select_board', input: { board_id: '', source_turn_id: 't1' } },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('invalid_board_id');
    expect(session.stateSnapshot.currentBoardId).toBe('sub-b');
  });

  test('clear_board_reading rejects "" as wrong_board (the A1a destructive-clear contract)', async () => {
    const session = makeSession({}, { boards: [{ id: 'main', designation: 'DB-1', ze: '0.35' }] });
    session.stateSnapshot.currentBoardId = 'main';
    const p = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      {
        tool_call_id: 'cb1',
        name: 'clear_board_reading',
        input: { field: 'ze', reason: 'wrong board', source_turn_id: 't1', board_id: '' },
      },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('wrong_board');
    // The value the clear would have destroyed is still there.
    expect(session.stateSnapshot.boards[0].ze).toBe('0.35');
  });

  test('record_board_reading rejects "" as wrong_board (same reject-before-mutate guard)', async () => {
    const session = makeSession({}, { boards: [{ id: 'main', designation: 'DB-1' }] });
    session.stateSnapshot.currentBoardId = 'main';
    const p = createPerTurnWrites();
    const env = await dispatchRecordBoardReading(
      {
        tool_call_id: 'rb1',
        name: 'record_board_reading',
        input: {
          field: 'ze',
          value: '0.28',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: '',
        },
      },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.boards[0].ze ?? null).toBeNull();
    // Nothing was stamped onto the per-turn accumulator either — the guard runs
    // before any effective-slot attachment.
    expect(p.boardReadings.size).toBe(0);
  });
});
