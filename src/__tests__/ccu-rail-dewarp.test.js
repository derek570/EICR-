/**
 * Tests for ccu-rail-dewarp.js.
 *
 * Coverage:
 *   - extendQuadForMargins: pure-math corner extension
 *   - dewarpRailQuad: end-to-end raw-buffer round-trip on a synthesised
 *     gradient image. Asserts the rectified output has the expected
 *     pixel content along the diagonal that maps from a known quad
 *     corner.
 */
import sharp from 'sharp';
import { dewarpRailQuad, extendQuadForMargins } from '../extraction/ccu-rail-dewarp.js';

describe('extendQuadForMargins', () => {
  test('axis-aligned 100×100 quad extends symmetrically with equal margins', () => {
    const quad = {
      tl: { x: 100, y: 100 },
      tr: { x: 200, y: 100 },
      bl: { x: 100, y: 200 },
      br: { x: 200, y: 200 },
    };
    const ext = extendQuadForMargins(quad, {
      marginAbove: 1.0,
      marginBelow: 1.0,
      marginHorizontal: 0.0,
    });
    // 100×100 rail, 100% above → tl/tr move up by 100, bl/br move down by 100
    expect(ext.tl).toEqual({ x: 100, y: 0 });
    expect(ext.tr).toEqual({ x: 200, y: 0 });
    expect(ext.bl).toEqual({ x: 100, y: 300 });
    expect(ext.br).toEqual({ x: 200, y: 300 });
  });

  test('axis-aligned quad extends horizontally with margin', () => {
    const quad = {
      tl: { x: 100, y: 100 },
      tr: { x: 200, y: 100 },
      bl: { x: 100, y: 200 },
      br: { x: 200, y: 200 },
    };
    const ext = extendQuadForMargins(quad, {
      marginAbove: 0,
      marginBelow: 0,
      marginHorizontal: 0.5,
    });
    // 100-wide rail, 50% margin → 50 px out each side
    expect(ext.tl.x).toBeCloseTo(50, 5);
    expect(ext.tr.x).toBeCloseTo(250, 5);
    expect(ext.bl.x).toBeCloseTo(50, 5);
    expect(ext.br.x).toBeCloseTo(250, 5);
  });

  test('tilted quad extends perpendicular to local edge', () => {
    // Tilt 45° clockwise — TL and TR rotated about the rail centre
    const s = Math.sqrt(2) / 2;
    const quad = {
      tl: { x: 0, y: 0 },
      tr: { x: 100 * s, y: 100 * s },
      // Down direction is perpendicular to TL→TR — for a 45° tilt the
      // "down" direction is (-s, s) scaled by 100 = (-70.7, 70.7).
      bl: { x: -100 * s, y: 100 * s },
      br: { x: 0, y: 2 * 100 * s },
    };
    const ext = extendQuadForMargins(quad, {
      marginAbove: 1.0,
      marginBelow: 0,
      marginHorizontal: 0,
    });
    // |down| = 100, so 100% above means moving each top corner by 100
    // px along the perpendicular outward (the "up" direction).
    const upDist = Math.sqrt((ext.tl.x - quad.tl.x) ** 2 + (ext.tl.y - quad.tl.y) ** 2);
    expect(upDist).toBeCloseTo(100, 3);
    // bl/br shouldn't move (marginBelow=0)
    expect(ext.bl.x).toBeCloseTo(quad.bl.x, 5);
    expect(ext.bl.y).toBeCloseTo(quad.bl.y, 5);
  });
});

