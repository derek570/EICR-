/**
 * §D2 (field-feedback-2026-07-14, F3) — C2-vs-C3 severity clarification
 * mechanics:
 *
 *   Group A — per-observation ask-budget chain identity (gate wrapper):
 *     two separate ambiguous observations at the SAME scope both receive
 *     initial asks (distinct server-minted chains); a same-turn pair where
 *     both require continuations → each chain allows two asks and blocks
 *     its OWN third. NOT ctx.turnId (shared by same-turn pairs).
 *
 *   Group B — post-answer write-or-reask net (harness): an ANSWERED
 *     observation_clarify ask followed by no qualifying observation
 *     mutation emits ONE deterministic audible re-ask; keyed independently
 *     of isAnswerTurn/producedNothing (the registry deletes the ask before
 *     the post-loop check and the successful ask_user call defeats
 *     producedNothing — the A3 net structurally cannot catch this).
 */

import { jest } from '@jest/globals';
import {
  wrapAskDispatcherWithGates,
  createAskGateWrapper,
  createObsClarifyChainBroker,
} from '../extraction/stage6-ask-gate-wrapper.js';
import { createAskBudget } from '../extraction/stage6-ask-budget.js';

const noopLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

function makeGatedDispatcher({ broker, budget }) {
  const logger = noopLogger();
  // Inner dispatcher answers instantly (the answer content is irrelevant to
  // budget mechanics) and records what it saw.
  const seen = [];
  const inner = jest.fn(async (call) => {
    seen.push({ ...call.input });
    return {
      tool_use_id: call.tool_call_id ?? call.id,
      content: JSON.stringify({
        answered: true,
        untrusted_user_text: 'reply',
        ...(call.input.clarification_chain_id
          ? { clarification_chain_id: call.input.clarification_chain_id }
          : {}),
      }),
      is_error: false,
    };
  });
  const gate = createAskGateWrapper({ delayMs: 0, logger, sessionId: 'sess-d2' });
  const dispatcher = wrapAskDispatcherWithGates(inner, {
    askBudget: budget,
    restrainedMode: { isActive: () => false, recordAsk: () => {} },
    gate,
    logger,
    sessionId: 'sess-d2',
    obsClarifyChains: broker,
  });
  return { dispatcher, inner, seen, gate };
}

const clarifyAsk = (id, chainId = null) => ({
  tool_call_id: id,
  name: 'ask_user',
  input: {
    question: 'Does the crack expose live parts, compromise the enclosure, or is it just cosmetic?',
    reason: 'observation_confirmation',
    context_field: 'observation_clarify',
    context_circuit: 3,
    expected_answer_shape: 'free_text',
    ...(chainId ? { clarification_chain_id: chainId } : {}),
  },
});

const ctx = { sessionId: 'sess-d2', turnId: 'turn-1' };

