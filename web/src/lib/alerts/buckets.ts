import type { Job } from '@/lib/types';

/**
 * Alert-bucket classifier (Phase 3).
 *
 * Mirrors iOS `AlertsView.swift:L74-L84`:
 *   - `needsAttention` — jobs with `status === 'failed'`.
 *   - `inProgress`     — `status === 'pending' | 'processing'`.
 *   - `recentlyCompleted` — `status === 'done'`, most-recent 10.
 *
 * Sort order inside each bucket:
 *   - Most-recently-updated first. iOS sort lives in its view model
 *     (JobListViewModel sorts before passing to the view), so we
 *     centralise the logic here to match.
 *
 * The "Recently Completed" cap at 10 matches iOS and keeps the
 * Alerts page short — the full Done list is the dashboard's job.
 *
 * Note on scope deliberation:
 *   The ledger sketched a richer taxonomy:
 *     - Needs Attention: "no inspection date, OR overdue, OR
 *       unresolved C1 observations"
 *     - In Progress: "has inspection date, but missing required
 *       fields" (via computeWarnings).
 *   Both of those require the full `JobDetail` per job (inspection
 *   dates + observations + computeWarnings all live under the detail
 *   payload, not the list). Loading N detail docs to compute alerts
 *   doesn't scale — iOS itself filters on `.status` only. We match
 *   iOS and leave the richer classification to a future backend
 *   field (see parity-ledger notes — backend flag).
 */

export interface AlertBuckets {
  needsAttention: Job[];
  inProgress: Job[];
  recentlyCompleted: Job[];
}

function compareUpdatedDesc(a: Job, b: Job): number {
  const ta = Date.parse(a.updated_at ?? a.created_at);
  const tb = Date.parse(b.updated_at ?? b.created_at);
  return tb - ta;
}

export function bucketJobs(jobs: Job[]): AlertBuckets {
  const needsAttention: Job[] = [];
  const inProgress: Job[] = [];
  const recentlyCompleted: Job[] = [];

  for (const j of jobs) {
    switch (j.status) {
      case 'failed':
        needsAttention.push(j);
        break;
      case 'pending':
      case 'processing':
        inProgress.push(j);
        break;
      case 'done':
        recentlyCompleted.push(j);
        break;
    }
  }

  needsAttention.sort(compareUpdatedDesc);
  inProgress.sort(compareUpdatedDesc);
  recentlyCompleted.sort(compareUpdatedDesc);

  // Cap recently-completed to match iOS `Array(... .prefix(10))`.
  return {
    needsAttention,
    inProgress,
    recentlyCompleted: recentlyCompleted.slice(0, 10),
  };
}
