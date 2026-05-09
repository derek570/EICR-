/**
 * stage6-answer-resolver-board-id.test.js
 *
 * 2026-05-09 add-board hotfix — unit coverage for `resolveBoardIdAnswer`.
 *
 * Repro pattern: sessions 7113A114-B535-4C8F-8318-7661A052A273 (07:43 BST) +
 * 399E69A7-A6E2-4293-85F5-777AB97A328D (07:50 BST), 2026-05-09. Inspector
 * tried to add a Garage sub-board fed from circuit 1 of the main board.
 * Sonnet asked variants of "Is the parent the main board?" / "What's the
 * board ID of the parent board?" and the inspector replied "It is.",
 * "Garage", "1" — every reply went through resolveValueAnswer which
 * looks for numerics and escalated `no_numeric_in_reply`. Eight failed
 * add_board rounds before ask_budget_exhausted.
 *
 * resolveBoardIdAnswer accepts:
 *   - the main keyword ("main", "the main", "main board")
 *   - affirmatives ("yes", "yes it is", "it is") IFF exactly one main board
 *   - a literal id ("main", "sub-1", "C58D2373-…")
 *   - a designation ("Garage", "DB-1") via exact / unique-substring match
 *   - cancel ("skip", "never mind")
 *
 * Multi-main / no-main snapshots escalate confidently — the model must
 * disambiguate, not the resolver.
 */

import { resolveBoardIdAnswer } from '../extraction/stage6-answer-resolver.js';

const SINGLE_MAIN = [{ id: 'main', designation: 'DB-1', board_type: 'main' }];

const SINGLE_MAIN_UUID = [
  { id: 'C58D2373-831A-402B-BA16-211F5022F973', designation: 'DB-1', board_type: 'main' },
];

const MAIN_PLUS_GARAGE = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-1', designation: 'Garage', board_type: 'sub_main', parent_board_id: 'main' },
];

const MULTI_MAIN = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'main-2', designation: 'DB-2', board_type: 'main' },
];

describe('resolveBoardIdAnswer — non-board context', () => {
  test('returns no_board_context when contextField is not a board-id field', () => {
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: 'measured_zs_ohm',
      boards: SINGLE_MAIN,
    });
    expect(v).toEqual({ kind: 'no_board_context' });
  });

  test('returns no_board_context when contextField is null', () => {
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: null,
      boards: SINGLE_MAIN,
    });
    expect(v).toEqual({ kind: 'no_board_context' });
  });
});

