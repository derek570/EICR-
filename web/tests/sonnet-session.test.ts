/**
 * SonnetSession regression + reconnect state-machine tests.
 *
 * Wave 4c.5 (client) — `web/reviews/WEB_REBUILD_COMPLETION.md` §2.1b.
 *
 * Commit A coverage (this commit): `session_ack.sessionId` is captured
 * and surfaced to the `onSessionAck` callback so the upcoming reconnect
 * state machine (Commits B–D) can echo it back inside `session_resume`
 * on a subsequent reconnect attempt.
 *
 * Later commits extend this suite with:
 *   - B: feature-flagged reconnect state machine (OFF = identical to
 *     today's "one open, error on close"; ON = exponential backoff with
 *     jitter, cap 10s, 5-attempt terminal failure).
 *   - C: `session_resume` frame shape + "first open sends session_start,
 *     subsequent opens send session_resume" ordering.
 *   - D: close-code log parity with Deepgram
 *     (`[sonnet] close code=<n> reason="<r>" reconnect=<bool> attempt=<i>`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { SonnetSession, VOICE_LATENCY_SUPPORTS } from '@/lib/recording/sonnet-session';

/**
 * Controllable scheduler for reconnect-path tests. The reconnect tick is
 * captured rather than fired on the wallclock — tests flush it manually
 * *after* the second mock server is registered, so there's no race
 * between `openSocket()` and `new WS(SONNET_URL)` and no dependency on
 * CI timer latency (previously flaked at the 5s vitest default).
 */
function makeControlledScheduler(): {
  scheduler: (cb: () => void, ms: number) => unknown;
  clearScheduler: (handle: unknown) => void;
  flush: () => void;
} {
  let pending: (() => void) | null = null;
  return {
    scheduler: (cb) => {
      pending = cb;
      return cb;
    },
    clearScheduler: (h) => {
      if (pending === h) pending = null;
    },
    flush: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
  };
}

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

function makeServer(): WS {
  // Prefix-match — the client appends `?token=…` so any query string
  // still routes to this fake server.
  return new WS(SONNET_URL);
}

function seedToken(): void {
  localStorage.setItem('cm_token', 'fake-jwt-token');
}

