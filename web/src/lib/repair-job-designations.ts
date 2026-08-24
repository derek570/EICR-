import { repairCircuitDesignation } from '@certmate/shared-utils';
import type { JobDetail } from './types';

// PLAN-B2 Codex r1 — the plan requires the session alias map to be
// "populated from load state", but by the time a recording session
// starts the load repair has already replaced the raw values. Each
// repair therefore records its raw→canonical pairs here; the recording
// context seeds its session-scoped alias store from this bounded module
// ledger at session start. Bounded + deduped so a long-lived tab cannot
// grow it unboundedly.
//
// Cycle-9 (F5): this ledger is deliberately MODULE-global rather than
// job-scoped, and the 200-entry cap is deliberately a silent stop.
// Both are safe because every value here is a PURE function of its own
// key — `repairCircuitDesignation(raw)` depends on nothing but `raw`.
// So a cross-job alias hit returns exactly what the rewriter's pure
// repair would have produced anyway, and an entry dropped at the cap
// degrades to that same pure repair. Neither can speak a DIFFERENT
// circuit's designation, which is the hazard job-scoping would exist
// to prevent. (A collision against a model-DERIVED alias with a
// different canonical is caught by the alias store's own uniqueness
// rule, which resolves an ambiguous key to nothing and falls through
// to pure repair.)
//
// What is NOT safe to keep is another inspector's text surviving a
// sign-out on a shared device — the same principle that made
// `purgeDesignationDraftState` necessary — so the ledger is cleared
// there via `clearLoadRepairAliases` below.
const loadRepairAliases: Array<[string, string]> = [];
const seenAliasKeys = new Set<string>();
const LOAD_ALIAS_CAP = 200;

function recordLoadRepairAlias(raw: string, canonical: string): void {
  const key = `${raw}\u0000${canonical}`;
  if (seenAliasKeys.has(key) || loadRepairAliases.length >= LOAD_ALIAS_CAP) return;
  seenAliasKeys.add(key);
  loadRepairAliases.push([raw, canonical]);
}

/** Raw→canonical pairs observed by load-boundary repairs (read-only). */
export function getLoadRepairAliases(): ReadonlyArray<[string, string]> {
  return loadRepairAliases;
}

/**
 * Sign-out reset (cycle-9 F5). `clearAuth` wipes the IDB job cache and
 * outbox so a shared device doesn't carry one inspector's data into the
 * next login; this in-memory ledger of designations they dictated must
 * go with it. It also restores the cap's headroom for the next session.
 */
export function clearLoadRepairAliases(): void {
  loadRepairAliases.length = 0;
  seenAliasKeys.clear();
}

/**
 * PLAN-B2 (B2-4) — pure repair of every circuit designation on a job
 * document. Returns the SAME object when nothing changed (so callers
 * can cheaply detect no-ops and referential guards keep working), or a
 * shallow-copied job with a new circuits array where at least one
 * designation was repaired.
 *
 * Repair semantics (never reject, never blank): a pre-existing dirty
 * job — e.g. the feedback-128 session's "Upstairs lighting circuit" —
 * is stripped to its canonical form; a banned-token-only designation is
 * left unchanged because an empty designation classifies the row as a
 * SPARE on both clients.
 *
 * Persistence is deliberately NOT this helper's business: JobProvider
 * decides whether a repaired snapshot may become a pending patch
 * (hydration-safe rules) — a pure display/PDF repair must never turn
 * into a stale pre-hydration PUT.
 */
export function repairJobCircuitDesignations(job: JobDetail): {
  job: JobDetail;
  changed: boolean;
} {
  const circuits = (job.circuits ?? []) as Array<Record<string, unknown>>;
  if (circuits.length === 0) return { job, changed: false };
  let changed = false;
  const next = circuits.map((row) => {
    const designation = row.circuit_designation;
    if (typeof designation !== 'string' || designation.length === 0) return row;
    const repaired = repairCircuitDesignation(designation);
    if (repaired === designation) return row;
    changed = true;
    if (typeof repaired === 'string') recordLoadRepairAlias(designation, repaired);
    return { ...row, circuit_designation: repaired };
  });
  if (!changed) return { job, changed: false };
  return { job: { ...job, circuits: next } as JobDetail, changed: true };
}
