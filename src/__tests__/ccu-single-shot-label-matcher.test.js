/**
 * Unit tests for matchLabelsToEntries — the position-based label-to-device
 * matcher in ccu-single-shot.js. Pinned to two separate 2026-05-21
 * diagnostic findings:
 *
 *   1. Ciaran's Crabtree Starbreaker, where the prior "VLM picks label
 *      per entry" approach put COOKER on a B16 (0.042 away) when it
 *      belonged on the neighbouring B32 (0.008 away). Fixed by shipping
 *      a position-based matcher.
 *
 *   2. Ciaran's Wylex NHRS12SL (extraction 1779384564405-u7dp9b), where
 *      ~0.02 normalised position noise in the VLM's reported label
 *      positions flipped each left-half label one slot to the right in
 *      the per-label nearest-neighbour matcher. Fixed by shipping a
 *      monotonic sequence-alignment matcher (DP, O(L × D)) — see the
 *      `matchLabelsToEntriesMonotonic` docstring for the algorithm.
 *
 * The default-exported `matchLabelsToEntries` dispatches to the
 * monotonic algorithm. Tests for the legacy nearest matcher live at the
 * bottom — it remains as a one-env-var rollback path.
 */
import {
  matchLabelsToEntries,
  matchLabelsToEntriesMonotonic,
  matchLabelsToEntriesNearest,
} from '../extraction/ccu-single-shot.js';

