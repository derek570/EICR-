/**
 * PLAN-W1 M2d (W1-1, revised W1-16/W1-17, W1-23, W1-24) — an utterance whose
 * named capture is ambiguous belongs to the model.
 *
 * `extractNamedFieldValues` keeps one capture per slot, so an in-breath
 * correction was written as the value it corrected ("old breaker was 20 amps,
 * new one is 32 amps" → 20). One gate in `processDialogueTurn` now hands such
 * an utterance to the model: a handoff on the active path, no entry on the
 * entry path. `extractNamedFieldValues` itself is unchanged.
 */

import {
  processProtectiveDeviceTurn,
  processRingContinuityTurn,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import {
  findAmbiguousNamedCapture,
  extractNamedFieldValues,
  maskCircuitSpans,
} from '../extraction/dialogue-engine/helpers/extraction.js';

const SESSION_ID = 'sess_w1_m2d';
const slotsOf = (name) => ALL_DIALOGUE_SCHEMAS.find((s) => s.name === name).slots;

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

function buildSession(circuits = { 3: {} }) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: {
      circuits: JSON.parse(JSON.stringify(circuits)),
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    },
  };
}

function rig(circuits) {
  const ws = new FakeWS();
  const session = buildSession(circuits);
  const rows = [];
  const logger = { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };
  let now = 1000;
  const turn = (fn, transcriptText) =>
    fn({ ws, session, sessionId: SESSION_ID, transcriptText, logger, now: (now += 1000) });
  return { ws, session, rows, turn };
}

describe('helper — red proofs (each is written today as the value it corrected)', () => {
  test.each([
    ['ocpd', 'old breaker was 20 amps, new one is 32 amps', 'ocpd_rating_a'],
    ['ocpd', 'rating is 20 amps no sorry 32 amps', 'ocpd_rating_a'],
    ['ring_continuity', 'lives 0.5 no lives 0.6', 'ring_r1_ohm'],
    ['ocpd', "the rating isn't 20 amps", 'ocpd_rating_a'],
    ['rcd', 'trip time 25 milliseconds, no, 28 milliseconds', 'rcd_trip_time'],
  ])('%s: "%s" is ambiguous on %s', (schema, text, field) => {
    expect(findAmbiguousNamedCapture(text, slotsOf(schema))).toMatchObject({ field });
  });

  test('the RCD entry string carries two trip times under a global scan', () => {
    const text = maskCircuitSpans(
      'RCD on circuit 3, trip time 25 milliseconds, no, 28 milliseconds, BS EN 61008'
    );
    expect(findAmbiguousNamedCapture(text, slotsOf('rcd'))).toMatchObject({
      field: 'rcd_trip_time',
    });
  });

  test.each([
    ['ocpd', '32 amps'],
    ['ocpd', '20 amps, yes 20 amps'],
    ['insulation_resistance', 'L-L 200, L-E 250'],
    ['ring_continuity', 'lives 0.43, 0.43 on the neutrals, CPC 0.78'],
    ['ring_continuity', 'lives, neutrals and cpc are all 0.5'],
  ])('control — %s: "%s" is not ambiguous', (schema, text) => {
    expect(findAmbiguousNamedCapture(text, slotsOf(schema))).toBeNull();
  });

  // A correction marker that introduces ANOTHER slot's value corrects that
  // slot, not the capture before it (EP deviation D-2: the literal rule flipped
  // two existing mid-walk BS overrides, which the plan forbids).
  test.each([
    ['ocpd', 'type B, actually BS 3871'],
    ['rcd', 'Type AC, actually BS EN 62423'],
  ])('control — %s: "%s" is not ambiguous (the marker belongs to the BS slot)', (schema, text) => {
    expect(findAmbiguousNamedCapture(text, slotsOf(schema))).toBeNull();
  });

  test.each([
    ['rcd', 'the main switch is type AC but this one is A', 'rcd_type'],
    ['ocpd', '32 amps but I think it is a 40', 'ocpd_rating_a'],
  ])('a contrasting "but" retracts: %s "%s" is ambiguous on %s', (schema, text, field) => {
    expect(findAmbiguousNamedCapture(text, slotsOf(schema))).toMatchObject({ field });
  });

  test('control: "but" introducing another slot\'s value is not a retraction', () => {
    expect(
      findAmbiguousNamedCapture('32 amps but the breaking capacity is 6 kA', slotsOf('ocpd'))
    ).toBeNull();
  });

  test('a marker followed by no value still retracts: "trip time 25 milliseconds, no issues" hands off', () => {
    expect(
      findAmbiguousNamedCapture('trip time 25 milliseconds, no issues', slotsOf('rcd'))
    ).toMatchObject({ field: 'rcd_trip_time' });
  });

  test('extractNamedFieldValues is unchanged: the ring compound forms still bind as on main', () => {
    expect(
      extractNamedFieldValues('lives, neutrals and cpc are all 0.5', slotsOf('ring_continuity'))
    ).toEqual([
      { field: 'ring_r1_ohm', value: '0.5' },
      { field: 'ring_rn_ohm', value: '0.5' },
      { field: 'ring_r2_ohm', value: '0.5' },
    ]);
  });
});

