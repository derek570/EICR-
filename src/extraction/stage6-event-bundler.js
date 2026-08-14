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

import {
  decodeReadingKey,
  decodeBoardReadingKey,
  EFFECTIVE_CIRCUIT_SLOT,
  rawCircuitSlot,
  EFFECTIVE_BOARD_SLOT,
  SECTION_DEDUPE_OPERATION,
  CONFIRMATION_REPLAY_TOKEN,
  boardSlotKey,
  projectReadingWinners,
  projectBoardReadingWinners,
  circuitDesignationKey,
  resolveDesignation,
  readEffectiveOpBoard,
  BULK_OUTCOME_CALL_ID,
} from './stage6-per-turn-writes.js';
// Loaded Barrel Phase 1.B (plan v10 §C) — the helper + friendly-name
// table moved into `confirmation-text.js` so loaded-barrel-speculator.js
// can import the same buildConfirmationText without dragging the rest
// of the bundler into its call site. No behavioural change here.
import {
  CONFIRMATION_FRIENDLY_NAMES,
  // CONFIRMATION_MIN_CONFIDENCE intentionally NOT imported here anymore:
  // the FINAL read-back no longer gates on confidence (audio-first,
  // 2026-06-18). The threshold survives in confirmation-text.js purely as
  // the loaded-barrel speculator's pre-synth cost gate.
  buildConfirmationText,
  buildFanoutGroupKey,
  buildGroupedConfirmationText,
  deriveFriendlyName,
} from './confirmation-text.js';
// §A1a (field-feedback-2026-07-14) — the ios_send_attempt telemetry loop
// (which consumed the three key builders) moved to stage6-shadow-harness.js
// so it runs on the SURVIVING post-debounce confirmation list. The two
// manifests here are intentionally distinct: WIRE/CLIENT drives `secfield_`
// production, while DEDUPE drives the candidate-1 backend debounce policy.
import { DEDUPE_TOKEN_FIELDS, WIRE_CLIENT_DEDUPE_TOKEN_FIELDS } from './ios-dedupe-key.js';
// §A2 (field-feedback-2026-07-14) — outbound `field_corrected` wire
// canonicalisation. field-name-corrections.js is a leaf module (no cycle).
import { FIELD_CORRECTIONS } from './field-name-corrections.js';
// Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 3 — friendly-name
// canonical). The bundler pre-computes the TTS-expanded form ("0 point 1 3
// ohms" out of "0.13 ohms") and emits it alongside the plain text so iOS
// can play either form without forking on capability. Older iOS builds
// that don't decode expanded_text fall through to local expansion via
// Self.expandForTTS (Sources/Recording/AlertManager.swift).
import { expandForTTS } from './tts-text-expander.js';
// id-100(b) (2026-07-25) — the dispatcher stashes an impedance-clamp correction
// on the perTurnWrites value entry under this Symbol, so the read-back can name
// the correction aloud. Import is the KEY only; impedance-clamp.js is a leaf
// module (its sole import is stage6-multi-board-shape.js) so there is no cycle.
import { IMPEDANCE_CLAMP_CORRECTION } from './impedance-clamp.js';
import { resolveEffectiveLocalityTail } from './postcode-snapshot-applier.js';

export const BUNDLER_PHASE = 2;

// §A2 (field-feedback-2026-07-14, F5) — raw dispatcher keys whose outbound
// `field_corrected` wire copy must NOT be canonicalised through
// FIELD_CORRECTIONS. Exactly one entry today: FIELD_CORRECTIONS maps
// `r2_ohm` → `r2`, but the deployed iOS clearer maps `r2` → the R1+R2 cell
// (`r1r2`) while `r2_ohm` maps to the DISTINCT R2 end-to-end cell (`r2Ohm`,
// Stage6FieldClearer.swift Group E/#32). Canonicalising would make
// "clear R2" wipe the R1+R2 cell on every build-418 device the moment this
// deploys. The wire keeps sending raw `r2_ohm`, which the clearer AND both
// record-APPLY paths already handle correctly — zero deployed-client
// behaviour change. Deliberately a LOCAL exemption here, NOT a deletion of
// the `r2_ohm` entry in FIELD_CORRECTIONS itself, which record_reading wire
// canonicalisation (sonnet-stream.js:794) still uses. Pinned by the
// semantic round-trip audit in stage6-clear-wire-audit.test.js.
export const CLEAR_WIRE_EXEMPT = new Set(['r2_ohm']);

/**
 * P5 (2026-07-23) — non-enumerable carrier for same-turn clear→write collapse
 * metadata. When the projection drops one or more stale `clear_reading`
 * corrections because a same-turn write survived for that circuit slot, it
 * attaches an array of `{field, circuit, board_id, final_effect:'write'}` to
 * the bundled result under this Symbol. The bundler stays PURE (no telemetry
 * side effects — the A2 work removed those); `stage6-shadow-harness.js` reads
 * this and emits `stage6.same_turn_clear_write_collapsed`. Non-enumerable so
 * it never enters JSON wire output or a defensive spread.
 */
export const SAME_TURN_CLEAR_WRITE_COLLAPSED = Symbol('stage6.sameTurnClearWriteCollapsed');

/**
 * PLAN-F2 finding 1 (2026-08-14) — module-local non-enumerable stamp joining
 * a synthesised confirmation (grouped or per-circuit) back to the bulk call
 * (and board) that produced it. Both the producer of this stamp
 * (synthesiseConfirmations, via buildFanoutGroupKey's identity dimension)
 * and its consumer (the bulk-outcome disclosure matching in
 * bundleToolCallsIntoResult) live in this one file, so — unlike
 * BULK_OUTCOME_CALL_ID, which crosses the dispatcher/bundler module
 * boundary — this never needs to be exported.
 */
const BULK_OUTCOME_MATCH_IDENTITY = Symbol('stage6.bulkOutcomeMatchIdentity');

/*
 * A2-multiboard (2026-07-28) — `REPLACES_CLEARED_AMBIGUOUS_PROJECTION` (and its
 * `stage6.replaces_cleared_ambiguous_projection` telemetry row) lived here.
 * A2-core used it to fail closed when a collapsed slot resolved to more than
 * one candidate surviving reading — two same-turn SPELLINGS of one slot (one
 * omitting `board_id`, one carrying the explicit current board) that the raw
 * Map kept as separate entries. The journal projection is last-write-wins per
 * EFFECTIVE slot, so both spellings now resolve to one winner and the
 * ambiguity is structurally unreachable. Removed rather than left dormant: a
 * dead fail-closed branch reads as live protection in a future review.
 */

/**
 * Synthesise brief read-back confirmations from the bundled readings.
 *
 * The legacy prose-JSON extractor used to emit a `confirmations` array
 * directly from the model (config/prompts/sonnet_extraction_system.md:283).
 * The Stage 6 agentic path has no analogue — record_reading is the only
 * write tool — so the iOS "Voice" toggle hooked to
 * `confirmationModeEnabled` (DeepgramRecordingViewModel.swift:7334) read
 * `result.confirmations` against an always-empty array, making the toggle
 * appear broken. This helper rebuilds the same wire shape from the
 * tool-call outcomes so the iOS path keeps working without a TestFlight
 * push or a prompt revision.
 *
 * Confirmation text is intentionally short (legacy "under 5 words" guidance
 * preserved at intent level; the friendly-name lookup keeps it concise).
 *
 * @param {Array<{field: string, circuit?: number|string, value: any, confidence: number}>} readings
 *   Circuit-scoped readings (bundler output extracted_readings).
 * @param {Array<{field: string, value: any, confidence: number}>} boardReadings
 *   Board-scoped readings (bundler output extracted_board_readings).
 * @returns {Array<{text: string, field: string, circuit: number|null}>}
 */
/**
 * 2026-05-29 — synthesise TTS confirmations for state-change ops
 * (create_circuit, rename_circuit, delete_circuit, add_board,
 * select_board). Pre-existing synthesis only covered record_reading
 * outcomes, so circuit creation/rename/delete and board switching
 * were silent under the hands-free AirPods workflow. Inspector said
 * "Circuit 1 is the cooker" → Sonnet called create_circuit only →
 * no TTS, inspector couldn't tell whether the system heard them.
 *
 * Dedup: if a record_reading(circuit_designation) for the same
 * circuit is in the same turn, skip the op confirmation — the
 * existing designation TTS path ("Circuit N is now the Cooker")
 * already carries the same intent.
 *
 * @param {Array} circuitOps perTurnWrites.circuitOps
 * @param {Array} boardOps perTurnWrites.boardOps
 * @param {Set<number>} skipCircuitDesignations circuits whose
 *   designation was already covered by a record_reading
 * @param {Map<string,string>|null} boardDesignations optional
 *   board_id → designation map for select_board lookup
 * @returns {Array<{text, expanded_text, field, circuit}>}
 */
function synthesiseStateChangeConfirmations(
  circuitOps,
  boardOps,
  skipCircuitDesignations,
  boardDesignations,
  turnId = null
) {
  const out = [];
  // A2-multiboard item 3 — a designation read-back only covers THIS op when it
  // landed on the SAME board. The pair key is consulted first (multi-board
  // turns enrich the reading with its board); the bare ref is the unscoped
  // fallback every single-board turn takes.
  const designationCovered = (op, ref) => {
    if (!skipCircuitDesignations) return false;
    const eff = readEffectiveOpBoard(op);
    if (eff != null && skipCircuitDesignations.has(circuitDesignationKey(eff, ref))) return true;
    return skipCircuitDesignations.has(ref);
  };
  if (Array.isArray(circuitOps)) {
    for (let opIdx = 0; opIdx < circuitOps.length; opIdx += 1) {
      const op = circuitOps[opIdx];
      const ref = op.circuit_ref;
      if (!Number.isInteger(ref) || ref <= 0) continue;
      let text = null;
      if (op.op === 'create') {
        if (designationCovered(op, ref)) continue; // covered by reading TTS
        const desig = op?.meta?.designation;
        if (typeof desig === 'string' && desig.trim()) {
          text = `Circuit ${ref} is now the ${desig.trim()}`;
        } else {
          text = `Circuit ${ref} created`;
        }
      } else if (op.op === 'rename') {
        if (designationCovered(op, ref)) continue;
        const desig = op?.meta?.designation;
        if (typeof desig === 'string' && desig.trim()) {
          text = `Circuit ${ref} is now the ${desig.trim()}`;
        } else if (Number.isInteger(op.from_ref) && op.from_ref !== ref) {
          text = `Circuit ${op.from_ref} renumbered to ${ref}`;
        }
      } else if (op.op === 'delete') {
        text = `Circuit ${ref} deleted`;
      }
      if (!text) continue;
      out.push({
        text,
        expanded_text: expandForTTS(text),
        field: 'circuit_op',
        circuit: ref,
        // §A1a operation dedupe token — turn + operation identity (ordinal
        // separates two DISTINCT same-circuit ops in one turn; a wire replay
        // of ONE op carries the identical token so client dedupe still
        // works). Composition pinned by the ios-dedupe-key drift test.
        dedupe_token: `circop_${turnId ?? 'noturn'}_${opIdx}_${op.op}_${ref}`,
        // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: state-change
        // confirmations are played on the iOS side via speakBriefConfirmation
        // call sites that lack a per-confirmation turnId today (the 10
        // no-LoadedBarrelTTSContext sites identified in the plan), so the
        // playback-ack will never fire. Mark `expects_ios_ack: false` so the
        // backend's audio finalizer doesn't arm waiting for an ACK that
        // can't arrive. Threading turnId through the no-context speak sites
        // is a Tier 1.4 follow-up.
        expects_ios_ack: false,
      });
    }
  }
  if (Array.isArray(boardOps)) {
    for (const op of boardOps) {
      let text = null;
      if (op.op === 'add_board') {
        const desig = op.designation;
        if (typeof desig === 'string' && desig.trim()) {
          text = `${desig.trim()} board added`;
        } else {
          text = `Board added`;
        }
      } else if (op.op === 'select_board') {
        const desig = boardDesignations instanceof Map ? boardDesignations.get(op.board_id) : null;
        // 2026-08-06 — a re-selection of the board already current says so,
        // instead of claiming a switch that never happened.
        //
        // WHY THIS IS WORDING, NOT SUPPRESSION: a fired chime is a promise —
        // the lever for not-responding is upstream of here, and gating "should
        // we speak?" on content is the F7 invariant breach. So a no-op still
        // speaks; it just stops lying. "Switched board" made a failed turn
        // sound productive in the field (session 10A27714…, turn-10: a
        // dictated Zs was rejected `wrong_board`, the model re-selected the
        // board it was already on, and the ONLY thing the inspector heard was
        // a confident "Switched board"). Hearing "Already on the DB-1 board"
        // is what tells a hands-free inspector the recovery achieved nothing.
        //
        // `changed` is additive: only an explicit `false` changes the wording,
        // so every producer that predates the flag keeps its exact bytes.
        const noop = op.changed === false;
        if (typeof desig === 'string' && desig.trim()) {
          text = noop
            ? `Already on the ${desig.trim()} board`
            : `Switched to the ${desig.trim()} board`;
        } else {
          text = noop ? `Already on that board` : `Switched board`;
        }
      } else if (op.op === 'mark_distribution_circuit') {
        const ref = op.circuit_ref;
        if (Number.isInteger(ref) && ref > 0) {
          text = `Circuit ${ref} marked as feeding the sub-board`;
        }
      }
      if (!text) continue;
      out.push({
        text,
        expanded_text: expandForTTS(text),
        field: 'board_op',
        circuit: null,
        // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5 — see circuit_op
        // entry above. Same rationale for board ops.
        expects_ios_ack: false,
      });
    }
  }
  return out;
}

/**
 * Issue 8 from 2026-05-31 field test. Inspector wants every UI write
 * read back via TTS so the iPad can sit in another room while they
 * work in AirPods. record_reading + state-change ops were already
 * spoken (synthesiseConfirmations + synthesiseStateChangeConfirm-
 * ations). The three missing categories — observations, observation
 * deletions, and explicit clear_reading corrections — are covered
 * here.
 *
 * @param {Array} observations perTurnWrites.observations
 * @param {Array} deletedObservations perTurnWrites.deletedObservations
 * @param {Array} fieldCorrections perTurnWrites.fieldCorrections
 *   (carries the previous_value + reason for clear_reading writes;
 *   per-reading "field_corrected" is the only category we speak —
 *   record_reading-driven corrections already go via the main
 *   confirmation path)
 * @param {Map<number|string,string>|null} designations designation map — see
 *   `resolveDesignation` for the two key spaces. Used to prefix cleared
 *   circuit-level readings with the spoken circuit name when known.
 * @returns {Array<{text, expanded_text, field, circuit}>}
 */
