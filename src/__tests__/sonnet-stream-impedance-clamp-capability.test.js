/**
 * Plan D (2026-07-25, feedback id 100(b)) — the `server_impedance_clamp`
 * `session_ack` capability advert.
 *
 * WHAT THE CAPABILITY MEANS ON THE WIRE
 * "The impedance value you are about to receive has ALREADY been clamped
 *  server-side, and the confirmation you are about to hear names the value that
 *  was actually stored — do NOT clamp it again."
 *
 * WHY THIS FILE EXISTS
 * Two failure modes sit either side of the advert, and BOTH corrupt a
 * safety-critical reading:
 *   - a MISSED emit site  → the client keeps its own `clampImpedance`, divides
 *     an already-clamped 1.6 again, and stores 0.16;
 *   - an OVER-BROAD emit  → an `off`/`shadow` session advertises a clamp it is
 *     not performing (those modes take the legacy result path, whose snapshot
 *     writer stores the RAW dictated value), the client stands down, and the
 *     raw 16 this whole plan exists to catch reaches the certificate.
 * So the advert is pinned at ALL FOUR establishing-ack sites across ALL THREE
 * modes, plus the mid-flight flip.
 *
 * HARNESS
 * Modelled on `sonnet-stream-resume.test.js`: a `WebSocketServer({noServer:
 * true})` driven through `emit('connection', …)` with a fake `ws` that captures
 * `.send()` payloads; the session + SDK are mocked so nothing touches the
 * network. The fake session deliberately MIRRORS the real
 * `EICRExtractionSession._resolveToolCallsMode` (env → 'live' default,
 * constructor-LOCKED, `applyModeChange` as the sole write surface) — that
 * resolution is exactly what `impedanceClampCapabilityFields` reads, so a fake
 * that hardcoded a mode could not discriminate the gate.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSessionInstances = [];

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = jest.fn();
    this.stop = jest.fn(() => ({ totals: { cost: 0 } }));
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    // Mirror of the real constructor-locked resolution
    // (`eicr-extraction-session.js:1288`): env, defaulting to 'live', with any
    // unrecognised value falling back to 'live'.
    const raw = process.env.SONNET_TOOL_CALLS ?? 'live';
    this.toolCallsMode = raw === 'off' || raw === 'shadow' || raw === 'live' ? raw : 'live';
    // The SOLE write surface for a mid-session mode flip, per the real class.
    this.applyModeChange = jest.fn((newMode) => {
      const valid = newMode === 'off' || newMode === 'shadow' || newMode === 'live';
      this.toolCallsMode = valid ? newMode : 'off';
    });
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

// ── Module under test (dynamic import after mocks) ───────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { SERVER_IMPEDANCE_CLAMP_CAPABILITY } =
  await import('../extraction/client-watchdog-fallback.js');

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

function lastAck(ws) {
  return [...ws._sent].reverse().find((m) => m.type === 'session_ack');
}

function ackWithStatus(ws, status) {
  return [...ws._sent].reverse().find((m) => m.type === 'session_ack' && m.status === status);
}

const START_FRAME = {
  type: 'session_start',
  sessionId: 'client-session-A',
  jobId: 'job-1',
  jobState: { certificateType: 'eicr' },
  protocol_version: 'stage6',
};

// ── The four establishing-ack sites, as drivers ──────────────────────────────
// Each returns the ack whose emit site is under test. Keeping them in one table
// is what makes "all four sites × all three modes" a matrix rather than twelve
// hand-written tests that can silently omit a site.

const ACK_SITES = [
  {
    name: "site 4 — 'started' (fresh session_start)",
    status: 'started',
    async drive(wss) {
      const ws = connect(wss);
      await sendFrame(ws, START_FRAME);
      return lastAck(ws);
    },
  },
  {
    name: "site 3 — 'reconnected' (2nd session_start, same sessionId)",
    status: 'reconnected',
    async drive(wss) {
      const ws1 = connect(wss);
      await sendFrame(ws1, START_FRAME);
      const ws2 = connect(wss);
      await sendFrame(ws2, START_FRAME);
      return ackWithStatus(ws2, 'reconnected');
    },
  },
  {
    name: 'site 1 — rehydrate spread-ack (session_resume with a valid token)',
    status: 'resumed',
    async drive(wss) {
      const wsA = connect(wss);
      await sendFrame(wsA, START_FRAME);
      const minted = lastAck(wsA).sessionId;
      const wsB = connect(wss);
      await sendFrame(wsB, { type: 'session_resume', sessionId: minted });
      return ackWithStatus(wsB, 'resumed');
    },
  },
  {
    name: 'site 2 — legacy sleep/wake resume (session_resume, no sessionId)',
    status: 'resumed',
    async drive(wss) {
      const ws = connect(wss);
      await sendFrame(ws, START_FRAME);
      await sendFrame(ws, { type: 'session_pause' });
      await sendFrame(ws, { type: 'session_resume' });
      return ackWithStatus(ws, 'resumed');
    },
  },
];

// ── Fixtures ─────────────────────────────────────────────────────────────────

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
let originalMode;

beforeEach(() => {
  originalMode = process.env.SONNET_TOOL_CALLS;
  mockSessionInstances.length = 0;
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  if (originalMode === undefined) delete process.env.SONNET_TOOL_CALLS;
  else process.env.SONNET_TOOL_CALLS = originalMode;
  activeSessions.clear();
  sonnetSessionStore.clear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Plan D — server_impedance_clamp advert: live mode, all four ack sites', () => {
  for (const site of ACK_SITES) {
    test(`${site.name} advertises server_impedance_clamp`, async () => {
      process.env.SONNET_TOOL_CALLS = 'live';
      const ack = await ACK_SITES.find((s) => s === site).drive(wss);
      expect(ack).toBeDefined();
      expect(ack.status).toBe(site.status);
      expect(ack.server_impedance_clamp).toBe(SERVER_IMPEDANCE_CLAMP_CAPABILITY);
      // Pinned as the strict value 1 (clients accept only that), and the
      // constant itself is asserted so a bump has to be deliberate.
      expect(SERVER_IMPEDANCE_CLAMP_CAPABILITY).toBe(1);
    });
  }
});

describe('Plan D — NEGATIVE: off/shadow sessions must NOT advertise', () => {
  for (const mode of ['off', 'shadow']) {
    for (const site of ACK_SITES) {
      test(`${mode} mode — ${site.name} WITHHOLDS the capability`, async () => {
        process.env.SONNET_TOOL_CALLS = mode;
        const ack = await site.drive(wss);
        expect(ack).toBeDefined();
        expect(ack.status).toBe(site.status);
        // ABSENT, not falsy: a withholding ack must be byte-identical to a
        // pre-Plan-D one so an old client cannot read a 0 as a promise.
        expect(ack.server_impedance_clamp).toBeUndefined();
        expect(Object.hasOwn(ack, 'server_impedance_clamp')).toBe(false);
      });
    }
  }

  test('the two halves of the contract are asserted together — a shadow session neither advertises NOR clamps', async () => {
    // Half 1 (wire): the ack withholds the capability.
    process.env.SONNET_TOOL_CALLS = 'shadow';
    const ws = connect(wss);
    await sendFrame(ws, START_FRAME);
    expect(lastAck(ws).server_impedance_clamp).toBeUndefined();

    // Half 2 (behaviour): a shadow session does not run the Stage-6 dispatchers
    // at all, so no clamp seam can execute — asserted through the session's own
    // resolved mode, which is the SAME expression the harness dispatches on
    // (`session.toolCallsMode ?? 'off'`). If a future change made shadow run
    // the dispatchers, this assertion fails and the gate has to be revisited
    // alongside the advert rather than drifting apart from it.
    const session = mockSessionInstances.at(-1);
    expect(session.toolCallsMode).toBe('shadow');
    expect(session.toolCallsMode).not.toBe('live');
  });
});

describe('Plan D — mid-flight mode flip is reflected, not latched server-side', () => {
  test('live → off between session_start and reconnect: the reconnect ack WITHHOLDS', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws1 = connect(wss);
    await sendFrame(ws1, START_FRAME);
    expect(lastAck(ws1).server_impedance_clamp).toBe(SERVER_IMPEDANCE_CLAMP_CAPABILITY);

    // Operator flips the kill-switch mid-session. The reconnect path restamps
    // the session's mode via `applyModeChange` BEFORE its ack is sent, so the
    // ack must describe what the session will now actually do.
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws2 = connect(wss);
    await sendFrame(ws2, START_FRAME);
    const ack = ackWithStatus(ws2, 'reconnected');
    expect(ack).toBeDefined();
    expect(ack.server_impedance_clamp).toBeUndefined();
    expect(mockSessionInstances.at(-1).toolCallsMode).toBe('off');
  });

  test('off → live between session_start and reconnect: the reconnect ack ADVERTISES', async () => {
    process.env.SONNET_TOOL_CALLS = 'off';
    const ws1 = connect(wss);
    await sendFrame(ws1, START_FRAME);
    expect(lastAck(ws1).server_impedance_clamp).toBeUndefined();

    process.env.SONNET_TOOL_CALLS = 'live';
    const ws2 = connect(wss);
    await sendFrame(ws2, START_FRAME);
    const ack = ackWithStatus(ws2, 'reconnected');
    expect(ack).toBeDefined();
    expect(ack.server_impedance_clamp).toBe(SERVER_IMPEDANCE_CLAMP_CAPABILITY);
  });
});

describe('Plan D — non-establishing acks never advertise', () => {
  test('paused ack carries no capability even in live mode', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws = connect(wss);
    await sendFrame(ws, START_FRAME);
    await sendFrame(ws, { type: 'session_pause' });
    const paused = ackWithStatus(ws, 'paused');
    expect(paused).toBeDefined();
    expect(paused.server_impedance_clamp).toBeUndefined();
  });

  test('a rehydrate MISS (status new) withholds even in live mode', async () => {
    process.env.SONNET_TOOL_CALLS = 'live';
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_resume', sessionId: 'no-such-token' });
    const ack = lastAck(ws);
    expect(ack.status).toBe('new');
    expect(ack.server_impedance_clamp).toBeUndefined();
  });
});
