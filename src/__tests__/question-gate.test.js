/**
 * Tests for QuestionGate — holds Sonnet questions for 2.5s before sending to iOS.
 */

import { jest } from '@jest/globals';
import { QuestionGate } from '../extraction/question-gate.js';

describe('QuestionGate', () => {
  let sendCallback;
  let gate;

  beforeEach(() => {
    jest.useFakeTimers();
    sendCallback = jest.fn();
    gate = new QuestionGate(sendCallback);
  });

  afterEach(() => {
    gate.destroy();
    jest.useRealTimers();
  });

  describe('enqueue', () => {
    test('should not send immediately on enqueue', () => {
      gate.enqueue([{ field: 'zs', circuit: 1, question: 'Which circuit?' }]);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should send after 2.5 second delay', () => {
      const questions = [{ field: 'zs', circuit: 1, question: 'Which circuit?' }];
      gate.enqueue(questions);

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback).toHaveBeenCalledWith(questions);
    });

    test('should ignore empty questions array', () => {
      gate.enqueue([]);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should ignore null questions', () => {
      gate.enqueue(null);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should ignore undefined questions', () => {
      gate.enqueue(undefined);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should accumulate questions from multiple enqueues', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      jest.advanceTimersByTime(500);
      gate.enqueue([{ field: 'r1_plus_r2', circuit: 2 }]);

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback).toHaveBeenCalledWith([
        { field: 'zs', circuit: 1 },
        { field: 'r1_plus_r2', circuit: 2 },
      ]);
    });

    test('should clear pending questions after flush', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // After flush, no more sends even if we wait
      jest.advanceTimersByTime(5000);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('onNewUtterance', () => {
    test('should reset timer when questions are pending', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      // Advance 1s (not yet flushed — gate is 1.5s)
      jest.advanceTimersByTime(1000);
      expect(sendCallback).not.toHaveBeenCalled();

      // New utterance resets the 1.5s timer
      gate.onNewUtterance();

      // 1s after reset — still not flushed
      jest.advanceTimersByTime(1000);
      expect(sendCallback).not.toHaveBeenCalled();

      // 1.5s total after reset — now flushed
      jest.advanceTimersByTime(500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('should not reset timer when no questions are pending', () => {
      gate.onNewUtterance();
      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });
  });

  describe('resolveByFields', () => {
    test('should remove questions matching resolved fields', () => {
      gate.enqueue([
        { field: 'zs', circuit: 1 },
        { field: 'r1_plus_r2', circuit: 2 },
      ]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'r1_plus_r2', circuit: 2 }]);
    });

    test('should cancel timer when all questions resolved', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should handle questions with undefined field/circuit', () => {
      // A field-less question ("What was that?") now SURVIVES field-keyed
      // resolution because there's no `field` to check against. Old code
      // coerced `q.field || 'unknown'` and matched a synthetic
      // `unknown:unknown` key — but no real reading ever carries that key,
      // so the coincidence test was locking in undefined behaviour.
      // Post-2026-04-20 wildcard-guard: field-less questions aren't in
      // INSTALLATION_FIELDS and fall through to "keep" (correct — Sonnet
      // asked something without a field hook, we can't auto-resolve it).
      gate.enqueue([{ question: 'What was that?' }, { field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['unknown:unknown']));

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledWith([
        { question: 'What was that?' },
        { field: 'zs', circuit: 1 },
      ]);
    });

    test('should not remove questions for non-matching fields', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['r1_plus_r2:1']));

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
    });

    // Regression for 14 Chichester Road postcode double-ask (session EE0A697A,
    // 2026-04-20). Sonnet emitted {type:"unclear", field:"postcode", circuit:null}
    // but readings for installation fields land at circuit 0 → old code built
    // resolveKey "postcode:unknown" vs reading key "postcode:0" → miss →
    // pending question survived into the 2.5s flush → duplicate TTS ask.
    test('null-circuit question resolves against any circuit reading for same field', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode', circuit: null }]);

      gate.resolveByFields(new Set(['postcode:0']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('undefined-circuit question also resolves against any circuit reading', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode' }]); // circuit undefined

      gate.resolveByFields(new Set(['postcode:0']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('specific-circuit question is NOT resolved by a different circuit', () => {
      // Regression guard: null-circuit wildcard must not leak into
      // specific-circuit questions. A question about Zs on circuit 1 must
      // survive when only Zs on circuit 2 was resolved.
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['zs:2']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
    });

    test('circuit:0 question resolves against circuit 0 reading (latent 0-falsy bug)', () => {
      // Old code built key `${field}:${circuit || 'unknown'}` — 0 is falsy in
      // JS so circuit:0 coerced to "unknown". Fixed by explicit null/undefined
      // check.
      gate.enqueue([{ field: 'address', circuit: 0 }]);

      gate.resolveByFields(new Set(['address:0']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    // Regression guard for codex review finding (2026-04-20). The first cut of
    // the null-circuit fix wildcard-resolved EVERY null-circuit question,
    // which meant an orphan reading prompt like `{field: zs, circuit: null}`
    // — "I heard a Zs reading but don't know which circuit" — would be
    // silently dropped by any `zs:<N>` reading on a different circuit.
    // Wildcard must be gated to a whitelist of install-level fields only.
    test('null-circuit orphan on circuit-specific field is NOT wildcard-resolved', () => {
      gate.enqueue([{ type: 'unclear', field: 'zs', circuit: null, heard_value: '0.42' }]);

      // An unrelated zs:1 reading arrives — the orphan is about a DIFFERENT
      // reading whose circuit is still unknown. It must survive so the
      // inspector is eventually asked to assign it.
      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toEqual([
        { type: 'unclear', field: 'zs', circuit: null, heard_value: '0.42' },
      ]);
    });

    test('null-circuit orphan on circuit-specific field survives even same-circuit reading', () => {
      // Stronger guarantee: even a `zs:1` reading does not clear a null-circuit
      // zs orphan, because the orphan is semantically "which circuit?" and
      // cannot be answered by a reading on any specific circuit — only by an
      // explicit user reply.
      gate.enqueue([{ type: 'unclear', field: 'r1_plus_r2', circuit: null }]);

      gate.resolveByFields(new Set(['r1_plus_r2:3']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    // Regression guard for the "RG30 postcode" bug (session 6C475A3F,
    // 2026-04-20). Sonnet extracted `postcode:0` AND flagged the value as
    // partial with a same-turn question ("what's the rest of the postcode?").
    // The old call order in sonnet-stream.js was enqueue → resolveByFields,
    // which let the install-field wildcard in resolveByFields cancel Sonnet's
    // own same-turn question in the same millisecond — the inspector was
    // never asked.
    //
    // Fix: swap the order at both call sites so resolveByFields runs FIRST
    // (clearing prior-turn pending questions) and THEN enqueue adds this
    // turn's new questions. This test pins the correct order — if someone
    // re-swaps them, the test fails.
    test('same-turn question survives when resolve runs before enqueue', () => {
      // Simulate what sonnet-stream.js now does per turn:
      //   1. resolveByFields(this-turn readings)  — clears prior-turn Qs
      //   2. enqueue(this-turn questions)         — adds new Qs
      const resolved = new Set(['postcode:0']);
      gate.resolveByFields(resolved);
      gate.enqueue([
        {
          type: 'gap_fill',
          field: 'postcode',
          circuit: null,
          heard_value: 'RG30',
          question: 'What is the rest of the postcode?',
        },
      ]);

      jest.advanceTimersByTime(1500);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toEqual([
        {
          type: 'gap_fill',
          field: 'postcode',
          circuit: null,
          heard_value: 'RG30',
          question: 'What is the rest of the postcode?',
        },
      ]);
    });

    // Confirm the BROKEN order reproduces the bug. This test documents why
    // the swap matters: if enqueue runs first and resolveByFields runs
    // second, the same-turn question is silently dropped by the install
    // field wildcard. Kept as a guard so the gate's wildcard behaviour is
    // exercised both ways.
    test('same-turn question is dropped when enqueue runs before resolve (bug repro)', () => {
      gate.enqueue([
        {
          type: 'gap_fill',
          field: 'postcode',
          circuit: null,
          heard_value: 'RG30',
          question: 'What is the rest of the postcode?',
        },
      ]);
      gate.resolveByFields(new Set(['postcode:0']));

      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();
    });
  });

  describe('de-dupe within TTL', () => {
    test('suppresses identical question re-enqueued while pending', () => {
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      gate.enqueue([{ ...q }]); // identical signature

      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toHaveLength(1);
    });

    test('suppresses identical question re-enqueued shortly after flush', () => {
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // Sonnet re-emits the same question 3s later (turn N+1)
      jest.advanceTimersByTime(3000);
      gate.enqueue([{ ...q }]);
      jest.advanceTimersByTime(1500);
      // Should NOT have fired a second time — dupe suppressed
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('allows re-ask after both dedupe windows expire', () => {
      // Historically this test only needed to advance past the 15s tuple
      // TTL. After the secondary heard_value dedup (120s) landed, an
      // identical re-ask must now outlast BOTH windows to fire again —
      // else the heard_value map would keep it suppressed.
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // Past HEARD_VALUE_DEDUPE_TTL_MS (120s) — both TTLs have expired.
      jest.advanceTimersByTime(121000);
      gate.enqueue([{ ...q }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });

    test('different heard_value is treated as a distinct question', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode', heard_value: 'RG' }]);
      jest.advanceTimersByTime(1500);
      gate.enqueue([{ type: 'unclear', field: 'postcode', heard_value: 'SW1' }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });
  });

  // --- heard_value-only dedup (2026-04-24 session 0952EC64 repro) ---
  //
  // The tuple sig `type|field|circuit|heard_value` caught none of the three
  // 0.13 re-asks in that session because field/circuit differed. The
  // secondary map keys on `(type, normalised_heard_value)` with a 120s TTL.

  describe('heard_value re-ask suppression (secondary dedup)', () => {
    test('suppresses same type + same heard_value across different circuit sentinels', () => {
      // Repro: two `unclear` questions about 0.13 in quick succession with
      // different sentinel circuits (-1 then 0). Tuple sig differs; the
      // heard_value map catches the second.
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      gate.enqueue([{ type: 'unclear', field: null, circuit: 0, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('suppresses via normalisation: "0.130" heard_value matches earlier "0.13"', () => {
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      gate.enqueue([
        { type: 'unclear', field: null, circuit: -1, heard_value: '0.130' },
      ]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('different TYPE, same heard_value is NOT dedup\'d by the secondary map', () => {
      // `unclear` 0.13 then `circuit_disambiguation` 0.13 are semantically
      // different asks (one confusion, one disambiguation). The secondary
      // map key includes type so only same-type variants are suppressed.
      // Filter A handles the stored-value case in parallel; this test is
      // about gate behaviour only.
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      gate.enqueue([
        {
          type: 'circuit_disambiguation',
          field: 'r1_plus_r2',
          circuit: -1,
          heard_value: '0.13',
        },
      ]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });

    test('heard_value dedup survives beyond the 15s tuple TTL (120s horizon)', () => {
      // Jump 90s between asks — tuple TTL would have expired, but the
      // heard_value map keeps it dedup'd.
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(90000); // 90s — past 15s, before 120s
      gate.enqueue([{ type: 'unclear', field: null, circuit: 0, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('heard_value dedup expires after HEARD_VALUE_DEDUPE_TTL_MS', () => {
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);

      // Jump 125s — past the 120s heard_value TTL.
      jest.advanceTimersByTime(125000);
      gate.enqueue([{ type: 'unclear', field: null, circuit: 0, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });

    test('suppresses duplicate heard_value within the SAME enqueue batch', () => {
      // Protects against Sonnet emitting two versions of the same question
      // in one batch (e.g. after a tool-call retry).
      gate.enqueue([
        { type: 'unclear', field: null, circuit: -1, heard_value: '0.13' },
        { type: 'unclear', field: null, circuit: 0, heard_value: '0.13' },
      ]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toHaveLength(1);
    });

    test('no heard_value → secondary dedup does not fire', () => {
      // Questions with null heard_value participate only in the tuple sig
      // map. Two questions with different fields both fire.
      gate.enqueue([
        { type: 'unclear', field: 'postcode', circuit: 0, heard_value: null },
      ]);
      jest.advanceTimersByTime(1500);
      gate.enqueue([
        { type: 'unclear', field: 'address', circuit: 0, heard_value: null },
      ]);
      jest.advanceTimersByTime(1500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });

    test('destroy() clears the heard_value map too', () => {
      gate.enqueue([{ type: 'unclear', field: null, circuit: -1, heard_value: '0.13' }]);
      jest.advanceTimersByTime(1500);
      // Flush populated the map (entry per flushed question's heard_value).
      expect(gate.recentlyFlushedHeardValues.size).toBe(1);
      gate.destroy();
      expect(gate.recentlyFlushedHeardValues.size).toBe(0);
    });
  });

  describe('destroy', () => {
    test('should cancel pending timer', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.destroy();

      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should clear pending questions', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.destroy();

      expect(gate.pendingQuestions).toEqual([]);
      expect(gate.gateTimer).toBeNull();
    });
  });

  describe('flush', () => {
    test('should not call callback when no pending questions', () => {
      gate.flush();
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should send and clear pending questions', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.flush();

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
      expect(gate.pendingQuestions).toEqual([]);
    });
  });
});
