/**
 * Plan 00B-2 C5 — the byte-level frame parity matrix (Codex finding 10).
 *
 * Four legs of the SAME deterministic scenario matrix:
 *   production   — NEITHER evaluationContextFactory NOR sessionFactory
 *   evaluation   — BOTH factories (the full mock-lane shape)
 *   session-only — sessionFactory alone (the scripted client alone must be
 *                  byte-parity-clean)
 *   context-only — evaluationContextFactory alone (the evaluation seams
 *                  alone must be byte-parity-clean; this is the EXACT
 *                  live-lane configuration 00C will run)
 *
 * The LIVE block drives the REAL tool-call path (SONNET_TOOL_CALLS=live,
 * real EICRExtractionSession, the strict field-replay scripted client
 * swapped in per turn): an extraction turn, a dispatcher ask answered on
 * the DIRECT channel, a dispatcher ask answered on the TRANSCRIPT channel,
 * and an observation turn, then a live session stop. The LEGACY block
 * (same jest-faked client seam on every leg) covers the VCR-carrying turn,
 * the legacy question channel, the reconnect flush of a buffered
 * extraction, session stop and the 5-minute disconnect-timer expiry.
 *
 * The comparison captures the EXACT argument passed to ws.send, in
 * sequence — no JSON.parse/re-stringify, no sorting, no redaction. The
 * determinism comes from injected/faked seams (fake timers with a fixed
 * epoch; a deterministic randomUUID through BOTH import styles); the fix
 * for a spurious diff is MORE determinism, never normalisation.
 *
 * The leak sweep derives from the ONE canonical frozen exported list of
 * every evaluation-only Symbol (EVALUATION_ONLY_SYMBOLS) across raw
 * frames, every logger payload and every storage.uploadJson body — with a
 * focused RED sensitivity proof per Symbol.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Deterministic randomUUID — every other node:crypto export stays real.
let uuidCounter = 0;
jest.unstable_mockModule('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  const deterministic = () => `det-uuid-${(uuidCounter += 1)}`;
  // Both import styles are live in the stack: named `randomUUID` (harness,
  // sonnet-stream) AND `crypto.randomUUID()` via the default export
  // (sonnet-session-store) — the mint must be deterministic through BOTH.
  const mocked = { ...actual, randomUUID: deterministic };
  return { ...mocked, default: mocked };
});

const loggedPayloads = [];
jest.unstable_mockModule('../logger.js', () => ({
  default: {
    info: jest.fn((msg, meta) => loggedPayloads.push(JSON.stringify({ msg, meta }))),
    warn: jest.fn((msg, meta) => loggedPayloads.push(JSON.stringify({ msg, meta }))),
    error: jest.fn((msg, meta) => loggedPayloads.push(JSON.stringify({ msg, meta }))),
    debug: jest.fn(),
  },
}));

const uploadedBodies = [];
jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async (data, key) => {
    uploadedBodies.push(JSON.stringify({ key, data }));
  }),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');
const { EVALUATION_ONLY_SYMBOLS } = await import('../extraction/plan00-lifecycle-hooks.js');
const { createAskLedger, createDeliveryLedger } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { createMutationObserver } = await import('../extraction/plan00-semantic-capture.js');
const { makeTurnClient } = await import('../../scripts/field-replay/lib/replay-runner-core.mjs');

const getKey = async () => 'parity-key';
const verifyToken = jest.fn();

const bootstrapClient = {
  messages: {
    create() {
      throw new Error('parity bootstrap client must never dispatch');
    },
    stream() {
      throw new Error('parity bootstrap client must be replaced before dispatch');
    },
  },
};

function makeFakeWs() {
  const sentRaw = [];
  const handlers = new Map();
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(payload) {
      sentRaw.push(payload); // EXACT argument, string/Buffer preserved
    },
    ping: jest.fn(),
    close: jest.fn(),
    on: (event, handler) => handlers.set(event, handler),
  };
  return {
    ws,
    sentRaw,
    emit: async (event, data) => {
      const h = handlers.get(event);
      if (!h) throw new Error(`no handler for ${event}`);
      return h(data);
    },
  };
}

function frameBuffer(frame) {
  return Buffer.from(JSON.stringify(frame));
}

function scriptedTurnClient(rounds, violations, turnIndex = 1) {
  return makeTurnClient({
    baseRounds: rounds,
    branches: [],
    turnState: {},
    violations,
    corpusId: 'parity',
    turnIndex,
  });
}

async function drainMicrotasks(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Drive one LIVE tool-loop turn under a FIXED virtual-time schedule.
 *
 * The advance sequence is identical on every leg REGARDLESS of when the
 * turn settles — early-stopping "when settled" would let a one-microtask
 * difference in settle OBSERVATION depth shift the accumulated virtual
 * time between legs, and any Date.now()-derived token minted later (e.g.
 * a dialogue-script srv-* ask id) would then diff spuriously. Fixed
 * schedule ⇒ byte-identical timestamps ⇒ any surviving diff is a REAL
 * behavioural difference.
 */
