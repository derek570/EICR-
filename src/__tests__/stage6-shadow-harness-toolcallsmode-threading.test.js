/**
 * Stage 6 Phase 6 Plan 06-06 r5-#3 (MINOR) — runShadowHarness must thread
 * the input session's `toolCallsMode` through to the cloned `shadowSession`
 * (rather than pinning 'shadow').
 *
 * WHY:
 * Plan 06-02 r1-#1 added a `fallbackToLegacy` gate INSIDE
 * createAskDispatcher's LIVE path (stage6-dispatcher-ask.js:341-348). The
 * dispatcher branches on `session.toolCallsMode === 'shadow'` at line 233
 * and short-circuits BEFORE the gate runs. Pre-fix, `runShadowHarness`
 * pinned `toolCallsMode: 'shadow'` on the cloned session
 * (stage6-shadow-harness.js:260) so the dispatcher's shadow short-circuit
 * always fired through the harness — the live + fallbackToLegacy path was
 * unreachable through the harness. Tests at the harness layer were
 * therefore proving an impossible state.
 *
 * Production was always correct (sonnet-stream.js calls the harness with
 * the real activeSessions session whose toolCallsMode reflects env mode),
 * but Phase 7 cutover will start exercising live mode through this harness
 * — locking the integration in tests now prevents regressions slipping
 * through future plans.
 *
 * Test approach:
 *   - The harness throws on session.toolCallsMode==='live' at line 147
 *     (Phase 1 guard preserved through Phase 6). End-to-end live mode
 *     through the harness is a Phase 7 surface.
 *   - To test the structural fix WITHOUT lifting the Phase 1 guard, the
 *     fix extracts the cloned-shadowSession construction into an exported
 *     helper `buildShadowSessionForDispatcher(session, preLegacySnapshot,
 *     preLegacyObservations)`. The test imports the helper and asserts
 *     the cloned session's toolCallsMode reflects the input's
 *     (NOT a hard-coded literal).
 *
 * Companion: stage6-dispatcher-ask-fallback.test.js (Plan 06-02) covers
 * the dispatcher's behaviour itself when called with live + fallbackToLegacy.
 * Together this file (clone reflects input mode) + that file (dispatcher
 * honours mode + fallback) prove the integration end-to-end without
 * standing up the full harness machinery for every combination — which
 * the Phase 1 guard at line 147 currently prevents anyway.
 */

import { jest } from '@jest/globals';

import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// ESM factory spies — must be registered BEFORE importing runShadowHarness.
// ---------------------------------------------------------------------------

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

const { runShadowHarness, buildShadowSessionForDispatcher } =
  await import('../extraction/stage6-shadow-harness.js');

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

function makeSession(mode) {
  return {
    sessionId: 'sess-r5-3',
    turnCount: 0,
    toolCallsMode: mode,
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([endTurnStreamEvents('ok')]),
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    _snapshot: null,
    buildSystemBlocks() {
      return [
        {
          type: 'text',
          text: this.systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ];
    },
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      this.turnCount = (this.turnCount ?? 0) + 1;
      return { extracted_readings: [], observations: [], questions: [] };
    }),
  };
}

function makePendingAsks() {
  return { __tag: 'pending-asks-registry', size: 0, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
});

// ---------------------------------------------------------------------------
// Group H — buildShadowSessionForDispatcher: structural threading
// ---------------------------------------------------------------------------
//
// The exported helper is the structural surface this finding pins. PRE-fix
// the helper does not exist (or pins 'shadow' inside the harness body); the
// test fails at import-time. POST-fix the helper exists, accepts the input
// session's toolCallsMode, and returns a clone with that mode preserved.

