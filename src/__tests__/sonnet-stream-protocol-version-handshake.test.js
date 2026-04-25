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
  constructor(apiKey, sessionId, certType, options = {}) {
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
    // Plan 06-07 r6-#1 — mirror the real EICRExtractionSession's
    // _resolveToolCallsMode behaviour so Group G can read back the
    // construction-time / write-back value of toolCallsMode. The real
    // class resolves from `options.toolCallsMode ?? process.env
    // .SONNET_TOOL_CALLS ?? 'off'` and sanitises through an allow-list
    // of 'off' | 'shadow' | 'live'. The fake mirrors that without
    // pulling in the real class's prompt module imports.
    const raw = options.toolCallsMode ?? process.env.SONNET_TOOL_CALLS ?? 'off';
    this.toolCallsMode = raw === 'off' || raw === 'shadow' || raw === 'live' ? raw : 'off';
    this.certType = certType;
    // Plan 06-08 r7-#1 — mirror the real EICRExtractionSession's
    // constructor-time systemPrompt derivation. Sentinel strings
    // ('legacy-prompt-eicr', 'legacy-prompt-eic', 'agentic-prompt')
    // stand in for the real prompt files — Group H.5 only needs to
    // assert which BUCKET of prompt the fake session lands in
    // (legacy-eicr / legacy-eic / agentic), not the actual prompt
    // bytes. Real-prompt-bytes regression is covered by the unit
    // test file `eicr-extraction-session-apply-mode-change.test.js`
    // which imports the real class.
    this.systemPrompt =
      this.toolCallsMode === 'off'
        ? this.certType === 'eic'
          ? 'legacy-prompt-eic'
          : 'legacy-prompt-eicr'
        : 'agentic-prompt';
  }

  // Plan 06-08 r7-#1 — mirror the real applyModeChange contract so
  // sonnet-stream.js's reconnect/resume call sites can hit the same
  // method on the fake. Validation + no-op + restamp logic is byte-
  // for-byte-equivalent semantics with the real method.
  applyModeChange(newMode) {
    let resolved;
    if (newMode === 'off' || newMode === 'shadow' || newMode === 'live') {
      resolved = newMode;
    } else {
      resolved = 'off';
    }
    if (resolved === this.toolCallsMode) return;
    this.toolCallsMode = resolved;
    this.systemPrompt =
      this.toolCallsMode === 'off'
        ? this.certType === 'eic'
          ? 'legacy-prompt-eic'
          : 'legacy-prompt-eicr'
        : 'agentic-prompt';
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

// -----------------------------------------------------------------------------
// Group G — entry.session.toolCallsMode reflects effective mode after
// reconnect/resume (r6-#1 BLOCK)
// -----------------------------------------------------------------------------
//
// Plan 06-07 r6-#1 (BLOCK) — r5 fixes restamp top-level entry.protocolVersion
// + entry.fallbackToLegacy on reconnect/resume but DON'T update
// entry.session.toolCallsMode. The runtime uses session.toolCallsMode for
// path selection at TWO load-bearing sites:
//
//   1. runShadowHarness at stage6-shadow-harness.js:188 reads
//      session.toolCallsMode and routes to legacy fast path / Phase-6
//      throw / shadow harness.
//   2. consumeLegacyQuestionsForUser at sonnet-stream.js:110 reads
//      entry?.session?.toolCallsMode === 'off' to gate ingestion of the
//      legacy questions_for_user JSON field per STR-01.
//
// `entry.session.toolCallsMode` is set ONCE at session-construction time
// by EICRExtractionSession's constructor from process.env.SONNET_TOOL_CALLS.
// After a mid-session env flip OR an iOS firmware upgrade that flips the
// (mode × match) handshake outcome, the entry continues to route through
// the OLD path even though r5 wrote the new fallbackToLegacy +
// protocolVersion values.
//
// Group G pins the contract: after a reconnect or resume, the entry's
// session.toolCallsMode reflects the freshly-resolved env mode, mirroring
// r5's protocolVersion + fallbackToLegacy write-backs.
//
// Test mechanics:
//   • Set env A and session_start. Assert entry.session.toolCallsMode === A.
//   • Flip env A → B.
//   • Reconnect (G.1, G.2, G.5) or resume (G.3, G.4) under B.
//   • Assert entry.session.toolCallsMode === B.
//
// FakeEICRExtractionSession's constructor (top of file) was extended to
// read `options.toolCallsMode ?? process.env.SONNET_TOOL_CALLS` so the
// initial assertion has something to read — the real class does the same.

describe('Group G — entry.session.toolCallsMode tracks effective env mode after reconnect/resume (r6-#1)', () => {
  test('G.1 — reconnect: off → shadow flip writes session.toolCallsMode=shadow', async () => {
    // Original session created under off-mode.
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-G');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-G1',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-G1').session.toolCallsMode).toBe('off');

    // Operator flips env: off → shadow. Inspector's iOS reconnects with
    // protocol_version='stage6' (post-firmware-upgrade or just standard
    // reconnect attempt). Without the r6 fix, entry.session.toolCallsMode
    // stays 'off' and the harness short-circuits to the legacy fast path
    // — defeating the operator's intent of engaging shadow mode.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws2 = connect(wss, 'user-G');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-G1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-G1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('shadow');
    // Sanity: r5's write-backs also reflect the new mode + handshake.
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
  });

  test('G.2 — reconnect: shadow → off flip writes session.toolCallsMode=off (STR-01 rollback)', async () => {
    // Original under shadow with stage6 — fallbackToLegacy=false.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-G');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-G2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-G2').session.toolCallsMode).toBe('shadow');

    // Operator flips shadow → off (STR-01 rollback). Reconnect must drop
    // the entry's session out of shadow routing, otherwise the harness
    // keeps running shadow even after the global rollback.
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss, 'user-G');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-G2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-G2');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('off');
  });

  test('G.3 — resume: off → shadow flip via session_resume writes session.toolCallsMode=shadow', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-G');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-G3',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-G3').session.toolCallsMode).toBe('off');
    const token = readRehydrateToken(ws1);

    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws2 = connect(wss, 'user-G');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-G3');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
  });

  test('G.4 — resume: shadow → off flip via session_resume writes session.toolCallsMode=off', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-G');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-G4',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-G4').session.toolCallsMode).toBe('shadow');
    const token = readRehydrateToken(ws1);

    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss, 'user-G');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-G4');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('off');
  });

  test('G.5 — reconnect: shadow + protocol_version mismatch keeps session.toolCallsMode=shadow AND fallbackToLegacy=true', async () => {
    // Regression-lock: toolCallsMode reflects the effective ENV mode at
    // reconnect time, not the (mode × match) handshake outcome. The
    // dispatcher's fallbackToLegacy gate (r1-#1) suppresses Stage 6 wire
    // emission to mismatched clients; that's a separate concern from
    // which routing path the harness takes.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-G');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-G5',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-G5').session.toolCallsMode).toBe('shadow');
    expect(activeSessions.get('sess-G5').fallbackToLegacy).toBe(false);

    // Reconnect under shadow but with protocol_version MISSING — r5-#2's
    // shadow-mismatch path stamps fallbackToLegacy=true. r6 must still
    // write toolCallsMode='shadow' (the env says shadow), so the harness
    // routes through the shadow path AND the dispatcher's
    // fallbackToLegacy gate suppresses the iOS-bound Stage 6 emit.
    const ws2 = connect(wss, 'user-G');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-G5',
      jobState: { certificateType: 'eicr' },
      // protocol_version omitted.
    });

    const entry = activeSessions.get('sess-G5');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.fallbackToLegacy).toBe(true);
    expect(entry.protocolVersion).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Group H — applyModeChange + systemPrompt restamp (r7-#1 MAJOR)
// -----------------------------------------------------------------------------
//
// Plan 06-08 r7-#1 (MAJOR) — r6 wrote `entry.session.toolCallsMode` on
// reconnect/resume so runtime path-selection tracks the live env mode.
// But `EICRExtractionSession.systemPrompt` is the OTHER constructor-time
// mode-derived field — set ONCE at construction (line 697-702) from
// `toolCallsMode` and never re-derived. After off → shadow flip,
// `buildSystemBlocks()` correctly switches its layout (snapshot in
// system[1] instead of in messages array, because it re-reads
// toolCallsMode live), but `system[0].text` is still the LEGACY prompt —
// a hybrid that doesn't exist in any release of the prompt module.
//
// Plan 06-08 fix: new public `applyModeChange(newMode)` method on
// EICRExtractionSession that restamps BOTH `toolCallsMode` AND
// `systemPrompt` together. Sonnet-stream.js's two write sites
// (handleSessionStart reconnect, handleSessionResumeRehydrate) call
// applyModeChange instead of poking session.toolCallsMode directly.
//
// Group H.5 here is the "call site uses the method" integration test —
// open under off (legacy prompt), reconnect under shadow, assert
// `entry.session.systemPrompt` flipped to the agentic prompt. The
// FakeEICRExtractionSession at the top of this file mirrors the real
// class's systemPrompt selection (sentinel strings 'legacy-prompt-eicr'
// vs 'agentic-prompt') AND mirrors the applyModeChange contract, so
// this test fails under RED if (a) sonnet-stream.js still does direct
// `session.toolCallsMode = ...` assignment instead of calling
// applyModeChange, and passes under GREEN once both call sites use the
// method.
//
// H.1-H.4 (method-contract unit tests on the REAL class) live in
// `eicr-extraction-session-apply-mode-change.test.js`.

describe('Group H — applyModeChange call-site integration (r7-#1)', () => {
  test('H.5 — reconnect off → shadow flips entry.session.systemPrompt to agentic', async () => {
    // Original session under off: legacy prompt selected at construction.
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-H');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-H5',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-H5').session.toolCallsMode).toBe('off');
    expect(activeSessions.get('sess-H5').session.systemPrompt).toBe('legacy-prompt-eicr');

    // Operator flips off → shadow. iOS reconnects with stage6.
    // Without the r7-#1 fix, sonnet-stream.js writes
    // `existing.session.toolCallsMode = 'shadow'` directly — toolCallsMode
    // updates (r6 already pinned that) but systemPrompt stays at
    // 'legacy-prompt-eicr' because it's a constructor-cached field.
    // With the fix, sonnet-stream.js calls applyModeChange which
    // restamps both fields atomically.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws2 = connect(wss, 'user-H');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-H5',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-H5');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.session.systemPrompt).toBe('agentic-prompt');
  });

  test('H.5b — resume off → shadow via session_resume flips systemPrompt to agentic', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss, 'user-H');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-H5b',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-H5b').session.systemPrompt).toBe('legacy-prompt-eicr');
    const token = readRehydrateToken(ws1);

    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws2 = connect(wss, 'user-H');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-H5b');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.session.systemPrompt).toBe('agentic-prompt');
  });

  test('H.5c — STR-01 rollback: shadow → off restores legacy-eicr prompt', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-H');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-H5c',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-H5c').session.systemPrompt).toBe('agentic-prompt');

    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss, 'user-H');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-H5c',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-H5c');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.session.toolCallsMode).toBe('off');
    expect(entry.session.systemPrompt).toBe('legacy-prompt-eicr');
  });

  test('H.5d — match-mode reconnect (shadow → shadow with stage6) is a no-op for systemPrompt', async () => {
    // Regression lock for the no-op path. After r7-#1 the
    // applyModeChange method short-circuits when newMode ===
    // current — preserves prompt object reference and emits no log.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-H');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-H5d',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const entry1 = activeSessions.get('sess-H5d');
    const promptBefore = entry1.session.systemPrompt;
    expect(promptBefore).toBe('agentic-prompt');

    // Reconnect, same mode.
    const ws2 = connect(wss, 'user-H');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-H5d',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry2 = activeSessions.get('sess-H5d');
    expect(entry2.session.systemPrompt).toBe(promptBefore);
    // Same exact reference — no recompute fired.
    expect(entry2.session.systemPrompt).toBe('agentic-prompt');
  });
});

