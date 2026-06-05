/**
 * reading-transcript-anchor.js — speech-anchor helper for the Bug 2
 * dispatcher metric (`stage6_reading_field_guessed_from_value`).
 *
 * 2026-06-03 — created during the observation-correctness sprint. Bug 2:
 * Haiku 4.5 emitted `record_reading {field: r1_r2_ohm, circuit: 4,
 * value: 0.6}` for the utterance "upstairs sockets number 0.6" — no
 * field name in the inspector's words; the field was chosen from
 * value-range alone (0.6 Ω is plausible for R1+R2). This helper is the
 * dispatcher's evidence-collection arm: when the field cannot be
 * anchored in the inspector's transcript by either (i) a normalised
 * form of the field's display label, OR (ii) a known spoken alias, the
 * dispatcher logs a `stage6_reading_field_guessed_from_value` row so
 * we can measure the rate over time and decide whether to promote the
 * warn-only metric to a hard reject.
 *
 * NORMALISATION
 *   Labels from config/field_schema.json carry unit suffixes and
 *   parenthetical qualifiers no inspector says aloud (e.g. `R1+R2 (ohm)`,
 *   `Max Disconnect Time (s)`, `IR L-L (Mohm)`). Raw substring matching
 *   against the label would return false on every real utterance.
 *   Normalisation: strip parenthetical content, strip trailing unit
 *   tokens (s, v, a, ms, ma, ka, mohm, ohm, mm2, kv), collapse
 *   whitespace, lowercase.
 *
 * SPOKEN ALIASES
 *   Hand-curated map per field. Sourced from inspector speech patterns
 *   logged in CloudWatch transcripts. NOT derived from
 *   field-name-corrections.js — that file maps canonical server field
 *   keys to legacy wire keys, NOT spoken phrasings; using it would miss
 *   every utterance and pollute the metric.
 *
 * COVERAGE
 *   Every member of RECORDABLE_READING_FIELDS MUST have at least one
 *   anchor (label OR alias). The mandatory coverage test in
 *   reading-transcript-anchor.test.js iterates the shared set from
 *   src/extraction/recordable-reading-fields.js (single source of
 *   truth) and asserts the helper returns true given a synthetic
 *   transcript containing either the normalised label or one alias.
 *   Silent under-coverage on a legitimate dictation would pollute the
 *   warn-only metric and skew the >5%/14-day promotion decision.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'field_schema.json');
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Hand-curated. Add a new entry when:
//   (a) a new regex-emittable reading field lands in
//       RECORDABLE_READING_FIELDS (the coverage test fails loudly), OR
//   (b) field telemetry shows a real inspector phrasing the current
//       aliases don't cover. The latter is the long-tail growth path;
//       observability-first metric means we don't have to be perfect
//       on day one — under-coverage shows up as elevated false-fire
//       rate, not as wrongly-rejected writes.
const SPOKEN_ALIASES = {
  measured_zs_ohm: ['zs'],
  ze: ['ze'],
  ze_at_db: ['ze at db', 'ze at the board'],
  ipf_at_db: ['ipf', 'pfc', 'pscc', 'prospective fault current'],
  r1_r2_ohm: ['r1 plus r2', 'r1+r2', 'r1 r2'],
  r2_ohm: ['r2'],
  ring_r1_ohm: ['ring r1', 'lives'],
  ring_rn_ohm: ['ring rn', 'neutrals'],
  ring_r2_ohm: ['ring r2', 'earths'],
  ir_live_live_mohm: ['ir', 'insulation resistance', 'live to live', 'live live'],
  ir_live_earth_mohm: ['ir', 'insulation resistance', 'live to earth', 'live earth'],
  ir_test_voltage_v: ['ir test voltage', 'test voltage'],
  rcd_time_ms: ['rcd time', 'rcd trip time'],
  rcd_operating_current_ma: ['rcd current', 'rcd operating', 'operating current'],
  polarity_confirmed: ['polarity'],
  rcd_button_confirmed: ['rcd test button', 'rcd button'],
  afdd_button_confirmed: ['afdd test button', 'afdd button', 'afdd'],
  number_of_points: ['points', 'number of points'],
  live_csa_mm2: ['live csa', 'cable size', 'cable csa'],
  cpc_csa_mm2: ['cpc csa', 'cpc'],
  max_disconnect_time_s: ['disconnect time', 'max disconnect'],
  ocpd_rating_a: ['ocpd rating', 'breaker rating', 'mcb rating'],
  ocpd_breaking_capacity_ka: ['breaking capacity'],
  ocpd_max_zs_ohm: ['max zs'],
  // legacy / wire aliases. Match RECORDABLE_READING_FIELDS membership
  // so the coverage test passes; aliases overlap with the canonical
  // field above (a transcript anchoring the legacy form is also
  // anchoring the canonical form).
  zs: ['zs'],
  pfc: ['pfc', 'pscc'],
  r1_plus_r2: ['r1 plus r2', 'r1+r2', 'r1 r2'],
  rcd_trip_time: ['rcd time', 'rcd trip time'],
};

const UNIT_TAIL_RE = /\s+(?:s|v|a|ms|ma|ka|mohm|ohm|mm2|kv)$/i;

export function normaliseLabel(label) {
  if (typeof label !== 'string') return '';
  return label
    .replace(/\([^)]*\)/g, '')
    .replace(UNIT_TAIL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fieldLabel(field) {
  const cf = SCHEMA.circuit_fields?.[field];
  const bf = SCHEMA.board_fields?.[field];
  const def = cf || bf || null;
  return def?.label ?? '';
}

/**
 * Does the transcript anchor a record_reading on the given field?
 *
 * Returns true if the lowercased transcript contains either (i) a
 * normalised form of the field's display label from
 * config/field_schema.json, OR (ii) a known spoken alias.
 *
 * Returns false on missing / empty / non-string transcript so callers
 * can use the result directly as the metric-suppression gate (the
 * dispatcher already skips the metric on null/empty transcripts per
 * the Bug 2 plan, so this never fires the metric on a falsy input).
 *
 * @param {string} field — record_reading.field value (canonical or legacy)
 * @param {string} transcript — session.activeTurnTranscript at dispatch time
 * @returns {boolean}
 */
export function hasReadingFieldAnchor(field, transcript) {
  if (typeof field !== 'string' || field.length === 0) return false;
  if (typeof transcript !== 'string' || transcript.length === 0) return false;
  const lowered = transcript.toLowerCase();
  const label = normaliseLabel(fieldLabel(field));
  if (label.length > 0 && lowered.includes(label)) return true;
  const aliases = SPOKEN_ALIASES[field] || [];
  for (const a of aliases) {
    if (a.length > 0 && lowered.includes(a)) return true;
  }
  return false;
}
