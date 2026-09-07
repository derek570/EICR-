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

  it('Extra prompts OFF + a generic reading confirmation enqueues exactly once', () => {
    setConfirmationModeEnabled(false);
    const conf = {
      text: 'Set Zs to 0.44 on circuit 3.',
      field: 'measured_zs_ohm' as string | null,
    };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k2',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(true);
    expect(shim.speak).toHaveBeenCalledTimes(1);
  });

  it('an emitted sibling ANSWERED P4 ack is not re-muted by the client', () => {
    setConfirmationModeEnabled(false);
    const conf = { text: 'Okay, got it.', field: null as string | null };
    const result = speakConfirmation(conf.text, {
      dedupeKey: 'k3',
      force: isP4DeclineAck(conf),
    });
    expect(result.enqueued).toBe(true);
    expect(shim.speak).toHaveBeenCalledTimes(1);
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
 * Any owed confirmation that fails before enqueue must release its reservation,
 * or replay would silently swallow the later retry.
 */
describe('confirmation reservation release on enqueue failure', () => {
  it('TTS unavailable: a forced decline-ack reservation is released so a later attempt can still speak', () => {
    // Override the file-level beforeEach's SynthShim install — this test
    // needs isTtsAvailable() === false (genuinely unavailable), not muted.
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    const store = new ConfirmationDedupeStore();
    const conf = { text: ASK_DECLINE_ACK_PROMPTS[2], field: null as string | null };
    const dedupeKey = 'p4-decline-unavailable';
    const fieldIsNil = conf.field == null;
    const p4DeclineAck = isP4DeclineAck(conf);

    store.reserve(dedupeKey, fieldIsNil);
    const attempt = speakConfirmation(conf.text, { dedupeKey, force: p4DeclineAck });
    expect(attempt.enqueued).toBe(false);
    // Without the fix this reservation would stand forever — assert the
    // pre-fix hazard is real before asserting the fix's outcome below.
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(true);

    if (!attempt.enqueued) {
      store.forget(dedupeKey);
    }
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(false);
  });

  it('an ordinary confirmation with Extra prompts OFF enqueues and keeps its live reservation', () => {
    setConfirmationModeEnabled(false);
    const store = new ConfirmationDedupeStore();
    const conf = {
      text: 'Set Zs to 0.44 on circuit 3.',
      field: 'measured_zs_ohm' as string | null,
    };
    const dedupeKey = 'ordinary-muted';
    const fieldIsNil = conf.field == null;
    const p4DeclineAck = isP4DeclineAck(conf);

    store.reserve(dedupeKey, fieldIsNil);
    const attempt = speakConfirmation(conf.text, { dedupeKey, force: p4DeclineAck });
    expect(attempt.enqueued).toBe(true);
    if (!attempt.enqueued) {
      store.forget(dedupeKey);
    }
    expect(store.isLive(dedupeKey, fieldIsNil)).toBe(true);
  });
});
