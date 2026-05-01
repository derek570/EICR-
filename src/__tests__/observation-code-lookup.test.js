/**
 * observation-code-lookup.test.js
 *
 * Locks the contract of the BPG4 / BS 7671 refinement pipeline restored on
 * 2026-05-01:
 *   - `needsRefinement` is now an always-true gate (modulo empty/short text).
 *     The legacy "skip if Sonnet already nailed it" heuristic was removed
 *     because the value-add now includes a professional-text rewrite that
 *     should always run.
 *   - `refineObservation` returns four refined fields on success:
 *     `code`, `regulation`, `schedule_item`, `professional_text` — plus
 *     `rationale` and `source` for audit.
 *   - schedule_item is validated to a section-number shape (e.g. "5.12.1").
 *     Free-text returns get rejected and surface as null rather than
 *     pollute iOS's ObservationScheduleLinker.
 *   - professional_text is bounded (8..500 chars). Out-of-bounds values
 *     fall back to null so callers send the original text instead of a
 *     blank or runaway rewrite.
 */

import { jest } from '@jest/globals';
import { needsRefinement, refineObservation } from '../extraction/observation-code-lookup.js';

describe('needsRefinement (always-refine gate)', () => {
  test('returns true for any observation with usable text', () => {
    expect(
      needsRefinement({
        observation_text: 'Bonding clamp missing on copper gas pipe',
        code: 'C2',
        regulation: 'Reg 411.3.1.2 — Protective bonding conductors',
        confidence: 'high',
      })
    ).toBe(true);
  });

  test('returns true even when Sonnet looked confident — the rewrite is the new value-add', () => {
    // Pre-2026-05-01 this returned false (early-exit on confident Sonnet).
    // Post-restore, refinement always runs to produce professional_text.
    expect(
      needsRefinement({
        observation_text: 'Outdoor socket has no RCD protection on the kitchen ring final',
        code: 'C2',
        regulation: 'Reg 411.3.3 — Additional protection for socket-outlets up to 32A',
        confidence: 'high',
      })
    ).toBe(true);
  });

  test('returns false for empty / too-short text (no value to refine)', () => {
    expect(needsRefinement({ observation_text: '' })).toBe(false);
    expect(needsRefinement({ observation_text: 'short' })).toBe(false); // <8 chars
    expect(needsRefinement({ observation_text: null })).toBe(false);
  });

  test('returns false for non-object input', () => {
    expect(needsRefinement(null)).toBe(false);
    expect(needsRefinement(undefined)).toBe(false);
    expect(needsRefinement('string')).toBe(false);
  });
});

describe('refineObservation — return shape', () => {
  function makeOpenAI(content) {
    return {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{ message: { content } }],
            usage: { completion_tokens: 120 },
          }),
        },
      },
    };
  }

  test('returns code + regulation + schedule_item + professional_text on a complete response', async () => {
    const openai = makeOpenAI(
      JSON.stringify({
        professional_text:
          'Outdoor socket-outlet rated up to 32A on kitchen ring lacks 30mA RCD additional protection.',
        code: 'C2',
        regulation: 'Reg 411.3.3 — Additional protection for socket-outlets rated up to 32A',
        schedule_item: '5.12.1',
        rationale: 'BPG4 7.1 codes missing 30mA RCD on outdoor sockets as C2.',
        source: 'BPG4 Issue 7.1 Table 4',
      })
    );
    const refined = await refineObservation(openai, {
      observation_text: 'No RCD on the outside socket in the kitchen ring',
    });
    expect(refined).toMatchObject({
      code: 'C2',
      schedule_item: '5.12.1',
      professional_text: expect.stringContaining('30mA RCD'),
    });
    expect(refined.regulation).toContain('411.3.3');
  });

  test('schedule_item: rejects free-text shapes and returns null', async () => {
    const openai = makeOpenAI(
      JSON.stringify({
        professional_text: 'Damaged enclosure observed at consumer unit.',
        code: 'C3',
        regulation: 'Reg 134.1.1 — Good workmanship',
        schedule_item: 'see notes', // garbage shape — must not pass through
      })
    );
    const refined = await refineObservation(openai, {
      observation_text: 'Smashed plastic on the consumer unit cover',
    });
    expect(refined.schedule_item).toBeNull();
  });

  test('schedule_item: null in response stays null (no section applies)', async () => {
    const openai = makeOpenAI(
      JSON.stringify({
        professional_text: 'General installation note.',
        code: 'C3',
        regulation: 'Reg 134.1.1',
        schedule_item: null,
      })
    );
    const refined = await refineObservation(openai, {
      observation_text: 'Some installation note worth flagging',
    });
    expect(refined.schedule_item).toBeNull();
  });

  test('professional_text: out-of-bounds rewrite falls back to null (caller will use original)', async () => {
    const openai = makeOpenAI(
      JSON.stringify({
        professional_text: 'short', // <8 chars
        code: 'C3',
        regulation: 'Reg 134.1.1',
        schedule_item: null,
      })
    );
    const refined = await refineObservation(openai, {
      observation_text: 'Some defect that needs writing up properly',
    });
    expect(refined.professional_text).toBeNull();
  });

  test('returns null on invalid code (refinement unsafe — caller leaves the observation alone)', async () => {
    const openai = makeOpenAI(
      JSON.stringify({
        professional_text: 'Whatever',
        code: 'X9', // not in VALID_CODES
        regulation: 'Reg 411.3.3',
      })
    );
    const refined = await refineObservation(openai, {
      observation_text: 'Some defect description',
    });
    expect(refined).toBeNull();
  });

  test('returns null when openai client is missing (defence in depth)', async () => {
    const refined = await refineObservation(null, {
      observation_text: 'Some defect description',
    });
    expect(refined).toBeNull();
  });
});
