/**
 * §A4 Codex r1-#1 (field-feedback-2026-07-14) — createAutoResolveWriteHook
 * must carry the ask's board scope into the synthesized dispatcher input.
 *
 * The resolvers (resolveValueAnswer / resolveEnumAnswer / the pending-value
 * chain) stamp `board_id` onto their writes per readback-correction-optionb
 * §3.3/§6, but the hook rebuilt synthInput WITHOUT it — so on a multi-board
 * job an auto-resolved reading was validated and written against
 * currentBoardId instead of the board the original ask named, and the
 * per-turn accumulator entry lost its board tag (the bundler then emitted
 * the reading without board_id, landing it on the wrong board's row in iOS).
 */

import { jest } from '@jest/globals';
import { createAutoResolveWriteHook } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

const noopLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

function makeSubBoardSession() {
  return {
    sessionId: 'sess-board-scope',
    stateSnapshot: {
      currentBoardId: 'sub-1',
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_main' },
      ],
      circuits: {
        // Sub-board circuits use composite keys (stage6-multi-board-shape.js).
        'sub-1::2': { circuit_designation: 'Garage sockets' },
      },
    },
  };
}

test('write.board_id reaches the dispatcher: entry lands with the board tag on the accumulator', async () => {
  const session = makeSubBoardSession();
  const perTurnWrites = createPerTurnWrites();
  const hook = createAutoResolveWriteHook(session, noopLogger(), 'turn-1', perTurnWrites);

  const result = await hook(
    {
      tool: 'record_reading',
      field: 'rcd_time_ms',
      circuit: 2,
      value: '26',
      confidence: 1.0,
      source_turn_id: 'turn-1',
      board_id: 'sub-1',
    },
    { toolCallId: 'toolu_scope' }
  );

  expect(result.ok).toBe(true);
  // The accumulator key carries the board tag — the bundler will emit
  // board_id on the wire reading, landing it on the right board's row.
  const taggedKey = encodeReadingKey('rcd_time_ms', 2, 'sub-1');
  expect(perTurnWrites.readings.has(taggedKey)).toBe(true);
  expect(perTurnWrites.readings.get(taggedKey).boardId).toBe('sub-1');
});

test('board_id omitted → single-board synthCall byte-identical (no board tag)', async () => {
  const session = makeSubBoardSession();
  session.stateSnapshot.currentBoardId = 'sub-1';
  const perTurnWrites = createPerTurnWrites();
  const hook = createAutoResolveWriteHook(session, noopLogger(), 'turn-1', perTurnWrites);
  const result = await hook(
    {
      tool: 'record_reading',
      field: 'rcd_time_ms',
      circuit: 2,
      value: '26',
      confidence: 1.0,
      source_turn_id: 'turn-1',
    },
    { toolCallId: 'toolu_noscope' }
  );
  expect(result.ok).toBe(true);
  // Untagged key — pre-fix behaviour preserved when no scope was named.
  expect(perTurnWrites.readings.has(encodeReadingKey('rcd_time_ms', 2))).toBe(true);
});
