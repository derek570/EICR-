import { jest } from '@jest/globals';

const originalBucket = process.env.S3_BUCKET;
process.env.S3_BUCKET = 'test-bucket';

const mockSend = jest.fn();
const mockS3Client = jest.fn(() => ({ send: mockSend }));

class MockListObjectsV2Command {
  constructor(input) {
    this.input = input;
  }
}

jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
  ListObjectsV2Command: MockListObjectsV2Command,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { listFiles } = await import('../storage.js');

afterAll(() => {
  if (originalBucket === undefined) delete process.env.S3_BUCKET;
  else process.env.S3_BUCKET = originalBucket;
});

beforeEach(() => {
  mockSend.mockReset();
});

test('listFiles follows S3 continuation tokens and returns every page', async () => {
  mockSend
    .mockResolvedValueOnce({
      Contents: [{ Key: 'ccu-extractions/a/result.json' }],
      IsTruncated: true,
      NextContinuationToken: 'page-2',
    })
    .mockResolvedValueOnce({
      Contents: [
        { Key: 'ccu-extractions/b/original.jpg' },
        { Key: 'ccu-extractions/b/result.json' },
      ],
      IsTruncated: false,
    });

  await expect(listFiles('ccu-extractions/')).resolves.toEqual([
    'ccu-extractions/a/result.json',
    'ccu-extractions/b/original.jpg',
    'ccu-extractions/b/result.json',
  ]);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls[0][0].input).toMatchObject({
    Bucket: 'test-bucket',
    Prefix: 'ccu-extractions/',
    ContinuationToken: undefined,
  });
  expect(mockSend.mock.calls[1][0].input).toMatchObject({
    ContinuationToken: 'page-2',
  });
});
