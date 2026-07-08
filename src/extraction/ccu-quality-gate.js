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
 *
 * Classifier confidence became a SOFT signal 2026-07-08. Field evidence
 * (Contactum board, three different photos, classifier pinned at 0.82
 * every time because it could not name the board *model*): the Stage-1
 * confidence is a property of the BOARD, not the PHOTO, so a sub-0.85
 * score rejects every retake forever while the downstream extraction is
 * demonstrably healthy (13/13 circuits, full label coverage, all ratings
 * read). Below `classifierMinConfidence` the gate now passes anyway when
 * the extraction corroborates itself — enough OCPD circuits with mostly
 * readable ratings. A hard floor (`classifierMinConfidenceHard`) is kept:
 * below it the classifier may have routed the photo down the wrong
 * pipeline entirely (modern vs rewireable prompts), so plausible-looking
 * output can't be trusted no matter how complete it looks. We deliberately
 * do NOT try to improve confidence by identifying the board model —
 * model-number lookups were rejected as a signal because there is too
 * much hardware variance within one model number (Derek, 2026-07-08).
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
  // 0.92–0.97 on clean photos. Below this the score alone is no longer
  // enough to pass; the extraction must corroborate itself (see header).
  classifierMinConfidence: 0.85,
  // Hard floor: below this the classifier genuinely didn't know what it
  // was looking at, so the wrong prompt (modern vs rewireable) may have
  // produced plausible garbage. Fails regardless of corroboration.
  // Field data: clean photos 0.92–0.97; the known board-model-unsure case
  // sits at 0.82 — comfortably above this floor.
  classifierMinConfidenceHard: 0.65,
  // Corroboration needs at least this many OCPD circuits before "the
  // ratings are mostly readable" means anything — 1-2 lucky reads on a
  // garbage extraction must not vouch for the classifier.
  corroborationMinOcpdSlots: 3,
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
    classifierSoftFail: false,
    corroboratedByExtraction: false,
  };

  // --- OCPD rating stats (computed up front — the classifier decision
  // below uses them as corroboration). Count MCB/RCBO circuits with no
  // readable amperage; tolerate null on RCDs, blanks and SPDs because
  // rating either doesn't apply or is read from a different field.
  //
  // Two circuit shapes reach this gate:
  //   - slot-shaped rows carrying `device_kind`/`kind`/`classification`
  //     (legacy per-slot path, route tests);
  //   - merged rows from `buildCircuitFromSlot` (the LIVE geometric-merged
  //     path), which carry NO kind key at all. There an OCPD circuit is
  //     recognisable by its `ocpd_bs_en` class default (mcb/rcbo/
  //     rewireable/cartridge all get one; blanks stay null) or `is_rcbo`.
  //     Before 2026-07-08 the filter only understood the slot shape, so
  //     this entire check was dead on live traffic.
  const ocpdSlots = (Array.isArray(circuits) ? circuits : []).filter((c) => {
    const k = c?.device_kind || c?.kind || c?.classification || null;
    if (k != null) return k === 'mcb' || k === 'rcbo';
    return c?.ocpd_bs_en != null || c?.is_rcbo === true || c?.ocpd_rating_a != null;
  });
  let ratingNullFraction = null;
  if (ocpdSlots.length > 0) {
    const nullRatingCount = ocpdSlots.filter(
      (c) => c?.ocpd_rating_a == null && c?.rating == null
    ).length;
    ratingNullFraction = nullRatingCount / ocpdSlots.length;
    diagnostic.ocpdSlotCount = ocpdSlots.length;
    diagnostic.ocpdNullRatingCount = nullRatingCount;
    diagnostic.ratingNullFraction = parseFloat(ratingNullFraction.toFixed(3));
  }

  // The extraction vouches for itself when it read a healthy board:
  // enough OCPD circuits, most with a readable rating.
  const corroborated =
    ocpdSlots.length >= cfg.corroborationMinOcpdSlots &&
    ratingNullFraction !== null &&
    ratingNullFraction <= cfg.ratingNullFractionMax;
  diagnostic.corroboratedByExtraction = corroborated;

  if (typeof classifierConfidence === 'number') {
    if (classifierConfidence < cfg.classifierMinConfidenceHard) {
      // Wrong-pipeline risk — never pass on corroboration alone.
      return {
        pass: false,
        reason: RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE,
        message: MESSAGES[RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE],
        diagnostic,
      };
    }
    if (classifierConfidence < cfg.classifierMinConfidence) {
      diagnostic.classifierSoftFail = true;
      if (!corroborated) {
        return {
          pass: false,
          reason: RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE,
          message: MESSAGES[RETAKE_REASONS.CLASSIFIER_LOW_CONFIDENCE],
          diagnostic,
        };
      }
      // Soft fail + corroborated extraction → let it through; the
      // low score reflects the board, not the photo (see header).
    }
  }

  if (typeof rectNormCorr === 'number' && rectNormCorr < cfg.rectNormCorrMinHard) {
    return {
      pass: false,
      reason: RETAKE_REASONS.POOR_QUAD_FIT,
      message: MESSAGES[RETAKE_REASONS.POOR_QUAD_FIT],
      diagnostic,
    };
  }

  if (ratingNullFraction !== null && ratingNullFraction > cfg.ratingNullFractionMax) {
    return {
      pass: false,
      reason: RETAKE_REASONS.TOO_MANY_NULLS,
      message: MESSAGES[RETAKE_REASONS.TOO_MANY_NULLS],
      diagnostic,
    };
  }

  return { pass: true, reason: null, message: null, diagnostic };
}

export const __TEST_INTERNALS = { MESSAGES, DEFAULT_THRESHOLDS };
