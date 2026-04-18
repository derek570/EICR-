'use client';

import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';

/**
 * Offline fallback rendered by the service worker whenever a navigation
 * times out (see `sw.ts`). Deliberately lightweight: no data fetches, no
 * auth calls, no API imports at module scope — this page must render from
 * the precache alone, on a device that may have no connectivity at all.
 *
 * Mirrors the login page's visual chrome (ambient orbs + glass card +
 * shimmer line) so the transition from online to offline doesn't feel
 * like hitting a "you broke the internet" dead-end.
 *
 * Copy policy (Wave 5 D10):
 *   The card must only claim what we can actually guarantee. A full
 *   reload happens on `online` per the Serwist `reloadOnOnline` default
 *   (still global until Wave 5 D7 scopes it to `/offline` only per
 *   FIX_PLAN Q6), and the Phase 7c outbox replays queued job-save
 *   patches when the tab reconnects — but only for signed-in sessions
 *   (AppShell-mounted replay worker) and only for mutations that use
 *   the outbox. The `/offline` shell is reached from unauth'd routes
 *   too (login, legal), so we can't promise "your changes will sync":
 *   we say edits are kept locally (IDB) and will attempt to sync on
 *   reconnect. "Attempt" is load-bearing — captive portals, 4xx
 *   poisoning, and signed-out sessions all mean best-effort, not
 *   guaranteed.
 */
export default function OfflinePage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
      <AmbientOrbs />
      <div
        className="cm-glass relative w-full rounded-[var(--radius-xl)] p-7 md:p-9 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        style={{ maxWidth: '420px' }}
      >
        <div className="mb-6 flex flex-col items-start gap-2">
          <Logo size="lg" />
          <h1 className="mt-3 text-[26px] font-bold tracking-tight">You appear to be offline</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            This page needs a connection. Edits you made while signed in are kept on this device and
            we&rsquo;ll try to sync them once you&rsquo;re back online.
          </p>
          <div className="cm-shimmer mt-2 h-px w-24 rounded-full" aria-hidden />
        </div>

        <Button
          type="button"
          size="lg"
          className="mt-2 w-full"
          onClick={() => {
            if (typeof window !== 'undefined') window.location.reload();
          }}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}

function AmbientOrbs() {
  return (
    <>
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
          background: 'radial-gradient(circle, rgba(0,204,102,0.55), transparent 70%)',
          animationDelay: '-4s',
        }}
        aria-hidden
      />
      <div
        className="cm-orb"
        style={{
          top: '35%',
          right: '10%',
          width: '220px',
          height: '220px',
          background: 'radial-gradient(circle, rgba(191,90,242,0.35), transparent 70%)',
          animationDelay: '-2s',
        }}
        aria-hidden
      />
    </>
  );
}
