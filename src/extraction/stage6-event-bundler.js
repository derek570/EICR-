/**
 * Stage 6 Phase 2 Plan 02-05 — Event bundler (pure function).
 *
 * REQUIREMENTS: STD-09 (bundler produces legacy shape) + STI-02 (iOS sees a
 * single `extraction` message per turn, not N granular events).
 * RESEARCH: §Q10 "iOS Event Bundling" — the server wire protocol does NOT
 * change in Phase 2. iOS still receives one `{type:'extraction', result:{...}}`
 * per turn. Only the SOURCE of that result shifts: prose-JSON parse (legacy)
 * vs. aggregated tool-call outcomes (Phase 2 shadow; Phase 7+ live).
 * PITFALL MITIGATED: #3 "bundler fires mid-loop" — this module is intentionally
 * side-effect-free and called ONCE post-loop by Plan 02-06's shadow harness.
 *
 * This module imports NOTHING and performs NO side effects (no logger, no
 * ws.send, no session mutation). It is a pure projection of the per-turn
 * writes accumulator (Plan 02-02) plus a passthrough of the legacy result's
 * `questions` slot into the iOS wire shape.
 */

export const BUNDLER_PHASE = 2;

/**
 * Translate per-turn tool-call outcomes into the legacy `extraction` result
 * shape that iOS `ServerWebSocketService` expects.
 *
 * @param {{readings: Map<string, {value: any, confidence: number, source_turn_id?: string}>,
 *          cleared: Array<{field: string, circuit: string, reason?: string}>,
 *          observations: Array<{id: string, text: string, code: string}>,
 *          deletedObservations: Array<{id: string, reason?: string}>,
 *          circuitOps: Array<{op: string, circuit_ref: string, from_ref?: string, meta?: any}>}} perTurnWrites
 *   Accumulator populated by Phase 2 dispatchers (Plans 02-03 + 02-04).
 * @param {{questions?: Array<any>}|null|undefined} legacyResultShape
 *   The legacy extractor's result object. Only `.questions` is consumed
 *   (Phase 2 keeps legacy question-gate behaviour; tool-call ask_user is
 *   Phase 3+). If null/undefined, treated as `{}` so the bundler still
 *   produces a valid empty-questions shape even when the legacy path threw.
 * @returns {{extracted_readings: Array<{field: string, circuit: string, value: any, confidence: number, source: 'tool_call'}>,
 *            observations: Array<{id: string, text: string, code: string}>,
 *            questions: Array<any>,
 *            cleared_readings?: Array<{field: string, circuit: string, reason?: string}>,
 *            circuit_updates?: Array<{op: string, circuit_ref: string, from_ref?: string, meta?: any}>,
 *            observation_deletions?: Array<{id: string, reason?: string}>}}
 */
export function bundleToolCallsIntoResult(perTurnWrites, legacyResultShape) {
  if (!perTurnWrites || !(perTurnWrites.readings instanceof Map)) {
    throw new TypeError('bundleToolCallsIntoResult: perTurnWrites.readings must be a Map');
  }
  const legacy = legacyResultShape ?? {};

  // 1. Readings projection — Map → array. Key `${field}::${circuit}` splits
  //    to recover (field, circuit); value carries {value, confidence, ...}.
  //    Confidence is passed VERBATIM (dispatcher already applied ?? 1.0).
  //    Map.entries() preserves insertion order — STT-09 same-turn correction
  //    survives because the dispatcher overwrote the Map entry before we see it.
  //
  //    Codex Phase-2 review MAJOR #2 fix: the Map key is built via template
  //    literal (`${field}::${input.circuit}`) which coerces the original
  //    integer circuit_ref to a string. Legacy `extracted_readings[].circuit`
  //    is typed as integer at `eicr-extraction-session.js:992` (`circuit === -1`)
  //    and the STS-01..04 tool schemas all declare `circuit` / `circuit_ref`
  //    as `integer` (stage6-tool-schemas.js). Emitting a string here would
  //    make the slot comparator see a legitimate divergence whenever both
  //    paths record the same reading, and Phase 7's wire projection would
  //    drift from legacy. Parse the suffix back to an integer when it round-
  //    trips cleanly; fall back to the raw string otherwise (future-proof
  //    against a non-integer circuit_ref the schema doesn't currently allow).
  const extracted_readings = [];
  for (const [key, entry] of perTurnWrites.readings) {
    const sep = key.indexOf('::');
    const field = sep >= 0 ? key.slice(0, sep) : key;
    const circuitStr = sep >= 0 ? key.slice(sep + 2) : '';
    const circuitInt = Number(circuitStr);
    const circuit =
      circuitStr !== '' && Number.isInteger(circuitInt) && String(circuitInt) === circuitStr
        ? circuitInt
        : circuitStr;
    extracted_readings.push({
      field,
      circuit,
      value: entry.value,
      confidence: entry.confidence,
      source: 'tool_call',
    });
  }

  // 2-3. Observations + questions — defensive copies so downstream mutation
  //      cannot retroactively alter the bundled result.
  const result = {
    extracted_readings,
    observations: [...perTurnWrites.observations],
    questions: Array.isArray(legacy.questions) ? [...legacy.questions] : [],
  };

  // 4-6. New Phase 2 slots — OMITTED when empty so iOS decoders unaware of
  //      these keys see byte-identical traffic to today. Swift Codable
  //      ignores unknown keys, but omission keeps session logs clean.
  if (perTurnWrites.cleared.length > 0) {
    result.cleared_readings = [...perTurnWrites.cleared];
  }
  if (perTurnWrites.circuitOps.length > 0) {
    result.circuit_updates = [...perTurnWrites.circuitOps];
  }
  if (perTurnWrites.deletedObservations.length > 0) {
    result.observation_deletions = [...perTurnWrites.deletedObservations];
  }

  return result;
}
