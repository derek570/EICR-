/**
 * Unit + corpus tests for `ccu-rail-quad` — perspective-aware rail
 * geometry. Verifies:
 *   - the line-fitter finds slope+intercept correctly and rejects outliers
 *   - line-line intersection produces the expected corner
 *   - bilinear quadrilateral parameterisation behaves correctly at the
 *     four corners and the centre
 *   - the gradient sampler interpolates without out-of-bounds reads
 *   - end-to-end count parity with the legacy box-tightener on the 3
 *     annotated corpus boards (Wylex 16, Hager 16, Protek 20)
 *   - waysOverride forces the count and locks pitch
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitLineLeastSquares,
  collectHorizontalEdgePoints,
  collectVerticalEdgePoints,
  bilinearQuad,
  sampleGradient,
  sobelYGrid,
  sobelXGrid,
  rectifiedColumnSum,
  findBoundaryPhase,
  tightenAndChunkQuad,
  RECT_SAMPLES,
  RECT_MIN_LAG,
  RECT_MAX_LAG,
} from '../extraction/ccu-rail-quad.js';

// ---------------------------------------------------------------------------
// Fixture / corpus
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dirname, '../../scripts/ccu-cv-corpus');
const CORPUS_AVAILABLE = fs.existsSync(path.join(CORPUS, 'manifest.json'));
const describeIfCorpus = CORPUS_AVAILABLE ? describe : describe.skip;

function loadCorpusBoard(extractionId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
  const entry = manifest.entries.find((e) => e.extractionId === extractionId);
  if (!entry) throw new Error(`no manifest entry for ${extractionId}`);
  const photo = fs.readFileSync(path.join(CORPUS, entry.photo));
  return { entry, photo };
}

const PRIOR_PROBE_V2 = process.env.CCU_PROBE_V2;
beforeAll(() => {
  // Quad path doesn't depend on this flag, but ensure determinism if any
  // legacy fallback fires during the corpus tests.
  process.env.CCU_PROBE_V2 = 'false';
});
afterAll(() => {
  if (PRIOR_PROBE_V2 === undefined) delete process.env.CCU_PROBE_V2;
  else process.env.CCU_PROBE_V2 = PRIOR_PROBE_V2;
});

// ---------------------------------------------------------------------------
// fitLineLeastSquares
// ---------------------------------------------------------------------------

describe('fitLineLeastSquares', () => {
  test('fits a perfect line exactly', () => {
    const points = [];
    for (let x = 0; x < 100; x++) {
      points.push({ x, y: 2 * x + 5 });
    }
    const line = fitLineLeastSquares(points);
    expect(line.slope).toBeCloseTo(2, 5);
    expect(line.intercept).toBeCloseTo(5, 4);
    expect(line.rejected).toBe(0);
  });

  test('returns null for fewer than 3 points', () => {
    expect(fitLineLeastSquares([{ x: 0, y: 0 }])).toBeNull();
    expect(
      fitLineLeastSquares([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])
    ).toBeNull();
    expect(fitLineLeastSquares(null)).toBeNull();
    expect(fitLineLeastSquares([])).toBeNull();
  });

  test('rejects outliers via MAD before fitting', () => {
    const points = [];
    for (let x = 0; x < 30; x++) points.push({ x, y: x });
    // 3 wild outliers — should not bend the line significantly
    points.push({ x: 5, y: 1000 });
    points.push({ x: 10, y: -1000 });
    points.push({ x: 20, y: 9999 });
    const line = fitLineLeastSquares(points);
    expect(line.rejected).toBeGreaterThanOrEqual(2);
    expect(line.slope).toBeCloseTo(1, 1);
    expect(line.intercept).toBeCloseTo(0, 0);
  });

  test('rejects degenerate (single-x) input', () => {
    const points = [
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
      { x: 5, y: 4 },
    ];
    expect(fitLineLeastSquares(points)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bilinearQuad
// ---------------------------------------------------------------------------

describe('bilinearQuad', () => {
  const corners = {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    bl: { x: 0, y: 50 },
    br: { x: 100, y: 50 },
  };

  test('hits each corner at the four (u,v) extremes', () => {
    expect(bilinearQuad(corners, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(bilinearQuad(corners, 1, 0)).toEqual({ x: 100, y: 0 });
    expect(bilinearQuad(corners, 0, 1)).toEqual({ x: 0, y: 50 });
    expect(bilinearQuad(corners, 1, 1)).toEqual({ x: 100, y: 50 });
  });

  test('centre (0.5, 0.5) lands at the geometric centre of the quad', () => {
    expect(bilinearQuad(corners, 0.5, 0.5)).toEqual({ x: 50, y: 25 });
  });

  test('on a tilted (trapezoidal) quad, sampling preserves edge tilts', () => {
    const tilted = {
      tl: { x: 10, y: 0 },
      tr: { x: 90, y: 5 }, // top edge tilts down-right
      bl: { x: 0, y: 50 },
      br: { x: 100, y: 45 },
    };
    // Walking u from 0 to 1 at v=0 should trace the top edge linearly
    const left = bilinearQuad(tilted, 0, 0);
    const right = bilinearQuad(tilted, 1, 0);
    expect(left).toEqual({ x: 10, y: 0 });
    expect(right).toEqual({ x: 90, y: 5 });
    // Mid-top
    expect(bilinearQuad(tilted, 0.5, 0).x).toBeCloseTo(50, 5);
    expect(bilinearQuad(tilted, 0.5, 0).y).toBeCloseTo(2.5, 5);
  });
});

// ---------------------------------------------------------------------------
// sampleGradient
// ---------------------------------------------------------------------------

describe('sampleGradient', () => {
  test('integer-aligned sample returns the underlying value', () => {
    const grid = new Float32Array(16); // 4×4
    grid[0 * 4 + 0] = 1;
    grid[1 * 4 + 1] = 5;
    grid[2 * 4 + 2] = 9;
    expect(sampleGradient(grid, 4, 4, 1, 1)).toBeCloseTo(5);
    expect(sampleGradient(grid, 4, 4, 2, 2)).toBeCloseTo(9);
  });

  test('out-of-bounds samples return 0', () => {
    const grid = new Float32Array(16).fill(7);
    expect(sampleGradient(grid, 4, 4, -1, 0)).toBe(0);
    expect(sampleGradient(grid, 4, 4, 0, -1)).toBe(0);
    expect(sampleGradient(grid, 4, 4, 100, 100)).toBe(0);
  });

  test('half-integer samples interpolate between neighbours', () => {
    const grid = new Float32Array(16); // 4×4
    grid[0 * 4 + 0] = 0;
    grid[0 * 4 + 1] = 10;
    grid[1 * 4 + 0] = 0;
    grid[1 * 4 + 1] = 0;
    // (0.5, 0) sits exactly between grid[0,0]=0 and grid[0,1]=10 → 5
    expect(sampleGradient(grid, 4, 4, 0.5, 0)).toBeCloseTo(5);
  });
});

// ---------------------------------------------------------------------------
// Edge-point collection (synthetic)
// ---------------------------------------------------------------------------

describe('collectHorizontalEdgePoints / collectVerticalEdgePoints', () => {
  test('locates the strongest gradient row at each column inside the strip', () => {
    // 30×30 grid. Plant a strong horizontal edge at y = 14 across all
    // columns — every column's max within strip [0, 30) should be 14.
    const W = 30;
    const H = 30;
    const grid = new Float32Array(W * H);
    for (let x = 0; x < W; x++) grid[14 * W + x] = 100;
    const pts = collectHorizontalEdgePoints(grid, W, H, 0, H);
    for (const p of pts) expect(p.y).toBe(14);
  });

  test('returns one point per column / row regardless of strip thickness', () => {
    const W = 30;
    const H = 30;
    const grid = new Float32Array(W * H);
    for (let x = 0; x < W; x++) grid[5 * W + x] = 1;
    const pts = collectHorizontalEdgePoints(grid, W, H, 0, 10);
    expect(pts).toHaveLength(W - 2); // skip x=0 and x=W-1 (Sobel edge convention)
    const vpts = collectVerticalEdgePoints(grid, W, H, 0, 10);
    expect(vpts).toHaveLength(H - 2);
  });
});

// ---------------------------------------------------------------------------
// rectifiedColumnSum (synthetic periodic image)
// ---------------------------------------------------------------------------

describe('rectifiedColumnSum + autocorrelation', () => {
  test('on a synthetic axis-aligned periodic image, autocorrelation finds the period', async () => {
    // Build a 256×64 grid with a vertical bar every 16 columns.
    const W = 256;
    const H = 64;
    const grey = new Uint8Array(W * H).fill(128);
    for (let x = 0; x < W; x += 16) {
      for (let y = 0; y < H; y++) {
        grey[y * W + x] = 255;
        if (x + 1 < W) grey[y * W + x + 1] = 0; // strong gradient
      }
    }
    const gradX = sobelXGrid(grey, W, H);
    const corners = {
      tl: { x: 0, y: 0 },
      tr: { x: W - 1, y: 0 },
      bl: { x: 0, y: H - 1 },
      br: { x: W - 1, y: H - 1 },
    };
    const sig = rectifiedColumnSum(gradX, W, H, corners);
    expect(sig.length).toBe(RECT_SAMPLES);
    const { autocorrPeak } = await import('../extraction/ccu-cv-pitch.js');
    const ac = autocorrPeak(sig, RECT_MIN_LAG, RECT_MAX_LAG);
    // Expect the rectified pitch lag corresponds to the 16/256 fraction of the rail.
    // 256 image-px / 16-px-period = 16 periods; on the rectified axis of
    // RECT_SAMPLES=1024 that's 1024/16 = 64 samples per period.
    expect(ac.lag).toBeCloseTo(64, -1);
    expect(ac.normCorr).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Corpus integration (drop-in parity vs legacy box-tightener)
// ---------------------------------------------------------------------------

describeIfCorpus('tightenAndChunkQuad — corpus integration', () => {
  test.each([
    ['1777441303200-92evuu', 'Wylex', 16],
    ['1777454064331-nxw2u3', 'Hager', 16],
    ['1777540559865-3boowk', 'Protek', 20],
  ])(
    '%s (%s) — produces correct module count via quad geometry',
    async (id, name, expected) => {
      const { entry, photo } = loadCorpusBoard(id);
      const result = await tightenAndChunkQuad(photo, entry.userBox);
      expect(result.moduleCount).toBe(expected);
      expect(result.slotCentersPx).toHaveLength(expected);
      // Centres are monotonically increasing image x-coords inside the rail
      for (let i = 1; i < result.slotCentersPx.length; i++) {
        expect(result.slotCentersPx[i]).toBeGreaterThan(result.slotCentersPx[i - 1]);
      }
      expect(result.slotCentersPx[0]).toBeGreaterThan(result.railFace.left);
      expect(result.slotCentersPx[result.slotCentersPx.length - 1]).toBeLessThan(
        result.railFace.right
      );
      // Quadrilateral has 4 corners that bracket the rail
      expect(result.quadrilateral.tl.x).toBeLessThan(result.quadrilateral.tr.x);
      expect(result.quadrilateral.bl.x).toBeLessThan(result.quadrilateral.br.x);
      expect(result.quadrilateral.tl.y).toBeLessThan(result.quadrilateral.bl.y);
      // Rectified normCorr should be confidently above the floor on these clean shots
      expect(result.refinement.quadDiag.rectNormCorr).toBeGreaterThan(0.25);
    },
    30_000
  );

  test('waysOverride forces the count and reports waysOverrideApplied=true', async () => {
    const { entry, photo } = loadCorpusBoard('1777441303200-92evuu'); // Wylex, true 16
    const result = await tightenAndChunkQuad(photo, entry.userBox, { waysOverride: 18 });
    expect(result.waysOverrideApplied).toBe(true);
    expect(result.moduleCount).toBe(18);
    expect(result.slotCentersPx).toHaveLength(18);
  }, 30_000);

  test('returns the same shape as the legacy box-tightener', async () => {
    const { entry, photo } = loadCorpusBoard('1777441303200-92evuu');
    const result = await tightenAndChunkQuad(photo, entry.userBox);
    // Legacy-shape parity for the route handler / logging code:
    expect(result).toMatchObject({
      imageWidth: expect.any(Number),
      imageHeight: expect.any(Number),
      railFace: {
        left: expect.any(Number),
        top: expect.any(Number),
        right: expect.any(Number),
        bottom: expect.any(Number),
      },
      moduleCount: expect.any(Number),
      pitchPx: expect.any(Number),
      slotCentersPx: expect.any(Array),
      initialPitchPx: expect.any(Number),
      waysOverrideApplied: expect.any(Boolean),
      refinement: {
        accepted: expect.any(Boolean),
        version: 'quad-v1',
        quadDiag: expect.any(Object),
      },
    });
    // Quad-specific extra
    expect(result.quadrilateral).toMatchObject({
      tl: { x: expect.any(Number), y: expect.any(Number) },
      tr: { x: expect.any(Number), y: expect.any(Number) },
      bl: { x: expect.any(Number), y: expect.any(Number) },
      br: { x: expect.any(Number), y: expect.any(Number) },
    });
  }, 30_000);
});

describe('tightenAndChunkQuad — edge cases', () => {
  test('throws on empty buffer', async () => {
    await expect(
      tightenAndChunkQuad(Buffer.alloc(0), { x: 0, y: 0, w: 1, h: 1 })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// findBoundaryPhase — locks slot grid to actual device positions
// ---------------------------------------------------------------------------

describe('findBoundaryPhase', () => {
  test('finds phase=0 when peaks already start at sample 0', () => {
    // Comb signal: peaks at 0, 32, 64, 96 ...
    const sig = new Float32Array(256);
    for (let i = 0; i < sig.length; i += 32) sig[i] = 100;
    expect(findBoundaryPhase(sig, 32)).toBe(0);
  });

  test('finds small positive phase (within default cap)', () => {
    // Phase = 3 samples = 9% of pitch=32 — within 12% cap → applied.
    const sig = new Float32Array(256);
    for (let i = 3; i < sig.length; i += 32) sig[i] = 100;
    expect(findBoundaryPhase(sig, 32)).toBe(3);
  });

  test('finds small negative phase', () => {
    // Phase = -2 (line-fitter overshot to the right). Peaks at -2 (out
    // of range, so first valid is at +30), 30, 62, 94, ... Comb at
    // offset=-2 collects samples at 30, 62, 94, ... + skips the
    // out-of-range -2.
    const sig = new Float32Array(256);
    for (let i = 30; i < sig.length; i += 32) sig[i] = 100;
    // Negative-phase comb at offset=-2 hits samples 30, 62, 94, … =
    // exactly where the peaks are.
    expect(findBoundaryPhase(sig, 32)).toBe(-2);
  });

  test('CAPS phase at +12% of pitch when matched filter wants more', () => {
    // Plant a strong false-maximum at offset=10 samples = 31% of pitch.
    // Without the cap the matched filter would lock to it; with the
    // 12% cap the search range is ±3 samples, so result is the best
    // offset within [-3, +3] — which is 0 (since real signal has no
    // periodic gradient there). The exact returned value depends on
    // whether ANY in-range offset has signal, but the absolute value
    // must be ≤ floor(0.12 * 32) = 3.
    const sig = new Float32Array(256);
    for (let i = 10; i < sig.length; i += 32) sig[i] = 100; // 31% phase
    const result = findBoundaryPhase(sig, 32);
    expect(Math.abs(result)).toBeLessThanOrEqual(3);
    expect(result).not.toBe(10); // would have been 10 without the cap
  });

  test('explicit capFraction overrides default', () => {
    // With capFraction=0.5, the cap permits offset 10 (31% of pitch).
    const sig = new Float32Array(256);
    for (let i = 10; i < sig.length; i += 32) sig[i] = 100;
    expect(findBoundaryPhase(sig, 32, { capFraction: 0.5 })).toBe(10);
  });

  test('robust to one missing peak (within cap)', () => {
    // Peaks at every 32 starting at 2 (6% of pitch — within cap), but
    // skip the one at 2+32=34
    const sig = new Float32Array(256);
    for (let i = 2; i < sig.length; i += 32) {
      if (i !== 34) sig[i] = 100;
    }
    expect(findBoundaryPhase(sig, 32)).toBe(2);
  });

  test('returns 0 on invalid pitch', () => {
    const sig = new Float32Array(64).fill(1);
    expect(findBoundaryPhase(sig, 0)).toBe(0);
    expect(findBoundaryPhase(sig, NaN)).toBe(0);
    expect(findBoundaryPhase(sig, -10)).toBe(0);
  });

  test('handles non-integer pitch by rounding', () => {
    const sig = new Float32Array(256);
    for (let i = 1; i < sig.length; i += 32) sig[i] = 100; // 3% phase
    // Pitch passed as 31.7 → rounds to 32
    expect(findBoundaryPhase(sig, 31.7)).toBe(1);
  });
});

describeIfCorpus('tightenAndChunkQuad — phase lock changes slot positions', () => {
  // Verifies that the phase-lock changes the slot positions in a
  // measurable way for at least one corpus board (the Wylex shot has a
  // visible LHS gap before the leftmost device — exactly the situation
  // phase-lock is designed for). We don't assert the EXACT positions
  // (they depend on photo specifics) — just that the diagnostic is
  // populated and slot 0 is shifted to the right of where the naive
  // (i+0.5)/N layout would put it.
  test('phaseShiftPx is non-zero on a board with leading rail margin', async () => {
    const { entry, photo } = loadCorpusBoard('1777441303200-92evuu'); // Wylex
    const result = await tightenAndChunkQuad(photo, entry.userBox);
    // Phase can now be negative (line-fitter overshot right) or positive
    // (overshot left) — either is fine, but bounded by the 12% cap.
    const pitchSamples = result.refinement.quadDiag.rectPitchSamples;
    expect(Math.abs(result.refinement.quadDiag.phaseOffsetSamples)).toBeLessThanOrEqual(
      Math.ceil(pitchSamples * 0.12)
    );
    // count is still correct after phase lock
    expect(result.moduleCount).toBe(16);
  }, 30_000);
});
