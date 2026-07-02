/**
 * WS3 item 7 — TranscriptGate literal-port branch coverage (2026-07-02).
 *
 * One test per branch of iOS `TranscriptGate.shouldForward`
 * (DeepgramRecordingViewModel.swift:22-160), same order as the source:
 * pending-ask, inResponseTo, regex-hit, empty, digit, bare-negation,
 * observation-pattern, strong trigger, earthing trigger, weak-trigger +
 * content-word threshold, identity two-word threshold — plus reject
 * cases that must produce neither a chime nor a send (asserted at the
 * gate level here; the recording-context wiring test asserts the
 * side-effect suppression).
 */
import { describe, it, expect } from 'vitest';
import { shouldForward, isObservation } from '@/lib/recording/transcript-gate';

const base = { hasRegexHit: false, hasPendingAsk: false, inResponseTo: false };

describe('TranscriptGate.shouldForward — PASS branches (iOS order)', () => {
  it('pending ask forwards anything (short answers must reach the server)', () => {
    expect(shouldForward({ ...base, text: 'yes', hasPendingAsk: true })).toBe(true);
  });

  it('inResponseTo forwards anything (legacy in_response_to payload)', () => {
    expect(shouldForward({ ...base, text: 'the second one', inResponseTo: true })).toBe(true);
  });

  it('regex hit forwards (a regex-only reading must never be gate-rejected)', () => {
    expect(shouldForward({ ...base, text: 'anything at all', hasRegexHit: true })).toBe(true);
  });

  it('digit forwards', () => {
    expect(shouldForward({ ...base, text: 'point four four' })).toBe(false);
    expect(shouldForward({ ...base, text: '0.44' })).toBe(true);
    expect(shouldForward({ ...base, text: 'circuit five is 32 amps' })).toBe(true);
  });

  it('bare negation forwards (readback-correction-optionb §3.3)', () => {
    expect(shouldForward({ ...base, text: 'No' })).toBe(true);
    expect(shouldForward({ ...base, text: 'nope.' })).toBe(true);
    expect(shouldForward({ ...base, text: 'Nah!' })).toBe(true);
  });

  it('observation pattern forwards, including Deepgram garbles', () => {
    expect(shouldForward({ ...base, text: 'observation broken socket faceplate' })).toBe(true);
    expect(shouldForward({ ...base, text: 'obs damaged consumer unit' })).toBe(true);
    // Garble family ("observashun"-style).
    expect(isObservation('make an observashun here')).toBe(true);
  });

  it('strong trigger forwards without any content threshold', () => {
    expect(shouldForward({ ...base, text: 'polarity confirmed' })).toBe(true);
    expect(shouldForward({ ...base, text: 'remove that' })).toBe(true);
  });

  it('earthing trigger forwards at content-threshold 1 (session DFCE2145 item #8)', () => {
    // All five field repros from the 2026-06-16 wave.
    expect(shouldForward({ ...base, text: 'Supply is a TNCS.' })).toBe(true);
    expect(shouldForward({ ...base, text: 'supply is TNCS.' })).toBe(true);
    expect(shouldForward({ ...base, text: 'It is TNCS.' })).toBe(true);
    expect(shouldForward({ ...base, text: "I think it's TNCS." })).toBe(true);
    expect(shouldForward({ ...base, text: 'it is TT' })).toBe(true);
  });

  it('weak trigger + ≥3 distinct content words forwards', () => {
    // "kitchen"(weak) + ring + sockets + kitchen = 3 distinct content words.
    expect(shouldForward({ ...base, text: 'the ring for the sockets in the kitchen' })).toBe(true);
  });

  it('identity trigger lowers the content threshold to 2 (2026-06-12 cert-identity fix)', () => {
    // "Customer is Michael" — exactly two content words (customer, michael).
    expect(shouldForward({ ...base, text: 'Customer is Michael' })).toBe(true);
    expect(shouldForward({ ...base, text: 'client is Smith' })).toBe(true);
  });
});

describe('TranscriptGate.shouldForward — REJECT branches', () => {
  it('empty / whitespace blocks', () => {
    expect(shouldForward({ ...base, text: '' })).toBe(false);
    expect(shouldForward({ ...base, text: '   ' })).toBe(false);
  });

  it('pure chitchat blocks (no weak trigger despite ≥3 content words)', () => {
    expect(shouldForward({ ...base, text: 'Can I use the toilet, please?' })).toBe(false);
  });

  it('weak trigger with <3 content words blocks ("Socket cracked.")', () => {
    expect(shouldForward({ ...base, text: 'Socket cracked.' })).toBe(false);
  });

  it('bare identity marker blocks (marker counts as one of the two)', () => {
    expect(shouldForward({ ...base, text: 'Customer?' })).toBe(false);
  });

  it('negation with a content word is NOT a bare negation ("No earth." stays weak-path)', () => {
    // "No earth." — weak trigger (earth) but only 1 content word → blocks.
    expect(shouldForward({ ...base, text: 'No problem' })).toBe(false);
    expect(shouldForward({ ...base, text: 'No earth.' })).toBe(false);
  });

  it('"Hello my name is John" chitchat blocks (bare "name" deliberately not a trigger)', () => {
    expect(shouldForward({ ...base, text: 'Hello my name is John' })).toBe(false);
  });

  it('observation VERB forms do not fire the observation pattern', () => {
    expect(isObservation('I was observing the weather')).toBe(false);
    // NOTE: "observe" is still a WEAK trigger, so a verb form with ≥3
    // content words forwards via the weak path (iOS parity) — the
    // pattern test above only pins that the OBSERVATION regex itself
    // rejects verb forms. A verb form with too few content words blocks:
    expect(shouldForward({ ...base, text: 'observing now' })).toBe(false);
  });
});
