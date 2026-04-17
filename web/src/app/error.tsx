'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';

/**
 * Root error boundary.
 *
 * Two jobs:
 *
 * 1. **Auto-recover from "Failed to find Server Action" after a deploy.**
 *    Next.js keys server-action lookups by a hash that changes every build.
 *    An open tab that was loaded before a deploy will see its cached JS
 *    call a handler that no longer exists server-side, and Next throws
 *    exactly that error with `digest: NEXT_SERVER_ACTION_*`. The fix is
 *    always the same: reload. We do it automatically, BUT only once per
 *    30 s (sessionStorage timestamp guard) so a broken action that
 *    *consistently* fails doesn't pin the user in a reload loop.
 *
 * 2. **Brand-consistent fallback for everything else.** Matches the
 *    login/offline visual language so an unhandled error doesn't dump
 *    users into a stock Next error page with no way out. `reset()` is
 *    Next's built-in recovery — retries rendering the segment without
 *    a full reload.
 *
 * We log the error to the console in dev, and emit `error.digest` to
 * console in prod so CloudWatch/Sentry-style aggregators can pick it up
 * (we don't have Sentry wired yet — Phase 7b+ will add it).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Always surface the error for diagnosis. `error.digest` is the only
    // identifier that reaches the server — users reporting bugs should
    // quote it.
    console.error('[cm:root-error]', error, 'digest:', error.digest);

    const isServerActionStale =
      error.message.includes('Failed to find Server Action') ||
      (typeof error.digest === 'string' && error.digest.includes('NEXT_SERVER_ACTION'));

    if (!isServerActionStale || typeof window === 'undefined') return;

    // Guard against a reload loop: if we reloaded within the last 30 s
    // and the error is still firing, something is broken beyond a stale
    // action hash. Stop reloading and show the fallback so the user can
    // at least see a message and choose to retry manually.
    const key = 'cm_sa_reload_ts';
    const now = Date.now();
    const raw = window.sessionStorage.getItem(key);
    const last = raw ? Number(raw) : 0;
    if (last && now - last < 30_000) return;

    window.sessionStorage.setItem(key, String(now));
    window.location.reload();
  }, [error]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
      <div
        className="cm-orb"
        style={{
          top: '-140px',
          left: '-80px',
          width: '480px',
          height: '480px',
          background: 'radial-gradient(circle, rgba(0,102,255,0.9), transparent 70%)',
        }}
        aria-hidden
      />
      <div
        className="cm-orb"
        style={{
          bottom: '-180px',
          right: '-120px',
          width: '560px',
          height: '560px',
          background: 'radial-gradient(circle, rgba(255,69,58,0.45), transparent 70%)',
          animationDelay: '-4s',
        }}
        aria-hidden
      />
      <div
        className="cm-glass relative w-full rounded-[var(--radius-xl)] p-7 md:p-9 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        style={{ maxWidth: '420px' }}
      >
        <div className="mb-6 flex flex-col items-start gap-2">
          <Logo size="lg" />
          <h1 className="mt-3 text-[26px] font-bold tracking-tight">Something went wrong</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            We&rsquo;ve logged this and will take a look. You can try again — if the problem
            persists after a reload, reopen the app.
          </p>
          <div className="cm-shimmer mt-2 h-px w-24 rounded-full" aria-hidden />
        </div>

        {error.digest ? (
          <p className="mb-4 font-mono text-xs text-[var(--color-text-secondary)] break-all">
            ref {error.digest}
          </p>
        ) : null}

        <Button type="button" size="lg" className="w-full" onClick={() => reset()}>
          Try again
        </Button>
      </div>
    </main>
  );
}
