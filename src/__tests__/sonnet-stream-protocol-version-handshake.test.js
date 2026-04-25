/**
 * Stage 6 Phase 6 Plan 06-01 — sonnet-stream.js handleSessionStart
 * `protocol_version` handshake tests.
 *
 * REQUIREMENTS: STI-06 (iOS protocol version handshake), STR-01
 * (rollback contract — off-mode functional equivalence).
 *
 * WHAT THIS FILE COVERS
 *   Group A — off mode (default through Phase 6)
 *     1. Missing protocol_version → session created, no warn log,
 *        no close, activeSessions entry exists.
 *     2. Wrong protocol_version → same (off-mode ignores entirely).
 *     3. Correct protocol_version → same.
 *
 *   Group B — shadow mode (Phase 7+ cutover)
 *     4. Missing protocol_version → warn logged
 *        ('stage6.protocol_version_mismatch_shadow_fallback'),
 *        entry.fallbackToLegacy === true, NO close, session usable.
 *     5. Correct protocol_version → no warn,
 *        entry.fallbackToLegacy === false.
 *
 *   Group C — live mode (Phase 7+2w post-cutover)
 *     6. Missing protocol_version → warn logged
 *        ('stage6.protocol_version_mismatch_live_reject'),
 *        ws.send error envelope, ws.close(1002), NO activeSessions entry.
 *     7. Wrong protocol_version → same as (6) but error message names
 *        the value seen.
 *     8. Correct protocol_version → no warn, session created,
 *        entry.protocolVersion === 'stage6'.
 *
 *   Group D — entry metadata
 *     9. Off-mode entry stores protocolVersion === null when client omits.
 *     10. Off-mode entry stores protocolVersion === 'stage6' when client
 *         sends (forward-looking — entry-level metadata is the same shape
 *         regardless of mode).
 *
 * MOCK STRATEGY: lifted from sonnet-stream-ask-routing.test.js — drive
 * a fake ws through wss.emit('connection',...) and capture handlers via
 * the fake's ws.on mock. The logger is mock'd as a per-test jest.fn so
 * we can assert specific warn calls without parsing real CloudWatch.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks (must register BEFORE dynamic import) ──────────────────────────────

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: mockLogger,
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
let originalToolCallsMode;

beforeEach(() => {
  // Snapshot env for mode-specific tests; restored in afterEach.
  originalToolCallsMode = process.env.SONNET_TOOL_CALLS;
  delete process.env.SONNET_TOOL_CALLS;
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  if (originalToolCallsMode === undefined) {
    delete process.env.SONNET_TOOL_CALLS;
  } else {
    process.env.SONNET_TOOL_CALLS = originalToolCallsMode;
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

// -----------------------------------------------------------------------------
// Group A — off mode (default through Phase 6)
// -----------------------------------------------------------------------------

describe('Group A — off mode ignores protocol_version entirely', () => {
  test('A.1 — missing protocol_version: session created, no warn, no close', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws = connect(wss, 'user-A');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-off-missing',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-off-missing')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();
    // No mismatch warns in either mode (off-mode is silent by-design)
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_live_reject');
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_shadow_fallback');
  });

  test('A.2 — wrong protocol_version in off mode: same — fully ignored', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws = connect(wss, 'user-A');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-off-wrong',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage7-future',
    });
    expect(activeSessions.get('sess-off-wrong')).toBeDefined();
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('A.3 — correct protocol_version in off mode: no warn, session created', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws = connect(wss, 'user-A');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-off-correct',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-off-correct')).toBeDefined();
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_live_reject');
  });
});

// -----------------------------------------------------------------------------
// Group B — shadow mode (Phase 7 cutover)
// -----------------------------------------------------------------------------

describe('Group B — shadow mode falls back to legacy on mismatch', () => {
  test('B.1 — missing protocol_version: warn + fallbackToLegacy=true, no close', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws = connect(wss, 'user-B');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-shadow-missing',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-shadow-missing');
    expect(entry).toBeDefined();
    expect(entry.fallbackToLegacy).toBe(true);
    expect(entry.protocolVersion).toBeNull();
    expect(ws.close).not.toHaveBeenCalled();
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).toContain('stage6.protocol_version_mismatch_shadow_fallback');
  });

  test('B.2 — correct protocol_version: no warn, fallbackToLegacy=false', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws = connect(wss, 'user-B');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-shadow-ok',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const entry = activeSessions.get('sess-shadow-ok');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_shadow_fallback');
  });
});

// -----------------------------------------------------------------------------
// Group C — live mode (Phase 7+2w post-cutover)
// -----------------------------------------------------------------------------

describe('Group C — live mode hard-rejects mismatched clients', () => {
  test('C.1 — missing protocol_version: warn + error envelope + ws.close(1002), NO entry', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws = connect(wss, 'user-C');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-live-missing',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-live-missing')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(1002, 'protocol_version_mismatch');
    const errorEnvelopes = ws._sent.filter((m) => m.type === 'error');
    expect(errorEnvelopes.length).toBe(1);
    expect(errorEnvelopes[0].message).toMatch(/protocol_version_mismatch/);
    expect(errorEnvelopes[0].message).toMatch(/expected stage6/);
    expect(errorEnvelopes[0].recoverable).toBe(false);
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).toContain('stage6.protocol_version_mismatch_live_reject');
  });

  test('C.2 — wrong protocol_version: error message names the value', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws = connect(wss, 'user-C');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-live-wrong',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage99-future',
    });
    expect(activeSessions.get('sess-live-wrong')).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(1002, 'protocol_version_mismatch');
    const errorEnvelopes = ws._sent.filter((m) => m.type === 'error');
    expect(errorEnvelopes[0].message).toMatch(/got stage99-future/);
  });

  test('C.3 — correct protocol_version: session created with metadata stamped', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws = connect(wss, 'user-C');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-live-ok',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const entry = activeSessions.get('sess-live-ok');
    expect(entry).toBeDefined();
    expect(entry.protocolVersion).toBe('stage6');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(ws.close).not.toHaveBeenCalled();
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_live_reject');
  });
});

// -----------------------------------------------------------------------------
// Group D — entry metadata stamping (regardless of mode)
// -----------------------------------------------------------------------------

describe('Group D — entry stamps protocolVersion from msg', () => {
  test('D.1 — off mode + missing key: protocolVersion === null', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws = connect(wss, 'user-D');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-D1',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-D1');
    expect(entry.protocolVersion).toBeNull();
    expect(entry.fallbackToLegacy).toBe(false);
  });

  test('D.2 — off mode + correct key: protocolVersion === stage6', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws = connect(wss, 'user-D');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-D2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const entry = activeSessions.get('sess-D2');
    expect(entry.protocolVersion).toBe('stage6');
  });
});

// -----------------------------------------------------------------------------
// Group E — session_resume rehydrate path enforces protocol_version policy
// -----------------------------------------------------------------------------
//
// Plan 06-06 r5-#1 (MAJOR) — handleSessionResumeRehydrate previously rebound
// the existing entry's ws based purely on the resume token's TTL validity. It
// never consulted msg.protocol_version against process.env.SONNET_TOOL_CALLS.
// This left a backdoor for stale iOS clients holding valid resume tokens to
// wake an entry into live mode without advertising stage6 capability —
// defeating the STI-06 hard-rejection contract that handleSessionStart
// already enforces on the fresh-connect path.
//
// These tests pin the policy at the resume surface: off ignores, shadow
// stamps fallbackToLegacy + warns, live rejects with ws.close(1002).
//
// Test mechanics:
//   1. Open the original session via session_start (mints rehydrateSessionId
//      into sonnetSessionStore as a side-effect of activeSessions.set).
//   2. Read the stored token from the session_ack response.
//   3. Connect a NEW fake ws and send `{type:'session_resume', sessionId:
//      <token>, protocol_version: <variant>}`. The new ws is what the
//      rehydrate path rebinds to, so policy assertions target it.
function readRehydrateToken(ws) {
  // session_start response includes `{type:'session_ack', status:'started',
  //   sessionId: <rehydrateSessionId>}`.
  const ack = ws._sent.find((m) => m.type === 'session_ack' && m.status === 'started');
  if (!ack || !ack.sessionId) {
    throw new Error(`No started session_ack in ws._sent: ${JSON.stringify(ws._sent)}`);
  }
  return ack.sessionId;
}

describe('Group E — session_resume enforces protocol_version policy (r5-#1)', () => {
  test('E.1 — off mode: session_resume works regardless of protocol_version (functional equivalence)', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-E');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-E1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const token = readRehydrateToken(ws1);

    const ws2 = connect(wss, 'user-E');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      // off-mode: protocol_version should be ignored even if downgraded/missing.
    });

    // The entry should be rebound to the new ws — no close, no error envelope.
    const entry = activeSessions.get('sess-E1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(ws2.close).not.toHaveBeenCalled();
    const errorEnvelopes = ws2._sent.filter((m) => m.type === 'error');
    expect(errorEnvelopes.length).toBe(0);
    // No mismatch warns either way.
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_live_reject_resume');
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_shadow_fallback_resume');
  });

  test('E.2 — shadow mode: resume frame missing protocol_version → fallbackToLegacy=true, warn fires, session usable', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-E');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-E2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    // After session_start with stage6, fallbackToLegacy should be false.
    expect(activeSessions.get('sess-E2').fallbackToLegacy).toBe(false);
    const token = readRehydrateToken(ws1);

    const ws2 = connect(wss, 'user-E');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      // protocol_version intentionally omitted (downgrade scenario).
    });

    const entry = activeSessions.get('sess-E2');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.fallbackToLegacy).toBe(true);
    expect(entry.protocolVersion).toBeNull();
    expect(ws2.close).not.toHaveBeenCalled();
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).toContain('stage6.protocol_version_mismatch_shadow_fallback_resume');
  });

  test('E.3 — shadow mode: resume frame with protocol_version=stage6 → fallbackToLegacy=false, no warn', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-E');
    // Open original under shadow with MISSING protocol_version (so initial
    // fallbackToLegacy is true), then assert resume with stage6 clears it.
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-E3',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-E3').fallbackToLegacy).toBe(true);
    const token = readRehydrateToken(ws1);
    mockLogger.warn.mockClear();

    const ws2 = connect(wss, 'user-E');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-E3');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_shadow_fallback_resume');
  });

  test('E.4 — live mode: resume frame missing protocol_version → ws.close(1002), entry NOT rebound', async () => {
    // Original session_start under live mode requires stage6 (otherwise it
    // fails the fresh-connect policy and never mints an entry). So we open
    // under stage6, then resume with the protocol_version omitted.
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss, 'user-E');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-E4',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const entry = activeSessions.get('sess-E4');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws1);
    const token = readRehydrateToken(ws1);
    mockLogger.warn.mockClear();

    const ws2 = connect(wss, 'user-E');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      // No protocol_version — downgraded resume attempt.
    });

    expect(ws2.close).toHaveBeenCalledWith(1002, 'protocol_version_mismatch');
    const errorEnvelopes = ws2._sent.filter((m) => m.type === 'error');
    expect(errorEnvelopes.length).toBe(1);
    expect(errorEnvelopes[0].message).toMatch(/protocol_version_mismatch/);

    // The entry must NOT have been rebound to the rejected ws.
    const entryAfter = activeSessions.get('sess-E4');
    expect(entryAfter).toBeDefined();
    expect(entryAfter.ws).not.toBe(ws2);

    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).toContain('stage6.protocol_version_mismatch_live_reject_resume');
  });

  test('E.5 — live mode: resume frame with protocol_version=stage6 → rehydrate succeeds, ws rebound', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss, 'user-E');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-E5',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const token = readRehydrateToken(ws1);
    mockLogger.warn.mockClear();

    const ws2 = connect(wss, 'user-E');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-E5');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.protocolVersion).toBe('stage6');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(ws2.close).not.toHaveBeenCalled();
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_live_reject_resume');
  });
});

// -----------------------------------------------------------------------------
// Group F — session_start reconnect updates entry.protocolVersion + fallbackToLegacy
// -----------------------------------------------------------------------------
//
// Plan 06-06 r5-#2 (MAJOR) — handleSessionStart's reconnect branch at
// sonnet-stream.js:1366 computes a NEW protocolVersion + fallbackToLegacy
// from the inbound msg (lines 1320-1352) but never writes those values back
// to `existing`. Two real-world surfaces break:
//   1. Operator flipping SONNET_TOOL_CALLS=off → shadow mid-session leaves
//      entry.fallbackToLegacy=false, leaking Stage 6 wire shapes to
//      mismatched clients post-flip.
//   2. iOS firmware upgrade mid-session that now advertises
//      protocol_version='stage6' on reconnect still sees fallbackToLegacy=true
//      on the entry, suppressing every Stage 6 emit even though the upgraded
//      client can now decode them.
//
// Tests:
//   F.1 — shadow + downgrade reconnect: entry.fallbackToLegacy must flip
//          to true after the reconnect frame.
//   F.2 — shadow + upgrade reconnect: entry.fallbackToLegacy must flip to
//          false (clears the stale-client suppression).
//   F.3 — live + downgrade reconnect: ws.close(1002), entry NOT swapped.
//   F.4 — off + anything: latest protocolVersion recorded; no policy.

describe('Group F — session_start reconnect updates entry.protocolVersion + fallbackToLegacy (r5-#2)', () => {
  test('F.1 — shadow downgrade across reconnect: fallbackToLegacy flips to true', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-F');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-F1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-F1').fallbackToLegacy).toBe(false);

    // Reconnect under shadow with protocol_version MISSING — the same
    // sessionId triggers handleSessionStart's reconnect branch.
    const ws2 = connect(wss, 'user-F');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-F1',
      jobState: { certificateType: 'eicr' },
      // protocol_version omitted — downgrade path.
    });

    const entry = activeSessions.get('sess-F1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.fallbackToLegacy).toBe(true);
    expect(entry.protocolVersion).toBeNull();
  });

  test('F.2 — shadow upgrade across reconnect: fallbackToLegacy flips to false', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-F');
    // Open original session with protocol_version MISSING — entry has
    // fallbackToLegacy=true.
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-F2',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-F2').fallbackToLegacy).toBe(true);
    mockLogger.warn.mockClear();

    // Reconnect now advertises stage6 — the entry must flip back to
    // fallbackToLegacy=false.
    const ws2 = connect(wss, 'user-F');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-F2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-F2');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
  });

  test('F.3 — live + downgrade reconnect: ws.close(1002), original entry not swapped', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss, 'user-F');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-F3',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-F3').ws).toBe(ws1);
    mockLogger.warn.mockClear();

    // Reconnect with protocol_version MISSING — should hard-reject.
    // (Existing top-of-handleSessionStart policy at lines ~1321-1345 already
    // catches this BEFORE the reconnect branch runs, so the warn key is the
    // shared 'stage6.protocol_version_mismatch_live_reject' rather than a
    // reconnect-specific key. The regression value here is that the
    // existing live policy still applies on the reconnect surface — i.e.
    // the existing entry is preserved untouched.)
    const ws2 = connect(wss, 'user-F');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-F3',
      jobState: { certificateType: 'eicr' },
      // protocol_version omitted.
    });

    expect(ws2.close).toHaveBeenCalledWith(1002, 'protocol_version_mismatch');
    // The original entry MUST NOT have its ws swapped to the rejected ws2.
    const entry = activeSessions.get('sess-F3');
    expect(entry).toBeDefined();
    expect(entry.ws).not.toBe(ws2);
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).toContain('stage6.protocol_version_mismatch_live_reject');
  });

  test('F.4 — off mode reconnect: latest protocolVersion recorded, no policy', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-F');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-F4',
      jobState: { certificateType: 'eicr' },
      // No protocol_version on first connect.
    });
    expect(activeSessions.get('sess-F4').protocolVersion).toBeNull();

    const ws2 = connect(wss, 'user-F');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-F4',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-F4');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.protocolVersion).toBe('stage6');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(ws2.close).not.toHaveBeenCalled();
  });
});