describe('Plan 06-06 r5-#3 — buildShadowSessionForDispatcher reflects input toolCallsMode', () => {
  test('shadow input → cloned shadowSession.toolCallsMode === "shadow" (regression-lock)', () => {
    const session = makeSession('shadow');
    const snap = { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] };
    const obs = [];

    const clone = buildShadowSessionForDispatcher(session, snap, obs);

    expect(clone.toolCallsMode).toBe('shadow');
    expect(clone.sessionId).toBe('sess-r5-3');
    expect(clone.stateSnapshot).toBe(snap); // identity — no extra clone
    expect(clone.extractedObservations).toBe(obs);
  });

  test('live input → cloned shadowSession.toolCallsMode === "live" (Phase 7 reachability)', () => {
    // The whole point of r5-#3: the cloned session must NOT pin 'shadow'
    // when the input mode is 'live'. Once Phase 7 lifts the harness's
    // line-147 mode-guard, this assertion guarantees the dispatcher's
    // fallbackToLegacy gate is reachable through the harness.
    const session = makeSession('live');
    const snap = { circuits: {} };
    const obs = [];

    const clone = buildShadowSessionForDispatcher(session, snap, obs);

    expect(clone.toolCallsMode).toBe('live');
  });

  test('off input → cloned shadowSession.toolCallsMode === "off" (defensive — should never reach this path)', () => {
    // The harness short-circuits off-mode at line 141 before ever calling
    // the helper. But if a future refactor moved the off-mode short-circuit
    // out, the helper must still preserve the input mode rather than coerce
    // to 'shadow'. Defensive regression lock.
    const session = makeSession('off');
    const snap = { circuits: {} };
    const obs = [];

    const clone = buildShadowSessionForDispatcher(session, snap, obs);

    expect(clone.toolCallsMode).toBe('off');
  });

  test('missing toolCallsMode → cloned shadowSession.toolCallsMode defaults to "shadow"', () => {
    // The helper's default mirrors the harness's `mode = session.toolCallsMode ?? 'off'`
    // pattern at line 138 except: by the time the helper is called (only
    // for non-off non-live modes), the input is necessarily 'shadow' or an
    // unknown string. A missing input field defaults to 'shadow' for back-
    // compat (matches every Phase 2-5 caller's expectation).
    const session = { sessionId: 'sess-X' };
    const snap = { circuits: {} };
    const obs = [];

    const clone = buildShadowSessionForDispatcher(session, snap, obs);

    expect(clone.toolCallsMode).toBe('shadow');
    expect(clone.sessionId).toBe('sess-X');
  });
});

// ---------------------------------------------------------------------------
// Group H2 — runShadowHarness end-to-end: shadow input still works
// ---------------------------------------------------------------------------

describe('Plan 06-06 r5-#3 — runShadowHarness end-to-end (regression lock)', () => {
  test('shadow harness call still reaches createAskDispatcher with toolCallsMode==="shadow"', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(s, 'text', [], { logger, pendingAsks, ws });

    expect(createAskDispatcherSpy).toHaveBeenCalledTimes(1);
    const [sessionArg] = createAskDispatcherSpy.mock.calls[0];
    expect(sessionArg.toolCallsMode).toBe('shadow');
    expect(sessionArg.sessionId).toBe('sess-r5-3');
  });

  test('opts.fallbackToLegacy threading: shadow harness still passes fallbackToLegacy=true through (Phase 6 r1-#1 contract)', async () => {
    // Plan 06-02 r1-#1 — fallbackToLegacy is threaded through the harness
    // call into createAskDispatcher's 6th arg (opts). Locks that wiring.
    const logger = makeLogger();
    const s = makeSession('shadow');
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks,
      ws,
      fallbackToLegacy: true,
    });

    expect(createAskDispatcherSpy).toHaveBeenCalledTimes(1);
    const args = createAskDispatcherSpy.mock.calls[0];
    expect(args.length).toBeGreaterThanOrEqual(6);
    const opts = args[5];
    expect(opts.fallbackToLegacy).toBe(true);
  });

  test('opts.fallbackToLegacy default (omitted): cloned dispatcher opts.fallbackToLegacy === false', async () => {
    const logger = makeLogger();
    const s = makeSession('shadow');
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(s, 'text', [], { logger, pendingAsks, ws });

    expect(createAskDispatcherSpy).toHaveBeenCalledTimes(1);
    const args = createAskDispatcherSpy.mock.calls[0];
    const opts = args[5];
    expect(opts.fallbackToLegacy).toBe(false);
  });
});
