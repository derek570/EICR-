/**
 * convert-core.mjs — stage 1 of the THREE-stage fixture workflow (plan
 * Item 1 "Concrete workflow"): parse raw sources → sanitized NON-runnable
 * draft + PRIVATE manifest written directly into the restricted archive.
 *
 * The private manifest can never be a CI input (it is never committed; a
 * two-stage design would fail closed on every clean checkout) — hence three
 * stages: convert (private) → accept (against the manifest) → validate
 * (CI, committed artifacts only).
 *
 * Fail-closed rules implemented here:
 *   - source PERMISSION preflight: sources outside a 0700 directory or
 *     broader than 0600 are REJECTED (archiving copies while the originals
 *     stay world-readable defeats the point);
 *   - drafts live OUTSIDE the executable corpus root (gitignore does not
 *     affect FILESYSTEM discovery — an ignored draft named fixture.yaml
 *     inside the corpus root would still be discovered);
 *   - any source computing stale/unlinked FAILS the conversion;
 *   - chime correlation ambiguity is recorded as a conversion failure
 *     requiring a human-selected mapping in the manifest — never guessed.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  generateCommitmentKey,
  mintOpaqueRef,
  rawSha256,
  sourceCommitment,
} from './canonical-crypto.mjs';
import {
  SOURCE_TYPES,
  makeSource,
  normaliseSources,
  correlateChimes,
} from './normalise-session.mjs';
import { computeSourceVerdict, FRESHNESS_STATUS } from './source-freshness.mjs';

/** The executable corpus root (relative to the repo root). */
export const CORPUS_ROOT = 'tests/fixtures/field-replay-corpus';
/** The dedicated draft directory (gitignored AND outside the corpus root). */
export const DRAFT_ROOT = '.field-replay-drafts';

export function isInsideCorpusRoot(p, repoRoot = process.cwd()) {
  const abs = path.resolve(repoRoot, p);
  const corpus = path.resolve(repoRoot, CORPUS_ROOT);
  return abs === corpus || abs.startsWith(corpus + path.sep);
}

/** Permission preflight for one raw source file. */
export function checkSourcePermissions(filePath) {
  const st = fs.statSync(filePath);
  const dirSt = fs.statSync(path.dirname(filePath));
  const fileMode = st.mode & 0o777;
  const dirMode = dirSt.mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    return { ok: false, reason: `source directory ${path.dirname(filePath)} is ${dirMode.toString(8)} — must be 0700` };
  }
  if ((fileMode & 0o177) !== 0) {
    return { ok: false, reason: `source file ${filePath} is ${fileMode.toString(8)} — must be 0600 or tighter` };
  }
  return { ok: true };
}

/** Parse a repeatable --source=<type>:<role>:<path> argument. */
export function parseSourceArg(arg) {
  const m = /^([a-z_]+):(primary|supporting):(.+)$/.exec(arg);
  if (!m) throw new Error(`--source must be <type>:<role>:<path>, got "${arg}"`);
  const [, type, role, p] = m;
  if (!SOURCE_TYPES[type]) throw new Error(`unknown source type "${type}" (known: ${Object.keys(SOURCE_TYPES).join(', ')})`);
  return { type, role, path: p };
}

/**
 * Run the conversion. Returns { corpusId, draft, manifest, failures }.
 * Throws on fail-closed conditions. Writes nothing — the CLI owns IO — so
 * tests can drive it purely.
 */
export function convertSession({ sourceSpecs, expectedSessionId = null, skipPermissionCheck = false }) {
  if (!Array.isArray(sourceSpecs) || sourceSpecs.length === 0) {
    throw new Error('at least one --source is required');
  }
  const sources = [];
  for (const spec of sourceSpecs) {
    if (!skipPermissionCheck) {
      const perm = checkSourcePermissions(spec.path);
      if (!perm.ok) throw new Error(`source permission preflight failed: ${perm.reason}`);
    }
    sources.push(
      makeSource({ type: spec.type, role: spec.role, path: spec.path, bytes: fs.readFileSync(spec.path) }),
    );
  }

  const events = normaliseSources(sources);
  const primaryEvents = events.filter((e) => e.source_priority === 0);
  const window = primaryEvents.length
    ? {
        min: Math.min(...primaryEvents.map((e) => e.timestamp_ms ?? Infinity)),
        max: Math.max(...primaryEvents.map((e) => e.timestamp_ms ?? -Infinity)),
      }
    : null;

  // Freshness verdicts — recomputed from bytes; ANY non-fresh fails closed.
  const verdicts = [];
  for (const source of sources) {
    const own = events.filter((e) => e.source_fingerprint === source.fingerprint);
    const verdict = computeSourceVerdict({
      source,
      events: own,
      expectedSessionId,
      primaryWindow: window,
      primaryEvents,
    });
    verdicts.push({ source, verdict });
    if (verdict.status !== FRESHNESS_STATUS.FRESH) {
      throw new Error(
        `source ${source.path} computes ${verdict.status}: ${verdict.reason} — conversion fails closed (a human override is a separately attested exception)`,
      );
    }
  }

  const { correlations, failures } = correlateChimes(events);
  const corpusId = mintOpaqueRef('corpus');
  const commitmentKey = generateCommitmentKey();

  // sources[] manifest entries (PRIVATE) + committed-fixture source stubs
  // (opaque commitments only — bare raw hashes NEVER enter committed
  // artifacts).
  const manifestSources = verdicts.map(({ source, verdict }) => ({
    type: source.type,
    role: source.role,
    path: source.path,
    fingerprint: source.fingerprint,
    freshness: { status: verdict.status, reason: verdict.reason ?? null },
    extraction_coverage: 'parsed',
    source_priority: source.priority,
  }));
  const committedSources = verdicts.map(({ source }) => ({
    type: source.type,
    role: source.role,
    commitment: sourceCommitment(commitmentKey, {
      content_sha256: source.fingerprint,
      role: source.role,
      type: source.type,
    }),
    source_priority: source.priority,
  }));

  const manifest = {
    manifest_version: 1,
    corpus_id: corpusId,
    commitment_key_hex: commitmentKey.toString('hex'),
    expected_session_id: expectedSessionId,
    sources: manifestSources,
    chime_correlations: correlations.map((c) => ({
      chime_ts: c.chime.timestamp_ms,
      transcript_ts: c.transcript.timestamp_ms,
      method: c.method,
      branch: c.branch ?? null,
    })),
    chime_correlation_failures: failures.map((f) => ({
      chime_ts: f.chime.timestamp_ms,
      reason: f.reason,
      candidate_count: f.candidate_count,
      human_selected_transcript_ts: null, // human mapping goes here
    })),
    raw_id_map: {}, // raw ↔ symbolic mappings, human-populated at reconstruction
    privacy_review: { signed_off: false, reviewer: null, at: null },
    created_at: null, // stamped by the CLI (no Date.now in pure core)
  };

  // Sanitized NON-runnable draft skeleton — the human reconstruction target.
  const draft = {
    schema_version: 1,
    corpus_id: corpusId,
    purpose: 'regression',
    gate_state: 'unsupported_pending',
    owner: 'UNREVIEWED-DRAFT',
    capability_exclusion: 'ingress',
    named_followup: 'UNREVIEWED-DRAFT — replace during human reconstruction',
    sanitized_transcript: [],
    human_expectations: 'UNREVIEWED-DRAFT',
    sources: committedSources,
    turns: [],
  };

  return { corpusId, draft, manifest, correlations, failures, events };
}
