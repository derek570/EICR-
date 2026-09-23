/**
 * PLAN-D Acceptance 16 — the WEB TWIN, asserted and not claimed as new.
 *
 * The resume line (and every voice-pause string) rides the protected
 * mode-status family of the confirmation FIFO. On web that route is already
 * local-capable: `playConfirmationHead` falls through to
 * `playConfirmationNative` (`speechSynthesis`) on a pre-playback ElevenLabs
 * failure. This test drives the REAL `speakConfirmationModeStatus` →
 * `tts-queue` → `playConfirmationHead` path against a failing proxy and
 * asserts the line reaches NATIVE playback start, and that the per-head
 * playback observer — the seam `voice_pause_speech_spoken` is emitted from —
 * fires at that native start, not at enqueue. No baseline-red claim: the
 * fallback predates PLAN-D; only the observer is new.
 *
 * It also pins the observer's own contract: 'start' fires for every head at
 * real audio start, and 'end' for a started head at its terminal, including
 * a manual teardown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { __resetElevenLabsForTests, setActiveSessionId } from '@/lib/recording/elevenlabs-tts';
import {
  __resetModeStatusCuesForTests,
  __resetTtsFingerprintsForTests,
  __resetTtsWindowForTests,
  handleModeStatusCueDiscard,
  handleModeStatusCuePlaybackStarted,
  speakConfirmationModeStatus,
} from '@/lib/recording/tts';
import {
  __resetForTests as __resetTtsQueueForTests,
  enqueueConfirmation,
  preemptFlush,
  setHeadPlaybackObserver,
  setOnDiscarded,
  setOnPlaybackStarted,
  type QueuePlayControls,
} from '@/lib/recording/tts-queue';
import { VOICE_PAUSE_STRINGS } from '@/lib/recording/voice-pause';

const API_BASE = 'http://localhost:3000';
const server = setupServer();

class UtteranceShim {
  constructor(public text: string) {}
  lang = 'en-GB';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
}
class SynthShim {
  cancel = vi.fn();
  getVoices = vi.fn(() => [] as SpeechSynthesisVoice[]);
  spoken: UtteranceShim[] = [];
  speak = vi.fn((u: UtteranceShim) => {
    this.spoken.push(u);
  });
}
let shim: SynthShim;

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });
  window.localStorage.setItem('cm_token', 'test-token');
  shim = new SynthShim();
  Object.defineProperty(window, 'speechSynthesis', {
    value: shim,
    writable: true,
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    UtteranceShim;
  const proto = HTMLMediaElement.prototype as unknown as {
    play: () => Promise<void>;
    pause: () => void;
    load: () => void;
  };
  proto.play = vi.fn(() => Promise.resolve());
  proto.pause = vi.fn();
  proto.load = vi.fn();
  __resetElevenLabsForTests();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetTtsFingerprintsForTests();
  setOnDiscarded((dedupeKey, reason) => {
    handleModeStatusCueDiscard(dedupeKey, reason);
  });
  setOnPlaybackStarted((dedupeKey) => {
    handleModeStatusCuePlaybackStarted(dedupeKey);
  });
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  window.localStorage.clear();
  __resetElevenLabsForTests();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetTtsFingerprintsForTests();
});

describe('PLAN-D Acceptance 16 (web twin) — the resume line routes locally', () => {
  it('a failing ElevenLabs fetch reaches native playback, and the observer fires at native start', async () => {
    setActiveSessionId('sess-pland-16');
    let fetches = 0;
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, () => {
        fetches += 1;
        return new HttpResponse('upstream down', { status: 503 });
      })
    );
    const events: Array<[string, string, string | undefined]> = [];
    setHeadPlaybackObserver((event, item) => events.push([event, item.text, item.dedupeKey]));

    speakConfirmationModeStatus(VOICE_PAUSE_STRINGS.resume_line.text);
    // Nothing is reported at enqueue.
    expect(events).toEqual([]);
    await vi.waitFor(() => expect(shim.spoken).toHaveLength(1));
    expect(fetches).toBe(1);
    expect(shim.spoken[0].text).toBe(VOICE_PAUSE_STRINGS.resume_line.text);
    expect(events).toEqual([]);

    shim.spoken[0].onstart?.();
    expect(events).toEqual([['start', VOICE_PAUSE_STRINGS.resume_line.text, 'mode-status:1']]);
    shim.spoken[0].onend?.();
    expect(events.at(-1)).toEqual(['end', VOICE_PAUSE_STRINGS.resume_line.text, 'mode-status:1']);
  });
});

describe('PLAN-D — the FIFO per-head playback observer', () => {
  function manualPlayer(record: { onEnd?: () => void }) {
    return (_text: string, controls: QueuePlayControls) => {
      controls.ready({
        play: () => {
          controls.onStart();
          record.onEnd = controls.onEnd;
        },
        discard: () => {},
      });
    };
  }

  it('fires start for un-keyed heads and end at the natural terminal', () => {
    const events: string[] = [];
    setHeadPlaybackObserver((event, item) => events.push(`${event}:${item.text}`));
    const rec: { onEnd?: () => void } = {};
    enqueueConfirmation({ text: 'Noted.', play: manualPlayer(rec) });
    expect(events).toEqual(['start:Noted.']);
    rec.onEnd?.();
    expect(events).toEqual(['start:Noted.', 'end:Noted.']);
  });

  it('fires end when a started head is torn down, and nothing for a never-started one', () => {
    const events: string[] = [];
    setHeadPlaybackObserver((event, item) => events.push(`${event}:${item.text}`));
    const rec: { onEnd?: () => void } = {};
    enqueueConfirmation({ text: 'Playing', play: manualPlayer(rec) });
    enqueueConfirmation({ text: 'Queued', play: manualPlayer({}) });
    preemptFlush();
    expect(events).toEqual(['start:Playing', 'end:Playing']);
  });
});
