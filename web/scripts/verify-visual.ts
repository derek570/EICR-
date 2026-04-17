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

/**
 * A JWT that never expires (exp: 2099-01-01) so the middleware's atob() decode
 * accepts it. Signature is ignored — middleware only checks shape + exp.
 * Payload: { "sub": "demo", "email": "demo@certmate.uk", "exp": 4070908800 }
 */
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJkZW1vIiwiZW1haWwiOiJkZW1vQGNlcnRtYXRlLnVrIiwiZXhwIjo0MDcwOTA4ODAwfQ.' +
  'sig';

const FAKE_USER = JSON.stringify({
  id: 'demo-user',
  email: 'demo@certmate.uk',
  name: 'Demo Inspector',
});

async function seedAuth(page: Page, baseUrl: string) {
  // Land on a same-origin page first so we can poke localStorage.
  await page.goto(baseUrl + '/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ token, user }) => {
      localStorage.setItem('cm_token', token);
      localStorage.setItem('cm_user', user);
      document.cookie = `token=${token}; path=/; max-age=86400; SameSite=Lax`;
    },
    { token: FAKE_JWT, user: FAKE_USER }
  );
}

const PHASE_1_ROUTES: Route[] = [
  { path: '/login', name: 'phase-1-login' },
  {
    path: '/dashboard',
    name: 'phase-1-dashboard',
    // Intercepts are set after seedAuth in captureRoute, so that fetches
    // triggered by the dashboard's useEffect resolve against our mocks
    // instead of the (non-running) localhost:3000 backend.
    prepare: async (page) => {
      await page.route('**/api/jobs/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      );
      await page.route('**/api/auth/me*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'demo-user',
            email: 'demo@certmate.uk',
            name: 'Demo Inspector',
          }),
        })
      );
    },
  },
];

/**
 * Phase 2 — all 10 job-detail tabs for both EICR and EIC certificate types.
 * We mock a pair of job detail responses so we can capture tab content
 * without needing the backend to be reachable.
 */
const MOCK_EICR_JOB = {
  id: 'demo-eicr',
  address: '42 Bonham Road, Bristol BS2 8HX',
  status: 'pending',
  created_at: '2026-03-12T09:00:00.000Z',
  updated_at: '2026-03-14T12:00:00.000Z',
  certificate_type: 'EICR',
  installation: {},
  supply: {},
  board: {},
  circuits: [],
  observations: [],
  inspection: {},
  inspector: {},
};

const MOCK_EIC_JOB = {
  id: 'demo-eic',
  address: '7 Ashwood Close, Bath BA1 4QD',
  status: 'processing',
  created_at: '2026-04-02T10:30:00.000Z',
  certificate_type: 'EIC',
  installation: {},
  extent: {},
  supply: {},
  board: {},
  circuits: [],
  inspection: {},
  design: {},
  inspector: {},
};

function jobRoutes(): Route[] {
  const mockJobPrep: Route['prepare'] = async (page) => {
    await page.route('**/api/job/**', (route) => {
      const url = route.request().url();
      // URL shape: .../api/job/<userId>/<jobId>. Match on the final segment
      // so `demo-eic` doesn't also pick up `demo-eicr`.
      const jobId =
        url
          .replace(/[?#].*$/, '')
          .split('/')
          .pop() ?? '';
      const job = jobId === 'demo-eic' ? MOCK_EIC_JOB : MOCK_EICR_JOB;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(job),
      });
    });
    await page.route('**/api/auth/me*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'demo-user',
          email: 'demo@certmate.uk',
          name: 'Demo Inspector',
        }),
      })
    );
  };

  const tabs = [
    { slug: '', name: 'overview' },
    { slug: '/installation', name: 'installation' },
    { slug: '/extent', name: 'extent' }, // EIC only but renders either way
    { slug: '/supply', name: 'supply' },
    { slug: '/board', name: 'board' },
    { slug: '/circuits', name: 'circuits' },
    { slug: '/observations', name: 'observations' },
    { slug: '/inspection', name: 'inspection' },
    { slug: '/design', name: 'design' },
    { slug: '/inspector', name: 'inspector' },
    { slug: '/pdf', name: 'pdf' },
  ];

  const out: Route[] = [];
  for (const cert of [
    { id: 'demo-eicr', label: 'eicr' },
    { id: 'demo-eic', label: 'eic' },
  ]) {
    for (const t of tabs) {
      // Skip Observations for EIC, skip Design/Extent for EICR — iOS hides
      // them in the tab bar so there's no useful screen to compare.
      if (cert.label === 'eic' && t.name === 'observations') continue;
      if (cert.label === 'eicr' && (t.name === 'design' || t.name === 'extent')) continue;
      out.push({
        path: `/job/${cert.id}${t.slug}`,
        name: `phase-2-${cert.label}-${t.name}`,
        prepare: mockJobPrep,
      });
    }
  }
  return out;
}

const PHASES: Record<string, Route[]> = {
  '0': PHASE_0_ROUTES,
  '1': PHASE_1_ROUTES,
  '2': jobRoutes(),
};

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
  viewport: Viewport,
  requiresAuth: boolean
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
    // Register mocks BEFORE any navigation — page.route handlers persist
    // across in-page navigations but must exist before the first request.
    if (route.prepare) await route.prepare(page);
    if (requiresAuth) await seedAuth(page, baseUrl);
    await page.goto(baseUrl + route.path, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    // Wait for any skeleton shimmer or counter animations to resolve before
    // snapshotting. Use a generous settle so the animated counter lands on
    // its final value.
    await page.waitForTimeout(1200);
    const file = join(outDir, `${route.name}.${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  ✓ ${route.name} [${viewport.name}] -> ${file}`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  const phase = process.env.PHASE ?? '1';
  const routes = PHASES[phase];
  if (!routes) {
    throw new Error(`Unknown PHASE=${phase}. Known: ${Object.keys(PHASES).join(', ')}`);
  }
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
      const requiresAuth = route.path === '/dashboard' || route.path.startsWith('/job');
      for (const viewport of VIEWPORTS) {
        await captureRoute(browser, baseUrl, route, outDir, viewport, requiresAuth);
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
