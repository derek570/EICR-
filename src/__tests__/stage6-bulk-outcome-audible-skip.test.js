/**
 * stage6-bulk-outcome-audible-skip.test.js
 *
 * PLAN-F item 1 (2026-08-12, feedback id 115), Decision 4 — the audible-skip
 * disclosure. dispatchSetFieldForAllCircuits stages a bulkOutcomes ledger
 * entry (see stage6-per-turn-writes.js stageBulkOutcomeForBundler); the
 * bundler consumes it to amend the matching confirmation with a count-aware
 * "…skipping N spare ways" clause, or to synthesise a standalone zero-applied
 * confirmation when nothing was written. Real-ingress: exercises the full
 * dispatcher → perTurnWrites → bundler pipeline (createWriteDispatcher +
 * bundleToolCallsIntoResult), not a hand-built fixture, so a change to either
 * side's identity space (field/board_id/circuits matching) is caught here.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function buildSession(circuits) {
  return { sessionId: 's-audible-skip', stateSnapshot: { circuits }, extractedObservations: [] };
}

async function runBulkApply(session, input) {
  const writes = createPerTurnWrites();
  const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
  await d({ tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input }, {});
  return writes;
}

describe('audible-skip disclosure — single applied circuit (per-circuit confirmation)', () => {
  test('1 spare skipped appends "…skipping 1 spare way" to the per-circuit confirmation', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Spare' },
    });
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find((c) => c.field === 'rcd_time_ms' && c.circuit === 1);
    expect(entry).toBeDefined();
    expect(entry.text.endsWith(', skipping 1 spare way')).toBe(true);
    expect(entry.expanded_text.endsWith(', skipping 1 spare way')).toBe(true);
  });
});

describe('audible-skip disclosure — multiple applied circuits (grouped confirmation)', () => {
  test('N spare skipped appends "…skipping N spare ways" (plural) to the grouped confirmation', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
      3: { circuit_designation: 'Spare' },
      4: { circuit_designation: '' },
    });
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find(
      (c) => c.field === 'rcd_time_ms' && Array.isArray(c.circuits)
    );
    expect(entry).toBeDefined();
    expect(entry.circuits.sort()).toEqual([1, 2]);
    expect(entry.text.endsWith(', skipping 2 spare ways')).toBe(true);
    expect(entry.expanded_text.endsWith(', skipping 2 spare ways')).toBe(true);
  });
});

describe('audible-skip disclosure — zero-applied (Decision 4 standalone confirmation)', () => {
  test('all targets spare under an exclude policy → standalone zero-applied confirmation, no reading to annotate', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Spare' },
      2: { circuit_designation: '' },
    });
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    // No readings were written at all (both circuits spare, excluded).
    expect(writes.readings.size).toBe(0);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find((c) => c.field === 'rcd_time_ms');
    expect(entry).toBeDefined();
    expect(entry.text).toBe('No non-spare circuits were updated; skipped 2 spare ways.');
    expect(entry.circuit).toBeNull();
  });

  test('exactly 1 spare skipped, zero applied → singular wording', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Spare' },
    });
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find((c) => c.field === 'rcd_time_ms');
    expect(entry.text).toBe('No non-spare circuits were updated; skipped 1 spare way.');
  });
});

describe('audible-skip disclosure — no skip, no disclosure clause', () => {
  test('no spares in the schedule → confirmation carries no skip clause, no extra entries', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
    });
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    expect(r.confirmations).toHaveLength(1);
    expect(r.confirmations[0].text).not.toContain('spare');
  });
});

describe('audible-skip disclosure — multiple bulk calls / multiple boards in one turn', () => {
  test('two bulk calls (different fields) in one turn — each disclosure attaches to its OWN confirmation, not the other', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Spare' },
    });
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu_bulk_1',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_time_ms', value: '25', confidence: 0.95, source_turn_id: 't1' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_bulk_2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_button_confirmed',
          value: 'OK',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(writes.bulkOutcomes).toHaveLength(2);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const rcdTime = r.confirmations.find((c) => c.field === 'rcd_time_ms');
    const rcdButton = r.confirmations.find((c) => c.field === 'rcd_button_confirmed');
    expect(rcdTime.text.endsWith(', skipping 1 spare way')).toBe(true);
    expect(rcdButton.text.endsWith(', skipping 1 spare way')).toBe(true);
    // Neither disclosure duplicated onto the other's field.
    expect(r.confirmations.filter((c) => c.text.includes('spare'))).toHaveLength(2);
  });

  test('cross-board "*" sweep — each board gets its OWN disclosure, not merged', async () => {
    // Main board uses LEGACY bare-numeric circuit keys; the sub board uses
    // composite `${board_id}::${circuit}` keys with explicit board_id/circuit
    // fields on the bucket — same shape as
    // stage6-a2-multiboard-board-id-normalisation.test.js's makeSession.
    const session = {
      sessionId: 's-cross-board',
      stateSnapshot: {
        currentBoardId: 'main',
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-b',
            designation: 'DB-2',
            board_type: 'sub_distribution',
            parent_board_id: 'main',
          },
        ],
        circuits: {
          0: {},
          1: { circuit_designation: 'Cooker' },
          2: { circuit_designation: 'Spare' },
          'sub-b::1': { board_id: 'sub-b', circuit: 1, circuit_designation: 'Immersion' },
          'sub-b::2': { board_id: 'sub-b', circuit: 2, circuit_designation: 'Sockets' },
        },
      },
      extractedObservations: [],
    };
    const writes = await runBulkApply(session, {
      field: 'rcd_time_ms',
      value: '25',
      confidence: 0.95,
      source_turn_id: 't1',
      board_id: '*',
    });
    // main board: circuit 1 applied, circuit 2 spare-skipped.
    // sub-b board: circuits 1+2 applied, no spares — its ledger entry
    // carries an EMPTY spareSkippedRefs, which the bundler's consumer
    // harmlessly skips (nothing to disclose).
    const mainOutcome = writes.bulkOutcomes.find((o) => o.boardId === 'main');
    const subOutcome = writes.bulkOutcomes.find((o) => o.boardId === 'sub-b');
    expect(mainOutcome?.appliedRefs).toEqual([1]);
    expect(mainOutcome?.spareSkippedRefs).toEqual([2]);
    expect(subOutcome?.appliedRefs).toEqual([1, 2]);
    expect(subOutcome?.spareSkippedRefs).toEqual([]);

    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    // A '*' sweep stamps board_id on EVERY applied entry (including main's),
    // per dispatchSetFieldForAllCircuits's `...(input.board_id === '*' ?
    // { board_id: boardId } : {})` — so main's confirmation carries
    // board_id:'main' here, not an omitted/null key.
    const subConfirmation = r.confirmations.find((c) => c.board_id === 'sub-b');
    const mainConfirmation = r.confirmations.find(
      (c) => c.field === 'rcd_time_ms' && c.board_id === 'main'
    );
    // The disclosure attaches ONLY to main's confirmation, never to sub-b's.
    expect(subConfirmation?.text.includes('spare')).toBe(false);
    expect(mainConfirmation?.text.endsWith(', skipping 1 spare way')).toBe(true);
  });
});

describe('PLAN-F2 finding 1 (2026-08-14) — callId-threaded bulk-outcome matching', () => {
  test('disjoint-circuit two-call scenario: each call keeps its OWN ledger entry and its OWN disclosure (per-circuit path)', async () => {
    // 1=Cooker (applied by call1), 2=Spare (skipped by call1),
    // 3=Sockets (applied by call2), 4=Spare (skipped by call2).
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Spare' },
      3: { circuit_designation: 'Sockets' },
      4: { circuit_designation: 'Spare' },
    });
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu_call_1',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [3, 4],
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_call_2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [1, 2],
        },
      },
      {}
    );
    // Pre-finding-1: the second call's (field, boardId)-only REPLACE would
    // have discarded the first call's ledger entry here. Both must survive.
    expect(writes.bulkOutcomes).toHaveLength(2);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const c1 = r.confirmations.find((c) => c.field === 'rcd_time_ms' && c.circuit === 1);
    const c3 = r.confirmations.find((c) => c.field === 'rcd_time_ms' && c.circuit === 3);
    expect(c1?.text.endsWith(', skipping 1 spare way')).toBe(true);
    expect(c3?.text.endsWith(', skipping 1 spare way')).toBe(true);
    // No stray fallback/standalone entries — both disclosures landed on
    // their own confirmation, not a defensive fallback line.
    expect(r.confirmations.filter((c) => c.text.includes('spare'))).toHaveLength(2);
  });

  test('same-VALUE disjoint calls form TWO grouped confirmations, each with its own disclosure', async () => {
    // 1,2 = Cooker/Sockets (applied by call1), 3 = Spare (skipped by call1)
    // 4,5 = Immersion/Shower (applied by call2), 6 = Spare (skipped by call2)
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Sockets' },
      3: { circuit_designation: 'Spare' },
      4: { circuit_designation: 'Immersion' },
      5: { circuit_designation: 'Shower' },
      6: { circuit_designation: 'Spare' },
    });
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu_call_1',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [4, 5, 6],
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_call_2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [1, 2, 3],
        },
      },
      {}
    );
    expect(writes.bulkOutcomes).toHaveLength(2);
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const grouped = r.confirmations.filter(
      (c) => c.field === 'rcd_time_ms' && Array.isArray(c.circuits)
    );
    // Same field+value+board would have collapsed into ONE bucket pre-
    // finding-1 (buildFanoutGroupKey carried no call identity) — now two.
    expect(grouped).toHaveLength(2);
    const g1 = grouped.find((c) => c.circuits.includes(1));
    const g2 = grouped.find((c) => c.circuits.includes(4));
    expect(g1.circuits.sort()).toEqual([1, 2]);
    expect(g2.circuits.sort()).toEqual([4, 5]);
    expect(g1.text.endsWith(', skipping 1 spare way')).toBe(true);
    expect(g2.text.endsWith(', skipping 1 spare way')).toBe(true);
  });

  test('a same-target correction (identical circuit set, new value) REPLACES — no stale fallback disclosure', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Spare' },
    });
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu_first',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_time_ms', value: '25', confidence: 0.95, source_turn_id: 't1' },
      },
      {}
    );
    // Same circuit set (no exclude difference) — a genuine correction.
    await d(
      {
        tool_call_id: 'tu_correction',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_time_ms', value: '30', confidence: 0.95, source_turn_id: 't1' },
      },
      {}
    );
    // REPLACE, not append — one surviving ledger entry, the correction's.
    expect(writes.bulkOutcomes).toHaveLength(1);
    expect(writes.bulkOutcomes[0].callId).toBe('tu_correction');
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const spareEntries = r.confirmations.filter((c) => c.text.includes('spare'));
    // The already-fixed bug (double-append: "...30, skipping 1 spare way,
    // skipping 1 spare way") must not return, and no stray fallback entry
    // either — exactly ONE confirmation, naming the corrected value.
    expect(spareEntries).toHaveLength(1);
    expect(spareEntries[0].text).toBe('Circuit 1, RCD time 30, skipping 1 spare way');
  });

  test('fast-correlation confirmation is unaffected by a two-bulk-call turn — text stays byte-identical, disclosure ships as an additive sibling', async () => {
    const session = buildSession({
      0: {},
      1: { circuit_designation: 'Cooker' },
      2: { circuit_designation: 'Spare' },
      3: { circuit_designation: 'Sockets' },
      4: { circuit_designation: 'Spare' },
    });
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu_call_1',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [3, 4],
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_call_2',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_time_ms',
          value: '25',
          confidence: 0.95,
          source_turn_id: 't1',
          exclude_circuits: [1, 2],
        },
      },
      {}
    );
    // circuit 1's confirmation is the "already played" fast-TTS twin.
    // Keyed by fastSlotKeyOf's EFFECTIVE board (resolveEffectiveBoardId
    // falls back to DEFAULT_MAIN_BOARD_ID 'main' for this boards-less
    // session), NOT the raw wire board_id (which stays omitted here).
    const fastAttemptBySlotKey = new Map([
      [
        'rcd_time_ms::1::main',
        {
          correlationId: 'cid-fast-1',
          field: 'rcd_time_ms',
          circuit: 1,
          boardId: null,
          canonicalValue: '25',
          comparisonText: 'Circuit 1, RCD time 25',
        },
      ],
    ]);
    const r = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, fastAttemptBySlotKey }
    );
    const c1 = r.confirmations.find((c) => c.circuit === 1 && c.field === 'rcd_time_ms');
    const c3 = r.confirmations.find((c) => c.circuit === 3 && c.field === 'rcd_time_ms');
    // The fast-correlation twin's TEXT is byte-identical to the fast route's
    // render — never mutated in place with the skip clause.
    expect(c1.fast_correlation_id).toBe('cid-fast-1');
    expect(c1.text).toBe('Circuit 1, RCD time 25');
    // Its disclosure still ships — as a separate additive fallback line.
    const fallback = r.confirmations.find(
      (c) => c.text === 'Skipping 1 spare way.' && c.circuit == null
    );
    expect(fallback).toBeDefined();
    // The OTHER (non-fast) call's confirmation gets its disclosure appended
    // normally, unaffected by the fast-correlation turn.
    expect(c3.fast_correlation_id).toBeUndefined();
    expect(c3.text.endsWith(', skipping 1 spare way')).toBe(true);
  });
});
