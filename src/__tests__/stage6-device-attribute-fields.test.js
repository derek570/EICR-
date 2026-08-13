/**
 * PLAN-F item 1 (feedback id 115) — DEVICE_ATTRIBUTE_FIELDS drift assertion.
 *
 * DEVICE_ATTRIBUTE_FIELDS is defined as the union of field_schema.json's
 * OCPD and RCD field_groups. This test pins the union directly against the
 * live schema (so a future schema addition to either group is caught here,
 * not silently) AND pins it against the committed JSON manifest fixture,
 * which is the artifact CertMateUnified's Swift test reads (that repo has
 * no schema access at test time) — see device-attribute-fields.js for the
 * full cross-repo drift-detection story.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_ATTRIBUTE_FIELDS } from '../extraction/device-attribute-fields.js';

const fieldSchemaRequire = createRequire(import.meta.url);
const FIELD_SCHEMA = fieldSchemaRequire('../../config/field_schema.json');

const MANIFEST_FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/test-contracts/device-attribute-fields.json', import.meta.url),
    'utf8'
  )
);

function liveOcpdRcdUnion() {
  const fields = [];
  for (const group of FIELD_SCHEMA.field_groups ?? []) {
    if (group.name === 'OCPD' || group.name === 'RCD') {
      fields.push(...(group.fields ?? []));
    }
  }
  return new Set(fields);
}

describe('PLAN-F DEVICE_ATTRIBUTE_FIELDS drift assertion', () => {
  test('DEVICE_ATTRIBUTE_FIELDS == live union of the schema OCPD + RCD field_groups', () => {
    expect(DEVICE_ATTRIBUTE_FIELDS).toEqual(liveOcpdRcdUnion());
  });

  test('DEVICE_ATTRIBUTE_FIELDS is exactly the documented 8-field closed list', () => {
    expect([...DEVICE_ATTRIBUTE_FIELDS].sort()).toEqual([
      'ocpd_breaking_capacity_ka',
      'ocpd_bs_en',
      'ocpd_max_zs_ohm',
      'ocpd_rating_a',
      'ocpd_type',
      'rcd_bs_en',
      'rcd_operating_current_ma',
      'rcd_type',
    ]);
  });

  test('the committed JSON manifest (cross-repo iOS drift artifact) matches the live classifier', () => {
    expect(new Set(MANIFEST_FIXTURE)).toEqual(DEVICE_ATTRIBUTE_FIELDS);
  });
});