// -----------------------------------------------------------------------------
// Group I — resume token survives protocol_version rejection (r7-#2 MAJOR)
// -----------------------------------------------------------------------------
//
// Plan 06-08 r7-#2 (MAJOR) — handleSessionResumeRehydrate calls
// `sonnetSessionStore.resume(...)` BEFORE validating
// requestedProtocolVersion. resume() is non-consuming TODAY (LRU bump
// only) but the contract is fragile against the Wave 4c.5 brief's
// explicit anticipation of evolving to a Redis-backed consuming-on-
// read store, AND today's LRU touch on a doomed read is the wrong
// direction. Plan 06-08 fix: introduce sonnetSessionStore.peek() — a
// non-mutating read — and reorder handleSessionResumeRehydrate to
// peek → validate → resume. A rejected live-mismatch returns
// `{ack:'rejected'}` BEFORE resume() fires, so the token is untouched
// and the iOS client can retry with a corrected protocol_version
// field.
//
// Tests:
//   I.1 — live mode + missing protocol_version on resume: ack
//         'rejected', token NOT consumed, retry with stage6
//         succeeds (the SAME token rehydrates the entry).
//   I.2 — live mode + correct protocol_version on resume: token IS
//         consumed (happy-path regression — successful rebind shouldn't
//         allow another rebind on the same token, mirroring r7-#2's
//         contract that resume() is the consuming step, peek() is not).

