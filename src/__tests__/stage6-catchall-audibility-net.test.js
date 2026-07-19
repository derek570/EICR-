/**
 * marker-② (numeric-gate-redesign 2026-07-18) — the catch-all audibility net.
 *
 * A chimed turn that ends with ZERO speech-intent must ALWAYS speak, even when
 * a tool ran and did not error (the class A3/marker-①/M1/F7 all structurally
 * miss — live repro: "Zs for circuit 4." → calculate_zs succeeds with
 * computed:[] → beep-then-silence). Audibility is SPEECH-INTENT only
 * (surviving audible confirmations, emitted asks, current-generation queued
 * prompts, produced-then-DEBOUNCED confirmations) — never readings/observation
 * counts. F/U-1 (2026-07-19): calculator writes now SPEAK ("calculated as"
 * read-back), so the former outcome-based designed-silent exemption is
 * removed — a computed calc turn whose read-back is lost fires the apology
 * (fail-audible), and a debounced calc read-back is predicate-4 evidence.
 *
 * Mock pattern mirrors stage6-orphan-net.test.js (mocked runToolLoop authors
 * toolLoopOut.tool_calls result envelopes directly; perTurnWrites is mutated
 * through opts.perTurnWritesRef() where a test needs real bundler
 * confirmations).
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-catchall-net';

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
  CATCHALL_AUDIBILITY_PROMPTS,
  NOOP_AUDIBILITY_PROMPTS,
  ORPHAN_PROMPTS,
  REJECTED_PROMPTS,
  OBSERVATION_ORPHAN_PROMPT,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} = await import('../extraction/stage6-shadow-harness.js');
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

/** The frozen live-repro tool loop: one non-error calculate_zs with an empty
 *  computed[] (skip reason parameterised), then nothing else. */
function mockCalcZsEmptyLoop(reason = 'no_r1_r2') {
  runToolLoopSpy.mockImplementation(async () => ({
    stop_reason: 'end_turn',
    rounds: 2,
    tool_calls: [
      {
        tool_call_id: 'toolu_calczs',
        name: 'calculate_zs',
        input: { circuit_ref: 4, all: false },
        result: {
          tool_use_id: 'toolu_calczs',
          is_error: false,
          content: JSON.stringify({
            ok: true,
            computed: [],
            skipped: [{ circuit_ref: 4, reason }],
          }),
        },
      },
    ],
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  }));
}

function catchallPrompts(result) {
  return (result.confirmations ?? []).filter((c) => c.field == null && CATCHALL_SET.has(c.text));
}

