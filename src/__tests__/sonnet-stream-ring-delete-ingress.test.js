/**
 * P1 ring-script-hardening — decision-gate criterion 2(a): REAL
 * sonnet-stream ingress with a harness spy. Proves the wire-in → engine →
 * model-bound-transcript seam end to end:
 *
 *   - delete-at-CONFIRM: the annotated client reply is parsed RAW by the
 *     engine (Fix 4), the confirmation delete exit composes the EXACT
 *     server-note antecedent, REPLACES the in_response_to annotation, and
 *     the downstream harness receives note + untouched raw reply.
 *   - delete-at-ENTRY: the entry guard falls through with NO note — the
 *     harness receives the raw transcript unchanged (there is no read-back
 *     to cite).
 *
 * The harness side of the seam (real runShadowHarness + canned
 * clear_reading rounds) lives in dialogue-engine-ring-delete-contract.test.js.
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
const runShadowHarnessSpy = jest.fn(async (_session, text) => {
  harnessCalls.push(text);
  return { extracted_readings: [], questions_for_user: [], observations: [], confirmations: [] };
});
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
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

async function startLiveSession(wss, sessionId) {
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
  // Seed the snapshot the ring dialogue engine reads (all three ring slots
  // filled → entry jumps straight to confirmation — the B4C45F25 shape).
  entry.session.stateSnapshot = {
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
  return { ws, entry };
}

const SERVER_NOTE_13 =
  '[Server note: The assistant just read back the complete ring-continuity set ' +
  '(R1, Rn and R2) for circuit 13 and asked "All correct?". ' +
  "The user's reply follows.] ";

let wss;
const openWs = [];
beforeEach(() => {
  loggerMock.info.mockClear();
  runShadowHarnessSpy.mockClear();
  harnessCalls.length = 0;
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'key', jest.fn());
});
afterEach(async () => {
  // Fire the connection close handler so the per-connection 30s ping
  // interval is cleared — otherwise the REAL interval keeps the jest worker
  // alive after the suite finishes (the watchdog sibling suite avoids this
  // via fake timers; these tests run real timers end-to-end).
  for (const ws of openWs.splice(0)) {
    ws.readyState = 3; // CLOSED
    await ws._emit('close');
  }
  // The close handler arms a REAL 5-minute disconnectTimer per session —
  // clear it or the jest worker never exits.
  for (const entry of activeSessions.values()) {
    if (entry?.disconnectTimer) clearTimeout(entry.disconnectTimer);
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('P1 delete ingress — real sonnet-stream → engine → model-bound transcript', () => {
  test('delete-at-CONFIRM: annotated reply → engine delete exit → harness receives EXACT note + untouched raw suffix (annotation replaced)', async () => {
    const { ws } = await startLiveSession(wss, 'sess-ingress-confirm');

    // Turn 1 — all-filled entry → engine emits the confirmation and
    // consumes the turn (Sonnet bypassed entirely).
    await ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'transcript',
          text: 'Ring continuity for circuit 13.',
          utterance_id: 'u1',
          regexResults: [],
        })
      )
    );
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
    const confirmAsk = ws._sent.find(
      (f) => f.type === 'ask_user_started' && f.reason === 'confirm_ring_continuity'
    );
    expect(confirmAsk).toBeDefined();
    expect(confirmAsk.question).toBe('R1 0.77, Rn 0.78, R2 1.19. All correct?');
    // P4d: the engine confirm carries the arming utterance's epoch.
    expect(confirmAsk.utterance_id).toBe('u1');

    // Turn 2 — the client answers through the annotated in_response_to
    // channel; the engine must parse the RAW reply and the delete exit must
    // REPLACE the annotation with the server note.
    await ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'transcript',
          text: 'No. Please delete them all.',
          utterance_id: 'u2',
          regexResults: [],
          in_response_to: {
            type: 'stage6_ask_user',
            question: 'R1 0.77, Rn 0.78, R2 1.19. All correct?',
          },
        })
      )
    );
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(harnessCalls[0]).toBe(`${SERVER_NOTE_13}No. Please delete them all.`);
    expect(harnessCalls[0]).not.toContain('In response to');
  });

  test('delete-at-ENTRY: the entry guard falls through with the RAW transcript and NO note', async () => {
    const { ws } = await startLiveSession(wss, 'sess-ingress-entry');
    await ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'transcript',
          text: 'Can you delete the readings for the ring continuity on circuit 13, please?',
          utterance_id: 'u1',
          regexResults: [],
        })
      )
    );
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(harnessCalls[0]).toBe(
      'Can you delete the readings for the ring continuity on circuit 13, please?'
    );
    expect(harnessCalls[0]).not.toContain('[Server note:');
    // The engine never entered the script.
    const engineAsks = ws._sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id ?? '').startsWith('srv-rcs-')
    );
    expect(engineAsks).toHaveLength(0);
  });
});
