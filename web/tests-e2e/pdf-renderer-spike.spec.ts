import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { htmlHead } from '../src/lib/pdf/template/css';

/**
 * WS9 Step 0 — renderer spike acceptance test (kept as a regression
 * gate for the client PDF renderer).
 *
 * Proves the chosen renderer (hidden-iframe + SVG foreignObject capture
 * + pdf-lib assembly, `src/lib/pdf/render/`) satisfies the Step 0
 * acceptance criteria from the WS9 plan:
 *   (a) returns a real PDF (Blob in-browser; bytes asserted here),
 *   (b) A4 portrait AND landscape pages merged into ONE document in
 *       iOS order (portrait first — HTMLPDFRenderer.swift:30-53),
 *   (c) page boxes exactly 595×842 / 842×595 pt (1 CSS px → 1 pt),
 *   (d) the fidelity-critical CSS the template depends on
 *       (writing-mode: vertical-lr circuit headers, flex layouts,
 *       badges) renders through the browser's real layout engine.
 *
 * Runs on chromium AND webkit — webkit shares the WebKit lineage with
 * the iOS WKWebView canon, so a webkit pass is the strongest available
 * automated fidelity signal short of the page-by-page reference diff.
 *
 * Captured page PNGs + the merged PDF are written to
 * `test-results/pdf-spike/` for eyeball comparison against the iOS
 * reference output.
 */

// Playwright runs specs with cwd = web/ (playwright.config.ts location).
const webRoot = process.cwd();
const outDir = path.join(webRoot, 'test-results', 'pdf-spike');

/** Static portrait page — a representative slice of certificate page 1
 * (red section bars, form tables, summary box) in the template's CSS. */
function spikePortraitHtml(): string {
  return (
    htmlHead() +
    `
<div class="page">
  <div style="display:flex;align-items:flex-start;margin-bottom:2pt;">
    <div style="flex:1;">
      <div style="font-size:13pt;font-weight:bold;line-height:1.1;">ELECTRICAL INSTALLATION CONDITION REPORT</div>
      <div style="font-size:6.5pt;color:#333;">Requirements for electrical installations (BS7671:2018+A3:2024 18th edition)</div>
      <div style="font-size:6.5pt;color:#333;">Certificate number: EICR-SPIKE001</div>
    </div>
  </div>
  <div class="red-bar">DETAILS OF CLIENT OR PERSON ORDERING REPORT</div>
  <table class="form-table">
    <tr><td class="label" style="width:55pt;">Client:</td><td class="value" colspan="3">Spike Test Client</td></tr>
    <tr><td class="label">Address:</td><td class="value" colspan="3">1 Test Fixture Lane, Reading, RG1 1AA</td></tr>
  </table>
  <div class="red-bar">SUMMARY OF THE CONDITION OF THE INSTALLATION</div>
  <div class="summary-box">
    <div class="summary-label">Overall assessment of the installation in<br/>terms of it's suitability for continued use*</div>
    <div class="summary-result">SATISFACTORY</div>
    <div class="summary-note">*An unsatisfactory assessment indicates that<br/>dangerous conditions have been identified.</div>
  </div>
  <div style="margin-top:4pt;">
    <span class="badge badge-c1">C1</span>
    <span class="badge badge-c2">C2</span>
    <span class="badge badge-c3">C3</span>
    <span class="badge badge-fi">FI</span>
    <span class="badge badge-tick">&#10003;</span>
    <span class="badge badge-lim">LIM</span>
  </div>
  <div class="footer"><span>Report produced by CertMate based on the model form from BS7671:2018+A3:2024 (18th Edition).</span><span>Page 1 of 2</span></div>
</div>
</body></html>`
  );
}

/** Static landscape page — circuit-schedule slice exercising the
 * vertical-lr rotated header cells and the fixed colgroup layout. */
