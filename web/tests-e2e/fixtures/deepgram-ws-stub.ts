/**
 * Browser-side WebSocket stub for Deepgram + Sonnet.
 *
 * Why this exists: Playwright's `page.route()` can mock HTTP, but it
 * does NOT proxy WebSocket frames in a way that lets us write plausible
 * Deepgram / Sonnet replies. The reliable pattern on Chromium + WebKit
 * is to replace `window.WebSocket` before the app's code runs, via
 * `page.addInitScript()`.
 *
 * Contract:
 *   - Any WS to `api.deepgram.com` is intercepted. On `.send(PCM)` the
 *     stub emits one interim Results frame + one final Results frame so
 *     the transcript log populates in the overlay.
 *   - `CloseStream` control frame is accepted silently; client then
 *     calls `close()` which fires `close` with code 1000 (normal).
 *   - Any WS to the Sonnet WS endpoint (`/api/sonnet-stream`) is
 *     intercepted. It accepts `session_start` / transcript / `pause` /
 *     `resume` frames silently and replies to the first transcript
 *     with an empty `extraction_complete` envelope so the UI clears
 *     the "…extracting" state without the product ever noticing.
 *
 * Everything else falls through to the real WebSocket. The stub is
 * exported as a string so it can be passed to
 * `page.addInitScript({ content: DEEPGRAM_WS_STUB })` without an
 * external file load.
 *
 * The stub deliberately avoids any closure capture from the test —
 * it's serialised verbatim into the page and runs in the page context.
 */
export const DEEPGRAM_WS_STUB = `
(() => {
  const NativeWebSocket = window.WebSocket;
  const DG_HOST = 'api.deepgram.com';
  const SONNET_PATH = '/api/sonnet-stream';

  class MockWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.protocol = '';
      this.readyState = 0; // CONNECTING
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      const host = (() => {
        try { return new URL(this.url).host; } catch { return ''; }
      })();
      const path = (() => {
        try { return new URL(this.url).pathname; } catch { return ''; }
      })();

      if (host === DG_HOST) {
        this._kind = 'deepgram';
        // Subprotocol echo-back so the app's auth check passes on
        // browsers that read protocol after open.
        if (Array.isArray(protocols) && protocols[0]) {
          this.protocol = protocols[0];
        }
      } else if (path === SONNET_PATH) {
        this._kind = 'sonnet';
      } else {
        // Not ours — fall back to the real WebSocket so any other
        // wire (Next HMR etc.) keeps working.
        return new NativeWebSocket(url, protocols);
      }

      // Open on next microtask so the caller can attach handlers
      // before we fire open.
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this._fire('open', {});
      }, 10);
    }

    send(data) {
      if (this.readyState !== 1) return;

      if (this._kind === 'deepgram') {
        // Control frames come through as JSON strings; skip the
        // CloseStream explicitly and drop KeepAlive quietly.
        if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === 'CloseStream') return;
            if (msg && msg.type === 'KeepAlive') return;
          } catch {}
          return;
        }
        // Binary audio. Reply with exactly one interim + one final
        // on the first frame so the overlay flips from "Listening…"
        // to a real transcript. Subsequent frames fall silent — the
        // overlay already has what it needs to validate the flow.
        if (this._dgRepliedOnce) return;
        this._dgRepliedOnce = true;

        const mkResults = (isFinal, transcript) => JSON.stringify({
          type: 'Results',
          is_final: isFinal,
          channel: {
            alternatives: [{
              transcript,
              confidence: 0.95,
              words: [],
            }],
          },
        });

        setTimeout(() => this._fire('message', { data: mkResults(false, 'test reading') }), 20);
        setTimeout(() => this._fire('message', { data: mkResults(true, 'test reading') }), 40);
        return;
      }

      if (this._kind === 'sonnet') {
        // Sonnet envelope is JSON. We just ack a transcript with an
        // empty extraction so the UI doesn't stall on "extracting".
        try {
          const msg = typeof data === 'string' ? JSON.parse(data) : null;
          if (msg && msg.type === 'transcript' && !this._sonnetExtractedOnce) {
            this._sonnetExtractedOnce = true;
            setTimeout(() => this._fire('message', {
              data: JSON.stringify({
                type: 'extraction_complete',
                result: { readings: [], questions: [], field_clears: [] },
              }),
            }), 30);
          }
        } catch {}
        return;
      }
    }

    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3; // CLOSED
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
  // Mirror the standard constants.
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  window.WebSocket = MockWebSocket;
})();
`;
