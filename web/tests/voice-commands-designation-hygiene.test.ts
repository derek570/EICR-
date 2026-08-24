/**
 * PLAN-B2 (B2-2, web voice boundaries) — designation hygiene in the
 * shared voice-command appliers.
 *
 * Contract under test: a designation value is canonicalised ONCE at
 * command entry (repair semantics — never reject, never blank) and the
 * SAME canonical value reaches BOTH the mutation and the spoken
 * response. Cleaned storage + raw speech is still a failure: the
 * hands-free inspector would hear a value the certificate doesn't carry.
 */

import { describe, expect, it } from 'vitest';

import { applyVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

const job = (): VoiceCommandJob => ({
  supply: {},
  circuits: [
    { id: 'c1', circuit_ref: '1', number: '1', circuit_designation: 'Cooker' },
    { id: 'c2', circuit_ref: '2', number: '2', circuit_designation: 'Sockets' },
  ],
});

describe('applyUpdateField — circuit_designation hygiene', () => {
  it('strips a trailing "circuit" from storage AND speech', () => {
    const outcome = applyVoiceCommand(
      {
        type: 'update_field',
        field: 'designation',
        value: 'Upstairs lighting circuit',
        circuit: 1,
      },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Upstairs lighting');
    expect(outcome.response).toBe('Set designation to Upstairs lighting on circuit 1.');
    expect(outcome.response).not.toMatch(/circuit\./i);
  });

  it('leaves a banned-token-only designation unchanged (spare hazard) in storage and speech', () => {
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'designation', value: 'Circuit', circuit: 2 },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[1].circuit_designation).toBe('Circuit');
    expect(outcome.response).toBe('Set designation to Circuit on circuit 2.');
  });

  it('keeps interior tokens and hyphen compounds untouched', () => {
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'designation', value: 'Ring circuit sockets', circuit: 1 },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Ring circuit sockets');
  });

  it('non-designation fields are untouched by the hygiene path', () => {
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'zs', value: '0.35', circuit: 1 },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].measured_zs_ohm).toBe('0.35');
    expect(outcome.response).toBe('Set Zs to 0.35 on circuit 1.');
  });
});

describe('applyApplyField — circuit_designation hygiene across bulk scope', () => {
  it('canonical value fans across the scope and is spoken once, canonically', () => {
    const outcome = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'designation',
        value: 'Circuit kitchen ring',
        scope: { kind: 'range', from: 1, to: 2 },
      },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('kitchen ring');
    expect(rows[1].circuit_designation).toBe('kitchen ring');
    expect(outcome.response).toBe('Set designation to kitchen ring for 2 circuits.');
  });

  it('banned-token-only value applies unchanged (never blanked to spare)', () => {
    const outcome = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'designation',
        value: 'circuits',
        scope: { kind: 'single', circuit: 1 },
      },
      job()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('circuits');
    expect(outcome.response).toBe('Set designation to circuits for 1 circuit.');
  });
});
