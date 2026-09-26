/**
 * PLAN-B (feedback-2026-09-17, B2) — repeat visibility for the model's asks.
 *
 * The ask budget is gone (Decision 3). In its place: the ask dispatcher emits
 * `match_status: 'value_escalated'` when the value resolver could not parse a
 * reply, a per-session counter classifies unusable replies, and on the second
 * one the ask's MODEL-FACING tool result gains `[Server note: repeat_ask. …]`.
 * Nothing is blocked: a third ask still dispatches.
 *
 * Covers acceptance 2 (classifier table, note in round two's tool result,
 * third ask dispatches, no ask_budget_exhausted anywhere) and the
 * real-dispatch half of acceptance 10 (the dispatcher itself emits the body,
 * never a hand-built one).
 */

import { jest } from '@jest/globals';

import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import {
  attachCarriedRepeatAskNote,
  classifyAskReply,
  createRepeatAskTracker,
  renderRepeatAskNote,
  REPEAT_ASK_NOTE_THRESHOLD,
} from '../extraction/stage6-repeat-ask.js';
import {
  createPerTurnWrites,
  EFFECTIVE_CIRCUIT_SLOT,
  EFFECTIVE_BOARD_SLOT,
} from '../extraction/stage6-per-turn-writes.js';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';
import { ASK_USER_TIMEOUT_MS } from '../extraction/stage6-dispatcher-ask.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { mockClient } from './helpers/mockStream.js';
import {
  makeLogger,
  makeLiveSession,
  makeOpenWs,
  toolUseRound,
  endTurnRound,
} from './helpers/f7-audibility-matrix.js';

const OPEN_WS = { readyState: 1, OPEN: 1, send() {} };

const zsAsk = (overrides = {}) => ({
  question: 'What was the Zs on circuit 3?',
  reason: 'missing_value',
  context_field: 'measured_zs_ohm',
  context_circuit: 3,
  expected_answer_shape: 'number',
  ...overrides,
});

const envelope = (body) => ({ tool_use_id: 't', content: JSON.stringify(body), is_error: false });

// runToolLoop pushes onto ONE messages array across rounds, and mockClient
// records a reference to it, so snapshot each request's messages at call time.
function snapshottingClient(rounds) {
  const inner = mockClient(rounds);
  const snapshots = [];
  return {
    snapshots,
    messages: {
      stream(args) {
        snapshots.push(JSON.parse(JSON.stringify(args.messages)));
        return inner.messages.stream(args);
      },
    },
  };
}

function lastToolResultText(messages) {
  const last = messages[messages.length - 1];
  return Array.isArray(last?.content)
    ? last.content.map((b) => b.content ?? b.text).join('\n')
    : '';
}

// Drive the REAL ask dispatcher: register, answer, return the emitted body.
async function dispatchAndAnswer(userText, input = zsAsk()) {
  const pendingAsks = createPendingAsksRegistry();
  const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true, body: { ok: true } });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const session = {
    sessionId: 'sess-repeat-ask-unit',
    stateSnapshot: { circuits: { 3: { designation: 'Sockets' } } },
  };
  const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, OPEN_WS, {
    autoResolveWrite,
  });
  const p = dispatcher({ tool_call_id: 'toolu_rep', name: 'ask_user', input }, {});
  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_rep', { answered: true, user_text: userText });
  const env = await p;
  return { env, body: JSON.parse(env.content), autoResolveWrite };
}

