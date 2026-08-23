/**
 * PLAN-A 2026-08-23 (feedback id 126) — hybrid-blocked direct command through
 * the REAL sonnet-stream transcript ingress.
 *
 * A dictated "use the same address for the client" against a target that
 * holds a component the source lacks must TERMINATE at the mirror ingress
 * block: exactly ONE spoken blocker frame, zero copied client_* readings,
 * and NO model fallthrough (the utterance is consumed — runShadowHarness is
 * never invoked). This pins the 'blocked' entry in the terminal
 * mirror-outcome classifier: without it the outcome would fall through the
 * question branch (no question on a blocked terminal) and continue into the
 * extraction pipeline.
 *
 * Mock strategy follows stage6-questions-for-user-deletion.test.js exactly:
 * fake ws via wss.emit('connection', ...), FakeEICRExtractionSession, and a
 * runShadowHarness spy. The address-mirror controller is the REAL one in
 * session-local (no-DB) mode, rebound onto the entry after session_start.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks (must be registered BEFORE dynamic import of sonnet-stream.js) ─────

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.toolCallsMode = 'live';
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.stateSnapshot = {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.updateJobState = jest.fn();
    this.applyModeChange = jest.fn((mode) => {
      this.toolCallsMode = mode;
    });
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
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

const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));

jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: jest.fn(),
  unmergeFastPathCorrelationIds: jest.fn(),
  coerceFastPathCorrelationIds: jest.fn(() => new Set()),
}));

// ── Dynamic import AFTER mocks ────────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { createAddressMirrorController } =
  await import('../extraction/address-mirror-controller.js');

// ── Helpers (pattern from sonnet-stream-ask-routing.test.js) ─────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => {
      try {
        sent.push(JSON.parse(payload));
      } catch {
        sent.push(payload);
      }
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

async function sendFrame(ws, frame) {
  await ws._emit('message', Buffer.from(JSON.stringify(frame)));
}

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  runShadowHarnessSpy.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('hybrid-blocked direct command at transcript ingress', () => {
  test('one spoken blocker frame, zero copy, utterance consumed with no model fallthrough', async () => {
    const ws = makeFakeWs();
    wss.emit('connection', ws, { headers: {} }, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-hybrid-ingress',
      jobId: 'job-hybrid',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-hybrid-ingress');
    expect(entry).toBeDefined();

    // Relaxed-complete source, hybrid target.
    entry.session.stateSnapshot.circuits = {
      0: { address: '137 Large Lane', county: 'Essex', client_postcode: 'HB1 1AA' },
    };
    // The REAL controller in session-local mode (the production entry binds a
    // durable-store controller; tests have no DB, so rebind the same API in
    // its no-DB shape — identical transition logic, session-local latch).
    entry.addressMirrorController = createAddressMirrorController({
      session: entry.session,
    });

    ws._sent.length = 0;
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Use the same address for the client.',
      utterance_id: 'utt-hybrid-ingress-1',
      regexResults: [],
    });

    // No model fallthrough — the blocked terminal consumed the utterance.
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();

    // Exactly one frame carries the spoken blocker; nothing carries a copy.
    const blockerText =
      'The client address already has a postcode — dictate the site postcode and ask me again.';
    const framesWithBlocker = ws._sent.filter((frame) =>
      JSON.stringify(frame).includes(blockerText)
    );
    expect(framesWithBlocker).toHaveLength(1);
    const extractionFrames = ws._sent.filter((frame) => frame.type === 'extraction');
    for (const frame of extractionFrames) {
      const readings = [
        ...(frame.result?.readings ?? []),
        ...(frame.result?.extracted_board_readings ?? []),
      ];
      expect(readings.filter((r) => String(r.field ?? '').startsWith('client_'))).toEqual([]);
    }
    // The target kept only what it had — never a silent merge.
    expect(entry.session.stateSnapshot.circuits[0].client_address).toBeUndefined();
    expect(entry.session.stateSnapshot.circuits[0].client_postcode).toBe('HB1 1AA');

    // The same occurrence re-sent (reconnect replay) is consumed silently by
    // the reservation, not re-spoken and not forwarded to the model.
    ws._sent.length = 0;
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Use the same address for the client.',
      utterance_id: 'utt-hybrid-ingress-1',
      regexResults: [],
    });
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
    expect(ws._sent.filter((frame) => JSON.stringify(frame).includes(blockerText))).toHaveLength(0);
  });

  test('after dictating the named source component, a fresh direct command copies (organic recovery through ingress)', async () => {
    const ws = makeFakeWs();
    wss.emit('connection', ws, { headers: {} }, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-hybrid-recover',
      jobId: 'job-hybrid-recover',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-hybrid-recover');
    entry.session.stateSnapshot.circuits = {
      0: { address: '137 Large Lane', county: 'Essex', client_postcode: 'HB1 1AA' },
    };
    entry.addressMirrorController = createAddressMirrorController({
      session: entry.session,
    });

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Use the same address for the client.',
      utterance_id: 'utt-recover-1',
      regexResults: [],
    });
    // FOLLOW the spoken instruction: the site postcode is dictated (the
    // extraction write itself is the model's job — simulate its landing).
    entry.session.stateSnapshot.circuits[0].postcode = 'HB1 1AA';

    ws._sent.length = 0;
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Use the same address for the client.',
      utterance_id: 'utt-recover-2',
      regexResults: [],
    });
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
    expect(entry.session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '137 Large Lane',
      client_postcode: 'HB1 1AA',
      client_county: 'Essex',
    });
  });

  test('durable restart: an undelivered persisted blocked terminal replays exactly one spoken blocker through the real reconnect outbox', async () => {
    // Codex diff-review cycle 1 — the restart contract through the REAL ws
    // layer: the process died after the blocked terminal was persisted but
    // before its audio was delivered; the reconnect outbox replay must speak
    // the persisted blocker exactly once, copy nothing, and mark the row
    // delivered.
    let row = {
      status: 'conflict',
      clarification_kind: 'direct',
      source_family: 'site',
      target_family: 'client',
      operation_token: 'direct-blocked-restart',
      question_id: 'address-mirror-direct-blocked-restart',
      source_snapshot: { address: '137 Large Lane', county: 'Essex' },
      source_writes: [],
      terminal_outcome: {
        outcome: 'blocked',
        reason: 'source_missing_target_components',
        missing_source_keys: ['postcode'],
        source_family: 'site',
        target_family: 'client',
      },
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => null),
      loadRecoverableDirect: jest.fn(async () => (row.delivered_at ? [] : [row])),
      claimDirectDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
      markDirectDelivered: jest.fn(async () => {
        row = { ...row, delivered_at: new Date().toISOString() };
        return row;
      }),
    };

    const ws1 = makeFakeWs();
    wss.emit('connection', ws1, { headers: {} }, 'user-1');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-hybrid-restart',
      jobId: 'job-hybrid-restart',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-hybrid-restart');
    entry.session.stateSnapshot.circuits = {
      0: { address: '137 Large Lane', county: 'Essex', client_postcode: 'HB1 1AA' },
    };
    // Durable-mode controller bound to the persisted store (the production
    // entry binds the real DB; the double carries the same CAS/lease shape).
    entry.addressMirrorController = createAddressMirrorController({
      userId: 'user-1',
      jobId: 'job-hybrid-restart',
      session: entry.session,
      store,
    });
    await entry.addressMirrorController.rehydrate();

    // "Restart": a fresh socket reconnects the same session — the real
    // reconnect path drains the address-mirror outbox.
    const ws2 = makeFakeWs();
    wss.emit('connection', ws2, { headers: {} }, 'user-1');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-hybrid-restart',
      jobId: 'job-hybrid-restart',
      jobState: { certificateType: 'eicr' },
    });

    const blockerText =
      'The client address already has a postcode — dictate the site postcode and ask me again.';
    const framesWithBlocker = ws2._sent.filter((frame) =>
      JSON.stringify(frame).includes(blockerText)
    );
    expect(framesWithBlocker).toHaveLength(1);
    // No model fallthrough, zero copy, and the outbox row is now delivered.
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
    expect(entry.session.stateSnapshot.circuits[0].client_address).toBeUndefined();
    expect(row.delivered_at).toBeTruthy();
  });
});
