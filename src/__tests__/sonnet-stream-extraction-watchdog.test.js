/**
 * sonnet-stream-extraction-watchdog.test.js — F7 Item 3 (task #14). The
 * per-turn extraction-watchdog controller: the askChainObserved latch extends
 * the 30s no-ask deadline to the absolute ceiling; at the deadline/ceiling a
 * LIVE generation is REALLY cancelled (AbortController) and isExtracting is NOT
 * force-cleared — it stays true until the aborted invocation's generation-
 * guarded finally settles, so a concurrent extraction can never start.
 *
 * These tests mock runShadowHarness (its options carry the signal +
 * onAskRegistered) and drive the real sonnet-stream handleTranscript through a
 * fake WS + fake timers advanced by the EXPORTED constants (no literals). The
 * "does the loop actually consume the signal" proof lives in
 * stage6-tool-loop.test.js (signal-consumer suite).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId) {
    this.sessionId = sessionId;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = jest.fn();
    this.stop = jest.fn(() => ({ totals: { cost: 0 } }));
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn((m) => {
      this.toolCallsMode = m;
    });
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

const {
  initSonnetStream,
  activeSessions,
  EXTRACTION_WATCHDOG_MS,
  EXTRACTION_WATCHDOG_ABSOLUTE_MS,
} = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((p) => sent.push(JSON.parse(p))),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((e, h) => ws._handlers.set(e, h));
  ws._sent = sent;
  ws._emit = (e, d) => ws._handlers.get(e)?.(d);
  return ws;
}
function connect(wss) {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  return ws;
}
function fireFrame(ws, frame) {
  // Do NOT await — the transcript handler blocks on the (gated) mocked
  // runShadowHarness; we drive it with fake timers.
  return ws._emit('message', Buffer.from(JSON.stringify(frame)));
}
async function startLiveSession(wss, sessionId) {
  const ws = connect(wss);
  await ws._emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'session_start', sessionId, jobState: { certificateType: 'eicr' } })
    )
  );
  const entry = activeSessions.get(sessionId);
  entry.session.toolCallsMode = 'live';
  return { ws, entry };
}

let wss;
beforeEach(() => {
  loggerMock.info.mockClear();
  runShadowHarnessSpy.mockClear();
  runShadowHarnessSpy.mockImplementation(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  }));
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'key', jest.fn());
});
afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

function rowsOf(event) {
  return loggerMock.info.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

/** A runShadowHarness mock that captures opts + holds until released. */
function makeGatedHarness() {
  let capturedOpts = null;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  runShadowHarnessSpy.mockImplementation(async (_session, _text, _regex, opts) => {
    capturedOpts = opts;
    if (typeof opts?._onEnter === 'function') opts._onEnter(opts);
    await gate;
    return { extracted_readings: [], observations: [], confirmations: [] };
  });
  return {
    getOpts: () => capturedOpts,
    release: () => release(),
  };
}

