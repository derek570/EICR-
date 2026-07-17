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
        { name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_1', tool: 'record_reading', is_error: true, validation_error: 'boom' } },
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
      logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_2', tool: 'record_reading', is_error: true, validation_error: { code: 'circuit_not_found' } } }],
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

  test('an ABSENT authoritative row → infrastructure for accept (never a vacuous pass)', () => {
    const tc = { id: 'toolu_5', name: 'record_reading', input: {}, dispatcher_expectation: 'accept' };
    const fails = matchToolExpectations(turnWith(tc), { validateToolInput: acceptValidator, logRows: [] });
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_5' && f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });

  test('an ABSENT authoritative row → infrastructure for reject too (missing ≠ satisfied)', () => {
    const tc = { id: 'toolu_6', name: 'record_reading', input: {}, dispatcher_expectation: 'reject' };
    const fails = matchToolExpectations(turnWith(tc), { validateToolInput: acceptValidator, logRows: [] });
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_6' && f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });

  test('a dispatcher-error-only thin row (no authoritative row) → infrastructure', () => {
    const tc = { id: 'toolu_7', name: 'record_reading', input: {}, dispatcher_expectation: 'accept' };
    const captured = { validateToolInput: acceptValidator, logRows: [{ name: 'stage6.tool_call', meta: { tool_call_id: 'toolu_7', outcome: 'dispatcher_error' } }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_7' && f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });

  test('reject with a MISSING validation_error but a declared reject_code FAILS (cannot confirm)', () => {
    const tc = { id: 'toolu_8', name: 'record_reading', input: {}, dispatcher_expectation: 'reject', dispatcher_reject_code: 'circuit_not_found' };
    const captured = { validateToolInput: acceptValidator, logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_8', tool: 'record_reading', is_error: true, validation_error: null } }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_8' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('reject_code compares EXACTLY (no substring collision)', () => {
    const tc = { id: 'toolu_9', name: 'record_reading', input: {}, dispatcher_expectation: 'reject', dispatcher_reject_code: 'not_found' };
    const captured = { validateToolInput: acceptValidator, logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_9', tool: 'record_reading', is_error: true, validation_error: { code: 'circuit_not_found' } } }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    // 'not_found' is a SUBSTRING of 'circuit_not_found' but not equal → must FAIL.
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_9' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('ask_user with NO lifecycle evidence (not emitted, no terminal row) → infrastructure', () => {
    const tc = { id: 'toolu_ask', name: 'ask_user', input: {}, dispatcher_expectation: 'accept' };
    const fails = matchToolExpectations(turnWith(tc), { validateToolInput: acceptValidator, logRows: [], wsFrames: [] });
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_ask' && f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });

  test('ask_user accept SATISFIED when the ask was emitted', () => {
    const tc = { id: 'toolu_ask2', name: 'ask_user', input: {}, dispatcher_expectation: 'accept' };
    const captured = { validateToolInput: acceptValidator, logRows: [], wsFrames: [{ type: 'ask_user_started', tool_call_id: 'toolu_ask2' }] };
    expect(matchToolExpectations(turnWith(tc), captured)).toHaveLength(0);
  });

  test('ask_user declared accept but GATED (answer_outcome ask_budget_exhausted) FAILS', () => {
    const tc = { id: 'toolu_ask3', name: 'ask_user', input: {}, dispatcher_expectation: 'accept' };
    const captured = { validateToolInput: acceptValidator, wsFrames: [], logRows: [{ name: 'stage6.ask_user', meta: { tool_call_id: 'toolu_ask3', answer_outcome: 'ask_budget_exhausted' } }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_ask3' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('ask_user declared reject but POSED (emitted) FAILS', () => {
    const tc = { id: 'toolu_ask4', name: 'ask_user', input: {}, dispatcher_expectation: 'reject' };
    const captured = { validateToolInput: acceptValidator, logRows: [], wsFrames: [{ type: 'ask_user_started', tool_call_id: 'toolu_ask4' }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_ask4' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('ask_user reject with the WRONG declared reject code FAILS', () => {
    const tc = { id: 'toolu_ask5', name: 'ask_user', input: {}, dispatcher_expectation: 'reject', dispatcher_reject_code: 'gated' };
    const captured = { validateToolInput: acceptValidator, wsFrames: [], logRows: [{ name: 'stage6.ask_user', meta: { tool_call_id: 'toolu_ask5', answer_outcome: 'ask_budget_exhausted' } }] };
    const fails = matchToolExpectations(turnWith(tc), captured);
    expect(fails.some((f) => f.id === 'tool.dispatcher.toolu_ask5' && f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('EMISSION is authoritative: emitted + reject-listed terminal row → reject still FAILS', () => {
    const tc = { id: 'toolu_ask6', name: 'ask_user', input: {}, dispatcher_expectation: 'reject' };
    const captured = {
      validateToolInput: acceptValidator,
      wsFrames: [{ type: 'ask_user_started', tool_call_id: 'toolu_ask6' }],
      logRows: [{ name: 'stage6.ask_user', meta: { tool_call_id: 'toolu_ask6', answer_outcome: 'gated' } }],
    };
    expect(matchToolExpectations(turnWith(tc), captured).some((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('EMISSION is authoritative: emitted + post-emission outcome → accept PASSES', () => {
    const tc = { id: 'toolu_ask7', name: 'ask_user', input: {}, dispatcher_expectation: 'accept' };
    const captured = {
      validateToolInput: acceptValidator,
      wsFrames: [{ type: 'ask_user_started', tool_call_id: 'toolu_ask7' }],
      logRows: [{ name: 'stage6.ask_user', meta: { tool_call_id: 'toolu_ask7', answer_outcome: 'transcript_already_extracted' } }],
    };
    expect(matchToolExpectations(turnWith(tc), captured)).toHaveLength(0);
  });

  test('non-ask: DUPLICATE authoritative rows → infrastructure (no silent first-match)', () => {
    const tc = { id: 'toolu_d', name: 'record_reading', input: {}, dispatcher_expectation: 'accept' };
    const captured = {
      validateToolInput: acceptValidator,
      logRows: [
        { name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_d', tool: 'record_reading', is_error: false } },
        { name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_d', tool: 'record_reading', is_error: true } },
      ],
    };
    expect(matchToolExpectations(turnWith(tc), captured).some((f) => f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });

  test('non-ask: a same-id row for a DIFFERENT tool → infrastructure (identity enforced)', () => {
    const tc = { id: 'toolu_x', name: 'record_reading', input: {}, dispatcher_expectation: 'accept' };
    const captured = {
      validateToolInput: acceptValidator,
      logRows: [{ name: 'stage6_tool_call', meta: { tool_use_id: 'toolu_x', tool: 'record_observation', is_error: false } }],
    };
    expect(matchToolExpectations(turnWith(tc), captured).some((f) => f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
  });
});
