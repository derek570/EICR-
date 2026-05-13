/**
 * Client-side image resize used by the observation-photo capture
 * flow (L2 sprint 2026-05-13).
 *
 * Why this exists: a full-resolution iPad camera capture is ~12 MB
 * (4032 × 3024 HEIC / JPEG) and stalls on cellular. The backend
 * accepts HEIC and resizes server-side, but we still want to upload
 * the smaller version so:
 *   - Upload finishes within the auto-link window (60 s) on a slow
 *     site connection.
 *   - The bytes sitting in the IDB pending-photo store are bounded.
 *   - EXIF + GPS are stripped before the bytes leave the device
 *     (PLAN §0.3 — canvas redraw drops EXIF for free).
 *
 * iOS canon: `ImageScaler.scale` at `ImageScaler.swift:65-93` — max
 * dimension 2048 px, JPEG quality 0.80, EXIF + GPS stripped via
 * `jpegDataStrippingMetadata`. We match those defaults exactly so
 * the wire bytes a PWA inspector uploads are indistinguishable from
 * what the iOS app uploads for the same shot.
 *
 * Implementation:
 *   - `createImageBitmap` decodes the source blob — works on any
 *     `<img>`-compatible MIME (jpeg, png, webp, heic on iOS 17+).
 *   - Aspect-ratio-preserving scale to a max long-edge of `maxWidth`.
 *     Photos already smaller than the cap are NOT upscaled — they go
 *     through the canvas redraw anyway so EXIF is still dropped.
 *   - `OffscreenCanvas` when available (avoids touching the DOM in
 *     the recording-time hot path); falls back to a detached
 *     `<canvas>` element on browsers without OffscreenCanvas.
 *   - Output is always `image/jpeg` regardless of input — keeps the
 *     server-side path simple and matches iOS.
 */

interface CanvasLike {
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Blob>;
}

function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

function isImageBitmap(value: unknown): value is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;
}

/**
 * Resize an image blob to a maximum long-edge of `maxWidth` and
 * re-encode as JPEG at `quality`. EXIF + GPS are dropped via the
 * canvas redraw step (the canvas has no metadata to write back).
 *
 * Throws if the input cannot be decoded as an image (e.g. corrupt
 * bytes, non-image MIME). Callers in the capture flow should treat
 * a thrown error as "user picked a non-image file" and surface a
 * toast.
 *
 * @param blob       source image bytes (any browser-decodable image)
 * @param maxWidth   long-edge cap in pixels — defaults to iOS 2048
 * @param quality    JPEG quality 0-1 — defaults to iOS 0.80
 */
export async function resizeImage(blob: Blob, maxWidth = 2048, quality = 0.8): Promise<Blob> {
  // Decode source. createImageBitmap returns a transferable bitmap
  // that's cheap to draw. Throws TypeError on undecodable input —
  // we let the caller catch and surface as an error toast.
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
    const targetW = Math.max(1, Math.round(bitmap.width * ratio));
    const targetH = Math.max(1, Math.round(bitmap.height * ratio));

    if (hasOffscreenCanvas()) {
      const canvas = new OffscreenCanvas(targetW, targetH) as OffscreenCanvas & CanvasLike;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('resizeImage: no 2d context on OffscreenCanvas');
      ctx.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);
      if (typeof canvas.convertToBlob === 'function') {
        return await canvas.convertToBlob({ type: 'image/jpeg', quality });
      }
    }

    // Fallback path — detached <canvas>. Used by jsdom under tests
    // and by older browsers without OffscreenCanvas.
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('resizeImage: no 2d context on canvas');
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (!result) {
            reject(new Error('resizeImage: canvas.toBlob returned null'));
            return;
          }
          resolve(result);
        },
        'image/jpeg',
        quality
      );
    });
  } finally {
    // Free the bitmap memory — important on iPad where capture
    // sessions can produce many in quick succession.
    if (isImageBitmap(bitmap) && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}
