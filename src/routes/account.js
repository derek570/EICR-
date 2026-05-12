/**
 * Account-level non-auth routes — consent acceptance, consent status.
 *
 * Kept separate from auth.js because the consent flow has its own
 * lifecycle (first login + version-bump re-acceptance) and is
 * orthogonal to authentication. Auth verifies who you are; consent
 * verifies you've agreed to the contract under which we process data
 * on your customers' behalf. Splitting also keeps the auth file tight.
 *
 * Routes:
 *   POST /api/account/consent/accept   — write a clickwrap acceptance
 *   GET  /api/account/consent/status   — am I current on the BTA?
 *
 * The `/api/auth/me` route is extended (in auth.js) to surface
 * consent_pending + current_agreement_version on every me-fetch so the
 * iOS root coordinator and the web middleware can route through the
 * consent screen without an extra round-trip.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as db from '../db.js';
import logger from '../logger.js';
import { CURRENT_VERSIONS, isCurrentVersion, VALID_KINDS } from '../lib/legal-text-versions.js';

const router = Router();

const ACCEPTED_AT_SKEW_TOLERANCE_MS = 5 * 60 * 1000; // ±5 min server clock-skew tolerance
const ACCEPTED_AT_FUTURE_LIMIT_MS = 60 * 1000; // never accept timestamps more than 60s ahead

/**
 * POST /api/account/consent/accept
 *
 * Body:
 *   {
 *     agreement_kind: 'beta_tester_agreement',
 *     agreement_version: '2026-05-12',
 *     accepted_at: '<ISO8601 UTC>',
 *     platform: 'ios' | 'web',
 *     platform_version: '<app build number>'
 *   }
 *
 * Validation order matters:
 *   1. Body shape — reject malformed before touching the DB.
 *   2. Kind is in the allow-list.
 *   3. Version is the CURRENT one for that kind — refuse acceptances
 *      against stale soft drafts. A client-side bug or attacker could
 *      attempt to bind the user to an older version with weaker terms;
 *      this guard prevents that.
 *   4. accepted_at is within ±5 min of server time. Wider skew would
 *      hand a forger a path to backdated acceptances.
 *   5. Platform is one of the known clients.
 *
 * On success (or idempotent re-submit) returns 200 with the row id
 * and timestamps. Errors are 400 / 401 / 500 with a code body so the
 * client UX can match-case on `code` without parsing English messages.
 */
router.post('/consent/accept', auth.requireAuth, async (req, res) => {
  try {
    const {
      agreement_kind: agreementKind,
      agreement_version: agreementVersion,
      accepted_at: acceptedAtRaw,
      platform,
      platform_version: platformVersion,
    } = req.body || {};

    if (!agreementKind || !agreementVersion || !acceptedAtRaw || !platform) {
      return res
        .status(400)
        .json({
          code: 'invalid_body',
          error: 'agreement_kind, agreement_version, accepted_at, platform are required',
        });
    }

    if (!VALID_KINDS.includes(agreementKind)) {
      return res
        .status(400)
        .json({ code: 'unknown_kind', error: `unknown agreement_kind: ${agreementKind}` });
    }

    if (!isCurrentVersion(agreementKind, agreementVersion)) {
      return res.status(400).json({
        code: 'stale_version',
        error: `version ${agreementVersion} is not the current version`,
        current_version: CURRENT_VERSIONS[agreementKind],
      });
    }

    const acceptedAt = new Date(acceptedAtRaw);
    if (Number.isNaN(acceptedAt.getTime())) {
      return res
        .status(400)
        .json({ code: 'bad_timestamp', error: 'accepted_at is not a valid ISO8601 timestamp' });
    }
    const now = Date.now();
    if (
      acceptedAt.getTime() < now - ACCEPTED_AT_SKEW_TOLERANCE_MS ||
      acceptedAt.getTime() > now + ACCEPTED_AT_FUTURE_LIMIT_MS
    ) {
      return res.status(400).json({
        code: 'clock_skew',
        error: 'accepted_at is too far from server time',
      });
    }

    if (platform !== 'ios' && platform !== 'web') {
      return res
        .status(400)
        .json({ code: 'unknown_platform', error: `unknown platform: ${platform}` });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const row = await db.recordAccountConsent({
      userId: req.user.id,
      agreementKind,
      agreementVersion,
      acceptedAt,
      platform,
      platformVersion,
      ipAddress: typeof ipAddress === 'string' ? ipAddress.split(',')[0].trim() : null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    });

    logger.info('consent_accepted', {
      user_id: req.user.id,
      agreement_kind: agreementKind,
      agreement_version: agreementVersion,
      platform,
    });

    return res.status(200).json({
      ok: true,
      consent_id: row.id,
      accepted_at: row.accepted_at,
      recorded_at: row.recorded_at,
    });
  } catch (err) {
    logger.error('consent_accept_failed', { error: err.message, user_id: req.user?.id });
    return res.status(500).json({ code: 'server_error', error: 'failed to record consent' });
  }
});

/**
 * GET /api/account/consent/status
 *
 * Returns whether the authenticated user is current on the BTA and,
 * if not, what version they need to accept. Cheaper than /api/auth/me
 * when the client only needs the consent flag (e.g. on resume from
 * background).
 */
router.get('/consent/status', auth.requireAuth, async (req, res) => {
  try {
    const kind = 'beta_tester_agreement';
    const current = CURRENT_VERSIONS[kind];
    const row = await db.getMostRecentAcceptedConsent(req.user.id, kind, current);
    return res.json({
      consent_pending: row === null,
      current_agreement_version: current,
      accepted_at: row ? row.accepted_at : null,
    });
  } catch (err) {
    logger.error('consent_status_failed', { error: err.message, user_id: req.user?.id });
    return res.status(500).json({ code: 'server_error', error: 'failed to read consent status' });
  }
});

export default router;
