/**
 * Tests for POST /api/debug-report (PLAN-backend-final.md Phase 1.6.8).
 *
 * Pinned behaviours added by Phase 1.6.3 to the existing handler:
 *   - emits a `Voice feedback captured` CloudWatch row
 *   - inserts a voice_feedback row with the s3_key + transcript_window
 *   - lastTranscriptWindow flows end-to-end into the DB insert payload
 *   - DB insert failure does NOT fail the S3 write (best-effort indexing)
 *
 * Mock graph mirrors src/__tests__/recording.test.js (the file is huge
 * with many transitive imports — using the proven mock set rather than
 * inventing a smaller one that drifts and hangs the import graph).
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// Capture logger.info so we can assert on the `Voice feedback captured` row.
const infoCalls = [];
const errorCalls = [];

const mockGetUserById = jest.fn();
const mockInsertVoiceFeedback = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: jest.fn(),
  getUserById: mockGetUserById,
  updateLastLogin: jest.fn(),
  updateLoginAttempts: jest.fn(),
  logAction: jest.fn(),
  createJob: jest.fn(),
  getJob: jest.fn(),
  updateJob: jest.fn(),
  getJobByAddress: jest.fn().mockResolvedValue(null),
  updateJobStatus: jest.fn(),
  deleteJob: jest.fn(),
  usePostgres: jest.fn().mockReturnValue(true),
  insertVoiceFeedback: mockInsertVoiceFeedback,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: (...args) => {
      infoCalls.push(args);
    },
    warn: jest.fn(),
    error: (...args) => {
      errorCalls.push(args);
    },
  },
}));

const mockUploadJson = jest.fn(async () => true);
jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: mockUploadJson,
  uploadBytes: jest.fn(async () => true),
  uploadText: jest.fn(async () => true),
  uploadFile: jest.fn(async () => true),
  downloadJson: jest.fn(async () => null),
  downloadFile: jest.fn(async () => null),
  exists: jest.fn(async () => false),
  list: jest.fn(async () => []),
  remove: jest.fn(async () => true),
}));

jest.unstable_mockModule('../transcribe.js', () => ({
  transcribeChunk: jest.fn().mockResolvedValue({ transcript: '', usage: null }),
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
  getExtractionPayload: jest.fn().mockReturnValue({
    pendingText: '',
    activeCircuit: null,
    activeTestType: null,
  }),
  markExtracted: jest.fn(),
  parseRingValues: jest.fn().mockReturnValue([]),
  getRingReadings: jest.fn().mockReturnValue({}),
  getExtractionWindow: jest.fn().mockReturnValue(''),
  parseCommonReadings: jest.fn().mockReturnValue([]),
}));

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const { default: recordingRouter } = await import('../routes/recording.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', recordingRouter);

const activeUser = {
  id: 'user-owner',
  email: 'owner@example.co.uk',
  name: 'Test',
  company_name: 'Co',
  is_active: true,
};

function makeToken(userId = 'user-owner') {
  return jwt.sign({ userId, email: 'owner@example.co.uk' }, JWT_SECRET, { expiresIn: '24h' });
}

describe('POST /api/debug-report (Phase 1.6.3 extensions)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
    mockInsertVoiceFeedback.mockReset();
    mockInsertVoiceFeedback.mockResolvedValue({ id: 42, created_at: new Date() });
    mockUploadJson.mockReset();
    mockUploadJson.mockResolvedValue(true);
    infoCalls.length = 0;
    errorCalls.length = 0;
  });

  afterEach(() => {
    if (errorCalls.length) {
      console.error('logger.error during test:', JSON.stringify(errorCalls, null, 2));
    }
  });

  test('uploads to S3 + emits CloudWatch row + inserts voice_feedback row', async () => {
    const token = makeToken();
    const res = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sessionId: 'sess_abc',
        issueText: 'Cooker tripped the RCD when I switched it on.',
        address: '71 Hexham Road, Reading',
        jobId: 'job_1780559309135',
        lastTranscriptWindow: [
          { ts: '2026-06-04T14:10:00Z', text: 'feedback' },
          { ts: '2026-06-04T14:10:05Z', text: 'cooker tripped the rcd' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reportId).toMatch(/^debug-reports\/user-owner\//);
    expect(res.body.voiceFeedbackId).toBe(42);

    // S3: both legacy uploads still fire.
    expect(mockUploadJson).toHaveBeenCalledTimes(2);
    const keys = mockUploadJson.mock.calls.map((c) => c[1]);
    expect(keys.some((k) => k.endsWith('/debug_report.json'))).toBe(true);
    expect(keys.some((k) => k.endsWith('/context.json'))).toBe(true);

    // The context payload now carries the transcript window.
    const contextCall = mockUploadJson.mock.calls.find((c) => c[1].endsWith('/context.json'));
    expect(contextCall[0].lastTranscriptWindow).toHaveLength(2);

    // CloudWatch row.
    const captured = infoCalls.find((c) => c[0] === 'Voice feedback captured');
    expect(captured).toBeDefined();
    expect(captured[1].sessionId).toBe('sess_abc');
    expect(captured[1].userId).toBe('user-owner');
    expect(captured[1].jobId).toBe('job_1780559309135');
    expect(captured[1].address).toBe('71 Hexham Road, Reading');
    expect(captured[1].issuePreview).toBe('Cooker tripped the RCD when I switched it on.');
    expect(captured[1].issueLength).toBe('Cooker tripped the RCD when I switched it on.'.length);
    expect(captured[1].transcriptWindowLength).toBe(2);
    expect(captured[1].s3Key).toMatch(/^debug-reports\/user-owner\/.*\/debug_report\.json$/);
    expect(captured[1].voiceFeedbackId).toBe(42);

    // DB insert payload.
    expect(mockInsertVoiceFeedback).toHaveBeenCalledTimes(1);
    const insertArg = mockInsertVoiceFeedback.mock.calls[0][0];
    expect(insertArg.userId).toBe('user-owner');
    expect(insertArg.sessionId).toBe('sess_abc');
    expect(insertArg.jobId).toBe('job_1780559309135');
    expect(insertArg.address).toBe('71 Hexham Road, Reading');
    expect(insertArg.issueText).toBe('Cooker tripped the RCD when I switched it on.');
    expect(insertArg.transcriptWindow).toHaveLength(2);
    expect(insertArg.s3Key).toMatch(/\/debug_report\.json$/);
  });

  test('null lastTranscriptWindow still emits CloudWatch row with length 0', async () => {
    const res = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ sessionId: 'sess_abc', issueText: 'no window provided here' });
    expect(res.status).toBe(200);
    const captured = infoCalls.find((c) => c[0] === 'Voice feedback captured');
    expect(captured).toBeDefined();
    expect(captured[1].transcriptWindowLength).toBe(0);
    const insertArg = mockInsertVoiceFeedback.mock.calls[0][0];
    expect(insertArg.transcriptWindow).toBeNull();
  });

  test('DB insert failure does NOT fail the request (best-effort indexing)', async () => {
    mockInsertVoiceFeedback.mockRejectedValueOnce(new Error('PG connection refused'));
    const res = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ sessionId: 'sess_abc', issueText: 'cooker tripped' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.voiceFeedbackId).toBeNull();
    const captured = infoCalls.find((c) => c[0] === 'Voice feedback captured');
    expect(captured).toBeDefined();
    expect(captured[1].voiceFeedbackId).toBeNull();
  });

  test('rejects missing issueText or sessionId with 400', async () => {
    const noText = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ sessionId: 'sess_abc' });
    expect(noText.status).toBe(400);

    const noSession = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ issueText: 'cooker' });
    expect(noSession.status).toBe(400);

    expect(mockInsertVoiceFeedback).not.toHaveBeenCalled();
    expect(mockUploadJson).not.toHaveBeenCalled();
  });

  test('rejects issueText over 5000 chars', async () => {
    const res = await supertest(app)
      .post('/api/debug-report')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ sessionId: 'sess_abc', issueText: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(mockInsertVoiceFeedback).not.toHaveBeenCalled();
  });
});
