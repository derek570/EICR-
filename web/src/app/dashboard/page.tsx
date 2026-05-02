'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  ChevronRight,
  Compass,
  FilePlus,
  LogOut,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  UserCheck,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { getCachedJobs, putCachedJobs } from '@/lib/pwa/job-cache';
import { useOutboxState } from '@/lib/pwa/use-outbox-state';
import { ApiError, type Job } from '@/lib/types';
import { AnimatedCounter } from '@/components/dashboard/animated-counter';
import { JobRow } from '@/components/dashboard/job-row';
import { TourOverlay } from '@/components/tour/tour-overlay';
import { useTour } from '@/hooks/use-tour';

/**
 * iOS-parity dashboard:
 *  - Gradient hero card with inline ACTIVE / DONE / EXP stats
 *  - Start EICR / Start EIC big buttons
 *  - Search bar
 *  - Recent Jobs <N> list (coloured stripe + status pill)
 *  - Setup & Tools 2-column grid
 *
 * Reference: memory/ios_design_parity.md (Dashboard section)
 */
export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = React.useState<Job[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [query, setQuery] = React.useState('');
  // Phase 7d — surface the "Pending sync" chip on job rows that have
  // an offline mutation still in the outbox. The hook refreshes on
  // any outbox change (same-tab + BroadcastChannel across tabs) so
  // the chip appears / disappears without a route change.
  const { pendingJobIds } = useOutboxState();

  React.useEffect(() => {
    const user = getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    let cancelled = false;

    // Phase 7b — stale-while-revalidate via the IDB job cache.
    //
    // Read cache first so the list paints instantly (avoids the 4-row
    // shimmer on a warm device, and makes the dashboard usable in
    // airplane mode / site basement / dead-spot van where the fetch
    // below will never land). The network call still fires in parallel
    // and replaces the UI + cache on success.
    //
    // Error handling diverges from 7a: if the network fails but we
    // already painted from cache, we DON'T surface an error banner —
    // the inspector can still browse their jobs, and the forthcoming
    // AppShell offline indicator (separate 7b commit) will tell them
    // the data is stale. Only show an error when there's nothing to
    // paint at all.
    let hadCache = false;
    // Pre-deploy fix: the previous closure check `jobs === null` relied
    // on the captured state at effect-run time, so a cache resolve that
    // fired *after* a fast network win could clobber fresh server data
    // with a stale IDB snapshot. A ref set the moment the network
    // branch lands gives us an unambiguous "don't paint cache anymore"
    // signal that doesn't depend on React's render timing.
    let networkLanded = false;
    getCachedJobs(user.id).then((cached) => {
      if (cancelled || networkLanded) return;
      if (cached) {
        // Functional setter so a racing network resolve can't be
        // silently overwritten (we only paint cache if nothing's there).
        setJobs((prev) => prev ?? cached);
        hadCache = true;
      }
    });

    api
      .jobs(user.id)
      .then((list) => {
        if (cancelled) return;
        networkLanded = true;
        setJobs(list);
        // Fire-and-forget cache write. Ignoring the promise is deliberate —
        // the UI already has the fresh data; a cache write failure is
        // logged inside `putCachedJobs` but doesn't affect this render.
        void putCachedJobs(user.id, list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Wave 2 D12: classify by `ApiError.status` instead of the pre-
        // D12 regex against `err.message`. The old check failed for any
        // backend route that returned a JSON envelope whose body didn't
        // literally contain "401" (e.g. `{error:"Unauthorised"}`), so a
        // real expiry would surface as a banner instead of a redirect.
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
          router.replace('/login');
          return;
        }
        // If we already painted from IDB, keep showing that and suppress
        // the banner — "offline with stale data" is a better UX than
        // "offline with an error message on top of stale data".
        if (hadCache) return;
        setError(err.message);
        setJobs([]);
      });
    return () => {
      cancelled = true;
    };
    // Pre-deploy: the cache/network race guard moved from a closure
    // check over `jobs` to the `networkLanded` flag above, so `jobs`
    // no longer needs to be referenced inside the effect — `router`
    // is the only live dependency and the exhaustive-deps rule is
    // satisfied without suppression.
  }, [router]);

  const stats = React.useMemo(() => {
    const list = jobs ?? [];
    // ACTIVE = anything not yet complete (includes failed so nothing is lost
    // in UI accounting). DONE = completed.
    const active = list.filter((j) => j.status !== 'done').length;
    const done = list.filter((j) => j.status === 'done').length;
    // Phase 3 — EXP parity with iOS `DashboardView.swift:L384-L387`.
    // The iOS app uses the same placeholder: done jobs whose
    // `lastModified` is older than 4 years. We mirror that with the
    // list-level `updated_at` (fallback to `created_at`) because the
    // Job list endpoint does NOT carry `next_inspection_due` — that
    // field lives only on `JobDetail.installation_details`. The
    // authoritative fix is a backend change to surface
    // `next_inspection_due` on the list response (flagged in the
    // parity ledger as a backend gap). Until then this heuristic is
    // byte-compatible with iOS's own fallback.
    const FOUR_YEARS_MS = 4 * 365.25 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - FOUR_YEARS_MS;
    const exp = list.filter((j) => {
      if (j.status !== 'done') return false;
      const t = Date.parse(j.updated_at ?? j.created_at);
      return Number.isFinite(t) && t < cutoff;
    }).length;
    return { active, done, exp };
  }, [jobs]);

  const recent = React.useMemo(() => {
    const list = jobs ?? [];
    const filtered = query.trim()
      ? list.filter((j) => (j.address ?? '').toLowerCase().includes(query.trim().toLowerCase()))
      : list;
    return filtered.slice(0, 8);
  }, [jobs, query]);

  async function createJob(kind: 'EICR' | 'EIC') {
    const user = getUser();
    if (!user) return;
    setCreating(true);
    try {
      const { id } = await api.createJob(user.id, kind);
      router.push(`/job/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create job");
    } finally {
      setCreating(false);
    }
  }

  // Phase 3 — drop a deleted job out of the list without a full refetch.
  // The JobRow calls this once the backend DELETE lands.
  const handleJobDeleted = React.useCallback((jobId: string) => {
    setJobs((prev) => (prev ? prev.filter((j) => j.id !== jobId) : prev));
  }, []);

  function signOut() {
    clearAuth();
    router.replace('/login');
  }

  // Phase 3 — guided tour controller. Auto-starts on first visit, and
  // the "Start tour" tile below hands off to `tour.start()` so the
  // same state machine runs whether the tour is auto or manual.
  // Phase D — narrate=true enables Web Speech API narration on each
  // step plus auto-advance once the speech ends. iOS canon: the
  // dashboard tour is fully narrated (TourManager.dashboardSteps).
  const tour = useTour({ autoStartOnFirstRun: true, narrate: true });

  return (
    <main
      className="mx-auto flex w-full flex-col gap-6 px-4 pb-24 pt-6 md:px-8 md:py-10"
      style={{ maxWidth: '1100px' }}
    >
      {/* ---------- Hero ---------- */}
      <div data-tour="hero">
        <HeroCard active={stats.active} done={stats.done} exp={stats.exp} />
      </div>

      {/* ---------- Start new certificate ---------- */}
      <section className="grid gap-3 md:grid-cols-2" data-tour="start-eicr">
        <StartTile
          kind="EICR"
          label="Start EICR"
          accent="var(--color-brand-blue)"
          onClick={() => createJob('EICR')}
          disabled={creating}
        />
        <StartTile
          kind="EIC"
          label="Start EIC"
          accent="var(--color-brand-green)"
          onClick={() => createJob('EIC')}
          disabled={creating}
        />
      </section>

      {/* ---------- Search ---------- */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-tertiary)]"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs..."
          aria-label="Search jobs"
          className="w-full rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] py-3 pl-11 pr-4 text-[15px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
        />
      </div>

      {/* ---------- Recent jobs ---------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold text-[var(--color-text-primary)]">
            Recent Jobs
            <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-[var(--color-brand-blue)] px-2 py-0.5 text-xs font-semibold text-white">
              {jobs?.length ?? 0}
            </span>
          </h2>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
          >
            {error}
          </p>
        ) : null}
        {jobs === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="cm-shimmer h-16 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
              />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">
            {query.trim()
              ? `No jobs match “${query}”.`
              : 'No certificates yet — start an EICR or EIC above.'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                pendingSync={pendingJobIds.has(j.id)}
                onDeleted={handleJobDeleted}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---------- Setup & Tools ----------
       *
       * Pre-deploy: trimmed to routes that actually exist under
       * `src/app/settings/`. The old set linked to `/settings/defaults`,
       * `/settings/inspectors`, and `/tour` — none of those pages ship
       * in this build, so every inspector landing on them would hit a
       * 404 from the dashboard's primary nav. Defaults / Tour will come
       * back as the routes land; the Staff tile points at the real
       * `/settings/staff` page (was the legacy `/inspectors` URL from
       * iOS). Log Out stays but is rendered by its own destructive
       * variant so the colour tells the story.
       */}
      <section className="flex flex-col gap-3 pt-2" data-tour="setup-tools">
        <h2 className="text-[17px] font-semibold text-[var(--color-text-primary)]">
          Setup &amp; Tools
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {/*
           * iOS canon ordering (DashboardView.swift L593-630):
           *   Defaults | Company / Staff | Settings / Tour | Log Out
           * Defaults tile was hidden during the Phase 6 partial port;
           * Phase B (2026-05-03) restores it now that the Defaults
           * manager is fully wired (presets + cable sizes editor + apply
           * flow at /settings/defaults).
           */}
          <SetupTile icon={SlidersHorizontal} label="Defaults" href="/settings/defaults" />
          <SetupTile icon={Building2} label="Company" href="/settings/company" />
          <SetupTile icon={UserCheck} label="Staff" href="/settings/staff" />
          <SetupTile icon={Settings} label="Settings" href="/settings" />
          {/*
           * Phase 3 — Tour tile. Two flavours:
           *   - While the tour is live, we show "Stop tour" so the
           *     user can always bail without hunting for the floating
           *     overlay's X button.
           *   - Otherwise, "Start tour" becomes the manual entry
           *     point. The tile appears regardless of the `seen` flag
           *     so returning users can re-run on demand (matches the
           *     iOS "Tour" tile which is always visible).
           */}
          <SetupTile
            icon={Compass}
            label={tour.active ? 'Stop tour' : 'Start tour'}
            onClick={() => (tour.active ? tour.stop() : tour.start())}
          />
          <SetupTile icon={LogOut} label="Log Out" variant="destructive" onClick={signOut} />
        </div>
      </section>

      {/* Phase 3 — floating tour overlay. Renders nothing when the
          tour isn't active, so mounting is free on every dashboard
          visit. */}
      <TourOverlay controller={tour} />
    </main>
  );
}

/* ----------------------------------------------------------------------- */

function HeroCard({ active, done, exp }: { active: number; done: number; exp: number }) {
  return (
    <section
      aria-labelledby="hero-heading"
      className="relative overflow-hidden rounded-[22px] px-6 py-6 md:px-8 md:py-8"
      style={{
        background:
          'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
      }}
    >
      {/* Subtle sheen on the top edge for iOS-like depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-16"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, transparent 100%)',
        }}
      />

      <Shield
        aria-hidden
        className="absolute right-5 top-5 h-7 w-7 text-white/80"
        strokeWidth={2}
      />

      <h1
        id="hero-heading"
        className="text-[34px] font-black leading-none text-white md:text-[40px]"
      >
        CertMate
      </h1>
      <p className="mt-1 text-[13px] font-medium text-white/85">Electrical Certification</p>

      <dl className="mt-6 grid grid-cols-3 gap-4">
        <HeroStat label="ACTIVE" value={active} />
        <HeroStat label="DONE" value={done} />
        <HeroStat label="EXP" value={exp} />
      </dl>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-start">
      <AnimatedCounter
        value={value}
        className="text-[34px] font-black leading-none text-white md:text-[40px]"
        aria-label={`${value} ${label.toLowerCase()}`}
      />
      <span className="mt-1 text-[11px] font-semibold tracking-[0.18em] text-white/80">
        {label}
      </span>
    </div>
  );
}

function StartTile({
  kind,
  label,
  accent,
  onClick,
  disabled,
}: {
  kind: 'EICR' | 'EIC';
  label: string;
  accent: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="group relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-[18px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] py-6 transition hover:bg-[var(--color-surface-3)] active:scale-[0.99] disabled:opacity-50"
      style={{
        // subtle accent tint, top-down
        backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${accent} 16%, transparent) 0%, transparent 70%)`,
      }}
    >
      <span
        className="inline-flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: `color-mix(in srgb, ${accent} 22%, transparent)`, color: accent }}
        aria-hidden
      >
        <FilePlus className="h-5 w-5" strokeWidth={2} />
      </span>
      <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">{label}</span>
      <span className="sr-only">Create new {kind} certificate</span>
    </button>
  );
}