async function driveLiveTurn({
  session,
  emit,
  sentRaw,
  sessionId,
  text,
  utteranceId,
  rounds,
  answerAfterAsk,
  violations,
  turnIndex,
}) {
  session.client = scriptedTurnClient(rounds, violations, turnIndex);
  let settled = false;
  const baseline = sentRaw.length;
  const turnPromise = emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId,
      text,
      is_final: true,
      utterance_id: utteranceId,
      confirmations_enabled: true,
    })
  ).finally(() => {
    settled = true;
  });
  await drainMicrotasks(20);
  // Fires the 1.5s question gate (and anything shorter) deterministically.
  await jest.advanceTimersByTimeAsync(2000);
  await drainMicrotasks(10);
  if (answerAfterAsk) {
    let askFrame = null;
    for (let i = sentRaw.length - 1; i >= baseline; i -= 1) {
      const s = String(sentRaw[i]);
      if (s.includes('"ask_user_started"')) {
        askFrame = JSON.parse(s);
        break;
      }
    }
    if (askFrame) {
      await answerAfterAsk(askFrame);
      await drainMicrotasks(10);
    }
    await jest.advanceTimersByTimeAsync(2000);
    await drainMicrotasks(10);
  }
  // Unconditional tail advance: fires the 45s ask timeout for any still-
  // pending ask (an unanswered ask settles identically on every leg).
  await jest.advanceTimersByTimeAsync(50000);
  await drainMicrotasks(10);
  if (!settled) throw new Error(`live turn ${utteranceId} failed to settle under the fixed pump`);
  await turnPromise;
  // Strict round consumption: every declared model round must have been
  // consumed exactly once — an under-consumed turn (e.g. the model path
  // silently not running) latches a violation instead of passing vacuously.
  session.client.assertFullyConsumed();
}

/**
 * Run the full deterministic scenario matrix under one leg configuration.
 * Returns the RAW sent-argument sequences per socket plus the diagnostics
 * sinks for the leak sweep.
 */
