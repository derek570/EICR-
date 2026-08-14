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
  confirmationDebounceKey,
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

// ── §A1a (field-feedback-2026-07-14) — token-aware debounce key ──
// Deletions have null value so the composite key falls to text, and EVERY
// deletion speaks the constant "Observation deleted" — two distinct same-turn
// deletions were collapsed server-side before any client saw them. With the
// dedupe_token in the key: distinct operations survive; a REPLAY carrying the
// SAME token is still suppressed.
describe('§A1a — token-aware confirmationDebounceKey / applyConfirmationDebounce', () => {
  const deletion = (token) => ({
    text: 'Observation deleted',
    expanded_text: 'Observation deleted',
    field: 'observation_deletion',
    circuit: null,
    dedupe_token: token,
    expects_ios_ack: false,
  });

  test('two same-text deletions with DISTINCT tokens in one burst → both survive', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const out = applyConfirmationDebounce([deletion('obsdel_a'), deletion('obsdel_b')], state, {
      now: 1000,
    });
    expect(out).toHaveLength(2);
  });

  test('a replay carrying the SAME token within the window → suppressed (speaks once)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const first = applyConfirmationDebounce([deletion('obsdel_a')], state, { now: t0 });
    expect(first).toHaveLength(1);
    const replay = applyConfirmationDebounce([deletion('obsdel_a')], state, { now: t0 + 200 });
    expect(replay).toHaveLength(0);
    expect(state.lastSuppressedCount).toBe(1);
  });

  test('allowlisted field WITHOUT a token keeps the composite key (backward-compatible fallback)', () => {
    const noToken = {
      text: 'Observation deleted',
      field: 'observation_deletion',
      circuit: null,
    };
    expect(confirmationDebounceKey(noToken)).not.toContain('tok:');
  });

  test('measured-value field with a spurious token is IGNORED (composite key preserved)', () => {
    const r = { text: 'Circuit 1, Zs 0.62', field: 'measured_zs_ohm', circuit: 1, value: '0.62' };
    const withSpurious = { ...r, dedupe_token: 'spurious' };
    expect(confirmationDebounceKey(withSpurious)).toBe(confirmationDebounceKey(r));
  });

  test('PLAN-2C candidate 1: postcode debounce stays token-blind', () => {
    const first = {
      text: 'Postcode RG1 5QA',
      field: 'postcode',
      circuit: null,
      dedupe_token: 'secfield_postcode_global_turn-1_ord0',
    };
    const laterOperation = {
      ...first,
      dedupe_token: 'secfield_postcode_global_turn-2_ord0',
    };
    expect(confirmationDebounceKey(first)).toBe(confirmationDebounceKey(laterOperation));

    const state = { lastEmittedAt: 0, lastField: null };
    expect(applyConfirmationDebounce([first], state, { now: 1_000_000 })).toHaveLength(1);
    expect(applyConfirmationDebounce([laterOperation], state, { now: 1_000_200 })).toHaveLength(0);
  });

  test('Codex r4-#6: A, B, A replay pattern — the second A is suppressed (windowed token map, not lastKey)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const a1 = applyConfirmationDebounce([deletion('obsdel_a')], state, { now: t0 });
    const b = applyConfirmationDebounce([deletion('obsdel_b')], state, { now: t0 + 200 });
    const a2 = applyConfirmationDebounce([deletion('obsdel_a')], state, { now: t0 + 400 });
    expect(a1).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a2).toHaveLength(0);
    expect(state.lastSuppressedCount).toBe(1);
  });

  test('Codex r4-#6: same-token replay OUTSIDE the window survives (map is pruned)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    applyConfirmationDebounce([deletion('obsdel_a')], state, { now: t0 });
    const late = applyConfirmationDebounce([deletion('obsdel_a')], state, {
      now: t0 + CONFIRMATION_DEBOUNCE_WINDOW_MS + 10,
    });
    expect(late).toHaveLength(1);
  });

  test('Codex r4-#6: a token confirmation does NOT evict a measured reading from lastKey', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const zs = { text: 'Circuit 1, Zs 0.62', field: 'measured_zs_ohm', circuit: 1, value: '0.62' };
    const first = applyConfirmationDebounce([zs], state, { now: t0 });
    const tokenConf = applyConfirmationDebounce([deletion('obsdel_x')], state, { now: t0 + 100 });
    const zsReplay = applyConfirmationDebounce([{ ...zs }], state, { now: t0 + 300 });
    expect(first).toHaveLength(1);
    expect(tokenConf).toHaveLength(1);
    expect(zsReplay).toHaveLength(0); // still coalesced despite the interleaved token entry
  });
});

