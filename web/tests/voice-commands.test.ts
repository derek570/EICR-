/**
 * Voice command parser + applier — iOS-parity tests.
 *
 * Pins the iOS-canon shapes the inspector dictates today:
 *   - "calculate Zs for circuit 3"
 *   - "calculate R1+R2 for all circuits"
 *   - "RCD test button correct for all circuits"
 *   - "set polarity to pass for circuits 1 to 4"
 *
 * Mirrors VoiceCommandExecutor.swift:314 (executeCalculateImpedance) and
 * line 399 (executeApplyField). Pinning the spoken-response phrasing
 * here as well so a future port doesn't drift away from "Done.
 * Calculated Zs for 3 circuits." which is what iOS speaks.
 */

import { describe, it, expect } from 'vitest';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

const jobWithCircuits = (
  ze: string | undefined,
  rows: Array<Record<string, unknown>>
): VoiceCommandJob => ({
  supply: ze != null ? { ze } : {},
  circuits: rows,
});

describe('parseVoiceCommand — calculate_impedance', () => {
  it('parses "calculate Zs for circuit 3"', () => {
    const cmd = parseVoiceCommand('calculate Zs for circuit 3');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'single', circuit: 3 },
    });
  });

  it('parses "calculate R1+R2 for all circuits"', () => {
    const cmd = parseVoiceCommand('calculate R1+R2 for all circuits');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'r1_r2',
      scope: { kind: 'all' },
    });
  });

  it('parses "calculate Zs for circuits 2 to 5" (range)', () => {
    const cmd = parseVoiceCommand('calculate Zs for circuits 2 to 5');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'range', from: 2, to: 5 },
    });
  });

  it('accepts "calculate impedance" as Zs (trade vernacular)', () => {
    const cmd = parseVoiceCommand('calculate impedance for circuit 1');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'single', circuit: 1 },
    });
  });

  it('accepts "R1 plus R2" longhand', () => {
    const cmd = parseVoiceCommand('calculate R1 plus R2 for all');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'r1_r2',
      scope: { kind: 'all' },
    });
  });

  it('refuses "calculate Zs" with no scope (ambiguous — iOS canon)', () => {
    expect(parseVoiceCommand('calculate Zs')).toBeNull();
  });
});

describe('applyVoiceCommand — calculate_impedance', () => {
  it('Zs = Ze + R1+R2 for a single circuit', () => {
    const job = jobWithCircuits('0.35', [
      { id: 'c1', circuit_ref: '1', r1_r2_ohm: '0.45' },
      { id: 'c2', circuit_ref: '2', r1_r2_ohm: '0.60' },
    ]);
    const cmd = parseVoiceCommand('calculate Zs for circuit 1')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Done. Calculated Zs for 1 circuit.');
    const next = (out.patch?.circuits as Array<Record<string, unknown>>)[0];
    expect(next.measured_zs_ohm).toBe('0.80');
  });

  it('Zs across all circuits — pluralised response', () => {
    const job = jobWithCircuits('0.35', [
      { id: 'c1', circuit_ref: '1', r1_r2_ohm: '0.45' },
      { id: 'c2', circuit_ref: '2', r1_r2_ohm: '0.60' },
      { id: 'c3', circuit_ref: '3', r1_r2_ohm: '0.20' },
    ]);
    const cmd = parseVoiceCommand('calculate Zs for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Done. Calculated Zs for 3 circuits.');
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.map((r) => r.measured_zs_ohm)).toEqual(['0.80', '0.95', '0.55']);
  });

  it('R1+R2 = Zs - Ze, skips circuits without Zs', () => {
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1', measured_zs_ohm: '0.55' },
      { id: 'c2', circuit_ref: '2' /* no Zs */ },
    ]);
    const cmd = parseVoiceCommand('calculate R1+R2 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Done. Calculated R1 plus R2 for 1 circuit.');
    const next = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(next[0].r1_r2_ohm).toBe('0.45');
    expect(next[1].r1_r2_ohm).toBeUndefined();
  });

  it('refuses gracefully when Ze is unset', () => {
    const job = jobWithCircuits(undefined, [{ id: 'c1', circuit_ref: '1', r1_r2_ohm: '0.45' }]);
    const cmd = parseVoiceCommand('calculate Zs for circuit 1')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toContain('zed E value');
    expect(out.patch).toBeUndefined();
  });

  it('reports zero updates when no circuits have the input', () => {
    const job = jobWithCircuits('0.35', [{ id: 'c1', circuit_ref: '1' /* no R1+R2 */ }]);
    const cmd = parseVoiceCommand('calculate Zs for all')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('No circuits had the values needed to calculate Zs.');
  });
});

