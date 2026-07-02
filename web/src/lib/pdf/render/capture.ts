/**
 * Browser-side page capture for the client PDF renderer.
 *
 * Renders a full certificate HTML document (the TS port of iOS
 * `EICRHTMLTemplate.swift` output) inside a hidden same-origin iframe,
 * then rasterises each fixed-size `.page` / `.page-landscape` div to a
 * PNG via an SVG `<foreignObject>` snapshot drawn onto a canvas.
 *
 * Why foreignObject capture (Step 0 renderer spike decision, 2026-07-02):
 *   - The iOS canon renders REAL HTML/CSS through WKWebView with one PDF
 *     page per fixed-size div (`HTMLPDFRenderer.swift:56-124`). Keeping
 *     the web template as the same HTML/CSS (near-line-for-line port)
 *     is what makes the WS1 "iOS template change → web companion" rule
 *     cheap to honour, so the renderer must consume HTML.
 *   - Browsers expose no native HTML→PDF API that returns bytes, so the
 *     candidates were: html2canvas (+jsPDF), a vector re-authoring
 *     (@react-pdf/renderer / pdfmake), or a foreignObject snapshot.
 *   - html2canvas REIMPLEMENTS CSS layout and does not support
 *     `writing-mode: vertical-lr` — the circuit-schedule header row
 *     depends on it — so its captures break exactly where fidelity
 *     matters most.
 *   - @react-pdf/renderer / pdfmake give selectable vector text but
 *     cannot consume HTML: the 2131-line template would need a full
 *     re-authoring into a different layout system, destroying the 1:1
 *     iOS↔web template correspondence and making every future iOS
 *     template change a re-translation. Rejected on maintenance
 *     grounds (parent WS9 fixes "port the iOS HTML template").
 *   - foreignObject snapshots use the browser's OWN layout engine — the
 *     same WebKit lineage as the iOS WKWebView render on Safari — so
 *     CSS fidelity (flex headers, vertical-lr table headers, badges,
 *     exact pt sizing) is inherited rather than re-implemented, with
 *     zero added dependency for the capture step.
 *   - Trade-off, stated honestly: output pages are rasters, so PDF text
 *     is not selectable (the iOS vector output is). Captures run at
 *     `pixelRatio` 3 (≈267 dpi effective) so text stays crisp in print
 *     and zoom; the plan treats vector text as strongly-preferred, not
 *     required, and the alternative renderers fail harder requirements
 *     (layout fidelity / HTML input / stable page breaks).
 *
 * The template emits fully self-contained documents (inline CSS, data:
 * URI images only, system fonts), which is precisely the constraint set
 * under which SVG-as-image rasterisation is lossless: no external
 * resource fetches happen inside the SVG.
 */

export interface PageCapture {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}

/** A4 CSS-pixel page boxes — must match the template's `.page` /
 * `.page-landscape` fixed sizes AND the iOS PDF page rects
 * (`HTMLPDFRenderer.swift:26-27`, 1 CSS px == 1 PDF pt here). */
export const A4_PORTRAIT = { width: 595, height: 842 } as const;
export const A4_LANDSCAPE = { width: 842, height: 595 } as const;

/** Default capture scale. 3× ≈ 267 dpi effective on an A4 page — crisp
 * for print without breaching iOS Safari's canvas-area ceiling
 * (2526×1785 ≈ 4.5MP per page, well under the ~16.7MP limit). */
export const DEFAULT_PIXEL_RATIO = 3;

/**
 * Load a full HTML document into a hidden iframe and resolve once the
 * document, its data-URI images, and fonts have settled. The iframe must
 * NOT be `display:none` (that suppresses layout entirely); it is parked
 * off-viewport instead, mirroring how WKWebView renders off-screen.
 */
