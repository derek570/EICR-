#!/usr/bin/env node
/**
 * subject-projection.mjs — the machine check behind the "test-infra-only"
 * claim (plan Item 4). Compares the PRODUCTION-EXECUTABLE projection of the
 * tree at HEAD (or --head=<ref>) against the pinned subject SHA and FAILS
 * on any addition/deletion/rename/content change:
 *
 *   - runtime `src/**` EXCLUDING `src/__tests__/**` (Foundation necessarily
 *     edits test helpers there);
 *   - runtime `config/` EXCLUDING the enumerated Foundation/bootstrap-added
 *     non-runtime manifests (each proven not runtime-loaded and classified
 *     a protected harness/governance input);
 *   - prompts (`config/prompts/**` is inside config/ and NOT excluded);
 *   - ECS task definitions (`ecs/**`);
 *   - backend Docker inputs (`docker/**`, `Dockerfile*`);
 *   - production dependencies — compared as the PRODUCTION-REACHABLE
 *     RESOLVED GRAPH of package-lock.json (the manifests are exempt as
 *     harness/dependency inputs, so byte comparison is undefined, and a
 *     full-lockfile comparison would fail on every legitimate
 *     dev-dependency add): the `packages` subgraph reachable from non-dev
 *     root dependencies, failing on any added/removed/version-changed/
 *     integrity-changed entry (docker/backend.Dockerfile installs
 *     production dependencies FROM these files via npm ci
 *     --only=production, so adding a devDep like Ajv could otherwise
 *     rewrite production resolution while the plan claims the baseline is
 *     under test).
 *
 * Usage:
 *   node scripts/field-replay/subject-projection.mjs --subject=<sha> [--head=<ref>]
 * Exit 0 = projection identical (production tree == subject); 1 = differs.
 */

import { execFileSync } from 'node:child_process';

/** Foundation/bootstrap-added non-runtime manifests — EVERY exclusion is a
 *  protected harness/governance input; a regression test proves each is not
 *  loaded by any runtime module. */
export const FOUNDATION_CONFIG_EXCLUSIONS = Object.freeze([
  'config/field-replay-maintainers.json',
  'config/field-replay-budget.json',
  'config/field-replay-ruleset-activated.json',
  'config/field-replay-runtime.json',
  'config/field-replay-harness-manifest.json',
]);

/** True when a repo path is part of the production-executable projection. */
export function isSubjectPath(p) {
  if (p.startsWith('src/')) {
    return !p.startsWith('src/__tests__/');
  }
  if (p.startsWith('config/')) {
    return !FOUNDATION_CONFIG_EXCLUSIONS.includes(p);
  }
  if (p.startsWith('ecs/')) return true;
  if (p.startsWith('docker/')) return true;
  if (/^Dockerfile/.test(p)) return true;
  return false;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** { path → blobSha } for the subject projection at a ref. */
export function projectionAt(ref, gitDir = process.cwd()) {
  const out = git(['ls-tree', '-r', ref], { cwd: gitDir });
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    // "<mode> blob <sha>\t<path>"
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) continue;
    const [, sha, p] = m;
    if (isSubjectPath(p)) map.set(p, sha);
  }
  return map;
}

/** Diff two projections → list of {path, kind}. */
export function diffProjections(subject, head) {
  const diffs = [];
  for (const [p, sha] of subject) {
    if (!head.has(p)) diffs.push({ path: p, kind: 'deleted' });
    else if (head.get(p) !== sha) diffs.push({ path: p, kind: 'modified' });
  }
  for (const p of head.keys()) {
    if (!subject.has(p)) diffs.push({ path: p, kind: 'added' });
  }
  return diffs;
}

/**
 * The PRODUCTION-REACHABLE resolved graph of a package-lock.json (v2/v3
 * `packages` format): entries reachable from the non-dev root dependencies
 * via node resolution over the lockfile keys, following dependencies,
 * optionalDependencies, and resolved peerDependencies.
 * Returns Map<node_modules path, {version, integrity}>.
 */
export function productionReachableGraph(lock) {
  const packages = lock.packages ?? {};
  const root = packages[''] ?? {};
  const rootDeps = Object.keys({
    ...(root.dependencies ?? {}),
    ...(root.optionalDependencies ?? {}),
  });

  const resolve = (fromPath, name) => {
    // Node resolution over lockfile keys: fromPath/node_modules/name, then
    // ancestors', then top-level node_modules/name.
    let base = fromPath;
    for (;;) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (base === '') return null;
      const idx = base.lastIndexOf('/node_modules/');
      base = idx === -1 ? '' : base.slice(0, idx);
    }
  };

  const reachable = new Map();
  const queue = rootDeps.map((n) => ({ from: '', name: n }));
  while (queue.length > 0) {
    const { from, name } = queue.shift();
    const key = resolve(from, name);
    if (!key || reachable.has(key)) continue;
    const entry = packages[key];
    reachable.set(key, { version: entry.version ?? null, integrity: entry.integrity ?? null });
    const next = Object.keys({
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      ...(entry.peerDependencies ?? {}),
    });
    for (const dep of next) queue.push({ from: key, name: dep });
  }
  return reachable;
}

/** Diff two production graphs → list of {key, kind, detail}. */
export function diffProductionGraphs(subjectGraph, headGraph) {
  const diffs = [];
  for (const [key, v] of subjectGraph) {
    const h = headGraph.get(key);
    if (!h) diffs.push({ key, kind: 'removed' });
    else if (h.version !== v.version) diffs.push({ key, kind: 'version_changed', detail: `${v.version} → ${h.version}` });
    else if (h.integrity !== v.integrity) diffs.push({ key, kind: 'integrity_changed' });
  }
  for (const key of headGraph.keys()) {
    if (!subjectGraph.has(key)) diffs.push({ key, kind: 'added' });
  }
  return diffs;
}

export function lockfileAt(ref, gitDir = process.cwd()) {
  return JSON.parse(git(['show', `${ref}:package-lock.json`], { cwd: gitDir }));
}

/** Full comparison. Returns { ok, pathDiffs, depDiffs }. */
export function compareSubjectProjection(subjectSha, headRef = 'HEAD', gitDir = process.cwd()) {
  const pathDiffs = diffProjections(projectionAt(subjectSha, gitDir), projectionAt(headRef, gitDir));
  const depDiffs = diffProductionGraphs(
    productionReachableGraph(lockfileAt(subjectSha, gitDir)),
    productionReachableGraph(lockfileAt(headRef, gitDir)),
  );
  return { ok: pathDiffs.length === 0 && depDiffs.length === 0, pathDiffs, depDiffs };
}

// --- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, '').split('=');
      return [k, rest.join('=')];
    }),
  );
  if (!args.subject) {
    console.error('Usage: --subject=<sha> [--head=<ref>]');
    process.exit(2);
  }
  const { ok, pathDiffs, depDiffs } = compareSubjectProjection(args.subject, args.head ?? 'HEAD');
  if (ok) {
    console.log(`subject projection IDENTICAL: production tree at ${args.head ?? 'HEAD'} == ${args.subject}`);
    process.exit(0);
  }
  console.error('subject projection DIFFERS — the baseline-equivalence claim is invalid:');
  for (const d of pathDiffs) console.error(`  [path ${d.kind}] ${d.path}`);
  for (const d of depDiffs) console.error(`  [prod-dep ${d.kind}] ${d.key}${d.detail ? ` (${d.detail})` : ''}`);
  process.exit(1);
}
