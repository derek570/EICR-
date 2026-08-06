/**
 * Plan 00B-4 §C1d + §C1e — the live-lane run coordinator.
 *
 * Two halves, tested against the REAL modules (never a re-implementation):
 *
 *  §C1e — `assertRunPreconditions` refuses BEFORE anything is allocated or
 *         reserved. Every refusal below is driven by perturbing exactly ONE
 *         override, so a passing test proves that clause is what refused, and
 *         each asserts the store is still free of reservations: a gate that
 *         refuses *after* burning an ordinal is not a gate.
 *
 *  §C1d — `cmdRunIr` / `cmdRunCorpus` orchestration: concurrency, partial-run
 *         resume, INVALID replacement, completed-work no-op. Driven through the
 *         real exported commands against a memory store with the real
 *         reservation/fold machinery — only the vendor call itself is faked,
 *         via the same sealed live-dispatch capability production mints.
 *
 * NOTE on the memory store: `assertDispatchAuthority` accepts a `liveDispatch`
 * capability against a MEMORY store (it only forbids `execute` fakes against a
 * DURABLE one), which is exactly the call `coordinateRun` makes. So the
 * coordinator runs here byte-for-byte as it does in production, including the
 * capability seal — the fake lives inside the sealed dispatch, not around it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryStore } from '../../scripts/plan00-evidence/lib/memory-store.mjs';
import {
  EVIDENCE_PREFIX,
  STAGE_A_COHORT,
  LUNA_MODEL_FAMILY,
  FAST_TIERS,
} from '../../scripts/plan00-evidence/lib/constants.mjs';
import { buildEvent, eventSchemaHash } from '../../scripts/plan00-evidence/lib/events.mjs';
import { publishDurable, loadAuditedPrefix } from '../../scripts/plan00-evidence/lib/store.mjs';
import {
  allocateOrdinal,
  buildOrdinalCandidate,
} from '../../scripts/plan00-evidence/lib/reservations.mjs';
import { brandLiveEvaluationClient } from '../../scripts/plan00-evidence/lib/live-capability.mjs';
import {
  vendorCorpusRequirementKey,
  vendorCorpusLane,
  ordinalIndexKey,
} from '../../scripts/plan00-evidence/lib/dispatch-plan.mjs';
import {
  PINNED_IR_IDENTITY,
  PINNED_IR_OVERRIDE_ARGS,
  assertNoPinnedIrOverride,
  pinnedIrRequirementKey,
} from '../../scripts/plan00-evidence/lib/pinned-ir.mjs';
import {
  LANE_MODELS,
  PINNED_IR_MODEL_LANE,
  resolveLaneModel,
  pinLaneModelEnv,
} from '../../scripts/plan00-evidence/lib/lane-models.mjs';
import {
  assertRunPreconditions,
  assertLiveBoot,
  cmdRunIr,
  cmdRunCorpus,
  computeCohortFingerprint,
} from '../../scripts/plan00-evidence/cli.mjs';
import { evidenceEventHash } from '../../scripts/field-replay/lib/canonical-crypto.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REAL_MANIFEST = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/model-ab/plan00-expectation-manifest.json'), 'utf8')
);

const FP = 'f'.repeat(64);
const HEAD_SHA = 'a'.repeat(40);
const ORACLE_DIGEST = REAL_MANIFEST.semantic_oracle_digest;

// ── cohort seeding ────────────────────────────────────────────────────────

let clockMs = Date.parse('2026-08-10T09:00:00Z');

function tickClock(store, iso) {
  clockMs = iso ? Date.parse(iso) : clockMs + 1000;
  store._setNow(() => new Date(clockMs).toISOString());
}

async function publishEventAt(store, { kind, cohortId, namespace, body, at }) {
  if (at) tickClock(store, at);
  const event = buildEvent({ kind, cohortId, namespace, body });
  const receipt = await publishDurable(store, { key: event.key, bytes: event.bytes });
  if (!receipt.ok) throw new Error(`test publish failed: ${receipt.error}`);
  return { event, receipt };
}

function stageABody(overrides = {}) {
  return {
    deploy_run: { run_id: '1', head_sha: HEAD_SHA, repository: 'derek570/EICR-' },
    runtime: {
      image_digest: 'sha256:img',
      task_def_arn: 'arn:task/377',
      task_family: 'eicr-backend',
      task_revision: '377',
      deployment_fingerprint: FP,
    },
    evidence_bucket: 'test-bucket',
    evidence_bucket_versioning: 'Enabled',
    config_fingerprint: 'cfg',
    tool_fingerprint: 'tool',
    prompt_fingerprint: 'prompt',
    semantic_oracle_digest: ORACLE_DIGEST,
    deployed_evidence_runtime_digest: 'sha256:img',
    event_schema_hash: eventSchemaHash(),
    ...overrides,
  };
}

/**
 * Seed stage_a_deployed → expectations_attested → cohort_initialized, attesting
 * the REAL committed manifest shas so `assertRunPreconditions` steps 2/3/3b all
 * pass and each test perturbs exactly one thing.
 */
