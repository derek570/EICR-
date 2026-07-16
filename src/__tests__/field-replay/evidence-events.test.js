/**
 * evidence-events.test.js — trusted-run retrieval verification (mocked
 * GitHub API), append-only evidence, advisory consecutiveness chains, and
 * expiry-extension chains (plan Items 1/2/3).
 *
 * The plan's named mocked-API cases: wrong repository, wrong workflow,
 * wrong SHA, non-success conclusion, digest mismatch, interrupted chain —
 * plus the hand-authored-evidence rejection (a correctly-shaped event with
 * regenerated hashes fails because trusted retrieval cannot verify a run
 * that never produced it).
 */

import { createHash } from 'node:crypto';
import {
  verifyTrustedRun,
  buildEvidenceEvent,
  assertAppendOnly,
  validateAdvisoryGreenChain,
  resolveExpiryChain,
  isExpired,
  EVIDENCE_ERROR_CODES,
} from '../../../scripts/field-replay/lib/evidence-events.mjs';
import {
  retrieveTrustedResult,
  acceptRedEvidence,
  acceptGreenEvidence,
  acceptAdvisoryEvidence,
  TRUSTED,
} from '../../../scripts/field-replay/lib/evidence-accept-core.mjs';

const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

function runnerResult(overrides = {}) {
  return {
    corpus_id: 'frc_0123456789abcdef0123456789abcdef',
    assertion_id: 'audibility.output.out_1',
    subject_code_sha: '8fb95b7b4500e971795ee2d94e01336862186bdf',
    harness_commit_sha: HEAD,
    base_sha: 'c'.repeat(40),
    tested_tree_oid: 'd'.repeat(40),
    fixture_attestation_hash: 'e'.repeat(64),
    exact_command: 'npm run replay:field-corpus -- --fixture=frc_0123456789abcdef0123456789abcdef',
    outcome: 'audibility.output.out_1',
    node_version: 'v20.19.0',
    ...overrides,
  };
}

function mockFetchers({ runOverrides = {}, result = runnerResult(), anchoredBlob = BLOB } = {}) {
  const bytes = Buffer.from(JSON.stringify(result));
  return {
    async getRun() {
      return {
        id: 4242,
        repository: TRUSTED.repository,
        workflow_path: TRUSTED.deterministic_workflow_path,
        workflow_blob_sha: BLOB,
        event: 'pull_request',
        ref: 'refs/heads/ep/keystone',
        head_sha: HEAD,
        conclusion: 'success',
        ...runOverrides,
      };
    },
    async getArtifact(_id, name) {
      return { bytes, digest: createHash('sha256').update(bytes).digest('hex'), name };
    },
    async getAnchoredWorkflowBlobSha() {
      return anchoredBlob;
    },
  };
}

const MANIFEST = { raw_id_map: { 'sess_realid_123x': 'sym_session_1' } };

describe('trusted-run retrieval — mocked-API rejection matrix', () => {
  const base = { runId: 4242, artifactName: 'field-replay-evidence', fetchers: mockFetchers() };

  test('a clean run retrieves and parses', async () => {
    const { parsed } = await retrieveTrustedResult({ mode: 'red', ...base });
    expect(parsed.assertion_id).toBe('audibility.output.out_1');
  });
  test('wrong repository rejects', async () => {
    const fetchers = mockFetchers({ runOverrides: { repository: 'someone/else' } });
    await expect(retrieveTrustedResult({ mode: 'red', ...base, fetchers })).rejects.toMatchObject({
      codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.WRONG_REPOSITORY]),
    });
  });
  test('wrong workflow path rejects', async () => {
    const fetchers = mockFetchers({ runOverrides: { workflow_path: '.github/workflows/deploy.yml' } });
    await expect(retrieveTrustedResult({ mode: 'red', ...base, fetchers })).rejects.toMatchObject({
      codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.WRONG_WORKFLOW]),
    });
  });
  test('a workflow blob differing from the anchored target-branch blob rejects (branch-edited workflow)', async () => {
    const fetchers = mockFetchers({ runOverrides: { workflow_blob_sha: 'f'.repeat(40) } });
    await expect(retrieveTrustedResult({ mode: 'red', ...base, fetchers })).rejects.toMatchObject({
      codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.WORKFLOW_BLOB_MISMATCH]),
    });
  });
  test('wrong head SHA rejects when pinned', async () => {
    await expect(
      retrieveTrustedResult({ mode: 'red', ...base, expectedOverrides: { head_sha: '9'.repeat(40) } }),
    ).rejects.toMatchObject({ codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.WRONG_HEAD_SHA]) });
  });
  test('non-success conclusion rejects', async () => {
    const fetchers = mockFetchers({ runOverrides: { conclusion: 'failure' } });
    await expect(retrieveTrustedResult({ mode: 'red', ...base, fetchers })).rejects.toMatchObject({
      codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.NOT_SUCCESS]),
    });
  });
  test('artifact digest mismatch rejects', async () => {
    await expect(
      retrieveTrustedResult({ mode: 'red', ...base, expectedOverrides: { artifact_digest: '0'.repeat(64) } }),
    ).rejects.toMatchObject({ codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.ARTIFACT_DIGEST]) });
  });
  test('fixture hash + assertion id + tested tree pins reject on mismatch', async () => {
    await expect(
      retrieveTrustedResult({
        mode: 'red',
        ...base,
        expectedOverrides: { fixture_attestation_hash: '1'.repeat(64), assertion_id: 'other.id', tested_tree_oid: '2'.repeat(40) },
      }),
    ).rejects.toMatchObject({
      codes: expect.arrayContaining([
        EVIDENCE_ERROR_CODES.FIXTURE_HASH,
        EVIDENCE_ERROR_CODES.ASSERTION_ID,
        EVIDENCE_ERROR_CODES.TESTED_TREE,
      ]),
    });
  });
});

