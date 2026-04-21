/**
 * Stage 6 Phase 3 Plan 03-06 — Tool-dispatcher composer + sortRecords sorter tests.
 *
 * WHAT: Locks the Phase 3 composition layer for runToolLoop's single
 * `(call, ctx) => Promise<ToolResult>` contract:
 *   - `createToolDispatcher(writes, asks)` delegates by `call.name`:
 *       * names in Phase 2 WRITE_DISPATCHERS → `writes`
 *       * `'ask_user'`                        → `asks`
 *       * unknown name                        → synthetic is_error:true tool_result
 *   - `createSortRecordsAsksLast()` returns a pure partitioner that moves
 *     every `ask_user` record to the END of the array while preserving
 *     stream-emission (index-ascending) order within each partition.
 *
 * WHY this file is NEW (plan 03-06 asked to extend an existing
 * stage6-dispatchers.test.js, which does not exist — the Phase 2 barrel
 * coverage lives in stage6-dispatcher-scaffold.test.js / -barrel.test.js /
 * -logging.test.js, each owning one surface. This new file owns the Phase 3
 * composer surface so future maintainers can grep by filename → surface.
 *
 * WHY WRITE_TOOL_NAMES is sourced from `Object.keys(WRITE_DISPATCHERS)`
 * at test time: the plan literal listed six names (mark_circuit_complete,
 * mark_turn_complete, log_ambiguity, defer_decision, record_reading,
 * record_observation) that do not match the six names Phase 2 shipped
 * (clear_reading, create_circuit, delete_observation, record_observation,
 * record_reading, rename_circuit). The invariant the composer actually
 * enforces is "any name in the Phase 2 dispatch table delegates to writes"
 * — so the tests derive the truth from WRITE_DISPATCHERS, not from the
 * plan's enumerated list. If a future phase adds a seventh write tool,
 * these tests continue to pass without edit.
 */

import { jest } from '@jest/globals';
import {
  WRITE_DISPATCHERS,
  createToolDispatcher,
  createSortRecordsAsksLast,
} from '../extraction/stage6-dispatchers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWriteSpy() {
  return jest.fn(async (call /* , ctx */) => ({
    tool_use_id: call.tool_call_id ?? call.id,
    content: JSON.stringify({ ok: true, from: 'writes', name: call.name }),
    is_error: false,
  }));
}

function makeAskSpy() {
  return jest.fn(async (call /* , ctx */) => ({
    tool_use_id: call.tool_call_id ?? call.id,
    content: JSON.stringify({ answered: false, reason: 'shadow_mode' }),
    is_error: false,
  }));
}

// ---------------------------------------------------------------------------
// createToolDispatcher — composition by call.name
// ---------------------------------------------------------------------------

describe('createToolDispatcher composition', () => {
  const WRITE_NAMES = Object.keys(WRITE_DISPATCHERS);

  for (const name of WRITE_NAMES) {
    test(`delegates '${name}' → writes dispatcher (NOT asks)`, async () => {
      const writes = makeWriteSpy();
      const asks = makeAskSpy();
      const dispatch = createToolDispatcher(writes, asks);

      const call = { tool_call_id: `toolu_${name}`, id: `toolu_${name}`, name, input: {} };
      const ctx = { sessionId: 's', turnId: 't' };
      const res = await dispatch(call, ctx);

      expect(writes).toHaveBeenCalledTimes(1);
      expect(asks).not.toHaveBeenCalled();
      expect(writes.mock.calls[0][0]).toBe(call); // call passed through unchanged
      expect(writes.mock.calls[0][1]).toBe(ctx); // ctx passed through unchanged
      // Composer returns whatever the selected dispatcher returns, verbatim.
      expect(res).toEqual({
        tool_use_id: `toolu_${name}`,
        content: JSON.stringify({ ok: true, from: 'writes', name }),
        is_error: false,
      });
    });
  }

  test("delegates 'ask_user' → asks dispatcher (NOT writes)", async () => {
    const writes = makeWriteSpy();
    const asks = makeAskSpy();
    const dispatch = createToolDispatcher(writes, asks);

    const call = { tool_call_id: 'toolu_ask', id: 'toolu_ask', name: 'ask_user', input: { question: 'q' } };
    const ctx = { sessionId: 's', turnId: 't' };
    const res = await dispatch(call, ctx);

    expect(asks).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(asks.mock.calls[0][0]).toBe(call);
    expect(asks.mock.calls[0][1]).toBe(ctx);
    expect(res.tool_use_id).toBe('toolu_ask');
    expect(res.is_error).toBe(false);
  });

  test("unknown name 'mystery_tool' → is_error:true envelope with 'unknown_tool' code, neither spy invoked", async () => {
    const writes = makeWriteSpy();
    const asks = makeAskSpy();
    const dispatch = createToolDispatcher(writes, asks);

    const res = await dispatch(
      { tool_call_id: 'toolu_x', id: 'toolu_x', name: 'mystery_tool', input: {} },
      { sessionId: 's', turnId: 't' },
    );

    expect(writes).not.toHaveBeenCalled();
    expect(asks).not.toHaveBeenCalled();
    expect(res.is_error).toBe(true);
    expect(res.tool_use_id).toBe('toolu_x');
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe('unknown_tool');
    expect(parsed.name).toBe('mystery_tool');
  });

  test('unknown name with missing call.id → tool_use_id is undefined but envelope still shaped', async () => {
    // Defensive: composer does not fabricate ids — it surfaces whatever the
    // caller gave it. Keeps the single source-of-truth invariant (runToolLoop
    // owns id threading) from bleeding into the composer.
    const dispatch = createToolDispatcher(makeWriteSpy(), makeAskSpy());
    const res = await dispatch({ name: 'mystery_tool', input: {} }, {});
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content)).toMatchObject({ error: 'unknown_tool', name: 'mystery_tool' });
  });

  test('preserves tool_use_id / content / is_error from selected dispatcher verbatim', async () => {
    const writes = jest.fn(async () => ({
      tool_use_id: 'echoed_from_dispatcher',
      content: '{"foo":"bar"}',
      is_error: true,
    }));
    const asks = makeAskSpy();
    const dispatch = createToolDispatcher(writes, asks);

    const res = await dispatch(
      { tool_call_id: 'toolu_verbatim', name: 'record_reading', input: {} },
      {},
    );
    expect(res).toEqual({
      tool_use_id: 'echoed_from_dispatcher',
      content: '{"foo":"bar"}',
      is_error: true,
    });
  });
});

