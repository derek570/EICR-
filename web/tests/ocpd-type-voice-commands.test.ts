/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — the web local-command paths
 * for `ocpd_type` (acceptance 2): no guard and no re-ask, one advisory clause,
 * an identical re-apply writes nothing and speaks one duplicate line, and bulk
 * Apply is per target with ONE grouped outcome. The sentences are pinned by
 * `config/ocpd-type-suggestions.json`; iOS asserts the same bytes.
 */

import { describe, expect, it } from 'vitest';

import { applyVoiceCommand, parseVoiceCommand, type VoiceCommandJob } from '@certmate/shared-utils';

type Row = Record<string, unknown>;

function job(rows: Array<[number, string, string?]>): VoiceCommandJob {
  return {
    circuits: rows.map(([ref, standard, type]) => ({
      id: `row-${ref}`,
      circuit_ref: String(ref),
      circuit_designation: `Circuit ${ref}`,
      ocpd_bs_en: standard,
      ...(type === undefined ? {} : { ocpd_type: type }),
    })),
  } as unknown as VoiceCommandJob;
}

const rowsOf = (out: { patch?: Record<string, unknown> }) => (out.patch?.circuits ?? []) as Row[];

describe('single-circuit update_field', () => {
  it('writes an off-list type and speaks the advisory once, through the protected path', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd type', value: 'gG', circuit: 4 },
      job([[4, 'BS EN 60898', 'B']])
    );
    expect(rowsOf(out)[0].ocpd_type).toBe('gG');
    expect(out.response).toBe(
      'Set OCPD type to gG on circuit 4 — may not be right for BS EN 60898.'
    );
    expect(out.protectedLocalReadback).toBe(true);
    expect(out.invalidClosedEnum).toBeUndefined();
  });

  it('an unknown type is written with "not a type I know"; N/A never advises', () => {
    const q = applyVoiceCommand(
      { type: 'update_field', field: 'type', value: 'type q', circuit: 4 },
      job([[4, 'BS EN 60898']])
    );
    expect(rowsOf(q)[0].ocpd_type).toBe('Q');
    expect(q.response).toBe('Set OCPD type to Q on circuit 4 — not a type I know.');
    const na = applyVoiceCommand(
      { type: 'update_field', field: 'type', value: 'N/A', circuit: 4 },
      job([[4, 'BS EN 60898']])
    );
    expect(na.response).toBe('Set OCPD type to N/A on circuit 4.');
  });

  it('an identical re-apply (canonically, stored alias included) writes nothing and speaks the duplicate line without the advisory', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'type', value: 'two', circuit: 4 },
      job([[4, 'BS EN 60898', 'type 2']])
    );
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe('Already got that — type 2 for circuit 4.');
    expect(out.actionOutcome).toBe('unapplied');
    expect(out.protectedLocalReadback).toBe(true);
  });

  it('a spoken command parses and lands: "OCPD type K for circuit 2"', () => {
    const cmd = parseVoiceCommand('OCPD type K for circuit 2');
    expect(cmd).not.toBeNull();
    const out = applyVoiceCommand(cmd!, job([[2, 'BS EN 60947-2']]));
    expect(rowsOf(out)[0].ocpd_type).toBe('K');
    // "for circuit N" parses as an apply_field with a single scope, so it takes
    // the Apply sentence family.
    expect(out.response).toBe('Type K set on circuit 2.');
  });

  it('a blank value and a missing circuit write nothing and say so', () => {
    const blank = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_type', value: '  ', circuit: 4 },
      job([[4, 'BS EN 60898', 'B']])
    );
    expect(blank.patch).toBeUndefined();
    expect(blank.invalidClosedEnum).toBe(true);
    const missing = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_type', value: 'B', circuit: 9 },
      job([[4, 'BS EN 60898']])
    );
    expect(missing.patch).toBeUndefined();
    expect(missing.guardedWriteFailed).toBe(true);
  });

  it('a type change recomputes max Zs through the OCPD-aware commit', () => {
    const j = {
      circuits: [
        {
          id: 'row-4',
          circuit_ref: '4',
          ocpd_bs_en: 'BS EN 60898',
          ocpd_type: 'B',
          ocpd_rating_a: '32',
          max_disconnect_time_s: '0.4',
          ocpd_max_zs_ohm: '1.37',
          ocpd_max_zs_source: 'auto',
        },
      ],
    } as unknown as VoiceCommandJob;
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'type', value: 'C', circuit: 4 },
      j
    );
    const row = rowsOf(out)[0];
    expect(row.ocpd_type).toBe('C');
    expect(row.ocpd_max_zs_ohm).not.toBe('1.37');
  });
});

