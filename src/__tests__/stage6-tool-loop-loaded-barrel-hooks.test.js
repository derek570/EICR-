/**
 * Loaded Barrel Phase 2.C — onSnapshotPatch + onLoopComplete hook tests
 * for runToolLoop (stage6-tool-loop.js).
 *
 * The hooks are additive opts. When NOT provided, behaviour is byte-
 * identical to pre-Phase-2 runToolLoop — verified by the existing
 * stage6-tool-loop.test.js suite. This file pins the NEW behaviour:
 * hooks fire on every state mutation, with correct patch shape, and
 * a throw in either hook doesn't break the dispatch loop.
 */

import { jest } from '@jest/globals';
import { runToolLoop, _loadedBarrelInternals } from '../extraction/stage6-tool-loop.js';
import {
  createPerTurnWrites,
  encodeReadingKey,
  encodeBoardReadingKey,
} from '../extraction/stage6-per-turn-writes.js';

const { captureSnapshot, diffSnapshot, patchHasChanges } = _loadedBarrelInternals;

// ---------------------------------------------------------------------------
// Diff helper unit tests (no runToolLoop involvement)
// ---------------------------------------------------------------------------

describe('captureSnapshot + diffSnapshot — direct', () => {
  test('empty → empty: no changes', () => {
    const w = createPerTurnWrites();
    const before = captureSnapshot(w);
    const patch = diffSnapshot(before, w);
    expect(patchHasChanges(patch)).toBe(false);
    expect(patch.readings.added).toEqual([]);
    expect(patch.boardReadings.added).toEqual([]);
    expect(patch.boardOps).toEqual([]);
  });

  test('detects added reading', () => {
    const w = createPerTurnWrites();
    const before = captureSnapshot(w);
    w.readings.set(encodeReadingKey('measured_zs_ohm', 1, null), {
      value: '0.5',
      confidence: 1.0,
      source_turn_id: 't1',
    });
    const patch = diffSnapshot(before, w);
    expect(patch.readings.added).toHaveLength(1);
    expect(patch.readings.added[0].value.value).toBe('0.5');
    expect(patch.readings.overwritten).toEqual([]);
    expect(patch.readings.removed).toEqual([]);
  });

  test('detects overwritten reading (same key, new value object)', () => {
    const w = createPerTurnWrites();
    const key = encodeReadingKey('measured_zs_ohm', 1, null);
    w.readings.set(key, { value: '0.5', confidence: 1.0 });
    const before = captureSnapshot(w);
    w.readings.set(key, { value: '0.6', confidence: 1.0 });
    const patch = diffSnapshot(before, w);
    expect(patch.readings.added).toEqual([]);
    expect(patch.readings.overwritten).toHaveLength(1);
    expect(patch.readings.overwritten[0].before.value).toBe('0.5');
    expect(patch.readings.overwritten[0].after.value).toBe('0.6');
  });

  test('detects removed reading (clear_reading path)', () => {
    const w = createPerTurnWrites();
    const key = encodeReadingKey('measured_zs_ohm', 1, null);
    w.readings.set(key, { value: '0.5', confidence: 1.0 });
    const before = captureSnapshot(w);
    w.readings.delete(key);
    const patch = diffSnapshot(before, w);
    expect(patch.readings.removed).toHaveLength(1);
    expect(patch.readings.removed[0].before.value).toBe('0.5');
  });

  test('detects boardReadings added + overwritten + removed', () => {
    const w = createPerTurnWrites();
    const key = encodeBoardReadingKey('earth_loop_impedance_ze', null);
    w.boardReadings.set(key, { value: '0.19', confidence: 1.0 });
    const beforeOverwrite = captureSnapshot(w);
    w.boardReadings.set(key, { value: '0.20', confidence: 1.0 });
    const patch1 = diffSnapshot(beforeOverwrite, w);
    expect(patch1.boardReadings.overwritten).toHaveLength(1);

    const beforeDelete = captureSnapshot(w);
    w.boardReadings.delete(key);
    const patch2 = diffSnapshot(beforeDelete, w);
    expect(patch2.boardReadings.removed).toHaveLength(1);
  });

  test('detects appended boardOps', () => {
    const w = createPerTurnWrites();
    const before = captureSnapshot(w);
    w.boardOps.push({ op: 'add_board', board_id: 'B1', designation: 'Sub-1' });
    w.boardOps.push({ op: 'select_board', board_id: 'B1' });
    const patch = diffSnapshot(before, w);
    expect(patch.boardOps).toHaveLength(2);
    expect(patch.boardOps[0].op).toBe('add_board');
    expect(patch.boardOps[1].op).toBe('select_board');
  });

  test('detects appended cleared / observations / circuitOps / fieldCorrections', () => {
    const w = createPerTurnWrites();
    const before = captureSnapshot(w);
    w.cleared.push({ field: 'F', circuit: 1, reason: 'clear_reading' });
    w.observations.push({ id: 'o1', text: 'note', code: 'C1' });
    w.circuitOps.push({ op: 'create', circuit_ref: 'new' });
    w.fieldCorrections.push({
      field: 'F',
      circuit: 1,
      previous_value: '0.5',
      reason: 'replace_value',
    });
    const patch = diffSnapshot(before, w);
    expect(patch.cleared).toHaveLength(1);
    expect(patch.observations).toHaveLength(1);
    expect(patch.circuitOps).toHaveLength(1);
    expect(patch.fieldCorrections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: runToolLoop wires the hooks correctly
// ---------------------------------------------------------------------------

// Mock Anthropic client that drives a TWO-round loop:
//   - round 1: stop_reason='tool_use' with N tool_use blocks (these get
//              dispatched + state-mutated)
//   - round 2: stop_reason='end_turn' with no tool_use (loop exits)
// Matches the assembler's expected streaming event shape.
function makeTwoRoundClient({ toolCalls, finalUsage = null }) {
  const usage = finalUsage || {
    input_tokens: 10,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let callCount = 0;

  function buildToolUseStream() {
    const events = [];
    events.push({ type: 'message_start', message: { usage } });
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
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
    }
    events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    events.push({ type: 'message_stop' });
    const assistantMsg = {
      id: 'msg_r1',
      content: toolCalls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
      usage,
    };
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const ev of events) yield ev;
      },
      finalMessage: async () => assistantMsg,
    };
  }

  function buildEndTurnStream() {
    const events = [
      { type: 'message_start', message: { usage } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const assistantMsg = { id: 'msg_r2', content: [], usage };
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const ev of events) yield ev;
      },
      finalMessage: async () => assistantMsg,
    };
  }

  return {
    messages: {
      stream(_opts) {
        callCount += 1;
        return callCount === 1 ? buildToolUseStream() : buildEndTurnStream();
      },
    },
  };
}

describe('runToolLoop + onSnapshotPatch — integration', () => {
  test('hook fires once per dispatched tool_use when state mutates', async () => {
    const writes = createPerTurnWrites();
    const dispatchedCalls = [];
    const dispatcher = jest.fn(async (call, _ctx) => {
      dispatchedCalls.push(call);
      // Mutate the accumulator like the real dispatcher would.
      const key = encodeReadingKey(call.input.field, call.input.circuit, null);
      writes.readings.set(key, {
        value: call.input.value,
        confidence: 1.0,
        source_turn_id: 't1',
      });
      return {
        tool_use_id: call.tool_call_id,
        content: JSON.stringify({ ok: true }),
        is_error: false,
      };
    });

    const patches = [];
    const onSnapshotPatch = jest.fn((evt) => patches.push(evt));

    const client = makeTwoRoundClient({
      toolCalls: [
        {
          id: 't1_a',
          name: 'record_reading',
          input: { field: 'measured_zs_ohm', circuit: 1, value: '0.5' },
        },
        {
          id: 't1_b',
          name: 'record_reading',
          input: { field: 'r1_r2_ohm', circuit: 2, value: '0.6' },
        },
      ],
    });

    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      perTurnWritesRef: () => writes,
      onSnapshotPatch,
    });

    expect(dispatcher).toHaveBeenCalledTimes(2);
    expect(onSnapshotPatch).toHaveBeenCalledTimes(2);
    expect(patches[0].patch.readings.added).toHaveLength(1);
    expect(patches[0].patch.readings.added[0].value.value).toBe('0.5');
    expect(patches[0].ctx.toolName).toBe('record_reading');
    expect(patches[0].ctx.sessionId).toBe('S');
    expect(patches[0].ctx.turnId).toBe('T');
    expect(patches[0].ctx.roundIdx).toBe(1);
    expect(patches[1].patch.readings.added[0].value.value).toBe('0.6');
  });

  test('hook does NOT fire when dispatcher returns without mutating state', async () => {
    const writes = createPerTurnWrites();
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: JSON.stringify({ ok: true }),
      is_error: false,
    }));
    const onSnapshotPatch = jest.fn();

    const client = makeTwoRoundClient({
      toolCalls: [{ id: 't1', name: 'noop_tool', input: { x: 1 } }],
    });

    await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      perTurnWritesRef: () => writes,
      onSnapshotPatch,
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(onSnapshotPatch).toHaveBeenCalledTimes(0);
  });

  test('hook throw is caught + does NOT break the loop', async () => {
    const writes = createPerTurnWrites();
    const dispatcher = jest.fn(async (call) => {
      const key = encodeReadingKey(call.input.field, call.input.circuit, null);
      writes.readings.set(key, { value: call.input.value, confidence: 1.0 });
      return {
        tool_use_id: call.tool_call_id,
        content: JSON.stringify({ ok: true }),
        is_error: false,
      };
    });
    const onSnapshotPatch = jest.fn(() => {
      throw new Error('speculator boom');
    });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const client = makeTwoRoundClient({
      toolCalls: [
        { id: 't1', name: 'record_reading', input: { field: 'F', circuit: 1, value: '0.5' } },
      ],
    });

    const out = await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      logger,
      perTurnWritesRef: () => writes,
      onSnapshotPatch,
    });

    expect(out.aborted).toBe(false);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(onSnapshotPatch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'stage6.snapshot_patch_hook_error',
      expect.objectContaining({ error: 'speculator boom' })
    );
  });

  test('hook does NOT fire when perTurnWritesRef is missing (defensive)', async () => {
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: JSON.stringify({ ok: true }),
      is_error: false,
    }));
    const onSnapshotPatch = jest.fn();
    const client = makeTwoRoundClient({
      toolCalls: [{ id: 't1', name: 'X', input: {} }],
    });

    await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      onSnapshotPatch, // NO perTurnWritesRef
    });

    expect(onSnapshotPatch).toHaveBeenCalledTimes(0);
  });
});

