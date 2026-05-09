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

  // 2026-05-09 add-board hotfix — parent_required now ONLY fires when the
  // snapshot has zero or two-or-more main-board candidates. Single-main
  // jobs (the overwhelmingly common case) auto-resolve the parent to the
  // single main; on a multi-main snapshot the rejection is preserved so
  // Sonnet must disambiguate.
  test('parent_required: sub_main on a multi-main snapshot still rejects', async () => {
    const session = makeSession();
    // Add a second main board so the single-main fallback can't fire.
    session.stateSnapshot.boards.push({ id: 'main-2', designation: 'DB-2', board_type: 'main' });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_no_parent_multi_main',
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
    expect(session.stateSnapshot.boards).toHaveLength(2);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('parent_required: sub_main on a snapshot with no main board rejects', async () => {
    const session = makeSession();
    // Wipe boards entirely — pathological state but the validator must
    // hold the line. ensureMultiBoardShape would re-synthesise a default
    // on the next dispatcher entry, so we replace boards[] AFTER
    // construction (the dispatcher's ensureMultiBoardShape call is a
    // no-op when boards is non-empty).
    session.stateSnapshot.boards = [
      { id: 'sub-only', designation: 'SubOnly', board_type: 'sub_distribution' },
    ];
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_no_parent_no_main',
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
    expect(writes.boardOps).toHaveLength(0);
  });

  test('single-main fallback: sub_main without parent_board_id auto-fills the single main', async () => {
    // 2026-05-09 add-board hotfix — sessions 7113A114 + 399E69A7 looped on
    // parent_required because Sonnet had no way to learn the main board's
    // id. With a single main on snapshot.boards[], the dispatcher resolves
    // the parent silently and the call proceeds to feed_circuit_ref + the
    // hierarchy validator.
    const session = makeSession();
    session.stateSnapshot.circuits['main::1'] = { board_id: 'main', circuit: 1 };
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_fallback',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          // parent_board_id omitted — should fall back to 'main'.
          feed_circuit_ref: 1,
        },
      },
      {}
    );
    expect(res.is_error).toBeFalsy();
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(true);
    expect(body.board_id).toBe('sub-1');

    // Snapshot: new sub-board persists with parent_board_id resolved to the
    // single main, so a downstream PUT /api/job hierarchy gate also passes.
    expect(session.stateSnapshot.boards).toHaveLength(2);
    expect(session.stateSnapshot.boards[1]).toMatchObject({
      id: 'sub-1',
      board_type: 'sub_main',
      parent_board_id: 'main',
      feed_circuit_ref: 1,
    });

    // boardOps: wire op carries the resolved parent so iOS doesn't have to
    // re-derive it from currentBoardId.
    expect(writes.boardOps).toEqual([
      {
        op: 'add_board',
        board_id: 'sub-1',
        designation: 'Garage CU',
        board_type: 'sub_main',
        parent_board_id: 'main',
        feed_circuit_ref: 1,
      },
    ]);

    // Optimiser visibility — the fallback is logged as a separate event so
    // CloudWatch queries can quantify how often the model lets the server
    // do the disambiguation.
    const fallbackLogs = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6.add_board_parent_fallback'
    );
    expect(fallbackLogs).toHaveLength(1);
    expect(fallbackLogs[0][1]).toMatchObject({
      source: 'single_main_fallback',
      resolved_parent_board_id: 'main',
    });
  });

  test('single-main fallback: empty-string parent_board_id is treated as missing', async () => {
    // STT / Sonnet sometimes round-trip an empty string when the model
    // emits the field but has no value to put there. Treat that the same
    // as missing so the fallback fires.
    const session = makeSession();
    session.stateSnapshot.circuits['main::1'] = { board_id: 'main', circuit: 1 };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_fallback_empty',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          parent_board_id: '',
          feed_circuit_ref: 1,
        },
      },
      {}
    );
    expect(res.is_error).toBeFalsy();
    expect(session.stateSnapshot.boards[1].parent_board_id).toBe('main');
  });

  test('single-main fallback: explicit valid parent_board_id still wins (no logging noise)', async () => {
    // The fallback only triggers when parent_board_id is missing/empty.
    // Explicitly-supplied valid ids must take precedence and NOT log the
    // fallback event.
    const session = makeSession();
    session.stateSnapshot.circuits['main::4'] = { board_id: 'main', circuit: 4 };
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_explicit',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 4,
        },
      },
      {}
    );
    expect(res.is_error).toBeFalsy();
    const fallbackLogs = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6.add_board_parent_fallback'
    );
    expect(fallbackLogs).toHaveLength(0);
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
// Group 3b — Legacy snapshot adapter (2026-05-08)
// ---------------------------------------------------------------------------

