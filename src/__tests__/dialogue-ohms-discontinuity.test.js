/**
 * PLAN-A2 (2026-09-23) — feedback ids 141 and 142.
 *
 * id 141: the inspector dictated *"Open circuit"* for a ring CPC. The ring slot
 * grammar CAPTURED the word, `parseOhms` returned null, and the engine wrote
 * nothing — then asked for the same leg again. The reading was invisible to a
 * hands-free inspector, which Audio-First invariant #2 forbids outright. The
 * legacy twin has mapped the same six forms to "∞" since it was written, so the
 * engine was the half that drifted.
 *
 * id 142: a ring CPC result was recorded as `r2_ohm` (the radial field). The
 * prompt listed `r2_ohm` as a valid target for exactly that utterance, so this
 * suite also locks the structural half of the prompt fix — the routing rule's
 * assertions live in stage6-agentic-prompt.test.js, next to the other prompt
 * invariants.
 *
 * What is pinned here:
 *   1. the six discontinuity forms → "∞", and LIM/numeric behaviour unchanged;
 *   2. three-grammar parity — engine parser, legacy `parseValue`, and the
 *      `RING_VALUE_GROUP` capture alternation agree on those six;
 *   3. IR is untouched (both megaohm grammars), because "infinite" means
 *      SATURATION on an insulation reading and OPEN on a continuity one — the
 *      two must never converge;
 *   4. "∞" is SPOKEN as "infinity" on both spoken paths, and stored as the
 *      character.
 */
import { parseOhms } from '../extraction/dialogue-engine/parsers/ohms.js';
import {
  processRingContinuityTurn,
  tryEnterScriptFromWrites,
  enterScriptByName,
  ALL_DIALOGUE_SCHEMAS,
} from '../extraction/dialogue-engine/index.js';
import { isHandedOff } from '../extraction/dialogue-handoff-tombstone.js';
import { parseMegaohms } from '../extraction/dialogue-engine/parsers/megaohms.js';
import {
  RING_VALUE_GROUP,
  ringContinuitySchema,
} from '../extraction/dialogue-engine/schemas/ring-continuity.js';
import { __testing__ as ringLegacy } from '../extraction/ring-continuity-script.js';
import { __testing__ as irLegacy } from '../extraction/insulation-resistance-script.js';
import {
  INFINITY_SENTINEL,
  speakSentinelValue,
  buildValueSpokenTail,
  buildConfirmationText,
} from '../extraction/confirmation-text.js';

// The exact six the plan names. Not "everything that sounds open" — widening
// this set is a behaviour change that has to move all three grammars at once.
const SIX_FORMS = ['infinite', 'infinity', 'open', 'open circuit', 'open ring', 'discontinuous'];

