/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — acceptance 1, 2, 4 and 7: the
 * blank predicate at every model-controlled mutation boundary.
 *
 * WHAT THESE TESTS ARE DEFENDING. On 17 September the model, twice rejected
 * on `BS 3871`, wrote `ocpd_bs_en = ""` and the dispatcher accepted it. A
 * blank write produces no read-back worth hearing, so a legally-significant
 * certificate value emptied while the inspector — hands-free, in AirPods —
 * heard nothing. Every case below is one boundary that could do that again.
 *
 * TWO THINGS ARE ASSERTED EVERYWHERE, not one: the write is REJECTED, and the
 * rejection is AUDIBLE. A refusal nobody hears is the same defect wearing a
 * different code.
 *
 * The EXEMPTION cases matter as much as the rejections. A structural field
 * already has a truthful refusal naming the route that works
 * (`mark_distribution_circuit`), and `clear_reading` cannot clear it — so a
 * blank there must keep that refusal and must never be told to "say clear".
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import {
  validateRecordReading,
  BLANK_WRITE_EXEMPT_READING_FIELDS,
} from '../extraction/stage6-dispatch-validation.js';
import { normaliseDialogueSlotWrite } from '../extraction/dialogue-engine/helpers/dialogue-slot-normalise.js';
import { ALL_DIALOGUE_SCHEMAS } from '../extraction/dialogue-engine/index.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';
import { BOARD_FIELD_ENUM } from '../extraction/stage6-tool-schemas.js';
import { boardNoticeSlot, boardFieldLabel } from '../extraction/stage6-blank-write-notices.js';
import {
  STRUCTURAL_READING_FIELDS,
  UNROUTABLE_READING_FIELDS,
} from '../extraction/client-routable-reading-fields.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(extra = {}) {
  return {
    sessionId: 's-c3-boundaries',
    stateSnapshot: {
      circuits: {
        0: { earth_loop_impedance_ze: '0.35', manufacturer: 'Wylex' },
        3: { circuit_designation: 'Upstairs Lighting', ocpd_bs_en: 'BS EN 60898', phase: 'L1' },
      },
      observations: [],
      ...extra,
    },
    extractedObservations: [],
  };
}

function notices(writes, family) {
  return writes.mandatoryNotices.filter((n) => n.family === family);
}

