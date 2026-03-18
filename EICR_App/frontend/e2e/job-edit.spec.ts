/**
 * E2E tests for job editing and tab navigation.
 * Tests navigating between job tabs and basic interactions.
 */

import { test, expect, Page } from "@playwright/test";

const TEST_USER = { id: "user-1", email: "test@example.com" };
const JOB_ID = "job_abc-123";
const SAMPLE_JOB_DETAIL = {
  id: JOB_ID,
  address: "18 Test Street",
  status: "done",
  created_at: "2026-02-01T10:00:00Z",
  certificate_type: "EICR",
  circuits: [
    {
      id: "c1",
      circuit_number: 1,
      designation: "Lighting",
      ocpd_type: "MCB",
      ocpd_rating: "6",
      cable_size: "1.5",
    },
  ],
  observations: [
    {
      code: "C2",
      item_location: "Kitchen",
      observation_text: "Damaged socket outlet",
    },
  ],
  installation_details: {
    client_name: "John Smith",
    address: "18 Test Street",
    reason_for_report: "Periodic inspection",
  },
  supply_characteristics: {
    ze: "0.35",
    pfc: "1.2",
    earthing_arrangement: "TN-C-S",
  },
  board_info: {
    name: "Main Consumer Unit",
    manufacturer: "Hager",
  },
  inspection_schedule: {},
  boards: [],
};

async function setupAuthAndMocks(page: Page) {
  // Set auth state
  await page.goto("/login");
  await page.evaluate(
    ({ user, token }) => {
      localStorage.setItem("user", JSON.stringify(user));
      localStorage.setItem("token", token);
      document.cookie = `token=${token}; path=/; max-age=86400`;
    },
    { user: TEST_USER, token: "test-jwt-token" }
  );

  // Mock job detail API
  await page.route(`**/api/jobs/user-1/${JOB_ID}`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SAMPLE_JOB_DETAIL),
      });
    }
    // PUT for save
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  // Mock jobs list (for back navigation)
  await page.route("**/api/jobs/user-1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([SAMPLE_JOB_DETAIL]),
    })
  );

  // Mock socket.io
  await page.route("**/socket.io/**", (route) => route.abort());
}

test.describe("Job Editing", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthAndMocks(page);
  });

  test("loads job and displays address in header", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);

    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });
  });

  test("displays EICR tab navigation", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);

    // Wait for page to load
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    // Check EICR-specific tabs are visible
    const expectedTabs = [
      "Overview",
      "Installation",
      "Supply",
      "Board",
      "Circuits",
      "Observations",
    ];

    for (const tabName of expectedTabs) {
      await expect(
        page.getByRole("link", { name: tabName, exact: true })
      ).toBeVisible();
    }
  });

  test("navigates to Installation tab", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await page
      .getByRole("link", { name: "Installation", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/job/${JOB_ID}/installation`));
  });

  test("navigates to Supply tab", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole("link", { name: "Supply", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/job/${JOB_ID}/supply`));
  });

  test("navigates to Circuits tab", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole("link", { name: "Circuits", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/job/${JOB_ID}/circuits`));
  });

  test("navigates to Observations tab", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await page
      .getByRole("link", { name: "Observations", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/job/${JOB_ID}/observations`));
  });

  test("navigates to PDF tab", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole("link", { name: "PDF", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/job/${JOB_ID}/pdf`));
  });

  test("has Save button in header", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    await expect(
      page.getByRole("button", { name: /save/i })
    ).toBeVisible();
  });

  test("has back button that navigates to dashboard", async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    // Click the back arrow button (first ghost button with ArrowLeft icon)
    const backButton = page.locator("header button").first();
    await backButton.click();

    await expect(page).toHaveURL(/dashboard/, { timeout: 5000 });
  });
});

test.describe("EIC Tab Navigation", () => {
  test("displays EIC-specific tabs for EIC job", async ({ page }) => {
    // Override with EIC certificate type
    const eicJob = { ...SAMPLE_JOB_DETAIL, certificate_type: "EIC" };

    await page.goto("/login");
    await page.evaluate(
      ({ user, token }) => {
        localStorage.setItem("user", JSON.stringify(user));
        localStorage.setItem("token", token);
        document.cookie = `token=${token}; path=/; max-age=86400`;
      },
      { user: TEST_USER, token: "test-jwt-token" }
    );

    await page.route(`**/api/jobs/user-1/${JOB_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(eicJob),
      })
    );

    await page.route("**/socket.io/**", (route) => route.abort());

    await page.goto(`/job/${JOB_ID}`);
    await expect(page.getByText("18 Test Street")).toBeVisible({
      timeout: 5000,
    });

    // EIC has "Extent & Type" and "Design" tabs instead of EICR's "Inspection"
    await expect(
      page.getByRole("link", { name: "Extent & Type", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Design", exact: true })
    ).toBeVisible();
  });
});
