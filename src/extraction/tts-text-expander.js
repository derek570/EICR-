/**
 * tts-text-expander.js — server-side mirror of iOS
 * AlertManager.expandForTTS.
 *
 * Loaded Barrel Phase 0 (plan v6 §B5). The speculator synthesises
 * confirmation audio BEFORE iOS asks for it; the cache key must be a
 * string both ends compute identically. iOS sends the POST body
 * already-expanded (CertMateUnified Sources/Recording/AlertManager.swift
 * line ≈1082: `proxyElevenLabsTTS(text: expanded, …)`), so the
 * speculator hashes its OWN expanded text and the backend short-circuit
 * hashes the iOS POST body verbatim. The two hashes match iff the
 * speculator's expansion is byte-for-byte identical to iOS's.
 *
 * Source of truth: CertMateUnified Sources/Recording/AlertManager.swift
 *   - `ttsReplacements` array (lines 932-977)
 *   - `expandForTTS` (lines 986-995)
 *   - `expandNumbers` (lines 1001-1027)
 *
 * IF YOU CHANGE THIS FILE: update iOS AlertManager.swift in the SAME
 * commit (or vice versa). The parity tests at
 * `src/__tests__/tts-text-expander-parity.test.js` will fail-fast if
 * the two drift on any of the pinned fixtures, but only an iOS test
 * pass actually verifies the Swift side.
 *
 * Why the unicode patterns (MΩ, mΩ, Ω) are kept even though `\b` is
 * ASCII-only in both Swift NSRegularExpression and JS RegExp: parity
 * over functionality. The bundler doesn't emit unicode units (it
 * substitutes friendly names like 'Zs' and 'IR L to E'), so these
 * patterns are inert on the production path in BOTH runtimes. Removing
 * them here without also removing them from iOS would break parity if
 * some other code path ever feeds them unicode text.
 */

/**
 * Bump on every edit to either REPLACEMENTS or expandNumbers, in tandem
 * with the iOS side. iOS Phase 4b adds a `Bundle.expandForTTSVersion`
 * resource hashed from the same source list; the keys.js short-circuit
 * compares the version header from the iOS POST against this constant
 * to skip lookup when versions drift (parity_mismatch telemetry).
 * Format: ISO date of edit, allowing alphanumeric suffix for same-day
 * iterations ("2026-05-24a", "2026-05-24b").
 */
export const EXPANDER_VERSION = '2026-06-25';

const REPLACEMENTS = Object.freeze([
  // Impedance values — compound patterns FIRST so `\bZe\/Zs\b` wins
  // over `\bZe\b` + `\bZs\b` on input "Ze/Zs".
  [/\bZe\/Zs\b/g, 'zed E over zed S'],
  [/\bze\/zs\b/g, 'zed E over zed S'],
  [/\bZe\b/g, 'zed E'],
  [/\bze\b/g, 'zed E'],
  [/\bZs\b/g, 'zed S'],
  [/\bzs\b/g, 'zed S'],
  // Units — "megger ohms" is the spoken trade term.
  [/mm²/g, 'millimetres squared'],
  [/mm2\b/g, 'millimetres squared'],
  [/\bMΩ\b/g, 'megger ohms'],
  [/\bmΩ\b/g, 'milli ohms'],
  [/\bmegohms\b/g, 'megger ohms'],
  [/\bmega ohms\b/g, 'megger ohms'],
  [/\bmilliohms\b/g, 'milli ohms'],
  [/\bkA\b/g, 'kilo amps'],
  [/\bΩ\b/g, 'ohms'],
  [/\bms\b/g, 'milliseconds'],
  // Greater-than: capture trailing whitespace + drop it (the literal
  // 'greater than ' replacement contributes its own trailing space).
  [/>(\s*)/g, 'greater than '],
  // Circuit protection abbreviations
  [/\bRCD\b/g, 'R C D'],
  [/\brcd\b/g, 'R C D'],
  [/\bRCBO\b/g, 'R C B O'],
  [/\brcbo\b/g, 'R C B O'],
  [/\bMCB\b/g, 'M C B'],
  [/\bmcb\b/g, 'M C B'],
  [/\bSPD\b/g, 'S P D'],
  [/\bBSEN\b/g, 'B S E N'],
  [/\bBS\s*EN\b/g, 'B S E N'],
  [/\bBS\s*7671\b/g, 'B S 7671'],
  // Electrical formulae — compound R1+R2 first.
  [/\bR1\+R2\b/g, 'R1 plus R2'],
  [/\bR2\b/g, 'R 2'],
  [/\bR1\b/g, 'R 1'],
  // Earthing systems
  [/\bTN-C-S\b/g, 'T N C S'],
  [/\bTN-S\b/g, 'T N S'],
  [/\bTT\b/g, 'T T'],
  [/\bPME\b/g, 'P M E'],
  // Electrical "live" pronounced as "lyve" (alive, long-i /laɪv/), not "liv".
  // 2026-06-25 (field session 6674E8C5): ElevenLabs mispronounced the previous
  // "lyve" respelling, so the inspector heard a wrong "live-to-live". Switched
  // to "lighv" — the "igh" grapheme (as in high/light/night) is the single most
  // reliable long-i cue in English orthography. ⚠️ This string MUST stay
  // byte-identical with iOS AlertManager.swift (the Loaded Barrel speculator
  // keys the TTS cache on the expanded text). NEEDS AN EAR-CHECK against the
  // live ElevenLabs voice; alternatives if it's still off: "lyv", "lyev".
  [/\blive\b/g, 'lighv'],
]);

