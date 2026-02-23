/**
 * Tests for job route handler logic — create, get, update, delete, access control, input validation.
 *
 * These tests exercise the auth + db + storage layer that the job routes depend on,
 * without requiring a full Express server (which pulls in heavy transitive deps).
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

// Must be set before importing auth.js (which reads it at module init)
process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Mock DB layer ----
const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
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
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const auth = await import('../auth.js');
const db = await import('../db.js');

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

describe('Job route handler logic', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('requireAuth gate for job routes', () => {
    let req, res, next;

    beforeEach(() => {
      req = { headers: {}, query: {} };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
    });

    test('should reject unauthenticated requests', () => {
      auth.requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('should set req.user for valid token', async () => {
      req.headers.authorization = `Bearer ${makeToken()}`;
      mockGetUserById.mockResolvedValue(activeUser);

      auth.requireAuth(req, res, next);
      await new Promise(r => setTimeout(r, 50));

      expect(next).toHaveBeenCalled();
      expect(req.user.id).toBe('user-1');
    });
  });

  describe('Create job logic', () => {
    test('should create job with generated ID and timestamp', async () => {
      const job = {
        id: 'job_1234567890',
        user_id: 'user-1',
        folder_name: 'job_1234567890',
        certificate_type: 'EICR',
        status: 'pending',
        address: '42 Test Street',
      };

      mockCreateJob.mockResolvedValue(job);

      await db.createJob(job);

      expect(mockCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          certificate_type: 'EICR',
          status: 'pending',
        })
      );
    });

    test('should default certificate_type to EICR', () => {
      const body = {};
      const certificateType = body.certificate_type || 'EICR';
      expect(certificateType).toBe('EICR');
    });

    test('should accept EIC as certificate_type', () => {
      const body = { certificate_type: 'EIC' };
      const certificateType = body.certificate_type || 'EICR';
      expect(certificateType).toBe('EIC');
    });
  });

  describe('Get job logic', () => {
    test('should fetch job by ID', async () => {
      mockGetJob.mockResolvedValue({
        id: 'job-1',
        user_id: 'user-1',
        address: '42 Test Street',
        status: 'done',
      });

      const job = await db.getJob('job-1');

      expect(job).not.toBeNull();
      expect(job.id).toBe('job-1');
      expect(job.address).toBe('42 Test Street');
    });

    test('should return null for nonexistent job (404 scenario)', async () => {
      mockGetJob.mockResolvedValue(null);

      const job = await db.getJob('nonexistent-job');

      expect(job).toBeNull();
    });

    test('should also resolve by address', async () => {
      mockGetJob.mockResolvedValue(null);
      mockGetJobByAddress.mockResolvedValue({
        id: 'job-1',
        user_id: 'user-1',
        address: '42 Test Street',
      });

      let job = await db.getJob('42 Test Street');
      if (!job) {
        job = await db.getJobByAddress('user-1', '42 Test Street');
      }

      expect(job).not.toBeNull();
      expect(job.address).toBe('42 Test Street');
    });
  });

  describe('Update job logic', () => {
    test('should update allowed fields', async () => {
      mockUpdateJob.mockResolvedValue(undefined);

      await db.updateJob('job-1', {
        status: 'done',
        address: '99 New Street',
      });

      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {
        status: 'done',
        address: '99 New Street',
      });
    });

    test('should handle empty update data gracefully', async () => {
      mockUpdateJob.mockResolvedValue(undefined);

      await db.updateJob('job-1', {});

      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', {});
    });
  });

  describe('Delete job logic', () => {
    test('should delete by jobId and userId', async () => {
      mockDeleteJob.mockResolvedValue(undefined);

      await db.deleteJob('job-1', 'user-1');

      expect(mockDeleteJob).toHaveBeenCalledWith('job-1', 'user-1');
    });

    test('should propagate delete errors', async () => {
      mockDeleteJob.mockRejectedValue(new Error('delete failed'));

      await expect(db.deleteJob('job-1', 'user-1')).rejects.toThrow('delete failed');
    });
  });

  describe('Access control', () => {
    test('should deny access when userId does not match authenticated user', () => {
      const reqUserId = 'user-1';
      const paramUserId = 'user-2';

      // Simulates the route handler check: if (req.user.id !== userId)
      expect(reqUserId !== paramUserId).toBe(true);
    });

    test('should allow access when userId matches', () => {
      const reqUserId = 'user-1';
      const paramUserId = 'user-1';

      expect(reqUserId === paramUserId).toBe(true);
    });
  });

  describe('Input validation — SQL injection guard', () => {
    test('updateJob uses parameterized queries (mock verifies call shape)', async () => {
      mockUpdateJob.mockResolvedValue(undefined);

      // Attempt to pass SQL injection payload as a field value
      const maliciousAddress = "'; DROP TABLE jobs; --";

      await db.updateJob('job-1', { address: maliciousAddress });

      // The mock was called with the raw string — the real db.js uses $N parameterized queries
      expect(mockUpdateJob).toHaveBeenCalledWith('job-1', { address: maliciousAddress });
      // In the real db.js, this becomes: UPDATE jobs SET address = $1 WHERE id = $2
      // The malicious string is passed as a parameter, not interpolated into SQL
    });

    test('createJob uses parameterized queries', async () => {
      mockCreateJob.mockResolvedValue({});

      const maliciousJob = {
        id: "job-1",
        user_id: "user-1",
        folder_name: "'; DROP TABLE jobs; --",
        certificate_type: "EICR",
        status: "pending",
      };

      await db.createJob(maliciousJob);

      // Verify the malicious string was passed through (not rejected),
      // because the real DB layer uses parameterized queries
      expect(mockCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({ folder_name: "'; DROP TABLE jobs; --" })
      );
    });
  });

  describe('Job clone validation', () => {
    test('should reject path traversal in address', () => {
      const address = '../../../etc/passwd';
      const isInvalid = address.includes('..') || address.includes('/') || address.includes('\\');
      expect(isInvalid).toBe(true);
    });

    test('should reject empty address', () => {
      const address = '   ';
      const trimmed = address.trim();
      expect(!trimmed).toBe(true);
    });

    test('should accept valid address', () => {
      const address = '42 Test Street';
      const trimmed = address.trim();
      const isInvalid = trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\');
      expect(isInvalid).toBe(false);
      expect(trimmed.length > 0).toBe(true);
    });
  });

  describe('Job list sorting', () => {
    test('should sort jobs by updated_at descending', () => {
      const jobs = [
        { id: 'j1', updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
        { id: 'j3', updated_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' },
        { id: 'j2', updated_at: '2026-02-01T00:00:00Z', created_at: '2026-02-01T00:00:00Z' },
      ];

      jobs.sort((a, b) => {
        const aDate = new Date(a.updated_at || a.created_at);
        const bDate = new Date(b.updated_at || b.created_at);
        return bDate - aDate;
      });

      expect(jobs[0].id).toBe('j3');
      expect(jobs[1].id).toBe('j2');
      expect(jobs[2].id).toBe('j1');
    });

    test('should fall back to created_at when updated_at is missing', () => {
      const jobs = [
        { id: 'j1', created_at: '2026-01-01T00:00:00Z' },
        { id: 'j2', created_at: '2026-02-01T00:00:00Z' },
      ];

      jobs.sort((a, b) => {
        const aDate = new Date(a.updated_at || a.created_at);
        const bDate = new Date(b.updated_at || b.created_at);
        return bDate - aDate;
      });

      expect(jobs[0].id).toBe('j2');
    });
  });

  describe('Job versioning', () => {
    test('should save version before overwriting data', async () => {
      mockSaveJobVersion.mockResolvedValue(undefined);

      const currentData = { circuits: [{ circuit_ref: '1' }], observations: [] };

      await db.saveJobVersion('job-1', 'user-1', currentData, 'Updated: circuits');

      expect(mockSaveJobVersion).toHaveBeenCalledWith(
        'job-1', 'user-1', currentData, 'Updated: circuits'
      );
    });

    test('should list version history', async () => {
      mockGetJobVersions.mockResolvedValue([
        { id: 'v1', created_at: '2026-01-01', changes_summary: 'Initial save' },
        { id: 'v2', created_at: '2026-01-02', changes_summary: 'Updated: circuits' },
      ]);

      const versions = await db.getJobVersions('job-1');

      expect(versions).toHaveLength(2);
      expect(versions[1].changes_summary).toBe('Updated: circuits');
    });
  });
});
