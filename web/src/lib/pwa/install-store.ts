import { create } from 'zustand';

/**
 * Chrome / Edge / Android WebView fire `beforeinstallprompt` when the app
 * meets the PWA install criteria. We stash the event in a store instead
 * of acting on it immediately so the user, not the browser, decides when
 * to install — auto-banners hurt conversion and annoy power users.
 *
 * Safari (desktop + iOS) does NOT fire this event at all; the store will
 * simply stay empty there and `<InstallButton />` will render nothing.
 * An iOS "Add to Home Screen" hint on `/settings` is a Phase 7b add-on.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

interface InstallState {
  deferredPrompt: BeforeInstallPromptEvent | null;
  /** `deferredPrompt != null`; surfaced as a selector for readability. */
  canInstall: boolean;
  /** Set to true once the PWA is installed; the browser fires `appinstalled`. */
  isInstalled: boolean;
  setDeferred: (evt: BeforeInstallPromptEvent | null) => void;
  markInstalled: () => void;
}

export const useInstallStore = create<InstallState>((set) => ({
  deferredPrompt: null,
  canInstall: false,
  isInstalled: false,
  setDeferred: (evt) =>
    set({
      deferredPrompt: evt,
      canInstall: evt !== null,
    }),
  markInstalled: () => set({ deferredPrompt: null, canInstall: false, isInstalled: true }),
}));
