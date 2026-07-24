/**
 * stage6-observation-tier-routing.test.js — the observation-tier model router
 * on the LIVE recording path (chunk C1).
 *
 * WHY: runLiveMode historically hard-coded `model: SHADOW_MODEL`
 * (= process.env.SONNET_EXTRACT_MODEL = Haiku in prod) into runToolLoop, so
 * EVERY observation severity-coding turn ran on Haiku — the tiered router in
 * EICRExtractionSession.callWithRetry (eicr-extraction-session.js:2798) that
 * escalates observation turns to OBSERVATION_EXTRACT_MODEL (Sonnet) never fired
 * on this path. This suite is the deterministic routing matrix.
 *
 * The router:
 *   - is DARK behind OBSERVATION_TIER_ROUTING (default OFF → byte-identical);
 *   - classifies OBSERVATION_PATTERN on the RAW inspector text
 *     (options.rawInspectorTranscript = untouched msg.text), NEVER the enriched
 *     transcriptText — so a bare answer on an observation-question turn cannot
 *     escalate (server-context isolation);
 *   - routes the WHOLE loop (every continuation round) to the selected model;
 *   - locks out the round-1 VOICE_LATENCY_ROUND1_MODEL override for
 *     observation-tier turns (reading turns keep it);
 *   - flows the selected model to the cost tracker (toolLoopOut.model);
 *   - emits ONE PII-safe stage6.observation_tier_routing telemetry event.
 *
 * Model output QUALITY (does Sonnet actually code C2 correctly) is NOT tested
 * here — that is advisory live-lane probing (non-deterministic). This suite
 * asserts only WHICH MODEL the SDK is invoked with.
 */

import { jest } from '@jest/globals';

import { mockClient } from './helpers/mockStream.js';
import {
  makeLiveSession as makeF7LiveSession,
  makeOpenWs,
  toolUseRound as f7ToolUseRound,
  endTurnRound as f7EndTurnRound,
  askStartedFrames,
} from './helpers/f7-audibility-matrix.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { ASK_USER_TIMEOUT_MS } from '../extraction/stage6-dispatcher-ask.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { CostTracker } from '../extraction/cost-tracker.js';

// A distinctive sentinel so a routed observation turn is unambiguous vs the
// default (SHADOW_MODEL, latched from SONNET_EXTRACT_MODEL at module import).
const OBS_MODEL = 'claude-observation-tier-sentinel';
const ROUND1_MODEL = 'claude-round1-fast-sentinel';

// Observation-shaped raw utterance (contains the literal "observation" →
// matches OBSERVATION_PATTERN). Reading utterance is digits-only (no match).
const OBS_TRANSCRIPT = 'observation, cracked socket outlet on circuit four, category two';
const READING_TRANSCRIPT = 'zs circuit one is nought point six two';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function endTurnRound(text = 'ok') {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_end',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 40 },
    },
    { type: 'message_stop' },
  ];
}

function toolUseRound(name, input) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_tu',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 500,
          output_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 30 },
    },
    { type: 'message_stop' },
  ];
}

function makeLiveSession(rounds) {
  return {
    sessionId: 'sess-obs-routing',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST',
    client: mockClient(rounds),
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    extractedReadingsCount: 0,
    askedQuestions: [],
    pendingAsks: { size: 0, entries: () => [], register: jest.fn() },
    costTracker: new CostTracker(),
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    extractFromUtterance: jest.fn(),
  };
}

/** Pull the single stage6.observation_tier_routing telemetry payload. */
function routingEvent(logger) {
  const call = logger.info.mock.calls.find((c) => c[0] === 'stage6.observation_tier_routing');
  return call ? call[1] : null;
}

