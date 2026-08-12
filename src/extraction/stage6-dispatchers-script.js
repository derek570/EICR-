/**
 * Stage 6 — start_dialogue_script dispatcher.
 *
 * WHAT: Single dispatcher for the `start_dialogue_script` tool added
 * 2026-04-30 as the Sonnet-side entry point for the dialogue engine
 * (src/extraction/dialogue-engine/). When Sonnet recognises a
 * structured walk-through entry the engine's regex missed (Deepgram
 * garble, paraphrase, vocabulary the schema author didn't anticipate),
 * Sonnet calls this tool; the dispatcher invokes the engine's
 * `enterScriptByName` to set up state and emit the first ask.
 *
 * WHY a separate sibling (not appended to circuit / observation / board):
 * MAJOR-2 file-isolation rule from Phase 2 — each new dispatcher class
 * gets its own file. Keeps merge surface predictable, mirrors the
 * existing pattern.
 *
 * Wire-emit responsibility: enterScriptByName uses session.activeWs (or
 * the explicit `ws` arg) to send the first ask. The dispatcher passes
 * the per-session WS through `ctx.ws` if available; otherwise the
 * engine's safeSend swallows the no-ws case (test fixtures, audit
 * replays) and the dispatcher still returns a structured envelope.
 *
 * Idempotency: enterScriptByName short-circuits when a script is
 * already active, returning `{ok:true, status:'already_active'}`. The
 * dispatcher passes that through verbatim so Sonnet can call
 * defensively (e.g. alongside the engine's regex entry on the same
 * turn) without breaking the flow.
 */

import {
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
  valuesCanonicallyEqual,
} from './dialogue-engine/index.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import {
  getCircuitBucket,
  getMainBoardId,
  normaliseBoardScopeInput,
} from './stage6-multi-board-shape.js';
import {
  encodeReadingKey,
  attachEffectiveSlot,
  recordReadingWrite,
  projectReadingWinners,
  rawCircuitSlot,
} from './stage6-per-turn-writes.js';
// Imported from the helper directly rather than the barrel: value-corrections.js
// is dialogue-engine INTERNAL transport (the barrel exports the turn-processing
// API), and this dispatcher is the one outside consumer that legitimately has to
// hand a correction over to the Stage-6 bundler. See the backfill below.
import { consumeValueCorrection } from './dialogue-engine/helpers/value-corrections.js';
import { IMPEDANCE_CLAMP_CORRECTION } from './impedance-clamp.js';

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/**
 * Validate → enterScriptByName → log → envelope.
 *
 * Validation contract (defence-in-depth on top of strict-mode tool
 * schema):
 *   - input.schema must be one of the registered schemas (already
 *     enum-gated by the API; checked here in case of fixture drift).
 *   - input.circuit must be null or a positive integer matching an
 *     existing circuit on the snapshot. Unknown circuit → 'unknown_circuit'
 *     error so Sonnet calls create_circuit first.
 *
 * Outcomes (all mirrored in the log row):
 *   - 'ok'             — engine entered the script, first ask emitted.
 *   - 'already_active' — a script (possibly a different schema) is in
 *                        flight; engine state was NOT touched.
 *   - 'rejected'       — validation failed; tool_result is_error:true.
 *
 * @param {{tool_call_id: string, name: string, input: {schema: string, circuit: ?number, source_turn_id: string, reason: string}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number, ws?: object}} ctx
 */
