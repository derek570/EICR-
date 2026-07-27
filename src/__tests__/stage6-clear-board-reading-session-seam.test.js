/**
 * Plan A1a + Codex diff-review r1 — the REAL sonnet-stream session seam:
 * session_start capability parse → active-session entry → live dispatcher →
 * REAL immediate emission (the §3.4c ledger), plus the reconnect capability
 * RE-PARSE (r5-#2 rebind-write-back precedent).
 *
 * These are the legs the harness-level suites cannot see: a regression that
 * drops parsed capabilities while building the real entry, a reconnect that
 * retains a stale advert, or the immediate path ceasing to emit the
 * standalone board field_corrected frame (with the post-canonicalisation
 * 'pfc' wire name) after the extraction envelope.
 *
 * Harness mirrors plan-c-p4d-batch-frames.test.js (real initSonnetStream +
 * fake WS + real handlers); ONLY runToolLoop is mocked, and its mock
 * dispatches the REAL composed dispatcher so capability threading,
 * validation order, mutation and bundling all run for real.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: mockCreate } })),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const runToolLoopSpy = jest.fn();
jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => {
      try {
        sent.push(JSON.parse(payload));
      } catch {
        sent.push(payload);
      }
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler for ${event}`);
    await h(data);
  };
  return ws;
}

let wss;
beforeEach(() => {
  mockCreate.mockReset();
  runToolLoopSpy.mockReset();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  for (const entry of activeSessions.values()) {
    try {
      entry.session?.stop?.();
    } catch {
      /* already stopped */
    }
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

function connect() {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  return ws;
}
const sendFrame = (ws, frame) => ws._emit('message', Buffer.from(JSON.stringify(frame)));

/** session_start with an OPTIONAL voice-latency capabilities block. */
async function startSession(ws, { supports } = {}) {
  await sendFrame(ws, {
    type: 'session_start',
    sessionId: 'sess-seam',
    protocol_version: 'stage6',
    jobState: { certificateType: 'eicr' },
    ...(supports !== undefined
      ? { capabilities: { voice_latency: { version: 1, supports } } }
      : {}),
  });
  return activeSessions.get('sess-seam');
}

