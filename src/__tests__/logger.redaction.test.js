import { jest } from '@jest/globals';
import winston from 'winston';
import Transport from 'winston-transport';
import { PII_FIELDS, redactPiiInPlace } from '../logger.js';

// Custom in-memory transport so we can assert on the actual info object
// each format chain emits. Avoids depending on console.log monkey-patching.
class MemoryTransport extends Transport {
  constructor(opts = {}) {
    super(opts);
    this.entries = [];
  }
  log(info, callback) {
    this.entries.push(info);
    callback();
  }
}

describe('redactPiiInPlace', () => {
  test('redacts every known PII field at the top level', () => {
    const fields = Array.from(PII_FIELDS);
    expect(fields.length).toBeGreaterThan(0);
    const obj = Object.fromEntries(fields.map((f) => [f, `value-of-${f}`]));
    obj.safe = 'keep me';
    obj.jobId = 'abc-123';

    redactPiiInPlace(obj);

    for (const f of fields) {
      expect(obj[f]).toBe('[REDACTED]');
    }
    expect(obj.safe).toBe('keep me');
    expect(obj.jobId).toBe('abc-123');
  });

  test('recurses into nested objects', () => {
    const obj = {
      meta: { address: '1 MacArthur Close', postcode: 'RG30 4XW' },
      safe: { foo: 'bar' },
    };
    redactPiiInPlace(obj);
    expect(obj.meta.address).toBe('[REDACTED]');
    expect(obj.meta.postcode).toBe('[REDACTED]');
    expect(obj.safe.foo).toBe('bar');
  });

  test('leaves null and undefined PII values untouched', () => {
    const obj = { address: null, client_name: undefined, safe: 'ok' };
    redactPiiInPlace(obj);
    expect(obj.address).toBeNull();
    expect(obj.client_name).toBeUndefined();
    expect(obj.safe).toBe('ok');
  });

  test('does not recurse infinitely on cyclic objects', () => {
    const obj = { address: 'test', inner: {} };
    obj.inner.back = obj; // cycle
    expect(() => redactPiiInPlace(obj)).not.toThrow();
    expect(obj.address).toBe('[REDACTED]');
  });

  test('does not mutate caller-owned nested objects', () => {
    // Regression: GET /api/job/:userId/:jobId used to log
    // `installationData: extractedData.installation_details` directly. The
    // pre-fix in-place recursion overwrote address/postcode/client_name on
    // the live object, and the handler then returned the mutated reference
    // to the client — the next auto-save persisted '[REDACTED]' to S3 and
    // the jobs.address DB column. Pin the invariant: caller objects passed
    // in via logger meta must come back unchanged.
    const installation = {
      address: '1 MacArthur Close',
      postcode: 'RG30 4XW',
      client_name: 'John Smith',
      not_pii: 'keep me',
    };
    const supply = { earthing_arrangement: 'TN-S', client_phone: '07700 900123' };
    const info = { jobId: 'abc', installationData: installation, supplyData: supply };

    redactPiiInPlace(info);

    // Logger output is redacted (info-level fields)
    expect(info.installationData.address).toBe('[REDACTED]');
    expect(info.installationData.postcode).toBe('[REDACTED]');
    expect(info.installationData.client_name).toBe('[REDACTED]');
    expect(info.supplyData.client_phone).toBe('[REDACTED]');

    // Caller's original objects are untouched
    expect(installation.address).toBe('1 MacArthur Close');
    expect(installation.postcode).toBe('RG30 4XW');
    expect(installation.client_name).toBe('John Smith');
    expect(installation.not_pii).toBe('keep me');
    expect(supply.client_phone).toBe('07700 900123');
    expect(supply.earthing_arrangement).toBe('TN-S');

    // The redacted copy must be a different reference
    expect(info.installationData).not.toBe(installation);
    expect(info.supplyData).not.toBe(supply);
  });

  test('ignores arrays and primitive inputs', () => {
    // Arrays are intentionally skipped — winston doesn't pass arrays as info
    // and PII rarely sits in array form. Keeps the function simple.
    const arr = [{ address: '1 Test St' }];
    expect(() => redactPiiInPlace(arr)).not.toThrow();
    expect(arr[0].address).toBe('1 Test St'); // intentionally NOT redacted
    expect(() => redactPiiInPlace(null)).not.toThrow();
    expect(() => redactPiiInPlace('not an object')).not.toThrow();
  });
});

describe('winston logger format chain integration', () => {
  function buildLogger() {
    // Replicate logger.js's redactPiiFormat construction here so we can attach
    // a memory transport that captures the post-format info object.
    const redactPiiFormat = winston.format((info) => {
      redactPiiInPlace(info);
      return info;
    });
    const memory = new MemoryTransport({ level: 'info' });
    const logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        redactPiiFormat(),
        winston.format.timestamp()
      ),
      transports: [memory],
    });
    return { logger, memory };
  }

  test('PII in metadata is redacted before reaching transport', () => {
    const { logger, memory } = buildLogger();
    logger.info('Updating job address from PUT', {
      jobId: 'abc-123',
      address: '1 MacArthur Close',
      client_name: 'John Smith',
      postcode: 'RG30 4XW',
    });

    expect(memory.entries.length).toBe(1);
    const info = memory.entries[0];
    expect(info.message).toBe('Updating job address from PUT');
    expect(info.jobId).toBe('abc-123');
    expect(info.address).toBe('[REDACTED]');
    expect(info.client_name).toBe('[REDACTED]');
    expect(info.postcode).toBe('[REDACTED]');
  });

  test('PII nested under another key is also redacted', () => {
    const { logger, memory } = buildLogger();
    logger.info('Job snapshot', {
      jobId: 'abc-123',
      snapshot: {
        installation_details: {
          address: '1 MacArthur Close',
          client_phone: '07700 900123',
          client_email: 'test@example.com',
        },
      },
    });

    const info = memory.entries[0];
    expect(info.snapshot.installation_details.address).toBe('[REDACTED]');
    expect(info.snapshot.installation_details.client_phone).toBe('[REDACTED]');
    expect(info.snapshot.installation_details.client_email).toBe('[REDACTED]');
  });

  test('non-PII fields pass through unchanged', () => {
    const { logger, memory } = buildLogger();
    logger.info('Test message', {
      jobId: 'abc',
      sessionId: 'sess-1',
      chunkIndex: 5,
      audioBytes: 16000,
      error: 'transcription empty',
    });

    const info = memory.entries[0];
    expect(info.jobId).toBe('abc');
    expect(info.sessionId).toBe('sess-1');
    expect(info.chunkIndex).toBe(5);
    expect(info.audioBytes).toBe(16000);
    expect(info.error).toBe('transcription empty');
  });
});
