/**
 * session-builder.test.js — production-parity replay composition (plan
 * Item 2). Three layers:
 *   1. the MACHINE-CHECKED classification table vs the REAL production
 *      activeSessions.set block (parsed from sonnet-stream.js source — a
 *      production field add/remove without a table update FAILS here);
 *   2. the builder's entry vs the classification (every reproduced field
 *      present with production shape; the registry identity preserved);
 *   3. blocking behaviour tests through the REAL harness:
 *      `low_conf_readback_v1` presence flips a sub-0.5 write, and an ask
 *      traverses wrapAskDispatcherWithGates (budget short-circuit proves
 *      the gate stack composed — without askBudget + restrainedMode the
 *      wrapper never composes).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_ENTRY_CLASSIFICATION,
  HARNESS_OPTION_TABLE,
  buildReplaySession,
} from '../../../scripts/field-replay/lib/session-builder.mjs';
import { mockClient } from '../helpers/mockStream.js';
import { toolUseRound, endTurnRound, makeOpenWs } from '../helpers/f7-audibility-core.js';

// Real production modules (this is a jest test — static imports are fine
// here; the RUNNER is what must defer them until after clock install).
import { EICRExtractionSession } from '../../extraction/eicr-extraction-session.js';
import { activeSessions } from '../../extraction/active-sessions.js';
import { createPendingAsksRegistry } from '../../extraction/stage6-pending-asks-registry.js';
import { createAskBudget } from '../../extraction/stage6-ask-budget.js';
import { deriveAskKey } from '../../extraction/stage6-ask-gate-wrapper.js';
import {
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
} from '../../extraction/voice-latency-config.js';
import { createFilledSlotsShadowLogger } from '../../extraction/stage6-filled-slots-shadow.js';
import { runShadowHarness } from '../../extraction/stage6-shadow-harness.js';

const modules = {
  EICRExtractionSession,
  activeSessions,
  createPendingAsksRegistry,
  createAskBudget,
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
  createFilledSlotsShadowLogger,
};

function makeLogger() {
  const rows = [];
  const sink = (level) => (msg, meta) => rows.push({ level, name: typeof msg === 'string' ? msg : msg?.message, meta });
  return { info: sink('info'), warn: sink('warn'), error: sink('error'), debug: sink('debug'), rows };
}

function baseFixture(overrides = {}) {
  return {
    corpus_id: 'frc_0123456789abcdef0123456789abcdef',
    job_state: { certificateType: 'eicr', boards: [{ id: 'main', board_type: 'main' }], circuits: [{ number: 2 }] },
    client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
    fallback_to_legacy: { value: false, provenance: 'recorded_full' },
    ...overrides,
  };
}

/** Parse the production activeSessions.set block's top-level field names. */
function productionEntryFields() {
  const src = fs.readFileSync(path.resolve('src/extraction/sonnet-stream.js'), 'utf8');
  const start = src.indexOf('activeSessions.set(sessionId, {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, i);
  const fields = [];
  let d = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');
    if (d === 0) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*[:,]/.exec(line);
      if (m) fields.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') d += 1;
      else if (ch === '}' || ch === ']' || ch === ')') d -= 1;
    }
  }
  return [...new Set(fields)];
}

afterEach(() => {
  // Belt-and-suspenders: clear any leaked replay sessions.
  for (const [id] of activeSessions) {
    if (String(id).startsWith('frsess_')) activeSessions.delete(id);
  }
});

describe('machine-checked classification vs the production entry', () => {
  test('every production activeSessions.set field is classified; no stale classifications', () => {
    const prod = productionEntryFields();
    const classified = Object.keys(ACTIVE_ENTRY_CLASSIFICATION);
    const unclassified = prod.filter((f) => !classified.includes(f));
    const stale = classified.filter((f) => !prod.includes(f));
    expect(unclassified).toEqual([]); // production added a field → update the table
    expect(stale).toEqual([]); // production removed a field → update the table
  });
  test('every classification carries a rationale', () => {
    for (const [field, c] of Object.entries(ACTIVE_ENTRY_CLASSIFICATION)) {
      expect(['reproduced', 'deliberately_excluded', 'irrelevant']).toContain(c.class);
      expect((c.how ?? c.why ?? '').length).toBeGreaterThan(10);
    }
  });
});

