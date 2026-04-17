'use client';

import * as React from 'react';
import { Share, Plus, X } from 'lucide-react';

/**
 * Dismissible "Add to Home Screen" banner for iOS Safari users.
 *
 * Why this exists — the missing piece vs. Chrome/Edge/Android:
 *   Those browsers fire `beforeinstallprompt`, which we capture in
 *   `install-store.ts` and expose via the `<InstallButton />` in the
 *   AppShell header. iOS Safari does NOT fire that event at all; the
 *   only way to install on iOS is:
 *     Share icon → Add to Home Screen → Add
 *   So iPhone/iPad users would never learn the app is installable
 *   without explicit guidance. This banner provides that guidance,
 *   once, on `/settings` (low-traffic page, avoids nagging daily
 *   workflows).
 *
 * Where it renders:
 *   Only on the `/settings` hub. Not the dashboard — the dashboard
 *   is already dense with hero + job list + setup grid, and adding
 *   an install prompt there would push Recent Jobs below the fold
 *   on a phone for the primary daily task.
 *
 * When it suppresses itself:
 *   - Non-iOS devices — Chrome/Edge/Android already have
 *     `<InstallButton />`, so double-prompting is redundant.
 *   - iOS devices that are already running the app in standalone
 *     mode — `navigator.standalone === true` or
 *     `display-mode: standalone` — user has already installed.
 *   - User has tapped the × Dismiss — persisted in `localStorage`
 *     under a versioned key so a future campaign can reset it by
 *     bumping the version suffix (current: `:v1`). Versioning keeps
 *     us honest: the rule is "show once per user per campaign",
 *     not "never again forever".
 *
 * `navigator.standalone` caveats:
 *   - The property is iOS-specific and typed on a nonstandard
 *     navigator extension, so we access it via a cast rather than
 *     adding a global type declaration — it would pollute every
 *     other file's `navigator` type just to set this one flag.
 *   - Fallback to `matchMedia('(display-mode: standalone)')` so
 *     iPadOS 16+ (which reports `display-mode` but may return
 *     undefined for `navigator.standalone` in some configurations)
 *     is caught via whichever signal the OS version exposes.
 *
 * First-paint behaviour:
 *   Starts with `visible=false` and flips to `true` inside the
 *   effect so SSR output matches the no-show case. Flashing the
 *   banner in for a frame on non-iOS would be ugly; defaulting to
 *   hidden and opting in after platform detection is safer and
 *   makes the banner genuinely "opt-in by platform".
 */

const DISMISS_KEY = 'cm_pwa_ios_hint_dismissed:v1';

// iOS-specific navigator extension; not in lib.dom. Keep the cast local.
interface IOSNavigator extends Navigator {
  standalone?: boolean;
}

export function IOSInstallHint() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const ua = window.navigator.userAgent;
    // `MSStream` guard filters out old Windows Phones that spoofed iOS
    // user-agents. Cost of keeping it: nothing; cost of missing it:
    // wrong hint on a long-tail device.
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
    if (!isIOS) return;

    const standaloneNav = (window.navigator as IOSNavigator).standalone === true;
    const standaloneMQ =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches;
    if (standaloneNav || standaloneMQ) return;

    if (localStorage.getItem(DISMISS_KEY) === '1') return;

    setVisible(true);
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private-mode or quota-blown localStorage — fall through. The
      // banner is hidden for this render; at worst it'll come back on
      // next navigation, which is strictly better than crashing.
    }
  }

  if (!visible) return null;

  return (
    <aside
      role="region"
      aria-label="Install CertMate on your iPhone"
      className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-brand-blue)]/30 bg-[color-mix(in_srgb,var(--color-brand-blue)_10%,var(--color-surface-2))] p-5"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install hint"
        className="absolute right-2.5 top-2.5 inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
      >
        <X className="h-4 w-4" strokeWidth={2} aria-hidden />
      </button>

      <div className="flex items-start gap-4 pr-8">
        <div
          aria-hidden
          className="mt-0.5 inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--color-brand-blue)]/15 text-[var(--color-brand-blue)]"
        >
          <Plus className="h-5 w-5" strokeWidth={2.5} aria-hidden />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
            Add CertMate to your Home Screen
          </h2>
          <p className="text-[13px] leading-snug text-[var(--color-text-secondary)]">
            Installing lets you launch CertMate full-screen from your Home Screen — same as iOS
            native apps. No App Store needed.
          </p>
          <ol className="mt-1 flex flex-col gap-1.5 text-[13px] text-[var(--color-text-secondary)]">
            <li className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[11px] font-semibold text-[var(--color-text-primary)]">
                1
              </span>
              <span className="inline-flex items-center gap-1">
                Tap the
                <Share
                  className="h-4 w-4 text-[var(--color-brand-blue)]"
                  strokeWidth={2}
                  aria-label="Share"
                />
                Share icon in Safari’s toolbar.
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[11px] font-semibold text-[var(--color-text-primary)]">
                2
              </span>
              <span>
                Scroll and tap <strong className="font-semibold">Add to Home Screen</strong>, then{' '}
                <strong className="font-semibold">Add</strong>.
              </span>
            </li>
          </ol>
        </div>
      </div>
    </aside>
  );
}