function run(session, writes, call, ctx = {}) {
  const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, ctx);
  return d(call, ctx);
}

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 1 — record_reading', () => {
  test('a blank and a whitespace value are both rejected, mutate nothing, and speak', async () => {
    for (const [i, value] of ['', '  '].entries()) {
      const session = makeSession();
      const writes = createPerTurnWrites();
      const res = await run(session, writes, {
        tool_call_id: `tu_${i}`,
        name: 'record_reading',
        input: { field: 'ocpd_bs_en', circuit: 3, value, confidence: 0.9, source_turn_id: 't1' },
      });

      expect(res.is_error).toBe(true);
      const body = JSON.parse(res.content);
      expect(body.error.code).toBe('empty_write_not_allowed');
      expect(body.error.clear_tool).toBe('clear_reading');
      // Zero mutation: the value the certificate carries is untouched.
      expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS EN 60898');
      expect(writes.readings.size).toBe(0);
      // Audible, and with a ref the model can echo.
      expect(notices(writes, 'empty_write_blocked')).toHaveLength(1);
      expect(typeof body.rejection_ref).toBe('string');
      expect(writes.rejections).toHaveLength(1);
    }
  });

  test('the spoken line says what the slot STILL holds, not what was rejected', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await run(session, writes, {
      tool_call_id: 'tu_held',
      name: 'record_reading',
      input: { field: 'ocpd_bs_en', circuit: 3, value: '', confidence: 0.9, source_turn_id: 't1' },
    });
    const [notice] = notices(writes, 'empty_write_blocked');
    expect(notice.friendly).toContain('circuit 3');
    expect(notice.friendly).toContain('still BS EN 60898');
  });

  test('an EMPTY slot says "still blank" rather than claiming a value', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await run(session, writes, {
      tool_call_id: 'tu_blank',
      name: 'record_reading',
      input: { field: 'ref_method', circuit: 3, value: '', confidence: 0.9, source_turn_id: 't1' },
    });
    expect(notices(writes, 'empty_write_blocked')[0].friendly).toContain('still blank');
  });

  test('clear_reading still succeeds on the same slot, with one read-back', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_clear',
      name: 'clear_reading',
      input: { field: 'ocpd_bs_en', circuit: 3, reason: 'user_correction' },
    });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).ok).toBe(true);
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBeFalsy();
    expect(writes.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(1);
  });

  test.each([['is_distribution_circuit'], ['feeds_board_id']])(
    'a blank %s keeps the EXISTING structural refusal and never names clear_reading',
    async (field) => {
      const session = makeSession();
      const writes = createPerTurnWrites();
      const res = await run(session, writes, {
        tool_call_id: 'tu_struct',
        name: 'record_reading',
        input: { field, circuit: 3, value: '', confidence: 0.9, source_turn_id: 't1' },
      });
      const body = JSON.parse(res.content);
      expect(body.error.code).not.toBe('empty_write_not_allowed');
      expect(res.content).not.toContain('clear_reading');
      expect(notices(writes, 'empty_write_blocked')).toHaveLength(0);
      // The shipped structural/mark-distribution refusal still owns it.
      expect(writes.mandatoryNotices.length).toBeGreaterThan(0);
    }
  );

  test('the exemption set is the IMPORTED union, not a retyped list', () => {
    // The point of importing is that a schema change to either manifest moves
    // this set automatically. Assert membership of one representative from
    // each side rather than pinning the whole set, which would re-introduce
    // exactly the hand-maintained copy the import exists to avoid.
    expect(BLANK_WRITE_EXEMPT_READING_FIELDS.has('board_type')).toBe(true); // structural
    expect(BLANK_WRITE_EXEMPT_READING_FIELDS.has('circuit_ref')).toBe(true); // clear-excluded
    expect(BLANK_WRITE_EXEMPT_READING_FIELDS.has('ocpd_bs_en')).toBe(false);
  });

  test('a blank on an exempt field returns null from the validator, not a rejection', () => {
    const snapshot = { circuits: { 3: {} } };
    expect(
      validateRecordReading(
        { field: 'is_distribution_circuit', circuit: 3, value: '', confidence: 1 },
        snapshot
      )
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 2 — record_board_reading', () => {
  const capableCtx = { hasBoardClearV1: true };

  test('a blank writable, clearable board field is rejected and speaks', async () => {
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(
      session,
      writes,
      {
        tool_call_id: 'tu_b',
        name: 'record_board_reading',
        input: { field: 'manufacturer', value: '', confidence: 0.9, source_turn_id: 't1' },
      },
      capableCtx
    );
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error.code).toBe('empty_write_not_allowed');
    expect(body.error.clear_tool).toBe('clear_board_reading');
    expect(notices(writes, 'empty_write_blocked')).toHaveLength(1);
    expect(typeof body.rejection_ref).toBe('string');
  });

  test('clear_board_reading still succeeds on that field', async () => {
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(
      session,
      writes,
      {
        tool_call_id: 'tu_bc',
        name: 'clear_board_reading',
        input: { field: 'manufacturer', reason: 'user_correction' },
      },
      capableCtx
    );
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).ok).toBe(true);
  });

  test('a blank board_type keeps the existing structural refusal', async () => {
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(
      session,
      writes,
      {
        tool_call_id: 'tu_bt',
        name: 'record_board_reading',
        input: { field: 'board_type', value: '', confidence: 0.9, source_turn_id: 't1' },
      },
      capableCtx
    );
    expect(JSON.parse(res.content).error.code).toBe('structural_field_not_recordable');
    expect(notices(writes, 'empty_write_blocked')).toHaveLength(0);
  });

  test('a blank sub_main_cable_material keeps the existing unroutable refusal', async () => {
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(
      session,
      writes,
      {
        tool_call_id: 'tu_sm',
        name: 'record_board_reading',
        input: {
          field: 'sub_main_cable_material',
          value: '',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      capableCtx
    );
    expect(JSON.parse(res.content).error.code).toBe('client_route_unavailable');
    expect(notices(writes, 'empty_write_blocked')).toHaveLength(0);
    expect(notices(writes, 'unroutable_board_reading')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('board refusal labels are distinct across every reachable board field', () => {
  // A board refusal's rendered bytes are the field label plus, for a
  // board-scoped field only, the board ordinal. Two DISTINCT slots that
  // shared a label would render identical bytes into the clients' 30 s text
  // dedupe, and the second refusal would be silent. Codex review cycle 3
  // raised `main_earth_conductor_csa` / `earthing_conductor_csa`, which share
  // "main earth"; the first is not in `BOARD_FIELD_ENUM`, so
  // `record_board_reading` refuses it as off-schema before the blank check
  // and the pair is unreachable. This enumerates EVERY reachable field rather
  // than arguing from one pair, so a schema change that creates a real
  // collision fails here.
  function labelCollisions(fields) {
    const byLabel = new Map();
    for (const f of fields) {
      if (STRUCTURAL_READING_FIELDS.has(f) || UNROUTABLE_READING_FIELDS.has(f)) continue;
      const slot = boardNoticeSlot(f, 'main');
      const label = boardFieldLabel(f);
      if (!byLabel.has(label)) byLabel.set(label, new Set());
      byLabel.get(label).add(`${slot.field}|${slot.boardId}`);
    }
    return [...byLabel.entries()].filter(([, slots]) => slots.size > 1).map(([l]) => l);
  }

  test('no two distinct reachable board slots share a spoken label', () => {
    expect(labelCollisions(BOARD_FIELD_ENUM)).toEqual([]);
  });

  test('KNOWN-BAD: admitting the legacy alias to the enum WOULD collide', () => {
    // Same function, same input shape, one injected field — proves the empty
    // result above is a finding and not an instrument that cannot fail.
    expect(labelCollisions([...BOARD_FIELD_ENUM, 'main_earth_conductor_csa'])).toEqual([
      'main earth',
    ]);
  });

  test('the legacy alias is refused as off-schema before the blank check', async () => {
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_alias',
      name: 'record_board_reading',
      input: {
        field: 'main_earth_conductor_csa',
        value: '',
        confidence: 0.9,
        source_turn_id: 't1',
      },
    });
    expect(JSON.parse(res.content).error.code).not.toBe('empty_write_not_allowed');
    expect(notices(writes, 'empty_write_blocked')).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 4 — create_circuit and rename_circuit', () => {
  test('a blank phase on rename is rejected with the PHASE line, never "say its name"', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_rp',
      name: 'rename_circuit',
      input: { from_ref: 3, circuit_ref: 3, phase: '' },
    });
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error).toMatchObject({ code: 'empty_write_not_allowed', field: 'phase' });
    expect(session.stateSnapshot.circuits[3].phase).toBe('L1');
    expect(session.stateSnapshot.circuits[3].circuit_designation).toBe('Upstairs Lighting');
    const [notice] = notices(writes, 'rename_blocked');
    expect(notice.route).toBe('rename_blocked_phase');
    expect(notice.friendly).toContain("circuit 3's phase");
    expect(notice.friendly).toContain('still L1');
  });

  test('a whitespace designation on rename is rejected with the DESIGNATION line', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_rd',
      name: 'rename_circuit',
      input: { from_ref: 3, circuit_ref: 3, designation: '  ' },
    });
    expect(JSON.parse(res.content).error.field).toBe('designation');
    expect(session.stateSnapshot.circuits[3].circuit_designation).toBe('Upstairs Lighting');
    const [notice] = notices(writes, 'rename_blocked');
    expect(notice.route).toBe('rename_blocked_designation');
    expect(notice.friendly).toContain('still Upstairs Lighting');
  });

  test('create with a good designation and a blank phase gets the phase line, naming the designation', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_cp',
      name: 'create_circuit',
      input: { circuit_ref: 4, designation: 'Cooker', phase: '' },
    });
    expect(res.is_error).toBe(true);
    expect(session.stateSnapshot.circuits[4]).toBeUndefined();
    const [notice] = notices(writes, 'create_blocked');
    expect(notice.route).toBe('create_blocked_phase');
    expect(notice.friendly).toContain('Cooker');
    expect(notice.friendly).toContain('phase');
  });

  test('a renumber-plus-blank-phase rename is rejected WHOLE — no partial rekey', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await run(session, writes, {
      tool_call_id: 'tu_rr',
      name: 'rename_circuit',
      input: { from_ref: 3, circuit_ref: 9, phase: '' },
    });
    expect(session.stateSnapshot.circuits[3]).toBeDefined();
    expect(session.stateSnapshot.circuits[9]).toBeUndefined();
  });

  test('a rename of circuit 2 beside a BLANK rename of circuit 3 leaves only circuit 3 refused', async () => {
    const session = makeSession();
    session.stateSnapshot.circuits[2] = { circuit_designation: 'Sockets' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, {});
    await d(
      {
        tool_call_id: 'tu_ok',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'Cooker' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_bad',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 3, designation: '' },
      },
      {}
    );
    const staged = notices(writes, 'rename_blocked');
    expect(staged).toHaveLength(1);
    expect(staged[0].friendly).toContain('circuit 3');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
  });

  test('create WITHOUT a designation is unchanged — omitted is not blank', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_nd',
      name: 'create_circuit',
      input: { circuit_ref: 4 },
    });
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[4]).toBeDefined();
    expect(notices(writes, 'create_blocked')).toHaveLength(0);
  });

  test('a rename and a create refusal on the same ref are DIFFERENT slots', async () => {
    // The key carries the op, so a blocked create of 4 and a blocked rename
    // from 4 do not coalesce into one notice — they are two statements.
    const session = makeSession();
    session.stateSnapshot.circuits[4] = { circuit_designation: 'Sockets' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, {});
    await d(
      {
        tool_call_id: 'tu_a',
        name: 'rename_circuit',
        input: { from_ref: 4, circuit_ref: 4, designation: '' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'create_circuit',
        input: { circuit_ref: 5, designation: '' },
      },
      {}
    );
    expect(notices(writes, 'rename_blocked')).toHaveLength(1);
    expect(notices(writes, 'create_blocked')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 7 — dialogue seeds, slot parsers, mark_distribution_circuit', () => {
  const ringSchema = ALL_DIALOGUE_SCHEMAS.find((s) => s.name === 'ring_continuity');

  test('a whitespace SEED is dropped, on a numeric field and a non-numeric one alike', () => {
    // The non-numeric case is the one a late check would miss: the numeric
    // short-circuit returns ok:true for every other field.
    expect(normaliseDialogueSlotWrite(ringSchema, 'ring_r1_ohm', '  ')).toEqual({
      ok: false,
      reason: 'seed_blank',
    });
    expect(normaliseDialogueSlotWrite(ringSchema, 'ocpd_bs_en', '')).toEqual({
      ok: false,
      reason: 'seed_blank',
    });
  });

  test('a real seed still passes', () => {
    expect(normaliseDialogueSlotWrite(ringSchema, 'ring_r1_ohm', '0.43', null)).toMatchObject({
      ok: true,
      value: '0.43',
    });
  });

  test('EVERY slot parser returns null on blank input — never an empty string', () => {
    // The dialogue engine's direct write path is exempt from the predicate BY
    // CONSTRUCTION, and this is the construction. A parser that returned ''
    // would write a blank through a path no dispatcher boundary guards.
    for (const schema of ALL_DIALOGUE_SCHEMAS) {
      for (const slot of schema.slots ?? []) {
        if (typeof slot.parse !== 'function') continue;
        for (const input of ['', '   ', '...', '!!']) {
          const parsed = slot.parse(input, {});
          const value = parsed && typeof parsed === 'object' ? parsed.value : parsed;
          expect(value === '' || value === '   ').toBe(false);
        }
      }
    }
  });

  test('a whitespace SEED is dropped but the SCRIPT STILL ENTERS', async () => {
    // The two halves matter separately. Dropping the seed is the blank-write
    // rule; entering the script is what keeps the turn useful — the slot is
    // simply asked, which is the outcome the inspector wanted anyway. Refusing
    // the whole call would turn a blank seed into a lost walk-through.
    const session = {
      sessionId: 's-c3-seed',
      stateSnapshot: { circuits: { 0: {}, 4: { circuit_designation: 'Ring Final' } } },
      extractedObservations: [],
      activeWs: null,
    };
    const writes = createPerTurnWrites();
    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_seed',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: 4,
          source_turn_id: 't1',
          reason: 'inspector dictated a ring reading',
          pending_writes: [{ field: 'ring_r1_ohm', value: '   ' }],
        },
      },
      { session, logger: mockLogger(), turnId: 'turn-1', round: 1, perTurnWrites: writes }
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).ok).toBe(true);
    // The script is running…
    expect(session.dialogueScriptState).toBeTruthy();
    // …and the blank never reached the certificate.
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBeUndefined();
    expect(writes.readings.size).toBe(0);
  });

  test('a REAL seed on the same path still writes', async () => {
    // The mirror of the case above: without it, a seed gate that rejected
    // everything would pass.
    const session = {
      sessionId: 's-c3-seed-ok',
      stateSnapshot: { circuits: { 0: {}, 4: { circuit_designation: 'Ring Final' } } },
      extractedObservations: [],
      activeWs: null,
    };
    const writes = createPerTurnWrites();
    await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_seed_ok',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: 4,
          source_turn_id: 't1',
          reason: 'inspector dictated a ring reading',
          pending_writes: [{ field: 'ring_r1_ohm', value: '0.43' }],
        },
      },
      { session, logger: mockLogger(), turnId: 'turn-1', round: 1, perTurnWrites: writes }
    );
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.43');
  });

  test('mark_distribution_circuit with a blank board id is out of scope by construction', async () => {
    // The plan's acceptance 7 predicted `feeds_board_not_found` here. The
    // SHIPPED code rejects one step earlier, at the `invalid_feeds_board_id`
    // shape gate (`stage6-dispatchers-board.js`, the non-empty-string check
    // that precedes board resolution), so a blank never reaches the lookup at
    // all. The plan's CONCLUSION holds and is what this test defends — a blank
    // id can never create a hierarchy link, so no blank-write rule is needed
    // on this tool — only the code it named was wrong. Asserted against source
    // rather than against the prediction; recorded in the execution log.
    const session = makeSession({
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    });
    const writes = createPerTurnWrites();
    const res = await run(session, writes, {
      tool_call_id: 'tu_md',
      name: 'mark_distribution_circuit',
      input: { circuit: 3, feeds_board_id: '' },
    });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('invalid_feeds_board_id');
    // The link is not made, and no blank-write notice is staged for it.
    expect(session.stateSnapshot.circuits[3].feeds_board_id).toBeUndefined();
    expect(notices(writes, 'empty_write_blocked')).toHaveLength(0);
  });
});
