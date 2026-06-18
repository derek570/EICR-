/**
 * Unit tests for the pre-LLM transcript gate.
 *
 * Most fixtures are real transcripts from session
 * 33E6613D-49A7-4B42-A73B-1E2C6A82174D (2026-05-26), which produced
 * the panic-ask burst pattern the gate exists to prevent.
 */

import {
  shouldForwardToSonnet,
  GATE_REASONS,
  OBSERVATION_PATTERN,
  _internals,
} from '../extraction/pre-llm-gate.js';
import { ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26 } from './fixtures/pre-llm-gate-original-94-words.js';

describe('shouldForwardToSonnet — blocking decisions', () => {
  test.each([
    ['Yeah.', GATE_REASONS.LOW_CONTENT],
    // 'No.' moved to the forwarding table below (readback-correction-optionb
    // §3.3, 2026-06-18) — a bare negation now forwards so the model can
    // resolve it against the most recent read-back. Innocuous "no …" phrases
    // (with a content word) STAY here / on LOW_CONTENT — see negative pins.
    ['No earth.', GATE_REASONS.LOW_CONTENT],
    ['No problem.', GATE_REASONS.LOW_CONTENT],
    ['No signal.', GATE_REASONS.LOW_CONTENT],
    ['No spare.', GATE_REASONS.LOW_CONTENT],
    ['Hello?', GATE_REASONS.LOW_CONTENT],
    ['Girl.', GATE_REASONS.LOW_CONTENT],
    ['Sock it.', GATE_REASONS.LOW_CONTENT],
    ['And who?', GATE_REASONS.LOW_CONTENT],
    ['Whatever.', GATE_REASONS.LOW_CONTENT],
    ['Mm.', GATE_REASONS.LOW_CONTENT],
    ['', GATE_REASONS.EMPTY],
    ['    ', GATE_REASONS.EMPTY],
    // Burst-window fixtures
    ['Or is it', GATE_REASONS.LOW_CONTENT],
    ['I found what that is.', GATE_REASONS.LOW_CONTENT],
    ['it shouldn’t be charging.', GATE_REASONS.LOW_CONTENT],
  ])('blocks "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(false);
    expect(result.reason).toBe(expectedReason);
  });
});

describe('shouldForwardToSonnet — forwarding decisions', () => {
  test.each([
    // Real readings — digit triggers forward
    ['R1 plus R2 for rear heater is 0.24.', GATE_REASONS.HAS_DIGIT],
    ['Zs for socket 7, 0.62.', GATE_REASONS.HAS_DIGIT],
    ['Circuit 8 is heater rear bedroom.', GATE_REASONS.HAS_DIGIT],
    // 2026-05-29 PLAN_v5 — weak triggers now require ≥3 content words.
    // Pure chitchat ("toilet please") blocks at HAS_WEAK_TRIGGER level.
    ['Yeah. So this is a circuit. I don’t know what it does.', GATE_REASONS.HAS_WEAK_TRIGGER],
    ['Could be for an old alarm.', GATE_REASONS.HAS_WEAK_TRIGGER],
    ['Move to the next circuit.', GATE_REASONS.HAS_WEAK_TRIGGER],
    ['Add an observation about the cooker.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ])('forwards "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
    expect(result.reason).toBe(expectedReason);
  });

  // 2026-05-29 PLAN_v5 — pure conversational English (no inspection
  // vocabulary) now blocks. Field test session 1FBAE6E0: inspector said
  // "Can I use the toilet, please?" expecting silence; pre-v5 forwarded
  // via FALLBACK_FORWARD (6 content words) and Sonnet replied with a
  // toilet-facilities quip. v5 requires a weak/strong/observation/digit
  // signal for forward authority.
  test.each([
    ['I never use your toilet a sec.', GATE_REASONS.LOW_CONTENT],
    ['Cheers fellas thank you mate.', GATE_REASONS.LOW_CONTENT],
    ['Can I use the toilet, please?', GATE_REASONS.LOW_CONTENT],
    ['Hello, my name is Michael McGinley.', GATE_REASONS.LOW_CONTENT],
    // "Where is the bathroom?" has weak (bathroom) but only 2 content
    // words ("where", "bathroom"; "is", "the" are stopwords) — fails
    // the ≥3 threshold so still blocks. Good outcome.
    ['Where is the bathroom?', GATE_REASONS.LOW_CONTENT],
  ])('blocks-or-forwards chitchat "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.reason).toBe(expectedReason);
  });
});