function synthesiseObservationAndClearedConfirmations(
  observations,
  deletedObservations,
  fieldCorrections,
  designations = null,
  writtenSlots = null,
  turnId = null
) {
  const out = [];
  const lookupDesignation = (circuit, boardId = null) =>
    resolveDesignation(designations, circuit, boardId);

  if (Array.isArray(observations)) {
    for (const obs of observations) {
      if (!obs) continue;
      const code = typeof obs.code === 'string' && obs.code.trim() ? obs.code.trim() : null;
      const rawText = typeof obs.text === 'string' ? obs.text.trim() : '';
      let text;
      if (code && rawText) {
        // Field report 2026-06-24 #6: speak the FULL observation body — the
        // old 50-char cap cut "…combustible material" to "…combustible m"
        // mid-word before TTS synthesis. Audio-first invariant #1 (verify by
        // ear) means the inspector must hear the whole observation; no cap, no
        // runaway guard. Resolved decision #6 (2026-06-24).
        text = `Observation ${code} — ${rawText}`;
      } else if (code) {
        text = `Observation ${code} recorded`;
      } else if (rawText) {
        text = `Observation — ${rawText}`;
      } else {
        // Empty observation with no code or text — don't speak anything.
        continue;
      }
      out.push({
        text,
        expanded_text: expandForTTS(text),
        field: 'observation',
        circuit: Number.isInteger(obs.circuit) ? obs.circuit : null,
        // §A1a token — the observation ID is replay-stable operation
        // identity (two distinct observations always have distinct ids).
        ...(obs.id != null ? { dedupe_token: `obs_${obs.id}` } : {}),
        // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: synthesised
        // observation/cleared confirmations route through the same iOS
        // no-LoadedBarrelTTSContext paths as state-changes; the playback-ack
        // can't fire so the finalizer must not arm waiting for one.
        expects_ios_ack: false,
      });
    }
  }

  if (Array.isArray(deletedObservations)) {
    for (const d of deletedObservations) {
      if (!d) continue;
      const text = 'Observation deleted';
      out.push({
        text,
        expanded_text: expandForTTS(text),
        field: 'observation_deletion',
        circuit: null,
        // §A1a token — deletion identity is the deleted observation's ID.
        // Every deletion speaks the same "Observation deleted" text with
        // circuit:null, so WITHOUT the token two same-turn deletions compute
        // identical degenerate keys and the client swallows the second.
        ...(d.id != null ? { dedupe_token: `obsdel_${d.id}` } : {}),
        // Voice-latency Tier 1.1 sub-step 5: see observation entry above.
        expects_ios_ack: false,
      });
    }
  }

  if (Array.isArray(fieldCorrections)) {
    for (let corrIdx = 0; corrIdx < fieldCorrections.length; corrIdx += 1) {
      const c = fieldCorrections[corrIdx];
      if (!c) continue;
      // Only speak explicit clears; field_corrected with a non-clear
      // reason is a side-effect of a regular record_reading that the
      // main confirmation path already covers.
      if (c.reason !== 'clear_reading') continue;
      const field = c.field;
      if (typeof field !== 'string' || field.length === 0) continue;
      // #31 (2026-06-19, session AD0AE9FA): when the SAME turn also WRITES this
      // slot — a value *replacement*, e.g. "customer name is Charles Henry"
      // models as clear_reading{client_name} + record_board_reading{client_name}
      // — the new value's read-back IS the confirmation. Speaking a standalone
      // "<field> cleared" on top of it double-confirms, violating the audio-first
      // invariant "every dictated reading read back exactly once". Suppress the
      // field_cleared confirmation when a write for the same field+scope landed
      // this turn. Keyed by same-turn same-slot (circuit ref for circuit
      // readings, field-level for board/installation readings), NOT by tool
      // adjacency — tool results aren't reliably ordered/adjacent.
      if (writtenSlots) {
        const circ = c.circuit;
        if (Number.isInteger(circ) && circ > 0) {
          // A2-multiboard (2026-07-28) — membership is by EFFECTIVE CIRCUIT
          // SLOT, the exact circuit-side twin of the board fix plan A1a made
          // below for the same reason. `field|circuit` is board-AMBIGUOUS
          // (record_reading / clear_reading both omit `board_id` in the common
          // case), so a write on ONE board ate the read-back of a surviving
          // clear on ANOTHER: write Zs c1 on main, select_board garage, clear
          // Zs c1 on garage — the two effective slots differ so P5's collapse
          // correctly keeps BOTH operations, then the bare `measured_zs_ohm|1`
          // string from main's write suppressed garage's "Zs cleared". The
          // clear lands server-side and on the client and is never spoken:
          // Audio-First #1, written-but-not-spoken.
          //
          // The clear carries its dispatch-time EFFECTIVE_CIRCUIT_SLOT stamp
          // (dispatchClearReading attaches it to every fieldCorrections entry),
          // so this is a pure server-side suppression decision — no wire field
          // is read or written and the frame bytes are untouched. Symbol-less
          // (legacy-fixture) clears fall back to the stable null-board sentinel
          // key, which is what keeps their existing behaviour byte-identical.
          const csym = c[EFFECTIVE_CIRCUIT_SLOT];
          const clearSlot = csym
            ? rawCircuitSlot(csym.field, csym.circuit, csym.boardId)
            : rawCircuitSlot(field, circ, null);
          if (
            writtenSlots.circuitSlots instanceof Set &&
            writtenSlots.circuitSlots.has(clearSlot)
          ) {
            continue;
          }
        } else if (writtenSlots.boardFields instanceof Set) {
          // Board/installation-level clear (circuit 0/null) with a same-SLOT
          // board write this turn — a replacement; let the write speak.
          // Plan A1a: membership is by EFFECTIVE BOARD SLOT (canonical field
          // + scope-conditioned board id), never the bare field — a bare-
          // field test wrongly silenced a cross-board clear on a board-
          // scoped field. A stamp-less correction (no dispatcher-pushed
          // board clear carries none; defensive for hand-built fixtures)
          // keeps today's bare-field behaviour via the null-board sentinel.
          const bsym = c[EFFECTIVE_BOARD_SLOT];
          const clearSlot = bsym
            ? boardSlotKey(bsym.field, bsym.boardId)
            : boardSlotKey(FIELD_CORRECTIONS[field] ?? field, null);
          if (writtenSlots.boardFields.has(clearSlot)) {
            continue;
          }
        }
      }
      // Skip suppressed fields + *_id (mirrors buildConfirmationText
      // gating so we don't speak internal IDs being cleared).
      // Match by re-importing the predicate would tighten the dep
      // graph; for now inline the same check.
      if (typeof field === 'string' && field.endsWith('_id')) continue;
      const friendly = CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
      const circ = Number.isInteger(c.circuit) ? c.circuit : null;
      let text;
      if (circ == null || circ === 0) {
        text = `${friendly} cleared`;
      } else {
        // A2-multiboard — resolve the name on the clear's EFFECTIVE board
        // (stamped non-enumerably at dispatch) so a cleared circuit 3 on
        // sub-board B is not announced with board A's circuit-3 name.
        const desig = lookupDesignation(circ, c?.[EFFECTIVE_CIRCUIT_SLOT]?.boardId ?? null);
        const prefix =
          typeof desig === 'string' && desig.trim() ? desig.trim().slice(0, 40) : `Circuit ${circ}`;
        text = `${prefix}, ${friendly} cleared`;
      }
      out.push({
        text,
        expanded_text: expandForTTS(text),
        field: 'field_cleared',
        circuit: circ,
        // §A1a token — {field, circuit, turn AND ordinal} (Codex r1-#5:
        // turn-only collapsed two DISTINCT same-slot clears within one
        // extraction turn into one token, so the token-aware debounce ate
        // the second). turnId keeps identical clears in SEPARATE turns
        // distinct; the ordinal keeps distinct same-turn operations
        // distinct; a wire replay of ONE operation still carries the
        // identical token. NOTE: `field` here is the RAW dispatcher key
        // (perTurnWrites is never canonicalised — §A2); the token is an
        // opaque identity so raw-vs-wire spelling inside it is irrelevant
        // to clients.
        dedupe_token: `clear_${field}_${circ ?? 'board'}_${turnId ?? 'legacy'}_ord${corrIdx}`,
        // Voice-latency Tier 1.1 sub-step 5: see observation entry above.
        // field_cleared confirmations also route through the no-context
        // iOS speak path.
        expects_ios_ack: false,
      });
    }
  }

  return out;
}

