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
    expect(entry.text).toBe('No non-spare circuits were updated; skipping 2 spare ways.');
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
    expect(entry.text).toBe('No non-spare circuits were updated; skipping 1 spare way.');
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