describe('dispatchAddBoard legacy keyed-snapshot adapter', () => {
  // Production session EEB8F9EA (2026-05-08) seeded 13 circuits from a
  // pre-multi-board jobState. Each bucket carried its field map but no
  // `board_id` and no `circuit_ref` — the dictionary key was the only
  // record of the ref. The validator (which expects an array of objects
  // self-identifying their ref + board) couldn't find any circuit on the
  // main board, so add_board rejected `hierarchy_invalid` for every feed
  // ref. The dispatcher now synthesises both fields from the dictionary
  // key + the implicit main board id before handing the array to the
  // validator. Locks the regression.
  test('legacy keyed circuits (no board_id, no circuit_ref on bucket) accept a sub_main with a valid feed circuit', async () => {
    const session = makeSession();
    // Mirror the pre-fix seed shape: numeric keys, bare field maps.
    session.stateSnapshot.circuits = {
      0: { ze: '0.21' },
      1: { designation: 'Lights', rating_amps: 6 },
      11: { designation: 'Garden', rating_amps: 32 },
    };
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_legacy_seed',
        name: 'add_board',
        input: {
          designation: 'Garage',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 11,
        },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.boards).toHaveLength(2);
    expect(session.stateSnapshot.currentBoardId).toBe('sub-1');
    // 2026-05-09: dispatchAddBoard now atomically marks the parent's feed
    // circuit when both parent_board_id and feed_circuit_ref are supplied
    // AND the parent bucket exists. Legacy seeds use bare-numeric keys
    // for the main board, so getCircuitBucket(snap, 11, 'main') finds
    // circuits[11] and the auto-mark fires. Two boardOps result: the
    // add_board itself, then mark_distribution_circuit on circuit 11.
    expect(writes.boardOps).toHaveLength(2);
    expect(writes.boardOps[0]).toMatchObject({
      op: 'add_board',
      board_id: 'sub-1',
      parent_board_id: 'main',
      feed_circuit_ref: 11,
    });
    expect(writes.boardOps[1]).toEqual({
      op: 'mark_distribution_circuit',
      circuit_ref: 11,
      feeds_board_id: 'sub-1',
      source_board_id: 'main',
    });
    // Parent bucket also mutated in-place so any same-turn observer
    // (validator on a later round / shadow harness) sees the marked state.
    expect(session.stateSnapshot.circuits[11]).toMatchObject({
      is_distribution_circuit: 'yes',
      feeds_board_id: 'sub-1',
    });
  });

  test('legacy keyed circuits still reject when the feed ref is not in the snapshot', async () => {
    const session = makeSession();
    session.stateSnapshot.circuits = {
      1: { designation: 'Lights' },
    };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_legacy_dangling',
        name: 'add_board',
        input: {
          designation: 'Garage',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 99,
        },
      },
      {}
    );

    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('hierarchy_invalid');
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

// ---------------------------------------------------------------------------
// Group 5 — Auto-mark distribution circuit (atomicity, 2026-05-09)
//
// dispatchAddBoard atomically marks the parent's feed circuit as a
// distribution circuit when both parent_board_id and feed_circuit_ref
// are supplied AND the parent bucket exists. ONE inspector utterance
// ("garage CU fed from circuit 2 on the main") = ONE atomic mutation.
// Closes the source_board_not_found cascade observed in field test
// FD4FF35F (2026-05-09): post add_board the model would emit
// mark_distribution_circuit without an explicit board_id, the dispatcher
// resolved source via currentBoardId (just flipped to the new sub-board),
// and the source-board check rejected. The auto-mark eliminates the
// whole class of failure by making "add a sub-main fed from X" a single
// tool call.
// ---------------------------------------------------------------------------

describe('dispatchAddBoard auto-mark distribution circuit', () => {
  test('parent + feed_circuit_ref + bucket exists → emits mark_distribution_circuit op AND mutates parent bucket', async () => {
    const session = makeSession();
    // Legacy bare-numeric key — getCircuitBucket reads from the flat
    // namespace on the main board.
    session.stateSnapshot.circuits[2] = {
      designation: 'Garage feed',
      rating_amps: 32,
    };
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_atomic',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 2,
        },
      },
      {}
    );

    expect(res.is_error).toBeFalsy();
    expect(JSON.parse(res.content).board_id).toBe('sub-1');

    // boardOps: add_board then mark_distribution_circuit, in insertion order.
    expect(writes.boardOps).toHaveLength(2);
    expect(writes.boardOps[0].op).toBe('add_board');
    expect(writes.boardOps[1]).toEqual({
      op: 'mark_distribution_circuit',
      circuit_ref: 2,
      feeds_board_id: 'sub-1',
      source_board_id: 'main',
    });

    // Parent bucket mutated in place so any same-turn validator pass
    // (e.g. shadow harness) sees the marked state.
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      is_distribution_circuit: 'yes',
      feeds_board_id: 'sub-1',
      designation: 'Garage feed',
      rating_amps: 32,
    });

    // Optimiser visibility — auto-mark fires its own log row so analytics
    // can quantify how often the atomic path saves a chained tool call.
    const autoMarkLogs = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6.add_board_auto_mark_dist'
    );
    expect(autoMarkLogs).toHaveLength(1);
    expect(autoMarkLogs[0][1]).toMatchObject({
      board_id: 'sub-1',
      source_board_id: 'main',
      circuit_ref: 2,
    });
  });

  test('parent + feed_circuit_ref but bucket NOT in snapshot → rejected by hierarchy validator BEFORE auto-mark runs', async () => {
    // The hierarchy validator runs before the snapshot mutation step, so a
    // missing feed circuit on the parent surfaces as hierarchy_invalid and
    // the dispatcher never reaches the auto-mark branch. This is the
    // correct safety net: we don't want to silently add a board pointing
    // at a non-existent feed circuit.
    const session = makeSession();
    // Note: NO circuits seeded — feed_circuit_ref=2 will not validate.
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_no_feed',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 2,
        },
      },
      {}
    );

    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('hierarchy_invalid');
    // Snapshot untouched on rejection — no add_board, no auto-mark, no
    // boardOps emit.
    expect(session.stateSnapshot.boards).toHaveLength(1);
    expect(writes.boardOps).toHaveLength(0);
  });

  test('parent + feed_circuit_ref but composite-key seed under main → auto-mark NO-OP (lookup uses bare-numeric for main)', async () => {
    // The single-main-fallback path is the typical production seed shape:
    // iOS sends circuits keyed under composite `${board_id}::${ref}` even
    // for the main board. getCircuitBucket reads from the bare-numeric key
    // when the target id matches the main, so a composite-keyed-only main
    // bucket isn't visible to the auto-mark lookup. We log the skip and
    // proceed without the second op — the inspector can call
    // mark_distribution_circuit explicitly later (or, more typically, the
    // legacy main-board circuit will already be at the bare-numeric key
    // because the iOS-side state mirror writes both shapes).
    const session = makeSession();
    session.stateSnapshot.circuits['main::2'] = {
      board_id: 'main',
      circuit: 2,
      designation: 'Garage feed',
    };
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_composite_only',
        name: 'add_board',
        input: {
          designation: 'Garage CU',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 2,
        },
      },
      {}
    );

    // The hierarchy validator is happy because it iterates the keyed
    // object and synthesises a flat array (it sees 'main::2'). The
    // auto-mark uses getCircuitBucket which is namespace-strict for main,
    // so the actual bucket lookup misses and we log the skip.
    expect(res.is_error).toBeFalsy();
    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0].op).toBe('add_board');

    const skippedLogs = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6.add_board_auto_mark_dist_skipped'
    );
    expect(skippedLogs).toHaveLength(1);
    expect(skippedLogs[0][1]).toMatchObject({
      board_id: 'sub-1',
      source_board_id: 'main',
      circuit_ref: 2,
      reason: 'feed_circuit_not_found',
    });
  });

  test('sub_distribution + parent + feed_circuit_ref + bucket exists → also auto-marks (board_type-agnostic)', async () => {
    // The atomic auto-mark fires for any board_type that supplies both
    // parent_board_id and feed_circuit_ref. We don't gate on sub_main vs
    // sub_distribution because the inspector's intent — "this board is
    // fed from circuit X on the parent" — is identical regardless of
    // multi-feed status.
    const session = makeSession();
    session.stateSnapshot.circuits[7] = { designation: 'Annexe feed' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_subdist',
        name: 'add_board',
        input: {
          designation: 'Annexe DB',
          board_type: 'sub_distribution',
          parent_board_id: 'main',
          feed_circuit_ref: 7,
        },
      },
      {}
    );
    expect(res.is_error).toBeFalsy();
    expect(writes.boardOps).toHaveLength(2);
    expect(writes.boardOps[1].op).toBe('mark_distribution_circuit');
    expect(writes.boardOps[1].circuit_ref).toBe(7);
    expect(session.stateSnapshot.circuits[7].is_distribution_circuit).toBe('yes');
    expect(session.stateSnapshot.circuits[7].feeds_board_id).toBe('sub-1');
  });

  test('sub_distribution without parent_board_id → no auto-mark attempt, no skip log', async () => {
    // The auto-mark is gated on resolvedParentId AND a numeric
    // feed_circuit_ref. sub_distribution can be added without a parent
    // (multi-feed boards have no single parent), and that path must not
    // emit a noisy "skipped" log when no mark was ever expected.
    const session = makeSession();
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    await d(
      {
        tool_call_id: 'tu_no_parent',
        name: 'add_board',
        input: { designation: 'Standalone', board_type: 'sub_distribution' },
      },
      {}
    );

    expect(writes.boardOps).toHaveLength(1);
    expect(writes.boardOps[0].op).toBe('add_board');
    const skippedLogs = logger.info.mock.calls.filter(
      (c) =>
        c[0] === 'stage6.add_board_auto_mark_dist' ||
        c[0] === 'stage6.add_board_auto_mark_dist_skipped'
    );
    expect(skippedLogs).toHaveLength(0);
  });
});