describe('§D2 Group A — per-observation clarification-chain ask budget', () => {
  test('two separate ambiguous observations at the SAME scope both receive initial asks (distinct chains)', async () => {
    const broker = createObsClarifyChainBroker();
    const budget = createAskBudget({ maxAsksPerKey: 2 });
    const { dispatcher, seen } = makeGatedDispatcher({ broker, budget });

    const r1 = await dispatcher(clarifyAsk('toolu_o1'), ctx);
    const r2 = await dispatcher(clarifyAsk('toolu_o2'), ctx);
    expect(JSON.parse(r1.content).answered).toBe(true);
    expect(JSON.parse(r2.content).answered).toBe(true);
    // Server minted DISTINCT chain ids and stamped them onto the inputs.
    expect(seen[0].clarification_chain_id).toBeDefined();
    expect(seen[1].clarification_chain_id).toBeDefined();
    expect(seen[0].clarification_chain_id).not.toBe(seen[1].clarification_chain_id);
  });

  test('SAME-TURN pair with continuations: each chain allows two asks and blocks its OWN third', async () => {
    const broker = createObsClarifyChainBroker();
    const budget = createAskBudget({ maxAsksPerKey: 2 });
    const { dispatcher, seen } = makeGatedDispatcher({ broker, budget });

    // obs1 initial + obs2 initial (same extraction turn, same scope).
    const i1 = await dispatcher(clarifyAsk('toolu_o1'), ctx);
    await dispatcher(clarifyAsk('toolu_o2'), ctx);
    const chain1 = seen[0].clarification_chain_id;
    const chain2 = seen[1].clarification_chain_id;
    expect(JSON.parse(i1.content).clarification_chain_id).toBe(chain1);

    // Each observation's single continuation echoes ITS chain id — allowed.
    const c1 = await dispatcher(clarifyAsk('toolu_o1b', chain1), ctx);
    const c2 = await dispatcher(clarifyAsk('toolu_o2b', chain2), ctx);
    expect(JSON.parse(c1.content).answered).toBe(true);
    expect(JSON.parse(c2.content).answered).toBe(true);

    // A THIRD ask on chain 1 is blocked (its bucket is exhausted)…
    const third = await dispatcher(clarifyAsk('toolu_o1c', chain1), ctx);
    expect(JSON.parse(third.content)).toMatchObject({
      answered: false,
      reason: 'ask_budget_exhausted',
    });
    // …without collateral damage: a FRESH observation still gets its ask.
    const fresh = await dispatcher(clarifyAsk('toolu_o3'), ctx);
    expect(JSON.parse(fresh.content).answered).toBe(true);
  });

  test('an invented/unknown chain id mints a fresh chain (never joins another bucket)', async () => {
    const broker = createObsClarifyChainBroker();
    const budget = createAskBudget({ maxAsksPerKey: 2 });
    const { dispatcher, seen } = makeGatedDispatcher({ broker, budget });
    await dispatcher(clarifyAsk('toolu_x', 'obsclr-invented-999'), ctx);
    expect(seen[0].clarification_chain_id).not.toBe('obsclr-invented-999');
    expect(broker.known.has(seen[0].clarification_chain_id)).toBe(true);
  });
});

// ── Group B — the post-answer net, through the REAL harness ────────────────

const SESSION_ID = 'sess-d2-net';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

let toolLoopResult = null;
const runToolLoopSpy = jest.fn(async () => toolLoopResult);

const validateSpy = jest.fn();
const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: validateSpy,
  abortBySlot: jest.fn(),
  shutdown: jest.fn(),
}));

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: createSpeculatorSpy,
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

function makeSession() {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    activeTurnTranscript: null,
    _snapshot: null,
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
  };
}

function baseOpts(overrides = {}) {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    ...overrides,
  };
}

const answeredClarify = (id) => ({
  name: 'ask_user',
  tool_call_id: id,
  input: { context_field: 'observation_clarify', question: 'crack question' },
  result: {
    is_error: false,
    content: JSON.stringify({ answered: true, untrusted_user_text: 'just cosmetic' }),
  },
});
const unansweredClarify = (id) => ({
  name: 'ask_user',
  tool_call_id: id,
  input: { context_field: 'observation_clarify', question: 'follow-up' },
  result: { is_error: false, content: JSON.stringify({ answered: false, reason: 'timeout' }) },
});
const okObservation = () => ({
  name: 'record_observation',
  tool_call_id: 'obs_1',
  input: { code: 'C3', text: 'Cracked socket' },
  result: { is_error: false, content: JSON.stringify({ ok: true }) },
});
const okReading = () => ({
  name: 'record_reading',
  tool_call_id: 'rr_1',
  input: { field: 'measured_zs_ohm', circuit: 1, value: '0.3' },
  result: { is_error: false, content: JSON.stringify({ ok: true }) },
});

function loopOut(toolCalls) {
  return {
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: toolCalls,
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  };
}

const netText = /didn't record that observation/i;

