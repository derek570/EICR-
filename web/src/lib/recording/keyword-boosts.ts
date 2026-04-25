/**
 * Deepgram Nova-3 keyterm prompt generator — port of iOS
 * `KeywordBoostGenerator.swift` + the `keyword_boosts` block of
 * `CertMateUnified/Sources/Resources/default_config.json`.
 *
 * Why: iOS's recording pipeline sends ~89 boost-scored Nova-3 `keyterm`
 * URL params on every WebSocket connect. They massively improve
 * recognition of electrical jargon ("Zs", "R1 plus R2", "MICC",
 * "ring continuity") that Nova-3's general English model would
 * otherwise mishear. Pre-port the web client sent zero keyterms —
 * recording quality on web for inspectors saying "five point seven six
 * megohms" was demonstrably worse than iOS for the same audio.
 *
 * Boost tiers (verbatim from the iOS comment):
 *   - 2.0–3.0: critical measurement / outcome terms (Zs, Ze, R1, R2,
 *     R1+R2, megohms, LIM, observation codes)
 *   - 1.5: vocabulary, common breaker types, board manufacturers, RCD
 *     ratings, detected switch types
 *   - 1.0: circuit labels, circuit numbers, general terms
 *
 * URL-length budget: Deepgram's HTTP→WS upgrade rejects URLs over
 * ~2048 chars. iOS uses 1800 as the practical safety cap; we match.
 *
 * Boost-suffix optimisation: Deepgram interprets a bare keyterm
 * (`?keyterm=foo`) at the model's default boost intensity, and a
 * suffixed keyterm (`?keyterm=foo:3.0`) at the supplied multiplier.
 * iOS's optimisation: only append `:X.X` for top-tier (≥3.0) keywords.
 * Lower-tier keywords still benefit from being a keyterm at all; the
 * suffix saves ~4 chars per word, freeing significant URL space for
 * more keyterms. We carry the same convention here so behaviour
 * matches iOS at the URL byte level.
 *
 * If iOS ever changes either constant — `MAX_KEYTERMS` (100) or the
 * URL budget (1800) — keep them in lockstep with this file.
 */

/**
 * Baseline electrical vocabulary boost table — ported verbatim from
 * `default_config.json#keyword_boosts.base_electrical`. Order is not
 * meaningful (the `dedupAndCap` step sorts by boost desc + alpha for
 * stability).
 */
const BASE_KEYWORD_BOOSTS: Record<string, number> = {
  CertMate: 3.0,
  'cert mate': 3.0,
  megohms: 3.0,
  Zs: 2.0,
  Ze: 2.0,
  Zeddy: 2.0,
  'Zed e': 2.0,
  RCD: 1.5,
  RCBO: 1.5,
  MCB: 1.5,
  AFDD: 1.5,
  R1: 2.0,
  R2: 2.0,
  Rn: 1.5,
  CPC: 1.5,
  'R1 plus R2': 3.0,
  'loop impedance': 1.5,
  'insulation resistance': 2.5,
  insulation: 1.5,
  'ring continuity': 2.0,
  lives: 1.5,
  neutrals: 1.5,
  earths: 2.0,
  'live to live': 2.0,
  'live to earth': 2.0,
  'live to neutral': 1.5,
  'greater than': 2.0,
  'test voltage': 1.5,
  radial: 1.0,
  spur: 1.0,
  polarity: 1.0,
  'push button': 1.5,
  'push button works': 2.0,
  'trip time': 1.5,
  megger: 1.5,
  'earth fault': 1.5,
  continuity: 1.5,
  milliamps: 1.0,
  milliseconds: 1.0,
  circuit: 3.0,
  'nought point': 1.5,
  nought: 2.0,
  'main earth': 1.5,
  tails: 2.0, // iOS lists "tails" twice (1.5 then 2.0) — dedup keeps the higher.
  'meter tails': 1.5,
  bonding: 1.5,
  earthing: 2.0,
  'TN-C-S': 3.0,
  'TN-C': 2.0,
  'TN-S': 3.0,
  TT: 1.5,
  PME: 1.5,
  'prospective fault current': 1.5,
  PFC: 1.5,
  'supply voltage': 1.5,
  volts: 1.0,
  frequency: 1.5,
  hertz: 1.5,
  'type B': 1.5,
  'type C': 1.5,
  'number of points': 1.5,
  smokes: 1.5,
  'smoke detectors': 1.5,
  'cable size': 1.5,
  'circuit number': 1.5,
  upstairs: 1.0,
  downstairs: 1.0,
  wiring: 2.0,
  'reference method': 2.0,
  MICC: 2.5,
  'mineral insulated': 2.5,
  pyro: 2.0,
  FP200: 2.0,
  SWA: 2.0,
  XLPE: 2.0,
  armoured: 1.5,
  conduit: 1.5,
  trunking: 1.5,
  discontinuous: 2.5,
  'open circuit': 2.5,
  infinity: 2.0,
  correction: 1.5,
  'N/A': 2.5,
  LIM: 3.0,
  limitation: 2.5,
  debug: 2.0,
  observation: 2.5,
  C1: 2.0,
  C2: 2.0,
  C3: 2.0,
  FI: 1.5,
  'code 1': 1.5,
  'code 2': 1.5,
  'code 3': 1.5,
  'danger present': 1.5,
  'potentially dangerous': 1.5,
  'improvement recommended': 1.5,
  'further investigation': 1.5,
  defect: 1.5,
  postcode: 1.5,
  customer: 1.5,
  client: 1.5,
  address: 1.5,
  'in tails': 2.0,
  DB: 1.5,
  'distribution board': 1.5,
  'Zs for': 2.0,
  'R1 plus R2 for': 2.0,
  'live to earth for': 2.0,
  'live to live for': 2.0,
  'number of points for': 1.5,
  'trip time for': 1.5,
};

