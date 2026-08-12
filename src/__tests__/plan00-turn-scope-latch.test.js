/**
 * Plan 00B-3 C2 — the turn-scope enter/exit latch at BOTH out-of-try anchors.
 *
 * WHAT the fix is. `enterTurnScope` now returns a CLOSED success token
 * (literal `true`) and only after the scope is genuinely installed; each of
 * its call sites moved INSIDE its try/finally bracket and latches "I own this
 * scope" from that token, never from "the call didn't throw".
 *
 * WHY the token has to exist. In production the mutation observer is wrapped
 * by `guardEvidenceRole` (plan00-session-manifest.js), whose whole job is to
 * SWALLOW a throwing evidence role so the inspector's audible turn survives.
 * It returns `undefined` on a caught failure. Before this fix `enterTurnScope`
 * also returned `undefined` on SUCCESS, so a refused enter and a successful
 * one were byte-identical at the call site — and `openTurnId` cannot break the
 * tie either, because a rejected SAME-id re-entry leaves the open turn id
 * equal to the one that was just requested. A call site that exited
 * unconditionally would therefore call `exitTurnScope()` after a REFUSED
 * enter and CLEAR A CONCURRENT TURN'S SCOPE — closing one evidence hole by
 * opening someone else's.
 *
 * The plan names five cases and requires them at BOTH anchors:
 *   (1) a raw successful enter        — token truthy, latch set, scope closed
 *   (2) a guarded failure against a DIFFERENT open turn id
 *                                     — token falsy, latch unset, the other
 *                                       scope survives untouched
 *   (3) a guarded SAME-id re-entry rejection
 *                                     — token falsy; the case `openTurnId`
 *                                       cannot see
 *   (4) a downstream throw after a successful entry
 *                                     — always closes its OWN scope
 *   (5) no evaluation context at all   — production behaviour byte-identical
 *
 * Anchor A is `runShadowHarness` (stage6-shadow-harness.js), driven directly
 * with `toolCallsMode: 'off'` so the dispatch reduces to one
 * `session.extractFromUtterance` call — the smallest honest seam.
 *
 * Anchor B is the sonnet-stream Tier-2 dialogue region, driven through the
 * REAL captured WS listener (the harness `plan00-tier2-seams.test.js`
 * established) with the three dialogue-script wrappers stubbed inert, so the
 * region's enter/finally is exercised without dragging the real engine in.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE the dynamic imports below.
// ---------------------------------------------------------------------------

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockSessionInstances = [];

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.utteranceBuffer = [];
    this.stateSnapshot = { boards: [], circuits: [], currentBoardId: null, observations: [] };
    this.costTracker = {
      toCostUpdate: () => ({ type: 'cost_update', cost: 0 }),
      inFlightBillableInvocationCount: 0,
      usageRevision: 0,
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.extractFromUtterance = jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions_for_user: [],
    }));
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
    mockSessionInstances.push(this);
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

// The three dialogue-script wrappers are stubbed INERT so the Tier-2 region's
// scope bracket is exercised without the real engine. Case (4) swaps the ring
// wrapper's implementation for a thrower — the only controllable way to raise
// from INSIDE that try.
const ringWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const irWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const pdWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const noopDialogue = () => ({ handled: false, fallthrough: false });
const stubSchema = (name) => ({ name });
jest.unstable_mockModule('../extraction/dialogue-engine/index.js', () => ({
  processDialogueTurn: noopDialogue,
  enterScriptByName: noopDialogue,
  tryResumePausedScript: noopDialogue,
  tryEnterScriptFromWrites: noopDialogue,
  ringContinuitySchema: stubSchema('ring_continuity'),
  insulationResistanceSchema: stubSchema('insulation_resistance'),
  ocpdSchema: stubSchema('ocpd'),
  rcdSchema: stubSchema('rcd'),
  rcboSchema: stubSchema('rcbo'),
  ALL_DIALOGUE_SCHEMAS: [
    stubSchema('ring_continuity'),
    stubSchema('insulation_resistance'),
    stubSchema('rcbo'),
    stubSchema('ocpd'),
    stubSchema('rcd'),
  ],
  ALL_DIALOGUE_SCHEMA_NAMES: ['insulation_resistance', 'ocpd', 'rcbo', 'rcd', 'ring_continuity'],
  processRingContinuityTurn: ringWrapperSpy,
  processInsulationResistanceTurn: irWrapperSpy,
  processProtectiveDeviceTurn: pdWrapperSpy,
  valuesCanonicallyEqual: (slot, a, b) => a === b || String(a) === String(b),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { EVALUATION_CONTEXT } = await import('../extraction/plan00-lifecycle-hooks.js');
const { createAskLedger, createDeliveryLedger } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { createMutationObserver, attachMutationObserver } =
  await import('../extraction/plan00-semantic-capture.js');
const { guardEvidenceRole } = await import('../extraction/plan00-session-manifest.js');
const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A transparent delegating wrapper around the REAL mutation observer that
 * counts enter/exit traffic. The counters are the only way to tell "the latch
 * was never set" from "the latch was set and the scope re-closed" — both leave
 * `openTurnId` null.
 */