describe('PLAN-A2 acceptance 1 — parseOhms writes the discontinuity sentinel', () => {
  test.each(SIX_FORMS)('"%s" → ∞', (form) => {
    expect(parseOhms(form)).toBe(INFINITY_SENTINEL);
  });

  test.each(SIX_FORMS)(
    '"%s" inside a dictated sentence is NOT a bare reply — the named extractor owns it',
    (form) => {
      // Anchoring is what makes the whole-utterance bare-value fallback safe,
      // and the cost is that a field-qualified sentence no longer parses HERE.
      // It is not lost: the namedExtractor matches the field word and hands
      // this parser the bare captured token. Proven end to end below in
      // "the recorded CC9E0915 walk" and in the named-extractor test.
      expect(parseOhms(`The CPC is ${form}.`)).toBeNull();
    }
  );

  test('the sentinel character is U+221E, not a lookalike', () => {
    expect(INFINITY_SENTINEL).toBe('∞');
    expect(INFINITY_SENTINEL).toHaveLength(1);
  });

  test('numeric readings are unchanged (no regression)', () => {
    expect(parseOhms('0.43')).toBe('0.43');
    expect(parseOhms('.43')).toBe('0.43');
    expect(parseOhms('43')).toBe('43');
    expect(parseOhms('0.43 ohms')).toBe('0.43');
  });

  test('a BARE LIM reply still wins over the discontinuity branch', () => {
    // A limitation means the test was NOT performed; ∞ means it WAS performed
    // and the conductor is open. They are different facts on the certificate,
    // so the LIM branch keeps its existing precedence over the new one.
    expect(parseOhms('LIM')).toBe('LIM');
    expect(parseOhms('limb')).toBe('LIM');
    expect(parseOhms('limp')).toBe('LIM');
    expect(parseOhms('limitation')).toBe('LIM');
    expect(parseOhms("it's a limitation.")).toBe('LIM');
  });

  test('a contradictory mixed reply matches NEITHER matcher and re-asks', () => {
    // Both matchers are whole-reply anchored, so the LIM-before-∞ ordering is a
    // contract rather than a tie-break — they cannot both fire on one reply.
    // "limitation" and "open" are contradictory facts on a certificate ("not
    // tested" against "tested and open"), and the earlier permissive form
    // resolved that contradiction silently, in the OPPOSITE direction to
    // stage6-answer-resolver.js. Null re-asks, which is the honest answer.
    expect(parseOhms('the breaking capacity is a limitation')).toBeNull();
    expect(parseOhms('limitation — the circuit is open')).toBeNull();
  });

  test('near-bare filler is accepted, exactly as the LIM matcher accepts it', () => {
    // The same light filler parseLimSlot allows, for the same reason: an
    // inspector says "it's open circuit", not a bare token.
    for (const v of [
      'Open circuit.',
      "it's open circuit",
      'it is discontinuous',
      'an open ring',
      'the reading is infinite',
      'value is infinity',
      'discontinuous!',
    ]) {
      expect(parseOhms(v)).toBe(INFINITY_SENTINEL);
    }
  });

  test('ordinary speech containing "open" does NOT write the sentinel', () => {
    // THE REGRESSION THIS EXISTS FOR (Codex EP review, finding 2). The engine's
    // bare-value fallback runs this parser over the WHOLE utterance whenever no
    // named extractor matched, so during an active ring loop any of these would
    // otherwise certify a conductor as broken on a live certificate. No
    // topic-switch pattern intercepts them, and the 60 s / 180 s ring timers
    // bound the exposure window without undoing the write.
    for (const v of [
      "I'll open the board",
      'leave the door open',
      "I can't get it open",
      'the window is open',
      'can you keep that open',
      'open the cupboard for me',
      'it was open when I got here',
    ]) {
      expect(parseOhms(v)).toBeNull();
    }
  });

  test('word-anchored: "opening" / "reopened" / "infinitely" never match', () => {
    for (const near of ['opening', 'reopened', 'infinitely', 'openness']) {
      expect(parseOhms(near)).not.toBe(INFINITY_SENTINEL);
    }
  });

  test('a sentinel mixed with a stray number keeps its pre-PLAN-A2 numeric result', () => {
    // Deliberately UNCHANGED, and pinned so the choice is visible. "open
    // circuit on the 2.5" is not a bare reply, so the sentinel branch declines
    // and the numeric branch returns "2.5" — exactly what it returned before
    // PLAN-A2. Suppressing the number whenever a sentinel word appears
    // anywhere would silently drop real readings like "0.43, the board was
    // open", trading a known non-issue for an Audio-First #2 violation.
    expect(parseOhms('open circuit on the 2.5')).toBe('2.5');
  });

  test('non-strings and empty input still return null', () => {
    expect(parseOhms(null)).toBeNull();
    expect(parseOhms(undefined)).toBeNull();
    expect(parseOhms(42)).toBeNull();
    expect(parseOhms('')).toBeNull();
    expect(parseOhms('no reading here')).toBeNull();
  });
});

