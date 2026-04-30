/**
 * Tests for the start_dialogue_script tool dispatcher
 * (stage6-dispatchers-script.js) and the engine's enterScriptByName
 * back-door it wraps.
 *
 * Added 2026-04-30 (Silvertown Road follow-up). Together with the
 * dialogue-engine.test.js retry-once tests, this file pins the Sonnet-
 * driven recovery path for entry-trigger garbles like "instellation
 * resistance" and "wing continuity" that the per-schema regex misses.
 */

import { jest } from '@jest/globals';
import { dispatchStartDialogueScript } from '../extraction/stage6-dispatchers-script.js';
import {
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
  ringContinuitySchema,
  insulationResistanceSchema,
} from '../extraction/dialogue-engine/index.js';
import {
  processInsulationResistanceTurn,
  processRingContinuityTurn,
} from '../extraction/dialogue-engine/index.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

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
  return {
    sessionId: 'sess_test',
    stateSnapshot: { circuits },
  };
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function buildCtx(session, ws = null) {
  return {
    session,
    logger: mockLogger(),
    turnId: 't1',
    perTurnWrites: createPerTurnWrites(),
    round: 1,
    ws,
  };
}

describe('enterScriptByName — engine back door', () => {
  test('happy path: enters IR with circuit, emits live-to-live ask', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: { circuit_designation: 'Upstairs Sockets' } });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'insulation_resistance',
      circuit_ref: 4,
      ws,
      logger: null,
      now: 1000,
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'entered',
      schema: 'insulation_resistance',
      circuit_ref: 4,
      seeded_writes: [],
      queued_writes: [],
      dropped_fields: [],
    });
    expect(session.dialogueScriptState.active).toBe(true);
    expect(session.dialogueScriptState.schemaName).toBe('insulation_resistance');
    expect(session.dialogueScriptState.circuit_ref).toBe(4);
    // First slot ask emitted on the wire.
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      tool_call_id: 'srv-irs-sess_test-4-ir_live_live_mohm-1000',
      question: "What's the live-to-live?",
      context_field: 'ir_live_live_mohm',
      context_circuit: 4,
    });
  });

  test('null circuit emits the schema "which circuit?" ask', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      ws,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.circuit_ref).toBeNull();
    expect(ws.sent[0].question).toBe('Which circuit is the ring continuity for?');
    expect(ws.sent[0].context_field).toBeNull();
    expect(ws.sent[0].context_circuit).toBeNull();
  });

  test('idempotent — second call when a script is already active is a no-op', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });

    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      ws,
      now: 1000,
    });
    const stateBefore = { ...session.dialogueScriptState };
    const sentBefore = ws.sent.length;

    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'insulation_resistance', // different schema
      circuit_ref: 4,
      ws,
      now: 2000,
    });

    expect(result).toEqual({
      ok: true,
      status: 'already_active',
      schema: 'ring_continuity', // returns the ALREADY-active schema
      circuit_ref: 4,
    });
    // Engine state untouched.
    expect(session.dialogueScriptState.schemaName).toBe('ring_continuity');
    expect(session.dialogueScriptState.entered_at).toBe(stateBefore.entered_at);
    // No new ask emitted.
    expect(ws.sent.length).toBe(sentBefore);
  });

  test('rejects unknown schema name', () => {
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'not_a_real_schema',
      circuit_ref: null,
      now: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown_schema');
    expect(session.dialogueScriptState).toBeUndefined();
  });

  test('rejects unknown circuit_ref (no silent create)', () => {
    const session = buildSession({ 4: {} }); // no circuit 99
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 99,
      now: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'unknown_circuit', circuit_ref: 99 });
    expect(session.dialogueScriptState).toBeUndefined();
  });

  test('rejects invalid circuit_ref (negative / non-integer)', () => {
    const session = buildSession({ 4: {} });
    const r1 = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: -1,
      now: 1000,
    });
    expect(r1.ok).toBe(false);
    expect(r1.error.code).toBe('invalid_circuit_ref');

    const r2 = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 1.5,
      now: 1000,
    });
    expect(r2.ok).toBe(false);
    expect(r2.error.code).toBe('invalid_circuit_ref');
  });

  test('seeds existing snapshot values (skip-already-filled)', () => {
    const ws = new FakeWS();
    const session = buildSession({
      4: {
        circuit_designation: 'Upstairs Sockets',
        ring_r1_ohm: '0.83',
        ring_rn_ohm: '0.82',
      },
    });
    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      ws,
      now: 1000,
    });
    expect(session.dialogueScriptState.values).toEqual({
      ring_r1_ohm: '0.83',
      ring_rn_ohm: '0.82',
    });
    // Engine asks for the next missing slot (R2/CPC), not the first.
    expect(ws.sent[0].context_field).toBe('ring_r2_ohm');
    expect(ws.sent[0].question).toBe("What's the CPC?");
  });

  test('seeds Sonnet-volunteered values via pending_writes when circuit known', () => {
    // Codex P1#2: Sonnet hears "ring continuity for circuit 4 lives 0.32"
    // → Deepgram garbles "ring" but Sonnet recovers via LLM understanding.
    // Sonnet calls start_dialogue_script with circuit=4 + pending_writes
    // for R1=0.32. Engine writes R1 immediately, asks for R_n next.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
      ws,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.seeded_writes).toEqual(['ring_r1_ohm']);
    expect(result.queued_writes).toEqual([]);
    // Snapshot received the write.
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.32');
    // First wire emit: extraction payload for R1.
    expect(ws.sent[0]).toMatchObject({
      type: 'extraction',
      result: {
        readings: [
          {
            field: 'ring_r1_ohm',
            circuit: 4,
            value: '0.32',
            source: 'ring_script',
          },
        ],
      },
    });
    // Second wire emit: ask for R_n (next missing slot).
    expect(ws.sent[1].context_field).toBe('ring_rn_ohm');
    expect(ws.sent[1].question).toBe('What are the neutrals?');
  });

  test('queues Sonnet-volunteered values via pending_writes when circuit unknown', () => {
    // The Silvertown shape: "ring continuity lives are 0.32" with no
    // circuit number. Sonnet calls start_dialogue_script with circuit=null
    // + pending_writes. Engine asks "Which circuit?", queues R1.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
      ws,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.seeded_writes).toEqual([]); // not written yet
    expect(result.queued_writes).toEqual(['ring_r1_ohm']);
    // Nothing on the snapshot yet.
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBeUndefined();
    // pending_writes is in state, ready for circuit answer.
    expect(session.dialogueScriptState.pending_writes).toEqual([
      { field: 'ring_r1_ohm', value: '0.32' },
    ]);
    // First (and only) wire emit: which-circuit ask.
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].question).toBe('Which circuit is the ring continuity for?');
  });

  test('drains queued pending_writes onto the circuit when user answers', () => {
    // Continuation of the previous test. After server-entry with queued
    // R1, inspector says "circuit 4". Engine resolves circuit, drains R1.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      pending_writes: [{ field: 'ring_r1_ohm', value: '0.32' }],
      ws,
      now: 1000,
    });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: 'sess_test',
      transcriptText: '4',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[4].ring_r1_ohm).toBe('0.32');
    expect(session.dialogueScriptState.pending_writes).toEqual([]);
    // Engine asked for R_n.
    expect(ws.sent.at(-1).context_field).toBe('ring_rn_ohm');
  });

  test('drops unknown / malformed pending_writes entries (defence in depth)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      pending_writes: [
        { field: 'ring_r1_ohm', value: '0.32' }, // valid → applied
        { field: 'not_a_field', value: '0.43' }, // unknown → dropped
        { field: 'ir_live_live_mohm', value: '200' }, // wrong schema → dropped
        { field: 'ring_r2_ohm', value: '' }, // empty value → dropped
        null, // garbage → dropped
        { value: '0.5' }, // missing field → dropped
      ],
      ws,
      now: 1000,
    });
    expect(result.seeded_writes).toEqual(['ring_r1_ohm']);
    expect(result.dropped_fields).toEqual(['not_a_field', 'ir_live_live_mohm', 'ring_r2_ohm']);
    // Only the valid write landed on the snapshot.
    expect(session.stateSnapshot.circuits[4]).toMatchObject({
      ring_r1_ohm: '0.32',
    });
    expect(session.stateSnapshot.circuits[4].ring_r2_ohm).toBeUndefined();
  });

  test('all-slots-filled via pending_writes triggers immediate finishScript', () => {
    // Inspector dictates a complete ring family in one breath.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      pending_writes: [
        { field: 'ring_r1_ohm', value: '0.32' },
        { field: 'ring_rn_ohm', value: '0.31' },
        { field: 'ring_r2_ohm', value: '0.55' },
      ],
      ws,
      now: 1000,
    });
    // All three writes landed.
    expect(session.stateSnapshot.circuits[4]).toMatchObject({
      ring_r1_ohm: '0.32',
      ring_rn_ohm: '0.31',
      ring_r2_ohm: '0.55',
    });
    // finishScript ran — completion info emitted, state cleared.
    expect(session.dialogueScriptState).toBeNull();
    expect(ws.sent.at(-1)).toMatchObject({
      reason: 'info',
      question: expect.stringContaining('Got it'),
    });
  });

  test('handoff: server-entered IR script handles the next user turn cleanly', () => {
    // Silvertown-style scenario for IR. Sonnet calls start_dialogue_script
    // because Deepgram garbled "instellation resistance". Engine state set
    // up. Next user turn ("circuit 4, live-to-live 200") flows through
    // the active path.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'insulation_resistance',
      circuit_ref: null, // Sonnet didn't capture the circuit either
      ws,
      now: 1000,
    });
    expect(session.dialogueScriptState.circuit_ref).toBeNull();

    // Next user turn — answers the engine's "Which circuit?" with a digit.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: 'sess_test',
      transcriptText: '4',
      now: 2000,
    });
    expect(session.dialogueScriptState.circuit_ref).toBe(4);
    // Engine asked the first IR slot.
    const lastAsk = ws.sent.at(-1);
    expect(lastAsk.context_field).toBe('ir_live_live_mohm');
    expect(lastAsk.context_circuit).toBe(4);
  });
});

