import { describe, it, expect } from 'vitest';
import { resolveUplinkURLConfig } from '@/lib/recording/uplink-url-config';

describe('resolveUplinkURLConfig (PLAN-E1 E0 test seam)', () => {
  it('nova-3 ALWAYS forces linear16 regardless of the latched codec (safety invariant)', () => {
    const withOpusLatched = resolveUplinkURLConfig({
      model: 'nova3',
      latchedCodec: 'opus',
      ccuAnalysis: null,
    });
    expect(withOpusLatched.resolvedSenderCodec).toBe('linear16');
    expect(withOpusLatched.url).toContain('encoding=linear16');
    expect(withOpusLatched.url).not.toContain('encoding=opus');
  });

  it('flux with a null latch (old backend / first fetch pending) defaults to linear16', () => {
    const result = resolveUplinkURLConfig({ model: 'flux', latchedCodec: null, ccuAnalysis: null });
    expect(result.resolvedSenderCodec).toBe('linear16');
  });

  it('PLAN-E1B2 item 1 (disabled outcome) — flux with a latched opus codec still resolves to linear16', () => {
    // A live probe against the real WebCodecs AudioEncoder found the
    // packet-to-source-sample mapping is not determinable for the
    // genuinely reachable production input space (short-tail flush inputs
    // are not guaranteed multiples of the encoder's 320-sample internal
    // frame size) — see scripts/deepgram-webcodecs-opus-packet-probe.mjs
    // and PLAN-E1B2-final.md item 1's outcome matrix. Web Opus therefore
    // stays disabled unconditionally, regardless of what the backend/latch
    // claims.
    const result = resolveUplinkURLConfig({
      model: 'flux',
      latchedCodec: 'opus',
      ccuAnalysis: null,
    });
    expect(result.resolvedSenderCodec).toBe('linear16');
    expect(result.url).toContain('encoding=linear16');
    expect(result.url).not.toContain('encoding=opus');
  });

  it('keepalive policy: nova-3 enables the silence keepalive, flux disables it — for every codec', () => {
    const matrix = [
      { model: 'nova3' as const, latchedCodec: 'linear16' as const },
      { model: 'nova3' as const, latchedCodec: 'opus' as const },
      { model: 'flux' as const, latchedCodec: 'linear16' as const },
      { model: 'flux' as const, latchedCodec: 'opus' as const },
    ];
    for (const { model, latchedCodec } of matrix) {
      const result = resolveUplinkURLConfig({ model, latchedCodec, ccuAnalysis: null });
      expect(result.keepalivePolicy).toBe(
        model === 'nova3' ? 'nova3-silence-linear16' : 'disabled'
      );
    }
  });

  // Test 3c — URL invariants: mip_opt_out=true survives on EVERY constructed
  // URL, across the full {flux,nova3} x {linear16,opus} matrix.
  it('every constructed URL retains mip_opt_out=true (GDPR/DPIA M2.1)', () => {
    for (const model of ['nova3', 'flux'] as const) {
      for (const latchedCodec of ['linear16', 'opus'] as const) {
        const { url } = resolveUplinkURLConfig({ model, latchedCodec, ccuAnalysis: null });
        expect(url).toContain('mip_opt_out=true');
      }
    }
  });

  it('nova-3 URL keeps the legacy /v1/listen path and params unchanged from pre-E1 shape', () => {
    const { url } = resolveUplinkURLConfig({
      model: 'nova3',
      latchedCodec: null,
      ccuAnalysis: null,
    });
    expect(url).toMatch(/^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
    expect(url).toContain('model=nova-3');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('interim_results=true');
  });

  it('flux URL uses /v2/listen and the flux-general-en model', () => {
    const { url } = resolveUplinkURLConfig({
      model: 'flux',
      latchedCodec: null,
      ccuAnalysis: null,
    });
    expect(url).toMatch(/^wss:\/\/api\.deepgram\.com\/v2\/listen\?/);
    expect(url).toContain('model=flux-general-en');
  });

  // Test 3b — keyterm-budget invariance: the appended keyterm list must be
  // BYTE-IDENTICAL across every codec route a model supports, for the SAME
  // ccuAnalysis input.
  it('3b: nova-3 keyterm list is identical across every supported codec route', () => {
    const ccuAnalysis = {
      manufacturer: 'Wylex',
      circuits: [{ label: 'Upstairs lighting' }, { label: 'Downstairs sockets' }],
    } as any;
    const linear16 = resolveUplinkURLConfig({
      model: 'nova3',
      latchedCodec: 'linear16',
      ccuAnalysis,
    });
    const opusForced = resolveUplinkURLConfig({
      model: 'nova3',
      latchedCodec: 'opus',
      ccuAnalysis,
    });
    const keytermsOf = (url: string) => new URLSearchParams(url.split('?')[1]).getAll('keyterm');
    expect(keytermsOf(linear16.url)).toEqual(keytermsOf(opusForced.url));
  });

  it('3b: flux keyterm list is identical across linear16 and opus routes', () => {
    const ccuAnalysis = {
      manufacturer: 'Hager',
      circuits: [{ label: 'Kitchen ring' }, { label: 'Immersion heater' }],
    } as any;
    const linear16 = resolveUplinkURLConfig({
      model: 'flux',
      latchedCodec: 'linear16',
      ccuAnalysis,
    });
    const opus = resolveUplinkURLConfig({ model: 'flux', latchedCodec: 'opus', ccuAnalysis });
    const keytermsOf = (url: string) => new URLSearchParams(url.split('?')[1]).getAll('keyterm');
    expect(keytermsOf(linear16.url)).toEqual(keytermsOf(opus.url));
    expect(keytermsOf(linear16.url).length).toBeGreaterThan(0);
  });

  it('3b: every constructed URL stays within its model URL-length budget', () => {
    // A large synthetic CCU analysis to exercise the truncation path.
    const manyCircuits = Array.from({ length: 60 }, (_, i) => ({
      label: `Circuit ${i} — a moderately long descriptive label`,
    }));
    const ccuAnalysis = { manufacturer: 'Wylex', circuits: manyCircuits } as any;
    for (const model of ['nova3', 'flux'] as const) {
      for (const latchedCodec of ['linear16', 'opus'] as const) {
        const { url } = resolveUplinkURLConfig({ model, latchedCodec, ccuAnalysis });
        const budget = model === 'flux' ? 2000 : 1800;
        expect(url.length).toBeLessThanOrEqual(budget);
      }
    }
  });
});
