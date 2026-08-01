/**
 * Plan A1a (2026-07-27) — test 17's WS-seam half: the §3.4c ORDERED FRAME
 * LEDGER, driven through the REAL sonnet-stream reconnect flush with a
 * send-order spy.
 *
 * The ledger (extraction → current_board_changed* → observation_update* →
 * field_corrected* → voice_command_response) is ONE shared emitter for both
 * the immediate path and flushPendingExtractions, so the ordering proven
 * here is by construction the live-path ordering too. Legs:
 *  - full-buffer replay in order (exactly one extraction PRECEDES the board
 *    field_corrected frames; VCR last);
 *  - disconnect legs at EVERY family boundary AND INTRA-family (a
 *    family-level cursor fails the intra-family legs): after a mid-sequence
 *    send failure, ONLY the unsent suffix replays on the next reconnect —
 *    no loss, no duplicates, VCR exactly once.
 *
 * Harness mirrors plan-c-p4d-batch-frames.test.js (real initSonnetStream,
 * fake WS, real session_start handlers).
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: mockCreate } })),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { ADDRESS_MIRROR_DELIVERY } = await import('../extraction/address-mirror-controller.js');

// Content signatures for OUR ledger frames — the reconnect path emits other
// frames (session acks, session_resume board banners) that must not count.
const UTT = 'utt-ledger-x';
function isLedgerFrame(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.type === 'extraction') return p.result?.utterance_id === UTT;
  if (p.type === 'current_board_changed') return p.board_id === 'bX1' || p.board_id === 'bX2';
  if (p.type === 'observation_update')
    return p.observation_id === 'obs-x1' || p.observation_id === 'obs-x2';
  if (p.type === 'field_corrected') return p.field === 'ze' || p.field === 'pfc';
  if (p.type === 'voice_command_response') return p.utterance_id === UTT;
  return false;
}

function frameKey(p) {
  if (p.type === 'extraction') return 'extraction';
  if (p.type === 'current_board_changed') return `cbc:${p.board_id}`;
  if (p.type === 'observation_update') return `obs:${p.observation_id}`;
  if (p.type === 'field_corrected') return `fc:${p.field}`;
  if (p.type === 'voice_command_response') return 'vcr';
  return 'other';
}

const EXPECTED_ORDER = [
  'extraction',
  'cbc:bX1',
  'cbc:bX2',
  'obs:obs-x1',
  'obs:obs-x2',
  'fc:ze',
  'fc:pfc',
  'vcr',
];

/** A buffered result whose ledger is 8 frames across all four families + VCR. */
function makeLedgerResult() {
  return {
    extracted_readings: [],
    observations: [],
    questions: [],
    utterance_id: UTT,
    board_ops: [
      { op: 'select_board', board_id: 'bX1' },
      { op: 'select_board', board_id: 'bX2' },
    ],
    observationUpdates: [
      { observation_id: 'obs-x1', observation_text: 'obs one', code: 'C3', regulation: null },
      { observation_id: 'obs-x2', observation_text: 'obs two', code: 'C3', regulation: null },
    ],
    field_corrections: [
      {
        type: 'field_corrected',
        circuit: null,
        field: 'ze',
        previous_value: '0.4',
        reason: 'clear_reading',
        board_id: 'main',
      },
      {
        type: 'field_corrected',
        circuit: null,
        field: 'pfc',
        previous_value: '2.3',
        reason: 'clear_reading',
        board_id: 'main',
      },
    ],
    spoken_response: 'Ze cleared.',
    action: null,
  };
}

