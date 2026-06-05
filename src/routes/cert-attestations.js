/**
 * Per-PDF inspector attestations route.
 *
 * Spec: .planning/compliance/pdf-issuance-attestations.md.
 *
 * Routes:
 *   POST   /api/cert-attestations/accept       — atomic 2-row write
 *   PATCH  /api/cert-attestations/pdf-key      — stamp PDF key after render
 *   GET    /api/cert-attestations              — list by job_id (?job_id=)
 *
 * The route fires BEFORE the PDF render — the inspector taps both
 * tick-boxes, the client submits the pair, the server writes both
 * rows atomically, and only then does the client trigger the existing
 * iOS WKWebView render or the existing web /api/generate-pdf flow.
 *
 * On a downstream render failure, the rows stay (they record a real
 * inspector act) and the client may retry the render without
 * re-prompting — the attestation_ids returned here are the receipt.
 * This is the spec's only "no re-prompt" case.
 *
 * The route does NOT itself enforce job ownership — the iOS app only
 * ever supplies a job_id from the user's own dashboard, and an
 * attacker forging a `job_id` for someone else's job would write
 * audit-trail rows pointing at someone else's PDF without affecting
 * the actual cert content. Still: belt-and-braces, the route checks
 * the job belongs to the authenticated user before recording.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as db from '../db.js';
import logger from '../logger.js';
import {
  CURRENT_VERSIONS,
  isCurrentVersion,
  VALID_ATTESTATION_KINDS,
} from '../lib/legal-text-versions.js';

const router = Router();

const ATTESTED_AT_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const ATTESTED_AT_FUTURE_LIMIT_MS = 60 * 1000;

/**
 * POST /api/cert-attestations/accept
 *
 * Body:
 *   {
 *     job_id: string,
 *     pdf_s3_key?: string,             // optional; can be stamped later
 *     attestations: [
 *       { kind: 'readings',     text_version, attested_at, platform, platform_version },
 *       { kind: 'observations', text_version, attested_at, platform, platform_version }
 *     ]
 *   }
 *
 * Validation:
 *   - exactly 2 attestations, kinds = {'readings','observations'}
 *   - each kind's text_version must be the current one
 *   - each attested_at within ±5 min of server time
 *   - job belongs to the authenticated user
 */
