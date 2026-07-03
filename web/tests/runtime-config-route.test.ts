/**
 * Runtime STT kill-switch — `/runtime-config` route tests (parity WS4).
 *
 * Proves the route reads `DEEPGRAM_STT_MODEL` from `process.env` at REQUEST
 * time (so a runtime ECS env flip takes effect with NO bundle rebuild),
 * serves `no-store`, and exports `force-dynamic`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GET, dynamic } from '@/app/runtime-config/route';

const ORIGINAL = process.env.DEEPGRAM_STT_MODEL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEEPGRAM_STT_MODEL;
  else process.env.DEEPGRAM_STT_MODEL = ORIGINAL;
});

describe('/runtime-config route', () => {
  it('is force-dynamic (never a build-time snapshot)', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('serves the raw env value as { sttModel } with no-store', async () => {
    process.env.DEEPGRAM_STT_MODEL = 'nova3';
    const res = GET();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.json();
    expect(body).toEqual({ sttModel: 'nova3' });
  });

  it('returns { sttModel: null } when the env var is unset', async () => {
    delete process.env.DEEPGRAM_STT_MODEL;
    const body = await GET().json();
    expect(body).toEqual({ sttModel: null });
  });

  it('production-shape no-rebuild proof: a runtime env change flips the served value', async () => {
    // Same module instance (i.e. same "build"); only the runtime env changes.
    process.env.DEEPGRAM_STT_MODEL = 'nova3';
    expect(await GET().json()).toEqual({ sttModel: 'nova3' });
    // Operator re-registers the task def with flux — no code rebuild.
    process.env.DEEPGRAM_STT_MODEL = 'flux';
    expect(await GET().json()).toEqual({ sttModel: 'flux' });
    // And the client resolver would select the Flux builder off this value —
    // asserted in runtime-config.test.ts (production-shape no-rebuild test).
  });
});
