/**
 * PLAN-B B1 ingress 6 (ids 128 + 131) — DELIVERY proof at REAL
 * sonnet-stream EGRESS (not just the returned result).
 *
 * The seam's server-owned designation clarification is only worth its
 * bookkeeping if it actually reaches the inspector:
 *   - shadow mode REJECTS legacy `questions_for_user` payloads wholesale
 *     (consumeLegacyQuestionsForUser) — the tagged clarification is the
 *     ONE exception it consumes, and arbitrary model-authored questions
 *     must stay refused;
 *   - off mode routes questions through the REAL
 *     `filterQuestionsAgainstFilledSlots`, which must admit the marker
 *     even when the question targets an already-populated
 *     `circuit_designation` slot (the banned-only RENAME case).
 *
 * Scenarios (spec list): banned-only CREATE and banned-only
 * RENAME-onto-populated-slot, each having carried an unrelated rejected
 * field, in off AND shadow modes → exactly ONE `question` frame on the
 * wire, no asked-without-delivery state. The results driven here are the
 * POST-session shape (rejected reading already stripped, clarification
 * appended) — the session half of that pipeline, including sanitizer
 * survival with the unrelated rejected field, is proven end-to-end in
 * eicr-extraction-session.designation-seam.test.js; this file proves the
 * egress half on both delivery paths (sync handleTranscript + batched
 * onBatchResult).
 *
 * Harness: FakeEICRExtractionSession + wss.emit('connection') pattern
 * from plan-c-p4d-legacy-frames / transcript-normalise-ingress. The
 * filled-slots filter is REAL (its explicit admit is under test);
 * runShadowHarness is a faithful passthrough returning the crafted
 * post-session result for both modes (shadow's authoritative result IS
 * the legacy result — the tool loop mutates only a clone).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.toolCallsMode = 'off';
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
    this.reviewForOrphanedValues = jest.fn(async () => ({ questions_for_user: [] }));
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
    this.applyModeChange = jest.fn();
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerModule = {
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
};
jest.unstable_mockModule('../logger.js', () => loggerModule);
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

// Faithful passthrough: the harness's authoritative result is the legacy
// result in BOTH off and shadow modes (the shadow tool loop mutates only a
// clone) — the per-test crafted result stands in for that legacy output.
const runShadowHarnessSpy = jest.fn(async () => emptyResult());
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: jest.fn(),
  unmergeFastPathCorrelationIds: jest.fn(),
  coerceFastPathCorrelationIds: jest.fn(() => new Set()),
}));

jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: jest.fn(() => ({ kind: 'no_pending_asks' })),
  classifyFreshCommandText: jest.fn(() => ({
    isFreshCommand: false,
    matchedImperative: false,
    matchedBulkScope: false,
    wordCount: 0,
  })),
}));

// Always forward so transcripts reach the harness dispatch.
jest.unstable_mockModule('../extraction/pre-llm-gate.js', () => ({
  shouldForwardToSonnet: jest.fn(() => ({
    forward: true,
    reason: 'forwarded',
    borderline: false,
  })),
  GATE_REASONS: Object.freeze({ HAS_COMPLAINT_OR_NEGATION: 'has_complaint_or_negation' }),
  OBSERVATION_PATTERN: /(?!)/,
}));

// Dialogue engine stubbed out (synchronous factory — see the deadlock note
// in sonnet-stream-transcript-normalise-ingress.test.js).
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
  processRingContinuityTurn: noopDialogue,
  processInsulationResistanceTurn: noopDialogue,
  processProtectiveDeviceTurn: noopDialogue,
  valuesCanonicallyEqual: (slot, a, b) => a === b || String(a) === String(b),
}));

// NOTE: filled-slots-filter is deliberately NOT mocked — its explicit
// marker admission is part of what this file proves.

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const {
  DESIGNATION_HYGIENE_QUESTION_TYPE,
  DESIGNATION_HYGIENE_QUESTION_PURPOSE,
  normaliseLegacyDesignationResult,
  mergeDesignationConfirmations,
} = await import('../extraction/legacy-designation-seam.js');
const { filterQuestionsAgainstFilledSlots } = await import('../extraction/filled-slots-filter.js');

function emptyResult() {
  return {
    extracted_readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    questions_for_user: [],
    confirmations: [],
    spoken_response: null,
    action: null,
  };
}

// The seam's clarification shape (both marker keys, closed strings).
function hygieneQuestion(circuit = 2) {
  return {
    type: DESIGNATION_HYGIENE_QUESTION_TYPE,
    purpose: DESIGNATION_HYGIENE_QUESTION_PURPOSE,
    field: 'circuit_designation',
    circuit,
    question: `I couldn't use that as a name for circuit ${circuit} — "circuit" on its own isn't a description. What should circuit ${circuit} be called?`,
  };
}

/**
 * POST-session result for a banned-only turn that ALSO carried an
 * unrelated off-schema reading: the session sanitizer already stripped
 * the rejected reading and the seam appended its clarification — this is
 * the byte shape sonnet-stream's egress actually receives (proven in the
 * session-level suite).
 */
