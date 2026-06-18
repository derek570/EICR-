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
  // ─── Supply protective device (DNO cutout) / main switch ────────
  // 2026-06-03 voice-correctness Fix B: inspectors say "main fuse" /
  // "supply fuse" / "DNO fuse" / "cutout" for the DNO-side device
  // (canonical `spd_*` fields), and "main switch" / "main isolator"
  // for the consumer-unit isolator (`main_switch_*`). Without these
  // entries the deriveFriendlyName fallback speaks "SPD BS EN ..." /
  // "main switch BS EN ..." (snake_case→spaces), which (a) doesn't
  // echo the inspector's vocabulary and (b) for `spd_*` includes the
  // technical-jargon abbreviation that no inspector uses on site.
  // Inspector vocabulary verified via field-name-corrections.js —
  // `main_fuse_*` is the canonical alias namespace. Session
  // F03B590C turn 9 (2026-06-03 20:04 UTC).
  spd_bs_en: 'main fuse BS EN',
  spd_rated_current: 'main fuse rating',
  spd_short_circuit: 'main fuse breaking capacity',
  spd_type_supply: 'main fuse type',
  // Surge Protection Device (transient overvoltage protection) — distinct
  // from the main fuse / DNO cutout above. Spoken in the inspector's surge
  // vocabulary, not "SPD" jargon.
  surge_spd_present: 'surge protection fitted',
  surge_spd_type: 'surge protection type',
  surge_spd_bs_en: 'surge protection BS EN',
  surge_status_indicator: 'surge protection indicator',
  main_switch_bs_en: 'main switch BS EN',
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
  // PLAN voice-feedback-2026-06-05 Group E (Derek decision 1, 2026-06-05) —
  // the consumer-tails CSA slot rendered TTS "main switch conductor CSA"
  // via the snake-case→spaces fallback. Inspector field-test feedback at
  // 10:38:16 (session 84CE2125…) recalled it as "submain cable size".
  // Locking the friendly name to "tails CSA" — the on-site vocabulary
  // inspectors use for the consumer-side conductor between the cutout
  // and the main switch. On multi-board jobs the same slot lives on
  // sub-boards too where "sub-main" is the more familiar wording;
  // acceptable trade-off — the vast majority of jobs are single-board,
  // and on a sub-board "tails CSA" still resolves the value unambiguously.
  main_switch_conductor_csa: 'tails CSA',
  // PLAN voice-feedback-2026-06-05 Group F — `earthing_conductor_csa` is
  // the canonical board enum slot (config/field_schema.json:759). Inspector
  // marker #5 at 10:39:24 ("I said main earth is 16 mil") reported hearing
  // a bare "16" in TTS confirmation with no field context. Without an
  // explicit friendly-name the snake_case→spaces fallback renders
  // "earthing conductor CSA" — not what the inspector dictated and not
  // what they expected back. "main earth" matches the inspector's spoken
  // vocabulary verbatim. Defensive legacy alias on the next line covers
  // the iOS apply path where `main_earth_conductor_csa` may still flow.
  earthing_conductor_csa: 'main earth',
  main_earth_conductor_csa: 'main earth',
  // PLAN-backend-final.md Phase 4.4 — Derek's preferred vocabulary
  // for the client identity slot is "customer name", not the snake-
  // case→spaces fallback ("client name"). MUST be added INSIDE this
  // frozen literal — Object.freeze + ES-modules-always-strict means
  // a post-declaration assignment like
  // `CONFIRMATION_FRIENDLY_NAMES.client_name = "customer name"`
  // throws TypeError at runtime and the Phase 4 vocabulary-parity
  // acceptance would silently fail.
  client_name: 'customer name',
  // Phase 4.0 added the BILLING/CLIENT address slot family; spell out
  // the friendly forms so TTS doesn't echo snake_case ("client address",
  // "client postcode", "client town", "client county" are already the
  // snake→spaces fallback shape, but listing them explicitly future-
  // proofs against a rename that would silently re-fall to the
  // derivation path).
  client_address: 'customer address',
  client_postcode: 'customer postcode',
  client_town: 'customer town',
  client_county: 'customer county',
});

// Loaded-barrel SPECULATOR pre-synth cost gate (audio-first, 2026-06-18).
// This threshold is NO LONGER applied to the FINAL end-of-turn read-back
// (stage6-event-bundler.js) — a hands-free inspector verifies by ear, so
// every applied reading is read back regardless of self-reported
// confidence. The ONLY remaining consumer is shouldGenerateConfirmation
// below, which the loaded-barrel speculator uses to decide whether to
// pre-synthesise a mid-stream preview: a sub-threshold confidence skips
// the speculative pre-synth (a cost optimisation), and the value is still
// read back at turn end by the (now un-gated) bundler.
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

