/**
 * Job-creation defaults flow — web port of iOS
 * `JobListViewModel.autoApplyDefaults` (JobListViewModel.swift:200-234)
 * + the DashboardView PresetPicker sheet handlers.
 *
 * iOS contract (WS6 item 6, ledger row
 * `dashboard/job-creation-defaults-flow`):
 *   - 0 presets for the certificate type → apply STANDARD defaults
 *     (`applyStandardDefaults`), persist, navigate;
 *   - exactly 1 preset → auto-apply it, persist, navigate;
 *   - 2+ presets → present the picker; picking applies + persists +
 *     navigates; Skip navigates with the job untouched.
 *
 * Ordering is load-bearing (parent plan): `api.createJob` returns ONLY
 * `{id}`, so the flow FETCHES the created JobDetail first, applies the
 * patch to that object, PERSISTS (durable `queueSaveJob` — also warms
 * the IDB cache with the merged doc so the job page's cache-first
 * paint shows the defaults instantly), and only then navigates.
 *
 * Storage stays the existing settings blob (`loadPresets` /
 * `applyPresetToJob` from ./service) — zero backend change.
 *
 * Dependencies are injectable so the decision ladder is unit-testable
 * without module mocks; production callers use the defaults.
 */

import { api } from '../api-client';
import type { JobDetail } from '../types';
import { queueSaveJob } from '../pwa/queue-save-job';
import { putCachedJob } from '../pwa/job-cache';
import { applyPresetToJob, loadPresets } from './service';
import { applyStandardDefaultsToJob } from './standard-defaults';
import type { CertificateDefaultPreset } from './types';

export interface JobCreationDeps {
  fetchJob: (userId: string, jobId: string) => Promise<JobDetail>;
  loadPresets: (userId: string, certificateType: string) => Promise<CertificateDefaultPreset[]>;
  persist: (
    userId: string,
    jobId: string,
    patch: Partial<JobDetail>,
    merged: JobDetail
  ) => Promise<void>;
  cacheUntouched: (userId: string, jobId: string, detail: JobDetail) => Promise<void>;
}

const defaultDeps: JobCreationDeps = {
  fetchJob: (userId, jobId) => api.job(userId, jobId),
  loadPresets: (userId, certificateType) => loadPresets(userId, certificateType),
  persist: async (userId, jobId, patch, merged) => {
    await queueSaveJob(userId, jobId, patch, { optimisticDetail: merged });
  },
  cacheUntouched: async (userId, jobId, detail) => {
    await putCachedJob(userId, jobId, detail);
  },
};

export type JobCreationOutcome =
  /** Defaults applied (standard or single preset) and persisted — navigate now. */
  | { kind: 'ready'; applied: 'standard' | 'preset' }
  /** 2+ presets — show the picker; resolve via applyPickedPreset / skipPresetPick. */
  | { kind: 'pick'; detail: JobDetail; presets: CertificateDefaultPreset[] };

/**
 * Run the post-create defaults ladder for a freshly-created job.
 * Call AFTER `api.createJob` and BEFORE navigating to the job page.
 */
export async function prepareCreatedJob(
  userId: string,
  jobId: string,
  certificateType: 'EICR' | 'EIC',
  deps: JobCreationDeps = defaultDeps
): Promise<JobCreationOutcome> {
  // Fetch FIRST — createJob returns only {id}; the patch must be
  // computed against the real created doc (server seeds fields like
  // certificate_type / created_at that only-fill-empty must respect).
  const detail = await deps.fetchJob(userId, jobId);
  const presets = await deps.loadPresets(userId, certificateType);

  if (presets.length === 0) {
    const patch = applyStandardDefaultsToJob(detail);
    await deps.persist(userId, jobId, patch, { ...detail, ...patch });
    return { kind: 'ready', applied: 'standard' };
  }
  if (presets.length === 1) {
    const patch = applyPresetToJob(presets[0], detail);
    await deps.persist(userId, jobId, patch, { ...detail, ...patch });
    return { kind: 'ready', applied: 'preset' };
  }
  return { kind: 'pick', detail, presets };
}

/** Picker resolution — apply the chosen preset, persist, then the
 *  caller navigates. */
export async function applyPickedPreset(
  userId: string,
  detail: JobDetail,
  preset: CertificateDefaultPreset,
  deps: JobCreationDeps = defaultDeps
): Promise<void> {
  const patch = applyPresetToJob(preset, detail);
  await deps.persist(userId, detail.id, patch, { ...detail, ...patch });
}

/** Skip — the untouched created job is already persisted server-side;
 *  warm the cache with it so the job page's cache-first paint is
 *  correct, then the caller navigates. */
export async function skipPresetPick(
  userId: string,
  detail: JobDetail,
  deps: JobCreationDeps = defaultDeps
): Promise<void> {
  await deps.cacheUntouched(userId, detail.id, detail);
}
