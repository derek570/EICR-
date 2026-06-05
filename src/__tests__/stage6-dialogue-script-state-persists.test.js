/**
 * Regression: dialogue-engine state written by `start_dialogue_script` must
 * persist on the LIVE session across turns.
 *
 * Field repro 2026-05-01 session DFA7FDBF-86DB-4E7A-9E4F-70217CF2C028.
 * Inspector said "ring continuity lives are 0.6" → Deepgram garbled to
 * "recontinuity lives are 0.6" → Sonnet (correctly) called the safety-net
 * `start_dialogue_script` tool with schema=ring_continuity, circuit=null,
 * pending_writes=[ring_r1_ohm:0.6]. The dispatcher invoked enterScriptByName
 * which wrote `dialogueScriptState = {active:true, schemaName:'ring_continuity',
 * …}` and emitted "Which circuit is the ring continuity for?" via srv-rcs.
 * Inspector replied "downstairs sockets". The engine's processDialogueTurn
 * was supposed to read `state.active`, find circuit 2 by designation match,
 * fill in R1=0.6, and ask for neutrals.
 *
 * Instead, processDialogueTurn read `entry.session.dialogueScriptState` and
 * found `undefined`. Sonnet emitted a fresh `ask_user` "Which circuit number
 * is the downstairs sockets?" — re-asking what the walk-through was meant to
 * resolve silently from the snapshot.
 *
 * Root cause: stage6-shadow-harness.js's runLiveMode built a per-turn
 * literal `liveSession = { sessionId, stateSnapshot, extractedObservations,
 * toolCallsMode:'live' }` and bound that to the dispatcher. The dispatcher
 * called enterScriptByName({ session: liveSession, … }) which wrote
 * `liveSession.dialogueScriptState = …`. The literal was thrown away at
 * end-of-turn and the real session's `dialogueScriptState` stayed undefined.
 * `stateSnapshot` and `extractedObservations` survived because they're
 * reference-copied, but a NEW property assignment on the literal cannot
 * propagate up.
 *
 * Fix (stage6-shadow-harness.js): alias `liveSession = session` so writes
 * land on the underlying session.
 *
 * This file pins the cross-turn invariant directly by:
 *   1. Driving runShadowHarness in live mode with a tool-use stream that
 *      calls start_dialogue_script.
 *   2. Asserting `session.dialogueScriptState` IS set on the same session
 *      object the test handed in (proving no clone barrier).
 *   3. Calling processRingContinuityTurn against the same session with the
 *      simulated answer "downstairs sockets" and asserting the engine
 *      resolves circuit 2 via findCircuitByDesignation — the end-to-end
 *      behaviour the live field repro lost.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockClient } from './helpers/mockStream.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { processRingContinuityTurn } from '../extraction/dialogue-engine/index.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Single-round end_turn — no further tool calls.
 */
