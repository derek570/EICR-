/**
 * ci-and-governance.test.js — the CI history checks (immutability, manifest
 * lock, expected-red closure, evidence re-fetch, ruleset guard) and the
 * signed-commit governance verifier (plan Items 1/2/4/5).
 */

import {
  checkImmutability,
  checkManifestPathLock,
  checkExpectedRedClosure,
  checkNewEvidenceReFetch,
  checkRulesetContexts,
  REQUIRED_RULESET_CONTEXTS,
  CI_ERROR,
} from '../../../scripts/field-replay/ci-history-checks.mjs';
import {
  verifyGovernanceCommit,
  checkRotationIsolation,
  verifyGenesis,
  GOV_ERROR,
} from '../../../scripts/field-replay/lib/governance-core.mjs';
import { attestationPayloadHash } from '../../../scripts/field-replay/lib/canonical-crypto.mjs';
import { immutableProjection } from '../../../scripts/field-replay/lib/fixture-schema.mjs';

const CID = 'frc_0123456789abcdef0123456789abcdef';

function fixtureDoc(overrides = {}) {
  return {
    schema_version: 1,
    corpus_id: CID,
    purpose: 'regression',
    gate_state: 'expected_red',
    expected_failure_id: 'audibility.turn',
    red_proof_failure_id: 'audibility.turn',
    owner: 'Derek Beckley',
    introduced_at: '2026-01-10T00:00:00Z',
    fix_reference: 'fix_fedcba9876543210fedcba9876543210',
    expires_at: '2099-01-01T00:00:00Z',
    initial_state_fidelity: 'hand_authored',
    job_state: { certificateType: 'eicr', boards: [], circuits: [{ number: 2 }] },
    turns: [{ turn_index: 1, at_ms: 0, transcript: 'x', chime_observed: true, model_rounds: [{ stop_reason: 'end_turn' }], confirmations_enabled: { value: true, provenance: 'reconstructed_reviewed' }, in_response_to: { value: false, provenance: 'reconstructed_reviewed' } }],
    is_keystone: true,
    ...overrides,
  };
}

describe('CI immutability check', () => {
  test('an unchanged fixture passes; a payload edit fails; the GREEN flip is legal', () => {
    const base = fixtureDoc();
    expect(checkImmutability({ changedFixtures: [{ path: 'p', base, head: fixtureDoc(), corpus_id: CID }] })).toEqual([]);

    const tampered = fixtureDoc();
    tampered.turns[0].transcript = 'edited';
    const e1 = checkImmutability({ changedFixtures: [{ path: 'p', base, head: tampered, corpus_id: CID }] });
    expect(e1[0].code).toBe(CI_ERROR.IMMUTABLE_CHANGED);

    const green = fixtureDoc({ gate_state: 'required_green' });
    delete green.expected_failure_id;
    expect(checkImmutability({ changedFixtures: [{ path: 'p', base, head: green, corpus_id: CID }] })).toEqual([]);

    const reversed = checkImmutability({ changedFixtures: [{ path: 'p', base: green, head: base, corpus_id: CID }] });
    expect(reversed[0].code).toBe(CI_ERROR.ILLEGAL_TRANSITION);
  });
  test('a newly added fixture (no base) is exempt — immutability begins at merge', () => {
    expect(checkImmutability({ changedFixtures: [{ path: 'p', base: null, head: fixtureDoc(), corpus_id: CID }] })).toEqual([]);
  });
});

describe('manifest-path lock', () => {
  const manifestPaths = ['scripts/field-replay/lib/canonical-crypto.mjs', 'package-lock.json'];
  test('a non-harness (Keystone/fixing) PR touching a manifest path fails', () => {
    const e = checkManifestPathLock({
      isHarnessPR: false,
      changedPaths: ['scripts/field-replay/lib/canonical-crypto.mjs', 'tests/fixtures/field-replay-corpus/frc_x/fixture.yaml'],
      manifestPaths,
    });
    expect(e[0].code).toBe(CI_ERROR.MANIFEST_PATH_CHANGED);
  });
  test('a harness PR may change manifest paths (anchors them)', () => {
    expect(checkManifestPathLock({ isHarnessPR: true, changedPaths: manifestPaths, manifestPaths })).toEqual([]);
  });
});

describe('expected-red closure', () => {
  const fx = { path: 'p', doc: fixtureDoc() };
  const attHash = attestationPayloadHash(immutableProjection(fx.doc));
  const goodEvent = { corpus_id: CID, fixture_attestation_hash: attHash, assertion_id: 'audibility.turn', kind: 'red' };

  test('exactly one qualifying RED event passes; zero or two fail', () => {
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [goodEvent] })).toEqual([]);
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [] })[0].code).toBe(CI_ERROR.RED_CLOSURE_MISSING);
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [goodEvent, goodEvent] })[0].code).toBe(CI_ERROR.RED_CLOSURE_MISSING);
  });
  test('a wrong-hash event does not qualify', () => {
    const bad = { ...goodEvent, fixture_attestation_hash: 'f'.repeat(64) };
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [bad] })[0].code).toBe(CI_ERROR.RED_CLOSURE_MISSING);
  });
  test('the prepush phase-1 state (no evidence yet) is allowed ONLY with allowPhase1', () => {
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [], allowPhase1: true })).toEqual([]);
    expect(checkExpectedRedClosure({ newExpectedRedFixtures: [fx], redEvidenceEvents: [], allowPhase1: false }).length).toBe(1);
  });
});

