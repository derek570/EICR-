import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';

/**
 * Wave 2 D12 regression: ApiError carries the parsed JSON body and a
 * human-friendly message.
 *
 * The old `request()` set `ApiError.message = await res.text()`. For any
 * backend route that returned `{error: "..."}` (which is every route in
 * `src/routes/*.js`), the error toast would show `{"error":"Unauthorised"}`
 * literally. D12 parses the envelope, lifts `error` to `.message`, and
 * stashes the full parsed shape on `.body` for callers that want the
 * structured fields.
 *
 * These tests stub `global.fetch`; no MSW needed for such a narrow surface.
 */

interface StubResponseInit {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  _body?: unknown;
}

function fetchStub(responses: Array<StubResponseInit>): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(makeResponse(next));
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Build a `Response`-shaped object that satisfies the narrow subset of
 * the Fetch API `api-client.ts` actually reads (`status`, `ok`,
 * `statusText`, `headers.get('content-type')`, `json()`, `text()`,
 * `blob()`). Using a real `Response` constructor pulls in `Headers`,
 * `Blob`, and the global init-guard which is more than these tests need.
 */
function makeResponse(init: StubResponseInit): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? '';
  const headerEntries = new Map<string, string>();
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    headerEntries.set(k.toLowerCase(), v);
  }
  const contentType = headerEntries.get('content-type') ?? '';
  return {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string) {
        return headerEntries.get(name.toLowerCase()) ?? null;
      },
    } as Headers,
    async json() {
      return typeof init._body === 'string' ? JSON.parse(init._body) : init._body;
    },
    async text() {
      if (typeof init._body === 'string') return init._body;
      if (contentType.includes('application/json')) return JSON.stringify(init._body ?? '');
      return String(init._body ?? '');
    },
    async blob() {
      return new Blob([String(init._body ?? '')]);
    },
  } as unknown as Response;
}

beforeEach(() => {
  // Clean auth state between tests — getToken() reads localStorage.
  // jsdom's localStorage is sometimes missing the .clear() method in
  // the vitest 4 harness, so try/catch the call.
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear();
    }
  } catch {
    // No localStorage in this env — auth tests that depend on it
    // will stub `getToken` directly rather than relying on the store.
  }
});

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe('ApiError — D12 JSON envelope parsing', () => {
  it('lifts backend {error: "..."} into ApiError.message', async () => {
    restoreFetch = fetchStub([
      {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
        _body: { error: 'Email is required' },
      },
    ]);
    await expect(api.me()).rejects.toMatchObject({
      status: 400,
      message: 'Email is required',
      // Full parsed object preserved on `.body` so callers can reach past
      // the friendly message for structured fields.
      body: { error: 'Email is required' },
    });
  });

  it('keeps structured body even when `error` field is missing', async () => {
    restoreFetch = fetchStub([
      {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: { 'content-type': 'application/json' },
        _body: { code: 'VALIDATION', fields: { email: 'invalid' } },
      },
    ]);
    try {
      await api.me();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      // No `error` field → fall back to statusText for the message, but
      // the structured body still comes through for advanced callers.
      expect((err as ApiError).message).toBe('Unprocessable Entity');
      expect((err as ApiError).body).toEqual({ code: 'VALIDATION', fields: { email: 'invalid' } });
    }
  });

  it('falls through to text() for non-JSON error bodies', async () => {
    restoreFetch = fetchStub([
      {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/html' },
        _body: '<html>Nope</html>',
      },
    ]);
    try {
      await api.me();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).message).toBe('<html>Nope</html>');
      expect((err as ApiError).body).toBe('<html>Nope</html>');
    }
  });

  it('401 classifies by status, not message text — protects 7b layout redirects', async () => {
    // The pre-D12 dashboard/job-layout used `/401/.test(err.message)` which
    // would have MATCHED the body `{"error":"401 expired"}` and MISSED the
    // body `{"error":"Unauthorised"}`. Post-D12 callers branch on
    // `.status` so message content is irrelevant.
    restoreFetch = fetchStub([
      {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
        _body: { error: 'Unauthorised' },
      },
    ]);
    try {
      await api.me();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      // Message is friendly, no literal "401" in it — proves the old
      // regex would have bounced right past this response.
      expect((err as ApiError).message).toBe('Unauthorised');
      expect(/401/.test((err as ApiError).message)).toBe(false);
    }
  });
});

describe('saveJob (P0-1)', () => {
  it('uses PUT verb — backend has no PATCH route', async () => {
    const spy = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        _body: { success: true },
      })
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await api.saveJob('u1', 'j1', { address: '1 Test St' });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, init] = spy.mock.calls[0];
      expect(init.method).toBe('PUT');
      // Partial body — only dirty fields — per saveJob contract.
      expect(JSON.parse(init.body)).toEqual({ address: '1 Test St' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
