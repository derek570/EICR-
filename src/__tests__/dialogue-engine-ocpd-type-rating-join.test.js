/**
 * PLAN-W2 (Decision 7 wrong-value wave, audit row B-138) — the OCPD script's
 * type slot no longer admits a curve letter joined to a rating.
 *
 * `canonicaliseOcpdType` joined "C, 32" into `C,32` (the comma rode in on a
 * two-glyph token), "C 32" into `C32` and "B 6" into `B6`, and `parseMcbType`
 * admitted each as the type: a value the inspector never said, written to a
 * legal record. After the fix each of those replies canonicalises to a value
 * with a space, the slot parser misses, and the walk takes PLAN-A's first-miss
 * handoff to the model (Decision 7). The vectors themselves are pinned in
 * `config/ocpd-type-suggestions.json`; this suite proves the script path.
 */

import { processProtectiveDeviceTurn } from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_b138';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: {
      circuits: JSON.parse(JSON.stringify(circuits)),
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    },
  };
}

function walkToTypeAsk(rows) {
  const ws = new FakeWS();
  const session = buildSession({ 5: {} });
  const logger = { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'MCB on circuit 5.',
    logger,
    now: 1000,
  });
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'BS EN 60898',
    logger,
    now: 2000,
  });
  return { ws, session, logger };
}

describe('B-138 — "What type?" answered with a curve letter and a rating', () => {
  test.each(['C, 32', 'B 6', 'type C 32'])(
    '%s writes no ocpd_type and hands the turn to the model',
    (reply) => {
      const rows = [];
      const { ws, session, logger } = walkToTypeAsk(rows);
      expect(ws.sent.at(-1).context_field).toBe('ocpd_type');

      const out = processProtectiveDeviceTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: reply,
        logger,
        now: 3000,
      });

      expect(session.stateSnapshot.circuits[5].ocpd_type).toBeUndefined();
      expect(out).toMatchObject({ handled: true, fallthrough: true });
      expect(session.dialogueScriptState).toBeNull();
      const handoffs = rows.filter((r) => r.event === 'stage6.script_handoff');
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0].payload).toMatchObject({ kind: 'slot_miss', field: 'ocpd_type' });
      // No second "What type?" — the first miss ends the walk.
      expect(ws.sent.filter((m) => m.context_field === 'ocpd_type')).toHaveLength(1);
    }
  );

  test('a bare curve letter is still admitted (green before and after)', () => {
    const rows = [];
    const { ws, session, logger } = walkToTypeAsk(rows);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'C',
      logger,
      now: 3000,
    });
    expect(session.stateSnapshot.circuits[5].ocpd_type).toBe('C');
    expect(rows.filter((r) => r.event === 'stage6.script_handoff')).toHaveLength(0);
  });
});
