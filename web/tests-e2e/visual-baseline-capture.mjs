#!/usr/bin/env node
/**
 * WS0 visual-baseline capture (2026-07) — full authenticated sweep.
 *
 * Logs in with the parity test account (credentials read at runtime from
 * ~/.certmate-test-creds — key=value lines: email/password/user_id/
 * job_eicr/job_eic; NEVER hardcoded here, NEVER committed) and captures
 * the 14 MANIFEST screens across the two seeded jobs at both required
 * viewports. READ-ONLY by design: the only clicks performed are the CCU
 * button (opens the mode sheet — no picker, no upload) and the mic FAB
 * (opens the live recording overlay; the context is closed immediately
 * after the shot, no dictation, no Apply/End click). No job field is
 * ever edited and no save/generate/delete control is touched.
 *
 * Run:  node tests-e2e/visual-baseline-capture.mjs
 * Env:  BASE_URL   capture origin (default https://certmate.uk — production,
 *                  read-only usage against the seeded parity-test jobs)
 *       CREDS_FILE creds path (default ~/.certmate-test-creds)
 *       SKIP_RECORDING=1 to skip the live-session screen
 */
import { chromium, devices } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'https://certmate.uk';
const CREDS_FILE = process.env.CREDS_FILE ?? join(homedir(), '.certmate-test-creds');
const OUT = new URL('../audit/visual-baseline-2026-07/web/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// -- creds ------------------------------------------------------------------
const creds = Object.fromEntries(
  readFileSync(CREDS_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
for (const k of ['email', 'password', 'job_eicr', 'job_eic']) {
  if (!creds[k]) throw new Error(`missing '${k}' in ${CREDS_FILE}`);
}
const JOB = { eicr: creds.job_eicr, eic: creds.job_eic };

// Auth storage state lives OUTSIDE the repo (contains the JWT).
const STATE_FILE = join(tmpdir(), 'cm-visual-baseline-state.json');

/**
 * Programmatic login → Playwright storage state.
 *
 * We do NOT drive the login form: the parity test account has
 * `company_id: null` and `LoginResponseSchema` (strict parse) declares
 * `company_id: z.string().optional()` — not `.nullable()` — so the UI
 * login fails with "Response shape invalid" for any user not bound to a
 * company. Bug logged in MANIFEST.md / INDEX-2026-07 (web/src is owned
 * by WS2 this cycle, so no fix here). Instead we call the API directly
 * and store exactly what `setAuth()` (web/src/lib/auth.ts) would:
 * localStorage cm_token + cm_user, plus the `token` cookie the Next.js
 * middleware gates on.
 */
async function buildStorageState() {
  const apiBase = BASE === 'https://certmate.uk' ? 'https://api.certmate.uk' : BASE;
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const { token, user } = await res.json();
  if (!token || !user) throw new Error('login response missing token/user');
  const host = new URL(BASE).hostname;
  return {
    cookies: [
      {
        name: 'token',
        value: token,
        domain: host,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        httpOnly: false,
        secure: BASE.startsWith('https'),
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: BASE,
        localStorage: [
          { name: 'cm_token', value: token },
          { name: 'cm_user', value: JSON.stringify(user) },
          // T&Cs gate is DEVICE-LOCAL only (web/src/app/terms/
          // legal-texts-gate.ts — localStorage, no backend call), so
          // pre-seeding acceptance here mutates nothing server-side.
          // Without it every authenticated screen renders the gate.
          { name: 'termsAccepted', value: 'true' },
          { name: 'termsAcceptedVersion', value: '1.0' },
          { name: 'termsAcceptedDate', value: new Date().toISOString() },
          // Job-detail guided tour (8-step coach marks) — also device-
          // local (use-tour.ts `cm-tour-job`). Seed it seen+disabled so
          // job-tab captures aren't obscured by the overlay.
          { name: 'cm-tour-job', value: JSON.stringify({ seen: true, disabled: true }) },
        ],
      },
    ],
  };
}

// -- viewports --------------------------------------------------------------
// deviceScaleFactor forced to 1 per MANIFEST compression guidance (device
// resolution, not @3x) — keeps the 40+ file folder well under the 25 MB cap.
const VIEWPORTS = [
  { tag: 'iphone', device: { ...devices['iPhone 14'], deviceScaleFactor: 1 } },
  { tag: 'desktop', device: { viewport: { width: 1440, height: 900 } } },
];

// Job tabs per cert type. EICR has Observations; EIC has Extent + Design —
// mirrors the iOS tab gating verified in WS0 item 1.
const TABS = {
  eicr: ['', 'installation', 'supply', 'board', 'circuits', 'observations', 'inspection', 'staff', 'pdf'],
  eic: ['', 'installation', 'supply', 'board', 'circuits', 'extent', 'design', 'inspection', 'staff', 'pdf'],
};

// -- helpers ----------------------------------------------------------------
/** goto that tolerates never-idle pages (SW / websockets) then settles. */
async function visit(page, path, settle = 1200) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 20_000 });
  } catch {
    /* networkidle timeout — page is loaded enough; fall through to settle */
  }
  await page.waitForTimeout(settle);
}

