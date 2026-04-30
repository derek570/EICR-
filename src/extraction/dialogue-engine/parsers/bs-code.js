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

export function parseBsCode(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      return p.build ? p.build(m) : p.canonical;
    }
  }
  return null;
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
