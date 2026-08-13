/**
 * Plan B (feedback ids 118/119) B3.1/B3.2/B3.3 — the honest orphan net's
 * fast-ledger precedence chain + exact-duplicate re-speak.
 *
 * Mirrors stage6-orphan-net.test.js's mock pattern. Three sources of signal
 * feed the zero-tool-call apology decision:
 *   - B3.1 fast-attempt ledger (fast-path-accepted-identity.js):
 *     'playback_started' → suppress entirely; 'pending' (with a COMMITTED
 *     identity) → a correlation + dedupe-token stamped "Already got"
 *     fallback.
 *   - B3.2 exact-duplicate re-speak: a read-only re-parse of the transcript
 *     (reparseSingleCompleteReading, the SAME dialogue-schema parser the #5a
 *     apply-complete guard uses) compared against session.stateSnapshot —
 *     an EXACT match speaks "Already got" WITHOUT writing or setting
 *     orphanContext; a mismatch/no-tuple falls through to the unchanged
 *     orphan prompt.
 *   - B3.3 precedence: playback_started > pending > exact-duplicate >
 *     existing orphan prompt.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-fastpath-dup';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

// Default mock: a no-op turn (zero tool calls) — the orphan trigger shape.
const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: jest.fn(),
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

const { runShadowHarness, findExactDuplicateAgainstSnapshot } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const fastIdentity = await import('../extraction/fast-path-accepted-identity.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(circuits = {}) {
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
    stateSnapshot: { circuits, pending_readings: [], observations: [], validation_alerts: [] },
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

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
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
  fastIdentity._resetForTests();
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
  fastIdentity._resetForTests();
});

describe('findExactDuplicateAgainstSnapshot (read-only, unit level)', () => {
  test('exact match returns the clamped tuple; performs NO write', () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const dup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    expect(dup).toEqual({ field: 'rcd_time_ms', circuit: 2, value: '24' });
    // Unchanged — never mutated.
    expect(session.stateSnapshot.circuits[2]).toEqual({ rcd_time_ms: '24' });
  });

  test('value mismatch returns null', () => {
    const session = makeSession({ 2: { rcd_time_ms: '99' } });
    const dup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    expect(dup).toBeNull();
  });

  test('no existing value for that circuit/field returns null', () => {
    const session = makeSession({ 2: {} });
    const dup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    expect(dup).toBeNull();
  });
});

describe('B3.2 — exact-duplicate zero-tool-call re-speak (full harness)', () => {
  const DUP_RE = /^Already got that —/;

  test('an exact repeat speaks ONE "Already got" confirmation, writes nothing, no orphanContext', async () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      baseOpts()
    );
    const confs = (result.confirmations ?? []).filter((c) => DUP_RE.test(c.text || ''));
    expect(confs).toHaveLength(1);
    expect(confs[0]).toMatchObject({
      field: 'rcd_time_ms',
      circuit: 2,
      dedupe_token: `duplicate_${SESSION_ID}-turn-1`,
      expects_ios_ack: false,
    });
    expect(confs[0].fast_correlation_id).toBeUndefined();
    // No write — the snapshot value is untouched.
    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBe('24');
    expect(result.extracted_readings ?? []).toHaveLength(0);
    // Never armed for next-turn re-injection.
    expect(session.orphanContext == null).toBe(true);
  });

  test('a mismatched value (not a duplicate) falls through to the unchanged orphan prompt', async () => {
    // "EFC is 0.86." matches no ALL_DIALOGUE_SCHEMAS trigger at all (same
    // fixture as stage6-orphan-net.test.js's baseline) — reparse yields no
    // tuple, so exactDuplicateTuple is null and the precedence chain falls
    // all the way through to the pre-existing ORPHAN_PROMPTS branch,
    // UNCHANGED.
    const session = makeSession({});
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], baseOpts());
    const dupConfs = (result.confirmations ?? []).filter((c) => DUP_RE.test(c.text || ''));
    expect(dupConfs).toHaveLength(0);
    const orphanPrompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(orphanPrompt).toBeDefined();
    expect(session.orphanContext).not.toBeNull();
  });

  test('TWO consecutive identical duplicate turns each speak their OWN audible line with a DISTINCT dedupe_token', async () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const r1 = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      baseOpts()
    );
    const r2 = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      baseOpts()
    );
    const c1 = (r1.confirmations ?? []).find((c) => DUP_RE.test(c.text || ''));
    const c2 = (r2.confirmations ?? []).find((c) => DUP_RE.test(c.text || ''));
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1.dedupe_token).not.toBe(c2.dedupe_token);
    expect(c1.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-1`);
    expect(c2.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-2`);
  });
});

describe('B3.1/B3.3 — fast-attempt ledger precedence at the same seam', () => {
  test('playback_started → suppress entirely (no second line, no orphanContext)', async () => {
    fastIdentity.markFastAttemptPending('cid-played', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-played', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    fastIdentity.markFastAttemptPlaybackStarted(SESSION_ID, 'cid-played');

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-played' });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    // Nothing at all pushed for this turn — the user already heard the fast
    // clip.
    expect(result.confirmations ?? []).toHaveLength(0);
    expect(session.orphanContext == null).toBe(true);
    const row = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.orphan_duplicate_or_pending_outcome'
    );
    expect(row).toBeDefined();
    expect(row[1].kind).toBe('suppress');
  });

  test('pending WITH a committed identity → correlation + dedupe-token stamped "Already got" fallback', async () => {
    fastIdentity.markFastAttemptPending('cid-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    // Deliberately NOT marked playback_started or failed — stays 'pending'.

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-pending' });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    expect(confs[0]).toMatchObject({
      field: 'measured_zs_ohm',
      circuit: 4,
      fast_correlation_id: 'cid-pending',
      dedupe_token: `duplicate_${SESSION_ID}-turn-1`,
      expects_ios_ack: false,
    });
    expect(confs[0].text).toBe('Already got that — Circuit 4, Zs 0.62');
    expect(session.orphanContext == null).toBe(true);
  });

  test('pending WITHOUT a committed identity yet (race) → falls through to the unchanged orphan prompt (never a placeholder)', async () => {
    fastIdentity.markFastAttemptPending('cid-race', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    // Never committed.

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-race' });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const dupConfs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(dupConfs).toHaveLength(0);
    const orphanPrompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(orphanPrompt).toBeDefined();
  });

  test('TWO consecutive pending-fast duplicate turns each speak ONE audible line, with DISTINCT dedupe_tokens', async () => {
    fastIdentity.markFastAttemptPending('cid-a', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-a', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    fastIdentity.markFastAttemptPending('cid-b', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-b', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });

    const session = makeSession({});
    const r1 = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ regexFastCorrelationId: 'cid-a' })
    );
    const r2 = await runShadowHarness(
      session,
      'PFC is 0.86.',
      [],
      baseOpts({ regexFastCorrelationId: 'cid-b' })
    );
    const c1 = (r1.confirmations ?? []).find((c) => /^Already got that —/.test(c.text || ''));
    const c2 = (r2.confirmations ?? []).find((c) => /^Already got that —/.test(c.text || ''));
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1.fast_correlation_id).toBe('cid-a');
    expect(c2.fast_correlation_id).toBe('cid-b');
    expect(c1.dedupe_token).not.toBe(c2.dedupe_token);
    expect(c1.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-1`);
    expect(c2.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-2`);
  });

  test('failed ledger state falls through to the exact-duplicate check (not suppress/pending)', async () => {
    fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-failed');
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const opts = baseOpts({ regexFastCorrelationId: 'cid-failed' });
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      opts
    );
    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    // No fast_correlation_id — this outcome came from B3.2's snapshot
    // compare, not the fast ledger (which contributed nothing usable).
    expect(confs[0].fast_correlation_id).toBeUndefined();
    expect(confs[0].dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-1`);
  });

  test('allRejected turns are completely untouched by the fast-ledger precedence chain', async () => {
    fastIdentity.markFastAttemptPending('cid-x', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-x', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    fastIdentity.markFastAttemptPlaybackStarted(SESSION_ID, 'cid-x');
    runToolLoopSpy.mockImplementation(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [
        {
          name: 'create_circuit',
          input: {},
          result: { tool_use_id: 't', content: '{"ok":false}', is_error: true },
        },
      ],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-x' });
    const result = await runShadowHarness(session, 'Circuits 5, 6, 7, 8 are spare.', [], opts);
    // The pre-existing REJECTED_PROMPTS behaviour must be UNCHANGED — a
    // playback_started fast attempt for a DIFFERENT class of turn
    // (allRejected) must never suppress the "couldn't action that" apology.
    const rejectedPrompt = (result.confirmations ?? []).find((c) =>
      /(couldn't action|able to apply|didn't go through)/i.test(c.text || '')
    );
    expect(rejectedPrompt).toBeDefined();
    const suppressRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.orphan_duplicate_or_pending_outcome'
    );
    expect(suppressRow).toBeUndefined();
  });

  // Codex diff-review F4 (2026-08-13) — an allRejected turn whose transcript
  // happens to reparse to a value already matching the stored snapshot must
  // go through the ORIGINAL pre-Plan-B recovery path (apply + ordinary
  // read-back), NEVER B3.2's "Already got" wording — B3.2 is deliberately
  // scoped to the non-allRejected, zero-tool-call class only (see
  // resolveZeroToolCallDuplicateOutcome's doc comment and its caller, which
  // only invokes it when `!allRejected`).
  test('allRejected + reparse tuple matches an already-stored value → ORIGINAL recovery (write + ordinary read-back), never B3.2 "Already got"', async () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    runToolLoopSpy.mockImplementationOnce(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [
        {
          name: 'create_circuit',
          input: {},
          result: { tool_use_id: 't', content: '{"ok":false}', is_error: true },
        },
      ],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const opts = baseOpts();
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      opts
    );
    const dupConfs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(dupConfs).toHaveLength(0);
    // The ORIGINAL recovery path ran: a reading was pushed and an ordinary
    // (non-"Already got") confirmation speaks it.
    expect(result.extracted_readings ?? []).toHaveLength(1);
    expect(result.extracted_readings[0]).toMatchObject({
      field: 'rcd_time_ms',
      circuit: 2,
      value: '24',
    });
    const ordinaryConf = (result.confirmations ?? []).find(
      (c) => c.field === 'rcd_time_ms' && c.circuit === 2
    );
    expect(ordinaryConf).toBeDefined();
    expect(ordinaryConf.text).not.toMatch(/^Already got/);
    const recoveredRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.orphan_apply_complete'
    );
    expect(recoveredRow).toBeDefined();
    // B3.2's duplicate-detection log row must NEVER fire for an allRejected
    // turn — the read-only check is scoped OUT of this class entirely.
    const dupRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.orphan_exact_duplicate_detected'
    );
    expect(dupRow).toBeUndefined();
  });
});