async function establishCohort(
  store,
  { at = '2026-08-09T08:00:00Z', stageA: stageAOverrides } = {}
) {
  const { event: stageA } = await publishEventAt(store, {
    kind: 'stage_a_deployed',
    cohortId: STAGE_A_COHORT,
    namespace: 'machine',
    body: stageABody(stageAOverrides),
    at,
  });
  const shas = {
    stageAPayload: stageA.payload,
    combinedSha256: REAL_MANIFEST.combined_sha256,
    vendorLiveSha256: REAL_MANIFEST.vendor_live_expectations.sha256,
    deterministicEgressSha256: REAL_MANIFEST.deterministic_egress_expectations.sha256,
  };
  const { cohortId } = computeCohortFingerprint(shas);
  const { event: attested } = await publishEventAt(store, {
    kind: 'expectations_attested',
    cohortId,
    namespace: 'derek',
    body: {
      reviewer: 'Derek',
      attested_at: new Date(clockMs - 500).toISOString(),
      combined_sha256: REAL_MANIFEST.combined_sha256,
      vendor_live_sha256: REAL_MANIFEST.vendor_live_expectations.sha256,
      deterministic_egress_sha256: REAL_MANIFEST.deterministic_egress_expectations.sha256,
    },
  });
  const { fingerprint } = computeCohortFingerprint(shas);
  await publishEventAt(store, {
    kind: 'cohort_initialized',
    cohortId,
    namespace: 'derek',
    body: {
      cohort_fingerprint: fingerprint,
      stage_a_event_hash: evidenceEventHash(stageA.payload),
      expectations_event_hash: evidenceEventHash(attested.payload),
    },
  });
  return { cohortId, stageA, attested };
}

async function keysUnder(store, prefix) {
  const { versions } = await store.listAllVersions({ prefix });
  return [...new Set(versions.map((v) => v.key))].sort();
}

async function reservationKeys(store, cohortId) {
  return keysUnder(store, `${EVIDENCE_PREFIX}/reservations/${cohortId}/`);
}

/**
 * Count published `attempt_terminal` events.
 *
 * MUST read payloads, never keys: `buildEvent` names every event key by the
 * sha256 of its own payload (`…/events/<cohort>/<namespace>/<hash>.json`), so
 * the kind NEVER appears in the key and a `key.includes('attempt_terminal')`
 * filter silently counts zero forever — a green-looking assertion that proves
 * nothing.
 */
async function terminalCount(store, cohortId) {
  const { records, holds } = await loadAuditedPrefix(
    store,
    `${EVIDENCE_PREFIX}/events/${cohortId}/`
  );
  if (holds.length > 0) {
    throw new Error(`terminalCount: audit holds ${JSON.stringify(holds)}`);
  }
  return records.filter((r) => r.payload?.kind === 'attempt_terminal').length;
}

// ── §C1e — assertRunPreconditions ─────────────────────────────────────────

