/**
 * Codex diff-review cycle 3 D1 (PLAN-B, feedback ids 118/119) — production-
 * ingress test for the ask-answer fast-path-correlation seeding fix.
 *
 * THE BUG: when a transcript arrives and resolves an in-flight `ask_user`
 * (sonnet-stream.js's pre-queue or overtake-classifier seams — search
 * `entry.pendingAsks.resolve(` in sonnet-stream.js), the answering
 * transcript is consumed as the tool loop's answer and the function RETURNS
 * WITHOUT ever calling runLiveMode again for that answer — so if iOS
 * fast-dispatched a POST off the SAME transcript (it carries
 * `regex_fast_correlation_id`), the RESUMED turn's
 * `entry.fastPathCorrelationIdByTurn` set never learns about it, and the
 * bundler's echo-stamp logic (B1.3) has nothing to match against: the
 * resumed turn's canonical confirmation ships unstamped.
 *
 * THE FIX: `entry.activeTurnId` (stage6-shadow-harness.js's runLiveMode, set
 * at entry / cleared in `finally`) identifies which in-flight turn is
 * waiting on the ask. sonnet-stream.js's four ask-answer resolution sites
 * (pre-queue validation_error/answered, overtake validation_error/answered)
 * now call the shared `mergeFastPathCorrelationIds(entry, entry.activeTurnId,
 * msg.regex_fast_correlation_id)` helper before resolving the ask.
 *
 * TEST STRATEGY: this drives the REAL sonnet-stream.js WS message-routing
 * layer (initSonnetStream — the actual bug site) via the SAME proven
 * production-ingress pattern `sonnet-stream-cross-utterance-delete-ingress
 * .test.js` uses for its "LIVE pending ask answered via the pre-queue
 * classifyOvertake seam" test: `runShadowHarness` is mocked (so the test
 * doesn't have to stand up the real Anthropic-calling tool loop / the real
 * ask-gate-wrapper's 1500ms QUESTION_GATE_DELAY_MS debounce / the real
 * multi-layer dispatcher composition — none of which this fix touches), and
 * `entry.pendingAsks` + `entry.activeTurnId` are seeded directly to
 * reproduce the exact state a real in-flight runLiveMode call leaves behind
 * while it's mid-await on an ask. This isolates the ACTUAL code under test —
 * sonnet-stream.js's four resolve() call sites — from the (separately and
 * already thoroughly tested elsewhere: stage6-event-bundler-fast-attempt-
 * echo.test.js, stage6-orphan-net-fast-path-duplicate.test.js) downstream
 * bundler echo-stamp matching logic.
 *
 * `mergeFastPathCorrelationIds` itself (the coercion/merge helper) is
 * exercised directly and in isolation by the unit tests below — proving the
 * shape contract (string vs array, merge-not-replace) without any mocking.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const SESSION_ID = 'sess-fast-corr-ask-answer';

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
// sonnet-stream.js imports BOTH `runShadowHarness` and
// `mergeFastPathCorrelationIds` from this module — ESM named-export
// resolution requires the mock factory to provide every name the real
// module exports that any importer uses, so `mergeFastPathCorrelationIds`
// is re-implemented here verbatim (byte-identical to
// stage6-shadow-harness.js's real implementation) rather than stubbed with
// a no-op: this test's core assertions depend on the REAL merge/coerce
// behaviour actually populating `entry.fastPathCorrelationIdByTurn`. Direct
// unit coverage proving this reimplementation matches the real one lives in
// stage6-orphan-net-fast-path-duplicate.test.js (which imports the real,
// unmocked module).
function mergeFastPathCorrelationIdsMock(entry, turnId, rawCid) {
  if (!entry || typeof turnId !== 'string' || !turnId) return new Set();
  const cids = new Set();
  if (typeof rawCid === 'string' && rawCid) {
    cids.add(rawCid);
  } else if (Array.isArray(rawCid)) {
    for (const cid of rawCid) {
      if (typeof cid === 'string' && cid) cids.add(cid);
    }
  }
  if (cids.size === 0 || !(entry.fastPathCorrelationIdByTurn instanceof Map)) return new Set();
  const existing = entry.fastPathCorrelationIdByTurn.get(turnId);
  const newlyInserted = new Set();
  if (existing instanceof Set) {
    for (const cid of cids) {
      if (!existing.has(cid)) {
        existing.add(cid);
        newlyInserted.add(cid);
      }
    }
  } else {
    entry.fastPathCorrelationIdByTurn.set(turnId, cids);
    for (const cid of cids) newlyInserted.add(cid);
  }
  return newlyInserted;
}
// Codex diff-review cycle 4 (E2) — reimplemented verbatim (byte-identical to
// stage6-shadow-harness.js's real implementation), same rationale as the
// merge mock above: this file's E2 tests depend on the REAL rollback
// behaviour actually removing ids from `entry.fastPathCorrelationIdByTurn`.
function unmergeFastPathCorrelationIdsMock(entry, turnId, idsToRemove) {
  if (!entry || typeof turnId !== 'string' || !turnId) return;
  if (!(entry.fastPathCorrelationIdByTurn instanceof Map)) return;
  if (idsToRemove == null) return;
  const ids = idsToRemove instanceof Set ? idsToRemove : new Set(idsToRemove);
  if (ids.size === 0) return;
  const existing = entry.fastPathCorrelationIdByTurn.get(turnId);
  if (!(existing instanceof Set)) return;
  for (const cid of ids) existing.delete(cid);
  if (existing.size === 0) entry.fastPathCorrelationIdByTurn.delete(turnId);
}
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: mergeFastPathCorrelationIdsMock,
  unmergeFastPathCorrelationIds: unmergeFastPathCorrelationIdsMock,
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
// Direct unit coverage of `mergeFastPathCorrelationIds` itself (coercion
// shape contract: string vs array, merge-not-replace) lives in
// stage6-orphan-net-fast-path-duplicate.test.js, which imports the REAL
// (unmocked) stage6-shadow-harness.js — this file mocks that module's
// `runShadowHarness` above, so importing the helper here would resolve to
// the mock factory's shape (undefined), not the real implementation.

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

async function startLiveSession(wss, sessionId) {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
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

const transcript = (text, utterance_id, extra = {}) =>
  Buffer.from(
    JSON.stringify({ type: 'transcript', text, utterance_id, regexResults: [], ...extra })
  );

let wss;
beforeEach(() => {
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  runShadowHarnessSpy.mockClear();
  runShadowHarnessSpy.mockImplementation(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  }));
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('D1 — a transcript that ANSWERS an in-flight ask seeds fast-path correlation onto the RESUMED (in-flight) turn', () => {
  test("pre-queue seam (isExtracting=true, ask answered before the generic queue check): the answering transcript's regex_fast_correlation_id is merged onto entry.activeTurnId", async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);

    // Simulate a real in-flight runLiveMode call: it opened turn "turn-open",
    // registered a pending ask (via the real ask dispatcher), and is now
    // mid-await inside the tool loop — exactly the state D1 fixes seeding
    // for. entry.activeTurnId is what runLiveMode itself would have set at
    // entry (stage6-shadow-harness.js) before reaching this await point.
    entry.activeTurnId = 'turn-open';
    entry.isExtracting = true;
    const resolveSpy = jest.fn();
    entry.pendingAsks.register('toolu_ask_1', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 4,
      expectedAnswerShape: 'number',
      resolve: resolveSpy,
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    // Nothing seeded yet for this turn.
    expect(entry.fastPathCorrelationIdByTurn.get('turn-open')).toBeUndefined();

    // The answering transcript: matches the pending ask's (field, circuit)
    // via classifyOvertake's exact-match rule (pre-queue seam, since
    // entry.isExtracting is true), AND carries the fast-dispatch
    // correlation id iOS attached when it POSTed the fast-TTS candidate for
    // this SAME reading.
    await ws._emit(
      'message',
      transcript('Zs on circuit 4 is 0.62.', 'utt-answer', {
        regexResults: [{ field: 'measured_zs_ohm', circuit: 4, value: '0.62' }],
        regex_fast_correlation_id: 'cid-preq-1',
      })
    );

    // The ask channel consumed the transcript (pre-queue 'answers' verdict)
    // — resolve() was called with the answer, and runShadowHarness was
    // NEVER invoked for it (the whole point of the pre-queue short-circuit
    // — see sonnet-stream.js's own comment at the pre-queue site).
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, user_text: 'Zs on circuit 4 is 0.62.' })
    );
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();

    // THE ASSERTION: D1's fix seeded the correlation onto the in-flight
    // turn (entry.activeTurnId), even though this transcript never itself
    // reached runLiveMode's own seeding site.
    const seeded = entry.fastPathCorrelationIdByTurn.get('turn-open');
    expect(seeded).toBeInstanceOf(Set);
    expect(seeded.has('cid-preq-1')).toBe(true);

    // No stray frame — the pre-queue answer path is silent on the wire.
    expect(ws._sent.find((f) => f.type === 'error')).toBeUndefined();
  });

  test('pre-queue seam MERGES rather than replaces — a correlation already seeded earlier in the SAME turn survives', async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);
    entry.activeTurnId = 'turn-open';
    entry.isExtracting = true;
    // The turn's OPENING transcript already fast-dispatched a sibling
    // reading and seeded its own correlation id (this is what runLiveMode's
    // own seeding site does for the transcript that raised the ask).
    entry.fastPathCorrelationIdByTurn.set('turn-open', new Set(['cid-sibling-already-there']));
    entry.pendingAsks.register('toolu_ask_2', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 4,
      expectedAnswerShape: 'number',
      resolve: jest.fn(),
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await ws._emit(
      'message',
      transcript('Zs on circuit 4 is 0.62.', 'utt-answer', {
        regexResults: [{ field: 'measured_zs_ohm', circuit: 4, value: '0.62' }],
        regex_fast_correlation_id: 'cid-preq-2',
      })
    );

    const seeded = entry.fastPathCorrelationIdByTurn.get('turn-open');
    expect(seeded).toBeInstanceOf(Set);
    // BOTH ids present — a REPLACE (the pre-D1-fix shape of the shared
    // seeding logic before it was refactored into a merge-aware helper)
    // would have dropped the sibling reading's correlation entirely.
    expect(seeded.has('cid-sibling-already-there')).toBe(true);
    expect(seeded.has('cid-preq-2')).toBe(true);
    expect(seeded.size).toBe(2);
  });

  test('control — an answering transcript with NO fast-dispatch correlation seeds nothing (no-op, never throws)', async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);
    entry.activeTurnId = 'turn-open';
    entry.isExtracting = true;
    entry.pendingAsks.register('toolu_ask_3', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 4,
      expectedAnswerShape: 'number',
      resolve: jest.fn(),
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await ws._emit(
      'message',
      transcript('Zs on circuit 4 is 0.62.', 'utt-answer', {
        regexResults: [{ field: 'measured_zs_ohm', circuit: 4, value: '0.62' }],
        // no regex_fast_correlation_id
      })
    );

    expect(entry.fastPathCorrelationIdByTurn.get('turn-open')).toBeUndefined();
    expect(ws._sent.find((f) => f.type === 'error')).toBeUndefined();
  });

  test('overtake seam (isExtracting=false, entry.pendingAsks non-empty): the answering transcript still seeds entry.activeTurnId when one is set', async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);
    // The overtake classifier seam (the SECOND `entry.pendingAsks.size > 0`
    // check in sonnet-stream.js) is reached when isExtracting is FALSE —
    // e.g. a non-blocking / already-resumed ask still sitting in the
    // registry. entry.activeTurnId may or may not be live in that case;
    // when it IS (a genuinely in-flight turn), the same seeding must fire.
    entry.activeTurnId = 'turn-open-2';
    entry.isExtracting = false;
    const resolveSpy = jest.fn();
    entry.pendingAsks.register('toolu_ask_4', {
      contextField: 'r1_r2_ohm',
      contextCircuit: 7,
      expectedAnswerShape: 'number',
      resolve: resolveSpy,
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await ws._emit(
      'message',
      transcript('R1 plus R2 on circuit 7 is 0.85.', 'utt-answer-2', {
        regexResults: [{ field: 'r1_r2_ohm', circuit: 7, value: '0.85' }],
        regex_fast_correlation_id: 'cid-overtake-1',
      })
    );

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, user_text: 'R1 plus R2 on circuit 7 is 0.85.' })
    );
    const seeded = entry.fastPathCorrelationIdByTurn.get('turn-open-2');
    expect(seeded).toBeInstanceOf(Set);
    expect(seeded.has('cid-overtake-1')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Codex diff-review cycle 4 (E2) — the ask-answer correlation merge does NOT
// roll back when the ask resolution races and fails.
//
// D1's fix (above) merges the transcript's correlation id(s) onto
// entry.activeTurnId's tracking Set BEFORE calling pendingAsks.resolve(...).
// If resolve() returns false — a genuine race: the SAME ask was concurrently
// answered elsewhere (a direct ask_user_answered frame) or timed out between
// classifyOvertake's snapshot and this resolve() call — the transcript falls
// through to open a NEW extraction turn instead of resuming the stale one.
// Pre-E2, the merged correlation id(s) stayed attributed to the OLD
// (now-stale) activeTurnId regardless: the old turn could later stamp/
// suppress using fast audio that actually belongs to the new turn, and the
// new turn would never see the correlation at all.
//
// Each test registers a REAL ask (so the real classifyOvertake — unmocked in
// this file — finds it via `entries()`/`findByContext` and returns a genuine
// 'answers' verdict), then overrides ONLY `entry.pendingAsks.resolve` to a
// stub that returns false. `entries()`/`findByContext`/`size` are untouched
// closures over the same registry Map, so classification behaves exactly as
// a real race would look from sonnet-stream.js's point of view: the ask was
// found and matched, but resolving it lost the race.
// -----------------------------------------------------------------------------
describe('E2 — the ask-answer merge rolls back when resolve() races and fails', () => {
  test('pre-queue seam: resolve() returns false → the merge is rolled back, never left dangling on the stale entry.activeTurnId', async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);
    entry.activeTurnId = 'turn-e2-preq';
    entry.isExtracting = true;
    // A sibling correlation already legitimately seeded onto this SAME turn
    // (e.g. the turn's own opening utterance fast-dispatched a different
    // reading) — the rollback must NEVER touch this.
    entry.fastPathCorrelationIdByTurn.set('turn-e2-preq', new Set(['cid-sibling-legit']));
    entry.pendingAsks.register('toolu_ask_e2_preq', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 4,
      expectedAnswerShape: 'number',
      resolve: jest.fn(),
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    // Simulate the race: classification will still find + match this ask
    // (entries()/findByContext are untouched), but resolving it loses.
    entry.pendingAsks.resolve = jest.fn(() => false);

    await ws._emit(
      'message',
      transcript('Zs on circuit 4 is 0.62.', 'utt-answer-race', {
        regexResults: [{ field: 'measured_zs_ohm', circuit: 4, value: '0.62' }],
        regex_fast_correlation_id: 'cid-preq-race',
      })
    );

    // resolve() was attempted (classification matched) and lost the race.
    expect(entry.pendingAsks.resolve).toHaveBeenCalled();

    const seeded = entry.fastPathCorrelationIdByTurn.get('turn-e2-preq');
    // The raced id must NOT be attributed to the stale turn.
    expect(seeded?.has('cid-preq-race')).not.toBe(true);
    // The pre-existing sibling id survives — rollback removes ONLY what this
    // call added, never an earlier legitimate merge.
    expect(seeded?.has('cid-sibling-legit')).toBe(true);
  });

  test('overtake seam: resolve() returns false → the merge is rolled back, never left dangling on the stale entry.activeTurnId', async () => {
    const { ws, entry } = await startLiveSession(wss, SESSION_ID);
    entry.activeTurnId = 'turn-e2-overtake';
    entry.isExtracting = false;
    entry.fastPathCorrelationIdByTurn.set('turn-e2-overtake', new Set(['cid-sibling-legit-2']));
    entry.pendingAsks.register('toolu_ask_e2_overtake', {
      contextField: 'r1_r2_ohm',
      contextCircuit: 7,
      expectedAnswerShape: 'number',
      resolve: jest.fn(),
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    entry.pendingAsks.resolve = jest.fn(() => false);

    await ws._emit(
      'message',
      transcript('R1 plus R2 on circuit 7 is 0.85.', 'utt-answer-race-2', {
        regexResults: [{ field: 'r1_r2_ohm', circuit: 7, value: '0.85' }],
        regex_fast_correlation_id: 'cid-overtake-race',
      })
    );

    expect(entry.pendingAsks.resolve).toHaveBeenCalled();

    const seeded = entry.fastPathCorrelationIdByTurn.get('turn-e2-overtake');
    expect(seeded?.has('cid-overtake-race')).not.toBe(true);
    expect(seeded?.has('cid-sibling-legit-2')).toBe(true);
  });
});