function spikeLandscapeHtml(): string {
  return (
    htmlHead() +
    `
<div class="page-landscape">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4pt;">
    <div style="font-size:12pt;font-weight:bold;">Distribution Board - DB-1</div>
    <div style="font-size:7pt;font-weight:bold;">EICR-SPIKE001</div>
  </div>
  <div class="red-bar-small">DB-1 - Board Details</div>
  <table class="circuit-table" style="margin-top:3px;">
    <colgroup>
      <col style="width:22px"/><col style="width:63px"/><col style="width:24px"/><col style="width:25px"/>
      <col style="width:34px"/><col style="width:24px"/><col style="width:29px"/><col style="width:28px"/>
    </colgroup>
    <thead>
      <tr>
        <td class="group-header" colspan="2"></td>
        <td class="group-header" colspan="2">CONDUCTORS</td>
        <td class="group-header" colspan="2">OVERCURRENT DEVICES</td>
        <td class="group-header" colspan="2">TEST RESULTS</td>
      </tr>
      <tr>
        <th>Circuit<br/>reference</th>
        <th style="writing-mode:horizontal-tb;">Circuit designation</th>
        <th>Type of<br/>wiring</th>
        <th>Live<br/>(mm&#178;)</th>
        <th>BS(EN)</th>
        <th>Rating<br/>(A)</th>
        <th>R1+R2<br/>(ohm)</th>
        <th>Measured<br/>Zs (ohm)</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>1</td><td style="text-align:left;">Ring final circuit — kitchen sockets</td><td>A</td><td>2.5</td><td>BS EN 61009</td><td>32</td><td>0.42</td><td>0.58</td></tr>
      <tr><td>2</td><td style="text-align:left;">Lighting — ground floor</td><td>A</td><td>1.5</td><td>BS EN 60898</td><td>6</td><td>0.91</td><td>1.12</td></tr>
      <tr><td>3</td><td style="text-align:left;">Cooker</td><td>A</td><td>6.0</td><td>BS EN 61009</td><td>40</td><td>0.22</td><td>0.31</td></tr>
    </tbody>
  </table>
  <div class="footer"><span>Report produced by CertMate based on the model form from BS7671:2018+A3:2024 (18th Edition).</span><span>Page 2 of 2</span></div>
</div>
</body></html>`
  );
}

test('renderer spike: portrait+landscape merge into one A4 PDF Blob', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  // Bundle the real production renderer for standalone injection.
  const bundle = buildSync({
    entryPoints: [path.join(webRoot, 'src', 'lib', 'pdf', 'render', 'index.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'CertMatePdf',
    platform: 'browser',
  });

  await page.goto('about:blank');
  await page.setContent('<!DOCTYPE html><html><body></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const result = await page.evaluate(
    async ({ portrait, landscape }) => {
      type RenderApi = {
        renderCertificatePdf: (p: string, l: string | null) => Promise<Blob>;
        captureHtmlPages: (
          html: string,
          cls: 'page' | 'page-landscape',
          size: { width: number; height: number }
        ) => Promise<{ png: Uint8Array }[]>;
        A4_PORTRAIT: { width: number; height: number };
        A4_LANDSCAPE: { width: number; height: number };
      };
      const api = (window as unknown as { CertMatePdf: RenderApi }).CertMatePdf;

      const blob = await api.renderCertificatePdf(portrait, landscape);

      // Also expose the raw page rasters for eyeball inspection.
      const pagePngs = [
        ...(await api.captureHtmlPages(portrait, 'page', api.A4_PORTRAIT)),
        ...(await api.captureHtmlPages(landscape, 'page-landscape', api.A4_LANDSCAPE)),
      ];

      const toB64 = (bytes: Uint8Array) => {
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(s);
      };

      return {
        isBlob: blob instanceof Blob,
        type: blob.type,
        pdfB64: toB64(new Uint8Array(await blob.arrayBuffer())),
        pngB64: pagePngs.map((p) => toB64(p.png)),
      };
    },
    { portrait: spikePortraitHtml(), landscape: spikeLandscapeHtml() }
  );

  // (a) real Blob of type application/pdf
  expect(result.isBlob).toBe(true);
  expect(result.type).toBe('application/pdf');

  // (b)+(c) one document, portrait page then landscape page, exact A4 boxes
  const pdfBytes = Buffer.from(result.pdfB64, 'base64');
  const doc = await PDFDocument.load(pdfBytes);
  expect(doc.getPageCount()).toBe(2);
  const p0 = doc.getPage(0).getSize();
  const p1 = doc.getPage(1).getSize();
  expect(p0).toEqual({ width: 595, height: 842 });
  expect(p1).toEqual({ width: 842, height: 595 });

  // Persist artefacts for the visual fidelity check.
  const dir = path.join(outDir, testInfo.project.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spike.pdf'), pdfBytes);
  result.pngB64.forEach((b64, i) => {
    fs.writeFileSync(path.join(dir, `page-${i + 1}.png`), Buffer.from(b64, 'base64'));
  });
});
