/**
 * Burst-buffer parity scenarios.
 *
 * The 500 ms burst buffer is the PWA-side compensation for Deepgram
 * splitting a single conversational utterance into two finals (e.g.
 * "Observation." [350 ms gap] "There is a crack in a socket in a
 * bedroom."). Without it, Sonnet treats each half as its own turn and
 * — for the observation_confirmation case in sess_mp4jg2mt_231n
 * (2026-05-13) — emits a missing-context re-ask while the description
 * is still queued.
 *
 * iOS doesn't have this buffer (backend was kept immutable during the
 * 2026-05-13 fix per CLAUDE.md, so PWA absorbed the split client-side).
 * These scenarios pin the merge contract + the ' ... ' separator so it
 * can't drift.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { buildHarness, makeHarnessJob, type Harness } from './harness';

describe('parity harness — burst buffer (PWA-only, 2026-05-13)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({
      job: makeHarnessJob([{ ref: '1', designation: 'Immersion Heater' }]),
    });
  });

  afterEach(() => {
    h.teardown();
    WS.clean();
  });

  it('two finals inside the 500 ms window merge with " ... " separator', async () => {
    h.feedDeepgramFinal('Observation.', 0.92, { utteranceId: 'utt-bb-1' });
    h.feedDeepgramFinal('There is a crack in a socket in a bedroom.', 0.88, {
      utteranceId: 'utt-bb-2',
    });

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.type).toBe('transcript');
    expect(frame.text).toBe(
      // After number-normalisation neither half changes, so we expect the
      // verbatim concat. The space-around-dots is load-bearing — it mirrors
      // the server's legacy `_processUtteranceBatch` separator (sonnet-stream's
      // pre-2026-05-13 batcher).
      'Observation. ... There is a crack in a socket in a bedroom.'
    );

    // Exactly one transcript frame on the wire — the burst-merge collapsed
    // the two Deepgram finals into a single Sonnet turn.
    expect(h.server.messages.length).toBe(2); // 1 = session_start, 2 = the merged transcript
  });

  it('a single final dispatches normally after the window elapses', async () => {
    h.feedDeepgramFinal('Polarity OK.', 0.92, { utteranceId: 'utt-bb-3' });
    // Before timeout, nothing on the wire.
    expect(h.server.messages.length).toBe(1); // just session_start

    h.advance(500);

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.type).toBe('transcript');
    expect(frame.text).toBe('Polarity OK.');
  });

  it('flushBuffers on teardown dispatches any held final', async () => {
    h.feedDeepgramFinal('Held text', 0.9, { utteranceId: 'utt-bb-4' });
    h.flushBuffers();

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.text).toBe('Held text');
  });
});