export async function dispatchStartDialogueScript(call, ctx) {
  const { session, logger, turnId, round, ws, perTurnWrites } = ctx;
  // A2-multiboard item 6 — normalise once at the dispatcher boundary; this
  // single call covers all four places the script drain reads `input.board_id`
  // (bucket lookup, seeded effective board, reading-key encoding and the
  // outward `boardId` on the per-turn write), which would otherwise disagree
  // about whether an empty string means "current board" or a real scope.
  const input = normaliseBoardScopeInput(call.input || {}, session.stateSnapshot);

  // Resolve the WebSocket the engine should emit the first ask through.
  // The composer in stage6-dispatchers.js doesn't currently thread
  // `ws` into ctx; sessions stash the live WS as `session.activeWs`
  // (set by sonnet-stream.js when it builds the per-turn context).
  // Fall back to ctx.ws for tests / future plumbing.
  const targetWs = ws ?? session.activeWs ?? null;

  // PLAN A2 §A2.4 (feedback id 117) — project THIS turn's per-field winners
  // BEFORE calling enterScriptByName, and pass an ownership resolver into the
  // engine. Timing is the crux: enterScriptByName can emit finishScript and
  // clear state SYNCHRONOUSLY when every slot is already filled — a post-hoc
  // ownership check (the existing backfill below) runs too late to inform
  // that immediate-finish speech.
  const seededEffectiveBoardId =
    input.board_id ??
    session.stateSnapshot?.currentBoardId ??
    getMainBoardId(session.stateSnapshot);
  // Codex diff-review r1 (3/3 lenses) — only construct a resolver when this
  // dispatcher can ACTUALLY perform the guaranteed post-call backfill
  // (perTurnWrites.readings is a live Map); otherwise pass null so
  // enterScriptByName's APPLIED-seed branch correctly falls back to
  // script-owned instead of promising a bundler confirmation that will
  // never arrive (a seed marked 'bundler' with no backfill is a genuine
  // silent-drop — finishScript suppresses it, and nothing else ever speaks
  // it).
  const canBackfill = !!(perTurnWrites && perTurnWrites.readings instanceof Map);
  const priorWinnerValues = canBackfill
    ? new Map(projectReadingWinners(perTurnWrites).map((w) => [w.slot, w.value?.value]))
    : new Map();
  // (field, circuitRef, canonicalValue) => 'bundler' | null. Consulted for a
  // canonical-EQUAL seed to decide whether an EQUAL prior per-turn winner
  // means the bundler already speaks this value this turn. A DIFFERING
  // prior winner returns null — the engine's own canonicalise-compare then
  // treats it as a genuine correction and overwrites, never silently
  // discards it (Codex diff-review r1: an earlier "any prior winner always
  // wins" draft broke this — a valid later correction was silently lost).
  const ownershipResolver = canBackfill
    ? (field, circuitRef, canonicalValue) => {
        if (!Number.isInteger(circuitRef)) return null;
        const wireSlot = rawCircuitSlot(field, circuitRef, seededEffectiveBoardId);
        if (!priorWinnerValues.has(wireSlot)) return null;
        // Codex diff-review r2 — canonicalise through the SAME slot parser
        // the engine uses, not a raw String() comparison. A per-turn prior
        // winner from record_reading carries its FULLY CANONICAL form
        // ("BS EN 61008"); a Sonnet start_dialogue_script seed for the same
        // field often carries the RAW digits ("61008") — String()-unequal
        // but semantically identical. The false negative left the seed
        // script-owned even though the bundler already speaks the prior
        // winner, producing a double-speak of the same value.
        const schemaSlot = ALL_DIALOGUE_SCHEMAS.flatMap((s) => s.slots ?? []).find(
          (s) => s.field === field
        );
        return valuesCanonicallyEqual(schemaSlot, priorWinnerValues.get(wireSlot), canonicalValue)
          ? 'bundler'
          : null;
      }
    : null;

  const result = enterScriptByName({
    session,
    sessionId: session.sessionId,
    schemas: ALL_DIALOGUE_SCHEMAS,
    schemaName: input.schema,
    circuit_ref: input.circuit ?? null,
    pending_writes: Array.isArray(input.pending_writes) ? input.pending_writes : [],
    // Forward the live turn's transcript so the engine can run its
    // broadcast-intent guard (engine.js enterScriptByName). The
    // harness stashes this on `session.activeTurnTranscript` at the
    // top of runLiveMode and clears it in the finally; reading it
    // here keeps the dispatcher stateless. Falls back to null on
    // test paths that don't set up the harness.
    transcriptText: session.activeTurnTranscript ?? null,
    ws: targetWs,
    logger,
    now: Date.now(),
    // PLAN-C P4d (row 1) — stamp the engine's first ask_user_started with the
    // live response epoch. The harness stashes the live responseEpochRef on the
    // session at the top of runLiveMode (cleared in its finally); read `.current`
    // here so the frame carries the arming utterance's id and the client chime
    // watchdog disarms on the spoken question. Null on test paths / no live turn.
    responseEpoch: session.activeResponseEpochRef?.current ?? null,
    // PLAN A2 §A2.4 — dispatcher-resolved speech ownership.
    ownershipResolver,
  });

  if (!result.ok) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'start_dialogue_script',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: result.error,
      input_summary: { schema: input.schema, circuit: input.circuit },
    });
    return envelope(call.tool_call_id, { ok: false, error: result.error }, true);
  }

  // Outcome enum is 'ok' | 'noop' | 'rejected' (per stage6-dispatcher-logger.js
  // contract). 'noop' for already_active matches the existing semantic
  // (delete_observation uses noop when the observation id is unknown).
  // The detail of WHICH already-active schema is in the engine's separate
  // `stage6.dialogue_script_already_active` log row (emitted from
  // enterScriptByName), so CloudWatch can join sessionId+turnId to recover
  // the full picture without polluting the tool-call enum.
  // 2026-05-24 (voice-regression Item 1, bs_en_normalisation) — when
  // Sonnet routes a single-field BS-EN dictation through this tool
  // (e.g. "Circuit one OCPD BS 6898") instead of record_reading, the
  // dialogue engine writes the value to stateSnapshot directly via
  // applyWrite + emits an `extraction` WS message via
  // buildExtractionPayload — but the value never reaches
  // perTurnWrites.readings, so it's absent from the turn's
  // `extracted_readings` wire payload. iOS sees the value via the
  // engine's WS push, but downstream consumers (the regression harness
  // assertions, the slot comparator, any future analytic that reads
  // extracted_readings only) see a write-shaped silence.
  //
  // Backfill perTurnWrites here for every seeded write that landed on
  // a resolved circuit_ref. Reading the value back from the snapshot
  // (rather than mining it from input.pending_writes) covers the pivot
  // case where runPivot rewrote schema state on the OCPD→RCBO path
  // and mirrored ocpd_bs_en into rcd_bs_en — both fields show up in
  // the snapshot and get the perTurnWrites entry.
  //
  // Tool-loop already-active path: result.status === 'already_active'
  // means enterScriptByName did NOT touch state; seeded_writes is the
  // existing script's prior fills. Skip the backfill in that case to
  // avoid re-emitting prior-turn writes.
  if (
    result.status !== 'already_active' &&
    perTurnWrites &&
    perTurnWrites.readings instanceof Map &&
    Number.isInteger(result.circuit_ref) &&
    Array.isArray(result.seeded_writes) &&
    result.seeded_writes.length > 0
  ) {
    const bucket = getCircuitBucket(session.stateSnapshot, result.circuit_ref, input.board_id);
    // P5 (2026-07-23) — resolve the effective board ONCE for every seeded
    // write. start_dialogue_script's schema declares no board_id (raw
    // input.board_id is typically undefined) and no resolution existed at
    // dispatcher entry, so the collapse's effective-slot match had nothing to
    // key off. Raw input.board_id still feeds encodeReadingKey + the value's
    // enumerable boardId unchanged; only the non-enumerable slot marker uses
    // the effective id.
    // (seededEffectiveBoardId is computed once, above, before the
    // enterScriptByName call — PLAN A2 §A2.4 reuses that same value here so
    // the pre-call resolver and this post-call backfill agree on scope.)
    // A2-multiboard (2026-07-28) — the precedence check below is keyed on the
    // EFFECTIVE slot, not the raw Map key.
    //
    // The raw key is board-AMBIGUOUS: start_dialogue_script declares no
    // board_id, so `encodeReadingKey(field, ref, undefined)` is the SAME string
    // for every board. A `record_reading` on main followed by
    // `select_board garage` + a garage script seeding the same field on the
    // same ref would have matched `readings.has(key)` and skipped the garage
    // backfill entirely — the second board's value never reaching
    // extracted_readings at all. That is the spoken-but-not-written class this
    // plan exists to close, and it is exactly the collision the journal was
    // introduced to make decidable: `projectReadingWinners` is authoritative
    // for slot occupancy (see stage6-per-turn-writes.js — this backfill is one
    // of its named consumers), and it already excludes writes a same-turn clear
    // removed, matching the old `Map.has` semantics on that path.
    //
    // The raw `key` is still what feeds encodeReadingKey/recordReadingWrite, so
    // the Map key and the entry's enumerable `boardId` — and therefore the wire
    // bytes — are unchanged.
    // PLAN A2 §A2.4 (feedback id 117) — a Map, not a Set: "guarantees every
    // newly-applied seed becomes the latest per-turn winner before bundling
    // (including replacing an occupied winner whose value differs)". A2.3's
    // engine-side rewrite means a seed CAN now overwrite a stale snapshot
    // value even when the field was already occupied — that overwrite must
    // become the new winner, or the bundler would speak the STALE occupant
    // while the finish text (per §A2.4) stays silent on the assumption the
    // bundler already owns it.
    const occupiedSlots = new Map(
      projectReadingWinners(perTurnWrites).map((w) => [w.slot, w.value?.value])
    );
    for (const fieldName of result.seeded_writes) {
      const writtenValue = bucket?.[fieldName];
      if (writtenValue === undefined || writtenValue === null || writtenValue === '') continue;
      const key = encodeReadingKey(fieldName, result.circuit_ref, input.board_id);
      // "This slot" is the EFFECTIVE one — see the note above the Map.
      const slot = rawCircuitSlot(fieldName, result.circuit_ref, seededEffectiveBoardId);
      const occupiedValue = occupiedSlots.get(slot);
      if (occupiedValue !== undefined) {
        if (String(occupiedValue) === String(writtenValue)) continue; // already the latest winner
        // else: the script's write differs from the current occupant — fall
        // through and REPLACE it (recordReadingWrite below is a Map.set, so
        // this naturally becomes the newest entry for the slot).
      }
      occupiedSlots.set(slot, writtenValue);
      const entry = attachEffectiveSlot(
        {
          value: writtenValue,
          confidence: 1.0,
          source_turn_id: input.source_turn_id,
          boardId: input.board_id ?? undefined,
        },
        fieldName,
        result.circuit_ref,
        seededEffectiveBoardId
      );
      // Plan D (id-100(b)) — HAND THE CLAMP PROVENANCE OVER TO THE BUNDLER.
      //
      // `enterScriptByName` clamps a seeded pending_write (Seam A) and records
      // "16 → 1.6" into the dialogue state store, whose only speech consumer is
      // the script's own end-of-script confirmation. But THIS backfill also puts
      // the value in front of the Stage-6 bundler, which read it back with the
      // bare line "Circuit 4, ring R1 1.6" — the stored number was right, but
      // the inspector was never told the server had divided their "16". That
      // defeats the whole reason the correction is named aloud (§3: a WRONG
      // correction has to be catchable by ear), and it is the read-back that
      // lands FIRST, so it is the one they actually react to.
      //
      // CONSUME, not peek — this is a speech path, and consuming is precisely
      // what keeps the clause exactly-once (Audio-First #1): whichever of the
      // two read-backs gets there first names it, and the other stays bare.
      // Both orderings are safe by construction:
      //   - script asks the next slot  → correction still in state here, the
      //     bundler names it, the later confirmation does not repeat it.
      //   - script confirms immediately (every slot seeded) → the confirmation
      //     already consumed it inside enterScriptByName, this returns null,
      //     and the bundler line is bare. Named once either way.
      //
      // Non-enumerable + Symbol-keyed for the same reason as every other seam:
      // it must reach the synthesiser and must never be serialisable onto a
      // wire frame.
      const seededCorrection = consumeValueCorrection(session.dialogueScriptState, fieldName);
      if (seededCorrection) {
        Object.defineProperty(entry, IMPEDANCE_CLAMP_CORRECTION, {
          value: seededCorrection,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
      recordReadingWrite(perTurnWrites, key, entry);
    }
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'start_dialogue_script',
    round,
    is_error: false,
    outcome: result.status === 'already_active' ? 'noop' : 'ok',
    validation_error: null,
    input_summary: {
      schema: input.schema,
      circuit: input.circuit ?? null,
      reason: input.reason,
    },
  });

  return envelope(
    call.tool_call_id,
    {
      ok: true,
      status: result.status,
      schema: result.schema,
      circuit_ref: result.circuit_ref,
      seeded_writes: result.seeded_writes ?? [],
      queued_writes: result.queued_writes ?? [],
      dropped_fields: result.dropped_fields ?? [],
      // 2026-04-30 (Codex P2): when a seed write triggers a derivation
      // pivot (e.g. ocpd_bs_en="BS EN 61009" pivots OCPD → RCBO), the
      // `schema` field above already reports the NEW schema name, but
      // Sonnet may need to know that a pivot happened (vs. a direct
      // entry on the new schema) to reason about subsequent slots.
      // `pivoted: false` is reported on the no-pivot path so the
      // envelope shape stays consistent — Sonnet can rely on the
      // field's presence rather than its truthiness.
      pivoted: result.pivoted === true,
    },
    false
  );
}