async function runScenarioMatrix({ withContextFactory, withSessionFactory }) {
  uuidCounter = 0;
  loggedPayloads.length = 0;
  uploadedBodies.length = 0;
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.setSystemTime(new Date('2026-08-04T12:00:00Z'));

  const violations = [];
  const evalContexts = [];
  const initOptions = {};
  if (withContextFactory) {
    initOptions.evaluationContextFactory = () => {
      const roles = {
        observer: null,
        mutationObserver: createMutationObserver({ sessionId: 'parity' }),
        askLedger: createAskLedger(),
        deliveryLedger: createDeliveryLedger(),
      };
      evalContexts.push(roles);
      return roles;
    };
  }
  if (withSessionFactory) {
    // Mirror the env-resolved mode exactly as production construction does —
    // hardcoding 'live' here would diverge the legacy-block session_ack
    // (server_impedance_clamp is advertised in live mode only).
    initOptions.sessionFactory = ({ apiKey, sessionId, certificateType }) =>
      new EICRExtractionSession(apiKey, sessionId, certificateType, {
        toolCallsMode: process.env.SONNET_TOOL_CALLS === 'live' ? 'live' : 'off',
        providerClients: { anthropic: bootstrapClient },
      });
  }
  const wss = initSonnetStream(null, getKey, verifyToken, initOptions);

  // ── LIVE block: the real tool-call path with the scripted client ──
  process.env.SONNET_TOOL_CALLS = 'live';
  const liveSid = 'parity-live';
  const a = makeFakeWs();
  wss.emit('connection', a.ws, { headers: {} }, 'parity-user');
  await a.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: liveSid,
      jobState: {
        certificateType: 'eicr',
        boards: [],
        circuits: [{ circuit_ref: 4, circuit_designation: 'Upstairs sockets' }],
      },
      capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } },
      protocol_version: 'stage6',
    })
  );
  const liveEntry = activeSessions.get(liveSid);
  const liveSession = liveEntry.session;

  // Scenario: extraction turn.
  await driveLiveTurn({
    session: liveSession,
    emit: a.emit,
    sentRaw: a.sentRaw,
    violations,
    sessionId: liveSid,
    text: 'R1 plus R2 for circuit 4 is 0.32.',
    utteranceId: 'parity-utt-1',
    turnIndex: 1,
    rounds: [
      {
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'toolu_parity_r1r2',
            name: 'record_reading',
            input: {
              field: 'r1_r2_ohm',
              circuit: 4,
              value: '0.32',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
        ],
      },
      { stop_reason: 'end_turn', text: '' },
    ],
  });

  // Scenario: dispatcher ask answered on the DIRECT channel.
  await driveLiveTurn({
    session: liveSession,
    emit: a.emit,
    sentRaw: a.sentRaw,
    violations,
    sessionId: liveSid,
    text: 'The Zs was point five five.',
    utteranceId: 'parity-utt-2',
    turnIndex: 2,
    rounds: [
      {
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'toolu_parity_ask1',
            name: 'ask_user',
            input: {
              question: 'Which circuit was that Zs for?',
              reason: 'missing_context',
              context_field: 'measured_zs_ohm',
              context_circuit: null,
              expected_answer_shape: 'circuit_ref',
            },
          },
        ],
      },
      { stop_reason: 'end_turn', text: '' },
    ],
    answerAfterAsk: async (askFrame) => {
      await a.emit(
        'message',
        frameBuffer({
          type: 'ask_user_answered',
          sessionId: liveSid,
          tool_call_id: askFrame.tool_call_id,
          user_text: 'Circuit 4.',
        })
      );
    },
  });

  // Scenario: dispatcher ask answered on the TRANSCRIPT channel (a bare
  // value reply — resolves via the overtake classifier, or settles on the
  // deterministic timeout identically across legs). Wording deliberately
  // avoids the dialogue-script trigger vocabulary so this is a MODEL ask.
  await driveLiveTurn({
    session: liveSession,
    emit: a.emit,
    sentRaw: a.sentRaw,
    violations,
    sessionId: liveSid,
    text: 'Zs for circuit 4.',
    utteranceId: 'parity-utt-3',
    turnIndex: 3,
    rounds: [
      {
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'toolu_parity_ask2',
            name: 'ask_user',
            input: {
              question: 'Which circuit is that reading for?',
              reason: 'missing_context',
              context_field: 'measured_zs_ohm',
              context_circuit: null,
              // circuit_ref is the ONE shape the transcript-channel overtake
              // classifier resolves from a bare spoken reply (a bare number
              // answer to a `number` ask is deliberately ambiguous — see
              // stage6-overtake-classifier.js).
              expected_answer_shape: 'circuit_ref',
            },
          },
        ],
      },
      { stop_reason: 'end_turn', text: '' },
    ],
    answerAfterAsk: async () => {
      // The TRANSCRIPT answer channel: the overtake classifier consumes the
      // reply into the pending ask (verdict `answers`), so the transcript is
      // never forwarded as its own model turn. The ask-ledger assertion in
      // the test proves the ANSWERED terminal — a timeout would fail it.
      await a
        .emit(
          'message',
          frameBuffer({
            type: 'transcript',
            sessionId: liveSid,
            text: 'Circuit 7.',
            is_final: true,
            utterance_id: 'parity-utt-3b',
            confirmations_enabled: true,
          })
        )
        .catch(() => {});
    },
  });

  // Scenario: observation turn.
  await driveLiveTurn({
    session: liveSession,
    emit: a.emit,
    sentRaw: a.sentRaw,
    violations,
    sessionId: liveSid,
    text: 'There is a cracked socket front in the kitchen, code C2.',
    utteranceId: 'parity-utt-4',
    turnIndex: 4,
    rounds: [
      {
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'toolu_parity_obs',
            name: 'record_observation',
            input: {
              code: 'C2',
              location: 'Kitchen',
              text: 'Cracked socket front',
              circuit: null,
              suggested_regulation: '134.1.1',
              schedule_item: null,
              rationale: null,
              clarification_chain_id: null,
            },
          },
        ],
      },
      { stop_reason: 'end_turn', text: '' },
    ],
  });

  // Scenario: live session stop.
  await a.emit('message', frameBuffer({ type: 'session_stop', sessionId: liveSid }));

  // ── LEGACY block: same jest-faked client seam on EVERY leg ──
  process.env.SONNET_TOOL_CALLS = 'off';
  const sid = 'parity-legacy';
  const b = makeFakeWs();
  wss.emit('connection', b.ws, { headers: {} }, 'parity-user');
  await b.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: sid,
      jobState: { certificateType: 'eicr', boards: [], circuits: [] },
      capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } },
      protocol_version: 'stage6',
    })
  );
  const legacyEntry = activeSessions.get(sid);
  legacyEntry.session.toolCallsMode = 'off';

  // Scenario: legacy question turn + the question-gate flush.
  legacyEntry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    questions_for_user: [
      { type: 'unclear', question: 'Which circuit was that Zs for?', field: 'measured_zs_ohm' },
    ],
    turn_id: 'parity-turn-ask',
  }));
  await b.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Zs is 0.51.',
      is_final: true,
      utterance_id: 'parity-utt-l1',
      confirmations_enabled: true,
    })
  );
  await jest.advanceTimersByTimeAsync(1600); // the 1.5s question-gate flush

  // Scenario: standalone observation UPDATE + RECODE frames (Plan 00B-3 C4 —
  // cycle-5 finding 4). The RULE-6 classifier emits result.observationUpdates
  // (a CODE-CHANGE recode carrying previous_code, and a correction-lead-in
  // update); the frames ride the SAME buildResultFrameLedger egress on every
  // leg, so evaluation-only interference with observation_update frames now
  // breaks the byte-parity loop instead of leaving the 4/4 gate green.
  legacyEntry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    observationUpdates: [
      {
        observation_id: 'obs-parity-1',
        observation_text: 'Cracked socket front',
        code: 'C3',
        previous_code: 'C2',
        regulation: '134.1.1',
        rationale: 'code_change',
        source: 'rule_6_edit',
      },
      {
        observation_id: 'obs-parity-2',
        observation_text: 'Actually cracked socket front near the hob',
        code: 'C3',
        previous_code: null,
        regulation: null,
        rationale: 'correction_lead_in',
        source: 'rule_6_edit',
      },
    ],
    questions_for_user: [],
    turn_id: 'parity-turn-obs-upd',
  }));
  await b.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'The cracked socket front is a C3.',
      is_final: true,
      utterance_id: 'parity-utt-l1b',
      confirmations_enabled: true,
    })
  );

  // Scenario: VCR-carrying turn (spoken_response + action).
  legacyEntry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    questions_for_user: [],
    voice_command: { action: 'rename_circuit', circuit: 4 },
    spoken_response: 'Renamed circuit 4 to kitchen sockets.',
    action: 'rename_circuit',
    turn_id: 'parity-turn-vcr',
  }));
  await b.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Rename circuit 4 to kitchen sockets.',
      is_final: true,
      utterance_id: 'parity-utt-l2',
      confirmations_enabled: true,
    })
  );

  // Scenario: reconnect flush — buffer an extraction on a CLOSED socket,
  // then reconnect on a fresh socket and observe the replay frames.
  legacyEntry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [{ field: 'measured_zs_ohm', circuit: 4, value: '0.63', confidence: 0.9 }],
    observations: [],
    questions_for_user: [],
    turn_id: 'parity-turn-buffered',
  }));
  b.ws.readyState = 3;
  await b.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Zs for circuit 4 is 0.63.',
      is_final: true,
      utterance_id: 'parity-utt-l3',
      confirmations_enabled: true,
    })
  );
  const c = makeFakeWs();
  wss.emit('connection', c.ws, { headers: {} }, 'parity-user');
  await c.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: sid,
      jobState: { certificateType: 'eicr', boards: [], circuits: [] },
      capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } },
      protocol_version: 'stage6',
    })
  );

  // Scenario: session stop on the live socket.
  await c.emit('message', frameBuffer({ type: 'session_stop', sessionId: sid }));

  // Scenario: disconnect-timer retry — a third session left to expire.
  const d = makeFakeWs();
  wss.emit('connection', d.ws, { headers: {} }, 'parity-user');
  await d.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: 'parity-expire',
      jobState: { certificateType: 'eicr', boards: [], circuits: [] },
      protocol_version: 'stage6',
    })
  );
  await d.emit('close');
  await jest.advanceTimersByTimeAsync(300001);

  return {
    frames: { a: [...a.sentRaw], b: [...b.sentRaw], c: [...c.sentRaw], d: [...d.sentRaw] },
    logs: [...loggedPayloads],
    uploads: [...uploadedBodies],
    violations,
    evalContexts,
  };
}

