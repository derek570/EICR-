/**
 * Plan A1b (2026-07-29) — `field_corrected` BOARD-frame decode (web mirror
 * of the iOS Stage6Messages rule; iOS is canon for the frame shape).
 *
 * Wire contract (A1a §3.4b): a board/supply-scope clear emits
 * `{type:'field_corrected', circuit:null, field, board_id:<non-null>}`.
 * The pre-A1b web decoder required `typeof circuit === 'number'` and
 * silently DROPPED every board frame — the client-half gap this plan
 * closes before `board_clear_v1` is advertised.
 *
 * Decode rule under test:
 *  - circuit number            → decodes (legacy circuit clear; board_id null)
 *  - circuit-less + board_id   → decodes (the board frame)
 *  - circuit-less + board-less → REJECTED + logged (scope-less: the server
 *    always resolves a non-null board_id for board clears, so this shape is
 *    a contract violation — never a legitimate global clear)
 *  - a refused clear emits NO frame at all server-side; the spoken notice
 *    rides `confirmations[]` on the ordinary extraction frame — pinned here
 *    as "extraction fires, onFieldCorrected does NOT".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { SonnetSession } from '@/lib/recording/sonnet-session';
import { clearPipelineLog, getPipelineLog } from '@/lib/diagnostics/pipeline-log';

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

function seedToken(): void {
  localStorage.setItem('cm_token', 'fake-jwt-token');
}

async function connectedSession(callbacks: ConstructorParameters<typeof SonnetSession>[0]) {
  const session = new SonnetSession(callbacks);
  session.connect({ sessionId: 'client-a1b', jobId: 'job-1', certificateType: 'EICR' });
  return session;
}

describe('field_corrected board-frame decode (A1b)', () => {
  let server: WS;

  beforeEach(() => {
    seedToken();
    clearPipelineLog();
    server = new WS(SONNET_URL);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('circuit frame still decodes exactly as before (board_id null)', async () => {
    const onFieldCorrected = vi.fn();
    await connectedSession({ onFieldCorrected });
    await server.connected;
    server.send(JSON.stringify({ type: 'field_corrected', circuit: 3, field: 'measured_zs_ohm' }));
    await Promise.resolve();
    expect(onFieldCorrected).toHaveBeenCalledTimes(1);
    expect(onFieldCorrected.mock.calls[0][0]).toMatchObject({
      circuit: 3,
      field: 'measured_zs_ohm',
      board_id: null,
    });
  });

  it('BOARD frame (circuit:null + board_id) decodes — the shape the old decoder silently dropped', async () => {
    const onFieldCorrected = vi.fn();
    await connectedSession({ onFieldCorrected });
    await server.connected;
    server.send(
      JSON.stringify({
        type: 'field_corrected',
        circuit: null,
        field: 'ze',
        previous_value: '0.35',
        reason: 'clear_reading',
        board_id: 'main',
      })
    );
    await Promise.resolve();
    expect(onFieldCorrected).toHaveBeenCalledTimes(1);
    expect(onFieldCorrected.mock.calls[0][0]).toMatchObject({
      circuit: null,
      field: 'ze',
      board_id: 'main',
      reason: 'clear_reading',
    });
  });

  it('scope-less frame (no circuit, no board_id) is REJECTED and logged — never forwarded', async () => {
    const onFieldCorrected = vi.fn();
    await connectedSession({ onFieldCorrected });
    await server.connected;
    server.send(JSON.stringify({ type: 'field_corrected', circuit: null, field: 'ze' }));
    server.send(JSON.stringify({ type: 'field_corrected', field: 'pfc', board_id: '' }));
    await Promise.resolve();
    expect(onFieldCorrected).not.toHaveBeenCalled();
    const stages = getPipelineLog().map((e) => e.stage);
    expect(stages.filter((s) => s === 'field_corrected_scopeless_rejected')).toHaveLength(2);
  });

  it('a REFUSED clear arrives as a spoken notice on the extraction frame — onExtraction fires, onFieldCorrected does NOT (§4 test 6)', async () => {
    const onFieldCorrected = vi.fn();
    const onExtraction = vi.fn();
    await connectedSession({ onFieldCorrected, onExtraction });
    await server.connected;
    // A1a's refusal notices ride the ordinary extraction envelope as a
    // field-nil confirmation (the channel the client already renders/speaks).
    server.send(
      JSON.stringify({
        type: 'extraction',
        result: {
          readings: [],
          confirmations: [
            {
              field: null,
              text: "I can't clear that from here — say the reading again to replace it.",
            },
          ],
        },
      })
    );
    await Promise.resolve();
    expect(onExtraction).toHaveBeenCalledTimes(1);
    expect(onFieldCorrected).not.toHaveBeenCalled();
  });
});
