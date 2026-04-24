/**
 * Phase 5 — apply-defaults tests.
 *
 * Covers the pure helpers ported from iOS
 * `DefaultsService.applyDefaults(to:)` +
 * `CertificateDefaultsService.applyCableDefaults(to:)`.
 *
 * The key invariant is **never overwrite a non-empty field** — we test
 * that explicitly because it's the subtle iOS behaviour every electrician
 * relies on. An inspector who spent 20 minutes tapping 4.0mm² should not
 * have it silently replaced by the 2.5mm² socket default.
 */

import { describe, expect, it } from 'vitest';
import {
  applyDefaultsToCircuit,
  applyDefaultsToCircuits,
  DEFAULTS_BY_CIRCUIT,
  inferCircuitType,
} from '@certmate/shared-utils';
import type { Circuit } from '@certmate/shared-types';

describe('inferCircuitType', () => {
  it('detects sockets / rings', () => {
    expect(inferCircuitType({ circuit_designation: 'Kitchen sockets' })?.type).toBe('socket');
    expect(inferCircuitType({ circuit_designation: 'Ring final, hall' })?.type).toBe('socket');
  });

  it('splits upstairs vs downstairs lighting', () => {
    expect(
      inferCircuitType({ circuit_designation: 'Upstairs lighting', ocpd_rating_a: '6' })?.specific
    ).toBe('lighting_6a_upstairs');
    expect(
      inferCircuitType({ circuit_designation: 'Downstairs lighting', ocpd_rating_a: '6' })?.specific
    ).toBe('lighting_6a_downstairs');
  });

  it('detects shower / cooker / immersion', () => {
    expect(inferCircuitType({ circuit_designation: 'Electric shower' })?.type).toBe('shower');
    expect(inferCircuitType({ circuit_designation: 'Cooker' })?.type).toBe('cooker');
    expect(inferCircuitType({ circuit_designation: 'Hot water immersion' })?.type).toBe(
      'immersion'
    );
  });

  it('returns null for ambiguous designations', () => {
    expect(inferCircuitType({ circuit_designation: 'Mystery circuit' })).toBeNull();
    expect(inferCircuitType({ circuit_designation: '' })).toBeNull();
  });
});

describe('applyDefaultsToCircuit — non-overwrite invariant', () => {
  it('fills empty fields on a socket circuit', () => {
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Sockets ring',
    };
    const res = applyDefaultsToCircuit(input);
    expect(res.circuit.live_csa_mm2).toBe('2.5');
    expect(res.circuit.cpc_csa_mm2).toBe('1.5');
    expect(res.circuit.ocpd_rating_a).toBe('32');
    expect(res.circuit.max_disconnect_time_s).toBe('0.4');
    expect(res.circuit.ocpd_type).toBe('B');
    expect(res.filledFields).toBeGreaterThan(0);
  });

  it('NEVER overwrites a field the inspector has already set', () => {
    // Inspector ran 4.0mm² instead of the default 2.5 — apply must
    // leave it alone. This is the subtle invariant that guarantees
    // repeated Apply Defaults presses are idempotent after the first.
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Sockets ring',
      live_csa_mm2: '4.0',
      cpc_csa_mm2: '2.5',
      ocpd_rating_a: '40',
      max_disconnect_time_s: '0.5',
    };
    const res = applyDefaultsToCircuit(input);
    expect(res.circuit.live_csa_mm2).toBe('4.0'); // NOT 2.5
    expect(res.circuit.cpc_csa_mm2).toBe('2.5'); // matches default but set by user
    expect(res.circuit.ocpd_rating_a).toBe('40'); // NOT 32
    expect(res.circuit.max_disconnect_time_s).toBe('0.5'); // NOT 0.4
  });

  it('treats whitespace-only values as empty (fills them)', () => {
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Sockets',
      live_csa_mm2: '   ',
    };
    const res = applyDefaultsToCircuit(input);
    expect(res.circuit.live_csa_mm2).toBe('2.5');
  });

  it('skips per-type defaults for ambiguous circuits but still applies globals', () => {
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Spare',
    };
    const res = applyDefaultsToCircuit(input);
    // No per-type values filled (live_csa/cpc_csa/ocpd_rating stay empty)
    expect(res.circuit.live_csa_mm2).toBeUndefined();
    expect(res.circuit.ocpd_rating_a).toBeUndefined();
    // But global defaults DO apply.
    expect(res.circuit.max_disconnect_time_s).toBe('0.4');
    expect(res.circuit.ocpd_type).toBe('B');
    // Ambiguous only when ZERO fields are filled — globals filled some.
    expect(res.ambiguous).toBe(false);
  });

  it('picks up per-type cpc default for lighting (1.0)', () => {
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Upstairs lighting',
      ocpd_rating_a: '6',
    };
    const res = applyDefaultsToCircuit(input);
    expect(res.circuit.live_csa_mm2).toBe('1.0');
    expect(res.circuit.cpc_csa_mm2).toBe('1.0');
  });

  it('applies user-global defaults over schema defaults when both exist', () => {
    // Layer-1 wins because it runs first; layers 2/3 only fill empties.
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Sockets ring',
    };
    const res = applyDefaultsToCircuit(input, {
      userDefaults: { wiring_type: 'A', ref_method: 'C' },
    });
    expect(res.circuit.wiring_type).toBe('A');
    expect(res.circuit.ref_method).toBe('C');
  });

  it('user defaults with empty values do NOT overwrite schema defaults', () => {
    const input: Partial<Circuit> = {
      id: '1',
      circuit_ref: '1',
      circuit_designation: 'Sockets ring',
    };
    const res = applyDefaultsToCircuit(input, {
      userDefaults: { max_disconnect_time_s: '' },
    });
    expect(res.circuit.max_disconnect_time_s).toBe('0.4');
  });
});

