/**
 * Codex diff-review F4 (2026-08-13) — B3.2's read-only exact-duplicate CHECK
 * must run regardless of `IR_ORPHAN_APPLY_COMPLETE` (the OLDER, unrelated
 * #5a apply-complete mutation-fallback flag). The plan never makes B3
 * conditional on that flag — only the WRITE (`applyOrphanRecoveredReading`)
 * is gated by it, and only in the non-allRejected branch. This is a separate
 * file because `ORPHAN_APPLY_COMPLETE_ENABLED` is a module-load constant —
 * the env var must be set BEFORE the harness module is imported (same
 * pattern as stage6-honest-refusal-orphan-off.test.js for
 * VOICE_ORPHAN_PROMPT).
 */

import { jest } from '@jest/globals';

process.env.IR_ORPHAN_APPLY_COMPLETE = 'false';

const SESSION_ID = 'sess-fastpath-dup-flag-off';

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

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

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
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('B3.2 exact-duplicate check under IR_ORPHAN_APPLY_COMPLETE=false', () => {
  test('non-allRejected, zero-tool-call, exact duplicate transcript → "Already got" STILL fires (the duplicate check is not flag-gated)', async () => {
    const session = makeSession({ 2: { rcd_time_ms: '24' } });
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      baseOpts()
    );
    const dupConfs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(dupConfs).toHaveLength(1);
    expect(dupConfs[0]).toMatchObject({ field: 'rcd_time_ms', circuit: 2 });
    // No write — B3.2 is read-only, and the flag being off means the WRITE
    // path (applyOrphanRecoveredReading) never even gets a chance to run
    // for this tuple (it's a duplicate, not a fresh reading).
    expect(session.stateSnapshot.circuits[2].rcd_time_ms).toBe('24');
    expect(result.extracted_readings ?? []).toHaveLength(0);
    expect(session.orphanContext == null).toBe(true);
  });

  test('non-allRejected, zero-tool-call, NON-duplicate reparse tuple → flag off means no recovery write (falls through to the ordinary orphan prompt)', async () => {
    const session = makeSession({});
    const result = await runShadowHarness(
      session,
      'RCD trip time for circuit 2 is 24 ms',
      [],
      baseOpts()
    );
    const dupConfs = (result.confirmations ?? []).filter((c) =>
      /^Already got that —/.test(c.text || '')
    );
    expect(dupConfs).toHaveLength(0);
    // Flag off + not a duplicate → the write never happens, so the ordinary
    // orphan prompt (carriesValue path, since the transcript has a digit)
    // is what speaks — mirrors byte-identical pre-Plan-B flag-off behaviour.
    expect(result.extracted_readings ?? []).toHaveLength(0);
    const orphanPrompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(orphanPrompt).toBeDefined();
  });
});
