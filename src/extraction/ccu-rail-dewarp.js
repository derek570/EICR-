/**
 * CCU rail-region perspective dewarp.
 *
 * Replaces the axis-aligned `sharp.extract()` crop in ccu-single-shot.js
 * with a quad-aware rectification: given the four corners of the rail
 * (already detected by `tightenAndChunkQuad` in ccu-rail-quad.js), this
 * module maps the rail + a configurable label-margin band above and
 * below onto an axis-aligned rectangle.
 *
 * WHY
 * Camera tilt and off-axis framing are routine when an inspector
 * photographs a populated 19-module CCU at arm's length. A 0.3° rail
 * tilt accumulates to an ~8 px y-shift across a 1683 px rail width;
 * combined with mild keystone (left edge sloping more than right) that
 * pushes the label strip's "above-rail" zone into different vertical
 * bands at different x positions. The downstream VLM then sees label
 * text from slot N+1 inside slot N's vertical zone — manifesting as
 * cross-slot label bleed and uniform low-confidence reads. Rectifying
 * the rail to axis-aligned restores the spatial assumption the VLM
 * prompt and the per-slot crop geometry both implicitly make.
 *
 * APPROACH
 * 1. Take the rail quad (tl, tr, bl, br) in source-image pixel coords.
 * 2. Extend it outward along the rail's local-perpendicular direction
 *    by `marginAboveFraction` of rail height above and
 *    `marginBelowFraction` below. Each corner gets its own perpendicular
 *    so keystoned rails extend correctly. The label strip in the
 *    physical board is parallel to the rail, so this extension
 *    captures the same physical region of the schedule strip.
 * 3. Sample the source image at `outputWidth × outputHeight` output
 *    pixels via bilinear-quad parameterisation. For each output
 *    (u, v) ∈ [0,1]², compute the source (x, y) and bilinear-sample
 *    RGB from the source raw buffer.
 * 4. Encode the rectified buffer as JPEG and return.
 *
 * Bilinear-quad is used instead of a true projective homography
 * because the existing `bilinearQuad` primitive in ccu-rail-quad.js
 * (line 277) has a documented < 1 px error on typical CCU photos —
 * the four corners are close enough to a parallelogram that the
 * difference doesn't reach pixel resolution. Avoids adding a
 * dependency.
 *
 * OUTPUT RESOLUTION
 * Default `outputWidth: null` means "preserve native pixel density" —
 * the output width is computed from the extended quad's actual width
 * in source pixels, capped at the source image's width so we never
 * synthesise detail by upsampling. This sends the VLM as many pixels
 * per MCB face as the camera captured, which empirically improves
 * OCR on small label printing and faint device-face text. Pass an
 * explicit number to override (used for the legacy fixed-output path
 * and for tests). Output height is computed from extended-quad aspect
 * so the rectified image preserves the rail's shape ratio.
 *
 * FAILURE
 * Any error throws; the caller in `cropToRailRegion` is expected to
 * catch and fall back to the legacy axis-aligned extract so the
 * single-shot path is never blocked by a dewarp regression.
 */
import sharp from 'sharp';

// Compute |v|
function len({ x, y }) {
  return Math.sqrt(x * x + y * y);
}

// Normalised vector v / |v|
function normalize({ x, y }) {
  const l = len({ x, y }) || 1;
  return { x: x / l, y: y / l };
}

// Bilinear quad parameterisation: P(u, v) ∈ [0,1]² maps to
//   (1-u)(1-v)·TL + u(1-v)·TR + (1-u)v·BL + uv·BR
// applied inline in the hot loop below to avoid call overhead per
// output pixel. Same formula as ccu-rail-quad.js:bilinearQuad — kept
// local rather than re-importing to avoid pulling its autocorrelation
// buffers in on the rewireable single-shot path that never uses them.

/**
 * Extend a rail quad outward along the rail's local-perpendicular
 * direction to include label-margin bands above and below.
 *
 * `marginAboveFraction` and `marginBelowFraction` are expressed as
 * multiples of the rail's local height at that corner. So 2.0 means
 * "200% of rail height above the rail" — matching the existing
 * cropToRailRegion's 200% vertical margins.
 *
 * The horizontal extension uses the rail's left and right edges'
 * directions, so a keystoned rail still gets horizontal margin
 * proportional to the rail's local face length at each end.
 */
