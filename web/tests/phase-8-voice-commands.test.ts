/**
 * Phase 8 — Voice command parser + applier.
 *
 * Ports iOS `VoiceCommandExecutor` to shared-utils. Coverage targets the
 * three MVP commands (update_field / reorder_circuits / query_field).
 * Punted commands (add_circuit, delete_circuit, calculate_impedance,
 * query_summary) are marked `partial` on the parity ledger and tracked
 * for a follow-up.
 *
 * Tests hit the pure functions directly — no React / DOM plumbing —
 * mirroring the phase-5-impedance suite.
 */

import { describe, expect, it } from 'vitest';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

function jobWithCircuits(count: number): VoiceCommandJob {
  return {
    circuits: Array.from({ length: count }, (_, i) => ({
      id: `c-${i + 1}`,
      circuit_ref: String(i + 1),
      number: String(i + 1),
      circuit_designation: `Circuit ${i + 1}`,
    })),
  };
}

describe('parseVoiceCommand — update_field', () => {
  it('parses the canonical "set X to Y on circuit N" form', () => {
    const cmd = parseVoiceCommand('set OCPD to 32A on circuit 4');
    expect(cmd).toEqual({
      type: 'update_field',
      field: 'ocpd',
      value: '32',
      circuit: 4,
    });
  });

  it('strips trailing "amps" unit from the value', () => {
    const cmd = parseVoiceCommand('set OCPD rating to 16 amps on circuit 2');
    expect(cmd).toMatchObject({ value: '16', circuit: 2 });
  });

  it('parses supply-level fields without a circuit suffix', () => {
    const cmd = parseVoiceCommand('set Ze to 0.35');
    expect(cmd).toEqual({
      type: 'update_field',
      field: 'ze',
      value: '0.35',
      circuit: undefined,
    });
  });

  it('maps spoken "pass" to PASS for polarity', () => {
    const cmd = parseVoiceCommand('set polarity to pass on circuit 3');
    expect(cmd).toMatchObject({ value: 'PASS', circuit: 3 });
  });

  it('accepts the terse "circuit N field value" form', () => {
    const cmd = parseVoiceCommand('circuit 5 Zs 0.44');
    expect(cmd).toEqual({
      type: 'update_field',
      field: 'zs',
      value: '0.44',
      circuit: 5,
    });
  });

  it('returns null on unrecognised transcripts', () => {
    expect(parseVoiceCommand('this is just chatter about the weather')).toBeNull();
    expect(parseVoiceCommand('')).toBeNull();
  });
});

describe('parseVoiceCommand — reorder_circuits', () => {
  it('parses "move circuit N to M"', () => {
    expect(parseVoiceCommand('move circuit 7 to 3')).toEqual({
      type: 'reorder_circuits',
      from: 7,
      to: 3,
    });
  });

  it('accepts the "position" keyword', () => {
    expect(parseVoiceCommand('move circuit 2 to position 8')).toEqual({
      type: 'reorder_circuits',
      from: 2,
      to: 8,
    });
  });
});

describe('parseVoiceCommand — query_field', () => {
  it('parses "what is X on circuit N"', () => {
    expect(parseVoiceCommand('what is Zs on circuit 3')).toEqual({
      type: 'query_field',
      field: 'zs',
      circuit: 3,
    });
  });

  it('parses "read me X circuit N"', () => {
    expect(parseVoiceCommand('read me OCPD rating on circuit 1')).toMatchObject({
      type: 'query_field',
      field: 'ocpd rating',
      circuit: 1,
    });
  });

  it('omits circuit when not stated', () => {
    expect(parseVoiceCommand('what is Ze')).toEqual({
      type: 'query_field',
      field: 'ze',
      circuit: undefined,
    });
  });
});

