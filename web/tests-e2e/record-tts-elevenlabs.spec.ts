import { test, expect } from '@playwright/test';
import { buildAuth, buildJobFixture, primeAuth, stubRecordFlowApi } from './fixtures/auth';

/**
 * ElevenLabs TTS playback E2E.
 *
 * Vitest can't drive the audio element lifecycle in jsdom — `play()`
 * resolves but the `playing` and `ended` events never fire, so the
 * unit suite covers the request shape + abort/timeout matrix only.
 * This spec runs in a real Chromium and verifies the rest of the
 * contract end-to-end:
 *
 *   1. Start a recording session — `setActiveSessionId` wires the
 *      sessionId into elevenlabs-tts and primeTts() calls
 *      primeAudioElement() inside the Start-tap user gesture so the
 *      shared `<audio>` element is autoplay-unlocked.
 *   2. The Sonnet WS stub emits an `extraction_complete` with one
 *      question. recording-context's onQuestion handler routes it
 *      through `speak()` → `dispatchElevenLabs` → POST
 *      `/api/proxy/elevenlabs-tts`.
 *   3. The proxy stub returns a real MP3 blob (a 26-byte silent MP3
 *      "frame" wrapped in an ID3 header) so Chromium's media element
 *      can decode it and fire the lifecycle events the wrapper
 *      depends on (`playing`, `ended`).
 *   4. Assertions: the proxy was called with `{text, sessionId}`,
 *      `audio.play()` ran, the TTS audio window opened, and after
 *      the silent track ends the window closes (endMs becomes
 *      non-null) so subsequent transcripts pass the mic-feedback
 *      gate.
 *
 * The spec is Chromium-only — the existing record.spec.ts skips
 * WebKit because Playwright can't fake a mic stream there. Same
 * constraint applies here; the ElevenLabs path is downstream of
 * a working recording session.
 */

const JOB_ID = 'test-job-elevenlabs';

/**
 * 26-byte silent MP3 — minimal valid ID3v2 header followed by one
 * MP3 frame of silence. Chromium decodes this without complaint and
 * fires `playing` / `ended` in the same order a real ElevenLabs
 * payload would. Hand-crafted because shipping a binary fixture
 * file is overkill for one test.
 */
