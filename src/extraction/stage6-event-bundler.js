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

import { decodeReadingKey, decodeBoardReadingKey } from './stage6-per-turn-writes.js';
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
// so it runs on the SURVIVING post-debounce confirmation list. Only the
// allowlist is needed here, for the token-aware debounce key.
import { DEDUPE_TOKEN_FIELDS } from './ios-dedupe-key.js';
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
  if (Array.isArray(circuitOps)) {
    for (let opIdx = 0; opIdx < circuitOps.length; opIdx += 1) {
      const op = circuitOps[opIdx];
      const ref = op.circuit_ref;
      if (!Number.isInteger(ref) || ref <= 0) continue;
      let text = null;
      if (op.op === 'create') {
        if (skipCircuitDesignations.has(ref)) continue; // covered by reading TTS
        const desig = op?.meta?.designation;
        if (typeof desig === 'string' && desig.trim()) {
          text = `Circuit ${ref} is now the ${desig.trim()}`;
        } else {
          text = `Circuit ${ref} created`;
        }
      } else if (op.op === 'rename') {
        if (skipCircuitDesignations.has(ref)) continue;
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
        if (typeof desig === 'string' && desig.trim()) {
          text = `Switched to the ${desig.trim()} board`;
        } else {
          text = `Switched board`;
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
 * @param {Map<number,string>|null} designations circuit ref →
 *   designation, used to prefix cleared circuit-level readings with
 *   the spoken circuit name when known.
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
  const lookupDesignation = (circuit) => {
    if (!designations) return null;
    if (designations instanceof Map) {
      return designations.get(circuit) ?? designations.get(String(circuit)) ?? null;
    }
    if (typeof designations === 'object') {
      return designations[circuit] ?? designations[String(circuit)] ?? null;
    }
    return null;
  };

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
          if (
            writtenSlots.circuitSlots instanceof Set &&
            writtenSlots.circuitSlots.has(`${field}|${String(circ)}`)
          ) {
            continue;
          }
        } else if (writtenSlots.boardFields instanceof Set && writtenSlots.boardFields.has(field)) {
          // Board/installation-level clear (circuit 0/null) with a same-field
          // board write this turn — a replacement; let the write speak.
          continue;
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
        const desig = lookupDesignation(circ);
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
  calcReadings = null
) {
  const out = [];
  // F/U-1 (2026-07-19) — identity Set of projected reading objects that came
  // from a calculator write (::calc:: source). These speak with "calculated
  // as" phrasing so the inspector can ear-distinguish a derived value from a
  // meter reading. Null/absent (legacy callers, board readings) → nothing is
  // treated as calculated.
  const isCalc = (r) => calcReadings instanceof Set && calcReadings.has(r);
  const lookupDesignation = (circuit) => {
    if (!designations) return null;
    if (designations instanceof Map) {
      return designations.get(circuit) ?? designations.get(String(circuit)) ?? null;
    }
    if (typeof designations === 'object') {
      return designations[circuit] ?? designations[String(circuit)] ?? null;
    }
    return null;
  };

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
    const groupKey = buildFanoutGroupKey({
      field: r.field,
      value: r.value,
      boardId: r.board_id,
      calculated: isCalc(r),
    });
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = {
        field: r.field,
        value: r.value,
        board_id: r.board_id,
        calculated: isCalc(r),
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
      totalCircuitsInJob,
      { calculated: bucket.calculated }
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
    const designation = lookupDesignation(r.circuit);
    const text = buildConfirmationText(r.field, r.value, r.circuit, designation, {
      calculated: isCalc(r),
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
    // W1.4 transient confidence sidecar (per-circuit fallback path).
    entry._confidence = typeof r.confidence === 'number' ? r.confidence : null;
    out.push(entry);
  }
  for (const r of boardReadings) {
    // Audio-first: no confidence gate on the final read-back (see above).
    const text = buildConfirmationText(r.field, r.value, null);
    if (!text) continue;
    const entry = {
      text,
      expanded_text: expandForTTS(text),
      field: r.field,
      circuit: null,
    };
    if (r.board_id != null) {
      entry.board_id = r.board_id;
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
 *            extracted_board_readings?: Array<{field: string, value: any, confidence: number, source: 'tool_call', board_id?: string}>,
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
  const isDerivedWrite = (entry) => entry?.derived === true;
  const isCalcWrite = (entry) =>
    typeof entry?.source_turn_id === 'string' && entry.source_turn_id.startsWith('::calc::');
  for (const [key, entry] of perTurnWrites.readings) {
    // Slice 1.1c — decodeReadingKey handles BOTH the new boardId-tagged
    // shape `${field}::${circuit}<NUL>__board__<NUL>${boardId}<NUL>` and
    // legacy 2-part `${field}::${circuit}` keys (test fixtures or older
    // accumulators) so this loop is shape-agnostic. boardId from the key
    // is NOT used for emission — the value entry's boardId (set by the
    // dispatcher in slice 1.1a) is the wire-shape SoT; the key boardId
    // is purely a same-turn collision-key.
    const { field, circuit: circuitStr } = decodeReadingKey(key);
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
    extracted_readings.push(reading);
  }

  // 2-3. Observations + questions — defensive copies so downstream mutation
  //      cannot retroactively alter the bundled result.
  const result = {
    extracted_readings,
    observations: [...perTurnWrites.observations],
    questions: Array.isArray(legacy.questions) ? [...legacy.questions] : [],
  };
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
    Object.defineProperty(result, 'answer_source', {
      value: _answerState.stagedMeta?.fallback === true ? 'answer_fallback' : 'answer_user',
      enumerable: false,
    });
  }

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
  // 1a.6 — field_corrected event payloads. Carried on result so the
  // orchestrator (sonnet-stream.js) can iterate after sending the
  // extraction envelope and emit each as a separate WS message with the
  // pinned wire shape from PLAN_v3 §4.5 (type/circuit/field/
  // previous_value/reason). OMITTED when empty so back-compat decoders
  // never see the key.
  if (Array.isArray(perTurnWrites.fieldCorrections) && perTurnWrites.fieldCorrections.length > 0) {
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
    //    runs AFTER this line in the same function and compares
    //    perTurnWrites.fieldCorrections against writtenSlots on the RAW key
    //    to suppress the redundant "<field> cleared" TTS when the same turn
    //    also writes a replacement. An in-place `.field` rewrite through the
    //    old shallow copy would corrupt that compare and double-speak.
    // 2. CLEAR_WIRE_EXEMPT (r2_ohm): see the constant's comment — the
    //    canonical `r2` lands on the WRONG deployed clearer cell.
    result.field_corrections = perTurnWrites.fieldCorrections.map((c) => ({
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
  if (boardReadings.size > 0) {
    const extracted_board_readings = [];
    for (const [key, entry] of boardReadings) {
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
      // "Work on Board" hotfix slice 1.1a — emit board_id so shadow-harness's
      // fold to extracted_readings (with circuit:0) carries the field through
      // to iOS, where applySonnetReadings can land board-level supply on the
      // right BoardInfo via the boardIndex(for:) helper rather than
      // pinning to boards[0].
      if (entry.boardId != null) {
        reading.board_id = entry.boardId;
      }
      if (isDerivedWrite(entry)) {
        suppressConfirmationReadings.add(reading);
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
    // session.stateSnapshot.circuits, board-scoped if a sub-board is
    // the current target so a fan-out on board B doesn't count board
    // A's circuits toward the total). Null means "I don't know" → the
    // helper falls through to range/list phrasing.
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
      calcConfirmationReadings
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
    }
    // Codex r3-#2 — when the per-turn designation-op LOG shows more ops than
    // the last-write-wins readings Map surfaced, expand the read-backs to
    // one per operation (plan-pinned: "two designation changes on one
    // circuit → both speak"). The wire extracted_readings still carry only
    // the FINAL value (state is last-write-wins by design); only the spoken
    // confirmations expand. Tokens gain an ordinal so each op is a distinct
    // replay-stable identity for the client dedupe.
    if (Array.isArray(perTurnWrites.designationOps) && perTurnWrites.designationOps.length > 0) {
      const opsByScope = new Map();
      for (const op of perTurnWrites.designationOps) {
        const k = `${op.circuit}|${op.boardId ?? ''}`;
        if (!opsByScope.has(k)) opsByScope.set(k, []);
        opsByScope.get(k).push(op);
      }
      for (const [k, ops] of opsByScope) {
        if (ops.length < 2) continue; // single op — the Map-derived entry is exact
        // Codex r5-#2 — the lookup must match BOARD as well as circuit:
        // without it, repeated writes on board B could replace board A's
        // confirmation for the same circuit ref (A omitted, B duplicated).
        const idx = confirmations.findIndex(
          (c) =>
            c.field === 'circuit_designation' &&
            c.circuit === ops[0].circuit &&
            (c.board_id ?? null) === (ops[0].boardId ?? null)
        );
        if (idx < 0) continue;
        const replacement = ops.map((op, i) => {
          const text = buildConfirmationText('circuit_designation', op.value, op.circuit, op.value);
          const boardPart = op.boardId != null ? `_${op.boardId}` : '';
          const entry = {
            text,
            expanded_text: expandForTTS(text),
            field: 'circuit_designation',
            circuit: op.circuit,
            dedupe_token: `desig_${op.circuit}${boardPart}_${_turnId ?? 'noturn'}_ord${i}`,
            _confidence: typeof op.confidence === 'number' ? op.confidence : null,
          };
          if (op.boardId != null) entry.board_id = op.boardId;
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
    const skipDesignations = new Set();
    for (const r of extracted_readings) {
      if (r.field === 'circuit_designation' && Number.isInteger(r.circuit)) {
        skipDesignations.add(r.circuit);
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
    const writtenCircuitSlots = new Set();
    for (const r of extracted_readings) {
      if (typeof r.field === 'string' && r.circuit != null) {
        writtenCircuitSlots.add(`${r.field}|${String(r.circuit)}`);
      }
    }
    const writtenBoardFields = new Set();
    if (Array.isArray(result.extracted_board_readings)) {
      for (const r of result.extracted_board_readings) {
        if (typeof r.field === 'string') writtenBoardFields.add(r.field);
      }
    }
    const writtenSlots = {
      circuitSlots: writtenCircuitSlots,
      boardFields: writtenBoardFields,
    };
    const obsAndClears = synthesiseObservationAndClearedConfirmations(
      perTurnWrites.observations,
      perTurnWrites.deletedObservations,
      perTurnWrites.fieldCorrections,
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
export function confirmationDebounceKey(c) {
  if (!c) return '';
  const field = c.field ?? '';
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
  return `${field} ${circuit} ${circuits} ${board} ${value}`;
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
      c?.dedupe_token != null && DEDUPE_TOKEN_FIELDS.has(c?.field ?? '') && key !== '';
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