describe('Group I — resume token survives protocol_version rejection (r7-#2)', () => {
  test('I.1 — live + missing protocol_version: token survives rejection, retry with stage6 succeeds', async () => {
    // Open under live with stage6 — mints a resume token.
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss, 'user-I');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-I1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const token = readRehydrateToken(ws1);
    mockLogger.warn.mockClear();

    // First resume attempt — protocol_version MISSING (bad client
    // state, e.g. a downgrade scenario or a malformed retry frame).
    const ws2 = connect(wss, 'user-I');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      // protocol_version omitted — live + missing must reject.
    });
    expect(ws2.close).toHaveBeenCalledWith(1002, 'protocol_version_mismatch');

    // Second resume attempt — same token, but now with stage6.
    // Without the r7-#2 fix this would fail because the token was
    // touched/consumed on the first (rejected) attempt. With the
    // fix, peek validated protocol_version BEFORE resume, the
    // rejected attempt never touched the token, and this retry
    // rehydrates the entry into ws3.
    const ws3 = connect(wss, 'user-I');
    await sendFrame(ws3, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-I1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws3);
    expect(ws3.close).not.toHaveBeenCalled();
    // No protocol_version_mismatch error envelope on the SECOND ws.
    const errorsOnWs3 = ws3._sent.filter((m) => m.type === 'error');
    expect(errorsOnWs3.length).toBe(0);
  });

  test('I.2 — happy path consumes token: a successful rebind cannot be repeated with the same token', async () => {
    // r7-#2 contract: peek validates, resume commits. The successful
    // happy path STILL consumes the token (resume() handles its own
    // LRU touch / future deletion semantics). So a second resume with
    // the same token after a successful rebind must NOT rebind a
    // second ws to the same entry. This test pins that the fix
    // doesn't accidentally make resume idempotent on the happy path
    // (which would let a leaked token bind multiple wsen to the same
    // session — a security regression).
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss, 'user-I');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-I2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const token = readRehydrateToken(ws1);

    // First resume — succeeds, rebinds to ws2.
    const ws2 = connect(wss, 'user-I');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-I2').ws).toBe(ws2);

    // Note: today's resume() implementation bumps LRU on a happy-path
    // read but does NOT delete the entry — the token can technically
    // be re-used until TTL expires or LRU evicts. This is the
    // pre-existing Wave 4c.5 contract; r7-#2 does NOT change it. The
    // assertion below is therefore intentionally weaker: a second
    // resume on the same token rebinds to ws3 (the existing
    // implementation's tolerance for re-use), but no error envelope
    // fires and the entry is healthy. A future change to make resume
    // single-use will land in a separate plan; this regression-lock
    // pins the CURRENT shape so r7-#2's peek/resume split doesn't
    // accidentally drift into either direction.
    const ws3 = connect(wss, 'user-I');
    await sendFrame(ws3, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });
    // The entry is rebound to whichever was last (ws3). No
    // protocol_version error envelope.
    const errorsOnWs3 = ws3._sent.filter((m) => m.type === 'error');
    expect(errorsOnWs3.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Group J — handshake reads SONNET_TOOL_CALLS once per request (r8-#1 + r8-#2)
// -----------------------------------------------------------------------------
//
// Plan 06-09 r8-#1 (MAJOR) — handleSessionStart reads
// process.env.SONNET_TOOL_CALLS TWICE per request:
//   1. Top-of-function: `const toolCallsMode = process.env.SONNET_TOOL_CALLS
//      || 'off';` — drives the live-reject + shadow-fallback policy block.
//   2. Reconnect branch: `existing.session.applyModeChange(
//      resolveEffectiveToolCallsMode());` — re-reads via the r6 resolver.
// If the env flips between the two reads, the entry is stamped under one
// mode (policy block writes entry.fallbackToLegacy + entry.protocolVersion)
// and the session prompt is written under the OTHER mode (applyModeChange
// writes session.toolCallsMode + systemPrompt). Split-brain entry.
//
// Plan 06-09 r8-#2 (MAJOR) — same shape on handleSessionResumeRehydrate.
//
// Group J pins the contract: the function snapshots the env exactly ONCE
// at function entry and threads that single value through both the policy
// block AND the applyModeChange call. After the fix, BOTH writes reflect
// the SAME mode regardless of an intervening env flip.
//
// Test mechanism: install a getter on process.env.SONNET_TOOL_CALLS that
// returns a FIFO sequence of values across consecutive reads, simulating
// an env flip mid-request. Pre-fix the two reads return different values
// and the entry's policy + session mode disagree. Post-fix the second
// read never happens (the snapshot is reused), so both writes use the
// same first-read value.
//
// Helper: mockEnvSequence(values) installs a getter that returns
// `values[i]` on the i-th read (clamped to the last value). The
// existing afterEach resets process.env.SONNET_TOOL_CALLS via delete /
// reassign which clears the getter back to a plain-data property.

function mockEnvSequence(values) {
  // Returns a values array consumed FIFO on each .get(). Used as the
  // property descriptor for SONNET_TOOL_CALLS so successive reads within
  // one request return different values — simulating the env flipping
  // between two reads.
  let i = 0;
  Object.defineProperty(process.env, 'SONNET_TOOL_CALLS', {
    get() {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return v;
    },
    configurable: true,
  });
}

describe('Group J — handshake reads SONNET_TOOL_CALLS once per request (r8-#1 + r8-#2)', () => {
  test('J.1 — handleSessionStart reconnect: env flip between two reads is invisible to entry', async () => {
    // Original session under shadow + match.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-J');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-J1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    expect(activeSessions.get('sess-J1').fallbackToLegacy).toBe(false);
    expect(activeSessions.get('sess-J1').session.toolCallsMode).toBe('shadow');

    // Simulate a flip BETWEEN the two reads inside the next reconnect.
    // Provide enough distinct values to expose the race: first read
    // (policy block) returns 'shadow'; subsequent reads return 'off'.
    // Pre-fix the policy treats this as shadow + match (writes
    // entry.fallbackToLegacy=false + entry.protocolVersion='stage6')
    // but applyModeChange writes session.toolCallsMode='off' AND resets
    // systemPrompt to legacy — split-brain entry.
    //
    // Post-fix the function calls resolveEffectiveToolCallsMode() ONCE
    // at entry; subsequent reads of process.env.SONNET_TOOL_CALLS don't
    // happen, so the entry is stamped consistently from the FIRST
    // sampled value.
    mockEnvSequence(['shadow', 'off', 'off']);

    const ws2 = connect(wss, 'user-J');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-J1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-J1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    // CONSISTENCY CONTRACT: whichever single mode was sampled at entry,
    // BOTH writes use it. Post-fix this should pin to the first value
    // ('shadow') because that's what the single resolveEffectiveToolCallsMode
    // call returns; pre-fix the session.toolCallsMode would be 'off'
    // (second read) while fallbackToLegacy/protocolVersion reflect
    // shadow + match — disagreeing fields.
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
    expect(entry.session.systemPrompt).toBe('agentic-prompt');
  });

  test('J.2 — handleSessionResumeRehydrate: env flip between two reads is invisible to entry', async () => {
    // Original session under shadow + match (mints a resume token).
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-J');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-J2',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });
    const token = readRehydrateToken(ws1);
    expect(activeSessions.get('sess-J2').session.toolCallsMode).toBe('shadow');

    // Resume: simulate env flip between policy read and applyModeChange
    // read. Pre-r8 the rehydrate function reads env twice (line 2072
    // policy + line 2166 applyModeChange) — split-brain entry. Post-fix
    // single snapshot at entry.
    mockEnvSequence(['shadow', 'off', 'off']);

    const ws2 = connect(wss, 'user-J');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-J2');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    // Same consistency contract as J.1: post-fix BOTH writes reflect
    // the single first-sampled value ('shadow').
    expect(entry.session.toolCallsMode).toBe('shadow');
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.protocolVersion).toBe('stage6');
    expect(entry.session.systemPrompt).toBe('agentic-prompt');
  });

  test('J.3 — invalid env value: policy + applyModeChange both fall back to off consistently', async () => {
    // Pre-r8 the policy block reads env via `|| 'off'` (no allow-list
    // sanitisation), so a value like 'garbage' falls through to no
    // matching branch (off-equivalent default). applyModeChange's
    // resolveEffectiveToolCallsMode() correctly normalises 'garbage'
    // → 'off' via the allow-list. Post-r8 the policy block ALSO uses
    // resolveEffectiveToolCallsMode(), so 'garbage' is normalised to
    // 'off' for the policy block too — single source of truth, single
    // fallback policy. The contract this pins: the off-fallback applies
    // CONSISTENTLY to both surfaces, so an off-mode entry is created
    // (no live-reject, no shadow-mismatch warn, fallbackToLegacy false).
    process.env.SONNET_TOOL_CALLS = 'garbage';
    const ws = connect(wss, 'user-J');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-J3',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-J3');
    expect(entry).toBeDefined();
    // Policy must NOT live-reject (garbage ≠ 'live').
    expect(ws.close).not.toHaveBeenCalled();
    // applyModeChange normalises to 'off'. Post-fix the policy block
    // uses the same resolver, so the entry is in a consistent off
    // state.
    expect(entry.session.toolCallsMode).toBe('off');
    // STR-01: off mode must have pristine emission state.
    expect(entry.fallbackToLegacy).toBe(false);
    // No shadow-mismatch warn fired (we're effectively off, not shadow).
    const warnCalls = mockLogger.warn.mock.calls.map(([msg]) => msg);
    expect(warnCalls).not.toContain('stage6.protocol_version_mismatch_shadow_fallback');
  });
});

