// filled-slots-filter.test.js
// Coverage for the Stage 5 (voice-quality-sprint 2026-04-20) filledSlots
// pre-flight filter in sonnet-stream.js. Exercises the F21934D4 reproducer
// and the guardrails that keep same-turn and orphan questions alive.

import {
  filterQuestionsAgainstFilledSlots,
  __TEST_REFILL_QUESTION_TYPES,
} from '../extraction/filled-slots-filter.js';

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
    // in-turn judgement we must respect. Uses `unclear` (a refill-style
    // type) so this test genuinely exercises the same-turn bypass; a
    // non-refill type like `out_of_range` would pass through anyway.
    const snapshot = { circuits: { 0: { postcode: 'RG30' } } };
    const questions = [{ field: 'postcode', circuit: 0, type: 'unclear' }];
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

  // --- Codex round-2 blocker fixes: type whitelist ---

  describe('type whitelist (codex round-2 blocker)', () => {
    test('REFILL_QUESTION_TYPES matches canonical Sonnet refill vocabulary', () => {
      // Canonical schema: config/prompts/sonnet_extraction_system.md line 562
      //   orphaned | out_of_range | unclear | tt_confirmation
      //   | circuit_disambiguation | observation_confirmation
      //
      // Refill-style subset (inspector is being asked to (re-)supply a
      // value): `unclear`, `orphaned`, `circuit_disambiguation`. The rest are
      // warnings / confirmations / observations and must survive the filter.
      // If Sonnet's prompt grows a new refill type this test forces an
      // explicit decision about whether to add it.
      const asArray = Array.from(__TEST_REFILL_QUESTION_TYPES).sort();
      expect(asArray).toEqual(['circuit_disambiguation', 'orphaned', 'unclear']);
    });

    test('drops circuit_disambiguation refill when slot is filled', () => {
      // Codex round-3 blocker: previous cut used 'clarify' which is not in
      // the Sonnet schema. Real disambiguation type is `circuit_disambiguation`
      // and it must be suppressed when the target slot is already populated.
      const snapshot = { circuits: { 2: { zs: 1.23 } } };
      const questions = [
        { field: 'zs', circuit: 2, type: 'circuit_disambiguation', heard_value: '1.23' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('circuit_disambiguation survives when slot is NOT filled', () => {
      const snapshot = { circuits: { 3: { zs: 1.23 } } };
      const questions = [
        { field: 'zs', circuit: 2, type: 'circuit_disambiguation', heard_value: '0.64' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('"clarify" is NOT in the refill set (not a Sonnet schema type)', () => {
      // `clarify` was in the round-2 cut by mistake — not in the prompt
      // schema. Left as a pass-through regression guard: if Sonnet ever
      // surfaces it (e.g. via the iOS-reply annotation whitelist at
      // sonnet-stream.js:1201), we don't silently drop the question.
      const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
      const questions = [{ field: 'r1_r2', circuit: 2, type: 'clarify' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps out_of_range warnings even when slot is filled', () => {
      // out_of_range is the canonical "warning about an existing value" type.
      // Captured Zs = 9999 ohms would trigger out_of_range; the warning must
      // reach the inspector even though the slot is non-empty.
      const snapshot = { circuits: { 2: { zs: 9999 } } };
      const questions = [{ field: 'zs', circuit: 2, type: 'out_of_range', heard_value: '9999' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('out_of_range');
    });

    test('keeps tt_confirmation even when slot is filled', () => {
      const snapshot = { circuits: { 0: { earthing_arrangement: 'TT' } } };
      const questions = [
        { field: 'earthing_arrangement', circuit: 0, type: 'tt_confirmation' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps observation_* questions even when slot is filled', () => {
      // Observation-related questions normally carry field=null so fall
      // through the earlier null-circuit guard. This covers the paranoid
      // case where Sonnet emits them with a concrete field+circuit.
      const snapshot = { circuits: { 2: { polarity: 'confirmed' } } };
      const questions = [
        { field: 'polarity', circuit: 2, type: 'observation_confirmation' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps voice_command even when slot is filled', () => {
      const snapshot = { circuits: { 2: { zs: 1.23 } } };
      const questions = [{ field: 'zs', circuit: 2, type: 'voice_command' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps unknown/novel types (safer default for prompt drift)', () => {
      // If Sonnet's prompt grows a new question type we haven't seen yet,
      // pass it through rather than silently dropping warnings.
      const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
      const questions = [{ field: 'r1_r2', circuit: 2, type: 'range_warning_v2' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('drops orphaned refill question when slot is filled', () => {
      const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
      const questions = [{ field: 'r1_r2', circuit: 2, type: 'orphaned' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('type matching is case-insensitive', () => {
      // Defensive — Sonnet's prompt uses lower-case, but the value comes
      // from JSON so tolerate capitalisation drift.
      const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
      const questions = [{ field: 'r1_r2', circuit: 2, type: 'UNCLEAR' }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('missing type → pass through (treat as warning, not refill)', () => {
      // If Sonnet omits `type` entirely, err on the side of asking the
      // inspector rather than suppressing.
      const snapshot = { circuits: { 2: { r1_r2: 0.64 } } };
      const questions = [{ field: 'r1_r2', circuit: 2 }];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });
  });

  // --- (A) heard_value cross-reference — session 0952EC64 repro ---
  //
  // The null-field / circuit=-1 questions slip past the slot check but can
  // be caught by searching the whole snapshot for the heard value. The
  // three 0.13 questions in that session all match this pattern.

  describe('heard_value cross-reference across snapshot (session 0952EC64)', () => {
    test('drops null-field unclear question whose heard_value is stored elsewhere', () => {
      // Q2 from the repro: Sonnet confused about 0.13, asks "Did you say
      // 0.13 for a specific field or circuit?" while circuit.4.r1_plus_r2
      // is already 0.13.
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        { type: 'unclear', field: null, circuit: -1, heard_value: '0.13' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('drops circuit_disambiguation with sentinel circuit=-1 when value is stored', () => {
      // Q4 from the repro — different type, same heard_value.
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        {
          type: 'circuit_disambiguation',
          field: 'r1_plus_r2',
          circuit: -1,
          heard_value: '0.13',
        },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('normalises numeric forms: "0.130" heard_value matches 0.13 stored', () => {
      // Value normalisation shared with QuestionGate — "0.130", "0.13",
      // " 0.13 ohms" all collapse to the same canonical string.
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        { type: 'unclear', field: null, circuit: -1, heard_value: '0.130' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });

    test('keeps question when heard_value is stored but same (field,circuit) was just resolved this turn', () => {
      // Protects the same-turn "half a postcode" case for the heard_value
      // path: Sonnet extracted a value this turn AND is asking a follow-up.
      // The stored-location entry must be ignored if it's in thisTurn.
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        {
          type: 'unclear',
          field: 'r1_plus_r2',
          circuit: -1,
          heard_value: '0.13',
        },
      ];
      const resolvedThisTurn = new Set(['r1_plus_r2:4']);
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        resolvedThisTurn,
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps null-field question when heard_value is NOT stored anywhere', () => {
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        { type: 'unclear', field: null, circuit: -1, heard_value: '0.99' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps out_of_range warning even when heard_value is stored (non-refill type)', () => {
      // Inspector said 9999 ohms, stored, warning arrives. Must survive.
      const snapshot = { circuits: { 2: { zs: 9999 } } };
      const questions = [
        { type: 'out_of_range', field: 'zs', circuit: 2, heard_value: '9999' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('keeps null-field question with no heard_value (filter can\'t help)', () => {
      // Nothing to cross-reference on; falls through to existing orphan
      // pass-through path. QuestionGate deals with it.
      const snapshot = { circuits: { 4: { r1_plus_r2: 0.13 } } };
      const questions = [
        { type: 'unclear', field: null, circuit: -1, heard_value: null },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('preserves ">200" semantic prefix (not the same as "200")', () => {
      // Upper-bounded IR reading. ">200" is a >-flagged reading, not a
      // numeric 200; must NOT match.
      const snapshot = { circuits: { 1: { insulation_resistance_l_e: 200 } } };
      const questions = [
        { type: 'unclear', field: null, circuit: -1, heard_value: '>200' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toHaveLength(1);
    });

    test('matches across different circuits (the "don\'t know where it goes" case)', () => {
      // heard_value=0.13 on a question with circuit=-1 should match
      // regardless of which circuit stores 0.13 — the point is that the
      // value is already somewhere on the form.
      const snapshot = {
        circuits: {
          1: { r1_plus_r2: 0.5 },
          2: { zs: 0.13 }, // match here
          4: { r1_plus_r2: 0.7 },
        },
      };
      const questions = [
        { type: 'orphaned', field: null, circuit: -1, heard_value: '0.13' },
      ];
      const result = filterQuestionsAgainstFilledSlots(
        questions,
        snapshot,
        new Set(),
        sessionId
      );
      expect(result).toEqual([]);
    });
  });
});
