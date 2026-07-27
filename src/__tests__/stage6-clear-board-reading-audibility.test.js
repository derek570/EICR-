/**
 * Plan A1a (2026-07-27) — runLiveMode/harness-seam audibility tests: §5 rows
 * 7 / 7b / 7c / 7d / 8 / 9 / 9c / 10 / 10c / 18 / 19 (seam legs) / 14.
 *
 * Every wording/telemetry assertion runs at the harness seam and asserts the
 * FINAL EMITTED confirmation text (§3.5a rule 4) — a dispatcher-only
 * accumulator assertion cannot see the A3 net stealing the turn, nor the
 * whole-turn noSpeechIntent gate dropping a notice. Mixed-turn twins are the
 * rows that discriminate the mandatory channel from the voiceNotices
 * fallback (§3.5a rule 5): a single-operation test passes against the broken
 * design.
 *
 * Mock pattern mirrors stage6-catchall-audibility-net.test.js, EXCEPT the
 * mocked runToolLoop invokes the REAL composed dispatcher (opts.dispatcher)
 * so the real capability threading, validation order, notice staging and
 * envelope shapes are exercised end-to-end through the real drain.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-cbr-audibility';

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

const { runShadowHarness, CATCHALL_AUDIBILITY_PROMPTS, REJECTED_PROMPTS } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { BOARD_CLEAR_NOTICE_FAMILIES } = await import('../extraction/stage6-dispatchers-board.js');
const { CONFIRMATION_FRIENDLY_NAMES, deriveFriendlyName } =
  await import('../extraction/confirmation-text.js');

const CATCHALL_SET = new Set(CATCHALL_AUDIBILITY_PROMPTS);
const REJECTED_SET = new Set(REJECTED_PROMPTS);

function familyTexts(family, field) {
  const friendly = CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
  return BOARD_CLEAR_NOTICE_FAMILIES[family].map((f) => f(friendly));
}

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
      // Test 14 — the REAL wire shape through the REAL parser (the same
      // source runLiveMode reads); never a hand-built {hasBoardClearV1}.
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
function loopDispatching(calls, { between } = {}) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (let i = 0; i < calls.length; i += 1) {
      if (typeof between === 'function') between(i, opts);
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

const clearCall = (field, id) => ({
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

function audibleConfs(result) {
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

function fieldNullConfs(result) {
  return audibleConfs(result).filter((c) => c.field == null);
}

function assertNoApologies(result, logger) {
  for (const c of audibleConfs(result)) {
    expect(CATCHALL_SET.has(c.text)).toBe(false);
    expect(REJECTED_SET.has(c.text)).toBe(false);
  }
  const catchallRows = logger.info.mock.calls.filter(
    ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
  );
  expect(catchallRows).toHaveLength(0);
}

function mandatoryRows(logger) {
  return logger.info.mock.calls.filter(([ev]) => ev === 'stage6.mandatory_notice_emitted');
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  registerEntry(true);
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
  delete process.env.BOARD_CLEAR_DISABLED;
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 7 — already-empty clear SPEAKS the already-blank family (final emitted text)', () => {
  test('single-operation turn: exactly one audible entry from the family; mandatory telemetry; zero apologies; soft-skip envelope', async () => {
    const session = makeSession();
    loopDispatching([clearCall('ze', 'toolu_c1')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(familyTexts('board_clear_already_empty', 'ze')).toContain(speakers[0].text);
    expect(speakers[0].field).toBeNull();
    expect(mandatoryRows(opts.logger)).toHaveLength(1);
    expect(mandatoryRows(opts.logger)[0][1]).toMatchObject({
      family: 'board_clear_already_empty',
      sessionId: SESSION_ID,
    });
    assertNoApologies(result, opts.logger);
    // Leg (v) — the envelope was a soft skip, not a rejection.
    const env = runToolLoopSpy.mock.results[0].value;
    const loopOut = await env;
    expect(loopOut.tool_calls[0].result.is_error).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 7b — EICR comments refusal at the seam (UPPERCASE certType)', () => {
  test('refusal family speaks; comments unchanged; zero frames; three repeats produce three DISTINCT strings', async () => {
    const session = makeSession(
      { circuits: { 0: { comments: 'seeded note' } } },
      { certType: 'EICR' }
    );
    const texts = [];
    for (let i = 0; i < 3; i += 1) {
      loopDispatching([clearCall('comments', `toolu_r${i}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'clear the comments', [], opts);
      const speakers = audibleConfs(result);
      expect(speakers).toHaveLength(1);
      expect(familyTexts('field_not_applicable_on_eicr', 'comments')).toContain(speakers[0].text);
      texts.push(speakers[0].text);
      expect(result.field_corrections ?? []).toHaveLength(0);
      assertNoApologies(result, opts.logger);
    }
    expect(new Set(texts).size).toBe(3);
    expect(session.stateSnapshot.circuits[0].comments).toBe('seeded note');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('mixed-turn twins (round-11 BLOCKER — the class the voiceNotices design drops)', () => {
  test('7c — already-empty clear + successful record_reading: BOTH speak (count 2), write lands, target stays blank, no apologies', async () => {
    const session = makeSession({
      circuits: { 4: { circuit_designation: 'Sockets' } },
    });
    loopDispatching([clearCall('ze', 'toolu_c'), readingCall('toolu_r')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze. Zs on 4 is 0.86.', [], opts);

    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    // The unrelated write's read-back…
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('0.86');
    // …AND the already-blank notice, exactly once.
    const notice = speakers.filter((c) =>
      familyTexts('board_clear_already_empty', 'ze').includes(c.text)
    );
    expect(notice).toHaveLength(1);
    expect(session.stateSnapshot.circuits[0] ?? {}).not.toHaveProperty('ze');
    assertNoApologies(result, opts.logger);
  });

  test('7d — EICR comments refusal + successful record_reading: both speak; comments still seeded', async () => {
    const session = makeSession(
      { circuits: { 0: { comments: 'keep me' }, 4: { circuit_designation: 'Sockets' } } },
      { certType: 'EICR' }
    );
    loopDispatching([clearCall('comments', 'toolu_c'), readingCall('toolu_r')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'mixed turn', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    expect(
      speakers.filter((c) =>
        familyTexts('field_not_applicable_on_eicr', 'comments').includes(c.text)
      )
    ).toHaveLength(1);
    expect(session.stateSnapshot.circuits[0].comments).toBe('keep me');
    assertNoApologies(result, opts.logger);
  });

  test('9c — capability-missing denial + successful record_reading: both speak; target populated; zero board frames; reading in the envelope', async () => {
    registerEntry(false);
    const session = makeSession({
      circuits: { 0: { ze: '0.4' }, 4: { circuit_designation: 'Sockets' } },
    });
    loopDispatching([clearCall('ze', 'toolu_c'), readingCall('toolu_r')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'mixed denial turn', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(
      speakers.filter((c) => familyTexts('board_clear_capability_missing', 'ze').includes(c.text))
    ).toHaveLength(1);
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(result.field_corrections ?? []).toHaveLength(0);
    // The unrelated write rides the envelope's readings ENTRY (no standalone
    // frame) with its mutation landed and read-back present.
    expect(result.extracted_readings.some((r) => r.field === 'measured_zs_ohm')).toBe(true);
    expect(session.stateSnapshot.circuits[4].measured_zs_ohm).toBe('0.86');
    assertNoApologies(result, opts.logger);
  });

  test('10c — kill-switch denial + successful record_reading: both speak with the kill-switch family', async () => {
    process.env.BOARD_CLEAR_DISABLED = 'true';
    const session = makeSession({
      circuits: { 0: { ze: '0.4' }, 4: { circuit_designation: 'Sockets' } },
    });
    loopDispatching([clearCall('ze', 'toolu_c'), readingCall('toolu_r')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'mixed kill turn', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(
      speakers.filter((c) => familyTexts('board_clear_disabled', 'ze').includes(c.text))
    ).toHaveLength(1);
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    assertNoApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 8 — three already-empty clears in one session: distinct family strings, mandatory telemetry, zero apologies', () => {
  test('three consecutive turns, all family members, mutually distinct; NOT dispatcher_voice_notice_emitted', async () => {
    const session = makeSession();
    const texts = [];
    for (let i = 0; i < 3; i += 1) {
      loopDispatching([clearCall('ze', `toolu_e${i}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, `Delete Ze attempt ${i}`, [], opts);
      const speakers = fieldNullConfs(result);
      expect(speakers).toHaveLength(1);
      expect(familyTexts('board_clear_already_empty', 'ze')).toContain(speakers[0].text);
      texts.push(speakers[0].text);
      expect(mandatoryRows(opts.logger)).toHaveLength(1);
      // The two channels stay separable in CloudWatch.
      const voiceNoticeRows = opts.logger.info.mock.calls.filter(
        ([ev]) => ev === 'stage6.dispatcher_voice_notice_emitted'
      );
      expect(voiceNoticeRows).toHaveLength(0);
      assertNoApologies(result, opts.logger);
    }
    expect(new Set(texts).size).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('tests 9/10 — denial at the seam (five legs + leg vi three-turn rotation + leg vii unclassified slot fallback)', () => {
  test('9 — capability missing: exact code, field populated, zero frames, family speaks, soft-skip envelope, never REJECTED_PROMPTS', async () => {
    registerEntry(false);
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    loopDispatching([clearCall('ze', 'toolu_d')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
    // (i) exact reason code on the envelope, not unknown_tool.
    const loopOut = await runToolLoopSpy.mock.results[0].value;
    const envBody = JSON.parse(loopOut.tool_calls[0].result.content);
    expect(envBody).toEqual({ ok: true, skipped: true, reason: 'board_clear_capability_missing' });
    expect(loopOut.tool_calls[0].result.is_error).toBe(false); // (v)
    // (ii) still populated; (iii) zero frames.
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(result.field_corrections ?? []).toHaveLength(0);
    // (iv) final emitted text is exactly one capability-family member +
    // mandatory telemetry + zero catch-all.
    const speakers = fieldNullConfs(result);
    expect(speakers).toHaveLength(1);
    expect(familyTexts('board_clear_capability_missing', 'ze')).toContain(speakers[0].text);
    expect(mandatoryRows(opts.logger)).toHaveLength(1);
    assertNoApologies(result, opts.logger);
  });

  test('9 leg (vi) — three consecutive denial turns: three DISTINCT family strings, zero mutation/frames throughout', async () => {
    registerEntry(false);
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const texts = [];
    for (let i = 0; i < 3; i += 1) {
      loopDispatching([clearCall('ze', `toolu_v${i}`)]);
      const opts = baseOpts();
      const result = await runShadowHarness(session, `Delete Ze ${i}`, [], opts);
      const speakers = fieldNullConfs(result);
      expect(speakers).toHaveLength(1);
      expect(familyTexts('board_clear_capability_missing', 'ze')).toContain(speakers[0].text);
      texts.push(speakers[0].text);
      expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
      expect(result.field_corrections ?? []).toHaveLength(0);
      assertNoApologies(result, opts.logger);
    }
    expect(new Set(texts).size).toBe(3);
  });

  test('9 leg (vii) — denials for a MAPPED and an UNCLASSIFIED field both speak; two unclassified denials on DIFFERENT boards both speak (extra-audibility)', async () => {
    registerEntry(false);
    const session = makeSession({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
    });
    // One turn: mapped-field denial + unclassified-field denial on main +
    // the same unclassified field denied again with a DIFFERENT current
    // board — the (canonical field + resolved board) fallback slot keeps
    // the third audible instead of deduping it onto the second.
    loopDispatching(
      [
        clearCall('ze', 'toolu_m'),
        clearCall('earthing_arrangement', 'toolu_u1'),
        clearCall('earthing_arrangement', 'toolu_u2'),
      ],
      {
        between: (i) => {
          if (i === 2) session.stateSnapshot.currentBoardId = 'garage';
        },
      }
    );
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'multi denial', [], opts);
    const speakers = fieldNullConfs(result);
    expect(speakers).toHaveLength(3);
    expect(
      speakers.filter((c) => familyTexts('board_clear_capability_missing', 'ze').includes(c.text))
    ).toHaveLength(1);
    expect(
      speakers.filter((c) =>
        familyTexts('board_clear_capability_missing', 'earthing_arrangement').includes(c.text)
      )
    ).toHaveLength(2);
    assertNoApologies(result, opts.logger);
  });

  test('10 — kill-switch denies a CAPABLE client: distinct code, distinct family, mutation-and-emission stop', async () => {
    process.env.BOARD_CLEAR_DISABLED = 'true';
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    loopDispatching([clearCall('ze', 'toolu_k')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze.', [], opts);
    const loopOut = await runToolLoopSpy.mock.results[0].value;
    expect(JSON.parse(loopOut.tool_calls[0].result.content).reason).toBe('board_clear_disabled');
    expect(loopOut.tool_calls[0].result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(result.field_corrections ?? []).toHaveLength(0);
    const speakers = fieldNullConfs(result);
    expect(speakers).toHaveLength(1);
    expect(familyTexts('board_clear_disabled', 'ze')).toContain(speakers[0].text);
    expect(familyTexts('board_clear_capability_missing', 'ze')).not.toContain(speakers[0].text);
    assertNoApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 18 — same-slot suppression keyed by (family + canonical scope-aware slot)', () => {
  test('already-empty ze notice + later SUCCESSFUL same-slot write in the SAME turn: stale notice ABSENT, write speaks once', async () => {
    const session = makeSession();
    loopDispatching([
      clearCall('ze', 'toolu_c'),
      {
        name: 'record_board_reading',
        input: { field: 'ze', value: '0.35', confidence: 0.9, source_turn_id: 't1' },
        id: 'toolu_w',
      },
    ]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'Delete Ze. Ze is 0.35.', [], opts);
    const speakers = audibleConfs(result);
    // Only the write's read-back — the already-empty notice is suppressed by
    // the surviving same-slot write.
    expect(speakers).toHaveLength(1);
    expect(speakers[0].field).toBe('ze');
    expect(
      speakers.filter((c) => familyTexts('board_clear_already_empty', 'ze').includes(c.text))
    ).toHaveLength(0);
    assertNoApologies(result, opts.logger);
  });

  test('CROSS-BOARD ze (global): notice staged on board A is STILL suppressed by a same-logical-slot write under board B', async () => {
    const session = makeSession({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
    });
    loopDispatching(
      [
        clearCall('ze', 'toolu_c'),
        {
          name: 'record_board_reading',
          input: { field: 'ze', value: '0.42', confidence: 0.9, source_turn_id: 't1' },
          id: 'toolu_w',
        },
      ],
      {
        between: (i) => {
          if (i === 1) session.stateSnapshot.currentBoardId = 'garage';
        },
      }
    );
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'cross-board ze', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].field).toBe('ze');
    assertNoApologies(result, opts.logger);
  });

  test('CROSS-BOARD manufacturer (board-scoped): notice on board A is PRESERVED alongside a write on board B', async () => {
    const session = makeSession({
      boards: [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
    });
    loopDispatching(
      [
        clearCall('manufacturer', 'toolu_c'), // already-empty on main
        {
          name: 'record_board_reading',
          input: { field: 'manufacturer', value: 'Wylex', confidence: 0.9, source_turn_id: 't1' },
          id: 'toolu_w',
        },
      ],
      {
        between: (i) => {
          if (i === 1) session.stateSnapshot.currentBoardId = 'garage';
        },
      }
    );
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'cross-board manufacturer', [], opts);
    const speakers = audibleConfs(result);
    // The write's read-back AND the preserved notice (different board slots).
    expect(speakers).toHaveLength(2);
    expect(speakers.some((c) => c.field === 'manufacturer')).toBe(true);
    expect(
      speakers.filter((c) =>
        familyTexts('board_clear_already_empty', 'manufacturer').includes(c.text)
      )
    ).toHaveLength(1);
    assertNoApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 19 (seam legs) — unknown-scope fail-closed speaks the A1a family', () => {
  test('single-operation leg: family speaks, mandatory telemetry, zero catch-all/REJECTED, no mutation, no frame', async () => {
    const session = makeSession({ circuits: { 0: { earthing_arrangement: 'TN-C-S' } } });
    loopDispatching([clearCall('earthing_arrangement', 'toolu_s')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'clear the earthing arrangement', [], opts);
    const speakers = fieldNullConfs(result);
    expect(speakers).toHaveLength(1);
    expect(familyTexts('board_clear_scope_unclassified', 'earthing_arrangement')).toContain(
      speakers[0].text
    );
    expect(mandatoryRows(opts.logger)).toHaveLength(1);
    expect(session.stateSnapshot.circuits[0].earthing_arrangement).toBe('TN-C-S');
    expect(result.field_corrections ?? []).toHaveLength(0);
    assertNoApologies(result, opts.logger);
  });

  test('mixed-turn leg: unknown-scope notice + unrelated read-back both speak', async () => {
    const session = makeSession({
      circuits: { 0: { earthing_arrangement: 'TN-C-S' }, 4: { circuit_designation: 'Sockets' } },
    });
    loopDispatching([clearCall('earthing_arrangement', 'toolu_s'), readingCall('toolu_r')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'mixed unknown-scope', [], opts);
    const speakers = audibleConfs(result);
    expect(speakers).toHaveLength(2);
    expect(
      speakers.filter((c) =>
        familyTexts('board_clear_scope_unclassified', 'earthing_arrangement').includes(c.text)
      )
    ).toHaveLength(1);
    expect(speakers.some((c) => c.field === 'measured_zs_ohm')).toBe(true);
    assertNoApologies(result, opts.logger);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 14 — capability parser → dispatcher context through the REAL wiring', () => {
  test('leg (i): a session_start-shaped advert reaches the LIVE dispatcher — a capable session MUTATES', async () => {
    registerEntry(true); // real parser, real wire shape
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    loopDispatching([clearCall('ze', 'toolu_cap')]);
    const opts = baseOpts();
    await runShadowHarness(session, 'Delete Ze.', [], opts);
    // Deny-first default means mutation is only possible when the parsed
    // capability actually LANDED on the dispatcher context.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
  });

  test('leg (ii): advertising nothing, and a malformed capabilities block, each DENY', async () => {
    for (const capabilities of [
      { voice_latency: { version: 1, supports: [] } },
      { voice_latency: { version: 1, supports: 'board_clear_v1' } }, // malformed
      null,
    ]) {
      activeSessions.set(SESSION_ID, {
        session: { sessionId: SESSION_ID },
        pendingFastTtsSlots: new Map(),
        fastPathCorrelationIdByTurn: new Map(),
        broadcastIntentByTurn: new Map(),
        voiceLatency: {
          flags: { loadedBarrel: false },
          capabilities: parseVoiceLatencyCapabilities(capabilities),
        },
      });
      const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
      loopDispatching([clearCall('ze', 'toolu_no')]);
      const opts = baseOpts();
      await runShadowHarness(session, 'Delete Ze.', [], opts);
      expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    }
  });

  test('leg (iii): the SHADOW lane resolves the SAME capability; a shadow clear mutates the CLONE and leaves live state untouched', async () => {
    registerEntry(true);
    let shadowEnvBody = null;
    const session = makeSession(
      { circuits: { 0: { ze: '0.4' } } },
      {
        toolCallsMode: 'shadow',
        client: {},
        extractFromUtterance: jest.fn(async function legacy() {
          this.turnCount = (this.turnCount ?? 0) + 1;
          return { extracted_readings: [], observations: [], questions: [] };
        }),
      }
    );
    runToolLoopSpy.mockImplementation(async (opts) => {
      const env = await opts.dispatcher(
        {
          tool_call_id: 'toolu_sh',
          name: 'clear_board_reading',
          input: { field: 'ze', reason: 'user_correction' },
        },
        opts.ctx
      );
      shadowEnvBody = JSON.parse(env.content);
      return {
        stop_reason: 'end_turn',
        rounds: 1,
        tool_calls: [
          { tool_call_id: 'toolu_sh', name: 'clear_board_reading', input: {}, result: env },
        ],
        aborted: false,
        messages_final: [],
        usage: {},
        terminal_reason: 'end_turn',
      };
    });
    const opts = baseOpts();
    await runShadowHarness(session, 'Delete Ze.', [], opts);
    // Same parsed capability as live → the shadow dispatcher CLEARED (not
    // denied) — the round-4 "shadow must deny by construction" inversion
    // would have returned board_clear_capability_missing here.
    expect(shadowEnvBody).toEqual({ ok: true });
    // …and the mutation landed on the CLONE only: live state byte-unchanged.
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
  });
});
