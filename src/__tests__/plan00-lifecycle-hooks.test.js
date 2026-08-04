/**
 * Plan 00B §B1 — dormant evaluation lifecycle hooks + per-entry teardown
 * arbiter.
 *
 * Two layers under test:
 *   1. The hooks module itself (registration, dormancy, monotonic revisions,
 *      exactly-once quiescence-gated freeze).
 *   2. The REAL sonnet-stream lifecycle driven through `initSonnetStream`
 *      (same fake-ws pattern as sonnet-stream-resume.test.js): evaluation
 *      context attachment at entry creation, byte-for-byte production-vs-
 *      evaluation frame parity, teardown-arbiter races (explicit stop vs
 *      disconnect timeout vs both reconnect message types), and the
 *      non-quiescent stop freezing evidence-INELIGIBLE.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
let mockFlushBuffer = jest.fn(async () => null);
const mockSessionInstances = [];

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.utteranceBuffer = [];
    // The real constructor creates the snapshot via ensureMultiBoardShape —
    // C1 attaches the mutation observer to session AND snapshot pre-start.
    this.stateSnapshot = { boards: [], circuits: [] };
    this.costTracker = {
      toCostUpdate: () => ({ type: 'cost_update', cost: 0 }),
      inFlightBillableInvocationCount: 0,
      usageRevision: 0,
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = (...args) => mockFlushBuffer(...args);
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
const {
  registerEvidenceObserver,
  hasEvidenceObserver,
  getLifecycleLedger,
  recordLifecycleEvent,
  notifySuccessfulFrame,
  freezeEvidenceCompletion,
  freezeEvidenceStart,
  getCompletionFreeze,
  getStartFreeze,
  beginProducer,
  readInFlightCounts,
  normaliseEvaluationContext,
  attachEvaluationContext,
  EVIDENCE_OBSERVER,
  LIFECYCLE_LEDGER,
  EVALUATION_CONTEXT,
  PRODUCER_KINDS,
} = await import('../extraction/plan00-lifecycle-hooks.js');
const { createAskLedger, createDeliveryLedger } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { createMutationObserver, MUTATION_OBSERVER } =
  await import('../extraction/plan00-semantic-capture.js');

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

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

function makeObserver() {
  return {
    events: [],
    frozen: [],
    onRegistered: jest.fn(),
    onLifecycleEvent(row) {
      this.events.push(row);
    },
    onEvidenceFrozen(frozen) {
      this.frozen.push(frozen);
    },
    buildCandidate: jest.fn((snapshot) => ({
      timestamp: '2026-08-04T00:00:00Z',
      canonical_bytes: JSON.stringify({ boundary: snapshot.boundary }),
      content_hash: 'hash-abc',
      key: `key-${snapshot.sessionId}`,
      checksum: 'crc-1',
    })),
    publish: jest.fn(async () => 'published'),
  };
}

beforeEach(() => {
  mockSessionInstances.length = 0;
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer = jest.fn(async () => null);
  activeSessions.clear();
  sonnetSessionStore.clear();
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

// ── Layer 1: the hooks module ────────────────────────────────────────────────

describe('plan00-lifecycle-hooks module', () => {
  test('registration is exactly-once, non-enumerable, and fires onRegistered', () => {
    const entry = { session: null };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    expect(hasEvidenceObserver(entry)).toBe(true);
    expect(observer.onRegistered).toHaveBeenCalledWith({ at: 'entry_creation' });
    // Non-enumerable: never serialisable onto a wire frame or log row.
    expect(Object.keys(entry)).toEqual(['session']);
    expect(JSON.stringify(entry)).not.toContain('observer');
    expect(() => registerEvidenceObserver(entry, observer)).toThrow(/already registered/);
  });

  test('dormant path: no ledger means recordLifecycleEvent is a no-op', () => {
    const entry = {};
    expect(() => recordLifecycleEvent(entry, 'successful_frame', { x: 1 })).not.toThrow();
    expect(getLifecycleLedger(entry)).toBeNull();
    expect(
      freezeEvidenceCompletion(entry, { sessionId: 's', boundary: 'session_stopped' })
    ).toBeNull();
  });

  test('revisions are monotonic and sub-records immutable', () => {
    const entry = {};
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    notifySuccessfulFrame(entry, { frame_kind: 'extraction' });
    notifySuccessfulFrame(entry, { frame_kind: 'voice_command_response' });
    const ledger = getLifecycleLedger(entry);
    expect(ledger.revisions.successful_frame).toBe(2);
    expect(ledger.subRecords).toHaveLength(2);
    expect(ledger.subRecords[0].revision).toBe(1);
    expect(ledger.subRecords[1].revision).toBe(2);
    expect(Object.isFrozen(ledger.subRecords[0])).toBe(true);
    expect(observer.events).toHaveLength(2);
  });

  // Plan 00B-2 C3 — the single-latch lifecycle tests are DELIBERATELY
  // rewritten to per-key single-flight (they pinned the exact gap being
  // closed: one `frozen` latch could not serve 00C's separate start and
  // completion manifests). Latch-verbatim semantics are re-pinned INSIDE
  // this rewrite: the completion-key latch's `frozen.candidate` is still
  // asserted to be the builder's verbatim return.
  test('completion freeze latches candidate + publish promise exactly once PER KEY', async () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 3 } },
    };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's1',
      boundary: 'session_stopped',
    });
    expect(frozen.latch_key).toBe('completion');
    expect(frozen.eligible).toBe(true);
    expect(frozen.reason).toBeNull();
    // Latch-verbatim: the candidate IS the builder's return over the
    // five-key allowlisted snapshot.
    expect(frozen.candidate.key).toBe('key-s1');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    const snapshot = observer.buildCandidate.mock.calls[0][0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.boundary).toBe('session_stopped');
    expect(Object.keys(snapshot).sort()).toEqual([
      'boundary',
      'counts',
      'revisions',
      'sessionId',
      'sub_records',
    ]);
    // The quiescence outcome rides INSIDE counts, never a new top-level key.
    expect(snapshot.counts.non_quiescent_at_stop).toBe(0);
    expect(snapshot.counts.revision_instability).toBe(0);
    await expect(frozen.publishPromise).resolves.toBe('published');
    // Retry reuses the latch — builder and publish never run again.
    const again = freezeEvidenceCompletion(entry, { sessionId: 's1', boundary: 'session_stopped' });
    expect(again).toBe(frozen);
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    expect(observer.publish).toHaveBeenCalledTimes(1);
    // The explicit accessor is the read path — completion by canonical key.
    expect(getCompletionFreeze(entry)).toBe(frozen);
  });

  test('start and completion latch INDEPENDENTLY under canonical keys', async () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
    };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    const start = freezeEvidenceStart(entry, { sessionId: 's-keys' });
    expect(start.latch_key).toBe('start');
    expect(start.boundary).toBe('session_started');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    // Start is single-flight on ITS key.
    expect(freezeEvidenceStart(entry, { sessionId: 's-keys' })).toBe(start);
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    // Completion latches SEPARATELY — a different boundary string does not
    // collapse into the start latch.
    const completion = freezeEvidenceCompletion(entry, {
      sessionId: 's-keys',
      boundary: 'session_stopped',
    });
    expect(completion).not.toBe(start);
    expect(completion.latch_key).toBe('completion');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(2);
    expect(getStartFreeze(entry)).toBe(start);
    expect(getCompletionFreeze(entry)).toBe(completion);
    // The start latch can never satisfy the post-session verdict: it
    // carries no judged evidence.
    expect(start.evidence).toBeNull();
  });

  test('non-quiescent completion STILL builds and publishes a durable INELIGIBLE candidate', async () => {
    const entry = {
      isExtracting: true,
      session: { costTracker: { inFlightBillableInvocationCount: 1, usageRevision: 9 } },
    };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's2',
      boundary: 'session_stopped',
    });
    expect(frozen.eligible).toBe(false);
    expect(frozen.reason).toBe('non_quiescent_at_stop');
    // 00C's audit candidate is durably publishable even when ineligible.
    expect(frozen.candidate).not.toBeNull();
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    await expect(frozen.publishPromise).resolves.toBe('published');
    const snapshot = observer.buildCandidate.mock.calls[0][0];
    expect(snapshot.counts.non_quiescent_at_stop).toBe(1);
    expect(frozen.counts.billable_invocations_in_flight).toBe(1);
    expect(frozen.counts.extraction_in_flight).toBe(1);
    // Latched — a duplicate teardown caller sees the same ineligible record.
    expect(freezeEvidenceCompletion(entry, { sessionId: 's2', boundary: 'x' })).toBe(frozen);
  });

  test('observer-less (role-absent) context: both latches latch with null candidate/publish', () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
    };
    const ctx = normaliseEvaluationContext(
      { askLedger: createAskLedger() },
      { sessionId: 's-noobs' }
    );
    attachEvaluationContext(entry, ctx);
    const start = freezeEvidenceStart(entry, { sessionId: 's-noobs' });
    expect(start.candidate).toBeNull();
    expect(start.publishPromise).toBeNull();
    const completion = freezeEvidenceCompletion(entry, {
      sessionId: 's-noobs',
      boundary: 'session_stopped',
    });
    expect(completion.candidate).toBeNull();
    expect(completion.publishPromise).toBeNull();
    // frozen.evidence is still composed and latched identically.
    expect(completion.evidence).not.toBeNull();
    expect(completion.evidence.ask_entries).toEqual([]);
    expect(completion.eligible).toBe(true);
  });

  test('a rejecting publish never becomes an unhandled rejection', async () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
    };
    const observer = makeObserver();
    observer.publish = jest.fn(async () => {
      throw new Error('S3 down');
    });
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's3',
      boundary: 'session_stopped',
    });
    expect(frozen.eligible).toBe(true);
    await expect(frozen.publishPromise).rejects.toThrow('S3 down');
  });

  test('readInFlightCounts derives every count from real entry state', () => {
    const entry = {
      isExtracting: true,
      pendingTranscripts: [{}, {}],
      pendingExtractions: [{}],
      addressMirrorOutboxRetryHandle: setTimeout(() => {}, 1000),
      pendingRefinements: new Map([['a', {}]]),
      pendingAsks: { size: 3 },
      session: {
        utteranceBuffer: [{}],
        costTracker: { inFlightBillableInvocationCount: 2, usageRevision: 5 },
      },
    };
    const counts = readInFlightCounts(entry);
    clearTimeout(entry.addressMirrorOutboxRetryHandle);
    expect(counts).toEqual({
      billable_invocations_in_flight: 2,
      extraction_in_flight: 1,
      queued_transcripts: 2,
      buffered_utterances: 1,
      pending_extraction_frames: 1,
      outbox_retry_armed: 1,
      refinements_in_flight: 1,
      pending_asks: 3,
      // Plan 00B-2 C3 — per-kind producer counters (dormant entry → 0).
      producer_frame_send: 0,
      producer_outbox_replay: 0,
      producer_refinement: 0,
      producer_confirmation_drain: 0,
      producer_fast_tts: 0,
      producer_address_mirror_ingress: 0,
      producer_address_mirror_answer: 0,
      producer_address_mirror_ack: 0,
    });
  });

  // ── Plan 00B-2 C3 — producer-aware quiescence ──
  describe('beginProducer', () => {
    const KINDS = [
      'frame_send',
      'outbox_replay',
      'refinement',
      'confirmation_drain',
      'fast_tts',
      'address_mirror_ingress',
      'address_mirror_answer',
      'address_mirror_ack',
    ];

    test('the canonical kind registry is exactly the eight kinds', () => {
      expect([...PRODUCER_KINDS]).toEqual(KINDS);
    });

    test.each(KINDS)('%s holds an eligible freeze open until completion', (kind) => {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      const observer = makeObserver();
      registerEvidenceObserver(entry, observer);
      const handle = beginProducer(entry, kind);
      expect(readInFlightCounts(entry)[`producer_${kind}`]).toBe(1);
      // A stop landing while the producer is suspended freezes INELIGIBLE.
      const frozen = freezeEvidenceCompletion(entry, {
        sessionId: `s-${kind}`,
        boundary: 'session_stopped',
      });
      expect(frozen.eligible).toBe(false);
      expect(frozen.reason).toBe('non_quiescent_at_stop');
      expect(frozen.counts[`producer_${kind}`]).toBe(1);
      handle.complete();
      expect(readInFlightCounts(entry)[`producer_${kind}`]).toBe(0);
      // Late completion can NEVER flip the latched ineligible freeze.
      expect(getCompletionFreeze(entry)).toBe(frozen);
      expect(getCompletionFreeze(entry).eligible).toBe(false);
    });

    test('exception paths complete in finally without corrupting the counter', () => {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      registerEvidenceObserver(entry, makeObserver());
      const run = () => {
        const handle = beginProducer(entry, 'refinement');
        try {
          throw new Error('boom');
        } finally {
          handle.complete();
        }
      };
      expect(run).toThrow('boom');
      expect(readInFlightCounts(entry).producer_refinement).toBe(0);
    });

    test('overlapping producers of different kinds both hold the freeze', () => {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      registerEvidenceObserver(entry, makeObserver());
      // The documented ACK→outbox nesting: both counters held.
      const ack = beginProducer(entry, 'address_mirror_ack');
      const replay = beginProducer(entry, 'outbox_replay');
      const counts = readInFlightCounts(entry);
      expect(counts.producer_address_mirror_ack).toBe(1);
      expect(counts.producer_outbox_replay).toBe(1);
      replay.complete();
      ack.complete();
      const after = readInFlightCounts(entry);
      expect(after.producer_address_mirror_ack).toBe(0);
      expect(after.producer_outbox_replay).toBe(0);
    });

    test('unknown kind marks the lane INVALID and never throws', () => {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      registerEvidenceObserver(entry, makeObserver());
      const handle = beginProducer(entry, 'not_a_kind');
      expect(() => handle.complete()).not.toThrow();
      expect(getLifecycleLedger(entry).producerInvalid.reason).toBe('unknown_producer_kind');
    });

    test('double completion marks the lane INVALID', () => {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      registerEvidenceObserver(entry, makeObserver());
      const handle = beginProducer(entry, 'frame_send');
      handle.complete();
      handle.complete();
      expect(getLifecycleLedger(entry).producerInvalid.reason).toBe('producer_double_completion');
    });

    test('dormant entry: beginProducer is a shared no-op handle', () => {
      const entry = {};
      const handle = beginProducer(entry, 'frame_send');
      expect(() => handle.complete()).not.toThrow();
      expect(getLifecycleLedger(entry)).toBeNull();
    });
  });

  // ── Plan 00B-2 C3 — frozen.evidence: the ONLY judged evidence ──
  describe('frozen.evidence immutability at the freeze boundary', () => {
    function makeFullContextEntry(sessionId) {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      const observer = makeObserver();
      const ctx = normaliseEvaluationContext(
        {
          observer,
          mutationObserver: createMutationObserver({ sessionId }),
          askLedger: createAskLedger(),
          deliveryLedger: createDeliveryLedger(),
        },
        { sessionId }
      );
      attachEvaluationContext(entry, ctx);
      return { entry, ctx, observer };
    }

    test('completion latches deep-frozen evidence composed BEFORE buildCandidate', () => {
      const { entry, ctx, observer } = makeFullContextEntry('s-ev');
      ctx.mutationObserver.setOriginFrame({ origin: 'model_direct' });
      ctx.mutationObserver.commit({
        kind: 'reading',
        field: 'measured_zs_ohm',
        circuit: 4,
        value: '0.5',
      });
      const frozen = freezeEvidenceCompletion(entry, {
        sessionId: 's-ev',
        boundary: 'session_stopped',
      });
      expect(frozen.evidence).not.toBeNull();
      expect(frozen.evidence.receipts).toHaveLength(1);
      expect(Object.isFrozen(frozen.evidence)).toBe(true);
      expect(Object.isFrozen(frozen.evidence.receipts)).toBe(true);
      expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
      // Identity/agreement: the builder snapshot's sub_records IS the same
      // latched immutable copy as frozen.evidence.sub_records.
      const snapshot = observer.buildCandidate.mock.calls[0][0];
      expect(frozen.evidence.sub_records).toBe(snapshot.sub_records);
    });

    test('late live-ledger mutation is provably isolated from the latched evidence', () => {
      const { entry, ctx } = makeFullContextEntry('s-late');
      ctx.mutationObserver.setOriginFrame({ origin: 'model_direct' });
      ctx.mutationObserver.commit({
        kind: 'reading',
        field: 'measured_zs_ohm',
        circuit: 1,
        value: '0.3',
      });
      const frozen = freezeEvidenceCompletion(entry, {
        sessionId: 's-late',
        boundary: 'session_stopped',
      });
      expect(frozen.evidence.receipts).toHaveLength(1);
      // A suspended producer resuming post-freeze mutates the LIVE ledgers…
      ctx.mutationObserver.commit({
        kind: 'reading',
        field: 'measured_zs_ohm',
        circuit: 2,
        value: '0.4',
      });
      ctx.askLedger.produced('{"late":"ask"}', {});
      // …but the latched evidence never changes.
      expect(frozen.evidence.receipts).toHaveLength(1);
      expect(frozen.evidence.ask_entries).toHaveLength(0);
      // The live sub-record array stays append-mutable post-freeze while the
      // latched snapshot does not grow.
      const ledger = getLifecycleLedger(entry);
      recordLifecycleEvent(entry, 'successful_frame', { frame_kind: 'late' });
      expect(ledger.subRecords.length).toBeGreaterThan(frozen.evidence.sub_records.length);
    });
  });
});

// ── Layer 2: real-server lifecycle through initSonnetStream ─────────────────

describe('evaluation context through the REAL sonnet-stream lifecycle', () => {
  test('factory attaches the observer at entry creation, non-enumerably', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-eval-1', jobState: {} });
    const entry = activeSessions.get('sess-eval-1');
    expect(entry).toBeDefined();
    expect(hasEvidenceObserver(entry)).toBe(true);
    expect(entry[EVIDENCE_OBSERVER]).toBe(observer);
    // Non-enumerable — no wire frame / JSON log can carry it.
    expect(Object.getOwnPropertyNames(entry)).not.toContain('observer');
    expect(observer.onRegistered).toHaveBeenCalledTimes(1);
  });

  test('byte-for-byte frame parity: evaluation mode changes NOTHING on the wire', async () => {
    // Production shape (no factory).
    const wssProd = initSonnetStream(null, getKey, verifyToken);
    const wsProd = connect(wssProd);
    await sendFrame(wsProd, { type: 'session_start', sessionId: 'sess-parity', jobState: {} });
    await sendFrame(wsProd, { type: 'session_stop', sessionId: 'sess-parity' });
    const prodFrames = wsProd._sent.map((f) => JSON.stringify(f));
    activeSessions.clear();
    sonnetSessionStore.clear();
    mockSessionInstances.length = 0;

    // Evaluation shape (factory registered).
    const wssEval = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => makeObserver(),
    });
    const wsEval = connect(wssEval);
    await sendFrame(wsEval, { type: 'session_start', sessionId: 'sess-parity', jobState: {} });
    await sendFrame(wsEval, { type: 'session_stop', sessionId: 'sess-parity' });
    const evalFrames = wsEval._sent.map((f) => JSON.stringify(f));

    // The rehydrate token is minted per-run; normalise it before comparing.
    const normalise = (frames) =>
      frames.map((f) => f.replace(/"sessionId":"[0-9a-f-]{36}"/g, '"sessionId":"<token>"'));
    expect(normalise(evalFrames)).toEqual(normalise(prodFrames));
  });

  // Plan 00B-2 C3 — the eligible-stop and non-quiescent-stop boot tests are
  // DELIBERATELY rewritten per the boundary-latch design (they pinned the
  // single-latch gap being closed): one START candidate at session start,
  // one COMPLETION candidate at stop, the ineligible completion still built
  // and published.
  test('explicit stop: one START + one ELIGIBLE COMPLETION candidate, each exactly once', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-stop-1', jobState: {} });
    // The START candidate latched at fresh-create, before any stop.
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    expect(observer.buildCandidate.mock.calls[0][0].boundary).toBe('session_started');
    const entryRef = activeSessions.get('sess-stop-1');
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-stop-1' });
    expect(activeSessions.has('sess-stop-1')).toBe(false);
    expect(observer.frozen).toHaveLength(2);
    expect(observer.frozen[0].latch_key).toBe('start');
    expect(observer.frozen[1].latch_key).toBe('completion');
    expect(observer.frozen[1].eligible).toBe(true);
    expect(observer.frozen[1].boundary).toBe('session_stopped');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(2);
    expect(lastAck(ws).status).toBe('stopped');
    // C4 retained-entry retrieval: the accessor still answers on the
    // retained reference after the registry delete.
    expect(getCompletionFreeze(entryRef)).toBe(observer.frozen[1]);
    expect(getStartFreeze(entryRef)).toBe(observer.frozen[0]);
  });

  test('a non-quiescent stop still BUILDS + PUBLISHES the ineligible completion candidate', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-stop-2', jobState: {} });
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1); // start
    // A billable scope still open at stop = the session was NOT quiescent.
    const entry = activeSessions.get('sess-stop-2');
    entry.session.costTracker.inFlightBillableInvocationCount = 1;
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-stop-2' });
    const completion = observer.frozen.find((f) => f.latch_key === 'completion');
    expect(completion.eligible).toBe(false);
    expect(completion.reason).toBe('non_quiescent_at_stop');
    // 00C's durable audit candidate: built + published even when ineligible.
    expect(completion.candidate).not.toBeNull();
    expect(observer.buildCandidate).toHaveBeenCalledTimes(2);
    await expect(completion.publishPromise).resolves.toBe('published');
    expect(completion.counts.non_quiescent_at_stop).toBe(1);
    // Normal stop behaviour unchanged: ack still sent, entry still deleted.
    expect(lastAck(ws).status).toBe('stopped');
    expect(activeSessions.has('sess-stop-2')).toBe(false);
  });

  // ── Plan 00B-2 C1 — composition pins ──
  test('factory runs EXACTLY ONCE per fresh entry with ({sessionId, userId}); reconnect preserves the context instance', async () => {
    const factory = jest.fn(() => makeObserver());
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-once-1', jobState: {} });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toEqual({ sessionId: 'sess-once-1', userId: 'user-1' });
    const entry = activeSessions.get('sess-once-1');
    const ctx = entry[EVALUATION_CONTEXT];
    expect(ctx).toBeTruthy();
    // Reconnect (same session id, new socket) re-binds the EXISTING entry:
    // the factory never re-runs and the SAME context instance persists.
    const ws2 = connect(wss);
    await sendFrame(ws2, { type: 'session_start', sessionId: 'sess-once-1', jobState: {} });
    expect(factory).toHaveBeenCalledTimes(1);
    const entryAfter = activeSessions.get('sess-once-1');
    expect(entryAfter).toBe(entry);
    expect(entryAfter[EVALUATION_CONTEXT]).toBe(ctx);
    expect(hasEvidenceObserver(entryAfter)).toBe(true);
  });

  test('session_resume rehydrate preserves the same evaluation context instance', async () => {
    const factory = jest.fn(() => makeObserver());
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-resume-ctx', jobState: {} });
    const token = lastAck(ws).sessionId;
    const entry = activeSessions.get('sess-resume-ctx');
    const ctx = entry[EVALUATION_CONTEXT];
    const ws2 = connect(wss);
    await sendFrame(ws2, { type: 'session_resume', sessionId: token });
    expect(lastAck(ws2).status).toBe('resumed');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(activeSessions.get('sess-resume-ctx')).toBe(entry);
    expect(entry[EVALUATION_CONTEXT]).toBe(ctx);
  });

  test('EVALUATION_CONTEXT lives on the ENTRY only — the session carries the mutation observer but never the context Symbol', async () => {
    const observer = makeObserver();
    const factory = () => ({
      observer,
      mutationObserver: createMutationObserver({ sessionId: 'sess-sym-1' }),
      askLedger: createAskLedger(),
      deliveryLedger: createDeliveryLedger(),
    });
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: factory,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-sym-1', jobState: {} });
    const entry = activeSessions.get('sess-sym-1');
    expect(entry[EVALUATION_CONTEXT]).toBeTruthy();
    // The Symbol is NEVER attached to the session…
    expect(entry.session[EVALUATION_CONTEXT]).toBeUndefined();
    // …while MUTATION_OBSERVER legitimately lives on session + snapshot
    // (same instance, both targets, attached BEFORE session.start).
    expect(entry.session[MUTATION_OBSERVER]).toBe(entry[EVALUATION_CONTEXT].mutationObserver);
    expect(mockSessionInstances[0][MUTATION_OBSERVER]).toBe(
      entry[EVALUATION_CONTEXT].mutationObserver
    );
  });

  test('ask-only and delivery-only contexts still get producer counters, sub_records and the completion freeze', async () => {
    for (const shape of [
      { askLedger: createAskLedger() },
      { deliveryLedger: createDeliveryLedger() },
    ]) {
      activeSessions.clear();
      sonnetSessionStore.clear();
      const wss = initSonnetStream(null, getKey, verifyToken, {
        evaluationContextFactory: () => shape,
      });
      const ws = connect(wss);
      await sendFrame(ws, { type: 'session_start', sessionId: 'sess-role-1', jobState: {} });
      const entry = activeSessions.get('sess-role-1');
      expect(entry[EVALUATION_CONTEXT]).toBeTruthy();
      expect(hasEvidenceObserver(entry)).toBe(false);
      // The server-owned ledger exists without an external observer…
      const ledger = getLifecycleLedger(entry);
      expect(ledger).toBeTruthy();
      // …producer counters work…
      const handle = beginProducer(entry, 'frame_send');
      expect(readInFlightCounts(entry).producer_frame_send).toBe(1);
      handle.complete();
      // …sub-records append…
      recordLifecycleEvent(entry, 'successful_frame', { frame_kind: 'x' });
      expect(ledger.subRecords).toHaveLength(1);
      // …and the completion freeze latches with retained-entry retrieval.
      await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-role-1' });
      const frozen = getCompletionFreeze(entry);
      expect(frozen).toBeTruthy();
      expect(frozen.candidate).toBeNull();
      expect(frozen.evidence).not.toBeNull();
    }
  });

  test('duplicate stop frames run ONE teardown body', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-race-1', jobState: {} });
    // Slow flush so the second stop lands mid-teardown.
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stop1 = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-1' });
    const stop2 = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-1' });
    releaseFlush();
    await Promise.all([stop1, stop2]);
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(mockFlushBuffer).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-race-1')).toBe(false);
    // Exactly one stopped ack reached the wire.
    expect(ws._sent.filter((f) => f.type === 'session_ack' && f.status === 'stopped')).toHaveLength(
      1
    );
  });

  test('disconnect-timeout expiry racing an in-flight stop never runs a second teardown', async () => {
    jest.useFakeTimers();
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-race-2', jobState: {} });
    // Socket closes → 5-minute timer armed on the entry.
    await ws._emit('close');
    expect(activeSessions.get('sess-race-2').disconnectTimer).toBeTruthy();
    // Explicit stop starts first and is mid-flush when the timer fires.
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-2' });
    jest.advanceTimersByTime(300001);
    releaseFlush();
    await stopPromise;
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-race-2')).toBe(false);
  });

  test('disconnect-timeout teardown itself runs through the arbiter', async () => {
    jest.useFakeTimers();
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-timeout-1', jobState: {} });
    await ws._emit('close');
    jest.advanceTimersByTime(300001);
    // Let the async teardown body run.
    await jest.runOnlyPendingTimersAsync();
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-timeout-1')).toBe(false);
  });

  test('session_start reconnect during teardown awaits, never rebinds, and creates FRESH', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-reconnect-1', jobState: {} });
    const dyingEntry = activeSessions.get('sess-reconnect-1');
    const dyingSession = dyingEntry.session;
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-reconnect-1' });
    // Reconnect lands mid-teardown on a NEW socket.
    const ws2 = connect(wss);
    const reconnectPromise = sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-reconnect-1',
      jobState: {},
    });
    releaseFlush();
    await Promise.all([stopPromise, reconnectPromise]);
    // The reconnect followed the FRESH-session path: a brand-new session
    // object, never a rebind of the dying entry.
    const fresh = activeSessions.get('sess-reconnect-1');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(dyingEntry);
    expect(fresh.session).not.toBe(dyingSession);
    expect(fresh.ws).toBe(ws2);
    expect(lastAck(ws2).status).toBe('started');
    // No mode change / socket rebind touched the dying entry.
    expect(dyingSession.applyModeChange).not.toHaveBeenCalled();
    expect(dyingEntry.ws).toBe(ws);
  });

  test('session_resume rehydrate during teardown awaits and follows the miss path', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-resume-1', jobState: {} });
    const token = lastAck(ws).sessionId;
    expect(typeof token).toBe('string');
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-resume-1' });
    const ws2 = connect(wss);
    const resumePromise = sendFrame(ws2, { type: 'session_resume', sessionId: token });
    releaseFlush();
    await Promise.all([stopPromise, resumePromise]);
    // Teardown completed first from the resume's point of view: the entry is
    // gone, so the rehydrate answers deterministically with status 'new'.
    expect(lastAck(ws2).status).toBe('new');
    expect(activeSessions.has('sess-resume-1')).toBe(false);
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
  });

  test('successful-frame notifications stay fully dormant without an observer', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-dormant-1', jobState: {} });
    const entry = activeSessions.get('sess-dormant-1');
    expect(entry[LIFECYCLE_LEDGER]).toBeUndefined();
    expect(hasEvidenceObserver(entry)).toBe(false);
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-dormant-1' });
    // Freeze on a dormant entry returned null (nothing latched anywhere).
    expect(activeSessions.has('sess-dormant-1')).toBe(false);
  });
});