describe('bulk apply_field — per target, ONE outcome (acceptance 2 a–e)', () => {
  const apply = (value: string, j: VoiceCommandJob) =>
    applyVoiceCommand(
      { type: 'apply_field', field: 'ocpd type', value, scope: { kind: 'range', from: 1, to: 4 } },
      j
    );

  it('(a) all identical → no mutation, the stored alias keeps its bytes, one duplicate outcome', () => {
    const out = apply(
      'type 2',
      job([
        [1, 'BS EN 60898', '2'],
        [2, 'BS EN 60898', '2'],
        [3, 'BS EN 60898', '2'],
        [4, 'BS EN 60898', 'type 2'],
      ])
    );
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe('Already got type 2 on circuits 1 to 4.');
    expect(out.protectedLocalReadback).toBe(true);
  });

  it('(b) all different → four written, one clause naming only the BS EN 60898 circuits', () => {
    const out = apply(
      'type 2',
      job([
        [1, 'BS EN 60898', 'B'],
        [2, 'BS 3871', '1'],
        [3, 'BS EN 60898'],
        [4, 'BS 3871', '3'],
      ])
    );
    expect(rowsOf(out).map((r) => r.ocpd_type)).toEqual(['2', '2', '2', '2']);
    expect(out.response).toBe(
      'Type 2 set on circuits 1 to 4 — may not be right for BS EN 60898 on circuits 1 and 3.'
    );
  });

  it('(c) mixed → exactly rows 2 and 3 mutated, 1 and 4 untouched byte-for-byte and not re-advised', () => {
    const out = apply(
      'type 2',
      job([
        [1, 'BS 3871', '2'],
        [2, 'BS 3871', 'B'],
        [3, 'BS EN 60898', 'C'],
        [4, 'BS EN 60898', 'type 2'],
      ])
    );
    expect(rowsOf(out).map((r) => r.ocpd_type)).toEqual(['2', '2', '2', 'type 2']);
    expect(out.appliedResults?.map((r) => r.circuit)).toEqual(['2', '3']);
    expect(out.response).toBe(
      'Type 2 set on circuits 2 and 3; 1 and 4 already had it — may not be right for BS EN 60898 on circuit 3.'
    );
  });

  it('(d) two standards → groups ordered by lowest circuit, "may not be right" once', () => {
    const out = apply(
      'type 2',
      job([
        [1, 'BS 3871', 'B'],
        [2, 'BS EN 60898', 'B'],
        [3, 'BS 3036', 'Rew'],
        [4, 'BS EN 60898'],
      ])
    );
    expect(out.response).toBe(
      'Type 2 set on circuits 1 to 4 — may not be right for BS EN 60898 on circuits 2 and 4 and for BS 3036 on circuit 3.'
    );
  });

  it('(e) an unknown candidate → a group-wide clause with no circuit list', () => {
    const out = apply(
      'type Q',
      job([
        [1, 'BS 3871', 'B'],
        [2, 'BS EN 60898', 'B'],
        [3, 'BS 3036', 'Rew'],
        [4, 'BS EN 60898'],
      ])
    );
    expect(rowsOf(out).map((r) => r.ocpd_type)).toEqual(['Q', 'Q', 'Q', 'Q']);
    expect(out.response).toBe('Type Q set on circuits 1 to 4 — not a type I know.');
  });
});
