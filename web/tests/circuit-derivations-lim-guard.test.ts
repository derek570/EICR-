/**
 * P3 (2026-07-23, feedback id 86) — identity-derivation sentinel guard.
 *
 * recompute/recomputeAll parsed a non-numeric sentinel (e.g. "LIM") as null and
 * treated the target as BLANK, fabricating a derived value over an explicit
 * limitation — silently reversing the spoken read-back (Audio-First #2). Because
 * recomputeAll runs job-wide on every apply, the next dictated reading on ANY
 * circuit would clobber it. This pins the sentinel-aware guard on all THREE
 * targets (Zs / R1+R2 / Ze) and the recomputeAll no-spurious-filled_ze-change
 * rule, plus TS↔backend sentinel-set parity.
 */
import { describe, expect, it } from 'vitest';
import { recompute, recomputeAll, DERIVATION_SENTINELS } from '@certmate/shared-utils';
// Backend source of truth for the sentinel set (test-only import — no
// production dependency edge; shared-utils inlines its own copy).
import { STAGE6_VALUE_RULES } from '../../src/extraction/value-normalise.js';

describe('recompute — sentinel guard (P3)', () => {
  it('LIM Zs + numeric Ze/R1+R2 → no_change (does NOT fabricate Zs over LIM)', () => {
    const circuit = { measured_zs_ohm: 'LIM', r1_r2_ohm: '0.5' };
    const outcome = recompute(circuit, '0.35');
    expect(outcome.kind).toBe('no_change');
    expect(circuit.measured_zs_ohm).toBe('LIM'); // preserved
  });

  it('numeric Zs/Ze but LIM R1+R2 → no_change (does NOT fabricate R1+R2 over LIM)', () => {
    const circuit = { measured_zs_ohm: '1.0', r1_r2_ohm: 'LIM' };
    const outcome = recompute(circuit, '0.35');
    expect(outcome.kind).toBe('no_change');
    expect(circuit.r1_r2_ohm).toBe('LIM');
  });

  it('LIM Ze parameter + numeric Zs/R1+R2 → no_change (does NOT fabricate Ze)', () => {
    const circuit = { measured_zs_ohm: '1.0', r1_r2_ohm: '0.5' };
    const outcome = recompute(circuit, 'LIM');
    expect(outcome.kind).toBe('no_change');
  });

  it('other sentinels (N/A, ∞, inf) also block fabrication', () => {
    for (const s of ['N/A', 'n/a', '∞', 'inf', 'infinity', 'na']) {
      const c = { measured_zs_ohm: s, r1_r2_ohm: '0.5' };
      expect(recompute(c, '0.35').kind).toBe('no_change');
      expect(c.measured_zs_ohm).toBe(s);
    }
  });

  it('still derives normally when the target is genuinely blank', () => {
    const circuit = { measured_zs_ohm: '', r1_r2_ohm: '0.5' };
    const outcome = recompute(circuit, '0.35');
    expect(outcome.kind).toBe('filled_zs');
    expect(circuit.measured_zs_ohm).toBe('0.85');
  });
});

describe('recomputeAll — LIM preserved job-wide (P3)', () => {
  it('a LIM Zs is not clobbered when another circuit gets a reading', () => {
    const job = {
      supply_characteristics: { earth_loop_impedance_ze: '0.35' },
      circuits: [
        { measured_zs_ohm: 'LIM', r1_r2_ohm: '0.5' },
        { measured_zs_ohm: '', r1_r2_ohm: '0.5' },
      ],
    };
    const next = recomputeAll(job);
    // Circuit 2 fills; circuit 1's LIM stays.
    expect(next).not.toBeNull();
    expect((next as Array<Record<string, unknown>>)[0].measured_zs_ohm).toBe('LIM');
    expect((next as Array<Record<string, unknown>>)[1].measured_zs_ohm).toBe('0.85');
  });

  it('board.ze = LIM → recompute no_change AND recomputeAll returns null (no row change)', () => {
    const job = {
      boards: [{ id: 'b1', ze: 'LIM' }],
      circuits: [{ board_id: 'b1', measured_zs_ohm: '1.0', r1_r2_ohm: '0.5' }],
    };
    // No blank target to fill and Ze is a sentinel → nothing to do → null.
    expect(recomputeAll(job)).toBeNull();
  });

  it('a filled_ze-only pass reports NO row change (caller-owned)', () => {
    // Zs and R1+R2 numeric, Ze blank → recompute returns filled_ze but does not
    // mutate the row, so recomputeAll must return null.
    const job = {
      circuits: [{ measured_zs_ohm: '1.0', r1_r2_ohm: '0.4' }],
    };
    expect(recomputeAll(job)).toBeNull();
  });

  it('r1_r2_ohm = LIM is preserved through recomputeAll', () => {
    const job = {
      supply_characteristics: { earth_loop_impedance_ze: '0.35' },
      circuits: [{ measured_zs_ohm: '', r1_r2_ohm: 'LIM' }],
    };
    // Zs blank but R1+R2 is a sentinel → cannot derive Zs; nothing changes.
    expect(recomputeAll(job)).toBeNull();
  });
});

describe('sentinel-set parity (TS inlined ↔ backend VALID_SENTINELS)', () => {
  it('DERIVATION_SENTINELS matches the backend VALID_SENTINELS byte-for-byte', () => {
    expect([...DERIVATION_SENTINELS].sort()).toEqual(
      [...STAGE6_VALUE_RULES.VALID_SENTINELS].sort()
    );
  });
});
