/**
 * PLAN-A §A1 (feedback-2026-09-17) — the terminal read-back carrier and the
 * recovery step, acceptance item 11.
 *
 * The loss this closes: a script value's terminal read-back is sent through the
 * raw unbuffered `safeSend`. When that send DEFINITELY fails, the rendered line
 * is gone — `computeUncoveredReadback` stamps `covered_by` BEFORE the send and
 * ignores its result, so a second call returns null and nothing else will ever
 * speak those operations. Every outcome-gated net is suppressed by whatever
 * else the turn spoke, so a certificate value would be silently lost on a turn
 * that speaks something else.
 */

import { safeSend } from '../extraction/dialogue-engine/helpers/wire-emit.js';
import {
  processProtectiveDeviceTurn,
  processRingContinuityTurn,
} from '../extraction/dialogue-engine/index.js';
import { foldTerminalReadbackOutcomes } from '../extraction/terminal-readback-carrier.js';

const SESSION_ID = 'sess_carrier';

class FakeWS {
  constructor(readyState = 1) {
    this.OPEN = 1;
    this.readyState = readyState;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

class ThrowingWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {
    throw new Error('socket gone');
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: {
      circuits: JSON.parse(JSON.stringify(circuits)),
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    },
  };
}

const silentLog = { info: () => {}, warn: () => {} };

describe('safeSend returns an explicit boolean', () => {
  test('TRUE only when ws.send returned without throwing — queued, never “heard”', () => {
    expect(safeSend(new FakeWS(1), { type: 'x' })).toBe(true);
  });

  test('FALSE on exactly the three DEFINITE non-deliveries', () => {
    // absent ws / non-function send
    expect(safeSend(null, { type: 'x' })).toBe(false);
    expect(safeSend({}, { type: 'x' })).toBe(false);
    // readyState !== OPEN
    expect(safeSend(new FakeWS(3), { type: 'x' })).toBe(false);
    // ws.send throws
    expect(safeSend(new ThrowingWS(), { type: 'x' })).toBe(false);
  });
});

describe('renderTerminalReadback tri-state, through a real handoff', () => {
  function handoffWithCapture(ws, rows) {
    const session = buildSession({ 3: {} });
    const log = { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 3.',
      logger: log,
      now: 1000,
    });
    // Capture ONE value, so there is something uncovered to read back…
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'BS EN 61008',
      logger: log,
      now: 2000,
    });
    // …then miss.
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: log,
      now: 3000,
    });
    return { session, out };
  }

  test('(a) non-empty read-back, socket OPEN → built true, emitted true, one info frame, no lost text', () => {
    const ws = new FakeWS(1);
    const rows = [];
    const { out } = handoffWithCapture(ws, rows);

    expect(out.terminalReadbackBuilt).toBe(true);
    expect(out.terminalReadbackEmitted).toBe(true);
    expect(out.terminalReadbackLostText).toBeUndefined();

    const terminal = ws.sent.filter((m) => /-terminal_readback-/.test(m.tool_call_id ?? ''));
    expect(terminal).toHaveLength(1);
    // Today's frame shape, unchanged: an ask_user_started info frame with
    // expected_answer_shape 'none', carrying its speech in `question`.
    expect(terminal[0]).toMatchObject({
      type: 'ask_user_started',
      reason: 'info',
      expected_answer_shape: 'none',
    });
    expect(terminal[0].question).toContain('BS number');

    // No loss row on the happy path.
    expect(rows.some((r) => /_terminal_readback_send_failed$/.test(r.event))).toBe(false);
  });

  test('(b) EMPTY read-back → built false, emitted FALSE (never vacuously true), no frame', () => {
    // A first-slot miss with nothing captured.
    const ws = new FakeWS(1);
    const session = buildSession({ 3: {} });
    processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'RCD on circuit 3.',
      logger: silentLog,
      now: 1000,
    });
    const out = processProtectiveDeviceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'nothing that parses',
      logger: silentLog,
      now: 2000,
    });

    expect(out.terminalReadbackBuilt).toBe(false);
    // The ZERO-BUILT FLOOR. `emitted` must be false here, not vacuously true:
    // an AND over an empty set returns true, which would silence every
    // downstream net on a turn that captured nothing.
    expect(out.terminalReadbackEmitted).toBe(false);
    expect(ws.sent.filter((m) => /-terminal_readback-/.test(m.tool_call_id ?? ''))).toHaveLength(
      0
    );
  });

  test('(c) socket CLOSED → built true, emitted FALSE, ONE loss row, and the rendered line travels out', () => {
    const ws = new FakeWS(3); // not OPEN
    const rows = [];
    const { out } = handoffWithCapture(ws, rows);

    expect(out.terminalReadbackBuilt).toBe(true);
    expect(out.terminalReadbackEmitted).toBe(false);

    // The rendered TEXT travels out of the call — it cannot be recomputed,
    // because `computeUncoveredReadback` stamped `covered_by` before the send.
    expect(typeof out.terminalReadbackLostText).toBe('string');
    expect(out.terminalReadbackLostText).toContain('BS number');

    const lossRows = rows.filter((r) => /_terminal_readback_send_failed$/.test(r.event));
    expect(lossRows).toHaveLength(1);
    expect(lossRows[0].payload).toMatchObject({
      circuit_ref: 3,
      board_id: 'main',
      fields: ['rcd_bs_en'],
    });
  });

  test('the lost text is BYTE-IDENTICAL to the line the read-back rendered, not the wire frame', () => {
    // The frame carries its speech in `question`, so an implementation that
    // returned the frame instead of the readback object would make `.text`
    // undefined and the entry empty. Rendering it on an OPEN socket and
    // comparing to the CLOSED-socket carrier is what pins that.
    const openWs = new FakeWS(1);
    handoffWithCapture(openWs, []);
    const spokenLine = openWs.sent
      .filter((m) => /-terminal_readback-/.test(m.tool_call_id ?? ''))
      .at(-1).question;

    const closedWs = new FakeWS(3);
    const { out } = handoffWithCapture(closedWs, []);

    expect(out.terminalReadbackLostText).toBe(spokenLine);
  });
});

