'use client';

import * as React from 'react';
import Link from 'next/link';
import { ImageDown, RotateCw } from 'lucide-react';
import {
  getPendingCcuExtractions,
  submitCcuCapture,
  subscribePendingCcuChanges,
  type CcuSubmitResult,
  type PendingCcuExtraction,
} from '@/lib/ccu/pending-extraction-queue';

/**
 * Pending Extractions banner — web port of the iOS CircuitsTab
 * "Pending Extractions Banner" block (`CircuitsTab.swift:333-400`) +
 * the JobDetailView connectivity auto-retry (`JobDetailView.swift:817`).
 *
 * Self-contained by design (WS6 concurrency rule): the circuits page
 * contributes ONE insertion line; everything else (queue reads, change
 * subscription, thumbnails, retry buttons, auto-retry on `online`)
 * lives here. The page owns what happens to a successful analysis via
 * `onResult` — apply-to-job and match-review navigation need page
 * state (job context, router, board selection), which the banner
 * deliberately doesn't know about.
 *
 * iOS canon mirrored:
 *   - orange banner, "N PHOTO(S) PENDING EXTRACTION" uppercase header;
 *   - "Retry All" button when >1 entries (hidden while busy);
 *   - one row per entry: 44×44 thumbnail, mode, relative timestamp,
 *     byte size, per-row Retry button / spinner;
 *   - auto-retry every queued entry when connectivity returns
 *     (sequential, stops if another extraction starts).
 */

export function PendingCcuBanner({
  jobId,
  busy = false,
  onResult,
}: {
  jobId: string;
  /** True while the page runs a fresh (non-queued) extraction — retry
   *  buttons disable, matching iOS's `extractionVM.isAnalyzing` gate. */
  busy?: boolean;
  onResult: (entry: PendingCcuExtraction, result: CcuSubmitResult) => void;
}) {
  const [entries, setEntries] = React.useState<PendingCcuExtraction[]>([]);
  const [submittingId, setSubmittingId] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    void getPendingCcuExtractions(jobId).then(setEntries);
  }, [jobId]);

  React.useEffect(() => {
    refresh();
    return subscribePendingCcuChanges(refresh);
  }, [refresh]);

  // Latest-value refs so the `online` listener and sequential retry
  // loop read fresh state without re-subscribing per render.
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  const busyRef = React.useRef(busy || submittingId != null);
  busyRef.current = busy || submittingId != null;
  const onResultRef = React.useRef(onResult);
  onResultRef.current = onResult;

  const retryOne = React.useCallback(async (entry: PendingCcuExtraction) => {
    setSubmittingId(entry.id);
    try {
      const result = await submitCcuCapture(entry);
      onResultRef.current(entry, result);
    } finally {
      setSubmittingId(null);
    }
  }, []);

  const retryAll = React.useCallback(async () => {
    // Sequential like iOS `retryAllPending` — one in-flight upload at
    // a time; a fresh page-level extraction aborts the sweep.
    for (const entry of entriesRef.current) {
      if (busyRef.current) break;
      await retryOne(entry);
    }
  }, [retryOne]);

  // Auto-retry on connectivity restore (iOS: NetworkMonitor onChange at
  // JobDetailView level). `online` fires on the window when the browser
  // regains a network path.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      if (entriesRef.current.length > 0 && !busyRef.current) {
        void retryAll();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [retryAll]);

  if (entries.length === 0) return null;

  const disabled = busy || submittingId != null;

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-status-processing,#ff9f0a)]/40 bg-[var(--color-status-processing,#ff9f0a)]/10 p-3"
      role="status"
      aria-label="Pending CCU extractions"
    >
      <div className="flex items-center gap-2">
        <ImageDown
          className="h-4 w-4 flex-shrink-0 text-[var(--color-status-processing,#ff9f0a)]"
          aria-hidden
        />
        <span className="flex-1 text-[11px] font-bold uppercase tracking-[0.05em] text-[var(--color-status-processing,#ff9f0a)]">
          {entries.length} photo{entries.length === 1 ? '' : 's'} pending extraction
        </span>
        {entries.length > 1 && !disabled ? (
          <button
            type="button"
            onClick={() => void retryAll()}
            className="rounded-full border border-[var(--color-status-processing,#ff9f0a)]/50 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-status-processing,#ff9f0a)] transition hover:bg-[var(--color-status-processing,#ff9f0a)]/15"
          >
            Retry All
          </button>
        ) : null}
      </div>

      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <PendingRow
            key={entry.id}
            entry={entry}
            submitting={submittingId === entry.id}
            disabled={disabled}
            onRetry={() => void retryOne(entry)}
          />
        ))}
      </ul>
    </div>
  );
}

