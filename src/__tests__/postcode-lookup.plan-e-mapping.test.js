/**
 * PLAN-E (feedback id 125) — E3: tighten `postcode_lookup.js`'s town/county
 * mapping.
 *
 * Repro (EVIDENCE.md, live `curl api.postcodes.io/postcodes/RG63EY`):
 *   {parish:"Earley", admin_district:"Wokingham", admin_ward:"Hawkedon",
 *    admin_county:null, region:"South East"}
 *
 * Pre-fix: town <- admin_ward || parish || admin_district -> "Hawkedon", an
 * ELECTORAL WARD, silently overwrote a correct "Lower Earley". county <-
 * admin_county || region -> "South East" for every unitary authority (no
 * admin_county), re-manufacturing the exact drift value
 * postcode-snapshot-applier.js's UK_REGION_DRIFT exists to correct.
 *
 * Fix: town <- parish || admin_district (never admin_ward); county <-
 * admin_county only, blank when null (no ceremonial-county table this wave —
 * RESOLVED in /rp refine); `region` is never read by the mapping at all (a
 * source-level rule, not an output filter — filtering through
 * UK_REGION_DRIFT would blank legitimate towns like "London").
 */

import { jest } from '@jest/globals';
import { lookupPostcode, enrichInstallationDetails } from '../postcode_lookup.js';

function mockFetchOnce(body, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    json: async () => body,
  });
}

describe('PLAN-E E3 — lookupPostcode town/county mapping', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('RG6 3EY: town resolves to "Earley" (parish), NEVER the admin_ward "Hawkedon"', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'RG6 3EY',
        parish: 'Earley',
        admin_district: 'Wokingham',
        admin_ward: 'Hawkedon',
        admin_county: null,
        region: 'South East',
      },
    });
    const result = await lookupPostcode('RG6 3EY');
    expect(result.town).toBe('Earley');
    expect(result.town).not.toBe('Hawkedon');
  });

  test('RG6 3EZ: county is BLANK (admin_county null, unitary authority) — never "South East"', async () => {
    // Distinct postcode from the town-mapping test above: postcode_lookup.js
    // caches by normalised postcode module-wide, and a shared postcode would
    // silently skip this test's own fetch mock (masking a real regression
    // behind the earlier test's cached result).
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'RG6 3EZ',
        parish: 'Earley',
        admin_district: 'Wokingham',
        admin_ward: 'Hawkedon',
        admin_county: null,
        region: 'South East',
      },
    });
    const result = await lookupPostcode('RG6 3EZ');
    expect(result.county).toBe('');
  });

  test('a populated `region` field is IGNORED by the mapping (source-level rule, no output filter)', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'SW1A 1AA',
        parish: null,
        admin_district: 'Westminster',
        admin_ward: 'St James',
        admin_county: 'Greater London Authority',
        region: 'London',
      },
    });
    const result = await lookupPostcode('SW1A 1AA');
    expect(result.county).toBe('Greater London Authority');
    expect(result.county).not.toBe('London');
  });

  test('a legitimate town value that happens to collide with a UK_REGION_DRIFT entry is PRESERVED (no output filtering)', async () => {
    // parish/admin_district legitimately named "London" must never be
    // blanked by a drift-set filter on the lookup's own output — the
    // filter approach was explicitly rejected in favour of the
    // source-level fix (region is never read).
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'EC1A 1BB',
        parish: null,
        admin_district: 'London',
        admin_ward: 'Farringdon',
        admin_county: null,
        region: 'London',
      },
    });
    const result = await lookupPostcode('EC1A 1BB');
    expect(result.town).toBe('London');
  });

  test('falls back to admin_district when parish is absent (never admin_ward)', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'RG1 5QA',
        parish: null,
        admin_district: 'Reading',
        admin_ward: 'Abbey',
        admin_county: null,
        region: 'South East',
      },
    });
    const result = await lookupPostcode('RG1 5QA');
    expect(result.town).toBe('Reading');
  });

  test('both parish and admin_district absent yields an empty town, never admin_ward', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'XX1 1XX',
        parish: null,
        admin_district: null,
        admin_ward: 'Some Ward',
        admin_county: null,
        region: 'South East',
      },
    });
    const result = await lookupPostcode('XX1 1XX');
    expect(result.town).toBe('');
  });
});

describe('PLAN-E E3 — non-empty-town no-overwrite through the applier (E1 protection)', () => {
  test('enrichInstallationDetails preserves an existing (E1-seeded) town rather than the lookup value', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'RG6 3EA',
        parish: 'Earley',
        admin_district: 'Wokingham',
        admin_ward: 'Hawkedon',
        admin_county: null,
        region: 'South East',
      },
    });
    const enriched = await enrichInstallationDetails({
      postcode: 'RG6 3EA',
      town: 'Lower Earley',
    });
    // AI-extracted/pre-existing value wins; lookup only fills empty fields.
    expect(enriched.town).toBe('Lower Earley');
  });

  test('enrichInstallationDetails fills an empty town from the (now-correct) lookup value', async () => {
    mockFetchOnce({
      status: 200,
      result: {
        postcode: 'RG6 3EB',
        parish: 'Earley',
        admin_district: 'Wokingham',
        admin_ward: 'Hawkedon',
        admin_county: null,
        region: 'South East',
      },
    });
    const enriched = await enrichInstallationDetails({ postcode: 'RG6 3EB' });
    expect(enriched.town).toBe('Earley');
    expect(enriched.county).toBe('');
  });
});
