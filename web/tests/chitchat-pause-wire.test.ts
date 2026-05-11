/**
 * Chitchat-pause wire decode + send (SonnetSession).
 *
 * iOS canon contract (2026-05-06 slice 4):
 *   - Server emits `{type: "chitchat_paused"}` after 10 consecutive
 *     zero-engagement transcript turns → host clears Sonnet-forwarding,
 *     UI shows banner.
 *   - Server emits `{type: "chitchat_resumed", reason: "..."}` on any
 *     wake trigger → UI clears banner.
 *   - Client sends `{type: "chitchat_resume"}` from the banner Resume
 *     button → backend exits the paused state and confirms with
 *     `chitchat_resumed`.
 *
 * iOS files: `DeepgramRecordingViewModel.swift:6849-6912`,
 * `ServerWebSocketService.swift:544,968,972`,
 * `Views/Components/ChitchatPauseBanner.swift`.
 *
 * Backend wire shapes: `src/extraction/sonnet-stream.js` (search for
 * `chitchat_paused`, `chitchat_resumed`, `chitchat_resume`).
 *
 * These tests pin the SonnetSession-layer contract only — the
 * recording-context wiring (optimistic clear + 5s watchdog) lives in a
 * separate test alongside the banner UI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { SonnetSession } from '@/lib/recording/sonnet-session';

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

function seedToken(): void {
  localStorage.setItem('cm_token', 'fake-jwt-token');
}

describe('SonnetSession — chitchat-pause wire contract (iOS parity)', () => {
  let server: WS;

  beforeEach(() => {
    seedToken();
    server = new WS(SONNET_URL);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('decodes `chitchat_paused` and fires onChitchatPaused', async () => {
    const onChitchatPaused = vi.fn();
    const onChitchatResumed = vi.fn();
    const session = new SonnetSession({ onChitchatPaused, onChitchatResumed });

    session.connect({
      sessionId: 'sess-1',
      jobId: 'job-1',
      certificateType: 'EICR',
    });
    await server.connected;
    server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-1' }));

    server.send(JSON.stringify({ type: 'chitchat_paused' }));
    await Promise.resolve();

    expect(onChitchatPaused).toHaveBeenCalledTimes(1);
    expect(onChitchatResumed).not.toHaveBeenCalled();

    session.disconnect();
  });

  it('decodes `chitchat_resumed` and forwards the reason string', async () => {
    const onChitchatResumed = vi.fn();
    const session = new SonnetSession({ onChitchatResumed });

    session.connect({ sessionId: 'sess-2', jobId: 'job-2', certificateType: 'EICR' });
    await server.connected;
    server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-2' }));

    server.send(JSON.stringify({ type: 'chitchat_resumed', reason: 'wake_word_resume' }));
    await Promise.resolve();

    expect(onChitchatResumed).toHaveBeenCalledWith('wake_word_resume');

    session.disconnect();
  });

  it('tolerates `chitchat_resumed` with no reason (defaults to empty string)', async () => {
    const onChitchatResumed = vi.fn();
    const session = new SonnetSession({ onChitchatResumed });

    session.connect({ sessionId: 'sess-3', jobId: 'job-3', certificateType: 'EICR' });
    await server.connected;
    server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-3' }));

    server.send(JSON.stringify({ type: 'chitchat_resumed' }));
    await Promise.resolve();

    expect(onChitchatResumed).toHaveBeenCalledWith('');

    session.disconnect();
  });

  it('sendChitchatResume emits a `chitchat_resume` envelope', async () => {
    const session = new SonnetSession({});
    session.connect({ sessionId: 'sess-4', jobId: 'job-4', certificateType: 'EICR' });
    await server.connected;
    server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-4' }));

    // Drain any session_start / session_resume framing before we assert
    // on the chitchat_resume envelope shape.
    await server.nextMessage;

    session.sendChitchatResume();
    const raw = await server.nextMessage;
    const msg = JSON.parse(typeof raw === 'string' ? raw : '{}');

    expect(msg).toEqual({ type: 'chitchat_resume' });

    session.disconnect();
  });

  it('does not fire callbacks when the message type is unrelated', async () => {
    const onChitchatPaused = vi.fn();
    const onChitchatResumed = vi.fn();
    const session = new SonnetSession({ onChitchatPaused, onChitchatResumed });

    session.connect({ sessionId: 'sess-5', jobId: 'job-5', certificateType: 'EICR' });
    await server.connected;
    server.send(JSON.stringify({ type: 'session_ack', status: 'new', sessionId: 'srv-5' }));

    server.send(JSON.stringify({ type: 'cost_update', totalJobCost: 0.05 }));
    await Promise.resolve();

    expect(onChitchatPaused).not.toHaveBeenCalled();
    expect(onChitchatResumed).not.toHaveBeenCalled();

    session.disconnect();
  });
});