const BOARD_TYPE_BOOSTS: Record<string, number> = {
  Hager: 1.5,
  Elucian: 1.5,
  BG: 1.5,
  Wylex: 1.5,
  MK: 1.5,
  Schneider: 1.5,
  Fusebox: 1.5,
  Crabtree: 1.5,
};

/**
 * Hard cap on keyterm count. iOS uses 100 but iOS's base config is
 * "87+8=95" entries (per its `_budget_note`) so iOS rarely hits the
 * cap. Web's base config is larger (~113 base + 8 board after recent
 * additions) which means at MAX=100 the URL-byte budget (1800 chars)
 * becomes the second cap, dropping the alpha-tail of the keyterm
 * list — including the analysis-reserved slots in some scenarios.
 *
 * Lowering MAX to 85 puts the keyterm-count cap below the URL-byte
 * cap so the analysis-reserved-slot policy actually delivers what it
 * advertises. Net Deepgram recognition impact is minor — the dropped
 * 15 entries are the alpha-tail of base 1.5 terms (mostly the second-
 * tier observation codes and "for"-suffixed hint phrases), not the
 * primary-recognition vocabulary.
 *
 * Codex review on `e38fa5e` flagged the user-facing miss; this
 * constant + the analysis-first sort tie-break together resolve it.
 */
const MAX_KEYTERMS = 85;
const TOP_TIER_BOOST_THRESHOLD = 3.0;
const URL_LENGTH_BUDGET = 1800;
/**
 * Slots reserved at the bottom of the cap for analysis-derived
 * keyterms (board model, parsed label words, "circuit N" refs,
 * "surge protection"). All of those are 1.0-boost — under a pure
 * boost-desc sort they lose every slot to the dozen-odd 1.0-tier
 * base entries (radial, spur, polarity, milliamps, milliseconds,
 * upstairs, downstairs, etc.) and never reach the URL.
 *
 * This is a deliberate, small divergence from iOS's strict
 * boost-desc cap. iOS's `KeywordBoostGenerator` has the same latent
 * issue but iOS's base config is shorter (the inline `_budget_note`
 * in `default_config.json` says "87 base + 8 board" — written when
 * the list was smaller than today's 113 entries). Reserving 10
 * slots restores the user-facing "CCU augmentation surfaces in the
 * Deepgram URL" behaviour that the keyterm port is meant to deliver.
 *
 * Codex review finding on commit `e38fa5e`: "1.0 CCU-derived
 * keyterms are deterministically removed by the existing 100-term
 * cap". This is the structural fix.
 */
const ANALYSIS_RESERVED_SLOTS = 10;

