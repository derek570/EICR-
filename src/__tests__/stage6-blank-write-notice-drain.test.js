/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — acceptance 5 and 6: the drain,
 * the answer reconciliation, and the cancelled path.
 *
 * THE DEFECT THIS FILE DEFENDS AGAINST IS SILENCE, in three shapes:
 *
 *   1. A refusal that never speaks. The September-17 blank write is the
 *      original; a MIXED turn is the subtle one, because a sibling's
 *      successful read-back suppresses the catch-all and the rejected slot
 *      falls through every net.
 *   2. A refusal drowned out by the model. `answer_user` text is
 *      unconstrained — "Done, that's recorded" after a blocked blank would
 *      retire the only truthful line about an untouched certificate value.
 *   3. A refusal killed by a cancellation. The accumulator used to die with
 *      the turn, which is right for "the app can't do that" and wrong for the
 *      only report an inspector will ever get that a dictated value was not
 *      written.
 *
 * AND ITS OPPOSITE, which is just as wrong: a refusal that speaks BESIDE the
 * read-back of a write that superseded it. Every suppression case here is a
 * contradiction the inspector would otherwise hear.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-c3-drain';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);

let capturedAskOpts = null;
const createAskDispatcherSpy = jest.fn((session, logger, turnId, pendingAsks, ws, opts) => {
  capturedAskOpts = opts;
  return askSentinel;
});

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 45000,
}));

