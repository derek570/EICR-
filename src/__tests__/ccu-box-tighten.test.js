/**
 * Unit tests for ccu-box-tighten — drives the per-edge fine-tune + multi-
 * anchor pitch refinement against the 3 annotated corpus boards.
 */
import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tightenAndChunk } from '../extraction/ccu-box-tighten.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../scripts/ccu-cv-corpus');

// The corpus is ~211 MB of S3-fetched photos + manifest, intentionally
// gitignored (see scripts/ccu-cv-corpus/.gitignore). Local devs pull it
// via build-manifest.mjs; CI runs in a fresh checkout where it doesn't
// exist. Skip the corpus-driven cases when the manifest is missing
// rather than failing CI — the registry-style edge-case tests below
// still run, and the algorithm has unit coverage via prepareModernGeometry
// in ccu-geometric.test.js.
const CORPUS_AVAILABLE = fs.existsSync(path.join(CORPUS, 'manifest.json'));
const describeIfCorpus = CORPUS_AVAILABLE ? describe : describe.skip;

function loadCorpusBoard(extractionId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const entry = manifest.entries.find((e) => e.extractionId === extractionId);
  if (!entry) throw new Error(`no manifest entry for ${extractionId}`);
  const photo = fs.readFileSync(path.join(CORPUS, entry.photo));
  return { entry, photo };
}

describeIfCorpus('ccu-box-tighten — corpus integration', () => {
  // The annotated corpus has Wylex (16 modules, GT) and Hager (16 modules, GT).
  // Protek 20-module ground truth lives in the harness corpus too — verify
  // that the algorithm produces consistent counts across all three.
  test.each([
    ['1777441303200-92evuu', 'Wylex', 16],
    ['1777454064331-nxw2u3', 'Hager', 16],
    ['1777540559865-3boowk', 'Protek', 20],
  ])(
    '%s (%s) — produces correct module count',
    async (id, name, expected) => {
      const { entry, photo } = loadCorpusBoard(id);
      const result = await tightenAndChunk(photo, entry.userBox);
      expect(result.moduleCount).toBe(expected);
      // Slot centres are monotonic and live within the rail face.
      expect(result.slotCentersPx.length).toBe(expected);
      for (let i = 1; i < result.slotCentersPx.length; i++) {
        expect(result.slotCentersPx[i]).toBeGreaterThan(result.slotCentersPx[i - 1]);
      }
      expect(result.slotCentersPx[0]).toBeGreaterThan(result.railFace.left);
      expect(result.slotCentersPx[result.slotCentersPx.length - 1]).toBeLessThan(
        result.railFace.right
      );
      // Rail face dimensions are positive and within the source image.
      expect(result.railFace.right - result.railFace.left).toBeGreaterThan(0);
      expect(result.railFace.bottom - result.railFace.top).toBeGreaterThan(0);
      expect(result.railFace.right).toBeLessThanOrEqual(result.imageWidth);
      expect(result.railFace.bottom).toBeLessThanOrEqual(result.imageHeight);
    },
    30_000
  );

  test('returns multi-anchor refinement diagnostics', async () => {
    const { entry, photo } = loadCorpusBoard('1777540559865-3boowk');
    const result = await tightenAndChunk(photo, entry.userBox);
    expect(result.refinement).toMatchObject({
      accepted: expect.any(Boolean),
      pairCount: expect.any(Number),
      probes: expect.any(Array),
    });
    expect(result.refinement.probes.length).toBe(8);
    for (const probe of result.refinement.probes) {
      expect(probe).toMatchObject({
        idx: expect.any(Number),
        predicted: expect.any(Number),
        refined: expect.any(Number),
        snr: expect.any(Number),
        sharpness: expect.any(Number),
        confident: expect.any(Boolean),
      });
    }
  }, 30_000);
});

describe('ccu-box-tighten — edge cases', () => {
  test('throws on empty buffer', async () => {
    await expect(tightenAndChunk(Buffer.alloc(0), { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow();
  });
});
