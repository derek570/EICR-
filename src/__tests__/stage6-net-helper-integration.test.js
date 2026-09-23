/**
 * PLAN-B (feedback-2026-09-17, B3/B4/B5) — the net-site helper through the
 * REAL harness.
 *
 * A net about to speak a canned "I didn't understand" line first asks the
 * model (one call, retry-only `net_response`); the server renders the line;
 * the canned string is the last resort. These tests drive `runShadowHarness`
 * with a scripted client whose first round is the primary loop and whose
 * next round is the helper's.
 *
 *   acceptance 1  — CC9E0915 turns 11-17: model-authored lines, then canned
 *                   strings when the helper is frozen empty
 *   acceptance 5  — DROPPED-VALUE / pending-value terminal: recovered write,
 *                   helper disclosure, invalid code, quote not in transcript,
 *                   echo, two pending identities
 *   acceptance 7  — one billing ingest with a terminal_retry row
 *   acceptance 14 — a surviving PLAN-C3 notice owns the turn; no helper
 *   acceptance 16 — the PLAN-A carrier flags: suppress on EMITTED, never on
 *                   BUILT; no nothing-was-recorded template while BUILT
 */

import { jest } from '@jest/globals';

import {
  runShadowHarness,
  NOOP_AUDIBILITY_PROMPTS,
  ORPHAN_PROMPTS,
  CATCHALL_AUDIBILITY_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} from '../extraction/stage6-shadow-harness.js';
import { renderNetLine, validateNetResponse } from '../extraction/stage6-model-authored-line.js';
import { foldTerminalReadbackOutcomes } from '../extraction/terminal-readback-carrier.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';
import { ASK_USER_TIMEOUT_MS } from '../extraction/stage6-dispatcher-ask.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { mockClient } from './helpers/mockStream.js';
import {
  makeLogger,
  makeLiveSession,
  makeOpenWs,
  toolUseRound,
  endTurnRound,
} from './helpers/f7-audibility-matrix.js';

const SID = 'sess-plan-b-net-helper';
const CANNED = new Set([
  ...NOOP_AUDIBILITY_PROMPTS,
  ...ORPHAN_PROMPTS,
  ...CATCHALL_AUDIBILITY_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
]);

// runToolLoop pushes onto one messages array across rounds and mockClient
// keeps a reference, so snapshot each request at call time.
function scriptedClient(rounds) {
  const inner = mockClient(rounds);
  const requests = [];
  return {
    requests,
    messages: {
      stream(args) {
        requests.push(JSON.parse(JSON.stringify(args)));
        return inner.messages.stream(args);
      },
    },
  };
}

const helperRound = (input) => toolUseRound([{ id: 'net_1', name: 'net_response', input }]);

const isHelperRequest = (req) => (req.tools ?? []).every((t) => t.name === 'net_response');

function spoken(result) {
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

function logRows(logger, name) {
  return logger.info.mock.calls.filter(([n]) => n === name).map(([, m]) => m);
}

function logIndex(logger, name) {
  return logger.info.mock.calls.findIndex(([n]) => n === name);
}

async function runTurn(args) {
  const { transcript, rounds, stateSnapshot, options = {}, sessionOverrides = {} } = args;
  // `canonical: undefined` must mean "not supplied", so no default parameter.
  const canonical = Object.prototype.hasOwnProperty.call(args, 'canonical')
    ? args.canonical
    : transcript;
  const client = scriptedClient(rounds);
  const session = makeLiveSession({
    sessionId: SID,
    client,
    ...(stateSnapshot ? { stateSnapshot } : {}),
    ...sessionOverrides,
  });
  const logger = makeLogger();
  const result = await runShadowHarness(session, transcript, [], {
    logger,
    confirmationsEnabled: true,
    chimeObserved: true,
    rawInspectorTranscript: transcript,
    ...(canonical !== undefined ? { canonicalInspectorTranscript: canonical } : {}),
    generationId: 'gen-plan-b',
    ...options,
  });
  return { result, logger, session, client };
}

beforeEach(() => {
  activeSessions.set(SID, {
    session: { sessionId: SID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false } },
  });
});
afterEach(() => {
  activeSessions.delete(SID);
});

