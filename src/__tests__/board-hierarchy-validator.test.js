import { describe, expect, it } from '@jest/globals';
import { validateBoardHierarchy } from '../extraction/board-hierarchy-validator.js';

describe('validateBoardHierarchy', () => {
  it('accepts an empty boards array (brand-new job)', () => {
    expect(validateBoardHierarchy([], [])).toEqual({ ok: true, errors: [] });
  });

  it('accepts a single main board with no parent', () => {
    const boards = [{ id: 'main', designation: 'DB-1', board_type: 'main' }];
    expect(validateBoardHierarchy(boards, [])).toEqual({ ok: true, errors: [] });
  });

  it('treats a missing board_type as main (legacy single-board snapshot)', () => {
    const boards = [{ id: 'main', designation: 'DB-1' }];
    expect(validateBoardHierarchy(boards, [])).toEqual({ ok: true, errors: [] });
  });

  it('accepts a valid main + sub_main pair with feed circuit on parent', () => {
    const boards = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      {
        id: 'sub-1',
        designation: 'DB-2',
        board_type: 'sub_main',
        parent_board_id: 'main',
        feed_circuit_ref: '4',
      },
    ];
    const circuits = [
      { circuit: '4', board_id: 'main', is_distribution_circuit: 'yes', feeds_board_id: 'sub-1' },
      { circuit: '1', board_id: 'sub-1' },
    ];
    expect(validateBoardHierarchy(boards, circuits)).toEqual({ ok: true, errors: [] });
  });

  it('flags parent_not_found when parent_board_id has no matching board', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      {
        id: 'sub-1',
        board_type: 'sub_main',
        parent_board_id: 'does-not-exist',
        feed_circuit_ref: '4',
      },
    ];
    const result = validateBoardHierarchy(boards, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'parent_not_found',
      board_id: 'sub-1',
      parent: 'does-not-exist',
    });
  });

  it('flags circular_reference when parent chain loops', () => {
    const boards = [
      { id: 'a', board_type: 'sub_main', parent_board_id: 'b' },
      { id: 'b', board_type: 'sub_main', parent_board_id: 'a' },
    ];
    const result = validateBoardHierarchy(boards, []);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'circular_reference')).toBe(true);
  });

  it('flags multiple_main_boards when more than one board claims main', () => {
    const boards = [
      { id: 'main-1', board_type: 'main' },
      { id: 'main-2', board_type: 'main' },
    ];
    const result = validateBoardHierarchy(boards, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: 'multiple_main_boards', count: 2 });
  });

  it('accepts main + off_peak side by side (off-peak is a sibling, not a second main)', () => {
    // Off-peak boards are fed directly from the supply mains and are
    // siblings of the main board, not children of it. The validator must
    // NOT count off_peak toward the main-board count, otherwise a job
    // with a primary CU + an Economy 7 storage-heater CU would fail
    // persistence.
    const boards = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      { id: 'off-peak-1', designation: 'Off-Peak Board', board_type: 'off_peak' },
    ];
    expect(validateBoardHierarchy(boards, [])).toEqual({ ok: true, errors: [] });
  });

  it('still flags multiple_main_boards when off_peak coexists with two mains', () => {
    // Off-peak is excluded from the main count, but it shouldn't MASK
    // a genuine multi-main snapshot. Two main + one off_peak still fails.
    const boards = [
      { id: 'main-1', board_type: 'main' },
      { id: 'main-2', board_type: 'main' },
      { id: 'off-peak-1', board_type: 'off_peak' },
    ];
    const result = validateBoardHierarchy(boards, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: 'multiple_main_boards', count: 2 });
  });

  it('flags feed_circuit_not_found when feed_circuit_ref does not exist on parent', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      {
        id: 'sub-1',
        board_type: 'sub_main',
        parent_board_id: 'main',
        feed_circuit_ref: '99',
      },
    ];
    const circuits = [{ circuit: '4', board_id: 'main' }];
    const result = validateBoardHierarchy(boards, circuits);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'feed_circuit_not_found',
      board_id: 'sub-1',
      parent: 'main',
      ref: '99',
    });
  });

  it('feed_circuit_not_found also fires when the matching circuit lives on the wrong board', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: '4' },
    ];
    const circuits = [{ circuit: '4', board_id: 'sub-1' }];
    const result = validateBoardHierarchy(boards, circuits);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('feed_circuit_not_found');
  });

  it('matches feed_circuit_ref against either circuit or circuit_ref keys', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: '4' },
    ];
    const circuits = [{ circuit_ref: '4', board_id: 'main' }];
    expect(validateBoardHierarchy(boards, circuits)).toEqual({ ok: true, errors: [] });
  });

  it('coerces numeric feed_circuit_ref to string before comparison', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: 4 },
    ];
    const circuits = [{ circuit: 4, board_id: 'main' }];
    expect(validateBoardHierarchy(boards, circuits)).toEqual({ ok: true, errors: [] });
  });

  it('skips feed_circuit checks when feed_circuit_ref is missing', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main' },
    ];
    expect(validateBoardHierarchy(boards, [])).toEqual({ ok: true, errors: [] });
  });

  it('returns ok when boards is undefined / not an array', () => {
    expect(validateBoardHierarchy(undefined, undefined)).toEqual({ ok: true, errors: [] });
    expect(validateBoardHierarchy(null, null)).toEqual({ ok: true, errors: [] });
  });

  // Legacy snapshot fallback (2026-05-08): pre-multi-board sessions seed
  // circuit buckets with no `board_id`. Adding a sub_main against such a
  // job must succeed — circuits with absent board_id belong to the implicit
  // main board.
  it('accepts a missing board_id on circuits when the parent is the main board', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: 11 },
    ];
    const circuits = [{ circuit_ref: 11 }, { circuit_ref: 4 }];
    expect(validateBoardHierarchy(boards, circuits)).toEqual({ ok: true, errors: [] });
  });

  it('also accepts missing board_id when the parent has no board_type (legacy main)', () => {
    const boards = [
      { id: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: 11 },
    ];
    const circuits = [{ circuit_ref: 11 }];
    expect(validateBoardHierarchy(boards, circuits)).toEqual({ ok: true, errors: [] });
  });

  it('does NOT accept missing board_id when the parent is a non-main board', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: 4 },
      { id: 'sub-2', board_type: 'sub_main', parent_board_id: 'sub-1', feed_circuit_ref: 1 },
    ];
    const circuits = [{ circuit_ref: 4, board_id: 'main' }, { circuit_ref: 1 }];
    const result = validateBoardHierarchy(boards, circuits);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'feed_circuit_not_found',
      board_id: 'sub-2',
      parent: 'sub-1',
      ref: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 2026-06-12 — repairBoardHierarchy (PUT-path rearchitecture; see
// job_1778443465217 incident in the function JSDoc). Strict validation still
// gates interactive creation (add_board dispatcher); the persistence path
// repairs deterministically so a job can never become permanently unsyncable.
// ---------------------------------------------------------------------------
import { repairBoardHierarchy } from '../extraction/board-hierarchy-validator.js';

describe('repairBoardHierarchy', () => {
  test('valid hierarchy returns original reference with no repairs', () => {
    const boards = [{ id: 'main', board_type: 'main' }];
    const r = repairBoardHierarchy(boards, []);
    expect(r.ok).toBe(true);
    expect(r.boards).toBe(boards);
    expect(r.repairs).toEqual([]);
  });

  test('dangling feed_circuit_ref cleared, parent link kept (field incident shape)', () => {
    const boards = [
      { id: 'FA6C8923', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'FA6C8923', feed_circuit_ref: '2' },
    ];
    const r = repairBoardHierarchy(boards, [{ circuit_ref: '1', board_id: null }]);
    expect(r.ok).toBe(true);
    const sub = r.boards.find((b) => b.id === 'sub-1');
    expect(sub.feed_circuit_ref).toBeNull();
    expect(sub.parent_board_id).toBe('FA6C8923');
    expect(r.repairs).toEqual([
      {
        code: 'feed_circuit_not_found',
        board_id: 'sub-1',
        action: 'cleared_feed_circuit_ref',
        was: '2',
      },
    ]);
    // Pure: input untouched.
    expect(boards[1].feed_circuit_ref).toBe('2');
  });

  test('parent_not_found clears parent link AND feed ref', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'ghost', feed_circuit_ref: '4' },
    ];
    const r = repairBoardHierarchy(boards, []);
    expect(r.ok).toBe(true);
    const sub = r.boards.find((b) => b.id === 'sub-1');
    expect(sub.parent_board_id).toBeNull();
    expect(sub.feed_circuit_ref).toBeNull();
  });

  test('circular_reference broken by clearing the reported board parent', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'a', board_type: 'sub_main', parent_board_id: 'b' },
      { id: 'b', board_type: 'sub_main', parent_board_id: 'a' },
    ];
    const r = repairBoardHierarchy(boards, []);
    expect(r.ok).toBe(true);
    // At least one side of the cycle is now parentless; the other may keep
    // its (now valid) parent link.
    const a = r.boards.find((b) => b.id === 'a');
    const b = r.boards.find((x) => x.id === 'b');
    expect(a.parent_board_id === null || b.parent_board_id === null).toBe(true);
  });

  test('multiple mains: first keeps the role, later mains demote', () => {
    const boards = [
      { id: 'main-1', board_type: 'main' },
      { id: 'main-2', board_type: 'main' },
      { id: 'legacy-untyped' },
    ];
    const r = repairBoardHierarchy(boards, []);
    expect(r.ok).toBe(true);
    expect(r.boards.find((b) => b.id === 'main-1').board_type).toBe('main');
    expect(r.boards.find((b) => b.id === 'main-2').board_type).toBe('sub_distribution');
    expect(r.boards.find((b) => b.id === 'legacy-untyped').board_type).toBe('sub_distribution');
  });

  test('compound violations all repaired in one call', () => {
    const boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'ghost', feed_circuit_ref: '9' },
      { id: 'sub-2', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: '99' },
    ];
    const r = repairBoardHierarchy(boards, [{ circuit_ref: '1', board_id: null }]);
    expect(r.ok).toBe(true);
    expect(r.repairs.length).toBeGreaterThanOrEqual(2);
  });
});
