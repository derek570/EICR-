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

import {
  applyVoiceCommand,
  voiceCommandTargetsDesignation,
  type VoiceCommandJob,
} from '@certmate/shared-utils';
import { mapServerActionToVoiceCommand } from '../src/lib/recording/voice-command-action';

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

describe('add_circuit — legacy action, iOS-parity semantics (PLAN-B2)', () => {
  const multiBoardJob = (): VoiceCommandJob => ({
    supply: {},
    boards: [{ id: 'board-A' }, { id: 'board-B' }],
    circuits: [
      {
        id: 'c1',
        circuit_ref: '1',
        number: '1',
        board_id: 'board-A',
        circuit_designation: 'Cooker',
      },
      {
        id: 'c7',
        circuit_ref: '7',
        number: '7',
        board_id: 'board-B',
        circuit_designation: 'Sub sockets',
      },
    ],
  });

  it('mapper: add_circuit maps with description (previously dropped — spoke success, no mutation)', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'add_circuit',
      params: { description: 'Shower circuit' },
    });
    expect(cmd).toEqual({ type: 'add_circuit', description: 'Shower circuit' });
    // iOS tolerates a missing description (`params.description ?? ""`).
    expect(mapServerActionToVoiceCommand({ type: 'add_circuit', params: {} })).toEqual({
      type: 'add_circuit',
      description: '',
    });
  });

  it('applier: iOS executeAddCircuit parity — boards.first id + GLOBAL next-ref, canonical designation in storage AND speech', () => {
    const outcome = applyVoiceCommand(
      { type: 'add_circuit', description: 'Shower circuit' },
      multiBoardJob()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    const added = rows.find((r) => r.circuit_ref === '8');
    expect(added).toBeDefined();
    // Global next-ref (max across ALL boards = 7, so 8) + first-board
    // attribution — today's identically-imperfect iOS semantics.
    expect(added?.board_id).toBe('board-A');
    expect(added?.circuit_designation).toBe('Shower');
    expect(outcome.response).toBe('Added circuit 8, Shower.');
    expect(outcome.changedKeys).toEqual(['circuits']);
  });

  it('applier: empty description adds an unnamed circuit (iOS `?? ""`)', () => {
    const outcome = applyVoiceCommand({ type: 'add_circuit', description: '' }, multiBoardJob());
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.circuit_ref === '8')?.circuit_designation).toBe('');
    expect(outcome.response).toBe('Added circuit 8.');
  });

  it('applier: no boards yet — circuit added without board attribution', () => {
    const outcome = applyVoiceCommand(
      { type: 'add_circuit', description: 'Garage' },
      { supply: {}, circuits: [] }
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_ref).toBe('1');
    expect(rows[0].board_id).toBeUndefined();
    expect(outcome.response).toBe('Added circuit 1, Garage.');
  });

  it('applier: template choice uses the JS trim class, so a NEL-only canonical still names the designation (cycle-10 F1)', () => {
    // 'Circuit \u0085' canonicalises to a lone NEL on BOTH platforms —
    // SPACE is a delimiter, so "Circuit" is a standalone leading token.
    // This is the value that split the two clients: iOS tested emptiness
    // with a Foundation trim (Unicode White_Space, which SWALLOWS NEL)
    // and spoke the short template, while this side's `.trim()` (the
    // ECMAScript class, which does not) named the designation.
    const outcome = applyVoiceCommand(
      { type: 'add_circuit', description: 'Circuit \u0085' },
      multiBoardJob()
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.circuit_ref === '8')?.circuit_designation).toBe('\u0085');
    expect(outcome.response).toBe('Added circuit 8, \u0085.');
  });
});

describe('voiceCommandTargetsDesignation — spoken-override predicate', () => {
  it('true for designation update/apply and add_circuit; false otherwise', () => {
    expect(
      voiceCommandTargetsDesignation({
        type: 'update_field',
        field: 'designation',
        value: 'x',
        circuit: 1,
      })
    ).toBe(true);
    expect(
      voiceCommandTargetsDesignation({
        type: 'apply_field',
        field: 'description',
        value: 'x',
        scope: { kind: 'all' },
      })
    ).toBe(true);
    expect(voiceCommandTargetsDesignation({ type: 'add_circuit', description: 'x' })).toBe(true);
    expect(
      voiceCommandTargetsDesignation({
        type: 'update_field',
        field: 'zs',
        value: '0.3',
        circuit: 1,
      })
    ).toBe(false);
    expect(voiceCommandTargetsDesignation({ type: 'reorder_circuits', from: 1, to: 2 })).toBe(
      false
    );
  });
});

describe('Codex r1 regressions — canonical wire field + strict ref parity', () => {
  it('field:"circuit_designation" (canonical wire name) resolves on update AND apply', () => {
    const update = applyVoiceCommand(
      {
        type: 'update_field',
        field: 'circuit_designation',
        value: 'Upstairs lighting circuit',
        circuit: 1,
      },
      job()
    );
    const rows = update.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Upstairs lighting');
    expect(update.response).toBe('Set designation to Upstairs lighting on circuit 1.');
    expect(
      voiceCommandTargetsDesignation({
        type: 'update_field',
        field: 'circuit_designation',
        value: 'x',
        circuit: 1,
      })
    ).toBe(true);
    const mapped = mapServerActionToVoiceCommand({
      type: 'apply_field',
      params: { field: 'circuit_designation', value: 'kitchen ring', circuits: 'all' },
    });
    expect(mapped).not.toBeNull();
  });

  it('add_circuit ref allocation mirrors Swift Int(): "7A" counts as 0, not 7', () => {
    const outcome = applyVoiceCommand(
      { type: 'add_circuit', description: 'Garage' },
      {
        supply: {},
        circuits: [{ id: 'x', circuit_ref: '7A', number: '7A', circuit_designation: 'Odd' }],
      }
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    // iOS: Int("7A") = nil → 0 → next ref 1. parseInt would have said 8.
    expect(rows.some((r) => r.circuit_ref === '1')).toBe(true);
    expect(rows.some((r) => r.circuit_ref === '8')).toBe(false);
  });

  it('add_circuit with only negative refs mirrors iOS (max of values, no zero floor)', () => {
    const outcome = applyVoiceCommand(
      { type: 'add_circuit', description: 'Cellar' },
      {
        supply: {},
        circuits: [{ id: 'n', circuit_ref: '-5', number: '-5', circuit_designation: 'Neg' }],
      }
    );
    const rows = outcome.patch?.circuits as Array<Record<string, unknown>>;
    // iOS: max([-5]) = -5 → next ref "-4".
    expect(rows.some((r) => r.circuit_ref === '-4')).toBe(true);
  });
});
