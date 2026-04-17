'use client';

import { Button } from '@/components/ui/button';
import { useInstallStore } from '@/lib/pwa/install-store';

/**
 * Renders nothing until the browser has fired `beforeinstallprompt`. On
 * click, shows the native install prompt, then clears the stored event
 * (browsers allow `prompt()` to be called at most once per event).
 *
 * Ghost + small to sit quietly next to the Sign-out button in AppShell.
 * If the install dialog is dismissed, we still clear the deferred prompt
 * — Chrome won't fire `beforeinstallprompt` again in the same session, so
 * hiding the button is the correct affordance (re-shows on next visit).
 */
export function InstallButton() {
  const deferredPrompt = useInstallStore((s) => s.deferredPrompt);
  const canInstall = useInstallStore((s) => s.canInstall);
  const setDeferred = useInstallStore((s) => s.setDeferred);

  if (!canInstall || !deferredPrompt) return null;

  async function handleClick() {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      // Await the choice so we only clear once the dialog is actually done;
      // otherwise the button could flicker away before the user picks.
      await deferredPrompt.userChoice;
    } catch {
      // Silently ignore — the browser will refuse a second `prompt()` call
      // with an error; nothing we can recover from.
    } finally {
      setDeferred(null);
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleClick} aria-label="Install CertMate app">
      Install app
    </Button>
  );
}
