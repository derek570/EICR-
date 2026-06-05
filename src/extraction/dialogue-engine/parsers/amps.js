/**
 * Amperage parser for OCPD ratings (ocpd_rating_a). Inspector
 * usually says "32 amps" / "32A" / "32" — bare integer, optionally
 * followed by an amps unit word.
 *
 * Standard MCB ratings: 6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125 amps.
 * Standard fuse ratings: 5, 15, 30, 45, 60, 80, 100 (rewireable BS 3036).
 * The parser doesn't enforce a whitelist — it accepts any positive
 * integer in a reasonable range (1..1000) — the schema validator
 * downstream is the right place for the canonical-set check.
 *
 * Returns the integer as a string (matching iOS Circuit model's
 * String storage of `ocpdRatingA`). Null on no match.
 */
export function parseAmps(text) {
  if (typeof text !== 'string' || !text) return null;
  // First integer in the text. The schema's namedExtractor regex
  // typically captures the value group already; bare-value fallback
  // path passes the raw transcript and we extract the first int.
  const m = text.match(/\b(\d{1,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  return String(n);
}
