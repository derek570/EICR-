/**
 * PLAN-CS (feedback-2026-09-17) — the RCBO BS-standard family after the
 * backend flip to a free-text OCPD standard.
 *
 * What these tests pin, in the plan's own terms:
 *   - CS-100: neither RCBO BS slot is named-extracted, so one stretch of speech
 *     can never fill both — the ambiguity is unreachable, not adjudicated.
 *   - CS-64: no BS-code mirror anywhere; each BS slot is dictated or asked.
 *   - CS-66: `rcd_bs_en` is filled only when its stored value PARSES
 *     (`slotIsFilled`); a skip on a stored-unparseable value hands off.
 *   - CS-70: the RCBO finish line names the RCD's number only when it differs.
 *   - CS-105: an unanswered outstanding ask hands off even when the turn wrote
 *     something else (the contract PLAN-A implements at step 9b).
 *   - Decision 7 (EP cycle 1): a BS standard said and consumed by no BS slot —
 *     at entry or on a turn answering another slot — hands the turn to the
 *     model instead of being dropped. Detected, never attributed.
 *   - The raw reply, not the annotated transcript, reaches the BS parsers,
 *     so annotated, unannotated and mismatched-annotation turns behave
 *     identically.
 *
 * Case letters follow the plan's acceptance 3 list.
 */

import {
  processProtectiveDeviceTurn,
  enterScriptByName,
  tryEnterScriptFromWrites,
  ALL_DIALOGUE_SCHEMAS,
  rcboSchema,
  ocpdSchema,
  rcdSchema,
} from '../extraction/dialogue-engine/index.js';
import { extractNamedFieldValues } from '../extraction/dialogue-engine/helpers/extraction.js';
import { applyDerivations } from '../extraction/dialogue-engine/helpers/derivations.js';
import { normaliseDialogueSlotWrite } from '../extraction/dialogue-engine/helpers/dialogue-slot-normalise.js';
import {
  parseOcpdStandard,
  parseRcdBsCode,
} from '../extraction/dialogue-engine/parsers/bs-code.js';

const SESSION_ID = 'sess_plan_cs';
const Q_OCPD_BS = "What's the BS number of the RCBO?";
const Q_RCD_BS = "What's the RCD's BS number?";

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
    stateSnapshot: {
      circuits: JSON.parse(JSON.stringify(circuits)),
      boards: [{ id: 'main', board_type: 'main' }],
      currentBoardId: 'main',
    },
  };
}

const silentLog = { info: () => {}, warn: () => {} };

/** Every string the engine asked the client to speak. */
const spoken = (ws) => ws.sent.filter((m) => m?.type === 'ask_user_started').map((m) => m.question);
const lastAsk = (ws) => ws.sent.filter((m) => m?.type === 'ask_user_started').at(-1);
const count = (haystacks, needle) =>
  haystacks.reduce((n, s) => n + (s.split(needle).length - 1), 0);

/** The three annotation shapes a reply can arrive in. */
const ANNOTATIONS = {
  matching: (q, reply) => `[In response to TTS question type=stage6_ask_user: "${q}"] ${reply}`,
  none: (_q, reply) => reply,
  // The stale-window shape: the client attached a DIFFERENT question.
  mismatched: (_q, reply) =>
    `[In response to TTS question type=stage6_ask_user: "What's the RCD type?"] ${reply}`,
};

/** One turn. `rawReplyText` is always the bare reply, as sonnet-stream sends it. */
function say(ws, session, reply, now, { annotation = 'none', question = '' } = {}) {
  return processProtectiveDeviceTurn({
    ws,
    session,
    sessionId: SESSION_ID,
    transcriptText: ANNOTATIONS[annotation](question, reply),
    rawReplyText: reply,
    logger: silentLog,
    now,
  });
}

const opsFor = (session, field) =>
  (session.dialogueScriptState?.operations ?? []).filter((op) => op.field === field);

// ── Structural guarantees ────────────────────────────────────────────────────

