/**
 * PLAN-A 2026-08-23 (feedback id 126) — LIVE-path hybrid-blocker seam.
 *
 * The scenario: a direct mirror command was asked while the source was
 * incomplete (question emitted), the deciding source write then lands through
 * the REAL live tool loop (runShadowHarness, mode 'live'), and the target
 * meanwhile holds a component the source lacks. The controller terminates
 * fail-closed with a question-LESS terminal carrying only clearAskId.
 *
 * What this file locks:
 *  1. stage6-shadow-harness retains ADDRESS_MIRROR_DIRECT_FOLLOWUP when
 *     directFinal carries question OR clearAskId (previously question-only —
 *     the blocked terminal's cancel_pending_tts never reached the live frame
 *     ledger while the legacy finalizer already handled both).
 *  2. buildResultFrameLedger emits cancel_pending_tts BEFORE any frame that
 *     carries the spoken blocker, exactly one spoken blocker, zero copy.
 */

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { activeSessions } from '../extraction/active-sessions.js';
import {
  ADDRESS_MIRROR_DIRECT_FOLLOWUP,
  createAddressMirrorController,
} from '../extraction/address-mirror-controller.js';
import { _test_buildResultFrameLedger } from '../extraction/sonnet-stream.js';
import { EVALUATION_CONTEXT } from '../extraction/plan00-lifecycle-hooks.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { mockClient } from './helpers/mockStream.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function toolUseRound(toolCalls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_tu', role: 'assistant', content: [] } },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

const SESSION_ID = 'hybrid-live-seam';

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

test('deciding source write on the live path → cancel_pending_tts precedes exactly one spoken blocker, zero copy', async () => {
  const streams = [
    toolUseRound([
      {
        id: 'toolu_county',
        name: 'record_board_reading',
        input: { field: 'county', value: 'Essex', confidence: 1, source_turn_id: 't1' },
      },
    ]),
    endTurnRound(),
  ];
  const session = {
    sessionId: SESSION_ID,
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient(streams),
    stateSnapshot: {
      circuits: {
        0: {
          address: '137 Large Lane',
          client_postcode: 'HB1 1AA',
        },
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt }];
    },
    extractFromUtterance: jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions: [],
    })),
  };

  // The pending direct-incomplete question, exactly as the ingress path
  // would have created it: source is address-only, so the command asks for
  // the missing corroborator and stays pending.
  const controller = createAddressMirrorController({ session });
  const asked = await controller.applyDirectCommand(
    'use the same address for the client',
    createPerTurnWrites(),
    'utt-hybrid-cmd'
  );
  expect(asked).toMatchObject({ handled: true, outcome: 'source_incomplete' });
  expect(asked.question).toBe('What is the site postcode, town, or county?');

  // Cycle-2 pin: the finalize-driven blocked terminal must resolve its ask
  // in the Plan-00 evidence ledger exactly once (this path runs after the
  // tool loop, past every ingress-side recordAskResolved branch).
  const recordAskResolved = jest.fn();
  activeSessions.set(SESSION_ID, {
    addressMirrorController: controller,
    [EVALUATION_CONTEXT]: { recordAskResolved },
  });

  // The deciding write lands through the REAL live tool loop; the post-loop
  // mirror seam observes it, finds the target's postcode absent from the
  // now-complete source, and terminates the direct intent fail-closed.
  const result = await runShadowHarness(session, 'county is essex', [], {
    logger: mockLogger(),
    confirmationsEnabled: true,
    utteranceId: 'utt-hybrid-write',
  });

  // Seam fix: the question-less blocked terminal is RETAINED on the result.
  const followup = result[ADDRESS_MIRROR_DIRECT_FOLLOWUP];
  expect(followup).toMatchObject({ handled: true, outcome: 'blocked' });
  expect(followup.question).toBeUndefined();
  expect(followup.clearAskId).toBe(asked.questionId);

  // Zero copy — no derived client_* writes anywhere, snapshot untouched.
  const clientWrites = (result.extracted_board_readings ?? []).filter((r) =>
    String(r.field ?? '').startsWith('client_')
  );
  expect(clientWrites).toEqual([]);
  expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
  expect(session.stateSnapshot.circuits[0].client_postcode).toBe('HB1 1AA');

  // Frame ledger: cancel_pending_tts FIRST (clearing the direct question's
  // alert), then the audible frames — the spoken blocker exactly once.
  const frames = _test_buildResultFrameLedger(session.stateSnapshot, result, session);
  expect(frames[0].kind).toBe('cancel_pending_tts');
  expect(JSON.parse(frames[0].json)).toMatchObject({
    type: 'cancel_pending_tts',
    prefix: asked.questionId,
  });
  const blockerText =
    'The client address already has a postcode — dictate the site postcode and ask me again.';
  const framesCarryingBlocker = frames.filter((frame) => frame.json.includes(blockerText));
  expect(framesCarryingBlocker.length).toBe(1);
  expect(frames.indexOf(framesCarryingBlocker[0])).toBeGreaterThan(0);

  // The evidence ledger closed the cleared ask exactly once, with the
  // blocked outcome.
  expect(recordAskResolved).toHaveBeenCalledTimes(1);
  expect(recordAskResolved).toHaveBeenCalledWith(
    expect.objectContaining({
      runtimeId: asked.questionId,
      terminal: 'answered',
      detail: expect.objectContaining({ outcome: 'blocked' }),
    })
  );
});
