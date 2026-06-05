'use client';

import * as React from 'react';
import { PauseCircle } from 'lucide-react';
import { useRecording } from '@/lib/recording-context';

/**
 * Chitchat-pause banner.
 *
 * Rendered when the backend has paused Sonnet API forwarding because of
 * 10 consecutive zero-engagement transcript turns. Mirrors iOS
 * `ChitchatPauseBanner.swift` and `JobDetailView.swift:847-861` exactly:
 *   - Warning-coloured pause icon
 *   - "AI paused" title
 *   - "Say 'resume', 'carry on' or a value to wake" subtitle
 *   - "Resume" capsule button → `resumeChitchat()` (optimistic clear +
 *     5s watchdog re-show if the backend doesn't confirm).
 *
 * Distinct from `<OfflineBanner>`, `<PendingDataBanner>`, and the
 * Deepgram doze indicator — those keep rendering unchanged. This only
 * appears when the chitchat-pause state machine fires
 * (`chitchat_paused` over the server WS).
 *
 * Wake triggers (server-side; user just needs to say a wake word OR
 * tap Resume):
 *   - "resume" / "carry on" / "continue" / "wake up" / "go on" /
 *     "back to it" / "CertMate, resume" / "CertMate listen"
 *   - any value the regex extractor catches
 *   - the Resume button on this banner
 *   - audio coming back from Deepgram doze (also clears the pause)
 *
 * Copy is deliberately user-language only — no mention of Sonnet, AI
 * internals, API, or backend. The inspector sees a simple hint.
 */
export function ChitchatPauseBanner() {
  const { chitchatPaused, resumeChitchat } = useRecording();
  if (!chitchatPaused) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[var(--app-header-h,56px)] z-30 flex justify-center px-4 pt-2"
    >
      <div
        className="pointer-events-auto flex w-full max-w-[640px] items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-status-processing)]/45 bg-[var(--color-surface-1)] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur"
        style={{ borderWidth: '1.5px' }}
      >
        <PauseCircle
          className="h-6 w-6 shrink-0 text-[var(--color-status-processing)]"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
            AI paused
          </span>
          <span className="text-[12px] text-[var(--color-text-secondary)]">
            Say &lsquo;resume&rsquo;, &lsquo;carry on&rsquo; or a value to wake
          </span>
        </div>
        <button
          type="button"
          aria-label="Resume listening"
          onClick={resumeChitchat}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-blue)] px-4 text-[13px] font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
        >
          Resume
        </button>
      </div>
    </div>
  );
}