describe('PLAN-A2 acceptance 1 — three-grammar parity on the six forms', () => {
  // The capture alternation, the engine parser and the legacy twin are three
  // independent spellings of one rule. id 141 existed because they disagreed:
  // the alternation captured the word and the parser dropped it.
  const captureRe = new RegExp(`^(?:${RING_VALUE_GROUP})$`, 'i');

  test.each(SIX_FORMS)('"%s": captured, parsed by the engine, parsed by the twin', (form) => {
    // The alternation captures on the HEAD word ("open" for "open circuit"),
    // which is what the slot extractor hands to the parser.
    const head = form.split(' ')[0];
    expect(captureRe.test(head)).toBe(true);
    expect(parseOhms(form)).toBe(INFINITY_SENTINEL);
    expect(ringLegacy.parseValue(form)).toBe(INFINITY_SENTINEL);
  });

  test('engine and twin agree on numerics and on plain non-values too', () => {
    for (const v of ['0.43', '.43', '43', 'no reading here', '']) {
      expect(parseOhms(v)).toBe(ringLegacy.parseValue(v));
    }
  });

  test('the engine is deliberately NARROWER than the twin on non-bare text', () => {
    // Recorded, not hidden. The twin scans for the sentinel words ANYWHERE;
    // the engine requires a bare/near-bare reply, because only the engine has
    // the whole-utterance bare-value fallback that made an anywhere-scan
    // dangerous. Parity holds where the plan requires it (the six forms,
    // numerics, plain non-values) and breaks only in the SAFE direction: a
    // missed sentinel re-asks, a false one corrupts a certificate.
    //
    // The twin is not in the live path — sonnet-stream.js imports the dialogue
    // engine — so this divergence changes no shipped behavior. If the twin is
    // ever revived, it needs this same anchoring first.
    for (const v of ["I'll open the board", 'leave the door open', 'it was open when I got here']) {
      expect(ringLegacy.parseValue(v)).toBe(INFINITY_SENTINEL);
      expect(parseOhms(v)).toBeNull();
    }
    // And where a digit is present the engine keeps the pre-existing numeric
    // answer while the twin returns the sentinel — still narrower on the
    // sentinel, never wider.
    expect(ringLegacy.parseValue('open circuit on the 2.5')).toBe(INFINITY_SENTINEL);
    expect(parseOhms('open circuit on the 2.5')).toBe('2.5');
  });

  test('a FIELD-QUALIFIED sentinel still writes, via the named extractor', () => {
    // The anchoring does not cost the field-qualified form. The namedExtractor
    // matches the field word and hands this parser the BARE captured token —
    // the same route parseLimSlot documents for "the rating is a limitation".
    const captureRe = new RegExp(`(${RING_VALUE_GROUP})`, 'i');
    for (const utterance of [
      'The CPC is open circuit.',
      'CPC is discontinuous.',
      'earths are infinite',
    ]) {
      const captured = utterance.match(captureRe)?.[1];
      expect(captured).toBeDefined();
      expect(parseOhms(captured)).toBe(INFINITY_SENTINEL);
    }
  });

  test('the three ring slots all use the parser that writes the sentinel', () => {
    // A slot wired to a different parser would silently keep the old
    // drop-the-reading behaviour on one leg only.
    const fields = ringContinuitySchema.slots.map((s) => s.field);
    expect(fields).toEqual(['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm']);
    for (const slot of ringContinuitySchema.slots) {
      expect(slot.parser('open circuit')).toBe(INFINITY_SENTINEL);
    }
  });
});

describe('PLAN-A2 acceptance 1 — insulation resistance is NOT touched', () => {
  // "Infinite" on an IR reading means the meter saturated (a GOOD result, ">999
  // MΩ"); on a continuity reading it means the conductor is open (a C2 defect).
  // Collapsing the two would turn a healthy insulation reading into a fault, or
  // a broken CPC into a pass.
  const IR_CASES = [
    ['infinite', '>999'],
    ['infinity', '>999'],
    ['greater than 200', '>200'],
    ['>200', '>200'],
    ['LIM', 'LIM'],
    ['limitation', 'LIM'],
    ['200', '200'],
  ];

  test.each(IR_CASES)('parseMegaohms("%s") → %s', (input, expected) => {
    expect(parseMegaohms(input)).toBe(expected);
  });

  test('parseMegaohms("open circuit") is still null — "open" is not an IR sentinel', () => {
    expect(parseMegaohms('open circuit')).toBeNull();
    expect(parseMegaohms('open')).toBeNull();
    expect(parseMegaohms('discontinuous')).toBeNull();
  });

  test('the legacy IR twin agrees on every one of those', () => {
    for (const [input, expected] of IR_CASES) {
      expect(irLegacy.parseValue(input)).toBe(expected);
    }
    expect(irLegacy.parseValue('open circuit')).toBeNull();
  });
});

