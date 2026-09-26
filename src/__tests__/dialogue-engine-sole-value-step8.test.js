/**
 * PLAN-W1 M2a (B-127 to B-130, A-1) — the engine's step-8 bare-value fallback
 * writes only when the WHOLE raw reply is one value of the slot's grammar.
 *
 * Before this, step 8 ran the slot parser over the whole utterance, and every
 * parser takes the first match anywhere: "give me 2 minutes" wrote a 2 A
 * breaker, "hang on 2 secs" a 2 MΩ insulation reading. A reply that is not a
 * sole value now reaches the existing step-9b first-miss handoff: nothing is
 * written, and the model gets the note plus the reply.
 */

import {
  processProtectiveDeviceTurn,
  processInsulationResistanceTurn,
  processRingContinuityTurn,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';

const SESSION_ID = 'sess_sole_value_step8';

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

/** Every bare-value slot that parses the annotated or whole reply without a grammar. */
function slotsMissingSoleValueGrammar(schemas) {
  const missing = [];
  for (const schema of schemas) {
    for (const slot of schema.slots) {
      if (slot.acceptsBareValue === false || slot.exclusiveWhenExpected) continue;
      if (slot.kind === 'bs_code' || slot.parsesRawReply === true || slot.soleValueGrammar) {
        continue;
      }
      missing.push(`${schema.name}.${slot.field}`);
    }
  }
  return missing;
}

describe('completeness — every bare-value slot is anchored', () => {
  test('no slot in the live registry lacks a sole-value grammar, a raw-reply parser, or bs_code kind', () => {
    expect(slotsMissingSoleValueGrammar(ALL_DIALOGUE_SCHEMAS)).toEqual([]);
  });

  test('the checker names a slot stripped of its grammar (proved on the REAL registry)', () => {
    const clone = ALL_DIALOGUE_SCHEMAS.map((schema) => ({
      ...schema,
      slots: schema.slots.map((slot) => ({ ...slot })),
    }));
    const ocpd = clone.find((s) => s.name === 'ocpd');
    const rating = ocpd.slots.find((s) => s.field === 'ocpd_rating_a');
    expect(rating.soleValueGrammar).toBeDefined();
    delete rating.soleValueGrammar;
    expect(slotsMissingSoleValueGrammar(clone)).toEqual(['ocpd.ocpd_rating_a']);
  });
});

/** Walk a script to a live slot question, then send `reply`. */
function drive(processFn, turns, reply) {
  const ws = new FakeWS();
  const session = buildSession();
  const rows = [];
  const logger = { info: (event, payload) => rows.push({ event, payload }), warn: () => {} };
  let now = 1000;
  for (const t of turns) {
    processFn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: t,
      logger,
      now: (now += 1000),
    });
  }
  const before = JSON.parse(JSON.stringify(session.stateSnapshot.circuits[3]));
  const askedField = ws.sent.at(-1)?.context_field;
  const out = processFn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: reply,
    logger,
    now: (now += 1000),
  });
  return { ws, session, rows, out, before, askedField };
}

const OCPD_TO_RATING = ['MCB on circuit 3.', 'BS EN 60898', 'type B'];
const RING_TO_R2 = ['ring continuity for circuit 3', 'lives 0.5', 'neutrals 0.5'];
const IR_TO_LL = ['insulation resistance for circuit 3'];
const RCD_TO_TYPE = ['RCD on circuit 3.', 'BS EN 61008'];

function expectHandoffNoWrite({ session, rows, out, before, askedField }, field) {
  expect(askedField).toBe(field);
  expect(session.stateSnapshot.circuits[3]).toEqual(before);
  expect(session.stateSnapshot.circuits[3][field]).toBeUndefined();
  expect(out).toMatchObject({ handled: true, fallthrough: true });
  expect(out.transcriptText.startsWith('[Server note:')).toBe(true);
  const handoffs = rows.filter((r) => r.event === 'stage6.script_handoff');
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0].payload).toMatchObject({ field });
}

describe('red proofs — a non-sole reply hands off instead of writing', () => {
  test('OCPD rating question, "give me 2 minutes" (main writes 2)', () => {
    expectHandoffNoWrite(
      drive(processProtectiveDeviceTurn, OCPD_TO_RATING, 'give me 2 minutes'),
      'ocpd_rating_a'
    );
  });

  test('ring R2 question, "the breaker\'s a B32" (main writes 32, clamped)', () => {
    expectHandoffNoWrite(
      drive(processRingContinuityTurn, RING_TO_R2, "the breaker's a B32"),
      'ring_r2_ohm'
    );
  });

  test.each(['hang on 2 secs', 'what is the max for this', 'the limb is fine'])(
    'IR L-L question, "%s" (main writes 2, >999, LIM)',
    (reply) => {
      expectHandoffNoWrite(
        drive(processInsulationResistanceTurn, IR_TO_LL, reply),
        'ir_live_live_mohm'
      );
    }
  );

  // A-1 — both shapes. The step-8 anywhere-scan ("…is AC but this one is A")
  // is closed by the sole-value grammar. The plan's own repro ("…is TYPE AC but
  // this one is A") is captured at step 7 by rcd_type's named extractor, so it
  // is closed by M2d's retraction arm: "but" sets the earlier value aside.
  test.each([
    'the main switch is type AC but this one is A',
    'the main switch is AC but this one is A',
    // Review cycle 2: a sibling capture after the competing value.
    'the main switch is type AC but this one is A, BS EN 61008',
  ])('RCD type question, "%s" (main writes AC)', (reply) => {
    expectHandoffNoWrite(drive(processProtectiveDeviceTurn, RCD_TO_TYPE, reply), 'rcd_type');
  });
});

describe('controls — a sole value still writes', () => {
  function expectWrite(result, field, value) {
    expect(result.askedField).toBe(field);
    expect(result.session.stateSnapshot.circuits[3][field]).toBe(value);
    expect(result.rows.filter((r) => r.event === 'stage6.script_handoff')).toHaveLength(0);
  }

  test('"32 amps" on the OCPD rating', () => {
    expectWrite(
      drive(processProtectiveDeviceTurn, OCPD_TO_RATING, '32 amps'),
      'ocpd_rating_a',
      '32'
    );
  });
  test('".43" on a ring leg writes 0.43', () => {
    expectWrite(drive(processRingContinuityTurn, RING_TO_R2, '.43'), 'ring_r2_ohm', '0.43');
  });
  test('"greater than 200" on L-L', () => {
    expectWrite(
      drive(processInsulationResistanceTurn, IR_TO_LL, 'greater than 200'),
      'ir_live_live_mohm',
      '>200'
    );
  });
  test('"Type A" on the RCD type', () => {
    expectWrite(drive(processProtectiveDeviceTurn, RCD_TO_TYPE, 'Type A'), 'rcd_type', 'A');
  });
});
