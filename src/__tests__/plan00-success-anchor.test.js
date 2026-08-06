/**
 * Plan 00B-4 §"Digest + success-record contract" — the success-artifact chain
 * and cohort supersession.
 *
 * The defect this closes is a SELF-CONSISTENT LIE. Every pre-existing Plan-00
 * command compared the expectation manifest to ITSELF: `attest-expectations`
 * recomputed the semantic oracle from the checked-out sources and compared it to
 * the digest that same manifest declares, so a regenerated or hand-edited
 * manifest passed every check by construction. The shipped 00B `/ep` success
 * record is the one anchor OUTSIDE the manifest — written by a run that was
 * genuinely merged and deployed — so it is the only thing that can tell "the
 * manifest still says what it was proven to say" apart from "the manifest says
 * something new and internally consistent".
 *
 * Two halves, both driven through the REAL exported functions:
 *
 *  1. `assertSuccessArtifactChain` / `assertNotStageARebind` / the four
 *     `assertPlan00Anchors` phase modes. Each test perturbs exactly ONE input,
 *     so a passing test proves that clause is what refused.
 *
 *  2. Cohort supersession end-to-end against a real memory store: a second
 *     deployment voids the first, the shared resolver picks the successor, the
 *     run gate refuses an explicitly-named voided cohort BEFORE allocating, and
 *     the voided cohort's stored events are proven byte-unmutated (voiding is a
 *     forward-only assertion on a NEW record, never a rewrite of an old one —
 *     the store is append-only and a "fix" that mutated history would be
 *     undetectable by every downstream fold).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';

import { createMemoryStore } from '../../scripts/plan00-evidence/lib/memory-store.mjs';
import { EVIDENCE_PREFIX, STAGE_A_COHORT } from '../../scripts/plan00-evidence/lib/constants.mjs';
import { buildEvent, eventSchemaHash } from '../../scripts/plan00-evidence/lib/events.mjs';
import { publishDurable } from '../../scripts/plan00-evidence/lib/store.mjs';
import {
  ANCHOR_MODES,
  PLAN00_MANIFEST_REPO_PATH,
  PLAN00_SUCCESS_ARTIFACT_ID,
  assertNotStageARebind,
  assertSuccessArtifactChain,
  defaultSuccessRecordPath,
  findManifestArtifactRow,
  readSuccessRecordFile,
  validateSuccessRecordSchema,
} from '../../scripts/plan00-evidence/lib/success-record.mjs';
import {
  assertPlan00Anchors,
  assertRunPreconditions,
  cmdStatus,
  computeCohortFingerprint,
  resolveCohortId,
  resolveStatusCohortId,
} from '../../scripts/plan00-evidence/cli.mjs';
import { evidenceEventHash } from '../../scripts/field-replay/lib/canonical-crypto.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The manifest bytes are the REAL committed file, not a fixture: the whole
// contract is "the shipped record still describes what is checked out", and a
// synthetic manifest would test the comparison against itself — the exact
// self-consistency this module exists to break. Deriving the sha here (rather
// than hard-coding it) means the fixture self-updates when the manifest is
// regenerated, so these tests never go red for a reason unrelated to the code.
const MANIFEST_BYTES = readFileSync(path.join(REPO_ROOT, PLAN00_MANIFEST_REPO_PATH));
const MANIFEST_SHA256 = createHash('sha256').update(MANIFEST_BYTES).digest('hex');
const REAL_MANIFEST = JSON.parse(MANIFEST_BYTES.toString('utf8'));
const ORACLE_DIGEST = REAL_MANIFEST.semantic_oracle_digest;

const FP = 'f'.repeat(64);
const HEAD_SHA = 'a'.repeat(40);

function successRecordFixture(overrides = {}) {
  return {
    schema_version: 1,
    terminal_class: 'shipped',
    plan: { sha256: '1'.repeat(64) },
    merge_commit: '9'.repeat(40),
    deploy: { result: 'success' },
    artifacts: [
      {
        id: PLAN00_SUCCESS_ARTIFACT_ID,
        path: PLAN00_MANIFEST_REPO_PATH,
        sha256: MANIFEST_SHA256,
      },
    ],
    ...overrides,
  };
}

function chainOverrides(extra = {}) {
  return {
    recordPath: '/test/PLAN-final.md.ep-success.json',
    readRecord: () => successRecordFixture(),
    readManifestBytes: () => MANIFEST_BYTES,
    readManifest: () => JSON.parse(JSON.stringify(REAL_MANIFEST)),
    recomputeOracle: async () => ORACLE_DIGEST,
    ...extra,
  };
}

/** The `successRecord` sub-block `assertPlan00Anchors` forwards to the chain. */
function passingSuccessRecord(extra = {}) {
  return {
    recordPath: '/test/PLAN-final.md.ep-success.json',
    readRecord: () => successRecordFixture(),
    readManifestBytes: () => MANIFEST_BYTES,
    ...extra,
  };
}

