/**
 * PLAN-C (feedback id 129) — the guard AT THE WRITE BOUNDARY.
 *
 * `closed-enum-guard.test.ts` pins the canonicaliser and the re-ask
 * renderer against the cross-platform fixture. This file pins the thing
 * the field session actually needed: that a garbled closed-enum value
 * mutates NOTHING, that the inspector hears one complete-restatement
 * re-ask, and that a legitimate alias is stored AND spoken canonically.
 *
 * Session 17821FFA is the provenance — a Flux garble put "for" into
 * `wiring_type` and "MCB" into `ocpd_bs_en`, both silently, in a
 * legally-significant certificate. Backend Stage-6 has rejected exactly
 * these for a long time (`stage6-dispatch-validation.js:99`/`:198`); the
 * two CLIENT mirrors did not.
 */

import { describe, expect, it } from 'vitest';

import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

const JOB: VoiceCommandJob = {
  circuits: [
    { id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' },
    { id: 'c2', circuit_ref: '2', circuit_designation: 'Ring final' },
    { id: 'c3', circuit_ref: '3', circuit_designation: 'Upstairs lighting' },
  ],
};

describe('closed-enum guard — single-circuit update_field', () => {
  it('a garbled value mutates NOTHING and re-asks once, naming the field, the value and the target', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'wiring_type', value: 'for', circuit: 1 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.changedKeys).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toBe(
      "I heard wiring type 'for', which isn't a valid code — say, for example, 'wiring type A for circuit 1'."
    );
  });

  it('a device CLASS dictated where a device STANDARD belongs is rejected, not stored', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: 'MCB', circuit: 2 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toContain("I heard OCPD BS EN 'MCB', which isn't a valid standard");
  });

  it('a near-miss standard is re-asked, never snapped onto its neighbour (Lev-1 NOT ported)', () => {
    // The backend parser's fuzzy fallback maps 1362 → BS 1361. On a client
    // that writes straight into the certificate, a silently-substituted
    // device standard is worse than an audible re-ask.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: '1362', circuit: 1 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
  });

  it('a valid alias is CANONICALISED, stored, and read back as stored', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: '60898', circuit: 1 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].ocpd_bs_en).toBe('BS EN 60898');
    expect(out.response).toBe('Set OCPD BS EN to BS EN 60898 on circuit 1.');
    expect(out.canonicalSuccess).toBe(true);
    expect(out.invalidClosedEnum).toBeUndefined();
  });

  it('a spoken cable description resolves to its schema code', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'wiring_type', value: 'twin and earth', circuit: 3 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[2].wiring_type).toBe('A');
    expect(out.canonicalSuccess).toBe(true);
  });

  it('an already-canonical value writes with NO canonical-success flag (nothing to disclose)', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'rcd_type', value: 'AC', circuit: 1 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].rcd_type).toBe('AC');
    expect(out.canonicalSuccess).toBeUndefined();
  });

  it('a structurally complete value with NO circuit re-asks for the target instead of writing nowhere', () => {
    const out = applyVoiceCommand({ type: 'update_field', field: 'rcd_type', value: 'AC' }, JOB);
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toBe(
      "I heard RCD type 'AC' but not which circuit — say, for example, 'RCD type AC for circuit 3'."
    );
  });

  it('an empty value is a missing_value re-ask, not a blanking write', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_type', value: '', circuit: 1 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toContain("I didn't get a value for OCPD type");
  });

  it('the guard runs BEFORE the circuit lookup — a bad value on a missing circuit re-asks about the VALUE', () => {
    // Both are wrong; the value is the one the inspector can fix by
    // repeating the instruction, and it is judged first.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'rcd_type', value: 'RCBO', circuit: 99 },
      JOB
    );
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toContain("I heard RCD type 'RCBO'");
  });

  it('unguarded fields are untouched by the guard', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'measured_zs_ohm', value: '0.42', circuit: 1 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].measured_zs_ohm).toBe('0.42');
    expect(out.invalidClosedEnum).toBeUndefined();
    expect(out.canonicalSuccess).toBeUndefined();
  });
});

describe('closed-enum guard — bulk apply_field', () => {
  it('rejects the WHOLE command: no row is written and exactly one re-ask is spoken', () => {
    const out = applyVoiceCommand(
      { type: 'apply_field', field: 'ocpd_type', value: 'MCB', scope: { kind: 'all' } },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toBe(
      "I heard OCPD type 'MCB', which isn't a valid option — say, for example, 'OCPD type B for all circuits'."
    );
  });

  it("the re-ask echoes the command's ACTUAL target, including the spare policy", () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'rcd_type',
        value: 'RCBO',
        scope: { kind: 'range', from: 1, to: 3 },
        sparePolicy: 'exclude',
      },
      JOB
    );
    expect(out.response).toContain("for circuits 1 to 3, excluding spares'");
  });

  it('a valid alias canonicalises across the whole scope, once', () => {
    const out = applyVoiceCommand(
      { type: 'apply_field', field: 'wiring_type', value: 'swa', scope: { kind: 'all' } },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits.every((r) => r.wiring_type === 'F')).toBe(true);
    expect(out.response).toBe('Set wiring type to F for 3 circuits.');
    expect(out.canonicalSuccess).toBe(true);
  });
});

describe('closed-enum guard — parser no longer mangles guarded values', () => {
  it('a bare "A" survives the unit stripper (rcd_type "A" used to clean to "")', () => {
    const cmd = parseVoiceCommand('rcd type A for all circuits');
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd!, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits.every((r) => r.rcd_type === 'A')).toBe(true);
  });

  it('"N/A" survives intact (the slash-adjacent strip used to leave "N/")', () => {
    const cmd = parseVoiceCommand('ocpd type N/A for circuit 1');
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd!, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].ocpd_type).toBe('N/A');
  });

  it('"B+" keeps its internal plus', () => {
    const cmd = parseVoiceCommand('rcd type B+ for circuit 2');
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd!, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[1].rcd_type).toBe('B+');
  });

  it('the unit stripper still fires on UNGUARDED numeric fields', () => {
    const cmd = parseVoiceCommand('ocpd rating 32 amps for circuit 1');
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd!, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].ocpd_rating_a).toBe('32');
  });
});

describe('canonical snake_case field resolution (server-originated actions)', () => {
  // The server speaks canon: `voice_command_response.action.params.field`
  // carries the Stage-6 tool call's snake_case name. Before PLAN-C only
  // `circuit_designation` resolved (its alias key happens to equal its
  // canonical name), so every other canonical key fell through to
  // "I don't know the field …" — no write at all.
  it.each([
    ['wiring_type', 'A'],
    ['ref_method', 'C'],
    ['ocpd_bs_en', 'BS EN 60898'],
    ['ocpd_type', 'B'],
    ['rcd_bs_en', 'BS EN 61008'],
    ['rcd_type', 'AC'],
    ['measured_zs_ohm', '0.42'],
    ['number_of_points', '6'],
  ])('%s resolves and writes', (field, value) => {
    const out = applyVoiceCommand({ type: 'update_field', field, value, circuit: 1 }, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0][field]).toBe(value);
  });

  it('canonical SUPPLY keys resolve too', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'earthing_arrangement', value: 'TN-C-S' },
      { supply: {} }
    );
    expect((out.patch?.supply as Record<string, unknown>).earthing_arrangement).toBe('TN-C-S');
  });

  it('a genuinely unknown field still says so', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'not_a_field', value: 'x', circuit: 1 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.response).toContain("I don't know the field");
  });
});
