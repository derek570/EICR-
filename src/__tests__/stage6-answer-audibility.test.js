/**
 * A1 agentic-voice (2026-07-23) — Item 4 marker-net integration + fallback
 * answer, harness level.
 *
 * Mock pattern mirrors stage6-catchall-audibility-net.test.js: the mocked
 * runToolLoop authors toolLoopOut.tool_calls envelopes AND simulates the
 * (real, unmocked-elsewhere) answer dispatchers' effect by mutating
 * perTurnWrites.answer through opts.perTurnWritesRef() — exactly the state
 * the dispatchers feed in production.
 *
 * Pins (plan Item 4 + Item 3.5):
 *  - staged answer = speech-intent: chimed answer turn draws NO apology from
 *    any net (marker-② mutual exclusion), and the bundler projects
 *    result.spoken_response with a NON-ENUMERABLE answer_source.
 *  - failed-answer self-healing: attempted-but-failed answer (sole failed
 *    answer_user; inspect-then-silence) stages the FIXED fallback in BOTH
 *    confirmation-toggle states — the answer feature owns its own audibility
 *    (the apology nets are confirmationsEnabled-gated and can't cover
 *    confirmation-OFF).
 *  - A3 orphan-net exclusion: a sole terminal-failed answer_user is NOT an
 *    all-rejected turn (no REJECTED_PROMPTS apology beside the fallback).
 *  - mixed write+failed-answer → read-back owns the turn, NO fallback.
 *  - cancelled turns: finalization (incl. fallback staging) still runs; a
 *    staged answer suppresses the F7 cancellation apology (one utterance).
 *  - confirmation-OFF chatter: zero synthesis, answer state untouched.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-answer-audibility';

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

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

const { runShadowHarness, CATCHALL_AUDIBILITY_PROMPTS, ASK_AUDIBILITY_FALLBACK_TEXT } =
  await import('../extraction/stage6-shadow-harness.js');
const { ANSWER_FALLBACK_TEXT } = await import('../extraction/stage6-dispatchers-answer.js');
const { ExtractionCancelledError } = await import('../extraction/stage6-control-flow-errors.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { encodeReadingKey } = await import('../extraction/stage6-per-turn-writes.js');

const CATCHALL_SET = new Set(CATCHALL_AUDIBILITY_PROMPTS);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    agenticAnswersEnabled: true,
    turnCount: 0,
    costTracker: { addSonnetUsage: jest.fn() },
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      ...stateOverrides,
    },
    extractedObservations: [],
    activeTurnTranscript: null,
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

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: makeWs(),
    confirmationsEnabled: true,
    chimeObserved: true,
    ...overrides,
  };
}

/** Author a tool loop whose only call is answer_user, with an optional
 *  side-effect on perTurnWrites (simulating the real dispatcher's staging /
 *  outcome recording). */
