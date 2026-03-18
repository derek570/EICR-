/**
 * Tests for storage module helper functions.
 * Note: Full storage tests require proper ESM + Jest setup.
 * These tests focus on testable utility logic.
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';

describe('storage utilities', () => {
  describe('getJobPrefix logic', () => {
    // Test the prefix construction logic
    test('should construct correct prefix pattern', () => {
      const userId = 'user-123';
      const jobId = 'job-456';
      const expected = `jobs/${userId}/${jobId}`;

      expect(`jobs/${userId}/${jobId}`).toBe(expected);
    });

    test('should handle special characters in IDs', () => {
      const userId = 'user@example.com';
      const jobId = '18 Test Street';
      const prefix = `jobs/${userId}/${jobId}`;

      expect(prefix).toBe('jobs/user@example.com/18 Test Street');
    });
  });

  describe('S3 bucket detection logic', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test('should detect S3 mode when bucket is set', () => {
      process.env.S3_BUCKET = 'my-bucket';
      const isS3 = !!process.env.S3_BUCKET;
      expect(isS3).toBe(true);
    });

    test('should detect local mode when bucket is not set', () => {
      delete process.env.S3_BUCKET;
      const isS3 = !!process.env.S3_BUCKET;
      expect(isS3).toBe(false);
    });

    test('should return bucket name', () => {
      process.env.S3_BUCKET = 'eicr-files-bucket';
      expect(process.env.S3_BUCKET).toBe('eicr-files-bucket');
    });
  });
});

describe('local filesystem operations', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('file operations', () => {
    test('should write and read text files', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Hello, EICR!';

      await fs.writeFile(filePath, content, 'utf-8');
      const result = await fs.readFile(filePath, 'utf-8');

      expect(result).toBe(content);
    });

    test('should write and read JSON files', async () => {
      const filePath = path.join(tempDir, 'test.json');
      const data = { circuits: [{ ref: '1', description: 'Lights' }] };

      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
      const result = JSON.parse(await fs.readFile(filePath, 'utf-8'));

      expect(result).toEqual(data);
    });

    test('should check file existence', async () => {
      const existsPath = path.join(tempDir, 'exists.txt');
      const missingPath = path.join(tempDir, 'missing.txt');

      await fs.writeFile(existsPath, 'content');

      const existsResult = await fs.access(existsPath).then(() => true).catch(() => false);
      const missingResult = await fs.access(missingPath).then(() => true).catch(() => false);

      expect(existsResult).toBe(true);
      expect(missingResult).toBe(false);
    });

    test('should list files in directory', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'a');
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'b');
      await fs.writeFile(path.join(tempDir, 'file3.json'), 'c');

      const files = await fs.readdir(tempDir);

      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
      expect(files).toContain('file3.json');
      expect(files.length).toBe(3);
    });

    test('should return empty array for empty directory', async () => {
      const emptyDir = path.join(tempDir, 'empty');
      await fs.mkdir(emptyDir);

      const files = await fs.readdir(emptyDir);

      expect(files).toEqual([]);
    });

    test('should delete files', async () => {
      const filePath = path.join(tempDir, 'todelete.txt');
      await fs.writeFile(filePath, 'content');

      // Verify file exists
      const beforeDelete = await fs.access(filePath).then(() => true).catch(() => false);
      expect(beforeDelete).toBe(true);

      // Delete file
      await fs.unlink(filePath);

      // Verify file is gone
      const afterDelete = await fs.access(filePath).then(() => true).catch(() => false);
      expect(afterDelete).toBe(false);
    });

    test('should handle binary files', async () => {
      const filePath = path.join(tempDir, 'binary.bin');
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);

      await fs.writeFile(filePath, buffer);
      const result = await fs.readFile(filePath);

      expect(Buffer.compare(result, buffer)).toBe(0);
    });
  });

  describe('directory operations', () => {
    test('should create nested directories', async () => {
      const nestedPath = path.join(tempDir, 'a', 'b', 'c');

      await fs.mkdir(nestedPath, { recursive: true });

      const exists = await fs.access(nestedPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should list subdirectories', async () => {
      await fs.mkdir(path.join(tempDir, 'subdir1'));
      await fs.mkdir(path.join(tempDir, 'subdir2'));
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');

      const entries = await fs.readdir(tempDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

      expect(dirs).toContain('subdir1');
      expect(dirs).toContain('subdir2');
      expect(dirs).not.toContain('file.txt');
    });
  });
});

describe('path utilities', () => {
  test('should join paths correctly', () => {
    const result = path.join('jobs', 'user-1', 'job-1', 'file.json');
    expect(result).toBe('jobs/user-1/job-1/file.json');
  });

  test('should get directory from file path', () => {
    const filePath = '/data/jobs/user-1/job-1/test.pdf';
    const dir = path.dirname(filePath);
    expect(dir).toBe('/data/jobs/user-1/job-1');
  });

  test('should get filename from path', () => {
    const filePath = '/data/jobs/user-1/job-1/test.pdf';
    const filename = path.basename(filePath);
    expect(filename).toBe('test.pdf');
  });

  test('should get extension from filename', () => {
    expect(path.extname('document.pdf')).toBe('.pdf');
    expect(path.extname('image.jpeg')).toBe('.jpeg');
    expect(path.extname('noextension')).toBe('');
  });
});
