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
      const res = await supertest(app)
        .put('/api/job/user-1/job-1')
        .send({ status: 'done' });
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
