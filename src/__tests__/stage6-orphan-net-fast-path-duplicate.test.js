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

const {
  runShadowHarness,
  findExactDuplicateAgainstSnapshot,
  mergeFastPathCorrelationIds,
  unmergeFastPathCorrelationIds,
  resolveZeroToolCallDuplicateOutcome,
  CATCHALL_AUDIBILITY_PROMPTS,
} = await import('../extraction/stage6-shadow-harness.js');
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

// Codex diff-review cycle 3 D1 — direct unit coverage of the shared
// coercion/merge helper sonnet-stream.js's four ask-answer resolution sites
// now call (see sonnet-stream-ask-answer-fast-correlation-ingress.test.js
// for the production-ingress test proving those call sites actually invoke
// it; this describe block proves the helper's own shape contract in
// isolation).
describe('mergeFastPathCorrelationIds (unit level)', () => {
  function makeEntry(seed) {
    return { fastPathCorrelationIdByTurn: seed ?? new Map() };
  }

  test('accepts a single string id', () => {
    const entry = makeEntry();
    mergeFastPathCorrelationIds(entry, 'turn-1', 'cid-a');
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a']));
  });

  test('accepts an array of ids', () => {
    const entry = makeEntry();
    mergeFastPathCorrelationIds(entry, 'turn-1', ['cid-a', 'cid-b']);
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a', 'cid-b']));
  });

  test('MERGES into an existing Set for the turn rather than replacing it', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-existing'])]]));
    mergeFastPathCorrelationIds(entry, 'turn-1', 'cid-new');
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(
      new Set(['cid-existing', 'cid-new'])
    );
  });

  test('a different turnId gets its own independent Set', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-a'])]]));
    mergeFastPathCorrelationIds(entry, 'turn-2', 'cid-b');
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a']));
    expect(entry.fastPathCorrelationIdByTurn.get('turn-2')).toEqual(new Set(['cid-b']));
  });

  test('no-op on null/undefined/empty-string rawCid — never creates a stray entry', () => {
    const entry = makeEntry();
    mergeFastPathCorrelationIds(entry, 'turn-1', null);
    mergeFastPathCorrelationIds(entry, 'turn-1', undefined);
    mergeFastPathCorrelationIds(entry, 'turn-1', '');
    mergeFastPathCorrelationIds(entry, 'turn-1', []);
    expect(entry.fastPathCorrelationIdByTurn.has('turn-1')).toBe(false);
  });

  test('no-op when turnId is not a non-empty string (e.g. entry.activeTurnId is null — no turn in flight)', () => {
    const entry = makeEntry();
    mergeFastPathCorrelationIds(entry, null, 'cid-a');
    mergeFastPathCorrelationIds(entry, undefined, 'cid-a');
    mergeFastPathCorrelationIds(entry, '', 'cid-a');
    expect(entry.fastPathCorrelationIdByTurn.size).toBe(0);
  });

  test('no-op when entry is null/undefined — never throws', () => {
    expect(() => mergeFastPathCorrelationIds(null, 'turn-1', 'cid-a')).not.toThrow();
    expect(() => mergeFastPathCorrelationIds(undefined, 'turn-1', 'cid-a')).not.toThrow();
  });

  test('non-string array entries are filtered out; a fully-invalid array is a no-op', () => {
    const entry = makeEntry();
    mergeFastPathCorrelationIds(entry, 'turn-1', ['cid-a', 42, null, '', 'cid-b']);
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a', 'cid-b']));

    const entry2 = makeEntry();
    mergeFastPathCorrelationIds(entry2, 'turn-1', [42, null, '']);
    expect(entry2.fastPathCorrelationIdByTurn.has('turn-1')).toBe(false);
  });

  // Codex diff-review cycle 4 (E2) — the return-value contract the rollback
  // mechanism depends on: the CALLER needs to know exactly which ids THIS
  // call newly inserted, so a later rollback never touches an id that was
  // already legitimately present.
  describe('[E2] return value — the set of NEWLY inserted ids', () => {
    test('a brand-new turn: the return value equals everything passed in', () => {
      const entry = makeEntry();
      const inserted = mergeFastPathCorrelationIds(entry, 'turn-1', ['cid-a', 'cid-b']);
      expect(inserted).toEqual(new Set(['cid-a', 'cid-b']));
    });

    test('merging into an existing Set: the return value contains ONLY the ids that were not already present', () => {
      const entry = makeEntry(new Map([['turn-1', new Set(['cid-existing'])]]));
      const inserted = mergeFastPathCorrelationIds(entry, 'turn-1', ['cid-existing', 'cid-new']);
      expect(inserted).toEqual(new Set(['cid-new']));
      // The pre-existing id is untouched in the Map itself.
      expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(
        new Set(['cid-existing', 'cid-new'])
      );
    });

    test('re-merging an id already present this call: the return value is empty (nothing NEW inserted)', () => {
      const entry = makeEntry(new Map([['turn-1', new Set(['cid-a'])]]));
      const inserted = mergeFastPathCorrelationIds(entry, 'turn-1', 'cid-a');
      expect(inserted.size).toBe(0);
    });

    test('every no-op path (null entry, empty turnId, empty/invalid rawCid) returns an empty Set, never undefined', () => {
      expect(mergeFastPathCorrelationIds(null, 'turn-1', 'cid-a')).toEqual(new Set());
      expect(mergeFastPathCorrelationIds(undefined, 'turn-1', 'cid-a')).toEqual(new Set());
      const entry = makeEntry();
      expect(mergeFastPathCorrelationIds(entry, null, 'cid-a')).toEqual(new Set());
      expect(mergeFastPathCorrelationIds(entry, 'turn-1', null)).toEqual(new Set());
      expect(mergeFastPathCorrelationIds(entry, 'turn-1', [42, null, ''])).toEqual(new Set());
    });
  });
});