export function extendQuadForMargins(quad, { marginAbove, marginBelow, marginHorizontal }) {
  // Local "down" at left side = bl - tl
  const downL = { x: quad.bl.x - quad.tl.x, y: quad.bl.y - quad.tl.y };
  const downR = { x: quad.br.x - quad.tr.x, y: quad.br.y - quad.tr.y };
  const heightL = len(downL);
  const heightR = len(downR);
  // Unit vectors along the rail's local-perpendicular at each end
  const upLu = normalize({ x: -downL.x, y: -downL.y });
  const downLu = normalize(downL);
  const upRu = normalize({ x: -downR.x, y: -downR.y });
  const downRu = normalize(downR);

  // Local "right" at top side = tr - tl
  const rightT = { x: quad.tr.x - quad.tl.x, y: quad.tr.y - quad.tl.y };
  const rightB = { x: quad.br.x - quad.bl.x, y: quad.br.y - quad.bl.y };
  const widthT = len(rightT);
  const widthB = len(rightB);
  const leftTu = normalize({ x: -rightT.x, y: -rightT.y });
  const rightTu = normalize(rightT);
  const leftBu = normalize({ x: -rightB.x, y: -rightB.y });
  const rightBu = normalize(rightB);

  const aboveL = heightL * marginAbove;
  const aboveR = heightR * marginAbove;
  const belowL = heightL * marginBelow;
  const belowR = heightR * marginBelow;
  const horizT = widthT * marginHorizontal;
  const horizB = widthB * marginHorizontal;

  // Extend each corner: outward perpendicular AND outward along rail.
  return {
    tl: {
      x: quad.tl.x + upLu.x * aboveL + leftTu.x * horizT,
      y: quad.tl.y + upLu.y * aboveL + leftTu.y * horizT,
    },
    tr: {
      x: quad.tr.x + upRu.x * aboveR + rightTu.x * horizT,
      y: quad.tr.y + upRu.y * aboveR + rightTu.y * horizT,
    },
    bl: {
      x: quad.bl.x + downLu.x * belowL + leftBu.x * horizB,
      y: quad.bl.y + downLu.y * belowL + leftBu.y * horizB,
    },
    br: {
      x: quad.br.x + downRu.x * belowR + rightBu.x * horizB,
      y: quad.br.y + downRu.y * belowR + rightBu.y * horizB,
    },
  };
}

/**
 * Choose output dimensions from the extended quad. We preserve the
 * aspect ratio of the extended rail face — width from the average of
 * top and bottom edges, height from the average of left and right.
 *
 * `targetWidth` controls output width:
 *   - `null` / `0` / undefined → preserve native pixel density (use the
 *     extended quad's actual width in source pixels). Capped at
 *     `srcWidth` so we never upsample.
 *   - explicit positive number → use that.
 * Output height is derived to preserve aspect.
 */
function pickOutputSize(extendedQuad, targetWidth, srcWidth) {
  const widthTop = len({
    x: extendedQuad.tr.x - extendedQuad.tl.x,
    y: extendedQuad.tr.y - extendedQuad.tl.y,
  });
  const widthBot = len({
    x: extendedQuad.br.x - extendedQuad.bl.x,
    y: extendedQuad.br.y - extendedQuad.bl.y,
  });
  const heightL = len({
    x: extendedQuad.bl.x - extendedQuad.tl.x,
    y: extendedQuad.bl.y - extendedQuad.tl.y,
  });
  const heightR = len({
    x: extendedQuad.br.x - extendedQuad.tr.x,
    y: extendedQuad.br.y - extendedQuad.tr.y,
  });
  const avgWidth = (widthTop + widthBot) / 2;
  const avgHeight = (heightL + heightR) / 2;
  const aspect = avgHeight / Math.max(1, avgWidth);
  let widthPx;
  if (targetWidth == null || targetWidth <= 0) {
    const cap = Number.isFinite(srcWidth) && srcWidth > 0 ? srcWidth : Infinity;
    widthPx = Math.min(cap, Math.round(avgWidth));
  } else {
    widthPx = Math.round(targetWidth);
  }
  const outputWidth = Math.max(64, widthPx);
  const outputHeight = Math.max(32, Math.round(outputWidth * aspect));
  return { outputWidth, outputHeight };
}

/**
 * Dewarp the rail region of a CCU photo onto an axis-aligned
 * rectangle.
 *
 * @param {object}  args
 * @param {Buffer}  args.imageBuffer
 * @param {{tl:{x,y}, tr:{x,y}, bl:{x,y}, br:{x,y}}} args.quad — rail
 *        quad in source-image pixel coords. Y grows downward.
 * @param {number}  [args.marginAboveFraction=2.0]   — above the rail
 * @param {number}  [args.marginBelowFraction=2.0]   — below the rail
 * @param {number}  [args.marginHorizontalFraction=0.10] — beyond rail ends,
 *        ~1 module width on a 19-way board. Gives the VLM breathing
 *        room when the box-tightener clips the rail short.
 * @param {number|null}  [args.outputWidth=null] — null = preserve native
 *        pixel density from source; explicit number overrides.
 * @returns {Promise<{buffer:Buffer, outputWidth:number, outputHeight:number,
 *                    extendedQuad:object, ms:number}>}
 */
