/**
 * Runtime STT kill-switch — client accessor tests (parity WS4).
 *
 * Covers the full resolution matrix + the fail-safe split (DEFAULT vs SAFE):
 *   runtime 'flux'                     → flux
 *   runtime 'nova3'                    → nova3
 *   spelling variants (nova-3/Nova3/…) → nova3
 *   MISSING env                        → DEFAULT_STT_MODEL (assert the constant)
 *   unrecognised non-empty             → SAFE_STT_MODEL + diagnostic
 *   fetch failure                      → SAFE_STT_MODEL + diagnostic
 *   non-JSON (login-redirect) body     → SAFE_STT_MODEL + diagnostic
 *   force re-fetch picks up an ECS flip without a rebuild
 * plus: the fetch path is `/runtime-config` (NOT under `/api/*`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveSttModel,
  ensureRuntimeConfigLoaded,
  DEFAULT_STT_MODEL,
  SAFE_STT_MODEL,
  RUNTIME_CONFIG_PATH,
  __resetRuntimeConfigCacheForTests,
} from '@/lib/runtime-config';

const originalFetch = globalThis.fetch;

function stubFetch(
  impl: (url: string) => { ok: boolean; status?: number; json?: () => Promise<unknown> }
) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const r = impl(String(url));
    return Promise.resolve({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: r.json ?? (() => Promise.resolve({})),
    });
  }) as unknown as typeof fetch;
}

describe('resolveSttModel — pure resolution matrix', () => {
  it('resolves flux', () => expect(resolveSttModel('flux')).toBe('flux'));
  it('resolves nova3', () => expect(resolveSttModel('nova3')).toBe('nova3'));
  it('resolves spelling variants to nova3', () => {
    for (const v of ['nova-3', 'Nova3', 'nova_3', 'NOVA 3', ' Nova-3 ']) {
      expect(resolveSttModel(v)).toBe('nova3');
    }
  });
  it('resolves Flux casing variants to flux', () => {
    for (const v of ['Flux', 'FLUX', ' flux ']) expect(resolveSttModel(v)).toBe('flux');
  });
  it('MISSING env → DEFAULT_STT_MODEL (assert the constant, not a hardcoded model)', () => {
    expect(resolveSttModel(null)).toBe(DEFAULT_STT_MODEL);
    expect(resolveSttModel(undefined)).toBe(DEFAULT_STT_MODEL);
    expect(resolveSttModel('')).toBe(DEFAULT_STT_MODEL);
    expect(resolveSttModel('   ')).toBe(DEFAULT_STT_MODEL);
  });
  it('unrecognised non-empty → SAFE_STT_MODEL + loud diagnostic naming the raw value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveSttModel('whisper')).toBe(SAFE_STT_MODEL);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('whisper'));
    spy.mockRestore();
  });
});

describe('ensureRuntimeConfigLoaded — fetch + fail-safe', () => {
  beforeEach(() => {
    __resetRuntimeConfigCacheForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches /runtime-config (NOT under /api/*) with cache:no-store', async () => {
    let seenUrl = '';
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      seenUrl = String(url);
      expect(init?.cache).toBe('no-store');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sttModel: 'nova3' }),
      });
    }) as unknown as typeof fetch;
    await ensureRuntimeConfigLoaded({ force: true });
    expect(seenUrl).toBe(RUNTIME_CONFIG_PATH);
    expect(RUNTIME_CONFIG_PATH).toBe('/runtime-config');
    expect(seenUrl.startsWith('/api/')).toBe(false);
  });

  it('runtime flux → flux', async () => {
    stubFetch(() => ({ ok: true, json: () => Promise.resolve({ sttModel: 'flux' }) }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe('flux');
  });

  it('runtime nova3 → nova3', async () => {
    stubFetch(() => ({ ok: true, json: () => Promise.resolve({ sttModel: 'nova3' }) }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe('nova3');
  });

  it('MISSING env (route returns sttModel:null) → DEFAULT_STT_MODEL', async () => {
    stubFetch(() => ({ ok: true, json: () => Promise.resolve({ sttModel: null }) }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe(DEFAULT_STT_MODEL);
  });

  it('unrecognised non-empty env → SAFE_STT_MODEL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => ({ ok: true, json: () => Promise.resolve({ sttModel: 'banana' }) }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe(SAFE_STT_MODEL);
  });

  it('fetch failure → SAFE_STT_MODEL + diagnostic', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe(SAFE_STT_MODEL);
    expect(spy).toHaveBeenCalled();
  });

  it('non-JSON body (login-redirect HTML) → SAFE_STT_MODEL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }) as unknown as typeof fetch;
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe(SAFE_STT_MODEL);
  });

  it('non-200 status → SAFE_STT_MODEL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(() => ({ ok: false, status: 404 }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe(SAFE_STT_MODEL);
  });

  it('force:true re-fetches so an ECS env flip is picked up without a rebuild', async () => {
    let current = 'nova3';
    stubFetch(() => ({ ok: true, json: () => Promise.resolve({ sttModel: current }) }));
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe('nova3');
    // Operator flips the ECS env var — no code rebuild.
    current = 'flux';
    expect(await ensureRuntimeConfigLoaded({ force: true })).toBe('flux');
  });

  it('without force, returns the cached value (one fetch per recording session)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sttModel: 'nova3' }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await ensureRuntimeConfigLoaded({ force: true });
    await ensureRuntimeConfigLoaded(); // no force → cached, no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
