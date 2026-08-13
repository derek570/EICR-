/**
 * Codex diff-review cycle 5 (G1) — B3's exact-duplicate check and fast-ledger
 * precedence chain (B3.1/B3.2/B3.3, incl. the cycle-4 E1 catch-all latch)
 * were accidentally nested ENTIRELY inside `orphanEmissionEligible`, which
 * includes `ORPHAN_PROMPT_ENABLED` — a pre-existing, unrelated kill switch
 * for the OLD/legacy generic orphan-prompt mechanism. Flipping
 * VOICE_ORPHAN_PROMPT=false therefore silently disabled B3 entirely: an
 * exact duplicate stopped getting "Already got", and worse, a
 * `playback_started`/D3-silence outcome never got a chance to set
 * `fastLedgerSuppressesCatchallThisTurn`, so the marker-② catch-all E1 was
 * built to suppress could fire on top of audio the inspector already heard.
 *
 * Fix: a `orphanContentEligible` predicate identical to
 * `orphanEmissionEligible` MINUS `ORPHAN_PROMPT_ENABLED` now gates the
 * non-allRejected class (B3's home); the allRejected class and the legacy
 * generic-orphan-prompt emission calls keep the original flag-gated
 * behaviour verbatim (pinned by stage6-honest-refusal-orphan-off.test.js
 * and this file's own (d) control).
 *
 * Separate file because ORPHAN_PROMPT_ENABLED is a module-load constant —
 * the env var must be set BEFORE the harness module is imported (same
 * pattern as stage6-honest-refusal-orphan-off.test.js and
 * stage6-orphan-net-fast-path-duplicate-flag-off.test.js).
 */

import { jest } from '@jest/globals';

process.env.VOICE_ORPHAN_PROMPT = 'false';

const SESSION_ID = 'sess-fastpath-g1-flag-off';

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

const { runShadowHarness, CATCHALL_AUDIBILITY_PROMPTS, ORPHAN_PROMPTS } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const fastIdentity = await import('../extraction/fast-path-accepted-identity.js');

const ORPHAN_SET = new Set(ORPHAN_PROMPTS);

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

afterAll(() => {
  delete process.env.VOICE_ORPHAN_PROMPT;
});

test('(a) exact-duplicate zero-tool-call turn still produces "Already got" with VOICE_ORPHAN_PROMPT=false', async () => {
  const session = makeSession({ 2: { rcd_time_ms: '24' } });
  const opts = baseOpts();
  const result = await runShadowHarness(session, 'RCD trip time for circuit 2 is 24 ms', [], opts);

  const dupConfs = (result.confirmations ?? []).filter((c) =>
    /^Already got that —/.test(c.text || '')
  );
  expect(dupConfs).toHaveLength(1);
  expect(dupConfs[0]).toMatchObject({ field: 'rcd_time_ms', circuit: 2 });
  expect(session.orphanContext == null).toBe(true);
});

test('(b) playback_started outcome still produces no confirmation AND still latches the E1 catch-all exemption, with VOICE_ORPHAN_PROMPT=false', async () => {
  fastIdentity.markFastAttemptPending('cid-g1-played', {
    sessionId: SESSION_ID,
    turnId: 'irrelevant',
    field: 'measured_zs_ohm',
    circuit: 4,
    boardId: null,
    rawValue: '0.62',
  });
  fastIdentity.commitAcceptedIdentity('cid-g1-played', {
    sessionId: SESSION_ID,
    turnId: 'irrelevant',
    field: 'measured_zs_ohm',
    circuit: 4,
    boardId: null,
    canonicalValue: '0.62',
    comparisonText: 'Circuit 4, Zs 0.62',
  });
  fastIdentity.markFastAttemptPlaybackStarted(SESSION_ID, 'cid-g1-played');

  const session = makeSession({});
  const opts = baseOpts({ regexFastCorrelationId: 'cid-g1-played', chimeObserved: true });
  const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

  // No second line for the reading the user already heard on the fast clip.
  expect(result.confirmations ?? []).toHaveLength(0);
  const row = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.orphan_duplicate_or_pending_outcome'
  );
  expect(row).toBeDefined();
  expect(row[1].confirmationCount).toBe(0);
  // The E1 latch (fastLedgerSuppressesCatchallThisTurn) must still fire even
  // with the flag off — otherwise marker-② would apologise on top of audio
  // already played, which is the whole defect this file guards against.
  const catchall = (result.confirmations ?? []).filter((c) =>
    CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
  );
  expect(catchall).toHaveLength(0);
  const catchallRow = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
  );
  expect(catchallRow).toBeUndefined();
});

test('(c) D3 silence branch (correlation attempted, resolves to nothing usable) still fires with VOICE_ORPHAN_PROMPT=false — no apology, no catch-all', async () => {
  fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-g1-failed');
  const session = makeSession({});
  const opts = baseOpts({ regexFastCorrelationId: 'cid-g1-failed', chimeObserved: true });
  const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

  expect(result.confirmations ?? []).toHaveLength(0);
  const catchall = (result.confirmations ?? []).filter((c) =>
    CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
  );
  expect(catchall).toHaveLength(0);
  // D3's own suppression row still fires — proving the silence is the
  // deliberate D3 mechanism, not an accidental side effect of the flag.
  const d3Row = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.fast_ledger_unaddressed_failure_suppressed'
  );
  expect(d3Row).toBeDefined();
  // The LEGACY generic apology (D3's own defensive-assertion fallback,
  // which is itself gated by ORPHAN_PROMPT_ENABLED) never fires either.
  const legacyRow = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.orphan_prompt_emitted'
  );
  expect(legacyRow).toBeUndefined();
});

test('(d) control — a genuinely broken/empty turn with NO fast-ledger involvement stays silent: the LEGACY generic orphan prompt is correctly suppressed by VOICE_ORPHAN_PROMPT=false (B3 was only narrowed out of the flag, not the whole net widened)', async () => {
  const session = makeSession({});
  const opts = baseOpts();
  // No fast correlation, no exact-duplicate match (session has no stored
  // value for circuit 2), so this transcript reparses to a fresh (not
  // duplicate) tuple — exactly the class the legacy ORPHAN_PROMPTS family
  // used to cover before the flag was flipped off.
  const result = await runShadowHarness(session, 'RCD trip time for circuit 2 is 24 ms', [], opts);

  const orphanPrompt = (result.confirmations ?? []).filter((c) => ORPHAN_SET.has(c.text));
  expect(orphanPrompt).toHaveLength(0);
  const legacyRow = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.orphan_prompt_emitted'
  );
  expect(legacyRow).toBeUndefined();
  // Not widened either: the #5a apply-complete WRITE for this brand-new
  // (non-duplicate) reading stays behind ORPHAN_PROMPT_ENABLED too (it
  // predates Plan B and was already flag-gated pre-Plan-B) — no confirmation
  // AND no silent write, byte-identical to the pre-G1 flag-off behaviour.
  expect(result.confirmations ?? []).toHaveLength(0);
  const applyRow = opts.logger.info.mock.calls.find(
    ([ev]) => ev === 'stage6.orphan_apply_complete'
  );
  expect(applyRow).toBeUndefined();
  expect(session.orphanContext == null).toBe(true);
});