/**
 * Lightweight subset of `CCUAnalysis` (web-side wire shape) that
 * `generateKeyterms` needs. Inlined here so the keyword module has no
 * dependency on `@/lib/types` (avoids a recording → types → recording
 * import cycle if anyone reorganises later).
 */
export interface CcuAnalysisLite {
  board_manufacturer?: string | null;
  board_model?: string | null;
  main_switch_type?: string | null;
  spd_present?: boolean;
  circuits?: Array<{
    circuit_number?: number;
    label?: string | null;
    ocpd_type?: string | null;
    is_rcbo?: boolean;
    rcd_protected?: boolean;
    rcd_rating_ma?: string | null;
  }>;
}

export interface KeytermBoost {
  keyword: string;
  boost: number;
}

/**
 * Generate the full keyterm list. If `analysis` is provided, board-
 * specific terms (manufacturer, model, OCPD types found, SPD/main-
 * switch presence, label terms, circuit numbers, RCD ratings) are
 * appended on top of the base + board-type tables. The final list is
 * deduped (case-insensitive, keeping the highest boost), sorted by
 * boost desc then alphabetically, and capped at `MAX_KEYTERMS`.
 *
 * Mirrors iOS `KeywordBoostGenerator.generate(from:)` and
 * `generateFromConfig()` byte-for-byte where the input shapes line up.
 */
export function generateKeyterms(analysis?: CcuAnalysisLite | null): KeytermBoost[] {
  const baseBoosts: KeytermBoost[] = [];

  for (const [keyword, boost] of Object.entries(BASE_KEYWORD_BOOSTS)) {
    baseBoosts.push({ keyword, boost });
  }
  for (const [keyword, boost] of Object.entries(BOARD_TYPE_BOOSTS)) {
    baseBoosts.push({ keyword, boost });
  }

  // Track analysis-derived terms separately so the cap-allocation step
  // below can reserve `ANALYSIS_RESERVED_SLOTS` for them. Dedup here
  // is against the *base* set (so a base "Hager" still wins over a
  // CCU "Hager"); the cross-cut between the two pools happens in the
  // final dedupAndCap step.
  const analysisBoosts: KeytermBoost[] = [];

  if (analysis) {
    const baseSeen = new Set(baseBoosts.map((b) => b.keyword.toLowerCase()));
    const analysisSeen = new Set<string>();
    const isNovel = (lc: string): boolean => !baseSeen.has(lc) && !analysisSeen.has(lc);

    // 1. Board manufacturer (if novel, i.e. not already in the
    //    board-type table).
    pushAnalysisIfNovel(analysisBoosts, analysisSeen, isNovel, analysis.board_manufacturer, 1.5);

    // 2. Board model — distinct boost so we don't dupe the manufacturer.
    pushAnalysisIfNovel(analysisBoosts, analysisSeen, isNovel, analysis.board_model, 1.0);

    // 3. OCPD types found across circuits — strong (2.0) because they're
    //    measurement-context terms the inspector says often.
    for (const ocpd of extractOcpdTypes(analysis.circuits ?? [])) {
      const lc = ocpd.toLowerCase();
      if (isNovel(lc)) {
        analysisBoosts.push({ keyword: ocpd, boost: 2.0 });
        analysisSeen.add(lc);
      }
    }

    // 4. SPD-related vocabulary if SPD is present on the board.
    if (analysis.spd_present === true && isNovel('spd')) {
      analysisBoosts.push({ keyword: 'SPD', boost: 1.5 });
      analysisSeen.add('spd');
      if (isNovel('surge protection')) {
        analysisBoosts.push({ keyword: 'surge protection', boost: 1.0 });
        analysisSeen.add('surge protection');
      }
    }

    // 5. Main switch type if detected.
    pushAnalysisIfNovel(analysisBoosts, analysisSeen, isNovel, analysis.main_switch_type, 1.5);

    // 6. Label terms parsed out of circuit labels.
    for (const term of extractLabelTerms(analysis.circuits ?? [])) {
      const lc = term.toLowerCase();
      if (isNovel(lc)) {
        analysisBoosts.push({ keyword: term, boost: 1.0 });
        analysisSeen.add(lc);
      }
    }

    // 7. "circuit N" references — useful when the inspector says
    //    "circuit twelve" mid-test.
    for (const circuit of analysis.circuits ?? []) {
      if (typeof circuit.circuit_number === 'number') {
        const ref = `circuit ${circuit.circuit_number}`;
        const lc = ref.toLowerCase();
        if (isNovel(lc)) {
          analysisBoosts.push({ keyword: ref, boost: 1.0 });
          analysisSeen.add(lc);
        }
      }
    }

    // 8. RCD ratings spoken either way ("30 milliamp" / "30mA").
    for (const rating of extractRcdRatings(analysis.circuits ?? [])) {
      const lc = rating.toLowerCase();
      if (isNovel(lc)) {
        analysisBoosts.push({ keyword: rating, boost: 1.5 });
        analysisSeen.add(lc);
      }
    }
  }

  return mergeBaseAndAnalysisWithReservedSlots(baseBoosts, analysisBoosts);
}

