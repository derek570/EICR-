/**
 * Plan B (feedback ids 118/119) B1.2/B3.1 — the fast-TTS route's wiring into
 * fast-path-accepted-identity.js. Pins:
 *   - markFastAttemptPending fires once validateBody succeeds, BEFORE any
 *     later gate (eligibility/session/capability/etc.) can still reject.
 *   - commitAcceptedIdentity fires EXACTLY ONCE, on the FIRST onAudio byte —
 *     NOT once per streamed chunk (a D1 fail-open retry or a chunky mock
 *     stream must not double-commit).
 *   - markFastAttemptFailed fires on every reject path that funnels through
 *     rejectWithDecrement (a gate reject AND a pre-first-byte synth
 *     failure) — and is NEVER called on the happy path.
 *   - the kill-switch short-circuit (which returns before validateBody even
 *     runs) touches the ledger not at all.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 'test-user' };
    next();
  },
}));

jest.unstable_mockModule('../services/secrets.js', () => ({
  getElevenLabsKey: async () => 'test-elevenlabs-key',
}));

const markFastAttemptPending = jest.fn();
const commitAcceptedIdentity = jest.fn();
const markFastAttemptFailed = jest.fn();
jest.unstable_mockModule('../extraction/fast-path-accepted-identity.js', () => ({
  markFastAttemptPending,
  commitAcceptedIdentity,
  markFastAttemptFailed,
  markFastAttemptPlaybackStarted: jest.fn(),
}));

const { activeSessions } = await import('../extraction/active-sessions.js');
const turnSummary = await import('../extraction/voice-latency-turn-summary.js');
const fastTtsRouter = (await import('../routes/voice-latency-fast-tts.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', fastTtsRouter);
  return app;
}

function seedSession({
  sessionId = 'SESS',
  regexFastTts = true,
  hasRegexFastV2 = true,
  spec = { abortBySlot: jest.fn() },
} = {}) {
  activeSessions.set(sessionId, {
    userId: 'test-user',
    session: { sessionId, stateSnapshot: { boards: [] }, loadedBarrelSpeculator: spec },
    voiceLatency: { flags: { regexFastTts }, capabilities: { hasRegexFastV2 } },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
  });
}

function basicBody(overrides = {}) {
  return {
    sessionId: 'SESS',
    turnId: 'T1',
    correlationId: 'cid-abc-123',
    transcript: 'Circuit 1 Zs 0.62',
    candidate: { field: 'measured_zs_ohm', circuit: 1, value: '0.62' },
    ...overrides,
  };
}

async function postFastTts(body) {
  return request(buildApp())
    .post('/api/voice-latency/regex-fast-tts')
    .send(body)
    .buffer(true)
    .parse((response, cb) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

beforeEach(() => {
  activeSessions.clear();
  turnSummary._resetForTests();
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
  markFastAttemptPending.mockClear();
  commitAcceptedIdentity.mockClear();
  markFastAttemptFailed.mockClear();
});
afterEach(() => {
  activeSessions.clear();
  turnSummary._resetForTests();
});

describe('happy path — one ElevenLabs chunk (default mock)', () => {
  beforeEach(() => {
    // See the F6 "commit throw" describe below for why `resetModules()` is
    // required here too: without it, a mock re-registered for a
    // DYNAMICALLY-imported specifier doesn't take effect for a describe
    // running after the first one to trigger that import in this file.
    jest.resetModules();
    jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
      ElevenLabsStreamClient: class {
        constructor(opts) {
          this.outputFormat = opts.outputFormat;
        }
        async synth(_text, opts) {
          opts.onAudio(Buffer.from([0x49, 0x44, 0x33]));
          return { firstAudioNs: 0n, lastAudioNs: 0n };
        }
        static logSynthSpans() {}
      },
      contentTypeForFormat: () => 'audio/mpeg',
      synthWithLanguageFailOpen: jest.fn(async (client, _retry, text, opts) => ({
        timings: await client.synth(text, opts),
        client,
        attempts: 1,
      })),
    }));
  });

  test('markFastAttemptPending fires once, BEFORE eligibility can reject', async () => {
    seedSession();
    await postFastTts(basicBody());
    expect(markFastAttemptPending).toHaveBeenCalledTimes(1);
    expect(markFastAttemptPending).toHaveBeenCalledWith(
      'cid-abc-123',
      expect.objectContaining({
        sessionId: 'SESS',
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
        rawValue: '0.62',
      })
    );
  });

  test('commitAcceptedIdentity fires exactly once on success', async () => {
    seedSession();
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(200);
    expect(commitAcceptedIdentity).toHaveBeenCalledTimes(1);
    expect(commitAcceptedIdentity).toHaveBeenCalledWith(
      'cid-abc-123',
      expect.objectContaining({
        sessionId: 'SESS',
        turnId: 'T1',
        field: 'measured_zs_ohm',
        circuit: 1,
        canonicalValue: '0.62',
        comparisonText: expect.any(String),
      })
    );
  });

  test('markFastAttemptFailed is NEVER called on the happy path', async () => {
    seedSession();
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(200);
    expect(markFastAttemptFailed).not.toHaveBeenCalled();
  });
});

describe('multiple onAudio chunks — commit fires ONCE, not per chunk', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
      ElevenLabsStreamClient: class {
        constructor(opts) {
          this.outputFormat = opts.outputFormat;
        }
        async synth(_text, opts) {
          // Simulate a chunky stream — THREE separate onAudio calls.
          opts.onAudio(Buffer.from([0x49]));
          opts.onAudio(Buffer.from([0x44]));
          opts.onAudio(Buffer.from([0x33]));
          return { firstAudioNs: 0n, lastAudioNs: 0n };
        }
        static logSynthSpans() {}
      },
      contentTypeForFormat: () => 'audio/mpeg',
      synthWithLanguageFailOpen: jest.fn(async (client, _retry, text, opts) => ({
        timings: await client.synth(text, opts),
        client,
        attempts: 1,
      })),
    }));
  });

  test('commitAcceptedIdentity is called exactly ONCE despite three onAudio writes', async () => {
    seedSession();
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(200);
    expect(commitAcceptedIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('Codex diff-review F6 (2026-08-13) — an empty-buffer onAudio call never commits', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
      ElevenLabsStreamClient: class {
        constructor(opts) {
          this.outputFormat = opts.outputFormat;
        }
        async synth(_text, opts) {
          // An EMPTY buffer first (e.g. a keepalive/zero-length frame from
          // the vendor) — must never trigger a commit — followed by a real
          // chunk that must.
          opts.onAudio(Buffer.alloc(0));
          opts.onAudio(Buffer.from([0x49, 0x44, 0x33]));
          return { firstAudioNs: 0n, lastAudioNs: 0n };
        }
        static logSynthSpans() {}
      },
      contentTypeForFormat: () => 'audio/mpeg',
      synthWithLanguageFailOpen: jest.fn(async (client, _retry, text, opts) => ({
        timings: await client.synth(text, opts),
        client,
        attempts: 1,
      })),
    }));
  });

  test('the empty-buffer call is skipped entirely; the later real chunk is the ONE commit', async () => {
    seedSession();
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(200);
    expect(commitAcceptedIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('Codex diff-review F6 (2026-08-13) — a commit throw does not permanently give up', () => {
  beforeEach(() => {
    // A dynamically-imported specifier (`../extraction/elevenlabs-stream-client.js`
    // is `await import()`ed fresh INSIDE the route handler on every request)
    // is cached by the module loader after its FIRST resolution within this
    // test file's run — re-registering `jest.unstable_mockModule` for it in
    // a later describe's `beforeEach` does NOT retroactively change what an
    // earlier-resolved dynamic `import()` returns. `jest.resetModules()`
    // clears that cache so THIS describe's distinct two-real-chunk mock
    // actually takes effect (verified: without this, the route silently
    // kept using whichever describe's mock resolved first in file order).
    jest.resetModules();
    jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
      ElevenLabsStreamClient: class {
        constructor(opts) {
          this.outputFormat = opts.outputFormat;
        }
        async synth(_text, opts) {
          // TWO real (non-empty) chunks — the first hits a throwing
          // commitAcceptedIdentity mock, the second must still retry.
          opts.onAudio(Buffer.from([0x49]));
          opts.onAudio(Buffer.from([0x44]));
          return { firstAudioNs: 0n, lastAudioNs: 0n };
        }
        static logSynthSpans() {}
      },
      contentTypeForFormat: () => 'audio/mpeg',
      synthWithLanguageFailOpen: jest.fn(async (client, _retry, text, opts) => ({
        timings: await client.synth(text, opts),
        client,
        attempts: 1,
      })),
    }));
  });

  test('a commitAcceptedIdentity throw on the first real chunk lets a SECOND real chunk retry (and this time succeed)', async () => {
    seedSession();
    commitAcceptedIdentity.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(200);
    // First attempt threw (swallowed internally, `identityCommitted` stayed
    // false); second attempt was ATTEMPTED and this time succeeded.
    expect(commitAcceptedIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('reject paths — markFastAttemptFailed fires, commit never does', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
      ElevenLabsStreamClient: class {
        async synth() {
          return { firstAudioNs: 0n, lastAudioNs: 0n };
        }
        static logSynthSpans() {}
      },
      contentTypeForFormat: () => 'audio/mpeg',
      synthWithLanguageFailOpen: jest.fn(),
    }));
  });

  test('kill switch (503) — touches the ledger not at all (correlationId never read)', async () => {
    seedSession();
    process.env.VOICE_LATENCY_KILL_SWITCH = 'true';
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(503);
    expect(markFastAttemptPending).not.toHaveBeenCalled();
    expect(markFastAttemptFailed).not.toHaveBeenCalled();
    expect(commitAcceptedIdentity).not.toHaveBeenCalled();
  });

  test('validateBody failure (400, missing sessionId) — pending never marked, failed IS marked', async () => {
    seedSession();
    const res = await postFastTts({ ...basicBody(), sessionId: '' });
    expect(res.status).toBe(400);
    expect(markFastAttemptPending).not.toHaveBeenCalled();
    expect(markFastAttemptFailed).toHaveBeenCalledWith('', 'cid-abc-123');
  });

  test('eligibility gate (422) — pending WAS marked (validateBody succeeded), then failed', async () => {
    seedSession();
    const res = await postFastTts({
      ...basicBody(),
      candidate: { field: 'polarity_confirmed', circuit: 1, value: 'true' },
    });
    expect(res.status).toBe(422);
    expect(markFastAttemptPending).toHaveBeenCalledTimes(1);
    expect(markFastAttemptFailed).toHaveBeenCalledWith('SESS', 'cid-abc-123');
    expect(commitAcceptedIdentity).not.toHaveBeenCalled();
  });

  test('session-not-found (404) — pending marked, then failed; commit never fires', async () => {
    // No seedSession — session genuinely absent.
    const res = await postFastTts(basicBody());
    expect(res.status).toBe(404);
    expect(markFastAttemptPending).toHaveBeenCalledTimes(1);
    expect(markFastAttemptFailed).toHaveBeenCalledWith('SESS', 'cid-abc-123');
    expect(commitAcceptedIdentity).not.toHaveBeenCalled();
  });
});
