/**
 * Wave 5 D8 — IconButton regression tests.
 *
 * Why these tests:
 *   D8 closes a WCAG 2.5.5 hit-target gap: several icon-only buttons in
 *   the app rendered below 44×44. The <IconButton> primitive enforces
 *   the minimum at the type + class level. These tests lock the
 *   contract so a drive-by className change can't silently regress
 *   the target size.
 *
 * What we assert:
 *   1. `size="md"` (the default) produces h-11 w-11 = 44×44
 *   2. `size="sm"` = 36×36, `size="lg"` = 48×48 (edge sizes)
 *   3. `aria-label` is present on the rendered element
 *   4. `type` defaults to "button" (don't submit containing forms)
 *   5. `asChild` forwards classes to a child element (for Link usage)
 *   6. Click handler fires
 *
 * We intentionally do NOT read computed styles via getComputedStyle —
 * jsdom's layout is not a real renderer and the tailwind classes we
 * check are the source of truth the design system trusts. Asserting
 * on className carries the real guarantee.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IconButton } from '@/components/ui/icon-button';

// Mount via createRoot directly (mirrors outbox-replay integration tests)
// to avoid the React-instance dual-copy hazard documented in vitest.config.ts.
function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  mounted = null;
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function TestIcon() {
  return <svg data-testid="glyph" width="16" height="16" aria-hidden />;
}

describe('IconButton', () => {
  it('defaults to size="md" producing a 44×44 hit area (h-11 w-11)', () => {
    mounted = mount(
      <IconButton aria-label="Close sheet">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button');
    expect(btn).not.toBeNull();
    // 44×44 is tailwind's h-11 w-11. Lock the exact classes: missing
    // either means a call site (or the cva defaults) silently dropped
    // below the WCAG floor.
    expect(btn!.className).toContain('h-11');
    expect(btn!.className).toContain('w-11');
  });

  it('size="sm" renders 36×36 (h-9 w-9) — desktop-only', () => {
    mounted = mount(
      <IconButton aria-label="Dismiss" size="sm">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.className).toContain('h-9');
    expect(btn.className).toContain('w-9');
  });

  it('size="lg" renders 48×48 (h-12 w-12)', () => {
    mounted = mount(
      <IconButton aria-label="Open menu" size="lg">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.className).toContain('h-12');
    expect(btn.className).toContain('w-12');
  });

  it('propagates the required aria-label', () => {
    mounted = mount(
      <IconButton aria-label="Remove photo">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toBe('Remove photo');
  });

  it('defaults type="button" so it does not submit containing forms', () => {
    // Regression guard: an earlier draft forgot to set a default, which
    // meant dropping an IconButton inside a <form> would submit on click.
    mounted = mount(
      <form>
        <IconButton aria-label="Clear">
          <TestIcon />
        </IconButton>
      </form>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('allows type override (e.g. type="submit") when explicitly set', () => {
    mounted = mount(
      <IconButton aria-label="Submit" type="submit">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.getAttribute('type')).toBe('submit');
  });

  it('fires onClick when clicked', () => {
    const handler = vi.fn();
    mounted = mount(
      <IconButton aria-label="Delete" onClick={handler}>
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    act(() => {
      btn.click();
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders a 24×24 glyph wrapper around the child icon', () => {
    // The wrapper span gives a consistent visual slot regardless of
    // the child SVG's own size. h-6 w-6 = 24×24 per the design system.
    mounted = mount(
      <IconButton aria-label="X">
        <TestIcon />
      </IconButton>
    );
    const wrapper = mounted.container.querySelector('button > span');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain('h-6');
    expect(wrapper!.className).toContain('w-6');
  });

  it('applies variant classes (destructive)', () => {
    mounted = mount(
      <IconButton aria-label="Delete circuit" variant="destructive">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    // The destructive variant maps to the status-failed token. Check
    // for the token fragment rather than the full class so the test
    // survives minor Tailwind arbitrary-value formatting changes.
    expect(btn.className).toContain('color-status-failed');
  });

  it('asChild merges classes onto the child element (Link usage)', () => {
    // The sweep sites use Next <Link> as the element for "Back to X"
    // navigation. Slot merges our 44×44 classes onto the Link's <a>
    // root so the target size applies to the anchor, not a wrapping
    // button.
    mounted = mount(
      <IconButton aria-label="Back to settings" asChild>
        <a href="/settings" data-testid="link">
          <TestIcon />
        </a>
      </IconButton>
    );
    const anchor = mounted.container.querySelector('a')!;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('aria-label')).toBe('Back to settings');
    expect(anchor.className).toContain('h-11');
    expect(anchor.className).toContain('w-11');
    // There should NOT be an outer <button> in asChild mode.
    expect(mounted.container.querySelector('button')).toBeNull();
  });

  it('focus-visible outline classes are present for keyboard a11y', () => {
    // WCAG 2.4.7 — focusable elements need a visible focus indicator.
    // The IconButton inherits the app's 2px brand-blue ring via
    // focus-visible:outline-2 focus-visible:outline-[...]. Assert the
    // class is on the element so a refactor can't silently drop it.
    mounted = mount(
      <IconButton aria-label="Menu">
        <TestIcon />
      </IconButton>
    );
    const btn = mounted.container.querySelector('button')!;
    expect(btn.className).toContain('focus-visible:outline-2');
  });
});
