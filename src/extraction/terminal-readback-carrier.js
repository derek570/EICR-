/**
 * PLAN-A (feedback-2026-09-17) — the TERMINAL READ-BACK CARRIER's fold.
 *
 * A zero-import leaf holding the ONE combination rule, so the production site
 * (`sonnet-stream.js`, which folds the three dialogue-wrapper outcomes into the
 * harness options) and its test exercise the same code. A replica in the test
 * would pin nothing: it could agree with a wrong implementation.
 *
 * WHY A FOLD IS NEEDED AT ALL. The three wrappers run BEFORE
 * `runShadowHarness` creates the harness-local per-turn state, and a wrapper
 * outcome of `handled && !fallthrough` RETURNS without ever running the
 * harness. So nothing that depends on a harness drain can be the recovery for a
 * script read-back — the producer's own result has to travel out.
 */

/**
 * Combine the dialogue-wrapper outcomes of one turn.
 *
 * @param {Array<object|null|undefined>} outcomes — in WRAPPER-INVOCATION order:
 *   ring continuity, then insulation resistance, then protective device.
 * @returns {{built: boolean, emitted: boolean, lostTexts: string[], handoff: object|null}}
 */
export function foldTerminalReadbackOutcomes(outcomes) {
  let built = false;
  let anyBuilt = false;
  let allEmitted = true;
  const lostTexts = [];
  let handoff = null;
  for (const outcome of outcomes ?? []) {
    if (!outcome) continue;
    if (outcome.terminalReadbackBuilt === true) {
      built = true;
      anyBuilt = true;
      // `emitted` is an AND OVER THE CALLS THAT BUILT, never a uniform OR:
      // ORing lets one successful wrapper MASK another's failed send.
      if (outcome.terminalReadbackEmitted !== true) allEmitted = false;
    }
    // A call contributes its already-rendered line ONLY when it was
    // `built && !emitted`; the producer decides that and sets the field.
    if (typeof outcome.terminalReadbackLostText === 'string') {
      lostTexts.push(outcome.terminalReadbackLostText);
    }
    if (outcome.handoff && !handoff) handoff = outcome.handoff;
  }
  return {
    built,
    // THE ZERO-BUILT FLOOR. When NO call built, `emitted` is FALSE, not
    // vacuously true — `Array.prototype.every()` over an empty array returns
    // true, which would contradict the pinned no-capture case and silence every
    // downstream net on a turn that captured nothing.
    emitted: anyBuilt && allEmitted,
    lostTexts,
    handoff,
  };
}
