import { jest } from '@jest/globals';
import { createObsClarifyChainBroker } from '../extraction/stage6-ask-gate-wrapper.js';
import { createObservationClarificationTerminalDispatcher } from '../extraction/stage6-dispatchers-answer.js';
import { getToolByName } from '../extraction/stage6-tool-schemas.js';

function setup(kind = 'applicability') {
  const broker = createObsClarifyChainBroker();
  const chainId = broker.mint();
  broker.noteAnsweredAfddQuestion(chainId, kind);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const dispatch = createObservationClarificationTerminalDispatcher(
    { sessionId: 'sess-afdd-terminal', obsClarifyChains: broker },
    logger,
    'turn-afdd-terminal'
  );
  return { broker, chainId, logger, dispatch };
}

describe('PLAN-3 AFDD silent clarification terminal', () => {
  test('tool schemas expose the closed AFDD ask-kind enum and two terminal outcomes', () => {
    const askKind = getToolByName('ask_user').input_schema.properties
      .observation_clarification_kind;
    expect(askKind.anyOf[0].enum).toEqual([
      'afdd_topic',
      'afdd_applicability',
      'afdd_premises',
    ]);
    const terminal = getToolByName('resolve_observation_clarification');
    expect(terminal.input_schema.required).toEqual(['clarification_chain_id', 'outcome']);
    expect(terminal.input_schema.properties.outcome.enum).toEqual([
      'afdd_not_applicable',
      'afdd_recommendation_only',
    ]);
  });

  test('same-chain no-write outcome closes active flow without staging speech or mutation', async () => {
    const { broker, chainId, dispatch } = setup();
    const result = await dispatch({
      tool_call_id: 'terminal-1',
      name: 'resolve_observation_clarification',
      input: { clarification_chain_id: chainId, outcome: 'afdd_not_applicable' },
    });

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      code: 'observation_clarification_resolved',
      clarification_chain_id: chainId,
      outcome: 'afdd_not_applicable',
    });
    expect(broker.getActiveAfddFlow()).toBeNull();
  });

  test.each([
    ['wrong chain', { clarification_chain_id: 'invented', outcome: 'afdd_not_applicable' }],
    ['missing chain', { outcome: 'afdd_not_applicable' }],
    ['unknown outcome', { clarification_chain_id: 'CHAIN', outcome: 'severity_unknown' }],
    [
      'outcome does not match the last deciding fact',
      { clarification_chain_id: 'CHAIN', outcome: 'afdd_not_applicable' },
    ],
  ])('%s rejects and leaves the real active flow open', async (_label, input) => {
    const { broker, chainId, dispatch } = setup('premises');
    const resolvedInput = {
      ...input,
      ...(input.clarification_chain_id === 'CHAIN'
        ? { clarification_chain_id: chainId }
        : {}),
    };
    const result = await dispatch({
      tool_call_id: 'terminal-bad',
      name: 'resolve_observation_clarification',
      input: resolvedInput,
    });

    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      ok: false,
      code: 'invalid_observation_clarification_terminal',
    });
    expect(broker.getActiveAfddFlow()).toMatchObject({ chainId });
  });
});
