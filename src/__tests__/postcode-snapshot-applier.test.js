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
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG1 5QA', town: 'Reading', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0].town).toBe('Reading');
    expect(snapshot.circuits[0].county).toBe('Berkshire');
    expect(changes).toEqual([
      { field: 'town', value: 'Reading' },
      { field: 'county', value: 'Berkshire' },
    ]);
  });

  test('town/county lookup consequences mutate only the snapshot', () => {
    const snapshot = buildSnapshot({ postcode: 'RG1 5QA' });

    applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG1 5QA', town: 'Reading', county: 'Berkshire' },
      'sess_designed_silent'
    );

    expect(snapshot.circuits[0]).toMatchObject({
      postcode: 'RG1 5QA',
      town: 'Reading',
      county: 'Berkshire',
    });
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

  // Plan E (feedback id 125) — a blank-value drift-clear capability (write
  // an empty county through to clear a stored "South East") was tried
  // across two review cycles and ultimately REVERTED: the fill-empty-only
  // merge means a client whose own cache still shows the pre-clear value
  // structurally guarantees resurrecting it on its very next
  // job_state_update push — see postcode-snapshot-applier.js's comment.
  // This also exceeds the plan's explicit non-goal ("no retroactive repair
  // of already-written drift values... Derek corrects by voice"). Pinned
  // here: an EMPTY lookup value never touches an existing stored value,
  // drift or not — the ONLY way to clear/replace a stored value is a
  // NON-empty lookup result (unchanged from before this plan).
  test('a valid lookup with an EMPTY county does NOT clear a stored drift value (E1/E3 non-goal: no retroactive repair)', () => {
    const snapshot = buildSnapshot({ town: 'Earley', county: 'South East' });
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG6 3EY', town: 'Earley', county: '' },
      'sess_test'
    );
    expect(snapshot.circuits[0].county).toBe('South East');
    expect(changes).toEqual([]);
  });

  test('a valid lookup with an EMPTY town does NOT clear a stored drift value either', () => {
    const snapshot = buildSnapshot({ town: 'London', county: 'Berkshire' });
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG6 3EY', town: '', county: 'Berkshire' },
      'sess_test'
    );
    expect(snapshot.circuits[0].town).toBe('London');
    expect(changes).toEqual([]);
  });

  test('a valid lookup with an EMPTY county still fills a genuinely EMPTY existing county', () => {
    const snapshot = buildSnapshot({ town: 'Earley', county: '' });
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, postcode: 'RG6 3EY', town: 'Earley', county: '' },
      'sess_test'
    );
    // Empty-to-empty: shouldOverride(existing='') is true, but the lookup
    // value is falsy so the guard's `lookup.county &&` never fires — no-op,
    // not a spurious write.
    expect(changes).toEqual([]);
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

  test('enriches client locality without touching the site family', () => {
    const snapshot = buildSnapshot({ town: 'Site Town', county: 'Site County' });
    const changes = applyPostcodeLookupToSnapshot(
      snapshot,
      { valid: true, town: 'Client Town', county: 'Client County' },
      'sess_client',
      { family: 'client' }
    );
    expect(snapshot.circuits[0]).toMatchObject({
      town: 'Site Town',
      county: 'Site County',
      client_town: 'Client Town',
      client_county: 'Client County',
    });
    expect(changes.map((change) => change.field)).toEqual(['client_town', 'client_county']);
  });

  test('returns no changes when real client locality is already present', () => {
    const snapshot = buildSnapshot({ client_town: 'Manual Town', client_county: 'Manual County' });
    expect(
      applyPostcodeLookupToSnapshot(
        snapshot,
        { valid: true, town: 'Lookup Town', county: 'Lookup County' },
        'sess_client_manual',
        { family: 'client' }
      )
    ).toEqual([]);
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
