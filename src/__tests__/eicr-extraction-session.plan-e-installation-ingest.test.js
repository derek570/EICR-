/**
 * PLAN-E (feedback id 125) — E1: the installation address bucket must be
 * ingested into the snapshot at BOTH seed and mid-session-merge time, under
 * ONE precedence rule per surface (round-4 refine fix, see the plan's E1
 * step 2 "Merge authority" paragraph):
 *
 *   - SEED (session start, empty target): all 8 address-family keys write
 *     UNCONDITIONALLY — the target starts empty, so this is functionally
 *     client-authoritative (mirrors the supply seed block's own precedent,
 *     but deliberately does NOT narrow to a hand-picked subset like it does).
 *   - MID-SESSION MERGE: the 8 keys are kept OUT of FACT_FIELDS, so
 *     `_mergeCircuitOrBoardFields` treats them as READING tier —
 *     fill-EMPTY-ONLY. A stale client jobState push can fill a gap but can
 *     never clobber a fresher Sonnet-dictated correction.
 *
 * Without this, `_seedStateFromJobState` gated its ENTIRE body (including
 * board hydration and supply seeding, not just circuit seeding) on
 * `jobState.circuits` being present, so an installation-only payload seeded
 * nothing — and even a circuits-bearing payload never read the installation
 * bucket at all. web sends `installation_details` (snake_case); iOS sends
 * `installation`; a single-key read is a silent no-op for web.
 */

import { jest } from '@jest/globals';
import {
  EICRExtractionSession,
  selectInstallationContainer,
  normaliseInstallationIngest,
} from '../extraction/eicr-extraction-session.js';
import { unwrapJobStateFrame } from '../extraction/job-state-frame.js';

const liveSessions = [];
afterEach(() => {
  for (const s of liveSessions.splice(0)) {
    try {
      s.stop();
    } catch {
      /* teardown only */
    }
  }
});

function makeSession(opts = {}) {
  const s = new EICRExtractionSession('test-key', `plan-e-${Math.random()}`, 'eicr', opts);
  liveSessions.push(s);
  return s;
}

const FULL_INSTALLATION_IOS_SHAPE = {
  address: '12 Example Street',
  postcode: 'RG6 3EY',
  town: 'Lower Earley',
  county: 'Berkshire',
  clientAddress: '1 Other Road',
  clientPostcode: 'RG1 5QA',
  clientTown: 'Reading',
  clientCounty: 'Berkshire',
};

const EXPECTED_SNAPSHOT_FIELDS = {
  address: '12 Example Street',
  postcode: 'RG6 3EY',
  town: 'Lower Earley',
  county: 'Berkshire',
  client_address: '1 Other Road',
  client_postcode: 'RG1 5QA',
  client_town: 'Reading',
  client_county: 'Berkshire',
};

describe('PLAN-E E1 — selectInstallationContainer + normaliseInstallationIngest', () => {
  test('resolves the iOS bucket spelling', () => {
    expect(selectInstallationContainer({ installation: { address: '1 A St' } })).toEqual({
      address: '1 A St',
    });
  });

  test('resolves the web (snake_case) bucket spelling — the single-key-read gap this plan fixes', () => {
    expect(selectInstallationContainer({ installation_details: { address: '1 A St' } })).toEqual({
      address: '1 A St',
    });
  });

  test('resolves the camelCase third spelling (installationDetails)', () => {
    expect(selectInstallationContainer({ installationDetails: { address: '1 A St' } })).toEqual({
      address: '1 A St',
    });
  });

  test('iOS-first precedence per field across mixed containers', () => {
    const merged = selectInstallationContainer({
      installation: { postcode: 'RG6 3EY' },
      installation_details: { postcode: 'WRONG', town: 'Earley' },
    });
    expect(merged).toEqual({ postcode: 'RG6 3EY', town: 'Earley' });
  });

  test('an empty first container does not shadow a populated later one', () => {
    const merged = selectInstallationContainer({
      installation: {},
      installation_details: { address: '1 A St' },
    });
    expect(merged).toEqual({ address: '1 A St' });
  });

  test('no container present returns null', () => {
    expect(selectInstallationContainer({ circuits: [] })).toBeNull();
  });

  test('normaliseInstallationIngest maps the full frozen wire contract', () => {
    expect(normaliseInstallationIngest(FULL_INSTALLATION_IOS_SHAPE)).toEqual(
      EXPECTED_SNAPSHOT_FIELDS
    );
  });

  test('normaliseInstallationIngest only emits keys that are present', () => {
    expect(normaliseInstallationIngest({ address: '1 A St' })).toEqual({ address: '1 A St' });
  });
});