// ---------------------------------------------------------------------------
// Env isolation — the router live-reads OBSERVATION_TIER_ROUTING and
// OBSERVATION_EXTRACT_MODEL (mirroring callWithRetry). SHADOW_MODEL is
// module-latched at import, so the DEFAULT model is fixed for the process;
// assertions read it back from the telemetry event rather than hardcoding it.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'OBSERVATION_TIER_ROUTING',
  'OBSERVATION_EXTRACT_MODEL',
  'VOICE_LATENCY_ROUND1_MODEL',
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Clean slate each test.
  delete process.env.OBSERVATION_TIER_ROUTING;
  delete process.env.OBSERVATION_EXTRACT_MODEL;
  delete process.env.VOICE_LATENCY_ROUND1_MODEL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('observation-tier routing — model selection matrix', () => {
  test('flag ON + observation raw utterance → routes to OBSERVATION_EXTRACT_MODEL', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    await runShadowHarness(session, OBS_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });

    const ev = routingEvent(logger);
    expect(ev).toBeTruthy();
    // EXACT five-field shape — no transcript text, no extra keys (PII-safe
    // contract). default_model is SHADOW_MODEL (module-latched); read it back
    // rather than hardcoding the process's latched value.
    expect(Object.keys(ev).sort()).toEqual(
      ['classifier_match', 'default_model', 'flag_enabled', 'round1_override_locked', 'selected_model'].sort()
    );
    expect(ev).toEqual({
      classifier_match: true,
      flag_enabled: true,
      selected_model: OBS_MODEL,
      default_model: ev.default_model,
      round1_override_locked: true,
    });
    // End-to-end: the model actually reaching the SDK is the observation tier.
    expect(session.client._calls[0].model).toBe(OBS_MODEL);
  });

  test('ordinary reading turn → stays on the default model (SHADOW_MODEL) even flag ON', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    await runShadowHarness(session, READING_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: READING_TRANSCRIPT,
    });

    const ev = routingEvent(logger);
    expect(ev.classifier_match).toBe(false);
    expect(ev.flag_enabled).toBe(true);
    expect(ev.selected_model).toBe(ev.default_model);
    expect(ev.selected_model).not.toBe(OBS_MODEL);
    expect(ev.round1_override_locked).toBe(false);
    expect(session.client._calls[0].model).toBe(ev.default_model);
  });

  test('flag OFF → default model for EVERYTHING (dark-ship byte-identity), even an observation utterance', async () => {
    // No OBSERVATION_TIER_ROUTING set (default OFF).
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    await runShadowHarness(session, OBS_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });

    const ev = routingEvent(logger);
    // The raw text still matched the pattern, but the flag gates the route.
    expect(ev.classifier_match).toBe(true);
    expect(ev.flag_enabled).toBe(false);
    expect(ev.selected_model).toBe(ev.default_model);
    expect(ev.selected_model).not.toBe(OBS_MODEL);
    expect(ev.round1_override_locked).toBe(false);
    expect(session.client._calls[0].model).toBe(ev.default_model);
  });

  test('server-added context cannot escalate: a bare "yes" answer stays on the default model', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    // The ENRICHED transcript (what sonnet-stream builds at :3758) mentions
    // "observation" and DOES match OBSERVATION_PATTERN — proving the danger.
    const enriched = '[In response to TTS question: is this an observation?] yes';
    expect(
      // sanity: the enriched string WOULD have escalated if we classified it
      /\b(?:obs|[oa]?b[a-z]{0,5}v[a-z]{0,4}(?:tion|sion|shun|shen|shan|shon|nce|tor|tior|ation))s?\b/i.test(
        enriched
      )
    ).toBe(true);

    await runShadowHarness(session, enriched, [], {
      logger,
      // …but the router classifies ONLY the raw inspector text, which is "yes".
      rawInspectorTranscript: 'yes',
    });

    const ev = routingEvent(logger);
    expect(ev.classifier_match).toBe(false);
    expect(ev.selected_model).toBe(ev.default_model);
    expect(ev.selected_model).not.toBe(OBS_MODEL);
    expect(session.client._calls[0].model).toBe(ev.default_model);
  });

  test('flag ON + observation utterance but OBSERVATION_EXTRACT_MODEL unset → safe fallback to default', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    // OBSERVATION_EXTRACT_MODEL deliberately unset.
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    await runShadowHarness(session, OBS_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });

    const ev = routingEvent(logger);
    expect(ev.classifier_match).toBe(true);
    expect(ev.flag_enabled).toBe(true);
    expect(ev.selected_model).toBe(ev.default_model);
    expect(ev.round1_override_locked).toBe(false);
    expect(session.client._calls[0].model).toBe(ev.default_model);
  });

  test('missing rawInspectorTranscript (legacy caller) → never escalates', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);

    // No rawInspectorTranscript in options → classified as '' → no match.
    await runShadowHarness(session, OBS_TRANSCRIPT, [], { logger });

    const ev = routingEvent(logger);
    expect(ev.classifier_match).toBe(false);
    expect(ev.selected_model).toBe(ev.default_model);
    expect(session.client._calls[0].model).toBe(ev.default_model);
  });
});

