// filled-slots-filter.test.js
// Coverage for the Stage 5 (voice-quality-sprint 2026-04-20) filledSlots
// pre-flight filter in sonnet-stream.js. Exercises the F21934D4 reproducer
// and the guardrails that keep same-turn and orphan questions alive.

import { filterQuestionsAgainstFilledSlots } from '../extraction/filled-slots-filter.js';

describe('filterQuestionsAgainstFilledSlots', () => {
  const sessionId = 'test-session';

  test('drops question when slot is already filled in stateSnapshot', () => {
    // The F21934D4 reproducer: R1+R2 for circuit 2 already recorded, Sonnet
    // re-asks on a later turn after the sliding window drops the exchange.
    const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
    const questions = [
      { field: 'r1_r2', circuit: 2, type: 'unclear', heard_value: 'unclear' },
    ];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toEqual([]);
  });

  test('keeps question when slot is NOT filled', () => {
    const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
    const questions = [{ field: 'zs', circuit: 2, type: 'unclear' }];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('zs');
  });

  test('keeps question when circuit is null (orphan/install-field)', () => {
    // Null-circuit questions are handled by QuestionGate's install-field
    // wildcard / orphan logic. Pre-flight filter must not interfere.
    const snapshot = { circuits: { 0: { postcode: 'RG30' } } };
    const questions = [{ field: 'postcode', circuit: null, type: 'unclear' }];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toHaveLength(1);
  });

  test('keeps same-turn question even if stateSnapshot shows slot filled', () => {
    // Guards the "half a postcode" case — Sonnet extracts a partial value
    // AND asks about it in the same turn. stateSnapshot already reflects
    // the extraction, but resolvedFieldsThisTurn tells us this is an
    // in-turn judgement we must respect.
    const snapshot = { circuits: { 0: { postcode: 'RG30' } } };
    const questions = [{ field: 'postcode', circuit: 0, type: 'clarify' }];
    const resolvedThisTurn = new Set(['postcode:0']);
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      resolvedThisTurn,
      sessionId
    );
    expect(result).toHaveLength(1);
  });

  test('drops some questions, keeps others in a mixed batch', () => {
    const snapshot = {
      circuits: {
        2: { r1_r2: 0.64 },
        3: { zs: 1.23 },
      },
    };
    const questions = [
      { field: 'r1_r2', circuit: 2, type: 'unclear' }, // drop
      { field: 'zs', circuit: 4, type: 'unclear' }, // keep (not filled)
      { field: 'zs', circuit: 3, type: 'unclear' }, // drop
      { field: 'postcode', circuit: null, type: 'clarify' }, // keep (null)
    ];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toHaveLength(2);
    expect(result.map((q) => `${q.field}:${q.circuit}`).sort()).toEqual([
      'postcode:null',
      'zs:4',
    ]);
  });

  test('treats null/undefined/empty slot values as NOT filled', () => {
    // Protects against partial snapshot entries where the key exists but the
    // value was cleared / never populated. Without this guard the filter
    // would suppress a legitimate question.
    const snapshot = { circuits: { 2: { r1_r2: null, zs: undefined, pfc: '' } } };
    const questions = [
      { field: 'r1_r2', circuit: 2, type: 'unclear' },
      { field: 'zs', circuit: 2, type: 'unclear' },
      { field: 'pfc', circuit: 2, type: 'unclear' },
    ];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toHaveLength(3);
  });

  test('handles missing stateSnapshot gracefully', () => {
    const questions = [{ field: 'zs', circuit: 2, type: 'unclear' }];
    expect(
      filterQuestionsAgainstFilledSlots(questions, null, new Set(), sessionId)
    ).toHaveLength(1);
    expect(
      filterQuestionsAgainstFilledSlots(questions, undefined, new Set(), sessionId)
    ).toHaveLength(1);
    expect(
      filterQuestionsAgainstFilledSlots(questions, {}, new Set(), sessionId)
    ).toHaveLength(1);
  });

  test('returns input unchanged when questions is empty or missing', () => {
    const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
    expect(
      filterQuestionsAgainstFilledSlots([], snapshot, new Set(), sessionId)
    ).toEqual([]);
    expect(
      filterQuestionsAgainstFilledSlots(null, snapshot, new Set(), sessionId)
    ).toBeNull();
    expect(
      filterQuestionsAgainstFilledSlots(undefined, snapshot, new Set(), sessionId)
    ).toBeUndefined();
  });

  test('keeps question when field is missing (incomplete schema)', () => {
    // Malformed / partial questions fall through to QuestionGate which has
    // its own defence. Pre-flight filter must not drop them.
    const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
    const questions = [{ circuit: 2, type: 'unclear' }];
    const result = filterQuestionsAgainstFilledSlots(
      questions,
      snapshot,
      new Set(),
      sessionId
    );
    expect(result).toHaveLength(1);
  });

  test('tolerates non-Set resolvedFieldsThisTurn (defensive)', () => {
    const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
    const questions = [{ field: 'r1_r2', circuit: 2, type: 'unclear' }];
    // Passing undefined / an array / null should all behave as empty set —
    // i.e. no same-turn protection, drop the question.
    expect(
      filterQuestionsAgainstFilledSlots(questions, snapshot, undefined, sessionId)
    ).toEqual([]);
    expect(
      filterQuestionsAgainstFilledSlots(questions, snapshot, null, sessionId)
    ).toEqual([]);
    expect(
      filterQuestionsAgainstFilledSlots(questions, snapshot, ['r1_r2:2'], sessionId)
    ).toEqual([]);
  });
});
