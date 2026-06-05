/**
 * ElevenLabs TTS module tests — covers the parity port that mirrors iOS
 * `AlertManager.speakWithTTS` (AlertManager.swift:1029-1134) so the PWA
 * speaks Sonnet's `ask_user` questions in the same Archer Conversational
 * voice the inspector hears on iPad. Backend proxy is at
 * `/api/proxy/elevenlabs-tts` (src/routes/keys.js:223-312).
 *
 * What's covered:
 *   - Pre-flight short-circuits (no sessionId / no token / offline) skip
 *     the round-trip and surface the correct failure reason so tts.ts
 *     can decide whether to fall back.
 *   - Fetch failures (4xx / 5xx) surface `'fetch'` so tts.ts falls back.
 *   - cancelElevenLabs() aborts an in-flight fetch and surfaces
 *     `'aborted'` (NOT a fall-back trigger — used by Stop tap).
 *   - A second speakElevenLabs() supersedes the first by aborting it.
 *   - The Authorization header and POST body shape match the backend
 *     proxy's contract so the cost-tracker attribution lands.
 *
 * NOT covered here (left to Playwright E2E):
 *   - The HTMLMediaElement `play()` → `playing` → `ended` lifecycle.
 *     jsdom's media stub is a no-op and the shared audio element isn't
 *     reachable from test code without leaking module internals.
 *     Verifying that the lifecycle event listeners are attached and
 *     route to the right callbacks is exercised at the integration
 *     level by the recording-context tests; the headless browser
 *     covers the actual audio path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import {
  __resetElevenLabsForTests,
  cancelElevenLabs,
  isElevenLabsAvailable,
  primeAudioElement,
  setActiveSessionId,
  speakElevenLabs,
} from '@/lib/recording/elevenlabs-tts';

const API_BASE = 'http://localhost:3000';
const TOKEN_KEY = 'cm_token';

const server = setupServer();

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });

  // getToken() reads `cm_token` from localStorage in @/lib/auth.
  window.localStorage.setItem(TOKEN_KEY, 'test-token');

  // Patch the HTMLMediaElement prototype so play()/pause()/load() are
  // vi.fn no-ops. jsdom's defaults throw "Not implemented" warnings on
  // every call, which floods test output without affecting assertions.
  const proto = HTMLMediaElement.prototype as unknown as {
    play: () => Promise<void>;
    pause: () => void;
    load: () => void;
  };
  proto.play = vi.fn(() => Promise.resolve());
  proto.pause = vi.fn();
  proto.load = vi.fn();

  __resetElevenLabsForTests();
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  window.localStorage.clear();
  __resetElevenLabsForTests();
});

describe('isElevenLabsAvailable', () => {
  it('returns true in a browser-like context with fetch + Audio', () => {
    expect(isElevenLabsAvailable()).toBe(true);
  });
});

describe('primeAudioElement', () => {
  it('does not throw and is safe to call repeatedly', () => {
    expect(() => primeAudioElement()).not.toThrow();
    expect(() => primeAudioElement()).not.toThrow();
  });
});

describe('speakElevenLabs — pre-flight short-circuits', () => {
  it('calls onError("no-session") and resolves false when no sessionId is set', async () => {
    const onError = vi.fn();
    const ok = await speakElevenLabs('Hello', { onError });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('no-session');
  });

  it('calls onError("offline") when navigator.onLine is false', async () => {
    setActiveSessionId('sess_test_1');
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      const onError = vi.fn();
      const ok = await speakElevenLabs('Hello', { onError });
      expect(ok).toBe(false);
      expect(onError).toHaveBeenCalledWith('offline');
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'onLine', original);
      } else {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      }
    }
  });

  it('calls onError("no-token") when getToken() returns null', async () => {
    setActiveSessionId('sess_test_2');
    window.localStorage.removeItem(TOKEN_KEY);
    const onError = vi.fn();
    const ok = await speakElevenLabs('Hello', { onError });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('no-token');
  });
});

describe('speakElevenLabs — fetch wire format', () => {
  it('POSTs the correct headers + body to the proxy when sessionId is set', async () => {
    setActiveSessionId('sess_test_3');

    let receivedAuth: string | null = null;
    let receivedBody: { text?: string; sessionId?: string } | null = null;
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async ({ request }) => {
        receivedAuth = request.headers.get('Authorization');
        receivedBody = (await request.json()) as { text?: string; sessionId?: string };
        return new HttpResponse(new Uint8Array([0]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      })
    );

    // Don't await — speakElevenLabs only resolves on the audio
    // lifecycle which jsdom can't drive. Wait one tick for the fetch
    // round-trip then cancel to settle the promise.
    void speakElevenLabs('What is the Zs reading?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelElevenLabs();

    expect(receivedAuth).toBe('Bearer test-token');
    expect(receivedBody).toEqual({
      text: 'What is the Zs reading?',
      sessionId: 'sess_test_3',
    });
  });
});

describe('speakElevenLabs — fetch failures', () => {
  it('calls onError("fetch") on a 500 response and resolves false', async () => {
    setActiveSessionId('sess_test_4');
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, () =>
        HttpResponse.json({ error: 'oops' }, { status: 500 })
      )
    );
    const onError = vi.fn();
    const ok = await speakElevenLabs('Hello', { onError });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('fetch');
  });

  it('calls onError("fetch") on a 401 response so callers fall back to native', async () => {
    setActiveSessionId('sess_test_5');
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, () =>
        HttpResponse.json({ error: 'unauthenticated' }, { status: 401 })
      )
    );
    const onError = vi.fn();
    const ok = await speakElevenLabs('Hello', { onError });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('fetch');
  });
});

describe('cancelElevenLabs', () => {
  it('aborts an in-flight fetch and surfaces onError("aborted")', async () => {
    setActiveSessionId('sess_test_6');

    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async () => {
        // Hold the request open long enough for the abort to land.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return new HttpResponse(new Uint8Array([0]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      })
    );

    const onError = vi.fn();
    const promise = speakElevenLabs('Hello', { onError });

    // Wait one tick so the fetch has been issued.
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancelElevenLabs();

    const ok = await promise;
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith('aborted');
  });

  it('is safe to call when no request is in flight', () => {
    expect(() => cancelElevenLabs()).not.toThrow();
  });
});

describe('speakElevenLabs — concurrency', () => {
  it('a second speakElevenLabs() aborts the first', async () => {
    setActiveSessionId('sess_test_7');

    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async ({ request }) => {
        const body = (await request.json()) as { text?: string };
        if (body.text === 'first') {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        return new HttpResponse(new Uint8Array([0]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      })
    );

    const firstOnError = vi.fn();
    const firstPromise = speakElevenLabs('first', { onError: firstOnError });

    // Wait one tick so the first request is in flight before the
    // second supersedes it.
    await new Promise((resolve) => setTimeout(resolve, 10));

    void speakElevenLabs('second');

    // First should resolve quickly with aborted.
    const firstResult = await firstPromise;
    expect(firstResult).toBe(false);
    expect(firstOnError).toHaveBeenCalledWith('aborted');

    // Clean up the second to settle its promise.
    cancelElevenLabs();
  });
});
