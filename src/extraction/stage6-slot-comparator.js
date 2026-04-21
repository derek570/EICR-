/**
 * Stage 6 Phase 2 Plan 02-06 — Shadow-mode slot comparator (pure functions).
 *
 * REQUIREMENTS: STT-03 (multi-round integration) + STO-01 (divergence
 * observability) + STS-01..06 strict-mode audit surface.
 * RESEARCH: §Q11 "Shadow divergence comparator in Phase 2". Phase 1 always
 * logged `divergent:false` (different shapes, no comparison). Phase 2 projects
 * both the legacy `extraction` result and the bundler output into a uniform
 * slot shape and runs set-diff + value-diff.
 *
 * WHY pure + zero imports: This module is consumed by Plan 02-06's shadow
 * harness AND by Phase 7's retrospective analyzer (offline batch over
 * stage6_divergence log rows). Keeping it free of runtime deps — no logger,
 * no side effects, no async — means both callers get the same contract with
 * zero wiring.
 *
 * ---------------------------------------------------------------------------
 * OBSERVATION UUID NORMALISATION
 * ---------------------------------------------------------------------------
 * Legacy path and tool-call path both generate their own crypto.randomUUID()
 * per observation. Comparing ids is meaningless — by design they differ. The
 * projection therefore STRIPS id and keys observations on `(code, text)`
 * only. observation_deletions DOES carry id as its payload (there is no
 * content to key on), but id diffs between the two paths are expected — we
 * expose the count/id set for informational logging but DO NOT feed it into
 * the `any` / `reason` decision.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * REASON PRIORITY (highest wins — first matching branch returned)
 * ---------------------------------------------------------------------------
 *   'identical'              — every slot matches. any:false.
 *   'value_mismatch'         — same slot key in both, different values.
 *   'dispatcher_strict_mode' — readings present in LEGACY but absent in TOOL,
 *                              AND no other divergence exists. Known-expected
 *                              divergence per Research §Q4 / OPEN_QUESTIONS.md:
 *                              legacy auto-creates unknown circuits; tool
 *                              dispatcher rejects them. Phase 7 analyzer
 *                              filters these rows OUT of regression signal.
 *   'extra_in_tool'          — slots present in TOOL but absent in LEGACY.
 *                              Unexpected under Phase 2 rules (dispatcher is
 *                              strictly ≤ legacy). Flags a real bug.
 *   'observation_set_diff'   — observation (code, text) sets differ.
 *   'circuit_ops_diff'       — circuit_ops sets differ.
 *   'extra_in_legacy'        — catch-all for readings-only-in-legacy combined
 *                              with another class of divergence; documented
 *                              for completeness though rarely selected.
 * ---------------------------------------------------------------------------
 */

/**
 * Project an extraction result (legacy OR bundler output) into a uniform
 * slot shape suitable for set-diff comparison.
 *
 * @param {object|null|undefined} result Extraction result. Missing / null /
 *   malformed inputs produce empty containers (never throws).
 * @returns {{
 *   readings: Map<string, any>,
 *   cleared: Set<string>,
 *   observations: Set<string>,
 *   circuit_ops: Set<string>,
 *   observation_deletions: Set<string>,
 * }}
 *   readings: key `${field}::${circuit}`, value is the reading's `value`.
 *   cleared: `${field}::${circuit}` tuples (legacy never emits this slot).
 *   observations: `${code ?? 'none'}::${text.trim()}` tuples, UUID stripped.
 *   circuit_ops: `${op}::${circuit_ref}` tuples (create/rename/update).
 *   observation_deletions: id strings (informational only — ids differ by design).
 */
export function projectSlots(result) {
  const readings = new Map();
  const cleared = new Set();
  const observations = new Set();
  const circuit_ops = new Set();
  const observation_deletions = new Set();

  if (!result || typeof result !== 'object') {
    return { readings, cleared, observations, circuit_ops, observation_deletions };
  }

  // Readings — present in both legacy and bundler output.
  if (Array.isArray(result.extracted_readings)) {
    for (const r of result.extracted_readings) {
      if (!r || typeof r !== 'object') continue;
      const field = r.field ?? '';
      const circuit = r.circuit ?? '';
      readings.set(`${field}::${circuit}`, r.value);
    }
  }

  // Cleared readings — new Phase 2 slot. Legacy never emits it; bundler
  // emits only when non-empty (Plan 02-05 omission rule).
  if (Array.isArray(result.cleared_readings)) {
    for (const c of result.cleared_readings) {
      if (!c || typeof c !== 'object') continue;
      cleared.add(`${c.field ?? ''}::${c.circuit ?? ''}`);
    }
  }

  // Observations — legacy + bundler. STRIP id (different UUIDs per path).
  if (Array.isArray(result.observations)) {
    for (const o of result.observations) {
      if (!o || typeof o !== 'object') continue;
      const code = o.code ?? 'none';
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      observations.add(`${code}::${text}`);
    }
  }

  // Circuit ops — new Phase 2 slot.
  if (Array.isArray(result.circuit_updates)) {
    for (const op of result.circuit_updates) {
      if (!op || typeof op !== 'object') continue;
      circuit_ops.add(`${op.op ?? 'unknown'}::${op.circuit_ref ?? ''}`);
    }
  }

  // Observation deletions — informational; ids not compared for parity.
  if (Array.isArray(result.observation_deletions)) {
    for (const d of result.observation_deletions) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.id === 'string') observation_deletions.add(d.id);
    }
  }

  return { readings, cleared, observations, circuit_ops, observation_deletions };
}

// ---------------------------------------------------------------------------
// Internal set / map diff helpers — no external deps.
// ---------------------------------------------------------------------------