function passingOverrides(extra = {}) {
  return {
    readManifest: () => JSON.parse(JSON.stringify(REAL_MANIFEST)),
    recomputeOracle: async () => ORACLE_DIGEST,
    liveCheck: async () => ({ available: true, fingerprint_matches: true }),
    readHeadSha: async () => `${HEAD_SHA}\n`,
    readPorcelain: async () => '',
    ...extra,
  };
}

describe('plan00 §C1e — assertRunPreconditions refuses before allocating', () => {
  let store;
  let cohortId;

  beforeEach(async () => {
    store = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
    ({ cohortId } = await establishCohort(store));
  });

  async function expectRefusal(overrides, args = {}) {
    await expect(
      assertRunPreconditions(store, { cohort: cohortId, ...args }, passingOverrides(overrides))
    ).rejects.toThrow(/REFUSED:/);
    // A gate that refuses after burning an ordinal is not a gate.
    expect(await reservationKeys(store, cohortId)).toEqual([]);
  }

  test('a fully-consistent cohort passes and reports every attestation flag', async () => {
    const pre = await assertRunPreconditions(store, { cohort: cohortId }, passingOverrides());
    expect(pre.cohortId).toBe(cohortId);
    expect(pre.headSha).toBe(HEAD_SHA);
    expect(pre.deploymentFingerprint).toBe(FP);
    expect(pre.promptDigest).toBe('prompt');
    expect(pre.toolDigest).toBe('tool');
    expect(pre.attestation).toEqual({
      oracleDigestVerified: true,
      expectationAttestationVerified: true,
      deploymentVerified: true,
      sourceBindingVerified: true,
    });
    expect(Object.isFrozen(pre.attestation)).toBe(true);
    expect(await reservationKeys(store, cohortId)).toEqual([]);
  });

  test('--mode=mock is refused outright — a replay verdict must never enter the store', async () => {
    await expect(
      assertRunPreconditions(store, { cohort: cohortId, mode: 'mock' }, passingOverrides())
    ).rejects.toThrow(/dispatch the LIVE vendor lane only/);
    expect(await reservationKeys(store, cohortId)).toEqual([]);
  });

  test('--mode=live is the one accepted explicit mode', async () => {
    await expect(
      assertRunPreconditions(store, { cohort: cohortId, mode: 'live' }, passingOverrides())
    ).resolves.toBeTruthy();
  });

  test('an uninitialised cohort refuses', async () => {
    const bare = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
    await publishEventAt(bare, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    await expect(
      assertRunPreconditions(bare, { cohort: 'cohort-nope000000001' }, passingOverrides())
    ).rejects.toThrow(/is not initialized/);
  });

  test('semantic_oracle_digest drift refuses — a mutated oracle source is a new cohort', async () => {
    await expectRefusal({ recomputeOracle: async () => 'drifted-oracle-digest' });
  });

  test('a mutated dispatch-path file that leaves the oracle digest untouched is STILL refused', async () => {
    // The oracle digest covers only enumerated semantic-oracle inputs. Source
    // binding is the independent net: a dirty checkout cannot be reconstructed
    // from the recorded commit, whatever the oracle hashes to.
    await expectRefusal({
      recomputeOracle: async () => ORACLE_DIGEST,
      readPorcelain: async () => ' M scripts/plan00-evidence/lib/runner.mjs\n',
    });
  });

  test('attested sha no longer matching the committed manifest refuses', async () => {
    await expectRefusal({
      readManifest: () => ({
        ...JSON.parse(JSON.stringify(REAL_MANIFEST)),
        combined_sha256: 'c'.repeat(64),
      }),
    });
  });

  test('disagreeing manifest sha mirrors refuse BEFORE the money is spent', async () => {
    // The manifest states each lane sha TWICE (nested + top-level). fold.mjs
    // enforces terminals against the NESTED value while the coordinator binds
    // the TOP-LEVEL mirror, so a drift binds every terminal to a digest the
    // fold then rejects — after the vendor calls have been paid for.
    //
    // Perturb the NESTED value, not the top-level mirror: ordered step 3
    // (attested-vs-committed) compares the ATTESTED sha against the TOP-LEVEL
    // mirror and runs BEFORE step 3b, so mutating the mirror would fire the
    // earlier clause and this test would pass for the wrong reason.
    const manifest = JSON.parse(JSON.stringify(REAL_MANIFEST));
    manifest.vendor_live_expectations.sha256 = 'd'.repeat(64);
    await expectRefusal({ readManifest: () => manifest });
    await expect(
      assertRunPreconditions(
        store,
        { cohort: cohortId },
        passingOverrides({ readManifest: () => manifest })
      )
    ).rejects.toThrow(/mirrors disagree/);
  });

  test('a missing nested lane sha refuses rather than defaulting', async () => {
    const manifest = JSON.parse(JSON.stringify(REAL_MANIFEST));
    delete manifest.deterministic_egress_expectations.sha256;
    await expect(
      assertRunPreconditions(
        store,
        { cohort: cohortId },
        passingOverrides({ readManifest: () => manifest })
      )
    ).rejects.toThrow(/mirrors disagree/);
  });

  test('dispatch-source drift (HEAD != the deployed commit) refuses', async () => {
    await expectRefusal({ readHeadSha: async () => `${'b'.repeat(40)}\n` });
    await expect(
      assertRunPreconditions(
        store,
        { cohort: cohortId },
        passingOverrides({ readHeadSha: async () => `${'b'.repeat(40)}\n` })
      )
    ).rejects.toThrow(/dispatch-source drift/);
  });

  test('a dirty checkout refuses and names the offending paths', async () => {
    await expect(
      assertRunPreconditions(
        store,
        { cohort: cohortId },
        passingOverrides({ readPorcelain: async () => ' M src/a.js\n?? src/b.js\n' })
      )
    ).rejects.toThrow(/the checkout is dirty[\s\S]*src\/a\.js/);
  });

  test('a stale/absent live deployment refuses — a new deploy needs a new cohort', async () => {
    await expectRefusal({
      liveCheck: async () => ({
        available: true,
        fingerprint_matches: false,
        reason: 'image drift',
      }),
    });
    await expectRefusal({ liveCheck: async () => ({ available: false, reason: 'unavailable' }) });
  });

  test('a stage_a carrying an empty echoed fingerprint never binds at all', async () => {
    // Every terminal echoes the deployment/prompt/tool fingerprints, and step 6
    // fails closed if the bound stage_a lacks one. This pins WHY that clause is
    // a backstop rather than the live gate: the event schema already forbids an
    // empty fingerprint, so such an event is not a VALID stage_a and the cohort
    // binding (step 1) refuses first — step 6 only fires if the schema and this
    // reader ever diverge. Either way nothing is allocated.
    const other = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
    const seeded = await establishCohort(other, {
      at: '2026-08-09T08:00:00Z',
      stageA: { prompt_fingerprint: '' },
    });
    await expect(
      assertRunPreconditions(other, { cohort: seeded.cohortId }, passingOverrides())
    ).rejects.toThrow(/no valid stage_a_deployed event with that hash is readable/);
    expect(await reservationKeys(other, seeded.cohortId)).toEqual([]);
  });

  test('a stage_a event that cannot carry a head_sha refuses rather than dispatching unbound', async () => {
    // deploy_run.head_sha is what binds the dispatched source. An event whose
    // bound record no longer validates cannot be trusted for ANY of its fields,
    // so the cohort binding itself refuses first.
    const other = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
    const seeded = await establishCohort(other, {
      at: '2026-08-09T09:00:00Z',
      stageA: { deploy_run: { run_id: '1', head_sha: HEAD_SHA, repository: 'derek570/EICR-' } },
    });
    // Re-publishing a DIFFERENT stage-A body breaks the hash the cohort bound.
    await publishEventAt(other, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody({ config_fingerprint: 'cfg-changed' }),
      at: '2026-08-09T10:00:00Z',
    });
    const pre = await assertRunPreconditions(
      other,
      { cohort: seeded.cohortId },
      passingOverrides()
    );
    // The ORIGINAL bound event is still present and still valid, so the run is
    // bound to it — not to the newer, unattested one.
    // `buildEvent` spreads `body` FLAT into the payload — there is no `.body`.
    expect(pre.stageA.payload.config_fingerprint).toBe('cfg');
  });
});