describe('dispatchStartDialogueScript — tool dispatcher', () => {
  test('happy path returns ok envelope and enters the script', async () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: { circuit_designation: 'Upstairs Sockets' } });
    const ctx = buildCtx(session, ws);

    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_1',
        name: 'start_dialogue_script',
        input: {
          schema: 'insulation_resistance',
          circuit: 4,
          source_turn_id: 'turn-1',
          reason: 'engine missed instellation garble',
        },
      },
      ctx
    );

    expect(res.tool_use_id).toBe('tu_1');
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body).toMatchObject({
      ok: true,
      status: 'entered',
      schema: 'insulation_resistance',
      circuit_ref: 4,
      seeded_writes: [],
      queued_writes: [],
      dropped_fields: [],
    });
    // Side effect: engine state set up + first ask emitted.
    expect(session.dialogueScriptState.schemaName).toBe('insulation_resistance');
    expect(ws.sent[0].question).toBe("What's the live-to-live?");
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        tool: 'start_dialogue_script',
        outcome: 'ok',
      })
    );
  });

  test('idempotent — already_active is non-error', async () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    // Pre-existing ring script.
    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: 4,
      ws,
      now: 1000,
    });
    const ctx = buildCtx(session, ws);

    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_2',
        name: 'start_dialogue_script',
        input: {
          schema: 'insulation_resistance',
          circuit: 4,
          source_turn_id: 'turn-2',
          reason: 'defensive call alongside engine entry',
        },
      },
      ctx
    );

    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.status).toBe('already_active');
    expect(body.schema).toBe('ring_continuity');
    // Tool-call log row uses outcome:'noop' (matches the documented
    // logger enum 'ok' | 'noop' | 'rejected'); the detail
    // (which schema was active) lives in the separate
    // `stage6.dialogue_script_already_active` row from the engine.
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({ outcome: 'noop' })
    );
  });

  test('rejects unknown schema with is_error envelope', async () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const ctx = buildCtx(session, ws);

    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_3',
        name: 'start_dialogue_script',
        input: {
          schema: 'not_a_real_schema',
          circuit: null,
          source_turn_id: 'turn-3',
          reason: 'oops',
        },
      },
      ctx
    );

    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unknown_schema');
    expect(session.dialogueScriptState).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({ outcome: 'rejected' })
    );
  });

  test('rejects unknown circuit (no silent create)', async () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} }); // no circuit 99
    const ctx = buildCtx(session, ws);

    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_4',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: 99,
          source_turn_id: 'turn-4',
          reason: 'guessed circuit',
        },
      },
      ctx
    );

    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error.code).toBe('unknown_circuit');
    expect(body.error.circuit_ref).toBe(99);
  });

  test('null circuit is allowed — engine asks "Which circuit?"', async () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const ctx = buildCtx(session, ws);

    const res = await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_5',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: null,
          source_turn_id: 'turn-5',
          reason: 'inspector named load by designation',
        },
      },
      ctx
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).circuit_ref).toBeNull();
    expect(ws.sent[0].question).toBe('Which circuit is the ring continuity for?');
  });

  test('falls back to session.activeWs when ctx.ws is absent', async () => {
    // Future plumbing might stash the WS on the session instead of
    // threading via ctx — defence-in-depth so we don't break that path.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    session.activeWs = ws;
    const ctx = buildCtx(session, null); // no ctx.ws

    await dispatchStartDialogueScript(
      {
        tool_call_id: 'tu_6',
        name: 'start_dialogue_script',
        input: {
          schema: 'ring_continuity',
          circuit: 4,
          source_turn_id: 'turn-6',
          reason: 'session-level ws fallback',
        },
      },
      ctx
    );

    // Ask reached the WS via session.activeWs.
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].question).toBe('What are the lives?');
  });
});

describe('Silvertown end-to-end recovery (Fix 1 + Fix 2 combined)', () => {
  test('engine retry catches Silvertown-style "upstairs socket" miss', () => {
    // This is a re-statement of the Silvertown repro using the dispatcher
    // entry rather than the regex entry. Verifies that even when the script
    // is server-entered (Sonnet path), the Fix 1 retry kicks in for the
    // first unresolvable circuit answer.
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });

    enterScriptByName({
      session,
      sessionId: 'sess_test',
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      ws,
      now: 1000,
    });
    expect(ws.sent[0].question).toBe('Which circuit is the ring continuity for?');

    // User responds with un-resolvable designation — designation lookup
    // returns null because circuit 4 has no designation set.
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: 'sess_test',
      transcriptText: 'upstairs socket.',
      now: 2000,
    });

    // Fix 1 kicks in — engine re-asks instead of discarding state.
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(session.dialogueScriptState.circuit_retry_attempted).toBe(true);
    expect(ws.sent.at(-1).question).toBe("What's the circuit number for the upstairs socket.?");
  });
});
