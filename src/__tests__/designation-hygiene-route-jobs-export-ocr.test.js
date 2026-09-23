/**
 * PLAN-B B1 ingress 5 (feedback id 128) — ROUTE-LEVEL regressions for the
 * circuitsToCSV designation repair, driven through the real HTTP routes via
 * supertest (Codex pre-merge finding: source-regex pins are not route
 * coverage; these tests exercise the actual persistence flow end-to-end).
 *
 * Covered here (export.js is REAL — unlike jobs.test.js, which mocks it):
 *   - PUT /api/job/:userId/:jobId          (jobs save,  src/routes/jobs.js:744)
 *   - POST /api/job/:userId/:jobId/clone   (job clone,  src/routes/jobs.js:1101)
 *   - GET  /api/job/.../export/csv         (export,     src/routes/export.js:30)
 *   - POST /api/ocr/create-job             (OCR import, src/routes/ocr.js:72)
 *
 * The recording routes (recording.js:243/:491) live in
 * designation-hygiene-route-recording.test.js (their mock surface differs —
 * the accumulator must stay real there).
 *
 * Each test drives a circuit with designation "Upstairs lighting circuit"
 * plus one banned-token-only "Circuit" row through the route and asserts on
 * the PERSISTED CSV (the storage mock's captured uploadText payload — or the
 * downloaded body for the export route, whose deliverable is the response):
 *   1. the cleaned value lands in the circuit_designation column;
 *   2. the banned-only value is UNCHANGED (repair-never-reject; empty =
 *      spare hazard);
 *   3. the CSV header line is byte-identical to the pre-PLAN-B shape (the
 *      repair is cell-level only — no column added/removed/reordered).
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

// Must be set before importing auth.js
process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// The exact pre-PLAN-B header line (src/export.js CIRCUIT_FIELD_ORDER,
// last changed by multi-board Phase 2a). Deliberately a LITERAL, not an
// import — the pin is that the designation repair did not change the shape.
const EXPECTED_HEADER =
  'circuit_ref,circuit_designation,wiring_type,ref_method,number_of_points,' +
  'live_csa_mm2,cpc_csa_mm2,max_disconnect_time_s,ocpd_bs_en,ocpd_type,' +
  'ocpd_rating_a,ocpd_breaking_capacity_ka,ocpd_max_zs_ohm,rcd_bs_en,rcd_type,' +
  'rcd_operating_current_ma,ring_r1_ohm,ring_rn_ohm,ring_r2_ohm,r1_r2_ohm,' +
  'r2_ohm,ir_test_voltage_v,ir_live_live_mohm,ir_live_earth_mohm,' +
  'polarity_confirmed,measured_zs_ohm,rcd_time_ms,rcd_button_confirmed,' +
  'afdd_button_confirmed,board_id,is_distribution_circuit,feeds_board_id,' +
  'ocpd_max_zs_source';

// ---- Mock DB layer (same surface as jobs.test.js) ----
const mockGetUserById = jest.fn();
const mockGetUserByEmail = jest.fn();
const mockGetJob = jest.fn();
const mockGetJobByAddress = jest.fn();
const mockCreateJob = jest.fn();
const mockUpdateJob = jest.fn();
const mockLogAction = jest.fn();
const mockSaveJobVersion = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  updateLastLogin: jest.fn(),
  updateLoginAttempts: jest.fn(),
  logAction: mockLogAction,
  getJobsByUser: jest.fn(),
  createJob: mockCreateJob,
  getJob: mockGetJob,
  getJobByAddress: mockGetJobByAddress,
  updateJob: mockUpdateJob,
  updateJobStatus: jest.fn(),
  deleteJob: jest.fn(),
  saveJobVersion: mockSaveJobVersion,
  getJobVersions: jest.fn(),
  getJobVersion: jest.fn(),
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

// Mock storage — uploadText captures are the assertion target
const mockDownloadText = jest.fn().mockResolvedValue(null);
const mockUploadText = jest.fn().mockResolvedValue(undefined);

jest.unstable_mockModule('../storage.js', () => ({
  downloadText: mockDownloadText,
  uploadText: mockUploadText,
  listFiles: jest.fn().mockResolvedValue([]),
  isUsingS3: jest.fn().mockReturnValue(false),
  uploadBytes: jest.fn().mockResolvedValue(undefined),
  downloadBytes: jest.fn().mockResolvedValue(null),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  deletePrefix: jest.fn().mockResolvedValue(undefined),
  getBucketName: jest.fn().mockReturnValue(null),
  uploadJson: jest.fn().mockResolvedValue(undefined),
}));

// Mock heavy transitive deps (same as jobs.test.js) — but export.js is REAL.
jest.unstable_mockModule('../process_job.js', () => ({
  processJob: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../queue.js', () => ({
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  startWorker: jest.fn().mockResolvedValue(undefined),
  getJobQueue: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../zip.js', () => ({
  createJobsZip: jest.fn().mockResolvedValue(Buffer.from('')),
}));

jest.unstable_mockModule('../ocr_certificate.js', () => ({
  extractFromCertificate: jest.fn().mockResolvedValue({
    data: { circuits: [], observations: [] },
    usage: null,
    model: 'test',
  }),
}));

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const { default: jobsRouter } = await import('../routes/jobs.js');
const { default: exportRouter } = await import('../routes/export.js');
const { default: ocrRouter } = await import('../routes/ocr.js');

const app = express();
app.use(express.json());
app.use('/api', jobsRouter);
app.use('/api', exportRouter);
app.use('/api', ocrRouter);

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

/** All uploadText payloads whose key ends with test_results.csv, in order. */
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