describe('structure (CS-100 / CS-103 / CS-104 / CS-64)', () => {
  const SCHEMAS = ALL_DIALOGUE_SCHEMAS;

  test('neither RCBO BS slot declares a namedExtractor or namedExtractorCandidates', () => {
    for (const field of ['ocpd_bs_en', 'rcd_bs_en']) {
      const slot = rcboSchema.slots.find((s) => s.field === field);
      expect(slot.namedExtractor).toBeUndefined();
      expect(slot.namedExtractorCandidates).toBeUndefined();
    }
  });

  test('the tree holds exactly two BS extractors: OCPD’s and RCD’s', () => {
    const holders = [];
    for (const schema of SCHEMAS) {
      for (const slot of schema.slots) {
        if (slot.kind === 'bs_code' && (slot.namedExtractor || slot.namedExtractorCandidates)) {
          holders.push(`${schema.name}.${slot.field}`);
        }
      }
    }
    expect(holders.sort()).toEqual(['ocpd.ocpd_bs_en', 'rcd.rcd_bs_en']);
  });

  test('hygiene: within one schema no two slots declare the same extractor source', () => {
    // Catches a byte-identical copy (the shape the RCBO pair had) and nothing
    // more: two differently written regexes can still match the same text.
    for (const schema of SCHEMAS) {
      const sources = [];
      for (const slot of schema.slots) {
        if (slot.namedExtractor instanceof RegExp) sources.push(slot.namedExtractor.source);
        for (const c of slot.namedExtractorCandidates ?? []) sources.push(c.regex.source);
      }
      expect({
        schema: schema.name,
        dupes: sources.filter((s, i) => sources.indexOf(s) !== i),
      }).toEqual({ schema: schema.name, dupes: [] });
    }
  });

  test('no namedExtractor and no candidate regex anywhere is global', () => {
    // `String.prototype.match` on a /g regex returns no capture groups, so the
    // slot would silently never fill.
    for (const schema of SCHEMAS) {
      for (const slot of schema.slots) {
        if (slot.namedExtractor instanceof RegExp) {
          expect({ slot: slot.field, global: slot.namedExtractor.global }).toEqual({
            slot: slot.field,
            global: false,
          });
        }
        for (const c of slot.namedExtractorCandidates ?? []) {
          expect({ slot: slot.field, global: c.regex.global }).toEqual({
            slot: slot.field,
            global: false,
          });
        }
      }
    }
  });

  test('(n) no bs_code slot declares a mirror, and applyDerivations mirrors nothing anywhere', () => {
    for (const schema of SCHEMAS) {
      for (const slot of schema.slots) {
        for (const d of slot.derivations ?? []) expect(d.mirrors).toBeUndefined();
        if (!Array.isArray(slot.derivations)) continue;
        for (const value of ['BS EN 61009', 'BS 3036', 'BS EN 60898', 'B']) {
          const session = {
            stateSnapshot: { circuits: { 1: {} } },
            dialogueScriptState: { circuit_ref: 1, values: {}, operations: [] },
          };
          expect(applyDerivations({ session, schema, slot, value }).mirrorWrites).toEqual([]);
        }
      }
    }
  });

  test('the two BS slots carry the right parsers and flags', () => {
    const find = (schema, field) => schema.slots.find((s) => s.field === field);
    expect(find(ocpdSchema, 'ocpd_bs_en').parser).toBe(parseOcpdStandard);
    expect(find(rcboSchema, 'ocpd_bs_en').parser).toBe(parseOcpdStandard);
    expect(find(rcdSchema, 'rcd_bs_en').parser).toBe(parseRcdBsCode);
    expect(find(rcboSchema, 'rcd_bs_en').parser).toBe(parseRcdBsCode);
    expect(find(rcboSchema, 'rcd_bs_en').volunteeredOnly).toBeUndefined();
    const flagged = [];
    for (const schema of SCHEMAS) {
      for (const slot of schema.slots) {
        if (slot.askWhenStoredUnparseable) flagged.push(`${schema.name}.${slot.field}`);
      }
    }
    expect(flagged.sort()).toEqual(['rcbo.rcd_bs_en', 'rcd.rcd_bs_en']);
  });

  test('the two RCBO BS questions are distinct (moved from the retired mirror suite)', () => {
    const find = (field) => rcboSchema.slots.find((s) => s.field === field);
    expect(find('ocpd_bs_en').question).toBe(Q_OCPD_BS);
    expect(find('rcd_bs_en').question).toBe(Q_RCD_BS);
    expect(find('ocpd_bs_en').question).not.toBe(find('rcd_bs_en').question);
  });
});

// ── Acceptance 3 — OCPD active ingress, production-shaped annotation ────────

