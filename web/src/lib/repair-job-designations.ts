import { repairCircuitDesignation } from '@certmate/shared-utils';
import type { JobDetail } from './types';

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
    return { ...row, circuit_designation: repaired };
  });
  if (!changed) return { job, changed: false };
  return { job: { ...job, circuits: next } as JobDetail, changed: true };
}
