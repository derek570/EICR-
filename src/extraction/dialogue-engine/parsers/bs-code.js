/**
 * BS/EN standard code parser. Recognises spoken forms an inspector
 * uses for the BS number printed on the device — both with and
 * without the "BS EN" prefix, and tolerating a few common Deepgram
 * normalisations.
 *
 * Canonical output forms match `Constants.swift` ocpdBsEnOptions /
 * rcdBsEnOptions on iOS so the value displays correctly in the UI
 * without further mapping.
 *
 * Recognised codes:
 *   60898  → "BS EN 60898"   (MCB)
 *   61008  → "BS EN 61008"   (RCD)
 *   61009  → "BS EN 61009"   (RCBO — pivots schema)
 *   60947-2/60947 2 → "BS EN 60947-2"   (MCCB)
 *   62606  → "BS EN 62606"   (AFDD)
 *   62423  → "BS EN 62423"   (Type B RCD)
 *   88-2/88 2  → "BS 88-2"   (HRC fuse)
 *   88-3/88 3  → "BS 88-3"
 *   3036   → "BS 3036"       (rewireable fuse)
 *   1361   → "BS 1361"       (cartridge fuse)
 *   4293   → "BS 4293"       (legacy RCD)
 *
 * Order matters: longer / more specific codes are tested first so
 * "60898" doesn't match before "60898-1" or similar future
 * variants. iOS NumberNormaliser already converts spoken numerals
 * to digits before transcripts reach the backend, so the parser
 * only deals with digit forms.
 */

const PATTERNS = [
  // 5-digit codes prefixed by "BS EN" or bare. The trailing "-N"
  // suffix on 60947-2 etc. has to be respected; the regex captures
  // it explicitly so 60947 alone doesn't match.
  { re: /\b60947[-\s]*([23])\b/i, build: (m) => `BS EN 60947-${m[1]}` },
  { re: /\b60898\b/, canonical: 'BS EN 60898' },
  { re: /\b61008\b/, canonical: 'BS EN 61008' },
  { re: /\b61009\b/, canonical: 'BS EN 61009' },
  { re: /\b62606\b/, canonical: 'BS EN 62606' },
  { re: /\b62423\b/, canonical: 'BS EN 62423' },
  // BS 88-2 / 88-3 — accept hyphen, space, or "dash" between the
  // 88 and the suffix digit.
  { re: /\b88[-\s]*(?:dash[-\s]*)?([23])\b/i, build: (m) => `BS 88-${m[1]}` },
  { re: /\b3036\b/, canonical: 'BS 3036' },
  { re: /\b1361\b/, canonical: 'BS 1361' },
  { re: /\b4293\b/, canonical: 'BS 4293' },
];

/**
 * Pre-normalises common Flux artefacts that survive the iOS
 * NumberNormaliser layer when input doesn't go through it (web
 * frontend, tests, future clients). Defensive — iOS NumberNormaliser
 * already collapses these for the iOS path.
 *
 *   1. Letter-splitting: "a b s 60898" / "a. b. s. 60898" → "BS 60898"
 *      and "a b s e n 61009" → "BS EN 61009". Production session
 *      9FC3A6F1 (2026-04-30) — speakers say "BS" but Flux sometimes
 *      emits the letters separately.
 *   2. Zero-word inside digit run: "6 zero 8 9 8" → "60898". Same
 *      session — speakers say "Six zero eight nine eight" naturally;
 *      the standalone-digit-word converter leaves "zero" intact (idiom
 *      guard), and the digit-collapse pass needs zero-word tolerance
 *      to cross it.
 *
 * Tightly scoped — only fires on well-formed digit runs and the
 * three-letter "a b s" pattern, so doesn't corrupt prose containing
 * "abs" / "absolute" / "zero" alone.
 */
function normaliseBsInput(text) {
  // 1. Letter-splitting → "BS" / "BS EN"
  text = text.replace(/\ba\.?\s+b\.?\s+s\.?(?:\s+e\.?\s+n\.?)?(?![a-z])/gi, (m) =>
    m.toLowerCase().includes('e') ? 'BS EN' : 'BS'
  );
  // 2. Zero-word inside digit run → "0", then collapse spaces.
  // Multi-digit tokens are admitted on both ends so partial runs from
  // any upstream collapse re-fold here.
  text = text.replace(/\b\d+(?:\s+(?:\d+|zero|oh|nought|naught))+\b/gi, (m) =>
    m
      .split(/\s+/)
      .map((tok) => {
        const lower = tok.toLowerCase();
        if (lower === 'zero' || lower === 'oh' || lower === 'nought' || lower === 'naught') {
          return '0';
        }
        return tok;
      })
      .join('')
  );
  return text;
}

