/**
 * P4 (ask-decline-ack-net 2026-07-23, feedback id 85 / session 2ACE7677) —
 * the answered-ask silent-continuation net.
 *
 * THE class: the assistant posed a clarify ask, the inspector ANSWERED it (a
 * real reply — a decline "No. Don't worry." counts), and the continuation
 * produced ZERO audible output. marker-② treats the earlier spoken ask as
 * audibility evidence (its `emittedAskToolCallIds.size===0` term is CORRECT for
 * the spoken-but-UNanswered class), so an ANSWERED-then-silent turn slips every
 * existing net — a "chime is a promise" / Audio-First #1 violation. This net
 * fires ONE field-null acknowledgment (two-variant wording) for that class.
 *
 * Mock pattern mirrors stage6-catchall-audibility-net.test.js: a mocked
 * runToolLoop authors the toolLoopOut result directly, and the per-turn ask
 * lifecycle is seeded through the REAL onAskUserStarted/onAskAnswered observers
 * via the `_seedAskLifecycle` test seam (a mocked loop has no real dispatcher to
 * drive them). perTurnWrites is mutated through opts.perTurnWritesRef() where a
 * test needs real bundler confirmations / a staged A1 answer.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-ask-decline-net';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

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

const {
  runShadowHarness,
  ASK_DECLINE_ACK_PROMPTS,
  ASK_ANSWERED_ACK_PROMPTS,
  NOOP_AUDIBILITY_PROMPTS,
  CATCHALL_AUDIBILITY_PROMPTS,
  ORPHAN_PROMPTS,
  REJECTED_PROMPTS,
  OBSERVATION_ORPHAN_PROMPT,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { encodeReadingKey } = await import('../extraction/stage6-per-turn-writes.js');

const DECLINE_SET = new Set(ASK_DECLINE_ACK_PROMPTS);
const ANSWERED_SET = new Set(ASK_ANSWERED_ACK_PROMPTS);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}) {
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
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      ...stateOverrides,
    },
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

function makePendingAsks(size = 0) {
  return { __tag: 'pending-asks-registry', size, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: makePendingAsks(),
    ws: makeWs(),
    confirmationsEnabled: true,
    ...overrides,
  };
}

/** field-null acks queued by THIS net (either family). */
function declineAckPrompts(result) {
  return (result.confirmations ?? []).filter(
    (c) => c.field == null && (DECLINE_SET.has(c.text) || ANSWERED_SET.has(c.text))
  );
}
function ackRows(logger) {
  return logger.info.mock.calls.filter(([ev]) => ev === 'stage6.answered_ask_ack_emitted');
}

/**
 * The realistic frozen tool loop for an answered-ask turn: round 1 posed an
 * ask_user (present in tool_calls, is_error:false), the answer came, round 2
 * end_turn produced nothing. `orphanToolCalls > 0` here is what correctly
 * EXCLUDES the A3/marker-① orphan net in production (an empty-tool-call mock
 * would falsely let marker-① fire and mask the P4 net). Optional ptwMutator
 * mutates perTurnWrites for a continuation that DID produce output.
 */
