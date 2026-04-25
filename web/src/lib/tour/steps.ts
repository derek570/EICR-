/**
 * Hardcoded dashboard tour steps (Phase 3).
 *
 * Minimal 4-step walkthrough of the primary landing surface, mirroring
 * the iOS dashboard-phase tour's spirit without porting every step —
 * the job-detail phase of the iOS tour is out of scope for this wave
 * (revisit in Phase 5/6 once the recording flow has settled parity).
 *
 * Each step carries:
 *   - `id` — stable slug, used as the key for optional TTS narration
 *     lookups (backend endpoint check on mount decides whether to
 *     attempt audio).
 *   - `selector` — CSS selector resolved via
 *     `document.querySelector` when the highlight mounts. If the
 *     target isn't present (the user navigated away mid-tour), the
 *     overlay gracefully degrades to a centred tip with no spotlight.
 *   - `title` / `body` — tip copy rendered next to the spotlight.
 *   - `placement` — where the tip should float relative to the
 *     target. Defaults to `'bottom'`; we only override when a
 *     specific target would be clipped.
 *
 * The selectors rely on `data-tour` attributes we inject on the
 * dashboard. Using data attributes (not ids/classNames) keeps the
 * tour decoupled from the dashboard's visual classes, so refactors
 * there don't silently break the walkthrough.
 */

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface TourStep {
  id: string;
  selector: string | null;
  title: string;
  body: string;
  placement?: TourPlacement;
}

export const DASHBOARD_TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: 'welcome',
    selector: '[data-tour="hero"]',
    title: 'Welcome to CertMate',
    body: 'This is your dashboard — active work, completed jobs, and anything expiring soon all live here.',
    placement: 'bottom',
  },
  {
    id: 'start',
    selector: '[data-tour="start-eicr"]',
    title: 'Start a certificate',
    body: 'Tap EICR for a periodic inspection or EIC for a new install. You can switch certificate types inside the job.',
    placement: 'bottom',
  },
  {
    id: 'setup',
    selector: '[data-tour="setup-tools"]',
    title: 'Setup and tools',
    body: 'Company branding, your team, settings, and this tour — all one tap away when you need them.',
    placement: 'top',
  },
  {
    id: 'alerts',
    selector: '[data-tour="alerts-bell"]',
    title: 'Alerts',
    body: 'The bell surfaces jobs that need attention — failed states, in-progress work, and recently completed certificates.',
    placement: 'bottom',
  },
]);

export const DASHBOARD_TOUR_TOTAL = DASHBOARD_TOUR_STEPS.length;
