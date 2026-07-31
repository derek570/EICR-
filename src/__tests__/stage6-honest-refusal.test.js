/**
 * Plan B (honest-refusal, 2026-07-28, feedback id 101 secondary) — §5 test
 * matrix. "I can't do that" ≠ "I didn't catch that": a structurally
 * impossible request draws an honest, non-retry-inviting refusal — audibly,
 * every chimed attempt — while recoverable rejections keep today's behaviour
 * byte-identically.
 *
 * Mock pattern mirrors stage6-clear-board-reading-audibility.test.js: the
 * mocked runToolLoop invokes the REAL composed dispatcher (opts.dispatcher)
 * so capability threading, validation order, refusal staging, coverage
 * arbitration and the net-0 drain are exercised end-to-end at the harness
 * seam — the only place the A3 REJECTED_PROMPTS interception is visible.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-honest-refusal';

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
let lastLoopPerTurnWrites = null;

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
  REJECTED_PROMPTS,
  ORPHAN_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { BOARD_CLEAR_NOTICE_FAMILIES, selectMandatoryNoticeText, classifyBoardClear } =
  await import('../extraction/stage6-dispatchers-board.js');
const refusalModule = await import('../extraction/refusal-notices.js');
const {
  B_STAGED_POOLS,
  B_STAGED_TERMINALS,
  DIRECT_DENIAL_TERMINALS,
  renderedNoticeInventory,
  REFUSAL_REPEAT_WINDOW_MS,
} = refusalModule;
const { CONFIRMATION_FRIENDLY_NAMES, deriveFriendlyName } =
  await import('../extraction/confirmation-text.js');
const { boardSlotKey } = await import('../extraction/stage6-per-turn-writes.js');

const CATCHALL_SET = new Set(CATCHALL_AUDIBILITY_PROMPTS);
const REJECTED_SET = new Set(REJECTED_PROMPTS);
const ORPHAN_SET = new Set(ORPHAN_PROMPTS);

const ZE_FRIENDLY =
  CONFIRMATION_FRIENDLY_NAMES['earth_loop_impedance_ze'] ??
  deriveFriendlyName('earth_loop_impedance_ze');
const PFC_FRIENDLY =
  CONFIRMATION_FRIENDLY_NAMES['prospective_fault_current'] ??
  deriveFriendlyName('prospective_fault_current');

// unsupported_clear discriminated label for circuit_ref on circuit 4, single
// "main" board (ordinal 1 — boards[] exists, so the slot's board component is
// non-null and the ordinal clause renders).
const CIRCUIT_REF_LABEL_C4 = 'Circuit Reference for circuit 4 on board 1';

const bridgePoolTexts = (route, friendly) => B_STAGED_POOLS[route].map((f) => f(friendly));

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}, extra = {}) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    certType: 'eicr',
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
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
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
    ...extra,
  };
}

function registerEntry(capable) {
  const supports = capable ? ['board_clear_v1'] : [];
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: {
      flags: { loadedBarrel: false },
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports },
      }),
    },
  });
}

function makePendingAsks(size = 0) {
  return { __tag: 'pending-asks-registry', size, entries: () => [] };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: makePendingAsks(),
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    chimeObserved: true,
    ...overrides,
  };
}

/** Mock the loop to dispatch the given calls through the REAL dispatcher. */
function loopDispatching(calls) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    lastLoopPerTurnWrites =
      typeof opts.perTurnWritesRef === 'function' ? opts.perTurnWritesRef() : null;
    const toolCalls = [];
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i];
      const env = await opts.dispatcher(
        { tool_call_id: c.id ?? `toolu_${i}`, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({
        tool_call_id: c.id ?? `toolu_${i}`,
        name: c.name,
        input: c.input,
        result: env,
      });
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

const clearReadingCall = (field, circuit, id) => ({
  name: 'clear_reading',
  input: { field, circuit, reason: 'user_correction' },
  id,
});
const clearBoardCall = (field, id) => ({
  name: 'clear_board_reading',
  input: { field, reason: 'user_correction' },
  id,
});
const readingCall = (id) => ({
  name: 'record_reading',
  input: {
    field: 'measured_zs_ohm',
    circuit: 4,
    value: '0.86',
    confidence: 0.95,
    source_turn_id: 't1',
  },
  id,
});
const observationCall = (id, overrides = {}) => ({
  name: 'record_observation',
  input: {
    code: 'C3',
    location: null,
    text: 'AFDD protection is absent',
    circuit: null,
    suggested_regulation: '421.1.7',
    schedule_item: '5.22',
    rationale: null,
    clarification_chain_id: null,
    code_basis: null,
    ...overrides,
  },
  id,
});

function audibleConfs(result) {
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

function assertNoGenericApologies(result, logger) {
  for (const c of audibleConfs(result)) {
    expect(CATCHALL_SET.has(c.text)).toBe(false);
    expect(REJECTED_SET.has(c.text)).toBe(false);
    expect(ORPHAN_SET.has(c.text)).toBe(false);
    expect(c.text).not.toBe(ASK_AUDIBILITY_FALLBACK_TEXT);
  }
  const catchallRows = logger.info.mock.calls.filter(
    ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
  );
  expect(catchallRows).toHaveLength(0);
}

function orphanRows(logger) {
  return logger.info.mock.calls.filter(([ev]) => ev === 'stage6.orphan_prompt_emitted');
}
function mandatoryRows(logger) {
  return logger.info.mock.calls.filter(([ev]) => ev === 'stage6.mandatory_notice_emitted');
}
function suppressionRows(logger) {
  return logger.info.mock.calls.filter(
    ([ev]) => ev === 'stage6.rejected_prompt_suppressed_by_refusals'
  );
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  lastLoopPerTurnWrites = null;
  registerEntry(false); // default DARK — the headline C06B9904 state
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
  delete process.env.BOARD_CLEAR_DISABLED;
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.1 — unsupported_clear: known circuit field with no clear support', () => {
  test('clear_reading on circuit_ref speaks the unsupported_clear family; REJECTED_PROMPTS suppressed; one audible line; envelope byte-identical', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([clearReadingCall('circuit_ref', 4, 'toolu_u1')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear the circuit reference on 4.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4)).toContain(speakers[0].text);
    expect(speakers[0].field).toBeNull();
    assertNoGenericApologies(result, opts.logger);
    expect(orphanRows(opts.logger)).toHaveLength(0);
    expect(suppressionRows(opts.logger)).toHaveLength(1);
    // Envelope byte-identity: the hard rejection is unchanged.
    const loopOut = await runToolLoopSpy.mock.results[0].value;
    expect(loopOut.tool_calls[0].result.is_error).toBe(true);
    expect(JSON.parse(loopOut.tool_calls[0].result.content)).toEqual({
      ok: false,
      error: { code: 'field_not_clearable', field: 'field', value: 'circuit_ref' },
    });
    // Telemetry carries the route + coverage count (leak-safe dimensions).
    const rows = mandatoryRows(opts.logger);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({ family: 'unsupported_clear', covered_count: 1 });
  });

  test('next-turn no-reinjection pin: a fully-covered refusal turn does NOT set session.orphanContext', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([clearReadingCall('circuit_ref', 4, 'toolu_u2')]);
    const result = await runShadowHarness(
      session,
      'Clear the circuit reference on 4.',
      [],
      baseOpts()
    );
    expect(audibleConfs(result)).toHaveLength(1);
    // The harness clears orphanContext to null at consume time; the pin is
    // that a fully-covered refusal turn leaves NO context to reinject (a
    // {transcript,...} object here is the retry-loop this plan kills).
    expect(session.orphanContext == null).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.2 — the HEADLINE Ze bridge (clear_reading on a board-coverable field)', () => {
  test('DARK, raw spelling: earth_loop_impedance_ze canonicalises to ze and routes to the BRIDGE — capability_missing denial with bridge wording, exactly ONE audible line, REJECTED_PROMPTS suppressed', async () => {
    const session = makeSession();
    loopDispatching([clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_ze1')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    // BRIDGE pool (byte-distinct from A1a's DIRECT pool) — global scope, so
    // the label carries no board discriminator.
    expect(bridgePoolTexts('board_clear_capability_missing', ZE_FRIENDLY)).toContain(
      speakers[0].text
    );
    // NOT the unsupported_clear / model_contract routes (the round-2 miss),
    // and NOT the A1a direct pool (round-15 route-distinct early attempts).
    expect(
      BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) => f(ZE_FRIENDLY))
    ).not.toContain(speakers[0].text);
    assertNoGenericApologies(result, opts.logger);
    expect(orphanRows(opts.logger)).toHaveLength(0);
  });

  test('DARK, raw prospective_fault_current AND canonical ze/pfc all route to the bridge (canonical-vs-canonical membership)', async () => {
    for (const field of ['prospective_fault_current', 'ze', 'pfc']) {
      const session = makeSession();
      loopDispatching([clearReadingCall(field, 0, `toolu_${field}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, `Delete ${field}.`, [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      const friendly = field.includes('fault') || field === 'pfc' ? PFC_FRIENDLY : ZE_FRIENDLY;
      expect(bridgePoolTexts('board_clear_capability_missing', friendly)).toContain(
        speakers[0].text
      );
      assertNoGenericApologies(result, opts.logger);
    }
  });

  test('CAPABLE-uncorrected: one wrong_tool_clear routing-snag line, never "say it again"; the bridge NEVER mutates', async () => {
    registerEntry(true);
    const session = makeSession({ circuits: { 0: { ze: '1.6' } } });
    loopDispatching([clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_wtc')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(bridgePoolTexts('wrong_tool_clear', ZE_FRIENDLY)).toContain(speakers[0].text);
    expect(speakers[0].text).not.toMatch(/say (that|it) again/i);
    // Mutation-free pin: the bridge classified but did NOT clear.
    expect(session.stateSnapshot.circuits[0].ze).toBe('1.6');
    assertNoGenericApologies(result, opts.logger);
  });

  test('CAPABLE with same-turn correction, BOTH orders: the clear_board_reading success reconciles the wrong_tool_clear away (key = boardSlotKey(ze, null), the GLOBAL null board component)', async () => {
    for (const order of ['reject-first', 'success-first']) {
      registerEntry(true);
      const session = makeSession({ circuits: { 0: { ze: '1.6' } } });
      const calls =
        order === 'reject-first'
          ? [
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_r'),
              clearBoardCall('ze', 'toolu_s'),
            ]
          : [
              clearBoardCall('ze', 'toolu_s'),
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_r'),
            ];
      loopDispatching(calls);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Delete Ze.', [], opts);

      // The success read-back speaks alone: zero wrong_tool_clear lines.
      const wtcTexts = new Set([
        ...bridgePoolTexts('wrong_tool_clear', ZE_FRIENDLY),
        B_STAGED_TERMINALS.wrong_tool_clear(ZE_FRIENDLY, 1),
      ]);
      for (const c of audibleConfs(result)) {
        expect(wtcTexts.has(c.text)).toBe(false);
      }
      // The clear actually happened.
      expect(session.stateSnapshot.circuits[0] ?? {}).not.toHaveProperty('ze');
      // Reconciliation key parity: the staged notice's slot equals the
      // success stamp's boardSlotKey('ze', null) in this ordering.
      const cls = classifyBoardClear(session, { hasBoardClearV1: true }, 'ze', {
        field: 'earth_loop_impedance_ze',
      });
      expect(cls.slotKey).toBe(boardSlotKey('ze', null));
      assertNoGenericApologies(result, opts.logger);
      activeSessions.delete(SESSION_ID);
    }
  });

  test('clear_board_reading on Ze still stages A1a’s own DIRECT notice byte-identically (dark)', async () => {
    const session = makeSession();
    loopDispatching([clearBoardCall('ze', 'toolu_direct')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(
      BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) => f(ZE_FRIENDLY))
    ).toContain(speakers[0].text);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.3 — off-schema field string (leak pin)', () => {
  test('model_contract off-schema route: no unsupported_clear, the raw string NEVER renders, one audible line', async () => {
    const session = makeSession();
    loopDispatching([clearReadingCall('banana_volts', 3, 'toolu_off')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear the banana volts.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(B_STAGED_POOLS.offschema_clear.map((f) => f())).toContain(speakers[0].text);
    for (const c of audibleConfs(result)) {
      expect(c.text.includes('banana_volts')).toBe(false);
      expect(c.text.includes('banana')).toBe(false);
    }
    // The telemetry row must not carry the raw field either.
    const rows = mandatoryRows(opts.logger);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].field).toBeNull();
    assertNoGenericApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PLAN-3 — regulation-topic mismatch covered-refusal lifecycle', () => {
  const isTopicRefusal = (text) =>
    B_STAGED_POOLS.regulation_topic_mismatch.some((render) => render() === text);

  test('solo mismatch speaks the specific line once and suppresses the generic retry prompt', async () => {
    const session = makeSession();
    loopDispatching([
      observationCall('toolu_topic_solo', {
        suggested_regulation: '443.4',
      }),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'AFDD protection is absent.', [], opts);

    expect(session.extractedObservations).toHaveLength(0);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(isTopicRefusal(speakers[0].text)).toBe(true);
    expect(mandatoryRows(opts.logger)).toEqual([
      expect.arrayContaining([
        'stage6.mandatory_notice_emitted',
        expect.objectContaining({
          family: 'observation_integrity',
          route: 'regulation_topic_mismatch',
          covered_count: 1,
        }),
      ]),
    ]);
    expect(suppressionRows(opts.logger)).toHaveLength(1);
    assertNoGenericApologies(result, opts.logger);
  });

  test('mismatch and one emitted clarification speak both the ask and the specific refusal', async () => {
    const session = makeSession();
    const ws = { readyState: 1, OPEN: 1, send: jest.fn() };
    const emittedAsk = Object.assign(
      async (call) => {
        ws.send(
          JSON.stringify({
            type: 'ask_user_started',
            tool_call_id: call.tool_call_id,
            question: call.input.question,
          })
        );
        return {
          tool_use_id: call.tool_call_id,
          content: JSON.stringify({ answered: false, reason: 'user_moved_on' }),
          is_error: false,
        };
      },
      { __tag: 'asks' }
    );
    createAskDispatcherSpy.mockImplementationOnce(() => emittedAsk);
    loopDispatching([
      observationCall('toolu_topic_ask_reject', { suggested_regulation: '443.4' }),
      {
        name: 'ask_user',
        input: {
          question: 'Is this observation about AFDD protection or surge protection?',
          context_field: 'observation_clarify',
          circuit: null,
          board_id: null,
          pending_write: null,
          clarification_chain_id: null,
        },
        id: 'toolu_topic_ask',
      },
    ]);
    const opts = baseOpts({ ws });
    const result = await runShadowHarness(session, 'AFDD protection is absent.', [], opts);

    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: 'ask_user_started',
        question: 'Is this observation about AFDD protection or surge protection?',
      })
    );
    expect(audibleConfs(result).filter((c) => isTopicRefusal(c.text))).toHaveLength(1);
    assertNoGenericApologies(result, opts.logger);
  });

  test('same-turn corrected re-record speaks its read-back beside the first-attempt refusal', async () => {
    const session = makeSession();
    loopDispatching([
      observationCall('toolu_topic_retry_reject', { suggested_regulation: '443.4' }),
      observationCall('toolu_topic_retry_success', {
        text: 'AFDD protection is absent in this HMO',
        code_basis: 'afdd_premises_requirement',
      }),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'AFDD protection is absent in this HMO.',
      [],
      opts
    );

    expect(session.extractedObservations).toHaveLength(1);
    const speakers = audibleConfs(result);
    expect(speakers.filter((c) => isTopicRefusal(c.text))).toHaveLength(1);
    expect(speakers.filter((c) => !isTopicRefusal(c.text))).toHaveLength(1);
    expect(speakers.find((c) => !isTopicRefusal(c.text))?.text).toMatch(/C3|AFDD/i);
    assertNoGenericApologies(result, opts.logger);
  });

  test('ignored mismatch stays audible beside an unrelated surviving reading without leaking the raw ref', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([
      observationCall('toolu_topic_ignored', { suggested_regulation: '534.999' }),
      readingCall('toolu_topic_sibling'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'AFDD absent. Zs on 4 is 0.86.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers.filter((c) => isTopicRefusal(c.text))).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'measured_zs_ohm')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('534.999');
    assertNoGenericApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.4 — unknown-tool: both envelope routes', () => {
  test('string-form (composer route): model_contract wording, envelope byte-identical, REJECTED_PROMPTS suppressed, one audible line', async () => {
    const session = makeSession();
    loopDispatching([{ name: 'frobnicate_reading', input: { anything: 1 }, id: 'toolu_uk1' }]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Do the frobnication.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(B_STAGED_POOLS.unknown_tool.map((f) => f())).toContain(speakers[0].text);
    // Never a capability refusal for a hallucinated tool.
    expect(speakers[0].text).not.toMatch(/can't (do|clear)/i);
    const loopOut = await runToolLoopSpy.mock.results[0].value;
    expect(JSON.parse(loopOut.tool_calls[0].result.content)).toEqual({
      error: 'unknown_tool',
      name: 'frobnicate_reading',
    });
    expect(loopOut.tool_calls[0].result.is_error).toBe(true);
    assertNoGenericApologies(result, opts.logger);
  });

  test('object-form (createWriteDispatcher route via null-asks ask_user): counts as rejected (round-15 predicate), suppression works, one audible line', async () => {
    const session = makeSession();
    loopDispatching([{ name: 'ask_user', input: { question: 'which circuit?' }, id: 'toolu_uk2' }]);
    const opts = baseOpts({ pendingAsks: null });
    const result = await runShadowHarness(session, 'Some question turn.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(B_STAGED_POOLS.unknown_tool.map((f) => f())).toContain(speakers[0].text);
    const loopOut = await runToolLoopSpy.mock.results[0].value;
    expect(JSON.parse(loopOut.tool_calls[0].result.content)).toEqual({
      ok: false,
      error: { code: 'unknown_tool' },
    });
    assertNoGenericApologies(result, opts.logger);
    expect(orphanRows(opts.logger)).toHaveLength(0);
  });

  test('object-form route, recovery-success variant: a structurally complete reading in the transcript is STILL recovered and read back; the refusal drains additively beside it', async () => {
    const session = makeSession({ circuits: { 5: { circuit_designation: 'Shower' } } });
    loopDispatching([{ name: 'ask_user', input: { question: 'hm?' }, id: 'toolu_uk3' }]);
    const opts = baseOpts({ pendingAsks: null });
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 5 is 24 ms',
      [],
      opts
    );

    const speakers = audibleConfs(result);
    // The recovered reading's read-back AND the refusal notice both speak.
    expect(speakers.length).toBeGreaterThanOrEqual(2);
    expect(speakers.some((c) => B_STAGED_POOLS.unknown_tool.map((f) => f()).includes(c.text))).toBe(
      true
    );
    // The reading landed (branch 1: recovery runs FIRST, regardless of coverage).
    expect(session.stateSnapshot.circuits[5].rcd_time_ms).toBeDefined();
    // No generic prompt of any family.
    assertNoGenericApologies(result, opts.logger);
  });

  test('off-schema clear + genuine unknown-tool in one window keep SEPARATE ordinals (neither inflates the other)', async () => {
    const session = makeSession();
    // Three turns: off-schema clear ×2, then unknown tool. If the buckets
    // were shared, the unknown-tool render would be attempt 3 (terminal).
    for (let i = 0; i < 2; i += 1) {
      loopDispatching([clearReadingCall('banana_volts', 3, `toolu_o${i}`)]);
      await runShadowHarness(session, 'Clear the banana volts.', [], baseOpts());
    }
    loopDispatching([{ name: 'frobnicate_reading', input: {}, id: 'toolu_u9' }]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Frobnicate.', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    // Attempt 1 of the unknown_tool bucket — a pool variant, NOT a terminal.
    expect(B_STAGED_POOLS.unknown_tool.map((f) => f())).toContain(speakers[0].text);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.5 — recoverable errors stage NOTHING (fail-audible pin)', () => {
  test('circuit_not_found keeps today’s A3 behaviour byte-identically: REJECTED_PROMPTS speaks, no notice', async () => {
    const session = makeSession();
    loopDispatching([clearReadingCall('measured_zs_ohm', 99, 'toolu_rec')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear Zs on circuit 99.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
    expect(mandatoryRows(opts.logger)).toHaveLength(0);
    expect(orphanRows(opts.logger)).toHaveLength(1);
    expect(orphanRows(opts.logger)[0][1]).toMatchObject({ cause: 'all_rejected' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.6 — mixed turns', () => {
  test('one refused op + one successful write: refusal AND read-back both speak (additive channel), no generic prompt', async () => {
    const session = makeSession({ circuits: { 4: { circuit_designation: 'Sockets' } } });
    loopDispatching([clearReadingCall('circuit_ref', 4, 'toolu_m1'), readingCall('toolu_m2')]);
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'Clear the reference on 4. Zs on 4 is 0.86.',
      [],
      opts
    );

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(
      speakers.some((c) =>
        bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4).includes(c.text)
      )
    ).toBe(true);
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('0.86');
    assertNoGenericApologies(result, opts.logger);
  });

  test('round-18 pin — A1a soft-skip denial + UNCOVERED hard rejection: the drained direct notice IS the audible output; no REJECTED_PROMPTS; never silent', async () => {
    const session = makeSession();
    loopDispatching([
      clearBoardCall('ze', 'toolu_soft'),
      clearReadingCall('measured_zs_ohm', 99, 'toolu_hard'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze. Clear Zs on 99.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(
      BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) => f(ZE_FRIENDLY))
    ).toContain(speakers[0].text);
    for (const c of speakers) expect(REJECTED_SET.has(c.text)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.7 — partial coverage (round-2 double-speak case)', () => {
  test('one unsupported_clear + one ordinary validation rejection ⇒ exactly ONE generic line, ZERO refusal lines', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([
      clearReadingCall('circuit_ref', 4, 'toolu_p1'),
      clearReadingCall('measured_zs_ohm', 99, 'toolu_p2'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear those.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
    const refusalTexts = bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4);
    for (const c of speakers) expect(refusalTexts.includes(c.text)).toBe(false);
    expect(mandatoryRows(opts.logger)).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.8 — coalescing + across-turn repeat contract', () => {
  test('five same-turn rejections of one op ⇒ ONE line covering all five ids (coverage appended; ordinal NOT inflated)', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([
      clearReadingCall('circuit_ref', 4, 'toolu_c1'),
      clearReadingCall('circuit_ref', 4, 'toolu_c2'),
      clearReadingCall('circuit_ref', 4, 'toolu_c3'),
      clearReadingCall('circuit_ref', 4, 'toolu_c4'),
      clearReadingCall('circuit_ref', 4, 'toolu_c5'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear the reference on 4.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    // Attempt 1 wording — five coalesced calls must NOT render "attempt 5".
    expect(bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4)).toContain(speakers[0].text);
    // Exact coverage set via the telemetry dimension (suppression of the
    // generic line with five rejected envelopes is itself proof all five
    // ids were covered — a missing id would flip the turn to partial
    // coverage and speak the generic line instead).
    const rows = mandatoryRows(opts.logger);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toMatchObject({ family: 'unsupported_clear', covered_count: 5 });
    assertNoGenericApologies(result, opts.logger);
    // Next-ordinal pin: the per-slot count advanced ONCE.
    const key = Object.keys(session.refusedOps ?? {}).find((k) =>
      k.startsWith('unsupported_clear::')
    );
    expect(session.refusedOps[key].count).toBe(1);
  });

  test('two different excluded fields in one turn ⇒ two lines', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([
      clearReadingCall('circuit_ref', 4, 'toolu_d1'),
      clearReadingCall('is_distribution_circuit', 4, 'toolu_d2'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear both.', [], opts);
    expect(audibleConfs(result)).toHaveLength(2);
    assertNoGenericApologies(result, opts.logger);
  });

  test('five ACROSS-turn repeats ⇒ five audible lines, all full-string-distinct (pool → ordinal terminal from attempt 3), never silence; refusedOps resets after the 30 s window', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    const texts = [];
    for (let i = 0; i < 5; i += 1) {
      loopDispatching([clearReadingCall('circuit_ref', 4, `toolu_x${i}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Clear the reference on 4.', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      texts.push(speakers[0].text);
      assertNoGenericApologies(result, opts.logger);
    }
    expect(new Set(texts).size).toBe(5);
    // Attempts 1–2: pool variants; attempts 3–5: ordinal terminals.
    const pool = bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4);
    expect(pool).toContain(texts[0]);
    expect(pool).toContain(texts[1]);
    for (let n = 3; n <= 5; n += 1) {
      expect(texts[n - 1]).toBe(B_STAGED_TERMINALS.unsupported_clear(CIRCUIT_REF_LABEL_C4, n));
    }
    // Prune pin: age the entry past the client-dedupe window → attempt 1 again.
    const key = Object.keys(session.refusedOps).find((k) => k.startsWith('unsupported_clear::'));
    session.refusedOps[key].lastAt -= REFUSAL_REPEAT_WINDOW_MS + 1000;
    loopDispatching([clearReadingCall('circuit_ref', 4, 'toolu_x5')]);
    const result = await runShadowHarness(session, 'Clear the reference on 4.', [], baseOpts());
    const after = audibleConfs(result);
    expect(after).toHaveLength(1);
    expect(pool).toContain(after[0].text);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.9 — mixed-route provenance (round-14): direct→bridge and bridge→direct', () => {
  test('both orders produce IDENTICAL state (count 1) and identical B-staged wording', async () => {
    const outputs = [];
    for (const order of ['direct-first', 'bridge-first']) {
      registerEntry(false);
      const session = makeSession();
      const calls =
        order === 'direct-first'
          ? [
              clearBoardCall('ze', 'toolu_a'),
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_b'),
            ]
          : [
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_b'),
              clearBoardCall('ze', 'toolu_a'),
            ];
      loopDispatching(calls);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      outputs.push(speakers[0].text);
      const repeatKey = `board_clear_capability_missing::${boardSlotKey('ze', null)}`;
      expect(session.refusedOps[repeatKey].count).toBe(1);
      // The A1a family cursor was NOT advanced by the transition itself —
      // selection happened once at the drain for the covered entry, which
      // uses the per-slot count, not the cursor.
      assertNoGenericApologies(result, opts.logger);
      activeSessions.delete(SESSION_ID);
    }
    expect(outputs[0]).toBe(outputs[1]);
    expect(bridgePoolTexts('board_clear_capability_missing', ZE_FRIENDLY)).toContain(outputs[0]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.10 — A1a DIRECT-denial terminals (attempt 6+) + shared-helper parity', () => {
  test('six consecutive DARK denials on one family: five distinct variants then the family’s OWN truthful terminal (never the "nothing recorded" string), never a byte-identical pair', async () => {
    const session = makeSession();
    const texts = [];
    for (let i = 0; i < 6; i += 1) {
      loopDispatching([clearBoardCall('ze', `toolu_t${i}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      texts.push(speakers[0].text);
    }
    expect(new Set(texts).size).toBe(6);
    const variants = BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) =>
      f(ZE_FRIENDLY)
    );
    for (let i = 0; i < 5; i += 1) expect(variants).toContain(texts[i]);
    expect(texts[5]).toBe(DIRECT_DENIAL_TERMINALS.board_clear_capability_missing(ZE_FRIENDLY, 6));
    expect(texts[5]).not.toMatch(/nothing recorded/i);
  });

  test('six consecutive already-empty clears keep the empty-flavoured terminal', async () => {
    registerEntry(true);
    const session = makeSession(); // ze never set → already_empty every time
    const texts = [];
    for (let i = 0; i < 6; i += 1) {
      loopDispatching([clearBoardCall('ze', `toolu_e${i}`)]);
      const result = await runShadowHarness(session, 'Delete Ze.', [], baseOpts());
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      texts.push(speakers[0].text);
    }
    expect(new Set(texts).size).toBe(6);
    expect(texts[5]).toBe(DIRECT_DENIAL_TERMINALS.board_clear_already_empty(ZE_FRIENDLY, 6));
  });

  test('interleaved TWO-FIELD direct denials in one family: family-wide ordinal scope + per-render distinctness', async () => {
    const session = makeSession();
    const mfrFriendly =
      CONFIRMATION_FRIENDLY_NAMES['manufacturer'] ?? deriveFriendlyName('manufacturer');
    const fields = ['ze', 'manufacturer', 'ze', 'manufacturer', 'ze', 'manufacturer'];
    const texts = [];
    for (let i = 0; i < fields.length; i += 1) {
      loopDispatching([clearBoardCall(fields[i], `toolu_i${i}`)]);
      const result = await runShadowHarness(session, `Delete ${fields[i]}.`, [], baseOpts());
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      texts.push(speakers[0].text);
    }
    expect(new Set(texts).size).toBe(6);
    // The 6th render is the FAMILY-wide terminal — ordinal 6 even though it
    // is only the third denial for `manufacturer` (round-10: family/session
    // scope wording, with the label carried separately).
    expect(texts[5]).toBe(DIRECT_DENIAL_TERMINALS.board_clear_capability_missing(mfrFriendly, 6));
  });

  test('shared-helper parity: the board-file re-export IS the shared module’s object; selection semantics pinned (seeded first selection, monotonic rotation, no wrap-repeat)', () => {
    expect(BOARD_CLEAR_NOTICE_FAMILIES).toBe(refusalModule.BOARD_CLEAR_NOTICE_FAMILIES);
    expect(selectMandatoryNoticeText).toBe(refusalModule.selectMandatoryNoticeText);
    const session = {};
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      seen.push(selectMandatoryNoticeText(session, 'board_clear_disabled', 'turn-77', 'Ze'));
    }
    expect(new Set(seen).size).toBe(5);
    // Deterministic seed: a fresh session with the same turnId starts at the
    // same variant (djb2-seeded first selection).
    const session2 = {};
    expect(selectMandatoryNoticeText(session2, 'board_clear_disabled', 'turn-77', 'Ze')).toBe(
      seen[0]
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PLAN-2D — structural and unroutable reading refusals', () => {
  const boardReadingCall = (field, value, id) => ({
    name: 'record_board_reading',
    input: {
      field,
      value,
      confidence: 0.95,
      source_turn_id: 't-plan2d',
    },
    id,
  });
  const circuitReadingCall = (field, value, id) => ({
    name: 'record_reading',
    input: {
      field,
      circuit: 4,
      value,
      confidence: 0.95,
      source_turn_id: 't-plan2d',
    },
    id,
  });
  const markDistributionCall = (id) => ({
    name: 'mark_distribution_circuit',
    input: { circuit: 4, feeds_board_id: 'sub-1', board_id: 'main' },
    id,
  });
  const twoBoardSession = () =>
    makeSession({
      circuits: { 4: { designation: 'Sub-board feed' } },
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'Garage CU', board_type: 'sub_distribution' },
      ],
      currentBoardId: 'main',
    });

  test.each(['sub_main_cable_material', 'sub_main_cable_csa', 'sub_main_cpc_csa'])(
    '%s solo refusal names the Board tab and suppresses the generic retry prompt',
    async (field) => {
      const session = twoBoardSession();
      loopDispatching([boardReadingCall(field, 'test-value', `toolu_${field}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, `Set ${field}.`, [], opts);

      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      expect(speakers[0].text).toMatch(/Board tab/i);
      assertNoGenericApologies(result, opts.logger);
      expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
        family: 'unroutable_board_reading',
        covered_count: 1,
      });
    }
  );

  test('mixed sub-main rejection + surviving write speaks both outcomes', async () => {
    const session = twoBoardSession();
    loopDispatching([
      boardReadingCall('sub_main_cable_material', 'SWA', 'toolu_unroutable'),
      readingCall('toolu_success'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'Sub-main cable is SWA and circuit 4 Zs is 0.86.',
      [],
      opts
    );

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(speakers.some((c) => /Board tab/i.test(c.text))).toBe(true);
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    assertNoGenericApologies(result, opts.logger);
  });

  test('third same-slot unroutable attempt carries an ordinal instead of deduping to silence', async () => {
    const session = twoBoardSession();
    const heard = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      loopDispatching([
        boardReadingCall('sub_main_cable_csa', '16', `toolu_unroutable_${attempt}`),
      ]);
      const result = await runShadowHarness(session, 'Sub-main cable size is 16.', [], baseOpts());
      heard.push(...audibleConfs(result).map((c) => c.text));
    }
    expect(heard).toHaveLength(3);
    expect(new Set(heard).size).toBe(3);
    expect(heard[2]).toMatch(/attempt 3/i);
  });

  test.each([
    ['board', 'board_type', 'sub_distribution'],
    ['board', 'parent_board_id', 'main'],
    ['board', 'feed_circuit_ref', '4'],
    ['board', 'sort_order', '2'],
    ['circuit', 'circuit_ref', '5'],
    ['circuit', 'feeds_board_id', 'sub-1'],
    ['circuit', 'is_distribution_circuit', 'no'],
  ])('%s structural member %s is terminal and never mutates', async (kind, field, value) => {
    const session = twoBoardSession();
    const before = structuredClone(session.stateSnapshot);
    const call =
      kind === 'board'
        ? boardReadingCall(field, value, `toolu_terminal_${field}`)
        : circuitReadingCall(field, value, `toolu_terminal_${field}`);
    loopDispatching([call]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, `Set ${field}.`, [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].text).toMatch(/screen|reading/i);
    expect(session.stateSnapshot).toEqual(before);
    expect(result.extracted_readings ?? []).toEqual([]);
    expect(lastLoopPerTurnWrites?.readings.size).toBe(0);
    expect(lastLoopPerTurnWrites?.boardReadings.size).toBe(0);
    expect(lastLoopPerTurnWrites?.readingJournal).toEqual([]);
    expect(lastLoopPerTurnWrites?.boardReadingJournal).toEqual([]);
    assertNoGenericApologies(result, opts.logger);
    expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
      family: 'unsupported_structural_reading',
      covered_count: 1,
    });
  });

  test('recoverable distribution-link reading names mark_distribution_circuit', async () => {
    const session = twoBoardSession();
    loopDispatching([
      circuitReadingCall('is_distribution_circuit', 'yes', 'toolu_wrong_structure'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Circuit 4 feeds the sub-board.', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].text).toContain('mark_distribution_circuit');
    expect(session.stateSnapshot.circuits[4].is_distribution_circuit).toBeUndefined();
    assertNoGenericApologies(result, opts.logger);
  });

  test.each(['reject-first', 'success-first'])(
    'same-turn mark_distribution_circuit success reconciles the recoverable notice (%s)',
    async (order) => {
      const session = twoBoardSession();
      const rejected = circuitReadingCall(
        'is_distribution_circuit',
        'yes',
        `toolu_wrong_structure_${order}`
      );
      const success = markDistributionCall(`toolu_mark_${order}`);
      loopDispatching(order === 'reject-first' ? [rejected, success] : [success, rejected]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Circuit 4 feeds the garage board.', [], opts);

      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      expect(speakers[0].text).toBe('Circuit 4 marked as feeding the sub-board');
      expect(speakers[0].text).not.toContain('mark_distribution_circuit');
      expect(session.stateSnapshot.circuits[4]).toMatchObject({
        is_distribution_circuit: 'yes',
        feeds_board_id: 'sub-1',
      });
      expect(mandatoryRows(opts.logger)).toHaveLength(0);
      assertNoGenericApologies(result, opts.logger);
    }
  );

  test.each(['reject-first', 'success-first'])(
    'feeds_board_id stays terminal beside mark_distribution_circuit success (%s)',
    async (order) => {
      const session = twoBoardSession();
      const rejected = circuitReadingCall(
        'feeds_board_id',
        'sub-other',
        `toolu_terminal_link_${order}`
      );
      const success = markDistributionCall(`toolu_mark_terminal_${order}`);
      loopDispatching(order === 'reject-first' ? [rejected, success] : [success, rejected]);
      const opts = baseOpts();
      const result = await runShadowHarness(
        session,
        'Circuit 4 feeds another board; mark it as feeding the garage board.',
        [],
        opts
      );

      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(2);
      expect(speakers.some((c) => /screen|reading/i.test(c.text))).toBe(true);
      expect(speakers.some((c) => c.text === 'Circuit 4 marked as feeding the sub-board')).toBe(
        true
      );
      expect(session.stateSnapshot.circuits[4]).toMatchObject({
        is_distribution_circuit: 'yes',
        feeds_board_id: 'sub-1',
      });
      expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
        family: 'unsupported_structural_reading',
        covered_count: 1,
      });
      assertNoGenericApologies(result, opts.logger);
    }
  );

  test('off-enum record_reading is rejected before mutation and speaks one leak-safe refusal', async () => {
    const session = twoBoardSession();
    const before = structuredClone(session.stateSnapshot);
    const rawField = '__private_model_field__';
    const rawValue = 'secret-model-value';
    loopDispatching([
      {
        ...circuitReadingCall(rawField, rawValue, 'toolu_offschema_record'),
        input: {
          ...circuitReadingCall(rawField, rawValue, 'toolu_offschema_record').input,
          circuit: 999,
          confidence: 2,
          board_id: 'sub-1',
        },
      },
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, `${rawField} is ${rawValue}.`, [], opts);

    expect(session.stateSnapshot).toEqual(before);
    expect(result.extracted_readings).toEqual([]);
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0].text).toMatch(/field I recognise|field I know|known field/i);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(rawField);
    expect(wire).not.toContain(rawValue);
    expect(lastLoopPerTurnWrites?.readings.size).toBe(0);
    expect(lastLoopPerTurnWrites?.boardReadings.size).toBe(0);
    expect(lastLoopPerTurnWrites?.readingJournal).toEqual([]);
    expect(lastLoopPerTurnWrites?.boardReadingJournal).toEqual([]);
    expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
      family: 'model_contract',
      route: 'offschema_record',
      covered_count: 1,
    });
    assertNoGenericApologies(result, opts.logger);
  });

  test.each([
    [
      'record_board_reading',
      {
        name: 'record_board_reading',
        input: {
          field: '__private_board_field__',
          value: 'secret-board-value',
          confidence: 2,
          source_turn_id: 't-plan2d',
          board_id: 'sub-1',
        },
        id: 'toolu_offschema_board',
      },
      '__private_board_field__',
      'secret-board-value',
    ],
    [
      'set_field_for_all_circuits',
      {
        name: 'set_field_for_all_circuits',
        input: {
          field: '__private_bulk_field__',
          value: 'secret-bulk-value',
          confidence: 2,
          source_turn_id: 't-plan2d',
          scope: 'invalid_scope',
          board_id: 'missing-board',
        },
        id: 'toolu_offschema_bulk',
      },
      '__private_bulk_field__',
      'secret-bulk-value',
    ],
  ])(
    '%s off-enum field outranks malformed companion arguments and stays leak-free',
    async (_tool, call, rawField, rawValue) => {
      const session = twoBoardSession();
      const before = structuredClone(session.stateSnapshot);
      loopDispatching([call]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, `${rawField} is ${rawValue}.`, [], opts);

      expect(session.stateSnapshot).toEqual(before);
      expect(result.extracted_readings ?? []).toEqual([]);
      expect(result.confirmations).toHaveLength(1);
      expect(result.confirmations[0].text).toMatch(/field I recognise|field I know|known field/i);
      const wire = JSON.stringify(result);
      expect(wire).not.toContain(rawField);
      expect(wire).not.toContain(rawValue);
      expect(lastLoopPerTurnWrites?.readings.size).toBe(0);
      expect(lastLoopPerTurnWrites?.boardReadings.size).toBe(0);
      expect(lastLoopPerTurnWrites?.readingJournal).toEqual([]);
      expect(lastLoopPerTurnWrites?.boardReadingJournal).toEqual([]);
      expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
        family: 'model_contract',
        route: 'offschema_record',
        covered_count: 1,
      });
      assertNoGenericApologies(result, opts.logger);
    }
  );

  test('mixed off-schema calls coalesce leak-free beside one surviving read-back', async () => {
    const session = twoBoardSession();
    const rawField = '__private_mixed_field__';
    const rawValue = 'secret-mixed-value';
    loopDispatching([
      {
        ...circuitReadingCall(rawField, rawValue, 'toolu_mixed_circuit'),
        input: {
          ...circuitReadingCall(rawField, rawValue, 'toolu_mixed_circuit').input,
          circuit: 999,
          confidence: 2,
        },
      },
      {
        ...boardReadingCall(rawField, rawValue, 'toolu_mixed_board'),
        input: {
          ...boardReadingCall(rawField, rawValue, 'toolu_mixed_board').input,
          confidence: 2,
          board_id: 'sub-1',
        },
      },
      {
        name: 'set_field_for_all_circuits',
        input: {
          field: rawField,
          value: rawValue,
          confidence: 2,
          source_turn_id: 't-plan2d',
          scope: 'invalid_scope',
        },
        id: 'toolu_mixed_bulk',
      },
      readingCall('toolu_mixed_success'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Mixed model output.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(speakers.some((c) => /field I recognise|field I know|known field/i.test(c.text))).toBe(
      true
    );
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(rawField);
    expect(wire).not.toContain(rawValue);
    expect(lastLoopPerTurnWrites?.readings.size).toBe(1);
    expect(lastLoopPerTurnWrites?.boardReadings.size).toBe(0);
    expect(lastLoopPerTurnWrites?.readingJournal).toHaveLength(1);
    expect(lastLoopPerTurnWrites?.boardReadingJournal).toEqual([]);
    expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
      family: 'model_contract',
      route: 'offschema_record',
      covered_count: 3,
    });
    assertNoGenericApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Codex cycle-1 — recovery × partial coverage, board-scoped provenance, discriminator matrix, all direct terminals', () => {
  test('branch 1 with PARTIAL coverage: a recovered reading speaks AND the covered refusal drains additively; no generic prompt', async () => {
    const session = makeSession({ circuits: { 5: { circuit_designation: 'Shower' } } });
    loopDispatching([
      clearReadingCall('circuit_ref', 5, 'toolu_pcov'),
      clearReadingCall('measured_zs_ohm', 99, 'toolu_punc'),
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 5 is 24 ms',
      [],
      opts
    );

    // The recovered write landed and was read back…
    expect(session.stateSnapshot.circuits[5].rcd_time_ms).toBeDefined();
    const speakers = audibleConfs(result);
    expect(speakers.length).toBeGreaterThanOrEqual(2);
    // …the covered refusal was NOT drain:false-stamped (recovery ran first)…
    const refusalPool = bridgePoolTexts(
      'unsupported_clear',
      'Circuit Reference for circuit 5 on board 1'
    );
    expect(speakers.some((c) => refusalPool.includes(c.text))).toBe(true);
    // …and no generic prompt of any family fired.
    assertNoGenericApologies(result, opts.logger);
  });

  test('untrusted discriminators stage NOTHING (fail-audible): a malformed circuit keeps today’s generic A3 wording, never a covered refusal', async () => {
    const session = makeSession({ circuits: { 4: {} } });
    loopDispatching([
      {
        name: 'clear_reading',
        input: { field: 'circuit_ref', circuit: '4', reason: 'user_correction' },
        id: 'toolu_badc',
      },
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Clear the reference.', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
    expect(mandatoryRows(opts.logger)).toHaveLength(0);
  });

  test('BOARD-SCOPED direct↔bridge provenance, both orders: identical output carrying the board ordinal; distinct bytes across two boards sharing a designation', async () => {
    const perBoard = {};
    for (const boardId of ['main', 'b2']) {
      const outputs = [];
      for (const order of ['direct-first', 'bridge-first']) {
        registerEntry(false);
        const session = makeSession({
          boards: [
            { id: 'main', designation: 'DB-1', board_type: 'main' },
            { id: 'b2', designation: 'DB-1', board_type: 'sub' },
          ],
          currentBoardId: boardId,
        });
        const calls =
          order === 'direct-first'
            ? [
                clearBoardCall('manufacturer', 'toolu_d'),
                clearReadingCall('manufacturer', 1, 'toolu_b'),
              ]
            : [
                clearReadingCall('manufacturer', 1, 'toolu_b'),
                clearBoardCall('manufacturer', 'toolu_d'),
              ];
        loopDispatching(calls);
        const opts = baseOpts();
        const result = await runShadowHarness(session, 'Delete the manufacturer.', [], opts);
        const speakers = audibleConfs(result);
        expect(speakers).toHaveLength(1);
        outputs.push(speakers[0].text);
        // The covered render must carry the injective board ordinal (the F2
        // transition adopts the bridge metadata in BOTH orders).
        const ordinal = boardId === 'main' ? 1 : 2;
        expect(speakers[0].text).toContain(`on board ${ordinal}`);
        assertNoGenericApologies(result, opts.logger);
        activeSessions.delete(SESSION_ID);
      }
      expect(outputs[0]).toBe(outputs[1]);
      perBoard[boardId] = outputs[0];
    }
    // Two boards sharing one designation never render identical bytes.
    expect(perBoard.main).not.toBe(perBoard.b2);
  });

  test('same label, two circuits, interleaved through attempt 3+: separate counters, every render byte-distinct, terminals carry their own circuit', async () => {
    const session = makeSession({ circuits: { 4: {}, 7: {} } });
    const texts = [];
    const seq = [4, 7, 4, 7, 4, 7];
    for (let i = 0; i < seq.length; i += 1) {
      loopDispatching([clearReadingCall('circuit_ref', seq[i], `toolu_il${i}`)]);
      const result = await runShadowHarness(session, 'Clear the reference.', [], baseOpts());
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      texts.push(speakers[0].text);
    }
    expect(new Set(texts).size).toBe(6);
    // Attempt 3 for each circuit renders that circuit's own terminal.
    expect(texts[4]).toBe(
      B_STAGED_TERMINALS.unsupported_clear('Circuit Reference for circuit 4 on board 1', 3)
    );
    expect(texts[5]).toBe(
      B_STAGED_TERMINALS.unsupported_clear('Circuit Reference for circuit 7 on board 1', 3)
    );
  });

  test('attempt-6 direct terminals for the remaining families: board_clear_disabled, field_not_applicable_on_eicr, board_clear_scope_unclassified — each renders its OWN truthful terminal', async () => {
    const cases = [
      {
        family: 'board_clear_disabled',
        field: 'ze',
        friendly: ZE_FRIENDLY,
        setup: () => {
          registerEntry(true);
          process.env.BOARD_CLEAR_DISABLED = 'true';
        },
        session: () => makeSession(),
      },
      {
        family: 'field_not_applicable_on_eicr',
        field: 'comments',
        friendly: CONFIRMATION_FRIENDLY_NAMES['comments'] ?? deriveFriendlyName('comments'),
        setup: () => registerEntry(true),
        session: () => makeSession({}, { certType: 'EICR' }),
      },
      {
        family: 'board_clear_scope_unclassified',
        field: 'earthing_arrangement',
        friendly:
          CONFIRMATION_FRIENDLY_NAMES['earthing_arrangement'] ??
          deriveFriendlyName('earthing_arrangement'),
        setup: () => registerEntry(true),
        session: () => makeSession(),
      },
    ];
    for (const c of cases) {
      c.setup();
      const session = c.session();
      const texts = [];
      for (let i = 0; i < 6; i += 1) {
        loopDispatching([clearBoardCall(c.field, `toolu_${c.family}_${i}`)]);
        const result = await runShadowHarness(session, `Delete ${c.field}.`, [], baseOpts());
        const speakers = audibleConfs(result);
        expect(speakers).toHaveLength(1);
        texts.push(speakers[0].text);
      }
      expect(new Set(texts).size).toBe(6);
      const variants = BOARD_CLEAR_NOTICE_FAMILIES[c.family].map((f) => f(c.friendly));
      for (let i = 0; i < 5; i += 1) expect(variants).toContain(texts[i]);
      expect(texts[5]).toBe(DIRECT_DENIAL_TERMINALS[c.family](c.friendly, 6));
      expect(texts[5]).not.toMatch(/nothing recorded/i);
      delete process.env.BOARD_CLEAR_DISABLED;
      activeSessions.delete(SESSION_ID);
    }
  });

  test('cross-turn direct↔bridge on Ze at attempts 1–2 never collide (route-distinct pools inside one 30 s window)', async () => {
    const session = makeSession();
    loopDispatching([clearBoardCall('ze', 'toolu_ct1')]);
    const r1 = await runShadowHarness(session, 'Delete Ze.', [], baseOpts());
    loopDispatching([clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_ct2')]);
    const r2 = await runShadowHarness(session, 'Delete Ze.', [], baseOpts());
    const t1 = audibleConfs(r1)[0].text;
    const t2 = audibleConfs(r2)[0].text;
    expect(t1).not.toBe(t2);
    expect(
      BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) => f(ZE_FRIENDLY))
    ).toContain(t1);
    expect(bridgePoolTexts('board_clear_capability_missing', ZE_FRIENDLY)).toContain(t2);
  });

  test('unknown_tool and offschema_clear driven to attempt 3 render DISTINCT terminals with their own ordinals', async () => {
    const session = makeSession();
    const finals = {};
    for (const kind of ['unknown', 'offschema']) {
      for (let i = 0; i < 3; i += 1) {
        const call =
          kind === 'unknown'
            ? [{ name: 'frobnicate_reading', input: {}, id: `toolu_${kind}${i}` }]
            : [clearReadingCall('banana_volts', 3, `toolu_${kind}${i}`)];
        loopDispatching(call);
        const result = await runShadowHarness(session, 'Do the thing.', [], baseOpts());
        finals[kind] = audibleConfs(result)[0].text;
      }
    }
    expect(finals.unknown).toBe(B_STAGED_TERMINALS.unknown_tool(null, 3));
    expect(finals.offschema).toBe(B_STAGED_TERMINALS.offschema_clear(null, 3));
    expect(finals.unknown).not.toBe(finals.offschema);
  });

  test('object-form route with PARTIAL coverage: one generic line, zero refusal lines', async () => {
    const session = makeSession();
    loopDispatching([
      { name: 'ask_user', input: { question: 'hm?' }, id: 'toolu_opc1' },
      clearReadingCall('measured_zs_ohm', 99, 'toolu_opc2'),
    ]);
    const opts = baseOpts({ pendingAsks: null });
    const result = await runShadowHarness(session, 'Some turn.', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(REJECTED_SET.has(speakers[0].text)).toBe(true);
    expect(mandatoryRows(opts.logger)).toHaveLength(0);
  });

  test('CAPABLE correction via ALREADY-EMPTY, both orders: wrong_tool_clear reconciled away; the already-blank notice speaks alone', async () => {
    for (const order of ['reject-first', 'success-first']) {
      registerEntry(true);
      const session = makeSession(); // ze never set → already_empty
      const calls =
        order === 'reject-first'
          ? [
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_ae_r'),
              clearBoardCall('ze', 'toolu_ae_s'),
            ]
          : [
              clearBoardCall('ze', 'toolu_ae_s'),
              clearReadingCall('earth_loop_impedance_ze', 0, 'toolu_ae_r'),
            ];
      loopDispatching(calls);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      expect(
        BOARD_CLEAR_NOTICE_FAMILIES.board_clear_already_empty.map((f) => f(ZE_FRIENDLY))
      ).toContain(speakers[0].text);
      const wtcTexts = bridgePoolTexts('wrong_tool_clear', ZE_FRIENDLY);
      expect(wtcTexts.includes(speakers[0].text)).toBe(false);
      assertNoGenericApologies(result, opts.logger);
      activeSessions.delete(SESSION_ID);
    }
  });

  test.each([
    ['inResponseTo:true', { inResponseTo: true }],
    [
      'pendingAsks.size>0',
      { pendingAsks: { __tag: 'pending-asks-registry', size: 2, entries: () => [] } },
    ],
  ])(
    'ANSWER-turn partial coverage (%s): covered notices stamp drain:false immediately — one marker-② catch-all line, zero refusal lines (mini-review gate parity)',
    async (_label, optOverrides) => {
      const session = makeSession({ circuits: { 4: {} } });
      loopDispatching([
        clearReadingCall('circuit_ref', 4, 'toolu_at1'),
        clearReadingCall('measured_zs_ohm', 99, 'toolu_at2'),
      ]);
      const opts = baseOpts(optOverrides);
      const result = await runShadowHarness(session, 'Clear those.', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      expect(CATCHALL_SET.has(speakers[0].text)).toBe(true);
      const refusalPool = bridgePoolTexts('unsupported_clear', CIRCUIT_REF_LABEL_C4);
      for (const c of speakers) expect(refusalPool.includes(c.text)).toBe(false);
      expect(mandatoryRows(opts.logger)).toHaveLength(0);
    }
  );

  test('fake-clock: the 30 s expiry anchors at DRAIN time, not stage time (a late-draining attempt keeps the next attempt in-window)', () => {
    const session = {};
    const ptw = { mandatoryNotices: [] };
    const t0 = 1_000_000;
    const meta = {
      family: 'unsupported_clear',
      slotKey: 'slotX',
      turnId: 't1',
      friendly: 'sample label',
      field: 'circuit_ref',
      boardId: null,
      reason: 'unsupported_clear',
      coveredToolCallIds: ['id1'],
      route: 'unsupported_clear',
      repeatKey: 'unsupported_clear::slotX',
    };
    refusalModule.stageMandatoryNotice(ptw, session, meta, t0);
    // Drains 20 s later (e.g. behind a blocking ask) — lastAt refreshes.
    const text1 = refusalModule.renderMandatoryNoticeText(
      session,
      ptw.mandatoryNotices[0],
      't1',
      t0 + 20_000
    );
    expect(B_STAGED_POOLS.unsupported_clear.map((f) => f('sample label'))).toContain(text1);
    // A repeat 45 s after STAGING is only 25 s after the drain — still
    // in-window: count advances to 2 (no reset to a byte-identical attempt 1).
    const ptw2 = { mandatoryNotices: [] };
    refusalModule.stageMandatoryNotice(
      ptw2,
      session,
      { ...meta, coveredToolCallIds: ['id2'] },
      t0 + 45_000
    );
    expect(session.refusedOps['unsupported_clear::slotX'].count).toBe(2);
    // But a repeat >30 s after the DRAIN resets to attempt 1.
    const ptw3 = { mandatoryNotices: [] };
    refusalModule.stageMandatoryNotice(
      ptw3,
      session,
      { ...meta, coveredToolCallIds: ['id3'] },
      t0 + 45_000 + 31_000
    );
    expect(session.refusedOps['unsupported_clear::slotX'].count).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§5.11 — centralised distinctness inventory + wording contract', () => {
  const inventory = renderedNoticeInventory();

  test('every rendered string across ALL families/routes/terminals is mutually full-string distinct (the client dedupe is family-blind)', () => {
    const texts = inventory.map((e) => e.text);
    const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  test('no rendered string is retry-inviting or collides with the generic apology families', () => {
    for (const { text } of inventory) {
      expect(text).not.toMatch(/say (that|it|the .* )?again/i);
      expect(text).not.toMatch(/didn't catch/i);
      expect(text).not.toMatch(/could you (repeat|give)/i);
      expect(CATCHALL_SET.has(text)).toBe(false);
      expect(REJECTED_SET.has(text)).toBe(false);
      expect(ORPHAN_SET.has(text)).toBe(false);
      expect(text).not.toBe(ASK_AUDIBILITY_FALLBACK_TEXT);
    }
  });

  test('equal ordinals across routes never collide (terminal cross-template distinctness at n=7)', () => {
    const terminals = inventory.filter((e) => e.kind === 'terminal').map((e) => e.text);
    expect(new Set(terminals).size).toBe(terminals.length);
  });

  test('every B-staged family/route has ≥3 byte-distinct variants; bridge pools are byte-distinct from the A1a direct pools', () => {
    for (const [route, pool] of Object.entries(B_STAGED_POOLS)) {
      expect(pool.length).toBeGreaterThanOrEqual(3);
      const rendered = pool.map((f) => f('sample label'));
      expect(new Set(rendered).size).toBe(rendered.length);
      if (BOARD_CLEAR_NOTICE_FAMILIES[route]) {
        const direct = new Set(BOARD_CLEAR_NOTICE_FAMILIES[route].map((f) => f('sample label')));
        for (const t of rendered) expect(direct.has(t)).toBe(false);
      }
    }
    // unknown_tool vs offschema_clear first attempts are byte-distinct
    // (round-15: shared idx-0 would collide inside the dedupe window).
    expect(B_STAGED_POOLS.unknown_tool[0]()).not.toBe(B_STAGED_POOLS.offschema_clear[0]());
  });
});
