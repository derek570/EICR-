/**
 * T&Cs gate helpers — kept dependency-free so the AppShell can import
 * them without pulling in the `/terms` page's UI module (lucide icons,
 * radix dialog, design-system primitives). The page itself re-exports
 * `hasAcceptedCurrentTerms` for convenience.
 *
 * Storage parity with iOS `TermsAcceptanceView`:
 *   - `termsAccepted` (`"true"` once accepted)
 *   - `termsAcceptedVersion` (matches `TERMS_VERSION` for the active
 *     legal text revision; bumping the version forces re-acceptance)
 *   - `termsAcceptedDate` (ISO 8601 timestamp)
 *
 * **When updating `legal-texts.ts`, bump `TERMS_VERSION` here so every
 * inspector is re-prompted on next mount.**
 */

export const TERMS_VERSION = '1.0';

export const TERMS_STORAGE_KEYS = {
  accepted: 'termsAccepted',
  version: 'termsAcceptedVersion',
  date: 'termsAcceptedDate',
} as const;

/**
 * Returns `true` when the current device has accepted the **current**
 * `TERMS_VERSION`. Returns `false` (a) on first run, (b) if the version
 * has been bumped since acceptance, (c) on the server (no
 * `localStorage`), or (d) when localStorage throws (privacy mode /
 * quota). Treating those edges as "not accepted" is the safer default
 * — the worst case is a re-prompt; the alternative is a soft bypass of
 * the legal gate.
 */
export function hasAcceptedCurrentTerms(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const accepted = window.localStorage.getItem(TERMS_STORAGE_KEYS.accepted);
    if (accepted !== 'true') return false;
    const version = window.localStorage.getItem(TERMS_STORAGE_KEYS.version);
    return version === TERMS_VERSION;
  } catch {
    return false;
  }
}

/**
 * Persist acceptance for the current `TERMS_VERSION`. Best-effort —
 * silently no-ops if `localStorage` throws so a privacy-mode browser
 * doesn't strand the inspector on the gate page. The gate will simply
 * re-prompt next mount, which is acceptable.
 */
export function recordTermsAcceptance(now: Date = new Date()): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
    window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
    window.localStorage.setItem(TERMS_STORAGE_KEYS.date, now.toISOString());
  } catch {
    // see above — intentionally swallowed.
  }
}