// Codex diff-review cycle 4 (E2) — the rollback counterpart.
describe('unmergeFastPathCorrelationIds (unit level)', () => {
  function makeEntry(seed) {
    return { fastPathCorrelationIdByTurn: seed ?? new Map() };
  }

  test('removes only the specified ids, leaving siblings untouched', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-a', 'cid-b', 'cid-c'])]]));
    unmergeFastPathCorrelationIds(entry, 'turn-1', new Set(['cid-b']));
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a', 'cid-c']));
  });

  test('accepts an array of ids to remove, not just a Set', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-a', 'cid-b', 'cid-c'])]]));
    unmergeFastPathCorrelationIds(entry, 'turn-1', ['cid-a', 'cid-c']);
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-b']));
  });

  test('removing the LAST id for a turn deletes the Map entry entirely, matching a turn that never had any correlation ids', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-a'])]]));
    unmergeFastPathCorrelationIds(entry, 'turn-1', new Set(['cid-a']));
    expect(entry.fastPathCorrelationIdByTurn.has('turn-1')).toBe(false);
  });

  test('a different turnId is completely unaffected', () => {
    const entry = makeEntry(
      new Map([
        ['turn-1', new Set(['cid-a'])],
        ['turn-2', new Set(['cid-b'])],
      ])
    );
    unmergeFastPathCorrelationIds(entry, 'turn-1', new Set(['cid-a']));
    expect(entry.fastPathCorrelationIdByTurn.get('turn-2')).toEqual(new Set(['cid-b']));
  });

  test('removing an id NOT present is a no-op — never throws, never touches siblings', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-a'])]]));
    expect(() =>
      unmergeFastPathCorrelationIds(entry, 'turn-1', new Set(['cid-never-there']))
    ).not.toThrow();
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-a']));
  });

  test('every malformed-input path is a silent no-op — never throws', () => {
    expect(() => unmergeFastPathCorrelationIds(null, 'turn-1', new Set(['x']))).not.toThrow();
    expect(() => unmergeFastPathCorrelationIds(undefined, 'turn-1', new Set(['x']))).not.toThrow();
    const entry = makeEntry();
    expect(() => unmergeFastPathCorrelationIds(entry, null, new Set(['x']))).not.toThrow();
    expect(() => unmergeFastPathCorrelationIds(entry, 'turn-1', null)).not.toThrow();
    expect(() => unmergeFastPathCorrelationIds(entry, 'turn-1', undefined)).not.toThrow();
    // turnId not present in the Map at all.
    expect(() =>
      unmergeFastPathCorrelationIds(entry, 'turn-never-seeded', new Set(['x']))
    ).not.toThrow();
  });

  // The end-to-end contract E2 relies on: merge's own return value fed
  // straight into unmerge exactly undoes what that ONE call added, even when
  // an earlier call already seeded a sibling id onto the same turn.
  test('round-trip with mergeFastPathCorrelationIds: unmerging the returned newly-inserted set restores the pre-call state exactly', () => {
    const entry = makeEntry(new Map([['turn-1', new Set(['cid-earlier'])]]));
    const inserted = mergeFastPathCorrelationIds(entry, 'turn-1', ['cid-new-1', 'cid-new-2']);
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(
      new Set(['cid-earlier', 'cid-new-1', 'cid-new-2'])
    );
    unmergeFastPathCorrelationIds(entry, 'turn-1', inserted);
    expect(entry.fastPathCorrelationIdByTurn.get('turn-1')).toEqual(new Set(['cid-earlier']));
  });
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
    // Codex diff-review cycle 4 (E3) — `correction` now also rides along
    // (null here — the raw re-dictated value "24" needed no clamping).
    expect(dup).toEqual({
      field: 'rcd_time_ms',
      circuit: 2,
      value: '24',
      boardId: 'main',
      correction: null,
    });
    // Unchanged — never mutated.
    expect(session.stateSnapshot.circuits[2]).toEqual({ rcd_time_ms: '24' });
  });

  // Codex diff-review cycle 4 (E3) — the return-value fix under test: a raw
  // re-dictated value that needed clamping to MATCH the stored value (e.g.
  // "16" clamping to the stored "1.6") now surfaces that correction on the
  // return value instead of silently discarding it.
  test('exact match where the RAW re-dictated value needed clamping to match the stored value — correction is surfaced', () => {
    const session = makeSession({ 4: { r1_r2_ohm: '1.6' } });
    const dup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'r1_r2_ohm', circuit: 4, value: '16' },
    });
    expect(dup).toEqual({
      field: 'r1_r2_ohm',
      circuit: 4,
      value: '1.6',
      boardId: 'main',
      correction: expect.objectContaining({ original: '16', corrected: '1.6' }),
    });
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
    expect(mainDup).toEqual({
      field: 'rcd_time_ms',
      circuit: 2,
      value: '24',
      boardId: 'main',
      correction: null,
    });
    // Re-dictating sub-1's OWN value ("99") while sub-1 is the CURRENT board
    // matches sub-1's own stored value, not main's "24".
    session.stateSnapshot.currentBoardId = 'sub-1';
    const subDup = findExactDuplicateAgainstSnapshot({
      session,
      tuple: { slotField: 'rcd_trip_time', circuit: 2, value: '99' },
    });
    expect(subDup).toEqual({
      field: 'rcd_time_ms',
      circuit: 2,
      value: '99',
      boardId: 'sub-1',
      correction: null,
    });
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

  // Codex diff-review cycle 3 (D2, 2026-08-13) — the committed 'pending'
  // fallback confirmation used to drop the clamp-correction clause entirely
  // (fastClamp.correction was computed at the fast-tts route but never
  // threaded into commitAcceptedIdentity's stored fields), and the M4
  // coalescing group key grouped by slot+canonical-value only, so two
  // attempts with the SAME final value but DIFFERENT correction provenance
  // could wrongly coalesce into one spoken outcome.
  describe('Codex diff-review D2 — committed pending fallback carries the clamp correction, and correction provenance is part of the coalescing identity', () => {
    test('a COMMITTED ("pending") identity whose raw value needed a clamp correction — the pending fallback speaks the correction clause (fast clip streamed, no playback-start ACK)', async () => {
      fastIdentity.markFastAttemptPending('cid-pending-clamp', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '16',
      });
      // Committed (the fast route's first onAudio byte ran, so
      // canonicalValue/comparisonText/correction are all set) — but NEVER
      // markFastAttemptPlaybackStarted, so the state stays 'pending': the
      // clip streamed but iOS never ACKed playback-start.
      fastIdentity.commitAcceptedIdentity('cid-pending-clamp', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '1.6',
        comparisonText: 'Circuit 4, R1 plus R2 recorded as 1.6',
        correction: { original: '16', corrected: '1.6' },
      });

      const session = makeSession({});
      const opts = baseOpts({ regexFastCorrelationId: 'cid-pending-clamp' });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      expect(confs).toHaveLength(1);
      // Pre-D2 fix, this fallback would have spoken only "Already got that —
      // Circuit 4, R1 plus R2 recorded as 1.6" — silently dropping the
      // safety-relevant "— I corrected 16 to 1.6" clause the ORIGINAL fast
      // clip's own audio (voice-latency-fast-tts.js's `text`) included.
      expect(confs[0].text).toBe(
        'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
      );
      expect(confs[0]).toMatchObject({
        field: 'r1_r2_ohm',
        circuit: 4,
        fast_correlation_id: 'cid-pending-clamp',
      });
    });

    test('two committed attempts landing on the SAME final value via DIFFERENT correction provenance do NOT coalesce — both are spoken', async () => {
      // Attempt 1: raw 16 -> clamped 1.6 (a genuine clamp correction).
      fastIdentity.markFastAttemptPending('cid-corrected', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '16',
      });
      fastIdentity.commitAcceptedIdentity('cid-corrected', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '1.6',
        comparisonText: 'Circuit 4, R1 plus R2 recorded as 1.6',
        correction: { original: '16', corrected: '1.6' },
      });
      // Attempt 2: raw 1.6 -> 1.6, no correction needed — same final value,
      // different provenance (a genuinely different dictation that happens
      // to land on the identical stored number).
      fastIdentity.markFastAttemptPending('cid-uncorrected', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '1.6',
      });
      fastIdentity.commitAcceptedIdentity('cid-uncorrected', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'r1_r2_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '1.6',
        // No correction — buildConfirmationText renders WITHOUT the
        // "recorded as" / correction phrasing when options.correction is
        // absent (matches what the fast-tts route would have actually
        // rendered for an uncorrected candidate).
        comparisonText: 'Circuit 4, R1 plus R2 1.6',
        correction: null,
      });

      const session = makeSession({});
      const opts = baseOpts({
        regexFastCorrelationId: ['cid-corrected', 'cid-uncorrected'],
      });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      // Pre-D2 fix, the coalescing group key was slot+value only —
      // both attempts share field=r1_r2_ohm, circuit=4, boardId=null,
      // value='1.6', so they would have wrongly coalesced into ONE spoken
      // confirmation (arbitrarily picking one attempt's shape), silently
      // dropping the other correlation's own accounting entirely.
      expect(confs).toHaveLength(2);
      const corrected = confs.find((c) => c.fast_correlation_id === 'cid-corrected');
      const uncorrected = confs.find((c) => c.fast_correlation_id === 'cid-uncorrected');
      expect(corrected).toBeDefined();
      expect(uncorrected).toBeDefined();
      expect(corrected.text).toBe(
        'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
      );
      expect(uncorrected.text).toBe('Already got that — Circuit 4, R1 plus R2 1.6');
    });
  });

  // Codex diff-review cycle 2 (C2, 2026-08-13) — the MIXED-state bug: a
  // `failed` correlation (or one whose HTTP POST never reached the backend
  // at all, so no ledger record exists yet — the WS-transcript-before-HTTP-
  // POST race) used to contribute NO entry. If ANY sibling correlation in
  // the same turn WAS represented (e.g. a suppress), the caller treated the
  // whole turn as "handled" and never fell through to the ordinary
  // duplicate/apology check for the OMITTED correlation's own reading —
  // that reading went completely silent, worse than before Plan B existed.
  describe('Codex diff-review C2 — mixed fast-ledger states never silently drop a sibling reading', () => {
    test('one playback_started + one with NO ledger record at all (WS-before-HTTP race): the played one produces no confirmation AND the unrecorded one is SILENTLY accounted for (D3 — the underlying fast-TTS POST may still be in flight, so NO generic apology fires)', async () => {
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
      // 'cid-unrecorded' is NEVER marked pending/failed/committed at all —
      // simulates the transcript-carried correlation set naming a
      // correlationId before the fast-tts route's own
      // markFastAttemptPending has run server-side.

      // Empty session state → the transcript can never reparse to an exact
      // duplicate, so 'cid-unrecorded' has NOTHING to fall back to except
      // the (now-suppressed, per D3) ordinary orphan-prompt path.
      const session = makeSession({});
      const opts = baseOpts({ regexFastCorrelationId: ['cid-played', 'cid-unrecorded'] });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      // The played correlation produced no "Already got" confirmation of
      // its own.
      const alreadyGotConfs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      expect(alreadyGotConfs).toHaveLength(0);
      // Codex diff-review cycle 3 D3 — the unrecorded correlation's own
      // fast-TTS HTTP POST may still be in flight and could still stream
      // its audio moments later; speaking the generic apology now risks a
      // confusing SECOND, uncoordinated message once that clip lands. A
      // fully silent turn is the safer failure mode (never a placeholder,
      // never a generic apology either, when something concrete might
      // still be coming) — so NO orphan prompt fires at all here, unlike
      // pre-D3 behaviour.
      const orphanPrompt = (result.confirmations ?? []).find((c) =>
        /(catch|repeat|say it)/i.test(c.text || '')
      );
      expect(orphanPrompt).toBeUndefined();
      expect(result.confirmations ?? []).toHaveLength(0);
      const ledgerRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.orphan_duplicate_or_pending_outcome'
      );
      expect(ledgerRow).toBeDefined();
      expect(ledgerRow[1].confirmationCount).toBe(0);
      // The generic orphan-prompt row must NOT fire — D3 suppresses it.
      const orphanRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.orphan_prompt_emitted'
      );
      expect(orphanRow).toBeUndefined();
      // A distinct suppression row proves the branch was reached
      // deliberately, not just skipped by accident.
      const suppressedRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.fast_ledger_unaddressed_failure_suppressed'
      );
      expect(suppressedRow).toBeDefined();
    });

    // Codex diff-review cycle 3 D3 — control case. When NO correlation was
    // attempted for the turn at all (fastPathCorrelationIdByTurn empty),
    // the ordinary/generic orphan prompt must fire EXACTLY as before — the
    // suppression above is scoped to "a fast dispatch was genuinely
    // attempted", not to every zero-tool-call turn.
    test('D3 control — no correlation attempted at all this turn → the ordinary orphan prompt still fires unchanged', async () => {
      const session = makeSession({});
      const opts = baseOpts();
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const orphanPrompt = (result.confirmations ?? []).find((c) =>
        /(catch|repeat|say it)/i.test(c.text || '')
      );
      expect(orphanPrompt).toBeDefined();
      const orphanRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.orphan_prompt_emitted'
      );
      expect(orphanRow).toBeDefined();
      const suppressedRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.fast_ledger_unaddressed_failure_suppressed'
      );
      expect(suppressedRow).toBeUndefined();
    });

    test("one pending+committed + one failed: the pending one gets its correlation-stamped fallback AND the failed one's own reading is silently accounted for (D3 — no generic apology, no exactDuplicateTuple to match)", async () => {
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
      fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-failed');

      // Empty session state → no exactDuplicateTuple match for the failed
      // correlation's own reading.
      const session = makeSession({});
      const opts = baseOpts({ regexFastCorrelationId: ['cid-pending', 'cid-failed'] });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      // The pending correlation still gets its stamped "Already got"
      // fallback — unaffected by the sibling failure.
      const alreadyGotConfs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      expect(alreadyGotConfs).toHaveLength(1);
      expect(alreadyGotConfs[0]).toMatchObject({
        field: 'measured_zs_ohm',
        circuit: 4,
        fast_correlation_id: 'cid-pending',
      });
      // Codex diff-review cycle 3 D3 — the failed correlation's own reading
      // is accounted for SILENTLY, not via the ordinary orphan prompt: its
      // fast-TTS HTTP POST may still be in flight (the fact this ledger
      // state landed as 'failed' rather than never-attempted is exactly
      // the case D3 covers), and speaking a generic apology risks an
      // uncoordinated second message if that clip lands moments later.
      const orphanPrompt = (result.confirmations ?? []).find((c) =>
        /(catch|repeat|say it)/i.test(c.text || '')
      );
      expect(orphanPrompt).toBeUndefined();
      expect(result.confirmations).toHaveLength(1);
      const suppressedRow = opts.logger.info.mock.calls.find(
        ([ev]) => ev === 'stage6.fast_ledger_unaddressed_failure_suppressed'
      );
      expect(suppressedRow).toBeDefined();
    });

    test('one pending+committed + one failed, but the transcript DOES reparse to an exact duplicate of stored data: the failed one\'s reading gets the ordinary UNSTAMPED "Already got" (not a second apology)', async () => {
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
      fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-failed');

      // Seed a stored value the transcript's re-parse WILL exactly match —
      // this is the "falls through to the ordinary duplicate check" branch
      // succeeding rather than degrading to the generic apology.
      const session = makeSession({ 2: { rcd_time_ms: '24' } });
      const opts = baseOpts({ regexFastCorrelationId: ['cid-pending', 'cid-failed'] });
      const result = await runShadowHarness(
        session,
        'RCD trip time for circuit 2 is 24 ms',
        [],
        opts
      );

      const alreadyGotConfs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      // TWO distinct "Already got" lines: the pending fallback (stamped,
      // measured_zs_ohm) and the failed correlation's own reading resolved
      // via the exact-duplicate tuple (unstamped, rcd_time_ms) — never
      // coalesced into one another since they're genuinely different
      // readings, and no generic apology fires since the failed reading WAS
      // accounted for.
      expect(alreadyGotConfs).toHaveLength(2);
      const stamped = alreadyGotConfs.find((c) => c.fast_correlation_id === 'cid-pending');
      const unstamped = alreadyGotConfs.find((c) => c.fast_correlation_id === undefined);
      expect(stamped).toMatchObject({ field: 'measured_zs_ohm', circuit: 4 });
      expect(unstamped).toMatchObject({ field: 'rcd_time_ms', circuit: 2 });
      expect(unstamped.dedupe_token).toBe(`duplicate_${SESSION_ID}-turn-1`);
      const orphanPrompt = (result.confirmations ?? []).find((c) =>
        /(catch|repeat|say it)/i.test(c.text || '')
      );
      expect(orphanPrompt).toBeUndefined();
    });
  });

  // Codex diff-review cycle 2 (C3, 2026-08-13) — board-scope consistency
  // across the fast-ledger fallback paths. Both gaps below stem from the
  // SAME root cause: a fast-ledger identity's `boardId` was carried
  // through un-resolved (raw wire value, possibly null) instead of being
  // resolved via the SAME (explicit → currentBoardId → main) formula the
  // rest of the codebase uses for a scope-less action's effective board —
  // so a committed and a not-yet-committed retry of the IDENTICAL
  // single-board reading could resolve to DIFFERENT board identities and
  // fail to coalesce, or resolve to the WRONG board entirely on a
  // sub-board session.
  describe('Codex diff-review C3 — board-scope consistency in the fast-ledger fallback paths', () => {
    test('a committed ("pending") identity with a null boardId resolves through the CURRENT board, not main, on a sub-board session', async () => {
      fastIdentity.markFastAttemptPending('cid-subboard', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '0.62',
      });
      // Simulates an accepted identity committed with a null boardId (e.g.
      // an older record from before the route-side C3 fix) — the harness's
      // OWN resolution must still land on the CURRENT board as a
      // defense-in-depth, not just rely on the route having resolved it.
      fastIdentity.commitAcceptedIdentity('cid-subboard', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '0.62',
        comparisonText: 'Circuit 4, Zs 0.62',
      });

      const session = makeSession({});
      session.stateSnapshot.boards = [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub' },
      ];
      session.stateSnapshot.currentBoardId = 'sub-1';
      const opts = baseOpts({ regexFastCorrelationId: 'cid-subboard' });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      expect(confs).toHaveLength(1);
      // Resolved to sub-1, the CURRENT board — not main, and not omitted
      // (main is the only board_id value that's OMITTED from the wire).
      expect(confs[0].board_id).toBe('sub-1');
    });

    test('a mixed committed+uncommitted retry pair for the IDENTICAL single-board reading coalesce into ONE confirmation with the SAME resolved board identity', async () => {
      // 'cid-committed' has ALREADY reached commitAcceptedIdentity with a
      // null boardId (unresolved at commit time).
      fastIdentity.markFastAttemptPending('cid-committed', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '0.62',
      });
      fastIdentity.commitAcceptedIdentity('cid-committed', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '0.62',
        comparisonText: 'Circuit 4, Zs 0.62',
      });
      // 'cid-uncommitted' is a RETRY for the identical reading — pending
      // mark only, never committed (the fast route's first onAudio byte
      // hasn't fired for THIS correlation yet).
      fastIdentity.markFastAttemptPending('cid-uncommitted', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '0.62',
      });

      const session = makeSession({});
      session.stateSnapshot.boards = [
        { id: 'main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub' },
      ];
      session.stateSnapshot.currentBoardId = 'sub-1';
      const opts = baseOpts({
        regexFastCorrelationId: ['cid-committed', 'cid-uncommitted'],
      });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      // Pre-C3: 'cid-committed' would resolve to boardId null → main
      // (omitted board_id on the wire) while 'cid-uncommitted' would
      // resolve to raw null (also omitted) — coincidentally the SAME on a
      // legacy single-board session, which is exactly why this bug hid
      // until a sub-board session exposed it. Both must resolve to the
      // SAME 'sub-1' identity here and coalesce into exactly ONE line.
      expect(confs).toHaveLength(1);
      expect(confs[0].board_id).toBe('sub-1');
      expect(['cid-committed', 'cid-uncommitted']).toContain(confs[0].fast_correlation_id);
    });
  });

  // Codex diff-review cycle 2 (C4, 2026-08-13) — the plan calls out this
  // literal race: "the HTTP fast request and the WS transcript are
  // concurrent" (fast-path-accepted-identity.js's own module doc comment).
  // `entry.fastPathCorrelationIdByTurn` is seeded from the WS transcript at
  // the TOP of `runLiveMode`, BEFORE the tool loop runs; `commitAcceptedIdentity`
  // fires from the independent HTTP POST handler whenever ITS OWN first
  // audio byte streams — there is no guaranteed order between the two
  // relative to each other, only relative to the FIXED consumption point
  // (`resolveFastAttemptSlotIdentities`/`resolveFastLedgerOutcomeForTurn`,
  // both called "IMMEDIATELY BEFORE" bundling). Both orderings must resolve
  // identically as long as the commit lands before that fixed point.
  describe('Codex diff-review C4 — HTTP-first vs WS-first ordering resolves identically', () => {
    test('HTTP-first: commitAcceptedIdentity completes BEFORE the WS transcript (and therefore the correlationId) ever reaches the harness', async () => {
      // The fast-TTS route's onAudio callback has ALREADY committed the
      // identity by the time the WS transcript carrying the SAME
      // correlationId is processed — this is the ordering every OTHER test
      // in this file already exercises implicitly (commit always runs
      // before `runShadowHarness` is called), named explicitly here as the
      // HTTP-first leg of the C4 contract.
      fastIdentity.markFastAttemptPending('cid-http-first', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '0.62',
      });
      fastIdentity.commitAcceptedIdentity('cid-http-first', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        canonicalValue: '0.62',
        comparisonText: 'Circuit 4, Zs 0.62',
      });

      // ONLY NOW does the WS transcript "arrive" — runShadowHarness seeds
      // `entry.fastPathCorrelationIdByTurn` from `regexFastCorrelationId`
      // at turn entry, well after the commit above already landed.
      const session = makeSession({});
      const opts = baseOpts({ regexFastCorrelationId: 'cid-http-first' });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      expect(confs).toHaveLength(1);
      expect(confs[0]).toMatchObject({
        field: 'measured_zs_ohm',
        circuit: 4,
        fast_correlation_id: 'cid-http-first',
      });
    });

    test('WS-first: the correlationId is seeded from the WS transcript BEFORE commitAcceptedIdentity fires (commit races in DURING the tool-loop window)', async () => {
      // Only `markFastAttemptPending` has run before the turn starts — the
      // fast route's own onAudio commit has NOT fired yet. The WS
      // transcript reaches the harness (seeding
      // `entry.fastPathCorrelationIdByTurn`) and the tool loop begins
      // BEFORE the commit lands.
      fastIdentity.markFastAttemptPending('cid-ws-first', {
        sessionId: SESSION_ID,
        turnId: 'irrelevant',
        field: 'measured_zs_ohm',
        circuit: 4,
        boardId: null,
        rawValue: '0.62',
      });

      // Simulates the HTTP fast-tts route's onAudio callback landing MID-turn
      // — during the "Sonnet round-trip" window the module doc comment
      // describes — by committing the identity from inside the mocked tool
      // loop, which runs strictly AFTER `entry.fastPathCorrelationIdByTurn`
      // was already seeded (runLiveMode seeds it before invoking runToolLoop)
      // but strictly BEFORE `resolveFastAttemptSlotIdentities`/
      // `resolveFastLedgerOutcomeForTurn` are called (both resolved
      // "immediately before bundling", i.e. after the tool loop resolves).
      runToolLoopSpy.mockImplementationOnce(async () => {
        fastIdentity.commitAcceptedIdentity('cid-ws-first', {
          sessionId: SESSION_ID,
          turnId: 'irrelevant',
          field: 'measured_zs_ohm',
          circuit: 4,
          boardId: null,
          canonicalValue: '0.62',
          comparisonText: 'Circuit 4, Zs 0.62',
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

      const session = makeSession({});
      const opts = baseOpts({ regexFastCorrelationId: 'cid-ws-first' });
      const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

      const confs = (result.confirmations ?? []).filter((c) =>
        /^Already got that —/.test(c.text || '')
      );
      // Identical outcome to the HTTP-first ordering above — the resolved
      // identity is exactly as complete either way, since both orderings
      // land before the fixed resolveFastLedgerOutcomeForTurn consumption
      // point.
      expect(confs).toHaveLength(1);
      expect(confs[0]).toMatchObject({
        field: 'measured_zs_ohm',
        circuit: 4,
        fast_correlation_id: 'cid-ws-first',
      });
    });
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

// Codex diff-review cycle 4 (E1) — B3's `playback_started`-only "no second
// line" outcome and D3's `hadUnaddressedFailure` silence branch both
// deliberately produce a turn with zero confirmations, for a reason that is
// NOT "nothing happened". Without a turn-scoped exemption, the pre-existing
// marker-② catch-all net (stage6-shadow-harness.js, gated on
// `chimeObserved`) sees "zero confirmations this turn" and stacks its own
// generic apology on top — defeating the whole point of the suppression
// (a duplicate "already heard it" apology on top of a fast clip the
// inspector already heard, or a confusing apology ahead of audio still in
// flight). None of the tests above set `chimeObserved: true`, which is
// exactly why this regression shipped through three full review cycles
// unnoticed — marker-② never even evaluates without it.
describe('Codex diff-review cycle 4 (E1) — B3/D3 deliberate silence exempts marker-② catch-all', () => {
  test('(a) playback_started-only outcome ("no second line") + chimeObserved:true → NO catch-all apology stacks on top', async () => {
    fastIdentity.markFastAttemptPending('cid-e1-played', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '0.62',
    });
    fastIdentity.commitAcceptedIdentity('cid-e1-played', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'measured_zs_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '0.62',
      comparisonText: 'Circuit 4, Zs 0.62',
    });
    fastIdentity.markFastAttemptPlaybackStarted(SESSION_ID, 'cid-e1-played');

    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-e1-played', chimeObserved: true });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    // Pre-E1-fix this turn would have carried the pre-existing zero-
    // confirmation outcome PLUS a stacked generic apology.
    expect(result.confirmations ?? []).toHaveLength(0);
    const catchall = (result.confirmations ?? []).filter((c) =>
      CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
    );
    expect(catchall).toHaveLength(0);
    const catchallRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
    );
    expect(catchallRow).toBeUndefined();
  });

  test('(b) D3 silence branch (correlation attempted, resolves to nothing usable) + chimeObserved:true → NO catch-all apology stacks either, D3 silence preserved', async () => {
    fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-e1-failed');
    // Empty session + a phrase that reparses to no tuple (same fixture the
    // C2/D3 tests above use) — exactDuplicateTuple stays null, so the
    // failed correlation has nothing to fall back on and
    // hadUnaddressedFailure resolves true.
    const session = makeSession({});
    const opts = baseOpts({ regexFastCorrelationId: 'cid-e1-failed', chimeObserved: true });
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);

    expect(result.confirmations ?? []).toHaveLength(0);
    const catchall = (result.confirmations ?? []).filter((c) =>
      CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
    );
    expect(catchall).toHaveLength(0);
    const catchallRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
    );
    expect(catchallRow).toBeUndefined();
    // D3's own suppression row still fires — proving this specific branch
    // (not some accidental other exemption) is what kept the turn silent.
    const d3Row = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.fast_ledger_unaddressed_failure_suppressed'
    );
    expect(d3Row).toBeDefined();
  });

  test('(c) control: a genuinely empty/broken turn with NO fast-ledger involvement at all + chimeObserved:true → the ordinary marker-② apology STILL fires', async () => {
    // Proves the E1 exemption is scoped to B3/D3's own deliberate-silence
    // branches and does not accidentally silence marker-② for its ORIGINAL
    // purpose. Mirrors stage6-catchall-audibility-net.test.js's (a) fixture:
    // a tool ran, didn't error, but emitted nothing audible — the class
    // marker-② exists to catch.
    runToolLoopSpy.mockImplementationOnce(async () => ({
      stop_reason: 'end_turn',
      rounds: 2,
      tool_calls: [
        {
          tool_call_id: 'toolu_e1control',
          name: 'calculate_zs',
          input: { circuit_ref: 4, all: false },
          result: {
            tool_use_id: 'toolu_e1control',
            is_error: false,
            content: JSON.stringify({
              ok: true,
              computed: [],
              skipped: [{ circuit_ref: 4, reason: 'no_r1_r2' }],
            }),
          },
        },
      ],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession({ 4: { circuit_designation: 'Sockets' } });
    const opts = baseOpts({ chimeObserved: true }); // no regexFastCorrelationId at all
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], opts);

    const catchall = (result.confirmations ?? []).filter((c) =>
      CATCHALL_AUDIBILITY_PROMPTS.includes(c.text)
    );
    expect(catchall).toHaveLength(1);
    const catchallRow = opts.logger.info.mock.calls.find(
      ([ev]) => ev === 'stage6.catchall_audibility_fallback_emitted'
    );
    expect(catchallRow).toBeDefined();
  });
});

