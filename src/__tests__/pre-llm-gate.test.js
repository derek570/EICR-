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
    ['No.', GATE_REASONS.LOW_CONTENT],
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
    // 2026-05-29 PLAN_v4 — updated expectations. Pre-v4 these forwarded
    // as HAS_TRIGGER (any of 94 trigger words). Post-v4 they forward via
    // FALLBACK_FORWARD (≥3 distinct content words) or HAS_OBSERVATION_PREFIX.
    ['Yeah. So this is a circuit. I don’t know what it does.', GATE_REASONS.FALLBACK_FORWARD],
    ['Could be for an old alarm.', GATE_REASONS.FALLBACK_FORWARD],
    ['Move to the next circuit.', GATE_REASONS.FALLBACK_FORWARD],
    ['Add an observation about the cooker.', GATE_REASONS.HAS_OBSERVATION_PREFIX],
    // Fallback — three or more distinct content words, no digit, no trigger
    ['I never use your toilet a sec.', GATE_REASONS.FALLBACK_FORWARD],
    ['Cheers fellas thank you mate.', GATE_REASONS.FALLBACK_FORWARD],
  ])('forwards "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
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
    ['Delete that.', GATE_REASONS.HAS_STRONG_TRIGGER],
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

  test('WEAK additions limited to none (original word set preserved verbatim minus moves)', () => {
    const additions = [..._internals.WEAK_TRIGGER_WORDS]
      .filter((w) => !ORIGINAL_TRIGGER_WORDS_FROM_2026_05_26.has(w))
      .sort();
    expect(additions).toEqual([]);
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
  //   disabled > drainedRetry > pendingAsk > inResponseTo > regexHits > text rules
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
});

describe('shouldForwardToSonnet — distinct-content-word count', () => {
  test('exposes content-word count on low_content blocks', () => {
    const r = shouldForwardToSonnet('Yeah.');
    expect(r.distinctContentWords).toBe(1);
  });

  test('exposes content-word count on fallback forwards', () => {
    const r = shouldForwardToSonnet('I never use your toilet a sec.');
    expect(r.distinctContentWords).toBeGreaterThanOrEqual(3);
  });

  test('counts duplicate words once', () => {
    const r = shouldForwardToSonnet('Yeah. Yeah. Yeah.');
    expect(r.forward).toBe(false);
    expect(r.distinctContentWords).toBe(1);
  });
});