const DIRTY_CIRCUITS = [
  { circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit', measured_zs_ohm: '0.35' },
  { circuit_ref: '2', circuit_designation: 'Circuit', measured_zs_ohm: '0.99' },
];

function assertRepairedCsv(csv) {
  expect(csv.split('\n')[0]).toBe(EXPECTED_HEADER); // byte-identical header
  expect(cell(csv, 0, 'circuit_designation')).toBe('Upstairs lighting');
  expect(cell(csv, 1, 'circuit_designation')).toBe('Circuit'); // banned-only UNCHANGED
  // Neighbouring cells untouched — repair is designation-cell-only.
  expect(cell(csv, 0, 'measured_zs_ohm')).toBe('0.35');
  expect(cell(csv, 1, 'measured_zs_ohm')).toBe('0.99');
}

describe('ROUTE-level designation repair at the circuitsToCSV persistence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
    mockDownloadText.mockResolvedValue(null);
    mockUploadText.mockResolvedValue(undefined);
  });

  test('PUT /api/job/:userId/:jobId persists a repaired test_results.csv (jobs.js:744)', async () => {
    mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
    mockUpdateJob.mockResolvedValue(undefined);

    const res = await supertest(app)
      .put('/api/job/user-1/job-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ circuits: DIRTY_CIRCUITS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const uploads = capturedCsvUploads();
    expect(uploads).toHaveLength(1);
    assertRepairedCsv(uploads[0]);
  });

  test('POST /api/job/:userId/:jobId/clone repairs a LEGACY dirty stored CSV on re-serialisation (jobs.js:1101)', async () => {
    // The clone path round-trips the SOURCE job's stored CSV (parseCSV →
    // circuitsToCSV). Feed it a pre-PLAN-B legacy file that still carries the
    // trailing token — the clone must persist the repaired value, proving old
    // stored data self-heals on the next save-shaped operation.
    mockGetJob.mockResolvedValue({
      id: 'job-src',
      user_id: 'user-1',
      address: '42 Test St',
      certificate_type: 'EICR',
    });
    mockCreateJob.mockResolvedValue(undefined);
    const legacyCsv =
      'circuit_ref,circuit_designation,measured_zs_ohm\n' +
      '1,Upstairs lighting circuit,0.35\n' +
      '2,Circuit,0.99\n';
    mockDownloadText.mockImplementation(async (key) => {
      if (String(key).endsWith('test_results.csv')) return legacyCsv;
      if (String(key).endsWith('extracted_data.json')) return '{}';
      return null;
    });

    const res = await supertest(app)
      .post('/api/job/user-1/job-src/clone')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ newAddress: '99 Clone Ave' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const uploads = capturedCsvUploads();
    expect(uploads).toHaveLength(1);
    assertRepairedCsv(uploads[0]);
  });

  test('GET /api/job/:userId/:jobId/export/csv serves the repaired CSV (export.js:30)', async () => {
    // The export route's deliverable is the DOWNLOADED body (it re-serialises
    // the stored CSV through the real circuitsToCSV) — assert on res.text.
    mockGetJob.mockResolvedValue({ id: 'job-1', user_id: 'user-1', address: '42 Test St' });
    const legacyCsv =
      'circuit_ref,circuit_designation,measured_zs_ohm\n' +
      '1,Upstairs lighting circuit,0.35\n' +
      '2,Circuit,0.99\n';
    mockDownloadText.mockImplementation(async (key) => {
      if (String(key).endsWith('test_results.csv')) return legacyCsv;
      if (String(key).endsWith('extracted_data.json')) return '{}';
      return null;
    });

    const res = await supertest(app)
      .get('/api/job/user-1/job-1/export/csv')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    assertRepairedCsv(res.text);
  });

  test('POST /api/ocr/create-job persists a repaired test_results.csv (ocr.js:72)', async () => {
    mockCreateJob.mockResolvedValue(undefined);

    const res = await supertest(app)
      .post('/api/ocr/create-job')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({
        data: {
          installation_details: { address: '5 Ocr St' },
          circuits: DIRTY_CIRCUITS,
        },
        certificateType: 'EICR',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const uploads = capturedCsvUploads();
    expect(uploads).toHaveLength(1);
    assertRepairedCsv(uploads[0]);
  });
});
