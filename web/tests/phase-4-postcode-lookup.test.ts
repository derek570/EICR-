/**
 * Phase 4 — postcode autocomplete hook.
 *
 * Locks two things:
 *   1. `normalisePostcode` rejects obvious garbage and canonicalises
 *      valid UK postcodes to the "AA1 1AA" form.
 *   2. `usePostcodeLookup` debounces and memos — a burst of keystrokes
 *      only fires ONE lookup, and re-typing the same postcode after
 *      the first resolution is a no-op.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalisePostcode, usePostcodeLookup } from '@/hooks/use-postcode-lookup';

describe('normalisePostcode', () => {
  it('uppercases + single-spaces before the last 3 chars', () => {
    expect(normalisePostcode('sw1a1aa')).toBe('SW1A 1AA');
    expect(normalisePostcode('SW1A 1AA')).toBe('SW1A 1AA');
    expect(normalisePostcode('  sw1a  1aa  ')).toBe('SW1A 1AA');
    expect(normalisePostcode('rg304xw')).toBe('RG30 4XW');
  });

  it('returns null for non-postcodes', () => {
    expect(normalisePostcode('')).toBeNull();
    expect(normalisePostcode('not a postcode')).toBeNull();
    expect(normalisePostcode('123')).toBeNull();
    // 10-char string fails the upper bound but still contains a postcode
    expect(normalisePostcode('sw1a 1aa extra')).toBeNull();
  });
});

/**
 * Tiny test harness — mount a hook-using component, capture the latest
 * `onChange` in a ref so the test can drive it directly.
 */
function mountHook(options: {
  onResolved: (r: { postcode: string; town: string; county: string }) => void;
  lookup: (p: string) => Promise<{ postcode: string; town: string; county: string } | null>;
  delay?: number;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // A closed-over mutable holder for the latest hook return, assigned
  // inside a commit effect so the react-compiler's immutability rule
  // doesn't flag render-phase mutation.
  let latestOnChange: ((raw: string) => void) | null = null;

  function Harness() {
    const api = usePostcodeLookup({
      onResolved: options.onResolved,
      lookup: options.lookup,
      delay: options.delay ?? 50,
    });
    React.useEffect(() => {
      latestOnChange = api.onChange;
    });
    return null;
  }

  act(() => {
    root.render(React.createElement(Harness));
  });

  return {
    container,
    root,
    trigger: (raw: string) => {
      latestOnChange!(raw);
    },
  };
}

let mounted: { container: HTMLElement; root: Root; trigger: (raw: string) => void } | null = null;

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

describe('usePostcodeLookup', () => {
  it('debounces rapid keystrokes into a single lookup', async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    const lookup = vi.fn().mockResolvedValue({
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
    });

    mounted = mountHook({ onResolved, lookup, delay: 50 });
    mounted.trigger('sw1a');
    mounted.trigger('sw1a 1');
    mounted.trigger('sw1a 1a');
    mounted.trigger('sw1a 1aa');

    // No lookup fires before the debounce window.
    expect(lookup).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(60);
      // Flush the `await lookupRef.current(...)` microtask.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('SW1A 1AA');
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
    });
    vi.useRealTimers();
  });

  it('memoises by canonical postcode — same value re-typed does not re-fire', async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    const lookup = vi.fn().mockResolvedValue({
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
    });

    mounted = mountHook({ onResolved, lookup, delay: 20 });
    mounted.trigger('sw1a 1aa');
    await act(async () => {
      vi.advanceTimersByTime(30);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lookup).toHaveBeenCalledTimes(1);

    // Re-typing the same canonical postcode — should NOT fire again.
    mounted.trigger('sw1a1aa');
    await act(async () => {
      vi.advanceTimersByTime(30);
      await Promise.resolve();
    });
    expect(lookup).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('ignores obviously invalid input without firing the lookup', async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    const lookup = vi.fn();
    mounted = mountHook({ onResolved, lookup, delay: 20 });

    mounted.trigger('not a postcode');
    mounted.trigger('xyz');
    await act(async () => {
      vi.advanceTimersByTime(30);
      await Promise.resolve();
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels a pending lookup when the input is corrupted mid-debounce', async () => {
    // Regression guard for the Phase 4 post-codex fix: if the user
    // types a valid postcode, then backspaces it into an invalid form
    // before the debounce window elapses, the stale lookup must NOT
    // fire — otherwise it would repopulate town/county from the old
    // postcode even though the field now shows different text.
    vi.useFakeTimers();
    const onResolved = vi.fn();
    const lookup = vi.fn().mockResolvedValue({
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
    });

    mounted = mountHook({ onResolved, lookup, delay: 50 });
    mounted.trigger('sw1a 1aa');
    // Before the debounce elapses, user backspaces into invalid.
    mounted.trigger('sw1a 1');
    await act(async () => {
      vi.advanceTimersByTime(80);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
