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

  test('preserves non-plain objects (Date, Map, Set, Buffer, RegExp) without flattening', () => {
    // Regression: an earlier version of this fix used `{ ...value }` to
    // copy-on-write nested objects, which silently destroyed non-plain
    // values — `{...new Date()}` is `{}`, `{...new Map([['k','v']])}`
    // is `{}`, `{...Buffer.from('hi')}` is `{0: 104, 1: 105}`, etc. The
    // old in-place walker happened to be safe because `Object.keys(date)`
    // returns []. The `isPlainObject` guard preserves that behaviour.
    const date = new Date('2026-05-27T12:00:00Z');
    const map = new Map([['k', 'v']]);
    const set = new Set([1, 2, 3]);
    const buf = Buffer.from('hi');
    const regex = /abc/g;
    class CustomClass {
      constructor() {
        this.address = 'should-not-be-redacted-on-class-instance';
      }
    }
    const instance = new CustomClass();

    const info = {
      jobId: 'abc',
      startedAt: date,
      cache: map,
      seen: set,
      payload: buf,
      pattern: regex,
      custom: instance,
    };
    redactPiiInPlace(info);

    // Non-plain values must be passed through by reference, not flattened.
    expect(info.startedAt).toBe(date);
    expect(info.cache).toBe(map);
    expect(info.seen).toBe(set);
    expect(info.payload).toBe(buf);
    expect(info.pattern).toBe(regex);
    // Class instances are also non-plain — left alone (mirrors old
    // behaviour). Note: their PII properties are NOT redacted; the
    // logger is conservative-by-design (PII scanning is for plain meta
    // objects, not domain models). Documented here as the deliberate
    // trade-off.
    expect(info.custom).toBe(instance);
    expect(info.custom.address).toBe('should-not-be-redacted-on-class-instance');
  });

  test('shared sub-graph: same nested object referenced twice is cloned twice', () => {
    // Documents (does not optimise) the alias-loss in emitted logs:
    // if two meta keys reference the same underlying object, each gets
    // its own clone in the output. Caller's original is untouched. Pin
    // the behaviour so a future "share-clone-via-Map" optimisation
    // doesn't accidentally restore the cross-mutation hazard.
    const shared = { address: '1 Test St', postcode: 'TS1 1AA' };
    const info = { primary: shared, mirror: shared };
    redactPiiInPlace(info);

    // Both copies redacted, but distinct references — and original is
    // unmutated.
    expect(info.primary.address).toBe('[REDACTED]');
    expect(info.mirror.address).toBe('[REDACTED]');
    expect(info.primary).not.toBe(info.mirror);
    expect(shared.address).toBe('1 Test St');
    expect(shared.postcode).toBe('TS1 1AA');
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