describe('PLAN-E E1 — SEED writes all 8 keys unconditionally into an empty target', () => {
  test('start() with iOS-shaped installation seeds the full family', () => {
    const s = makeSession();
    s.start({ circuits: [], installation: FULL_INSTALLATION_IOS_SHAPE });
    expect(s.stateSnapshot.circuits[0]).toMatchObject(EXPECTED_SNAPSHOT_FIELDS);
  });

  test('start() with web-shaped installation_details (no `installation` key) seeds identically', () => {
    const s = makeSession();
    s.start({ circuits: [], installation_details: FULL_INSTALLATION_IOS_SHAPE });
    expect(s.stateSnapshot.circuits[0]).toMatchObject(EXPECTED_SNAPSHOT_FIELDS);
  });

  test('an installation-only payload (early-out removed) still seeds — no circuits array at all', () => {
    const s = makeSession();
    s.start({ installation: { address: '1 A St', postcode: 'RG6 3EY' } });
    expect(s.stateSnapshot.circuits[0]).toMatchObject({
      address: '1 A St',
      postcode: 'RG6 3EY',
    });
  });

  test('a circuits-present payload seeds circuits AND installation together, unchanged behaviour otherwise', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1, designation: 'Kitchen Ring' }],
      installation: { address: '1 A St' },
    });
    expect(s.stateSnapshot.circuits[1].circuit_designation).toBe('Kitchen Ring');
    expect(s.stateSnapshot.circuits[0].address).toBe('1 A St');
  });

  test('absent/non-array circuits is guarded, never throws', () => {
    const s = makeSession();
    expect(() =>
      s.start({ circuits: 'not-an-array', installation: { address: '1 A St' } })
    ).not.toThrow();
    expect(s.stateSnapshot.circuits[0].address).toBe('1 A St');
  });

  test('no installation container present leaves circuits[0] untouched by this path', () => {
    const s = makeSession();
    s.start({ circuits: [] });
    expect(s.stateSnapshot.circuits[0]).toBeUndefined();
  });
});

describe('PLAN-E E1 — MID-SESSION MERGE is fill-EMPTY-ONLY (the round-4 precedence fix)', () => {
  test('a stale client jobState push PRESERVES a fresher dictated value (the single-authority invariant)', () => {
    const s = makeSession();
    // Simulate a live dictated correction already on the snapshot.
    s.stateSnapshot.circuits[0] = { town: 'Lower Earley' };
    s.updateJobState({ installation: { town: 'Hawkedon' } });
    expect(s.stateSnapshot.circuits[0].town).toBe('Lower Earley');
  });

  test('an EMPTY slot IS filled by a mid-session client push', () => {
    const s = makeSession();
    s.updateJobState({ installation: { postcode: 'RG6 3EY' } });
    expect(s.stateSnapshot.circuits[0].postcode).toBe('RG6 3EY');
  });

  test('web-shaped installation_details merges identically to the iOS shape', () => {
    const s = makeSession();
    s.updateJobState({ installation_details: { postcode: 'RG6 3EY', town: 'Earley' } });
    expect(s.stateSnapshot.circuits[0]).toMatchObject({ postcode: 'RG6 3EY', town: 'Earley' });
  });

  test('the 8 address keys are NOT FACT tier — a merge-path test with a pre-populated target proves fill-empty, not overwrite', () => {
    const s = makeSession();
    s.stateSnapshot.circuits[0] = {
      address: 'A',
      postcode: 'B',
      town: 'C',
      county: 'D',
      client_address: 'E',
      client_postcode: 'F',
      client_town: 'G',
      client_county: 'H',
    };
    s.updateJobState({ installation: FULL_INSTALLATION_IOS_SHAPE });
    // Every pre-existing value survives verbatim — nothing was overwritten.
    expect(s.stateSnapshot.circuits[0]).toMatchObject({
      address: 'A',
      postcode: 'B',
      town: 'C',
      county: 'D',
      client_address: 'E',
      client_postcode: 'F',
      client_town: 'G',
      client_county: 'H',
    });
  });

  test('a supply-only or circuits-only update never disturbs an existing installation family', () => {
    const s = makeSession();
    s.updateJobState({ installation: { town: 'Lower Earley' } });
    s.updateJobState({ supply: { ze: '0.35' } });
    expect(s.stateSnapshot.circuits[0].town).toBe('Lower Earley');
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.35');
  });
});

