/**
 * PLAN-2D — the final-wire field contract is a complete four-way partition,
 * not a hand-maintained warning allowlist.
 */

import {
  BOARD_FIELD_ENUM,
  CIRCUIT_FIELD_ENUM,
} from '../extraction/stage6-tool-schemas.js';
import { FIELD_CORRECTIONS } from '../extraction/field-name-corrections.js';
import { KNOWN_FIELDS } from '../extraction/known-fields.js';
import {
  BOARD_READING_SCOPE_MAP,
  CLIENT_ROUTABLE_READING_FIELDS,
  CLIENT_ROUTABLE_READING_ROUTES,
  CORRECTION_BYPASS_EXEMPTIONS,
  CORRECTION_WIRE_DECISIONS,
  STRUCTURAL_READING_FIELDS,
  UNROUTABLE_READING_FIELDS,
} from '../extraction/client-routable-reading-fields.js';
import { readFileSync } from 'node:fs';

const ROUTE_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../tests/fixtures/test-contracts/client-routable-reading-fields.json',
      import.meta.url
    ),
    'utf8'
  )
);

const enumFields = new Set([...BOARD_FIELD_ENUM, ...CIRCUIT_FIELD_ENUM]);
const correctionKeys = new Set(
  [...enumFields].filter((field) => Object.hasOwn(FIELD_CORRECTIONS, field))
);

function intersection(a, b) {
  return new Set([...a].filter((value) => b.has(value)));
}

describe('PLAN-2D reading-field manifests', () => {
  test('dispatcher enums form one complete pairwise-disjoint four-way partition', () => {
    const partitions = [
      correctionKeys,
      intersection(enumFields, STRUCTURAL_READING_FIELDS),
      intersection(enumFields, UNROUTABLE_READING_FIELDS),
      intersection(enumFields, CLIENT_ROUTABLE_READING_FIELDS),
    ];

    for (let left = 0; left < partitions.length; left += 1) {
      for (let right = left + 1; right < partitions.length; right += 1) {
        expect(intersection(partitions[left], partitions[right])).toEqual(new Set());
      }
    }

    expect(new Set(partitions.flatMap((set) => [...set]))).toEqual(enumFields);
  });

  test('KNOWN_FIELDS is exactly the authoritative client-routable manifest', () => {
    expect(KNOWN_FIELDS).toEqual(CLIENT_ROUTABLE_READING_FIELDS);
    expect(new Set(Object.keys(CLIENT_ROUTABLE_READING_ROUTES))).toEqual(KNOWN_FIELDS);
    expect(ROUTE_FIXTURE).toEqual(CLIENT_ROUTABLE_READING_ROUTES);
  });

  test('every dispatcher correction lands on a committed client route', () => {
    for (const rawField of correctionKeys) {
      expect(CLIENT_ROUTABLE_READING_FIELDS.has(FIELD_CORRECTIONS[rawField])).toBe(true);
    }
  });

  test('correction bypass intersection equals the explicit exemption contract', () => {
    const actual = new Set(
      [...KNOWN_FIELDS].filter((field) => Object.hasOwn(FIELD_CORRECTIONS, field))
    );
    expect(actual).toEqual(new Set(Object.keys(CORRECTION_BYPASS_EXEMPTIONS)));
    expect(CORRECTION_BYPASS_EXEMPTIONS).toEqual({});
  });

  test.each([
    ['cpc_csa_mm2', 'cable_size_earth'],
    ['max_zs', 'ocpd_max_zs_ohm'],
    ['ocpd_max_zs', 'ocpd_max_zs_ohm'],
  ])('%s uses the adjudicated final wire name %s', (rawField, wireField) => {
    expect(CORRECTION_WIRE_DECISIONS[rawField]).toBe(wireField);
    expect(FIELD_CORRECTIONS[rawField]).toBe(wireField);
    expect(KNOWN_FIELDS.has(rawField)).toBe(false);
    expect(KNOWN_FIELDS.has(wireField)).toBe(true);
  });

  test('write-scope map covers every non-circuit client destination, without widening clears', () => {
    const expected = Object.fromEntries(
      Object.entries(CLIENT_ROUTABLE_READING_ROUTES)
        .filter(([, route]) => route !== 'circuit')
        .map(([field, route]) => [field, route === 'board_info' ? 'board' : 'global'])
    );
    expect(BOARD_READING_SCOPE_MAP).toEqual(expected);
  });
});

describe('PLAN-2D final egress guard', () => {
  test('three adjudicated overlaps are corrected and an off-manifest field is suppressed leak-free', async () => {
    const { _test_validateAndCorrectFields } = await import('../extraction/sonnet-stream.js');
    const result = {
      extracted_readings: [
        { field: 'cpc_csa_mm2', circuit: 1, value: '1.5' },
        { field: 'max_zs', circuit: 1, value: '1.44' },
        { field: 'ocpd_max_zs', circuit: 2, value: '0.72' },
        { field: '__synthetic_off_manifest__', circuit: 1, value: 'secret-model-value' },
      ],
      confirmations: [
        { field: 'cable_size_earth', circuit: 1, text: 'CPC CSA is 1.5' },
        {
          field: '__synthetic_off_manifest__',
          circuit: 1,
          text: '__synthetic_off_manifest__ is secret-model-value',
        },
        {
          field: null,
          text: 'I also saw __synthetic_off_manifest__ as secret-model-value',
        },
      ],
      spoken_response: '__synthetic_off_manifest__ is secret-model-value',
      action: {
        type: 'set_field',
        field: '__synthetic_off_manifest__',
        value: 'secret-model-value',
      },
    };

    _test_validateAndCorrectFields(result, 'plan2d-egress');

    expect(result.extracted_readings.map((reading) => reading.field)).toEqual([
      'cable_size_earth',
      'ocpd_max_zs_ohm',
      'ocpd_max_zs_ohm',
    ]);
    expect(result.confirmations).toEqual([
      { field: 'cable_size_earth', circuit: 1, text: 'CPC CSA is 1.5' },
    ]);
    expect(result.spoken_response).toMatch(/didn't match a field I recognise/i);
    expect(result.action).toBeNull();
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('__synthetic_off_manifest__');
    expect(wire).not.toContain('secret-model-value');
  });
});
