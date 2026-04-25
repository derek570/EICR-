/**
 * Circuit matcher — ported from iOS
 * `Sources/Processing/CircuitMatcher.swift`.
 *
 * Given a freshly-analysed board (from /api/analyze-ccu) and the job's
 * existing circuits, produce a one-to-one assignment of new→old so the
 * Hardware Update flow can preserve test readings on matched circuits.
 *
 * Algorithm (matches iOS 1:1):
 *   1. Score every (new, old) pair by combining three similarity
 *      heuristics:
 *        - Levenshtein distance over a normalised label (30%)
 *        - Jaccard overlap of normalised tokens (30%)
 *        - Semantic group overlap (40%) — maps common UK domestic
 *          synonyms into groups so e.g. "sockets" ≈ "ring final" or
 *          "upstairs" ≈ "first floor".
 *   2. Sort pairs by score descending, then do a greedy one-to-one
 *      assignment with a 0.40 threshold. Any new circuit that doesn't
 *      find a match above threshold becomes `isNew: true`.
 *
 * Normalisation expands common abbreviations (cct → circuit, skts →
 * sockets, ltg → lighting, dn/up → downstairs/upstairs, gf/ff → ground
 * floor / first floor, etc.) and strips filler words (circuit, way,
 * no, number) before tokenising.
 *
 * The `reason` string on each match is human-readable — the web Match
 * Review screen surfaces it as a subtitle so inspectors understand
 * why a pairing was proposed.
 *
 * This module is intentionally framework-free: no React, no DOM, no
 * `@certmate/shared-types` runtime imports. The generic `new/old`
 * types let web callers pass their own circuit shape without
 * plumbing the full `CircuitRow` type through — only `id` and
 * `circuit_designation` / `label` are read.
 */

/** Minimal shape for the "analysed" (new) circuit.
 *  Matches the subset of `CCUAnalysisCircuit` that the matcher reads. */
export interface MatcherNewCircuit {
  circuit_number: number;
  label?: string | null;
}

/** Minimal shape for an existing job circuit.
 *  Matches the subset of `CircuitRow` that the matcher reads. */
export interface MatcherExistingCircuit {
  id: string;
  circuit_designation?: string;
  circuit_ref?: string;
  [key: string]: unknown;
}

export interface CircuitMatch<
  TNew extends MatcherNewCircuit = MatcherNewCircuit,
  TOld extends MatcherExistingCircuit = MatcherExistingCircuit,
> {
  /** The analysed circuit from the new board photo. */
  newCircuit: TNew;
  /** The existing job circuit this new circuit was matched to, or
   *  `null` when no match reached threshold (treat as a brand-new
   *  circuit — no existing readings to preserve). */
  matchedOldCircuit: TOld | null;
  /** 0.0 – 1.0. `1.0` for normalised-exact label; 0 when unmatched. */
  confidence: number;
  /** Short human-readable reason — surfaced in the review UI. */
  matchReason: string;
}

/** Threshold below which a pair is considered unmatched. Mirrors iOS. */
const MATCH_THRESHOLD = 0.4;

/**
 * Match new circuits (from analysis) against existing job circuits.
 * Greedy one-to-one assignment by combined similarity score.
 */
