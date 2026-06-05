'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { record as recordLifecycle } from '@/lib/diagnostics/lifecycle-log';

/**
 * Renders nothing. Watches the active service-worker registration for a
 * waiting version and surfaces a sonner toast ("New version available —
 * Reload") so the user — not the browser — decides when to hot-swap code.
 *
 * Why this exists (Phase 7b):
 *   Phase 7a shipped with `skipWaiting: true`, which is safe on a *first*
 *   deploy (no prior SW in prod) but on every deploy after that would
 *   hot-swap the bundle under an inspector mid-edit. 7b removes that flag
 *   from `sw.ts` and moves the handoff to a user-initiated postMessage.
 *
 * Flow:
 *   1. New build is deployed → browser background-fetches `/sw.js`, new SW
 *      installs, sits in `waiting` (old SW still controls the page).
 *   2. This provider detects the waiting SW (either at page load via
 *      `registration.waiting` or on `updatefound` → `statechange: installed`
 *      while an existing controller is present) and shows a persistent
 *      toast with a "Reload" action.
 *   3. User taps Reload → we `postMessage({ type: 'SKIP_WAITING' })` to the
 *      waiting SW; the message handler in `sw.ts` calls `self.skipWaiting()`.
 *   4. New SW activates, `clientsClaim: true` claims this tab, browser fires
 *      `controllerchange` on `navigator.serviceWorker` → we `reload()` once.
 *
 * Guards:
 *   - Don't show the toast on the *first* install (no existing controller)
 *     — that's a fresh SW landing for a user who's never had one, not an
 *     upgrade. The check is `navigator.serviceWorker.controller != null`
 *     at the moment the new SW reaches `installed`.
 *   - `reloadedRef` prevents the `controllerchange` listener from firing
 *     `location.reload()` twice if the browser fires the event more than
 *     once (spec says it shouldn't, but belt-and-braces — a double reload
 *     during a save would be awful).
 *   - `toastShownRef` ensures we only surface one toast per waiting SW even
 *     if both the initial check and the `updatefound` path observe the same
 *     worker (race: registration resolves after `updatefound` already fired).
 *
 * Browser support:
 *   Service workers are unavailable on older Safari and in privacy modes;
 *   the early-return on `!('serviceWorker' in navigator)` keeps this inert.
 *   Serwist itself is disabled in development (see next.config.ts), so this
 *   provider is effectively a no-op in `npm run dev`.
 */
export function SwUpdateProvider() {
  // Persisted across renders so the controllerchange listener and the
  // toast-deduping logic share state with whichever effect tick observed
  // the update first.
  const reloadedRef = useRef(false);
  const toastShownRef = useRef(false);
  // Set true ONLY when the user explicitly taps "Reload" on the toast.
  // controllerchange will then know this is a user-initiated upgrade and
  // can fire `location.reload()` to swap to the new bundle. Without this
  // flag, any controllerchange — including the spontaneous ones that
  // happen when iOS Safari kills a backgrounded PWA and the waiting SW
  // activates on next launch with `clientsClaim: true` — would yank the
  // user to a fresh tab mid-task. The inspector log on 2026-05-11
  // captured 7 such uninitiated reloads in 18 hours, blowing away
  // recording sessions every time.
  const userInitiatedReloadRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    function promptToReload(waiting: ServiceWorker) {
      if (toastShownRef.current) return;
      toastShownRef.current = true;
      // `duration: Infinity` keeps the toast until the user decides — a
      // fresh bundle is worth an explicit acknowledgement. Dismissible so
      // power users can snooze it until their current task is saved.
      toast('New version available', {
        description: 'Reload to get the latest fixes and features.',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: () => {
            // Flip the user-initiated flag so the controllerchange
            // listener below knows this upgrade was opted into. Any
            // OTHER controllerchange (SW activating because the old
            // one's clients all closed) leaves the flag false and
            // the reload is suppressed.
            userInitiatedReloadRef.current = true;
            waiting.postMessage({ type: 'SKIP_WAITING' });
            // Don't call reload() here — wait for `controllerchange` so we
            // reload exactly once the new SW has claimed this client.
            // Reloading before activation would just re-serve the old SW.
          },
        },
      });
    }

    function watchRegistration(registration: ServiceWorkerRegistration) {
      // Case A: a waiting worker already exists at page load (user had the
      // tab open when a deploy shipped the new SW, then closed/reopened
      // the laptop without a hard refresh).
      if (registration.waiting && navigator.serviceWorker.controller) {
        promptToReload(registration.waiting);
      }

      // Case B: a new version installs while the page is open.
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // `installed` + existing controller = upgrade (not first install).
            promptToReload(installing);
          }
        });
      });
    }

    // `getRegistration()` is async; Serwist auto-registers on page load so
    // by the time this effect runs the registration usually exists, but we
    // handle the race by awaiting the promise either way.
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) watchRegistration(registration);
    });

    // First-install detection. If no SW controls this page at mount time,
    // the first `controllerchange` is the brand-new SW taking over — NOT
    // a user-initiated upgrade swap — and reloading would nuke any
    // in-progress edits the user hasn't saved yet. Only reload on
    // controllerchange when we know the page already had a controller
    // (meaning this is an upgrade we've just accepted via SKIP_WAITING).
    const hadControllerAtMount = navigator.serviceWorker.controller != null;

    function onControllerChange() {
      if (reloadedRef.current) return;
      if (!hadControllerAtMount) {
        // First-ever install claim — stay on the page. Subsequent
        // upgrades within the same page lifecycle will still reload
        // because the toast-driven SKIP_WAITING flow sets a different
        // condition (the waiting worker was observed while a
        // controller existed; see `promptToReload` above).
        recordLifecycle('sw-controllerchange-first-install', {});
        return;
      }
      if (!userInitiatedReloadRef.current) {
        // controllerchange fired but the user never tapped Reload. The
        // most common cause: iOS Safari killed the backgrounded PWA,
        // the old SW's controlled-client count hit zero, the waiting
        // SW activated, and `clientsClaim: true` immediately claimed
        // THIS tab on its next launch — all without the user opting
        // in to an upgrade. Pre-2026-05-11, this fired
        // `location.reload()` blindly and yanked inspectors out of
        // mid-recording sessions every time we deployed (7 reloads in
        // 18 hours per the lifecycle log we collected). Now we log
        // and stay put. The waiting toast (if applicable) is still
        // visible so the inspector can opt in when convenient.
        recordLifecycle('sw-controllerchange-uninitiated', {});
        return;
      }
      reloadedRef.current = true;
      recordLifecycle('sw-controllerchange-reload', {});
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  return null;
}
