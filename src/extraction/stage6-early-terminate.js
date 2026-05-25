/**
 * stage6-early-terminate — round-1 early-terminate predicate.
 *
 * Single-round latency sprint, Phase 2 (PLAN_v8 §A Pivot 1 + §E).
 *
 * Server-side decision: AFTER round-1's tool dispatch loop has run AND
 * pushed the real (non-empty) tool_results user message, SHOULD the
 * loop skip the round-2 Sonnet invocation?
 *
 * YES when all of the following hold:
 *   - No `is_error: true` tool_result this round (dispatcher accepted
 *     every call cleanly).
 *   - Single-board session (`boards.length === 1`) AND currentBoardId
 *     resolves to the main board id. Multi-board sessions are
 *     conservatively excluded — round 2 sometimes does board-switch
 *     follow-up work.
 *   - Exactly one streamed record (`records.length === 1`) AND that
 *     record's name is `record_reading`. No other tool variants
 *     allowed (no record_board_reading, no record_observation, no
 *     ask_user, no create_circuit, no clear_reading, no batch).
 *   - `perTurnWrites.readings.size === 1` (the dispatcher actually
 *     wrote the slot — not just attempted).
 *   - All other accumulator buckets are empty:
 *     `cleared`, `observations`, `circuitOps`, `boardOps`,
 *     `fieldCorrections` are all empty arrays, and
 *     `boardReadings` is an empty Map.
 *
 * If ANY check fails, the loop continues normally and Sonnet round 2
 * runs as today.
 *
 * Hard null-safety: predicate must never throw. Anything malformed
 * returns false (conservative).
 *
 * This predicate is conservative by design. The dominant 70%+ turn
 * shape (clean numeric record_reading) hits the YES branch; everything
 * else takes the safe path. Anything in scope to broaden is a separate
 * sprint.
 */

import { getMainBoardId } from './stage6-multi-board-shape.js';

/**
 * @param {Object} args
 * @param {Array<Object>} args.records       — assembler.finalize() records[]
 * @param {Array<Object>} args.toolResults   — tool_result content blocks (with is_error flags)
 * @param {Object} args.perTurnWrites        — Stage 6 per-turn accumulator (readings: Map, etc.)
 * @param {Object} args.session              — live session with stateSnapshot
 * @returns {boolean}
 */
export function shouldEarlyTerminate({ records, toolResults, perTurnWrites, session }) {
  // Null-safety
  if (!session || typeof session !== 'object') return false;
  const snapshot = session.stateSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (!Array.isArray(records) || !Array.isArray(toolResults)) return false;
  if (!perTurnWrites || typeof perTurnWrites !== 'object') return false;
  if (!perTurnWrites.readings || typeof perTurnWrites.readings.size !== 'number') return false;

  // Any dispatcher error keeps round-2 in play (model may follow up).
  if (toolResults.some((tr) => tr && tr.is_error === true)) return false;

  // Multi-board guard. Both single-board AND on-main-board required.
  const boards = Array.isArray(snapshot.boards) ? snapshot.boards : [];
  if (boards.length > 1) return false;
  const mainBoardId = getMainBoardId(snapshot);
  if (mainBoardId && snapshot.currentBoardId && snapshot.currentBoardId !== mainBoardId) {
    return false;
  }

  // Records must be exactly one record_reading.
  if (records.length !== 1) return false;
  if (records[0].name !== 'record_reading') return false;

  // Per-turn writes must have exactly one reading, nothing else.
  if (perTurnWrites.readings.size !== 1) return false;
  if (Array.isArray(perTurnWrites.cleared) && perTurnWrites.cleared.length > 0) return false;
  if (Array.isArray(perTurnWrites.observations) && perTurnWrites.observations.length > 0)
    return false;
  if (Array.isArray(perTurnWrites.circuitOps) && perTurnWrites.circuitOps.length > 0) return false;
  if (Array.isArray(perTurnWrites.boardOps) && perTurnWrites.boardOps.length > 0) return false;
  if (Array.isArray(perTurnWrites.fieldCorrections) && perTurnWrites.fieldCorrections.length > 0) {
    return false;
  }
  if (
    perTurnWrites.boardReadings &&
    typeof perTurnWrites.boardReadings.size === 'number' &&
    perTurnWrites.boardReadings.size > 0
  ) {
    return false;
  }

  return true;
}
