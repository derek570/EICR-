/**
 * Plan 00C §C5 — the shared load-and-fold pipeline used by the status
 * command AND the Stage-A test matrix (one pipeline, no test-only fork).
 */

import { EVIDENCE_PREFIX, STAGE_A_COHORT } from './constants.mjs';
import { loadAuditedPrefix } from './store.mjs';
import { validateStoredEvent } from './events.mjs';
import { collectSessionManifests } from './collector.mjs';
import { foldEvidence } from './fold.mjs';

export async function loadCohortState(store, cohortId) {
  const stageA = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/${STAGE_A_COHORT}/`);
  const cohort = cohortId
    ? await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/${cohortId}/`)
    : { records: [], holds: [] };
  const reservations = cohortId
    ? await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/reservations/${cohortId}/`)
    : { records: [], holds: [] };
  const reports = cohortId
    ? await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/reports/${cohortId}/`)
    : { records: [], holds: [] };
  return {
    stageARecords: stageA.records,
    cohortRecords: cohort.records,
    reservationRecords: reservations.records,
    reportRecords: reports.records,
    integrityHolds: [...stageA.holds, ...cohort.holds, ...reservations.holds, ...reports.holds],
  };
}

export function latestValid(records, kind) {
  const valid = records.filter(
    (r) =>
      r.payload?.kind === kind &&
      validateStoredEvent({ key: r.key, payload: r.payload }).length === 0
  );
  return (
    valid.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)).at(-1) ?? null
  );
}

/** Load everything for one cohort and fold it. Manifest pairs are collected
 *  per production_session_bound event with the FULL operator version audit. */
export async function computeFold(
  store,
  { cohortId, expectationManifest, recomputedOracleDigest, liveDeployment }
) {
  const state = await loadCohortState(store, cohortId);
  const manifestsBySession = new Map();
  for (const rec of state.cohortRecords) {
    if (rec.payload?.kind !== 'production_session_bound') continue;
    const sid = rec.payload.field_session_id;
    const fp = rec.payload.deployment_fingerprint;
    if (!sid || !fp || manifestsBySession.has(sid)) continue;
    manifestsBySession.set(
      sid,
      await collectSessionManifests(store, { deploymentFingerprint: fp, sessionId: sid })
    );
  }
  return foldEvidence({
    ...state,
    cohortId,
    manifestsBySession,
    expectationManifest,
    recomputedOracleDigest,
    liveDeployment,
  });
}
