import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest config — Wave 2 regression harness.
 *
 * Environment notes:
 *   - `jsdom` gives us a `window`, `document`, `fetch` polyfills for the
 *     React Testing Library and a usable `Response` for api-client tests.
 *   - `tests/setup.ts` wires `@testing-library/jest-dom`'s matchers and
 *     loads `fake-indexeddb/auto` so the PWA outbox + job-cache tests run
 *     without a browser IDB.
 *   - The alias `@` mirrors `tsconfig.json`'s `paths` so test imports
 *     match source imports one-for-one (no test-only import paths).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Keep the run short-running so pre-push doesn't drag. Any test
    // over 5s is almost certainly a hung async or a real-timer
    // oversight — fail loud instead of silently waiting.
    testTimeout: 5_000,
  },
});
