/**
 * Harness leak-lock (added 2026-07-03 test-harness hardening).
 *
 * This is a REGRESSION GUARD for the global cleanup configured in
 * `vitest.config.ts` (restoreMocks/clearMocks/unstubGlobals/unstubEnvs)
 * and the fake-timer afterEach in `tests/setup.ts`. It deliberately
 * pollutes shared state in the first test, then asserts in the SECOND
 * test that every kind of pollution was auto-reverted between tests —
 * WITHOUT any manual restore. If someone drops one of those flags, or
 * the setup.ts `vi.useRealTimers()` afterEach, one of the assertions
 * below fails and points straight at the regression.
 *
 * The two tests MUST stay in this order — test order within a file is
 * definition order, and the second test is the one that observes the
 * first test's cleanup.
 */
import { describe, it, expect, vi } from 'vitest';

// Shared across tests so we can observe cross-test spy restoration.
const target = {
  value(): string {
    return 'real';
  },
};

describe('harness leak-lock — global cleanup reverts cross-test pollution', () => {
  it('pollutes: installs fake timers, stubs a global + env, and a spy', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);

    vi.stubGlobal('__leakProbe__', 'polluted');
    expect((globalThis as Record<string, unknown>).__leakProbe__).toBe('polluted');

    vi.stubEnv('__LEAK_ENV__', 'polluted');
    expect(process.env.__LEAK_ENV__).toBe('polluted');

    vi.spyOn(target, 'value').mockReturnValue('spied');
    expect(target.value()).toBe('spied');
    // Intentionally NO manual cleanup — the global config must do it.
  });

  it('is clean: fake timers, stubbed global/env, and spy all auto-reverted', () => {
    // restoreMocks → the spy is back to the original implementation.
    expect(target.value()).toBe('real');
    // setup.ts afterEach(vi.useRealTimers()) → real timers restored.
    expect(vi.isFakeTimers()).toBe(false);
    // unstubGlobals → the stubbed global is gone.
    expect((globalThis as Record<string, unknown>).__leakProbe__).toBeUndefined();
    // unstubEnvs → the stubbed env var is gone.
    expect(process.env.__LEAK_ENV__).toBeUndefined();
  });
});
