import { test, expect, type Page } from '@playwright/test';
import { buildAuth, buildJobFixture, primeAuth, stubRecordFlowApi } from './fixtures/auth';

/**
 * PLAN-F web acceptance — the grown long-text control, in a real browser
 * (feedback ids 135 and 137, 2026-09-14).
 *
 * This is the ONLY lane that can assert the thing Derek actually reported.
 * The vitest suite runs under jsdom, which implements no CSS layout, so
 * `scrollHeight` / `clientHeight` there are meaningless; `tests/long-text-
 * fields.test.tsx` pins the structure and this spec pins the rendering.
 *
 * Viewports are phone-sized on purpose. At a 1280px desktop width a
 * 300-character clause already fits on three lines, so the desktop case
 * cannot distinguish a grown control from the fixed one it replaced — it
 * would pass against the bug. Both orientations are covered because id 135
 * named landscape specifically.
 */

const JOB_ID = 'test-job-1';

/** ~300 characters — a realistic extent clause, per the plan's acceptance. */
const THREE_HUNDRED_CHARS =
  'The whole of the fixed electrical installation at the premises, including the main consumer unit, ' +
  'all final circuits fed from it, the air conditioning isolator added under this certificate, and ' +
  'the sub-board serving the detached garage together with every circuit supplied from that board.';

/** Comfortably past the 12-line cap at any phone width. */
const VERY_LONG = THREE_HUNDRED_CHARS.repeat(6);

/** 12 lines × 24px — `AUTO_GROW_MAX_LINES * AUTO_GROW_LINE_HEIGHT`. */
const CAP_PX = 288;
/** 3 lines × 24px — the resting height of an empty field. */
const FLOOR_PX = 72;

const PORTRAIT = { width: 393, height: 852 };
const LANDSCAPE = { width: 852, height: 393 };

async function measureExtent(page: Page, value: string) {
  const extent = page.getByLabel('Extent');
  await expect(extent).toBeVisible();
  await extent.fill(value);
  // The counter is the cheap proof the value actually landed in state.
  await expect(page.getByText(`${value.length} characters`)).toBeVisible();
  return extent.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

test.describe('long free-text fields grow with their content', () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL missing from Playwright config');
    await primeAuth(context, buildAuth(), baseURL);
    // AppShell bounces an un-accepted device to `/terms?next=…`, which
    // detaches the field mid-test. Accept the current version up front —
    // the gate reads localStorage only (`app/terms/legal-texts-gate.ts`).
    await context.addInitScript(() => {
      window.localStorage.setItem('termsAccepted', 'true');
      window.localStorage.setItem('termsAcceptedVersion', '1.0');
    });
    await stubRecordFlowApi(page, buildJobFixture({ id: JOB_ID }));
  });

  test('a 300-character extent is fully visible on a portrait phone', async ({ page }) => {
    await page.setViewportSize(PORTRAIT);
    await page.goto(`/job/${JOB_ID}/extent`);

    const box = await measureExtent(page, THREE_HUNDRED_CHARS);

    // Grew past the 3-line floor — this is the assertion the fixed-`rows`
    // control failed.
    expect(box.clientHeight).toBeGreaterThan(FLOOR_PX);
    // …and every line of it is on screen. 1px of slack absorbs sub-pixel
    // rounding in the browser's own box model.
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
  });

  test('a 300-character extent is fully visible in landscape (id 135)', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE);
    await page.goto(`/job/${JOB_ID}/extent`);

    // *"in the landscape view, the extent covered does not fill the box. I
    // can only see the first few words."* Nothing hidden behind an internal
    // scrollbar is the whole of that complaint.
    const box = await measureExtent(page, THREE_HUNDRED_CHARS);
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
    expect(box.clientHeight).toBeLessThanOrEqual(CAP_PX);

    // 300 characters happen to fit the OLD four-row box at this width, so the
    // assertion above passes against the bug too. Keep it — it is the
    // acceptance Derek reported — but follow it with a clause long enough to
    // discriminate, which is what makes this case a gate rather than a
    // description.
    const longer = await measureExtent(page, THREE_HUNDRED_CHARS.repeat(2));
    expect(longer.clientHeight).toBeGreaterThan(box.clientHeight);
    expect(longer.scrollHeight).toBeLessThanOrEqual(longer.clientHeight + 1);
  });

  test('re-fits when the device is rotated (id 135)', async ({ page }) => {
    // The reported gesture. Height depends on WIDTH, so a clause that fits
    // three lines in landscape needs eight in portrait; without a re-fit the
    // control keeps its landscape height and hides two thirds of the text
    // behind an internal scrollbar. Measured on the unfixed build:
    // clientHeight 72 against scrollHeight 192.
    await page.setViewportSize(LANDSCAPE);
    await page.goto(`/job/${JOB_ID}/extent`);

    const landscape = await measureExtent(page, THREE_HUNDRED_CHARS);
    expect(landscape.scrollHeight).toBeLessThanOrEqual(landscape.clientHeight + 1);

    const extent = page.getByLabel('Extent');

    // Rotate to portrait: the same text now needs more lines.
    await page.setViewportSize(PORTRAIT);
    await expect
      .poll(async () => extent.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeLessThanOrEqual(1);
    const portrait = await extent.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(portrait.clientHeight).toBeGreaterThan(landscape.clientHeight);

    // …and back, so the box shrinks again rather than staying tall.
    await page.setViewportSize(LANDSCAPE);
    await expect
      .poll(async () => extent.evaluate((el) => el.clientHeight))
      .toBeLessThan(portrait.clientHeight);
    const back = await extent.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(back.scrollHeight).toBeLessThanOrEqual(back.clientHeight + 1);
  });

  test('growth stops at the 12-line cap and the rest scrolls', async ({ page }) => {
    await page.setViewportSize(PORTRAIT);
    await page.goto(`/job/${JOB_ID}/extent`);

    const box = await measureExtent(page, VERY_LONG);

    // The cap is what keeps a long clause from pushing the installation-type
    // picker and the Comments card off the screen.
    expect(box.clientHeight).toBe(CAP_PX);
    // Past the cap the content is reachable by scrolling, not clipped away.
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  });
});
