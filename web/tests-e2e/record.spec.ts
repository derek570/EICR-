import { test, expect } from '@playwright/test';
import { DEEPGRAM_WS_STUB } from './fixtures/deepgram-ws-stub';
import { buildAuth, buildJobFixture, primeAuth, stubRecordFlowApi } from './fixtures/auth';

/**
 * Record flow E2E. Maps to WEB_REBUILD_COMPLETION.md §5 gate 9
 * "Record (stubbed WS)":
 *
 *   - start → pause → resume → end a recording
 *   - in-page chrome (toolbar + transcript bar + viewport ring) renders
 *     while a session is active and tears down on End
 *   - reduced-motion preference is plumbed through to the page
 *   - no in-flight network error toasts after End
 *
 * Wave 5 D-pulse rebuild: the previous Radix Dialog overlay was replaced
 * with a `RecordingChrome` (red pulsing viewport ring + bottom action
 * toolbar + sticky transcript bar) so the live form stays visible during
 * recording. The accompanying focus-trap / Esc-to-close test was dropped
 * with the Dialog — the chrome is non-modal by design and there is no
 * focus scope to assert.
 *
 * All external wires are stubbed at the browser boundary:
 *   - HTTP: `page.route()` handles `/api/job/...` + `/api/proxy/deepgram-streaming-key`
 *   - WebSocket: `page.addInitScript(DEEPGRAM_WS_STUB)` replaces
 *     `window.WebSocket` before the app boots so Deepgram + Sonnet
 *     sockets connect in-process.
 *
 * Media: `getUserMedia` is granted via `context.grantPermissions(['microphone'])`.
 * Chromium exposes a fake mic by default; WebKit emulates silent audio.
 * Either way the app's RMS meter stays ~0 — the stubs already emit a
 * transcript so the spec doesn't depend on real audio reaching Deepgram.
 */

const JOB_ID = 'test-job-1';

