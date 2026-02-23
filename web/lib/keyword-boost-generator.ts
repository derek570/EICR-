/**
 * KeywordBoostGenerator — ported from CertMateUnified/Sources/Whisper/KeywordBoostGenerator.swift
 *
 * Converts board photo analysis data and default config into Deepgram keyword boost parameters.
 * Boost tiers:
 *   2.0: Critical measurement terms (Ze, Zs, R1, R2) and detected OCPD types
 *   1.5: Board manufacturer, common electrical vocabulary, detected breaker types
 *   1.0: Circuit labels, circuit numbers, general terms
 */

import type { Circuit, BoardInfo } from "./types";

// ============= Config (from default_config.json) =============

const BASE_ELECTRICAL: Record<string, number> = {
  megohms: 3.0,
  "mega ohms": 3.0,
  Zs: 2.0,
  Ze: 2.0,
  Zeddy: 2.0,
  "Zed e": 2.0,
  RCD: 1.5,
  RCBO: 1.5,
  MCB: 1.5,
  AFDD: 1.5,
  R1: 2.0,
  R2: 2.0,
  Rn: 1.5,
  CPC: 1.5,
  "R1 plus R2": 3.0,
  "loop impedance": 1.5,
  "insulation resistance": 2.5,
  insulation: 1.5,
  "ring continuity": 2.0,
  "ring continuity lives": 2.0,
  "ring continuity neutrals": 2.0,
  "ring continuity earths": 2.0,
  lives: 1.5,
  neutrals: 1.5,
  earths: 2.0,
  "live to live": 2.0,
  "live to earth": 2.0,
  "live to neutral": 1.5,
  "greater than": 2.0,
  "test voltage": 1.5,
  radial: 1.0,
  spur: 1.0,
  polarity: 1.0,
  "trip time": 1.5,
  megger: 1.5,
  "earth fault": 1.5,
  continuity: 1.5,
  milliamps: 1.0,
  milliseconds: 1.0,
  circuit: 1.5,
  "first circuit": 1.5,
  "second circuit": 1.5,
  "nought point": 1.5,
  nought: 2.0,
  "nought point eight eight": 2.0,
  "main earth": 1.5,
  bonding: 1.5,
  earthing: 2.0,
  Earthing: 2.0,
  "TN-C-S": 2.0,
  "TN-C": 2.0,
  "TN-S": 2.0,
  TT: 1.5,
  PME: 1.5,
  "prospective fault current": 1.5,
  PFC: 1.5,
  "type B": 1.5,
  "type C": 1.5,
  "number of points": 1.5,
  "cable size": 1.5,
  "circuit number": 1.5,
  upstairs: 1.0,
  downstairs: 1.0,
  "twenty four": 1.5,
  wiring: 2.0,
  "wiring type": 2.0,
  "reference method": 2.0,
  "ref method": 2.0,
  "wiring method": 2.0,
  correction: 1.5,
  debug: 2.0,
  "end debug": 2.0,
  postcode: 1.5,
  customer: 1.5,
  client: 1.5,
  address: 1.5,
};

const BOARD_TYPES: Record<string, number> = {
  Hager: 1.5,
  Elucian: 1.5,
  BG: 1.5,
  Wylex: 1.5,
  MK: 1.5,
  Schneider: 1.5,
  Fusebox: 1.5,
  Crabtree: 1.5,
};

// Common words to skip from circuit label extraction
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "no",
  "n/a",
  "na",
  "spare",
  "blank",
  "circuit",
  "way",
  "cct",
]);

// ============= Public API =============

/**
 * Generate keyword boosts from board info and circuits (from CCU photo analysis).
 * If no board data, returns config-only keywords.
 */
export function generateKeywordBoosts(
  boardInfo?: BoardInfo | null,
  circuits?: Circuit[] | null,
): Array<[string, number]> {
  const boosts = generateFromConfig();

  if (!boardInfo && (!circuits || circuits.length === 0)) {
    return boosts;
  }

  const existingKeywords = new Set(boosts.map(([kw]) => kw.toLowerCase()));
  const boardSpecific: Array<[string, number]> = [];

  // 1. Board manufacturer
  if (boardInfo?.manufacturer) {
    const trimmed = boardInfo.manufacturer.trim();
    if (trimmed && !existingKeywords.has(trimmed.toLowerCase())) {
      boardSpecific.push([trimmed, 1.5]);
    }
  }

  if (circuits && circuits.length > 0) {
    // 2. OCPD types from circuits
    const ocpdTypes = extractOCPDTypes(circuits);
    for (const ocpdType of ocpdTypes) {
      if (!existingKeywords.has(ocpdType.toLowerCase())) {
        boardSpecific.push([ocpdType, 2.0]);
      }
    }

    // 3. Label terms from circuit designations
    const labelTerms = extractLabelTerms(circuits);
    for (const term of labelTerms) {
      if (!existingKeywords.has(term.toLowerCase())) {
        boardSpecific.push([term, 1.0]);
      }
    }

    // 4. Circuit number references
    for (const circuit of circuits) {
      if (circuit.circuit_ref) {
        boardSpecific.push([`circuit ${circuit.circuit_ref}`, 1.0]);
      }
    }

    // 5. RCD ratings
    const rcdRatings = extractRCDRatings(circuits);
    for (const rating of rcdRatings) {
      if (!existingKeywords.has(rating.toLowerCase())) {
        boardSpecific.push([rating, 1.5]);
      }
    }
  }

  return [...boosts, ...boardSpecific];
}

/**
 * Generate keyword boosts from config only (no board-specific data).
 */
export function generateFromConfig(): Array<[string, number]> {
  const boosts: Array<[string, number]> = [];

  for (const [keyword, boost] of Object.entries(BASE_ELECTRICAL)) {
    boosts.push([keyword, boost]);
  }

  for (const [keyword, boost] of Object.entries(BOARD_TYPES)) {
    boosts.push([keyword, boost]);
  }

  return boosts;
}

// ============= Extraction Helpers =============

function extractOCPDTypes(circuits: Circuit[]): string[] {
  const types = new Set<string>();

  for (const circuit of circuits) {
    if (circuit.ocpd_type) {
      const normalised = circuit.ocpd_type.trim().toUpperCase();
      if (normalised) types.add(normalised);
    }
    // Check for RCD-related fields
    if (circuit.rcd_type) {
      types.add("RCD");
    }
  }

  return Array.from(types).sort();
}

function extractLabelTerms(circuits: Circuit[]): string[] {
  const terms = new Set<string>();

  for (const circuit of circuits) {
    const label = circuit.circuit_designation;
    if (!label) continue;

    // Split label into individual words
    const words = label
      .split(/[^a-zA-Z0-9]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3);

    for (const word of words) {
      if (STOP_WORDS.has(word.toLowerCase())) continue;
      // Capitalise first letter
      const capitalised =
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      terms.add(capitalised);
    }

    // Also add the full label if it's a common multi-word name
    const trimmedLabel = label.trim();
    if (trimmedLabel.length >= 4 && trimmedLabel.length <= 30) {
      terms.add(trimmedLabel);
    }
  }

  return Array.from(terms).sort();
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