// Digit-form lookup for fuzzy fallback — derived from PATTERNS above.
// Each entry maps a canonical BS-code string to the digit run an
// inspector would actually dictate (with internal hyphen preserved
// because "60947-2" and "60947-3" are distinct standards). Keep this
// list in sync with PATTERNS.
const FUZZY_TARGETS = [
  { digits: '60947-2', canonical: 'BS EN 60947-2' },
  { digits: '60947-3', canonical: 'BS EN 60947-3' },
  { digits: '60898', canonical: 'BS EN 60898' },
  { digits: '61008', canonical: 'BS EN 61008' },
  { digits: '61009', canonical: 'BS EN 61009' },
  { digits: '62606', canonical: 'BS EN 62606' },
  { digits: '62423', canonical: 'BS EN 62423' },
  { digits: '88-2', canonical: 'BS 88-2' },
  { digits: '88-3', canonical: 'BS 88-3' },
  { digits: '3036', canonical: 'BS 3036' },
  { digits: '1361', canonical: 'BS 1361' },
  { digits: '4293', canonical: 'BS 4293' },
];

/**
 * Levenshtein distance — substitution, insertion, deletion all cost 1.
 * Standard O(m*n) DP with rolling two-row memory. Used by the fuzzy
 * fallback to recover from Deepgram digit drift on BS codes.
 *
 * Production failure that motivated this: session C4467E35 (2026-05-06)
 * inspector said "BS 6898" three times — Deepgram dropped the leading
 * "0" so the strict `\b60898\b` pattern never matched and the engine
 * looped re-asking forever. With Lev-1 fallback "6898" → "60898"
 * (insertion distance 1) → "BS EN 60898".
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/**
 * Fuzzy fallback for BS-code recognition. Extracts the longest digit
 * run from the (already letter-split-normalised) text and compares to
 * every canonical's digit form via Levenshtein-1. Returns the
 * canonical string only if EXACTLY ONE target is at distance ≤ 1 —
 * ambiguity (e.g. "6100" → 61008/61009 tie) falls through so the
 * engine re-asks rather than guessing.
 *
 * Conservative on length: only attempts a match when the candidate
 * has 4-6 digits, ruling out fragments like "6" or single-digit
 * answers that aren't BS codes anyway.
 */
function fuzzyMatchBsCode(text) {
  const m = text.match(/\d[\d-]*\d|\d+/);
  if (!m) return null;
  const candidate = digitsOnly(m[0]);
  if (candidate.length < 4 || candidate.length > 6) return null;
  const matches = FUZZY_TARGETS.filter((t) => levenshtein(candidate, digitsOnly(t.digits)) <= 1);
  if (matches.length === 1) return matches[0].canonical;
  return null;
}

export function parseBsCode(text) {
  if (typeof text !== 'string' || !text) return null;
  const normalised = normaliseBsInput(text);
  for (const p of PATTERNS) {
    const m = normalised.match(p.re);
    if (m) {
      return p.build ? p.build(m) : p.canonical;
    }
  }
  // Fuzzy fallback — single-best Lev-1 match against the canonical
  // digit set. Catches Deepgram digit-drift that the strict patterns
  // above miss (single insertion, deletion, or substitution).
  return fuzzyMatchBsCode(normalised);
}

/**
 * Numeric suffix only — used by the engine's pivot mechanism to
 * decide whether a fresh `ocpd_bs_en` value indicates an RCBO
 * (61009) or a legacy fuse (3036/1361). Returns the bare digit
 * string from the canonical form.
 *
 *   "BS EN 61009"  → "61009"
 *   "BS 3036"      → "3036"
 *   anything else  → null
 */
export function bsCodeDigits(canonical) {
  if (typeof canonical !== 'string') return null;
  const m = canonical.match(/(\d{4,5}(?:-\d)?)/);
  return m ? m[1] : null;
}