describe('builder composition', () => {
  test('the entry carries every production field; reproduced maps/sets have production shape', () => {
    const logger = makeLogger();
    const built = buildReplaySession({ modules, fixture: baseFixture(), logger });
    try {
      for (const field of productionEntryFields()) {
        expect(Object.prototype.hasOwnProperty.call(built.entry, field)).toBe(true);
      }
      expect(built.entry.pendingFastTtsSlots).toBeInstanceOf(Map);
      expect(built.entry.fastPathCorrelationIdByTurn).toBeInstanceOf(Map);
      expect(built.entry.broadcastIntentByTurn).toBeInstanceOf(Map);
      expect(built.entry.voiceLatency.lastAudioSeqByCorrelation).toBeInstanceOf(Map);
      expect(built.entry.consumedAskUtterances).toBeInstanceOf(Set);
      expect(built.entry.restrainedMode.isActive()).toBe(false);
      expect(activeSessions.get(built.sessionId)).toBe(built.entry);
    } finally {
      built.teardown();
    }
    expect(activeSessions.has(built.sessionId)).toBe(false);
  });

  test('capabilities parse the wire shape: low_conf_readback_v1 flips hasLowConfReadbackV1', () => {
    const logger = makeLogger();
    const withCap = buildReplaySession({ modules, fixture: baseFixture(), logger });
    const without = buildReplaySession({
      modules,
      fixture: baseFixture({
        corpus_id: 'frc_fedcba9876543210fedcba9876543210',
        client_capabilities: { value: [], provenance: 'recorded_full' },
      }),
      logger,
    });
    try {
      expect(withCap.entry.voiceLatency.capabilities.hasLowConfReadbackV1).toBe(true);
      expect(without.entry.voiceLatency.capabilities.hasLowConfReadbackV1).toBe(false);
    } finally {
      withCap.teardown();
      without.teardown();
    }
  });

  test('buildTurnOptions enumerates the production option table (singular regexFastCorrelationId; omitted when absent)', () => {
    const logger = makeLogger();
    const built = buildReplaySession({ modules, fixture: baseFixture(), logger });
    try {
      const ws = makeOpenWs();
      const opts = built.buildTurnOptions({
        turnIndex: 1,
        turn: {
          confirmations_enabled: { value: true },
          in_response_to: { value: false },
          regex_fast_correlation_ids: ['sym_corr_1'],
        },
        ws,
        onAskRegistered: () => true,
        signal: new AbortController().signal,
      });
      const expected = Object.keys(HARNESS_OPTION_TABLE);
      for (const k of expected) {
        expect(Object.prototype.hasOwnProperty.call(opts, k)).toBe(true);
      }
      expect(opts.regexFastCorrelationId).toBe('sym_corr_1'); // SINGULAR
      // Observation-tier routing (C1) — rawInspectorTranscript is threaded from
      // the fixture's raw turn.transcript so the recorded lane classifies on
      // the SAME string prod does (msg.text), never an enriched form.
      const optsWithTranscript = built.buildTurnOptions({
        turnIndex: 4,
        turn: {
          confirmations_enabled: { value: true },
          in_response_to: { value: false },
          transcript: 'observation, cracked socket on circuit four',
        },
        ws,
        onAskRegistered: () => true,
        signal: new AbortController().signal,
      });
      expect(optsWithTranscript.rawInspectorTranscript).toBe(
        'observation, cracked socket on circuit four'
      );
      expect(opts.pendingAsks).toBe(built.entry.pendingAsks); // identity preserved
      // Absence is passed only when evidence-backed: no ids → option omitted.
      const optsNone = built.buildTurnOptions({
        turnIndex: 2,
        turn: { confirmations_enabled: { value: true }, in_response_to: { value: false } },
        ws,
        onAskRegistered: () => true,
        signal: new AbortController().signal,
      });
      expect('regexFastCorrelationId' in optsNone).toBe(false);
      // Multiple ids pass through as the array form production normalises.
      const optsMulti = built.buildTurnOptions({
        turnIndex: 3,
        turn: {
          confirmations_enabled: { value: true },
          in_response_to: { value: false },
          regex_fast_correlation_ids: ['sym_corr_1', 'sym_corr_2'],
        },
        ws,
        onAskRegistered: () => true,
        signal: new AbortController().signal,
      });
      expect(optsMulti.regexFastCorrelationId).toEqual(['sym_corr_1', 'sym_corr_2']);
    } finally {
      built.teardown();
    }
  });
});

