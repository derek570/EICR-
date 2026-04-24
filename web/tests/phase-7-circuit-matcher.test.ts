/**
 * Phase 7 — circuit matcher.
 *
 * Ports iOS `CircuitMatcher.swift` to `@certmate/shared-utils`. These
 * tests pin the invariants that matter when the Hardware Update mode
 * is replaying a whole board:
 *   - Exact normalised labels collapse to score 1.0 and are always the
 *     top-ranked pair.
 *   - Abbreviations (cct, skts, ltg, up/dn, gf/ff, hw, fcu) normalise
 *     into their expanded forms so "up skts" matches "upstairs sockets".
 *   - Semantic groups catch synonyms the other two heuristics miss
 *     (cooker ≈ oven, immersion ≈ hot water, etc.).
 *   - One-to-one assignment prevents the same existing circuit from
 *     being claimed by multiple new circuits (iOS parity: a later new
 *     circuit with a slightly lower score can't steal).
 *   - When all old circuits have been taken, remaining new ones fall
 *     through to `matchedOldCircuit: null` with `confidence: 0`.
 *   - Empty existing-circuits list produces all-new matches without
 *     throwing.
 */

import { describe, expect, it } from 'vitest';
import {
  matchCircuits,
  normaliseLabel,
  similarityScore,
  type MatcherExistingCircuit,
  type MatcherNewCircuit,
} from '@certmate/shared-utils';

function ex(id: string, circuit_designation: string): MatcherExistingCircuit {
  return { id, circuit_designation, circuit_ref: id };
}

function nu(circuit_number: number, label: string): MatcherNewCircuit {
  return { circuit_number, label };
}

describe('normaliseLabel', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normaliseLabel('  Kitchen Sockets!!  ')).toBe('kitchen sockets');
  });

  it('expands common abbreviations', () => {
    expect(normaliseLabel('Up skts cct')).toBe('upstairs sockets');
    expect(normaliseLabel('Dn ltg ckts')).toBe('downstairs lighting circuits');
    expect(normaliseLabel('HW immersion')).toBe('hot water immersion');
  });

  it('drops filler words (circuit, way, number)', () => {
    expect(normaliseLabel('Circuit number 3 way')).toBe('3');
  });
});

describe('similarityScore', () => {
  it('scores identical normalised labels at 1.0', () => {
    const { score, reason } = similarityScore('Kitchen Sockets', 'kitchen sockets');
    expect(score).toBe(1);
    expect(reason).toBe('exact label');
  });

  it('keeps abbreviation variants above the 0.4 threshold', () => {
    // "up skts" → "upstairs sockets" after normalisation — exact match.
    const { score } = similarityScore('Up Skts', 'Upstairs Sockets');
    expect(score).toBe(1);
  });

  it('catches semantic synonyms (cooker ≈ oven) above zero via semantic group', () => {
    // Both tokens "cooker" and "oven" map to the same cooker/kitchen
    // semantic group, so the overlap contributes a non-zero component
    // even though Levenshtein + Jaccard are near zero. The combined
    // score does NOT necessarily clear 0.4 — iOS parity: the token
    // "electric" happens to map to the shower group, which dilutes
    // groupsB to {cooker-group, shower-group} and the intersection
    // ratio ends up at 0.5 not 1.0.
    const { score, reason } = similarityScore('Cooker', 'Electric Oven');
    expect(score).toBeGreaterThan(0);
    expect(reason).toMatch(/semantic|token|fuzzy/);
  });

  it('synonyms on the same side (immersion ≈ hot water) clear the threshold', () => {
    // "immersion" and "hot water" / "water heater" all live in the
    // immersion-heater semantic group, so matching them produces a
    // full semantic intersection / union and a combined score well
    // above the 0.4 threshold.
    const { score } = similarityScore('Immersion Heater', 'Hot Water');
    expect(score).toBeGreaterThanOrEqual(0.4);
  });

  it('returns low scores for unrelated labels', () => {
    const { score } = similarityScore('Bathroom Fan', 'Cooker');
    expect(score).toBeLessThan(0.4);
  });
});

describe('matchCircuits — greedy one-to-one assignment', () => {
  it('returns all-new when no existing circuits', () => {
    const matches = matchCircuits([nu(1, 'Sockets'), nu(2, 'Lighting')], []);
    expect(matches).toHaveLength(2);
    for (const m of matches) {
      expect(m.matchedOldCircuit).toBeNull();
      expect(m.confidence).toBe(0);
      expect(m.matchReason).toBe('no existing circuits');
    }
  });

  it('matches exact labels and scores 1.0', () => {
    const [m] = matchCircuits(
      [nu(1, 'Kitchen Sockets')],
      [ex('a', 'Kitchen Sockets'), ex('b', 'Garage Lighting')]
    );
    expect(m.matchedOldCircuit?.id).toBe('a');
    expect(m.confidence).toBe(1);
  });

  it('prefers the best pair first (greedy)', () => {
    // Two new circuits, both "want" the same old circuit. The stronger
    // overlap should win; the other falls back to its runner-up or
    // becomes unmatched if nothing clears the threshold.
    const matches = matchCircuits(
      [nu(1, 'Upstairs Sockets'), nu(2, 'Up Skts')],
      [ex('a', 'Upstairs Sockets')]
    );
    // #1 wins (exact); #2 has no candidate left above threshold.
    expect(matches[0].matchedOldCircuit?.id).toBe('a');
    expect(matches[1].matchedOldCircuit).toBeNull();
  });

  it('drops pairs below the 0.4 threshold to unmatched', () => {
    const matches = matchCircuits([nu(1, 'Garden Pond Pump')], [ex('a', 'Kitchen Sockets')]);
    expect(matches[0].matchedOldCircuit).toBeNull();
    expect(matches[0].matchReason).toBe('no match above threshold');
  });

  it('confidence reflects the score (not a hardcoded constant)', () => {
    // Near-identical labels with one extra token — lands between the
    // 0.4 threshold and the perfect-score 1.0. Protects against a
    // regression where someone hardcodes the match confidence.
    const matches = matchCircuits([nu(1, 'Kitchen Sockets Ring')], [ex('a', 'Kitchen Sockets')]);
    expect(matches[0].matchedOldCircuit?.id).toBe('a');
    expect(matches[0].confidence).toBeGreaterThan(0.4);
    expect(matches[0].confidence).toBeLessThan(1);
  });
});
