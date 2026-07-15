/**
 * stage6-audibility-invariants.test.js — F7 audibility-invariant sweep,
 * INTEGRATION LANE (PLAN f7-hardening-2026-07 Item 1, task #17).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * The 28 Stage-6 review findings from the field-feedback-2026-07-14 run were
 * all backend bugs the PWA replay harness (web-composition scope) cannot
 * cover. The keystone class: a transcript-gate chime followed by SILENCE
 * because an ask_user was SUPPRESSED before emitting `ask_user_started`
 * (restrained_mode / ask_budget_exhausted / validation_error / prompt-leak /
 * dispatcher_error / closed-WS / throwing-send / fallback-to-legacy / a
 * swallowed D2 continuation). Audio-First invariant #1 says every
 * chime-producing turn must end with ≥1 audible output.
 *
 * This lane drives the REAL composition — real pendingAsks registry, real
 * `createAskDispatcher`, the real gate (`createAskGateWrapper` +
 * `wrapAskDispatcherWithGates`), the real `runToolLoop` driven by a mock
 * Anthropic client, and a WS stub — so a mocked dispatcher cannot trivially
 * agree with the net's assumptions. Fake timers are MANDATORY: the real gate
 * debounce (QUESTION_GATE_DELAY_MS) and the real ASK_USER_TIMEOUT_MS (45s)
 * would make the lane prohibitively slow and could trip the 90s jest ceiling
 * (a vacuous RED). We advance by the imported constants, never numeric
 * literals.
 *
 * The audibility oracle inspects the WS stub's actual sent-frame log (an
 * `ask_user_started` frame that really crossed the wire) plus surviving
 * confirmation text — available today, zero production edits. It does NOT
 * import Item 2's `emittedAskToolCallIds` (which does not exist until Item 2
 * lands), so the IDENTICAL jest command proves the RED→GREEN transition.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RED→GREEN CONTRACT (harness-first)
 * ═══════════════════════════════════════════════════════════════════════════
 * The NINE invariant-(a) cases below are marked `test.failing` for the Item-1
 * commit: pre-Item-2 each turn suppresses its ask with ZERO surviving audible
 * output, so `turnIsAudible` is false and the assertion FAILS — which is what
 * `test.failing` REQUIRES (the suite goes RED if any of them unexpectedly
 * passes). When Item 2's pre-emission net lands, ALL nine `.failing` marks are
 * removed together and the identical jest command runs green.
 *
 * Targeted command (record in the execution log):
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js \
 *     --watchman=false --forceExit src/__tests__/stage6-audibility-invariants.test.js
 */

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { ASK_USER_TIMEOUT_MS } from '../extraction/stage6-dispatcher-ask.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';
import { ASK_USER_ANSWER_OUTCOMES } from '../extraction/stage6-dispatcher-logger.js';
import { isPreEmitNonFireReason } from '../extraction/stage6-ask-gate-wrapper.js';
import { createObsClarifyChainBroker } from '../extraction/stage6-ask-gate-wrapper.js';
import {
  extractPendingValue,
  detectStructuredReading,
} from '../extraction/stage6-pending-value.js';
import {
  applyConfirmationDebounce,
  CONFIRMATION_DEBOUNCE_WINDOW_MS,
} from '../extraction/stage6-event-bundler.js';
import { activeSessions } from '../extraction/active-sessions.js';

import {
  makeLogger,
  makeLiveSession,
  makeOpenWs,
  makeClosedWs,
  makeThrowingWs,
  toolUseRound,
  endTurnRound,
  turnIsAudible,
  askStartedFrames,
  GUARANTEED_PRE_EMIT_OUTCOMES,
  EMISSION_EVIDENCE_REQUIRED_OUTCOMES,
  WRAPPER_LAYER_PRE_EMIT_OUTCOMES,
} from './helpers/f7-audibility-matrix.js';

import { mockClient } from './helpers/mockStream.js';

const SESSION_ID = 'sess-f7-integration';

// Total fake-time budget to advance while awaiting a turn: the gate debounce
// plus the 45s ask timeout plus slack — imported constants, no literals.
const MAX_ADVANCE_MS = QUESTION_GATE_DELAY_MS + ASK_USER_TIMEOUT_MS + 2000;