describe('blocking behaviour through the REAL harness', () => {
  async function runTurn(built, { rounds, transcript, capabilitiesOverride }) {
    const ws = makeOpenWs();
    built.entry.ws = ws;
    if (capabilitiesOverride) built.entry.voiceLatency.capabilities = capabilitiesOverride;
    built.session.client = mockClient(rounds);
    built.session.start(built.fixtureJobState);
    built.session._clearCacheKeepalive?.();
    const opts = built.buildTurnOptions({
      turnIndex: 1,
      turn: { confirmations_enabled: { value: true }, in_response_to: { value: false } },
      ws,
      onAskRegistered: () => true,
      signal: new AbortController().signal,
    });
    const result = await runShadowHarness(built.session, transcript, [], opts);
    return { result, ws };
  }

  test('low_conf_readback_v1 presence flips a sub-0.5 record_reading write', async () => {
    const logger = makeLogger();
    const rounds = () => [
      toolUseRound([
        {
          id: 'toolu_low_conf',
          name: 'record_reading',
          input: { field: 'measured_zs_ohm', circuit: 2, value: '0.35', confidence: 0.3 },
        },
      ]),
      endTurnRound(),
    ];

    const withCap = buildReplaySession({ modules, fixture: baseFixture(), logger });
    let withWrite;
    try {
      const { result } = await runTurn(withCap, { rounds: rounds(), transcript: 'zs nought point three five circuit two' });
      withWrite = (result?.extracted_readings ?? []).some(
        (r) => r.field === 'measured_zs_ohm' && String(r.circuit) === '2',
      );
    } finally {
      withCap.teardown();
    }

    const without = buildReplaySession({
      modules,
      fixture: baseFixture({
        corpus_id: 'frc_fedcba9876543210fedcba9876543210',
        client_capabilities: { value: [], provenance: 'recorded_full' },
      }),
      logger,
    });
    let withoutWrite;
    try {
      const { result } = await runTurn(without, { rounds: rounds(), transcript: 'zs nought point three five circuit two' });
      withoutWrite = (result?.extracted_readings ?? []).some(
        (r) => r.field === 'measured_zs_ohm' && String(r.circuit) === '2',
      );
    } finally {
      without.teardown();
    }

    expect(withWrite).toBe(true);
    expect(withoutWrite).toBe(false);
  });

  test('an ask traverses wrapAskDispatcherWithGates: a pre-exhausted budget short-circuits with ask_budget_exhausted', async () => {
    const logger = makeLogger();
    const built = buildReplaySession({ modules, fixture: baseFixture(), logger });
    try {
      const askInput = {
        question: 'Which circuit was that reading for?',
        reason: 'ambiguous_circuit',
        context_field: 'measured_zs_ohm',
        context_circuit: 2,
      };
      // Exhaust the per-(field, circuit) budget (default cap 2) BEFORE the
      // turn — the wrapper's isExhausted check fires pre-dispatch, so the
      // injected ask short-circuits WITHOUT registering or emitting. Only
      // the gate wrapper produces this outcome — its presence proves
      // askBudget + restrainedMode composed the gate stack.
      const key = deriveAskKey(askInput);
      built.entry.askBudget.increment(key);
      built.entry.askBudget.increment(key);
      expect(built.entry.askBudget.isExhausted(key)).toBe(true);

      const { result, ws } = await runTurn(built, {
        rounds: [
          toolUseRound([{ id: 'toolu_gated_ask', name: 'ask_user', input: askInput }]),
          endTurnRound(),
        ],
        transcript: 'point three five',
      });
      void result;
      // The short-circuited ask never crossed the wire.
      const askFrames = ws.sent.filter((f) => f.type === 'ask_user_started');
      expect(askFrames).toEqual([]);
      // And the registry holds nothing (no 45s timer leaked).
      expect([...built.entry.pendingAsks.entries()]).toEqual([]);
    } finally {
      built.teardown();
    }
  });

  // Observation-tier routing (C1) — the recorded lane must route identically
  // to prod: an observation-shaped fixture transcript escalates to
  // OBSERVATION_EXTRACT_MODEL when OBSERVATION_TIER_ROUTING is on, a reading
  // transcript does not, AND enriched server context alone cannot escalate —
  // the router keys off buildTurnOptions' rawInspectorTranscript (turn.transcript),
  // NOT the harness transcript arg, so a bare "yes" answer whose HARNESS
  // transcript mentions "observation" stays on the default model.
  test('observation fixture routes to OBSERVATION_EXTRACT_MODEL (flag on); reading + enriched-context-only do NOT', async () => {
    const OBS_MODEL = 'claude-observation-tier-sentinel';
    const savedFlag = process.env.OBSERVATION_TIER_ROUTING;
    const savedModel = process.env.OBSERVATION_EXTRACT_MODEL;
    process.env.OBSERVATION_TIER_ROUTING = 'true';
    process.env.OBSERVATION_EXTRACT_MODEL = OBS_MODEL;
    const logger = makeLogger();

    // `harnessTranscript` is what runShadowHarness receives (in prod this may be
    // the ENRICHED "[In response to TTS question…]" form); `rawTranscript` is
    // the untouched inspector text buildTurnOptions threads as
    // rawInspectorTranscript. Default: identical (a normal recorded turn).
    async function routeModelFor({ harnessTranscript, rawTranscript = harnessTranscript, corpusId }) {
      const built = buildReplaySession({
        modules,
        fixture: baseFixture({ corpus_id: corpusId }),
        logger,
      });
      try {
        const ws = makeOpenWs();
        built.entry.ws = ws;
        built.session.client = mockClient([endTurnRound()]);
        built.session.start(built.fixtureJobState);
        built.session._clearCacheKeepalive?.();
        const opts = built.buildTurnOptions({
          turnIndex: 1,
          turn: {
            confirmations_enabled: { value: true },
            in_response_to: { value: false },
            transcript: rawTranscript,
          },
          ws,
          onAskRegistered: () => true,
          signal: new AbortController().signal,
        });
        await runShadowHarness(built.session, harnessTranscript, [], opts);
        return built.session.client._calls[0].model;
      } finally {
        built.teardown();
      }
    }

    try {
      const obsModel = await routeModelFor({
        harnessTranscript: 'observation, cracked socket outlet on circuit four',
        corpusId: 'frc_00000000000000000000000000000001',
      });
      const readingModel = await routeModelFor({
        harnessTranscript: 'zs circuit one is nought point six two',
        corpusId: 'frc_00000000000000000000000000000002',
      });
      // Enriched-context-only: the HARNESS transcript mentions "observation"
      // (would match OBSERVATION_PATTERN) but the RAW text is a bare "yes" —
      // the router must NOT escalate (server-context isolation at replay level).
      const enrichedModel = await routeModelFor({
        harnessTranscript: '[In response to TTS question: is this an observation?] yes',
        rawTranscript: 'yes',
        corpusId: 'frc_00000000000000000000000000000003',
      });
      expect(obsModel).toBe(OBS_MODEL);
      expect(readingModel).not.toBe(OBS_MODEL);
      expect(enrichedModel).not.toBe(OBS_MODEL);
    } finally {
      if (savedFlag === undefined) delete process.env.OBSERVATION_TIER_ROUTING;
      else process.env.OBSERVATION_TIER_ROUTING = savedFlag;
      if (savedModel === undefined) delete process.env.OBSERVATION_EXTRACT_MODEL;
      else process.env.OBSERVATION_EXTRACT_MODEL = savedModel;
    }
  });

  // NOTE on the blocking ask_user continuation (plan test list): the selected
  // model must hold across the loop's suspend-on-ask / resume-on-answer
  // boundary. This is STRUCTURALLY guaranteed — `model: selectedModel` is passed
  // ONCE to runToolLoop and reused for EVERY `client.messages.stream` call,
  // including the post-ask resume round (the ask suspends WITHIN one runToolLoop
  // invocation, it does not restart the loop). The multi-round proof in
  // stage6-observation-tier-routing.test.js pins that a second round uses the
  // same model; ask_user adds no new model source. A bespoke real-harness
  // ask_user register/resume test was intentionally NOT added: no test in the
  // suite drives a real ask_user registration through runShadowHarness (every
  // ask test short-circuits via budget-exhaustion or stubs the registry), so a
  // hand-rolled suspend/resume drive would be flaky rather than load-bearing.
});
