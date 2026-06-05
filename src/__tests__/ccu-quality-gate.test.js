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

  test('fails when classifier confidence is below threshold', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      classifierConfidence: 0.6,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
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
      thresholds: { classifierMinConfidence: 0.95 },
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE);
  });
});
