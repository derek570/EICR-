/**
 * Plan 00B (live-lane follow-ups) C3 — ONE shared capture/row budget for the
 * whole Plan-00 evidence lane.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every per-session evidence collection in the lane is append-only and grows
 * with the SESSION, not with a turn: lifecycle sub-records, the ask ledger's
 * entries and their per-entry `history` arrays, the delivery ledger's
 * deliveries/provisionals/playbacks/ambiguity set, the NESTED per-provisional
 * `staged_acks` array, the mutation observer's receipts/correlation/overlay
 * maps, and the evaluation context's binding maps. A genuinely long
 * production session (a full inspection day on one socket) therefore had no
 * upper bound on evidence memory, and the nested `staged_acks` case could
 * grow without adding a single top-level row — so a row count alone could
 * never have seen it.
 *
 * WHAT IT DOES
 * ------------
 * ONE counter, shared by every collection, with capacity RESERVED for exactly
 * one overflow marker row:
 *
 *  - `admit(site)` returns true while the budget holds and false forever
 *    after. Callers that get `false` skip their evidence write ONLY —
 *    production control flow, production counters and the production return
 *    contract are untouched (an evidence-side skip must never be visible to
 *    the inspector).
 *  - The FIRST refusal fires the single registered overflow sink exactly
 *    once. The lifecycle adapter uses that sink to append the one reserved
 *    `capture_budget_overflow` row, latch the evidence INVALID, and emit the
 *    one bounded telemetry line. Every later refusal is silent.
 *
 * WHY A LATCH AND NOT A RING BUFFER
 * ---------------------------------
 * An evidence stream that silently DROPS its oldest rows would still fold as
 * complete while being provably incomplete — the same defect class as 00B-3's
 * uncreditable rows. Stopping and latching INVALID is the fail-closed choice:
 * the session keeps working, its evidence simply earns zero family credit.
 */

/**
 * The closed set of capture sites that may spend the budget. Enumerated (and
 * test-pinned) so a NEW unbounded collection has to be declared here rather
 * than quietly sharing an existing site's name.
 */
export const PLAN00_CAPTURE_SITES = Object.freeze([
  // src/extraction/plan00-lifecycle-hooks.js
  'lifecycle_row',
  'ask_runtime_binding',
  'srv_answer_half',
  'non_mutating_audible',
  'delivery_claimed_receipt',
  'recovery_lineage',
  'address_mirror_unit',
  'fast_tts_reservation',
  'delivery_prepared',
  // src/extraction/plan00-audibility-ledgers.js
  'ask_entry',
  'ask_history',
  'delivery_row',
  'ambiguous_op_key',
  'provisional',
  'staged_ack',
  'playback_row',
  // src/extraction/plan00-semantic-capture.js
  'mutation_receipt',
  'fast_correlation_turn',
  'journal_overlay',
]);

/**
 * Total admitted capture writes per session, across ALL collections.
 *
 * Deliberately conservative: a long real session's evidence lands in the low
 * thousands of writes (each dictated reading contributes a handful of
 * lifecycle rows plus at most one delivery/playback/receipt each), so 20 000
 * leaves better than an order of magnitude of headroom over the worst
 * observed traffic while still bounding a pathological loop. The number is
 * test-pinned: changing it is a reviewed decision, not a tuning knob.
 */
export const PLAN00_CAPTURE_ROW_BUDGET = 20000;

/** The single reserved row kind minted when the budget is exhausted. */
export const CAPTURE_BUDGET_OVERFLOW_KIND = 'capture_budget_overflow';

/**
 * Create one shared budget. Every evidence role in a session adopts the SAME
 * instance (see `normaliseEvaluationContext`), so the bound is on total
 * evidence memory rather than per-collection — a per-collection cap would let
 * N collections multiply the ceiling by N.
 */
export function createCaptureBudget({ limit = PLAN00_CAPTURE_ROW_BUDGET } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : PLAN00_CAPTURE_ROW_BUDGET;
  let admitted = 0;
  let overflowed = false;
  let sink = null;
  let sinkFired = false;

  return {
    get limit() {
      return cap;
    },
    get admitted() {
      return admitted;
    },
    get overflowed() {
      return overflowed;
    },
    /**
     * Register the single overflow sink. FIRST-WINS — a second registration
     * is ignored, so the "exactly one marker row, exactly one telemetry
     * line" contract cannot be broken by a re-attached context.
     */
    onFirstOverflow(fn) {
      if (!sink && typeof fn === 'function') sink = fn;
    },
    /**
     * Ask for one capture slot. `true` ⇒ the caller may grow its evidence
     * collection. `false` ⇒ the budget is spent; skip the evidence write and
     * carry on with production work unchanged.
     */
    admit(site) {
      if (overflowed) return false;
      if (admitted < cap) {
        admitted += 1;
        return true;
      }
      overflowed = true;
      if (sink && !sinkFired) {
        sinkFired = true;
        try {
          sink({ site: typeof site === 'string' ? site : null, limit: cap, admitted });
        } catch (_err) {
          // Behaviour isolation, same contract as the observer callbacks: an
          // evidence sink that throws must never reach a production path.
        }
      }
      return false;
    },
  };
}

/**
 * Shared adoption helper. Each evidence role constructs its own PRIVATE
 * budget so it is bounded even when used standalone (tests, the eval lane's
 * hand-built shapes), then adopts the session-shared instance exactly once
 * when an evaluation context normalises it. First-wins: a role never swaps
 * budgets mid-session, which would reset the ceiling.
 */
export function makeBudgetHolder() {
  let budget = createCaptureBudget();
  let adopted = false;
  return {
    get current() {
      return budget;
    },
    adopt(shared) {
      if (adopted || !shared || typeof shared.admit !== 'function') return;
      adopted = true;
      budget = shared;
    },
  };
}
