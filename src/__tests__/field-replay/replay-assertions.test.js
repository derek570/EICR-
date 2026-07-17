/**
 * Unit tests for the write / tool-expectation oracles — the accident-class
 * correctness surface hardened in the PR #93 Codex review (grouped-circuit
 * require-all, fail-closed unsupported kinds, and the tool-outcome matcher
 * that must not false-pass a stub_ok row or false-fail a structured error).
 */
import { describe, test, expect } from '@jest/globals';
import { matchOperations, matchToolExpectations, OUTCOME } from '../../../scripts/field-replay/lib/replay-assertions.mjs';

const acceptValidator = () => ({ ok: true, errors: '' });
const rejectValidator = () => ({ ok: false, errors: 'missing required' });

describe('matchOperations write oracle', () => {
  test('grouped circuits require EVERY declared circuit, not any-one', () => {
    const result = { extracted_readings: [{ field: 'measured_zs_ohm', circuit: 2, value: '0.3' }] };
    const op = { operation_id: 'g', kind: 'reading', field: 'measured_zs_ohm', circuits: [2, 3], audibility: 'exactly_once' };
    const fails = matchOperations([op], { result });
    // circuit 3 is missing → one FAIL; circuit 2 present → no fail for it.
    expect(fails.filter((f) => f.outcome === OUTCOME.FAIL)).toHaveLength(1);
  });

  test('exactly_once fails on a duplicate write to the same slot', () => {
    const result = {
      extracted_readings: [
        { field: 'measured_zs_ohm', circuit: 2, value: '0.3' },
        { field: 'measured_zs_ohm', circuit: 2, value: '0.3' },
      ],
    };
    const op = { operation_id: 'd', kind: 'reading', field: 'measured_zs_ohm', circuit: 2, audibility: 'exactly_once' };
    const fails = matchOperations([op], { result });
    expect(fails.some((f) => f.outcome === OUTCOME.FAIL && /exactly one/.test(f.message))).toBe(true);
  });

  test('a kind with no faithful oracle latches INFRASTRUCTURE (never a silent pass)', () => {
    const fails = matchOperations([{ operation_id: 'c', kind: 'clear', audibility: 'exactly_once' }], { result: {} });
    expect(fails).toHaveLength(1);
    expect(fails[0].outcome).toBe(OUTCOME.INFRASTRUCTURE);
  });
});

describe('matchToolExpectations', () => {
  const turnWith = (tc) => ({ model_rounds: [{ stop_reason: 'tool_use', tool_calls: [tc] }] });

  test('a stub_ok row (no is_error) never satisfies dispatcher_expectation:accept when the real row errored', () => {
    const tc = { id: 'toolu_1', name: 'record_reading', input: {}, schema_expectation: 'accept', dispatcher_expectation: 'accept' };
    const captured = {
      validateToolInput: acceptValidator,
      logRows: [
        { name: 'stage6.tool_call', meta: { tool_call_id: 'toolu_1', outcome: 'stub_ok' } },
        { name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_1', is_error: true, validation_error: 'boom' } },
      ],
    };
    const fails = matchToolExpectations(turnWith(tc), captured);
    // The authoritative errored row must produce a dispatcher FAIL despite the stub_ok row.
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_1' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('a structured validation_error {code} matches its declared reject code (no [object Object])', () => {
    const tc = { id: 'toolu_2', name: 'record_reading', input: {}, schema_expectation: 'reject', dispatcher_expectation: 'reject', dispatcher_reject_code: 'circuit_not_found' };
    const captured = {
      validateToolInput: rejectValidator, // schema:reject satisfied
      logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_2', is_error: true, validation_error: { code: 'circuit_not_found' } } }],
    };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails).toHaveLength(0); // both schema:reject and dispatcher:reject(+code) satisfied
  });

  test('schema and dispatcher failures use DISTINCT ids (never collapse into one expected_red id)', () => {
    const tc = { id: 'toolu_3', name: 'record_reading', input: {}, schema_expectation: 'accept', dispatcher_expectation: 'accept' };
    const captured = {
      validateToolInput: rejectValidator, // schema:accept violated
      logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_3', is_error: true, validation_error: 'x' } }], // dispatcher:accept violated
    };
    const ids = matchToolExpectations(turnWith(tc), captured).map((f) => f.id).sort();
    expect(ids).toEqual(['tool.dispatcher.toolu_3', 'tool.schema.toolu_3']);
  });

  test('validator unavailable latches infrastructure (cannot verify schema_expectation)', () => {
    const tc = { id: 'toolu_4', name: 'record_reading', input: {}, schema_expectation: 'accept' };
    const fails = matchToolExpectations(turnWith(tc), { logRows: [] });
    expect(fails.some((f) => f.id === 'tool.schema.toolu_4' && f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });
});
