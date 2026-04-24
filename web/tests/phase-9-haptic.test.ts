/**
 * Phase 9 — haptic() helper tests.
 *
 * Covers the core contract of the Vibration-API wrapper:
 *   - Silent no-op when `navigator.vibrate` is undefined (iOS Safari,
 *     most desktop browsers).
 *   - Forwards the per-strength pattern to the browser when present.
 *   - Swallows browser exceptions so a buggy WebView can't take the
 *     caller down with it.
 *
 * Using vitest's `globalThis.navigator` shim rather than jsdom's
 * built-in so we can toggle `vibrate` between runs without tripping
 * jsdom's read-only Navigator proxy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { haptic } from '@/lib/haptic';

const realNavigator = globalThis.navigator;

function installNavigator(vibrate: unknown | undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: vibrate === undefined ? {} : { vibrate },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: realNavigator,
    configurable: true,
    writable: true,
  });
});

describe('haptic()', () => {
  it('no-ops when navigator.vibrate is undefined', () => {
    installNavigator(undefined);
    expect(haptic('light')).toBe(false);
  });

  it('no-ops when navigator.vibrate is not a function', () => {
    installNavigator('not-a-function');
    expect(haptic()).toBe(false);
  });

  it('forwards a numeric pattern for single-pulse strengths', () => {
    const vibrate = vi.fn(() => true);
    installNavigator(vibrate);
    expect(haptic('medium')).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(18);
  });

  it('forwards an array pattern for multi-pulse strengths', () => {
    const vibrate = vi.fn(() => true);
    installNavigator(vibrate);
    expect(haptic('success')).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([10, 40, 10]);
  });

  it('swallows thrown exceptions from the vibrate call', () => {
    const vibrate = vi.fn(() => {
      throw new Error('not allowed in this context');
    });
    installNavigator(vibrate);
    expect(() => haptic('heavy')).not.toThrow();
    expect(haptic('heavy')).toBe(false);
  });
});

describe('haptic() — SSR safety', () => {
  it('no-ops when navigator is undefined (SSR)', () => {
    const original = globalThis.navigator;
    // Simulate the server-side render environment where the helper
    // could be imported (via a "use client" file transitively loaded
    // during static generation). The wrapper must stay silent.
    // @ts-expect-error — intentional undefined for the SSR path
    delete (globalThis as { navigator?: Navigator }).navigator;
    try {
      expect(haptic('light')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});
