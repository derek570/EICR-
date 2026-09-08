/**
 * A01P (2026-09-08) — the `client_command` marker through the REAL
 * `initSonnetStream` seam, with the agentic-answers flag OFF.
 *
 * A client that recognised "calculate impedance for all" on a MULTI-board job
 * discards its local parse and forwards the final as an ordinary transcript
 * stamped `client_command: 'calculate_zs'`. That grammar carries no digit and
 * no trigger word, so without the marker the backend gate blocks it as
 * LOW_CONTENT whenever VOICE_AGENTIC_ANSWERS is off (control below). With the
 * marker the transcript reaches the model, which selects Stage 6's
 * `calculate_zs` (scripted here), the dispatcher resolves the CURRENT board,
 * mutates once and the turn carries one read-back.
 *
 * Harness mirrors stage6-clear-board-reading-wire.test.js (real
 * initSonnetStream, fake WS, real session_start seed) with the Anthropic SDK
 * replaced by the scripted-stream helper so the tool loop runs for real.
 */

import { jest } from '@jest/globals';
import { mockClient } from './helpers/mockStream.js';

let scriptedResponses = [];
const streamSpy = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => {
    const client = mockClient(scriptedResponses);
    const realStream = client.messages.stream.bind(client.messages);
    client.messages.stream = (...args) => {
      streamSpy(...args);
      return realStream(...args);
    };
    client.messages.create = jest.fn(async () => ({ content: [], usage: {} }));
    return client;
  }),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

