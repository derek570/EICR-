/**
 * PLAN-C P4d — ask/question/voice-command emit-site response-epoch matrix.
 *
 * This file covers the DIALOGUE-ENGINE + DISPATCHER rows (1-4): every
 * ask_user_started frame the server emits in reply to a chimed utterance must
 * carry that utterance's response epoch (`utterance_id`) so the client
 * chime-silence watchdog disarms on the spoken question instead of false-firing
 * a 20s native apology. The legacy sonnet-stream/batch rows (5-8) live in
 * plan-c-p4d-legacy-frames.test.js.
 *
 * Each row carries a focused assertion that FAILS when utterance_id is absent
 * (the plan's contract).
 */

import { jest } from '@jest/globals';
import {
  buildScriptAsk,
  buildScriptConfirm,
  buildScriptInfo,
  ASK_STARTED_OBSERVER,
} from '../extraction/dialogue-engine/helpers/wire-emit.js';
import {
  processRingContinuityTurn,
  processInsulationResistanceTurn,
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import {
  processRingContinuityTurn as legacyRingTurn,
} from '../extraction/ring-continuity-script.js';
import {
  processInsulationResistanceTurn as legacyIrTurn,
} from '../extraction/insulation-resistance-script.js';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

const EPOCH = 'utt-EPOCH-1';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits = {}) {
  return { sessionId: 'sess_p4d', stateSnapshot: { circuits } };
}

// ── Row 1a — the builders (REQUIRED sentinel + stamping) ────────────────────

describe('P4d row 1 — wire-emit builders REQUIRE responseEpoch', () => {
  const base = { toolCallIdPrefix: 'srv-x', sessionId: 's', now: 1000 };

  test('buildScriptAsk THROWS when responseEpoch is not threaded (missed nest = loud failure)', () => {
    expect(() => buildScriptAsk({ ...base, kind: 'which_circuit', whichCircuitQuestion: 'Q?' })).toThrow(
      /responseEpoch is required/
    );
  });

  test('buildScriptConfirm THROWS when responseEpoch is absent', () => {
    expect(() =>
      buildScriptConfirm({ ...base, circuit_ref: 1, question: 'ok?', reason: 'confirm' })
    ).toThrow(/responseEpoch is required/);
  });

  test('buildScriptInfo THROWS when responseEpoch is absent', () => {
    expect(() => buildScriptInfo({ ...base, kind: 'done', text: 'Got it.' })).toThrow(
      /responseEpoch is required/
    );
  });

  test('explicit null epoch is allowed and omits utterance_id (byte-identical)', () => {
    const ask = buildScriptAsk({
      ...base,
      kind: 'which_circuit',
      whichCircuitQuestion: 'Q?',
      responseEpoch: null,
    });
    expect(ask).not.toHaveProperty('utterance_id');
  });

  test('non-empty epoch stamps utterance_id on all three builders', () => {
    const ask = buildScriptAsk({
      ...base,
      kind: 'value',
      circuit_ref: 2,
      missing_field: 'ring_r1_ohm',
      slotQuestion: 'R1?',
      responseEpoch: EPOCH,
    });
    const confirm = buildScriptConfirm({
      ...base,
      circuit_ref: 2,
      question: 'ok?',
      reason: 'confirm',
      responseEpoch: EPOCH,
    });
    const info = buildScriptInfo({ ...base, kind: 'done', text: 'Got it.', responseEpoch: EPOCH });
    expect(ask.utterance_id).toBe(EPOCH);
    expect(confirm.utterance_id).toBe(EPOCH);
    expect(info.utterance_id).toBe(EPOCH);
  });

  test('empty-string epoch does NOT stamp (mirrors advance-only-on-non-empty)', () => {
    const ask = buildScriptAsk({
      ...base,
      kind: 'which_circuit',
      whichCircuitQuestion: 'Q?',
      responseEpoch: '',
    });
    expect(ask).not.toHaveProperty('utterance_id');
  });
});

// ── Row 1b — the live dialogue engine threads the epoch to the emitted ask ──