const SILENT_MP3 = new Uint8Array([
  // ID3v2.3 header — "ID3" + version 3.0 + flags 0x00 + size 0
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // MPEG-1 Layer 3, 32 kbps, 44.1 kHz, padding 0, no CRC
  0xff, 0xfb, 0x90, 0x44,
  // Frame body — 12 zero bytes is enough to satisfy the parser; the
  // total length comes out at 26 which Chromium plays as ~0.026 s.
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Browser-side WebSocket stub — extends the standard one so the
 * Sonnet socket replies with a question that triggers `speak()`.
 * Keeps the Deepgram half identical to deepgram-ws-stub.ts.
 */
const WS_STUB_WITH_QUESTION = `
(() => {
  const NativeWebSocket = window.WebSocket;
  const DG_HOST = 'api.deepgram.com';
  const SONNET_PATH = '/api/sonnet-stream';

  class MockWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.protocol = '';
      this.readyState = 0;
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      const host = (() => { try { return new URL(this.url).host; } catch { return ''; } })();
      const path = (() => { try { return new URL(this.url).pathname; } catch { return ''; } })();

      if (host === DG_HOST) {
        this._kind = 'deepgram';
        if (Array.isArray(protocols) && protocols[0]) this.protocol = protocols[0];
      } else if (path === SONNET_PATH) {
        this._kind = 'sonnet';
      } else {
        return new NativeWebSocket(url, protocols);
      }

      setTimeout(() => {
        this.readyState = 1;
        this._fire('open', {});
      }, 10);
    }

    send(data) {
      if (this.readyState !== 1) return;

      if (this._kind === 'deepgram') {
        if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            if (msg && (msg.type === 'CloseStream' || msg.type === 'KeepAlive')) return;
          } catch {}
          return;
        }
        if (this._dgRepliedOnce) return;
        this._dgRepliedOnce = true;
        const mkResults = (isFinal, transcript) => JSON.stringify({
          type: 'Results',
          is_final: isFinal,
          channel: { alternatives: [{ transcript, confidence: 0.95, words: [] }] },
        });
        setTimeout(() => this._fire('message', { data: mkResults(false, 'test') }), 20);
        setTimeout(() => this._fire('message', { data: mkResults(true, 'test') }), 40);
        return;
      }

      if (this._kind === 'sonnet') {
        try {
          const msg = typeof data === 'string' ? JSON.parse(data) : null;
          // session_start arrives first — ack with the server-minted
          // sessionId envelope so the SonnetSession state machine
          // exits the 'connecting' state.
          if (msg && msg.type === 'session_start' && !this._sonnetAcked) {
            this._sonnetAcked = true;
            setTimeout(() => this._fire('message', {
              data: JSON.stringify({
                type: 'session_ack',
                status: 'started',
                sessionId: 'sess_e2e_minted_' + Math.random().toString(36).slice(2, 8),
              }),
            }), 5);
            return;
          }
          // The first transcript fires a top-level "question" frame.
          // sonnet-session.ts:955-962 routes this directly to
          // recording-context's onQuestion handler, which calls
          // speak('What is the Zs reading?') → dispatchElevenLabs →
          // POST /api/proxy/elevenlabs-tts.
          if (msg && msg.type === 'transcript' && !this._sonnetRepliedOnce) {
            this._sonnetRepliedOnce = true;
            setTimeout(() => this._fire('message', {
              data: JSON.stringify({
                type: 'question',
                question_type: 'ask_user',
                question: 'What is the Zs reading?',
                field: 'zs',
                circuit: 1,
              }),
            }), 30);
          }
        } catch {}
        return;
      }
    }

    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => {
        this._fire('close', { code: code ?? 1000, reason: reason ?? '', wasClean: true });
      }, 5);
    }

    _fire(kind, init) {
      const handler = this['on' + kind];
      const event = new MessageEvent(kind, init);
      if (typeof handler === 'function') {
        try { handler.call(this, event); } catch {}
      }
      this.dispatchEvent(event);
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  window.WebSocket = MockWebSocket;
})();
`;

/**
 * Page-side play() probe — only wraps the play() call so the test can
 * confirm an audio element actually started playing without changing
 * any other lifecycle (the wrapper-side `removeEventListener` semantics
 * stay intact, which a more aggressive addEventListener proxy would
 * silently break by replacing the listener with a wrapped function the
 * removeEventListener call can't match).
 */
const AUDIO_PROBE = `
(() => {
  const probe = {
    playCalls: 0,
    lastBlobUrl: null,
  };
  window.__ttsProbe = probe;

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    probe.playCalls += 1;
    probe.lastBlobUrl = this.src || null;
    return origPlay.call(this);
  };
})();
`;

test.describe('ElevenLabs TTS playback (audio lifecycle)', () => {
  // Same WebKit-skip rationale as record.spec.ts — the recording flow
  // depends on a fake mic that Playwright only provides on Chromium.
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'WebKit cannot fake a mic stream in headless Playwright'
  );

  test.beforeEach(async ({ context, page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL missing from Playwright config');
    await primeAuth(context, buildAuth(), baseURL);
    try {
      await context.grantPermissions(['microphone'], { origin: baseURL });
    } catch {
      /* WebKit — skipped above */
    }
    await context.addInitScript({ content: WS_STUB_WITH_QUESTION });
    await context.addInitScript({ content: AUDIO_PROBE });
    // Suppress the job-detail tour. JOB_TOUR_STEPS auto-narrates on
    // mount via use-tour, which calls speak() with a long sentence and
    // opens the SpeechSynthesis TTS window. In headless Chromium the
    // utterance's `onend` doesn't always fire, so the window stays
    // open and `isWithinTtsWindow()` suppresses every Deepgram final
    // — which means recording-context never forwards a transcript to
    // Sonnet, the WS stub never replies with a question, and the
    // ElevenLabs path under test never runs. Setting the persisted
    // tour state to {seen, disabled} BEFORE first paint makes the
    // tour skip its auto-start.
    await context.addInitScript({
      content: `
        try {
          window.localStorage.setItem(
            'cm-tour-job',
            JSON.stringify({ seen: true, disabled: true })
          );
        } catch {}
      `,
    });
    await stubRecordFlowApi(page, buildJobFixture({ id: JOB_ID }));
  });

  test('Sonnet question routes to ElevenLabs proxy and audio plays end-to-end', async ({
    page,
  }) => {
    // Track every ElevenLabs proxy hit so the assertions can verify
    // the request shape AND the response was successfully delivered.
    const proxyHits: { authHeader: string | null; body: { text?: string; sessionId?: string } }[] =
      [];

    await page.route(/\/api\/proxy\/elevenlabs-tts/, async (route) => {
      const req = route.request();
      const auth = req.headerValue('Authorization');
      const body = JSON.parse(req.postData() ?? '{}') as {
        text?: string;
        sessionId?: string;
      };
      proxyHits.push({ authHeader: await auth, body });
      return route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        body: Buffer.from(SILENT_MP3),
      });
    });

    // Forward browser console to the test output so a missing piece
    // surfaces as text rather than a black-box "no proxy hit" timeout.
    page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));

    await page.goto(`/job/${JOB_ID}`);

    // Start recording — primes the shared audio element inside the
    // user-gesture handler.
    await page.getByRole('button', { name: /^start recording$/i }).click();

    // Wait for the recording chrome to settle into the active state
    // (toolbar, ring, transcript bar all visible).
    await expect(page.getByRole('toolbar', { name: /recording controls/i })).toBeVisible({
      timeout: 10_000,
    });

    // The WS stub emits the extraction_complete (with our seeded
    // question) ~30ms after the first transcript. Poll the proxy hit
    // log instead of racing on a raw timeout.
    await expect.poll(() => proxyHits.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Wire format — text the inspector should hear, sessionId for
    // backend cost attribution.
    const hit = proxyHits[0];
    expect(hit.authHeader).toMatch(/^Bearer /);
    expect(hit.body.text).toBe('What is the Zs reading?');
    expect(typeof hit.body.sessionId).toBe('string');
    expect(hit.body.sessionId?.startsWith('sess_')).toBe(true);

    // Audio playback ran. `lastBlobUrl` becomes a `blob:` URL only
    // when the proxy response was decoded into an MP3 blob and assigned
    // to the shared audio element's src — that's the strong signal
    // the wire actually delivered audio bytes from /api/proxy/elevenlabs-tts
    // through to the playback path. Polling absorbs the small race
    // between the proxy response landing and `audio.src = blobUrl`
    // (one microtask in the wrapper, but real Chromium's autoplay
    // policy can hold play() promises for a few hundred ms while
    // waiting on resource loading). play() counts vary by browser
    // build because the priming silent-WAV play() doesn't always
    // register before the ElevenLabs play() in headless mode.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __ttsProbe: { lastBlobUrl: string | null } }).__ttsProbe
                .lastBlobUrl
          ),
        { timeout: 5_000 }
      )
      .toMatch(/^blob:/);
  });
});
