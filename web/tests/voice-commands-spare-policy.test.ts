/**
 * voice-commands-spare-policy.test.ts
 *
 * PLAN-F item 1 (2026-08-12, feedback id 115) — spares in bulk apply, web
 * half. Mirrors the backend's spare_policy truth table + Decision 4
 * audible-skip disclosure. Field fact: "RCD type for all circuits is AC"
 * previously updated every circuit on web INCLUDING spares silently
 * (web's baseline was "skips nothing" — the opposite direction from
 * iOS/backend's "always skips"); this now resolves through the same
 * family-aware automatic default, with the explicit include/exclude
 * modifier honoured and disclosed audibly either way.
 */

import { describe, it, expect } from 'vitest';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

const jobWithCircuits = (rows: Array<Record<string, unknown>>): VoiceCommandJob => ({
  supply: {},
  circuits: rows,
});

const REAL_CIRCUITS = [
  { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' },
  { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
];
const SPARE_BLANK = { id: 'c3', circuit_ref: '3', circuit_designation: '' };
const SPARE_NAMED = { id: 'c4', circuit_ref: '4', circuit_designation: 'Spare' };

describe('parseVoiceCommand — sparePolicy modifiers', () => {
  it('"including spares" attaches sparePolicy: "include"', () => {
    const cmd = parseVoiceCommand('rcd type AC for all circuits including spares');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'rcd type',
      value: 'ac',
      scope: { kind: 'all' },
      sparePolicy: 'include',
    });
  });

  it('"excluding spares" attaches sparePolicy: "exclude"', () => {
    const cmd = parseVoiceCommand('test voltage 250 for all circuits excluding spares');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'test voltage',
      value: '250',
      scope: { kind: 'all' },
      sparePolicy: 'exclude',
    });
  });

  it('"except spares" also attaches sparePolicy: "exclude"', () => {
    const cmd = parseVoiceCommand('rcd type AC for all circuits except spares');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'rcd type',
      value: 'ac',
      scope: { kind: 'all' },
      sparePolicy: 'exclude',
    });
  });

  it('no modifier → sparePolicy is undefined (automatic)', () => {
    const cmd = parseVoiceCommand('rcd type AC for all circuits');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'rcd type',
      value: 'ac',
      scope: { kind: 'all' },
    });
  });

  it('contradictory modifiers ("including spares" + "excluding spares") → apply_field_contradiction', () => {
    const cmd = parseVoiceCommand(
      'rcd type AC for all circuits including spares but excluding spares'
    );
    expect(cmd).toEqual({ type: 'apply_field_contradiction' });
  });
});

describe('applyVoiceCommand — apply_field_contradiction (local-consumed refusal)', () => {
  it('speaks a deterministic refusal with NO patch (never forwarded, nothing mutates)', () => {
    const job = jobWithCircuits(REAL_CIRCUITS);
    const cmd = parseVoiceCommand(
      'rcd type AC for all circuits including spares but excluding spares'
    )!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.patch).toBeUndefined();
    expect(out.response).toContain('contradictory');
  });
});

describe('applyVoiceCommand — spare_policy truth table, device-attribute field (rcd_type)', () => {
  it('omitted (automatic) → include (spares written)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.rcd_type === 'ac')).toBe(true);
    expect(out.response).toBe('Set RCD type to ac for 4 circuits.');
  });

  it('explicit "including spares" → include', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits including spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.rcd_type === 'ac')).toBe(true);
  });

  it('explicit "excluding spares" → exclude, even on a device-attribute field', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits excluding spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[0].rcd_type).toBe('ac');
    expect(updated[1].rcd_type).toBe('ac');
    expect(updated[2].rcd_type).toBeUndefined();
    expect(out.response).toBe('Set RCD type to ac for 2 circuits, skipping 1 spare way.');
  });
});

describe('applyVoiceCommand — spare_policy truth table, reading field (test voltage)', () => {
  it('omitted (automatic) → exclude (spares skipped)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[0].ir_test_voltage_v).toBe('250');
    expect(updated[1].ir_test_voltage_v).toBe('250');
    expect(updated[2].ir_test_voltage_v).toBeUndefined();
    expect(updated[3].ir_test_voltage_v).toBeUndefined();
    expect(out.response).toBe(
      'Set insulation test voltage to 250 for 2 circuits, skipping 2 spare ways.'
    );
  });

  it('explicit "including spares" on a reading field → include (spares get the readingless write too)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits including spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.ir_test_voltage_v === '250')).toBe(true);
  });
});

describe('applyVoiceCommand — zero-applied Decision 4 wording (exact match across implementations)', () => {
  it('all targets spare under an exclude policy → "No non-spare circuits were updated; skipping N spare ways."', () => {
    const job = jobWithCircuits([SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe('No non-spare circuits were updated; skipping 2 spare ways.');
  });

  it('exactly 1 spare skipped, zero applied → singular wording', () => {
    const job = jobWithCircuits([SPARE_NAMED]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('No non-spare circuits were updated; skipping 1 spare way.');
  });
});

describe('spare designation predicate — unified regex semantics ("Spare way", blank, "non-spare")', () => {
  it('"Spare way" (word-boundary match) is classified as spare', () => {
    const job = jobWithCircuits([
      ...REAL_CIRCUITS,
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Spare way' },
    ]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[2].ir_test_voltage_v).toBeUndefined();
  });

  it('"Non-spare backup" is NOT classified as spare (negative lookbehind)', () => {
    const job = jobWithCircuits([
      ...REAL_CIRCUITS,
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Non-spare backup' },
    ]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[2].ir_test_voltage_v).toBe('250');
  });
});

describe('calculate-impedance scope — unaffected by this plan (always spare-excluded)', () => {
  it('calculate Zs for all circuits still computes only on non-spare rows', () => {
    const job: VoiceCommandJob = {
      supply: { ze: '0.35' },
      circuits: [
        { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker', r1_r2_ohm: '0.45' },
        { id: 'c2', circuit_ref: '2', circuit_designation: '', r1_r2_ohm: '0.60' },
      ],
    };
    const cmd = parseVoiceCommand('calculate Zs for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Done. Calculated Zs for 1 circuit.');
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[0].measured_zs_ohm).toBe('0.80');
    expect(updated[1].measured_zs_ohm).toBeUndefined();
  });
});

describe('BS/EN field aliases (web previously had none)', () => {
  it.each([
    ['ocpd bs en', 'ocpd_bs_en'],
    ['ocpd breaking capacity', 'ocpd_breaking_capacity_ka'],
    ['ocpd max zs', 'ocpd_max_zs_ohm'],
    ['rcd bs en', 'rcd_bs_en'],
  ])('"%s" maps to circuit field %s and includes spares by default', (phrase, canonical) => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    // Value deliberately doesn't echo any word from the field phrase
    // itself (a prior version used "BS EN 61009" as the value for the
    // "...bs en" fields, which the longest-prefix field matcher
    // partially re-consumed as part of the field phrase).
    const cmd = parseVoiceCommand(`${phrase} sixtyone for all circuits`)!;
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r[canonical] === 'sixtyone')).toBe(true);
  });
});
