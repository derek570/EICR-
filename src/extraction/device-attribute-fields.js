/**
 * PLAN-F item 1 (2026-08-12, feedback id 115) — the closed list of
 * "device-attribute" circuit fields that include spares by default in bulk
 * apply ("RCD type for all circuits including spares"). A spare way with a
 * fitted device shares the device's spec attributes, unlike a measurement/
 * reading field (a spare has no readings).
 *
 * Defined as the UNION of field_schema.json's OCPD and RCD field_groups (8
 * fields), generated from the live schema so a future schema addition
 * cannot silently diverge from this classifier — see the drift assertion
 * test (stage6-device-attribute-fields.test.js), which checks this module
 * against FIELD_SCHEMA directly.
 *
 * Cross-repo drift: CertMateUnified is a SEPARATE git repo with no schema
 * access at test time (and backend CI has no access to iOS files either).
 * The committed JSON manifest at
 * tests/fixtures/test-contracts/device-attribute-fields.json is the
 * cross-repo drift-detection artifact — CertMateUnified carries a
 * byte-identical copy pinned by SHA-256 in
 * DeviceAttributeFieldsContractTests.swift, following the
 * client-routable-reading-fields.json / ClientRoutableReadingContractTests
 * precedent (PLAN-2D). When the schema changes: this test fails, the
 * manifest JSON is regenerated, and the new digest is propagated to the
 * iOS fixture + pin (same regenerate-and-sync loop).
 */
import { createRequire } from 'node:module';

const fieldSchemaRequire = createRequire(import.meta.url);
const FIELD_SCHEMA = fieldSchemaRequire('../../config/field_schema.json');

const DEVICE_ATTRIBUTE_GROUP_NAMES = Object.freeze(['OCPD', 'RCD']);

function unionOfGroups(groupNames) {
  const fields = [];
  for (const group of FIELD_SCHEMA.field_groups ?? []) {
    if (groupNames.includes(group.name)) {
      fields.push(...(group.fields ?? []));
    }
  }
  return fields;
}

export const DEVICE_ATTRIBUTE_FIELDS = new Set(unionOfGroups(DEVICE_ATTRIBUTE_GROUP_NAMES));