function anchorOverrides(extra = {}) {
  return {
    readManifest: () => JSON.parse(JSON.stringify(REAL_MANIFEST)),
    recomputeOracle: async () => ORACLE_DIGEST,
    successRecord: passingSuccessRecord(),
    ...extra,
  };
}

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

/** Seed stage_a_deployed → expectations_attested → cohort_initialized. */
async function establishCohort(
  store,
  { at = '2026-08-09T08:00:00Z', stageA: stageAOverrides, initBody: initOverrides } = {}
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
  const { cohortId, fingerprint } = computeCohortFingerprint(shas);
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
  await publishEventAt(store, {
    kind: 'cohort_initialized',
    cohortId,
    namespace: 'derek',
    body: {
      cohort_fingerprint: fingerprint,
      stage_a_event_hash: evidenceEventHash(stageA.payload),
      expectations_event_hash: evidenceEventHash(attested.payload),
      manifest_artifact_sha256: MANIFEST_SHA256,
      semantic_oracle_digest: ORACLE_DIGEST,
      ...initOverrides,
    },
  });
  return { cohortId, stageA, attested };
}

async function reservationKeys(store, cohortId) {
  const { versions } = await store.listAllVersions({
    prefix: `${EVIDENCE_PREFIX}/reservations/${cohortId}/`,
  });
  return [...new Set(versions.map((v) => v.key))].sort();
}

/**
 * A content-addressed snapshot of every stored version under a cohort.
 *
 * Keys are payload hashes and the store is append-only, so an identical
 * snapshot before and after is proof that nothing under that cohort was
 * rewritten, deleted or re-versioned — which is the whole claim "superseded
 * evidence is voided, never mutated" rests on.
 */
async function versionSnapshot(store, cohortId) {
  const { versions } = await store.listAllVersions({
    prefix: `${EVIDENCE_PREFIX}/events/${cohortId}/`,
  });
  return versions.map((v) => `${v.key}#${v.versionId ?? ''}`).sort();
}

function runOverrides(extra = {}) {
  return {
    readManifest: () => JSON.parse(JSON.stringify(REAL_MANIFEST)),
    recomputeOracle: async () => ORACLE_DIGEST,
    liveCheck: async () => ({ available: true, fingerprint_matches: true }),
    readHeadSha: async () => `${HEAD_SHA}\n`,
    readPorcelain: async () => '',
    successRecord: passingSuccessRecord(),
    ...extra,
  };
}

// ── the phase-independent chain ───────────────────────────────────────────