const DIGIT_WORDS = Object.freeze([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
]);

/**
 * Mirror of iOS `expandNumbers` (AlertManager.swift:1001-1027).
 *
 *   Decimals (any digits.digits): "0.35" → "zero point three five"
 *   Integers with 4+ digits:      "1234" → "one two three four"
 *   Small integers (1-3 digits) pass through (TTS reads them naturally,
 *   "200" → "two hundred").
 */
function expandNumbers(text) {
  // Pattern matches the Swift regex \b(\d+)\.(\d+)\b|\b(\d{4,})\b
  // exactly. JS replace with function callback selects which alt
  // matched by which capture group is defined.
  const re = /\b(\d+)\.(\d+)\b|\b(\d{4,})\b/g;
  return text.replace(re, (match, whole, frac, intMatch) => {
    if (whole !== undefined && frac !== undefined) {
      const wholeSpoken = Array.from(whole, (d) => DIGIT_WORDS[Number(d)]).join(' ');
      const fracSpoken = Array.from(frac, (d) => DIGIT_WORDS[Number(d)]).join(' ');
      return `${wholeSpoken} point ${fracSpoken}`;
    }
    if (intMatch !== undefined) {
      return Array.from(intMatch, (d) => DIGIT_WORDS[Number(d)]).join(' ');
    }
    return match;
  });
}

/**
 * Expand the EICR/EIC TTS abbreviations + numbers, returning the
 * string the speculator should hand to ElevenLabs (and the string
 * iOS will send in the POST body for cache lookup).
 *
 * Null / undefined input returns the empty string — matches iOS's
 * `String` parameter semantics (Swift `String` is non-optional in the
 * call site so iOS never passes nil, but the JS caller may).
 */
export function expandForTTS(text) {
  if (text == null) return '';
  let result = String(text);
  for (const [re, rep] of REPLACEMENTS) {
    // Each regex has the /g flag → all occurrences replaced in a single
    // call, matching Swift's `stringByReplacingMatches(in:, range:,
    // withTemplate:)` with an NSRange covering the whole string.
    result = result.replace(re, rep);
  }
  result = expandNumbers(result);
  // item #7 (session DFCE2145, 2026-06-23) — append a terminating period when
  // the expanded text ends on a bare digit (e.g. "R C D time 28", "9 points"
  // would NOT — it ends on the noun). ElevenLabs renders utterance-final bare
  // numerals unreliably (clipped/rushed prosody — the reported "…points 9"
  // garble); an explicit end-of-sentence cue fixes the prosody. Decimals are
  // already expanded to words ("zero point six two") so they don't end in a
  // digit and are untouched. MUST stay byte-identical with iOS
  // AlertManager.expandForTTS — the speculator pre-synth text and the iOS
  // cache-lookup POST body must match.
  return /\d$/.test(result) ? `${result}.` : result;
}

/** Exported for parity-test introspection only. Do not depend on the
 *  shape from production code — these internals can change as iOS's
 *  rules evolve. */
export const _internals = Object.freeze({
  REPLACEMENTS,
  DIGIT_WORDS,
  expandNumbers,
});
