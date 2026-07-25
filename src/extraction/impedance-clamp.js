/**
 * Backend mirror of the client `clampImpedance` — Deepgram decimal-drop recovery,
 * made SERVER-AUTHORITATIVE so the spoken read-back always names the value that
 * was actually stored.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Field session `C06B9904` (2026-07-25, feedback id 100(b), SAFETY-CRITICAL):
 * Derek dictated "Main earth is 16 now.", the backend wrote the raw `16` and
 * synthesised the confirmation "Ze 16" from it, and then the CLIENT silently
 * divided the value to `1.6` before storing it (`impedance_auto_divided`). The
 * inspector heard a value 10× larger than the one that landed in the
 * certificate. That is a direct violation of Audio-First invariant #1 — the
 * read-back is the ONLY channel a hands-free inspector has, so it must reflect
 * the stored value, and a silent alteration is undetectable by ear.
 *
 * The clamp itself is a genuine convenience for a real dictation pattern (Flux
 * drops the decimal point: "nought point six five" → "65"). The defect was that
 * it ran client-side, AFTER the server had already spoken. Moving it to the
 * server pre-write seams makes ONE actor authoritative: the value the server
 * stores is the value the server speaks, and the correction is NAMED aloud
 * ("Ze recorded as 1.6 — I corrected 16 to 1.6.") so a WRONG correction is
 * catchable by ear.
 *
 * WHY A JS MIRROR AND NOT AN IMPORT OF `@certmate/shared-utils`
 * ────────────────────────────────────────────────────────────
 * Importing the TS source from the backend is impossible on four independent
 * counts, all verified at authoring time:
 *   1. the root `package.json` IS the backend manifest and declares no
 *      `@certmate/shared-utils` dependency (`workspaces: ["packages/*","web"]`
 *      makes it a sibling, not a dep);
 *   2. `packages/shared-utils` publishes RAW TypeScript (`"main":
 *      "src/index.ts"`) with no build output — there is no `dist/` to require;
 *   3. backend Jest runs with `transform: {}` and
 *      `moduleFileExtensions: ['js','json']`, so a `.ts` file cannot even be
 *      resolved, let alone compiled;
 *   4. `Dockerfile.backend` copies only `package*.json`, `src/`, `config/`,
 *      `assets/` and `python/` — `packages/` never reaches the runtime image, so
 *      an import that somehow passed tests would crash in production.
 *
 * This therefore follows the ESTABLISHED four-way-mirror precedent of
 * `src/extraction/ios-dedupe-key.js`: a hand-maintained backend twin, pinned
 * against the tracked TS source by a drift test
 * (`src/__tests__/stage6-impedance-clamp.test.js`) so the two cannot silently
 * diverge. The Swift reciprocal pin ships in the iOS repo.
 *
 * REFERENCE (the canonical source of the algorithm — do NOT change the ladder,
 * the bounds, or `formatCorrected` here without changing it there and updating
 * the drift test):
 *   packages/shared-utils/src/circuit-derivations.ts:207-281 (`clampImpedance`)
 */

import { getMainBoardId } from './stage6-multi-board-shape.js';

/**
 * Marker under which a pre-write seam stashes the correction it applied, on the
 * `perTurnWrites` entry it just produced.
 *
 * WHY A SYMBOL: the correction is BACKEND-INTERNAL provenance. It must reach the
 * confirmation synthesiser but must NEVER cross the wire — the extraction
 * payload is built by `JSON.stringify`-shaped serialisation, and a Symbol key is
 * invisible to it by construction, so this cannot leak to a client even by
 * accident. A plain string key would need a strip step at every wire boundary
 * and would silently start shipping the moment someone added a new boundary.
 */
export const IMPEDANCE_CLAMP_CORRECTION = Symbol('impedanceClampCorrection');

