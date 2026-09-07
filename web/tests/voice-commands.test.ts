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
 * here as well so a future port cannot regress to a count-only success.
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
    expect(out.response).toBe('Circuit 1, Zs calculated as 0.80 ohms');
    expect(out.actionOutcome).toBe('applied');
    expect(out.appliedResults).toEqual([{ circuit: '1', field: 'measured_zs_ohm', value: '0.80' }]);
    const next = (out.patch?.circuits as Array<Record<string, unknown>>)[0];
    expect(next.measured_zs_ohm).toBe('0.80');
  });

  it('Zs across all circuits reads back each distinct applied value', () => {
    // PLAN-F item 1 (2026-08-12, feedback id 115) — circuit_designation is
    // now the spare-classification signal (blank = spare); these are real
    // circuits under test, so they carry a non-spare designation.
    const job = jobWithCircuits('0.35', [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker', r1_r2_ohm: '0.45' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets', r1_r2_ohm: '0.60' },
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Lights', r1_r2_ohm: '0.20' },
    ]);
    const cmd = parseVoiceCommand('calculate Zs for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe(
      'Circuit 1, Zs calculated as 0.80 ohms. Circuit 2, Zs calculated as 0.95 ohms. Circuit 3, Zs calculated as 0.55 ohms'
    );
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.map((r) => r.measured_zs_ohm)).toEqual(['0.80', '0.95', '0.55']);
  });

  it('R1+R2 = Zs - Ze, skips circuits without Zs', () => {
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker', measured_zs_ohm: '0.55' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' /* no Zs */ },
    ]);
    const cmd = parseVoiceCommand('calculate R1+R2 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Circuit 1, R1 plus R2 calculated as 0.45 ohms');
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
    expect(out.actionOutcome).toBe('unsupported');
  });

  it('reports zero updates when no circuits have the input', () => {
    const job = jobWithCircuits('0.35', [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' /* no R1+R2 */ },
    ]);
    const cmd = parseVoiceCommand('calculate Zs for all')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('No circuits had the values needed to calculate Zs.');
    expect(out.actionOutcome).toBe('unapplied');
  });

  it('groups only identical calculated values under their exact circuits', () => {
    const job = jobWithCircuits('0.35', [
      { circuit_ref: '2', circuit_designation: 'Sockets', r1_r2_ohm: '0.45' },
      { circuit_ref: '4', circuit_designation: 'Lights', r1_r2_ohm: '0.45' },
      { circuit_ref: '7', circuit_designation: 'Cooker', r1_r2_ohm: '0.20' },
    ]);
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all circuits')!, job);
    expect(out.response).toBe(
      'Circuits 2 and 4, Zs calculated as 0.80 ohms. Circuit 7, Zs calculated as 0.55 ohms'
    );
  });

  it('returns typed unsupported for an unreadable Ze carrier', () => {
    const job = jobWithCircuits('recorded-but-unreadable', [
      { circuit_ref: '1', circuit_designation: 'Sockets', r1_r2_ohm: '0.45' },
    ]);
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for circuit 1')!, job);
    expect(out).toMatchObject({
      response: 'I couldn’t apply that calculation.',
      actionOutcome: 'unsupported',
      actionReason: 'ze_unreadable',
    });
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
    // ir_test_voltage_v is a reading field (not device-attribute), so the
    // automatic default excludes spares — these are real circuits under
    // test, so they carry a non-spare designation.
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
      { id: 'c3', circuit_ref: '3', circuit_designation: 'Lights' },
    ]);
    const cmd = parseVoiceCommand('insulation test voltage 250 for all circuits')!;
    const out = applyVoiceCommand(cmd, job);
    expect(out.response).toBe('Set insulation test voltage to 250 for 3 circuits.');
    const updated = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(updated.every((r) => r.ir_test_voltage_v === '250')).toBe(true);
  });

  it('normalises pass/fail for polarity to ✓ / ✗ across the scope', () => {
    const job = jobWithCircuits('0.10', [
      { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' },
      { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
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
  // vs iOS ~40. These tests pin the additional aliases the applier
  // resolves, matching VoiceCommandExecutor.swift:setCircuitField
  // (lines 207–256). Commands of this shape now arrive via the server
  // (Sonnet's `voice_command_response`) rather than the client parser
  // — iOS canon. We construct the `update_field` command directly to
  // exercise the alias resolution.
  //
  // PLAN-C (feedback id 129): the three closed-enum aliases in this table
  // now carry a schema-VALID value. "30" was only ever a placeholder to
  // prove the alias resolved, but it is not a member of `rcd_type` /
  // `wiring_type` / `ref_method`, and the closed-enum guard rejects it —
  // correctly, and exactly as it would have rejected the Flux garble this
  // plan exists to stop. The alias assertion is unchanged; only the
  // placeholder became a legal value for the field it is written to.
  it.each([
    ['cpc size', 'cpc_csa_mm2', '30'],
    ['rcd rating', 'rcd_rating_a', '30'],
    ['rcd type', 'rcd_type', 'AC'],
    ['rcd operating current', 'rcd_operating_current_ma', '30'],
    ['rcd test button', 'rcd_button_confirmed', '30'],
    ['afdd test button', 'afdd_button_confirmed', '30'],
    ['wiring type', 'wiring_type', 'A'],
    ['ref method', 'ref_method', 'C'],
    ['disconnect time', 'max_disconnect_time_s', '30'],
    ['number of points', 'number_of_points', '30'],
    ['test voltage', 'ir_test_voltage_v', '30'],
  ])('"%s" maps to circuit field %s', (phrase, canonical, value) => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: phrase, value, circuit: 1 },
      { circuits: [{ id: 'c1', circuit_ref: '1' }] }
    );
    const next = (out.patch?.circuits as Array<Record<string, unknown>>)[0];
    expect(next[canonical]).toBeDefined();
  });
});