/** Mock the loop to dispatch the given real calls through opts.dispatcher. */
function loopDispatching(calls) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (const c of calls) {
      const env = await opts.dispatcher(
        { tool_call_id: c.id, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({ tool_call_id: c.id, name: c.name, input: c.input, result: env });
    }
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: toolCalls,
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

async function sendClearTranscript(ws, field, text = 'Delete that reading.') {
  loopDispatching([
    {
      id: 'toolu_seam_clear',
      name: 'clear_board_reading',
      input: { field, reason: 'user_correction' },
    },
  ]);
  await sendFrame(ws, {
    type: 'transcript',
    text,
    utterance_id: 'utt-seam-1',
    confirmations_enabled: true,
    // Non-empty regex hints take the gate's HAS_REGEX_HINT bypass so the
    // test exercises the emission seam, not gate phrasing.
    regexResults: [{ field }],
  });
}

describe('REAL session seam — capability parse, live emission bytes, reconnect re-parse', () => {
  test('capable session_start → clear mutates; the standalone field_corrected frame carries the POST-canonicalisation pfc name AFTER the extraction envelope', async () => {
    const ws = connect();
    const entry = await startSession(ws, { supports: ['board_clear_v1'] });
    entry.session.start(null);
    entry.session.stateSnapshot.circuits[0] = { prospective_fault_current: '2.3' };

    await sendClearTranscript(ws, 'prospective_fault_current');

    // Mutation really happened through the REAL parse→entry→dispatcher chain
    // (deny-first means this is only possible when the capability landed).
    expect(entry.session.stateSnapshot.circuits[0]).not.toHaveProperty('prospective_fault_current');
    // Wire bytes: the §3.4b frame, POST-canonicalisation name, after the
    // extraction envelope.
    const types = ws._sent.map((f) => f.type);
    const extractionIdx = types.indexOf('extraction');
    const fcIdx = types.indexOf('field_corrected');
    expect(extractionIdx).toBeGreaterThanOrEqual(0);
    expect(fcIdx).toBeGreaterThan(extractionIdx);
    const frame = ws._sent[fcIdx];
    expect(frame).toEqual({
      type: 'field_corrected',
      circuit: null,
      field: 'pfc',
      previous_value: '2.3',
      reason: 'clear_reading',
      board_id: 'main',
    });
    // The spoken clear rides the extraction envelope's confirmations.
    const extraction = ws._sent[extractionIdx];
    expect(
      (extraction.result.confirmations ?? []).some(
        (c) => c.field === 'field_cleared' && /cleared/i.test(c.text)
      )
    ).toBe(true);
  });

  test('select_board board-op leg: current_board_changed rides BETWEEN the extraction envelope and the field_corrected frame (ledger order on the live path)', async () => {
    const ws = connect();
    const entry = await startSession(ws, { supports: ['board_clear_v1'] });
    entry.session.start(null);
    entry.session.stateSnapshot.boards = [
      { id: 'main', designation: 'Main DB', board_type: 'main' },
      {
        id: 'garage',
        designation: 'Garage CU',
        board_type: 'sub_distribution',
        manufacturer: 'Wylex',
      },
    ];
    loopDispatching([
      { id: 'toolu_sel', name: 'select_board', input: { board_id: 'garage' } },
      {
        id: 'toolu_clear',
        name: 'clear_board_reading',
        input: { field: 'manufacturer', reason: 'user_correction' },
      },
    ]);
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Switch to the garage board and delete the manufacturer.',
      utterance_id: 'utt-seam-2',
      confirmations_enabled: true,
      regexResults: [{ field: 'manufacturer' }],
    });
    const extractionIdx = ws._sent.findIndex((f) => f.type === 'extraction');
    // The session_start handler emits its own current_board_changed banner
    // (source 'session_start') BEFORE any turn — the ledger's frame is the
    // source-'sonnet' one.
    const cbcIdx = ws._sent.findIndex(
      (f) => f.type === 'current_board_changed' && f.source === 'sonnet'
    );
    const fcIdx = ws._sent.findIndex((f) => f.type === 'field_corrected');
    expect(extractionIdx).toBeGreaterThanOrEqual(0);
    expect(cbcIdx).toBeGreaterThan(extractionIdx);
    expect(fcIdx).toBeGreaterThan(cbcIdx);
    expect(ws._sent[fcIdx].board_id).toBe('garage');
  });

  test('capability ABSENT and MALFORMED session_starts both DENY through the real chain', async () => {
    for (const supports of [[], 'board_clear_v1', undefined]) {
      activeSessions.clear();
      sonnetSessionStore.clear();
      const ws = connect();
      const entry = await startSession(ws, supports === undefined ? {} : { supports });
      entry.session.start(null);
      entry.session.stateSnapshot.circuits[0] = { ze: '0.4' };
      await sendClearTranscript(ws, 'ze');
      expect(entry.session.stateSnapshot.circuits[0].ze).toBe('0.4');
      expect(ws._sent.some((f) => f.type === 'field_corrected')).toBe(false);
      entry.session.stop();
    }
  });

  test('RECONNECT RE-PARSE: capable → downgraded reconnect is DENIED; a later capable reconnect re-authorises', async () => {
    const wsA = connect();
    const entry = await startSession(wsA, { supports: ['board_clear_v1'] });
    entry.session.start(null);
    entry.session.stateSnapshot.circuits[0] = { ze: '0.4', earth_loop_impedance_ze: '0.4' };

    // Reconnect with the capability REMOVED (block present, empty supports)
    // — the rebind must re-parse and revoke mutation authority.
    const wsB = connect();
    await startSession(wsB, { supports: [] });
    await sendClearTranscript(wsB, 'ze');
    expect(entry.session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(wsB._sent.some((f) => f.type === 'field_corrected')).toBe(false);

    // Reconnect capable again — authority restored, the clear mutates.
    const wsC = connect();
    await startSession(wsC, { supports: ['board_clear_v1'] });
    await sendClearTranscript(wsC, 'ze');
    expect(entry.session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(wsC._sent.some((f) => f.type === 'field_corrected')).toBe(true);
  });

  test('reconnect frame that OMITS the capabilities block is DENY-FIRST: the stale advert is revoked (mini-review M1)', async () => {
    const wsA = connect();
    const entry = await startSession(wsA, { supports: ['board_clear_v1'] });
    entry.session.start(null);
    entry.session.stateSnapshot.circuits[0] = { ze: '0.4' };
    const wsB = connect();
    await startSession(wsB, {}); // no capabilities key at all
    await sendClearTranscript(wsB, 'ze');
    // An omitted block re-parses to the empty/deny shape — a client that
    // stops advertising (or never could) must not retain destructive-clear
    // authority from a stale construction-time parse.
    expect(entry.session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(wsB._sent.some((f) => f.type === 'field_corrected')).toBe(false);
  });
});
