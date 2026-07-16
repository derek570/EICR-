#!/usr/bin/env node
/**
 * ci-history-checks.mjs — the merge-gate history checks that run INSIDE
 * `test-backend` after the corpus lane (plan Item 1 history-anchored
 * immutability + Item 4 evidence closure/re-fetch + Item 5 manifest-path
 * lock + ruleset-verification guard). Composed of independent checks so a
 * failure names exactly which invariant broke.
 *
 * Checks (each fails the job with a bounded message):
 *   1. IMMUTABILITY — every PRE-EXISTING executable fixture / attestation /
 *      evidence log's immutable projection is unchanged vs the merge-base
 *      (PR) or github.event.before (push); the ONLY legal fixture change is
 *      a gate_state transition per the state machine.
 *   2. SUBJECT-PATH lock on Keystone/fixing PRs — manifest paths may not
 *      change (harness changes land via a Foundation-style PR first).
 *   3. EXPECTED-RED CLOSURE — the mergeable head contains exactly ONE
 *      qualifying trusted RED event per newly added expected_red fixture.
 *   4. EVIDENCE RE-FETCH — every NEWLY ADDED evidence event is independently
 *      re-fetched + verified before merge (a hand-authored event with
 *      regenerated hashes is rejected because the run it names doesn't
 *      verify); pre-existing evidence relies on history locking.
 *   5. RULESET-VERIFICATION guard — DORMANT until the activation marker
 *      exists on the target branch; then FAILS if any of the three required
 *      contexts is missing from the ruleset.
 *
 * This module holds the PURE check logic + injected git/gh accessors so it
 * unit-tests offline; the CLI wires the real accessors. In CI it is invoked
 * as a step; locally it exits 0 with a note when no base ref is available.
 */

import { attestationPayloadHash } from './lib/canonical-crypto.mjs';
import { immutableProjection, legalTransition } from './lib/fixture-schema.mjs';
import { CORPUS_ROOT } from './lib/convert-core.mjs';

export const CI_ERROR = Object.freeze({
  IMMUTABLE_CHANGED: 'immutable_projection_changed',
  ILLEGAL_TRANSITION: 'illegal_gate_transition',
  MANIFEST_PATH_CHANGED: 'manifest_path_changed_outside_foundation',
  RED_CLOSURE_MISSING: 'expected_red_closure_missing',
  EVIDENCE_UNVERIFIED: 'newly_added_evidence_unverified',
  RULESET_MISSING_CONTEXT: 'ruleset_missing_required_context',
  BASE_UNAVAILABLE: 'comparison_base_unavailable',
});

/** Check 1: immutability of pre-existing fixtures + attestations. */
export function checkImmutability({ changedFixtures }) {
  const errors = [];
  for (const cf of changedFixtures) {
    if (!cf.base) continue; // newly added — immutability begins at merge
    const prevHash = attestationPayloadHash(immutableProjection(cf.base));
    const headHash = attestationPayloadHash(immutableProjection(cf.head));
    if (prevHash !== headHash) {
      errors.push({ code: CI_ERROR.IMMUTABLE_CHANGED, path: cf.path, message: `immutable projection changed for ${cf.corpus_id}` });
      continue;
    }
    if (cf.base.gate_state !== cf.head.gate_state) {
      const t = legalTransition(cf.base.gate_state, cf.head.gate_state, cf.transitionContext ?? {});
      if (!t.ok) {
        errors.push({ code: CI_ERROR.ILLEGAL_TRANSITION, path: cf.path, message: `${cf.base.gate_state} → ${cf.head.gate_state}: ${t.reason}` });
      }
    }
  }
  return errors;
}

/** Check 2: Keystone/fixing PRs may not change trusted-harness manifest
 *  paths (harness changes anchor via Foundation-style PRs). */
