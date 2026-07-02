import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCertificateHtml } from '../src/lib/pdf/template/eicr-html-template';
import { decodePdfJob } from '../src/lib/pdf/template/decode';
import { normalizePdfJob } from '../src/lib/pdf/generate-certificate';
import type { JobDetail } from '../src/lib/types';

/**
 * WS9 acceptance-diff renderer — renders the seeded parity fixture jobs
 * through the REAL web pipeline (wire decode → PDFGenerator
 * normalization → template port → foreignObject capture → pdf-lib) and
 * writes the resulting PDFs next to the iOS reference PDFs for the
 * page-by-page fidelity diff.
 *
 * Gated behind WS9_FIXTURE_DIR because the fixture JSONs + iOS
 * reference PDFs live OUTSIDE the repo (the WS9 handoff folder — job
 * data is read-only and reference PDFs are session artefacts). Re-run
 * for the field-validation follow-up with:
 *
 *   WS9_FIXTURE_DIR=~/.claude/handoffs/EICR_Automation--parity-ws9-pdf-parity-2026-07-02/ios-reference \
 *     npx playwright test tests-e2e/ws9-acceptance-render.spec.ts --project=webkit
 *
 * The company/inspector inputs are undefined — matching the iOS
 * reference renders exactly (the parity account has no company settings
 * and both fixture jobs carry nil staff ids, so iOS's PDFGenerator
 * passed nil for all of them too).
 */

const fixtureDir = process.env.WS9_FIXTURE_DIR;

const CASES = [
  { fixture: 'eicr-job.json', out: 'web-eicr.pdf', reference: 'ios-reference-eicr.pdf' },
  { fixture: 'eic-job.json', out: 'web-eic.pdf', reference: 'ios-reference-eic.pdf' },
] as const;

test.describe('WS9 acceptance render (fixture-gated)', () => {
  test.skip(!fixtureDir, 'WS9_FIXTURE_DIR not set — acceptance render is a manual fidelity step');

  for (const c of CASES) {
    test(`renders ${c.fixture} through the web pipeline and matches the iOS page geometry`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const dir = fixtureDir!.replace(/^~/, process.env.HOME ?? '~');

      const detail = JSON.parse(
        fs.readFileSync(path.join(dir, c.fixture), 'utf8')
      ) as unknown as JobDetail;
      const job = normalizePdfJob(decodePdfJob(detail));
      const { portrait, landscape } = buildCertificateHtml(job, undefined, undefined);

      const bundle = buildSync({
        entryPoints: [path.join(process.cwd(), 'src', 'lib', 'pdf', 'render', 'index.ts')],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'CertMatePdf',
        platform: 'browser',
      });

      await page.goto('about:blank');
      await page.setContent('<!DOCTYPE html><html><body></body></html>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });

      const pdfB64 = await page.evaluate(
        async ({ portraitHtml, landscapeHtml }) => {
          const api = (
            window as unknown as {
              CertMatePdf: {
                renderCertificatePdf: (p: string, l: string | null) => Promise<Blob>;
              };
            }
          ).CertMatePdf;
          const blob = await api.renderCertificatePdf(portraitHtml, landscapeHtml);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          return btoa(s);
        },
        { portraitHtml: portrait, landscapeHtml: landscape }
      );

      const webBytes = Buffer.from(pdfB64, 'base64');
      fs.writeFileSync(path.join(dir, c.out), webBytes);

      // Geometry gate: same page count and same per-page boxes as the
      // iOS reference. The pixel-level look is the manual page-by-page
      // diff recorded in web/audit/ws9-pdf-fidelity-2026-07/.
      const webDoc = await PDFDocument.load(webBytes);
      const iosDoc = await PDFDocument.load(fs.readFileSync(path.join(dir, c.reference)));
      expect(webDoc.getPageCount()).toBe(iosDoc.getPageCount());
      for (let i = 0; i < webDoc.getPageCount(); i++) {
        const w = webDoc.getPage(i).getSize();
        const ios = iosDoc.getPage(i).getSize();
        expect(Math.round(w.width)).toBe(Math.round(ios.width));
        expect(Math.round(w.height)).toBe(Math.round(ios.height));
      }
    });
  }
});
