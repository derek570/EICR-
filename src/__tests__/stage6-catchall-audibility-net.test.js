/**
 * marker-② (numeric-gate-redesign 2026-07-18) — the catch-all audibility net.
 *
 * A chimed turn that ends with ZERO speech-intent must ALWAYS speak, even when
 * a tool ran and did not error (the class A3/marker-①/M1/F7 all structurally
 * miss — live repro: "Zs for circuit 4." → calculate_zs succeeds with
 * computed:[] → beep-then-silence). Audibility is SPEECH-INTENT only
 * (surviving audible confirmations, emitted asks, current-generation queued
 * prompts, produced-then-DEBOUNCED confirmations) — never readings/observation
 * counts. The designed-silent exemption is classified by dispatcher OUTCOME
 * (body ok:true + computed.length>0 — the ::calc:: read-back-exempt write),
 * never by tool name.
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
    // Pinned decision (plan Open-q1): the already-recorded empty outcome gets
    // the GENERIC apology this wave — never-silent wins over perfect wording.
    // A specific "those are already recorded" message is a calculate_zs-
    // dispatcher follow-up, not this net's job. A future change here must be
    // deliberate.
    expect(catchallPrompts(result)).toHaveLength(1);
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

  test('a successful calculate_zs that COMPUTED values (designed-silent ::calc:: write) → no catch-all', async () => {
    // Phase-0 verified: computed writes carry ::calc:: and are EXCLUDED from
    // spoken read-back by design (the 2026-06-18 Audio-First auto-derivation
    // exemption) — a correct silent write must not draw a "say that again".
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
    // The ::calc:: write is on the wire but NOT spoken…
    expect((result.extracted_readings ?? []).some((r) => r.field === 'measured_zs_ohm')).toBe(true);
    expect((result.confirmations ?? []).some((c) => c.field === 'measured_zs_ohm')).toBe(false);
    // …and the outcome-based exemption keeps the catch-all quiet.
    expect(catchallPrompts(result)).toHaveLength(0);
    expect(catchallRows(opts.logger)).toHaveLength(0);
  });

  test('MIXED turn: computed calc + EMPTY calc → catch-all FIRES (exemption is every-call, not any-call)', async () => {
    // Codex diff-review cycle 1: a legitimate computed write must not mask a
    // sibling silent failure in the same turn.
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
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc both', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('MIXED turn: computed calc + REJECTED call → catch-all FIRES (mixed rejection defeats both M1 and the exemption)', async () => {
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
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc and a bad write', [], opts);
    // The M1 all-rejected net cannot fire (not ALL rejected) — marker-② must.
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('MIXED turn: computed calc + a silent non-calc op (derived write, ok body without computed[]) → catch-all FIRES', async () => {
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
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc and a silent op', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('PARTIAL batch: ONE board-scoped calculate_zs call with computed AND skipped circuits → catch-all FIRES', async () => {
    // Codex diff-review cycle 1: a single batch envelope can be partially
    // successful ("calculate Zs for all circuits" → some computed, some
    // skipped). The skipped circuits went silent for a non-designed reason,
    // so the call is NOT wholly designed-silent.
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
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calculate Zs for all circuits', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('INVISIBLE failure: computed calc visible + a thrown-dispatcher error NOT in tool_calls → catch-all FIRES (ledger guard)', async () => {
    // Codex cycle-1 mini-review: runToolLoop omits thrown dispatchers /
    // padded internal_no_result from tool_calls (they land only in the
    // per-round error counts), so every() over the visible subset would
    // exempt a turn with an invisible failure. The loop-ledger guard
    // (attempted==accumulated, zero errors) must defeat the exemption.
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
        // TWO attempted in round 0 but only one accumulated; one error row.
        tool_call_count_per_round: [2, 0],
        tool_error_count_per_round: [1, 0],
      };
    });
    const opts = baseOpts({ chimeObserved: true });
    const result = await runShadowHarness(session4(), 'calc plus a crash', [], opts);
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('CAP-HIT turn: computed calc + tool_use_cap_hit terminal → catch-all FIRES (never exempt an aborted/capped loop)', async () => {
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
    expect(catchallPrompts(result)).toHaveLength(1);
  });

  test('MALFORMED skipped (missing / null / non-array) fails CLOSED → catch-all FIRES for each variant', async () => {
    for (const skippedVariant of [undefined, null, 'none']) {
      const body = {
        ok: true,
        computed: [{ circuit_ref: 2, field: 'measured_zs_ohm', value: '1.10' }],
      };
      if (skippedVariant !== undefined) body.skipped = skippedVariant;
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
              tool_call_id: 'toolu_s',
              name: 'calculate_zs',
              input: { circuit_ref: 2, all: false },
              result: { tool_use_id: 'toolu_s', is_error: false, content: JSON.stringify(body) },
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
      const opts = baseOpts({ chimeObserved: true });
      const result = await runShadowHarness(session4(), 'calc odd shape', [], opts);
      expect(catchallPrompts(result)).toHaveLength(1);
    }
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