describe('ask dispatcher emits value_escalated from the real resolver (acceptance 2 / 10)', () => {
  test('no numeric in the reply → value_escalated + parsed_hint no_numeric_in_reply, no write', async () => {
    const { body, autoResolveWrite } = await dispatchAndAnswer('erm hang on a second');
    expect(body).toEqual({
      answered: true,
      untrusted_user_text: 'erm hang on a second',
      match_status: 'value_escalated',
      parsed_hint: 'no_numeric_in_reply',
    });
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('two distinct numerics with no correction marker → value_escalated + multiple_numerics hint', async () => {
    const { body, autoResolveWrite } = await dispatchAndAnswer('0.21 or 0.47');
    expect(body.match_status).toBe('value_escalated');
    expect(body.parsed_hint).toBe('multiple_numerics:0.21,0.47');
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('a single numeric still auto-resolves (value_resolved) — escalation is not recorded', async () => {
    const { body, autoResolveWrite } = await dispatchAndAnswer('0.47');
    expect(body.match_status).toBe('value_resolved');
    expect(autoResolveWrite).toHaveBeenCalledTimes(1);
  });

  test('an ask with no context_circuit keeps the legacy bare body (the value resolver does not escalate)', async () => {
    const { body } = await dispatchAndAnswer('the kitchen one', zsAsk({ context_circuit: null }));
    expect(body.match_status).not.toBe('value_escalated');
  });
});

describe('classifyAskReply — the plan classifier table', () => {
  const input = zsAsk();
  test.each([
    ['timeout', { answered: false, reason: 'timeout' }],
    ['user_moved_on', { answered: false, reason: 'user_moved_on' }],
    [
      'no_numeric_in_reply',
      {
        answered: true,
        untrusted_user_text: 'erm',
        match_status: 'value_escalated',
        parsed_hint: 'no_numeric_in_reply',
      },
    ],
    [
      'multiple_numerics:0.21,0.47',
      {
        answered: true,
        untrusted_user_text: '0.21 0.47',
        match_status: 'value_escalated',
        parsed_hint: 'multiple_numerics:0.21,0.47',
      },
    ],
    // PLAN-W1 M2b — the two new sole-value hints.
    [
      'reply_not_value_only',
      {
        answered: true,
        untrusted_user_text: '0.47 I think',
        match_status: 'value_escalated',
        parsed_hint: 'reply_not_value_only',
      },
    ],
    [
      'unit_mismatch:milliseconds',
      {
        answered: true,
        untrusted_user_text: '25 milliseconds',
        match_status: 'value_escalated',
        parsed_hint: 'unit_mismatch:milliseconds',
      },
    ],
  ])('%s counts as unusable', (_label, body) => {
    const verdict = classifyAskReply({
      input,
      result: envelope(body),
      perTurnWrites: createPerTurnWrites(),
    });
    expect(verdict.kind).toBe('unusable');
  });

  test.each([
    [
      'invalid_value (PLAN-C3 owns enum rejections)',
      { answered: true, match_status: 'invalid_value' },
    ],
    ['did_you_mean', { answered: true, match_status: 'did_you_mean' }],
    ['gated (never reached the inspector)', { answered: false, reason: 'gated' }],
    ['afdd_flow_violation', { answered: false, reason: 'afdd_flow_violation' }],
  ])('%s is ignored — the counter does not move', (_label, body) => {
    const verdict = classifyAskReply({
      input,
      result: envelope(body),
      perTurnWrites: createPerTurnWrites(),
    });
    expect(verdict.kind).toBe('ignored');
  });

  test('a value_escalated reply is USABLE when the asked slot was already written this turn', () => {
    const ptw = createPerTurnWrites();
    ptw.readings.set('measured_zs_ohm::3', { field: 'measured_zs_ohm', circuit: 3, value: '0.4' });
    const verdict = classifyAskReply({
      input,
      result: envelope({
        answered: true,
        untrusted_user_text: 'erm',
        match_status: 'value_escalated',
        parsed_hint: 'no_numeric_in_reply',
      }),
      perTurnWrites: ptw,
    });
    expect(verdict.kind).toBe('usable');
  });

  test('a write to the same field and circuit on ANOTHER board does not make the reply usable (B-review #2)', () => {
    const ptw = createPerTurnWrites();
    const d = { field: 'measured_zs_ohm', circuit: 3, value: '0.4' };
    Object.defineProperty(d, EFFECTIVE_CIRCUIT_SLOT, {
      value: { field: 'measured_zs_ohm', circuit: 3, boardId: 'main' },
      enumerable: false,
    });
    ptw.readings.set('measured_zs_ohm::3::main', d);
    const verdict = classifyAskReply({
      input: { ...input, context_board_id: 'sub-1' },
      result: envelope({
        answered: true,
        untrusted_user_text: 'erm',
        match_status: 'value_escalated',
        parsed_hint: 'no_numeric_in_reply',
      }),
      perTurnWrites: ptw,
      currentBoardId: 'main',
    });
    expect(verdict.kind).toBe('unusable');
    // …while the same board makes it usable.
    const same = classifyAskReply({
      input: { ...input, context_board_id: 'main' },
      result: envelope({
        answered: true,
        untrusted_user_text: 'erm',
        match_status: 'value_escalated',
        parsed_hint: 'no_numeric_in_reply',
      }),
      perTurnWrites: ptw,
      currentBoardId: 'main',
    });
    expect(same.kind).toBe('usable');
  });

  test('a board-level ask checks the board-reading winners', () => {
    const ptw = createPerTurnWrites();
    const v = { field: 'ze', value: '0.3' };
    Object.defineProperty(v, EFFECTIVE_BOARD_SLOT, {
      value: { field: 'ze', boardId: null },
      enumerable: false,
    });
    ptw.boardReadings.set('ze', v);
    const verdict = classifyAskReply({
      input: {
        question: 'Ze?',
        context_field: 'ze',
        context_circuit: null,
        expected_answer_shape: 'number',
      },
      result: envelope({
        answered: true,
        untrusted_user_text: 'erm',
        match_status: 'value_escalated',
        parsed_hint: 'no_numeric_in_reply',
      }),
      perTurnWrites: ptw,
    });
    expect(verdict.kind).toBe('usable');
  });

  test('a resolved answer is usable', () => {
    const verdict = classifyAskReply({
      input,
      result: envelope({ answered: true, match_status: 'value_resolved' }),
      perTurnWrites: createPerTurnWrites(),
    });
    expect(verdict.kind).toBe('usable');
  });
});

describe('createRepeatAskTracker', () => {
  const unusable = envelope({
    answered: true,
    untrusted_user_text: 'erm',
    match_status: 'value_escalated',
    parsed_hint: 'no_numeric_in_reply',
  });

  test('the note is produced on the SECOND unusable reply only; the third counts without a new note', () => {
    const tracker = createRepeatAskTracker();
    const ptw = createPerTurnWrites();
    const first = tracker.observe({ input: zsAsk(), result: unusable, perTurnWrites: ptw });
    const second = tracker.observe({
      input: zsAsk(),
      result: envelope({ answered: false, reason: 'timeout' }),
      perTurnWrites: ptw,
    });
    const third = tracker.observe({ input: zsAsk(), result: unusable, perTurnWrites: ptw });
    expect(first).toMatchObject({ count: 1, note: null });
    expect(second.count).toBe(REPEAT_ASK_NOTE_THRESHOLD);
    expect(second.note.startsWith('[Server note: repeat_ask.')).toBe(true);
    expect(JSON.parse(second.note.slice(second.note.indexOf('] ') + 2))).toEqual({
      field: 'measured_zs_ohm',
      circuit: 3,
      replies: [
        { outcome: 'answered', text: 'erm', parsed_hint: 'no_numeric_in_reply' },
        { outcome: 'timeout' },
      ],
    });
    expect(third).toMatchObject({ count: 3, note: null });
  });

  test('a usable answer resets the key', () => {
    const tracker = createRepeatAskTracker();
    const ptw = createPerTurnWrites();
    tracker.observe({ input: zsAsk(), result: unusable, perTurnWrites: ptw });
    tracker.observe({
      input: zsAsk(),
      result: envelope({ answered: true, match_status: 'value_resolved' }),
      perTurnWrites: ptw,
    });
    expect(tracker.countFor(zsAsk())).toBe(0);
    expect(
      tracker.observe({ input: zsAsk(), result: unusable, perTurnWrites: ptw }).note
    ).toBeNull();
  });

  test('different circuits keep separate counts', () => {
    const tracker = createRepeatAskTracker();
    const ptw = createPerTurnWrites();
    tracker.observe({ input: zsAsk(), result: unusable, perTurnWrites: ptw });
    const other = tracker.observe({
      input: zsAsk({ context_circuit: 4 }),
      result: unusable,
      perTurnWrites: ptw,
    });
    expect(other).toMatchObject({ count: 1, note: null });
  });

  test('renderRepeatAskNote names the board when the ask carried one', () => {
    const note = renderRepeatAskNote({
      input: zsAsk({ context_board_id: 'sub-1' }),
      replies: [{ outcome: 'timeout' }],
    });
    expect(note).toContain('"board_id":"sub-1"');
  });
});

describe('runToolLoop augmentToolResult hook', () => {
  test('appends to the MODEL-facing tool_result only; the caller-facing envelope is unchanged', async () => {
    const client = snapshottingClient([
      toolUseRound([{ id: 'toolu_a', name: 'ask_user', input: zsAsk() }]),
      endTurnRound('ok'),
    ]);
    const dispatcher = async (call) =>
      envelope({ answered: false, reason: 'timeout', id: call.tool_call_id });
    const out = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 's', turnId: 't' },
      augmentToolResult: (call) =>
        call.name === 'ask_user' ? '[Server note: repeat_ask. x] {}' : null,
    });
    expect(
      lastToolResultText(client.snapshots[1]).endsWith('\n[Server note: repeat_ask. x] {}')
    ).toBe(true);
    expect(() => JSON.parse(out.tool_calls[0].result.content)).not.toThrow();
  });

  test('a throwing hook is ignored and the content is left as dispatched', async () => {
    const client = snapshottingClient([
      toolUseRound([{ id: 'toolu_b', name: 'ask_user', input: zsAsk() }]),
      endTurnRound('ok'),
    ]);
    const logger = makeLogger();
    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher: async () => envelope({ answered: false, reason: 'timeout' }),
      ctx: { sessionId: 's', turnId: 't' },
      logger,
      augmentToolResult: () => {
        throw new Error('boom');
      },
    });
    expect(lastToolResultText(client.snapshots[1])).toBe(
      JSON.stringify({ answered: false, reason: 'timeout' })
    );
    expect(logger.warn.mock.calls.some(([n]) => n === 'stage6.tool_result_augment_error')).toBe(
      true
    );
  });
});

