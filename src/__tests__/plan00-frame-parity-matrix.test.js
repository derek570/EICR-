/**
 * Plan 00B-2 C5 — the byte-level frame parity matrix (Codex finding 10).
 *
 * Four legs of the SAME deterministic scenario matrix:
 *   production  — NEITHER evaluationContextFactory NOR sessionFactory
 *   evaluation  — BOTH factories (the full mock-lane shape)
 *   session-only — sessionFactory alone (the scripted client alone must be
 *                  byte-parity-clean)
 *   context-only — evaluationContextFactory alone (the evaluation seams
 *                  alone must be byte-parity-clean; this is the EXACT
 *                  live-lane configuration 00C will run)
 *
 * The comparison captures the EXACT argument passed to ws.send, in
 * sequence — no JSON.parse/re-stringify, no sorting, no redaction. The
 * determinism comes from injected/faked seams (fake timers with a fixed
 * epoch, a deterministic randomUUID, identical scripted clients and
 * inputs); the fix for a spurious diff is MORE determinism, never
 * normalisation.
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

const mockSessionInstances = [];
class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType, _opts = undefined) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.utteranceBuffer = [];
    this.stateSnapshot = { boards: [], circuits: [], currentBoardId: null, observations: [] };
    this.costTracker = {
      toCostUpdate: () => ({ type: 'cost_update', cost: 0 }),
      inFlightBillableInvocationCount: 0,
      usageRevision: 0,
    };
    this.start = jest.fn();
    this.stop = jest.fn(() => ({ totals: { cost: 0 } }));
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

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { EVALUATION_ONLY_SYMBOLS } = await import('../extraction/plan00-lifecycle-hooks.js');
const { createAskLedger, createDeliveryLedger } =
  await import('../extraction/plan00-audibility-ledgers.js');
const { createMutationObserver } = await import('../extraction/plan00-semantic-capture.js');

const getKey = async () => 'parity-key';
const verifyToken = jest.fn();

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

/**
 * Run the full deterministic scenario matrix under one leg configuration.
 * Returns the RAW sent-argument sequences per socket plus the diagnostics
 * sinks for the leak sweep.
 */