router.post('/accept', auth.requireAuth, async (req, res) => {
  try {
    const { job_id: jobId, pdf_s3_key: pdfS3Key, attestations } = req.body || {};

    if (!jobId) {
      return res.status(400).json({ code: 'invalid_body', error: 'job_id is required' });
    }
    if (!Array.isArray(attestations) || attestations.length !== 2) {
      return res
        .status(400)
        .json({ code: 'invalid_body', error: 'exactly 2 attestations are required' });
    }

    const kinds = new Set(attestations.map((a) => a?.kind));
    for (const k of VALID_ATTESTATION_KINDS) {
      if (!kinds.has(k)) {
        return res
          .status(400)
          .json({ code: 'missing_kind', error: `attestation kind '${k}' is required` });
      }
    }
    if (kinds.size !== 2) {
      return res
        .status(400)
        .json({ code: 'duplicate_kind', error: 'each kind must appear exactly once' });
    }

    const now = Date.now();
    const normalised = [];
    for (const att of attestations) {
      const {
        kind,
        text_version: textVersion,
        attested_at: attestedAtRaw,
        platform,
        platform_version: platformVersion,
      } = att || {};

      if (!kind || !textVersion || !attestedAtRaw || !platform) {
        return res.status(400).json({
          code: 'invalid_attestation_body',
          error: 'kind, text_version, attested_at, platform are all required per attestation',
        });
      }

      const wordingKind = `cert_attestation_${kind}`;
      if (!isCurrentVersion(wordingKind, textVersion)) {
        return res.status(400).json({
          code: 'stale_text_version',
          error: `text_version ${textVersion} is not the current version for ${kind}`,
          kind,
          current_version: CURRENT_VERSIONS[wordingKind],
        });
      }

      const attestedAt = new Date(attestedAtRaw);
      if (Number.isNaN(attestedAt.getTime())) {
        return res
          .status(400)
          .json({ code: 'bad_timestamp', error: 'attested_at is not a valid ISO8601 timestamp' });
      }
      if (
        attestedAt.getTime() < now - ATTESTED_AT_SKEW_TOLERANCE_MS ||
        attestedAt.getTime() > now + ATTESTED_AT_FUTURE_LIMIT_MS
      ) {
        return res
          .status(400)
          .json({ code: 'clock_skew', error: 'attested_at is too far from server time' });
      }

      if (platform !== 'ios' && platform !== 'web') {
        return res
          .status(400)
          .json({ code: 'unknown_platform', error: `unknown platform: ${platform}` });
      }

      normalised.push({
        kind,
        textVersion,
        attestedAt,
        platform,
        platformVersion,
      });
    }

    // Belt-and-braces job-ownership check.
    let jobBelongs = true;
    try {
      const queryResult = await db.query('SELECT user_id FROM jobs WHERE id = $1 LIMIT 1', [jobId]);
      if (queryResult.rows.length > 0) {
        jobBelongs = queryResult.rows[0].user_id === req.user.id;
      }
      // If the job row doesn't exist (e.g. local dev iOS path before
      // job sync lands), allow — the audit trail still has the
      // user_id + job_id and is meaningful for forensic correlation.
    } catch (err) {
      logger.warn('cert_attestations_job_check_open', { error: err.message });
    }
    if (!jobBelongs) {
      return res
        .status(403)
        .json({ code: 'not_your_job', error: 'job does not belong to authenticated user' });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const rows = await db.recordCertAttestations({
      userId: req.user.id,
      jobId,
      pdfS3Key,
      attestations: normalised,
      ipAddress: typeof ipAddress === 'string' ? ipAddress.split(',')[0].trim() : null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    });

    logger.info('cert_attestations_accepted', {
      user_id: req.user.id,
      job_id: jobId,
      attestation_ids: rows.map((r) => r.id),
    });

    return res.status(200).json({
      ok: true,
      attestation_ids: rows.map((r) => r.id),
      rows,
    });
  } catch (err) {
    logger.error('cert_attestations_accept_failed', {
      error: err.message,
      user_id: req.user?.id,
    });
    return res.status(500).json({ code: 'server_error', error: 'failed to record attestations' });
  }
});

/**
 * PATCH /api/cert-attestations/pdf-key
 *
 * Stamp the PDF S3 key onto attestations whose render has just
 * completed. Useful when the render is async / two-step.
 *
 * Body: { attestation_ids: number[], pdf_s3_key: string }
 */
router.patch('/pdf-key', auth.requireAuth, async (req, res) => {
  try {
    const { attestation_ids: attestationIds, pdf_s3_key: pdfS3Key } = req.body || {};
    if (!Array.isArray(attestationIds) || attestationIds.length === 0 || !pdfS3Key) {
      return res.status(400).json({
        code: 'invalid_body',
        error: 'attestation_ids[] and pdf_s3_key are required',
      });
    }
    // Per-id ownership is enforced at insert; we don't allow stamping
    // attestations the user doesn't own. Belt-and-braces: query the
    // user_id on each row before updating.
    const ownership = await db.query(
      `SELECT id, user_id FROM cert_attestations WHERE id = ANY($1::int[])`,
      [attestationIds]
    );
    for (const r of ownership.rows) {
      if (r.user_id !== req.user.id) {
        return res.status(403).json({
          code: 'not_your_attestation',
          error: `attestation ${r.id} does not belong to user`,
        });
      }
    }
    const updated = await db.updateAttestationPdfKey(attestationIds, pdfS3Key);
    return res.json({ ok: true, updated });
  } catch (err) {
    logger.error('cert_attestations_pdf_key_failed', {
      error: err.message,
      user_id: req.user?.id,
    });
    return res.status(500).json({ code: 'server_error', error: 'failed to update pdf key' });
  }
});

/**
 * GET /api/cert-attestations?job_id=<id>
 *
 * List all attestations for a job, owned by the authenticated user.
 * Used by Settings → Issued certificates and by support / audit
 * pulls. Sorted recorded_at DESC.
 */
router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const jobId = req.query.job_id;
    if (!jobId || typeof jobId !== 'string') {
      return res
        .status(400)
        .json({ code: 'invalid_query', error: 'job_id query param is required' });
    }
    const rows = await db.getAttestationsForJob(req.user.id, jobId);
    return res.json({ ok: true, attestations: rows });
  } catch (err) {
    logger.error('cert_attestations_list_failed', { error: err.message, user_id: req.user?.id });
    return res.status(500).json({ code: 'server_error', error: 'failed to read attestations' });
  }
});

export default router;