describe('applyDefaultsToCircuits — bulk', () => {
  it('summarises filled fields across multiple circuits', () => {
    const input: Partial<Circuit>[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Sockets' },
      { id: '2', circuit_ref: '2', circuit_designation: 'Shower' },
      { id: '3', circuit_ref: '3', circuit_designation: 'Spare' },
    ];
    const res = applyDefaultsToCircuits(input);
    expect(res.summary.touchedCircuits).toBe(3);
    expect(res.summary.filledFields).toBeGreaterThan(5);
    expect(res.circuits[0].live_csa_mm2).toBe('2.5');
    expect(res.circuits[1].live_csa_mm2).toBe('10.0');
    // Spare only gets globals, not per-type.
    expect(res.circuits[2].live_csa_mm2).toBeUndefined();
    expect(res.circuits[2].max_disconnect_time_s).toBe('0.4');
  });

  it('preserves the input array identity when nothing is filled', () => {
    const input: Partial<Circuit>[] = [
      {
        id: '1',
        circuit_ref: '1',
        circuit_designation: 'Sockets',
        live_csa_mm2: '2.5',
        cpc_csa_mm2: '1.5',
        ocpd_rating_a: '32',
        max_disconnect_time_s: '0.4',
        ocpd_type: 'B',
        ocpd_breaking_capacity_ka: '6',
        rcd_operating_current_ma: '30',
        ir_test_voltage_v: '500',
      },
    ];
    const res = applyDefaultsToCircuits(input);
    expect(res.summary.filledFields).toBe(0);
    expect(res.circuits).toBe(input);
  });
});

describe('schema subset vs field_schema.json alignment', () => {
  // Sentinel test — if the schema changes upstream and we forget to
  // re-copy, this test fails. Values hand-transcribed from
  // config/field_schema.json defaults_by_circuit (2026-04 snapshot).
  it('DEFAULTS_BY_CIRCUIT matches the iOS/schema source of truth', () => {
    expect(DEFAULTS_BY_CIRCUIT.live_csa_mm2).toEqual({
      lighting: '1.0',
      socket: '2.5',
      cooker: '6.0',
      shower: '10.0',
      immersion: '2.5',
    });
    expect(DEFAULTS_BY_CIRCUIT.cpc_csa_mm2).toEqual({
      lighting: '1.0',
      socket: '1.5',
      cooker: '2.5',
      shower: '4.0',
      immersion: '1.5',
    });
    expect(DEFAULTS_BY_CIRCUIT.ocpd_rating_a).toEqual({
      lighting: '6',
      socket: '32',
      cooker: '32',
      shower: '40',
      immersion: '16',
    });
  });
});