// ── PLAN-F2 finding 5 (2026-08-14) — bulkoutcome_ structural token prefix ──
// dispatchSetFieldForAllCircuits's zero-applied/fallback disclosure can
// target ANY circuit reading field (rcd_time_ms here — NOT in
// DEDUPE_TOKEN_FIELDS), so without the structural-prefix recognition this
// suite exercises, two identical all-spares commands on the SAME field
// within the debounce window would collide on the OLD composite key (same
// field, null circuit, no circuits, same board, same TEXT) and the second
// would be silently dropped SERVER-side before either client's own dedupe
// token branch ever ran.
describe('PLAN-F2 finding 5 — bulkoutcome_ prefix recognised by BOTH confirmationDebounceKey and the isTokenKey gate', () => {
  const zeroApplied = (
    token,
    text = 'No non-spare circuits were updated; skipped 2 spare ways.'
  ) => ({
    text,
    expanded_text: text,
    field: 'rcd_time_ms',
    circuit: null,
    dedupe_token: token,
  });

  test('confirmationDebounceKey prefers the token even though rcd_time_ms is NOT in DEDUPE_TOKEN_FIELDS', () => {
    const key = confirmationDebounceKey(zeroApplied('bulkoutcome_t1_tu1_main'));
    expect(key).toBe('rcd_time_ms tok:bulkoutcome_t1_tu1_main');
  });

  test('two identical all-spares commands (same field, same text) in one session → BOTH spoken inside the debounce window', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    // Distinct tokens (different turnId/callId per turn) — exactly what the
    // bundler mints for two separate turns.
    const first = applyConfirmationDebounce([zeroApplied('bulkoutcome_t1_tu1_main')], state, {
      now: t0,
    });
    const second = applyConfirmationDebounce([zeroApplied('bulkoutcome_t2_tu2_main')], state, {
      now: t0 + 200,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test('replaying the ORIGINAL token within the window is suppressed', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const first = applyConfirmationDebounce([zeroApplied('bulkoutcome_t1_tu1_main')], state, {
      now: t0,
    });
    const replay = applyConfirmationDebounce([zeroApplied('bulkoutcome_t1_tu1_main')], state, {
      now: t0 + 200,
    });
    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(0);
    expect(state.lastSuppressedCount).toBe(1);
  });

  test('ONE wildcard call staging one zero-applied entry per board → both survive (distinct board segment)', () => {
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const main = applyConfirmationDebounce([zeroApplied('bulkoutcome_t1_tu1_main')], state, {
      now: t0,
    });
    const subB = applyConfirmationDebounce([zeroApplied('bulkoutcome_t1_tu1_sub-b')], state, {
      now: t0 + 50,
    });
    expect(main).toHaveLength(1);
    expect(subB).toHaveLength(1);
  });

  test('the unmatched/fallback-sibling shape (non-zero text) is likewise token-aware and replay-suppressed', () => {
    const fallback = (token) => zeroApplied(token, 'Skipping 1 spare way.');
    const state = { lastEmittedAt: 0, lastField: null };
    const t0 = 1_000_000;
    const first = applyConfirmationDebounce([fallback('bulkoutcome_t1_tu1_main')], state, {
      now: t0,
    });
    const distinctCall = applyConfirmationDebounce([fallback('bulkoutcome_t1_tu2_main')], state, {
      now: t0 + 50,
    });
    const replayOriginal = applyConfirmationDebounce([fallback('bulkoutcome_t1_tu1_main')], state, {
      now: t0 + 100,
    });
    expect(first).toHaveLength(1);
    expect(distinctCall).toHaveLength(1); // distinct call id — a different disclosure, survives
    expect(replayOriginal).toHaveLength(0); // exact replay of the FIRST token — suppressed
  });
});