describe('dewarpRailQuad', () => {
  // Synthesise a 400×400 RGB image with a colour gradient and a known
  // axis-aligned "rail" region (red square at [100..300, 150..250]).
  // Dewarping with the rail quad as identity should yield a rectified
  // image that contains the red region centred at the expected output
  // y range (with the configured margins above/below it).
  async function makeTestImage({ width = 400, height = 400 } = {}) {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 3;
        // Background: blue-grey gradient by x
        data[off] = 50;
        data[off + 1] = 50;
        data[off + 2] = 50 + Math.floor((x / width) * 100);
        // Red rail at [100..300, 150..250]
        if (x >= 100 && x < 300 && y >= 150 && y < 250) {
          data[off] = 220;
          data[off + 1] = 20;
          data[off + 2] = 20;
        }
      }
    }
    return sharp(data, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  test('axis-aligned quad with zero margins produces a rectangle matching the rail', async () => {
    const img = await makeTestImage();
    // Rail is at [100..300, 150..250]
    const quad = {
      tl: { x: 100, y: 150 },
      tr: { x: 300, y: 150 },
      bl: { x: 100, y: 250 },
      br: { x: 300, y: 250 },
    };
    const out = await dewarpRailQuad({
      imageBuffer: img,
      quad,
      marginAboveFraction: 0,
      marginBelowFraction: 0,
      marginHorizontalFraction: 0,
      outputWidth: 200,
    });
    expect(out.outputWidth).toBe(200);
    // Aspect ratio: rail is 200×100 (2:1) → output 200×100
    expect(out.outputHeight).toBe(100);
    // Sample the centre of the rectified image. Should be predominantly
    // red — the centre of the source rail.
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const off = (cy * info.width + cx) * info.channels;
    expect(data[off]).toBeGreaterThan(150); // R channel high
    expect(data[off + 1]).toBeLessThan(80); // G low
    expect(data[off + 2]).toBeLessThan(80); // B low
  });

  test('rejects malformed quad', async () => {
    const img = await makeTestImage();
    await expect(
      dewarpRailQuad({
        imageBuffer: img,
        quad: { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 } },
      })
    ).rejects.toThrow(/quad/);
  });

  test('rejects non-buffer imageBuffer', async () => {
    await expect(
      dewarpRailQuad({
        imageBuffer: 'not a buffer',
        quad: {
          tl: { x: 0, y: 0 },
          tr: { x: 10, y: 0 },
          bl: { x: 0, y: 10 },
          br: { x: 10, y: 10 },
        },
      })
    ).rejects.toThrow(/imageBuffer/);
  });

  test('tilted quad rectifies — sample inside-rail region is red after dewarp', async () => {
    // Synthesise an image with a tilted red bar. Use a parallelogram
    // sheared by 10 px in y over a 200 px width.
    const width = 400;
    const height = 400;
    const data = Buffer.alloc(width * height * 3, 50);
    // Tilted red rail: bar tilts down-to-right by 10 px over [100..300]
    // Mid-rail y at x=200 is ~200, but actual y range depends on x.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 3;
        const tilt = ((x - 100) / 200) * 10; // 0 → 10 across the rail
        const top = 150 + tilt;
        const bottom = 250 + tilt;
        if (x >= 100 && x < 300 && y >= top && y < bottom) {
          data[off] = 220;
          data[off + 1] = 20;
          data[off + 2] = 20;
        }
      }
    }
    const img = await sharp(data, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const quad = {
      tl: { x: 100, y: 150 },
      tr: { x: 300, y: 160 }, // tilted right side
      bl: { x: 100, y: 250 },
      br: { x: 300, y: 260 }, // tilted right side
    };
    const out = await dewarpRailQuad({
      imageBuffer: img,
      quad,
      marginAboveFraction: 0,
      marginBelowFraction: 0,
      marginHorizontalFraction: 0,
      outputWidth: 200,
    });
    const { data: outData, info } = await sharp(out.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    // After rectification, the entire rectified rail should be red.
    // Spot-check four positions: left-mid, right-mid, top-mid, bottom-mid.
    const samples = [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
      { x: 0.5, y: 0.25 },
      { x: 0.5, y: 0.75 },
    ];
    for (const s of samples) {
      const px = Math.floor(s.x * info.width);
      const py = Math.floor(s.y * info.height);
      const off = (py * info.width + px) * info.channels;
      expect(outData[off]).toBeGreaterThan(150);
      expect(outData[off + 1]).toBeLessThan(80);
    }
  });
});
