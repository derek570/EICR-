import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockListFiles = jest.fn();
const mockDownloadJson = jest.fn();
const mockGetFileUrl = jest.fn();
const mockFileExists = jest.fn();
const mockUploadJson = jest.fn();

jest.unstable_mockModule('../storage.js', () => ({
  listFiles: mockListFiles,
  downloadJson: mockDownloadJson,
  getFileUrl: mockGetFileUrl,
  fileExists: mockFileExists,
  uploadJson: mockUploadJson,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  default: ccuReviewRouter,
  decodeCcuReviewSampleId,
  encodeCcuReviewSampleId,
  projectCcuAnalysisForReview,
  sanitiseCcuGroundTruth,
} = await import('../routes/ccu-review.js');

const PREFIX = 'ccu-extractions/user-1/session-1/1785232800000-extraction-1';
const SAMPLE_ID = encodeCcuReviewSampleId(PREFIX);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', role: 'admin' };
    next();
  });
  app.use('/', ccuReviewRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CCU review sample identifiers and projections', () => {
  test('round-trips an opaque id and rejects paths outside the extraction namespace', () => {
    expect(decodeCcuReviewSampleId(SAMPLE_ID)).toBe(PREFIX);
    expect(
      decodeCcuReviewSampleId(
        Buffer.from('ccu-extractions/user-1/../secret', 'utf8').toString('base64url')
      )
    ).toBeNull();
    expect(
      decodeCcuReviewSampleId(Buffer.from('jobs/user-1/session/job', 'utf8').toString('base64url'))
    ).toBeNull();
  });

  test('keeps review fields while stripping crop/base64 and unrelated result data', () => {
    const projected = projectCcuAnalysisForReview({
      board_manufacturer: 'Hager',
      board_model: 'VML',
      circuits: [
        {
          circuit_number: 1,
          label: 'Sockets',
          ocpd_type: 'B',
          crop: { base64: 'huge' },
          confidence: 0.9,
        },
      ],
      slots: [{ crop: { base64: 'huge' } }],
      gptVisionCost: { cost_usd: 1 },
      userId: 'must-not-leak',
    });

    expect(projected).toMatchObject({
      board_manufacturer: 'Hager',
      board_model: 'VML',
      circuits: [{ circuit_number: 1, label: 'Sockets', ocpd_type: 'B' }],
    });
    expect(projected).not.toHaveProperty('slots');
    expect(projected).not.toHaveProperty('gptVisionCost');
    expect(projected).not.toHaveProperty('userId');
    expect(projected.circuits[0]).not.toHaveProperty('crop');
  });

  test('sanitises ground truth to the CertMate board/circuit field allowlists', () => {
    const groundTruth = sanitiseCcuGroundTruth({
      board: { board_manufacturer: 'Wylex', secret: 'drop-me' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Kitchen',
          ocpd_type: 'B',
          rcd_protected: true,
          secret: 'drop-me',
        },
      ],
      notes: 'Label partly obscured',
      secret: 'drop-me',
    });

    expect(groundTruth).toEqual({
      board: { board_manufacturer: 'Wylex' },
      circuits: [
        {
          id: 'c1',
          circuit_ref: '1',
          circuit_designation: 'Kitchen',
          ocpd_type: 'B',
          rcd_protected: true,
        },
      ],
      notes: 'Label partly obscured',
    });
  });
});

describe('GET /', () => {
  test('groups photo/result pairs, reports review counts, and filters the queue', async () => {
    mockListFiles.mockResolvedValueOnce([
      `${PREFIX}/original.jpg`,
      `${PREFIX}/result.json`,
      `${PREFIX}/ground-truth.json`,
      'ccu-extractions/user-2/session-2/1785319200000-extraction-2/original.jpg',
      'ccu-extractions/user-2/session-2/1785319200000-extraction-2/result.json',
      'ccu-extractions/user-3/session-3/orphan/result.json',
    ]);

    const res = await request(buildApp()).get('/?status=all');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, reviewed: 1, unreviewed: 1 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      extractionId: '1785319200000-extraction-2',
      reviewed: false,
    });
    expect(res.body.items[1]).toMatchObject({
      sampleId: SAMPLE_ID,
      reviewed: true,
    });
  });
});

describe('GET /:sampleId', () => {
  test('returns a signed original photo, projected extraction, saved truth and session reference', async () => {
    mockDownloadJson
      .mockResolvedValueOnce({
        analysis: {
          board_manufacturer: 'Hager',
          circuits: [{ circuit_number: 1, label: 'Sockets', crop: { base64: 'drop' } }],
        },
        meta: { model: 'gpt-5.5', timestamp: '2026-07-29T10:00:00.000Z', totalElapsedMs: 1234 },
      })
      .mockResolvedValueOnce({
        revision: 2,
        reviewedAt: '2026-07-29T11:00:00.000Z',
        groundTruth: { board: {}, circuits: [], notes: '' },
      })
      .mockResolvedValueOnce({ layout: { circuits: [{ circuit_ref: '1' }] } });
    mockGetFileUrl.mockResolvedValueOnce('https://signed.example/original.jpg');

    const res = await request(buildApp()).get(`/${SAMPLE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      imageUrl: 'https://signed.example/original.jpg',
      sample: { sampleId: SAMPLE_ID, reviewed: true },
      extracted: {
        board_manufacturer: 'Hager',
        circuits: [{ circuit_number: 1, label: 'Sockets' }],
      },
      extractionMeta: { model: 'gpt-5.5', totalElapsedMs: 1234 },
      groundTruth: { board: {}, circuits: [], notes: '' },
      reviewMeta: { revision: 2 },
      sessionConfirmedLayout: { circuits: [{ circuit_ref: '1' }] },
    });
    expect(mockGetFileUrl).toHaveBeenCalledWith(`${PREFIX}/original.jpg`, 900);
  });

  test('rejects an invalid opaque sample id before accessing storage', async () => {
    const res = await request(buildApp()).get('/not-a-valid-sample');
    expect(res.status).toBe(400);
    expect(mockDownloadJson).not.toHaveBeenCalled();
  });
});

describe('PUT /:sampleId', () => {
  test('writes a revisioned ground-truth document beside the exact extraction', async () => {
    mockFileExists.mockResolvedValueOnce(true);
    mockDownloadJson.mockResolvedValueOnce({ revision: 2, createdAt: '2026-07-29T09:00:00.000Z' });
    mockUploadJson.mockResolvedValueOnce(true);

    const res = await request(buildApp())
      .put(`/${SAMPLE_ID}`)
      .send({
        board: { board_manufacturer: 'Hager' },
        circuits: [{ circuit_ref: '1', circuit_designation: 'Sockets' }],
        notes: 'Checked against photo',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sampleId: SAMPLE_ID, revision: 3 });
    expect(mockUploadJson).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 'ccu-ground-truth-v1',
        extractionId: '1785232800000-extraction-1',
        createdAt: '2026-07-29T09:00:00.000Z',
        reviewedBy: 'admin-1',
        revision: 3,
        groundTruth: expect.objectContaining({
          board: { board_manufacturer: 'Hager' },
          circuits: [
            expect.objectContaining({
              id: 'ground-truth-1',
              circuit_ref: '1',
              circuit_designation: 'Sockets',
            }),
          ],
        }),
      }),
      `${PREFIX}/ground-truth.json`
    );
  });

  test('returns 400 for malformed circuit data and never writes it', async () => {
    const res = await request(buildApp()).put(`/${SAMPLE_ID}`).send({ circuits: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(mockUploadJson).not.toHaveBeenCalled();
  });
});