function mockAnswerLoop({ envelope, mutate, alsoWrite = false, throwAfter = false }) {
  runToolLoopSpy.mockImplementation(async (args) => {
    const ptw = args.perTurnWritesRef();
    if (mutate) mutate(ptw);
    if (alsoWrite) {
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 3, null), {
        value: '0.42',
        confidence: 0.95,
        source_turn_id: 'turn-t',
      });
    }
    if (throwAfter) throw new ExtractionCancelledError('watchdog ceiling');
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: envelope
        ? [
            {
              tool_call_id: 'toolu_ans',
              name: envelope.name ?? 'answer_user',
              input: {},
              result: {
                tool_use_id: 'toolu_ans',
                is_error: envelope.is_error,
                content: envelope.content,
              },
            },
          ]
        : [],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

function fieldNilApologies(result) {
  return (result.confirmations ?? []).filter((c) => c.field == null);
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
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
    voiceLatency: { flags: {} },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

// ───────────────────────────────────────────────────────────────────────────
describe('staged answer = speech-intent (mutual exclusion with every net)', () => {
  test('successful answer: spoken_response projected, answer_source NON-ENUMERABLE, zero apologies', async () => {
    const answer = 'Circuit 4 has no Zs recorded yet.';
    mockAnswerLoop({
      envelope: { is_error: false, content: JSON.stringify({ ok: true }) },
      mutate: (ptw) => {
        ptw.answer.featureTouched = true;
        ptw.answer.stagedText = answer;
        ptw.answer.stagedMeta = { truncated: false, chars: answer.length };
        ptw.answer.outcomes.push({ tool: 'answer_user', code: 'ok' });
      },
    });
    const result = await runShadowHarness(session(), "What's missing on circuit 4?", [], baseOpts());
    expect(result.spoken_response).toBe(answer);
    expect(result.answer_source).toBe('answer_user');
    // NON-ENUMERABLE: the marker never survives spread or JSON serialisation
    // (three frame sites destructure-spread the raw result; pendingExtractions
    // buffers it whole).
    expect(Object.keys(result)).not.toContain('answer_source');
    expect(JSON.stringify(result)).not.toContain('answer_source');
    expect({ ...result }.answer_source).toBeUndefined();
    // Zero apology of ANY family (marker-② mutual exclusion via speech-intent).
    expect(fieldNilApologies(result)).toHaveLength(0);

    function session() {
      return makeSession();
    }
  });

  test('confirmation-ON chimed chatter (no answer feature touched) still draws exactly one marker apology', async () => {
    // Regression pin: the answer machinery must not swallow the pre-existing
    // no-op nets when the feature was never attempted.
    const result = await runShadowHarness(
      makeSession(),
      'lovely wallpaper honestly',
      [],
      baseOpts()
    );
    expect(result.spoken_response).toBeUndefined();
    const apologies = fieldNilApologies(result);
    expect(apologies).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('failed-answer self-healing — the fixed fallback speaks in BOTH toggle states', () => {
  const failedAnswerMutate = (ptw) => {
    ptw.answer.featureTouched = true;
    ptw.answer.emptyRetryUsed = true;
    ptw.answer.outcomes.push({ tool: 'answer_user', code: 'empty_answer' });
  };

  test.each([
    ['confirmations ON', true],
    ['confirmations OFF', false],
  ])(
    'sole failed answer_user → fallback staged + spoken_response, zero apology confirmations — %s',
    async (_label, confirmationsEnabled) => {
      mockAnswerLoop({
        envelope: { is_error: true, content: JSON.stringify({ ok: false, code: 'empty_answer' }) },
        mutate: failedAnswerMutate,
      });
      const opts = baseOpts({ confirmationsEnabled });
      const result = await runShadowHarness(makeSession(), 'did you get that?', [], opts);
      expect(result.spoken_response).toBe(ANSWER_FALLBACK_TEXT);
      expect(result.answer_source).toBe('answer_fallback');
      // Exactly ONE utterance: the fallback via VCR. No A3 REJECTED_PROMPTS
      // apology (name-guard exclusion), no marker-② catch-all, no F7.
      expect(fieldNilApologies(result)).toHaveLength(0);
      const staged = opts.logger.info.mock.calls.filter(
        ([ev]) => ev === 'stage6.answer_fallback_staged'
      );
      expect(staged).toHaveLength(1);
    }
  );

  test('inspect-then-silence (feature touched via inspect only) → fallback speaks', async () => {
    mockAnswerLoop({
      envelope: {
        name: 'inspect_session_state',
        is_error: false,
        content: JSON.stringify({ ok: true, scope: 'summary' }),
      },
      mutate: (ptw) => {
        ptw.answer.featureTouched = true;
        ptw.answer.outcomes.push({ tool: 'inspect_session_state', code: 'ok' });
      },
    });
    const result = await runShadowHarness(makeSession(), 'what is left overall?', [], baseOpts());
    expect(result.spoken_response).toBe(ANSWER_FALLBACK_TEXT);
    expect(fieldNilApologies(result)).toHaveLength(0);
  });

  test('mixed successful-write + failed answer → read-back owns the turn, NO fallback', async () => {
    mockAnswerLoop({
      envelope: { is_error: true, content: JSON.stringify({ ok: false, code: 'empty_answer' }) },
      mutate: failedAnswerMutate,
      alsoWrite: true,
    });
    const result = await runShadowHarness(
      makeSession({ circuits: { 3: { circuit_designation: 'Cooker' } } }),
      'Zs on circuit 3 is 0.42 and also tell me...',
      [],
      baseOpts()
    );
    expect(result.spoken_response).toBeUndefined();
    // The write survived and produces its read-back confirmation.
    expect(result.extracted_readings).toHaveLength(1);
    expect((result.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(true);
  });

  test('confirmation-OFF chimed chatter (no answer feature) → NOTHING spoken, answer state untouched', async () => {
    const opts = baseOpts({ confirmationsEnabled: false });
    const result = await runShadowHarness(makeSession(), 'lovely wallpaper honestly', [], opts);
    expect(result.spoken_response).toBeUndefined();
    expect(result.confirmations ?? []).toHaveLength(0);
    const staged = opts.logger.info.mock.calls.filter(
      ([ev]) => ev === 'stage6.answer_fallback_staged'
    );
    expect(staged).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('cancelled turns — finalization still runs; answers suppress the F7 cancellation apology', () => {
  test('answer staged then loop cancellation → the answer survives, no F7 apology', async () => {
    const answer = 'Three circuits are still incomplete.';
    mockAnswerLoop({
      envelope: null,
      mutate: (ptw) => {
        ptw.answer.featureTouched = true;
        ptw.answer.stagedText = answer;
        ptw.answer.stagedMeta = { truncated: false, chars: answer.length };
        ptw.answer.outcomes.push({ tool: 'answer_user', code: 'ok' });
      },
      throwAfter: true,
    });
    const session = makeSession();
    const result = await runShadowHarness(session, 'how many circuits are left?', [], baseOpts());
    expect(result.spoken_response).toBe(answer);
    // No F7 cancellation apology queued — the staged answer is an audible
    // survivor on the cancellation branch.
    const queued = (session.pendingVoicePrompts ?? []).map((p) => p.text);
    expect(queued).not.toContain(ASK_AUDIBILITY_FALLBACK_TEXT);
    expect(fieldNilApologies(result).filter((c) => CATCHALL_SET.has(c.text))).toHaveLength(0);
  });

  test('cancelled turn + failed answer, no write → exactly the fallback (both nets stay silent)', async () => {
    mockAnswerLoop({
      envelope: null,
      mutate: (ptw) => {
        ptw.answer.featureTouched = true;
        ptw.answer.emptyRetryUsed = true;
        ptw.answer.outcomes.push({ tool: 'answer_user', code: 'empty_answer' });
      },
      throwAfter: true,
    });
    const session = makeSession();
    const result = await runShadowHarness(session, 'did you get that?', [], baseOpts());
    expect(result.spoken_response).toBe(ANSWER_FALLBACK_TEXT);
    const queued = (session.pendingVoicePrompts ?? []).map((p) => p.text);
    expect(queued).not.toContain(ASK_AUDIBILITY_FALLBACK_TEXT);
  });

  test('cancelled turn with NO answer-feature touch → existing F7 cancellation behaviour unchanged', async () => {
    runToolLoopSpy.mockImplementation(async () => {
      throw new ExtractionCancelledError('watchdog ceiling');
    });
    const session = makeSession();
    const result = await runShadowHarness(session, 'Zs is 0.42 on circuit 3.', [], baseOpts());
    expect(result.spoken_response).toBeUndefined();
    // The F7 cancellation fallback still fires (nothing audible survived).
    const apologyTexts = fieldNilApologies(result).map((c) => c.text);
    expect(apologyTexts).toContain(ASK_AUDIBILITY_FALLBACK_TEXT);
  });
});
