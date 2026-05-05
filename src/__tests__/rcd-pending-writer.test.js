/**
 * Unit tests for the auto-grow side: writeRcdPendingEntry persists
 * unknown (manufacturer, model) pairs to S3 so the promote CLI can
 * accumulate sightings and let the operator decide whether to add them
 * to the lookup table.
 *
 * `storage.js` is mocked so we don't need a real S3 client — the
 * upload/download fakes capture the exact bytes the writer would push.
 */

import { jest } from '@jest/globals';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const uploads = [];
const fakeStore = new Map();

await jest.unstable_mockModule('../storage.js', () => ({
  uploadBytes: jest.fn(async (data, key, contentType) => {
    fakeStore.set(key, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    uploads.push({
      key,
      contentType,
      body: typeof data === 'string' ? data : data.toString('utf8'),
    });
    return true;
  }),
  downloadBytes: jest.fn(async (key) => fakeStore.get(key) ?? null),
}));

await jest.unstable_mockModule('../logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

const { writeRcdPendingEntry, pendingKey } = await import('../extraction/rcd-pending-writer.js');

beforeEach(() => {
  uploads.length = 0;
  fakeStore.clear();
  process.env.S3_BUCKET = 'test-bucket';
});

afterEach(() => {
  delete process.env.S3_BUCKET;
});

describe('pendingKey', () => {
  test.each([
    ['Elucian', 'CU1SPD275', 'rcd-lookup-pending/elucian/CU1SPD275.json'],
    ['  Click Scolmore  ', 'cu1spd275', 'rcd-lookup-pending/click_scolmore/CU1SPD275.json'],
    [null, 'X1', 'rcd-lookup-pending/_unknown/X1.json'],
    ['Wylex', null, 'rcd-lookup-pending/wylex/_no_model.json'],
    [null, null, 'rcd-lookup-pending/_unknown/_no_model.json'],
    ['Schneider/Electric', 'EZ9 D', 'rcd-lookup-pending/schneider_electric/EZ9_D.json'],
  ])('%p / %p → %s', (mfg, model, expected) => {
    expect(pendingKey(mfg, model)).toBe(expected);
  });
});

describe('writeRcdPendingEntry', () => {
  test('skipped when S3_BUCKET unset', async () => {
    delete process.env.S3_BUCKET;
    const ok = await writeRcdPendingEntry({
      manufacturer: 'Elucian',
      model: 'X1',
      outcome: 'miss',
      inferredType: 'A',
    });
    expect(ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  test('skipped for non-pending outcomes', async () => {
    const ok = await writeRcdPendingEntry({
      manufacturer: 'Elucian',
      model: 'X1',
      outcome: 'hit',
      inferredType: 'A',
    });
    expect(ok).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  test('first sighting writes a fresh payload with sighting_count=1', async () => {
    const ok = await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'A',
      inferredWays: 12,
      classifierConfidence: 0.85,
      perSlotAvgConfidence: 0.88,
      inferenceSource: 'per_slot_uniform',
      extractionId: 'ext-1',
      userId: 'u-1',
    });
    expect(ok).toBe(true);
    expect(uploads).toHaveLength(1);
    const written = JSON.parse(uploads[0].body);
    expect(written.schema_version).toBe(1);
    expect(written.manufacturer).toBe('NewBrand');
    expect(written.model).toBe('NB100');
    expect(written.outcome).toBe('miss');
    expect(written.sighting_count).toBe(1);
    expect(written.sightings).toHaveLength(1);
    expect(written.sightings[0]).toMatchObject({
      extractionId: 'ext-1',
      userId: 'u-1',
      inferredType: 'A',
      inferredWays: 12,
      classifierConfidence: 0.85,
      perSlotAvgConfidence: 0.88,
      inferenceSource: 'per_slot_uniform',
    });
    expect(written.aggregate.type_votes).toEqual({ A: 1 });
    expect(written.aggregate.ways_votes).toEqual({ 12: 1 });
  });

  test('subsequent sightings upsert + accumulate aggregate votes', async () => {
    await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'AC',
      inferredWays: 12,
    });
    await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'A',
      inferredWays: 12,
    });
    await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'A',
      inferredWays: 14,
    });
    const final = JSON.parse(uploads[uploads.length - 1].body);
    expect(final.sighting_count).toBe(3);
    expect(final.sightings).toHaveLength(3);
    expect(final.aggregate.type_votes).toEqual({ AC: 1, A: 2 });
    expect(final.aggregate.ways_votes).toEqual({ 12: 2, 14: 1 });
  });

  test('caps sighting history at 10 most recent', async () => {
    for (let i = 0; i < 15; i++) {
      await writeRcdPendingEntry({
        manufacturer: 'NewBrand',
        model: 'NB100',
        outcome: 'miss',
        inferredType: 'A',
      });
    }
    const final = JSON.parse(uploads[uploads.length - 1].body);
    expect(final.sighting_count).toBe(15);
    expect(final.sightings).toHaveLength(10); // history capped
  });

  test('handles missing/garbage existing payload gracefully', async () => {
    const key = pendingKey('NewBrand', 'NB100');
    fakeStore.set(key, Buffer.from('not valid json', 'utf8'));
    await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'A',
    });
    const final = JSON.parse(uploads[uploads.length - 1].body);
    expect(final.sighting_count).toBe(1); // treated as first sighting
  });

  test('uploads as application/json', async () => {
    await writeRcdPendingEntry({
      manufacturer: 'NewBrand',
      model: 'NB100',
      outcome: 'miss',
      inferredType: 'A',
    });
    expect(uploads[0].contentType).toBe('application/json');
  });
});