describe('F7 Item 3 — extraction-watchdog controller', () => {
  test('runShadowHarness receives a live AbortSignal + onAskRegistered + generationId', async () => {
    const { ws } = await startLiveSession(wss, 'sess-wd-0');
    const h = makeGatedHarness();
    jest.useFakeTimers();
    const p = fireFrame(ws, {
      type: 'transcript',
      text: 'Zs 0.5',
      utterance_id: 'u0',
      regexResults: [],
    });
    await jest.advanceTimersByTimeAsync(0);
    const opts = h.getOpts();
    expect(opts).not.toBeNull();
    expect(opts.signal).toBeDefined();
    expect(opts.signal.aborted).toBe(false);
    expect(typeof opts.onAskRegistered).toBe('function');
    expect(typeof opts.generationId).toBe('string');
    h.release();
    await jest.advanceTimersByTimeAsync(0);
    await p;
  });

  test('(c/no-ask) a live extraction with NO ask observed is aborted at the 30s deadline; a concurrent transcript is QUEUED until it settles', async () => {
    const { ws, entry } = await startLiveSession(wss, 'sess-wd-1');
    const h = makeGatedHarness();
    jest.useFakeTimers();
    const p1 = fireFrame(ws, {
      type: 'transcript',
      text: 'Zs 0.5',
      utterance_id: 'u1',
      regexResults: [],
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(entry.isExtracting).toBe(true);

    // Advance to the no-ask deadline → the signal aborts.
    await jest.advanceTimersByTimeAsync(EXTRACTION_WATCHDOG_MS);
    expect(h.getOpts().signal.aborted).toBe(true);
    // isExtracting is NOT force-cleared — the aborted invocation still owns it.
    expect(entry.isExtracting).toBe(true);

    // A concurrent transcript is queued, NOT run.
    fireFrame(ws, { type: 'transcript', text: 'Ze 0.2', utterance_id: 'u2', regexResults: [] });
    await jest.advanceTimersByTimeAsync(0);
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);

    // The first (aborted) invocation settles → finally clears isExtracting →
    // the queued transcript now drains.
    h.release();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(0);
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(2);
    await p1;
  });

  test('(latch) an observed ask EXTENDS the deadline: held past 30s (below ceiling) is NOT aborted, and emits extraction_watchdog_extended_for_ask', async () => {
    const { ws } = await startLiveSession(wss, 'sess-wd-2');
    let capturedOpts = null;
    let release;
    const gate = new Promise((r) => (release = r));
    runShadowHarnessSpy.mockImplementation(async (_s, _t, _r, opts) => {
      capturedOpts = opts;
      opts.onAskRegistered('toolu_a'); // arm the latch
      await gate;
      return { extracted_readings: [], observations: [], confirmations: [] };
    });
    jest.useFakeTimers();
    const p = fireFrame(ws, {
      type: 'transcript',
      text: 'Zs 0.5',
      utterance_id: 'u1',
      regexResults: [],
    });
    await jest.advanceTimersByTimeAsync(0);
    // Past the 30s no-ask deadline but well below the ceiling.
    await jest.advanceTimersByTimeAsync(EXTRACTION_WATCHDOG_MS + 1000);
    expect(capturedOpts.signal.aborted).toBe(false); // extended, not aborted
    expect(rowsOf('extraction_watchdog_extended_for_ask')).toHaveLength(1);
    expect(rowsOf('extraction_watchdog_absolute_ceiling_fired')).toHaveLength(0);
    release();
    await jest.advanceTimersByTimeAsync(0);
    await p;
  });

  test('(ceiling) a latched chain wedged past the absolute ceiling is cancelled + emits extraction_watchdog_absolute_ceiling_fired', async () => {
    const { ws } = await startLiveSession(wss, 'sess-wd-3');
    let capturedOpts = null;
    let release;
    const gate = new Promise((r) => (release = r));
    runShadowHarnessSpy.mockImplementation(async (_s, _t, _r, opts) => {
      capturedOpts = opts;
      opts.onAskRegistered('toolu_a');
      await gate;
      return { extracted_readings: [], observations: [], confirmations: [] };
    });
    jest.useFakeTimers();
    const p = fireFrame(ws, {
      type: 'transcript',
      text: 'Zs 0.5',
      utterance_id: 'u1',
      regexResults: [],
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(EXTRACTION_WATCHDOG_ABSOLUTE_MS);
    expect(capturedOpts.signal.aborted).toBe(true);
    expect(rowsOf('extraction_watchdog_absolute_ceiling_fired')).toHaveLength(1);
    release();
    await jest.advanceTimersByTimeAsync(0);
    await p;
  });

  test('(late-registration) onAskRegistered after the generation released returns false', async () => {
    const { ws } = await startLiveSession(wss, 'sess-wd-4');
    let capturedOpts = null;
    runShadowHarnessSpy.mockImplementation(async (_s, _t, _r, opts) => {
      capturedOpts = opts;
      // In-turn registration is owned (true).
      expect(opts.onAskRegistered('toolu_a')).toBe(true);
      return { extracted_readings: [], observations: [], confirmations: [] };
    });
    jest.useFakeTimers();
    await fireFrame(ws, {
      type: 'transcript',
      text: 'Zs 0.5',
      utterance_id: 'u1',
      regexResults: [],
    });
    await jest.advanceTimersByTimeAsync(0);
    // After the generation settled (finally ran → released), a stale
    // registration by the old loop returns false.
    expect(capturedOpts.onAskRegistered('toolu_late')).toBe(false);
  });

  test('(a3 arithmetic) the sanctioned A4 timeline sums below the ceiling', () => {
    const eps = 1;
    const threeAsks = 3 * (45000 - eps); // ASK_USER_TIMEOUT_MS − ε, ×3
    const twoGaps = 2 * 1000; // two inter-ask empty-registry gap advances
    expect(threeAsks + twoGaps).toBeLessThan(EXTRACTION_WATCHDOG_ABSOLUTE_MS);
  });
});
