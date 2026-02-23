/**
 * Keyword boost generator — port of iOS KeywordBoostGenerator.swift
 *
 * Converts board photo analysis data and base vocabulary into
 * Deepgram keyword boost parameters to improve recognition of
 * electrical terms specific to the board under test.
 *
 * Boost tiers:
 * - 2.0: Critical measurement terms (Ze, Zs, R1, R2) and detected OCPD types
 * - 1.5: Board manufacturer, common electrical vocabulary, detected breaker types
 * - 1.0: Circuit labels, circuit numbers, general terms
 */

import type { BoardInfo, Circuit } from '../api';

// ── Base Electrical Vocabulary ──
// Hardcoded from default_config.json keyword_boosts.base_electrical

const baseKeywordBoosts: [string, number][] = [
  ['megohms', 3.0],
  ['mega ohms', 3.0],
  ['Zs', 2.0],
  ['Ze', 2.0],
  ['Zeddy', 2.0],
  ['Zed e', 2.0],
  ['zed e', 2.0],
  ['Z e', 2.0],
  ['ze is', 2.0],
  ['RCD', 1.5],
  ['RCBO', 1.5],
  ['MCB', 1.5],
  ['AFDD', 1.5],
  ['R1', 2.0],
  ['R2', 2.0],
  ['Rn', 1.5],
  ['CPC', 1.5],
  ['R1 plus R2', 3.0],
  ['loop impedance', 1.5],
  ['insulation resistance', 2.5],
  ['insulation', 1.5],
  ['ring continuity', 2.0],
  ['ring continuity lives', 2.0],
  ['ring continuity neutrals', 2.0],
  ['ring continuity earths', 2.0],
  ['lives', 1.5],
  ['neutrals', 1.5],
  ['earths', 2.0],
  ['births', -5.0],
  ['live to live', 2.0],
  ['live to earth', 2.0],
  ['live to neutral', 1.5],
  ['greater than', 2.0],
  ['test voltage', 1.5],
  ['radial', 1.0],
  ['spur', 1.0],
  ['polarity', 1.0],
  ['push button', 1.5],
  ['push button works', 2.0],
  ['trip time', 1.5],
  ['megger', 1.5],
  ['earth fault', 1.5],
  ['continuity', 1.5],
  ['milliamps', 1.0],
  ['milliseconds', 1.0],
  ['circuit', 3.0],
  ['first circuit', 1.5],
  ['second circuit', 1.5],
  ['third circuit', 1.5],
  ['fourth circuit', 1.5],
  ['fifth circuit', 1.5],
  ['sixth circuit', 1.5],
  ['circuit three', 1.5],
  ['circuit four', 1.5],
  ['circuit five', 1.5],
  ['circuit six', 1.5],
  ['nought point', 1.5],
  ['nought', 2.0],
  ['nought point eight eight', 2.0],
  ['main earth', 1.5],
  ['bonding', 1.5],
  ['earthing', 2.0],
  ['Earthing', 2.0],
  ['TN-C-S', 3.0],
  ['TN dash C dash S', 2.0],
  ['TN-C', 2.0],
  ['TN-S', 3.0],
  ['TN dash S', 2.0],
  ['TT', 1.5],
  ['PME', 1.5],
  ['prospective fault current', 1.5],
  ['PFC', 1.5],
  ['supply voltage', 1.5],
  ['volts', 1.0],
  ['frequency', 1.5],
  ['hertz', 1.5],
  ['type B', 1.5],
  ['type C', 1.5],
  ['number of points', 1.5],
  ['smokes', 1.5],
  ['smoke detectors', 1.5],
  ['cable size', 1.5],
  ['circuit number', 1.5],
  ['upstairs', 1.0],
  ['downstairs', 1.0],
  ['twenty four', 1.5],
  ['wiring', 2.0],
  ['wiring type', 2.0],
  ['reference method', 2.0],
  ['ref method', 2.0],
  ['wiring method', 2.0],
  ['correction', 1.5],
  ['N/A', 2.5],
  ['NA', 2.0],
  ['not applicable', 1.5],
  ['LIM', 3.0],
  ['lim', 3.0],
  ['limitation', 2.5],
  ['limited', 2.0],
  ['debug', 2.0],
  ['end debug', 2.0],
  ['observation', 2.5],
  ['C1', 2.0],
  ['C2', 2.0],
  ['C3', 2.0],
  ['FI', 1.5],
  ['code 1', 1.5],
  ['code 2', 1.5],
  ['code 3', 1.5],
  ['danger present', 1.5],
  ['potentially dangerous', 1.5],
  ['improvement recommended', 1.5],
  ['further investigation', 1.5],
  ['defect', 1.5],
  ['postcode', 1.5],
  ['customer', 1.5],
  ['client', 1.5],
  ['address', 1.5],
];

// ── Board Type Boosts ──

const boardTypeBoosts: [string, number][] = [
  ['Hager', 1.5],
  ['Elucian', 1.5],
  ['BG', 1.5],
  ['Wylex', 1.5],
  ['MK', 1.5],
  ['Schneider', 1.5],
  ['Fusebox', 1.5],
  ['Crabtree', 1.5],
];

// ── Label Stop Words ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on',
  'no', 'n/a', 'na', 'spare', 'blank', 'circuit', 'way', 'cct',
]);

// ── Private Helpers ──

function extractOCPDTypes(circuits: Circuit[]): string[] {
  const types = new Set<string>();

  for (const circuit of circuits) {
    if (circuit.ocpd_type) {
      const trimmed = circuit.ocpd_type.trim();
      if (trimmed) types.add(trimmed.toUpperCase());
    }
  }

  return Array.from(types).sort();
}

