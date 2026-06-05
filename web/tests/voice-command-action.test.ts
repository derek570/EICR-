/**
 * `mapServerActionToVoiceCommand` — maps server-side
 * `voice_command_response.action` (iOS-canon shape from
 * `src/extraction/sonnet-stream.js:2322`) onto the web's
 * `VoiceCommand` discriminated union so `applyVoiceCommand` can
 * execute it.
 *
 * Mirrors iOS `VoiceCommandExecutor.execute(action:jobVM:)` switch
 * (CertMateUnified/Sources/Recording/VoiceCommandExecutor.swift:28).
 */

import { describe, expect, it } from 'vitest';
import { mapServerActionToVoiceCommand } from '../src/lib/recording/voice-command-action';

describe('mapServerActionToVoiceCommand — update_field', () => {
  it('maps a circuit-scoped update', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'update_field',
      params: { field: 'ocpd_rating_a', value: '32', circuit: 4 },
    });
    expect(cmd).toEqual({
      type: 'update_field',
      field: 'ocpd_rating_a',
      value: '32',
      circuit: 4,
    });
  });

  it('maps a supply-level update (no circuit)', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'update_field',
      params: { field: 'ze', value: '0.35' },
    });
    expect(cmd).toEqual({
      type: 'update_field',
      field: 'ze',
      value: '0.35',
      circuit: undefined,
    });
  });

  it('returns null when field is missing', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'update_field',
        params: { value: '32', circuit: 1 },
      })
    ).toBeNull();
  });

  it('returns null when value is missing', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'update_field',
        params: { field: 'zs', circuit: 1 },
      })
    ).toBeNull();
  });
});

describe('mapServerActionToVoiceCommand — query_field', () => {
  it('maps a circuit-scoped query', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'query_field',
      params: { field: 'zs', circuit: 3 },
    });
    expect(cmd).toEqual({ type: 'query_field', field: 'zs', circuit: 3 });
  });

  it('maps a supply-level query (no circuit)', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'query_field',
      params: { field: 'ze' },
    });
    expect(cmd).toEqual({ type: 'query_field', field: 'ze', circuit: undefined });
  });

  it('returns null when field is missing', () => {
    expect(
      mapServerActionToVoiceCommand({ type: 'query_field', params: { circuit: 1 } })
    ).toBeNull();
  });
});

describe('mapServerActionToVoiceCommand — reorder_circuits', () => {
  it('maps the first circuit_moves entry', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'reorder_circuits',
      params: { circuit_moves: [{ from: 7, to: 3 }] },
    });
    expect(cmd).toEqual({ type: 'reorder_circuits', from: 7, to: 3 });
  });

  it('returns null when circuit_moves is empty', () => {
    expect(
      mapServerActionToVoiceCommand({ type: 'reorder_circuits', params: { circuit_moves: [] } })
    ).toBeNull();
  });

  it('returns null when circuit_moves is missing', () => {
    expect(mapServerActionToVoiceCommand({ type: 'reorder_circuits', params: {} })).toBeNull();
  });
});

describe('mapServerActionToVoiceCommand — calculate_impedance', () => {
  it('maps all-scope Zs', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'calculate_impedance',
        params: { calculate: 'zs', circuits: 'all' },
      })
    ).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'all' },
    });
  });

  it('maps single-scope R1+R2 via circuit field', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'calculate_impedance',
        params: { calculate: 'r1_r2', circuit: 2 },
      })
    ).toEqual({
      type: 'calculate_impedance',
      kind: 'r1_r2',
      scope: { kind: 'single', circuit: 2 },
    });
  });

  it('maps range-scope via circuit_from / circuit_to', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'calculate_impedance',
        params: { calculate: 'zs', circuit_from: 2, circuit_to: 5 },
      })
    ).toEqual({
      type: 'calculate_impedance',
      kind: 'zs',
      scope: { kind: 'range', from: 2, to: 5 },
    });
  });

  it('returns null when calculate kind is unrecognised', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'calculate_impedance',
        params: { calculate: 'wibble', circuits: 'all' },
      })
    ).toBeNull();
  });

  it('returns null when scope cannot be resolved', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'calculate_impedance',
        params: { calculate: 'zs' },
      })
    ).toBeNull();
  });
});

describe('mapServerActionToVoiceCommand — apply_field', () => {
  it('maps an all-scope batch', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'apply_field',
        params: { field: 'polarity', value: 'PASS', circuits: 'all' },
      })
    ).toEqual({
      type: 'apply_field',
      field: 'polarity',
      value: 'PASS',
      scope: { kind: 'all' },
    });
  });

  it('maps a range-scope batch', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'apply_field',
        params: { field: 'test_voltage', value: '250', circuit_from: 1, circuit_to: 4 },
      })
    ).toEqual({
      type: 'apply_field',
      field: 'test_voltage',
      value: '250',
      scope: { kind: 'range', from: 1, to: 4 },
    });
  });

  it('returns null when scope cannot be resolved', () => {
    expect(
      mapServerActionToVoiceCommand({
        type: 'apply_field',
        params: { field: 'polarity', value: 'PASS' },
      })
    ).toBeNull();
  });
});

describe('mapServerActionToVoiceCommand — unknown / malformed actions', () => {
  it('returns null for an unknown action.type', () => {
    expect(
      mapServerActionToVoiceCommand({ type: 'add_circuit', params: { circuit_ref: '1' } })
    ).toBeNull();
  });

  it('returns null when action.type is absent', () => {
    expect(mapServerActionToVoiceCommand({ params: { field: 'zs', value: '0.35' } })).toBeNull();
  });

  it('tolerates a missing params object', () => {
    expect(mapServerActionToVoiceCommand({ type: 'update_field' })).toBeNull();
  });
});
