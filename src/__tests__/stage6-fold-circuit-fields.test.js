/**
 * Bug-I (2026-04-26) — circuit-field name normalisation tests.
 *
 * Backend Stage 6 tool schemas use field_schema.json circuit_fields
 * keys verbatim (e.g. `measured_zs_ohm`). iOS `applyExtractedReadings`
 * (DeepgramRecordingViewModel.swift:3270-3500) dispatches on legacy
 * short aliases (e.g. `zs`). Without a normalisation pass, every
 * circuit-scoped reading from the bundler falls through iOS's switch
 * and never lands in the certificate model — confirmed in field test
 * 2026-04-26 session FA361D70.
 *
 * `foldCircuitFieldsToLegacy` is the pure helper that does the rename.
 * These tests lock the mapping table (regression guard against a future
 * refactor accidentally dropping an entry) AND the boundary conditions
 * (board-scoped untouched, unknown fields untouched, immutability).
 */

import { jest } from '@jest/globals';

import { foldCircuitFieldsToLegacy } from '../extraction/stage6-shadow-harness.js';

describe('foldCircuitFieldsToLegacy — Bug-I', () => {
  describe('mapping table — every schema-canonical → legacy alias iOS accepts', () => {
    // One-row test per mapping. Each row asserts:
    //   1. The canonical-name input lands as the legacy alias on output.
    //   2. circuit, value, confidence, source pass through verbatim.
    // Keep this aligned with CIRCUIT_FIELD_TO_LEGACY in the source.
    const cases = [
      ['measured_zs_ohm', 'zs'],
      ['r1_r2_ohm', 'r1_r2'],
      ['r2_ohm', 'r2'],
      ['ring_r1_ohm', 'ring_continuity_r1'],
      ['ring_rn_ohm', 'ring_continuity_rn'],
      ['ring_r2_ohm', 'ring_continuity_r2'],
      ['ir_live_live_mohm', 'ir_live_live'],
      ['ir_live_earth_mohm', 'ir_live_earth'],
      ['polarity_confirmed', 'polarity'],
      ['rcd_time_ms', 'rcd_trip_time'],
      ['ocpd_rating_a', 'ocpd_rating'],
      ['cpc_csa_mm2', 'cpc_csa'],
      ['live_csa_mm2', 'cable_size'],
      ['circuit_designation', 'designation'],
    ];

    test.each(cases)('%s → %s', (canonical, legacy) => {
      const out = foldCircuitFieldsToLegacy([
        {
          field: canonical,
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
          source: 'tool_call',
        },
      ]);
      expect(out).toEqual([
        {
          field: legacy,
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
          source: 'tool_call',
        },
      ]);
    });
  });

  describe('boundary conditions', () => {
    test('board-scoped reading (circuit:0) passes through unchanged even when field name is in the map', () => {
      // Defensive guard: iOS already accepts the canonical name for board-
      // scoped readings (BOARD_FIELD_ENUM == iOS dispatch surface). If a
      // map entry coincidentally collided with a board field, blindly
      // rewriting would corrupt the iOS dispatch.
      const input = [
        {
          field: 'polarity_confirmed', // (hypothetical collision)
          circuit: 0,
          value: 'yes',
          confidence: 1.0,
          source: 'tool_call',
        },
      ];
      expect(foldCircuitFieldsToLegacy(input)).toEqual(input);
    });

    test('unknown field passes through unchanged (no map entry → pass through)', () => {
      // Fields iOS already accepts via the canonical name (ocpd_type,
      // ocpd_bs_en, rcd_bs_en, wiring_type, number_of_points, etc.) are
      // INTENTIONALLY absent from the map and must hit the pass-through.
      const input = [
        {
          field: 'ocpd_type',
          circuit: 1,
          value: 'B',
          confidence: 1.0,
          source: 'tool_call',
        },
        {
          field: 'wiring_type',
          circuit: 1,
          value: 'D',
          confidence: 1.0,
          source: 'tool_call',
        },
      ];
      expect(foldCircuitFieldsToLegacy(input)).toEqual(input);
    });

    test('mixed batch: board + circuit + unknown — circuit gets renamed, others pass through', () => {
      // Mirrors a realistic post-bundle shape from a turn that touched
      // both scopes (e.g. session FA361D70 turn 7: board reading +
      // circuit reading in the same response).
      const input = [
        {
          field: 'client_name', // board-scoped, unchanged
          circuit: 0,
          value: 'Michael McIntyre',
          confidence: 1.0,
          source: 'tool_call',
        },
        {
          field: 'measured_zs_ohm', // circuit-scoped, renamed
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
          source: 'tool_call',
        },
        {
          field: 'ocpd_type', // circuit-scoped, no map entry, unchanged
          circuit: 1,
          value: 'B',
          confidence: 1.0,
          source: 'tool_call',
        },
      ];
      const out = foldCircuitFieldsToLegacy(input);
      expect(out).toEqual([
        {
          field: 'client_name',
          circuit: 0,
          value: 'Michael McIntyre',
          confidence: 1.0,
          source: 'tool_call',
        },
        {
          field: 'zs', // ← renamed
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
          source: 'tool_call',
        },
        {
          field: 'ocpd_type',
          circuit: 1,
          value: 'B',
          confidence: 1.0,
          source: 'tool_call',
        },
      ]);
    });

    test('empty array → empty array', () => {
      expect(foldCircuitFieldsToLegacy([])).toEqual([]);
    });

    test('non-array input passes through (defensive — caller is responsible for shape)', () => {
      // The shadow-harness call site already guards Array.isArray, but
      // the helper is exported as a pure utility. Returning the input
      // verbatim on non-array (rather than throwing) keeps it composable
      // without surprise.
      expect(foldCircuitFieldsToLegacy(null)).toBeNull();
      expect(foldCircuitFieldsToLegacy(undefined)).toBeUndefined();
      expect(foldCircuitFieldsToLegacy('not-an-array')).toBe('not-an-array');
    });

    test('does NOT mutate input array or its entries', () => {
      // A rewritten entry must be a new object so callers retaining a
      // reference to the original see no field-name change. Same array-
      // identity contract as Object.entries / Array.map.
      const original = [
        {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
        },
      ];
      const snapshot = JSON.parse(JSON.stringify(original));
      const out = foldCircuitFieldsToLegacy(original);
      expect(original).toEqual(snapshot); // input untouched
      expect(out).not.toBe(original); // new array
      expect(out[0]).not.toBe(original[0]); // new entry object
    });
  });

  describe('FA361D70 regression replay (2026-04-26 field test)', () => {
    // The exact bundled shape that Sonnet produced during session
    // FA361D70 — three circuit-scoped readings that all silently
    // dropped on iOS Build 302. Pinning the expected post-fold shape
    // here gives us a one-glance regression check if the map ever
    // changes.
    test('T3 R1+R2 + T4 Zs + meta-folded designation all rename correctly', () => {
      const input = [
        // T3: record_reading(r1_r2_ohm, c=1, 0.86)
        {
          field: 'r1_r2_ohm',
          circuit: 1,
          value: '0.86',
          confidence: 0.95,
          source: 'tool_call',
        },
        // T4: record_reading(measured_zs_ohm, c=1, 0.32)
        {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.32',
          confidence: 0.95,
          source: 'tool_call',
        },
        // T5 Bug-G fold: create_circuit(3, designation="upstairs lights")
        // → already mapped to legacy `designation` by Bug-G's
        // META_TO_LEGACY_FIELD upstream. Here we assert it isn't
        // double-touched (legacy passes through unchanged).
        {
          field: 'designation',
          circuit: 3,
          value: 'upstairs lights',
          confidence: 1.0,
          source: 'tool_call',
        },
      ];
      const out = foldCircuitFieldsToLegacy(input);
      expect(out.map((r) => r.field)).toEqual(['r1_r2', 'zs', 'designation']);
      // Values, circuits, confidences all preserved.
      expect(out.map((r) => `${r.field}@${r.circuit}=${r.value}`)).toEqual([
        'r1_r2@1=0.86',
        'zs@1=0.32',
        'designation@3=upstairs lights',
      ]);
    });
  });

  // jest is imported but the suite uses no spies — keep the import to
  // match the rest of the Stage 6 test surface (ESM module loader expects
  // it in tests that run alongside mocked-stream suites).
  test('jest import sanity (no-op)', () => {
    expect(typeof jest).toBe('object');
  });
});
