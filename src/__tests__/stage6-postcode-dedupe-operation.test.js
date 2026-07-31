import { jest } from '@jest/globals';

import { WIRE_CLIENT_SECTION_DEDUPE_SCOPES } from '../extraction/ios-dedupe-key.js';
import { dispatchRecordBoardReading } from '../extraction/stage6-dispatchers-board.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(currentBoardId = 'main') {
  return {
    sessionId: `sess-${currentBoardId}`,
    stateSnapshot: {
      circuits: { 0: {} },
      boards: [
        { id: 'main', board_type: 'main', circuits: [] },
        { id: 'sub-1', board_type: 'distribution', circuits: [] },
      ],
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

async function writePostcode({
  perTurnWrites,
  session,
  boardId,
  value = 'RG1 5QA',
  callId = 'postcode-write',
  turnId = 'turn-1',
}) {
  const input = {
    field: 'postcode',
    value,
    confidence: 1,
    source_turn_id: turnId,
  };
  if (boardId !== undefined) input.board_id = boardId;
  const result = await dispatchRecordBoardReading(
    { tool_call_id: callId, name: 'record_board_reading', input },
    {
      session,
      logger: makeLogger(),
      turnId,
      perTurnWrites,
      round: 0,
    }
  );
  expect(result.is_error).toBe(false);
}

function postcodeConfirmation(perTurnWrites, turnId) {
  const result = bundleToolCallsIntoResult(
    perTurnWrites,
    { questions: [] },
    { confirmationsEnabled: true, turnId }
  );
  return result.confirmations.find((entry) => entry.field === 'postcode');
}

describe('PLAN-2C postcode dispatcher operation identity', () => {
  test('producer scope manifest is exact and independent from board-clear scope', () => {
    expect(WIRE_CLIENT_SECTION_DEDUPE_SCOPES).toEqual({ postcode: 'global' });
  });

  test('unscoped and explicit board spellings mint the same global operation token', async () => {
    const unscopedWrites = createPerTurnWrites();
    await writePostcode({
      perTurnWrites: unscopedWrites,
      session: makeSession('main'),
    });

    const explicitWrites = createPerTurnWrites();
    await writePostcode({
      perTurnWrites: explicitWrites,
      session: makeSession('sub-1'),
      boardId: 'sub-1',
    });

    expect(postcodeConfirmation(unscopedWrites, 'turn-1').dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord0'
    );
    expect(postcodeConfirmation(explicitWrites, 'turn-1').dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord0'
    );
  });

  test('fresh replay is stable; later turn and second same-turn operation are distinct', async () => {
    const first = createPerTurnWrites();
    await writePostcode({ perTurnWrites: first, session: makeSession() });

    const replay = createPerTurnWrites();
    await writePostcode({ perTurnWrites: replay, session: makeSession() });

    const sameTurnRewrite = createPerTurnWrites();
    const rewriteSession = makeSession();
    await writePostcode({
      perTurnWrites: sameTurnRewrite,
      session: rewriteSession,
      callId: 'postcode-write-1',
    });
    await writePostcode({
      perTurnWrites: sameTurnRewrite,
      session: rewriteSession,
      callId: 'postcode-write-2',
    });

    const later = createPerTurnWrites();
    await writePostcode({
      perTurnWrites: later,
      session: makeSession(),
      turnId: 'turn-2',
    });

    expect(postcodeConfirmation(first, 'turn-1').dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord0'
    );
    expect(postcodeConfirmation(replay, 'turn-1').dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord0'
    );
    expect(postcodeConfirmation(sameTurnRewrite, 'turn-1').dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord1'
    );
    expect(postcodeConfirmation(later, 'turn-2').dedupe_token).toBe(
      'secfield_postcode_global_turn-2_ord0'
    );
  });
});