test.describe('record flow (stubbed WS)', () => {
  // WebKit doesn't expose a fake audio device equivalent to Chromium's
  // `--use-fake-device-for-media-stream`, and `grantPermissions` on
  // WebKit rejects the `microphone` name. The whole flow below needs
  // a working `getUserMedia`; skip the project with a documented
  // reason. Smoke spec still exercises WebKit so iOS parity isn't
  // silently dropped.
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit cannot fake a mic stream in headless Playwright'
  );

  test.beforeEach(async ({ context, page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL missing from Playwright config');

    // Seed auth so the Next middleware lets `/job/...` render.
    await primeAuth(context, buildAuth(), baseURL);

    // Grant mic permission up-front; without it the app flips to
    // `state === 'error'` in <100ms and nothing else works. Chromium
    // gets the grant via `grantPermissions` + the fake-device launch
    // flag (see `playwright.config.ts`), which creates a real virtual
    // audio track `AudioContext.createMediaStreamSource` is happy
    // with. WebKit doesn't recognise the 'microphone' permission
    // name AND has no equivalent flag, so the record flow is
    // Chromium-only for this wave — WebKit coverage is a gap we
    // document in WAVE_3H_HANDOFF.md.
    try {
      await context.grantPermissions(['microphone'], { origin: baseURL });
    } catch {
      // WebKit — the tests below skip themselves via `browserName`.
    }

    // Install the Deepgram / Sonnet WS stub in every page.
    await context.addInitScript({ content: DEEPGRAM_WS_STUB });

    // Stub HTTP APIs before the first navigation so the layout fetch
    // sees a 200 rather than a real network hit.
    await stubRecordFlowApi(page, buildJobFixture({ id: JOB_ID }));
  });

  test('start → pause → resume → end transitions cleanly', async ({ page }) => {
    await page.goto(`/job/${JOB_ID}`);

    // Start the session. Mic button is the prominent green FAB.
    const micButton = page.getByRole('button', { name: /^start recording$/i });
    await expect(micButton).toBeVisible();
    await micButton.click();

    // The new in-page chrome mounts a `role=toolbar` action bar with the
    // "Recording controls" accessible name (recording-chrome.tsx). The
    // viewport ring (`.cm-rec-ring`) and the sticky transcript bar
    // (`role=status` "Live transcript") are the other two surfaces — all
    // three appear together while a session is non-idle.
    const toolbar = page.getByRole('toolbar', { name: /recording controls/i });
    await expect(toolbar).toBeVisible();
    await expect(page.locator('.cm-rec-ring')).toBeVisible();
    await expect(page.getByRole('status', { name: /live transcript/i })).toBeVisible();

    // Live state pill flips to "Listening" once mic + WS handshake
    // complete (was "Recording" on the old overlay; renamed when the
    // chrome adopted the iOS-style state language).
    await expect(toolbar.getByText(/listening/i).first()).toBeVisible({ timeout: 10_000 });

    // Pause.
    await toolbar.getByRole('button', { name: /^pause$/i }).click();
    await expect(toolbar.getByText(/paused/i).first()).toBeVisible();

    // Resume — the Pause control swaps to a Resume button while the
    // session is dozing/sleeping.
    await toolbar.getByRole('button', { name: /^resume$/i }).click();
    await expect(toolbar.getByText(/listening/i).first()).toBeVisible();

    // End — equivalent to the old Stop. Tears the chrome down and
    // returns the session to idle.
    await toolbar.getByRole('button', { name: /^end$/i }).click();

    // All three chrome surfaces unmount on idle.
    await expect(toolbar).toBeHidden();
    await expect(page.locator('.cm-rec-ring')).toHaveCount(0);
    await expect(page.getByRole('status', { name: /live transcript/i })).toHaveCount(0);

    // No in-flight error toast. Sonner's toaster container mounts
    // an empty `role=alert` region always; Next.js dev mode also
    // mounts a silent alert node for hydration/error reporting.
    // Both are fine — what we DON'T want is a *visible* alert with
    // error copy. Assert the product-surface error banner from the
    // layout ("Couldn't load job…") is absent, and no sonner toast
    // with 'error'/'failed' copy has popped.
    await expect(page.getByText(/couldn.?t load job/i)).toHaveCount(0);
    await expect(
      page.locator('[role="status"], [role="alert"]').filter({ hasText: /error|failed/i })
    ).toHaveCount(0);
  });

  test('reduced-motion preference is plumbed through to the recording chrome', async ({
    browser,
    baseURL,
  }) => {
    // Fresh context so the reduced-motion preference applies from the
    // very first paint — the ring's `cm-rec-ring` keyframes are wired
    // at mount, so toggling mid-test would be a no-op for the global
    // `@media (prefers-reduced-motion)` short-circuit.
    const context = await browser.newContext({
      reducedMotion: 'reduce',
    });
    if (!baseURL) throw new Error('baseURL missing from Playwright config');
    await primeAuth(context, buildAuth(), baseURL);
    await context.grantPermissions(['microphone'], { origin: baseURL });
    await context.addInitScript({ content: DEEPGRAM_WS_STUB });
    const page = await context.newPage();
    await stubRecordFlowApi(page, buildJobFixture({ id: JOB_ID }));
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/job/${JOB_ID}`);

      // The CSS media query must resolve to `reduce` so any animation
      // the chrome registers (`cm-rec-ring`, `cm-pulse-dot`) is
      // suppressed by the global `@media (prefers-reduced-motion)`
      // rule in globals.css.
      const prefersReduce = await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      expect(prefersReduce).toBe(true);

      await page.getByRole('button', { name: /^start recording$/i }).click();
      const toolbar = page.getByRole('toolbar', { name: /recording controls/i });
      await expect(toolbar).toBeVisible();

      // Ring renders regardless of motion preference; the keyframes
      // animation is what gets neutralised, not the element itself.
      // We don't strictly assert `animation-duration: 0s` here (the
      // global stylesheet hook is still a Wave 5 D9 follow-up) but we
      // DO assert the signal is available to the app. If D9 lands the
      // follow-up can tighten this assertion against `cm-rec-ring`.
      await expect(page.locator('.cm-rec-ring')).toBeVisible();

      await toolbar.getByRole('button', { name: /^end$/i }).click();
      await expect(toolbar).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