beforeEach(() => {
  runToolLoopSpy.mockClear();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: true } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('§D2 Group B — post-answer write-or-reask net', () => {
  test('(1) clarify answered → zero further tools → audible deterministic follow-up TTS', async () => {
    toolLoopResult = loopOut([answeredClarify('toolu_c1')]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
    expect(net.field).toBeNull();
    expect(net.expects_ios_ack).toBe(false);
  });

  test('(2) answer turn records an UNRELATED reading but no observation → net still fires', async () => {
    toolLoopResult = loopOut([answeredClarify('toolu_c1'), okReading()]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
  });

  test('(3) two answered asks then zero tools → fallback anchored at the LATEST answered ask', async () => {
    toolLoopResult = loopOut([
      answeredClarify('toolu_c1'),
      answeredClarify('toolu_c2'), // answered continuation — anchor advances
    ]);
    const result = await runShadowHarness(makeSession(), 'still not sure', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
  });

  test('NEGATIVE: answered clarify followed by a successful record_observation → no net', async () => {
    toolLoopResult = loopOut([answeredClarify('toolu_c1'), okObservation()]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeUndefined();
  });

  test('NEGATIVE: answered clarify followed by an UNANSWERED continuation → no net (the question was audible)', async () => {
    toolLoopResult = loopOut([answeredClarify('toolu_c1'), unansweredClarify('toolu_c2')]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeUndefined();
  });

  test('Codex r4-#5: an audibly-terminated ask on a DIFFERENT chain does NOT qualify — chain A still gets the net', async () => {
    // Answered clarify on chain A, then a NEW ambiguous observation B whose
    // initial ask times out. B's audible ask must not suppress A's
    // deterministic fallback — A's answered clarification would be
    // silently dropped.
    const answeredA = answeredClarify('toolu_a');
    answeredA.input.clarification_chain_id = 'chain_a';
    const timedOutB = unansweredClarify('toolu_b');
    timedOutB.input.clarification_chain_id = 'chain_b';
    toolLoopResult = loopOut([answeredA, timedOutB]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
  });

  test('Codex r8-#2: the D2 net confirmation gets exactly one ios_send_attempt telemetry row', async () => {
    toolLoopResult = loopOut([answeredClarify('toolu_c1')]);
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
    const rows = opts.logger.info.mock.calls
      .filter((c) => c[0] === 'ios_send_attempt')
      .map((c) => c[1]);
    expect(rows.filter((r) => r.field == null)).toHaveLength(1);
  });

  test('Codex r4-#5: a SAME-CHAIN audibly-terminated continuation still qualifies → no net', async () => {
    const answeredA = answeredClarify('toolu_a');
    answeredA.input.clarification_chain_id = 'chain_a';
    const continuationA = unansweredClarify('toolu_a2');
    continuationA.input.clarification_chain_id = 'chain_a';
    toolLoopResult = loopOut([answeredA, continuationA]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeUndefined();
  });

  test('Codex r1-#3: a PRE-FIRE continuation outcome (ask_budget_exhausted — never spoken) does NOT qualify → net fires', async () => {
    const preFireContinuation = {
      name: 'ask_user',
      tool_call_id: 'toolu_c2',
      input: { context_field: 'observation_clarify', question: 'follow-up' },
      result: {
        is_error: false,
        content: JSON.stringify({ answered: false, reason: 'ask_budget_exhausted' }),
      },
    };
    toolLoopResult = loopOut([answeredClarify('toolu_c1'), preFireContinuation]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined(); // the continuation was never audible — silence guarded
  });

  test('Codex r1-#3: delete_observation does NOT qualify (removes a different observation, records nothing) → net fires', async () => {
    const del = {
      name: 'delete_observation',
      tool_call_id: 'del_1',
      input: { id: 'obs-unrelated' },
      result: { is_error: false, content: JSON.stringify({ ok: true }) },
    };
    toolLoopResult = loopOut([answeredClarify('toolu_c1'), del]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
  });

  test('Codex r1-#4: the anchor chain RETIRES on net evaluation (success or terminal — the clarification is over)', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['obsclr-7']), mint: () => 'obsclr-8', retire };
    const anchored = answeredClarify('toolu_c1');
    anchored.input.clarification_chain_id = 'obsclr-7';
    toolLoopResult = loopOut([anchored, okObservation()]);
    await runShadowHarness(session, 'just cosmetic', [], baseOpts());
    expect(retire).toHaveBeenCalledWith('obsclr-7');
  });

  test('NEGATIVE: no observation_clarify ask in the turn → net never fires', async () => {
    toolLoopResult = loopOut([okReading()]);
    const result = await runShadowHarness(makeSession(), 'Zs circuit 1 0.3', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeUndefined();
  });
});
