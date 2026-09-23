/**
 * PLAN-CC (feedback-2026-09-17 wave) — `ocpd_max_zs_source` survives the CSV
 * persistence boundary.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Both clients decide whether a derived max Zs may be recomputed, must be
 * preserved, or should be marked "unverified" from ONE key. The key only
 * survives a save->load cycle if BOTH `CIRCUIT_FIELD_ORDER` and
 * `CIRCUIT_HEADERS` in `src/export.js` carry it — the column and its label.
 * That is exactly how the multi-board `board_id` / `feeds_board_id` columns
 * were silently dropped on every cycle before May 2026, and a dropped
 * provenance key here is worse than a dropped hierarchy marker: every row
 * degrades to "unknown origin", so a genuinely auto-derived value stops being
 * recomputed and starts wearing a warning triangle on the certificate
 * preflight.
 *
 * THREE STATES, not two. `auto` and `manual` are values; ABSENT is the third
 * state and means "pre-plan data of unknown origin". `parseCSV` reads a
 * missing cell as the empty string, so the absent case is asserted as `''`
 * rather than `undefined` — that is what the clients actually receive, and a
 * client that treated `''` as a value would recompute rows it must preserve.
 */

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Mock DB layer (same surface as the designation route tests) ----
const mockGetUserById = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJob = jest.fn();

jest.unstable_mockModule('../db.js', () => ({
  getUserByEmail: jest.fn(),
  getUserById: mockGetUserById,
  updateLastLogin: jest.fn(),
  updateLoginAttempts: jest.fn(),
  logAction: jest.fn(),
  getJobsByUser: jest.fn(),
  createJob: jest.fn(),
  getJob: mockGetJob,
  getJobByAddress: jest.fn(),
  updateJob: mockUpdateJob,
  updateJobStatus: jest.fn(),
  deleteJob: jest.fn(),
  saveJobVersion: jest.fn(),
  getJobVersions: jest.fn(),
  getJobVersion: jest.fn(),
  usePostgres: jest.fn().mockReturnValue(true),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  createJobLogger: jest
    .fn()
    .mockReturnValue({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

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

const { default: express } = await import('express');
const { default: supertest } = await import('supertest');
const { default: jobsRouter } = await import('../routes/jobs.js');
const { circuitsToCSV } = await import('../export.js');
const { parseCSV } = await import('../utils/jobs.js');

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

/** One circuit per provenance state, in a fixed order the assertions index. */
const CIRCUITS = [
  {
    circuit_ref: '1',
    circuit_designation: 'Upstairs lighting',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    ocpd_max_zs_ohm: '1.44',
    ocpd_max_zs_source: 'auto',
  },
  {
    circuit_ref: '2',
    circuit_designation: 'Kitchen sockets',
    ocpd_bs_en: 'BS 3871',
    ocpd_type: '2',
    ocpd_rating_a: '30',
    ocpd_max_zs_ohm: '1.44',
    ocpd_max_zs_source: 'manual',
  },
  {
    // Pre-plan row: a max Zs and NO key at all.
    circuit_ref: '3',
    circuit_designation: 'Garage',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    ocpd_max_zs_ohm: '1.44',
  },
];

describe('ocpd_max_zs_source — serializer round trip', () => {
  test('the column is present, last, and labelled', async () => {
    const csv = circuitsToCSV(CIRCUITS);
    const headers = csv.trim().split('\n')[0].split(',');
    expect(headers).toContain('ocpd_max_zs_source');
    // Appended at the END for the same reason the Phase 2a columns were:
    // parseCSV maps by header NAME, so an older file simply lacks it.
    expect(headers[headers.length - 1]).toBe('ocpd_max_zs_source');
    const { jobToExcel } = await import('../export.js');
    // The Excel sheet is driven by CIRCUIT_HEADERS; a missing entry there
    // would leave the column unlabelled even with the order entry present.
    expect(() => jobToExcel({ circuits: CIRCUITS })).not.toThrow();
  });

  test('auto, manual and absent all survive circuitsToCSV → parseCSV', () => {
    const parsed = parseCSV(circuitsToCSV(CIRCUITS));
    expect(parsed).toHaveLength(3);
    expect(parsed[0].ocpd_max_zs_source).toBe('auto');
    expect(parsed[1].ocpd_max_zs_source).toBe('manual');
    // Absent stays absent — parseCSV renders a missing cell as ''. The clients
    // read '' as "no key", which is the preserve-and-mark state.
    expect(parsed[2].ocpd_max_zs_source).toBe('');
    // The value itself is untouched in all three states.
    expect(parsed.map((r) => r.ocpd_max_zs_ohm)).toEqual(['1.44', '1.44', '1.44']);
  });

  test('a LEGACY csv with no such column still parses, with the key absent', () => {
    const legacy =
      'circuit_ref,circuit_designation,ocpd_max_zs_ohm\n' + '1,Upstairs lighting,1.44\n';
    const parsed = parseCSV(legacy);
    expect(parsed[0].ocpd_max_zs_ohm).toBe('1.44');
    expect(parsed[0].ocpd_max_zs_source).toBeUndefined();
  });
});

describe('ocpd_max_zs_source — PUT then GET through the job routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(activeUser);
    mockDownloadText.mockResolvedValue(null);
    mockUploadText.mockResolvedValue(undefined);
    mockGetJob.mockResolvedValue({
      id: 'job-1',
      user_id: 'user-1',
      address: '42 Test St',
      certificate_type: 'EICR',
    });
    mockUpdateJob.mockResolvedValue(undefined);
  });

  test('the key written by a PUT comes back from the GET in all three states', async () => {
    const put = await supertest(app)
      .put('/api/job/user-1/job-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ circuits: CIRCUITS });
    expect(put.status).toBe(200);

    const uploads = capturedCsvUploads();
    expect(uploads).toHaveLength(1);
    const persisted = uploads[0];
    expect(cell(persisted, 0, 'ocpd_max_zs_source')).toBe('auto');
    expect(cell(persisted, 1, 'ocpd_max_zs_source')).toBe('manual');
    expect(cell(persisted, 2, 'ocpd_max_zs_source')).toBe('');

    // Feed exactly those persisted bytes back to the read path.
    mockDownloadText.mockImplementation(async (key) => {
      if (String(key).endsWith('test_results.csv')) return persisted;
      if (String(key).endsWith('extracted_data.json')) return '{}';
      return null;
    });

    const get = await supertest(app)
      .get('/api/job/user-1/job-1')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(get.status).toBe(200);

    const circuits = get.body.circuits ?? get.body.job?.circuits;
    expect(Array.isArray(circuits)).toBe(true);
    expect(circuits).toHaveLength(3);
    expect(circuits[0].ocpd_max_zs_source).toBe('auto');
    expect(circuits[1].ocpd_max_zs_source).toBe('manual');
    expect(circuits[2].ocpd_max_zs_source).toBe('');
    expect(circuits.map((c) => c.ocpd_max_zs_ohm)).toEqual(['1.44', '1.44', '1.44']);
    // Acceptance 4: a free-text standard outside the old closed list survives
    // the same PUT → GET, byte for byte.
    expect(circuits[1].ocpd_bs_en).toBe('BS 3871');
  });
});