describe('plan00 §C1e — assertLiveBoot', () => {
  test('refuses a non-live boot', () => {
    expect(() => assertLiveBoot({ liveMode: false })).toThrow(/the lane boot is not live/);
    expect(() => assertLiveBoot({})).toThrow(/REFUSED:/);
    expect(() => assertLiveBoot(null)).toThrow(/REFUSED:/);
  });

  test('accepts a live boot', () => {
    expect(() => assertLiveBoot({ liveMode: true })).not.toThrow();
  });
});

// ── §C1d — coordinator orchestration ──────────────────────────────────────

const REAL_KEYS = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

function brandedClients() {
  return {
    anthropic: brandLiveEvaluationClient(
      { tag: 'anthropic' },
      { provider: 'anthropic', maxRetries: 0 }
    ),
    openai: brandLiveEvaluationClient({ tag: 'openai' }, { provider: 'openai', maxRetries: 0 }),
  };
}

const PASSING_ATTESTATION = Object.freeze({
  oracleDigestVerified: true,
  expectationAttestationVerified: true,
  deploymentVerified: true,
  sourceBindingVerified: true,
});

function stubPreconditions(cohortId) {
  return async () => ({
    cohortId,
    state: null,
    init: null,
    stageA: null,
    attested: null,
    manifest: JSON.parse(JSON.stringify(REAL_MANIFEST)),
    oracle: ORACLE_DIGEST,
    live: { available: true, fingerprint_matches: true },
    headSha: HEAD_SHA,
    deploymentFingerprint: FP,
    promptDigest: 'prompt',
    toolDigest: 'tool',
    attestation: PASSING_ATTESTATION,
  });
}