// =============================================================================
// 2026-05-29 PLAN_v4 — observation-gated architecture coverage
// =============================================================================

describe('PLAN_v4 — STRONG trigger forwards alone', () => {
  test.each([
    ['Zs.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['Polarity confirmed.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['MCB tripped.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['Continuity check.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['Insulation test.', GATE_REASONS.HAS_STRONG_TRIGGER],
    // "Delete that." moved out of this group on 2026-06-04 (PLAN-backend-
    // final.md Phase 5.1). The new COMPLAINT_OR_NEGATION trigger runs
    // BEFORE the strong-trigger check and matches "delete that" /
    // "cancel that" / "fix that" as corrective complaints. Both reasons
    // forward — the categorisation just reflects the inspector's intent
    // (it's a complaint about something they just said). The Phase 5.1
    // describe block lower in this file owns the positive assertion.
    ['Remove the entry.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['FCU spur.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['CPC discontinuous.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['AFDD installed.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['SPD fitted.', GATE_REASONS.HAS_STRONG_TRIGGER],
    ['SPD present.', GATE_REASONS.HAS_STRONG_TRIGGER],
  ])('forwards strong-trigger "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
    expect(result.reason).toBe(expectedReason);
  });
});

describe('PLAN_v4 — OBSERVATION_PATTERN forwards', () => {
  test.each([
    // Canonical
    ['Observation: socket cracked.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Observation. The cable is exposed.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['I have an observation about the cooker.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Add an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Note an observation.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Observations recorded.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    // Truncation
    ['Obs: cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    // Deepgram garbles
    ['Obvashon, cracked casing.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Abservation, missing cover.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Obviation here.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Obstervation noted.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Obvashen here.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    ['Observatior on cable.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    // Homophone overlap
    ['Observance of the rules.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
  ])('forwards observation-pattern "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
    expect(result.reason).toBe(expectedReason);
  });
});

describe('PLAN_v4 — OBSERVATION_PATTERN rejects verb forms and non-electrical English', () => {
  test.each([
    'observe',
    'observed',
    'observing',
    'observer',
    'obstruction',
    'operation',
    'objection',
    'obsession',
    'aviation',
    'obvious',
    'absorb',
    'obscure',
    'obesity',
    'obscene',
  ])('OBSERVATION_PATTERN.test("%s") === false', (word) => {
    expect(_internals.OBSERVATION_PATTERN.test(word)).toBe(false);
  });

  test('accepted false positive: abbreviation matches', () => {
    expect(_internals.OBSERVATION_PATTERN.test('abbreviation')).toBe(true);
  });
});

describe('PLAN_v4 — damage adjectives block without observation prefix (Q3)', () => {
  test.each([
    ['Socket cracked.', GATE_REASONS.LOW_CONTENT],
    ['Cable exposed.', GATE_REASONS.LOW_CONTENT],
    ['No earth.', GATE_REASONS.LOW_CONTENT],
    ['Cover missing.', GATE_REASONS.LOW_CONTENT],
    ['Loose connection.', GATE_REASONS.LOW_CONTENT],
    ['Cracked casing.', GATE_REASONS.LOW_CONTENT],
    ['Burnt cable.', GATE_REASONS.LOW_CONTENT],
    ['Defect on casing.', GATE_REASONS.LOW_CONTENT],
    ['I cracked an egg.', GATE_REASONS.LOW_CONTENT],
  ])('blocks damage-only "%s"', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(false);
    expect(result.reason).toBe(expectedReason);
  });
});

describe('PLAN_v4 — damage adjectives + observation prefix forward', () => {
  test.each([
    'Observation: socket cracked.',
    'Obvashon, cable exposed.',
    'Observation: no earth.',
    'Observation: cover missing on circuit 3.',
  ])('forwards damage+observation prefix "%s"', (text) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
    // First test has no digit so observation prefix; "circuit 3" version has
    // digit but observation pattern still fires first per step order.
    expect([GATE_REASONS.HAS_OBSERVATION_PREFIX, GATE_REASONS.HAS_DIGIT]).toContain(result.reason);
  });
});

describe('PLAN_v4 — silent vocab additions guard (Codex v2 MAJOR 4)', () => {
  test.each([
    ['Clear that.', GATE_REASONS.LOW_CONTENT],
    ['Rename it.', GATE_REASONS.LOW_CONTENT],
    ['Clear circuit 3.', GATE_REASONS.HAS_DIGIT],
    ['Rename circuit 4 to cooker.', GATE_REASONS.HAS_DIGIT],
  ])('"%s" -> %s', (text, expectedReason) => {
    expect(shouldForwardToSonnet(text).reason).toBe(expectedReason);
  });
});

describe('PLAN_v4 — weak-trigger + digit regression', () => {
  test.each([
    'Done with circuit 3.',
    'Add to circuit 4.',
    'Cooker circuit 4.',
    'Kitchen socket reading is 0.45.',
  ])('forwards weak+digit "%s" via HAS_DIGIT', (text) => {
    expect(shouldForwardToSonnet(text)).toEqual({
      forward: true,
      reason: GATE_REASONS.HAS_DIGIT,
    });
  });
});

describe('PLAN_v4 — EN route now correction (Codex v2 MAJOR 5)', () => {
  test('"EN route now." blocks as LOW_CONTENT', () => {
    const result = shouldForwardToSonnet('EN route now.');
    expect(result.forward).toBe(false);
    expect(result.reason).toBe(GATE_REASONS.LOW_CONTENT);
  });
});

describe('PLAN_v4 — telemetry reason values', () => {
  test('HAS_TRIGGER value retained for back-compat', () => {
    expect(GATE_REASONS.HAS_TRIGGER).toBe('has_trigger');
  });
  test('HAS_STRONG_TRIGGER value', () => {
    expect(GATE_REASONS.HAS_STRONG_TRIGGER).toBe('has_strong_trigger');
  });
  test('HAS_OBSERVATION_PREFIX value', () => {
    expect(GATE_REASONS.HAS_OBSERVATION_PREFIX).toBe('has_observation_prefix');
  });
  test('HAS_COMPLAINT_OR_NEGATION value (PLAN-backend-final Phase 5.1)', () => {
    expect(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION).toBe('has_complaint_or_negation');
  });
});

// PLAN-backend-final.md Phase 5.3 — COMPLAINT_OR_NEGATION trigger
// coverage. The three captured field-test utterances (session
// 60754E4D) MUST forward (they were silently dropped to LOW_CONTENT
// before Phase 5.1). Synthetic complaints round out the positive
// space; negative cases lock the bare-"no" continuation discipline
// against "no problem" / "no signal" / "no spare" innocuous forms.
describe('Phase 5.1 — COMPLAINT_OR_NEGATION trigger', () => {
  describe('captured utterances from session 60754E4D (the bug fixtures)', () => {
    test.each([
      'Why did you ask the b s number for that one again?',
      "No. That's not what I said.",
      "You haven't set it to LIM.",
    ])('forwards "%s" with HAS_COMPLAINT_OR_NEGATION', (text) => {
      const result = shouldForwardToSonnet(text);
      expect(result.forward).toBe(true);
      // The captured utterance "Why did you ask the b s number..." also
      // matches HAS_DIGIT (bs-prefix has none, but it doesn't matter —
      // complaint check runs BEFORE digit check by design so the reason
      // reflects intent. Lock that ordering explicitly.
      expect(result.reason).toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
    });
  });

  describe('synthetic positive cases', () => {
    test.each([
      "No, I didn't say that.",
      "That's wrong.",
      'Stop it.',
      'Undo.',
      'Cancel that.',
      'Delete that.',
      'Fix that.',
      "That's not right.",
      "I didn't say that.",
      'Why are you doing that?',
    ])('forwards "%s" with HAS_COMPLAINT_OR_NEGATION', (text) => {
      const result = shouldForwardToSonnet(text);
      expect(result.forward).toBe(true);
      expect(result.reason).toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
    });
  });

  // readback-correction-optionb §3.3 (2026-06-18) — STANDALONE bare
  // negation now forwards so the live model (with a rolling window of the
  // read-backs it spoke) can resolve "no" against the most recent read-back
  // and ask for the replacement (Option B). Previously these dropped to
  // LOW_CONTENT (the continuation-pronoun discipline above).
  describe('standalone bare negation forwards (audio-first read-back rejection)', () => {
    test.each(['No.', 'no', 'Nope.', 'nope', 'Nah', 'nah.', '  No!  '])(
      'forwards "%s" with HAS_COMPLAINT_OR_NEGATION',
      (text) => {
        const result = shouldForwardToSonnet(text);
        expect(result.forward).toBe(true);
        expect(result.reason).toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
      }
    );

    // The bare-negation relaxation is anchored ^…$ so a "no <content word>"
    // phrase still falls through (these carry an inspection/content word and
    // are NOT a standalone negation).
    test.each(['No earth.', 'No problem.', 'No signal.', 'No spare.'])(
      'does NOT forward "%s" as a standalone negation',
      (text) => {
        const result = shouldForwardToSonnet(text);
        expect(result.reason).not.toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
      }
    );
  });

  describe('negative cases — innocuous bare-"no" forms must NOT trip the trigger', () => {
    // These all start with "no" but lack a continuation pronoun /
    // marker the regex requires. They should fall through to other
    // checks (LOW_CONTENT for short ones, HAS_WEAK_TRIGGER for the
    // ones with inspection vocabulary). The point of this group is
    // to lock that the regex's "no[,.]?\s+(that|that's|i|you|...)"
    // anchor stays in place — without it, "no problem" silently
    // forwards and a 50-turn benign exchange floods Sonnet.
    test.each(['no problem', 'no signal', 'no spare'])(
      'does NOT forward "%s" via the complaint trigger',
      (text) => {
        const result = shouldForwardToSonnet(text);
        // Must NOT match the complaint trigger. Some of these may still
        // forward via other paths (e.g. "no spare" matches WEAK trigger
        // "spare" via the inspection vocab path), but the REASON must
        // not be HAS_COMPLAINT_OR_NEGATION.
        expect(result.reason).not.toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
      }
    );
  });

  describe('complaint-forward wins over digit-forward (ordering invariant)', () => {
    // The plan's explicit design: place the complaint check BEFORE
    // HAS_DIGIT so a complaint that happens to contain a number
    // ("you set it to 0.45 but I said 0.55") logs with the
    // complaint reason, not the digit reason. The optimizer-side
    // dashboard then attributes the call to the right intent.
    test('"You haven\'t set it to 0.55, I said 0.32" → complaint, not digit', () => {
      const result = shouldForwardToSonnet("You haven't set it to 0.55, I said 0.32");
      expect(result.forward).toBe(true);
      expect(result.reason).toBe(GATE_REASONS.HAS_COMPLAINT_OR_NEGATION);
    });
  });
});

describe('PLAN_v4 — original-94 vocabulary preservation invariant', () => {
  test('every original-94 word appears in STRONG, WEAK, or OBSERVATION_PATTERN', () => {
    const missing = [];
    for (const w of ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26) {
      const inStrong = _internals.STRONG_TRIGGER_WORDS.has(w);
      const inWeak = _internals.WEAK_TRIGGER_WORDS.has(w);
      const inObsRegex = OBSERVATION_PATTERN.test(w);
      if (!(inStrong || inWeak || inObsRegex)) {
        missing.push(w);
      }
    }
    // Failure shows the missing words in the diff — engineer adding/removing
    // an original word must update either STRONG_TRIGGER_WORDS,
    // WEAK_TRIGGER_WORDS, or OBSERVATION_PATTERN in the same commit.
    expect(missing.sort()).toEqual([]);
  });

  test('STRONG additions limited to ["afdd", "cpc"]', () => {
    const additions = [..._internals.STRONG_TRIGGER_WORDS]
      .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w))
      .sort();
    expect(additions).toEqual(['afdd', 'cpc']);
  });

  test('WEAK additions limited to the 2026-06-12 cert-identity dictation markers', () => {
    // 2026-06-12 field report (session 15B88D6B, voiceFeedbackId 20):
    // "Customer is Michael Johnson" carried no digit / strong / weak
    // trigger, so spoken corrections of client_name could never reach
    // Sonnet. These words mark certificate dictation; bare 'name' is
    // deliberately excluded so "Hello my name is ..." chitchat still
    // blocks. Mirrored in the iOS TranscriptGate weakTriggers.
    const additions = [..._internals.WEAK_TRIGGER_WORDS]
      .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w))
      .sort();
    expect(additions).toEqual([
      'address',
      'client',
      'customer',
      'landlord',
      'occupier',
      'postcode',
      'tenant',
    ]);
  });
});

