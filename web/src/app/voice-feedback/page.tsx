'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MessageSquareWarning } from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { isSystemAdmin } from '@/lib/roles';
import { useCurrentUser } from '@/lib/use-current-user';
import { ApiError, type VoiceFeedbackListItem, type VoiceFeedbackStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pill } from '@/components/ui/pill';

/**
 * /voice-feedback — triage list for on-device voice feedback markers.
 *
 * PLAN-web-final.md §1.6.5. Inspector says "feedback ... end feedback"
 * on-device → iOS uploads a JSON blob with the captured complaint text
 * + a short transcript window → backend writes a `voice_feedback` row →
 * this page lets the developer/admin walk through them, mark them
 * reviewed, jot a note, or escalate to the detail view.
 *
 * Sibling pages:
 *   - /voice-feedback/[id] — detail (issue text + transcript + S3 link)
 *
 * Layout deliberately mirrors /alerts — no nested AppShell wrap (the
 * page returns `<main>` and lives below the global `app/layout.tsx`),
 * a max-3xl centred column, status-pill rows. Inspector vocabulary
 * stays the same as the rest of the app (no "ticket" / "report" — it
 * is voice "feedback").
 */
export default function VoiceFeedbackListPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const isAdmin = isSystemAdmin(user);

  // Filter state. `null` for status === "All"; an explicit
  // VoiceFeedbackStatus narrows the list. `jobId` and `q` are independent.
  const [statusFilter, setStatusFilter] = React.useState<VoiceFeedbackStatus | null>(null);
  const [jobIdFilter, setJobIdFilter] = React.useState<string | null>(null);
  const [searchRaw, setSearchRaw] = React.useState('');
  const [searchDebounced, setSearchDebounced] = React.useState('');

  // Admin "Show all users" toggle. Only rendered when isSystemAdmin,
  // but the state lives at the page level so the request branching
  // stays in one place.
  const [showAllUsers, setShowAllUsers] = React.useState(false);

  const [items, setItems] = React.useState<VoiceFeedbackListItem[] | null>(null);
  const [total, setTotal] = React.useState<number>(0);
  const [offset, setOffset] = React.useState<number>(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Per-row "mark reviewed" busy state so we can disable the button
  // during the in-flight PATCH without freezing the whole list.
  const [busyIds, setBusyIds] = React.useState<Set<string>>(new Set());

  // Debounce free-text search at 300 ms. The user can type freely; we
  // only re-query when they pause. Setting `searchDebounced` to the
  // current input value resets the offset back to 0 via the main
  // `loadFirstPage` effect.
  React.useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchRaw.trim()), 300);
    return () => clearTimeout(t);
  }, [searchRaw]);

  // Anchor: any filter change wipes the previous results, resets
  // offset, and re-fetches from page 0. We do NOT preserve the partial
  // list while filters reload because the row identities change — a
  // half-redrawn list would be misleading.
  React.useEffect(() => {
    const u = getUser();
    if (!u) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    setOffset(0);
    setItems(null);
    setTotal(0);
    setError(null);

    const params = {
      status: statusFilter ?? undefined,
      jobId: jobIdFilter ?? undefined,
      q: searchDebounced || undefined,
      limit: 50,
      offset: 0,
    };

    const promise =
      isAdmin && showAllUsers ? api.voiceFeedbackAdminAll(params) : api.voiceFeedbackList(params);

    promise
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load feedback');
        setItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [router, statusFilter, jobIdFilter, searchDebounced, isAdmin, showAllUsers]);

  async function handleLoadMore() {
    if (loadingMore || !items) return;
    setLoadingMore(true);
    const nextOffset = offset + 50;
    try {
      const params = {
        status: statusFilter ?? undefined,
        jobId: jobIdFilter ?? undefined,
        q: searchDebounced || undefined,
        limit: 50,
        offset: nextOffset,
      };
      const res =
        isAdmin && showAllUsers
          ? await api.voiceFeedbackAdminAll(params)
          : await api.voiceFeedbackList(params);
      setItems((prev) => (prev ? [...prev, ...res.items] : res.items));
      setOffset(nextOffset);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more feedback');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleMarkReviewed(id: string) {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    // Optimistic update. Failure paths roll back and surface an error.
    const prevItems = items;
    setItems((cur) =>
      cur ? cur.map((it) => (it.id === id ? { ...it, status: 'reviewed' } : it)) : cur
    );
    try {
      await api.voiceFeedbackPatch(id, { status: 'reviewed' });
    } catch (err) {
      setItems(prevItems);
      setError(err instanceof Error ? err.message : 'Failed to mark reviewed');
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const hasMore = items !== null && items.length < total;

  // Distinct job IDs derived from the items currently loaded. Plan
  // calls for a "dropdown of distinct jobIds"; v1 reads them off the
  // current page rather than asking the backend for the full distinct
  // set, since the realistic feedback volume per dev is small and
  // anything we don't see in the current page is filterable via the
  // free-text search anyway. Promotable to a dedicated endpoint if
  // volume grows.
  const distinctJobIds = React.useMemo(() => {
    if (!items) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
      if (it.jobId && !seen.has(it.jobId)) {
        seen.add(it.jobId);
        out.push(it.jobId);
      }
    }
    return out;
  }, [items]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">Voice feedback</h1>
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          On-device complaints captured via the &quot;feedback&hellip; end feedback&quot; voice
          marker.
        </p>
      </header>

      <FilterBar
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        jobIdFilter={jobIdFilter}
        onJobIdChange={setJobIdFilter}
        distinctJobIds={distinctJobIds}
        search={searchRaw}
        onSearchChange={setSearchRaw}
        isAdmin={isAdmin}
        showAllUsers={showAllUsers}
        onShowAllUsersChange={setShowAllUsers}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
        >
          {error}
        </p>
      ) : null}

      {items === null ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="cm-shimmer h-24 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it) => (
            <FeedbackRow
              key={it.id}
              item={it}
              busy={busyIds.has(it.id)}
              onMarkReviewed={() => handleMarkReviewed(it.id)}
            />
          ))}
          {hasMore ? (
            <Button
              variant="secondary"
              size="md"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="mt-2 self-center"
            >
              {loadingMore ? 'Loading…' : `Load more (${total - items.length} remaining)`}
            </Button>
          ) : null}
        </div>
      )}
    </main>
  );
}

