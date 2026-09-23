/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — acceptance 3: the bulk half.
 *
 * TWO CHANGES, AND THE SECOND IS WHY THE FIRST IS SAFE.
 *
 * `set_field_for_all_circuits {value: ""}` used to BE the bulk-clear idiom,
 * and it was the widest silent clear in the product: nothing is read back per
 * circuit, so fourteen certificate values could empty while an inspector in
 * AirPods heard nothing at all. It is now rejected.
 *
 * But that write existed for a reason — per-circuit model calls once stopped
 * halfway through a 14-circuit operation (session DC946608), which is exactly
 * why the bulk tool was built. Removing the idiom without a replacement would
 * reintroduce that failure. So `clear_field_for_all_circuits` takes the job:
 * server-iterated, one grouped spoken line, partial failures disclosed.
 *
 * The REGISTRATION test is not a formality. An unregistered name returns
 * `unknown_tool` at the dispatcher barrel, so a tool advertised to the model
 * but missing from `WRITE_DISPATCHERS` would tell it the only supported
 * bulk-clear route does not exist.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher, WRITE_DISPATCHERS } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites, BULK_OUTCOME_CALL_ID } from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { TOOL_SCHEMAS } from '../extraction/stage6-tool-schemas.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** 14 active circuits, every one carrying a reference method to clear. */
function build14(overrides = {}) {
  const circuits = { 0: {} };
  for (let n = 1; n <= 14; n += 1) {
    circuits[n] = { circuit_designation: `Circuit ${n}`, ref_method: 'C', ...(overrides[n] ?? {}) };
  }
  return { sessionId: 's-bulk-clear', stateSnapshot: { circuits }, extractedObservations: [] };
}

async function dispatch(session, writes, call, ctx = {}) {
  const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, ctx);
  return d(call, ctx);
}

const bulkClear = (input = {}) => ({
  tool_call_id: 'tu_bulkclear',
  name: 'clear_field_for_all_circuits',
  input: { field: 'ref_method', source_turn_id: 't1', scope: 'all', ...input },
});