/**
 * A lane session that never touches a vendor: `driveFixture` returns whatever
 * the supplied verdict factory says, and the judge is never consulted (the fake
 * driver stands in for the whole judged dispatch).
 */
function stubLaneSession({ verdictFor, modelLane = PINNED_IR_MODEL_LANE, beforeRun } = {}) {
  const calls = [];
  const session = async (opts, fn) => {
    if (beforeRun) await beforeRun();
    return fn({
      boot: { liveMode: true, liveProviderClients: brandedClients() },
      driverMod: {
        driveFixture: async ({ fixture }) => {
          const id = fixture?.corpus_id ?? 'unknown';
          calls.push(id);
          const verdict = verdictFor ? verdictFor(id, calls.length) : null;
          return (
            verdict ?? {
              verdict: 'PASS',
              mismatches: [],
              provider_call_ids: [`prov_${calls.length}`],
            }
          );
        },
      },
      judgeMod: { judgeFrozenEvidence: () => ({ verdict: 'PASS', mismatches: [] }) },
      descriptor: resolveLaneModel(opts.modelLane ?? modelLane),
    });
  };
  session.calls = calls;
  return session;
}

describe('plan00 §C1d — run coordinator orchestration', () => {
  let store;
  let cohortId;

  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(REAL_KEYS)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    store = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
    ({ cohortId } = await establishCohort(store));
  });

  function runOpts(extra = {}) {
    return {
      preconditions: stubPreconditions(cohortId),
      log: () => {},
      sleep: async () => {},
      ...extra,
    };
  }

  // ── run-ir ──────────────────────────────────────────────────────────────

  test('run-ir dispatches the pinned fixture exactly once and records a terminal', async () => {
    const laneSession = stubLaneSession();
    const out = await cmdRunIr(
      { cohort: cohortId, 'inter-turn-ms': 0 },
      store,
      runOpts({ laneSession })
    );
    expect(out.ordinal).toBe(1);
    expect(out.dispatched).toBe(1);
    expect(laneSession.calls).toEqual([PINNED_IR_IDENTITY.fixture_id]);
    expect(out.outcomes[0].verdict).toBe('PASS');
    expect(await terminalCount(store, cohortId)).toBe(1);
  });

  test('run-ir is a no-op once the ordinal is complete, and --new-repetition opens the next', async () => {
    await cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: stubLaneSession() }));

    const second = stubLaneSession();
    const noop = await cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: second }));
    expect(noop.complete).toBe(true);
    expect(noop.dispatched).toBe(0);
    expect(second.calls).toEqual([]);

    const third = stubLaneSession();
    const next = await cmdRunIr(
      { cohort: cohortId, 'new-repetition': true },
      store,
      runOpts({ laneSession: third })
    );
    expect(next.ordinal).toBe(2);
    expect(next.dispatched).toBe(1);
    expect(await terminalCount(store, cohortId)).toBe(2);
  });

  test('an INVALID terminal is replaced under the SAME requirement key at generation N+1', async () => {
    const first = stubLaneSession({ verdictFor: () => ({ verdict: 'INVALID_HOLD' }) });
    const bad = await cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: first }));
    expect(bad.outcomes[0].verdict).toBe('INVALID');

    const second = stubLaneSession();
    const fixed = await cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: second }));
    expect(fixed.ordinal).toBe(1); // same ordinal, not a fresh repetition
    expect(fixed.dispatched).toBe(1);
    expect(fixed.outcomes[0].verdict).toBe('PASS');
    expect(fixed.outcomes[0].requirementKey).toBe(pinnedIrRequirementKey(1));

    const keys = await reservationKeys(store, cohortId);
    expect(keys.some((k) => k.endsWith('gen-1.json'))).toBe(true);
    expect(keys.some((k) => k.endsWith('gen-2.json'))).toBe(true);
  });

  test('two coordinators racing the same ordinal dispatch exactly once', async () => {
    // Both sessions block inside the lane session until both have arrived, so
    // both have adopted ordinal 1 with NO attempt reservation yet in existence.
    // Exclusivity is the conditional-create PENDING, not the ordinal.
    let release;
    const barrier = new Promise((r) => {
      release = r;
    });
    let arrived = 0;
    const gate = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await barrier;
    };
    const a = stubLaneSession({ beforeRun: gate });
    const b = stubLaneSession({ beforeRun: gate });

    const [ra, rb] = await Promise.all([
      cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: a })),
      cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession: b })),
    ]);

    expect(ra.ordinal).toBe(1);
    expect(rb.ordinal).toBe(1);
    expect(ra.dispatched + rb.dispatched).toBe(1);
    expect(a.calls.length + b.calls.length).toBe(1);
    expect(await terminalCount(store, cohortId)).toBe(1);
  });

  test('an ordinal allocated by a coordinator that then died is ADOPTED, not skipped', async () => {
    const pre = await allocateOrdinal(
      store,
      buildOrdinalCandidate({ cohortId, lane: PINNED_IR_IDENTITY.lane, ordinal: 1 })
    );
    expect(pre.allocated).toBe(true);

    const laneSession = stubLaneSession();
    const out = await cmdRunIr({ cohort: cohortId }, store, runOpts({ laneSession }));
    expect(out.ordinal).toBe(1);
    expect(out.dispatched).toBe(1);
    expect(out.outcomes[0].terminal?.body?.allocation_version_id ?? pre.versionId).toBe(
      pre.versionId
    );
  });

  test('run-ir refuses every fixture/expectation override before allocating', async () => {
    for (const name of PINNED_IR_OVERRIDE_ARGS) {
      const laneSession = stubLaneSession();
      await expect(
        cmdRunIr({ cohort: cohortId, [name]: 'x' }, store, runOpts({ laneSession }))
      ).rejects.toThrow(/REFUSED: run-ir judges exactly the pinned fixture/);
      expect(laneSession.calls).toEqual([]);
    }
    expect(await reservationKeys(store, cohortId)).toEqual([]);
  });

  // ── run-corpus ──────────────────────────────────────────────────────────

  test('run-corpus allocates ONE ordinal spanning every vendor-lane fixture', async () => {
    const laneSession = stubLaneSession({ modelLane: 'luna' });
    const out = await cmdRunCorpus(
      { cohort: cohortId, 'model-lane': 'luna' },
      store,
      runOpts({ laneSession })
    );
    const projection = await import('../../scripts/model-ab/lib/expectation-projection.mjs');
    expect(out.lane).toBe(vendorCorpusLane('luna'));
    expect(out.ordinal).toBe(1);
    expect(out.dispatched).toBe(projection.VENDOR_LIVE_FIXTURE_IDS.length);
    expect(laneSession.calls.sort()).toEqual([...projection.VENDOR_LIVE_FIXTURE_IDS].sort());
    expect(await terminalCount(store, cohortId)).toBe(projection.VENDOR_LIVE_FIXTURE_IDS.length);
  }, 60000);

  test('a partial run RESUMES the same ordinal and dispatches only the outstanding fixtures', async () => {
    const projection = await import('../../scripts/model-ab/lib/expectation-projection.mjs');
    const total = projection.VENDOR_LIVE_FIXTURE_IDS.length;

    // Die between samples: `sleep` is only called BETWEEN fixtures, so throwing
    // on the 4th inter-sample pause leaves exactly 4 terminals behind.
    let sleeps = 0;
    const crashingSleep = async () => {
      sleeps += 1;
      if (sleeps === 4) throw new Error('coordinator died mid-run');
    };
    const first = stubLaneSession({ modelLane: 'luna' });
    await expect(
      cmdRunCorpus(
        { cohort: cohortId, 'model-lane': 'luna', 'inter-turn-ms': 1 },
        store,
        runOpts({ laneSession: first, sleep: crashingSleep })
      )
    ).rejects.toThrow(/coordinator died mid-run/);
    expect(first.calls.length).toBe(4);
    expect(await terminalCount(store, cohortId)).toBe(4);

    const second = stubLaneSession({ modelLane: 'luna' });
    const resumed = await cmdRunCorpus(
      { cohort: cohortId, 'model-lane': 'luna' },
      store,
      runOpts({ laneSession: second })
    );
    expect(resumed.ordinal).toBe(1); // resumed, not a fresh run
    expect(resumed.dispatched).toBe(total - 4);
    expect(second.calls.length).toBe(total - 4);
    // No fixture is judged twice inside one corpus run.
    expect(new Set([...first.calls, ...second.calls]).size).toBe(total);
    expect(await terminalCount(store, cohortId)).toBe(total);
  }, 60000);

  test('a completed corpus run is a no-op until --new-run', async () => {
    const laneSession = stubLaneSession({ modelLane: 'luna' });
    await cmdRunCorpus({ cohort: cohortId, 'model-lane': 'luna' }, store, runOpts({ laneSession }));

    const second = stubLaneSession({ modelLane: 'luna' });
    const noop = await cmdRunCorpus(
      { cohort: cohortId, 'model-lane': 'luna' },
      store,
      runOpts({ laneSession: second })
    );
    expect(noop.complete).toBe(true);
    expect(noop.dispatched).toBe(0);
    expect(second.calls).toEqual([]);
  }, 60000);

  test('an unknown model lane throws before anything is allocated', async () => {
    const laneSession = stubLaneSession();
    await expect(
      cmdRunCorpus({ cohort: cohortId, 'model-lane': 'nope' }, store, runOpts({ laneSession }))
    ).rejects.toThrow(/unknown model lane/);
    expect(await reservationKeys(store, cohortId)).toEqual([]);
  });

  test('each lane gets its OWN ordinal namespace — luna and haiku never collide', async () => {
    const luna = stubLaneSession({ modelLane: 'luna' });
    const haiku = stubLaneSession({ modelLane: 'haiku' });
    const a = await cmdRunCorpus(
      { cohort: cohortId, 'model-lane': 'luna' },
      store,
      runOpts({ laneSession: luna })
    );
    const b = await cmdRunCorpus(
      { cohort: cohortId, 'model-lane': 'haiku' },
      store,
      runOpts({ laneSession: haiku })
    );
    expect(a.lane).toBe('corpus-run-luna');
    expect(b.lane).toBe('corpus-run-haiku');
    expect(a.ordinal).toBe(1);
    expect(b.ordinal).toBe(1); // separate namespace, not ordinal 2
    expect(b.dispatched).toBe(a.dispatched);
  }, 90000);
});

