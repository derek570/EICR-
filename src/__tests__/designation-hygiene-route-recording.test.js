/**
 * PLAN-B B1 ingress 5 (feedback id 128) — ROUTE-LEVEL regressions for the
 * two recording-finish circuitsToCSV persistence sites:
 *
 *   - src/routes/recording.js:243 — the initial CSV upload in saveSession
 *     (POST /api/recording/:sessionId/finish);
 *   - src/routes/recording.js:491 — the GPT-enrichment RE-upload (session-
 *     level extractSession fills merged into formData, then re-serialised).
 *
 * Unlike recording.test.js, the accumulator (chunk_accumulator.js), the EICR
 * buffer and export.js are all REAL here — the tests assert on the storage
 * mock's captured uploadText payloads, i.e. the bytes that would land in S3.
 *
 * The :491 test deliberately feeds a DIRTY designation from the (mocked)
 * extractSession — production extract_session.js repairs at its own egress,
 * but the route-level serializer must repair independently of that
 * (belt-and-braces: a future extractor that forgets its egress repair still
 * cannot persist the banned token).
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// Byte-identity pin for the persisted header (see the sibling route test for
// provenance — src/export.js CIRCUIT_FIELD_ORDER, multi-board Phase 2a).
const EXPECTED_HEADER =
  'circuit_ref,circuit_designation,wiring_type,ref_method,number_of_points,' +
  'live_csa_mm2,cpc_csa_mm2,max_disconnect_time_s,ocpd_bs_en,ocpd_type,' +
  'ocpd_rating_a,ocpd_breaking_capacity_ka,ocpd_max_zs_ohm,rcd_bs_en,rcd_type,' +
  'rcd_operating_current_ma,ring_r1_ohm,ring_rn_ohm,ring_r2_ohm,r1_r2_ohm,' +
  'r2_ohm,ir_test_voltage_v,ir_live_live_mohm,ir_live_earth_mohm,' +
  'polarity_confirmed,measured_zs_ohm,rcd_time_ms,rcd_button_confirmed,' +
  'afdd_button_confirmed,board_id,is_distribution_circuit,feeds_board_id,' +
  'ocpd_max_zs_source';

// ---- Mock DB layer ----
const mockGetUserById = jest.fn();
const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJob = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: jest.fn(),
  getUserById: mockGetUserById,
  updateLastLogin: jest.fn(),
  updateLoginAttempts: jest.fn(),
  logAction: jest.fn(),
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

jest.unstable_mockModule('../queue.js', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
}));

// Mock storage — uploads captured for assertion
const mockDownloadText = jest.fn().mockResolvedValue(null);
const mockUploadText = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../storage.js', () => ({
  downloadText: mockDownloadText,
  uploadText: mockUploadText,
  uploadBytes: jest.fn().mockResolvedValue(undefined),
  uploadJson: jest.fn().mockResolvedValue(undefined),
  downloadBytes: jest.fn().mockResolvedValue(null),
  listFiles: jest.fn().mockResolvedValue([]),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  isUsingS3: jest.fn().mockReturnValue(false),
  getBucketName: jest.fn().mockReturnValue(null),
}));

// AI seams mocked (canned data drives the route); accumulator/buffer/export
// stay REAL — that is the point of these tests.
jest.unstable_mockModule('../transcribe.js', () => ({
  transcribeChunk: jest
    .fn()
    .mockResolvedValue({ transcript: 'circuit one', modelUsed: 'test', usage: null }),
}));

const mockExtractChunk = jest
  .fn()
  .mockResolvedValue({ circuits: [], observations: [], usage: null });
jest.unstable_mockModule('../extract_chunk.js', () => ({
  extractChunk: mockExtractChunk,
}));

const mockExtractSession = jest
  .fn()
  .mockResolvedValue({ circuits: [], observations: [], usage: null });
jest.unstable_mockModule('../extract_session.js', () => ({
  extractSession: mockExtractSession,
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

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const { default: recordingRouter } = await import('../routes/recording.js');
// Same live-session map instance the router uses — lets the enrichment test
// stage accumulator/transcript state without inventing new production seams.
const { activeSessions } = await import('../state/recording-sessions.js');

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
  return jwt.sign({ userId, email: 'test@example.com' }, JWT_SECRET, { expiresIn: '24h' });
}

function capturedCsvUploads() {
  return mockUploadText.mock.calls
    .filter(([, key]) => String(key).endsWith('test_results.csv'))
    .map(([content]) => content);
}

function cell(csv, rowIdx, field) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const col = headers.indexOf(field);
  return lines[rowIdx + 1].split(',')[col];
}

async function startSession() {
  const res = await supertest(app)
    .post('/api/recording/start')
    .set('Authorization', `Bearer ${makeToken()}`)
    .send({ address: '42 Test St' });
  expect(res.status).toBe(200);
  return res.body.sessionId;
}

describe('Recording finish — designation repair on the persisted CSV', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
    mockCreateJob.mockResolvedValue(undefined);
    mockUpdateJob.mockResolvedValue(undefined);
    mockDownloadText.mockResolvedValue(null);
    mockExtractSession.mockResolvedValue({ circuits: [], observations: [], usage: null });
  });

  test('finish (whisper jobData path) persists repaired CSV — recording.js:243', async () => {
    const sessionId = await startSession();

    const res = await supertest(app)
      .post(`/api/recording/${sessionId}/finish`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        address: '42 Test St',
        jobData: {
          circuits: [
            {
              circuit_ref: '1',
              circuit_designation: 'Upstairs lighting circuit',
              measured_zs_ohm: '0.35',
            },
            { circuit_ref: '2', circuit_designation: 'Circuit', measured_zs_ohm: '0.99' },
          ],
        },
      });

    expect(res.status).toBe(200);

    const uploads = capturedCsvUploads();
    // No session transcript → no GPT enrichment pass → exactly ONE CSV write.
    expect(uploads).toHaveLength(1);
    const csv = uploads[0];
    expect(csv.split('\n')[0]).toBe(EXPECTED_HEADER);
    expect(cell(csv, 0, 'circuit_designation')).toBe('Upstairs lighting');
    expect(cell(csv, 1, 'circuit_designation')).toBe('Circuit'); // banned-only UNCHANGED
    expect(cell(csv, 0, 'measured_zs_ohm')).toBe('0.35');
    expect(cell(csv, 1, 'measured_zs_ohm')).toBe('0.99');
  });

  test('GPT-enrichment re-upload also repairs, including a dirty GPT fill — recording.js:491', async () => {
    const sessionId = await startSession();

    // Stage real session state: circuits already accumulated (one dirty, one
    // banned-only, one awaiting a designation) + a >50-char transcript so the
    // session-level extraction gate opens.
    const session = activeSessions.get(sessionId);
    expect(session).toBeDefined();
    session.accumulator.circuits.push(
      { circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit' },
      { circuit_ref: '2', circuit_designation: 'Circuit' },
      { circuit_ref: '3', circuit_designation: '' }
    );
    session.eicrBuffer.fullText =
      'Circuit three is the garage lighting circuit, Zs nought point four one ohms.';

    // Mocked extractSession returns a RAW dirty designation (production
    // repairs at its own egress; the route must repair independently).
    mockExtractSession.mockResolvedValue({
      circuits: [
        {
          circuit_ref: '3',
          circuit_designation: 'Circuit garage lighting',
          measured_zs_ohm: '0.41',
        },
      ],
      observations: [],
      usage: null,
    });

    const res = await supertest(app)
      .post(`/api/recording/${sessionId}/finish`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ address: '7 Enrich Rd' });

    expect(res.status).toBe(200);
    expect(mockExtractSession).toHaveBeenCalledTimes(1);

    const uploads = capturedCsvUploads();
    // Two writes: saveSession's initial upload (:243), then the enrichment
    // re-upload (:491) after gptFills > 0.
    expect(uploads).toHaveLength(2);

    for (const csv of uploads) {
      expect(csv.split('\n')[0]).toBe(EXPECTED_HEADER);
      expect(cell(csv, 0, 'circuit_designation')).toBe('Upstairs lighting');
      expect(cell(csv, 1, 'circuit_designation')).toBe('Circuit'); // banned-only UNCHANGED
    }

    // Initial write: circuit 3 not yet designated.
    expect(cell(uploads[0], 2, 'circuit_designation')).toBe('');
    // Enriched write: the dirty GPT fill ("Circuit garage lighting") was
    // merged into formData raw, and the serializer repaired the leading token.
    expect(cell(uploads[1], 2, 'circuit_designation')).toBe('garage lighting');
    expect(cell(uploads[1], 2, 'measured_zs_ohm')).toBe('0.41');
  });
});