describe('PLAN-A2 — the sentinel is STORED as a character and SPOKEN as a word', () => {
  test('speakSentinelValue maps only the sentinel, and passes everything else through', () => {
    expect(speakSentinelValue(INFINITY_SENTINEL)).toBe('infinity');
    expect(speakSentinelValue(` ${INFINITY_SENTINEL} `)).toBe('infinity');
    expect(speakSentinelValue('0.43')).toBe('0.43');
    expect(speakSentinelValue('LIM')).toBe('LIM');
    expect(speakSentinelValue('?')).toBe('?');
    expect(speakSentinelValue(null)).toBeNull();
    expect(speakSentinelValue(undefined)).toBeUndefined();
  });

  test('buildValueSpokenTail speaks "infinity", never the bare character', () => {
    const tail = buildValueSpokenTail('ring_r2_ohm', INFINITY_SENTINEL, 'ring R2');
    expect(tail).toBe('ring R2 infinity');
    expect(tail).not.toContain(INFINITY_SENTINEL);
  });

  test('the sentinel branch sits between LIM and the correction clause', () => {
    // LIM first (a limitation is a limitation whatever the field), then the
    // sentinel, then the clamp correction — a sentinel is never numerically
    // clamped, so if both were somehow present the sentinel is the safer read.
    expect(buildValueSpokenTail('ring_r2_ohm', 'LIM', 'ring R2')).toBe(
      'ring R2 recorded as LIM — limitation'
    );
    expect(
      buildValueSpokenTail('ring_r2_ohm', INFINITY_SENTINEL, 'ring R2', {
        correction: { original: '16', corrected: '1.6' },
      })
    ).toBe('ring R2 infinity');
    expect(
      buildValueSpokenTail('r1_r2_ohm', '1.6', 'R1+R2', {
        correction: { original: '16', corrected: '1.6' },
      })
    ).toBe('R1+R2 recorded as 1.6 — I corrected 16 to 1.6');
  });

  test('ordinary values keep their byte-identical spoken tails', () => {
    expect(buildValueSpokenTail('ring_r2_ohm', '0.43', 'ring R2')).toBe('ring R2 0.43');
    expect(buildValueSpokenTail('number_of_points', '6', 'points')).toBe('6 points');
    expect(buildValueSpokenTail('zs_ohm', '0.62', 'Zs', { calculated: true })).toBe(
      'Zs calculated as 0.62'
    );
  });
});

describe('PLAN-A2 acceptance 2 — the ring triple read-back speaks "infinity"', () => {
  const buildMessage = ringContinuitySchema.confirmation.buildMessage;

  test('R1 0.43, Rn 0.43, R2 ∞ → "R1 0.43, Rn 0.43, R2 infinity. All correct?"', () => {
    // The exact string the recorded CC9E0915 session should have heard. This is
    // the ONLY ring path that speaks stored values, so it is the only place a
    // stored "∞" can reach TTS.
    const question = buildMessage({
      values: {
        ring_r1_ohm: '0.43',
        ring_rn_ohm: '0.43',
        ring_r2_ohm: INFINITY_SENTINEL,
      },
    });
    expect(question).toBe('R1 0.43, Rn 0.43, R2 infinity. All correct?');
    expect(question).not.toContain(INFINITY_SENTINEL);
  });

  test('every leg goes through the helper, not just R2', () => {
    const question = buildMessage({
      values: {
        ring_r1_ohm: INFINITY_SENTINEL,
        ring_rn_ohm: INFINITY_SENTINEL,
        ring_r2_ohm: INFINITY_SENTINEL,
      },
    });
    expect(question).toBe('R1 infinity, Rn infinity, R2 infinity. All correct?');
  });

  test('an all-numeric triple is byte-identical to before (replay corpus pin)', () => {
    expect(
      buildMessage({
        values: { ring_r1_ohm: '0.43', ring_rn_ohm: '0.43', ring_r2_ohm: '0.78' },
      })
    ).toBe('R1 0.43, Rn 0.43, R2 0.78. All correct?');
  });

  test('unfilled legs still render "?", and a clamp still appends its own sentence', () => {
    expect(buildMessage({ values: { ring_r1_ohm: '0.43' } })).toBe(
      'R1 0.43, Rn ?, R2 ?. All correct?'
    );
    expect(
      buildMessage({
        values: { ring_r1_ohm: '1.6', ring_rn_ohm: '0.43', ring_r2_ohm: INFINITY_SENTINEL },
        corrections: { ring_r1_ohm: { original: '16', corrected: '1.6' } },
      })
    ).toBe('R1 1.6, Rn 0.43, R2 infinity. I corrected 16 to 1.6. All correct?');
  });
});