describe('acceptance 3 — OCPD script, the annotated BS answer', () => {
  const Q = "What's the BS number of the breaker?";
  function answer(reply) {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'MCB on circuit 5.', 1000);
    const out = say(ws, session, reply, 2000, { annotation: 'matching', question: Q });
    return { ws, session, out };
  }

  test('bare 12345 → BS 12345 (the whole-value grammar reads the RAW reply)', () => {
    const { session, out } = answer('12345');
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS 12345');
  });

  test('BS 9999 → written, not handed off', () => {
    const { session, out } = answer('BS 9999');
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS 9999');
  });

  test('BS 3871 (the September 17 standard) → written as dictated', () => {
    const { session } = answer('BS 3871');
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS 3871');
  });

  test('"There is no RCBO" → PLAN-A first-miss handoff, nothing written', () => {
    const { session, out } = answer('There is no RCBO');
    expect(out.fallthrough).toBe(true);
    expect(out.serverNote.asked_field).toBe('ocpd_bs_en');
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBeUndefined();
  });

  test('"I don\'t know" is the ordinary per-slot skip on a BLANK slot (CS-66 / PLAN-A A-138)', () => {
    // Recorded as an EP deviation: the plan's acceptance line lists this reply
    // as a handoff, but the plan's own CS-66 rule and PLAN-A both keep a skip
    // verb on a blank slot an ordinary skip, and this plan does not change
    // skip semantics. Pinned so the behaviour is a known state.
    const { ws, session, out } = answer("I don't know");
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBeUndefined();
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
  });
});

// ── RCBO walk-through cases ──────────────────────────────────────────────────