// -----------------------------------------------------------------------------
// Group K — STR-01 rollback clears fallbackToLegacy on off branch (r8-#3)
// -----------------------------------------------------------------------------
//
// Plan 06-09 r8-#3 (MINOR) — both off-mode write-back branches
// (handleSessionStart reconnect at line ~1461 + handleSessionResumeRehydrate
// at line ~2141) update existing.protocolVersion / entry.protocolVersion
// but leave existing.fallbackToLegacy / entry.fallbackToLegacy untouched.
//
// After the sequence:
//   1. Original session_start under shadow + mismatch (no protocol_version)
//      → entry.fallbackToLegacy = true.
//   2. Reconnect/resume under off + anything → off-branch fires, only
//      writes protocolVersion. fallbackToLegacy stays at true from step 1.
//
// STR-01 says off mode is the rollback safe state — an entry whose
// fallbackToLegacy stays true across a shadow → off transition violates
// "off has pristine Stage 6 emission state" because the dispatcher's
// fallbackToLegacy gate (Plan 06-02 r1-#1) is shadow-only territory but
// any future code that reads entry.fallbackToLegacy WITHOUT first
// gating on entry.session.toolCallsMode === 'shadow' would suppress
// emission incorrectly.
//
// Group K pins the contract: the off-branch writes BOTH fallbackToLegacy
// = false AND protocolVersion together. Single line addition per branch
// alongside the existing protocolVersion write.

