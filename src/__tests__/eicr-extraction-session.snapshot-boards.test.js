/**
 * eicr-extraction-session.snapshot-boards.test.js
 *
 * 2026-05-09 add-board hotfix — locks the new BOARDS: section in
 * `buildStateSnapshotMessage`. Pre-fix the snapshot exposed circuits but
 * never the boards array, so when Sonnet wanted to call `add_board`,
 * `select_board`, or `mark_distribution_circuit`, it had no way to learn
 * the literal id of an existing board. Sessions 7113A114 + 399E69A7
 * (2026-05-09) showed 10+ rejected add_board calls in two consecutive
 * recordings on the same job.
 *
 * Section format:
 *   - JSON-per-line so Sonnet can copy an id verbatim
 *   - Includes id (canonical), designation, board_type, parent_board_id,
 *     feed_circuit_ref (when present)
 *   - Active board is annotated with `"active": true`
 *   - Designation strings are wrapped with USER_TEXT markers (free text)
 *   - Header points at the three tools that consume the ids
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

function makeSession() {
  // toolCallsMode defaults to 'off' which still emits the boards section
  // when a snapshot is otherwise non-empty. Use 'live' here so the
  // snapshot is always built (off-mode early-returns null when only
  // boards are present, by design — pre-existing boards on a fresh
  // session aren't load-bearing for off-mode emit decisions).
  return new EICRExtractionSession('k', 's-snap-boards', 'eicr', {
    toolCallsMode: 'live',
  });
}

describe('buildStateSnapshotMessage — BOARDS section', () => {
  test('omits the boards section on single-board jobs (single-main fallback covers them)', () => {
    // The single-main fallback in dispatchAddBoard + the main-keyword
    // path in resolveBoardIdAnswer cover the entire single-board surface.
    // Emitting the BOARDS section in that case would just burn prompt
    // bytes (and break the pre-existing empty-snapshot canary tests).
    const session = makeSession();
    expect(session.stateSnapshot.boards).toHaveLength(1);
    const snapshot = session.buildStateSnapshotMessage();
    // Snapshot is null on a fresh session (no circuits, no observations,
    // no schedule, single synth board) — the empty-session canary.
    expect(snapshot).toBeNull();
  });

  test('emits the boards section once a second board is added', () => {
    // Smoking gun: sessions 7113A114 + 399E69A7. Inspector said
    // "DV 2 is fed from circuit 1" — Sonnet calls add_board with
    // sub_main, the snapshot now has 2 boards, and BEFORE this hotfix
    // Sonnet still didn't see board ids, so it looped on parent_required.
    // After this hotfix, the BOARDS section appears as soon as the
    // second board exists, so Sonnet has the ids on hand for any
    // subsequent mark_distribution_circuit / select_board call.
    const session = makeSession();
    session.stateSnapshot.boards.push({
      id: 'sub-1',
      designation: 'Garage',
      board_type: 'sub_main',
      parent_board_id: 'main',
      feed_circuit_ref: 1,
    });
    const snapshot = session.buildStateSnapshotMessage();
    expect(snapshot).toBeTruthy();
    expect(snapshot).toContain('BOARDS');
    expect(snapshot).toContain('"id":"main"');
    expect(snapshot).toContain('"id":"sub-1"');
  });

  test('lists every board with id + designation + board_type + active flag', () => {
    const session = makeSession();
    session.stateSnapshot.boards = [
      { id: 'C58D2373-831A-402B-BA16-211F5022F973', designation: 'DB-1', board_type: 'main' },
      {
        id: 'sub-1',
        designation: 'Garage CU',
        board_type: 'sub_main',
        parent_board_id: 'C58D2373-831A-402B-BA16-211F5022F973',
        feed_circuit_ref: 4,
      },
    ];
    session.stateSnapshot.currentBoardId = 'sub-1';

    const snapshot = session.buildStateSnapshotMessage();
    expect(snapshot).toContain('BOARDS');
    // UUID id is preserved verbatim in the snapshot so Sonnet can copy
    // it into parent_board_id on the next add_board call.
    expect(snapshot).toContain('"id":"C58D2373-831A-402B-BA16-211F5022F973"');
    expect(snapshot).toContain('"id":"sub-1"');
    expect(snapshot).toContain('"board_type":"main"');
    expect(snapshot).toContain('"board_type":"sub_main"');
    // Hierarchy fields come through too.
    expect(snapshot).toContain('"parent_board_id":"C58D2373-831A-402B-BA16-211F5022F973"');
    expect(snapshot).toContain('"feed_circuit_ref":4');
    // Active board is annotated. The currentBoardId was flipped to sub-1.
    const activeLine = snapshot.split('\n').find((l) => l.includes('"id":"sub-1"'));
    expect(activeLine).toContain('"active":true');
    // The other board is NOT marked active.
    const mainLine = snapshot
      .split('\n')
      .find((l) => l.includes('"id":"C58D2373-831A-402B-BA16-211F5022F973"'));
    expect(mainLine).not.toContain('"active":true');
  });

  test('header points at the three tools that consume the ids', () => {
    // Plain documentation cue inside the snapshot — Sonnet uses this
    // to know which tools take which kind of board reference. Without
    // this, the model has to guess from the schema descriptions alone.
    const session = makeSession();
    session.stateSnapshot.boards.push({
      id: 'sub-1',
      designation: 'Garage',
      board_type: 'sub_main',
      parent_board_id: 'main',
      feed_circuit_ref: 1,
    });
    const snapshot = session.buildStateSnapshotMessage();
    expect(snapshot).toContain('add_board.parent_board_id');
    expect(snapshot).toContain('select_board.board_id');
    expect(snapshot).toContain('mark_distribution_circuit.feeds_board_id');
  });

  test('designation strings are wrapped with USER_TEXT markers (free-text safety)', () => {
    // Designations are inspector-supplied via add_board / iOS UI. Wrap
    // them inline so the snapshot's preamble covers the whole region.
    const session = makeSession();
    session.stateSnapshot.boards = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      { id: 'sub-1', designation: 'Garage', board_type: 'sub_main', parent_board_id: 'main' },
    ];
    const snapshot = session.buildStateSnapshotMessage();
    // The inline wrap shape is `"<<<USER_TEXT>>>...<<<END_USER_TEXT>>>"`
    // (or sanitised escaped variant). Don't pin the exact characters —
    // just confirm the designation lives inside USER_TEXT markers.
    const boardsLine = snapshot.split('\n').find((l) => l.startsWith('{"id":"main"'));
    expect(boardsLine).toMatch(/USER_TEXT/);
    expect(boardsLine).toContain('DB-1');
  });

  test('returns null when there are no boards AND no other snapshot surfaces', () => {
    // Belt-and-braces: without any circuits / observations / alerts /
    // schedule / asked / extractedObs / boards the snapshot is null
    // (cache-key invariant — the system block must not be empty when
    // present in non-off mode).
    const session = makeSession();
    session.stateSnapshot.boards = [];
    session.stateSnapshot.currentBoardId = null;
    expect(session.buildStateSnapshotMessage()).toBeNull();
  });

  test('omits malformed board entries (no id) without crashing', () => {
    const session = makeSession();
    session.stateSnapshot.boards = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      null, // defensive
      { designation: 'No-ID Board' }, // missing id
      { id: 'sub-1', designation: 'Garage', board_type: 'sub_main' },
      { id: 'sub-2', designation: 'Loft', board_type: 'sub_distribution' },
    ];
    const snapshot = session.buildStateSnapshotMessage();
    expect(snapshot).toContain('"id":"main"');
    expect(snapshot).toContain('"id":"sub-1"');
    expect(snapshot).toContain('"id":"sub-2"');
    expect(snapshot).not.toContain('No-ID Board');
  });
});
