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

import { normalise } from '@/lib/recording/number-normaliser';

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

  it('a dictated standard outside the old closed list is now WRITTEN and read back', () => {
    // PLAN-CC. BS 1362 is the 13 A plug-top fuse — a real device standard the
    // eight-option schema list simply never carried, so dictating it used to
    // draw a re-ask and the certificate recorded nothing. The backend parser's
    // Levenshtein-1 fallback made it worse by snapping 1362 onto BS 1361, a
    // DIFFERENT device. The field takes it as dictated now, and the read-back
    // is what lets the inspector catch a mishear by ear.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: '1362', circuit: 1 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].ocpd_bs_en).toBe('BS 1362');
    expect(circuits[0].ocpd_bs_en).not.toBe('BS 1361');
    expect(out.response).toBe('Set OCPD BS EN to BS 1362 on circuit 1.');
    expect(out.invalidClosedEnum).toBeUndefined();
  });

  it('prose still misses, and the re-ask is the SAME sentence it always was', () => {
    // The miss path is unchanged by PLAN-CC — same renderer, same words. What
    // changed is WHICH values reach it.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: 'There is no RCBO', circuit: 1 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toBe(
      "I heard OCPD BS EN 'There is no RCBO', which isn't a valid standard — say, for example, 'OCPD standard BS EN 60898 for circuit 1'."
    );
  });

  it('a dictated N/A survives the cleaner and is never mangled to N/', () => {
    // `ocpd_bs_en` left the guarded set, so it had to be named explicitly in
    // `cleanValue` — the unit-stripping fallback ends with an `a$` strip.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: 'N/A', circuit: 1 },
      JOB
    );
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0].ocpd_bs_en).toBe('N/A');
    expect(out.response).toContain('N/A');
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
    // Addressed by its SPOKEN alias — which is how this column is reachable
    // on both clients. (Codex cycle 3: the canonical `measured_zs_ohm`
    // spelling deliberately does NOT resolve; iOS has no case for it.)
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'zs', value: '0.42', circuit: 1 },
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
      { type: 'apply_field', field: 'rcd_type', value: 'MCB', scope: { kind: 'all' } },
      JOB
    );
    // PLAN-C2 — the example moved from `ocpd_type` (free text now) to
    // `rcd_type`, which is still guarded.
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toBe(
      "I heard RCD type 'MCB', which isn't a valid option — say, for example, 'RCD type AC for all circuits'."
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
    ['number_of_points', '6'],
    ['max_disconnect_time_s', '0.4'],
  ])('%s resolves and writes', (field, value) => {
    const out = applyVoiceCommand({ type: 'update_field', field, value, circuit: 1 }, JOB);
    const circuits = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(circuits[0][field]).toBe(value);
  });

  // Codex cycle 3 — the fallback is the INTERSECTION with iOS, not every
  // canonical name web's alias table happens to resolve to. iOS's
  // `setCircuitField` knows these columns only under shorter names (`zs`,
  // `r1_r2`, `ocpd_rating`, `polarity`, `cpc_csa`), so accepting the long
  // spellings here would make one identical wire frame write on web and
  // do nothing on iOS. iOS is canon; the union is a separate decision.
  it.each([
    'measured_zs_ohm',
    'r1_r2_ohm',
    'ocpd_rating_a',
    'polarity_confirmed',
    'cpc_csa_mm2',
    'rcd_operating_current_ma',
  ])('%s is NOT resolved — iOS has no case for it', (field) => {
    const out = applyVoiceCommand({ type: 'update_field', field, value: '1', circuit: 1 }, JOB);
    expect(out.patch).toBeUndefined();
    expect(out.response).toContain("I don't know the field");
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

describe('Codex cycle 1 — an accepted value whose write did not land', () => {
  // The guard says yes, nothing is mutated because the target isn't there,
  // and (before the fix) no flag reached the speak seam — so the server's
  // "Set wiring type to A on circuit 12." was read back over a certificate
  // that has no circuit 12. Exactly the lie PLAN-B2's Codex r1 closed for
  // designations, in the six columns this plan owns.
  it('a missing circuit is flagged so the seam speaks the truthful line', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'wiring_type', value: 'A', circuit: 12 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.guardedWriteFailed).toBe(true);
    expect(out.response).toBe("Circuit 12 doesn't exist.");
  });

  it('an UNGUARDED field on a missing circuit is left exactly as it was', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'measured_zs_ohm', value: '0.42', circuit: 12 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.guardedWriteFailed).toBeUndefined();
  });

  it('a fractional circuit reference is a MISSING target, not an empty one', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'wiring_type', value: 'A', circuit: 3.5 },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toContain('which circuit');
  });

  it('a guarded bulk apply that matches no circuit is flagged too', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'wiring_type', value: 'A', circuit: 0 },
      JOB
    );
    // circuit 0 is not a structurally complete target either.
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
  });

  it('a guarded range apply matching nothing is flagged rather than silent', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'wiring_type',
        value: 'A',
        scope: { kind: 'range', from: 40, to: 45 },
      },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.guardedWriteFailed).toBe(true);
    expect(out.response).toBe('No circuits found in the specified range.');
  });
});