describe('active path — the script hands off instead of writing', () => {
  test('OCPD rating question answered "old breaker was 20 amps, new one is 32 amps" (main writes 20)', () => {
    const { ws, session, rows, turn } = rig();
    for (const t of ['MCB on circuit 3.', 'BS EN 60898', 'type B']) {
      turn(processProtectiveDeviceTurn, t);
    }
    expect(ws.sent.at(-1).context_field).toBe('ocpd_rating_a');

    const out = turn(processProtectiveDeviceTurn, 'old breaker was 20 amps, new one is 32 amps');

    expect(session.stateSnapshot.circuits[3].ocpd_rating_a).toBeUndefined();
    expect(out).toMatchObject({ handled: true, fallthrough: true });
    expect(out.transcriptText.startsWith('[Server note:')).toBe(true);
    expect(out.transcriptText).toContain('old breaker was 20 amps, new one is 32 amps');
    const handoffs = rows.filter((r) => r.event === 'stage6.script_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].payload).toMatchObject({ kind: 'ambiguous_capture' });
    expect(session.dialogueScriptState).toBeNull();
  });

  test('awaiting confirmation (W1-24): one purge frame BEFORE the handoff, no write, server note', () => {
    const { ws, session, turn } = rig({
      3: { ring_r1_ohm: '0.77', ring_rn_ohm: '0.78', ring_r2_ohm: '1.19' },
    });
    turn(processRingContinuityTurn, 'Ring continuity for circuit 3.');
    expect(session.dialogueScriptState?.awaiting_confirmation).toBe(true);
    const sentBefore = ws.sent.length;

    const out = turn(processRingContinuityTurn, 'no, lives 0.5, no lives 0.6');

    const turnFrames = ws.sent.slice(sentBefore);
    const purges = turnFrames.filter((f) => f.type === 'cancel_pending_tts');
    expect(purges).toHaveLength(1);
    expect(turnFrames[0].type).toBe('cancel_pending_tts');
    expect(session.stateSnapshot.circuits[3]).toMatchObject({
      ring_r1_ohm: '0.77',
      ring_rn_ohm: '0.78',
      ring_r2_ohm: '1.19',
    });
    expect(out.transcriptText.startsWith('[Server note:')).toBe(true);
  });
});

describe('entry path — no schema enters', () => {
  test('RCD entry carrying two trip times plus a BS code (main enters, writes 25 ms and the BS code)', () => {
    const { ws, session, rows, turn } = rig();
    const out = turn(
      processProtectiveDeviceTurn,
      'RCD on circuit 3, trip time 25 milliseconds, no, 28 milliseconds, BS EN 61008'
    );

    expect(out).toEqual({ handled: false });
    const c3 = session.stateSnapshot.circuits[3];
    for (const f of ['rcd_time_ms', 'rcd_trip_time', 'rcd_bs_en', 'rcd_type']) {
      expect(c3[f]).toBeUndefined();
    }
    // Neither RCD nor a sibling schema in the same family entered.
    expect(session.dialogueScriptState?.active ?? false).toBe(false);
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(0);
    expect(rows.some((r) => r.event === 'stage6.script_entry_ambiguous_capture')).toBe(true);
    expect(session.dialogueEntryGuardVeto?.text).toBe(
      'RCD on circuit 3, trip time 25 milliseconds, no, 28 milliseconds, BS EN 61008'
    );
  });
});
