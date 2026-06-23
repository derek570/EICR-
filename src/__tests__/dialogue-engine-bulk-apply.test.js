/**
 * Tests for the RCD bulk-apply follow-up (fix B slice 3, 2026-05-21).
 *
 * After the RCD walk-through fills BS / type / mA, the engine emits
 * a post-completion prompt asking whether to copy the device-level
 * fields to other circuits. The reply parses via parseCircuitRange
 * and the engine writes to the resolved set — creating blank
 * circuits for unknown numbers per user direction.
 */

import { processProtectiveDeviceTurn } from '../extraction/dialogue-engine/index.js';
import {
  parseCircuitRange,
  formatBulkApplyConfirm,
} from '../extraction/dialogue-engine/parsers/circuit-range.js';

const SESSION_ID = 'sess_bulk';

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

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
  };
}

/** Drive the script through entry → BS → type → mA so the engine
 *  arrives at the bulk-apply prompt. */
function runRcdToBulkPrompt(session, ws) {
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'RCD on circuit 1.',
    now: 1000,
  });
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'BS EN 61008',
    now: 2000,
  });
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: 'AC',
    now: 3000,
  });
  processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: '30',
    now: 4000,
  });
}

describe('parseCircuitRange', () => {
  test('"all" → scope=all', () => {
    expect(parseCircuitRange('all')).toEqual({ scope: 'all' });
  });

  test('"all of them" → scope=all', () => {
    expect(parseCircuitRange('all of them')).toEqual({ scope: 'all' });
  });

  test('"every circuit" → scope=all', () => {
    expect(parseCircuitRange('every circuit')).toEqual({ scope: 'all' });
  });

  test('"yes all" → scope=all', () => {
    expect(parseCircuitRange('yes all')).toEqual({ scope: 'all' });
  });

  test('"1 to 6" → range with 6 circuits', () => {
    expect(parseCircuitRange('1 to 6')).toEqual({
      scope: 'range',
      circuits: [1, 2, 3, 4, 5, 6],
    });
  });

  test('"1 through 6" → same range', () => {
    expect(parseCircuitRange('1 through 6')).toEqual({
      scope: 'range',
      circuits: [1, 2, 3, 4, 5, 6],
    });
  });

  test('"1-6" → range', () => {
    expect(parseCircuitRange('1-6')).toEqual({
      scope: 'range',
      circuits: [1, 2, 3, 4, 5, 6],
    });
  });

  test('"circuits 2 to 8" → range 2..8', () => {
    expect(parseCircuitRange('circuits 2 to 8')).toEqual({
      scope: 'range',
      circuits: [2, 3, 4, 5, 6, 7, 8],
    });
  });

  test('reverse range "6 to 1" normalises to 1..6', () => {
    expect(parseCircuitRange('6 to 1')).toEqual({
      scope: 'range',
      circuits: [1, 2, 3, 4, 5, 6],
    });
  });

  test('range cap: "1 to 200" rejected (would create 200 circuits)', () => {
    // Falls through to list path which captures both digits.
    const r = parseCircuitRange('1 to 200');
    expect(r.scope).toBe('list');
    expect(r.circuits).toEqual([1, 200]);
  });

  test('"1, 3, 5" → list', () => {
    expect(parseCircuitRange('1, 3, 5')).toEqual({
      scope: 'list',
      circuits: [1, 3, 5],
    });
  });

  test('"1 and 3 and 5" → list deduped sorted', () => {
    expect(parseCircuitRange('1 and 3 and 5')).toEqual({
      scope: 'list',
      circuits: [1, 3, 5],
    });
  });

  test('"5, 5, 3, 1" → list deduped sorted', () => {
    expect(parseCircuitRange('5, 5, 3, 1')).toEqual({
      scope: 'list',
      circuits: [1, 3, 5],
    });
  });

  test('"no" → scope=none', () => {
    expect(parseCircuitRange('no')).toEqual({ scope: 'none' });
  });

  test('"nope" → scope=none', () => {
    expect(parseCircuitRange('nope')).toEqual({ scope: 'none' });
  });

  test('"just this one" → scope=none', () => {
    expect(parseCircuitRange('just this one')).toEqual({ scope: 'none' });
  });

  test('"no, just circuit 1" → scope=none (decline wins over digit)', () => {
    expect(parseCircuitRange('no, just circuit 1')).toEqual({ scope: 'none' });
  });

  test('empty / whitespace → scope=none', () => {
    expect(parseCircuitRange('')).toEqual({ scope: 'none' });
    expect(parseCircuitRange('   ')).toEqual({ scope: 'none' });
  });

  test('digit 0 is filtered out (legacy installation bucket)', () => {
    expect(parseCircuitRange('circuit 0')).toEqual({ scope: 'none' });
  });

  test('single digit → list with one entry', () => {
    expect(parseCircuitRange('5')).toEqual({ scope: 'list', circuits: [5] });
  });
});