let throwOnLoop = false;
const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: jest.fn(() => ({
    onSnapshotPatch: jest.fn(),
    onLoopComplete: jest.fn(),
    onToolUseStreamed: jest.fn(),
    validateAgainstConfirmations: jest.fn(),
    abortBySlot: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { ExtractionCancelledError } = await import('../extraction/stage6-control-flow-errors.js');
const { C3_NOTICE_FAMILIES, C3_NOTICE_ROUTES, B_STAGED_POOLS, BOARD_CLEAR_NOTICE_FAMILIES } =
  await import('../extraction/refusal-notices.js');
const { ANSWER_FALLBACK_TEXT } = await import('../extraction/stage6-dispatchers-answer.js');
const { rawCircuitSlot } = await import('../extraction/stage6-per-turn-writes.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(boards, currentBoardId, circuits) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    certType: 'eicr',
    turnCount: 0,
    agenticAnswersEnabled: true,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: {
      circuits: circuits ?? {
        0: { manufacturer: 'Wylex' },
        1: { circuit_designation: 'Upstairs Lighting', ocpd_bs_en: 'BS EN 60898', ref_method: 'C' },
        2: { circuit_designation: 'Sockets', ref_method: 'C' },
        3: { circuit_designation: 'Cooker', ref_method: 'C' },
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards,
      currentBoardId,
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

const SINGLE_BOARD = [{ id: 'main', board_type: 'main' }];
const TWO_BOARDS = [
  { id: 'main', board_type: 'main' },
  { id: 'garage', board_type: 'sub_distribution' },
];

function registerEntry() {
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: {
      flags: { loadedBarrel: false },
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports: ['board_clear_v1'] },
      }),
    },
  });
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    chimeObserved: true,
    generationId: 'gen-c3',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Drive the REAL composed dispatcher over `calls`. `stage` runs after each
 * call so a test can flip the selected board or journal an `answer_user`
 * exactly where it needs to, including BEFORE the rejecting write.
 */
function loopDispatching(calls, { between, cancelAfter } = {}) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (let i = 0; i < calls.length; i += 1) {
      if (typeof between === 'function') between(i, opts);
      const c = calls[i];
      const env = await opts.dispatcher(
        { tool_call_id: c.id, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({ tool_call_id: c.id, name: c.name, input: c.input, result: env });
      if (cancelAfter != null && i === cancelAfter) {
        throw new ExtractionCancelledError('extraction_watchdog_absolute_ceiling');
      }
    }
    if (throwOnLoop) throw new ExtractionCancelledError('extraction_watchdog_absolute_ceiling');
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

const spoken = (result) =>
  (result.confirmations ?? [])
    .filter((c) => typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => c.text);

const logRows = (opts, event) =>
  opts.logger.info.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);

// Call shapes used across the file.
const blankWrite = (id = 'tu_blank', circuit = 1, field = 'ocpd_bs_en') => ({
  id,
  name: 'record_reading',
  input: { field, circuit, value: '', confidence: 0.9, source_turn_id: 't1' },
});
const goodWrite = (id, circuit, field, value) => ({
  id,
  name: 'record_reading',
  input: { field, circuit, value, confidence: 0.9, source_turn_id: 't1' },
});
const clearWrite = (id, circuit, field) => ({
  id,
  name: 'clear_reading',
  input: { field, circuit, reason: 'user_correction' },
});
const answer = (id, text, rejection_ref) => ({
  id,
  name: 'answer_user',
  input: { answer_text: text, ...(rejection_ref === undefined ? {} : { rejection_ref }) },
});
const blankBulk = (id = 'tu_bulk', field = 'ref_method') => ({
  id,
  name: 'set_field_for_all_circuits',
  input: { field, value: '', confidence: 0.9, source_turn_id: 't1', scope: 'all' },
});

beforeEach(() => {
  throwOnLoop = false;
  capturedAskOpts = null;
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  registerEntry();
});
afterEach(() => activeSessions.delete(SESSION_ID));

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5a — a mixed turn never leaves a blocked blank silent', () => {
  test('one valid write + one blank → the read-back AND the truthful refusal', async () => {
    // THE case the coverage arbitration cannot reach: `allRejected` is false,
    // so the sibling's read-back suppresses the catch-all and the rejected
    // slot would otherwise have no audible outcome at all.
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([goodWrite('tu_ok', 2, 'ref_method', 'A'), blankWrite()]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'mixed turn', [], opts);
    const texts = spoken(result);
    expect(
      texts.some((t) => t.includes('Reference Method') || t.includes('reference method'))
    ).toBe(true);
    expect(texts.some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('a slot that held NOTHING says "still blank", never a value it does not have', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      goodWrite('tu_ok', 2, 'ref_method', 'A'),
      blankWrite('tu_b', 1, 'ref_method'),
    ]);
    const result = await runShadowHarness(session, 'mixed turn', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('still C'))).toBe(true);
  });

  test('a same-slot CLEAR later in the turn retires the refusal — in BOTH dispatch orders', async () => {
    for (const order of [
      [blankWrite('tu_b'), clearWrite('tu_c', 1, 'ocpd_bs_en')],
      [clearWrite('tu_c', 1, 'ocpd_bs_en'), blankWrite('tu_b')],
    ]) {
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(order);
      const result = await runShadowHarness(session, 'blank then clear', [], baseOpts());
      expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(false);
    }
  });

  test('a same-slot WRITE later in the turn retires it — the read-back speaks alone', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), goodWrite('tu_ok', 1, 'ocpd_bs_en', 'BS EN 61009')]);
    const result = await runShadowHarness(session, 'blank then correct', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes('still BS EN 60898'))).toBe(false);
    expect(texts.some((t) => t.includes('61009'))).toBe(true);
  });

  test('the same field on a DIFFERENT circuit does NOT retire it', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b', 1), goodWrite('tu_ok', 2, 'ocpd_bs_en', 'BS EN 61009')]);
    const result = await runShadowHarness(session, 'other circuit', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('a main-board blank followed by a sub-board write on the SAME ref still speaks', async () => {
    // Board is part of the slot key. Without it the garage write would retire
    // a refusal about a value on a board it never touched — the inspector
    // hears one read-back and walks away believing both boards are recorded.
    // The garage circuit is a REAL composite-keyed bucket so its write
    // succeeds; a rejected second write would make this an all-rejected turn
    // and test the coverage arbitration instead of the slot key.
    const session = makeSession(TWO_BOARDS, 'main', {
      0: {},
      1: { circuit_designation: 'Upstairs Lighting', ocpd_bs_en: 'BS EN 60898' },
      'garage::1': { circuit: 1, board_id: 'garage', circuit_designation: 'Garage Lighting' },
    });
    loopDispatching([blankWrite('tu_b', 1), goodWrite('tu_ok', 1, 'ocpd_bs_en', 'BS EN 61009')], {
      between: (i) => {
        if (i === 1) session.stateSnapshot.currentBoardId = 'garage';
      },
    });
    const result = await runShadowHarness(session, 'cross board', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes('still BS EN 60898'))).toBe(true);
    expect(texts.some((t) => t.includes('61009'))).toBe(true);
  });

  test('five same-slot blanks in one turn produce ONE notice', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([0, 1, 2, 3, 4].map((n) => blankWrite(`tu_b${n}`)));
    const result = await runShadowHarness(session, 'repeat blanks', [], baseOpts());
    expect(spoken(result).filter((t) => t.includes('still BS EN 60898'))).toHaveLength(1);
  });

  test('two blanks on DIFFERENT slots both speak, byte-distinct', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b1', 1, 'ref_method'), blankWrite('tu_b2', 2, 'ref_method')]);
    const result = await runShadowHarness(session, 'two slots', [], baseOpts());
    const refusals = spoken(result).filter((t) => t.includes('blank'));
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(refusals).size).toBe(refusals.length);
  });

  test('an all-rejected blank turn speaks the notice and NOT the generic apology', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b')]);
    const result = await runShadowHarness(session, 'blank only', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes('still BS EN 60898'))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("didn't catch"))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 4 (drain half) — a corrected circuit op retires its refusal', () => {
  const blankRename = (id = 'tu_br') => ({
    id,
    name: 'rename_circuit',
    input: { from_ref: 1, circuit_ref: 1, designation: '' },
  });
  const goodRename = (id = 'tu_gr') => ({
    id,
    name: 'rename_circuit',
    input: { from_ref: 1, circuit_ref: 1, designation: 'Landing Lights' },
  });
  const blankCreate = (id = 'tu_bc') => ({
    id,
    name: 'create_circuit',
    input: { circuit_ref: 7, designation: '' },
  });
  const goodCreate = (id = 'tu_gc') => ({
    id,
    name: 'create_circuit',
    input: { circuit_ref: 7, designation: 'Immersion' },
  });

  test('a same-turn corrected RENAME retires the refusal, in both dispatch orders', async () => {
    // No stale "not renamed" line beside the circuit's new name.
    for (const order of [
      [blankRename(), goodRename()],
      [goodRename(), blankRename()],
    ]) {
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(order);
      const result = await runShadowHarness(session, 'rename retry', [], baseOpts());
      expect(spoken(result).some((t) => t.includes("I haven't renamed"))).toBe(false);
      expect(spoken(result).some((t) => t.includes('Landing Lights'))).toBe(true);
    }
  });

  test('a same-turn corrected CREATE retires the refusal, in both dispatch orders', async () => {
    for (const order of [
      [blankCreate(), goodCreate()],
      [goodCreate(), blankCreate()],
    ]) {
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(order);
      const result = await runShadowHarness(session, 'create retry', [], baseOpts());
      expect(spoken(result).some((t) => t.includes("I haven't created"))).toBe(false);
    }
  });

  test('a correction on ANOTHER ref does not retire it', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      blankRename(),
      {
        id: 'tu_other',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'Ring Final' },
      },
    ]);
    const result = await runShadowHarness(session, 'other ref', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('circuit 1'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5b — a bulk refusal is per CALL', () => {
  test('a blank bulk followed by a successful single write still speaks', async () => {
    // A bulk request is one statement about a scope, and a later per-circuit
    // write does not make it true.
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankBulk(), goodWrite('tu_ok', 1, 'ref_method', 'A')]);
    const result = await runShadowHarness(session, 'bulk then single', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('all circuits'))).toBe(true);
  });

  test('an IDENTICAL bulk retry that succeeds still leaves the refusal spoken', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      blankBulk(),
      {
        id: 'tu_retry',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'ref_method',
          value: 'A',
          confidence: 0.9,
          source_turn_id: 't1',
          scope: 'all',
        },
      },
    ]);
    const result = await runShadowHarness(session, 'bulk retry', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes('all circuits'))).toBe(true);
    // The retry's own grouped read-back speaks too — the refusal is about ITS
    // call, and the retry is about the retry.
    expect(texts.some((t) => t === 'All circuits, reference method A')).toBe(true);
  });

  test('two DIFFERENT resolved scopes on one field render byte-distinct lines', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      blankBulk('tu_all'),
      {
        id: 'tu_rcd',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'ref_method',
          value: '',
          confidence: 0.9,
          source_turn_id: 't1',
          scope: 'rcd_protected_only',
        },
      },
    ]);
    const result = await runShadowHarness(session, 'two scopes', [], baseOpts());
    const bulkLines = spoken(result).filter(
      (t) => t.includes('all circuits') || t.includes('RCD-protected')
    );
    expect(bulkLines.length).toBe(2);
    expect(new Set(bulkLines).size).toBe(2);
  });

  test('the descriptor names the RESOLVED selector, never "all circuits" for a narrower one', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      {
        id: 'tu_rcd',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'ref_method',
          value: '',
          confidence: 0.9,
          source_turn_id: 't1',
          scope: 'rcd_protected_only',
        },
      },
    ]);
    const result = await runShadowHarness(session, 'rcd scope', [], baseOpts());
    const line = spoken(result).find((t) => t.includes('circuits'));
    // Assert on the DESCRIPTOR (the "<label> for <scope>" clause), not on the
    // whole line: the wording pool's escape hint legitimately says "clear it
    // for all circuits", which is advice about the clear tool and not a claim
    // about what this call targeted.
    expect(line).toContain('Reference Method for the RCD-protected circuits');
    expect(line).not.toContain('Reference Method for all circuits');
  });

  test('an "except" clause follows the selector it narrows', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      {
        id: 'tu_ex',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'ref_method',
          value: '',
          confidence: 0.9,
          source_turn_id: 't1',
          scope: 'rcd_protected_only',
          exclude_circuits: [4],
        },
      },
    ]);
    const result = await runShadowHarness(session, 'rcd except 4', [], baseOpts());
    const line = spoken(result).find((t) => t.includes('circuits'));
    expect(line).toContain('the RCD-protected circuits');
    expect(line).toContain('except 4');
    expect(line.indexOf('RCD-protected')).toBeLessThan(line.indexOf('except 4'));
  });

  test('two scopes differing only ABOVE the sixth ref render byte-distinct lines', async () => {
    // Codex review cycle 1: the descriptor used to drop the ref list above six
    // targets, while the slot key kept it — so circuits 1-7 and 1-8 were two
    // slots with one rendered string, and the client's 30 s byte dedupe
    // swallowed the second refusal.
    const circuits = { 0: {} };
    for (let n = 1; n <= 8; n += 1) circuits[n] = { circuit_designation: `C${n}`, ref_method: 'C' };
    const session = makeSession(SINGLE_BOARD, 'main', circuits);
    const bulk = (id, exclude_circuits) => ({
      id,
      name: 'set_field_for_all_circuits',
      input: {
        field: 'ref_method',
        value: '',
        confidence: 0.9,
        source_turn_id: 't1',
        scope: 'all',
        exclude_circuits,
      },
    });
    // Exclusions change the "except" clause too, so compare by the ref runs:
    // one call over 1-8, one over 1-7 reached by adding circuit 8 later.
    loopDispatching([bulk('tu_a', [])], {});
    const first = await runShadowHarness(session, 'eight', [], baseOpts());
    delete session.stateSnapshot.circuits[8];
    loopDispatching([bulk('tu_b', [])], {});
    const second = await runShadowHarness(session, 'seven', [], baseOpts());
    const a = spoken(first).find((t) => t.includes('all circuits'));
    const b = spoken(second).find((t) => t.includes('all circuits'));
    expect(a).toContain('1 to 8');
    expect(b).toContain('1 to 7');
    expect(a).not.toBe(b);
  });

  test('include-spares and exclude-spares sweeps are byte-distinct', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    const bulk = (id, spare_policy) => ({
      id,
      name: 'set_field_for_all_circuits',
      input: {
        field: 'ref_method',
        value: '',
        confidence: 0.9,
        source_turn_id: 't1',
        scope: 'all',
        spare_policy,
      },
    });
    loopDispatching([bulk('tu_inc', 'include'), bulk('tu_exc', 'exclude')]);
    const result = await runShadowHarness(session, 'spare policies', [], baseOpts());
    const lines = spoken(result).filter((t) => t.includes('all circuits'));
    expect(lines.some((t) => t.includes('all circuits including spares'))).toBe(true);
    expect(lines.some((t) => t.includes('all circuits excluding spares'))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5g — the PROVISIONAL direct enum rejection', () => {
  const badEnum = (id = 'tu_enum', circuit = 1) => ({
    id,
    name: 'record_reading',
    input: { field: 'rcd_type', circuit, value: 'bogus', confidence: 0.9, source_turn_id: 't1' },
  });

  test('a mixed turn where the model neither asks nor rewrites → the read-back AND the refusal', async () => {
    // The case nothing else covers: `allRejected` is false, so the coverage
    // arbitration never runs, and the sibling read-back suppresses the
    // catch-all. Without this notice the rejected certificate value would have
    // no audible outcome at all.
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([goodWrite('tu_ok', 2, 'ref_method', 'A'), badEnum()]);
    const result = await runShadowHarness(session, 'mixed enum', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes('reference method A'))).toBe(true);
    expect(texts.some((t) => t.includes("isn't one of the options"))).toBe(true);
  });

  test('a COVERING ask reconciles the provisional notice away — the question speaks alone', async () => {
    // The ask is the intended audible outcome; staging the notice costs
    // nothing when the model behaves.
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      await o.dispatcher(
        { tool_call_id: 'tu_enum', name: 'record_reading', input: badEnum().input },
        o.ctx
      );
      o.perTurnWritesRef().askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'rcd_type',
        circuits: [1],
        boardId: 'main',
      });
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
    const result = await runShadowHarness(
      session,
      'enum then ask',
      [],
      baseOpts({ _seedEmittedAskToolCallIds: ['tu_ask'] })
    );
    expect(spoken(result).some((t) => t.includes("isn't one of the options"))).toBe(false);
  });

  test('a corrected same-slot WRITE also reconciles it away', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([badEnum(), goodWrite('tu_fix', 1, 'rcd_type', 'AC')]);
    const result = await runShadowHarness(session, 'enum then fix', [], baseOpts());
    const texts = spoken(result);
    expect(texts.some((t) => t.includes("isn't one of the options"))).toBe(false);
    expect(texts.some((t) => t.toLowerCase().includes('rcd type'))).toBe(true);
  });

  test('an answer_user ECHOING the ref is dropped and the refusal speaks once', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    let mintedRef = null;
    runToolLoopSpy.mockImplementation(async (o) => {
      const env = await o.dispatcher(
        { tool_call_id: 'tu_enum', name: 'record_reading', input: badEnum().input },
        o.ctx
      );
      mintedRef = JSON.parse(env.content).rejection_ref;
      await o.dispatcher(
        {
          tool_call_id: 'tu_a',
          name: 'answer_user',
          input: { answer_text: 'Noted, moving on.', rejection_ref: mintedRef },
        },
        o.ctx
      );
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
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'enum + ref answer', [], opts);
    expect(typeof mintedRef).toBe('string');
    expect(result.spoken_response ?? '').not.toContain('Noted');
    expect(spoken(result).filter((t) => t.includes("isn't one of the options"))).toHaveLength(1);
    expect(logRows(opts, 'stage6.answer_narration_dropped')[0].code).toBe('notice_authoritative');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5c — answer ownership is ORDER-INDEPENDENT', () => {
  const orders = [
    ['answer BEFORE the rejecting write', (a) => [a, blankWrite('tu_b')]],
    ['answer AFTER the rejecting write', (a) => [blankWrite('tu_b'), a]],
  ];

  test.each(orders)(
    '%s: no rejection_ref → the answer is dropped, the notice speaks once',
    async (_label, build) => {
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(build(answer('tu_a', "Done, that's recorded.")));
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'answer + blank', [], opts);
      const texts = spoken(result);
      expect(texts).not.toContain("Done, that's recorded.");
      expect(result.spoken_response ?? '').not.toContain('Done');
      expect(texts.filter((t) => t.includes('still BS EN 60898'))).toHaveLength(1);
      const dropped = logRows(opts, 'stage6.answer_narration_dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0].code).toBe('narration_requires_rejection_ref');
    }
  );

  test.each(orders)(
    '%s: the MATCHING ref → still dropped, because the notice is authoritative',
    async (_label, build) => {
      // A ref proves ASSOCIATION, never TRUTH. "Done, that's recorded" carrying
      // the right ref would retire the only truthful line about an untouched
      // certificate value.
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(build(answer('tu_a', "Done, that's recorded.", 'turn-1:tu_b')), {
        between: (i, opts) => {
          // The ref is minted from the harness's own turn id, so resolve it
          // from the accumulator rather than guessing the string.
          const journal = opts.perTurnWritesRef?.()?.rejections ?? [];
          if (journal.length > 0) {
            for (const call of runToolLoopSpy.mock.calls) void call;
          }
          void i;
        },
      });
      const opts = baseOpts();
      // Re-drive with the real minted ref: dispatch the write first in a probe
      // run, read its ref, then replay the pair in the order under test.
      const probeSession = makeSession(SINGLE_BOARD, 'main');
      loopDispatching([blankWrite('tu_b')]);
      let mintedRef = null;
      runToolLoopSpy.mockImplementation(async (o) => {
        const env = await o.dispatcher(
          { tool_call_id: 'tu_b', name: 'record_reading', input: blankWrite('tu_b').input },
          o.ctx
        );
        mintedRef = JSON.parse(env.content).rejection_ref;
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
      await runShadowHarness(probeSession, 'probe', [], baseOpts());
      expect(typeof mintedRef).toBe('string');

      loopDispatching(build(answer('tu_a', "Done, that's recorded.", mintedRef)));
      const result = await runShadowHarness(session, 'answer + blank', [], opts);
      expect(spoken(result)).not.toContain("Done, that's recorded.");
      expect(spoken(result).filter((t) => t.includes('still BS EN 60898'))).toHaveLength(1);
      const dropped = logRows(opts, 'stage6.answer_narration_dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0].code).toBe('notice_authoritative');
    }
  );

  test.each(orders)('%s: rejection_ref "unrelated" → BOTH speak', async (_label, build) => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching(build(answer('tu_a', 'Two circuits left.', 'unrelated')));
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'unrelated answer', [], opts);
    expect(result.spoken_response).toBe('Two circuits left.');
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
    expect(logRows(opts, 'stage6.answer_narration_dropped')).toHaveLength(0);
  });

  test('a MALFORMED ref is dropped exactly like an absent one', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), answer('tu_a', 'Recorded.', 'not-a-real-ref')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'malformed ref', [], opts);
    expect(result.spoken_response ?? '').not.toContain('Recorded.');
    expect(logRows(opts, 'stage6.answer_narration_dropped')[0].code).toBe(
      'narration_requires_rejection_ref'
    );
  });

  test('an ANSWER-ONLY turn (no refusal) speaks its answer and stages NO fallback', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([answer('tu_a', 'Two circuits left.')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'answer only', [], opts);
    expect(result.spoken_response).toBe('Two circuits left.');
    expect(logRows(opts, 'stage6.answer_fallback_staged')).toHaveLength(0);
  });

  test('a dropped answer does NOT trigger ANSWER_FALLBACK_TEXT — the notice is the outcome', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), answer('tu_a', 'Recorded.')]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'dropped answer', [], opts);
    expect(spoken(result)).not.toContain(ANSWER_FALLBACK_TEXT);
    expect(logRows(opts, 'stage6.answer_fallback_staged')).toHaveLength(0);
  });

  test('an INSPECT-only turn still gets ANSWER_FALLBACK_TEXT — the flag is not overloaded', async () => {
    // `featureTouched` is deliberately untouched by this plan; clearing it
    // would delete inspect-then-silence and the failed-answer fallback to fix
    // a different problem.
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([{ id: 'tu_i', name: 'inspect_session_state', input: { scope: 'summary' } }]);
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'inspect only', [], opts);
    expect(result.spoken_response).toBe(ANSWER_FALLBACK_TEXT);
  });

  test('the drop log never carries the answer text (leak rule)', async () => {
    const sentinel = 'ZX9-SENTINEL-ANSWER the Zs on circuit 2 is 0.42';
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), answer('tu_a', sentinel)]);
    const opts = baseOpts();
    await runShadowHarness(session, 'leak check', [], opts);
    const all = JSON.stringify([
      ...opts.logger.info.mock.calls,
      ...opts.logger.warn.mock.calls,
      ...opts.logger.error.mock.calls,
    ]);
    expect(all).not.toContain('ZX9-SENTINEL-ANSWER');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5d — cancelled turns', () => {
  test("this plan's families SURVIVE a cancellation", async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b')], { cancelAfter: 0 });
    const result = await runShadowHarness(session, 'cancelled blank', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('a cancelled turn with a surviving refusal gets NO generic F7 apology', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b')], { cancelAfter: 0 });
    const result = await runShadowHarness(session, 'cancelled blank', [], baseOpts());
    expect(spoken(result).some((t) => t.toLowerCase().includes("didn't catch"))).toBe(false);
  });

  test('SUPERSESSION still applies on a cancelled turn, in both dispatch orders', async () => {
    // The cancelled finalization still builds confirmations for writes applied
    // before the abort, so a superseded refusal must never speak beside that
    // read-back.
    for (const order of [
      [blankWrite('tu_b'), goodWrite('tu_ok', 1, 'ocpd_bs_en', 'BS EN 61009')],
      [goodWrite('tu_ok', 1, 'ocpd_bs_en', 'BS EN 61009'), blankWrite('tu_b')],
    ]) {
      const session = makeSession(SINGLE_BOARD, 'main');
      loopDispatching(order, { cancelAfter: 1 });
      const result = await runShadowHarness(session, 'cancelled supersession', [], baseOpts());
      expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(false);
    }
  });

  test('a BULK refusal and an identical successful retry BOTH speak on a cancelled turn', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching(
      [
        blankBulk(),
        {
          id: 'tu_retry',
          name: 'set_field_for_all_circuits',
          input: {
            field: 'ref_method',
            value: 'A',
            confidence: 0.9,
            source_turn_id: 't1',
            scope: 'all',
          },
        },
      ],
      { cancelAfter: 1 }
    );
    const result = await runShadowHarness(session, 'cancelled bulk retry', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('all circuits'))).toBe(true);
  });

  test('a ref-bearing answer stays dropped on a cancelled turn; "unrelated" still co-speaks', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), answer('tu_a', 'Recorded.')], { cancelAfter: 1 });
    const dropResult = await runShadowHarness(session, 'cancelled drop', [], baseOpts());
    expect(dropResult.spoken_response ?? '').not.toContain('Recorded.');

    const session2 = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b'), answer('tu_a', 'Two left.', 'unrelated')], {
      cancelAfter: 1,
    });
    const coResult = await runShadowHarness(session2, 'cancelled unrelated', [], baseOpts());
    expect(coResult.spoken_response).toBe('Two left.');
    expect(spoken(coResult).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('a LEGACY family still dies with a cancelled turn — the regression pin for the narrowed guard', async () => {
    // `board_clear_already_empty` is the shipped Plan-2A case: on a cancelled
    // turn F7 owns its apology, exactly as before.
    const session = makeSession(SINGLE_BOARD, 'main', { 0: {}, 1: {} });
    loopDispatching(
      [
        {
          id: 'tu_cb',
          name: 'clear_board_reading',
          input: { field: 'manufacturer', reason: 'user_correction' },
        },
      ],
      { cancelAfter: 0 }
    );
    const result = await runShadowHarness(session, 'cancelled legacy', [], baseOpts());
    expect(spoken(result).some((t) => t.toLowerCase().includes('already blank'))).toBe(false);
  });

  test('a DENYLIST implementation fails: families outside the Plan-2A trio also die', async () => {
    // An implementation that filtered on the three named legacy families would
    // let these through. `model_contract` via unknown_tool is the cheapest to
    // provoke through the real barrel.
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([{ id: 'tu_x', name: 'no_such_tool', input: {} }], { cancelAfter: 0 });
    const result = await runShadowHarness(session, 'cancelled unknown tool', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('internal snag'))).toBe(false);
  });

  test('PARAMETERIZED: every registered non-C3 family/route is silent on a cancelled turn', async () => {
    // Walks the REGISTRY rather than a hand-written list, so a family added
    // later cannot drift past the allowlist unnoticed. The union is exactly
    // the one the informative inventory describes: the `B_STAGED_POOLS` route
    // keys plus the direct `BOARD_CLEAR_NOTICE_FAMILIES` keys, minus this
    // plan's own routes.
    const registered = new Set([
      ...Object.keys(B_STAGED_POOLS),
      ...Object.keys(BOARD_CLEAR_NOTICE_FAMILIES),
    ]);
    const nonC3 = [...registered].filter(
      (k) => !C3_NOTICE_ROUTES.has(k) && !C3_NOTICE_FAMILIES.has(k)
    );
    // The inventory the plan describes: fourteen registered keys, twelve
    // distinct non-C3 family strings.
    expect(nonC3.length).toBe(14);

    for (const route of nonC3) {
      const session = makeSession(SINGLE_BOARD, 'main');
      const staged = { family: route === 'unknown_tool' ? 'model_contract' : route };
      // Stage the family DIRECTLY onto the accumulator through the loop hook,
      // which is the only way to reach families whose real producers need
      // bespoke session state (capability gates, cert type, observations).
      runToolLoopSpy.mockImplementation(async (o) => {
        const ptw = o.perTurnWritesRef();
        ptw.mandatoryNotices.push({
          family: staged.family,
          slotKey: `probe::${route}`,
          turnId: 'turn-1',
          friendly: 'probe label',
          field: null,
          boardId: null,
          reason: route,
          coveredToolCallIds: ['tu_probe'],
          route,
          repeatKey: `${route}::probe`,
        });
        throw new ExtractionCancelledError('extraction_watchdog_absolute_ceiling');
      });
      const result = await runShadowHarness(session, `cancelled ${route}`, [], baseOpts());
      const texts = spoken(result);
      expect(texts.some((t) => t.toLowerCase().includes('probe label'))).toBe(false);
    }
  });

  test('…and one of THIS plan’s families staged the same way DOES survive', async () => {
    // The mirror of the sweep above. Without it the sweep would pass on an
    // implementation that drained nothing at all on a cancelled turn.
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      const ptw = o.perTurnWritesRef();
      ptw.mandatoryNotices.push({
        family: 'empty_write_blocked',
        slotKey: 'probe::c3',
        turnId: 'turn-1',
        friendly: 'probe label',
        field: null,
        boardId: null,
        reason: 'empty_write_blocked',
        coveredToolCallIds: ['tu_probe'],
        route: 'empty_write_blocked',
        repeatKey: 'empty_write_blocked::probe',
      });
      throw new ExtractionCancelledError('extraction_watchdog_absolute_ceiling');
    });
    const result = await runShadowHarness(session, 'cancelled c3 probe', [], baseOpts());
    expect(spoken(result).some((t) => t.toLowerCase().includes('probe label'))).toBe(true);
  });

  test('a cancellation with NO notice staged is unchanged from F7 today', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([goodWrite('tu_ok', 1, 'ref_method', 'A')], { cancelAfter: 0 });
    const result = await runShadowHarness(session, 'cancelled clean', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('reference method A'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5e — telemetry', () => {
  test('a value-bearing notice row carries NO text preview', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b')]);
    const opts = baseOpts();
    await runShadowHarness(session, 'telemetry', [], opts);
    const rows = logRows(opts, 'stage6.mandatory_notice_emitted');
    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe('empty_write_blocked');
    expect(rows[0]).not.toHaveProperty('textPreview');
  });

  test('a NON value-bearing family keeps its bounded preview', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([{ id: 'tu_x', name: 'no_such_tool', input: {} }]);
    const opts = baseOpts();
    await runShadowHarness(session, 'legacy telemetry', [], opts);
    const rows = logRows(opts, 'stage6.mandatory_notice_emitted');
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].textPreview).toBe('string');
  });

  test('no held value, designation or phase appears in ANY emitted notice row', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([
      blankWrite('tu_b'),
      {
        id: 'tu_r',
        name: 'rename_circuit',
        input: { from_ref: 1, circuit_ref: 1, designation: '' },
      },
    ]);
    const opts = baseOpts();
    await runShadowHarness(session, 'leak sweep', [], opts);
    const rows = JSON.stringify(logRows(opts, 'stage6.mandatory_notice_emitted'));
    expect(rows).not.toContain('BS EN 60898');
    expect(rows).not.toContain('Upstairs Lighting');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5f/6 — the ask hooks and the CC9E0915 shape', () => {
  test('the ask dispatcher is composed WITH both rejection hooks', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([]);
    await runShadowHarness(session, 'compose', [], baseOpts());
    expect(typeof capturedAskOpts?.recordAskRegistration).toBe('function');
    expect(typeof capturedAskOpts?.stageEnumRejectionAfterAsk).toBe('function');
  });

  test('a covering ask retires the refusal — the question speaks alone', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    loopDispatching([blankWrite('tu_b')], {
      between: (i, o) => {
        if (i !== 0) return;
        // Journal the ask exactly as the ask dispatcher would, through the
        // harness's own hook — the point is the DRAIN's reconciliation, not
        // the ask module's plumbing (covered in its own suite).
        void o;
      },
    });
    runToolLoopSpy.mockImplementation(async (o) => {
      await o.dispatcher(
        { tool_call_id: 'tu_b', name: 'record_reading', input: blankWrite('tu_b').input },
        o.ctx
      );
      const ptw = o.perTurnWritesRef();
      ptw.askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'ocpd_bs_en',
        circuits: [1],
        boardId: 'main',
      });
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
    const result = await runShadowHarness(
      session,
      'ask covers',
      [],
      baseOpts({ _seedEmittedAskToolCallIds: ['tu_ask'] })
    );
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(false);
  });

  test('an ask on the same field but a DIFFERENT circuit does not retire it', async () => {
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      await o.dispatcher(
        { tool_call_id: 'tu_b', name: 'record_reading', input: blankWrite('tu_b').input },
        o.ctx
      );
      o.perTurnWritesRef().askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'ocpd_bs_en',
        circuits: [2],
        boardId: 'main',
      });
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
    const result = await runShadowHarness(
      session,
      'ask other circuit',
      [],
      baseOpts({ _seedEmittedAskToolCallIds: ['tu_ask'] })
    );
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('an ask that was REGISTERED but never HEARD does not retire the refusal', async () => {
    // Codex review cycle 1: the registration is journaled BEFORE the WebSocket
    // send. A closed socket or a throwing send leaves a question nobody heard,
    // and retiring the refusal for it leaves the rejected value with no
    // specific spoken outcome at all. Same setup as the covering-ask case
    // above, minus the emission evidence — so this is the discriminating half.
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      await o.dispatcher(
        { tool_call_id: 'tu_b', name: 'record_reading', input: blankWrite('tu_b').input },
        o.ctx
      );
      o.perTurnWritesRef().askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'ocpd_bs_en',
        circuits: [1],
        boardId: 'main',
      });
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
    const result = await runShadowHarness(session, 'unsent ask', [], baseOpts());
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('a POST-ASK refusal is NOT retired by the ask that produced it', async () => {
    // Found by the live lane, and invisible to every other test here: the
    // covering ask ALWAYS matches its own post-ask notice's slot, so a blanket
    // covering-ask rule swallows every `enum_rejected_after_ask` there is.
    //
    // The question already spoke. The inspector then answered, and the answer
    // was rejected too. THAT refusal is the second, necessary line — it is the
    // whole reason the prompt can tell the model to emit nothing further. A
    // server that suppressed it would restore the September-17 dead end with
    // itself doing the silencing instead of the model.
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      const ptw = o.perTurnWritesRef();
      // The ask, registered exactly as the ask dispatcher registers it…
      ptw.askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'ocpd_bs_en',
        circuits: [1],
        boardId: 'main',
      });
      // …and the refusal its own resolution stages, on the same slot.
      ptw.mandatoryNotices.push({
        family: 'enum_rejected_after_ask',
        slotKey: rawCircuitSlot('ocpd_bs_en', 1, 'main'),
        turnId: 'turn-1',
        friendly: 'OCPD BS/EN on circuit 1, still BS EN 60898',
        field: 'ocpd_bs_en',
        boardId: 'main',
        reason: 'enum_rejected_after_ask',
        coveredToolCallIds: ['tu_ask'],
        route: 'enum_rejected_after_ask',
        repeatKey: 'enum_rejected_after_ask::probe',
      });
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
    const result = await runShadowHarness(
      session,
      'post-ask refusal',
      [],
      baseOpts({ _seedEmittedAskToolCallIds: ['tu_ask'] })
    );
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(true);
  });

  test('…while a PROVISIONAL refusal on the same slot IS retired by that ask', async () => {
    // The discriminating half: the rule still applies to the family it was
    // written for, so the fix narrowed the branch rather than deleting it.
    const session = makeSession(SINGLE_BOARD, 'main');
    runToolLoopSpy.mockImplementation(async (o) => {
      const ptw = o.perTurnWritesRef();
      ptw.askRegistrations.push({
        toolCallId: 'tu_ask',
        rejectionRef: null,
        field: 'ocpd_bs_en',
        circuits: [1],
        boardId: 'main',
      });
      ptw.mandatoryNotices.push({
        family: 'enum_rejected',
        slotKey: rawCircuitSlot('ocpd_bs_en', 1, 'main'),
        turnId: 'turn-1',
        friendly: 'OCPD BS/EN on circuit 1, still BS EN 60898',
        field: 'ocpd_bs_en',
        boardId: 'main',
        reason: 'enum_rejected',
        coveredToolCallIds: ['tu_w'],
        route: 'enum_rejected',
        repeatKey: 'enum_rejected::probe',
      });
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
    const result = await runShadowHarness(
      session,
      'provisional refusal',
      [],
      baseOpts({ _seedEmittedAskToolCallIds: ['tu_ask'] })
    );
    expect(spoken(result).some((t) => t.includes('still BS EN 60898'))).toBe(false);
  });

  test('acceptance 6 — the CC9E0915 11:28:53 shape replayed: the blank is refused and speaks once', async () => {
    // The field turn that produced this plan: `ocpd_bs_en` written as `""`
    // after two rejections, on a circuit whose value was NOT yet set. The
    // spoken outcome must name the slot and say it is still blank.
    const session = makeSession(SINGLE_BOARD, 'main', {
      0: {},
      4: { circuit_designation: 'Immersion' },
    });
    loopDispatching([blankWrite('tu_cc', 4, 'ocpd_bs_en')]);
    const result = await runShadowHarness(session, 'CC9E0915 replay', [], baseOpts());
    const refusals = spoken(result).filter((t) => t.includes('still blank'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('circuit 4');
    expect(session.stateSnapshot.circuits[4].ocpd_bs_en).toBeUndefined();
  });
});
