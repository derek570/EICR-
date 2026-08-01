import { jest } from '@jest/globals';

import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

function mirrorCall(id = 'toolu-mirror-1') {
  return {
    tool_call_id: id,
    name: 'ask_user',
    input: {
      question: 'Use the same address for the client?',
      reason: 'missing_context',
      context_field: 'client_address',
      context_circuit: null,
      expected_answer_shape: 'yes_no',
      purpose: 'address_mirror',
    },
  };
}

function openWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('address mirror ask dispatcher boundary', () => {
  test('durable claim precedes registration/send and purpose survives the wire', async () => {
    const order = [];
    const pendingAsks = createPendingAsksRegistry();
    const originalRegister = pendingAsks.register;
    pendingAsks.register = (...args) => {
      order.push('register');
      return originalRegister(...args);
    };
    const ws = openWs();
    const controller = {
      claimLiveAsk: jest.fn(async () => {
        order.push('claim');
        return { ok: true };
      }),
      resolveLiveAnswer: jest.fn(async () => ({
        handled: true,
        outcome: 'yes',
        changed: ['client_address', 'client_postcode'],
        replayedSource: 0,
      })),
    };
    const dispatcher = createAskDispatcher(
      { sessionId: 'sess-mirror', stateSnapshot: { circuits: { 0: {} } } },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      'turn-mirror',
      pendingAsks,
      ws,
      { addressMirrorController: controller }
    );

    const promise = dispatcher(mirrorCall(), {});
    await tick();
    expect(order).toEqual(['claim', 'register']);
    expect(ws.sent).toEqual([
      expect.objectContaining({
        type: 'ask_user_started',
        tool_call_id: 'toolu-mirror-1',
        purpose: 'address_mirror',
      }),
    ]);
    pendingAsks.resolve('toolu-mirror-1', { answered: true, user_text: 'yes' });
    const envelope = await promise;
    expect(JSON.parse(envelope.content)).toEqual({
      answered: true,
      address_mirror: 'yes',
      changed_fields: ['client_address', 'client_postcode'],
      source_replay_count: 0,
    });
  });

  test('failed durable claim registers and emits nothing', async () => {
    const pendingAsks = createPendingAsksRegistry();
    const ws = openWs();
    const dispatcher = createAskDispatcher(
      { sessionId: 'sess-mirror', stateSnapshot: { circuits: { 0: {} } } },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      'turn-mirror',
      pendingAsks,
      ws,
      {
        addressMirrorController: {
          claimLiveAsk: jest.fn(async () => ({ ok: false, reason: 'source_incomplete' })),
        },
      }
    );
    const envelope = await dispatcher(mirrorCall('toolu-mirror-2'), {});
    expect(pendingAsks.size).toBe(0);
    expect(ws.sent).toEqual([]);
    expect(JSON.parse(envelope.content)).toMatchObject({
      answered: false,
      reason: 'address_mirror_not_claimed',
      disposition: 'source_incomplete',
    });
  });
});