// ───────────────────────────────────────────────────────────────────────────
// Acceptance 1 — session CC9E0915, turns 11-17 (customer chat, 11:46-11:51)
// ───────────────────────────────────────────────────────────────────────────
const CC9E0915_TURNS = [
  "considering... or is it... I'd say I'd say 70. When was it billed? Do you know?",
  "Yeah. Yeah. I've always wondered why the the... like, because every time I've done quite a few here, and I'm always like, why is there... I thought a moat. And it is...",
  "But... yeah. No. I'm surprised with the reading. So, yeah, I've done a few in there.",
  'I said yes. I had a new shower and all that sort of activity, innit? Yeah.',
  "So, please, this is done because my brother lives in Eczema. My sister's in Derby. Just on the",
  "Thanks. I'll quick look at... I just... is this is this the... Cooker. Cooker. How do you turn this on and off?",
  "So that's the big 1 is the exchange, isn't it?",
];

describe('acceptance 1 — CC9E0915 turns 11-17 with the primary loop frozen empty', () => {
  // The helper is frozen to one deterministic response per turn. The plan's
  // example quotes "you're talking to the customer", which none of these
  // transcripts contains — the plan's own quotation rule (acceptance 9) would
  // reject it — so each turn quotes its own opening words. A digit-bearing
  // turn is an orphan_value net, where `chat` is not an allowed code, so it
  // answers `value_unplaced`.
  const frozenFor = (transcript) => {
    const netKind = /\d/.test(transcript) ? 'orphan_value' : 'noop';
    const heard = transcript.trim().split(/\s+/).slice(0, 3).join(' ');
    const input = { outcome_code: netKind === 'noop' ? 'chat' : 'value_unplaced', heard };
    return { netKind, input };
  };

  test.each(CC9E0915_TURNS.map((t, i) => [11 + i, t]))(
    'turn %i: one model-authored line, no canned string',
    async (_turnNo, transcript) => {
      const { netKind, input } = frozenFor(transcript);
      const { result, logger, client } = await runTurn({
        transcript,
        rounds: [endTurnRound(''), helperRound(input)],
      });
      const verdict = validateNetResponse(input, { netKind, canonicalTranscript: transcript });
      expect(verdict.ok).toBe(true);
      const expected = renderNetLine(netKind, verdict.value);
      const lines = spoken(result);
      expect(lines.map((c) => c.text)).toEqual([expected]);
      expect(lines[0].dedupe_token).toBe(
        `${SID}-turn-1`.replace(/^/, 'p4ack_') + `_net_${netKind}`
      );
      expect(lines.some((c) => CANNED.has(c.text))).toBe(false);
      expect(client.requests).toHaveLength(2);
      expect(isHelperRequest(client.requests[1])).toBe(true);
      expect(logRows(logger, 'stage6.noop_retry_round')[0]).toMatchObject({
        netKind,
        outcome: 'answered',
      });
    }
  );

  test.each(CC9E0915_TURNS.map((t, i) => [11 + i, t]))(
    'turn %i with the helper frozen EMPTY: the canned string, preceded by noop_retry_round {outcome: empty}',
    async (_turnNo, transcript) => {
      const { result, logger } = await runTurn({
        transcript,
        rounds: [endTurnRound(''), endTurnRound('')],
      });
      const lines = spoken(result);
      expect(lines).toHaveLength(1);
      expect(CANNED.has(lines[0].text)).toBe(true);
      expect(lines[0].dedupe_token).toBeUndefined();
      const retryAt = logIndex(logger, 'stage6.noop_retry_round');
      const emittedAt = logIndex(logger, 'stage6.orphan_prompt_emitted');
      expect(retryAt).toBeGreaterThanOrEqual(0);
      expect(logRows(logger, 'stage6.noop_retry_round')[0].outcome).toBe('empty');
      expect(retryAt).toBeLessThan(emittedAt);
      expect(logRows(logger, 'stage6.orphan_prompt_emitted')[0].author).toBe('canned');
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Acceptance 5 — DROPPED-VALUE: write or disclose
// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 5 — pending-value terminals and the dropped_value helper', () => {
  const pending = (field, circuit, value, text) => ({
    text,
    generationId: 'gen-plan-b',
    promptKind: 'pending_value_terminal',
    pendingField: field,
    pendingCircuit: circuit,
    pendingBoardId: null,
    pendingValue: value,
  });
  const P1 = pending('measured_zs_ohm', 3, '0.4', 'Sorry, I lost the Zs for circuit 3.');
  const P2 = pending('r1_r2_ohm', 5, '0.2', 'Sorry, I lost the R1 plus R2 for circuit 5.');
  // No digit, no observation lead-in, no chime: the orphan and marker-② nets
  // stay out of the way, so the drain's helper is the only extra call.
  const transcript = 'hang on a moment';
  const quietOptions = { chimeObserved: false };

  test('two pending terminals: the disclosed identity is retracted, the other still speaks', async () => {
    const { result, logger, client } = await runTurn({
      transcript,
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'not_recorded', heard: 'hang on' })],
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1, P2] },
    });
    const texts = spoken(result).map((c) => c.text);
    expect(texts).toEqual([
      "I couldn't record that — I heard “hang on”. Say it again with the circuit?",
      P2.text,
    ]);
    expect(texts).not.toContain(P1.text);
    expect(spoken(result)[0].dedupe_token).toBe(`p4ack_${SID}-turn-1_net_dropped_value`);
    expect(client.requests).toHaveLength(2);
    expect(logRows(logger, 'stage6.pending_value_apology_disclosed_by_model')).toHaveLength(1);
  });

  test('a recovered write → one read-back, the apology superseded, no helper call', async () => {
    const { result, logger, client } = await runTurn({
      transcript: 'Zs on circuit three is nought point four',
      canonical: 'Zs on circuit 3 is 0.4',
      rounds: [
        toolUseRound([
          {
            id: 'w1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.4',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
        ]),
        endTurnRound(''),
      ],
      stateSnapshot: {
        circuits: { 3: { circuit_designation: 'Sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1] },
    });
    const texts = spoken(result).map((c) => c.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toBe(P1.text);
    expect(client.requests).toHaveLength(2); // primary tool round + its end_turn; no helper
    expect(client.requests.some(isHelperRequest)).toBe(false);
    expect(logRows(logger, 'stage6.pending_value_apology_superseded')).toHaveLength(1);
  });

  test('an out-of-enum outcome_code → rejected; the canned loss line speaks', async () => {
    const { result, logger } = await runTurn({
      transcript,
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'chat' })],
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1] },
    });
    expect(spoken(result).map((c) => c.text)).toEqual([P1.text]);
    expect(logRows(logger, 'stage6.noop_retry_round')[0]).toMatchObject({
      netKind: 'dropped_value',
      outcome: 'rejected',
      rejection_reasons: ['outcome_code_not_allowed'],
    });
  });

  test('a missing outcome_code → rejected; the canned loss line speaks', async () => {
    const { result } = await runTurn({
      transcript,
      rounds: [endTurnRound(''), helperRound({ heard: 'hang on' })],
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1] },
    });
    expect(spoken(result).map((c) => c.text)).toEqual([P1.text]);
  });

  test('a heard that is not in the transcript → heard_not_in_transcript; the canned loss line speaks', async () => {
    const { result, logger } = await runTurn({
      transcript,
      rounds: [
        endTurnRound(''),
        helperRound({ outcome_code: 'not_recorded', heard: 'I recorded that for you' }),
      ],
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1] },
    });
    expect(spoken(result).map((c) => c.text)).toEqual([P1.text]);
    expect(logRows(logger, 'stage6.noop_retry_round')[0].rejection_reasons).toEqual([
      'heard_not_in_transcript',
    ]);
  });

  test('a valid not_recorded whose heard merely echoes the transcript is accepted', async () => {
    const { result } = await runTurn({
      transcript,
      rounds: [
        endTurnRound(''),
        helperRound({ outcome_code: 'not_recorded', heard: 'hang on a moment', question: 'none' }),
      ],
      options: quietOptions,
      sessionOverrides: { pendingVoicePrompts: [P1] },
    });
    expect(spoken(result).map((c) => c.text)).toEqual([
      "I couldn't record that — I heard “hang on a moment”.",
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Acceptance 7 — accounting
// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 7 — one invocation id, one ingest, a terminal_retry row', () => {
  const trackerSpy = () => ({
    beginBillableInvocation: jest.fn(() => true),
    ingestBillableUsage: jest.fn(() => true),
    endBillableInvocation: jest.fn(() => true),
  });

  test('the helper rows merge into the primary invocation and are ingested once', async () => {
    const costTracker = trackerSpy();
    const { result } = await runTurn({
      transcript: 'I said yes, innit',
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'chat' })],
      sessionOverrides: { costTracker },
    });
    expect(spoken(result)).toHaveLength(1);
    expect(costTracker.beginBillableInvocation).toHaveBeenCalledTimes(1);
    expect(costTracker.ingestBillableUsage).toHaveBeenCalledTimes(1);
    const [invocationId, rows, kind] = costTracker.ingestBillableUsage.mock.calls[0];
    expect(invocationId).toBe(costTracker.beginBillableInvocation.mock.calls[0][0]);
    expect(kind).toBe('inspector_live');
    expect(rows).toHaveLength(2);
    expect(rows[0].usage_role).toBeUndefined();
    expect(rows[1]).toMatchObject({ usage_role: 'terminal_retry', round_idx: 1 });
    expect(costTracker.endBillableInvocation).toHaveBeenCalledTimes(1);
  });

  test('a real CostTracker counts both rounds', async () => {
    const costTracker = new CostTracker();
    await runTurn({
      transcript: 'I said yes, innit',
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'chat' })],
      sessionOverrides: { costTracker },
    });
    expect(costTracker.completedModelRounds).toBe(2);
    expect(costTracker.loopInvocations).toBe(1);
    expect(costTracker.roundUsageEvidence.map((r) => r.usage_role ?? null)).toEqual([
      null,
      'terminal_retry',
    ]);
    expect(costTracker.inFlightBillableInvocationCount).toBe(0);
  });

  test('a provider error in the helper → a terminal_retry row carrying the error, and the canned string', async () => {
    const costTracker = trackerSpy();
    let calls = 0;
    const inner = mockClient([endTurnRound('')]);
    const client = {
      messages: {
        stream(args) {
          calls += 1;
          if (calls === 2) throw new Error('503 upstream');
          return inner.messages.stream(args);
        },
      },
    };
    const session = makeLiveSession({ sessionId: SID, client, costTracker });
    const logger = makeLogger();
    const result = await runShadowHarness(session, 'I said yes, innit', [], {
      logger,
      chimeObserved: true,
      rawInspectorTranscript: 'I said yes, innit',
      canonicalInspectorTranscript: 'I said yes, innit',
      generationId: 'gen-plan-b',
    });
    const lines = spoken(result);
    expect(lines).toHaveLength(1);
    expect(NOOP_AUDIBILITY_PROMPTS).toContain(lines[0].text);
    const rows = costTracker.ingestBillableUsage.mock.calls[0][1];
    expect(rows[rows.length - 1]).toMatchObject({
      usage_role: 'terminal_retry',
      error: expect.stringContaining('503'),
    });
    expect(logRows(logger, 'stage6.noop_retry_round')[0].outcome).toBe('provider_error');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Acceptance 16 — the PLAN-A carrier flags
// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 16 — handoff gating on the terminal read-back carrier', () => {
  test('the fold: emitted is the AND over calls that built, with a zero-built floor (B-137, B-152)', () => {
    expect(foldTerminalReadbackOutcomes([])).toMatchObject({ built: false, emitted: false });
    expect(
      foldTerminalReadbackOutcomes([
        { terminalReadbackBuilt: true, terminalReadbackEmitted: true },
        { terminalReadbackBuilt: false, terminalReadbackEmitted: false },
        null,
      ])
    ).toMatchObject({ built: true, emitted: true });
    // Ring emitted, protective device built-but-failed → NOT emitted.
    expect(
      foldTerminalReadbackOutcomes([
        { terminalReadbackBuilt: true, terminalReadbackEmitted: true },
        null,
        {
          terminalReadbackBuilt: true,
          terminalReadbackEmitted: false,
          terminalReadbackLostText: 'Also got circuit 4 Zs 0.35.',
        },
      ])
    ).toMatchObject({ built: true, emitted: false, lostTexts: ['Also got circuit 4 Zs 0.35.'] });
  });

  test('a first-slot miss with nothing captured, then a silent model → the helper runs WITH the handoff context', async () => {
    const handoff = {
      script: 'ring_continuity',
      asked: 'ring_r1_ohm',
      circuit: 4,
      remaining: ['ring_r1_ohm'],
    };
    const { result, client } = await runTurn({
      transcript: 'what did I say',
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'need_repeat' })],
      options: { terminalReadbackBuilt: false, terminalReadbackEmitted: false, handoff },
    });
    expect(spoken(result).map((c) => c.text)).toEqual([
      "Nothing was recorded — I didn't catch that. Say it again?",
    ]);
    const note = JSON.stringify(client.requests[1].messages.at(-1));
    expect(note).toContain('ring_continuity');
    expect(note).toContain('remaining');
  });

  test('a captured value whose read-back was EMITTED → no helper, no orphan, no marker-②, no F7; nothing else speaks', async () => {
    const { result, logger, client } = await runTurn({
      transcript: 'what did I say',
      rounds: [endTurnRound('')],
      options: { terminalReadbackBuilt: true, terminalReadbackEmitted: true },
    });
    expect(spoken(result)).toHaveLength(0);
    expect(client.requests).toHaveLength(1);
    expect(logRows(logger, 'stage6.noop_retry_round')).toHaveLength(0);
    expect(logRows(logger, 'stage6.orphan_prompt_suppressed_by_terminal_readback')).toHaveLength(1);
    expect(logRows(logger, 'stage6.catchall_audibility_fallback_emitted')).toHaveLength(0);
    expect(logRows(logger, 'stage6.ask_audibility_fallback_emitted')).toHaveLength(0);
  });

  test('BUILT but not EMITTED (a closed socket) → the nets are NOT excluded, but no nothing-was-recorded template renders', async () => {
    // Pinned at the flag level with no lost text passed through, so the
    // orphan net is reachable: it fires (not excluded by `built`), the helper
    // is withheld (values WERE recorded), and the canned line speaks.
    const { result, logger, client } = await runTurn({
      transcript: 'what did I say',
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'nothing_recorded' })],
      options: {
        terminalReadbackBuilt: true,
        terminalReadbackEmitted: false,
        terminalReadbackLostTexts: [],
      },
    });
    const texts = spoken(result).map((c) => c.text);
    expect(texts).toHaveLength(1);
    expect(NOOP_AUDIBILITY_PROMPTS).toContain(texts[0]);
    expect(texts.some((t) => t.startsWith('Nothing was recorded'))).toBe(false);
    expect(client.requests).toHaveLength(1);
    expect(logRows(logger, 'stage6.noop_retry_round')).toHaveLength(0);
  });

  test('F7 is NOT excluded by BUILT alone: an attempted-but-unemitted ask still draws its fallback', async () => {
    const { result } = await runTurn({
      transcript: 'which circuit',
      rounds: [
        toolUseRound([
          {
            id: 'ask_1',
            name: 'ask_user',
            input: {
              question: 'Which circuit?',
              reason: 'ambiguous_circuit',
              expected_answer_shape: 'circuit_ref',
            },
          },
        ]),
        endTurnRound(''),
      ],
      options: {
        terminalReadbackBuilt: true,
        terminalReadbackEmitted: false,
        terminalReadbackLostTexts: [],
        chimeObserved: false,
      },
    });
    expect(spoken(result).map((c) => c.text)).toContain(ASK_AUDIBILITY_FALLBACK_TEXT);
  });

  test('B-144: BUILT-but-lost with a surviving model write keeps PLAN-A’s recovery line and draws no apology', async () => {
    const { result, client } = await runTurn({
      transcript: 'Zs on circuit 3 is 0.4',
      rounds: [
        toolUseRound([
          {
            id: 'w1',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.4',
              confidence: 0.9,
              source_turn_id: 't1',
            },
          },
        ]),
        endTurnRound(''),
      ],
      stateSnapshot: {
        circuits: { 3: { circuit_designation: 'Sockets' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
      options: {
        terminalReadbackBuilt: true,
        terminalReadbackEmitted: false,
        terminalReadbackLostTexts: ['Also got circuit 4 Zs 0.35.'],
      },
    });
    const texts = spoken(result).map((c) => c.text);
    expect(texts).toContain('Also got circuit 4 Zs 0.35.');
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => CANNED.has(t))).toBe(false);
    expect(client.requests.some(isHelperRequest)).toBe(false);
  });

  test('a heard copied from a prepended server note is not quotable (canonical transcript only)', async () => {
    const note = '[Server note: the ring continuity set is incomplete] ';
    const { result, logger } = await runTurn({
      transcript: `${note}what did I say`,
      canonical: 'what did I say',
      rounds: [
        endTurnRound(''),
        helperRound({ outcome_code: 'chat', heard: 'ring continuity set is incomplete' }),
      ],
    });
    expect(NOOP_AUDIBILITY_PROMPTS).toContain(spoken(result)[0].text);
    expect(logRows(logger, 'stage6.noop_retry_round')[0].rejection_reasons).toEqual([
      'heard_not_in_transcript',
    ]);
  });

  test('without canonicalInspectorTranscript a heard is rejected (heard_no_canonical_transcript) and the canned string speaks', async () => {
    const { result, logger } = await runTurn({
      transcript: 'what did I say',
      canonical: undefined,
      rounds: [endTurnRound(''), helperRound({ outcome_code: 'chat', heard: 'what did I say' })],
    });
    expect(NOOP_AUDIBILITY_PROMPTS).toContain(spoken(result)[0].text);
    expect(logRows(logger, 'stage6.noop_retry_round')[0].rejection_reasons).toEqual([
      'heard_no_canonical_transcript',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Acceptance 14 — ownership vs PLAN-C3
// ───────────────────────────────────────────────────────────────────────────
describe('acceptance 14 — a surviving PLAN-C3 post-ask enum notice owns the turn', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('enum_rejected_after_ask → exactly one spoken line (the notice); no helper call, no noop_retry_round', async () => {
    const client = scriptedClient([
      toolUseRound([
        {
          id: 'ask_rcd',
          name: 'ask_user',
          input: {
            question: 'What type is the RCD on circuit 1?',
            reason: 'missing_value',
            context_field: 'rcd_type',
            context_circuit: 1,
            expected_answer_shape: 'free_text',
          },
        },
      ]),
      endTurnRound(''),
      helperRound({ outcome_code: 'chat' }), // must NOT be consumed
    ]);
    const session = makeLiveSession({
      sessionId: SID,
      client,
      stateSnapshot: {
        circuits: { 1: { circuit_designation: 'Cooker' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    });
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const opts = {
      logger,
      pendingAsks,
      ws: makeOpenWs(),
      confirmationsEnabled: true,
      chimeObserved: true,
      rawInspectorTranscript: 'the rcd type',
      canonicalInspectorTranscript: 'the rcd type',
      generationId: 'gen-plan-b',
    };
    let settled = false;
    let value;
    const p = runShadowHarness(session, 'the rcd type', [], opts).then((v) => {
      settled = true;
      value = v;
    });
    let elapsed = 0;
    let answered = false;
    while (!settled && elapsed <= QUESTION_GATE_DELAY_MS + ASK_USER_TIMEOUT_MS) {
      if (!answered) {
        answered = pendingAsks.resolve('ask_rcd', { answered: true, user_text: 'banana' });
      }
      await jest.advanceTimersByTimeAsync(250);
      elapsed += 250;
    }
    await p;
    expect(answered).toBe(true);
    const texts = spoken(value).map((c) => c.text);
    expect(texts).toHaveLength(1);
    // The one line is PLAN-C3's post-ask enum notice (drained at net-0).
    expect(logRows(logger, 'stage6.mandatory_notice_emitted').map((r) => r.family)).toContain(
      'enum_rejected_after_ask'
    );
    expect(texts[0]).not.toMatch(/^Nothing was recorded/);
    expect(texts.some((t) => CANNED.has(t))).toBe(false);
    expect(client.requests.some(isHelperRequest)).toBe(false);
    expect(logRows(logger, 'stage6.noop_retry_round')).toHaveLength(0);
  });
});
