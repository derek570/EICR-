/**
 * Integration tests for the chitchat-pause wiring in sonnet-stream.js.
 *
 * Slice 1 + 2 + 3 are unit-tested at the helper-module level
 * (`chitchat-pause.test.js`). Those tests prove the state machine is
 * correct in isolation but DO NOT prove the host (`sonnet-stream.js`)
 * calls the helpers correctly. This file fills that gap by driving the
 * actual `case 'transcript'` / `case 'session_resume'` /
 * `case 'chitchat_resume'` dispatch arms via a fake WebSocket
 * (`makeFakeWs` from the existing `sonnet-stream-resume.test.js`
 * pattern) and asserting:
 *   - paused session + plain text → transcript suppressed, replay
 *     buffer grows, no `chitchat_resumed` envelope sent
 *   - paused session + wake-word text → `chitchat_resumed` envelope
 *     sent with `reason: 'wake_word'`, paused flag cleared, buffer
 *     drained
 *   - paused session + non-empty `regexResults` → `chitchat_resumed`
 *     envelope sent with `reason: 'regex_hint'`, same state
 *     mutations
 *   - non-paused session + non-empty `regexResults` → counter resets
 *     directly (no envelope sent — session was never paused)
 *   - manual `chitchat_resume` envelope while paused → `chitchat_resumed`
 *     sent with `reason: 'manual'`
 *   - `session_resume` envelope (Deepgram doze recovery) while paused →
 *     paused flag STAYS true, no `chitchat_resumed` envelope. Deepgram
 *     doze cycles must not reset the chitchat budget — see header comment
 *     in `chitchat-pause.js` for the prod incident that motivated this.
 *
 * The session machinery is mocked the same way `sonnet-stream-resume`
 * does it (FakeEICRExtractionSession) so handleTranscript's downstream
 * calls don't reach the network — but the chitchat gate runs BEFORE
 * any `await handleTranscript`, so its observable side-effects (sent
 * envelopes + chitchatState mutations) are visible synchronously
 * regardless of whether handleTranscript itself succeeds.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);
const mockSessionInstances = [];

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
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn((newMode) => {
      const valid = newMode === 'off' || newMode === 'shadow' || newMode === 'live';
      this.toolCallsMode = valid ? newMode : 'off';
    });
    // handleTranscript will call extractFromUtterance once it gets past
    // the chitchat gate. Resolve with an empty result so the sync path
    // doesn't blow up before the chitchat assertions complete.
    this.extractFromUtterance = jest.fn(async () => ({
      extracted_readings: [],
      questions_for_user: [],
    }));
    this.stateSnapshot = { circuits: [] };
    mockSessionInstances.push(this);
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { ensureChitchatState } = await import('../extraction/chitchat-pause.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
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

function envelopesOfType(ws, type) {
  return ws._sent.filter((m) => m.type === type);
}

async function startSession(ws, clientSessionId = 'client-session-A') {
  await sendFrame(ws, {
    type: 'session_start',
    sessionId: clientSessionId,
    jobId: 'job-1',
    jobState: { certificateType: 'eicr' },
  });
  return clientSessionId; // activeSessions is keyed by the client-supplied id
}

function getEntry(clientSessionId) {
  return activeSessions.get(clientSessionId);
}

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  mockSessionInstances.length = 0;
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('case transcript — paused session, plain text → suppressed', () => {
  test('text is buffered, no chitchat_resumed envelope, paused flag stays true', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);
    cc.paused = true;
    cc.pausedAt = Date.now();

    await sendFrame(ws, { type: 'transcript', text: 'just having a chat about the weather' });

    expect(cc.paused).toBe(true);
    expect(cc.replayBuffer).toHaveLength(1);
    expect(cc.replayBuffer[0].text).toBe('just having a chat about the weather');
    expect(envelopesOfType(ws, 'chitchat_resumed')).toEqual([]);
  });
});

describe('case transcript — paused session, wake word → resumed with replay drain', () => {
  test('emits chitchat_resumed reason wake_word, clears paused, drains buffer', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);

    // Pre-populate the buffer to simulate prior suppressed transcripts.
    cc.paused = true;
    cc.pausedAt = Date.now();
    cc.replayBuffer.push({ ts: Date.now(), text: 'kitchen sockets are 0.13 ohms' });

    await sendFrame(ws, { type: 'transcript', text: 'carry on now' });

    expect(cc.paused).toBe(false);
    expect(cc.replayBuffer).toEqual([]); // drained
    const resumed = envelopesOfType(ws, 'chitchat_resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0].reason).toBe('wake_word');
  });
});

describe('case transcript — paused session, regex hit → resumed with reason regex_hint', () => {
  test('non-empty regexResults wakes regardless of text content', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);

    cc.paused = true;
    cc.pausedAt = Date.now();

    await sendFrame(ws, {
      type: 'transcript',
      text: 'point one three ohms',
      regexResults: [{ field: 'r1_r2', value: '0.13' }],
    });

    expect(cc.paused).toBe(false);
    const resumed = envelopesOfType(ws, 'chitchat_resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0].reason).toBe('regex_hint');
  });
});

describe('case transcript — non-paused session, regex hit → counter resets directly', () => {
  // The regex-hit reset (slice 2) runs at transcript-receipt time
  // BEFORE the Sonnet round-trip. The post-extraction recordTurn hook
  // can then tick the counter back up if Sonnet returned no
  // engagement signal — that's expected, the regex-hit path
  // doesn't claim to suppress the post-extraction tick. What we
  // assert here is the ATOMIC reset: counter went from 7 down toward
  // 0 thanks to the regex-hit path, not "stayed at 7" or "went to 8".
  // The post-extraction tick of 0→1 is acceptable.
  test('regex-hit on non-paused session drops counter from 7 to ≤1', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);
    cc.turnsSinceExtraction = 7;

    await sendFrame(ws, {
      type: 'transcript',
      text: 'ze is point three two',
      regexResults: [{ field: 'ze', value: '0.32' }],
    });

    expect(cc.paused).toBe(false);
    // Started at 7; regex-hit reset to 0; post-extraction tick may
    // push it back up by 1 if FakeSession returns empty (it does).
    // What MUST NOT happen: counter stayed near 7 or grew further.
    expect(cc.turnsSinceExtraction).toBeLessThanOrEqual(1);
    expect(envelopesOfType(ws, 'chitchat_resumed')).toEqual([]);
    expect(envelopesOfType(ws, 'chitchat_paused')).toEqual([]);
  });
});

describe('case chitchat_resume — manual wake from iOS Resume button', () => {
  test('paused session → resumed envelope reason manual, paused cleared', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);
    cc.paused = true;
    cc.pausedAt = Date.now();

    await sendFrame(ws, { type: 'chitchat_resume' });

    expect(cc.paused).toBe(false);
    const resumed = envelopesOfType(ws, 'chitchat_resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0].reason).toBe('manual');
  });

  test('non-paused session → no-op (no envelope)', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);
    expect(cc.paused).toBe(false);

    await sendFrame(ws, { type: 'chitchat_resume' });

    expect(envelopesOfType(ws, 'chitchat_resumed')).toEqual([]);
  });
});

describe('case session_resume — Deepgram doze recovery does NOT wake chitchat', () => {
  // Regression for prod session D8E51F51 (2026-05-09): the chitchat pause
  // fired correctly at turn 8 with the inspector's phone in his pocket,
  // then was immediately undone by `session_resume` 215s later when
  // Deepgram came back from doze. Counter restarted from 0 and the
  // "ferry-situation" protection (bounded chitchat → bounded Sonnet cost)
  // was effectively defeated. Wake is now semantic-only.
  test('legacy wake (no sessionId) on paused chitchat → paused stays true, no envelope', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    const cc = ensureChitchatState(entry);
    cc.paused = true;
    cc.pausedAt = Date.now();
    await sendFrame(ws, { type: 'session_resume' });

    expect(cc.paused).toBe(true);
    expect(envelopesOfType(ws, 'chitchat_resumed')).toEqual([]);
    // The session-level resume ack still fires (Deepgram doze recovery
    // is a separate concern from chitchat — only the chitchat hook is
    // dropped). Asserts the doze recovery itself wasn't broken.
    const acks = envelopesOfType(ws, 'session_ack').filter((e) => e.status === 'resumed');
    expect(acks).toHaveLength(1);
  });
});