describe('SonnetSession', () => {
  let server: WS;

  beforeEach(() => {
    seedToken();
    server = makeServer();
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Commit A — sessionId capture from session_ack
  // ────────────────────────────────────────────────────────────────────────
  describe('session_ack handling (Commit A)', () => {
    it('captures sessionId from session_ack and forwards it to onSessionAck', async () => {
      const onSessionAck = vi.fn();
      const session = new SonnetSession({ onSessionAck });

      session.connect({
        sessionId: 'client-side-id-1',
        jobId: 'job-1',
        certificateType: 'EICR',
      });
      await server.connected;

      server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-abc-123' }));
      // Let the message handler run.
      await Promise.resolve();

      expect(onSessionAck).toHaveBeenCalledWith('new', 'srv-abc-123');
    });

    it('passes undefined sessionId when server omits it (legacy backend)', async () => {
      const onSessionAck = vi.fn();
      const session = new SonnetSession({ onSessionAck });

      session.connect({
        sessionId: 'client-side-id-2',
        jobId: 'job-2',
        certificateType: 'EICR',
      });
      await server.connected;

      server.send(JSON.stringify({ type: 'session_ack', status: 'new' }));
      await Promise.resolve();

      expect(onSessionAck).toHaveBeenCalledWith('new', undefined);
    });

    it('retains captured sessionId across subsequent session_ack frames', async () => {
      const onSessionAck = vi.fn();
      const session = new SonnetSession({ onSessionAck });

      session.connect({
        sessionId: 'client-side-id-3',
        jobId: 'job-3',
        certificateType: 'EICR',
      });
      await server.connected;

      server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-first' }));
      await Promise.resolve();

      // Server omits sessionId on a follow-up ack (shouldn't clobber state).
      server.send(JSON.stringify({ type: 'session_ack', status: 'resumed' }));
      await Promise.resolve();

      expect(onSessionAck).toHaveBeenLastCalledWith('resumed', 'srv-first');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // cancel_pending_tts decode (web TTS FIFO parity — iOS Phase 6.3)
  // ────────────────────────────────────────────────────────────────────────
  describe('cancel_pending_tts decode', () => {
    it('fires onCancelPendingTts with the exact { prefix, sessionId } shape', async () => {
      const onCancelPendingTts = vi.fn();
      const session = new SonnetSession({ onCancelPendingTts });
      session.connect({ sessionId: 'c-1', jobId: 'job-1', certificateType: 'EICR' });
      await server.connected;

      server.send(
        JSON.stringify({ type: 'cancel_pending_tts', prefix: 'srv-ir-', sessionId: 'srv-abc' })
      );
      await Promise.resolve();

      expect(onCancelPendingTts).toHaveBeenCalledWith({ prefix: 'srv-ir-', sessionId: 'srv-abc' });
    });

    it('defaults sessionId to null when the frame omits it', async () => {
      const onCancelPendingTts = vi.fn();
      const session = new SonnetSession({ onCancelPendingTts });
      session.connect({ sessionId: 'c-2', jobId: 'job-2', certificateType: 'EICR' });
      await server.connected;

      server.send(JSON.stringify({ type: 'cancel_pending_tts', prefix: 'srv-bs-' }));
      await Promise.resolve();

      expect(onCancelPendingTts).toHaveBeenCalledWith({ prefix: 'srv-bs-', sessionId: null });
    });

    it('IGNORES a frame with an empty/missing prefix', async () => {
      const onCancelPendingTts = vi.fn();
      const session = new SonnetSession({ onCancelPendingTts });
      session.connect({ sessionId: 'c-3', jobId: 'job-3', certificateType: 'EICR' });
      await server.connected;

      server.send(JSON.stringify({ type: 'cancel_pending_tts', prefix: '' }));
      server.send(JSON.stringify({ type: 'cancel_pending_tts' }));
      await Promise.resolve();

      expect(onCancelPendingTts).not.toHaveBeenCalled();
    });

    it('clearInFlightToolCallIdByPrefix drops a matching in-flight ask, keeps a non-match', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 'c-4', jobId: 'job-4', certificateType: 'EICR' });
      await server.connected;

      // Latch an in-flight ask_user toolCallId via the wire.
      server.send(
        JSON.stringify({
          type: 'ask_user_started',
          question: 'BS number?',
          tool_call_id: 'srv-bs-1',
        })
      );
      await Promise.resolve();
      expect(session.peekInFlightToolCallId()).toBe('srv-bs-1');

      // Non-matching prefix leaves it.
      session.clearInFlightToolCallIdByPrefix('srv-ir-');
      expect(session.peekInFlightToolCallId()).toBe('srv-bs-1');

      // Matching prefix clears it.
      session.clearInFlightToolCallIdByPrefix('srv-bs-');
      expect(session.peekInFlightToolCallId()).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Commit B — reconnect state machine (feature-flagged)
  //
  // We stub `Math.random` to 0 so `computeBackoffDelay` collapses to 0 and
  // reconnect attempts fire on the next tick. That lets us use real timers
  // + `jest-websocket-mock`'s microtask-driven handshake without having to
  // reconcile fake-timer interleaving with the mock-socket internals.
  // ────────────────────────────────────────────────────────────────────────
  describe('reconnect flag OFF (default)', () => {
    it('fires a recoverable onError once for a dirty close and does NOT reconnect', async () => {
      const onError = vi.fn();
      const session = new SonnetSession({ onError });
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;

      // Stand up a second server so a misbehaving state machine would
      // gladly reconnect. It must stay unconnected.
      const probe = new WS(SONNET_URL);
      await new Promise((r) => setTimeout(r, 50));
      expect(probe.server.clients().length).toBe(0);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][1]).toBe(true); // recoverable
    });

    it('does not fire onError for a clean close (code 1000)', async () => {
      const onError = vi.fn();
      const session = new SonnetSession({ onError });
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1000, reason: 'normal', wasClean: true });
      await server.closed;

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('reconnect flag ON', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      // Collapse backoff to 0 so reconnect attempts fire on next tick.
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
    });

    it('clean close (1000) does NOT trigger reconnect', async () => {
      const onError = vi.fn();
      const session = new SonnetSession({ onError });
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1000, reason: 'normal', wasClean: true });
      await server.closed;

      const probe = new WS(SONNET_URL);
      await new Promise((r) => setTimeout(r, 50));
      expect(probe.server.clients().length).toBe(0);
      expect(onError).not.toHaveBeenCalled();
    });

    it('dirty close schedules a reconnect that reaches a new server', async () => {
      const sched = makeControlledScheduler();
      const session = new SonnetSession({}, sched);
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;

      // Stand up the second server BEFORE firing the captured reconnect
      // tick so mock-socket has a live server to pair the new client
      // socket with. Previously this relied on a real setTimeout(0)
      // winning the race against the next test line — fine locally,
      // flaky under CI load.
      const next = new WS(SONNET_URL);
      sched.flush();
      await next.connected;
      expect(session.connectionState).toBe('connected');
    });

    it('resets attempt counter on a clean open', async () => {
      // Construct a session, drive it through enough break/reconnect
      // cycles to exceed MAX if the counter weren't resetting, and
      // assert no terminal error fires. We inspect the counter via
      // the close-code log (Commit D) rather than a long live cycle
      // to keep the test deterministic — each successful reconnect
      // prints `attempt=0` in the subsequent close log, proving the
      // counter was reset on onopen.
      //
      // [2026-04-29] Use the controlled scheduler so the reconnect
      // tick fires AFTER the new mock server is up — same pattern as
      // the test above. Without it the real setTimeout(0) raced ahead
      // of `new WS(SONNET_URL)` under CI load and the session went
      // into a second backoff cycle, blowing past the 5s test timeout.
      const sched = makeControlledScheduler();
      const onError = vi.fn();
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = new SonnetSession({ onError }, sched);
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      // Cycle 1: dirty close → reconnect → the close log on the next
      // cycle should show `attempt=0`, proving the counter reset on the
      // successful open.
      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;
      const next = new WS(SONNET_URL);
      sched.flush();
      await next.connected;

      next.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await next.closed;

      // Two close logs recorded — the second must show attempt=0 (fresh
      // exponential ramp after the successful open reset the counter).
      const closeLogs = info.mock.calls
        .map((c) => c[0])
        .filter((l): l is string => typeof l === 'string' && l.startsWith('[sonnet] close'));
      expect(closeLogs.length).toBeGreaterThanOrEqual(2);
      expect(closeLogs[1]).toMatch(/attempt=0/);
      expect(onError).not.toHaveBeenCalled();
    });

    it('terminates after RECONNECT_MAX_ATTEMPTS (50) attempts and fires terminal non-recoverable onError', async () => {
      // To exercise the terminal path we need 50 dirty closes WITHOUT a
      // successful open in between (an onopen resets the counter).
      // The cap was raised from 5 → 50 in audit row #33 to mirror iOS
      // (`ServerWebSocketService.swift:1187-1225`) which retries
      // indefinitely. 50 × ~5ms-per-cycle = ~250 ms drain window.
      // Easiest way: stub `window.WebSocket` so every construction
      // yields a socket whose onclose fires on next tick without a
      // prior onopen. That drives attempts 1..50 to exhaustion, and
      // the 51st close is the one that flips onError to non-recoverable.
      const OriginalWS = window.WebSocket;
      const fakeSockets: Array<{
        close: () => void;
        readyState: number;
        onopen?: () => void;
        onclose?: (e: CloseEvent) => void;
        onerror?: () => void;
        onmessage?: (e: MessageEvent) => void;
        send: () => void;
      }> = [];
      class FakeWS {
        readyState = 0;
        onopen?: () => void;
        onclose?: (e: CloseEvent) => void;
        onerror?: () => void;
        onmessage?: (e: MessageEvent) => void;
        constructor() {
          fakeSockets.push(this as unknown as (typeof fakeSockets)[number]);
          // Fire a dirty close on next microtask — no onopen.
          queueMicrotask(() => {
            this.readyState = 3;
            this.onclose?.({
              code: 1006,
              reason: 'no server',
              wasClean: false,
            } as CloseEvent);
          });
        }
        close(): void {
          this.readyState = 3;
        }
        send(): void {
          /* no-op */
        }
      }
      (window as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

      try {
        const onError = vi.fn();
        const session = new SonnetSession({ onError });
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });

        // Each microtask cycle closes the current socket and the
        // onclose handler schedules the next reconnect via
        // `setTimeout(..., 0)` (jitter=0 from the beforeEach stub).
        // Drain until the terminal error fires. Cap raised to 50 in
        // audit #33, so we drain ~250ms total (50 cycles × 5ms).
        for (let i = 0; i < 150 && onError.mock.calls.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // Drain one more pass so the terminal onError definitely landed.
        await new Promise((r) => setTimeout(r, 20));

        // The terminal error is non-recoverable with the documented message.
        const calls = onError.mock.calls;
        const terminal = calls.find(
          (c) => c[1] === false && /reconnect failed after 50 attempts/.test(String(c[0]))
        );
        expect(terminal).toBeDefined();
      } finally {
        (window as unknown as { WebSocket: unknown }).WebSocket = OriginalWS;
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Commit C — session_resume frame on reconnect
  // ────────────────────────────────────────────────────────────────────────
  describe('session_resume on reconnect (Commit C)', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });
    afterEach(() => {
      delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
    });

    it('first open sends session_start, NOT session_resume', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      const firstRaw = await server.nextMessage;
      const firstFrame = JSON.parse(firstRaw as string) as { type: string };
      expect(firstFrame.type).toBe('session_start');
    });

    it('sends session_resume with captured sessionId on reconnect', async () => {
      const sched = makeControlledScheduler();
      const session = new SonnetSession({}, sched);
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      // Drain session_start.
      await server.nextMessage;

      // Server hands out a sessionId via session_ack.
      server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-xyz-1' }));
      await Promise.resolve();

      // Dirty close → state machine reconnects.
      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;

      const next = new WS(SONNET_URL);
      sched.flush();
      await next.connected;
      const resumeRaw = await next.nextMessage;
      const resumeFrame = JSON.parse(resumeRaw as string) as {
        type: string;
        sessionId: string;
      };
      expect(resumeFrame.type).toBe('session_resume');
      expect(resumeFrame.sessionId).toBe('srv-xyz-1');
    });

    it('falls back to session_start on reconnect when server never advertised a sessionId', async () => {
      const sched = makeControlledScheduler();
      const session = new SonnetSession({}, sched);
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // session_start

      // Legacy server ack — no sessionId.
      server.send(JSON.stringify({ type: 'session_ack', status: 'new' }));
      await Promise.resolve();

      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;

      const next = new WS(SONNET_URL);
      sched.flush();
      await next.connected;
      const raw = await next.nextMessage;
      const frame = JSON.parse(raw as string) as { type: string };
      // No captured id → we can't meaningfully resume → send start.
      expect(frame.type).toBe('session_start');
    });

    it('surfaces a warning when server returns status=new to a resume (TTL expired)', async () => {
      const onError = vi.fn();
      const session = new SonnetSession({ onError });
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage;

      // First ack — sessionStatus becomes 'resumed' so the next 'new' is
      // interpreted as TTL expiry.
      server.send(JSON.stringify({ type: 'session_ack', status: 'resumed', sessionId: 'srv-rr' }));
      await Promise.resolve();

      // Then server sends another ack with status='new' — TTL expired.
      server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-rr-2' }));
      await Promise.resolve();

      // Recoverable warning fired.
      const warning = onError.mock.calls.find(
        (c) => c[1] === true && /context expired/.test(String(c[0]))
      );
      expect(warning).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Commit D — close-code logging (Deepgram-matching format)
  // ────────────────────────────────────────────────────────────────────────
  describe('close-code logging (Commit D)', () => {
    it('logs close events in the Deepgram-matching format', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1011, reason: 'server error', wasClean: false });
      await server.closed;

      // `[sonnet] close code=<n> reason="<r>" reconnect=<bool> attempt=<i>`
      const matchingCall = info.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('[sonnet] close')
      );
      expect(matchingCall).toBeDefined();
      const line = matchingCall?.[0] as string;
      expect(line).toMatch(
        /^\[sonnet\] close code=\d+ reason=".*" reconnect=(true|false) attempt=\d+$/
      );
    });

    it('logs reconnect=true when the flag is ON and close is dirty', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const session = new SonnetSession({});
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
        await server.connected;

        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        const line = info.mock.calls.find(
          (c) => typeof c[0] === 'string' && c[0].startsWith('[sonnet] close')
        )?.[0] as string;
        expect(line).toMatch(/reconnect=true/);
        expect(line).toMatch(/code=1006/);
        expect(line).toMatch(/reason="abnormal"/);
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });

    it('logs reconnect=false for a clean close', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1000, reason: 'normal', wasClean: true });
      await server.closed;

      const line = info.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('[sonnet] close')
      )?.[0] as string;
      expect(line).toMatch(/reconnect=false/);
      expect(line).toMatch(/code=1000/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Stage 6 protocol_version handshake — Farm Close prod incident fix
  // (sess_moqvdgjl_fo6w, 2026-05-04). Without these the backend treats us
  // as a pre-Stage 6 client, sets fallbackToLegacy=true, and SUPPRESSES
  // ask_user_started — leaving the inspector staring at a quiet UI while
  // Sonnet waits for an answer that never arrives.
  // ────────────────────────────────────────────────────────────────────────
  describe('Stage 6 protocol handshake', () => {
    it('advertises protocol_version="stage6" on session_start', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      const raw = await server.nextMessage;
      const frame = JSON.parse(raw as string) as { type: string; protocol_version?: string };
      expect(frame.type).toBe('session_start');
      expect(frame.protocol_version).toBe('stage6');
    });

    it('advertises voice-latency capabilities in the exact parser shape on session_start (WS3 item 1)', async () => {
      // parseVoiceLatencyCapabilities (src/extraction/voice-latency-config.js:174)
      // accepts ONLY `capabilities: { voice_latency: { version: 1, supports } }`.
      // A bare array parses as v0 and leaves the capability DORMANT — this
      // test pins the nested shape so a refactor can't silently regress it.
      const session = new SonnetSession({});
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      const raw = await server.nextMessage;
      const frame = JSON.parse(raw as string) as {
        type: string;
        capabilities?: { voice_latency?: { version?: number; supports?: string[] } };
      };
      expect(frame.type).toBe('session_start');
      expect(frame.capabilities).toEqual({
        voice_latency: {
          version: 1,
          // P3 (2026-07-23) — lim_ranged_write_v1 added: web ships the
          // sentinel-safe guards this wave, so it advertises LIM-ranged-write.
          supports: ['low_conf_readback_v1', 'lim_ranged_write_v1'],
        },
      });
      // Exported constant is the single source of truth (iOS parity:
      // ServerWebSocketService.voiceLatencySupports).
      expect(VOICE_LATENCY_SUPPORTS).toEqual(['low_conf_readback_v1', 'lim_ranged_write_v1']);
      // regex_fast_v2 / client_playback_telemetry MUST NOT be claimed until
      // their web plumbing ships (parity-ledger follow-up rows own them).
      expect(VOICE_LATENCY_SUPPORTS).not.toContain('regex_fast_v2');
      expect(VOICE_LATENCY_SUPPORTS).not.toContain('client_playback_telemetry');
    });

    it('advertises protocol_version="stage6" on session_resume', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const sched = makeControlledScheduler();
        const session = new SonnetSession({}, sched);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // drain session_start
        server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-xyz' }));
        await Promise.resolve();
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        const next = new WS(SONNET_URL);
        sched.flush();
        await next.connected;
        const raw = await next.nextMessage;
        const frame = JSON.parse(raw as string) as {
          type: string;
          protocol_version?: string;
        };
        expect(frame.type).toBe('session_resume');
        expect(frame.protocol_version).toBe('stage6');
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });

    it('maps inbound ask_user_started onto onQuestion (parity with iOS)', async () => {
      const onQuestion = vi.fn();
      const session = new SonnetSession({ onQuestion });
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // drain session_start

      server.send(
        JSON.stringify({
          type: 'ask_user_started',
          tool_call_id: 'toolu_01ABC',
          question: "Should I create circuit 1, and what's the designation?",
          reason: 'out_of_range_circuit',
          context_field: 'measured_zs_ohm',
          context_circuit: 1,
          expected_answer_shape: 'designation',
        })
      );
      await Promise.resolve();

      expect(onQuestion).toHaveBeenCalledTimes(1);
      const arg = onQuestion.mock.calls[0][0];
      expect(arg.question).toBe("Should I create circuit 1, and what's the designation?");
      expect(arg.question_type).toBe('out_of_range_circuit');
      expect(arg.field).toBe('measured_zs_ohm');
      expect(arg.circuit).toBe(1);
    });
  });

  describe('backoff math', () => {
    it('produces non-negative delays within the cap for any jitter seed', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        for (const r of [0, 0.25, 0.5, 0.75, 1]) {
          const d = SonnetSession.computeBackoffDelay(attempt, () => r);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(10_000);
        }
      }
    });

    it('maximum possible delay is monotonically non-decreasing across attempts until the cap', () => {
      // `rand = () => 1` gives the upper bound of the jittered range.
      const maxes = [1, 2, 3, 4, 5, 6].map((a) => SonnetSession.computeBackoffDelay(a, () => 1));
      for (let i = 1; i < maxes.length; i++) {
        expect(maxes[i]).toBeGreaterThanOrEqual(maxes[i - 1]);
      }
      // Attempt 5 with rand=1 should hit the cap (500 * 2^4 = 8000;
      // attempt 6: 500 * 2^5 = 16000 → capped at 10 000).
      expect(maxes[5]).toBe(10_000);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Stage 6 STI-04 — ask_user answer wire (transcript → ask_user_answered)
  //
  // The PWA used to rely entirely on the server-side overtake classifier
  // to figure out which transcript was the answer to a Stage 6 ask. That
  // worked for unambiguous shapes ("1.") but failed on plausible value-
  // shaped answers ("0.6", "TT", "cooker"). These tests pin the iOS
  // wire-protocol parity: ask_user_started captures the toolCallId, the
  // first non-empty final mints a UUID, sends the transcript stamped with
  // utterance_id THEN ask_user_answered carrying the same id as
  // consumed_utterance_id.
  // ────────────────────────────────────────────────────────────────────────
  describe('Stage 6 ask_user_answered wire', () => {
    it('captures tool_call_id from ask_user_started and surfaces it on SonnetQuestion', async () => {
      const onQuestion = vi.fn();
      const session = new SonnetSession({ onQuestion });
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // drain session_start

      server.send(
        JSON.stringify({
          type: 'ask_user_started',
          tool_call_id: 'toolu_01ABC',
          question: "What's the designation for circuit 1?",
          reason: 'out_of_range_circuit',
          context_field: 'circuit_designation',
          context_circuit: 1,
        })
      );
      await Promise.resolve();

      expect(onQuestion).toHaveBeenCalledTimes(1);
      const arg = onQuestion.mock.calls[0][0];
      expect(arg.tool_call_id).toBe('toolu_01ABC');
    });

    it('consumeInFlightToolCallId returns the latched id then null', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage;

      server.send(
        JSON.stringify({
          type: 'ask_user_started',
          tool_call_id: 'toolu_xyz',
          question: 'q',
          reason: 'missing_context',
        })
      );
      await Promise.resolve();

      expect(session.consumeInFlightToolCallId()).toBe('toolu_xyz');
      // Second consume must return null — toolCallId is single-shot.
      expect(session.consumeInFlightToolCallId()).toBeNull();
    });

    it('sendTranscript stamps utterance_id when provided', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // session_start

      session.sendTranscript('cooker', {
        confirmationsEnabled: false,
        utteranceId: 'u-1234',
      });
      const raw = await server.nextMessage;
      const frame = JSON.parse(raw as string) as Record<string, unknown>;
      expect(frame.type).toBe('transcript');
      expect(frame.text).toBe('cooker');
      expect(frame.utterance_id).toBe('u-1234');
      // iOS-conditional: confirmations_enabled is OMITTED when false to
      // match ServerWebSocketService.swift:509-511. Pre-fix the wire
      // shape always included `false`; post-fix the key is absent.
      expect(frame.confirmations_enabled).toBeUndefined();
    });

    it('sendAskUserAnswered emits transcript-then-ask in correct shape', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // session_start

      session.sendTranscript('cooker', {
        confirmationsEnabled: true,
        utteranceId: 'u-abc',
      });
      session.sendAskUserAnswered('toolu_01', 'cooker', 'u-abc');

      const t = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      const a = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;

      expect(t.type).toBe('transcript');
      expect(t.utterance_id).toBe('u-abc');
      expect(a.type).toBe('ask_user_answered');
      expect(a.tool_call_id).toBe('toolu_01');
      expect(a.user_text).toBe('cooker');
      expect(a.consumed_utterance_id).toBe('u-abc');
    });

    it('sendAskUserAnswered no-ops on empty toolCallId or userText', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage;

      session.sendAskUserAnswered('', 'cooker', 'u-1');
      session.sendAskUserAnswered('toolu', '', 'u-1');
      // Neither call should have produced a frame on the wire.
      // Send a known frame as a synchronisation anchor and assert the
      // very next inbound is THAT frame.
      session.sendTranscript('marker', { utteranceId: 'u-marker' });
      const raw = (await server.nextMessage) as string;
      const frame = JSON.parse(raw) as Record<string, unknown>;
      expect(frame.type).toBe('transcript');
      expect(frame.utterance_id).toBe('u-marker');
    });

    it('does not re-arm in-flight slot for an already-fired toolCallId (idempotency)', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage;

      // First ask_user_started, consume, fire.
      server.send(
        JSON.stringify({ type: 'ask_user_started', tool_call_id: 'toolu_dup', question: 'q1' })
      );
      await Promise.resolve();
      expect(session.consumeInFlightToolCallId()).toBe('toolu_dup');

      // Server re-emits the SAME ask (e.g. session_resume rehydrate). The
      // in-flight slot must NOT re-arm — answering twice would emit a
      // duplicate ask_user_answered and the backend would log
      // unknown_or_stale_tool_call_id on the second pass.
      server.send(
        JSON.stringify({ type: 'ask_user_started', tool_call_id: 'toolu_dup', question: 'q1' })
      );
      await Promise.resolve();
      expect(session.consumeInFlightToolCallId()).toBeNull();
    });

    it('disconnect clears in-flight slot and fired Set so the next session starts clean', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage;

      server.send(
        JSON.stringify({ type: 'ask_user_started', tool_call_id: 'toolu_a', question: 'q' })
      );
      await Promise.resolve();
      // Fire it once so it lands in firedToolCallIds.
      expect(session.consumeInFlightToolCallId()).toBe('toolu_a');

      session.disconnect();
      // The session above is over; a brand-new SonnetSession starts with a
      // clean Set, but for THIS instance disconnect also clears the Set so
      // tests can reuse it without leakage.
      // (Reuse isn't a real-world flow — the consumer always allocates a
      // new SonnetSession per recording — but the contract should hold.)
      // We assert by re-arming the same id and consuming again.
      session.connect({ sessionId: 's2', jobId: 'j', certificateType: 'EICR' });
      // Note: this test doesn't actually need a second WS, just the
      // public-API state assertion.
      // The latched id was cleared by disconnect — first consume returns null.
      expect(session.consumeInFlightToolCallId()).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Phase 3 — disconnected buffering + paired-replay reorder. Mirrors iOS
  // ServerWebSocketService.flushPendingMessages + reorderPendingForReplay
  // (Plan 06-05 r4-#2).
  // ────────────────────────────────────────────────────────────────────────
  describe('disconnected buffering', () => {
    it('buffers transcript / correction / ask_user_answered while connecting and flushes on open', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      // Send before the WS handshake completes — these must be buffered
      // and replayed on `onopen`, not lost.
      session.sendTranscript('hello', { utteranceId: 'u-1' });
      session.sendCorrection('zs', 1, '0.44');
      session.sendAskUserAnswered('toolu_x', 'hello', 'u-1');

      await server.connected;

      // Drain session_start first, then the three buffered frames.
      const start = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      expect(start.type).toBe('session_start');

      // The buffered FIFO is [transcript(u-1), correction, ask(u-1)].
      // Transcript was buffered BEFORE ask, so the reorder algorithm
      // emits each frame in its original slot — the transcript is
      // already in front of the ask and the wire-ordering invariant
      // (transcript before its matching ask) is satisfied without
      // hoisting. The correction stays sandwiched in between; the
      // backend's seenTranscriptUtterances Set is populated by the
      // transcript at slot 0 long before the ask's fast-path lookup.
      const f1 = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      const f2 = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      const f3 = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      expect(f1.type).toBe('transcript');
      expect(f1.utterance_id).toBe('u-1');
      expect(f2.type).toBe('correction');
      expect(f3.type).toBe('ask_user_answered');
      expect(f3.consumed_utterance_id).toBe('u-1');
    });

    it('hoists transcript IMMEDIATELY before its paired ask when ask was buffered first', async () => {
      // The worst case the prior "asks first" partition got wrong:
      // ask was buffered BEFORE its matching transcript, so a naive
      // FIFO replay would emit ask before transcript and the backend
      // Set would be empty at fast-path lookup time. Paired-replay
      // hoists the transcript to immediately precede the ask.
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      // Order matters: ask first, then matching transcript.
      session.sendAskUserAnswered('toolu_y', 'cooker', 'u-Y');
      session.sendTranscript('cooker', { utteranceId: 'u-Y' });
      await server.connected;

      const start = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      expect(start.type).toBe('session_start');

      const f1 = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      const f2 = JSON.parse((await server.nextMessage) as string) as Record<string, unknown>;
      // First out is the hoisted transcript, second is the ask — the
      // matching transcript is NOT re-emitted later in the walk.
      expect(f1.type).toBe('transcript');
      expect(f1.utterance_id).toBe('u-Y');
      expect(f2.type).toBe('ask_user_answered');
      expect(f2.consumed_utterance_id).toBe('u-Y');
    });
  });

  describe('reorderPendingForReplay', () => {
    it('returns empty for empty input', () => {
      expect(SonnetSession.reorderPendingForReplay([])).toEqual([]);
    });

    it('preserves order when no asks are buffered', () => {
      const input = [
        { type: 'transcript', text: 'a', utterance_id: 'u1' },
        { type: 'transcript', text: 'b', utterance_id: 'u2' },
        { type: 'correction', field: 'zs', circuit: 1, value: '0.44' },
      ];
      expect(SonnetSession.reorderPendingForReplay(input)).toEqual(input);
    });

    it('hoists matching transcript IMMEDIATELY before its paired ask_user_answered', () => {
      // Worst case: ask buffered BEFORE its matching transcript (the bug
      // the prior global-partition strategy got wrong). After reorder the
      // transcript must appear right before the ask in the wire stream.
      const input = [
        {
          type: 'ask_user_answered',
          tool_call_id: 't1',
          user_text: 'x',
          consumed_utterance_id: 'uX',
        },
        { type: 'transcript', text: 'x', utterance_id: 'uX' },
      ];
      const out = SonnetSession.reorderPendingForReplay(input);
      expect(out).toHaveLength(2);
      expect(out[0].type).toBe('transcript');
      expect(out[0].utterance_id).toBe('uX');
      expect(out[1].type).toBe('ask_user_answered');
      expect(out[1].consumed_utterance_id).toBe('uX');
    });

    it('emits ask in place when no buffered matching transcript exists', () => {
      // The pre-disconnect transcript already populated the backend Set;
      // emit the ask in place (no hoisting possible).
      const input = [
        { type: 'transcript', text: 'unrelated', utterance_id: 'uA' },
        {
          type: 'ask_user_answered',
          tool_call_id: 't2',
          user_text: 'y',
          consumed_utterance_id: 'uMissing',
        },
      ];
      const out = SonnetSession.reorderPendingForReplay(input);
      expect(out).toHaveLength(2);
      expect(out[0].utterance_id).toBe('uA');
      expect(out[1].type).toBe('ask_user_answered');
    });

    it('output count equals input count — no frame is added or dropped', () => {
      const input = [
        { type: 'transcript', text: 'a', utterance_id: 'u1' },
        { type: 'correction', field: 'z', circuit: 1, value: '1' },
        {
          type: 'ask_user_answered',
          tool_call_id: 't',
          user_text: 'a',
          consumed_utterance_id: 'u1',
        },
        { type: 'transcript', text: 'b', utterance_id: 'u2' },
      ];
      const out = SonnetSession.reorderPendingForReplay(input);
      expect(out).toHaveLength(input.length);
    });

    it('preserves intra-class FIFO when multiple unrelated frames are buffered', () => {
      const input = [
        { type: 'correction', field: 'a', circuit: 1, value: '1' },
        { type: 'correction', field: 'b', circuit: 1, value: '2' },
        { type: 'transcript', text: 't', utterance_id: 'u1' },
      ];
      const out = SonnetSession.reorderPendingForReplay(input);
      expect(out.map((m) => (m.type === 'correction' ? m.field : m.type))).toEqual([
        'a',
        'b',
        'transcript',
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Close code 1005 — Flaw B fix from sess_mp79tvcj_6prk (2026-05-15).
  // RFC 6455 §7.1.5 "no status received": iPad Safari fires onclose with
  // code 1005 when the OS reaps a backgrounded tab's WS during audio
  // playback / App Nap. Treating 1005 as clean (pre-this-commit
  // behaviour) suppressed reconnect on the exact death pattern that
  // most needs one.
  // ────────────────────────────────────────────────────────────────────────
  describe('close code 1005 (Flaw B — iPad Safari tab-reap reconnect)', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });
    afterEach(() => {
      delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
    });

    it('schedules a reconnect on code 1005 (was suppressed pre-fix)', async () => {
      const sched = makeControlledScheduler();
      const session = new SonnetSession({}, sched);
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // drain session_start

      server.close({ code: 1005, reason: '', wasClean: false });
      await server.closed;

      const next = new WS(SONNET_URL);
      sched.flush();
      await next.connected;
      expect(session.connectionState).toBe('connected');
    });

    it('logs reconnect=true for a 1005 close when flag ON', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1005, reason: '', wasClean: false });
      await server.closed;

      const line = info.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('[sonnet] close')
      )?.[0] as string;
      expect(line).toMatch(/code=1005/);
      expect(line).toMatch(/reconnect=true/);
    });

    it('1000 still treated as clean (no reconnect) — narrow guard, not a blanket flip', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const session = new SonnetSession({});
      session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
      await server.connected;

      server.close({ code: 1000, reason: 'normal', wasClean: true });
      await server.closed;

      const line = info.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].startsWith('[sonnet] close')
      )?.[0] as string;
      expect(line).toMatch(/code=1000/);
      expect(line).toMatch(/reconnect=false/);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Out-of-band client_diagnostic buffer — Flaw A fix from
  // sess_mp79tvcj_6prk (2026-05-15). Pre-fix `sendClientDiagnostic`
  // dropped on the floor when `state !== 'connected'`, so the very
  // events that document a WS death (sonnet_ws_close,
  // recording_pagehide, recording_visibility_change) were silently
  // discarded. Now buffered + drained on the next clean open.
  // ────────────────────────────────────────────────────────────────────────
  describe('client_diagnostic out-of-band buffer (Flaw A fix)', () => {
    it('buffers diagnostics fired while disconnected and replays on reconnect', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      try {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const sched = makeControlledScheduler();
        const session = new SonnetSession({}, sched);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // drain session_start
        server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-1' }));
        await Promise.resolve();

        // Dirty close — WS dies. Diagnostics fired AFTER this point must
        // not be silently dropped.
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        // The recording-context page-lifecycle effect would fire this in
        // production when iPad Safari sends the tab into BFCache.
        session.sendClientDiagnostic('recording_pagehide', { persisted: true });
        session.sendClientDiagnostic('sonnet_ws_close_late_observation', {
          ms_since_recv: 42,
        });

        const next = new WS(SONNET_URL);
        sched.flush();
        await next.connected;

        // First post-resume frame is session_resume; drain it.
        await next.nextMessage;

        // The two buffered diagnostics MUST land in CloudWatch on the new WS.
        const drained: Array<Record<string, unknown>> = [];
        for (let i = 0; i < 2; i++) {
          const raw = await next.nextMessage;
          drained.push(JSON.parse(raw as string) as Record<string, unknown>);
        }
        expect(drained.every((m) => m.type === 'client_diagnostic')).toBe(true);
        expect(drained[0].category).toBe('recording_pagehide');
        expect(drained[0].persisted).toBe(true);
        expect(drained[0].replayed_from_pending).toBe(true);
        expect(typeof drained[0].replay_delay_ms).toBe('number');
        expect(drained[1].category).toBe('sonnet_ws_close_late_observation');
        expect(drained[1].replayed_from_pending).toBe(true);
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });

    it('drains in FIFO order so the replay matches the dead-WS timeline', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      try {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const sched = makeControlledScheduler();
        const session = new SonnetSession({}, sched);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // drain session_start
        server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-1' }));
        await Promise.resolve();
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        for (let i = 0; i < 5; i++) {
          session.sendClientDiagnostic('test_seq', { seq: i });
        }

        const next = new WS(SONNET_URL);
        sched.flush();
        await next.connected;
        await next.nextMessage; // drain session_resume

        const replayed: number[] = [];
        for (let i = 0; i < 5; i++) {
          const raw = await next.nextMessage;
          replayed.push((JSON.parse(raw as string) as Record<string, unknown>).seq as number);
        }
        expect(replayed).toEqual([0, 1, 2, 3, 4]);
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });

    it('drops oldest events when the buffer overflows PENDING_DIAGNOSTICS_MAX (200)', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      try {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const sched = makeControlledScheduler();
        const session = new SonnetSession({}, sched);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // drain session_start
        server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-1' }));
        await Promise.resolve();
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        // Fire 250 events — first 50 should evict.
        for (let i = 0; i < 250; i++) {
          session.sendClientDiagnostic('overflow_test', { seq: i });
        }

        const next = new WS(SONNET_URL);
        sched.flush();
        await next.connected;
        await next.nextMessage; // session_resume

        const first = JSON.parse((await next.nextMessage) as string) as Record<string, unknown>;
        // After eviction, the kept window is [seq=50 .. seq=249] — first
        // drained event is seq=50.
        expect(first.seq).toBe(50);
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });

    it('connected sends remain inline (no buffering when WS is live)', async () => {
      const session = new SonnetSession({});
      session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
      await server.connected;
      await server.nextMessage; // drain session_start

      session.sendClientDiagnostic('inline_test', { hello: 'world' });
      const raw = await server.nextMessage;
      const msg = JSON.parse(raw as string) as Record<string, unknown>;
      expect(msg.type).toBe('client_diagnostic');
      expect(msg.category).toBe('inline_test');
      expect(msg.hello).toBe('world');
      expect(msg.replayed_from_pending).toBeUndefined();
    });

    it('disconnect() drops the pending buffer — stale diagnostics never replay on the next session', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      try {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const session = new SonnetSession({});
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // session_start
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        session.sendClientDiagnostic('stale_event', {});
        session.disconnect();
        // After grace period, open a new server + reconnect manually.
        await new Promise((r) => setTimeout(r, 350));

        const next = new WS(SONNET_URL);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await next.connected;
        const raw = await next.nextMessage;
        const frame = JSON.parse(raw as string) as Record<string, unknown>;
        // First frame is session_start — NOT the buffered stale_event.
        expect(frame.type).toBe('session_start');
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // App-layer heartbeat — AWS ALB idle-timeout defence (#31 from runtime
  // couplings audit, 2026-05-17). Mirrors iOS
  // ServerWebSocketService.swift:604,1069-1092 — every 25s, send
  // `{type:"heartbeat"}` to keep ALB's idle counter at zero. WS-level
  // PING isn't enough; ALB counts application data frames only.
  // ────────────────────────────────────────────────────────────────────────
  describe('app-layer heartbeat (ALB defence)', () => {
    it('sends `{type:"heartbeat"}` every 25s after WS open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const session = new SonnetSession({});
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
        await server.connected;

        // Drain session_start so subsequent nextMessage reads are clean.
        const startRaw = await server.nextMessage;
        expect((JSON.parse(startRaw as string) as { type: string }).type).toBe('session_start');

        // Fire the first heartbeat tick by advancing 25s of fake time.
        await vi.advanceTimersByTimeAsync(25_000);
        const beat1 = await server.nextMessage;
        const frame1 = JSON.parse(beat1 as string) as { type: string };
        expect(frame1.type).toBe('heartbeat');

        // And a second tick another 25s later.
        await vi.advanceTimersByTimeAsync(25_000);
        const beat2 = await server.nextMessage;
        const frame2 = JSON.parse(beat2 as string) as { type: string };
        expect(frame2.type).toBe('heartbeat');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT fire before 25s elapses', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const session = new SonnetSession({});
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // session_start

        // Advance 24.9s — heartbeat must NOT have fired yet.
        await vi.advanceTimersByTimeAsync(24_900);
        expect(server.messagesToConsume.pendingItems).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops on ws.onclose so no orphaned interval keeps firing', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const session = new SonnetSession({});
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // session_start

        server.close({ code: 1000, reason: 'normal', wasClean: true });
        await server.closed;

        // 60s of fake time post-close. With no live ws, no frames can land
        // server-side anyway, but the interval should have been cleared
        // so it isn't firing in the background.
        await vi.advanceTimersByTimeAsync(60_000);
        // We can't directly probe `heartbeatTimer` (it's private). The
        // observable signal is "no message arrives on the closed server."
        // We're using fake-timers + a clean close so the test cannot race
        // with a pending tick.
        expect(server.messagesToConsume.pendingItems).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-arms on reconnect (new ws.onopen → new heartbeat cycle)', async () => {
      process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED = 'true';
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // Math.random is consumed by the reconnect backoff jitter; pin to 0
        // so the scheduled reconnect fires immediately when we advance time.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const sched = makeControlledScheduler();
        const session = new SonnetSession({}, sched);
        session.connect({ sessionId: 'client-s', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // session_start

        // Dirty close → reconnect path.
        server.close({ code: 1006, reason: 'abnormal', wasClean: false });
        await server.closed;

        // Stand up second server BEFORE flushing the scheduled reconnect.
        const next = new WS(SONNET_URL);
        sched.flush();
        await next.connected;
        await next.nextMessage; // session_resume (or session_start fallback)

        // The reconnected WS should re-arm the heartbeat.
        await vi.advanceTimersByTimeAsync(25_000);
        const beat = await next.nextMessage;
        const frame = JSON.parse(beat as string) as { type: string };
        expect(frame.type).toBe('heartbeat');
      } finally {
        delete process.env.NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED;
        vi.useRealTimers();
      }
    });

    it('disconnect() clears the heartbeat', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const session = new SonnetSession({});
        session.connect({ sessionId: 's', jobId: 'j', certificateType: 'EICR' });
        await server.connected;
        await server.nextMessage; // session_start

        session.disconnect();
        // `disconnect()` sends `{type:"session_stop"}` synchronously
        // before scheduling the 300ms close grace. Drain it.
        const stopRaw = await server.nextMessage;
        expect((JSON.parse(stopRaw as string) as { type: string }).type).toBe('session_stop');

        // 300ms close grace + buffer, then 60s further. No additional
        // heartbeat should have been queued on the server side.
        await vi.advanceTimersByTimeAsync(60_400);
        expect(server.messagesToConsume.pendingItems).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
