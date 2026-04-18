/**
 * MSW v2 node server — shared factory for integration tests.
 *
 * Wave 3a introduces MSW to drive the outbox replay path through the
 * real `api.saveJob` fetch surface. We opt for a per-file setup (each
 * test file calls `createTestServer()` in `beforeAll`) rather than a
 * global install in `tests/setup.ts` because:
 *
 *   1. The existing api-client.test.ts stubs `globalThis.fetch` directly
 *      — an always-on MSW server would either fight that stub or force
 *      an audit of every existing test to thread handlers through.
 *   2. Integration tests that actually want MSW can opt in locally and
 *      the other 52 Wave 2 regression tests stay on their current
 *      harness unchanged.
 *
 * The factory returns a `SetupServerApi` plus a convenience `beforeAll`/
 * `afterAll`/`afterEach` wire-up function so a test file can get a
 * ready-to-use server in two lines.
 *
 * `onUnhandledRequest: 'error'` — any request the replay worker fires
 * that we haven't explicitly stubbed is a regression (should never hit
 * the real network in a test). Failing loud is the whole point.
 *
 * Base URL: the api-client reads `NEXT_PUBLIC_API_URL`; in vitest that's
 * undefined so the client falls back to `http://localhost:3000`. We
 * export the same constant so handlers don't drift from the client.
 */

import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { HttpHandler } from 'msw';

export const TEST_API_BASE = 'http://localhost:3000';

export function createTestServer(initialHandlers: HttpHandler[] = []): SetupServer {
  const server = setupServer(...initialHandlers);
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterEach(() => {
    server.resetHandlers(...initialHandlers);
  });
  afterAll(() => {
    server.close();
  });
  return server;
}
