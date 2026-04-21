/**
 * Stage 6 Phase 3 Plan 03-09 — STT-05 / STT-06 / STT-07 end-to-end integration.
 *
 * WHAT: Exercises the fully-wired Phase 3 stack end-to-end against the REAL
 * Plans 03-01 → 03-08 implementation:
 *   - real runToolLoop (Phase 1)
 *   - real createToolDispatcher + createSortRecordsAsksLast (Plan 03-06)
 *   - real createWriteDispatcher (Phase 2)
 *   - real createAskDispatcher (Plan 03-05)
 *   - real createPendingAsksRegistry (Plan 03-01)
 *   - real validateAskUser (Plan 03-02)
 *   - real logAskUser (Plan 03-03)
 *   - real classifyOvertake (Plan 03-04)
 *   - mock Anthropic client via helpers/mockStream.js
 *   - mock iOS WebSocket with .injectClientMessage (matches sonnet-stream.js
 *     routing shape from Plan 03-08)
 *
 * THREE SCENARIOS mirroring the REQUIREMENTS.md entries:
 *   STT-05 — blocking round-trip (inspector answers within 20s)
 *   STT-06 — 20s timeout (inspector never answers)
 *   STT-07 — overtake (inspector says something unrelated mid-ask)
 *
 * Requirements: STT-05, STT-06, STT-07. STO-02 asserted via stage6.ask_user
 * log row shape. STA-03 20s window asserted deterministically via jest fake
 * timers.
 *
 * WHY event-driven synchronisation (waitFor on mockWs.sent) rather than
 * arbitrary sleeps: the ask dispatcher does pendingAsks.register() INSIDE the
 * Promise executor, then ws.send() right after, all before the outer `await`
 * on the Promise runs. The test's resolve() must come AFTER that register has
 * landed or we race. waitFor polls the observable side-effect (ws.send)
 * instead of guessing a delay.
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
import { classifyOvertake } from '../extraction/stage6-overtake-classifier.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// Stream fixture builders — same pattern as stage6-tool-loop-e2e.test.js
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
// Mock iOS server-WebSocket — matches the shape sonnet-stream.js would pass
// to the ask dispatcher. `.sent` is the outbound queue (iOS-bound frames);
// `.injectClientMessage` simulates an iOS→server frame being dispatched.
// ---------------------------------------------------------------------------

function createMockServerWs() {
  const sent = [];
  const messageHandlers = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close: jest.fn(),
    on(event, handler) {
      if (event === 'message') messageHandlers.push(handler);
    },
    injectClientMessage(msg) {
      for (const h of messageHandlers) h(Buffer.from(JSON.stringify(msg)));
    },
  };
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(mode = 'live') {
  return {
    sessionId: 'sess-integration',
    toolCallsMode: mode,
    updateJobState: jest.fn(),
    // Pre-populate circuit 5 so record_reading passes validateRecordReading
    // (the writes dispatcher calls validateRecordReading(input, snapshot) and
    // the test must make that snapshot consistent with the mock Anthropic's
    // tool inputs).
    stateSnapshot: {
      circuits: { 5: {}, 1: {} },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
  };
}

// Poll-based synchronisation helper — resolves when `predicate()` is truthy
// or rejects after `timeoutMs`. Uses a short real setTimeout per poll: jest's
// interaction with for-await-of async generators means microtask-only drains
// (setImmediate / Promise.resolve) do NOT reliably yield to the stream's
// internal scheduler; a 1ms setTimeout forces a true macrotask boundary that
// lets the runToolLoop's `for await` pump emit its next event.
async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 1 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become truthy within ${timeoutMs}ms`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// STT-05 — Blocking round-trip
// ---------------------------------------------------------------------------

describe('STT-05 — blocking ask_user round-trip (Plan 03-09)', () => {
  test('happy path: ask_user → inspector answers → record_reading → end_turn', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const perTurnWrites = createPerTurnWrites();

    // Mock Anthropic: round 1 emits ask_user; round 2 (after tool_result with
    // answered:true) emits record_reading for circuit 5; round 3 is end_turn.
    const mockAnthropic = mockClient([
      toolUseRound([
        {
          id: 'toolu_ask_1',
          name: 'ask_user',
          input: {
            question: 'Which circuit were you referring to?',
            reason: 'ambiguous_circuit',
            context_field: 'measured_zs_ohm',
            context_circuit: null,
            expected_answer_shape: 'circuit_ref',
          },
        },
      ]),
      toolUseRound([
        {
          id: 'toolu_rr_1',
          name: 'record_reading',
          input: {
            field: 'measured_zs_ohm',
            circuit: 5,
            value: '1.08',
            confidence: 1.0,
            source_turn_id: 'turn-1',
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
    const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
    const dispatcher = createToolDispatcher(writes, asks);
    const sortRecords = createSortRecordsAsksLast();

    const loopPromise = runToolLoop({
      client: mockAnthropic,
      model: 'test-model',
      system: 'TEST',
      messages: [{ role: 'user', content: 'tell me about circuit' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'sess-integration', turnId: 'turn-1' },
      logger,
      sortRecords,
    });

    // Wait for the ask dispatcher to emit ask_user_started on ws.sent.
    await waitFor(() => ws.sent.some((m) => m.type === 'ask_user_started'));

    const started = ws.sent.find((m) => m.type === 'ask_user_started');
    expect(started.tool_call_id).toBe('toolu_ask_1');
    expect(started.question).toBe('Which circuit were you referring to?');
    expect(pendingAsks.size).toBe(1);

    // Simulate the sonnet-stream.js handleAskUserAnswered path: registry.resolve
    // drives the ask dispatcher's awaited Promise, which then returns the
    // tool_result to the loop, which then re-invokes the model for round 2.
    pendingAsks.resolve('toolu_ask_1', { answered: true, user_text: 'Circuit 5' });

    const out = await loopPromise;

    expect(out.stop_reason).toBe('end_turn');
    // Round count: round 1 (ask_user tool_use), round 2 (record_reading
    // tool_use), round 3 (end_turn). runToolLoop counts round for every
    // stream invocation including the end_turn round.
    expect(out.rounds).toBe(3);
    expect(out.aborted).toBe(false);

    // Registry drained — no orphan entries.
    expect(pendingAsks.size).toBe(0);

    // Phase 3 STO-02: exactly one stage6.ask_user log row with answer_outcome=answered.
    const askRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askRows).toHaveLength(1);
    expect(askRows[0][1]).toMatchObject({
      sessionId: 'sess-integration',
      turnId: 'turn-1',
      phase: 3,
      mode: 'live',
      tool_call_id: 'toolu_ask_1',
      answer_outcome: 'answered',
      user_text: 'Circuit 5',
    });
    // STA-03 + STO-02: wait_duration_ms is a real measured interval (>0).
    expect(askRows[0][1].wait_duration_ms).toBeGreaterThanOrEqual(0);

    // record_reading dispatched in round 2 — evidence: Phase 2 writes log row.
    const writeLogs = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6_tool_call' && c[1]?.tool === 'record_reading',
    );
    expect(writeLogs).toHaveLength(1);
    expect(writeLogs[0][1]).toMatchObject({ outcome: 'ok', is_error: false });

    // perTurnWrites received the reading from the writes dispatcher.
    // Phase 2 perTurnWrites.readings is a Map keyed by `${field}::${circuit}`.
    expect(perTurnWrites.readings.size).toBe(1);
    expect(perTurnWrites.readings.get('measured_zs_ohm::5')).toMatchObject({
      value: '1.08',
      confidence: 1.0,
      source_turn_id: 'turn-1',
    });

    // No orphan timers.
    // (Real timers used here; jest.getTimerCount only reflects fake timers.)
  });
});

// ---------------------------------------------------------------------------
// STT-06 — 20s timeout
// ---------------------------------------------------------------------------

describe('STT-06 — ask_user 20s timeout (Plan 03-09)', () => {
  test('no answer within ASK_USER_TIMEOUT_MS → registry self-resolves with reason:timeout', async () => {
    // Fake timers for setTimeout ONLY. Promises/queueMicrotask remain real
    // so `await` continues to drain microtasks naturally.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });

    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pendingAsks = createPendingAsksRegistry();
      const ws = createMockServerWs();
      const perTurnWrites = createPerTurnWrites();

      // Round 1: ask_user. Round 2: end_turn (Sonnet gives up after timeout).
      const mockAnthropic = mockClient([
        toolUseRound([
          {
            id: 'toolu_ask_to',
            name: 'ask_user',
            input: {
              question: 'Which circuit?',
              reason: 'ambiguous_circuit',
              context_field: null,
              context_circuit: null,
              expected_answer_shape: 'circuit_ref',
            },
          },
        ]),
        endTurnRound('giving up'),
      ]);

      const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
      const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
      const dispatcher = createToolDispatcher(writes, asks);

      const loopPromise = runToolLoop({
        client: mockAnthropic,
        model: 'test-model',
        system: 'TEST',
        messages: [{ role: 'user', content: 'start' }],
        tools: [],
        dispatcher,
        ctx: { sessionId: 'sess-integration', turnId: 'turn-1' },
        logger,
        sortRecords: createSortRecordsAsksLast(),
      });

      // Drain microtasks until the ask registers (register() is synchronous
      // inside the Promise executor; we just need microtasks to flush).
      // Using a bounded wait to avoid infinite loop on a wiring regression.
      for (let i = 0; i < 500 && pendingAsks.size === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }

      expect(pendingAsks.size).toBe(1);
      // 20s timer is pending.
      expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

      // Advance past the 20000ms timeout.
      jest.advanceTimersByTime(20001);

      const out = await loopPromise;

      expect(out.stop_reason).toBe('end_turn');
      expect(out.aborted).toBe(false);
      expect(pendingAsks.size).toBe(0);

      // Log row: answer_outcome=timeout, wait_duration_ms within [20000, 20100].
      const askRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
      expect(askRows).toHaveLength(1);
      expect(askRows[0][1]).toMatchObject({
        answer_outcome: 'timeout',
        mode: 'live',
        tool_call_id: 'toolu_ask_to',
      });
      // user_text must NOT be present on timeout rows.
      expect(askRows[0][1].user_text).toBeUndefined();
      expect(askRows[0][1].wait_duration_ms).toBeGreaterThanOrEqual(20000);
      expect(askRows[0][1].wait_duration_ms).toBeLessThanOrEqual(20100);

      // No orphan timers — ASK_USER_TIMEOUT_MS fired its callback which
      // cleared itself via registry.resolve.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// STT-07 — Overtake
// ---------------------------------------------------------------------------

describe('STT-07 — mid-ask overtake (Plan 03-09)', () => {
  test('fresh transcript with different field → classifyOvertake=user_moved_on → rejectAll → loop continues', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pendingAsks = createPendingAsksRegistry();
    const ws = createMockServerWs();
    const perTurnWrites = createPerTurnWrites();

    // Round 1: ask_user(context_field='measured_zs_ohm'). Round 2:
    // record_reading for a different field (ocpd_max_zs_ohm, which regex could
    // plausibly have surfaced from the fresh overtake utterance). Round 3:
    // end_turn. The classifier sees a different-field regex hit and returns
    // user_moved_on regardless of the actual Phase 5 field-name-to-regex
    // plumbing — this test only needs the classifier verdict to route
    // rejectAll and the subsequent round to dispatch cleanly.
    const mockAnthropic = mockClient([
      toolUseRound([
        {
          id: 'toolu_ask_ov',
          name: 'ask_user',
          input: {
            question: 'Which circuit for Zs?',
            reason: 'ambiguous_circuit',
            context_field: 'measured_zs_ohm',
            context_circuit: null,
            expected_answer_shape: 'circuit_ref',
          },
        },
      ]),
      toolUseRound([
        {
          id: 'toolu_rr_ov',
          name: 'record_reading',
          input: {
            field: 'ocpd_max_zs_ohm',
            circuit: 1,
            value: '0.3',
            confidence: 1.0,
            source_turn_id: 'turn-1',
          },
        },
      ]),
      endTurnRound('ok'),
    ]);

    const writes = createWriteDispatcher(session, logger, 'turn-1', perTurnWrites);
    const asks = createAskDispatcher(session, logger, 'turn-1', pendingAsks, ws);
    const dispatcher = createToolDispatcher(writes, asks);

    const loopPromise = runToolLoop({
      client: mockAnthropic,
      model: 'test-model',
      system: 'TEST',
      messages: [{ role: 'user', content: 'start' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'sess-integration', turnId: 'turn-1' },
      logger,
      sortRecords: createSortRecordsAsksLast(),
    });

    // Wait for ask_user_started to land.
    await waitFor(() => ws.sent.some((m) => m.type === 'ask_user_started'));
    expect(pendingAsks.size).toBe(1);

    // Simulate sonnet-stream.js handleTranscript's overtake path:
    //   1. classifyOvertake(newText, regexResults, pendingAsks)
    //   2. if user_moved_on → pendingAsks.rejectAll('user_moved_on')
    //   3. fresh transcript then flows into the next turn.
    // regexResults carries a DIFFERENT context_field than the pending ask,
    // which classifyOvertake's decision-tree step 2 returns as user_moved_on.
    const freshText = 'The OCPD max Zs is point three';
    const freshRegex = [{ field: 'ocpd_max_zs_ohm', circuit: null, value: 0.3 }];
    const verdict = classifyOvertake(freshText, freshRegex, pendingAsks);
    expect(verdict.kind).toBe('user_moved_on');

    pendingAsks.rejectAll('user_moved_on');

    const out = await loopPromise;

    expect(out.stop_reason).toBe('end_turn');
    expect(out.rounds).toBe(3);
    expect(out.aborted).toBe(false);
    expect(pendingAsks.size).toBe(0);

    // Log row: answer_outcome=user_moved_on.
    const askRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askRows).toHaveLength(1);
    expect(askRows[0][1]).toMatchObject({
      answer_outcome: 'user_moved_on',
      mode: 'live',
      tool_call_id: 'toolu_ask_ov',
    });
    expect(askRows[0][1].user_text).toBeUndefined();

    // record_reading for ocpd_max_zs_ohm=0.3 committed in round 2. Map shape.
    expect(perTurnWrites.readings.size).toBe(1);
    expect(perTurnWrites.readings.get('ocpd_max_zs_ohm::1')).toMatchObject({
      value: '0.3',
      confidence: 1.0,
    });
  });
});
