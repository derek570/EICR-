/**
 * §A2 (field-feedback-2026-07-14) — SEMANTIC round-trip audit for the
 * clear_reading wire. THIS TEST GATES THE BACKEND DEPLOY: the backend-first
 * rollout order makes a wrong clearer mapping live for every build-418
 * device the moment the canonicalised wire deploys, so a presence-only check
 * is not enough — it passes wrongly on at least one mapping (FIELD_CORRECTIONS
 * maps `r2_ohm` → `r2`, and the deployed clearer maps `r2` → the R1+R2 cell:
 * "clear R2" would wipe R1+R2 and leave R2 populated).
 *
 * For EVERY field in the clear_reading schema enum this asserts the full
 * chain — raw dispatcher key → FIELD_CORRECTIONS wire key (with
 * CLEAR_WIRE_EXEMPT) → iOS Stage6FieldClearer.snakeToCamel → clearField
 * property — lands on the SAME Circuit property the record-APPLY path
 * writes for that raw key. Swift tables are committed fixture copies
 * (tests/fixtures/ios-stage6-field-clearer.fixture.json — drift pointers in
 * the fixture header; the backend gate cannot execute Swift).
 *
 * Two lanes:
 *   - NEXT table (deploy gate): the table the field-feedback iOS PR ships —
 *     every clearable field must round-trip to the correct cell.
 *   - BUILD-418 compatibility: under the CURRENTLY DEPLOYED table the
 *     canonicalised wire must NEVER land on a DIFFERENT cell than the raw
 *     key would — a benign no-op (unknown key) is allowed during the
 *     rollout window (F5 closes only after TestFlight), a mis-clear is not.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { FIELD_CORRECTIONS } from '../extraction/field-name-corrections.js';
import { CLEAR_WIRE_EXEMPT } from '../extraction/stage6-event-bundler.js';
import { CLEAR_READING_FIELD_ENUM, TOOL_SCHEMAS } from '../extraction/stage6-tool-schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', '..', 'tests', 'fixtures', 'ios-stage6-field-clearer.fixture.json'),
    'utf8'
  )
);

const snake418 = fixture.snakeToCamel_build418;
const snakeNext = { ...snake418, ...fixture.snakeToCamel_next_additions };
const canon418 = fixture.canonicalToProperty_build418;
const canonNext = { ...canon418, ...fixture.canonicalToProperty_next_additions };
const applyMap = fixture.liveApplyWireToProperty;

/** The wire key the canonicalised clear path emits for a raw dispatcher key. */
function clearWireKey(raw) {
  return CLEAR_WIRE_EXEMPT.has(raw) ? raw : (FIELD_CORRECTIONS[raw] ?? raw);
}

/** The Circuit property a given clearer table clears for a wire key (undefined = no-op). */
function clearedProperty(wireKey, snakeTable, canonTable) {
  const canonical = snakeTable[wireKey] ?? wireKey;
  return canonTable[canonical];
}

describe('§A2 clear_reading semantic round-trip audit (DEPLOY GATE)', () => {
  test('audit domain equals the clear_reading schema enum EXACTLY (no silent narrowing)', () => {
    // The schema source enum and the tool actually registered must agree…
    const registered = TOOL_SCHEMAS.find((t) => t.name === 'clear_reading');
    expect(registered.input_schema.properties.field.enum).toEqual(CLEAR_READING_FIELD_ENUM);
    // …the three excluded fields are OUT…
    for (const excluded of ['circuit_ref', 'is_distribution_circuit', 'feeds_board_id']) {
      expect(CLEAR_READING_FIELD_ENUM).not.toContain(excluded);
    }
    // …and every enum member has a record-APPLY cell to audit against (the
    // audit below iterates this exact list — nothing is skipped).
    for (const raw of CLEAR_READING_FIELD_ENUM) {
      const recordWire = FIELD_CORRECTIONS[raw] ?? raw;
      expect(applyMap[recordWire]).toBeDefined();
    }
  });

  test('NEXT clearer table: every clearable field clears the SAME Circuit property the record-APPLY path writes', () => {
    const failures = [];
    for (const raw of CLEAR_READING_FIELD_ENUM) {
      const recordWire = FIELD_CORRECTIONS[raw] ?? raw;
      const applyProp = applyMap[recordWire];
      // The live apply switch also accepts the RAW schema key on every
      // circuit field — both routes must agree on the cell.
      if (applyMap[raw] !== applyProp) {
        failures.push(`${raw}: raw-apply ${applyMap[raw]} != canonical-apply ${applyProp}`);
      }
      const clearProp = clearedProperty(clearWireKey(raw), snakeNext, canonNext);
      if (clearProp !== applyProp) {
        failures.push(
          `${raw}: clear wire '${clearWireKey(raw)}' clears '${clearProp}' but record-apply writes '${applyProp}'`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('BUILD-418 compatibility: canonicalised clear wire never lands on a DIFFERENT cell than the raw key (no-op allowed, mis-clear not)', () => {
    const failures = [];
    for (const raw of CLEAR_READING_FIELD_ENUM) {
      const recordWire = FIELD_CORRECTIONS[raw] ?? raw;
      const applyProp = applyMap[recordWire];
      const prop418 = clearedProperty(clearWireKey(raw), snake418, canon418);
      if (prop418 !== undefined && prop418 !== applyProp) {
        failures.push(
          `${raw}: on build-418 the canonicalised wire '${clearWireKey(raw)}' clears '${prop418}' but the value lives in '${applyProp}' — MIS-CLEAR`
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('the r2_ohm exemption is the load-bearing case: WITHOUT it build-418 would mis-clear R1+R2', () => {
    // Prove the exemption is not vestigial: run the 418 chain on the
    // UNEXEMPTED canonical key and show it lands on the wrong cell.
    const canonicalised = FIELD_CORRECTIONS['r2_ohm']; // 'r2'
    expect(canonicalised).toBe('r2');
    const wrongProp = clearedProperty(canonicalised, snake418, canon418);
    expect(wrongProp).toBe('r1R2Ohm'); // the R1+R2 cell — NOT r2Ohm
    // With the exemption the wire keeps r2_ohm and clears the right cell.
    expect(CLEAR_WIRE_EXEMPT.has('r2_ohm')).toBe(true);
    expect(clearedProperty(clearWireKey('r2_ohm'), snake418, canon418)).toBe('r2Ohm');
  });

  test('F5 pin: clear r1_r2_ohm wire key is r1_plus_r2, resolved by the NEXT table (open on 418 as a benign no-op until TestFlight)', () => {
    expect(clearWireKey('r1_r2_ohm')).toBe('r1_plus_r2');
    expect(clearedProperty('r1_plus_r2', snakeNext, canonNext)).toBe('r1R2Ohm');
    // Build-418: unknown key → benign no-op, never a different cell.
    expect(clearedProperty('r1_plus_r2', snake418, canon418)).toBeUndefined();
  });
});