const SAVED_MODE = process.env.SONNET_TOOL_CALLS;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
  if (SAVED_MODE === undefined) delete process.env.SONNET_TOOL_CALLS;
  else process.env.SONNET_TOOL_CALLS = SAVED_MODE;
});

describe('C5 — byte-level frame parity across the four legs', () => {
  test('production vs evaluation vs each single-factory leg: EXACT ws.send sequences', async () => {
    const production = await runScenarioMatrix({
      withContextFactory: false,
      withSessionFactory: false,
    });
    const evaluation = await runScenarioMatrix({
      withContextFactory: true,
      withSessionFactory: true,
    });
    const sessionOnly = await runScenarioMatrix({
      withContextFactory: false,
      withSessionFactory: true,
    });
    const contextOnly = await runScenarioMatrix({
      withContextFactory: true,
      withSessionFactory: false,
    });

    // Sanity: the LIVE block genuinely exercised the tool-call path —
    // a real reading write, BOTH dispatcher asks crossing the wire, and a
    // real observation dispatch (the Codex finding-10 matrix) — and every
    // socket produced frames.
    const liveAsks = production.frames.a.filter((f) => f.includes('"ask_user_started"'));
    expect(liveAsks.length).toBeGreaterThanOrEqual(2);
    expect(production.frames.a.some((f) => f.includes('"r1_plus_r2"'))).toBe(true);
    expect(
      production.frames.a.some(
        (f) => f.includes('"observations":[{') || f.includes('"observation_text"')
      )
    ).toBe(true);
    expect(production.frames.b.some((f) => f.includes('"voice_command_response"'))).toBe(true);
    expect(production.frames.c.length).toBeGreaterThan(0);
    expect(production.frames.d.length).toBeGreaterThan(0);
    // Plan 00B-3 C4 — the standalone observation UPDATE and RECODE
    // scenarios genuinely produced rule_6_edit observation_update frames
    // (a recode via code_change AND an update via correction_lead_in);
    // evaluation-only interference with these frames would break the
    // byte-parity loop below.
    const obsUpdateFrames = production.frames.b.filter(
      (f) => f.includes('"observation_update"') && f.includes('rule_6_edit')
    );
    expect(obsUpdateFrames.length).toBeGreaterThanOrEqual(2);
    expect(obsUpdateFrames.some((f) => f.includes('code_change'))).toBe(true);
    expect(obsUpdateFrames.some((f) => f.includes('correction_lead_in'))).toBe(true);
    expect(obsUpdateFrames.some((f) => f.includes('"code":"C3"'))).toBe(true);

    // Discrimination (mini-review r1 finding 10): the scenarios must have
    // RUN as intended, not merely produced identical bytes.
    // (a) Every scripted model round was consumed exactly once on every leg
    //     — an under-consumed turn latches a strict-consumption violation.
    for (const leg of [production, evaluation, sessionOnly, contextOnly]) {
      expect(leg.violations).toEqual([]);
    }
    // (b) BOTH dispatcher asks genuinely resolved as ANSWERED through their
    //     intended channels — proven on the evaluation leg's ask ledger
    //     (the same run whose frames are byte-identical to production, so
    //     the proof carries across). A timeout terminal would fail here.
    const liveAskLedger = evaluation.evalContexts[0]?.askLedger;
    expect(liveAskLedger).toBeTruthy();
    const askStates = new Map(liveAskLedger.entries.map((e) => [e.runtime_id, e.state]));
    expect(askStates.get('toolu_parity_ask1')).toBe('answered'); // direct channel
    expect(askStates.get('toolu_parity_ask2')).toBe('answered'); // transcript channel
    expect(liveAskLedger.invalid).toBeNull();

    for (const legName of ['evaluation', 'sessionOnly', 'contextOnly']) {
      const leg = { evaluation, sessionOnly, contextOnly }[legName];
      for (const sock of ['a', 'b', 'c', 'd']) {
        expect(leg.frames[sock]).toEqual(production.frames[sock]);
      }
    }
  }, 60000);
});