describe('EVERY fallthrough exit carries its lost read-back, not just the handoff', () => {
  // The defect this closes: only `terminateWithHandoff` returned the tri-state.
  // Other terminal exits called `renderTerminalReadback` and DISCARDED it, so a
  // DEFINITE non-delivery there lost the rendered line with no recovery —
  // `computeUncoveredReadback` had already stamped `covered_by`, so nothing
  // would ever speak those operations again.
  //
  // The plan names exactly one uncovered gap: a script-HANDLED turn that
  // returns before the harness runs. A fallthrough turn is not that gap.

  function ringWithCapture(ws) {
    const session = buildSession({ 2: {} });
    const run = (text, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText: text,
        logger: silentLog,
        now,
      });
    run('Ring continuity for circuit 2.', 1000);
    run('Lives are 0.43.', 2000);
    run('0.06', 3000);
    return { session, run };
  }

  test('TOPIC SWITCH with a failed send carries the rendered line out', () => {
    // The concrete sequence from the review: the ring script captured R1 and
    // Rn; the next utterance is a topic switch; the terminal frame's send
    // fails. Without the carrier the turn falls through, the model confirms the
    // NEW topic, every outcome-gated net stays quiet because something WAS
    // audible — and the captured readings are never heard.
    const ws = new FakeWS(1);
    const { run } = ringWithCapture(ws);
    ws.readyState = 3; // socket closes before the terminal frame

    const out = run('Zs is 0.62', 4000);

    expect(out).toMatchObject({ handled: true, fallthrough: true });
    expect(out.terminalReadbackBuilt).toBe(true);
    expect(out.terminalReadbackEmitted).toBe(false);
    expect(typeof out.terminalReadbackLostText).toBe('string');
    // The captured readings are IN the carried line — that is the whole point.
    expect(out.terminalReadbackLostText).toContain('0.43');
  });

  test('…and the same exit on an OPEN socket carries no lost text', () => {
    const ws = new FakeWS(1);
    const { run } = ringWithCapture(ws);
    const out = run('Zs is 0.62', 4000);
    expect(out.terminalReadbackBuilt).toBe(true);
    expect(out.terminalReadbackEmitted).toBe(true);
    expect(out.terminalReadbackLostText).toBeUndefined();
  });

  test('an exit that built NOTHING adds no carrier keys at all', () => {
    // Keeps the outcome object byte-identical on the overwhelmingly common
    // path, which is what every existing caller and test sees.
    const ws = new FakeWS(1);
    const session = buildSession({ 2: {} });
    processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 2.',
      logger: silentLog,
      now: 1000,
    });
    const out = processRingContinuityTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62',
      logger: silentLog,
      now: 2000,
    });
    expect(out).toMatchObject({ handled: true, fallthrough: true });
    expect('terminalReadbackBuilt' in out).toBe(false);
    expect('terminalReadbackEmitted' in out).toBe(false);
    expect('terminalReadbackLostText' in out).toBe(false);
  });
});

