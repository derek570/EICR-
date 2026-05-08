/**
 * Integration tests for the `case 'select_board'` WS handler in
 * sonnet-stream.js (2026-05-08 multi-board sprint Phase C).
 *
 * The handler is the server-side counterpart of iOS's on-device
 * WorkOnBoardIntent ("work on the garage" / "switch to DB-2"). It
 * directly mutates `session.stateSnapshot.currentBoardId` without
 * routing through Sonnet's tool-call loop — the same precedent as
 * `case 'chitchat_resume'`. This file covers the four observable
 * outcomes:
 *
 *   1. Happy path           → ack ok=true, currentBoardId flipped
 *   2. board_not_found      → ack ok=false, snapshot untouched
 *   3. invalid_board_id     → ack ok=false, snapshot untouched
 *   4. no_active_session    → ack ok=false, snapshot untouched
 *
 * Test harness mirrors `sonnet-stream-chitchat.test.js` so failures
 * here surface in the same shape and the same FakeEICRExtractionSession
 * does both jobs.
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
    this.applyModeChange = jest.fn();
    this.extractFromUtterance = jest.fn(async () => ({
      extracted_readings: [],
      questions_for_user: [],
    }));
    // Default empty snapshot — tests that need boards mutate this on
    // the entry after startSession.
    this.stateSnapshot = { circuits: {} };
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
  return clientSessionId;
}

function getEntry(clientSessionId) {
  return activeSessions.get(clientSessionId);
}

/**
 * Seed the snapshot with two boards so select_board has somewhere to
 * land. Default currentBoardId = 'main' so the flip is observable.
 */
function seedTwoBoardSnapshot(entry) {
  entry.session.stateSnapshot = {
    boards: [
      { id: 'main', designation: 'Main Board', board_type: 'main' },
      { id: 'sub-1', designation: 'Garage', board_type: 'sub_distribution' },
    ],
    currentBoardId: 'main',
    circuits: {},
  };
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

describe('case select_board — happy path', () => {
  test('valid board_id flips currentBoardId and acks ok=true with designation', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: 'sub-1' });

    expect(entry.session.stateSnapshot.currentBoardId).toBe('sub-1');
    const acks = envelopesOfType(ws, 'select_board_ack');
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      type: 'select_board_ack',
      ok: true,
      board_id: 'sub-1',
      designation: 'Garage',
    });
  });

  // 2026-05-08 multi-board sprint Phase E — unified `current_board_changed`
  // broadcast. After the ack, the handler also emits a top-level envelope
  // that iOS uses to drive `JobViewModel.currentBoardId`. Source = 'ios'
  // distinguishes from the Sonnet-initiated path.
  test('emits current_board_changed broadcast on success (source=ios)', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: 'sub-1' });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      type: 'current_board_changed',
      board_id: 'sub-1',
      designation: 'Garage',
      source: 'ios',
    });
  });

  test('current_board_changed carries null designation when board carries none', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    entry.session.stateSnapshot = {
      boards: [
        { id: 'main', designation: 'Main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' }, // no designation
      ],
      currentBoardId: 'main',
      circuits: {},
    };

    await sendFrame(ws, { type: 'select_board', board_id: 'sub-1' });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ board_id: 'sub-1', designation: null, source: 'ios' });
  });

  test('flipping back to main is allowed and acks ok=true', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);
    entry.session.stateSnapshot.currentBoardId = 'sub-1';

    await sendFrame(ws, { type: 'select_board', board_id: 'main' });

    expect(entry.session.stateSnapshot.currentBoardId).toBe('main');
    expect(envelopesOfType(ws, 'select_board_ack')[0].ok).toBe(true);
  });

  test('idempotent — selecting current board still acks ok and emits no error', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry); // currentBoardId = 'main'

    await sendFrame(ws, { type: 'select_board', board_id: 'main' });

    expect(entry.session.stateSnapshot.currentBoardId).toBe('main');
    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: true,
      board_id: 'main',
    });
  });
});

describe('case select_board — board_not_found', () => {
  test('unknown board_id rejects with ok=false, currentBoardId untouched', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: 'sub-99' });

    expect(entry.session.stateSnapshot.currentBoardId).toBe('main');
    const acks = envelopesOfType(ws, 'select_board_ack');
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      ok: false,
      error: 'board_not_found',
      board_id: 'sub-99',
    });
  });

  // Phase E — rejection paths must NOT broadcast `current_board_changed`,
  // since the snapshot's `currentBoardId` was never flipped. Otherwise iOS
  // would think a switch happened and render the banner on the wrong board.
  test('does NOT emit current_board_changed on rejection', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: 'sub-99' });

    expect(envelopesOfType(ws, 'current_board_changed')).toHaveLength(0);
  });

  test('snapshot with no boards array rejects board_not_found', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    // FakeEICRExtractionSession's default snapshot has no boards. After
    // ensureMultiBoardShape that becomes a single legacy main board with
    // id='main', so a sub-1 lookup still fails.
    await sendFrame(ws, { type: 'select_board', board_id: 'sub-1' });

    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: false,
      error: 'board_not_found',
    });
  });
});

