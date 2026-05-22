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

  test('VLM-vs-CV count signals are tolerated when both are absent (legacy passthrough)', () => {
    // The original symmetric vlmCountAgreesWithCv signal was removed
    // 2026-05-14 (CV false-positives on F2014MX). An asymmetric
    // re-introduction landed 2026-05-22 — see the dedicated VLM_UNDERCOUNT
    // tests below. When NEITHER count is supplied (legacy callers, or
    // CV failed to estimate), the gate cannot fire on this signal.
    const result = evaluateQualityGate(goodArgs());
    expect(result.pass).toBe(true);
  });

  test('diagnostic includes every signal we evaluated, including vlm/cv counts when supplied', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 14,
      cvCount: 14,
    });
    expect(result.diagnostic).toMatchObject({
      classifierConfidence: 0.95,
      rectNormCorr: 0.44,
      vlmCount: 14,
      cvCount: 14,
      vlmUndershoot: 0,
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

  // ---------------------------------------------------------------------------
  // VLM under-count gate (re-introduced 2026-05-22, asymmetric)
  // ---------------------------------------------------------------------------

  test('fails with VLM_UNDERCOUNT when vlmCount is 2+ below cvCount (the 2026-05-22 Wylex case)', () => {
    // Real values from production extraction 1779468040371-vwj60m:
    // vlm=14, cv=16 → undershoot 2, fails.
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 14,
      cvCount: 16,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.VLM_UNDERCOUNT);
    expect(result.diagnostic.vlmUndershoot).toBe(2);
  });

  test('passes when vlmCount is exactly 1 below cvCount (CV off-by-one noise band)', () => {
    // Today's 11:19 UTC extraction: vlm=15, cv=16, undershoot 1. Single-
    // slot disagreement is in CV's normal noise band on multi-pole devices,
    // doesn't warrant a retake.
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 15,
      cvCount: 16,
    });
    expect(result.pass).toBe(true);
  });

  test('passes when vlmCount > cvCount (the F2014MX false-positive case the 2026-05-14 removal was about)', () => {
    // F2014MX boards have ADRBs / SPDs that break CV's autocorrelation;
    // CV undercounts the rail, VLM correctly enumerates everything. The
    // asymmetric gate must NOT retake-required this case, otherwise we
    // re-introduce the bug that motivated dropping the symmetric gate.
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 18,
      cvCount: 14,
    });
    expect(result.pass).toBe(true);
  });

  test('passes when vlmCount and cvCount agree', () => {
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 16,
      cvCount: 16,
    });
    expect(result.pass).toBe(true);
  });

  test('passes when either count is null (signal unavailable)', () => {
    expect(evaluateQualityGate({ ...goodArgs(), vlmCount: null, cvCount: 16 }).pass).toBe(true);
    expect(evaluateQualityGate({ ...goodArgs(), vlmCount: 14, cvCount: null }).pass).toBe(true);
  });

  test('honours vlmCountUndershootMin threshold override', () => {
    // Lower the threshold to 1 — now an off-by-one fails.
    const result = evaluateQualityGate({
      ...goodArgs(),
      vlmCount: 15,
      cvCount: 16,
      thresholds: { vlmCountUndershootMin: 1 },
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe(RETAKE_REASONS.VLM_UNDERCOUNT);
  });
});
