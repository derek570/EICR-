/**
 * Stage 6 multi-board sprint Phase 6.3 — mark_distribution_circuit coverage.
 *
 * Locks: schema shape, happy paths under flag-on (composite key) and
 * flag-off (legacy numeric key), every rejection code, the STOP-SLICE
 * deviation from PLAN.md L577-583 (no forward-ref ask_user — Sonnet
 * must call add_board first), and boardOps wire emit shape.
 *
 * NOTE: forward-reference ask_user (when feeds_board_id doesn't yet exist)
 * is a STOP slice in PHASE6_PHASE7_AUTONOMOUS.md. This file's tests pin
 * the rejection contract today; the supervised slice that adds the
 * resolver flow will need to update the `feeds_board_not_found` assertion.
 */

import { jest } from '@jest/globals';
import { TOOL_SCHEMAS, getToolByName } from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession({ flagOn = false } = {}) {
  // Always restore env after the test — see beforeEach/afterEach below.
  if (flagOn) process.env.STAGE6_MULTI_BOARD = 'true';
  else delete process.env.STAGE6_MULTI_BOARD;

  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  // Add a sub-board so the dispatcher has a target it can resolve.
  snapshot.boards.push({
    id: 'sub-1',
    designation: 'Garage CU',
    board_type: 'sub_distribution',
  });
  return { sessionId: 's-mark-dc', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

beforeEach(() => {
  delete process.env.STAGE6_MULTI_BOARD;
});
afterEach(() => {
  delete process.env.STAGE6_MULTI_BOARD;
});

describe('mark_distribution_circuit schema', () => {
  test('exists in TOOL_SCHEMAS', () => {
    const tool = getToolByName('mark_distribution_circuit');
    expect(tool).toBeDefined();
    expect(TOOL_SCHEMAS.some((t) => t.name === 'mark_distribution_circuit')).toBe(true);
  });

  test('required is exactly [circuit, feeds_board_id]; board_id is optional', () => {
    const tool = getToolByName('mark_distribution_circuit');
    expect(tool.input_schema.required.sort()).toEqual(['circuit', 'feeds_board_id']);
    expect(tool.input_schema.required).not.toContain('board_id');
    expect(tool.input_schema.properties.board_id.type).toBe('string');
  });

  test('circuit is integer; feeds_board_id is string', () => {
    const tool = getToolByName('mark_distribution_circuit');
    expect(tool.input_schema.properties.circuit.type).toBe('integer');
    expect(tool.input_schema.properties.feeds_board_id.type).toBe('string');
  });

  test('additionalProperties:false', () => {
    const tool = getToolByName('mark_distribution_circuit');
    expect(tool.input_schema.additionalProperties).toBe(false);
  });
});

describe('dispatchMarkDistributionCircuit happy paths', () => {
  test('flag-off: marks legacy circuits[ref] bucket, emits boardOps with all 4 fields', async () => {
    const session = makeSession({ flagOn: false });
    // Seed circuit 4 on the legacy numeric key.
    session.stateSnapshot.circuits[4] = { designation: 'Sub-board feed' };

    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_mark_off',
        name: 'mark_distribution_circuit',
        input: { circuit: 4, feeds_board_id: 'sub-1' },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ ok: true });

    expect(session.stateSnapshot.circuits[4].is_distribution_circuit).toBe('yes');
    expect(session.stateSnapshot.circuits[4].feeds_board_id).toBe('sub-1');

    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0]).toEqual({
      op: 'mark_distribution_circuit',
      circuit_ref: 4,
      feeds_board_id: 'sub-1',
      source_board_id: 'main',
    });

    expect(toolCallRows(logger)[0]).toMatchObject({
      tool: 'mark_distribution_circuit',
      outcome: 'ok',
      input_summary: { circuit: 4, source_board_id: 'main', feeds_board_id: 'sub-1' },
    });
  });

  test('flag-on: marks composite-key bucket on the resolved board', async () => {
    const session = makeSession({ flagOn: true });
    // Seed circuit 4 on the composite key main::4.
    session.stateSnapshot.circuits['main::4'] = {
      board_id: 'main',
      circuit: 4,
      designation: 'Sub-board feed',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_mark_on',
        name: 'mark_distribution_circuit',
        input: { circuit: 4, feeds_board_id: 'sub-1' },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['main::4'].is_distribution_circuit).toBe('yes');
    expect(session.stateSnapshot.circuits['main::4'].feeds_board_id).toBe('sub-1');
    expect(writes.boardOps[0].source_board_id).toBe('main');
  });

  test('explicit board_id overrides currentBoardId', async () => {
    const session = makeSession({ flagOn: false });
    // currentBoardId stays at 'main' from ensureMultiBoardShape; we add a
    // second sub board so the explicit board_id arg has somewhere distinct
    // to point.
    session.stateSnapshot.boards.push({
      id: 'sub-2',
      designation: 'Annexe DB',
      board_type: 'sub_distribution',
    });
    session.stateSnapshot.circuits[7] = { designation: 'Lighting' };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_explicit_board',
        name: 'mark_distribution_circuit',
        input: { circuit: 7, board_id: 'main', feeds_board_id: 'sub-2' },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(writes.boardOps[0].source_board_id).toBe('main');
    expect(writes.boardOps[0].feeds_board_id).toBe('sub-2');
  });
});

