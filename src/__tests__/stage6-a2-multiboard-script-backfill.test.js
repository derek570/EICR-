/**
 * A2-multiboard (2026-07-28) — the `start_dialogue_script` backfill's
 * precedence guard is keyed on the EFFECTIVE slot, not the raw Map key.
 *
 * `start_dialogue_script` declares no `board_id`, so the backfill's Map key is
 * `encodeReadingKey(field, ref, undefined)` — the SAME string on every board.
 * Its guard ("skip if something already wrote this slot this turn") was
 * therefore board-blind: a `record_reading` on one board suppressed the script
 * backfill for the SAME field+ref on a DIFFERENT board, and that board's value
 * never reached `extracted_readings` at all. Spoken-but-not-written — the class
 * Audio-First #1 exists to prevent, and precisely the raw-key ambiguity the
 * write journal was introduced to make decidable.
 *
 * The guard is a DEFENSIVE dedupe (Sonnet rarely double-emits a slot), not a
 * correctness filter, so it must never fire across boards. `projectReadingWinners`
 * is the one authoritative answer to "is this effective slot occupied?" — the
 * journal module's own docstring already names this backfill as one of its
 * consumers.
 */

import { jest } from '@jest/globals';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';
import { dispatchRecordReading } from '../extraction/stage6-dispatchers-circuit.js';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function ctx(session, perTurnWrites, callId) {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0, callId };
}

function session(currentBoardId) {
  return {
    sessionId: 'a2mb-script-backfill',
    stateSnapshot: {
      // Circuit 1 exists on BOTH boards: the legacy bare-numeric key is main's,
      // the composite key is the sub-board's (the dual-shape convention).
      circuits: {
        1: {},
        'sub-b::1': { board_id: 'sub-b', circuit: 1 },
      },
      boards: MULTI_BOARD,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

/** An omitted-`board_id` write — the shape the model actually emits. */
function unscopedWrite(s, p, callId, value) {
  return dispatchRecordReading(
    {
      tool_call_id: callId,
      name: 'record_reading',
      input: {
        field: 'ring_r1_ohm',
        circuit: 1,
        value,
        confidence: 0.9,
        source_turn_id: 't1',
      },
    },
    ctx(s, p, callId)
  );
}

function seedScript(s, p, value) {
  return dispatchStartDialogueScript(
    {
      tool_call_id: 'sds1',
      name: 'start_dialogue_script',
      input: {
        schema: 'ring_continuity',
        circuit: 1,
        source_turn_id: 't1',
        reason: 'inspector dictated a ring reading',
        pending_writes: [{ field: 'ring_r1_ohm', value }],
      },
    },
    { session: s, logger: mockLogger(), turnId: 't1', round: 1, perTurnWrites: p }
  );
}

const r1Of = (r) => r.extracted_readings.filter((x) => x.field === 'ring_r1_ohm');

describe('A2-multiboard — script backfill precedence is per EFFECTIVE slot', () => {
  test('DISCRIMINATING: a sub-board record_reading does not suppress a main-board script seed', async () => {
    // The turn: dictate a ring R1 on the sub-board, then `select_board main`,
    // then enter the ring script on main with its own seeded value. Both calls
    // omit `board_id`, so both land on the SAME raw Map key — the collision the
    // old guard could not see through.
    const s = session('sub-b');
    const p = createPerTurnWrites();

    await unscopedWrite(s, p, 'w1', '0.42');
    // `select_board main` — the dispatcher mutates `currentBoardId`, the only
    // input to the following call's effective-board resolution.
    s.stateSnapshot.currentBoardId = 'main';
    const res = await seedScript(s, p, '0.85');
    expect(JSON.parse(res.content).seeded_writes).toEqual(['ring_r1_ohm']);

    const r1 = r1Of(bundle(p));
    // Pre-fix this was length 1: the raw-key guard matched the sub-board write
    // and skipped the main-board backfill outright, so main's 0.85 never
    // reached the wire even though the script had already applied it and will
    // read it back aloud.
    expect(r1).toHaveLength(2);
    expect(r1.find((x) => x.value === '0.42').board_id).toBe('sub-b');
    expect(r1.find((x) => x.value === '0.85').board_id).toBe('main');
  });

  test('the SAME effective slot is still deduped — the defensive guard is intact', async () => {
    // Same field, same ref, same board, no `select_board` in between. The
    // backfill must still yield to the earlier `record_reading` rather than
    // overwriting it with the script's copy.
    const s = session('main');
    const p = createPerTurnWrites();

    await unscopedWrite(s, p, 'w1', '0.42');
    await seedScript(s, p, '0.85');

    const r1 = r1Of(bundle(p));
    expect(r1).toHaveLength(1);
    expect(r1[0].value).toBe('0.42');
  });

  test('the Map key and the wire bytes are unchanged for a single-board turn', async () => {
    // The fix changes only WHICH writes are skipped — never how a surviving
    // write is keyed or serialised. `encodeReadingKey(..., undefined)` is still
    // what the backfill stores under, and a single-board turn grows no
    // `board_id` (the enrichment rule is cross-board-only for ordinary reads).
    const s = session('main');
    const p = createPerTurnWrites();

    await seedScript(s, p, '0.85');

    expect(p.readings.has(encodeReadingKey('ring_r1_ohm', 1, undefined))).toBe(true);
    const r1 = r1Of(bundle(p));
    expect(r1).toHaveLength(1);
    expect(Object.hasOwn(r1[0], 'board_id')).toBe(false);
  });
});

function bundle(perTurnWrites) {
  return bundleToolCallsIntoResult(perTurnWrites, null, {
    confirmationsEnabled: true,
    turnId: 't1',
  });
}