function endTurnStream() {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

/**
 * Tool-use stream that calls start_dialogue_script(ring_continuity, null,
 * pending_writes=[{ring_r1_ohm, 0.6}]) — the exact shape Sonnet emitted in
 * the DFA7FDBF field repro.
 */
function startDialogueScriptStream({ pendingR1 = '0.6' } = {}) {
  const input = {
    schema: 'ring_continuity',
    circuit: null,
    source_turn_id: 'turn-test',
    reason: 'test fixture — Deepgram garbled "ring" prefix',
    pending_writes: [{ field: 'ring_r1_ohm', value: pendingR1 }],
  };
  return [
    { type: 'message_start', message: { id: 'msg_tool', role: 'assistant', content: [] } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_sds_1', name: 'start_dialogue_script', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/**
 * Build a session shape the harness accepts. Mirrors the canonical fixture
 * in stage6-shadow-harness.test.js — `mode='live'`, snapshot pre-seeded with
 * two named circuits (the field-repro state at the moment "downstairs sockets"
 * came in).
 */
function makeLiveSession() {
  return {
    sessionId: 'sess-DFA7FDBF',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([startDialogueScriptStream(), endTurnStream()]),
    stateSnapshot: {
      circuits: {
        1: { circuit_ref: 1, circuit_designation: 'Upstairs Light' },
        2: { circuit_ref: 2, circuit_designation: 'Downstairs Sockets' },
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    _snapshot: null,
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    extractFromUtterance: jest.fn(),
  };
}

describe('dialogue-engine state survives end-of-turn (DFA7FDBF regression)', () => {
  let session;
  let logger;

  beforeEach(() => {
    session = makeLiveSession();
    logger = makeLogger();
  });

  test('start_dialogue_script via runShadowHarness writes dialogueScriptState onto the LIVE session, not a per-turn clone', async () => {
    expect(session.dialogueScriptState).toBeUndefined();

    await runShadowHarness(session, '[recontinuity lives are 0.6]', [], { logger });

    // The bug: the literal `liveSession = { sessionId, stateSnapshot, … }`
    // captured the dispatcher closure; enterScriptByName's
    // `session.dialogueScriptState = …` landed on that throwaway literal.
    // After the fix the real session carries the state.
    expect(session.dialogueScriptState).toBeDefined();
    expect(session.dialogueScriptState).toMatchObject({
      active: true,
      schemaName: 'ring_continuity',
      // pending_writes seeds dropped to empty after entry seeds R1; R1 lives
      // in `state.values` once the circuit is resolved on a later turn.
      // While circuit_ref is still null, R1 stays queued.
      circuit_ref: null,
    });
    // Crucial: the volunteered ring_r1_ohm reading is held against the next
    // turn's circuit resolution — not lost.
    const queuedR1 = session.dialogueScriptState.pending_writes?.find(
      (w) => w.field === 'ring_r1_ohm'
    );
    expect(queuedR1).toBeDefined();
    expect(queuedR1.value).toBe('0.6');
  });

  test("next-turn 'downstairs sockets' resolves to circuit 2 via designation match — walk-through continues", async () => {
    // Turn 1 — Sonnet calls start_dialogue_script (Deepgram garbled "ring").
    await runShadowHarness(session, '[recontinuity lives are 0.6]', [], { logger });
    expect(session.dialogueScriptState?.active).toBe(true);

    // Turn 2 — inspector replies "downstairs sockets" to the engine's
    // "Which circuit is the ring continuity for?" prompt. Engine runs
    // BEFORE Sonnet on every transcript turn; with state alive on the live
    // session it should find circuit 2 by designation match, drain the
    // queued R1=0.6 onto circuit 2, and emit the next slot ask ("What are
    // the neutrals?").
    const fakeWs = { send: jest.fn(), readyState: 1, OPEN: 1 };
    const outcome = processRingContinuityTurn({
      ws: fakeWs,
      session,
      sessionId: session.sessionId,
      transcriptText: 'downstairs sockets.',
      logger,
    });

    // Engine consumed the turn — Sonnet path is bypassed.
    expect(outcome.handled).toBe(true);
    expect(outcome.fallthrough).toBeFalsy();

    // Designation match log emitted — fresh-eyes pin so the resolution path
    // is searchable in CloudWatch.
    const designationCall = logger.info.mock.calls.find(
      (c) => c[0] === 'stage6.ring_continuity_script_designation_match'
    );
    expect(designationCall).toBeDefined();
    expect(designationCall[1]).toMatchObject({ circuit_ref: 2 });

    // Engine's circuit_ref is now bound to 2 — walk-through is now anchored.
    expect(session.dialogueScriptState.circuit_ref).toBe(2);
    // R1=0.6 has drained onto the resolved circuit (state.values).
    expect(session.dialogueScriptState.values?.ring_r1_ohm).toBe('0.6');

    // The engine emitted the next slot ask via the WS — this is the visible
    // "walk-through continued" signal the inspector hears as TTS. Asks are
    // shaped { type: 'ask_user_started', tool_call_id: 'srv-rcs-…-{circuit}-
    // {field}-…', question: 'What are the neutrals?', context_field:
    // 'ring_rn_ohm', context_circuit: 2 } per buildScriptAsk in
    // src/extraction/dialogue-engine/helpers/wire-emit.js.
    const sentFrames = fakeWs.send.mock.calls.map((c) => JSON.parse(c[0]));
    const nextSlotAsk = sentFrames.find(
      (f) => f.type === 'ask_user_started' && /neutral/i.test(f.question ?? '')
    );
    expect(nextSlotAsk).toBeDefined();
    expect(nextSlotAsk.tool_call_id).toMatch(/^srv-rcs-/);
    expect(nextSlotAsk.context_field).toBe('ring_rn_ohm');
    expect(nextSlotAsk.context_circuit).toBe(2);
  });
});