describe('harness: the note reaches the model in round two, and a third ask still dispatches (acceptance 2)', () => {
  const SESSION_ID = 'sess-repeat-ask-harness';
  const MAX_ADVANCE_MS = 3 * (QUESTION_GATE_DELAY_MS + 500) + ASK_USER_TIMEOUT_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    activeSessions.set(SESSION_ID, {
      session: { sessionId: SESSION_ID },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    activeSessions.delete(SESSION_ID);
  });

  async function drive(session, opts, answers) {
    const answerMap = new Map(Object.entries(answers));
    let settled = false;
    let value;
    let error;
    const p = runShadowHarness(session, 'Zs on circuit 3', [], opts).then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        error = e;
      }
    );
    await jest.advanceTimersByTimeAsync(0);
    let elapsed = 0;
    while (!settled && elapsed <= MAX_ADVANCE_MS) {
      for (const [id, payload] of [...answerMap]) {
        if (opts.pendingAsks.resolve(id, payload)) answerMap.delete(id);
      }
      await jest.advanceTimersByTimeAsync(250);
      elapsed += 250;
    }
    await jest.advanceTimersByTimeAsync(0);
    await p;
    if (error) throw error;
    return value;
  }

  test('second unusable reply → round three sees the note; the third ask is dispatched', async () => {
    const client = snapshottingClient([
      toolUseRound([{ id: 'toolu_r1', name: 'ask_user', input: zsAsk() }]),
      toolUseRound([{ id: 'toolu_r2', name: 'ask_user', input: zsAsk() }]),
      toolUseRound([{ id: 'toolu_r3', name: 'ask_user', input: zsAsk() }]),
      endTurnRound('done'),
    ]);
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client,
      stateSnapshot: {
        circuits: { 3: { designation: 'Sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    });
    const ws = makeOpenWs();
    const logger = makeLogger();
    const opts = {
      logger,
      pendingAsks: createPendingAsksRegistry(),
      ws,
      confirmationsEnabled: true,
    };
    await drive(session, opts, {
      toolu_r1: { answered: true, user_text: 'erm hang on' },
      toolu_r2: { answered: true, user_text: 'sorry what' },
      toolu_r3: { answered: true, user_text: 'nought point four seven' },
    });

    const toolResultContent = (callIdx) => lastToolResultText(client.snapshots[callIdx]);
    // Round 2 saw the first reply only — no note yet.
    expect(toolResultContent(1)).not.toContain('[Server note: repeat_ask.');
    // Round 3 is the model's next round after the SECOND unusable reply.
    expect(toolResultContent(2)).toContain('[Server note: repeat_ask.');
    expect(toolResultContent(2)).toContain('"replies"');
    // The third ask was emitted to the inspector — nothing blocks it.
    const askFrames = ws.sent.filter((f) => f.type === 'ask_user_started');
    expect(askFrames.map((f) => f.tool_call_id)).toEqual(['toolu_r1', 'toolu_r2', 'toolu_r3']);
    // Telemetry: the repeat is logged; no budget outcome exists anywhere.
    const rows = logger.info.mock.calls;
    expect(
      rows.some(([n, m]) => n === 'stage6.repeat_ask' && m.count === 2 && m.note_appended)
    ).toBe(true);
    const outcomes = rows.filter(([n]) => n === 'stage6.ask_user').map(([, m]) => m.answer_outcome);
    expect(outcomes).not.toContain('ask_budget_exhausted');
    expect(outcomes).not.toContain('restrained_mode');
  });

  test('a generation that fails on the round that would read the note carries it to the next turn', async () => {
    const inner = snapshottingClient([
      toolUseRound([{ id: 'toolu_c1', name: 'ask_user', input: zsAsk() }]),
      toolUseRound([{ id: 'toolu_c2', name: 'ask_user', input: zsAsk() }]),
    ]);
    let calls = 0;
    const client = {
      messages: {
        stream(args) {
          calls += 1;
          if (calls === 3) throw new Error('provider unavailable');
          return inner.messages.stream(args);
        },
      },
    };
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client,
      stateSnapshot: {
        circuits: { 3: { designation: 'Sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    });
    await drive(
      session,
      {
        logger: makeLogger(),
        pendingAsks: createPendingAsksRegistry(),
        ws: makeOpenWs(),
        confirmationsEnabled: true,
      },
      {
        toolu_c1: { answered: true, user_text: 'erm' },
        toolu_c2: { answered: true, user_text: 'sorry what' },
      }
    );
    expect(calls).toBe(3);
    expect(typeof session.pendingRepeatAskNote).toBe('string');
    expect(session.pendingRepeatAskNote.startsWith('[Server note: repeat_ask.')).toBe(true);
  });
});

describe('acceptance 4 — the live composition site debounces with no budget object threaded', () => {
  const SESSION_ID = 'sess-plan-b-gate4-live';
  beforeEach(() => {
    jest.useFakeTimers();
    activeSessions.set(SESSION_ID, {
      session: { sessionId: SESSION_ID },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    activeSessions.delete(SESSION_ID);
  });

  test('an ask reaches the inspector only after QUESTION_GATE_DELAY_MS (gate 4), and nothing else was needed', async () => {
    const client = snapshottingClient([
      toolUseRound([{ id: 'toolu_g4', name: 'ask_user', input: zsAsk() }]),
      endTurnRound('done'),
    ]);
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client,
      stateSnapshot: {
        circuits: { 3: { designation: 'Sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    });
    const ws = makeOpenWs();
    const pendingAsks = createPendingAsksRegistry();
    let settled = false;
    const p = runShadowHarness(session, 'Zs on circuit 3', [], {
      logger: makeLogger(),
      pendingAsks,
      ws,
      confirmationsEnabled: true,
    }).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(QUESTION_GATE_DELAY_MS - 100);
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(200);
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(1);
    pendingAsks.resolve('toolu_g4', { answered: true, user_text: '0.4' });
    let elapsed = 0;
    while (!settled && elapsed < ASK_USER_TIMEOUT_MS) {
      await jest.advanceTimersByTimeAsync(250);
      elapsed += 250;
    }
    await p;
  });
});

describe('the carried note is consumed only once a provider round receives it (B-review #1)', () => {
  const SESSION_ID = 'sess-plan-b-carry-consume';
  const note = '[Server note: repeat_ask. x] {"field":"measured_zs_ohm"}';
  beforeEach(() => {
    activeSessions.set(SESSION_ID, {
      session: { sessionId: SESSION_ID },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
  });
  afterEach(() => activeSessions.delete(SESSION_ID));

  async function turnWith(client) {
    const session = makeLiveSession({ sessionId: SESSION_ID, client, pendingRepeatAskNote: note });
    const { transcriptText } = attachCarriedRepeatAskNote(session, 'hang on');
    await runShadowHarness(session, transcriptText, [], { logger: makeLogger() });
    return session;
  }

  test('a completed round consumes it', async () => {
    const session = await turnWith(mockClient([endTurnRound('')]));
    expect(session.pendingRepeatAskNote).toBeNull();
  });

  test('a generation that fails before its first round keeps it for the next turn', async () => {
    const session = await turnWith({
      messages: {
        stream() {
          throw new Error('connection reset');
        },
      },
    });
    expect(session.pendingRepeatAskNote).toBe(note);
  });
});

describe('attachCarriedRepeatAskNote — ingress precedence', () => {
  const note = '[Server note: repeat_ask. x] {}';

  test('no carried note → transcript unchanged', () => {
    const session = {};
    expect(attachCarriedRepeatAskNote(session, 'Zs 0.4')).toEqual({
      transcriptText: 'Zs 0.4',
      outcome: 'none',
    });
  });

  test('prepended when no other server note is attached — but NOT consumed until a round receives it', () => {
    const session = { pendingRepeatAskNote: note };
    expect(attachCarriedRepeatAskNote(session, 'Zs 0.4')).toEqual({
      transcriptText: `${note} Zs 0.4`,
      outcome: 'carried',
    });
    // Consumption belongs to runLiveMode, after a provider round (below).
    expect(session.pendingRepeatAskNote).toBe(note);
  });

  test('deferred (kept for the next turn) when a handoff or expiry note is already attached', () => {
    const session = { pendingRepeatAskNote: note };
    const text = '[Server note: circuit 3 ring continuity is incomplete; …] Zs 0.4';
    expect(attachCarriedRepeatAskNote(session, text)).toEqual({
      transcriptText: text,
      outcome: 'deferred',
    });
    expect(session.pendingRepeatAskNote).toBe(note);
  });
});