/**
 * Combine base + analysis pools into the final cap. Base entries get
 * `MAX_KEYTERMS - ANALYSIS_RESERVED_SLOTS` slots (sorted boost desc →
 * alpha); analysis entries get the rest (same sort within their pool).
 *
 * The combined output is sorted boost desc, then *analysis-first*
 * within each boost tier, then alphabetically. The analysis-first
 * tie-break is essential because the URL appender then walks this
 * list in order and stops at the 1800-char budget — without it, base
 * 1.0 entries (radial, spur, polarity, etc.) would consume the URL
 * tail and analysis 1.0 entries (Kitchen, "circuit 7") would never
 * be appended even though they survived the keyterm cap. iOS has
 * the same latent issue but doesn't have a public-facing claim that
 * CCU augmentation surfaces in the URL — we do.
 */
function mergeBaseAndAnalysisWithReservedSlots(
  base: KeytermBoost[],
  analysis: KeytermBoost[]
): KeytermBoost[] {
  if (analysis.length === 0) return dedupAndCap(base, MAX_KEYTERMS);

  const reserved = Math.min(ANALYSIS_RESERVED_SLOTS, analysis.length);
  const baseBudget = MAX_KEYTERMS - reserved;

  const baseCapped = dedupAndCap(base, baseBudget).map((b) => ({ ...b, _isAnalysis: false }));
  const analysisCapped = dedupAndCap(analysis, reserved).map((b) => ({
    ...b,
    _isAnalysis: true,
  }));

  // Dedup base/analysis collision (rare), then sort with the analysis-
  // first tie-break and strip the internal flag.
  const merged = new Map<string, KeytermBoost & { _isAnalysis: boolean }>();
  for (const entry of [...baseCapped, ...analysisCapped]) {
    const key = entry.keyword.toLowerCase();
    const existing = merged.get(key);
    // Higher boost wins; analysis wins ties (so a base 1.5 collision
    // with an analysis 1.5 retains the analysis-priority sort key).
    if (
      !existing ||
      entry.boost > existing.boost ||
      (entry.boost === existing.boost && entry._isAnalysis && !existing._isAnalysis)
    ) {
      merged.set(key, entry);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => {
      if (a.boost !== b.boost) return b.boost - a.boost;
      // Analysis-first within tier — this is the URL-appender priority.
      if (a._isAnalysis !== b._isAnalysis) return a._isAnalysis ? -1 : 1;
      return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0;
    })
    .slice(0, MAX_KEYTERMS)
    .map(({ keyword, boost }) => ({ keyword, boost }));
}

/**
 * Append `keyterm` URL params to an existing `URLSearchParams`, in
 * boost-descending order, until the projected URL length would exceed
 * `URL_LENGTH_BUDGET`. Top-tier (≥`TOP_TIER_BOOST_THRESHOLD`) keywords
 * carry the explicit `:X.X` suffix; lower-tier keywords go in bare to
 * save URL space. Mirrors iOS `DeepgramService.buildURL` behaviour.
 *
 * `baseUrlLength` is the length the URL has *before* any keyterm is
 * appended (scheme + host + path + the existing query string + `&`).
 * Caller measures it once and passes it in so the budget calculation
 * stays correct as keyterms accumulate. The function mutates `params`
 * in place and returns the count of keyterms actually appended (useful
 * for diagnostics; iOS logs "stopped at N keyterms" when it bails).
 */
export function appendKeytermsToUrl(
  params: URLSearchParams,
  keyterms: KeytermBoost[],
  baseUrlLength: number
): number {
  let appended = 0;
  let projectedLen = baseUrlLength + (params.toString() ? 0 : 0);
  // Account for the existing params already on `params` (caller's
  // baseline) — keyterms are appended onto the same instance.
  projectedLen = baseUrlLength;

  for (const { keyword, boost } of keyterms) {
    const value = boost >= TOP_TIER_BOOST_THRESHOLD ? `${keyword}:${boost.toFixed(1)}` : keyword;
    // `&keyterm=<urlencoded value>` is the worst-case overhead per
    // entry. URLSearchParams encodes the value when serialising, so
    // we mirror that here for an honest length estimate.
    const encoded = encodeURIComponent(value);
    const overhead = '&keyterm='.length + encoded.length;
    if (projectedLen + overhead > URL_LENGTH_BUDGET) {
      break;
    }
    params.append('keyterm', value);
    projectedLen += overhead;
    appended += 1;
  }

  return appended;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function pushAnalysisIfNovel(
  list: KeytermBoost[],
  analysisSeen: Set<string>,
  isNovel: (lc: string) => boolean,
  raw: string | null | undefined,
  boost: number
): void {
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (!isNovel(key)) return;
  list.push({ keyword: trimmed, boost });
  analysisSeen.add(key);
}

function extractOcpdTypes(circuits: NonNullable<CcuAnalysisLite['circuits']>): string[] {
  const types = new Set<string>();
  for (const circuit of circuits) {
    if (circuit.ocpd_type && circuit.ocpd_type.trim()) {
      types.add(circuit.ocpd_type.trim().toUpperCase());
    }
    if (circuit.is_rcbo === true) types.add('RCBO');
    if (circuit.rcd_protected === true) types.add('RCD');
  }
  return Array.from(types).sort();
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'on',
  'no',
  'n/a',
  'na',
  'spare',
  'blank',
  'circuit',
  'way',
  'cct',
]);

function extractLabelTerms(circuits: NonNullable<CcuAnalysisLite['circuits']>): string[] {
  const terms = new Set<string>();
  for (const circuit of circuits) {
    const label = circuit.label;
    if (!label) continue;

    // Split on non-alphanumeric, drop tokens shorter than 3 chars and
    // anything in the stop-word list. Title-case the rest so Deepgram
    // sees a clean keyword.
    const words = label.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3);
    for (const word of words) {
      const lower = word.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      const titled = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      terms.add(titled);
    }

    // Also keep the full label if it's a likely room/area name (length
    // window matches iOS heuristic). Apply the stop-word filter to the
    // full label too — iOS skips this check (its 1.0 boosts get capped
    // out anyway), but with our reserved-slot fix a label like "Spare"
    // would otherwise leak in via the analysis pool.
    const trimmed = label.trim();
    if (trimmed.length >= 4 && trimmed.length <= 30 && !STOP_WORDS.has(trimmed.toLowerCase())) {
      terms.add(trimmed);
    }
  }
  return Array.from(terms).sort();
}

