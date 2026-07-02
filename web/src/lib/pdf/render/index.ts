import { A4_LANDSCAPE, A4_PORTRAIT, captureHtmlPages, DEFAULT_PIXEL_RATIO } from './capture';
import { assemblePdf } from './assemble';

export { assemblePdf } from './assemble';
export type { CapturedPage } from './assemble';
export { captureHtmlPages, A4_PORTRAIT, A4_LANDSCAPE, DEFAULT_PIXEL_RATIO } from './capture';
export type { PageCapture } from './capture';

/**
 * Render a certificate to a PDF Blob in the browser. Mirrors
 * `HTMLPDFRenderer.render(portraitHTML:landscapeHTML:)` exactly:
 * portrait `.page` divs first (A4 portrait pages), then landscape
 * `.page-landscape` divs (A4 landscape pages), merged into one document.
 *
 * Callers should dynamic-import this module so pdf-lib and the capture
 * machinery stay out of the main PWA bundle until Generate is tapped.
 */
export async function renderCertificatePdf(
  portraitHTML: string,
  landscapeHTML: string | null,
  pixelRatio: number = DEFAULT_PIXEL_RATIO
): Promise<Blob> {
  const portraitPages = await captureHtmlPages(portraitHTML, 'page', A4_PORTRAIT, pixelRatio);
  const landscapePages =
    landscapeHTML && landscapeHTML.length > 0
      ? await captureHtmlPages(landscapeHTML, 'page-landscape', A4_LANDSCAPE, pixelRatio)
      : [];

  const bytes = await assemblePdf(
    [...portraitPages, ...landscapePages].map((p) => ({
      png: p.png,
      widthPt: p.widthPx,
      heightPt: p.heightPx,
    }))
  );
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}
