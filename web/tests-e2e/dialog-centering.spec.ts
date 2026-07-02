import { test, expect } from '@playwright/test';
import { buildAuth, primeAuth } from './fixtures/auth';

/**
 * Dialog centering regression — Parity WS5 (2026-07-02).
 *
 * Guards against the double-offset bug found during the WS0 visual
 * baseline: Tailwind v4's standalone `-translate-x-1/2 -translate-y-1/2`
 * utilities emit the CSS `translate` PROPERTY, while the
 * `.cm-dialog-content` animation block in `globals.css` used to set a
 * `transform: translate(-50%, -50%) scale(1)` on the same element. The
 * two compose (translate property + transform property both apply), so
 * every styled `DialogContent` rendered offset a further half-width up
 * and left of centre.
 *
 * The fix keeps the Tailwind utilities as the ONLY translation source
 * and moves the open/close animation onto the standalone `scale`
 * property, so this spec asserts two things on a real styled consumer:
 *   1. geometry — the dialog's box is centred in the viewport
 *      (x within the 16px `mx-4` margin shift, y exact);
 *   2. mechanism — the computed styles do not carry a translation in
 *      BOTH `translate` and `transform` at once.
 *
 * Consumer under test: the /terms legal-document dialog. Chosen
 * deliberately over the CCU sheet / settings modals because the terms
 * page used to re-specify `fixed left-1/2 top-1/2 -translate-*` on its
 * DialogContent className — this spec exercises the consumer-level
 * cleanup as well as the primitive. Do NOT swap this for
 * `ObservationSheet` or the job-photos picker: both pass `unstyled` and
 * bypass the centred-card transform path entirely.
 */

test.describe('styled DialogContent centering', () => {
  test('terms legal-document dialog is centred exactly once', async ({
    page,
    context,
    baseURL,
  }) => {
    await primeAuth(context, buildAuth(), baseURL!);
    await page.goto('/terms');

    // Open the T&Cs legal-document dialog. The row button's accessible
    // name is "Read Terms & Conditions" — anchored so the (disabled)
    // "Accept terms and conditions" CTA can never match.
    await page.getByRole('button', { name: /^read terms & conditions/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Radix flips data-state to "open" after mount; wait for it so the
    // open-state styles (not the closed-state scale) are what we read.
    await expect(dialog).toHaveAttribute('data-state', 'open');

    // Screenshot before the assertions so a failing run still leaves
    // visual evidence in test-results/.
    await page.screenshot({
      path: 'test-results/dialog-centering-terms.png',
      fullPage: false,
    });

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const vp = page.viewportSize();
    expect(vp).not.toBeNull();

    const centreX = box!.x + box!.width / 2;
    const centreY = box!.y + box!.height / 2;

    // Vertical: exact centre (no vertical margin on the recipe). The
    // double-offset bug shifted the box up by height/2 — hundreds of px —
    // so a 2px tolerance is a sharp discriminator.
    expect(Math.abs(centreY - vp!.height / 2)).toBeLessThanOrEqual(2);
    // Horizontal: the primitive's `mx-4` shifts the border box up to
    // 16px right of true centre by design; allow margin + rounding.
    expect(Math.abs(centreX - vp!.width / 2)).toBeLessThanOrEqual(17);

    // Mechanism assertion: translation must come from exactly one of the
    // two composable channels. Pre-fix, `translate` (Tailwind v4 utility)
    // AND `transform` (cm-dialog-content) both carried -50% translations.
    const { translate, transform } = await dialog.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { translate: cs.translate, transform: cs.transform };
    });
    const translateActive = translate !== 'none' && translate !== '' && translate !== '0px';
    const transformTranslates = (() => {
      if (transform === 'none' || transform === '') return false;
      // matrix(a, b, c, d, tx, ty) — translation lives in tx/ty.
      const m = transform.match(/matrix\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(',').map((v) => parseFloat(v));
      return Math.abs(parts[4]) > 0.5 || Math.abs(parts[5]) > 0.5;
    })();
    expect(
      translateActive && transformTranslates,
      `dialog translated twice: translate="${translate}" transform="${transform}"`
    ).toBe(false);
  });
});