async function runScenarioMatrix({ withContextFactory, withSessionFactory }) {
  uuidCounter = 0;
  loggedPayloads.length = 0;
  uploadedBodies.length = 0;
  mockSessionInstances.length = 0;
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.setSystemTime(new Date('2026-08-04T12:00:00Z'));

  const initOptions = {};
  if (withContextFactory) {
    initOptions.evaluationContextFactory = () => ({
      observer: null,
      mutationObserver: createMutationObserver({ sessionId: 'parity' }),
      askLedger: createAskLedger(),
      deliveryLedger: createDeliveryLedger(),
    });
  }
  if (withSessionFactory) {
    initOptions.sessionFactory = ({ apiKey, sessionId, certificateType }) =>
      new FakeEICRExtractionSession(apiKey, sessionId, certificateType, {
        providerClients: {},
      });
  }
  const wss = initSonnetStream(null, getKey, verifyToken, initOptions);

  const sid = 'parity-session';
  const a = makeFakeWs();
  wss.emit('connection', a.ws, { headers: {} }, 'parity-user');

  // Scenario: session start (stage6 handshake).
  await a.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: sid,
      jobState: { certificateType: 'eicr', boards: [], circuits: [] },
      capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } },
      protocol_version: 'stage6',
    })
  );

  // Scenario: extraction turn (mode off → the jest-faked session client
  // seam; the scripted result is identical across legs).
  const entry = activeSessions.get(sid);
  entry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [{ field: 'r1_r2_ohm', circuit: 4, value: '0.32', confidence: 0.9 }],
    observations: [],
    questions_for_user: [],
    confirmations: [{ field: 'r1_r2_ohm', circuit: 4, text: 'Circuit 4, R1 plus R2 0.32' }],
    turn_id: 'parity-turn-1',
  }));
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'R1 plus R2 for circuit 4 is 0.32.',
      is_final: true,
      utterance_id: 'parity-utt-1',
      confirmations_enabled: true,
    })
  );

  // Scenario: ask turn (legacy question channel) + BOTH answer channels —
  // a direct ask_user_answered frame and an in_response_to transcript.
  entry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    questions_for_user: [
      { type: 'unclear', question: 'Which circuit was that Zs for?', field: 'measured_zs_ohm' },
    ],
    turn_id: 'parity-turn-ask',
  }));
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Zs is 0.51.',
      is_final: true,
      utterance_id: 'parity-utt-ask',
      confirmations_enabled: true,
    })
  );
  await jest.advanceTimersByTimeAsync(1600); // the 1.5s question-gate flush
  await a.emit(
    'message',
    frameBuffer({
      type: 'ask_user_answered',
      sessionId: sid,
      tool_call_id: 'toolu_parity_direct',
      user_text: 'Circuit 4.',
    })
  );
  entry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    questions_for_user: [],
    turn_id: 'parity-turn-answer',
  }));
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Circuit 4.',
      is_final: true,
      utterance_id: 'parity-utt-answer',
      confirmations_enabled: true,
      in_response_to: { type: 'unclear', question: 'Which circuit was that Zs for?' },
    })
  );

  // Scenario: observation turn + a VCR-carrying turn (spoken_response).
  entry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [
      {
        observation_id: 'parity-obs-1',
        observation_text: 'Cracked socket front in the kitchen',
        code: 'C2',
      },
    ],
    questions_for_user: [],
    turn_id: 'parity-turn-obs',
  }));
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Observation: cracked socket front in the kitchen, C2.',
      is_final: true,
      utterance_id: 'parity-utt-obs',
      confirmations_enabled: true,
    })
  );
  entry.session.extractFromUtterance = jest.fn(async () => ({
    extracted_readings: [],
    observations: [],
    questions_for_user: [],
    voice_command: { action: 'rename_circuit', circuit: 4 },
    spoken_response: 'Renamed circuit 4 to kitchen sockets.',
    action: 'rename_circuit',
    turn_id: 'parity-turn-vcr',
  }));
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Rename circuit 4 to kitchen sockets.',
      is_final: true,
      utterance_id: 'parity-utt-vcr',
      confirmations_enabled: true,
    })
  );

  // Scenario: reconnect flush — buffer an extraction on a CLOSED socket,
  // then reconnect on a fresh socket and observe the replay frames.
  a.ws.readyState = 3;
  await a.emit(
    'message',
    frameBuffer({
      type: 'transcript',
      sessionId: sid,
      text: 'Zs for circuit 4 is 0.63.',
      is_final: true,
      utterance_id: 'parity-utt-2',
      confirmations_enabled: true,
    })
  );
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

  // Scenario: session stop on the live socket.
  await b.emit('message', frameBuffer({ type: 'session_stop', sessionId: sid }));

  // Scenario: disconnect-timer retry — a second session left to expire.
  const c = makeFakeWs();
  wss.emit('connection', c.ws, { headers: {} }, 'parity-user');
  await c.emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId: 'parity-expire',
      jobState: { certificateType: 'eicr', boards: [], circuits: [] },
      protocol_version: 'stage6',
    })
  );
  await c.emit('close');
  await jest.advanceTimersByTimeAsync(300001);

  return {
    frames: { a: [...a.sentRaw], b: [...b.sentRaw], c: [...c.sentRaw] },
    logs: [...loggedPayloads],
    uploads: [...uploadedBodies],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
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

    // Sanity: the matrix genuinely produced frames on every socket.
    expect(production.frames.a.length).toBeGreaterThan(0);
    expect(production.frames.b.length).toBeGreaterThan(0);
    expect(production.frames.c.length).toBeGreaterThan(0);

    for (const legName of ['evaluation', 'sessionOnly', 'contextOnly']) {
      const leg = { evaluation, sessionOnly, contextOnly }[legName];
      for (const sock of ['a', 'b', 'c']) {
        expect(leg.frames[sock]).toEqual(production.frames[sock]);
      }
    }
  });
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
  });

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
