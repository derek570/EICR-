/**
 * Feedback id 98 (session 2D8E432D) — leading-circuit entry scope +
 * contradiction resolver. §6 matrix tests 1–4, 6, 7 of the
 * leading-circuit-scope plan:
 *
 *   1. Leading full entry with volunteered values ⇒ scoped entry, no
 *      which_circuit ask, volunteered value writes immediately.
 *   2. Leading terse entry; trailing regression; clause-start acceptance;
 *      newline / mid-clause NEGATIVES.
 *   3. Contradiction ⇒ which_circuit ask (no silent winner); same-number
 *      duplication unambiguous; circuit-span MASKING pinned through EACH
 *      conflict state separately (initial entry / active non-confirmation /
 *      awaiting_confirmation — ring only) against engine AND twin.
 *   4. Existing exclusions unchanged (destructive-verb entries fall through
 *      for ring AND the new IR guard; narration negatives; the ACTIVE-script
 *      topicSwitchTrigger `circuit N is` behaviour preserved).
 *   6. Mid-script circuit switch via a LEADING-circuit different-entry (the
 *      six-reader collect-all regression pin, engine + both twins).
 *   7. Per-file garble divergences pinned (IR twin keeps `international`,
 *      IR schema keeps `insurance`; ring twin terse stays ring-only).
 *
 * The id-93 cross-utterance scenarios are ENGINE-ONLY and live in
 * sonnet-stream-cross-utterance-delete-ingress.test.js — the memoryless
 * twins would necessarily diverge there.
 */

import {
  processRingContinuityTurn as engineRing,
  processInsulationResistanceTurn as engineIR,
} from '../extraction/dialogue-engine/index.js';
import { processDialogueTurn, __testing__ } from '../extraction/dialogue-engine/engine.js';

const engineDetectEntry = __testing__.detectEntry;
import { ringContinuitySchema } from '../extraction/dialogue-engine/schemas/ring-continuity.js';
import { insulationResistanceSchema } from '../extraction/dialogue-engine/schemas/insulation-resistance.js';
import {
  processRingContinuityTurn as legacyRing,
  detectEntry as legacyRingDetectEntry,
} from '../extraction/ring-continuity-script.js';
import {
  processInsulationResistanceTurn as legacyIR,
  detectEntry as legacyIrDetectEntry,
} from '../extraction/insulation-resistance-script.js';

const SESSION_ID = 'sess_leading_scope';

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

function run(processor, transcripts, initialCircuits) {
  const ws = new FakeWS();
  const session = buildSession(initialCircuits);
  for (const { text, now } of transcripts) {
    processor({ ws, session, sessionId: SESSION_ID, transcriptText: text, logger: null, now });
  }
  return { ws, session };
}

const whichCircuitAsks = (ws, question) =>
  ws.sent.filter((f) => f.type === 'ask_user_started' && f.question === question);
const extractionFrames = (ws) => ws.sent.filter((f) => f.type === 'extraction');
const allReadings = (ws) =>
  extractionFrames(ws).flatMap((f) => (Array.isArray(f.result?.readings) ? f.result.readings : []));

const RING_WHICH = 'Which circuit is the ring continuity for?';
const IR_WHICH = 'Which circuit is the insulation resistance for?';

// ---------------------------------------------------------------------------
// 1. Leading entry with volunteered values — scoped, no which_circuit ask.
// ---------------------------------------------------------------------------

describe('matrix 1 — leading full entry scopes the script (engine + twins)', () => {
  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])('%s: "Circuit 10, ring continuity. Lives are 0.61." writes immediately', (_label, proc) => {
    const { ws, session } = run(
      proc,
      [{ text: 'Circuit 10, ring continuity. Lives are 0.61.', now: 1000 }],
      { 10: {} }
    );
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(0);
    expect(session.stateSnapshot.circuits[10].ring_r1_ohm).toBe('0.61');
    const r1Writes = allReadings(ws).filter((r) => String(r.value) === '0.61');
    expect(r1Writes).toHaveLength(1);
    expect(r1Writes[0].circuit).toBe(10);
  });

  test.each([
    ['engine IR', engineIR],
    ['legacy IR twin', legacyIR],
  ])('%s: "Circuit 4, insulation resistance live to live 200." scopes to 4', (_label, proc) => {
    const { ws, session } = run(
      proc,
      [{ text: 'Circuit 4, insulation resistance live to live 200.', now: 1000 }],
      { 4: {} }
    );
    expect(whichCircuitAsks(ws, IR_WHICH)).toHaveLength(0);
    expect(session.stateSnapshot.circuits[4].ir_live_live_mohm).toBe('200');
  });
});

