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
  test('3 rapid record_reading confirmations within 800 ms emit 1, not 3', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.62', 1)],
      state,
      { now: t0 }
    );
    const second = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.59', 2)],
      state,
      { now: t0 + 250 }
    );
    const third = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.71', 3)],
      state,
      { now: t0 + 800 }
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(state.lastSuppressedCount).toBe(2);
    expect(state.lastField).toBe('measured_zs_ohm');
  });

  test('different fields within the window are NOT suppressed', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.62', 1)],
      state,
      { now: t0 }
    );
    const second = applyConfirmationDebounce(
      [reading('r1_r2_ohm', '0.24', 1)],
      state,
      { now: t0 + 300 }
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(state.lastField).toBe('r1_r2_ohm');
  });

  test('same field AFTER the window passes through', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    const first = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.62', 1)],
      state,
      { now: t0 }
    );
    const second = applyConfirmationDebounce(
      [reading('measured_zs_ohm', '0.59', 2)],
      state,
      { now: t0 + CONFIRMATION_DEBOUNCE_WINDOW_MS + 1 }
    );

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

  test('suppression count accumulates across calls', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;

    applyConfirmationDebounce([reading('measured_zs_ohm', '0.62', 1)], state, { now: t0 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.59', 2)], state, { now: t0 + 100 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.71', 3)], state, { now: t0 + 200 });
    applyConfirmationDebounce([reading('measured_zs_ohm', '0.83', 4)], state, { now: t0 + 300 });

    expect(state.lastSuppressedCount).toBe(3);
  });
});