function toolUseRound(toolCalls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_tu', role: 'assistant', content: [] } },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound(text) {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload, callback) => {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
      sent.push(parsed);
      callback?.();
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  Object.defineProperty(ws.send, 'length', { value: 2 });
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler for ${event}`);
    await h(data);
  };
  return ws;
}

/** Two-board job: main (Ze 0.35 board-local) + garage (Ze 0.38), R1+R2 on both. */
const TWO_BOARD_JOB_STATE = {
  certificateType: 'eicr',
  supply_characteristics: { earth_loop_impedance_ze: '0.50' },
  boards: [
    { id: 'main', designation: 'Main DB', board_type: 'main', ze: '0.35' },
    { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution', ze: '0.38' },
  ],
  circuits: [
    { board_id: 'main', circuit_ref: 1, circuit_designation: 'Kitchen Ring', r1_r2_ohm: '0.20' },
    {
      board_id: 'garage',
      circuit_ref: 1,
      circuit_designation: 'Garage Sockets',
      r1_r2_ohm: '0.30',
    },
  ],
};

let wss;
const savedFlag = process.env.VOICE_AGENTIC_ANSWERS;
beforeEach(() => {
  process.env.VOICE_AGENTIC_ANSWERS = 'false';
  streamSpy.mockReset();
  scriptedResponses = [];
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.VOICE_AGENTIC_ANSWERS;
  else process.env.VOICE_AGENTIC_ANSWERS = savedFlag;
  // Real sessions arm real timers (cache keepalive) — stop them so the
  // process exits without --forceExit.
  for (const entry of activeSessions.values()) {
    try {
      entry?.session?.stop?.();
    } catch {
      /* teardown only */
    }
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

const sendFrame = (ws, frame) => ws._emit('message', Buffer.from(JSON.stringify(frame)));

async function startSession(sessionId = 'sess-a01p-cc') {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  await sendFrame(ws, { type: 'session_start', sessionId, jobState: TWO_BOARD_JOB_STATE });
  const entry = activeSessions.get(sessionId);
  expect(entry?.session?.agenticAnswersEnabled).toBe(false);
  return { ws, entry };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

describe('[invariant] client_command through the real seam with VOICE_AGENTIC_ANSWERS off', () => {
  test.each([
    'calculate impedance for all',
    'calculate z s for all',
    'calculate impedance for all.',
  ])(
    '"%s" + client_command calculate_zs → model round runs, calculate_zs resolves the CURRENT board, one mutation, one read-back',
    async (text) => {
      scriptedResponses = [
        toolUseRound([{ id: 'tu_calc', name: 'calculate_zs', input: { all: true } }]),
        endTurnRound('Zs for circuit one is 0.55.'),
      ];
      const { ws, entry } = await startSession();
      expect(entry.session.stateSnapshot.currentBoardId ?? 'main').toBe('main');
      await sendFrame(ws, {
        type: 'transcript',
        text,
        regexResults: [],
        utterance_id: 'utt-cc-1',
        client_command: 'calculate_zs',
      });
      await settle();
      // The model was consulted (forward authority came from the marker).
      expect(streamSpy).toHaveBeenCalled();
      // ONE mutation on the resolved (current = main) board: 0.35 + 0.20.
      expect(entry.session.stateSnapshot.circuits[1].measured_zs_ohm).toBe('0.55');
      // The garage circuit was NOT touched (resolved board, not a sweep).
      expect(entry.session.stateSnapshot.circuits['garage::1']).not.toHaveProperty(
        'measured_zs_ohm'
      );
      // One extraction frame carrying the computed reading and one spoken read-back.
      const extractions = ws._sent.filter((m) => m.type === 'extraction');
      expect(extractions).toHaveLength(1);
      const result = extractions[0].result;
      // The wire reading rides under the legacy `zs` spelling (FIELD_CORRECTIONS
      // outbound), sourced from the tool call, on circuit 1 of the resolved board.
      const computed = (result.readings ?? []).filter(
        (r) => r.field === 'measured_zs_ohm' || r.field === 'zs'
      );
      expect(computed).toHaveLength(1);
      expect(computed[0]).toMatchObject({ circuit: 1, value: '0.55', source: 'tool_call' });
      // Exactly ONE read-back for the one accepted calculation.
      expect(result.confirmations).toHaveLength(1);
      expect(result.confirmations[0]).toMatchObject({ field: 'measured_zs_ohm', circuit: 1 });
      expect(result.confirmations[0].text).toContain('0.55');
    }
  );

  test('control: the SAME unmarked trigger-less transcript is gate-blocked — no model call, no extraction frame', async () => {
    scriptedResponses = [
      toolUseRound([{ id: 'tu_calc', name: 'calculate_zs', input: { all: true } }]),
      endTurnRound('Zs for circuit one is 0.55.'),
    ];
    const { ws, entry } = await startSession('sess-a01p-cc-control');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'calculate impedance for all',
      regexResults: [],
      utterance_id: 'utt-cc-2',
    });
    await settle();
    expect(streamSpy).not.toHaveBeenCalled();
    expect(entry.session.stateSnapshot.circuits[1]).not.toHaveProperty('measured_zs_ohm');
    expect(ws._sent.filter((m) => m.type === 'extraction')).toHaveLength(0);
  });

  test('control: a MALFORMED marker is ignored — still gate-blocked', async () => {
    scriptedResponses = [endTurnRound('unused')];
    const { ws, entry } = await startSession('sess-a01p-cc-malformed');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'calculate impedance for all',
      regexResults: [],
      utterance_id: 'utt-cc-3',
      client_command: 'calculate_impedance',
    });
    await settle();
    expect(streamSpy).not.toHaveBeenCalled();
    expect(entry.session.stateSnapshot.circuits[1]).not.toHaveProperty('measured_zs_ohm');
  });

  test('the marker never reaches the model as a regex hint: the user turn carries no regex-hint context for it', async () => {
    scriptedResponses = [endTurnRound('Okay.')];
    const { ws } = await startSession('sess-a01p-cc-hint');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'calculate impedance for all',
      regexResults: [],
      utterance_id: 'utt-cc-4',
      client_command: 'calculate_zs',
    });
    await settle();
    expect(streamSpy).toHaveBeenCalled();
    const args = streamSpy.mock.calls[0][0];
    const serialised = JSON.stringify(args.messages ?? args);
    expect(serialised).not.toContain('client_command');
    expect(serialised).toContain('calculate impedance for all');
  });
});
