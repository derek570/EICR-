/**
 * Tests for ccu-quality-gate.js.
 *
 * Pure-function tests — no extraction-pipeline integration here; the
 * route-level integration is covered by the analyze-ccu route tests.
 */
import { evaluateQualityGate, RETAKE_REASONS } from '../extraction/ccu-quality-gate.js';

describe('evaluateQualityGate', () => {
  const goodArgs = () => ({
    classifierConfidence: 0.95,
    rectNormCorr: 0.44,
    circuits: [
      { device_kind: 'mcb', ocpd_rating_a: 32 },
      { device_kind: 'mcb', ocpd_rating_a: 16 },
      { device_kind: 'rcbo', ocpd_rating_a: 32 },
    ],
  });

  test('passes when all signals are healthy', () => {
    const result = evaluateQualityGate(goodArgs());
    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.message).toBeNull();
  });

  test('fails below the hard classifier floor even with corroborating circuits', () => {
    // Below classifierMinConfidenceHard (0.65) the classifier may have
    // routed the photo down the wrong pipeline (modern vs rewireable),
    // so plausible-looking output cannot vouch for it.
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.6,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
  });

  test('soft classifier fail passes when the extraction corroborates itself', () => {
    // Field regression 2026-07-08: a Contactum board pinned the Stage-1
    // classifier at 0.82 on THREE different photos (board-model unknown →
    // confidence capped by the board, not the photo), while the extraction
    // read 13/13 circuits with full ratings. The gate rejected every
    // retake forever. 0.82 is above the hard floor; a healthy circuit
    // list must let it through.
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.82,
    });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.classifierSoftFail).toBe(true);
    expect(result.diagnostic.corroboratedByExtraction).toBe(true);
  });

  test('soft classifier fail still fails without corroborating circuits', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.82,
      circuits: [],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
    expect(result.diagnostic.classifierSoftFail).toBe(true);
    expect(result.diagnostic.corroboratedByExtraction).toBe(false);
  });

  test('soft classifier fail still fails when ratings are mostly unreadable', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.82,
      circuits: [
        { device_kind: 'mcb', ocpd_rating_a: 32 },
        { device_kind: 'mcb', ocpd_rating_a: null },
        { device_kind: 'mcb', ocpd_rating_a: null },
        { device_kind: 'rcbo', ocpd_rating_a: null },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
  });

  test('soft classifier fail needs at least corroborationMinOcpdSlots circuits', () => {
    // 1-2 lucky reads on a garbage extraction must not vouch for the
    // classifier.
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.82,
      circuits: [
        { device_kind: 'mcb', ocpd_rating_a: 32 },
        { device_kind: 'mcb', ocpd_rating_a: 16 },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
  });

  test('recognises live merged-circuit shape (no device_kind key) for corroboration', () => {
    // The LIVE geometric-merged path emits circuits from
    // buildCircuitFromSlot, which carry NO device_kind/kind/classification
    // key — OCPD circuits are recognisable by ocpd_bs_en / is_rcbo, blanks
    // ("Spare") by all-null OCPD fields. This is the exact shape from the
    // 2026-07-08 field failure.
    const result = evaluateQualityGate({
      classifierConfidence: 0.82,
      rectNormCorr: 0.527,
      circuits: [
        { circuit_number: 1, ocpd_bs_en: 'BS EN 61009', ocpd_rating_a: '20', is_rcbo: true },
        { circuit_number: 2, ocpd_bs_en: 'BS EN 61009', ocpd_rating_a: '16', is_rcbo: true },
        { circuit_number: 3, ocpd_bs_en: 'BS EN 60898', ocpd_rating_a: '40', is_rcbo: false },
        { circuit_number: 4, ocpd_bs_en: 'BS EN 60898', ocpd_rating_a: '32', is_rcbo: false },
        // Blank ("Spare") — must not count as an OCPD slot.
        { circuit_number: 5, ocpd_bs_en: null, ocpd_rating_a: null, is_rcbo: false },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.ocpdSlotCount).toBe(4);
    expect(result.diagnostic.ocpdNullRatingCount).toBe(0);
    expect(result.diagnostic.corroboratedByExtraction).toBe(true);
  });

  test('merged-circuit shape with mostly-null ratings triggers too_many_nulls', () => {
    // Before 2026-07-08 the OCPD filter only understood slot-shaped rows,
    // so this check was dead on live traffic.
    const result = evaluateQualityGate({
      ...goodArgs(),
      circuits: [
        { circuit_number: 1, ocpd_bs_en: 'BS EN 60898', ocpd_rating_a: '32' },
        { circuit_number: 2, ocpd_bs_en: 'BS EN 60898', ocpd_rating_a: null },
        { circuit_number: 3, ocpd_bs_en: 'BS EN 60898', ocpd_rating_a: null },
        { circuit_number: 4, ocpd_bs_en: 'BS 3036', ocpd_rating_a: null },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.TOO_MANY_NULLS);
    expect(result.diagnostic.ratingNullFraction).toBe(0.75);
  });

  test('passes when classifier confidence is exactly at threshold (0.85)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.85,
    });
    expect(result.pass).toBe(true);
  });

  test('passes when classifier confidence is null (signal unavailable)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: null,
    });
    expect(result.pass).toBe(true);
  });

  test('fails when rectNormCorr is below hard threshold (severely keystoned)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      rectNormCorr: 0.1,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.POOR_QUAD_FIT);
  });

  test('passes when rectNormCorr is null (no quad — legacy bbox path)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      rectNormCorr: null,
    });
    expect(result.pass).toBe(true);
  });

  test('fails when >50% of OCPD slots have null amperage', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      circuits: [
        { device_kind: 'mcb', ocpd_rating_a: 32 },
        { device_kind: 'mcb', ocpd_rating_a: null },
        { device_kind: 'mcb', ocpd_rating_a: null },
        { device_kind: 'mcb', ocpd_rating_a: null },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.TOO_MANY_NULLS);
    expect(result.diagnostic.ratingNullFraction).toBe(0.75);
  });

  test('passes when exactly 50% of OCPD slots have null amperage (boundary)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      circuits: [
        { device_kind: 'mcb', ocpd_rating_a: 32 },
        { device_kind: 'mcb', ocpd_rating_a: 16 },
        { device_kind: 'mcb', ocpd_rating_a: null },
        { device_kind: 'mcb', ocpd_rating_a: null },
      ],
    });
    expect(result.pass).toBe(true);
  });

  test('ignores nulls on non-OCPD slots (RCD, blank, SPD, main_switch)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      circuits: [
        { device_kind: 'mcb', ocpd_rating_a: 32 },
        { device_kind: 'rcd', ocpd_rating_a: null },
        { device_kind: 'blank', ocpd_rating_a: null },
        { device_kind: 'spd', ocpd_rating_a: null },
        { device_kind: 'main_switch', ocpd_rating_a: null },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.ocpdSlotCount).toBe(1);
  });

  test('supports both `device_kind` and legacy `kind` / `classification` keys', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      circuits: [
        { kind: 'mcb', rating: 32 },
        { classification: 'rcbo', rating: 16 },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.diagnostic.ocpdSlotCount).toBe(2);
  });

  test('VLM-vs-CV count disagreement no longer triggers a retake', () => {
    // The hard-fail block on `vlmCountAgreesWithCv === false` was removed
    // 2026-05-14. The gate ignores VLM/CV count signals entirely now;
    // even an extreme mismatch passes if the other signals are healthy.
    // (CV is unreliable on real-world boards — see header comment.)
    const result = evaluateQualityGate(goodArgs());
    expect(result.pass).toBe(true);
  });

  test('diagnostic includes every signal we evaluated', () => {
    const result = evaluateQualityGate(goodArgs());
    expect(result.diagnostic).toMatchObject({
      classifierConfidence: 0.95,
      rectNormCorr: 0.44,
      ocpdSlotCount: 3,
      ocpdNullRatingCount: 0,
      ratingNullFraction: 0,
    });
    // VLM/CV fields are no longer present in the diagnostic.
    expect(result.diagnostic).not.toHaveProperty('vlmCount');
    expect(result.diagnostic).not.toHaveProperty('cvCount');
    expect(result.diagnostic).not.toHaveProperty('vlmCountAgreesWithCv');
  });

  test('honours threshold overrides for tests', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.9,
      thresholds: { classifierMinConfidence: 0.95, classifierMinConfidenceHard: 0.92 },
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
  });
});
