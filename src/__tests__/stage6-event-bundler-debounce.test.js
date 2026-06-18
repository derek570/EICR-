/**
 * PLAN-backend-final.md Phase 7.4 — tests for applyConfirmationDebounce.
 *
 * The helper drops same-field-family confirmations within a 1500 ms
 * window. Inspector hears one TTS per burst instead of three when
 * Sonnet rapid-fires record_reading across consecutive turns.
 *
 * Repro context: session 60754E4D had 10 audio_finalizer_timeout_fired
 * events with empty ios_playback_ack arrays because iOS started TTS
 * playback but the next confirmation overlapped and the queue stalled.
 * iOS slice 7.1 (AlertManager queue) is the consumer; the backend
 * debounce dropped the duplicate confirmation BEFORE it enters that
 * queue so the inspector just hears the first one.
 */

import {
  applyConfirmationDebounce,
  CONFIRMATION_DEBOUNCE_WINDOW_MS,
} from '../extraction/stage6-event-bundler.js';

function reading(field, value, circuit) {
  return { field, value, circuit };
}

describe('applyConfirmationDebounce', () => {
  // Audio-first (2026-06-18, readback-correction-optionb): the debounce key
  // now includes circuit+board+value, so distinct same-field different-
  // circuit readings each ride through (every applied reading is read back).
  // The debounce ONLY coalesces a genuine duplicate of the SAME reading.
  test('audio-first: 3 same-field different-circuit readings within 800 ms ALL emit', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0,
    });
    const second = applyConfirmationDebounce([reading('measured_zs_ohm', '0.59', 2)], state, {
      now: t0 + 250,
    });
    const third = applyConfirmationDebounce([reading('measured_zs_ohm', '0.71', 3)], state, {
      now: t0 + 800,
    });

    // Each is a distinct reading (different circuit + value) → all spoken.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(state.lastSuppressedCount).toBeUndefined();
  });

  test('a genuine duplicate of the SAME reading within the window IS suppressed', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0,
    });
    // Same field + circuit + value re-emitted 250 ms later → coalesced.
    const second = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0 + 250,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(state.lastSuppressedCount).toBe(1);
  });

  test('two same-field different-circuit readings inside 1.5 s → BOTH spoken (plan §3.1)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const first = applyConfirmationDebounce([reading('measured_zs_ohm', '0.86', 3)], state, {
      now: t0,
    });
    const second = applyConfirmationDebounce([reading('measured_zs_ohm', '0.91', 4)], state, {
      now: t0 + 400, // well within the 1500 ms window
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test('live confirmation entries (text-keyed, no `value`) distinguish circuits by text', () => {
    // Real bundler confirmation entries carry `text` (which encodes
    // circuit+value), not a bare `value`. The key falls back to `text`.
    // Different circuits → different text → both ride through; an immediate
    // exact-duplicate of the most recent reading is coalesced.
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const c1 = { field: 'measured_zs_ohm', circuit: 3, text: 'Circuit 3, Zs 0.86' };
    const c2 = { field: 'measured_zs_ohm', circuit: 4, text: 'Circuit 4, Zs 0.91' };
    const dupC2 = { field: 'measured_zs_ohm', circuit: 4, text: 'Circuit 4, Zs 0.91' };
    expect(applyConfirmationDebounce([c1], state, { now: t0 })).toHaveLength(1);
    expect(applyConfirmationDebounce([c2], state, { now: t0 + 100 })).toHaveLength(1);
    // Exact duplicate of the immediately-preceding reading (c2) → suppressed.
    expect(applyConfirmationDebounce([dupC2], state, { now: t0 + 200 })).toHaveLength(0);
  });

  test('different fields within the window are NOT suppressed', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0,
    });
    const second = applyConfirmationDebounce([reading('r1_r2_ohm', '0.24', 1)], state, {
      now: t0 + 300,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(state.lastField).toBe('r1_r2_ohm');
  });

  test('same identical reading AFTER the window passes through', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0,
    });
    // Identical reading (same field+circuit+value) but past the window.
    const second = applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, {
      now: t0 + CONFIRMATION_DEBOUNCE_WINDOW_MS + 1,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test('multiple confirmations in a single batch ride through in order, state tracks the LAST one', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const batch = [
      reading('measured_zs_ohm', '0.62', 1),
      reading('r1_r2_ohm', '0.24', 1),
      reading('polarity_confirmed', 'true', 1),
    ];

    const out = applyConfirmationDebounce(batch, state, { now: t0 });
    expect(out).toHaveLength(3);
    expect(state.lastField).toBe('polarity_confirmed');
  });

  test('no debounceState → passes through unchanged (defensive)', () => {
    const batch = [reading('measured_zs_ohm', '0.62', 1)];
    const out = applyConfirmationDebounce(batch, null, { now: 1000 });
    expect(out).toEqual(batch);
  });

  test('empty input → empty array', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    expect(applyConfirmationDebounce([], state, { now: 1000 })).toEqual([]);
    expect(applyConfirmationDebounce(null, state, { now: 1000 })).toEqual([]);
    expect(applyConfirmationDebounce(undefined, state, { now: 1000 })).toEqual([]);
  });

  test('window threshold is 1500 ms (matches plan + constant export)', () => {
    expect(CONFIRMATION_DEBOUNCE_WINDOW_MS).toBe(1500);
  });

  test('suppression count accumulates across calls (identical reading re-emitted)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    // Same field+circuit+value re-emitted 4× in a burst → 1 spoken, 3 suppressed.
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, { now: t0 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, { now: t0 + 100 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, { now: t0 + 200 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, { now: t0 + 300 });

    expect(state.lastSuppressedCount).toBe(3);
  });
});
