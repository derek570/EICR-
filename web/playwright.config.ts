import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — Wave 3H harness stand-up.
 *
 * First Playwright harness in this codebase. Keeps scope tight:
 *
 *   - `testDir: ./tests-e2e` is deliberately *outside* the vitest
 *     `tests/` directory so vitest's `include: ['tests/**']` glob and
 *     this runner never compete for the same files.
 *   - `baseURL` + `webServer` boot a local dev server on :3001. The
 *     backend claims :3000, so the spec files always target :3001 for
 *     the web app. We invoke `next dev` directly rather than
 *     `npm run dev --workspace=web` because `PORT` only takes effect
 *     when passed to the `next` binary (turbopack reads the env var
 *     before any npm-script env injection).
 *   - `chromium` + `webkit` projects only. iOS Safari parity is the
 *     whole reason this app exists; firefox would be extra install
 *     weight for no coverage we care about.
 *   - `reporter: 'list'` — readable in terminals, no HTML report junk
 *     to gitignore until we wire up CI.
 *   - Retries: 0 local (fail fast so drift is visible), 2 CI (absorb
 *     the one-in-a-hundred WS handshake flake so CI stays green).
 *   - Pre-push hook integration deliberately deferred (Wave 5 gate).
 *     Playwright is ~5s startup + per-spec browser boot; unsuitable
 *     for pre-push until we've proven its stability.
 */
export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    // `next dev` honours PORT; running it via the workspace binary
    // avoids a second shell layer that might eat the env var.
    command: 'PORT=3001 npx next dev --turbopack',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