describe('shouldForwardToSonnet — bypasses', () => {
  test('forwards short fillers when a pending ask is unresolved', () => {
    expect(shouldForwardToSonnet('Yeah.', { hasPendingAsk: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_PENDING_ASK,
    });
    expect(shouldForwardToSonnet('No.', { hasPendingAsk: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_PENDING_ASK,
    });
  });

  test('forwards when iOS tagged the transcript as in_response_to a TTS question', () => {
    expect(shouldForwardToSonnet('Yeah.', { inResponseTo: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_IN_RESPONSE_TO,
    });
  });

  // 2026-05-31 — server-side dialogue-engine asks (RCD / OCPD / RCBO / IR /
  // ring-continuity walk-throughs) don't register in pendingAsks because
  // they use the `srv-*` tool-call-id prefix; the engine reads its own
  // dialogueScriptState and needs every utterance forwarded so its defer /
  // skip / cancel / topic-switch parsers can fire. Repro: inspector replies
  // bare "later" to "What's the BS number? Or do you want to fill that in
  // later?" — without this bypass the gate blocks LOW_CONTENT and the
  // engine's deferTriggers regex `/^\s*later[.!?]?\s*$/i` (rcd.js:148)
  // never sees the reply.
  test('forwards single-word "later" when a dialogue script is active', () => {
    expect(shouldForwardToSonnet('later', { hasActiveDialogueScript: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE,
    });
  });

  test('forwards bare "skip" when a dialogue script is active', () => {
    expect(shouldForwardToSonnet('Skip.', { hasActiveDialogueScript: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE,
    });
  });

  test('forwards bare "AC" type answer when a dialogue script is active', () => {
    // RCD slot question "What RCD type? AC, A, F, or B?" — bare "AC"
    // would block LOW_CONTENT without the bypass (1 content word, no
    // weak/strong trigger).
    expect(shouldForwardToSonnet('AC', { hasActiveDialogueScript: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE,
    });
  });

  test('dialogue-script bypass works even when text is empty', () => {
    // Empty payload reaches the engine and falls through harmlessly;
    // we don't want the gate to silently drop replies that contain only
    // the answer's punctuation or get whitespace-clipped by Deepgram.
    expect(shouldForwardToSonnet('   ', { hasActiveDialogueScript: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE,
    });
  });

  test('forwards drained-retry replays unconditionally', () => {
    expect(shouldForwardToSonnet('Yeah.', { drainedRetry: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DRAINED_RETRY,
    });
  });

  test('forwards when iOS regex caught a value, even if text alone looks empty', () => {
    expect(
      shouldForwardToSonnet('uh', {
        regexResults: [{ field: 'r1_r2_ohm', circuit: '3', value: 0.45 }],
      })
    ).toEqual({ forward: true, reason: GATE_REASONS.HAS_REGEX_HINT });
  });

  test('disabled gate forwards everything', () => {
    expect(shouldForwardToSonnet('Yeah.', { gateEnabled: false })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DISABLED,
    });
    // Distinct-content count is irrelevant when the gate is off.
    expect(shouldForwardToSonnet('', { gateEnabled: false })).toEqual({
      forward: true,
      reason: GATE_REASONS.BYPASS_DISABLED,
    });
  });
});

describe('shouldForwardToSonnet — bypass precedence', () => {
  // The gate evaluates bypasses in a deterministic order:
  //   disabled > drainedRetry > pendingAsk > activeDialogueScript >
  //   inResponseTo > regexHits > text rules
  test('disabled flag dominates every bypass', () => {
    expect(
      shouldForwardToSonnet('Yeah.', {
        gateEnabled: false,
        drainedRetry: true,
        hasPendingAsk: true,
      }).reason
    ).toBe(GATE_REASONS.BYPASS_DISABLED);
  });

  test('drainedRetry wins over pendingAsk + regex hits', () => {
    expect(
      shouldForwardToSonnet('Yeah.', {
        drainedRetry: true,
        hasPendingAsk: true,
        regexResults: [{ field: 'zs', value: 0.5 }],
      }).reason
    ).toBe(GATE_REASONS.BYPASS_DRAINED_RETRY);
  });

  test('pendingAsk wins over activeDialogueScript', () => {
    // pendingAsk (Sonnet `ask_user` outstanding) is the older signal and
    // sits one step higher in the order. When both fire on the same
    // utterance (e.g. mid-script Sonnet also asked for a clarification),
    // attributing to pendingAsk preserves existing telemetry semantics.
    expect(
      shouldForwardToSonnet('later', {
        hasPendingAsk: true,
        hasActiveDialogueScript: true,
      }).reason
    ).toBe(GATE_REASONS.BYPASS_PENDING_ASK);
  });

  test('activeDialogueScript wins over inResponseTo + regexHits', () => {
    expect(
      shouldForwardToSonnet('later', {
        hasActiveDialogueScript: true,
        inResponseTo: true,
        regexResults: [{ field: 'rcd_bs_en', value: '60898' }],
      }).reason
    ).toBe(GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE);
  });
});

describe('shouldForwardToSonnet — distinct-content-word count', () => {
  test('exposes content-word count on low_content blocks', () => {
    const r = shouldForwardToSonnet('Yeah.');
    expect(r.distinctContentWords).toBe(1);
  });

  test('exposes content-word count on chitchat blocks (post-v5)', () => {
    // 2026-05-29 PLAN_v5 — "I never use your toilet a sec." now blocks
    // (no weak trigger). Content count is still exposed for telemetry.
    const r = shouldForwardToSonnet('I never use your toilet a sec.');
    expect(r.forward).toBe(false);
    expect(r.distinctContentWords).toBeGreaterThanOrEqual(3);
  });

  test('counts duplicate words once', () => {
    const r = shouldForwardToSonnet('Yeah. Yeah. Yeah.');
    expect(r.forward).toBe(false);
    expect(r.distinctContentWords).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2026-06-12 — cert-identity dictation markers (session 15B88D6B,
// voiceFeedbackId 20). "Customer is Michael Johnson" must forward (weak
// trigger 'customer' + 3 content words) and the lowered identity threshold
// must let the 2-content-word short form "Customer is Michael" through,
// while chitchat shapes keep blocking.
// ---------------------------------------------------------------------------
describe('shouldForwardToSonnet — cert-identity dictation markers (2026-06-12)', () => {
  test('"Customer is Michael Johnson." forwards via weak trigger', () => {
    const r = shouldForwardToSonnet('Customer is Michael Johnson.');
    expect(r.forward).toBe(true);
    expect(r.reason).toBe(GATE_REASONS.HAS_WEAK_TRIGGER);
  });

  test('"Customer is Michael." (2 content words) forwards via identity threshold', () => {
    const r = shouldForwardToSonnet('Customer is Michael.');
    expect(r.forward).toBe(true);
    expect(r.reason).toBe(GATE_REASONS.HAS_WEAK_TRIGGER);
  });

  test('"Client address is Vicarage Road." forwards', () => {
    expect(shouldForwardToSonnet('Client address is Vicarage Road.').forward).toBe(true);
  });

  test('bare "Customer?" still blocks (1 content word)', () => {
    const r = shouldForwardToSonnet('Customer?');
    expect(r.forward).toBe(false);
    expect(r.reason).toBe(GATE_REASONS.LOW_CONTENT);
  });

  test('"Hello my name is Michael McGinley" still blocks (2026-05-29 chitchat case)', () => {
    const r = shouldForwardToSonnet('Hello my name is Michael McGinley');
    expect(r.forward).toBe(false);
  });

  test('"Can I use the toilet, please?" still blocks', () => {
    expect(shouldForwardToSonnet('Can I use the toilet, please?').forward).toBe(false);
  });
});
