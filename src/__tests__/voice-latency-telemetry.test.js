/**
 * Voice-latency telemetry — contract tests.
 *
 * Pins the module's public surface so Stage 2/3/4/5 emitters can build
 * against a stable interface. The module itself emits via logger.info;
 * we mock the logger and assert on the captured payloads.
 */

import { jest } from '@jest/globals';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../logger.js', () => ({ default: mockLogger }));

const tel = await import('../extraction/voice-latency-telemetry.js');

afterEach(() => {
  for (const fn of Object.values(mockLogger)) fn.mockClear();
});

describe('voice-latency-telemetry', () => {
  describe('mintCorrelationId', () => {
    test('returns a vl_<source>_<rand10> string', () => {
      const id = tel.mintCorrelationId('sess_1', 'confirmation');
      expect(id).toMatch(/^vl_confirmation_[0-9a-f]{10}$/);
    });

    test('throws when sessionId is missing', () => {
      expect(() => tel.mintCorrelationId(null, 'confirmation')).toThrow(/sessionId required/);
    });

    test('warns once per unknown source', () => {
      tel.mintCorrelationId('sess_x', 'totally_made_up_source');
      tel.mintCorrelationId('sess_y', 'totally_made_up_source');
      const warns = mockLogger.warn.mock.calls.filter(
        (c) => c[0] === 'voice_latency.unknown_source'
      );
      // Module dedupes across calls; the second time should not re-warn.
      expect(warns.length).toBe(1);
      expect(warns[0][1]).toEqual({ source: 'totally_made_up_source' });
    });

    test('known sources do not warn', () => {
      for (const source of [
        'confirmation',
        'correction',
        'question',
        'notification',
        'fast_path',
        'ask_user_stream',
      ]) {
        tel.mintCorrelationId('sess', source);
      }
      const warns = mockLogger.warn.mock.calls.filter(
        (c) => c[0] === 'voice_latency.unknown_source'
      );
      expect(warns.length).toBe(0);
    });
  });

  describe('recordSpan', () => {
    test('logs a span with duration_ms', () => {
      const cid = 'vl_confirmation_abc';
      const start = process.hrtime.bigint();
      const end = start + 250000000n; // +250ms
      tel.recordSpan(cid, 'backend_recv', start, end, { sessionId: 'sess' });
      const calls = mockLogger.info.mock.calls.filter((c) => c[0] === 'voice_latency.span');
      expect(calls.length).toBe(1);
      const payload = calls[0][1];
      expect(payload.correlation_id).toBe(cid);
      expect(payload.hop).toBe('backend_recv');
      expect(payload.duration_ms).toBe(250);
      expect(payload.meta).toEqual({ sessionId: 'sess' });
    });

    test('warns on unknown hop names', () => {
      tel.recordSpan('vl_x', 'made_up_hop', 0n, 100n);
      expect(mockLogger.warn).toHaveBeenCalledWith('voice_latency.unknown_hop', expect.any(Object));
    });

    test('warns on non-bigint timestamps', () => {
      tel.recordSpan('vl_x', 'backend_recv', 100, 200);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'voice_latency.span_non_bigint',
        expect.any(Object)
      );
    });

    test('silently no-ops when correlation_id is missing', () => {
      tel.recordSpan(null, 'backend_recv', 0n, 100n);
      tel.recordSpan(undefined, 'backend_recv', 0n, 100n);
      tel.recordSpan('', 'backend_recv', 0n, 100n);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('recordOutcome', () => {
    test('logs a SERVER outcome', () => {
      tel.recordOutcome('vl_x', 'sent_to_client', { audio_seq: 42n, meta: { boardId: 'main' } });
      const calls = mockLogger.info.mock.calls.filter((c) => c[0] === 'voice_latency.outcome');
      expect(calls.length).toBe(1);
      const p = calls[0][1];
      expect(p.outcome).toBe('sent_to_client');
      expect(p.audio_seq).toBe('42');
      expect(p.acked_by_ios).toBe(false);
      expect(p.meta).toEqual({ boardId: 'main' });
    });

    test('logs an iOS outcome with acked_by_ios=true', () => {
      tel.recordOutcome('vl_x', 'playback_completed', { acked_by_ios: true });
      const p = mockLogger.info.mock.calls.filter((c) => c[0] === 'voice_latency.outcome')[0][1];
      expect(p.acked_by_ios).toBe(true);
    });

    test('warns on unknown outcome', () => {
      tel.recordOutcome('vl_x', 'made_up_outcome');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'voice_latency.unknown_outcome',
        expect.any(Object)
      );
    });
  });

  describe('withSpan', () => {
    test('returns the fn return value and records span', async () => {
      const cid = 'vl_x';
      const result = await tel.withSpan(cid, 'backend_recv', null, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'value';
      });
      expect(result).toBe('value');
      const calls = mockLogger.info.mock.calls.filter((c) => c[0] === 'voice_latency.span');
      expect(calls.length).toBe(1);
      expect(calls[0][1].hop).toBe('backend_recv');
      expect(calls[0][1].duration_ms).toBeGreaterThanOrEqual(0);
    });

    test('re-throws after recording a span with the error message', async () => {
      const cid = 'vl_x';
      await expect(
        tel.withSpan(cid, 'backend_recv', { test: true }, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      const span = mockLogger.info.mock.calls.filter((c) => c[0] === 'voice_latency.span')[0][1];
      expect(span.meta.threw).toBe('boom');
      expect(span.meta.test).toBe(true);
    });
  });

  describe('frozen constants', () => {
    test('HOPS includes all 15 protocol hops', () => {
      expect(tel.HOPS).toContain('utterance_final');
      expect(tel.HOPS).toContain('vendor_first_audio');
      expect(tel.HOPS).toContain('ios_dataPlayedBack');
      expect(tel.HOPS.length).toBe(15);
    });

    test('SERVER_OUTCOMES includes original 8 server states + 13 loaded-barrel states', () => {
      // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.4)
      // added `loaded_barrel_pretext_abort` — bumping the total to 21.
      expect(tel.SERVER_OUTCOMES.length).toBe(21);
      // Original 8 (pre-Loaded-Barrel) — pin for back-compat:
      expect(tel.SERVER_OUTCOMES).toContain('sent_to_client');
      expect(tel.SERVER_OUTCOMES).toContain('suppressed_after_synth');
      expect(tel.SERVER_OUTCOMES).toContain('synth_started');
      // Loaded Barrel Phase 1.D additions:
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_started');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_fired');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_hit');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_hit_pending');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_hit_late');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_miss');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_aborted');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_cap_skipped');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_parity_mismatch');
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_text_drift_detected');
      // Single-round latency sprint Phase 1:
      expect(tel.SERVER_OUTCOMES).toContain('loaded_barrel_pretext_abort');
    });

    test('IOS_OUTCOMES includes the 5 ack outcomes', () => {
      expect(tel.IOS_OUTCOMES.length).toBe(5);
      expect(tel.IOS_OUTCOMES).toContain('playback_completed');
      expect(tel.IOS_OUTCOMES).toContain('dropped_stale');
    });

    test('Loaded Barrel correlation IDs mint with source="loaded_barrel" (no warning)', () => {
      // KNOWN_SOURCES additions are private; verify behaviour via mint.
      // The mintCorrelationId function warns once per unknown source —
      // we just check the prefix surface.
      const id = tel.mintCorrelationId('sess-test', 'loaded_barrel');
      expect(id).toMatch(/^vl_loaded_barrel_[a-f0-9]{10}$/);
    });
  });
});