describe('RED / GREEN / advisory acceptance', () => {
  test('RED evidence: clean acceptance builds the immutable event + hash attestation', async () => {
    const r = await acceptRedEvidence({
      manifest: MANIFEST,
      runId: 4242,
      artifactName: 'field-replay-evidence',
      fetchers: mockFetchers(),
    });
    expect(r.event.kind).toBe('red');
    expect(r.event.subject_code_sha).toBe('8fb95b7b4500e971795ee2d94e01336862186bdf');
    expect(r.attestation.event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fileName).toMatch(/^red-/);
  });
  test('RED evidence containing a private raw-ID fragment rejects (local manifest scan)', async () => {
    const leaky = runnerResult({ outcome: 'audibility.output.out_1 (sess_realid_123x)' });
    await expect(
      acceptRedEvidence({ manifest: MANIFEST, runId: 4242, artifactName: 'x', fetchers: mockFetchers({ result: leaky }) }),
    ).rejects.toThrow(/raw-ID fragment/);
  });
  test('GREEN evidence binds the fixture attestation hash', async () => {
    const att = { immutable_payload_hash: 'e'.repeat(64) };
    const r = await acceptGreenEvidence({ attestation: att, runId: 4242, artifactName: 'x', fetchers: mockFetchers() });
    expect(r.event.kind).toBe('green');
    // A different fixture's attestation rejects.
    await expect(
      acceptGreenEvidence({ attestation: { immutable_payload_hash: '3'.repeat(64) }, runId: 4242, artifactName: 'x', fetchers: mockFetchers() }),
    ).rejects.toMatchObject({ codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.FIXTURE_HASH]) });
  });
  test('a hand-authored event with regenerated hashes is REJECTED — the run it names does not verify', async () => {
    // The forger commits a plausible event naming run 4242 with a fabricated
    // artifact; re-fetch verification recomputes the digest from the REAL
    // artifact bytes and the pins do not line up.
    const forged = runnerResult({ fixture_attestation_hash: '4'.repeat(64) });
    await expect(
      acceptGreenEvidence({
        attestation: { immutable_payload_hash: 'e'.repeat(64) },
        runId: 4242,
        artifactName: 'x',
        fetchers: mockFetchers({ result: forged }),
      }),
    ).rejects.toMatchObject({ codes: expect.arrayContaining([EVIDENCE_ERROR_CODES.FIXTURE_HASH]) });
  });
  test('advisory acceptance uses the nightly workflow anchor', async () => {
    const fetchers = mockFetchers({
      runOverrides: { workflow_path: TRUSTED.advisory_workflow_path, event: 'schedule' },
      result: runnerResult({ model: 'claude-haiku-4-5-20251001', behaviour_fingerprint: 'f'.repeat(64), outcome: 'pass' }),
    });
    const r = await acceptAdvisoryEvidence({ runId: 4242, artifactName: 'x', fetchers });
    expect(r.event.kind).toBe('advisory');
  });
});

describe('append-only evidence', () => {
  test('overwrites are rejected', () => {
    expect(() => assertAppendOnly(['red-a-1.json'], 'red-a-1.json')).toThrow(/append-only/);
    expect(() => assertAppendOnly(['red-a-1.json'], 'red-a-2.json')).not.toThrow();
  });
});

