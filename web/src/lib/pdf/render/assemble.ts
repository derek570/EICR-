import { PDFDocument } from 'pdf-lib';

/**
 * One captured certificate page: a PNG raster plus the PDF page box it
 * should occupy, in PDF points. Mirrors the iOS pipeline where
 * `HTMLPDFRenderer` produces one PDF page per `.page` / `.page-landscape`
 * div at A4 portrait (595×842) or landscape (842×595) point sizes
 * (`HTMLPDFRenderer.swift:26-27`).
 */
export interface CapturedPage {
  png: Uint8Array;
  widthPt: number;
  heightPt: number;
}

/**
 * Assemble captured page rasters into a single PDF, one page per raster,
 * each image drawn full-bleed at the page's point size. This is the web
 * equivalent of `HTMLPDFRenderer.mergePDFArray` — portrait pages first,
 * landscape appended after, exactly the order the caller passes.
 *
 * Kept isomorphic (no DOM access) so vitest can assert page count and
 * A4 dimensions in Node without a browser.
 */
export async function assemblePdf(pages: CapturedPage[]): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new Error('assemblePdf: no pages captured');
  }
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const pdfPage = doc.addPage([page.widthPt, page.heightPt]);
    const png = await doc.embedPng(page.png);
    pdfPage.drawImage(png, {
      x: 0,
      y: 0,
      width: page.widthPt,
      height: page.heightPt,
    });
  }
  return doc.save();
}