// ---------------------------------------------------------------------------
// 2. Leading terse + clause-start acceptance + negatives.
// ---------------------------------------------------------------------------

describe('matrix 2 — terse/clause-start/anchoring', () => {
  test('leading TERSE: "Circuit 7, ring readings next." enters scoped to 7 (engine)', () => {
    const result = engineDetectEntry('Circuit 7, ring readings next.', ringContinuitySchema);
    expect(result).toEqual({ matched: true, circuit_ref: 7, scope_conflict: false });
  });

  test('trailing regression: "…for circuit 13" still yields 13 on every detector', () => {
    expect(engineDetectEntry('Ring continuity for circuit 13.', ringContinuitySchema)).toEqual({
      matched: true,
      circuit_ref: 13,
      scope_conflict: false,
    });
    expect(legacyRingDetectEntry('Ring continuity for circuit 13.')).toEqual({
      matched: true,
      circuit_ref: 13,
      scope_conflict: false,
    });
    expect(
      engineDetectEntry('Insulation resistance for circuit 3.', insulationResistanceSchema)
    ).toEqual({ matched: true, circuit_ref: 3, scope_conflict: false });
    expect(legacyIrDetectEntry('Insulation resistance for circuit 3.')).toEqual({
      matched: true,
      circuit_ref: 3,
      scope_conflict: false,
    });
  });

  test('post-sentence clause start binds: "Right. Circuit 9, ring continuity."', () => {
    expect(engineDetectEntry('Right. Circuit 9, ring continuity.', ringContinuitySchema)).toEqual({
      matched: true,
      circuit_ref: 9,
      scope_conflict: false,
    });
  });

  test('NEGATIVE: punctuation followed by a NEWLINE does not bind the leading circuit', () => {
    // Pattern 1 still trigger-matches "ring continuity" (no trailing circuit),
    // so the utterance enters UNSCOPED — the leading 5 must NOT bind.
    expect(engineDetectEntry('done.\nCircuit 5 ring continuity', ringContinuitySchema)).toEqual({
      matched: true,
      circuit_ref: null,
      scope_conflict: false,
    });
  });

  test('NEGATIVE: a newline between "circuit" and its number does not bind', () => {
    expect(engineDetectEntry('Circuit\n5 ring continuity', ringContinuitySchema)).toEqual({
      matched: true,
      circuit_ref: null,
      scope_conflict: false,
    });
  });

  test('NEGATIVE: a mid-clause circuit mention before the trigger does not bind', () => {
    expect(
      engineDetectEntry('the reading on circuit 5 ring continuity', ringContinuitySchema)
    ).toEqual({ matched: true, circuit_ref: null, scope_conflict: false });
  });
});

// ---------------------------------------------------------------------------
// 3. Contradiction resolver + masking pins per conflict state.
// ---------------------------------------------------------------------------

const RING_CONTAMINATED = 'Circuit 5, ring continuity earths for circuit 3 are 1.19.';
const IR_CONTAMINATED = 'Circuit 5, insulation resistance live to live for circuit 3 is 200.';

function expectNoBareThreeWritten(ws, session) {
  // The contaminated exemplar's trailing "circuit 3" digit must appear in
  // NEITHER an emitted reading nor any persisted circuit value.
  for (const r of allReadings(ws)) {
    expect(String(r.value)).not.toBe('3');
  }
  for (const c of Object.values(session.stateSnapshot.circuits)) {
    for (const v of Object.values(c)) {
      expect(String(v)).not.toBe('3');
    }
  }
}

