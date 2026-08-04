/**
 * Plan 00B §B4/§B6 — expectation projections, lane partition and the
 * published combined manifest. The merge-blocking source check lives here:
 * any drift between the committed manifest and a recomputation from the
 * checked-out sources (fixtures, egress test files, semantic-oracle inputs)
 * fails, so 00C can never consume a stale digest and no one can silently
 * update it — a changed input requires a fresh reviewed 00B successor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderExpectationManifests,
  computeSemanticOracleDigest,
  projectFixtureExpectation,
  loadFixture,
  listCorpusIds,
  VENDOR_LIVE_FIXTURE_IDS,
  DETERMINISTIC_EGRESS_CASES,
  STRATA_NAMED_GAPS,
  EXPECTATION_STATUS,
} from '../../scripts/model-ab/lib/expectation-projection.mjs';
import { judgeSample } from '../../scripts/model-ab/lib/semantic-judge.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, 'scripts', 'model-ab', 'plan00-expectation-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

describe('lane partition (§B6)', () => {
  test('every corpus fixture belongs to EXACTLY one executable lane', () => {
    const corpusIds = listCorpusIds(repoRoot);
    const vendorSet = new Set(VENDOR_LIVE_FIXTURE_IDS);
    // vendor lane covers each corpus fixture exactly once…
    expect([...vendorSet].sort()).toEqual(corpusIds);
    // …and the egress lane is a disjoint named-case inventory (no frc ids).
    for (const c of DETERMINISTIC_EGRESS_CASES) {
      expect(vendorSet.has(c.case_id)).toBe(false);
      expect(c.case_id.startsWith('frc_')).toBe(false);
    }
  });

  test('egress cases each name a real committed covering test file', () => {
    for (const c of DETERMINISTIC_EGRESS_CASES) {
      expect(fs.existsSync(path.join(repoRoot, c.covered_by))).toBe(true);
    }
  });
});

describe('projections (§B4)', () => {
  test('projections carry NO recorded model rounds or tool ids', () => {
    for (const id of VENDOR_LIVE_FIXTURE_IDS) {
      const proj = projectFixtureExpectation(loadFixture(repoRoot, id));
      const json = JSON.stringify(proj);
      expect(json).not.toContain('model_rounds');
      expect(json).not.toContain('tool_call_id');
      expect(json).not.toContain('toolu_');
      expect(proj.status).toBe(EXPECTATION_STATUS);
    }
  });

  test('rendering is deterministic', () => {
    const a = renderExpectationManifests(repoRoot);
    const b = renderExpectationManifests(repoRoot);
    expect(a.combined_sha256).toBe(b.combined_sha256);
  });
});

describe('published combined manifest — merge-blocking drift check (§B6)', () => {
  test('committed hashes match a fresh recomputation from the checkout', () => {
    const m = renderExpectationManifests(repoRoot);
    expect(manifest.vendor_live_expectations.sha256).toBe(m.vendor_live_sha256);
    expect(manifest.deterministic_egress_expectations.sha256).toBe(m.deterministic_egress_sha256);
    expect(manifest.combined_sha256).toBe(m.combined_sha256);
  });

  test('the enumerated semantic_oracle_digest matches the checked-out sources', () => {
    const oracle = computeSemanticOracleDigest(repoRoot);
    expect(manifest.semantic_oracle_digest).toBe(oracle.digest);
    expect(manifest.semantic_oracle_inputs).toEqual(oracle.rows);
    // Repository-relative, complete, deterministic.
    for (const row of oracle.rows) {
      expect(row.path.startsWith('/')).toBe(false);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('status is UNREVIEWED-DRAFT — 00B stores no attestation', () => {
    expect(manifest.status).toBe('UNREVIEWED-DRAFT');
    expect(JSON.stringify(manifest)).not.toContain('expectations_attested');
  });

  test('named strata gaps are dated, non-safety, and recorded for 00C', () => {
    expect(manifest.strata_named_gaps).toEqual(STRATA_NAMED_GAPS);
    for (const gap of manifest.strata_named_gaps) {
      expect(gap.safety_critical).toBe(false);
      expect(gap.dated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('RED: a changed oracle input fails the digest closed', () => {
    const oracle = computeSemanticOracleDigest(repoRoot);
    const tampered = [...oracle.rows];
    tampered[0] = { ...tampered[0], sha256: 'f'.repeat(64) };
    const recomputed = tampered.map((r) => `${r.path}\n${r.sha256}\n`).join('');
    expect(recomputed).not.toBe(oracle.rows.map((r) => `${r.path}\n${r.sha256}\n`).join(''));
  });
});

describe('semantic judge (§B5) — pinned IR contract', () => {
  const pinnedIr = projectFixtureExpectation(
    loadFixture(repoRoot, 'frc_4687948efcd06a3cd9dce203a3aa4ffe')
  );
  const base = { captureInvalid: null, audibleTexts: [] };

  test('plain overwrite satisfies the pinned IR semantic (board wildcard)', () => {
    const res = judgeSample(
      pinnedIr,
      {
        ...base,
        receipts: [
          {
            kind: 'reading',
            field: 'ir_live_live_mohm',
            circuit: 3,
            board_id: 'anything',
            value: '100',
            parent_operation_id: null,
          },
        ],
      },
      { boardWildcard: true }
    );
    expect(res.verdict).toBe('PASS');
  });

  test('explicit clear→write also satisfies it', () => {
    const res = judgeSample(
      pinnedIr,
      {
        ...base,
        receipts: [
          {
            kind: 'clear',
            field: 'ir_live_live_mohm',
            circuit: 3,
            board_id: 'main',
            value: null,
            parent_operation_id: null,
          },
          {
            kind: 'reading',
            field: 'ir_live_live_mohm',
            circuit: 3,
            board_id: 'main',
            value: '100',
            parent_operation_id: null,
          },
        ],
      },
      { boardWildcard: true }
    );
    expect(res.verdict).toBe('PASS');
  });

  test('RED: a wrong value FAILS', () => {
    const res = judgeSample(
      pinnedIr,
      {
        ...base,
        receipts: [
          {
            kind: 'reading',
            field: 'ir_live_live_mohm',
            circuit: 3,
            board_id: 'main',
            value: '10',
            parent_operation_id: null,
          },
        ],
      },
      { boardWildcard: true }
    );
    expect(res.verdict).toBe('FAIL');
    expect(res.reason).toBe('wrong_value');
  });

  test('RED: a missing operation FAILS; recorded rounds can never stand in', () => {
    const res = judgeSample(pinnedIr, { ...base, receipts: [] }, { boardWildcard: true });
    expect(res.verdict).toBe('FAIL');
    expect(res.reason).toBe('operation_missing');
  });

  test('RED: an undeclared EXTRA mutation FAILS', () => {
    const res = judgeSample(
      pinnedIr,
      {
        ...base,
        receipts: [
          {
            kind: 'reading',
            field: 'ir_live_live_mohm',
            circuit: 3,
            board_id: 'main',
            value: '100',
            parent_operation_id: null,
          },
          {
            kind: 'reading',
            field: 'measured_zs_ohm',
            circuit: 7,
            board_id: 'main',
            value: '0.9',
            parent_operation_id: null,
          },
        ],
      },
      { boardWildcard: true }
    );
    expect(res.verdict).toBe('FAIL');
    expect(res.mismatches.some((m) => m.class === 'extra_mutation')).toBe(true);
  });

  test('INVALID capture is HELD — never compared, never pass/fail', () => {
    const res = judgeSample(pinnedIr, {
      ...base,
      receipts: [],
      captureInvalid: { reason: 'non_quiescent_at_stop' },
    });
    expect(res.verdict).toBe('INVALID_HOLD');
    expect(res.reason).toBe('non_quiescent_at_stop');
  });
});

describe('lane runner gate', () => {
  test('the runner refuses live vendor sampling without the 00C attestation record', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'model-ab', 'run-semantic-lane.mjs'),
      'utf8'
    );
    expect(src).toContain("args.mode === 'live' && !args.attestationRecord");
    expect(src).toContain('REFUSED');
  });
});
