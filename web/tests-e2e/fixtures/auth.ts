import type { BrowserContext, Page } from '@playwright/test';
import type { JobDetail, User } from '../../src/lib/types';

/**
 * Test-harness auth helpers.
 *
 * The middleware gate decodes the JWT from the `token` cookie and checks
 * `exp`. There's no signature check in middleware — `src/middleware.ts`
 * only `atob`s the payload (Wave 4 D4 will add signature verify; until
 * then an unsigned-but-decodable JWT with a future `exp` passes). We
 * mint one here so specs don't need a running auth backend.
 *
 * `localStorage` holds the mirrored token + user blob that
 * `web/src/lib/auth.ts:getUser()` reads. Setting both via
 * `addInitScript` + `context.addCookies` means the very first navigation
 * in the spec already looks authenticated.
 */

const TEST_USER: User = {
  id: 'test-inspector-1',
  email: 'inspector@example.com',
  name: 'Test Inspector',
  role: 'user',
  company_role: 'employee',
};

/** Unsigned JWT with `exp = now + 1h`. Middleware passes it; the
 *  payload is base64url-encoded JSON. Header + signature are placeholders
 *  — nothing in the test path verifies the signature. */
function mintTestJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  return `${header}.${body}.sig`;
}

export interface AuthFixture {
  token: string;
  user: User;
}

/** Build a fresh `{token, user}` pair with a 1-hour expiry. */
export function buildAuth(): AuthFixture {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60;
  const token = mintTestJwt({
    sub: TEST_USER.id,
    email: TEST_USER.email,
    role: TEST_USER.role,
    company_role: TEST_USER.company_role,
    exp,
  });
  return { token, user: TEST_USER };
}

/**
 * Prime a Playwright context with auth. Sets the `token` cookie so the
 * Next middleware lets the request through, then pushes the same token
 * + user JSON into localStorage so `getUser()` / `getToken()` see a
 * logged-in state on the very first render.
 *
 * Must run BEFORE the first `page.goto()` — cookies + init scripts
 * attach at the context level so they apply to every subsequent nav.
 */
export async function primeAuth(
  context: BrowserContext,
  auth: AuthFixture,
  baseURL: string
): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: 'token',
      value: auth.token,
      domain: url.hostname,
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
  ]);

  // localStorage seeding has to happen in a page-init script (cookies
  // attach to the context, localStorage is per-origin and only exists
  // once a page navigates to that origin). The app reads the same two
  // keys that `lib/auth.ts:setAuth` writes.
  const token = auth.token;
  const userJson = JSON.stringify(auth.user);
  await context.addInitScript(
    ({ token, userJson }: { token: string; userJson: string }) => {
      try {
        localStorage.setItem('cm_token', token);
        localStorage.setItem('cm_user', userJson);
      } catch {
        // Private mode / SSR early call — ignore; the app will just
        // think we're logged out and the spec will fail visibly.
      }
    },
    { token, userJson }
  );
}

/**
 * Build a permissive JobDetail fixture. Adapter-typed on the way out so
 * a schema drift in `web/src/lib/types.ts` fails the spec compile step
 * rather than the runtime assertion.
 */
export function buildJobFixture(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'test-job-1',
    address: '1 Test Street, London',
    status: 'pending',
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    certificate_type: 'EICR',
    installation: {},
    extent: {},
    supply: {},
    board: {},
    circuits: [],
    observations: [],
    inspection: {},
    design: {},
    ...overrides,
  };
}

/**
 * Stub every HTTP call the record flow touches. Anything the spec
 * forgets to stub will surface as a real network call → the spec will
 * see "Couldn't load job: Failed to fetch" and fail loud.
 *
 * Uses `page.route()` so stubs only apply to the current page (the WS
 * stub at `deepgram-ws-stub.ts` operates at the browser level instead).
 */
export async function stubRecordFlowApi(page: Page, job: JobDetail): Promise<void> {
  // Job detail endpoint — /api/job/:userId/:jobId.
  await page.route(/\/api\/job\/[^/]+\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(job),
    });
  });

  // Deepgram scoped token — /api/deepgram-proxy.
  await page.route(/\/api\/deepgram-proxy/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ key: 'test-deepgram-key' }),
    })
  );

  // Any other /api/* call during the record flow is a surprise — fail
  // fast with 500 so the spec author sees it rather than hanging on a
  // real fetch.
  await page.route(/\/api\//, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unstubbed API call in e2e' }),
    })
  );
}