function extractRcdRatings(circuits: NonNullable<CcuAnalysisLite['circuits']>): string[] {
  const ratings = new Set<string>();
  for (const circuit of circuits) {
    const raw = circuit.rcd_rating_ma;
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    ratings.add(`${trimmed} milliamp`);
    ratings.add(`${trimmed}mA`);
  }
  return Array.from(ratings).sort();
}

function dedupAndCap(boosts: KeytermBoost[], cap: number): KeytermBoost[] {
  const bestByKey = new Map<string, KeytermBoost>();
  for (const entry of boosts) {
    const key = entry.keyword.toLowerCase();
    const existing = bestByKey.get(key);
    if (!existing || entry.boost > existing.boost) {
      bestByKey.set(key, entry);
    }
  }
  const sorted = Array.from(bestByKey.values()).sort((a, b) => {
    if (a.boost !== b.boost) return b.boost - a.boost;
    return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0;
  });
  return sorted.slice(0, cap);
}

// Re-export constants for tests + diagnostics.
export const KEYTERM_INTERNALS = {
  MAX_KEYTERMS,
  TOP_TIER_BOOST_THRESHOLD,
  URL_LENGTH_BUDGET,
  ANALYSIS_RESERVED_SLOTS,
  BASE_KEYWORD_BOOSTS,
  BOARD_TYPE_BOOSTS,
} as const;