/**
 * Fields whose values are earth-fault-loop impedances (Ze at the origin or at a
 * distribution board).
 *
 * Order matches `resolveBoardAwareZe` (`stage6-dispatchers-circuit.js`) so the
 * two agree on which spelling wins when several are present. `zs_at_db` is an
 * `alias_for` of `ze_at_db` in `config/field_schema.json` and is
 * DISPATCHER-UNREACHABLE today (it is absent from `BOARD_FIELD_ENUM`, so
 * `stage6-dispatchers-board.js` rejects it) — it is carried here anyway because
 * the alias is real in the schema and a future widening of the enum must not
 * silently gain an unclamped Ze spelling.
 */
export const ZE_IMPEDANCE_FIELDS = Object.freeze([
  'ze',
  'earth_loop_impedance_ze',
  'ze_at_db',
  'zs_at_db',
]);

/**
 * Continuity-resistance fields: R1+R2 and the three ring end-to-end readings,
 * plus bare R2.
 *
 * NOTE `measured_zs_ohm` is DELIBERATELY ABSENT and must stay absent. The
 * backend range gate already allows 0–100 Ω for it
 * (`value-enum-validator.js`) — a circuit Zs of tens of ohms is legitimate on a
 * long final circuit — and iOS never clamped it either. Adding it here would
 * start silently dividing valid readings, which is a worse defect than the one
 * this module fixes.
 */
export const CONTINUITY_IMPEDANCE_FIELDS = Object.freeze([
  'r1_r2_ohm',
  'r2_ohm',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
]);

const ZE_FIELD_SET = new Set(ZE_IMPEDANCE_FIELDS);
const CONTINUITY_FIELD_SET = new Set(CONTINUITY_IMPEDANCE_FIELDS);

/**
 * Which clamp band (if any) a field belongs to.
 *
 * @param {string} field
 * @returns {'ze'|'continuity'|null} `null` for every field the clamp must not
 *   touch — the overwhelming majority. Callers treat `null` as "pass through
 *   byte-unchanged", which is what keeps this seam safe to call unconditionally.
 */
export function resolveImpedanceKind(field) {
  if (typeof field !== 'string' || field === '') return null;
  if (ZE_FIELD_SET.has(field)) return 'ze';
  if (CONTINUITY_FIELD_SET.has(field)) return 'continuity';
  return null;
}

/**
 * Resolve the earthing arrangement that governs the Ze band for a write, using
 * the same board-aware source ladder as `resolveBoardAwareZe`
 * (`stage6-dispatchers-circuit.js`) so the two cannot disagree about which board
 * a value belongs to.
 *
 * Sources: the target board's `boards[]` record (board-local for EVERY board),
 * then `circuits[0]` (which carries the ORIGIN SUPPLY earthing — seeded from the
 * job's supply characteristics and written by a dictated supply reading).
 *
 * TT WINS ACROSS SOURCES, deliberately. A board-local repeat of the arrangement
 * could in principle disagree with the origin, and the two candidate bands are
 * not symmetric in consequence: the TT band ([0.01, 200] Ω) is a SUPERSET of the
 * non-TT band ([0.01, 5] Ω), so believing "TT" can only ever cause the clamp to
 * leave a value alone, whereas believing "not TT" can cause it to divide a
 * perfectly good rod-earth reading by ten. Corrupting a correct reading is the
 * harm this whole plan exists to prevent, so any evidence of TT anywhere in the
 * ladder takes precedence over a non-TT sibling. Otherwise the first present
 * value wins, board-local before origin.
 *
 * @param {object|null|undefined} snapshot `session.stateSnapshot`.
 * @param {string|null|undefined} [inputBoardId] Board the write targets; falls
 *   back to the snapshot's current board, then the main board.
 * @returns {string|null} The arrangement string, or `null` when it is not
 *   established — which makes `clampReadingForDispatch` fail safe on `ze`.
 */