/**
 * Keys in `a` that are NOT in `b`. Works on both Set<string> and
 * Map<string, any>: for Maps we iterate `a.keys()` explicitly so we get
 * key strings (not [key, value] entries from the default iterator).
 */
function setOnlyIn(a, b) {
  const out = [];
  const keys = typeof a.keys === 'function' ? a.keys() : a;
  for (const k of keys) if (!b.has(k)) out.push(k);
  return out;
}

function mapValueMismatch(aMap, bMap) {
  const out = [];
  for (const [k, v] of aMap) {
    if (bMap.has(k) && !looseEqual(v, bMap.get(k))) {
      out.push({ key: k, legacy_value: v, tool_value: bMap.get(k) });
    }
  }
  return out;
}

/**
 * Loose value equality: strings/numbers compared via ==, objects via
 * JSON.stringify (sufficient for reading.value which is a scalar). Null ≠
 * undefined.
 */
function looseEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  // eslint-disable-next-line eqeqeq
  return a == b;
}

/**
 * Compare two extraction results slot-by-slot.
 *
 * @param {object} legacy    Legacy `extractFromUtterance` result.
 * @param {object} toolResult Bundler output (Plan 02-05).
 * @returns {{
 *   any: boolean,
 *   reason: string,
 *   legacy_slots: ReturnType<projectSlots>,
 *   tool_slots: ReturnType<projectSlots>,
 *   details: {
 *     readings_value_mismatch: Array<{key, legacy_value, tool_value}>,
 *     readings_only_legacy: Array<string>,
 *     readings_only_tool: Array<string>,
 *     observations_diff: {added_in_tool: string[], removed_in_tool: string[]},
 *     circuit_ops_diff: {added_in_tool: string[], removed_in_tool: string[]},
 *   },
 * }}
 */
export function compareSlots(legacy, toolResult) {
  const legacy_slots = projectSlots(legacy);
  const tool_slots = projectSlots(toolResult);

  const readings_value_mismatch = mapValueMismatch(legacy_slots.readings, tool_slots.readings);
  const readings_only_legacy = setOnlyIn(legacy_slots.readings, tool_slots.readings);
  const readings_only_tool = setOnlyIn(tool_slots.readings, legacy_slots.readings);

  const obs_added = setOnlyIn(tool_slots.observations, legacy_slots.observations);
  const obs_removed = setOnlyIn(legacy_slots.observations, tool_slots.observations);

  const ops_added = setOnlyIn(tool_slots.circuit_ops, legacy_slots.circuit_ops);
  const ops_removed = setOnlyIn(legacy_slots.circuit_ops, tool_slots.circuit_ops);

  // Cleared set: legacy never emits cleared, so any cleared entry in tool
  // counts as extra_in_tool (handled under reason priority below).
  const cleared_only_tool = setOnlyIn(tool_slots.cleared, legacy_slots.cleared);

  const details = {
    readings_value_mismatch,
    readings_only_legacy,
    readings_only_tool,
    observations_diff: { added_in_tool: obs_added, removed_in_tool: obs_removed },
    circuit_ops_diff: { added_in_tool: ops_added, removed_in_tool: ops_removed },
  };

  const hasValueMismatch = readings_value_mismatch.length > 0;
  const hasOnlyLegacyReadings = readings_only_legacy.length > 0;
  const hasOnlyToolReadings = readings_only_tool.length > 0;
  const hasObsDiff = obs_added.length > 0 || obs_removed.length > 0;
  const hasOpsDiff = ops_added.length > 0 || ops_removed.length > 0;
  const hasClearedOnlyTool = cleared_only_tool.length > 0;

  const anyDivergence =
    hasValueMismatch ||
    hasOnlyLegacyReadings ||
    hasOnlyToolReadings ||
    hasObsDiff ||
    hasOpsDiff ||
    hasClearedOnlyTool;

  if (!anyDivergence) {
    return { any: false, reason: 'identical', legacy_slots, tool_slots, details };
  }

  // Reason priority — first match wins.

  // 1. value_mismatch — same slot key in both, different values. Genuine
  //    regression signal.
  if (hasValueMismatch) {
    return { any: true, reason: 'value_mismatch', legacy_slots, tool_slots, details };
  }

  // 2. dispatcher_strict_mode — ONLY difference is readings-only-legacy AND
  //    no other divergence class. Known-expected per Research §Q4.
  if (
    hasOnlyLegacyReadings &&
    !hasOnlyToolReadings &&
    !hasObsDiff &&
    !hasOpsDiff &&
    !hasClearedOnlyTool
  ) {
    return { any: true, reason: 'dispatcher_strict_mode', legacy_slots, tool_slots, details };
  }

  // 3. extra_in_tool — tool wrote slots legacy didn't. Covers both readings
  //    and cleared (legacy never emits cleared, so cleared-in-tool counts
  //    here when nothing else diverges).
  if (hasOnlyToolReadings || hasClearedOnlyTool) {
    return { any: true, reason: 'extra_in_tool', legacy_slots, tool_slots, details };
  }

  // 4. observation_set_diff — observation (code, text) sets differ.
  if (hasObsDiff) {
    return { any: true, reason: 'observation_set_diff', legacy_slots, tool_slots, details };
  }

  // 5. circuit_ops_diff — circuit_ops sets differ.
  if (hasOpsDiff) {
    return { any: true, reason: 'circuit_ops_diff', legacy_slots, tool_slots, details };
  }

  // 6. extra_in_legacy — catch-all for readings-only-in-legacy combined with
  //    something else that wasn't selected above. Rare; present for
  //    completeness so the reason namespace is closed.
  return { any: true, reason: 'extra_in_legacy', legacy_slots, tool_slots, details };
}