function countingObserver(real, opts = {}) {
  const calls = { enter: [], exit: 0 };
  let seeded = false;
  const wrapper = {
    _real: real,
    _calls: calls,
    enterTurnScope(turnId) {
      calls.enter.push(turnId);
      // `seedSameIdHolder` reproduces case (3) FAITHFULLY rather than by
      // simulation: before the anchor's own enter is let through, a
      // CONCURRENT holder takes the scope under the SAME id via the real
      // implementation. The anchor's enter then hits the real re-entry
      // throw, and `openTurnId` ends up equal to the id it just asked for —
      // indistinguishable from success to any latch keyed on the id.
      if (opts.seedSameIdHolder && !seeded) {
        seeded = true;
        real.enterTurnScope(turnId);
      }
      return real.enterTurnScope(turnId);
    },
    exitTurnScope() {
      calls.exit += 1;
      return real.exitTurnScope();
    },
    get openTurnId() {
      return real.openTurnId;
    },
    get invalid() {
      return real.invalid;
    },
  };
  // Everything else delegates verbatim (bindFastCorrelation, setOriginFrame,
  // emitMutationCommit, markInvalid, …) so the observer stays contract-complete.
  return new Proxy(wrapper, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      const value = real[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Anchor A — runShadowHarness (stage6-shadow-harness.js)
// ---------------------------------------------------------------------------

describe('Plan 00B-3 C2 — anchor A: runShadowHarness turn-scope latch', () => {
  function makeSession() {
    return {
      sessionId: 'sess-anchor-a',
      toolCallsMode: 'off',
      costTracker: { recordInspectorExtractionTurn: jest.fn() },
      extractFromUtterance: jest.fn(async () => ({
        extracted_readings: [],
        observations: [],
        questions_for_user: [],
      })),
    };
  }

  test('(1) a RAW successful enter returns the token, latches, and closes its own scope', async () => {
    const real = createMutationObserver({ sessionId: 'sess-anchor-a' });
    const observer = countingObserver(real);
    const session = makeSession();
    attachMutationObserver(session, observer);

    // The token itself is the contract — assert it directly, not just its
    // consequence, so a future change that returns a truthy non-`true` value
    // (which the `=== true` latch would reject) fails here.
    expect(real.enterTurnScope('probe-token')).toBe(true);
    real.exitTurnScope();

    const out = await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-a1',
    });

    expect(out).toBeTruthy();
    expect(session.extractFromUtterance).toHaveBeenCalledTimes(1);
    expect(observer._calls.enter).toEqual(['turn-a1']);
    expect(observer._calls.exit).toBe(1);
    expect(real.openTurnId).toBeNull();
  });

  test('(2) a GUARDED failure against a DIFFERENT open turn id leaves that scope untouched', async () => {
    const real = createMutationObserver({ sessionId: 'sess-anchor-a' });
    const counted = countingObserver(real);
    const session = makeSession();
    // Production shape: the observer reaching the call site is the guard proxy,
    // which swallows the re-entry throw and returns undefined.
    attachMutationObserver(session, guardEvidenceRole(counted, 'mutation'));

    // A concurrent turn already owns the scope under a DIFFERENT id.
    real.enterTurnScope('turn-concurrent');

    await expect(
      runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], { extractionTurnId: 'turn-a2' })
    ).resolves.toBeTruthy();

    // The refusal must not have been mistaken for ownership: no exit ran, and
    // the concurrent turn still holds its scope.
    expect(counted._calls.exit).toBe(0);
    expect(real.openTurnId).toBe('turn-concurrent');
  });

  test('(3) a GUARDED SAME-id re-entry rejection — the case openTurnId cannot see', async () => {
    const real = createMutationObserver({ sessionId: 'sess-anchor-a' });
    const counted = countingObserver(real, { seedSameIdHolder: true });
    const session = makeSession();
    attachMutationObserver(session, guardEvidenceRole(counted, 'mutation'));

    await expect(
      runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], { extractionTurnId: 'turn-a3' })
    ).resolves.toBeTruthy();

    // `openTurnId` now EQUALS the requested id, so an id-keyed latch would read
    // this refusal as a successful entry. The token latch does not: no exit.
    expect(real.openTurnId).toBe('turn-a3');
    expect(counted._calls.exit).toBe(0);
    expect(real.invalid?.reason).toBe('turn_scope_reentered');
    expect(real.invalid?.detail?.open_turn_id).toBe(real.invalid?.detail?.requested_turn_id);
  });

  test('(4) a downstream throw after a successful entry still closes its OWN scope', async () => {
    const real = createMutationObserver({ sessionId: 'sess-anchor-a' });
    const observer = countingObserver(real);
    const session = makeSession();
    session.extractFromUtterance = jest.fn(async () => {
      throw new Error('dispatch exploded');
    });
    attachMutationObserver(session, observer);

    await expect(
      runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], { extractionTurnId: 'turn-a4' })
    ).rejects.toThrow('dispatch exploded');

    expect(observer._calls.exit).toBe(1);
    expect(real.openTurnId).toBeNull();
  });

  test('(5) with NO evaluation context the dispatch behaves byte-identically', async () => {
    const session = makeSession();
    const out = await runShadowHarness(session, 'Zs on circuit 4 is 0.41.', [], {
      extractionTurnId: 'turn-a5',
    });

    expect(out).toEqual({ extracted_readings: [], observations: [], questions_for_user: [] });
    expect(session.extractFromUtterance).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Anchor B — the sonnet-stream Tier-2 dialogue region, through the REAL listener
// ---------------------------------------------------------------------------

describe('Plan 00B-3 C2 — anchor B: sonnet-stream Tier-2 turn-scope latch', () => {
  const getKey = async () => 'fake-anthropic-key';
  const verifyToken = jest.fn();

  function makeFakeWs() {
    const sent = [];
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: jest.fn((payload) => {
        sent.push(JSON.parse(payload));
      }),
      ping: jest.fn(),
      close: jest.fn(),
      on: jest.fn(),
      _handlers: new Map(),
    };
    ws.on.mockImplementation((event, handler) => {
      ws._handlers.set(event, handler);
    });
    ws._sent = sent;
    ws._emit = async (event, data) => {
      const h = ws._handlers.get(event);
      if (!h) throw new Error(`No handler registered for ${event}`);
      await h(data);
    };
    return ws;
  }

  function connect(wss, userId = 'user-1') {
    const ws = makeFakeWs();
    wss.emit('connection', ws, { headers: {} }, userId);
    return ws;
  }

  async function sendFrame(ws, frame) {
    await ws._emit('message', Buffer.from(JSON.stringify(frame)));
  }

  /**
   * Boot a live session whose evaluation context carries `mutationObserver`.
   * Returns the raw observer, the counting wrapper, and the ws.
   */
  async function bootSession(sessionId, { guarded = false, seedSameIdHolder = false } = {}) {
    const real = createMutationObserver({ sessionId });
    const counted = countingObserver(real, { seedSameIdHolder });
    const roles = {
      observer: null,
      mutationObserver: guarded ? guardEvidenceRole(counted, 'mutation') : counted,
      askLedger: createAskLedger(),
      deliveryLedger: createDeliveryLedger(),
    };
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => roles,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId, jobState: {} });
    expect(activeSessions.get(sessionId)[EVALUATION_CONTEXT]).toBeTruthy();
    return { real, counted, ws };
  }

  let utteranceCounter = 0;
  function transcriptFrame(sessionId, text) {
    utteranceCounter += 1;
    return {
      type: 'transcript',
      sessionId,
      text,
      is_final: true,
      utterance_id: `utt-${utteranceCounter}`,
    };
  }

  beforeEach(() => {
    mockSessionInstances.length = 0;
    mockSessionStart.mockClear();
    mockSessionStop.mockClear();
    ringWrapperSpy.mockClear();
    ringWrapperSpy.mockImplementation(() => ({ handled: false, fallthrough: false }));
    activeSessions.clear();
    sonnetSessionStore.clear();
    utteranceCounter = 0;
  });

  afterEach(() => {
    activeSessions.clear();
    sonnetSessionStore.clear();
    jest.useRealTimers();
  });

  test('(1) a RAW successful enter latches and every entered scope re-closes', async () => {
    const { real, counted, ws } = await bootSession('sess-anchor-b1');

    await sendFrame(ws, transcriptFrame('sess-anchor-b1', 'Ring continuity for circuit 4.'));

    // The Tier-2 region entered (and, once it fell through, runShadowHarness
    // entered its own harness scope on the SAME observer — see
    // sonnet-stream.js attachMutationObserver). Every successful enter is
    // paired with exactly one exit and nothing is left open.
    expect(counted._calls.enter.length).toBeGreaterThanOrEqual(1);
    expect(counted._calls.exit).toBe(counted._calls.enter.length);
    expect(real.openTurnId).toBeNull();
    expect(ringWrapperSpy).toHaveBeenCalledTimes(1);
  });

  test('(2) a GUARDED failure against a DIFFERENT open turn id leaves that scope untouched', async () => {
    const { real, counted, ws } = await bootSession('sess-anchor-b2', { guarded: true });

    real.enterTurnScope('utt-other-turn');
    await sendFrame(ws, transcriptFrame('sess-anchor-b2', 'Ring continuity for circuit 4.'));

    expect(counted._calls.enter.length).toBeGreaterThanOrEqual(1);
    expect(counted._calls.exit).toBe(0);
    expect(real.openTurnId).toBe('utt-other-turn');
  });

  test('(3) a GUARDED SAME-id re-entry rejection never clears the concurrent holder', async () => {
    const { real, counted, ws } = await bootSession('sess-anchor-b3', {
      guarded: true,
      seedSameIdHolder: true,
    });

    await sendFrame(ws, transcriptFrame('sess-anchor-b3', 'Ring continuity for circuit 4.'));

    // The concurrent holder took the scope under the very id the region then
    // requested — `openTurnId` reads back as the requested id, and only the
    // token latch keeps the region from exiting a scope it never entered.
    expect(real.openTurnId).toBe(counted._calls.enter[0]);
    expect(counted._calls.exit).toBe(0);
    expect(real.invalid?.reason).toBe('turn_scope_reentered');
  });

  test('(4) a throw from INSIDE the region still closes the scope it opened', async () => {
    const { real, counted, ws } = await bootSession('sess-anchor-b4');
    ringWrapperSpy.mockImplementation(() => {
      throw new Error('ring script exploded');
    });

    // The listener owns its own error handling; what matters here is that the
    // region's finally ran on the throwing path.
    await sendFrame(ws, transcriptFrame('sess-anchor-b4', 'Ring continuity for circuit 4.')).catch(
      () => {}
    );

    expect(counted._calls.enter.length).toBeGreaterThanOrEqual(1);
    expect(counted._calls.exit).toBe(counted._calls.enter.length);
    expect(real.openTurnId).toBeNull();
  });

  test('(5) with NO evaluation context the region is inert and the turn proceeds', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken, {});
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-anchor-b5', jobState: {} });
    expect(activeSessions.get('sess-anchor-b5')[EVALUATION_CONTEXT] ?? null).toBeNull();

    await sendFrame(ws, transcriptFrame('sess-anchor-b5', 'Ring continuity for circuit 4.'));

    expect(ringWrapperSpy).toHaveBeenCalledTimes(1);
    expect(mockSessionInstances[0].extractFromUtterance).toHaveBeenCalled();
  });
});
