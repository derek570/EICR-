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
});