describe('matrix 3 — contradiction asks; masking pinned per conflict state', () => {
  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])('%s: INITIAL-ENTRY conflict asks which_circuit, masks the digit', (_label, proc) => {
    const { ws, session } = run(proc, [{ text: RING_CONTAMINATED, now: 1000 }], {
      3: {},
      5: {},
    });
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(1);
    expectNoBareThreeWritten(ws, session);
    // The masked volunteered value (earths → R2 = 1.19) drains onto the
    // ANSWERED circuit, proving it was queued, not dropped and not 3.
    proc({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 5',
      logger: null,
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ring_r2_ohm).toBe('1.19');
    expect(session.stateSnapshot.circuits[3].ring_r2_ohm).toBeUndefined();
  });

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])(
    '%s: ACTIVE non-confirmation conflict asks, never writes to the OLD circuit',
    (_label, proc) => {
      const { ws, session } = run(
        proc,
        [
          { text: 'Ring continuity for circuit 13.', now: 1000 },
          { text: 'Lives are 0.30.', now: 2000 },
          { text: RING_CONTAMINATED, now: 3000 },
        ],
        { 3: {}, 5: {}, 13: {} }
      );
      expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(1);
      expectNoBareThreeWritten(ws, session);
      // The old circuit keeps its own committed value and gains nothing new.
      expect(session.stateSnapshot.circuits[13].ring_r1_ohm).toBe('0.30');
      expect(session.stateSnapshot.circuits[13].ring_r2_ohm).toBeUndefined();
    }
  );

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])(
    '%s: AWAITING_CONFIRMATION conflict purges + asks (current circuit AMONG refs)',
    (_label, proc) => {
      // All three slots pre-filled → entry jumps straight to confirmation.
      const { ws, session } = run(
        proc,
        [
          { text: 'Ring continuity for circuit 5.', now: 1000 },
          // Current circuit 5 is AMONG the conflicting refs {5, 3} — the 5a
          // preflight would filter 5 out and silently switch to 3.
          { text: RING_CONTAMINATED, now: 2000 },
        ],
        { 3: {}, 5: { ring_r1_ohm: '0.31', ring_rn_ohm: '0.29', ring_r2_ohm: '0.47' } }
      );
      expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(1);
      expectNoBareThreeWritten(ws, session);
      // No silent switch: circuit 3 stays untouched.
      expect(Object.keys(session.stateSnapshot.circuits[3])).toHaveLength(0);
    }
  );

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])('%s: AWAITING_CONFIRMATION conflict (current circuit NEITHER ref)', (_label, proc) => {
    const { ws, session } = run(
      proc,
      [
        { text: 'Ring continuity for circuit 13.', now: 1000 },
        { text: RING_CONTAMINATED, now: 2000 },
      ],
      {
        3: {},
        5: {},
        13: { ring_r1_ohm: '0.31', ring_rn_ohm: '0.29', ring_r2_ohm: '0.47' },
      }
    );
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(1);
    expectNoBareThreeWritten(ws, session);
    expect(Object.keys(session.stateSnapshot.circuits[5])).toHaveLength(0);
  });

  test('engine ring confirmation conflict PURGES the stale confirm prompt first', () => {
    const { ws } = run(
      engineRing,
      [
        { text: 'Ring continuity for circuit 5.', now: 1000 },
        { text: RING_CONTAMINATED, now: 2000 },
      ],
      { 3: {}, 5: { ring_r1_ohm: '0.31', ring_rn_ohm: '0.29', ring_r2_ohm: '0.47' } }
    );
    const purgeIdx = ws.sent.findIndex((f) => f.type === 'cancel_pending_tts');
    const askIdx = ws.sent.findIndex(
      (f) => f.type === 'ask_user_started' && f.question === RING_WHICH
    );
    expect(purgeIdx).toBeGreaterThanOrEqual(0);
    expect(askIdx).toBeGreaterThan(purgeIdx);
  });

  test.each([
    ['engine IR', engineIR],
    ['legacy IR twin', legacyIR],
  ])('%s: IR INITIAL-ENTRY conflict asks + masks (IR analogue)', (_label, proc) => {
    // The "…for circuit 3…" digit-swallow exemplar: the IR gap regex breaks
    // on "for", so the digit is unreachable raw OR masked — assert only the
    // digit-protection half here.
    const contaminated = run(proc, [{ text: IR_CONTAMINATED, now: 1000 }], { 3: {}, 5: {} });
    expect(whichCircuitAsks(contaminated.ws, IR_WHICH)).toHaveLength(1);
    expectNoBareThreeWritten(contaminated.ws, contaminated.session);

    // A cleanly-phrased volunteered value on a conflict utterance QUEUES
    // (masked extraction) and drains onto the ANSWERED circuit — proving the
    // conflict path preserves data, not just protection.
    const { ws, session } = run(
      proc,
      [
        {
          text: 'Circuit 5, insulation resistance for circuit 3. Live to live is 200.',
          now: 1000,
        },
      ],
      { 3: {}, 5: {} }
    );
    expect(whichCircuitAsks(ws, IR_WHICH)).toHaveLength(1);
    proc({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 5',
      logger: null,
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[5].ir_live_live_mohm).toBe('200');
    expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBeUndefined();
  });

  test.each([
    ['engine IR', engineIR],
    ['legacy IR twin', legacyIR],
  ])('%s: IR ACTIVE different-entry conflict asks + masks', (_label, proc) => {
    const { ws, session } = run(
      proc,
      [
        { text: 'Insulation resistance for circuit 13.', now: 1000 },
        { text: IR_CONTAMINATED, now: 2000 },
      ],
      { 3: {}, 5: {}, 13: {} }
    );
    expect(whichCircuitAsks(ws, IR_WHICH)).toHaveLength(1);
    expectNoBareThreeWritten(ws, session);
  });

  test('same number stated twice is UNAMBIGUOUS (no conflict, no ask)', () => {
    expect(
      engineDetectEntry('Circuit 13, ring continuity for circuit 13.', ringContinuitySchema)
    ).toEqual({ matched: true, circuit_ref: 13, scope_conflict: false });
    const { ws } = run(
      engineRing,
      [{ text: 'Circuit 13, ring continuity for circuit 13.', now: 1000 }],
      { 13: {} }
    );
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(0);
  });

  test('contradiction shape reported by every detector (engine + both twins)', () => {
    const conflict = { matched: true, circuit_ref: null, scope_conflict: true };
    expect(
      engineDetectEntry('Circuit 10, ring continuity for circuit 13.', ringContinuitySchema)
    ).toEqual(conflict);
    expect(legacyRingDetectEntry('Circuit 10, ring continuity for circuit 13.')).toEqual(conflict);
    expect(
      engineDetectEntry(
        'Circuit 10, insulation resistance for circuit 13.',
        insulationResistanceSchema
      )
    ).toEqual(conflict);
    expect(legacyIrDetectEntry('Circuit 10, insulation resistance for circuit 13.')).toEqual(
      conflict
    );
  });
});

