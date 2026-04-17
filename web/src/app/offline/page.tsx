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
 * like hitting a "you broke the internet" dead-end. The card explicitly
 * tells the inspector that queued work will sync when they're back
 * online — true now (a full reload happens on `online` per the Serwist
 * `reloadOnOnline` default; no per-field sync yet) and forward-compatible
 * with the Phase 7c outbox.
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
          <h1 className="mt-3 text-[26px] font-bold tracking-tight">You&rsquo;re offline</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Reconnect to continue. Any changes you made before losing signal are still on this
            device and will sync automatically when the network returns.
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