async function loadDocument(
  html: string,
  width: number,
  height: number
): Promise<HTMLIFrameElement> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.left = '-12000px';
  iframe.style.top = '0';
  iframe.style.width = `${width}px`;
  iframe.style.height = `${height}px`;
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('PDF render: document load timed out')),
      30_000
    );
    iframe.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    iframe.srcdoc = html;
  });

  const doc = iframe.contentDocument;
  if (!doc) throw new Error('PDF render: iframe document unavailable');

  // Wait for data-URI images to decode and fonts to settle — the same
  // job as the 800ms layout-settle sleep in HTMLPDFRenderer.swift:77,
  // but event-driven instead of a fixed delay.
  const images = Array.from(doc.images);
  await Promise.all(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((r) => {
            img.onload = () => r();
            img.onerror = () => r();
          })
    )
  );
  try {
    await doc.fonts?.ready;
  } catch {
    // Font readiness is best-effort; system fonts render regardless.
  }
  return iframe;
}

/** Serialise one page div (plus the document's stylesheet) into a
 * self-contained SVG foreignObject document. XMLSerializer guarantees
 * well-formed XHTML regardless of how the source HTML was authored.
 *
 * The wrapper carries the source document BODY's computed typography as
 * inline style: the template scopes its base font on `body { … }`, and
 * inside the foreignObject the content root is a <div>, so a bare copy
 * of the stylesheet would silently drop the body rule and every page
 * would rasterise in the engine's default serif face (caught in the
 * WS9 acceptance diff vs the iOS reference). */
function pageToSvg(pageEl: Element, css: string, width: number, height: number): string {
  const clone = pageEl.cloneNode(true) as HTMLElement;
  // Page-by-page isolation: the template relies on one div per PDF page;
  // the clone is the only content in this SVG so display stays block.
  clone.style.display = 'block';
  const serialized = new XMLSerializer().serializeToString(clone);

  const body = pageEl.ownerDocument?.body;
  const view = pageEl.ownerDocument?.defaultView;
  let bodyStyle = '';
  if (body && view) {
    const computed = view.getComputedStyle(body);
    bodyStyle =
      `font-family:${computed.fontFamily};` +
      `font-size:${computed.fontSize};` +
      `font-weight:${computed.fontWeight};` +
      `line-height:${computed.lineHeight};` +
      `color:${computed.color};`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="${bodyStyle}">` +
    `<style>${css}</style>` +
    serialized +
    `</div>` +
    `</foreignObject>` +
    `</svg>`
  );
}

async function svgToPng(
  svg: string,
  width: number,
  height: number,
  pixelRatio: number
): Promise<Uint8Array> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('PDF render: SVG rasterisation failed'));
    img.src = url;
  });
  // Safari can resolve the load event before nested data-URI images
  // inside the foreignObject have painted. Decode + a frame + a short
  // settle keeps the draw deterministic across engines (the html-to-image
  // family carries the same workaround).
  try {
    await img.decode();
  } catch {
    // decode() may reject for SVG on some engines even when drawable.
  }
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PDF render: canvas 2d context unavailable');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PDF render: PNG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Capture every `pageClass` div in `html` as a PNG raster, in document
 * order. Direct equivalent of `HTMLPDFRenderer.renderPageByPage` — the
 * iOS version hides all-but-one div and calls `createPDF()` per page;
 * here each div is snapshotted independently so no show/hide pass is
 * needed.
 */
export async function captureHtmlPages(
  html: string,
  pageClass: 'page' | 'page-landscape',
  size: { width: number; height: number },
  pixelRatio: number = DEFAULT_PIXEL_RATIO
): Promise<PageCapture[]> {
  const iframe = await loadDocument(html, size.width, size.height);
  try {
    const doc = iframe.contentDocument!;
    const pages = Array.from(doc.querySelectorAll(`.${pageClass}`));
    if (pages.length === 0) {
      throw new Error(`PDF render: no .${pageClass} pages found`);
    }
    const css = Array.from(doc.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');

    const captures: PageCapture[] = [];
    for (const pageEl of pages) {
      const svg = pageToSvg(pageEl, css, size.width, size.height);
      const png = await svgToPng(svg, size.width, size.height, pixelRatio);
      captures.push({ png, widthPx: size.width, heightPx: size.height });
    }
    return captures;
  } finally {
    iframe.remove();
  }
}