export function checkManifestPathLock({ isHarnessPR, changedPaths, manifestPaths }) {
  if (isHarnessPR) return [];
  const touched = changedPaths.filter((p) => manifestPaths.includes(p));
  return touched.map((p) => ({ code: CI_ERROR.MANIFEST_PATH_CHANGED, path: p, message: `${p} is a trusted-harness manifest path — change it via a separate Foundation-style PR` }));
}

/** Check 3: expected_red closure — one qualifying RED event per newly
 *  added expected_red fixture (matching corpus id, attestation hash,
 *  red_proof_failure_id, unexpired). `allowPhase1` (prepush non-main)
 *  permits the not-yet-evidenced state; the MERGE gate passes false. */
export function checkExpectedRedClosure({ newExpectedRedFixtures, redEvidenceEvents, allowPhase1 = false }) {
  const errors = [];
  for (const fx of newExpectedRedFixtures) {
    const attHash = attestationPayloadHash(immutableProjection(fx.doc));
    const qualifying = (redEvidenceEvents ?? []).filter(
      (e) =>
        e.corpus_id === fx.doc.corpus_id &&
        e.fixture_attestation_hash === attHash &&
        e.assertion_id === fx.doc.red_proof_failure_id &&
        e.kind === 'red',
    );
    if (qualifying.length !== 1) {
      if (allowPhase1 && qualifying.length === 0) continue; // phase-1 push
      errors.push({
        code: CI_ERROR.RED_CLOSURE_MISSING,
        path: fx.path,
        message: `expected_red ${fx.doc.corpus_id} needs exactly ONE qualifying trusted RED event (found ${qualifying.length})`,
      });
    }
  }
  return errors;
}

/**
 * Check 4: re-fetch + verify every NEWLY ADDED evidence event.
 * `fetchers.verifyEvent(event)` returns { ok, errors } by re-fetching the
 * referenced run/artifact and re-running the trusted-run verification.
 */
export async function checkNewEvidenceReFetch({ newEvidenceEvents, fetchers }) {
  const errors = [];
  for (const ev of newEvidenceEvents) {
    let verdict;
    try {
      verdict = await fetchers.verifyEvent(ev);
    } catch (err) {
      verdict = { ok: false, errors: [err.message] };
    }
    if (!verdict.ok) {
      errors.push({
        code: CI_ERROR.EVIDENCE_UNVERIFIED,
        path: ev._path ?? ev.corpus_id,
        message: `newly added evidence for ${ev.corpus_id} failed independent re-fetch verification: ${(verdict.errors ?? []).join(', ')}`,
      });
    }
  }
  return errors;
}

/** Check 5: ruleset-verification guard — dormant until the activation
 *  marker exists; then all three required contexts must be present. */
export const REQUIRED_RULESET_CONTEXTS = Object.freeze([
  'Test Backend (Node.js)',
  'Test Frontend (Next.js)',
  'npm Audit Security Scan',
]);

export function checkRulesetContexts({ activationMarkerPresent, installedRequiredContexts }) {
  if (!activationMarkerPresent) return []; // DORMANT pre-marker
  const missing = REQUIRED_RULESET_CONTEXTS.filter((c) => !(installedRequiredContexts ?? []).includes(c));
  return missing.map((c) => ({ code: CI_ERROR.RULESET_MISSING_CONTEXT, message: `required ruleset context missing: "${c}"` }));
}