describe('PLAN-A2 acceptance 2 — the recorded CC9E0915 11:39:34 walk, end to end', () => {
  // Session CC9E0915, 11:38:57–11:40:13: lives 0.43, neutrals 0.43, then "Open
  // circuit." for the CPC. What actually happened was three misses, a canned
  // hint offering "a number, greater than X, or LIM" (none of which is the
  // right answer for an open CPC), a context-free model question that timed out
  // after 45 s, and finally "R1 0.43, Rn 0.43, R2 ?. All correct?" — the
  // reading gone. This walks the same transcript through the live engine.
  const SESSION_ID = 'sess_a2_cc9e0915';

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

  function walk(cpcReply) {
    const ws = new FakeWS();
    const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 1: {} } } };
    const turn = (transcriptText, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        rawReplyText: transcriptText,
        logger: null,
        now,
      });
    turn('Ring continuity on circuit 1. Lives are 0.43.', 1000);
    turn('0.43', 2000);
    turn(cpcReply, 3000);
    turn('Yes.', 4000);
    return { ws, session };
  }

  test.each(['Open circuit.', 'open circuit.', 'Discontinuous.', 'Infinity.'])(
    '"%s" writes ring_r2_ohm = ∞, asks the CPC exactly once, and reads back "infinity"',
    (cpcReply) => {
      const { ws, session } = walk(cpcReply);

      // 1. The reading is STORED, as the character.
      expect(session.stateSnapshot.circuits[1]).toEqual({
        ring_r1_ohm: '0.43',
        ring_rn_ohm: '0.43',
        ring_r2_ohm: INFINITY_SENTINEL,
      });

      // 2. Zero repeated CPC asks — the miss/miss/miss/hint/handoff loop is
      //    what the inspector actually experienced, and it is gone.
      const cpcAsks = ws.sent.filter((f) => f.question === "What's the CPC?");
      expect(cpcAsks).toHaveLength(1);

      // 3. Exactly one confirmation, speaking the word, never the character.
      const confirms = ws.sent.filter((f) => f.reason === 'confirm_ring_continuity');
      expect(confirms).toHaveLength(1);
      expect(confirms[0].question).toBe('R1 0.43, Rn 0.43, R2 infinity. All correct?');
      expect(confirms[0].question).not.toContain(INFINITY_SENTINEL);

      // 4. A positive reply closes the loop without re-reading the triple.
      expect(ws.sent.at(-1)).toMatchObject({ question: 'Got it.', reason: 'info' });
      expect(ws.sent.filter((f) => /All correct\?$/.test(f.question ?? ''))).toHaveLength(1);
    }
  );

  test('a numeric CPC walk is unchanged (the same harness, as a control)', () => {
    const { ws, session } = walk('0.78');
    expect(session.stateSnapshot.circuits[1].ring_r2_ohm).toBe('0.78');
    const confirms = ws.sent.filter((f) => f.reason === 'confirm_ring_continuity');
    expect(confirms).toHaveLength(1);
    expect(confirms[0].question).toBe('R1 0.43, Rn 0.43, R2 0.78. All correct?');
  });
});