describe('applyVoiceCommand — update_field (circuit)', () => {
  it('patches the matching circuit row', () => {
    const job = jobWithCircuits(3);
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd', value: '32', circuit: 2 },
      job
    );
    expect(outcome.patch).toBeDefined();
    expect(outcome.response).toMatch(/OCPD rating to 32 on circuit 2/);
    const circuits = (outcome.patch as { circuits: Array<{ ocpd_rating_a?: string }> }).circuits;
    expect(circuits[1].ocpd_rating_a).toBe('32');
    // Other rows untouched.
    expect(circuits[0].ocpd_rating_a).toBeUndefined();
  });

  it('converts PASS to the ✓ sigil for polarity_confirmed', () => {
    const job = jobWithCircuits(2);
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'polarity', value: 'PASS', circuit: 1 },
      job
    );
    const circuits = (outcome.patch as { circuits: Array<{ polarity_confirmed?: string }> })
      .circuits;
    expect(circuits[0].polarity_confirmed).toBe('✓');
  });

  it('returns an "unknown field" response when the phrase is unmapped', () => {
    const job = jobWithCircuits(1);
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'flux capacitance', value: '1.21', circuit: 1 },
      job
    );
    expect(outcome.patch).toBeUndefined();
    expect(outcome.response).toMatch(/don't know the field/i);
  });

  it('returns a "circuit doesn\'t exist" response when the circuit is missing', () => {
    const job = jobWithCircuits(3);
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'zs', value: '0.44', circuit: 99 },
      job
    );
    expect(outcome.patch).toBeUndefined();
    expect(outcome.response).toMatch(/doesn't exist/i);
  });
});

describe('applyVoiceCommand — update_field (supply)', () => {
  it('patches supply.ze when no circuit is specified', () => {
    const job: VoiceCommandJob = { supply: { pfc: '1.5' } };
    const outcome = applyVoiceCommand({ type: 'update_field', field: 'ze', value: '0.35' }, job);
    expect(outcome.patch).toEqual({ supply: { pfc: '1.5', ze: '0.35' } });
    expect(outcome.response).toMatch(/Ze to 0.35/);
  });

  it('patches installation.client_name for "client name"', () => {
    const job: VoiceCommandJob = {};
    const outcome = applyVoiceCommand(
      { type: 'update_field', field: 'client name', value: 'Alice' },
      job
    );
    expect(outcome.patch).toEqual({ installation: { client_name: 'Alice' } });
  });
});

describe('applyVoiceCommand — reorder_circuits', () => {
  it('moves a circuit and renumbers refs sequentially', () => {
    const job = jobWithCircuits(5);
    const outcome = applyVoiceCommand({ type: 'reorder_circuits', from: 4, to: 2 }, job);
    expect(outcome.patch).toBeDefined();
    const circuits = (
      outcome.patch as {
        circuits: Array<{ id: string; circuit_ref: string }>;
      }
    ).circuits;
    // c-4 should now sit at index 1 (position 2).
    expect(circuits[1].id).toBe('c-4');
    expect(circuits[1].circuit_ref).toBe('2');
    // Refs should be dense 1..5 after renumbering.
    expect(circuits.map((c) => c.circuit_ref)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('is a no-op when from === to', () => {
    const job = jobWithCircuits(3);
    const outcome = applyVoiceCommand({ type: 'reorder_circuits', from: 2, to: 2 }, job);
    expect(outcome.patch).toBeUndefined();
    expect(outcome.response).toMatch(/already at position/i);
  });
});

describe('applyVoiceCommand — query_field', () => {
  it('reads back a circuit value', () => {
    const job: VoiceCommandJob = {
      circuits: [
        {
          id: 'c-1',
          circuit_ref: '1',
          measured_zs_ohm: '0.44',
        },
      ],
    };
    const outcome = applyVoiceCommand({ type: 'query_field', field: 'zs', circuit: 1 }, job);
    expect(outcome.patch).toBeUndefined();
    expect(outcome.response).toMatch(/Zs on circuit 1 is 0\.44/);
  });

  it('says "not set" when the value is blank', () => {
    const job = jobWithCircuits(1);
    const outcome = applyVoiceCommand({ type: 'query_field', field: 'zs', circuit: 1 }, job);
    expect(outcome.response).toMatch(/not set/i);
  });
});
