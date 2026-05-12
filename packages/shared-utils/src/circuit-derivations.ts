/**
 * BS 7671 Zs = Ze + (R1+R2) identity — deterministic derivations and
 * Deepgram-decimal-recovery clamping for Sonnet-emitted impedance
 * values.
 *
 * Mirrors iOS `CircuitDerivations.swift` (recompute, recomputeAll,
 * resolveZe, clampImpedance) — keep in lock-step.
 *
 * - `recompute(circuit, ze)`: pure helper. Fills exactly ONE of the
 *   three unknowns (Zs / R1+R2 / Ze) when the other two are known.
 *   Never overwrites a non-empty target.
 * - `recomputeAll(job)`: walks every circuit on a job, resolving Ze
 *   per-circuit via `resolveZe`, and returns the updated circuits
 *   when at least one row changed.
 * - `resolveZe(circuit, job)`: priority chain — board.ze →
 *   board.ze_at_db (alias `zs_at_db` on PWA) → supply_characteristics.
 *   earth_loop_impedance_ze. Same order iOS uses since the multi-
 *   board sprint (2026-05-08).
 * - `clampImpedance(field, value, earthing?)`: bounds check on Sonnet-
 *   emitted impedance values. Deepgram regularly drops decimal points
 *   ("zero point four four" → "44"); when the raw value is implausible
 *   try ÷10 then ÷100 and accept the first divisor that lands in
 *   typical bounds. Otherwise out-of-range — caller decides.
 *
 * PWA column conventions used here:
 *   - `measured_zs_ohm`   (PWA) ≡ `measuredZsOhm` (iOS)
 *   - `r1_r2_ohm`         (PWA) ≡ `r1R2Ohm`       (iOS)
 *   - `ze`                on supply_characteristics or board record
 *   - `zs_at_db`          on board record (legacy alias `ze_at_db`)
 */

interface DerivableCircuit {
  measured_zs_ohm?: string;
  r1_r2_ohm?: string;
}

interface JobLike {
  supply_characteristics?: Record<string, unknown>;
  boards?: Array<Record<string, unknown>>;
  circuits?: Array<Record<string, unknown>>;
}

/** Parse a string to a finite number, or `null` for empty/non-numeric. */
function parseImpedance(s: string | undefined | null): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** 2 dp result, trailing-zero trim. Matches the inspector's typed-
 *  reading convention so derived values display identically to
 *  manually-entered ones. */
