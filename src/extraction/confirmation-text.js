/**
 * Stage 6 confirmation-text leaf module.
 *
 * Loaded Barrel Phase 1.B (plan v10 §C). Hosts the friendly-name
 * table + `buildConfirmationText` helper that the bundler and the
 * speculator BOTH call to produce the same brief read-back sentence
 * from a single (field, circuit, value) tuple.
 *
 * Before Phase 1.B these constants and the helper lived inside
 * `stage6-event-bundler.js`. They've been moved here UNCHANGED so a
 * non-bundler consumer (loaded-barrel-speculator.js) can import the
 * helper without dragging the rest of the bundler's wire-shape code
 * into the speculator's call site. The bundler now imports from this
 * leaf; no behavioural change for any existing consumer.
 *
 * Source-of-truth contract: the speculator MUST call the same
 * `buildConfirmationText` the bundler will call at turn-end so the
 * pre-synthesised audio matches the text iOS asks for. The bundler's
 * `synthesiseConfirmations` (still in the bundler) iterates the
 * post-loop accumulator; the speculator iterates the per-write diff
 * mid-loop. Both call THIS file's `buildConfirmationText` so the
 * underlying text is byte-identical when iOS POSTs.
 */

// 2026-05-29 policy flip — deny-list, not allow-list.
//
// Inspector workflow: AirPods, iPad-by-the-CU, walking the house and
// dictating every reading. Wants TTS confirmation on EVERYTHING that
// lands in the UI — addresses, names, dates, every field, no
// silent-write surprises.
//
// New policy: speak unless field is on SUPPRESSED_TTS_FIELDS (internal
// IDs and metadata) OR field ends in `_id` (foreign-key style fields
// that have no spoken form). For known fields, the friendly-name table
// below provides the preferred phrasing; for everything else, fall
// back to snake_case → spaces with acronym fix-up.
//
// Previous allow-list approach silently dropped any field not in the
// table — including all PII / address fields the inspector expressly
// asked to hear in the AirPods workflow.
export const SUPPRESSED_TTS_FIELDS = Object.freeze(
  new Set([
    // The circuit number itself is the anchor for every other TTS line;
    // "circuit_ref 4" would be redundant with "Circuit 4 created".
    'circuit_ref',
    // UI sort/visibility metadata — not user-facing values.
    'sort_order',
    'suppress_from_report',
    // File paths / linkage metadata.
    'signature_file',
    'schedule_item',
    'defaults_by_circuit',
    // Observation metadata wrapped in its own dedicated TTS path
    // (the observation text + code are spoken via record_observation,
    // not via the confirmation table).
    '_outcome_meanings',
    'code',
  ])
);

// Map of canonical field names to PREFERRED short spoken labels. Used
// before the snake_case fallback in buildConfirmationText. Anything
// missing from this table is still spoken (deny-list policy) — the
// table just provides nicer phrasing for the common high-frequency
// fields where the inspector benefits from a brief acoustic label.
export const CONFIRMATION_FRIENDLY_NAMES = Object.freeze({
  // ─── Measurements ────────────────────────────────────────────────
  measured_zs_ohm: 'Zs',
  r1_r2_ohm: 'R1 plus R2',
  r2_ohm: 'R2',
  ring_r1_ohm: 'ring r1',
  ring_rn_ohm: 'ring rn',
  ring_r2_ohm: 'ring r2',
  ir_live_earth_mohm: 'IR L to E',
  ir_live_live_mohm: 'IR L to L',
  ir_test_voltage_v: 'IR test voltage',
  // ─── OCPD / RCD / AFDD ───────────────────────────────────────────
  ocpd_rating_a: 'OCPD rating',
  ocpd_type: 'OCPD type',
  ocpd_bs_en: 'OCPD BS EN',
  ocpd_breaking_capacity_ka: 'OCPD breaking capacity',
  ocpd_max_zs_ohm: 'OCPD max Zs',
  rcd_operating_current_ma: 'RCD',
  rcd_time_ms: 'RCD time',
  rcd_type: 'RCD type',
  rcd_bs_en: 'RCD BS EN',
  rcd_button_confirmed: 'RCD button',
  afdd_button_confirmed: 'AFDD button',
  // ─── Circuit characteristics ─────────────────────────────────────
  circuit_designation: '__DESIGNATION__', // special-cased in builder
  number_of_points: 'points',
  wiring_type: 'wiring type',
  ref_method: 'reference method',
  max_disconnect_time_s: 'disconnection time',
  live_csa_mm2: 'live CSA',
  cpc_csa_mm2: 'CPC CSA',
  polarity_confirmed: 'polarity',
  is_distribution_circuit: 'distribution circuit',
  // ─── Board-level (circuit=0 on the wire) ─────────────────────────
  // The friendly name carries enough context on its own; no "Circuit 0"
  // prefix is rendered.
  earth_loop_impedance_ze: 'Ze',
  prospective_fault_current: 'PFC',
  prospective_short_circuit_current: 'PSCC',
  prospective_earth_fault_current: 'PEFC',
  // Board metadata (read back so the inspector can walk away during
  // board details dictation).
  name: 'board name',
  location: 'board location',
  manufacturer: 'board manufacturer',
  phases: 'phases',
  earthing_arrangement: 'earthing arrangement',
  board_type: 'board type',
  sub_main_cable_material: 'sub-main cable material',
  sub_main_cable_csa: 'sub-main cable size',
  sub_main_cpc_csa: 'sub-main CPC size',
});