function catchallRows(logger) {
  return logger.info.mock.calls.filter(
    ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
  );
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
describe('marker-② — fires on the tool-ran-but-nothing-audible class', () => {
  test('(a) calculate_zs empty (missing input, no_r1_r2) + chime → exactly ONE catch-all apology + telemetry', async () => {
    // Ze present under the REAL dispatcher key; circuit 4 has no r1_r2 —
    // the no_r1_r2-reason variant the recorded fixture cannot seed (its
    // job_state path can only write supply Ze as the short `ze` key).
    const session = makeSession({
      circuits: { 0: { earth_loop_impedance_ze: '0.35' }, 4: { circuit_designation: 'Sockets' } },
    });
    mockCalcZsEmptyLoop('no_r1_r2');
    const opts = baseOpts({ chimeObserved: true, generationId: 'gen-a' });
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);

    const prompts = catchallPrompts(result);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].circuit).toBeNull();
    expect(prompts[0].expects_ios_ack).toBe(false);
    // No other apology family speaks (A3/M1/F7 all declined this shape).
    expect((result.confirmations ?? []).filter((c) => c.field == null)).toHaveLength(1);
    const rows = catchallRows(opts.logger);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({
      sessionId: SESSION_ID,
      generationId: 'gen-a',
      reason: 'no_speech_intent_survived',
    });
    expect(rows[0][1].tool_names).toEqual(['calculate_zs']);
  });

  test('(f) calculate_zs empty because ALREADY-RECORDED (already_set) → catch-all STILL fires (pinned: never silent this wave)', async () => {
    const session = makeSession({
      circuits: { 4: { measured_zs_ohm: '0.9', circuit_designation: 'Sockets' } },
    });
    mockCalcZsEmptyLoop('already_set');
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);
    // F/U-3 (2026-07-19) update to the original pinned decision: the REAL
    // calculate dispatcher now records a SPECIFIC "already recorded" voice
    // notice for this outcome (see the F/U-2/3 tests below and
    // stage6-fu23-silent-edges.test.js), which replaces the generic apology
    // via speech-intent. THIS test mocks the tool loop without the notice,
    // so it keeps pinning the net MACHINERY: zero speech-intent → the
    // generic apology still fires (never silent, fail-closed).
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('F/U-2/3: a dispatcher voice NOTICE (rename-to-same / already_set) reaches the wire and REPLACES the generic apology', async () => {
    // Simulates the real dispatcher contract: a successful-but-writeless
    // outcome records perTurnWrites.voiceNotices; the harness stamps the
    // generation id, queues it before the net evaluates (speech-intent →
    // no generic apology), and the §A4 drain emits it field:null this turn.
    const NOTICE = 'Zs for circuit 4 is already recorded — say a new reading to replace it.';
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.voiceNotices.push({ text: NOTICE });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_n1',
            name: 'calculate_zs',
            input: { circuit_ref: 4, all: false },
            result: {
              tool_use_id: 'toolu_n1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [],
                skipped: [{ circuit_ref: 4, reason: 'already_set' }],
              }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calculate Zs for circuit 4', [], opts);
    const noticeConfs = (result.confirmations ?? []).filter((c) => c.text === NOTICE);
    expect(noticeConfs).toHaveLength(1);
    expect(noticeConfs[0].field).toBeNull();
    expect(catchallPrompts(result)).toHaveLength(0);
    expect(catchallRows(opts.logger)).toHaveLength(0);
  });

  test('F/U-2/3: notices are dropped for mode-off users (confirmationsEnabled:false) — no wire leak', async () => {
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.voiceNotices.push({ text: 'Circuit 4 is unchanged — I did not catch a new name.' });
      return {
        stop_reason: 'end_turn',
        rounds: 1,
        tool_calls: [],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ chimeObserved: true, confirmationsEnabled: false });
    const result = await runShadowHarness(session4(), 'rename attempt', [], opts);
    expect((result.confirmations ?? []).some((c) => /unchanged/.test(c.text ?? ''))).toBe(false);
  });

  test('(e2) a write with NO confirmation produced and no dedupe evidence → catch-all fires (a silent write IS beep-then-silence)', async () => {
    // A derived-only write (mirror-style, derived:true) produces an
    // extracted_readings entry but is excluded from spoken read-back; the
    // tool result body carries no computed[] so the designed-silent-CALC
    // exemption does not apply. Readings are UI state, not speech.
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('bonding_conductor_continuity', 0, undefined), {
        value: 'OK',
        confidence: 1.0,
        source_turn_id: 'turn-1',
        derived: true,
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_w',
            name: 'record_reading',
            input: {},
            result: { tool_use_id: 'toolu_w', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'bonding check', [], opts);
    expect((result.extracted_readings ?? []).length).toBeGreaterThan(0);
    expect(catchallPrompts(result)).toHaveLength(1);
  });
});

function session4() {
  return makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
}

