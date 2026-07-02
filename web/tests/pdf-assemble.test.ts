/**
 * WS9 — PDF assembly geometry regression (Node-side twin of the Step 0
 * spike's browser assertions).
 *
 * assemblePdf is deliberately isomorphic so this suite can pin the page
 * geometry contract without a browser: one PDF page per captured
 * raster, portrait 595×842pt / landscape 842×595pt (the iOS
 * HTMLPDFRenderer page rects), in caller order (portrait first —
 * HTMLPDFRenderer.render appends landscape after portrait).
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { assemblePdf } from '@/lib/pdf/render/assemble';

// Smallest valid PNG (1×1 transparent pixel).
const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);

describe('WS9 · assemblePdf', () => {
  it('produces one A4 page per capture, portrait then landscape, exact point sizes', async () => {
    const bytes = await assemblePdf([
      { png: PNG_1PX, widthPt: 595, heightPt: 842 },
      { png: PNG_1PX, widthPt: 595, heightPt: 842 },
      { png: PNG_1PX, widthPt: 842, heightPt: 595 },
    ]);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 595, height: 842 });
    expect(doc.getPage(2).getSize()).toEqual({ width: 842, height: 595 });
  });

  it('rejects an empty capture set instead of emitting a 0-page document', async () => {
    await expect(assemblePdf([])).rejects.toThrow('no pages captured');
  });
});
