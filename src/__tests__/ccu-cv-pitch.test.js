/**
 * Unit tests for ccu-cv-pitch — synthetic periodic images with known pitch
 * verify the autocorrelation finds the right lag.
 */
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
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
});
