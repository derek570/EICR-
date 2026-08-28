'use client';

import * as React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { useRecording } from '@/lib/recording-context';
import { getUser } from '@/lib/auth';
import {
  formatUnresolvedAudioBannerText,
  isUnresolvedAudioVisible,
} from '@/lib/recording/unresolved-audio-record';

/**
 * PLAN-E-TERM (T2) — the post-session unresolved-audio RECORD banner.
 *
 * Renders BENEATH `RecordingProvider` (the job detail layout) because the
 * visibility predicate needs BOTH the JobContext rows AND the recording
 * session's active state: an entry is written during active recovery, so
 * a still-active session's rows must stay hidden (a recoverable episode
 * is not a residue yet). Shown only when the row is unresolved (no
 * tombstone), belongs to the signed-in user + this job, and its session
 * is no longer active. Cause-neutral, uncertainty-preserving wording —
 * never spoken. Dismissal writes `resolved_via: dismissed`.
 *
 * iOS canon: `JobDetailView` banner above the tab content.
 */
export function UnresolvedAudioBanner() {
  const { unresolvedAudio, dismissUnresolvedAudio } = useJobContext();
  const { state, getClientSessionId, job } = useRecordingWithJob();
  const userId = React.useMemo(() => getUser()?.id ?? null, []);

  const visible = React.useMemo(() => {
    const activeSessionIds = new Set<string>();
    if (state !== 'idle') {
      const id = getClientSessionId();
      if (id) activeSessionIds.add(id);
    }
    return unresolvedAudio.filter((r) =>
      isUnresolvedAudioVisible(r, { userId, jobId: job.id, activeSessionIds })
    );
  }, [unresolvedAudio, state, getClientSessionId, userId, job.id]);

  if (visible.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="unresolved-audio-banner"
      className="mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        <AlertTriangle className="h-4 w-4" aria-hidden />
        Unresolved dictation
      </div>
      <ul className="space-y-2">
        {visible.map((record) => (
          <li
            key={record.key}
            className="flex items-start gap-2"
            data-testid="unresolved-audio-row"
          >
            <span className="flex-1">{formatUnresolvedAudioBannerText(record)}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="rounded p-1 hover:bg-amber-200/60 dark:hover:bg-amber-900/60"
              onClick={() => void dismissUnresolvedAudio(record.key)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useRecordingWithJob() {
  const { state, getClientSessionId } = useRecording();
  const { job } = useJobContext();
  return { state, getClientSessionId, job };
}
