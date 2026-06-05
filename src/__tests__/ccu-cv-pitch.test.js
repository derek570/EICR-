/**
 * Unit tests for ccu-cv-pitch — synthetic periodic images with known pitch
 * verify the autocorrelation finds the right lag.
 */
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  detectModulePitchCv,
  sobelXColumnSum,
  movingAverage3,
  autocorrPeak,
} from '../extraction/ccu-cv-pitch.js';

/**
 * Build a synthetic image with vertical bars at known pitch (px). Each bar
 * is a single dark column on a light background — gives clean Sobel-X
 * peaks at every bar boundary.
 */
async function makePeriodicImage(width, height, pitchPx) {
  const buf = Buffer.alloc(width * height * 3, 240); // light grey background
  for (let x = 0; x < width; x++) {
    if (Math.floor(x / pitchPx) !== Math.floor((x - 1) / pitchPx)) {
      // boundary between modules → dark vertical line, 2 px wide
      for (let y = 0; y < height; y++) {
        for (let dx = 0; dx < 2; dx++) {
          if (x + dx < width) {
            const i = (y * width + (x + dx)) * 3;
            buf[i] = 30;
            buf[i + 1] = 30;
            buf[i + 2] = 30;
          }
        }
      }
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toBuffer();
}

describe('ccu-cv-pitch internals', () => {
  test('movingAverage3 smooths interior, preserves endpoints', () => {
    const out = movingAverage3(Float32Array.from([10, 20, 30, 40, 50]));
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(20); // (10+20+30)/3
    expect(out[2]).toBe(30);
    expect(out[3]).toBe(40);
    expect(out[4]).toBe(50);
  });

  test('autocorrPeak finds period of pure sine wave', () => {
    const N = 1000;
    const period = 80;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.sin((2 * Math.PI * i) / period);
    const { lag, normCorr } = autocorrPeak(sig, 40, 200);
    // Should land within ±2 px of the true period.
    expect(Math.abs(lag - period)).toBeLessThanOrEqual(2);
    // Pure sine should have very high correlation.
    expect(normCorr).toBeGreaterThan(0.9);
  });

  test('autocorrPeak returns low normCorr on white noise', () => {
    const N = 500;
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = Math.random() - 0.5;
    const { normCorr } = autocorrPeak(sig, 40, 200);
    expect(normCorr).toBeLessThan(0.2);
  });

  test('sobelXColumnSum produces expected length', () => {
    const W = 20,
      H = 10;
    const grey = Buffer.alloc(W * H, 128);
    const cs = sobelXColumnSum(grey, W, H);
    expect(cs.length).toBe(W);
    // Flat input → all sums zero (no edges anywhere).
    for (let i = 0; i < W; i++) expect(cs[i]).toBe(0);
  });
});

describe('detectModulePitchCv — synthetic periodic image', () => {
  test('finds 80px pitch in a synthetic 1000×200 periodic image', async () => {
    const W = 1000,
      H = 200,
      pitch = 80;
    const img = await makePeriodicImage(W, H, pitch);
    const result = await detectModulePitchCv(img, { left: 0, right: W, top: 0, bottom: H });
    expect(result).not.toBeNull();
    expect(result.pitchPx).toBeGreaterThanOrEqual(pitch - 2);
    expect(result.pitchPx).toBeLessThanOrEqual(pitch + 2);
    // 1000 / 80 = 12.5 → rounds to 12 or 13 depending on detected pitch.
    expect(result.moduleCount).toBeGreaterThanOrEqual(12);
    expect(result.moduleCount).toBeLessThanOrEqual(13);
    expect(result.normCorr).toBeGreaterThan(0.5);
  });

  test('returns low-confidence on a flat (non-periodic) image', async () => {
    const W = 500,
      H = 100;
    const flat = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const result = await detectModulePitchCv(flat, { left: 0, right: W, top: 0, bottom: H });
    expect(result.reason).toBe('low-confidence');
    expect(result.pitchPx).toBeDefined(); // surfaced for telemetry but caller ignores
  });

  test('returns rail-too-narrow when bbox is below MIN_CYCLES × MIN_LAG', async () => {
    const W = 100,
      H = 50;
    const img = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const result = await detectModulePitchCv(img, { left: 0, right: W, top: 0, bottom: H });
    expect(result.reason).toBe('rail-too-narrow');
  });

  test('returns empty-bbox on zero-width crop', async () => {
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const result = await detectModulePitchCv(img, { left: 50, right: 50, top: 0, bottom: 100 });
    expect(result.reason).toBe('empty-bbox');
  });

  // Regression for 2026-04-30 prod failure: high-resolution Hager job at
  // 5973×1119 produced a module pitch of ~290 px, well above the old
  // hard-cap MAX_LAG of 200. CV pitch silently fell back to noise (pitchPx
  // 62, normCorr 0.169) and the height-anchor over-counted to 18 vs the
  // ground-truth 16. Fix replaced the constant cap with a rail-width-derived
  // dynamic cap (with 800-px ceiling). This test locks the fix in: the
  // Wylex NHRS12SL corpus photo upscaled 3.5× (~5600 px wide, ~257 px true
  // pitch — same regime as the failing prod photo) must be detected
  // correctly, NOT fall through to low-confidence.
  //
  // Synthetic-bar images are unsuitable for this test — pure 2-px bars
  // autocorrelate equally at every multiple of the pitch, so the algorithm
  // can land on the second or third harmonic. Real CCU photos (with body
  // texture, label strips, varying breaker colours) have a much stronger
  // fundamental peak. The corpus photo replicates the real signal shape.
  test('detects high-pitch on upscaled real CCU photo (prod regression)', async () => {
    const corpusPath = path.resolve(
      __dirname,
      '../../scripts/ccu-cv-corpus/raw/1777441303200-92evuu/original.jpg'
    );
    if (!fs.existsSync(corpusPath)) {
      // Don't make CI choke if the corpus isn't present (it's gitignored).
      // Skip with a clear log instead.
      console.warn(`[skip] corpus photo not found at ${corpusPath}`);
      return;
    }
    const original = fs.readFileSync(corpusPath);
    const meta0 = await sharp(original).metadata();
    const upscaled = await sharp(original)
      .resize({ width: Math.round(meta0.width * 3.5) })
      .jpeg({ quality: 90 })
      .toBuffer();
    const meta = await sharp(upscaled).metadata();
    // medianRails for this photo (verified ground truth: 16 modules):
    // rail_left 109, rail_right 842, rail_top 430, rail_bottom 588 (0-1000).
    const rail = {
      left: 0.109 * meta.width,
      right: 0.842 * meta.width,
      top: 0.43 * meta.height,
      bottom: 0.588 * meta.height,
    };
    const result = await detectModulePitchCv(upscaled, rail);
    expect(result).not.toBeNull();
    expect(result.reason).toBeUndefined(); // not low-confidence, not too-narrow
    // Real photo at 3.5× → pitch around 250-260 px. Allow generous band
    // because exact value depends on JPEG re-encoding interpolation.
    expect(result.pitchPx).toBeGreaterThanOrEqual(245);
    expect(result.pitchPx).toBeLessThanOrEqual(270);
    expect(result.moduleCount).toBe(16);
    expect(result.normCorr).toBeGreaterThan(0.3);
  });
});
