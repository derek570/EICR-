/**
 * PLAN-CD — the guard's typed `ocpdStandardMiss` verdict. It marks ONLY an
 * `ocpd_bs_en` value the canonicaliser could not read. Every other rejection
 * — an empty value, a missing target, any other closed-enum field — keeps its
 * question, so the client-local handoff can never widen past the case the
 * plan scopes it to.
 */
import { describe, expect, it } from 'vitest';
import { applyVoiceCommand, parseVoiceCommand, type VoiceCommand } from '@certmate/shared-utils';

const job = {
  circuits: [
    { circuit_ref: '1', circuit_designation: 'Sockets' },
    { circuit_ref: '2', circuit_designation: 'Lights' },
  ],
} as never;

const run = (text: string) => {
  const command = parseVoiceCommand(text);
  if (!command) throw new Error(`"${text}" did not parse`);
  return applyVoiceCommand(command, job);
};

describe('ocpdStandardMiss', () => {
  it('is set on a canonicalisation miss, on apply_field and update_field alike', () => {
    for (const text of [
      'OCPD standard grey square for all',
      'OCPD standard grey square for circuit 1',
    ]) {
      const outcome = run(text);
      expect(outcome.invalidClosedEnum).toBe(true);
      expect(outcome.ocpdStandardMiss).toBe(true);
      expect(outcome.patch).toBeUndefined();
    }
    const update: VoiceCommand = {
      type: 'update_field',
      field: 'ocpd standard',
      value: 'grey square',
      circuit: 1,
    } as VoiceCommand;
    const outcome = applyVoiceCommand(update, job);
    expect(outcome.invalidClosedEnum).toBe(true);
    expect(outcome.ocpdStandardMiss).toBe(true);
  });

  it('is NOT set on a success, an empty value, or another closed-enum field', () => {
    expect(run('OCPD standard 60898 for all circuits').ocpdStandardMiss).toBeUndefined();
    const empty = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'ocpd standard',
        value: '  ',
        scope: { kind: 'all' },
      } as VoiceCommand,
      job
    );
    expect(empty.invalidClosedEnum).toBe(true);
    expect(empty.ocpdStandardMiss).toBeUndefined();
    const wiring = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'wiring type',
        value: 'grey square',
        scope: { kind: 'all' },
      } as VoiceCommand,
      job
    );
    expect(wiring.invalidClosedEnum).toBe(true);
    expect(wiring.ocpdStandardMiss).toBeUndefined();
  });

  it('is NOT set when the value canonicalises but the target is missing', () => {
    const noTarget = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd standard', value: '60898' } as VoiceCommand,
      job
    );
    expect(noTarget.invalidClosedEnum).toBe(true);
    expect(noTarget.ocpdStandardMiss).toBeUndefined();
  });
});