function synthesiseConfirmations(
  readings,
  boardReadings,
  designations = null,
  totalCircuitsInJob = null,
  calcReadings = null,
  clampCorrections = null,
  boardScope = null,
  // PLAN-F2 finding 1 (2026-08-14) — WeakMap<reading, callId>, resolved by
  // the caller from BULK_OUTCOME_CALL_ID during projection. Optional (a
  // non-Map value, the default) means "no bulk-call identity this turn" —
  // every existing caller (test fixtures, older call sites) omits it, and
  // every reading takes the unstamped path, byte-identical to pre-finding-1
  // behaviour.
  bulkCallIds = null
) {
  const out = [];
  // A2-multiboard item 8 (2026-07-28) — per-GROUP circuit populations.
  //
  // `totalCircuitsInJob` is one session-wide scalar; a fan-out group belongs to
  // whichever board the DISPATCHER resolved for its writes, which on a
  // multi-board job is not always the board the session is pointed at. Feeding
  // the scalar to every group is how "All circuits" comes to assert a
  // completeness measured against a DIFFERENT board's population — an
  // over-claim the hands-free inspector has no way to see is wrong, on the one
  // phrasing whose entire job is to assert completeness.
  //
  // Resolution, fail-closed at every step (a false "All circuits" is an
  // inaudible lie; a range/list line is merely less elegant):
  //
  //   * group's effective board KNOWN and censused → that board's count.
  //   * group's effective board KNOWN but absent from the census (a board with
  //     no snapshot circuits, a stale/unknown id) → null, never "All".
  //   * group's effective board UNKNOWN → the legacy scalar ONLY when the job
  //     is unambiguously single-board; on a multi-board job → null.
  //   * no census at all (legacy callers / hand-built fixtures) → the scalar,
  //     byte-identical to pre-item-8 behaviour.
  const boardCounts = boardScope?.byBoard instanceof Map ? boardScope.byBoard : null;
  const jobIsMultiBoard = boardCounts != null && boardCounts.size > 1;
  // The WIRE `board_id` is only enriched onto ordinary readings on a
  // cross-board turn (see the enrichment pass in bundleToolCallsIntoResult), so
  // the dispatcher-resolved fallback is what keeps a single-board turn on a
  // multi-board job attributable at all.
  const effectiveBoardOf = (r) => {
    if (r?.board_id != null && r.board_id !== '') return r.board_id;
    const resolver = boardScope?.effectiveBoardOf;
    return typeof resolver === 'function' ? (resolver(r) ?? null) : null;
  };
  const resolveTotalForBoard = (boardId) => {
    if (boardCounts == null) return totalCircuitsInJob;
    if (boardId != null) return boardCounts.get(boardId) ?? null;
    return jobIsMultiBoard ? null : totalCircuitsInJob;
  };
  // id-100(b) (2026-07-25) — per-bundle identity map from a projected reading
  // object to the impedance-clamp correction the dispatcher recorded for it.
  // Keyed on object IDENTITY (same pattern as calcReadings/suppress sets) rather
  // than on a (field, circuit, board) tuple, because the tuple is not unique
  // across a turn that writes the same slot twice — identity is.
  const correctionOf = (r) =>
    clampCorrections instanceof WeakMap ? (clampCorrections.get(r) ?? null) : null;
  // PLAN-F2 finding 1 (2026-08-14) — same identity pattern as correctionOf,
  // for the bulk-call id BULK_OUTCOME_CALL_ID stamped at dispatch time.
  // null for any reading that didn't come from a bulk call.
  const bulkCallIdOf = (r) =>
    bulkCallIds instanceof WeakMap ? (bulkCallIds.get(r) ?? null) : null;
  // Codex diff-review cycle 2 (2026-08-14) — BLOCKER fix: the fan-out
  // group-key identity must be the full (callId, effectiveBoardId)
  // composite the plan specifies, not callId alone relying on the raw
  // `boardId` base-key field to already equal the effective board. That
  // reliance holds ONLY because the A2-multiboard cross-board enrichment
  // pass happens to normalise raw→effective before grouping runs on any
  // turn where the distinction would matter — correct by construction
  // today, but fragile: it depends on an unrelated subsystem's side effect
  // rather than being provably correct on its own. Composing effectiveBoardOf
  // directly into the bulk identity removes that cross-subsystem dependency.
  // Still null/undefined for non-bulk readings (no callId), so the key stays
  // byte-identical to pre-finding-1 behaviour there.
  const bulkGroupIdentityOf = (r) => {
    const callId = bulkCallIdOf(r);
    if (!callId) return undefined;
    return `${callId}|${effectiveBoardOf(r) ?? ''}`;
  };
  const sectionDedupeOperationOf = (r) => {
    const resolver = boardScope?.sectionDedupeOperationOf;
    return typeof resolver === 'function' ? (resolver(r) ?? null) : null;
  };
  // Plan E (feedback id 125, E4) — fold the audible locality (town/county)
  // into the postcode confirmation's EXISTING text, reading the EFFECTIVE
  // post-apply snapshot rather than the raw lookup output (a seeded/
  // preserved value speaks as stored — see resolveEffectiveLocalityTail).
  // Board readings ONLY: postcode/client_postcode are always global-scope
  // board-level writes, never circuit-scoped.
  const localityTailOf = (r) => {
    if (r?.field !== 'postcode' && r?.field !== 'client_postcode') return null;
    const family = r.field === 'client_postcode' ? 'client' : 'site';
    const townField = family === 'client' ? 'client_town' : 'town';
    const countyField = family === 'client' ? 'client_county' : 'county';
    // Codex diff-review finding (cycle 1, lens B) — town/county are ALSO
    // legitimate directly-dictatable fields (config/field_schema.json), not
    // only derived-from-lookup. If this SAME turn also confirms the
    // matching town/county as its own (non-derived) board reading, that
    // reading already speaks on its own; folding it into the postcode tail
    // too would speak the same locality TWICE in one turn, violating
    // Audio-First's exactly-once invariant. The tail's whole purpose is to
    // surface a value that would otherwise stay silent — when it's already
    // audible via its own confirmation, defer to that and stay quiet here.
    //
    // Per-fix mini-review (cycle 1) caught two follow-on defects in the
    // first version of this guard: (a) it suppressed the WHOLE tail when
    // EITHER component had its own confirmation, silencing a sibling that
    // was still only derived (e.g. a dictated town alongside a
    // still-only-derived county went completely inaudible); (b) it treated
    // FIELD PRESENCE in `boardReadings` as proof the sibling would actually
    // speak, but `buildConfirmationText` returns null (no confirmation at
    // all) for an empty value — so an empty-valued sibling entry wrongly
    // suppressed the tail with nothing to replace it. Fixed: check each
    // component INDEPENDENTLY, and only count a sibling as "will speak on
    // its own" when its value is genuinely non-empty (mirrors
    // buildConfirmationText's own `String(value ?? '').trim()` emptiness
    // check).
    const hasOwnConfirmation = (field) =>
      Array.isArray(boardReadings) &&
      boardReadings.some(
        (br) => br.field === field && br.value != null && String(br.value).trim() !== ''
      );
    const skipTown = hasOwnConfirmation(townField);
    const skipCounty = hasOwnConfirmation(countyField);
    if (skipTown && skipCounty) return null;
    return resolveEffectiveLocalityTail(boardScope?.stateSnapshot, family, {
      skipTown,
      skipCounty,
    });
  };
  // F/U-1 (2026-07-19) — identity Set of projected reading objects that came
  // from a calculator write (::calc:: source). These speak with "calculated
  // as" phrasing so the inspector can ear-distinguish a derived value from a
  // meter reading. Null/absent (legacy callers, board readings) → nothing is
  // treated as calculated.
  const isCalc = (r) => calcReadings instanceof Set && calcReadings.has(r);
  const lookupDesignation = (circuit, boardId = null) =>
    resolveDesignation(designations, circuit, boardId);

  // Plan B B1.3 (feedback ids 118/119) — renderer-aligned echo-stamping.
  // `fastAttemptBySlotKey` is `Map<slotKey, {correlationId, field, circuit,
  // boardId, canonicalValue, comparisonText}>`, resolved by the caller
  // (stage6-shadow-harness.js) IMMEDIATELY before bundleToolCallsIntoResult
  // from this turn's accepted fast-TTS identities. A reading matches ONLY
  // when its slotKey (field::circuit::boardId, the WIRE boardId — same
  // normalisation the fast route uses) joins AND its OWN renderer-aligned
  // comparison text (designation=null, matching the fast route's own
  // render) is BYTE-IDENTICAL to the accepted text AND the canonical value
  // also matches. A value/text mismatch (a correction) NEVER stamps — it is
  // structurally excluded from `fastMatchByReading` below and falls through
  // the ordinary per-circuit/grouped path unchanged, so the canonical
  // correction is always the one that speaks.
  const fastAttemptBySlotKey =
    boardScope?.fastAttemptBySlotKey instanceof Map ? boardScope.fastAttemptBySlotKey : null;
  // Codex diff-review F1 (2026-08-13): this MUST join on the same
  // dispatcher-resolved effective board `effectiveBoardOf` already computes
  // above, not the raw wire `board_id`. An ordinary single-board write
  // deliberately OMITS `board_id` on the wire (see `effectiveBoardOf`'s own
  // comment) while the fast-TTS route's accepted identity always carries
  // iOS's non-null local board id — joining on raw `r.board_id` would never
  // match on the common single-board case, reproducing the exact
  // double-read-back bug this module exists to fix.
  const fastSlotKeyOf = (r) => {
    const effBoard = effectiveBoardOf(r);
    const normBoardId = typeof effBoard === 'string' && effBoard ? effBoard : '';
    const circ = Number.isInteger(r?.circuit) ? r.circuit : 'null';
    return `${r?.field}::${circ}::${normBoardId}`;
  };
  // Identity-keyed (not slotKey-keyed): a reading OBJECT, not a tuple, so
  // the grouping loop and the per-circuit loop below can both ask "was THIS
  // exact projected reading fast-matched?" without re-deriving the slotKey
  // or re-running the comparison-text render a second time.
  const fastMatchByReading = new WeakMap();
  if (fastAttemptBySlotKey && fastAttemptBySlotKey.size > 0) {
    for (const r of readings) {
      const identity = fastAttemptBySlotKey.get(fastSlotKeyOf(r));
      if (!identity) continue;
      const comparisonText = buildConfirmationText(r.field, r.value, r.circuit, null, {
        calculated: isCalc(r),
        correction: correctionOf(r),
      });
      const valueMatches =
        String(r.value ?? '').trim() === String(identity.canonicalValue ?? '').trim();
      if (comparisonText != null && comparisonText === identity.comparisonText && valueMatches) {
        fastMatchByReading.set(r, identity.correlationId);
      }
    }
  }

  // Issue 10 (2026-05-31, session B95B2EE1): a fan-out write to
  // multiple circuits used to emit one per-circuit confirmation each;
  // the speculator picked one random circuit and the inspector heard
  // "Circuit 4, IR L to L >299" instead of "All circuits, IR L to L
  // >299". Group readings up-front so each (field, board_id, value)
  // bucket fires ONE TTS line. Per-circuit readings fall through
  // unchanged (group size 1 → buildGroupedConfirmationText returns
  // null and we use the existing buildConfirmationText path).
  const groups = new Map();
  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    // Plan B B1.3 — grouped-confirmation partition. A fast-attempted
    // single-circuit reading is pulled OUT of grouping entirely, BEFORE the
    // groupKey is even computed, so it can never be folded into a
    // multi-circuit bucket. It falls through to the per-circuit loop below
    // (untouched by `consumedReadingIndices`, since it's never added to a
    // bucket here) where it gets its own single confirmation stamped with
    // `fast_correlation_id` — and the REMAINING uncovered circuits in what
    // would have been its bucket still group normally. Suppressing the
    // whole grouped frame over one covered circuit would silence the
    // others; refusing to partition would double-speak the covered one.
    if (fastMatchByReading.has(r)) continue;
    // Audio-first (2026-06-18, readback-correction-optionb): the FINAL
    // read-back no longer drops on the model's self-reported confidence.
    // A hands-free inspector verifies by EAR, so every applied reading is
    // read back exactly once regardless of confidence — the inspector
    // catches a wrong value and corrects it by speaking. The `< 0.5`
    // capability rollout gate now lives PRE-APPLY in dispatchRecordReading
    // (so an un-applied reading never reaches this list), and the
    // CONFIRMATION_MIN_CONFIDENCE threshold is now ONLY the loaded-barrel
    // speculator's pre-synth cost gate (shouldGenerateConfirmation).
    // Group key excludes circuit on purpose — that's the dimension we
    // want to collapse across. Board scope still matters (the same
    // field+value on board A vs board B is two distinct broadcasts).
    // F/U-1 r3 — SHARED builder with the speculator's broadcast buckets
    // (buildFanoutGroupKey): calc-ness is a group dimension (a calculated
    // and a dictated same-value Zs speak with different phrasing and never
    // collapse), and the value is trimmed to match the spoken text the
    // builders produce.
    // id-100(b) — the clamp correction is part of the fan-out identity, so a
    // clamped and an unclamped write of the same final value never collapse into
    // one line (which would silence the safety-critical correction clause).
    // PLAN-F2 finding 1 (2026-08-14) — `identity` (the bulk call's
    // tool_call_id, null for non-bulk readings) joins the group key so two
    // same-turn bulk calls with disjoint circuit targets never collapse
    // into one group even when field+value+board+calc+correction all
    // match. Readings from ordinary (non-bulk) writes carry no identity —
    // `identity` is null/undefined for them and the key is byte-identical
    // to pre-finding-1 behaviour.
    const groupKey = buildFanoutGroupKey({
      field: r.field,
      value: r.value,
      boardId: r.board_id,
      calculated: isCalc(r),
      correction: correctionOf(r),
      identity: bulkGroupIdentityOf(r),
    });
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = {
        field: r.field,
        value: r.value,
        board_id: r.board_id,
        // A2-multiboard item 8 — the board this group's "All circuits" claim is
        // measured against. Safe to read off the FIRST member for the same
        // reason `correction` is: the wire `board_id` is part of the group key,
        // and a turn on which two members could differ in EFFECTIVE board is by
        // definition cross-board, which is exactly when the enrichment pass has
        // already stamped that difference onto the wire.
        effectiveBoardId: effectiveBoardOf(r),
        calculated: isCalc(r),
        // Safe to read off the FIRST member: every member of a bucket shares
        // this correction by construction (it is part of the group key).
        correction: correctionOf(r),
        // PLAN-F2 finding 1 — likewise safe to read off the FIRST member:
        // `identity` is part of the group key, so every member of a bucket
        // shares the same bulk-call id (or all share `null`).
        bulkCallId: bulkCallIdOf(r),
        items: [],
        indices: [],
      };
      groups.set(groupKey, bucket);
    }
    bucket.items.push(r);
    bucket.indices.push(i);
  }

  const consumedReadingIndices = new Set();

  for (const bucket of groups.values()) {
    if (bucket.items.length < 2) continue;
    // Codex r5-#3 — circuit_designation NEVER groups. If circuit 1's new
    // designation happens to equal circuit 2's same-turn value ("Sockets"),
    // grouping would collapse them into a circuit:null roll-up whose text
    // exposes the '__DESIGNATION__' friendly-name sentinel AND whose shape
    // breaks the per-op ordinal expansion's per-circuit lookup (an earlier
    // designation op would never be read back). Designations stay
    // per-circuit; each speaks its own line.
    if (bucket.field === 'circuit_designation') continue;
    // Only attempt the grouped form for circuit-level readings (the
    // helper rejects circuit:0/null entries by returning null).
    const circuits = bucket.items.map((r) => r.circuit).filter((c) => Number.isInteger(c) && c > 0);
    if (circuits.length < 2) continue;
    const grouped = buildGroupedConfirmationText(
      bucket.field,
      bucket.value,
      circuits,
      resolveTotalForBoard(bucket.effectiveBoardId),
      { calculated: bucket.calculated, correction: bucket.correction }
    );
    if (!grouped) continue;
    const entry = {
      text: grouped,
      expanded_text: expandForTTS(grouped),
      field: bucket.field,
      // Grouped confirmations are circuit-bag, not single-circuit;
      // null tells iOS this isn't tied to a specific row for the
      // anti-stale highlight logic.
      circuit: null,
      // Surface the underlying circuits so iOS can mark each as
      // confirmed in the highlight buffer (so individual cells flash
      // green) even though the spoken text is a single roll-up.
      circuits,
    };
    if (bucket.board_id != null) {
      entry.board_id = bucket.board_id;
    }
    // PLAN voice-feedback-2026-06-05 W1.4 — transient `_confidence`
    // sidecar carries the lowest confidence across the bucket so the
    // bundler's `ios_send_attempt` telemetry can include it. Stripped
    // BEFORE the entries reach the wire (see bundler stripTransient step).
    // Leading underscore marks transient by convention.
    entry._confidence = bucket.items.reduce(
      (min, r) => (typeof r.confidence === 'number' && r.confidence < min ? r.confidence : min),
      Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(entry._confidence)) entry._confidence = null;
    // PLAN-F2 finding 1 (2026-08-14) — stamp the composite (callId,
    // effectiveBoardId) identity so the bulk-outcome consumer in
    // bundleToolCallsIntoResult can join this confirmation back to ONLY the
    // bulk call that produced it. Non-enumerable: never rides the wire.
    // PLAN-F2 finding 4 — the board component is `bucket.effectiveBoardId`
    // (already resolved above, same value the "All circuits" census uses),
    // NOT the raw wire `bucket.board_id` — the ledger's matching field is
    // now the resolved effectiveBoardId too (see the consumer below), and
    // comparing raw-vs-resolved would fail the match on an ordinary
    // single-board turn (where the wire board_id is omitted but the
    // session may have a real non-main board selected).
    if (bucket.bulkCallId) {
      Object.defineProperty(entry, BULK_OUTCOME_MATCH_IDENTITY, {
        value: { callId: bucket.bulkCallId, boardId: bucket.effectiveBoardId ?? null },
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    out.push(entry);
    for (const idx of bucket.indices) consumedReadingIndices.add(idx);
  }

  for (let i = 0; i < readings.length; i += 1) {
    if (consumedReadingIndices.has(i)) continue;
    const r = readings[i];
    // Audio-first: no confidence gate on the final read-back (see grouping
    // loop above). Every applied reading is read back regardless of
    // self-reported confidence.
    // 2026-05-29 — pass designation so the TTS reads "Cooker, Zs 0.62"
    // instead of "Circuit 1, Zs 0.62". Lookup uses the same per-turn
    // circuit_designation write so a brand-new circuit confirmed in the
    // SAME turn (Sonnet: create_circuit + record_reading) speaks with
    // its name immediately.
    // A2-multiboard — pass the reading's board so a per-board designation wins
    // over the bare-ref fallback (two boards can both own a circuit 3).
    const designation = lookupDesignation(r.circuit, r.board_id ?? null);
    const text = buildConfirmationText(r.field, r.value, r.circuit, designation, {
      calculated: isCalc(r),
      correction: correctionOf(r),
    });
    if (!text) continue;
    const entry = {
      text,
      // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 3). Pre-
      // compute the TTS-expanded form server-side. iOS Builds advertising
      // `regex_fast_v2` consume `expanded_text` verbatim (skipping the
      // local Self.expandForTTS) so client + server agree on the spoken
      // form for every numeric reading. The expander is pure + ASCII so
      // pre-computing it has zero cost beyond the string allocation.
      expanded_text: expandForTTS(text),
      field: r.field,
      circuit: Number.isInteger(r.circuit) ? r.circuit : null,
    };
    // Loaded Barrel Phase 1.B — emit board_id when set so the iOS
    // POST can include it in the cache-key tuple. Omit when null/
    // undefined so single-board sessions stay byte-identical on the
    // wire and pre-Phase-4a iOS clients (which don't decode board_id
    // on ValueConfirmation yet) see no change.
    if (r.board_id != null) {
      entry.board_id = r.board_id;
    }
    // Plan B B1.3 — echo stamp. The SPOKEN text above always carries the
    // real designation (unchanged); `fast_correlation_id` is a PURELY
    // ADDITIVE field that tells iOS this confirmation is the value-identical
    // twin of a fast clip it may already have played, so it can suppress the
    // duplicate read-back. Only set when `fastMatchByReading` found a
    // full (slotKey + renderer-aligned text + value) match above.
    const fastCorrelationId = fastMatchByReading.get(r);
    if (fastCorrelationId) {
      entry.fast_correlation_id = fastCorrelationId;
    }
    // W1.4 transient confidence sidecar (per-circuit fallback path).
    entry._confidence = typeof r.confidence === 'number' ? r.confidence : null;
    // PLAN-F2 finding 1 (2026-08-14) — same composite-identity stamp as the
    // grouped path above, for a bulk call whose sweep applied to exactly one
    // circuit (never grouped — bucket.items.length < 2). PLAN-F2 finding 4
    // — board component is effectiveBoardOf(r) (resolved), not raw
    // r.board_id, same rationale as the grouped path above.
    const perCircuitBulkCallId = bulkCallIdOf(r);
    if (perCircuitBulkCallId) {
      Object.defineProperty(entry, BULK_OUTCOME_MATCH_IDENTITY, {
        value: { callId: perCircuitBulkCallId, boardId: effectiveBoardOf(r) ?? null },
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    out.push(entry);
  }
  for (const r of boardReadings) {
    // Audio-first: no confidence gate on the final read-back (see above).
    // id-100(b) — THIS IS THE C06B9904 REPRO PATH. A supply Ze arrives here as a
    // board reading (circuit null), and this call previously passed only three
    // arguments, so an options object could not reach the text builder at all —
    // the correction clause would have been structurally unreachable for the very
    // field that produced the defect. The 4th argument stays `null` (board
    // readings have no circuit and therefore no designation prefix).
    const text = buildConfirmationText(r.field, r.value, null, null, {
      correction: correctionOf(r),
    });
    if (!text) continue;
    // Plan E — append the effective locality clause AFTER the base text is
    // built (never a standalone confirmation object — one utterance,
    // exactly-once). `dedupe_token` (stamped below on the wire entry) is
    // computed from field/scope/turnId/ordinal, not from text, so the
    // longer string does not disturb the client dedupe identity.
    const localityTail = localityTailOf(r);
    const finalText = localityTail ? `${text}, ${localityTail}` : text;
    const entry = {
      text: finalText,
      expanded_text: expandForTTS(finalText),
      field: r.field,
      circuit: null,
    };
    if (r.board_id != null) {
      entry.board_id = r.board_id;
    }
    const sectionDedupeOperation = sectionDedupeOperationOf(r);
    if (sectionDedupeOperation) {
      Object.defineProperty(entry, SECTION_DEDUPE_OPERATION, {
        value: sectionDedupeOperation,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    // W1.4 transient confidence sidecar (board-level degenerate path).
    entry._confidence = typeof r.confidence === 'number' ? r.confidence : null;
    out.push(entry);
  }
  return out;
}

/**
 * Translate per-turn tool-call outcomes into the legacy `extraction` result
 * shape that iOS `ServerWebSocketService` expects.
 *
 * @param {{readings: Map<string, {value: any, confidence: number, source_turn_id?: string, boardId?: string}>,
 *          boardReadings: Map<string, {value: any, confidence: number, source_turn_id?: string, boardId?: string}>,
 *          cleared: Array<{field: string, circuit: string, reason?: string}>,
 *          observations: Array<{id: string, text: string, code: string}>,
 *          deletedObservations: Array<{id: string, reason?: string}>,
 *          circuitOps: Array<{op: string, circuit_ref: string, from_ref?: string, board_id?: string, meta?: any}>,
 *          boardOps?: Array<{op: string, [key: string]: any}>}} perTurnWrites
 *   Accumulator populated by Phase 2 dispatchers (Plans 02-03 + 02-04 +
 *   Bug-C carryover dispatcher record_board_reading + Phase 6 board-op
 *   dispatchers).
 * @param {{questions?: Array<any>}|null|undefined} legacyResultShape
 *   The legacy extractor's result object. Only `.questions` is consumed
 *   (Phase 2 keeps legacy question-gate behaviour; tool-call ask_user is
 *   Phase 3+). If null/undefined, treated as `{}` so the bundler still
 *   produces a valid empty-questions shape even when the legacy path threw.
 * @returns {{extracted_readings: Array<{field: string, circuit: string, value: any, confidence: number, source: 'tool_call', board_id?: string}>,
 *            observations: Array<{id: string, text: string, code: string}>,
 *            questions: Array<any>,
 *            cleared_readings?: Array<{field: string, circuit: string, reason?: string}>,
 *            circuit_updates?: Array<{op: string, circuit_ref: string, from_ref?: string, board_id?: string, meta?: any}>,
 *            observation_deletions?: Array<{id: string, reason?: string}>,
 *            extracted_board_readings?: Array<{field: string, value: any, confidence: number, source: 'tool_call', board_id?: string, derived?: true}>,
 *            board_ops?: Array<{op: string, [key: string]: any}>}}
 */
export function bundleToolCallsIntoResult(perTurnWrites, legacyResultShape, options = {}) {
  if (!perTurnWrites || !(perTurnWrites.readings instanceof Map)) {
    throw new TypeError('bundleToolCallsIntoResult: perTurnWrites.readings must be a Map');
  }
  // Loaded Barrel Phase 1.B → Phase 4a wire contract. When the caller
  // (runLiveMode / runShadowHarness) supplies the per-turn turnId via
  // options.turnId, emit it as `result.turn_id` so iOS Phase 4a can
  // round-trip it on the TTS POST body for cache lookup. Omitted when
  // not supplied so legacy bundler call sites (and pre-Phase-4a iOS
  // decoders) see byte-identical wire traffic.
  const _turnId = typeof options.turnId === 'string' && options.turnId ? options.turnId : null;
  const _confirmationDedupeTurnId =
    typeof perTurnWrites?.[CONFIRMATION_REPLAY_TOKEN] === 'string' &&
    perTurnWrites[CONFIRMATION_REPLAY_TOKEN]
      ? perTurnWrites[CONFIRMATION_REPLAY_TOKEN]
      : _turnId;
  // Voice-latency plan 2026-06-05 Phase 2.1 — echo the iOS-minted
  // utterance_id of the transcript that drove this turn back to iOS so
  // DeepgramRecordingViewModel.handleServerExtraction can pair it with
  // the stashed pendingUtteranceEnds entry and fire the non-orphan
  // /api/voice-latency/utterance-end POST. Without this, every
  // utterance_end POST orphans at iOS TTL (~30 s) and the dashboard's
  // perceived-latency metric never lands. iOS already decodes
  // `utterance_id` via RollingExtractionResult.utteranceId
  // (ClaudeService.swift:376-425). Live mode receives one transcript
  // per harness invocation so this is exactly that transcript's id;
  // shadow/off batch paths do not thread it (out of scope per plan
  // §2.1, no live impact). Emit `null` when caller didn't supply (back-
  // compat with existing tests).
  const _utteranceId =
    typeof options.utteranceId === 'string' && options.utteranceId ? options.utteranceId : null;
  // boardReadings is optional for backwards compat with any caller that
  // builds the accumulator manually (e.g. older test fixtures that pre-date
  // the Bug C carryover). createPerTurnWrites() always seeds an empty Map.
  const boardReadings =
    perTurnWrites.boardReadings instanceof Map ? perTurnWrites.boardReadings : new Map();
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
  // Audio-first read-back exemption (2026-06-18): automatic derivations and
  // side-effect ticks are computed consequences, NOT dictated readings, and
  // must NOT produce a spoken confirmation (Audio-First invariant 1
  // exception). Polarity/mirror derivations carry `derived: true` (e.g. the
  // bonding-continuity mirror in stage6-dispatchers-board) and stay silent.
  //
  // F/U-1 (2026-07-19) — calculator writes (`::calc::<tool>` source_turn_id,
  // applyCalculatedReading) are NO LONGER read-back-exempt. The Phase-4
  // prompt steer (marker-②, PR #99) reserves calculate_zs /
  // calculate_r1_plus_r2 for EXPLICIT compute intent, so every ::calc::
  // write is an explicitly-requested result the hands-free inspector must
  // hear — pre-fix an explicit "calculate Zs" computed + wrote SILENTLY
  // (beep-then-silence on a successful turn). They speak with distinct
  // "calculated as" phrasing so a derived value is ear-distinguishable from
  // a meter reading. Mirror/polarity ticks (`derived: true`) remain the
  // designed-silent exception.
  const suppressConfirmationReadings = new Set();
  const calcConfirmationReadings = new Set();
  // id-100(b) — impedance-clamp corrections, carried from the dispatcher's
  // perTurnWrites value entry (Symbol-keyed) onto the freshly-projected reading
  // object the confirmation synthesiser will see. A WeakMap keyed on the reading
  // object is the same identity-based hand-off the two Sets above use; it cannot
  // reach the wire because the projected `reading` objects are serialised by
  // key enumeration and the correction never becomes one of their keys.
  const clampCorrectionByReading = new WeakMap();
  // PLAN-F2 finding 1 (2026-08-14) — same hand-off pattern as
  // clampCorrectionByReading above, for BULK_OUTCOME_CALL_ID. Only circuit
  // readings (never board readings — dispatchSetFieldForAllCircuits writes
  // circuits only) carry this stamp.
  const bulkOutcomeCallIdByReading = new WeakMap();
  // A2 (2026-07-28) — `replaces_cleared` candidate index. Keyed by the SAME
  // slot identity the P5 collapse below matches on, and SPLIT the same way
  // (effective-stamped writes vs Symbol-less raw-key writes) so a lookup can
  // never resolve to a write the collapse predicate itself would not have
  // considered. Values are the PROJECTED reading objects, so a hit can be
  // stamped directly. Derived/mirror writes are excluded from candidacy — they
  // are designed-silent computed consequences, never the audible replacement a
  // clear was superseded by. CALCULATOR writes REMAIN candidates: since F/U-1
  // (2026-07-19) a `::calc::` result is an explicitly-requested, spoken and
  // authoritative value, so a clear→calculate turn has exactly the same
  // spoken-but-not-written exposure on web as a clear→dictate turn.
  const replacesEffectiveCandidates = new Map();
  const replacesRawCandidates = new Map();
  const addReplacesCandidate = (map, slotKey, reading) => {
    const bucket = map.get(slotKey);
    if (bucket) bucket.push(reading);
    else map.set(slotKey, [reading]);
  };
  const isDerivedWrite = (entry) => entry?.derived === true;
  const isCalcWrite = (entry) =>
    typeof entry?.source_turn_id === 'string' && entry.source_turn_id.startsWith('::calc::');
  // A2-multiboard (2026-07-28) — effective-board WIRE ENRICHMENT bookkeeping.
  //
  // `dispatchRecordReading` stores only the RAW `input.board_id`, which the
  // model omits in the common case, so a write dispatched while board B is
  // selected reaches the wire with no `board_id` at all. Both clients then
  // resolve it by circuit REF alone (web `ensureRow`, iOS's single envelope-
  // wide current/first-board fallback), so two winners for circuit 3 on two
  // different boards land on ONE client row — the write survives the bundler
  // and is still lost. The effective board the dispatcher resolved is recorded
  // here per projected reading and stamped onto the wire below.
  const effectiveBoardByReading = new WeakMap();
  // PLAN-2C — direct projection of the dispatcher-owned section operation
  // stamp. This never infers identity from optional wire scope or synthesized
  // confirmation order.
  const sectionDedupeOperationByReading = new WeakMap();
  const distinctEffectiveBoards = new Set();
  // A2-multiboard (2026-07-28) — project from the JOURNAL, not the raw Map.
  //
  // The raw Map key is board-AMBIGUOUS (`record_reading` omits `board_id` in
  // the common case), so `select_board A → write → select_board B → write`
  // collapsed onto ONE Map entry and the bundler could only ever see board B's
  // value: board A's dictated reading had been read back aloud and then
  // silently vanished. `projectReadingWinners` returns the last-write-wins
  // winner per EFFECTIVE slot, so BOTH boards' writes reach the wire.
  //
  // Ordering is preserved: the projection emits each effective slot at its
  // FIRST-appearance index, which reproduces `Map.set` insertion-order
  // semantics exactly whenever no two effective slots share a raw key — i.e.
  // for all single-board traffic the wire byte order does not move. Entries
  // that never went through a staging helper (legacy hand-built accumulators)
  // are appended verbatim in Map order.
  const readingWinners = projectReadingWinners(perTurnWrites);
  for (const { rawKey: key, value: entry } of readingWinners) {
    // Slice 1.1c — decodeReadingKey handles BOTH the new boardId-tagged
    // shape `${field}::${circuit}<NUL>__board__<NUL>${boardId}<NUL>` and
    // legacy 2-part `${field}::${circuit}` keys (test fixtures or older
    // accumulators) so this loop is shape-agnostic. boardId from the key
    // is NOT used for emission — the value entry's boardId (set by the
    // dispatcher in slice 1.1a) is the wire-shape SoT; the key boardId
    // is purely a same-turn collision-key.
    const decodedKey = decodeReadingKey(key);
    const { field, circuit: circuitStr } = decodedKey;
    const circuitInt = Number(circuitStr);
    const circuit =
      circuitStr !== '' && Number.isInteger(circuitInt) && String(circuitInt) === circuitStr
        ? circuitInt
        : circuitStr;
    const reading = {
      field,
      circuit,
      value: entry.value,
      confidence: entry.confidence,
      source: 'tool_call',
    };
    // P3-B (2026-04-27) — propagate the auto_resolve marker so the slot
    // comparator can filter synthetic writes out of shadow-vs-live diffs.
    // Set ONLY when truthy so the JSON wire shape stays byte-identical for
    // every Sonnet-direct write (the existing iOS decoder doesn't know this
    // field; omitting when undefined keeps the snapshot stable).
    if (entry.auto_resolved === true) {
      reading.auto_resolved = true;
    }
    // Address/locality mirrors and other automatic consequences must remain
    // distinguishable after they cross the client boundary. The server already
    // suppresses their generated confirmations; carrying the additive marker
    // also prevents a Voice-off client from inventing a local correction
    // read-back for a write the inspector did not dictate.
    if (isDerivedWrite(entry)) {
      reading.derived = true;
    }
    // "Work on Board" hotfix slice 1.1a (2026-05-08) — emit board_id when
    // the dispatcher recorded one on the value entry. Omit otherwise so
    // single-board sessions stay byte-identical to pre-hotfix traffic and
    // pre-fix iOS clients (which ignore the field via decodeIfPresent) see
    // no change.
    if (entry.boardId != null) {
      reading.board_id = entry.boardId;
    }
    if (isDerivedWrite(entry)) {
      suppressConfirmationReadings.add(reading);
    } else if (isCalcWrite(entry)) {
      calcConfirmationReadings.add(reading);
    }
    // A2-multiboard — remember the dispatcher-resolved effective board for the
    // enrichment pass below. Derived/mirror writes are included here (unlike
    // the candidate index): they are silent, but they still have to land on the
    // right client row.
    {
      const effBoard = entry?.[EFFECTIVE_CIRCUIT_SLOT]?.boardId ?? null;
      if (effBoard != null && effBoard !== '') {
        effectiveBoardByReading.set(reading, effBoard);
        distinctEffectiveBoards.add(effBoard);
      }
    }
    // A2 — index this projected reading as a `replaces_cleared` candidate
    // unless it is a derived/mirror write (see the Map declarations above).
    if (!isDerivedWrite(entry)) {
      const effSym = entry?.[EFFECTIVE_CIRCUIT_SLOT];
      if (effSym) {
        addReplacesCandidate(
          replacesEffectiveCandidates,
          rawCircuitSlot(effSym.field, effSym.circuit, effSym.boardId),
          reading
        );
      } else {
        addReplacesCandidate(
          replacesRawCandidates,
          rawCircuitSlot(decodedKey.field, decodedKey.circuit, decodedKey.boardId),
          reading
        );
      }
    }
    // id-100(b) — carry the dispatcher's clamp correction across the projection
    // boundary. Read off the Symbol (never an enumerable key), so a legacy or
    // hand-built fixture entry simply has no correction.
    const clampCorrection = entry?.[IMPEDANCE_CLAMP_CORRECTION];
    if (clampCorrection) {
      clampCorrectionByReading.set(reading, clampCorrection);
    }
    // PLAN-F2 finding 1 (2026-08-14) — carry the bulk-call identity across
    // the projection boundary, same pattern as the clamp correction above.
    const bulkOutcomeCallId = entry?.[BULK_OUTCOME_CALL_ID];
    if (bulkOutcomeCallId) {
      bulkOutcomeCallIdByReading.set(reading, bulkOutcomeCallId);
    }
    extracted_readings.push(reading);
  }

  // P5 (2026-07-23) — same-turn clear→write collapse. A clear_reading + write
  // for the SAME circuit slot in ONE turn emitted the write frame FIRST then
  // the stale clear frame, so the clear (minted against pre-write state) wiped
  // the value on the client even though the server ended with it (marker T10 /
  // feedback 80B+81). write→clear is ALREADY collapsed correctly for circuit
  // slots by dispatchClearReading's same-turn delete (only the clear survives).
  // The MIRROR — clear→final-write — is closed HERE by a PURE projection-time
  // filter: drop any clear correction whose slot has a SURVIVING readings
  // write. Given the effective-aware dispatcher delete, a surviving readings
  // entry co-present with a clear correction can only mean the write came
  // AFTER the clear.
  //
  // Scope: circuit-reading slots from perTurnWrites.readings ONLY. boardReadings
  // is EXCLUDED — the dispatcher delete never covers it, so co-presence is not
  // an ordering proof at board scope and a board-scope collapse would wrongly
  // drop a legitimate board write→clear clear (the inverse divergence). Board-
  // level write→clear ordering is a pre-existing separate behaviour, out of P5
  // scope (dated note 2026-07-23).
  //
  // Identity: matches the clear entry's EFFECTIVE slot key against the surviving
  // readings entries' EFFECTIVE keys (both carry EFFECTIVE_CIRCUIT_SLOT, stamped
  // at dispatch). Symbol-less entries (legacy/hand-built fixtures) fall back to
  // RAW decoded Map-key identity via the shared rawCircuitSlot helper — readings
  // identity derived EXCLUSIVELY from decodeReadingKey(mapKey) (the Map key is
  // authoritative; value.boardId is outward wire metadata only). The raw
  // fallback applies ONLY when BOTH compared sides lack the Symbol; a one-sided
  // pair never infers ordering (no collapse). currentBoardId is NEVER resolved
  // here (a mid-turn select_board would skew it).
  const survivingEffectiveSlots = new Set();
  const survivingRawSlots = new Set();
  // A2-multiboard — read survival from the JOURNAL winners for the same reason
  // the projection above does: a board-A write shadowed under a shared raw Map
  // key still SURVIVED the turn, and a raw-Map scan would have missed it, so a
  // clear on board A would not have collapsed against its own replacement.
  for (const { rawKey: mapKey, value: val } of readingWinners) {
    const sym = val?.[EFFECTIVE_CIRCUIT_SLOT];
    if (sym) {
      survivingEffectiveSlots.add(rawCircuitSlot(sym.field, sym.circuit, sym.boardId));
    } else {
      const d = decodeReadingKey(mapKey);
      survivingRawSlots.add(rawCircuitSlot(d.field, d.circuit, d.boardId));
    }
  }
  const clearSlotHasSurvivingWrite = (entry) => {
    const sym = entry?.[EFFECTIVE_CIRCUIT_SLOT];
    if (sym) {
      return survivingEffectiveSlots.has(rawCircuitSlot(sym.field, sym.circuit, sym.boardId));
    }
    // Both-Symbol-less fallback: match against the RAW surviving set only.
    return survivingRawSlots.has(
      rawCircuitSlot(entry?.field, entry?.circuit, entry?.board_id ?? null)
    );
  };
  // Plan A1a (2026-07-27) — mechanism B, the BOARD twin of the circuit
  // collapse above. A board correction can now emit clear_board_reading then
  // a replacement record_board_reading in one turn (the documented
  // replacement idiom); the circuit machinery cannot see board slots
  // (board writes live in perTurnWrites.boardReadings, and a board clear's
  // circuit is null so the raw circuit fallback can never match). Deferring
  // this recreates P5's exact clear→write wipe at board scope: the #31 gate
  // silences the spoken clear (replacement), the stale clear frame then
  // wipes the client AFTER the write's extraction envelope — client blank,
  // server written, nothing audible about it.
  //
  // Identity: EFFECTIVE_BOARD_SLOT stamps ONLY (canonical field + scope-
  // conditioned board id — global fields board-insensitive). No raw
  // fallback: a board clear only ever dispatches for a SCOPE-CLASSIFIED
  // field, and a same-slot write of that field is stamped by
  // dispatchRecordBoardReading, so a stamp-vs-stamp match is complete for
  // every reachable pair; an unstamped (unclassified legacy) write can
  // never co-exist with a board clear of the same slot.
  const survivingBoardSlots = new Set();
  // Defensive: hand-built accumulators (older test fixtures) may omit the
  // boardReadings Map entirely.
  // A2-multiboard — board winners come from the board JOURNAL for the same
  // reason as the circuit side: `record_board_reading` has no schema `board_id`
  // at all, so `select_board A → record manufacturer → select_board B → record
  // manufacturer` shares ONE raw key and a Map scan sees only board B.
  const boardReadingWinners = projectBoardReadingWinners(perTurnWrites);
  // A2-multiboard item 7 (2026-07-28) — the BOARD twin of the
  // `replaces_cleared` candidate index. Mechanism B already dropped the stale
  // board clear from the wire; without a stamp on the surviving board write,
  // web receives a BARE board write against a still-populated cell and its
  // fill-only gate silently skips it — P5's exact defect, at board scope.
  //
  // This index holds the perTurnWrites VALUE object, not the wire reading: the
  // board readings are projected much further down (after `result` exists), so
  // the wire object the stamp belongs on has not been built yet. The stamp is
  // therefore applied by OBJECT IDENTITY in that loop, which is stricter than
  // re-deriving the slot key there and cannot drift from what the collapse
  // predicate actually matched.
  const replacesBoardCandidates = new Map();
  for (const { value: val } of boardReadingWinners) {
    const bsym = val?.[EFFECTIVE_BOARD_SLOT];
    if (!bsym) continue;
    const bslot = boardSlotKey(bsym.field, bsym.boardId);
    survivingBoardSlots.add(bslot);
    // Derived/mirror board writes are silent (they never produce a read-back),
    // so they are excluded from candidacy for the same reason as the circuit
    // side: there is nothing spoken for the flag to protect.
    if (!isDerivedWrite(val)) addReplacesCandidate(replacesBoardCandidates, bslot, val);
  }
  const boardClearHasSurvivingWrite = (entry) => {
    const bsym = entry?.[EFFECTIVE_BOARD_SLOT];
    if (!bsym) return false;
    return survivingBoardSlots.has(boardSlotKey(bsym.field, bsym.boardId));
  };
  // Compute the collapse ONCE and reuse for the wire field_corrections
  // projection, the cleared_readings envelope, and the cleared-confirmation
  // synthesis so all three stay consistent. cleared entries carry NO reason
  // predicate (every perTurnWrites.cleared entry is a clear; its `reason` holds
  // the MODEL's free-form reason, never the literal 'clear_reading' — a literal
  // predicate would match nothing); fieldCorrections gate on
  // reason === 'clear_reading'. Corrections with reason same_turn_correction /
  // replace_value are NEVER dropped — those legitimately coexist with a write.
  const rawFieldCorrections = Array.isArray(perTurnWrites.fieldCorrections)
    ? perTurnWrites.fieldCorrections
    : [];
  const clearWriteCollapsedSlots = [];
  // Telemetry is ONE row PER COLLAPSED SLOT, not per dropped correction: a
  // clear→write→clear→final-write sequence drops TWO clear corrections for the
  // SAME slot, but that is one collapse event. Dedupe on the effective/raw slot
  // identity (the same key the collapse matched on) while still dropping EVERY
  // matched correction from the wire.
  const collapsedSlotSeen = new Set();
  // A2 — accumulated here, applied AFTER `const result` below. The stamps
  // themselves could be applied in-loop, but the ambiguity manifest Symbol
  // cannot (`result` is in its temporal dead zone until the declaration), so
  // both halves are deferred together and land at one site.
  const pendingStamp = [];
  // A2-multiboard item 7 — board twin of `pendingStamp`. Holds perTurnWrites
  // VALUE objects (see `replacesBoardCandidates`); consumed by identity in the
  // board-reading projection loop further down, which is the first point at
  // which the wire object exists. A Set (not an Array) because two clear
  // corrections for one slot must not queue the same write twice.
  const pendingBoardStamp = new Set();
  const keptFieldCorrections = [];
  for (const c of rawFieldCorrections) {
    if (c && c.reason === 'clear_reading' && clearSlotHasSurvivingWrite(c)) {
      const sym = c[EFFECTIVE_CIRCUIT_SLOT];
      const slotKey = sym
        ? rawCircuitSlot(sym.field, sym.circuit, sym.boardId)
        : rawCircuitSlot(c.field, c.circuit, c.board_id ?? null);
      if (!collapsedSlotSeen.has(slotKey)) {
        collapsedSlotSeen.add(slotKey);
        clearWriteCollapsedSlots.push({
          field: c.field,
          circuit: c.circuit,
          board_id: sym?.boardId ?? c.board_id ?? null,
          final_effect: 'write',
        });
        // A2 (2026-07-28) — the collapse just dropped this clear from the wire,
        // so web receives a BARE write against a still-populated cell and its
        // fill-only `applyCircuitReadings` gate silently skips it (the reading
        // is spoken and stored server-side but never lands on web — the inverse
        // Audio-First violation). Mark the surviving reading so the consumer can
        // tell "this write REPLACES a value the server already cleared" apart
        // from an ordinary write. Look the candidate up with the SAME
        // effective-first slotKey the collapse matched on (never the raw
        // `c.field`/`c.circuit`, which would mis-key a scope-resolved clear) and
        // in the SAME-sidedness bucket, so a stamp can only ever land on a write
        // the collapse predicate itself considered.
        const cands = (sym ? replacesEffectiveCandidates : replacesRawCandidates).get(slotKey);
        // A2-multiboard (2026-07-28) — A2-core's fail-closed-UNFLAGGED branch
        // for `cands.length > 1` is REMOVED, because the case it defended
        // against can no longer arise. It fired when two same-turn SPELLINGS of
        // one slot (one omitting `board_id`, one carrying the explicit current
        // board) both survived as separate raw Map keys, leaving the stamp a
        // guess. The journal projection above is last-write-wins per EFFECTIVE
        // slot, so those two spellings now resolve to exactly ONE winner —
        // there is nothing left to guess between, and the write the inspector
        // actually spoke last is the one that gets flagged.
        //
        // The defensive `length === 1` shape is kept (rather than taking
        // `cands[0]` unconditionally) so a future producer that reintroduced a
        // duplicate would fail SILENT-UNFLAGGED rather than stamp arbitrarily.
        if (cands && cands.length === 1) {
          pendingStamp.push(cands[0]);
        }
        // cands undefined/empty is reachable only when the sole surviving write
        // for the slot was a derived/mirror write (excluded from candidacy).
        // Nothing audible replaced the clear, so there is nothing to stamp.
      }
      continue;
    }
    // Plan A1a — mechanism B: board clear→write collapse. Same telemetry
    // dedupe discipline as the circuit branch (one row per collapsed SLOT).
    if (c && c.reason === 'clear_reading' && boardClearHasSurvivingWrite(c)) {
      const bsym = c[EFFECTIVE_BOARD_SLOT];
      const bslot = boardSlotKey(bsym.field, bsym.boardId);
      const slotKey = `board:${bslot}`;
      if (!collapsedSlotSeen.has(slotKey)) {
        collapsedSlotSeen.add(slotKey);
        clearWriteCollapsedSlots.push({
          field: c.field,
          circuit: null,
          board_id: bsym.boardId ?? c.board_id ?? null,
          final_effect: 'write',
        });
        // A2-multiboard item 7 — queue the surviving board write for the
        // `replaces_cleared` stamp. Same defensive `length === 1` shape as the
        // circuit branch: the journal projection is last-write-wins per
        // EFFECTIVE board slot so exactly one winner is the norm, and a future
        // producer that reintroduced a duplicate fails SILENT-UNFLAGGED rather
        // than stamping an arbitrary one of them.
        const bcands = replacesBoardCandidates.get(bslot);
        if (bcands && bcands.length === 1) {
          pendingBoardStamp.add(bcands[0]);
        }
        // bcands undefined/empty is reachable only when the sole surviving
        // write for the slot was derived/mirror (excluded from candidacy) —
        // nothing audible replaced the clear, so nothing to stamp.
      }
      continue;
    }
    keptFieldCorrections.push(c);
  }

  // 2-3. Observations + questions — defensive copies so downstream mutation
  //      cannot retroactively alter the bundled result.
  const result = {
    extracted_readings,
    observations: [...perTurnWrites.observations],
    questions: Array.isArray(legacy.questions) ? [...legacy.questions] : [],
  };
  if (clearWriteCollapsedSlots.length > 0) {
    // Telemetry-only; non-enumerable so it never rides the wire or a spread.
    Object.defineProperty(result, SAME_TURN_CLEAR_WRITE_COLLAPSED, {
      value: clearWriteCollapsedSlots,
      enumerable: false,
    });
  }
  // A2 — apply the deferred `replaces_cleared` stamps. Enumerable and
  // omit-when-false: an ordinary write carries no such key, so every existing
  // wire snapshot (and every client that has never heard of the field) is
  // byte-identical to pre-A2.
  for (const reading of pendingStamp) {
    reading.replaces_cleared = true;
  }
  // A2-multiboard (2026-07-28) — effective-board WIRE ENRICHMENT.
  //
  // Two classes of reading get the dispatcher-resolved effective board stamped
  // onto the wire when the model omitted it:
  //
  //   1. FLAGGED replacements, ALWAYS (archive P1's enrichment clause). The
  //      collapse manifest already keys on the EFFECTIVE board, so without this
  //      the manifest knows the board while the reading does not — and the
  //      board-aware fail-closed targeting on the client would then reject a
  //      perfectly valid multi-board replacement as unresolvable, which is the
  //      exact spoken-but-not-written defect this whole plan closes.
  //
  //   2. ORDINARY writes, but ONLY on a CROSS-BOARD turn (winners spanning two
  //      or more distinct effective boards). This is deliberately narrow. On a
  //      single-board turn — including every turn of a multi-board job where
  //      the inspector is working one board at a time — nothing is enriched, so
  //      the wire stays byte-identical to pre-A2 and the loaded-barrel
  //      speculator's null-board cache entries keep hitting (blanket enrichment
  //      would cost latency on every turn to fix a defect that only exists when
  //      two boards are written in ONE turn; Audio-First #3).
  //
  // An already-explicit `board_id` is never overwritten: the model said which
  // board it meant, and the dispatcher validated that against the current one.
  const enrichCrossBoard = distinctEffectiveBoards.size > 1;
  for (const reading of extracted_readings) {
    if (reading.board_id != null) continue;
    if (reading.replaces_cleared !== true && !enrichCrossBoard) continue;
    const effBoard = effectiveBoardByReading.get(reading);
    if (effBoard != null) reading.board_id = effBoard;
  }
  if (_turnId) result.turn_id = _turnId;
  // Voice-latency plan 2026-06-05 Phase 2.1 — emit `utterance_id`
  // ONLY when supplied (matches the `turn_id` emit-when-truthy
  // pattern above so the existing iOS-parity regression test at
  // stage6-event-bundler.test.js:28-37 still passes byte-identically
  // for legacy callers that don't thread the field). iOS decodes
  // `utterance_id` via decodeIfPresent (ClaudeService.swift:425)
  // and treats missing-key and JSON-null identically — both leave
  // RollingExtractionResult.utteranceId nil, which DeepgramRecording-
  // ViewModel.handleServerExtraction reads as "no matching pending
  // utterance, skip the non-orphan POST" (the desired pre-Tier-1.3
  // behaviour). When the caller IS the live `handleTranscript` path
  // (which always supplies a string), every production extraction
  // envelope now carries the field and the iOS pairing fires.
  if (_utteranceId) result.utterance_id = _utteranceId;

  // A1 agentic-voice (2026-07-23) — project the turn's staged spoken answer
  // (answer_user success, or the Item-4 fixed fallback staged by runLiveMode's
  // post-loop finalization) as `result.spoken_response`. The EXISTING
  // voice_command_response emit machinery in sonnet-stream.js (sync path +
  // P4d reconnect replay) then fires unchanged — answer-after-extraction
  // ordering, the utterance_id stamp, socket-down buffering and FIFO replay
  // all for free. Key OMITTED when nothing is staged, so flag-off (and every
  // answer-less turn) stays byte-identical to pre-A1.
  //
  // `answer_source` is the internal origin marker for redacted logging at the
  // emit site (model-controlled text is never logged raw). It MUST NOT ride
  // the wire: the raw result is destructure-spread into extraction frames at
  // three sites AND buffered whole into pendingExtractions when the socket is
  // down, so it is attached NON-ENUMERABLY — every spread/JSON.stringify site
  // is then automatically clean while `result.answer_source` stays readable.
  const _answerState = perTurnWrites.answer;
  if (typeof _answerState?.stagedText === 'string' && _answerState.stagedText.trim()) {
    result.spoken_response = _answerState.stagedText;
    // Codex diff-review r1 — the internal source token is exactly
    // 'answer_user' per the plan's Item 1.5 contract; the fallback
    // distinction lives ONLY on answer_meta.fallback (telemetry dimension),
    // never as a second source token.
    Object.defineProperty(result, 'answer_source', {
      value: 'answer_user',
      enumerable: false,
    });
    // Same non-enumerable treatment for the emit-site telemetry meta
    // (chars/truncated/fallback) — readable at sonnet-stream's
    // redacted-logging branch, never on the wire.
    Object.defineProperty(result, 'answer_meta', {
      value: {
        truncated: _answerState.stagedMeta?.truncated === true,
        chars: _answerState.stagedText.length,
        fallback: _answerState.stagedMeta?.fallback === true,
      },
      enumerable: false,
    });
  }

  // 4-6. New Phase 2 slots — OMITTED when empty so iOS decoders unaware of
  //      these keys see byte-identical traffic to today. Swift Codable
  //      ignores unknown keys, but omission keeps session logs clean.
  if (perTurnWrites.cleared.length > 0) {
    // P5 — drop cleared entries whose slot has a surviving same-turn write
    // (clear→write). No reason predicate: every cleared entry is a clear.
    // OMITTED when all were collapsed, keeping the empty-slot byte-identity.
    const keptCleared = perTurnWrites.cleared.filter((c) => !clearSlotHasSurvivingWrite(c));
    if (keptCleared.length > 0) {
      result.cleared_readings = keptCleared;
    }
  }
  if (perTurnWrites.circuitOps.length > 0) {
    result.circuit_updates = [...perTurnWrites.circuitOps];
  }
  if (perTurnWrites.deletedObservations.length > 0) {
    result.observation_deletions = [...perTurnWrites.deletedObservations];
  }
  // 1a.6 — field_corrected event payloads. Carried on result so the
  // orchestrator (sonnet-stream.js) can iterate after sending the
  // extraction envelope and emit each as a separate WS message with the
  // pinned wire shape from PLAN_v3 §4.5 (type/circuit/field/
  // previous_value/reason). OMITTED when empty so back-compat decoders
  // never see the key.
  if (keptFieldCorrections.length > 0) {
    // §A2 (field-feedback-2026-07-14, F5) — canonicalise ONLY this outbound
    // wire copy, with NEW objects. Session 6B6FE011: `dispatchClearReading`
    // pushed the raw dispatcher key (`r1_r2_ohm`) and it went to the wire
    // uncanonicalised → iOS `stage6_field_corrected_unmapped` → the cell
    // never cleared while the TTS said "cleared" (a silent wrong-state, the
    // inverse of the audio-first invariant). The record-APPLY wire path
    // already canonicalises (sonnet-stream.js:794 applyFieldNameCorrection),
    // so the clear path must speak the same dialect.
    //
    // Two constraints make this exact shape load-bearing:
    // 1. NEW objects (map + spread), never in-place: the confirmation-
    //    synthesis block below (synthesiseObservationAndClearedConfirmations)
    //    runs AFTER this line in the same function and compares the field
    //    corrections against writtenSlots on the RAW key to suppress the
    //    redundant "<field> cleared" TTS when the same turn also writes a
    //    replacement. An in-place `.field` rewrite through the old shallow
    //    copy would corrupt that compare and double-speak. (The spread also
    //    drops the non-enumerable P5 slot marker — matching already ran.)
    // 2. CLEAR_WIRE_EXEMPT (r2_ohm): see the constant's comment — the
    //    canonical `r2` lands on the WRONG deployed clearer cell.
    // P5 — source array is `keptFieldCorrections` (clear→write collapsed
    // clears already dropped), so a wiped slot's stale clear never reaches the
    // wire. Matching happened on RAW dispatcher field keys BEFORE this A2
    // canonicalisation (an A2-mapped field like ir_live_live_mohm / r1_r2_ohm
    // matched pre-conversion; r2_ohm keeps its exemption).
    result.field_corrections = keptFieldCorrections.map((c) => ({
      ...c,
      field: CLEAR_WIRE_EXEMPT.has(c.field) ? c.field : (FIELD_CORRECTIONS[c.field] ?? c.field),
    }));
  }

  // 7. Phase 2 carryover slot — supply / installation / board-level writes
  //    via record_board_reading. Same shape as extracted_readings (field +
  //    value + confidence + source: 'tool_call') but WITHOUT a `circuit`
  //    field — these readings always live at circuits[0] in the snapshot.
  //    Emitting them in a SEPARATE slot (rather than merging into
  //    extracted_readings with circuit:0) makes the Stage 6 wire shape
  //    self-describing — a downstream consumer can tell tool_call board
  //    writes apart from circuit writes without having to inspect every
  //    entry's `circuit` field. The slot comparator (Plan 02-06) projects
  //    legacy's circuit:0 readings into the same comparison Map so
  //    divergence comparison still aligns the two paths.
  //
  //    Map.entries() preserves insertion order — same property the readings
  //    Map relies on for STT-09 same-turn correction.
  // A2-multiboard — iterate the board JOURNAL winners (computed above) rather
  // than the raw Map, so two boards' writes of one board-scoped field both
  // reach the wire instead of the second silently destroying the first. The
  // `boardReadings.size` guard is retained as the emit condition: an empty Map
  // means an empty journal, and hand-built accumulators with a Map but no
  // journal still project through the winner helper's legacy passthrough.
  if (boardReadings.size > 0) {
    const extracted_board_readings = [];
    for (const { rawKey: key, value: entry } of boardReadingWinners) {
      // Slice 1.1c — same key-decoder treatment as the readings Map. Legacy
      // field-only keys decode to boardId=null; new boardId-tagged keys
      // strip the tag so `field` is the bare field name on the wire.
      const { field } = decodeBoardReadingKey(key);
      const reading = {
        field,
        value: entry.value,
        confidence: entry.confidence,
        source: 'tool_call',
      };
      // P3-B — same auto_resolve propagation as extracted_readings above.
      if (entry.auto_resolved === true) {
        reading.auto_resolved = true;
      }
      if (isDerivedWrite(entry)) {
        reading.derived = true;
      }
      // "Work on Board" hotfix slice 1.1a — emit board_id so shadow-harness's
      // fold to extracted_readings (with circuit:0) carries the field through
      // to iOS, where applySonnetReadings can land board-level supply on the
      // right BoardInfo via the boardIndex(for:) helper rather than
      // pinning to boards[0].
      if (entry.boardId != null) {
        reading.board_id = entry.boardId;
      }
      // PLAN-2D — projected-write board identity. Egress sends the extraction
      // BEFORE current_board_changed, so a same-turn select_board(B) → write
      // must carry the dispatcher-resolved board. `board_id` has long been an
      // additive optional client key; the committed write-scope manifest is
      // now the compatibility boundary, so every stamped board-scoped write is
      // enriched regardless of the unrelated board-clear capability.
      {
        const a1aSym = entry?.[EFFECTIVE_BOARD_SLOT];
        if (a1aSym && a1aSym.boardId != null && reading.board_id == null) {
          reading.board_id = a1aSym.boardId;
        }
      }
      // A2-multiboard item 7 — the BOARD `replaces_cleared` stamp. Matched by
      // object identity against the queue the collapse branch built, so the
      // flag can only ever land on a write the collapse predicate itself
      // considered.
      if (pendingBoardStamp.has(entry)) {
        reading.replaces_cleared = true;
        // FLAGGED replacements are ALWAYS enriched with the resolved effective
        // board — item 1's rule, applied here to the board channel. Deliberately
        // NOT gated on `hasBoardClearV1` (unlike the ordinary fill above): the
        // collapse manifest keys on the EFFECTIVE board, so an un-enriched flag
        // would tell the client "this replaces a cleared value" while leaving it
        // no way to decide WHICH board's value — and a board-aware client that
        // fails closed on an unresolvable target would then drop a spoken
        // replacement, which is the exact defect this plan closes. Safe for
        // capability-absent clients too: `board_id` on a board reading (and on
        // its circuit:0 fold) has been decoded since slice 1.1a, so the extra
        // key can only route the value to the RIGHT board.
        if (reading.board_id == null) {
          const flaggedBoardId = entry?.[EFFECTIVE_BOARD_SLOT]?.boardId;
          if (flaggedBoardId != null && flaggedBoardId !== '') {
            reading.board_id = flaggedBoardId;
          }
        }
      }
      if (isDerivedWrite(entry)) {
        suppressConfirmationReadings.add(reading);
      }
      // id-100(b) — same clamp-correction hand-off as the circuit loop. This is
      // the branch the C06B9904 supply-Ze write travels through.
      const clampCorrection = entry?.[IMPEDANCE_CLAMP_CORRECTION];
      if (clampCorrection) {
        clampCorrectionByReading.set(reading, clampCorrection);
      }
      const sectionDedupeOperation = entry?.[SECTION_DEDUPE_OPERATION];
      if (sectionDedupeOperation) {
        sectionDedupeOperationByReading.set(reading, sectionDedupeOperation);
      }
      extracted_board_readings.push(reading);
    }
    result.extracted_board_readings = extracted_board_readings;
  }

  // 8. Phase 6.0 — multi-board board-ops wire channel (Codex deal-breaker #3).
  //    Append-only Array of discriminated-union ops emitted by Phase 6 board
  //    dispatchers (`add_board` / `select_board` / `mark_distribution_circuit`,
  //    plus any future board-mutation tool). Each entry carries an `op` field
  //    plus the payload the tool dispatcher built.
  //
  //    Emit verbatim (defensive shallow copy so downstream mutation can't
  //    retro-alter the bundled result). OMITTED when empty so pre-Phase-6
  //    traffic — every session today, since no dispatcher writes here yet —
  //    stays byte-identical and existing iOS decoders unaware of the slot
  //    see no change.
  //
  //    boardOps is optional in the input shape because callers building the
  //    accumulator manually (older test fixtures) may pre-date the Phase 6.0
  //    wire-in. createPerTurnWrites() always seeds an empty array.
  if (Array.isArray(perTurnWrites.boardOps) && perTurnWrites.boardOps.length > 0) {
    result.board_ops = perTurnWrites.boardOps.map((op) => ({ ...op }));
  }

  // 9. Stage 6 confirmation read-backs (2026-05-20).
  //    When the client opts in via `confirmations_enabled` on the
  //    transcript message (iOS Voice toggle → sonnet-stream.js:3707 →
  //    runShadowHarness options → here), synthesise brief text-to-speech
  //    read-backs from the per-turn writes. iOS already decodes
  //    `result.confirmations` (DeepgramRecordingViewModel.swift:7334) and
  //    applies its own dedupe/suppression layer; the backend's job is just
  //    to emit a short well-formed array per turn so the iOS speech queue
  //    has something to work with.
  //
  //    Legacy prose-JSON path: when `legacyResultShape.confirmations` is
  //    already populated (shadow mode, prompt-JSON extractor produced
  //    them), preserve those verbatim and skip synthesis — the legacy
  //    output is the authoritative shape there and we don't want to
  //    double-emit. Live mode always has `legacy === null` and synthesis
  //    is the only source.
  //
  //    OMITTED from the result when empty so pre-feature traffic and
  //    sessions where the inspector turned the toggle off stay byte-
  //    identical on the wire.
  if (Array.isArray(legacy.confirmations) && legacy.confirmations.length > 0) {
    result.confirmations = legacy.confirmations.map((c) => ({ ...c }));
  } else if (options.confirmationsEnabled === true) {
    const boardReadings = Array.isArray(result.extracted_board_readings)
      ? result.extracted_board_readings
      : [];
    // 2026-05-29 — circuit-designation lookup so TTS reads circuit names.
    // The caller (stage6-shadow-harness.js) builds the map from
    // session.stateSnapshot.circuits + the same-turn circuit_designation
    // writes in perTurnWrites.readings (so a freshly-named circuit
    // confirms with its NEW name, not "Circuit N").
    // totalCircuitsInJob lets the helper decide whether a multi-circuit
    // group qualifies as "all circuits" vs "circuits X to Y". Sourced
    // from the caller (stage6-shadow-harness.js builds it from
    // session.stateSnapshot.circuits, scoped to the SESSION'S currently
    // selected board). Null means "I don't know" → the helper falls
    // through to range/list phrasing.
    // A2-multiboard item 8 — `totalCircuitsByBoard` is the per-board census
    // that supersedes the scalar whenever the group's own effective board is
    // knowable; the scalar survives as the answer for an unambiguously
    // single-board job and for callers that pass no census at all.
    // Audio-first: exclude mirror/polarity auto-derivations (derived: true)
    // from the spoken read-back while keeping them on the extracted_readings
    // wire. F/U-1: calculator writes are NOT excluded — they speak with
    // "calculated as" phrasing (see calcConfirmationReadings above).
    const confirmableReadings = extracted_readings.filter(
      (r) => !suppressConfirmationReadings.has(r)
    );
    const confirmableBoardReadings = boardReadings.filter(
      (r) => !suppressConfirmationReadings.has(r)
    );
    const confirmations = synthesiseConfirmations(
      confirmableReadings,
      confirmableBoardReadings,
      options.circuitDesignations,
      options.totalCircuitsInJob ?? null,
      calcConfirmationReadings,
      clampCorrectionByReading,
      {
        byBoard: options.totalCircuitsByBoard instanceof Map ? options.totalCircuitsByBoard : null,
        // Same WeakMap the enrichment pass above consulted, so a group whose
        // wire `board_id` was deliberately left off (single-board turn) is
        // still measured against ITS board rather than the session's.
        effectiveBoardOf: (r) => effectiveBoardByReading.get(r) ?? null,
        sectionDedupeOperationOf: (r) => sectionDedupeOperationByReading.get(r) ?? null,
        // Plan E (E4) — threaded through to localityTailOf inside
        // synthesiseConfirmations. Omitted (undefined) on any caller that
        // doesn't pass it (test fixtures, the shadow-mode call site);
        // resolveEffectiveLocalityTail's snapshot guard returns null on a
        // missing snapshot, so the postcode confirmation just carries no
        // locality clause rather than throwing.
        stateSnapshot: options.stateSnapshot ?? null,
        // Plan B B1.3 — Map<slotKey, accepted identity>, resolved by the
        // caller (stage6-shadow-harness.js) immediately before this call.
        // Omitted (undefined) on any caller that doesn't pass it (test
        // fixtures, older call sites) — synthesiseConfirmations treats a
        // non-Map value as "no fast attempts this turn" and every reading
        // takes the unstamped path, byte-identical to pre-B1.3 behaviour.
        fastAttemptBySlotKey:
          options.fastAttemptBySlotKey instanceof Map ? options.fastAttemptBySlotKey : null,
      },
      // PLAN-F2 finding 1 (2026-08-14) — bulk-call identity WeakMap built
      // during projection above.
      bulkOutcomeCallIdByReading
    );
    // §A1a (field-feedback-2026-07-14) — the `ios_send_attempt` telemetry
    // loop and the `_confidence` strip MOVED to stage6-shadow-harness.js,
    // immediately after `applyConfirmationDebounce`. Rationale: rows were
    // emitted here BEFORE stateChanges/obsAndClears merged into the stream
    // (three of the five allowlisted text-op fields never got telemetry) and
    // BEFORE the harness's mid-stream filter + debounce (a suppressed
    // confirmation still produced a row — the forensic contract was false
    // both ways). The bundler now returns `result.confirmations` with the
    // transient `_confidence` sidecar INTACT on reading entries; the harness
    // emits telemetry from the SURVIVING post-debounce list and strips
    // `_confidence` before the wire. This also restores the module's
    // documented purity (no logger side effects).
    //
    // §A1a token stamping for circuit_designation — the fifth allowlisted
    // text-op field arrives via synthesiseConfirmations (record_reading),
    // not the state-change/obs synthesisers, so stamp it here where turnId
    // is in scope. Only when turnId exists: without it there is no stable
    // operation identity and the client falls back to the bare key (today's
    // behaviour). The readings Map keys field::circuit, so a same-turn
    // designation re-write overwrites — one surviving op per circuit per
    // turn, and `desig_<circuit(s)>_<turnId>` is unique per operation.
    if (_turnId) {
      for (const entry of confirmations) {
        if (entry.field !== 'circuit_designation') continue;
        const scope = Number.isInteger(entry.circuit)
          ? String(entry.circuit)
          : Array.isArray(entry.circuits)
            ? entry.circuits.join('-')
            : 'board';
        // Codex r5-#2 — board discriminator in the token. Without it, two
        // valid designation writes for the SAME circuit ref on DIFFERENT
        // boards minted identical tokens and the client debounce swallowed
        // the second read-back. Suffix only when a board is present so
        // every existing single-board token (and its pinned iOS/backend
        // hash vector) stays byte-identical.
        const boardPart = entry.board_id != null ? `_${entry.board_id}` : '';
        entry.dedupe_token = `desig_${scope}${boardPart}_${_turnId}`;
      }

      // PLAN-2C §3.5 (feedback id 102) — ordinary section/board-field
      // confirmations need replay-stable OPERATION identity too. Their
      // positional client key hashes field+text, so two legitimate postcode
      // amendments that speak the same text collide for the entire session.
      //
      // Stamp ONLY confirmations backed by dispatcher-owned operation
      // identity. Never infer scope from optional wire board_id or ordinal
      // from the post-LWW list: both lose the actual operation identity.
      // `postcode` is the sole producer in this wave and is globally scoped.
      for (const entry of confirmations) {
        const field = entry?.field;
        const isSectionShape =
          entry?.circuit == null &&
          (!Array.isArray(entry?.circuits) || entry.circuits.length === 0);
        if (
          !field ||
          !isSectionShape ||
          entry.dedupe_token ||
          !WIRE_CLIENT_DEDUPE_TOKEN_FIELDS.has(field)
        ) {
          continue;
        }
        const identity = entry?.[SECTION_DEDUPE_OPERATION];
        if (!identity || identity.field !== field) continue;
        entry.dedupe_token = `secfield_${identity.field}_${identity.scope}_${_confirmationDedupeTurnId}_ord${identity.ordinal}`;
      }
    }
    // PLAN-F item 1 (2026-08-12, feedback id 115) — audible-skip disclosure.
    // dispatchSetFieldForAllCircuits does NOT compose confirmations itself
    // (it never sees `confirmations` — only perTurnWrites/legacyResultShape/
    // options reach it, per the module JSDoc above), so it stages one
    // bulkOutcomes entry per (call, board) with applied/spare-skipped refs;
    // this amends the MATCHING grouped or per-circuit confirmation with a
    // count-aware "…skipping N spare ways" clause, or synthesises the
    // standalone zero-applied confirmation when nothing was written
    // (Decision 4). Joined by the composite (callId, effectiveBoardId)
    // identity — see the join below. Not gated by `_turnId` — the
    // disclosure is independent of the designation-token machinery above.
    //
    // Codex diff-review cycle 3 (2026-08-14) — BLOCKER fix: an outcome with
    // a non-empty `appliedRefs` must act ONLY if its composite identity
    // still owns at least one WINNING projected reading. Two same-turn
    // calls to the same field+board with OVERLAPPING (not identical, so
    // APPEND not REPLACE — finding 1) circuit targets can have the LATER
    // call's write overwrite the readings Map entry the EARLIER call
    // produced (last-write-wins on the shared (field, circuit, board) key),
    // re-tagging that reading with the later call's identity. The earlier
    // call's ledger entry then owns ZERO winning readings, yet without this
    // check it would still fall through to the "defensive fallback" branch
    // below and speak a STALE disclosure about circuits it no longer
    // actually wrote. `bulkIdentityOwnsWinningReading` distinguishes that
    // case (no reading anywhere carries this identity — skip entirely, no
    // fallback) from the fallback's actual intended case (a reading DOES
    // still carry this identity, but no confirmation was synthesised for
    // it for an unrelated reason — the fallback still fires).
    const bulkIdentityOwnsWinningReading = new Set();
    for (const r of extracted_readings) {
      const rCallId = bulkOutcomeCallIdByReading.get(r);
      if (!rCallId) continue;
      const rEffBoard = effectiveBoardByReading.get(r) ?? null;
      bulkIdentityOwnsWinningReading.add(`${rCallId}|${rEffBoard}`);
    }
    if (Array.isArray(perTurnWrites.bulkOutcomes) && perTurnWrites.bulkOutcomes.length > 0) {
      for (const outcome of perTurnWrites.bulkOutcomes) {
        if (!Array.isArray(outcome.spareSkippedRefs) || outcome.spareSkippedRefs.length === 0) {
          continue; // nothing to disclose
        }
        // Codex diff-review r1 (2026-08-13) — the plan's exact wording
        // DIFFERS by context: the clause appended to a success confirmation
        // is present-continuous ("…skipping N spare ways"); the standalone
        // zero-applied sentence is past-tense ("skipped N spare ways") —
        // "No non-spare circuits were updated; skipped N spare ways."
        // (PLAN-F-final.md Decision 4, verbatim). Two distinct forms, not
        // one reused across both contexts.
        const appendClause =
          outcome.spareSkippedRefs.length === 1
            ? 'skipping 1 spare way'
            : `skipping ${outcome.spareSkippedRefs.length} spare ways`;
        const standaloneClause =
          outcome.spareSkippedRefs.length === 1
            ? 'skipped 1 spare way'
            : `skipped ${outcome.spareSkippedRefs.length} spare ways`;
        if (!Array.isArray(outcome.appliedRefs) || outcome.appliedRefs.length === 0) {
          // Decision 4 — zero-applied: all targets were spares under an
          // exclude policy, so no reading/group exists to annotate.
          const zeroText = `No non-spare circuits were updated; ${standaloneClause}.`;
          const zeroEntry = {
            text: zeroText,
            expanded_text: expandForTTS(zeroText),
            field: outcome.field,
            circuit: null,
            // PLAN-F2 finding 5 (2026-08-14) — replay-stable dedupe token
            // WITH a board discriminator: a single '*' wildcard call can
            // stage one zero-applied entry per board (all sharing
            // turn+call), so the board component is load-bearing, not
            // decorative — without it, two boards' zero-applied disclosures
            // in the same call would mint IDENTICAL tokens and client
            // dedupe would swallow all but one. effectiveBoardId is never
            // null (finding 4), so this segment is always populated.
            dedupe_token: `bulkoutcome_${_turnId ?? 'noturn'}_${outcome.callId}_${outcome.effectiveBoardId}`,
          };
          if (outcome.boardId != null) zeroEntry.board_id = outcome.boardId;
          confirmations.push(zeroEntry);
          continue;
        }
        // PLAN-F2 finding 1 (2026-08-14) — join by the composite (callId,
        // effectiveBoardId) identity stamped during synthesis
        // (BULK_OUTCOME_MATCH_IDENTITY), NOT by (field, board, exact
        // circuit set). The field/circuit-set match this replaces could
        // misattribute a disclosure whenever two same-turn bulk calls to
        // the same field+board produced different groupings than the
        // ledger expected (the class of bug this finding fixes) — an
        // outcome now acts ONLY if its own call's identity owns a winning
        // projected reading (i.e. a confirmation was actually stamped with
        // it), so it can never latch onto a different call's confirmation
        // by coincidence of shape.
        // PLAN-F2 finding 4 — the board component compares
        // `outcome.effectiveBoardId` (resolved), NOT the raw `outcome.boardId`
        // used for wire emission above. Both sides of the join are now the
        // resolved effective board, so an ordinary single-board turn (wire
        // board_id omitted, but the session may have a real non-main board
        // selected) still matches correctly — comparing raw-vs-resolved
        // would fail on exactly that common case.
        const matchIdx = confirmations.findIndex((c) => {
          const identity = c[BULK_OUTCOME_MATCH_IDENTITY];
          return (
            identity != null &&
            identity.callId === outcome.callId &&
            identity.boardId === outcome.effectiveBoardId
          );
        });
        // Codex diff-review r1 (edge-interactions lens, WITHIN_INTENT per
        // Audio-First invariant #1 — exactly once, never twice) — a
        // confirmation that already carries `fast_correlation_id` is the
        // canonical twin of an ALREADY-SPOKEN fast-TTS clip (PLAN-B); its
        // text must stay byte-identical to what the fast path rendered, or
        // iOS's exactly-once suppression either drops the disclosure
        // entirely (text no longer matches → treated as a correction,
        // suppressed as a duplicate) or the base reading risks a second
        // playback. Never mutate that entry in place — the disclosure
        // still ships, as its own additive line, so it's never silently
        // lost either.
        if (matchIdx >= 0 && !confirmations[matchIdx].fast_correlation_id) {
          const match = confirmations[matchIdx];
          match.text = `${match.text}, ${appendClause}`;
          match.expanded_text = expandForTTS(match.text);
        } else if (
          bulkIdentityOwnsWinningReading.has(`${outcome.callId}|${outcome.effectiveBoardId}`)
        ) {
          // Defensive fallback — Audio-First invariant #1: a disclosure
          // must never be silently lost even if the matching confirmation
          // was itself suppressed upstream for an unrelated reason, OR
          // (the fast-correlation case above) deliberately left unmutated.
          // Codex diff-review cycle 3 — gated on ownership (see the Set's
          // doc comment above): this outcome's identity DOES still own a
          // winning reading, so its disclosure would otherwise go missing
          // with no confirmation to append to.
          const fallbackText = `${appendClause.charAt(0).toUpperCase()}${appendClause.slice(1)}.`;
          const fallbackEntry = {
            text: fallbackText,
            expanded_text: expandForTTS(fallbackText),
            field: outcome.field,
            circuit: null,
            // PLAN-F2 finding 5 (2026-08-14) — same replay-stable,
            // board-discriminated token as the zero-applied branch above
            // (see its comment for why the board segment is load-bearing).
            dedupe_token: `bulkoutcome_${_turnId ?? 'noturn'}_${outcome.callId}_${outcome.effectiveBoardId}`,
          };
          if (outcome.boardId != null) fallbackEntry.board_id = outcome.boardId;
          confirmations.push(fallbackEntry);
        }
        // else: this outcome's identity owns NO winning reading anywhere —
        // every circuit it wrote was subsequently overwritten by a LATER
        // call (last-write-wins on the shared readings Map key). Its
        // disclosure is now STALE (nothing it actually wrote survives to
        // annotate) and is correctly dropped, not spoken as a fallback.
      }
    }
    // Codex r3-#2 — when the per-turn designation-op LOG shows more ops than
    // the last-write-wins readings Map surfaced, expand the read-backs to
    // one per operation (plan-pinned: "two designation changes on one
    // circuit → both speak"). The wire extracted_readings still carry only
    // the FINAL value (state is last-write-wins by design); only the spoken
    // confirmations expand. Tokens gain an ordinal so each op is a distinct
    // replay-stable identity for the client dedupe.
    if (Array.isArray(perTurnWrites.designationOps) && perTurnWrites.designationOps.length > 0) {
      // A2-multiboard item 3 — group by the EFFECTIVE board, not the raw one.
      // `record_reading` omits `board_id` in the common case, so a
      // `select_board A → rename circuit 3 → select_board B → rename circuit 3`
      // turn produced TWO raw-null ops that merged into ONE scope bucket, and
      // the expansion then spoke both boards' names as if they were two edits
      // of a single circuit. The effective board separates them; single-board
      // traffic groups identically to before (one board ⇒ one bucket either
      // way).
      const opsByScope = new Map();
      const groupCountByCircuit = new Map();
      for (const op of perTurnWrites.designationOps) {
        const k = `${op.circuit}|${readEffectiveOpBoard(op) ?? ''}`;
        if (!opsByScope.has(k)) {
          opsByScope.set(k, []);
          groupCountByCircuit.set(op.circuit, (groupCountByCircuit.get(op.circuit) ?? 0) + 1);
        }
        opsByScope.get(k).push(op);
      }
      for (const [, ops] of opsByScope) {
        if (ops.length < 2) continue; // single op — the Map-derived entry is exact
        // Codex r5-#2 — the lookup must match BOARD as well as circuit:
        // without it, repeated writes on board B could replace board A's
        // confirmation for the same circuit ref (A omitted, B duplicated).
        //
        // A2-multiboard item 3 — the confirmation's `board_id` is the WIRE
        // value, which item 1 enriches onto ORDINARY readings only when the
        // turn touched more than one board. So match the effective board FIRST
        // (exact, and the only correct answer in the multi-board case), then
        // fall back to a circuit-only match ONLY when this circuit has a single
        // op-group — i.e. there is no other board it could be confused with.
        // That fallback is what keeps single-board traffic byte-identical.
        const opEffectiveBoard = readEffectiveOpBoard(ops[0]);
        let idx = confirmations.findIndex(
          (c) =>
            c.field === 'circuit_designation' &&
            c.circuit === ops[0].circuit &&
            (c.board_id ?? null) === opEffectiveBoard
        );
        if (idx < 0 && (groupCountByCircuit.get(ops[0].circuit) ?? 0) === 1) {
          idx = confirmations.findIndex(
            (c) => c.field === 'circuit_designation' && c.circuit === ops[0].circuit
          );
        }
        if (idx < 0) continue;
        // A2-multiboard item 3 (Codex cycle 2) — the replacements inherit the
        // board identity of the confirmation they REPLACE, not the raw
        // `op.boardId`.
        //
        // Raw is board-AMBIGUOUS: `rename_circuit`/`record_reading` omit
        // `board_id` in the common case, so on a
        // `select_board main → rename 3 → rename 3 → select_board sub → rename 3 → rename 3`
        // turn BOTH groups minted `desig_3_<turn>_ord0`/`_ord1` and emitted no
        // `board_id` at all. `applyConfirmationDebounce` then swallowed the
        // second board's pair as duplicates: the sub-board's designations were
        // written but never spoken — Audio-First #1, and the exact
        // spoken-vs-written split this item exists to close. It also left the
        // surviving read-backs unroutable, since the client can only address a
        // board it is told about.
        //
        // The wire `board_id` is the right source rather than
        // `opEffectiveBoard` because these entries SUBSTITUTE for
        // `confirmations[idx]` — they must carry the identity the client would
        // otherwise have received — and because it is the same convention the
        // §A1a primary token stamping above already uses. Byte-invariance
        // follows for free: a single-board turn is not cross-board-enriched, so
        // the value is absent, `boardPart` is '' and every existing token (and
        // its pinned iOS/web hash vector) is unchanged. It only ever differs in
        // the colliding cross-board case, where the primary lookup above
        // already proved the confirmation carries its effective board.
        const wireBoardId = confirmations[idx].board_id ?? null;
        const boardPart = wireBoardId != null ? `_${wireBoardId}` : '';
        const replacement = ops.map((op, i) => {
          const text = buildConfirmationText('circuit_designation', op.value, op.circuit, op.value);
          const entry = {
            text,
            expanded_text: expandForTTS(text),
            field: 'circuit_designation',
            circuit: op.circuit,
            dedupe_token: `desig_${op.circuit}${boardPart}_${_turnId ?? 'noturn'}_ord${i}`,
            _confidence: typeof op.confidence === 'number' ? op.confidence : null,
          };
          if (wireBoardId != null) entry.board_id = wireBoardId;
          return entry;
        });
        confirmations.splice(idx, 1, ...replacement);
      }
    }
    // 2026-05-29 — state-change confirmations (create_circuit, rename,
    // delete, add_board, select_board, mark_distribution_circuit) so the
    // AirPods-only inspector hears EVERY state change, not just record_
    // reading writes. Dedup against the per-turn circuit_designation
    // writes so we don't double-announce "Circuit 1 is now the Cooker"
    // when Sonnet pairs create_circuit + record_reading.
    //
    // A2-multiboard item 3 — the dedupe identity is `(effective_board, ref)`,
    // not the bare ref. On a multi-board turn a designation read-back for
    // board A's circuit 3 used to suppress board B's `create circuit 3`
    // confirmation as well, so a real state change on B went unspoken
    // (Audio-First #1). A board-scoped reading contributes ONLY its pair key;
    // an unscoped reading contributes the bare ref, which is what every
    // single-board turn produces — so single-board behaviour is unchanged.
    const skipDesignations = new Set();
    for (const r of extracted_readings) {
      if (r.field === 'circuit_designation' && Number.isInteger(r.circuit)) {
        if (r.board_id != null && r.board_id !== '') {
          skipDesignations.add(circuitDesignationKey(r.board_id, r.circuit));
        } else {
          skipDesignations.add(r.circuit);
        }
      }
    }
    const stateChanges = synthesiseStateChangeConfirmations(
      perTurnWrites.circuitOps,
      perTurnWrites.boardOps,
      skipDesignations,
      options.boardDesignations,
      _turnId
    );
    // 2026-06-01 Issue 8 — observations, observation deletions and
    // explicit clear_reading corrections were silent. Inspector
    // running AirPods-only would never know whether the system had
    // logged their dictated defect.
    // #31 — collect the slots WRITTEN this turn so a same-turn clear+write
    // (value replacement) suppresses the redundant "<field> cleared" read-back.
    // Circuit readings key by field+circuit ref; board/installation readings
    // (client_name, supply fields, …) live in a separate slot with no circuit,
    // so they key field-only at board scope.
    // A2-multiboard (2026-07-28) — the circuit twin of the A1a board fix
    // immediately below: membership is a Set of EFFECTIVE CIRCUIT SLOTS,
    // sourced from the write JOURNAL's stamps, not the bare `field|circuit`
    // string. `extracted_readings` is deliberately NOT the source — its
    // entries are freshly constructed downstream and therefore CANNOT carry
    // the non-enumerable EFFECTIVE_CIRCUIT_SLOT stamp, the exact trap the
    // board half documents. `projectReadingWinners` is the one authoritative
    // answer to "which effective slots did this turn write?", and it is the
    // same source the clear→write collapse already matches on — one source
    // for both, or they drift.
    //
    // Unsequenced/Symbol-less legacy writes resolve, via readingSlotKeyOf's
    // own fallback, to the raw decoded key — whose board is null for every
    // omitted-`board_id` write, i.e. the same stable null-board sentinel the
    // clear side falls back to. Single-board turns therefore behave exactly
    // as before (both sides resolve to the one board, or both to null).
    const writtenCircuitSlots = new Set();
    for (const w of projectReadingWinners(perTurnWrites)) {
      writtenCircuitSlots.add(w.slot);
    }
    // Plan A1a (2026-07-27) — the #31 board membership is now a Set of
    // EFFECTIVE BOARD SLOTS, not bare field names, sourced from
    // perTurnWrites.boardReadings stamps — the SAME source mechanism B's
    // collapse uses (one source for both, or they drift). The old producer
    // iterated result.extracted_board_readings, whose entries are freshly
    // constructed (they cannot carry the non-enumerable stamp) and whose
    // board_id is undefined on the live no-param write path — a bare-field
    // Set silently suppressed a legitimate CROSS-BOARD clear's speech
    // (write manufacturer on A, select_board B, clear on B: both operations
    // survive the collapse but the bare string 'manufacturer' from A's
    // write ate B's clear read-back — an Audio-First #1 violation).
    // Symbol-less (unclassified legacy) writes keep today's bare-field
    // suppression via the stable null-board sentinel key
    // boardSlotKey(canonical, null).
    const writtenBoardFields = new Set();
    const writtenBoardMap =
      perTurnWrites.boardReadings instanceof Map ? perTurnWrites.boardReadings : new Map();
    for (const [bKey, bVal] of writtenBoardMap) {
      const bsym = bVal?.[EFFECTIVE_BOARD_SLOT];
      if (bsym) {
        writtenBoardFields.add(boardSlotKey(bsym.field, bsym.boardId));
      } else {
        const d = decodeBoardReadingKey(bKey);
        const canonical = FIELD_CORRECTIONS[d.field] ?? d.field;
        writtenBoardFields.add(boardSlotKey(canonical, null));
      }
    }
    const writtenSlots = {
      circuitSlots: writtenCircuitSlots,
      boardFields: writtenBoardFields,
    };
    // P5 — pass the collapsed corrections (clear→write collapsed clears already
    // removed) so a wiped slot never synthesises a "<field> cleared" line. The
    // #31 writtenSlots suppression runs on top, re-sourced by plan A1a to
    // EFFECTIVE-BOARD-SLOT identity: boardFields is a Set of boardSlotKey
    // (canonical field + resolved board id from the write's stamp; a
    // Symbol-less legacy entry falls back to the null-board sentinel). A
    // same-turn write only suppresses the clear line for the SAME effective
    // slot — a write on one board no longer suppresses a spoken clear on a
    // DIFFERENT board (the pre-A1a board-UNAWARE cross-board over-suppression
    // is closed; tests 6 and 6c pin both cross-board directions, 11-L1/L2
    // pin the symbol-less legacy fallback).
    const obsAndClears = synthesiseObservationAndClearedConfirmations(
      perTurnWrites.observations,
      perTurnWrites.deletedObservations,
      keptFieldCorrections,
      options.circuitDesignations,
      writtenSlots,
      _turnId
    );
    const merged = confirmations.concat(stateChanges).concat(obsAndClears);
    if (merged.length > 0) {
      result.confirmations = merged;
    }
  }

  return result;
}

// PLAN-backend-final.md Phase 7.3 — backend confirmation debounce.
//
// Cross-turn same-field-family suppression. Inside a single turn the
// existing synthesiseConfirmations grouping (line ~333) already folds
// duplicate (field, value, board) tuples into one TTS line. The
// separate concern this helper addresses is BURST turns: Sonnet's
// extraction queue produces three sequential record_reading calls
// across three turns inside ~800 ms (e.g. RCD trip-time fan-out where
// each turn writes one circuit) and the inspector hears the same
// confirmation three times. iOS slice 7.1 owns the queue serialiser
// that prevents overlapping TTS playback; this helper drops the
// duplicate confirmation BEFORE it enters that queue so the inspector
// just hears the first one.
//
// Coalescing strategy: within the debounce window, suppress new
// confirmations whose field matches the most-recently emitted one.
// The first confirmation in a burst rides through (and updates the
// state); subsequent ones in the same field family are dropped.
// State is per-session and lives on the activeSessions entry; the
// caller threads it in. windowMs defaults to 1500 per the plan.
export const CONFIRMATION_DEBOUNCE_WINDOW_MS = 1500;

// Audio-first (2026-06-18, readback-correction-optionb): the debounce key
// must include circuit(s) + board_id + value, NOT field alone. A field-only
// key suppressed the SECOND of two distinct same-field readings on different
// circuits dictated close together (e.g. "Circuit 3 Zs 0.86" then "Circuit 4
// Zs 0.91" within 1.5 s) — violating "read back EVERY applied reading
// exactly once". With the composite key the debounce only coalesces a
// genuine duplicate of the SAME reading (same field+circuit+board+value);
// distinct readings always ride through and are each read back. iOS slice
// 7.1's TTS queue serialiser handles playing them back-to-back. The `value`
// proxy prefers an explicit `value` (test fixtures) and falls back to the
// rendered `text` (live confirmation entries, which encode circuit+value).
// PLAN-F2 finding 5 (2026-08-14) — `bulkoutcome_` is a STRUCTURAL token
// prefix, not a field-allowlist entry: dispatchSetFieldForAllCircuits can
// target ANY circuit reading field (not just the five DEDUPE_TOKEN_FIELDS
// text-op fields), so gating the server-side debounce's token-awareness on
// DEDUPE_TOKEN_FIELDS.has(field) would mean two identical same-field bulk
// commands inside the 1.5 s debounce window get dropped HERE, server-side,
// before either client's own dedupe token branch ever runs. Mirrors the
// client-side `duplicate_` structural-prefix pattern (ios-dedupe-key.js).
function hasBulkOutcomeTokenPrefix(token) {
  return typeof token === 'string' && token.startsWith('bulkoutcome_');
}

export function confirmationDebounceKey(c) {
  if (!c) return '';
  const field = c.field ?? '';
  // PLAN-F2 finding 5 — checked BEFORE the field-allowlist branch, exactly
  // like the client-side duplicate_ prefix takes precedence over the
  // WIRE_CLIENT_DEDUPE_TOKEN_FIELDS allowlist check in ios-dedupe-key.js.
  if (hasBulkOutcomeTokenPrefix(c.dedupe_token)) {
    return `${field} tok:${c.dedupe_token}`;
  }
  // §A1a (field-feedback-2026-07-14) — token-aware key for the five
  // allowlisted text-op fields. Deletions have null value so the composite
  // key falls to text, and every deletion's text is the constant
  // "Observation deleted" — two DISTINCT same-turn deletions would be
  // collapsed server-side before any client saw them. With the token:
  // distinct operations survive the debounce; a replay carrying the SAME
  // token is still suppressed. Measured-value fields never carry a token
  // and keep the composite shape below.
  if (c.dedupe_token && DEDUPE_TOKEN_FIELDS.has(field)) {
    return `${field} tok:${c.dedupe_token}`;
  }
  const circuit = Number.isInteger(c.circuit) ? String(c.circuit) : '';
  const circuits = Array.isArray(c.circuits) ? c.circuits.join(',') : '';
  const board = c.board_id ?? '';
  const value = c.value != null ? String(c.value) : (c.text ?? '');
  return `${field}\u0000${circuit}\u0000${circuits}\u0000${board}\u0000${value}`;
}

export function applyConfirmationDebounce(newConfirmations, debounceState, options = {}) {
  if (!Array.isArray(newConfirmations) || newConfirmations.length === 0) {
    return Array.isArray(newConfirmations) ? newConfirmations : [];
  }
  if (!debounceState) return newConfirmations;
  const { now = Date.now(), windowMs = CONFIRMATION_DEBOUNCE_WINDOW_MS } = options;

  const out = [];
  let suppressedCount = 0;
  for (const c of newConfirmations) {
    const field = c?.field ?? null;
    const key = confirmationDebounceKey(c);
    // Codex r4-#6 — token-keyed confirmations get a windowed MAP of
    // recently emitted keys, not the single lastKey slot: with lastKey
    // alone, a replay of token A after a distinct token B inside the
    // window survived (A, B, A emitted all three), defeating §A1a's
    // replay suppression. Token entries do NOT touch lastKey/lastEmittedAt,
    // so measured-value debounce keeps its existing single-slot contract
    // (and a token confirmation no longer evicts a measured reading's key).
    const isTokenKey =
      c?.dedupe_token != null &&
      key !== '' &&
      // PLAN-F2 finding 5 — bulkoutcome_ is structural (see
      // hasBulkOutcomeTokenPrefix above), so it qualifies regardless of
      // whether the field is on the DEDUPE_TOKEN_FIELDS allowlist.
      (DEDUPE_TOKEN_FIELDS.has(c?.field ?? '') || hasBulkOutcomeTokenPrefix(c.dedupe_token));
    if (isTokenKey) {
      if (!(debounceState.tokenKeysMs instanceof Map)) debounceState.tokenKeysMs = new Map();
      for (const [k, ts] of debounceState.tokenKeysMs) {
        if (now - ts >= windowMs) debounceState.tokenKeysMs.delete(k);
      }
      const seenAt = debounceState.tokenKeysMs.get(key);
      if (seenAt != null && now - seenAt < windowMs) {
        suppressedCount += 1;
        continue;
      }
      debounceState.tokenKeysMs.set(key, now);
      out.push(c);
      continue;
    }
    const elapsed = now - (debounceState.lastEmittedAt || 0);
    // Coalesce only a genuine duplicate of the SAME reading within the
    // window (same field+circuit+board+value). Distinct readings — even
    // same-field different-circuit — always pass.
    const sameReading = key !== '' && debounceState.lastKey === key;
    if (sameReading && elapsed < windowMs) {
      suppressedCount += 1;
      continue;
    }
    out.push(c);
    debounceState.lastEmittedAt = now;
    debounceState.lastKey = key;
    // lastField preserved for back-compat telemetry/state shape.
    debounceState.lastField = field;
  }
  if (suppressedCount > 0) {
    debounceState.lastSuppressedCount = (debounceState.lastSuppressedCount || 0) + suppressedCount;
  }
  return out;
}