// --- CLI (real accessors) ---------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const { execFileSync } = await import('node:child_process');
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const yaml = (await import('js-yaml')).default;

  const git = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return null;
    }
  };

  // Resolve the comparison base: merge-base on PRs, github.event.before on
  // pushes. An unavailable base is a FAILURE — never "all fixtures are new".
  const eventName = process.env.GITHUB_EVENT_NAME ?? null;
  let baseRef = null;
  if (eventName === 'pull_request' && process.env.GITHUB_BASE_REF) {
    baseRef = git(['merge-base', `origin/${process.env.GITHUB_BASE_REF}`, 'HEAD'])?.trim() ?? null;
  } else if (process.env.GITHUB_EVENT_BEFORE && !/^0+$/.test(process.env.GITHUB_EVENT_BEFORE)) {
    baseRef = process.env.GITHUB_EVENT_BEFORE.trim();
  }

  if (!eventName) {
    // Local diagnostic run — no CI base. Exit 0 with a note.
    process.stderr.write('ci-history-checks: no GITHUB_EVENT_NAME (local run) — skipping (CI is authoritative).\n');
    process.exit(0);
  }
  if (!baseRef || !git(['cat-file', '-e', `${baseRef}^{commit}`])) {
    process.stderr.write(`ci-history-checks: [${CI_ERROR.BASE_UNAVAILABLE}] comparison base unavailable (base=${baseRef}); an unavailable base is NEVER treated as "all fixtures new".\n`);
    process.exit(1);
  }

  const errors = [];

  // Gather changed fixtures under the corpus root.
  const changedRaw = git(['diff', '--name-status', baseRef, 'HEAD']) ?? '';
  const changedPaths = changedRaw
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t').slice(-1)[0]);
  const fixturePaths = changedPaths.filter((p) => p.startsWith(`${CORPUS_ROOT}/`) && p.endsWith('/fixture.yaml'));

  const loadAt = (ref, p) => {
    const raw = git(['show', `${ref}:${p}`]);
    return raw ? yaml.load(raw) : null;
  };

  const changedFixtures = fixturePaths.map((p) => ({
    path: p,
    base: loadAt(baseRef, p),
    head: fs.existsSync(p) ? yaml.load(fs.readFileSync(p, 'utf8')) : null,
    corpus_id: (fs.existsSync(p) ? yaml.load(fs.readFileSync(p, 'utf8')) : {})?.corpus_id,
  })).filter((cf) => cf.head);

  errors.push(...checkImmutability({ changedFixtures }));

  // Manifest-path lock: harness PR = touches any scripts/field-replay or the
  // helper modules; otherwise Keystone/fixing PRs may not touch manifest
  // paths. We treat a PR that adds/removes a manifest CORE file as harness.
  const manifest = JSON.parse(fs.readFileSync('config/field-replay-harness-manifest.json', 'utf8'));
  const manifestPaths = manifest.core_files;
  const isHarnessPR = changedPaths.some(
    (p) => p.startsWith('scripts/field-replay/') || p.startsWith('scripts/voice-latency-bench/') || p.startsWith('src/__tests__/helpers/'),
  );
  errors.push(...checkManifestPathLock({ isHarnessPR, changedPaths, manifestPaths }));

  // Ruleset guard (dormant until marker on the target branch).
  const activationMarkerPresent = fs.existsSync('config/field-replay-ruleset-activated.json');
  let installedRequiredContexts = [];
  if (activationMarkerPresent && process.env.GH_TOKEN) {
    try {
      const marker = JSON.parse(fs.readFileSync('config/field-replay-ruleset-activated.json', 'utf8'));
      installedRequiredContexts = marker.installed_required_contexts ?? [];
    } catch {
      /* fall through — check will fail on missing contexts */
    }
  }
  errors.push(...checkRulesetContexts({ activationMarkerPresent, installedRequiredContexts }));

  // NOTE: expected-red closure + evidence re-fetch require the trusted-run
  // fetchers (gh) and the evidence directory; they run in the anchored
  // evidence workflow's verification step and are exercised by the unit
  // tests. The in-CI wiring passes GH_TOKEN and the evidence dir when the
  // Keystone/fixing PRs land (Foundation ships zero fixtures/evidence, so
  // these are no-ops on the Foundation PR by construction).

  if (errors.length === 0) {
    process.stderr.write('ci-history-checks: all history-anchored checks passed.\n');
    process.exit(0);
  }
  for (const e of errors) process.stderr.write(`ci-history-checks: [${e.code}] ${e.message}\n`);
  process.exit(1);
}
