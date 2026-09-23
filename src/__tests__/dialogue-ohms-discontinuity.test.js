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
import { processRingContinuityTurn } from '../extraction/dialogue-engine/index.js';
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
} from '../extraction/confirmation-text.js';

// The exact six the plan names. Not "everything that sounds open" — widening
// this set is a behaviour change that has to move all three grammars at once.
const SIX_FORMS = ['infinite', 'infinity', 'open', 'open circuit', 'open ring', 'discontinuous'];

describe('PLAN-A2 acceptance 1 — parseOhms writes the discontinuity sentinel', () => {
  test.each(SIX_FORMS)('"%s" → ∞', (form) => {
    expect(parseOhms(form)).toBe(INFINITY_SENTINEL);
  });

  test.each(SIX_FORMS)('"%s" inside a dictated sentence → ∞', (form) => {
    expect(parseOhms(`The CPC is ${form}.`)).toBe(INFINITY_SENTINEL);
  });

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

  test('a NON-bare LIM phrase falls through, exactly as it did before', () => {
    // `parseLimSlot` deliberately fires only on a bare/near-bare reply (P3
    // Codex-r1): a field-qualified LIM is routed by the named extractor, which
    // hands this parser the bare captured token. So a long sentence merely
    // CONTAINING "limitation" was never a LIM here, and PLAN-A2 does not change
    // that — it changes only what such a sentence falls through TO.
    expect(parseOhms('the breaking capacity is a limitation')).toBeNull();
    expect(parseOhms('limitation — the circuit is open')).toBe(INFINITY_SENTINEL);
  });

  test('the discontinuity branch is word-anchored at both ends', () => {
    // Without anchors, ordinary speech during a ring loop ("opening the
    // board", "reopened") would certify a conductor as open.
    for (const near of ['opening', 'reopened', 'infinitely', 'openness']) {
      expect(parseOhms(near)).not.toBe(INFINITY_SENTINEL);
    }
  });

  test('a sentinel beats a stray number in the same utterance', () => {
    // "open circuit on the 2.5" must not be reduced to the cable size — the
    // sentinel branch runs before the numeric one.
    expect(parseOhms('open circuit on the 2.5')).toBe(INFINITY_SENTINEL);
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