// Confidence threshold mirrors the legacy prompt's confirmation gate
// ("confidence >= 0.8") at config/prompts/sonnet_extraction_system.md
// so the agentic path doesn't read back values Sonnet itself would
// have withheld under the prose-JSON contract.
export const CONFIRMATION_MIN_CONFIDENCE = 0.8;

/**
 * Build the confirmation text from a single (field, value, circuit)
 * tuple. Returns null when the field isn't in the friendly-name table,
 * the value is empty, or the polarity_confirmed special-case rejects
 * a "false" value.
 *
 * Identical to the function that previously lived at
 * `stage6-event-bundler.js:66`. No semantic change.
 *
 * @param {string} field — canonical field name (snake_case).
 * @param {any} value — string-coerced; whitespace trimmed.
 * @param {number|null|undefined} circuit — circuit ref. null/0 →
 *   board-level (skips the "Circuit N, " prefix).
 * @returns {string|null}
 */
// Acronym fix-up so snake_case→spaces produces sensible TTS for
// inspection vocabulary the friendly-name table doesn't cover.
const ACRONYM_FIXES = [
  [/\bocpd\b/gi, 'OCPD'],
  [/\brcd\b/gi, 'RCD'],
  [/\bafdd\b/gi, 'AFDD'],
  [/\bspd\b/gi, 'SPD'],
  [/\bcpc\b/gi, 'CPC'],
  [/\bcsa\b/gi, 'CSA'],
  [/\bbs en\b/gi, 'BS EN'],
  [/\bbs\b/gi, 'BS'],
  [/\bze\b/gi, 'Ze'],
  [/\bzs\b/gi, 'Zs'],
  [/\bir\b/gi, 'IR'],
  [/\bipf\b/gi, 'IPF'],
  [/\bpfc\b/gi, 'PFC'],
  [/\bpscc\b/gi, 'PSCC'],
  [/\bpefc\b/gi, 'PEFC'],
  [/\bmohm\b/gi, 'megohms'],
  [/\bohm\b/gi, 'ohms'],
  [/\bma\b/gi, 'milliamps'],
  [/\bka\b/gi, 'kiloamps'],
  [/\bms\b/gi, 'milliseconds'],
  [/\bmm2\b/gi, 'square millimetres'],
  [/\buo\b/gi, 'U-zero'],
  [/\bdb\b/gi, 'DB'],
];

function deriveFriendlyName(field) {
  let s = field.replace(/_/g, ' ');
  for (const [re, repl] of ACRONYM_FIXES) {
    s = s.replace(re, repl);
  }
  return s;
}