function makeFakeWs({ failAtLedgerIndex = null, callbackFailAtLedgerIndex = null } = {}) {
  const sent = [];
  let ledgerCount = 0;
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload, callback) => {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }
      if (isLedgerFrame(parsed)) {
        if (failAtLedgerIndex !== null && ledgerCount === failAtLedgerIndex) {
          throw new Error(`injected send failure at ledger frame ${ledgerCount}`);
        }
        if (callbackFailAtLedgerIndex !== null && ledgerCount === callbackFailAtLedgerIndex) {
          callback?.(new Error(`injected callback failure at ledger frame ${ledgerCount}`));
          return;
        }
        ledgerCount += 1;
      }
      sent.push(parsed);
      callback?.();
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  // Jest mock wrappers report arity zero. Production `ws.send` exposes a
  // callback-capable signature; pin that capability in this fake so the real
  // ledger awaits callback success rather than taking its sync-stub fallback.
  Object.defineProperty(ws.send, 'length', { value: 2 });
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler for ${event}`);
    await h(data);
  };
  return ws;
}

let wss;
beforeEach(() => {
  mockCreate.mockReset();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

function connect(fakeWsOpts) {
  const ws = makeFakeWs(fakeWsOpts);
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  return ws;
}
const sendFrame = (ws, frame) => ws._emit('message', Buffer.from(JSON.stringify(frame)));

async function startSession(fakeWsOpts, capabilities) {
  const ws = connect(fakeWsOpts);
  await sendFrame(ws, {
    type: 'session_start',
    sessionId: 'sess-ledger',
    jobState: { certificateType: 'eicr' },
    ...(capabilities ? { capabilities } : {}),
  });
  return { ws, entry: activeSessions.get('sess-ledger') };
}

function ledgerFrames(ws) {
  return ws._sent.filter(isLedgerFrame).map(frameKey);
}

describe('§3.4c ordered frame ledger — reconnect flush through the REAL seam', () => {
  test('full-buffer replay: all 8 frames in ledger order; the extraction PRECEDES every board field_corrected; VCR last, exactly once', async () => {
    const { entry } = await startSession();
    entry.pendingExtractions.push(makeLedgerResult());
    const { ws: wsB } = await startSession();
    expect(ledgerFrames(wsB)).toEqual(EXPECTED_ORDER);
    expect(entry.pendingExtractions).toHaveLength(0);
    // Ordering claim stated explicitly: one extraction, before every
    // field_corrected frame.
    const keys = ledgerFrames(wsB);
    expect(keys.filter((k) => k === 'extraction')).toHaveLength(1);
    expect(keys.indexOf('extraction')).toBeLessThan(keys.indexOf('fc:ze'));
    expect(keys.filter((k) => k === 'vcr')).toHaveLength(1);
    expect(keys[keys.length - 1]).toBe('vcr');
  });

  // Disconnect legs at EVERY family boundary AND intra-family. The failure
  // index is the ledger-frame ordinal the injected send throws at:
  //   0 extraction | 1 cbc:bX1 (family boundary) | 2 cbc:bX2 (INTRA-family)
  //   3 obs:obs-x1 (boundary)  | 4 obs:obs-x2 (INTRA) | 5 fc:ze (boundary)
  //   6 fc:pfc (INTRA)         | 7 vcr (boundary)
  test.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'failure at ledger frame %i → requeued; the NEXT reconnect replays ONLY the unsent suffix (no loss, no duplicates, VCR exactly once)',
    async (failAt) => {
      const { entry } = await startSession();
      entry.pendingExtractions.push(makeLedgerResult());

      // Flush 1: the injected failure fires mid-sequence.
      const { ws: wsB } = await startSession({ failAtLedgerIndex: failAt });
      const delivered = ledgerFrames(wsB);
      expect(delivered).toEqual(EXPECTED_ORDER.slice(0, failAt));
      // The entry is re-queued with its cursor.
      expect(entry.pendingExtractions).toHaveLength(1);

      // Flush 2: clean socket — ONLY the unsent suffix replays.
      const { ws: wsC } = await startSession();
      const replayed = ledgerFrames(wsC);
      expect(replayed).toEqual(EXPECTED_ORDER.slice(failAt));
      expect(entry.pendingExtractions).toHaveLength(0);

      // Union across both flushes: every frame exactly once, in order.
      const combined = [...delivered, ...replayed];
      expect(combined).toEqual(EXPECTED_ORDER);
      expect(combined.filter((k) => k === 'vcr')).toHaveLength(1);
    }
  );

  test('the cursor never leaks onto the wire: the replayed extraction frame carries no cursor key', async () => {
    const { entry } = await startSession();
    entry.pendingExtractions.push(makeLedgerResult());
    // Fail at the VCR so the cursor is persisted on the result…
    const { ws: wsB } = await startSession({ failAtLedgerIndex: 7 });
    const extraction = wsB._sent.find((p) => p.type === 'extraction' && isLedgerFrame(p));
    // …and the already-sent extraction JSON has no cursor-shaped key (the
    // Symbol is invisible to JSON.stringify by construction).
    expect(Object.keys(extraction.result)).not.toEqual(
      expect.arrayContaining(['emissionCursor', 'cursor'])
    );
    // Complete the replay so afterEach leaves a clean store.
    await startSession();
    expect(entry.pendingExtractions).toHaveLength(0);
  });

  test('callback failure after queueing keeps the terminal owed for reconnect replay', async () => {
    const { entry } = await startSession();
    entry.pendingExtractions.push(makeLedgerResult());

    const { ws: failed } = await startSession({ callbackFailAtLedgerIndex: 7 });
    expect(ledgerFrames(failed)).toEqual(EXPECTED_ORDER.slice(0, 7));
    expect(entry.pendingExtractions).toHaveLength(1);

    const { ws: replay } = await startSession();
    expect(ledgerFrames(replay)).toEqual(['vcr']);
    expect(entry.pendingExtractions).toHaveLength(0);
  });

  test('address mirror VCR carries its stable client speech-dedupe token', async () => {
    const { entry } = await startSession();
    const result = makeLedgerResult();
    Object.defineProperty(result, ADDRESS_MIRROR_DELIVERY, {
      value: { kind: 'direct', token: 'operation-7', claimToken: 'lease-7' },
      enumerable: false,
    });
    entry.pendingExtractions.push(result);

    const { ws } = await startSession();
    const vcr = ws._sent.find((frame) => frame.type === 'voice_command_response');
    expect(vcr.address_mirror_delivery_token).toBe('direct:operation-7');
  });

  test('capable client socket flush leaves delivery pending until playback ACK', async () => {
    const { entry } = await startSession();
    const markDelivered = jest
      .spyOn(entry.addressMirrorController, 'markDelivered')
      .mockResolvedValue(true);
    const result = makeLedgerResult();
    Object.defineProperty(result, ADDRESS_MIRROR_DELIVERY, {
      value: { kind: 'direct', token: 'operation-ack-1', claimToken: 'lease-ack-1' },
      enumerable: false,
    });
    entry.pendingExtractions.push(result);

    const { ws } = await startSession(undefined, {
      voice_latency: { version: 1, supports: ['address_mirror_delivery_ack_v1'] },
    });

    expect(ledgerFrames(ws)).toEqual(EXPECTED_ORDER);
    expect(markDelivered).not.toHaveBeenCalled();
    await sendFrame(ws, {
      type: 'address_mirror_delivery_ack',
      delivery_token: 'direct:operation-ack-1',
    });
    expect(markDelivered).toHaveBeenCalledWith({
      kind: 'direct',
      token: 'operation-ack-1',
    });
    expect(entry.addressMirrorOutboxRetryHandle).toBeNull();
  });
});
