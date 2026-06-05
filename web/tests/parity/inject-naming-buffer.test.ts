/**
 * Naming-buffer parity scenarios — Bug K (2026-05-11, sess_mp19b6tf_i5xc).
 *
 * Deepgram occasionally chunks "Circuit N is X" across two finals:
 *   final 1: "Circuit 2 is" (no completion)
 *   final 2: "downstairs sockets"
 *
 * Without buffering, Sonnet sees these as two unrelated utterances:
 *   - Turn 1 has nothing to do — `create_circuit` doesn't fire.
 *   - Turn 2 ("downstairs sockets") routes via DESCRIPTION MATCHING
 *     against the existing schedule, which can rename an unrelated
 *     circuit instead of creating circuit 2.
 *
 * The naming buffer detects the trailing-naming pattern on final 1,
 * holds for 3000 ms, and concatenates with the next final so the
 * regex matcher sees both halves in the same cumulative pass AND
 * Sonnet sees them as a single turn. Same regex shape on iOS — keep
 * the two clients buffering identically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { buildHarness, makeHarnessJob, type Harness } from './harness';

describe('parity harness — naming buffer (Bug K)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({
      job: makeHarnessJob([
        { ref: '1', designation: 'Immersion Heater' },
        { ref: '2', designation: 'Downstairs Sockets' },
      ]),
    });
  });

  afterEach(() => {
    h.teardown();
    WS.clean();
  });

  it('"Circuit 2 is" + "downstairs sockets" arrives at Sonnet as one merged turn', async () => {
    h.feedDeepgramFinal('Circuit 2 is', 0.95, { utteranceId: 'utt-nb-1' });
    // Nothing on the wire yet — held by the naming buffer.
    expect(h.server.messages.length).toBe(1); // just session_start

    h.feedDeepgramFinal('downstairs sockets', 0.91, { utteranceId: 'utt-nb-2' });
    // After concat the joined text is no longer a trailing-naming
    // pattern, so the burst buffer takes over — still nothing on the
    // wire until either the 500 ms window elapses or another final
    // arrives.
    expect(h.server.messages.length).toBe(1);

    h.advance(500);

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.type).toBe('transcript');
    // Concat path uses a single space (NamingBuffer separator),
    // distinct from the burst buffer's ' ... '.
    expect(frame.text).toBe('Circuit 2 is downstairs sockets');
  });

  it('timeout-flushes the held preface alone if no completion arrives', async () => {
    h.feedDeepgramFinal('Circuit 5 is', 0.93, { utteranceId: 'utt-nb-3' });
    expect(h.server.messages.length).toBe(1);

    // Burn through the naming window first (3000 ms), then the burst
    // window (500 ms).
    h.advance(3000);
    h.advance(500);

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.text).toBe('Circuit 5 is');
  });

  it('does NOT buffer when the utterance continues past "is"', async () => {
    h.feedDeepgramFinal('Circuit 1 is a cooker', 0.94, { utteranceId: 'utt-nb-4' });
    // Naming pattern requires "is" at end-of-string — this one bypasses
    // the naming buffer. The burst buffer takes the final and holds it
    // until the window elapses (no second final to merge with).
    expect(h.server.messages.length).toBe(1);

    h.advance(500);

    const frame = (await h.nextWireMessage()) as { type: string; text: string };
    expect(frame.text).toBe('Circuit 1 is a cooker');
  });
});
