/**
 * MCB curve / OCPD type parser. Returns one of the canonical iOS
 * `ocpdTypes` values: "B", "C", "D", "1", "2", "gG", "gM", "HRC",
 * "Rew".
 *
 * Recognised forms (case-insensitive):
 *   "B" / "B curve" / "type B" / "B-curve"  → "B"
 *   "C" / "C curve" / "type C"               → "C"
 *   "D" / "D curve" / "type D"               → "D"
 *   "rewireable" / "Rew"                     → "Rew"
 *   "HRC" / "high rupturing capacity"        → "HRC"
 *   "gG" / "g G"                             → "gG"
 *   "gM"                                     → "gM"
 *   "type 1" / "1"                           → "1"
 *   "type 2" / "2"                           → "2"
 *
 * Bare letters are accepted only if surrounded by whitespace /
 * punctuation. "B" alone in the middle of a longer sentence is
 * intentionally NOT enough — the inspector usually says "type B" or
 * "B curve". This avoids mis-firing on words like "be" or "by".
 */

const PATTERNS = [
  // Explicit "type X" / "X curve" / "X-curve" prefix forms.
  { re: /\btype\s*([BCD])\b/i, build: (m) => m[1].toUpperCase() },
  { re: /\b([BCD])[-\s]*curve\b/i, build: (m) => m[1].toUpperCase() },
  { re: /\bcurve\s*([BCD])\b/i, build: (m) => m[1].toUpperCase() },
  // Class words.
  // "rewireable" / "rewirable" / "re-wireable" / "re wirable".
  // Vowel between "wir" and "ble" is optional/variable.
  { re: /\bre[-\s]?wir[ea]+ble\b/i, canonical: 'Rew' },
  { re: /\bRew\b/, canonical: 'Rew' },
  { re: /\bHRC\b/i, canonical: 'HRC' },
  { re: /\bhigh[\s-]*rupturing[\s-]*capacity\b/i, canonical: 'HRC' },
  { re: /\bg\s*G\b/, canonical: 'gG' },
  { re: /\bg\s*M\b/, canonical: 'gM' },
  // Numeric classes — restricted to "type N" form only so we don't
  // mis-fire on amp ratings like "32 amp" landing as type "32".
  { re: /\btype\s*([12])\b/i, build: (m) => m[1] },
  // Standalone curve letters at start or end of utterance (e.g.,
  // a one-word reply "B." to "What MCB curve?"). Must be
  // surrounded by anchors / punctuation, NOT mid-sentence.
  { re: /^\s*([BCD])\s*\.?\s*$/i, build: (m) => m[1].toUpperCase() },
];

export function parseMcbType(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      return p.build ? p.build(m) : p.canonical;
    }
  }
  return null;
}
