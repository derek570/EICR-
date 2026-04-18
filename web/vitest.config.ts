import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest config — Wave 2 regression harness + Wave 3a integration tests.
 *
 * Environment notes:
 *   - `jsdom` gives us a `window`, `document`, `fetch` polyfills for the
 *     React Testing Library and a usable `Response` for api-client tests.
 *   - `tests/setup.ts` wires `@testing-library/jest-dom`'s matchers and
 *     loads `fake-indexeddb/auto` so the PWA outbox + job-cache tests run
 *     without a browser IDB.
 *   - The alias `@` mirrors `tsconfig.json`'s `paths` so test imports
 *     match source imports one-for-one (no test-only import paths).
 *
 * React-instance pin (added in Wave 3a):
 *   The monorepo root hoists a slightly older React patch (19.2.3 via
 *   `@dnd-kit/utilities`) while `web` declares 19.2.4. Product code and
 *   Vite-transformed test files always go through Vite's resolver, so
 *   they pick up the web-local copy. But any CJS dep loaded via Node's
 *   bare-require resolution (e.g. `@testing-library/react`'s dist
 *   bundle at the workspace root) picks up the ROOT copy. Two React
 *   instances → dispatcher is installed on one but read from the other
 *   → every `useRef`/`useEffect` throws "Invalid hook call".
 *
 *   The `alias` regex forces every `react` + `react-dom` import
 *   (including deep paths like `react/jsx-dev-runtime`) to resolve to
 *   this workspace's copy. The integration tests sidestep
 *   `@testing-library/react` entirely by mounting via `createRoot` so
 *   the pin only needs to apply to code going through Vite — which is
 *   what `resolve.alias` covers.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      {
        find: /^react(\/.*)?$/,
        replacement: path.resolve(__dirname, 'node_modules/react') + '$1',
      },
      {
        find: /^react-dom(\/.*)?$/,
        replacement: path.resolve(__dirname, 'node_modules/react-dom') + '$1',
      },
    ],
    dedupe: ['react', 'react-dom'],
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
