/**
 * Stage 6 multi-board sprint Phase 6.1 — add_board end-to-end coverage.
 *
 * WHAT: Locks the schema, dispatcher validation, state mutation, hierarchy
 * gate, and boardOps wire emit for the new tool. Mirrors the structure of
 * stage6-tool-schemas-board.test.js (record_board_reading) but covers the
 * add_board surface.
 *
 * WHY this file (not extending the board test): record_board_reading covers
 * field writes onto circuits[0]; add_board covers boards[] mutations. The
 * two tools share zero validators and zero mutators — separating the test
 * files keeps each suite focused and the regression coverage easy to audit.
 *
 * Coverage:
 *   1. Schema shape — required = [designation, board_type], enum = [main,
 *      sub_distribution, sub_main], no extra/missing properties.
 *   2. Happy paths — sub_distribution and sub_main with parent + feed_circuit_ref.
 *   3. Rejections — invalid_board_type, invalid_designation (empty/whitespace/
 *      33-char), parent_required (sub_main with no parent), parent_not_found,
 *      feed_circuit_ref_required, hierarchy_invalid (validator-rejected case).
 *   4. boardOps ordering — multiple add_board calls in one turn.
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
  // ensureMultiBoardShape synthesises the default `main` board so the
  // session starts in the post-Phase-5.1 multi-board shape.
  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  return { sessionId: 's-add-board', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

// ---------------------------------------------------------------------------
// Group 1 — Schema shape
// ---------------------------------------------------------------------------

describe('add_board schema', () => {
  test('exists in TOOL_SCHEMAS via getToolByName', () => {
    const tool = getToolByName('add_board');
    expect(tool).toBeDefined();
    expect(TOOL_SCHEMAS.some((t) => t.name === 'add_board')).toBe(true);
  });

  test('required list is exactly [designation, board_type]', () => {
    const tool = getToolByName('add_board');
    expect(tool.input_schema.required.sort()).toEqual(['board_type', 'designation']);
  });

  test('board_type enum is exactly [main, sub_distribution, sub_main]', () => {
    const tool = getToolByName('add_board');
    expect(tool.input_schema.properties.board_type.enum).toEqual([
      'main',
      'sub_distribution',
      'sub_main',
    ]);
  });

  test('declares parent_board_id and feed_circuit_ref as optional properties', () => {
    const tool = getToolByName('add_board');
    expect(tool.input_schema.properties.parent_board_id.type).toBe('string');
    expect(tool.input_schema.properties.feed_circuit_ref.type).toBe('integer');
    expect(tool.input_schema.required).not.toContain('parent_board_id');
    expect(tool.input_schema.required).not.toContain('feed_circuit_ref');
  });

  test('additionalProperties:false (strict drops extra keys at the API boundary)', () => {
    const tool = getToolByName('add_board');
    expect(tool.input_schema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Happy paths
// ---------------------------------------------------------------------------

describe('dispatchAddBoard happy paths', () => {
  test('add sub_distribution: appends board, flips currentBoardId, emits boardOps entry', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_add_subdist',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_distribution',
        },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(true);
    expect(body.board_id).toBe('sub-1');
    expect(body.currentBoardId).toBe('sub-1');

    // Snapshot mutated in place: boards[] gains the new entry, currentBoardId
    // flips to the synthesised id.
    expect(session.stateSnapshot.boards).toHaveLength(2);
    expect(session.stateSnapshot.boards[1]).toEqual({
      id: 'sub-1',
      designation: 'Garage CU',
      board_type: 'sub_distribution',
    });
    expect(session.stateSnapshot.currentBoardId).toBe('sub-1');

    // boardOps wire channel populated.
    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0]).toEqual({
      op: 'add_board',
      board_id: 'sub-1',
      designation: 'Garage CU',
      board_type: 'sub_distribution',
      parent_board_id: null,
      feed_circuit_ref: null,
    });

    // Log row carries the ok outcome.
    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'add_board',
      outcome: 'ok',
      is_error: false,
      input_summary: {
        board_id: 'sub-1',
        board_type: 'sub_distribution',
        parent_board_id: null,
      },
    });
    // PII guard: never log the designation (free text).
    expect(rows[0].input_summary).not.toHaveProperty('designation');
  });

  test('add sub_main with parent + feed_circuit_ref: round-trips both fields into snapshot AND boardOps', async () => {
    // Seed an existing distribution circuit on the main board so the
    // hierarchy validator's feed_circuit_not_found check is satisfied.
    const session = makeSession();
    session.stateSnapshot.circuits['main::4'] = {
      board_id: 'main',
      circuit: 4,
      designation: 'Sub-board feed',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_add_submain',
        name: 'add_board',
        input: {
          designation: 'Annexe DB',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 4,
        },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).board_id).toBe('sub-1');

    expect(session.stateSnapshot.boards[1]).toEqual({
      id: 'sub-1',
      designation: 'Annexe DB',
      board_type: 'sub_main',
      parent_board_id: 'main',
      feed_circuit_ref: 4,
    });

    expect(writes.boardOps[0]).toEqual({
      op: 'add_board',
      board_id: 'sub-1',
      designation: 'Annexe DB',
      board_type: 'sub_main',
      parent_board_id: 'main',
      feed_circuit_ref: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Rejections (snapshot invariants: no mutation, no boardOps emit)
// ---------------------------------------------------------------------------

describe('dispatchAddBoard rejections', () => {
  test('invalid_board_type: unknown enum value', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_bad_type',
        name: 'add_board',
        input: { designation: 'X', board_type: 'invalid' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'invalid_board_type',
      field: 'board_type',
    });
    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(session.stateSnapshot.currentBoardId).toBe('main');
    expect(writes.boardOps).toHaveLength(0);
  });

  test('invalid_designation: empty string, whitespace-only, and 33-char overflow', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    for (const designation of ['', '   ', 'X'.repeat(33)]) {
      const res = await d(
        {
          tool_call_id: `tu_bad_des_${designation.length}`,
          name: 'add_board',
          input: { designation, board_type: 'sub_distribution' },
        },
        {}
      );
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).error.code).toBe('invalid_designation');
    }
    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('parent_required: sub_main without parent_board_id', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_no_parent',
        name: 'add_board',
        input: { designation: 'Annexe', board_type: 'sub_main' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'parent_required',
      field: 'parent_board_id',
    });
    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('parent_not_found: parent_board_id pointing at a non-existent board', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_orphan',
        name: 'add_board',
        input: {
          designation: 'Annexe',
          board_type: 'sub_main',
          parent_board_id: 'sub-99',
          feed_circuit_ref: 4,
        },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'parent_not_found',
      field: 'parent_board_id',
    });
    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('feed_circuit_ref_required: parent_board_id set but feed_circuit_ref missing or non-integer', async () => {
    const session = makeSession();
    session.stateSnapshot.circuits['main::1'] = { board_id: 'main', circuit: 1 };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    // Missing feed_circuit_ref entirely.
    let res = await d(
      {
        tool_call_id: 'tu_no_feed_ref',
        name: 'add_board',
        input: {
          designation: 'A',
          board_type: 'sub_distribution',
          parent_board_id: 'main',
        },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('feed_circuit_ref_required');

    // Non-integer feed_circuit_ref (e.g. "4" string).
    res = await d(
      {
        tool_call_id: 'tu_feed_ref_str',
        name: 'add_board',
        input: {
          designation: 'B',
          board_type: 'sub_distribution',
          parent_board_id: 'main',
          feed_circuit_ref: '4',
        },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('feed_circuit_ref_required');

    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('hierarchy_invalid: feed_circuit_ref points at a circuit that does not exist on the parent board', async () => {
    // No circuit seeded on the main board, so feed_circuit_ref=4 cannot
    // resolve to a known circuit. validateBoardHierarchy returns
    // feed_circuit_not_found; dispatcher rejects with hierarchy_invalid.
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_dangling_feed',
        name: 'add_board',
        input: {
          designation: 'Dangling',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 4,
        },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error.code).toBe('hierarchy_invalid');
    // Validator-derived details surfaced for the model + analyzer.
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.some((e) => e.code === 'feed_circuit_not_found')).toBe(true);

    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — boardOps ordering
// ---------------------------------------------------------------------------

describe('dispatchAddBoard wire emit ordering', () => {
  test('multiple add_board calls in one turn produce boardOps entries in insertion order', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    await d(
      {
        tool_call_id: 'tu_a',
        name: 'add_board',
        input: { designation: 'First', board_type: 'sub_distribution' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'add_board',
        input: { designation: 'Second', board_type: 'sub_distribution' },
      },
      {}
    );

    expect(writes.boardOps).toHaveLength(2);
    expect(writes.boardOps[0].board_id).toBe('sub-1');
    expect(writes.boardOps[0].designation).toBe('First');
    expect(writes.boardOps[1].board_id).toBe('sub-2');
    expect(writes.boardOps[1].designation).toBe('Second');

    // currentBoardId tracks the latest add.
    expect(session.stateSnapshot.currentBoardId).toBe('sub-2');
  });
});
