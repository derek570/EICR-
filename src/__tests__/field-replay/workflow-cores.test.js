/**
 * workflow-cores.test.js — stage-1/2/3 workflow cores + discovery (plan
 * Item 1 "Concrete workflow" + Item 2 "Discovery"). Covers the mixed
 * CloudWatch+debug-report conversion, stale-secondary failure, permission
 * preflight, draft-location guards, acceptance fail-closed conditions,
 * attestation tamper detection, expiry stamping, and corpus discovery
 * (exact basename, nested dirs, empty-corpus PASS semantics).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convertSession,
  parseSourceArg,
  checkSourcePermissions,
  isInsideCorpusRoot,
  CORPUS_ROOT,
} from '../../../scripts/field-replay/lib/convert-core.mjs';
import {
  acceptFixture,
  validateCommittedFixture,
  computeExpiresAt,
  EXPIRY_POLICY,
} from '../../../scripts/field-replay/lib/accept-core.mjs';
import {
  discoverFixtures,
  assertUniqueCorpusIds,
} from '../../../scripts/field-replay/lib/discovery.mjs';
import { OPAQUE_REF_CLASSES } from '../../../scripts/field-replay/lib/identity-constants.mjs';

const T0 = Date.UTC(2026, 0, 10, 6, 11, 42);
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-wf-'));
  fs.chmodSync(tmpRoot, 0o700);
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSource(name, content, mode = 0o600) {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, { mode });
  fs.chmodSync(p, mode);
  return p;
}

function primaryRows() {
  return [
    JSON.stringify({ timestamp: iso(T0), message: 'transcript', sessionId: 'sym_session_1', text: 'synthetic' }),
    JSON.stringify({ timestamp: iso(T0 + 500), message: 'Client diagnostic', category: 'chime_invoke', sessionId: 'sym_session_1', branch: 'confirmation' }),
    JSON.stringify({ timestamp: iso(T0 + 2000), message: 'transcript', sessionId: 'sym_session_1', text: 'follow up' }),
    JSON.stringify({
      timestamp: iso(T0 + 3000),
      message: 'Client log batch entry',
      sessionId: 'sym_session_1',
      client_log: { category: 'feedback', event: 'debug_report_uploaded', data: { description: 'synthetic issue text' } },
    }),
  ].join('\n');
}

describe('convert-core (stage 1)', () => {
  test('parseSourceArg validates shape and type', () => {
    expect(parseSourceArg('cloudwatch:primary:/x/y.jsonl')).toEqual({ type: 'cloudwatch', role: 'primary', path: '/x/y.jsonl' });
    expect(() => parseSourceArg('bogus:primary:/x')).toThrow(/unknown source type/);
    expect(() => parseSourceArg('cloudwatch:/x')).toThrow(/--source must be/);
  });

  test('permission preflight rejects world-readable sources and broad directories', () => {
    const p = writeSource('cw.jsonl', primaryRows(), 0o644);
    expect(checkSourcePermissions(p).ok).toBe(false);
    fs.chmodSync(p, 0o600);
    expect(checkSourcePermissions(p).ok).toBe(true);
    fs.chmodSync(tmpRoot, 0o755);
    expect(checkSourcePermissions(p).ok).toBe(false);
    fs.chmodSync(tmpRoot, 0o700);
  });

  test('mixed CloudWatch + debug-report conversion produces manifest + committed source commitments (no raw hashes in the draft)', () => {
    const cw = writeSource('cw.jsonl', primaryRows());
    const rep = writeSource('rep.json', JSON.stringify({ timestamp: iso(T0 + 3100), description: 'synthetic issue text' }));
    const { corpusId, draft, manifest } = convertSession({
      sourceSpecs: [
        { type: 'cloudwatch', role: 'primary', path: cw },
        { type: 'debug_report', role: 'supporting', path: rep },
      ],
      expectedSessionId: 'sym_session_1',
    });
    expect(corpusId).toMatch(OPAQUE_REF_CLASSES.corpus.pattern);
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.sources.every((s) => s.freshness.status === 'fresh')).toBe(true);
    expect(manifest.commitment_key_hex).toMatch(/^[0-9a-f]{64}$/);
    // Draft carries KEYED commitments only — never the raw fingerprints.
    const draftJson = JSON.stringify(draft);
    for (const s of manifest.sources) {
      expect(draftJson).not.toContain(s.fingerprint);
    }
    expect(draft.sources.every((s) => /^[0-9a-f]{64}$/.test(s.commitment))).toBe(true);
    expect(manifest.chime_correlations).toHaveLength(1);
  });

  test('a stale/changed secondary report fails conversion closed', () => {
    const cw = writeSource('cw.jsonl', primaryRows());
    const rep = writeSource('rep.json', JSON.stringify({ timestamp: iso(T0 + 3100), description: 'DIFFERENT text that matches no upload event' }));
    expect(() =>
      convertSession({
        sourceSpecs: [
          { type: 'cloudwatch', role: 'primary', path: cw },
          { type: 'debug_report', role: 'supporting', path: rep },
        ],
        expectedSessionId: 'sym_session_1',
      }),
    ).toThrow(/fails closed/);
  });

  test('corpus-root path guard', () => {
    expect(isInsideCorpusRoot(`${CORPUS_ROOT}/frc_x/fixture.yaml`)).toBe(true);
    expect(isInsideCorpusRoot('.field-replay-drafts/x.draft.yaml')).toBe(false);
  });
});

function validDraft(corpusId) {
  return {
    schema_version: 1,
    corpus_id: corpusId,
    purpose: 'regression',
    gate_state: 'expected_red',
    expected_failure_id: 'audibility.output.out_1',
    red_proof_failure_id: 'audibility.output.out_1',
    owner: 'Derek Beckley',
    introduced_at: '2026-01-10T00:00:00Z',
    fix_reference: 'fix_fedcba9876543210fedcba9876543210',
    expires_at: 'PENDING-ACCEPTANCE',
    initial_state_fidelity: 'hand_authored',
    job_state: { certificateType: 'eicr', boards: [], circuits: [{ circuit_ref: '2' }] },
    turns: [
      {
        turn_index: 1,
        at_ms: 0,
        transcript: 'synthetic garbled text',
        regex_results: [],
        confirmations_enabled: { value: true, provenance: 'recorded_full' },
        in_response_to: { value: false, provenance: 'recorded_full' },
        ws_mode: 'open',
        chime_observed: true,
        model_rounds: [{ stop_reason: 'end_turn', text: '' }],
        expected_audible_outputs: [
          {
            output_id: 'out_1',
            kind: 'field_null_fallback',
            count: 1,
            match: { text_exact: "Sorry, I didn't catch that.", dedupe_token: 'sym_token_1' },
          },
        ],
      },
    ],
  };
}

function validManifest(corpusId) {
  return {
    manifest_version: 1,
    corpus_id: corpusId,
    commitment_key_hex: '11'.repeat(32),
    expected_session_id: 'sym_session_1',
    sources: [
      {
        type: 'cloudwatch',
        role: 'primary',
        path: '/private/archive/cw.jsonl',
        fingerprint: 'ab'.repeat(32),
        freshness: { status: 'fresh', reason: null },
        extraction_coverage: 'parsed',
        source_priority: 0,
      },
    ],
    chime_correlations: [{ chime_ts: 1, transcript_ts: 2, method: 'interval', branch: 'confirmation' }],
    chime_correlation_failures: [],
    raw_id_map: { 'sess_realid_123x': 'sym_session_1' },
    privacy_review: { signed_off: true, reviewer: 'Derek Beckley', at: '2026-01-10T00:00:00Z' },
    created_at: '2026-01-10T00:00:00Z',
  };
}

const CID = 'frc_0123456789abcdef0123456789abcdef';

describe('accept-core (stage 2)', () => {
  const acceptedAtIso = '2026-01-11T09:00:00.000Z';

  test('a clean draft accepts: expiry stamped from accepted_at, attestation carries the immutable hash + keyed commitments', async () => {
    const draftDoc = validDraft(CID);
    const r = await acceptFixture({
      draftDoc,
      draftRawBytes: Buffer.from(JSON.stringify(draftDoc)),
      manifest: validManifest(CID),
      acceptedAtIso,
      reviewer: 'Derek Beckley',
      draftPath: '.field-replay-drafts/x.draft.yaml',
      isInsideCorpusRootFn: isInsideCorpusRoot,
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.fixture.expires_at).toBe(computeExpiresAt(acceptedAtIso));
    expect(Date.parse(r.fixture.expires_at) - Date.parse(acceptedAtIso)).toBe(
      EXPIRY_POLICY.initialDays * 24 * 60 * 60 * 1000,
    );
    expect(r.attestation.immutable_payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.attestation.accepted_at).toBe(acceptedAtIso);
    expect(r.attestation.sources[0].commitment).toMatch(/^[0-9a-f]{64}$/);
    // The manifest's raw source fingerprint must not appear anywhere public.
    expect(JSON.stringify(r.fixture) + JSON.stringify(r.attestation)).not.toContain('ab'.repeat(32));
  });

  test('missing privacy sign-off, stale source, or manifest mismatch fail closed', async () => {
    const draftDoc = validDraft(CID);
    const noSignoff = validManifest(CID);
    noSignoff.privacy_review.signed_off = false;
    const r1 = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from('{}'), manifest: noSignoff, acceptedAtIso, reviewer: 'D' });
    expect(r1.ok).toBe(false);
    expect(r1.errors.some((e) => e.code === 'privacy_review_missing')).toBe(true);

    const stale = validManifest(CID);
    stale.sources[0].freshness = { status: 'stale', reason: 'stale upload' };
    const r2 = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from('{}'), manifest: stale, acceptedAtIso, reviewer: 'D' });
    expect(r2.errors.some((e) => e.code === 'source_stale')).toBe(true);

    const wrongId = validManifest('frc_ffffffffffffffffffffffffffffffff');
    const r3 = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from('{}'), manifest: wrongId, acceptedAtIso, reviewer: 'D' });
    expect(r3.errors.some((e) => e.code === 'manifest_mismatch')).toBe(true);

    const r4 = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from('{}'), manifest: null, acceptedAtIso, reviewer: 'D' });
    expect(r4.errors.some((e) => e.code === 'manifest_missing')).toBe(true);
  });

  test('a surviving manifest-listed raw fragment in the draft bytes rejects', async () => {
    const draftDoc = validDraft(CID);
    const bytes = Buffer.from(JSON.stringify(draftDoc) + '\n# leftover: sess_realid_123x\n');
    const r = await acceptFixture({ draftDoc, draftRawBytes: bytes, manifest: validManifest(CID), acceptedAtIso, reviewer: 'D' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code.startsWith('pii_'))).toBe(true);
  });

  test('unrecognized chime_observed provenance rejects (more chime turns than recognized correlations)', async () => {
    const draftDoc = validDraft(CID);
    const manifest = validManifest(CID);
    manifest.chime_correlations = [];
    const r = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from(JSON.stringify(draftDoc)), manifest, acceptedAtIso, reviewer: 'D' });
    expect(r.errors.some((e) => e.code === 'chime_provenance_unrecognized')).toBe(true);
  });

  test('a human-selected chime mapping in the manifest satisfies provenance', async () => {
    const draftDoc = validDraft(CID);
    const manifest = validManifest(CID);
    manifest.chime_correlations = [];
    manifest.chime_correlation_failures = [
      { chime_ts: 1, reason: 'ambiguous_candidates', candidate_count: 2, human_selected_transcript_ts: 2 },
    ];
    const r = await acceptFixture({ draftDoc, draftRawBytes: Buffer.from(JSON.stringify(draftDoc)), manifest, acceptedAtIso, reviewer: 'D' });
    expect(r.errors).toEqual([]);
  });

  test('a draft inside the corpus root is rejected', async () => {
    const draftDoc = validDraft(CID);
    const r = await acceptFixture({
      draftDoc,
      draftRawBytes: Buffer.from(JSON.stringify(draftDoc)),
      manifest: validManifest(CID),
      acceptedAtIso,
      reviewer: 'D',
      draftPath: `${CORPUS_ROOT}/${CID}/fixture.yaml`,
      isInsideCorpusRootFn: isInsideCorpusRoot,
    });
    expect(r.errors.some((e) => e.code === 'draft_inside_corpus_root')).toBe(true);
  });
});

describe('validate-committed (stage 3 — CI, no manifest)', () => {
  async function acceptedPair() {
    const draftDoc = validDraft(CID);
    const r = await acceptFixture({
      draftDoc,
      draftRawBytes: Buffer.from(JSON.stringify(draftDoc)),
      manifest: validManifest(CID),
      acceptedAtIso: '2026-01-11T09:00:00.000Z',
      reviewer: 'Derek Beckley',
    });
    return r;
  }

  test('an accepted fixture + attestation validates in CI', async () => {
    const { fixture, attestation } = await acceptedPair();
    const v = await validateCommittedFixture({
      fixtureDoc: fixture,
      fixtureRawBytes: Buffer.from(JSON.stringify(fixture)),
      attestation,
    });
    expect(v.errors).toEqual([]);
  });

  test('missing attestation rejects', async () => {
    const { fixture } = await acceptedPair();
    const v = await validateCommittedFixture({ fixtureDoc: fixture, fixtureRawBytes: Buffer.from('{}'), attestation: null });
    expect(v.errors.some((e) => e.code === 'attestation_missing')).toBe(true);
  });

  test('a tampered immutable payload is caught by the attestation hash', async () => {
    const { fixture, attestation } = await acceptedPair();
    fixture.turns[0].transcript = 'edited after acceptance';
    const v = await validateCommittedFixture({ fixtureDoc: fixture, fixtureRawBytes: Buffer.from(JSON.stringify(fixture)), attestation });
    expect(v.errors.some((e) => e.code === 'attestation_hash_mismatch')).toBe(true);
  });

  test('history-anchored: the GREEN flip is legal; a payload change or reverse flip is not', async () => {
    const { fixture, attestation } = await acceptedPair();
    const green = JSON.parse(JSON.stringify(fixture));
    green.gate_state = 'required_green';
    delete green.expected_failure_id;
    const ok = await validateCommittedFixture({
      fixtureDoc: green,
      fixtureRawBytes: Buffer.from(JSON.stringify(green)),
      attestation,
      previousVersion: { fixtureDoc: fixture },
    });
    expect(ok.errors).toEqual([]);

    const reversed = await validateCommittedFixture({
      fixtureDoc: fixture,
      fixtureRawBytes: Buffer.from(JSON.stringify(fixture)),
      attestation,
      previousVersion: { fixtureDoc: green },
    });
    expect(reversed.errors.some((e) => e.code === 'illegal_gate_transition')).toBe(true);
  });
});

describe('discovery (Item 2)', () => {
  test('exact-basename discovery: nested dirs execute; drafts/attestations/evidence/unrelated YAML ignored', () => {
    const root = path.join(tmpRoot, 'corpus');
    fs.mkdirSync(path.join(root, 'frc_aa/nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'frc_bb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'frc_aa/fixture.yaml'), 'corpus_id: frc_aa\n');
    fs.writeFileSync(path.join(root, 'frc_aa/nested/fixture.yaml'), 'corpus_id: frc_nested\n');
    fs.writeFileSync(path.join(root, 'frc_aa/attestation.json'), '{}');
    fs.writeFileSync(path.join(root, 'frc_aa/evidence.json'), '{}');
    fs.writeFileSync(path.join(root, 'frc_bb/draft.yaml'), 'x: 1\n');
    fs.writeFileSync(path.join(root, 'frc_bb/notes.yaml'), 'x: 1\n');
    const found = discoverFixtures(root).map((f) => path.relative(root, f.fixturePath));
    expect(found).toEqual(['frc_aa/fixture.yaml', 'frc_aa/nested/fixture.yaml']);
  });

  test('an ignored draft saved as fixture.yaml inside the corpus root WOULD be discovered — the reason the acceptance guard exists', () => {
    const root = path.join(tmpRoot, 'corpus2');
    fs.mkdirSync(path.join(root, 'frc_cc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'frc_cc/fixture.yaml'), 'corpus_id: frc_cc\n');
    // gitignore does not affect FILESYSTEM discovery.
    expect(discoverFixtures(root)).toHaveLength(1);
  });

  test('empty or absent corpus discovers zero (the lane treats this as PASS)', () => {
    expect(discoverFixtures(path.join(tmpRoot, 'missing'))).toEqual([]);
    const empty = path.join(tmpRoot, 'empty');
    fs.mkdirSync(empty);
    expect(discoverFixtures(empty)).toEqual([]);
  });

  test('duplicate corpus ids reject', () => {
    expect(() =>
      assertUniqueCorpusIds([
        { fixturePath: 'a/fixture.yaml', doc: { corpus_id: 'frc_x' } },
        { fixturePath: 'b/fixture.yaml', doc: { corpus_id: 'frc_x' } },
      ]),
    ).toThrow(/duplicate corpus_id/);
  });
});