describe('matchLabelsToEntries', () => {
  it('assigns COOKER to the nearer B32 even when a B16 sits within reach (the field-test repro)', () => {
    // Approximate positions from the actual diagnostic run on Ciaran's photo.
    const entries = [
      { device_kind: 'main_switch', position_x: 0.055 },
      { device_kind: 'main_switch', position_x: 0.105 },
      { device_kind: 'blank', position_x: 0.175 },
      { device_kind: 'mcb', ocpd_rating_a: 50, position_x: 0.248 },
      { device_kind: 'rcd', position_x: 0.345 },
      { device_kind: 'rcd', position_x: 0.395 },
      { device_kind: 'blank', position_x: 0.455 },
      { device_kind: 'mcb', ocpd_rating_a: 16, position_x: 0.535 }, // B16 — should NOT win
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.585 }, // B32 — should win Cooker
      { device_kind: 'mcb', ocpd_rating_a: 6, position_x: 0.632 }, // B6 — should win Lighting
    ];
    const labelArray = [
      { text: 'Cooker', position_x: 0.577 },
      { text: 'Lighting', position_x: 0.627 },
    ];
    const diag = matchLabelsToEntries(entries, labelArray);

    expect(diag.skipped).toBe(false);
    expect(diag.matched).toBe(2);
    // The B32 (index 8) gets Cooker.
    expect(entries[8].label).toBe('Cooker');
    // The B6 (index 9) gets Lighting.
    expect(entries[9].label).toBe('Lighting');
    // The B16 (index 7) gets null — confirmed the closer-to-neighbour rule.
    expect(entries[7].label).toBe(null);
  });

  it('drops section headers like "RCD Protected Circuits" via the pitch-derived threshold', () => {
    const entries = [
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.1 },
      { device_kind: 'rcd', position_x: 0.3 },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 },
      { device_kind: 'mcb', ocpd_rating_a: 6, position_x: 0.56 },
      { device_kind: 'mcb', ocpd_rating_a: 16, position_x: 0.62 },
    ];
    const labelArray = [
      { text: 'RCD Protected Circuits', position_x: 0.3 }, // sits on the RCD (excluded kind), nearest MCB is 0.200 away → drop
      { text: 'Sockets', position_x: 0.5 },
      { text: 'Lights', position_x: 0.56 },
      { text: 'Cooker', position_x: 0.62 },
    ];
    const diag = matchLabelsToEntries(entries, labelArray);

    expect(diag.matched).toBe(3); // Sockets, Lights, Cooker
    expect(diag.labelsSkipped).toBeGreaterThan(0); // "RCD Protected Circuits" force-skipped
    expect(entries[2].label).toBe('Sockets');
    expect(entries[3].label).toBe('Lights');
    expect(entries[4].label).toBe('Cooker');
    // RCD entry was never a candidate for label assignment.
    expect(entries[1].label).toBeUndefined();
  });

  it('skips with reason when labels array missing', () => {
    const entries = [{ device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 }];
    const diag = matchLabelsToEntries(entries, []);
    expect(diag.skipped).toBe(true);
    expect(diag.skipReason).toBe('no_labels_array');
  });

  it('skips when no matchable candidates (e.g. only main_switch and RCDs)', () => {
    const entries = [
      { device_kind: 'main_switch', position_x: 0.1 },
      { device_kind: 'rcd', position_x: 0.5 },
    ];
    const diag = matchLabelsToEntries(entries, [{ text: 'Test', position_x: 0.5 }]);
    expect(diag.skipped).toBe(true);
    expect(diag.skipReason).toBe('no_matchable_candidates');
  });

  it('handles label crowding by giving the device to the closer label when the other device is beyond max match cost', () => {
    // Two labels stacked very close to entry[0]; entry[1] sits 0.17 from
    // the second label — beyond MAX_MATCH_COST = 0.7 × pitch = 0.14 — so
    // the second label is force-skipped, the closer one claims entry[0],
    // and entry[1] is left unlabelled. This preserves the original
    // closest-wins intent without depending on the legacy "duplicate
    // claim" mechanic that no longer exists in the monotonic matcher.
    const entries = [
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.7 },
    ];
    const labelArray = [
      { text: 'Cooker', position_x: 0.51 }, // dist 0.01 to entry[0], dist 0.19 (>MAX) to entry[1]
      { text: 'Sockets', position_x: 0.53 }, // dist 0.03 to entry[0], dist 0.17 (>MAX) to entry[1]
    ];
    matchLabelsToEntries(entries, labelArray);
    expect(entries[0].label).toBe('Cooker');
    expect(entries[1].label).toBe(null);
  });

  it('prevents the Wylex run-3 +1 shift on noisy VLM positions (the 2026-05-21 regression)', () => {
    // Real diagnostic-replay positions from extraction 1779384564405-u7dp9b
    // run 3. "Kitchen Sockets" at x=0.279 is 0.029 from slot 3 (x=0.250)
    // and only 0.023 from slot 4 (x=0.302). The per-label nearest-
    // neighbour matcher picked slot 4, shifting every downstream label
    // one slot to the right. Monotonic alignment uses the order
    // constraint to keep it on slot 3 — matching it to slot 4 would
    // force every downstream label one slot too.
    //
    // Setup: 4 candidates and 4 labels (forced 1:1) so the DP can't fix
    // the shift by skipping a "convenient" device. The naive matcher
    // takes the locally-best (closer) per-label match; monotonic respects
    // the order. See the matchLabelsToEntriesNearest test below for the
    // same data run through the legacy algorithm to compare.
    const entries = [
      { device_kind: 'mcb', position_x: 0.198 }, // slot 2 — Downstairs Sockets
      { device_kind: 'mcb', position_x: 0.25 }, // slot 3 — Kitchen Sockets BELONGS here
      { device_kind: 'mcb', position_x: 0.302 }, // slot 4 — nearest-neighbour drifts to here
      { device_kind: 'mcb', position_x: 0.354 }, // slot 5 — Sockets
    ];
    const labelArray = [
      { text: 'Downstairs Sockets', position_x: 0.219 },
      { text: 'Kitchen Sockets', position_x: 0.279 },
      { text: 'Sockets', position_x: 0.335 },
      { text: 'Sockets Study', position_x: 0.389 },
    ];
    matchLabelsToEntries(entries, labelArray);
    expect(entries[0].label).toBe('Downstairs Sockets');
    expect(entries[1].label).toBe('Kitchen Sockets'); // ← the regression-pin assertion
    expect(entries[2].label).toBe('Sockets');
    expect(entries[3].label).toBe('Sockets Study');
  });

  it('clears stale per-entry labels on matchable entries when no label matches', () => {
    const entries = [
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5, label: 'stale-from-old-prompt' },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.6, label: 'also-stale' },
    ];
    const labelArray = [{ text: 'Sockets', position_x: 0.5 }];
    matchLabelsToEntries(entries, labelArray);
    expect(entries[0].label).toBe('Sockets');
    // The second MCB had a stale label, no matching label → cleared.
    expect(entries[1].label).toBe(null);
  });

  it('tolerates labels with text:null (position-only) by skipping them', () => {
    const entries = [{ device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 }];
    const labelArray = [
      { text: null, position_x: 0.5 },
      { text: 'Real', position_x: 0.5 },
    ];
    const diag = matchLabelsToEntries(entries, labelArray);
    expect(entries[0].label).toBe('Real');
    expect(diag.matched).toBe(1);
  });

  it('does not touch label on non-matchable kinds (main_switch keeps prompt-provided text)', () => {
    const entries = [
      { device_kind: 'main_switch', position_x: 0.05, label: 'Main Switch' },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 },
    ];
    matchLabelsToEntries(entries, [{ text: 'Sockets', position_x: 0.5 }]);
    expect(entries[0].label).toBe('Main Switch'); // untouched
    expect(entries[1].label).toBe('Sockets');
  });

  it('returns a monotonic diagnostic with the cost-weight knobs surfaced for CloudWatch tuning', () => {
    const entries = [
      { device_kind: 'mcb', position_x: 0.1 },
      { device_kind: 'mcb', position_x: 0.5 },
    ];
    const labelArray = [{ text: 'Sockets', position_x: 0.5 }];
    const diag = matchLabelsToEntriesMonotonic(entries, labelArray);
    expect(diag.algorithm).toBe('monotonic');
    expect(diag.pitchNorm).toBeCloseTo(0.4, 3);
    expect(diag.labelSkipPenalty).toBeCloseTo(0.4, 3); // factor 1.0
    expect(diag.deviceSkipPenalty).toBeCloseTo(0.2, 3); // factor 0.5
    expect(diag.maxMatchCost).toBeCloseTo(0.28, 3); // factor 0.7
    expect(diag.matched).toBe(1);
    expect(diag.devicesSkipped).toBe(1);
  });
});

