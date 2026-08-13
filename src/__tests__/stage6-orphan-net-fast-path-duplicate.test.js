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
  test('exact match returns the clamped tuple (+ resolved boardId); performs NO write', () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const dup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    // Codex diff-review F3 (2026-08-13) — the resolved effective board now
    // rides along on the return value (single-board fixture → main).
    expect(dup).toEqual({ field: 'rcd_time_ms', circuit: 2, value: '24', boardId: 'main' });
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

  // Codex diff-review F3 (2026-08-13) — the PREVIOUS shape read
  // `session.stateSnapshot.circuits[tuple.circuit]` directly with no board
  // resolution at all: on a multi-board job the same circuit ref exists on
  // every board, so a re-dictation of board B's circuit 2 could silently
  // compare against board A's circuit 2's DIFFERENT stored value.
  test('multi-board: resolves against the CURRENT board only, never a same-ref circuit on a different board', () => {
    const session = makeSession({
      2: { rcd_time_ms: '24' }, // main board's circuit 2
      'sub-1::2': { rcd_time_ms: '99', circuit: 2, board_id: 'sub-1' }, // sub-board's circuit 2
    });
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub' },
    ];
    // On the MAIN board (no currentBoardId set → resolves to main): a
    // re-dictation of "24" matches main's stored value.
    const mainDup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    expect(mainDup).toEqual({ field: 'rcd_time_ms', circuit: 2, value: '24', boardId: 'main' });
    // Re-dictating sub-1's OWN value ("99") while sub-1 is the CURRENT board
    // matches sub-1's own stored value, not main's "24".
    session.stateSnapshot.currentBoardId = 'sub-1';
    const subDup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '99' },
    });
    expect(subDup).toEqual({ field: 'rcd_time_ms', circuit: 2, value: '99', boardId: 'sub-1' });
    // Re-dictating MAIN's value ("24") while sub-1 is current must NOT match
    // — sub-1's own stored value is "99", a different value entirely.
    const crossBoardMiss = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '24' },
    });
    expect(crossBoardMiss).toBeNull();
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
    // F8 (array shape) — a lone 'suppress' entry yields ZERO confirmations,
    // logged via confirmationCount rather than a single top-level `kind`.
    expect(row[1].confirmationCount).toBe(0);
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
      // F8 — per-correlation collision-free token.
      dedupe_token: `duplicate_${SESSION_ID}-turn-1_cid-pending`,
      expects_ios_ack: false,
    });
    expect(confs[0].text).toBe('Already got that — Circuit 4, Zs 0.62');
    expect(session.orphanContext == null).toBe(true);
  });

  // Codex diff-review F2 (2026-08-13): PREVIOUSLY this raced-before-commit
  // case fell through to the ordinary orphan prompt — silently defaulting
  // to ABSENCE, exactly the outcome the plan's "pending, not absence" rule
  // forbids (a real fast-TTS attempt is in flight; the transcript can
  // legitimately beat ElevenLabs' first byte over the wire). Fixed: the
  // ledger's raw (un-clamped) pre-commit record now still produces a
  // correlation-stamped fallback confirmation, built the same way B3.2's
  // "Already got" wording works, just sourced from the un-clamped candidate
  // captured at markFastAttemptPending time instead of the clamped
  // commitAcceptedIdentity value.
  test('pending WITHOUT a committed identity yet (race) → correlation-stamped fallback confirmation (never an apology, never silence)', async () => {
    fastIdentity.markFastAttemptPending('cid-race', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    // Never committed — commitAcceptedIdentity (the fast route's first
    // onAudio byte) has not run yet.

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-race' });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const orphanPrompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(orphanPrompt).toBeUndefined();
    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    expect(confs[0]).toMatchObject({
      field: 'measured_zs_ohm',
      circuit: 4,
      fast_correlation_id: 'cid-race',
      // F8 — per-correlation collision-free token.
      dedupe_token: `duplicate_${SESSION_ID}-turn-1_cid-race`,
      expects_ios_ack: false,
    });
    expect(confs[0].text).toBe('Already got that — Circuit 4, Zs 0.62');
    expect(session.orphanContext == null).toBe(true);
  });

  // Codex diff-review M2 (2026-08-13, per-fix mini-review): the
  // pending_uncommitted fallback above (F2) clamps the raw rawValue via
  // clampReadingForDispatch but PREVIOUSLY dropped the resulting
  // correction on the floor when building the spoken text — if this
  // fallback is the ONLY audible line for a reading that needed a
  // decimal-slip clamp (e.g. "16" -> "1.6" on a continuity field), the
  // inspector would hear the corrected number with no "I corrected 16 to
  // 1.6" clause, silently misleading them into thinking the number they
  // said is what got recorded.
  test('pending WITHOUT a committed identity, raw value needs a clamp correction — fallback speaks the correction clause', async () => {
    fastIdentity.markFastAttemptPending('cid-clamp-race', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'r1_r2_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '16',
    });
    // Never committed — commitAcceptedIdentity (the fast route's first
    // onAudio byte) has not run yet.

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-clamp-race' });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    expect(confs[0].text).toBe(
      'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
    );
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
    // F8 — per-correlation collision-free tokens.
    expect(c1.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-1_cid-a`);
    expect(c2.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-2_cid-b`);
  });

  // [DEVIATION] F8 (Codex diff-review, 2026-08-13, sanctioned) — the
  // required test from the brief: a turn with TWO attempted correlations,
  // one `playback_started` and one `pending` with a committed identity.
  // Before F8, resolveFastLedgerOutcomeForTurn collapsed the whole turn to
  // ONE winner — whichever correlation the for-loop hit first (Set
  // iteration order, i.e. insertion order) decided the ENTIRE outcome, so
  // depending on which correlation the test attempted first, the pending
  // sibling's fallback could be silently dropped entirely (0 confirmations
  // when there should be 1) OR the playback_started sibling's suppression
  // could be defeated. F8 makes both independent: the playback_started
  // correlation contributes nothing but does NOT cancel the pending
  // sibling's own fallback confirmation.
  test('[DEVIATION] F8 — TWO attempted correlations (one playback_started, one pending+committed) → exactly ONE fallback confirmation, BOTH independently accounted for', async () => {
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

    fastIdentity.markFastAttemptPending('cid-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'r1_r2_ohm',
      circuit: 5,
      boardId: null,
      rawValue: '0.35',
    });
    fastIdentity.commitAcceptedIdentity('cid-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'r1_r2_ohm',
      circuit: 5,
      boardId: null,
      canonicalValue: '0.35',
      comparisonText: 'Circuit 5, R1 plus R2 0.35',
    });
    // cid-pending deliberately NOT marked playback_started or failed.

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: ['cid-played', 'cid-pending'] });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    expect(confs[0]).toMatchObject({
      field: 'r1_r2_ohm',
      circuit: 5,
      fast_correlation_id: 'cid-pending',
      dedupe_token: `duplicate_${SESSION_ID}-turn-1_cid-pending`,
    });
    // The playback_started correlation produced NO confirmation of its own
    // — but critically, it also didn't SUPPRESS the pending sibling's one.
    expect(confs.find((c) => c.fast_correlation_id === 'cid-played')).toBeUndefined();
    // Both correlations were independently accounted for: the log row
    // reflects exactly ONE confirmation (the pending one), not zero (which
    // would mean the playback_started sibling silently ate it) and not two
    // (which would mean the suppress entry fabricated a second line).
    const row = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.orphan_duplicate_or_pending_outcome'
    );
    expect(row).toBeDefined();
    expect(row[1].confirmationCount).toBe(1);
    expect(row[1].fastCorrelationIds).toEqual(['cid-pending']);
    expect(session.orphanContext == null).toBe(true);
  });

  // Codex diff-review M4 (2026-08-13, per-fix mini-review): F8 gave every
  // ATTEMPTED correlationId its own independent outcome — correct for
  // genuinely different readings, but if TWO DISTINCT correlationIds
  // resolve to the SAME semantic reading (e.g. iOS retries a fast dispatch
  // with a freshly-minted correlationId for what is fundamentally the same
  // dictated value), each independently produced its own fallback with its
  // own dedupe_token — the client could not collapse them, so the SAME
  // reading could be spoken TWICE. Outcomes are now coalesced by
  // (field, circuit, boardId, value) before confirmations are built.
  test('[M4] TWO correlationIds resolving to the SAME field/circuit/board/value (a retry) → exactly ONE confirmation, not two', async () => {
    fastIdentity.markFastAttemptPending('cid-retry-a', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-retry-a', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    // A second correlationId — iOS retried the same dispatch with a fresh
    // client-minted UUID — resolving to the IDENTICAL field/circuit/board/
    // value. Both stay 'pending' (neither played back).
    fastIdentity.markFastAttemptPending('cid-retry-b', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-retry-b', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: ['cid-retry-a', 'cid-retry-b'] });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(1);
    expect(confs[0].text).toBe('Already got that — Circuit 4, Zs 0.62');
    // Either correlationId is an acceptable representative — the important
    // invariant is there is exactly ONE, not one-per-correlationId.
    expect(['cid-retry-a', 'cid-retry-b']).toContain(confs[0].fast_correlation_id);
  });

  test('[M4] a playback_started correlation and a retry for the SAME reading → the WHOLE group is suppressed (zero confirmations), not one', async () => {
    fastIdentity.markFastAttemptPending('cid-played-retry', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-played-retry', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    fastIdentity.markFastAttemptPlaybackStarted(SESSION_ID, 'cid-played-retry');

    // A SECOND correlationId for the SAME reading, still pending — the user
    // already HEARD this exact value via the sibling's playback, so this
    // must not speak a second "Already got" line either.
    fastIdentity.markFastAttemptPending('cid-still-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-still-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });

    const session = makeSession({});
    const opts = baseOpts({
      regexFastCorrelationId: ['cid-played-retry', 'cid-still-pending'],
    });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    const confs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(confs).toHaveLength(0);
    expect(session.orphanContext == null).toBe(true);
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