type LucideIcon = React.ComponentType<{
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean;
}>;

function SetupTile({
  icon: Icon,
  label,
  href,
  onClick,
  trailing,
  variant = 'default',
}: {
  icon: LucideIcon;
  label: string;
  href?: string;
  onClick?: () => void;
  trailing?: string;
  variant?: 'default' | 'destructive';
}) {
  const destructive = variant === 'destructive';
  const color = destructive ? 'var(--color-status-failed)' : 'var(--color-text-primary)';
  const iconColor = destructive ? 'var(--color-status-failed)' : 'var(--color-brand-blue)';

  const content = (
    <>
      <span
        className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--color-surface-3)', color: iconColor }}
        aria-hidden
      >
        <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
      </span>
      <span className="flex-1 truncate text-[15px] font-semibold" style={{ color }}>
        {label}
      </span>
      {trailing ? (
        <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--color-text-tertiary)]">
          {trailing}
        </span>
      ) : null}
      <ChevronRight
        aria-hidden
        className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]"
        strokeWidth={2}
      />
    </>
  );

  const classes =
    'flex items-center gap-3 rounded-[14px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 text-left transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]';

  if (href) {
    // Use next/link for internal destinations so the dashboard gets
    // client-side navigation + prefetch. The old raw `<a href>` caused
    // a full document navigation on every tap — visibly slower, and
    // dropped the SWR dashboard state each time the user bounced out
    // to settings.
    return (
      <Link href={href} className={classes} prefetch>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {content}
    </button>
  );
}
