/**
 * Visual verification harness.
 *
 * Spins up `next dev` on a free port, screenshots every configured route at
 * iPhone 14 Pro viewport + desktop viewport, writes PNGs to
 * `_screenshots/<timestamp>/...`. Designed to be run per phase so we can
 * visually diff against iOS reference shots stored in
 * `_reference/ios-screenshots/`.
 *
 * Usage: npm run verify [-- --keep-server]
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

type Viewport = { name: string; width: number; height: number; isMobile: boolean };

const VIEWPORTS: Viewport[] = [
  { name: 'mobile', width: 390, height: 844, isMobile: true }, // iPhone 14 Pro
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
];

type Route = {
  /** URL path, e.g. `/` */
  path: string;
  /** Filename stem for the PNG */
  name: string;
  /** Optional Playwright action before screenshot (hover, scroll, etc.) */
  prepare?: (page: Page) => Promise<void>;
};

const PHASE_0_ROUTES: Route[] = [{ path: '/', name: 'phase-0-showcase' }];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error('failed to bind'));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function captureRoute(
  browser: Browser,
  baseUrl: string,
  route: Route,
  outDir: string,
  viewport: Viewport
) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  try {
    await page.goto(baseUrl + route.path, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    // Give any CSS animations / fonts a beat to settle before the shot.
    await page.waitForTimeout(400);
    if (route.prepare) await route.prepare(page);
    const file = join(outDir, `${route.name}.${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  ✓ ${route.name} [${viewport.name}] -> ${file}`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  const phase = process.env.PHASE ?? '0';
  const routes = PHASE_0_ROUTES; // extend per-phase in a future patch
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), '_screenshots', `phase-${phase}-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  console.log(`Starting next dev on ${baseUrl}`);
  const dev: ChildProcess = spawn('npx', ['next', 'dev', '--turbopack', '-p', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  dev.stdout?.on('data', (d) => process.stdout.write(`[next] ${d}`));
  dev.stderr?.on('data', (d) => process.stderr.write(`[next] ${d}`));

  let browser: Browser | null = null;
  try {
    await waitForHttp(baseUrl);
    console.log('Dev server up — launching Chromium');

    browser = await chromium.launch();
    for (const route of routes) {
      for (const viewport of VIEWPORTS) {
        await captureRoute(browser, baseUrl, route, outDir, viewport);
      }
    }
    console.log(`\nScreenshots written to ${outDir}`);
  } finally {
    if (browser) await browser.close();
    dev.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
