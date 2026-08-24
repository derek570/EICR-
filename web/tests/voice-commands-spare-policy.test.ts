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
import {
  applyVoiceCommand,
  parseVoiceCommand,
  DEVICE_ATTRIBUTE_FIELDS,
  type VoiceCommandJob,
} from '@certmate/shared-utils';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

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

  // Codex diff-review r1 (silent-path lens) — "not including spares" used
  // to match BOTH the include AND exclude regexes (the exclude alternation
  // includes "not including", but that phrase also contains the bare
  // substring "including spares"), so a single exclude-shaped instruction
  // was misclassified as a self-contradiction and silently refused.
  it('"not including spares" is exclude, NOT a false contradiction', () => {
    const cmd = parseVoiceCommand('rcd type AC for all circuits not including spares');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'rcd type',
      value: 'ac',
      scope: { kind: 'all' },
      sparePolicy: 'exclude',
    });
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

// PLAN-C (feedback id 129) — `rcd_type` is one of the six closed-enum
// fields. The parser lowercases the whole transcript, so the applier used
// to STORE the lowercase residue "ac"; the guard's canonical-casing snap
// now writes the schema option "AC" instead, and (per Audio-First §1) the
// spoken confirmation reads back the stored value, not the heard one.
// Those two facts are what changed in the expectations below — the spare
// policy semantics this file exists to pin are untouched.
describe('applyVoiceCommand — spare_policy truth table, device-attribute field (rcd_type)', () => {
  it('omitted (automatic) → include (spares written)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.rcd_type === 'AC')).toBe(true);
    expect(out.response).toBe('Set RCD type to AC for 4 circuits.');
  });

  it('explicit "including spares" → include', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits including spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.rcd_type === 'AC')).toBe(true);
  });

  it('explicit "excluding spares" → exclude, even on a device-attribute field', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
    const cmd = parseVoiceCommand('rcd type AC for all circuits excluding spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated[0].rcd_type).toBe('AC');
    expect(updated[1].rcd_type).toBe('AC');
    expect(updated[2].rcd_type).toBeUndefined();
    expect(out.response).toBe('Set RCD type to AC for 2 circuits, skipping 1 spare way.');
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
  it('all targets spare under an exclude policy → "No non-spare circuits were updated; skipped N spare ways."', () => {
    const job = jobWithCircuits([SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe('No non-spare circuits were updated; skipped 2 spare ways.');
  });

  it('exactly 1 spare skipped, zero applied → singular wording', () => {
    const job = jobWithCircuits([SPARE_NAMED]);
    const cmd = parseVoiceCommand('test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('No non-spare circuits were updated; skipped 1 spare way.');
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
  // PLAN-C — the two `..._bs_en` fields are closed-enum guarded, so the
  // placeholder value now has to be a real standard. A bare code is used
  // rather than the full "BS EN 61009" phrasing because the longest-prefix
  // field matcher partially re-consumes a value that echoes the field
  // phrase; the guard canonicalises the bare code back to the full option,
  // which is the ingress this plan is actually about.
  it.each([
    ['ocpd bs en', 'ocpd_bs_en', '60898', 'BS EN 60898'],
    ['ocpd breaking capacity', 'ocpd_breaking_capacity_ka', 'sixtyone', 'sixtyone'],
    ['ocpd max zs', 'ocpd_max_zs_ohm', 'sixtyone', 'sixtyone'],
    ['rcd bs en', 'rcd_bs_en', '61008', 'BS EN 61008'],
  ])(
    '"%s" maps to circuit field %s and includes spares by default',
    (phrase, canonical, spoken, stored) => {
      const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
      const cmd = parseVoiceCommand(`${phrase} ${spoken} for all circuits`)!;
      expect(cmd).not.toBeNull();
      const out = applyVoiceCommand(cmd, job);
      const updated = out.patch?.circuits as Array<Record<string, unknown>>;
      expect(updated.every((r) => r[canonical] === stored)).toBe(true);
    }
  );
});

// Codex diff-review r1 (wire-contract + edge-interactions lenses) — the
// plan requires one write-and-read-back test PER FIELD in the closed
// 8-field list, not just the 4 fields this plan newly added aliases for.
describe('all 8 DEVICE_ATTRIBUTE_FIELDS — write-and-read-back, spares included by default', () => {
  // PLAN-C — four of these eight are closed-enum guarded and take a
  // schema-valid dictated value; the other four keep the "nineteen"
  // placeholder, which proves the guard leaves unguarded fields alone.
  it.each([
    ['ocpd bs en', 'ocpd_bs_en', '60898', 'BS EN 60898'],
    ['ocpd type', 'ocpd_type', 'B', 'B'],
    ['ocpd rating', 'ocpd_rating_a', 'nineteen', 'nineteen'],
    ['ocpd breaking capacity', 'ocpd_breaking_capacity_ka', 'nineteen', 'nineteen'],
    ['ocpd max zs', 'ocpd_max_zs_ohm', 'nineteen', 'nineteen'],
    ['rcd bs en', 'rcd_bs_en', '61008', 'BS EN 61008'],
    ['rcd type', 'rcd_type', 'AC', 'AC'],
    ['rcd operating current', 'rcd_operating_current_ma', 'nineteen', 'nineteen'],
  ])(
    '"%s" (%s) writes to every circuit incl. the spare, response names the count',
    (phrase, canonical, spoken, stored) => {
      const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK]);
      const cmd = parseVoiceCommand(`${phrase} ${spoken} for all circuits`)!;
      expect(cmd).not.toBeNull();
      const out = applyVoiceCommand(cmd, job);
      const updated = out.patch?.circuits as Array<Record<string, unknown>>;
      expect(updated).toHaveLength(3);
      expect(updated.every((r) => r[canonical] === stored)).toBe(true);
      expect(out.response).toContain('for 3 circuits');
      expect(out.response).not.toContain('spare');
    }
  );
});

// Codex diff-review r1 (finding D) — the classifier is a hand-written
// 8-field Set; nothing proved it tracks the live schema. Compare it
// directly against config/field_schema.json's OCPD∪RCD union so a
// future field-schema edit that forgets this Set fails a test, not a
// field session.
describe('DEVICE_ATTRIBUTE_FIELDS — live schema drift assertion', () => {
  it('equals the live OCPD+RCD union from config/field_schema.json', () => {
    const groups = (fieldSchema as { field_groups: Array<{ name: string; fields: string[] }> })
      .field_groups;
    const liveUnion = new Set(
      groups.filter((g) => g.name === 'OCPD' || g.name === 'RCD').flatMap((g) => g.fields)
    );
    expect(liveUnion.size).toBeGreaterThan(0);
    expect(DEVICE_ATTRIBUTE_FIELDS).toEqual(liveUnion);
  });
});

/**
 * PLAN-F2 finding 2 (2026-08-14, Derek decision 1) — range/single scope now
 * COMPOSES with a spoken spare_policy modifier, instead of ignoring it.
 * Modifier ABSENT keeps today's behaviour (explicitly-named circuits are
 * never spare-filtered); modifier PRESENT ('exclude') filters + discloses.
 */
describe('range/single scope composes with a spoken spare_policy modifier', () => {
  it('MODIFIER ABSENT: "circuits 1 to 4" with a spare inside still writes ALL of them (unchanged default)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for circuits 1 to 4')!;
    expect(cmd.scope).toEqual({ kind: 'range', from: 1, to: 4 });
    expect(cmd.sparePolicy).toBeUndefined();
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.filter((r) => r.rcd_type === 'AC')).toHaveLength(4);
    expect(out.response).toContain('for 4 circuits');
    expect(out.response).not.toContain('spare');
  });

  it('Codex diff-review cycle 2 — the PLAN\'S OWN comma-bearing phrasing ("circuits 3 to 5, excluding spares") parses and composes, not just the no-comma form', () => {
    // A stray comma left over after modifier-stripping used to break the
    // anchored shape regex, silently deferring to Sonnet instead of
    // composing locally — the exact worked example Decision 1 quotes.
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for circuits 1 to 4, excluding spares')!;
    expect(cmd).not.toBeNull();
    expect(cmd.scope).toEqual({ kind: 'range', from: 1, to: 4 });
    expect(cmd.sparePolicy).toBe('exclude');
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.filter((r) => r.rcd_type === 'AC')).toHaveLength(2);
    expect(out.response).toContain(', skipping 2 spare ways.');
  });

  it('MODIFIER PRESENT (exclude): "circuits 1 to 4 excluding spares" filters the spares out AND discloses the skip', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_BLANK, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for circuits 1 to 4 excluding spares')!;
    expect(cmd.scope).toEqual({ kind: 'range', from: 1, to: 4 });
    expect(cmd.sparePolicy).toBe('exclude');
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    // Only the two REAL circuits (1, 2) got written; the two spares (3, 4)
    // did not.
    expect(updated.filter((r) => r.rcd_type === 'AC')).toHaveLength(2);
    expect(updated.find((r) => r.circuit_ref === '3')?.rcd_type).toBeUndefined();
    expect(updated.find((r) => r.circuit_ref === '4')?.rcd_type).toBeUndefined();
    expect(out.response).toContain('for 2 circuits');
    expect(out.response).toContain(', skipping 2 spare ways.');
  });

  it('MODIFIER PRESENT (include) on a range with NO spares: harmless no-op, no disclosure', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS]);
    const cmd = parseVoiceCommand('rcd type AC for circuits 1 to 2 including spares')!;
    expect(cmd.sparePolicy).toBe('include');
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.filter((r) => r.rcd_type === 'AC')).toHaveLength(2);
    expect(out.response).not.toContain('spare');
  });

  it('SINGLE circuit, explicitly a spare, excluding spares → zero-applied standalone disclosure (no "circuit not found" collision)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for circuit 4 excluding spares')!;
    expect(cmd.scope).toEqual({ kind: 'single', circuit: 4 });
    expect(cmd.sparePolicy).toBe('exclude');
    const out = applyVoiceCommand(cmd, job);
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe('No non-spare circuits were updated; skipped 1 spare way.');
  });

  it('SINGLE circuit, NOT a spare, excluding spares → writes normally (the modifier only filters, never blocks a real circuit)', () => {
    const job = jobWithCircuits([...REAL_CIRCUITS, SPARE_NAMED]);
    const cmd = parseVoiceCommand('rcd type AC for circuit 1 excluding spares')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.find((r) => r.circuit_ref === '1')?.rcd_type).toBe('AC');
    expect(out.response).not.toContain('spare');
  });
});
