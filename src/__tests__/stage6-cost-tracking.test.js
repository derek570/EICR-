/**
 * Stage 6 cost tracking — token usage flows from runToolLoop into the
 * session's CostTracker so cost_summary.json (and the optimiser pipeline
 * that reads it at scripts/analyze-session.js) populate the
 * sonnet.{turns, cacheReads, cacheWrites, input, output, cost} fields.
 *
 * WHY: pre-fix, the legacy off-mode `extract()` path called
 * costTracker.addSonnetUsage at eicr-extraction-session.js:1614, but the
 * Stage 6 multi-round tool loop never reached that code, so its API calls
 * were billed by Anthropic but invisible to dashboards (sonnet.turns=0,
 * cost=0). Field session 2D391936 (47 Ashcroft Road, 2026-04-28) showed
 * 8 server_extraction_received events landing on a $0-Sonnet cost summary.
 *
 * SCOPE:
 *   1. runToolLoop sums per-round usage from `assistantMsg.usage` into a
 *      Message.usage-shaped object on the return value.
 *   2. runToolLoop is defensive against missing usage fields and missing
 *      usage objects entirely (mock streams without usage events).
 *   3. runShadowHarness in `live` mode calls
 *      session.costTracker.addSonnetUsage(toolLoopOut.usage) once per loop
 *      run, and bumps session.extractedReadingsCount.
 *   4. runShadowHarness in `shadow` mode also calls addSonnetUsage (the
 *      shadow leg makes a real billable Anthropic call in parallel to
 *      legacy) but does NOT bump extractedReadingsCount (shadow readings
 *      never reach iOS — comparator returns legacy).
 */

import { jest } from '@jest/globals';

import { runToolLoop, NOOP_DISPATCHER } from '../extraction/stage6-tool-loop.js';
import { mockClient, mockStream } from './helpers/mockStream.js';
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
  test('addSonnetUsage called once with summed token usage', async () => {
    const session = makeLiveSession();
    const addSpy = jest.spyOn(session.costTracker, 'addSonnetUsage');

    await runShadowHarness(session, 'hello', [], { logger: makeLogger() });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith({
      input_tokens: 2000,
      output_tokens: 120,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 0,
    });

    // Confirm the cost tracker actually accepted the usage and flipped its
    // counters — this is what cost_summary.json reads via toSessionSummary.
    expect(session.costTracker.sonnet.turns).toBe(1);
    expect(session.costTracker.sonnet.inputTokens).toBe(2000);
    expect(session.costTracker.sonnet.outputTokens).toBe(120);
    expect(session.costTracker.sonnet.cacheWriteTokens).toBe(500);
    expect(session.costTracker.sonnetCost).toBeGreaterThan(0);
  });

  test('zero-usage extraction → addSonnetUsage NOT called (test-stability guard)', async () => {
    // Mock streams without usage events would otherwise increment turns
    // with all-zero deltas, polluting test fixtures that assert exact
    // turn counts. The wiring's all-zero short-circuit prevents that.
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
    const addSpy = jest.spyOn(session.costTracker, 'addSonnetUsage');

    await runShadowHarness(session, 'hello', [], { logger: makeLogger() });

    expect(addSpy).not.toHaveBeenCalled();
    expect(session.costTracker.sonnet.turns).toBe(0);
  });
});
