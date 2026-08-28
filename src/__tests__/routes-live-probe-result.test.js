/**
 * Tests for POST /api/live-probe-result and GET /api/live-probe-results.
 *
 * Backend half of PLAN-E1B item 11's in-app live Opus/Deepgram probe
 * (iOS `LiveOpusProbeRunner` posts each run here so results are
 * centrally reviewable, not only in the device-local JSONL). Pins:
 *   - validation: deviceModel + iosVersion required
 *   - the S3 key is per-user under `live-probe-results/{userId}/`
 *   - `succeeded` derivation (transcript + a turn event, no failureReason)
 *   - the CloudWatch row is emitted with the stored shape
 *   - the listing reads back ONLY the caller's prefix, newest first,
 *     and tolerates an unreadable result.json
 *
 * Mock graph copied from routes-debug-report-cloudwatch.test.js (the
 * proven set for importing routes/recording.js).
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
const mockDownloadJson = jest.fn(async () => null);
const mockListDirectories = jest.fn(async () => []);
jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: mockUploadJson,
  uploadBytes: jest.fn(async () => true),
  uploadText: jest.fn(async () => true),
  uploadFile: jest.fn(async () => true),
  downloadJson: mockDownloadJson,
  listDirectories: mockListDirectories,
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

describe('live Opus probe result endpoints (PLAN-E1B item 11 backend half)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
    mockUploadJson.mockReset();
    mockUploadJson.mockResolvedValue(true);
    mockDownloadJson.mockReset();
    mockListDirectories.mockReset();
    mockListDirectories.mockResolvedValue([]);
    infoCalls.length = 0;
    errorCalls.length = 0;
  });

  test('POST rejects a payload without deviceModel/iosVersion', async () => {
    const res = await supertest(app)
      .post('/api/live-probe-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ transcript: 'x' });
    expect(res.status).toBe(400);
    expect(mockUploadJson).not.toHaveBeenCalled();
  });

  test('POST stores a per-user S3 record, derives succeeded, and emits a CloudWatch row', async () => {
    const res = await supertest(app)
      .post('/api/live-probe-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        deviceModel: 'iPhone',
        iosVersion: '26.1',
        networkCondition: 'cellular',
        packetDurationsMs: Array.from({ length: 15 }, (_, i) => 20 + i),
        transcript: 'electrical installation condition report',
        sawTurnInfo: true,
        sawEndOfTurn: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resultId).toMatch(/^live-probe-results\/user-owner\//);

    expect(mockUploadJson).toHaveBeenCalledTimes(1);
    const [stored, key] = mockUploadJson.mock.calls[0];
    expect(key).toBe(`${res.body.resultId}/result.json`);
    expect(stored).toMatchObject({
      deviceModel: 'iPhone',
      iosVersion: '26.1',
      networkCondition: 'cellular',
      packetCount: 15,
      sawTurnInfo: true,
      sawEndOfTurn: false,
      succeeded: true,
      failureReason: null,
    });
    expect(stored.firstTenPacketDurationsMs).toHaveLength(10);
    expect(typeof stored.timestamp).toBe('string');

    const row = infoCalls.find(([msg]) => msg === 'Live Opus probe result');
    expect(row).toBeDefined();
    expect(row[1]).toMatchObject({ userId: 'user-owner', succeeded: true, packetCount: 15 });
  });

  test('POST marks succeeded=false when a failureReason is present or no turn event was seen', async () => {
    const post = (body) =>
      supertest(app)
        .post('/api/live-probe-result')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ deviceModel: 'iPhone', iosVersion: '26.1', ...body });

    await post({ transcript: 'hello', sawTurnInfo: true, failureReason: 'timeout' });
    expect(mockUploadJson.mock.calls[0][0]).toMatchObject({
      succeeded: false,
      failureReason: 'timeout',
    });

    await post({ transcript: 'hello', sawTurnInfo: false, sawEndOfTurn: false });
    expect(mockUploadJson.mock.calls[1][0]).toMatchObject({
      succeeded: false,
      failureReason: null,
    });

    await post({ transcript: '', sawEndOfTurn: true });
    expect(mockUploadJson.mock.calls[2][0]).toMatchObject({ succeeded: false, transcript: '' });
  });

  test('POST returns 500 when the S3 write fails', async () => {
    mockUploadJson.mockRejectedValueOnce(new Error('s3 down'));
    const res = await supertest(app)
      .post('/api/live-probe-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ deviceModel: 'iPhone', iosVersion: '26.1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/s3 down/);
    errorCalls.length = 0;
  });

  test("GET lists only the caller's results, newest first, skipping unreadable entries", async () => {
    mockListDirectories.mockResolvedValueOnce([
      '2026-08-28T10-00-00-000Z',
      '2026-08-28T12-00-00-000Z',
      'broken',
    ]);
    mockDownloadJson.mockImplementation(async (key) => {
      if (key.endsWith('/broken/result.json')) throw new Error('missing');
      const ts = key.includes('T12') ? '2026-08-28T12:00:00.000Z' : '2026-08-28T10:00:00.000Z';
      return { deviceModel: 'iPhone', timestamp: ts };
    });

    const res = await supertest(app)
      .get('/api/live-probe-results')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(mockListDirectories).toHaveBeenCalledWith('live-probe-results/user-owner/');
    expect(mockDownloadJson.mock.calls.map(([k]) => k)).toEqual([
      'live-probe-results/user-owner/2026-08-28T10-00-00-000Z/result.json',
      'live-probe-results/user-owner/2026-08-28T12-00-00-000Z/result.json',
      'live-probe-results/user-owner/broken/result.json',
    ]);
    expect(res.body.results.map((r) => r.timestamp)).toEqual([
      '2026-08-28T12:00:00.000Z',
      '2026-08-28T10:00:00.000Z',
    ]);
  });

  test('GET returns an empty list when the user has no results', async () => {
    const res = await supertest(app)
      .get('/api/live-probe-results')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });
});