describe('PLAN-A2 — the TERMINAL read-back speaks the sentinel too (Codex EP review, blocker 1)', () => {
  // The confirmed-triple path was the obvious one and it was covered. This is
  // the path that was NOT: a ring walk that ends before the triple is
  // confirmed — cancelled, deferred, or otherwise terminated — reads back what
  // it collected through computeUncoveredReadback, which interpolated the raw
  // stored value. Making parseOhms write "∞" made that route newly reachable
  // for the five continuity fields, so the fix and this test arrived together.
  //
  // Red-proof, run before the test was written: with the one-line engine fix
  // reverted, this exact walk emits "Ring continuity cancelled. 1 of 3 saved.
  // Also got lives ∞." — an applied reading whose read-back is silence in
  // every TTS voice, which is Audio-First invariant #1 violated on the nose.
  const SESSION_ID = 'sess_a2_terminal';

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

  function walkThenExit(exitPhrase) {
    const ws = new FakeWS();
    const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 1: {} } } };
    const turn = (transcriptText, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        rawReplyText: transcriptText,
        logger: null,
        now,
      });
    turn('Ring continuity on circuit 1. Lives are open circuit.', 1000);
    ws.sent.length = 0; // isolate the frames the EXIT produces
    turn(exitPhrase, 2000);
    return { ws, session };
  }

  test.each(['cancel that', 'forget it'])(
    'an open leg collected then "%s" reads back "infinity", never the character',
    (exitPhrase) => {
      const { ws, session } = walkThenExit(exitPhrase);

      // The reading is applied and keeps the character in storage.
      expect(session.stateSnapshot.circuits[1].ring_r1_ohm).toBe(INFINITY_SENTINEL);

      const spoken = ws.sent.map((f) => f.question ?? f.text).filter((t) => typeof t === 'string');
      const readback = spoken.find((t) => t.includes('Also got'));
      expect(readback).toBe('Ring continuity cancelled. 1 of 3 saved. Also got lives infinity.');

      // Exactly once, and the raw glyph reaches no spoken line at all.
      const infinityMentions = spoken.join(' ').match(/infinity/g) ?? [];
      expect(infinityMentions).toHaveLength(1);
      for (const line of spoken) expect(line).not.toContain(INFINITY_SENTINEL);
    }
  );

  test('a numeric leg collected then cancelled is byte-identical to before', () => {
    const ws = new FakeWS();
    const session = { sessionId: SESSION_ID, stateSnapshot: { circuits: { 1: {} } } };
    const turn = (transcriptText, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        rawReplyText: transcriptText,
        logger: null,
        now,
      });
    turn('Ring continuity on circuit 1. Lives are 0.43.', 1000);
    ws.sent.length = 0;
    turn('cancel that', 2000);
    const readback = ws.sent
      .map((f) => f.question ?? f.text)
      .find((t) => typeof t === 'string' && t.includes('Also got'));
    expect(readback).toBe('Ring continuity cancelled. 1 of 3 saved. Also got lives 0.43.');
  });
});