describe('dispatchMarkDistributionCircuit rejections', () => {
  test('invalid_circuit: non-integer or < 1', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    for (const bad of [0, -1, 1.5, '4', null]) {
      const res = await d(
        {
          tool_call_id: `tu_bad_circuit_${bad}`,
          name: 'mark_distribution_circuit',
          input: { circuit: bad, feeds_board_id: 'sub-1' },
        },
        {}
      );
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).error.code).toBe('invalid_circuit');
    }
    expect(writes.boardOps).toHaveLength(0);
  });

  test('invalid_feeds_board_id: empty / whitespace / non-string', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    for (const bad of ['', '   ', null, 5]) {
      const res = await d(
        {
          tool_call_id: `tu_bad_feeds_${typeof bad}`,
          name: 'mark_distribution_circuit',
          input: { circuit: 4, feeds_board_id: bad },
        },
        {}
      );
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).error.code).toBe('invalid_feeds_board_id');
    }
    expect(writes.boardOps).toHaveLength(0);
  });

  test('source_board_not_found: explicit board_id pointing at unknown board', async () => {
    const session = makeSession();
    session.stateSnapshot.circuits[4] = { designation: 'feed' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_bad_source',
        name: 'mark_distribution_circuit',
        input: { circuit: 4, board_id: 'sub-99', feeds_board_id: 'sub-1' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'source_board_not_found',
      field: 'board_id',
    });
    expect(writes.boardOps).toHaveLength(0);
  });

  test('feeds_board_not_found: STOP-SLICE deviation from PLAN.md L577-583 (no forward-ref ask_user)', async () => {
    // PLAN.md prescribed an ask_user(add_board) flow when feeds_board_id
    // doesn't exist. This slice REJECTS instead — Sonnet must call
    // add_board first. The supervised slice that adds the resolver flow
    // needs to update this assertion.
    const session = makeSession();
    session.stateSnapshot.circuits[4] = { designation: 'feed' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_forward_ref',
        name: 'mark_distribution_circuit',
        input: { circuit: 4, feeds_board_id: 'sub-99' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'feeds_board_not_found',
      field: 'feeds_board_id',
    });
    expect(writes.boardOps).toHaveLength(0);
  });

  test('circuit_not_found: circuit bucket absent on the source board', async () => {
    const session = makeSession();
    // No circuits[] entries seeded.
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_no_circuit',
        name: 'mark_distribution_circuit',
        input: { circuit: 4, feeds_board_id: 'sub-1' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'circuit_not_found',
      field: 'circuit',
    });
    expect(writes.boardOps).toHaveLength(0);
  });
});
