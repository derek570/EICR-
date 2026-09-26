/**
 * PLAN-W1 M3 (B-46) — a "yes" to a board-reference ask reaches the model as
 * `board_resolution_escalated`; the dispatcher no longer resolves it to the
 * only main board. The model reads its own blocking ask_user question in the
 * same tool loop and resolves it.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const OPEN_WS = { readyState: 1, OPEN: 1, send() {} };

async function answerBoardAsk(userText) {
  const session = {
    sessionId: 'sess-w1-board',
    stateSnapshot: {
      circuits: { 4: { circuit_designation: 'Garage supply' } },
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'Garage', board_type: 'sub_distribution' },
      ],
    },
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const pendingAsks = createPendingAsksRegistry();
  const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
  const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, OPEN_WS, {
    autoResolveWrite,
  });
  const p = dispatcher(
    {
      tool_call_id: 'toolu_board',
      name: 'ask_user',
      input: {
        question: 'Is circuit 4 feeding the garage board or the main?',
        reason: 'missing_context',
        context_field: 'feeds_board_id',
        context_circuit: 4,
        expected_answer_shape: 'free_text',
      },
    },
    {}
  );
  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_board', { answered: true, user_text: userText });
  const env = await p;
  return { body: JSON.parse(env.content), autoResolveWrite };
}

describe('PLAN-W1 M3 — B-46 affirmative board answer', () => {
  test('"yes" → board_resolution_escalated with the hint and the board list; nothing resolved, nothing written', async () => {
    const { body, autoResolveWrite } = await answerBoardAsk('yes');
    expect(body).toMatchObject({
      answered: true,
      untrusted_user_text: 'yes',
      match_status: 'board_resolution_escalated',
      parsed_hint: 'affirmative_board_answer',
    });
    expect(body.available_boards).toHaveLength(2);
    expect(body.auto_resolved).not.toBe(true);
    expect(body.resolved_board_id).toBeUndefined();
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('control: "the garage" still resolves by designation', async () => {
    const { body } = await answerBoardAsk('the garage');
    expect(body).toMatchObject({ match_status: 'board_resolved', resolved_board_id: 'sub-1' });
  });
});
