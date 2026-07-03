import * as React from 'react';

/**
 * BrandedSplash — WS7 launch/loading continuity with iOS `RootView`'s
 * branded loading view: a `bolt.shield.fill` glyph inside a blue→green
 * hero-gradient circle, above the "CertMate" wordmark (blue "Cert" / green
 * "Mate"). Reuses the WS5 brand tokens so the cold-launch splash reads as
 * the same app as the iOS build rather than a flash of empty dark surface.
 *
 * Used as the App Router root `loading.tsx` (shown while the first segment
 * streams in) and available for any full-screen boot/suspense state.
 */
export function BrandedSplash() {
  return (
    <div
      role="status"
      aria-label="Loading CertMate"
      className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-[var(--color-surface-0)]"
    >
      <div
        className="flex h-24 w-24 items-center justify-center rounded-full"
        style={{
          background: 'linear-gradient(135deg, var(--color-brand-blue), var(--color-brand-green))',
          boxShadow: '0 8px 40px rgba(0, 102, 255, 0.35)',
        }}
      >
        {/* bolt.shield.fill — a lightning bolt inside a shield. */}
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 2l7 3v6c0 4.6-3 8.1-7 9-4-.9-7-4.4-7-9V5l7-3z"
            fill="rgba(255,255,255,0.16)"
            stroke="white"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M13 6.5l-4.2 6.2H12l-1 4.8 4.2-6.4H12l1-4.6z" fill="white" />
        </svg>
      </div>
      <div className="text-2xl font-bold tracking-tight">
        <span className="text-[var(--color-brand-blue)]">Cert</span>
        <span className="text-[var(--color-brand-green)]">Mate</span>
      </div>
    </div>
  );
}
