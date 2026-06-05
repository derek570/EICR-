/**
 * Stage 6 multi-board sprint Phase 6.2 — select_board (id-only) coverage.
 *
 * Locks: schema shape (id-only contract — designation NOT accepted),
 * happy path id flip, every rejection code, idempotent re-select.
 *
 * NOTE: designation fuzzy match is a STOP slice
 * (PHASE6_PHASE7_AUTONOMOUS.md). Levenshtein floor / case sensitivity /
 * ambiguity are product judgement calls deferred to a supervised session.
 * This file's tests will need extension when fuzzy-match ships.
 */

import { jest } from '@jest/globals';
import { TOOL_SCHEMAS, getToolByName } from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession() {
  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  // Seed two extra boards so select_board has somewhere to flip TO.
  snapshot.boards.push({
    id: 'sub-1',
    designation: 'Garage CU',
    board_type: 'sub_distribution',
  });
  snapshot.boards.push({
    id: 'sub-2',
    designation: 'Annexe DB',
    board_type: 'sub_main',
    parent_board_id: 'main',
    feed_circuit_ref: 4,
  });
  return { sessionId: 's-select', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

describe('select_board schema', () => {
  test('exists in TOOL_SCHEMAS via getToolByName', () => {
    const tool = getToolByName('select_board');
    expect(tool).toBeDefined();
    expect(TOOL_SCHEMAS.some((t) => t.name === 'select_board')).toBe(true);
  });

  test('required is exactly [board_id]', () => {
    const tool = getToolByName('select_board');
    expect(tool.input_schema.required).toEqual(['board_id']);
  });

  test('properties are exactly { board_id }; designation is intentionally absent (id-only)', () => {
    // The slice ships id-only resolution. Adding a `designation` property
    // here would invite the model to pass a designation; the dispatcher
    // would reject with board_not_found, but we can rule out the path
    // entirely at the schema layer.
    const tool = getToolByName('select_board');
    expect(Object.keys(tool.input_schema.properties)).toEqual(['board_id']);
    expect(tool.input_schema.properties.board_id.type).toBe('string');
  });

  test('additionalProperties:false', () => {
    const tool = getToolByName('select_board');
    expect(tool.input_schema.additionalProperties).toBe(false);
  });
});

describe('dispatchSelectBoard happy paths', () => {
  test('flips currentBoardId to the named board, emits a single boardOps select_board entry, returns ok envelope', async () => {
    const session = makeSession();
    expect(session.stateSnapshot.currentBoardId).toBe('main');

    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_select_sub1',
        name: 'select_board',
        input: { board_id: 'sub-1' },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ ok: true, currentBoardId: 'sub-1' });
    expect(session.stateSnapshot.currentBoardId).toBe('sub-1');

    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0]).toEqual({ op: 'select_board', board_id: 'sub-1' });

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'select_board',
      outcome: 'ok',
      is_error: false,
      input_summary: { board_id: 'sub-1' },
    });
  });

  test('idempotent: select_board("main") when already on main still emits one boardOps entry (wire = "model called the tool")', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_idem',
        name: 'select_board',
        input: { board_id: 'main' },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.currentBoardId).toBe('main');
    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0]).toEqual({ op: 'select_board', board_id: 'main' });
  });
});

describe('dispatchSelectBoard rejections', () => {
  test('board_not_found: unknown id', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_404',
        name: 'select_board',
        input: { board_id: 'sub-99' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'board_not_found',
      field: 'board_id',
    });
    // Snapshot unchanged; no wire op emitted.
    expect(session.stateSnapshot.currentBoardId).toBe('main');
    expect(writes.boardOps).toHaveLength(0);
  });

  test('invalid_board_id: empty string, whitespace, non-string', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    for (const bad of ['', '   ', null, undefined, 123]) {
      const res = await d(
        {
          tool_call_id: `tu_bad_${typeof bad}`,
          name: 'select_board',
          input: { board_id: bad },
        },
        {}
      );
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).error.code).toBe('invalid_board_id');
    }
    // Snapshot unchanged; no wire op emitted.
    expect(session.stateSnapshot.currentBoardId).toBe('main');
    expect(writes.boardOps).toHaveLength(0);
  });

  test('id-only contract: passing a designation (e.g. "Garage CU") rejects with board_not_found, NOT silently fuzzy-matches', async () => {
    // The seed has board sub-1 with designation 'Garage CU'. Phase 6.2
    // ships id-only — this MUST NOT resolve. Phase 6.2 fuzzy-match (a
    // STOP slice) would change this assertion.
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_designation',
        name: 'select_board',
        input: { board_id: 'Garage CU' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('board_not_found');
    expect(session.stateSnapshot.currentBoardId).toBe('main');
    expect(writes.boardOps).toHaveLength(0);
  });
});