describe('observation-tier routing — multi-round + override lock + cost', () => {
  test('EVERY continuation round stays on the selected model (multi-round loop)', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    // Round 1 emits a tool_use → the loop continues → round 2 end_turn. Both
    // Anthropic calls must run on the observation tier (the model is passed
    // ONCE to runToolLoop and reused every round). The BLOCKING ask_user
    // suspend/resume variant of this contract is pinned by the "blocking
    // ask_user continuation" describe block below in this file.
    const session = makeLiveSession([
      toolUseRound('record_observation', { category: 'C2', description: 'cracked socket' }),
      endTurnRound(),
    ]);

    await runShadowHarness(session, OBS_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });

    expect(session.client._callCount).toBe(2);
    expect(session.client._calls[0].model).toBe(OBS_MODEL);
    expect(session.client._calls[1].model).toBe(OBS_MODEL);
  });

  test('observation turns IGNORE the round-1 override; reading turns RETAIN it', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    process.env.VOICE_LATENCY_ROUND1_MODEL = ROUND1_MODEL;

    // Reading turn: round-1 override applies (latency fast-path).
    const readingLogger = makeLogger();
    const readingSession = makeLiveSession([endTurnRound()]);
    await runShadowHarness(readingSession, READING_TRANSCRIPT, [], {
      logger: readingLogger,
      rawInspectorTranscript: READING_TRANSCRIPT,
    });
    expect(readingSession.client._calls[0].model).toBe(ROUND1_MODEL);

    // Observation turn: the model is LOCKED — the round-1 override cannot
    // swap the Sonnet escalation back to the fast model.
    const obsLogger = makeLogger();
    const obsSession = makeLiveSession([endTurnRound()]);
    await runShadowHarness(obsSession, OBS_TRANSCRIPT, [], {
      logger: obsLogger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });
    expect(routingEvent(obsLogger).round1_override_locked).toBe(true);
    expect(obsSession.client._calls[0].model).toBe(OBS_MODEL);
  });

  test('the cost tracker receives the SELECTED model (observation tier)', async () => {
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();
    const session = makeLiveSession([endTurnRound()]);
    const addSpy = jest.spyOn(session.costTracker, 'addSonnetUsage');

    await runShadowHarness(session, OBS_TRANSCRIPT, [], {
      logger,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith(expect.any(Object), OBS_MODEL);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Blocking ask_user continuation — driven through the REAL ask dispatcher +
// pending-asks registry + runToolLoop so the ask genuinely SUSPENDS the loop
// and RESUMES on the ANSWER (not a timeout). This is the load-bearing
// multi-round case the plan names: the selected model must hold across the
// suspend/resume boundary. Uses the F7 integration lane's proven fake-timer
// drive (stage6-audibility-invariants.test.js) — the gate debounce + the 45s
// ask timeout make real timers impractical. The test asserts the answer
// actually resolved the ask (registry emptied by the ANSWER, before the
// timeout) so a timeout-driven resume cannot false-pass the model assertions.
// ───────────────────────────────────────────────────────────────────────────
describe('observation-tier routing — blocking ask_user continuation (real dispatcher)', () => {
  const SID = 'sess-obs-routing-ask';
  const MAX_ADVANCE_MS = QUESTION_GATE_DELAY_MS + ASK_USER_TIMEOUT_MS + 2000;
  let savedFlag;
  let savedModel;

  beforeEach(() => {
    jest.useFakeTimers();
    // The router reads getActiveSessionEntry(sessionId); register a minimal
    // entry (loadedBarrel OFF → speculator skipped) exactly like the F7 lane.
    activeSessions.set(SID, {
      session: { sessionId: SID },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
    savedFlag = process.env.OBSERVATION_TIER_ROUTING;
    savedModel = process.env.OBSERVATION_EXTRACT_MODEL;
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
  });

  afterEach(() => {
    activeSessions.delete(SID);
    jest.useRealTimers();
    if (savedFlag === undefined) delete process.env.OBSERVATION_TIER_ROUTING;
    else process.env.OBSERVATION_TIER_ROUTING = savedFlag;
    if (savedModel === undefined) delete process.env.OBSERVATION_EXTRACT_MODEL;
    else process.env.OBSERVATION_EXTRACT_MODEL = savedModel;
  });

  /** Drive one live turn under fake timers, resolving any queued ask the moment
   *  it registers (ported from stage6-audibility-invariants.test.js). Returns
   *  the settled result AND how many supplied answers were never consumed —
   *  `unresolvedAnswers > 0` means the ask timed out instead of being answered
   *  (`pendingAsks.resolve` only succeeds for a still-registered ask), which
   *  the caller asserts against so a timeout-resume can't false-pass. */
  async function driveAskTurn(session, transcript, opts, answers) {
    const pendingAsks = opts.pendingAsks;
    const answerMap = new Map(Object.entries(answers));
    let settled = false;
    let value;
    let error;
    const p = runShadowHarness(session, transcript, [], opts).then(
      (v) => {
        settled = true;
        value = v;
      },
      (e) => {
        settled = true;
        error = e;
      }
    );
    await jest.advanceTimersByTimeAsync(0);
    const step = 250;
    let elapsed = 0;
    while (!settled && elapsed <= MAX_ADVANCE_MS) {
      for (const [id, payload] of [...answerMap]) {
        if (pendingAsks && pendingAsks.resolve(id, payload)) answerMap.delete(id);
      }
      await jest.advanceTimersByTimeAsync(step);
      elapsed += step;
    }
    await jest.advanceTimersByTimeAsync(0);
    await p;
    if (error) throw error;
    return { value, unresolvedAnswers: answerMap.size };
  }

  test('both the pre-ask round and the post-answer round run on OBSERVATION_EXTRACT_MODEL', async () => {
    const client = mockClient([
      f7ToolUseRound([
        {
          id: 'toolu_obs_ask',
          name: 'ask_user',
          input: {
            question: 'Which circuit is that observation for?',
            reason: 'ambiguous_circuit',
            context_field: 'measured_zs_ohm',
            context_circuit: null,
            expected_answer_shape: 'circuit_ref',
          },
        },
      ]),
      f7EndTurnRound('ok'),
    ]);
    const session = makeF7LiveSession({ sessionId: SID, client });
    const ws = makeOpenWs();
    const pendingAsks = createPendingAsksRegistry();
    const opts = {
      logger: makeLogger(),
      pendingAsks,
      ws,
      confirmationsEnabled: true,
      rawInspectorTranscript: OBS_TRANSCRIPT,
    };

    const { unresolvedAnswers } = await driveAskTurn(session, OBS_TRANSCRIPT, opts, {
      toolu_obs_ask: { answered: true, user_text: 'Circuit 4' },
    });

    // The ask really EMITTED (crossed the WS) and was ANSWERED (registry
    // emptied by the answer, before the 45s timeout) — NOT a timeout-resume.
    expect(askStartedFrames(ws).length).toBeGreaterThanOrEqual(1);
    expect(unresolvedAnswers).toBe(0);
    expect([...pendingAsks.entries()].length).toBe(0);
    // …and the answered suspend/resume kept BOTH Anthropic calls on the
    // observation tier (the model is selected once and locked).
    expect(client._callCount).toBe(2);
    expect(client._calls[0].model).toBe(OBS_MODEL); // pre-ask round
    expect(client._calls[1].model).toBe(OBS_MODEL); // post-answer resume round
  });
});