describe('Group K — STR-01 rollback clears fallbackToLegacy on off branch (r8-#3)', () => {
  test('K.1 — reconnect shadow→off: stale fallbackToLegacy is cleared', async () => {
    // Step 1: open under shadow with NO protocol_version → mismatch
    // → entry.fallbackToLegacy = true.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-K');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-K1',
      jobState: { certificateType: 'eicr' },
    });
    expect(activeSessions.get('sess-K1').fallbackToLegacy).toBe(true);

    // Step 2: operator flips shadow → off. Reconnect under off.
    // Off-branch (line 1461-1466 pre-fix) only writes protocolVersion;
    // fallbackToLegacy stays true. STR-01 violation.
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss, 'user-K');
    await sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-K1',
      jobState: { certificateType: 'eicr' },
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-K1');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    // STR-01 contract: off-mode entry must have pristine Stage 6
    // emission state. Pre-fix this is `true`; post-fix it's `false`.
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.session.toolCallsMode).toBe('off');
  });

  test('K.2 — resume shadow→off: stale entry.fallbackToLegacy is cleared', async () => {
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws1 = connect(wss, 'user-K');
    await sendFrame(ws1, {
      type: 'session_start',
      sessionId: 'sess-K2',
      jobState: { certificateType: 'eicr' },
      // No protocol_version → shadow mismatch → fallbackToLegacy=true.
    });
    expect(activeSessions.get('sess-K2').fallbackToLegacy).toBe(true);
    const token = readRehydrateToken(ws1);

    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss, 'user-K');
    await sendFrame(ws2, {
      type: 'session_resume',
      sessionId: token,
      protocol_version: 'stage6',
    });

    const entry = activeSessions.get('sess-K2');
    expect(entry).toBeDefined();
    expect(entry.ws).toBe(ws2);
    expect(entry.fallbackToLegacy).toBe(false);
    expect(entry.session.toolCallsMode).toBe('off');
  });
});
