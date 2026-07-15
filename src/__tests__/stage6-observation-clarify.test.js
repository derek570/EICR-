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

// ── Group B (2026-07-15) — mutation-to-chain correlation (multi-chain) ──────

const netTextPlural = /didn't record those observations/i;

// answered clarify carrying a specific chain id.
const answeredChain = (id, chainId) => {
  const c = answeredClarify(id);
  if (chainId != null) c.input.clarification_chain_id = chainId;
  return c;
};
// audibly-terminated (timeout) continuation carrying a chain id.
const timedOutChain = (id, chainId) => {
  const c = unansweredClarify(id);
  if (chainId != null) c.input.clarification_chain_id = chainId;
  return c;
};
// successful record_observation carrying (or omitting) a chain id.
const okObsChain = (toolCallId, chainId) => ({
  name: 'record_observation',
  tool_call_id: toolCallId,
  input: {
    code: 'C3',
    text: 'Cracked socket',
    ...(chainId != null ? { clarification_chain_id: chainId } : {}),
  },
  result: { is_error: false, content: JSON.stringify({ ok: true, observation_id: toolCallId }) },
});
// answered clarify in the REAL runToolLoop shape: id at result.tool_use_id,
// NO synthetic top-level tool_call_id (test 15 asserts non-null anchor ids).
const answeredChainRealShape = (tuid, chainId) => ({
  name: 'ask_user',
  input: {
    context_field: 'observation_clarify',
    question: 'crack question',
    ...(chainId != null ? { clarification_chain_id: chainId } : {}),
  },
  result: {
    is_error: false,
    tool_use_id: tuid,
    content: JSON.stringify({ answered: true, untrusted_user_text: 'just cosmetic' }),
  },
});
const infoRows = (opts, name) =>
  opts.logger.info.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
const DROPPED = 'stage6.observation_clarify_dropped_net';
const LENIENT = 'stage6.observation_clarify_lenient_qualification';