describe('acceptance 3 — RCBO, no mirrors (CS-64 / CS-65 / CS-66 / CS-100)', () => {
  // EP cycle 1 (Codex c1-1 / c2-3, Decision 7): the plan let this entry ask for
  // the number again and drop the one just said. Decision 7 forbids a silent
  // skip after a failure to understand, so an entry utterance naming a BS
  // standard the RCBO schema cannot attribute goes to the model instead.
  test('(a) entry "RCBO on circuit 3, BS EN 61009" → handed to the model, nothing consumed or dropped', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const out = say(ws, session, 'RCBO on circuit 3, BS EN 61009', 1000);
    // Not handled by the script: the utterance reaches the model unchanged.
    expect(out.handled).toBe(false);
    expect(session.dialogueScriptState ?? null).toBeNull();
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBeUndefined();
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBeUndefined();
    // The script asked nothing — the model owns this turn.
    expect(spoken(ws)).toEqual([]);
  });

  test.each(Object.keys(ANNOTATIONS))(
    '(b) "BS EN 61009" answering the OCPD BS question → ONE step-8 operation, RCD BS next [%s annotation]',
    (annotation) => {
      const ws = new FakeWS();
      const session = buildSession({ 3: {} });
      say(ws, session, 'RCBO on circuit 3.', 1000);
      // The regression that fails if either BS extractor is ever restored.
      expect(extractNamedFieldValues('BS EN 61009', rcboSchema.slots)).toEqual([]);
      say(ws, session, 'BS EN 61009', 2000, { annotation, question: Q_OCPD_BS });
      const ops = opsFor(session, 'ocpd_bs_en');
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ disposition: 'applied', source: 'step8_bare' });
      expect(opsFor(session, 'rcd_bs_en')).toEqual([]);
      expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    }
  );

  function walkToFinish(ws, session, start = 3000) {
    say(ws, session, 'B', start);
    say(ws, session, '32', start + 1000);
    say(ws, session, '6', start + 2000);
    say(ws, session, 'AC', start + 3000);
    return say(ws, session, '30', start + 4000);
  }

  test('(c) bare 61009 twice → both slots written, curve next, finish names ONE BS number', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    say(ws, session, '61009', 2000);
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS EN 61009');
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBeUndefined();
    expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    say(ws, session, '61009', 2500);
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS EN 61009');
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    walkToFinish(ws, session);
    const finish = lastAsk(ws).question;
    expect(finish).toMatch(/^Got it\. BS EN 61009, type B/);
    expect(count([finish], '61009')).toBe(1);
  });

  test.each(Object.keys(ANNOTATIONS))(
    '(d) OCPD BS 9999 then RCD BS EN 61009 → ONE rcd op, the OCPD standard untouched [%s annotation]',
    (annotation) => {
      const ws = new FakeWS();
      const session = buildSession({ 3: {} });
      say(ws, session, 'RCBO on circuit 3.', 1000);
      say(ws, session, 'BS 9999', 2000, { annotation, question: Q_OCPD_BS });
      const ocpdOpsBefore = opsFor(session, 'ocpd_bs_en').length;
      const out = say(ws, session, 'BS EN 61009', 2500, { annotation, question: Q_RCD_BS });
      // madeProgress TRUE — the asked slot's own parser succeeded and wrote.
      expect(out.fallthrough).toBe(false);
      expect(opsFor(session, 'rcd_bs_en')).toHaveLength(1);
      // The case the family existed for: NO new ocpd_bs_en operation of any
      // disposition — not a write, not a satisfied_existing.
      expect(opsFor(session, 'ocpd_bs_en')).toHaveLength(ocpdOpsBefore);
      expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS 9999');
      expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS EN 61009');
      walkToFinish(ws, session);
      const finish = lastAsk(ws).question;
      expect(finish).toMatch(/^Got it\. BS 9999, RCD BS BS EN 61009, type B/);
      expect(count(spoken(ws), 'BS 9999')).toBe(1);
      expect(count(spoken(ws), 'BS EN 61009')).toBe(1);
    }
  );

  test('(d) with a PRE-EXISTING OCPD standard: the legacy line is suppressed and only the RCD BS is read back', () => {
    const ws = new FakeWS();
    const session = buildSession({
      3: {
        ocpd_bs_en: 'BS 9999',
        ocpd_type: 'B',
        ocpd_rating_a: '32',
        ocpd_breaking_capacity_ka: '6',
        rcd_type: 'AC',
        rcd_operating_current_ma: '30',
      },
    });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    say(ws, session, 'BS EN 61009', 2000);
    expect(lastAsk(ws).question).toBe('Also got RCD BS number BS EN 61009.');
    expect(count(spoken(ws), 'BS 9999')).toBe(0);
  });

  test('(e) stored-unparseable rcd_bs_en: model-write entry asks it; the answer replaces the bytes', () => {
    const ws = new FakeWS();
    const rows = [];
    // The model's `record_reading` has already been applied by the dispatcher
    // when the entry hook runs, so the snapshot carries it.
    const session = buildSession({
      3: {
        ocpd_bs_en: 'BS EN 61009',
        rcd_bs_en: 'BS 9999',
        ocpd_type: 'B',
        ocpd_rating_a: '32',
        ocpd_breaking_capacity_ka: '6',
        rcd_type: 'AC',
        rcd_operating_current_ma: '30',
      },
    });
    const entry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'ocpd_bs_en', circuit: 3, value: 'BS EN 61009' }],
      logger: { info: (e) => rows.push(e), warn: () => {} },
      now: 1000,
    });
    expect(entry.entered).toBe(true);
    expect(rows.some((e) => e.endsWith('_entry_from_write_skipped_all_filled'))).toBe(false);
    expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    say(ws, session, 'BS EN 61009', 2000);
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS EN 61009');
  });

  function storedUnparseableRcbo() {
    const ws = new FakeWS();
    const session = buildSession({
      3: {
        ocpd_bs_en: 'BS EN 61009',
        rcd_bs_en: 'BS 9999',
        ocpd_type: 'B',
        ocpd_rating_a: '32',
        ocpd_breaking_capacity_ka: '6',
        rcd_type: 'AC',
        rcd_operating_current_ma: '30',
      },
    });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    return { ws, session };
  }

  test('(e) cancel before answering → "6 of 7 saved" (the same fill predicate)', () => {
    const { ws, session } = storedUnparseableRcbo();
    say(ws, session, 'cancel', 2000);
    expect(lastAsk(ws).question).toBe('RCBO cancelled. 6 of 7 saved.');
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS 9999');
  });

  test('(e) "leave it blank" on a stored-unparseable value → handoff, bytes kept, not skipped', () => {
    const { ws, session } = storedUnparseableRcbo();
    const skippedBefore = [...(session.dialogueScriptState.skipped_slots ?? [])];
    const out = say(ws, session, 'leave it blank', 2000);
    expect(out.fallthrough).toBe(true);
    expect(out.serverNote.remaining.map((r) => r.field)).toEqual(['rcd_bs_en']);
    expect(out.serverNote.existing_values.rcd_bs_en).toBe('BS 9999');
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS 9999');
    expect(skippedBefore).not.toContain('rcd_bs_en');
    // The script ended — nothing left to extend.
    expect(session.dialogueScriptState).toBeNull();
  });

  test('(e) "leave it blank" on a BLANK rcd_bs_en is an ordinary skip, and the combined line is suppressed', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    say(ws, session, 'BS EN 61009', 2000);
    expect(lastAsk(ws).question).toBe(Q_RCD_BS);
    const out = say(ws, session, 'leave it blank', 2500);
    expect(out.fallthrough).toBe(false);
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    walkToFinish(ws, session);
    const finish = lastAsk(ws).question;
    // rcd_bs_en is finish-covered and never dictated, so allCoveredScriptOwned
    // is false: no combined "Got it." line; each dictated field once instead.
    expect(finish).not.toMatch(/^Got it\./);
    expect(count(spoken(ws), 'BS EN 61009')).toBe(1);
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBeUndefined();
  });

  test('(f) stored legacy rcd_bs_en = 61009-1 parses: not asked, never spoken, legacy line suppressed', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: { rcd_bs_en: '61009-1' } });
    // A bare entry (a BS number at entry now goes to the model — case (a)).
    say(ws, session, 'RCBO on circuit 3.', 1000);
    expect(opsFor(session, 'ocpd_bs_en')).toEqual([]);
    expect(opsFor(session, 'rcd_bs_en')).toEqual([]);
    expect(lastAsk(ws).question).toBe(Q_OCPD_BS);
    say(ws, session, 'BS EN 61009', 2000);
    // rcd_bs_en parses, so the walk goes straight to the curve.
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    walkToFinish(ws, session);
    const finish = lastAsk(ws).question;
    expect(finish).not.toMatch(/^Got it\./);
    expect(count(spoken(ws), '61009-1')).toBe(0);
    expect(count(spoken(ws), 'BS EN 61009')).toBe(1);
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('61009-1');
  });

  test('(f) the same legacy value with the number said AT ENTRY → the model, legacy bytes untouched', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: { rcd_bs_en: '61009-1' } });
    const out = say(ws, session, 'RCBO on circuit 3, BS EN 61009', 1000);
    expect(out.handled).toBe(false);
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('61009-1');
    expect(spoken(ws)).toEqual([]);
  });

  test('(g) RCD-first prose at ENTRY ("the RCD BS code is 61009, …") → handed to the model', () => {
    // The plan had this enter and ask the OCPD question, losing 61009. The
    // detection pattern sees the "BS code is N" lead-in, which the extractor
    // grammar never matched, and the turn goes to the model with it.
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const out = say(ws, session, 'the RCD BS code is 61009, RCBO on circuit 3', 1000);
    expect(out.handled).toBe(false);
    expect(session.dialogueScriptState ?? null).toBeNull();
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBeUndefined();
    expect(spoken(ws)).toEqual([]);
  });

  test('(h) OCPD pivot on 61009 asks the RCD BS exactly once', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'MCB on circuit 5.', 1000);
    say(ws, session, 'BS EN 61009', 2000);
    expect(session.dialogueScriptState.schemaName).toBe('rcbo');
    expect(spoken(ws).filter((q) => q === Q_RCD_BS)).toHaveLength(1);
  });

  test.each(Object.keys(ANNOTATIONS))(
    '(i) a second non-RCD answer (BS 9999) to the RCD BS question → handoff, nothing written to the OCPD standard [%s annotation]',
    (annotation) => {
      const ws = new FakeWS();
      const session = buildSession({ 3: {} });
      say(ws, session, 'RCBO on circuit 3.', 1000);
      say(ws, session, 'BS 9999', 2000, { annotation, question: Q_OCPD_BS });
      const ocpdOps = opsFor(session, 'ocpd_bs_en');
      expect(ocpdOps).toHaveLength(1);
      const out = say(ws, session, 'BS 9999', 2500, { annotation, question: Q_RCD_BS });
      // madeProgress false → the miss is counted and hands off.
      expect(out.fallthrough).toBe(true);
      expect(out.serverNote.remaining.map((r) => r.field)).toContain('rcd_bs_en');
      // NO ocpd_bs_en operation of any disposition from this turn — the
      // recorded list still holds the ONE original OCPD operation.
      const recordedOcpd = out.serverNote.recorded.filter((r) => r.field === 'ocpd_bs_en');
      expect(recordedOcpd).toHaveLength(1);
      expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS 9999');
      expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBeUndefined();
      // PLAN-A's terminal read-back names the original OCPD value exactly once.
      expect(count(spoken(ws), 'BS 9999')).toBe(1);
    }
  );

  test('(j) COMPOUND utterance on the OCPD curve slot writes all three readings, no handoff', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'MCB on circuit 5.', 1000);
    say(ws, session, 'BS EN 60898', 2000);
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    const out = say(ws, session, 'type B, 32 amps, 6 kA', 3000);
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5]).toMatchObject({
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_breaking_capacity_ka: '6',
    });
    // The walk is complete, so the finish line reads each back exactly once.
    expect(session.dialogueScriptState).toBeNull();
    const finish = lastAsk(ws).question;
    expect(finish).toBe('Got it. BS EN 60898, type B, 32 amps, 6 kA.');
    for (const phrase of ['type B', '32 amps', '6 kA']) expect(count(spoken(ws), phrase)).toBe(1);
  });

  test('(k) mid-walk BS override on the OCPD script still writes', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'MCB on circuit 5.', 1000);
    say(ws, session, 'BS EN 60898', 2000);
    const out = say(ws, session, 'type B, actually BS 3871', 3000);
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5].ocpd_bs_en).toBe('BS 3871');
    expect(session.stateSnapshot.circuits[5].ocpd_type).toBe('B');
  });

  test('(k) a volunteered RCD BS number clears its deferred mark on the RCD script', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'RCD on circuit 5.', 1000);
    say(ws, session, 'later', 2000);
    expect(session.dialogueScriptState).toBeNull();
    say(ws, session, 'RCD on circuit 5.', 3000);
    // The deferred BS slot is skipped on re-entry…
    expect(lastAsk(ws).context_field).toBe('rcd_type');
    // …and a volunteered BS value writes and clears the mark.
    say(ws, session, 'type AC, BS 61008', 4000);
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    expect(session.stateSnapshot.circuits[5].rcd_type).toBe('AC');
    expect(session.dialogueDeferredSlots?.rcd?.[5]?.has?.('rcd_bs_en') ?? false).toBe(false);
  });

  test('(k) the RCBO counterpart matches nothing and hands off; the utterance rides transcriptText', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    say(ws, session, 'BS EN 61009', 2000);
    say(ws, session, 'BS EN 61009', 2500);
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    const out = say(ws, session, 'the BS code is 60898', 3000);
    expect(out.fallthrough).toBe(true);
    expect(out.transcriptText).toContain('the BS code is 60898');
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS EN 61009');
  });

  test.each(Object.keys(ANNOTATIONS))(
    '(l) a volunteered BS number on the RCBO curve slot reaches no discriminator and hands off [%s annotation]',
    (annotation) => {
      const ws = new FakeWS();
      const session = buildSession({ 3: {} });
      say(ws, session, 'RCBO on circuit 3.', 1000);
      say(ws, session, 'BS EN 60898', 2000);
      say(ws, session, 'BS EN 61009', 2500);
      expect(lastAsk(ws).context_field).toBe('ocpd_type');
      expect(extractNamedFieldValues('BS EN 61009', rcboSchema.slots)).toEqual([]);
      const before = {
        ocpd: opsFor(session, 'ocpd_bs_en').length,
        rcd: opsFor(session, 'rcd_bs_en').length,
      };
      const out = say(ws, session, 'BS EN 61009', 3000, {
        annotation,
        question: 'What MCB curve? B, C, or D?',
      });
      expect(out.fallthrough).toBe(true);
      // The value reaches the model in the SIBLING transcriptText…
      expect(out.transcriptText).toContain('BS EN 61009');
      // …and structurally NOT in the note: it has no raw-transcript field, and
      // this turn produced no BS operation of any disposition, so no row can
      // carry it.
      expect(Object.keys(out.serverNote).sort()).toEqual(
        [
          'asked_field',
          'asked_question',
          'circuit_ref',
          'derived_replaced',
          'directive',
          'existing_values',
          'kind',
          'recorded',
          'remaining',
          'schema',
        ].sort()
      );
      expect(before).toEqual({ ocpd: 1, rcd: 1 });
      expect(out.serverNote.recorded.filter((r) => r.field === 'ocpd_bs_en')).toHaveLength(1);
      expect(out.serverNote.recorded.find((r) => r.field === 'ocpd_bs_en').value).toBe(
        'BS EN 60898'
      );
    }
  );

  test('(m) the round-15 counter-example on the RCD script writes BOTH readings', () => {
    const ws = new FakeWS();
    const session = buildSession({ 5: {} });
    say(ws, session, 'RCD on circuit 5.', 1000);
    expect(lastAsk(ws).context_field).toBe('rcd_bs_en');
    const out = say(ws, session, 'trip time, BS 61008, 25 ms', 2000);
    expect(out.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    expect(
      session.stateSnapshot.circuits[5].rcd_time_ms ??
        session.stateSnapshot.circuits[5].rcd_trip_time
    ).toBe('25');
    expect(opsFor(session, 'rcd_bs_en').filter((o) => o.disposition === 'applied')).toHaveLength(1);
  });

  test.each(Object.keys(ANNOTATIONS))(
    '(o) COMPOUND answer to the OCPD BS question hands off even though it wrote the curve [%s annotation]',
    (annotation) => {
      const ws = new FakeWS();
      const session = buildSession({ 3: {} });
      say(ws, session, 'RCBO on circuit 3.', 1000);
      // (1) the BS half matches nothing; the curve half matches.
      expect(extractNamedFieldValues('BS EN 61009, type B', rcboSchema.slots)).toEqual([
        { field: 'ocpd_type', value: 'B' },
      ]);
      const out = say(ws, session, 'BS EN 61009, type B', 2000, {
        annotation,
        question: Q_OCPD_BS,
      });
      // (2) no ocpd_bs_en operation of any disposition.
      expect(opsFor(session, 'ocpd_bs_en')).toEqual([]);
      expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBeUndefined();
      // (3) the understood reading is kept and spoken once.
      expect(session.stateSnapshot.circuits[3].ocpd_type).toBe('B');
      // (4) the turn hands off even though writes.length > 0.
      expect(out.fallthrough).toBe(true);
      expect(out.serverNote.asked_field).toBe('ocpd_bs_en');
      // (5) the carrier pair: the utterance is in transcriptText; the note
      // carries field NAMES and the applied curve, never the BS value.
      expect(out.transcriptText).toContain('BS EN 61009, type B');
      expect(out.serverNote.remaining.map((r) => r.field)).toEqual(
        expect.arrayContaining(['ocpd_bs_en', 'rcd_bs_en'])
      );
      expect(out.serverNote.recorded).toEqual([
        expect.objectContaining({ field: 'ocpd_type', value: 'B' }),
      ]);
      expect(out.serverNote.existing_values).toEqual({});
      // (6) the script does not ask the BS question again.
      expect(session.dialogueScriptState).toBeNull();
      expect(spoken(ws).filter((q) => q === Q_OCPD_BS)).toHaveLength(1);
    }
  );

  test('(o) siblings: an ordinary answer is not a miss; a compound answer that ALSO names a standard hands off', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    say(ws, session, 'BS EN 61009', 2000);
    say(ws, session, 'BS EN 61009', 2500);
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    const plain = say(ws, session, 'type B', 3000);
    expect(plain.fallthrough).toBe(false);

    // EP cycle 1 (Codex c2-2, Decision 7): the plan recorded this as a residual
    // silent loss. The standard is DETECTED (never attributed), so the turn
    // keeps its curve write, reads it back once, and hands the utterance —
    // BS number included — to the model instead of dropping it.
    const ws2 = new FakeWS();
    const session2 = buildSession({ 3: {} });
    say(ws2, session2, 'RCBO on circuit 3.', 1000);
    say(ws2, session2, 'BS EN 60898', 2000);
    say(ws2, session2, 'BS EN 61009', 2500);
    const compound = say(ws2, session2, 'BS EN 61009, type B', 3000);
    expect(compound.fallthrough).toBe(true);
    expect(compound.transcriptText).toContain('BS EN 61009, type B');
    expect(session2.stateSnapshot.circuits[3].ocpd_type).toBe('B');
    // Nothing guessed: the stored OCPD standard is untouched by the engine.
    expect(session2.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS EN 60898');
    expect(compound.serverNote.recorded.filter((r) => r.field === 'ocpd_type')).toHaveLength(1);
    // PLAN-A's terminal read-back names everything the walk captured exactly
    // once, the curve included.
    expect(count(spoken(ws2), 'curve B')).toBe(1);
    expect(count(spoken(ws2), 'BS EN 60898')).toBe(1);
  });
});