describe('C5 — evaluation-only Symbol leak sweep (derived from the canonical frozen list)', () => {
  function sweep(str, description) {
    return str.includes(description);
  }

  test('no evaluation Symbol description reaches raw frames, logger payloads or storage bodies', async () => {
    const evaluation = await runScenarioMatrix({
      withContextFactory: true,
      withSessionFactory: true,
    });
    const surfaces = [
      ...evaluation.frames.a,
      ...evaluation.frames.b,
      ...evaluation.frames.c,
      ...evaluation.frames.d,
      ...evaluation.logs,
      ...evaluation.uploads,
    ].map((s) => (typeof s === 'string' ? s : String(s)));
    expect(EVALUATION_ONLY_SYMBOLS.length).toBeGreaterThanOrEqual(9);
    for (const { name, symbol } of EVALUATION_ONLY_SYMBOLS) {
      expect(typeof symbol).toBe('symbol');
      const description = symbol.description;
      expect(description).toBeTruthy();
      for (const s of surfaces) {
        if (sweep(s, description)) {
          throw new Error(
            `evaluation Symbol ${name} (${description}) leaked into: ${s.slice(0, 200)}`
          );
        }
      }
    }
  }, 60000);

  test('RED sensitivity proof: a leaked Symbol description IS caught, per Symbol', () => {
    for (const { symbol } of EVALUATION_ONLY_SYMBOLS) {
      const leakedPayload = JSON.stringify({ [symbol.description]: 'leaked' });
      expect(sweep(leakedPayload, symbol.description)).toBe(true);
      // And the non-enumerable Symbol key itself can never serialise.
      const carrier = {};
      Object.defineProperty(carrier, symbol, { value: 'x', enumerable: false });
      expect(JSON.stringify(carrier)).toBe('{}');
    }
  });
});