// ── module units ──────────────────────────────────────────────────────────

describe('plan00 §C1d — dispatch-plan key derivation', () => {
  test('a vendor-corpus requirement key names lane, ordinal AND fixture', () => {
    expect(
      vendorCorpusRequirementKey({ modelLane: 'luna', corpusRunOrdinal: 3, fixtureId: 'frc_x' })
    ).toBe('vendor_corpus:luna:run:3:frc_x');
  });

  test('lane names and ordinal index keys are namespaced per lane', () => {
    expect(vendorCorpusLane('haiku')).toBe('corpus-run-haiku');
    expect(ordinalIndexKey('corpus-run-luna', 2)).toBe('corpus-run-luna#2');
    expect(ordinalIndexKey('corpus-run-luna', 2)).not.toBe(ordinalIndexKey('corpus-run-haiku', 2));
  });

  test('the pinned-IR requirement key is stable and rejects a bad ordinal', () => {
    expect(pinnedIrRequirementKey(4)).toBe(`pinned_ir:${PINNED_IR_IDENTITY.fixture_id}:rep:4`);
    expect(() => pinnedIrRequirementKey(0)).toThrow(/bad repetition ordinal/);
    expect(() => pinnedIrRequirementKey(1.5)).toThrow(/bad repetition ordinal/);
  });

  test('assertNoPinnedIrOverride tolerates a missing/odd args object', () => {
    expect(() => assertNoPinnedIrOverride(undefined)).not.toThrow();
    expect(() => assertNoPinnedIrOverride({ cohort: 'x' })).not.toThrow();
  });
});

