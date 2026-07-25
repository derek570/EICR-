/**
 * Plan D (2026-07-25, feedback id 100(b)) — the fast-TTS route seam.
 *
 * This route is the THIRD independent producer of spoken confirmation text and
 * the LOWEST-latency one: iOS plays the returned MP3 within ~500 ms, long
 * before the model's tool call reaches any dispatcher. It is therefore the seam
 * most likely to actually be HEARD, so an unclamped read-back here speaks the
 * raw dictated number while the dispatcher later stores the clamped one — the
 * C06B9904 defect via the fastest channel.
 *
 * Lives in its own file because `jest.unstable_mockModule` must precede the
 * dynamic `await import` of the router, which cannot coexist with the static
 * imports in `stage6-impedance-clamp.test.js`.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/** Every text handed to ElevenLabs, in order. The route synthesises the exact
 *  confirmation string (no TTS expansion at this seam), so this IS the
 *  observable spoken line. */
const synthTexts = [];

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 'test-user' };
    next();
  },
}));

jest.unstable_mockModule('../extraction/elevenlabs-stream-client.js', () => ({
  ElevenLabsStreamClient: class {
    constructor(opts) {
      this.outputFormat = opts.outputFormat;
    }
    async synth(text, opts) {
      synthTexts.push(text);
      opts.onAudio(Buffer.from([0x49, 0x44, 0x33]));
      return { firstAudioNs: 0n, lastAudioNs: 0n };
    }
    static logSynthSpans() {}
  },
  contentTypeForFormat: () => 'audio/mpeg',
}));

jest.unstable_mockModule('../services/secrets.js', () => ({
  getElevenLabsKey: async () => 'test-elevenlabs-key',
}));

const { activeSessions } = await import('../extraction/active-sessions.js');
const turnSummary = await import('../extraction/voice-latency-turn-summary.js');
const fastTtsRouter = (await import('../routes/voice-latency-fast-tts.js')).default;
const { buildConfirmationText } = await import('../extraction/confirmation-text.js');
const { createPerTurnWrites } = await import('../extraction/stage6-per-turn-writes.js');
const { createWriteDispatcher } = await import('../extraction/stage6-dispatchers.js');
const { bundleToolCallsIntoResult } = await import('../extraction/stage6-event-bundler.js');
const { ensureMultiBoardShape } = await import('../extraction/stage6-multi-board-shape.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', fastTtsRouter);
  return app;
}

function seedSession({ sessionId = 'SESS', earthing = 'TN-C-S' } = {}) {
  // The route resolves earthing off the SESSION snapshot, so the seeded origin
  // supply has to be present exactly as the real seeder writes it.
  const stateSnapshot = { boards: [], circuits: { 0: { earthing_arrangement: earthing }, 4: {} } };
  activeSessions.set(sessionId, {
    session: { sessionId, stateSnapshot, loadedBarrelSpeculator: null },
    voiceLatency: { flags: { regexFastTts: true }, capabilities: { hasRegexFastV2: true } },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
  });
}

function post(candidate) {
  return request(buildApp())
    .post('/api/voice-latency/regex-fast-tts')
    .send({
      sessionId: 'SESS',
      turnId: 'T1',
      correlationId: 'cid-clamp-1',
      transcript: 'dictated',
      candidate,
    })
    .buffer(true)
    .parse((response, cb) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

beforeEach(() => {
  synthTexts.length = 0;
  activeSessions.clear();
  turnSummary._resetForTests();
  process.env.VOICE_LATENCY_KILL_SWITCH = '';
});
afterEach(() => {
  activeSessions.clear();
  turnSummary._resetForTests();
});

describe('fast-TTS route — impedance clamp', () => {
  test('an eligible r1_r2_ohm of 16 is CLAMPED before it is spoken, and the clause is spoken', async () => {
    seedSession();
    const res = await post({ field: 'r1_r2_ohm', circuit: 4, value: '16' });
    expect(res.status).toBe(200);
    // DISCRIMINATING on content: on unfixed `main` this route synthesises
    // "Circuit 4, R1 plus R2 16" — the inspector hears a number that is not
    // what the dispatcher goes on to store.
    expect(synthTexts).toEqual(['Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6']);
  });

  test('an in-band r1_r2_ohm is spoken BYTE-IDENTICALLY to pre-Plan-D', async () => {
    seedSession();
    await post({ field: 'r1_r2_ohm', circuit: 4, value: '0.35' });
    expect(synthTexts).toEqual(['Circuit 4, R1 plus R2 0.35']);
  });

  test('measured_zs_ohm passes through BYTE-UNCHANGED — a 16 Ω circuit Zs is legitimate', async () => {
    seedSession();
    await post({ field: 'measured_zs_ohm', circuit: 4, value: '16' });
    expect(synthTexts).toEqual(['Circuit 4, Zs 16']);
  });

  test('the continuity clamp is earthing-INDEPENDENT (an unresolved arrangement still clamps)', async () => {
    seedSession({ earthing: null });
    await post({ field: 'r1_r2_ohm', circuit: 4, value: '16' });
    expect(synthTexts).toEqual(['Circuit 4, R1 plus R2 recorded as 1.6 — I corrected 16 to 1.6']);
  });

  test('route text is BYTE-IDENTICAL to the server confirmation for the same slot', async () => {
    // The Pivot-3 canonical-text contract. If these two producers drift, the
    // inspector hears the fast line and then a second, contradictory one.
    seedSession();
    await post({ field: 'r1_r2_ohm', circuit: 4, value: '16' });

    const snapshot = { circuits: { 0: { earthing_arrangement: 'TN-C-S' }, 4: {} } };
    ensureMultiBoardShape(snapshot);
    const session = { sessionId: 'SESS', stateSnapshot: snapshot, extractedObservations: [] };
    const writes = createPerTurnWrites();
    const dispatch = createWriteDispatcher(
      session,
      { info: jest.fn(), warn: jest.fn() },
      't1',
      writes
    );
    await dispatch(
      {
        tool_call_id: 'tu1',
        name: 'record_reading',
        input: {
          field: 'r1_r2_ohm',
          circuit: 4,
          value: '16',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );
    const result = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      {
        confirmationsEnabled: true,
        turnId: 't1',
      }
    );

    expect(result.confirmations).toHaveLength(1);
    expect(synthTexts[0]).toBe(result.confirmations[0].text);
    // Pinned to the literal too, so the pair can't drift TOGETHER into silence
    // about the correction.
    expect(synthTexts[0]).toBe(
      buildConfirmationText('r1_r2_ohm', '1.6', 4, null, {
        correction: { original: '16', corrected: '1.6', divisor: 10 },
      })
    );
  });
});
