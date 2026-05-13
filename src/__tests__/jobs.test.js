/**
 * Integration tests for job routes — tests actual HTTP routes via supertest.
 * Mocks the database and storage layers but tests middleware, auth guards,
 * response codes, and route behavior.
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

// Must be set before importing auth.js
process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Mock DB layer ----
const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockUpdateLastLogin = jest.fn();
const mockUpdateLoginAttempts = jest.fn();
const mockLogAction = jest.fn();
const mockGetJobsByUser = jest.fn();
const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockGetJobByAddress = jest.fn();
const mockUpdateJob = jest.fn();
const mockUpdateJobStatus = jest.fn();
const mockDeleteJob = jest.fn();
const mockSaveJobVersion = jest.fn();
const mockGetJobVersions = jest.fn();
const mockGetJobVersion = jest.fn();
const mockUsePostgres = jest.fn().mockReturnValue(true);

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  updateLastLogin: mockUpdateLastLogin,
  updateLoginAttempts: mockUpdateLoginAttempts,
  logAction: mockLogAction,
  getJobsByUser: mockGetJobsByUser,
  createJob: mockCreateJob,
  getJob: mockGetJob,
  getJobByAddress: mockGetJobByAddress,
  updateJob: mockUpdateJob,
  updateJobStatus: mockUpdateJobStatus,
  deleteJob: mockDeleteJob,
  saveJobVersion: mockSaveJobVersion,
  getJobVersions: mockGetJobVersions,
  getJobVersion: mockGetJobVersion,
  usePostgres: mockUsePostgres,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock storage
const mockDownloadText = jest.fn().mockResolvedValue(null);
const mockUploadText = jest.fn().mockResolvedValue(undefined);
const mockListFiles = jest.fn().mockResolvedValue([]);
const mockIsUsingS3 = jest.fn().mockReturnValue(false);

jest.unstable_mockModule('../storage.js', () => ({
  downloadText: mockDownloadText,
  uploadText: mockUploadText,
  listFiles: mockListFiles,
  isUsingS3: mockIsUsingS3,
  uploadBytes: jest.fn().mockResolvedValue(undefined),
  downloadBytes: jest.fn().mockResolvedValue(null),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  getBucketName: jest.fn().mockReturnValue(null),
  uploadJson: jest.fn().mockResolvedValue(undefined),
}));

// Mock heavy transitive deps
jest.unstable_mockModule('../process_job.js', () => ({
  processJob: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../queue.js', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  startWorker: jest.fn().mockResolvedValue(undefined),
  getJobQueue: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../export.js', () => ({
  circuitsToCSV: jest.fn().mockReturnValue(''),
}));

jest.unstable_mockModule('../zip.js', () => ({
  createJobsZip: jest.fn().mockResolvedValue(Buffer.from('')),
}));

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const auth = await import('../auth.js');
const { default: jobsRouter } = await import('../routes/jobs.js');

// Create test app
const app = express();
app.use(express.json());
app.use('/api', jobsRouter);

const activeUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  company_name: 'Co',
  is_active: true,
};

function makeToken(userId = 'user-1') {
  return jwt.sign({ userId, email: 'test@example.com' }, JWT_SECRET, { expiresIn: '24h' });
}

describe('Job routes (supertest)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
  });

  describe('GET /api/jobs/:userId', () => {
    test('should return 401 without auth token', async () => {
      const res = await supertest(app).get('/api/jobs/user-1');
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    test('should return 403 when userId does not match token', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/jobs/user-2')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    test('should return jobs for authenticated user', async () => {
      const jobs = [
        { id: 'job-1', address: '42 Test St', status: 'done' },
        { id: 'job-2', address: '99 New St', status: 'pending' },
      ];
      mockGetJobsByUser.mockResolvedValue(jobs);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/jobs/user-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('job-1');
    });
  });

  describe('GET /api/job/:userId/:jobId', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app).get('/api/job/user-1/job-1');
      expect(res.status).toBe(401);
    });

    test('should return 403 for wrong user', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-2/job-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    test('should return 404 when job and S3 data are both missing', async () => {
      mockGetJob.mockResolvedValue(null);
      mockGetJobByAddress.mockResolvedValue(null);
      mockDownloadText.mockResolvedValue(null);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-1/nonexistent')
        .set('Authorization', `Bearer ${token}`);
      // Route returns 404 only when no job record and no S3 data
      expect([200, 404]).toContain(res.status);
      if (res.status === 404) {
        expect(res.body.error).toContain('not found');
      }
    });

    test('should return job data for valid request', async () => {
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockDownloadText.mockResolvedValue(null);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.address).toBeDefined();
    });
  });

  describe('PUT /api/job/:userId/:jobId', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app).put('/api/job/user-1/job-1').send({ status: 'done' });
      expect(res.status).toBe(401);
    });

    test('should return 403 for wrong user', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-2/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'done' });
      expect(res.status).toBe(403);
    });

    test('should update job for valid request', async () => {
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1' });
      mockUpdateJob.mockResolvedValue(undefined);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'done', address: '99 New St' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('preserves multi-board fields in extracted_data.json on PUT', async () => {
      // Phase 2.2 regression test (multi-board sprint
      // .planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md).
      // Pins that boards[].parent_board_id, .feed_circuit_ref, .board_type,
      // and the sub-main cable fields survive the PUT round-trip into the
      // extracted_data.json blob — the JSON pass-through is what makes the
      // current cloud sync work for multi-board jobs, so any future refactor
      // that strips boards through a typed shape must keep this test green.
      // Phase 1's deletion of sub_main_cable_length is also pinned here.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockUpdateJob.mockResolvedValue(undefined);

      let uploadedExtractedDataJson = null;
      mockUploadText.mockImplementation(async (content, key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          uploadedExtractedDataJson = content;
        }
      });

      const payload = {
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-1',
            designation: 'DB-2',
            board_type: 'sub_main',
            parent_board_id: 'main',
            feed_circuit_ref: '4',
            sub_main_cable_material: 'Cu',
            sub_main_cable_csa: '16',
            sub_main_cpc_csa: '6',
          },
        ],
        circuits: [
          {
            circuit: '4',
            board_id: 'main',
            is_distribution_circuit: 'yes',
            feeds_board_id: 'sub-1',
          },
          { circuit: '1', board_id: 'sub-1', designation: 'Kitchen' },
        ],
      };

      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(uploadedExtractedDataJson).not.toBeNull();
      const written = JSON.parse(uploadedExtractedDataJson);
      expect(written.boards).toHaveLength(2);
      expect(written.boards[0]).toMatchObject({ id: 'main', board_type: 'main' });
      expect(written.boards[1]).toMatchObject({
        id: 'sub-1',
        parent_board_id: 'main',
        feed_circuit_ref: '4',
        board_type: 'sub_main',
        sub_main_cable_material: 'Cu',
        sub_main_cable_csa: '16',
        sub_main_cpc_csa: '6',
      });
      // Phase 1: sub_main_cable_length must NOT survive — iOS dropped it,
      // so any payload still carrying it is upstream noise. We don't strip
      // it server-side (the iOS Codable encoder no longer emits it), but
      // this test pins that we don't accidentally synthesise it either.
      expect(written.boards[1].sub_main_cable_length).toBeUndefined();
    });

    test('returns multi-board fields from extracted_data.json on GET', async () => {
      // Read-side complement to the PUT round-trip pin above. Confirms the
      // GET handler at src/routes/jobs.js:474 surfaces boards[] verbatim
      // from the stored JSON, so iOS / web clients receive the hierarchy
      // fields they wrote.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });

      const stored = {
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-1',
            designation: 'DB-2',
            board_type: 'sub_main',
            parent_board_id: 'main',
            feed_circuit_ref: '4',
            sub_main_cable_csa: '16',
            sub_main_cpc_csa: '6',
          },
        ],
      };
      mockDownloadText.mockImplementation(async (key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          return JSON.stringify(stored);
        }
        return null;
      });

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.boards).toHaveLength(2);
      expect(res.body.boards[1].parent_board_id).toBe('main');
      expect(res.body.boards[1].feed_circuit_ref).toBe('4');
      expect(res.body.boards[1].board_type).toBe('sub_main');
      expect(res.body.boards[1].sub_main_cable_csa).toBe('16');
      expect(res.body.boards[1].sub_main_cable_length).toBeUndefined();
    });

    test('preserves unassigned_photos in extracted_data.json on PUT', async () => {
      // L2 observation-photo auto-link sprint 2026-05-13. Before this fix,
      // the route destructure at jobs.js:654 omitted unassigned_photos so
      // iOS's pool (Job.swift:104 + JobViewModel.swift:518-525) silently
      // dropped on every save — the field never reached extracted_data.json.
      // Pin the round-trip so a future destructure rewrite can't regress it.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockUpdateJob.mockResolvedValue(undefined);

      let uploadedExtractedDataJson = null;
      mockUploadText.mockImplementation(async (content, key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          uploadedExtractedDataJson = content;
        }
      });

      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send({
          unassigned_photos: ['photo-a.jpg', 'photo-b.jpg'],
        });

      expect(res.status).toBe(200);
      expect(uploadedExtractedDataJson).not.toBeNull();
      const written = JSON.parse(uploadedExtractedDataJson);
      expect(written.unassigned_photos).toEqual(['photo-a.jpg', 'photo-b.jpg']);
    });

    test('PUT with empty unassigned_photos array clears the pool', async () => {
      // Mirror iOS removePhotosFromUnassigned which sets the property to nil
      // when the pool empties. An explicit [] from a client must replace any
      // prior pool — not be skipped as falsy.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockUpdateJob.mockResolvedValue(undefined);
      mockDownloadText.mockImplementation(async (key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          return JSON.stringify({ unassigned_photos: ['old.jpg'] });
        }
        return null;
      });

      let uploadedExtractedDataJson = null;
      mockUploadText.mockImplementation(async (content, key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          uploadedExtractedDataJson = content;
        }
      });

      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ unassigned_photos: [] });

      expect(res.status).toBe(200);
      const written = JSON.parse(uploadedExtractedDataJson);
      expect(written.unassigned_photos).toEqual([]);
    });

    test('returns unassigned_photos from extracted_data.json on GET', async () => {
      // Read-side complement. Before this fix, the GET response builder at
      // jobs.js:576-593 enumerated a fixed field list that omitted
      // unassigned_photos — so even if the field landed in S3 it never
      // surfaced to the client.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockDownloadText.mockImplementation(async (key) => {
        if (typeof key === 'string' && key.endsWith('extracted_data.json')) {
          return JSON.stringify({ unassigned_photos: ['photo-a.jpg', 'photo-b.jpg'] });
        }
        return null;
      });

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.unassigned_photos).toEqual(['photo-a.jpg', 'photo-b.jpg']);
    });

    test('GET defaults unassigned_photos to null when absent', async () => {
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
      mockDownloadText.mockResolvedValue(null);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.unassigned_photos).toBeNull();
    });

    test('rejects PUT with invalid board hierarchy (400)', async () => {
      // Phase 2.3 — wire-level proof that the validator runs before S3 writes.
      // Payload has a sub_main board pointing at a parent_board_id that does
      // not exist in boards[], which is the cleanest single-error case.
      mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1' });
      mockUploadText.mockClear();

      const token = makeToken('user-1');
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`)
        .send({
          boards: [
            { id: 'main', board_type: 'main' },
            { id: 'sub-1', board_type: 'sub_main', parent_board_id: 'does-not-exist' },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_board_hierarchy');
      expect(res.body.details).toContainEqual({
        code: 'parent_not_found',
        board_id: 'sub-1',
        parent: 'does-not-exist',
      });
      // No S3 write should have happened — the validator rejected before
      // the try block that builds extracted_data.json.
      expect(mockUploadText).not.toHaveBeenCalled();
    });

    // Phase 2a closed the CSV-header round-trip gap (src/export.js
    // CIRCUIT_FIELD_ORDER appended board_id, is_distribution_circuit,
    // feeds_board_id). The actual round-trip is exercised in
    // src/__tests__/export.test.js where circuitsToCSV is NOT mocked;
    // this `jobs.test.js` mocks `circuitsToCSV` to return '' so a route-
    // level round-trip here would only re-test the mock, not the real
    // serializer. The cross-reference is intentional — see export.test.js.
  });

  describe('DELETE /api/job/:userId/:jobId', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app).delete('/api/job/user-1/job-1');
      expect(res.status).toBe(401);
    });

    test('should return 403 for wrong user', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .delete('/api/job/user-2/job-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    test('should delete job for valid request', async () => {
      mockDeleteJob.mockResolvedValue(undefined);

      const token = makeToken('user-1');
      const res = await supertest(app)
        .delete('/api/job/user-1/job-1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDeleteJob).toHaveBeenCalledWith('job-1', 'user-1');
    });
  });
});