describe('PLAN-E E1.4 — job-state-frame.js gate lets an installation-only frame through', () => {
  test('an installation-only nested (web) job_state_update frame is NOT classified as envelope noise', () => {
    const frame = unwrapJobStateFrame({
      type: 'job_state_update',
      jobState: { installation_details: { postcode: 'RG6 3EY' } },
    });
    expect(frame).toEqual({ installation_details: { postcode: 'RG6 3EY' } });
  });

  test('an installation-only flat (iOS) job_state_update frame is NOT dropped', () => {
    const frame = unwrapJobStateFrame({ installation: { postcode: 'RG6 3EY' } });
    expect(frame).toEqual({ installation: { postcode: 'RG6 3EY' } });
  });

  test('a malformed (non-plain-record) installation container fails structural validation, rejecting the whole frame', () => {
    const frame = unwrapJobStateFrame({
      type: 'job_state_update',
      jobState: { installation: ['not', 'a', 'record'] },
    });
    expect(frame).toBeNull();
  });

  test('a payload with none of the recognised fields is still envelope noise', () => {
    const frame = unwrapJobStateFrame({ type: 'job_state_update', jobState: { foo: 'bar' } });
    expect(frame).toBeNull();
  });
});

describe('PLAN-E — mirror-ask family completeness now satisfiable (provenance gate preserved)', () => {
  // Exercises the REAL controller entry points (claimLiveAsk), proving E1
  // restores family COMPLETENESS without widening the provenance gate
  // itself — a current-turn non-derived address-family write is still
  // required (address-mirror-controller.js buildCandidate/
  // sourceFamilyFromWrites). Mirrors the existing suite's own
  // sessionWith/sourceTurnWrites fixtures (address-mirror-controller.test.js).
  let createAddressMirrorController;
  let createPerTurnWrites;
  let encodeBoardReadingKey;
  let recordBoardReadingWrite;

  beforeAll(async () => {
    ({ createAddressMirrorController } =
      await import('../extraction/address-mirror-controller.js'));
    ({ createPerTurnWrites, encodeBoardReadingKey, recordBoardReadingWrite } =
      await import('../extraction/stage6-per-turn-writes.js'));
  });

  function seededSiteSession() {
    return {
      sessionId: 'plan-e-mirror-seeded',
      stateSnapshot: {
        circuits: {
          0: {
            address: '12 Example Street',
            postcode: 'RG6 3EY',
            town: 'Lower Earley',
            county: 'Berkshire',
          },
        },
      },
    };
  }

  function turnWrites(values) {
    const writes = createPerTurnWrites();
    for (const [field, value] of Object.entries(values)) {
      recordBoardReadingWrite(writes, encodeBoardReadingKey(field), {
        value,
        confidence: 1,
        source_turn_id: 'turn-source',
      });
    }
    return writes;
  }

  test('an E1-seeded complete site family + a dictated postcode this turn → convenience-ask claim succeeds', async () => {
    const store = { claim: jest.fn(async (_u, _j, intent) => ({ claimed: true, intent })) };
    const controller = createAddressMirrorController({
      userId: 'owner-plan-e',
      jobId: 'job-plan-e',
      session: seededSiteSession(),
      store,
    });
    const out = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-plan-e',
      perTurnWrites: turnWrites({ postcode: 'RG6 3EY' }),
    });
    expect(out).toMatchObject({ ok: true });
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  test('an E1-seeded complete family with NO current-turn address write → NO convenience ask (provenance gate holds)', async () => {
    const store = { claim: jest.fn() };
    const controller = createAddressMirrorController({
      userId: 'owner-plan-e-2',
      jobId: 'job-plan-e-2',
      session: seededSiteSession(),
      store,
    });
    const out = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-plan-e-2',
      perTurnWrites: turnWrites({ measured_zs_ohm: '0.35' }),
    });
    expect(out).toEqual({ ok: false, reason: 'source_family_ambiguous' });
    expect(store.claim).not.toHaveBeenCalled();
  });
});