describe('formatBulkApplyConfirm', () => {
  test('scope=all → "Applied RCD to all circuits."', () => {
    expect(formatBulkApplyConfirm('all', {}, 'RCD')).toBe('Applied RCD to all circuits.');
  });

  test('scope=range → "Applied RCD to circuits 1 through 6."', () => {
    expect(formatBulkApplyConfirm('range', { circuits: [1, 2, 3, 4, 5, 6] })).toBe(
      'Applied RCD to circuits 1 through 6.'
    );
  });

  test('scope=list with one → "Applied RCD to circuit 3."', () => {
    expect(formatBulkApplyConfirm('list', { circuits: [3] })).toBe('Applied RCD to circuit 3.');
  });

  test('scope=list with two → "Applied RCD to circuits 1 and 3."', () => {
    expect(formatBulkApplyConfirm('list', { circuits: [1, 3] })).toBe(
      'Applied RCD to circuits 1 and 3.'
    );
  });

  test('scope=list with three+ → "Applied RCD to circuits 1, 3 and 5."', () => {
    expect(formatBulkApplyConfirm('list', { circuits: [1, 3, 5] })).toBe(
      'Applied RCD to circuits 1, 3 and 5.'
    );
  });

  test('scope=none → null (caller emits normal finish TTS)', () => {
    expect(formatBulkApplyConfirm('none', {})).toBe(null);
  });
});