describe('parseVoiceCommand — apply_field', () => {
  it('parses "RCD test button correct for all circuits"', () => {
    const cmd = parseVoiceCommand('RCD test button correct for all circuits');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'rcd test button',
      value: 'correct',
      scope: { kind: 'all' },
    });
  });

  it('parses "polarity pass for circuits 1 to 4" (range)', () => {
    const cmd = parseVoiceCommand('polarity pass for circuits 1 to 4');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'polarity',
      value: 'PASS',
      scope: { kind: 'range', from: 1, to: 4 },
    });
  });

  it('parses Deepgram garble: "test voltage for all circuits is 250 volts"', () => {
    const cmd = parseVoiceCommand('test voltage for all circuits is 250 volts');
    expect(cmd).toEqual({
      type: 'apply_field',
      field: 'test voltage',
      value: '250',
      scope: { kind: 'all' },
    });
  });
});

describe('applyVoiceCommand — apply_field', () => {
  it('writes the value to every circuit in scope; pluralises response', () => {
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1' },
      { id: 'c2', circuit_ref: '2' },
      { id: 'c3', circuit_ref: '3' },
    ]);
    const cmd = parseVoiceCommand('insulation test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Set insulation test voltage to 250 for 3 circuits.');
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.ir_test_voltage_v === '250')).toBe(true);
  });

  it('normalises pass/fail for polarity to ✓ / ✗ across the scope', () => {
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1' },
      { id: 'c2', circuit_ref: '2' },
    ]);
    const cmd = parseVoiceCommand('polarity pass for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.polarity_confirmed === '✓')).toBe(true);
  });

  it('returns null for an unrecognised phrase (Sonnet handles freeform)', () => {
    // iOS canon: unrecognised intents fall through to Sonnet via the
    // server-side path. The PWA's parser deliberately returns null
    // rather than synthesising an error response so the transcript
    // routes through to Sonnet for natural-language interpretation.
    expect(parseVoiceCommand('quibble nonsense for all circuits')).toBeNull();
  });
});

describe('field-alias coverage (iOS parity)', () => {
  // The audit found the PWA's pre-fix vocabulary covered ~15 fields
  // vs iOS ~40. These tests pin the additional aliases we now accept,
  // matching VoiceCommandExecutor.swift:setCircuitField (lines 207–256).
  it.each([
    ['cpc size', 'cpc_csa_mm2'],
    ['rcd rating', 'rcd_rating_a'],
    ['rcd type', 'rcd_type'],
    ['rcd operating current', 'rcd_operating_current_ma'],
    ['rcd test button', 'rcd_button_confirmed'],
    ['afdd test button', 'afdd_button_confirmed'],
    ['wiring type', 'wiring_type'],
    ['ref method', 'ref_method'],
    ['disconnect time', 'max_disconnect_time_s'],
    ['number of points', 'number_of_points'],
    ['test voltage', 'ir_test_voltage_v'],
  ])('"%s" maps to circuit field %s', (phrase, canonical) => {
    const cmd = parseVoiceCommand(`set ${phrase} to 30 on circuit 1`);
    expect(cmd).toEqual({
      type: 'update_field',
      field: phrase,
      value: '30',
      circuit: 1,
    });
    // resolveField is internal — we exercise it via the applier.
    const out = applyVoiceCommand(cmd!, {
      circuits: [{ id: 'c1', circuit_ref: '1' }],
    });
    const next = (out.patch?.circuits as Array<Record<string, unknown>>)[0];
    expect(next[canonical]).toBeDefined();
  });
});
