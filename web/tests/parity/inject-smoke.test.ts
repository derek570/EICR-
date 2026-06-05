/**
 * Smoke test for the transcript-injection harness.
 *
 * Drives a single utterance through the full normalise → matcher → wire
 * pipeline and asserts the outbound frame matches what iOS would send.
 * This is the canary — if it breaks, every other parity scenario is
 * untrustworthy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { buildHarness, makeHarnessJob, type Harness } from './harness';

describe('parity harness — smoke', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({
      job: makeHarnessJob([
        { ref: '1', designation: 'Immersion Heater' },
        { ref: '2', designation: 'Downstairs Sockets' },
      ]),
    });
  });

  afterEach(() => {
    h.teardown();
    WS.clean();
  });

  it('sends a normalised transcript with regexResults for a simple Zs reading', async () => {
    const utteranceId = 'test-utt-001';
    const result = h.injectFinal('circuit one Zs nought point four two', {
      utteranceId,
    });

    // Number normaliser converted spoken digits/decimal.
    expect(result.normalisedText.toLowerCase()).toContain('zs');
    expect(result.normalisedText).toContain('0.42');

    // Matcher attributed Zs to circuit 1.
    expect(result.changedKeys.length).toBeGreaterThan(0);
    expect(result.changedKeys.some((k) => k.includes('measured_zs_ohm'))).toBe(true);

    // SonnetSession emitted exactly one transcript frame.
    const frame = (await h.nextWireMessage()) as {
      type: string;
      text: string;
      timestamp?: string;
      utterance_id?: string;
      confirmations_enabled?: boolean;
      regexResults?: Array<{ field: string; value?: string }>;
      in_response_to?: unknown;
    };

    expect(frame.type).toBe('transcript');
    expect(frame.utterance_id).toBe(utteranceId);
    // D3 — confirmations_enabled is OMITTED when falsy (iOS conditional).
    expect(frame.confirmations_enabled).toBeUndefined();
    // D2 — timestamp now stamped on every frame (iOS canon).
    expect(typeof frame.timestamp).toBe('string');
    expect(frame.timestamp!).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(frame.text).toBe(result.normalisedText);
    expect(Array.isArray(frame.regexResults)).toBe(true);
    expect(frame.regexResults!.length).toBeGreaterThan(0);
    // iOS shape is `{field, value?}` — never a separate `circuit` key.
    expect(frame.regexResults![0]).toHaveProperty('field');
    // No in_response_to when no question context provided.
    expect(frame.in_response_to).toBeUndefined();
  });

  it('emits confirmations_enabled: true ONLY when the option is set (iOS-conditional)', async () => {
    h.injectFinal('postcode RG30 6AA', {
      utteranceId: 'utt-conf-001',
      confirmationsEnabled: true,
    });
    const frame = (await h.nextWireMessage()) as { confirmations_enabled?: boolean };
    expect(frame.confirmations_enabled).toBe(true);
  });

  it('produces a cumulative transcript across two finals (matcher state survives)', async () => {
    h.injectFinal('circuit one Zs nought point four two');
    const second = h.injectFinal('R1 plus R2 zero point three five');

    expect(second.cumulativeTranscript).toContain('0.42');
    expect(second.cumulativeTranscript).toContain('0.35');
  });

  it('attaches in_response_to when the harness models an active TTS question', async () => {
    // Mirrors the live pipeline: when a TTS question is in flight, the
    // recording context computes the `in_response_to` payload via
    // takeInResponseToPayload() and threads it into sendTranscript.
    // Here the test scenario passes it explicitly through the harness.
    const inResponseTo = {
      type: 'observation_confirmation',
      question: 'Should I log that as an observation on the certificate?',
      field: null,
      circuit: null,
    };

    h.injectFinal('yes', {
      utteranceId: 'utt-resp-001',
      inResponseTo,
    });

    const frame = (await h.nextWireMessage()) as {
      type: string;
      in_response_to?: { type: string; question: string; field?: unknown; circuit?: unknown };
    };

    expect(frame.type).toBe('transcript');
    expect(frame.in_response_to).toBeDefined();
    expect(frame.in_response_to!.type).toBe('observation_confirmation');
    expect(frame.in_response_to!.question).toBe(
      'Should I log that as an observation on the certificate?'
    );
  });
});
