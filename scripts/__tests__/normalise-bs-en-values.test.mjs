/**
 * Unit tests for normalise-bs-en-values.js — pure-function coverage of
 * the mapping table + per-snapshot walk. The DB plumbing (CLI runner +
 * pg.Pool + UPDATE statements) is integration-level and is not covered
 * here; those run against a real PostgreSQL instance via the manual
 * `node scripts/normalise-bs-en-values.js --apply` invocation.
 *
 * Uses node's built-in test runner (no jest dependency) so the script
 * tests stay independent of the main src/__tests__ jest config.
 *
 * Run with:  node --test scripts/__tests__/normalise-bs-en-values.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseField, normaliseSnapshot, _MAPS } from '../normalise-bs-en-values.js';

// ---------------------------------------------------------------------------
// normaliseField — single-value lookup
// ---------------------------------------------------------------------------

test('normaliseField — empty / null / non-string → no change, no unknown flag', () => {
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, ''), { changed: false });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, null), { changed: false });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, '   '), { changed: false });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, 42), {
    changed: false,
    unknown: true,
    before: 42,
  });
});

test('normaliseField — canonical value already matches → no change', () => {
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, '61008'), { changed: false });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, '61009'), { changed: false });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, 'N/A'), { changed: false });
});

test('normaliseField — common rcd_bs_en variants normalise to canonical', () => {
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, 'BS EN 61008'), {
    changed: true,
    before: 'BS EN 61008',
    after: '61008',
  });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, 'BS 61009'), {
    changed: true,
    before: 'BS 61009',
    after: '61009',
  });
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, '61008-1'), {
    changed: true,
    before: '61008-1',
    after: '61008',
  });
});

test('normaliseField — N/A synonyms map to canonical "N/A"', () => {
  assert.equal(normaliseField(_MAPS.rcd_bs_en, 'na').after, 'N/A');
  assert.equal(normaliseField(_MAPS.rcd_bs_en, 'none').after, 'N/A');
  assert.equal(normaliseField(_MAPS.rcd_bs_en, 'no rcd').after, 'N/A');
  assert.equal(normaliseField(_MAPS.rcd_bs_en, 'No RCD').after, 'N/A'); // case-insensitive
});

test('normaliseField — unknown values are flagged but preserved', () => {
  assert.deepEqual(normaliseField(_MAPS.rcd_bs_en, 'made up value'), {
    changed: false,
    unknown: true,
    before: 'made up value',
  });
});

test('normaliseField — case-insensitive lookup, canonical case in output', () => {
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'mcb').after, '60898-1');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'MCB').after, '60898-1');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'Mcb').after, '60898-1');
});

test('normaliseField — ocpd_bs_en MCB variants normalise to "60898-1"', () => {
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, '60898').after, '60898-1');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'BS 60898').after, '60898-1');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'BS EN 60898').after, '60898-1');
});

test('normaliseField — ocpd_bs_en HRC fuse: BS 88-2 / BS 88-3 → "60269-2"', () => {
  // BS 88-2 is the historical UK designation; BS EN 60269-2 is the
  // harmonised European equivalent and what BS_EN_LOOKUP.gG / .HRC writes.
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'BS 88-2').after, '60269-2');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, '88-2').after, '60269-2');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'BS 88-3').after, '60269-2');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'gG').after, '60269-2');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'HRC').after, '60269-2');
});

test('normaliseField — ocpd_bs_en rewireable + cartridge keep the BS prefix in canonical form', () => {
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, '3036').after, 'BS 3036');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'rewireable').after, 'BS 3036');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, '1361').after, 'BS 1361');
  assert.equal(normaliseField(_MAPS.ocpd_bs_en, 'cartridge').after, 'BS 1361');
});

// ---------------------------------------------------------------------------
// normaliseSnapshot — full-blob walk
// ---------------------------------------------------------------------------

test('normaliseSnapshot — null / non-circuit input → no mutation', () => {
  assert.deepEqual(normaliseSnapshot(null), {
    mutated: false,
    snapshot: null,
    changes: [],
    unknowns: [],
  });
  assert.deepEqual(normaliseSnapshot({}), {
    mutated: false,
    snapshot: {},
    changes: [],
    unknowns: [],
  });
  assert.deepEqual(normaliseSnapshot({ circuits: 'not an array' }), {
    mutated: false,
    snapshot: { circuits: 'not an array' },
    changes: [],
    unknowns: [],
  });
});

test('normaliseSnapshot — multi-circuit snapshot rewrites both rcd_bs_en and ocpd_bs_en', () => {
  const snapshot = {
    circuits: [
      { circuit_ref: 1, rcd_bs_en: 'BS EN 61008', ocpd_bs_en: '60898' },
      { circuit_ref: 2, rcd_bs_en: '61009-1', ocpd_bs_en: 'MCB' },
      { circuit_ref: 3, rcd_bs_en: '61008', ocpd_bs_en: 'BS 1361' }, // already canonical
      { circuit_ref: 4, rcd_bs_en: '', ocpd_bs_en: 'BS 88-2' },
    ],
  };
  const result = normaliseSnapshot(snapshot);
  assert.equal(result.mutated, true);
  // Circuit 1 changes both fields (2). Circuit 2 changes both (2). Circuit 3
  // is already canonical (0). Circuit 4 has empty rcd_bs_en (skipped) and
  // 'BS 88-2' ocpd_bs_en (1). Total = 5 change records.
  assert.equal(result.changes.length, 5);
  // Verify in-place mutation.
  assert.equal(snapshot.circuits[0].rcd_bs_en, '61008');
  assert.equal(snapshot.circuits[0].ocpd_bs_en, '60898-1');
  assert.equal(snapshot.circuits[1].rcd_bs_en, '61009');
  assert.equal(snapshot.circuits[1].ocpd_bs_en, '60898-1');
  assert.equal(snapshot.circuits[2].rcd_bs_en, '61008'); // unchanged
  assert.equal(snapshot.circuits[2].ocpd_bs_en, 'BS 1361'); // unchanged
  assert.equal(snapshot.circuits[3].rcd_bs_en, '');
  assert.equal(snapshot.circuits[3].ocpd_bs_en, '60269-2');
});

test('normaliseSnapshot — unknown values surface in unknowns[] but are NOT rewritten', () => {
  const snapshot = {
    circuits: [
      { circuit_ref: 1, rcd_bs_en: 'something exotic', ocpd_bs_en: 'BS 12345-7' },
      { circuit_ref: 2, rcd_bs_en: '61008', ocpd_bs_en: 'BS 60898' },
    ],
  };
  const result = normaliseSnapshot(snapshot);
  assert.equal(result.mutated, true); // circuit 2's ocpd_bs_en still changes
  assert.equal(result.unknowns.length, 2);
  // Unknown values preserved.
  assert.equal(snapshot.circuits[0].rcd_bs_en, 'something exotic');
  assert.equal(snapshot.circuits[0].ocpd_bs_en, 'BS 12345-7');
  // Unknowns carry circuit_ref + field + value for the report.
  assert.deepEqual(result.unknowns[0], {
    circuit_ref: 1,
    field: 'rcd_bs_en',
    value: 'something exotic',
  });
});

test('normaliseSnapshot — circuit without bs_en fields is untouched', () => {
  const snapshot = {
    circuits: [
      { circuit_ref: 1, circuit_designation: 'Cooker' }, // no rcd_bs_en / ocpd_bs_en
      { circuit_ref: 2, rcd_bs_en: 'BS EN 61008' },
    ],
  };
  const result = normaliseSnapshot(snapshot);
  assert.equal(result.mutated, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].circuit_ref, 2);
});

test('normaliseSnapshot — change record carries circuit_ref / field / before / after', () => {
  const snapshot = {
    circuits: [{ circuit_ref: 5, rcd_bs_en: 'BS EN 61009-1' }],
  };
  const result = normaliseSnapshot(snapshot);
  assert.deepEqual(result.changes, [
    { circuit_ref: 5, field: 'rcd_bs_en', before: 'BS EN 61009-1', after: '61009' },
  ]);
});

test('normaliseSnapshot — null / undefined circuit elements are skipped without throwing', () => {
  const snapshot = {
    circuits: [
      null,
      undefined,
      { circuit_ref: 3, rcd_bs_en: 'BS EN 61008' },
    ],
  };
  const result = normaliseSnapshot(snapshot);
  assert.equal(result.mutated, true);
  assert.equal(result.changes.length, 1);
});
