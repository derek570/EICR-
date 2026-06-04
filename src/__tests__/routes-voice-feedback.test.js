/**
 * Tests for /api/voice-feedback/* (PLAN-backend-final.md Phase 1.6.8).
 *
 * Pinned behaviours:
 *   - GET list filters by status / job_id / q + paginates (clamps limit)
 *   - GET /admin/all is admin-only AND registered before /:id so
 *     `/admin/all` is NOT captured as id='admin'
 *   - GET /:id enforces owner-or-admin per-row ACL
 *   - PATCH /:id validates status enum + review_note length + requires
 *     at least one of status/review_note
 *   - PATCH /:id enforces owner-or-admin (cannot patch another user's row)
 */

import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockListVoiceFeedback = jest.fn();
const mockGetVoiceFeedback = jest.fn();
const mockUpdateVoiceFeedbackStatus = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  listVoiceFeedback: mockListVoiceFeedback,
  getVoiceFeedback: mockGetVoiceFeedback,
  updateVoiceFeedbackStatus: mockUpdateVoiceFeedbackStatus,
}));

const errorCalls = [];
jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args) => {
      errorCalls.push(args);
    },
  },
}));

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    const h = req.headers['x-test-user'];
    if (h) req.user = JSON.parse(h);
    next();
  },
  requireAdmin: (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'admin required' });
    }
    next();
  },
}));

const router = (await import('../routes/voice-feedback.js')).default;
const auth = await import('../auth.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Match the production mount at src/api.js — requireAuth lifts the
  // x-test-user header into req.user; the production version reads from
  // the JWT cookie/header. Without this, every handler's req.user.id
  // throws TypeError and the route returns 500.
  app.use('/api/voice-feedback', auth.requireAuth, router);
  return app;
}

const owner = { id: 'user-owner', email: 'owner@example.co.uk', role: 'user' };
const other = { id: 'user-other', email: 'other@example.co.uk', role: 'user' };
const admin = { id: 'user-admin', email: 'admin@example.co.uk', role: 'admin' };

beforeEach(() => {
  mockListVoiceFeedback.mockReset();
  mockGetVoiceFeedback.mockReset();
  mockUpdateVoiceFeedbackStatus.mockReset();
  mockListVoiceFeedback.mockResolvedValue({ items: [], total: 0 });
  errorCalls.length = 0;
});

afterEach(() => {
  if (errorCalls.length) {
    // surface for diagnosis if a handler fell into its 500-catch path

    console.error('logger.error during test:', JSON.stringify(errorCalls, null, 2));
  }
});

describe('GET /api/voice-feedback (list)', () => {
  test('returns owner-scoped list, default pagination', async () => {
    mockListVoiceFeedback.mockResolvedValueOnce({
      items: [{ id: 1, issue_preview: 'cooker tripped', status: 'open' }],
      total: 1,
    });
    const res = await request(buildApp())
      .get('/api/voice-feedback')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(1);
    const call = mockListVoiceFeedback.mock.calls[0][0];
    expect(call.userId).toBe('user-owner');
    expect(call.includeAllUsers).toBeFalsy();
    expect(call.limit).toBe(50);
    expect(call.offset).toBe(0);
  });

  test('forwards status / job_id / q / limit / offset to db', async () => {
    const res = await request(buildApp())
      .get('/api/voice-feedback')
      .query({ status: 'reviewed', job_id: 'job_42', q: 'cooker', limit: 10, offset: 20 })
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(200);
    const call = mockListVoiceFeedback.mock.calls[0][0];
    expect(call.status).toBe('reviewed');
    expect(call.jobId).toBe('job_42');
    expect(call.q).toBe('cooker');
    expect(call.limit).toBe(10);
    expect(call.offset).toBe(20);
  });

  test('rejects invalid status with 400', async () => {
    const res = await request(buildApp())
      .get('/api/voice-feedback')
      .query({ status: 'bogus' })
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(400);
    expect(mockListVoiceFeedback).not.toHaveBeenCalled();
  });

  test('clamps over-large limit to 200', async () => {
    await request(buildApp())
      .get('/api/voice-feedback')
      .query({ limit: 5000 })
      .set('x-test-user', JSON.stringify(owner));
    expect(mockListVoiceFeedback.mock.calls[0][0].limit).toBe(200);
  });
});

