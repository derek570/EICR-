/**
 * apply-extraction — H3/H4/H5 impedance compliance pass tests.
 *
 *  H3: `ocpd_max_zs_ohm` auto-computed from OCPD type + rating +
 *      max_disconnect_time_s (BS 7671 Tables 41.2 / 41.3 / 41.4).
 *  H4: Zs ↔ R1+R2 ↔ Ze derivation across all circuits after readings
 *      land (BS 7671 Zs = Ze + R1+R2).
 *  H5: Sonnet-emitted impedance values clamped via ÷10 / ÷100 when
 *      out of typical band — Deepgram decimal-drop recovery.
 *
 *  iOS canon: `Circuit.recalculateMaxZs`, `CircuitDerivations.
 *  recomputeAll`, `CircuitDerivations.clampImpedance` (Swift files in
 *  CertMateUnified/Sources/{Models,Processing}).
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────
// H3 — Max Zs auto-compute
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction H3 — ocpd_max_zs_ohm auto-compute', () => {
  it('computes Type B 32A @ 0.4s = 1.44 Ω from Sonnet OCPD writes', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [
        { circuit: 1, field: 'ocpd_type', value: 'B' },
        { circuit: 1, field: 'ocpd_rating_a', value: '32' },
        // Default max_disconnect_time_s ('0.4') will be applied by H7
        // on a newly-created row; for this test the row pre-exists so
        // we set it explicitly.
        { circuit: 1, field: 'max_disconnect_time_s', value: '0.4' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.circuits![0].ocpd_max_zs_ohm).toBe('1.44');
  });

  it('switches to 5s table when max_disconnect_time_s = "5"', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Sub-main' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [
        { circuit: 1, field: 'ocpd_type', value: 'B' },
        { circuit: 1, field: 'ocpd_rating_a', value: '32' },
        { circuit: 1, field: 'max_disconnect_time_s', value: '5' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // Table 41.3: B_32 @ 5s = 2.40
    expect(applied!.patch.circuits![0].ocpd_max_zs_ohm).toBe('2.40');
  });

  it('skips computation when OCPD type is missing', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      ocpd_rating_a: '32',
    };
    const job = makeJob({ circuits: [row] });
    const applied = applyExtractionToJob(job, makeResult({}));
    // No reading touched the row; recompute pass should leave it alone.
    expect(applied?.patch.circuits?.[0]?.ocpd_max_zs_ohm).toBeUndefined();
  });

  it('does NOT overwrite a user-typed max Zs override', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Special',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
      ocpd_max_zs_ohm: '9.99', // user wrote a deliberately-different value
    };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'ocpd_type', value: 'B' }],
    });
    const applied = applyExtractionToJob(job, result);
    // Row sees no change because the only reading was already-set,
    // OR if changed, the max-Zs MUST be preserved.
    const after = applied?.patch.circuits?.[0] ?? row;
    expect((after as CircuitRow).ocpd_max_zs_ohm).toBe('9.99');
  });

  it('handles fuse types (BS3036, BS1361, BS88)', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [
        { circuit: 1, field: 'ocpd_type', value: 'BS88' },
        { circuit: 1, field: 'ocpd_rating_a', value: '32' },
        { circuit: 1, field: 'max_disconnect_time_s', value: '0.4' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    // Table 41.4: BS88_32 @ 0.4s = 0.93
    expect(applied!.patch.circuits![0].ocpd_max_zs_ohm).toBe('0.93');
  });
});

// ────────────────────────────────────────────────────────────────────
// H4 — Zs ↔ R1+R2 ↔ Ze derivation
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction H4 — Zs derivation on Sonnet writes', () => {
  it('fills Zs when Ze (supply) + R1+R2 (circuit) both present', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      r1_r2_ohm: '0.42',
    };
    const job = makeJob({
      circuits: [row],
      supply_characteristics: { earth_loop_impedance_ze: '0.35' },
    });
    // Trigger by writing any reading on the circuit (or just rely on
    // a no-op extraction triggering the recompute pass).
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].measured_zs_ohm).toBe('0.77');
  });

  it('fills Zs from short-form ze alias (wire-shape dual-write)', () => {
    // The supply tab apply-path dual-writes Ze under both
    // `earth_loop_impedance_ze` (PWA col) AND `ze` (wire). Resolve
    // should accept either.
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Lights',
      r1_r2_ohm: '0.2',
    };
    const job = makeJob({
      circuits: [row],
      supply_characteristics: { ze: '0.35' },
    });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '0.2' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].measured_zs_ohm).toBe('0.55');
  });

  it('does NOT overwrite an inspector-typed Zs', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      r1_r2_ohm: '0.42',
      measured_zs_ohm: '0.99', // typed value
    };
    const job = makeJob({
      circuits: [row],
      supply_characteristics: { earth_loop_impedance_ze: '0.35' },
    });
    const applied = applyExtractionToJob(job, makeResult({}));
    const after = applied?.patch.circuits?.[0] ?? row;
    expect((after as CircuitRow).measured_zs_ohm).toBe('0.99');
  });

  it('fills R1+R2 when Ze + Zs both present (and Zs ≥ Ze)', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Shower',
      measured_zs_ohm: '0.77',
    };
    const job = makeJob({
      circuits: [row],
      supply_characteristics: { earth_loop_impedance_ze: '0.35' },
    });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.77' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].r1_r2_ohm).toBe('0.42');
  });
});

// ────────────────────────────────────────────────────────────────────
// H5 — clampImpedance recovery for Deepgram decimal drops
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction H5 — impedance clamp recovery', () => {
  // ──────────────────────────────────────────────────────────────────
  // Plan D (id-100(b)) web companion, 2026-07-25 — `measured_zs_ohm` is
  // no longer clamped client-side. These two tests are DISCRIMINATING:
  // on unfixed `main` the map still carried `measured_zs_ohm:'continuity'`
  // and both values below were silently divided.
  // ──────────────────────────────────────────────────────────────────
  it('DISCRIMINATING: a legitimate 5 Ω Zs is NOT silently divided to 0.5', () => {
    // The defect this removal fixes. 5 Ω is a perfectly ordinary Zs on a
    // long radial or a TT installation, and the backend's own range gate
    // allows Zs up to 100 Ω — but web's continuity band `[0.01, 2.0]`
    // treated it as a dropped decimal and wrote 0.5, an order of
    // magnitude out, silently. On `main` this expectation reads '0.5'.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Outbuilding' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '5' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].measured_zs_ohm).toBe('5');
  });

  it('DISCRIMINATING: an apparently decimal-dropped Zs is stored RAW — nothing corrects it, by design', () => {
    // "44" for a Zs probably IS a dropped decimal — and it is still
    // stored as 44, on every platform. Plan D's backend clamp set
    // deliberately EXCLUDES `measured_zs_ohm` (a backend test pins
    // `resolveImpedanceKind('measured_zs_ohm') === null`), because
    // adopting web's continuity band server-side would newly divide
    // legitimate multi-ohm Zs on iOS. So this is NOT "left for the
    // server to fix later" — no layer fixes it, and that is the
    // decision, not an oversight.
    //
    // Correcting it HERE is the thing that must not happen:
    // `applyExtractionToJob` has no TTS channel, so a client-side divide
    // is silent — the inspector hears the server read back 44 while 0.44
    // sits in the cell. That divergence between the spoken and the
    // stored number is precisely the id-100(b) defect. A wrong Zs is
    // caught by ear instead: the inspector hears "Zs 44" and corrects it
    // by speaking, which only works while both numbers agree.
    //
    // On `main` this expectation reads '0.44'.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '44' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].measured_zs_ohm).toBe('44');
  });

  it('the removal is SCOPED to Zs — R1+R2 still clamps in the same extraction', () => {
    // Guards the removal against over-reach: the shared `continuity`
    // band is still correct for the R1+R2 / ring legs (a genuinely
    // sub-ohm family), and pulling Zs out must not disturb them. Both
    // fields ride the same map on the same circuit in one turn.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Ring' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [
        { circuit: 1, field: 'measured_zs_ohm', value: '5' },
        { circuit: 1, field: 'r1_r2_ohm', value: '14' },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    const cell = applied!.patch.circuits![0];
    expect(cell.measured_zs_ohm).toBe('5');
    expect(cell.r1_r2_ohm).toBe('1.4');
  });

  it('CHARACTERISATION (not change-proving): an already-server-corrected value passes through inert', () => {
    // §4.9 round-5 IMPORTANT, recorded honestly: this test CANNOT FAIL
    // on `main` and must NOT be counted among the tests that prove the
    // fix. It exists only to pin the shape the plan relies on — that
    // web's retained clamp is inert for values the server already
    // corrected. `clampImpedance` returns `{kind:'ok'}` for an in-band
    // input, so no divide happens, no metadata is emitted, and there is
    // no TTS side-effect (web has no TTS channel here at all). That
    // inertness is WHY `recording-context.tsx` needs no correction
    // plumbing and the backend confirmation can stay authoritative.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Ring' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '1.6' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].r1_r2_ohm).toBe('1.6');
  });

  it('recovers via ÷10 when the value is just one decimal-place off', () => {
    // "1.4" heard as "14" → /10 → "1.4" lands in 0.01-2 band.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Ring' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '14' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].r1_r2_ohm).toBe('1.4');
  });

  it('still writes out-of-range values (visual gate is downstream)', () => {
    // 9999 doesn't recover cleanly (÷10 = 999.9, ÷100 = 99.99). Out
    // of typical band but we write it so the inspector sees the
    // wonky value rather than a silent drop.
    //
    // Re-pointed from `measured_zs_ohm` to `r1_r2_ohm` in the plan-D web
    // companion: Zs no longer enters the clamp at all, so asserting it
    // on Zs would have gone on passing while testing nothing. The
    // `out_of_range` branch still needs a field that reaches it.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Shower' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '9999' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].r1_r2_ohm).toBe('9999');
  });

  it('passes through in-range values unchanged (no rounding surprises)', () => {
    // Also re-pointed off `measured_zs_ohm` — same reason as above.
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'r1_r2_ohm', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.circuits![0].r1_r2_ohm).toBe('0.42');
  });

  it('clamps ring continuity readings (ring_r1_ohm, ring_rn_ohm, ring_r2_ohm)', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Ring' };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      readings: [
        { circuit: 1, field: 'ring_r1_ohm', value: '12' }, // ÷10 → 1.2
        { circuit: 1, field: 'ring_rn_ohm', value: '13' }, // ÷10 → 1.3
        { circuit: 1, field: 'ring_r2_ohm', value: '21' }, // ÷10 → 2.1 -> OUT, ÷100 → 0.21 ✓
      ],
    });
    const applied = applyExtractionToJob(job, result);
    const cell = applied!.patch.circuits![0];
    expect(cell.ring_r1_ohm).toBe('1.2');
    expect(cell.ring_rn_ohm).toBe('1.3');
    expect(cell.ring_r2_ohm).toBe('0.21');
  });
});
