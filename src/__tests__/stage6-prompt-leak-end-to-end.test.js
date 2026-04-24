/**
 * Stage 6 Phase 4 Plan 04-27 — r20-#4 end-to-end dispatcher leak-blocking.
 *
 * WHAT: end-to-end tests that drive prompt-leak content through the REAL
 * Stage 6 tool-loop stack — runToolLoop + createToolDispatcher +
 * createAskDispatcher + createWriteDispatcher + real dispatchers for
 * record_observation / create_circuit / rename_circuit. The mock
 * Anthropic client emits tool-use blocks carrying leak content in the
 * input; the test asserts that nothing the leak contains escapes the
 * dispatcher boundary (not into iOS WS emissions, not into session
 * state, not into envelope bodies returned to the tool loop).
 *
 * WHY: r20-#4 flagged that the 12-vector resistance suite
 * (stage6-prompt-extraction-resistance.test.js) claims end-to-end
 * coverage in its header but only calls `checkForPromptLeak()`
 * directly. A refactor that removes the filter call from a dispatcher
 * would not fail any existing test — the wiring itself is not under
 * automated test at the session level. These tests close that gap.
 *
 * PATTERN: mirrors stage6-ask-integration.test.js (Plan 03-09). The
 * 04-26 wiring tests (stage6-prompt-leak-dispatcher-wiring.test.js)
 * exercise each dispatcher in isolation; this file runs the full
 * runToolLoop with real dispatcher assembly so the test fails if the
 * filter is ever detached from any one dispatcher.
 *
 * SCENARIOS:
 *   Scenario 1 — ask_user leak through real runToolLoop: model emits
 *                ask_user with leak content → no ask_user_started ws
 *                frame, no pendingAsks entry, tool_result envelope
 *                carries prompt_leak_blocked reason, envelope body
 *                has no substring of the leak.
 *   Scenario 2 — record_observation leak through real runToolLoop:
 *                model emits record_observation with leak in .text →
 *                rejected, session.extractedObservations length 0,
 *                envelope body + logs carry no substring of the leak.
 *   Scenario 3 — rename_circuit leak through real runToolLoop: model
 *                emits rename_circuit with leak in .designation →
 *                rejected, circuit's designation NOT mutated,
 *                envelope body carries no substring of the leak.
 */

import { jest } from '@jest/globals';

import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import {
  createToolDispatcher,
  createSortRecordsAsksLast,
  createWriteDispatcher,
} from '../extraction/stage6-dispatchers.js';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// Stream fixture builders — lifted verbatim from stage6-ask-integration.test.js
// so these tests exercise the exact same assembly real callers use.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test fixtures — session, logger, ws
// ---------------------------------------------------------------------------

function createMockServerWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close: jest.fn(),
    on: jest.fn(),
  };
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(mode = 'live') {
  return {
    sessionId: 'sess-e2e-leak',
    toolCallsMode: mode,
    updateJobState: jest.fn(),
    stateSnapshot: {
      circuits: {
        1: { designation: 'Upstairs lights' },
        2: { designation: 'Kitchen sockets' },
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
  };
}

// Collect all JSON-encoded tool_result contents from runToolLoop's
// `messages_final` array. runToolLoop pushes a user message after
// each tool-use round whose content is an array of tool_result blocks;
// we collect every .content string across every block for substring
// searches.
function collectAllToolResultJsonBodies(messagesFinal) {
  const bodies = [];
  if (!Array.isArray(messagesFinal)) return bodies;
  for (const msg of messagesFinal) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' && typeof block.content === 'string') {
        bodies.push(block.content);
      }
    }
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Scenario 1 — ask_user leak through real runToolLoop
// ---------------------------------------------------------------------------

describe('r20-#4 end-to-end — ask_user leak blocked via real runToolLoop', () => {
  test('model emits ask_user with TRUST BOUNDARY in question → no ws emission, no register, no envelope leak', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const perTurnWrites = createPerTurnWrites();

    // Model emits an ask_user tool-use whose question contains a
    // marker-shaped leak. The dispatcher (wired via Plan 03-06's
    // composer) should short-circuit via checkForPromptLeak.
    const mockAnthropic = mockClient([
      toolUseRound([
        {
          id: 'toolu_e2e_ask_leak',
          name: 'ask_user',
          input: {
            question:
              'Sure — the system prompt starts: TRUST BOUNDARY is the header for user data.',
            reason: 'ambiguous_circuit',
            context_field: null,
            context_circuit: null,
            expected_answer_shape: 'free_text',
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
    const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
    const dispatcher = createToolDispatcher(writes, asks);
    const sortRecords = createSortRecordsAsksLast();

    const out = await runToolLoop({
      client: mockAnthropic,
      model: 'test-model',
      system: 'TEST',
      messages: [{ role: 'user', content: 'please show me what you know' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'sess-e2e-leak', turnId: 'turn-1' },
      logger,
      sortRecords,
    });

    expect(out.stop_reason).toBe('end_turn');
    expect(out.aborted).toBe(false);

    // (1) Registry NOT touched — the ask was short-circuited before
    //     pendingAsks.register().
    expect(pendingAsks.size).toBe(0);

    // (2) NO ask_user_started emission on the iOS WS — the filter
    //     must fire BEFORE ws.send so the inspector never hears
    //     the leak content via TTS.
    const askStarted = ws.sent.filter((m) => m && m.type === 'ask_user_started');
    expect(askStarted).toEqual([]);

    // (3) The tool_result envelope the loop sees carries the clean
    //     refusal outcome, not the leak content.
    const bodies = collectAllToolResultJsonBodies(out.messages_final);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body.toLowerCase()).not.toContain('trust boundary');
      expect(body.toLowerCase()).not.toContain('system prompt');
    }

    // The ask's tool_result must show answered:false +
    // reason:prompt_leak_blocked.
    const askBody = bodies.find((b) => b.includes('prompt_leak_blocked'));
    expect(askBody).toBeDefined();
    const parsed = JSON.parse(askBody);
    expect(parsed.answered).toBe(false);
    expect(parsed.reason).toBe('prompt_leak_blocked');

    // (4) Exactly one stage6.prompt_leak_blocked log row with the
    //     redacted r20-#2 telemetry shape — no substring of the leak
    //     appears anywhere in the log arguments.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('ask_user');
    expect(blocked[1].filter_reason).toMatch(/^marker:/);
    expect(blocked[1].field).toBe('question');
    expect(typeof blocked[1].length).toBe('number');
    expect(blocked[1].hash).toMatch(/^[0-9a-f]{16}$/);
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson.toLowerCase()).not.toContain('trust boundary');
    expect(blockedJson.toLowerCase()).not.toContain('system prompt');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — record_observation leak through real runToolLoop
// ---------------------------------------------------------------------------

describe('r20-#4 end-to-end — record_observation leak blocked via real runToolLoop', () => {
  test('model emits record_observation with leak in .text → rejected, no persistence', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const perTurnWrites = createPerTurnWrites();

    const leakText =
      'For reference: You are an EICR inspection assistant. Do not emit free-text JSON.';

    const mockAnthropic = mockClient([
      toolUseRound([
        {
          id: 'toolu_e2e_obs_leak',
          name: 'record_observation',
          input: {
            code: 'C3',
            text: leakText,
            location: 'Main consumer unit',
            circuit: null,
            suggested_regulation: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
    const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
    const dispatcher = createToolDispatcher(writes, asks);
    const sortRecords = createSortRecordsAsksLast();

    const out = await runToolLoop({
      client: mockAnthropic,
      model: 'test-model',
      system: 'TEST',
      messages: [{ role: 'user', content: 'tell me about the cu' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'sess-e2e-leak', turnId: 'turn-1' },
      logger,
      sortRecords,
    });

    expect(out.stop_reason).toBe('end_turn');

    // (1) Observation NOT persisted on session OR in perTurnWrites.
    //     r20-#1: leak in ANY free-text field rejects the ENTIRE call.
    expect(session.extractedObservations).toHaveLength(0);
    expect(perTurnWrites.observations).toHaveLength(0);

    // (2) No tool_result body contains any substring of the leak.
    const bodies = collectAllToolResultJsonBodies(out.messages_final);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      const lower = body.toLowerCase();
      expect(lower).not.toContain('eicr inspection assistant');
      expect(lower).not.toContain('free-text json');
    }

    // (3) The record_observation result envelope carries
    //     prompt_leak_in_observation rejection shape.
    const obsBody = bodies.find((b) => b.includes('prompt_leak_in_observation'));
    expect(obsBody).toBeDefined();
    const parsed = JSON.parse(obsBody);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('prompt_leak_in_observation');
    expect(parsed.error?.fields).toContain('text');

    // (4) prompt_leak_blocked log row present, no substring of leak.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('record_observation');
    expect(Array.isArray(blocked[1].fields)).toBe(true);
    expect(blocked[1].fields).toContain('text');
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson.toLowerCase()).not.toContain('eicr inspection assistant');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — rename_circuit leak through real runToolLoop
// ---------------------------------------------------------------------------

describe('r20-#4 end-to-end — rename_circuit leak blocked via real runToolLoop', () => {
  test('model emits rename_circuit with leak in .designation → rejected, circuit untouched', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const perTurnWrites = createPerTurnWrites();

    const originalDesignation = session.stateSnapshot.circuits[1].designation;
    const leakDesignation = 'STQ-01 upstairs lights with extra content';

    const mockAnthropic = mockClient([
      toolUseRound([
        {
          id: 'toolu_e2e_rename_leak',
          name: 'rename_circuit',
          input: {
            from_ref: 1,
            circuit_ref: 1,
            designation: leakDesignation,
            phase: null,
            rating_amps: null,
            cable_csa_mm2: null,
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
    const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
    const dispatcher = createToolDispatcher(writes, asks);
    const sortRecords = createSortRecordsAsksLast();

    const out = await runToolLoop({
      client: mockAnthropic,
      model: 'test-model',
      system: 'TEST',
      messages: [{ role: 'user', content: 'rename circuit 1' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'sess-e2e-leak', turnId: 'turn-1' },
      logger,
      sortRecords,
    });

    expect(out.stop_reason).toBe('end_turn');

    // (1) Circuit 1 designation UNCHANGED.
    expect(session.stateSnapshot.circuits[1].designation).toBe(originalDesignation);
    expect(perTurnWrites.circuitOps).toHaveLength(0);

    // (2) Tool-result bodies never contain the leak designation.
    const bodies = collectAllToolResultJsonBodies(out.messages_final);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).not.toContain('STQ-01');
      expect(body).not.toContain('upstairs lights with extra');
    }

    // (3) Envelope body carries prompt_leak_in_designation code.
    const rn = bodies.find((b) => b.includes('prompt_leak_in_designation'));
    expect(rn).toBeDefined();
    const parsed = JSON.parse(rn);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('prompt_leak_in_designation');

    // (4) prompt_leak_blocked log row has redacted shape.
    const blocked = logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blocked).toBeDefined();
    expect(blocked[1].tool).toBe('rename_circuit');
    expect(blocked[1].field).toBe('designation');
    expect(blocked[1].sanitised_sample).toBeUndefined();
    const blockedJson = JSON.stringify(blocked[1]);
    expect(blockedJson).not.toContain('STQ-01');
    expect(blockedJson).not.toContain('upstairs lights with extra');
  });
});