describe('GET /api/voice-feedback/admin/all', () => {
  test('admin sees all users', async () => {
    mockListVoiceFeedback.mockResolvedValueOnce({
      items: [{ id: 1, user_id: 'user-other', issue_preview: 'foo' }],
      total: 1,
    });
    const res = await request(buildApp())
      .get('/api/voice-feedback/admin/all')
      .set('x-test-user', JSON.stringify(admin));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const call = mockListVoiceFeedback.mock.calls[0][0];
    expect(call.includeAllUsers).toBe(true);
    expect(call.userId).toBeNull();
  });

  test('non-admin is rejected with 403', async () => {
    const res = await request(buildApp())
      .get('/api/voice-feedback/admin/all')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(403);
    expect(mockListVoiceFeedback).not.toHaveBeenCalled();
  });

  test('route order: /admin/all is NOT swallowed by /:id', async () => {
    // If Express matched /:id first, mockGetVoiceFeedback would be called
    // with id="admin" → coerced to NaN → returned 400. The admin path
    // hitting requireAdmin (and returning 403 for non-admin) is the
    // signal that route registration order is correct.
    const res = await request(buildApp())
      .get('/api/voice-feedback/admin/all')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(403);
    expect(mockGetVoiceFeedback).not.toHaveBeenCalled();
  });
});

describe('GET /api/voice-feedback/:id (detail)', () => {
  test('owner sees their own row', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({
      id: 7,
      user_id: 'user-owner',
      issue_text: 'full text here',
      transcript_window: [{ ts: '2026-06-04T14:10', text: 'hello' }],
    });
    const res = await request(buildApp())
      .get('/api/voice-feedback/7')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(200);
    expect(res.body.issue_text).toBe('full text here');
    expect(res.body.transcript_window).toHaveLength(1);
  });

  test('admin can see any row', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({
      id: 7,
      user_id: 'user-owner',
      issue_text: 'x',
    });
    const res = await request(buildApp())
      .get('/api/voice-feedback/7')
      .set('x-test-user', JSON.stringify(admin));
    expect(res.status).toBe(200);
  });

  test('other user is rejected with 403', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({
      id: 7,
      user_id: 'user-owner',
      issue_text: 'x',
    });
    const res = await request(buildApp())
      .get('/api/voice-feedback/7')
      .set('x-test-user', JSON.stringify(other));
    expect(res.status).toBe(403);
  });

  test('missing row returns 404', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .get('/api/voice-feedback/9999')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(404);
  });

  test('invalid id returns 400', async () => {
    const res = await request(buildApp())
      .get('/api/voice-feedback/abc')
      .set('x-test-user', JSON.stringify(owner));
    expect(res.status).toBe(400);
    expect(mockGetVoiceFeedback).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/voice-feedback/:id', () => {
  test('owner can update status + review_note', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({ id: 5, user_id: 'user-owner', status: 'open' });
    mockUpdateVoiceFeedbackStatus.mockResolvedValueOnce({
      id: 5,
      status: 'reviewed',
      review_note: 'looked at it',
      reviewed_at: new Date(),
    });
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(owner))
      .send({ status: 'reviewed', review_note: 'looked at it' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reviewed');
    expect(mockUpdateVoiceFeedbackStatus).toHaveBeenCalledWith(5, {
      status: 'reviewed',
      reviewNote: 'looked at it',
    });
  });

  test('admin can patch another user', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({ id: 5, user_id: 'user-owner' });
    mockUpdateVoiceFeedbackStatus.mockResolvedValueOnce({ id: 5, status: 'wontfix' });
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(admin))
      .send({ status: 'wontfix' });
    expect(res.status).toBe(200);
  });

  test('other user is rejected with 403', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce({ id: 5, user_id: 'user-owner' });
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(other))
      .send({ status: 'reviewed' });
    expect(res.status).toBe(403);
    expect(mockUpdateVoiceFeedbackStatus).not.toHaveBeenCalled();
  });

  test('rejects invalid status', async () => {
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(owner))
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(mockGetVoiceFeedback).not.toHaveBeenCalled();
  });

  test('rejects empty body (no status, no review_note)', async () => {
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(owner))
      .send({});
    expect(res.status).toBe(400);
    expect(mockGetVoiceFeedback).not.toHaveBeenCalled();
  });

  test('rejects review_note over 2000 chars', async () => {
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(owner))
      .send({ review_note: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  test('row not found returns 404', async () => {
    mockGetVoiceFeedback.mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .patch('/api/voice-feedback/5')
      .set('x-test-user', JSON.stringify(owner))
      .send({ status: 'reviewed' });
    expect(res.status).toBe(404);
  });
});
