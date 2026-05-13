/**
 * Tests for ccu-quality-gate.js.
 *
 * Pure-function tests — no extraction-pipeline integration here; the
 * route-level integration is covered by the analyze-ccu route tests.
 */
import { evaluateQualityGate, RETAKE_REASONS } from '../extraction/ccu-quality-gate.js';

describe('evaluateQualityGate', () => {
  const goodArgs = () => ({
    vlmCountAgreesWithCv: true,
    vlmCount: 16,
    cvCount: 16,
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

  test('fails when VLM count disagrees with CV count (the shadowed-MCB case)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCountAgreesWithCv: false,
      vlmCount: 15,
      cvCount: 16,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.VLM_CV_DISAGREEMENT);
    expect(result.message).toMatch(/shadows|glare|obstructed/i);
    expect(result.diagnostic.vlmCount).toBe(15);
    expect(result.diagnostic.cvCount).toBe(16);
  });

  test('passes when vlmCountAgreesWithCv is null (CV count unavailable)', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCountAgreesWithCv: null,
    });
    expect(result.pass).toBe(true);
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

  test('VLM-vs-CV disagreement takes precedence over other signals', () => {
    const result = evaluateQualityGate({
      vlmCountAgreesWithCv: false,
      vlmCount: 15,
      cvCount: 16,
      classifierConfidence: 0.3, // also bad
      rectNormCorr: 0.05, // also bad
      circuits: [],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.VLM_CV_DISAGREEMENT);
  });

  test('diagnostic includes every signal we evaluated', () => {
    const result = evaluateQualityGate(goodArgs());
    expect(result.diagnostic).toMatchObject({
      vlmCount: 16,
      cvCount: 16,
      vlmCountAgreesWithCv: true,
      classifierConfidence: 0.95,
      rectNormCorr: 0.44,
      ocpdSlotCount: 3,
      ocpdNullRatingCount: 0,
      ratingNullFraction: 0,
    });
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