// ---------------------------------------------------------------------------
// 3b. Codex diff-review r1 hardening pins.
// ---------------------------------------------------------------------------

describe('review r1 — collect-all across OCCURRENCES, masking on the ordinary path, conflict data preservation', () => {
  test('repeated SAME-pattern contradiction is collected (engine + both twins)', () => {
    const conflict = { matched: true, circuit_ref: null, scope_conflict: true };
    const text = 'Ring continuity for circuit 10. Ring continuity for circuit 13.';
    expect(engineDetectEntry(text, ringContinuitySchema)).toEqual(conflict);
    expect(legacyRingDetectEntry(text)).toEqual(conflict);
    const irText = 'Insulation resistance for circuit 10. Insulation resistance for circuit 13.';
    expect(engineDetectEntry(irText, insulationResistanceSchema)).toEqual(conflict);
    expect(legacyIrDetectEntry(irText)).toEqual(conflict);
  });

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])(
    '%s: UNAMBIGUOUS repeated scope with a value writes the VALUE, never the span digit',
    (_l, proc) => {
      const { session } = run(
        proc,
        [{ text: 'Circuit 13, ring continuity earths for circuit 13 are 1.19.', now: 1000 }],
        { 13: {} }
      );
      expect(session.stateSnapshot.circuits[13].ring_r2_ohm).toBe('1.19');
    }
  );

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])('%s: conflict-queued value OVERWRITES a pre-filled destination on resolve', (_l, proc) => {
    // awaiting_confirmation conflict with the current circuit AMONG the refs
    // and the destination already holding R2 — the dictated 1.19 must win.
    const { ws, session } = run(
      proc,
      [
        { text: 'Ring continuity for circuit 5.', now: 1000 },
        { text: RING_CONTAMINATED, now: 2000 },
        { text: 'circuit 5', now: 3000 },
      ],
      { 3: {}, 5: { ring_r1_ohm: '0.31', ring_rn_ohm: '0.29', ring_r2_ohm: '0.47' } }
    );
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(1);
    expect(session.stateSnapshot.circuits[5].ring_r2_ohm).toBe('1.19');
    expect(session.stateSnapshot.circuits[3].ring_r2_ohm).toBeUndefined();
  });

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])("%s: an UNRESOLVED episode's queued values survive a conflict replacement", (_l, proc) => {
    const { session } = run(
      proc,
      [
        { text: 'Ring continuity is lives are 0.75.', now: 1000 }, // unresolved, queues R1
        { text: 'Circuit 5, ring continuity for circuit 3.', now: 2000 }, // conflict replaces
        { text: 'circuit 5', now: 3000 },
      ],
      { 3: {}, 5: {} }
    );
    expect(session.stateSnapshot.circuits[5].ring_r1_ohm).toBe('0.75');
  });

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])(
    '%s: a value-only reply to the conflict ask RE-ASKS which_circuit and keeps the queue',
    (_l, proc) => {
      const { ws, session } = run(
        proc,
        [
          { text: 'Circuit 5, ring continuity for circuit 3.', now: 1000 },
          { text: 'Lives are 0.61.', now: 2000 }, // value, not a circuit — re-ask
          { text: 'circuit 5', now: 3000 },
        ],
        { 3: {}, 5: {} }
      );
      expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(2);
      expect(session.stateSnapshot.circuits[5].ring_r1_ohm).toBe('0.61');
    }
  );

  test('engine IR: a conflict reply during awaiting_disambiguation is NOT a disambiguation answer', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {}, 5: {}, 13: {} });
    // Hand-built minimal awaiting_disambiguation state (the pause/resume
    // machinery that produces it normally spans a Sonnet turn).
    session.dialogueScriptState = {
      active: true,
      schemaName: 'insulation_resistance',
      circuit_ref: 13,
      values: {},
      valueCorrections: {},
      slotPendingConfirm: null,
      pending_writes: [],
      skipped_slots: new Set(),
      entered_at: 500,
      last_turn_at: 500,
      circuit_retry_attempted: false,
      last_designation_attempt: null,
      slot_no_progress: null,
      entered_via_pivot: false,
      pivoted_from: null,
      ambiguous_bare_value: null,
      paused: false,
      awaiting_disambiguation: { value: '299', source: 'megaohm' },
      disambiguation_retry_attempted: false,
    };
    engineIR({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Circuit 5, insulation resistance live to live for circuit 3 is 200.',
      logger: null,
      now: 1000,
    });
    // The buffered 299 must NOT have been routed to circuit 13, and the
    // conflict must have asked.
    expect(session.stateSnapshot.circuits[13].ir_live_live_mohm).toBeUndefined();
    expect(session.stateSnapshot.circuits[13].ir_live_earth_mohm).toBeUndefined();
    expect(whichCircuitAsks(ws, IR_WHICH)).toHaveLength(1);
  });

  test('engine: annotated in_response_to reply still switches on a LEADING circuit and never writes the ref as a value', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {}, 14: {} });
    engineRing({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      logger: null,
      now: 1000,
    });
    engineRing({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        '[In response to TTS question: "What are the lives?"] Circuit 14, ring continuity.',
      rawReplyText: 'Circuit 14, ring continuity.',
      logger: null,
      now: 2000,
    });
    expect(session.dialogueScriptState.circuit_ref).toBe(14);
    // The quoted question's "lives" + the leading 14 must not have written
    // 14 (or its clamp 1.4) anywhere.
    for (const c of Object.values(session.stateSnapshot.circuits)) {
      for (const v of Object.values(c)) {
        expect(String(v)).not.toBe('14');
        expect(String(v)).not.toBe('1.4');
      }
    }
  });

  test.each([
    ['engine ring', engineRing, 'circuit 5 is ring continuity'],
    ['legacy ring twin', legacyRing, 'circuit 5 is ring continuity'],
  ])(
    '%s: ACTIVE "circuit N is …" keeps its topic-switch claim (leading pattern must not pre-empt)',
    (_l, proc, switchText) => {
      const { session } = run(
        proc,
        [
          { text: 'Ring continuity for circuit 13.', now: 1000 },
          { text: switchText, now: 2000 },
        ],
        { 5: {}, 13: {} }
      );
      // Topic switch → cleared state, NOT a switch to circuit 5.
      const state = session.dialogueScriptState ?? session.ringContinuityScript ?? null;
      expect(state?.active ?? false).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// 3c. Mini-review r1 pins.
// ---------------------------------------------------------------------------

describe('mini-review r1 — repeated terse, disambiguation switch, conflict follow-up upsert', () => {
  test('repeated TERSE contradiction across sentences is collected (engine + twins)', () => {
    const conflict = { matched: true, circuit_ref: null, scope_conflict: true };
    expect(
      engineDetectEntry('Ring on circuit 10. Ring on circuit 13.', ringContinuitySchema)
    ).toEqual(conflict);
    expect(legacyRingDetectEntry('Ring on circuit 10. Ring on circuit 13.')).toEqual(conflict);
    expect(
      engineDetectEntry('IR for circuit 10. IR for circuit 13.', insulationResistanceSchema)
    ).toEqual(conflict);
    expect(legacyIrDetectEntry('IR for circuit 10. IR for circuit 13.')).toEqual(conflict);
  });

  test('engine IR: a SINGLE different-circuit entry during awaiting_disambiguation switches instead of consuming the routing answer', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {}, 13: {} });
    session.dialogueScriptState = {
      active: true,
      schemaName: 'insulation_resistance',
      circuit_ref: 13,
      values: {},
      valueCorrections: {},
      slotPendingConfirm: null,
      pending_writes: [],
      skipped_slots: new Set(),
      entered_at: 500,
      last_turn_at: 500,
      circuit_retry_attempted: false,
      last_designation_attempt: null,
      slot_no_progress: null,
      entered_via_pivot: false,
      pivoted_from: null,
      ambiguous_bare_value: null,
      paused: false,
      awaiting_disambiguation: { value: '299', source: 'megaohm' },
      disambiguation_retry_attempted: false,
    };
    engineIR({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Circuit 5, insulation resistance live to live is 200.',
      logger: null,
      now: 1000,
    });
    // The buffered 299 must NOT land on circuit 13; the explicit circuit-5
    // reading must land on 5 via the fresh scoped entry.
    expect(session.stateSnapshot.circuits[13].ir_live_live_mohm).toBeUndefined();
    expect(session.stateSnapshot.circuits[5].ir_live_live_mohm).toBe('200');
  });

  test.each([
    ['engine ring', engineRing],
    ['legacy ring twin', legacyRing],
  ])(
    '%s: a conflict follow-up CORRECTION upserts and wins on a pre-filled destination',
    (_l, proc) => {
      const { session } = run(
        proc,
        [
          { text: 'Circuit 5, ring continuity for circuit 3.', now: 1000 },
          { text: 'Lives are 0.61.', now: 2000 },
          { text: 'Lives are 0.63.', now: 3000 }, // correction — newest wins
          { text: 'circuit 5', now: 4000 },
        ],
        { 3: {}, 5: { ring_r1_ohm: '0.31' } } // destination pre-filled
      );
      expect(session.stateSnapshot.circuits[5].ring_r1_ohm).toBe('0.63');
      expect(session.stateSnapshot.circuits[3].ring_r1_ohm).toBeUndefined();
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Existing exclusions unchanged.
// ---------------------------------------------------------------------------

describe('matrix 4 — exclusions preserved', () => {
  test('ring destructive same-utterance entry still falls through (engine)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = engineRing({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Can you delete the readings for the ring continuity on circuit 13',
      logger: null,
      now: 1000,
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toHaveLength(0);
  });

  test('NEW IR guard: destructive same-utterance IR entry falls through (engine)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = engineIR({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Delete the insulation resistance readings for circuit 13.',
      logger: null,
      now: 1000,
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toHaveLength(0);
  });

  test('narration negatives stay negatives', () => {
    expect(engineDetectEntry('the phone is ringing again', ringContinuitySchema).matched).toBe(
      false
    );
    expect(
      engineDetectEntry("we're looking at the ring main now", ringContinuitySchema).matched
    ).toBe(false);
  });

  test('ACTIVE-script topicSwitchTrigger "circuit N is …" still exits the script', () => {
    const { ws, session } = run(
      engineRing,
      [
        { text: 'Ring continuity for circuit 13.', now: 1000 },
        { text: 'circuit 5 is the cooker', now: 2000 },
      ],
      { 5: {}, 13: {} }
    );
    // Topic switch → state cleared, fallthrough — no which_circuit ask, no
    // script write for circuit 5.
    expect(whichCircuitAsks(ws, RING_WHICH)).toHaveLength(0);
    expect(session.dialogueScriptState ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Mid-script circuit switch via a LEADING different-entry (six-reader pin).
// ---------------------------------------------------------------------------

describe('matrix 6 — leading-circuit different-entry switches mid-script', () => {
  test.each([
    ['engine ring', engineRing, 'Circuit 14, ring continuity.', 'ring_r1_ohm'],
    ['legacy ring twin', legacyRing, 'Circuit 14, ring continuity.', 'ring_r1_ohm'],
  ])('%s: switches 13 → 14 from a leading entry', (_label, proc, switchText) => {
    const { session } = run(
      proc,
      [
        { text: 'Ring continuity for circuit 13.', now: 1000 },
        { text: switchText, now: 2000 },
      ],
      { 13: {}, 14: {} }
    );
    const state = session.dialogueScriptState ?? session.ringContinuityScript;
    expect(state.circuit_ref).toBe(14);
  });

  test.each([
    ['engine IR', engineIR],
    ['legacy IR twin', legacyIR],
  ])('%s: switches 13 → 14 from a leading IR entry', (_label, proc) => {
    const { session } = run(
      proc,
      [
        { text: 'Insulation resistance for circuit 13.', now: 1000 },
        { text: 'Circuit 14, insulation resistance.', now: 2000 },
      ],
      { 13: {}, 14: {} }
    );
    const state = session.dialogueScriptState ?? session.insulationResistanceScript;
    expect(state.circuit_ref).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 7. Per-file garble divergences pinned.
// ---------------------------------------------------------------------------

describe('matrix 7 — per-file vocabulary divergences preserved', () => {
  test('IR schema keeps `insurance`; IR twin does NOT gain it', () => {
    expect(
      engineDetectEntry('Circuit 4, insurance resistance.', insulationResistanceSchema)
    ).toEqual({ matched: true, circuit_ref: 4, scope_conflict: false });
    expect(legacyIrDetectEntry('Circuit 4, insurance resistance.').matched).toBe(false);
  });

  test('IR twin keeps `international`; IR schema does NOT gain it', () => {
    expect(legacyIrDetectEntry('Circuit 4, international resistance.')).toEqual({
      matched: true,
      circuit_ref: 4,
      scope_conflict: false,
    });
    expect(
      engineDetectEntry('Circuit 4, international resistance.', insulationResistanceSchema).matched
    ).toBe(false);
  });

  test('ring schema terse leading carries bring/wing; ring twin terse stays ring-only', () => {
    expect(engineDetectEntry('Circuit 6, wing readings.', ringContinuitySchema)).toEqual({
      matched: true,
      circuit_ref: 6,
      scope_conflict: false,
    });
    expect(legacyRingDetectEntry('Circuit 6, wing readings.').matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-schema registry: suppressDestructiveEntry honoured only by guarded
// schemas (engine-only — the flag never reaches the twins).
// ---------------------------------------------------------------------------

describe('suppressDestructiveEntry (engine flag contract)', () => {
  test('flag=true skips ring entry (guarded schema) — falls through to the model', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'recontinuity readings for circuit 13.',
      schemas: [ringContinuitySchema],
      logger: null,
      now: 1000,
      suppressDestructiveEntry: true,
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toHaveLength(0);
    expect(session.dialogueScriptState ?? null).toBeNull();
  });

  test('flag=true skips IR entry too (new IR guard makes IR a guarded schema)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Insulation resistance for circuit 13.',
      schemas: [insulationResistanceSchema],
      logger: null,
      now: 1000,
      suppressDestructiveEntry: true,
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toHaveLength(0);
  });

  test('flag=false (default) leaves entry behaviour unchanged', () => {
    const ws = new FakeWS();
    const session = buildSession({ 13: {} });
    const out = processDialogueTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Ring continuity for circuit 13.',
      schemas: [ringContinuitySchema],
      logger: null,
      now: 1000,
    });
    expect(out.handled).toBe(true);
    expect(session.dialogueScriptState?.active).toBe(true);
  });
});
