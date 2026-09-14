/**
 * Feedback id 139 turn-4 (session 2FFC497B, 2026-09-14) — `isValueBearingAsk`
 * decides whether an answered-then-silent ask is a DROPPED reply (the P4 net
 * speaks the dropped-value family) or an understood no-op (the plain "Noted"
 * family). A yes/no confirmation is never value-bearing; anything with a real
 * context field or a pending write is.
 */

import { isValueBearingAsk } from '../extraction/stage6-dispatcher-ask.js';

describe('isValueBearingAsk', () => {
  test('a designation ask for a circuit is value-bearing (the turn-4 shape)', () => {
    expect(
      isValueBearingAsk({
        question: 'What distinguishing description should I use for circuit 3?',
        reason: 'missing_context',
        context_field: 'circuit_designation',
        context_circuit: 3,
        expected_answer_shape: 'free_text',
      })
    ).toBe(true);
  });

  test('a which-circuit ask is value-bearing', () => {
    expect(
      isValueBearingAsk({
        question: 'Did you mean circuit 3 or circuit 2?',
        reason: 'ambiguous_circuit',
        context_field: 'circuit_ref',
        expected_answer_shape: 'circuit_ref',
      })
    ).toBe(true);
  });

  test('a pending-write ask is value-bearing even without a context field', () => {
    expect(
      isValueBearingAsk({
        question: 'Which circuit was that 0.47 for?',
        reason: 'missing_context',
        context_field: 'none',
        expected_answer_shape: 'circuit_ref',
        pending_write: { field: 'measured_zs_ohm', value: '0.47' },
      })
    ).toBe(true);
  });

  test('a yes/no confirmation is never value-bearing, whatever its context field', () => {
    expect(
      isValueBearingAsk({
        question: 'Should I use this same address for the customer?',
        reason: 'missing_context',
        context_field: 'client_address',
        expected_answer_shape: 'yes_no',
        purpose: 'address_mirror',
      })
    ).toBe(false);
  });

  test('no context field and no pending write is not value-bearing', () => {
    expect(
      isValueBearingAsk({
        question: 'Could you repeat that?',
        reason: 'unclear',
        context_field: 'none',
        expected_answer_shape: 'free_text',
      })
    ).toBe(false);
    expect(isValueBearingAsk({ question: 'x', reason: 'y' })).toBe(false);
    expect(isValueBearingAsk(null)).toBe(false);
    expect(isValueBearingAsk(undefined)).toBe(false);
  });
});