describe('newly-added evidence re-fetch', () => {
  test('a hand-authored event whose named run does not verify is REJECTED', async () => {
    const fetchers = {
      verifyEvent: async (ev) => (ev.forged ? { ok: false, errors: ['wrong_head_sha'] } : { ok: true }),
    };
    const errors = await checkNewEvidenceReFetch({
      newEvidenceEvents: [{ corpus_id: CID, forged: true, _path: 'e.json' }],
      fetchers,
    });
    expect(errors[0].code).toBe(CI_ERROR.EVIDENCE_UNVERIFIED);
  });
  test('a genuine event that re-fetches clean passes', async () => {
    const fetchers = { verifyEvent: async () => ({ ok: true }) };
    expect(await checkNewEvidenceReFetch({ newEvidenceEvents: [{ corpus_id: CID }], fetchers })).toEqual([]);
  });
});

describe('ruleset-verification guard', () => {
  test('DORMANT before the activation marker; ENFORCING after', () => {
    expect(checkRulesetContexts({ activationMarkerPresent: false, installedRequiredContexts: [] })).toEqual([]);
    const missing = checkRulesetContexts({ activationMarkerPresent: true, installedRequiredContexts: ['Test Backend (Node.js)'] });
    expect(missing.map((e) => e.code)).toEqual([CI_ERROR.RULESET_MISSING_CONTEXT, CI_ERROR.RULESET_MISSING_CONTEXT]);
    expect(checkRulesetContexts({ activationMarkerPresent: true, installedRequiredContexts: [...REQUIRED_RULESET_CONTEXTS] })).toEqual([]);
  });
  test('all three required contexts are pinned (WS5×WS7 drift-stop)', () => {
    expect(REQUIRED_RULESET_CONTEXTS).toEqual([
      'Test Backend (Node.js)',
      'Test Frontend (Next.js)',
      'npm Audit Security Scan',
    ]);
  });
});

describe('signed-commit governance verification', () => {
  const allowlist = {
    keys: [{ identity: 'derek570', fingerprint: 'SHA256:gG+qyc9+qdnGA8rCI1319eRkFLb08rbLMm5j6f3IWDw' }],
  };
  const permittedPaths = ['tests/fixtures/field-replay-corpus/frc_x/evidence/expiry-1.json'];

  test('a correctly-signed, correctly-scoped expiry_extension passes', () => {
    const r = verifyGovernanceCommit({
      commitOid: 'abc123',
      boundOid: 'abc123',
      signature: { verified: true, algorithm: 'ssh-ed25519', keyFingerprint: allowlist.keys[0].fingerprint },
      allowlist,
      changedPaths: permittedPaths,
      permittedPaths,
      eventType: 'expiry_extension',
    });
    expect(r.errors).toEqual([]);
  });
  test('an unsigned commit is rejected', () => {
    const r = verifyGovernanceCommit({
      commitOid: 'abc', boundOid: 'abc', signature: { verified: false }, allowlist, changedPaths: permittedPaths, permittedPaths, eventType: 'expiry_extension',
    });
    expect(r.errors[0].code).toBe(GOV_ERROR.UNSIGNED);
  });
  test('a wrong-but-GitHub-verified key is rejected (verified:true is INSUFFICIENT)', () => {
    const r = verifyGovernanceCommit({
      commitOid: 'abc', boundOid: 'abc',
      signature: { verified: true, algorithm: 'ssh-ed25519', keyFingerprint: 'SHA256:someotherverifiedkey' },
      allowlist, changedPaths: permittedPaths, permittedPaths, eventType: 'expiry_extension',
    });
    expect(r.errors[0].code).toBe(GOV_ERROR.WRONG_KEY_VERIFIED);
  });
  test('a commit touching disallowed paths is rejected', () => {
    const r = verifyGovernanceCommit({
      commitOid: 'abc', boundOid: 'abc',
      signature: { verified: true, keyFingerprint: allowlist.keys[0].fingerprint },
      allowlist,
      changedPaths: [...permittedPaths, 'src/extraction/sonnet-stream.js'],
      permittedPaths, eventType: 'expiry_extension',
    });
    expect(r.errors[0].code).toBe(GOV_ERROR.DIFF_SCOPE);
  });
  test('OID binding: a signature bound to a different commit is rejected', () => {
    const r = verifyGovernanceCommit({
      commitOid: 'abc', boundOid: 'xyz',
      signature: { verified: true, keyFingerprint: allowlist.keys[0].fingerprint },
      allowlist, changedPaths: permittedPaths, permittedPaths, eventType: 'expiry_extension',
    });
    expect(r.errors.some((e) => e.code === GOV_ERROR.OID_MISMATCH)).toBe(true);
  });
  test('rotation isolation: an allowlist rotation may not share a PR with a transition', () => {
    expect(checkRotationIsolation(['allowlist_rotation'])).toEqual([]);
    expect(checkRotationIsolation(['allowlist_rotation', 'expiry_extension'])[0].code).toBe(GOV_ERROR.SELF_AUTHORIZING_ROTATION);
  });
  test('GENESIS: the first entry is verified directly by OID + fingerprint', () => {
    const genesisKey = { fingerprint: 'SHA256:gG+qyc9+qdnGA8rCI1319eRkFLb08rbLMm5j6f3IWDw' };
    expect(verifyGenesis({ signature: { verified: true, keyFingerprint: genesisKey.fingerprint }, genesisKey, commitOid: 'g1', boundOid: 'g1' }).ok).toBe(true);
    expect(verifyGenesis({ signature: { verified: true, keyFingerprint: 'SHA256:wrong' }, genesisKey, commitOid: 'g1', boundOid: 'g1' }).ok).toBe(false);
    expect(verifyGenesis({ signature: { verified: false }, genesisKey, commitOid: 'g1', boundOid: 'g1' }).ok).toBe(false);
  });
});