export function resolveBoardAwareEarthing(snapshot, inputBoardId) {
  const mainId = getMainBoardId(snapshot);
  const targetId = inputBoardId ?? snapshot?.currentBoardId ?? mainId;
  const boardRecord = Array.isArray(snapshot?.boards)
    ? snapshot.boards.find((b) => b && b.id === targetId)
    : null;
  const circuits0 = snapshot?.circuits?.[0];

  // Scalars only, mirroring the supply-ingestion + resolveBoardAwareZe
  // hardening: String(['TT']) === 'TT' would let a malformed array value pick
  // the band.
  const present = (v) => {
    if (typeof v !== 'string') return null;
    const str = v.trim();
    return str === '' ? null : str;
  };

  let first = null;
  for (const src of [boardRecord, circuits0]) {
    if (!src) continue;
    const str = present(src.earthing_arrangement);
    if (str == null) continue;
    if (str.toUpperCase().includes('TT')) return str;
    if (first === null) first = str;
  }
  return first;
}

/**
 * Mirror of `bounds()` in circuit-derivations.ts:217-234.
 *
 * @param {'ze'|'continuity'} kind
 * @param {string|null|undefined} earthing
 * @returns {[number, number]}
 */
function bounds(kind, earthing) {
  if (kind === 'ze') {
    // TT systems use a rod earth — Ze can legitimately be tens of ohms. BS 7671
    // caps at 200 Ω. Any other earthing arrangement (TN-S, TN-C-S/PME, TN-C,
    // IT) sits below 5 Ω.
    if (typeof earthing === 'string' && earthing.toUpperCase().includes('TT')) {
      return [0.01, 200.0];
    }
    return [0.01, 5.0];
  }
  // R1+R2 / ring R1 / Rn / R2 / bare R2 — tightest realistic domestic range.
  // Above 2 Ω is essentially always Deepgram dropping a decimal.
  return [0.01, 2.0];
}

/**
 * Mirror of `formatCorrected()` in circuit-derivations.ts:236-244.
 *
 * @param {number} d
 * @returns {string}
 */