// ── Seeds (acceptance 3 (n), second half) ────────────────────────────────────

describe('dialogue seeds canonicalise through the field’s own parser', () => {
  test.each([
    ['ocpd_bs_en', '60898-1', { ok: true, value: 'BS EN 60898' }],
    ['ocpd_bs_en', 'BS 3871', { ok: true, value: 'BS 3871' }],
    ['ocpd_bs_en', 'the breaker is fine', { ok: false, reason: 'seed_unparseable' }],
    ['rcd_bs_en', 'BS 3871', { ok: false, reason: 'seed_unparseable' }],
    ['rcd_bs_en', '', { ok: false, reason: 'seed_blank' }],
    ['rcd_bs_en', '61009-1', { ok: true, value: 'BS EN 61009' }],
  ])('%s seed %j', (field, value, expected) => {
    expect(normaliseDialogueSlotWrite(rcboSchema, field, value)).toMatchObject(expected);
  });

  test('an unparseable RCD seed is not stored; the script still enters and asks it', () => {
    const ws = new FakeWS();
    const session = buildSession({ 4: {} });
    const result = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcd',
      circuit_ref: 4,
      pending_writes: [{ field: 'rcd_bs_en', value: 'BS 3871' }],
      ws,
      logger: silentLog,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(session.stateSnapshot.circuits[4].rcd_bs_en).toBeUndefined();
    expect(lastAsk(ws).context_field).toBe('rcd_bs_en');
  });
});