describe('plan00 — the 00B success-artifact chain', () => {
  test('a well-formed record over the committed manifest resolves', async () => {
    const chain = await assertSuccessArtifactChain(chainOverrides());
    expect(chain.manifestSha256).toBe(MANIFEST_SHA256);
    expect(chain.oracleDigest).toBe(ORACLE_DIGEST);
    expect(chain.row.path).toBe(PLAN00_MANIFEST_REPO_PATH);
    expect(chain.recordPath).toBe('/test/PLAN-final.md.ep-success.json');
  });

  test.each([
    ['a held run is not an anchor', { terminal_class: 'held' }, /terminal_class must be "shipped"/],
    ['an unknown schema version', { schema_version: 2 }, /schema_version must be 1/],
    ['a truncated plan hash', { plan: { sha256: 'abc' } }, /plan\.sha256 is not a sha256/],
    ['a missing plan block', { plan: undefined }, /plan block missing/],
    ['a non-sha merge commit', { merge_commit: 'HEAD' }, /merge_commit is not a 40-hex/],
    ['a failed deploy', { deploy: { result: 'failure' } }, /deploy\.result must be "success"/],
    ['a missing deploy block', { deploy: undefined }, /deploy block missing/],
    ['no artifacts at all', { artifacts: [] }, /artifacts must be a non-empty array/],
  ])('refuses %s', async (_label, overrides, pattern) => {
    await expect(
      assertSuccessArtifactChain(
        chainOverrides({ readRecord: () => successRecordFixture(overrides) })
      )
    ).rejects.toThrow(pattern);
  });

  test('reports EVERY schema problem at once, so a fix is one pass not five', () => {
    const problems = validateSuccessRecordSchema({
      schema_version: 2,
      terminal_class: 'held',
      merge_commit: 'nope',
      artifacts: [],
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });

  test('a non-object record is rejected without inspecting fields', () => {
    expect(validateSuccessRecordSchema(null)).toEqual(['record is not a JSON object']);
    expect(validateSuccessRecordSchema([])).toEqual(['record is not a JSON object']);
  });

  test('duplicate manifest artifact rows are refused — never first-match-wins', () => {
    const record = successRecordFixture();
    record.artifacts.push({
      id: PLAN00_SUCCESS_ARTIFACT_ID,
      path: PLAN00_MANIFEST_REPO_PATH,
      sha256: '0'.repeat(64),
    });
    expect(() => findManifestArtifactRow(record)).toThrow(/EXACTLY ONE .* \(found 2\)/);
  });

  test('a row naming a DIFFERENT file is refused — it would look like a check', () => {
    const record = successRecordFixture();
    record.artifacts[0].path = 'scripts/model-ab/some-other-file.json';
    expect(() => findManifestArtifactRow(record)).toThrow(/different file/);
  });

  test('a non-sha256 row hash is refused', () => {
    const record = successRecordFixture();
    record.artifacts[0].sha256 = 'deadbeef';
    expect(() => findManifestArtifactRow(record)).toThrow(/not a sha256 hex digest/);
  });

  test('a manifest whose bytes drifted from the pinned sha is refused, naming both', async () => {
    const stale = successRecordFixture();
    stale.artifacts[0].sha256 = '0'.repeat(64);
    await expect(
      assertSuccessArtifactChain(chainOverrides({ readRecord: () => stale }))
    ).rejects.toThrow(new RegExp(`hashes to ${MANIFEST_SHA256} but the shipped 00B`));
  });

  test('semantic_oracle_digest drift is refused', async () => {
    await expect(
      assertSuccessArtifactChain(chainOverrides({ recomputeOracle: async () => 'b'.repeat(64) }))
    ).rejects.toThrow(/semantic_oracle_digest drift/);
  });

  test('a tampered record refuses BEFORE the oracle recompute is ever run', async () => {
    // Ordering is the point: recomputing the oracle walks the whole enumerated
    // source list. A record that cannot be trusted must cost nothing to reject.
    const recomputeOracle = jest.fn(async () => ORACLE_DIGEST);
    await expect(
      assertSuccessArtifactChain(
        chainOverrides({
          readRecord: () => successRecordFixture({ terminal_class: 'partial' }),
          recomputeOracle,
        })
      )
    ).rejects.toThrow(/REFUSED:/);
    expect(recomputeOracle).not.toHaveBeenCalled();
  });

  test('an unreadable record names the path and says why it matters', () => {
    expect(() => readSuccessRecordFile('/definitely/not/here.json')).toThrow(
      /unreadable at \/definitely\/not\/here\.json.*only anchor outside the manifest/s
    );
  });

  test('a corrupt record reports JSON failure, not a schema failure', async () => {
    await expect(
      assertSuccessArtifactChain(
        chainOverrides({
          readRecord: () => {
            throw new Error('REFUSED: the 00B success record at /x is not valid JSON (boom)');
          },
        })
      )
    ).rejects.toThrow(/not valid JSON/);
  });

  test('the default record path honours the env override and is otherwise HOME-anchored', () => {
    expect(defaultSuccessRecordPath({ PLAN00_SUCCESS_RECORD: '/tmp/x.json' }, '/home/d')).toBe(
      '/tmp/x.json'
    );
    expect(defaultSuccessRecordPath({}, '/home/d')).toBe(
      '/home/d/.claude/handoffs/EICR_Automation--00b-trusted-semantic-oracle-2026-08-03/PLAN-final.md.ep-success.json'
    );
  });
});

// ── the publish-phase rebind test ─────────────────────────────────────────

describe('plan00 — assertNotStageARebind', () => {
  const boundStageAPayload = stageABody();

  test('an identical deploy identity is a rebind and is refused', () => {
    expect(() =>
      assertNotStageARebind({
        boundStageAPayload,
        candidate: { run_id: '1', head_sha: HEAD_SHA, deployment_fingerprint: FP },
        cohortId: 'cohort-x',
      })
    ).toThrow(/rebind of a live cohort, not a new deployment/);
  });

  test.each([
    ['a new deploy run', { run_id: '2' }],
    ['a new head sha', { head_sha: 'b'.repeat(40) }],
    ['a new runtime fingerprint', { deployment_fingerprint: 'e'.repeat(64) }],
  ])('%s is a genuine redeploy and is ADMITTED', (_label, diff) => {
    const result = assertNotStageARebind({
      boundStageAPayload,
      candidate: { run_id: '1', head_sha: HEAD_SHA, deployment_fingerprint: FP, ...diff },
      cohortId: 'cohort-x',
    });
    expect(result.rebind).toBe(false);
    expect(result.differing).toEqual([Object.keys(diff)[0]]);
  });

  test('the first publish — nothing bound yet — is admitted', () => {
    expect(assertNotStageARebind({ boundStageAPayload: null, candidate: {} })).toEqual({
      rebind: false,
      reason: 'no live cohort binds a stage_a event',
    });
  });
});

// ── the four phase modes ──────────────────────────────────────────────────

describe('plan00 — assertPlan00Anchors phase modes', () => {
  let store;

  beforeEach(() => {
    store = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
  });

  test('an unknown mode throws and names the four it knows', async () => {
    await expect(assertPlan00Anchors({ mode: 'sideways', store })).rejects.toThrow(
      /unknown mode "sideways".*publish, attest, init, run/
    );
    expect(ANCHOR_MODES).toEqual(['publish', 'attest', 'init', 'run']);
  });

  test.each(ANCHOR_MODES)('mode=%s refuses a tampered success record', async (mode) => {
    await establishCohort(store);
    await expect(
      assertPlan00Anchors({
        mode,
        store,
        args: { 'run-id': '9', 'head-sha': HEAD_SHA },
        overrides: anchorOverrides({
          successRecord: passingSuccessRecord({
            readRecord: () => successRecordFixture({ terminal_class: 'failed' }),
          }),
        }),
      })
    ).rejects.toThrow(/REFUSED:/);
  });

  test.each([
    ['run-id', { 'head-sha': HEAD_SHA }],
    ['head-sha', { 'run-id': '9' }],
  ])('publish requires --%s', async (missing, args) => {
    await expect(
      assertPlan00Anchors({ mode: 'publish', store, args, overrides: anchorOverrides() })
    ).rejects.toThrow(new RegExp(`publish-stage-a requires --${missing}`));
  });

  test('publish refuses a bare valueless flag, not just an absent one', async () => {
    // `parseArgs` turns `--run-id` with no value into `true`; accepting that
    // would anchor a deployment to the literal string "true".
    await expect(
      assertPlan00Anchors({
        mode: 'publish',
        store,
        args: { 'run-id': true, 'head-sha': HEAD_SHA },
        overrides: anchorOverrides(),
      })
    ).rejects.toThrow(/publish-stage-a requires --run-id/);
  });

  test('publish with no cohort yet returns a null rebind target — always admitted', async () => {
    const out = await assertPlan00Anchors({
      mode: 'publish',
      store,
      args: { 'run-id': '9', 'head-sha': HEAD_SHA },
      overrides: anchorOverrides(),
    });
    expect(out.rebindTarget).toBeNull();
    expect(out.oracleDigest).toBe(ORACLE_DIGEST);
  });

  test('publish resolves the live cohort’s bound stage-A, and that payload rebind-refuses', async () => {
    const { cohortId } = await establishCohort(store);
    const out = await assertPlan00Anchors({
      mode: 'publish',
      store,
      args: { 'run-id': '9', 'head-sha': HEAD_SHA },
      overrides: anchorOverrides(),
    });
    expect(out.rebindTarget.cohortId).toBe(cohortId);
    expect(out.rebindTarget.boundStageAPayload.deploy_run.run_id).toBe('1');

    // The resolved payload is exactly what the rebind test consumes: feeding its
    // own identity back must refuse, and a genuinely new run must not.
    expect(() =>
      assertNotStageARebind({
        boundStageAPayload: out.rebindTarget.boundStageAPayload,
        candidate: { run_id: '1', head_sha: HEAD_SHA, deployment_fingerprint: FP },
        cohortId,
      })
    ).toThrow(/rebind of a live cohort/);
    expect(
      assertNotStageARebind({
        boundStageAPayload: out.rebindTarget.boundStageAPayload,
        candidate: { run_id: '2', head_sha: HEAD_SHA, deployment_fingerprint: FP },
        cohortId,
      }).rebind
    ).toBe(false);
  });

  test.each(['attest', 'init'])('mode=%s refuses when no stage_a exists yet', async (mode) => {
    await expect(
      assertPlan00Anchors({ mode, store, overrides: anchorOverrides() })
    ).rejects.toThrow(/no valid stage_a_deployed event is readable/);
  });

  test.each(['attest', 'init'])(
    'mode=%s refuses when the PUBLISHED stage-A oracle differs from the checkout',
    async (mode) => {
      await establishCohort(store, {
        stageA: { semantic_oracle_digest: 'c'.repeat(64) },
      });
      await expect(
        assertPlan00Anchors({ mode, store, overrides: anchorOverrides() })
      ).rejects.toThrow(/published Stage-A anchor declares semantic_oracle_digest/);
    }
  );

  test('mode=init returns the stage-A record it will bind', async () => {
    const { stageA } = await establishCohort(store);
    const out = await assertPlan00Anchors({ mode: 'init', store, overrides: anchorOverrides() });
    expect(evidenceEventHash(out.stageA.payload)).toBe(evidenceEventHash(stageA.payload));
  });

  test('mode=run returns the bare chain — the cohort binding is layered on above', async () => {
    const out = await assertPlan00Anchors({ mode: 'run', store, overrides: anchorOverrides() });
    expect(out.rebindTarget).toBeUndefined();
    expect(out.stageA).toBeUndefined();
    expect(out.manifestSha256).toBe(MANIFEST_SHA256);
  });
});

// ── cohort supersession ───────────────────────────────────────────────────

describe('plan00 — cohort supersession voids the prior cohort', () => {
  let store;

  beforeEach(() => {
    store = createMemoryStore({ bucket: 'test-bucket', versioning: 'Enabled' });
  });

  /** A second deployment, explicitly recording which cohort it voids. */
  async function supersede(priorCohortId, { at = '2026-08-09T12:00:00Z', runId = '2' } = {}) {
    return establishCohort(store, {
      at,
      stageA: { deploy_run: { run_id: runId, head_sha: HEAD_SHA, repository: 'derek570/EICR-' } },
      initBody: { supersedes: priorCohortId },
    });
  }

  test('two live cohorts with no supersession are genuinely ambiguous', async () => {
    await establishCohort(store);
    await establishCohort(store, {
      at: '2026-08-09T12:00:00Z',
      stageA: { deploy_run: { run_id: '2', head_sha: HEAD_SHA, repository: 'derek570/EICR-' } },
    });
    await expect(resolveCohortId(store, {})).rejects.toThrow(/multiple cohorts exist/);
  });

  test('the shared resolver picks the successor once supersession is recorded', async () => {
    const first = await establishCohort(store);
    const second = await supersede(first.cohortId);
    expect(second.cohortId).not.toBe(first.cohortId);
    await expect(resolveCohortId(store, {})).resolves.toBe(second.cohortId);
  });

  test('a chain A→B→C resolves to C — every voided link drops out', async () => {
    const a = await establishCohort(store);
    const b = await supersede(a.cohortId, { at: '2026-08-09T12:00:00Z', runId: '2' });
    const c = await supersede(b.cohortId, { at: '2026-08-09T14:00:00Z', runId: '3' });
    await expect(resolveCohortId(store, {})).resolves.toBe(c.cohortId);
  });

  test('an explicit --cohort still wins — supersession never overrides an operator', async () => {
    const first = await establishCohort(store);
    await supersede(first.cohortId);
    await expect(resolveCohortId(store, { cohort: first.cohortId })).resolves.toBe(first.cohortId);
  });

  test('the run gate refuses a superseded --cohort BEFORE allocating anything', async () => {
    const first = await establishCohort(store);
    const second = await supersede(first.cohortId);
    await expect(
      assertRunPreconditions(store, { cohort: first.cohortId }, runOverrides())
    ).rejects.toThrow(new RegExp(`cohort ${first.cohortId} was superseded by ${second.cohortId}`));
    // Dispatching into a void cohort spends real vendor money on evidence that
    // can never count, so the refusal must precede every allocation.
    expect(await reservationKeys(store, first.cohortId)).toEqual([]);
    expect(await reservationKeys(store, second.cohortId)).toEqual([]);
  });

  test('the run gate resolves to the successor with no --cohort at all', async () => {
    const first = await establishCohort(store);
    const second = await supersede(first.cohortId);
    const pre = await assertRunPreconditions(store, {}, runOverrides());
    expect(pre.cohortId).toBe(second.cohortId);
  });

  test('superseding MUTATES NOTHING under the voided cohort', async () => {
    const first = await establishCohort(store);
    const before = await versionSnapshot(store, first.cohortId);
    expect(before.length).toBeGreaterThan(0);

    const second = await supersede(first.cohortId);
    await cmdStatus({ cohort: first.cohortId }, store);

    const after = await versionSnapshot(store, first.cohortId);
    expect(after).toEqual(before);
    expect(await versionSnapshot(store, second.cohortId)).not.toEqual(before);
  });

  test('status reports a superseded cohort as VOID with zero day credit', async () => {
    const first = await establishCohort(store);
    const second = await supersede(first.cohortId);
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
    try {
      // Returns before any AWS/fold work — proven by this running against a pure
      // memory store with no aws runner stubbed at all.
      await cmdStatus({ cohort: first.cohortId }, store);
    } finally {
      spy.mockRestore();
    }
    expect(lines[0]).toBe(`State: VOID (superseded by ${second.cohortId})`);
    expect(lines).toContain('qualifying_days: 0');
    expect(lines.join('\n')).toMatch(/does not count toward the gate/);
  });
});

// ── the status-specific resolution ladder ─────────────────────────────────

describe('plan00 — resolveStatusCohortId', () => {
  const s = (over = {}) => ({ ids: [], initialized: new Map(), live: [], ...over });

  test('an explicit --cohort always wins', () => {
    expect(resolveStatusCohortId(s(), 'cohort-explicit')).toBe('cohort-explicit');
  });

  test('the single live INITIALISED cohort is preferred', () => {
    const state = s({
      ids: ['a', 'b'],
      live: ['a', 'b'],
      initialized: new Map([['b', {}]]),
    });
    expect(resolveStatusCohortId(state, null)).toBe('b');
  });

  test('a sole UNINITIALISED cohort is still reported — that is what status is for', () => {
    // The write commands are right to refuse this; status must not, or the one
    // state an operator most needs to see becomes invisible.
    expect(resolveStatusCohortId(s({ ids: ['a'], live: ['a'] }), null)).toBe('a');
  });

  test('no cohort at all resolves to null rather than throwing', () => {
    expect(resolveStatusCohortId(s(), null)).toBeNull();
  });

  test('genuinely ambiguous state asks for --cohort', () => {
    expect(() => resolveStatusCohortId(s({ ids: ['a', 'b'], live: ['a', 'b'] }), null)).toThrow(
      /multiple live cohorts exist \(a, b\)/
    );
  });
});
