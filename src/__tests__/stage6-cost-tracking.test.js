/**
 * Stage 6 cost tracking — token usage flows from runToolLoop into the
 * session's CostTracker so cost_summary.json (and the optimiser pipeline
 * that reads it at scripts/analyze-session.js) populate the
 * sonnet.{turns, cacheReads, cacheWrites, input, output, cost} fields.
 *
 * SCOPE:
 *   1. runToolLoop retains per-round provider/model/tier provenance and
 *      also sums a compatibility Message.usage-shaped aggregate.
 *   2. runToolLoop is defensive against missing usage fields and missing
 *      usage objects entirely (mock streams without usage events).
 *   3. runShadowHarness brackets one billable scope around the whole live
 *      loop and ingests those rows exactly once before final decrement.
 *   4. Public inspector-turn identity remains separate from completed
 *      model rounds, including zero-token completed responses.
 */

import { jest } from '@jest/globals';

import { runToolLoop, NOOP_DISPATCHER } from '../extraction/stage6-tool-loop.js';
import { mockClient } from './helpers/mockStream.js';
import { TOOL_SCHEMAS } from '../extraction/stage6-tool-schemas.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { CostTracker } from '../extraction/cost-tracker.js';

// ---------------------------------------------------------------------------
// Event fixture builders — usage-bearing variants of the standard helpers
// from stage6-tool-loop.test.js. Anthropic streaming SDK contract:
//   message_start: usage = { input_tokens, cache_creation_input_tokens,
//                            cache_read_input_tokens, output_tokens: 0 }
//   message_delta: usage = { output_tokens: <cumulative> }
//   finalMessage: returns the post-assembly snapshot
// We mirror that contract so tests assert against the same shape the real
// SDK would produce.
// ---------------------------------------------------------------------------

function endTurnRoundWithUsage(text, usage) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_end',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
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
      usage: { output_tokens: usage.output_tokens ?? 0 },
    },
    { type: 'message_stop' },
  ];
}

function toolUseRoundWithUsage(toolCalls, usage) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_tu',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          output_tokens: 0,
        },
      },
    },
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
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: usage.output_tokens ?? 0 },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function baseCtx() {
  return { sessionId: 'sess-cost', turnId: 'sess-cost-turn-1' };
}

// ---------------------------------------------------------------------------
// Group 1 — runToolLoop usage accumulation
// ---------------------------------------------------------------------------