// ───────────────────────────────────────────────────────────────────────────
describe('marker-② — gates and exemptions (does NOT fire)', () => {
  test('(b) the chime gate is load-bearing: same empty calculate_zs WITHOUT chimeObserved → no apology', async () => {
    const session = session4();
    mockCalcZsEmptyLoop();
    const opts = baseOpts(); // no chimeObserved
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);
    expect(catchallPrompts(result)).toHaveLength(0);
    expect(catchallRows(opts.logger)).toHaveLength(0);
  });

  test('(c) confirmationsEnabled:false → no apology (mode-off opted out of the spoken channel)', async () => {
    const session = session4();
    mockCalcZsEmptyLoop();
    const opts = baseOpts({ chimeObserved: true, confirmationsEnabled: false });
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('(d) a successful reading with an audible confirmation → no catch-all (speech survived)', async () => {
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 4, undefined), {
        value: '0.86',
        confidence: 0.9,
        source_turn_id: 'turn-1',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_r',
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: 4, value: '0.86' },
            result: { tool_use_id: 'toolu_r', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'Zs for circuit 4 is 0.86', [], opts);
    expect((result.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('(e1) produced-then-DEBOUNCED confirmation (already heard) → no catch-all after a heard reading', async () => {
    const mkLoop = () =>
      runToolLoopSpy.mockImplementation(async (opts) => {
        const ptw = opts.perTurnWritesRef();
        ptw.readings.set(encodeReadingKey('measured_zs_ohm', 4, undefined), {
          value: '0.86',
          confidence: 0.9,
          source_turn_id: 'turn-x',
        });
        return {
          stop_reason: 'end_turn',
          rounds: 2,
          tool_calls: [
            {
              tool_call_id: 'toolu_r2',
              name: 'record_reading',
              input: { field: 'measured_zs_ohm', circuit: 4, value: '0.86' },
              result: { tool_use_id: 'toolu_r2', is_error: false, content: '{"ok":true}' },
            },
          ],
          aborted: false,
          messages_final: [],
          usage: {},
          terminal_reason: 'end_turn',
        };
      });
    const session = session4();
    mkLoop();
    const opts1 = baseOpts({ chimeObserved: true });
    const r1 = await runShadowHarness(session, 'Zs for circuit 4 is 0.86', [], opts1);
    expect((r1.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(true);

    // Same reading again within the 1500 ms debounce window: the confirmation
    // is PRODUCED then suppressed by applyConfirmationDebounce — the turn ends
    // with zero surviving speech, but the inspector already heard it. The
    // per-turn debounce evidence must exempt the catch-all (a false "say that
    // again" after a heard reading invites a duplicate re-dictation).
    mkLoop();
    const opts2 = baseOpts({ chimeObserved: true });
    const r2 = await runShadowHarness(session, 'Zs for circuit 4 is 0.86', [], opts2);
    expect((r2.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(false);
    expect(catchallPrompts(r2)).toHaveLength(0);
    expect(catchallRows(opts2.logger)).toHaveLength(0);
  });

  test('(g) a VERIFIED-audible side-effect (board switch → select_board TTS) → no catch-all (its confirmation survives)', async () => {
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.boardOps.push({ op: 'select_board', board_id: 'main' });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_b',
            name: 'select_board',
            input: { board_id: 'main' },
            result: { tool_use_id: 'toolu_b', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(makeSession(), 'work on the main board', [], opts);
    expect((result.confirmations ?? []).some((c) => /Switched/i.test(c.text ?? ''))).toBe(true);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('F/U-1: a successful calculate_zs that COMPUTED values SPEAKS a "calculated as" read-back → no catch-all', async () => {
    // F/U-1 (2026-07-19): calculator writes are no longer read-back-exempt.
    // An explicit "calculate Zs" speaks its result ("Circuit N, Zs calculated
    // as X"), so the turn carries speech-intent and the net never fires. The
    // former outcome-based designed-silent exemption (with its body parser +
    // loop-ledger guard) is REMOVED — see the fail-audible test below for the
    // regression pin.
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 4, undefined), {
        value: '1.21',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_c',
            name: 'calculate_zs',
            input: { circuit_ref: 4, all: false },
            result: {
              tool_use_id: 'toolu_c',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 4, field: 'measured_zs_ohm', value: '1.21' }],
                skipped: [],
              }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // The exemption requires an EXHAUSTIVE clean loop ledger — attempted
        // count equals the accumulated list and zero errors in any round.
        tool_call_count_per_round: [1, 0],
        tool_error_count_per_round: [0, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calculate Zs for circuit 4', [], opts);
    // The ::calc:: write is on the wire AND spoken with calculated phrasing…
    expect((result.extracted_readings ?? []).some((r) => r.field === 'measured_zs_ohm')).toBe(true);
    const calcConfs = (result.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm');
    expect(calcConfs).toHaveLength(1);
    expect(calcConfs[0].text).toMatch(/calculated as 1\.21/);
    // …so the turn carries speech-intent and the catch-all stays quiet.
    expect(catchallPrompts(result)).toHaveLength(0);
    expect(catchallRows(opts.logger)).toHaveLength(0);
  });

  test('MIXED turn: computed calc + EMPTY calc → computed value SPEAKS, no catch-all (skip wording is F/U-3)', async () => {
    // F/U-1: the computed circuit's read-back carries the turn's speech-
    // intent, so the net does not fire. The EMPTY sibling's skip stays
    // unspoken this wave — per-reason skip wording (already_set / no_zs…)
    // is the batched F/U-3 dispatcher follow-up, and a wholly-empty calc
    // turn (no computed circuits at all) still draws the catch-all apology
    // (tests (a)/(f) above).
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, undefined), {
        value: '1.10',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_m1',
            name: 'calculate_zs',
            input: { circuit_ref: 2, all: false },
            result: {
              tool_use_id: 'toolu_m1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [],
              }),
            },
          },
          {
            tool_call_id: 'toolu_m2',
            name: 'calculate_r1_plus_r2',
            input: { circuit_ref: 4, all: false, method: 'zs_minus_ze' },
            result: {
              tool_use_id: 'toolu_m2',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [],
                skipped: [{ circuit_ref: 4, reason: 'no_zs' }],
              }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // CLEAN ledger — makes the whole-turn every() classification the
        // deciding factor (a missing ledger would fail the exemption anyway
        // and mask a regression of the every()/skipped protections).
        tool_call_count_per_round: [2, 0],
        tool_error_count_per_round: [0, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc both', [], opts);
    const calcConfs = (result.confirmations ?? []).filter(
      (c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? '')
    );
    expect(calcConfs).toHaveLength(1);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('MIXED turn: computed calc + REJECTED sibling → the calc read-back still speaks, no catch-all', async () => {
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, undefined), {
        value: '1.10',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_x1',
            name: 'calculate_zs',
            input: { circuit_ref: 2, all: false },
            result: {
              tool_use_id: 'toolu_x1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [],
              }),
            },
          },
          {
            tool_call_id: 'toolu_x2',
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: 99, value: '0.5' },
            result: {
              tool_use_id: 'toolu_x2',
              is_error: true,
              content: JSON.stringify({ ok: false, error: 'source_not_found' }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // Realistic ledger: the rejection is a visible error row — BOTH the
        // ledger guard and the every() classification defeat the exemption.
        tool_call_count_per_round: [2, 0],
        tool_error_count_per_round: [1, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc and a bad write', [], opts);
    // F/U-1: the computed calc's read-back IS the turn's audible output — the
    // M1 all-rejected net can't fire (not ALL rejected) and marker-② doesn't
    // need to (speech survived).
    expect(
      (result.confirmations ?? []).some(
        (c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? '')
      )
    ).toBe(true);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('MIXED turn: computed calc + a silent derived write → calc speaks, mirror stays silent, no catch-all', async () => {
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, undefined), {
        value: '1.10',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      ptw.readings.set(encodeReadingKey('bonding_conductor_continuity', 0, undefined), {
        value: 'OK',
        confidence: 1.0,
        source_turn_id: 'turn-1',
        derived: true,
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_y1',
            name: 'calculate_zs',
            input: { circuit_ref: 2, all: false },
            result: {
              tool_use_id: 'toolu_y1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [],
              }),
            },
          },
          {
            tool_call_id: 'toolu_y2',
            name: 'record_reading',
            input: {},
            result: { tool_use_id: 'toolu_y2', is_error: false, content: '{"ok":true}' },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // CLEAN ledger — the every() classification is the deciding factor.
        tool_call_count_per_round: [2, 0],
        tool_error_count_per_round: [0, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc and a silent op', [], opts);
    // The calc result speaks; the derived (mirror) write stays silent by
    // design — Audio-First auto-derivation exception, unchanged by F/U-1.
    const confs = result.confirmations ?? [];
    expect(
      confs.some((c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? ''))
    ).toBe(true);
    expect(confs.some((c) => c.field === 'bonding_conductor_continuity')).toBe(false);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('PARTIAL batch: ONE board-scoped calculate_zs call with computed AND skipped circuits → computed speaks, no catch-all', async () => {
    // F/U-1: a partially-successful batch ("calculate Zs for all circuits" →
    // some computed, some skipped) speaks the computed circuits — the board-
    // scoped write keeps its board_id on the spoken entry. Per-reason skip
    // wording is the F/U-3 follow-up.
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, 'board-b'), {
        value: '1.10',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
        boardId: 'board-b',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_p1',
            name: 'calculate_zs',
            input: { all: true, board_id: 'board-b' },
            result: {
              tool_use_id: 'toolu_p1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [{ circuit_ref: 4, reason: 'no_r1_r2' }],
              }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // CLEAN ledger — the skipped.length===0 requirement is the deciding
        // factor for the partial-batch fire.
        tool_call_count_per_round: [1, 0],
        tool_error_count_per_round: [0, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calculate Zs for all circuits', [], opts);
    const calcConfs = (result.confirmations ?? []).filter(
      (c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? '')
    );
    expect(calcConfs).toHaveLength(1);
    expect(calcConfs[0].board_id).toBe('board-b');
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('F/U-1 regression pin: a computed calc whose read-back is LOST renders the turn silent → catch-all FIRES (exemption removed)', async () => {
    // THE fail-audible pin for the exemption removal. Pre-F/U-1 the outcome-
    // based designed-silent exemption (body ok:true ∧ computed>0 ∧ skipped:[]
    // ∧ clean loop ledger) would classify this turn as designed-silent and
    // keep the net quiet — masking a calc read-back regression as design.
    // Post-F/U-1 a computed calc turn is expected to SPEAK; if its
    // confirmation is lost anywhere downstream (here: a value that renders
    // to empty text, so buildConfirmationText returns null), the turn ends
    // with zero speech-intent and the apology MUST fire. Never silent.
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, undefined), {
        value: '', // renders to empty text → confirmation lost
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      return {
        stop_reason: 'end_turn',
        rounds: 2,
        tool_calls: [
          {
            tool_call_id: 'toolu_v1',
            name: 'calculate_zs',
            input: { circuit_ref: 2, all: false },
            result: {
              tool_use_id: 'toolu_v1',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [],
              }),
            },
          },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
        // A ledger the old exemption would have accepted as CLEAN — proving
        // the fire below comes from the removal, not a ledger technicality.
        tool_call_count_per_round: [1, 0],
        tool_error_count_per_round: [0, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc lost readback', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
    expect(catchallRows(opts.logger)).toHaveLength(1);
  });

  test('CAP-HIT turn: computed calc + tool_use_cap_hit terminal → the calc read-back still speaks, no catch-all', async () => {
    // F/U-1: the abnormal loop termination no longer matters to the net —
    // speech-intent (the spoken calc result) is the only currency. An
    // aborted/capped loop with zero speech still fires via predicate 4.
    runToolLoopSpy.mockImplementation(async (opts) => {
      const ptw = opts.perTurnWritesRef();
      ptw.readings.set(encodeReadingKey('measured_zs_ohm', 2, undefined), {
        value: '1.10',
        confidence: 1.0,
        source_turn_id: '::calc::calculate_zs',
      });
      return {
        stop_reason: 'tool_use',
        rounds: 8,
        tool_calls: [
          {
            tool_call_id: 'toolu_cap',
            name: 'calculate_zs',
            input: { circuit_ref: 2, all: false },
            result: {
              tool_use_id: 'toolu_cap',
              is_error: false,
              content: JSON.stringify({
                ok: true,
                computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
                skipped: [],
              }),
            },
          },
        ],
        aborted: true,
        messages_final: [],
        usage: {},
        terminal_reason: 'tool_use_cap_hit',
        tool_call_count_per_round: [1],
        tool_error_count_per_round: [0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc then wedge', [], opts);
    expect(
      (result.confirmations ?? []).some(
        (c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? '')
      )
    ).toBe(true);
    expect(catchallPrompts(result)).toHaveLength(0);
  });

  test('F/U-1: a DEBOUNCED calc read-back is already-heard evidence → no catch-all (predicate 4 covers calcs too)', async () => {
    // The debounce path replaces the old exemption for the legitimate-silence
    // case: an identical calc read-back within the 1500 ms window is
    // produced-then-suppressed, and the per-turn debounce evidence keeps the
    // net quiet — exactly the record_reading (e1) contract, now for calcs.
    const mkLoop = () =>
      runToolLoopSpy.mockImplementation(async (opts) => {
        const ptw = opts.perTurnWritesRef();
        ptw.readings.set(encodeReadingKey('measured_zs_ohm', 4, undefined), {
          value: '1.21',
          confidence: 1.0,
          source_turn_id: '::calc::calculate_zs',
        });
        return {
          stop_reason: 'end_turn',
          rounds: 2,
          tool_calls: [
            {
              tool_call_id: 'toolu_dc',
              name: 'calculate_zs',
              input: { circuit_ref: 4, all: false },
              result: {
                tool_use_id: 'toolu_dc',
                is_error: false,
                content: JSON.stringify({
                  ok: true,
                  computed: [{ circuit_ref: 4, field: 'measured_zs_ohm', value: '1.21' }],
                  skipped: [],
                }),
              },
            },
          ],
          aborted: false,
          messages_final: [],
          usage: {},
          terminal_reason: 'end_turn',
          tool_call_count_per_round: [1, 0],
          tool_error_count_per_round: [0, 0],
        };
      });
    const session = session4();
    mkLoop();
    const opts1 = baseOpts({ chimeObserved: true });
    const r1 = await runShadowHarness(session, 'calculate Zs for circuit 4', [], opts1);
    expect(
      (r1.confirmations ?? []).some(
        (c) => c.field === 'measured_zs_ohm' && /calculated as/.test(c.text ?? '')
      )
    ).toBe(true);

    mkLoop();
    const opts2 = baseOpts({ chimeObserved: true });
    const r2 = await runShadowHarness(session, 'calculate Zs for circuit 4', [], opts2);
    expect((r2.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(false);
    expect(catchallPrompts(r2)).toHaveLength(0);
    expect(catchallRows(opts2.logger)).toHaveLength(0);
  });

  test('(h) no double-fire with marker-①: a chimed no-content no-op → exactly ONE apology, from marker-① not marker-②', async () => {
    // Default mock = zero tool calls; garble has no digit / observation lead-in.
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(
      makeSession(),
      'Chuck it too is upstairs lights.',
      [],
      opts
    );
    const fieldNil = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(fieldNil).toHaveLength(1);
    expect(NOOP_AUDIBILITY_PROMPTS).toContain(fieldNil[0].text);
    expect(catchallPrompts(result)).toHaveLength(0);
    expect(catchallRows(opts.logger)).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('marker-② — hoisted-helper semantics', () => {
  test('a whitespace-only CURRENT-generation queued prompt is NOT audible → catch-all still fires (and the drain drops the blank)', async () => {
    mockCalcZsEmptyLoop();
    const session = session4();
    // A whitespace-only prompt in the current generation: isCurrentGenPrompt
    // matches it but isAudibleText must reject it — it cannot count as
    // speech-intent (the drain's trimmed-non-empty guard also keeps it off
    // the wire).
    session.pendingVoicePrompts = [{ text: '   ', generationId: 'gen-W' }];
    const opts = baseOpts({ chimeObserved: true, generationId: 'gen-W' });
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
    // The blank never reaches the wire.
    expect((result.confirmations ?? []).some((c) => c.text === '   ')).toBe(false);
  });

  test('an OTHER-generation queued prompt does NOT suppress the catch-all; a CURRENT-generation one does', async () => {
    mockCalcZsEmptyLoop();
    // Other generation → still fires.
    const sessionA = session4();
    sessionA.pendingVoicePrompts = [{ text: 'stale apology', generationId: 'gen-OLD' }];
    const optsA = baseOpts({ chimeObserved: true, generationId: 'gen-NEW' });
    const rA = await runShadowHarness(sessionA, 'Zs for circuit 4.', [], optsA);
    expect(catchallPrompts(rA)).toHaveLength(1);

    // Current generation (e.g. the pending-value apology) → suppressed.
    mockCalcZsEmptyLoop();
    const sessionB = session4();
    sessionB.pendingVoicePrompts = [{ text: 'queued current apology', generationId: 'gen-CUR' }];
    const optsB = baseOpts({ chimeObserved: true, generationId: 'gen-CUR' });
    const rB = await runShadowHarness(sessionB, 'Zs for circuit 4.', [], optsB);
    expect(catchallPrompts(rB)).toHaveLength(0);
    // The queued prompt itself drains and speaks this turn (A4).
    expect((rB.confirmations ?? []).some((c) => c.text === 'queued current apology')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('marker-② wave — generic tool-loop failure is never silent (Codex cycle 2)', () => {
  test('a GENERIC runToolLoop rejection (network/API error) → finalization still runs and exactly ONE apology speaks', async () => {
    // Pre-fix, a non-fatal loop error early-returned an EMPTY extraction
    // before A3/D2/F7/marker-②/A4 ever ran — a chimed turn died
    // beep-then-silence on any transport error. Now it takes the F7 Item-3
    // reduced-finalization path (cancelled latch), whose nothing-audible
    // fallback guarantees one spoken apology.
    runToolLoopSpy.mockImplementation(async () => {
      throw new Error('stream disconnected');
    });
    const opts = baseOpts({ chimeObserved: true, generationId: 'gen-err' });
    const result = await runShadowHarness(session4(), 'Zs for circuit 4.', [], opts);
    // Well-formed result (iOS never sees undefined)…
    expect(Array.isArray(result.extracted_readings)).toBe(true);
    // …and exactly ONE field-nil apology survived to the wire (the F7
    // cancellation-branch fallback text — marker-② itself is cancelled-gated).
    const fieldNil = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(fieldNil).toHaveLength(1);
    expect(fieldNil[0].text).toBe(ASK_AUDIBILITY_FALLBACK_TEXT);
    // The error is still in CloudWatch for diagnosis.
    const errRows = opts.logger.error.mock.calls.filter(([ev]) => ev === 'stage6_live_error');
    expect(errRows).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('marker-② — apology-text distinctness (client dedupe channels never collide)', () => {
  test('CATCHALL_AUDIBILITY_PROMPTS shares no text with ANY other apology family', () => {
    const others = new Set([
      ...ORPHAN_PROMPTS,
      ...REJECTED_PROMPTS,
      OBSERVATION_ORPHAN_PROMPT,
      ...NOOP_AUDIBILITY_PROMPTS,
      ASK_AUDIBILITY_FALLBACK_TEXT,
      // §D2 collapsed-fallback literals (inline in the harness — keep in sync).
      "Sorry — I didn't record those observations. Could you give them to me again?",
      "Sorry — I didn't record that observation. Could you give it to me again?",
    ]);
    expect(CATCHALL_AUDIBILITY_PROMPTS.length).toBe(5);
    for (const t of CATCHALL_AUDIBILITY_PROMPTS) {
      expect(others.has(t)).toBe(false);
    }
    // And the family itself has no internal duplicates.
    expect(new Set(CATCHALL_AUDIBILITY_PROMPTS).size).toBe(CATCHALL_AUDIBILITY_PROMPTS.length);
  });

  test('rotation varies the wording across turns (turnNum % len)', async () => {
    const session = session4();
    mockCalcZsEmptyLoop();
    const r1 = await runShadowHarness(
      session,
      'Zs for circuit 4.',
      [],
      baseOpts({ chimeObserved: true })
    );
    mockCalcZsEmptyLoop();
    const r2 = await runShadowHarness(
      session,
      'Zs for circuit 4.',
      [],
      baseOpts({ chimeObserved: true })
    );
    const t1 = catchallPrompts(r1)[0]?.text;
    const t2 = catchallPrompts(r2)[0]?.text;
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1).not.toBe(t2);
  });
});
