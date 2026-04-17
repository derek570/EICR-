'use client';

import { useEffect } from 'react';
import { type BeforeInstallPromptEvent, useInstallStore } from '@/lib/pwa/install-store';

/**
 * Renders nothing. Attaches window listeners for `beforeinstallprompt` and
 * `appinstalled` so the zustand install store reflects current install
 * eligibility as early as possible in the page lifecycle.
 *
 * Mounted in the root `layout.tsx` (not `AppShell`) because Chrome can fire
 * `beforeinstallprompt` on any page including `/login`; if we waited until
 * the AppShell mounted, users who land on `/login`, sign in, and cruise
 * straight to the dashboard might miss the event entirely and the install
 * button would never appear.
 *
 * `e.preventDefault()` suppresses Chrome's built-in install banner — we
 * prefer a low-key button in the header over an intrusive banner.
 */
export function InstallPromptProvider() {
  const setDeferred = useInstallStore((s) => s.setDeferred);
  const markInstalled = useInstallStore((s) => s.markInstalled);

  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      markInstalled();
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [setDeferred, markInstalled]);

  return null;
}
