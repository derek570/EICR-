/**
 * P6 — production-ingress integration test for the dictation-transcript
 * normaliser (feedback ids 89 + 80A).
 *
 * WHY THIS FILE IS THE LOAD-BEARING PROOF
 *   The normaliser lives at TWO seams inside sonnet-stream.js's live WS
 *   handlers (Seam A = handleTranscript, Seam B = ask_user_answered). The
 *   voice-regression / replay DIRECT runner
 *   (transcript-replay-direct-runner.mjs) calls runShadowHarness DIRECTLY and
 *   resolves in-turn asks through pendingAsks — it BYPASSES handleTranscript /
 *   sanitiseUserText, so it would NOT exercise the normaliser seam at all. Only
 *   driving real frames through the `ws._emit('message', …)` handler (the
 *   pattern from sonnet-stream-ask-routing.test.js) proves the raw→canonical
 *   transformation actually reaches the behavioural consumers.
 *
 *   The deterministic claim proven here is: "the model / scripts / anchors /
 *   gate SEE canonical text." Whether the model then WRITES is model behaviour
 *   (live-lane, not fixture-lockable).
 *
 * MOCK STRATEGY
 *   Mirror ask-routing.test.js: drive a fake ws through
 *   `wss.emit('connection', …)` and capture the closure-bound handlers via the
 *   fake's `ws.on` mock. runShadowHarness, classifyOvertake, the pre-LLM gate,
 *   and the three dialogue-script wrappers are spies so we can read the EXACT
 *   text they receive. The reading-field anchor + the megaohms parser + the
 *   normaliser itself are REAL — the whole point is to prove the real anchor
 *   flips true and the real parser parses the canonical value.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks (registered BEFORE the dynamic import of sonnet-stream.js) ─────────

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
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerModule = {
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
};
jest.unstable_mockModule('../logger.js', () => loggerModule);

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

// runShadowHarness spy — arg[1] is transcriptText (the model-bound text).
const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

// classifyOvertake spy — default no_pending_asks so transcripts pass through and
// Seam B's stage-1 shape check falls to stage 2. arg[0] is the text classified.
const classifyOvertakeSpy = jest.fn(() => ({ kind: 'no_pending_asks' }));
jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: classifyOvertakeSpy,
}));

// pre-LLM gate spy — arg[0] is the text the gate judges. Always forward so the
// handler proceeds to the dialogue wrappers + runShadowHarness. The mock
// provides the exact surface its importers read: sonnet-stream reads
// shouldForwardToSonnet + GATE_REASONS.HAS_COMPLAINT_OR_NEGATION; the real
// dialogue-engine engine.js reads OBSERVATION_PATTERN at load (never executed
// here — the real wrappers are spied out).
const gateSpy = jest.fn(() => ({ forward: true, reason: 'forwarded', borderline: false }));
jest.unstable_mockModule('../extraction/pre-llm-gate.js', () => ({
  shouldForwardToSonnet: gateSpy,
  GATE_REASONS: Object.freeze({ HAS_COMPLAINT_OR_NEGATION: 'has_complaint_or_negation' }),
  OBSERVATION_PATTERN: /(?!)/,
}));

// Dialogue-script wrapper spies — default handled:false so the turn falls
// through to runShadowHarness. We assert on the `transcriptText` + `rawReplyText`
// they receive (both must be canonical; rawReplyText must be UN-annotated).
//
// The factory is SYNCHRONOUS with hardcoded stubs and imports NOTHING. This is
// deliberate: the real schemas/*.js import index.js back (schemas/ring-continuity
// .js → index.js), so an async factory that awaited the real engine/schemas
// would DEADLOCK (jest can't resolve index.js's exports until the factory
// Promise settles, but the factory awaits a module that transitively imports
// index.js). Stubbing keeps the real engine + schemas OUT of the graph entirely.
// The only non-wrapper export a loaded consumer reads is
// ALL_DIALOGUE_SCHEMA_NAMES (stage6-tool-schemas builds the start_dialogue_script
// enum from it — not asserted here), so real name strings are enough.
const irWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const ringWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const pdWrapperSpy = jest.fn(() => ({ handled: false, fallthrough: false }));
const noopDialogue = () => ({ handled: false, fallthrough: false });
const stubSchema = (name) => ({ name });
jest.unstable_mockModule('../extraction/dialogue-engine/index.js', () => ({
  processDialogueTurn: noopDialogue,
  enterScriptByName: noopDialogue,
  tryResumePausedScript: noopDialogue,
  tryEnterScriptFromWrites: noopDialogue,
  ringContinuitySchema: stubSchema('ring_continuity'),
  insulationResistanceSchema: stubSchema('insulation_resistance'),
  ocpdSchema: stubSchema('ocpd'),
  rcdSchema: stubSchema('rcd'),
  rcboSchema: stubSchema('rcbo'),
  ALL_DIALOGUE_SCHEMAS: [
    stubSchema('ring_continuity'),
    stubSchema('insulation_resistance'),
    stubSchema('rcbo'),
    stubSchema('ocpd'),
    stubSchema('rcd'),
  ],
  ALL_DIALOGUE_SCHEMA_NAMES: ['insulation_resistance', 'ocpd', 'rcbo', 'rcd', 'ring_continuity'],
  processRingContinuityTurn: ringWrapperSpy,
  processInsulationResistanceTurn: irWrapperSpy,
  processProtectiveDeviceTurn: pdWrapperSpy,
}));

// ── Dynamic imports AFTER mocks ─────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
// REAL helpers — the whole point is to exercise the genuine anchor + parser.
const { normalise } = await import('../extraction/transcript-normalise.js');
const { hasReadingFieldAnchor } = await import('../extraction/reading-transcript-anchor.js');
const { parseBareMegaohmsWithUnit } = await import(
  '../extraction/dialogue-engine/parsers/megaohms.js'
);

// ── Harness helpers (lifted from ask-routing.test.js) ────────────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => sent.push(JSON.parse(payload))),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
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

async function startSession(ws, sessionId) {
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobId: 'job-1',
    jobState: { certificateType: 'eicr' },
  });
}

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer.mockClear();
  runShadowHarnessSpy.mockClear();
  classifyOvertakeSpy.mockClear();
  classifyOvertakeSpy.mockImplementation(() => ({ kind: 'no_pending_asks' }));
  runShadowHarnessSpy.mockImplementation(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  }));
  gateSpy.mockClear();
  irWrapperSpy.mockClear();
  ringWrapperSpy.mockClear();
  pdWrapperSpy.mockClear();
  loggerModule.default.info.mockClear();
  loggerModule.default.warn.mockClear();
  loggerModule.default.error.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

const CANON = 'Zs on the heating was 0.67';
const RAW = 'Z s on the heating was 0.67';

// -----------------------------------------------------------------------------
// Seam A — the model/scripts/gate/anchor all SEE canonical (id 89)
// -----------------------------------------------------------------------------

describe('Seam A — "Z s … 0.67" is canonicalised at ingest (id 89)', () => {
  test('the pre-LLM gate receives the canonical "Zs …" text', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-A1');
    await sendFrame(ws, { type: 'transcript', text: RAW });
    expect(gateSpy).toHaveBeenCalled();
    expect(gateSpy.mock.calls[0][0]).toBe(CANON);
  });

  test('runShadowHarness receives the canonical model-bound transcript', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-A2');
    await sendFrame(ws, { type: 'transcript', text: RAW });
    expect(runShadowHarnessSpy).toHaveBeenCalled();
    expect(runShadowHarnessSpy.mock.calls.at(-1)[1]).toBe(CANON);
  });

  test('the dialogue-script wrappers receive canonical transcriptText + UN-annotated canonical rawReplyText', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-A3');
    await sendFrame(ws, { type: 'transcript', text: RAW });
    for (const spy of [ringWrapperSpy, irWrapperSpy, pdWrapperSpy]) {
      expect(spy).toHaveBeenCalled();
      const arg = spy.mock.calls.at(-1)[0];
      expect(arg.transcriptText).toBe(CANON);
      // rawReplyText is normalised but NEVER annotated (no bracketed prefix).
      expect(arg.rawReplyText).toBe(CANON);
    }
  });

  test('the REAL reading-field anchor flips true on canonical text (false on raw) — the id-89 fix', () => {
    // Before P6 the backend saw the raw "z s" (spelled, spaced) which the
    // anchor's "zs" alias misses; after P6 it sees "Zs".
    expect(hasReadingFieldAnchor('measured_zs_ohm', RAW)).toBe(false);
    expect(hasReadingFieldAnchor('measured_zs_ohm', CANON)).toBe(true);
    // And the canonical text that actually reached the harness anchors:
    expect(hasReadingFieldAnchor('measured_zs_ohm', normalise(RAW).text)).toBe(true);
  });

  test('genuine two-letter dictation is NOT collapsed (negative — gate/harness see raw-equivalent)', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-A4');
    const designation = 'designation Z S 1';
    await sendFrame(ws, { type: 'transcript', text: designation });
    expect(gateSpy.mock.calls[0][0]).toBe(designation);
    expect(runShadowHarnessSpy.mock.calls.at(-1)[1]).toBe(designation);
  });

  test('stage6.transcript_normalised logs EXACTLY once with rule IDs only (no raw/canonical text)', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-A5');
    await sendFrame(ws, { type: 'transcript', text: RAW });
    const rows = loggerModule.default.info.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_normalised'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][1].rules_hit).toEqual(['zs_field_token']);
    // Leak-filter — the log payload carries rule IDs, NEVER the transcript text.
    const payloadStr = JSON.stringify(rows[0][1]);
    expect(payloadStr).not.toContain('0.67');
    expect(payloadStr).not.toContain('heating');
  });
});

// -----------------------------------------------------------------------------
// id 80A — "a hundred" digit-ises so the REAL megaohms parser parses it
// -----------------------------------------------------------------------------

describe('id 80A — "a hundred MΩ" digit-ises to a parseable "100 MΩ"', () => {
  test('the REAL megaohms parser fails on the raw word-number and parses the canonical', () => {
    // The bug: "a hundred megaohms" has no digit → the parser returns null.
    expect(parseBareMegaohmsWithUnit('a hundred megaohms')).toBeNull();
    // The fix: normalise → "100 megaohms" → parses to "100" (100 MΩ). The unit
    // itself was always parseable; the miss was purely the word-number.
    expect(parseBareMegaohmsWithUnit(normalise('a hundred megaohms').text)).toBe('100');
    expect(parseBareMegaohmsWithUnit(normalise('A hundred MΩ').text)).toBe('100');
  });

  test('the IR dialogue wrapper receives canonical "100 …" through the transcript seam', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-80A');
    await sendFrame(ws, { type: 'transcript', text: 'A hundred megaohms' });
    expect(irWrapperSpy).toHaveBeenCalled();
    const arg = irWrapperSpy.mock.calls.at(-1)[0];
    expect(arg.transcriptText).toBe('100 megaohms');
    expect(arg.rawReplyText).toBe('100 megaohms');
    // And the model-bound transcript the harness would see is canonical too.
    expect(runShadowHarnessSpy.mock.calls.at(-1)[1]).toBe('100 megaohms');
  });
});

// -----------------------------------------------------------------------------
// Seam B — direct ask_user_answered (non-srv) routes canonical text
// -----------------------------------------------------------------------------

describe('Seam B — direct ask_user_answered normalises the answer', () => {
  function seedPendingAsk(entry, toolCallId) {
    let capturedResolve;
    const answered = new Promise((res) => {
      capturedResolve = res;
    });
    entry.pendingAsks.register(toolCallId, {
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      resolve: capturedResolve,
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    return answered;
  }

  test('"A hundred" answer resolves the ask with canonical "100" (and classifyOvertake sees canonical)', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-B1');
    const entry = activeSessions.get('sess-B1');
    const answered = seedPendingAsk(entry, 'toolu_v');

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_v',
      user_text: 'A hundred',
    });

    await expect(answered).resolves.toMatchObject({ answered: true, user_text: '100' });
    // Seam B stage-1 shape check judged the canonical text.
    const seamBClassifyCalls = classifyOvertakeSpy.mock.calls.filter((c) => c[0] === '100');
    expect(seamBClassifyCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('the recentAskAnswers anchor is pushed canonical (dedupe parity with Seam A)', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-B2');
    const entry = activeSessions.get('sess-B2');
    seedPendingAsk(entry, 'toolu_z');
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_z',
      user_text: RAW, // "Z s …"
    });
    // The anchor ledger holds the CANONICAL normalised form, so Seam A's
    // canonical content-anchor consult will match it.
    const anchors = entry.recentAskAnswers || [];
    expect(anchors.length).toBe(1);
    expect(anchors[0].normalisedText).toBe('zs on the heating was 0 67');
  });
});

// -----------------------------------------------------------------------------
// Paired-frame dedupe — canonical-vs-canonical in BOTH arrival orders
// -----------------------------------------------------------------------------

describe('paired-frame dedupe — no double-exposure in either order', () => {
  function seedPendingAsk(entry, toolCallId) {
    let capturedResolve;
    const answered = new Promise((res) => {
      capturedResolve = res;
    });
    entry.pendingAsks.register(toolCallId, {
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      resolve: capturedResolve,
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    return answered;
  }

  test('order 1 (transcript then answer): the answer is deduped as transcript_already_extracted', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-D1');
    const entry = activeSessions.get('sess-D1');

    // Transcript first — canonicalised + committed → recentTranscripts push.
    await sendFrame(ws, { type: 'transcript', text: RAW });
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);

    // Paired ask-answer with the SAME raw text (no consumed_utterance_id →
    // content-anchor path). Its canonical dedupe key matches the canonical
    // recentTranscripts entry → resolve WITHOUT re-exposing to the model.
    const answered = seedPendingAsk(entry, 'toolu_p');
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_p',
      user_text: RAW,
    });
    await expect(answered).resolves.toMatchObject({
      answered: false,
      reason: 'transcript_already_extracted',
    });
    // No second extraction — the answer was NOT double-exposed.
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
  });

  test('order 2 (answer then transcript): the paired transcript is suppressed by the content anchor', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-D2');
    const entry = activeSessions.get('sess-D2');

    // Ask-answer first — resolves answered:true, pushes recentAskAnswers canonical.
    seedPendingAsk(entry, 'toolu_q');
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_q',
      user_text: RAW,
    });
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();

    // Paired transcript with the SAME raw text — Seam A's canonical content
    // anchor matches the canonical recentAskAnswers entry → suppress + return.
    await sendFrame(ws, { type: 'transcript', text: RAW });
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
    const suppressWarns = loggerModule.default.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_suppressed_content_anchor'
    );
    expect(suppressWarns).toHaveLength(1);
  });
});
