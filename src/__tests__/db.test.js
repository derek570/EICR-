/**
 * Tests for db module — PostgreSQL query functions with mocked pg Pool.
 */

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

jest.unstable_mockModule('pg', () => ({
  default: {
    Pool: jest.fn(() => ({
      query: mockQuery,
      on: jest.fn(),
    })),
  },
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Set DATABASE_URL so usePostgres() returns true
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/testdb';

const db = await import('../db.js');

describe('db', () => {
  afterEach(() => {
    mockQuery.mockReset();
  });

  describe('usePostgres', () => {
    test('should return true when DATABASE_URL is set to postgres', () => {
      expect(db.usePostgres()).toBe(true);
    });
  });

  describe('getUserByEmail', () => {
    test('should query with lowercase email', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'user-1', email: 'test@example.com' }] });

      const user = await db.getUserByEmail('TEST@Example.com');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM users WHERE email = $1'),
        ['test@example.com']
      );
      expect(user.id).toBe('user-1');
    });

    test('should return null when user not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const user = await db.getUserByEmail('nobody@example.com');

      expect(user).toBeNull();
    });

    test('should throw on database error', async () => {
      mockQuery.mockRejectedValue(new Error('connection refused'));

      await expect(db.getUserByEmail('test@example.com')).rejects.toThrow('connection refused');
    });
  });

  describe('getUserById', () => {
    test('should return user by ID', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'user-1', name: 'Test' }] });

      const user = await db.getUserById('user-1');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM users WHERE id = $1'), [
        'user-1',
      ]);
      expect(user.name).toBe('Test');
    });

    test('should return null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      expect(await db.getUserById('nonexistent')).toBeNull();
    });
  });

  describe('getJobsByUser', () => {
    test('should query with COALESCE and timestamp cast', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'job-1' }] });

      const jobs = await db.getJobsByUser('user-1');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('created_at::TIMESTAMP'), [
        'user-1',
      ]);
      expect(jobs).toEqual([{ id: 'job-1' }]);
    });

    test('should return empty array on error', async () => {
      mockQuery.mockRejectedValue(new Error('query failed'));

      const jobs = await db.getJobsByUser('user-1');

      expect(jobs).toEqual([]);
    });
  });

  describe('createJob', () => {
    test('should insert job with all fields', async () => {
      mockQuery.mockResolvedValue({});

      const job = {
        id: 'job-1',
        user_id: 'user-1',
        folder_name: 'test-folder',
        certificate_type: 'EICR',
        status: 'pending',
        address: '123 Test St',
        client_name: 'Test Client',
        s3_prefix: 'jobs/user-1/123-test-st',
      };

      const result = await db.createJob(job);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO jobs'),
        expect.arrayContaining(['job-1', 'user-1', 'test-folder'])
      );
      expect(result).toBe(job);
    });

    test('should throw on insert error', async () => {
      mockQuery.mockRejectedValue(new Error('duplicate key'));

      await expect(db.createJob({ id: 'job-1', user_id: 'user-1' })).rejects.toThrow(
        'duplicate key'
      );
    });
  });

  describe('getJob', () => {
    test('should return job by ID and user_id', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'job-1', status: 'pending' }] });

      const job = await db.getJob('job-1', 'user-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2'),
        ['job-1', 'user-1']
      );
      expect(job.status).toBe('pending');
    });

    test('should return null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      expect(await db.getJob('nonexistent', 'user-1')).toBeNull();
    });
  });

  describe('getJobByAddress', () => {
    test('should query by user_id and address or folder_name', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'job-1', address: '123 Test St' }] });

      const job = await db.getJobByAddress('user-1', '123 Test St');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('address = $2 OR folder_name = $2'),
        ['user-1', '123 Test St']
      );
      expect(job.address).toBe('123 Test St');
    });
  });

  describe('updateJob', () => {
    test('should build dynamic UPDATE query with user_id filter', async () => {
      mockQuery.mockResolvedValue({});

      await db.updateJob('job-1', 'user-1', { status: 'done', address: '456 New St' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE jobs SET'),
        expect.arrayContaining(['done', '456 New St', 'job-1', 'user-1'])
      );
    });

    test('should auto-set updated_at', async () => {
      mockQuery.mockResolvedValue({});

      await db.updateJob('job-1', 'user-1', { status: 'done' });

      const callArgs = mockQuery.mock.calls[0];
      expect(callArgs[0]).toContain('updated_at');
      expect(callArgs[0]).toContain('user_id');
    });

    test('should be no-op for empty data', async () => {
      await db.updateJob('job-1', 'user-1', {});
      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe('updateJobStatus', () => {
    test('should set completed_at when status is done', async () => {
      mockQuery.mockResolvedValue({});

      await db.updateJobStatus('job-1', 'user-1', 'done');

      const query = mockQuery.mock.calls[0][0];
      expect(query).toContain('completed_at');
      expect(query).toContain('updated_at');
    });

    test('should include address when provided', async () => {
      mockQuery.mockResolvedValue({});

      await db.updateJobStatus('job-1', 'user-1', 'processing', '123 Test St');

      const query = mockQuery.mock.calls[0][0];
      expect(query).toContain('address');
    });
  });

  describe('deleteJob', () => {
    test('should delete by jobId and userId', async () => {
      mockQuery.mockResolvedValue({});

      await db.deleteJob('job-1', 'user-1');

      expect(mockQuery).toHaveBeenCalledWith('DELETE FROM jobs WHERE id = $1 AND user_id = $2', [
        'job-1',
        'user-1',
      ]);
    });

    test('should throw on error', async () => {
      mockQuery.mockRejectedValue(new Error('not found'));

      await expect(db.deleteJob('job-1', 'user-1')).rejects.toThrow('not found');
    });
  });

  describe('getJobStats', () => {
    test('should return parsed statistics', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            total: '10',
            completed: '5',
            processing: '3',
            failed: '2',
            eicr_count: '7',
            eic_count: '3',
          },
        ],
      });

      const stats = await db.getJobStats('user-1');

      expect(stats.total).toBe(10);
      expect(stats.completed).toBe(5);
      expect(typeof stats.total).toBe('number');
    });

    test('should return zeros on error', async () => {
      mockQuery.mockRejectedValue(new Error('query failed'));

      const stats = await db.getJobStats('user-1');

      expect(stats.total).toBe(0);
      expect(stats.completed).toBe(0);
    });
  });

  describe('ensureJobsUpdatedAt', () => {
    test('should add column if it does not exist', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // Column doesn't exist
        .mockResolvedValueOnce({}) // ALTER TABLE ADD COLUMN
        .mockResolvedValueOnce({}); // Backfill NULLs

      await db.ensureJobsUpdatedAt();

      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery.mock.calls[1][0]).toContain('ALTER TABLE jobs ADD COLUMN updated_at');
    });

    test('should migrate from TEXT to TIMESTAMP if needed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ data_type: 'text' }] }) // Column exists as TEXT
        .mockResolvedValueOnce({}) // ALTER TYPE
        .mockResolvedValueOnce({}); // Backfill

      await db.ensureJobsUpdatedAt();

      expect(mockQuery.mock.calls[1][0]).toContain(
        'ALTER TABLE jobs ALTER COLUMN updated_at TYPE TIMESTAMP'
      );
    });

    test('should backfill NULLs using created_at::TIMESTAMP cast', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ data_type: 'timestamp without time zone' }] })
        .mockResolvedValueOnce({}); // Only backfill (no ALTER needed)

      await db.ensureJobsUpdatedAt();

      const backfillQuery = mockQuery.mock.calls[1][0];
      expect(backfillQuery).toContain('created_at::TIMESTAMP');
    });
  });

  describe('CRM operations', () => {
    test('getClients should return sorted results', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'c1', name: 'Alice' }] });

      const clients = await db.getClients('user-1');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ORDER BY name ASC'), [
        'user-1',
      ]);
      expect(clients).toEqual([{ id: 'c1', name: 'Alice' }]);
    });

    test('createClient should insert and return with ID', async () => {
      mockQuery.mockResolvedValue({});

      const client = await db.createClient({
        user_id: 'user-1',
        name: 'New Client',
        email: 'new@example.com',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO clients'),
        expect.any(Array)
      );
      expect(client.name).toBe('New Client');
      expect(client.id).toBeDefined();
    });

    test('deleteClient should check ownership', async () => {
      mockQuery.mockResolvedValue({});

      await db.deleteClient('client-1', 'user-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2'),
        ['client-1', 'user-1']
      );
    });
  });

  describe('push subscriptions', () => {
    test('savePushSubscription should upsert', async () => {
      mockQuery.mockResolvedValue({});

      await db.savePushSubscription('user-1', {
        endpoint: 'https://push.example.com',
        keys: { p256dh: 'key1', auth: 'key2' },
      });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
        'user-1',
        'https://push.example.com',
        'key1',
        'key2',
      ]);
    });
  });

  describe('query', () => {
    test('should pass through raw SQL', async () => {
      mockQuery.mockResolvedValue({ rows: [{ count: 5 }] });

      const result = await db.query('SELECT COUNT(*) as count FROM jobs WHERE user_id = $1', [
        'user-1',
      ]);

      expect(result.rows[0].count).toBe(5);
    });
  });
});