describe('PLAN-A2 acceptance 3 — combined with PLAN-A’s handoff tombstone', () => {
  // The plan's third acceptance item could not be checked while PLAN-A was
  // unmerged: it asks what happens when THIS plan's ∞ is written by the MODEL
  // on a circuit whose walk-through has already ended at its first miss.
  //
  // The risk it guards is a DOUBLE read-back. Before PLAN-A's tombstone, a
  // write-only model turn re-entered the script through the post-dispatch entry
  // hook (`tryEnterScriptFromWrites` guards only `script_already_active`, and a
  // handed-off state is null), so the freshly seeded walk would have spoken the
  // triple on top of the bundler's own line — two audible "infinity"s for one
  // dictated reading, which Audio-First invariant #1 forbids.
  //
  // With the tombstone in place the write is an ORDINARY bundler read-back and
  // nothing else. Both halves are asserted here because neither plan alone
  // proves it: PLAN-A owns the fence, PLAN-A2 owns the word.
  const SESSION_ID = 'sess_a2_handoff';

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

  // Enter the ring walk, then miss it. One miss is all it takes since PLAN-A:
  // the walk ends and the model owns the circuit.
  function handedOffRingWalk() {
    const ws = new FakeWS();
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: {
        circuits: { 1: {} },
        boards: [{ id: 'main', board_type: 'main' }],
        currentBoardId: 'main',
      },
    };
    const turn = (transcriptText, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        rawReplyText: transcriptText,
        logger: null,
        now,
      });
    turn('Ring continuity on circuit 1.', 1000);
    turn('there is no way to get at the other end', 2000);
    return { ws, session };
  }

  test('the walk really has ended and the tombstone really is set', () => {
    const { session } = handedOffRingWalk();
    expect(session.dialogueScriptState).toBeNull();
    expect(isHandedOff(session, 'main', 'ring_continuity', 1)).toBe(true);
  });

  test('a model ∞ write after the handoff starts no script and emits no script frame', () => {
    const { ws, session } = handedOffRingWalk();
    const framesBefore = ws.sent.length;

    // What the dispatcher does with a model write: apply it, then offer it to
    // the entry hook.
    session.stateSnapshot.circuits[1].ring_r2_ohm = INFINITY_SENTINEL;
    const entry = tryEnterScriptFromWrites({
      session,
      ws,
      schemas: ALL_DIALOGUE_SCHEMAS,
      readings: [{ field: 'ring_r2_ohm', circuit: 1, value: INFINITY_SENTINEL }],
      logger: null,
      now: 3000,
    });

    expect(entry).toEqual({ entered: false, reason: 'handed_off' });
    expect(session.dialogueScriptState).toBeNull();
    // No ask, no confirmation, no triple — the script contributed nothing.
    expect(ws.sent.length).toBe(framesBefore);
    expect(ws.sent.filter((f) => f.reason === 'confirm_ring_continuity')).toHaveLength(0);
    // And the value itself is untouched by the fence.
    expect(session.stateSnapshot.circuits[1].ring_r2_ohm).toBe(INFINITY_SENTINEL);
  });

  test('the bundler read-back is the ONE audible line, and it says "infinity"', () => {
    const spoken = buildConfirmationText('ring_r2_ohm', INFINITY_SENTINEL, 1);
    expect(spoken).toBe('Circuit 1, ring r2 infinity');
    // Exactly once — this is the whole point of the combined item.
    expect(spoken.match(/infinity/g)).toHaveLength(1);
    expect(spoken).not.toContain(INFINITY_SENTINEL);
    // Control: a numeric write through the same builder is unchanged.
    expect(buildConfirmationText('ring_r2_ohm', '0.43', 1)).toBe('Circuit 1, ring r2 0.43');
  });
});

