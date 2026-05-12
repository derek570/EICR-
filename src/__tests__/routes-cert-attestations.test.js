/**
 * Tests for /api/cert-attestations/*.
 *
 * Pinned behaviours:
 *   - Exactly 2 attestations required, must be {readings, observations}.
 *   - Duplicate kinds rejected.
 *   - Stale text_version rejected.
 *   - Clock-skew tolerance enforced.
 *   - Per-handler atomic write — recordCertAttestations called once
 *     with both rows; iOS/web cannot end up with only one attestation
 *     stored if the other failed validation.
 *   - Job ownership check rejects forged job_id.
 *   - List endpoint filters by user_id + job_id.
 */

import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockRecordCertAttestations = jest.fn();
const mockGetAttestationsForJob = jest.fn();
const mockUpdateAttestationPdfKey = jest.fn();
const mockQuery = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  recordCertAttestations: mockRecordCertAttestations,
  getAttestationsForJob: mockGetAttestationsForJob,
  updateAttestationPdfKey: mockUpdateAttestationPdfKey,
  query: mockQuery,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    const userHeader = req.headers['x-test-user'];
    if (userHeader) req.user = JSON.parse(userHeader);
    next();
  },
}));

const router = (await import('../routes/cert-attestations.js')).default;
const { CURRENT_VERSIONS } = await import('../lib/legal-text-versions.js');

const READINGS_V = CURRENT_VERSIONS.cert_attestation_readings;
const OBS_V = CURRENT_VERSIONS.cert_attestation_observations;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cert-attestations', router);
  return app;
}

const user = { id: 'user-abc', email: 'inspector@example.co.uk', role: 'user' };

function bothAttestations(now = new Date()) {
  return [
    {
      kind: 'readings',
      text_version: READINGS_V,
      attested_at: now.toISOString(),
      platform: 'ios',
      platform_version: '360',
    },
    {
      kind: 'observations',
      text_version: OBS_V,
      attested_at: now.toISOString(),
      platform: 'ios',
      platform_version: '360',
    },
  ];
}

beforeEach(() => {
  mockRecordCertAttestations.mockReset();
  mockGetAttestationsForJob.mockReset();
  mockUpdateAttestationPdfKey.mockReset();
  mockQuery.mockReset();
  // Default: job belongs to caller.
  mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-abc' }] });
  mockRecordCertAttestations.mockResolvedValue([
    { id: 11, attestation_kind: 'readings', attested_at: new Date(), recorded_at: new Date() },
    {
      id: 12,
      attestation_kind: 'observations',
      attested_at: new Date(),
      recorded_at: new Date(),
    },
  ]);
});

describe('POST /api/cert-attestations/accept', () => {
  test('happy path — writes both attestations atomically', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'job-1',
        attestations: bothAttestations(),
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.attestation_ids).toEqual([11, 12]);
    expect(mockRecordCertAttestations).toHaveBeenCalledTimes(1);
    const arg = mockRecordCertAttestations.mock.calls[0][0];
    expect(arg.attestations).toHaveLength(2);
    const kinds = arg.attestations.map((a) => a.kind).sort();
    expect(kinds).toEqual(['observations', 'readings']);
  });

  test('rejects fewer than 2 attestations', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'job-1',
        attestations: [bothAttestations()[0]],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
    expect(mockRecordCertAttestations).not.toHaveBeenCalled();
  });

  test('rejects 2 of the same kind (missing the other)', async () => {
    const app = buildApp();
    const both = bothAttestations();
    both[1] = { ...both[0] }; // both 'readings'
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'job-1',
        attestations: both,
      });
    expect(res.status).toBe(400);
    expect(['missing_kind', 'duplicate_kind']).toContain(res.body.code);
  });

  test('rejects stale text_version', async () => {
    const app = buildApp();
    const both = bothAttestations();
    both[0].text_version = '2024-01-01';
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'job-1',
        attestations: both,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('stale_text_version');
    expect(res.body.kind).toBe('readings');
  });

  test('rejects clock-skewed attested_at (>5 min in the past)', async () => {
    const app = buildApp();
    const both = bothAttestations();
    both[0].attested_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'job-1',
        attestations: both,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('clock_skew');
  });

  test('rejects job that belongs to another user', async () => {
    mockQuery.mockResolvedValue({ rows: [{ user_id: 'user-other' }] });
    const app = buildApp();
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'forged-job-id',
        attestations: bothAttestations(),
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_job');
    expect(mockRecordCertAttestations).not.toHaveBeenCalled();
  });

  test('allows when job row is missing (local-dev / sync-pending path)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .post('/api/cert-attestations/accept')
      .set('x-test-user', JSON.stringify(user))
      .send({
        job_id: 'local-only-job',
        attestations: bothAttestations(),
      });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/cert-attestations', () => {
  test('lists attestations for a job', async () => {
    mockGetAttestationsForJob.mockResolvedValue([
      { id: 11, attestation_kind: 'readings' },
      { id: 12, attestation_kind: 'observations' },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get('/api/cert-attestations?job_id=job-1')
      .set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(200);
    expect(res.body.attestations).toHaveLength(2);
    expect(mockGetAttestationsForJob).toHaveBeenCalledWith('user-abc', 'job-1');
  });

  test('rejects missing job_id', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/cert-attestations')
      .set('x-test-user', JSON.stringify(user));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query');
  });
});

describe('PATCH /api/cert-attestations/pdf-key', () => {
  test('stamps the PDF key after the render lands', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 11, user_id: 'user-abc' },
        { id: 12, user_id: 'user-abc' },
      ],
    });
    mockUpdateAttestationPdfKey.mockResolvedValue(2);
    const app = buildApp();
    const res = await request(app)
      .patch('/api/cert-attestations/pdf-key')
      .set('x-test-user', JSON.stringify(user))
      .send({
        attestation_ids: [11, 12],
        pdf_s3_key: 'jobs/user-abc/job-1/output/eicr_certificate.pdf',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  test('refuses to stamp attestations owned by a different user', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 11, user_id: 'user-other' }],
    });
    const app = buildApp();
    const res = await request(app)
      .patch('/api/cert-attestations/pdf-key')
      .set('x-test-user', JSON.stringify(user))
      .send({
        attestation_ids: [11],
        pdf_s3_key: 'jobs/user-other/job-x/output/c.pdf',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_your_attestation');
  });
});
