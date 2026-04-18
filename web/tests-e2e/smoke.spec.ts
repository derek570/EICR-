import { test, expect } from '@playwright/test';

/**
 * Harness-level smoke. Loads the login page (unauth root redirects there
 * via middleware) and asserts a well-known marker renders. Isolates
 * "Playwright itself is misconfigured" failures from "the app is broken"
 * failures in every other spec.
 *
 * Why /login and not /: the root page redirects to /login without a
 * token cookie, and that redirect is the first thing to break if the
 * server hasn't booted yet. If *this* spec passes we know: dev server
 * up, Next middleware running, baseURL correct, browser launching.
 */
test.describe('smoke', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login');

    // The login form is the one stable landmark across the whole app —
    // even minor chrome changes shouldn't move the email input.
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });
});
