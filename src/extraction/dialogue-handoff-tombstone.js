/**
 * PLAN-A (feedback-2026-09-17, ids 140/141/143) — the HANDOFF TOMBSTONE.
 *
 * A ZERO-IMPORT leaf, deliberately. Three modules read or write this map and
 * they live on opposite sides of the dependency graph: the dialogue engine
 * (which writes it at the terminating handoff and reads it at
 * `start_dialogue_script`), the shadow harness (the post-dispatch entry hook)
 * and the circuit dispatcher (the rename migration). Putting the key builder
 * here is what lets all three share ONE definition without the dispatcher
 * importing the engine, which would close a cycle through the tool schemas.
 *
 * The map is session-scoped and NEVER persisted. It survives `clearScriptState`
 * — which is the whole point, since the tombstone exists precisely to outlive
 * the script it ends.
 *
 * BOARD NORMALISATION: every caller resolves its board through
 * `resolveEffectiveBoardId` BEFORE calling in here. No function in this file
 * resolves a board, so there is exactly one place that formula can live and
 * exactly one way for a writer and a reader to disagree — which is none.
 */

// ── PLAN-A (feedback-2026-09-17) — the HANDOFF TOMBSTONE ────────────────────
//
// Key: (effective board id, schema name, circuit_ref), held in
// `session.dialogueScriptHandoffs` — a session-scoped Map shaped like
// `dialogueScriptDeferredSlots` above, NEVER persisted. Written by the
// terminating handoff; read by the two re-entry paths.
//
// WHY IT EXISTS rather than relying on clearing the script. Clearing is not
// enough: `tryEnterScriptFromWrites` guards only `script_already_active`, and
// the post-dispatch entry hook runs it on EVERY turn carrying
// `extracted_readings`. So a write-only handoff outcome (state null,
// `modelHoldsFloor` false) would call `initScriptState` and `askNextOrFinish` —
// a fresh script asking the next missing slot on the very circuit just handed
// off, which is the loop this plan exists to end. `start_dialogue_script` is a
// second path, and `already_active` cannot apply when the state is null.
//
// The model is also TOLD in the handoff note not to call
// `start_dialogue_script` for the handed-off circuit. The tombstone makes that
// a guarantee rather than an instruction.
//
// BOARD NORMALISATION, stated once and inherited by every row: every writer and
// every reader resolves its board through the SAME `resolveEffectiveBoardId`
// call. No caller may substitute a raw `currentBoardId` read — see
// `initScriptState` for why that would break the key silently.
export function handoffKey(effectiveBoardId, schemaName, circuit_ref) {
  return `${effectiveBoardId ?? 'main'}::${schemaName}::${circuit_ref ?? 'none'}`;
}

export function ensureHandoffMap(session) {
  if (!session) return null;
  if (!(session.dialogueScriptHandoffs instanceof Map)) {
    session.dialogueScriptHandoffs = new Map();
  }
  return session.dialogueScriptHandoffs;
}

export function getHandoff(session, effectiveBoardId, schemaName, circuit_ref) {
  const map = session?.dialogueScriptHandoffs;
  if (!(map instanceof Map)) return null;
  return map.get(handoffKey(effectiveBoardId, schemaName, circuit_ref)) ?? null;
}

export function setHandoff(session, effectiveBoardId, schemaName, circuit_ref, entry) {
  const map = ensureHandoffMap(session);
  if (!map) return;
  map.set(handoffKey(effectiveBoardId, schemaName, circuit_ref), entry);
}

export function deleteHandoff(session, effectiveBoardId, schemaName, circuit_ref) {
  const map = session?.dialogueScriptHandoffs;
  if (!(map instanceof Map)) return false;
  return map.delete(handoffKey(effectiveBoardId, schemaName, circuit_ref));
}

/**
 * Drop every tombstone for one circuit on one board, whatever the schema.
 *
 * Used by circuit DELETION: the key goes with the circuit. A rename is NOT a
 * deletion and must not come through here — it MIGRATES the key instead, so a
 * same-turn rename plus a write on the new ref stays fenced.
 */
export function clearHandoffsForCircuit(session, effectiveBoardId, circuit_ref) {
  const map = session?.dialogueScriptHandoffs;
  if (!(map instanceof Map)) return 0;
  const suffix = `::${circuit_ref ?? 'none'}`;
  const prefix = `${effectiveBoardId ?? 'main'}::`;
  let removed = 0;
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Re-key every tombstone for one circuit onto a new `circuit_ref`.
 *
 * Called at rename DISPATCH time, before the post-dispatch entry hook runs —
 * dispatch mutates the snapshot before the hook, and circuit-op projection runs
 * after it — so a same-turn `rename_circuit 3→7` plus a write on 7 is still
 * fenced. A rename is not a fresh trigger.
 */
export function migrateHandoffsForRename(session, effectiveBoardId, fromRef, toRef) {
  const map = session?.dialogueScriptHandoffs;
  if (!(map instanceof Map)) return 0;
  if (fromRef === toRef) return 0;
  const fromSuffix = `::${fromRef ?? 'none'}`;
  const prefix = `${effectiveBoardId ?? 'main'}::`;
  let migrated = 0;
  for (const [key, value] of [...map.entries()]) {
    if (!key.startsWith(prefix) || !key.endsWith(fromSuffix)) continue;
    const schemaName = key.slice(prefix.length, key.length - fromSuffix.length);
    map.delete(key);
    map.set(handoffKey(effectiveBoardId, schemaName, toRef), value);
    migrated += 1;
  }
  return migrated;
}

/**
 * Is this (board, schema, circuit) handed off to the model?
 *
 * Exported for the two re-entry readers that live outside this module's own
 * call graph. Both MUST resolve `effectiveBoardId` through
 * `resolveEffectiveBoardId`.
 */
export function isHandedOff(session, effectiveBoardId, schemaName, circuit_ref) {
  return getHandoff(session, effectiveBoardId, schemaName, circuit_ref) !== null;
}

/**
 * PLAN-A2 EP (2026-09-23) — does ANY circuit on this board hold a handoff for
 * this schema?
 *
 * The one reader that cannot name a circuit: `start_dialogue_script` with
 * `circuit: null` ("engine asks"). Checking a tombstone once the inspector's
 * answer resolves the circuit is too late — by then the model's turn is over, so
 * the values it queued have no owner that can speak them exactly once. The
 * engine refuses such a start up front instead, while the model can still act
 * in the same turn. Same board-normalisation rule as every other reader.
 */
export function hasAnyHandoffForSchema(session, effectiveBoardId, schemaName) {
  const map = session?.dialogueScriptHandoffs;
  if (!(map instanceof Map) || map.size === 0) return false;
  const prefix = `${effectiveBoardId ?? 'main'}::${schemaName}::`;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
