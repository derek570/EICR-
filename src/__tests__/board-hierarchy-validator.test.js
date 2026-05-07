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
});