function extractLabelTerms(circuits: Circuit[]): string[] {
  const terms = new Set<string>();

  for (const circuit of circuits) {
    const label = circuit.circuit_designation;
    if (!label) continue;

    // Split label into individual words (non-alphanumeric separators)
    const words = label.split(/[^a-zA-Z0-9]+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3);

    for (const word of words) {
      const lower = word.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      // Capitalise first letter for cleaner Deepgram keyword
      const capitalised = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      terms.add(capitalised);
    }

    // Also add the full label if it's a common multi-word room/area name
    const trimmedLabel = label.trim();
    if (trimmedLabel.length >= 4 && trimmedLabel.length <= 30) {
      terms.add(trimmedLabel);
    }
  }

  return Array.from(terms).sort();
}

function extractCircuitNumbers(circuits: Circuit[]): string[] {
  return circuits.map(c => `circuit ${c.circuit_ref}`);
}

function extractRCDRatings(circuits: Circuit[]): string[] {
  const ratings = new Set<string>();

  for (const circuit of circuits) {
    if (circuit.rcd_operating_current_ma) {
      const trimmed = circuit.rcd_operating_current_ma.trim();
      if (trimmed) {
        ratings.add(`${trimmed} milliamp`);
        ratings.add(`${trimmed}mA`);
      }
    }
  }

  return Array.from(ratings).sort();
}

// ── Keyterm Limit ──
// Deepgram Nova-3 keyterm limit: 500 tokens across all keyterms.
// Deepgram estimates 500 tokens ≈ 100 keyterms (varies by length).
// Cap at 100 to stay within the documented limit.
const MAX_KEYTERMS = 100;

/**
 * Deduplicate (case-insensitive, keeping highest boost), sort by boost descending,
 * and cap at MAX_KEYTERMS to stay within Deepgram's URL parameter limits.
 */
function dedupAndCap(boosts: [string, number][]): [string, number][] {
  const bestByKey = new Map<string, [string, number]>();
  for (const [keyword, boost] of boosts) {
    const key = keyword.toLowerCase();
    const existing = bestByKey.get(key);
    if (!existing || boost > existing[1]) {
      bestByKey.set(key, [keyword, boost]);
    }
  }

  const sorted = Array.from(bestByKey.values()).sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1]; // highest boost first
    return a[0].localeCompare(b[0]); // then alphabetical
  });

  return sorted.slice(0, MAX_KEYTERMS);
}

// ── Public API ──

/**
 * Generate keyword boosts from board photo analysis combined with base vocabulary.
 *
 * Merges base electrical vocabulary, board-type keywords, and board-specific terms
 * extracted from BoardInfo and circuits. If no boardInfo is provided, falls back
 * to config-only keywords.
 *
 * The result is deduped (case-insensitive, keeping highest boost),
 * sorted by boost descending, and capped at MAX_KEYTERMS.
 *
 * @param boardInfo - The board info from CCU photo analysis, or null/undefined
 * @param circuits - Array of circuits from the board, or undefined
 * @returns Array of [keyword, boost_value] tuples for DeepgramService.connect()
 */
export function generateKeywordBoosts(
  boardInfo?: BoardInfo | null,
  circuits?: Circuit[],
): [string, number][] {
  // Start with config-based keywords
  const boosts: [string, number][] = [
    ...baseKeywordBoosts,
    ...boardTypeBoosts,
  ];

  if (!boardInfo && (!circuits || circuits.length === 0)) {
    return dedupAndCap(boosts);
  }

  const existingKeywords = new Set(boosts.map(([kw]) => kw.toLowerCase()));
  const boardSpecific: [string, number][] = [];

  // 1. Board manufacturer
  if (boardInfo?.manufacturer) {
    const trimmed = boardInfo.manufacturer.trim();
    if (trimmed && !existingKeywords.has(trimmed.toLowerCase())) {
      boardSpecific.push([trimmed, 1.5]);
    }
  }

  // 2. Board model — BoardInfo doesn't have a model field in the web types,
  //    but we check name as a fallback (distinct from manufacturer)
  if (boardInfo?.name) {
    const trimmed = boardInfo.name.trim();
    if (trimmed && !existingKeywords.has(trimmed.toLowerCase())) {
      boardSpecific.push([trimmed, 1.0]);
    }
  }

  const circuitList = circuits ?? [];

  // 3. Circuit breaker types found in circuits
  const ocpdTypes = extractOCPDTypes(circuitList);
  for (const ocpdType of ocpdTypes) {
    if (!existingKeywords.has(ocpdType.toLowerCase())) {
      boardSpecific.push([ocpdType, 2.0]);
    }
  }

  // 4. SPD-related keywords — check if any circuit data suggests SPD
  // (web BoardInfo doesn't have spdPresent; skip if not available)

  // 5. Main switch type — not directly on BoardInfo web type; skip

  // 6. Key terms from circuit labels
  const labelTerms = extractLabelTerms(circuitList);
  for (const term of labelTerms) {
    if (!existingKeywords.has(term.toLowerCase())) {
      boardSpecific.push([term, 1.0]);
    }
  }

  // 7. Circuit numbers (e.g., "circuit 7", "circuit 12")
  const circuitNumbers = extractCircuitNumbers(circuitList);
  for (const circuitRef of circuitNumbers) {
    boardSpecific.push([circuitRef, 1.0]);
  }

  // 8. RCD ratings if detected (e.g., "30 milliamp", "30mA")
  const rcdRatings = extractRCDRatings(circuitList);
  for (const rating of rcdRatings) {
    if (!existingKeywords.has(rating.toLowerCase())) {
      boardSpecific.push([rating, 1.5]);
    }
  }

  boosts.push(...boardSpecific);
  return dedupAndCap(boosts);
}