function formatCorrected(d) {
  const rounded = Math.round(d * 100) / 100;
  let s = rounded.toFixed(2);
  if (s.includes('.')) {
    while (s.endsWith('0')) s = s.slice(0, -1);
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

/**
 * Mirror of `clampImpedance()` in circuit-derivations.ts:258-281.
 *
 *   1. value ∈ typical range → accept (`ok`).
 *   2. else try ÷10, then ÷100; take the FIRST divisor that lands in range
 *      (`divided`).
 *   3. otherwise `out_of_range` — the caller decides.
 *
 * Numeric input is preserved EXACTLY when in range (no rounding — callers expect
 * their string round-trip to land byte-identical). Divided values are rounded to
 * 2 dp and trailing-zero-trimmed.
 *
 * @param {'ze'|'continuity'} kind
 * @param {string} value
 * @param {string|null} [earthing]
 * @returns {{kind:'ok', value:string}
 *   | {kind:'divided', original:string, corrected:string, divisor:number}
 *   | {kind:'out_of_range', value:string}}
 */
export function clampImpedance(kind, value, earthing) {
  const trimmed = String(value).trim();
  if (!trimmed) return { kind: 'ok', value };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { kind: 'ok', value };
  const [lo, hi] = bounds(kind, earthing ?? null);
  if (n >= lo && n <= hi) return { kind: 'ok', value };
  for (const divisor of [10, 100]) {
    const candidate = n / divisor;
    if (candidate >= lo && candidate <= hi) {
      return {
        kind: 'divided',
        original: trimmed,
        corrected: formatCorrected(candidate),
        divisor,
      };
    }
  }
  return { kind: 'out_of_range', value: trimmed };
}

/**
 * THE SEAM ENTRY POINT. Pure, allocation-light, holds no session state of its
 * own — every caller passes the earthing arrangement it resolved itself, so the
 * clamp cannot accidentally read a stale global.
 *
 * Call it IMMEDIATELY AFTER the existing value coercion at each pre-write seam,
 * so the ordering is:
 *
 *     coerce (garble / enum normalisation) → clamp (numeric range) → validate
 *
 * Clamping BEFORE coercion would see un-normalised garble; clamping AFTER
 * validation would either be rejected by the range gate first (defeating the
 * whole point) or would alter a value the gate had already blessed.
 *
 * FAIL-SAFE ON UNKNOWN EARTHING (`ze` band only): if the earthing arrangement is
 * not established, do NOT divide. The `ze` band is 40× wider on TT
 * ([0.01, 200] vs [0.01, 5]), so a `16` is a perfectly ordinary TT rod-earth
 * reading and dividing it to `1.6` would CORRUPT a correct reading — the exact
 * class of harm this plan exists to prevent. Guessing wrong in the "divide"
 * direction is unrecoverable-by-ear; leaving a raw value alone is not (it is
 * simply read back as dictated). Continuity bands are earthing-independent and
 * so are unaffected.
 *
 * `out_of_range` is returned as a NO-OP correction: the write proceeds with the
 * value unchanged and no correction is spoken. §4.6 of the plan keeps
 * `out_of_range` behaviour deliberately untouched — this change is only about
 * making the DIVIDE audible, and inventing a new backend rejection path here
 * would risk silently dropping readings (Audio-First invariant #2).
 *
 * @param {object} args
 * @param {string} args.field Raw (pre-A2-canonicalisation) field name.
 * @param {*} args.value Coerced value, normally a string.
 * @param {string|null} [args.earthing] Resolved earthing arrangement for the
 *   board this write targets, or `null`/`undefined` when not established.
 * @returns {{value:*, correction:{original:string, corrected:string, divisor:number}|null}}
 *   `value` is the value to write (unchanged unless a divide applied);
 *   `correction` is non-null ONLY on a divide, and is what makes the read-back
 *   name the alteration.
 */
export function clampReadingForDispatch({ field, value, earthing } = {}) {
  const kind = resolveImpedanceKind(field);
  if (kind === null) return { value, correction: null };

  // Non-string / non-finite values are left to the validator; the clamp has
  // nothing meaningful to say about them and must not coerce their type.
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { value, correction: null };
  }

  const earthingKnown = typeof earthing === 'string' && earthing.trim() !== '';
  if (kind === 'ze' && !earthingKnown) {
    // Fail safe — see the FAIL-SAFE note above.
    return { value, correction: null };
  }

  const outcome = clampImpedance(kind, value, earthingKnown ? earthing : null);
  if (outcome.kind !== 'divided') return { value, correction: null };

  return {
    value: outcome.corrected,
    correction: {
      original: outcome.original,
      corrected: outcome.corrected,
      divisor: outcome.divisor,
    },
  };
}

/**
 * Single telemetry choke point for an applied clamp — one INFO row per corrected
 * write, from whichever seam applied it.
 *
 * The clamp is now the only actor that can change a dictated number between the
 * inspector's mouth and the certificate, so it has to be observable: a
 * mis-tuned band or a wrongly-resolved earthing arrangement shows up here as a
 * run of divides that should not have happened. `seam` is what makes the row
 * actionable — the same correction reaching TTS from the dialogue engine and
 * from the tool dispatcher are different bugs.
 *
 * No leak-filter concern: every field is either server-derived or a numeric
 * electrical measurement. The values ARE logged deliberately (unlike the
 * PII-filtered `input_summary`) — a clamp row without the before/after numbers
 * could not be used to audit a suspect correction.
 *
 * @param {object|null|undefined} logger
 * @param {object} row
 * @param {string} row.seam Stable identifier of the call site.
 */
export function logImpedanceClamp(logger, row) {
  logger?.info?.('stage6.impedance_clamp_applied', row);
}