function confirmations(writes, session) {
  const result = bundleToolCallsIntoResult(writes, null, {
    turnId: 'turn-1',
    session,
    snapshot: session.stateSnapshot,
    confirmationsEnabled: true,
  });
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 3a — the empty bulk write is rejected and speaks once', () => {
  test('a blank bulk value is rejected, writes nothing, and stages exactly one notice', async () => {
    const session = build14();
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, {
      tool_call_id: 'tu_blank',
      name: 'set_field_for_all_circuits',
      input: {
        field: 'ref_method',
        value: '',
        confidence: 0.95,
        source_turn_id: 't1',
        scope: 'all',
      },
    });

    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error.code).toBe('empty_write_not_allowed');
    expect(body.error.clear_tool).toBe('clear_field_for_all_circuits');
    expect(writes.readings.size).toBe(0);
    expect(session.stateSnapshot.circuits[7].ref_method).toBe('C');

    // ONE notice for the whole scope, never fourteen.
    const staged = writes.mandatoryNotices.filter((n) => n.family === 'empty_bulk_write_blocked');
    expect(staged).toHaveLength(1);
    expect(staged[0].friendly).toContain('all circuits');
    expect(staged[0].friendly).toContain('Reference Method');
    expect(typeof body.rejection_ref).toBe('string');
  });

  test('the refusal is COVERED, which is what suppresses the generic apology', async () => {
    // `rejectedSetFullyCovered` reads call-level coverage. Without it an
    // all-rejected turn speaks the specific refusal AND "I didn't catch that",
    // which contradict each other.
    const session = build14();
    const writes = createPerTurnWrites();
    await dispatch(session, writes, {
      tool_call_id: 'tu_cov',
      name: 'set_field_for_all_circuits',
      input: {
        field: 'ref_method',
        value: '',
        confidence: 0.95,
        source_turn_id: 't1',
        scope: 'all',
      },
    });
    const [notice] = writes.mandatoryNotices;
    expect(notice.coveredToolCallIds).toEqual(['tu_cov']);
  });

  test('a blank is_distribution_circuit bulk keeps the structural refusal, with no bulk-clear hint', async () => {
    const session = build14();
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, {
      tool_call_id: 'tu_struct',
      name: 'set_field_for_all_circuits',
      input: {
        field: 'is_distribution_circuit',
        value: '',
        confidence: 0.95,
        source_turn_id: 't1',
      },
    });
    expect(JSON.parse(res.content).error.code).not.toBe('empty_write_not_allowed');
    expect(res.content).not.toContain('clear_field_for_all_circuits');
    expect(
      writes.mandatoryNotices.filter((n) => n.family === 'empty_bulk_write_blocked')
    ).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 3b — clear_field_for_all_circuits', () => {
  test('the tool is REACHABLE — registered, and never answered with unknown_tool', async () => {
    expect(typeof WRITE_DISPATCHERS.clear_field_for_all_circuits).toBe('function');
    expect(TOOL_SCHEMAS.some((t) => t.name === 'clear_field_for_all_circuits')).toBe(true);
    const session = build14();
    const res = await dispatch(session, createPerTurnWrites(), bulkClear());
    expect(res.content).not.toContain('unknown_tool');
  });

  test('14 circuits → 14 field_corrected on the wire, ONE grouped spoken line', async () => {
    const session = build14();
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, bulkClear());

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).cleared).toHaveLength(14);
    // The wire shape is unchanged: one correction per circuit.
    const corrections = writes.fieldCorrections.filter((c) => c.reason === 'clear_reading');
    expect(corrections).toHaveLength(14);
    for (const c of corrections) expect(c[BULK_OUTCOME_CALL_ID]).toBe('tu_bulkclear');
    // Speech is ONE line.
    const spoken = confirmations(writes, session).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('Circuits 1 to 14, reference method cleared');
    expect(spoken[0].circuits).toHaveLength(14);
    expect(spoken[0].dedupe_token).toBe('p4ack_turn-1_tu_bulkclear');
    // Every circuit is actually empty.
    for (let n = 1; n <= 14; n += 1)
      expect(session.stateSnapshot.circuits[n].ref_method).toBeFalsy();
  });

  test('two ALREADY-EMPTY circuits are counted as cleared, not as failures', async () => {
    const session = build14({ 3: { ref_method: '' }, 9: { ref_method: '' } });
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, bulkClear());
    const body = JSON.parse(res.content);
    expect(body.failed).toEqual([]);
    expect(body.already_empty.sort((a, b) => a - b)).toEqual([3, 9]);
    expect(body.cleared).toHaveLength(12);
    // Nothing changed on those two, so no wire event and no spoken member.
    expect(writes.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(12);
    expect(writes.partialFailureNotices).toHaveLength(0);
  });

  test('one circuit failing → 13 cleared and an explicit disclosure line', async () => {
    // A registry/bucket disagreement: `listCircuitRefsInBoard` offers the ref
    // but no record resolves. That is the one class that would otherwise be
    // silent, and the inspector asked for a scope.
    const session = build14();
    delete session.stateSnapshot.circuits[6];
    session.stateSnapshot.circuits[6] = null;
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, bulkClear());
    const body = JSON.parse(res.content);
    expect(body.cleared).toHaveLength(13);
    expect(body.failed).toEqual([{ circuit_ref: 6, reason: 'circuit_not_found' }]);
    expect(writes.partialFailureNotices).toHaveLength(1);
    expect(writes.partialFailureNotices[0].reason).toBe('circuit_not_found');
  });

  test('a single-circuit sweep is NOT grouped — the per-circuit line carries the designation', async () => {
    const session = build14();
    for (let n = 2; n <= 14; n += 1) session.stateSnapshot.circuits[n].ref_method = '';
    const writes = createPerTurnWrites();
    await dispatch(session, writes, bulkClear());
    const spoken = confirmations(writes, session).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].circuit).toBe(1);
    expect(spoken[0].text).toContain('reference method cleared');
    expect(spoken[0].text).not.toContain('Circuits');
  });

  test('exclude_circuits and the scope selector narrow the sweep', async () => {
    const session = build14({ 4: { circuit_designation: 'Spare' } });
    const writes = createPerTurnWrites();
    const res = await dispatch(
      session,
      writes,
      bulkClear({ exclude_circuits: [2, 5], spare_policy: 'exclude' })
    );
    const body = JSON.parse(res.content);
    expect(body.cleared).not.toContain(2);
    expect(body.cleared).not.toContain(5);
    expect(body.cleared).not.toContain(4); // spare
    expect(session.stateSnapshot.circuits[2].ref_method).toBe('C');
    expect(session.stateSnapshot.circuits[4].ref_method).toBe('C');
  });

  test('a non-clearable field is refused with the SAME code clear_reading uses', async () => {
    const session = build14();
    const res = await dispatch(
      session,
      createPerTurnWrites(),
      bulkClear({ field: 'is_distribution_circuit' })
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('field_not_clearable');
  });

  test("a board_id:'*' sweep over two boards speaks two DISTINCT lines with distinct tokens", async () => {
    // Codex review cycle 1: two boards each holding circuits 1 and 2 rendered
    // the same text AND the same `p4ack_<turn>_<call>` token, so the client's
    // dedupe could drop one board's only spoken confirmation.
    const session = {
      sessionId: 's-bulk-2b',
      stateSnapshot: {
        circuits: {
          0: {},
          1: { circuit_designation: 'A', ref_method: 'C' },
          2: { circuit_designation: 'B', ref_method: 'C' },
          'garage::1': {
            circuit: 1,
            board_id: 'garage',
            circuit_designation: 'G1',
            ref_method: 'C',
          },
          'garage::2': {
            circuit: 2,
            board_id: 'garage',
            circuit_designation: 'G2',
            ref_method: 'C',
          },
        },
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'garage', board_type: 'sub_distribution' },
        ],
        currentBoardId: 'main',
      },
      extractedObservations: [],
    };
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, bulkClear({ board_id: '*' }));
    expect(JSON.parse(res.content).cleared).toHaveLength(4);
    // The wire is still one correction per cleared circuit.
    expect(writes.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(4);
    const result = bundleToolCallsIntoResult(writes, null, {
      turnId: 'turn-1',
      session,
      snapshot: session.stateSnapshot,
      stateSnapshot: session.stateSnapshot,
      confirmationsEnabled: true,
    });
    const spoken = (result.confirmations ?? []).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(2);
    expect(new Set(spoken.map((c) => c.text)).size).toBe(2);
    expect(new Set(spoken.map((c) => c.dedupe_token)).size).toBe(2);
    expect(spoken.map((c) => c.text).sort()).toEqual([
      'Circuits 1, 2, reference method cleared on board 1',
      'Circuits 1, 2, reference method cleared on board 2',
    ]);
  });

  test("a board_id:'*' sweep clearing ONE same-named circuit per board names each board", async () => {
    // Codex review cycle 3: one-member buckets are not grouped, so the
    // per-circuit line had no board clause and both boards spoke the
    // identical "Circuit 1, reference method cleared".
    const session = {
      sessionId: 's-bulk-2b-single',
      stateSnapshot: {
        circuits: {
          0: {},
          1: { circuit_designation: 'Lights', ref_method: 'C' },
          'garage::1': {
            circuit: 1,
            board_id: 'garage',
            circuit_designation: 'Lights',
            ref_method: 'C',
          },
        },
        boards: [
          { id: 'main', board_type: 'main' },
          { id: 'garage', board_type: 'sub_distribution' },
        ],
        currentBoardId: 'main',
      },
      extractedObservations: [],
    };
    const writes = createPerTurnWrites();
    await dispatch(session, writes, bulkClear({ board_id: '*' }));
    const result = bundleToolCallsIntoResult(writes, null, {
      turnId: 'turn-1',
      session,
      snapshot: session.stateSnapshot,
      stateSnapshot: session.stateSnapshot,
      confirmationsEnabled: true,
    });
    const spoken = (result.confirmations ?? []).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(2);
    expect(new Set(spoken.map((c) => c.text)).size).toBe(2);
    // The prefix is whatever the designation lookup yields (this direct
    // bundler call passes no designation map, so "Circuit 1"); the property
    // under test is the board suffix, which is what makes the two distinct.
    const texts = spoken.map((c) => c.text).sort();
    expect(texts[0]).toMatch(/reference method cleared on board 1$/);
    expect(texts[1]).toMatch(/reference method cleared on board 2$/);
  });

  test('a SINGLE-board per-circuit clear line is unchanged — no board clause', async () => {
    const session = build14();
    for (let n = 2; n <= 14; n += 1) session.stateSnapshot.circuits[n].ref_method = '';
    const writes = createPerTurnWrites();
    await dispatch(session, writes, bulkClear());
    const spoken = confirmations(writes, session).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).not.toContain('on board');
  });

  test('an UNKNOWN board_id is rejected, never reported as a successful empty sweep', async () => {
    // Codex review cycle 1: it used to return {ok:true, cleared:[]} while the
    // value the inspector asked to remove stayed put.
    const session = build14();
    session.stateSnapshot.boards = [{ id: 'main', board_type: 'main' }];
    session.stateSnapshot.currentBoardId = 'main';
    const writes = createPerTurnWrites();
    const res = await dispatch(session, writes, bulkClear({ board_id: 'does-not-exist' }));
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('board_not_found');
    expect(session.stateSnapshot.circuits[1].ref_method).toBe('C');
  });

  test('two bulk clears in one turn stay TWO spoken lines', async () => {
    // They are two statements about two scopes; collapsing them would let one
    // sweep stand in for another.
    const session = build14({ 1: { r1_r2_ohm: '0.4' }, 2: { r1_r2_ohm: '0.5' } });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, {});
    await d(bulkClear(), {});
    await d({ ...bulkClear({ field: 'r1_r2_ohm' }), tool_call_id: 'tu_second' }, {});
    const spoken = confirmations(writes, session).filter((c) => c.field === 'field_cleared');
    expect(spoken).toHaveLength(2);
    expect(new Set(spoken.map((s) => s.dedupe_token)).size).toBe(2);
  });
});