export function deriveFriendlyName(field) {
  let s = field.replace(/_/g, ' ');
  for (const [re, repl] of ACRONYM_FIXES) {
    s = s.replace(re, repl);
  }
  return s;
}

/**
 * Build a SINGLE grouped confirmation for a fan-out reading that
 * touched multiple circuits in one turn (e.g. an IR reading dictated
 * "for all circuits", or a set_field_for_all_circuits broadcast).
 *
 * Issue 10 from 2026-05-31 field test (session B95B2EE1
 * @23:00:24): one IR utterance "for all circuits" produced four
 * separate per-circuit speculator confirmations in 34ms — Derek
 * heard "Circuit 4, IR L to L >299" (one random circuit, not the
 * "all circuits" he asked for). The bundler also emitted four
 * per-circuit confirmations 2s later; three were deduped, the fourth
 * was a stale wrong-text playback. The right behaviour: one TTS
 * line that says "All circuits, IR L to L >299" / "Circuits 1 to 5,
 * IR L to L >299" / "Circuits 1, 3, 5, IR L to L >299" depending on
 * shape.
 *
 * Shape rules (locked 2026-06-01):
 *  - circuits.length === 1 → caller should fall through to
 *    buildConfirmationText, this helper returns null.
 *  - circuits.length === totalCircuitsInJob (where supplied + > 0)
 *    → "All circuits, ${friendly} ${value}".
 *  - circuits form a contiguous integer range (no gaps) of >= 3 →
 *    "Circuits ${min} to ${max}, ${friendly} ${value}".
 *  - otherwise → comma-separated list:
 *      "Circuits 1, 3, 5, ${friendly} ${value}".
 *
 * Designations are NOT used for grouped text — speaking five circuit
 * names would dominate the TTS line, which is why the inspector
 * batched in the first place. Designations remain in the per-
 * circuit path for single readings.
 *
 * Returns null when the field is suppressed or the value renders
 * empty (same gating as buildConfirmationText).
 */
export function buildGroupedConfirmationText(field, value, circuits, totalCircuitsInJob = null) {
  if (SUPPRESSED_TTS_FIELDS.has(field)) return null;
  if (typeof field === 'string' && field.endsWith('_id')) return null;
  if (!Array.isArray(circuits) || circuits.length === 0) return null;
  const valueStr = String(value ?? '').trim();
  if (!valueStr) return null;

  // Filter to integer circuit refs > 0, dedupe, and sort ascending.
  // Board-level (circuit 0 / null) doesn't belong in a fan-out — if
  // a 0 sneaks in, treat the broadcast as ambiguous and bail to per-
  // circuit handling by returning null.
  const ints = [];
  const seen = new Set();
  for (const c of circuits) {
    const n = typeof c === 'number' ? c : parseInt(c, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (seen.has(n)) continue;
    seen.add(n);
    ints.push(n);
  }
  ints.sort((a, b) => a - b);

  if (ints.length < 2) return null;

  const friendly = CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);

  // Tail uses the same special-cases as buildConfirmationText: the
  // valueStr embeds straight after the friendly name. We do NOT
  // replicate buildConfirmationText's polarity_confirmed / circuit_
  // designation branches because those fields are not realistic
  // fan-out targets — polarity is per-circuit, designation is per-
  // circuit. If they ever DO arrive here, fall through to the plain
  // form (caller can split if it matters).
  let tail;
  if (field === 'polarity_confirmed') {
    const lc = valueStr.toLowerCase();
    const isTrue = lc === 'true' || lc === 'y' || lc === 'ok' || lc === 'yes';
    if (!isTrue) return null;
    tail = 'polarity confirmed';
  } else {
    tail = `${friendly} ${valueStr}`;
  }

  // Head selection.
  // "All circuits" only when totalCircuitsInJob is a positive int we
  // can compare against. Without it, fall through to the range/list
  // form — we don't want to say "all" when we might just be missing
  // circuits the inspector skipped.
  if (
    typeof totalCircuitsInJob === 'number' &&
    Number.isInteger(totalCircuitsInJob) &&
    totalCircuitsInJob > 0 &&
    ints.length === totalCircuitsInJob
  ) {
    return `All circuits, ${tail}`;
  }
  // Contiguous-range form needs at least 3 circuits so "Circuits 1
  // and 2" doesn't sound like a labour-saving lie compared to listing
  // them.
  const isContiguous = ints.length >= 3 && ints[ints.length - 1] - ints[0] === ints.length - 1;
  if (isContiguous) {
    return `Circuits ${ints[0]} to ${ints[ints.length - 1]}, ${tail}`;
  }
  return `Circuits ${ints.join(', ')}, ${tail}`;
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
