/**
 * RCD waveform-type parser. Returns one of the canonical iOS
 * `rcdTypes` values: "AC", "A", "F", "B", "S", "N/A".
 *
 * Recognised forms (case-insensitive):
 *   "AC" / "type AC"            → "AC"
 *   "A" / "type A"              → "A"
 *   "F" / "type F"              → "F"
 *   "B" / "type B"              → "B"   (note: same letter as MCB
 *                                        curve B — the schema slot
 *                                        decides which parser runs,
 *                                        so collision is harmless)
 *   "S" / "selective"           → "S"
 *   "N/A" / "not applicable"    → "N/A"
 *
 * Standalone letter "B" is accepted only as a one-word reply (start
 * or end of utterance). Same anchoring as the MCB-type parser.
 */

const PATTERNS = [
  // "type X" prefix forms — most explicit.
  { re: /\btype\s*AC\b/i, canonical: 'AC' },
  { re: /\btype\s*([AFB])\b/i, build: (m) => m[1].toUpperCase() },
  { re: /\btype\s*S\b/i, canonical: 'S' },
  // "AC" — needs to be tested before bare "A".
  { re: /\bAC\b/, canonical: 'AC' },
  { re: /\bselective\b/i, canonical: 'S' },
  { re: /\bnot\s+applicable\b/i, canonical: 'N/A' },
  { re: /\bN[/\s]*A\b/, canonical: 'N/A' },
  // Standalone letter as one-word reply.
  { re: /^\s*([AFBS])\s*\.?\s*$/i, build: (m) => m[1].toUpperCase() },
];

export function parseRcdType(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      return p.build ? p.build(m) : p.canonical;
    }
  }
  return null;
}
