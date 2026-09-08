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
import {
  applyVoiceCommand,
  clientCommandForCalculate,
  parseCalculateCommand,
  parseScopeTextWithRemainder,
  parseVoiceCommand,
  resolveJobZe,
  NO_ZE_RESPONSE,
  type VoiceCommandJob,
} from '@certmate/shared-utils';

// A01P (2026-09-08) — the local calculator resolves Ze through the REAL web
// job keys (`supply_characteristics`, `boards`, `board_info`), never the
// unpopulated singular `supply` bag that caused the original Ze bug.
const jobWithCircuits = (
  ze: string | undefined,
  rows: Array<Record<string, unknown>>
): VoiceCommandJob => ({
  supply_characteristics: ze != null ? { ze } : {},
  circuits: rows,
});

describe('parseVoiceCommand — calculate_impedance', () => {
  it('parses "calculate Zs for circuit 3"', () => {
    const cmd = parseVoiceCommand('calculate Zs for circuit 3');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'single', circuit: 3 },
      remainder: '',
    });
  });

  it('parses "calculate R1+R2 for all circuits"', () => {
    const cmd = parseVoiceCommand('calculate R1+R2 for all circuits');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'r1_r2',
      scope: { kind: 'all' },
      remainder: '',
    });
  });

  it('parses "calculate Zs for circuits 2 to 5" (range)', () => {
    const cmd = parseVoiceCommand('calculate Zs for circuits 2 to 5');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'range', from: 2, to: 5 },
      remainder: '',
    });
  });

  it('accepts "calculate impedance" as Zs (trade vernacular)', () => {
    const cmd = parseVoiceCommand('calculate impedance for circuit 1');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'single', circuit: 1 },
      remainder: '',
    });
  });

  it('accepts "R1 plus R2" longhand', () => {
    const cmd = parseVoiceCommand('calculate R1 plus R2 for all');
    expect(cmd).toEqual({
      type: 'calculate_impedance',
      kind: 'r1_r2',
      scope: { kind: 'all' },
      remainder: '',
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

// ─────────────────────────────────────────────────
// A01P (2026-09-08) — remainder-aware Calculate parsing, terminal
// punctuation tolerance, and the job-level three-state Ze ladder.
// ─────────────────────────────────────────────────
describe('[invariant] A01P — parseScopeTextWithRemainder / terminal punctuation', () => {
  it('tolerates a terminal full stop, comma, bang or question mark on every scope shape', () => {
    for (const p of ['.', ',', '!', '?']) {
      expect(parseVoiceCommand(`calculate impedance for all${p}`)).toMatchObject({
        type: 'calculate_impedance',
        kind: 'zs',
        scope: { kind: 'all' },
        remainder: '',
      });
      expect(parseVoiceCommand(`calculate Zs for circuit 1${p}`)).toMatchObject({
        scope: { kind: 'single', circuit: 1 },
        remainder: '',
      });
      expect(parseVoiceCommand(`calculate Zs for circuits 1 to 4${p}`)).toMatchObject({
        scope: { kind: 'range', from: 1, to: 4 },
        remainder: '',
      });
    }
  });

  it('the spoken "z s" prefix parses as Zs (no \\bzs\\b trigger word on the wire)', () => {
    expect(parseVoiceCommand('calculate z s for all')).toMatchObject({
      kind: 'zs',
      scope: { kind: 'all' },
      remainder: '',
    });
  });

  it('reports board-qualified trailing text as an unconsumed remainder (recognition unchanged)', () => {
    expect(parseVoiceCommand('calculate Zs for circuit 1 on the garage board')).toMatchObject({
      scope: { kind: 'single', circuit: 1 },
      remainder: 'on the garage board',
    });
    expect(
      parseVoiceCommand('calculate Zs for circuits 1 to 4 on the garage board.')
    ).toMatchObject({
      scope: { kind: 'range', from: 1, to: 4 },
      remainder: 'on the garage board',
    });
    expect(parseScopeTextWithRemainder('for all circuits on the garage board')).toEqual({
      scope: { kind: 'all' },
      remainder: 'on the garage board',
    });
  });

  it('parseCalculateCommand is the Calculate branch only; a mixed query keeps its remainder', () => {
    expect(parseCalculateCommand('calculate Zs for circuit 1, what did I say?')).toMatchObject({
      scope: { kind: 'single', circuit: 1 },
      remainder: ', what did i say',
    });
    expect(parseCalculateCommand('Zs for circuit 1 is 0.5')).toBeNull();
    expect(parseCalculateCommand('calculate Zs for second one')).toBeNull();
  });

  it('clientCommandForCalculate names the server calculator', () => {
    expect(clientCommandForCalculate(parseCalculateCommand('calculate impedance for all')!)).toBe(
      'calculate_zs'
    );
    expect(clientCommandForCalculate(parseCalculateCommand('calculate R1 plus R2 for all')!)).toBe(
      'calculate_r1_plus_r2'
    );
  });
});

describe('[invariant] A01P — job-level Ze ladder (resolveJobZe) and three-state local Calculate', () => {
  const rows = [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker', r1_r2_ohm: '0.20' }];
  const cmd = () => parseVoiceCommand('calculate Zs for circuit 1')!;

  it('boards: null + populated board_info → board_info.ze wins over supply Ze (0.35 + 0.20 = 0.55)', () => {
    const job: VoiceCommandJob = {
      boards: null,
      board_info: { ze: '0.35' },
      supply_characteristics: { ze: '0.50', earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(job)).toEqual({
      state: 'finite',
      value: 0.35,
      raw: '0.35',
      source: 'board_ze',
    });
    const out = applyVoiceCommand(cmd(), job);
    expect(out.response).toBe('Circuit 1, Zs calculated as 0.55 ohms');
  });

  it('boards: [] behaves identically to boards: null (board_info is the sole board)', () => {
    const job: VoiceCommandJob = {
      boards: [],
      board_info: { ze: '0.35' },
      supply_characteristics: { ze: '0.50', earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(applyVoiceCommand(cmd(), job).response).toBe('Circuit 1, Zs calculated as 0.55 ohms');
  });

  it('one board with a Ze override uses it whatever the circuit board_id says (absent / empty)', () => {
    for (const boardId of [undefined, '']) {
      const job: VoiceCommandJob = {
        boards: [{ id: 'main', board_type: 'main', ze: '0.30' }],
        supply_characteristics: { earth_loop_impedance_ze: '0.50' },
        circuits: [{ ...rows[0], ...(boardId === undefined ? {} : { board_id: boardId }) }],
      };
      expect(applyVoiceCommand(cmd(), job).response).toBe('Circuit 1, Zs calculated as 0.50 ohms');
    }
  });

  it('at-DB tier (zs_at_db, and the iOS ze_at_db alias) beats supply when the override is blank', () => {
    const a: VoiceCommandJob = {
      boards: [{ id: 'main', board_type: 'main', ze: '', zs_at_db: '0.40' }],
      supply_characteristics: { earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(a)).toMatchObject({ state: 'finite', value: 0.4, source: 'board_at_db' });
    const b: VoiceCommandJob = {
      boards: [{ id: 'main', board_type: 'main', ze_at_db: '0.40' }],
      supply_characteristics: { earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(b)).toMatchObject({ state: 'finite', value: 0.4, source: 'board_at_db' });
  });

  it('boards-less job with no board_info values reaches the supply ladder: long alias, then short', () => {
    expect(
      resolveJobZe({
        board_info: {},
        supply_characteristics: { ze: '0.35', earth_loop_impedance_ze: '0.50' },
      })
    ).toMatchObject({ state: 'finite', value: 0.5, source: 'supply_long' });
    expect(resolveJobZe({ supply_characteristics: { ze: '0.35' } })).toMatchObject({
      state: 'finite',
      value: 0.35,
      source: 'supply_short',
    });
  });

  it('present-but-invalid at the highest occupied tier is unreadable — never a fall-through to a finite lower tier', () => {
    const job: VoiceCommandJob = {
      boards: [{ id: 'main', board_type: 'main', ze: 'LIM' }],
      supply_characteristics: { earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(job)).toEqual({ state: 'unreadable', raw: 'LIM', source: 'board_ze' });
    const out = applyVoiceCommand(cmd(), job);
    expect(out).toMatchObject({
      response: 'I couldn’t apply that calculation.',
      actionOutcome: 'unsupported',
      actionReason: 'ze_unreadable',
    });
    expect(out.patch).toBeUndefined();
    for (const raw of ['N/A', 'abc', [0.5]]) {
      expect(
        resolveJobZe({ supply_characteristics: { earth_loop_impedance_ze: raw as unknown } }).state
      ).toBe('unreadable');
    }
  });

  it('genuinely absent Ze keeps the existing no-Ze wording', () => {
    const job: VoiceCommandJob = {
      boards: [{ id: 'main', ze: '  ' }],
      supply_characteristics: {},
      circuits: rows,
    };
    expect(resolveJobZe(job)).toEqual({ state: 'absent' });
    const out = applyVoiceCommand(cmd(), job);
    expect(out.response).toBe(NO_ZE_RESPONSE);
    expect(out.actionOutcome).toBe('unsupported');
    expect(out.patch).toBeUndefined();
  });

  it('two or more boards → multi_board (the caller forwards; the calculator never computes)', () => {
    const job: VoiceCommandJob = {
      boards: [
        { id: 'main', ze: '0.35' },
        { id: 'garage', ze: '0.38' },
      ],
      supply_characteristics: { ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(job)).toEqual({ state: 'multi_board', boardCount: 2 });
    const out = applyVoiceCommand(cmd(), job);
    expect(out.actionOutcome).toBe('unsupported');
    expect(out.actionReason).toBe('multi_board');
    expect(out.patch).toBeUndefined();
  });

  it('the singular legacy `supply` bag is NOT a Ze source any more', () => {
    const job: VoiceCommandJob = { supply: { ze: '0.35' }, circuits: rows };
    expect(applyVoiceCommand(cmd(), job).response).toBe(NO_ZE_RESPONSE);
  });
});

describe('[invariant] A01P Codex cycle-1 — a meter reading always wins (already_set skip, every scope)', () => {
  const rows = [
    {
      id: 'c1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      r1_r2_ohm: '0.20',
      measured_zs_ohm: '0.42',
    },
    { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets', r1_r2_ohm: '0.30' },
    {
      id: 'c3',
      circuit_ref: '3',
      circuit_designation: 'Lights',
      r1_r2_ohm: '0.10',
      measured_zs_ohm: 'LIM',
    },
    { id: 'c4', circuit_ref: '4', circuit_designation: 'Shower', r1_r2_ohm: '0.40' },
  ];
  const job = (): VoiceCommandJob => ({
    supply_characteristics: { ze: '0.35' },
    circuits: rows.map((r) => ({ ...r })),
  });

  it('single scope: an occupied destination is left unchanged and the outcome says so', () => {
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for circuit 1')!, job());
    expect(out.patch).toBeUndefined();
    expect(out.actionOutcome).toBe('unapplied');
    expect(out.actionReason).toBe('already_set');
    expect(out.skippedResults).toEqual([{ circuit: '1', reason: 'already_set' }]);
    expect(out.response).toBe(
      'Zs for circuit 1 is already recorded — say a new reading to replace it.'
    );
  });

  it('range scope: occupied rows (a number AND a LIM) are skipped, the empty row in the same command fills; read-back names only what was written', () => {
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for circuits 1 to 3')!, job());
    const next = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(next[0].measured_zs_ohm).toBe('0.42');
    expect(next[2].measured_zs_ohm).toBe('LIM');
    expect(next[1].measured_zs_ohm).toBe('0.65');
    expect(out.appliedResults).toEqual([{ circuit: '2', field: 'measured_zs_ohm', value: '0.65' }]);
    expect(out.skippedResults).toEqual([
      { circuit: '1', reason: 'already_set' },
      { circuit: '3', reason: 'already_set' },
    ]);
    expect(out.response).toBe('Circuit 2, Zs calculated as 0.65 ohms');
    expect(out.actionOutcome).toBe('applied');
  });

  it('all scope: two skipped, two filled', () => {
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all circuits')!, job());
    const next = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(next.map((r) => r.measured_zs_ohm)).toEqual(['0.42', '0.65', 'LIM', '0.75']);
    expect(out.response).toBe(
      'Circuit 2, Zs calculated as 0.65 ohms. Circuit 4, Zs calculated as 0.75 ohms'
    );
  });

  it('all scope with every destination occupied → the plural already-recorded line, nothing written', () => {
    const j: VoiceCommandJob = {
      supply_characteristics: { ze: '0.35' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          r1_r2_ohm: '0.20',
          measured_zs_ohm: '0.42',
        },
        {
          id: 'c2',
          circuit_ref: '2',
          circuit_designation: 'Sockets',
          r1_r2_ohm: '0.30',
          measured_zs_ohm: '0.66',
        },
      ],
    };
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all')!, j);
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe(
      'Zs for circuits 1 and 2 is already recorded — say new readings to replace them.'
    );
    expect(out.actionOutcome).toBe('unapplied');
  });

  it('R1+R2 branch: an occupied r1_r2_ohm is never overwritten by Zs − Ze', () => {
    const j: VoiceCommandJob = {
      supply_characteristics: { ze: '0.10' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          measured_zs_ohm: '0.55',
          r1_r2_ohm: '0.20',
        },
        { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets', measured_zs_ohm: '0.60' },
      ],
    };
    const out = applyVoiceCommand(parseVoiceCommand('calculate R1+R2 for all circuits')!, j);
    const next = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(next[0].r1_r2_ohm).toBe('0.20');
    expect(next[1].r1_r2_ohm).toBe('0.50');
    expect(out.response).toBe('Circuit 2, R1 plus R2 calculated as 0.50 ohms');
    expect(out.skippedResults).toEqual([{ circuit: '1', reason: 'already_set' }]);
  });
});

describe('[invariant] A01P Codex cycle-1 — at-DB alias selected by occupancy', () => {
  const rows = [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker', r1_r2_ohm: '0.20' }];
  it('a BLANK zs_at_db beside a populated ze_at_db uses ze_at_db (0.40 + 0.20 = 0.60, not supply 0.70)', () => {
    const job: VoiceCommandJob = {
      boards: [{ id: 'main', board_type: 'main', zs_at_db: '', ze_at_db: '0.40' }],
      supply_characteristics: { earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(job)).toMatchObject({ state: 'finite', value: 0.4, source: 'board_at_db' });
    expect(applyVoiceCommand(parseVoiceCommand('calculate Zs for circuit 1')!, job).response).toBe(
      'Circuit 1, Zs calculated as 0.60 ohms'
    );
  });

  it('an occupied-INVALID zs_at_db still wins the tier: unreadable, never the sibling or supply', () => {
    const job: VoiceCommandJob = {
      boards: [{ id: 'main', board_type: 'main', zs_at_db: 'N/A', ze_at_db: '0.40' }],
      supply_characteristics: { earth_loop_impedance_ze: '0.50' },
      circuits: rows,
    };
    expect(resolveJobZe(job)).toEqual({ state: 'unreadable', raw: 'N/A', source: 'board_at_db' });
  });

  it('both at-DB aliases blank → supply ladder', () => {
    expect(
      resolveJobZe({
        boards: [{ id: 'main', zs_at_db: ' ', ze_at_db: '' }],
        supply_characteristics: { ze: '0.50' },
      })
    ).toMatchObject({ state: 'finite', value: 0.5, source: 'supply_short' });
  });
});

describe('[invariant] A01P Codex cycle-2 — mixed-skip zero-write commands name BOTH reasons', () => {
  it('Zs: circuit 1 occupied, circuit 2 blank but lacking R1+R2 → both named, nothing written, unapplied', () => {
    const job: VoiceCommandJob = {
      supply_characteristics: { ze: '0.35' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          r1_r2_ohm: '0.20',
          measured_zs_ohm: '0.42',
        },
        { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
      ],
    };
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all')!, job);
    expect(out.patch).toBeUndefined();
    expect(out.actionOutcome).toBe('unapplied');
    expect(out.actionReason).toBe('mixed_skips');
    expect(out.skippedResults).toEqual([
      { circuit: '1', reason: 'already_set' },
      { circuit: '2', reason: 'no_r1_r2' },
    ]);
    expect(out.response).toBe(
      'Zs for circuit 1 is already recorded, and circuit 2 has no R1 plus R2 to calculate from.'
    );
  });

  it('R1+R2: occupied row plus a row with no Zs → both named; a Zs-below-Ze row is named as such', () => {
    const base = {
      supply_characteristics: { ze: '0.35' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          measured_zs_ohm: '0.55',
          r1_r2_ohm: '0.20',
        },
        { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
        { id: 'c3', circuit_ref: '3', circuit_designation: 'Lights' },
      ],
    } as VoiceCommandJob;
    const out = applyVoiceCommand(parseVoiceCommand('calculate R1+R2 for all circuits')!, base);
    expect(out.patch).toBeUndefined();
    expect(out.response).toBe(
      'R1 plus R2 for circuit 1 is already recorded, and circuits 2 and 3 have no Zs to calculate from.'
    );
    const below: VoiceCommandJob = {
      supply_characteristics: { ze: '0.35' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          measured_zs_ohm: '0.55',
          r1_r2_ohm: '0.20',
        },
        { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets', measured_zs_ohm: '0.10' },
      ],
    };
    const out2 = applyVoiceCommand(parseVoiceCommand('calculate R1+R2 for all circuits')!, below);
    expect(out2.response).toBe(
      'R1 plus R2 for circuit 1 is already recorded, and circuit 2 has a Zs below Ze to calculate from.'
    );
    expect(out2.skippedResults).toEqual([
      { circuit: '1', reason: 'already_set' },
      { circuit: '2', reason: 'zs_below_ze' },
    ]);
  });

  it('no occupied rows and nothing computable keeps the existing line, now with the skip reasons attached', () => {
    const job: VoiceCommandJob = {
      supply_characteristics: { ze: '0.35' },
      circuits: [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' }],
    };
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all')!, job);
    expect(out.response).toBe('No circuits had the values needed to calculate Zs.');
    expect(out.actionOutcome).toBe('unapplied');
    expect(out.skippedResults).toEqual([{ circuit: '1', reason: 'no_r1_r2' }]);
  });

  it('one occupied row plus one computed row still speaks only the computed value (applied)', () => {
    const job: VoiceCommandJob = {
      supply_characteristics: { ze: '0.35' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Cooker',
          r1_r2_ohm: '0.20',
          measured_zs_ohm: '0.42',
        },
        { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets', r1_r2_ohm: '0.30' },
      ],
    };
    const out = applyVoiceCommand(parseVoiceCommand('calculate Zs for all')!, job);
    expect(out.actionOutcome).toBe('applied');
    expect(out.response).toBe('Circuit 2, Zs calculated as 0.65 ohms');
  });
});