function PendingRow({
  entry,
  submitting,
  disabled,
  onRetry,
}: {
  entry: PendingCcuExtraction;
  submitting: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  // Object URL for the 44×44 thumbnail — revoked on unmount/entry swap
  // so a long banner session doesn't leak Blob URLs.
  const [thumbUrl, setThumbUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let url: string | null = null;
    try {
      url = URL.createObjectURL(entry.photo);
      setThumbUrl(url);
    } catch {
      setThumbUrl(null);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry.photo]);

  return (
    <li className="flex items-center gap-3">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Blob URL; next/image can't optimise it
        <img
          src={thumbUrl}
          alt=""
          className="h-11 w-11 flex-shrink-0 rounded-[6px] object-cover"
          aria-hidden
        />
      ) : (
        <span
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[6px] bg-[var(--color-surface-3)]"
          aria-hidden
        >
          <ImageDown className="h-4 w-4 text-[var(--color-text-tertiary)]" aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
          {modeLabel(entry.mode)}
        </span>
        <span className="text-[11px] text-[var(--color-text-secondary)]">
          {relativeTime(entry.timestamp)} · {formatBytes(entry.photoSizeBytes)}
        </span>
      </span>
      {submitting ? (
        <RotateCw
          className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--color-status-processing,#ff9f0a)]"
          aria-label="Retrying"
        />
      ) : (
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-[var(--color-status-processing,#ff9f0a)]/50 px-3 text-[12px] font-semibold text-[var(--color-status-processing,#ff9f0a)] transition hover:bg-[var(--color-status-processing,#ff9f0a)]/15 disabled:opacity-50"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      )}
    </li>
  );
}

/**
 * Per-job "photos waiting to upload" pill — web port of the iOS
 * Overview banner (`JobDetailView.swift:1174-1190`: photo icon +
 * "N photo(s) waiting to upload" + "Tap to view" → jumps to Circuits).
 */
export function PendingCcuOverviewPill({ jobId }: { jobId: string }) {
  const [count, setCount] = React.useState(0);
  const refresh = React.useCallback(() => {
    void getPendingCcuExtractions(jobId).then((rows) => setCount(rows.length));
  }, [jobId]);
  React.useEffect(() => {
    refresh();
    return subscribePendingCcuChanges(refresh);
  }, [refresh]);

  if (count === 0) return null;
  return (
    <Link
      href={`/job/${jobId}/circuits`}
      className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-status-processing,#ff9f0a)]/40 bg-[var(--color-status-processing,#ff9f0a)]/10 px-3 py-2 text-[12px] font-semibold text-[var(--color-status-processing,#ff9f0a)]"
    >
      <ImageDown className="h-4 w-4" aria-hidden />
      <span className="flex-1">
        {count === 1 ? '1 photo waiting to upload' : `${count} photos waiting to upload`}
      </span>
      <span className="text-[11px] font-medium opacity-80">Tap to view</span>
    </Link>
  );
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'names_only':
      return 'Circuit Names Only';
    case 'hardware_update':
      return 'Update Hardware';
    case 'full_capture':
      return 'Full New Consumer Unit';
    case 'append_rail':
      return 'Add Another Rail';
    case 'add_new_board':
      return 'Add Sub-Board';
    case 'add_off_peak_board':
      return 'Add Off-Peak Board';
    default:
      return mode;
  }
}

function relativeTime(epochMs: number): string {
  const deltaS = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaS < 60) return 'just now';
  const mins = Math.round(deltaS / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