function silentAnsweredLoop(toolCallId = 'toolu_ask', ptwMutator = null) {
  runToolLoopSpy.mockImplementation(async (o) => {
    if (ptwMutator) ptwMutator(o.perTurnWritesRef());
    return {
      stop_reason: 'end_turn',
      rounds: 2,
      tool_calls: [
        {
          tool_call_id: toolCallId,
          name: 'ask_user',
          input: { question: 'Which reading was that?', reason: 'missing_value' },
          result: { tool_use_id: toolCallId, is_error: false, content: '{"answered":true}' },
        },
      ],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

/** A seeded emitted-then-answered ask lifecycle (mirrors the real dispatcher). */
function declineLifecycle(toolCallId = 'toolu_ask', source = 'initial') {
  return [
    { event: 'emitted', toolCallId, source },
    { event: 'answered', toolCallId, source, answered: true, declineClass: 'decline' },
  ];
}
function answeredLifecycle(toolCallId = 'toolu_ask', source = 'initial') {
  return [
    { event: 'emitted', toolCallId, source },
    { event: 'answered', toolCallId, source, answered: true, declineClass: null },
  ];
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  validateSpy.mockClear();
  runToolLoopSpy.mockImplementation(async () => ({
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: [],
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  }));
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

// ───────────────────────────────────────────────────────────────────────────
describe('P4 — the answered-ask silent-continuation net FIRES', () => {
  test('(a) a DECLINE reply ("No. Don\'t worry.") with a silent continuation → exactly ONE decline-family ack + telemetry', async () => {
    // The repro: an ask was posed + answered with a decline, the model no-op\'d,
    // nothing audible followed. turnNum=1 → decline family index 1.
    silentAnsweredLoop();
    const opts = baseOpts({ _seedAskLifecycle: declineLifecycle(), generationId: 'gen-a' });
    const result = await runShadowHarness(makeSession(), 'zed s for circuit three', [], opts);

    const acks = declineAckPrompts(result);
    expect(acks).toHaveLength(1);
    expect(DECLINE_SET.has(acks[0].text)).toBe(true);
    expect(acks[0].text).toBe(ASK_DECLINE_ACK_PROMPTS[1 % ASK_DECLINE_ACK_PROMPTS.length]);
    expect(acks[0].circuit).toBeNull();
    expect(acks[0].expects_ios_ack).toBe(false);
    // It is the ONLY field-nil output (no other apology family fired).
    expect((result.confirmations ?? []).filter((c) => c.field == null)).toHaveLength(1);
    const rows = ackRows(opts.logger);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({
      sessionId: SESSION_ID,
      generationId: 'gen-a',
      ack_class: 'decline',
      answered_ask_source: 'initial',
    });
  });

  test('(a2) fires even WITHOUT chimeObserved — the answered reply is the engagement signal, not a chime', async () => {
    silentAnsweredLoop();
    const opts = baseOpts({ _seedAskLifecycle: declineLifecycle() }); // no chimeObserved
    const result = await runShadowHarness(makeSession(), 'zed s for circuit three', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(1);
  });

  test('(b) a NON-decline answered outcome with a silent continuation → ONE generic "Okay."-class ack', async () => {
    silentAnsweredLoop();
    const opts = baseOpts({ _seedAskLifecycle: answeredLifecycle() });
    const result = await runShadowHarness(makeSession(), 'clarify then silence', [], opts);
    const acks = declineAckPrompts(result);
    expect(acks).toHaveLength(1);
    expect(ANSWERED_SET.has(acks[0].text)).toBe(true);
    expect(acks[0].text).toBe(ASK_ANSWERED_ACK_PROMPTS[1 % ASK_ANSWERED_ACK_PROMPTS.length]);
    expect(ackRows(opts.logger)[0][1].ack_class).toBe('answered');
  });

  test('(c) a brokered pvr-* answered ask that goes silent → ONE ack (source pvr)', async () => {
    silentAnsweredLoop('pvr-abc123');
    const opts = baseOpts({ _seedAskLifecycle: declineLifecycle('pvr-abc123', 'pvr') });
    const result = await runShadowHarness(makeSession(), 'pending value flow', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(1);
    expect(ackRows(opts.logger)[0][1].answered_ask_source).toBe('pvr');
  });

  test('(d) an answered ask whose continuation produces ONLY a DEBOUNCED-away confirmation → ack STILL fires (debounced excluded from post-answer audibility)', async () => {
    // A debounced confirmation was removed BEFORE crossing an audible channel —
    // it is NOT post-answer audible output. Suppressing the ack on it would
    // repeat the exact defect (answered utterance → silence).
    const mkLoop = () =>
      runToolLoopSpy.mockImplementation(async (o) => {
        const ptw = o.perTurnWritesRef();
        ptw.readings.set(encodeReadingKey('measured_zs_ohm', 3, undefined), {
          value: '0.55',
          confidence: 0.9,
          source_turn_id: 'turn-x',
        });
        return {
          stop_reason: 'end_turn',
          rounds: 2,
          tool_calls: [
            {
              tool_call_id: 'toolu_r',
              name: 'record_reading',
              input: { field: 'measured_zs_ohm', circuit: 3, value: '0.55' },
              result: { tool_use_id: 'toolu_r', is_error: false, content: '{"ok":true}' },
            },
          ],
          aborted: false,
          messages_final: [],
          usage: {},
          terminal_reason: 'end_turn',
        };
      });
    const session = makeSession();
    // Turn 1 — the reading is HEARD (produces an audible confirmation).
    mkLoop();
    const r1 = await runShadowHarness(session, 'zs for circuit 3 is 0.55', [], baseOpts());
    expect((r1.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(true);

    // Turn 2 — SAME reading within the debounce window (suppressed) PLUS an
    // answered ask that goes silent. The reading confirmation is debounced away
    // (survivingConfCount 0) but the ack must STILL fire.
    mkLoop();
    const r2 = await runShadowHarness(
      session,
      'zs for circuit 3 is 0.55',
      [],
      baseOpts({ _seedAskLifecycle: declineLifecycle() })
    );
    expect((r2.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(false);
    expect(declineAckPrompts(r2)).toHaveLength(1);
  });

  test('(e-cancel) Codex r1: an answered ask on a CANCELLED turn with nothing audible → ack STILL fires (F7 cancellation branch needs size===0, so it misses the answered case)', async () => {
    // The generation is cancelled AFTER the ask was answered (a wedged/failed
    // continuation → the cancellation finalization). F7's cancellation branch
    // requires emittedAskToolCallIds.size===0, so a size>0 answered ask is
    // covered by neither F7, marker-② (!cancelled), nor a not-cancelled P4 —
    // genuine silence, the exact feedback-85 class. P4 closes it.
    runToolLoopSpy.mockImplementation(async () => {
      throw new Error('stream disconnected mid-continuation');
    });
    const opts = baseOpts({ _seedAskLifecycle: declineLifecycle(), generationId: 'gen-cx' });
    const result = await runShadowHarness(makeSession(), 'ask, decline, then cancel', [], opts);
    // The turn ends well-formed…
    expect(Array.isArray(result.confirmations)).toBe(true);
    // …and exactly ONE field-nil ack survives — the P4 decline ack, NOT the F7
    // ASK_AUDIBILITY_FALLBACK_TEXT (F7's cancellation branch declined, size>0).
    const fieldNil = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(fieldNil).toHaveLength(1);
    expect(DECLINE_SET.has(fieldNil[0].text)).toBe(true);
  });

  test('(f-reemit) Codex mini-review: an ask RE-EMITTED after a decline answer, then RE-ANSWERED with a non-decline → fires the GENERIC family, not the stale decline (declineClass reset on re-emission)', async () => {
    silentAnsweredLoop('toolu_rx');
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'toolu_rx', source: 'initial' },
        {
          event: 'answered',
          toolCallId: 'toolu_rx',
          source: 'initial',
          answered: true,
          declineClass: 'decline',
        },
        { event: 'emitted', toolCallId: 'toolu_rx', source: 'initial' }, // re-emitted (resets class)
        {
          event: 'answered',
          toolCallId: 'toolu_rx',
          source: 'initial',
          answered: true,
          declineClass: null,
        }, // non-decline
      ],
    });
    const result = await runShadowHarness(makeSession(), 're-emit then generic answer', [], opts);
    const acks = declineAckPrompts(result);
    expect(acks).toHaveLength(1);
    // The stale 'decline' class must NOT survive the re-emission → generic ack.
    expect(ANSWERED_SET.has(acks[0].text)).toBe(true);
    expect(DECLINE_SET.has(acks[0].text)).toBe(false);
  });

  test('(g-interleave) Codex r3: an UNanswered srv-* ask emitted BEFORE the initial ask resolves → the ack STILL fires (later-emission is checked against the ANSWER resolution, not max emissionSeq)', async () => {
    // A emits, an srv-* dialogue-script ask B emits (via ASK_STARTED_OBSERVER)
    // while A awaits, THEN A is answered. B is never answered here and emitted
    // BEFORE A's resolution — it is NOT a "later emitted ask after the answer",
    // so the turn is silent-after-A and the ack must fire. A max-emissionSeq
    // rule would pick B (answered:false) and wrongly suppress.
    silentAnsweredLoop('toolu_A');
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'toolu_A', source: 'initial' },
        { event: 'emitted', toolCallId: 'srv-rcd-B', source: 'dialogue_script' }, // interleaved, never answered
        {
          event: 'answered',
          toolCallId: 'toolu_A',
          source: 'initial',
          answered: true,
          declineClass: 'decline',
        },
      ],
    });
    const result = await runShadowHarness(
      makeSession(),
      'interleaved srv ask then answer A',
      [],
      opts
    );
    const acks = declineAckPrompts(result);
    expect(acks).toHaveLength(1);
    expect(DECLINE_SET.has(acks[0].text)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('P4 — does NOT fire', () => {
  test('(e) an answered ask whose continuation WROTE a reading (audible confirmation survives) → no ack', async () => {
    runToolLoopSpy.mockImplementation(async (o) => {
      const ptw = o.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 3, undefined), {
        value: '0.55',
        confidence: 0.9,
        source_turn_id: 'turn-1',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_w',
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: 3, value: '0.55' },
            result: { tool_use_id: 'toolu_w', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ _seedAskLifecycle: answeredLifecycle() });
    const result = await runShadowHarness(makeSession(), 'zs for c3 is 0.55', [], opts);
    expect((result.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(declineAckPrompts(result)).toHaveLength(0);
    expect(ackRows(opts.logger)).toHaveLength(0);
  });

  test('(f) A1 mutual exclusion — the model ANSWERED via answer_user (spoken_response set) → no ack; EXACTLY ONE audible response', async () => {
    runToolLoopSpy.mockImplementation(async (o) => {
      const ptw = o.perTurnWritesRef();
      ptw.answer.stagedText = 'That circuit is on the upstairs board.';
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_ans',
            name: 'answer_user',
            input: { answer: 'That circuit is on the upstairs board.' },
            result: { tool_use_id: 'toolu_ans', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ _seedAskLifecycle: answeredLifecycle() });
    const result = await runShadowHarness(makeSession(), 'which board is c3 on?', [], opts);
    // The agentic answer is the audible response…
    expect(result.spoken_response).toBe('That circuit is on the upstairs board.');
    // …so the ack does NOT double-speak, and no field-nil apology of any family.
    expect(declineAckPrompts(result)).toHaveLength(0);
    expect((result.confirmations ?? []).filter((c) => c.field == null)).toHaveLength(0);
  });

  test("(g) a TIMEOUT (answered:false) → no ack — the already-emitted question is the turn's last audio", async () => {
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'toolu_t', source: 'initial' },
        { event: 'answered', toolCallId: 'toolu_t', source: 'initial', answered: false },
      ],
    });
    const result = await runShadowHarness(makeSession(), 'no reply came', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(0);
    // No queued field-nil apology at all (the plan pins: do NOT assert a
    // timeout apology — none exists; the spoken question already covered it).
    expect((result.confirmations ?? []).filter((c) => c.field == null)).toHaveLength(0);
  });

  test('(h) an srv-* engine ask that only EMITTED (never answered here — answered on a later transcript) → no ack', async () => {
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'srv-rcd-xyz', source: 'dialogue_script' },
      ],
    });
    const result = await runShadowHarness(makeSession(), 'rcd script step', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(0);
  });

  test('(h2) Codex r1: an ask RE-EMITTED after its earlier resolution → no ack (resolutionSeq must be > the latest emissionSeq)', async () => {
    // Defensive ordering: the same tool_call_id is emitted, answered, then
    // emitted AGAIN (a re-emission). The ledger keeps answered:true but the new
    // emissionSeq now exceeds the resolutionSeq — the ask has NOT been answered
    // since re-emission, so firing would double-speak over a live question.
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'toolu_re', source: 'initial' },
        {
          event: 'answered',
          toolCallId: 'toolu_re',
          source: 'initial',
          answered: true,
          declineClass: 'decline',
        },
        { event: 'emitted', toolCallId: 'toolu_re', source: 'initial' }, // re-emitted, now unanswered
      ],
    });
    const result = await runShadowHarness(makeSession(), 're-emitted ask', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(0);
  });

  test('(i) a LATER ask emitted AFTER the answer (a follow-up question) that itself times out → no ack (the follow-up question is audible)', async () => {
    // Sequence: ask A answered, continuation emits ask B (a fresh clarify) which
    // then times out. B is the LAST emitted ask and is NOT answered → no ack.
    const opts = baseOpts({
      _seedAskLifecycle: [
        { event: 'emitted', toolCallId: 'toolu_A', source: 'initial' },
        {
          event: 'answered',
          toolCallId: 'toolu_A',
          source: 'initial',
          answered: true,
          declineClass: 'decline',
        },
        { event: 'emitted', toolCallId: 'toolu_B', source: 'initial' },
        { event: 'answered', toolCallId: 'toolu_B', source: 'initial', answered: false },
      ],
    });
    const result = await runShadowHarness(makeSession(), 'ask, decline, re-ask, silence', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(0);
  });

  test('(j) confirmationsEnabled:false → no ack (mode-off opted out of the spoken channel)', async () => {
    const opts = baseOpts({ confirmationsEnabled: false, _seedAskLifecycle: declineLifecycle() });
    const result = await runShadowHarness(makeSession(), 'mode off decline', [], opts);
    expect(declineAckPrompts(result)).toHaveLength(0);
  });

  test('(k) no ask at all (a plain no-op turn) → the P4 net does not fire (marker-① owns that class)', async () => {
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(
      makeSession(),
      'Chuck it too is upstairs lights.',
      [],
      opts
    );
    // marker-① speaks its own apology, but NOT a P4 decline/answered ack.
    expect(declineAckPrompts(result)).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('P4 — mutual exclusion with marker-②', () => {
  test('an answered-ask silent turn WITH chimeObserved fires the P4 ack and NOT marker-② (emitted-ask term excludes it)', async () => {
    silentAnsweredLoop();
    const opts = baseOpts({ chimeObserved: true, _seedAskLifecycle: declineLifecycle() });
    const result = await runShadowHarness(makeSession(), 'ask, decline, silence, chimed', [], opts);
    const acks = declineAckPrompts(result);
    expect(acks).toHaveLength(1);
    // marker-② would have queued a CATCHALL_AUDIBILITY_PROMPTS text — assert none.
    const catchall = (result.confirmations ?? []).filter((c) =>
      CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
    );
    expect(catchall).toHaveLength(0);
    // Exactly one field-nil output overall (no double-speak).
    expect((result.confirmations ?? []).filter((c) => c.field == null)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('P4 — apology-text distinctness + rotation', () => {
  test('the two ack families share no text with ANY existing apology family (client dedupe channels never collide)', () => {
    const others = new Set([
      ...ORPHAN_PROMPTS,
      ...REJECTED_PROMPTS,
      OBSERVATION_ORPHAN_PROMPT,
      ...NOOP_AUDIBILITY_PROMPTS,
      ...CATCHALL_AUDIBILITY_PROMPTS,
      ASK_AUDIBILITY_FALLBACK_TEXT,
      "Sorry — I didn't record those observations. Could you give them to me again?",
      "Sorry — I didn't record that observation. Could you give it to me again?",
      "Sorry, I couldn't place that reading — could you say the field and value together again?",
    ]);
    for (const t of [...ASK_DECLINE_ACK_PROMPTS, ...ASK_ANSWERED_ACK_PROMPTS]) {
      expect(others.has(t)).toBe(false);
    }
    // The two families are mutually disjoint and internally duplicate-free.
    for (const t of ASK_DECLINE_ACK_PROMPTS) expect(ANSWERED_SET.has(t)).toBe(false);
    expect(new Set(ASK_DECLINE_ACK_PROMPTS).size).toBe(ASK_DECLINE_ACK_PROMPTS.length);
    expect(new Set(ASK_ANSWERED_ACK_PROMPTS).size).toBe(ASK_ANSWERED_ACK_PROMPTS.length);
  });

  test('Codex r2: each family carries FIVE phrasings (the NOOP/CATCHALL burst margin) so a repeat cannot re-silence a burst before the 6th consecutive turn', () => {
    expect(ASK_DECLINE_ACK_PROMPTS.length).toBe(5);
    expect(ASK_ANSWERED_ACK_PROMPTS.length).toBe(5);
  });

  test('the ack wording rotates across a FULL family cycle with no repeat within the window (turnNum % len)', async () => {
    // Five consecutive decline-silent turns on the SAME session must produce
    // five DISTINCT phrasings — no client field-null dedupe key collides within
    // the burst (the previous 3-phrase family wrapped on turn 4).
    const session = makeSession();
    const texts = [];
    for (let i = 0; i < ASK_DECLINE_ACK_PROMPTS.length; i += 1) {
      silentAnsweredLoop();
      const r = await runShadowHarness(
        session,
        `ask decline ${i}`,
        [],
        baseOpts({ _seedAskLifecycle: declineLifecycle() })
      );
      texts.push(declineAckPrompts(r)[0]?.text);
    }
    expect(texts.every((t) => typeof t === 'string')).toBe(true);
    expect(new Set(texts).size).toBe(ASK_DECLINE_ACK_PROMPTS.length);
  });
});
