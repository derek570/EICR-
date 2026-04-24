/**
 * Phase 1 — SkeletonRow primitive.
 *
 * Why these tests: the shimmer animation and the `role="status"`
 * wrapper are the two contracts Phase 3+ loading states will lean on.
 * Both are trivial to regress silently with a className change — lock
 * them with DOM-level assertions.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SkeletonRow } from '@/components/ui/skeleton-row';

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

describe('SkeletonRow', () => {
  it('defaults to one shimmer bar inside a status-role wrapper', () => {
    mounted = mount(<SkeletonRow />);
    const wrapper = mounted.container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('role')).toBe('status');
    expect(wrapper.getAttribute('aria-busy')).toBe('true');
    expect(wrapper.getAttribute('aria-label')).toBe('Loading');
    expect(wrapper.querySelectorAll('span').length).toBe(1);
  });

  it('renders `lines` bars and narrows the trailing one for visual rhythm', () => {
    mounted = mount(<SkeletonRow lines={4} />);
    const bars = mounted.container.querySelectorAll('span');
    expect(bars.length).toBe(4);
    expect((bars[0] as HTMLElement).style.width).toBe('100%');
    expect((bars[bars.length - 1] as HTMLElement).style.width).toBe('70%');
  });

  it('clamps lines to a minimum of 1', () => {
    mounted = mount(<SkeletonRow lines={0} />);
    const bars = mounted.container.querySelectorAll('span');
    expect(bars.length).toBe(1);
  });

  it('each bar carries the cm-shimmer keyframe class', () => {
    mounted = mount(<SkeletonRow lines={2} />);
    const bars = mounted.container.querySelectorAll('span');
    for (const bar of Array.from(bars)) {
      expect(bar.className).toContain('cm-shimmer');
    }
  });

  it('overrides aria-label when provided', () => {
    mounted = mount(<SkeletonRow aria-label="Loading jobs" lines={2} />);
    const wrapper = mounted.container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-label')).toBe('Loading jobs');
  });
});
