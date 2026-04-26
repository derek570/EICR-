/**
 * Tests for stage6-shadow-harness — Phase 3 Plan 03-07 wiring.
 *
 * WHAT THIS FILE COVERS (distinct from stage6-shadow-harness.test.js):
 *   - Phase 3 dispatcher composition: createWriteDispatcher +
 *     createAskDispatcher → createToolDispatcher wiring inside runShadowHarness.
 *   - sortRecords passthrough: createSortRecordsAsksLast() threaded to
 *     runToolLoop so STA-02 "writes before asks" ordering fires at the
 *     harness call-site.
 *   - Null-pendingAsks fallback (Phase 2 back-compat during rollout):
 *     runShadowHarness called WITHOUT pendingAsks still works — write-only
 *     dispatcher, no ask composition, identity sortRecords. This is the
 *     behaviour the existing 02-06 test suite depends on and Plan 03-08
 *     will remove the fallback later once all call-sites thread the
 *     per-session registry.
 *   - Env-flag gating preserved: mode='off' short-circuits BEFORE dispatcher
 *     construction; mode='live' still throws (Phase 7 guard).
 *
 * WHY A SEPARATE FILE (not appended to stage6-shadow-harness.test.js):
 * The existing file uses static `import { runShadowHarness } from ...` and
 * its tests assert on the real composition. Phase 3 wiring asserts are
 * cleanest with `jest.unstable_mockModule` factory spies — which under
 * --experimental-vm-modules must run BEFORE any static import of the
 * target. Mixing both styles in one file would either force the existing
 * Phase 2 tests into dynamic imports (noisy diff) or make the spies
 * useless against the pre-bound symbols. One file per mock-strategy keeps
 * both suites green and diffable.
 *
 * Corresponds to Plan 03-07 task 1 (RED) / task 2 (GREEN). Pairs with
 * stage6-shadow-harness.test.js which remains the authoritative Phase 2
 * contract suite.
 */

import { jest } from '@jest/globals';

import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// ESM factory spies — must be registered BEFORE importing runShadowHarness.
// ---------------------------------------------------------------------------

const writeSentinel = Object.assign(
  async () => ({ tool_use_id: 'w', content: '{}', is_error: false }),
  { __tag: 'writes' }
);
const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const composedSentinel = Object.assign(
  async () => ({ tool_use_id: 'c', content: '{}', is_error: false }),
  { __tag: 'composed' }
);
const sortSentinel = Object.assign((records) => records, { __tag: 'sort' });

const createWriteDispatcherSpy = jest.fn(() => writeSentinel);
const createAskDispatcherSpy = jest.fn(() => askSentinel);
const createToolDispatcherSpy = jest.fn(() => composedSentinel);
const createSortRecordsAsksLastSpy = jest.fn(() => sortSentinel);

// The real runToolLoop is replaced by a spy so we can inspect the {dispatcher,
// sortRecords} args the harness forwards to it. Returns the minimal shape the
// bundler + comparator expect downstream.
const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
}));

// Keep real bundler + comparator — we only care about dispatcher wiring,
// not log projection. Real modules supply the expected shape downstream.
jest.unstable_mockModule('../extraction/stage6-dispatchers.js', () => ({
  createWriteDispatcher: createWriteDispatcherSpy,
  createToolDispatcher: createToolDispatcherSpy,
  createSortRecordsAsksLast: createSortRecordsAsksLastSpy,
  // WRITE_DISPATCHERS unused by harness; stub for any transitive import safety.
  WRITE_DISPATCHERS: {},
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

// Dynamic import AFTER mocks are registered.
const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function endTurnStreamEvents(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function makeSession(
  mode,
  legacyResult = { extracted_readings: [], observations: [], questions: [] }
) {
  return {
    sessionId: 'sess-phase3',
    turnCount: 0,
    toolCallsMode: mode,
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([endTurnStreamEvents('ok')]),
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    // Plan 04-11 r5-#1 — stub must implement buildSystemBlocks() post-fix.
    // Same semantics as the sibling stub in stage6-shadow-harness.test.js.
    _snapshot: null,
    buildSystemBlocks() {
      const base = {
        type: 'text',
        text: this.systemPrompt,
        cache_control: { type: 'ephemeral', ttl: '5m' },
      };
      if (this.toolCallsMode === 'off') return [base];
      if (!this._snapshot) return [base];
      return [
        base,
        {
          type: 'text',
          text: this._snapshot,
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ];
    },
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      this.turnCount = (this.turnCount ?? 0) + 1;
      return legacyResult;
    }),
  };
}

// Minimal duck-typed pendingAsks stand-in. Phase 3 plan 03-07 specifies the
// harness ONLY reads/writes via the ask dispatcher it constructs — it never
// calls .register / .resolve / .rejectAll directly. So a bare object with
// observable identity is sufficient here; the spy asserts identity passthrough.
function makePendingAsks() {
  return { __tag: 'pending-asks-registry', size: 0, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

beforeEach(() => {
  createWriteDispatcherSpy.mockClear();
  createAskDispatcherSpy.mockClear();
  createToolDispatcherSpy.mockClear();
  createSortRecordsAsksLastSpy.mockClear();
  runToolLoopSpy.mockClear();
  runToolLoopSpy.mockImplementation(async () => ({
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: [],
    aborted: false,
    messages_final: [],
  }));
});

// ---------------------------------------------------------------------------
// Group A — Composition when pendingAsks provided
// ---------------------------------------------------------------------------

describe('Phase 3 — tool dispatcher composition (pendingAsks provided)', () => {
  test('createAskDispatcher called with (session, logger, turnId, pendingAsks, ws)', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(s, 'text', [], { logger, pendingAsks, ws });

    expect(createAskDispatcherSpy).toHaveBeenCalledTimes(1);
    const [sessionArg, loggerArg, turnIdArg, pendingArg, wsArg] =
      createAskDispatcherSpy.mock.calls[0];
    // Harness passes its shadowSession clone (NOT the live session) — assert
    // shape equivalence (sessionId shared for log correlation) instead of
    // identity, matching Phase 2 BLOCK#1 clone behaviour.
    expect(sessionArg.sessionId).toBe('sess-phase3');
    expect(loggerArg).toBe(logger);
    expect(turnIdArg).toBe('sess-phase3-turn-1');
    expect(pendingArg).toBe(pendingAsks);
    expect(wsArg).toBe(ws);
  });

  test('createToolDispatcher called with (writes, asks) from the two factories', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks: makePendingAsks(),
      ws: makeWs(),
    });

    expect(createToolDispatcherSpy).toHaveBeenCalledTimes(1);
    const [writesArg, asksArg] = createToolDispatcherSpy.mock.calls[0];
    expect(writesArg).toBe(writeSentinel);
    expect(asksArg).toBe(askSentinel);
  });

  test('runToolLoop receives the composed dispatcher (not the writes dispatcher)', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks: makePendingAsks(),
      ws: makeWs(),
    });

    expect(runToolLoopSpy).toHaveBeenCalledTimes(1);
    const loopArgs = runToolLoopSpy.mock.calls[0][0];
    expect(loopArgs.dispatcher).toBe(composedSentinel);
    expect(loopArgs.dispatcher).not.toBe(writeSentinel);
  });

  test('runToolLoop receives sortRecords = createSortRecordsAsksLast() output', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks: makePendingAsks(),
      ws: makeWs(),
    });

    expect(createSortRecordsAsksLastSpy).toHaveBeenCalledTimes(1);
    const loopArgs = runToolLoopSpy.mock.calls[0][0];
    expect(typeof loopArgs.sortRecords).toBe('function');
    expect(loopArgs.sortRecords).toBe(sortSentinel);
  });
});

