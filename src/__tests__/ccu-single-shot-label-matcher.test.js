/**
 * Unit tests for matchLabelsToEntries — the position-based label-to-device
 * matcher in ccu-single-shot.js. Pinned to the 2026-05-21 diagnostic
 * findings against Ciaran's Crabtree Starbreaker field-test photo, where
 * the prior "VLM picks label per entry" approach put COOKER on a B16
 * (0.042 away) when it belonged on the neighbouring B32 (0.008 away).
 */
import { matchLabelsToEntries } from '../extraction/ccu-single-shot.js';

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
    expect(diag.droppedFarFromAnyDevice).toBeGreaterThan(0);
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

  it('handles duplicate label claims by giving the device to the closer label', () => {
    // Wider spacing so both candidate labels comfortably fit inside the threshold
    // (0.5 × 0.2 pitch = 0.1 maxDist) — avoids floating-point edge cases at the
    // exact boundary and lets the duplicate-claim branch exercise cleanly.
    const entries = [
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.5 },
      { device_kind: 'mcb', ocpd_rating_a: 32, position_x: 0.7 },
    ];
    const labelArray = [
      { text: 'Cooker', position_x: 0.51 }, // dist 0.01 to entry[0]
      { text: 'Sockets', position_x: 0.53 }, // dist 0.03 to entry[0] — both claim it, Cooker wins
    ];
    const diag = matchLabelsToEntries(entries, labelArray);
    expect(entries[0].label).toBe('Cooker');
    expect(diag.droppedDuplicateClaim).toBe(1);
    // entry[1] never got a label because both labels were closer to entry[0].
    expect(entries[1].label).toBe(null);
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
});