describe('C5 — voice-latency playback-ack route parity (HTTP surface — cannot ride the WS sequence)', () => {
  test('identical status, body and headers with and without an attached evaluation context', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createPlaybackAckRouter } = await import('../routes/voice-latency-playback-ack.js');
    const { attachEvaluationContext, normaliseEvaluationContext } =
      await import('../extraction/plan00-lifecycle-hooks.js');

    const makeApp = (withContext) => {
      const entry = { userId: 'route-user', session: {} };
      if (withContext) {
        const ctx = normaliseEvaluationContext(
          { deliveryLedger: createDeliveryLedger(), askLedger: createAskLedger() },
          { sessionId: 'parity-route' }
        );
        // Give the evaluation leg a matchable delivery row so its forwarding
        // path genuinely runs (a resolved playback), not just a no-op miss.
        ctx.recordDelivery(
          [{ extractionTurnId: 't1', field: 'measured_zs_ohm', circuit: 4, boardId: null }],
          {
            producerId: 'result_frame_confirmation',
            kind: 'confirmation',
            text: 'Circuit 4, Zs 0.63',
          }
        );
        attachEvaluationContext(entry, ctx);
      }
      const router = createPlaybackAckRouter({
        requireAuth: (req, _res, next) => {
          req.user = { id: 'route-user' };
          next();
        },
        getActiveSessionEntry: () => entry,
      });
      const app = express();
      app.use(express.json());
      app.use('/api', router);
      return app;
    };

    const bodies = [
      {
        sessionId: 'parity-route',
        turnId: 't-route',
        slot: { field: 'measured_zs_ohm', circuit: 4, boardId: null },
        source: 'bundler',
        at_ms: 1754300000000,
      },
      // Slot-less ACK (optional slot) and the fast_tts source path.
      { sessionId: 'parity-route', turnId: 't-route', source: 'bundler', at_ms: 1754300000000 },
      {
        sessionId: 'parity-route',
        turnId: 't-route',
        source: 'fast_tts',
        at_ms: 1754300000000,
      },
      // A validation failure must reject identically too.
      { sessionId: 'parity-route', source: 'bundler' },
    ];
    for (const body of bodies) {
      const prod = await request(makeApp(false)).post('/api/voice-latency/playback-ack').send(body);
      const evald = await request(makeApp(true)).post('/api/voice-latency/playback-ack').send(body);
      expect(evald.status).toBe(prod.status);
      expect(evald.text).toBe(prod.text);
      expect(evald.headers['content-type'] ?? null).toBe(prod.headers['content-type'] ?? null);
    }
  });
});