// ---------------------------------------------------------------------------
// Group B — Null-pendingAsks fallback (Phase 2 rollout back-compat)
// ---------------------------------------------------------------------------

describe('Phase 3 — null pendingAsks fallback', () => {
  test('omitted pendingAsks: writes-only dispatcher, no ask composition, identity sortRecords', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');

    await runShadowHarness(s, 'text', [], { logger });

    expect(createWriteDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(createAskDispatcherSpy).not.toHaveBeenCalled();
    expect(createToolDispatcherSpy).not.toHaveBeenCalled();
    expect(createSortRecordsAsksLastSpy).not.toHaveBeenCalled();

    const loopArgs = runToolLoopSpy.mock.calls[0][0];
    expect(loopArgs.dispatcher).toBe(writeSentinel);
    expect(loopArgs.sortRecords).toBeUndefined();
  });

  test('explicit pendingAsks=null: same fallback, no throw', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');

    await expect(
      runShadowHarness(s, 'text', [], { logger, pendingAsks: null, ws: null })
    ).resolves.toBeDefined();

    expect(createAskDispatcherSpy).not.toHaveBeenCalled();
    expect(createToolDispatcherSpy).not.toHaveBeenCalled();
    const loopArgs = runToolLoopSpy.mock.calls[0][0];
    expect(loopArgs.dispatcher).toBe(writeSentinel);
    expect(loopArgs.sortRecords).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group C — Env-flag gating preserved
// ---------------------------------------------------------------------------

describe('Phase 3 — env-flag gating preserved', () => {
  test("mode='off' short-circuits BEFORE dispatcher construction; pendingAsks untouched", async () => {
    const logger = makeLogger();
    const s = makeSession('off', { passthrough: true });
    const pendingAsks = makePendingAsks();
    // Mutate to a known marker BEFORE the call; assert untouched after.
    pendingAsks.size = 0;

    const result = await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks,
      ws: makeWs(),
    });

    expect(result).toEqual({ passthrough: true });
    expect(s.extractFromUtterance).toHaveBeenCalledTimes(1);
    expect(createWriteDispatcherSpy).not.toHaveBeenCalled();
    expect(createAskDispatcherSpy).not.toHaveBeenCalled();
    expect(createToolDispatcherSpy).not.toHaveBeenCalled();
    expect(createSortRecordsAsksLastSpy).not.toHaveBeenCalled();
    expect(runToolLoopSpy).not.toHaveBeenCalled();
    // pendingAsks marker unchanged — harness never touched it.
    expect(pendingAsks.size).toBe(0);
  });

  test("mode='live' constructs dispatchers and runs tool loop (no legacy fallback)", async () => {
    // 2026-04-26 (Bug-B pivot): live mode runs the agentic tool loop directly.
    // Dispatchers ARE constructed and the tool loop IS invoked; legacy is not.
    const logger = makeLogger();
    const s = makeSession('live');

    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks: makePendingAsks(),
      ws: makeWs(),
    });

    expect(createWriteDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(createAskDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(createToolDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(runToolLoopSpy).toHaveBeenCalledTimes(1);
    // Legacy never called.
    expect(s.extractFromUtterance).not.toHaveBeenCalled();
  });
});