describe('runToolLoop — token usage accumulation', () => {
  test('single end_turn round → usage equals that round', async () => {
    const client = mockClient([
      endTurnRoundWithUsage('done', {
        input_tokens: 1200,
        output_tokens: 80,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 0,
      }),
    ]);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 80,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 0,
    });
  });

  test('multi-round tool_use → usage sums across rounds', async () => {
    const client = mockClient([
      toolUseRoundWithUsage([{ id: 'toolu_1', name: 'record_reading', input: { x: 1 } }], {
        input_tokens: 1000,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 0,
      }),
      toolUseRoundWithUsage([{ id: 'toolu_2', name: 'record_reading', input: { x: 2 } }], {
        input_tokens: 500,
        output_tokens: 60,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1100,
      }),
      endTurnRoundWithUsage('done', {
        input_tokens: 200,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500,
      }),
    ]);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.rounds).toBe(3);
    expect(result.usage).toEqual({
      input_tokens: 1700,
      output_tokens: 140,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 2600,
    });
  });

  test('mock without usage events → usage is zeroed (defensive default)', async () => {
    // Standard mock helpers from stage6-tool-loop.test.js don't carry usage.
    // The accumulator must treat that as zeros, not throw or return undefined,
    // so existing tests keep passing untouched.
    const eventsNoUsage = [
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const client = mockClient([eventsNoUsage]);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  test('partial usage (missing fields) → only present fields contribute', async () => {
    // SDK shape drift / partial-stream rounds may surface only some fields.
    // The accumulator must default missing fields to zero per round, not
    // poison the sum with NaN.
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'm',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 500 }, // intentionally missing the other 3
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 25 }, // only output, no cache fields
      },
      { type: 'message_stop' },
    ];
    const client = mockClient([events]);

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });

    expect(result.usage.input_tokens).toBe(500);
    expect(result.usage.output_tokens).toBe(25);
    expect(result.usage.cache_creation_input_tokens).toBe(0);
    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(Number.isFinite(result.usage.input_tokens)).toBe(true);
    expect(Number.isFinite(result.usage.output_tokens)).toBe(true);
  });

  test('two-round accounting scope stays 0→1→1→0 until caller ingestion completes', async () => {
    const tracker = new CostTracker();
    const delegate = mockClient([
      toolUseRoundWithUsage([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }], {
        input_tokens: 100,
        output_tokens: 10,
      }),
      endTurnRoundWithUsage('done', { input_tokens: 120, output_tokens: 5 }),
    ]);
    const counts = [tracker.inFlightBillableInvocationCount];
    const client = {
      messages: {
        stream(...args) {
          counts.push(tracker.inFlightBillableInvocationCount);
          return delegate.messages.stream(...args);
        },
      },
    };
    tracker.beginBillableInvocation('two-round');
    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      billingIdentity: 'two-round',
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOL_SCHEMAS,
      dispatcher: jest.fn(NOOP_DISPATCHER),
      ctx: baseCtx(),
      logger: makeLogger(),
    });
    counts.push(tracker.inFlightBillableInvocationCount);
    tracker.ingestBillableUsage('two-round', result.round_usage, 'inspector_live');
    counts.push(tracker.inFlightBillableInvocationCount);
    tracker.endBillableInvocation('two-round');
    counts.push(tracker.inFlightBillableInvocationCount);

    expect(counts).toEqual([0, 1, 1, 1, 1, 0]);
    expect(tracker.completedModelRounds).toBe(2);
  });

  test('later-round cancellation keeps scope live until attached billed usage is ingested', async () => {
    const tracker = new CostTracker();
    const controller = new AbortController();
    const client = mockClient([
      toolUseRoundWithUsage([{ id: 'toolu_1', name: 'record_reading', input: { field: 'x' } }], {
        input_tokens: 100,
        output_tokens: 10,
      }),
    ]);
    const counts = [tracker.inFlightBillableInvocationCount];
    tracker.beginBillableInvocation('cancelled-loop');
    counts.push(tracker.inFlightBillableInvocationCount);

    let failure;
    try {
      await runToolLoop({
        client,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        billingIdentity: 'cancelled-loop',
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOL_SCHEMAS,
        dispatcher: async (call) => {
          controller.abort();
          return NOOP_DISPATCHER(call);
        },
        ctx: baseCtx(),
        logger: makeLogger(),
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }
    counts.push(tracker.inFlightBillableInvocationCount);
    tracker.ingestBillableUsage(
      'cancelled-loop',
      failure.billableUsage.round_usage,
      'inspector_live'
    );
    counts.push(tracker.inFlightBillableInvocationCount);
    tracker.endBillableInvocation('cancelled-loop');
    counts.push(tracker.inFlightBillableInvocationCount);

    expect(failure.name).toBe('ExtractionCancelledError');
    expect(failure.billableUsage.completed_model_rounds).toBe(1);
    expect(counts).toEqual([0, 1, 1, 1, 0]);
    expect(tracker.completedModelRounds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — runShadowHarness LIVE mode wires usage to costTracker
// ---------------------------------------------------------------------------

function makeLiveSession() {
  return {
    sessionId: 'sess-live-cost',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST',
    client: mockClient([
      endTurnRoundWithUsage('done', {
        input_tokens: 2000,
        output_tokens: 120,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
      }),
    ]),
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

describe('runShadowHarness live mode — costTracker wiring', () => {
  test('records one inspector turn, one loop and one attributed model round', async () => {
    const session = makeLiveSession();

    await runShadowHarness(session, 'hello', [], { logger: makeLogger() });

    expect(session.costTracker.sonnet.turns).toBe(1);
    expect(session.costTracker.loopInvocations).toBe(1);
    expect(session.costTracker.completedModelRounds).toBe(1);
    expect(session.costTracker.inFlightBillableInvocationCount).toBe(0);
    expect(session.costTracker.roundUsageEvidence).toHaveLength(1);
    expect(session.costTracker.roundUsageEvidence[0]).toEqual(
      expect.objectContaining({
        kind: 'inspector_live',
        provider: 'anthropic',
        billing_model: expect.stringMatching(/^claude-/),
        fresh_input_tokens: 2000,
        cache_write_input_tokens: 500,
        output_tokens: 120,
      })
    );
    expect(session.costTracker.sonnet.inputTokens).toBe(2000);
    expect(session.costTracker.sonnet.outputTokens).toBe(120);
    expect(session.costTracker.sonnet.cacheWriteTokens).toBe(500);
    expect(session.costTracker.sonnetCost).toBeGreaterThan(0);
  });

  test('zero-token completed response still records the accepted turn/loop/round', async () => {
    const session = makeLiveSession();
    session.client = mockClient([
      // no usage — shape matches the old endTurnRound helper from
      // stage6-tool-loop.test.js, which is what every pre-existing
      // shadow-harness test uses.
      [
        { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ],
    ]);
    await runShadowHarness(session, 'hello', [], { logger: makeLogger() });

    expect(session.costTracker.sonnet.turns).toBe(1);
    expect(session.costTracker.loopInvocations).toBe(1);
    expect(session.costTracker.completedModelRounds).toBe(1);
    expect(session.costTracker.sonnetCost).toBe(0);
    expect(session.costTracker.inFlightBillableInvocationCount).toBe(0);
  });
});
