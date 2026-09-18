/**
 * cropToRailRegion width cap — every image that leaves the single-shot
 * crop stage is at most CCU_DEWARP_OUTPUT_WIDTH (default 2048) wide,
 * whichever geometry path produced it.
 *
 * Why: the dewarp path has resized to 2048 since 2026-05-22 (see the
 * history block in ccu-single-shot.js), but the axis-aligned bbox crop,
 * the rewireable panel crop and the two full-image fallbacks still sent
 * native pixel density. Field extraction 1789724736752-5boxmu
 * (2026-09-18) hit the bbox path after a quad-fit rejection and sent a
 * 3447 px crop — the regime the history block records as unreliable for
 * counting. These tests pin the cap on each non-dewarp path.
 */
import sharp from 'sharp';
import {
  cropToRailRegion,
  capToOutputWidth,
  resolveOutputWidthCap,
} from '../extraction/ccu-single-shot.js';

const W = 4096;
const H = 3072;

async function syntheticPhoto(width = W, height = H) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('cropToRailRegion width cap', () => {
  test('default cap is 2048 with no env override', () => {
    expect(resolveOutputWidthCap()).toBe(2048);
  });

  test('axis-aligned bbox crop wider than the cap is resized to the cap', async () => {
    const imageBuffer = await syntheticPhoto();
    // Rail spans ~77% of the width in permille units — same shape as
    // extraction 1789724736752-5boxmu (left 140.6, right 905.5).
    const prepared = {
      railQuad: null,
      panelBounds: null,
      railBbox: { left: 140.625, right: 905.517578125, top: 483.07, bottom: 674.48 },
    };
    const out = await cropToRailRegion({
      imageBuffer,
      prepared,
      imgW: W,
      imgH: H,
      isRewireable: false,
      logger: silentLogger,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(2048);
    // Aspect ratio preserved: the prod crop was 3447×2764.
    expect(meta.height).toBeGreaterThan(1500);
    expect(meta.height).toBeLessThan(1700);
  });

  test('bbox crop narrower than the cap is left at its native width', async () => {
    const imageBuffer = await syntheticPhoto(1600, 1200);
    const prepared = {
      railQuad: null,
      panelBounds: null,
      railBbox: { left: 100, right: 900, top: 450, bottom: 550 },
    };
    const out = await cropToRailRegion({
      imageBuffer,
      prepared,
      imgW: 1600,
      imgH: 1200,
      isRewireable: false,
      logger: silentLogger,
    });
    const meta = await sharp(out).metadata();
    // 800 permille of 1600 = 1280 px rail + 5% margins each side.
    expect(meta.width).toBeLessThanOrEqual(1408);
    expect(meta.width).toBeGreaterThan(1280);
  });

  test('rewireable panel crop goes through the same cap', async () => {
    const imageBuffer = await syntheticPhoto();
    const prepared = {
      railQuad: null,
      railBbox: null,
      panelBounds: { left: 300, right: 750, top: 400, bottom: 650 },
    };
    const out = await cropToRailRegion({
      imageBuffer,
      prepared,
      imgW: W,
      imgH: H,
      isRewireable: true,
      logger: silentLogger,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
  });

  test('missing bbox falls back to the full image, capped', async () => {
    const imageBuffer = await syntheticPhoto();
    const out = await cropToRailRegion({
      imageBuffer,
      prepared: { railQuad: null, railBbox: null, panelBounds: null },
      imgW: W,
      imgH: H,
      isRewireable: false,
      logger: silentLogger,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(1536);
  });

  test('capToOutputWidth never upsamples', async () => {
    const small = await syntheticPhoto(1200, 900);
    const out = await capToOutputWidth(small, { logger: silentLogger, reason: 'test' });
    expect(out).toBe(small);
  });
});