describe('carrier aggregation — the rules that a naive fold gets wrong', () => {
  // The PRODUCTION fold, imported rather than replicated: `sonnet-stream.js`
  // calls this exact function on the three wrapper outcomes in a FIXED
  // invocation order — ring → insulation resistance → protective device. A
  // replica here would pin nothing, because it could agree with a wrong
  // implementation.
  //
  // Why this is pinned DIRECTLY rather than through an end-to-end turn: the
  // session holds ONE `dialogueScriptState` and the engine's contract is that
  // only one script can be active per session, enforced via mutually-exclusive
  // triggers. Two wrapper calls each BUILDING a terminal read-back in one turn
  // would need two active episodes. So the fold is exercised on synthetic
  // outcomes, which is the only reachable way to assert its ORDER.
  const fold = (outcomes) => {
    const r = foldTerminalReadbackOutcomes(outcomes);
    return { built: r.built, emitted: r.emitted, lost: r.lostTexts, handoff: r.handoff };
  };

  test('`built` is an OR; `emitted` is an AND OVER THE CALLS THAT BUILT', () => {
    // ORing `emitted` would let one successful wrapper MASK another's failed
    // send — the whole reason it is an AND.
    const r = fold([
      { terminalReadbackBuilt: true, terminalReadbackEmitted: true },
      { terminalReadbackBuilt: false, terminalReadbackEmitted: false },
      { terminalReadbackBuilt: true, terminalReadbackEmitted: false, terminalReadbackLostText: 'P' },
    ]);
    expect(r.built).toBe(true);
    expect(r.emitted).toBe(false);
  });

  test('the ZERO-BUILT FLOOR: no call built → emitted is FALSE, not vacuously true', () => {
    const r = fold([
      { terminalReadbackBuilt: false, terminalReadbackEmitted: false },
      { terminalReadbackBuilt: false, terminalReadbackEmitted: false },
    ]);
    expect(r.built).toBe(false);
    expect(r.emitted).toBe(false);
  });

  test('lost texts are in WRAPPER-INVOCATION order — a reversed or unordered fold MUST fail', () => {
    const r = fold([
      { terminalReadbackBuilt: true, terminalReadbackEmitted: false, terminalReadbackLostText: 'R' },
      { terminalReadbackBuilt: false, terminalReadbackEmitted: false },
      { terminalReadbackBuilt: true, terminalReadbackEmitted: false, terminalReadbackLostText: 'P' },
    ]);
    // The assertion is on the ARRAY, not on membership: "contains R and P"
    // passes a reversed accumulator and a Set alike, and is therefore not a pin.
    expect(r.lost).toEqual(['R', 'P']);
    expect(r.lost).not.toEqual(['P', 'R']);
  });

  test('the handoff is the one non-null value', () => {
    const handoff = { boardId: 'main', schema: 'rcd', circuit_ref: 3 };
    expect(fold([{}, { handoff }, {}]).handoff).toEqual(handoff);
    expect(fold([{}, {}, {}]).handoff).toBeNull();
  });
});