export function matchCircuits<TNew extends MatcherNewCircuit, TOld extends MatcherExistingCircuit>(
  newCircuits: TNew[],
  existingCircuits: TOld[]
): CircuitMatch<TNew, TOld>[] {
  if (existingCircuits.length === 0) {
    return newCircuits.map((c) => ({
      newCircuit: c,
      matchedOldCircuit: null,
      confidence: 0,
      matchReason: 'no existing circuits',
    }));
  }

  // Score every pair.
  const pairs: { ni: number; oi: number; score: number; reason: string }[] = [];
  for (let ni = 0; ni < newCircuits.length; ni++) {
    const newLabel = newCircuits[ni].label ?? '';
    for (let oi = 0; oi < existingCircuits.length; oi++) {
      const oldLabel = existingCircuits[oi].circuit_designation ?? '';
      const { score, reason } = similarityScore(newLabel, oldLabel);
      pairs.push({ ni, oi, score, reason });
    }
  }

  // Sort descending.
  pairs.sort((a, b) => b.score - a.score);

  // Greedy one-to-one assignment above threshold.
  const assignedNew = new Set<number>();
  const assignedOld = new Set<number>();
  const chosen = new Map<number, { oi: number; score: number; reason: string }>();

  for (const p of pairs) {
    if (p.score < MATCH_THRESHOLD) break;
    if (assignedNew.has(p.ni) || assignedOld.has(p.oi)) continue;
    chosen.set(p.ni, { oi: p.oi, score: p.score, reason: p.reason });
    assignedNew.add(p.ni);
    assignedOld.add(p.oi);
  }

  return newCircuits.map((c, ni) => {
    const m = chosen.get(ni);
    if (!m) {
      return {
        newCircuit: c,
        matchedOldCircuit: null,
        confidence: 0,
        matchReason: 'no match above threshold',
      };
    }
    return {
      newCircuit: c,
      matchedOldCircuit: existingCircuits[m.oi],
      confidence: m.score,
      matchReason: m.reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Combined similarity score: Levenshtein (30%) + Jaccard (30%) +
 * semantic group overlap (40%). Exact normalised match short-circuits
 * to 1.0. Returns a human-readable reason for the Review UI.
 */
export function similarityScore(a: string, b: string): { score: number; reason: string } {
  const normA = normaliseLabel(a);
  const normB = normaliseLabel(b);

  if (normA.length > 0 && normA === normB) {
    return { score: 1.0, reason: 'exact label' };
  }

  const lev = levenshteinSimilarity(normA, normB);

  const tokensA = new Set(normA.split(' ').filter(Boolean));
  const tokensB = new Set(normB.split(' ').filter(Boolean));
  let jaccard = 0;
  if (tokensA.size > 0 || tokensB.size > 0) {
    const inter = new Set<string>();
    for (const t of tokensA) if (tokensB.has(t)) inter.add(t);
    const union = new Set<string>([...tokensA, ...tokensB]);
    jaccard = union.size > 0 ? inter.size / union.size : 0;
  }

  const sem = semanticScore(tokensA, tokensB);

  const combined = lev * 0.3 + jaccard * 0.3 + sem * 0.4;

  let reason: string;
  if (sem > 0.5) reason = `fuzzy+semantic: "${a}" ~ "${b}"`;
  else if (jaccard > 0.5) reason = `fuzzy+token: "${a}" ~ "${b}"`;
  else reason = `fuzzy: "${a}" ~ "${b}"`;

  return { score: combined, reason };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ABBREVIATIONS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bckts?\b/g, replacement: 'circuits' },
  { pattern: /\bckct\b/g, replacement: 'circuit' },
  { pattern: /\bcct\b/g, replacement: 'circuit' },
  { pattern: /\bskts?\b/g, replacement: 'sockets' },
  { pattern: /\bsocs?\b/g, replacement: 'sockets' },
  { pattern: /\bltg\b/g, replacement: 'lighting' },
  { pattern: /\blts\b/g, replacement: 'lighting' },
  { pattern: /\bdn\b/g, replacement: 'downstairs' },
  { pattern: /\bup\b/g, replacement: 'upstairs' },
  { pattern: /\bdk\b/g, replacement: 'dark' },
  { pattern: /\bgnd\b/g, replacement: 'ground' },
  { pattern: /\bff\b/g, replacement: 'first floor' },
  { pattern: /\bgf\b/g, replacement: 'ground floor' },
  { pattern: /\bhw\b/g, replacement: 'hot water' },
  { pattern: /\bfcu\b/g, replacement: 'fused spur' },
];

const FILLER_WORDS = new Set(['circuit', 'cct', 'way', 'no', 'number']);

/** Lowercase, strip punctuation, expand abbreviations, drop fillers. */
export function normaliseLabel(label: string): string {
  let s = label.toLowerCase().trim();
  // Replace non-alphanumeric with space (keeps word boundaries intact).
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  for (const { pattern, replacement } of ABBREVIATIONS) {
    s = s.replace(pattern, replacement);
  }
  s = s
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .join(' ')
    .trim();
  return s;
}

// ---------------------------------------------------------------------------
// Semantic matching
// ---------------------------------------------------------------------------

const SEMANTIC_GROUPS: string[][] = [
  ['sockets', 'socket', 'ring', 'power', 'socket outlet', 'ring final'],
  ['lighting', 'lights', 'light'],
  ['upstairs', 'first floor', '1st floor'],
  ['downstairs', 'ground floor'],
  ['cooker', 'oven', 'hob', 'kitchen'],
  ['shower', 'electric shower'],
  ['immersion', 'immersion heater', 'hot water', 'water heater'],
  [
    'smoke',
    'detector',
    'alarm',
    'smoke detectors',
    'smoke alarms',
    'smoke alarm',
    'fire alarms',
    'afd',
  ],
  ['garage', 'outbuilding', 'shed'],
  ['spur', 'fused spur'],
];

const WORD_TO_GROUP: Map<string, number> = (() => {
  const m = new Map<string, number>();
  SEMANTIC_GROUPS.forEach((group, gi) => {
    for (const phrase of group) {
      // Add the whole phrase so normalisation that preserves it still hits.
      m.set(phrase, gi);
      for (const token of phrase.split(' ')) {
        if (token) m.set(token, gi);
      }
    }
  });
  return m;
})();

function semanticScore(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const groupsA = new Set<number>();
  const groupsB = new Set<number>();
  for (const t of tokensA) {
    const gi = WORD_TO_GROUP.get(t);
    if (gi != null) groupsA.add(gi);
  }
  for (const t of tokensB) {
    const gi = WORD_TO_GROUP.get(t);
    if (gi != null) groupsB.add(gi);
  }
  if (groupsA.size === 0 && groupsB.size === 0) return 0;
  const inter = new Set<number>();
  for (const g of groupsA) if (groupsB.has(g)) inter.add(g);
  const union = new Set<number>([...groupsA, ...groupsB]);
  return union.size > 0 ? inter.size / union.size : 0;
}

// ---------------------------------------------------------------------------
// Levenshtein
// ---------------------------------------------------------------------------

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
