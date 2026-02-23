/**
 * E2E tests for the dashboard page.
 * Tests job listing, new job creation, refresh, and navigation.
 */

import { test, expect, Page } from "@playwright/test";

const TEST_USER = { id: "user-1", email: "test@example.com" };
const SAMPLE_JOBS = [
  {
    id: "job_abc-123",
    address: "18 Test Street",
    status: "done",
    created_at: "2026-02-01T10:00:00Z",
    certificate_type: "EICR",
  },
  {
    id: "job_def-456",
    address: "42 Example Road",
    status: "pending",
    created_at: "2026-02-15T14:00:00Z",
    certificate_type: "EIC",
  },
];

async function loginAndSetup(page: Page) {
  // Set auth state in localStorage before navigating
  await page.goto("/login");
  await page.evaluate(
    ({ user, token }) => {
      localStorage.setItem("user", JSON.stringify(user));
      localStorage.setItem("token", token);
      document.cookie = `token=${token}; path=/; max-age=86400`;
    },
    { user: TEST_USER, token: "test-jwt-token" }
  );
}

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    // Mock API endpoints
    await page.route("**/api/jobs/user-1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SAMPLE_JOBS),
      })
    );

    // Mock socket.io connection
    await page.route("**/socket.io/**", (route) => route.abort());

    await loginAndSetup(page);
  });

  test("displays job list", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page.getByText("Your Jobs")).toBeVisible();
    await expect(page.getByText("18 Test Street")).toBeVisible();
    await expect(page.getByText("42 Example Road")).toBeVisible();
  });

  test("shows empty state when no jobs", async ({ page }) => {
    // Override to return empty jobs
    await page.route("**/api/jobs/user-1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    );

    await page.goto("/dashboard");

    await expect(page.getByText("No jobs yet")).toBeVisible();
  });

  test("has Record EICR and Record EIC buttons", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(
      page.getByRole("button", { name: /Record EICR/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Record EIC/i })
    ).toBeVisible();
  });

  test("has refresh button", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(
      page.getByRole("button", { name: /refresh/i })
    ).toBeVisible();
  });

  test("clicking a job card navigates to job detail", async ({ page }) => {
    // Mock job detail API
    await page.route("**/api/jobs/user-1/job_abc-123", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...SAMPLE_JOBS[0],
          circuits: [],
          observations: [],
          installation_details: {},
          supply_characteristics: {},
          board_info: {},
        }),
      })
    );

    await page.goto("/dashboard");

    // Wait for jobs to load
    await expect(page.getByText("18 Test Street")).toBeVisible();

    // Click the job card (it's a link)
    await page.getByText("18 Test Street").click();

    await expect(page).toHaveURL(/\/job\/job_abc-123/, { timeout: 5000 });
  });

  test("logout clears auth and redirects to login", async ({ page }) => {
    // Mock logout API
    await page.route("**/api/auth/logout", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      })
    );

    await page.goto("/dashboard");
    await expect(page.getByText("Your Jobs")).toBeVisible();

    // Find and click logout — it may be in a dropdown or settings menu
    // The DashboardHeader contains the logout button
    const logoutButton = page.getByRole("button", { name: /log\s*out/i });
    if (await logoutButton.isVisible()) {
      await logoutButton.click();
    } else {
      // May be behind a menu — click menu button first
      const menuButton = page.locator("[data-testid='user-menu']").or(
        page.getByRole("button", { name: /menu|settings/i })
      );
      if (await menuButton.isVisible()) {
        await menuButton.click();
        await page.getByText(/log\s*out/i).click();
      }
    }

    // Should redirect to login
    await expect(page).toHaveURL(/login/, { timeout: 5000 });

    // localStorage should be cleared
    const token = await page.evaluate(() => localStorage.getItem("token"));
    expect(token).toBeNull();
  });
});
