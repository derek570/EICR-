/**
 * Tests for applyPostcodeLookupToSnapshot — the prescriptive postcode
 * lookup applier wired into _extractSingle.
 *
 * Locked policy (Derek 2026-06-01): lookup wins on empty OR
 * Sonnet-drift (a UK ITL1 region). Manual values that look like real
 * administrative town/county strings are preserved.
 */

import { applyPostcodeLookupToSnapshot } from '../extraction/postcode-snapshot-applier.js';

function buildSnapshot(circuit0 = {}) {
  return { circuits: { 0: { ...circuit0 } } };
}

describe('applyPostcodeLookupToSnapshot', () => {
  test('fills empty town + county (B95B2EE1 repro: RG1 5QA → Reading, Berkshire)', () => {
    const snapshot = buildSnapshot({ address: '9A Hatherley Road', postcode: 'RG1 5QA' });
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG1 5QA', town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0].town).toBe('Reading');
    expect(snapshot.circuits[0].county).toBe('Berkshire');
  });

  test('overrides "South East" drift with administrative county', () => {
    const snapshot = buildSnapshot({ town: 'Reading', county: 'South East' });
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0].county).toBe('Berkshire');
  });

  test('overrides region drift in town field too ("Greater London" stored as town)', () => {
    const snapshot = buildSnapshot({ town: 'Greater London', county: 'London' });
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Wandsworth', county: 'Greater London' },
      'sess_test'
    );
    expect(snapshot.circuits[0].town).toBe('Wandsworth');
    // 'Greater London' in the COUNTY slot is the canonical postcodes.io
    // value — no drift detected, lookup writes it.
    expect(snapshot.circuits[0].county).toBe('Greater London');
  });

  test('preserves manually-set real town/county', () => {
    const snapshot = buildSnapshot({ town: 'Wokingham', county: 'Berkshire' });
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    // Wokingham is a real town near Reading — drift list shouldn't
    // catch it. Manual edit wins.
    expect(snapshot.circuits[0].town).toBe('Wokingham');
    expect(snapshot.circuits[0].county).toBe('Berkshire');
  });

  test('no-op when lookup is not valid', () => {
    const snapshot = buildSnapshot({ town: '', county: '' });
    applyPostcodeLookupToSnapshot(snapshot, { valid: false, postcode: 'XX99 9XX' }, 'sess_test');
    expect(snapshot.circuits[0].town).toBe('');
    expect(snapshot.circuits[0].county).toBe('');
  });

  test('no-op when lookup result is null', () => {
    const snapshot = buildSnapshot({ town: '', county: '' });
    applyPostcodeLookupToSnapshot(snapshot, null, 'sess_test');
    expect(snapshot.circuits[0].town).toBe('');
  });

  test('initialises circuits[0] when missing entirely', () => {
    const snapshot = { circuits: {} };
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0]).toEqual({ town: 'Reading', county: 'Berkshire' });
  });

  test('initialises circuits object when missing', () => {
    const snapshot = {};
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits).toBeDefined();
    expect(snapshot.circuits[0].town).toBe('Reading');
  });

  test('null snapshot is silently ignored', () => {
    expect(() =>
      applyPostcodeLookupToSnapshot(
        null,
        { valid: true, town: 'Reading', county: 'Berkshire' },
        'sess_test'
      )
    ).not.toThrow();
  });

  test('drift detection is case-insensitive and trim-tolerant', () => {
    const snapshot = buildSnapshot({ county: '  SOUTH EAST  ' });
    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0].county).toBe('Berkshire');
  });
});
