/**
 * Stage 6 Phase 5 Plan 05-07 r1-#3 — runShadowHarness threads mode='shadow'
 * into the ask-gate-wrapper composition.
 *
 * WHAT: Mocks `stage6-ask-gate-wrapper.js` with factory spies, then drives
 * runShadowHarness through the Phase 5 composition branch (askBudget +
 * restrainedMode threaded through opts). Asserts BOTH createAskGateWrapper
 * and wrapAskDispatcherWithGates received `mode: 'shadow'`.
 *
 * WHY: r1-#3 surfaced that synthResultWrapped hard-coded mode='live' inside
 * the wrapper, so runShadowHarness's wrapper-emitted log rows mis-tagged
 * shadow asks as live — Phase 8 dashboards split by mode and that split
 * was therefore corrupted. The fix threads mode through both wrapper
 * factory functions; this test pins the production wiring (the wrapper's
 * own unit tests cover the synthResultWrapped behaviour itself).
 *
 * WHY a separate file (not appended to stage6-shadow-harness.phase3.test.js):
 * that file uses jest.unstable_mockModule to mock dispatchers + tool-loop;
 * adding a wrapper mock to the same file collides with the existing
 * dispatcher mocks (the harness composes them BOTH and the wrapper takes
 * an inner dispatcher arg). Cleanest separation — this file mocks ONLY
 * the wrapper module.
 */

import { jest } from '@jest/globals';

import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// ESM factory spies — must be registered BEFORE importing runShadowHarness.
// ---------------------------------------------------------------------------

const gateSentinel = {
  __tag: 'gate-sentinel',
  gateOrFire: jest.fn(),
  destroy: jest.fn(),
};
const wrappedSentinel = Object.assign(
  async () => ({ tool_use_id: 'wr', content: '{}', is_error: false }),
  { __tag: 'wrapped-sentinel' }
);

const createAskGateWrapperSpy = jest.fn(() => gateSentinel);
const wrapAskDispatcherWithGatesSpy = jest.fn(() => wrappedSentinel);
const deriveAskKeySpy = jest.fn(() => '_:_'); // Plan 05-03 imports this; keep stub safe

jest.unstable_mockModule('../extraction/stage6-ask-gate-wrapper.js', () => ({
  createAskGateWrapper: createAskGateWrapperSpy,
  wrapAskDispatcherWithGates: wrapAskDispatcherWithGatesSpy,
  deriveAskKey: deriveAskKeySpy,
}));

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

function makeSession() {
  return {
    sessionId: 'sess-r1-3',
    turnCount: 0,
    toolCallsMode: 'shadow',
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

function makeAskBudget() {
  return {
    isExhausted: jest.fn(() => false),
    increment: jest.fn(),
    getCount: jest.fn(() => 0),
  };
}

function makeRestrainedMode() {
  return {
    isActive: jest.fn(() => false),
    recordAsk: jest.fn(),
    activate: jest.fn(),
    destroy: jest.fn(),
  };
}

beforeEach(() => {
  createAskGateWrapperSpy.mockClear();
  wrapAskDispatcherWithGatesSpy.mockClear();
  gateSentinel.gateOrFire.mockClear?.();
  gateSentinel.destroy.mockClear?.();
});

// ---------------------------------------------------------------------------
// Group — Plan 05-07 r1-#3
// ---------------------------------------------------------------------------

describe("Plan 05-07 r1-#3 — runShadowHarness threads mode='shadow' into wrapper composition", () => {
  test("createAskGateWrapper opts include mode:'shadow' when called from shadow harness", async () => {
    const logger = makeLogger();
    const s = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();
    const askBudget = makeAskBudget();
    const restrainedMode = makeRestrainedMode();

    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks,
      ws,
      askBudget,
      restrainedMode,
    });

    expect(createAskGateWrapperSpy).toHaveBeenCalledTimes(1);
    const opts = createAskGateWrapperSpy.mock.calls[0][0];
    expect(opts.mode).toBe('shadow');
    // Sanity — sessionId carries through
    expect(opts.sessionId).toBe('sess-r1-3');
  });

  test("wrapAskDispatcherWithGates opts include mode:'shadow' when called from shadow harness", async () => {
    const logger = makeLogger();
    const s = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();
    const askBudget = makeAskBudget();
    const restrainedMode = makeRestrainedMode();

    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks,
      ws,
      askBudget,
      restrainedMode,
    });

    expect(wrapAskDispatcherWithGatesSpy).toHaveBeenCalledTimes(1);
    const opts = wrapAskDispatcherWithGatesSpy.mock.calls[0][1];
    expect(opts.mode).toBe('shadow');
    // Sanity — wrapper composition still receives every Phase 5 gate handle
    expect(opts.askBudget).toBe(askBudget);
    expect(opts.restrainedMode).toBe(restrainedMode);
    expect(opts.sessionId).toBe('sess-r1-3');
  });

  test('wrapper composition is skipped when askBudget/restrainedMode are absent (Phase 3/4 back-compat)', async () => {
    // Existing Phase 3/4 callers thread pendingAsks + ws but NOT askBudget /
    // restrainedMode. The wrapper composition branch must stay gated on
    // BOTH gates being present so those callers' behaviour is unchanged.
    const logger = makeLogger();
    const s = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(s, 'text', [], {
      logger,
      pendingAsks,
      ws,
      // No askBudget, no restrainedMode — wrapper must NOT compose.
    });

    expect(createAskGateWrapperSpy).not.toHaveBeenCalled();
    expect(wrapAskDispatcherWithGatesSpy).not.toHaveBeenCalled();
  });
});