// ── Entry routing is unchanged by the loss of `volunteeredOnly` ─────────────

describe('model-write entry routing (tryEnterScriptFromWrites specificity ranking)', () => {
  function enterFrom(readings) {
    const ws = new FakeWS();
    const session = buildSession({
      3: Object.fromEntries(readings.map((r) => [r.field, r.value])),
    });
    tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings,
      logger: silentLog,
      now: 1000,
    });
    return { ws, session };
  }

  test('an rcd_bs_en write ALONE still enters the RCD walk, not RCBO (2026-06-02 ranking)', () => {
    const { session } = enterFrom([{ field: 'rcd_bs_en', circuit: 3, value: 'BS EN 61008' }]);
    expect(session.dialogueScriptState.schemaName).toBe('rcd');
  });

  test('a full RCBO spec still enters RCBO', () => {
    const { session } = enterFrom([
      { field: 'ocpd_bs_en', circuit: 3, value: 'BS EN 61009' },
      { field: 'ocpd_type', circuit: 3, value: 'B' },
      { field: 'rcd_type', circuit: 3, value: 'A' },
    ]);
    expect(session.dialogueScriptState.schemaName).toBe('rcbo');
  });
});

// ── EP review cycle 2 (Codex c3) — the same Decision 7 rule on every path ──

