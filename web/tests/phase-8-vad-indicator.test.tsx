/**
 * Phase 8 — VadIndicator.
 *
 * Locks the colour + label mapping between the web recording state
 * machine and the iOS `VADIndicatorView`. We assert on the `aria-label`
 * (which encodes the human-readable state) rather than computed styles
 * — jsdom isn't a real renderer, and the label is the a11y contract
 * we've committed to.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Lucide icons are mocked per the pattern in phase-3-alerts-bell —
// avoids the React-dual-copy issue when the icon lib resolves React
// from the monorepo root instead of the web workspace copy. VadIndicator
// doesn't USE lucide directly (we render a span), so this is defensive
// for future icon additions.
vi.mock('lucide-react', () => ({}));

import { VadIndicator } from '@/components/recording/vad-indicator';

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
    const toUnmount = mounted;
    act(() => {
      toUnmount.root.unmount();
    });
    toUnmount.container.remove();
    mounted = null;
  }
});

describe('VadIndicator', () => {
  it('renders Active when the recording state is active', () => {
    mounted = mount(<VadIndicator state="active" />);
    const status = mounted.container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-label')).toBe('VAD Active');
    expect(status?.textContent).toMatch(/Active/i);
  });

  it('renders Sleeping during the sleeping state', () => {
    mounted = mount(<VadIndicator state="sleeping" />);
    const status = mounted.container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('VAD Sleeping');
  });

  it('renders Idle when not actively recording', () => {
    mounted = mount(<VadIndicator state="idle" />);
    const status = mounted.container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('VAD Idle');
  });

  it('renders Error when the state machine has failed', () => {
    mounted = mount(<VadIndicator state="error" />);
    const status = mounted.container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('VAD Error');
  });
});