/** A WS whose FIRST ask_user_started send throws (swallowed pre-fix) so a
 *  single-round anchor emission is suppressed; kept OPEN so production
 *  ATTEMPTS the send. Used for the D2 swallowed-continuation case where both
 *  the anchor and continuation must be inaudible this turn. */
function makeAllSwallowedWs() {
  return makeThrowingWs();
}

function registerEntry(sessionId = SESSION_ID) {
  activeSessions.set(sessionId, {
    session: { sessionId },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    // loadedBarrel OFF → speculator skipped → no ElevenLabs.
    voiceLatency: { flags: { loadedBarrel: false } },
  });
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: createPendingAsksRegistry(),
    ws: makeOpenWs(),
    confirmationsEnabled: true,
    ...overrides,
  };
}

/**
 * Drive one live turn under fake timers. Resolves any `answers`
 * (toolCallId → resolve-payload) the moment their ask registers, and advances
 * fake time up to MAX_ADVANCE_MS so suppressed/closed/throwing asks reach
 * their 45s timeout without a real wall-clock wait. Returns the settled
 * `runShadowHarness` result.
 */
async function driveLiveTurn(session, transcript, opts, { answers = {} } = {}) {
  const pendingAsks = opts.pendingAsks;
  const answerMap = new Map(Object.entries(answers));
  let settled = false;
  let value;
  let error;
  const p = runShadowHarness(session, transcript, [], opts).then(
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
  const step = 250;
  let elapsed = 0;
  while (!settled && elapsed <= MAX_ADVANCE_MS) {
    for (const [id, payload] of [...answerMap]) {
      if (pendingAsks && pendingAsks.resolve(id, payload)) answerMap.delete(id);
    }

    await jest.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
  // Final drains for any timer armed at the tail (audio finalizer).
  await jest.advanceTimersByTimeAsync(0);
  await p;
  if (error) throw error;
  return value;
}

// Build the two-round mock client for a single suppressed ask: round 1 emits
// the ask_user, round 2 ends the turn.
function mockAskThenEnd(askInput, askId = 'toolu_ask_1') {
  return mockClient([
    toolUseRound([{ id: askId, name: 'ask_user', input: askInput }]),
    endTurnRound('ok'),
  ]);
}

const VALID_ASK = {
  question: 'Which circuit were you referring to?',
  reason: 'ambiguous_circuit',
  context_field: 'measured_zs_ohm',
  context_circuit: null,
  expected_answer_shape: 'circuit_ref',
};

// ───────────────────────────────────────────────────────────────────────────
describe('F7 integration lane — invariant (a): chime-producing confirmation-mode-ON turn ends with ≥1 audible output', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    registerEntry();
  });
  afterEach(() => {
    activeSessions.delete(SESSION_ID);
    jest.useRealTimers();
  });

  // Sanity GREEN baseline (NOT failing): a successful ask really emits
  // ask_user_started, so the turn is audible — proves the oracle + wiring.
  test('BASELINE (green): a successfully-emitted ask makes the turn audible', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockClient([
        toolUseRound([{ id: 'toolu_ask_1', name: 'ask_user', input: VALID_ASK }]),
        endTurnRound('ok'),
      ]),
    });
    const ws = makeOpenWs();
    const opts = baseOpts({ ws });
    const result = await driveLiveTurn(session, 'which circuit was that', opts, {
      answers: { toolu_ask_1: { answered: true, user_text: 'Circuit 5' } },
    });
    expect(askStartedFrames(ws).length).toBeGreaterThanOrEqual(1);
    expect(turnIsAudible(result, ws)).toBe(true);
  });

  // ── the NINE pre-Item-2 RED cases (test.failing until Item 2 lands) ──

  test.failing(
    'RED#1 validation_error: invalid ask reason is suppressed → silence (no fallback pre-fix)',
    async () => {
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        client: mockAskThenEnd({ ...VALID_ASK, reason: 'not_a_real_reason' }),
      });
      const ws = makeOpenWs();
      const result = await driveLiveTurn(session, 'which circuit was that', baseOpts({ ws }));
      expect(askStartedFrames(ws)).toHaveLength(0); // never emitted
      expect(turnIsAudible(result, ws)).toBe(true); // FAILS pre-fix (silence)
    }
  );

  test.failing('RED#2 prompt_leak_blocked: leak question is suppressed → silence', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockAskThenEnd({ ...VALID_ASK, question: 'What about the TRUST BOUNDARY here?' }),
    });
    const ws = makeOpenWs();
    const result = await driveLiveTurn(session, 'which circuit was that', baseOpts({ ws }));
    expect(askStartedFrames(ws)).toHaveLength(0);
    expect(turnIsAudible(result, ws)).toBe(true);
  });

  test.failing(
    'RED#3 dispatcher_error: a non-duplicate register throw is suppressed → silence',
    async () => {
      const pendingAsks = createPendingAsksRegistry();
      // Force the real dispatcher's outer catch: make register throw a
      // NON-duplicate error exactly once (no DUPLICATE_TOOL_CALL_ID code).
      const realRegister = pendingAsks.register.bind(pendingAsks);
      let thrown = false;
      pendingAsks.register = (id, entry) => {
        if (!thrown) {
          thrown = true;
          throw new Error('synthetic dispatcher failure');
        }
        return realRegister(id, entry);
      };
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        client: mockAskThenEnd(VALID_ASK),
      });
      const ws = makeOpenWs();
      const result = await driveLiveTurn(
        session,
        'which circuit was that',
        baseOpts({ ws, pendingAsks })
      );
      expect(askStartedFrames(ws)).toHaveLength(0);
      expect(turnIsAudible(result, ws)).toBe(true);
    }
  );

  test.failing('RED#4 restrained_mode: gate short-circuit is suppressed → silence', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockAskThenEnd(VALID_ASK),
    });
    const ws = makeOpenWs();
    const opts = baseOpts({
      ws,
      restrainedMode: { isActive: () => true, recordAsk: () => {} },
      askBudget: { isExhausted: () => false, increment: () => {} },
    });
    const result = await driveLiveTurn(session, 'which circuit was that', opts);
    expect(askStartedFrames(ws)).toHaveLength(0);
    expect(turnIsAudible(result, ws)).toBe(true);
  });

  test.failing(
    'RED#5 ask_budget_exhausted: gate short-circuit is suppressed → silence',
    async () => {
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        client: mockAskThenEnd(VALID_ASK),
      });
      const ws = makeOpenWs();
      const opts = baseOpts({
        ws,
        restrainedMode: { isActive: () => false, recordAsk: () => {} },
        askBudget: { isExhausted: () => true, increment: () => {} },
      });
      const result = await driveLiveTurn(session, 'which circuit was that', opts);
      expect(askStartedFrames(ws)).toHaveLength(0);
      expect(turnIsAudible(result, ws)).toBe(true);
    }
  );

  test.failing('RED#6 closed WS: ask registers, never emits, times out → silence', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockAskThenEnd(VALID_ASK),
    });
    const ws = makeClosedWs();
    const result = await driveLiveTurn(session, 'which circuit was that', baseOpts({ ws }));
    expect(askStartedFrames(ws)).toHaveLength(0);
    expect(turnIsAudible(result, ws)).toBe(true);
  });

  test.failing(
    'RED#7 throwing ws.send: ask registers, send throws (swallowed), times out → silence',
    async () => {
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        client: mockAskThenEnd(VALID_ASK),
      });
      const ws = makeThrowingWs();
      const result = await driveLiveTurn(session, 'which circuit was that', baseOpts({ ws }));
      expect(askStartedFrames(ws)).toHaveLength(0);
      expect(turnIsAudible(result, ws)).toBe(true);
    }
  );

  test.failing(
    'RED#8 live + fallbackToLegacy: ask_user_started suppressed, no legacy emit → silence',
    async () => {
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        client: mockAskThenEnd(VALID_ASK),
      });
      const ws = makeOpenWs();
      const result = await driveLiveTurn(
        session,
        'which circuit was that',
        baseOpts({ ws, fallbackToLegacy: true })
      );
      expect(askStartedFrames(ws)).toHaveLength(0);
      expect(turnIsAudible(result, ws)).toBe(true);
    }
  );

  test.failing(
    'RED#9 D2 swallowed continuation: answered anchor + same-chain swallowed continuation → silence',
    async () => {
      // Pre-seed the chain broker + mint one chain id so BOTH asks key to it.
      const obsClarifyChains = createObsClarifyChainBroker();
      const chainId = obsClarifyChains.mint();
      const session = makeLiveSession({
        sessionId: SESSION_ID,
        obsClarifyChains,
      });
      const clarifyInput = (extra) => ({
        question: 'Does the crack expose live parts or is it cosmetic?',
        reason: 'observation_confirmation',
        context_field: 'observation_clarify',
        context_circuit: 3,
        expected_answer_shape: 'free_text',
        clarification_chain_id: chainId,
        ...extra,
      });
      session.client = mockClient([
        toolUseRound([{ id: 'toolu_anchor', name: 'ask_user', input: clarifyInput() }]),
        toolUseRound([{ id: 'toolu_cont', name: 'ask_user', input: clarifyInput() }]),
        endTurnRound('ok'),
      ]);
      // Throwing ws → both asks' emissions swallowed this turn. Anchor is
      // answered externally; the continuation times out.
      const ws = makeAllSwallowedWs();
      const opts = baseOpts({
        ws,
        restrainedMode: { isActive: () => false, recordAsk: () => {} },
        askBudget: { isExhausted: () => false, increment: () => {} },
      });
      const result = await driveLiveTurn(session, 'observation about the crack', opts, {
        answers: { toolu_anchor: { answered: true, user_text: 'cosmetic' } },
      });
      expect(askStartedFrames(ws)).toHaveLength(0); // both swallowed
      // Pre-fix D2 counts the timed-out continuation audible-by-reason and
      // suppresses its fallback → silence. Post-fix the emission check fails
      // the qualification → the deterministic fallback fires.
      expect(turnIsAudible(result, ws)).toBe(true);
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Static ask-outcome classification — name-based, no harness, no timers.
// A future enum addition must FAIL these until it is classified.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 ask-outcome classification is disjoint + complete over ASK_USER_ANSWER_OUTCOMES', () => {
  test('the enum has exactly 15 members (partition arithmetic 8 + 7)', () => {
    expect(ASK_USER_ANSWER_OUTCOMES).toHaveLength(15);
  });

  test('GUARANTEED_PRE_EMIT_OUTCOMES = isPreEmitNonFireReason ∪ {restrained_mode, ask_budget_exhausted, gated} = 8', () => {
    expect(GUARANTEED_PRE_EMIT_OUTCOMES).toHaveLength(8);
    // The 5 predicate members are present.
    for (const m of [
      'validation_error',
      'duplicate_tool_call_id',
      'prompt_leak_blocked',
      'shadow_mode',
      'dispatcher_error',
    ]) {
      expect(GUARANTEED_PRE_EMIT_OUTCOMES).toContain(m);
    }
    for (const m of WRAPPER_LAYER_PRE_EMIT_OUTCOMES) {
      expect(GUARANTEED_PRE_EMIT_OUTCOMES).toContain(m);
    }
  });

  test('EMISSION_EVIDENCE_REQUIRED_OUTCOMES is the explicit 7', () => {
    expect(EMISSION_EVIDENCE_REQUIRED_OUTCOMES).toHaveLength(7);
  });

  test('the two explicit sets are DISJOINT', () => {
    const pre = new Set(GUARANTEED_PRE_EMIT_OUTCOMES);
    const overlap = EMISSION_EVIDENCE_REQUIRED_OUTCOMES.filter((m) => pre.has(m));
    expect(overlap).toEqual([]);
  });

  test('their UNION equals the closed enum EXACTLY (a 16th member fails until classified)', () => {
    const union = new Set([
      ...GUARANTEED_PRE_EMIT_OUTCOMES,
      ...EMISSION_EVIDENCE_REQUIRED_OUTCOMES,
    ]);
    expect(union.size).toBe(ASK_USER_ANSWER_OUTCOMES.length);
    for (const m of ASK_USER_ANSWER_OUTCOMES) expect(union.has(m)).toBe(true);
  });

  test('isPreEmitNonFireReason returns true for EXACTLY those five members, false for every other enum member', () => {
    const five = new Set([
      'validation_error',
      'duplicate_tool_call_id',
      'prompt_leak_blocked',
      'shadow_mode',
      'dispatcher_error',
    ]);
    for (const m of ASK_USER_ANSWER_OUTCOMES) {
      expect(isPreEmitNonFireReason(m)).toBe(five.has(m));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fixture self-test: the open WS stub records exactly one ask_user_started.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 WS-stub fixture contract', () => {
  test('open stub records one ask_user_started frame; closed/throwing record none', () => {
    const open = makeOpenWs();
    expect(open.OPEN).toBe(1);
    expect(open.readyState).toBe(1);
    open.send(JSON.stringify({ type: 'ask_user_started', tool_call_id: 'x' }));
    expect(askStartedFrames(open)).toHaveLength(1);

    const closed = makeClosedWs();
    expect(closed.OPEN).toBe(1);
    expect(closed.readyState).not.toBe(closed.OPEN);
    expect(askStartedFrames(closed)).toHaveLength(0);

    const throwing = makeThrowingWs();
    expect(throwing.readyState).toBe(throwing.OPEN);
    expect(() => throwing.send('{}')).toThrow();
    expect(askStartedFrames(throwing)).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Property-style adversarial tests — pending value + token debounce, through
// PUBLIC exports only. Bounded literal tables, deterministic, no randomness.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 property — extractPendingValue / detectStructuredReading (public exports only)', () => {
  const UNIT_CASES = [
    { transcript: 'the reading is 0.47 ohms', expectValue: true },
    { transcript: 'insulation is greater than 299 megohms', expectValue: true },
    { transcript: 'that is 25 milliseconds', expectValue: true },
    { transcript: 'no numbers here at all', expectValue: false },
    { transcript: '', expectValue: false },
  ];
  test.each(UNIT_CASES)(
    'extractPendingValue on "$transcript" → captured=$expectValue',
    ({ transcript, expectValue }) => {
      const pv = extractPendingValue({ transcript, question: 'what was that reading for?' });
      if (expectValue) {
        expect(pv).not.toBeNull();
        expect(typeof pv.value === 'string' || typeof pv.value === 'number').toBe(true);
      } else {
        expect(pv).toBeNull();
      }
    }
  );

  test('multiple unbound numbers never guess a single value (ambiguity → null)', () => {
    const pv = extractPendingValue({
      transcript: 'circuit 3 and circuit 4 both read something',
      question: 'what was that reading for?',
    });
    // Two circuit numbers, no bound value → must not fabricate a reading.
    expect(pv).toBeNull();
  });

  test('detectStructuredReading is a pure predicate over its input (no throw on odd shapes)', () => {
    expect(() => detectStructuredReading({ transcript: 'Zs for circuit 2 is 0.62' })).not.toThrow();
    expect(() => detectStructuredReading({ transcript: '' })).not.toThrow();
    expect(() => detectStructuredReading({})).not.toThrow();
  });
});

describe('F7 property — applyConfirmationDebounce (generated replay patterns)', () => {
  // Deterministic replay: a fresh field, an A-B-A pattern, and a same-token
  // repeat. No unseeded randomness; the tables are literal.
  function conf(field, value, token) {
    return { field, circuit: 1, value, text: `${field} ${value}`, dedupe_token: token };
  }

  test('window constant matches the source of truth', () => {
    expect(CONFIRMATION_DEBOUNCE_WINDOW_MS).toBeGreaterThan(0);
  });

  test('a fresh confirmation survives the debounce', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const out = applyConfirmationDebounce([conf('measured_zs_ohm', '0.62')], state, { now: 1000 });
    expect(out).toHaveLength(1);
  });

  test('A-B-A: interleaving distinct fields does not suppress the re-hit of A', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const now = 1000;
    const a1 = applyConfirmationDebounce([conf('measured_zs_ohm', '0.62')], state, { now });
    const b = applyConfirmationDebounce([conf('r1_r2_ohm', '0.40')], state, { now: now + 10 });
    const a2 = applyConfirmationDebounce([conf('measured_zs_ohm', '0.63')], state, {
      now: now + 20,
    });
    expect(a1).toHaveLength(1);
    expect(b).toHaveLength(1);
    // A different value on a different-from-lastField hit survives.
    expect(a2).toHaveLength(1);
  });
});