/**
 * The DASHBOARD tour persists in IndexedDB (`certmate-cache` →
 * `app-settings`, key `tour-state` — see web/src/lib/tour/state.ts), which
 * Playwright storageState can't seed. Visit a non-dashboard authed page
 * first (AppShell opens the DB at the current version), then write the
 * seen+disabled row so the dashboard capture isn't obscured by coach
 * marks. Device-local only — nothing server-side.
 */
async function disableDashboardTour(page) {
  await visit(page, '/settings', 500);
  const result = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('certmate-cache');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains('app-settings')) {
      db.close();
      return 'no-store';
    }
    await new Promise((res, rej) => {
      const tx = db.transaction('app-settings', 'readwrite');
      tx.objectStore('app-settings').put({
        key: 'tour-state',
        value: { seen: true, disabled: true },
      });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return 'ok';
  });
  if (result !== 'ok') console.warn('dashboard tour seed:', result);
}

async function shot(page, name, tag, opts = {}) {
  const file = `${OUT}${name}-${tag}.png`;
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? true, ...opts.shotOpts });
  console.log('captured', file);
}

// -- launch (fake mic so the recording overlay can start headlessly) --------
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

// -- 1. unauthenticated login screen + one real UI login for storage state --
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ ...vp.device, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await visit(page, '/login', 750);
  await shot(page, 'login', vp.tag);
  await ctx.close();
}

writeFileSync(STATE_FILE, JSON.stringify(await buildStorageState()));
console.log('logged in (API) as', creds.email);

// -- 2. authenticated sweep at both viewports --------------------------------
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    ...vp.device,
    colorScheme: 'dark',
    storageState: STATE_FILE,
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();

  await disableDashboardTour(page);

  await visit(page, '/dashboard');
  await shot(page, 'dashboard', vp.tag);

  for (const [certType, tabs] of Object.entries(TABS)) {
    for (const tab of tabs) {
      await visit(page, `/job/${JOB[certType]}${tab ? `/${tab}` : ''}`);
      await shot(page, `job-${tab || 'overview'}-${certType}`, vp.tag);
    }
  }

  await visit(page, '/settings');
  await shot(page, 'settings', vp.tag);

  // CCU mode sheet — CCU button opens the picker sheet; nothing mutates
  // until a photo is chosen, which we never do.
  await visit(page, `/job/${JOB.eicr}/circuits`);
  // JS-dispatch the click: a normal Playwright click scrolls/pans the
  // mobile visual viewport to the off-screen rail button, and the
  // viewport-fixed dialog then renders offset in the screenshot.
  await page
    .getByRole('button', { name: 'CCU', exact: true })
    .first()
    .evaluate((el) => el.click());
  await page.getByRole('dialog').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot(page, 'ccu-mode-sheet-eicr', vp.tag, { fullPage: false });
  await page.keyboard.press('Escape');

  // Observation card — element shot of the first populated card.
  await visit(page, `/job/${JOB.eicr}/observations`);
  const card = page.locator('[class*="cm-"], article, li, div').filter({ hasText: /C[123]|FI/ }).first();
  try {
    const file = `${OUT}observation-card-eicr-${vp.tag}.png`;
    await card.screenshot({ path: file, timeout: 10_000 });
    console.log('captured', file);
  } catch {
    console.warn('observation card element shot failed — full page fallback');
    await shot(page, 'observation-card-eicr', vp.tag);
  }

  await ctx.close();
}

// -- 3. recording overlay (live session) — separate short-lived contexts ----
// start() POSTs /api/recording/start (a backend session record, not job
// data); we capture the overlay and close the context immediately, which
// tears down the websocket. Nothing is dictated, applied, or saved.
if (!process.env.SKIP_RECORDING) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      ...vp.device,
      colorScheme: 'dark',
      storageState: STATE_FILE,
      permissions: ['microphone'],
    });
    const page = await ctx.newPage();
    await visit(page, `/job/${JOB.eicr}`);
    try {
      await page.getByRole('button', { name: 'Start recording' }).click({ timeout: 10_000 });
      await page.waitForTimeout(7_000); // let the session connect + chrome render
      await shot(page, 'recording-eicr', vp.tag, { fullPage: false });
    } catch (e) {
      console.warn(`recording capture failed (${vp.tag}):`, e.message);
    }
    await ctx.close();
  }
}

await browser.close();
rmSync(STATE_FILE, { force: true });
console.log('done →', OUT);