describe('§D2 Group B (2026-07-15) — mutation-to-chain correlation', () => {
  test('(1) correlated A+B, one record carrying A id → exactly ONE fallback (for B), both chains retired once', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['A', 'B']), mint: () => 'z', retire };
    const opts = baseOpts();
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_a', 'A'),
    ]);
    const result = await runShadowHarness(session, 'just cosmetic', [], opts);
    const singular = (result.confirmations ?? []).filter((c) => netText.test(c.text || ''));
    const plural = (result.confirmations ?? []).filter((c) => netTextPlural.test(c.text || ''));
    expect(singular).toHaveLength(1); // only chain B fell back
    expect(plural).toHaveLength(0);
    expect(retire).toHaveBeenCalledWith('A');
    expect(retire).toHaveBeenCalledWith('B');
    expect(retire).toHaveBeenCalledTimes(2);
    const dropped = infoRows(opts, DROPPED);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].unqualified_chain_ids).toEqual(['B']);
    expect(dropped[0].qualified_chain_ids).toEqual(['A']);
    expect(dropped[0].mutation_id_kinds).toEqual(['matched']);
    expect(dropped[0].lenient_qualification).toBe(false);
  });

  test('(2) correlated A+B, two records carrying A and B ids → zero fallbacks, both retired', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['A', 'B']), mint: () => 'z', retire };
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_a', 'A'),
      okObsChain('obs_b', 'B'),
    ]);
    const result = await runShadowHarness(session, 'just cosmetic', [], baseOpts());
    const nets = (result.confirmations ?? []).filter(
      (c) => netText.test(c.text || '') || netTextPlural.test(c.text || '')
    );
    expect(nets).toHaveLength(0);
    expect(retire).toHaveBeenCalledWith('A');
    expect(retire).toHaveBeenCalledWith('B');
  });

  describe('(3) failed record_observation never qualifies → chain falls back', () => {
    const cases = [
      ['(a) is_error:false + {ok:false}', { is_error: false, content: JSON.stringify({ ok: false }) }],
      ['(b) is_error:false + malformed content', { is_error: false, content: '{not json' }],
      ['(c) is_error:false + JSON missing ok', { is_error: false, content: JSON.stringify({ observation_id: 'x' }) }],
      ['(d) is_error:true + {ok:true}', { is_error: true, content: JSON.stringify({ ok: true }) }],
    ];
    for (const [label, res] of cases) {
      test(label, async () => {
        const failObs = {
          name: 'record_observation',
          tool_call_id: 'obs_fail',
          input: { code: 'C3', text: 'x', clarification_chain_id: 'A' },
          result: res,
        };
        toolLoopResult = loopOut([answeredChain('toolu_a', 'A'), failObs]);
        const opts = baseOpts();
        const result = await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
        const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
        expect(net).toBeDefined();
        // The parser must catch malformed bodies internally — NEVER throw into
        // the outer catch (which would emit only net_error and re-open the
        // silence path). So no net_error row must be logged.
        expect(
          opts.logger.warn.mock.calls.filter(
            (c) => c[0] === 'stage6.observation_clarify_net_error'
          )
        ).toHaveLength(0);
      });
    }
  });

  test('(4) unknown id "obsclr-999" with answered chain A → LENIENT: A qualified, zero fallbacks, retired', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['A']), mint: () => 'z', retire };
    const opts = baseOpts();
    toolLoopResult = loopOut([answeredChain('toolu_a', 'A'), okObsChain('obs_x', 'obsclr-999')]);
    const result = await runShadowHarness(session, 'just cosmetic', [], opts);
    const net = (result.confirmations ?? []).find(
      (c) => netText.test(c.text || '') || netTextPlural.test(c.text || '')
    );
    expect(net).toBeUndefined();
    expect(retire).toHaveBeenCalledWith('A');
    const lenient = infoRows(opts, LENIENT);
    expect(lenient).toHaveLength(1);
    expect(lenient[0].mutation_id_kind).toBe('unknown');
    expect(lenient[0].qualified_chain_ids).toEqual(['A']);
    expect(infoRows(opts, DROPPED)).toHaveLength(0);
  });

  test('(5) id-less mutation, single chain → qualifies (today\'s behaviour preserved)', async () => {
    toolLoopResult = loopOut([answeredChain('toolu_a', 'A'), okObsChain('obs_x', null)]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find(
      (c) => netText.test(c.text || '') || netTextPlural.test(c.text || '')
    );
    expect(net).toBeUndefined();
  });

  test('(6) id-less mutation, two chains → zero fallbacks (D-1a lenient), BOTH retired', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['A', 'B']), mint: () => 'z', retire };
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_x', null),
    ]);
    const result = await runShadowHarness(session, 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find(
      (c) => netText.test(c.text || '') || netTextPlural.test(c.text || '')
    );
    expect(net).toBeUndefined();
    expect(retire).toHaveBeenCalledWith('A');
    expect(retire).toHaveBeenCalledWith('B');
  });

  test('(7) same chain: answered initial + answered continuation, no mutation → exactly ONE fallback, ONE retire', async () => {
    const retire = jest.fn();
    const session = makeSession();
    session.obsClarifyChains = { known: new Set(['A']), mint: () => 'z', retire };
    toolLoopResult = loopOut([answeredChain('toolu_a1', 'A'), answeredChain('toolu_a2', 'A')]);
    const result = await runShadowHarness(session, 'still not sure', [], baseOpts());
    const nets = (result.confirmations ?? []).filter((c) => netText.test(c.text || ''));
    expect(nets).toHaveLength(1); // one chain, singular wording
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith('A');
  });

  test('(8) same-chain audible continuation qualifies ONLY its own chain (B still falls back)', async () => {
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      answeredChain('toolu_b', 'B'),
      timedOutChain('toolu_a2', 'A'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined(); // B fell back
    const dropped = infoRows(opts, DROPPED);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].unqualified_chain_ids).toEqual(['B']);
    expect(dropped[0].qualified_chain_ids).toEqual(['A']);
  });

  test('(9) two unqualified chains, same turn → ONE combined PLURAL fallback; dropped_net mutation_id_kinds:[]', async () => {
    toolLoopResult = loopOut([answeredChain('toolu_a', 'A'), answeredChain('toolu_b', 'B')]);
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'still not sure', [], opts);
    const plural = (result.confirmations ?? []).filter((c) => netTextPlural.test(c.text || ''));
    const singular = (result.confirmations ?? []).filter((c) => netText.test(c.text || ''));
    expect(plural).toHaveLength(1); // ONE combined, plural wording
    expect(singular).toHaveLength(0); // distinct from single-chain text
    const dropped = infoRows(opts, DROPPED);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].mutation_id_kinds).toEqual([]); // zero-mutation payload
    expect(dropped[0].unqualified_chain_ids).toEqual(['A', 'B']);
  });

  test('(12) ordering: record carrying A id BEFORE A anchor does NOT qualify → A falls back', async () => {
    toolLoopResult = loopOut([okObsChain('obs_a', 'A'), answeredChain('toolu_a', 'A')]);
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], baseOpts());
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined();
  });

  test('(13) ordering + lenient: id-less mutation BETWEEN anchors A and B qualifies A only', async () => {
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      okObsChain('obs_x', null),
      answeredChain('toolu_b', 'B'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const net = (result.confirmations ?? []).find((c) => netText.test(c.text || ''));
    expect(net).toBeDefined(); // B fell back
    const dropped = infoRows(opts, DROPPED);
    expect(dropped[0].unqualified_chain_ids).toEqual(['B']);
    expect(dropped[0].qualified_chain_ids).toEqual(['A']);
    const lenient = infoRows(opts, LENIENT);
    expect(lenient).toHaveLength(1);
    expect(lenient[0].qualified_chain_ids).toEqual(['A']);
  });

  test('(14) telemetry lenient: id-less mutation qualifying two chains → one lenient row, no dropped_net', async () => {
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_x', null),
    ]);
    const opts = baseOpts();
    await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const lenient = infoRows(opts, LENIENT);
    expect(lenient).toHaveLength(1);
    expect(lenient[0].lenient_qualification).toBe(true);
    expect(lenient[0].mutation_id_kind).toBe('null');
    expect(lenient[0].qualified_chain_ids.sort()).toEqual(['A', 'B']);
    expect(infoRows(opts, DROPPED)).toHaveLength(0);
  });

  test('(14b) telemetry lenient: [A, null M1, B, unknown M2] → TWO lenient rows [A] then [B]', async () => {
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      okObsChain('obs_1', null),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_2', 'obsclr-zzz'),
    ]);
    const opts = baseOpts();
    await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const lenient = infoRows(opts, LENIENT);
    expect(lenient).toHaveLength(2);
    expect(lenient[0].qualified_chain_ids).toEqual(['A']);
    expect(lenient[0].mutation_id_kind).toBe('null');
    expect(lenient[1].qualified_chain_ids).toEqual(['B']);
    expect(lenient[1].mutation_id_kind).toBe('unknown');
    expect(infoRows(opts, DROPPED)).toHaveLength(0);
  });

  test('(15) telemetry payload: A+B/record-A partial → complete dropped_net with NON-NULL anchor ids', async () => {
    toolLoopResult = loopOut([
      answeredChainRealShape('tuid_a', 'A'),
      answeredChainRealShape('tuid_b', 'B'),
      okObsChain('obs_a', 'A'),
    ]);
    const opts = baseOpts();
    await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const dropped = infoRows(opts, DROPPED);
    expect(dropped).toHaveLength(1);
    const row = dropped[0];
    expect(row.unqualified_chain_ids).toEqual(['B']);
    expect(row.qualified_chain_ids).toEqual(['A']);
    expect(row.lenient_qualification).toBe(false);
    expect(row.mutation_id_kinds).toEqual(['matched']);
    // anchor_tool_call_ids: TWO entries, anchor order, NON-NULL ids.
    expect(row.anchor_tool_call_ids).toEqual([
      { clarification_chain_id: 'A', anchor_tool_call_id: 'tuid_a' },
      { clarification_chain_id: 'B', anchor_tool_call_id: 'tuid_b' },
    ]);
  });

  test('(15b) telemetry payload mixed: [A, matched-A, B, null, C] → mutation_id_kinds:[matched,null], C unqualified', async () => {
    toolLoopResult = loopOut([
      answeredChain('toolu_a', 'A'),
      okObsChain('obs_a', 'A'),
      answeredChain('toolu_b', 'B'),
      okObsChain('obs_null', null),
      answeredChain('toolu_c', 'C'),
    ]);
    const opts = baseOpts();
    await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const dropped = infoRows(opts, DROPPED);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].unqualified_chain_ids).toEqual(['C']);
    expect(dropped[0].mutation_id_kinds).toEqual(['matched', 'null']);
    expect(dropped[0].lenient_qualification).toBe(true); // null mutation newly qualified B
  });

  test('(16) no-raw-id: unknown id "MODEL-CONTROLLED-DO-NOT-LOG" never appears in ANY emitted row', async () => {
    const RAW = 'MODEL-CONTROLLED-DO-NOT-LOG';
    toolLoopResult = loopOut([answeredChain('toolu_a', 'A'), okObsChain('obs_x', RAW)]);
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'just cosmetic', [], opts);
    const net = (result.confirmations ?? []).find(
      (c) => netText.test(c.text || '') || netTextPlural.test(c.text || '')
    );
    expect(net).toBeUndefined(); // lenient — qualifies the only chain
    const lenient = infoRows(opts, LENIENT);
    expect(lenient).toHaveLength(1);
    expect(lenient[0].mutation_id_kind).toBe('unknown');
    expect(lenient[0].qualified_chain_ids).toEqual(['A']);
    expect(infoRows(opts, DROPPED)).toHaveLength(0);
    // EVERY emitted info row's JSON must not contain the raw id.
    for (const call of opts.logger.info.mock.calls) {
      expect(JSON.stringify(call[1] ?? null)).not.toContain(RAW);
    }
  });
});
