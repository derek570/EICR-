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
import { SonnetSession } from '@/lib/recording/sonnet-session';

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

    it('terminates after max (5) attempts and fires terminal non-recoverable onError', async () => {
      // To exercise the terminal path we need 5 dirty closes WITHOUT a
      // successful open in between (an onopen resets the counter).
      // Easiest way: stub `window.WebSocket` so every construction
      // yields a socket whose onclose fires on next tick without a
      // prior onopen. That drives attempts 1..5 to exhaustion, and
      // the 6th close is the one that flips onError to non-recoverable.
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
        // Drain until the terminal error fires.
        for (let i = 0; i < 20 && onError.mock.calls.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // Drain one more pass so the terminal onError definitely landed.
        await new Promise((r) => setTimeout(r, 20));

        // The terminal error is non-recoverable with the documented message.
        const calls = onError.mock.calls;
        const terminal = calls.find(
          (c) => c[1] === false && /reconnect failed after 5 attempts/.test(String(c[0]))
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
});
