/**
 * Feedback id 93 (session 2D8E432D) — cross-utterance destructive-intent
 * memory, tested at the REAL sonnet-stream ingress (§6 matrix test 5).
 *
 * The repro: "delete" (10:33:03) and "recontinuity readings for circuit 13."
 * (10:33:09) arrived as two separate STT-finalised utterances; the entry
 * guard had no cross-utterance memory, so the trigger entered the ring
 * script and asked its confirmation instead of the delete reaching the
 * model. These tests drive the full arm → consume → suppress lifecycle:
 * arrival stamping (Symbol, byte-exact through the queue AND the
 * _drainedRetry requeue), arming at the model-commit seam, one-shot
 * consumption at each terminal disposition, the 12 s ORDERED ARRIVAL-DELTA
 * window (consumption-time `now` is banned — the FIFO both-queued case),
 * and the three-wrapper topology (ring runs first and must not burn the
 * token before IR).
 *
 * Engine-only class: the memoryless legacy twins would enter and ask where
 * the engine suppresses, so none of this runs through the expectIdentical
 * replay lane (see the plan's §6 lane note).
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

const harnessCalls = [];
// When a test sets `harnessGate` to a promise, the NEXT harness call blocks
// on it (simulating an in-flight extraction the queue backs up behind).
let harnessGate = null;
const runShadowHarnessSpy = jest.fn(async (_session, text) => {
  harnessCalls.push(text);
  if (harnessGate) {
    const gate = harnessGate;
    harnessGate = null;
    await gate;
  }
  return { extracted_readings: [], questions_for_user: [], observations: [], confirmations: [] };
});
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

const { initSonnetStream, activeSessions, TRANSCRIPT_ARRIVED_AT } =
  await import('../extraction/sonnet-stream.js');
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

const RING_FILLED_13 = {
  circuits: {
    13: {
      circuit_ref: 13,
      ring_r1_ohm: '0.77',
      ring_rn_ohm: '0.78',
      ring_r2_ohm: '1.19',
    },
  },
  pending_readings: [],
  observations: [],
  validation_alerts: [],
};

async function startLiveSession(wss, sessionId, snapshot = RING_FILLED_13) {
  const ws = makeFakeWs();
  openWs.push(ws);
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  await ws._emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'session_start', sessionId, jobState: { certificateType: 'eicr' } })
    )
  );
  const entry = activeSessions.get(sessionId);
  entry.session.toolCallsMode = 'live';
  entry.session.stateSnapshot = JSON.parse(JSON.stringify(snapshot));
  return { ws, entry };
}

const transcript = (text, utterance_id, extra = {}) =>
  Buffer.from(
    JSON.stringify({ type: 'transcript', text, utterance_id, regexResults: [], ...extra })
  );

const confirmAsks = (ws) =>
  ws._sent.filter((f) => f.type === 'ask_user_started' && f.reason === 'confirm_ring_continuity');
const irAsks = (ws) =>
  ws._sent.filter(
    (f) => f.type === 'ask_user_started' && String(f.tool_call_id ?? '').startsWith('srv-irs-')
  );
const armedRows = () =>
  loggerMock.info.mock.calls.filter(([msg]) => msg === 'stage6.cross_utterance_destructive_armed');
const consumedRows = () =>
  loggerMock.info.mock.calls.filter(
    ([msg]) => msg === 'stage6.cross_utterance_destructive_consumed'
  );

const T0 = 1_700_000_000_000;
let fakeNow;
let nowSpy;
let wss;
const openWs = [];

beforeEach(() => {
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  runShadowHarnessSpy.mockClear();
  harnessCalls.length = 0;
  harnessGate = null;
  activeSessions.clear();
  sonnetSessionStore.clear();
  fakeNow = T0;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
  wss = initSonnetStream(null, async () => 'key', jest.fn());
});

afterEach(async () => {
  nowSpy.mockRestore();
  for (const ws of openWs.splice(0)) {
    ws.readyState = 3; // CLOSED
    await ws._emit('close');
  }
  for (const entry of activeSessions.values()) {
    if (entry?.disconnectTimer) clearTimeout(entry.disconnectTimer);
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('id 93 — cross-utterance delete state machine at the sonnet-stream seam', () => {
  test('delete → RING trigger at 6 s ⇒ SUPPRESSED (the exact repro: trigger reaches the model, script never asks)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-ring');
    await ws._emit('message', transcript('Delete.', 'u1'));
    expect(harnessCalls).toEqual(['Delete.']);
    expect(armedRows()).toHaveLength(1);

    fakeNow = T0 + 6000;
    await ws._emit('message', transcript('recontinuity readings for circuit 13.', 'u2'));
    // Unsuppressed, the all-filled entry would jump straight to the ring
    // confirmation — the id-93 failure. Suppressed, it reaches the model.
    expect(confirmAsks(ws)).toHaveLength(0);
    expect(harnessCalls[1]).toBe('recontinuity readings for circuit 13.');
    const consumed = consumedRows();
    expect(consumed).toHaveLength(1);
    expect(consumed[0][1]).toMatchObject({
      seam: 'extraction_slot',
      arrival_delta_ms: 6000,
      suppressed: true,
    });
  });

  test('delete → IR trigger at 6 s ⇒ SUPPRESSED (three-wrapper topology: the ring wrapper runs first and must NOT burn the token)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-ir', {
      circuits: { 13: { circuit_ref: 13 } },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    });
    await ws._emit('message', transcript('Delete.', 'u1'));
    fakeNow = T0 + 6000;
    await ws._emit('message', transcript('Insulation resistance for circuit 13.', 'u2'));
    expect(irAsks(ws)).toHaveLength(0);
    expect(harnessCalls[1]).toBe('Insulation resistance for circuit 13.');
  });

  test('delete → UNRELATED utterance → trigger inside the window ⇒ enters normally (token consumed by the unrelated turn)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-consume');
    await ws._emit('message', transcript('Delete.', 'u1'));
    fakeNow = T0 + 2000;
    await ws._emit('message', transcript('Zs on circuit 4 is 0.62.', 'u2'));
    fakeNow = T0 + 4000;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u3'));
    // The unrelated turn consumed the token → the trigger enters the script.
    expect(confirmAsks(ws)).toHaveLength(1);
    expect(harnessCalls).toEqual(['Delete.', 'Zs on circuit 4 is 0.62.']);
  });

  test('delete → trigger after a 12 001 ms arrival delta ⇒ enters (window expired; token still consumed)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-expired');
    await ws._emit('message', transcript('Delete.', 'u1'));
    fakeNow = T0 + 12_001;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u2'));
    expect(confirmAsks(ws)).toHaveLength(1);
    const consumed = consumedRows();
    expect(consumed).toHaveLength(1);
    expect(consumed[0][1]).toMatchObject({ arrival_delta_ms: 12_001, suppressed: false });
  });

  test('FIFO both-queued (round-4 case): delete + trigger queued behind one in-flight extraction, drained late ⇒ trigger SUPPRESSED on the ARRIVAL delta', async () => {
    const { ws, entry } = await startLiveSession(wss, 'sess-x-fifo');
    let release;
    harnessGate = new Promise((r) => {
      release = r;
    });
    // Turn 0 occupies the extraction slot (harness blocks on the gate).
    const inFlight = ws._emit('message', transcript('Zs on circuit 4 is 0.62.', 'u0'));
    fakeNow = T0 + 1000;
    await ws._emit('message', transcript('Delete.', 'u1'));
    fakeNow = T0 + 7000;
    await ws._emit('message', transcript('recontinuity readings for circuit 13.', 'u2'));
    // Both queued; the arrival stamps are byte-exact on the queued clones
    // (the `{ ...msg }` spread preserves the enumerable Symbol).
    expect(entry.pendingTranscripts).toHaveLength(2);
    expect(entry.pendingTranscripts[0][TRANSCRIPT_ARRIVED_AT]).toBe(T0 + 1000);
    expect(entry.pendingTranscripts[1][TRANSCRIPT_ARRIVED_AT]).toBe(T0 + 7000);

    // Drain long after the window would have expired on a consumption-time
    // clock — the ORDERED ARRIVAL DELTA (6000 ms) is what must be compared.
    fakeNow = T0 + 30_000;
    release();
    await inFlight;

    expect(harnessCalls).toEqual([
      'Zs on circuit 4 is 0.62.',
      'Delete.',
      'recontinuity readings for circuit 13.',
    ]);
    expect(confirmAsks(ws)).toHaveLength(0);
  });

  test('re-stamp discriminator: both queued with a 13 s ARRIVAL delta, drained back-to-back ⇒ NOT suppressed (a drain-time re-stamp would make the delta ~0 and wrongly suppress)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-restamp');
    let release;
    harnessGate = new Promise((r) => {
      release = r;
    });
    const inFlight = ws._emit('message', transcript('Zs on circuit 4 is 0.62.', 'u0'));
    fakeNow = T0 + 1000;
    await ws._emit('message', transcript('Delete.', 'u1'));
    fakeNow = T0 + 14_001;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u2'));
    fakeNow = T0 + 40_000;
    release();
    await inFlight;
    expect(confirmAsks(ws)).toHaveLength(1);
  });

  test('"fix the socket wiring on circuit 4" does NOT arm (anchored standalone grammar)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-noarm');
    await ws._emit('message', transcript('fix the socket wiring on circuit 4', 'u1'));
    expect(armedRows()).toHaveLength(0);
    fakeNow = T0 + 2000;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u2'));
    expect(confirmAsks(ws)).toHaveLength(1);
  });

  test('arming works when "delete" is an in_response_to reply (grammar runs on the UN-ANNOTATED canonical text)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-annotated');
    await ws._emit(
      'message',
      transcript('delete', 'u1', {
        in_response_to: { type: 'stage6_ask_user', question: 'Anything else on circuit 13?' },
      })
    );
    // The model-bound transcript IS annotated; arming keyed on the canonical
    // un-annotated reply anyway.
    expect(harnessCalls[0]).toContain('In response to TTS question');
    expect(armedRows()).toHaveLength(1);
    fakeNow = T0 + 6000;
    await ws._emit('message', transcript('recontinuity readings for circuit 13.', 'u2'));
    expect(confirmAsks(ws)).toHaveLength(0);
    expect(harnessCalls[1]).toBe('recontinuity readings for circuit 13.');
  });

  test('a "delete" consumed as an ASK ANSWER (content-anchor path) arms NO token', async () => {
    const { ws, entry } = await startLiveSession(wss, 'sess-x-askanswer');
    // The direct ask_user_answered channel already carried this answer; the
    // paired transcript is suppressed via the content anchor — a terminal
    // ask-resolution disposition that must never arm.
    entry.recentAskAnswers = [
      { normalisedText: 'delete', expiresAt: fakeNow + 100_000, toolCallId: 'toolu_x' },
    ];
    await ws._emit('message', transcript('Delete.', 'u1'));
    expect(harnessCalls).toHaveLength(0);
    expect(armedRows()).toHaveLength(0);
    fakeNow = T0 + 6000;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u2'));
    expect(confirmAsks(ws)).toHaveLength(1);
  });

  test('a gate-blocked filler CONSUMES the token (no stale suppression of a later legitimate entry)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-gateblock');
    await ws._emit('message', transcript('Delete.', 'u1'));
    expect(armedRows()).toHaveLength(1);
    fakeNow = T0 + 1000;
    await ws._emit('message', transcript('um.', 'u2'));
    const consumed = consumedRows();
    expect(consumed).toHaveLength(1);
    expect(consumed[0][1]).toMatchObject({ seam: 'gate_blocked' });
    fakeNow = T0 + 2000;
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u3'));
    expect(confirmAsks(ws)).toHaveLength(1);
  });

  test('user_moved_on requeue: the _drainedRetry clone keeps the ORIGINAL arrival stamp byte-exact, and the delete still arms after the requeue', async () => {
    const { ws, entry } = await startLiveSession(wss, 'sess-x-requeue');
    // A pending ask whose shape can never match bare "Delete." → the
    // overtake classifier's fail-safe user_moved_on → rejectAll + requeue.
    entry.pendingAsks.register('toolu_req', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 4,
      expectedAnswerShape: 'number',
      resolve: jest.fn(),
      timer: null,
      askStartedAt: fakeNow,
    });
    const requeued = [];
    const origPush = entry.pendingTranscripts.push.bind(entry.pendingTranscripts);
    entry.pendingTranscripts.push = (item) => {
      requeued.push(item);
      return origPush(item);
    };

    await ws._emit('message', transcript('Delete.', 'u1'));
    expect(requeued).toHaveLength(1);
    expect(requeued[0]._drainedRetry).toBe(true);
    expect(requeued[0][TRANSCRIPT_ARRIVED_AT]).toBe(T0);
    // The drained re-entry reached the model-commit seam and armed.
    expect(armedRows()).toHaveLength(1);

    fakeNow = T0 + 6000;
    await ws._emit('message', transcript('recontinuity readings for circuit 13.', 'u2'));
    expect(confirmAsks(ws)).toHaveLength(0);
    expect(harnessCalls[harnessCalls.length - 1]).toBe('recontinuity readings for circuit 13.');
  });

  test('delete-on-confirm keeps its P1 server-note fallthrough AND does not arm (the reply is not a standalone destructive)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-x-p1confirm');
    await ws._emit('message', transcript('Ring continuity for circuit 13.', 'u1'));
    expect(confirmAsks(ws)).toHaveLength(1);
    fakeNow = T0 + 2000;
    await ws._emit(
      'message',
      transcript('No. Please delete them all.', 'u2', {
        in_response_to: {
          type: 'stage6_ask_user',
          question: 'R1 0.77, Rn 0.78, R2 1.19. All correct?',
        },
      })
    );
    expect(harnessCalls[0]).toContain('[Server note:');
    expect(harnessCalls[0]).toContain('No. Please delete them all.');
    // "No. Please delete them all." fails the ^-anchored standalone grammar.
    expect(armedRows()).toHaveLength(0);
  });
});
