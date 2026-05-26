/**
 * Unit tests for the pre-LLM transcript gate.
 *
 * Most fixtures are real transcripts from session
 * 33E6613D-49A7-4B42-A73B-1E2C6A82174D (2026-05-26), which produced
 * the panic-ask burst pattern the gate exists to prevent.
 */

import { shouldForwardToSonnet, GATE_REASONS } from '../extraction/pre-llm-gate.js';

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
    // Trigger words
    ['Yeah. So this is a circuit. I don’t know what it does.', GATE_REASONS.HAS_TRIGGER],
    ['Could be for an old alarm.', GATE_REASONS.HAS_TRIGGER],
    ['Move to the next circuit.', GATE_REASONS.HAS_TRIGGER],
    ['Add an observation about the cooker.', GATE_REASONS.HAS_TRIGGER],
    // Fallback — three or more distinct content words, no digit, no trigger
    ['I never use your toilet a sec.', GATE_REASONS.FALLBACK_FORWARD],
    ['Cheers fellas thank you mate.', GATE_REASONS.FALLBACK_FORWARD],
  ])('forwards "%s" with reason=%s', (text, expectedReason) => {
    const result = shouldForwardToSonnet(text);
    expect(result.forward).toBe(true);
    expect(result.reason).toBe(expectedReason);
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