describe('Codex cycle 2 — an apply_field scope is only a target if it is a real circuit', () => {
  // The action mapper's `asNumber` screens for finiteness only, so a
  // malformed frame can put 0 or 2.5 into `scope.circuit`. iOS
  // (`guardedApplyTarget`, VoiceCommandExecutor.swift:749) has always
  // required a POSITIVE INTEGER and re-asks "…but not which circuit"; web
  // used to accept the scope, find no rows, and say "No circuits found in
  // the specified range." Neither client wrote anything — but the two
  // SPOKE different things for one wire frame, and iOS is canon.
  it('circuit 0 asks which circuit, exactly as iOS does', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'wiring_type',
        value: 'A',
        scope: { kind: 'single', circuit: 0 },
      },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.guardedWriteFailed).toBeUndefined();
    expect(out.response).toContain('which circuit');
  });

  it('a fractional single scope asks which circuit', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'rcd_type',
        value: 'A',
        scope: { kind: 'single', circuit: 2.5 },
      },
      JOB
    );
    expect(out.patch).toBeUndefined();
    expect(out.invalidClosedEnum).toBe(true);
    expect(out.response).toContain('which circuit');
  });

  it('the re-ask quotes the ACCEPTED canonical value, not the raw input', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'ocpd_bs_en',
        value: '60898',
        scope: { kind: 'single', circuit: 0 },
      },
      JOB
    );
    expect(out.response).toContain('BS EN 60898');
  });

  /* Codex cycle 5 — end-to-end pin for the `^100[123]$` reference-method
   * branch, which a reviewer proposed deleting as dead code.
   *
   * The unit fixture pins the guard in isolation ("1001" → "101"), but
   * NOTHING pinned the reason "1001" reaches the guard at all: the number
   * normaliser runs first, and whether the inspector says "and" decides
   * which digit shape it emits. Both are real dictations, so both are
   * driven here through the REAL chain — normalise → parse → apply — and
   * must land the same stored value. Delete the branch and the second
   * case stops writing and starts re-asking (Audio-First §2). */
  it.each([
    ['reference method one hundred and one for circuit 1', '101'],
    ['reference method one hundred one for circuit 1', '101'],
    ['reference method one hundred and three for circuit 1', '103'],
    ['reference method one hundred three for circuit 1', '103'],
    ['reference method one hundred for circuit 1', '100'],
  ])('%s writes ref_method %s through normalise → parse → apply', (utterance, expected) => {
    const command = parseVoiceCommand(normalise(utterance).toLowerCase());
    expect(command, 'the utterance must parse as a local voice command').not.toBeNull();
    const out = applyVoiceCommand(command!, JOB);
    expect(out.invalidClosedEnum, `"${utterance}" must not draw a re-ask`).toBeUndefined();
    expect((out.patch?.circuits as Array<Record<string, unknown>>)[0].ref_method).toBe(expected);
    // Audio-First §3 — spoken and stored come from the same canonical value.
    expect(out.response).toContain(expected);
  });

  it('a legitimate positive-integer scope is unaffected', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'wiring_type',
        value: 'A',
        scope: { kind: 'single', circuit: 1 },
      },
      JOB
    );
    expect(out.patch).toBeDefined();
    expect(out.invalidClosedEnum).toBeUndefined();
    expect(out.guardedWriteFailed).toBeUndefined();
  });
});
