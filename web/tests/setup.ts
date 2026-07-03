/**
 * Vitest setup — runs once before the test files.
 *
 * Responsibilities:
 *   - Register `@testing-library/jest-dom` matchers on vitest's expect.
 *     We wire these up via `expect.extend(matchers)` rather than the
 *     shorthand `import '@testing-library/jest-dom/vitest'` because the
 *     shorthand module imports `vitest` via bare-specifier lookup, and
 *     npm hoists jest-dom to the workspace-root `node_modules` where
 *     `vitest` is NOT installed (it only lives in `web/node_modules`).
 *     Doing the extension here means the import graph is
 *     vitest(web) → setup(web) → jest-dom/matchers, none of which need
 *     jest-dom to resolve vitest from its own nesting.
 *   - Load `fake-indexeddb/auto` which installs `indexedDB`,
 *     `IDBKeyRange`, and friends on `globalThis`. The PWA outbox and
 *     job-cache helpers (`web/src/lib/pwa/*`) use the bare `indexedDB`
 *     global, so a side-effect import is enough — no per-test install /
 *     reset needed beyond the per-test `deleteDB` calls we already do.
 */
import * as matchers from '@testing-library/jest-dom/matchers';
import { afterEach, expect, vi } from 'vitest';
expect.extend(matchers);
import 'fake-indexeddb/auto';

/**
 * Global fake-timer safety net (added 2026-07-03 test-harness hardening).
 *
 * vitest's `restoreMocks`/`clearMocks`/`unstubGlobals`/`unstubEnvs`
 * (see vitest.config.ts) clean spies, stubbed globals and env, but they
 * do NOT restore fake timers. A test that calls `vi.useFakeTimers()`
 * without a matching `vi.useRealTimers()` would leave fake timers
 * installed for every subsequent test in the same file/worker — an
 * order-dependent leak. Restoring real timers after every test closes
 * that gap once, centrally, instead of per-file.
 */
afterEach(() => {
  vi.useRealTimers();
});

/**
 * jsdom 29 under vitest 4 ships a `Storage` prototype that is installed
 * on `window` but whose methods (`getItem`, `setItem`, etc.) aren't
 * reliably available as own or inherited properties on the `localStorage`
 * / `sessionStorage` instances — accessing `localStorage.getItem` throws
 * `TypeError: localStorage.getItem is not a function` in our harness.
 *
 * Rather than chase the jsdom internals, replace both stores with a
 * plain in-memory map implementation that satisfies the Storage
 * interface contract that `src/lib/auth.ts` relies on. This is only
 * wired up when the real thing is broken, so tests that explicitly
 * manipulate `localStorage` (e.g. auth tests that seed a token) keep
 * working without test-by-test shims.
 */
function installStorageShim(name: 'localStorage' | 'sessionStorage'): void {
  // Install UNCONDITIONALLY. jsdom's real Storage object can appear to work
  // (`getItem` exists, so an earlier `hasWorkingGetItem` guard skipped the
  // shim) while still IGNORING per-instance method overrides like
  // `window.localStorage.setItem = () => { throw }`. Several tests intentionally
  // replace setItem/removeItem to simulate quota / privacy-mode failures; on CI
  // (a jsdom/Node build where the real Storage survived the guard) those
  // overrides were silently no-ops, so persist-failure tests saw the write
  // succeed and failed order-dependently. Locally the guard installed the shim
  // and the tests passed — hence CI-only. Always installing the writable
  // Map-backed shim makes override behaviour deterministic across Node/jsdom
  // versions and CI workers.
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, name, {
    value: shim,
    writable: true,
    configurable: true,
  });
}
installStorageShim('localStorage');
installStorageShim('sessionStorage');
