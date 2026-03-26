/**
 * Integration tests for recording routes — tests actual HTTP routes via supertest.
 * Mocks the database, storage, transcription, and extraction layers but tests
 * middleware, auth guards, response codes, and route behavior.
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
const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJob = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  updateLastLogin: mockUpdateLastLogin,
  updateLoginAttempts: mockUpdateLoginAttempts,
  logAction: mockLogAction,
  createJob: mockCreateJob,
  getJob: mockGetJob,
  updateJob: mockUpdateJob,
  getJobByAddress: jest.fn().mockResolvedValue(null),
  updateJobStatus: jest.fn(),
  deleteJob: jest.fn(),
  usePostgres: jest.fn().mockReturnValue(true),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  createJobLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock storage
jest.unstable_mockModule('../storage.js', () => ({
  downloadText: jest.fn().mockResolvedValue(null),
  uploadText: jest.fn().mockResolvedValue(undefined),
  uploadBytes: jest.fn().mockResolvedValue(undefined),
  uploadJson: jest.fn().mockResolvedValue(undefined),
  downloadBytes: jest.fn().mockResolvedValue(null),
  listFiles: jest.fn().mockResolvedValue([]),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  isUsingS3: jest.fn().mockReturnValue(false),
  getBucketName: jest.fn().mockReturnValue(null),
}));

// Mock heavy transitive deps
jest.unstable_mockModule('../transcribe.js', () => ({
  transcribeChunk: jest
    .fn()
    .mockResolvedValue({ transcript: 'circuit one', modelUsed: 'test', usage: null }),
  transcribeAudio: jest
    .fn()
    .mockResolvedValue({ transcript: 'test', modelUsed: 'test', usage: null }),
}));

jest.unstable_mockModule('../queue.js', () => ({
  enqueueJob: jest.fn(),
}));

jest.unstable_mockModule('../process_job.js', () => ({
  processJob: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../extract_chunk.js', () => ({
  extractChunk: jest.fn().mockResolvedValue({ circuits: [], observations: [], usage: null }),
}));

jest.unstable_mockModule('../extract_session.js', () => ({
  extractSession: jest.fn().mockResolvedValue({ circuits: [], observations: [], usage: null }),
}));

jest.unstable_mockModule('../generate_debug_report.js', () => ({
  generateAndSaveDebugReports: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../token_logger.js', () => ({
  createTokenAccumulator: jest.fn().mockReturnValue({
    add: jest.fn(),
    getTotals: jest.fn().mockReturnValue({
      totalTokens: 0,
      totalCost: 0,
      geminiTokens: 0,
      geminiCost: 0,
      gptTokens: 0,
      gptCost: 0,
    }),
  }),
  logTokenUsage: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../export.js', () => ({
  circuitsToCSV: jest.fn().mockReturnValue(''),
}));

jest.unstable_mockModule('../chunk_accumulator.js', () => ({
  createAccumulator: jest.fn().mockReturnValue({
    circuits: [],
    observations: [],
    photos: [],
    installation: {},
    supply: {},
    board: {},
    metadata: { chunksProcessed: 0, linked_photos: [] },
  }),
  addChunk: jest.fn(),
  addPhoto: jest.fn(),
  getFormData: jest.fn().mockReturnValue({
    circuits: [],
    observations: [],
    installation_details: {},
    supply_characteristics: {},
    board_info: {},
    metadata: { chunksProcessed: 0, linked_photos: [] },
  }),
  finalize: jest.fn(),
  injectRingReading: jest.fn(),
  injectReading: jest.fn(),
}));

jest.unstable_mockModule('../eicr_buffer.js', () => ({
  createEICRBuffer: jest.fn().mockReturnValue({
    fullText: '',
    pendingText: '',
    activeCircuit: null,
    activeTestType: null,
    ringCircuit: null,
  }),
  addTranscript: jest.fn().mockReturnValue({ shouldExtract: false }),
  getExtractionPayload: jest
    .fn()
    .mockReturnValue({ pendingText: '', activeCircuit: null, activeTestType: null }),
  markExtracted: jest.fn(),
  parseRingValues: jest.fn().mockReturnValue([]),
  getRingReadings: jest.fn().mockReturnValue({}),
  getExtractionWindow: jest.fn().mockReturnValue(''),
  parseCommonReadings: jest.fn().mockReturnValue([]),
}));

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const auth = await import('../auth.js');
const { default: recordingRouter } = await import('../routes/recording.js');

// Create test app
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', recordingRouter);

const activeUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test',
  company_name: 'Co',
  is_active: true,
};

function makeToken(userId = 'user-1') {
  return jwt.sign({ userId, email: 'test@example.com', tv: 0 }, JWT_SECRET, {
    expiresIn: '24h',
    issuer: 'certmate',
    audience: 'certmate-api',
  });
}

describe('Recording routes (supertest)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
  });

  describe('POST /api/recording/start', () => {
    test('should return 401 without auth token', async () => {
      const res = await supertest(app).post('/api/recording/start').send({ address: '42 Test St' });
      expect(res.status).toBe(401);
    });

    test('should start a recording session for authenticated user', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/recording/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ address: '42 Test St' });

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toMatch(/^rec_\d+_[a-z0-9]+$/);
      expect(res.body.message).toContain('Recording session started');
    });

    test('should accept optional jobId', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/recording/start')
        .set('Authorization', `Bearer ${token}`)
        .send({ address: '42 Test St', jobId: 'job_existing' });

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe('job_existing');
    });
  });

  describe('GET /api/recording/:sessionId', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app).get('/api/recording/rec_123');
      expect(res.status).toBe(401);
    });

    test('should return 404 for nonexistent session', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .get('/api/recording/rec_nonexistent')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    test('should return session data for valid session', async () => {
      // First start a session
      const token = makeToken('user-1');
      const startRes = await supertest(app)
        .post('/api/recording/start')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      const sessionId = startRes.body.sessionId;

      // Then get it
      const res = await supertest(app)
        .get(`/api/recording/${sessionId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe(sessionId);
      expect(res.body.formData).toBeDefined();
      expect(res.body.chunksReceived).toBe(0);
    });

    test('should return 403 when accessing another user session', async () => {
      // Start a session as user-1
      const token1 = makeToken('user-1');
      const startRes = await supertest(app)
        .post('/api/recording/start')
        .set('Authorization', `Bearer ${token1}`)
        .send({});

      const sessionId = startRes.body.sessionId;

      // Try to access as user-2
      const user2 = { ...activeUser, id: 'user-2' };
      mockGetUserById.mockResolvedValue(user2);

      const token2 = jwt.sign({ userId: 'user-2', email: 'user2@example.com', tv: 0 }, JWT_SECRET, {
        expiresIn: '24h',
        issuer: 'certmate',
        audience: 'certmate-api',
      });

      const res = await supertest(app)
        .get(`/api/recording/${sessionId}`)
        .set('Authorization', `Bearer ${token2}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/recording/extract-transcript', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app)
        .post('/api/recording/extract-transcript')
        .send({ transcript: 'circuit one lights' });
      expect(res.status).toBe(401);
    });

    test('should return 400 for short transcript', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/recording/extract-transcript')
        .set('Authorization', `Bearer ${token}`)
        .send({ transcript: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('too short');
    });

    test('should extract from valid transcript', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/recording/extract-transcript')
        .set('Authorization', `Bearer ${token}`)
        .send({
          transcript: 'Circuit one lights measured zs 0.35 ohms insulation resistance 200 megohms',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.formData).toBeDefined();
    });
  });

  describe('POST /api/debug-report', () => {
    test('should return 401 without auth', async () => {
      const res = await supertest(app)
        .post('/api/debug-report')
        .send({ sessionId: 'rec_123', issueText: 'problem' });
      expect(res.status).toBe(401);
    });

    test('should return 400 when sessionId is missing', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/debug-report')
        .set('Authorization', `Bearer ${token}`)
        .send({ issueText: 'problem' });
      expect(res.status).toBe(400);
    });

    test('should return 400 when issueText is missing', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/debug-report')
        .set('Authorization', `Bearer ${token}`)
        .send({ sessionId: 'rec_123' });
      expect(res.status).toBe(400);
    });

    test('should return 400 when issueText exceeds 5000 chars', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/debug-report')
        .set('Authorization', `Bearer ${token}`)
        .send({ sessionId: 'rec_123', issueText: 'a'.repeat(5001) });
      expect(res.status).toBe(400);
    });

    test('should accept valid debug report', async () => {
      const token = makeToken('user-1');
      const res = await supertest(app)
        .post('/api/debug-report')
        .set('Authorization', `Bearer ${token}`)
        .send({ sessionId: 'rec_123', issueText: 'Problem with circuit three wiring' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
