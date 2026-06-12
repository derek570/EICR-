/**
 * stage6-early-terminate — round-1 early-terminate predicate.
 *
 * Single-round latency sprint, Phase 2 (PLAN_v8 §A Pivot 1 + §E).
 * 2026-05-28 widening: include `record_board_reading` and allow
 * N≥1 records (was strictly 1).
 *
 * Server-side decision: AFTER round-1's tool dispatch loop has run AND
 * pushed the real (non-empty) tool_results user message, SHOULD the
 * loop skip the round-2 Sonnet invocation?
 *
 * YES when all of the following hold:
 *   - No `is_error: true` tool_result this round (dispatcher accepted
 *     every call cleanly).
 *   - At least one streamed record, AND every record's name is in the
 *     allowed set `{record_reading, record_board_reading}`. Mixed
 *     turns (one of each) are allowed — they're the same dispatch
 *     class semantically (write a reading, then end_turn).
 *   - For `record_reading` records: the session must be single-board
 *     OR the inspector must be on the main board. Multi-board
 *     sessions doing record_reading still risk round-2 board-switch
 *     follow-up work, so we keep the conservative guard there.
 *     `record_board_reading` records bypass this guard because the
 *     dispatcher's `validateBoardScope` already enforces that they
 *     target the current board (any cross-board attempt surfaces as
 *     `is_error: true` and short-circuits the predicate above).
 *   - `perTurnWrites.readings.size` matches the count of
 *     `record_reading` records; `perTurnWrites.boardReadings.size`
 *     matches the count of `record_board_reading` records. Every
 *     streamed call must have actually written its bucket — partial
 *     writes mean the model's still mid-thought and round 2 may
 *     correct it.
 *   - All non-reading accumulator buckets are empty:
 *     `cleared`, `observations`, `circuitOps`, `boardOps`,
 *     `fieldCorrections` are all empty arrays.
 *
 * If ANY check fails, the loop continues normally and Sonnet round 2
 * runs as today.
 *
 * Hard null-safety: predicate must never throw. Anything malformed
 * returns false (conservative).
 *
 * Why widen now: production telemetry on 2026-05-28 showed
 * record_board_reading turns paying ~1.4-2.5 s of round-2 wall time
 * with the same clean-write shape as record_reading. Same predicate
 * shape, same safety profile — just a different bucket name in
 * perTurnWrites.
 *
 * Multi-record case: the previous predicate hard-capped at
 * records.length === 1, which excluded the common "two readings in
 * one utterance" pattern (e.g. measured_zs_ohm + r1_r2_ohm spoken
 * back-to-back). Allowing N≥1 records of the same allowed type is
 * safe because the dispatcher's per-record validation runs
 * independently — N clean writes are no more ambiguous than one,
 * just more of them.
 */

import { getMainBoardId } from './stage6-multi-board-shape.js';

const ALLOWED_TOOL_NAMES = new Set(['record_reading', 'record_board_reading']);

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
  if (!perTurnWrites.boardReadings || typeof perTurnWrites.boardReadings.size !== 'number') {
    return false;
  }

  // Any dispatcher error keeps round-2 in play (model may follow up).
  if (toolResults.some((tr) => tr && tr.is_error === true)) return false;

  // At least one record, all of allowed type.
  if (records.length === 0) return false;
  if (!records.every((r) => r && ALLOWED_TOOL_NAMES.has(r.name))) return false;

  // Tally per-tool counts; bucket sizes must match.
  let recordReadingCount = 0;
  let boardReadingCount = 0;
  for (const r of records) {
    if (r.name === 'record_reading') recordReadingCount += 1;
    else if (r.name === 'record_board_reading') boardReadingCount += 1;
  }
  if (perTurnWrites.readings.size !== recordReadingCount) return false;
  // 2026-06-12 — the bonding-continuity mirror (stage6-dispatchers-board.js
  // step 4b) appends a derived boardReadings entry with no corresponding
  // streamed tool call. Subtract derived entries from the parity check or
  // every clean bonding-service PASS turn would show size=N+1 vs count=N
  // and forfeit the round-1 early-terminate latency win on exactly the
  // utterance family the 2026-05-28 sprint optimised.
  let derivedBoardReadingCount = 0;
  if (typeof perTurnWrites.boardReadings.values === 'function') {
    for (const v of perTurnWrites.boardReadings.values()) {
      if (v && v.derived === true) derivedBoardReadingCount += 1;
    }
  }
  if (perTurnWrites.boardReadings.size - derivedBoardReadingCount !== boardReadingCount) {
    return false;
  }

  // Multi-board guard ONLY applies when at least one record_reading is
  // present. record_board_reading sessions are by definition multi-board
  // OR multi-board-ready, and the dispatcher's validateBoardScope already
  // rejects cross-board attempts as is_error (which short-circuits above).
  if (recordReadingCount > 0) {
    const boards = Array.isArray(snapshot.boards) ? snapshot.boards : [];
    if (boards.length > 1) return false;
    const mainBoardId = getMainBoardId(snapshot);
    if (mainBoardId && snapshot.currentBoardId && snapshot.currentBoardId !== mainBoardId) {
      return false;
    }
  }

  // Non-reading accumulators must all be empty — anything else in the
  // bucket means the dispatcher did work beyond a clean reading write,
  // and round 2 may need to confirm/finalise.
  if (Array.isArray(perTurnWrites.cleared) && perTurnWrites.cleared.length > 0) return false;
  if (Array.isArray(perTurnWrites.observations) && perTurnWrites.observations.length > 0) {
    return false;
  }
  if (Array.isArray(perTurnWrites.circuitOps) && perTurnWrites.circuitOps.length > 0) return false;
  if (Array.isArray(perTurnWrites.boardOps) && perTurnWrites.boardOps.length > 0) return false;
  if (Array.isArray(perTurnWrites.fieldCorrections) && perTurnWrites.fieldCorrections.length > 0) {
    return false;
  }

  return true;
}
