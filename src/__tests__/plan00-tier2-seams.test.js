/**
 * Plan 00B-2 C2 — Tier-2 FOCUSED integration evidence (the parent finding
 * 3's wiring proof — deliberately NOT the corpus gate: the nine frozen
 * fixtures cannot traverse the dialogue-script or address-mirror channels,
 * so those two families are proven here through the REAL captured WS
 * listener).
 *
 * (a) Dialogue: an explicitly TRIGGERING transcript proves one
 *     produced/emitted `srv-*` ask, the two-half frame+transcript
 *     resolution, operation-backed spoken delivery with its descriptor
 *     binding, and focused negatives (half-answers, send failure,
 *     non-mutating info kinds unbound).
 * (b) Address-mirror: through the real listener with an injected
 *     controller, the direct-question lifecycle (same-id reissue on
 *     reconnect replay), the accepted `address_mirror_delivery_ack`, and
 *     focused negatives (wrong token, failed send).
 * (c) The C3 round_usage sink through a REAL CostTracker.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockSessionInstances = [];

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.utteranceBuffer = [];
    // A realistically-shaped snapshot: the dialogue engine writes through
    // the REAL snapshot mutators, which expect the multi-board shape.
    this.stateSnapshot = {
      boards: [],
      circuits: [],
      currentBoardId: null,
      observations: [],
    };
    this.costTracker = {
      toCostUpdate: () => ({ type: 'cost_update', cost: 0 }),
      inFlightBillableInvocationCount: 0,
      usageRevision: 0,
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.extractFromUtterance = jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions_for_user: [],
    }));
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
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

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { EVALUATION_CONTEXT, PLAN00_ROUND_USAGE_SINK } =
  await import('../extraction/plan00-lifecycle-hooks.js');
const { createAskLedger, createDeliveryLedger } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { createMutationObserver } = await import('../extraction/plan00-semantic-capture.js');
const { CostTracker } = await import('../extraction/cost-tracker.js');
const { attributeRoundUsage } = await import('../extraction/round-usage-attribution.js');

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

function makeFullContextFactory(sessionIdHint = null) {
  const roles = {
    observer: null,
    mutationObserver: createMutationObserver({ sessionId: sessionIdHint }),
    askLedger: createAskLedger(),
    deliveryLedger: createDeliveryLedger(),
  };
  return { factory: () => roles, roles };
}

let utteranceCounter = 0;
function transcriptFrame(sessionId, text) {
  utteranceCounter += 1;
  return {
    type: 'transcript',
    sessionId,
    text,
    is_final: true,
    utterance_id: `utt-${utteranceCounter}`,
  };
}

beforeEach(() => {
  mockSessionInstances.length = 0;
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  utteranceCounter = 0;
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

describe('Tier-2 (a) — dialogue-script family through the REAL WS listener', () => {
  test('a triggering transcript produces + emits exactly one srv-* ask; a half-answer never closes it; the two-half join resolves it', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-t2-1', jobState: {} });
    const entry = activeSessions.get('sess-t2-1');
    expect(entry[EVALUATION_CONTEXT]).toBeTruthy();

    // Trigger the ring-continuity script — the engine emits its first
    // srv-* ask through safeSend, which the sibling observers capture.
    await sendFrame(ws, transcriptFrame('sess-t2-1', 'Ring continuity for circuit 4.'));
    const askFrames = ws._sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('srv-')
    );
    expect(askFrames.length).toBeGreaterThanOrEqual(1);
    const firstAsk = askFrames[0];
    const ledgerEntry = roles.askLedger.entries.find((e) => e.runtime_id === firstAsk.tool_call_id);
    expect(ledgerEntry).toBeTruthy();
    expect(ledgerEntry.state).toBe('emitted');
    expect(ledgerEntry.history).toEqual(['produced', 'emitted']);
    expect(roles.askLedger.invalid).toBeNull();

    // HALF-ANSWER negative: the answer FRAME alone (srv-* branch keeps its
    // immediate break) never closes the ask.
    await sendFrame(ws, {
      type: 'ask_user_answered',
      sessionId: 'sess-t2-1',
      tool_call_id: firstAsk.tool_call_id,
      user_text: '0.31',
      consumed_utterance_id: 'utt-answer-1',
    });
    expect(roles.askLedger.entries.find((e) => e.runtime_id === firstAsk.tool_call_id).state).toBe(
      'emitted'
    );

    // The paired transcript (same utterance id) that the engine CONSUMES
    // resolves the join — terminal only when BOTH halves exist.
    utteranceCounter += 1;
    await sendFrame(ws, {
      type: 'transcript',
      sessionId: 'sess-t2-1',
      text: '0.31',
      is_final: true,
      utterance_id: 'utt-answer-1',
    });
    const resolved = roles.askLedger.entries.find((e) => e.runtime_id === firstAsk.tool_call_id);
    expect(resolved.state).toBe('answered');
    expect(resolved.terminal_detail.transcript_resolved).toBe(true);
    expect(roles.askLedger.invalid).toBeNull();
  });

  test('send failure (closed ws) leaves an OPEN produced entry — the silent-ask evidence', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-t2-2', jobState: {} });
    // Close the socket UNDER the engine: safeSend's readyState gate skips
    // the send, so produced is recorded and emitted never is.
    ws.readyState = 3;
    await sendFrame(ws, transcriptFrame('sess-t2-2', 'Ring continuity for circuit 7.'));
    const produced = roles.askLedger.entries.filter((e) => e.state === 'produced');
    expect(produced.length).toBeGreaterThanOrEqual(1);
    expect(roles.askLedger.entries.some((e) => e.state === 'emitted')).toBe(false);
  });

  test('completing the script yields an operation-backed spoken delivery with its descriptor binding', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-t2-3', jobState: {} });

    await sendFrame(ws, transcriptFrame('sess-t2-3', 'Ring continuity for circuit 4.'));
    // Answer the three ring slots; the engine advances one slot per turn.
    await sendFrame(ws, transcriptFrame('sess-t2-3', '0.31'));
    await sendFrame(ws, transcriptFrame('sess-t2-3', '0.29'));
    await sendFrame(ws, transcriptFrame('sess-t2-3', '0.52'));
    // Ring's confirmation gate: accept.
    await sendFrame(ws, transcriptFrame('sess-t2-3', 'Yes, all correct.'));

    // The completion read-back is a multi-operation audibility unit bound
    // to the slots the script wrote.
    const dialogueDeliveries = roles.deliveryLedger.deliveries.filter(
      (d) => d.transport === 'dialogue_ws'
    );
    expect(dialogueDeliveries.length).toBeGreaterThanOrEqual(1);
    expect(dialogueDeliveries[0].op_keys.length).toBeGreaterThanOrEqual(1);
    expect(roles.deliveryLedger.invalid).toBeNull();
  });
});

describe('Tier-2 (b) — address-mirror family through the REAL listener with an injected controller', () => {
  function injectFakeController(entry, overrides = {}) {
    entry.addressMirrorController = {
      currentDirectQuestion: async () => null,
      claimLegacyQuestion: (q) => q,
      rehydrate: async () => {},
      shouldHoldReplyTranscript: async () => false,
      noteReplyHoldReleased: () => {},
      resolveRecoveredAnswer: async () => ({ handled: false }),
      resolveDirectClarification: async () => ({ handled: false }),
      resolvePendingDirectCommand: async () => ({ handled: false }),
      applyDirectCommand: async () => ({ handled: false }),
      recoverUndelivered: async () => ({ handled: false }),
      markDelivered: async () => true,
      ...overrides,
    };
  }

  test('direct-question lifecycle: produced+emitted on first send, reissued_attempt on the reconnect replay (same id, no second produced)', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-1', jobState: {} });
    const entry = activeSessions.get('sess-am-1');
    const directQuestion = {
      question: 'What is the installation address and postcode?',
      questionId: 'address-mirror-direct-tok-1',
      outcome: 'incomplete',
    };
    injectFakeController(entry, { currentDirectQuestion: async () => directQuestion });

    // Reconnect replays the pending direct question through the REAL
    // reconnect branch (sendAddressMirrorDirectQuestion post-send seam).
    const ws2 = connect(wss);
    await sendFrame(ws2, { type: 'session_start', sessionId: 'sess-am-1', jobState: {} });
    const row = roles.askLedger.entries.find((e) => e.runtime_id === 'address-mirror-direct-tok-1');
    expect(row).toBeTruthy();
    expect(row.state).toBe('emitted');
    expect(row.history).toEqual(['produced', 'emitted']);

    // A SECOND replay of the same id appends a reissued attempt to the SAME
    // open entry — never a second produced row, never a terminal.
    const ws3 = connect(wss);
    await sendFrame(ws3, { type: 'session_start', sessionId: 'sess-am-1', jobState: {} });
    const after = roles.askLedger.entries.filter(
      (e) => e.runtime_id === 'address-mirror-direct-tok-1'
    );
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe('emitted');
    expect(after[0].history).toEqual(['produced', 'emitted', 'reissued_attempt']);
    expect(roles.askLedger.invalid).toBeNull();
  });

  test('the controller transition accepting a matching answer closes the address-mirror ask', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-2', jobState: {} });
    const entry = activeSessions.get('sess-am-2');
    const directQuestion = {
      question: 'The client address is already different. Should I replace it?',
      questionId: 'address-mirror-direct-tok-2',
      outcome: 'conflict',
    };
    injectFakeController(entry, {
      currentDirectQuestion: async () => directQuestion,
      resolveRecoveredAnswer: async () => ({
        handled: true,
        outcome: 'yes',
        clearAskId: 'address-mirror-direct-tok-2',
        resolutionToken: 'rt-1',
        changed: [],
        replayedSource: 0,
      }),
    });
    // First get the ask produced/emitted via the reconnect replay.
    const ws2 = connect(wss);
    await sendFrame(ws2, { type: 'session_start', sessionId: 'sess-am-2', jobState: {} });
    // Answer via the ask_user_answered recovery path (no live registry ask).
    await sendFrame(ws2, {
      type: 'ask_user_answered',
      sessionId: 'sess-am-2',
      tool_call_id: 'address-mirror-direct-tok-2',
      user_text: 'Yes',
    });
    const row = roles.askLedger.entries.find((e) => e.runtime_id === 'address-mirror-direct-tok-2');
    expect(row.state).toBe('answered');
    expect(roles.askLedger.invalid).toBeNull();
  });

  test('address_mirror_delivery_ack: accepted token records ONE playback start against its unit; wrong token stays non-authoritative', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-3', jobState: {} });
    const entry = activeSessions.get('sess-am-3');
    injectFakeController(entry, { markDelivered: async () => true });
    const ctx = entry[EVALUATION_CONTEXT];
    // A collapsed multi-write terminal unit, keyed by its claim lineage.
    ctx.recordAddressMirrorTerminal({
      claimLineage: 'convenience:tok-3',
      ops: [
        { extractionTurnId: 't1', field: 'client_address', circuit: null, boardId: null },
        { extractionTurnId: 't1', field: 'client_postcode', circuit: null, boardId: null },
      ],
    });
    expect(roles.deliveryLedger.deliveries).toHaveLength(1);
    expect(roles.deliveryLedger.deliveries[0].op_keys).toHaveLength(2);

    // Wrong token: markDelivered accepts but no unit correlates — nothing
    // recorded, nothing invalid.
    await sendFrame(ws, {
      type: 'address_mirror_delivery_ack',
      sessionId: 'sess-am-3',
      delivery_token: 'convenience:tok-OTHER',
    });
    expect(roles.deliveryLedger.playbacks).toHaveLength(0);
    expect(roles.deliveryLedger.invalid).toBeNull();

    // Accepted token: exactly one playback start against the unit.
    await sendFrame(ws, {
      type: 'address_mirror_delivery_ack',
      sessionId: 'sess-am-3',
      delivery_token: 'convenience:tok-3',
    });
    expect(roles.deliveryLedger.playbacks).toHaveLength(1);
    // Byte-identical retransmission dedupes to the same single start.
    await sendFrame(ws, {
      type: 'address_mirror_delivery_ack',
      sessionId: 'sess-am-3',
      delivery_token: 'convenience:tok-3',
    });
    expect(roles.deliveryLedger.playbacks).toHaveLength(1);
  });

  test('rejected/stale token (markDelivered false) never reaches the evaluation forwarding hook', async () => {
    const { factory, roles } = makeFullContextFactory();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-4', jobState: {} });
    const entry = activeSessions.get('sess-am-4');
    injectFakeController(entry, { markDelivered: async () => false });
    entry[EVALUATION_CONTEXT].recordAddressMirrorTerminal({
      claimLineage: 'direct:tok-4',
      ops: [{ extractionTurnId: 't1', field: 'client_address', circuit: null, boardId: null }],
    });
    await sendFrame(ws, {
      type: 'address_mirror_delivery_ack',
      sessionId: 'sess-am-4',
      delivery_token: 'direct:tok-4',
    });
    expect(roles.deliveryLedger.playbacks).toHaveLength(0);
  });
});

describe('C3 — round_usage sub-records through a REAL CostTracker', () => {
  function buildRow(overrides = {}) {
    return attributeRoundUsage({
      provider: 'openai',
      requestedModel: 'gpt-5.6-terra',
      requestedTier: 'standard',
      responseModel: 'gpt-5.6-terra',
      responseTier: 'standard',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      roundIdx: 0,
      reasoningEffort: 'low',
      ...overrides,
    });
  }

  async function makeContextEntry(sessionId) {
    const { factory, roles } = makeFullContextFactory(sessionId);
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId, jobState: {} });
    const entry = activeSessions.get(sessionId);
    return { entry, roles, ws };
  }

  test('one canonical PII-free round_usage sub-record per accepted round row, discriminator pinned', async () => {
    const { entry } = await makeContextEntry('sess-ru-1');
    const tracker = new CostTracker();
    Object.defineProperty(tracker, PLAN00_ROUND_USAGE_SINK, {
      value: (row, meta) => entry[EVALUATION_CONTEXT].roundUsageSink(row, meta),
      enumerable: false,
      configurable: true,
    });
    // A raw row smuggling a `kind` key can NEVER overwrite the round_usage
    // discriminator — the detail is HAND-BUILT allowlisted, never a spread.
    const rows = [buildRow(), { ...buildRow({ roundIdx: 1 }), kind: 'evil_kind' }];
    expect(tracker.ingestBillableUsage('loop-1', rows, 'inspector_live')).toBe(true);
    const subRows = entry.session
      ? entry[EVALUATION_CONTEXT].entryRef[
          Object.getOwnPropertySymbols(entry).find(
            (s) => s.description === 'plan00.lifecycleLedger'
          )
        ].subRecords.filter((r) => r.kind === 'round_usage')
      : [];
    expect(subRows).toHaveLength(2);
    for (const r of subRows) {
      expect(r.kind).toBe('round_usage');
      expect(r.billable_kind).toBe('inspector_live');
      expect(r.loop_invocation_id).toBe('loop-1');
      expect(r.provider).toBe('openai');
      expect(r.reasoning_effort).toBe('low');
      // PII-safety: the allowlist carries no free text.
      expect(r.transcript).toBeUndefined();
      expect(r.validation_error).toBeUndefined();
    }
    expect(subRows.map((r) => r.round_idx)).toEqual([0, 1]);

    // The call-level loop_invocation_id dedupe is the exactly-once guard.
    expect(tracker.ingestBillableUsage('loop-1', rows, 'inspector_live')).toBe(false);
    const after = entry[EVALUATION_CONTEXT].entryRef[
      Object.getOwnPropertySymbols(entry).find((s) => s.description === 'plan00.lifecycleLedger')
    ].subRecords.filter((r) => r.kind === 'round_usage');
    expect(after).toHaveLength(2);
  });

  test('keepalive/orphan-review rows carry their billable_kind — the 00C counting-rule negatives', async () => {
    const { entry } = await makeContextEntry('sess-ru-2');
    const tracker = new CostTracker();
    Object.defineProperty(tracker, PLAN00_ROUND_USAGE_SINK, {
      value: (row, meta) => entry[EVALUATION_CONTEXT].roundUsageSink(row, meta),
      enumerable: false,
      configurable: true,
    });
    tracker.ingestBillableUsage('loop-ka', [buildRow()], 'cache_keepalive');
    tracker.ingestBillableUsage('loop-or', [buildRow()], 'orphan_review');
    const ledger =
      entry[
        Object.getOwnPropertySymbols(entry).find((s) => s.description === 'plan00.lifecycleLedger')
      ];
    const kinds = ledger.subRecords
      .filter((r) => r.kind === 'round_usage')
      .map((r) => r.billable_kind);
    expect(kinds).toEqual(['cache_keepalive', 'orphan_review']);
  });

  test('dormant tracker (no sink Symbol) ingests identically with zero evaluation side-effects', () => {
    const tracker = new CostTracker();
    expect(tracker.ingestBillableUsage('loop-x', [buildRow()], 'inspector_live')).toBe(true);
    expect(tracker.roundUsageEvidence).toHaveLength(1);
  });
});

describe('Tier-2 (b2) — Codex r2 finding 1: the REAL controller through the REAL seams', () => {
  test('a direct mirror command produces receipt-backed unit identities (no fabricated ops, observer VALID)', async () => {
    const { factory, roles } = makeFullContextFactory('sess-am-real');
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    // NO jobId in jobState → the entry's REAL controller runs LOCAL-mode
    // (zero DB); this test deliberately does NOT inject a fake controller —
    // the whole point is that stageBoardWrite's snapshot mutations traverse
    // the real atoms under the new mirror-region turn-scope/origin bracket.
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-real', jobState: {} });
    const entry = activeSessions.get('sess-am-real');
    expect(entry.addressMirrorController).toBeTruthy();
    // Seed a complete SITE address the way pre-recorded job state would.
    entry.session.stateSnapshot.circuits[0] = {
      address: '12 High Street',
      postcode: 'AB1 2CD',
    };
    await sendFrame(ws, transcriptFrame('sess-am-real', 'Same address for the client'));

    // The controller's writes committed through the REAL atoms under an
    // open evaluation turn scope with a declared origin — the capture is
    // VALID and every receipt carries a real turn identity.
    expect(roles.mutationObserver.invalid).toBeNull();
    const mirrorReceipts = roles.mutationObserver.receipts.filter((r) =>
      String(r.field ?? '').startsWith('client_')
    );
    expect(mirrorReceipts.length).toBeGreaterThanOrEqual(2);
    for (const r of mirrorReceipts) {
      expect(typeof r.extraction_turn_id).toBe('string');
      expect(r.extraction_turn_id.length).toBeGreaterThan(0);
    }

    // Exactly ONE mirror unit, and its op_keys are the receipts' own
    // canonical identities (turn + ordinal), never invented {null, 0} keys.
    const units = roles.deliveryLedger.deliveries.filter(
      (d) => d.kind === 'address_mirror_terminal'
    );
    expect(units).toHaveLength(1);
    const ids = (units[0].op_keys ?? []).map((k) => JSON.parse(k));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(typeof id.turn).toBe('string');
      expect(id.turn.length).toBeGreaterThan(0);
    }
    expect(roles.deliveryLedger.invalid).toBeNull();
  });
});

describe('Tier-2 (b3) — mini-review r2 concern 1: the RECOVERY region bracket', () => {
  test('an ask_user_answered mirror recovery write commits under a turn scope with a declared origin', async () => {
    const { factory, roles } = makeFullContextFactory('sess-am-rec');
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-rec', jobState: {} });
    const entry = activeSessions.get('sess-am-rec');
    // The controller transition is faked; the WRITE goes through the REAL
    // atom against the REAL observed snapshot INSIDE the recovery region —
    // exactly the mutation shape stageBoardWrite performs. Pre-bracket this
    // latched `commit_without_origin_frame` with a null turn.
    const { applyBoardReadingFlagAware } =
      await import('../extraction/stage6-snapshot-mutators.js');
    entry.addressMirrorController = {
      resolveRecoveredAnswer: async () => {
        applyBoardReadingFlagAware(entry.session.stateSnapshot, {
          field: 'client_address',
          value: '99 Recovery Road',
          boardId: null,
        });
        return { handled: true, outcome: 'duplicate', changed: [] };
      },
    };
    await sendFrame(ws, {
      type: 'ask_user_answered',
      sessionId: 'sess-am-rec',
      tool_call_id: 'mir-rec-ask-1',
      user_text: 'yes',
      purpose: 'address_mirror',
      consumed_utterance_id: 'utt-rec-1',
    });
    expect(roles.mutationObserver.invalid).toBeNull();
    const receipt = roles.mutationObserver.receipts.find((r) => r.field === 'client_address');
    expect(receipt).toBeTruthy();
    expect(receipt.extraction_turn_id).toBe('utt-rec-1');
    expect(receipt.origin).toBe('ask_auto_resolve');
  });
});

describe('Tier-2 (b4) — Codex r4 finding 2: mirror regions fail CLOSED on a concurrent open scope', () => {
  test('an already-open turn scope at mirror ingress latches INVALID instead of borrowing the turn', async () => {
    const { factory, roles } = makeFullContextFactory('sess-am-conc');
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-conc', jobState: {} });
    const entry = activeSessions.get('sess-am-conc');
    entry.session.stateSnapshot.circuits[0] = { address: '1 Test Way', postcode: 'ZZ9 9ZZ' };
    // A concurrent suspended turn holds the scope open.
    roles.mutationObserver.enterTurnScope('utt-other-turn');
    await sendFrame(ws, transcriptFrame('sess-am-conc', 'Same address for the client'));
    expect(roles.mutationObserver.invalid).not.toBeNull();
    expect(roles.mutationObserver.invalid.reason).toBe('mirror_scope_conflict');
    roles.mutationObserver.exitTurnScope();
  });
});

describe('Tier-2 (b5) — mini-review r4: the ANSWER-region scope-conflict branch', () => {
  test('an open scope at ask_user_answered mirror recovery latches INVALID', async () => {
    const { factory, roles } = makeFullContextFactory('sess-am-conc2');
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-am-conc2', jobState: {} });
    const entry = activeSessions.get('sess-am-conc2');
    entry.addressMirrorController = {
      resolveRecoveredAnswer: async () => ({ handled: true, outcome: 'duplicate', changed: [] }),
    };
    roles.mutationObserver.enterTurnScope('utt-other-turn');
    await sendFrame(ws, {
      type: 'ask_user_answered',
      sessionId: 'sess-am-conc2',
      tool_call_id: 'mir-conc-ask-1',
      user_text: 'yes',
      purpose: 'address_mirror',
      consumed_utterance_id: 'utt-conc-1',
    });
    expect(roles.mutationObserver.invalid).not.toBeNull();
    expect(roles.mutationObserver.invalid.reason).toBe('mirror_scope_conflict');
    expect(roles.mutationObserver.invalid.detail.region).toBe('address_mirror_answer');
    roles.mutationObserver.exitTurnScope();
  });
});
