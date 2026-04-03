/**
 * E2E tests for authentication flow.
 * Tests login page rendering, form validation, successful login,
 * failed login, and protected route redirect.
 */

import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Clear any stored auth state
    await page.goto("/login");
    await page.evaluate(() => {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      document.cookie = "token=; path=/; max-age=0";
    });
  });

  test("login page renders with form fields", async ({ page }) => {
    await page.goto("/login");

    // Check page title
    await expect(
      page.getByText("CertMate")
    ).toBeVisible();

    // Check form fields exist
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });

  test("shows validation error for invalid email", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("not-an-email");
    await page.getByLabel(/password/i).fill("somepassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/valid email/i)).toBeVisible();
  });

  test("shows validation error for missing password", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel(/email/i).fill("test@example.com");
    // Leave password empty and submit
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/password is required/i)).toBeVisible();
  });

  test("login with invalid credentials shows error toast", async ({
    page,
  }) => {
    // Mock the API to return an error
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid email or password" }),
      })
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("wrong@example.com");
    await page.getByLabel(/password/i).fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should show error (via sonner toast)
    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 5000 });
  });

  test("successful login redirects to dashboard", async ({ page }) => {
    // Mock login API
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "test-jwt-token",
          user: { id: "user-1", email: "test@example.com" },
        }),
      })
    );

    // Mock the jobs API that dashboard will call
    await page.route("**/api/jobs/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    );

    await page.goto("/login");
    await page.getByLabel(/email/i).fill("test@example.com");
    await page.getByLabel(/password/i).fill("testpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/dashboard/, { timeout: 5000 });
  });

  test("protected route redirects to login when not authenticated", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    // Dashboard checks localStorage for user and redirects to /login
    await expect(page).toHaveURL(/login/, { timeout: 5000 });
  });
});