describe('P4d row 1 — dialogue engine ask_user_started carries the epoch', () => {
  test('ring-continuity slot ask carries utterance_id from responseEpoch', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
      responseEpoch: EPOCH,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask.utterance_id).toBe(EPOCH);
  });

  test('IR which-circuit ask carries utterance_id', () => {
    const ws = new FakeWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Insulation resistance please.',
      logger: null,
      now: 1000,
      responseEpoch: EPOCH,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask.utterance_id).toBe(EPOCH);
  });

  test('server-driven enterScriptByName first ask carries utterance_id', () => {
    const ws = new FakeWS();
    const session = buildSession();
    enterScriptByName({
      session,
      sessionId: 'sess_p4d',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      ws,
      now: 1000,
      responseEpoch: EPOCH,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask.utterance_id).toBe(EPOCH);
  });

  test('no responseEpoch (legacy caller) → ask omits utterance_id, no throw', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask).not.toHaveProperty('utterance_id');
  });

  test('ASK_STARTED_OBSERVER backstop reports the stamped id on the successful send', () => {
    const ws = new FakeWS();
    const observed = [];
    ws[ASK_STARTED_OBSERVER] = (info) => observed.push(info);
    const session = buildSession({ 13: { circuit_designation: 'Cooker' } });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
      responseEpoch: EPOCH,
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0].utteranceId).toBe(EPOCH);
  });
});

// ── Rows 2 & 3 — the legacy ring / IR scripts thread the epoch too ──────────

describe('P4d rows 2-3 — legacy ring/IR script ask frames carry the epoch', () => {
  test('legacy ring-continuity slot ask carries utterance_id', () => {
    const ws = new FakeWS();
    const session = { sessionId: 'sess_p4d', stateSnapshot: { circuits: {} } };
    legacyRingTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Ring continuity for circuit 5.',
      logger: null,
      now: 1000,
      responseEpoch: EPOCH,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask.utterance_id).toBe(EPOCH);
  });

  test('legacy IR ask carries utterance_id', () => {
    const ws = new FakeWS();
    const session = { sessionId: 'sess_p4d', stateSnapshot: { circuits: {} } };
    legacyIrTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Insulation resistance for circuit 5.',
      logger: null,
      now: 1000,
      responseEpoch: EPOCH,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask.utterance_id).toBe(EPOCH);
  });

  test('legacy ring script without an epoch omits utterance_id (dead-path null default, no throw)', () => {
    const ws = new FakeWS();
    const session = { sessionId: 'sess_p4d', stateSnapshot: { circuits: {} } };
    legacyRingTurn({
      ws,
      session,
      sessionId: 'sess_p4d',
      transcriptText: 'Ring continuity for circuit 5.',
      logger: null,
      now: 1000,
    });
    const ask = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(ask).toBeDefined();
    expect(ask).not.toHaveProperty('utterance_id');
  });
});

// ── Row 4 — the ask dispatcher stamps the QUESTION frame ────────────────────

describe('P4d row 4 — dispatcher ask_user_started carries the response epoch', () => {
  function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  }
  function makeWs() {
    const sent = [];
    return {
      readyState: 1,
      OPEN: 1,
      sent,
      send: jest.fn((data) => sent.push(JSON.parse(data))),
    };
  }
  const call = {
    id: 'toolu_p4d',
    name: 'ask_user',
    input: {
      question: 'Which circuit were you referring to?',
      reason: 'ambiguous_circuit',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'circuit_ref',
    },
  };

  test('initial ask carries utterance_id from responseEpochRef.current', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = { sessionId: 'sess-1', toolCallsMode: 'live' };
      const ws = makeWs();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, makeLogger(), 'turn-1', pending, ws, {
        responseEpochRef: { current: EPOCH },
      });
      dispatch(call, { sessionId: 'sess-1', turnId: 'turn-1' });
      await Promise.resolve();
      await Promise.resolve();
      const ask = ws.sent.find((m) => m.type === 'ask_user_started');
      expect(ask).toBeDefined();
      expect(ask.utterance_id).toBe(EPOCH);
    } finally {
      jest.useRealTimers();
    }
  });

  test('no responseEpochRef (legacy) → ask omits utterance_id, never throws', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = { sessionId: 'sess-1', toolCallsMode: 'live' };
      const ws = makeWs();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, makeLogger(), 'turn-1', pending, ws, {});
      dispatch(call, { sessionId: 'sess-1', turnId: 'turn-1' });
      await Promise.resolve();
      await Promise.resolve();
      const ask = ws.sent.find((m) => m.type === 'ask_user_started');
      expect(ask).toBeDefined();
      expect(ask).not.toHaveProperty('utterance_id');
    } finally {
      jest.useRealTimers();
    }
  });
});