describe('matchLabelsToEntriesNearest (legacy rollback path)', () => {
  it('still resolves the Cooker-on-B32 field-test repro', () => {
    // Pin the legacy nearest-neighbour algorithm against the original
    // bug it was designed to fix, so the rollback flag
    // (CCU_LABEL_MATCHER_ALGORITHM=nearest) stays viable.
    const entries = [
      { device_kind: 'mcb', ocpd_rating_a: 16, position_x: 0.535 },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.585 },
      { device_kind: 'mcb', ocpd_rating_a: 6, position_x: 0.632 },
    ];
    const labelArray = [
      { text: 'Cooker', position_x: 0.577 },
      { text: 'Lighting', position_x: 0.627 },
    ];
    const diag = matchLabelsToEntriesNearest(entries, labelArray);
    expect(diag.algorithm).toBe('nearest');
    expect(entries[0].label).toBe(null);
    expect(entries[1].label).toBe('Cooker');
    expect(entries[2].label).toBe('Lighting');
  });

  it('still reproduces the Wylex +1 shift it was originally vulnerable to (sanity check, not desired behaviour)', () => {
    // This is the bug the monotonic matcher exists to fix. Pinned here
    // so anyone flipping back to the nearest algorithm knows EXACTLY
    // what behaviour they're rolling back to. If this test ever starts
    // passing as "Kitchen Sockets on slot 3", the nearest matcher has
    // been silently improved and the rollback safety net is gone.
    const entries = [
      { device_kind: 'mcb', position_x: 0.25 }, // slot 3
      { device_kind: 'mcb', position_x: 0.302 }, // slot 4
    ];
    const labelArray = [{ text: 'Kitchen Sockets', position_x: 0.279 }];
    matchLabelsToEntriesNearest(entries, labelArray);
    // Nearest-neighbour picks slot 4 (0.023 away) over slot 3 (0.029 away).
    expect(entries[0].label).toBe(null);
    expect(entries[1].label).toBe('Kitchen Sockets');
  });
});
