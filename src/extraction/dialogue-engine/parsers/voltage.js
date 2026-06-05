/**
 * Test-voltage parser for IR. Common values: 100, 250, 500, 1000.
 * iOS NumberNormaliser already converts spoken "five hundred" → "500"
 * before the transcript reaches the backend, so we only recognise digits.
 *
 * Sanity range 50..2500 — anything outside that is almost certainly a
 * misparse (a circuit reference, a Zs value, etc.) — return null and let
 * the script re-ask.
 */
export function parseVoltage(text) {
  if (typeof text !== 'string') return null;
  // Take the first 2-4 digit integer in the text. IR voltage is always
  // integer (no decimal) and in the hundreds.
  const m = text.match(/\b(\d{2,4})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 50 || n > 2500) return null;
  return String(n);
}