describe('EP cycle 2 — an unattributed BS standard is never dropped', () => {
  test.each([
    'RCBO on circuit 3, the BS code for the RCD is 61009',
    'RCBO on circuit 3, BS 6 1 zero zero 9',
  ])('entry phrasing %j goes to the model (c3-1)', (text) => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    const out = say(ws, session, text, 1000);
    expect(out.handled).toBe(false);
    expect(spoken(ws)).toEqual([]);
  });

  test('"skip that, BS EN 61009" on the curve question hands off instead of skipping (c3-2)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    say(ws, session, 'BS EN 60898', 2000);
    say(ws, session, 'BS EN 61009', 2500);
    expect(lastAsk(ws).context_field).toBe('ocpd_type');
    const out = say(ws, session, 'skip that, BS EN 61009', 3000);
    expect(out.fallthrough).toBe(true);
    expect(out.transcriptText).toContain('skip that, BS EN 61009');
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS EN 60898');
  });

  test('a drained pending write that fills the last slot still hands off a newly named standard (c3-3)', () => {
    const ws = new FakeWS();
    const session = buildSession({
      3: {
        ocpd_type: 'B',
        ocpd_rating_a: '32',
        ocpd_breaking_capacity_ka: '6',
        rcd_type: 'A',
        rcd_operating_current_ma: '30',
        rcd_bs_en: 'BS EN 61008',
      },
    });
    const entered = enterScriptByName({
      session,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'rcbo',
      circuit_ref: null,
      pending_writes: [{ field: 'ocpd_bs_en', value: 'BS 9999' }],
      ws,
      logger: silentLog,
      now: 1000,
    });
    expect(entered.queued_writes).toEqual(['ocpd_bs_en']);
    const out = say(ws, session, 'circuit 3, RCD BS EN 61009', 2000);
    expect(out.fallthrough).toBe(true);
    expect(out.transcriptText).toContain('RCD BS EN 61009');
    // The drained write landed and is read back once; the stored RCD value is
    // untouched — the model owns the unattributed one.
    expect(session.stateSnapshot.circuits[3].ocpd_bs_en).toBe('BS 9999');
    expect(session.stateSnapshot.circuits[3].rcd_bs_en).toBe('BS EN 61008');
    expect(count(spoken(ws), 'BS 9999')).toBe(1);
  });

  test('ordinary RCBO answers never trip the detection (no false hand-off)', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: {} });
    say(ws, session, 'RCBO on circuit 3.', 1000);
    for (const [reply, t] of [
      ['BS EN 61009', 2000],
      ['61009', 2500],
      ['type B', 3000],
      ['32 amps', 4000],
      ['6 kA', 5000],
      ['type A', 6000],
    ]) {
      const out = say(ws, session, reply, t);
      expect({ reply, fallthrough: out.fallthrough }).toEqual({ reply, fallthrough: false });
    }
    const out = say(ws, session, '30', 7000);
    expect(out.fallthrough).toBe(false);
    expect(lastAsk(ws).question).toMatch(/^Got it\./);
  });
});

describe('EP cycle 3 — a circuit designated "BS 3" is not a stated standard (c4-1)', () => {
  test('entry "RCBO on circuit BS 3" enters and asks, no hand-off', () => {
    const ws = new FakeWS();
    const session = buildSession({ 3: { circuit_designation: 'BS 3' } });
    const out = say(ws, session, 'RCBO on circuit 3.', 1000);
    expect(out.handled).toBe(true);
    const out2 = say(ws, session, 'BS EN 61009', 2000);
    expect(out2.fallthrough).toBe(false);
    const out3 = say(ws, session, 'BS EN 61009', 2500);
    expect(out3.fallthrough).toBe(false);
    // "curve B on circuit BS 3" answers the curve; the designation's single
    // digit is not a standard, so the walk continues.
    const out4 = say(ws, session, 'curve B on circuit BS 3', 3000);
    expect(out4.fallthrough).toBe(false);
    expect(session.stateSnapshot.circuits[3].ocpd_type).toBe('B');
  });
});