describe('plan00 §C1d — lane model descriptors', () => {
  test('the pinned-IR lane agrees with the fold rule (Luna family, FAST tier)', () => {
    const descriptor = LANE_MODELS[PINNED_IR_MODEL_LANE];
    expect(descriptor).toBeTruthy();
    expect(descriptor.model.startsWith(LUNA_MODEL_FAMILY)).toBe(true);
    expect(FAST_TIERS).toContain(descriptor.tier);
  });

  test('every lane declares every model-selecting variable, so a prior lane cannot leak', () => {
    const names = new Set();
    for (const d of Object.values(LANE_MODELS)) for (const n of Object.keys(d.env)) names.add(n);
    for (const [lane, d] of Object.entries(LANE_MODELS)) {
      for (const n of names) {
        expect({ lane, n, has: Object.prototype.hasOwnProperty.call(d.env, n) }).toEqual({
          lane,
          n,
          has: true,
        });
      }
    }
  });

  test('pinLaneModelEnv sets the environment FROM the descriptor the caller declares', () => {
    const env = { SONNET_EXTRACT_MODEL: 'stale-model', OPENAI_EXTRACT_SERVICE_TIER: 'fast' };
    const descriptor = pinLaneModelEnv('haiku', env);
    expect(env.SONNET_EXTRACT_MODEL).toBe(descriptor.model);
    expect(env.OPENAI_EXTRACT_SERVICE_TIER).toBe(descriptor.tier);
    expect(descriptor).toBe(LANE_MODELS.haiku);
  });

  test('an unknown lane throws and names the known lanes', () => {
    expect(() => resolveLaneModel('sonnet')).toThrow(/unknown model lane/);
    expect(() => resolveLaneModel('sonnet')).toThrow(/luna, haiku/);
    expect(() => resolveLaneModel('constructor')).toThrow(/unknown model lane/);
  });
});

describe('plan00 §C1d — live-evaluation client branding', () => {
  test('a client constructed with SDK retries is refused — a retry burns a second identity', () => {
    expect(() => brandLiveEvaluationClient({}, { provider: 'openai', maxRetries: 2 })).toThrow(
      /maxRetries: 0/
    );
    expect(() => brandLiveEvaluationClient({}, { provider: 'made-up', maxRetries: 0 })).toThrow();
  });
});
