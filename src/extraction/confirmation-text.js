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

// Map of canonical field names to short spoken labels for confirmation
// read-backs (Voice button feature). Only includes fields whose acoustic
// feedback genuinely helps an inspector verify the dictation was
// understood — numeric measurements and high-value categorical writes.
// Free-text fields (designation), long-form codes (BS_EN), and address
// fields are intentionally excluded; the inspector reads those off the
// screen instead.
//
// Address fields are also suppressed iOS-side (DeepgramRecordingViewModel
// `ttsSuppressedAddressFields`) — they're omitted here as belt-and-braces
// so the backend doesn't ship bytes the client immediately discards.
export const CONFIRMATION_FRIENDLY_NAMES = Object.freeze({
  measured_zs_ohm: 'Zs',
  r1_r2_ohm: 'R1 plus R2',
  r2_ohm: 'R2',
  ring_r1_ohm: 'ring r1',
  ring_rn_ohm: 'ring rn',
  ring_r2_ohm: 'ring r2',
  ir_live_earth_mohm: 'IR L to E',
  ir_live_live_mohm: 'IR L to L',
  ocpd_rating_a: 'OCPD rating',
  ocpd_type: 'OCPD type',
  rcd_operating_current_ma: 'RCD',
  rcd_time_ms: 'RCD time',
  rcd_type: 'RCD type',
  number_of_points: 'points',
  wiring_type: 'wiring type',
  live_csa_mm2: 'live CSA',
  cpc_csa_mm2: 'CPC CSA',
  polarity_confirmed: 'polarity',
  // Board-level (circuit=0 on the wire) — the friendly name carries
  // enough context on its own; no "Circuit 0" prefix is rendered.
  earth_loop_impedance_ze: 'Ze',
  prospective_fault_current: 'PFC',
  prospective_short_circuit_current: 'PSCC',
  prospective_earth_fault_current: 'PEFC',
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
export function buildConfirmationText(field, value, circuit) {
  const friendly = CONFIRMATION_FRIENDLY_NAMES[field];
  if (!friendly) return null;
  const valueStr = String(value ?? '').trim();
  if (!valueStr) return null;
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
    return `Circuit ${circuit}, polarity confirmed`;
  }
  // Board-level readings (circuit 0 or absent) skip the "Circuit N,"
  // prefix — "Ze 0.25" is a complete sentence in inspector parlance,
  // "Circuit 0, Ze" would be confusing.
  if (circuit == null || circuit === 0) {
    return `${friendly} ${valueStr}`;
  }
  return `Circuit ${circuit}, ${friendly} ${valueStr}`;
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
  if (!CONFIRMATION_FRIENDLY_NAMES[slot.field]) return false;
  if (typeof slot.confidence === 'number' && slot.confidence < CONFIRMATION_MIN_CONFIDENCE) {
    return false;
  }
  return true;
}