describe('resolveBoardIdAnswer — main keyword (single main)', () => {
  test('"main" resolves to main board id', () => {
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v).toMatchObject({
      kind: 'auto_resolve',
      resolved_board_id: 'main',
      resolved_via: 'main_keyword',
    });
  });

  test('"the main board." (with punctuation) resolves to main', () => {
    const v = resolveBoardIdAnswer({
      userText: 'the main board.',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('main');
  });

  test('"the main one" resolves to main', () => {
    const v = resolveBoardIdAnswer({
      userText: 'the main one',
      contextField: 'parent_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('main');
  });

  test('UUID-based main board id is resolved correctly', () => {
    // iOS supplies UUID ids via jobState.boards[]; the resolver must
    // surface the UUID, not the synthetic `main` literal.
    const v = resolveBoardIdAnswer({
      userText: 'the main board',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN_UUID,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('C58D2373-831A-402B-BA16-211F5022F973');
  });
});

describe('resolveBoardIdAnswer — affirmatives (single-main fallback)', () => {
  test('"It is." resolves to single main board id', () => {
    // Production smoking gun: session 7113A114, user_text="It is."
    const v = resolveBoardIdAnswer({
      userText: 'It is.',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v).toMatchObject({
      kind: 'auto_resolve',
      resolved_board_id: 'main',
      resolved_via: 'affirmative_single_main',
    });
  });

  test.each([
    ['yes', 'main'],
    ['Yes.', 'main'],
    ['yeah', 'main'],
    ['yep', 'main'],
    ['yup', 'main'],
    ['correct', 'main'],
    ["that's right", 'main'],
    ['yes it is', 'main'],
    ['yes the main', 'main'],
    ['yes the main board', 'main'],
  ])('"%s" → %s (single main)', (userText, expectedId) => {
    const v = resolveBoardIdAnswer({
      userText,
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe(expectedId);
  });

  test('"yes" against a multi-main snapshot escalates (ambiguous)', () => {
    const v = resolveBoardIdAnswer({
      userText: 'yes',
      contextField: 'feeds_board_id',
      boards: MULTI_MAIN,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('affirmative_multiple_mains');
    expect(v.available_boards).toHaveLength(2);
  });

  test('"yes" against a no-main snapshot escalates (no target)', () => {
    const v = resolveBoardIdAnswer({
      userText: 'yes',
      contextField: 'feeds_board_id',
      boards: [{ id: 'sub-1', designation: 'X', board_type: 'sub_distribution' }],
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('affirmative_no_main_board');
  });

  test('"main" against multi-main snapshot escalates (ambiguous keyword)', () => {
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: 'feeds_board_id',
      boards: MULTI_MAIN,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('main_keyword_but_multiple_mains');
  });
});

describe('resolveBoardIdAnswer — designation match', () => {
  test('"Garage" exact-matches the Garage sub-board', () => {
    const v = resolveBoardIdAnswer({
      userText: 'Garage',
      contextField: 'feeds_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v).toMatchObject({
      kind: 'auto_resolve',
      resolved_board_id: 'sub-1',
      resolved_via: 'designation_match',
    });
  });

  test('"the garage" matches via designation cleaner ("the" → drop)', () => {
    const v = resolveBoardIdAnswer({
      userText: 'the garage',
      contextField: 'feeds_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('sub-1');
  });

  test('"DB-1" matches the main by designation', () => {
    const v = resolveBoardIdAnswer({
      userText: 'DB-1',
      contextField: 'feeds_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('main');
  });

  test('ambiguous designation match escalates with the candidate ids', () => {
    const boards = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      { id: 'sub-1', designation: 'Garage CU 1', board_type: 'sub_main', parent_board_id: 'main' },
      { id: 'sub-2', designation: 'Garage CU 2', board_type: 'sub_main', parent_board_id: 'main' },
    ];
    const v = resolveBoardIdAnswer({
      userText: 'garage',
      contextField: 'feeds_board_id',
      boards,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toMatch(/^ambiguous_board_designation:/);
    expect(v.parsed_hint).toContain('sub-1');
    expect(v.parsed_hint).toContain('sub-2');
  });
});

describe('resolveBoardIdAnswer — literal id', () => {
  test('"sub-1" matches the synthetic id verbatim', () => {
    const v = resolveBoardIdAnswer({
      userText: 'sub-1',
      contextField: 'parent_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('sub-1');
    expect(v.resolved_via).toBe('literal_id');
  });

  test('UUID id matches case-insensitively', () => {
    const v = resolveBoardIdAnswer({
      userText: 'c58d2373-831a-402b-ba16-211f5022f973',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN_UUID,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('C58D2373-831A-402B-BA16-211F5022F973');
    expect(v.resolved_via).toBe('literal_id');
  });
});

describe('resolveBoardIdAnswer — cancel + edge cases', () => {
  test('"skip" cancels', () => {
    const v = resolveBoardIdAnswer({
      userText: 'skip',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v).toEqual({ kind: 'cancel' });
  });

  test('"never mind" cancels', () => {
    const v = resolveBoardIdAnswer({
      userText: 'never mind',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v).toEqual({ kind: 'cancel' });
  });

  test('empty reply escalates', () => {
    const v = resolveBoardIdAnswer({
      userText: '',
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('empty_reply');
  });

  test('garbled reply ("xyzzy") escalates with no_board_match', () => {
    const v = resolveBoardIdAnswer({
      userText: 'xyzzy',
      contextField: 'feeds_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('no_board_match');
    // available_boards must be present so Sonnet can pick on retry without
    // having to wait for another snapshot turn.
    expect(v.available_boards).toEqual([
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      { id: 'sub-1', designation: 'Garage', board_type: 'sub_main' },
    ]);
  });

  test('one-character residue is too short for designation match', () => {
    const v = resolveBoardIdAnswer({
      userText: 'a',
      contextField: 'feeds_board_id',
      boards: MAIN_PLUS_GARAGE,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('no_board_match');
  });

  test('parent_board_id context is also handled', () => {
    // Both feeds_board_id and parent_board_id must route through the
    // resolver. The dispatcher uses the same code path for both.
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: 'parent_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('auto_resolve');
    expect(v.resolved_board_id).toBe('main');
  });
});

describe('resolveBoardIdAnswer — defensive shapes', () => {
  test('boards = undefined returns escalate without crashing', () => {
    const v = resolveBoardIdAnswer({
      userText: 'main',
      contextField: 'feeds_board_id',
      boards: undefined,
    });
    // No boards = nothing matches the keyword. Escalate.
    expect(v.kind).toBe('escalate');
  });

  test('boards = [] returns escalate without crashing', () => {
    const v = resolveBoardIdAnswer({
      userText: 'yes',
      contextField: 'feeds_board_id',
      boards: [],
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('affirmative_no_main_board');
  });

  test('null user text is treated as empty', () => {
    const v = resolveBoardIdAnswer({
      userText: null,
      contextField: 'feeds_board_id',
      boards: SINGLE_MAIN,
    });
    expect(v.kind).toBe('escalate');
    expect(v.parsed_hint).toBe('empty_reply');
  });
});
