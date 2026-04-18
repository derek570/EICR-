/**
 * Shared formatting helpers.
 *
 * Extracted for Wave 3b (D11) from three copies that had been hand-duplicated
 * across the Phase 6c admin pages:
 *   - web/src/app/settings/admin/users/page.tsx
 *   - web/src/app/settings/admin/users/[userId]/page.tsx
 *   - web/src/app/settings/company/dashboard/page.tsx
 *
 * All three copies were byte-identical (only a trailing comment differed in one
 * — the comment is preserved here, not duplicated at the call sites).
 */

/**
 * Short human-readable date — "12 Apr" this year, "12 Apr 2024" if not.
 *
 * Returns '' for null/undefined so call sites can use template concatenation
 * without needing to guard every property access. If `Date` construction or
 * `toLocaleDateString` throws (e.g. malformed string), falls back to the raw
 * ISO rather than propagating the error — the surrounding row should still
 * render even if one timestamp is dodgy.
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch {
    return iso;
  }
}
