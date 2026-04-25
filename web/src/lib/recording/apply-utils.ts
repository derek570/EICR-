/**
 * Tiny utilities shared by `apply-extraction.ts`, `apply-rules.ts`, and
 * `field-source.ts`. Lives in its own module so apply-rules can use
 * `hasValue` without creating a circular import on apply-extraction
 * (which itself uses applySonnetValue from apply-rules).
 */

/** Non-empty / non-null check used by the 3-tier priority guards. */
export function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'boolean' || typeof v === 'number') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}
