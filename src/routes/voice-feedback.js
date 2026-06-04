/**
 * Voice-feedback router — PLAN-backend-final.md Phase 1.6.4.
 *
 * Routes are deliberately registered in this order — Express matches
 * by registration order, so a parameterised `/:id` defined BEFORE
 * `/admin/all` would capture `/admin/all` as `id="admin"` and the
 * admin endpoint would silently never reach its handler.
 *
 *   GET    /                — list the auth'd user's markers
 *   GET    /admin/all       — list every user's markers (admin only)
 *   GET    /:id             — full detail (owner or admin)
 *   PATCH  /:id             — status + optional review_note (owner or admin)
 *
 * Mount: src/api.js wraps this router with `auth.requireAuth +
 * requireConsent`. The voice-feedback rows may carry homeowner /
 * site context via transcript_window, so consent gating matches the
 * existing recording-router pattern.
 *
 * Kept SEPARATE from src/routes/feedback.js — that one serves the
 * session-optimizer HTML form (GET returns HTML, POST accepts
 * form-encoded). They share neither schema nor consumers.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as db from '../db.js';
import logger from '../logger.js';

const router = Router();

function parseLimit(raw, fallback = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

function parseOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ──────────────────────────────────────────────────────────────────────
// GET /  — list the authenticated user's voice-feedback markers.
//
// Query params (all optional):
//   ?status=open|reviewed|actioned|wontfix
//   ?job_id=<job>           // exact match
//   ?q=<text>               // ILIKE pattern on issue_text
//   ?limit=50&offset=0      // pagination (limit clamped to 200)
//
// Response shape: { items: [...], total: <count> }
// items are LIST projections (issue_preview, no transcript_window) —
// callers wanting the full row hit GET /:id.
// ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, job_id: jobId, q } = req.query;
    if (status && !['open', 'reviewed', 'actioned', 'wontfix'].includes(String(status))) {
      return res.status(400).json({ error: `invalid status: ${status}` });
    }
    const { items, total } = await db.listVoiceFeedback({
      userId,
      status: status ? String(status) : null,
      jobId: jobId ? String(jobId) : null,
      q: q ? String(q) : null,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
    });
    res.json({ items, total });
  } catch (err) {
    logger.error('GET /api/voice-feedback failed', { userId: req.user?.id, error: err?.message });
    res.status(500).json({ error: 'voice_feedback list failed' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /admin/all  — list every user's markers (admin only).
//
// MUST be registered before `/:id` — otherwise Express would route
// `/admin/all` to the parameterised handler as id="admin".
// ──────────────────────────────────────────────────────────────────────
router.get('/admin/all', auth.requireAdmin, async (req, res) => {
  try {
    const { status, job_id: jobId, q } = req.query;
    if (status && !['open', 'reviewed', 'actioned', 'wontfix'].includes(String(status))) {
      return res.status(400).json({ error: `invalid status: ${status}` });
    }
    const { items, total } = await db.listVoiceFeedback({
      userId: null,
      includeAllUsers: true,
      status: status ? String(status) : null,
      jobId: jobId ? String(jobId) : null,
      q: q ? String(q) : null,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
    });
    res.json({ items, total });
  } catch (err) {
    logger.error('GET /api/voice-feedback/admin/all failed', {
      adminId: req.user?.id,
      error: err?.message,
    });
    res.status(500).json({ error: 'voice_feedback admin list failed' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /:id  — full detail (issue_text + transcript_window + s3 link).
// Owner-or-admin gate inside the handler (per-row ACL, not middleware).
// ──────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const row = await db.getVoiceFeedback(id);
    if (!row) return res.status(404).json({ error: 'not found' });

    const isOwner = row.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json(row);
  } catch (err) {
    logger.error('GET /api/voice-feedback/:id failed', {
      id: req.params.id,
      userId: req.user?.id,
      error: err?.message,
    });
    res.status(500).json({ error: 'voice_feedback detail failed' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /:id  — status + optional review_note (owner or admin).
//
// Body: { status: 'open'|'reviewed'|'actioned'|'wontfix', review_note?: string }
// Either field is optional; sending neither is rejected at 400 to
// prevent silent no-ops the UI would interpret as a successful write.
// ──────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const { status, review_note: reviewNote } = req.body || {};
    if (status == null && reviewNote == null) {
      return res.status(400).json({ error: 'status or review_note required' });
    }
    if (status && !['open', 'reviewed', 'actioned', 'wontfix'].includes(String(status))) {
      return res.status(400).json({ error: `invalid status: ${status}` });
    }
    if (reviewNote != null && typeof reviewNote !== 'string') {
      return res.status(400).json({ error: 'review_note must be a string' });
    }
    if (typeof reviewNote === 'string' && reviewNote.length > 2000) {
      return res
        .status(400)
        .json({ error: 'review_note exceeds maximum length of 2000 characters' });
    }

    const existing = await db.getVoiceFeedback(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    const isOwner = existing.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const updated = await db.updateVoiceFeedbackStatus(id, {
      status: status || null,
      reviewNote: reviewNote == null ? null : String(reviewNote),
    });
    res.json(updated);
  } catch (err) {
    logger.error('PATCH /api/voice-feedback/:id failed', {
      id: req.params.id,
      userId: req.user?.id,
      error: err?.message,
    });
    res.status(500).json({ error: 'voice_feedback patch failed' });
  }
});

export default router;