describe('runToolLoop + onLoopComplete — integration', () => {
  test('fires once on end_turn with perTurnWrites + tool_calls + usage', async () => {
    const writes = createPerTurnWrites();
    const dispatcher = jest.fn(async (call) => {
      const key = encodeReadingKey(call.input.field, call.input.circuit, null);
      writes.readings.set(key, { value: call.input.value, confidence: 1.0 });
      return {
        tool_use_id: call.tool_call_id,
        content: JSON.stringify({ ok: true }),
        is_error: false,
      };
    });
    const onLoopComplete = jest.fn();

    const client = makeTwoRoundClient({
      toolCalls: [
        { id: 't1', name: 'record_reading', input: { field: 'F', circuit: 1, value: '0.5' } },
      ],
    });

    await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      perTurnWritesRef: () => writes,
      onLoopComplete,
    });

    expect(onLoopComplete).toHaveBeenCalledTimes(1);
    const evt = onLoopComplete.mock.calls[0][0];
    expect(evt.perTurnWrites).toBe(writes);
    expect(evt.tool_calls).toHaveLength(1);
    // Two rounds: round 1 = tool_use, round 2 = end_turn (mock contract).
    expect(evt.rounds).toBe(2);
    expect(evt.stop_reason).toBe('end_turn');
    expect(evt.aborted).toBe(false);
    // usage sums across BOTH rounds (the mock's per-round usage is 10/10).
    expect(evt.usage.input_tokens).toBe(20);
  });

  test('fires with perTurnWrites=null when perTurnWritesRef omitted', async () => {
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: JSON.stringify({ ok: true }),
      is_error: false,
    }));
    const onLoopComplete = jest.fn();
    const client = makeTwoRoundClient({
      toolCalls: [{ id: 't1', name: 'X', input: {} }],
    });

    await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      onLoopComplete,
    });

    expect(onLoopComplete).toHaveBeenCalledTimes(1);
    expect(onLoopComplete.mock.calls[0][0].perTurnWrites).toBe(null);
  });

  test('hook throw is caught + does NOT affect return value', async () => {
    const dispatcher = jest.fn(async (call) => ({
      tool_use_id: call.tool_call_id,
      content: JSON.stringify({ ok: true }),
      is_error: false,
    }));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const onLoopComplete = jest.fn(() => {
      throw new Error('drift detector blew up');
    });
    const client = makeTwoRoundClient({
      toolCalls: [{ id: 't1', name: 'X', input: {} }],
    });

    const out = await runToolLoop({
      client,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 'S', turnId: 'T' },
      logger,
      onLoopComplete,
    });

    expect(out.stop_reason).toBe('end_turn');
    expect(logger.error).toHaveBeenCalledWith(
      'stage6.loop_complete_hook_error',
      expect.objectContaining({ error: 'drift detector blew up' })
    );
  });
});