function format(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  let s = rounded.toFixed(2);
  if (s.includes('.')) {
    while (s.endsWith('0')) s = s.slice(0, -1);
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

export type DerivationOutcome =
  | { kind: 'no_change' }
  | { kind: 'filled_zs'; value: string }
  | { kind: 'filled_r1r2'; value: string }
  | { kind: 'filled_ze'; value: string };

/** Recompute derived values for a single circuit. Mutates the circuit
 *  row in place when filling Zs or R1+R2. Filling Ze is surfaced via
 *  the return value only — the caller decides whether to write it
 *  back onto supply_characteristics or a board record. */
export function recompute(
  circuit: DerivableCircuit,
  ze: string | null | undefined
): DerivationOutcome {
  const zeNum = parseImpedance(ze);
  const r1r2 = parseImpedance(circuit.r1_r2_ohm);
  const zs = parseImpedance(circuit.measured_zs_ohm);

  // Zs = Ze + R1+R2 — fill Zs when blank and the other two are
  // numeric.
  if (zs == null && zeNum != null && r1r2 != null) {
    const derived = format(zeNum + r1r2);
    circuit.measured_zs_ohm = derived;
    return { kind: 'filled_zs', value: derived };
  }

  // R1+R2 = Zs - Ze — fill R1+R2 when blank, the other two are
  // numeric, AND the result is non-negative (Zs ≥ Ze).
  if (r1r2 == null && zeNum != null && zs != null && zs >= zeNum) {
    const derived = format(zs - zeNum);
    circuit.r1_r2_ohm = derived;
    return { kind: 'filled_r1r2', value: derived };
  }

  // Ze = Zs - R1+R2 — rare in practice. Caller decides whether to
  // write the derived value to supply / board.
  if (zeNum == null && zs != null && r1r2 != null && zs >= r1r2) {
    return { kind: 'filled_ze', value: format(zs - r1r2) };
  }

  return { kind: 'no_change' };
}

/** Resolve the Ze that should drive a derivation for a given circuit.
 *  Priority: board.ze → board.zs_at_db (the PWA alias for iOS
 *  `ze_at_db`) → supply_characteristics.earth_loop_impedance_ze.
 *  Returns `null` when none of the three has a value.
 *
 *  The `board_id` lookup is optional — when the circuit has no
 *  `board_id` (single-board legacy snapshot) the helper falls through
 *  to the supply value directly. */
export function resolveZe(circuit: Record<string, unknown>, job: JobLike): string | null {
  const boardId =
    typeof circuit.board_id === 'string' && circuit.board_id ? circuit.board_id : null;
  const boards = Array.isArray(job.boards) ? job.boards : [];
  if (boardId) {
    const board = boards.find((b) => b && (b as { id?: string }).id === boardId) as
      | Record<string, unknown>
      | undefined;
    if (board) {
      const boardZe = typeof board.ze === 'string' ? board.ze.trim() : '';
      if (boardZe) return boardZe;
      const boardZsAtDb = typeof board.zs_at_db === 'string' ? board.zs_at_db.trim() : '';
      if (boardZsAtDb) return boardZsAtDb;
    }
  }
  const supply = (job.supply_characteristics as Record<string, unknown> | undefined) ?? {};
  // Supply tab reads under the PWA column `earth_loop_impedance_ze`
  // (long form) AND the wire writes also dual-write under `ze`. Check
  // both, preferring the explicit long form so user edits win over
  // a wire-shape mirror.
  const supplyLong =
    typeof supply.earth_loop_impedance_ze === 'string'
      ? (supply.earth_loop_impedance_ze as string).trim()
      : '';
  if (supplyLong) return supplyLong;
  const supplyShort = typeof supply.ze === 'string' ? (supply.ze as string).trim() : '';
  if (supplyShort) return supplyShort;
  return null;
}

/** Recompute every circuit on a job in one pass. Returns the updated
 *  circuits array when any row changed, or `null` to indicate a no-op
 *  (so the caller can skip the `updateJob` round trip).
 *
 *  Pure: never mutates the input `job.circuits` reference. */
export function recomputeAll(job: JobLike): Array<Record<string, unknown>> | null {
  if (!Array.isArray(job.circuits) || job.circuits.length === 0) return null;
  let changed = false;
  const next = job.circuits.map((row) => {
    const ze = resolveZe(row, job);
    const copy = { ...row } as DerivableCircuit & Record<string, unknown>;
    const outcome = recompute(copy, ze);
    if (outcome.kind === 'no_change') return row;
    changed = true;
    return copy;
  });
  return changed ? next : null;
}

// ─────────────────────────────────────────────────────────────────
// clampImpedance — Deepgram decimal-drop recovery.
// ─────────────────────────────────────────────────────────────────

export type ImpedanceField = 'ze' | 'continuity';

export type ClampOutcome =
  | { kind: 'ok'; value: string }
  | { kind: 'divided'; original: string; corrected: string; divisor: number }
  | { kind: 'out_of_range'; value: string };

function bounds(field: ImpedanceField, earthing: string | null | undefined): [number, number] {
  switch (field) {
    case 'ze': {
      // TT systems use a rod earth — Ze can legitimately be tens of
      // ohms. BS 7671 caps at 200 Ω. Any other earthing arrangement
      // (TN-S, TN-C-S/PME, TN-C, IT) sits below 5 Ω.
      if (typeof earthing === 'string' && earthing.toUpperCase().includes('TT')) {
        return [0.01, 200.0];
      }
      return [0.01, 5.0];
    }
    case 'continuity':
      // R1+R2 / ring R1 / Rn / R2 / bare R2 — tightest realistic
      // domestic range. Above 2 Ω is essentially always Deepgram
      // dropping a decimal.
      return [0.01, 2.0];
  }
}

function formatCorrected(d: number): string {
  const rounded = Math.round(d * 100) / 100;
  let s = rounded.toFixed(2);
  if (s.includes('.')) {
    while (s.endsWith('0')) s = s.slice(0, -1);
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

/** Decide what to do with a Sonnet-emitted impedance value:
 *
 *   1. If value ∈ typical range: accept (`ok`).
 *   2. Else try ÷10, then ÷100. Take the FIRST divisor that lands
 *      in range (`divided`).
 *   3. Otherwise `out_of_range` — caller decides whether to skip
 *      the write and surface the value via TTS.
 *
 *  Numeric input is preserved exactly when in range (no rounding —
 *  callers expect their string round-trip to land byte-identical).
 *  Divided values are rounded to 2 dp and trailing-zero-trimmed.
 */
export function clampImpedance(
  field: ImpedanceField,
  value: string,
  earthing?: string | null
): ClampOutcome {
  const trimmed = String(value).trim();
  if (!trimmed) return { kind: 'ok', value };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { kind: 'ok', value };
  const [lo, hi] = bounds(field, earthing ?? null);
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