// ---------------------------------------------------------------------------
// createSortRecordsAsksLast — pure partitioner
// ---------------------------------------------------------------------------

describe('createSortRecordsAsksLast sorter', () => {
  function mkWrite(name, index) {
    return { id: `toolu_w${index}`, name, input: {}, index };
  }
  function mkAsk(index) {
    return { id: `toolu_a${index}`, name: 'ask_user', input: { question: 'q' }, index };
  }

  test('all writes, no asks → order unchanged (same member identity)', () => {
    const sort = createSortRecordsAsksLast();
    const input = [mkWrite('record_reading', 0), mkWrite('record_observation', 1), mkWrite('create_circuit', 2)];
    const out = sort(input);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual(['toolu_w0', 'toolu_w1', 'toolu_w2']);
  });

  test('all asks → order unchanged', () => {
    const sort = createSortRecordsAsksLast();
    const input = [mkAsk(0), mkAsk(1), mkAsk(2)];
    const out = sort(input);
    expect(out.map((r) => r.id)).toEqual(['toolu_a0', 'toolu_a1', 'toolu_a2']);
  });

  test('mixed [write, ask, write, ask, write] → [write, write, write, ask, ask] (STA-02)', () => {
    const sort = createSortRecordsAsksLast();
    const w1 = mkWrite('record_reading', 0);
    const a1 = mkAsk(1);
    const w2 = mkWrite('record_observation', 2);
    const a2 = mkAsk(3);
    const w3 = mkWrite('record_reading', 4);
    const out = sort([w1, a1, w2, a2, w3]);
    expect(out.map((r) => r.id)).toEqual([
      'toolu_w0',
      'toolu_w2',
      'toolu_w4',
      'toolu_a1',
      'toolu_a3',
    ]);
  });

  test('preserves internal order within each partition across non-adjacent input', () => {
    const sort = createSortRecordsAsksLast();
    // Input: a1, w1, a2, w2, a3, w3 (alternating). Writes emitted at indices
    // 1, 3, 5 must come out in that order; asks 0, 2, 4 ditto.
    const input = [mkAsk(0), mkWrite('record_reading', 1), mkAsk(2), mkWrite('record_observation', 3), mkAsk(4), mkWrite('create_circuit', 5)];
    const out = sort(input);
    expect(out.map((r) => r.id)).toEqual([
      'toolu_w1',
      'toolu_w3',
      'toolu_w5',
      'toolu_a0',
      'toolu_a2',
      'toolu_a4',
    ]);
  });

  test('empty array → empty array (no throw)', () => {
    const sort = createSortRecordsAsksLast();
    expect(sort([])).toEqual([]);
  });

  test('single write record → unchanged', () => {
    const sort = createSortRecordsAsksLast();
    const input = [mkWrite('record_reading', 0)];
    const out = sort(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('toolu_w0');
  });

  test('single ask record → unchanged', () => {
    const sort = createSortRecordsAsksLast();
    const input = [mkAsk(0)];
    const out = sort(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('toolu_a0');
  });

  test('does NOT mutate input array (length, order, member identity preserved)', () => {
    const sort = createSortRecordsAsksLast();
    const w1 = mkWrite('record_reading', 0);
    const a1 = mkAsk(1);
    const w2 = mkWrite('record_observation', 2);
    const input = [w1, a1, w2];
    const inputSnapshot = [...input];

    sort(input);

    expect(input).toHaveLength(3);
    expect(input[0]).toBe(w1);
    expect(input[1]).toBe(a1);
    expect(input[2]).toBe(w2);
    expect(input).toEqual(inputSnapshot);
  });

  test('multiple ask_user in same round → all moved to end, internal order preserved', () => {
    const sort = createSortRecordsAsksLast();
    const input = [mkAsk(0), mkWrite('record_reading', 1), mkAsk(2), mkAsk(3), mkWrite('record_observation', 4), mkAsk(5)];
    const out = sort(input);
    // Writes first in emission order (w1, w4), then all asks in emission order (a0, a2, a3, a5).
    expect(out.map((r) => r.id)).toEqual([
      'toolu_w1',
      'toolu_w4',
      'toolu_a0',
      'toolu_a2',
      'toolu_a3',
      'toolu_a5',
    ]);
  });

  test('non-array input → returned unchanged (defensive)', () => {
    const sort = createSortRecordsAsksLast();
    // If runToolLoop ever passes something weird (null, undefined), the hook
    // should fail-open to identity — matches the "do not mutate" contract.
    expect(sort(null)).toBe(null);
    expect(sort(undefined)).toBe(undefined);
  });
});
