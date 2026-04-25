/**
 * Phase 1 — TallyBadge primitive.
 *
 * Asserts:
 *   1. Renders the numeric count as tabular-nums text.
 *   2. Composes aria-label from count + label for screen readers.
 *   3. Variant maps to the severity token (colour assertion via inline
 *      style — jsdom doesn't compute CSS variables so asserting on
 *      CSS vars wouldn't add anything).
 *   4. Omitting `label` still produces an accessible pure-count badge.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TallyBadge } from '@/components/ui/tally-badge';

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

describe('TallyBadge', () => {
  it('renders count + label with composed aria-label', () => {
    mounted = mount(<TallyBadge count={3} label="C1" variant="destructive" />);
    const pill = mounted.container.querySelector('span');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('aria-label')).toBe('3 C1');
    expect(pill!.textContent).toContain('3');
    expect(pill!.textContent).toContain('C1');
  });

  it('omits the label when only a count is provided (Alerts bell variant)', () => {
    mounted = mount(<TallyBadge count={12} variant="info" />);
    const pill = mounted.container.querySelector('span')!;
    expect(pill.getAttribute('aria-label')).toBe('12');
    expect(pill.textContent).toBe('12');
  });

  it.each([
    ['destructive', 'var(--color-severity-c1)'],
    ['warn', 'var(--color-severity-c2)'],
    ['info', 'var(--color-severity-c3)'],
    ['muted', 'var(--color-severity-fi)'],
    ['success', 'var(--color-severity-ok)'],
  ] as const)('variant=%s paints the %s token', (variant, token) => {
    mounted = mount(<TallyBadge count={1} variant={variant} />);
    const pill = mounted.container.querySelector('span')!;
    expect(pill.style.color).toBe(token);
  });

  it('defaults to the info variant', () => {
    mounted = mount(<TallyBadge count={1} />);
    const pill = mounted.container.querySelector('span')!;
    expect(pill.style.color).toBe('var(--color-severity-c3)');
  });
});
