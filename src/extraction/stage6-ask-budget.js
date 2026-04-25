/**
 * Stage 6 Phase 5 Plan 05-03 — per-session ask counter for STA-06.
 *
 * Map-backed per-key counter. One instance per session, owned by
 * activeSessions.get(id).askBudget. Pure module — zero imports, no logger,
 * no WS handle, no field/circuit awareness. The wrapper (Plan 05-01) owns
 * key normalisation via deriveAskKey; this module treats keys as opaque
 * strings.
 *
 * Why a separate module from stage6-pending-asks-registry.js (Plan 03-01):
 *   That registry is a deferred-Promise broker (r21 finally closed under
 *   Codex STG #3 review). Counting is a different concern; mixing them
 *   would re-open the Codex lifecycle review surface.
 *
 * Why a separate module from stage6-restrained-mode.js (Plan 05-04):
 *   Two orthogonal invariants — per-key ask cap (STA-06) vs session-wide
 *   restrained-mode state machine (STB-02). Combining muddles the Codex
 *   STG review surface (SC #9).
 *
 * Boundary contract (locked by stage6-ask-budget.test.js Group 2 test 2):
 *   isExhausted(key) returns true when counts.get(key) >= maxAsksPerKey.
 *   The wrapper checks isExhausted BEFORE invoking the inner dispatcher,
 *   then increments on a successful dispatch (pre-register semantics per
 *   Plan 05-01). With the default maxAsksPerKey=2, the 1st and 2nd asks
 *   fire (counts 0 → 1, 1 → 2) and the 3rd short-circuits with
 *   answer_outcome='ask_budget_exhausted'.
 *
 * Reset semantics (STA-06 + Open Question #2 lock):
 *   Budget is destroyed only on session termination — handleSessionStop
 *   and ws.on('close') disconnect-delete. Reconnect (STR-01: same session,
 *   new socket) PRESERVES the budget — otherwise hang-up + reconnect would
 *   reset the 2-ask cap.
 *
 * Requirements: STA-06, STB-04, STB-05.
 */

/**
 * Factory. Call once per session.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxAsksPerKey=2]  Cap before isExhausted flips true.
 * @returns {{
 *   isExhausted: (key: string) => boolean,
 *   increment: (key: string) => void,
 *   getCount: (key: string) => number,
 *   destroy: () => void,
 *   _snapshot: () => Record<string, number>,
 * }}
 */
export function createAskBudget({ maxAsksPerKey = 2 } = {}) {
  const counts = new Map();

  return {
    isExhausted(key) {
      return (counts.get(key) ?? 0) >= maxAsksPerKey;
    },
    increment(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    getCount(key) {
      return counts.get(key) ?? 0;
    },
    destroy() {
      // Idempotent — clear on an empty Map is a no-op. Matches the Phase 3
      // pendingAsks rejectAll idempotency contract so termination paths
      // can be order-independent and survive double-close races.
      counts.clear();
    },
    _snapshot() {
      // Object.fromEntries breaks the Map reference; consumers (tests +
      // Plan 05-06 logger) cannot leak writes back into internal state.
      return Object.fromEntries(counts);
    },
  };
}
