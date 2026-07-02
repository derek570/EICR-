#!/usr/bin/env node
/**
 * WS0 visual-baseline capture (2026-07) — UNAUTHENTICATED STATES ONLY.
 *
 * No dev-account credentials are available to an autonomous session, so
 * this captures the accessible pre-auth surfaces (login; terms redirects
 * to login when unauthenticated) at the two required viewports. Every
 * seeded/authenticated screen is listed BLOCKED in MANIFEST.md.
 *
 * Run:  node tests-e2e/visual-baseline-capture.mjs
 * Precondition: dev server on http://localhost:3001
 * (PORT=3001 npx next dev --turbopack)
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../audit/visual-baseline-2026-07/web/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { name: 'login', path: '/login' },
];

const VIEWPORTS = [
  { tag: 'iphone', device: devices['iPhone 14'] },
  { tag: 'desktop', device: { viewport: { width: 1440, height: 900 } } },
];

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ ...vp.device, colorScheme: 'dark' });
  const page = await ctx.newPage();
  for (const t of TARGETS) {
    await page.goto(`http://localhost:3001${t.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(750); // let entrance animations settle
    const file = `${OUT}${t.name}-${vp.tag}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log('captured', file);
  }
  await ctx.close();
}
await browser.close();
