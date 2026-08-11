/**
 * Plan 08B (A6a) — the rendered agentic prompt names the sole `'*'` acceptor
 * EXPLICITLY, and says the two calculators reject it.
 *
 * WHY: `set_field_for_all_circuits`, `calculate_zs` and `calculate_r1_plus_r2`
 * are three adjacent bulk tools that all take `board_id`. Exactly one of them
 * accepts the `'*'` cross-board wildcard; the other two reject it
 * (`board_id_star_unsupported`, from `validateCalculateBoardTarget`). The
 * prompt used to convey that distinction with a positional qualifier — it
 * listed the three tools and then said "(and `'*'` for cross-board sweep on
 * the last)". "The last" is a property of the sentence, not of the tool, so it
 * survives no reordering and communicates nothing about WHY. Naming the tool
 * and stating the rejection makes the boundary readable.
 *
 * ASSERTED SEMANTICALLY, NOT BYTE-FOR-BYTE: a full-sentence pin would break on
 * any legitimate future prompt edit while detecting nothing a targeted
 * assertion misses.
 *
 * BOTH RENDER VARIANTS: the clause lives in the SHARED region of
 * `sonnet_agentic_system.md` — after the `<!--/A1:ON-->` marker and before the
 * next `<!--A1:OFF-->` — so the marker-stripping loop in
 * `eicr-extraction-session.js` emits it in both the agentic-answers-enabled
 * and -disabled renders. If a future edit moves it into a gated region, these
 * tests fail on one variant and that is the correct alarm.
 */

import { renderAgenticSystemPrompt } from '../extraction/eicr-extraction-session.js';

const VARIANTS = [
  ['agentic answers ENABLED', true],
  ['agentic answers DISABLED', false],
];

describe.each(VARIANTS)('star-wildcard clause — %s', (_label, agenticAnswersEnabled) => {
  const prompt = renderAgenticSystemPrompt(agenticAnswersEnabled);

  test('set_field_for_all_circuits is named as the sole "*" acceptor, non-positionally', () => {
    // The tool name and the wildcard must appear in one statement. A loose
    // assertion (both strings present somewhere in a 200-line prompt) would
    // have passed against the old positional wording too, and so would have
    // accepted exactly the text this edit exists to remove.
    expect(prompt).toMatch(
      /`?set_field_for_all_circuits`?[^.\n]*(?:accepts|takes)[^.\n]*(?:`'\*'`|'\*'|"\*"|\*)/
    );
  });

  test('both calculators are named as REJECTING "*"', () => {
    expect(prompt).toMatch(
      /(?:`?calculate_zs`?[^.\n]*`?calculate_r1_plus_r2`?|`?calculate_r1_plus_r2`?[^.\n]*`?calculate_zs`?)[^.\n]*(?:REJECT|reject)/
    );
  });

  test('the positional qualifier "on the last" is gone', () => {
    expect(prompt).not.toContain('on the last');
  });

  test('all three bulk tools are still named (the clause cannot be gutted)', () => {
    // Green before this plan as well as after — kept so a later "tighten the
    // prompt" edit cannot quietly drop a tool from the boundary statement.
    expect(prompt).toContain('set_field_for_all_circuits');
    expect(prompt).toContain('calculate_zs');
    expect(prompt).toContain('calculate_r1_plus_r2');
  });
});
