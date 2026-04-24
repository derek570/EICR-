/**
 * Phase 8 — LiveField flash regression.
 *
 * Phase 5d shipped the brand-blue flash that fades when Sonnet fills a
 * field. Phase 8 verifies it still fires after markUpdated() and the
 * mechanism is orientation-agnostic (data-recent attribute → CSS
 * transition, so portrait vs landscape is handled by the same selector).
 *
 * We assert at the data-attribute layer rather than trying to read
 * computed styles — jsdom isn't a real renderer, but the attribute is
 * the single source of truth the CSS rule targets.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => ({}));

import { LiveField } from '@/components/live-fill/live-field';
import { liveFillStore } from '@/lib/recording/live-fill-state';

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
  liveFillStore.reset();
});

afterEach(() => {
  if (mounted) {
    const toUnmount = mounted;
    act(() => {
      toUnmount.root.unmount();
    });
    toUnmount.container.remove();
    mounted = null;
  }
  liveFillStore.reset();
});

describe('LiveField flash', () => {
  it('starts with data-recent="false" at rest', () => {
    mounted = mount(<LiveField fieldKey="supply.ze" label="Ze" value="0.35" />);
    const cell = mounted.container.querySelector('.cm-live-field');
    expect(cell?.getAttribute('data-recent')).toBe('false');
  });

  it('flips to data-recent="true" when the store marks the key fresh', () => {
    mounted = mount(<LiveField fieldKey="supply.ze" label="Ze" value="0.35" />);
    act(() => {
      liveFillStore.markUpdated(['supply.ze']);
    });
    const cell = mounted.container.querySelector('.cm-live-field');
    expect(cell?.getAttribute('data-recent')).toBe('true');
  });

  it('ignores updates to unrelated keys', () => {
    mounted = mount(<LiveField fieldKey="supply.ze" label="Ze" value="0.35" />);
    act(() => {
      liveFillStore.markUpdated(['supply.pfc']);
    });
    const cell = mounted.container.querySelector('.cm-live-field');
    expect(cell?.getAttribute('data-recent')).toBe('false');
  });
});
