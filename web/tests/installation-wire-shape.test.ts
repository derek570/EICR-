import { describe, expect, it } from 'vitest';
import {
  buildInstallationWirePayload,
  buildJobStateForWire,
} from '@/lib/recording/installation-wire-shape';

// PLAN-E (feedback id 125) — E2: web's `installation_details` bucket uses
// canonical snake_case field names internally (matches the backend
// field_schema.json — see apply-extraction.ts's INSTALLATION_FIELDS route
// table), but the frozen client->server wire contract uses iOS's camelCase
// shape for the four client_* keys. Without this normalisation at the wire
// boundary, web's client_postcode/client_town/client_county/client_address
// would cross correctly bucketed but under a field name the backend's
// selectInstallationContainer normaliser doesn't read, silently dropping
// the client address family on every web session.
describe('PLAN-E E2 — buildInstallationWirePayload', () => {
  it('renames the four client_* keys to the frozen camelCase wire shape', () => {
    const out = buildInstallationWirePayload({
      address: '12 Example Street',
      postcode: 'RG6 3EY',
      town: 'Lower Earley',
      county: 'Berkshire',
      client_address: '1 Other Road',
      client_postcode: 'RG1 5QA',
      client_town: 'Reading',
      client_county: 'Berkshire',
    });
    expect(out).toEqual({
      address: '12 Example Street',
      postcode: 'RG6 3EY',
      town: 'Lower Earley',
      county: 'Berkshire',
      clientAddress: '1 Other Road',
      clientPostcode: 'RG1 5QA',
      clientTown: 'Reading',
      clientCounty: 'Berkshire',
    });
  });

  it('site keys pass through unrenamed (already spelled identically in both conventions)', () => {
    const out = buildInstallationWirePayload({ address: '1 A St', postcode: 'RG6 3EY' });
    expect(out).toEqual({ address: '1 A St', postcode: 'RG6 3EY' });
  });

  it('non-address fields (clientName, occupierName, etc.) pass through unchanged', () => {
    const out = buildInstallationWirePayload({
      client_name: 'Jane Doe',
      occupier_name: 'John Smith',
      postcode: 'RG6 3EY',
    });
    expect(out).toEqual({
      client_name: 'Jane Doe',
      occupier_name: 'John Smith',
      postcode: 'RG6 3EY',
    });
  });

  it('returns undefined for null/missing installation_details (no bucket to normalise)', () => {
    expect(buildInstallationWirePayload(null)).toBeUndefined();
    expect(buildInstallationWirePayload(undefined)).toBeUndefined();
  });

  it('partial client fields only rename the ones present', () => {
    const out = buildInstallationWirePayload({ client_postcode: 'RG1 5QA' });
    expect(out).toEqual({ clientPostcode: 'RG1 5QA' });
    expect('client_postcode' in (out as object)).toBe(false);
  });
});

describe('PLAN-E E2 — buildJobStateForWire', () => {
  it('shallow-copies the job with installation_details normalised, other keys untouched', () => {
    const job = {
      id: 'job-1',
      circuits: [{ ref: 1 }],
      installation_details: { client_postcode: 'RG1 5QA' },
    };
    const wire = buildJobStateForWire(job);
    expect(wire).not.toBe(job); // shallow copy, not mutated in place
    expect(wire.circuits).toBe(job.circuits); // other keys pass by reference
    expect(wire.installation_details).toEqual({ clientPostcode: 'RG1 5QA' });
    // The original job's internal representation is untouched.
    expect(job.installation_details).toEqual({ client_postcode: 'RG1 5QA' });
  });

  it('returns the SAME reference when there is no installation bucket (byte-identical wire for a job with none yet)', () => {
    const job = { id: 'job-1', circuits: [] };
    expect(buildJobStateForWire(job)).toBe(job);
  });
});