export function buildConfirmationText(field, value, circuit, designation = null) {
  // 2026-05-29 — deny-list policy. Speak every field with a value
  // unless explicitly suppressed (internal IDs / metadata).
  if (SUPPRESSED_TTS_FIELDS.has(field)) return null;
  if (typeof field === 'string' && field.endsWith('_id')) return null;
  const friendly = CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
  const valueStr = String(value ?? '').trim();
  if (!valueStr) return null;

  // Designation prefix: when a circuit-level reading lands and we know
  // the circuit's name ("Cooker", "Upstairs lights"), use the name as
  // the spoken anchor. Falls back to "Circuit N" when no designation is
  // known (new circuit, or designation not yet entered). Designation is
  // trimmed + length-capped so a verbose "Upstairs sockets, lights, and
  // smoke alarms" doesn't dominate every TTS line.
  const desigStr =
    typeof designation === 'string' && designation.trim() ? designation.trim().slice(0, 40) : null;
  const circuitPrefix =
    circuit == null || circuit === 0
      ? null
      : desigStr
        ? `${desigStr}, circuit ${circuit}`
        : `Circuit ${circuit}`;

  // circuit_designation field is special — the value IS the new
  // designation, so phrase the confirmation as "Circuit N is now the
  // Cooker" rather than the generic "{prefix}, designation Cooker".
  if (field === 'circuit_designation') {
    if (circuit == null || circuit === 0) return null;
    return `Circuit ${circuit} is now the ${valueStr}`;
  }
  // polarity_confirmed canonical enum (config/field_schema.json) is
  // {"", "OK", "Y", "N"}. Sonnet sometimes emits the boolean-ish
  // string "true"/"false" or English aliases — the dispatcher's
  // coerceRecordReadingValue (record-reading-coercion.js, 2026-05-24)
  // maps the synonyms onto Y/N/OK BEFORE this builder runs in the
  // tool-call path. The list below accepts both the canonical
  // values AND the pre-coercion alternatives so:
  //   - the legacy off-mode path (no coercion) still confirms "true";
  //   - the tool-call path (post-coercion) confirms "Y"/"OK"; and
  //   - cached fixtures with either spelling continue to confirm.
  // Speak "polarity confirmed" for any truthy form, suppress for
  // falsy/empty/unknown — a false polarity is an inspection failure
  // that the inspector will edit by hand and shouldn't be acoustically
  // reinforced as if accepted. Keep the "Circuit N" prefix when present
  // so the inspector can tell two back-to-back polarity confirmations
  // apart.
  if (field === 'polarity_confirmed') {
    const lc = valueStr.toLowerCase();
    const isTrue = lc === 'true' || lc === 'y' || lc === 'ok' || lc === 'yes';
    if (!isTrue) return null;
    if (circuit == null || circuit === 0) return 'polarity confirmed';
    return `${circuitPrefix}, polarity confirmed`;
  }
  // Board-level readings (circuit 0 or absent) skip the prefix — "Ze
  // 0.25" is a complete sentence in inspector parlance, "Circuit 0, Ze"
  // would be confusing.
  if (circuit == null || circuit === 0) {
    return `${friendly} ${valueStr}`;
  }
  return `${circuitPrefix}, ${friendly} ${valueStr}`;
}

/**
 * Loaded Barrel Phase 1.B helper. Convenience predicate for the
 * speculator's per-write decision: should this slot trigger a
 * pre-synthesis?
 *
 * Returns false when:
 *   - field is not in the friendly-name table (no confirmation
 *     would be produced anyway)
 *   - confidence is a number below threshold
 *   - value would render to an empty confirmation (caller would
 *     have to call buildConfirmationText to discover this; we let
 *     them do that one step later)
 *
 * Pass-through for unknown confidence (legacy callers that emit no
 * confidence field default to "speculate"); the bundler's
 * `confidence < CONFIRMATION_MIN_CONFIDENCE` filter at turn-end
 * handles the downstream wire shape.
 *
 * @param {{field: string, confidence?: number}} slot
 * @returns {boolean}
 */
export function shouldGenerateConfirmation(slot) {
  if (!slot) return false;
  // 2026-05-29 — match buildConfirmationText's deny-list policy.
  if (SUPPRESSED_TTS_FIELDS.has(slot.field)) return false;
  if (typeof slot.field === 'string' && slot.field.endsWith('_id')) return false;
  if (typeof slot.confidence === 'number' && slot.confidence < CONFIRMATION_MIN_CONFIDENCE) {
    return false;
  }
  return true;
}