// -----------------------------------------------------------------------

function FilterBar({
  statusFilter,
  onStatusChange,
  jobIdFilter,
  onJobIdChange,
  distinctJobIds,
  search,
  onSearchChange,
  isAdmin,
  showAllUsers,
  onShowAllUsersChange,
}: {
  statusFilter: VoiceFeedbackStatus | null;
  onStatusChange: (next: VoiceFeedbackStatus | null) => void;
  jobIdFilter: string | null;
  onJobIdChange: (next: string | null) => void;
  distinctJobIds: string[];
  search: string;
  onSearchChange: (next: string) => void;
  isAdmin: boolean;
  showAllUsers: boolean;
  onShowAllUsersChange: (next: boolean) => void;
}) {
  const statusOptions: Array<{ label: string; value: VoiceFeedbackStatus | null }> = [
    { label: 'All', value: null },
    { label: 'Open', value: 'open' },
    { label: 'Reviewed', value: 'reviewed' },
    { label: 'Actioned', value: 'actioned' },
    { label: 'Wontfix', value: 'wontfix' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {statusOptions.map((opt) => {
          const active = statusFilter === opt.value;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => onStatusChange(opt.value)}
              data-status-chip={opt.label.toLowerCase()}
              aria-pressed={active}
              className={
                active
                  ? 'rounded-full bg-[var(--color-brand-blue)] px-3 py-1 text-[13px] font-semibold text-white'
                  : 'rounded-full border border-[var(--color-border-default)] bg-transparent px-3 py-1 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={jobIdFilter ?? ''}
          onChange={(e) => onJobIdChange(e.target.value || null)}
          className="h-11 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-2)] px-3 text-[15px] text-[var(--color-text-primary)] sm:flex-none"
          aria-label="Filter by job"
        >
          <option value="">Job: any</option>
          {distinctJobIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search issue text…"
          aria-label="Search feedback issue text"
        />
      </div>
      {isAdmin ? (
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={showAllUsers}
            onChange={(e) => onShowAllUsersChange(e.target.checked)}
          />
          Show all users (admin)
        </label>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------

function FeedbackRow({
  item,
  busy,
  onMarkReviewed,
}: {
  item: VoiceFeedbackListItem;
  busy: boolean;
  onMarkReviewed: () => void;
}) {
  const dateLabel = formatDate(item.createdAt);
  return (
    <article
      data-feedback-id={item.id}
      className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="text-[13px] text-[var(--color-text-secondary)]">
            {dateLabel}
            {item.address ? <> · {item.address}</> : null}
            {item.jobId ? <> · {item.jobId}</> : null}
            {item.userId ? <> · user {item.userId}</> : null}
          </div>
        </div>
        <StatusPill status={item.status} />
      </header>
      <p className="line-clamp-3 text-[14px] leading-[1.45] text-[var(--color-text-primary)]">
        {item.issuePreview || '(no transcript captured)'}
      </p>
      <footer className="flex items-center justify-between gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link href={`/voice-feedback/${encodeURIComponent(item.id)}`} data-action="open-detail">
            Open
          </Link>
        </Button>
        {item.status === 'open' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMarkReviewed}
            disabled={busy}
            data-action="mark-reviewed"
          >
            {busy ? 'Saving…' : 'Mark reviewed'}
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

function StatusPill({ status }: { status: VoiceFeedbackStatus }) {
  // Plan §1.6.5: open=amber / reviewed=blue / actioned=green / wontfix=grey.
  // Pill primitive's `neutral` colour is the grey/tertiary text colour,
  // which matches the design-system "muted" state — closest semantic
  // match for "wontfix" without inventing a new colour token.
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

function EmptyState() {
  return (
    <section className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-6 py-12 text-center">
      <MessageSquareWarning
        className="h-14 w-14 text-[var(--color-text-tertiary)]"
        strokeWidth={1.5}
        aria-hidden
      />
      <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">No feedback yet</h2>
      <p className="max-w-xs text-[13px] leading-[1.5] text-[var(--color-text-secondary)]">
        Voice feedback markers captured on the iOS app will appear here.
      </p>
    </section>
  );
}

function formatDate(iso: string): string {
  // Defensive: backend should send ISO-8601; treat anything unparseable
  // as a transparent passthrough rather than throwing on the user.
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