describe('advisory consecutiveness (three-event chain)', () => {
  const ev = (outcome, runId, fp = 'fp1') => ({
    kind: 'advisory',
    outcome,
    model: 'claude-haiku-4-5-20251001',
    assertion_id: 'obs.routing.model_origin',
    behaviour_fingerprint: fp,
    run: { id: runId },
  });

  test('three consecutive passes with distinct runs qualify', () => {
    const r = validateAdvisoryGreenChain([ev('pass', 1), ev('pass', 2), ev('pass', 3)]);
    expect(r.ok).toBe(true);
    expect(r.chain).toHaveLength(3);
  });
  test('an intervening qualifying failure resets the chain (interrupted chain)', () => {
    const r = validateAdvisoryGreenChain([ev('pass', 1), ev('fail', 2), ev('pass', 3), ev('pass', 4)]);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(EVIDENCE_ERROR_CODES.CHAIN_TOO_SHORT);
  });
  test('a behaviour_fingerprint change resets the chain', () => {
    const r = validateAdvisoryGreenChain([ev('pass', 1), ev('pass', 2, 'fp2'), ev('pass', 3, 'fp2')]);
    expect(r.ok).toBe(false);
  });
  test('duplicate run ids cannot satisfy the chain', () => {
    const r = validateAdvisoryGreenChain([ev('pass', 1), ev('pass', 1), ev('pass', 2)]);
    expect(r.ok).toBe(false);
  });
  test('the lifecycle flip path rejects without the chain', async () => {
    const fetchers = mockFetchers({
      runOverrides: { workflow_path: TRUSTED.advisory_workflow_path, event: 'schedule' },
      result: runnerResult({ model: 'm', behaviour_fingerprint: 'fp1', outcome: 'pass' }),
    });
    await expect(
      acceptAdvisoryEvidence({ runId: 4242, artifactName: 'x', fetchers, history: [], lifecycleFlipRequested: true }),
    ).rejects.toThrow(/three consecutive/);
  });
});

describe('expiry-extension chains + wall-clock expiry', () => {
  const initial = '2026-02-10T09:00:00.000Z';
  const ext = (prior, next, extra = {}) => ({
    prior_expires_at: prior,
    new_expires_at: next,
    reason: 'fix wave slipped one sprint',
    reviewer: 'Derek Beckley',
    fix_reference: 'fix_fedcba9876543210fedcba9876543210',
    ...extra,
  });

  test('a valid chronological chain resolves (two 14-day extensions max)', () => {
    const e1 = ext(initial, '2026-02-24T09:00:00.000Z');
    const e2 = ext('2026-02-24T09:00:00.000Z', '2026-03-10T09:00:00.000Z');
    const r = resolveExpiryChain(initial, [e1, e2]);
    expect(r.ok).toBe(true);
    expect(r.effectiveExpiry).toBe('2026-03-10T09:00:00.000Z');
  });
  test('gaps, backward dates, oversize extensions, missing reviewer, and a third extension reject', () => {
    expect(resolveExpiryChain(initial, [ext('2026-02-11T09:00:00.000Z', '2026-02-25T09:00:00.000Z')]).ok).toBe(false);
    expect(resolveExpiryChain(initial, [ext(initial, '2026-02-01T09:00:00.000Z')]).ok).toBe(false);
    expect(resolveExpiryChain(initial, [ext(initial, '2026-03-10T09:00:00.000Z')]).ok).toBe(false); // 28d > 14d
    expect(resolveExpiryChain(initial, [ext(initial, '2026-02-24T09:00:00.000Z', { reviewer: null })]).ok).toBe(false);
    const e1 = ext(initial, '2026-02-24T09:00:00.000Z');
    const e2 = ext('2026-02-24T09:00:00.000Z', '2026-03-10T09:00:00.000Z');
    const e3 = ext('2026-03-10T09:00:00.000Z', '2026-03-24T09:00:00.000Z');
    expect(resolveExpiryChain(initial, [e1, e2, e3]).ok).toBe(false);
  });
  test('expiry evaluates against the REAL wall clock, never replay time — boundary at just-before/at/after', () => {
    const t = Date.parse(initial);
    expect(isExpired(initial, t - 1)).toBe(false);
    expect(isExpired(initial, t)).toBe(true);
    expect(isExpired(initial, t + 1)).toBe(true);
  });
});

describe('buildEvidenceEvent', () => {
  test('unknown kinds throw; the attestation hash is deterministic', () => {
    expect(() => buildEvidenceEvent({ kind: 'bogus' })).toThrow(/unknown evidence kind/);
    const a = buildEvidenceEvent({ kind: 'red', corpus_id: 'frc_x', outcome: 'o' });
    const b = buildEvidenceEvent({ kind: 'red', corpus_id: 'frc_x', outcome: 'o' });
    expect(a.attestation.event_hash).toBe(b.attestation.event_hash);
  });
});