describe('RCD bulk-apply integration', () => {
  test('emits the bulk-apply prompt after BS/type/mA fill', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {}, 3: {} });
    runRcdToBulkPrompt(session, ws);
    const last = ws.sent.at(-1);
    expect(last.reason).toBe('missing_context');
    expect(last.question).toBe(
      "Apply these RCD details to any other circuits? Say 'all' or a range like '1 to 6'."
    );
    expect(last.context_field).toBe(null);
    expect(last.context_circuit).toBe(null);
    expect(last.tool_call_id).toMatch(/bulk-apply/);
    // Script state still active, but bulkApplyPending flagged.
    expect(session.dialogueScriptState.bulkApplyPending).toBe(true);
  });

  test('"all" → copies BS/type/mA to every other existing circuit + confirms + finishes', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {}, 3: { rcd_type: 'B' } });
    runRcdToBulkPrompt(session, ws);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'all',
      now: 5000,
    });
    // Circuits 2 and 3 got the RCD details. Circuit 1 is the script's
    // own circuit — already filled, skipped.
    expect(session.stateSnapshot.circuits[2]).toMatchObject({
      rcd_bs_en: 'BS EN 61008',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
    // Circuit 3 had rcd_type: 'B' — overwritten to 'AC' per user direction.
    expect(session.stateSnapshot.circuits[3]).toMatchObject({
      rcd_bs_en: 'BS EN 61008',
      rcd_type: 'AC',
      rcd_operating_current_ma: '30',
    });
    // Confirmation TTS emitted, script cleared.
    const last = ws.sent.at(-1);
    expect(last.reason).toBe('info');
    expect(last.question).toBe('Applied RCD to all circuits.');
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('"1 to 6" → creates blank circuits for unknown numbers', () => {
    const ws = new FakeWS();
    // Only circuit 1 exists at the start of the script.
    const session = buildSession({ 1: {} });
    runRcdToBulkPrompt(session, ws);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '1 to 6',
      now: 5000,
    });
    // Circuits 2, 3, 4, 5, 6 — all created blank with the RCD values.
    for (const ref of [2, 3, 4, 5, 6]) {
      expect(session.stateSnapshot.circuits[ref]).toMatchObject({
        rcd_bs_en: 'BS EN 61008',
        rcd_type: 'AC',
        rcd_operating_current_ma: '30',
      });
    }
    expect(ws.sent.at(-1).question).toBe('Applied RCD to circuits 1 through 6.');
  });

  test('"no" → no bulk write, normal "Got it. ..." finish TTS', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {} });
    runRcdToBulkPrompt(session, ws);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'no',
      now: 5000,
    });
    // Circuit 2 untouched.
    expect(session.stateSnapshot.circuits[2]).toEqual({});
    expect(ws.sent.at(-1).question).toBe('Got it. BS EN 61008, type AC, 30 mA.');
  });

  test('"1, 3, 5" list → only those circuits written', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {}, 3: {}, 4: {}, 5: {} });
    runRcdToBulkPrompt(session, ws);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '1, 3, 5',
      now: 5000,
    });
    // Circuit 1 is the script's own — skipped (already filled).
    // Circuits 3 and 5 newly written.
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS EN 61008');
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    // Circuits 2, 4 untouched.
    expect(session.stateSnapshot.circuits[2]).toEqual({});
    expect(session.stateSnapshot.circuits[4]).toEqual({});
    // TTS confirms the inspector's spoken intent, not the filtered write
    // set. Saying "applied to 1, 3 and 5" matches what the inspector
    // said and is accurate to the final state (all three are now
    // populated — 1 was already done by the script, 3 and 5 just got
    // written).
    expect(ws.sent.at(-1).question).toBe('Applied RCD to circuits 1, 3 and 5.');
  });

  test('trip_time is NOT propagated by bulk apply', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {} });
    // Entry volunteers trip_time → harvested onto circuit 1.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for circuit 1 is 25 ms.',
      now: 1000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      now: 2000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'AC',
      now: 3000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '30',
      now: 4000,
    });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'all',
      now: 5000,
    });
    // Circuit 2 got BS/type/mA but NOT trip_time.
    expect(session.stateSnapshot.circuits[2].rcd_bs_en).toBe('BS EN 61008');
    expect(session.stateSnapshot.circuits[2].rcd_type).toBe('AC');
    expect(session.stateSnapshot.circuits[2].rcd_operating_current_ma).toBe('30');
    expect(session.stateSnapshot.circuits[2].rcd_trip_time).toBeUndefined();
    // Circuit 1 (own) keeps its trip_time.
    expect(session.stateSnapshot.circuits[1].rcd_trip_time).toBe('25');
  });

  // ─────────────────────────────────────────────────────────────────────
  // End-to-end regression for the field-test bug (session 293F074F,
  // 2026-05-21). The verbatim utterance that produced the four-times
  // BS-number ask loop now flows cleanly: trip_time lands, BS gets
  // asked once with the defer hint, inspector can either provide BS or
  // defer. This is the user-facing acceptance test for fix B.
  // ─────────────────────────────────────────────────────────────────────
  test('session 293F074F repro: "RCD trip time for the cooker is 25 ms" → defer → exits with trip_time saved', () => {
    const ws = new FakeWS();
    const session = buildSession({
      // Field session had circuit 1 = Cooker with designation set.
      1: { designation: 'Cooker' },
    });

    // Entry — verbatim from the production log.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD trip time for the cooker is 25 ms.',
      now: 1000,
    });

    // BEFORE fix: this looped on "What's the BS number?" four times.
    // AFTER fix: trip_time on the snapshot, BS ask emitted ONCE with
    // the defer hint.
    expect(session.stateSnapshot.circuits[1].rcd_trip_time).toBe('25');
    const askPayload = ws.sent.find((m) => m.context_field === 'rcd_bs_en');
    expect(askPayload).toBeDefined();
    expect(askPayload.question).toBe(
      "What's the BS number of the RCD? Or do you want to fill that in later?"
    );

    // Inspector defers — script exits cleanly, trip_time preserved.
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'fill later',
      now: 2000,
    });
    expect(ws.sent.at(-1).question).toBe("Okay, I'll come back to that later.");
    expect(session.stateSnapshot.circuits[1].rcd_trip_time).toBe('25');
    expect(session.stateSnapshot.circuits[1].rcd_bs_en).toBeUndefined();
    expect(session.dialogueScriptState).toBeFalsy();
  });

  test('unparseable reply ("um what?") → fall through to normal finish', () => {
    const ws = new FakeWS();
    const session = buildSession({ 1: {}, 2: {} });
    runRcdToBulkPrompt(session, ws);
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'um what?',
      now: 5000,
    });
    // No bulk write happened, circuit 2 still empty.
    expect(session.stateSnapshot.circuits[2]).toEqual({});
    // Normal "Got it." finish.
    expect(ws.sent.at(-1).question).toBe('Got it. BS EN 61008, type AC, 30 mA.');
  });
});