describe('case select_board — invalid_board_id', () => {
  test('missing board_id rejects', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board' });

    expect(entry.session.stateSnapshot.currentBoardId).toBe('main');
    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: false,
      error: 'invalid_board_id',
    });
  });

  test('non-string board_id rejects', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: 42 });

    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: false,
      error: 'invalid_board_id',
    });
  });

  test('empty-string board_id rejects', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    await sendFrame(ws, { type: 'select_board', board_id: '   ' });

    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: false,
      error: 'invalid_board_id',
    });
  });
});

describe('case select_board — no_active_session', () => {
  test('select_board before session_start rejects with no_active_session', async () => {
    const ws = connect(wss);
    // No startSession call.
    await sendFrame(ws, { type: 'select_board', board_id: 'sub-1' });

    expect(envelopesOfType(ws, 'select_board_ack')[0]).toMatchObject({
      ok: false,
      error: 'no_active_session',
    });
  });
});

// 2026-05-08 multi-board sprint Phase E — Sonnet-initiated `select_board`
// path. dispatchSelectBoard pushes `{op: 'select_board', board_id}` onto
// `perTurnWrites.boardOps`; the bundler emits `result.board_ops`; the
// extraction-send path (this batch callback or handleTranscript) then
// broadcasts `current_board_changed` so iOS reacts the same way as the
// iOS-initiated path. These tests exercise the helper via the batch
// callback hook — the same hook that fires when Sonnet's tool loop
// resolves asynchronously.
describe('Phase E — current_board_changed broadcast from Sonnet boardOps', () => {
  test('emits current_board_changed (source=sonnet) for select_board op in result.board_ops', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    // Synthesize a turn result containing a select_board op as if Sonnet's
    // dispatcher had pushed it during a tool-loop iteration.
    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      board_ops: [{ op: 'select_board', board_id: 'sub-1' }],
    });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      type: 'current_board_changed',
      board_id: 'sub-1',
      designation: 'Garage',
      source: 'sonnet',
    });
  });

  test('emits one broadcast per select_board / add_board op when multiple appear in same turn', async () => {
    // Hotfix slice 2.1 — add_board now also fires a current_board_changed
    // broadcast (with source='sonnet_add' to disambiguate from select_board).
    // Expected: 3 broadcasts for [select_board, add_board, select_board].
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    entry.session.stateSnapshot = {
      boards: [
        { id: 'main', designation: 'Main', board_type: 'main' },
        { id: 'sub-1', designation: 'Garage', board_type: 'sub_distribution' },
        { id: 'sub-2', designation: 'Annexe', board_type: 'sub_distribution' },
      ],
      currentBoardId: 'main',
      circuits: {},
    };

    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      board_ops: [
        { op: 'select_board', board_id: 'sub-1' },
        { op: 'add_board', board_id: 'sub-2', designation: 'Annexe' },
        { op: 'select_board', board_id: 'sub-2' },
      ],
    });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(3);
    expect(broadcasts[0]).toMatchObject({
      board_id: 'sub-1',
      designation: 'Garage',
      source: 'sonnet',
    });
    expect(broadcasts[1]).toMatchObject({
      board_id: 'sub-2',
      designation: 'Annexe',
      source: 'sonnet_add',
    });
    expect(broadcasts[2]).toMatchObject({
      board_id: 'sub-2',
      designation: 'Annexe',
      source: 'sonnet',
    });
  });

  test('emits current_board_changed (source=sonnet_add) for add_board op (hotfix slice 2.1)', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      board_ops: [
        {
          op: 'add_board',
          board_id: 'sub-1',
          designation: 'Garage',
          board_type: 'sub_distribution',
        },
      ],
    });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      type: 'current_board_changed',
      board_id: 'sub-1',
      designation: 'Garage',
      source: 'sonnet_add',
    });
  });

  test('does NOT broadcast when board_ops contains only mark_distribution_circuit', async () => {
    // Slice 2.1 widened the discriminator to {select_board, add_board};
    // mark_distribution_circuit and any future non-flip op stays silent.
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      board_ops: [{ op: 'mark_distribution_circuit', circuit_ref: 4, feeds_board_id: 'sub-1' }],
    });

    expect(envelopesOfType(ws, 'current_board_changed')).toHaveLength(0);
  });

  test('does NOT broadcast when board_ops slot is omitted from result', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    seedTwoBoardSnapshot(entry);

    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      // no board_ops key at all
    });

    expect(envelopesOfType(ws, 'current_board_changed')).toHaveLength(0);
  });

  test('current_board_changed carries null designation when target board has none', async () => {
    const ws = connect(wss);
    const sid = await startSession(ws);
    const entry = getEntry(sid);
    entry.session.stateSnapshot = {
      boards: [
        { id: 'main', designation: 'Main', board_type: 'main' },
        { id: 'sub-1', board_type: 'sub_distribution' }, // no designation
      ],
      currentBoardId: 'main',
      circuits: {},
    };

    entry.session.onBatchResult({
      extracted_readings: [],
      observations: [],
      board_ops: [{ op: 'select_board', board_id: 'sub-1' }],
    });

    const broadcasts = envelopesOfType(ws, 'current_board_changed');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      board_id: 'sub-1',
      designation: null,
      source: 'sonnet',
    });
  });
});