function bannedOnlyResult(circuit = 2) {
  return {
    ...emptyResult(),
    questions_for_user: [hygieneQuestion(circuit)],
    spoken_response: `I couldn't save a reading because it didn't match a field I recognise — it's logged.`,
    turn_id: 'legacy-test-turn',
  };
}

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
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler for ${event}`);
    await h(data);
  };
  return ws;
}

const connectedSockets = [];
function connect(wss) {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  connectedSockets.push(ws);
  return ws;
}

async function sendFrame(ws, frame) {
  await ws._emit('message', Buffer.from(JSON.stringify(frame)));
}

const getKey = async () => 'fake-key';

let wss;
beforeEach(() => {
  runShadowHarnessSpy.mockClear();
  runShadowHarnessSpy.mockImplementation(async () => emptyResult());
  loggerModule.default.info.mockClear();
  loggerModule.default.warn.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, jest.fn());
});

afterEach(async () => {
  for (const entry of activeSessions.values()) entry.questionGate?.destroy?.();
  // Fire each connection's close handler so the per-connection 30s
  // keepalive pingInterval is cleared — without this a standalone
  // (in-band) jest run never exits (same open handle the sibling
  // sonnet-stream harnesses leave; cleared here to keep this suite
  // self-contained).
  for (const ws of connectedSockets.splice(0)) {
    const closeHandler = ws._handlers.get('close');
    if (closeHandler) await closeHandler();
  }
  // The close handler arms a 5-minute reconnect-window disconnectTimer per
  // session — clear those too, same reason as above.
  for (const entry of activeSessions.values()) {
    if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

async function startSession(sessionId, mode) {
  const ws = connect(wss);
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobState: { certificateType: 'eicr' },
  });
  const entry = activeSessions.get(sessionId);
  entry.session.toolCallsMode = mode;
  return { ws, entry };
}

function questionFrames(ws) {
  return ws._sent.filter((m) => m.type === 'question');
}

const bypassLogged = () =>
  loggerModule.default.info.mock.calls.some(
    (c) => c[0] === 'questions_for_user bypassed (tool-call path)'
  );

// ─────────────────────────────────────────────────────────────────────────────
// Wire delivery — sync path (handleTranscript) — off + shadow modes
// ─────────────────────────────────────────────────────────────────────────────

describe.each(['off', 'shadow'])(
  'sync egress (mode=%s) — banned-only turns deliver exactly ONE question frame',
  (mode) => {
    test('banned-only CREATE (with unrelated rejected field): one tagged question frame on the wire', async () => {
      const { ws, entry } = await startSession(`desig-sync-create-${mode}`, mode);
      runShadowHarnessSpy.mockImplementation(async () => bannedOnlyResult(7));

      await sendFrame(ws, { type: 'transcript', text: 'Circuit seven is called circuit.' });
      await entry.questionGate.flush();

      const frames = questionFrames(ws);
      expect(frames).toHaveLength(1);
      expect(frames[0].question_type).toBe(DESIGNATION_HYGIENE_QUESTION_TYPE);
      expect(frames[0].purpose).toBe(DESIGNATION_HYGIENE_QUESTION_PURPOSE);
      expect(frames[0].circuit).toBe(7);
      // The extraction envelope never carries questions (they ride their
      // own frame), so the ONE question frame is the whole delivery.
      const extraction = ws._sent.find((m) => m.type === 'extraction');
      expect(extraction?.result ?? extraction ?? {}).not.toHaveProperty('questions_for_user');
    });

    test('banned-only RENAME onto a populated slot: the REAL filled-slot filter admits the marker; no mutation crosses the wire', async () => {
      const { ws, entry } = await startSession(`desig-sync-rename-${mode}`, mode);
      // The rename target slot is POPULATED — exactly the shape the
      // filled-slot filter exists to suppress for refill questions.
      entry.session.stateSnapshot.circuits[2] = { circuit_designation: 'Kitchen sockets' };
      runShadowHarnessSpy.mockImplementation(async () => bannedOnlyResult(2));

      await sendFrame(ws, { type: 'transcript', text: 'Rename circuit two to circuit.' });
      await entry.questionGate.flush();

      const frames = questionFrames(ws);
      expect(frames).toHaveLength(1);
      expect(frames[0].question_type).toBe(DESIGNATION_HYGIENE_QUESTION_TYPE);
      expect(frames[0].circuit).toBe(2);
      // No designation mutation reached the wire: the banned-only op was
      // removed server-side, so no extraction frame carries circuit_updates
      // and the stored designation is untouched.
      const extraction = ws._sent.find((m) => m.type === 'extraction');
      if (extraction) {
        expect(extraction.result?.circuit_updates ?? []).toHaveLength(0);
      }
      expect(entry.session.stateSnapshot.circuits[2].circuit_designation).toBe('Kitchen sockets');
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Wire delivery — batched path (onBatchResult) — off + shadow modes
// ─────────────────────────────────────────────────────────────────────────────

describe.each(['off', 'shadow'])(
  'batched egress (mode=%s) — onBatchResult delivers the tagged clarification',
  (mode) => {
    test('banned-only create: exactly ONE question frame after the batch flush', async () => {
      const { ws, entry } = await startSession(`desig-batch-${mode}`, mode);

      await entry.session.onBatchResult(bannedOnlyResult(4));
      await entry.questionGate.flush();

      const frames = questionFrames(ws);
      expect(frames).toHaveLength(1);
      expect(frames[0].question_type).toBe(DESIGNATION_HYGIENE_QUESTION_TYPE);
      expect(frames[0].purpose).toBe(DESIGNATION_HYGIENE_QUESTION_PURPOSE);
      expect(frames[0].circuit).toBe(4);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Shadow-mode consumption is CLOSED: only the tagged question, never
// arbitrary model-authored legacy questions
// ─────────────────────────────────────────────────────────────────────────────

describe('shadow-mode closed consumption', () => {
  test('model-authored legacy questions stay refused; the tagged clarification alone is consumed (and the bypass diagnostic still fires)', async () => {
    const { ws, entry } = await startSession('desig-shadow-mixed', 'shadow');
    const result = bannedOnlyResult(3);
    result.questions_for_user.push({
      type: 'unclear',
      field: 'measured_zs_ohm',
      circuit: 3,
      question: 'What was that Zs again?',
    });
    runShadowHarnessSpy.mockImplementation(async () => result);

    await sendFrame(ws, { type: 'transcript', text: 'Circuit three is called circuit.' });
    await entry.questionGate.flush();

    const frames = questionFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0].question_type).toBe(DESIGNATION_HYGIENE_QUESTION_TYPE);
    // The refused model question is still surfaced to CloudWatch as a
    // prompt-regression diagnostic.
    expect(bypassLogged()).toBe(true);
  });

  test('a hygiene-only payload does NOT trip the bypass diagnostic (it is consumed, not leaked)', async () => {
    const { ws, entry } = await startSession('desig-shadow-clean', 'shadow');
    runShadowHarnessSpy.mockImplementation(async () => bannedOnlyResult(5));

    await sendFrame(ws, { type: 'transcript', text: 'Circuit five is called circuit.' });
    await entry.questionGate.flush();

    expect(questionFrames(ws)).toHaveLength(1);
    expect(bypassLogged()).toBe(false);
  });

  test('shadow mode with NO tagged question delivers nothing (pre-existing refusal intact)', async () => {
    const { ws, entry } = await startSession('desig-shadow-none', 'shadow');
    const result = emptyResult();
    result.questions_for_user = [
      { type: 'unclear', field: 'measured_zs_ohm', circuit: 1, question: 'Repeat Zs?' },
    ];
    runShadowHarnessSpy.mockImplementation(async () => result);

    await sendFrame(ws, { type: 'transcript', text: 'Zs was nought point three.' });
    await entry.questionGate.flush();

    expect(questionFrames(ws)).toHaveLength(0);
    expect(bypassLogged()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape — rebuilt legacy confirmations serialize as EXACTLY
// {text, field, circuit} at the REAL egress (Codex cycle-1 #1)
// ─────────────────────────────────────────────────────────────────────────────

describe.each(['off', 'shadow'])(
  'confirmation wire shape (mode=%s) — ZERO-wire-change contract',
  (mode) => {
    test('a seam-rebuilt confirmation crosses the wire with only text/field/circuit keys', async () => {
      const { ws } = await startSession(`desig-wire-${mode}`, mode);

      // Build the result through the REAL seam pipeline (normalise +
      // post-sanitizer merge), exactly as the session does — then observe
      // its serialized shape on the actual extraction frame.
      const result = {
        ...emptyResult(),
        circuit_updates: [{ circuit: 3, designation: 'Ring Final Circuit', action: 'create' }],
        turn_id: 'legacy-wire-turn',
      };
      const seamReport = normaliseLegacyDesignationResult(result, { sessionId: 'wire-test' });
      mergeDesignationConfirmations(result, seamReport, { confirmationsEnabled: true });
      runShadowHarnessSpy.mockImplementation(async () => result);

      await sendFrame(ws, { type: 'transcript', text: 'Circuit three is the ring final.' });

      const extraction = ws._sent.find((m) => m.type === 'extraction');
      expect(extraction).toBeDefined();
      const confs = extraction.result?.confirmations ?? extraction.confirmations;
      expect(confs).toHaveLength(1);
      // ws._sent holds JSON.parse(JSON.stringify(...)) frames — this IS the
      // serialized wire object. The legacy contract is {text, field,
      // circuit} and nothing else (no value, no board_id).
      expect(confs[0]).toEqual({
        text: 'Circuit 3 is now the Ring Final',
        field: 'circuit_designation',
        circuit: 3,
      });
      expect(Object.keys(confs[0]).sort()).toEqual(['circuit', 'field', 'text']);
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Filled-slot filter — explicit marker admission (unit level, REAL filter)
// ─────────────────────────────────────────────────────────────────────────────

describe('filterQuestionsAgainstFilledSlots — explicit designation-hygiene admit', () => {
  test('the tagged question survives a populated circuit_designation slot', () => {
    const snapshot = { circuits: { 2: { circuit_designation: 'Kitchen sockets' } } };
    const kept = filterQuestionsAgainstFilledSlots(
      [hygieneQuestion(2)],
      snapshot,
      new Set(),
      'sess-filter-admit'
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].purpose).toBe(DESIGNATION_HYGIENE_QUESTION_PURPOSE);
  });

  test('a refill-style question against the same populated slot is still suppressed (admit is marker-scoped, not a blanket hole)', () => {
    const snapshot = { circuits: { 2: { circuit_designation: 'Kitchen sockets' } } };
    const kept = filterQuestionsAgainstFilledSlots(
      [{ type: 'unclear', field: 'circuit_designation', circuit: 2, question: 'Name again?' }],
      snapshot,
      new Set(),
      'sess-filter-suppress'
    );
    expect(kept).toHaveLength(0);
  });
});
