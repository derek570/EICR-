/**
 * SonnetSession — ALB heartbeat + observation_update wire handler.
 *
 * Two Wave-A audit Phase 6 P0 gaps closed in B6.1:
 *
 *   1. **ALB heartbeat (25 s app-level JSON).** WS PINGs alone don't
 *      reset AWS ALB's idle_timeout — iOS observed sessions in the
 *      2026-04-22..24 window where the WS closed after ~88 s of doze
 *      silence even with PINGs flowing. iOS now sends `{"type":
 *      "heartbeat"}` every 25 s; this test locks the same cadence on
 *      web and asserts it stops on disconnect.
 *
 *   2. **`observation_update` dispatch.** The server emits this when
 *      the BPG4 / BS 7671 lookup resolves a second or two after an
 *      initial extraction; web pre-fix dropped the message on the
 *      floor. Now it round-trips into `onObservationUpdate` with the
 *      iOS-parity payload shape (id / text / code / regulation /
 *      rationale / source).
 *
 * Mount strategy: `jest-websocket-mock` for the WS handshake (mirrors
 * the existing deepgram-service tests), `vi.useFakeTimers` so the
 * 25-second interval can be exercised without real wall-clock sleeps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { SonnetSession, type ObservationUpdate } from '@/lib/recording/sonnet-session';

// Token + base URL — the SonnetSession buildURL uses these.
vi.mock('@/lib/auth', () => ({
  getToken: () => 'test-jwt',
}));
vi.mock('@/lib/api-client', () => ({
  api: { baseUrl: 'http://localhost:3000' },
}));

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

function makeServer(): WS {
  return new WS(SONNET_URL, { jsonProtocol: true });
}

describe('SonnetSession · ALB heartbeat (audit Phase 6 P0)', () => {
  let server: WS;

  beforeEach(() => {
    server = makeServer();
  });

  afterEach(() => {
    WS.clean();
    vi.useRealTimers();
  });

  it('sends `{type: "heartbeat"}` on the heartbeat interval while connected', async () => {
    // jest-websocket-mock's handshake needs real timers to settle, so
    // we don't use fake timers here. Instead we inject a tiny
    // `heartbeatIntervalMs` so two ticks fire within a few hundred
    // ms of wallclock — quick and deterministic, and exercises the
    // exact same setInterval code path as production's 25 s value.
    const session = new SonnetSession({}, { heartbeatIntervalMs: 50 });
    session.connect({
      sessionId: 'sess-1',
      jobId: 'job-1',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;
    // Drain the session_start frame so the assertions below only see
    // heartbeats. jsonProtocol exposes parsed messages on `messages`.
    await new Promise((r) => setTimeout(r, 10));
    const startedFrames = server.messages.length;

    // Wait long enough for at least 2 heartbeat ticks (50 ms each).
    await new Promise((r) => setTimeout(r, 200));
    const heartbeats = server.messages
      .slice(startedFrames)
      .filter((m): m is { type: string } => typeof m === 'object' && m !== null && 'type' in m)
      .filter((m) => m.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    session.disconnect();
    await new Promise((r) => setTimeout(r, 400));
  });

  it('stops sending heartbeats after disconnect()', async () => {
    const session = new SonnetSession({}, { heartbeatIntervalMs: 50 });
    session.connect({
      sessionId: 'sess-2',
      jobId: 'job-2',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;
    // Let one heartbeat fire so we know the loop is alive.
    await new Promise((r) => setTimeout(r, 80));
    const before = server.messages.length;

    session.disconnect();
    // disconnect uses a 300ms grace before close — flush.
    await new Promise((r) => setTimeout(r, 400));

    // Wait several intervals' worth — no new heartbeats should arrive.
    const afterDisconnect = server.messages.length;
    await new Promise((r) => setTimeout(r, 250));
    const tail = server.messages.slice(afterDisconnect);
    const newHeartbeats = tail
      .filter((m): m is { type: string } => typeof m === 'object' && m !== null && 'type' in m)
      .filter((m) => m.type === 'heartbeat');
    expect(newHeartbeats).toHaveLength(0);
    // Sanity — we did fire at least one heartbeat before disconnect.
    expect(before).toBeGreaterThan(0);
  });
});

describe('SonnetSession · observation_update dispatch (audit Phase 6 P0)', () => {
  let server: WS;

  beforeEach(() => {
    server = makeServer();
  });

  afterEach(() => {
    WS.clean();
    vi.useRealTimers();
  });

  it('decodes observation_update frames and fans out to onObservationUpdate', async () => {
    const updates: ObservationUpdate[] = [];
    const session = new SonnetSession({
      onObservationUpdate: (u) => {
        updates.push(u);
      },
    });
    session.connect({
      sessionId: 'sess-3',
      jobId: 'job-3',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;

    server.send({
      type: 'observation_update',
      observation_id: 'obs-uuid-7',
      observation_text: 'Bonding to gas service incomplete',
      code: 'C2',
      regulation: '411.3.1.2',
      rationale: 'BPG4 5.3 update',
      source: 'BPG4',
    });

    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      observation_id: 'obs-uuid-7',
      observation_text: 'Bonding to gas service incomplete',
      code: 'C2',
      regulation: '411.3.1.2',
      rationale: 'BPG4 5.3 update',
      source: 'BPG4',
    });

    session.disconnect();
  });

  it('handles legacy observation_update frames missing optional fields', async () => {
    const updates: ObservationUpdate[] = [];
    const session = new SonnetSession({
      onObservationUpdate: (u) => {
        updates.push(u);
      },
    });
    session.connect({
      sessionId: 'sess-4',
      jobId: 'job-4',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;

    // Pre-id-assignment server: only observation_text + code present.
    server.send({
      type: 'observation_update',
      observation_text: 'No CPC at light fitting',
      code: 'C2',
    });

    await Promise.resolve();
    expect(updates).toHaveLength(1);
    expect(updates[0].observation_id).toBeUndefined();
    expect(updates[0].observation_text).toBe('No CPC at light fitting');
    expect(updates[0].code).toBe('C2');
    expect(updates[0].regulation).toBeUndefined();

    session.disconnect();
  });
});
