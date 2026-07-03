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
  // WS7 T&Cs signature port — mirrors iOS
  // `UserDefaults["termsAcceptanceSignature"]` (a base64 PNG data URL of
  // the finger/pointer-drawn acceptance signature). Client-side only; no
  // backend write (parent §6.3).
  signature: 'termsAcceptanceSignature',
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
 * Persist acceptance for the current `TERMS_VERSION` together with the
 * acceptance signature — **all-or-nothing**.
 *
 * The signature data URL (a base64 PNG) is much larger than the other
 * three scalar keys, so it is the one write that can realistically throw
 * on a `localStorage` quota/security error. If we wrote `accepted`+
 * `version` first and the signature throw came second, we'd be left with
 * `termsAccepted=true` + version set but NO signature — and
 * `hasAcceptedCurrentTerms()` (which only checks accepted/version) would
 * then permanently bypass the gate with no audit signature on file.
 *
 * To prevent that we (1) write the signature FIRST, then accepted /
 * version / date; (2) wrap ALL FOUR `setItem`s in one try/catch; and (3)
 * on ANY throw, remove all four terms keys and return `false` so the
 * caller does NOT navigate away — the gate simply re-prompts. Returns
 * `true` only when every key persisted.
 *
 * `hasAcceptedCurrentTerms()` intentionally stays accepted/version-only
 * (mirrors iOS `hasAcceptedCurrentVersion`) so existing accepted users do
 * NOT get forced to re-sign on upgrade.
 */
export function recordTermsAcceptance({
  signatureDataUrl,
  now = new Date(),
}: {
  signatureDataUrl: string;
  now?: Date;
}): boolean {
  if (typeof window === 'undefined') return false;
  try {
    // Signature FIRST — it's the largest write and the likely thrower.
    window.localStorage.setItem(TERMS_STORAGE_KEYS.signature, signatureDataUrl);
    window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
    window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
    window.localStorage.setItem(TERMS_STORAGE_KEYS.date, now.toISOString());
    return true;
  } catch {
    // Roll back to a clean "not accepted" state so a partial write can
    // never soft-bypass the gate. Each remove is itself guarded — a
    // storage that throws on write may also throw on remove.
    for (const key of Object.values(TERMS_STORAGE_KEYS)) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // best-effort cleanup; nothing else we can do.
      }
    }
    return false;
  }
}