// Codex diff-review cycle 4 (E3) — B3.2's `findExactDuplicateAgainstSnapshot`
// now surfaces its clamp correction on the return value (tested directly
// above), but that value has to actually REACH the spoken text at BOTH
// downstream consumers: the no-fast-attempt branch (a) and the
// 'failed'/'pending_unrecorded' ledger-outcome fallback (b) — the same bug
// class D2 already fixed for the OTHER (committed-pending) fallback path,
// just missed here. Exercised via `resolveZeroToolCallDuplicateOutcome`
// directly (already exported, unit-testable) rather than the full harness —
// R1+R2 has no single-complete-reading dialogue-schema trigger phrase this
// suite could drive end-to-end, and the two functions under test
// (`resolveOutcomeIdentityForCoalescing`'s exactDuplicateTuple fallback,
// `buildFastLedgerFallbackConfirmation`'s 'failed' branch) are both reached
// identically either way.
describe('Codex diff-review cycle 4 (E3) — the clamp correction reaches BOTH exactDuplicateTuple-derived confirmation paths', () => {
  const CORRECTION = { original: '16', corrected: '1.6' };
  const correctedTuple = (boardId = 'main') => ({
    field: 'r1_r2_ohm',
    circuit: 4,
    value: '1.6',
    boardId,
    correction: CORRECTION,
  });

  test('(a) no-fast-attempt exact duplicate of a clamp-corrected value — the "Already got" text includes the correction clause', () => {
    const session = makeSession({ 4: { r1_r2_ohm: '1.6' } });
    const outcome = resolveZeroToolCallDuplicateOutcome({
      session,
      turnId: 'turn-e3-a',
      correlationIds: null, // no fast dispatch attempted this turn at all
      exactDuplicateTuple: correctedTuple(),
    });
    expect(outcome.kind).toBe('confirmations');
    expect(outcome.confirmations).toHaveLength(1);
    expect(outcome.confirmations[0].text).toBe(
      'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
    );
    expect(outcome.confirmations[0].fast_correlation_id).toBeUndefined();
    expect(outcome.confirmations[0].dedupe_token).toBe('duplicate_turn-e3-a');
  });

  test('(b) failed-ledger-outcome exact duplicate of the same shape — the "Already got" text also includes the correction clause', () => {
    fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-e3-failed');
    const session = makeSession({ 4: { r1_r2_ohm: '1.6' } });
    const outcome = resolveZeroToolCallDuplicateOutcome({
      session,
      turnId: 'turn-e3-b',
      correlationIds: new Set(['cid-e3-failed']),
      exactDuplicateTuple: correctedTuple(),
    });
    expect(outcome.kind).toBe('confirmations');
    expect(outcome.confirmations).toHaveLength(1);
    // Pre-E3-fix this would have been "Already got that — Circuit 4, R1
    // plus R2 recorded as 1.6" with NO correction clause — silently
    // implying the raw "16" the inspector re-dictated is what got recorded.
    expect(outcome.confirmations[0].text).toBe(
      'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
    );
    // C2 — deliberately UNSTAMPED: a 'failed' correlation is definitively
    // dead, so this is the ordinary exact-duplicate re-speak, not a
    // ledger-tracked fallback.
    expect(outcome.confirmations[0].fast_correlation_id).toBeUndefined();
    expect(outcome.confirmations[0].dedupe_token).toBe('duplicate_turn-e3-b');
  });

  // Coalescing test (M4): a committed 'pending' correlation and a 'failed'
  // correlation whose only identity comes from the SAME exactDuplicateTuple
  // now resolve to the IDENTICAL (field, circuit, boardId, value,
  // correction) group key — read D2's own tests above for what "coalesce"
  // means in this module: ONE spoken confirmation for the group, sourced
  // from the preferred ('pending') representative, with the 'failed'
  // sibling contributing nothing of its own (not a second line). Pre-E3-fix
  // the 'failed' side's hardcoded `correction: null` would have produced a
  // DIFFERENT group key (missing the correctionKeyPart), so this exact pair
  // would have wrongly stayed un-coalesced and spoken TWICE.
  test('a "pending"+committed correlation and a "failed" exact-duplicate resolving to the IDENTICAL (field, circuit, boardId, value, correction) coalesce into ONE confirmation', () => {
    fastIdentity.markFastAttemptPending('cid-e3-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'r1_r2_ohm',
      circuit: 4,
      boardId: null,
      rawValue: '16',
    });
    fastIdentity.commitAcceptedIdentity('cid-e3-pending', {
      sessionId: SESSION_ID,
      turnId: 'irrelevant',
      field: 'r1_r2_ohm',
      circuit: 4,
      boardId: null,
      canonicalValue: '1.6',
      comparisonText: 'Circuit 4, R1 plus R2 recorded as 1.6',
      correction: CORRECTION,
    });
    fastIdentity.markFastAttemptFailed(SESSION_ID, 'cid-e3-failed-2');

    const session = makeSession({ 4: { r1_r2_ohm: '1.6' } });
    const outcome = resolveZeroToolCallDuplicateOutcome({
      session,
      turnId: 'turn-e3-c',
      correlationIds: new Set(['cid-e3-pending', 'cid-e3-failed-2']),
      exactDuplicateTuple: correctedTuple(),
    });
    expect(outcome.confirmations).toHaveLength(1);
    expect(outcome.confirmations[0].text).toBe(
      'Already got that — Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6'
    );
    // The 'pending' member is the group's representative (STAMPED,
    // carries fast_correlation_id) — the 'failed' sibling produced no
    // confirmation of its own, but critically it did not SPLIT the group
    // into two spoken lines either.
    expect(outcome.confirmations[0].fast_correlation_id).toBe('cid-e3-pending');
  });
});
