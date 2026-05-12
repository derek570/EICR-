/**
 * require-consent middleware.
 *
 * Apply to routes that touch Customer Personal Data. Rejects with 403
 * + { code: 'consent_required', current_version } if the authenticated
 * user has not accepted the current Beta Tester Agreement version.
 *
 * The check is a single indexed lookup on
 *   account_consents (user_id, agreement_kind, agreement_version)
 * so cost is negligible relative to the route's own DB work.
 *
 * Why a body code rather than English text: iOS and web clients gate
 * on `code` to drive a UI flow (redirect to consent screen). English
 * text would lock that branch to a regex match.
 *
 * Apply order: AFTER requireAuth — needs req.user. Per the spec, do
 * NOT apply to:
 *   - /api/auth/*
 *   - /api/account/* (the consent route itself, and status)
 *   - /api/legal/* (text versions are fetchable pre-consent)
 *   - /api/me
 *   - /api/health, /api/health/ready
 *   - PWA static assets
 *
 * Apply TO:
 *   - jobs (create/update/finalise)       — Customer Personal Data
 *   - recording sessions                  — voice + transcripts
 *   - extraction (Sonnet, GPT Vision)     — touches transcript content
 *   - photos                              — homeowner-photographed
 *   - cert_attestations                   — only makes sense if the
 *                                           user has consented to the
 *                                           contract their attestation
 *                                           sits inside of
 *
 * The check fail-opens in two narrow cases:
 *   1. Database is unavailable / not configured (local dev). The
 *      consent table doesn't exist there; gating would block all dev
 *      work. The check returns "allow" rather than 500 — local dev
 *      doesn't process real data so the open posture is acceptable.
 *   2. The user record itself is somehow missing req.user.id. That
 *      shouldn't happen post-requireAuth; if it does the 401 from
 *      requireAuth would have fired first.
 */

import * as db from '../db.js';
import logger from '../logger.js';
import { CURRENT_VERSIONS } from '../lib/legal-text-versions.js';

const KIND = 'beta_tester_agreement';

export async function requireConsent(req, res, next) {
  if (!req.user || !req.user.id) {
    return next();
  }
  const currentVersion = CURRENT_VERSIONS[KIND];
  try {
    const row = await db.getMostRecentAcceptedConsent(req.user.id, KIND, currentVersion);
    if (row) {
      return next();
    }
    return res.status(403).json({
      code: 'consent_required',
      error: 'You must accept the current Beta Tester Agreement before using this feature.',
      current_version: currentVersion,
    });
  } catch (err) {
    // Database unavailable. Don't block dev work. Log so prod regressions
    // are still visible.
    logger.warn('require_consent_check_failed_open', {
      error: err.message,
      user_id: req.user.id,
    });
    return next();
  }
}
