/**
 * PLAN-G (2026-08-14, Derek decision, feedback id-114) — web companion.
 *
 * Round-1 review disproved the plan's original "clients do not re-gate"
 * claim: web's `speakConfirmation` drops any unforced confirmation while
 * the local `cm-confirmation-mode` toggle is off, so the backend's P4
 * decline-ack bypass (stage6-ask-decline-ack-net.test.js (j)) alone would
 * still leave web silent. `isP4DeclineAck` + the `force` flag close that
 * gap — this file pins BOTH the predicate in isolation and the end-to-end
 * `speakConfirmation` behaviour it gates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_DECLINE_ACK_PROMPTS, isP4DeclineAck } from '@/lib/recording/confirmation-dedupe-key';
import {
  __resetTtsWindowForTests,
  setConfirmationModeEnabled,
  speakConfirmation,
} from '@/lib/recording/tts';
import { __resetForTests as __resetTtsQueueForTests } from '@/lib/recording/tts-queue';
import { ConfirmationDedupeStore } from '@/lib/recording/confirmation-dedupe-store';

describe('isP4DeclineAck — closed decline-ack family predicate', () => {
  it('matches every string in the closed ASK_DECLINE_ACK_PROMPTS family, field-null', () => {
    for (const text of ASK_DECLINE_ACK_PROMPTS) {
      expect(isP4DeclineAck({ text, field: null })).toBe(true);
    }
  });

  it('does NOT match an ordinary reading confirmation', () => {
    expect(isP4DeclineAck({ text: 'Set Zs to 0.44 on circuit 3.', field: 'measured_zs_ohm' })).toBe(
      false
    );
  });

  it('does NOT match the sibling ANSWERED (non-decline) P4 ack family', () => {
    expect(isP4DeclineAck({ text: 'Okay, got it.', field: null })).toBe(false);
    expect(isP4DeclineAck({ text: 'Understood.', field: null })).toBe(false);
  });

  it('requires field:null — a decline-ack string on a fielded confirmation does not match', () => {
    expect(
      isP4DeclineAck({ text: ASK_DECLINE_ACK_PROMPTS[0], field: 'measured_zs_ohm', circuit: 2 })
    ).toBe(false);
  });

  it('tolerates surrounding whitespace the same way confirmationToSentence trims it', () => {
    expect(isP4DeclineAck({ text: `  ${ASK_DECLINE_ACK_PROMPTS[1]}  `, field: null })).toBe(true);
  });
});

class UtteranceShim {
  text: string;
  lang = 'en-GB';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class SynthShim {
  cancel = vi.fn();
  getVoices = vi.fn(() => [] as SpeechSynthesisVoice[]);
  spoken: UtteranceShim[] = [];
  speak = vi.fn((u: UtteranceShim) => {
    this.spoken.push(u);
  });
}

let shim: SynthShim;

beforeEach(() => {
  shim = new SynthShim();
  Object.defineProperty(window, 'speechSynthesis', {
    value: shim,
    writable: true,
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    UtteranceShim;
  window.localStorage.clear();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
});

afterEach(() => {
  window.localStorage.clear();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
});

describe('speakConfirmation + isP4DeclineAck — the recording-context call-site contract', () => {
  it('cm-confirmation-mode OFF + a decline-family ack (forced) → enqueues exactly once', () => {
    setConfirmationModeEnabled(false);
    const conf = { text: ASK_DECLINE_ACK_PROMPTS[1], field: null as string | null };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k1',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(true);
    expect(shim.speak).toHaveBeenCalledTimes(1);
    expect(shim.spoken[0].text).toBe(ASK_DECLINE_ACK_PROMPTS[1]);
  });

  it('cm-confirmation-mode OFF + a generic reading confirmation (unforced) → stays muted', () => {
    setConfirmationModeEnabled(false);
    const conf = {
      text: 'Set Zs to 0.44 on circuit 3.',
      field: 'measured_zs_ohm' as string | null,
    };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k2',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(false);
    expect(shim.speak).not.toHaveBeenCalled();
  });

  it('cm-confirmation-mode OFF + the sibling ANSWERED (non-decline) P4 ack (unforced) → stays muted', () => {
    setConfirmationModeEnabled(false);
    const conf = { text: 'Okay, got it.', field: null as string | null };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k3',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(false);
    expect(shim.speak).not.toHaveBeenCalled();
  });

  it('cm-confirmation-mode ON + a decline-family ack → enqueues once (unchanged from today)', () => {
    setConfirmationModeEnabled(true);
    const conf = { text: ASK_DECLINE_ACK_PROMPTS[0], field: null as string | null };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k4',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(true);
    expect(shim.speak).toHaveBeenCalledTimes(1);
  });
});

/**
 * PLAN-G round-1 Codex diff review (cycle 1, lens C) — a forced decline ack
 * that fails to enqueue (TTS genuinely unavailable — force:true means the
 * confirmation-mode toggle can never be the cause) must NOT leave a
 * permanent reservation behind, or a genuine LATER decline landing on the
 * same rotated text would be silently swallowed forever. Mirrors the exact
 * reserve/speak/discard-on-fail sequence recording-context.tsx runs
 * (its own reserve()/discardConfirmationReservation() aren't exported, so
 * this test drives the same public primitives — ConfirmationDedupeStore +
 * speakConfirmation — the component composes them with).
 */
describe('P4 decline-ack reservation release on enqueue failure (PLAN-G cycle-1 fix)', () => {
  it('TTS unavailable: a forced decline-ack reservation is released so a later attempt can still speak', () => {
    // Override the file-level beforeEach's SynthShim install — this test
    // needs isTtsAvailable() === false (genuinely unavailable), not muted.
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    const store = new ConfirmationDedupeStore();
    const conf = { text: ASK_DECLINE_ACK_PROMPTS[2], field: null as string | null };
    const dedupeKey = 'p4-decline-unavailable';
    const fieldIsNil = conf.field == null;

    store.reserve(dedupeKey, fieldIsNil);
    const attempt = speakConfirmation(conf.text, { dedupeKey, force: isP4DeclineAck(conf) });
    expect(attempt.enqueued).toBe(false);
    // Without the fix this reservation would stand forever — assert the
    // pre-fix hazard is real before asserting the fix's outcome below.
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(true);

    // The recording-context.tsx fix: p4DeclineAck && !enqueued → discard.
    if (isP4DeclineAck(conf) && !attempt.enqueued) {
      store.forget(dedupeKey);
    }
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(false);
  });

  it('an ORDINARY confirmation muted by the toggle (not TTS-unavailable) keeps its permanent reservation — never discarded', () => {
    setConfirmationModeEnabled(false);
    const store = new ConfirmationDedupeStore();
    const conf = {
      text: 'Set Zs to 0.44 on circuit 3.',
      field: 'measured_zs_ohm' as string | null,
    };
    const dedupeKey = 'ordinary-muted';
    const fieldIsNil = conf.field == null;

    store.reserve(dedupeKey, fieldIsNil);
    const attempt = speakConfirmation(conf.text, { dedupeKey, force: isP4DeclineAck(conf) });
    expect(attempt.enqueued).toBe(false);
    // p4DeclineAck is false here, so the fix's discard branch never fires —
    // the reservation stands, which is CORRECT: a muted confirmation the
    // inspector chose not to hear must not re-prompt.
    if (isP4DeclineAck(conf) && !attempt.enqueued) {
      store.forget(dedupeKey);
    }
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(true);
  });
});
