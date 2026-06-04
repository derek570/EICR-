'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { ApiError, type VoiceFeedbackDetail, type VoiceFeedbackStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Pill } from '@/components/ui/pill';
import { SectionCard } from '@/components/ui/section-card';

/**
 * /voice-feedback/[id] — detail view for a single voice-feedback row.
 *
 * PLAN-web-final.md §1.6.5. v1 surface deliberately scoped to the
 * data the backend slice ships:
 *   - issue_text (full inspector-spoken complaint)
 *   - transcript_window (timestamped surrounding lines, JSONB array)
 *   - s3_key (link to the raw JSON payload — fetched authed and
 *     opened as a blob URL because S3 doesn't accept our auth header)
 *   - status (dropdown, PATCH on change)
 *   - review_note (textarea, PATCH on blur)
 *
 * Out of scope for v1 (per plan): TTS prompts said at the moment of
 * feedback, tool calls fired, dialogue-script state. Those signals
 * live in CloudWatch / S3 session-logs and aren't part of the
 * voice_feedback row yet; promoted to a v2 sub-phase pending the
 * backend's optional `feedback_context JSONB` field.
 */
export default function VoiceFeedbackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [detail, setDetail] = React.useState<VoiceFeedbackDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Local editable state. Mirrors `detail` after the GET resolves; the
  // status dropdown writes immediately, the note textarea writes on
  // blur (debounced via a ref to avoid duplicate flushes from focus-
  // change race conditions).
  const [statusDraft, setStatusDraft] = React.useState<VoiceFeedbackStatus>('open');
  const [noteDraft, setNoteDraft] = React.useState<string>('');
  const noteCommittedRef = React.useRef<string>('');
  const [saving, setSaving] = React.useState(false);

  // "Open raw JSON" download — fetch the authed blob on click, open
  // in a new tab via createObjectURL, schedule revoke. We don't keep
  // the URL around because the user navigates away from the tab to
  // view it; one click → one blob → revoked on next tick.
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [openingRaw, setOpeningRaw] = React.useState(false);

  React.useEffect(() => {
    const u = getUser();
    if (!u) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);

    api
      .voiceFeedbackGet(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setStatusDraft(d.status);
        setNoteDraft(d.reviewNote ?? '');
        noteCommittedRef.current = d.reviewNote ?? '';
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
          router.replace('/login');
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load feedback');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, router]);

  async function handleStatusChange(next: VoiceFeedbackStatus) {
    if (!detail) return;
    const prev = statusDraft;
    setStatusDraft(next);
    setSaving(true);
    try {
      const fresh = await api.voiceFeedbackPatch(id, { status: next });
      setDetail(fresh);
      // Re-sync the note in case the backend normalised whitespace.
      setNoteDraft(fresh.reviewNote ?? '');
      noteCommittedRef.current = fresh.reviewNote ?? '';
    } catch (err) {
      setStatusDraft(prev);
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setSaving(false);
    }
  }

  async function handleNoteBlur() {
    if (!detail) return;
    if (noteDraft === noteCommittedRef.current) return;
    const next = noteDraft;
    setSaving(true);
    try {
      const fresh = await api.voiceFeedbackPatch(id, { review_note: next });
      noteCommittedRef.current = next;
      setDetail(fresh);
    } catch (err) {
      // Note's still in the textarea — don't wipe the user's typing.
      // Just surface the error and let them retry (a subsequent blur
      // will re-attempt the same content).
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenRaw() {
    if (openingRaw) return;
    setOpeningRaw(true);
    setRawError(null);
    try {
      const blob = await api.voiceFeedbackFetchRawBlob(id);
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      // Some browsers block window.open without user-gesture context
      // even though this is in a click handler — fall back to a direct
      // navigation rather than dropping the blob on the floor.
      if (!win) window.location.href = url;
      // Schedule revoke after the new tab has had time to load. Setting
      // 60 s rather than next-tick because Firefox revokes too eagerly
      // and the new tab loses access mid-fetch.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      // 404 here usually means the backend hasn't shipped the /raw
      // proxy yet — give a friendlier message than the generic body
      // text since the raw link is a nice-to-have.
      setRawError(
        apiErr?.status === 404
          ? 'Raw JSON is unavailable for this row (backend route not deployed yet).'
          : err instanceof Error
            ? err.message
            : 'Failed to fetch raw payload'
      );
    } finally {
      setOpeningRaw(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <div className="cm-shimmer h-8 w-32 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
        <div className="cm-shimmer h-40 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <BackBar />
        <SectionCard accent="amber">
          <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">
            Feedback not found
          </h2>
          <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">
            This feedback row has been deleted or you don&apos;t have access to it.
          </p>
        </SectionCard>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <BackBar />
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
          >
            {error}
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <BackBar />

      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">Voice feedback</h1>
          <div className="text-[13px] text-[var(--color-text-secondary)]">
            {formatDate(detail.createdAt)}
            {detail.address ? <> · {detail.address}</> : null}
            {detail.jobId ? (
              <>
                {' · '}
                <Link
                  href={`/job/${encodeURIComponent(detail.jobId)}`}
                  className="underline decoration-dotted hover:text-[var(--color-text-primary)]"
                >
                  {detail.jobId}
                </Link>
              </>
            ) : null}
          </div>
        </div>
        <StatusPill status={statusDraft} />
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
        >
          {error}
        </p>
      ) : null}

      <SectionCard accent="blue">
        <div className="flex flex-col gap-2">
          <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">Issue</h2>
          <p className="whitespace-pre-wrap text-[14px] leading-[1.5] text-[var(--color-text-primary)]">
            {detail.issueText || '(no transcript captured)'}
          </p>
        </div>
      </SectionCard>

      <SectionCard accent="blue">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">
              Transcript window
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenRaw}
              disabled={openingRaw}
              data-action="open-raw"
            >
              <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />
              {openingRaw ? 'Loading…' : 'Open raw JSON'}
            </Button>
          </div>
          {rawError ? (
            <p className="text-[12px] text-[var(--color-text-tertiary)]">{rawError}</p>
          ) : null}
          {detail.transcriptWindow.length === 0 ? (
            <p className="text-[13px] text-[var(--color-text-tertiary)]">
              No transcript window captured.
            </p>
          ) : (
            <ol className="flex flex-col gap-1 font-mono text-[12px] leading-[1.5]">
              {detail.transcriptWindow.map((entry, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-[var(--color-text-tertiary)]">
                    [{formatClock(entry.ts)}]
                  </span>
                  <span className="text-[var(--color-text-primary)]">{entry.text}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-[11px] text-[var(--color-text-tertiary)]">S3 key: {detail.s3Key}</p>
        </div>
      </SectionCard>

      <SectionCard accent="blue">
        <div className="flex flex-col gap-3">
          <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">Triage</h2>
          <label className="flex flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
            Status
            <select
              value={statusDraft}
              onChange={(e) => handleStatusChange(e.target.value as VoiceFeedbackStatus)}
              disabled={saving}
              data-action="status-select"
              className="h-11 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-2)] px-3 text-[15px] text-[var(--color-text-primary)]"
            >
              <option value="open">Open</option>
              <option value="reviewed">Reviewed</option>
              <option value="actioned">Actioned</option>
              <option value="wontfix">Won&apos;t fix</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
            Review note
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={handleNoteBlur}
              disabled={saving}
              rows={4}
              placeholder="Notes for triage / fix-tracking / follow-up&hellip;"
              data-action="review-note"
              className="min-h-[96px] rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-2)] p-3 text-[14px] leading-[1.5] text-[var(--color-text-primary)]"
            />
          </label>
        </div>
      </SectionCard>
    </main>
  );
}

// -----------------------------------------------------------------------

function BackBar() {
  return (
    <div className="flex items-center gap-2">
      <IconButton asChild aria-label="Back to feedback list">
        <Link href="/voice-feedback">
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
      </IconButton>
      <span className="text-[13px] text-[var(--color-text-secondary)]">All voice feedback</span>
    </div>
  );
}

function StatusPill({ status }: { status: VoiceFeedbackStatus }) {
  // Same mapping as the list page — `wontfix` falls back to Pill's
  // `neutral` colour since the design system has no grey-pill token.
  const color = (
    status === 'open'
      ? 'amber'
      : status === 'reviewed'
        ? 'blue'
        : status === 'actioned'
          ? 'green'
          : 'neutral'
  ) as 'amber' | 'blue' | 'green' | 'neutral';
  return <Pill color={color}>{status}</Pill>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
