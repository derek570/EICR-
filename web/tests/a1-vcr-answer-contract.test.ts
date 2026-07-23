/**
 * A1 agentic-voice (2026-07-23) — web companion tests.
 *
 * 1. CONTRACT: backend emit → JSON → web decode for the answer-bearing
 *    `voice_command_response` frame. The frame below is byte-shaped exactly
 *    as the backend sync emit site builds it (sonnet-stream.js:
 *    `{type, understood, spoken_response, action, utterance_id?}` — the
 *    P4d utterance_id stamp is emit-when-truthy). The web decoder
 *    (sonnet-session.ts `voice_command_response` case) surfaces
 *    `{understood, spoken_response, action}` — `utterance_id` is currently
 *    DISCARDED by both client decoders (PLAN-C owns decoding/propagating it
 *    for the chime watchdog; A1 only preserves the backend stamp).
 *
 * 2. REPLAY (toggle ON): the a1-vcr-answer-toggle-off scenario replayed
 *    with the confirmation toggle FORCED ON still plays the answer exactly
 *    once — force-speak must not double-play or change behaviour when the
 *    toggle would have allowed it anyway. (The toggle-OFF direction — the
 *    actual companion fix — runs as part of the scenario suite in
 *    pwa-replay-scenarios.test.ts via the fixture's `confirmation_mode:
 *    false`.)
 *
 * iOS decode side (contract-test convention, cited not executed):
 * ServerWebSocketService.swift:1093 → DeepgramRecordingViewModel.swift:8981
 * → handleVoiceCommandResponse (:9852) → speakBriefConfirmation (:9888,
 * unconditional — no toggle gate on the VCR path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SonnetSession } from '@/lib/recording/sonnet-session';
import { loadScenario } from './harness/scenario';
import { replayScenario } from './harness/runner';

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';
const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_FILE = path.resolve(
  here,
  '../../tests/fixtures/pwa-replay-sessions/a1-vcr-answer-toggle-off.yaml'
);

describe('A1 — voice_command_response answer contract (backend emit → web decode)', () => {
  let server: WS;

  beforeEach(() => {
    localStorage.setItem('cm_token', 'fake-jwt-token');
    server = new WS(SONNET_URL);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('decodes the answer-bearing VCR frame exactly as the backend sync site emits it', async () => {
    const onVoiceCommandResponse = vi.fn();
    const session = new SonnetSession({ onVoiceCommandResponse });
    session.connect({ sessionId: 'a1-contract-1', jobId: 'job-a1', certificateType: 'EICR' });
    await server.connected;

    // Byte-shape of the backend's sync emit (spoken answer projected from
    // result.spoken_response; utterance_id = the P4d response-epoch stamp).
    server.send(
      JSON.stringify({
        type: 'voice_command_response',
        understood: true,
        spoken_response: 'Circuit 4 still needs Zs and both insulation readings.',
        action: null,
        utterance_id: 'utt-epoch-1',
      })
    );
    await Promise.resolve();

    expect(onVoiceCommandResponse).toHaveBeenCalledTimes(1);
    expect(onVoiceCommandResponse).toHaveBeenCalledWith({
      understood: true,
      spoken_response: 'Circuit 4 still needs Zs and both insulation readings.',
      action: null,
    });
  });

  it('decodes a no-epoch frame identically (utterance_id key omitted — pre-A1 shape)', async () => {
    const onVoiceCommandResponse = vi.fn();
    const session = new SonnetSession({ onVoiceCommandResponse });
    session.connect({ sessionId: 'a1-contract-2', jobId: 'job-a1', certificateType: 'EICR' });
    await server.connected;

    server.send(
      JSON.stringify({
        type: 'voice_command_response',
        understood: true,
        spoken_response: "Sorry, I couldn't answer that — please ask it another way.",
        action: null,
      })
    );
    await Promise.resolve();

    expect(onVoiceCommandResponse).toHaveBeenCalledWith({
      understood: true,
      spoken_response: "Sorry, I couldn't answer that — please ask it another way.",
      action: null,
    });
  });
});

describe('A1 — VCR answer force-speak, toggle-ON regression (replay harness)', () => {
  it('plays the answer exactly once with the confirmation toggle ON', async () => {
    const scenario = loadScenario(SCENARIO_FILE);
    const result = await replayScenario(scenario, { confirmationMode: true });
    const answerPlays = result.trace.totals.confirmationsPlayed.filter((t) =>
      t.includes('Circuit 4 still needs Zs')
    );
    expect(answerPlays).toHaveLength(1);
  });
});