export async function dewarpRailQuad({
  imageBuffer,
  quad,
  marginAboveFraction = 2.0,
  marginBelowFraction = 2.0,
  marginHorizontalFraction = 0.1,
  outputWidth: targetWidth = null,
}) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('dewarpRailQuad: imageBuffer must be a Buffer');
  }
  if (
    !quad ||
    !quad.tl ||
    !quad.tr ||
    !quad.bl ||
    !quad.br ||
    !Number.isFinite(quad.tl.x) ||
    !Number.isFinite(quad.tl.y) ||
    !Number.isFinite(quad.tr.x) ||
    !Number.isFinite(quad.tr.y) ||
    !Number.isFinite(quad.bl.x) ||
    !Number.isFinite(quad.bl.y) ||
    !Number.isFinite(quad.br.x) ||
    !Number.isFinite(quad.br.y)
  ) {
    throw new Error('dewarpRailQuad: quad must have finite tl/tr/bl/br {x, y}');
  }

  const start = Date.now();

  // Read source as raw pixel data. We need pixel-level access for
  // bilinear sampling, and srcW must be known before pickOutputSize so
  // native-mode output width can be capped at the source's width.
  //
  // sharp returns RGB (3 channels) for JPEGs and RGBA (4 channels) for
  // PNGs with alpha. We support both — we only read R/G/B and ignore
  // any alpha. Stride is `width * srcChannels` bytes per row.
  const { data: srcData, info: srcInfo } = await sharp(imageBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcW = srcInfo.width;
  const srcH = srcInfo.height;
  const srcChannels = srcInfo.channels;

  if (srcChannels !== 3 && srcChannels !== 4) {
    throw new Error(`dewarpRailQuad: expected 3- or 4-channel source; got ${srcChannels}`);
  }

  const extendedQuad = extendQuadForMargins(quad, {
    marginAbove: marginAboveFraction,
    marginBelow: marginBelowFraction,
    marginHorizontal: marginHorizontalFraction,
  });

  const { outputWidth, outputHeight } = pickOutputSize(extendedQuad, targetWidth, srcW);

  const out = Buffer.allocUnsafe(outputWidth * outputHeight * 3);

  // Bilinear-sample source at fractional (sx, sy). Out-of-bounds → 0
  // (black). Reads R/G/B only, regardless of whether the source is 3-
  // or 4-channel (alpha ignored).
  //
  // Hot loop — keep allocation-free. `srcStride` captured from the
  // surrounding closure as a constant for the inner-loop indexing.
  const srcStride = srcW * srcChannels;
  const sampleSrc = (sx, sy, dstOff) => {
    if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
      out[dstOff] = 0;
      out[dstOff + 1] = 0;
      out[dstOff + 2] = 0;
      return;
    }
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const i00 = y0 * srcStride + x0 * srcChannels;
    const i01 = i00 + srcChannels; // (x0+1, y0)
    const i10 = i00 + srcStride; // (x0, y0+1)
    const i11 = i10 + srcChannels; // (x0+1, y0+1)
    const w00 = (1 - fx) * (1 - fy);
    const w01 = fx * (1 - fy);
    const w10 = (1 - fx) * fy;
    const w11 = fx * fy;
    out[dstOff] = srcData[i00] * w00 + srcData[i01] * w01 + srcData[i10] * w10 + srcData[i11] * w11;
    out[dstOff + 1] =
      srcData[i00 + 1] * w00 +
      srcData[i01 + 1] * w01 +
      srcData[i10 + 1] * w10 +
      srcData[i11 + 1] * w11;
    out[dstOff + 2] =
      srcData[i00 + 2] * w00 +
      srcData[i01 + 2] * w01 +
      srcData[i10 + 2] * w10 +
      srcData[i11 + 2] * w11;
  };

  // Precompute the four corner deltas so the inner loop is linear.
  // P(u,v) = (1-u)(1-v)·TL + u(1-v)·TR + (1-u)v·BL + uv·BR
  // We sweep v on the outer loop and u on the inner loop.
  const tl = extendedQuad.tl;
  const tr = extendedQuad.tr;
  const bl = extendedQuad.bl;
  const br = extendedQuad.br;

  for (let oy = 0; oy < outputHeight; oy++) {
    const v = oy / (outputHeight - 1);
    // Endpoints of the row in source coords: P(0, v) and P(1, v).
    const leftX = (1 - v) * tl.x + v * bl.x;
    const leftY = (1 - v) * tl.y + v * bl.y;
    const rightX = (1 - v) * tr.x + v * br.x;
    const rightY = (1 - v) * tr.y + v * br.y;
    const dx = rightX - leftX;
    const dy = rightY - leftY;
    const invW = 1 / (outputWidth - 1);
    let dstOff = oy * outputWidth * 3;
    for (let ox = 0; ox < outputWidth; ox++) {
      const u = ox * invW;
      sampleSrc(leftX + u * dx, leftY + u * dy, dstOff);
      dstOff += 3;
    }
  }

  // Re-encode as JPEG. Quality 92 matches the legacy cropToRailRegion
  // re-encode path so byte budgets stay similar.
  const buffer = await sharp(out, {
    raw: { width: outputWidth, height: outputHeight, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

  return {
    buffer,
    outputWidth,
    outputHeight,
    extendedQuad,
    ms: Date.now() - start,
  };
}