describe('PLAN-A2 acceptance 3 — the DEFERRED start path is fenced too (Codex EP cycle 3, blocker)', () => {
  // `start_dialogue_script` may be called with `circuit: null` — "engine asks".
  // PLAN-A fenced the call when the circuit is known, but nothing checked the
  // tombstone when the answer resolved it, so a handed-off ring circuit walked
  // to its own "R2 infinity. All correct?" — on top of the bundler's line when
  // the model had also written the value the ordinary way. Two audible
  // "infinity"s for one dictated reading, and script involvement after a
  // handoff: both halves of acceptance 3.
  const SESSION_ID = 'sess_a2_deferred';

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

  function setup() {
    const ws = new FakeWS();
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: {
        circuits: { 1: { circuit_designation: 'Ring Main' } },
        boards: [{ id: 'main', board_type: 'main' }],
        currentBoardId: 'main',
      },
    };
    const turn = (transcriptText, now) =>
      processRingContinuityTurn({
        ws,
        session,
        sessionId: SESSION_ID,
        transcriptText,
        rawReplyText: transcriptText,
        logger: null,
        now,
      });
    return { ws, session, turn };
  }

  function handOff(turn) {
    turn('Ring continuity on circuit 1.', 1000);
    turn('there is no way to get at the other end', 2000);
  }

  function modelStartsWithNoCircuit(session, ws, now = 3000) {
    return enterScriptByName({
      session,
      ws,
      sessionId: SESSION_ID,
      schemas: ALL_DIALOGUE_SCHEMAS,
      schemaName: 'ring_continuity',
      circuit_ref: null,
      pending_writes: [{ field: 'ring_r2_ohm', value: INFINITY_SENTINEL }],
      logger: null,
      now,
    });
  }

  const spokenTexts = (frames) =>
    frames.map((f) => f.question ?? f.text).filter((s) => typeof s === 'string');

  test('same-turn ordinary write + deferred start: the bundler line is the ONLY "infinity"', () => {
    const { ws, session, turn } = setup();
    handOff(turn);
    // The model's ordinary write this turn — bundler-spoken as
    // "Circuit 1, ring r2 infinity" (asserted in the block above).
    session.stateSnapshot.circuits[1].ring_r2_ohm = INFINITY_SENTINEL;
    expect(modelStartsWithNoCircuit(session, ws).status).toBe('entered');
    const before = ws.sent.length;

    const out = turn('circuit 1', 4000);

    // The script hands straight back to the model rather than walking.
    expect(out.fallthrough).toBe(true);
    expect(out.serverNote.kind).toBe('deferred_entry');
    expect(session.dialogueScriptState).toBeNull();
    expect(isHandedOff(session, 'main', 'ring_continuity', 1)).toBe(true);
    // Already on the certificate and already read back, so NOT returned for
    // re-writing — that would be the second read-back.
    expect(out.serverNote.unapplied).toBeUndefined();
    expect(out.serverNote.existing_values).toMatchObject({ ring_r2_ohm: INFINITY_SENTINEL });
    // Nothing further from the script: no ask, no triple, no "infinity".
    const after = spokenTexts(ws.sent.slice(before));
    expect(after.filter((s) => /infinity/.test(s))).toHaveLength(0);
    expect(ws.sent.filter((f) => f.reason === 'confirm_ring_continuity')).toHaveLength(0);
    // Follow the walk the old code took; the script must stay silent.
    turn('0.43', 5000);
    turn('0.44', 6000);
    expect(ws.sent.filter((f) => f.reason === 'confirm_ring_continuity')).toHaveLength(0);
  });

  test('deferred start ALONE: the value goes back to the model, never silently dropped', () => {
    const { ws, session, turn } = setup();
    handOff(turn);
    modelStartsWithNoCircuit(session, ws);
    const out = turn('circuit 1', 4000);

    expect(out.fallthrough).toBe(true);
    expect(out.serverNote.unapplied).toEqual([
      { field: 'ring_r2_ohm', value: INFINITY_SENTINEL },
    ]);
    // The script wrote nothing — the model owns the write, and the bundler
    // will read it back once.
    expect(session.stateSnapshot.circuits[1].ring_r2_ohm).toBeUndefined();
    // And the model actually READS it: the note is prepended to the utterance.
    expect(out.transcriptText).toMatch(/^\[Server note: The walk-through you started did not run/);
    expect(out.transcriptText).toContain('"unapplied":[{"field":"ring_r2_ohm","value":"∞"}]');
    expect(out.transcriptText.endsWith('circuit 1')).toBe(true);
  });

  test('scope: a deferred MODEL start on a circuit that was never handed off still walks', () => {
    const { ws, session, turn } = setup();
    modelStartsWithNoCircuit(session, ws);
    const out = turn('circuit 1', 4000);
    expect(out.fallthrough).toBe(false);
    expect(session.dialogueScriptState?.active).toBe(true);
    expect(session.dialogueScriptState.circuit_ref).toBe(1);
    expect(session.stateSnapshot.circuits[1].ring_r2_ohm).toBe(INFINITY_SENTINEL);
  });

  test('scope: an INSPECTOR trigger with no circuit is not fenced — PLAN-A lets it override', () => {
    const { session, turn } = setup();
    handOff(turn);
    turn('Ring continuity.', 3000);
    expect(session.dialogueScriptState?.deferred_model_entry).toBeUndefined();
    const out = turn('circuit 1', 4000);
    expect(out.fallthrough).toBe(false);
    expect(session.dialogueScriptState?.active).toBe(true);
    expect(session.dialogueScriptState.circuit_ref).toBe(1);
  });
});
