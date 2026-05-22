/**
 * CCU quality gate.
 *
 * Evaluates extraction-pipeline signals and decides whether the result
 * is reliable enough to return to the inspector. When a hard signal
 * fires, /api/analyze-ccu returns HTTP 422 with a structured retake
 * payload and iOS shows a "retake photo" screen.
 *
 * Design intent: **never return wrong data silently.** The USP of the
 * extraction pipeline is correctness; if we can't be confident, we
 * tell the inspector to retake with a hint about what went wrong.
 *
 * Signal sources:
 *   - classifierConfidence: Stage 1 board_technology classifier's own
 *     score. Low = couldn't clearly identify the board.
 *   - rectNormCorr: Stage 2 box-tightener's quad-vs-rectangle fit
 *     score. Very low = rail is severely keystoned or partially
 *     occluded; dewarp output will be poor.
 *   - ocpd null fraction: how many MCB/RCBO slots have no readable
 *     amperage. High = device faces are unreadable (glare, focus).
 *
 * VLM-vs-CV count agreement was previously a hard-fail signal here.
 * It was dropped 2026-05-14 because CV's autocorrelation-based module
 * count is unreliable on real-world boards: ADRBs, SPDs, multi-pole
 * main switches, and any non-standard device face breaks the periodic
 * signature the pitch estimator depends on. The result was a high
 * false-positive rate (clean F2014MX photos being rejected three retakes
 * in a row because CV under-counted by 2). Modern GPT-5.5 enumeration
 * is more reliable than CV's geometric count on the variety of boards
 * we see in the field; the count is now logged for telemetry only.
 */

export const RETAKE_REASONS = {
  CLASSIFIER_LOW_CONFIDENCE: 'classifier_low_confidence',
  POOR_QUAD_FIT: 'poor_quad_fit',
  TOO_MANY_NULLS: 'too_many_nulls',
};

const MESSAGES = {
  [RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE]:
    'We couldn’t identify the consumer unit clearly. Please retake with the whole board in frame, in focus, and well lit.',
  [RETAKE_REASONS.POOR_QUAD_FIT]:
    'The consumer unit is at too steep an angle in this photo. Please retake from a more head-on position.',
  [RETAKE_REASONS.TOO_MANY_NULLS]:
    'Many of the device ratings aren’t readable in this photo. Please retake with brighter light and a closer, head-on angle so the printed text on each device is clear.',
};

const DEFAULT_THRESHOLDS = {
  // Stage 1 board_technology classifier — typical real-world runs sit
  // 0.92–0.97 on clean photos. < 0.85 means the model wasn't even sure
  // what *kind* of board it was looking at.
  classifierMinConfidence: 0.85,
  // Stage 2 quad-fit score. Observed real-world range on good photos:
  // 0.35–0.55. < 0.20 means the rail isn't even approximately a
  // rectangle in the image — typically heavy perspective + occlusion.
  rectNormCorrMinHard: 0.2,
  // Fraction of MCB/RCBO slots with null `ocpd_rating_a`. > 0.5 means
  // we couldn't read the amperage on more than half the device faces;
  // the extraction is unusable for an inspector. Below this we still
  // pass — a couple of unreadable labels is recoverable in the UI.
  ratingNullFractionMax: 0.5,
};

/**
 * Pure function. No I/O, no logging. Inputs come from the in-route
 * scope after extraction completes; the route does the actual logging
 * and HTTP response shaping.
 *
 * @param {object} args
 * @param {number|null} [args.classifierConfidence]
 *        From `boardClassification.confidence`.
 * @param {number|null} [args.rectNormCorr]
 *        From `geometricResult.chunkingDiag.refinement.quadDiag.rectNormCorr`.
 * @param {Array} [args.circuits] — `analysis.circuits` after merger.
 * @param {object} [args.thresholds] — overrides for tests.
 * @returns {{
 *   pass: boolean,
 *   reason: string|null,
 *   message: string|null,
 *   diagnostic: object,
 * }}
 */
export function evaluateQualityGate({
  classifierConfidence = null,
  rectNormCorr = null,
  circuits = null,
  thresholds = {},
} = {}) {
  const cfg = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const diagnostic = {
    classifierConfidence,
    rectNormCorr,
    ocpdSlotCount: null,
    ocpdNullRatingCount: null,
    ratingNullFraction: null,
  };

  if (
    typeof classifierConfidence === 'number' &&
    classifierConfidence < cfg.classifierMinConfidence
  ) {
    return {
      pass: false,
      reason: RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE,
      message: MESSAGES[RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE],
      diagnostic,
    };
  }

  if (typeof rectNormCorr === 'number' && rectNormCorr < cfg.rectNormCorrMinHard) {
    return {
      pass: false,
      reason: RETAKE_REASONS.POOR_QUAD_FIT,
      message: MESSAGES[RETAKE_REASONS.POOR_QUAD_FIT],
      diagnostic,
    };
  }

  if (Array.isArray(circuits) && circuits.length > 0) {
    // Count MCB/RCBO slots with no readable amperage. We tolerate
    // null on RCDs, blanks and SPDs because rating either doesn't
    // apply or is read from a different field.
    const ocpdSlots = circuits.filter((c) => {
      const k = c?.device_kind || c?.kind || c?.classification || null;
      return k === 'mcb' || k === 'rcbo';
    });
    if (ocpdSlots.length > 0) {
      const nullRatingCount = ocpdSlots.filter(
        (c) => c?.ocpd_rating_a == null && c?.rating == null
      ).length;
      const fraction = nullRatingCount / ocpdSlots.length;
      diagnostic.ocpdSlotCount = ocpdSlots.length;
      diagnostic.ocpdNullRatingCount = nullRatingCount;
      diagnostic.ratingNullFraction = parseFloat(fraction.toFixed(3));
      if (fraction > cfg.ratingNullFractionMax) {
        return {
          pass: false,
          reason: RETAKE_REASONS.TOO_MANY_NULLS,
          message: MESSAGES[RETAKE_REASONS.TOO_MANY_NULLS],
          diagnostic,
        };
      }
    }
  }

  return { pass: true, reason: null, message: null, diagnostic };
}

export const __TEST_INTERNALS = { MESSAGES, DEFAULT_THRESHOLDS };
